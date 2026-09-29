// @vitest-environment jsdom
/**
 * 实际保存编排(UX-12)单元测试:
 * - 纯函数 submitActualSave:直接成功 / replayed / 明确失败(4xx 不查回执) /
 *   结果未知(网络错误、5xx)先查回执 → 已提交按成功 / 404 未提交可重试 / 回执查询失败待核对
 * - hook useActualSaveOrchestration:单在途防重复提交、待核对状态、
 *   同编号同内容重试、放弃核对
 * api 层全部经注入的 mock 替代,不发起真实请求。
 */
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { ApiError } from '../../api/client';
import {
  submitActualSave,
  useActualSaveOrchestration,
  newSaveRequestId,
  type ActualSaveDeps,
  type ActualSaveMeta,
} from './useActualSaveOrchestration';
import type { ActualSavePayload, ActualSaveReceipt, ActualSaveResult } from '../../api/actual';

const META: ActualSaveMeta = { year: 2026, history: false, snapshotDate: '2026-08-31', skippedMemoOnlyKeys: [] };

const payloadOf = (requestId = 'req-test-0001'): ActualSavePayload => ({
  year: 2026,
  snapshotDate: '2026-08-31',
  entries: [{ orgId: 101, accountId: 1, amount: '100.00' }],
  mode: 'replace',
  history: false,
  expectedCurrentBatchId: 7,
  allowEmptyReplace: false,
  requestId,
});

const resultOf = (replayed = false): ActualSaveResult => ({
  batchId: 42,
  saved: 1,
  deleted: 0,
  cellNotesSaved: 0,
  cellNotesDeleted: 0,
  replayed,
});

const receiptOf = (requestId: string): ActualSaveReceipt => ({
  committed: true,
  requestId,
  year: 2026,
  batchId: 42,
  result: { batchId: 42, saved: 1, deleted: 0, cellNotesSaved: 0, cellNotesDeleted: 0 },
  createdAt: '2026-09-20T01:00:00.000Z',
});

const apiError = (status: number, message: string) => new ApiError({ code: 'X', message }, status);

/* ============ newSaveRequestId ============ */

describe('newSaveRequestId(幂等请求编号)', () => {
  it('满足 8-64 位 [A-Za-z0-9_-] 且每次不同', () => {
    const a = newSaveRequestId();
    const b = newSaveRequestId();
    expect(a).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(b).toMatch(/^[A-Za-z0-9_-]{8,64}$/);
    expect(a).not.toBe(b);
  });
});

/* ============ 纯函数:submitActualSave ============ */

