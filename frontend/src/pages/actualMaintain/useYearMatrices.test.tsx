// @vitest-environment jsdom
/**
 * useYearMatrices 年度归属(UX-28)单元测试:
 * - 年度列表前部插入新年度导致 useQueries 同位置 queryKey 换人时,
 *   旧年度数据不得以占位/缓存形式出现在新年度标签下(§4.10 禁止「新年度标题配旧年度数值」);
 * - 响应自带的年度/版本年度与请求年度不符时,视为加载中,不进入展示层;
 * - 同键后台重取(同年度再次 enabled)保留旧数据,不清空正在看的内容。
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, renderHook, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { ReactNode } from 'react';
import { api } from '../../api/client';
import type { ActualMatrixResponse, BudgetMatrixResponse, VersionRow } from './types';
import { useYearMatrices } from './useYearMatrices';

const actualMatrix = (year: number, amountCents: number): ActualMatrixResponse => ({
  yearState: { year, status: 'open', current_batch_id: 1 },
  currentBatch: { id: 1, snapshot_date: `${year}-08-31`, revision: 1, source: 'manual' },
  orgRows: [],
  accountRows: [],
  leafOrgIds: [101],
  leafAccountIds: [3],
  activeAccountIds: [3],
  financeOwnedCells: [],
  entries: [{ orgId: 101, accountId: 3, amountCents, amountDisplay: '', quantity: null, source: 'manual' }],
  cellNotes: [],
});

const budgetMatrix = (versionId: number, year: number): BudgetMatrixResponse => ({
  version: { id: versionId, year, name: `${year} 年初预算`, status: 'locked', is_current: 1 },
  entries: [],
});

const VERSIONS: VersionRow[] = [
  { id: 11, year: 2025, name: '2025 年初预算', status: 'locked', is_current: 1, kind: 'budget' },
];

function setup(years: number[], viewMode: 'orgs' | 'years' = 'orgs', editYear?: number) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
  const wrapper = ({ children }: { children: ReactNode }) => (
    <QueryClientProvider client={qc}>{children}</QueryClientProvider>
  );
  return renderHook(
    (props: { years: number[] }) => useYearMatrices(props.years, VERSIONS, editYear ?? props.years[props.years.length - 1], viewMode),
    { wrapper, initialProps: { years } },
  );
}

describe('useYearMatrices · 年度归属(UX-28)', () => {
  beforeEach(() => {
    vi.restoreAllMocks();
    vi.spyOn(api, 'get').mockImplementation((path: string) => {
      if (path.startsWith('/actual/matrix?year=2025')) return Promise.resolve(actualMatrix(2025, 500)) as never;
      if (path.startsWith('/versions/11/matrix')) return Promise.resolve(budgetMatrix(11, 2025)) as never;
      // 其余请求(如 2024 年矩阵)悬置,保持加载中
      return new Promise(() => undefined) as never;
    });
  });

  afterEach(() => cleanup());

  it('年度列表前部插入新年度:新年度不继承旧年度数据,标记为加载中', async () => {
    // 多年视图所有年度都启用,才能真实复现「位置换人」场景(单组织视图非编辑年度的查询本就停用)
    const { result, rerender } = setup([2025], 'years');
    await waitFor(() => expect(result.current[2025].actualLoadStatus).toBe('ready'));
    expect(result.current[2025].actualEntries.get('101:3')?.amountCents).toBe(500);

    // versions 异步加载后,2024 插入列表前部,useQueries 位置 0 的 queryKey 换人
    rerender({ years: [2024, 2025] });
    const y2024 = result.current[2024];
    expect(y2024.actualLoadStatus).toBe('loading');
    expect(y2024.actualEntries.size).toBe(0);
    // 旧年度保持自己的数据,不被插入扰动
    expect(result.current[2025].actualLoadStatus).toBe('ready');
    expect(result.current[2025].actualEntries.get('101:3')?.amountCents).toBe(500);
  });

  it('响应年度与请求年度不符:视为加载中,不进入展示层', async () => {
    vi.mocked(api.get).mockImplementation((path: string) => {
      if (path.startsWith('/actual/matrix')) return Promise.resolve(actualMatrix(2024, 900)) as never;
      if (path.startsWith('/versions/11/matrix')) return Promise.resolve(budgetMatrix(11, 2025)) as never;
      return new Promise(() => undefined) as never;
    });
    const { result } = setup([2025]);
    await waitFor(() => expect(result.current[2025]).toBeDefined());
    // 请求 2025 却返回 2024 的数据:状态保持 loading,条目不展示
    await waitFor(() => expect(api.get).toHaveBeenCalled());
    expect(result.current[2025].actualLoadStatus).toBe('loading');
    expect(result.current[2025].actualEntries.size).toBe(0);
  });

  it('同年度后台重取保留旧数据(不清空正在看的内容)', async () => {
    const { result, rerender } = setup([2025]);
    await waitFor(() => expect(result.current[2025].actualLoadStatus).toBe('ready'));
    // 同键重渲染/后台 refetch 在途:数据仍在,状态 ready
    rerender({ years: [2025] });
    expect(result.current[2025].actualEntries.get('101:3')?.amountCents).toBe(500);
  });
});
