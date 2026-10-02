import fs from 'fs';
import path from 'path';
import { describe, expect, it } from 'vitest';
import type { DB } from '../src/db/connection';
import { runWithContext, systemContext } from '../src/core/request-context';
import { createRole, loadAuthContext } from '../src/modules/security/security.service';
import { executeTool, toolDefinitions } from '../src/assistant/tools';
import { TOOL_POLICIES } from '../src/assistant/tool-policy';
import { allowedToolsForCapabilities } from '../src/assistant/page-capabilities';
import { SEARCH_TYPES } from '../src/contracts/search';
import { crossDomainSearch } from '../src/modules/search/search.service';
import { listProjectBudgetBatches } from '../src/modules/project-budget/project-budget.service';
import { boot, get, json } from './t3-helpers';
import { createScopedUser } from './http-helpers';
import { createProject, createSupplier } from './t4-helpers';

/**
 * T-6 跨域检索(AC-F26):各类型复用该域列表 service 的权限与组织范围;缺权限的类型跳过;
 * 他人草稿报告不可见;通配符不生效;结果路径都是前端真实路由;助手 cross_search 同源且不超过 30 条。
 */

const now = '2026-06-30T00:00:00.000Z';

function as<T>(db: DB, userId: number, fn: () => T): T {
  const auth = loadAuthContext(db, userId);
  if (!auth) throw new Error('user disabled');
  return runWithContext({ requestId: 'test', source: 'http', auth }, fn);
}

function seedContract(db: DB, no: string, name: string, orgId: number): number {
  return Number(db.prepare(`INSERT INTO ct_contract (contract_no, normalized_no, name, org_id, original_cents, paid_cents, payment_cap_ratio_scaled, stage, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, 1000000, 0, 800000, 'performance', 'active', ?, ?)`).run(no, no, name, orgId, now, now).lastInsertRowid);
}

function seedReport(db: DB, seriesNo: string, title: string, orgId: number | null, status: string, userId: number | null): number {
  return Number(db.prepare(`INSERT INTO rpt_report (series_no, title, kind, org_id, year, status, created_by_user_id, created_at, updated_at)
    VALUES (?, ?, 'risk_investment', ?, 2026, ?, ?, ?, ?)`).run(seriesNo, title, orgId, status, userId, now, now).lastInsertRowid);
}