describe('submitActualSave(单次幂等提交)', () => {
  it('直接成功:不查回执,viaReceipt=false', async () => {
    const deps: ActualSaveDeps = {
      save: vi.fn().mockResolvedValue(resultOf(false)),
      getReceipt: vi.fn(),
    };
    const outcome = await submitActualSave(payloadOf(), deps);
    expect(outcome).toEqual({ kind: 'success', result: resultOf(false), viaReceipt: false });
    expect(deps.getReceipt).not.toHaveBeenCalled();
  });

  it('服务端命中既有回执(replayed=true):viaReceipt=true,不重复写入', async () => {
    const deps: ActualSaveDeps = {
      save: vi.fn().mockResolvedValue(resultOf(true)),
      getReceipt: vi.fn(),
    };
    const outcome = await submitActualSave(payloadOf(), deps);
    expect(outcome.kind).toBe('success');
    if (outcome.kind === 'success') {
      expect(outcome.viaReceipt).toBe(true);
      expect(outcome.result.batchId).toBe(42);
    }
  });

  it('4xx 明确拒绝(校验/冲突):rejected,不查回执', async () => {
    const getReceipt = vi.fn();
    const deps: ActualSaveDeps = {
      save: vi.fn().mockRejectedValue(apiError(400, '实际数格式不正确')),
      getReceipt,
    };
    const outcome = await submitActualSave(payloadOf(), deps);
    expect(outcome).toEqual({ kind: 'rejected', message: '实际数格式不正确' });
    expect(getReceipt).not.toHaveBeenCalled();
  });

  it('409 同编号不同内容:rejected,不查回执', async () => {
    const deps: ActualSaveDeps = {
      save: vi.fn().mockRejectedValue(apiError(409, '相同请求编号的内容不一致')),
      getReceipt: vi.fn(),
    };
    const outcome = await submitActualSave(payloadOf(), deps);
    expect(outcome.kind).toBe('rejected');
    expect(deps.getReceipt).not.toHaveBeenCalled();
  });

  it('响应丢失(网络错误)+ 回执已提交:按成功处理,结果取自回执且不重复写入', async () => {
    const deps: ActualSaveDeps = {
      save: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
      getReceipt: vi.fn().mockResolvedValue(receiptOf('req-test-0001')),
    };
    const outcome = await submitActualSave(payloadOf(), deps);
    expect(deps.getReceipt).toHaveBeenCalledWith('req-test-0001');
    expect(outcome.kind).toBe('success');
    if (outcome.kind === 'success') {
      expect(outcome.viaReceipt).toBe(true);
      expect(outcome.result).toEqual({ ...receiptOf('req-test-0001').result, replayed: true });
    }
  });

  it('响应丢失 + 回执 404:uncommitted(未提交,可同编号重试)', async () => {
    const deps: ActualSaveDeps = {
      save: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
      getReceipt: vi.fn().mockResolvedValue(null),
    };
    const outcome = await submitActualSave(payloadOf('req-abc-123'), deps);
    expect(outcome).toEqual({ kind: 'uncommitted', requestId: 'req-abc-123' });
  });

  it('响应丢失 + 回执查询本身失败:unverified(结果待核对,绝不按成功处理)', async () => {
    const deps: ActualSaveDeps = {
      save: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
      getReceipt: vi.fn().mockRejectedValue(new Error('回执查询超时')),
    };
    const outcome = await submitActualSave(payloadOf('req-xyz-999'), deps);
    expect(outcome).toEqual({ kind: 'unverified', requestId: 'req-xyz-999', reason: '回执查询超时' });
  });

  it('5xx 无明确业务结论:视为结果未知,先查回执', async () => {
    const deps: ActualSaveDeps = {
      save: vi.fn().mockRejectedValue(apiError(502, 'Bad Gateway')),
      getReceipt: vi.fn().mockResolvedValue(null),
    };
    const outcome = await submitActualSave(payloadOf(), deps);
    expect(deps.getReceipt).toHaveBeenCalled();
    expect(outcome.kind).toBe('uncommitted');
  });
});

/* ============ hook:useActualSaveOrchestration ============ */

