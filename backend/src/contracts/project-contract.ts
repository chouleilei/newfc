import { legalFields, EVIDENCE_KINDS, type EvidenceKind, type LegalMetadata } from './contract-legal-review';
import {
  CONTRACT_ARCHIVE_STATUSES, CONTRACT_CURRENCIES, CONTRACT_DIRECTIONS, CONTRACT_PAYMENT_APPROVAL_TIERS, CONTRACT_PAYMENT_TYPES, CONTRACT_PRICING_MODES,
  CHANGE_APPROVAL_TIERS, CHANGE_KINDS, CONTRACT_DECISION_METHODS, CONTRACT_MEETING_TYPES,
  contractLifecycleFields, type ChangeApprovalTier, type ChangeKind, type ContractArchiveStatus, type ContractDecisionMethod, type ContractDirection,
  type ContractDisputeDto, type ContractGuaranteeDto, type ContractLifecycleMetadataDto, type ContractMeetingType, type ContractPaymentApprovalTier,
  type ContractPaymentType, type ContractPricingMode, type ContractReceiptDto, type ContractSettlementDto, type ContractUndertakerHandoverDto,
  type ContractWarrantyDto,
  type ContractEvaluationDto,
  type ContractCurrencyLineDto,
  type LegacyReconciliationDto,
} from './contract-lifecycle';
import { z } from 'zod';
import { expectedVersion, id, moneyString, optionalText, pageQuery, reason, type MoneyString, type RatioString } from './common';
import type { RowErrorDto } from './project-budget';
export * from './contract-lifecycle';

/** AC-F16 合同生命周期 / AC-F04 合同导入:请求 schema 与响应类型。 */

export const CONTRACT_STAGES = ['initiation', 'procurement', 'drafting', 'approval', 'performance', 'settlement', 'warranty', 'closed'] as const;
export type ContractStage = (typeof CONTRACT_STAGES)[number];
export const CONTRACT_STAGE_LABELS: Record<ContractStage, string> = {
  initiation: '需求立项', procurement: '招采准备', drafting: '合同起草', approval: '审批签署', performance: '履约执行', settlement: '验收结算', warranty: '质保维护', closed: '履约完结',
};
export const CONTRACT_STATUSES = ['active', 'suspended', 'closed', 'terminated', 'voided'] as const;
export type ContractStatus = (typeof CONTRACT_STATUSES)[number];
export const CONTRACT_STATUS_LABELS: Record<ContractStatus, string> = { active: '进行中', suspended: '已中止', closed: '已完成', terminated: '已终止', voided: '已作废' };
export const CONTRACT_DOC_TYPES = [
  'procurement', 'contract_text', 'signed', 'performance', 'acceptance', 'invoice', 'change', 'settlement',
  'authorization', 'qualification', 'guarantee', 'dispute', 'other',
] as const;
export type ContractDocType = (typeof CONTRACT_DOC_TYPES)[number];
export const CONTRACT_DOC_TYPE_LABELS: Record<ContractDocType, string> = {
  procurement: '招采文件', contract_text: '合同正文', signed: '签署件', performance: '履约记录', acceptance: '验收文件', invoice: '发票',
  change: '变更依据', settlement: '结算文件', authorization: '签署授权书', qualification: '资信/资格审查', guarantee: '保函/保险单', dispute: '纠纷/法律文书', other: '其他',
};

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD');
/** 比率:0～1 的小数字符串,最多 6 位。 */
const ratio = z.string().trim().regex(/^(0(\.\d{1,6})?|1(\.0{1,6})?)$/, '比例应为 0～1 的小数(最多 6 位)');

