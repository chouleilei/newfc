import { SIGNATORIES, PAYMENT_APPROVAL, CHANGE_GOVERNANCE, seedCurrentLegalRun, seedNetAssets } from './contract-review-fixtures';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/connection';
import { applyMigrations } from '../src/db/migrations';
import { computeChangeApprovalTier } from '../src/modules/contracts/contract-change.service';
import { boot, get, post, upload, type Session } from './t3-helpers';
import { createScopedUser, fetchAs } from './http-helpers';
import { createProject, createSupplier } from './t4-helpers';

const patch = (base: string, s: Session, url: string, body: unknown) =>
  fetchAs(s, `${base}${url}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const put = (base: string, s: Session, url: string, body: unknown) =>
  fetchAs(s, `${base}${url}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
async function ok(res: Response | Promise<Response>, status = 200) {
  const r = await res;
  const b = (await r.json()) as any;
  expect(r.status, JSON.stringify(b)).toBe(status);
  return b;
}
async function fail(res: Response | Promise<Response>, status: number, code?: string) {
  const r = await res;
  const b = (await r.json()) as any;
  expect(r.status, JSON.stringify(b)).toBe(status);
  if (code) expect(b.code, JSON.stringify(b)).toBe(code);
  return b;
}

describe('T-11.1 V69 变更索赔、担保质保与纠纷迁移', () => {
  it('V68 存量 ct_change 无损升级至 V69：支持 0 金额变更、法人内唯一补充协议号及外键完整', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'newfc-t11-v69-'));
    const dbPath = path.join(dir, 'v68-to-v69.sqlite');
    const db = openDatabase(dbPath);
    const now = '2026-11-13T00:00:00.000Z';
    try {
      applyMigrations(db, 68);
      const orgId = Number(db.prepare("INSERT INTO org (code, name, sort_order, created_at, updated_at) VALUES ('1001', '湘水测试单位', 1, ?, ?)").run(now, now).lastInsertRowid);
      const org2Id = Number(db.prepare("INSERT INTO org (code, name, sort_order, created_at, updated_at) VALUES ('1002', '另一法人单位', 2, ?, ?)").run(now, now).lastInsertRowid);
      const fileObjId = Number(db.prepare("INSERT INTO file_object (sha256, size_bytes, content_type, original_name, created_at) VALUES (?, 10, 'application/pdf', 'chg.pdf', ?)").run('a'.repeat(64), now).lastInsertRowid);
      const c1 = Number(db.prepare("INSERT INTO ct_contract (contract_no, normalized_no, name, org_id, original_cents, created_at, updated_at) VALUES ('HT-V69-1', 'HT-V69-1', '测试合同1', ?, 1000000, ?, ?)").run(orgId, now, now).lastInsertRowid);
      const c2 = Number(db.prepare("INSERT INTO ct_contract (contract_no, normalized_no, name, org_id, original_cents, created_at, updated_at) VALUES ('HT-V69-2', 'HT-V69-2', '测试合同2', ?, 1000000, ?, ?)").run(orgId, now, now).lastInsertRowid);
      const c3 = Number(db.prepare("INSERT INTO ct_contract (contract_no, normalized_no, name, org_id, original_cents, created_at, updated_at) VALUES ('HT-V69-3', 'HT-V69-3', '测试合同3', ?, 1000000, ?, ?)").run(org2Id, now, now).lastInsertRowid);
      const doc1 = Number(db.prepare("INSERT INTO ct_document (contract_id, doc_type, file_object_id, name, uploaded_at) VALUES (?, 'change', ?, '签证.pdf', ?)").run(c1, fileObjId, now).lastInsertRowid);
      const doc2 = Number(db.prepare("INSERT INTO ct_document (contract_id, doc_type, file_object_id, name, uploaded_at) VALUES (?, 'change', ?, '签证2.pdf', ?)").run(c2, fileObjId, now).lastInsertRowid);
      const doc3 = Number(db.prepare("INSERT INTO ct_document (contract_id, doc_type, file_object_id, name, uploaded_at) VALUES (?, 'change', ?, '签证3.pdf', ?)").run(c3, fileObjId, now).lastInsertRowid);
      const oldChgId = Number(db.prepare("INSERT INTO ct_change (contract_id, delta_cents, reason, evidence_document_id, status, submitted_at, reviewed_at) VALUES (?, 50000, '旧变更', ?, 'approved', ?, ?)").run(c1, doc1, now, now).lastInsertRowid);

      expect(applyMigrations(db, 69).map((m) => m.version)).toEqual([69]);
      expect(applyMigrations(db, 69)).toEqual([]);
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
      for (const tbl of ['ct_change', 'ct_document', 'ct_guarantee', 'ct_warranty', 'ct_dispute']) {
        const fks = db.prepare(`SELECT "table" AS t FROM pragma_foreign_key_list('${tbl}')`).all() as { t: string }[];
        expect(fks.every((fk) => !fk.t.endsWith('_v69')), `${tbl}: ${JSON.stringify(fks)}`).toBe(true);
      }

      const migrated = db.prepare('SELECT org_root_id, change_kind, delta_cents, status FROM ct_change WHERE id = ?').get(oldChgId) as Record<string, unknown>;
      expect(migrated).toEqual({ org_root_id: orgId, change_kind: 'change', delta_cents: 50000, status: 'approved' });

      // 支持 0 金额变更与已批变更补录备案字段
      db.prepare("UPDATE ct_change SET supplement_no = 'SUPP-001', normalized_supplement_no = 'SUPP-001', discipline_filed_at = '2026-11-13' WHERE id = ?").run(oldChgId);
      expect(() => db.prepare("UPDATE ct_change SET status = 'rejected' WHERE id = ?").run(oldChgId)).toThrow(/只能复核一次/);

      const zeroChg = Number(db.prepare("INSERT INTO ct_change (contract_id, org_root_id, change_kind, delta_cents, change_matter, reason, evidence_document_id, supplement_no, normalized_supplement_no, submitted_at) VALUES (?, ?, 'change', 0, '变更收款账户', '银行开户行调整', ?, 'SUPP-002', 'SUPP-002', ?)").run(c2, orgId, doc2, now).lastInsertRowid);
      expect(zeroChg).toBeGreaterThan(0);

      // 同一法人单位补充协议号唯一，不同法人单位允许相同编号
      expect(() => db.prepare("INSERT INTO ct_change (contract_id, org_root_id, change_kind, delta_cents, reason, evidence_document_id, supplement_no, normalized_supplement_no, submitted_at) VALUES (?, ?, 'change', 0, '重复编号', ?, 'SUPP-001', 'SUPP-001', ?)").run(c2, orgId, doc2, now)).toThrow(/UNIQUE/);
      const otherOrgChg = Number(db.prepare("INSERT INTO ct_change (contract_id, org_root_id, change_kind, delta_cents, reason, evidence_document_id, supplement_no, normalized_supplement_no, submitted_at) VALUES (?, ?, 'change', 0, '其他单位同名编号', ?, 'SUPP-001', 'SUPP-001', ?)").run(c3, org2Id, doc3, now).lastInsertRowid);
      expect(otherOrgChg).toBeGreaterThan(0);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('T-11.2 附件 5 变更分级引擎与中止/解除四位一体', () => {
  it('computeChangeApprovalTier 纯函数：四档定级、500万/10%门槛、0/负变更、孰低/孰高口径全覆盖', () => {
    // 原合同 2000 万元（2,000,000,000 分），2%=40万 vs 20万(孰低20万)
    const orig = 2_000_000_000n;
    expect(computeChangeApprovalTier({ originalCents: orig, priorApprovedPositiveCents: 0n, deltaCents: 20_000_000n, changeKind: 'change', procurementTier: 'tier_1', involvesBizOrEntityChange: false, involvesTechChange: false, orMode: 'min' }).tier).toBe('undertaker_unit');
    expect(computeChangeApprovalTier({ originalCents: orig, priorApprovedPositiveCents: 0n, deltaCents: 20_000_001n, changeKind: 'change', procurementTier: 'tier_1', involvesBizOrEntityChange: false, involvesTechChange: false, orMode: 'min' }).tier).toBe('dual_vp');
    expect(computeChangeApprovalTier({ originalCents: orig, priorApprovedPositiveCents: 0n, deltaCents: 35_000_000n, changeKind: 'change', procurementTier: 'tier_1', involvesBizOrEntityChange: false, involvesTechChange: false, orMode: 'max' }).tier).toBe('undertaker_unit');
    expect(computeChangeApprovalTier({ originalCents: orig, priorApprovedPositiveCents: 0n, deltaCents: 50_000_001n, changeKind: 'change', procurementTier: 'tier_1', involvesBizOrEntityChange: false, involvesTechChange: false, orMode: 'min' }).tier).toBe('general_manager');
    expect(computeChangeApprovalTier({ originalCents: orig, priorApprovedPositiveCents: 0n, deltaCents: 100_000_001n, changeKind: 'change', procurementTier: 'tier_1', involvesBizOrEntityChange: false, involvesTechChange: false, orMode: 'min' }).tier).toBe('management_board');
    // 累计已批 >= 10% 或 >= 500 万后，任意正增加直达 management_board
    expect(computeChangeApprovalTier({ originalCents: orig, priorApprovedPositiveCents: 200_000_000n, deltaCents: 100_00n, changeKind: 'claim_by_contractor', procurementTier: 'tier_1', involvesBizOrEntityChange: false, involvesTechChange: false, orMode: 'min' }).tier).toBe('management_board');
    expect(computeChangeApprovalTier({ originalCents: 10_000_000_000n, priorApprovedPositiveCents: 500_000_000n, deltaCents: 100_00n, changeKind: 'change', procurementTier: 'tier_1', involvesBizOrEntityChange: false, involvesTechChange: false, orMode: 'min' }).tier).toBe('management_board');
    // >10% 触发技术归口专项复核
    expect(computeChangeApprovalTier({ originalCents: 100_000_000n, priorApprovedPositiveCents: 0n, deltaCents: 10_000_001n, changeKind: 'change', procurementTier: 'tier_2', involvesBizOrEntityChange: false, involvesTechChange: false, orMode: 'min' }).requireTechSpecialAudit).toBe(true);
    // 0 / 负变更分级
    expect(computeChangeApprovalTier({ originalCents: orig, priorApprovedPositiveCents: 0n, deltaCents: 0n, changeKind: 'change', procurementTier: 'tier_1', involvesBizOrEntityChange: true, involvesTechChange: false, orMode: 'min' }).tier).toBe('undertaker_vp');
    expect(computeChangeApprovalTier({ originalCents: orig, priorApprovedPositiveCents: 0n, deltaCents: -100_000n, changeKind: 'change', procurementTier: 'tier_3', involvesBizOrEntityChange: false, involvesTechChange: true, orMode: 'min' }).tier).toBe('dual_vp');
    expect(computeChangeApprovalTier({ originalCents: orig, priorApprovedPositiveCents: 0n, deltaCents: 0n, changeKind: 'terminate', procurementTier: 'tier_1', involvesBizOrEntityChange: false, involvesTechChange: false, orMode: 'min' }).tier).toBe('general_manager');
  });

  it('AC-CLM-08/09: 0 金额变更、防规避采购拦截、技术复核与超计划门禁、中止解除联动与担保方同意硬阻断', async () => {
    const t = await boot('newfc-t11-chg-');
    seedNetAssets(t.db);
    const projectId = await createProject(t.base, t.admin, 'P-T11-1', '引水工程项目', t.fx.orgIds.shanghai);
    const supplierId = await createSupplier(t.base, t.admin, 'S-T11-1', '湘水工程公司');
    const maker = createScopedUser(t.db, { username: 't11-maker', roleCodes: ['data_maintainer'], orgIds: [t.fx.orgIds.east] }).session;
    const reviewer = createScopedUser(t.db, { username: 't11-rev', roleCodes: ['business_reviewer'], orgIds: [t.fx.orgIds.east] }).session;
    const doc = async (cid: number, docType: string, name: string, evidenceKind?: string) =>
      (await ok(upload(t.base, maker, `/api/contracts/${cid}/documents`, Buffer.from(`${docType}-${name}`), name, { docType, ...(evidenceKind ? { evidenceKind } : {}) }), 201)).id as number;

    // 造一条关联综合计划项（年度计划 200 万元）
    const now = '2026-11-13T00:00:00.000Z';
    const foId = Number(t.db.prepare("INSERT INTO file_object (sha256, size_bytes, content_type, original_name, created_at) VALUES (?, 10, 'application/octet-stream', 'p.xlsx', ?)").run('b'.repeat(64), now).lastInsertRowid);
    const batchId = Number(t.db.prepare("INSERT INTO plan_batch (year, actual_period, file_object_id, file_sha256, file_name, amount_unit, status, is_current, item_count, fact_count, created_at) VALUES (2026, '2026-11', ?, ?, 'p.xlsx', 'yuan', 'imported', 1, 1, 1, ?)").run(foId, 'b'.repeat(64), now).lastInsertRowid);
    const planItemId = Number(t.db.prepare("INSERT INTO plan_item (batch_id, sheet_code, row_no, item_name, item_type, item_key, org_id, project_id) VALUES (?, 'investment', 1, '引水计划项', 'detail', 'inv-1', ?, ?)").run(batchId, t.fx.orgIds.shanghai, projectId).lastInsertRowid);
    t.db.prepare("INSERT INTO plan_fact (batch_id, item_id, field_key, measure, value_type, amount_cents, source_cell) VALUES (?, ?, 'annual_plan', 'annual_plan', 'amount', 200000000, 'D5')").run(batchId, planItemId);

    let c = await ok(post(t.base, maker, '/api/contracts', { ...SIGNATORIES,
      contractNo: 'LS-SG-001/2026-201',
      name: '引水渠施工合同',
      contractType: '工程',
      orgId: t.fx.orgIds.shanghai,
      projectId,
      supplierId,
      planItemId,
      originalAmount: '1800000.00',
      legalCategory: 'construction',
      procurementTarget: 'construction',
      procurementMethod: 'public_tender',
    }), 201);
    await doc(c.id, 'procurement', '定标.pdf', 'bid_award_approval');
    for (const st of ['procurement', 'drafting']) {
      c = await ok(get(t.base, maker, `/api/contracts/${c.id}`));
      c = await ok(post(t.base, maker, `/api/contracts/${c.id}/advance`, { expectedVersion: c.version, toStage: st }));
    }
    const txtId = await doc(c.id, 'contract_text', '正文.docx');
    c = await ok(get(t.base, maker, `/api/contracts/${c.id}`));
    c = await ok(post(t.base, maker, `/api/contracts/${c.id}/advance`, { expectedVersion: c.version, toStage: 'approval' }));
    seedCurrentLegalRun(t.db, c.id);
    c = await ok(post(t.base, maker, `/api/contracts/${c.id}/reviews`, { documentId: txtId }), 201);
    c = await ok(post(t.base, reviewer, `/api/contracts/${c.id}/reviews/${c.reviews[0].id}/decide`, { decision: 'approve' }));
    await doc(c.id, 'signed', '盖章.pdf');
    c = await ok(get(t.base, maker, `/api/contracts/${c.id}`));
    c = await ok(patch(t.base, maker, `/api/contracts/${c.id}`, { expectedVersion: c.version, signDate: '2026-03-01', effectiveDate: '2026-03-01' }));
    c = await ok(post(t.base, maker, `/api/contracts/${c.id}/advance`, { expectedVersion: c.version, toStage: 'performance' }));

    const chgDoc = await doc(c.id, 'change', '变更决议.pdf', 'change_decision');
    const techAuditDoc = await doc(c.id, 'other', '技术专项复核.pdf', 'tech_special_audit');
    const outPlanDoc = await doc(c.id, 'other', '计划外批件.pdf', 'out_of_plan_approval');
    const termDoc = await doc(c.id, 'other', '解除协议.pdf', 'termination_agreement');
    const guarDoc = await doc(c.id, 'guarantee', '担保同意函.pdf', 'guarantor_consent');

    // 1) 防拆包规避采购拦截（第 9.1.4 条）
    await fail(post(t.base, maker, `/api/contracts/${c.id}/changes`, { ...CHANGE_GOVERNANCE,
      changeKind: 'change', delta: '50000.00', changeMatter: '新增独立标段', reason: '附带委托', evidenceDocumentId: chgDoc, isIndependentDelegable: true,
    }), 409, 'CONTRACT_CHANGE_EVADE_PROCUREMENT');

    // 2) 0 金额变更允许落库 + 唯一补充协议号 + 批准后补录备案
    c = await ok(post(t.base, maker, `/api/contracts/${c.id}/changes`, { ...CHANGE_GOVERNANCE,
      changeKind: 'change', delta: '0.00', changeMatter: '工期顺延30天', reason: '汛期不可抗力', evidenceDocumentId: chgDoc,
      involvesBizOrEntityChange: true, actualApprovalTier: 'undertaker_vp', supplementNo: 'HT-201-补1',
    }), 201);
    expect(c.changes[0]).toMatchObject({ delta: '0.00', requiredApprovalTier: 'undertaker_vp', supplementNo: 'HT-201-补1' });
    await fail(post(t.base, maker, `/api/contracts/${c.id}/changes`, { ...CHANGE_GOVERNANCE,
      changeKind: 'change', delta: '0.00', changeMatter: '重复编号', reason: '测试', evidenceDocumentId: chgDoc, actualApprovalTier: 'undertaker_unit', supplementNo: 'ht-201-补1',
    }), 409, 'SUPPLEMENT_NO_EXISTS');
    c = await ok(post(t.base, reviewer, `/api/contracts/${c.id}/changes/${c.changes[0].id}/decide`, { decision: 'approve' }));
    c = await ok(patch(t.base, maker, `/api/contracts/${c.id}/changes/${c.changes[0].id}/filing`, { disciplineFiledAt: '2026-04-01', hasDispute: false }));
    expect(c.changes[0].disciplineFiledAt).toBe('2026-04-01');

    // 3) >10% 增额（25万 > 180万*10%=18万，且 180+25=205万 > 计划 200万）同时校验审批层级、技术复核及超计划凭据
    await fail(post(t.base, maker, `/api/contracts/${c.id}/changes`, { ...CHANGE_GOVERNANCE,
      changeKind: 'change', delta: '250000.00', changeMatter: '渠道扩建', reason: '地质变更', evidenceDocumentId: chgDoc,
      actualApprovalTier: 'undertaker_unit',
    }), 409, 'CONTRACT_CHANGE_TIER_MISMATCH');
    await fail(post(t.base, maker, `/api/contracts/${c.id}/changes`, { ...CHANGE_GOVERNANCE,
      changeKind: 'change', delta: '250000.00', changeMatter: '渠道扩建', reason: '地质变更', evidenceDocumentId: chgDoc,
      actualApprovalTier: 'management_board',
    }), 409, 'TECH_SPECIAL_AUDIT_REQUIRED');
    await fail(post(t.base, maker, `/api/contracts/${c.id}/changes`, { ...CHANGE_GOVERNANCE,
      changeKind: 'change', delta: '250000.00', changeMatter: '渠道扩建', reason: '地质变更', evidenceDocumentId: chgDoc,
      actualApprovalTier: 'management_board', techSpecialAuditDocId: techAuditDoc,
    }), 409, 'OUT_OF_PLAN_APPROVAL_REQUIRED');
    c = await ok(post(t.base, maker, `/api/contracts/${c.id}/changes`, { ...CHANGE_GOVERNANCE,
      changeKind: 'change', delta: '250000.00', changeMatter: '渠道扩建', reason: '地质变更', evidenceDocumentId: chgDoc,
      actualApprovalTier: 'management_board', techSpecialAuditDocId: techAuditDoc, outOfPlanDocId: outPlanDoc,
    }), 201);
    c = await ok(post(t.base, reviewer, `/api/contracts/${c.id}/changes/${c.changes[1].id}/decide`, { decision: 'approve' }));
    expect(c.currentAmount).toBe('2050000.00');

    // 4) 存在有效担保记录时，变更、中止、解除缺担保方书面同意均硬阻断
    t.db.prepare("INSERT INTO ct_guarantee (contract_id, guarantee_type, direction, issuer_name, guarantee_no, amount_cents, status, created_at, updated_at) VALUES (?, 'performance_guarantee', 'inbound', '建设银行', 'LG-001', 18000000, 'active', ?, ?)").run(c.id, now, now);
    await fail(post(t.base, maker, `/api/contracts/${c.id}/changes`, { ...CHANGE_GOVERNANCE,
      changeKind: 'change', delta: '0.00', changeMatter: '调整条款', reason: '无担保同意', evidenceDocumentId: chgDoc, actualApprovalTier: 'undertaker_unit',
    }), 409, 'GUARANTOR_CONSENT_REQUIRED');
    await fail(post(t.base, maker, `/api/contracts/${c.id}/suspend`, { expectedVersion: c.version, reason: '中止无担保同意' }), 409, 'GUARANTOR_CONSENT_REQUIRED');
    await fail(post(t.base, maker, `/api/contracts/${c.id}/terminate`, { expectedVersion: c.version, reason: '解除无担保同意' }), 409, 'GUARANTOR_CONSENT_REQUIRED');

    // 附上担保同意函完成中止 → 恢复 → 四位一体解除（总经理批准 + 解除协议 + 担保同意）
    c = await ok(post(t.base, maker, `/api/contracts/${c.id}/changes`, { ...CHANGE_GOVERNANCE,
      changeKind: 'suspend', delta: '0.00', changeMatter: '汛期中止', reason: '汛期停工', evidenceDocumentId: chgDoc,
      actualApprovalTier: 'undertaker_vp', guarantorConsentDocumentId: guarDoc,
    }), 201);
    c = await ok(post(t.base, reviewer, `/api/contracts/${c.id}/changes/${c.changes[2].id}/decide`, { decision: 'approve' }));
    expect(c.status).toBe('suspended');
    c = await ok(post(t.base, maker, `/api/contracts/${c.id}/resume`, { expectedVersion: c.version, reason: '汛期结束恢复' }));
    expect(c.status).toBe('active');

    await fail(post(t.base, maker, `/api/contracts/${c.id}/changes`, { ...CHANGE_GOVERNANCE,
      changeKind: 'terminate', delta: '0.00', changeMatter: '提前解除', reason: '项目调整', evidenceDocumentId: termDoc,
      actualApprovalTier: 'dual_vp', guarantorConsentDocumentId: guarDoc,
    }), 409, 'CONTRACT_CHANGE_TIER_MISMATCH');
    c = await ok(post(t.base, maker, `/api/contracts/${c.id}/changes`, { ...CHANGE_GOVERNANCE,
      changeKind: 'terminate', delta: '0.00', changeMatter: '提前解除', reason: '项目调整', evidenceDocumentId: termDoc,
      actualApprovalTier: 'general_manager', guarantorConsentDocumentId: guarDoc,
    }), 201);
    c = await ok(post(t.base, reviewer, `/api/contracts/${c.id}/changes/${c.changes[3].id}/decide`, { decision: 'approve' }));
    expect(c.status).toBe('terminated');
  });
});

describe('T-11.3 保函保险、质保签证与纠纷闭环', () => {
  it('AC-CLM-10: 保函押金清理与索赔报告、质保期满签证解锁尾款、17列纠纷台账及双备案、权限与审计闭环', async () => {
    const t = await boot('newfc-t11-safe-');
    seedNetAssets(t.db);
    const projectId = await createProject(t.base, t.admin, 'P-T11-3', '闸门除险工程', t.fx.orgIds.shanghai);
    const supplierId = await createSupplier(t.base, t.admin, 'S-T11-3', '湘澧水工机械公司');
    const maker = createScopedUser(t.db, { username: 't11s-maker', roleCodes: ['data_maintainer'], orgIds: [t.fx.orgIds.east] }).session;
    const reviewer = createScopedUser(t.db, { username: 't11s-rev', roleCodes: ['business_reviewer'], orgIds: [t.fx.orgIds.east] }).session;
    const njUser = createScopedUser(t.db, { username: 't11s-nj', roleCodes: ['data_maintainer'], orgIds: [t.fx.orgIds.nanjing] }).session;
    const viewer = createScopedUser(t.db, { username: 't11s-view', roleCodes: ['viewer'], orgIds: [t.fx.orgIds.east] }).session;
    const doc = async (cid: number, docType: string, name: string, evidenceKind?: string) =>
      (await ok(upload(t.base, maker, `/api/contracts/${cid}/documents`, Buffer.from(`${docType}-${name}`), name, { docType, ...(evidenceKind ? { evidenceKind } : {}) }), 201)).id as number;

    let c = await ok(post(t.base, maker, '/api/contracts', { ...SIGNATORIES,
      contractNo: 'LS-SG-001/2026-301',
      name: '泄洪闸门安装及质保合同',
      contractType: '工程',
      orgId: t.fx.orgIds.shanghai,
      projectId,
      supplierId,
      originalAmount: '1000000.00',
      hasWarranty: true,
      warrantyMonths: 12,
      warrantyRetentionRatio: '0.05',
      undertakerName: '陈工',
    }), 201);

    // 推进至 performance
    await doc(c.id, 'procurement', '定标.pdf', 'bid_award_approval');
    for (const st of ['procurement', 'drafting']) {
      c = await ok(get(t.base, maker, `/api/contracts/${c.id}`));
      c = await ok(post(t.base, maker, `/api/contracts/${c.id}/advance`, { expectedVersion: c.version, toStage: st }));
    }
    const txtId = await doc(c.id, 'contract_text', '正文.docx');
    c = await ok(get(t.base, maker, `/api/contracts/${c.id}`));
    c = await ok(post(t.base, maker, `/api/contracts/${c.id}/advance`, { expectedVersion: c.version, toStage: 'approval' }));
    c = await ok(post(t.base, maker, `/api/contracts/${c.id}/reviews`, { documentId: txtId }), 201);
    c = await ok(post(t.base, reviewer, `/api/contracts/${c.id}/reviews/${c.reviews[0].id}/decide`, { decision: 'approve' }));
    await doc(c.id, 'signed', '盖章.pdf');
    c = await ok(get(t.base, maker, `/api/contracts/${c.id}`));
    c = await ok(patch(t.base, maker, `/api/contracts/${c.id}`, { expectedVersion: c.version, signDate: '2026-03-01', effectiveDate: '2026-03-01' }));
    c = await ok(post(t.base, maker, `/api/contracts/${c.id}/advance`, { expectedVersion: c.version, toStage: 'performance' }));

    const lgDoc = await doc(c.id, 'guarantee', '履约保函.pdf');
    const visaDoc = await doc(c.id, 'settlement', '质保金支付签证表.pdf', 'warranty_release_visa');
    const invDoc = await doc(c.id, 'invoice', '工程发票.pdf');
    const apprDoc = await doc(c.id, 'other', '签批单.pdf', 'payment_approval_form');
    const chgDoc = await doc(c.id, 'change', '争议签证.pdf', 'change_decision');
    const guarConsentDoc = await doc(c.id, 'guarantee', '担保方书面同意函.pdf', 'guarantor_consent');

    // 1) 保函/保证金/保险台账：校验、登记、索赔报告、退还清理及权限范围隔离
    await fail(post(t.base, maker, `/api/contracts/${c.id}/guarantees`, {
      guaranteeType: 'performance_guarantee', direction: 'inbound', issuerName: '中国银行', guaranteeNo: 'LG-ERR',
      amount: '100000.00', effectiveDate: '2026-06-01', expiryDate: '2026-05-01',
    }), 400, 'VALIDATION_FAILED');

    c = await ok(post(t.base, maker, `/api/contracts/${c.id}/guarantees`, {
      guaranteeType: 'performance_guarantee', direction: 'inbound', issuerName: '中国银行常德分行', guaranteeNo: 'LG-301-01',
      amount: '100000.00', depositAmount: '20000.00', ratio: '0.100000',
      effectiveDate: '2026-03-05', expiryDate: '2026-12-31', documentId: lgDoc, note: '履约保函含押金',
    }), 201);
    const gid1 = c.guarantees[0].id;
    expect(c.guarantees[0]).toMatchObject({ status: 'active', amount: '100000.00', depositAmount: '20000.00', ratio: '0.100000' });

    // 索赔发生日期、报告日期校验
    c = await ok(post(t.base, maker, `/api/contracts/${c.id}/guarantees`, {
      guaranteeType: 'engineering_insurance', direction: 'outbound', issuerName: '人保财险', guaranteeNo: 'INS-301-02',
      amount: '500000.00', depositAmount: '0.00', effectiveDate: '2026-03-05', expiryDate: '2026-12-31',
    }), 201);
    const gid2 = c.guarantees[1].id;
    await fail(patch(t.base, maker, `/api/contracts/${c.id}/guarantees/${gid2}`, { status: 'claimed' }), 400, 'VALIDATION_FAILED');
    await fail(patch(t.base, maker, `/api/contracts/${c.id}/guarantees/${gid2}`, {
      status: 'claimed', claimOccurredAt: '2026-05-10', claimReportedAt: '2026-05-09',
    }), 400, 'VALIDATION_FAILED');
    c = await ok(patch(t.base, maker, `/api/contracts/${c.id}/guarantees/${gid2}`, {
      status: 'claimed', claimOccurredAt: '2026-05-10', claimReportedAt: '2026-05-11', note: '出险理赔并按2日规则报告',
    }));
    expect(c.guarantees[1]).toMatchObject({ status: 'claimed', claimOccurredAt: '2026-05-10', claimReportedAt: '2026-05-11' });
    expect(await ok(get(t.base, maker, `/api/contracts/${c.id}/guarantees`))).toHaveLength(2);

    // 范围外与只读权限校验
    expect((await get(t.base, njUser, `/api/contracts/${c.id}/guarantees`)).status).toBe(404);
    expect((await post(t.base, viewer, `/api/contracts/${c.id}/guarantees`, { guaranteeType: 'bid_bond', amount: '100.00' })).status).toBe(403);

    // 2) 结算扣留 5 万质保金并推进至 warranty 阶段
    await doc(c.id, 'performance', '施工验收记录.pdf');
    await doc(c.id, 'acceptance', '竣工初验单.pdf');
    c = await ok(get(t.base, maker, `/api/contracts/${c.id}`));
    c = await ok(post(t.base, reviewer, `/api/contracts/${c.id}/archive-status`, { expectedVersion: c.version, archiveStatus: 'checked' }));
    c = await ok(post(t.base, maker, `/api/contracts/${c.id}/settlements`, {
      settlementKind: 'final', settlementDate: '2026-06-01',
      inContractAmount: '1000000.00', deductRetentionAmount: '50000.00',
    }), 201);
    c = await ok(post(t.base, reviewer, `/api/contracts/${c.id}/settlements/${c.settlements[0].id}/decide`, { decision: 'approve' }));
    c = await ok(post(t.base, maker, `/api/contracts/${c.id}/payments`, { ...PAYMENT_APPROVAL,
      settlementId: c.settlements[0].id, nodeName: '竣工结算款(扣质保金)', paymentType: 'progress', amount: '950000.00',
      approvalTier: 'general_manager', approverName: '王总', approverTitle: '总经理', approvalDocId: apprDoc,
    }), 201);
    const p1 = c.payments[0].id;
    c = await ok(post(t.base, reviewer, `/api/contracts/${c.id}/payments/${p1}/decide`, { decision: 'approve' }));
    c = await ok(post(t.base, maker, `/api/contracts/${c.id}/payments/${p1}/pay`, { paidDate: '2026-06-10', invoiceDocumentId: invDoc }));
    c = await ok(post(t.base, reviewer, `/api/contracts/${c.id}/archive-status`, { expectedVersion: c.version, archiveStatus: 'transferred', actionDate: '2026-06-12', transferNo: 'ARC-301' }));
    c = await ok(post(t.base, maker, `/api/contracts/${c.id}/advance`, { expectedVersion: c.version, toStage: 'settlement' }));
    c = await ok(patch(t.base, maker, `/api/contracts/${c.id}`, { expectedVersion: c.version, finalAccepted: true }));
    c = await ok(post(t.base, maker, `/api/contracts/${c.id}/advance`, { expectedVersion: c.version, toStage: 'warranty' }));

    // 3) 质保期维护与签证确认门禁
    c = await ok(put(t.base, maker, `/api/contracts/${c.id}/warranty`, {
      startDate: '2026-06-15', endDate: '2026-10-14', retentionAmount: '50000.00',
      defectRecords: [{ date: '2026-09-01', description: '闸门止水微渗漏', resolved: true, resolvedDate: '2026-09-10' }],
    }));
    expect(c.warranty).toMatchObject({ startDate: '2026-06-15', endDate: '2026-10-14', retentionAmount: '50000.00' });
    await fail(put(t.base, maker, `/api/contracts/${c.id}/warranty`, { endDate: '2026-05-01' }), 400, 'VALIDATION_FAILED');
    // 无 contract:review 权限不能确认质保签证；有 contract:review 但无 contract:write 不能只改期限
    await fail(put(t.base, maker, `/api/contracts/${c.id}/warranty`, { inspectionConclusion: 'passed', visaDocumentId: visaDoc }), 403, 'FORBIDDEN');
    await fail(put(t.base, reviewer, `/api/contracts/${c.id}/warranty`, { endDate: '2027-06-20' }), 403, 'FORBIDDEN');

    // 质保结论为整改中时，即使存在 visa 文档也拦截质保尾款申请
    c = await ok(put(t.base, reviewer, `/api/contracts/${c.id}/warranty`, {
      inspectionDate: '2026-10-15', inspectionConclusion: 'rectifying',
    }));
    await fail(post(t.base, maker, `/api/contracts/${c.id}/payments`, { ...PAYMENT_APPROVAL,
      nodeName: '质保尾款', paymentType: 'warranty_release', amount: '50000.00',
      approvalTier: 'finance_vp', approverName: '李副总', approverTitle: '财务副总',
    }), 409, 'WARRANTY_VISA_REQUIRED');

    // 复核人确认质保期满验收通过并绑定《质保金支付签证表》
    c = await ok(put(t.base, reviewer, `/api/contracts/${c.id}/warranty`, {
      inspectionDate: '2026-10-20', inspectionConclusion: 'passed', visaDocumentId: visaDoc,
    }));
    expect(c.warranty).toMatchObject({ inspectionConclusion: 'passed', visaDocumentId: visaDoc });
    expect((await ok(get(t.base, maker, `/api/contracts/${c.id}/warranty`))).inspectionConclusion).toBe('passed');

    // 未支付质保尾款前阻断 warranty → closed（同时检查未退还保函与未结纠纷）
    c = await ok(post(t.base, maker, `/api/contracts/${c.id}/changes`, { ...CHANGE_GOVERNANCE,
      changeKind: 'counter_claim', delta: '0.00', changeMatter: '质保缺陷反索赔争议', reason: '闸门止水渗漏反索赔协商', evidenceDocumentId: chgDoc,
      actualApprovalTier: 'undertaker_unit', guarantorConsentDocumentId: guarConsentDoc,
    }), 201);
    const chgId = c.changes[0].id;
    c = await ok(post(t.base, reviewer, `/api/contracts/${c.id}/changes/${chgId}/decide`, { decision: 'approve' }));

    // 4) 17 列诉讼仲裁纠纷台账与双备案
    c = await ok(post(t.base, maker, `/api/contracts/${c.id}/disputes`, {
      changeId: chgId,
      occurredDate: '2026-10-01',
      reportedToDeptAt: '2026-10-02',
      litigationType: '民事诉讼',
      causeOfAction: '建设工程施工合同纠纷',
      counterpartyAndRole: '湘澧水工机械公司（原告）',
      stage: 'litigation_1st',
      institutionName: '常德市中级人民法院',
      caseNo: '(2026)湘07民初128号',
      involvedOrgName: '上海分公司',
      ourLitigationRole: '被告',
      acceptedDate: '2026-10-12',
      caseSummary: '围绕甲供配件延迟引发窝工索赔',
      gmApprovedAt: '2026-10-08',
      legalDocForm: '民事起诉状/答辩状',
      disputeAmount: '80000.00',
      lawFirmAndLawyer: '湖南天地人律师事务所 张律师',
    }), 201);
    const did = c.disputes[0].id;
    expect(c.disputes[0]).toMatchObject({ caseNo: '(2026)湘07民初128号', stage: 'litigation_1st', disputeAmount: '80000.00' });
    expect(c.changes[0].hasDispute).toBe(true);
    expect(await ok(get(t.base, maker, `/api/contracts/${c.id}/disputes`))).toHaveLength(1);

    // 此时应有 3 项阻断：CONTRACT_NOT_CLEARED / ACTIVE_GUARANTEES_UNRETURNED / OPEN_DISPUTES
    expect(c.blockers.map((b: { code: string }) => b.code)).toEqual(
      expect.arrayContaining(['CONTRACT_NOT_CLEARED', 'ACTIVE_GUARANTEES_UNRETURNED', 'OPEN_DISPUTES']),
    );
    await fail(post(t.base, maker, `/api/contracts/${c.id}/advance`, { expectedVersion: c.version, toStage: 'closed' }), 409, 'CONTRACT_STAGE_BLOCKED');

    // 逐项闭环解锁：支付质保金尾款 → 退还履约保函/押金 → 纠纷结案与企管/纪审双备案
    c = await ok(post(t.base, maker, `/api/contracts/${c.id}/payments`, { ...PAYMENT_APPROVAL,
      nodeName: '质保期满尾款', paymentType: 'warranty_release', amount: '50000.00',
      approvalTier: 'finance_vp', approverName: '李副总', approverTitle: '财务副总',
    }), 201);
    const retPayId = c.payments.at(-1).id;
    c = await ok(post(t.base, reviewer, `/api/contracts/${c.id}/payments/${retPayId}/decide`, { decision: 'approve' }));
    c = await ok(post(t.base, maker, `/api/contracts/${c.id}/payments/${retPayId}/pay`, { paidDate: '2027-06-25', voucherNo: '记-0625-01', invoiceDocumentId: invDoc }));
    expect(c.warranty.releasedPaymentId).toBe(retPayId);

    await fail(patch(t.base, maker, `/api/contracts/${c.id}/guarantees/${gid1}`, { status: 'returned' }), 400, 'VALIDATION_FAILED');
    c = await ok(patch(t.base, maker, `/api/contracts/${c.id}/guarantees/${gid1}`, { status: 'returned', returnedDate: '2027-06-26' }));
    expect(c.guarantees[0]).toMatchObject({ status: 'returned', returnedDate: '2027-06-26' });

    c = await ok(patch(t.base, maker, `/api/contracts/${c.id}/disputes/${did}`, {
      stage: 'closed',
      closedDate: '2027-06-28',
      judgmentResult: '法院调解撤诉，驳回额外索赔请求',
      actualSettledAmount: '0.00',
      filedToMgmtAt: '2027-06-29',
      filedToDisciplineAt: '2027-06-30',
    }));
    expect(c.disputes[0]).toMatchObject({
      stage: 'closed', actualSettledAmount: '0.00', filedToMgmtAt: '2027-06-29', filedToDisciplineAt: '2027-06-30',
    });

    // 出险保险也须完成理赔清理，不能仅凭已登记索赔就视为闭环。
    c = await ok(patch(t.base, maker, `/api/contracts/${c.id}/guarantees/${gid2}`, { status: 'returned', returnedDate: '2026-10-26' }));
    // 阻断清空，顺利从 warranty 推进至 closed
    expect(c.blockers).toEqual([]);
    c = await ok(post(t.base, maker, `/api/contracts/${c.id}/advance`, { expectedVersion: c.version, toStage: 'closed' }));
    expect(c).toMatchObject({ stage: 'closed', status: 'closed', paidAmount: '1000000.00' });

    const evTypes = c.events.map((e: { eventType: string }) => e.eventType);
    expect(evTypes).toEqual(expect.arrayContaining(['guarantee.create', 'guarantee.update', 'warranty.update', 'dispute.create', 'dispute.update', 'archive']));
  });
});
