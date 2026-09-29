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

export const easActivateRequest = z.object({ expectedVersion });
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
