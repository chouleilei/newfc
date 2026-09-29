/**
 * 导入批次只读接口与确认恢复(方案《易用性与直觉化交互实施方案》§5.2/§5.3,任务 UX-15)。
 *
 * - 类型与后端 import.service.ts / preview-detail.ts 的 DTO 一一对应;
 * - 确认只发送批次 ID(服务端拒绝客户端 entries);
 * - 结果未知(网络错误/超时/5xx)时先查批次详情:已提交按成功处理并标注 viaRecovery,
 *   仍待确认可重试同一批次,绝不自动新建另一个导入批次。
 */
import { ApiError, api, errorText } from './client';

export type PreviewAction = 'insert' | 'overwrite' | 'clear' | 'unchanged' | 'note_change' | 'excluded' | 'skipped';
export type PreviewValueKind = 'amount' | 'quantity' | 'memo';
export type PreviewSource = 'standard' | 'cleaning' | 'finance';
export type DetailCapability = 'frozen-detail' | 'legacy-summary';
export type ImportBatchStatus = 'pending' | 'committed' | 'rolled_back' | 'cancelled';

export interface PreviewActionCounts {
  insert: number;
  overwrite: number;
  clear: number;
  unchanged: number;
  noteChange: number;
  excluded: number;
  skipped: number;
}

/** 统一预览摘要 DTO(创建批次时冻结;与后端 UnifiedPreviewSummary 一致)。 */
export interface UnifiedPreviewSummary {
  schemaVersion: 1;
  kind: 'budget' | 'actual';
  source: PreviewSource;
  history: boolean;
  target: { versionId?: number; versionName?: string; year?: number; years?: number[] };
  /** 实际导入按 年度×截止日 分组(多年度文件不折叠为入口年度);预算导入为空数组 */
  periods: { year: number; snapshotDate: string; entryCount: number }[];
  orgScope: { count: number; codes: string[] };
  /** 明细行精确值口径:金额整数分,数量 10^4 缩放整数 */
  amountUnit: 'yuan';
  /** 利润方向:收入为正、成本费用为负(与存储一致) */
  signConvention: 'profit_direction';
  actions: PreviewActionCounts;
  warnings: number;
  updatesCurrent: boolean;
  createsSnapshot: boolean;
  comparisonBasis: 'actual_current' | 'history_snapshot' | 'budget_entry';
  resultLocation: 'budget_entry' | 'actual_current_and_snapshot' | 'actual_history_snapshot';
}

export interface BatchActionGate {
  allowed: boolean;
  reason?: string;
}

/** 批次只读详情(与后端 getBatchDetail 一致):不返回文件正文或可修改重放的 payload。 */
export interface ImportBatchDetail {
  id: number;
  kind: 'budget' | 'actual';
  status: ImportBatchStatus;
  history: boolean;
  originalName: string;
  sha256: string;
  createdAt: string;
  committedAt: string | null;
  rolledBackAt: string | null;
  target: {
    versionId?: number;
    versionName?: string;
    year?: number;
    years?: number[];
    periods?: { year: number; snapshotDate: string; entryCount: number }[];
  };
  /** 创建时冻结的统一预览摘要;旧批次为 null */
  preview: UnifiedPreviewSummary | null;
  summary: Record<string, unknown>;
  /** 提交/撤销后的结果;pending 批次为 null */
  result: Record<string, unknown> | null;
  detailCapability: DetailCapability;
  detailNote?: string;
  actions: { confirm: BatchActionGate; cancel: BatchActionGate; rollback: BatchActionGate };
}

/** 冻结预览明细行(与后端 PreviewRowDto 一致):金额为整数分 + 无损展示字符串(元,利润方向)。 */
export interface ImportPreviewRow {
  id: number;
  groupYear: number | null;
  groupDate: string | null;
  sourceSheet: string;
  /** 源行号可追溯到源文件;null 表示该批次无法定位源行 */
  sourceRow: number | null;
  orgId: number | null;
  orgCode: string;
  accountId: number | null;
  accountCode: string;
  valueKind: PreviewValueKind;
  oldCents: number | null;
  newCents: number | null;
  oldQuantity: number | null;
  newQuantity: number | null;
  oldText: string;
  newText: string;
  oldFormula: string;
  newFormula: string;
  /** 展示用无损字符串(元/自然单位);不用于差异判断 */
  oldValue: string | null;
  newValue: string | null;
  action: PreviewAction;
  warning: string;
}

export interface ImportPreviewRowsResult {
  total: number;
  page: number;
  pageSize: number;
  detailCapability: DetailCapability;
  items: ImportPreviewRow[];
}

export interface ImportPreviewRowQuery {
  page?: number;
  pageSize?: number;
  orgId?: number;
  action?: PreviewAction;
  warningOnly?: boolean;
}

export const PREVIEW_ACTION_LABEL: Record<PreviewAction, string> = {
  insert: '新增',
  overwrite: '覆盖',
  clear: '清零',
  unchanged: '不变',
  note_change: '备注变更',
  excluded: '排除',
  skipped: '跳过',
};

