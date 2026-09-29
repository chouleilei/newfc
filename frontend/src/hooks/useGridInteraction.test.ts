// @vitest-environment jsdom
/**
 * 表格交互层单元测试:
 * - 纯函数:剪贴板清洗/解析/转置(Excel 带格式数字口径)
 * - 统一写入入口 applyCells:只读守卫、类型校验、公式绑定、撤销入栈
 * - 脏格基线:resetData / markSaved / markPersisted / markClean
 * - 撤销/重做:容量上限、只读重放守卫、新操作清空重做栈
 * - 填充(Ctrl+D/Ctrl+R/拖拽填充柄):类型不匹配跳过、轴向选择
 * - 粘贴引擎:矩阵写入、越界反馈、skipEmpty/转置/valuesOnly、真实写入行列统计
 * - 键盘状态机:导航/编辑态、组合键路由、输入法保护
 * - 选区统计(利润方向符号)、查找替换、TSV 复制、焦点记忆
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  UNDO_LIMIT,
  cleanPastedValue,
  normalizeNumericInput,
  parseClipboardGrid,
  transposeGrid,
  useGridInteraction,
  type GridColDesc,
  type GridInteraction,
  type GridInteractionOptions,
  type GridRowDesc,
  type PasteOutcome,
} from './useGridInteraction';

/* ============ 测试几何:3 列 × 4 行(收入/费用/费用/数量) ============ */
const ROWS: GridRowDesc[] = [
  { id: 1, type: 'income', label: '收入A' },
  { id: 2, type: 'expense', label: '费用B' },
  { id: 3, type: 'expense', label: '费用C' },
  { id: 4, type: 'quantity', label: '数量D' },
];
const COLS: GridColDesc[] = [
  { id: 101, label: '一月' },
  { id: 102, label: '二月' },
  { id: 103, label: '三月' },
];

/** 与 hook 内部一致:`${colId}:${rowId}` */
const key = (rowId: number, colId: number) => `${colId}:${rowId}`;

interface Harness {
  result: { current: GridInteraction };
  notifications: Array<{ type: string; text: string }>;
  /** 放入 `${rowId}:${colId}` 即视为只读 */
  readonly: Set<string>;
  run: (fn: (g: GridInteraction) => void) => void;
}

function setup(overrides: Partial<GridInteractionOptions> = {}): Harness {
  const notifications: Harness['notifications'] = [];
  const readonly = new Set<string>();
  const opts: GridInteractionOptions = {
    getRows: () => ROWS,
    getCols: () => COLS,
    isCellEditable: (rowId, colId) => !readonly.has(`${rowId}:${colId}`),
    cellDomId: (rowId, colId) => `cell-${rowId}-${colId}`,
    notify: (type, text) => notifications.push({ type, text }),
    ...overrides,
  };
  const { result } = renderHook(() => useGridInteraction(opts));
  const run: Harness['run'] = (fn) => act(() => fn(result.current));
  return { result, notifications, readonly, run };
}

const notified = (h: Harness, text: string) => h.notifications.some((n) => n.text.includes(text));

/** 伪造键盘事件(仅携带状态机读取的字段) */
const keyEvent = (
  keyName: string,
  opts: { ctrl?: boolean; shift?: boolean; alt?: boolean; value?: string; selStart?: number; selEnd?: number; composing?: boolean } = {},
) => ({
  key: keyName,
  ctrlKey: opts.ctrl ?? false,
  metaKey: false,
  shiftKey: opts.shift ?? false,
  altKey: opts.alt ?? false,
  preventDefault: vi.fn(),
  nativeEvent: { isComposing: opts.composing ?? false },
  currentTarget: {
    value: opts.value ?? '',
    selectionStart: opts.selStart ?? 0,
    selectionEnd: opts.selEnd ?? 0,
  },
// eslint-disable-next-line @typescript-eslint/no-explicit-any
}) as any;

const mapOf = (entries: Array<[string, string]>) => new Map<string, string>(entries);

beforeEach(() => {
  sessionStorage.clear();
});

/* ============ 纯函数 ============ */

describe('cleanPastedValue(Excel 带格式数字清洗)', () => {
  it('去除货币符号、千分位与首尾空白', () => {
    expect(cleanPastedValue('  ¥1,234.56  ')).toBe('1234.56');
    expect(cleanPastedValue('$2,000')).toBe('2000');
    expect(cleanPastedValue('￥3,000.5')).toBe('3000.5');
    expect(cleanPastedValue('€4')).toBe('4');
  });

  it('去除引号包裹、不间断空格/全角空格与首部加号', () => {
    expect(cleanPastedValue('"1,234.50"')).toBe('1234.50');
    expect(cleanPastedValue(' 123 ')).toBe('123');
    expect(cleanPastedValue('　456　')).toBe('456');
    expect(cleanPastedValue('+789.10')).toBe('789.10');
  });

  it('负号保留,普通文本原样返回', () => {
    expect(cleanPastedValue('-123.45')).toBe('-123.45');
    expect(cleanPastedValue('abc')).toBe('abc');
    expect(cleanPastedValue('')).toBe('');
  });
});

describe('normalizeNumericInput(失焦数字规范化)', () => {
  it('公式原样保留,不参与清洗', () => {
    expect(normalizeNumericInput('=1+2')).toBe('=1+2');
    expect(normalizeNumericInput(' = 1,000 * 2 ')).toBe(' = 1,000 * 2 ');
  });

  it('非公式与粘贴清洗同口径', () => {
    expect(normalizeNumericInput('1,234.50')).toBe('1234.50');
    expect(normalizeNumericInput('¥ +100 ')).toBe('100');
  });
});

