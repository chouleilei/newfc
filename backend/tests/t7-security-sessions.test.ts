import { describe, expect, it } from 'vitest';
import { boot, get, json, post } from './t3-helpers';
import { createScopedUser, sessionFor } from './http-helpers';

/** T-7 安全管理补齐 lishui(AC-F24):管理员查看/吊销用户会话(只暴露句柄)、复制角色。 */

describe('T-7 会话管理与角色复制', () => {
  it('会话列表、吊销、当前会话保护;角色复制', async () => {
    const { base, db, admin } = await boot('newfc-t7-sec-');
    const u = createScopedUser(db, { username: 'sess-user', roleCodes: ['viewer'], allOrgs: true });
    const second = sessionFor(db, u.userId);
    expect((await get(base, u.session, '/api/me')).status).toBe(200);

    // 非管理员不能访问
    expect((await get(base, u.session, `/api/security/users/${u.userId}/sessions`)).status).toBe(403);

    const list = await json(get(base, admin, `/api/security/users/${u.userId}/sessions`));
    expect(list.items).toHaveLength(2);
    for (const s of list.items) {
      expect(s).toMatchObject({ status: 'active', ip: '127.0.0.1', userAgent: 'vitest', current: false, revokedAt: null });
      expect(s.sid).toMatch(/^[a-f0-9]{16}$/);
      expect(Object.keys(s)).not.toContain('csrfToken');
    }

    // 吊销其中一个:该会话立即失效,另一个不受影响
    const secondSid = (db.prepare('SELECT substr(id, 1, 16) AS sid FROM app_session WHERE user_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1').get(u.userId) as { sid: string }).sid;
    const r = await post(base, admin, `/api/security/users/${u.userId}/sessions/${secondSid}/revoke`);
    expect(r.status).toBe(200);
    expect((await get(base, second, '/api/me')).status).toBe(401);
    expect((await get(base, u.session, '/api/me')).status).toBe(200);
    const after = await json(get(base, admin, `/api/security/users/${u.userId}/sessions`));
    expect(after.items.find((s: { sid: string }) => s.sid === secondSid)).toMatchObject({ status: 'revoked' });
    expect((await post(base, admin, `/api/security/users/${u.userId}/sessions/${secondSid}/revoke`)).status).toBe(200); // 幂等
    expect((await post(base, admin, `/api/security/users/${u.userId}/sessions/zz/revoke`)).status).toBe(400);
    expect((await post(base, admin, `/api/security/users/${u.userId}/sessions/0000000000000000/revoke`)).status).toBe(404);

    // 管理员自己的当前会话:标记 current,不能在此吊销
    const adminId = (db.prepare("SELECT id FROM app_user WHERE username = 'test-admin'").get() as { id: number }).id;
    const mine = await json(get(base, admin, `/api/security/users/${adminId}/sessions`));
    const cur = mine.items.find((s: { current: boolean }) => s.current);
    expect(cur).toBeTruthy();
    const self = await post(base, admin, `/api/security/users/${adminId}/sessions/${cur.sid}/revoke`);
    expect([self.status, (await self.json()).code]).toEqual([409, 'SESSION_CURRENT']);

    // 角色复制:权限原样带出,新角色不锁定、无用户;编码冲突 409
    const roles = await json(get(base, admin, '/api/security/roles'));
    const reviewer = roles.items.find((x: { code: string }) => x.code === 'business_reviewer');
    const copy = await json(post(base, admin, `/api/security/roles/${reviewer.id}/copy`, { code: 'reviewer_east' }));
    expect(copy).toMatchObject({ code: 'reviewer_east', name: '业务复核(副本)', locked: false, userCount: 0, permissions: reviewer.permissions });
    expect(copy.description).toContain('复制自 business_reviewer');
    const dup = await post(base, admin, `/api/security/roles/${reviewer.id}/copy`, { code: 'reviewer_east' });
    expect([dup.status, (await dup.json()).code]).toEqual([409, 'ROLE_CODE_TAKEN']);
    const adminRole = roles.items.find((x: { locked: boolean }) => x.locked);
    const fromLocked = await json(post(base, admin, `/api/security/roles/${adminRole.id}/copy`, { code: 'admin_copy', name: '管理员模板' }));
    expect(fromLocked).toMatchObject({ locked: false, name: '管理员模板', permissions: adminRole.permissions });
    expect((await post(base, admin, '/api/security/roles/99999/copy', { code: 'x_copy' })).status).toBe(404);
    const logs = db.prepare("SELECT action FROM operation_log WHERE action IN ('security.role.copy', 'security.session.revoke')").all() as { action: string }[];
    expect(logs.map((l) => l.action).sort()).toEqual(['security.role.copy', 'security.role.copy', 'security.session.revoke']);
  });
});
