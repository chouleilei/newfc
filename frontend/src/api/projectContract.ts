import type { LegalReviewsDto, PolicyDto as LegalPolicyDto, TemplateDto as LegalTemplateDto, EvidenceKind } from '@contracts/contract-legal-review';
/**
 * T-4 项目预算、计划执行、合同与费用审核接口。
 * 类型取自后端共享契约(@contracts/*,仅 import type)。
 */
import { api } from './client';
import { qs } from './financeData';
import type { PageDto, PageQuery } from '@contracts/common';
import type { PbBatchDto, PbBatchListQuery, PbEntryDto, PbPreviewDto, PbSummaryDto } from '@contracts/project-budget';
import type {
  PlanBatchDto, PlanItemDto, PlanOverviewDto, PlanPreviewDto, PlanProjectProgressListDto, PlanSheetCode,
  PlanAdjustmentCreateRequest, PlanAdjustmentDto, PlanAdjustmentReviewRequest,
  PlanIssuanceCycleCreateRequest, PlanIssuanceCycleDto, PlanPackAcknowledgeRequest,
  PlanReconcileReportDto, PlanReconcileRequest, PlanUnitPackDto,
} from '@contracts/plan-execution';
import type {
  ContractArchiveStatusRequest, ContractChangeFilingRequest, ContractChangeRequest, ContractDistributionRequest, ContractHandoverRequest,
  ContractPaymentRequest, ContractReceiptCreateRequest, ContractReceiptReceiveRequest, ContractSettlementCreateRequest,
  ContractDisputeCreateRequest, ContractDisputeUpdateRequest, ContractGuaranteeCreateRequest, ContractGuaranteeUpdateRequest, ContractWarrantyUpsertRequest,
  ContractEvaluationRequest, SupervisionExportLogDto, SupervisionPortalResponseDto, SupervisionPreflightDto,
  ContractCountersignDecideRequest, ContractCountersignDto, ContractCreateRequest, ContractDetailDto,
  ContractDocType, ContractDocumentDto, ContractDto, ContractImportDto, ContractListQuery, ContractPageDto,
  ContractStage, ContractSummaryDto, MonthlyReportLogDto, MonthlyReportLogRequest,
  ProcurementRecordDto, ProcurementRecordSaveRequest,
  DecisionRequest,
  ChangeKind, ChangeTierPreviewDto, ContractImportKind, ContractNextNoDto, ContractPrefixMapCreateRequest,
  ContractPrefixMapDto, ContractPrefixMapPatchRequest, PaymentTierPreviewDto, PrefixEntityStatus, SupervisionExportPurpose,
} from '@contracts/project-contract';
import type {
  ClaimAttachmentDto, ClaimCreateRequest, ClaimDetailDto, ClaimDto, ClaimListQuery, ClaimReviewRequest, ClaimSubmitResultDto, ClaimUpdateRequest, ExpenseQueueDto,
  PolicyCreateRequest, PolicyDto,
} from '@contracts/expense';

export type * from '@contracts/project-budget';
export type * from '@contracts/plan-execution';
export type * from '@contracts/project-contract';
export type * from '@contracts/expense';

function form(file: File, fields: Record<string, string | number | undefined>): FormData {
  const fd = new FormData();
  fd.append('file', file);
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== '') fd.append(k, String(v));
  return fd;
}

function multiForm(files: File[], fields: Record<string, string | number | undefined>): FormData {
  const fd = new FormData();
  for (const f of files) fd.append('file', f);
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== '') fd.append(k, String(v));
  return fd;
}

