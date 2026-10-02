import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';

export function positiveQueryNumber(value: string | null): number | undefined {
  if (value == null || !value.trim()) return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/** 台账页的筛选/分页写入 URL,刷新和返回时复用;改变筛选回到第一页。 */
export function useListSearchParams(defaultPageSize = 20) {
  const [params, setParams] = useSearchParams();
  const page = positiveQueryNumber(params.get('page')) ?? 1;
  const size = positiveQueryNumber(params.get('pageSize'));
  const pageSize = size != null && size <= 100 ? size : defaultPageSize;
  const update = useCallback((values: Record<string, string | number | undefined>, resetPage = true) => {
    setParams((prev) => {
      const next = new URLSearchParams(prev);
      for (const [key, value] of Object.entries(values)) {
        if (value == null || value === '') next.delete(key);
        else next.set(key, String(value));
      }
      if (resetPage) next.delete('page');
      return next;
    }, { replace: true });
  }, [setParams]);
  return { params, setParams, page, pageSize, update };
}
