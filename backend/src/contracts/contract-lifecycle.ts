import type { ContractStatus } from './project-contract';
import { z } from 'zod';
import { expectedVersion, id, moneyString, optionalText, reason, type MoneyString, type RatioString } from './common';

const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '日期格式应为 YYYY-MM-DD');
const ratio = z.string().trim().regex(/^(0(\.\d{1,6})?|1(\.0{1,6})?)$/, '比例应为 0～1 的小数(最多 6 位)');

/** 对齐上级《纪巡财审合同导入》官方模板 20 种币种枚举 */
export const CONTRACT_CURRENCIES = [
  '人民币', '美元', '加元', '澳元', '欧元', '英镑', '港币', '韩元', '日元', '印度卢比',
  '朝鲜元', '澳门元', '新西兰元', '俄罗斯卢布', '瑞典克朗', '新加坡元', '泰铢', '新台币', '南非兰特', '越南盾',
] as const;
export type ContractCurrency = (typeof CONTRACT_CURRENCIES)[number];

export const CONTRACT_DIRECTIONS = ['expense', 'income'] as const;
export type ContractDirection = (typeof CONTRACT_DIRECTIONS)[number];

export const CONTRACT_PRICING_MODES = ['lump_sum', 'unit_price'] as const;
export type ContractPricingMode = (typeof CONTRACT_PRICING_MODES)[number];

export const CONTRACT_REPORT_CATEGORIES = ['engineering', 'goods', 'service', 'other'] as const;
export type ContractReportCategory = (typeof CONTRACT_REPORT_CATEGORIES)[number];

export const CONTRACT_BUDGET_TYPES = ['single_listed', 'lump_sum_pool', 'emergency_unplanned'] as const;
export type ContractBudgetType = (typeof CONTRACT_BUDGET_TYPES)[number];

export const CONTRACT_FUNDING_SOURCES = ['fiscal', 'income_contract', 'self_owned_other'] as const;
export type ContractFundingSource = (typeof CONTRACT_FUNDING_SOURCES)[number];

export const CONTRACT_DECISION_METHODS = ['meeting', 'approval', 'other'] as const;
export type ContractDecisionMethod = (typeof CONTRACT_DECISION_METHODS)[number];

export const CONTRACT_MEETING_TYPES = ['party_committee', 'admin_office', 'board', 'gm_office', 'other'] as const;
export type ContractMeetingType = (typeof CONTRACT_MEETING_TYPES)[number];

export const CONTRACT_ACQUISITION_METHODS = ['tender', 'negotiation', 'other'] as const;
export type ContractAcquisitionMethod = (typeof CONTRACT_ACQUISITION_METHODS)[number];

export const CONTRACT_TENDER_BODY_TYPES = ['consortium', 'single'] as const;
export type ContractTenderBodyType = (typeof CONTRACT_TENDER_BODY_TYPES)[number];

export const CONTRACT_TERM_TYPES = ['fixed', 'conditional', 'unspecified'] as const;
export type ContractTermType = (typeof CONTRACT_TERM_TYPES)[number];

export const CONTRACT_DISTRIBUTION_STATUSES = ['pending', 'completed'] as const;
export type ContractDistributionStatus = (typeof CONTRACT_DISTRIBUTION_STATUSES)[number];

export const CONTRACT_ARCHIVE_STATUSES = ['collecting', 'checked', 'transferred'] as const;
export type ContractArchiveStatus = (typeof CONTRACT_ARCHIVE_STATUSES)[number];

export const SETTLEMENT_KINDS = ['progress', 'final'] as const;
export type SettlementKind = (typeof SETTLEMENT_KINDS)[number];

export const CONTRACT_PAYMENT_TYPES = ['prepayment', 'progress', 'final', 'warranty_release', 'other'] as const;
export type ContractPaymentType = (typeof CONTRACT_PAYMENT_TYPES)[number];

export const CONTRACT_PAYMENT_APPROVAL_TIERS = ['secondary_unit_head', 'finance_vp', 'general_manager', 'collective_decision'] as const;
export type ContractPaymentApprovalTier = (typeof CONTRACT_PAYMENT_APPROVAL_TIERS)[number];

export const CHANGE_KINDS = ['change', 'claim_by_contractor', 'counter_claim', 'suspend', 'terminate'] as const;
export type ChangeKind = (typeof CHANGE_KINDS)[number];