export interface PbUploadFields { year: number; period: string; name?: string }
export const projectBudgetApi = {
  preview: (file: File, f: PbUploadFields) => api.post<PbPreviewDto>('/project-budget/preview', form(file, { ...f })),
  importFile: (file: File, f: PbUploadFields) => api.post<PbBatchDto>('/project-budget/import', form(file, { ...f })),
  batches: (q: { year?: number; period?: string; status?: string }) => api.get<PbBatchDto[]>(`/project-budget/batches${qs(q)}`),
  batchesPage: (q: PbBatchListQuery & PageQuery) => api.get<PageDto<PbBatchDto>>(`/project-budget/batches/page${qs({ ...q })}`),
  batch: (id: number) => api.get<PbBatchDto>(`/project-budget/batches/${id}`),
  entries: (id: number) => api.get<PbEntryDto[]>(`/project-budget/batches/${id}/entries`),
  activate: (id: number, expectedCurrentBatchId: number | null) => api.post<PbBatchDto>(`/project-budget/batches/${id}/activate`, { expectedCurrentBatchId }),
  void: (id: number, reason: string) => api.post<PbBatchDto>(`/project-budget/batches/${id}/void`, { reason }),
  summary: (q: { year?: number; period?: string; batchId?: number; orgId?: number; projectId?: number }) => api.get<PbSummaryDto>(`/project-budget/summary${qs(q)}`),
};

export interface PlanUploadFields { year: number; actualPeriod: string }
export interface PlanQueryFields { year: number; asOfPeriod?: string; orgId?: number; projectId?: number }
export const planApi = {
  batch: (id: number) => api.get<PlanBatchDto>(`/plan/batches/${id}`),
  preview: (file: File, f: PlanUploadFields) => api.post<PlanPreviewDto>('/plan/preview', form(file, { ...f })),
  importFile: (file: File, f: PlanUploadFields) => api.post<PlanBatchDto>('/plan/import', form(file, { ...f })),
  batches: (q: { year?: number; status?: string }) => api.get<PlanBatchDto[]>(`/plan/batches${qs(q)}`),
  items: (id: number, sheet?: PlanSheetCode) => api.get<PlanItemDto[]>(`/plan/batches/${id}/items${qs({ sheet })}`),
  activate: (id: number, expectedCurrentBatchId: number | null) => api.post<PlanBatchDto>(`/plan/batches/${id}/activate`, { expectedCurrentBatchId }),
  void: (id: number, reason: string) => api.post<PlanBatchDto>(`/plan/batches/${id}/void`, { reason }),
  overview: (q: PlanQueryFields) => api.get<PlanOverviewDto>(`/plan/overview${qs({ ...q })}`),
  projects: (q: PlanQueryFields) => api.get<PlanProjectProgressListDto>(`/plan/projects${qs({ ...q })}`),
  templatePath: (year?: number) => `/plan/template${qs({ year })}`,
  exportBatchPath: (id: number) => `/plan/batches/${id}/export`,
  cycles: (q?: { year?: number; status?: string }) =>
    api.get<{ items: PlanIssuanceCycleDto[] }>(`/plan/issuance/cycles${qs(q ?? {})}`),
  createCycle: (body: PlanIssuanceCycleCreateRequest) =>
    api.post<PlanIssuanceCycleDto>('/plan/issuance/cycles', body),
  cycle: (id: number) => api.get<PlanIssuanceCycleDto>(`/plan/issuance/cycles/${id}`),
  reconcileCycle: (id: number, body?: PlanReconcileRequest) =>
    api.post<PlanReconcileReportDto>(`/plan/issuance/cycles/${id}/reconcile`, body ?? {}),
  publishCycle: (id: number) =>
    api.post<PlanIssuanceCycleDto>(`/plan/issuance/cycles/${id}/publish`, {}),
  exportCycleZipPath: (id: number) => `/plan/issuance/cycles/${id}/export-zip`,
  packs: (q?: { cycleId?: number; year?: number; status?: string; view?: 'unit' | 'undertake' }) =>
    api.get<{ items: PlanUnitPackDto[] }>(`/plan/issuance/packs${qs(q ?? {})}`),
  pack: (id: number) => api.get<PlanUnitPackDto>(`/plan/issuance/packs/${id}`),
  acknowledgePack: (id: number, body: PlanPackAcknowledgeRequest) =>
    api.post<PlanUnitPackDto>(`/plan/issuance/packs/${id}/acknowledge`, body),
  exportPackDocxPath: (id: number) => `/plan/issuance/packs/${id}/export-docx`,
  adjustments: (q?: { cycleId?: number; status?: string }) =>
    api.get<{ items: PlanAdjustmentDto[] }>(`/plan/issuance/adjustments${qs(q ?? {})}`),
  createAdjustment: (body: PlanAdjustmentCreateRequest) =>
    api.post<PlanAdjustmentDto>('/plan/issuance/adjustments', body),
  reviewAdjustment: (id: number, body: PlanAdjustmentReviewRequest) =>
    api.post<PlanAdjustmentDto>(`/plan/issuance/adjustments/${id}/review`, body),
};

