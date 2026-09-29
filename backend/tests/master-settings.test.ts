/**
 * T-1:AC-F07 master_data(项目/供应商/编码映射,停用与映射变更不改历史解析)、
 * AC-F23 system_settings(类型化业务设置、整批校验、凭据不回显、无旧平台设置)。
 * 经真实 HTTP + Cookie 会话 + CSRF 链路验证。
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Server } from 'http';
import { createApp } from '../src/server';
import type { DB } from '../src/db/connection';
import { buildFixture, type Fixture } from './helpers';
import { createScopedUser, ensureAdmin, fetchAs, sessionFor } from './http-helpers';
import { purgeExpiredJobs } from '../src/modules/jobs/job.service';
import { compactOrgName, normalizeName } from '../src/modules/master/master.service';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

type Session = { cookie: string; csrf: string };

async function boot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'newfc-master-'));
  const { app, holder } = await createApp({ dbPath: path.join(dir, 'newfc.sqlite') });
  const server: Server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  cleanups.push(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    try { holder.getDb().close(); } catch { /* closed */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const db = holder.getDb();
  const admin = sessionFor(db, ensureAdmin(db));
  const fx = buildFixture(db);
  const call = async (session: Session, method: string, p: string, body?: unknown) => {
    const res = await fetchAs(session, `${base}/api${p}`, {
      method, headers: body === undefined ? {} : { 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body),
    });
    return { status: res.status, body: await res.json() as any };
  };
  return { db, admin, fx, call };
}

function lastLog(db: DB, action: string) {
  return db.prepare('SELECT * FROM operation_log WHERE action = ? ORDER BY id DESC LIMIT 1').get(action) as { detail_json: string; actor: string; request_id: string } | undefined;
}

describe('AC-F07 项目与组织范围', () => {
  it('项目 CRUD:编码唯一且不可改,停用留审计;受限用户只见授权组织项目,范围外 404', async () => {
    const { db, admin, fx, call } = await boot();
    const created = await call(admin, 'POST', '/master/projects', { code: 'P-SH-01', name: '上海泵站改造', orgId: fx.orgIds.shanghai, projectType: '改造' });
    expect(created.status).toBe(201);
    expect(created.body).toMatchObject({ code: 'P-SH-01', orgName: '上海公司', status: 'active' });
    const west = await call(admin, 'POST', '/master/projects', { code: 'P-NJ-01', name: '南京堤防', orgId: fx.orgIds.nanjing });
    expect(west.status).toBe(201);
    expect((await call(admin, 'POST', '/master/projects', { code: 'P-SH-01', name: '重复', orgId: fx.orgIds.shanghai })).body.code).toBe('CODE_TAKEN');
    expect((await call(admin, 'PATCH', `/master/projects/${created.body.id}`, { code: 'P-X' })).status).toBe(400);

    const off = await call(admin, 'PATCH', `/master/projects/${created.body.id}`, { status: 'inactive' });
    expect(off.body.status).toBe('inactive');
    expect(lastLog(db, 'master.project.deactivate')?.actor).toBe('test-admin');

    const maint = createScopedUser(db, { username: 'maint-west', roleCodes: ['data_maintainer'], orgIds: [fx.orgIds.west] });
    const list = await call(maint.session, 'GET', '/master/projects');
    expect(list.body.map((p: { code: string }) => p.code)).toEqual(['P-NJ-01']);
    expect((await call(maint.session, 'GET', `/master/projects/${created.body.id}`)).status).toBe(404);
    expect((await call(maint.session, 'POST', '/master/projects', { code: 'P-SH-02', name: '越权', orgId: fx.orgIds.shanghai })).status).toBe(404);
    expect((await call(maint.session, 'PATCH', `/master/projects/${west.body.id}`, { orgId: fx.orgIds.shanghai })).status).toBe(404);
    expect((await call(maint.session, 'POST', '/master/projects', { code: 'P-NJ-02', name: '南京二期', orgId: fx.orgIds.nanjing })).status).toBe(201);

    const viewer = createScopedUser(db, { username: 'viewer-all', roleCodes: ['viewer'], allOrgs: true });
    expect((await call(viewer.session, 'GET', '/master/projects')).body).toHaveLength(3);
    expect((await call(viewer.session, 'POST', '/master/projects', { code: 'P-V', name: 'v', orgId: fx.orgIds.root })).status).toBe(403);
  });
});

