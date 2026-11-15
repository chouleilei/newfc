import { z } from 'zod';
import { expectedVersion, id, moneyString, optionalText, period, reason, type MoneyString, type RatioString } from './common';
import { year, type RowErrorDto } from './project-budget';

/** AC-F15 计划执行与形象进度:请求 schema 与响应类型。 */

export const PLAN_SHEETS = [
  'investment',
  'investment_tech_renovation',
  'investment_info',
  'investment_other',
  'purchase',
  'pre_work',
  'capacity_add',
  'tech_renovation_exp',
  'maintenance',
  'safety_input',
  'five_expenses',
  'mgmt_fee',
  'mfg_fee',
  'annual_kpi',
  'profit_budget',
  'responsibility_kpi',
] as const;
export type PlanSheetCode = (typeof PLAN_SHEETS)[number];
export const PLAN_SHEET_LABELS: Record<PlanSheetCode, string> = {
  investment: '固定资产投资计划',
  investment_tech_renovation: '资本化更新改造',
  investment_info: '信息化投资',
  investment_other: '其他投资',
  purchase: '固定资产购置计划',
  pre_work: '前期工作费',
  capacity_add: '新增生产能力',
  tech_renovation_exp: '费用化更新改造',
  maintenance: '运行维护费',
  safety_input: '安全生产投入',
  five_expenses: '五项费用',
  mgmt_fee: '管理类费用',
  mfg_fee: '制造费用',
  annual_kpi: '主要指标',
  profit_budget: '利润预算明细',
  responsibility_kpi: '经营目标责任指标',
};

export type PlanSheetDomain = 'investment_purchase' | 'operation_expense' | 'kpi_budget';
export const PLAN_SHEET_DOMAIN_LABELS: Record<PlanSheetDomain, string> = {
  investment_purchase: '投资与购置',
  operation_expense: '运维与费用',
  kpi_budget: '指标与预算',
};
export const PLAN_SHEET_DOMAINS: Record<PlanSheetDomain, readonly PlanSheetCode[]> = {
  investment_purchase: [
    'investment',
    'investment_tech_renovation',
    'investment_info',
    'investment_other',
    'purchase',
    'pre_work',
    'capacity_add',
  ],
  operation_expense: [
    'tech_renovation_exp',
    'maintenance',
    'safety_input',
    'five_expenses',
    'mgmt_fee',
    'mfg_fee',
  ],
  kpi_budget: ['annual_kpi', 'profit_budget', 'responsibility_kpi'],
};

export const PLAN_MEASURES = ['annual_plan', 'annual_actual_ytd', 'cumulative', 'total', 'snapshot'] as const;
export type PlanMeasure = (typeof PLAN_MEASURES)[number];
export const PLAN_MEASURE_LABELS: Record<PlanMeasure, string> = {
  annual_plan: '本年计划', annual_actual_ytd: '本年累计实际', cumulative: '开工累计', total: '总额', snapshot: '状态/形象进度',
};
export type PlanRowStatus = 'not_computable' | 'over_plan' | 'slow' | 'normal';
export const PLAN_ROW_STATUS_LABELS: Record<PlanRowStatus, string> = { not_computable: '不可计算', over_plan: '超计划', slow: '偏慢', normal: '正常' };

/** 上传表单:计划年度 + 实际期间(须在年度内)。 */
export const planUploadForm = z.object({ year, actualPeriod: period })
  .refine((v) => v.actualPeriod.startsWith(`${v.year}-`), { message: '实际期间必须在计划年度内', path: ['actualPeriod'] });
export type PlanUploadForm = z.infer<typeof planUploadForm>;
export const planActivateRequest = z.object({ expectedCurrentBatchId: id.nullable() });
export const planVoidRequest = z.object({ reason });
/** 同年取数:year 必填;asOfPeriod 缺省取该年最新的当前批次。 */
export const planQuery = z.object({ year, asOfPeriod: period.optional(), orgId: id.optional(), projectId: id.optional() })
  .refine((v) => !v.asOfPeriod || v.asOfPeriod.startsWith(`${v.year}-`), { message: '截至期间必须在计划年度内', path: ['asOfPeriod'] });
export type PlanQuery = z.infer<typeof planQuery>;