describe('parseClipboardGrid(剪贴板文本 -> 矩阵)', () => {
  it('按行/制表符切分', () => {
    expect(parseClipboardGrid('1\t2\n3\t4')).toEqual([['1', '2'], ['3', '4']]);
    expect(parseClipboardGrid('abc')).toEqual([['abc']]);
  });

  it('归一 CRLF/CR 换行并去掉末尾空行', () => {
    expect(parseClipboardGrid('1\r\n2\r\n')).toEqual([['1'], ['2']]);
    expect(parseClipboardGrid('1\r2')).toEqual([['1'], ['2']]);
    expect(parseClipboardGrid('1\n2\n')).toEqual([['1'], ['2']]);
  });

  it('中间空行保留(对应 Excel 空行)', () => {
    expect(parseClipboardGrid('1\n\n2')).toEqual([['1'], [''], ['2']]);
  });
});

describe('transposeGrid(矩阵转置)', () => {
  it('方阵转置', () => {
    expect(transposeGrid([['1', '2'], ['3', '4']])).toEqual([['1', '3'], ['2', '4']]);
  });

  it('残缺行以空串补齐,空矩阵安全返回', () => {
    expect(transposeGrid([['1', '2'], ['3']])).toEqual([['1', '3'], ['2', '']]);
    expect(transposeGrid([])).toEqual([]);
  });
});

/* ============ applyCells 统一写入入口 ============ */

describe('applyCells(统一写入入口)', () => {
  it('写入数值、标脏并压入撤销栈', () => {
    const h = setup();
    let written = 0;
    h.run((g) => { written = g.applyCells([{ key: key(2, 101), value: '100' }], '测试').written; });
    expect(written).toBe(1);
    expect(h.result.current.values.get(key(2, 101))).toBe('100');
    expect(h.result.current.dirty).toBe(true);
    expect(h.result.current.dirtyCount).toBe(1);
    expect(h.result.current.canUndo).toBe(true);
  });

  it('只读格跳过且不产生撤销步骤', () => {
    const h = setup();
    h.readonly.add('2:101');
    let res!: ReturnType<GridInteraction['applyCells']>;
    h.run((g) => { res = g.applyCells([{ key: key(2, 101), value: '100' }], '测试'); });
    expect(res.written).toBe(0);
    expect(res.skipped).toBe(1);
    expect(h.result.current.values.has(key(2, 101))).toBe(false);
    expect(h.result.current.canUndo).toBe(false);
  });

  it('值未变化的格不计入写入、不入撤销栈', () => {
    const h = setup();
    h.run((g) => g.resetData(mapOf([[key(2, 101), '100']])));
    let res!: ReturnType<GridInteraction['applyCells']>;
    h.run((g) => { res = g.applyCells([{ key: key(2, 101), value: '100' }], '测试'); });
    expect(res.written).toBe(0);
    expect(res.writtenKeys).toEqual([]);
    expect(h.result.current.canUndo).toBe(false);
    expect(h.result.current.dirty).toBe(false);
  });

  it('非法值写入后标红(invalidCells)并计数', () => {
    const h = setup();
    let res!: ReturnType<GridInteraction['applyCells']>;
    h.run((g) => { res = g.applyCells([{ key: key(2, 101), value: 'abc' }], '测试'); });
    expect(res.written).toBe(1);
    expect(res.invalid).toBe(1);
    expect(h.result.current.invalidCells.has(key(2, 101))).toBe(true);
    // 修正为合法值后移出标红集合
    h.run((g) => g.applyCells([{ key: key(2, 101), value: '50' }], '修正'));
    expect(h.result.current.invalidCells.has(key(2, 101))).toBe(false);
  });

  it('数量科目按四位小数口径校验', () => {
    const h = setup();
    let bad = 0; let good = 0;
    h.run((g) => { bad = g.applyCells([{ key: key(4, 101), value: '1.23456' }], '测试').invalid; });
    expect(bad).toBe(1);
    h.run((g) => { good = g.applyCells([{ key: key(4, 102), value: '1.2345' }], '测试').invalid; });
    expect(good).toBe(0);
    expect(h.result.current.invalidCells.has(key(4, 101))).toBe(true);
    expect(h.result.current.invalidCells.has(key(4, 102))).toBe(false);
  });

  it('值为公式时求值并绑定公式', () => {
    const h = setup();
    h.run((g) => g.applyCells([{ key: key(1, 101), value: '=1+2' }], '公式'));
    expect(h.result.current.values.get(key(1, 101))).toBe('3.00');
    expect(h.result.current.formulas.get(key(1, 101))).toBe('=1+2');
  });

  it('显式 formula 参数求值;普通值粘贴清除旧公式(valuesOnly 除外见粘贴用例)', () => {
    const h = setup();
    h.run((g) => g.applyCells([{ key: key(1, 101), formula: '=2*3' }], '公式'));
    expect(h.result.current.values.get(key(1, 101))).toBe('6.00');
    expect(h.result.current.formulas.get(key(1, 101))).toBe('=2*3');
    h.run((g) => g.applyCells([{ key: key(1, 101), value: '50', formula: null }], '覆盖'));
    expect(h.result.current.values.get(key(1, 101))).toBe('50');
    expect(h.result.current.formulas.has(key(1, 101))).toBe(false);
  });

  it('附注写入与清除', () => {
    const h = setup();
    h.run((g) => g.applyCells([{ key: key(1, 101), note: '依据' }], '附注'));
    expect(h.result.current.notes.get(key(1, 101))).toBe('依据');
    h.run((g) => g.applyCells([{ key: key(1, 101), note: null }], '清除'));
    expect(h.result.current.notes.has(key(1, 101))).toBe(false);
  });
});

/* ============ 脏格基线 ============ */

