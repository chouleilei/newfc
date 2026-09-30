/**
 * T-5 可行性测算、投资控制、财务预测、风险闭环与分析报告接口。
 * 有共享契约的类型取自 @contracts/*(仅 import type);服务端推导的响应在此按页面用到的字段声明。
 */
import { api } from './client';
import { qs } from './financeData';
import type {
  FeasCheckDto, FeasIndicatorDto, FeasibilityAssumptionsInput, FeasResultDto, FeasSensitivityItemDto, SensitivityCode,
} from '@contracts/investment-feasibility';
import type { IcComparisonRowDto, IcComparisonSummaryDto, IcLevel, IcVersionType } from '@contracts/investment-control';
import type { ForecastDiagnostic, ForecastOutput, ForecastParam } from '@contracts/finance-forecast';
import type {
  RiskChecklistDto, RiskCommand, RiskEventDetailDto, RiskEventDto, RiskExplanationDto, RiskLevel, RiskListQuery, RiskRuleCreate, RiskRuleDto, RiskRuleUpdate, RiskScanDto,
  RiskSummaryDto,
} from '@contracts/risk';
import type { RptGenerate, RptKind, RptListQuery, RptReportDto, RptReportListItemDto, RptSectionEditDto, RptStatus } from '@contracts/analysis-reports';

export type * from '@contracts/investment-feasibility';
export type * from '@contracts/investment-control';
export type * from '@contracts/finance-forecast';
export type * from '@contracts/risk';
export type * from '@contracts/analysis-reports';

function form(file: File | null | undefined, fields: Record<string, string | number | boolean | undefined | null>): FormData {
  const fd = new FormData();
  if (file) fd.append('file', file);
  for (const [k, v] of Object.entries(fields)) if (v !== undefined && v !== null && v !== '') fd.append(k, String(v));
  return fd;
}
export interface RowErrorDto { row: number; field: string; message: string }

/* ---------------- 后台任务 ---------------- */