export const PREVIEW_ACTION_COLOR: Record<PreviewAction, string> = {
  insert: 'green',
  overwrite: 'orange',
  clear: 'red',
  unchanged: 'default',
  note_change: 'blue',
  excluded: 'purple',
  skipped: 'default',
};

export const IMPORT_SOURCE_LABEL: Record<PreviewSource, string> = {
  standard: '标准模板导入',
  cleaning: '非标准 Excel 清洗',
  finance: '财务系统转换',
};

export const IMPORT_BATCH_STATUS_LABEL: Record<ImportBatchStatus, string> = {
  pending: '待确认',
  committed: '已提交',
  rolled_back: '已撤销',
  cancelled: '已取消',
};

export const COMPARISON_BASIS_LABEL: Record<UnifiedPreviewSummary['comparisonBasis'], string> = {
  actual_current: '当前累计实际数',
  history_snapshot: '同日历史快照(追加,不动当前累计)',
  budget_entry: '预算版本明细(草稿当前内容)',
};

export const RESULT_LOCATION_LABEL: Record<UnifiedPreviewSummary['resultLocation'], string> = {
  budget_entry: '预算版本明细',
  actual_current_and_snapshot: '当前累计实际数,并生成对应年度快照',
  actual_history_snapshot: '仅追加历史快照,不更新当前累计',
};

export function getImportBatchDetail(id: number): Promise<ImportBatchDetail> {
  return api.get<ImportBatchDetail>(`/io/import-batches/${id}`);
}

export function listImportBatchPreviewRows(id: number, params: ImportPreviewRowQuery = {}): Promise<ImportPreviewRowsResult> {
  const search = new URLSearchParams();
  if (params.page != null) search.set('page', String(params.page));
  if (params.pageSize != null) search.set('pageSize', String(params.pageSize));
  if (params.orgId != null) search.set('orgId', String(params.orgId));
  if (params.action) search.set('action', params.action);
  if (params.warningOnly) search.set('warningOnly', '1');
  const qs = search.toString();
  return api.get<ImportPreviewRowsResult>(`/io/import-batches/${id}/preview-rows${qs ? `?${qs}` : ''}`);
}

/** 确认只发送批次 ID;服务端拒绝客户端 entries(见 server.ts 校验)。 */
export function confirmImportBatch(id: number): Promise<{ id: number; status: string; kind: string; result: Record<string, unknown> }> {
  return api.post(`/io/import-batches/${id}/confirm`);
}

export function cancelImportBatch(id: number): Promise<{ ok: true }> {
  return api.post(`/io/import-batches/${id}/cancel`);
}

export type ImportConfirmOutcome =
  /** 已确认提交;viaRecovery=true 表示确认响应曾丢失,经批次状态核对确认已提交(未重复写入) */
  | { kind: 'committed'; viaRecovery: boolean }
  /** 明确失败:服务端 4xx 拒绝(校验/基线/状态),或核对发现批次已取消/已撤销;本次确认确定未生效 */
  | { kind: 'rejected'; message: string }
  /** 响应丢失,批次仍待确认:可用同一批次 ID 重试确认(服务端 committed 后重复确认会被 409 拦下) */
  | { kind: 'still-pending' }
  /** 响应丢失且批次查询失败:结果待核对,绝不按成功处理,也不新建批次 */
  | { kind: 'unverifiable'; reason: string };

export interface ImportConfirmDeps {
  confirm: (batchId: number) => Promise<unknown>;
  getDetail: (batchId: number) => Promise<ImportBatchDetail>;
}

export const defaultImportConfirmDeps: ImportConfirmDeps = {
  confirm: confirmImportBatch,
  getDetail: getImportBatchDetail,
};

/**
 * 导入确认 + 结果未知恢复(纯函数,deps 可注入 mock 便于行为测试):
 * 1. POST confirm(只带批次 ID);成功即 committed;
 * 2. 4xx 等服务端明确拒绝 → rejected(不重查);
 * 3. 结果未知(网络错误/超时/5xx) → GET 批次详情:
 *    committed 按成功处理(viaRecovery);pending → still-pending 可重试;
 *    已取消/已撤销 → rejected 并带原因;查询失败 → unverifiable。
 * 任何分支都不会新建导入批次。
 */
export async function confirmImportBatchWithRecovery(
  batchId: number,
  deps: ImportConfirmDeps = defaultImportConfirmDeps,
): Promise<ImportConfirmOutcome> {
  try {
    await deps.confirm(batchId);
    return { kind: 'committed', viaRecovery: false };
  } catch (error) {
    if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
      return { kind: 'rejected', message: errorText(error, { fallback: '确认失败' }) };
    }
    let detail: ImportBatchDetail;
    try {
      detail = await deps.getDetail(batchId);
    } catch (detailError) {
      return { kind: 'unverifiable', reason: errorText(detailError, { fallback: '批次状态查询失败' }) };
    }
    if (detail.status === 'committed') return { kind: 'committed', viaRecovery: true };
    if (detail.status === 'pending') return { kind: 'still-pending' };
    return {
      kind: 'rejected',
      message: `批次 #${batchId} 已${IMPORT_BATCH_STATUS_LABEL[detail.status]}(${detail.actions.confirm.reason ?? '不能确认'}),本次确认未生效`,
    };
  }
}
