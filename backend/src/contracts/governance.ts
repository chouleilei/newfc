import { z } from 'zod';
import { expectedVersion, id, optionalText, period, reason } from './common';

/** AC-F06 数据治理:请求 schema 与响应类型。 */

export const GOV_SOURCE_TYPES = ['eas_recon', 'eas_master', 'statement'] as const;
export type GovSourceType = (typeof GOV_SOURCE_TYPES)[number];
export const GOV_ISSUE_STATUSES = ['open', 'pending_review', 'resolved', 'dismissed'] as const;
export type GovIssueStatus = (typeof GOV_ISSUE_STATUSES)[number];
export type GovDispositionKind = 'mapping_override' | 'false_positive' | 'reimport';

export const govScanRequest = z.object({ orgId: id.optional(), period: period.optional() });
export type GovScanRequest = z.infer<typeof govScanRequest>;

/** 处置:映射覆盖需 targetId(项目/供应商主数据 ID);重新导入需 setId(已激活的新 EAS 集合)。 */
export const govDispositionCreate = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('mapping_override'), expectedVersion, reason, targetId: id }),
  z.object({ kind: z.literal('false_positive'), expectedVersion, reason }),
  z.object({ kind: z.literal('reimport'), expectedVersion, reason, setId: id }),
]);
export type GovDispositionCreate = z.infer<typeof govDispositionCreate>;

export const govReviewRequest = z.object({
  action: z.enum(['approve', 'return']),
  comment: optionalText(),
  exceptionReason: optionalText(),
});
export type GovReviewRequest = z.infer<typeof govReviewRequest>;

export interface GovScanResultDto { created: number; updated: number; reopened: number; unchanged: number; scannedAt: string }

export interface GovDispositionDto {
  id: number;
  kind: GovDispositionKind;
  payload: Record<string, unknown>;
  reason: string;
  status: 'pending_review' | 'approved' | 'returned';
  sourceHashBefore: string;
  submittedByUserId: number | null;
  submittedAt: string;
  review: { action: 'approve' | 'return'; comment: string | null; exceptionReason: string | null; reviewerUserId: number | null; createdAt: string } | null;
  proof: { beforeHash: string; afterHash: string; verified: boolean; detail: Record<string, unknown>; createdAt: string } | null;
}

export interface GovIssueDto {
  id: number;
  sourceType: GovSourceType;
  problemType: string;
  sourceRef: string;
  orgId: number | null;
  orgName: string | null;
  period: string;
  severity: 'error' | 'warning';
  title: string;
  detail: Record<string, unknown>;
  sourceHash: string;
  status: GovIssueStatus;
  reopenCount: number;
  version: number;
  firstSeenAt: string;
  lastSeenAt: string;
  closedAt: string | null;
  dispositions?: GovDispositionDto[];
}

export interface GovVerifyDto { issueId: number; sourceHash: string; unchanged: true; checkedAt: string }

/** T-7(AC-F06)质量评分:按来源分维度,固定扣分规则,范围内统计。 */
export interface GovQualityDimensionDto {
  key: string; label: string; sourceType: GovSourceType; weight: string; score: string;
  total: number; openErrors: number; openWarnings: number; pendingReview: number; closed: number;
}
export interface GovQualityScoreDto {
  score: string;
  grade: '优' | '良' | '中' | '差';
  dimensions: GovQualityDimensionDto[];
  totals: { total: number; open: number; pendingReview: number; resolved: number; dismissed: number };
  formula: string;
  computedAt: string;
}

/** T-7(AC-F06)主数据匹配建议:只读,采用走映射覆盖处置 → 复核。 */
export interface GovMatchSuggestionDto {
  issueId: number;
  issueVersion: number;
  status: GovIssueStatus;
  entity: 'project' | 'supplier';
  value: string;
  orgName: string | null;
  period: string;
  lineCount: number;
  sourceNames: string[];
  suggestions: { targetId: number; code: string | null; name: string; confidence: string; reason: string }[];
}
