import { z } from 'zod';
import { expectedVersion, id, moneyString, optionalText, reason, type MoneyString } from './common';

/** AC-F22 费用审核:请求 schema 与响应类型。规则见 specs/implementation.md T-4「费用审核」。 */

export const CLAIM_STATUSES = ['draft', 'submitted', 'audited', 'reviewed', 'supplement'] as const;
export type ClaimStatus = (typeof CLAIM_STATUSES)[number];
export const CLAIM_STATUS_LABELS: Record<ClaimStatus, string> = {
  draft: '草稿', submitted: '审核中', audited: '待复核', reviewed: '已复核', supplement: '退回补件',
};
export const FINDING_SEVERITIES = ['info', 'low', 'medium', 'high'] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];
export const FINDING_SOURCES = ['rule', 'ocr', 'model'] as const;
export type FindingSource = (typeof FINDING_SOURCES)[number];
export const RISK_LEVELS = ['low', 'medium', 'high'] as const;
export type RiskLevel = (typeof RISK_LEVELS)[number];
export const REVIEW_CONCLUSIONS = ['pass', 'reject', 'supplement_required'] as const;
export type ReviewConclusion = (typeof REVIEW_CONCLUSIONS)[number];
export const REVIEW_CONCLUSION_LABELS: Record<ReviewConclusion, string> = { pass: '通过', reject: '驳回', supplement_required: '退回补件' };
/** 发现处置:确认问题 / 排除(误报或已核实无碍) / 缺失材料(需补件)。 */
export const DISPOSITIONS = ['confirmed', 'dismissed', 'missing_material'] as const;
export type Disposition = (typeof DISPOSITIONS)[number];
export const DISPOSITION_LABELS: Record<Disposition, string> = { confirmed: '确认问题', dismissed: '排除', missing_material: '缺失材料' };

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD');
const positiveMoney = moneyString.refine((v) => !v.startsWith('-') && !/^0+(\.0+)?$/.test(v), '金额必须大于 0');
const keyword = z.string().trim().min(1).max(30);
const expenseType = z.string().trim().min(1, '费用类型不能为空').max(50);

export const policyClauseInput = z.object({
  clauseNo: z.string().trim().min(1).max(30),
  clauseText: z.string().trim().min(1).max(2000),
  expenseTypes: z.array(expenseType).max(20).default([]),
  limit: moneyString.refine((v) => !v.startsWith('-'), '金额上限不能为负').nullish(),
  requiredKeywords: z.array(keyword).max(20).default([]),
  /** 必备材料至少命中几项;空 = 全部命中。lishui 首版规则为 min(2, 关键词数)。 */
  keywordMinMatches: z.number().int().min(1).max(20).nullish(),
}).refine((c) => c.keywordMinMatches == null || c.keywordMinMatches <= c.requiredKeywords.length,
  { message: '至少命中数不能大于关键词数', path: ['keywordMinMatches'] });
export const policyCreateRequest = z.object({
  code: z.string().trim().min(1).max(50),
  title: z.string().trim().min(1).max(200),
  effectiveFrom: date,
  effectiveTo: date.nullish(),
  clauses: z.array(policyClauseInput).min(1, '至少一条条款').max(200),
}).refine((v) => !v.effectiveTo || v.effectiveTo >= v.effectiveFrom, { message: '失效日期不能早于生效日期', path: ['effectiveTo'] })
  .refine((v) => new Set(v.clauses.map((c) => c.clauseNo)).size === v.clauses.length, { message: '条款号不能重复', path: ['clauses'] });
export type PolicyCreateRequest = z.infer<typeof policyCreateRequest>;
export const policyRetireRequest = z.object({ reason });

