import { z } from 'zod';
export const LEGAL_CATEGORIES = [
  'goods_procurement',
  'small_construction',
  'tech_service',
  'general_service',
  'construction',
  'income_sales',
  'important_special',
  'other',
] as const;
export const PARTY_ROLES = [
  'buyer',
  'seller',
  'employer',
  'contractor',
  'client',
  'provider',
  'other',
] as const;
export const PROCUREMENT_TARGETS = [
  'construction',
  'goods',
  'service',
] as const;
export const PROCUREMENT_METHODS = [
  'public_tender',
  'invited_tender',
  'negotiation',
  'inquiry',
  'bidding',
  'direct',
  'direct_reimburse',
] as const;
/** 签约前法审快照计入的签订依据枚举（与履约/结算/签署授权等事后证据严格隔离，AC-CLM-05） */
export const LEGAL_PRE_REVIEW_EVIDENCE_KINDS = [
  'procurement_scheme_approval',
  'bid_award_approval',
  'award_notice',
  'evaluation_report',
  'company_approval',
  'client_written_offer',
  'legal_opinion',
  'triple_major_decision',
  'tech_spec',
  'safety_protocol',
] as const;
export const EVIDENCE_KINDS = [
  ...LEGAL_PRE_REVIEW_EVIDENCE_KINDS,
  'supplier_qualification',
  'our_signatory_auth',
  'counterparty_signatory_auth',
  'change_decision',
  'change_agreement',
  'guarantor_consent',
  'termination_agreement',
  'warranty_release_visa',
  'payment_approval_form',
  'out_of_plan_approval',
  'tech_special_audit',
  'funding_feasibility',
  'boq_quantity_settlement',
  'boq_price_settlement',
  'other',
] as const;
export type EvidenceKind = (typeof EVIDENCE_KINDS)[number];
export type LegalCategory = (typeof LEGAL_CATEGORIES)[number];
export type ProcurementTier =
  | 'tier_1'
  | 'tier_2'
  | 'tier_3'
  | 'exempt_small'
  | 'non_procurement';
export const legalFields = {
  legalCategory: z.enum(LEGAL_CATEGORIES).optional(),
  partyRole: z.enum(PARTY_ROLES).optional(),
  signingEntityLevel: z.enum(['company', 'secondary_unit']).optional(),
  isProcurement: z.boolean().optional(),
  procurementTarget: z.enum(PROCUREMENT_TARGETS).nullish(),
  procurementMethod: z.enum(PROCUREMENT_METHODS).nullish(),
  isImportant: z.boolean().optional(),
};
export interface LegalMetadata {
  legalCategory: LegalCategory;
  partyRole: (typeof PARTY_ROLES)[number];
  signingEntityLevel: 'company' | 'secondary_unit';
  isProcurement: boolean;
  procurementTarget: (typeof PROCUREMENT_TARGETS)[number] | null;
  procurementMethod: (typeof PROCUREMENT_METHODS)[number] | null;
  procurementTier: ProcurementTier | null;
  isImportant: boolean;
}
const text = z.string().trim().min(1).max(16000);
const clause = z
  .object({
    clauseNo: text.max(60),
    chapterTitle: text.max(200),
    clauseText: text,
    ruleTags: z.array(z.string().max(80)).max(30).default([]),
  })
  .strict();
export const policyPublishRequest = z
  .object({
    code: text.max(80),
    version: z.number().int().positive().safe(),
    title: text.max(300),
    docNo: text.max(200),
    effectiveFrom: z.string().date('生效日期不合法'),
    sourceNote: text.max(2000),
    clauses: z
      .array(clause)
      .min(1)
      .max(500)
      .refine(
        (items) => new Set(items.map((c) => c.clauseNo)).size === items.length,
        '条款编号不能重复',
      ),
  })
  .strict();
const templateClause = z
  .object({
    clauseKey: text.max(80),
    clauseNo: text.max(60),
    title: text.max(200),
    tier: z.enum(['fixed', 'default_ref', 'placeholder']),
    standardText: text,
    defaultValueNote: z.string().max(2000).default(''),
    placeholderKeys: z.array(z.string().max(100)).max(50).default([]),
    policyClauseRef: z.number().int().positive().nullish(),
  })
  .strict();
export const templatePublishRequest = z
  .object({
    code: text.max(80),
    version: z.number().int().positive().safe(),
    name: text.max(300),
    legalCategory: z.enum(LEGAL_CATEGORIES),
    approvalStatus: z.enum(['candidate', 'official']).default('candidate'),
    notes: text.max(2000),
    clauses: z
      .array(templateClause)
      .min(1)
      .max(500)
      .refine(
        (items) => new Set(items.map((c) => c.clauseKey)).size === items.length,
        '条款识别码不能重复',
      ),
  })
  .strict();
export const catalogReasonRequest = z
  .object({ reason: z.string().trim().min(1).max(2000) })
  .strict();
export type PolicyInput = z.infer<typeof policyPublishRequest>;
export type TemplateInput = z.infer<typeof templatePublishRequest>;
export interface PolicyDto extends PolicyInput {
  id: number;
  status: 'active' | 'retired';
  sourceFileObjectId: number | null;
  clauses: (PolicyInput['clauses'][number] & { id: number })[];
}
export interface TemplateDto extends Omit<TemplateInput, 'approvalStatus'> {
  id: number;
  approvalStatus: 'candidate' | 'official' | 'retired';
  sourceFileObjectId: number | null;
  clauses: (TemplateInput['clauses'][number] & { id: number })[];
}
export type Verdict = 'pass' | 'revise' | 'manual_review';
export type Severity = 'high' | 'medium' | 'low' | 'info';
export interface LegalFinding {
  id?: number;
  source: 'rule' | 'template_diff' | 'parse_ocr' | 'model';
  code: string;
  severity: Severity;
  blocking: boolean;
  title: string;
  message: string;
  locationRef: string;
  excerpt: string;
  expectedText: string;
  suggestedText: string;
  policyClauseId: number | null;
  templateClauseId: number | null;
}
export interface LegalRunDto {
  id: number;
  contractId: number;
  documentId: number;
  documentSha256: string;
  contractVersion: number;
  contextFingerprint: string;
  policyRefs: { id: number; code: string; version: number }[];
  templateId: number | null;
  templateApprovalStatus: string | null;
  jobId: number | null;
  parseChannel: string;
  parseStatus: string;
  modelStatus: string;
  verdict: Verdict;
  riskLevel: Severity;
  summary: string[];
  elements: Record<string, string | string[]>;
  stats: Record<string, number | boolean | string>;
  createdAt: string;
  isCurrent: boolean;
  findings: LegalFinding[];
}
export interface LegalReviewsDto {
  lastJob?: { id: number; status: string; error: string } | null;
  runs: LegalRunDto[];
  activeJob: {
    id: number;
    status: string;
    progress: number;
    message: string;
  } | null;
}

export function procurementTier(
  procurement: boolean,
  target: string | null,
  amount: bigint,
  method: string | null,
): ProcurementTier | null {
  if (!procurement) return 'non_procurement';
  if (!target) return null;
  if (method === 'direct_reimburse' && amount <= 3000000n)
    return 'exempt_small';
  const limits =
    target === 'construction'
      ? [300000000n, 100000000n]
      : target === 'goods'
        ? [150000000n, 50000000n]
        : [100000000n, 30000000n];
  return amount >= limits[0]
    ? 'tier_1'
    : amount >= limits[1]
      ? 'tier_2'
      : 'tier_3';
}
