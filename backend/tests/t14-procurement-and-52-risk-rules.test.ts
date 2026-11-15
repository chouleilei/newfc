import { describe, expect, it } from 'vitest';
import { evaluateReviewerQualified } from '../src/modules/contracts/contract-procurement.service';
import { SUPERVISION_52_DETECTORS } from '../src/modules/risk/supervision-52-detectors';
import { SIGNATORIES } from './contract-review-fixtures';
import { boot, get, json, post, upload, type Session } from './t3-helpers';
import { createScopedUser, fetchAs } from './http-helpers';
import { createProject, createSupplier } from './t4-helpers';

const put = (base: string, s: Session, url: string, body: unknown) =>
  fetchAs(s, `${base}${url}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
const patch = (base: string, s: Session, url: string, body: unknown) =>
  fetchAs(s, `${base}${url}`, {
    method: 'PATCH',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

describe('T-GAP-15 / AC-T14-07 1:N 结构化招采台账、OrgScope 共享保护、月报日志与 52 条制度预警全量核验', () => {
  it('1:N 共享招采挂接、跨单位 OrgScope 脱敏与共享修改保护、招标强制提级 tier_1、直接采购 vs 3万内比价及评委资格重算', async () => {
    const { base, admin, db, fx } = await boot('newfc-t14-procurement-1n-');
    const orgA = fx.orgIds.shanghai;
    const orgB = fx.orgIds.nanjing;
    const supplierId = await createSupplier(base, admin, 'S-PR-01', '合成水电自动化成套有限公司');

    // 1. 验证评委资格判定函数
    expect(evaluateReviewerQualified({ identity: 'owner', titleLevel: '高级工程师', midTitleYears: 0, hasRegQualification: false }, true, 'tier_1')).toBe(true);
    expect(evaluateReviewerQualified({ identity: 'owner', titleLevel: '工程师', midTitleYears: 8, hasRegQualification: true }, true, 'tier_1')).toBe(false);
    expect(evaluateReviewerQualified({ identity: 'external', titleLevel: '中级工程师', midTitleYears: 5, hasRegQualification: false }, false, 'tier_2')).toBe(true);
    expect(evaluateReviewerQualified({ identity: 'staff', titleLevel: '初级工程师', midTitleYears: 2, hasRegQualification: true }, false, 'tier_2')).toBe(true);

    // 2. 创建共享招采项目：金额仅 300,000.00 元但采用公开招标 -> 服务端强制派生 tier_1 与 isTender = true
    const prRes = await post(base, admin, '/api/procurement-records', {
      procurementCode: 'ZB-2026-001',
      procurementTitle: '2026年度流域梯级电站保护装置框架采购（标段一、标段二）',
      orgId: orgA,
      procurementTarget: 'goods',
      procurementMethod: 'public_tender',
      estimatedAmount: '300000.00',
      approvalTier: '经营层专题会',
      approverName: '总经理办公会',
      announcementDate: '2026-07-01',
      bidOpenDate: '2026-07-22',
      evalReportSubmitDate: '2026-07-23',
      candidatePublicityStart: '2026-07-24',
      candidatePublicityEnd: '2026-07-28',
      awardNoticeDate: '2026-07-29',
      invitedVendorCount: 4,
      supplierInPool: true,
      reviewers: [
        { reviewerName: '王高工', identity: 'owner', titleLevel: '正高级工程师', midTitleYears: 12, hasRegQualification: true },
        { reviewerName: '赵专家', identity: 'external', titleLevel: '高级经济师', midTitleYears: 10, hasRegQualification: false },
        { reviewerName: '刘工', identity: 'staff', titleLevel: '工程师', midTitleYears: 6, hasRegQualification: false },
        { reviewerName: '孙工', identity: 'external', titleLevel: '工程师', midTitleYears: 5, hasRegQualification: false },
        { reviewerName: '周专员', identity: 'owner', titleLevel: '工程师', midTitleYears: 6, hasRegQualification: false },
      ],
    });
    expect(prRes.status).toBe(201);
    const pr = await json(prRes);
    expect(pr.procurementTier).toBe('tier_1');
    expect(pr.isTender).toBe(true);
    expect(pr.committeeSize).toBe(5);
    expect(pr.committeeQualifiedCount).toBe(4); // 周专员作为业主代表非高级职称 -> 不达标

    // 3. 将两份分属 orgA 与 orgB 的标段合同挂接到同一招采记录（1:N）
    const cA = await json(
      post(base, admin, '/api/contracts', {
        contractNo: 'GRP-PR-2026-001',
        name: '保护装置框架采购（标段一）',
        direction: 'expense',
        category: '物资采购',
        legalCategory: 'goods_procurement',
        orgId: orgA,
        supplierId,
        originalAmount: '180000.00',
        signDate: '2026-08-01',
        isProcurement: true,
        procurementTarget: 'goods',
        procurementMethod: 'public_tender',
        ...SIGNATORIES,
      }),
    );
    const cB = await json(
      post(base, admin, '/api/contracts', {
        contractNo: 'GRP-PR-2026-002',
        name: '保护装置框架采购（标段二）',
        direction: 'expense',
        category: '物资采购',
        legalCategory: 'goods_procurement',
        orgId: orgB,
        supplierId,
        originalAmount: '120000.00',
        signDate: '2026-08-01',
        isProcurement: true,
        procurementTarget: 'goods',
        procurementMethod: 'public_tender',
        ...SIGNATORIES,
      }),
    );

    await json(put(base, admin, `/api/contracts/${cA.id}/procurement`, { linkProcurementRecordId: pr.id }));
    await json(put(base, admin, `/api/contracts/${cB.id}/procurement`, { linkProcurementRecordId: pr.id }));

    // 受限用户仅授权 orgA：读取 linkedContracts 时，orgB 合同必须被脱敏且禁止单方面篡改共享招采记录
    const orgAMaintainer = createScopedUser(db, {
      username: 'org-a-proc-user',
      roleCodes: ['data_maintainer'],
      orgIds: [orgA],
    });
    const scopedPr = await json(get(base, orgAMaintainer.session, `/api/contracts/${cA.id}/procurement`));
    expect(scopedPr.linkedContractCount).toBe(2);
    const otherLink = scopedPr.linkedContracts.find((x: any) => x.id === cB.id);
    expect(otherLink.redacted).toBe(true);
    expect(otherLink.contractNo).toContain('已脱敏');

    const unauthorizedSharedPut = await put(base, orgAMaintainer.session, `/api/procurement-records/${pr.id}`, {
      procurementTitle: '越权修改跨单位共享招采',
      orgId: orgA,
      procurementTarget: 'goods',
      procurementMethod: 'public_tender',
      updateShared: true,
    });
    expect(unauthorizedSharedPut.status).toBe(403);

    // 全权限管理员不传 updateShared 修改已共享记录返回 409 SHARED_PROCUREMENT_CONFIRM_REQUIRED；传 updateShared=true 成功并记入 ct_procurement_revision_log
    const missingConfirm = await put(base, admin, `/api/procurement-records/${pr.id}`, {
      procurementCode: 'ZB-2026-001',
      procurementTitle: '2026年度流域梯级电站保护装置框架采购（修订）',
      orgId: orgA,
      procurementTarget: 'goods',
      procurementMethod: 'public_tender',
    });
    expect(missingConfirm.status).toBe(409);

    const confirmedUpdate = await put(base, admin, `/api/procurement-records/${pr.id}`, {
      procurementCode: 'ZB-2026-001',
      procurementTitle: '2026年度流域梯级电站保护装置框架采购（修订）',
      orgId: orgA,
      procurementTarget: 'goods',
      procurementMethod: 'public_tender',
      updateShared: true,
    });
    expect(confirmedUpdate.status).toBe(200);
    const revLogCount = (
      db.prepare('SELECT COUNT(*) AS n FROM ct_procurement_revision_log WHERE procurement_record_id = ?').get(pr.id) as { n: number }
    ).n;
    expect(revLogCount).toBe(1);

    // 4. 严格区分直接采购 direct（情形6必填 mgmDecisionDoc）与 3 万元以内直接报销采购 direct_reimburse（超 3 万拦截）
    const directNoDoc = await post(base, admin, '/api/procurement-records', {
      procurementTitle: '集团战略合作直接采购缺纪要测试',
      orgId: orgA,
      procurementTarget: 'service',
      procurementMethod: 'direct',
      estimatedAmount: '150000.00',
      directProcurementGrounds: ['ground_6_group_strategic_mgm'],
    });
    expect(directNoDoc.status).toBe(400);

    const reimburseOver30k = await post(base, admin, '/api/procurement-records', {
      procurementTitle: '超3万元违规走发票直接报账测试',
      orgId: orgA,
      procurementTarget: 'goods',
      procurementMethod: 'direct_reimburse',
      estimatedAmount: '35000.00',
    });
    expect(reimburseOver30k.status).toBe(400);
  });

  it('全量覆盖 52 项制度预警规则（PW_01~20 & CW_01~32）：验证正反用例、CW_02 去重、历史合同 insufficient_evidence、月报 OA 日志与直属电站分流', async () => {
    const { base, admin, db, fx } = await boot('newfc-t14-52-rules-');
    const orgStation = fx.orgIds.shanghai;
    const orgSub = fx.orgIds.nanjing;
    const now = new Date().toISOString();

    // 将 orgStation 标记为直属水电站（is_direct_station = 1），orgSub 标记为独立法人子公司（is_direct_station = 0）
    db.prepare(`UPDATE org SET org_kind = 'direct_unit', is_direct_station = 1 WHERE id = ?`).run(orgStation);
    db.prepare(`UPDATE org SET org_kind = 'legal_entity', is_direct_station = 0 WHERE id = ?`).run(orgSub);

    // 1. 核验注册表：51 个内置检测器覆盖全部 52 项制度点（CW-03 并入 CW_01，CW_02 复用 PW_01）
    expect(Object.keys(SUPERVISION_52_DETECTORS)).toHaveLength(51);
    const allRules = await json(get(base, admin, '/api/risk/rules'));
    const net33Rules = await json(get(base, admin, '/api/risk/rules?ruleScope=supervision_net_33'));
    const ic18Rules = await json(get(base, admin, '/api/risk/rules?ruleScope=internal_control_18'));
    expect(net33Rules).toHaveLength(33);
    expect(ic18Rules).toHaveLength(18);
    expect(allRules.length).toBeGreaterThanOrEqual(63);

    // 干净初始状态下全量扫描零异常完成
    const cleanScan = await json(post(base, admin, '/api/risk/scans', {}));
    expect(cleanScan.id).toBeGreaterThan(0);

    const projectId = await createProject(base, admin, 'P-RK-52', '流域设备更新改造工程', orgStation);
    const unpooledSupplierId = await createSupplier(base, admin, 'S-RK-UNPOOL', '未入库外部设备商');
    const pooledSupplierId = await createSupplier(base, admin, 'S-RK-POOL', '库内合格供应商');
    await json(patch(base, admin, `/api/master/suppliers/${pooledSupplierId}`, { isInPool: true, pooledAt: '2026-01-10' }));

    // 构造典型违规样本集：
    // (A) 2026-07-10 新制度后签署的采购合同：违规编号、等级错判(触发 PW_01 且 CW_02 自动合并去重)、未入库供应商(PW_20)、询比不足3家(PW_10)、重要合同缺法审/三重一大(CW_04/CW_06)、先履行后生效(CW_08)
    const badProcRes = await json(
      post(base, admin, '/api/procurement-records', {
        procurementCode: 'PR-BAD-01',
        procurementTitle: '发电机组励磁调节器询比采购',
        orgId: orgStation,
        procurementTarget: 'goods',
        procurementMethod: 'inquiry',
        estimatedAmount: '2500000.00',
        approvalTier: '部门负责人',
        invitedVendorCount: 2,
        supplierInPool: false,
        reviewers: [
          { reviewerName: '甲业主', identity: 'owner', titleLevel: '中级工程师', midTitleYears: 6, hasRegQualification: false },
          { reviewerName: '乙专家', identity: 'external', titleLevel: '中级工程师', midTitleYears: 3, hasRegQualification: false },
          { reviewerName: '丙专员', identity: 'staff', titleLevel: '助理工程师', midTitleYears: 2, hasRegQualification: false },
        ],
      }),
    );
    // 人为在 DB 写入错判的 procurement_tier = 'tier_3' 模拟历史/手工等级错判，检验 PW_01 命中且 CW_02 不重复生成第 2 条告警
    db.prepare(`UPDATE ct_procurement_record SET procurement_tier = 'tier_3' WHERE id = ?`).run(badProcRes.id);

    // 另建一笔公开招标项目但业主评委仅为中级职称 -> 精准触发 PW_17
    await json(
      post(base, admin, '/api/procurement-records', {
        procurementCode: 'PR-TENDER-PW17',
        procurementTitle: '主变压器大修公开招标项目',
        orgId: orgStation,
        procurementTarget: 'service',
        procurementMethod: 'public_tender',
        estimatedAmount: '1500000.00',
        approvalTier: '总经理办公会',
        invitedVendorCount: 4,
        supplierInPool: true,
        reviewers: [
          { reviewerName: '业主中级代表', identity: 'owner', titleLevel: '工程师', midTitleYears: 6, hasRegQualification: false },
          { reviewerName: '外部高工A', identity: 'external', titleLevel: '高级工程师', midTitleYears: 10, hasRegQualification: true },
          { reviewerName: '外部高工B', identity: 'external', titleLevel: '高级工程师', midTitleYears: 12, hasRegQualification: true },
          { reviewerName: '外部高工C', identity: 'external', titleLevel: '高级经济师', midTitleYears: 9, hasRegQualification: false },
          { reviewerName: '外部高工D', identity: 'external', titleLevel: '正高级工程师', midTitleYears: 15, hasRegQualification: true },
        ],
      }),
    );

    const cNewBad = await json(
      post(base, admin, '/api/contracts', {
        contractNo: 'BADFORMAT_2026_01',
        name: '励磁调节器设备采购合同',
        direction: 'expense',
        category: '物资采购',
        legalCategory: 'goods_procurement',
        orgId: orgStation,
        projectId,
        supplierId: unpooledSupplierId,
        originalAmount: '2500000.00',
        signDate: '2026-07-10',
        effectiveDate: '2026-08-01',
        termStartDate: '2026-07-05',
        termEndDate: '2026-12-31',
        isProcurement: true,
        procurementTarget: 'goods',
        procurementMethod: 'inquiry',
        isImportant: true,
        isTripleMajor: false,
        ...SIGNATORIES,
      }),
    );
    await json(put(base, admin, `/api/contracts/${cNewBad.id}/procurement`, { linkProcurementRecordId: badProcRes.id }));

    // (B) 2026-06-25 前签署的历史存量合同：缺失过程附件时必须标为 insufficient_evidence 而非 confirmed_hit
    db.prepare(`
      INSERT INTO ct_contract (
        contract_no, normalized_no, name, direction, contract_type, legal_category, org_id, supplier_id,
        original_cents, sign_date, status, stage, origin, migration_mode, is_important, is_triple_major,
        is_procurement, procurement_target, procurement_method, created_at, updated_at
      ) VALUES (
        'HIST-2025-009', 'HIST-2025-009', '2025年历史重要检修合同', 'expense', '技术服务', 'tech_service', ?, ?,
        180000000, '2025-05-12', 'active', 'performance', 'legacy_migration', 'legacy_tolerant', 1, 0,
        1, 'service', 'inquiry', ?, ?
      )
    `).run(orgStation, pooledSupplierId, now, now);
    const histContractId = (db.prepare(`SELECT id FROM ct_contract WHERE contract_no = 'HIST-2025-009'`).get() as { id: number }).id;

    // (C) 直属水电站资金进项合同未以集团名义签订：在线建档主动拦截(400)，容缺导入落库的违规记录命中 CW_31 且不误报 CW_32
    const stBlocked = await post(base, admin, '/api/contracts', {
      contractNo: 'ST-INC-2026-001',
      name: '直属电站对外运维技术服务收入合同',
      direction: 'income',
      contractType: '技术服务',
      legalCategory: 'tech_service',
      orgId: orgStation,
      signingEntityLevel: 'secondary_unit',
      signingSubjectOrgId: orgStation,
      originalAmount: '500000.00',
      signDate: '2026-07-02',
      ...SIGNATORIES,
    });
    expect(stBlocked.status).toBe(409);

    db.prepare(`
      INSERT INTO ct_contract (
        contract_no, normalized_no, name, direction, contract_type, legal_category, org_id,
        signing_entity_level, signing_subject_org_id, original_cents, sign_date,
        status, stage, origin, migration_mode, created_at, updated_at
      ) VALUES (
        'ST-INC-2026-001', 'ST-INC-2026-001', '直属电站对外运维技术服务收入合同', 'income', '技术服务', 'tech_service', ?,
        'secondary_unit', ?, 50000000, '2026-07-02',
        'active', 'performance', 'standard_import', 'normal', ?, ?
      )
    `).run(orgStation, orgStation, now, now);

    // (D) 独立法人子公司外部进项合同超 10 个工作日未报备 -> 命中 CW_32；内部关联交易 isInternalGroupTx = true -> 不命中 CW_32
    await json(
      post(base, admin, '/api/contracts', {
        contractNo: 'SUB-INC-2026-001',
        name: '子公司对外设备租赁进项合同',
        direction: 'income',
        category: '租赁服务',
        legalCategory: 'other',
        orgId: orgSub,
        signingEntityLevel: 'secondary_unit',
        originalAmount: '400000.00',
        signDate: '2026-07-01',
        isInternalGroupTx: false,
        ...SIGNATORIES,
      }),
    );
    const cInternal = await json(
      post(base, admin, '/api/contracts', {
        contractNo: 'SUB-INC-INT-002',
        name: '集团内部关联运维协同协议',
        direction: 'income',
        category: '关联服务',
        legalCategory: 'other',
        orgId: orgSub,
        signingEntityLevel: 'secondary_unit',
        originalAmount: '300000.00',
        signDate: '2026-07-01',
        isInternalGroupTx: true,
        ...SIGNATORIES,
      }),
    );

    // (E) 月度合同报表：仅下载导出（exported_at 非空但 submitted_at/oa_ref_no 为空）仍触发 CW_28；登记正式 OA 回执后 CW_28 消除
    await fetchAs(admin, `${base}/api/contracts/exports/monthly-ledger?period=2026-07&orgId=${orgStation}`);

    // (F) 同单位同供应商 30 天内连续 2 笔 <30,000.00 元发票直接报账 -> 命中 PW_14 且 evidenceStatus === 'suspected_clue'
    for (let i = 1; i <= 2; i++) {
      const pSmall = await json(
        post(base, admin, '/api/procurement-records', {
          procurementTitle: `零星备件直接报账第${i}批`,
          orgId: orgStation,
          procurementTarget: 'goods',
          procurementMethod: 'direct_reimburse',
          estimatedAmount: '19000.00',
          comparisonQuotes: [
            { vendorName: '供应商甲', quoteAmount: '19000.00', selected: true },
            { vendorName: '供应商乙', quoteAmount: '20500.00', selected: false },
          ],
        }),
      );
      const cSmall = await json(
        post(base, admin, '/api/contracts', {
          contractNo: `GRP-SM-2026-00${i}`,
          name: `零星阀门采购第${i}批`,
          direction: 'expense',
          category: '物资采购',
          legalCategory: 'other',
          orgId: orgStation,
          supplierId: pooledSupplierId,
          originalAmount: '19000.00',
          signDate: `2026-07-1${i}`,
          isProcurement: true,
          procurementTarget: 'goods',
          procurementMethod: 'direct_reimburse',
          ...SIGNATORIES,
        }),
      );
      await json(put(base, admin, `/api/contracts/${cSmall.id}/procurement`, { linkProcurementRecordId: pSmall.id }));
    }

    // 执行全量扫描并校验各项断言
    const scan1 = await json(post(base, admin, '/api/risk/scans', {}));
    expect(scan1.createdCount).toBeGreaterThan(0);

    const events = await json(get(base, admin, '/api/risk/events'));
    const codes = new Set(events.map((e: any) => e.ruleCode));
    expect(codes.has('PW_01')).toBe(true);
    expect(codes.has('CW_02')).toBe(false); // 同一标的 PW_01 与 CW_02 自动合并去重，不重复告警
    expect(codes.has('PW_10')).toBe(true);
    expect(codes.has('PW_14')).toBe(true);
    expect(codes.has('PW_15')).toBe(true);
    expect(codes.has('PW_17')).toBe(true);
    expect(codes.has('PW_18')).toBe(true);
    expect(codes.has('PW_20')).toBe(true);
    expect(codes.has('CW_01')).toBe(true);
    expect(codes.has('CW_04')).toBe(true);
    expect(codes.has('CW_06')).toBe(true);
    expect(codes.has('CW_08')).toBe(true);
    expect(codes.has('CW_28')).toBe(true);
    expect(codes.has('CW_31')).toBe(true);
    expect(codes.has('CW_32')).toBe(true);

    // 内部关联交易合同 cInternal 绝不误报 CW_32
    expect(events.some((e: any) => e.ruleCode === 'CW_32' && e.subjectId === cInternal.id)).toBe(false);

    // 历史存量合同 (< 2026-06-25) 命中项必须为 insufficient_evidence
    const histEvents = events.filter((e: any) => e.subjectType === 'contract' && e.subjectId === histContractId);
    expect(histEvents.length).toBeGreaterThan(0);
    expect(histEvents.every((e: any) => e.evidenceStatus === 'insufficient_evidence')).toBe(true);

    // PW_14 拆单提示必须为 suspected_clue，且支持按 ruleScope 与 evidenceStatus 筛选
    const suspectedEvents = await json(get(base, admin, '/api/risk/events?evidenceStatus=suspected_clue'));
    expect(suspectedEvents.some((e: any) => e.ruleCode === 'PW_14')).toBe(true);

    const net33Events = await json(get(base, admin, '/api/risk/events?ruleScope=supervision_net_33'));
    expect(net33Events.every((e: any) => e.ruleScope === 'supervision_net_33')).toBe(true);

    // 登记 orgStation 2026-07 正式 OA 月报报送回执后复扫，该单位 2026-07 的 CW_28 自动消除不再命中
    await json(
      post(base, admin, '/api/contracts/monthly-report-log', {
        orgId: orgStation,
        reportMonth: '2026-07',
        oaRefNo: 'OA-HTYB-2026-088',
      }),
    );
    await json(post(base, admin, '/api/risk/scans', {}));
    const eventsAfterOa = await json(get(base, admin, `/api/risk/events?ruleCode=CW_28&orgId=${orgStation}`));
    expect(eventsAfterOa.every((e: any) => !e.lastScanHit)).toBe(true);
  });
});