/** 前端 App.tsx 路由表中的一级路径(含 budget/:id 这类参数路由)。 */
function frontendRoutes(): RegExp[] {
  const src = fs.readFileSync(path.join(__dirname, '../../frontend/src/App.tsx'), 'utf8');
  return [...src.matchAll(/\{ path: '([^'*]+)', element:/g)].map((m) => new RegExp(`^/${m[1].replace(/:[a-zA-Z]+/g, '[^/]+')}$`));
}

describe('T-6 跨域检索', () => {
  it('旧预算批次先按关键词筛选再限量,搜索与联想均遵守明细组织范围', async () => {
    const { base, db, admin, fx } = await boot('newfc-t6-search-old-batch-');
    const shProject = await createProject(base, admin, 'OLD-SH', '上海旧项目', fx.orgIds.shanghai);
    const njProject = await createProject(base, admin, 'OLD-NJ', '南京旧项目', fx.orgIds.nanjing);
    const fileId = Number(db.prepare(`INSERT INTO file_object (sha256, size_bytes, original_name, created_at)
      VALUES (?, 0, 'budget.xlsx', ?)`).run('0'.repeat(64), now).lastInsertRowid);
    const insertBatch = db.prepare(`INSERT INTO pb_batch (year, period, name, file_object_id, file_sha256, file_name, row_count, created_at)
      VALUES (2026, '2026-06', ?, ?, ?, 'budget.xlsx', 1, ?)`);
    const insertEntry = db.prepare(`INSERT INTO pb_entry (batch_id, row_no, project_id, project_code, project_name, org_id,
      fund_source, budget_cents, executed_cents, exec_month) VALUES (?, 1, ?, ?, ?, ?, '自有资金', 10000, 1000, '2026-06')`);
    let oldId = 0;
    db.transaction(() => {
      for (let i = 0; i < 302; i++) {
        const name = i < 2 ? '历史泵站预算' : `近期批次${i}`;
        const batchId = Number(insertBatch.run(name, fileId, String(i).padStart(64, '0'), now).lastInsertRowid);
        const orgId = i === 1 ? fx.orgIds.nanjing : fx.orgIds.shanghai;
        const projectId = i === 1 ? njProject : shProject;
        insertEntry.run(batchId, projectId, i === 1 ? 'OLD-NJ' : 'OLD-SH', '预算项目', orgId);
        if (i === 0) oldId = batchId;
      }
    })();
    const sh = createScopedUser(db, { username: 't6-old-sh', roleCodes: ['viewer'], orgIds: [fx.orgIds.shanghai] });
    const result = await json(get(base, sh.session, `/api/search?q=${encodeURIComponent('历史泵站')}&types=project_budget_batch`));
    expect(result.items.map((i: { id: number }) => i.id)).toEqual([oldId]);
    expect(result.items[0].path).toBe(`/project-budget?batchId=${oldId}`);
    const suggestions = await json(get(base, sh.session, `/api/search/suggestions?q=${encodeURIComponent('历史泵站')}`));
    expect(suggestions.items.filter((i: { type: string }) => i.type === 'project_budget_batch').map((i: { id: number }) => i.id)).toEqual([oldId]);
    // 领域列表的关键词按字面匹配,不能借通配符扩大结果。
    as(db, sh.userId, () => expect(listProjectBudgetBatches(db, { keyword: '%' })).toEqual([]));
  });

  it('按权限与组织范围检索,排序、截断、通配符与路由', async () => {
    const { base, db, admin, fx } = await boot('newfc-t6-search-');
    await createProject(base, admin, 'SW-SH-01', '临港水厂', fx.orgIds.shanghai);
    await createProject(base, admin, 'SW-NJ-01', '江北水厂扩建', fx.orgIds.nanjing);
    await createSupplier(base, admin, 'GYS-01', '水厂设备公司');
    const ctSh = seedContract(db, 'HT-SH-001', '临港水厂施工合同', fx.orgIds.shanghai);
    seedContract(db, 'HT-NJ-001', '江北水厂施工合同', fx.orgIds.nanjing);
    const sh = createScopedUser(db, { username: 't6-viewer-sh', roleCodes: ['viewer'], orgIds: [fx.orgIds.shanghai] });
    const other = createScopedUser(db, { username: 't6-analyst-all', roleCodes: ['finance_analyst'], allOrgs: true });
    seedReport(db, 'RPT-202606-00001', '水厂运营分析(已发布)', fx.orgIds.shanghai, 'published', other.userId);
    seedReport(db, 'RPT-202606-00002', '水厂运营分析(他人草稿)', fx.orgIds.shanghai, 'draft', other.userId);
    seedReport(db, 'RPT-202606-00003', '水厂运营分析(本人草稿)', fx.orgIds.shanghai, 'draft', sh.userId);

    // 受限用户:只见上海的项目/合同,不见他人草稿;供应商为集团共享主数据
    const r = await json(get(base, sh.session, `/api/search?q=${encodeURIComponent('水厂')}`));
    const byType = (t: string) => r.items.filter((i: any) => i.type === t);
    expect(byType('project').map((i: any) => i.code)).toEqual(['SW-SH-01']);
    expect(byType('contract').map((i: any) => i.code)).toEqual(['HT-SH-001']);
    expect(byType('contract')[0]).toMatchObject({ typeLabel: '合同', orgName: '上海公司', path: `/contracts?id=${ctSh}` });
    expect(byType('supplier').map((i: any) => i.title)).toEqual(['水厂设备公司']);
    expect(byType('analysis_report').map((i: any) => i.code).sort()).toEqual(['RPT-202606-00001', 'RPT-202606-00003']);
    expect(JSON.stringify(r)).not.toContain('江北');
    expect(r.skipped).toEqual([]);

    // 全组织用户:两地都可见;前缀命中排在包含命中之前
    const all = await json(get(base, other.session, `/api/search?q=${encodeURIComponent('HT-')}&types=contract`));
    expect(all.items.map((i: any) => i.code).sort()).toEqual(['HT-NJ-001', 'HT-SH-001']);
    const ranked = await json(get(base, admin, `/api/search?q=${encodeURIComponent('临港水厂')}&types=project,contract`));
    expect(ranked.items[0]).toMatchObject({ type: 'project', title: '临港水厂' });

    // 单类上限与截断标记
    const limited = await json(get(base, admin, `/api/search?q=${encodeURIComponent('水厂')}&types=project&limit=1`));
    expect(limited.items).toHaveLength(1);
    expect(limited.truncated).toEqual({ project: true });

    // 缺少 contract:read 的角色:合同类型跳过,其余照常
    const role = runWithContext(systemContext('cli'), () => createRole(db, { code: 't6_master_only', name: '仅主数据', permissions: ['master:read', 'search:use', 'assistant:use'] }));
    const masterOnly = createScopedUser(db, { username: 't6-master-only', roleCodes: [role.code], allOrgs: true });
    const mo = await json(get(base, masterOnly.session, `/api/search?q=${encodeURIComponent('水厂')}`));
    expect([...new Set(mo.items.map((i: any) => i.type))].sort()).toEqual(['project', 'supplier']);
    expect(mo.skipped).toContain('contract');
    expect(mo.skipped).toContain('analysis_report');
    expect(mo.skipped).not.toContain('project');
    // 没有 search:use 的角色:接口与助手工具都拒绝
    const noSearch = runWithContext(systemContext('cli'), () => createRole(db, { code: 't6_no_search', name: '无检索', permissions: ['master:read', 'assistant:use'] }));
    const ns = createScopedUser(db, { username: 't6-no-search', roleCodes: [noSearch.code], allOrgs: true });
    expect((await get(base, ns.session, '/api/search?q=水厂')).status).toBe(403);
    as(db, ns.userId, () => expect(() => executeTool(db, 'cross_search', { q: '水厂' })).toThrow());

    // 通配符不生效:只含 % _ 时拒绝;'%' 不能匹配全部
    const wild = await get(base, admin, `/api/search?q=${encodeURIComponent('%_')}`);
    expect(wild.status).toBe(400);
    // 若 % 作为通配符,'HT%001' 会命中两份合同;去除后为字面量 'HT001',不命中
    const pct = await json(get(base, admin, `/api/search?q=${encodeURIComponent('HT%001')}&types=contract`));
    expect(pct).toMatchObject({ query: 'HT001', items: [] });
    expect((await get(base, admin, '/api/search?q=x&types=contract,bogus')).status).toBe(400);
    expect((await get(base, admin, '/api/search?q=')).status).toBe(400);

    // 所有结果路径都能在前端路由表中找到
    const routes = frontendRoutes();
    const everything = await json(get(base, admin, `/api/search?q=${encodeURIComponent('水')}`));
    expect(everything.items.length).toBeGreaterThan(0);
    for (const item of everything.items) {
      const pathname = item.path.split('?')[0];
      expect(routes.some((re) => re.test(pathname)), item.path).toBe(true);
    }
  });

  it('每种类型的结果路径都指向前端路由', async () => {
    const { db, fx } = await boot('newfc-t6-search-paths-');
    const routes = frontendRoutes();
    db.prepare(`INSERT INTO if_project (code, name, org_id, construction_start_year, operation_start_year, horizon_years, created_at, updated_at)
      VALUES ('FS-ZZ', '综合测算', ?, 2026, 2028, 20, ?, ?)`).run(fx.orgIds.shanghai, now, now);
    db.prepare('INSERT INTO ff_model (name, org_id, base_year, horizon_years, created_at, updated_at) VALUES (?, ?, 2026, 5, ?, ?)').run('综合预测', fx.orgIds.shanghai, now, now);
    seedReport(db, 'RPT-202606-00009', '综合报告', null, 'published', null);
    const res = runWithContext(systemContext('cli'), () => crossDomainSearch(db, { q: '综合' }));
    const types = new Set(res.items.map((i) => i.type));
    for (const t of ['feasibility_project', 'forecast_model', 'analysis_report']) expect(types.has(t as never), t).toBe(true);
    for (const item of res.items) expect(routes.some((re) => re.test(item.path.split('?')[0])), item.path).toBe(true);
    // 路径模板覆盖全部类型(不依赖是否命中)
    const svc = fs.readFileSync(path.join(__dirname, '../src/modules/search/search.service.ts'), 'utf8');
    const templates = [...svc.matchAll(/path: `([^`?$]+)/g)].map((m) => m[1].replace(/\/$/, '/1'));
    expect(templates.length).toBe(SEARCH_TYPES.length);
    for (const t of templates) expect(routes.some((re) => re.test(t)), t).toBe(true);
  });

  it('助手 cross_search 与接口同源,按身份裁剪且不超过 30 条', async () => {
    const { base, db, admin, fx } = await boot('newfc-t6-search-tool-');
    expect(TOOL_POLICIES.cross_search).toMatchObject({ permission: 'search:use', scope: 'global' });
    expect(toolDefinitions.some((d) => d.function.name === 'cross_search')).toBe(true);
    expect(allowedToolsForCapabilities([])).toContain('cross_search');
    for (let i = 0; i < 15; i++) {
      seedContract(db, `HT-A-${String(i).padStart(2, '0')}`, `批量合同${i}`, fx.orgIds.shanghai);
      await createProject(base, admin, `XM-A-${String(i).padStart(2, '0')}`, `批量项目${i}`, fx.orgIds.shanghai);
      await createSupplier(base, admin, `GS-A-${String(i).padStart(2, '0')}`, `批量供应商${i}`);
    }
    seedContract(db, 'HT-NJ-X', '批量合同南京', fx.orgIds.nanjing);
    const sh = createScopedUser(db, { username: 't6-tool-sh', roleCodes: ['viewer'], orgIds: [fx.orgIds.shanghai] });
    as(db, sh.userId, () => {
      const r = executeTool(db, 'cross_search', { q: '批量' }) as any;
      expect(r.items.length).toBe(30);
      expect(JSON.stringify(r)).not.toContain('南京');
      const only = executeTool(db, 'cross_search', { q: '批量', types: ['contract'] }) as any;
      expect(only.items.every((i: any) => i.type === 'contract')).toBe(true);
      expect(only.truncated).toEqual({ contract: true });
      expect(() => executeTool(db, 'cross_search', { q: '批量', types: ['bogus'] })).toThrow(/types/);
      expect(() => executeTool(db, 'cross_search', {})).toThrow(/q/);
      expect(() => executeTool(db, 'cross_search', { q: '%%' })).toThrow(/通配符/);
    });
  });
});