describe('useActualSaveOrchestration(提交编排)', () => {
  it('提交在途时 submitting=true;成功提交后无待核对状态', async () => {
    let release!: (r: ActualSaveResult) => void;
    const deps: ActualSaveDeps = {
      save: vi.fn().mockImplementation(() => new Promise<ActualSaveResult>((resolve) => { release = resolve; })),
      getReceipt: vi.fn(),
    };
    const { result } = renderHook(() => useActualSaveOrchestration(deps));
    let done!: Promise<unknown>;
    act(() => { done = result.current.submit(payloadOf(), META); });
    expect(result.current.submitting).toBe(true);
    await act(async () => { release(resultOf(false)); await done; });
    expect(result.current.submitting).toBe(false);
    expect(result.current.pending).toBeNull();
    await expect(done).resolves.toMatchObject({ kind: 'success' });
  });

  it('重复提交(双击/连按快捷键):第二次返回 in_flight,save 只调用一次', async () => {
    let release!: (r: ActualSaveResult) => void;
    const deps: ActualSaveDeps = {
      save: vi.fn().mockImplementation(() => new Promise<ActualSaveResult>((resolve) => { release = resolve; })),
      getReceipt: vi.fn(),
    };
    const { result } = renderHook(() => useActualSaveOrchestration(deps));
    let first!: Promise<unknown>;
    let second!: Promise<unknown>;
    act(() => {
      first = result.current.submit(payloadOf(), META);
      second = result.current.submit(payloadOf('req-other'), META);
    });
    await expect(second).resolves.toEqual({ kind: 'in_flight' });
    expect(deps.save).toHaveBeenCalledTimes(1);
    await act(async () => { release(resultOf(false)); await first; });
  });

  it('响应丢失且未提交:进入待核对;同编号同内容重试成功后清除', async () => {
    const save = vi.fn()
      .mockRejectedValueOnce(new TypeError('Failed to fetch'))
      .mockResolvedValueOnce(resultOf(true));
    const deps: ActualSaveDeps = { save, getReceipt: vi.fn().mockResolvedValue(null) };
    const { result } = renderHook(() => useActualSaveOrchestration(deps));
    const payload = payloadOf('req-retry-01');

    let outcome!: unknown;
    await act(async () => { outcome = await result.current.submit(payload, META); });
    expect(outcome).toMatchObject({ kind: 'uncommitted', requestId: 'req-retry-01' });
    expect(result.current.pending).toMatchObject({ requestId: 'req-retry-01', status: 'uncommitted' });

    // 重试:必须原样重发(相同 requestId + 冻结内容),服务端幂等返回原回执
    let retried!: { outcome: unknown } | null;
    await act(async () => { retried = await result.current.retryPending(); });
    expect(save).toHaveBeenCalledTimes(2);
    expect(save.mock.calls[1][0]).toBe(payload);
    expect(save.mock.calls[1][0].requestId).toBe('req-retry-01');
    expect(retried?.outcome).toMatchObject({ kind: 'success', viaReceipt: true });
    expect(result.current.pending).toBeNull();
  });

  it('回执查询失败:pending 为 unverified 并保留原因;重试仍失败则保持待核对', async () => {
    const deps: ActualSaveDeps = {
      save: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
      getReceipt: vi.fn().mockRejectedValue(new Error('网络中断')),
    };
    const { result } = renderHook(() => useActualSaveOrchestration(deps));
    await act(async () => { await result.current.submit(payloadOf('req-unverified'), META); });
    expect(result.current.pending).toMatchObject({ requestId: 'req-unverified', status: 'unverified', reason: '网络中断' });

    // 重试仍然结果未知:pending 保留,绝不清除为成功
    let retried!: { outcome: unknown } | null;
    await act(async () => { retried = await result.current.retryPending(); });
    expect(retried?.outcome).toMatchObject({ kind: 'unverified' });
    expect(result.current.pending).not.toBeNull();
    expect(result.current.submitting).toBe(false);
  });

  it('响应丢失后查回执已提交:直接按成功处理,不进入待核对', async () => {
    const deps: ActualSaveDeps = {
      save: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
      getReceipt: vi.fn().mockResolvedValue(receiptOf('req-committed')),
    };
    const { result } = renderHook(() => useActualSaveOrchestration(deps));
    let outcome!: unknown;
    await act(async () => { outcome = await result.current.submit(payloadOf('req-committed'), META); });
    expect(outcome).toMatchObject({ kind: 'success', viaReceipt: true });
    expect(result.current.pending).toBeNull();
  });

  it('明确失败(4xx):不进入待核对,允许用户修改后重新保存(新编号)', async () => {
    const deps: ActualSaveDeps = {
      save: vi.fn().mockRejectedValue(apiError(400, '截止日不能早于当前累计截止日')),
      getReceipt: vi.fn(),
    };
    const { result } = renderHook(() => useActualSaveOrchestration(deps));
    let outcome!: unknown;
    await act(async () => { outcome = await result.current.submit(payloadOf(), META); });
    expect(outcome).toMatchObject({ kind: 'rejected' });
    expect(result.current.pending).toBeNull();
  });

  it('放弃本次提交:dismissPending 清除待核对状态;无待核对时 retryPending 返回 null', async () => {
    const deps: ActualSaveDeps = {
      save: vi.fn().mockRejectedValue(new TypeError('Failed to fetch')),
      getReceipt: vi.fn().mockResolvedValue(null),
    };
    const { result } = renderHook(() => useActualSaveOrchestration(deps));
    await act(async () => { await result.current.submit(payloadOf(), META); });
    expect(result.current.pending).not.toBeNull();
    act(() => { result.current.dismissPending(); });
    expect(result.current.pending).toBeNull();
    let retried!: unknown;
    await act(async () => { retried = await result.current.retryPending(); });
    expect(retried).toBeNull();
  });
});
