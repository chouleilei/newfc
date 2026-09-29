/**
 * T-3 数据治理(AC-F06):扫描 → 处置 → 复核 → 生效证明;去重、重开、事实变化检测、组织范围。
 *
 * 样本:lishui v600 三件套(澧水公司 2026-05)。主数据预置项目 LS-2026-001 与供应商“湖南水利建设集团有限公司”,
 * 其余两个项目编码(LS-2026-002/004)和两个供应商在当前凭证中无法解析 → 4 个 eas_master 问题。
 */
import { describe, it, expect } from 'vitest';
import type { DB } from '../src/db/connection';
import { org } from './helpers';
import { createScopedUser } from './http-helpers';
import { boot, easSample, EAS_V600, get, json, post, upload, type Session } from './t3-helpers';

async function setupLs(base: string, db: DB, admin: Session) {
  const ls = org.createOrg(db, { parentId: null, code: 'LS', name: '澧水公司' }).id;
  expect((await post(base, admin, '/api/master/projects', { code: 'LS-2026-001', name: '江垭灌区续建配套与节水改造项目', orgId: ls })).status).toBe(201);
  expect((await post(base, admin, '/api/master/suppliers', { name: '湖南水利建设集团有限公司' })).status).toBe(201);
  return ls;
}

async function importV600(base: string, s: Session, overrides: Partial<Record<string, Buffer>> = {}) {
  for (const [type, file] of EAS_V600) {
    const res = await upload(base, s, '/api/eas/import', overrides[type] ?? easSample(file), file, { dataType: type });
    expect(res.status, await res.clone().text()).toBeLessThan(300);
  }
}

async function activate(base: string, s: Session, orgId: number, period = '2026-05') {
  const set = await json(post(base, s, '/api/eas/precheck', { orgId, period }));
  const status = await json(get(base, s, `/api/eas/period-status?orgId=${orgId}&period=${period}`));
  const res = await post(base, s, `/api/eas/sets/${set.id}/activate`, { expectedVersion: set.version, expectedCurrentSetId: status.currentSet?.id ?? null });
  expect(res.status, await res.clone().text()).toBe(200);
  return set;
}

/** 在建工程余额本期借方改为 3,100,000(与凭证 3,000,000 不一致) */
const badBalance = () => Buffer.from(easSample('eas_balance.csv').toString('utf8')
  .replace('160401,在建工程,0,0,3000000,0,3000000,0', '160401,在建工程,0,0,3100000,0,3100000,0'), 'utf8');

