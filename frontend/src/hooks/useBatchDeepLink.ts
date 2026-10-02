import { useEffect, useRef } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';

/** 显式来源链接只加载指定批次，成功后交给页面详情；失败保留链接供重试。 */
export function useBatchDeepLink<T>(domain: string, load: (id: number) => Promise<T>, onLoaded: (batch: T) => void) {
  const [params, setParams] = useSearchParams();
  const raw = params.get('batchId');
  const id = raw && /^\d+$/.test(raw) && Number.isSafeInteger(Number(raw)) && Number(raw) > 0 ? Number(raw) : undefined;
  const callback = useRef(onLoaded); callback.current = onLoaded;
  const query = useQuery({ queryKey: ['batch-deep-link', domain, id], queryFn: () => load(id!), enabled: id != null });
  useEffect(() => {
    if (!query.data || id == null) return;
    callback.current(query.data);
    setParams((previous) => { const next = new URLSearchParams(previous); next.delete('batchId'); return next; }, { replace: true });
  }, [query.data, id, setParams]);
  return query;
}
