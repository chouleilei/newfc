import { z } from 'zod';
import { expectedVersion, id, optionalText, period, reason, type MoneyString } from './common';

/** AC-F05 EAS 原始事实与期间控制:请求 schema 与响应类型。 */

export const EAS_DATA_TYPES = ['voucher', 'balance', 'auxiliary'] as const;
export type EasDataType = (typeof EAS_DATA_TYPES)[number];

export const easImportForm = z.object({
  dataType: z.enum(EAS_DATA_TYPES),
  /** 可选:页面已选组织时用于核对文件中的公司;不能用它改变解析结果。 */
  orgId: id.optional(),
  correctionId: id.optional(),
});
export type EasImportForm = z.infer<typeof easImportForm>;

export const easPrecheckRequest = z.object({
  orgId: id,
  period,
  batchIds: z.array(id).max(3).optional(),
});
export type EasPrecheckRequest = z.infer<typeof easPrecheckRequest>;

/** expectedCurrentSetId:页面看到的当前生效集合(无则 null);与实际不一致说明有并发激活,返回 EAS_CURRENT_SET_CHANGED。 */
export const easActivateRequest = z.object({ expectedVersion, expectedCurrentSetId: id.nullable() });
export type EasActivateRequest = z.infer<typeof easActivateRequest>;
export const easLockRequest = z.object({ orgId: id, period, setId: id, reason });
export const easUnlockRequest = z.object({ expectedVersion, reason });
export const easCorrectionCreate = z.object({ orgId: id, period, expectedCurrentSetId: id, reason });
export const easCorrectionReview = z.object({
  action: z.enum(['approve', 'return']),
  expectedVersion,
  comment: optionalText(),
  exceptionReason: optionalText(),
});
export const easAuxRequirementCreate = z.object({
  orgId: id,
  accountCode: z.string().trim().min(1).max(64),
  auxType: z.string().trim().min(1).max(32),
});
export type EasLockRequest = z.infer<typeof easLockRequest>;
export type EasCorrectionCreate = z.infer<typeof easCorrectionCreate>;
export type EasCorrectionReview = z.infer<typeof easCorrectionReview>;
export type EasAuxRequirementCreate = z.infer<typeof easAuxRequirementCreate>;

export type EasBatchStatus = 'candidate' | 'active' | 'superseded';
export type EasReconStatus = 'incomplete' | 'failed' | 'passed';
export type EasRuleStatus = 'passed' | 'warning' | 'incomplete' | 'failed';
export type EasCorrectionStatus = 'submitted' | 'candidate_import' | 'pending_review' | 'approved' | 'returned';

export interface EasBatchDto {
  id: number;
  dataType: EasDataType;
  orgId: number;
  orgName: string;
  sourceCompany: string;
  period: string;
  fileName: string;
  fileSha256: string;
  rowCount: number;
  debitTotal: MoneyString;
  creditTotal: MoneyString;
  status: EasBatchStatus;
  isCurrent: boolean;
  correctionId: number | null;
  createdAt: string;
  replayed?: boolean;
}

export interface EasReconResultDto {
  ruleCode: string;
  status: EasRuleStatus;
  diffCount: number;
  diffAmount: MoneyString;
  details: Record<string, unknown>;
}

export interface EasReconSetDto {
  id: number;
  orgId: number;
  orgName: string;
  period: string;
  status: EasReconStatus;
  isCurrent: boolean;
  correctionId: number | null;
  errorCount: number;
  warningCount: number;
  version: number;
  createdAt: string;
  activatedAt: string | null;
  batches: { dataType: EasDataType; batchId: number; fileName: string }[];
  results: EasReconResultDto[];
}

export interface EasPeriodLockDto {
  id: number;
  orgId: number;
  orgName: string;
  period: string;
  status: 'locked' | 'unlocked';
  setId: number;
  reason: string;
  version: number;
  lockedAt: string | null;
  unlockedAt: string | null;
}

export interface EasCorrectionDto {
  id: number;
  orgId: number;
  orgName: string;
  period: string;
  status: EasCorrectionStatus;
  reason: string;
  expectedCurrentSetId: number;
  candidateSetId: number | null;
  version: number;
  submittedByUserId: number | null;
  submittedAt: string;
  reviewedByUserId: number | null;
  reviewedAt: string | null;
  reviewComment: string | null;
  candidateBatches: EasBatchDto[];
  reviews: { action: 'approve' | 'return'; comment: string | null; exceptionReason: string | null; reviewerUserId: number | null; createdAt: string }[];
}

