/**
 * T-1:AC-F01 platform_auth、AC-F24 security_administration、AC-F25 audit_log、AC-X04 权限与身份。
 * 全部经真实 HTTP + Cookie 会话 + CSRF 链路验证。
 */
import { describe, it, expect, afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Server } from 'http';
import { createApp } from '../src/server';
import { buildFixture } from './helpers';
import { createScopedUser, fetchAs, TEST_ADMIN, ensureAdmin } from './http-helpers';
import { SESSION_COOKIE } from '../src/modules/security/http';

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function boot(dbPath?: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'newfc-sec-'));
  const file = dbPath ?? path.join(dir, 'newfc.sqlite');
  const { app, holder } = await createApp({ dbPath: file });
  const server: Server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  cleanups.push(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    try { holder.getDb().close(); } catch { /* closed */ }
  });
  return { base, db: holder.getDb(), dbPath: file };
}

async function login(base: string, username: string, password: string) {
  const res = await fetch(`${base}/api/auth/login`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }),
  });
  const setCookie = res.headers.get('set-cookie') ?? '';
  const token = /newfc_session=([a-f0-9]{64})/.exec(setCookie)?.[1];
  const body = await res.json() as { csrfToken?: string; code?: string; user?: { permissions: string[] } };
  return { res, body, setCookie, session: token ? { cookie: `${SESSION_COOKIE}=${token}`, csrf: body.csrfToken! } : null };
}

