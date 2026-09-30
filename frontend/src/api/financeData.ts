/**
 * T-3 财务数据、管理会计与标准报表接口。
 * 类型全部取自后端共享契约(@contracts/*,仅 import type,构建产物不含 zod)。
 */
import { api } from './client';
import type {
  EasBatchDto, EasBatchLinesDto, EasCorrectionDto, EasDataType, EasPeriodLockDto, EasPeriodStatusDto, EasReconSetDto,
} from '@contracts/eas';
import type { GovDispositionCreate, GovIssueDto, GovMatchSuggestionDto, GovQualityScoreDto, GovScanResultDto, GovVerifyDto } from '@contracts/governance';
import type {
  StatementBatchDto, StatementItemDto, StatementOverviewDto, StatementPreviewDto, StatementScope, StatementSheetCode, StatementTrendDto,
} from '@contracts/statements';
import type { StdReportDto, StdReportGenerate, StdReportListItemDto } from '@contracts/standard-reports';

export type * from '@contracts/eas';
export type * from '@contracts/governance';
export type * from '@contracts/statements';
export type * from '@contracts/mgmt';
export type * from '@contracts/standard-reports';

/** 查询串:忽略空值。 */
export function qs(params: Record<string, string | number | undefined | null | (string | number)[]>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(params)) {
    if (v === undefined || v === null || v === '') continue;
    const text = Array.isArray(v) ? v.join(',') : String(v);
    if (text) parts.push(`${encodeURIComponent(k)}=${encodeURIComponent(text)}`);
  }
  return parts.length ? `?${parts.join('&')}` : '';
}

function form(file: File, fields: Record<string, string | number | undefined>): FormData {
  const fd = new FormData();
  fd.append('file', file);
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== '') fd.append(k, String(v));
  return fd;
}

export const easApi = {
  periodStatus: (orgId: number, period: string) => api.get<EasPeriodStatusDto>(`/eas/period-status${qs({ orgId, period })}`),
  batches: (q: { orgId?: number; period?: string; dataType?: EasDataType; status?: string }) => api.get<EasBatchDto[]>(`/eas/batches${qs(q)}`),
  batchLines: (id: number, page = 1, pageSize = 100) => api.get<EasBatchLinesDto>(`/eas/batches/${id}/lines${qs({ page, pageSize })}`),
  importFile: (file: File, fields: { dataType: EasDataType; orgId?: number; correctionId?: number }) => api.post<EasBatchDto>('/eas/import', form(file, fields)),
  precheck: (orgId: number, period: string) => api.post<EasReconSetDto>('/eas/precheck', { orgId, period }),
  sets: (q: { orgId?: number; period?: string }) => api.get<EasReconSetDto[]>(`/eas/sets${qs(q)}`),
  set: (id: number) => api.get<EasReconSetDto>(`/eas/sets/${id}`),
  activate: (id: number, expectedVersion: number, expectedCurrentSetId: number | null) => api.post<EasReconSetDto>(`/eas/sets/${id}/activate`, { expectedVersion, expectedCurrentSetId }),
  locks: () => api.get<EasPeriodLockDto[]>('/eas/locks'),
  lock: (body: { orgId: number; period: string; setId: number; reason: string }) => api.post<EasPeriodLockDto>('/eas/locks', body),
  unlock: (id: number, expectedVersion: number, reason: string) => api.post<EasPeriodLockDto>(`/eas/locks/${id}/unlock`, { expectedVersion, reason }),
  corrections: (pending = false) => api.get<EasCorrectionDto[]>(`/eas/corrections${pending ? '?status=pending' : ''}`),
  createCorrection: (body: { orgId: number; period: string; expectedCurrentSetId: number; reason: string }) => api.post<EasCorrectionDto>('/eas/corrections', body),
  precheckCorrection: (id: number) => api.post<EasCorrectionDto>(`/eas/corrections/${id}/precheck`, {}),
  reviewCorrection: (id: number, body: { action: 'approve' | 'return'; expectedVersion: number; comment?: string; exceptionReason?: string }) =>
    api.post<EasCorrectionDto>(`/eas/corrections/${id}/review`, body),
  auxRequirements: (orgId?: number) => api.get<{ id: number; orgId: number; orgName: string; accountCode: string; auxType: string; status: 'active' | 'inactive'; createdAt: string }[]>(`/eas/aux-requirements${qs({ orgId })}`),
  addAuxRequirement: (body: { orgId: number; accountCode: string; auxType: string }) => api.post('/eas/aux-requirements', body),
  deactivateAuxRequirement: (id: number) => api.post(`/eas/aux-requirements/${id}/deactivate`, {}),
};

