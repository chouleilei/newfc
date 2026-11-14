import { SIGNATORIES, PAYMENT_APPROVAL, CHANGE_GOVERNANCE, seedNetAssets } from './contract-review-fixtures';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/connection';
import { applyMigrations } from '../src/db/migrations';
import { importLegalSeed } from '../src/modules/contracts/legal-catalog.service';
import seed from '../../deploy/contract-legal-seed-v1.json';
import { boot, get, post, upload, type Session } from './t3-helpers';
import { createScopedUser, fetchAs } from './http-helpers';
import { createProject, createSupplier } from './t4-helpers';
import { legalRules } from '../src/modules/contracts/legal-rules';
import { GOOD_TEXT, parsed } from './t9-legal-fixture';
import { contractPaidInPeriod, contractPaymentTotals, contractReceivedInPeriod, contractReceiptTotals, type ContractRow } from '../src/modules/contracts/contract.service';

const patch = (base: string, s: Session, url: string, body: unknown) =>
  fetchAs(s, `${base}${url}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
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

describe('T-10.1 V68 合同生命周期底座重建迁移', () => {
  it('临时文件库 V67 非空合同/法审数据无损迁移至 V68：archived → closed + transferred、外键与触发器完整', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'newfc-t10-v68-'));
    const dbPath = path.join(dir, 'v67-to-v68.sqlite');
    const backupPath = path.join(dir, 'v67-backup.sqlite');
    const db = openDatabase(dbPath);
    const now = '2026-11-12T08:00:00.000Z';
    try {
      applyMigrations(db, 67);
      expect((db.prepare('SELECT MAX(version) AS v FROM schema_migration').get() as { v: number }).v).toBe(67);

      // 写入法审制度与范本种子
      const seeded = importLegalSeed(db, seed);
      expect(seeded.policies).toBeGreaterThan(0);
      expect(seeded.templates).toBeGreaterThan(0);

      const orgId = Number(
        db.prepare("INSERT INTO org (code, name, created_at, updated_at) VALUES ('ORG-T10', '澧水测试单位', ?, ?)").run(now, now).lastInsertRowid,
      );
      const sha64 = 'a'.repeat(64);
      const fileObjId = Number(
        db.prepare("INSERT INTO file_object (sha256, size_bytes, content_type, original_name, created_at) VALUES (?, 256, 'application/pdf', 'contract.pdf', ?)")
          .run(sha64, now).lastInsertRowid,
      );
      expect(fileObjId).toBeGreaterThan(0);

      // 1) 存量已归档合同 (stage = 'archived')
      const archivedId = Number(
        db.prepare(`INSERT INTO ct_contract (
          contract_no, normalized_no, name, contract_type, org_id, original_cents, approved_change_cents, paid_cents,
          stage, status, sign_date, effective_date, created_at, updated_at, legal_category, procurement_target
        ) VALUES ('HT-V67-ARCH', 'HT-V67-ARCH', '存量归档施工合同', '工程', ?, 50000000, 10000000, 60000000,
          'archived', 'closed', '2026-01-10', '2026-01-10', ?, ?, 'small_construction', 'construction')`)
          .run(orgId, now, now).lastInsertRowid,
      );

      // 2) 存量进行中合同 + 文档 + 法审运行 + 审核 + 变更 + 付款 + 事件
      const activeId = Number(
        db.prepare(`INSERT INTO ct_contract (
          contract_no, normalized_no, name, contract_type, org_id, original_cents, approved_change_cents, paid_cents,
          stage, status, sign_date, created_at, updated_at, legal_category, party_role, signing_entity_level, is_procurement, procurement_target, procurement_method, is_important
        ) VALUES ('HT-V67-ACT', 'HT-V67-ACT', '存量设备采购合同', '货物', ?, 10000000, 0, 3000000,
          'performance', 'active', '2026-05-01', ?, ?, 'goods_procurement', 'buyer', 'company', 1, 'goods', 'inquiry', 1)`)
          .run(orgId, now, now).lastInsertRowid,
      );

      const docId = Number(
        db.prepare("INSERT INTO ct_document (contract_id, doc_type, file_object_id, name, uploaded_at, evidence_kind) VALUES (?, 'contract_text', ?, '正文.docx', ?, NULL)")
          .run(activeId, fileObjId, now).lastInsertRowid,
      );
      const invDocId = Number(
        db.prepare("INSERT INTO ct_document (contract_id, doc_type, file_object_id, name, uploaded_at, evidence_kind) VALUES (?, 'invoice', ?, '发票.pdf', ?, 'other')")
          .run(activeId, fileObjId, now).lastInsertRowid,
      );
      const chgDocId = Number(
        db.prepare("INSERT INTO ct_document (contract_id, doc_type, file_object_id, name, uploaded_at, evidence_kind) VALUES (?, 'change', ?, '签证.pdf', ?, 'other')")
          .run(activeId, fileObjId, now).lastInsertRowid,
      );
      const runId = Number(
        db.prepare(`INSERT INTO ct_legal_run (
          contract_id, document_id, document_sha256, contract_version, context_fingerprint, policy_refs_json,
          parse_channel, parse_status, model_status, verdict, risk_level, summary_json, elements_json, stats_json, created_at
        ) VALUES (?, ?, ?, 1, 'fp-v67', '[]', 'docx_native', 'ok', 'ok', 'pass', 'low', '[]', '{}', '{}', ?)`)
          .run(activeId, docId, sha64, now).lastInsertRowid,
      );
      db.prepare(`INSERT INTO ct_legal_finding (
        run_id, source, code, severity, blocking, title, message, location_ref, excerpt, expected_text, suggested_text, sort_order
      ) VALUES (?, 'rule', 'INFO_NOTE', 'info', 0, '提示', '测试提示', 'P1', '摘录', '', '', 1)`).run(runId);
      db.prepare(`INSERT INTO ct_review (contract_id, document_id, status, submit_note, submitted_at, reviewed_at, legal_run_id, override_high_risk)
        VALUES (?, ?, 'approved', '送审', ?, ?, ?, 0)`).run(activeId, docId, now, now, runId);
      db.prepare("INSERT INTO ct_change (contract_id, delta_cents, reason, evidence_document_id, status, submitted_at) VALUES (?, 500000, '增项', ?, 'submitted', ?)")
        .run(activeId, chgDocId, now);
      const payId = Number(
        db.prepare(`INSERT INTO ct_payment (
          contract_id, kind, node_name, amount_cents, status, submitted_at, reviewed_at, paid_date, invoice_document_id, paid_at
        ) VALUES (?, 'normal', '首付款', 3000000, 'paid', ?, ?, '2026-05-15', ?, ?)`)
          .run(activeId, now, now, invDocId, now).lastInsertRowid,
      );
      db.prepare("INSERT INTO ct_event (contract_id, event_type, from_stage, to_stage, detail_json, created_at) VALUES (?, 'archive', 'settlement', 'archived', '{}', ?)")
        .run(archivedId, now);

      await db.backup(backupPath);

      // 执行 V68 重建迁移与幂等复跑
      expect(applyMigrations(db, 68).map((m) => m.version)).toEqual([68]);
      expect(applyMigrations(db, 68)).toEqual([]);
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');

      // 验证外键目标表名未残留 *_v68
      for (const tbl of ['ct_contract', 'ct_document', 'ct_payment', 'ct_review', 'ct_change', 'ct_legal_run', 'ct_settlement', 'ct_receipt', 'ct_undertaker_handover']) {
        const fks = db.prepare(`SELECT "table" AS t FROM pragma_foreign_key_list('${tbl}')`).all() as { t: string }[];
        expect(fks.every((fk) => !fk.t.endsWith('_v68')), `${tbl}: ${JSON.stringify(fks)}`).toBe(true);
      }

      // 验证 archived → closed + transferred + report_category 自动映射
      const archRow = db.prepare('SELECT stage, status, archive_status, final_accepted, report_category, archive_transferred_at FROM ct_contract WHERE id = ?')
        .get(archivedId) as Record<string, unknown>;
      expect(archRow).toEqual({
        stage: 'closed',
        status: 'closed',
        archive_status: 'transferred',
        final_accepted: 1,
        report_category: 'engineering',
        archive_transferred_at: now,
      });

      // 验证进行中合同、法审运行、付款记录无损保留
      const actRow = db.prepare('SELECT stage, status, direction, pricing_mode, currency, report_category, paid_cents FROM ct_contract WHERE id = ?')
        .safeIntegers(true).get(activeId) as Record<string, unknown>;
      expect(actRow).toEqual({
        stage: 'performance',
        status: 'active',
        direction: 'expense',
        pricing_mode: 'lump_sum',
        currency: '人民币',
        report_category: 'goods',
        paid_cents: 3000000n,
      });
      expect(db.prepare('SELECT verdict, context_fingerprint FROM ct_legal_run WHERE id = ?').get(runId)).toEqual({
        verdict: 'pass',
        context_fingerprint: 'fp-v67',
      });
      expect(db.prepare('SELECT payment_type, currency, amount_cents FROM ct_payment WHERE id = ?').safeIntegers(true).get(payId)).toEqual({
        payment_type: 'progress',
        currency: '人民币',
        amount_cents: 3000000n,
      });

      // 验证单价合同允许 original_cents = 0 且受 estimated_ceiling_cents 约束
      const unitId = Number(
        db.prepare(`INSERT INTO ct_contract (
          contract_no, normalized_no, name, org_id, pricing_mode, unit_price_desc, original_cents, estimated_ceiling_cents, created_at, updated_at
        ) VALUES ('HT-UNIT-01', 'HT-UNIT-01', '框架单价检修合同', ?, 'unit_price', '按审定工时单价 500 元/工日结算', 0, 2000000, ?, ?)`)
          .run(orgId, now, now).lastInsertRowid,
      );
      expect(unitId).toBeGreaterThan(0);
      expect(() => db.prepare('UPDATE ct_contract SET paid_cents = 2000001 WHERE id = ?').run(unitId)).toThrow(/CHECK/);

      // 验证结算单三栏勾稽 CHECK 与只追加触发器
      expect(() =>
        db.prepare(`INSERT INTO ct_settlement (
          contract_id, period_no, settlement_kind, settlement_date, in_contract_cents, change_claim_cents, other_add_cents,
          gross_payable_cents, deduct_prepayment_cents, deduct_retention_cents, deduct_penalty_cents, total_deduct_cents, net_payable_cents, submitted_at
        ) VALUES (?, 1, 'progress', '2026-06-01', 10000, 0, 0, 10000, 1000, 500, 0, 1500, 9000, ?)`).run(activeId, now),
      ).toThrow(/CHECK/);

      const handoverId = Number(
        db.prepare("INSERT INTO ct_undertaker_handover (contract_id, from_undertaker, to_undertaker, handover_date, created_at) VALUES (?, '张三', '李四', '2026-06-10', ?)")
          .run(activeId, now).lastInsertRowid,
      );
      expect(() => db.prepare("UPDATE ct_undertaker_handover SET to_undertaker = '王五' WHERE id = ?").run(handoverId)).toThrow(/只追加/);
      expect(() => db.prepare('DELETE FROM ct_undertaker_handover WHERE id = ?').run(handoverId)).toThrow(/只追加/);
      expect(() => db.prepare("UPDATE ct_document SET name = 'x' WHERE id = ?").run(docId)).toThrow(/不可修改/);
      // 复核修复 V72：非空 V67 链路、整数金额、法审引用与不可变文档均保留。
      expect(applyMigrations(db, 72).map(m => m.version)).toEqual([69, 70, 71, 72]);
      expect(applyMigrations(db, 72)).toEqual([]);
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(db.prepare('SELECT context_fingerprint FROM ct_legal_run WHERE id=?').get(runId)).toEqual({ context_fingerprint: 'fp-v67' });
      expect(db.prepare('SELECT amount_cents FROM ct_payment WHERE id=?').safeIntegers(true).get(payId)).toEqual({ amount_cents: 3000000n });
      expect(() => db.prepare("UPDATE ct_document SET name='x' WHERE id=?").run(docId)).toThrow(/不可修改/);
      const restoredPath = path.join(dir, 'restored.sqlite');
      fs.copyFileSync(backupPath, restoredPath);
      const restored = openDatabase(restoredPath);
      try {
        applyMigrations(restored, 72);
        expect(restored.pragma('foreign_key_check')).toEqual([]);
        expect(restored.pragma('integrity_check', { simple: true })).toBe('ok');
        expect(restored.prepare('SELECT stage, archive_status FROM ct_contract WHERE id=?').get(archivedId)).toEqual({ stage: 'closed', archive_status: 'transferred' });
        expect(restored.prepare('SELECT context_fingerprint FROM ct_legal_run WHERE id=?').get(runId)).toEqual({ context_fingerprint: 'fp-v67' });
      } finally { restored.close(); }

    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it.each(['currency', 'supplement'] as const)('V72遇到历史污染（%s）时整棒回滚，修正后可重试', (issue) => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'newfc-t10-v72-rollback-'));
    const db = openDatabase(path.join(dir, 'v71.sqlite'));
    const now = '2026-11-13T00:00:00.000Z';
    try {
      applyMigrations(db, 71);
      const org = (code: string, parent: number | null) => Number(db.prepare(
        'INSERT INTO org(code,name,parent_id,created_at,updated_at) VALUES(?,?,?,?,?)',
      ).run(code, code, parent, now, now).lastInsertRowid);
      const root = org('ROOT', null);
      const departments = [org('DEPT-A', root), org('DEPT-B', root)];
      const file = Number(db.prepare(
        "INSERT INTO file_object(sha256,size_bytes,content_type,original_name,created_at) VALUES(?,1,'application/pdf','evidence.pdf',?)",
      ).run('b'.repeat(64), now).lastInsertRowid);
      const ids = departments.map((orgId, i) => {
        const id = Number(db.prepare(
          'INSERT INTO ct_contract(contract_no,normalized_no,name,org_id,original_cents,created_at,updated_at) VALUES(?,?,?,?,10000,?,?)',
        ).run(`ROLLBACK-${i}`, `ROLLBACK-${i}`, '迁移回滚合成合同', orgId, now, now).lastInsertRowid);
        const doc = Number(db.prepare(
          "INSERT INTO ct_document(contract_id,doc_type,file_object_id,name,uploaded_at,evidence_kind) VALUES(?,'change',?,'evidence.pdf',?,'change_decision')",
        ).run(id, file, now).lastInsertRowid);
        if (issue === 'supplement') db.prepare(
          "INSERT INTO ct_change(contract_id,org_root_id,reason,evidence_document_id,supplement_no,normalized_supplement_no,submitted_at) VALUES(?,?,'同法人跨部门旧重号',?,'SUPP-1','SUPP-1',?)",
        ).run(id, orgId, doc, now);
        return id;
      });
      if (issue === 'currency') db.prepare(
        "INSERT INTO ct_payment(contract_id,node_name,amount_cents,currency,submitted_at) VALUES(?,'旧错币种流水',100,'美元',?)",
      ).run(ids[0], now);
      const schema = () => db.prepare('SELECT type,name,tbl_name,sql FROM sqlite_master ORDER BY type,name').all();
      const rows = () => ['ct_contract', 'ct_document', 'ct_change', 'ct_payment', 'schema_migration'].map(table =>
        db.prepare(`SELECT * FROM ${table} ORDER BY 1`).safeIntegers(true).all(),
      );
      const originalSchema = schema();
      const originalRows = rows();
      expect(() => applyMigrations(db, 72)).toThrow(issue === 'currency' ? /币种不一致/ : /UNIQUE/);
      expect(schema()).toEqual(originalSchema);
      expect(rows()).toEqual(originalRows);
      expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
      expect(() => db.prepare("UPDATE ct_document SET name='changed'").run()).toThrow(/不可修改/);
      if (issue === 'currency') db.prepare("UPDATE ct_payment SET currency='人民币'").run();
      else db.prepare("UPDATE ct_change SET supplement_no='SUPP-2',normalized_supplement_no='SUPP-2' WHERE contract_id=?").run(ids[1]);
      expect(applyMigrations(db, 72).map(m => m.version)).toEqual([72]);
      expect(applyMigrations(db, 72)).toEqual([]);
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
      if (issue === 'supplement') expect(db.prepare('SELECT DISTINCT org_root_id FROM ct_change').all()).toEqual([{ org_root_id: root }]);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('T-10.2 八阶段状态机、单价合同与授权/时间链门禁', () => {
  it('AC-CLM-01/03/05: 8阶段质保闭环、中止恢复、签署授权门禁、承办人交接与正交分发归档', async () => {
    const t = await boot('newfc-t10-sm-');
    seedNetAssets(t.db);
    const projectId = await createProject(t.base, t.admin, 'P-CLM-01', '泵站维保项目', t.fx.orgIds.shanghai);
    const supplierId = await createSupplier(t.base, t.admin, 'S-CLM-01', '湘澧机电有限公司');
    const maker = createScopedUser(t.db, { username: 'clm-maker', roleCodes: ['data_maintainer'], orgIds: [t.fx.orgIds.east] }).session;
    const reviewer = createScopedUser(t.db, { username: 'clm-rev', roleCodes: ['business_reviewer'], orgIds: [t.fx.orgIds.east] }).session;
    const doc = async (cid: number, docType: string, name: string, evidenceKind?: string) =>
      (await ok(upload(t.base, maker, `/api/contracts/${cid}/documents`, Buffer.from(`${docType}-${name}`), name, { docType, ...(evidenceKind ? { evidenceKind } : {}) }), 201)).id as number;

    let c = await ok(post(t.base, maker, '/api/contracts', { ...SIGNATORIES,
      contractNo: 'LS-SG-001/2026-010',
      name: '含质保泵站改造施工合同',
      contractType: '工程',
      orgId: t.fx.orgIds.shanghai,
      projectId,
      supplierId,
      originalAmount: '100000.00',
      direction: 'expense',
      pricingMode: 'lump_sum',
      hasWarranty: true,
      warrantyMonths: 12,
      warrantyRetentionRatio: '0.05',
      undertakerName: '张工',
      undertakerDept: '工程部',
      counterpartyNames: '湘澧机电有限公司,湘水安装联合体',
      procurementStartDate: '2026-02-01',
      supplierConfirmDate: '2026-02-15',
      termType: 'fixed',
      termStartDate: '2026-03-01',
      termEndDate: '2026-12-31',
      ourSignatoryName: '李副总',
      ourSignatoryTitle: '副总经理',
      ourSignatoryIsLegalRep: false,
      counterpartySignatoryName: '王经理',
      counterpartySignatoryIsLegalRep: false,
    }), 201);

    await doc(c.id, 'procurement', '定标.pdf', 'bid_award_approval');
    c = await ok(get(t.base, maker, `/api/contracts/${c.id}`));
    c = await ok(post(t.base, maker, `/api/contracts/${c.id}/advance`, { expectedVersion: c.version, toStage: 'procurement' }));
    c = await ok(post(t.base, maker, `/api/contracts/${c.id}/advance`, { expectedVersion: c.version, toStage: 'drafting' }));
    const txtId = await doc(c.id, 'contract_text', '正文.docx');
    c = await ok(get(t.base, maker, `/api/contracts/${c.id}`));
    c = await ok(post(t.base, maker, `/api/contracts/${c.id}/advance`, { expectedVersion: c.version, toStage: 'approval' }));
    c = await ok(post(t.base, maker, `/api/contracts/${c.id}/reviews`, { documentId: txtId }), 201);
    c = await ok(post(t.base, reviewer, `/api/contracts/${c.id}/reviews/${c.reviews[0].id}/decide`, { decision: 'approve' }));
    await doc(c.id, 'signed', '盖章件.pdf');
    c = await ok(get(t.base, maker, `/api/contracts/${c.id}`));
    c = await ok(patch(t.base, maker, `/api/contracts/${c.id}`, { expectedVersion: c.version, signDate: '2026-02-28', effectiveDate: '2026-02-28' }));

    // 任一方非法定代表人且缺对应授权委托书，阻断推进履约
    expect(c.blockers.map((b: { code: string }) => b.code)).toEqual(['OUR_SIGNATORY_AUTH_REQUIRED', 'COUNTERPARTY_SIGNATORY_AUTH_REQUIRED']);
    await fail(post(t.base, maker, `/api/contracts/${c.id}/advance`, { expectedVersion: c.version, toStage: 'performance' }), 409, 'CONTRACT_STAGE_BLOCKED');
    await doc(c.id, 'authorization', '我方授权书.pdf', 'our_signatory_auth');
    await doc(c.id, 'authorization', '对方授权书.pdf', 'counterparty_signatory_auth');
    c = await ok(get(t.base, maker, `/api/contracts/${c.id}`));
    expect(c.blockers).toEqual([]);
    c = await ok(post(t.base, maker, `/api/contracts/${c.id}/advance`, { expectedVersion: c.version, toStage: 'performance' }));

    // 正交分发与承办人交接历史只追加
    c = await ok(post(t.base, maker, `/api/contracts/${c.id}/distribution`, { expectedVersion: c.version, distributedAt: '2026-03-05', companyFiledAt: '2026-03-06' }));
    expect(c.distributionStatus).toBe('completed');
    c = await ok(post(t.base, maker, `/api/contracts/${c.id}/undertaker-handover`, {
      expectedVersion: c.version, toUndertaker: '赵工', toDept: '机电部', reason: '岗位调动', leftPostDate: '2026-03-10', handoverDate: '2026-03-12',
    }));
    expect(c.undertakerName).toBe('赵工');
    expect(c.handovers).toHaveLength(1);
    expect(c.handovers[0]).toMatchObject({ fromUndertaker: '张工', toUndertaker: '赵工', handoverDate: '2026-03-12' });

    // 中止与恢复
    await doc(c.id, 'performance', '履约记录.pdf');
    c = await ok(get(t.base, maker, `/api/contracts/${c.id}`));
    c = await ok(post(t.base, maker, `/api/contracts/${c.id}/suspend`, { expectedVersion: c.version, reason: '汛期停工中止' }));
    expect(c.status).toBe('suspended');
    await fail(post(t.base, maker, `/api/contracts/${c.id}/payments`, { ...PAYMENT_APPROVAL, nodeName: '进度款', amount: '1000.00' }), 409, 'CONTRACT_STATE');
    c = await ok(post(t.base, maker, `/api/contracts/${c.id}/resume`, { expectedVersion: c.version, reason: '恢复施工' }));
    expect(c.status).toBe('active');

    // 推进到 settlement → warranty → closed (含质保合同不可跳过 warranty 直接 closed)
    c = await ok(post(t.base, maker, `/api/contracts/${c.id}/advance`, { expectedVersion: c.version, toStage: 'settlement' }));
    await doc(c.id, 'acceptance', '初验单.pdf');
    c = await ok(get(t.base, maker, `/api/contracts/${c.id}`));
    expect(c.nextStage).toBe('warranty');
    await fail(post(t.base, maker, `/api/contracts/${c.id}/advance`, { expectedVersion: c.version, toStage: 'closed' }), 409, 'CONTRACT_STAGE_BLOCKED');
    c = await ok(patch(t.base, maker, `/api/contracts/${c.id}`, { expectedVersion: c.version, finalAccepted: true }));
    c = await ok(post(t.base, reviewer, `/api/contracts/${c.id}/archive-status`, { expectedVersion: c.version, archiveStatus: 'checked' }));
    c = await ok(post(t.base, maker, `/api/contracts/${c.id}/settlements`, { settlementKind: 'final', settlementDate: '2026-01-01', inContractAmount: '100000.00', deductPenaltyAmount: '100000.00' }), 201);
    c = await ok(post(t.base, reviewer, `/api/contracts/${c.id}/settlements/${c.settlements[0].id}/decide`, { decision: 'approve' }));
    c = await ok(post(t.base, maker, `/api/contracts/${c.id}/advance`, { expectedVersion: c.version, toStage: 'warranty' }));
    expect(c.blockers.map((b: { code: string }) => b.code)).toContain('WARRANTY_VISA_REQUIRED');
    const visa = await doc(c.id, 'settlement', '质保金支付签证表.pdf', 'warranty_release_visa');
    c = await ok(fetchAs(reviewer, `${t.base}/api/contracts/${c.id}/warranty`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ startDate: '2025-01-01', endDate: '2026-01-01', inspectionDate: '2026-01-02', inspectionConclusion: 'passed', visaDocumentId: visa }) }));
    c = await ok(get(t.base, maker, `/api/contracts/${c.id}`));
    c = await ok(post(t.base, reviewer, `/api/contracts/${c.id}/archive-status`, { expectedVersion: c.version, archiveStatus: 'transferred', actionDate: '2026-12-31', transferNo: 'ARC-2026-01' }));
    expect(c.archiveStatus).toBe('transferred');
    c = await ok(post(t.base, maker, `/api/contracts/${c.id}/advance`, { expectedVersion: c.version, toStage: 'closed' }));
    expect(c).toMatchObject({ stage: 'closed', status: 'closed', nextStage: null });
  });

  it('AC-CLM-02/04: 单价合同 0 初始额、以收定支校验、采购时间链与直属电站收入合同主体阻断', async () => {
    const t = await boot('newfc-t10-rules-');
    seedNetAssets(t.db);
    const now = '2026-11-12T00:00:00.000Z';
    const stationOrgId = Number(
      t.db.prepare("INSERT INTO org (parent_id, code, name, sort_order, status, created_at, updated_at) VALUES (?, '0199', '江垭水电站', 99, 'active', ?, ?)")
        .run(t.fx.orgIds.east, now, now).lastInsertRowid,
    );
    const supplierId = await createSupplier(t.base, t.admin, 'S-CLM-02', '湖南电网售电客户');
    const projectId = await createProject(t.base, t.admin, 'P-CLM-02', '年度单价检修项目', t.fx.orgIds.shanghai);

    // 1) 直属电站以二级单位签收入合同 -> 服务端与规则层双重阻断
    await fail(post(t.base, t.admin, '/api/contracts', { ...SIGNATORIES,
      contractNo: 'LS-SR-001/2026-001',
      name: '电站售电进项合同',
      contractType: '销售',
      orgId: stationOrgId,
      supplierId,
      direction: 'income',
      partyRole: 'seller',
      signingEntityLevel: 'secondary_unit',
      isProcurement: false,
      originalAmount: '500000.00',
    }), 409, 'CONTRACT_DIRECT_STATION_ENTITY');

    const incomeContract = await ok(post(t.base, t.admin, '/api/contracts', { ...SIGNATORIES,
      contractNo: 'LS-SR-001/2026-002',
      name: '江垭电站售电进项合同',
      contractType: '销售',
      orgId: stationOrgId,
      supplierId,
      direction: 'income',
      partyRole: 'seller',
      signingEntityLevel: 'company',
      isProcurement: false,
      originalAmount: '500000.00',
    }), 201);
    expect(incomeContract.direction).toBe('income');

    // 规则层阻断校验
    const ruleStation = legalRules({
      c: { ...(incomeContract as unknown as ContractRow), contract_no: 'LS-SR-001/2026-001', original_cents: 50000000n, approved_change_cents: 0n, direction: 'income', legal_category: 'income_sales', party_role: 'seller', signing_entity_level: 'secondary_unit', is_procurement: 0, procurement_target: null, procurement_method: null, is_important: 0 } as ContractRow,
      parsed: parsed(GOOD_TEXT),
      evidence: ['client_written_offer'],
      policies: [],
      orgName: '江垭水电站',
      supplierName: '湖南电网售电客户',
    });
    expect(ruleStation.findings.some((f) => f.code === 'DIRECT_STATION_INCOME_ENTITY' && f.blocking)).toBe(true);

    // 2) 支出合同选收入合同资金来源但未绑定 / 采购时间倒置 -> 阻断
    await fail(post(t.base, t.admin, '/api/contracts', { ...SIGNATORIES,
      contractNo: 'LS-SG-002/2026-001',
      name: '未绑定来源支出',
      orgId: t.fx.orgIds.shanghai,
      fundingSource: 'income_contract',
    }), 400);
    await fail(post(t.base, t.admin, '/api/contracts', { ...SIGNATORIES,
      contractNo: 'LS-SG-002/2026-002',
      name: '采购时间倒置',
      orgId: t.fx.orgIds.shanghai,
      procurementStartDate: '2026-05-10',
      supplierConfirmDate: '2026-05-01',
    }), 400);

    // 3) 单价合同允许 0 初始金额通过 drafting → approval 及法审
    let unit = await ok(post(t.base, t.admin, '/api/contracts', { ...SIGNATORIES,
      contractNo: 'LS-SG-003/2026-001',
      name: '单价检修框架合同',
      contractType: '服务',
      orgId: t.fx.orgIds.shanghai,
      projectId,
      supplierId,
      direction: 'expense',
      pricingMode: 'unit_price',
      unitPriceDesc: '人工 500 元/工日，最高限价 20 万元',
      estimatedCeilingAmount: '200000.00',
      currency: '美元', exchangeRate: '7.00',
      exchangeRate: '7.200000',
      fundingSource: 'income_contract',
      sourceIncomeContractId: incomeContract.id,
      originalAmount: '0.00',
      legalCategory: 'general_service',
      isProcurement: true,
      procurementTarget: 'service',
      procurementMethod: 'inquiry',
    }), 201);
    expect(unit).toMatchObject({ pricingMode: 'unit_price', currency: '美元', exchangeRate: '7.200000', sourceIncomeContractNo: 'LS-SR-001/2026-002' });
    await ok(upload(t.base, t.admin, `/api/contracts/${unit.id}/documents`, Buffer.from('proc'), 'proc.pdf', { docType: 'procurement', evidenceKind: 'bid_award_approval' }), 201);
    unit = await ok(get(t.base, t.admin, `/api/contracts/${unit.id}`));
    unit = await ok(post(t.base, t.admin, `/api/contracts/${unit.id}/advance`, { expectedVersion: unit.version, toStage: 'procurement' }));
    unit = await ok(post(t.base, t.admin, `/api/contracts/${unit.id}/advance`, { expectedVersion: unit.version, toStage: 'drafting' }));
    await ok(upload(t.base, t.admin, `/api/contracts/${unit.id}/documents`, Buffer.from('text'), 'text.docx', { docType: 'contract_text' }), 201);
    unit = await ok(get(t.base, t.admin, `/api/contracts/${unit.id}`));
    unit = await ok(post(t.base, t.admin, `/api/contracts/${unit.id}/advance`, { expectedVersion: unit.version, toStage: 'approval' }));
    expect(unit.stage).toBe('approval');

    // 单价合同法审规则不误报总价为 0 硬伤
    const unitText = GOOD_TEXT
      .replace('LS-SG-001/2026-001', 'LS-SG-003/2026-001')
      .replace('本合同含税总价为人民币壹拾万元整（¥100000.00元），增值税税率为13%。', '本合同含税单价标准为人工 500 元/工日据实结算，最高限价 200000 元，增值税税率为13%。');
    const unitRule = legalRules({
      c: { id: unit.id, contract_no: 'LS-SG-003/2026-001', name: unit.name, original_cents: 0n, approved_change_cents: 0n, pricing_mode: 'unit_price', unit_price_desc: unit.unitPriceDesc, estimated_ceiling_cents: 20000000n, direction: 'expense', legal_category: 'general_service', party_role: 'buyer', signing_entity_level: 'company', is_procurement: 1, procurement_target: 'service', procurement_method: 'inquiry', is_important: 0, sign_date: '2026-11-20', effective_date: '2026-11-20' } as ContractRow,
      parsed: parsed(unitText),
      evidence: ['bid_award_approval'],
      policies: [],
      orgName: '上海公司',
      supplierName: '测试供货公司',
    });
    expect(unitRule.findings.filter((f) => f.blocking)).toEqual([]);

    // 外币不与人民币裸加
    const sum = await ok(get(t.base, t.admin, '/api/contracts/summary'));
    expect(sum.foreignCurrencyCount).toBe(1);
    expect(sum.incomeCurrentAmount).toBe('500000.00');
    expect(sum.currentAmount).toBe('0.00');
  });
});

describe('T-10.3 结算单、双向分级收付闭环与跨模块收支隔离', () => {
  it('AC-CLM-06/07: 结算三栏勾稽、未批变更/未归档拦截、50万/500万分级付款、收入收款闭环与跨模块收支隔离', async () => {
    const t = await boot('newfc-t10-settle-');
    seedNetAssets(t.db);
    const projectId = await createProject(t.base, t.admin, 'P-CLM-03', '大坝加固及发电项目', t.fx.orgIds.shanghai);
    const supplierId = await createSupplier(t.base, t.admin, 'S-CLM-03', '湖南水利建筑公司');
    const maker = createScopedUser(t.db, { username: 'set-maker', roleCodes: ['data_maintainer'], orgIds: [t.fx.orgIds.east] }).session;
    const reviewer = createScopedUser(t.db, { username: 'set-rev', roleCodes: ['business_reviewer'], orgIds: [t.fx.orgIds.east] }).session;
    const doc = async (cid: number, docType: string, name: string, evidenceKind?: string) =>
      (await ok(upload(t.base, maker, `/api/contracts/${cid}/documents`, Buffer.from(`${docType}-${name}`), name, { docType, ...(evidenceKind ? { evidenceKind } : {}) }), 201)).id as number;

    const advanceToPerformance = async (cid: number) => {
      await doc(cid, 'procurement', '定标.pdf', 'bid_award_approval');
      let d = await ok(get(t.base, maker, `/api/contracts/${cid}`));
      d = await ok(post(t.base, maker, `/api/contracts/${cid}/advance`, { expectedVersion: d.version, toStage: 'procurement' }));
      d = await ok(post(t.base, maker, `/api/contracts/${cid}/advance`, { expectedVersion: d.version, toStage: 'drafting' }));
      const txtId = await doc(cid, 'contract_text', '正文.docx');
      d = await ok(get(t.base, maker, `/api/contracts/${cid}`));
      d = await ok(post(t.base, maker, `/api/contracts/${cid}/advance`, { expectedVersion: d.version, toStage: 'approval' }));
      d = await ok(post(t.base, maker, `/api/contracts/${cid}/reviews`, { documentId: txtId }), 201);
      d = await ok(post(t.base, reviewer, `/api/contracts/${cid}/reviews/${d.reviews[0].id}/decide`, { decision: 'approve' }));
      await doc(cid, 'signed', '盖章.pdf');
      d = await ok(get(t.base, maker, `/api/contracts/${cid}`));
      d = await ok(patch(t.base, maker, `/api/contracts/${cid}`, { expectedVersion: d.version, ...SIGNATORIES, signDate: '2026-03-01', effectiveDate: '2026-03-01' }));
      return ok(post(t.base, maker, `/api/contracts/${cid}/advance`, { expectedVersion: d.version, toStage: 'performance' }));
    };

    // 1) 支出总价合同 600 万（含质保，测试 50万 / 500万 分级审批 + 附件 8 结算 + 质保金解锁）
    let exp = await ok(post(t.base, maker, '/api/contracts', { ...SIGNATORIES,
      contractNo: 'LS-SG-001/2026-101',
      name: '大坝除险加固施工合同',
      contractType: '工程',
      orgId: t.fx.orgIds.shanghai,
      projectId,
      supplierId,
      originalAmount: '6000000.00',
      direction: 'expense',
      signingEntityLevel: 'company',
      hasWarranty: true,
      warrantyMonths: 12,
      warrantyRetentionRatio: '0.05',
      reportCategory: 'engineering',
      farmerWageAccount: '6222021900001234567',
      undertakerName: '周工',
    }), 201);
    exp = await advanceToPerformance(exp.id);
    const invDoc = await doc(exp.id, 'invoice', '工程发票.pdf');
    const apprDoc = await doc(exp.id, 'other', '签批会议纪要.pdf', 'payment_approval_form');
    const chgDoc = await doc(exp.id, 'change', '增项签证.pdf');
    const techAudit = await doc(exp.id, 'other', '技术复核.pdf', 'tech_special_audit');

    // 50万/500万分级审批门禁校验
    await fail(post(t.base, maker, `/api/contracts/${exp.id}/payments`, { ...PAYMENT_APPROVAL,
      nodeName: '预付款', paymentType: 'prepayment', amount: '400000.00',
      approvalTier: 'secondary_unit_head', approverName: '张主任', approverTitle: '分部主任',
    }), 409, 'CONTRACT_APPROVAL_TIER_REQUIRED');
    await fail(post(t.base, maker, `/api/contracts/${exp.id}/payments`, { ...PAYMENT_APPROVAL,
      nodeName: '进度大额款', paymentType: 'prepayment', amount: '600000.00',
      approvalTier: 'finance_vp', approverName: '李副总', approverTitle: '财务副总', approvalDocId: apprDoc,
    }), 409, 'CONTRACT_APPROVAL_TIER_REQUIRED');
    await fail(post(t.base, maker, `/api/contracts/${exp.id}/payments`, { ...PAYMENT_APPROVAL,
      nodeName: '大额预付缺批件', paymentType: 'prepayment', amount: '600000.00',
      approvalTier: 'general_manager', approverName: '王总', approverTitle: '总经理',
    }), 409, 'EVIDENCE_REQUIRED');

    // 预付款 60万（>50万，总经理批准+批件）在无结算单时放行
    exp = await ok(post(t.base, maker, `/api/contracts/${exp.id}/payments`, { ...PAYMENT_APPROVAL,
      nodeName: '开工预付款', paymentType: 'prepayment', amount: '600000.00',
      approvalTier: 'general_manager', approverName: '王总', approverTitle: '总经理', approvalDocId: apprDoc,
    }), 201);
    const prepayId = exp.payments[0].id;
    exp = await ok(post(t.base, reviewer, `/api/contracts/${exp.id}/payments/${prepayId}/decide`, { decision: 'approve' }));
    exp = await ok(post(t.base, maker, `/api/contracts/${exp.id}/payments/${prepayId}/pay`, { paidDate: '2026-04-10', voucherNo: '记-0410-01', invoiceDocumentId: invDoc }));
    expect(exp.paidAmount).toBe('600000.00');

    // 含未批变更金额的结算单被硬拦截
    await fail(post(t.base, maker, `/api/contracts/${exp.id}/settlements`, {
      settlementKind: 'progress', settlementDate: '2026-05-10',
      inContractAmount: '500000.00', changeClaimAmount: '100000.00',
    }), 409, 'UNAPPROVED_CHANGE_IN_SETTLEMENT');

    // 批准 +100万 变更后再提交第 1 期进度结算（应结 580万 - 扣预付 60万 - 扣质保 30万 - 扣违约 10万 = 净付 480万）
    exp = await ok(post(t.base, maker, `/api/contracts/${exp.id}/changes`, { ...CHANGE_GOVERNANCE, techSpecialAuditDocId: techAudit, delta: '1000000.00', reason: '增加护坡工程', evidenceDocumentId: chgDoc }), 201);
    exp = await ok(post(t.base, reviewer, `/api/contracts/${exp.id}/changes/${exp.changes[0].id}/decide`, { decision: 'approve' }));
    exp = await ok(post(t.base, maker, `/api/contracts/${exp.id}/settlements`, {
      settlementKind: 'progress', settlementDate: '2026-05-15',
      inContractAmount: '5500000.00', changeClaimAmount: '300000.00', otherAddAmount: '0.00',
      deductPrepaymentAmount: '600000.00', deductRetentionAmount: '300000.00', deductPenaltyAmount: '100000.00',
    }), 201);
    const sid1 = exp.settlements[0].id;
    expect(exp.settlements[0]).toMatchObject({
      periodNo: 1, grossPayableAmount: '5800000.00', totalDeductAmount: '1000000.00', netPayableAmount: '4800000.00', status: 'submitted',
    });
    exp = await ok(post(t.base, reviewer, `/api/contracts/${exp.id}/settlements/${sid1}/decide`, { decision: 'approve' }));
    expect(exp).toMatchObject({ settledGrossAmount: '5800000.00', settledNetAmount: '4800000.00' });

    // 超结算净应付申请被拒
    await fail(post(t.base, maker, `/api/contracts/${exp.id}/payments`, { ...PAYMENT_APPROVAL,
      settlementId: sid1, nodeName: '超额进度款', paymentType: 'progress', amount: '4800000.01',
      approvalTier: 'general_manager', approverName: '王总', approverTitle: '总经理', approvalDocId: apprDoc,
    }), 409, 'CONTRACT_PAYMENT_EXCEEDS_SETTLED');

    // >=500万大额支付门禁（仅总经理审批被拒）与 480万进度款支付
    await fail(post(t.base, maker, `/api/contracts/${exp.id}/payments`, { ...PAYMENT_APPROVAL,
      nodeName: '超500万大额测试', paymentType: 'prepayment', amount: '5000000.00',
      approvalTier: 'general_manager', approverName: '王总', approverTitle: '总经理', approvalDocId: apprDoc,
    }), 409, 'CONTRACT_APPROVAL_TIER_REQUIRED');
    exp = await ok(post(t.base, maker, `/api/contracts/${exp.id}/payments`, { ...PAYMENT_APPROVAL,
      settlementId: sid1, nodeName: '一期进度款', paymentType: 'progress', amount: '4800000.00',
      approvalTier: 'general_manager', approverName: '王总', approverTitle: '总经理', approvalDocId: apprDoc,
      isFarmerWageTransfer: true,
    }), 201);
    const progId = exp.payments.at(-1).id;
    exp = await ok(post(t.base, reviewer, `/api/contracts/${exp.id}/payments/${progId}/decide`, { decision: 'approve' }));
    exp = await ok(post(t.base, maker, `/api/contracts/${exp.id}/payments/${progId}/pay`, { paidDate: '2026-05-20', voucherNo: '记-0520-01', invoiceDocumentId: invDoc }));
    expect(exp.paidAmount).toBe('5400000.00');

    // 最终结算门禁：无验收或档案未验收时拦截
    await doc(exp.id, 'performance', '施工日志.pdf');
    exp = await ok(get(t.base, maker, `/api/contracts/${exp.id}`));
    exp = await ok(post(t.base, maker, `/api/contracts/${exp.id}/advance`, { expectedVersion: exp.version, toStage: 'settlement' }));
    await fail(post(t.base, maker, `/api/contracts/${exp.id}/settlements`, {
      settlementKind: 'final', settlementDate: '2026-06-01', inContractAmount: '100000.00',
    }), 409, 'EVIDENCE_REQUIRED');
    await doc(exp.id, 'acceptance', '竣工验收单.pdf');
    await fail(post(t.base, maker, `/api/contracts/${exp.id}/settlements`, {
      settlementKind: 'final', settlementDate: '2026-06-01', inContractAmount: '100000.00',
    }), 409, 'CONTRACT_ARCHIVE_INCOMPLETE');
    exp = await ok(get(t.base, maker, `/api/contracts/${exp.id}`));
    exp = await ok(post(t.base, reviewer, `/api/contracts/${exp.id}/archive-status`, { expectedVersion: exp.version, archiveStatus: 'checked', actionDate: '2026-06-01' }));
    exp = await ok(post(t.base, maker, `/api/contracts/${exp.id}/settlements`, {
      settlementKind: 'final', settlementDate: '2026-06-02', inContractAmount: '700000.00',
    }), 201);
    exp = await ok(post(t.base, reviewer, `/api/contracts/${exp.id}/settlements/${exp.settlements[1].id}/decide`, { decision: 'approve' }));

    // 质保尾款在无质保签证前拦截，上传签证后在 warranty 阶段支付
    exp = await ok(patch(t.base, maker, `/api/contracts/${exp.id}`, { expectedVersion: exp.version, finalAccepted: true }));
    exp = await ok(post(t.base, maker, `/api/contracts/${exp.id}/advance`, { expectedVersion: exp.version, toStage: 'warranty' }));
    await fail(post(t.base, maker, `/api/contracts/${exp.id}/payments`, { ...PAYMENT_APPROVAL,
      nodeName: '质保尾款', paymentType: 'warranty_release', amount: '300000.00',
      approvalTier: 'finance_vp', approverName: '李副总', approverTitle: '财务副总',
    }), 409, 'WARRANTY_VISA_REQUIRED');
    const visaExp = await doc(exp.id, 'settlement', '质保金支付签证表.pdf', 'warranty_release_visa');
    exp = await ok(fetchAs(reviewer, `${t.base}/api/contracts/${exp.id}/warranty`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ startDate: '2025-01-01', endDate: '2026-01-01', inspectionDate: '2026-01-02', inspectionConclusion: 'passed', visaDocumentId: visaExp }) }));
    exp = await ok(post(t.base, maker, `/api/contracts/${exp.id}/payments`, { ...PAYMENT_APPROVAL,
      nodeName: '质保尾款', paymentType: 'warranty_release', amount: '300000.00',
      approvalTier: 'finance_vp', approverName: '李副总', approverTitle: '财务副总',
    }), 201);
    const retPayId = exp.payments.at(-1).id;
    exp = await ok(post(t.base, reviewer, `/api/contracts/${exp.id}/payments/${retPayId}/decide`, { decision: 'approve' }));
    exp = await ok(post(t.base, maker, `/api/contracts/${exp.id}/payments/${retPayId}/pay`, { paidDate: '2026-06-15', invoiceDocumentId: invDoc }));
    expect(exp.paidAmount).toBe('5700000.00');

    // 2) 收入合同正向收款闭环（禁止走付款申请）与同项目人民币/外币隔离
    let inc = await ok(post(t.base, maker, '/api/contracts', { ...SIGNATORIES,
      contractNo: 'LS-SR-001/2026-102',
      name: '电站上网售电收入合同',
      contractType: '销售',
      orgId: t.fx.orgIds.shanghai,
      projectId,
      supplierId,
      originalAmount: '2000000.00',
      direction: 'income',
      partyRole: 'seller',
      isProcurement: false,
    }), 201);
    inc = await advanceToPerformance(inc.id);
    await fail(post(t.base, maker, `/api/contracts/${inc.id}/payments`, { ...PAYMENT_APPROVAL, nodeName: '误录支出', amount: '100.00' }), 409, 'CONTRACT_DIRECTION_MISMATCH');
    await fail(post(t.base, maker, `/api/contracts/${exp.id}/receipts`, { nodeName: '误录收款', amount: '100.00' }), 409, 'CONTRACT_DIRECTION_MISMATCH');
    const incInv = await doc(inc.id, 'invoice', '售电发票.pdf');
    inc = await ok(post(t.base, maker, `/api/contracts/${inc.id}/receipts`, {
      nodeName: '5月电费结算收款', amount: '1500000.00', plannedDate: '2026-05-25', invoiceDocumentId: incInv,
    }), 201);
    const recId = inc.receipts[0].id;
    inc = await ok(post(t.base, reviewer, `/api/contracts/${inc.id}/receipts/${recId}/decide`, { decision: 'approve' }));
    inc = await ok(post(t.base, maker, `/api/contracts/${inc.id}/receipts/${recId}/receive`, { receivedDate: '2026-05-28', voucherNo: '收-0528-01', invoiceDocumentId: incInv }));
    expect(inc).toMatchObject({ receivedAmount: '1500000.00', receiptRate: '0.750000' });

    // 外币支出合同 100 万美元不混入人民币统计
    let fxCt = await ok(post(t.base, maker, '/api/contracts', { ...SIGNATORIES,
      contractNo: 'LS-SG-001/2026-103',
      name: '进口水轮机备件采购',
      contractType: '货物',
      orgId: t.fx.orgIds.shanghai,
      projectId,
      supplierId,
      originalAmount: '1000000.00',
      currency: '美元', exchangeRate: '7.00',
      direction: 'expense',
    }), 201);
    fxCt = await advanceToPerformance(fxCt.id);
    const fxInv = await doc(fxCt.id, 'invoice', '美元发票.pdf');
    const fxAppr = await doc(fxCt.id, 'other', '采购批件.pdf', 'payment_approval_form');
    fxCt = await ok(post(t.base, maker, `/api/contracts/${fxCt.id}/payments`, { ...PAYMENT_APPROVAL,
      nodeName: '首付款', paymentType: 'prepayment', amount: '600000.00',
      approvalTier: 'general_manager', approverName: '王总', approverTitle: '总经理', approvalDocId: fxAppr,
    }), 201);
    fxCt = await ok(post(t.base, reviewer, `/api/contracts/${fxCt.id}/payments/${fxCt.payments[0].id}/decide`, { decision: 'approve' }));
    await ok(post(t.base, maker, `/api/contracts/${fxCt.id}/payments/${fxCt.payments[0].id}/pay`, { paidDate: '2026-05-29', invoiceDocumentId: fxInv }));

    // 跨模块验证：管理会计指标、项目 360°档案、标准报表、待办口径均严格隔离收入/外币
    expect(contractPaidInPeriod(t.db, [t.fx.orgIds.shanghai], '2026-05')).toBe(480000000n);
    expect(contractPaymentTotals(t.db, [t.fx.orgIds.shanghai])).toEqual({ paid: 570000000n, current: 700000000n });
    expect(contractReceivedInPeriod(t.db, [t.fx.orgIds.shanghai], '2026-05')).toBe(150000000n);
    expect(contractReceiptTotals(t.db, [t.fx.orgIds.shanghai])).toEqual({ received: 150000000n, current: 200000000n });

    const profile = await ok(get(t.base, t.admin, `/api/master/projects/${projectId}/profile`));
    expect(profile.contracts).toMatchObject({
      count: 3,
      expenseCount: 2,
      settledTotal: '5500000.00',
      incomeCount: 1,
      foreignCurrencyCount: 1,
      currentTotal: '7000000.00',
      paidTotal: '5700000.00',
      incomeCurrentTotal: '2000000.00',
      incomeSettledTotal: '0.00',
      receivedTotal: '1500000.00',
      receivedRate: '0.750000',
      activeGuaranteeCount: 0,
      openChangeCount: 0,
      openDisputeCount: 0,
    });

    const ledger = await ok(post(t.base, t.admin, '/api/standard-reports', { reportType: 'contract_payment_ledger', period: '2026-05', orgId: t.fx.orgIds.shanghai }), 201);
    expect(ledger.summary.find((s: { label: string }) => s.label === '本期已付合计')?.value).toBe('4800000.00');
    expect(ledger.summary.find((s: { label: string }) => s.label === '本期实收合计')?.value).toBe('1500000.00');

    const todosMaker = Object.fromEntries((await ok(get(t.base, maker, '/api/dashboard/todos'))).items.map((i: { key: string; count: number }) => [i.key, i.count]));
    expect(todosMaker.contract_distribution).toBe(3);
  });
});
