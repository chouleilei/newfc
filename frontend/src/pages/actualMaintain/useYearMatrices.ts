import { useMemo } from 'react';
import { useQueries } from '@tanstack/react-query';
import { api } from '../../api/client';
import type { YearData, VersionRow, ActualMatrixResponse, BudgetMatrixResponse } from './types';

/** 按需加载年度矩阵：默认仅编辑年度，多年视图再启用其余年度。 */
export function useYearMatrices(years: number[], versions: VersionRow[] | undefined, editYear: number, viewMode: 'orgs' | 'years'): Record<number, YearData> {
  const selected = useMemo(() => years.map((year) => {
    const vers = (versions ?? []).filter((v) => v.year === year && v.kind === 'budget' && v.status !== 'draft');
    return { year, version: vers.find((v) => v.is_current) ?? vers[0] };
  }), [years, versions]);
  const enabledYear = (year: number) => viewMode === 'years' || year === editYear;
  /* UX-28:不提供 placeholderData——years 列表随 versions/yearStates 异步加载而插入新年度时,
     useQueries 同一位置的 queryKey 会换人;占位数据会把上一年度矩阵标成 ready 渲染在新年度标签下
     (「标题已换年、数字还是上一年」混合态,§4.10 禁止)。键变化=新加载,交给 loading 骨架;
     同键后台重取 React Query 本就保留旧数据,不受影响。 */
  const actualQueries = useQueries({ queries: selected.map(({ year }) => ({
    queryKey: ['actual-matrix', year],
    queryFn: ({ signal }: { signal: AbortSignal }) => api.get<ActualMatrixResponse>(`/actual/matrix?year=${year}`, { signal }),
    enabled: enabledYear(year),
  })) });
  const budgetQueries = useQueries({ queries: selected.map(({ version }) => ({
    queryKey: ['budget-matrix', version?.id ?? 0],
    queryFn: ({ signal }: { signal: AbortSignal }) => api.get<BudgetMatrixResponse>(`/versions/${version!.id}/matrix`, { signal }),
    enabled: !!version && enabledYear(version.year),
  })) });
  return useMemo(() => Object.fromEntries(selected.map(({ year, version }, i) => {
    const aq = actualQueries[i]; const bq = budgetQueries[i];
    /* 防御:即使将来重新引入占位数据,年度不符的响应也绝不进入展示层 */
    const am = aq.data && (aq.data.yearState == null || aq.data.yearState.year === year) ? aq.data : undefined;
    const bm = bq.data && bq.data.version.year === year ? bq.data : undefined;
    const actualStale = aq.data != null && am == null;
    const budgetStale = bq.data != null && bm == null;
    const loading = enabledYear(year) && (aq.isPending || actualStale || (!!version && (bq.isPending || budgetStale)));
    const error = aq.error instanceof Error ? aq.error.message : undefined;
    // 预算与实际是两条独立请求:预算失败要显式携带错误,而不是空 Map + ready
    const budgetLoading = !!version && enabledYear(year) && (bq.isPending || budgetStale);
    const budgetError = version && bq.error instanceof Error ? bq.error.message : undefined;
    return [year, { budgetVersion: version, budgetEntries: new Map((bm?.entries ?? []).map((e) => [`${e.orgId}:${e.accountId}`, e])), actualEntries: new Map((am?.entries ?? []).map((e) => [`${e.orgId}:${e.accountId}`, e])), actualCellNotes: new Map((am?.cellNotes ?? []).map((n) => [`${n.orgId}:${n.accountId}`, n.memo] as const)), actualFrozen: am?.yearState?.status === 'frozen', actualCutoff: am?.currentBatch?.snapshot_date, actualCurrentBatchId: am?.yearState?.current_batch_id ?? null, financeOwnedCells: am?.financeOwnedCells ?? [], actualLoadStatus: loading ? 'loading' : error ? 'error' : 'ready', actualLoadError: error, budgetLoadStatus: budgetLoading ? 'loading' : budgetError ? 'error' : 'ready', budgetLoadError: budgetError } satisfies YearData];
  })), [selected, actualQueries, budgetQueries, editYear, viewMode]);
}
