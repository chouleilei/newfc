/**
 * T-2:AC-X04 / AC-F20 / AC-F24 助手与分析接口的组织范围。
 *
 * 样本:集团 → 华东(上海、杭州)/西部(南京)。受限用户只授权「上海公司」。
 * 杭州、南京各有一条独一无二的金额(43.21 / 987.65 元),任一出现在受限用户可见的
 * 输出里即为越权泄漏;集团合计同理。
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Server } from 'http';
import { createApp } from '../src/server';
import type { DB } from '../src/db/connection';
import { buildFixture, saveActualSnapshot, budget, type Fixture } from './helpers';
import { createScopedUser, ensureAdmin, fetchAs, sessionFor } from './http-helpers';

type TestSession = ReturnType<typeof sessionFor>;
import { runWithContext, systemContext } from '../src/core/request-context';
import { loadAuthContext, updateUser } from '../src/modules/security/security.service';
import { executeTool } from '../src/assistant/tools';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function boot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'newfc-scope-'));
  const { app, holder } = await createApp({ dbPath: path.join(dir, 'newfc.sqlite') });
  const server: Server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  cleanups.push(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    try { holder.getDb().close(); } catch { /* closed */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { base, db: holder.getDb() };
}

/** 杭州/南京的独有金额(分)与名称;集团合计收入 100 + 50 + 987.65 = 1137.65 元。 */
const FOREIGN_MARKERS = ['杭州公司', '南京公司', '98765', '4321', '113765'];

function seed(fx: Fixture) {
  // saveEntries 是整表替换:标准样本与范围外独有金额一次写入
  const v = budget.createVersion(fx.db, { year: 2026, name: 'V1' });
  budget.saveEntries(fx.db, v.id, [
    { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '100.00' },
    { orgId: fx.orgIds.shanghai, accountId: fx.accIds.costSub, amount: '60.00' },
    { orgId: fx.orgIds.shanghai, accountId: fx.accIds.expenseAdmin, amount: '20.00' },
    { orgId: fx.orgIds.hangzhou, accountId: fx.accIds.incomeMain, amount: '50.00' },
    { orgId: fx.orgIds.hangzhou, accountId: fx.accIds.expenseOther, amount: '43.21' },
    { orgId: fx.orgIds.nanjing, accountId: fx.accIds.incomeMain, amount: '987.65' },
  ]);
  saveActualSnapshot(fx, 2026, '2026-06-30', [
    { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '40.00' },
    { orgId: fx.orgIds.hangzhou, accountId: fx.accIds.incomeMain, amount: '43.21' },
    { orgId: fx.orgIds.nanjing, accountId: fx.accIds.incomeMain, amount: '987.65' },
  ]);
  return v;
}

function expectNoLeak(label: string, value: unknown) {
  const text = JSON.stringify(value);
  for (const marker of FOREIGN_MARKERS) {
    if (text.includes(marker)) throw new Error(`${label} 泄漏了范围外事实「${marker}」`);
  }
}

function as<T>(db: DB, userId: number, fn: () => T): T {
  const auth = loadAuthContext(db, userId);
  if (!auth) throw new Error('user disabled');
  return runWithContext({ requestId: 'test', source: 'http', auth }, fn);
}

function codeOf(fn: () => unknown): string | undefined {
  try { fn(); return undefined; } catch (err) { return (err as { code?: string }).code; }
}

async function json(res: Response) { return { status: res.status, body: await res.json() as any }; }