describe('脏格基线(resetData / markSaved / markPersisted / markClean)', () => {
  it('resetData 载入即为干净基线', () => {
    const h = setup();
    h.run((g) => g.resetData(mapOf([[key(1, 101), '100'], [key(2, 101), '200']])));
    expect(h.result.current.values.get(key(1, 101))).toBe('100');
    expect(h.result.current.dirty).toBe(false);
    expect(h.result.current.canUndo).toBe(false);
  });

  it('markSaved 快照前移、脏格清零且撤销栈保留(与 Excel 一致)', () => {
    const h = setup();
    h.run((g) => g.applyCells([{ key: key(1, 101), value: '100' }], '编辑'));
    expect(h.result.current.dirty).toBe(true);
    h.run((g) => g.markSaved());
    expect(h.result.current.dirty).toBe(false);
    expect(h.result.current.canUndo).toBe(true);
    // 撤销后回到空值,与已保存基线不同 -> 重新标脏
    h.run((g) => g.undo());
    expect(h.result.current.values.has(key(1, 101))).toBe(false);
    expect(h.result.current.dirty).toBe(true);
  });

  it('markPersisted 以实际发送快照前移,保存在途期间的录入不误标已保存', () => {
    const h = setup();
    h.run((g) => g.resetData(mapOf([[key(1, 101), '100']])));
    h.run((g) => g.applyCells([{ key: key(1, 101), value: '200' }], '编辑')); // 自动保存发出 200
    h.run((g) => g.applyCells([{ key: key(1, 101), value: '300' }], '在途录入')); // 在途期间又改成 300
    h.run((g) => g.markPersisted(mapOf([[key(1, 101), '200']]), new Map(), new Map()));
    expect(h.result.current.dirty).toBe(true); // 300 未保存,不能误清
    h.run((g) => g.markPersisted(mapOf([[key(1, 101), '300']]), new Map(), new Map()));
    expect(h.result.current.dirty).toBe(false);
  });

  it('markClean 只清脏标记不动数据', () => {
    const h = setup();
    h.run((g) => g.applyCells([{ key: key(1, 101), value: '100' }], '编辑'));
    h.run((g) => g.markClean());
    expect(h.result.current.dirty).toBe(false);
    expect(h.result.current.values.get(key(1, 101))).toBe('100');
  });
});

/* ============ 撤销/重做 ============ */

describe('撤销/重做', () => {
  it('撤销恢复前值,重做恢复后值', () => {
    const h = setup();
    h.run((g) => g.applyCells([{ key: key(1, 101), value: '100' }], '编辑'));
    h.run((g) => g.undo());
    expect(h.result.current.values.has(key(1, 101))).toBe(false);
    expect(h.result.current.canRedo).toBe(true);
    expect(notified(h, '已撤销')).toBe(true);
    h.run((g) => g.redo());
    expect(h.result.current.values.get(key(1, 101))).toBe('100');
    expect(h.result.current.canUndo).toBe(true);
  });

  it('新写操作清空重做栈', () => {
    const h = setup();
    h.run((g) => g.applyCells([{ key: key(1, 101), value: '1' }], '一'));
    h.run((g) => g.applyCells([{ key: key(1, 101), value: '2' }], '二'));
    h.run((g) => g.undo());
    expect(h.result.current.canRedo).toBe(true);
    h.run((g) => g.applyCells([{ key: key(1, 101), value: '3' }], '三'));
    expect(h.result.current.canRedo).toBe(false);
  });

  it('空栈撤销/重做给出提示且不出错', () => {
    const h = setup();
    h.run((g) => g.undo());
    h.run((g) => g.redo());
    expect(notified(h, '没有可撤销的操作')).toBe(true);
    expect(notified(h, '没有可重做的操作')).toBe(true);
  });

  it('撤销栈容量上限 100,超出丢弃最早步骤', () => {
    const h = setup();
    h.run((g) => {
      for (let i = 1; i <= UNDO_LIMIT + 5; i++) {
        g.applyCells([{ key: key(1, 101), value: String(i) }], `op${i}`);
      }
    });
    expect(h.result.current.undoDepth).toBe(UNDO_LIMIT);
  });

  it('只读重放守卫:格变只读后撤销不重写并丢弃该步', () => {
    const h = setup();
    h.run((g) => g.applyCells([{ key: key(1, 101), value: '100' }], '编辑'));
    h.readonly.add('1:101');
    h.run((g) => g.undo());
    expect(h.result.current.values.get(key(1, 101))).toBe('100'); // 未被重写
    expect(notified(h, '无法撤销')).toBe(true);
    expect(h.result.current.canUndo).toBe(false);
    expect(h.result.current.canRedo).toBe(false); // 步骤被丢弃而非进入重做栈
  });
});

/* ============ 撤销/重做 ============ */

describe('外部撤销条目(pushExternalUndo, UX-23-6)', () => {
  it('外部编辑与明细格编辑按发生顺序混排撤销/重做', () => {
    const h = setup();
    const log: string[] = [];
    h.run((g) => g.applyCells([{ key: key(1, 101), value: '100' }], '明细编辑'));
    h.run((g) => g.pushExternalUndo('汇总格备注', {
      canApply: () => true,
      undo: () => log.push('undo:memo'),
      redo: () => log.push('redo:memo'),
    }));
    expect(h.result.current.undoDepth).toBe(2);

    h.run((g) => g.undo()); // 后发生的汇总备注先撤销
    expect(log).toEqual(['undo:memo']);
    expect(h.result.current.values.get(key(1, 101))).toBe('100');

    h.run((g) => g.undo()); // 再撤销明细编辑
    expect(h.result.current.values.has(key(1, 101))).toBe(false);

    h.run((g) => g.redo()); // 重做按相反顺序回放
    h.run((g) => g.redo());
    expect(log).toEqual(['undo:memo', 'redo:memo']);
    expect(h.result.current.values.get(key(1, 101))).toBe('100');
    expect(notified(h, '已撤销: 汇总格备注')).toBe(true);
  });

  it('canApply 为 false 时拒绝写入、丢弃该步且不进重做栈', () => {
    const h = setup();
    let applicable = true;
    const log: string[] = [];
    h.run((g) => g.pushExternalUndo('汇总格备注', {
      canApply: () => applicable,
      undo: () => log.push('undo'),
      redo: () => log.push('redo'),
    }));
    applicable = false; // 目标已只读(定稿/历史任务)
    h.run((g) => g.undo());
    expect(log).toEqual([]);
    expect(notified(h, '不可撤销')).toBe(true);
    expect(h.result.current.canUndo).toBe(false);
    expect(h.result.current.canRedo).toBe(false);
  });

  it('新操作清空重做栈的规则对外部条目同样生效', () => {
    const h = setup();
    h.run((g) => g.pushExternalUndo('备注A', { canApply: () => true, undo: () => {}, redo: () => {} }));
    h.run((g) => g.undo());
    expect(h.result.current.canRedo).toBe(true);
    h.run((g) => g.pushExternalUndo('备注B', { canApply: () => true, undo: () => {}, redo: () => {} }));
    expect(h.result.current.canRedo).toBe(false);
  });
});