export interface PlanFactDto {
  fieldKey: string;
  fieldName: string;
  measure: PlanMeasure;
  valueType: 'amount' | 'quantity' | 'ratio' | 'text';
  /** amount 为元字符串,quantity 4 位、ratio 6 位小数字符串,text 为原文 */
  value: string;
  sourceCell: string;
}

export interface PlanWarningDto {
  code: 'MISSING_PROJECT_CODE' | 'STALE_YEAR_HEADER' | 'PLACEHOLDER_SHEET_SKIPPED' | 'ZERO_PLACEHOLDER_ROW' | 'CROSS_UNIT_CELL_REF' | 'FORMULA_CACHE_ISSUE';
  sheet: string;
  row: number;
  message: string;
  headerYearRaw?: string;
}

export type PlanItemType = 'detail' | 'category' | 'subtotal' | 'leaf' | 'section_header' | 'cross_ref_summary';

export interface PlanItemDto {
  id: number;
  sheetCode: PlanSheetCode;
  rowNo: number;
  seqNo: string;
  itemName: string;
  itemType: PlanItemType;
  path: string;
  projectId: number | null;
  projectCode: string | null;
  orgId: number | null;
  orgName: string | null;
  undertakeOrgId?: number | null;
  undertakeOrgName?: string | null;
  stableItemUid?: string;
  costNature?: string;
  fundingChannel?: string;
  submittedAmount?: MoneyString | null;
  approvedAmount?: MoneyString | null;
  approvedBudget?: MoneyString | null;
  paidCumulative?: MoneyString | null;
  warnings?: PlanWarningDto[];
  facts: PlanFactDto[];
}

export interface PlanSheetSummaryDto { code: PlanSheetCode; name: string; sourceName: string; itemCount: number; detailCount: number; unit: 'yuan' | 'wan' }

export interface PlanPreviewDto {
  valid: boolean;
  errors: RowErrorDto[];
  warnings?: PlanWarningDto[];
  sheets: PlanSheetSummaryDto[];
  ignoredSheets: string[];
  itemCount: number;
  factCount: number;
  previewItems: PlanItemDto[];
}

export interface PlanBatchDto {
  id: number;
  year: number;
  actualPeriod: string;
  fileName: string;
  fileSha256: string;
  amountUnit: 'yuan' | 'wan';
  status: 'imported' | 'voided';
  isCurrent: boolean;
  itemCount: number;
  factCount: number;
  sheets: PlanSheetSummaryDto[];
  ignoredSheets: string[];
  partial: boolean;
  orgNames: string[];
  version: number;
  createdAt: string;
  activatedAt: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  replayed?: boolean;
}

/** 当期发生额:本期年度累计实际 − 同年上一实际期间当前批次的年度累计实际;无法计算时 value=null 并给出原因。 */
export interface PeriodValueDto { value: MoneyString | null; reason: string | null; previousBatchId: number | null; previousPeriod: string | null }

export interface PlanSheetOverviewDto {
  code: PlanSheetCode;
  name: string;
  detailCount: number;
  annualPlan: MoneyString | null;
  annualActualYtd: MoneyString | null;
  /** 年度执行率 = 年度累计实际 / 年度计划(只计同时有两项的行) */
  annualRate: RatioString;
  period: PeriodValueDto;
  /** 投资:已完成(开工累计) / 总投资;其他表为 null */
  cumulativeRate: RatioString;
  completedCumulative: MoneyString | null;
  totalInvestment: MoneyString | null;
  statusCounts: Record<PlanRowStatus, number>;
  notes: string[];
}

export interface PlanOverviewDto {
  year: number;
  asOfPeriod: string | null;
  batch: PlanBatchDto | null;
  sheets: PlanSheetOverviewDto[];
  notes: string[];
}

export interface PlanProjectProgressDto {
  itemId: number;
  rowNo: number;
  projectId: number | null;
  projectCode: string;
  projectName: string;
  orgName: string;
  undertakeOrgName?: string | null;
  approvedBudget: MoneyString | null;
  totalInvestment: MoneyString | null;
  completedCumulative: MoneyString | null;
  cumulativeRate: RatioString;
  annualPlan: MoneyString | null;
  annualActualYtd: MoneyString | null;
  annualRate: RatioString;
  period: PeriodValueDto;
  /** 仅来自形象进度列;缺失为 null,不用投资完成比例冒充 */
  physicalProgress: RatioString;
  progressNote: string | null;
  paidCumulative: MoneyString | null;
  status: PlanRowStatus;
}

