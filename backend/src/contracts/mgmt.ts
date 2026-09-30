import { z } from 'zod';
import { expectedVersion, id, moneyString, optionalText, period, reason, type MoneyString } from './common';
import { STATEMENT_METRICS, STATEMENT_SCOPES } from './statements';

/** AC-F14 管理会计:请求 schema 与响应类型(规则见 specs/implementation.md T-3「管理会计」)。 */

const code = z.string().trim().regex(/^[A-Za-z][A-Za-z0-9_-]{0,31}$/, '编码为字母开头的 1～32 位字母、数字、下划线或连字符');
const name = z.string().trim().min(1, '名称不能为空').max(100);
/** 比率/权重/得分等:十进制字符串,最多 6 位小数。 */
export const scaledString = z.string().trim().regex(/^-?\d{1,12}(\.\d{1,6})?$/, '应为最多 6 位小数的十进制字符串');

/* ---------------- 维度 ---------------- */

export const MA_MEMBER_TYPES = ['org', 'project', 'account', 'custom'] as const;
export type MaMemberType = (typeof MA_MEMBER_TYPES)[number];

export const maDimensionCreate = z.object({ code, name, memberType: z.enum(MA_MEMBER_TYPES) });
export const maDimensionUpdate = z.object({ expectedVersion, name: name.optional(), status: z.enum(['active', 'inactive']).optional() });
/** 成员映射:org/project/account 维度按主数据编码引用(refCode),custom 维度只有自定义编码。 */
export const maMemberInput = z.object({ code, name: name.optional(), refCode: z.string().trim().min(1).max(64).optional() });
export const maMemberPreviewRequest = z.object({ members: z.array(maMemberInput).min(1).max(500) });
export const maMemberConfirmRequest = maMemberPreviewRequest.extend({ previewHash: z.string().regex(/^[0-9a-f]{64}$/) });
export type MaMemberPreviewRequest = z.infer<typeof maMemberPreviewRequest>;
export type MaMemberConfirmRequest = z.infer<typeof maMemberConfirmRequest>;

export interface MaDimensionDto { id: number; code: string; name: string; memberType: MaMemberType; status: 'active' | 'inactive'; version: number; memberCount: number; createdAt: string; updatedAt: string }
export interface MaMemberDto { id: number; dimensionId: number; code: string; name: string; refType: MaMemberType; refId: number | null; refCode: string | null; orgId: number | null; status: 'active' | 'inactive'; createdAt: string }
export interface MaMemberPreviewRowDto {
  row: number; code: string; name: string; refCode: string | null; refId: number | null; refName: string | null; orgId: number | null;
  action: 'create' | 'unchanged' | 'error'; message: string | null;
}
export interface MaMemberPreviewDto { valid: boolean; previewHash: string; rows: MaMemberPreviewRowDto[]; createCount: number; unchangedCount: number; errorCount: number }

/* ---------------- 指标 ---------------- */

export const MA_CALCULATORS = [
  'budget_amount', 'actual_amount', 'execution_rate', 'eas_balance', 'statement_item', 'allocated_cost', 'contract_paid', 'contract_payment_rate', 'plan_execution_rate',
  'risk_open_amount', 'investment_deviation_rate',
] as const;
export type MaCalculator = (typeof MA_CALCULATORS)[number];
export const MA_CALCULATOR_LABELS: Record<MaCalculator, string> = {
  budget_amount: '预算金额(当前采用预算)', actual_amount: '实际金额(年度最新实际)', execution_rate: '预算执行率',
  eas_balance: 'EAS 科目余额(当前集合)', statement_item: '财报语义指标(当前批次)', allocated_cost: '已确认分摊成本',
  contract_paid: '合同本期已付', contract_payment_rate: '合同付款比例(已付/当前金额)', plan_execution_rate: '计划年度执行率(同年取数)',
  risk_open_amount: '未关闭风险金额', investment_deviation_rate: '投资静态总偏差率(各项目最新对比快照)',
};
export const EAS_BALANCE_FIELDS = ['end_net', 'end_debit', 'end_credit', 'period_debit', 'period_credit'] as const;

