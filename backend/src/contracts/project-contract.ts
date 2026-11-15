import { legalFields, LEGAL_CATEGORIES, PROCUREMENT_METHODS, PROCUREMENT_TARGETS, EVIDENCE_KINDS, type EvidenceKind, type LegalCategory, type LegalMetadata, type ProcurementMethod, type ProcurementTarget, type ProcurementTier } from './contract-legal-review';
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
import { expectedVersion, id, moneyString, optionalText, pageQuery, reason, type MoneyString, type PageDto, type RatioString } from './common';
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
  adverseOccurredAt: date.nullish(),
  adverseReportedAt: date.nullish(),
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
export const CONTRACT_SORT_FIELDS = [
  'updated_at',
  'sign_date',
  'original_cents',
  'contract_no',
  'updatedAt',
  'signDate',
  'originalAmount',
  'currentAmount',
  'contractNo',
] as const;
export type ContractSortField = (typeof CONTRACT_SORT_FIELDS)[number];
export const CONTRACT_SORT_DIRS = ['asc', 'desc'] as const;
export type ContractSortDir = (typeof CONTRACT_SORT_DIRS)[number];

export const contractListQuery = z.object({
  status: z.enum(CONTRACT_STATUSES).optional(), stage: z.enum(CONTRACT_STAGES).optional(), orgId: id.optional(), projectId: id.optional(),
  planItemId: id.optional(),
  direction: z.enum(CONTRACT_DIRECTIONS).optional(), pricingMode: z.enum(CONTRACT_PRICING_MODES).optional(), archiveStatus: z.enum(CONTRACT_ARCHIVE_STATUSES).optional(),
  legalCategory: z.enum(LEGAL_CATEGORIES).optional(),
  procurementMethod: z.enum(PROCUREMENT_METHODS).optional(),
  signDateFrom: date.optional(),
  signDateTo: date.optional(),
  migrationMode: z.enum(['normal', 'legacy_tolerant']).optional(),
  sortBy: z.enum(CONTRACT_SORT_FIELDS).optional(),
  sortDir: z.enum(CONTRACT_SORT_DIRS).optional(),
  keyword: z.string().trim().max(100).optional(),
  /** 工作台待办下钻:进行中且有待审核文档 / 待复核变更 / 待复核付款 / 已批准待支付的合同 */
  todo: z.enum(CONTRACT_TODOS).optional(),
});
export type ContractListQuery = z.infer<typeof contractListQuery>;
export const contractPageQuery = contractListQuery.merge(pageQuery);

export interface ContractCurrencyTotalDto {
  currency: string;
  count: number;
  originalTotal: MoneyString;
  currentTotal: MoneyString;
  settledTotal: MoneyString;
  paidTotal: MoneyString;
  receivedTotal: MoneyString;
}

export interface ContractPageDto extends PageDto<ContractDto> {
  totals?: ContractCurrencyTotalDto[];
}

export const contractDocumentWithdrawRequest = z.object({
  reason: z.string().trim().min(2, '请填写撤回作废原因').max(500),
});
export type ContractDocumentWithdrawRequest = z.infer<typeof contractDocumentWithdrawRequest>;

/* ---------------- T-14 多部门结构化会签与 1:N 招采契约 ---------------- */

export const COUNTERSIGN_DEPTS = ['ANJI', 'JIANGUAN', 'DIAOXIN', 'QIGUAN', 'CAIWU', 'JIESUAN', 'JISHEN'] as const;
export type CountersignDeptCode = (typeof COUNTERSIGN_DEPTS)[number];
export const COUNTERSIGN_DEPT_LABELS: Record<CountersignDeptCode, string> = {
  ANJI: '安技部',
  JIANGUAN: '建管/重大项目部',
  DIAOXIN: '调信部',
  QIGUAN: '企管部',
  CAIWU: '财务部',
  JIESUAN: '财务结算中心',
  JISHEN: '纪审部',
};
export const COUNTERSIGN_STATUSES = ['pending', 'approved', 'returned', 'waived', 'superseded'] as const;
export type CountersignStatus = (typeof COUNTERSIGN_STATUSES)[number];