describe('AC-X04 组织树按授权范围返回', () => {
  it('受限用户只拿到授权子树,授权根作为根节点;全组织用户拿到整棵树', async () => {
    const { db, admin, fx, call } = await boot();
    const east = createScopedUser(db, { username: 'viewer-east', roleCodes: ['viewer'], orgIds: [fx.orgIds.east] });
    const t = await call(east.session, 'GET', '/org/tree');
    expect(t.status).toBe(200);
    expect(t.body.rows.map((r: { code: string }) => r.code).sort()).toEqual(['EAST', 'HZ', 'SH']);
    expect(t.body.tree).toHaveLength(1);
    expect(t.body.tree[0]).toMatchObject({ code: 'EAST', parentId: null });
    expect(t.body.leafIds.sort()).toEqual([fx.orgIds.shanghai, fx.orgIds.hangzhou].sort());
    expect(JSON.stringify(t.body)).not.toContain('南京');
    const none = createScopedUser(db, { username: 'viewer-none', roleCodes: ['viewer'], orgIds: [] });
    expect((await call(none.session, 'GET', '/org/tree')).body.rows).toEqual([]);
    expect((await call(admin, 'GET', '/org/tree')).body.rows).toHaveLength(6);
  });
});

describe('AC-F07 供应商归一化', () => {
  it('全角/空白/括号差异视为同名;信用代码校验;改名冲突 409', async () => {
    const { call, admin } = await boot();
    const a = await call(admin, 'POST', '/master/suppliers', { name: '浙江水利（集团）有限公司', creditCode: '91330000123456789X' });
    expect(a.status).toBe(201);
    const dup = await call(admin, 'POST', '/master/suppliers', { name: ' 浙江 水利(集团)有限公司 ' });
    expect(dup.status).toBe(409);
    expect(dup.body.code).toBe('DUPLICATE_SUPPLIER');
    expect((await call(admin, 'POST', '/master/suppliers', { name: '丽水建工', creditCode: 'bad-code' })).status).toBe(400);
    const b = await call(admin, 'POST', '/master/suppliers', { name: '丽水建工', code: 'S002' });
    expect((await call(admin, 'PATCH', `/master/suppliers/${b.body.id}`, { name: '浙江水利(集团)有限公司' })).status).toBe(409);
    expect((await call(admin, 'GET', '/master/suppliers?keyword=浙江 水利')).body).toHaveLength(1);
    expect(normalizeName('ＡＢＣ 公司（一）')).toBe('abc公司一');
    expect(compactOrgName('上海 分公司')).toBe('上海');
  });
});