export interface EasVoucherLineDto {
  sourceRow: number; voucherDate: string; voucherNo: string; entryNo: string; accountCode: string; accountName: string;
  summary: string | null; debit: MoneyString; credit: MoneyString; projectCode: string | null; projectName: string | null;
  deptName: string | null; supplierName: string | null; fundSource: string | null;
}
export interface EasBalanceLineDto {
  sourceRow: number; accountCode: string; accountName: string; beginDebit: MoneyString; beginCredit: MoneyString;
  debit: MoneyString; credit: MoneyString; endDebit: MoneyString; endCredit: MoneyString;
  projectCode: string | null; deptName: string | null; supplierName: string | null;
}
export interface EasAuxLineDto {
  sourceRow: number; auxType: string; auxCode: string; auxName: string; accountCode: string; accountName: string;
  begin: MoneyString; debit: MoneyString; credit: MoneyString; end: MoneyString; supplierName: string | null;
}
export interface EasBatchLinesDto {
  batch: EasBatchDto;
  total: number;
  lines: EasVoucherLineDto[] | EasBalanceLineDto[] | EasAuxLineDto[];
}

/** 期间状态(页面与助手同源):当前集合、锁、待处理更正。 */
export interface EasPeriodStatusDto {
  orgId: number;
  orgName: string;
  period: string;
  currentSet: EasReconSetDto | null;
  lock: EasPeriodLockDto | null;
  pendingCorrection: EasCorrectionDto | null;
  candidateBatches: EasBatchDto[];
}

/* ================= GAP-20: EAS 合同质保金 / 往来负余额 / 在建工程遗留对账 ================= */

export const EAS_CONTRACT_RECON_CATEGORIES = [
  'warranty_2241_overdue',
  'supplier_negative_balance',
  'cip_1604_legacy',
] as const;
export type EasContractReconCategory = (typeof EAS_CONTRACT_RECON_CATEGORIES)[number];
export const EAS_CONTRACT_RECON_CATEGORY_LABELS: Record<EasContractReconCategory, string> = {
  warranty_2241_overdue: '质保金 2241 到期未清',
  supplier_negative_balance: '供应商往来异常负余额',
  cip_1604_legacy: '在建工程 1604 长期未转固遗留',
};

export const EAS_RECON_NOTE_STATUSES = ['pending', 'to_writeoff', 'explained_normal', 'resolved'] as const;
export type EasReconNoteStatus = (typeof EAS_RECON_NOTE_STATUSES)[number];
export const EAS_RECON_NOTE_STATUS_LABELS: Record<EasReconNoteStatus, string> = {
  pending: '待核查',
  to_writeoff: '拟核销',
  explained_normal: '正常挂账说明',
  resolved: '已核销结清',
};

export const easContractReconNoteRequest = z.object({
  orgId: id,
  period,
  category: z.enum(EAS_CONTRACT_RECON_CATEGORIES),
  targetKey: z.string().trim().min(1, '核对目标键不能为空').max(200),
  reconStatus: z.enum(EAS_RECON_NOTE_STATUSES),
  voucherRef: z.string().trim().max(100).default(''),
  note: z.string().trim().min(1, '请填写财务核对说明').max(1000),
});
export type EasContractReconNoteRequest = z.infer<typeof easContractReconNoteRequest>;

export interface EasReconNoteDto {
  id: number;
  orgId: number;
  period: string;
  category: EasContractReconCategory;
  targetKey: string;
  reconStatus: EasReconNoteStatus;
  voucherRef: string;
  note: string;
  updatedByName: string | null;
  updatedAt: string;
}

export interface EasContractReconItemDto {
  targetKey: string;
  category: EasContractReconCategory;
  accountCode: string;
  accountName: string;
  projectCode: string | null;
  projectName: string | null;
  projectId: number | null;
  supplierName: string | null;
  supplierId: number | null;
  contractId: number | null;
  contractNo: string | null;
  contractName: string | null;
  bookBalance: MoneyString;
  statusSummary: string;
  overdueDays: number | null;
  anomalyReason: string;
  voucherRefs: string[];
  reconStatus: EasReconNoteStatus;
  voucherRef: string;
  note: string;
  noteUpdatedByName: string | null;
  noteUpdatedAt: string | null;
}

export interface EasContractReconDto {
  orgId: number;
  orgName: string;
  period: string;
  hasActiveBalanceBatch: boolean;
  summary: {
    totalCount: number;
    unresolvedCount: number;
    byCategory: Record<EasContractReconCategory, { count: number; totalAbsAmount: MoneyString }>;
  };
  items: EasContractReconItemDto[];
}
