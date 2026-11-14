import { z } from 'zod';
import { id, period, reason, type MoneyString, type RatioString } from './common';
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
  code: 'MISSING_PROJECT_CODE' | 'STALE_YEAR_HEADER' | 'PLACEHOLDER_SHEET_SKIPPED' | 'ZERO_PLACEHOLDER_ROW';
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
