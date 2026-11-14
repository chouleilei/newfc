import { describe, expect, it } from 'vitest';
import { boot, get, json, post } from './t3-helpers';
import { createScopedUser, fetchAs, sessionFor } from './http-helpers';

describe('T-GAP-02 组织树与多级用户数据范围两阶段批量导入', () => {
  it('POST /api/org/import 支持两阶段拓扑建树、环状父节点拦截与非全域账号 403 守卫', async () => {
    const { base, admin, db, fx } = await boot('newfc-t13-org-batch-');

    const scopedMaint = createScopedUser(db, {
      username: 'scoped-maint',
      roleCodes: ['data_maintainer'],
      orgIds: [fx.orgIds.east],
    });
    const denied = await post(base, scopedMaint.session, '/api/org/import', {
      mode: 'preview',
      rows: [{ code: 'X1', name: '越权组织' }],
    });
    expect(denied.status).toBe(403);

    const cycleRows = [
      { code: 'CYC_A', parentCode: 'CYC_B', name: '环节点A', orgKind: 'legal_entity' },
      { code: 'CYC_B', parentCode: 'CYC_A', name: '环节点B', orgKind: 'legal_entity' },
    ];
    const pvCycle = await json(post(base, admin, '/api/org/import', { mode: 'preview', rows: cycleRows }));
    expect(pvCycle.errors.length).toBeGreaterThan(0);
    expect(pvCycle.errors.some((e: { message: string }) => e.message.includes('循环'))).toBe(true);
    expect((await post(base, admin, '/api/org/import', { mode: 'confirm', rows: cycleRows })).status).toBe(400);

    const validRows = [
      { code: 'SUB_CHILD', parentCode: 'SUB_PARENT', name: '下属三级公司', orgKind: 'legal_entity', planIssuanceRootCode: 'SUB_PARENT', contractPrefixCode: 'SUBP' },
      { code: 'SUB_PARENT', parentCode: null, name: '一级能源板块公司', orgKind: 'legal_entity', planIssuanceRootCode: 'SUB_PARENT', contractPrefixCode: 'SUBP' },
      { code: 'OLD_CLOSED', parentCode: 'SUB_PARENT', name: '已注销历史电站', orgKind: 'closed_history', status: 'inactive', isPlanExcluded: true },
    ];
    const pvOk = await json(post(base, admin, '/api/org/import', { mode: 'preview', rows: validRows }));
    expect(pvOk).toMatchObject({ mode: 'preview', errors: [], created: 3, updated: 0 });

    const cfOk = await json(post(base, admin, '/api/org/import', { mode: 'confirm', rows: validRows }));
    expect(cfOk).toMatchObject({ mode: 'confirm', errors: [], created: 3, updated: 0 });

    const cfIdem = await json(post(base, admin, '/api/org/import', { mode: 'confirm', rows: validRows }));
    expect(cfIdem).toMatchObject({ mode: 'confirm', errors: [], created: 0, updated: 3 });
  });

  it('POST /api/security/users/batch-import 拦截停用历史组织授权，首次登录强制改密且 OrgScope 即刻生效', async () => {
    const { base, admin, db, fx } = await boot('newfc-t13-user-batch-');

    await json(
      post(base, admin, '/api/org/import', {
        mode: 'confirm',
        rows: [
          { code: 'UNIT_ACTIVE', parentCode: null, name: '在运二级法人', orgKind: 'legal_entity' },
          { code: 'UNIT_SUB', parentCode: 'UNIT_ACTIVE', name: '下属项目部', orgKind: 'direct_unit' },
          { code: 'UNIT_HIST', parentCode: 'UNIT_ACTIVE', name: '历史注销主体', orgKind: 'closed_history', status: 'inactive' },
        ],
      })
    );

    const scopedSec = createScopedUser(db, {
      username: 'scoped-sec-admin',
      roleCodes: ['admin'],
      orgIds: [fx.orgIds.east],
    });
    expect((await post(base, scopedSec.session, '/api/security/users/batch-import', { mode: 'preview', items: [] })).status).toBe(403);

    const badItems = [
      {
        username: 'hist_operator',
        displayName: '误授权经办人',
        roleCodes: 'data_maintainer',
        allOrgs: false,
        orgCodes: 'UNIT_HIST',
        initialPassword: 'Init-User-2026!',
      },
    ];
    const badPv = await json(post(base, admin, '/api/security/users/batch-import', { mode: 'preview', items: badItems }));
    expect(badPv.errors.some((e: { message: string }) => e.message.includes('停用历史组织不可授予写权限范围'))).toBe(true);
    expect((await post(base, admin, '/api/security/users/batch-import', { mode: 'confirm', items: badItems })).status).toBe(400);

    const goodItems = [
      {
        username: 'unit_maker_01',
        displayName: '二级法人经办',
        roleCodes: ['data_maintainer'],
        allOrgs: false,
        orgCodes: 'UNIT_ACTIVE',
        initialPassword: 'Maker-Init-2026!',
      },
      {
        username: 'unit_reviewer_01',
        displayName: '二级法人复核',
        roleCodes: 'business_reviewer',
        allOrgs: false,
        orgCodes: 'UNIT_ACTIVE',
        initialPassword: 'Review-Init-2026!',
      },
    ];
    const pv = await json(post(base, admin, '/api/security/users/batch-import', { mode: 'preview', items: goodItems }));
    expect(pv).toMatchObject({ mode: 'preview', created: 2, updated: 0, errors: [] });

    const cf = await json(post(base, admin, '/api/security/users/batch-import', { mode: 'confirm', items: goodItems }));
    expect(cf).toMatchObject({ mode: 'confirm', created: 2, updated: 0, errors: [] });

    const logs = db.prepare("SELECT detail_json FROM operation_log WHERE action = 'security.user.batch_import'").all() as { detail_json: string }[];
    expect(logs.length).toBe(1);
    expect(logs[0].detail_json).not.toContain('Maker-Init-2026!');

    const makerRow = db.prepare("SELECT id FROM app_user WHERE username = 'unit_maker_01'").get() as { id: number };
    const makerSession = sessionFor(db, makerRow.id);
    const beforeChange = await get(base, makerSession, '/api/org/tree');
    expect(beforeChange.status).toBe(403);
    expect((await json(beforeChange)).code).toBe('PASSWORD_CHANGE_REQUIRED');

    const pwRes = await fetchAs(makerSession, `${base}/api/me/password`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ currentPassword: 'Maker-Init-2026!', newPassword: 'Maker-New-2026#' }),
    });
    expect(pwRes.status).toBe(200);

    const visibleTree = await json(get(base, makerSession, '/api/org/tree'));
    const codes = (visibleTree.rows as { code: string }[]).map((r) => r.code).sort();
    expect(codes).toEqual(['UNIT_ACTIVE', 'UNIT_HIST', 'UNIT_SUB']);
  });
});
