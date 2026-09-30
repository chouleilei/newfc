import { z } from 'zod';
import { expectedVersion, id, optionalText } from './common';

/**
 * 分析报告契约(T-5,AC-F18)。draft → pending_approval → approved → published;published 只能修订为新修订号的 draft,
 * 新修订发布后旧版 superseded。
 */

export const RPT_KINDS = ['monthly_execution', 'annual_review', 'budget_discussion', 'risk_investment'] as const;
export type RptKind = (typeof RPT_KINDS)[number];
export const RPT_KIND_LABELS: Record<RptKind, string> = {
  monthly_execution: '预算执行月报', annual_review: '年度复盘', budget_discussion: '预算讨论材料', risk_investment: '风险与投资专题',
};
export const RPT_STATUSES = ['draft', 'pending_approval', 'approved', 'published', 'superseded'] as const;
export type RptStatus = (typeof RPT_STATUSES)[number];
export const RPT_STATUS_LABELS: Record<RptStatus, string> = {
  draft: '草稿', pending_approval: '待审批', approved: '已审批', published: '已发布', superseded: '已被新修订替代',
};

const year = z.coerce.number().int().min(2000).max(2100);

export const rptGenerate = z.object({
  kind: z.enum(RPT_KINDS),
  title: z.string().trim().min(1).max(200).optional(),
  orgId: id.optional(),
  year: year.optional(),
  versionId: id.optional(),
  targetVersionId: id.optional(),
  batchId: id.optional(),
  /** 是否尝试模型改写叙述(缺省 true);模型不可用或改动事实时保留模板叙述 */
  useModel: z.boolean().optional(),
}).strict().superRefine((v, ctx) => {
  if ((v.kind === 'monthly_execution' || v.kind === 'budget_discussion') && !v.versionId) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['versionId'], message: '该报告类型需要选择预算版本' });
  if (v.kind === 'annual_review' && !v.year) ctx.addIssue({ code: z.ZodIssueCode.custom, path: ['year'], message: '年度复盘需要选择年度' });
});
export type RptGenerate = z.infer<typeof rptGenerate>;

export const rptListQuery = z.object({
  kind: z.enum(RPT_KINDS).optional(),
  status: z.enum(RPT_STATUSES).optional(),
  orgId: id.optional(),
  keyword: z.string().trim().max(100).optional(),
}).strict();
export type RptListQuery = z.infer<typeof rptListQuery>;

export const rptSectionUpdate = z.object({ expectedVersion, body: z.string().max(50_000), title: z.string().trim().min(1).max(200).optional() }).strict();
export const rptCommand = z.object({ expectedVersion }).strict();
export const rptReturn = z.object({ expectedVersion, comment: z.string().trim().min(1, '退回必须填写意见').max(2000) }).strict();
export const rptApprove = z.object({ expectedVersion, comment: optionalText(2000), exceptionReason: optionalText(500) }).strict();
export const rptExportQuery = z.object({ format: z.enum(['docx', 'pdf']) }).strict();

export interface RptSectionDto {
  id: number; sortOrder: number; key: string; title: string; body: string; facts: unknown; citations: unknown[]; edited: boolean; updatedAt: string;
}
export interface RptReportListItemDto {
  id: number; seriesNo: string; revisionNo: number; previousReportId: number | null; title: string; kind: RptKind; kindLabel: string;
  orgId: number | null; orgName: string | null; year: number | null; status: RptStatus; modelStatus: string; version: number;
  createdByUserId: number | null; createdByName: string | null; createdAt: string; updatedAt: string;
  submittedByUserId: number | null; submittedAt: string | null; approvedByUserId: number | null; approvedAt: string | null;
  publishedByUserId: number | null; publishedAt: string | null;
}
export interface RptReportDto extends RptReportListItemDto {
  params: Record<string, unknown>;
  sections: RptSectionDto[];
  approvalComment: string | null; exceptionReason: string | null; selfApproval: boolean; returnComment: string | null;
  publication: { id: number; snapshotSha256: string; docxFileObjectId: number; pdfFileObjectId: number; createdAt: string } | null;
  editCount: number;
  allowed: ('edit' | 'submit' | 'return' | 'approve' | 'publish' | 'revise' | 'delete')[];
}
export interface RptSectionEditDto { id: number; sectionId: number; sectionTitle: string; beforeBody: string; afterBody: string; actorUserId: number | null; actorName: string | null; createdAt: string }
