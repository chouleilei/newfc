/**
 * 实际保存编排(方案《易用性与直觉化交互实施方案》§4.3/§4.9/§5.3,任务 UX-12)。
 *
 * 统一提交入口(保存按钮 / Ctrl+S / 守卫「保存并切换·离开」共用):
 * - 提交前固定请求内容并生成请求编号 requestId;单在途请求,重复点击/快捷键不重复提交;
 * - 成功(直接 200 或经回执核对确认已提交)才允许更新基线、提示成功、放行守卫;
 * - 响应丢失(网络错误/超时/5xx)先查回执:已提交按成功处理;未提交保持输入并进入
 *   「可同编号重试」的持续状态;回执查询本身失败则保持「结果待核对」,绝不显示保存成功。
 *
 * 纯函数 submitActualSave 与 hook 分离,便于注入 mock 的 save/getReceipt 做行为测试。
 */
import { useCallback, useRef, useState } from 'react';
import { ApiError, errorText } from '../../api/client';
import {
  saveActual,
  getActualSaveReceipt,
  type ActualSavePayload,
  type ActualSaveReceipt,
  type ActualSaveResult,
} from '../../api/actual';

/** 保存结果展示与重试所需的最小上下文(随待核对提交一起冻结)。 */
export interface ActualSaveMeta {
  year: number;
  history: boolean;
  snapshotDate: string;
  /** 仅附注未落库的格子:保存成功后仍保持脏标记,且守卫不放行(沿用既有语义) */
  skippedMemoOnlyKeys: string[];
}

export type ActualSaveOutcome =
  /** 已确认提交成功;viaReceipt=true 表示响应曾丢失、经回执核对确认(未重复写入) */
  | { kind: 'success'; result: ActualSaveResult; viaReceipt: boolean }
  /** 明确失败:服务端已拒绝(4xx 校验/冲突/基线),本次提交确定未生效 */
  | { kind: 'rejected'; message: string }
  /** 响应丢失,回执确认未提交:输入保留,可用相同请求编号重试 */
  | { kind: 'uncommitted'; requestId: string }
  /** 响应丢失且回执查询失败:结果待核对,输入保留,绝不按成功处理 */
  | { kind: 'unverified'; requestId: string; reason: string }
  /** 已有提交在途:本次触发被忽略(防重复提交) */
  | { kind: 'in_flight' };

/** 生成幂等请求编号:优先 crypto.randomUUID;兜底仍满足 8-64 位 [A-Za-z0-9_-]。 */
export function newSaveRequestId(): string {
  const c = globalThis.crypto;
  if (c?.randomUUID) return c.randomUUID();
  if (c?.getRandomValues) {
    const bytes = new Uint8Array(24);
    c.getRandomValues(bytes);
    return [...bytes].map((b) => b.toString(16).padStart(2, '0')).join('');
  }
  return `req_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 14)}`;
}

export interface ActualSaveDeps {
  save: (payload: ActualSavePayload) => Promise<ActualSaveResult>;
  getReceipt: (requestId: string) => Promise<ActualSaveReceipt | null>;
}

export const defaultActualSaveDeps: ActualSaveDeps = {
  save: saveActual,
  getReceipt: getActualSaveReceipt,
};

/**
 * 单次幂等提交(纯函数):
 * 1. POST 保存;成功(含 replayed)即返回 success;
 * 2. 4xx 等服务端明确拒绝 → rejected(未生效,不重查回执);
 * 3. 结果未知(网络错误/超时/5xx) → 查回执:
 *    committed 按成功处理;404 记 uncommitted;回执查询失败记 unverified。
 */
export async function submitActualSave(
  payload: ActualSavePayload,
  deps: ActualSaveDeps = defaultActualSaveDeps,
): Promise<ActualSaveOutcome> {
  try {
    const result = await deps.save(payload);
    return { kind: 'success', result, viaReceipt: result.replayed === true };
  } catch (error) {
    if (error instanceof ApiError && error.status >= 400 && error.status < 500) {
      return { kind: 'rejected', message: errorText(error) };
    }
    let receipt: ActualSaveReceipt | null;
    try {
      receipt = await deps.getReceipt(payload.requestId);
    } catch (receiptError) {
      return { kind: 'unverified', requestId: payload.requestId, reason: errorText(receiptError) };
    }
    if (receipt) {
      return { kind: 'success', result: { ...receipt.result, replayed: true }, viaReceipt: true };
    }
    return { kind: 'uncommitted', requestId: payload.requestId };
  }
}

/** 待核对提交:冻结的请求编号、内容与上下文;重试必须原样重发(同编号不同内容会被服务端 409)。 */
export interface ActualSavePending {
  requestId: string;
  payload: ActualSavePayload;
  meta: ActualSaveMeta;
  status: 'uncommitted' | 'unverified';
  /** unverified 时回执查询失败的原因 */
  reason?: string;
}

/**
 * 保存编排 hook:单在途请求 + 待核对状态。
 * submitting 期间与 pending 未解决期间,页面应锁定该实际编辑目标(输入禁用),
 * 保证重试内容与首次提交逐字节一致、markSaved 基线前移等于发送内容。
 */
export function useActualSaveOrchestration(deps: ActualSaveDeps = defaultActualSaveDeps) {
  const depsRef = useRef(deps);
  depsRef.current = deps;
  const [submitting, setSubmitting] = useState(false);
  const [pending, setPending] = useState<ActualSavePending | null>(null);
  const inFlightRef = useRef(false);
  const pendingRef = useRef(pending);
  pendingRef.current = pending;

  const submit = useCallback(async (payload: ActualSavePayload, meta: ActualSaveMeta): Promise<ActualSaveOutcome> => {
    if (inFlightRef.current) return { kind: 'in_flight' };
    inFlightRef.current = true;
    setSubmitting(true);
    try {
      const outcome = await submitActualSave(payload, depsRef.current);
      if (outcome.kind === 'uncommitted') {
        setPending({ requestId: payload.requestId, payload, meta, status: 'uncommitted' });
      } else if (outcome.kind === 'unverified') {
        setPending({ requestId: payload.requestId, payload, meta, status: 'unverified', reason: outcome.reason });
      } else {
        setPending(null);
      }
      return outcome;
    } finally {
      inFlightRef.current = false;
      setSubmitting(false);
    }
  }, []);

  /** 用相同请求编号与冻结内容重试(响应丢失后的恢复路径,不会重复生成快照)。 */
  const retryPending = useCallback(async (): Promise<{ outcome: ActualSaveOutcome; meta: ActualSaveMeta } | null> => {
    const p = pendingRef.current;
    if (!p) return null;
    const outcome = await submit(p.payload, p.meta);
    return { outcome, meta: p.meta };
  }, [submit]);

  /**
   * 放弃本次提交的核对(输入仍保留在表格中,解除锁定)。
   * 仅当用户明确选择时调用;若服务端实际已提交,后续保存会被基线校验拦下并提示刷新。
   */
  const dismissPending = useCallback(() => setPending(null), []);

  return { submitting, pending, submit, retryPending, dismissPending };
}

export type ActualSaveOrchestration = ReturnType<typeof useActualSaveOrchestration>;