/* ============ 填充 ============ */

describe('填充(Ctrl+D / Ctrl+R / 拖拽填充柄)', () => {
  it('向下填充复制首行,类型不匹配的行跳过并如实反馈', () => {
    const h = setup();
    h.run((g) => g.applyCells([{ key: key(2, 101), value: '500' }], '录入'));
    h.run((g) => { g.focusCell(1, 0); g.extendSelection(1, 0); g.extendSelection(1, 0); }); // 行 2..4(费用/费用/数量)
    h.run((g) => g.fillBy('down'));
    expect(h.result.current.values.get(key(3, 101))).toBe('500'); // 费用C 被填充
    expect(h.result.current.values.has(key(4, 101))).toBe(false); // 数量D 类型不匹配
    expect(notified(h, '已填充 1 格')).toBe(true);
    expect(notified(h, '类型不匹配跳过 1 格')).toBe(true);
  });

  it('单行选区向下填充仅提示不写入', () => {
    const h = setup();
    h.run((g) => g.applyCells([{ key: key(2, 101), value: '500' }], '录入'));
    h.run((g) => g.focusCell(1, 0));
    h.run((g) => g.fillBy('down'));
    expect(notified(h, '请先选中多行')).toBe(true);
    expect(h.result.current.values.has(key(3, 101))).toBe(false);
  });

  it('向右填充复制首列,不做类型跳过', () => {
    const h = setup();
    h.run((g) => g.applyCells([{ key: key(2, 101), value: '500' }], '录入'));
    h.run((g) => { g.focusCell(1, 0); g.extendSelection(0, 1); g.extendSelection(0, 1); });
    h.run((g) => g.fillBy('right'));
    expect(h.result.current.values.get(key(2, 102))).toBe('500');
    expect(h.result.current.values.get(key(2, 103))).toBe('500');
  });

  it('填充遇只读格跳过并计数', () => {
    const h = setup();
    h.readonly.add('3:101');
    h.run((g) => g.applyCells([{ key: key(2, 101), value: '500' }], '录入'));
    h.run((g) => { g.focusCell(1, 0); g.extendSelection(1, 0); });
    h.run((g) => g.fillBy('down'));
    expect(h.result.current.values.has(key(3, 101))).toBe(false);
    expect(notified(h, '跳过只读 1 格')).toBe(true);
  });

  /** 模拟填充柄拖拽:beginFillDrag -> window mouseup(命中带 data-gr/data-gc 的 td) */
  const dragFill = (h: Harness, from: { r: number; c: number }, to: { r: number; c: number }) => {
    h.run((g) => g.beginFillDrag({ preventDefault: vi.fn(), stopPropagation: vi.fn() } as never, from.r, from.c));
    const td = document.createElement('td');
    td.setAttribute('data-gr', String(to.r));
    td.setAttribute('data-gc', String(to.c));
    const original = document.elementFromPoint;
    document.elementFromPoint = () => td as unknown as Element;
    try {
      act(() => { window.dispatchEvent(new MouseEvent('mouseup', { clientX: 10, clientY: 10 })); });
    } finally {
      document.elementFromPoint = original;
    }
  };

  it('横向拖拽填充同行后续格并移动焦点到终点', () => {
    const h = setup();
    h.run((g) => g.applyCells([{ key: key(2, 101), value: '500' }], '录入'));
    dragFill(h, { r: 1, c: 0 }, { r: 1, c: 2 });
    expect(h.result.current.values.get(key(2, 102))).toBe('500');
    expect(h.result.current.values.get(key(2, 103))).toBe('500');
    expect(notified(h, '拖拽填充: 已填充 2 格')).toBe(true);
    expect(h.result.current.active).toEqual({ r: 1, c: 2 });
  });

  it('纵向拖拽填充按类型跳过数量行', () => {
    const h = setup();
    h.run((g) => g.applyCells([{ key: key(2, 101), value: '500' }], '录入'));
    dragFill(h, { r: 1, c: 0 }, { r: 3, c: 0 });
    expect(h.result.current.values.get(key(3, 101))).toBe('500');
    expect(h.result.current.values.has(key(4, 101))).toBe(false);
    expect(notified(h, '类型不匹配跳过 1 格')).toBe(true);
  });

  it('原地松手(起止同格)不产生任何写入', () => {
    const h = setup();
    h.run((g) => g.applyCells([{ key: key(2, 101), value: '500' }], '录入'));
    const before = h.notifications.length;
    dragFill(h, { r: 1, c: 0 }, { r: 1, c: 0 });
    expect(h.notifications.length).toBe(before);
    expect(h.result.current.undoDepth).toBe(1); // 仅录入那一步
  });
});

/* ============ 粘贴引擎 ============ */

