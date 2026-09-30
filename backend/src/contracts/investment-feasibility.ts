import { z } from 'zod';
import { expectedVersion, id, optionalText } from './common';

/**
 * 投资可行性测算契约(T-5,AC-F12)。
 *
 * assumptions 是版本化的模型输入文档(schema_version = standard-1.0),字段名沿用标准模型
 * (snake_case,与 lishui 标准模板/回归样本一致);金额单位万元、最多 6 位小数,比率 0~1、最多 6 位小数。
 * 数值一律以十进制字符串传输(也接受不带指数的 JSON 数字),服务端规范化后参与 hash 与计算。
 */

const DEC_RE = /^\d{1,13}(\.\d{1,6})?$/;
function canonical(v: string): string {
  const [i, f = ''] = v.split('.');
  const intPart = i.replace(/^0+(?=\d)/, '');
  const frac = f.replace(/0+$/, '');
  return frac ? `${intPart}.${frac}` : intPart;
}
const decimalInput = z.union([z.string(), z.number()]).transform((v, ctx) => {
  const text = typeof v === 'number' ? String(v) : v.trim();
  if (!DEC_RE.test(text)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: '应为非负十进制数,最多 6 位小数' });
    return z.NEVER;
  }
  return canonical(text);
});
/** 万元金额,≥0。 */
export const wanAmount = decimalInput;
/** 0~1 比率。 */
export const ratio01 = decimalInput.refine((v) => {
  if (typeof v !== 'string') return true;
  const [i, f = ''] = v.split('.');
  return i === '0' || (i === '1' && /^0*$/.test(f));
}, '比率应在 0 到 1 之间');
const year = z.number().int().min(2000).max(2100);
const text = (max: number) => z.string().trim().min(1).max(max);
const note = z.string().trim().max(500).nullish();

function uniqueYears<T extends { fiscal_year: number }>(label: string) {
  return (rows: T[], ctx: z.RefinementCtx) => {
    const seen = new Set<number>();
    for (const r of rows) {
      if (seen.has(r.fiscal_year)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `${label}年份重复:${r.fiscal_year}` });
      seen.add(r.fiscal_year);
    }
  };
}

export const INVESTMENT_FIELDS = ['engineering_cost', 'equipment_cost', 'land_resettlement_cost', 'preliminary_cost', 'design_supervision_cost',
  'other_cost', 'contingency', 'working_capital'] as const;

const investmentPlanItem = z.object({
  fiscal_year: year,
  engineering_cost: wanAmount.default('0'),
  equipment_cost: wanAmount.default('0'),
  land_resettlement_cost: wanAmount.default('0'),
  preliminary_cost: wanAmount.default('0'),
  design_supervision_cost: wanAmount.default('0'),
  other_cost: wanAmount.default('0'),
  contingency: wanAmount.default('0'),
  working_capital: wanAmount.default('0'),
}).strict();

const financingPlanItem = z.object({
  fiscal_year: year,
  debt_drawdown: wanAmount,
  equity_contribution: wanAmount,
  capitalized_interest: wanAmount,
}).strict();

const revenueItem = z.object({
  name: text(64),
  mode: z.enum(['power', 'fixed_amount']).default('fixed_amount'),
  start_year: year,
  end_year: year.nullish(),
  power_generation_10k_kwh: wanAmount.nullish(),
  electricity_price_yuan_per_kwh: wanAmount.nullish(),
  price_tax_mode: z.enum(['tax_inclusive', 'tax_exclusive']).default('tax_inclusive'),
  annual_amount: wanAmount.nullish(),
  growth_rate: ratio01.default('0'),
  taxable_for_vat: z.boolean().default(true),
  note,
}).strict().superRefine((v, ctx) => {
  if (v.end_year != null && v.end_year < v.start_year) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `收入“${v.name}”结束年份不得早于开始年份` });
  if (v.mode === 'power' && (v.power_generation_10k_kwh == null || v.electricity_price_yuan_per_kwh == null)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: `发电收入“${v.name}”必须填写发电量和电价` });
  }
  if (v.mode === 'fixed_amount' && v.annual_amount == null) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `固定金额收入“${v.name}”必须填写年度金额` });
});

const yearAmount = z.object({ fiscal_year: year, amount: wanAmount }).strict();