export const maMetricParams = z.discriminatedUnion('calculator', [
  z.object({ calculator: z.literal('budget_amount'), accountCode: z.string().trim().min(1).max(64) }),
  z.object({ calculator: z.literal('actual_amount'), accountCode: z.string().trim().min(1).max(64) }),
  z.object({ calculator: z.literal('execution_rate'), accountCode: z.string().trim().min(1).max(64) }),
  z.object({ calculator: z.literal('eas_balance'), accountCode: z.string().trim().min(1).max(64), field: z.enum(EAS_BALANCE_FIELDS) }),
  z.object({ calculator: z.literal('statement_item'), metricKey: z.enum(STATEMENT_METRICS), scope: z.enum(STATEMENT_SCOPES).optional() }),
  z.object({ calculator: z.literal('allocated_cost') }),
  z.object({ calculator: z.literal('contract_paid') }),
  z.object({ calculator: z.literal('contract_payment_rate') }),
  z.object({ calculator: z.literal('plan_execution_rate') }),
  z.object({ calculator: z.literal('risk_open_amount') }),
  z.object({ calculator: z.literal('investment_deviation_rate') }),
]);
export type MaMetricParams = z.infer<typeof maMetricParams>;

/** 阈值:上下限按指标单位(money 为元,ratio 为 0～1 比率);偏差比例为 (实际 − 预算) / |预算|,仅 actual_amount 指标适用。 */
export const maThresholds = z.object({
  upperWarning: scaledString.optional(), upperCritical: scaledString.optional(),
  lowerWarning: scaledString.optional(), lowerCritical: scaledString.optional(),
  deviationWarning: scaledString.optional(), deviationCritical: scaledString.optional(),
}).strict();
export type MaThresholds = z.infer<typeof maThresholds>;

export const maMetricCreate = z.object({ code, name, params: maMetricParams, thresholds: maThresholds.default({}) });
export const maMetricUpdate = z.object({
  expectedVersion, name: name.optional(), params: maMetricParams.optional(), thresholds: maThresholds.optional(), status: z.enum(['active', 'inactive']).optional(),
});
export type MaMetricCreate = z.infer<typeof maMetricCreate>;
export type MaMetricUpdate = z.infer<typeof maMetricUpdate>;

export interface MaMetricDto {
  id: number; code: string; name: string; unit: 'money' | 'ratio'; calculator: MaCalculator; params: MaMetricParams; thresholds: MaThresholds;
  builtin: boolean; status: 'active' | 'inactive'; version: number; createdAt: string; updatedAt: string;
}

export const maCalcRunRequest = z.object({ period, metricIds: z.array(id).min(1).max(100).optional(), orgIds: z.array(id).min(1).max(200).optional() });
export type MaCalcRunRequest = z.infer<typeof maCalcRunRequest>;

export interface MaUnavailableReason { code: string; message: string }
export interface MaSnapshotDto {
  id: number; runId: number; metricId: number; metricCode: string; metricName: string; unit: 'money' | 'ratio'; orgId: number; orgName: string; period: string;
  status: 'valid' | 'unavailable' | 'invalidated';
  /** money 为元字符串,ratio 为 6 位小数比率字符串;不可用时为 null(不是 0)。 */
  value: string | null;
  /** actual_amount 指标的同口径预算,用于偏差预警。 */
  compareValue: MoneyString | null;
  reasons: MaUnavailableReason[];
  evidence: Record<string, unknown>;
  allocRunId: number | null; adjustmentId: number | null;
  invalidatedAt: string | null; invalidatedReason: string | null; createdAt: string;
}
export interface MaCalcRunDto {
  id: number; kind: 'calc' | 'allocation'; period: string; request: Record<string, unknown>; snapshotCount: number; unavailableCount: number;
  createdByUserId: number | null; createdAt: string; snapshots?: MaSnapshotDto[];
}

/* ---------------- 分摊 ---------------- */