export const contractCreateRequest = z.object({
  ...legalFields,
  ...contractLifecycleFields,
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
  ...legalFields,
  ...contractLifecycleFields,
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
export const contractCommandRequest = z.object({
  expectedVersion, reason,
  guarantorConsentDocumentId: id.nullish(),
  approvalTier: z.enum(CHANGE_APPROVAL_TIERS).nullish(),
  terminationAgreementDocumentId: id.nullish(),
});
export type ContractCommandRequest = z.infer<typeof contractCommandRequest>;
export const contractReopenRequest = z.object({ expectedVersion, reason, targetStage: z.enum(CONTRACT_STAGES).refine((s) => s !== 'closed', '重开目标阶段不能是履约完结') });
export const contractDocumentForm = z.object({
  docType: z.enum(CONTRACT_DOC_TYPES), name: optionalText(200), evidenceKind: z.enum(EVIDENCE_KINDS).optional(), changeId: id.optional(),
});
export const contractReviewSubmitRequest = z.object({ documentId: id, note: optionalText(500) });
export const decisionRequest = z.object({
  decision: z.enum(['approve', 'reject']),
  comment: optionalText(500),
  exceptionReason: optionalText(500),
});
export type DecisionRequest = z.infer<typeof decisionRequest>;
export const contractChangeRequest = z.object({
  changeKind: z.enum(CHANGE_KINDS).optional(),
  delta: moneyString.default('0'),
  changeMatter: optionalText(500),
  reason,
  evidenceDocumentId: id,
  involvesBizOrEntityChange: z.boolean().optional(),
  involvesTechChange: z.boolean().optional(),
  isIndependentDelegable: z.boolean().optional(),
  decisionMethod: z.enum(CONTRACT_DECISION_METHODS).nullish(),
  decisionMethodOther: optionalText(200),
  meetingType: z.enum(CONTRACT_MEETING_TYPES).nullish(),
  meetingTypeOther: optionalText(200),
  finalApproverName: optionalText(100),
  finalApproverTitle: optionalText(100),
  actualApprovalTier: z.enum(CHANGE_APPROVAL_TIERS).nullish(),
  supplementNo: optionalText(100),
  hasDispute: z.boolean().optional(),
  techReviewAppliedAt: date.nullish(),
  techReviewRepliedAt: date.nullish(),
  techSpecialAuditDocId: id.nullish(),
  outOfPlanDocId: id.nullish(),
  guarantorConsentDocumentId: id.nullish(),
  disciplineFiledAt: date.nullish(),
});
export type ContractChangeRequest = Omit<z.infer<typeof contractChangeRequest>, 'delta'> & { delta?: MoneyString };
export const contractPaymentRequest = z.object({
  nodeName: z.string().trim().min(1).max(100), amount: moneyString, plannedDate: date.nullish(), evidenceDocumentId: id.nullish(),
  feasibilityDocId: id.nullish(),
  settlementId: id.nullish(), paymentType: z.enum(CONTRACT_PAYMENT_TYPES).optional(), currency: z.enum(CONTRACT_CURRENCIES).optional(),
  approvalTier: z.enum(CONTRACT_PAYMENT_APPROVAL_TIERS).nullish(), approverName: optionalText(100), approverTitle: optionalText(100),
  approvalDocId: id.nullish(), isFarmerWageTransfer: z.boolean().optional(),
});
export type ContractPaymentRequest = z.infer<typeof contractPaymentRequest>;
export const contractPayRequest = z.object({ paidDate: date, voucherNo: optionalText(64), invoiceDocumentId: id });
export type ContractPayRequest = z.infer<typeof contractPayRequest>;
export const CONTRACT_TODOS = ['review', 'change', 'payment', 'pay', 'settlement', 'receipt', 'distribution', 'guarantee_warranty'] as const;
export type ContractTodo = (typeof CONTRACT_TODOS)[number];
export const contractListQuery = z.object({
  status: z.enum(CONTRACT_STATUSES).optional(), stage: z.enum(CONTRACT_STAGES).optional(), orgId: id.optional(), projectId: id.optional(),
  direction: z.enum(CONTRACT_DIRECTIONS).optional(), pricingMode: z.enum(CONTRACT_PRICING_MODES).optional(), archiveStatus: z.enum(CONTRACT_ARCHIVE_STATUSES).optional(),
  keyword: z.string().trim().max(100).optional(),
  /** 工作台待办下钻:进行中且有待审核文档 / 待复核变更 / 待复核付款 / 已批准待支付的合同 */
  todo: z.enum(CONTRACT_TODOS).optional(),
});
export type ContractListQuery = z.infer<typeof contractListQuery>;
export const contractPageQuery = contractListQuery.merge(pageQuery);

export interface BlockerDto { code: string; message: string }

export interface ContractDto extends Partial<LegalMetadata>, Partial<ContractLifecycleMetadataDto> {
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
  pendingSettlements?: number;
  openReceipts?: number;
  createdAt: string;
  updatedAt: string;
}

export interface ContractDocumentDto {
  evidenceKind?: EvidenceKind | null; changeId?: number | null; id: number; docType: ContractDocType; name: string; fileSha256: string; sizeBytes: number; uploadedBy: string | null; uploadedAt: string;
}
export interface ContractReviewDto {
  legalRunId?: number|null; overrideHighRisk?: boolean;
  id: number; documentId: number; documentName: string; status: 'submitted' | 'approved' | 'rejected'; note: string;
  submittedBy: string | null; submittedAt: string; reviewedBy: string | null; reviewedAt: string | null; comment: string | null; exceptionReason: string | null; selfReview: boolean;
}
export interface ContractChangeDto {
  id: number; delta: MoneyString; reason: string; evidenceDocumentId: number; status: 'submitted' | 'approved' | 'rejected';
  changeKind?: ChangeKind; changeMatter?: string; orgRootId?: number | null;
  involvesBizOrEntityChange?: boolean; involvesTechChange?: boolean; isIndependentDelegable?: boolean;
  decisionMethod?: ContractDecisionMethod | null; decisionMethodOther?: string;
  meetingType?: ContractMeetingType | null; meetingTypeOther?: string;
  finalApproverName?: string; finalApproverTitle?: string;
  requiredApprovalTier?: ChangeApprovalTier; actualApprovalTier?: ChangeApprovalTier | null;
  supplementNo?: string | null; hasDispute?: boolean;
  techReviewAppliedAt?: string | null; techReviewRepliedAt?: string | null;
  techSpecialAuditDocId?: number | null; outOfPlanDocId?: number | null; guarantorConsentDocId?: number | null; disciplineFiledAt?: string | null;
  submittedBy: string | null; submittedAt: string; reviewedBy: string | null; reviewedAt: string | null; comment: string | null; exceptionReason: string | null; selfReview: boolean;
}
export interface ContractPaymentDto {
  id: number; kind: 'normal' | 'import_baseline'; nodeName: string; amount: MoneyString; plannedDate: string | null; evidenceDocumentId: number | null;
  settlementId?: number | null; paymentType?: ContractPaymentType; currency?: string;
  approvalTier?: ContractPaymentApprovalTier | null; approverName?: string; approverTitle?: string; approvalDocId?: number | null; isFarmerWageTransfer?: boolean;
  status: 'submitted' | 'approved' | 'rejected' | 'paid'; submittedBy: string | null; submittedAt: string; reviewedBy: string | null; reviewedAt: string | null;
  comment: string | null; exceptionReason: string | null; selfReview: boolean; paidDate: string | null; voucherNo: string | null; invoiceDocumentId: number | null;
}
export interface ContractEventDto { id: number; eventType: string; fromStage: ContractStage | null; toStage: ContractStage | null; detail: Record<string, unknown>; actor: string | null; createdAt: string }

export interface ContractDetailDto extends ContractDto {
  /** Server-derived: includes default categories, important contracts and any legal-review job/run. */
  legalReviewEnabled: boolean;
  nextStage: ContractStage | null;
  /** 推进到下一阶段的阻断项(服务端重算) */
  blockers: BlockerDto[];
  documents: ContractDocumentDto[];
  reviews: ContractReviewDto[];
  changes: ContractChangeDto[];
  settlements?: ContractSettlementDto[];
  payments: ContractPaymentDto[];
  receipts?: ContractReceiptDto[];
  guarantees?: ContractGuaranteeDto[];
  warranty?: ContractWarrantyDto | null;
  disputes?: ContractDisputeDto[];
  handovers?: ContractUndertakerHandoverDto[];
  evaluation?: ContractEvaluationDto | null;
  events: ContractEventDto[];
}

export interface ContractSummaryDto {
  count: number;
  byStatus: Record<ContractStatus, number>;
  byStage: Record<ContractStage, number>;
  currentAmount: MoneyString;
  paidAmount: MoneyString;
  paymentRate: RatioString;
  incomeCurrentAmount?: MoneyString;
  receivedAmount?: MoneyString;
  receiptRate?: RatioString;
  foreignCurrencyCount?: number;
  pending: { reviews: number; changes: number; payments: number; unpaidApproved: number };
}

/* ---------------- 合同导入 ---------------- */

export const CONTRACT_IMPORT_KINDS = [
  'standard_ledger', 'monthly_ledger_wan',
  'supervision_expense_base', 'supervision_expense_exec', 'supervision_expense_change',
  'supervision_income_base', 'supervision_income_exec', 'supervision_income_change',
] as const;
export type ContractImportKind = (typeof CONTRACT_IMPORT_KINDS)[number];
export const CONTRACT_IMPORT_KIND_LABELS: Record<ContractImportKind, string> = {
  standard_ledger: '标准合同台账',
  monthly_ledger_wan: '公司月报合同台账(万元)',
  supervision_expense_base: '纪巡财审 · 支出合同基本信息',
  supervision_expense_exec: '纪巡财审 · 支出合同执行及实付',
  supervision_expense_change: '纪巡财审 · 支出合同变更与纠纷',
  supervision_income_base: '纪巡财审 · 收入合同基本信息',
  supervision_income_exec: '纪巡财审 · 收入合同执行及实收',
  supervision_income_change: '纪巡财审 · 收入合同变更与纠纷',
};
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
  direction?: ContractDirection;
  pricingMode?: ContractPricingMode;
  detailSummary?: string;
  currency?: string;
  exchangeRate?: string | null;
  signingOrgId?: number | null;
  signingOrgName?: string | null;
  legalEntityOrgId?: number | null;
  legalEntityOrgName?: string | null;
  coManagedOrgName?: string | null;
  canonicalEntityCode?: string;
  legacyPrefixCode?: string;
  legacyRawNo?: string;
  noExemptReason?: string;
  rawAmountText?: string;
  rawSignDateText?: string;
  foreignAmountText?: string;
  missingFields?: string[];
  isReversal?: boolean;
  syntheticNoFlag?: boolean;
  duplicateConflictGroup?: string;
  isInternalGroupTx?: boolean;
  amountFactSource?: 'confirmed_contract' | 'unit_price_open' | 'voucher_debit_clue' | 'unverified_forecast';
  currencyStructStatus?: 'single' | 'structured_multi' | 'partial_unstructured';
  currencyLines?: ContractCurrencyLineDto[];
  legacySettledBaselineAmount?: MoneyString | null;
  /** update 时变化的字段:[原值, 新值] */
  changes: Record<string, [string | null, string | null]>;
}
export interface ContractImportDto {
  id: number;
  importKind?: ContractImportKind | 'legacy_batch_upsert';
  importMode?: 'standard' | 'legacy_tolerant';
  paidOrReceivedLabel?: '已付金额' | '已收金额';
  missingFieldCount?: number;
  syntheticNoCount?: number;
  reversalCount?: number;
  duplicateSkippedCount?: number;
  reconciliation?: LegacyReconciliationDto | null;
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