describe('AC-F07 编码映射与解析', () => {
  async function seedProjects(ctx: Awaited<ReturnType<typeof boot>>) {
    const a = (await ctx.call(ctx.admin, 'POST', '/master/projects', { code: 'P-A', name: '项目甲', orgId: ctx.fx.orgIds.shanghai })).body;
    const b = (await ctx.call(ctx.admin, 'POST', '/master/projects', { code: 'P-B', name: '项目乙', orgId: ctx.fx.orgIds.nanjing })).body;
    return { a, b };
  }

  it('映射变更 = 退役旧行 + 新增行;按 asOf 复现历史口径;目标停用不改历史解析', async () => {
    const ctx = await boot();
    const { db, admin, call } = ctx;
    const { a, b } = await seedProjects(ctx);
    const m1 = await call(admin, 'POST', '/master/mappings', { sourceSystem: 'eas', entityType: 'project', sourceKey: 'EAS-0001', targetId: a.id, validFrom: '2026-01-01T00:00:00.000Z' });
    expect(m1.status).toBe(201);
    // 同目标重复提交幂等
    expect((await call(admin, 'POST', '/master/mappings', { sourceSystem: 'eas', entityType: 'project', sourceKey: 'EAS-0001', targetId: a.id, validFrom: '2026-02-01T00:00:00.000Z' })).body.id).toBe(m1.body.id);
    // 生效时间不能早于现行映射
    expect((await call(admin, 'POST', '/master/mappings', { sourceSystem: 'eas', entityType: 'project', sourceKey: 'EAS-0001', targetId: b.id, validFrom: '2025-12-01T00:00:00.000Z' })).status).toBe(400);
    const m2 = await call(admin, 'POST', '/master/mappings', { sourceSystem: 'eas', entityType: 'project', sourceKey: 'EAS-0001', targetId: b.id, validFrom: '2026-06-01T00:00:00.000Z' });
    expect(m2.status).toBe(201);
    expect(lastLog(db, 'master.mapping.replace')?.detail_json).toContain(`"replaced":${m1.body.id}`);

    const active = await call(admin, 'GET', '/master/mappings');
    expect(active.body.map((m: { id: number }) => m.id)).toEqual([m2.body.id]);
    const all = await call(admin, 'GET', '/master/mappings?includeRetired=1');
    expect(all.body.find((m: { id: number }) => m.id === m1.body.id)).toMatchObject({ active: false, validTo: '2026-06-01T00:00:00.000Z', targetCode: 'P-A' });

    const resolve = (asOf?: string) => call(admin, 'POST', '/master/resolve', { entityType: 'project', sourceSystem: 'eas', asOf, items: [{ code: 'EAS-0001' }] });
    expect((await resolve('2026-03-01T00:00:00.000Z')).body[0]).toMatchObject({ matchedBy: 'mapping_code', targetCode: 'P-A' });
    expect((await resolve()).body[0]).toMatchObject({ matchedBy: 'mapping_code', targetCode: 'P-B' });

    // 目标改名不影响映射(按 id 关联);停用后当前口径不再解析到它,历史口径仍是当时目标
    await call(admin, 'PATCH', `/master/projects/${b.id}`, { name: '项目乙(更名)' });
    expect((await resolve()).body[0].targetName).toBe('项目乙(更名)');
    await call(admin, 'PATCH', `/master/projects/${b.id}`, { status: 'inactive' });
    expect((await resolve()).body[0].matchedBy).toBe('unmatched');
    expect((await resolve('2026-03-01T00:00:00.000Z')).body[0].targetCode).toBe('P-A');
    // 停用目标不能新建映射
    expect((await call(admin, 'POST', '/master/mappings', { sourceSystem: 'eas', entityType: 'project', sourceKey: 'EAS-0009', targetId: b.id })).status).toBe(400);

    const retired = await call(admin, 'POST', `/master/mappings/${m2.body.id}/retire`);
    expect(retired.body.active).toBe(false);
    expect((await call(admin, 'POST', `/master/mappings/${m2.body.id}/retire`)).status).toBe(409);
    expect((await resolve('2026-03-01T00:00:00.000Z')).body[0].targetCode).toBe('P-A');
  });

  it('解析顺序:精确编码 → 映射 → 精确名称 → 名称映射 → 组织去后缀;多候选返回 ambiguous', async () => {
    const ctx = await boot();
    const { admin, call, fx } = ctx;
    await seedProjects(ctx);
    await call(admin, 'POST', '/master/mappings', { sourceSystem: 'legacy', entityType: 'org', matchKind: 'name', sourceKey: '沪司', targetId: fx.orgIds.shanghai });
    const r = await call(admin, 'POST', '/master/resolve', {
      entityType: 'org',
      items: [{ code: 'SH' }, { name: '上海公司' }, { name: '沪司' }, { name: '上海分公司' }, { name: '不存在单位' }],
    });
    expect(r.body.map((x: { matchedBy: string }) => x.matchedBy)).toEqual(['exact_code', 'exact_name', 'mapping_name', 'normalized_name', 'unmatched']);
    expect(r.body[3]).toMatchObject({ targetId: fx.orgIds.shanghai, confidence: '0.86' });

    // 两个供应商名称不同,但被映射到同一外部编码的不同来源 → 不同来源系统互不干扰;同一键多目标 → ambiguous
    const s1 = (await call(admin, 'POST', '/master/suppliers', { name: '甲供应商' })).body;
    const s2 = (await call(admin, 'POST', '/master/suppliers', { name: '乙供应商' })).body;
    await call(admin, 'POST', '/master/mappings', { sourceSystem: 'eas', entityType: 'supplier', sourceKey: 'V01', targetId: s1.id });
    await call(admin, 'POST', '/master/mappings', { sourceSystem: 'contract', entityType: 'supplier', sourceKey: 'V01', targetId: s2.id });
    const eas = await call(admin, 'POST', '/master/resolve', { entityType: 'supplier', sourceSystem: 'eas', items: [{ code: 'V01' }] });
    expect(eas.body[0].targetName).toBe('甲供应商');
    const any = await call(admin, 'POST', '/master/resolve', { entityType: 'supplier', items: [{ code: 'V01' }] });
    expect(any.body[0].matchedBy).toBe('ambiguous');
    expect(any.body[0].candidates).toHaveLength(2);
  });

  it('受限用户:映射写入 SCOPE_RESTRICTED;解析预览不泄露范围外组织/项目', async () => {
    const ctx = await boot();
    const { db, call, fx } = ctx;
    await seedProjects(ctx);
    const maint = createScopedUser(db, { username: 'maint-west2', roleCodes: ['data_maintainer'], orgIds: [fx.orgIds.west] });
    const w = await call(maint.session, 'POST', '/master/mappings', { sourceSystem: 'eas', entityType: 'org', sourceKey: 'X', targetId: fx.orgIds.nanjing });
    expect(w.status).toBe(403);
    expect(w.body.code).toBe('SCOPE_RESTRICTED');
    const r = await call(maint.session, 'POST', '/master/resolve', { entityType: 'project', items: [{ code: 'P-A' }, { code: 'P-B' }] });
    expect(r.body.map((x: { matchedBy: string }) => x.matchedBy)).toEqual(['unmatched', 'exact_code']);
    const o = await call(maint.session, 'POST', '/master/resolve', { entityType: 'org', items: [{ name: '上海公司' }, { name: '南京公司' }] });
    expect(o.body.map((x: { targetId: number | null }) => x.targetId)).toEqual([null, fx.orgIds.nanjing]);
  });
});

