import { describe, expect, it } from 'vitest';
import { boot, get, json, post, upload } from './t3-helpers';
import { createScopedUser, fetchAs } from './http-helpers';
import { count, createProject, createSupplier } from './t4-helpers';

/**
 * AC-F04 合同导入:预览不写合同;确认 = 预览;重复确认只产生一份;预览后库内合同变化 → PREVIEW_STALE;
 * “50”比例与 1970 年签订日期被拒;中途失败全部回滚、预览可重试;只能由预览人确认。
 */

const HEADER = '合同编号,合同名称,项目编码,供应商,合同金额,已付款金额,签订日期,合同类型,责任组织,付款上限比例';
const csv = (...rows: string[]) => Buffer.from(`﻿${[HEADER, ...rows].join('\n')}\n`);

async function setup() {
  const t = await boot('newfc-t4-ci-');
  await createProject(t.base, t.admin, 'P-SH-01', '上海泵站改造', t.fx.orgIds.shanghai);
  await createSupplier(t.base, t.admin, 'S-001', '华东水利建设有限公司');
  const importer = createScopedUser(t.db, { username: 'ci-maker', roleCodes: ['data_maintainer'], allOrgs: true }).session;
  return { ...t, importer };
}

const confirm = (base: string, s: Parameters<typeof post>[1], id: number, planHash: string) => post(base, s, `/api/contracts/imports/${id}/confirm`, { planHash });