export interface PlanProjectProgressListDto { year: number; asOfPeriod: string | null; batch: PlanBatchDto | null; rows: PlanProjectProgressDto[]; notes: string[] }

/* ---------------- T-14 计划与预算合一下达、稽核与调整契约 ---------------- */

export const PLAN_ISSUANCE_STAGES = ['pre_arrangement', 'formal_draft', 'official', 'adjusted'] as const;
export type PlanIssuanceStage = (typeof PLAN_ISSUANCE_STAGES)[number];
export const PLAN_ISSUANCE_STAGE_LABELS: Record<PlanIssuanceStage, string> = {
  pre_arrangement: '预安排',
  formal_draft: '正式草案',
  official: '正式下达',
  adjusted: '年中调整修订',
};

export const PLAN_CYCLE_STATUSES = ['draft', 'published', 'superseded', 'archived'] as const;
export type PlanCycleStatus = (typeof PLAN_CYCLE_STATUSES)[number];
export const PLAN_CYCLE_STATUS_LABELS: Record<PlanCycleStatus, string> = {
  draft: '草稿编校',
  published: '已正式下达',
  superseded: '已被修订替代',
  archived: '已归档',
};

export const PLAN_PACK_SIGN_STATUSES = ['draft', 'issued', 'acknowledged', 'adjust_requested'] as const;
export type PlanPackSignStatus = (typeof PLAN_PACK_SIGN_STATUSES)[number];
export const PLAN_PACK_SIGN_STATUS_LABELS: Record<PlanPackSignStatus, string> = {
  draft: '待下发',
  issued: '待签收',
  acknowledged: '已签收',
  adjust_requested: '调整申请中',
};

export const PLAN_ADJUST_TYPES = [
  'within_total_realloc',
  'overall_target_change',
  'unplanned_hq_or_station',
  'unplanned_subsidiary_within_cap',
  'unplanned_subsidiary_over_cap',
  'emergency_retroactive',
] as const;
export type PlanAdjustType = (typeof PLAN_ADJUST_TYPES)[number];
export const PLAN_ADJUST_TYPE_LABELS: Record<PlanAdjustType, string> = {
  within_total_realloc: '总体指标内执行方案调剂',
  overall_target_change: '新增产能/总收入/利润等总体指标调整',
  unplanned_hq_or_station: '本部及直属电站计划外立项',
  unplanned_subsidiary_within_cap: '分子公司年度专项控制目标内计划外项目',
  unplanned_subsidiary_over_cap: '分子公司超年度专项控制目标计划外项目',
  emergency_retroactive: '防汛/突发应急先开工后补立项',
};

export const PLAN_APPROVAL_BODIES = [
  'gm_office',
  'board_of_directors',
  'joint_review_company',
  'subsidiary_self_decision',
  'company_approval',
] as const;
export type PlanApprovalBody = (typeof PLAN_APPROVAL_BODIES)[number];
export const PLAN_APPROVAL_BODY_LABELS: Record<PlanApprovalBody, string> = {
  gm_office: '总经理办公会审定',
  board_of_directors: '党组前置/董事会批准',
  joint_review_company: '专业与财务联合会审后报集团审批',
  subsidiary_self_decision: '分子公司依制度自决并报备',
  company_approval: '报集团公司审批',
};

export const PLAN_ADJ_VALUE_TYPES = ['amount_cents', 'scaled_int', 'rate_bp', 'text'] as const;
export type PlanAdjustmentValueType = (typeof PLAN_ADJ_VALUE_TYPES)[number];

const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD');

export const planIssuanceCycleCreateRequest = z.object({
  year,
  cycleCode: z.string().trim().min(2).max(64),
  issuanceStage: z.enum(PLAN_ISSUANCE_STAGES).default('official'),
  sourcePlanBatchId: id.nullish(),
  sourceBudgetVersionId: id.nullish(),
  decisionDocMeta: z.record(z.string(), z.unknown()).optional(),
  issuedDate: isoDate.nullish(),
  docNoPrefix: optionalText(64),
  annualSpecialCaps: z.array(z.object({ unitOrgId: id, sheetCode: z.enum(PLAN_SHEETS), amount: z.string().trim().regex(/^\d+(?:\.\d{1,2})?$/) })).max(128).optional(),
});
export type PlanIssuanceCycleCreateRequest = z.infer<typeof planIssuanceCycleCreateRequest>;

