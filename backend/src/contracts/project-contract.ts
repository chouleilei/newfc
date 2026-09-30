import { z } from 'zod';
import { expectedVersion, id, moneyString, optionalText, reason, type MoneyString, type RatioString } from './common';
import type { RowErrorDto } from './project-budget';

/** AC-F16 合同生命周期 / AC-F04 合同导入:请求 schema 与响应类型。 */

export const CONTRACT_STAGES = ['initiation', 'procurement', 'drafting', 'approval', 'performance', 'settlement', 'archived'] as const;
export type ContractStage = (typeof CONTRACT_STAGES)[number];
export const CONTRACT_STAGE_LABELS: Record<ContractStage, string> = {
  initiation: '需求立项', procurement: '招采准备', drafting: '合同起草', approval: '审批签署', performance: '履约执行', settlement: '变更结算', archived: '归档关闭',
};
export const CONTRACT_STATUSES = ['active', 'closed', 'terminated', 'voided'] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];
export const CONTRACT_STATUS_LABELS: Record<ContractStatus, string> = { active: '进行中', closed: '已关闭', terminated: '已终止', voided: '已作废' };
export const CONTRACT_DOC_TYPES = ['procurement', 'contract_text', 'signed', 'performance', 'acceptance', 'invoice', 'change', 'settlement', 'other'] as const;
export type ContractDocType = (typeof CONTRACT_DOC_TYPES)[number];
export const CONTRACT_DOC_TYPE_LABELS: Record<ContractDocType, string> = {
  procurement: '招采文件', contract_text: '合同正文', signed: '签署件', performance: '履约记录', acceptance: '验收文件', invoice: '发票',
  change: '变更依据', settlement: '结算文件', other: '其他',
};

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD');
/** 比率:0～1 的小数字符串,最多 6 位。 */
const ratio = z.string().trim().regex(/^(0(\.\d{1,6})?|1(\.0{1,6})?)$/, '比例应为 0～1 的小数(最多 6 位)');

export const contractCreateRequest = z.object({
  contractNo: z.string().trim().min(1).max(64),
  name: z.string().trim().min(1).max(200),
  contractType: z.string().trim().max(50).default(''),
  orgId: id,
  projectId: id.nullish(),
  supplierId: id.nullish(),
  originalAmount: moneyString.default('0'),
  paymentCapRatio: ratio.nullish(),
  signDate: date.nullish(),
  effectiveDate: date.nullish(),
});
export type ContractCreateRequest = z.infer<typeof contractCreateRequest>;
export const contractUpdateRequest = z.object({
  expectedVersion,
  name: z.string().trim().min(1).max(200).optional(),
  contractType: z.string().trim().max(50).optional(),
  projectId: id.nullish(),
  supplierId: id.nullish(),
  originalAmount: moneyString.optional(),
  paymentCapRatio: ratio.nullish(),
  signDate: date.nullish(),
  effectiveDate: date.nullish(),
});
export type ContractUpdateRequest = z.infer<typeof contractUpdateRequest>;
export const contractAdvanceRequest = z.object({ expectedVersion, toStage: z.enum(CONTRACT_STAGES) });
export const contractCommandRequest = z.object({ expectedVersion, reason });
export const contractReopenRequest = z.object({ expectedVersion, reason, targetStage: z.enum(CONTRACT_STAGES).refine((s) => s !== 'archived', '重开目标阶段不能是归档关闭') });
export const contractDocumentForm = z.object({ docType: z.enum(CONTRACT_DOC_TYPES), name: optionalText(200) });
export const contractReviewSubmitRequest = z.object({ documentId: id, note: optionalText(500) });
export const decisionRequest = z.object({
  decision: z.enum(['approve', 'reject']),
  comment: optionalText(500),
  exceptionReason: optionalText(500),
});
export type DecisionRequest = z.infer<typeof decisionRequest>;
export const contractChangeRequest = z.object({ delta: moneyString, reason, evidenceDocumentId: id });
export const contractPaymentRequest = z.object({
  nodeName: z.string().trim().min(1).max(100), amount: moneyString, plannedDate: date.nullish(), evidenceDocumentId: id.nullish(),
});
export const contractPayRequest = z.object({ paidDate: date, voucherNo: optionalText(64), invoiceDocumentId: id });
export const contractListQuery = z.object({
  status: z.enum(CONTRACT_STATUSES).optional(), stage: z.enum(CONTRACT_STAGES).optional(), orgId: id.optional(), projectId: id.optional(),
  keyword: z.string().trim().max(100).optional(),
});
export type ContractListQuery = z.infer<typeof contractListQuery>;