export const maCostPoolCreate = z.object({ name, orgId: id, period, total: moneyString, note: optionalText() });
export const maCostPoolUpdate = z.object({ expectedVersion, name: name.optional(), total: moneyString.optional(), note: optionalText() });
export const maAllocRulesRequest = z.object({
  expectedVersion,
  rules: z.array(z.object({ targetOrgId: id, weight: scaledString })).min(1).max(200),
});
export const maAllocConfirmRequest = z.object({ expectedVersion });
export const maAllocVoidRequest = z.object({ reason });
export const maAllocAdjustmentCreate = z.object({ fromResultId: id, toResultId: id, amount: moneyString, reason });
export const maReviewRequest = z.object({ action: z.enum(['approve', 'reject']), comment: optionalText(), exceptionReason: optionalText() });
export type MaCostPoolCreate = z.infer<typeof maCostPoolCreate>;
export type MaCostPoolUpdate = z.infer<typeof maCostPoolUpdate>;
export type MaAllocRulesRequest = z.infer<typeof maAllocRulesRequest>;
export type MaAllocAdjustmentCreate = z.infer<typeof maAllocAdjustmentCreate>;
export type MaReviewRequest = z.infer<typeof maReviewRequest>;

export interface MaAllocRuleDto { id: number; targetOrgId: number; targetOrgName: string; weight: string; sortOrder: number }
export interface MaCostPoolDto {
  id: number; name: string; orgId: number; orgName: string; period: string; total: MoneyString; note: string; version: number;
  rules: MaAllocRuleDto[]; confirmedRunId: number | null; createdAt: string; updatedAt: string;
}
export interface MaAllocPreviewDto { poolId: number; poolVersion: number; total: MoneyString; results: { targetOrgId: number; targetOrgName: string; weight: string; amount: MoneyString }[] }
export interface MaAllocResultDto { id: number; targetOrgId: number; targetOrgName: string; weight: string; baseAmount: MoneyString; amount: MoneyString; sortOrder: number }
export interface MaAllocAdjustmentDto {
  id: number; runId: number; fromResultId: number; toResultId: number; fromOrgName: string; toOrgName: string; amount: MoneyString; reason: string;
  status: 'pending' | 'approved' | 'rejected' | 'cancelled'; submittedByUserId: number | null; submittedAt: string;
  reviewedByUserId: number | null; reviewedAt: string | null; reviewComment: string | null; exceptionReason: string | null; selfReview: boolean;
}
export interface MaAllocRunDto {
  id: number; poolId: number; poolName: string; poolVersion: number; period: string; total: MoneyString; calcRunId: number | null;
  status: 'confirmed' | 'voided'; version: number; confirmedByUserId: number | null; confirmedAt: string;
  voidedAt: string | null; voidReason: string | null; results: MaAllocResultDto[]; adjustments: MaAllocAdjustmentDto[];
}
export interface MaLineageDto {
  pool: MaCostPoolDto; run: MaAllocRunDto; rulesAtConfirm: { targetOrgId: number; weight: string }[];
  snapshots: MaSnapshotDto[];
  /** 血缘链:成本池 → 规则/权重 → 运行 → 结果 → 调整 → 快照 */
  chain: { kind: 'pool' | 'rule' | 'run' | 'result' | 'adjustment' | 'snapshot'; id: number; parent: string | null; label: string }[];
}

/* ---------------- 预算调整 ---------------- */

/** 针对当前采用且已锁定的经营预算版本(versionId)的一个叶子单元格;amount 为界面口径(成本费用填正数)。 */
export const maBudgetAdjustmentCreate = z.object({ versionId: id, orgId: id, accountId: id, amount: moneyString, reason });
export type MaBudgetAdjustmentCreate = z.infer<typeof maBudgetAdjustmentCreate>;
export interface MaBudgetAdjustmentDto {
  id: number; sourceVersionId: number; sourceVersionName: string; year: number; orgId: number; orgName: string; accountId: number; accountCode: string; accountName: string;
  /** 界面口径金额(成本费用为正数)。 */
  beforeAmount: MoneyString; afterAmount: MoneyString; reason: string; status: 'pending' | 'effective' | 'rejected'; newVersionId: number | null;
  submittedByUserId: number | null; submittedAt: string; reviewedByUserId: number | null; reviewedAt: string | null; reviewComment: string | null;
  exceptionReason: string | null; selfReview: boolean;
}

/* ---------------- 预警 ---------------- */