type Decision = Partial<DecisionRequest> & Pick<DecisionRequest, 'decision'>;
export const contractApi = {
  legalReviews:(id:number)=>api.get<LegalReviewsDto>(`/contracts/${id}/legal-reviews`),
  runLegalReview:(id:number)=>api.post<{jobId:number;deduplicated:boolean}>(`/contracts/${id}/legal-reviews/run`,{}),
  legalPolicies:()=>api.get<LegalPolicyDto[]>('/contracts/legal-catalog/policies'),
  legalTemplates:()=>api.get<LegalTemplateDto[]>('/contracts/legal-catalog/templates'),
  publishLegal:(kind:'policies'|'templates',body:unknown)=>api.post(`/contracts/legal-catalog/${kind}`,body),
  changeLegal:(kind:'policies'|'templates',id:number,action:'retire'|'promote',reason:string)=>api.post(`/contracts/legal-catalog/${kind}/${id}/${action}`,{reason}),
  legalSource:(kind:'policies'|'templates',id:number,file:File)=>api.post(`/contracts/legal-catalog/${kind}/${id}/source`,form(file,{})),
  prefixMap: (q?: { keyword?: string; entityStatus?: PrefixEntityStatus; allowNewOnly?: boolean }) =>
    api.get<ContractPrefixMapDto[]>(`/contracts/prefix-map${qs({ keyword: q?.keyword, entityStatus: q?.entityStatus, allowNewOnly: q?.allowNewOnly ? 1 : undefined })}`),
  createPrefixMap: (body: ContractPrefixMapCreateRequest) =>
    api.post<ContractPrefixMapDto>('/contracts/prefix-map', body),
  patchPrefixMap: (id: number, body: ContractPrefixMapPatchRequest) =>
    api.patch<ContractPrefixMapDto>(`/contracts/prefix-map/${id}`, body),
  suggestNextNo: (q: {
    orgId: number;
    signingSubjectOrgId?: number;
    signingEntityLevel?: 'company' | 'secondary_unit';
    category?: string;
    legalCategory?: string;
    direction?: 'expense' | 'income';
    year?: number;
  }) => api.get<ContractNextNoDto>(`/contracts/next-no${qs({ ...q })}`),
  list: (q: Partial<ContractListQuery>) => api.get<ContractDto[]>(`/contracts${qs({ ...q })}`),
  listPage: (q: ContractListQuery & PageQuery) => api.get<ContractPageDto>(`/contracts/page${qs({ ...q })}`),
  summary: (q: Partial<ContractListQuery>) => api.get<ContractSummaryDto>(`/contracts/summary${qs({ ...q })}`),
  get: (id: number) => api.get<ContractDetailDto>(`/contracts/${id}`),
  paymentTierPreview: (id: number, q: { amount?: string; plannedDate?: string }) =>
    api.get<PaymentTierPreviewDto>(`/contracts/${id}/payment-tier-preview${qs({ ...q })}`),
  changeTierPreview: (
    id: number,
    q: { delta?: string; changeKind?: ChangeKind; involvesBizOrEntityChange?: boolean; involvesTechChange?: boolean },
  ) =>
    api.get<ChangeTierPreviewDto>(
      `/contracts/${id}/change-tier-preview${qs({
        delta: q.delta,
        changeKind: q.changeKind,
        involvesBizOrEntityChange: q.involvesBizOrEntityChange ? 1 : undefined,
        involvesTechChange: q.involvesTechChange ? 1 : undefined,
      })}`,
    ),
  create: (body: Partial<ContractCreateRequest>) => api.post<ContractDetailDto>('/contracts', body),
  update: (id: number, body: Record<string, unknown> & { expectedVersion: number }) => api.patch<ContractDetailDto>(`/contracts/${id}`, body),
  advance: (id: number, expectedVersion: number, toStage: ContractStage) => api.post<ContractDetailDto>(`/contracts/${id}/advance`, { expectedVersion, toStage }),
  terminate: (id: number, expectedVersion: number, reason: string, extra: Record<string, unknown> = {}) => api.post<ContractDetailDto>(`/contracts/${id}/terminate`, { expectedVersion, reason, ...extra }),
  void: (id: number, expectedVersion: number, reason: string) => api.post<ContractDetailDto>(`/contracts/${id}/void`, { expectedVersion, reason }),
  reopen: (id: number, expectedVersion: number, reason: string, targetStage: ContractStage) =>
    api.post<ContractDetailDto>(`/contracts/${id}/reopen`, { expectedVersion, reason, targetStage }),
  suspend: (id: number, expectedVersion: number, reason: string, guarantorConsentDocumentId?: number) =>
    api.post<ContractDetailDto>(`/contracts/${id}/suspend`, { expectedVersion, reason, guarantorConsentDocumentId }),
  resume: (id: number, expectedVersion: number, reason: string) =>
    api.post<ContractDetailDto>(`/contracts/${id}/resume`, { expectedVersion, reason }),
  updateDistribution: (id: number, body: ContractDistributionRequest) =>
    api.post<ContractDetailDto>(`/contracts/${id}/distribution`, body),
  updateArchiveStatus: (id: number, body: ContractArchiveStatusRequest) =>
    api.post<ContractDetailDto>(`/contracts/${id}/archive-status`, body),
  handoverUndertaker: (id: number, body: ContractHandoverRequest) =>
    api.post<ContractDetailDto>(`/contracts/${id}/undertaker-handover`, body),
  uploadDocument: (id: number, file: File, docType: ContractDocType, name?: string, evidenceKind?: EvidenceKind, changeId?: number) =>
    api.post<ContractDocumentDto>(`/contracts/${id}/documents`, form(file, { docType, name, evidenceKind, changeId })),
  withdrawDocument: (id: number, docId: number, reason: string) =>
    api.post<ContractDetailDto>(`/contracts/${id}/documents/${docId}/withdraw`, { reason }),
  countersigns: (id: number) => api.get<ContractCountersignDto[]>(`/contracts/${id}/countersigns`),
  triggerCountersigns: (id: number, assignedReviewers?: Record<string, number | null>) =>
    api.post<ContractCountersignDto[]>(`/contracts/${id}/countersigns`, assignedReviewers ? { assignedReviewers } : {}),
  decideCountersign: (id: number, cid: number, body: ContractCountersignDecideRequest) =>
    api.post<ContractCountersignDto[]>(`/contracts/${id}/countersigns/${cid}/decide`, body),
  getProcurement: (id: number) => api.get<ProcurementRecordDto | null>(`/contracts/${id}/procurement`),
  saveProcurement: (id: number, body: ProcurementRecordSaveRequest | { linkProcurementRecordId: number | null }) =>
    api.put<ProcurementRecordDto | null>(`/contracts/${id}/procurement`, body),
  listProcurementRecords: (q?: { orgId?: number; keyword?: string; procurementMethod?: string }) =>
    api.get<ProcurementRecordDto[]>(`/procurement-records${qs(q ?? {})}`),
  createProcurementRecord: (body: ProcurementRecordSaveRequest) =>
    api.post<ProcurementRecordDto>('/procurement-records', body),
  getProcurementRecord: (pid: number) => api.get<ProcurementRecordDto>(`/procurement-records/${pid}`),
  updateProcurementRecord: (pid: number, body: ProcurementRecordSaveRequest) =>
    api.put<ProcurementRecordDto>(`/procurement-records/${pid}`, body),
  disputesExportPath: (q?: { orgId?: number; contractId?: number; stage?: string }) =>
    `/contracts/disputes/export${qs(q ?? {})}`,
  monthlyReportLogs: (q?: { orgId?: number; reportMonth?: string }) =>
    api.get<MonthlyReportLogDto[]>(`/contracts/monthly-report-logs${qs(q ?? {})}`),
  submitMonthlyReportLog: (body: MonthlyReportLogRequest) =>
    api.post<MonthlyReportLogDto>('/contracts/monthly-report-log', body),
  submitReview: (id: number, documentId: number, note?: string) => api.post<ContractDetailDto>(`/contracts/${id}/reviews`, { documentId, note }),
  decideReview: (id: number, rid: number, body: Decision) => api.post<ContractDetailDto>(`/contracts/${id}/reviews/${rid}/decide`, body),
  submitChange: (id: number, body: ContractChangeRequest) => api.post<ContractDetailDto>(`/contracts/${id}/changes`, body),
  decideChange: (id: number, cid: number, body: Decision) => api.post<ContractDetailDto>(`/contracts/${id}/changes/${cid}/decide`, body),
  updateChangeFiling: (id: number, cid: number, body: ContractChangeFilingRequest) => api.patch<ContractDetailDto>(`/contracts/${id}/changes/${cid}/filing`, body),
  submitSettlement: (id: number, body: Partial<ContractSettlementCreateRequest> & { settlementDate: string }) => api.post<ContractDetailDto>(`/contracts/${id}/settlements`, body),
  decideSettlement: (id: number, sid: number, body: Decision) => api.post<ContractDetailDto>(`/contracts/${id}/settlements/${sid}/decide`, body),
  submitPayment: (id: number, body: ContractPaymentRequest) =>
    api.post<ContractDetailDto>(`/contracts/${id}/payments`, body),
  decidePayment: (id: number, pid: number, body: Decision) => api.post<ContractDetailDto>(`/contracts/${id}/payments/${pid}/decide`, body),
  pay: (id: number, pid: number, body: { paidDate: string; voucherNo?: string; invoiceDocumentId: number }) =>
    api.post<ContractDetailDto>(`/contracts/${id}/payments/${pid}/pay`, body),
  submitReceipt: (id: number, body: ContractReceiptCreateRequest) => api.post<ContractDetailDto>(`/contracts/${id}/receipts`, body),
  decideReceipt: (id: number, rid: number, body: Decision) => api.post<ContractDetailDto>(`/contracts/${id}/receipts/${rid}/decide`, body),
  receiveReceipt: (id: number, rid: number, body: ContractReceiptReceiveRequest) => api.post<ContractDetailDto>(`/contracts/${id}/receipts/${rid}/receive`, body),
  createGuarantee: (id: number, body: ContractGuaranteeCreateRequest) => api.post<ContractDetailDto>(`/contracts/${id}/guarantees`, body),
  updateGuarantee: (id: number, gid: number, body: ContractGuaranteeUpdateRequest) => api.patch<ContractDetailDto>(`/contracts/${id}/guarantees/${gid}`, body),
  upsertWarranty: (id: number, body: ContractWarrantyUpsertRequest) => api.put<ContractDetailDto>(`/contracts/${id}/warranty`, body),
  createDispute: (id: number, body: ContractDisputeCreateRequest) => api.post<ContractDetailDto>(`/contracts/${id}/disputes`, body),
  updateDispute: (id: number, did: number, body: ContractDisputeUpdateRequest) => api.patch<ContractDetailDto>(`/contracts/${id}/disputes/${did}`, body),
  previewImport: (
    fileOrFiles: File | File[],
    opts?: { importMode?: 'standard' | 'legacy_tolerant'; orgId?: number; batchGroup?: string; asOfDate?: string },
  ) => {
    const files = Array.isArray(fileOrFiles) ? fileOrFiles : [fileOrFiles];
    return api.post<ContractImportDto>('/contracts/imports', multiForm(files, { ...opts }));
  },
  listImports: (q?: { importMode?: 'standard' | 'legacy_tolerant'; status?: 'previewed' | 'confirmed'; limit?: number }) =>
    api.get<ContractImportDto[]>(`/contracts/imports${qs({ ...q })}`),
  importTemplatePath: (kind: ContractImportKind) => `/contracts/imports/templates/${kind}`,
  getImport: (id: number) => api.get<ContractImportDto>(`/contracts/imports/${id}`),
  confirmImport: (id: number, planHash: string) => api.post<ContractImportDto>(`/contracts/imports/${id}/confirm`, { planHash }),
  upsertEvaluation: (id: number, body: ContractEvaluationRequest) => api.put<ContractDetailDto>(`/contracts/${id}/evaluation`, body),
  monthlyLedgerExportPath: (q: { period?: string; orgId?: number }) => `/contracts/exports/monthly-ledger${qs(q)}`,
  preflightSupervision: (q: { period?: string; orgId?: number; scopeMode?: 'changed' | 'all_active'; exportPurpose?: SupervisionExportPurpose }) =>
    api.get<SupervisionPreflightDto>(`/contracts/exports/supervision/preflight${qs(q)}`),
  supervisionExportLogs: () => api.get<SupervisionExportLogDto[]>('/contracts/exports/logs'),
  exportSupervisionPackage: (body: { period?: string; orgId?: number; scopeMode?: 'changed' | 'all_active'; exportPurpose?: SupervisionExportPurpose }) =>
    api.post<Blob>('/contracts/exports/supervision/package', body),
  supervisionPortalFull: (q?: { orgId?: number }) => api.get<SupervisionPortalResponseDto>(`/contracts/supervision-portal/full${qs(q ?? {})}`),
};

