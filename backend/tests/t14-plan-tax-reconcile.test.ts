import { describe, expect, it } from 'vitest';
import {
  WAN_2DEC_HALF_STEP_CENTS,
  WAN_2DEC_STEP_CENTS,
  computeExclTaxFromInclusiveCents,
  verifyMgmtFeeHierarchy,
  verifyVatMaintenanceReconcile,
  verifyWan2DecIssuedStep,
} from '../src/modules/plan-execution/plan-tax-reconcile';
import { boot, json, post } from './t3-helpers';

describe('T-GAP-08 / AC-T14-04 四层数值语义、含税÷1.06 bigint 定点勾稽与五项费用 0.01万元步长校验', () => {
  it('全程使用缩放 bigint 计算含税运维 ÷ 1.06（允差 ≤ 1n），混填含税数入不含税预算时精确阻断', () => {
    expect(WAN_2DEC_STEP_CENTS).toBe(10_000n);
    expect(WAN_2DEC_HALF_STEP_CENTS).toBe(5_000n);

    // 3,000,000.00 元（300,000,000n 分）÷ 1.06 = 2,830,188.68 元（283,018,868n 分）
    const excl3m = computeExclTaxFromInclusiveCents(300_000_000n, 600);
    expect(excl3m).toBe(283_018_868n);

    const okVat = verifyVatMaintenanceReconcile({
      unitOrgId: 1,
      unitName: '集团总部',
      planInclusiveCents: 300_000_000n,
      budgetExclCents: 283_018_868n,
    });
    expect(okVat.passed).toBe(true);
    expect(okVat.blocking).toBe(false);

    // 含税计划扣除跨科目调整项后再校验（如含税 12,720,400.00 / 1.06 = 12,000,377.36，扣除 356,000.00 = 11,644,377.36）
    const okDeducted = verifyVatMaintenanceReconcile({
      unitOrgId: 2,
      unitName: '甲级直属水电枢纽',
      planInclusiveCents: 1_272_040_000n,
      adjustmentDeductionCents: 35_600_000n,
      budgetExclCents: 1_164_437_736n,
    });
    expect(okDeducted.passed).toBe(true);

    // 反例：误将含税 3,000,000.00 元直接填入不含税经营预算 -> 精确拦截 TAX_RECONCILE_MISMATCH
    const badVat = verifyVatMaintenanceReconcile({
      unitOrgId: 1,
      unitName: '集团总部',
      planInclusiveCents: 300_000_000n,
      budgetExclCents: 300_000_000n,
    });
    expect(badVat.passed).toBe(false);
    expect(badVat.blocking).toBe(true);
    expect(badVat.reasonCode).toBe('TAX_RECONCILE_MISMATCH');
  });

  it('校验管理类费用 R17 === R18 + R19 + R20 + R21 嵌套恒等式与责任书可控管理费 0.01万元（10000n）步长进位', async () => {
    // 1. 严格模式精确相等
    const exactMgmt = verifyMgmtFeeHierarchy({
      unitOrgId: 2,
      unitName: '甲级直属水电枢纽',
      r17TotalCents: 980_450_000n,
      r18LaborCents: 620_000_000n,
      r19FiveExpensesCents: 125_450_000n,
      r20ControllableOtherCents: 85_000_000n,
      r21TaxDeprCents: 150_000_000n,
      mode: 'strict_compile',
    });
    expect(exactMgmt.passed).toBe(true);
    expect(exactMgmt.reasonCode).toBe('EXACT_MATCH');

    // 2. 历史兼容模式允许 1 分浮点缓存尾差 SOURCE_FLOAT_CACHE_1C，严格模式则阻断
    const cache1cLegacy = verifyMgmtFeeHierarchy({
      unitOrgId: 3,
      unitName: '清洁能源子公司',
      r17TotalCents: 500_000_001n,
      r18LaborCents: 300_000_000n,
      r19FiveExpensesCents: 80_000_000n,
      r20ControllableOtherCents: 50_000_000n,
      r21TaxDeprCents: 70_000_000n,
      mode: 'legacy_reconcile',
    });
    expect(cache1cLegacy.passed).toBe(true);
    expect(cache1cLegacy.reasonCode).toBe('SOURCE_FLOAT_CACHE_1C');

    const cache1cStrict = verifyMgmtFeeHierarchy({
      unitOrgId: 3,
      unitName: '清洁能源子公司',
      r17TotalCents: 500_000_001n,
      r18LaborCents: 300_000_000n,
      r19FiveExpensesCents: 80_000_000n,
      r20ControllableOtherCents: 50_000_000n,
      r21TaxDeprCents: 70_000_000n,
      mode: 'strict_compile',
    });
    expect(cache1cStrict.passed).toBe(false);
    expect(cache1cStrict.blocking).toBe(true);

    // 3. 目标责任书可控管理费 R19 + R20：精确值 2,104,548.20 元（210,454,820n 分）-> 0.01万元步长四舍五入为 2,104,500.00 元（210,450,000n 分，差 4,820n ≤ 5,000n）
    const stepOk = verifyWan2DecIssuedStep({
      unitOrgId: 2,
      unitName: '甲级直属水电枢纽',
      metricLabel: '可控管理费(R19+R20)',
      exactCalcCents: 210_454_820n,
      approvedIssuedCents: 210_450_000n,
    });
    expect(stepOk.passed).toBe(true);
    expect(stepOk.reasonCode).toBe('DISPLAY_WAN_2DEC_HALF_UP');

    // 反例 1：下达值非 100.00 元（0.01万元）整数倍且不等于精确值 -> STEP_ROUNDING_MISMATCH
    const stepUnaligned = verifyWan2DecIssuedStep({
      unitOrgId: 2,
      unitName: '甲级直属水电枢纽',
      metricLabel: '可控管理费(R19+R20)',
      exactCalcCents: 210_454_820n,
      approvedIssuedCents: 210_454_000n,
    });
    expect(stepUnaligned.passed).toBe(false);
    expect(stepUnaligned.reasonCode).toBe('STEP_ROUNDING_MISMATCH');

    // 反例 2：偏离超过半步长 5,000n（50.00 元）-> STEP_ROUNDING_MISMATCH
    const stepDrift = verifyWan2DecIssuedStep({
      unitOrgId: 2,
      unitName: '甲级直属水电枢纽',
      metricLabel: '可控管理费(R19+R20)',
      exactCalcCents: 210_454_820n,
      approvedIssuedCents: 210_460_000n,
    });
    expect(stepDrift.passed).toBe(false);
    expect(stepDrift.reasonCode).toBe('STEP_ROUNDING_MISMATCH');

    // 4. 集成验证：失衡的周期禁止正式发布
    const { base, admin } = await boot('newfc-t14-tax-block-');
    const cycle = await json(
      post(base, admin, '/api/plan/issuance/cycles', {
        year: 2026,
        cycleCode: 'TAX-IMBALANCE-2026',
        issuanceStage: 'official',
        decisionDocMeta: {
          vatChecks: [
            {
              unitOrgId: 1,
              unitName: '集团总部',
              planInclusiveAmount: '3000000.00',
              budgetExclAmount: '3000000.00',
            },
          ],
          mgmtHierarchyChecks: [
            {
              unitOrgId: 1,
              unitName: '集团总部',
              r17TotalAmount: '1000000.00',
              r18LaborAmount: '500000.00',
              r19FiveExpensesAmount: '200000.00',
              r20ControllableOtherAmount: '100000.00',
              r21TaxDeprAmount: '150000.00',
            },
          ],
        },
      }),
    );
    const rec = await json(post(base, admin, `/api/plan/issuance/cycles/${cycle.id}/reconcile`, {}));
    expect(rec.passed).toBe(false);
    expect(rec.blockingCount).toBe(2);

    const pubBlocked = await post(base, admin, `/api/plan/issuance/cycles/${cycle.id}/publish`, {});
    expect(pubBlocked.status).toBe(409);
  });
});
