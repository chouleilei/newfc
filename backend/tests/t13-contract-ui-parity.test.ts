import { describe, expect, it } from 'vitest';
import { saveBusinessSettings } from '../src/modules/settings/business-settings';
import { SIGNATORIES } from './contract-review-fixtures';
import { createScopedUser } from './http-helpers';
import { boot, get, json, post, upload } from './t3-helpers';
import { createProject, createSupplier } from './t4-helpers';

describe('T-13 GAP-18 付款/变更分级同源预览、附件 8 合法负扣款与累计列对齐', () => {
  it('验证 payment-tier-preview 与 submitContractPayment 同源一致、change-tier-preview 随 change_or_mode 切换、保留金退还负扣款放行及负净额阻断', async () => {
    const { base, db, admin, fx } = await boot('newfc-t13-parity-');
    const sh = fx.orgIds.shanghai;
    const rootOrg = fx.orgIds.root;

    const reviewer = createScopedUser(db, {
      username: 'parity-reviewer',
      roleCodes: ['business_reviewer'],
      orgIds: [fx.orgIds.east],
    });

    const projId = await createProject(base, admin, 'P-G18', '结算分级测试项目', sh);
    const supId = await createSupplier(base, admin, 'S-G18', '测试施工单位');

    // 1) 创建以公司名义签署的大额工程合同（进入 performance 阶段）
    const c = await json(
      post(base, admin, '/api/contracts', {
        ...SIGNATORIES,
        contractNo: 'SH-SG-01/2026-88',
        name: '引水隧洞衬砌合同',
        contractType: '工程',
        orgId: sh,
        projectId: projId,
        supplierId: supId,
        originalAmount: '10000000.00',
        direction: 'expense',
        signingEntityLevel: 'company',
        signDate: '2026-03-01',
        effectiveDate: '2026-03-01',
      }),
    );
    db.prepare("UPDATE ct_contract SET stage = 'performance' WHERE id = ?").run(c.id);

    const approvalFormDoc = await json(
      upload(base, admin, `/api/contracts/${c.id}/documents`, Buffer.from('approval-form'), '签批单.pdf', {
        docType: 'other',
        evidenceKind: 'payment_approval_form',
      }),
    );
    const feasDoc = await json(
      upload(base, admin, `/api/contracts/${c.id}/documents`, Buffer.from('feasibility'), '资金可行性.pdf', {
        docType: 'other',
        evidenceKind: 'funding_feasibility',
      }),
    );

    // A. 未配置上年净资产时：即使 40 万元也要求 collective_decision
    saveBusinessSettings(db, { 'contract.prior_year_net_assets': '[]' });
    const pvNoAsset = await json(
      get(base, admin, `/api/contracts/${c.id}/payment-tier-preview?amount=400000.00&plannedDate=2026-06-15`),
    );
    expect(pvNoAsset).toMatchObject({
      requiredTier: 'collective_decision',
      netAssetFound: false,
      onePercentAmount: null,
    });
    const subFailNoAsset = await post(base, admin, `/api/contracts/${c.id}/payments`, {
      nodeName: '首期进度款',
      amount: '400000.00',
      plannedDate: '2026-06-15',
      approvalTier: 'finance_vp',
      approverName: '李副总',
      approverTitle: '财务副总',
      approvalDocId: approvalFormDoc.id,
    });
    expect(subFailNoAsset.status).toBe(409);

    // B. 配置母公司 2025 年净资产为 8000 万元（1% = 80 万元）：
    //    - 40 万元（<= 50万 且 < 80万）-> finance_vp
    //    - 60 万元（> 50万 且 < 80万）-> general_manager
    //    - 90 万元（>= 1% 80万）-> collective_decision
    saveBusinessSettings(db, {
      'contract.prior_year_net_assets': JSON.stringify([{ orgId: rootOrg, year: 2025, amount: '80000000.00' }]),
    });

    const pv40w = await json(
      get(base, admin, `/api/contracts/${c.id}/payment-tier-preview?amount=400000.00&plannedDate=2026-06-15`),
    );
    expect(pv40w).toMatchObject({
      requiredTier: 'finance_vp',
      netAssetFound: true,
      onePercentAmount: '800000.00',
      ceilingAmount: '5000000.00',
    });
    const ok40w = await post(base, admin, `/api/contracts/${c.id}/payments`, {
      nodeName: '首期进度款',
      amount: '400000.00',
      plannedDate: '2026-06-15',
      approvalTier: 'finance_vp',
      approverName: '李副总',
      approverTitle: '财务副总',
    });
    expect(ok40w.status).toBe(201);

    const pv60w = await json(
      get(base, admin, `/api/contracts/${c.id}/payment-tier-preview?amount=600000.00&plannedDate=2026-06-15`),
    );
    expect(pv60w.requiredTier).toBe('general_manager');

    const pv90w = await json(
      get(base, admin, `/api/contracts/${c.id}/payment-tier-preview?amount=900000.00&plannedDate=2026-06-15`),
    );
    expect(pv90w.requiredTier).toBe('collective_decision');
    const fail90wGm = await post(base, admin, `/api/contracts/${c.id}/payments`, {
      nodeName: '超1%进度款',
      amount: '900000.00',
      plannedDate: '2026-06-15',
      approvalTier: 'general_manager',
      approverName: '王总',
      approverTitle: '总经理',
      approvalDocId: approvalFormDoc.id,
      feasibilityDocId: feasDoc.id,
    });
    expect(fail90wGm.status).toBe(409);

    // C. 二级单位自身名义签约合同：< 1% 且 < 500万 时为 secondary_unit_head
    saveBusinessSettings(db, {
      'contract.legal_entity_org_ids': String(sh),
      'contract.prior_year_net_assets': JSON.stringify([
        { orgId: rootOrg, year: 2025, amount: '80000000.00' },
        { orgId: sh, year: 2025, amount: '60000000.00' },
      ]),
    });
    const cSub = await json(
      post(base, admin, '/api/contracts', {
        ...SIGNATORIES,
        contractNo: 'SH-SG-02/2026-89',
        name: '子公司自主运维采购',
        contractType: '服务',
        orgId: sh,
        projectId: projId,
        supplierId: supId,
        originalAmount: '2000000.00',
        direction: 'expense',
        signingEntityLevel: 'secondary_unit',
        signDate: '2026-03-05',
      }),
    );
    const pvSub = await json(
      get(base, admin, `/api/contracts/${cSub.id}/payment-tier-preview?amount=550000.00&plannedDate=2026-06-15`),
    );
    expect(pvSub.requiredTier).toBe('secondary_unit_head');

    // 2) change-tier-preview 与 contract.change_or_mode 动态联动（1000 万基数，变更 +25 万 = 2.5% > 2%，但 > 20万且 <= 50万）
    //    - min（比例与定额双达标：2.5% <= 4% 且 25万 <= 50万）-> dual_vp；若测 +30万（3% > 2%，> 20万）：
    //      测 +15万 但基数 500万（3% > 2%，但 15万 <= 20万）：min 模式下 3% > 2% 不满足第1档 -> dual_vp；max 模式下 15万 <= 20万 满足第1档 -> undertaker_unit！
    const c500w = await json(
      post(base, admin, '/api/contracts', {
        ...SIGNATORIES,
        contractNo: 'SH-SG-03/2026-90',
        name: '五百万变更口径对比合同',
        contractType: '工程',
        orgId: sh,
        projectId: projId,
        supplierId: supId,
        originalAmount: '5000000.00',
        direction: 'expense',
        signDate: '2026-03-10',
      }),
    );
    saveBusinessSettings(db, { 'contract.change_or_mode': 'min' });
    const chgMin = await json(get(base, admin, `/api/contracts/${c500w.id}/change-tier-preview?delta=150000.00`));
    expect(chgMin).toMatchObject({ orMode: 'min', requiredTier: 'dual_vp' });
    expect((await json(get(base, admin, `/api/contracts/${c500w.id}`))).changeOrMode).toBe('min');

    saveBusinessSettings(db, { 'contract.change_or_mode': 'max' });
    const chgMax = await json(get(base, admin, `/api/contracts/${c500w.id}/change-tier-preview?delta=150000.00`));
    expect(chgMax).toMatchObject({ orMode: 'max', requiredTier: 'undertaker_unit' });
    expect((await json(get(base, admin, `/api/contracts/${c500w.id}`))).changeOrMode).toBe('max');

    // 3) 附件 8 结算单：第 1 期扣留质保金 +50,000.00 -> 第 2 期退还保留金（deductRetentionAmount = -20,000.00，合法负扣款）放行并准确计算上期/本年/累计四列，而 netPayable < 0 严格拦截
    const s1Res = await post(base, admin, `/api/contracts/${c.id}/settlements`, {
      settlementKind: 'progress',
      settlementDate: '2025-12-20',
      inContractAmount: '1000000.00',
      changeClaimAmount: '0.00',
      otherAddAmount: '0.00',
      deductPrepaymentAmount: '0.00',
      deductRetentionAmount: '50000.00',
      deductPenaltyAmount: '0.00',
      note: '2025年末第1期结算扣留5万质保金',
    });
    expect(s1Res.status).toBe(201);
    const s1Detail = await json(s1Res);
    await post(base, reviewer.session, `/api/contracts/${c.id}/settlements/${s1Detail.settlements[0].id}/decide`, {
      decision: 'approve',
    });

    // 2026年退还部分质保金（合同内应结 0，扣留质保金 -20000.00 => 应扣小计 -20000.00，本期净应付 +20000.00 >= 0）
    const s2Res = await post(base, admin, `/api/contracts/${c.id}/settlements`, {
      settlementKind: 'progress',
      settlementDate: '2026-06-20',
      inContractAmount: '0.00',
      changeClaimAmount: '0.00',
      otherAddAmount: '0.00',
      deductPrepaymentAmount: '0.00',
      deductRetentionAmount: '-20000.00',
      deductPenaltyAmount: '0.00',
      note: '附件8注2保留金退还负扣款',
    });
    expect(s2Res.status).toBe(201);
    const s2Detail = await json(s2Res);
    expect(s2Detail.settlements).toHaveLength(2);
    expect(s2Detail.settlements[1]).toMatchObject({
      grossPayableAmount: '0.00',
      deductRetentionAmount: '-20000.00',
      totalDeductAmount: '-20000.00',
      netPayableAmount: '20000.00',
      priorGrossAmount: '1000000.00',
      priorTotalDeductAmount: '50000.00',
      priorNetPayableAmount: '950000.00',
      ytdGrossAmount: '0.00',
      ytdTotalDeductAmount: '-20000.00',
      ytdNetPayableAmount: '20000.00',
      cumulativeGrossAmount: '1000000.00',
      cumulativeTotalDeductAmount: '30000.00',
      cumulativeNetPayableAmount: '970000.00',
    });

    // 净应付为负数（如应结 10000，扣款 30000 -> net = -20000）必须 400 阻断
    const negNetRes = await post(base, admin, `/api/contracts/${c.id}/settlements`, {
      settlementKind: 'progress',
      settlementDate: '2026-06-25',
      inContractAmount: '10000.00',
      deductPenaltyAmount: '30000.00',
    });
    expect(negNetRes.status).toBe(400);
  });
});
