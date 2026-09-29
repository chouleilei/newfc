/**
 * confirmImportBatchWithRecovery(UX-15)行为测试:
 * - 直接成功;4xx 明确拒绝不查批次;
 * - 结果未知(网络错误/5xx)先查批次状态:committed 按成功(viaRecovery)、pending 可同批次重试、
 *   cancelled/rolled_back 明确失败、查询失败进入待核对;
 * - 任何分支都不新建导入批次(deps 只有 confirm/getDetail 两个出口)。
 */
import { describe, expect, it, vi } from 'vitest';
import { ApiError } from './client';
import {
  confirmImportBatchWithRecovery,
  type ImportBatchDetail,
  type ImportConfirmDeps,
} from './importBatch';

function makeDetail(status: ImportBatchDetail['status'], reason?: string): ImportBatchDetail {
  return {
    id: 7,
    kind: 'actual',
    status,
    history: false,
    originalName: 'a.xlsx',
    sha256: 'x'.repeat(64),
    createdAt: '2026-09-20T00:00:00.000Z',
    committedAt: status === 'committed' ? '2026-09-20T00:01:00.000Z' : null,
    rolledBackAt: null,
    target: { year: 2026, years: [2026], periods: [{ year: 2026, snapshotDate: '2026-08-31', entryCount: 3 }] },
    preview: null,
    summary: {},
    result: status === 'committed' ? { count: 3 } : null,
    detailCapability: 'frozen-detail',
    actions: {
      confirm: status === 'pending' ? { allowed: true } : { allowed: false, reason: reason ?? '预览已取消或过期' },
      cancel: status === 'pending' ? { allowed: true } : { allowed: false, reason: reason ?? '预览已取消或过期' },
      rollback: { allowed: false, reason: '批次尚未确认，可取消而非撤销' },
    },
  };
}

function makeDeps(confirmImpl: () => Promise<unknown>, detail: () => Promise<ImportBatchDetail>) {
  const deps: ImportConfirmDeps = { confirm: vi.fn(confirmImpl), getDetail: vi.fn(detail) };
  return deps;
}

describe('confirmImportBatchWithRecovery', () => {
  it('直接确认成功:committed,不查批次详情,不重发请求', async () => {
    const deps = makeDeps(() => Promise.resolve({ status: 'committed' }), () => Promise.resolve(makeDetail('committed')));
    const outcome = await confirmImportBatchWithRecovery(7, deps);
    expect(outcome).toEqual({ kind: 'committed', viaRecovery: false });
    expect(deps.confirm).toHaveBeenCalledTimes(1);
    expect(deps.confirm).toHaveBeenCalledWith(7);
    expect(deps.getDetail).not.toHaveBeenCalled();
  });

  it('4xx(基线失效/状态冲突)为明确失败:不查批次、不重试', async () => {
    const deps = makeDeps(
      () => Promise.reject(new ApiError({ code: 'CONFLICT', message: '预览后数据已被修改' }, 409)),
      () => Promise.resolve(makeDetail('cancelled')),
    );
    const outcome = await confirmImportBatchWithRecovery(7, deps);
    expect(outcome.kind).toBe('rejected');
    if (outcome.kind === 'rejected') expect(outcome.message).toContain('预览后数据已被修改');
    expect(deps.getDetail).not.toHaveBeenCalled();
  });

  it('网络错误 + 批次已提交:按成功恢复(viaRecovery),不会重复写入', async () => {
    const deps = makeDeps(
      () => Promise.reject(new TypeError('Failed to fetch')),
      () => Promise.resolve(makeDetail('committed')),
    );
    const outcome = await confirmImportBatchWithRecovery(7, deps);
    expect(outcome).toEqual({ kind: 'committed', viaRecovery: true });
    expect(deps.confirm).toHaveBeenCalledTimes(1);
  });

  it('网络错误 + 批次仍待确认:返回 still-pending,允许同一批次重试', async () => {
    const deps = makeDeps(
      () => Promise.reject(new TypeError('Failed to fetch')),
      () => Promise.resolve(makeDetail('pending')),
    );
    const outcome = await confirmImportBatchWithRecovery(7, deps);
    expect(outcome.kind).toBe('still-pending');
  });

  it('网络错误 + 批次已取消/已撤销:明确失败并带原因,不按成功处理', async () => {
    const deps = makeDeps(
      () => Promise.reject(new TypeError('Failed to fetch')),
      () => Promise.resolve(makeDetail('cancelled')),
    );
    const outcome = await confirmImportBatchWithRecovery(7, deps);
    expect(outcome.kind).toBe('rejected');
    if (outcome.kind === 'rejected') {
      expect(outcome.message).toContain('已取消');
      expect(outcome.message).toContain('未生效');
    }
  });

  it('网络错误 + 批次查询也失败:unverifiable(结果待核对),绝不显示成功', async () => {
    const deps = makeDeps(
      () => Promise.reject(new TypeError('Failed to fetch')),
      () => Promise.reject(new TypeError('Failed to fetch')),
    );
    const outcome = await confirmImportBatchWithRecovery(7, deps);
    expect(outcome.kind).toBe('unverifiable');
    if (outcome.kind === 'unverifiable') expect(outcome.reason).toBeTruthy();
  });

  it('5xx 同样按结果未知处理:先查批次状态', async () => {
    const deps = makeDeps(
      () => Promise.reject(new ApiError({ code: 'INTERNAL', message: '服务器错误' }, 500)),
      () => Promise.resolve(makeDetail('committed')),
    );
    const outcome = await confirmImportBatchWithRecovery(7, deps);
    expect(outcome).toEqual({ kind: 'committed', viaRecovery: true });
  });

  it('still-pending 后由调用方用同一批次重试,恢复逻辑本身不新建批次', async () => {
    // 第一次:网络错误 + pending;第二次重试:直接成功。deps 全程只有 confirm/getDetail 两个出口。
    let confirmCalls = 0;
    const deps = makeDeps(
      () => {
        confirmCalls += 1;
        return confirmCalls === 1 ? Promise.reject(new TypeError('Failed to fetch')) : Promise.resolve({ status: 'committed' });
      },
      () => Promise.resolve(makeDetail('pending')),
    );
    const first = await confirmImportBatchWithRecovery(7, deps);
    expect(first.kind).toBe('still-pending');
    const second = await confirmImportBatchWithRecovery(7, deps);
    expect(second).toEqual({ kind: 'committed', viaRecovery: false });
    expect(deps.confirm).toHaveBeenCalledTimes(2);
    expect(vi.mocked(deps.confirm).mock.calls.every(([id]) => id === 7)).toBe(true);
  });
});