export const planPackAcknowledgeRequest = z.object({
  expectedVersion,
  ackNote: optionalText(500),
});
export type PlanPackAcknowledgeRequest = z.infer<typeof planPackAcknowledgeRequest>;

export const planAdjustmentLineInput = z.object({
  planItemId: id.nullish(),
  stableItemUid: optionalText(128),
  targetSheetCode: z.enum(PLAN_SHEETS),
  targetItemName: z.string().trim().min(1).max(200),
  valueType: z.enum(PLAN_ADJ_VALUE_TYPES).default('amount_cents'),
  scale: z.number().int().min(0).max(8).default(2),
  unit: z.string().trim().max(32).default('元'),
  beforeVal: z.string().trim().max(120).default('0'),
  afterVal: z.string().trim().max(120).default('0'),
  budgetAccountId: id.nullish(),
  note: optionalText(500),
});
export type PlanAdjustmentLineInput = z.infer<typeof planAdjustmentLineInput>;

export const planAdjustmentCreateRequest = z.object({
  cycleId: id,
  unitPackId: id,
  adjustType: z.enum(PLAN_ADJUST_TYPES),
  decisionDocNo: optionalText(120),
  decisionAttachmentId: id.nullish(),
  emergencyStartDate: isoDate.nullish(),
  exceedsOverallTarget: z.boolean().optional(),
  reason,
  lines: z.array(planAdjustmentLineInput).min(1, '至少填写一条调整明细').max(200),
});
export type PlanAdjustmentCreateRequest = z.infer<typeof planAdjustmentCreateRequest>;

export const planAdjustmentReviewRequest = z.object({
  action: z.enum(['approve', 'reject']),
  comment: optionalText(1000),
  exceptionReason: optionalText(500),
  decisionDocNo: optionalText(120),
  decisionAttachmentId: id.nullish(),
});
export type PlanAdjustmentReviewRequest = z.infer<typeof planAdjustmentReviewRequest>;

export interface PlanAttachmentSummaryDto {
  attachmentNo: number;
  title: string;
  sheetCode: PlanSheetCode;
  unitOfMeasure: string;
  leafRowCount: number;
  exactTotalAmount: MoneyString;
  issuedTotalAmount: MoneyString;
  diffReasonCode: string;
  subEntities: string[];
  undertakeDepts: string[];
  rows: {
    seqNo: string;
    itemName: string;
    unit: string;
    amountOrValue: string;
    undertakeOrgName: string | null;
    note: string;
  }[];
}

export interface PlanUnitPackDto {
  id: number;
  cycleId: number;
  unitOrgId: number;
  unitOrgCode: string;
  unitOrgName: string;
  docNo: string;
  issuedDate: string | null;
  attachmentCount: number;
  hasResponsibilityLetter: boolean;
  responsibilityLetterNo: string;
  budgetVersionId: number | null;
  signOffStatus: PlanPackSignStatus;
  ackUserId: number | null;
  ackUserName: string | null;
  ackAt: string | null;
  ackNote: string;
  version: number;
  mergedChildOrgs: { id: number; code: string; name: string }[];
  metrics: {
    operatingRevenue: MoneyString;
    totalRevenue: MoneyString;
    profitBeforeTax: MoneyString;
    netProfit: MoneyString;
    investmentTotal: MoneyString;
    purchaseTotal: MoneyString;
    maintenanceTotal: MoneyString;
    safetyInputTotal: MoneyString;
    fiveExpensesExact: MoneyString;
    fiveExpensesIssued: MoneyString;
    controllableMgmtFeeExact: MoneyString;
    controllableMgmtFeeIssued: MoneyString;
  };
  attachments?: PlanAttachmentSummaryDto[];
  undertakeItems?: {
    itemId: number;
    sheetCode: PlanSheetCode;
    itemName: string;
    ownerUnitOrgId: number;
    ownerUnitOrgName: string;
    undertakeOrgId: number;
    undertakeOrgName: string;
    approvedAmount: MoneyString;
  }[];
  createdAt: string;
  updatedAt: string;
}