describe('粘贴引擎(pasteText)', () => {
  it('矩阵写入、真实行列统计、单步撤销', () => {
    const h = setup();
    let o!: PasteOutcome;
    h.run((g) => { o = g.pasteText('1\t2\n3\t4', 0, 0); });
    expect(o.written).toBe(4);
    expect(o.writtenRows).toBe(2);
    expect(o.writtenCols).toBe(2);
    expect(h.result.current.values.get(key(1, 101))).toBe('1');
    expect(h.result.current.values.get(key(2, 102))).toBe('4');
    expect(h.result.current.undoDepth).toBe(1); // 整个粘贴一个撤销步
    h.run((g) => g.undo());
    expect(h.result.current.values.size).toBe(0);
  });

  it('Excel 带格式数字粘贴前清洗(货币符号/千分位)', () => {
    const h = setup();
    h.run((g) => g.pasteText('¥1,234.56\t€2,000', 0, 0));
    expect(h.result.current.values.get(key(1, 101))).toBe('1234.56');
    expect(h.result.current.values.get(key(1, 102))).toBe('2000');
  });

  it('越界行列忽略并计数反馈', () => {
    const h = setup();
    let o!: PasteOutcome;
    h.run((g) => { o = g.pasteText('1\n2\n3\n4\n5', 2, 0); }); // 4 行几何,从第 3 行起粘 5 行
    expect(o.written).toBe(2);
    expect(o.outRows).toBe(3);
    h.run((g) => { o = g.pasteText('1\t2\t3\t4\t5', 0, 1); }); // 3 列几何,从第 2 列起粘 5 列
    expect(o.written).toBe(2);
    expect(o.outCols).toBe(3);
  });

  it('只读格跳过,其余格正常写入', () => {
    const h = setup();
    h.readonly.add('1:101');
    let o!: PasteOutcome;
    h.run((g) => { o = g.pasteText('1\t2', 0, 0); });
    expect(o.written).toBe(1);
    expect(o.skipped).toBe(1);
    expect(h.result.current.values.has(key(1, 101))).toBe(false);
    expect(h.result.current.values.get(key(1, 102))).toBe('2');
  });

  it('skipEmpty 保留既有值;默认粘贴空格覆盖清空', () => {
    const h = setup();
    h.run((g) => g.resetData(mapOf([[key(1, 101), '99']])));
    h.run((g) => g.pasteText('\t5', 0, 0, { skipEmpty: true }));
    expect(h.result.current.values.get(key(1, 101))).toBe('99');
    expect(h.result.current.values.get(key(1, 102))).toBe('5');

    const h2 = setup();
    h2.run((g) => g.resetData(mapOf([[key(1, 101), '99']])));
    h2.run((g) => g.pasteText('\t5', 0, 0));
    expect(h2.result.current.values.has(key(1, 101))).toBe(false); // 被空格清空
    expect(h2.result.current.values.get(key(1, 102))).toBe('5');
  });

  it('转置粘贴', () => {
    const h = setup();
    h.run((g) => g.pasteText('1\t2\n3\t4', 0, 0, { transpose: true }));
    expect(h.result.current.values.get(key(1, 101))).toBe('1');
    expect(h.result.current.values.get(key(2, 101))).toBe('2');
    expect(h.result.current.values.get(key(1, 102))).toBe('3');
    expect(h.result.current.values.get(key(2, 102))).toBe('4');
  });

  it('默认粘贴清除旧公式,valuesOnly 保留公式绑定', () => {
    const h = setup();
    h.run((g) => g.applyCells([{ key: key(1, 101), value: '=1+1' }], '公式'));
    expect(h.result.current.formulas.get(key(1, 101))).toBe('=1+1');

    const hKeep = setup();
    hKeep.run((g) => g.applyCells([{ key: key(1, 101), value: '=1+1' }], '公式'));
    hKeep.run((g) => g.pasteText('50', 0, 0, { valuesOnly: true }));
    expect(hKeep.result.current.values.get(key(1, 101))).toBe('50');
    expect(hKeep.result.current.formulas.get(key(1, 101))).toBe('=1+1'); // 公式保留

    h.run((g) => g.pasteText('50', 0, 0));
    expect(h.result.current.values.get(key(1, 101))).toBe('50');
    expect(h.result.current.formulas.has(key(1, 101))).toBe(false); // 公式被清除
  });

  it('粘贴值与现值一致时统计为 0 行 0 列(不虚报)', () => {
    const h = setup();
    h.run((g) => g.resetData(mapOf([[key(1, 101), '1'], [key(1, 102), '2']])));
    let o!: PasteOutcome;
    h.run((g) => { o = g.pasteText('1\t2', 0, 0); });
    expect(o.written).toBe(0);
    expect(o.writtenRows).toBe(0);
    expect(o.writtenCols).toBe(0);
  });

  it('非法值写入后计入 invalid 并标红,outcome 携带首个问题格坐标', () => {
    const h = setup();
    let o!: PasteOutcome;
    h.run((g) => { o = g.pasteText('abc', 0, 0); });
    expect(o.invalid).toBe(1);
    expect(o.firstInvalid).toEqual({ r: 0, c: 0 });
    expect(h.result.current.invalidCells.has(key(1, 101))).toBe(true);
  });

  it('矩阵粘贴中首个非法格取粘贴顺序最早者;无非法格为 null', () => {
    const h = setup();
    let o!: PasteOutcome;
    h.run((g) => { o = g.pasteText('1\tabc\nxyz\t4', 0, 0); });
    expect(o.invalid).toBe(2);
    expect(o.firstInvalid).toEqual({ r: 0, c: 1 }); // abc 先于 xyz
    expect(o.written).toBe(4);

    const ok = setup();
    let o2!: PasteOutcome;
    ok.run((g) => { o2 = g.pasteText('1\t2', 0, 0); });
    expect(o2.firstInvalid).toBeNull();
  });

  it('reportPaste 定位首个问题格并在反馈中说明可整次撤销', () => {
    const h = setup();
    h.run((g) => g.reportPaste(g.pasteText('abc\t2', 0, 0)));
    expect(h.result.current.active).toEqual({ r: 0, c: 0 }); // 焦点移到首个非法格
    expect(notified(h, '已定位首个格式错误格')).toBe(true);
    expect(notified(h, '可 Ctrl+Z 撤销整次粘贴')).toBe(true);
    // 整次粘贴一步撤销,问题格与原值一起回滚
    h.run((g) => g.undo());
    expect(h.result.current.values.size).toBe(0);
    expect(h.result.current.invalidCells.size).toBe(0);
  });

  it('handleCellPaste:单值粘贴保持原生行为,矩阵粘贴拦截', () => {
    const h = setup();
    const single = { clipboardData: { getData: () => 'abc' }, preventDefault: vi.fn() };
    h.run((g) => g.handleCellPaste(single as never, 0, 0));
    expect(single.preventDefault).not.toHaveBeenCalled();
    expect(h.result.current.values.size).toBe(0);

    const matrix = { clipboardData: { getData: () => '1\t2' }, preventDefault: vi.fn() };
    h.run((g) => g.handleCellPaste(matrix as never, 0, 0));
    expect(matrix.preventDefault).toHaveBeenCalled();
    expect(h.result.current.values.get(key(1, 102))).toBe('2');
    expect(notified(h, '批量粘贴')).toBe(true);
  });
});