export const CHANGE_APPROVAL_TIERS = ['undertaker_unit', 'undertaker_vp', 'tech_and_undertaker_vp', 'dual_vp', 'general_manager', 'management_board'] as const;
export type ChangeApprovalTier = (typeof CHANGE_APPROVAL_TIERS)[number];

export const GUARANTEE_TYPES = ['bid_bond', 'prepayment_guarantee', 'performance_guarantee', 'warranty_guarantee', 'engineering_insurance'] as const;
export type GuaranteeType = (typeof GUARANTEE_TYPES)[number];

export const GUARANTEE_DIRECTIONS = ['inbound', 'outbound'] as const;
export type GuaranteeDirection = (typeof GUARANTEE_DIRECTIONS)[number];

export const GUARANTEE_STATUSES = ['active', 'expired', 'claimed', 'returned'] as const;
export type GuaranteeStatus = (typeof GUARANTEE_STATUSES)[number];

export const WARRANTY_CONCLUSIONS = ['passed', 'rectifying'] as const;
export type WarrantyConclusion = (typeof WARRANTY_CONCLUSIONS)[number];

export const DISPUTE_STAGES = ['negotiation', 'mediation', 'arbitration', 'litigation_1st', 'litigation_2nd', 'execution', 'closed'] as const;
export type DisputeStage = (typeof DISPUTE_STAGES)[number];

/** 合同底座扩展字段（Create / Update 共用） */
export const contractLifecycleFields = {
  direction: z.enum(CONTRACT_DIRECTIONS).optional(),
  pricingMode: z.enum(CONTRACT_PRICING_MODES).optional(),
  unitPriceDesc: optionalText(500),
  estimatedCeilingAmount: moneyString.nullish(),
  currency: z.enum(CONTRACT_CURRENCIES).optional(),
  exchangeRate: z.string().trim().regex(/^\d+(\.\d{1,6})?$/, '汇率应为最多 6 位小数的正数').nullish(),
  reportCategory: z.enum(CONTRACT_REPORT_CATEGORIES).optional(),
  summaryText: optionalText(2000),
  remark: optionalText(2000),
  planItemId: id.nullish(),
  outOfPlanApprovedDate: date.nullish(),
  budgetType: z.enum(CONTRACT_BUDGET_TYPES).optional(),
  isEmergency: z.boolean().optional(),
  emergencyStartDate: date.nullish(),
  fundingSource: z.enum(CONTRACT_FUNDING_SOURCES).optional(),
  fundingSourceDetail: optionalText(500),
  sourceIncomeContractId: id.nullish(),
  parentContractId: id.nullish(),
  externalNoExempt: z.boolean().optional(),
  counterpartyNames: optionalText(1000),
  undertakerName: optionalText(100),
  undertakerDept: optionalText(100),
  ourSignatoryName: optionalText(100),
  ourSignatoryTitle: optionalText(100),
  ourSignatoryIsLegalRep: z.boolean().nullish(),
  counterpartySignatoryName: optionalText(100),
  counterpartySignatoryTitle: optionalText(100),
  counterpartySignatoryIsLegalRep: z.boolean().nullish(),
  entrustReason: optionalText(1000),
  isTripleMajor: z.boolean().optional(),
  decisionMethod: z.enum(CONTRACT_DECISION_METHODS).nullish(),
  decisionMethodOther: optionalText(200),
  meetingType: z.enum(CONTRACT_MEETING_TYPES).nullish(),
  meetingTypeOther: optionalText(200),
  finalApproverName: optionalText(100),
  finalApproverTitle: optionalText(100),
  isGovProcurement: z.boolean().optional(),
  procurementMethodOther: optionalText(200),
  procurementPlanText: optionalText(500),
  procurementStartDate: date.nullish(),
  supplierConfirmDate: date.nullish(),
  responseDocsComplete: z.boolean().nullish(),
  creditChecked: z.boolean().nullish(),
  bidAwardAmount: moneyString.nullish(),
  acquisitionMethod: z.enum(CONTRACT_ACQUISITION_METHODS).nullish(),
  acquisitionMethodOther: optionalText(200),
  tenderBodyType: z.enum(CONTRACT_TENDER_BODY_TYPES).nullish(),
  consortiumMembers: optionalText(1000),
  deptReviewerName: optionalText(100),
  relatedMgmtDepts: optionalText(500),
  relatedMgmtReviewers: optionalText(500),
  unitApproverName: optionalText(100),
  unitApproverTitle: optionalText(100),
  farmerWageAccount: optionalText(100),
  termType: z.enum(CONTRACT_TERM_TYPES).optional(),
  termStartDate: date.nullish(),
  termEndDate: date.nullish(),
  termConditionText: optionalText(50),
  deliverableSubmitted: z.boolean().nullish(),
  finalAccepted: z.boolean().optional(),
  hasWarranty: z.boolean().optional(),
  warrantyMonths: z.number().int().min(0).max(600).nullish(),
  warrantyRetentionRatio: ratio.nullish(),
};

