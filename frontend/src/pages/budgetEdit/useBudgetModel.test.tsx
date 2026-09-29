// @vitest-environment jsdom
/**
 * useBudgetModel 行模型(UX-06)单元测试:
 * - 全部科目(all)按版本绑定快照构造完整树并展开到可填写末级,不依赖任何自定义模板
 * - 一级汇总(overview)保持根科目折叠单行
 * - 未知表返回空行模型(由页面给出空态提示)
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { api } from '../../api/client';
import type { MatrixResponse } from './types';
import { useBudgetModel } from './useBudgetModel';

const matrix: MatrixResponse = {
  version: { id: 1, year: 2026, name: '年初预算', status: 'draft', is_current: 0, kind: 'budget', note: '', org_tree_snapshot_id: 1, account_tree_snapshot_id: 1, revision: 1 },
  orgNodes: [
    { id: 100, parent_id: null, code: 'G', name: '集团', status: 'active' },
    { id: 101, parent_id: 100, code: 'G01', name: '华东', status: 'active' },
  ],
  accountNodes: [
    { id: 1, parent_id: null, code: 'I', name: '收入', type: 'income', status: 'active' },
    { id: 2, parent_id: 1, code: 'I1', name: '主营业务收入', type: 'income', status: 'active' },
    { id: 3, parent_id: 2, code: 'I101', name: '电费收入', type: 'income', status: 'active' },
    { id: 4, parent_id: null, code: 'C', name: '成本', type: 'cost', status: 'active' },
    { id: 5, parent_id: 4, code: 'C1', name: '营业成本', type: 'cost', status: 'active' },
  ],
  leafOrgIds: [101],
  leafAccountIds: [3, 5],
  entries: [],
  cellNotes: [],
};

function setup(sheetKey: string) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  /* dbSheets 传空:全部科目视图不得依赖任何自定义模板恰好存在 */
  return renderHook(() => useBudgetModel(1, sheetKey, null, []), { wrapper });
}

describe('useBudgetModel · 全部科目视图(UX-06)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'get').mockImplementation((path: string) => (
      Promise.resolve(path.includes('/matrix') ? matrix : { items: [] }) as never
    ));
  });

  afterEach(() => cleanup());

  it('sheet=all:无自定义模板时按版本快照展开全部科目到末级', async () => {
    const { result } = setup('all');
    await waitFor(() => expect(result.current.isLoading).toBe(false));
    const rows = result.current.rows;
    expect(rows.map((r) => r.code)).toEqual(['I', 'I1', 'I101', 'C', 'C1']);
    // 完全展开:没有「此处折叠」的汇总行,层级深度正确
    expect(rows.every((r) => r.kind === 'account' && !r.collapsedHere)).toBe(true);
    expect(rows.map((r) => (r.kind === 'account' ? r.depth : -1))).toEqual([0, 1, 2, 0, 1]);
    const leaves = rows.filter((r) => r.kind === 'account' && r.isLeaf);
    expect(leaves.map((r) => r.code)).toEqual(['I101', 'C1']);
  });

  it('sheet=overview:根科目折叠为单行汇总;未知表返回空行模型', async () => {
    const overview = setup('overview');
    await waitFor(() => expect(overview.result.current.isLoading).toBe(false));
    expect(overview.result.current.rows.map((r) => r.code)).toEqual(['I', 'C']);
    expect(overview.result.current.rows.every((r) => r.kind === 'account' && r.collapsedHere)).toBe(true);

    const unknown = setup('no-such-sheet');
    await waitFor(() => expect(unknown.result.current.isLoading).toBe(false));
    expect(unknown.result.current.rows).toEqual([]);
  });
});
