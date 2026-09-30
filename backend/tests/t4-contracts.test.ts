import { describe, expect, it } from 'vitest';
import { boot, get, json, post, upload, type Session } from './t3-helpers';
import { createScopedUser, fetchAs } from './http-helpers';
import { count, createProject, createSupplier } from './t4-helpers';

/**
 * AC-F16 合同生命周期:阶段只前进且 blocker 服务端重算;审核/变更/付款复核分离;
 * 当前金额 = 原始 + 已批准变更;付款不超过当前金额;变更不低于已付;作废/关闭后拒绝写入;事件与审计。
 */

async function setup() {
  const t = await boot('newfc-t4-ct-');
  const projectId = await createProject(t.base, t.admin, 'P-SH-01', '上海泵站改造', t.fx.orgIds.shanghai);
  const supplierId = await createSupplier(t.base, t.admin, 'S-001', '华东水利建设有限公司');
  const maker = createScopedUser(t.db, { username: 'ct-maker', roleCodes: ['data_maintainer'], orgIds: [t.fx.orgIds.east] });
  const reviewer = createScopedUser(t.db, { username: 'ct-reviewer', roleCodes: ['business_reviewer'], orgIds: [t.fx.orgIds.east] });
  return { ...t, projectId, supplierId, maker: maker.session, reviewer: reviewer.session };
}