const costItem = z.object({
  name: text(64),
  mode: z.enum(['fixed_amount', 'revenue_rate', 'yearly_amount']).default('fixed_amount'),
  start_year: year,
  end_year: year.nullish(),
  annual_amount: wanAmount.nullish(),
  revenue_rate: ratio01.nullish(),
  yearly_amounts: z.array(yearAmount).max(100).default([]),
  growth_rate: ratio01.default('0'),
  amount_tax_mode: z.enum(['tax_inclusive', 'tax_exclusive']).default('tax_exclusive'),
  input_vat_rate: ratio01.default('0'),
  note,
}).strict().superRefine((v, ctx) => {
  if (v.end_year != null && v.end_year < v.start_year) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `成本“${v.name}”结束年份不得早于开始年份` });
  if (v.mode === 'fixed_amount' && v.annual_amount == null) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `固定成本“${v.name}”必须填写年度金额` });
  if (v.mode === 'revenue_rate' && v.revenue_rate == null) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `收入比例成本“${v.name}”必须填写收入比例` });
  if (v.mode === 'yearly_amount' && v.yearly_amounts.length === 0) ctx.addIssue({ code: z.ZodIssueCode.custom, message: `分年成本“${v.name}”必须填写至少一个年度金额` });
  uniqueYears('分年成本')(v.yearly_amounts, ctx);
});

const taxAssumption = z.object({
  vat_rate: ratio01.default('0.09'),
  opening_input_vat_credit: wanAmount.default('0'),
  annual_input_vat: z.array(z.object({ fiscal_year: year, input_vat: wanAmount.default('0') }).strict()).max(100).default([]),
  water_resource_tax_yuan_per_kwh: wanAmount.default('0'),
  water_construction_fund_rate: ratio01.default('0'),
  surcharge_rate: ratio01.default('0.12'),
  income_tax_rate: ratio01.default('0.25'),
  loss_carryforward_years: z.number().int().min(0).max(10).default(5),
  note,
}).strict().superRefine((v, ctx) => uniqueYears('年度进项税')(v.annual_input_vat, ctx));

const depreciationAssumption = z.object({
  depreciable_base: wanAmount.nullish(),
  residual_rate: ratio01.default('0.05'),
  useful_life_years: z.number().int().min(1).max(60).default(20),
  method: z.literal('straight_line').default('straight_line'),
}).strict();

const financingAssumption = z.object({
  debt_ratio: ratio01.default('0.6'),
  loan_interest_rate: ratio01.default('0.04'),
  total_loan_years: z.number().int().min(1).max(60).default(12),
  operation_repayment_years: z.number().int().min(1).max(50).default(10),
  repayment_method: z.enum(['equal_principal', 'equal_payment', 'bullet']).default('equal_principal'),
  plan: z.array(financingPlanItem).max(100).default([]),
  other_funding_note: note,
}).strict().superRefine((v, ctx) => {
  if (v.operation_repayment_years > v.total_loan_years) ctx.addIssue({ code: z.ZodIssueCode.custom, message: '运营偿还期不得超过贷款总期限' });
  uniqueYears('融资计划')(v.plan, ctx);
});

const evaluationAssumption = z.object({
  discount_rate: ratio01.default('0.08'),
  benchmark_irr: ratio01.default('0.08'),
  min_dscr: decimalInput.default('1.2'),
  horizon_years: z.number().int().min(1).max(60).default(30),
  cashflow_timing: z.literal('end_of_year').default('end_of_year'),
  terminal_recovery: wanAmount.default('0'),
  affordability_warning_score: decimalInput.refine((v) => typeof v !== 'string' || /^(100(\.0+)?|\d{1,2}(\.\d+)?)$/.test(v), '评分阈值应在 0 到 100 之间').default('70'),
}).strict();

export const SENSITIVITY_CODES = ['construction_investment', 'electricity_price', 'power_generation', 'operating_cost', 'construction_delay',
  'loan_interest_rate', 'opening_input_vat_credit'] as const;
export type SensitivityCode = (typeof SENSITIVITY_CODES)[number];

const signedChange = z.union([z.string(), z.number()]).transform((v, ctx) => {
  const t = typeof v === 'number' ? String(v) : v.trim();
  if (!/^-?\d{1,3}(\.\d{1,6})?$/.test(t)) {
    ctx.addIssue({ code: z.ZodIssueCode.custom, message: '变动值应为最多 6 位小数的十进制数' });
    return z.NEVER;
  }
  return t;
});
export const sensitivityVariable = z.object({
  code: z.enum(SENSITIVITY_CODES),
  mode: z.enum(['relative', 'percentage_point', 'year_delta']).default('relative'),
  changes: z.array(signedChange).min(1).max(10).default(['-0.1', '0.1']),
}).strict().superRefine((v, ctx) => {
  if (v.mode === 'percentage_point' && v.code !== 'loan_interest_rate') ctx.addIssue({ code: z.ZodIssueCode.custom, message: '百分点变化仅适用于贷款利率' });
  if (v.mode === 'year_delta' && v.code !== 'construction_delay') ctx.addIssue({ code: z.ZodIssueCode.custom, message: '年份变化仅适用于建设延期' });
  if (v.mode === 'year_delta' && v.changes.some((c) => !/^-?\d{1,2}$/.test(c))) ctx.addIssue({ code: z.ZodIssueCode.custom, message: '建设延期变动应为整数年' });
  if (v.mode === 'relative' && v.changes.some((c) => Number(c) <= -1)) ctx.addIssue({ code: z.ZodIssueCode.custom, message: '相对变动必须大于 -100%' });
});