export const contractSuspendRequest = z.object({
  expectedVersion,
  reason,
  guarantorConsentDocumentId: id.nullish(),
});
export type ContractSuspendRequest = z.infer<typeof contractSuspendRequest>;

export const contractChangeFilingRequest = z.object({
  supplementNo: optionalText(100),
  disciplineFiledAt: date.nullish(),
  techReviewRepliedAt: date.nullish(),
  hasDispute: z.boolean().optional(),
});
export type ContractChangeFilingRequest = z.infer<typeof contractChangeFilingRequest>;

export const contractGuaranteeCreateRequest = z.object({
  guaranteeType: z.enum(GUARANTEE_TYPES),
  direction: z.enum(GUARANTEE_DIRECTIONS).default('inbound'),
  issuerName: z.string().trim().max(200).default(''),
  guaranteeNo: z.string().trim().max(100).default(''),
  amount: moneyString.default('0'),
  depositAmount: moneyString.default('0'),
  ratio: ratio.nullish(),
  effectiveDate: date.nullish(),
  expiryDate: date.nullish(),
  documentId: id.nullish(),
  note: optionalText(500),
});
export type ContractGuaranteeCreateRequest = z.infer<typeof contractGuaranteeCreateRequest>;

export const contractGuaranteeUpdateRequest = z.object({
  status: z.enum(GUARANTEE_STATUSES).optional(),
  effectiveDate: date.nullish(),
  expiryDate: date.nullish(),
  claimOccurredAt: date.nullish(),
  claimReportedAt: date.nullish(),
  returnedDate: date.nullish(),
  documentId: id.nullish(),
  note: optionalText(500),
});
export type ContractGuaranteeUpdateRequest = z.infer<typeof contractGuaranteeUpdateRequest>;

export const contractWarrantyDefectSchema = z.object({
  date,
  description: z.string().trim().min(1).max(500),
  resolved: z.boolean().default(false),
  resolvedDate: date.nullish(),
});

export const contractWarrantyUpsertRequest = z.object({
  startDate: date.nullish(),
  endDate: date.nullish(),
  retentionAmount: moneyString.optional(),
  defectRecords: z.array(contractWarrantyDefectSchema).max(100).optional(),
  inspectionDate: date.nullish(),
  inspectionConclusion: z.enum(WARRANTY_CONCLUSIONS).nullish(),
  visaDocumentId: id.nullish(),
  releasedPaymentId: id.nullish(),
});
export type ContractWarrantyUpsertRequest = z.infer<typeof contractWarrantyUpsertRequest>;

export const contractDisputeCreateRequest = z.object({
  changeId: id.nullish(),
  occurredDate: date,
  reportedToDeptAt: date.nullish(),
  litigationType: optionalText(100),
  causeOfAction: optionalText(200),
  counterpartyAndRole: optionalText(300),
  stage: z.enum(DISPUTE_STAGES).default('negotiation'),
  institutionName: optionalText(200),
  caseNo: optionalText(100),
  involvedOrgName: optionalText(200),
  ourLitigationRole: optionalText(100),
  acceptedDate: date.nullish(),
  caseSummary: optionalText(2000),
  gmApprovedAt: date.nullish(),
  legalDocForm: optionalText(100),
  closedDate: date.nullish(),
  disputeAmount: moneyString.default('0'),
  judgmentResult: optionalText(1000),
  actualSettledAmount: moneyString.nullish(),
  lawFirmAndLawyer: optionalText(300),
  filedToMgmtAt: date.nullish(),
  filedToDisciplineAt: date.nullish(),
});
export type ContractDisputeCreateRequest = z.infer<typeof contractDisputeCreateRequest>;
export const contractDisputeUpdateRequest = contractDisputeCreateRequest.partial();
export type ContractDisputeUpdateRequest = z.infer<typeof contractDisputeUpdateRequest>;