export interface PlanTaxCheckItemDto {
  unitOrgId: number | null;
  unitName: string;
  kind: 'vat_maintenance' | 'mgmt_fee_nested' | 'controllable_mgmt_step' | 'cross_unit_formula' | 'consolidation_balance';
  passed: boolean;
  blocking: boolean;
  planInclusiveAmount: MoneyString | null;
  expectedBudgetExclAmount: MoneyString | null;
  actualBudgetExclAmount: MoneyString | null;
  diffAmount: MoneyString;
  reasonCode: string;
  message: string;
}

export interface PlanReconcileReportDto {
  cycleId: number;
  mode: 'strict_compile' | 'legacy_reconcile';
  passed: boolean;
  blockingCount: number;
  warningCount: number;
  vatRateBp: number;
  consolidation: {
    sum8UnitsOperatingRevenue: MoneyString;
    excludedOrgsOperatingRevenue: MoneyString;
    groupConsolidatedOperatingRevenue: MoneyString;
    operatingRevenueSubCentDiff: MoneyString;
    sum8UnitsProfitBeforeTax: MoneyString;
    excludedOrgsProfitBeforeTax: MoneyString;
    groupConsolidatedProfitBeforeTax: MoneyString;
    profitDiff: MoneyString;
    investmentTotal: MoneyString;
    safetyInputTotal: MoneyString;
    fiveExpensesExactTotal: MoneyString;
    fiveExpensesIssuedTotal: MoneyString;
    fiveExpensesStepDiff: MoneyString;
    excludedOrgs: { orgId: number; orgCode: string; orgName: string; operatingRevenue: MoneyString; profitBeforeTax: MoneyString }[];
  };
  checks: PlanTaxCheckItemDto[];
  crossUnitFormulaErrors: PlanWarningDto[];
}

export interface PlanIssuanceCycleDto {
  id: number;
  year: number;
  cycleCode: string;
  issuanceStage: PlanIssuanceStage;
  sourcePlanBatchId: number | null;
  sourceBudgetVersionId: number | null;
  decisionDocMeta: Record<string, unknown>;
  frozenSnapshot: Record<string, unknown>;
  snapshotSha256: string;
  status: PlanCycleStatus;
  version: number;
  unitPackCount: number;
  acknowledgedCount: number;
  excludedOrgs: { id: number; code: string; name: string }[];
  packs?: PlanUnitPackDto[];
  reconcileReport?: PlanReconcileReportDto | null;
  createdByUserId: number | null;
  createdAt: string;
  updatedAt: string;
}

export interface PlanAdjustmentLineDto {
  id: number;
  planItemId: number | null;
  stableItemUid: string;
  targetSheetCode: PlanSheetCode;
  targetItemName: string;
  valueType: PlanAdjustmentValueType;
  scale: number;
  unit: string;
  beforeVal: string;
  afterVal: string;
  deltaVal: string;
  beforeAmount: MoneyString;
  afterAmount: MoneyString;
  deltaAmount: MoneyString;
  budgetAccountId: number | null;
  note: string;
}

export interface PlanAdjustmentDto {
  id: number;
  cycleId: number;
  cycleCode: string;
  unitPackId: number;
  unitOrgId: number;
  unitOrgName: string;
  adjustType: PlanAdjustType;
  adjustTypeLabel: string;
  approvalBody: PlanApprovalBody;
  approvalBodyLabel: string;
  decisionDocNo: string;
  decisionAttachmentId: number | null;
  emergencyStartDate: string | null;
  emergencyOverdue5Workdays: boolean;
  reason: string;
  status: 'submitted' | 'approved' | 'rejected';
  newCycleId: number | null;
  submittedByUserId: number | null;
  submittedByName: string | null;
  submittedAt: string;
  reviewedByUserId: number | null;
  reviewedByName: string | null;
  reviewedAt: string | null;
  reviewComment: string | null;
  exceptionReason: string | null;
  selfReview: boolean;
  lines: PlanAdjustmentLineDto[];
}

export const planReconcileRequest = z.object({
  mode: z.enum(['strict_compile', 'legacy_reconcile']).optional(),
  vatRateBp: z.number().int().min(0).max(5000).optional(),
  groupConsolidatedOperatingRevenue: moneyString.optional(),
  groupConsolidatedProfitBeforeTax: moneyString.optional(),
});
export type PlanReconcileRequest = z.infer<typeof planReconcileRequest>;
