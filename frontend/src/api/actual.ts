/**
 * 实际数保存 API(UX-11/UX-12):
 * - POST /api/actual/save 携带幂等请求编号 requestId,同编号同规范化内容重试返回原回执;
 * - GET /api/actual/save-requests/:requestId 只读回执查询,404 表示无成功回执
 *   (查不到不代表输入一定未到达,重试仍须沿用相同请求编号)。
 */
import { api, ApiError } from './client';

export interface ActualSaveEntry {
  orgId: number;
  accountId: number;
  /** 标准元字符串(服务端按整数分解析);与 quantity 二选一 */
  amount?: string;
  /** 数量字符串(最多四位小数) */
  quantity?: string;
  memo?: string;
}

export interface ActualSaveCellNote {
  orgId: number;
  accountId: number;
  memo: string;
}

/** 界面整包保存请求体:提交前固定内容并生成 requestId,重试沿用同一编号(UX-12)。 */
export interface ActualSavePayload {
  year: number;
  snapshotDate: string;
  entries: ActualSaveEntry[];
  mode: 'replace';
  /** 历史补录:只追加历史快照,不更新当前累计 */
  history: boolean;
  expectedCurrentBatchId: number | null;
  allowEmptyReplace: boolean;
  /** 汇总格备注(仅当前任务随整包提交;历史任务不传) */
  cellNotes?: ActualSaveCellNote[];
  /** 幂等请求编号:8-64 位字母/数字/连字符/下划线(建议 UUID) */
  requestId: string;
}

export interface ActualSaveResult {
  batchId: number;
  saved: number;
  deleted: number;
  cellNotesSaved: number;
  cellNotesDeleted: number;
  /** true = 命中既有回执:本次是响应丢失后的同编号重试,未重复写入实际/快照 */
  replayed: boolean;
}

/** 回执查询成功响应(committed 恒为 true;无成功回执时接口返回 404)。 */
export interface ActualSaveReceipt {
  committed: true;
  requestId: string;
  year: number;
  batchId: number;
  result: Omit<ActualSaveResult, 'replayed'>;
  createdAt: string;
}

export function saveActual(payload: ActualSavePayload): Promise<ActualSaveResult> {
  return api.post<ActualSaveResult>('/actual/save', payload);
}

/**
 * 只读回执查询:返回 null 表示没有已提交成功的回执(404);
 * 其余错误(网络/5xx)照常抛出,由调用方按「结果待核对」处理。
 */
export async function getActualSaveReceipt(requestId: string): Promise<ActualSaveReceipt | null> {
  try {
    return await api.get<ActualSaveReceipt>(`/actual/save-requests/${encodeURIComponent(requestId)}`);
  } catch (error) {
    if (error instanceof ApiError && error.status === 404) return null;
    throw error;
  }
}
