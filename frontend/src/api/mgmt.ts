/** AC-F14 管理会计接口;类型取自 @contracts/mgmt(仅 import type)。 */
import { api } from './client';
import { qs } from './financeData';
import type {
  MaAlertDto, MaAlertScanDto, MaAllocAdjustmentDto, MaAllocPreviewDto, MaAllocRunDto, MaAnalysisDto, MaBudgetAdjustmentCreate, MaBudgetAdjustmentDto,
  MaCalcRunDto, MaCalcRunRequest, MaCostPoolCreate, MaCostPoolDto, MaDimensionDto, MaLineageDto, MaMemberDto, MaMemberPreviewDto, MaMemberPreviewRequest,
  MaMetricCreate, MaMetricDto, MaMetricUpdate, MaPerfReviewRequest, MaPerfSchemeCreate, MaPerfSchemeDto, MaPerfScoreDto, MaResponsibilityCenterDto,
  MaReviewRequest, MaSnapshotDto, MaMemberType,
} from '@contracts/mgmt';

export const mgmtApi = {
  dimensions: () => api.get<MaDimensionDto[]>('/mgmt/dimensions'),
  dimension: (id: number) => api.get<MaDimensionDto & { members: MaMemberDto[] }>(`/mgmt/dimensions/${id}`),
  createDimension: (body: { code: string; name: string; memberType: MaMemberType }) => api.post<MaDimensionDto>('/mgmt/dimensions', body),
  updateDimension: (id: number, body: { expectedVersion: number; name?: string; status?: 'active' | 'inactive' }) => api.patch<MaDimensionDto>(`/mgmt/dimensions/${id}`, body),
  previewMembers: (id: number, body: MaMemberPreviewRequest) => api.post<MaMemberPreviewDto>(`/mgmt/dimensions/${id}/members/preview`, body),
  confirmMembers: (id: number, body: MaMemberPreviewRequest & { previewHash: string }) => api.post<{ created: number; unchanged: number }>(`/mgmt/dimensions/${id}/members/confirm`, body),

  metrics: (status?: string) => api.get<MaMetricDto[]>(`/mgmt/metrics${qs({ status })}`),
  createMetric: (body: MaMetricCreate) => api.post<MaMetricDto>('/mgmt/metrics', body),
  updateMetric: (id: number, body: MaMetricUpdate) => api.patch<MaMetricDto>(`/mgmt/metrics/${id}`, body),
  calcRuns: (q: { period?: string; kind?: string }) => api.get<MaCalcRunDto[]>(`/mgmt/calc-runs${qs(q)}`),
  calcRun: (id: number) => api.get<MaCalcRunDto>(`/mgmt/calc-runs/${id}`),
  createCalcRun: (body: MaCalcRunRequest) => api.post<MaCalcRunDto>('/mgmt/calc-runs', body),
  snapshots: (q: { metricId?: number; orgId?: number; period?: string; status?: string; runId?: number }) => api.get<MaSnapshotDto[]>(`/mgmt/snapshots${qs(q)}`),
  analysis: (q: { metricIds: number[]; periods: string[]; groupBy: 'org' | 'dimension'; dimensionId?: number; orgIds?: number[] }) =>
    api.get<MaAnalysisDto>(`/mgmt/analysis${qs(q)}`),

  pools: (q: { period?: string; orgId?: number }) => api.get<MaCostPoolDto[]>(`/mgmt/cost-pools${qs(q)}`),
  createPool: (body: MaCostPoolCreate) => api.post<MaCostPoolDto>('/mgmt/cost-pools', body),
  setRules: (id: number, body: { expectedVersion: number; rules: { targetOrgId: number; weight: string }[] }) => api.put<MaCostPoolDto>(`/mgmt/cost-pools/${id}/rules`, body),
  previewAllocation: (id: number) => api.get<MaAllocPreviewDto>(`/mgmt/cost-pools/${id}/preview`),
  confirmAllocation: (id: number, expectedVersion: number) => api.post<MaAllocRunDto>(`/mgmt/cost-pools/${id}/confirm`, { expectedVersion }),
  allocRuns: (q: { poolId?: number; status?: string }) => api.get<MaAllocRunDto[]>(`/mgmt/alloc-runs${qs(q)}`),
  voidRun: (id: number, reason: string) => api.post<MaAllocRunDto>(`/mgmt/alloc-runs/${id}/void`, { reason }),
  lineage: (id: number) => api.get<MaLineageDto>(`/mgmt/alloc-runs/${id}/lineage`),
  createAdjustment: (runId: number, body: { fromResultId: number; toResultId: number; amount: string; reason: string }) => api.post<MaAllocAdjustmentDto>(`/mgmt/alloc-runs/${runId}/adjustments`, body),
  pendingAdjustments: () => api.get<MaAllocAdjustmentDto[]>('/mgmt/alloc-adjustments'),
  reviewAdjustment: (id: number, body: MaReviewRequest) => api.post<MaAllocAdjustmentDto>(`/mgmt/alloc-adjustments/${id}/review`, body),

  budgetAdjustments: (status?: string) => api.get<MaBudgetAdjustmentDto[]>(`/mgmt/budget-adjustments${qs({ status })}`),
  submitBudgetAdjustment: (body: MaBudgetAdjustmentCreate) => api.post<MaBudgetAdjustmentDto>('/mgmt/budget-adjustments', body),
  reviewBudgetAdjustment: (id: number, body: MaReviewRequest) => api.post<MaBudgetAdjustmentDto>(`/mgmt/budget-adjustments/${id}/review`, body),

  alerts: (q: { status?: string; orgId?: number; period?: string; metricId?: number }) => api.get<MaAlertDto[]>(`/mgmt/alerts${qs(q)}`),
  scanAlerts: (runId: number) => api.post<MaAlertScanDto>('/mgmt/alerts/scan', { runId }),
  acknowledgeAlert: (id: number, body: { expectedVersion: number; causeCategory: string; note: string }) => api.post<MaAlertDto>(`/mgmt/alerts/${id}/acknowledge`, body),
  closeAlert: (id: number, body: { expectedVersion: number; note?: string }) => api.post<MaAlertDto>(`/mgmt/alerts/${id}/close`, body),

  centers: (period: string, orgId?: number) => api.get<MaResponsibilityCenterDto[]>(`/mgmt/centers${qs({ period, orgId })}`),

  schemes: () => api.get<MaPerfSchemeDto[]>('/mgmt/perf-schemes'),
  createScheme: (body: MaPerfSchemeCreate) => api.post<MaPerfSchemeDto>('/mgmt/perf-schemes', body),
  score: (id: number, body: { runId: number; orgIds?: number[] }) => api.post<{ scores: MaPerfScoreDto[]; skipped: { orgId: number; orgName: string; reasons: string[] }[] }>(`/mgmt/perf-schemes/${id}/score`, body),
  scores: (q: { schemeId?: number; period?: string; status?: string }) => api.get<MaPerfScoreDto[]>(`/mgmt/perf-scores${qs(q)}`),
  reviewScore: (id: number, body: MaPerfReviewRequest) => api.post<MaPerfScoreDto>(`/mgmt/perf-scores/${id}/review`, body),
};