describe('T-4 合同导入(AC-F04)', () => {
  it('预览与确认一致;重复确认只产生一份;已付记为导入基线;更新只改允许字段', async () => {
    const { base, db, importer } = await setup();
    const file = csv(
      'HT-001,泵站改造施工合同,P-SH-01,华东水利建设有限公司,"100,000.00",30000,2026-03-01,工程,,80%',
      'ht 002,管网巡检服务合同,,华东水利建设有限公司,5000,,,服务,上海公司,',
    );
    const preview = await json(upload(base, importer, '/api/contracts/imports', file, 'contracts.csv'));
    expect(preview).toMatchObject({ status: 'previewed', rowCount: 2, errorCount: 0, counts: { create: 2, update: 0, unchanged: 0 } });
    expect(preview.rows[0]).toMatchObject({ contractNo: 'HT-001', action: 'create', orgName: '上海公司', supplierName: '华东水利建设有限公司', amount: '100000.00', paid: '30000.00' });
    expect(count(db, 'ct_contract')).toBe(0);

    const done = await json(confirm(base, importer, preview.id, preview.planHash));
    expect(done).toMatchObject({ status: 'confirmed', result: { created: 2, updated: 0, unchanged: 0 } });
    const again = await json(confirm(base, importer, preview.id, preview.planHash));
    expect(again).toMatchObject({ replayed: true, result: done.result });
    expect(count(db, 'ct_contract')).toBe(2);

    const [id1] = done.result.contractIds;
    const c1 = await json(get(base, importer, `/api/contracts/${id1}`));
    expect(c1).toMatchObject({ source: 'import', stage: 'performance', currentAmount: '100000.00', paidAmount: '30000.00', paymentCapRatio: '0.800000', signDate: '2026-03-01' });
    expect(c1.payments).toEqual([expect.objectContaining({ kind: 'import_baseline', status: 'paid', amount: '30000.00' })]);
    expect(c1.events.map((e: { eventType: string }) => e.eventType)).toEqual(['import.create']);
    // 付款上限 80%:可付上限 80,000,已付 30,000 → 申请 50,000.01 被拒
    const over = await post(base, importer, `/api/contracts/${id1}/payments`, { nodeName: '进度款', amount: '50000.01' });
    expect((await json(over)).code).toBe('CONTRACT_PAYMENT_EXCEEDS');
    // 已有付款的合同不能作废
    expect((await json(post(base, importer, `/api/contracts/${id1}/void`, { expectedVersion: c1.version, reason: 'x' }))).code).toBe('CONTRACT_STATE');

    // 第二次导入:名称与签订日期更新、已付基线更新;第二行不变
    const file2 = csv(
      'HT-001,泵站改造施工合同(补充),P-SH-01,华东水利建设有限公司,100000,40000,2026-03-02,工程,上海公司,80%',
      'HT002,管网巡检服务合同,,华东水利建设有限公司,5000,,,服务,上海公司,',
    );
    const p2 = await json(upload(base, importer, '/api/contracts/imports', file2, 'contracts2.csv'));
    expect(p2.counts).toEqual({ create: 0, update: 1, unchanged: 1 });
    expect(p2.rows[0].changes).toEqual({ name: ['泵站改造施工合同', '泵站改造施工合同(补充)'], signDate: ['2026-03-01', '2026-03-02'], paid: ['30000.00', '40000.00'] });
    await json(confirm(base, importer, p2.id, p2.planHash));
    const u1 = await json(get(base, importer, `/api/contracts/${id1}`));
    expect(u1).toMatchObject({ name: '泵站改造施工合同(补充)', paidAmount: '40000.00' });
    expect(u1.payments).toHaveLength(1);

    // 金额不一致:行错误(须走变更),不能确认
    const p3 = await json(upload(base, importer, '/api/contracts/imports', csv('HT-001,泵站改造施工合同(补充),P-SH-01,,120000,,,,,'), 'c3.csv'));
    expect(p3.errors[0].message).toMatch(/须走变更流程/);
    const r3 = await confirm(base, importer, p3.id, p3.planHash);
    expect(r3.status).toBe(422);
  });

  it('“50”比例与 1970 年签订日期、重复编号、未知供应商被拒且不写库;预览后合同变化返回 PREVIEW_STALE;只能由预览人确认', async () => {
    const { base, db, fx, importer } = await setup();
    const bad = await json(upload(base, importer, '/api/contracts/imports', csv(
      'HT-A,甲,,华东水利建设有限公司,100,,1970-01-01,服务,上海公司,50',
      'HT-A,乙,,不存在的供应商,100,200,,服务,上海公司,',
      'HT-B,丙,,,abc,,,服务,不存在的组织,',
    ), 'bad.csv'));
    const msgs = bad.errors.map((e: { row: number; message: string }) => `${e.row}:${e.message}`);
    expect(msgs).toEqual(expect.arrayContaining([
      expect.stringMatching(/^2:付款上限比例「50」须带 %/),
      expect.stringMatching(/^2:签订日期 1970-01-01 不在 1990-01-01 至/),
      '3:合同编号与第 2 行重复',
      '3:已付款金额不能超过合同金额',
      '3:供应商“不存在的供应商”未在主数据中找到',
      expect.stringMatching(/^4:合同金额「abc」不是合法金额/),
      '4:责任组织“不存在的组织”未匹配到组织',
    ]));
    expect((await confirm(base, importer, bad.id, bad.planHash)).status).toBe(422);
    expect(count(db, 'ct_contract')).toBe(0);

    const created = await json(post(base, importer, '/api/contracts', { contractNo: 'HT-S', name: '原名', orgId: fx.orgIds.shanghai }));
    const preview = await json(upload(base, importer, '/api/contracts/imports', csv('HT-S,新名,,,1.00,,,服务,上海公司,'), 's.csv'));
    // 金额 0 的手工合同与导入金额不一致 → 先把手工合同金额调成一致
    expect(preview.errors[0].message).toMatch(/须走变更流程/);
    const patched = await fetchAs(importer, `${base}/api/contracts/${created.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedVersion: created.version, originalAmount: '1.00' }) });
    const v2 = await json(patched);
    const fresh = await json(upload(base, importer, '/api/contracts/imports', csv('HT-S,新名,,,1.00,,,服务,上海公司,'), 's.csv'));
    expect(fresh.counts.update).toBe(1);
    // 其他人不能确认或查看
    const other = createScopedUser(db, { username: 'ci-other', roleCodes: ['data_maintainer'], allOrgs: true }).session;
    expect((await json(confirm(base, other, fresh.id, fresh.planHash))).code).toBe('PREVIEW_OWNER_MISMATCH');
    expect((await get(base, other, `/api/contracts/imports/${fresh.id}`)).status).toBe(404);
    // 预览后合同被修改 → PREVIEW_STALE,不写入
    await fetchAs(importer, `${base}/api/contracts/${created.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedVersion: v2.version, contractType: '工程' }) });
    const stale = await confirm(base, importer, fresh.id, fresh.planHash);
    expect(stale.status).toBe(409);
    expect((await json(stale)).code).toBe('PREVIEW_STALE');
    expect((await json(get(base, importer, `/api/contracts/${created.id}`))).name).toBe('原名');
    // 哈希与预览不一致同样拒绝
    expect((await json(confirm(base, importer, fresh.id, '0'.repeat(64)))).code).toBe('PREVIEW_STALE');
  });

  it('中途失败全部回滚,预览保持可重试;受限用户只能导入范围内组织', async () => {
    const { base, db, fx, importer } = await setup();
    const preview = await json(upload(base, importer, '/api/contracts/imports', csv(
      'HT-OK1,甲,,,100,,,服务,上海公司,',
      'HT-FAIL,乙,,,200,,,服务,上海公司,',
      'HT-OK2,丙,,,300,,,服务,上海公司,',
    ), 'r.csv'));
    db.exec("CREATE TRIGGER t_fail BEFORE INSERT ON ct_contract WHEN NEW.normalized_no = 'HT-FAIL' BEGIN SELECT RAISE(ABORT, 'injected failure'); END;");
    const failed = await confirm(base, importer, preview.id, preview.planHash);
    expect(failed.status).toBeGreaterThanOrEqual(500);
    expect(count(db, 'ct_contract')).toBe(0);
    expect(count(db, 'ct_event')).toBe(0);
    expect((db.prepare('SELECT status FROM ct_import WHERE id = ?').get(preview.id) as { status: string }).status).toBe('previewed');
    db.exec('DROP TRIGGER t_fail');
    const retried = await json(confirm(base, importer, preview.id, preview.planHash));
    expect(retried.result.created).toBe(3);

    const sh = createScopedUser(db, { username: 'ci-sh', roleCodes: ['data_maintainer'], orgIds: [fx.orgIds.shanghai] }).session;
    const outside = await json(upload(base, sh, '/api/contracts/imports', csv('HT-NJ,南京,,,100,,,服务,南京公司,'), 'nj.csv'));
    expect(outside.errors[0].message).toBe('责任组织“南京公司”未匹配到组织');
    const viewer = createScopedUser(db, { username: 'ci-viewer', roleCodes: ['viewer'], allOrgs: true }).session;
    expect((await upload(base, viewer, '/api/contracts/imports', csv('HT-V,v,,,1,,,服务,上海公司,'), 'v.csv')).status).toBe(403);
  });

  it('复核分离:同一非管理员提交与复核被拒;管理员同人复核须写例外原因', async () => {
    const { base, db, admin, fx } = await setup();
    const both = createScopedUser(db, { username: 'ci-both', roleCodes: ['data_maintainer', 'business_reviewer'], allOrgs: true }).session;
    const imp = await json(upload(base, admin, '/api/contracts/imports', csv('HT-R,复核样本,,,1000,,2026-01-05,服务,上海公司,'), 'r.csv'));
    const [cid] = (await json(confirm(base, admin, imp.id, imp.planHash))).result.contractIds;
    let c = await json(post(base, both, `/api/contracts/${cid}/payments`, { nodeName: '首付', amount: '100.00' }));
    const pid = c.payments[0].id;
    expect((await json(post(base, both, `/api/contracts/${cid}/payments/${pid}/decide`, { decision: 'approve' }))).code).toBe('SELF_REVIEW_FORBIDDEN');
    c = await json(post(base, admin, `/api/contracts/${cid}/payments`, { nodeName: '二期', amount: '100.00' }));
    const own = c.payments[1].id;
    expect((await post(base, admin, `/api/contracts/${cid}/payments/${own}/decide`, { decision: 'approve' })).status).toBe(400);
    c = await json(post(base, admin, `/api/contracts/${cid}/payments/${own}/decide`, { decision: 'approve', exceptionReason: '单人值守' }));
    expect(c.payments[1]).toMatchObject({ status: 'approved', selfReview: true, exceptionReason: '单人值守' });
    expect(fx.orgIds.shanghai).toBeGreaterThan(0);
  });
});