export interface BlockerDto { code: string; message: string }

export interface ContractDto {
  id: number;
  contractNo: string;
  name: string;
  contractType: string;
  orgId: number;
  orgName: string;
  projectId: number | null;
  projectCode: string | null;
  projectName: string | null;
  supplierId: number | null;
  supplierName: string | null;
  originalAmount: MoneyString;
  approvedChange: MoneyString;
  /** 当前金额 = 原始金额 + 已批准变更 */
  currentAmount: MoneyString;
  paidAmount: MoneyString;
  /** 已付 / 当前金额;当前金额为 0 时 null */
  paymentRate: RatioString;
  paymentCapRatio: RatioString;
  stage: ContractStage;
  status: ContractStatus;
  statusReason: string | null;
  signDate: string | null;
  effectiveDate: string | null;
  source: 'manual' | 'import';
  version: number;
  pendingReviews: number;
  pendingChanges: number;
  openPayments: number;
  createdAt: string;
  updatedAt: string;
}

export interface ContractDocumentDto { id: number; docType: ContractDocType; name: string; fileSha256: string; sizeBytes: number; uploadedBy: string | null; uploadedAt: string }
export interface ContractReviewDto {
  id: number; documentId: number; documentName: string; status: 'submitted' | 'approved' | 'rejected'; note: string;
  submittedBy: string | null; submittedAt: string; reviewedBy: string | null; reviewedAt: string | null; comment: string | null; exceptionReason: string | null; selfReview: boolean;
}
export interface ContractChangeDto {
  id: number; delta: MoneyString; reason: string; evidenceDocumentId: number; status: 'submitted' | 'approved' | 'rejected';
  submittedBy: string | null; submittedAt: string; reviewedBy: string | null; reviewedAt: string | null; comment: string | null; exceptionReason: string | null; selfReview: boolean;
}
export interface ContractPaymentDto {
  id: number; kind: 'normal' | 'import_baseline'; nodeName: string; amount: MoneyString; plannedDate: string | null; evidenceDocumentId: number | null;
  status: 'submitted' | 'approved' | 'rejected' | 'paid'; submittedBy: string | null; submittedAt: string; reviewedBy: string | null; reviewedAt: string | null;
  comment: string | null; exceptionReason: string | null; selfReview: boolean; paidDate: string | null; voucherNo: string | null; invoiceDocumentId: number | null;
}
export interface ContractEventDto { id: number; eventType: string; fromStage: ContractStage | null; toStage: ContractStage | null; detail: Record<string, unknown>; actor: string | null; createdAt: string }

export interface ContractDetailDto extends ContractDto {
  nextStage: ContractStage | null;
  /** 推进到下一阶段的阻断项(服务端重算) */
  blockers: BlockerDto[];
  documents: ContractDocumentDto[];
  reviews: ContractReviewDto[];
  changes: ContractChangeDto[];
  payments: ContractPaymentDto[];
  events: ContractEventDto[];
}

export interface ContractSummaryDto {
  count: number;
  byStatus: Record<ContractStatus, number>;
  byStage: Record<ContractStage, number>;
  currentAmount: MoneyString;
  paidAmount: MoneyString;
  paymentRate: RatioString;
  pending: { reviews: number; changes: number; payments: number; unpaidApproved: number };
}

/* ---------------- 合同导入 ---------------- */

export type ContractImportAction = 'create' | 'update' | 'unchanged';
export interface ContractImportRowDto {
  row: number;
  contractNo: string;
  name: string;
  action: ContractImportAction | null;
  contractId: number | null;
  orgName: string | null;
  projectCode: string | null;
  supplierName: string | null;
  amount: MoneyString | null;
  paid: MoneyString | null;
  signDate: string | null;
  /** update 时变化的字段:[原值, 新值] */
  changes: Record<string, [string | null, string | null]>;
}
export interface ContractImportDto {
  id: number;
  fileName: string;
  fileSha256: string;
  status: 'previewed' | 'confirmed';
  rowCount: number;
  errorCount: number;
  errors: RowErrorDto[];
  rows: ContractImportRowDto[];
  counts: Record<ContractImportAction, number>;
  planHash: string;
  createdAt: string;
  confirmedAt: string | null;
  result: { created: number; updated: number; unchanged: number; contractIds: number[] } | null;
  replayed?: boolean;
}
