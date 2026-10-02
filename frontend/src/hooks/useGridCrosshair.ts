/**
 * 网格十字准星 + 冻结列滚动阴影(《视觉高级感提升方案》3.3①②)。
 *
 * 两条约束:
 * 1. **只加视觉层,不动交互逻辑** —— 不触碰 applyCells、撤销栈与粘贴反馈,
 *    事件一律走委托(容器上挂 data-* 属性),不逐格挂监听、不引入依赖。
 * 2. **动效引用既有令牌** —— 阴影过渡走 --newfc-dur-lift,不写死时长。
 *
 * 准星的实现:容器上维护 data-crosshair-r / data-crosshair-c 两个索引属性,
 * 单元格与表头带 data-gr / data-gc;命中与否完全由 CSS 选择器判定,
 * 因此索引变化只触发一次容器属性写入,不引起单元格重渲染。
 */
import { useCallback, useEffect, useRef, useState } from 'react';

/** 从事件目标向上找最近的带 data-gr/data-gc 的单元格 */
function cellIndexFrom(target: EventTarget | null): { r: number; c: number } | null {
  let node = target as HTMLElement | null;
  let guard = 0;
  while (node && guard++ < 5) {
    if (node.dataset && (node.dataset.gr != null || node.dataset.gc != null)) {
      const r = Number(node.dataset.gr);
      const c = Number(node.dataset.gc);
      if (Number.isInteger(r) || Number.isInteger(c)) {
        return { r: Number.isInteger(r) ? r : -1, c: Number.isInteger(c) ? c : -1 };
      }
    }
    node = node.parentElement;
  }
  return null;
}

export interface GridCrosshair {
  /** 挂到滚动容器上 */
  containerRef: React.RefObject<HTMLDivElement>;
  /** 容器上的准星属性,展开到 <div> 上 */
  crosshairProps: {
    'data-crosshair-r': string;
    'data-crosshair-c': string;
    onMouseMove: (e: React.MouseEvent) => void;
    onMouseLeave: () => void;
  };
  /** 冻结列阴影:横向滚动位置 + 已滚动标记 */
  frozenProps: {
    className: string;
    'data-scrolled': '0' | '1';
    onScroll: (e: React.UIEvent<HTMLDivElement>) => void;
  };
}

/**
 * @param enabled 首列固定为 false 时不挂冻结阴影(没有冻结列就没有分界可言)
 */
export function useGridCrosshair(enabled = true): GridCrosshair {
  const containerRef = useRef<HTMLDivElement>(null);
  const [row, setRow] = useState(-1);
  const [col, setCol] = useState(-1);
  const [scrolled, setScrolled] = useState(false);

  const onMouseMove = useCallback((e: React.MouseEvent) => {
    if (!enabled) return;
    const idx = cellIndexFrom(e.target);
    setRow(idx?.r ?? -1);
    setCol(idx?.c ?? -1);
  }, [enabled]);

  const onMouseLeave = useCallback(() => { setRow(-1); setCol(-1); }, []);

  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setScrolled(e.currentTarget.scrollLeft > 0);
  }, []);

  /* 首列固定开关变化时重算:关闭冻结后阴影必须立即消失 */
  useEffect(() => {
    if (!enabled) setScrolled(false);
  }, [enabled]);

  return {
    containerRef,
    crosshairProps: {
      'data-crosshair-r': String(row),
      'data-crosshair-c': String(col),
      onMouseMove,
      onMouseLeave,
    },
    frozenProps: {
      className: enabled ? 'newfc-grid-frozen-x' : '',
      'data-scrolled': scrolled ? '1' : '0',
      onScroll,
    },
  };
}
