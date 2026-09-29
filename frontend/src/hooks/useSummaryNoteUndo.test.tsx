// @vitest-environment jsdom
/**
 * useSummaryNoteUndo(UX-23-6)行为测试:
 * - 汇总备注提交纳入网格统一撤销栈,与明细编辑按发生顺序混排
 * - 撤销/重做按序回放前值/后值
 * - 目标只读(canEdit=false)时撤销被拒绝且不写入
 * - 无变化提交不产生撤销步骤
 */
import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useState } from 'react';
import { useGridInteraction, type GridInteraction, type GridInteractionOptions } from './useGridInteraction';
import { useSummaryNoteUndo } from './useSummaryNoteUndo';

const ROWS = [{ id: 1, type: 'expense', label: '费用A' }];
const COLS = [{ id: 101, label: '组织甲' }];

interface HarnessResult {
  grid: GridInteraction;
  notes: Map<string, string>;
  apply: (key: string, text: string) => boolean;
}

function setup(opts: { canEdit?: boolean } & Partial<GridInteractionOptions> = {}) {
  const { canEdit = true, ...gridOverrides } = opts;
  const notifications: Array<{ type: string; text: string }> = [];
  let canEditValue = canEdit;
  const { result, rerender } = renderHook((): HarnessResult => {
    const grid = useGridInteraction({
      getRows: () => ROWS,
      getCols: () => COLS,
      isCellEditable: () => true,
      cellDomId: (rowId, colId) => `cell-${rowId}-${colId}`,
      notify: (type, text) => notifications.push({ type, text }),
      ...gridOverrides,
    });
    const [notes, setNotes] = useState<Map<string, string>>(new Map());
    const apply = useSummaryNoteUndo({
      grid,
      notes,
      setNote: (key, text) => setNotes((cur) => {
        const m = new Map(cur);
        if (text) m.set(key, text); else m.delete(key);
        return m;
      }),
      canEdit: canEditValue,
    });
    return { grid, notes, apply };
  });
  return {
    result,
    notifications,
    rerender,
    /** 模拟目标变只读(定稿/历史任务/冲突锁定) */
    setCanEdit: (v: boolean) => { canEditValue = v; rerender(); },
    run: (fn: (h: HarnessResult) => void) => act(() => fn(result.current)),
  };
}

describe('useSummaryNoteUndo(汇总备注统一撤销)', () => {
  it('提交写入备注并入撤销栈,Ctrl+Z 撤销恢复前值', () => {
    const h = setup();
    let applied = false;
    h.run((x) => { applied = x.apply('101:9', '口径说明'); });
    expect(applied).toBe(true);
    expect(h.result.current.notes.get('101:9')).toBe('口径说明');
    expect(h.result.current.grid.canUndo).toBe(true);

    h.run((x) => x.grid.undo());
    expect(h.result.current.notes.has('101:9')).toBe(false);
    expect(h.result.current.grid.canRedo).toBe(true);

    h.run((x) => x.grid.redo());
    expect(h.result.current.notes.get('101:9')).toBe('口径说明');
  });

  it('与明细格编辑按发生顺序混排:后发生的先撤销', () => {
    const h = setup();
    h.run((x) => x.grid.applyCells([{ key: '101:1', value: '100' }], '明细编辑'));
    h.run((x) => x.apply('101:9', '汇总备注'));
    h.run((x) => x.grid.applyCells([{ key: '101:1', value: '200' }], '明细编辑2'));

    h.run((x) => x.grid.undo()); // 先撤销最后发生的明细编辑2
    expect(h.result.current.grid.values.get('101:1')).toBe('100');
    expect(h.result.current.notes.get('101:9')).toBe('汇总备注');

    h.run((x) => x.grid.undo()); // 再撤销汇总备注
    expect(h.result.current.notes.has('101:9')).toBe(false);
    expect(h.result.current.grid.values.get('101:1')).toBe('100');

    h.run((x) => x.grid.undo()); // 最后撤销最早的明细编辑
    expect(h.result.current.grid.values.has('101:1')).toBe(false);
  });

  it('目标只读后撤销被拒绝、不写入,且该步被丢弃', () => {
    const h = setup();
    h.run((x) => x.apply('101:9', '备注'));
    h.setCanEdit(false); // 模拟切到历史补录/定稿
    h.run((x) => x.grid.undo());
    expect(h.result.current.notes.get('101:9')).toBe('备注'); // 未被撤销改写
    expect(h.result.current.grid.canUndo).toBe(false);
    expect(h.result.current.grid.canRedo).toBe(false);
    expect(h.notifications.some((n) => n.text.includes('不可撤销'))).toBe(true);
  });

  it('只读期间重做同样被拒绝', () => {
    const h = setup();
    h.run((x) => x.apply('101:9', '备注'));
    h.run((x) => x.grid.undo());
    h.setCanEdit(false);
    h.run((x) => x.grid.redo());
    expect(h.result.current.notes.has('101:9')).toBe(false);
    expect(h.notifications.some((n) => n.text.includes('不可重做'))).toBe(true);
  });

  it('内容无变化的提交不产生撤销步骤', () => {
    const h = setup();
    h.run((x) => x.apply('101:9', '备注'));
    const depth = h.result.current.grid.undoDepth;
    let applied = true;
    h.run((x) => { applied = x.apply('101:9', '  备注  '); }); // trim 后相同
    expect(applied).toBe(false);
    expect(h.result.current.grid.undoDepth).toBe(depth);
  });

  it('清空备注(空串)同样可撤销恢复', () => {
    const h = setup();
    h.run((x) => x.apply('101:9', '备注'));
    h.run((x) => x.apply('101:9', ''));
    expect(h.result.current.notes.has('101:9')).toBe(false);
    h.run((x) => x.grid.undo());
    expect(h.result.current.notes.get('101:9')).toBe('备注');
  });
});