export const contractResumeRequest = z.object({
  expectedVersion,
  reason,
});
export type ContractResumeRequest = z.infer<typeof contractResumeRequest>;

export const contractDistributionRequest = z.object({
  expectedVersion,
  distributedAt: date,
  companyFiledAt: date.nullish(),
  note: optionalText(500),
});
export type ContractDistributionRequest = z.infer<typeof contractDistributionRequest>;

export const contractArchiveStatusRequest = z.object({
  expectedVersion,
  archiveStatus: z.enum(['checked', 'transferred']),
  actionDate: date.optional(),
  transferNo: optionalText(100),
  deferNote: optionalText(500),
});
export type ContractArchiveStatusRequest = z.infer<typeof contractArchiveStatusRequest>;

export const contractHandoverRequest = z.object({
  expectedVersion,
  toUndertaker: z.string().trim().min(1).max(100),
  toDept: optionalText(100),
  reason: optionalText(500),
  leftPostDate: date.nullish(),
  handoverDate: date,
});
export type ContractHandoverRequest = z.infer<typeof contractHandoverRequest>;

export const contractSettlementCreateRequest = z.object({
  settlementKind: z.enum(SETTLEMENT_KINDS).default('progress'),
  settlementDate: date,
  inContractAmount: moneyString.default('0'),
  changeClaimAmount: moneyString.default('0'),
  otherAddAmount: moneyString.default('0'),
  deductPrepaymentAmount: moneyString.default('0'),
  deductRetentionAmount: moneyString.default('0'),
  deductPenaltyAmount: moneyString.default('0'),
  note: optionalText(500),
  evidenceDocumentId: id.nullish(),
});
export type ContractSettlementCreateRequest = z.infer<typeof contractSettlementCreateRequest>;

export const contractReceiptCreateRequest = z.object({
  settlementId: id.nullish(),
  nodeName: z.string().trim().min(1).max(100),
  currency: z.enum(CONTRACT_CURRENCIES).optional(),
  amount: moneyString,
  plannedDate: date.nullish(),
  invoiceDocumentId: id.nullish(),
});
export type ContractReceiptCreateRequest = z.infer<typeof contractReceiptCreateRequest>;

export const contractReceiptReceiveRequest = z.object({
  receivedDate: date,
  voucherNo: optionalText(64),
  invoiceDocumentId: id.nullish(),
});
export type ContractReceiptReceiveRequest = z.infer<typeof contractReceiptReceiveRequest>;

export interface ContractLifecycleMetadataDto {
  direction: ContractDirection;
  pricingMode: ContractPricingMode;
  unitPriceDesc: string;
  estimatedCeilingAmount: MoneyString | null;
  currency: string;
  exchangeRate: string | null;
  reportCategory: ContractReportCategory;
  summaryText: string;
  remark: string;
  planItemId: number | null;
  outOfPlanApprovedDate: string | null;
  budgetType: ContractBudgetType;
  isEmergency: boolean;
  emergencyStartDate: string | null;
  fundingSource: ContractFundingSource;
  fundingSourceDetail: string;
  sourceIncomeContractId: number | null;
  sourceIncomeContractNo: string | null;
  sourceIncomeContractName: string | null;
  parentContractId: number | null;
  externalNoExempt: boolean;
  counterpartyNames: string;
  undertakerName: string;
  undertakerDept: string;
  ourSignatoryName: string;
  ourSignatoryTitle: string;
  ourSignatoryIsLegalRep: boolean | null;
  counterpartySignatoryName: string;
  counterpartySignatoryTitle: string;
  counterpartySignatoryIsLegalRep: boolean | null;
  entrustReason: string;
  isTripleMajor: boolean;
  decisionMethod: ContractDecisionMethod | null;
  decisionMethodOther: string;
  meetingType: ContractMeetingType | null;
  meetingTypeOther: string;
  finalApproverName: string;
  finalApproverTitle: string;
  isGovProcurement: boolean;
  procurementMethodOther: string;
  procurementPlanText: string;
  procurementStartDate: string | null;
  supplierConfirmDate: string | null;
  responseDocsComplete: boolean | null;
  creditChecked: boolean | null;
  bidAwardAmount: MoneyString | null;
  acquisitionMethod: ContractAcquisitionMethod | null;
  acquisitionMethodOther: string;
  tenderBodyType: ContractTenderBodyType | null;
  consortiumMembers: string;
  deptReviewerName: string;
  relatedMgmtDepts: string;
  relatedMgmtReviewers: string;
  unitApproverName: string;
  unitApproverTitle: string;
  farmerWageAccount: string;
  termType: ContractTermType;
  termStartDate: string | null;
  termEndDate: string | null;
  termConditionText: string;
  deliverableSubmitted: boolean | null;
  finalAccepted: boolean;
  hasWarranty: boolean;
  warrantyMonths: number | null;
  warrantyRetentionRatio: RatioString;
  settledGrossAmount: MoneyString;
  settledNetAmount: MoneyString;
  receivedAmount: MoneyString;
  receiptRate: RatioString;
  distributionStatus: ContractDistributionStatus;
  distributedAt: string | null;
  companyFiledAt: string | null;
  archiveStatus: ContractArchiveStatus;
  archiveCheckedAt: string | null;
  archiveTransferredAt: string | null;
  archiveTransferNo: string | null;
  archiveDeferNote: string | null;
}

