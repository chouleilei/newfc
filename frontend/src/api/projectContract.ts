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
} from '@contracts/plan-execution';
import type {
  ContractCreateRequest, ContractDetailDto, ContractDocType, ContractDocumentDto, ContractDto, ContractImportDto, ContractListQuery, ContractStage, ContractSummaryDto,
  DecisionRequest,
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
};

type Decision = Partial<DecisionRequest> & Pick<DecisionRequest, 'decision'>;
export const contractApi = {
  list: (q: Partial<ContractListQuery>) => api.get<ContractDto[]>(`/contracts${qs({ ...q })}`),
  listPage: (q: ContractListQuery & PageQuery) => api.get<PageDto<ContractDto>>(`/contracts/page${qs({ ...q })}`),
  summary: (q: { orgId?: number; projectId?: number }) => api.get<ContractSummaryDto>(`/contracts/summary${qs(q)}`),
  get: (id: number) => api.get<ContractDetailDto>(`/contracts/${id}`),
  create: (body: Partial<ContractCreateRequest>) => api.post<ContractDetailDto>('/contracts', body),
  update: (id: number, body: Record<string, unknown> & { expectedVersion: number }) => api.patch<ContractDetailDto>(`/contracts/${id}`, body),
  advance: (id: number, expectedVersion: number, toStage: ContractStage) => api.post<ContractDetailDto>(`/contracts/${id}/advance`, { expectedVersion, toStage }),
  terminate: (id: number, expectedVersion: number, reason: string) => api.post<ContractDetailDto>(`/contracts/${id}/terminate`, { expectedVersion, reason }),
  void: (id: number, expectedVersion: number, reason: string) => api.post<ContractDetailDto>(`/contracts/${id}/void`, { expectedVersion, reason }),
  reopen: (id: number, expectedVersion: number, reason: string, targetStage: ContractStage) =>
    api.post<ContractDetailDto>(`/contracts/${id}/reopen`, { expectedVersion, reason, targetStage }),
  uploadDocument: (id: number, file: File, docType: ContractDocType, name?: string) =>
    api.post<ContractDocumentDto>(`/contracts/${id}/documents`, form(file, { docType, name })),
  submitReview: (id: number, documentId: number, note?: string) => api.post<ContractDetailDto>(`/contracts/${id}/reviews`, { documentId, note }),
  decideReview: (id: number, rid: number, body: Decision) => api.post<ContractDetailDto>(`/contracts/${id}/reviews/${rid}/decide`, body),
  submitChange: (id: number, body: { delta: string; reason: string; evidenceDocumentId: number }) => api.post<ContractDetailDto>(`/contracts/${id}/changes`, body),
  decideChange: (id: number, cid: number, body: Decision) => api.post<ContractDetailDto>(`/contracts/${id}/changes/${cid}/decide`, body),
  submitPayment: (id: number, body: { nodeName: string; amount: string; plannedDate?: string; evidenceDocumentId?: number }) =>
    api.post<ContractDetailDto>(`/contracts/${id}/payments`, body),
  decidePayment: (id: number, pid: number, body: Decision) => api.post<ContractDetailDto>(`/contracts/${id}/payments/${pid}/decide`, body),
  pay: (id: number, pid: number, body: { paidDate: string; voucherNo?: string; invoiceDocumentId: number }) =>
    api.post<ContractDetailDto>(`/contracts/${id}/payments/${pid}/pay`, body),
  previewImport: (file: File) => api.post<ContractImportDto>('/contracts/imports', form(file, {})),
  getImport: (id: number) => api.get<ContractImportDto>(`/contracts/imports/${id}`),
  confirmImport: (id: number, planHash: string) => api.post<ContractImportDto>(`/contracts/imports/${id}/confirm`, { planHash }),
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