describe('AC-F23 业务设置', () => {
  it('默认值、整批校验(任一不合法全部不写)、未知键与旧平台键拒绝', async () => {
    const { db, admin, call } = await boot();
    const list = await call(admin, 'GET', '/settings/business');
    expect(list.status).toBe(200);
    const month = list.body.items.find((s: { key: string }) => s.key === 'finance.fiscal_year_start_month');
    expect(month).toMatchObject({ value: 1, isDefault: true, type: 'int' });
    expect(JSON.stringify(list.body).toLowerCase()).not.toMatch(/dify|dbgpt|db-gpt/);

    const bad = await call(admin, 'PUT', '/settings/business', { 'report.company_name': '丽水水投', 'finance.fiscal_year_start_month': 13, 'display.amount_unit': 'kilo' });
    expect(bad.status).toBe(400);
    expect(bad.body.errors.map((e: { field: string }) => e.field).sort()).toEqual(['display.amount_unit', 'finance.fiscal_year_start_month']);
    expect(db.prepare('SELECT COUNT(*) AS n FROM app_setting').get()).toEqual({ n: 0 });

    for (const key of ['dify.api_key', 'dbgpt.base_url', 'report.unknown']) {
      const r = await call(admin, 'PUT', '/settings/business', { [key]: 'x' });
      expect(r.body.code).toBe('UNKNOWN_SETTING');
    }

    const ok = await call(admin, 'PUT', '/settings/business', { 'report.company_name': ' 丽水水投 ', 'finance.fiscal_year_start_month': '4', 'display.amount_unit': 'wan_yuan' });
    expect(ok.status).toBe(200);
    const get = (key: string) => ok.body.items.find((s: { key: string }) => s.key === key);
    expect(get('report.company_name')).toMatchObject({ value: '丽水水投', isDefault: false });
    expect(get('finance.fiscal_year_start_month').value).toBe(4);
    // 设回默认值即删除存储行
    const reset = await call(admin, 'PUT', '/settings/business', { 'finance.fiscal_year_start_month': 1 });
    expect(reset.body.items.find((s: { key: string }) => s.key === 'finance.fiscal_year_start_month').isDefault).toBe(true);
    expect(lastLog(db, 'settings.business.save')?.detail_json).toContain('finance.fiscal_year_start_month');
  });

  it('凭据只写不读:列表只返回是否已配置与末 4 位;审计与响应不含明文;null 清除', async () => {
    const { db, admin, call } = await boot();
    const secret = 'ocr-secret-value-9f3a';
    const put = await call(admin, 'PUT', '/settings/business', { 'integration.ocr_api_key': secret, 'integration.ocr_base_url': 'https://ocr.example.com/v1' });
    expect(put.status).toBe(200);
    expect(JSON.stringify(put.body)).not.toContain(secret);
    const item = (await call(admin, 'GET', '/settings/business')).body.items.find((s: { key: string }) => s.key === 'integration.ocr_api_key');
    expect(item).toMatchObject({ value: null, configured: true, preview: '****9f3a' });
    const logs = db.prepare('SELECT detail_json FROM operation_log').all() as { detail_json: string }[];
    expect(logs.some((l) => l.detail_json.includes(secret))).toBe(false);

    expect((await call(admin, 'PUT', '/settings/business', { 'integration.ocr_base_url': 'http://ocr.example.com' })).status).toBe(400);
    expect((await call(admin, 'PUT', '/settings/business', { 'integration.ocr_base_url': 'https://u:p@ocr.example.com' })).status).toBe(400);

    const cleared = await call(admin, 'PUT', '/settings/business', { 'integration.ocr_api_key': null });
    expect(cleared.body.items.find((s: { key: string }) => s.key === 'integration.ocr_api_key')).toMatchObject({ configured: false, preview: null });
  });

  it('无 settings 权限的角色既不能查看也不能修改业务设置', async () => {
    const { db, call } = await boot();
    const viewer = createScopedUser(db, { username: 'viewer-set', roleCodes: ['viewer'], allOrgs: true });
    expect((await call(viewer.session, 'GET', '/settings/business')).status).toBe(403);
    expect((await call(viewer.session, 'PUT', '/settings/business', { 'report.company_name': 'x' })).status).toBe(403);
  });

  it('任务保留期:只清理超期的已结束任务,步骤级联删除', async () => {
    const { db } = await boot();
    const old = new Date(Date.now() - 40 * 86_400_000).toISOString();
    const insert = db.prepare(`INSERT INTO app_job (kind, title, status, created_by, created_at, updated_at, finished_at) VALUES ('demo.kind', 't', ?, 1, ?, ?, ?)`);
    const oldDone = Number(insert.run('succeeded', old, old, old).lastInsertRowid);
    insert.run('running', old, old, null);
    insert.run('failed', old, old, new Date().toISOString());
    db.prepare(`INSERT INTO app_job_step (job_id, seq, step_type, name, status, created_at) VALUES (?, 1, 'system', 's', 'success', ?)`).run(oldDone, old);
    expect(purgeExpiredJobs(db, 30)).toBe(1);
    expect(db.prepare('SELECT COUNT(*) AS n FROM app_job').get()).toEqual({ n: 2 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM app_job_step').get()).toEqual({ n: 0 });
  });
});

export type { Fixture };