describe('T-3 数据治理', () => {
  it('扫描生成主数据类问题并去重;映射覆盖经复核生效,生效证明可核对,重扫不再出现', async () => {
    const { base, db, admin } = await boot();
    const ls = await setupLs(base, db, admin);
    await importV600(base, admin);
    await activate(base, admin, ls);

    const first = await json(post(base, admin, '/api/governance/scan', {}));
    expect(first).toMatchObject({ created: 4, updated: 0, reopened: 0 });
    const again = await json(post(base, admin, '/api/governance/scan', { orgId: ls }));
    expect(again).toMatchObject({ created: 0, unchanged: 4 });
    const issues = await json(get(base, admin, `/api/governance/issues?orgId=${ls}`));
    expect(issues.map((i: any) => i.detail.value).sort()).toEqual(['LS-2026-002', 'LS-2026-004', '常德澧源机电设备有限公司', '长沙云图信息科技有限公司']);
    const target = issues.find((i: any) => i.detail.value === 'LS-2026-004');
    expect(target).toMatchObject({ sourceType: 'eas_master', problemType: 'unmapped_project', status: 'open', severity: 'warning' });

    const maint = createScopedUser(db, { username: 'gov-maint', roleCodes: ['data_maintainer'], allOrgs: true });
    const reviewer = createScopedUser(db, { username: 'gov-rev', roleCodes: ['business_reviewer'], allOrgs: true });
    const project = await json(post(base, admin, '/api/master/projects', { code: 'DT-01', name: '澧水流域数字孪生调度平台', orgId: ls }));
    const submitted = await post(base, maint.session, `/api/governance/issues/${target.id}/dispositions`,
      { kind: 'mapping_override', expectedVersion: target.version, reason: 'EAS 使用旧项目编码', targetId: project.id });
    expect(submitted.status, await submitted.clone().text()).toBe(201);
    const pending = await submitted.json() as any;
    expect(pending.status).toBe('pending_review');
    const dispositionId = pending.dispositions[0].id;

    // 提交人没有复核权限;复核人批准
    expect((await post(base, maint.session, `/api/governance/dispositions/${dispositionId}/review`, { action: 'approve' })).status).toBe(403);
    const approved = await post(base, reviewer.session, `/api/governance/dispositions/${dispositionId}/review`, { action: 'approve', comment: '已核对' });
    expect(approved.status, await approved.clone().text()).toBe(200);
    const resolved = await approved.json() as any;
    expect(resolved.status).toBe('resolved');
    expect(resolved.dispositions[0].proof).toMatchObject({ verified: true, beforeHash: target.sourceHash });
    expect(resolved.dispositions[0].proof.detail).toMatchObject({ matchedBy: 'mapping_code', targetId: project.id });
    const mapping = db.prepare("SELECT source_system, entity_type, match_kind, source_key, target_id FROM md_code_mapping WHERE valid_to IS NULL").get();
    expect(mapping).toEqual({ source_system: 'eas', entity_type: 'project', match_kind: 'code', source_key: 'LS-2026-004', target_id: project.id });

    // 同一处置只能复核一次;原始事实未被改写
    const twice = await post(base, reviewer.session, `/api/governance/dispositions/${dispositionId}/review`, { action: 'approve' });
    expect((await twice.json() as any).code).toBe('GOVERNANCE_ALREADY_REVIEWED');
    expect((db.prepare("SELECT COUNT(*) AS c FROM eas_voucher_line WHERE project_code = 'LS-2026-004'").get() as { c: number }).c).toBe(2);

    const rescan = await json(post(base, admin, '/api/governance/scan', {}));
    expect(rescan).toMatchObject({ created: 0, reopened: 0, unchanged: 3 });
    const audit = db.prepare("SELECT action FROM operation_log WHERE action LIKE 'governance.%' OR action LIKE 'master.mapping.%' ORDER BY id").all() as { action: string }[];
    expect(audit.map((a) => a.action)).toEqual(['governance.scan', 'governance.scan', 'governance.disposition_submit', 'master.mapping.create', 'governance.review', 'governance.scan']);
  });

  it('误报处置:管理员同人复核须写例外原因;误报在来源不变时重扫保持关闭', async () => {
    const { base, db, admin } = await boot();
    const ls = await setupLs(base, db, admin);
    await importV600(base, admin);
    await activate(base, admin, ls);
    await post(base, admin, '/api/governance/scan', {});
    const issue = (await json(get(base, admin, '/api/governance/issues'))).find((i: any) => i.detail.value === '长沙云图信息科技有限公司');
    const sub = await json(post(base, admin, `/api/governance/issues/${issue.id}/dispositions`, { kind: 'false_positive', expectedVersion: issue.version, reason: '个人供应商,无需建档' }));
    const did = sub.dispositions[0].id;
    const noReason = await post(base, admin, `/api/governance/dispositions/${did}/review`, { action: 'approve' });
    expect(noReason.status).toBe(400);
    const ok = await json(post(base, admin, `/api/governance/dispositions/${did}/review`, { action: 'approve', exceptionReason: '单人部署' }));
    expect(ok.status).toBe('dismissed');
    expect(ok.dispositions[0].proof).toMatchObject({ verified: true, beforeHash: issue.sourceHash, afterHash: issue.sourceHash });
    const rescan = await json(post(base, admin, '/api/governance/scan', {}));
    expect(rescan.reopened).toBe(0);
    expect((await json(get(base, admin, `/api/governance/issues/${issue.id}`))).status).toBe('dismissed');
  });

  it('EAS 预检失败生成问题;关联新激活集合的重新导入处置经复核解决;再次失败时重新打开', async () => {
    const { base, db, admin } = await boot();
    const ls = await setupLs(base, db, admin);
    await importV600(base, admin, { balance: badBalance() });
    const failed = await json(post(base, admin, '/api/eas/precheck', { orgId: ls, period: '2026-05' }));
    expect(failed.status).toBe('failed');
    await post(base, admin, '/api/governance/scan', { orgId: ls, period: '2026-05' });
    const issue = (await json(get(base, admin, '/api/governance/issues?sourceType=eas_recon')))[0];
    expect(issue).toMatchObject({ problemType: 'voucher_balance_movement', severity: 'error', status: 'open' });
    expect(issue.detail.setId).toBe(failed.id);

    // 未激活的新集合不能作为重新导入依据
    const early = await post(base, admin, `/api/governance/issues/${issue.id}/dispositions`, { kind: 'reimport', expectedVersion: issue.version, reason: '重导余额', setId: failed.id });
    expect((await early.json() as any).code).toBe('GOVERNANCE_REIMPORT_INVALID');

    await upload(base, admin, '/api/eas/import', easSample('eas_balance.csv'), 'eas_balance.csv', { dataType: 'balance' });
    const good = await activate(base, admin, ls);
    const maint = createScopedUser(db, { username: 'gov-maint', roleCodes: ['data_maintainer'], orgIds: [ls] });
    const reviewer = createScopedUser(db, { username: 'gov-rev', roleCodes: ['business_reviewer'], orgIds: [ls] });
    const sub = await post(base, maint.session, `/api/governance/issues/${issue.id}/dispositions`, { kind: 'reimport', expectedVersion: issue.version, reason: '重导余额', setId: good.id });
    expect(sub.status, await sub.clone().text()).toBe(201);
    const did = (await sub.json() as any).dispositions[0].id;
    const done = await json(post(base, reviewer.session, `/api/governance/dispositions/${did}/review`, { action: 'approve' }));
    expect(done.status).toBe('resolved');
    expect(done.dispositions[0].proof.detail).toMatchObject({ setId: good.id, ruleStatus: 'passed' });

    // 再导入不一致的余额并预检:最新预检又失败 → 问题重新打开
    await upload(base, admin, '/api/eas/import', Buffer.concat([badBalance(), Buffer.from('\n')]), 'eas_balance_v3.csv', { dataType: 'balance' });
    await post(base, admin, '/api/eas/precheck', { orgId: ls, period: '2026-05' });
    const rescan = await json(post(base, admin, '/api/governance/scan', { orgId: ls }));
    expect(rescan.reopened).toBe(1);
    expect(await json(get(base, admin, `/api/governance/issues/${issue.id}`))).toMatchObject({ status: 'open', reopenCount: 1 });
  });

  it('来源事实被改动时重验与复核返回 GOVERNANCE_FACT_MUTATED', async () => {
    const { base, db, admin } = await boot();
    const ls = await setupLs(base, db, admin);
    await importV600(base, admin);
    await activate(base, admin, ls);
    await post(base, admin, '/api/governance/scan', {});
    const issue = (await json(get(base, admin, '/api/governance/issues'))).find((i: any) => i.detail.value === 'LS-2026-002');
    expect((await get(base, admin, `/api/governance/issues/${issue.id}/verify`)).status).toBe(200);
    const reviewer = createScopedUser(db, { username: 'gov-rev', roleCodes: ['business_reviewer'], allOrgs: true });
    const sub = await json(post(base, admin, `/api/governance/issues/${issue.id}/dispositions`, { kind: 'false_positive', expectedVersion: issue.version, reason: '误报' }));

    // 模拟绕过应用层的篡改(去掉不可变触发器后直接改库)
    db.exec('DROP TRIGGER trg_eas_voucher_immutable_u');
    db.prepare("UPDATE eas_voucher_line SET debit_cents = debit_cents + 1 WHERE project_code = 'LS-2026-002' AND debit_cents > 0").run();
    const verify = await get(base, admin, `/api/governance/issues/${issue.id}/verify`);
    expect(verify.status).toBe(409);
    expect((await verify.json() as any).code).toBe('GOVERNANCE_FACT_MUTATED');
    const review = await post(base, reviewer.session, `/api/governance/dispositions/${sub.dispositions[0].id}/review`, { action: 'approve' });
    expect((await review.json() as any).code).toBe('GOVERNANCE_FACT_MUTATED');
    expect((await json(get(base, admin, `/api/governance/issues/${issue.id}`))).status).toBe('pending_review');
  });

  it('组织范围:范围外问题不可见;受限用户扫描只覆盖授权组织;映射覆盖需要全组织权限', async () => {
    const { base, db, admin, fx } = await boot();
    const ls = await setupLs(base, db, admin);
    await importV600(base, admin);
    await activate(base, admin, ls);
    await post(base, admin, '/api/governance/scan', {});
    const issue = (await json(get(base, admin, '/api/governance/issues')))[0];

    const hz = createScopedUser(db, { username: 'gov-hz', roleCodes: ['data_maintainer'], orgIds: [fx.orgIds.hangzhou] });
    expect(await json(get(base, hz.session, '/api/governance/issues'))).toEqual([]);
    expect((await get(base, hz.session, `/api/governance/issues/${issue.id}`)).status).toBe(404);
    expect((await post(base, hz.session, '/api/governance/scan', { orgId: ls })).status).toBe(404);
    expect(await json(post(base, hz.session, '/api/governance/scan', {}))).toMatchObject({ created: 0, unchanged: 0 });

    const lsMaint = createScopedUser(db, { username: 'gov-ls', roleCodes: ['data_maintainer'], orgIds: [ls] });
    const mapped = await post(base, lsMaint.session, `/api/governance/issues/${issue.id}/dispositions`, { kind: 'mapping_override', expectedVersion: issue.version, reason: 'x', targetId: 1 });
    expect(mapped.status).toBe(403);
    expect((await mapped.json() as any).code).toBe('SCOPE_RESTRICTED');
    const viewer = createScopedUser(db, { username: 'gov-viewer', roleCodes: ['viewer'], allOrgs: true });
    expect((await post(base, viewer.session, '/api/governance/scan', {})).status).toBe(403);
  });
});