/* ============ 清空选区 ============ */

describe('清空选区(Delete)', () => {
  it('清空数值保留附注;清除全部连附注一起清', () => {
    const h = setup();
    h.run((g) => {
      g.applyCells([
        { key: key(1, 101), value: '1' },
        { key: key(1, 102), value: '2', note: '依据' },
        { key: key(2, 101), value: '3' },
        { key: key(2, 102), value: '4' },
      ], '录入');
      g.focusCell(0, 0);
      g.extendSelection(1, 1);
    });
    h.run((g) => g.clearSelectionValues(false));
    expect(h.result.current.values.size).toBe(0);
    expect(h.result.current.notes.get(key(1, 102))).toBe('依据'); // 附注保留
    h.run((g) => g.clearSelectionValues(true));
    expect(h.result.current.notes.has(key(1, 102))).toBe(false);
  });

  it('选区全部只读时提示且不误报成功', () => {
    const h = setup();
    h.readonly.add('1:101');
    h.run((g) => g.focusCell(0, 0));
    h.run((g) => g.clearSelectionValues(false));
    expect(notified(h, '没有可清空的单元格')).toBe(true);
  });
});

/* ============ 单格输入 / 提交 / Esc ============ */

describe('单格输入与提交(setCellInput / commitCell / cancelEdit)', () => {
  it('输入态即时可见但不入撤销栈,失焦提交才入栈', () => {
    const h = setup();
    h.run((g) => { g.handleCellFocus(0, 0); g.setCellInput(0, 0, '42'); });
    expect(h.result.current.values.get(key(1, 101))).toBe('42');
    expect(h.result.current.canUndo).toBe(false);
    h.run((g) => g.commitCell(0, 0));
    expect(h.result.current.canUndo).toBe(true);
  });

  it('失焦规范化:千分位与货币符号按粘贴同口径清洗', () => {
    const h = setup();
    h.run((g) => { g.handleCellFocus(0, 0); g.setCellInput(0, 0, '¥1,234.5'); g.commitCell(0, 0); });
    expect(h.result.current.values.get(key(1, 101))).toBe('1234.5');
  });

  it('公式输入预览并在提交时求值绑定', () => {
    const h = setup();
    h.run((g) => { g.handleCellFocus(0, 0); g.setCellInput(0, 0, '=1+2'); });
    expect(h.result.current.formulaPreview?.res.ok).toBe(true);
    expect(h.result.current.formulaPreview?.res.display).toBe('3.00');
    h.run((g) => g.commitCell(0, 0));
    expect(h.result.current.values.get(key(1, 101))).toBe('3.00');
    expect(h.result.current.formulas.get(key(1, 101))).toBe('=1+2');
    expect(h.result.current.formulaPreview).toBeNull();
  });

  it('数值等价(1234.5 vs 1234.50)提交不产生撤销步骤', () => {
    const h = setup();
    h.run((g) => g.resetData(mapOf([[key(1, 101), '1234.5']])));
    h.run((g) => { g.handleCellFocus(0, 0); g.setCellInput(0, 0, '1234.50'); g.commitCell(0, 0); });
    expect(h.result.current.canUndo).toBe(false);
  });

  it('提交非法普通值时清除遗留公式绑定并标红', () => {
    const h = setup();
    h.run((g) => g.applyCells([{ key: key(1, 101), value: '=1+1' }], '公式'));
    h.run((g) => { g.handleCellFocus(0, 0); g.setCellInput(0, 0, 'abc'); g.commitCell(0, 0); });
    expect(h.result.current.values.get(key(1, 101))).toBe('abc');
    expect(h.result.current.formulas.has(key(1, 101))).toBe(false);
    expect(h.result.current.invalidCells.has(key(1, 101))).toBe(true);
  });

  it('Esc 还原进入编辑前的值且不入撤销栈', () => {
    const h = setup();
    h.run((g) => g.resetData(mapOf([[key(1, 101), '100']])));
    h.run((g) => { g.handleCellFocus(0, 0); g.setCellInput(0, 0, '999'); g.cancelEdit(); });
    expect(h.result.current.values.get(key(1, 101))).toBe('100');
    expect(h.result.current.canUndo).toBe(false);
    expect(h.result.current.dirty).toBe(false);
  });
});

/* ============ 键盘状态机 ============ */

