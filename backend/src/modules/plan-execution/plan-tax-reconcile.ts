/**
 * T-14 / GAP-08: 综合计划（含税）↔ 经营预算（不含税 ÷ 1.06）与五项费用/可控管理费嵌套勾稽引擎。
 *
 * 严格遵守 docs/money-contract.md：
 * - 全程使用 bigint 整数分（_cents）运算，禁止 Number 浮点参与金融计算；
 * - 公文与目标责任书两位小数万元步长为 0.01万元 = 100.00元 = 10,000分（10000n），
 *   单次 ROUND_HALF_UP 半步长理论上界 <= 5000n（50.00元），严禁与 100n（1.00元）混淆。
 */
import { centsToDecimalString, roundHalfUpDiv, roundHalfUpStep } from '../../core/decimal';
import type { PlanTaxCheckItemDto } from '../../contracts/plan-execution';

export const WAN_2DEC_STEP_CENTS = 10_000n;
export const WAN_2DEC_HALF_STEP_CENTS = 5_000n;
export const DEFAULT_MAINTENANCE_VAT_BP = 600; // 6.00% -> 10000 / 10600 === 100 / 106

/**
 * 含税金额（分）按给定增值税率基点（默认 600bp = 6%）折算不含税预算金额（分）：
 * roundHalfUpDiv(amountCents * 10000n, 10000n + BigInt(vatRateBp))
 * 当 vatRateBp = 600 时等价于 roundHalfUpDiv(amountCents * 100n, 106n)。
 */
export function computeExclTaxFromInclusiveCents(taxInclusiveCents: bigint, vatRateBp = DEFAULT_MAINTENANCE_VAT_BP): bigint {
  if (vatRateBp < 0 || !Number.isInteger(vatRateBp)) {
    throw new Error(`非法增值税率基点: ${vatRateBp}`);
  }
  if (vatRateBp === 600) {
    return roundHalfUpDiv(taxInclusiveCents * 100n, 106n);
  }
  return roundHalfUpDiv(taxInclusiveCents * 10_000n, 10_000n + BigInt(vatRateBp));
}

export interface VatMaintenanceCheckInput {
  unitOrgId: number | null;
  unitName: string;
  planInclusiveCents: bigint;
  budgetExclCents: bigint;
  /** 经核备的不含税调整扣减项（分，正数表示从税后额扣减，如专项调出项） */
  adjustmentDeductionCents?: bigint;
  vatRateBp?: number;
}

/** 校验含税运维计划与不含税营业成本预算（扣除核定调整项后单笔允差 <= 1n 即 0.01元）。 */
export function verifyVatMaintenanceReconcile(input: VatMaintenanceCheckInput): PlanTaxCheckItemDto {
  const vatRateBp = input.vatRateBp ?? DEFAULT_MAINTENANCE_VAT_BP;
  const rawExcl = computeExclTaxFromInclusiveCents(input.planInclusiveCents, vatRateBp);
  const deduction = input.adjustmentDeductionCents ?? 0n;
  const expectedExcl = rawExcl - deduction;
  const diff = input.budgetExclCents - expectedExcl;
  const absDiff = diff < 0n ? -diff : diff;
  const passed = absDiff <= 1n;
  return {
    unitOrgId: input.unitOrgId,
    unitName: input.unitName,
    kind: 'vat_maintenance',
    passed,
    blocking: !passed,
    planInclusiveAmount: centsToDecimalString(input.planInclusiveCents),
    expectedBudgetExclAmount: centsToDecimalString(expectedExcl),
    actualBudgetExclAmount: centsToDecimalString(input.budgetExclCents),
    diffAmount: centsToDecimalString(diff),
    reasonCode: passed ? (diff === 0n ? 'EXACT_MATCH' : 'VAT_ROUND_1C') : 'TAX_RECONCILE_MISMATCH',
    message: passed
      ? `${input.unitName}含税运维计划（${centsToDecimalString(input.planInclusiveCents)}元）折算不含税预算（${centsToDecimalString(expectedExcl)}元）核对通过`
      : `${input.unitName}不含税预算值（${centsToDecimalString(input.budgetExclCents)}元）与含税计划除税预期值（${centsToDecimalString(expectedExcl)}元）偏差 ${centsToDecimalString(diff)}元，超过 0.01元允差（疑似混填含税数或漏计调整项）`,
  };
}

export interface MgmtHierarchyCheckInput {
  unitOrgId: number | null;
  unitName: string;
  r17TotalCents: bigint;
  r18LaborCents: bigint;
  r19FiveExpensesCents: bigint;
  r20ControllableOtherCents: bigint;
  r21TaxDeprCents: bigint;
  mode: 'strict_compile' | 'legacy_reconcile';
}

/**
 * 校验管理类费用刚性嵌套恒等式：R17 === R18 + R19 + R20 + R21。
 * - strict_compile：要求 0n 误差；
 * - legacy_reconcile：对历史源表 1n（0.01元）浮点缓存差显式标记 SOURCE_FLOAT_CACHE_1C，超 1n 仍阻断。
 */
