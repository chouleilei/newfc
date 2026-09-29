import { ApiError, api } from './client';

export type CleaningTargetKind = 'budget' | 'actual-current';
export type CleaningValueKind = 'amount' | 'quantity';
export type CleaningColumnField = 'orgCode' | 'orgName' | 'accountCode' | 'accountName' | 'amount' | 'quantity' | 'note' | 'ignore';

export interface CleaningTarget {
  targetKind: CleaningTargetKind;
  versionId?: number;
  year?: number;
  snapshotDate?: string;
}

export interface CleaningPlan {
  version: 1;
  targetKind: CleaningTargetKind;
  sheets: { sheetName: string; headerRow: number; dataStartRow: number; dataEndRow: number }[];
  columns: { sourceColumn: number; field: CleaningColumnField }[];
  valueKind: CleaningValueKind;
  amountUnit?: 'yuan' | 'wan';
  signConvention?: 'display_positive' | 'profit_signed';
  excludedRows: { sheetName: string; row: number; reason: string }[];
  mappings: { kind: 'org' | 'account'; sourceText: string; targetCode: string }[];
  clearBlankNotes?: boolean;
  templateId?: number;
  aiSuggested?: boolean;
}

export interface WorkbookCellPreview { column: number; address: string; text: string; formula: boolean; merged: boolean }
export interface WorkbookRowPreview { row: number; hidden: boolean; cells: WorkbookCellPreview[] }
export interface WorkbookSheetSummary {
  name: string;
  state: 'visible' | 'hidden' | 'veryHidden';
  rowCount: number;
  columnCount: number;
  mergedRangeCount: number;
  formulaCellCount: number;
  hiddenRowCount: number;
  hiddenColumnCount: number;
  sampleRows: WorkbookRowPreview[];
}
export type CleaningRowHintKind = 'subtotal' | 'header' | 'trailer' | 'note' | 'blank';

export interface CleaningAiRowHint {
  row: number;
  kind: CleaningRowHintKind;
  reason: string;
}

export interface CleaningAiSuggestion {
  sheet: string;
  headerRow: number;
  dataStartRow: number;
  dataEndRow?: number;
  columns: { col: number; field: CleaningColumnField; confidence: number; reason?: string }[];
  suspectedExcludedRows: number[];
  warnings: string[];
  /** 行级识别建议(AI 功能增强计划阶段四);旧后端无此字段时按空数组处理 */
  rowHints?: CleaningAiRowHint[];
}
export interface CleaningWorkbookUpload {
  token: string;
  originalName: string;
  sha256: string;
  size: number;
  sheets: WorkbookSheetSummary[];
  aiAvailable: boolean;
  aiSuggestion: CleaningAiSuggestion | null;
}

export interface CleaningTargetOption {
  id: number;
  code: string;
  name: string;
  path: string;
  status: string;
  type?: string;
  unit?: string;
  quantityAgg?: string;
}
export interface CleaningIssue { sheetName: string; row: number; field: string; code: string; message: string }
export interface CleaningAnalysisRow {
  sheetName: string;
  rowNumber: number;
  hidden: boolean;
  excluded: boolean;
  exclusionReason?: string;
  suspectedReason?: string;
  sourceOrgText: string;
  sourceAccountText: string;
  sourceValueText: string;
  targetOrgCode?: string;
  targetAccountCode?: string;
  normalizedValue: string;
  warnings: string[];
}
export interface CleaningUnresolvedGroup {
  kind: 'org' | 'account';
  sourceText: string;
  rows: { sheetName: string; row: number }[];
  candidates: { code: string; name: string; path: string; status: string; score: number }[];
  staleAliasTarget?: string;
}
export interface CleaningAnalysis {
  rows: CleaningAnalysisRow[];
  errors: CleaningIssue[];
  warnings: CleaningIssue[];
  unresolved: CleaningUnresolvedGroup[];
  targets: { orgs: CleaningTargetOption[]; accounts: CleaningTargetOption[] };
  exclusionSummary: {
    amount?: { sourceAmountCents: number };
    quantity?: { groups: { accountCode: string; unit: string; quantityScaled: number }[] };
  };
  counts: { selected: number; effective: number; excluded: number; errors: number; warnings: number; unresolved: number };
}

export interface CleaningPreviewSummary {
  targetKind: CleaningTargetKind;
  valueKind: CleaningValueKind;
  amountUnit?: 'yuan' | 'wan';
  signConvention?: 'display_positive' | 'profit_signed';
  scopeLabel: string;
  actions: { insert: number; overwrite: number; unchanged: number; clear: number; excluded: number };
  counts: Record<string, number>;
  amount?: { beforeCents: number; afterCents: number; changeCents: number; excludedSourceAmountCents: number; changesByOrgAndRoot: { orgCode: string; rootAccountCode: string; changeCents: number }[] };
  quantity?: { groups: { accountCode: string; unit: string; quantityAgg: string; beforeScaled: number; afterScaled: number; changeScaled: number }[] };
  warnings: CleaningIssue[];
  clearSemantics: string;
}
export interface CleaningPreview { importBatchId: number; sha256: string; summary: CleaningPreviewSummary }
export interface CleaningPreviewRow {
  id: number;
  sheet_name: string;
  row_number: number;
  source_org_text: string;
  source_account_text: string;
  source_value_text: string;
  target_org_code: string;
  target_account_code: string;
  normalized_value: string;
  expected_value_text: string;
  action: 'insert' | 'overwrite' | 'unchanged' | 'clear' | 'excluded';
  warning: string;
}

export interface CleaningTemplate {
  id: number;
  name: string;
  targetKind: CleaningTargetKind;
  config: CleaningTemplateConfig;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}
