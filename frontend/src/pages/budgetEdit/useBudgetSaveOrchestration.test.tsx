// @vitest-environment jsdom
/**
 * 预算页保存编排(UX-05)单元测试:
 * - Ctrl/Cmd+S 立即排空防抖并保存最新输入,不触发编制记录接口
 * - 无脏数据时重复快捷键不产生额外保存请求
 * - 保存请求在途时继续输入,再次保存严格串行且 revision 顺延;markPersisted 收到的是"已发送快照"
 * - 保存失败保留持续可见的 saveError,重试成功后清除
 * - 格式错误时拦截保存并保持 invalid 状态
 * - runAfterSaves(编制记录等互斥动作)排在在途保存之后、后续保存之前
 * - 汇总格备注随整包一并提交
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App } from 'antd';
import type { ReactNode } from 'react';
import { api, ApiError } from '../../api/client';
import type { MatrixResponse } from './types';
import { useBudgetSaveOrchestration } from './useBudgetSaveOrchestration';
import { buildPristineBudgetValues } from './types';

const matrix: MatrixResponse = {
  version: { id: 1, year: 2026, name: '年初预算', status: 'draft', is_current: 0, kind: 'budget', note: '', org_tree_snapshot_id: 1, account_tree_snapshot_id: 1, revision: 7 },
  orgNodes: [{ id: 101, parent_id: null, code: 'X1', name: '组织一', status: 'active' }],
  accountNodes: [{ id: 1, parent_id: null, code: 'A1', name: '科目一', type: 'expense', status: 'active' }],
  leafOrgIds: [101],
  leafAccountIds: [1],
  entries: [],
  cellNotes: [],
};

type Opts = Parameters<typeof useBudgetSaveOrchestration>[0];

function baseOpts(overrides: Partial<Opts> = {}): Opts {
  return {
    versionId: 1,
    data: matrix,
    editable: true,
    draftActionPending: false,
    dirty: false,
    invalidCount: 0,
    values: new Map(),
    formulas: new Map(),
    notes: new Map(),
    summaryNotes: new Map(),
    setSummaryNotes: vi.fn(),
    markPersisted: vi.fn(),
    resetData: vi.fn(),
    refreshSummary: vi.fn().mockResolvedValue(undefined),
    ...overrides,
  };
}

function setup(overrides: Partial<Opts> = {}) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}><App>{children}</App></QueryClientProvider>
  );
  const hook = renderHook((p: Opts) => useBudgetSaveOrchestration(p), { wrapper, initialProps: baseOpts(overrides) });
  act(() => { hook.result.current.revisionRef.current = 7; });
  return { ...hook, qc };
}

function pressCtrlS() {
  act(() => {
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 's', ctrlKey: true, bubbles: true, cancelable: true }));
  });
}

describe('useBudgetSaveOrchestration', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'put').mockResolvedValue({ saved: 1, deleted: 0, revision: 8 });
    vi.spyOn(api, 'post').mockResolvedValue({});
  });

  afterEach(() => cleanup());

  it('Ctrl+S 立即保存最新输入(万元转元),不调用编制记录接口', async () => {
    const put = vi.mocked(api.put);
    const post = vi.mocked(api.post);
    setup({ dirty: true, values: new Map([['101:1', '12.34']]) });
    pressCtrlS();
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    const [path, body] = put.mock.calls[0] as unknown as [string, { entries: { amount?: string }[]; expectedRevision: number }];
    expect(path).toBe('/versions/1/entries');
    expect(body.expectedRevision).toBe(7);
    expect(body.entries).toHaveLength(1);
    // 12.34 万元 = 123,400.00 元(UI 万元两位小数,接口为标准元)
    expect(body.entries[0].amount).toBe('123400.00');
    // 快捷键不再生成编制记录
    expect(post.mock.calls.filter((c) => String(c[0]).includes('checkpoints'))).toHaveLength(0);
  });

  it('无待保存修改时重复 Ctrl+S 不产生额外保存请求', async () => {
    const put = vi.mocked(api.put);
    const { result, rerender } = setup({ dirty: true, values: new Map([['101:1', '12.34']]) });
    pressCtrlS();
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    // 保存成功后用户未再编辑:网格脏标记清除
    rerender(baseOpts({ dirty: false, values: new Map([['101:1', '12.34']]) }));
    pressCtrlS();
    pressCtrlS();
    await new Promise((r) => setTimeout(r, 50));
    expect(put).toHaveBeenCalledTimes(1);
    expect(result.current.autoSaveState).toBe('saved');
  });

  it('保存在途时继续输入:再次保存严格串行,revision 顺延,markPersisted 收到已发送快照', async () => {
    let resolveFirst!: (v: { saved: number; deleted: number; revision: number }) => void;
    const put = vi.mocked(api.put);
    put.mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }));
    put.mockResolvedValue({ saved: 1, deleted: 0, revision: 9 });
    const markPersisted = vi.fn();
    const valuesA = new Map([['101:1', '12.34']]);
    const { result, rerender } = setup({ dirty: true, values: valuesA, markPersisted });
    pressCtrlS();
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    // 在途期间继续输入第二处修改,再次 Ctrl+S
    rerender(baseOpts({ dirty: true, values: new Map([['101:1', '56.78']]), markPersisted }));
    pressCtrlS();
    await new Promise((r) => setTimeout(r, 30));
    // 第二次保存必须等第一次完成,串行队列不允许并发
    expect(put).toHaveBeenCalledTimes(1);
    resolveFirst({ saved: 1, deleted: 0, revision: 8 });
    await waitFor(() => expect(put).toHaveBeenCalledTimes(2));
    const secondBody = put.mock.calls[1][1] as { expectedRevision: number; entries: { amount?: string }[] };
    expect(secondBody.expectedRevision).toBe(8);
    expect(secondBody.entries[0].amount).toBe('567800.00');
    // 基线前移以第一次实际发送的快照为准,在途期间的新输入保持脏标记(由 markPersisted 重算)
    expect(markPersisted.mock.calls[0][0]).toEqual(valuesA);
    expect(result.current.autoSaveState).toBe('saved');
  });

  it('保存失败保留持续的 saveError 与失败状态,重试成功后清除', async () => {
    const put = vi.mocked(api.put);
    put.mockRejectedValueOnce(new Error('网络超时'));
    const { result } = setup({ dirty: true, values: new Map([['101:1', '1']]) });
    pressCtrlS();
    await waitFor(() => expect(result.current.saveError).toBe('网络超时'));
    expect(result.current.autoSaveState).toBe('error');
    // 重试(同一入口):成功后清除持续错误并回到已保存
    act(() => { result.current.requestSaveNow(); });
    await waitFor(() => expect(result.current.autoSaveState).toBe('saved'));
    expect(result.current.saveError).toBeNull();
    expect(put).toHaveBeenCalledTimes(2);
  });

  it('存在格式错误时拦截保存并保持 invalid 状态', async () => {
    const put = vi.mocked(api.put);
    const { result } = setup({ dirty: true, invalidCount: 2, values: new Map([['101:1', 'abc']]) });
    pressCtrlS();
    await new Promise((r) => setTimeout(r, 30));
    expect(put).not.toHaveBeenCalled();
    expect(result.current.autoSaveState).toBe('invalid');
  });

  it('自动保存防抖约 1.3 秒后落库', async () => {
    const put = vi.mocked(api.put);
    setup({ dirty: true, values: new Map([['101:1', '3.21']]) });
    expect(put).not.toHaveBeenCalled();
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1), { timeout: 2500 });
  });

  it('汇总格备注随整包一并提交;runAfterSaves 排在在途保存之后、后续保存之前', async () => {
    let resolveFirst!: (v: { saved: number; deleted: number; revision: number }) => void;
    const put = vi.mocked(api.put);
    put.mockImplementationOnce(() => new Promise((r) => { resolveFirst = r; }));
    put.mockResolvedValue({ saved: 1, deleted: 0, revision: 9 });
    const order: string[] = [];
    const { result, rerender } = setup({
      dirty: true,
      values: new Map([['101:1', '1']]),
      summaryNotes: new Map([['101:0', '汇总口径说明']]),
    });
    pressCtrlS();
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    // 互斥动作(如生成编制记录)排进同一队列
    let checkpointResolved = false;
    const checkpointPromise = result.current.runAfterSaves(() => { order.push('checkpoint'); return Promise.resolve('ok'); });
    // 随后继续输入触发的保存应排在编制记录之后
    rerender(baseOpts({ dirty: true, values: new Map([['101:1', '2']]) }));
    pressCtrlS();
    resolveFirst({ saved: 1, deleted: 0, revision: 8 });
    await checkpointPromise.then(() => { checkpointResolved = true; });
    await waitFor(() => expect(put).toHaveBeenCalledTimes(2));
    expect(checkpointResolved).toBe(true);
    expect(order).toEqual(['checkpoint']);
    const firstBody = put.mock.calls[0][1] as { cellNotes: { note: string }[] };
    expect(firstBody.cellNotes).toEqual([{ orgId: 101, accountId: 0, note: '汇总口径说明' }]);
  });

  /* ---------- UX-20/UX-21 冲突恢复编排 ---------- */

  it('保存成功后精确基线随提交内容推进(利润方向分)', async () => {
    const put = vi.mocked(api.put);
    const { result } = setup({ dirty: true, values: new Map([['101:1', '12.34']]) });
    pressCtrlS();
    await waitFor(() => expect(put).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(result.current.autoSaveState).toBe('saved'));
    // expense 科目:12.34 万 = 123,400 元,存储为利润方向负值
    expect(result.current.baselineRef.current?.revision).toBe(8);
    expect(result.current.baselineRef.current?.cells.get('101:1')?.amountCents).toBe(-12340000);
  });

  it('冲突恢复保存:使用刚采纳服务器的 expectedRevision 与精确基线直通,409 时重新进入冲突', async () => {
    const put = vi.mocked(api.put);
    const { result } = setup();
    // 服务器最新矩阵:该格被他人改成 0.51 元(万元显示同为 0.00)
    const server: MatrixResponse = {
      ...matrix,
      version: { ...matrix.version, revision: 9 },
      entries: [{ orgId: 101, accountId: 1, amountCents: -51, amountDisplay: '0.51', quantity: null, formula: '', note: '' }],
    };
    act(() => { result.current.beginConflictResolution(server); });
    expect(result.current.baselineRef.current?.revision).toBe(9);
    // 恢复保存:快照显示与服务器一致('0.00' 万),必须直通服务器精确分而不是回写成 0
    await act(async () => {
      await result.current.saveResolvedDraft(
        { values: new Map([['101:1', '0.00']]), formulas: new Map(), notes: new Map(), summaryNotes: new Map() },
        9,
        buildPristineBudgetValues(server),
      );
    });
    const [path, body] = put.mock.calls[0] as unknown as [string, { entries: { amount?: string }[]; expectedRevision: number }];
    expect(path).toBe('/versions/1/entries');
    expect(body.expectedRevision).toBe(9);
    expect(body.entries[0].amount).toBe('0.51');
    expect(result.current.saveConflict).toBe(false);

    // 恢复保存期间服务器又被修改 -> 409 -> 重新进入冲突流程
    put.mockRejectedValueOnce(new ApiError({ message: 'revision conflict' } as never, 409));
    await act(async () => {
      await result.current.saveResolvedDraft(
        { values: new Map([['101:1', '0.00']]), formulas: new Map(), notes: new Map(), summaryNotes: new Map() },
        9,
        buildPristineBudgetValues(server),
      ).catch(() => undefined);
    });
    expect(result.current.saveConflict).toBe(true);
  });
});
