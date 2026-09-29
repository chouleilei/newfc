import { z } from 'zod';
import { id, optionalText, period } from './common';
import { STATEMENT_SCOPES } from './statements';

/** AC-F19 标准报表:请求 schema 与响应类型。 */

export const STD_REPORT_TYPES = ['budget_execution', 'statement_summary', 'eas_recon'] as const;
export type StdReportType = (typeof STD_REPORT_TYPES)[number];
export const STD_REPORT_TYPE_LABELS: Record<StdReportType, string> = {
  budget_execution: '经营预算执行表', statement_summary: '财务报表摘要', eas_recon: 'EAS 对账结果表',
};

/**
 * 生成请求:
 * - budget_execution:year + 可选 versionId(缺省为该年当前采用预算)+ 可选 orgId(缺省为全组织,需全组织权限);
 * - statement_summary:orgId + period + 可选 scope(缺省合并口径优先);
 * - eas_recon:orgId + period(取当前集合)。
 */
export const stdReportGenerate = z.discriminatedUnion('reportType', [
  z.object({ reportType: z.literal('budget_execution'), year: z.coerce.number().int().min(1900).max(9999), versionId: id.optional(), orgId: id.optional() }),
  z.object({ reportType: z.literal('statement_summary'), orgId: id, period, scope: z.enum(STATEMENT_SCOPES).optional() }),
  z.object({ reportType: z.literal('eas_recon'), orgId: id, period }),
]);
export type StdReportGenerate = z.infer<typeof stdReportGenerate>;

export const stdReportReview = z.object({ comment: optionalText(), exceptionReason: optionalText() });
export type StdReportReview = z.infer<typeof stdReportReview>;

export type StdCellValue = string | number | null;
export interface StdColumnDto { key: string; label: string; kind: 'text' | 'money' | 'ratio' | 'integer' }

export interface StdReportListItemDto {
  id: number; reportType: StdReportType; title: string; orgId: number | null; orgName: string | null; period: string;
  status: 'generated' | 'reviewed'; rowCount: number; generatedByUserId: number | null; generatedAt: string; reviewedByUserId: number | null; reviewedAt: string | null;
}
export interface StdReportDto extends StdReportListItemDto {
  params: Record<string, unknown>;
  columns: StdColumnDto[];
  rows: Record<string, StdCellValue>[];
  summary: { label: string; value: string }[];
  sources: Record<string, unknown>;
  contentSha256: string;
  reviewComment: string | null; exceptionReason: string | null; selfReview: boolean;
}
