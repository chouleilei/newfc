import { useCallback } from 'react';
import { useSearchParams } from 'react-router-dom';

/**
 * 详情抽屉的打开对象与 URL 参数同步(T-6 跨域检索 `?id=` 定位,AC-F26):
 * 从检索结果或分享链接进入时直接打开详情,关闭时移除参数;非正整数视为未打开。
 */
export function useUrlId(name = 'id'): [number | null, (id: number | null) => void] {
  const [params, setParams] = useSearchParams();
  const raw = params.get(name);
  const id = raw && /^[1-9]\d{0,15}$/.test(raw) ? Number(raw) : null;
  const setId = useCallback((next: number | null) => setParams((p) => {
    const n = new URLSearchParams(p);
    if (next == null) n.delete(name); else n.set(name, String(next));
    return n;
  }, { replace: true }), [name, setParams]);
  return [id, setId];
}
