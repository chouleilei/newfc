/**
 * 路由条目滚动位置恢复(UX-03):挂在唯一天滚动容器(.newfc-main)上。
 *
 * - 持续监听滚动并即时记录(节流一帧),条目切换的 cleanup 里再兜底保存一次;
 * - 条目变化时按导航类型决定目标位置(POP 恢复 / PUSH 回顶 / REPLACE 不动);
 * - 页面内容异步加载,恢复按递增节拍重试,直到目标位置可达或节拍用尽。
 */
import { useEffect, type RefObject } from 'react';
import { useLocation, useNavigationType } from 'react-router-dom';
import { readRoutePosition, resolveScrollTarget, saveRoutePosition } from '../utils/routeMemory';

const RESTORE_BEATS = [0, 60, 180, 400, 800, 1400, 2200];

export function useRouteScrollMemory(containerRef: RefObject<HTMLElement | null>): void {
  const location = useLocation();
  const navType = useNavigationType();

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const storage = window.sessionStorage;
    // 先读后写:读取本条目的历史记录必须早于任何写入,否则残留位置会覆盖待恢复值
    const target = resolveScrollTarget(navType, readRoutePosition(storage, location.key));
    /* PUSH 回顶只在落地时执行一次:目标页可能有自己的定位滚动(UX-03 预警→分析展开定位),
       重试节拍不能把它再拽回顶部;POP 恢复需等内容异步加载撑出高度,才按节拍重试。 */
    const beats = navType === 'POP' ? RESTORE_BEATS : [0];
    const timers = target == null ? [] : beats.map((delay) => window.setTimeout(() => {
      containerRef.current?.scrollTo({ top: target });
    }, delay));

    let raf = 0;
    const onScroll = () => {
      cancelAnimationFrame(raf);
      raf = requestAnimationFrame(() => saveRoutePosition(storage, location.key, el.scrollTop));
    };
    el.addEventListener('scroll', onScroll, { passive: true });
    return () => {
      cancelAnimationFrame(raf);
      el.removeEventListener('scroll', onScroll);
      timers.forEach((timer) => window.clearTimeout(timer));
      saveRoutePosition(storage, location.key, el.scrollTop);
    };
  }, [containerRef, location.key, navType]);
}
