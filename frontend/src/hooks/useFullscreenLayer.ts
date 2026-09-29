import { useEffect } from 'react';

/** 判断页面上是否已有打开的 antd 浮层(弹窗/抽屉/下拉菜单),它们自己消费 Esc */
function hasOpenOverlay(): boolean {
  const nodes = document.querySelectorAll('.ant-modal-wrap, .ant-drawer-open, .ant-dropdown, .ant-popover');
  for (const node of Array.from(nodes)) {
    const el = node as HTMLElement;
    if (el.classList.contains('ant-dropdown-hidden') || el.classList.contains('ant-popover-hidden')) continue;
    if (getComputedStyle(el).display !== 'none') return true;
  }
  return false;
}

/**
 * 全屏覆盖层的通用行为:Esc 退出 + 锁背景滚动。
 *
 * Esc 守卫(不退出全屏的情形):
 * - 焦点在输入框/文本域/可编辑区内 —— 表格里 Esc 是"取消本格编辑",不应顺带退出全屏;
 * - 事件已被上层处理过(defaultPrevented);
 * - 已有弹窗/抽屉/下拉菜单打开 —— Esc 先关它们。
 */
export function useFullscreenLayer(active: boolean, onExit: () => void): void {
  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.defaultPrevented) return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || el.tagName === 'INPUT' || el.tagName === 'TEXTAREA' || el.tagName === 'SELECT')) return;
      if (hasOpenOverlay()) return;
      onExit();
    };
    window.addEventListener('keydown', onKey);
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      window.removeEventListener('keydown', onKey);
      document.body.style.overflow = previousOverflow;
    };
  }, [active, onExit]);
}