export interface ContractUndertakerHandoverDto {
  id: number;
  fromUndertaker: string;
  toUndertaker: string;
  toDept: string;
  reason: string;
  leftPostDate: string | null;
  handoverDate: string;
  actor: string | null;
  createdAt: string;
}

export interface ContractSettlementDto {
  id: number;
  periodNo: number;
  settlementKind: SettlementKind;
  settlementDate: string;
  inContractAmount: MoneyString;
  changeClaimAmount: MoneyString;
  otherAddAmount: MoneyString;
  grossPayableAmount: MoneyString;
  deductPrepaymentAmount: MoneyString;
  deductRetentionAmount: MoneyString;
  deductPenaltyAmount: MoneyString;
  totalDeductAmount: MoneyString;
  netPayableAmount: MoneyString;
  note: string;
  evidenceDocumentId: number | null;
  status: 'submitted' | 'approved' | 'rejected';
  submittedBy: string | null;
  submittedAt: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  comment: string | null;
  exceptionReason: string | null;
  selfReview: boolean;
}

export interface ContractReceiptDto {
  id: number;
  kind: 'normal' | 'import_baseline';
  settlementId: number | null;
  nodeName: string;
  currency: string;
  amount: MoneyString;
  plannedDate: string | null;
  invoiceDocumentId: number | null;
  status: 'submitted' | 'approved' | 'rejected' | 'received';
  submittedBy: string | null;
  submittedAt: string;
  reviewedBy: string | null;
  reviewedAt: string | null;
  comment: string | null;
  exceptionReason: string | null;
  selfReview: boolean;
  receivedDate: string | null;
  voucherNo: string | null;
  receivedBy: string | null;
  receivedAt: string | null;
}