export function verifyMgmtFeeHierarchy(input: MgmtHierarchyCheckInput): PlanTaxCheckItemDto {
  const sumParts = input.r18LaborCents + input.r19FiveExpensesCents + input.r20ControllableOtherCents + input.r21TaxDeprCents;
  const diff = input.r17TotalCents - sumParts;
  const absDiff = diff < 0n ? -diff : diff;
  if (diff === 0n) {
    return {
      unitOrgId: input.unitOrgId,
      unitName: input.unitName,
      kind: 'mgmt_fee_nested',
      passed: true,
      blocking: false,
      planInclusiveAmount: null,
      expectedBudgetExclAmount: centsToDecimalString(sumParts),
      actualBudgetExclAmount: centsToDecimalString(input.r17TotalCents),
      diffAmount: '0.00',
      reasonCode: 'EXACT_MATCH',
      message: `${input.unitName}管理费用嵌套恒等式 R17 = R18 + R19 + R20 + R21 精确闭合（0.00元误差）`,
    };
  }
  if (input.mode === 'legacy_reconcile' && absDiff === 1n) {
    return {
      unitOrgId: input.unitOrgId,
      unitName: input.unitName,
      kind: 'mgmt_fee_nested',
      passed: true,
      blocking: false,
      planInclusiveAmount: null,
      expectedBudgetExclAmount: centsToDecimalString(sumParts),
      actualBudgetExclAmount: centsToDecimalString(input.r17TotalCents),
      diffAmount: centsToDecimalString(diff),
      reasonCode: 'SOURCE_FLOAT_CACHE_1C',
      message: `${input.unitName}历史源表 R17（${centsToDecimalString(input.r17TotalCents)}元）与四分项之和（${centsToDecimalString(sumParts)}元）存在 ${centsToDecimalString(diff)}元 Excel 浮点缓存尾差（SOURCE_FLOAT_CACHE_1C）`,
    };
  }
  return {
    unitOrgId: input.unitOrgId,
    unitName: input.unitName,
    kind: 'mgmt_fee_nested',
    passed: false,
    blocking: true,
    planInclusiveAmount: null,
    expectedBudgetExclAmount: centsToDecimalString(sumParts),
    actualBudgetExclAmount: centsToDecimalString(input.r17TotalCents),
    diffAmount: centsToDecimalString(diff),
    reasonCode: 'MGMT_NESTED_IMBALANCE',
    message: `${input.unitName}管理费用合计 R17（${centsToDecimalString(input.r17TotalCents)}元）不等于 R18+R19+R20+R21（${centsToDecimalString(sumParts)}元），差额 ${centsToDecimalString(diff)}元`,
  };
}

export interface Wan2DecStepCheckInput {
  unitOrgId: number | null;
  unitName: string;
  metricLabel: string;
  exactCalcCents: bigint;
  approvedIssuedCents: bigint;
  kind?: PlanTaxCheckItemDto['kind'];
}

/**
 * 校验公文通知/目标责任书批复金额与精确计算分值（如 R19 五项费用、可控管理费 = R19 + R20）的一致性：
 * 仅允许：
 * 1) 精确到分下达（approvedIssuedCents === exactCalcCents）；
 * 2) 按 0.01万元（100.00元 = 10000n）步长执行标准 ROUND_HALF_UP 派生（且 |diff| <= 5000n 半步长上界）。
 * 严禁放行未经 ROUND_HALF_UP 公式派生的任意差额。
 */
export function verifyWan2DecIssuedStep(input: Wan2DecStepCheckInput): PlanTaxCheckItemDto {
  const expectedWanStep = roundHalfUpStep(input.exactCalcCents, WAN_2DEC_STEP_CENTS);
  const diff = input.approvedIssuedCents - input.exactCalcCents;
  const absDiff = diff < 0n ? -diff : diff;
  const kind = input.kind ?? 'controllable_mgmt_step';

  if (input.approvedIssuedCents === input.exactCalcCents) {
    return {
      unitOrgId: input.unitOrgId,
      unitName: input.unitName,
      kind,
      passed: true,
      blocking: false,
      planInclusiveAmount: null,
      expectedBudgetExclAmount: centsToDecimalString(input.exactCalcCents),
      actualBudgetExclAmount: centsToDecimalString(input.approvedIssuedCents),
      diffAmount: '0.00',
      reasonCode: 'EXACT_MATCH',
      message: `${input.unitName}${input.metricLabel}精确值与发文批复值完全一致（${centsToDecimalString(input.exactCalcCents)}元）`,
    };
  }

  if (input.approvedIssuedCents === expectedWanStep && absDiff <= WAN_2DEC_HALF_STEP_CENTS) {
    return {
      unitOrgId: input.unitOrgId,
      unitName: input.unitName,
      kind,
      passed: true,
      blocking: false,
      planInclusiveAmount: null,
      expectedBudgetExclAmount: centsToDecimalString(input.exactCalcCents),
      actualBudgetExclAmount: centsToDecimalString(input.approvedIssuedCents),
      diffAmount: centsToDecimalString(diff),
      reasonCode: 'DISPLAY_WAN_2DEC_HALF_UP',
      message: `${input.unitName}${input.metricLabel}精确值 ${centsToDecimalString(input.exactCalcCents)}元 按 0.01万元（100.00元）ROUND_HALF_UP 派生为 ${centsToDecimalString(input.approvedIssuedCents)}元（进位差 ${centsToDecimalString(diff)}元 <= 50.00元半步长）`,
    };
  }

  return {
    unitOrgId: input.unitOrgId,
    unitName: input.unitName,
    kind,
    passed: false,
    blocking: true,
    planInclusiveAmount: null,
    expectedBudgetExclAmount: centsToDecimalString(expectedWanStep),
    actualBudgetExclAmount: centsToDecimalString(input.approvedIssuedCents),
    diffAmount: centsToDecimalString(diff),
    reasonCode: 'STEP_ROUNDING_MISMATCH',
    message: `${input.unitName}${input.metricLabel}批复值（${centsToDecimalString(input.approvedIssuedCents)}元）既不等于精确分值（${centsToDecimalString(input.exactCalcCents)}元），也不等于 0.01万元 ROUND_HALF_UP 派生值（${centsToDecimalString(expectedWanStep)}元），差额 ${centsToDecimalString(diff)}元`,
  };
}