export interface ContractCountersignDto {
  id: number;
  contractId: number;
  roundNo: number;
  docFingerprint: string;
  deptCode: CountersignDeptCode | string;
  deptName: string;
  triggerReason: string;
  assignedReviewerUserId: number | null;
  assignedReviewerName: string | null;
  reviewerUserId: number | null;
  reviewerName: string;
  dueDate: string | null;
  overdue: boolean;
  canDecide: boolean;
  status: CountersignStatus;
  opinion: string;
  decidedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export const contractCountersignDecideRequest = z.object({
  decision: z.enum(['approved', 'returned', 'waived']),
  opinion: z.string().trim().min(1, '请填写会签意见').max(1000),
  triggerReason: optionalText(300),
});
export type ContractCountersignDecideRequest = z.infer<typeof contractCountersignDecideRequest>;

export const DIRECT_PROCUREMENT_GROUNDS = [
  'ground_1_state_secret',
  'ground_2_sole_source_patent',
  'ground_3_add_on_compatibility',
  'ground_4_emergency_rescue',
  'ground_5_twice_tender_failed',
  'ground_6_group_strategic_mgm',
  'ground_7_gov_designated_tariff',
  'ground_8_internal_subsidiary_cap',
] as const;
export type DirectProcurementGround = (typeof DIRECT_PROCUREMENT_GROUNDS)[number];
export const DIRECT_PROCUREMENT_GROUND_LABELS: Record<DirectProcurementGround, string> = {
  ground_1_state_secret: '情形1：涉及国家秘密或抢险救灾不适宜竞争',
  ground_2_sole_source_patent: '情形2：使用不可替代专利/专有技术只能从唯一供应商采购',
  ground_3_add_on_compatibility: '情形3：原采购后续添购须保证与既有设施服务配套一致',
  ground_4_emergency_rescue: '情形4：突发应急抢修保供时间紧迫无法履行竞争程序',
  ground_5_twice_tender_failed: '情形5：公开/邀请采购连续两次流标且采购文件无歧视条款',
  ground_6_group_strategic_mgm: '情形6：经集团经营层专题决策认定的特殊直接采购（必填决策文号）',
  ground_7_gov_designated_tariff: '情形7：水电气热讯等政府定价或特许专营垄断项目',
  ground_8_internal_subsidiary_cap: '情形8：符合内部关联协同规定且具备法定承接资质项目',
};

export const procurementReviewerInput = z.object({
  reviewerName: z.string().trim().min(1).max(60),
  identity: z.enum(['owner', 'staff', 'external']),
  titleLevel: optionalText(60),
  midTitleYears: z.number().int().min(0).max(60).nullish(),
  hasRegQualification: z.boolean().default(false),
});
export type ProcurementReviewerInput = z.infer<typeof procurementReviewerInput>;

export interface ProcurementReviewerDto {
  id: number;
  reviewerName: string;
  identity: 'owner' | 'staff' | 'external';
  titleLevel: string;
  midTitleYears: number | null;
  hasRegQualification: boolean;
  isQualified: boolean;
}

export const procurementCandidateInput = z.object({
  rank: z.number().int().min(1).max(20),
  vendorName: z.string().trim().min(1).max(200),
  bidAmount: moneyString,
});
export const procurementQuoteInput = z.object({
  vendorName: z.string().trim().min(1).max(200),
  quoteAmount: moneyString,
  selected: z.boolean().default(false),
});

export const procurementRecordSaveRequest = z.object({
  procurementCode: optionalText(64),
  procurementTitle: z.string().trim().min(1, '请填写采购项目名称').max(200),
  projectId: id.nullish(),
  orgId: id,
  procurementTarget: z.enum(PROCUREMENT_TARGETS),
  procurementMethod: z.enum(PROCUREMENT_METHODS),
  estimatedAmount: moneyString.nullish(),
  isLegallyMandatoryTender: z.boolean().default(false),
  undertakerUnitType: z.enum(['dept_center', 'secondary_unit']).nullish(),
  approvalTier: optionalText(64),
  approverName: optionalText(100),
  twiceTenderFailed: z.boolean().default(false),
  mgmDecisionDoc: optionalText(120),
  tenderAgency: optionalText(200),
  planSubmittedAt: date.nullish(),
  announcementDate: date.nullish(),
  prequalSaleStart: date.nullish(),
  prequalSaleEnd: date.nullish(),
  docSaleStartDate: date.nullish(),
  clarificationSiteDate: date.nullish(),
  bidOpenDate: date.nullish(),
  evalReportSubmitDate: date.nullish(),
  evalReportReceiveDate: date.nullish(),
  candidatePublicityStart: date.nullish(),
  candidatePublicityEnd: date.nullish(),
  awardNoticeDate: date.nullish(),
  invitedVendorCount: z.number().int().min(0).max(500).nullish(),
  supplierInPool: z.boolean().nullish(),
  directProcurementGrounds: z.array(z.enum(DIRECT_PROCUREMENT_GROUNDS)).max(8).default([]),
  candidateRanking: z.array(procurementCandidateInput).max(20).default([]),
  comparisonQuotes: z.array(procurementQuoteInput).max(50).default([]),
  protestFlag: z.boolean().default(false),
  protestDetail: optionalText(1000),
  protestResolvedAt: date.nullish(),
  reviewers: z.array(procurementReviewerInput).max(50).default([]),
  updateShared: z.boolean().optional(),
  linkProcurementRecordId: id.nullish(),
});
export type ProcurementRecordSaveRequest = z.infer<typeof procurementRecordSaveRequest>;

export interface ProcurementRecordDto {
  id: number;
  procurementCode: string | null;
  procurementTitle: string;
  projectId: number | null;
  orgId: number;
  orgName: string | null;
  procurementTarget: ProcurementTarget | null;
  procurementMethod: ProcurementMethod | null;
  procurementTier: ProcurementTier | null;
  estimatedAmount: MoneyString | null;
  isTender: boolean;
  isLegallyMandatoryTender: boolean;
  undertakerUnitType: 'dept_center' | 'secondary_unit' | null;
  approvalTier: string;
  approverName: string;
  twiceTenderFailed: boolean;
  isInvoiceReimburse: boolean;
  mgmDecisionDoc: string;
  tenderAgency: string;
  planSubmittedAt: string | null;
  announcementDate: string | null;
  prequalSaleStart: string | null;
  prequalSaleEnd: string | null;
  docSaleStartDate: string | null;
  clarificationSiteDate: string | null;
  bidOpenDate: string | null;
  evalReportSubmitDate: string | null;
  evalReportReceiveDate: string | null;
  candidatePublicityStart: string | null;
  candidatePublicityEnd: string | null;
  awardNoticeDate: string | null;
  invitedVendorCount: number | null;
  committeeSize: number;
  committeeQualifiedCount: number;
  supplierInPool: boolean | null;
  directProcurementGrounds: DirectProcurementGround[];
  candidateRanking: { rank: number; vendorName: string; bidAmount: MoneyString }[];
  comparisonQuotes: { vendorName: string; quoteAmount: MoneyString; selected: boolean }[];
  protestFlag: boolean;
  protestDetail: string;
  protestResolvedAt: string | null;
  reviewers: ProcurementReviewerDto[];
  linkedContracts: { id: number; contractNo: string; name: string; orgId: number; orgName: string; redacted?: boolean }[];
  linkedContractCount: number;
  warnings: string[];
  createdAt: string;
  updatedAt: string;
}

export const monthlyReportLogRequest = z.object({
  orgId: id.optional(),
  reportMonth: z.string().regex(/^\d{4}-(0[1-9]|1[0-2])$/, '月份格式应为 YYYY-MM'),
  oaRefNo: z.string().trim().min(1, '请填写 OA 报送流程单号或回执号').max(120),
  receiptAttachmentId: id.nullish(),
});
export type MonthlyReportLogRequest = z.infer<typeof monthlyReportLogRequest>;

export interface MonthlyReportLogDto {
  id: number;
  orgId: number;
  orgName: string;
  reportMonth: string;
  exportedAt: string | null;
  submittedAt: string | null;
  oaRefNo: string;
  receiptAttachmentId: number | null;
  submittedByName: string | null;
}

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
  planItemName?: string | null;
  parentContractNo?: string | null;
  annualPlanAllocAmount?: MoneyString | null;
  budgetPoolAccountId?: number | null;
  budgetPoolCapAmount?: MoneyString | null;
  budgetPoolUsedAmount?: MoneyString | null;
  budgetPoolRemainingAmount?: MoneyString | null;
  procurementRecordId?: number | null;
  linkedProcurementContractCount?: number;
  createdAt: string;
  updatedAt: string;
}

export interface ContractDocumentDto {
  evidenceKind?: EvidenceKind | null; changeId?: number | null; changeSupplementNo?: string | null;
  withdrawnAt?: string | null; withdrawReason?: string; canWithdraw?: boolean;
  id: number; docType: ContractDocType; name: string; fileSha256: string; sizeBytes: number; uploadedBy: string | null; uploadedAt: string;
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
  adverseOccurredAt?: string | null; adverseReportedAt?: string | null; adverseOverdue2Workdays?: boolean;
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
  countersigns?: ContractCountersignDto[];
  procurementRecord?: ProcurementRecordDto | null;
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
