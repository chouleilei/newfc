import { z } from 'zod';
import { id, period, reason, type MoneyString, type RatioString } from './common';

/** AC-F10 财务报表:请求 schema 与响应类型。 */

export const STATEMENT_SCOPES = ['parent', 'subsidiary', 'consolidated'] as const;
export type StatementScope = (typeof STATEMENT_SCOPES)[number];
export const STATEMENT_SHEET_CODES = ['balance_sheet', 'income_statement', 'cash_flow_statement', 'equity_change_statement'] as const;
export type StatementSheetCode = (typeof STATEMENT_SHEET_CODES)[number];

/** multipart 表单字段(预览与导入相同)。 */
export const statementUploadForm = z.object({ orgId: id, period, scope: z.enum(STATEMENT_SCOPES) });
export type StatementUploadForm = z.infer<typeof statementUploadForm>;
/** expectedCurrentBatchId:页面看到的当前批次(无则 null),与实际不一致返回 CURRENT_BATCH_CHANGED。 */
export const statementActivateRequest = z.object({ expectedCurrentBatchId: id.nullable() });
export const statementVoidRequest = z.object({ reason });

export interface StatementCheckDto { code: string; level: 'error' | 'warning'; message: string; sheetCode?: StatementSheetCode; sourceCell?: string; extra?: Record<string, string> }
export interface StatementSheetDto { code: StatementSheetCode; name: string; itemCount: number; factCount: number; formulaCount: number }

/** 语义指标:键名写明口径,资产负债表 *_period_end(期末余额),利润表/现金流量表 *_ytd(本年累计)。 */
export const STATEMENT_METRICS = [
  'total_assets_period_end', 'total_liabilities_period_end', 'owner_equity_period_end', 'liability_equity_total_period_end',
  'revenue_ytd', 'cost_ytd', 'operating_profit_ytd', 'total_profit_ytd', 'net_profit_ytd',
  'operating_cash_flow_ytd', 'investing_cash_flow_ytd', 'financing_cash_flow_ytd', 'cash_net_increase_ytd', 'cash_beginning_ytd', 'cash_ending_ytd',
] as const;
export type StatementMetricCode = (typeof STATEMENT_METRICS)[number];
export const STATEMENT_METRIC_LABELS: Record<StatementMetricCode, string> = {
  total_assets_period_end: '总资产(期末)', total_liabilities_period_end: '总负债(期末)', owner_equity_period_end: '所有者权益(期末)',
  liability_equity_total_period_end: '负债和所有者权益总计(期末)', revenue_ytd: '营业总收入(本年累计)', cost_ytd: '营业总成本(本年累计)',
  operating_profit_ytd: '营业利润(本年累计)', total_profit_ytd: '利润总额(本年累计)', net_profit_ytd: '净利润(本年累计)',
  operating_cash_flow_ytd: '经营活动现金流量净额(本年累计)', investing_cash_flow_ytd: '投资活动现金流量净额(本年累计)',
  financing_cash_flow_ytd: '筹资活动现金流量净额(本年累计)', cash_net_increase_ytd: '现金净增加额(本年累计)',
  cash_beginning_ytd: '期初现金余额', cash_ending_ytd: '期末现金余额',
};
export type StatementMetricsDto = Record<StatementMetricCode, MoneyString | null>;
export interface StatementRatiosDto { debt_asset_ratio: RatioString; equity_ratio: RatioString; net_profit_margin: RatioString }

export interface StatementPreviewDto {
  valid: boolean;
  checks: StatementCheckDto[];
  sheets: StatementSheetDto[];
  ignoredSheets: string[];
  metrics: StatementMetricsDto;
  itemCount: number;
  factCount: number;
  previewItems: StatementItemDto[];
}

export interface StatementBatchDto {
  id: number;
  orgId: number;
  orgName: string;
  period: string;
  scope: StatementScope;
  fileName: string;
  fileSha256: string;
  templateVersion: string;
  status: 'imported' | 'active' | 'superseded' | 'voided';
  isCurrent: boolean;
  itemCount: number;
  factCount: number;
  warningCount: number;
  checks: StatementCheckDto[];
  sheets: StatementSheetDto[];
  version: number;
  createdAt: string;
  activatedAt: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  replayed?: boolean;
}

export interface StatementFactDto { fieldKey: string; fieldName: string; amount: MoneyString | null; textValue: string | null; formulaText: string | null; sourceCell: string }
export interface StatementItemDto {
  sheetCode: StatementSheetCode; side: 'asset' | 'liability_equity' | null; rowNo: number; lineNo: string | null; itemName: string;
  semanticKey: string | null; itemType: 'total' | 'subtotal' | 'detail'; facts: StatementFactDto[];
}

export interface StatementOverviewDto {
  batch: StatementBatchDto | null;
  metrics: StatementMetricsDto | null;
  ratios: StatementRatiosDto | null;
  unitComparison: { batchId: number; orgId: number; orgName: string; scope: StatementScope; period: string; totalAssets: MoneyString | null; netProfitYtd: MoneyString | null; debtAssetRatio: RatioString }[];
}

/** 本年累计类流量指标:趋势中可按相邻期间相减得到当月发生额(1 月即累计数)。 */
export const STATEMENT_FLOW_METRICS = [
  'revenue_ytd', 'cost_ytd', 'operating_profit_ytd', 'total_profit_ytd', 'net_profit_ytd',
  'operating_cash_flow_ytd', 'investing_cash_flow_ytd', 'financing_cash_flow_ytd', 'cash_net_increase_ytd',
] as const satisfies readonly StatementMetricCode[];
export type StatementFlowMetricCode = (typeof STATEMENT_FLOW_METRICS)[number];

/** 多期趋势(对应 lishui `/financial-statements/trends`):同一报表单位 + 口径的当前批次按期间排列。 */
export interface StatementTrendPointDto {
  period: string; batchId: number; metrics: StatementMetricsDto; ratios: StatementRatiosDto;
  /** 当月发生额;上一期间缺失(非 1 月)时为 null。 */
  monthly: Record<StatementFlowMetricCode, MoneyString | null>;
}
export interface StatementTrendDto {
  orgId: number | null; orgName: string | null; scope: StatementScope | null; from: string | null; to: string | null;
  points: StatementTrendPointDto[];
  /** 区间内缺少当前批次的期间。 */
  missingPeriods: string[];
}