export interface CleaningTemplateConfig {
  preferredSheetName?: string;
  sheetNamePattern?: string;
  headerRow?: number;
  dataStartRow?: number;
  columns: { sourceColumn: number; field: CleaningColumnField }[];
  valueKind: CleaningValueKind;
  amountUnit?: 'yuan' | 'wan';
  signConvention?: 'display_positive' | 'profit_signed';
  multiSheet?: boolean;
  clearBlankNotes?: boolean;
}

export interface CleaningAlias {
  id: number;
  targetKind: CleaningTargetKind;
  mappingKind: 'org' | 'account';
  sourceText: string;
  targetCode: string;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

/**
 * UX-17:reopen 恢复服务响应(201 首次 / 200 幂等 reused:true)。
 * token 仅经响应体返回,不进 URL、日志或助手上下文。
 */
export interface CleaningReopenResult {
  /** 被取消的旧预览批次 */
  sourceBatchId: number;
  /** 新临时上传凭证 */
  token: string;
  originalName: string;
  /** 原文件 SHA-256,用于核对重传/复用文件的一致性 */
  sha256: string;
  plan: CleaningPlan;
  target: CleaningTarget;
  /** true=响应丢失后的重复请求命中既有恢复会话,未创建新临时副本 */
  reused: boolean;
}

/** UX-17:410 CLEANING_SOURCE_EXPIRED 的 details——原文件无法找回,但计划与目标可恢复 */
export interface CleaningReopenExpiredDetails {
  sourceBatchId: number;
  originalName: string;
  sha256: string;
  plan: CleaningPlan | null;
  target: CleaningTarget | null;
}

/** 从 reopen 的 410 错误中提取可恢复的计划/目标;其他错误返回 null */
export function reopenExpiredDetails(error: unknown): CleaningReopenExpiredDetails | null {
  if (!(error instanceof ApiError)) return null;
  if (error.status !== 410 || error.body.code !== 'CLEANING_SOURCE_EXPIRED') return null;
  const details = error.body.details as Partial<CleaningReopenExpiredDetails> | undefined;
  if (!details || typeof details.sha256 !== 'string' || typeof details.originalName !== 'string') return null;
  return {
    sourceBatchId: Number(details.sourceBatchId ?? 0),
    originalName: details.originalName,
    sha256: details.sha256,
    plan: (details.plan ?? null) as CleaningPlan | null,
    target: (details.target ?? null) as CleaningTarget | null,
  };
}

export async function uploadCleaningWorkbook(file: File, targetKind: CleaningTargetKind): Promise<CleaningWorkbookUpload> {
  const form = new FormData();
  form.append('file', file);
  form.append('targetKind', targetKind);
  return api.post('/io/cleaning/workbook', form);
}

export const cleaningApi = {
  region: (token: string, params: { sheet: string; startRow: number; endRow: number; startCol: number; endCol: number; page: number; pageSize: number }) => {
    const query = new URLSearchParams(Object.entries(params).map(([key, value]) => [key, String(value)]));
    return api.get<{ total: number; page: number; pageSize: number; rows: WorkbookRowPreview[] }>(`/io/cleaning/workbook/${token}/region?${query}`);
  },
  analyze: (token: string, target: CleaningTarget, plan: CleaningPlan) => api.post<CleaningAnalysis>('/io/cleaning/analyze', { token, target, plan }),
  suggest: (token: string, targetKind: CleaningTargetKind) => api.post<{ available: boolean; suggestion: CleaningAiSuggestion | null }>('/io/cleaning/suggest', { token, targetKind }),
  preview: (token: string, target: CleaningTarget, plan: CleaningPlan) => api.post<CleaningPreview>('/io/cleaning/preview', { token, target, plan }),
  /** UX-17:恢复待确认批次(生成新上传会话并取消旧预览);重复请求幂等返回同一会话 */
  reopen: (batchId: number) => api.post<CleaningReopenResult>(`/io/cleaning/previews/${batchId}/reopen`),
  previewRows: (batchId: number, params: { page: number; pageSize: number; action?: string; warningOnly?: boolean }) => {
    const query = new URLSearchParams();
    query.set('page', String(params.page)); query.set('pageSize', String(params.pageSize));
    if (params.action) query.set('action', params.action);
    if (params.warningOnly) query.set('warningOnly', 'true');
    return api.get<{ total: number; page: number; pageSize: number; items: CleaningPreviewRow[] }>(`/io/cleaning/previews/${batchId}/rows?${query}`);
  },
  templates: (targetKind: CleaningTargetKind) => api.get<{ items: CleaningTemplate[] }>(`/io/cleaning/templates?targetKind=${targetKind}`),
  saveTemplate: (body: { name: string; targetKind: CleaningTargetKind; config: CleaningTemplateConfig }) => api.post<CleaningTemplate>('/io/cleaning/templates', body),
  updateTemplate: (id: number, body: { name?: string; config?: CleaningTemplateConfig }) => api.patch<CleaningTemplate>(`/io/cleaning/templates/${id}`, body),
  deleteTemplate: (id: number) => api.del<void>(`/io/cleaning/templates/${id}`),
  aliases: (targetKind: CleaningTargetKind) => api.get<{ items: CleaningAlias[] }>(`/io/cleaning/aliases?targetKind=${targetKind}`),
  saveAlias: (body: { targetKind: CleaningTargetKind; mappingKind: 'org' | 'account'; sourceText: string; targetCode: string }) => api.post<CleaningAlias>('/io/cleaning/aliases', body),
  updateAlias: (id: number, body: { sourceText?: string; targetCode?: string }) => api.patch<CleaningAlias>(`/io/cleaning/aliases/${id}`, body),
  deleteAlias: (id: number) => api.del<void>(`/io/cleaning/aliases/${id}`),
};
