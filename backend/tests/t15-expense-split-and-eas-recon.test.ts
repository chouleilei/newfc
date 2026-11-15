import { describe, expect, it } from 'vitest';
import type { DB } from '../src/db/connection';
import { SIGNATORIES } from './contract-review-fixtures';
import { boot, get, json, post, upload, type Session } from './t3-helpers';
import { createScopedUser, fetchAs } from './http-helpers';
import { createProject, createSupplier } from './t4-helpers';

/**
 * T-15 / GAP-20（AC-T15-01 & AC-T15-02）：
 * 1. 报销单挂接合同、服务端权威统计比价附件数、≤30,000.00元缺书面比价预警（EXP_SMALL_PROC_NO_COMPARISON）、
 *    15日连报 2 笔 18,000.00 元同类维修采购费触发拆单预警（EXP_SPLIT_BELOW_30K + ex_split_alert_log + PW_14 线索）；
 * 2. EAS 合同质保金 2241 到期超 30 天未清、供应商往来异常负余额、1604 在建工程遗留与竣工决算对账及只读核对备注登记。
 */

async function ok(res: Response | Promise<Response>, status = 200) {
  const r = await res;
  const body = await json(r);
  expect(r.status, JSON.stringify(body)).toBe(status);
  return body;
}

async function waitClaimAudited(base: string, s: Session, claimId: number, expectedRuns = 1) {
  for (let i = 0; i < 120; i += 1) {
    const detail = await ok(get(base, s, `/api/expense/claims/${claimId}`));
    if (detail.runs.length >= expectedRuns && detail.status !== 'submitted') return detail;
    await new Promise((r) => setTimeout(r, 40));
  }
  throw new Error(`报销单 #${claimId} 未在预期时间内完成审核运行`);
}

let fileSeq = 0;
function seedFileObject(db: DB, name: string): number {
  fileSeq += 1;
  const sha = `b8${String(fileSeq).padStart(4, '0')}`.padEnd(64, '0');
  return Number(
    db.prepare('INSERT INTO file_object (sha256, size_bytes, original_name, created_at) VALUES (?, 64, ?, ?)')
      .run(sha, name, '2026-06-30T00:00:00.000Z').lastInsertRowid
  );
}