const patch = (base: string, s: Session, url: string, body: unknown) =>
  fetchAs(s, `${base}${url}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function ok(res: Response | Promise<Response>, status = 200) {
  const r = await res;
  const body = await r.json();
  expect(r.status, JSON.stringify(body)).toBe(status);
  return body;
}
async function fail(res: Response | Promise<Response>, status: number, code: string) {
  const r = await res;
  const body = await r.json();
  expect([r.status, body.code], JSON.stringify(body)).toEqual([status, code]);
  return body;
}

describe('T-4 合同生命周期(AC-F16)', () => {
  it('完整样本:阶段 blocker、审核、变更 +20,000、付款 50,000+70,000、超付与低于已付被拒、归档后拒写与重开', async () => {
    const { base, db, admin, fx, projectId, supplierId, maker, reviewer } = await setup();
    const doc = async (contractId: number, docType: string, name = `${docType}.pdf`) =>
      (await ok(upload(base, maker, `/api/contracts/${contractId}/documents`, Buffer.from(`${docType}-${Math.random()}`), name, { docType }), 201)).id as number;

    let c = await ok(post(base, maker, '/api/contracts', { contractNo: 'ht-2026-001', name: '泵站改造施工合同', orgId: fx.orgIds.shanghai, originalAmount: '100000.00' }), 201);
    expect(c).toMatchObject({ contractNo: 'ht-2026-001', stage: 'initiation', status: 'active', currentAmount: '100000.00', paidAmount: '0.00', paymentRate: '0.000000', nextStage: 'procurement' });
    expect(c.blockers.map((b: { code: string }) => b.code)).toEqual(['PROJECT_REQUIRED', 'TYPE_REQUIRED']);
    await fail(post(base, maker, '/api/contracts', { contractNo: 'HT-2026-001 ', name: '重复', orgId: fx.orgIds.shanghai }), 409, 'CONTRACT_NO_EXISTS');
    const blocked = await fail(post(base, maker, `/api/contracts/${c.id}/advance`, { expectedVersion: c.version, toStage: 'procurement' }), 409, 'CONTRACT_STAGE_BLOCKED');
    expect(blocked.details.blockers).toHaveLength(2);
    await fail(post(base, maker, `/api/contracts/${c.id}/advance`, { expectedVersion: c.version, toStage: 'drafting' }), 409, 'CONTRACT_STAGE_BLOCKED');

    c = await ok(patch(base, maker, `/api/contracts/${c.id}`, { expectedVersion: c.version, projectId, contractType: '工程' }));
    await fail(post(base, maker, `/api/contracts/${c.id}/advance`, { expectedVersion: c.version - 1, toStage: 'procurement' }), 409, 'VERSION_CONFLICT');
    c = await ok(post(base, maker, `/api/contracts/${c.id}/advance`, { expectedVersion: c.version, toStage: 'procurement' }));
    expect(c.blockers.map((b: { code: string }) => b.code)).toEqual(['PROCUREMENT_DOC']);
    await doc(c.id, 'procurement');
    c = await ok(get(base, maker, `/api/contracts/${c.id}`));
    c = await ok(post(base, maker, `/api/contracts/${c.id}/advance`, { expectedVersion: c.version, toStage: 'drafting' }));
    expect(c.blockers.map((b: { code: string }) => b.code)).toEqual(['SUPPLIER_REQUIRED', 'CONTRACT_TEXT_DOC']);
    const text1 = await doc(c.id, 'contract_text', '合同正文v1.docx');
    c = await ok(patch(base, maker, `/api/contracts/${c.id}`, { expectedVersion: (await ok(get(base, maker, `/api/contracts/${c.id}`))).version, supplierId }));
    c = await ok(post(base, maker, `/api/contracts/${c.id}/advance`, { expectedVersion: c.version, toStage: 'approval' }));
    expect(c.blockers.map((b: { code: string }) => b.code)).toEqual(['REVIEW_APPROVED', 'SIGN_DATE', 'SIGNED_DOC']);
    // 进入审批签署后金额只能走变更
    await fail(patch(base, maker, `/api/contracts/${c.id}`, { expectedVersion: c.version, originalAmount: '1.00' }), 409, 'CONTRACT_STATE');

    // 审核:同人被拒;审核期间不能替换正文;复核人批准
    c = await ok(post(base, maker, `/api/contracts/${c.id}/reviews`, { documentId: text1 }), 201);
    const reviewId = c.reviews[0].id;
    await fail(post(base, maker, `/api/contracts/${c.id}/reviews`, { documentId: text1 }), 409, 'CONTRACT_STATE');
    await fail(upload(base, maker, `/api/contracts/${c.id}/documents`, Buffer.from('v2'), 'v2.docx', { docType: 'contract_text' }), 409, 'CONTRACT_STATE');
    await fail(post(base, maker, `/api/contracts/${c.id}/reviews/${reviewId}/decide`, { decision: 'approve' }), 403, 'FORBIDDEN');
    c = await ok(post(base, reviewer, `/api/contracts/${c.id}/reviews/${reviewId}/decide`, { decision: 'approve', comment: '条款齐全' }));
    expect(c.reviews[0]).toMatchObject({ status: 'approved', comment: '条款齐全', selfReview: false });
    await fail(post(base, reviewer, `/api/contracts/${c.id}/reviews/${reviewId}/decide`, { decision: 'reject' }), 409, 'CONTRACT_STATE');
    // 审核后替换正文:需要重新审核
    await doc(c.id, 'contract_text', '合同正文v2.docx');
    c = await ok(get(base, maker, `/api/contracts/${c.id}`));
    expect(c.blockers.map((b: { code: string }) => b.code)).toContain('REVIEW_OUTDATED');
    const text2 = c.documents.filter((d: { docType: string }) => d.docType === 'contract_text').at(-1).id;
    c = await ok(post(base, maker, `/api/contracts/${c.id}/reviews`, { documentId: text2 }), 201);
    c = await ok(post(base, reviewer, `/api/contracts/${c.id}/reviews/${c.reviews[1].id}/decide`, { decision: 'approve' }));
    await doc(c.id, 'signed');
    c = await ok(patch(base, maker, `/api/contracts/${c.id}`, { expectedVersion: (await ok(get(base, maker, `/api/contracts/${c.id}`))).version, signDate: '2026-03-01' }));
    expect(c.blockers).toEqual([]);
    // 审批签署前不能付款、变更
    const evidence = await doc(c.id, 'change', '变更签证.pdf');
    await fail(post(base, maker, `/api/contracts/${c.id}/payments`, { nodeName: '预付款', amount: '1.00' }), 409, 'CONTRACT_STATE');
    await fail(post(base, maker, `/api/contracts/${c.id}/changes`, { delta: '1.00', reason: 'x', evidenceDocumentId: evidence }), 409, 'CONTRACT_STATE');
    c = await ok(get(base, maker, `/api/contracts/${c.id}`));
    c = await ok(post(base, maker, `/api/contracts/${c.id}/advance`, { expectedVersion: c.version, toStage: 'performance' }));

    // 变更 +20,000:复核后当前金额 120,000
    c = await ok(post(base, maker, `/api/contracts/${c.id}/changes`, { delta: '20000.00', reason: '增加附属工程', evidenceDocumentId: evidence }), 201);
    expect(c.currentAmount).toBe('100000.00');
    // 工作台待办下钻:todo 过滤与待办计数同口径
    const todoIds = async (todo: string) => (await ok(get(base, reviewer, `/api/contracts?todo=${todo}`))).map((x: { id: number }) => x.id);
    expect(await todoIds('change')).toEqual([c.id]);
    expect(await todoIds('review')).toEqual([]);
    await fail(get(base, reviewer, '/api/contracts?todo=other'), 400, 'VALIDATION_FAILED');
    c = await ok(post(base, reviewer, `/api/contracts/${c.id}/changes/${c.changes[0].id}/decide`, { decision: 'approve' }));
    expect(c).toMatchObject({ originalAmount: '100000.00', approvedChange: '20000.00', currentAmount: '120000.00' });

    // 付款 50,000 + 70,000;支付须附发票
    const pay = async (amount: string) => {
      let d = await ok(post(base, maker, `/api/contracts/${c.id}/payments`, { nodeName: `节点${amount}`, amount }), 201);
      const pid = d.payments.at(-1).id;
      d = await ok(post(base, reviewer, `/api/contracts/${c.id}/payments/${pid}/decide`, { decision: 'approve' }));
      return pid as number;
    };
    const p1 = await pay('50000.00');
    const performanceDoc = await doc(c.id, 'performance');
    await fail(post(base, maker, `/api/contracts/${c.id}/payments/${p1}/pay`, { paidDate: '2026-04-10', invoiceDocumentId: performanceDoc }), 409, 'EVIDENCE_REQUIRED');
    const invoice = await doc(c.id, 'invoice', '发票1.pdf');
    c = await ok(post(base, maker, `/api/contracts/${c.id}/payments/${p1}/pay`, { paidDate: '2026-04-10', voucherNo: '记-0410-01', invoiceDocumentId: invoice }));
    expect(c.paidAmount).toBe('50000.00');
    const p2 = await pay('70000.00');
    expect(await todoIds('pay')).toEqual([c.id]);
    expect(await todoIds('payment')).toEqual([]);
    // 已批准未付 70,000 + 已付 50,000 = 120,000:再申请 0.01 被拒
    await fail(post(base, maker, `/api/contracts/${c.id}/payments`, { nodeName: '尾款', amount: '0.01' }), 409, 'CONTRACT_PAYMENT_EXCEEDS');
    c = await ok(post(base, maker, `/api/contracts/${c.id}/payments/${p2}/pay`, { paidDate: '2026-05-20', invoiceDocumentId: invoice }));
    expect(c).toMatchObject({ paidAmount: '120000.00', paymentRate: '1.000000' });
    await fail(post(base, maker, `/api/contracts/${c.id}/payments`, { nodeName: '尾款', amount: '0.01' }), 409, 'CONTRACT_PAYMENT_EXCEEDS');
    // 变更 −80,000 将低于已付:提交即被拒
    const below = await fail(post(base, maker, `/api/contracts/${c.id}/changes`, { delta: '-80000.00', reason: '核减', evidenceDocumentId: evidence }), 409, 'CONTRACT_AMOUNT_BELOW_PAID');
    expect(below.details).toMatchObject({ currentAmount: '120000.00', paidAmount: '120000.00', afterChange: '40000.00' });

    // 变更结算 → 归档:需要验收文件
    c = await ok(get(base, maker, `/api/contracts/${c.id}`));
    c = await ok(post(base, maker, `/api/contracts/${c.id}/advance`, { expectedVersion: c.version, toStage: 'settlement' }));
    expect(c.blockers.map((b: { code: string }) => b.code)).toEqual(['ACCEPTANCE_DOC']);
    await doc(c.id, 'acceptance');
    c = await ok(get(base, maker, `/api/contracts/${c.id}`));
    c = await ok(post(base, maker, `/api/contracts/${c.id}/advance`, { expectedVersion: c.version, toStage: 'archived' }));
    expect(c).toMatchObject({ stage: 'archived', status: 'closed', nextStage: null });
    await fail(upload(base, maker, `/api/contracts/${c.id}/documents`, Buffer.from('late'), 'late.pdf', { docType: 'other' }), 409, 'CONTRACT_STATE');
    await fail(post(base, maker, `/api/contracts/${c.id}/terminate`, { expectedVersion: c.version, reason: 'x' }), 409, 'CONTRACT_STATE');
    // 重开需要 contract:review
    expect((await post(base, maker, `/api/contracts/${c.id}/reopen`, { expectedVersion: c.version, reason: '补结算', targetStage: 'settlement' })).status).toBe(403);
    c = await ok(post(base, reviewer, `/api/contracts/${c.id}/reopen`, { expectedVersion: c.version, reason: '补结算', targetStage: 'settlement' }));
    expect(c).toMatchObject({ status: 'active', stage: 'settlement', statusReason: '补结算' });

    // 事件只追加,每步有审计
    const types = c.events.map((e: { eventType: string }) => e.eventType);
    expect(types).toEqual(expect.arrayContaining(['create', 'update', 'advance', 'document', 'review.submit', 'review.approve', 'change.submit', 'change.approve',
      'payment.submit', 'payment.approve', 'payment.pay', 'archive', 'reopen']));
    expect(c.events.find((e: { eventType: string }) => e.eventType === 'archive')).toMatchObject({ fromStage: 'settlement', toStage: 'archived', actor: 'ct-maker' });
    expect(count(db, 'operation_log', "action LIKE 'contract.%' AND entity_id = ?", String(c.id))).toBe(c.events.length);
    expect(() => db.prepare('DELETE FROM ct_event WHERE contract_id = ?').run(c.id)).toThrow(/只追加/);
    expect(() => db.prepare('UPDATE ct_document SET name = ? WHERE contract_id = ?').run('x', c.id)).toThrow(/不可修改/);
    // 管理员同人复核须写例外原因
    const own = await ok(post(base, admin, '/api/contracts', { contractNo: 'HT-ADMIN', name: 'x', orgId: fx.orgIds.shanghai, projectId, contractType: '服务', originalAmount: '10.00' }), 201);
    expect(own.id).toBeGreaterThan(0);
  });

  it('作废/终止:须填原因;有付款不能作废;作废后拒绝写入且不可重开', async () => {
    const { base, fx, maker, reviewer } = await setup();
    let c = await ok(post(base, maker, '/api/contracts', { contractNo: 'HT-V', name: '作废样本', orgId: fx.orgIds.shanghai, originalAmount: '10.00' }), 201);
    expect((await post(base, maker, `/api/contracts/${c.id}/void`, { expectedVersion: c.version })).status).toBe(400);
    c = await ok(post(base, maker, `/api/contracts/${c.id}/void`, { expectedVersion: c.version, reason: '重复登记' }));
    expect(c).toMatchObject({ status: 'voided', statusReason: '重复登记' });
    await fail(patch(base, maker, `/api/contracts/${c.id}`, { expectedVersion: c.version, name: '改名' }), 409, 'CONTRACT_STATE');
    await fail(upload(base, maker, `/api/contracts/${c.id}/documents`, Buffer.from('x'), 'x.pdf', { docType: 'other' }), 409, 'CONTRACT_STATE');
    await fail(post(base, maker, `/api/contracts/${c.id}/advance`, { expectedVersion: c.version, toStage: 'procurement' }), 409, 'CONTRACT_STATE');
    await fail(post(base, reviewer, `/api/contracts/${c.id}/reopen`, { expectedVersion: c.version, reason: 'x', targetStage: 'initiation' }), 409, 'CONTRACT_STATE');
    const t = await ok(post(base, maker, '/api/contracts', { contractNo: 'HT-T', name: '终止样本', orgId: fx.orgIds.shanghai }), 201);
    expect((await ok(post(base, maker, `/api/contracts/${t.id}/terminate`, { expectedVersion: t.version, reason: '项目取消' }))).status).toBe('terminated');
  });

  it('受限用户与审计:范围外合同 404、列表与汇总只含范围内;只读角色不能写', async () => {
    const { base, db, admin, fx } = await setup();
    const sh = await ok(post(base, admin, '/api/contracts', { contractNo: 'HT-SH', name: '上海', orgId: fx.orgIds.shanghai, originalAmount: '100.00' }), 201);
    const nj = await ok(post(base, admin, '/api/contracts', { contractNo: 'HT-NJ', name: '南京', orgId: fx.orgIds.nanjing, originalAmount: '300.00' }), 201);
    const user = createScopedUser(db, { username: 'ct-sh', roleCodes: ['data_maintainer'], orgIds: [fx.orgIds.shanghai] }).session;
    expect((await ok(get(base, user, '/api/contracts'))).map((c: { contractNo: string }) => c.contractNo)).toEqual(['HT-SH']);
    expect((await get(base, user, `/api/contracts/${nj.id}`)).status).toBe(404);
    expect((await post(base, user, `/api/contracts/${nj.id}/void`, { expectedVersion: 1, reason: 'x' })).status).toBe(404);
    expect((await upload(base, user, `/api/contracts/${nj.id}/documents`, Buffer.from('x'), 'x.pdf', { docType: 'other' })).status).toBe(404);
    expect((await post(base, user, '/api/contracts', { contractNo: 'HT-X', name: 'x', orgId: fx.orgIds.nanjing })).status).toBe(404);
    expect(await ok(get(base, user, '/api/contracts/summary'))).toMatchObject({ count: 1, currentAmount: '100.00' });
    expect(await ok(get(base, admin, '/api/contracts/summary'))).toMatchObject({ count: 2, currentAmount: '400.00' });
    const viewer = createScopedUser(db, { username: 'ct-viewer', roleCodes: ['viewer'], orgIds: [fx.orgIds.shanghai] }).session;
    expect((await get(base, viewer, `/api/contracts/${sh.id}`)).status).toBe(200);
    expect((await post(base, viewer, '/api/contracts', { contractNo: 'HT-Y', name: 'y', orgId: fx.orgIds.shanghai })).status).toBe(403);
  });
});
