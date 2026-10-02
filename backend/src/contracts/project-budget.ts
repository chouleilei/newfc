import { z } from 'zod';
import { id, pageQuery, period, reason, type MoneyString, type RatioString } from './common';

/** AC-F09 项目预算:请求 schema 与响应类型。 */

export const year = z.coerce.number().int().min(2000).max(2100);
export const pbBatchListQuery = z.object({
  year: year.optional(), period: period.optional(), status: z.enum(['imported', 'voided']).optional(),
  keyword: z.string().trim().max(100).optional(),
});
export type PbBatchListQuery = z.infer<typeof pbBatchListQuery>;
export const pbBatchPageQuery = pbBatchListQuery.merge(pageQuery);

/** multipart 表单字段(预览与导入相同):年度 + 执行期间(须在年度内)。 */
export const pbUploadForm = z.object({ year, period, name: z.string().trim().max(100).optional() })
  .refine((v) => v.period.startsWith(`${v.year}-`), { message: '执行期间必须在预算年度内', path: ['period'] });
export type PbUploadForm = z.infer<typeof pbUploadForm>;
export const pbActivateRequest = z.object({ expectedCurrentBatchId: id.nullable() });
export const pbVoidRequest = z.object({ reason });
export const pbSummaryQuery = z.object({
  year: year.optional(), period: period.optional(), batchId: id.optional(), orgId: id.optional(), projectId: id.optional(),
});
export type PbSummaryQuery = z.infer<typeof pbSummaryQuery>;

export interface RowErrorDto { row: number; field: string; message: string }

export interface PbEntryDto {
  rowNo: number;
  projectId: number;
  projectCode: string;
  projectName: string;
  orgId: number;
  orgName: string;
  fundSource: string;
  expenseCategory: string;
  execMonth: string;
  budget: MoneyString;
  executed: MoneyString;
  remaining: MoneyString;
  /** 已执行 / 年度预算;预算为 0 时 null */
  executionRate: RatioString;
}

export interface PbTotalsDto { budget: MoneyString; executed: MoneyString; remaining: MoneyString; executionRate: RatioString }

export interface PbPreviewDto {
  valid: boolean;
  rowCount: number;
  errors: RowErrorDto[];
  totals: PbTotalsDto;
  orgNames: string[];
  rows: PbEntryDto[];
}

export interface PbBatchDto {
  id: number;
  year: number;
  period: string;
  name: string;
  fileName: string;
  fileSha256: string;
  status: 'imported' | 'voided';
  isCurrent: boolean;
  rowCount: number;
  /** 当前账号可见的明细汇总;批次含范围外组织时 partial=true */
  totals: PbTotalsDto;
  partial: boolean;
  orgNames: string[];
  version: number;
  createdAt: string;
  activatedAt: string | null;
  voidedAt: string | null;
  voidReason: string | null;
  replayed?: boolean;
}

export interface PbGroupDto extends PbTotalsDto { key: string; label: string; orgName?: string }

export interface PbSummaryDto {
  batch: PbBatchDto | null;
  year: number | null;
  period: string | null;
  totals: PbTotalsDto;
  byProject: (PbGroupDto & { projectId: number; projectCode: string })[];
  byOrg: (PbGroupDto & { orgId: number })[];
  byFundSource: PbGroupDto[];
  /** 没有当前批次等说明 */
  notes: string[];
}