describe('AC-F01 登录、会话、登出与 CSRF', () => {
  it('未初始化管理员时登录给出明确的初始化指引', async () => {
    const { base } = await boot();
    const r = await login(base, 'admin', 'whatever-password');
    expect(r.res.status).toBe(401);
    expect(r.body.code).toBe('NOT_INITIALIZED');
    const s = await fetch(`${base}/api/auth/session`);
    expect(s.status).toBe(401);
    expect(await s.json()).toMatchObject({ code: 'UNAUTHORIZED', details: { initialized: false } });
  });

  it('登录签发 HttpOnly+SameSite=Strict Cookie;会话查询返回 CSRF 令牌与权限;登出后失效', async () => {
    const { base, db } = await boot();
    ensureAdmin(db);
    const r = await login(base, TEST_ADMIN.username, TEST_ADMIN.password);
    expect(r.res.status).toBe(200);
    expect(r.setCookie).toMatch(/HttpOnly/);
    expect(r.setCookie).toMatch(/SameSite=Strict/);
    expect(r.body.user!.permissions).toContain('security:manage');
    // 响应体不含会话令牌本身
    expect(JSON.stringify(r.body)).not.toMatch(/[a-f0-9]{64}/);
    const session = await fetchAs(r.session!, `${base}/api/auth/session`);
    expect(session.status).toBe(200);
    expect(await session.json()).toMatchObject({ authenticated: true, user: { username: TEST_ADMIN.username, allOrgs: true } });

    const out = await fetchAs(r.session!, `${base}/api/auth/logout`, { method: 'POST' });
    expect(out.status).toBe(200);
    expect((await fetchAs(r.session!, `${base}/api/org/tree`)).status).toBe(401);
  });

  it('会话持久化:服务重启后原会话仍有效', async () => {
    const first = await boot();
    ensureAdmin(first.db);
    const r = await login(first.base, TEST_ADMIN.username, TEST_ADMIN.password);
    await cleanups.pop()!();
    const second = await boot(first.dbPath);
    expect((await fetchAs(r.session!, `${second.base}/api/org/tree`)).status).toBe(200);
  });

  it('错误口令 401 且审计不含口令;连续失败锁定', async () => {
    const { base, db } = await boot();
    ensureAdmin(db);
    const bad = await login(base, TEST_ADMIN.username, 'wrong-password-xx');
    expect(bad.res.status).toBe(401);
    expect(bad.body.code).toBe('AUTH_FAILED');
    const row = db.prepare("SELECT * FROM operation_log WHERE action = 'auth.login_failed' ORDER BY id DESC LIMIT 1").get() as { detail_json: string; result: string };
    expect(row.result).toBe('failure');
    expect(row.detail_json).not.toContain('wrong-password-xx');
    let last = bad;
    for (let i = 0; i < 8; i++) last = await login(base, TEST_ADMIN.username, 'wrong-password-xx');
    expect(last.res.status).toBe(429);
    // 锁定期内正确口令同样被拒
    expect((await login(base, TEST_ADMIN.username, TEST_ADMIN.password)).res.status).toBe(429);
  });

  it('写请求缺少或伪造 CSRF 令牌被拒绝;跨站 Origin 被拒绝;GET 不需要 CSRF', async () => {
    const { base, db } = await boot();
    ensureAdmin(db);
    const r = await login(base, TEST_ADMIN.username, TEST_ADMIN.password);
    const body = JSON.stringify({ parentId: null, code: 'X1', name: '测试组织' });
    const noCsrf = await fetch(`${base}/api/org`, { method: 'POST', headers: { cookie: r.session!.cookie, 'content-type': 'application/json' }, body });
    expect(noCsrf.status).toBe(403);
    expect(await noCsrf.json()).toMatchObject({ code: 'CSRF_REJECTED' });
    const forged = await fetchAs({ ...r.session!, csrf: 'f'.repeat(48) }, `${base}/api/org`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    expect(forged.status).toBe(403);
    const crossSite = await fetchAs(r.session!, `${base}/api/org`, { method: 'POST', headers: { 'content-type': 'application/json', origin: 'https://evil.example' }, body });
    expect(crossSite.status).toBe(403);
    expect((await fetchAs(r.session!, `${base}/api/org/tree`)).status).toBe(200);
    const ok = await fetchAs(r.session!, `${base}/api/org`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
    expect(ok.status).toBe(201);
    // 未通过的写请求没有产生组织
    expect((db.prepare("SELECT COUNT(*) AS c FROM org WHERE code = 'X1'").get() as { c: number }).c).toBe(1);
  });

  it('停用用户:已有会话立即失效,无法再登录', async () => {
    const { base, db } = await boot();
    const adminId = ensureAdmin(db);
    const admin = await login(base, TEST_ADMIN.username, TEST_ADMIN.password);
    const viewer = createScopedUser(db, { username: 'viewer1', roleCodes: ['viewer'], allOrgs: true });
    expect((await fetchAs(viewer.session, `${base}/api/org/tree`)).status).toBe(200);
    const patch = await fetchAs(admin.session!, `${base}/api/security/users/${viewer.userId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ status: 'disabled' }),
    });
    expect(patch.status).toBe(200);
    expect((await fetchAs(viewer.session, `${base}/api/org/tree`)).status).toBe(401);
    expect((await login(base, 'viewer1', 'Vt9-scoped-user-staple')).res.status).toBe(401);
    expect(adminId).toBeGreaterThan(0);
  });

  it('管理员重置口令后,用户必须先修改口令才能访问业务接口', async () => {
    const { base, db } = await boot();
    ensureAdmin(db);
    const admin = await login(base, TEST_ADMIN.username, TEST_ADMIN.password);
    const viewer = createScopedUser(db, { username: 'viewer2', roleCodes: ['viewer'], allOrgs: true });
    await fetchAs(admin.session!, `${base}/api/security/users/${viewer.userId}`, {
      method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ password: 'Reset-pass-7788' }),
    });
    const r = await login(base, 'viewer2', 'Reset-pass-7788');
    expect(r.res.status).toBe(200);
    const blocked = await fetchAs(r.session!, `${base}/api/org/tree`);
    expect(blocked.status).toBe(403);
    expect(await blocked.json()).toMatchObject({ code: 'PASSWORD_CHANGE_REQUIRED' });
    const change = await fetchAs(r.session!, `${base}/api/me/password`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ currentPassword: 'Reset-pass-7788', newPassword: 'My-own-secret-42' }),
    });
    expect(change.status).toBe(200);
    expect((await fetchAs(r.session!, `${base}/api/org/tree`)).status).toBe(200);
  });
});

describe('AC-F24 / AC-X04 用户、角色与组织授权', () => {
  it('无操作权限 403;未登记路由默认拒绝;受限用户访问全组织接口得到 SCOPE_RESTRICTED', async () => {
    const { base, db } = await boot();
    ensureAdmin(db);
    const fx = buildFixture(db);
    const viewer = createScopedUser(db, { username: 'viewer3', roleCodes: ['viewer'], orgIds: [fx.orgIds.east] });
    const create = await fetchAs(viewer.session, `${base}/api/org`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ parentId: null, code: 'Y', name: 'Y' }) });
    expect(create.status).toBe(403);
    expect(await create.json()).toMatchObject({ code: 'FORBIDDEN' });
    const unknown = await fetchAs(viewer.session, `${base}/api/not-registered-anywhere`);
    expect(unknown.status).toBe(403);
    expect(await unknown.json()).toMatchObject({ code: 'ROUTE_NOT_AUTHORIZED' });
    const group = await fetchAs(viewer.session, `${base}/api/dashboard`);
    expect(group.status).toBe(403);
    expect(await group.json()).toMatchObject({ code: 'SCOPE_RESTRICTED' });
    const security = await fetchAs(viewer.session, `${base}/api/security/users`);
    expect(security.status).toBe(403);
  });

  it('组织参数越权:受限用户查询授权范围外组织返回 404(不泄露存在),范围内(含下级)放行到接口自身', async () => {
    const { base, db } = await boot();
    ensureAdmin(db);
    const fx = buildFixture(db);
    const analyst = createScopedUser(db, { username: 'analyst1', roleCodes: ['finance_analyst'], orgIds: [fx.orgIds.east] });
    const outside = await fetchAs(analyst.session, `${base}/api/me?orgId=${fx.orgIds.nanjing}`);
    expect(outside.status).toBe(404);
    expect(await outside.json()).toMatchObject({ code: 'NOT_FOUND' });
    const missing = await fetchAs(analyst.session, `${base}/api/me?orgId=999999`);
    expect(missing.status).toBe(404);
    const inside = await fetchAs(analyst.session, `${base}/api/me?orgId=${fx.orgIds.shanghai}`);
    expect(inside.status).not.toBe(403);
    expect(inside.status).not.toBe(404);
  });

  it('角色管理:内置管理员角色不可修改;不能移除最后一个授权管理员;授权变更下一请求即生效', async () => {
    const { base, db } = await boot();
    const adminId = ensureAdmin(db);
    const admin = await login(base, TEST_ADMIN.username, TEST_ADMIN.password);
    const roles = await (await fetchAs(admin.session!, `${base}/api/security/roles`)).json() as { items: { id: number; code: string }[] };
    const adminRole = roles.items.find((r) => r.code === 'admin')!;
    const viewerRole = roles.items.find((r) => r.code === 'viewer')!;
    const lockedEdit = await fetchAs(admin.session!, `${base}/api/security/roles/${adminRole.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ permissions: [] }) });
    expect(lockedEdit.status).toBe(409);
    const demote = await fetchAs(admin.session!, `${base}/api/security/users/${adminId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ roleIds: [viewerRole.id] }) });
    expect(demote.status).toBe(409);
    expect(await demote.json()).toMatchObject({ code: 'LAST_ADMIN' });

    const created = await fetchAs(admin.session!, `${base}/api/security/users`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'maint1', password: 'Maint-pass-2026', roleIds: [viewerRole.id], allOrgs: true, mustChangePassword: false }),
    });
    expect(created.status).toBe(201);
    const maint = await created.json() as { id: number; roles: unknown[] };
    // 口令哈希不回显
    expect(JSON.stringify(maint)).not.toMatch(/scrypt|Maint-pass/);
    const m = await login(base, 'maint1', 'Maint-pass-2026');
    expect((await fetchAs(m.session!, `${base}/api/org`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ parentId: null, code: 'Z', name: 'Z' }) })).status).toBe(403);
    const maintRole = roles.items.find((r) => r.code === 'data_maintainer')!;
    await fetchAs(admin.session!, `${base}/api/security/users/${maint.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ roleIds: [maintRole.id] }) });
    expect((await fetchAs(m.session!, `${base}/api/org`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ parentId: null, code: 'Z', name: 'Z' }) })).status).toBe(201);
  });
});