export const expenseApi = {
  policies: (includeRetired = false) => api.get<PolicyDto[]>(`/expense/policies${includeRetired ? '?includeRetired=1' : ''}`),
  createPolicy: (body: PolicyCreateRequest) => api.post<PolicyDto>('/expense/policies', body),
  retirePolicy: (id: number, reason: string) => api.post<PolicyDto>(`/expense/policies/${id}/retire`, { reason }),
  uploadPolicySource: (id: number, file: File) => api.post<PolicyDto>(`/expense/policies/${id}/source`, form(file, {})),
  queue: (orgId?: number) => api.get<ExpenseQueueDto>(`/expense/queue${qs({ orgId })}`),
  claims: (q: Partial<ClaimListQuery>) => api.get<ClaimDto[]>(`/expense/claims${qs({ ...q })}`),
  claimsPage: (q: ClaimListQuery & PageQuery) => api.get<PageDto<ClaimDto>>(`/expense/claims/page${qs({ ...q })}`),
  claim: (id: number) => api.get<ClaimDetailDto>(`/expense/claims/${id}`),
  createClaim: (body: ClaimCreateRequest) => api.post<ClaimDetailDto>('/expense/claims', body),
  updateClaim: (id: number, body: ClaimUpdateRequest) => api.put<ClaimDetailDto>(`/expense/claims/${id}`, body),
  addAttachment: (id: number, file: File, kindHint?: string) => api.post<ClaimAttachmentDto>(`/expense/claims/${id}/attachments`, form(file, { kindHint })),
  removeAttachment: (id: number, aid: number) => api.del<ClaimDetailDto>(`/expense/claims/${id}/attachments/${aid}`),
  submit: (id: number, expectedReviewVersion: number) => api.post<ClaimSubmitResultDto>(`/expense/claims/${id}/submit`, { expectedReviewVersion }),
  rerun: (id: number) => api.post<ClaimSubmitResultDto>(`/expense/claims/${id}/audit`, {}),
  review: (id: number, body: ClaimReviewRequest) => api.post<ClaimDetailDto>(`/expense/claims/${id}/review`, body),
};

export interface TodoItem { key: string; label: string; count: number; path: string }
export const todoApi = { list: () => api.get<{ items: TodoItem[] }>('/dashboard/todos') };