export const MA_ALERT_CAUSES = ['timing', 'business_change', 'data_quality', 'one_off', 'other'] as const;
export const MA_ALERT_CAUSE_LABELS: Record<(typeof MA_ALERT_CAUSES)[number], string> = {
  timing: '时间性差异', business_change: '业务变化', data_quality: '数据质量', one_off: '一次性事项', other: '其他',
};
export const maAlertScanRequest = z.object({ runId: id });
export const maAlertAckRequest = z.object({ expectedVersion, causeCategory: z.enum(MA_ALERT_CAUSES), note: reason });
export const maAlertCloseRequest = z.object({ expectedVersion, note: optionalText() });
export interface MaAlertDto {
  id: number; metricId: number; metricCode: string; metricName: string; orgId: number; orgName: string; period: string;
  alertType: 'upper' | 'lower' | 'deviation'; level: 'warning' | 'critical'; status: 'open' | 'acknowledged' | 'closed';
  snapshotId: number; runId: number; value: string; threshold: string; message: string; hitCount: number;
  causeCategory: string | null; ackNote: string | null; acknowledgedAt: string | null; closeNote: string | null; closedAt: string | null;
  version: number; createdAt: string; updatedAt: string;
}
export interface MaAlertScanDto { created: number; updated: number; unchanged: number; evaluated: number }

/* ---------------- 绩效 ---------------- */

export const maPerfSchemeCreate = z.object({
  code, name,
  items: z.array(z.object({ metricId: id, weight: scaledString, target: scaledString, direction: z.enum(['higher_better', 'lower_better']) })).min(1).max(50),
});
export const maPerfScoreRequest = z.object({ runId: id, orgIds: z.array(id).min(1).max(200).optional() });
export const maPerfReviewRequest = z.object({
  action: z.enum(['confirm', 'adjust']), adjustedScore: scaledString.optional(), reason: optionalText(), comment: optionalText(), exceptionReason: optionalText(),
});
export type MaPerfSchemeCreate = z.infer<typeof maPerfSchemeCreate>;
export type MaPerfReviewRequest = z.infer<typeof maPerfReviewRequest>;
export interface MaPerfSchemeDto {
  id: number; code: string; name: string; status: 'active' | 'inactive'; version: number; createdAt: string;
  items: { id: number; metricId: number; metricCode: string; metricName: string; unit: 'money' | 'ratio'; weight: string; target: string; direction: 'higher_better' | 'lower_better' }[];
}
export interface MaPerfScoreDto {
  id: number; schemeId: number; schemeName: string; runId: number; orgId: number; orgName: string; period: string;
  /** 原始得分(百分制,2 位小数);复核调整不覆盖。 */
  score: string; finalScore: string;
  details: { metricId: number; metricName: string; value: string; target: string; direction: string; weight: string; achievement: string; itemScore: string; snapshotId: number }[];
  status: 'scored' | 'reviewed'; reviewAction: 'confirm' | 'adjust' | null; adjustedScore: string | null; adjustReason: string | null;
  reviewComment: string | null; exceptionReason: string | null; selfReview: boolean;
  scoredByUserId: number | null; scoredAt: string; reviewedByUserId: number | null; reviewedAt: string | null;
}

/* ---------------- 责任中心 / 多维分析 ---------------- */

export interface MaResponsibilityCenterDto {
  orgId: number; orgName: string; orgCode: string; period: string;
  snapshots: MaSnapshotDto[];
  openAlerts: { warning: number; critical: number; acknowledged: number };
  allocatedCost: MoneyString;
  todos: { kind: 'alert_ack' | 'alloc_adjustment_review' | 'budget_adjustment_review' | 'perf_review'; id: number; title: string }[];
}

export const maAnalysisQuery = z.object({
  metricIds: z.array(id).min(1).max(50),
  periods: z.array(period).min(1).max(36),
  groupBy: z.enum(['org', 'dimension']).default('org'),
  dimensionId: id.optional(),
  orgIds: z.array(id).max(200).optional(),
});
export type MaAnalysisQuery = z.infer<typeof maAnalysisQuery>;
export interface MaAnalysisDto {
  groupBy: 'org' | 'dimension';
  rows: { metricId: number; metricCode: string; metricName: string; unit: 'money' | 'ratio'; period: string; groupKey: string; groupName: string; orgId: number; value: string | null; snapshotId: number | null; runId: number | null }[];
}