describe('AC-F25 审计日志', () => {
  it('记录操作人、结果、来源与请求 ID;请求 ID 与响应头一致;凭据被脱敏', async () => {
    const { base, db } = await boot();
    const adminId = ensureAdmin(db);
    const admin = await login(base, TEST_ADMIN.username, TEST_ADMIN.password);
    const res = await fetchAs(admin.session!, `${base}/api/org`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ parentId: null, code: 'AUD', name: '审计组织' }) });
    const requestId = res.headers.get('x-request-id');
    expect(requestId).toMatch(/^[a-f0-9]{16}$/);
    const row = db.prepare("SELECT * FROM operation_log WHERE action = 'org.create' ORDER BY id DESC LIMIT 1").get() as Record<string, unknown>;
    expect(row).toMatchObject({ actor_user_id: adminId, actor: TEST_ADMIN.username, result: 'success', source: 'http', request_id: requestId });

    const createUserRes = await fetchAs(admin.session!, `${base}/api/security/users`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ username: 'aud2', password: 'Audit-pass-3030', allOrgs: true }),
    });
    expect(createUserRes.status).toBe(201);
    const all = db.prepare('SELECT detail_json FROM operation_log').all() as { detail_json: string }[];
    for (const r of all) expect(r.detail_json).not.toContain('Audit-pass-3030');

    const logs = await fetchAs(admin.session!, `${base}/api/logs?action=security.`);
    expect(logs.status).toBe(200);
    const body = await logs.json() as { items: { action: string; actor: string }[] };
    expect(body.items.some((i) => i.action === 'security.user.create' && i.actor === TEST_ADMIN.username)).toBe(true);
  });

  it('错误响应携带 requestId 便于定位,且不暴露内部异常', async () => {
    const { base, db } = await boot();
    ensureAdmin(db);
    const admin = await login(base, TEST_ADMIN.username, TEST_ADMIN.password);
    const res = await fetchAs(admin.session!, `${base}/api/versions/abc`);
    const body = await res.json() as { requestId?: string; message: string };
    expect(body.requestId).toBe(res.headers.get('x-request-id'));
    expect(body.message).not.toMatch(/SQLITE|at .*\.ts/);
  });
});