describe('T-15 / GAP-20 报销小额比价拆单预警与 EAS 遗留对账（AC-T15-01, AC-T15-02）', () => {
  it('AC-T15-01：服务端自动统计比价附件，检出 ≤3万元缺书面比价与 15 日内 2×18,000.00 元拆单并联动 PW_14 风险线索', async () => {
    const { base, db, admin, fx } = await boot('newfc-t15-exp-split-');
    const sh = fx.orgIds.shanghai;
    const hz = fx.orgIds.hangzhou;
    const maker = createScopedUser(db, { username: 't15-exp-maker', roleCodes: ['data_maintainer'], orgIds: [fx.orgIds.east] }).session;
    const reviewer = createScopedUser(db, { username: 't15-exp-rev', roleCodes: ['business_reviewer'], orgIds: [fx.orgIds.east] }).session;
    const westMaker = createScopedUser(db, { username: 't15-west-maker', roleCodes: ['data_maintainer'], orgIds: [fx.orgIds.west] }).session;

    await ok(post(base, admin, '/api/expense/policies', {
      code: 'FIN-MAINT-2026',
      title: '零星维修及小额采购报销规范',
      effectiveFrom: '2026-01-01',
      clauses: [
        {
          clauseNo: '8.1.7',
          clauseText: '3万元（含）以内采购直接报销应形成书面市场比价报告，禁止拆分规避集中采购。',
          expenseTypes: ['设备维修费'],
          limit: '30000.00',
          requiredKeywords: [],
        },
      ],
    }), 201);

    const shCt = await ok(post(base, maker, '/api/contracts', {
      ...SIGNATORIES,
      contractNo: 'HT-T15-SH-01',
      externalNoExempt: true,
      name: '合成泵站年度零星维保框架',
      orgId: sh,
      originalAmount: '90000.00',
    }), 201);
    const westCt = await ok(post(base, westMaker, '/api/contracts', {
      ...SIGNATORIES,
      contractNo: 'HT-T15-WEST-01',
      externalNoExempt: true,
      name: '西部片区维保合同',
      orgId: fx.orgIds.west,
      originalAmount: '50000.00',
    }), 201);

    // 越权挂接范围外合同返回 404
    const crossScopeRes = await post(base, maker, '/api/expense/claims', {
      orgId: sh,
      applicant: '李工',
      department: '运维部',
      expenseType: '设备维修费',
      amount: '12000.00',
      occurredDate: '2026-06-01',
      description: '越权测试',
      contractId: westCt.id,
      isProcurementExpense: true,
      lines: [{ expenseType: '设备维修费', amount: '12000.00', invoiceNo: 'INV-X1', invoiceDate: '2026-06-01' }],
    });
    expect(crossScopeRes.status).toBe(404);

    // 第 1 笔：18,000.00 元采购维修报销，初始未传比价报告 -> 触发 EXP_SMALL_PROC_NO_COMPARISON
    let claim1 = await ok(post(base, maker, '/api/expense/claims', {
      orgId: sh,
      applicant: '李工',
      department: '运维部',
      expenseType: '设备维修费',
      amount: '18000.00',
      occurredDate: '2026-06-05',
      description: '一号机组阀门更换零星采购维修',
      contractId: shCt.id,
      isProcurementExpense: true,
      lines: [{ expenseType: '设备维修费', amount: '18000.00', invoiceNo: 'INV-T15-01', invoiceDate: '2026-06-05', description: '阀门配件及人工' }],
    }), 201);
    expect(claim1).toMatchObject({
      contractId: shCt.id,
      contractNo: 'HT-T15-SH-01',
      isProcurementExpense: true,
      priceCompareDocCount: 0,
      splitAlertHit: false,
    });

    // 上传再移除比价附件：验证服务端权威重算 priceCompareDocCount
    const tempAtt = await ok(
      upload(base, maker, `/api/expense/claims/${claim1.id}/attachments`, Buffer.from('三家市场询价比选表'), '三家市场比价报告.pdf', {
        kindHint: 'price_comparison',
      }),
      201
    );
    claim1 = await ok(get(base, maker, `/api/expense/claims/${claim1.id}`));
    expect(claim1.priceCompareDocCount).toBe(1);

    const delRes = await fetchAs(maker, `${base}/api/expense/claims/${claim1.id}/attachments/${tempAtt.id}`, { method: 'DELETE' });
    expect(delRes.status).toBe(200);
    claim1 = await json(delRes);
    expect(claim1.priceCompareDocCount).toBe(0);

    // 未传比价附件直接送审 claim1 -> 命中 EXP_SMALL_PROC_NO_COMPARISON，尚不触发拆单
    await ok(post(base, maker, `/api/expense/claims/${claim1.id}/submit`, { expectedReviewVersion: claim1.reviewVersion }));
    claim1 = await waitClaimAudited(base, maker, claim1.id, 1);
    const run1Codes = claim1.runs[0].findings.map((f: { code: string }) => f.code);
    expect(run1Codes).toContain('EXP_SMALL_PROC_NO_COMPARISON');
    expect(run1Codes).not.toContain('EXP_SPLIT_BELOW_30K');
    expect(claim1.missingComparisonAlert).toBe(true);

    // 第 2 笔：同组织 15 日内（2026-06-18）再报 18,000.00 元同类维修费，且已附书面比价报告
    // 累计 36,000.00 元 >= 30,000.00 元 -> 不报缺比价，但精准触发 EXP_SPLIT_BELOW_30K + ex_split_alert_log + PW_14 线索！
    let claim2 = await ok(post(base, maker, '/api/expense/claims', {
      orgId: sh,
      applicant: '王工',
      department: '运维部',
      expenseType: '设备维修费',
      amount: '18000.00',
      occurredDate: '2026-06-18',
      description: '二号机组同批次阀门更换采购维修',
      contractId: shCt.id,
      isProcurementExpense: true,
      lines: [{ expenseType: '设备维修费', amount: '18000.00', invoiceNo: 'INV-T15-02', invoiceDate: '2026-06-18', description: '同型阀门采购维修' }],
    }), 201);
    await ok(
      upload(base, maker, `/api/expense/claims/${claim2.id}/attachments`, Buffer.from('书面市场比价单'), '阀门市场比价报告.pdf', {
        kindHint: 'price_comparison',
      }),
      201
    );
    claim2 = await ok(get(base, maker, `/api/expense/claims/${claim2.id}`));
    expect(claim2.priceCompareDocCount).toBe(1);

    await ok(post(base, maker, `/api/expense/claims/${claim2.id}/submit`, { expectedReviewVersion: claim2.reviewVersion }));
    claim2 = await waitClaimAudited(base, maker, claim2.id, 1);
    const run2Codes = claim2.runs[0].findings.map((f: { code: string }) => f.code);
    expect(run2Codes).not.toContain('EXP_SMALL_PROC_NO_COMPARISON');
    expect(run2Codes).toContain('EXP_SPLIT_BELOW_30K');
    expect(claim2.splitAlertHit).toBe(true);
    expect(claim2.splitRiskEventId).toEqual(expect.any(Number));

    const splitLogs = db.prepare('SELECT * FROM ex_split_alert_log WHERE org_id = ?').safeIntegers(true).all(sh) as Record<string, unknown>[];
    expect(splitLogs).toHaveLength(1);
    expect(Number(splitLogs[0].claim_count)).toBe(2);
    expect(BigInt(splitLogs[0].total_cents as bigint)).toBe(3_600_000n);

    const riskEvent = db.prepare("SELECT rule_code, evidence_status, amount_cents FROM risk_event WHERE id = ?")
      .safeIntegers(true)
      .get(claim2.splitRiskEventId) as { rule_code: string; evidence_status: string; amount_cents: bigint };
    expect(riskEvent).toEqual({
      rule_code: 'PW_14',
      evidence_status: 'suspected_clue',
      amount_cents: 3_600_000n,
    });

    // 若在另一组织（hz）单报 1 笔被驳回的 18,000.00 元 + 1 笔有效 18,000.00 元，已驳回废单不计入拆单累计
    let rejClaim = await ok(post(base, maker, '/api/expense/claims', {
      orgId: hz,
      applicant: '赵工',
      department: '工程部',
      expenseType: '设备维修费',
      amount: '18000.00',
      occurredDate: '2026-06-02',
      description: '测试驳回排除',
      isProcurementExpense: true,
      lines: [{ expenseType: '设备维修费', amount: '18000.00', invoiceNo: 'INV-HZ-1', invoiceDate: '2026-06-02' }],
    }), 201);
    await ok(post(base, maker, `/api/expense/claims/${rejClaim.id}/submit`, { expectedReviewVersion: rejClaim.reviewVersion }));
    rejClaim = await waitClaimAudited(base, maker, rejClaim.id, 1);
    await ok(post(base, reviewer, `/api/expense/claims/${rejClaim.id}/review`, {
      expectedReviewVersion: rejClaim.reviewVersion,
      runId: rejClaim.runs[0].id,
      conclusion: 'reject',
      dispositions: rejClaim.runs[0].findings.map((f: { id: number }) => ({ findingId: f.id, disposition: 'confirmed' })),
      comment: '单据作废驳回',
    }));

    let hzValid = await ok(post(base, maker, '/api/expense/claims', {
      orgId: hz,
      applicant: '赵工',
      department: '工程部',
      expenseType: '设备维修费',
      amount: '18000.00',
      occurredDate: '2026-06-10',
      description: '正常单笔维修',
      isProcurementExpense: true,
      lines: [{ expenseType: '设备维修费', amount: '18000.00', invoiceNo: 'INV-HZ-2', invoiceDate: '2026-06-10' }],
    }), 201);
    await ok(post(base, maker, `/api/expense/claims/${hzValid.id}/submit`, { expectedReviewVersion: hzValid.reviewVersion }));
    hzValid = await waitClaimAudited(base, maker, hzValid.id, 1);
    expect(hzValid.runs[0].findings.map((f: { code: string }) => f.code)).not.toContain('EXP_SPLIT_BELOW_30K');
  });

  it('AC-T15-02：EAS 2241 质保到期超 30 天未清、往来负余额、1604 在建工程遗留对账及只读核对备注保存', async () => {
    const { base, db, admin, fx } = await boot('newfc-t15-eas-recon-');
    const sh = fx.orgIds.shanghai;
    const viewer = createScopedUser(db, { username: 't15-eas-viewer', roleCodes: ['viewer'], orgIds: [sh] }).session;
    const maintainer = createScopedUser(db, { username: 't15-eas-maint', roleCodes: ['data_maintainer'], orgIds: [sh] }).session;
    const westViewer = createScopedUser(db, { username: 't15-eas-west', roleCodes: ['viewer'], orgIds: [fx.orgIds.west] }).session;

    const prjWarranty = await createProject(base, admin, 'PRJ-W2241', '一号闸门除险工程', sh);
    const prjCipDone = await createProject(base, admin, 'PRJ-CIP-01', '二号电站增效扩容工程', sh);
    const supAlpha = await createSupplier(base, admin, 'SUP-ALPHA', '合成水工装备有限公司');
    const supNeg = await createSupplier(base, admin, 'SUP-NEG', '合成机电物资商行');

    // 1) 创建已签证通过且距 2026-06-30 超 30 天的质保合同（inspection_date = 2026-04-15，超期 76 天）
    const ctWarranty = await ok(post(base, maintainer, '/api/contracts', {
      ...SIGNATORIES,
      contractNo: 'HT-W2241-001',
      externalNoExempt: true,
      name: '闸门更换施工合同',
      orgId: sh,
      projectId: prjWarranty,
      supplierId: supAlpha,
      counterpartyName: '合成水工装备有限公司',
      originalAmount: '1000000.00',
    }), 201);
    db.prepare(
      `INSERT INTO ct_warranty (contract_id, start_date, end_date, retention_cents, inspection_date, inspection_conclusion, created_at, updated_at)
       VALUES (?, '2025-04-01', '2026-04-01', 5000000, '2026-04-15', 'passed', '2026-04-15T00:00:00Z', '2026-04-15T00:00:00Z')`
    ).run(ctWarranty.id);

    // 2) 创建已确认竣工决算版本的投控项目（对应 EAS 编码映射 OLD-BJ-002 -> prjCipDone）
    db.prepare(
      `INSERT INTO md_code_mapping (source_system, entity_type, match_kind, source_key, source_label, target_id, valid_from, created_at)
       VALUES ('eas', 'project', 'code', 'OLD-BJ-002', '历史在建工程辅助码', ?, '2020-01-01', '2026-01-01T00:00:00Z')`
    ).run(prjCipDone);
    const icPid = Number(
      db.prepare(
        `INSERT INTO ic_project (md_project_id, org_id, approved_cents, status, created_at, updated_at)
         VALUES (?, ?, 1500000000, 'active', '2026-01-01T00:00:00Z', '2026-05-01T00:00:00Z')`
      ).run(prjCipDone, sh).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO ic_version (project_id, version_type, version_no, name, status, is_current, static_cents, dynamic_cents, approval_date, created_at, updated_at)
       VALUES (?, 'final_account', 1, '竣工决算审定版', 'confirmed', 1, 1250000000, 1250000000, '2026-03-20', '2026-03-20T00:00:00Z', '2026-03-20T00:00:00Z')`
    ).run(icPid);

    // 3) 写入当前激活的 EAS 2026-06 余额批次与凭证批次
    const balBatchId = Number(
      db.prepare(
        `INSERT INTO eas_batch (data_type, org_id, source_company, period, file_object_id, file_sha256, file_name, row_count, debit_total_cents, credit_total_cents, status, is_current, parser_version, created_at)
         VALUES ('balance', ?, '测试水电公司', '2026-06', ?, 'sha-t15-bal', 'bal-202606.xlsx', 4, 0, 0, 'active', 1, 'v1', '2026-06-30T00:00:00Z')`
      ).run(sh, seedFileObject(db, 'bal.xlsx')).lastInsertRowid
    );
    const insBal = db.prepare(
      `INSERT INTO eas_balance_line (batch_id, source_row, account_code, account_name, begin_debit_cents, begin_credit_cents, debit_cents, credit_cents, end_debit_cents, end_credit_cents, project_code, project_name, supplier_name)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    // 224101 应付质保金贷方余额 50,000.00 元（5,000,000 分）未清
    insBal.run(balBatchId, 2, '224101', '其他应付款-质保金', 0, 5_000_000, 0, 0, 0, 5_000_000, 'PRJ-W2241', '一号闸门除险工程', '合成水工装备有限公司');
    // 220201 应付账款借方大于贷方 -> 异常负余额 -15,000.00 元
    insBal.run(balBatchId, 3, '220201', '应付账款-工程物资', 1_500_000, 0, 0, 0, 1_500_000, 0, null, null, '合成机电物资商行');
    // 160401 在建工程已竣工决算仍挂账 12,500,000.00 元（1,250,000,000 分）
    insBal.run(balBatchId, 4, '160401', '在建工程-建筑安装工程', 1_250_000_000, 0, 0, 0, 1_250_000_000, 0, 'OLD-BJ-002', '二号电站增效扩容', null);
    // 160402 在建工程长期静止零发生遗留 860,000.00 元
    insBal.run(balBatchId, 5, '160402', '在建工程-待摊投资', 86_000_000, 0, 0, 0, 86_000_000, 0, 'LEGACY-CIP-99', '早期遗留技改工程', null);

    const vouBatchId = Number(
      db.prepare(
        `INSERT INTO eas_batch (data_type, org_id, source_company, period, file_object_id, file_sha256, file_name, row_count, debit_total_cents, credit_total_cents, status, is_current, parser_version, created_at)
         VALUES ('voucher', ?, '测试水电公司', '2026-06', ?, 'sha-t15-vou', 'vou-202606.xlsx', 1, 5000000, 5000000, 'active', 1, 'v1', '2026-06-30T00:00:00Z')`
      ).run(sh, seedFileObject(db, 'vou.xlsx')).lastInsertRowid
    );
    db.prepare(
      `INSERT INTO eas_voucher_line (batch_id, source_row, voucher_date, voucher_no, entry_no, account_code, account_name, summary, debit_cents, credit_cents, project_code, supplier_name)
       VALUES (?, 2, '2026-06-15', '记-0088', '1', '224101', '其他应付款-质保金', '质保金挂账', 0, 5000000, 'PRJ-W2241', '合成水工装备有限公司')`
    ).run(vouBatchId);

    // 范围外组织查询返回 404
    expect((await get(base, westViewer, `/api/eas/contract-recon?orgId=${sh}&period=2026-06`)).status).toBe(404);

    // viewer 可只读查询全部 4 条异常项
    const recon = await ok(get(base, viewer, `/api/eas/contract-recon?orgId=${sh}&period=2026-06`));
    expect(recon.hasActiveBalanceBatch).toBe(true);
    expect(recon.summary).toMatchObject({
      totalCount: 4,
      unresolvedCount: 4,
      byCategory: {
        warranty_2241_overdue: { count: 1, totalAbsAmount: '50000.00' },
        supplier_negative_balance: { count: 1, totalAbsAmount: '15000.00' },
        cip_1604_legacy: { count: 2, totalAbsAmount: '13360000.00' },
      },
    });

    const wItem = recon.items.find((i: any) => i.category === 'warranty_2241_overdue');
    expect(wItem).toMatchObject({
      contractId: ctWarranty.id,
      contractNo: 'HT-W2241-001',
      bookBalance: '50000.00',
      overdueDays: 76,
      reconStatus: 'pending',
      voucherRefs: ['记-0088'],
    });

    const negItem = recon.items.find((i: any) => i.category === 'supplier_negative_balance');
    expect(negItem).toMatchObject({
      accountCode: '220201',
      supplierId: supNeg,
      bookBalance: '-15000.00',
    });

    const cipDoneItem = recon.items.find((i: any) => i.targetKey === '1604:OLD-BJ-002:160401');
    expect(cipDoneItem).toMatchObject({
      projectId: prjCipDone,
      bookBalance: '12500000.00',
    });
    expect(cipDoneItem.statusSummary).toContain('竣工决算确认');

    // viewer 无 eas:import 权限，写备注被拒 403
    const forbiddenNote = await post(base, viewer, '/api/eas/contract-recon/notes', {
      orgId: sh,
      period: '2026-06',
      category: 'warranty_2241_overdue',
      targetKey: wItem.targetKey,
      reconStatus: 'to_writeoff',
      voucherRef: '记-0088',
      note: '已通知工程部提交质保结清审批单',
    });
    expect(forbiddenNote.status).toBe(403);

    // maintainer 幂等保存核对备注，且验证原始 eas_balance_line 零修改
    const beforeBalSnap = db.prepare('SELECT end_credit_cents, end_debit_cents FROM eas_balance_line WHERE batch_id = ? ORDER BY id').safeIntegers(true).all(balBatchId);
    const savedNote = await ok(post(base, maintainer, '/api/eas/contract-recon/notes', {
      orgId: sh,
      period: '2026-06',
      category: 'warranty_2241_overdue',
      targetKey: wItem.targetKey,
      reconStatus: 'resolved',
      voucherRef: '记-202607-0012',
      note: '已在次月第 12 号凭证冲销支付完毕',
    }), 201);
    expect(savedNote).toMatchObject({
      reconStatus: 'resolved',
      voucherRef: '记-202607-0012',
    });
    const afterBalSnap = db.prepare('SELECT end_credit_cents, end_debit_cents FROM eas_balance_line WHERE batch_id = ? ORDER BY id').safeIntegers(true).all(balBatchId);
    expect(afterBalSnap).toEqual(beforeBalSnap);

    // unresolvedOnly=true 自动排除已结清项
    const unresolved = await ok(get(base, viewer, `/api/eas/contract-recon?orgId=${sh}&period=2026-06&unresolvedOnly=true`));
    expect(unresolved.summary.unresolvedCount).toBe(3);
    expect(unresolved.items).toHaveLength(3);
  });
});