export const govApi = {
  issues: (q: { status?: string; sourceType?: string; orgId?: number; period?: string }) => api.get<GovIssueDto[]>(`/governance/issues${qs(q)}`),
  issue: (id: number) => api.get<GovIssueDto>(`/governance/issues/${id}`),
  verify: (id: number) => api.get<GovVerifyDto>(`/governance/issues/${id}/verify`),
  scan: (body: { orgId?: number; period?: string }) => api.post<GovScanResultDto>('/governance/scan', body),
  dispose: (id: number, body: GovDispositionCreate) => api.post(`/governance/issues/${id}/dispositions`, body),
  review: (dispositionId: number, body: { action: 'approve' | 'return'; comment?: string; exceptionReason?: string }) => api.post(`/governance/dispositions/${dispositionId}/review`, body),
  qualityScore: (q: { orgId?: number; period?: string }) => api.get<GovQualityScoreDto>(`/governance/quality-score${qs(q)}`),
  matches: (q: { orgId?: number; period?: string; withSuggestionsOnly?: boolean }) =>
    api.get<{ items: GovMatchSuggestionDto[] }>(`/governance/master-data-matches${qs({ ...q, withSuggestionsOnly: q.withSuggestionsOnly ? 'true' : undefined })}`),
  issueMatches: (id: number) => api.get<Partial<GovMatchSuggestionDto> & { suggestions: GovMatchSuggestionDto['suggestions'] }>(`/governance/issues/${id}/match-suggestions`),
};

export const statementApi = {
  overview: (q: { orgId?: number; period?: string; scope?: StatementScope }) => api.get<StatementOverviewDto>(`/statements/overview${qs(q)}`),
  trends: (q: { orgId?: number; scope?: StatementScope; from?: string; to?: string }) => api.get<StatementTrendDto>(`/statements/trends${qs(q)}`),
  batches: (q: { orgId?: number; period?: string; scope?: StatementScope; status?: string }) => api.get<StatementBatchDto[]>(`/statements/batches${qs(q)}`),
  items: (id: number, sheet?: StatementSheetCode) => api.get<StatementItemDto[]>(`/statements/batches/${id}/items${qs({ sheet })}`),
  preview: (file: File, fields: { orgId: number; period: string; scope: StatementScope }) => api.post<StatementPreviewDto>('/statements/preview', form(file, fields)),
  importFile: (file: File, fields: { orgId: number; period: string; scope: StatementScope }) => api.post<StatementBatchDto>('/statements/import', form(file, fields)),
  activate: (id: number, expectedCurrentBatchId: number | null) => api.post<StatementBatchDto>(`/statements/batches/${id}/activate`, { expectedCurrentBatchId }),
  void: (id: number, reason: string) => api.post<StatementBatchDto>(`/statements/batches/${id}/void`, { reason }),
};

export const stdReportApi = {
  list: (q: { reportType?: string; status?: string; period?: string }) => api.get<StdReportListItemDto[]>(`/standard-reports${qs(q)}`),
  get: (id: number) => api.get<StdReportDto>(`/standard-reports/${id}`),
  generate: (body: StdReportGenerate) => api.post<StdReportDto>('/standard-reports', body),
  review: (id: number, body: { comment?: string; exceptionReason?: string }) => api.post<StdReportDto>(`/standard-reports/${id}/review`, body),
};