export interface JobDto { id: number; title: string; status: 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted'; error: { code: string | null; message: string | null } | null; result: unknown }
/** 轮询任务直到结束;返回最终状态(调用方据此提示)。 */
export async function waitJob(jobId: number, { intervalMs = 800, timeoutMs = 120_000 } = {}): Promise<JobDto> {
  const started = Date.now();
  for (;;) {
    const job = await api.get<JobDto>(`/jobs/${jobId}`);
    if (!['queued', 'running'].includes(job.status)) return job;
    if (Date.now() - started > timeoutMs) return job;
    await new Promise((r) => setTimeout(r, intervalMs));
  }
}

/* ---------------- 可行性测算(AC-F12) ---------------- */

export interface FeasRunSummaryDto {
  id: number; scenarioId: number; kind: 'base' | 'sensitivity'; status: 'succeeded' | 'failed'; parameterHash: string; modelVersion: string; scenarioVersion: number;
  allChecksPassed: boolean | null; indicators: FeasIndicatorDto[] | null; errorMessage: string | null; createdAt: string; createdBy: string | null;
}
export interface FeasProjectDto {
  id: number; code: string; name: string; orgId: number; orgName: string; mdProjectId: number | null; mdProjectCode: string | null; description: string;
  constructionStartYear: number; operationStartYear: number; horizonYears: number; status: 'active' | 'archived'; version: number; scenarioCount: number;
  createdAt: string; updatedAt: string;
}
export interface FeasScenarioDto {
  id: number; projectId: number; code: string; name: string; assumptions: FeasibilityAssumptionsInput; parameterHash: string; sourceFileName: string | null;
  version: number; createdAt: string; updatedAt: string; latestRun: FeasRunSummaryDto | null; stale: boolean;
}
export interface FeasProjectDetailDto extends FeasProjectDto { scenarios: FeasScenarioDto[] }
export interface FeasRunDetailDto extends FeasRunSummaryDto {
  scenarioCode: string; scenarioName: string; projectId: number; projectName: string; assumptions: FeasibilityAssumptionsInput;
  result: FeasResultDto | { variables: unknown[]; baseIndicators: FeasIndicatorDto[]; items: FeasSensitivityItemDto[] } | null;
}
export interface FeasImportDto {
  id: number; projectId: number; fileName: string; sha256: string; status: string; errors: RowErrorDto[]; assumptions: FeasibilityAssumptionsInput | null;
  scenarioId: number | null; createdAt: string; confirmedAt: string | null; replayed?: boolean;
}
export type { FeasCheckDto };

export const feasibilityApi = {
  projects: (q: { orgId?: number; status?: string; keyword?: string }) => api.get<{ items: FeasProjectDto[] }>(`/investment/feasibility/projects${qs(q)}`),
  createProject: (body: Record<string, unknown>) => api.post<FeasProjectDto>('/investment/feasibility/projects', body),
  project: (id: number) => api.get<FeasProjectDetailDto>(`/investment/feasibility/projects/${id}`),
  updateProject: (id: number, body: Record<string, unknown> & { expectedVersion: number }) => api.patch<FeasProjectDto>(`/investment/feasibility/projects/${id}`, body),
  createScenario: (projectId: number, body: { code: string; name: string; assumptions: FeasibilityAssumptionsInput }) =>
    api.post<FeasScenarioDto>(`/investment/feasibility/projects/${projectId}/scenarios`, body),
  scenario: (id: number) => api.get<FeasScenarioDto & { project: FeasProjectDto }>(`/investment/feasibility/scenarios/${id}`),
  updateScenario: (id: number, body: { expectedVersion: number; name?: string; assumptions?: FeasibilityAssumptionsInput }) =>
    api.patch<FeasScenarioDto>(`/investment/feasibility/scenarios/${id}`, body),
  copyScenario: (id: number, body: { code: string; name: string }) => api.post<FeasScenarioDto>(`/investment/feasibility/scenarios/${id}/copy`, body),
  run: (id: number, expectedVersion: number) => api.post<FeasRunDetailDto>(`/investment/feasibility/scenarios/${id}/run`, { expectedVersion }),
  sensitivity: (id: number, body: { expectedVersion: number; variables?: { code: SensitivityCode; mode: string; changes: string[] }[] }) =>
    api.post<{ jobId: number }>(`/investment/feasibility/scenarios/${id}/sensitivity`, body),
  runs: (scenarioId: number) => api.get<{ items: FeasRunSummaryDto[] }>(`/investment/feasibility/scenarios/${scenarioId}/runs`),
  runDetail: (runId: number) => api.get<FeasRunDetailDto>(`/investment/feasibility/runs/${runId}`),
  previewImport: (projectId: number, file: File) => api.post<FeasImportDto>(`/investment/feasibility/projects/${projectId}/imports`, form(file, {})),
  confirmImport: (importId: number, body: { sha256: string; code: string; name: string }) => api.post<FeasImportDto>(`/investment/feasibility/imports/${importId}/confirm`, body),
  templatePath: (scenarioId?: number) => `/investment/feasibility/template${qs({ scenarioId })}`,
  exportPath: (runId: number) => `/investment/feasibility/runs/${runId}/export`,
};

/* ---------------- 投资控制(AC-F13) ---------------- */

export interface IcVersionSummaryDto {
  id: number; projectId: number; versionType: IcVersionType; typeLabel: string; versionNo: number; name: string; status: 'draft' | 'confirmed' | 'voided';
  isCurrent: boolean; isRedline: boolean; staticTotal: string; dynamicTotal: string; approvalDocNo: string; approvalDate: string | null; sourceFileName: string | null;
  contentHash: string | null; voidReason: string | null; version: number; createdAt: string; createdBy: string | null; confirmedAt: string | null; confirmedBy: string | null;
  mappingCounts: { matched: number; need_mapping: number; manual: number; ignored: number };
}
export interface IcItemDto {
  id: number; rowNo: number; code: string; parentCode: string | null; level: number; name: string; category: string; staticAmount: string; dynamicAmount: string;
  sourceCell: string | null; canonicalCode: string | null; canonicalName: string | null; mappingStatus: 'matched' | 'need_mapping' | 'manual' | 'ignored'; mappingMethod: string | null;
}
export interface IcVersionDetailDto extends IcVersionSummaryDto {
  referenceVersionId: number | null; canonicalItems: { code: string; name: string; level: number }[]; items: IcItemDto[];
}
export interface IcProjectDto {
  id: number; mdProjectId: number; code: string; name: string; orgId: number; orgName: string; approvedAmount: string | null; approvalDocNo: string;
  status: 'active' | 'archived'; version: number; redlineVersionId: number | null; redlineAmount: string | null;
  current: Partial<Record<IcVersionType, { id: number; versionNo: number; staticTotal: string }>>; createdAt: string; updatedAt: string;
}
export interface IcProjectDetailDto extends IcProjectDto { versions: IcVersionSummaryDto[] }
export interface IcImportDto {
  id: number; projectId: number; versionType: IcVersionType; fileName: string; sha256: string; status: string; rowCount: number; errorCount: number; errors: RowErrorDto[];
  name: string; versionId: number | null; staticTotal: string; dynamicTotal: string;
  items: { code: string; name: string; level: number; staticAmount: string; dynamicAmount: string }[]; createdAt: string;
}
interface IcVersionRef { id: number; versionType: IcVersionType; typeLabel: string; versionNo: number; name: string; status: string; contentHash: string }
export interface IcComparisonDto {
  id: number; projectId: number; base: IcVersionRef; target: IcVersionRef; redlineVersionId: number | null; thresholds: Record<'normal' | 'attention' | 'warning', string>;
  summary: IcComparisonSummaryDto; rows?: IcComparisonRowDto[]; contentSha256: string; createdAt: string; createdBy: string | null;
}
export type { IcLevel };

export const icApi = {
  projects: (q: { orgId?: number; status?: string; keyword?: string }) => api.get<{ items: IcProjectDto[] }>(`/investment/control/projects${qs(q)}`),
  createProject: (body: { mdProjectId: number; approvedAmount?: string | null; approvalDocNo?: string }) => api.post<IcProjectDto>('/investment/control/projects', body),
  project: (id: number) => api.get<IcProjectDetailDto>(`/investment/control/projects/${id}`),
  updateProject: (id: number, body: Record<string, unknown> & { expectedVersion: number }) => api.patch<IcProjectDto>(`/investment/control/projects/${id}`, body),
  previewImport: (projectId: number, file: File, f: { versionType: IcVersionType; name?: string; approvalDocNo?: string; approvalDate?: string }) =>
    api.post<IcImportDto>(`/investment/control/projects/${projectId}/imports`, form(file, f)),
  confirmImport: (importId: number, sha256: string) => api.post<IcImportDto & { replayed: boolean }>(`/investment/control/imports/${importId}/confirm`, { sha256 }),
  version: (id: number) => api.get<IcVersionDetailDto>(`/investment/control/versions/${id}`),
  mapping: (id: number, expectedVersion: number, items: { itemId: number; action: 'map' | 'ignore' | 'reset'; canonicalCode?: string }[]) =>
    api.post<IcVersionDetailDto>(`/investment/control/versions/${id}/mapping`, { expectedVersion, items }),
  confirmVersion: (id: number, expectedVersion: number) => api.post<IcVersionDetailDto>(`/investment/control/versions/${id}/confirm`, { expectedVersion }),
  voidVersion: (id: number, expectedVersion: number, reason: string) => api.post<IcVersionDetailDto>(`/investment/control/versions/${id}/void`, { expectedVersion, reason }),
  comparisons: (projectId: number) => api.get<{ items: IcComparisonDto[] }>(`/investment/control/projects/${projectId}/comparisons`),
  compare: (body: { baseVersionId: number; targetVersionId: number; thresholds?: Record<'normal' | 'attention' | 'warning', string> }) =>
    api.post<IcComparisonDto>('/investment/control/comparisons', body),
  comparison: (id: number) => api.get<IcComparisonDto>(`/investment/control/comparisons/${id}`),
  templatePath: '/investment/control/template',
  exportPath: (id: number) => `/investment/control/comparisons/${id}/export`,
};

/* ---------------- 财务预测(AC-F11) ---------------- */

export interface FfModelDto {
  id: number; name: string; orgId: number; orgName: string; baseYear: number; horizonYears: number; description: string; status: 'active' | 'archived'; version: number;
  versionCount: number; frozenCount: number; createdAt: string; updatedAt: string; createdBy: string | null;
}
export interface FfVersionDto {
  id: number; modelId: number; versionNo: number; status: 'draft' | 'frozen'; note: string; contentHash: string; sourceFileName: string | null;
  sheets: { name: string; cellCount: number }[]; cellCount: number; params: ForecastParam[]; outputs: ForecastOutput[]; errorCount: number; warningCount: number;
  baselineRunId: number | null; version: number; createdAt: string; createdBy: string | null; frozenAt: string | null; frozenBy: string | null;
  diagnostics?: ForecastDiagnostic[];
}
export interface FfModelDetailDto extends FfModelDto { versions: FfVersionDto[] }
export type FfCell = { f: string } | { n: string | number } | { s: string } | { b: boolean } | { e: string };
export interface FfRunDto {
  id: number; versionId: number; kind: 'baseline' | 'scenario'; scenarioName: string | null; params: Record<string, string>;
  status: 'queued' | 'running' | 'succeeded' | 'failed'; outputs: Record<string, string[]> | null; errorCode: string | null; errorMessage: string | null;
  diagnostics: unknown[]; jobId: number | null; durationMs: number | null; createdAt: string; finishedAt: string | null; createdBy: string | null;
}
export interface FfCompareDto {
  runId: number; baselineRunId: number; scenarioName: string | null; params: Record<string, string>;
  items: { key: string; name: string; unit: string; values: { index: number; baseline: string | null; scenario: string; diff: string | null; rate: string | null }[] }[];
}

export const forecastApi = {
  models: (q: { orgId?: number; status?: string; keyword?: string }) => api.get<{ items: FfModelDto[] }>(`/forecast/models${qs(q)}`),
  createModel: (body: { name: string; orgId: number; baseYear: number; horizonYears: number; description?: string }) => api.post<FfModelDto>('/forecast/models', body),
  model: (id: number) => api.get<FfModelDetailDto>(`/forecast/models/${id}`),
  updateModel: (id: number, body: Record<string, unknown> & { expectedVersion: number }) => api.patch<FfModelDto>(`/forecast/models/${id}`, body),
  importVersion: (modelId: number, file: File, note?: string) => api.post<FfVersionDto>(`/forecast/models/${modelId}/imports`, form(file, { note })),
  version: (id: number) => api.get<FfVersionDto>(`/forecast/versions/${id}`),
  sheet: (id: number, name: string) => api.get<{ versionId: number; name: string; cells: Record<string, FfCell> }>(`/forecast/versions/${id}/sheets/${encodeURIComponent(name)}`),
  updateVersion: (id: number, body: { expectedVersion: number; cells?: { sheet: string; cell: string; value: FfCell | null }[]; params?: ForecastParam[]; outputs?: ForecastOutput[]; note?: string }) =>
    api.patch<FfVersionDto>(`/forecast/versions/${id}`, body),
  freeze: (id: number, expectedVersion: number) => api.post<FfVersionDto>(`/forecast/versions/${id}/freeze`, { expectedVersion }),
  copy: (id: number) => api.post<FfVersionDto>(`/forecast/versions/${id}/copy`, {}),
  runs: (versionId: number) => api.get<{ items: FfRunDto[] }>(`/forecast/versions/${versionId}/runs`),
  startRun: (versionId: number, body: { kind: 'baseline' | 'scenario'; scenarioName?: string; params?: Record<string, string> }) =>
    api.post<FfRunDto>(`/forecast/versions/${versionId}/runs`, body),
  run: (id: number) => api.get<FfRunDto>(`/forecast/runs/${id}`),
  compare: (id: number) => api.get<FfCompareDto>(`/forecast/runs/${id}/compare`),
};

/* ---------------- 风险闭环(AC-F17) ---------------- */

export const riskApi = {
  summary: (q: { orgId?: number }) => api.get<RiskSummaryDto>(`/risk/summary${qs(q)}`),
  events: (q: Partial<RiskListQuery>) => api.get<RiskEventDto[]>(`/risk/events${qs({ ...q })}`),
  event: (id: number) => api.get<RiskEventDetailDto>(`/risk/events/${id}`),
  act: (id: number, f: { action: RiskCommand; expectedVersion: number; comment?: string; handlerUserId?: number; deadline?: string; exceptionReason?: string }, file?: File | null) =>
    api.post<RiskEventDetailDto>(`/risk/events/${id}/actions`, form(file, f)),
  attachmentPath: (id: number, actionId: number) => `/risk/events/${id}/actions/${actionId}/attachment`,
  scans: () => api.get<RiskScanDto[]>('/risk/scans'),
  scan: (orgId?: number) => api.post<RiskScanDto>('/risk/scans', orgId ? { orgId } : {}),
  rules: () => api.get<RiskRuleDto[]>('/risk/rules'),
  updateRule: (code: string, body: RiskRuleUpdate) => api.patch<RiskRuleDto>(`/risk/rules/${code}`, body),
  createRule: (body: RiskRuleCreate) => api.post<RiskRuleDto>('/risk/rules', body),
  explain: (id: number) => api.post<RiskExplanationDto>(`/risk/events/${id}/explain`, {}),
  checklist: (id: number) => api.get<RiskChecklistDto>(`/risk/events/${id}/checklist`),
};
export type { RiskLevel };

/* ---------------- 分析报告(AC-F18) ---------------- */

export const reportApi = {
  list: (q: Partial<RptListQuery>) => api.get<RptReportListItemDto[]>(`/analysis-reports${qs({ ...q })}`),
  get: (id: number) => api.get<RptReportDto>(`/analysis-reports/${id}`),
  generate: (body: Partial<RptGenerate> & { kind: RptKind }) => api.post<RptReportDto>('/analysis-reports', body),
  remove: (id: number, expectedVersion: number) => api.del<void>(`/analysis-reports/${id}${qs({ expectedVersion })}`),
  revisions: (id: number) => api.get<RptReportListItemDto[]>(`/analysis-reports/${id}/revisions`),
  edits: (id: number) => api.get<RptSectionEditDto[]>(`/analysis-reports/${id}/edits`),
  updateSection: (id: number, sectionId: number, body: { expectedVersion: number; body: string; title?: string }) =>
    api.patch<RptReportDto>(`/analysis-reports/${id}/sections/${sectionId}`, body),
  submit: (id: number, expectedVersion: number) => api.post<RptReportDto>(`/analysis-reports/${id}/submit`, { expectedVersion }),
  returnBack: (id: number, expectedVersion: number, comment: string) => api.post<RptReportDto>(`/analysis-reports/${id}/return`, { expectedVersion, comment }),
  approve: (id: number, body: { expectedVersion: number; comment?: string; exceptionReason?: string }) => api.post<RptReportDto>(`/analysis-reports/${id}/approve`, body),
  publish: (id: number, expectedVersion: number) => api.post<{ jobId: number }>(`/analysis-reports/${id}/publish`, { expectedVersion }),
  revise: (id: number, expectedVersion: number) => api.post<RptReportDto>(`/analysis-reports/${id}/revise`, { expectedVersion }),
  exportPath: (id: number, format: 'docx' | 'pdf') => `/analysis-reports/${id}/export?format=${format}`,
};
export type { RptStatus };
