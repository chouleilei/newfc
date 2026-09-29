/**
 * 汇总格备注的统一撤销接入(UX-23-6):
 * 汇总格备注是页面级状态(不存放在网格 values/formulas/notes 里),其「已提交」的编辑
 * (弹窗点保存,而非取消)通过本 hook 写入,同时把一个外部撤销条目压入网格撤销栈,
 * 与明细格编辑按发生顺序混排,Ctrl+Z / 撤销按钮一视同仁。
 *
 * 重放安全:canEdit 为渲染期可编辑标记,hook 内部以 ref 镜像;撤销/重做重放时复核,
 * 目标已只读(定稿/冻结/历史补录/冲突锁定)时该步被丢弃,备注不会被撤销入口绕过写入。
 * 弹窗「取消」不经过本 hook,只放弃本次弹窗输入,不产生撤销步骤。
 */
import { useCallback, useRef } from 'react';
import type { GridInteraction } from './useGridInteraction';

export function useSummaryNoteUndo(opts: {
  grid: GridInteraction;
  /** 当前汇总备注表(渲染期值;hook 内部镜像为 ref 供事件期读取) */
  notes: ReadonlyMap<string, string>;
  /** 写入单个键(空串 = 删除该条备注) */
  setNote: (key: string, text: string) => void;
  /** 渲染期可编辑标记(草稿/当前任务/未冻结/无冲突/无在途提交) */
  canEdit: boolean;
  /** 撤销提示文案中的操作名 */
  label?: string;
}) {
  const optsRef = useRef(opts);
  optsRef.current = opts;

  /** 提交一次汇总备注编辑:立即写入 + 入统一撤销栈。无变化时不产生撤销步骤。 */
  const applySummaryNote = useCallback((key: string, nextText: string) => {
    const { notes, setNote, grid, label = '汇总格备注' } = optsRef.current;
    const prev = notes.get(key) ?? '';
    const next = nextText.trim();
    if (prev === next) return false;
    setNote(key, next);
    grid.pushExternalUndo(label, {
      canApply: () => optsRef.current.canEdit,
      undo: () => optsRef.current.setNote(key, prev),
      redo: () => optsRef.current.setNote(key, next),
    });
    return true;
  }, []);

  return applySummaryNote;
}