describe('键盘路由(handleCellKeyDown)', () => {
  it('Ctrl+Z 撤销 / Ctrl+Shift+Z 与 Ctrl+Y 重做', () => {
    const h = setup();
    h.run((g) => g.applyCells([{ key: key(1, 101), value: '100' }], '编辑'));
    h.run((g) => g.handleCellKeyDown(keyEvent('z', { ctrl: true }), 0, 0));
    expect(h.result.current.values.has(key(1, 101))).toBe(false);
    h.run((g) => g.handleCellKeyDown(keyEvent('z', { ctrl: true, shift: true }), 0, 0));
    expect(h.result.current.values.get(key(1, 101))).toBe('100');
    h.run((g) => g.handleCellKeyDown(keyEvent('z', { ctrl: true }), 0, 0));
    h.run((g) => g.handleCellKeyDown(keyEvent('y', { ctrl: true }), 0, 0));
    expect(h.result.current.values.get(key(1, 101))).toBe('100');
  });

  it('Ctrl+D 触发向下填充', () => {
    const h = setup();
    h.run((g) => {
      g.applyCells([{ key: key(2, 101), value: '500' }], '录入');
      g.focusCell(1, 0);
      g.extendSelection(1, 0);
    });
    h.run((g) => g.handleCellKeyDown(keyEvent('d', { ctrl: true }), 1, 0));
    expect(h.result.current.values.get(key(3, 101))).toBe('500');
  });

  it('Delete:多格选区直接清空;单格未修改态清格;编辑态走原生', () => {
    const h = setup();
    h.run((g) => g.resetData(mapOf([[key(1, 101), '100'], [key(1, 102), '200'], [key(3, 101), '300']])));
    // 多格选区
    h.run((g) => { g.focusCell(0, 0); g.extendSelection(0, 1); });
    const multi = keyEvent('Delete');
    h.run((g) => g.handleCellKeyDown(multi, 0, 0));
    expect(multi.preventDefault).toHaveBeenCalled();
    expect(h.result.current.values.has(key(1, 101))).toBe(false);
    expect(h.result.current.values.has(key(1, 102))).toBe(false);

    // 单格未修改(输入框值与进入编辑时一致)
    h.run((g) => g.handleCellFocus(2, 0));
    const single = keyEvent('Delete', { value: '300' });
    h.run((g) => g.handleCellKeyDown(single, 2, 0));
    expect(single.preventDefault).toHaveBeenCalled();
    expect(h.result.current.values.has(key(3, 101))).toBe(false);

    // 编辑态(值已修改)不拦截
    h.run((g) => g.resetData(mapOf([[key(3, 101), '300']])));
    h.run((g) => g.handleCellFocus(2, 0));
    const editing = keyEvent('Delete', { value: '300x' });
    h.run((g) => g.handleCellKeyDown(editing, 2, 0));
    expect(editing.preventDefault).not.toHaveBeenCalled();
    expect(h.result.current.values.get(key(3, 101))).toBe('300');
  });

  it('Enter 提交并下移,跳过只读行', () => {
    const h = setup();
    h.readonly.add('2:101');
    h.run((g) => { g.handleCellFocus(0, 0); g.setCellInput(0, 0, '42'); });
    h.run((g) => g.handleCellKeyDown(keyEvent('Enter', { value: '42' }), 0, 0));
    expect(h.result.current.values.get(key(1, 101))).toBe('42');
    expect(h.result.current.active).toEqual({ r: 2, c: 0 }); // 跳过只读的费用B 行
  });

  it('Tab 在行尾回绕到下一行首列', () => {
    const h = setup();
    h.run((g) => g.focusCell(0, 2));
    h.run((g) => g.handleCellKeyDown(keyEvent('Tab'), 0, 2));
    expect(h.result.current.active).toEqual({ r: 1, c: 0 });
  });

  it('Shift+方向键扩展选区不移动锚点', () => {
    const h = setup();
    h.run((g) => g.focusCell(0, 0));
    h.run((g) => g.handleCellKeyDown(keyEvent('ArrowDown', { shift: true }), 0, 0));
    h.run((g) => g.handleCellKeyDown(keyEvent('ArrowRight', { shift: true }), 0, 1));
    expect(h.result.current.selection).toEqual({ r1: 0, c1: 0, r2: 1, c2: 1 });
    expect(h.result.current.selectionSize).toBe(4);
  });

  it('输入法候选框操作(isComposing)不触发任何导航', () => {
    const h = setup();
    h.run((g) => g.focusCell(0, 0));
    const ev = keyEvent('Enter', { composing: true });
    h.run((g) => g.handleCellKeyDown(ev, 0, 0));
    expect(ev.preventDefault).not.toHaveBeenCalled();
    expect(h.result.current.active).toEqual({ r: 0, c: 0 });
  });

  it('中文输入法候选期间方向键/Tab/Esc 均不跳格、不提交、不取消编辑', () => {
    const h = setup();
    h.run((g) => { g.handleCellFocus(0, 0); g.setCellInput(0, 0, '12'); });
    for (const keyName of ['ArrowDown', 'ArrowUp', 'ArrowLeft', 'ArrowRight', 'Tab', 'Escape']) {
      const ev = keyEvent(keyName, { composing: true, value: '12' });
      h.run((g) => g.handleCellKeyDown(ev, 0, 0));
      expect(ev.preventDefault).not.toHaveBeenCalled();
      expect(h.result.current.active).toEqual({ r: 0, c: 0 });
    }
    // 输入态仍在(未被 commit/Esc 改动),composition 结束后正常提交
    expect(h.result.current.values.get(key(1, 101))).toBe('12');
    h.run((g) => g.handleCellKeyDown(keyEvent('Enter', { value: '12' }), 0, 0));
    expect(h.result.current.active).toEqual({ r: 1, c: 0 });
  });

  it('Ctrl+方向键跳连续数据块边界;空区跳到网格边缘', () => {
    const h = setup();
    h.run((g) => g.resetData(mapOf([[key(1, 101), '1'], [key(1, 102), '2']])));
    h.run((g) => g.focusCell(0, 0));
    h.run((g) => g.handleCellKeyDown(keyEvent('ArrowRight', { ctrl: true }), 0, 0));
    expect(h.result.current.active).toEqual({ r: 0, c: 1 }); // 数据块末格

    const empty = setup();
    empty.run((g) => g.focusCell(0, 0));
    empty.run((g) => g.handleCellKeyDown(keyEvent('ArrowRight', { ctrl: true }), 0, 0));
    expect(empty.result.current.active).toEqual({ r: 0, c: 2 }); // 一路跳到边缘
  });
});