function post(session: TestSession, url: string, body: unknown) {
  return fetchAs(session, url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

describe('AC-X04 助手工具按同一 AuthContext 裁剪', () => {
  it('受限用户的 org_scope 工具只返回授权子树,缺省取唯一授权根;输出不含范围外名称/金额', async () => {
    const { db } = await boot();
    ensureAdmin(db);
    const fx = buildFixture(db);
    const v = seed(fx);
    const sh = createScopedUser(db, { username: 'sh-analyst', roleCodes: ['finance_analyst'], orgIds: [fx.orgIds.shanghai] });
    as(db, sh.userId, () => {
      const outputs: Record<string, unknown> = {
        calculate_execution: executeTool(db, 'calculate_execution', { versionId: v.id } as any),
        calculate_trend: executeTool(db, 'calculate_trend', { year: 2026, versionId: v.id } as any),
        calculate_anomalies: executeTool(db, 'calculate_anomalies', { versionId: v.id } as any),
        calculate_attribution: executeTool(db, 'calculate_attribution', { versionId: v.id } as any),
        calculate_structure: executeTool(db, 'calculate_structure', { versionId: v.id } as any),
        calculate_multi_year_trend: executeTool(db, 'calculate_multi_year_trend', { baseYear: 2026 } as any),
        generate_report: executeTool(db, 'generate_report', { kind: 'monthly_execution', versionId: v.id } as any),
        get_metric_evidence: executeTool(db, 'get_metric_evidence', { versionId: v.id, metricId: fx.metricIds.gross } as any),
        get_org_tree: executeTool(db, 'get_org_tree', {  }),
      };
      for (const [name, out] of Object.entries(outputs)) expectNoLeak(name, out);
      // 上海收入预算 100 元确实被算出来(不是空结果冒充通过)
      expect(JSON.stringify(outputs.calculate_execution)).toContain('10000');
    });
  });

  it('伪造范围参数:范围外组织 404,集团口径工具 SCOPE_RESTRICTED,穿透缺组织 SCOPE_REQUIRED', async () => {
    const { db } = await boot();
    ensureAdmin(db);
    const fx = buildFixture(db);
    const v = seed(fx);
    const sh = createScopedUser(db, { username: 'sh-forge', roleCodes: ['finance_analyst'], orgIds: [fx.orgIds.shanghai] });
    as(db, sh.userId, () => {
      expect(codeOf(() => executeTool(db, 'calculate_execution', { versionId: v.id, orgScopeId: fx.orgIds.nanjing } as any))).toBe('NOT_FOUND');
      expect(codeOf(() => executeTool(db, 'calculate_execution', { versionId: v.id, orgScopeId: fx.orgIds.root } as any))).toBe('NOT_FOUND');
      expect(codeOf(() => executeTool(db, 'calculate_multi_year_trend', { baseYear: 2026, orgCodes: ['NJ'] } as any))).toBe('NOT_FOUND');
      expect(codeOf(() => executeTool(db, 'get_budget_matrix', { versionId: v.id }))).toBe('SCOPE_RESTRICTED');
      expect(codeOf(() => executeTool(db, 'get_historical_comparison', {  }))).toBe('SCOPE_RESTRICTED');
      expect(codeOf(() => executeTool(db, 'generate_report', { kind: 'annual_review', year: 2026 } as any))).toBe('SCOPE_RESTRICTED');
      expect(codeOf(() => executeTool(db, 'get_cell_evidence', { source: 'budget', sourceId: v.id, accountId: fx.accIds.incomeMain } as any))).toBe('SCOPE_REQUIRED');
      expect(codeOf(() => executeTool(db, 'get_cell_evidence', { source: 'budget', sourceId: v.id, accountId: fx.accIds.incomeMain, orgId: fx.orgIds.nanjing } as any))).toBe('NOT_FOUND');
      expect(codeOf(() => executeTool(db, 'get_budget_cell_history', { versionId: v.id, orgId: fx.orgIds.hangzhou, accountId: fx.accIds.incomeMain }))).toBe('NOT_FOUND');
    });
    // 无操作权限:只读查看角色没有 import:run
    const viewer = createScopedUser(db, { username: 'viewer-all', roleCodes: ['viewer'], allOrgs: true });
    as(db, viewer.userId, () => {
      expect(codeOf(() => executeTool(db, 'explain_import', {} as any))).toBe('FORBIDDEN');
    });
  });

  it('多个授权根:不指定组织时 SCOPE_REQUIRED,指定其一则放行', async () => {
    const { db } = await boot();
    ensureAdmin(db);
    const fx = buildFixture(db);
    const v = seed(fx);
    const multi = createScopedUser(db, { username: 'multi-root', roleCodes: ['finance_analyst'], orgIds: [fx.orgIds.shanghai, fx.orgIds.nanjing] });
    as(db, multi.userId, () => {
      expect(codeOf(() => executeTool(db, 'calculate_execution', { versionId: v.id } as any))).toBe('SCOPE_REQUIRED');
      const out = executeTool(db, 'calculate_execution', { versionId: v.id, orgScopeId: fx.orgIds.nanjing } as any);
      expect(JSON.stringify(out)).toContain('98765');
    });
  });
});

describe('AC-X04 分析接口与工作台(HTTP)', () => {
  it('执行报表/穿透/导出按范围裁剪,越权 404,集团口径 403,工作台只给范围内计数且无日志', async () => {
    const { base, db } = await boot();
    ensureAdmin(db);
    const fx = buildFixture(db);
    const v = seed(fx);
    const sh = createScopedUser(db, { username: 'sh-http', roleCodes: ['finance_analyst'], orgIds: [fx.orgIds.shanghai] });

    const page = await json(await fetchAs(sh.session, `${base}/api/report/completion?versionId=${v.id}`));
    expect(page.status).toBe(200);
    expectNoLeak('/api/report/completion', page.body);

    // AC-F20 同源:页面接口与助手工具在同一身份、同一范围下逐字段一致
    const toolOut = as(db, sh.userId, () => executeTool(db, 'calculate_execution', { versionId: v.id, sheetKey: 'all' } as any));
    expect(JSON.parse(JSON.stringify(toolOut)).analysisAccounts).toEqual(page.body.analysisAccounts);

    expect((await fetchAs(sh.session, `${base}/api/report/completion?versionId=${v.id}&orgScopeId=${fx.orgIds.nanjing}`)).status).toBe(404);
    expect((await fetchAs(sh.session, `${base}/api/report/structure?versionId=${v.id}&orgScopeId=${fx.orgIds.east}`)).status).toBe(404);
    const anomalies = await json(await fetchAs(sh.session, `${base}/api/analysis/anomalies?versionId=${v.id}`));
    expect(anomalies.status).toBe(200);
    expectNoLeak('/api/analysis/anomalies', anomalies.body);
    const trend = await json(await fetchAs(sh.session, `${base}/api/report/trend?year=2026&versionId=${v.id}`));
    expect(trend.status).toBe(200);
    expectNoLeak('/api/report/trend', trend.body);

    const noOrg = await json(await fetchAs(sh.session, `${base}/api/evidence/budget-cell?versionId=${v.id}&accountId=${fx.accIds.incomeMain}`));
    expect(noOrg.status).toBe(400);
    expect(noOrg.body.code).toBe('SCOPE_REQUIRED');
    expect((await fetchAs(sh.session, `${base}/api/evidence/budget-cell?versionId=${v.id}&accountId=${fx.accIds.incomeMain}&orgId=${fx.orgIds.hangzhou}`)).status).toBe(404);
    expect((await fetchAs(sh.session, `${base}/api/evidence/budget-cell?versionId=${v.id}&accountId=${fx.accIds.incomeMain}&orgId=${fx.orgIds.shanghai}`)).status).toBe(200);

    const historical = await json(await fetchAs(sh.session, `${base}/api/report/historical`));
    expect(historical.status).toBe(403);
    expect(historical.body.code).toBe('SCOPE_RESTRICTED');
    expect((await fetchAs(sh.session, `${base}/api/io/export/budget-detail/${v.id}`)).status).toBe(403);
    const exported = await fetchAs(sh.session, `${base}/api/io/export/completion/${v.id}`);
    expect(exported.status).toBe(200);
    expect((await fetchAs(sh.session, `${base}/api/io/export/completion/${v.id}?orgScopeId=${fx.orgIds.nanjing}`)).status).toBe(404);

    const dash = await json(await fetchAs(sh.session, `${base}/api/dashboard`));
    expect(dash.status).toBe(200);
    expect(dash.body.counts.orgs).toBe(1);
    expect(dash.body.recentLogs).toEqual([]);
    expect(dash.body.scopeLimited).toBe(true);

    const multi = createScopedUser(db, { username: 'multi-http', roleCodes: ['finance_analyst'], orgIds: [fx.orgIds.shanghai, fx.orgIds.nanjing] });
    const required = await json(await fetchAs(multi.session, `${base}/api/report/completion?versionId=${v.id}`));
    expect(required.status).toBe(400);
    expect(required.body.code).toBe('SCOPE_REQUIRED');
  });
});

describe('AC-X04 / AC-F20 助手问答与记录归属(HTTP)', () => {
  it('规则问答按授权根取范围并如实说明;点名范围外组织 404;回答不含范围外事实', async () => {
    const { base, db } = await boot();
    ensureAdmin(db);
    const fx = buildFixture(db);
    const v = seed(fx);
    const sh = createScopedUser(db, { username: 'sh-chat', roleCodes: ['finance_analyst'], orgIds: [fx.orgIds.shanghai] });

    const chat = await json(await post(sh.session, `${base}/api/assistant/chat`, { message: '2026年预算执行情况怎么样', context: { year: 2026, budgetVersionId: v.id } }));
    expect(chat.status).toBe(200);
    expect(chat.body.resolvedContext.orgId).toBe(fx.orgIds.shanghai);
    expect(JSON.stringify(chat.body)).toContain('按当前账号的授权组织范围');
    expectNoLeak('assistant chat', chat.body);
    // 回答确实基于上海的事实(预算收入 100 元 = 10000 分),而不是空结果
    expect(JSON.stringify(chat.body)).toContain('"budgetCents":10000');

    const outside = await json(await post(sh.session, `${base}/api/assistant/chat`, { message: '南京公司2026年预算执行情况', context: { year: 2026, budgetVersionId: v.id } }));
    expect(outside.status).toBe(404);
    const forged = await json(await post(sh.session, `${base}/api/assistant/chat`, { message: '执行情况', context: { year: 2026, budgetVersionId: v.id, orgId: fx.orgIds.hangzhou } }));
    expect(forged.status).toBe(404);
  });

  it('会话/洞察按创建人隔离:他人会话 404;受限用户看不到集团洞察,全组织用户可见受限用户的洞察', async () => {
    const { base, db } = await boot();
    const adminId = ensureAdmin(db);
    const admin = sessionFor(db, adminId);
    const fx = buildFixture(db);
    const v = seed(fx);
    const sh = createScopedUser(db, { username: 'sh-owner', roleCodes: ['finance_analyst'], orgIds: [fx.orgIds.shanghai] });

    const adminChat = await json(await post(admin, `${base}/api/assistant/chat`, { message: '列出预算版本', context: { year: 2026 } }));
    expect(adminChat.status).toBe(200);
    const adminConv = adminChat.body.conversationId;
    const adminInsight = await json(await post(admin, `${base}/api/assistant/insights`, { kind: 'execution', params: { versionId: v.id }, title: '集团执行洞察' }));
    expect(adminInsight.status).toBe(201);

    const list = await json(await fetchAs(sh.session, `${base}/api/assistant/conversations`));
    expect(list.body.items.map((c: any) => c.id)).not.toContain(adminConv);
    expect((await fetchAs(sh.session, `${base}/api/assistant/conversations/${adminConv}`)).status).toBe(404);
    const hijack = await post(sh.session, `${base}/api/assistant/chat`, { conversationId: adminConv, message: '继续' });
    expect(hijack.status).toBe(404);
    expect((await fetchAs(sh.session, `${base}/api/assistant/insights/${adminInsight.body.id}`)).status).toBe(404);
    const shInsights = await json(await fetchAs(sh.session, `${base}/api/assistant/insights`));
    expect(shInsights.body.items).toEqual([]);

    const own = await json(await post(sh.session, `${base}/api/assistant/insights`, { kind: 'execution', params: { versionId: v.id }, title: '上海执行洞察' }));
    expect(own.status).toBe(201);
    expectNoLeak('restricted insight', own.body);
    const adminView = await json(await fetchAs(admin, `${base}/api/assistant/insights`));
    expect(adminView.body.items.map((i: any) => i.id)).toEqual(expect.arrayContaining([adminInsight.body.id, own.body.id]));
    expect(JSON.stringify(own.body)).not.toContain('owner_user_id');
  });

  it('写操作与正式页面同权:预算写入需 budget:write + 全组织;明细导出限全组织;执行导出按范围;确认/下载前复核', async () => {
    const { base, db } = await boot();
    ensureAdmin(db);
    const fx = buildFixture(db);
    const v = seed(fx);
    const viewer = createScopedUser(db, { username: 'sh-viewer', roleCodes: ['viewer'], orgIds: [fx.orgIds.shanghai] });
    const maintainer = createScopedUser(db, { username: 'sh-maint', roleCodes: ['data_maintainer'], orgIds: [fx.orgIds.shanghai] });
    const analyst = createScopedUser(db, { username: 'sh-export', roleCodes: ['finance_analyst'], orgIds: [fx.orgIds.shanghai] });

    const copy = { type: 'copy_budget', params: { sourceVersionId: v.id, name: '副本', targetYear: 2027 } };
    expect((await json(await post(viewer.session, `${base}/api/assistant/preview`, copy))).body.code).toBe('FORBIDDEN');
    expect((await json(await post(maintainer.session, `${base}/api/assistant/preview`, copy))).body.code).toBe('SCOPE_RESTRICTED');

    const detail = await json(await post(analyst.session, `${base}/api/assistant/preview`, { type: 'export', params: { kind: 'budget_detail', versionId: v.id } }));
    expect(detail.body.code).toBe('SCOPE_RESTRICTED');
    const forged = await json(await post(analyst.session, `${base}/api/assistant/preview`, { type: 'export', params: { kind: 'completion', versionId: v.id, options: { orgScopeId: fx.orgIds.nanjing } } }));
    expect(forged.status).toBe(404);
    const preview = await json(await post(analyst.session, `${base}/api/assistant/preview`, { type: 'export', params: { kind: 'completion', versionId: v.id } }));
    expect(preview.status).toBe(201);
    expect(preview.body.preview).toMatchObject({ kind: 'completion' });

    // 他人不能确认/查看该操作(即使拿到 id)
    const other = await post(maintainer.session, `${base}/api/assistant/actions/${preview.body.id}/confirm`, { confirmationToken: preview.body.confirmationToken });
    expect(other.status).toBe(404);

    // 预览后授权范围被改到杭州:确认按新范围复核,拒绝
    runWithContext(systemContext('cli'), () => updateUser(db, analyst.userId, { orgIds: [fx.orgIds.hangzhou] }));
    const confirm = await post(analyst.session, `${base}/api/assistant/actions/${preview.body.id}/confirm`, { confirmationToken: preview.body.confirmationToken });
    expect(confirm.status).toBe(404);
  });
});