export const feasibilityAssumptions = z.object({
  schema_version: z.literal('standard-1.0', { errorMap: () => ({ message: '仅支持标准模型 standard-1.0' }) }),
  basis: z.object({
    preparation_basis: note, data_source: note, notes: note, scope_note: note,
  }).strict().default({}),
  investment_plan: z.array(investmentPlanItem).min(1, '至少需要一年建设投资').max(60),
  revenue_items: z.array(revenueItem).max(50).default([]),
  cost_items: z.array(costItem).max(50).default([]),
  financing: financingAssumption.default({}),
  tax: taxAssumption.default({}),
  depreciation: depreciationAssumption.default({}),
  evaluation: evaluationAssumption.default({}),
  sensitivity: z.object({ variables: z.array(sensitivityVariable).max(20).default([]) }).strict().default({}),
}).strict().superRefine((v, ctx) => uniqueYears('建设投资')(v.investment_plan, ctx));

export type FeasibilityAssumptions = z.output<typeof feasibilityAssumptions>;
export type FeasibilityAssumptionsInput = z.input<typeof feasibilityAssumptions>;

const projectYears = z.object({
  constructionStartYear: year,
  operationStartYear: year,
  horizonYears: z.number().int().min(1).max(60),
});
export const feasProjectCreate = projectYears.extend({
  code: text(64),
  name: text(128),
  orgId: id,
  mdProjectId: id.nullish(),
  description: optionalText(1000),
}).strict().superRefine((v, ctx) => {
  if (v.operationStartYear <= v.constructionStartYear) ctx.addIssue({ code: z.ZodIssueCode.custom, message: '运营起年必须晚于建设起年' });
});
export const feasProjectUpdate = z.object({
  expectedVersion,
  name: text(128).optional(),
  description: optionalText(1000),
  constructionStartYear: year.optional(),
  operationStartYear: year.optional(),
  horizonYears: z.number().int().min(1).max(60).optional(),
  status: z.enum(['active', 'archived']).optional(),
}).strict();

export const feasScenarioCreate = z.object({
  code: text(64),
  name: text(128),
  assumptions: feasibilityAssumptions,
}).strict();
export const feasScenarioUpdate = z.object({
  expectedVersion,
  name: text(128).optional(),
  assumptions: feasibilityAssumptions.optional(),
}).strict();
export const feasScenarioCopy = z.object({ code: text(64), name: text(128) }).strict();
export const feasRunRequest = z.object({ expectedVersion }).strict();
export const feasSensitivityRequest = z.object({
  expectedVersion,
  variables: z.array(sensitivityVariable).max(20).optional(),
}).strict();
export const feasProjectListQuery = z.object({
  orgId: id.optional(),
  status: z.enum(['active', 'archived']).optional(),
  keyword: z.string().trim().max(100).optional(),
}).strict();
export const feasImportConfirm = z.object({
  sha256: z.string().regex(/^[0-9a-f]{64}$/),
  code: text(64),
  name: text(128),
}).strict();

export interface FeasIndicatorDto {
  code: string;
  name: string;
  value: string | null;
  unit: string;
  status: 'ok' | 'warning' | 'no_solution';
  evidence: Record<string, unknown> | null;
}
export interface FeasCheckDto {
  code: string;
  passed: boolean;
  severity: 'info' | 'error';
  message: string;
  evidence: Record<string, unknown>;
}
/** 逐年现金流:金额为万元 6 位小数字符串;dscr 为倍数 6 位小数,不适用时 null。 */
export type FeasCashflowDto = Record<string, string | number | null | Record<string, string>>;
export interface FeasResultDto {
  modelVersion: 'standard-1.0';
  roundingRule: string;
  parameterHash: string;
  discountBaseYear: number;
  allChecksPassed: boolean;
  checks: FeasCheckDto[];
  indicators: FeasIndicatorDto[];
  cashflows: FeasCashflowDto[];
}
export interface FeasSensitivityItemDto {
  code: SensitivityCode;
  mode: string;
  change: string;
  status: 'ok' | 'failed';
  error?: string;
  indicators: { code: string; value: string | null; baseValue: string | null; delta: string | null }[];
}