export interface ContractGuaranteeDto {
  id: number;
  guaranteeType: GuaranteeType;
  direction: GuaranteeDirection;
  issuerName: string;
  guaranteeNo: string;
  amount: MoneyString;
  depositAmount: MoneyString;
  ratio: RatioString;
  effectiveDate: string | null;
  expiryDate: string | null;
  status: GuaranteeStatus;
  claimOccurredAt: string | null;
  claimReportedAt: string | null;
  returnedDate: string | null;
  documentId: number | null;
  note: string;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ContractWarrantyDto {
  id: number;
  startDate: string | null;
  endDate: string | null;
  retentionAmount: MoneyString;
  defectRecords: Array<{ date: string; description: string; resolved: boolean; resolvedDate: string | null }>;
  inspectionDate: string | null;
  inspectionConclusion: WarrantyConclusion | null;
  visaDocumentId: number | null;
  releasedPaymentId: number | null;
  reviewedBy: string | null;
  reviewedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface ContractDisputeDto {
  id: number;
  changeId: number | null;
  occurredDate: string;
  reportedToDeptAt: string | null;
  litigationType: string;
  causeOfAction: string;
  counterpartyAndRole: string;
  stage: DisputeStage;
  institutionName: string;
  caseNo: string;
  involvedOrgName: string;
  ourLitigationRole: string;
  acceptedDate: string | null;
  caseSummary: string;
  gmApprovedAt: string | null;
  legalDocForm: string;
  closedDate: string | null;
  disputeAmount: MoneyString;
  judgmentResult: string;
  actualSettledAmount: MoneyString | null;
  lawFirmAndLawyer: string;
  filedToMgmtAt: string | null;
  filedToDisciplineAt: string | null;
  createdBy: string | null;
  createdAt: string;
  updatedAt: string;
}

export const EVALUATION_RECOMMENDATIONS = ['preferred', 'normal', 'restricted', 'blacklisted'] as const;
export type EvaluationRecommendation = (typeof EVALUATION_RECOMMENDATIONS)[number];

export const contractEvaluationRequest = z.object({
  qualityScore: z.number().int().min(1).max(5),
  scheduleScore: z.number().int().min(1).max(5),
  serviceScore: z.number().int().min(1).max(5),
  recommendation: z.enum(EVALUATION_RECOMMENDATIONS),
  comment: optionalText(1000),
});
export type ContractEvaluationRequest = z.infer<typeof contractEvaluationRequest>;

export interface ContractEvaluationDto {
  id: number;
  contractId: number;
  supplierId: number | null;
  qualityScore: number;
  scheduleScore: number;
  serviceScore: number;
  totalScore: number;
  recommendation: EvaluationRecommendation;
  comment: string;
  evaluatedBy: string | null;
  evaluatedAt: string;
}

export interface SupervisionPreflightItemDto {
  contractId: number;
  contractNo: string;
  name: string;
  direction: ContractDirection;
  missingFields: string[];
  missingAttachments: string[];
  warnings: string[];
  ready: boolean;
}

export interface SupervisionPreflightDto {
  scopeMode: 'changed' | 'all_active';
  period: string;
  totalCount: number;
  readyCount: number;
  incompleteCount: number;
  items: SupervisionPreflightItemDto[];
}

export interface SupervisionExportLogDto {
  id: number;
  exportKind: 'monthly_ledger' | 'supervision_package';
  orgId: number | null;
  period: string;
  scopeMode: string;
  contractCount: number;
  fileName: string;
  fileSha256: string;
  byteSize: number;
  createdAt: string;
}

export interface SupervisionPortalItemDto {
  status: ContractStatus;
  deleted: boolean;
  id: number;
  contractNo: string;
  name: string;
  direction: ContractDirection;
  reportCategory: ContractReportCategory;
  orgId: number;
  orgName: string;
  orgFullName: string;
  counterpartyNames: string;
  pricingMode: ContractPricingMode;
  currency: string;
  originalAmount: MoneyString;
  approvedChangeAmount: MoneyString;
  currentAmount: MoneyString;
  settledNetAmount: MoneyString;
  paidAmount: MoneyString;
  receivedAmount: MoneyString;
  procurementTier: string | null;
  procurementMethod: string | null;
  supervisionExecStatus: '执行中' | '未完成已中止' | '未完成已终止' | '已完成' | '未签署';
  signDate: string | null;
  ourSignatoryName: string;
  ourSignatoryTitle: string;
  ourSignatoryIsLegalRep: boolean | null;
  counterpartySignatoryIsLegalRep: boolean | null;
  openRiskCount: number;
  version: number;
  updatedAt: string;
}

export interface SupervisionPortalResponseDto {
  generatedAt: string;
  mode: 'full' | 'incremental';
  since: string | null;
  nextSince: string | null;
  nextCursorId: number | null;
  summary: {
    totalContracts: number;
    expenseCount: number;
    incomeCount: number;
    totalSignedAmount: MoneyString;
    totalSettledAmount: MoneyString;
    totalPaidAmount: MoneyString;
    totalReceivedAmount: MoneyString;
    totalApprovedChangeAmount: MoneyString;
    constructionSummary: {
      count: number;
      contractAmount: MoneyString;
      settledAmount: MoneyString;
      paidAmount: MoneyString;
    };
    procurementDistribution: {
      tier1Count: number;
      tier2Count: number;
      tier3Count: number;
      directCount: number;
      directRatio: RatioString;
      inquiryCount: number;
      inquiryRatio: RatioString;
    };
    riskStats: {
      totalAlerts: number;
      rectifiedClosedAlerts: number;
    };
  };
  items: SupervisionPortalItemDto[];
}