export const claimLineInput = z.object({
  expenseType,
  amount: positiveMoney,
  invoiceNo: z.string().trim().max(64).default(''),
  invoiceDate: date.nullish(),
  description: z.string().trim().max(500).default(''),
});
const claimFields = {
  orgId: id,
  applicant: z.string().trim().min(1, '申请人不能为空').max(50),
  department: z.string().trim().max(100).default(''),
  expenseType,
  amount: positiveMoney,
  occurredDate: date,
  description: z.string().trim().max(1000).default(''),
  lines: z.array(claimLineInput).max(200).default([]),
};
export const claimCreateRequest = z.object({ claimNo: z.string().trim().max(64).optional(), ...claimFields });
export type ClaimCreateRequest = z.infer<typeof claimCreateRequest>;
export const claimUpdateRequest = z.object({ expectedReviewVersion: expectedVersion, ...claimFields });
export type ClaimUpdateRequest = z.infer<typeof claimUpdateRequest>;
export const claimSubmitRequest = z.object({ expectedReviewVersion: expectedVersion });
export const claimAttachmentForm = z.object({ kindHint: optionalText(50), name: optionalText(200) });
export const claimListQuery = z.object({
  status: z.enum(CLAIM_STATUSES).optional(), orgId: id.optional(), keyword: z.string().trim().max(100).optional(),
});
export type ClaimListQuery = z.infer<typeof claimListQuery>;
export const claimReviewRequest = z.object({
  expectedReviewVersion: expectedVersion,
  runId: id,
  conclusion: z.enum(REVIEW_CONCLUSIONS),
  dispositions: z.array(z.object({ findingId: id, disposition: z.enum(DISPOSITIONS), note: optionalText(500) })).max(500).default([]),
  comment: optionalText(1000),
  exceptionReason: optionalText(500),
});
export type ClaimReviewRequest = z.infer<typeof claimReviewRequest>;

export interface PolicyClauseDto {
  id: number; clauseNo: string; clauseText: string; expenseTypes: string[]; limit: MoneyString | null; requiredKeywords: string[]; keywordMinMatches: number | null;
}
export interface PolicyDto {
  id: number; code: string; title: string; version: number; effectiveFrom: string; effectiveTo: string | null; status: 'active' | 'retired';
  hasSource: boolean; clauses: PolicyClauseDto[]; createdAt: string; updatedAt: string;
}

export interface ClaimLineDto { id: number; lineNo: number; expenseType: string; amount: MoneyString; invoiceNo: string; invoiceDate: string | null; description: string }
export interface ClaimAttachmentDto { id: number; name: string; kindHint: string; sha256: string; submitRound: number; uploadedAt: string }
/** 证据引用:字段 / 明细号 / 附件 / OCR 页 / 条款。 */
export interface EvidenceRef { kind: 'field' | 'line' | 'attachment' | 'ocr' | 'clause'; ref: string; text?: string }
export interface FindingDto {
  id: number; source: FindingSource; code: string; severity: FindingSeverity; message: string; evidence: EvidenceRef[];
  clauseId: number | null; clauseLabel: string | null;
}
export interface AuditRunDto {
  id: number; reviewVersion: number; contentSha256: string; jobId: number | null; riskLevel: RiskLevel;
  ocrStatus: 'ok' | 'unavailable' | 'failed' | 'not_needed'; modelStatus: 'ok' | 'unavailable' | 'invalid' | 'failed';
  policyRefs: { policyId: number; code: string; version: number }[]; findings: FindingDto[]; createdAt: string;
}
export interface ClaimReviewDto {
  id: number; runId: number; reviewVersion: number; conclusion: ReviewConclusion;
  dispositions: { findingId: number; disposition: Disposition; note?: string }[];
  comment: string; exceptionReason: string | null; selfReview: boolean; reviewerName: string | null; createdAt: string;
}
export interface ClaimDto {
  id: number; claimNo: string; orgId: number; orgName: string; applicant: string; department: string; expenseType: string; amount: MoneyString;
  occurredDate: string; description: string; status: ClaimStatus; conclusion: 'pass' | 'reject' | null; reviewVersion: number; submitRound: number;
  contentSha256: string | null; submittedByName: string | null; submittedAt: string | null; latestRiskLevel: RiskLevel | null; createdAt: string; updatedAt: string;
}
export interface ClaimDetailDto extends ClaimDto {
  lines: ClaimLineDto[]; attachments: ClaimAttachmentDto[]; runs: AuditRunDto[]; reviews: ClaimReviewDto[];
  /** 最新审核运行(对应当前 reviewVersion 与内容哈希);没有时为 null。 */
  currentRunId: number | null;
}
export interface ClaimSubmitResultDto { claim: ClaimDetailDto; jobId: number }
export interface ExpenseQueueDto {
  counts: Record<ClaimStatus, number>;
  awaitingReview: { id: number; claimNo: string; orgName: string; applicant: string; amount: MoneyString; riskLevel: RiskLevel | null; submittedAt: string | null }[];
}