/* ============ 选区聚合统计 ============ */

describe('选区聚合统计(selectionStats)', () => {
  it('求和/利润方向合计/计数/均值,数量隔离、非法格单列', () => {
    const h = setup();
    h.run((g) => {
      g.applyCells([
        { key: key(1, 101), value: '100' },   // 收入 +1
        { key: key(2, 101), value: '30' },    // 费用 -1
        { key: key(3, 101), value: 'abc' },   // 非法
        { key: key(4, 101), value: '5' },     // 数量,不参与求和
      ], '录入');
      g.focusCell(0, 0);
      g.extendSelection(3, 0);
    });
    const s = h.result.current.selectionStats!;
    expect(s.count).toBe(4);
    expect(s.nonEmpty).toBe(4);
    expect(s.moneyCount).toBe(2);
    expect(s.qtyCount).toBe(1);
    expect(s.invalidCount).toBe(1);
    expect(s.sum).toBe(130);
    expect(s.directional).toBe(70); // 100 - 30
    expect(s.avg).toBe(65);
  });

  it('无选区时返回 null', () => {
    const h = setup();
    expect(h.result.current.selectionStats).toBeNull();
  });
});

/* ============ 查找 / 替换 ============ */

describe('网格内查找/替换', () => {
  it('按标签/值/公式/附注分范围命中', () => {
    const h = setup();
    h.run((g) => {
      g.applyCells([
        { key: key(1, 101), value: '100' },
        { key: key(2, 101), value: '=1+1' },
        { key: key(3, 102), note: '依据100' },
      ], '录入');
    });
    // 标签:费用B/费用C × 3 列
    const byLabel = h.result.current.findMatches('费用', {});
    expect(byLabel).toHaveLength(6);
    expect(byLabel.every((m) => m.kind === 'label')).toBe(true);
    // 值范围(默认)
    const byValue = h.result.current.findMatches('100', {});
    expect(byValue.map((m) => m.kind)).toEqual(['value']);
    expect(byValue[0].key).toBe(key(1, 101));
    // 附注需显式开启
    const withNote = h.result.current.findMatches('100', { note: true });
    expect(withNote.map((m) => m.kind).sort()).toEqual(['note', 'value']);
    // 公式需显式开启
    expect(h.result.current.findMatches('=1', {})).toHaveLength(0);
    const byFormula = h.result.current.findMatches('=1', { formula: true });
    expect(byFormula.map((m) => m.kind)).toEqual(['formula']);
  });

  it('替换命中子串并整体入一步撤销;标签命中不替换', () => {
    const h = setup();
    h.run((g) => g.applyCells([{ key: key(1, 101), value: '100' }, { key: key(1, 102), value: '100' }], '录入'));
    const matches = h.result.current.findMatches('100', {});
    let replaced = 0;
    h.run((g) => { replaced = g.replaceMatches(matches, '200', '100'); });
    expect(replaced).toBe(2);
    expect(h.result.current.values.get(key(1, 101))).toBe('200');
    expect(h.result.current.values.get(key(1, 102))).toBe('200');
    expect(h.result.current.undoDepth).toBe(2); // 录入 + 替换
    // 标签命中跳过:查「费用」命中 6 个标签格,替换返回 0
    let labelReplaced = -1;
    h.run((g) => { labelReplaced = g.replaceMatches(g.findMatches('费用', {}), 'X', '费用'); });
    expect(labelReplaced).toBe(0);
  });

  it('替换为空串等价于清空该格', () => {
    const h = setup();
    h.run((g) => g.applyCells([{ key: key(1, 101), value: '100' }], '录入'));
    h.run((g) => g.replaceMatches(g.findMatches('100', {}), '', '100'));
    expect(h.result.current.values.has(key(1, 101))).toBe(false);
  });
});

/* ============ TSV 复制 ============ */

describe('批量复制(buildSelectionTsv)', () => {
  it('无表头纯值矩阵;含表头带行列标签', () => {
    const h = setup();
    h.run((g) => {
      g.resetData(mapOf([
        [key(1, 101), '1'], [key(1, 102), '2'],
        [key(2, 101), '3'], [key(2, 102), '4'],
      ]));
      g.focusCell(0, 0);
      g.extendSelection(1, 1);
    });
    expect(h.result.current.buildSelectionTsv(false)).toBe('1\t2\n3\t4');
    expect(h.result.current.buildSelectionTsv(true)).toBe(
      '科目\\组织\t一月\t二月\n收入A\t1\t2\n费用B\t3\t4',
    );
  });

  it('无选区返回 null', () => {
    const h = setup();
    expect(h.result.current.buildSelectionTsv(false)).toBeNull();
  });
});

/* ============ 焦点位置记忆 ============ */

describe('焦点位置记忆(persistKey)', () => {
  it('焦点变化写入 sessionStorage,restoreFocus 按 id 还原', () => {
    const h = setup({ persistKey: 'v1' });
    h.run((g) => g.focusCell(1, 1));
    expect(sessionStorage.getItem('v1:gridpos')).toBe(JSON.stringify({ rowId: 2, colId: 102 }));

    const restored = setup({ persistKey: 'v1' });
    restored.run((g) => g.restoreFocus());
    expect(restored.result.current.active).toEqual({ r: 1, c: 1 });
  });

  it('存储中的 id 已不存在时静默忽略', () => {
    sessionStorage.setItem('v2:gridpos', JSON.stringify({ rowId: 999, colId: 888 }));
    const h = setup({ persistKey: 'v2' });
    h.run((g) => g.restoreFocus());
    expect(h.result.current.active).toBeNull();
  });
});
