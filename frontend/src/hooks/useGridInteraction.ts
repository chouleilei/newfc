/**
 * 自研表格统一交互层(《预算表格手感优化方案》阶段〇~六落地):
 * - applyCells 统一写入入口:values/formulas/notes + invalidCells + dirtyCells + 撤销栈 单一出口
 * - 焦点格 + 矩形选区双模型(Shift+方向键/Shift+点击扩展)
 * - 编辑态/导航态键盘状态机(Enter/Tab/方向键/Home/End/PageUp/Down/Ctrl+方向跳边界)
 * - 撤销/重做(Ctrl+Z / Ctrl+Y / Ctrl+Shift+Z,容量 100,保存不清栈)
 * - 外部编辑(汇总格备注)经 pushExternalUndo 入同一撤销栈,按发生顺序混排;
 *   重放时复核 canApply,只读/历史任务下拒绝写入(UX-23-6)
 * - 矩阵粘贴引擎(清洗、如实反馈、转置、跳过空、定位首个问题格)与批量复制(TSV)
 * - Delete 批量清空、Ctrl+D/Ctrl+R 填充、拖拽填充柄
 * - 选区聚合统计(求和/利润方向合计/计数/非空/均值)与网格内查找
 * 所有批量写必须走 applyCells;只读守卫由 isCellEditable 注入,跳过数如实反馈。
 */

import { readBrowserStorage } from '../utils/browserStorage';
import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { ClipboardEvent as ReactClipboardEvent, KeyboardEvent as ReactKeyboardEvent, MouseEvent as ReactMouseEvent } from 'react';
import { amountSchema, quantitySchema, signOfType, cellValueEquivalent } from '../utils/money';
import { isFormula, evaluateFormula } from '../utils/formula';

export const UNDO_LIMIT = 100;

export interface CellPos { r: number; c: number }
export interface SelRect { r1: number; c1: number; r2: number; c2: number } // 已归一化 r1<=r2, c1<=c2

export interface GridRowDesc { id: number; type: string; label: string }
export interface GridColDesc { id: number; label: string }

export interface CellUpdate {
  key: string;                // `${colId}:${rowId}`
  value?: string;             // 不传则不改
  formula?: string | null;    // null = 清除
  note?: string | null;
  type?: string;              // 行类型(amount/quantity/...),不传时按 key 反查
}

export interface ApplyResult {
  written: number;
  skipped: number;            // 只读跳过
  typeSkipped: number;        // 填充时类型不匹配跳过
  invalid: number;            // 写入后非法(标红)格数
  writtenKeys: string[];      // 实际发生变化的格(供粘贴统计真实行列数)
}

interface CellState { value: string; formula: string; note: string }
interface DeltaCell { key: string; before: CellState; after: CellState }

/**
 * 页面级外部编辑(如汇总格备注)的撤销条目(UX-23-6):
 * 与明细格操作共用同一撤销栈,按发生顺序撤销/重做。
 * canApply 在重放时复核(目标变只读/历史任务/冲突锁定时拒绝写入,步骤丢弃),
 * 保证只读与历史限制不被撤销入口绕过。
 */
export interface ExternalUndoEntry {
  canApply: () => boolean;
  undo: () => void;
  redo: () => void;
}

interface GridDelta { label: string; cells: DeltaCell[]; external?: ExternalUndoEntry }

export interface SelectionStats {
  count: number; nonEmpty: number; moneyCount: number; qtyCount: number;
  invalidCount: number; sum: number; directional: number; avg: number | null;
}

export interface FindMatch { r: number; c: number; key: string; kind: 'label' | 'value' | 'formula' | 'note'; preview: string }

export interface PasteOptions { transpose?: boolean; skipEmpty?: boolean; valuesOnly?: boolean }
export interface PasteOutcome extends ApplyResult {
  writtenRows: number; writtenCols: number; outRows: number; outCols: number;
  /** 首个格式非法格的网格坐标(UX-23-5:支持定位首个问题格);无非法格为 null */
  firstInvalid: CellPos | null;
}

/* ============ 纯函数:剪贴板解析与清洗(供单元测试) ============ */

/** Excel 带格式数字清洗:货币符号、千分位、引号包裹、不间断空格、首部加号 */
export function cleanPastedValue(raw: string): string {
  let val = raw.replace(/[\u00A0\u3000]/g, ' ').trim();
  val = val.replace(/[¥￥$€]/g, '').trim();
  val = val.replace(/^"(.*)"$/, '$1').trim();
  val = val.replace(/,/g, '');
  val = val.replace(/^\+/, '');
  return val.trim();
}

/** 失焦数字规范化:与粘贴清洗同口径(输入态随意、显示态规整) */
export function normalizeNumericInput(raw: string): string {
  if (isFormula(raw)) return raw;
  return cleanPastedValue(raw);
}

/** 剪贴板文本 -> 行列矩阵(归一换行、去末尾空行) */
export function parseClipboardGrid(text: string): string[][] {
  const lines = text.replace(/\r\n/g, '\n').replace(/\r/g, '\n').split('\n');
  if (lines.length > 0 && lines[lines.length - 1].trim() === '') lines.pop();
  return lines.map((line) => line.split('\t'));
}

export function transposeGrid(grid: string[][]): string[][] {
  const rows = grid.length; const cols = Math.max(0, ...grid.map((r) => r.length));
  const out: string[][] = [];
  for (let c = 0; c < cols; c++) out.push(grid.map((row) => row[c] ?? ''));
  return out;
}

/* ============ Hook ============ */

export interface GridInteractionOptions {
  /** 行/列几何用惰性 getter 注入:页面可在 hook 声明之后才完成 visibleRows 等推导 */
  getRows: () => GridRowDesc[];
  getCols: () => GridColDesc[];
  isCellEditable: (rowId: number, colId: number) => boolean;
  cellDomId: (rowId: number, colId: number) => string;
  onOpenNote?: (rowId: number, colId: number) => void;
  onOpenFind?: (mode: 'find' | 'replace') => void;
  onOpenPasteSpecial?: () => void;
  notify: (type: 'success' | 'info' | 'warning' | 'error', text: string) => void;
  persistKey?: string;                                    // 焦点位置记忆(sessionStorage)
}

/** 查找/替换用的正则转义 */
function escapeRegExp(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function useGridInteraction(opts: GridInteractionOptions) {
  const { notify } = opts;

  /* ---- 主数据:state(身份变化驱动渲染) + ref 镜像(事件期读取) ---- */
  const [values, setValues] = useState<Map<string, string>>(new Map());
  const [formulas, setFormulas] = useState<Map<string, string>>(new Map());
  const [notes, setNotes] = useState<Map<string, string>>(new Map());
  const [invalidCells, setInvalidCells] = useState<Set<string>>(new Set());
  const [dirtyCells, setDirtyCells] = useState<Set<string>>(new Set());
  const invalidCellsRef = useRef(invalidCells);
  const dirtyCellsRef = useRef(dirtyCells);
  const activeRef = useRef<CellPos | null>(null);

  const valuesRef = useRef(values);
  const formulasRef = useRef(formulas);
  const notesRef = useRef(notes);
  const snapshotRef = useRef<{ values: Map<string, string>; formulas: Map<string, string>; notes: Map<string, string> }>({ values: new Map(), formulas: new Map(), notes: new Map() });

  /* ---- 焦点/选区 ---- */
  const [active, setActive] = useState<CellPos | null>(null);
  const [anchor, setAnchor] = useState<CellPos | null>(null);
  const [formulaPreview, setFormulaPreview] = useState<{ key: string; res: ReturnType<typeof evaluateFormula> } | null>(null);
  const editSnapshotRef = useRef<{ key: string } & CellState | null>(null);

  /* ---- 撤销栈 ---- */
  const undoStackRef = useRef<GridDelta[]>([]);
  const redoStackRef = useRef<GridDelta[]>([]);
  const [undoDepth, setUndoDepth] = useState(0);
  const [redoDepth, setRedoDepth] = useState(0);

  /* ---- 行列几何:getter 惰性求值 + 镜像 state(驱动统计/高亮),事件期读 ref ---- */
  const [geometry, setGeometry] = useState<{ rows: GridRowDesc[]; cols: GridColDesc[]; sig: string }>({ rows: [], cols: [], sig: '' });
  const geoSigRef = useRef('');
  const rowsRef = useRef<GridRowDesc[]>([]);
  const colsRef = useRef<GridColDesc[]>([]);
  const optsRef = useRef(opts);
  optsRef.current = opts;

  useEffect(() => {
    const rows = optsRef.current.getRows();
    const cols = optsRef.current.getCols();
    rowsRef.current = rows;
    colsRef.current = cols;
    const sig = `${rows.map((r) => r.id).join(',')}|${cols.map((c) => c.id).join(',')}`;
    if (sig !== geoSigRef.current) {
      geoSigRef.current = sig;
      setGeometry({ rows, cols, sig });
      // 几何变化(筛选/折叠/视图切换):清空选区、编辑快照与公式预览,不做静默映射
      setAnchor(null);
      editSnapshotRef.current = null;
      setFormulaPreview(null);
      setActive((prev) => {
        if (!prev) return prev;
        if (prev.r >= rows.length || prev.c >= cols.length) return null;
        return prev;
      });
    }
  });

  const keyOf = useCallback((r: number, c: number) => `${colsRef.current[c]?.id}:${rowsRef.current[r]?.id}`, []);
  const typeOfRow = useCallback((rowId: number) => rowsRef.current.find((x) => x.id === rowId)?.type ?? 'expense', []);
  const decimalsFor = useCallback((type: string) => (type === 'quantity' ? 4 : 2), []);

  const validateValue = useCallback((val: string, type: string): boolean => {
    if (val === '') return true;
    if (isFormula(val)) return evaluateFormula(val, decimalsFor(type)).ok;
    const schema = type === 'quantity' ? quantitySchema : amountSchema;
    return schema.safeParse(cleanPastedValue(val)).success;
  }, [decimalsFor]);

  /* ---- 内部提交:同步 ref 与 state ---- */
  const commitState = useCallback((next: { values?: Map<string, string>; formulas?: Map<string, string>; notes?: Map<string, string>; invalid?: Set<string>; dirty?: Set<string> }) => {
    if (next.values) { valuesRef.current = next.values; setValues(next.values); }
    if (next.formulas) { formulasRef.current = next.formulas; setFormulas(next.formulas); }
    if (next.notes) { notesRef.current = next.notes; setNotes(next.notes); }
    if (next.invalid) { invalidCellsRef.current = next.invalid; setInvalidCells(next.invalid); }
    if (next.dirty) { dirtyCellsRef.current = next.dirty; setDirtyCells(next.dirty); }
  }, []);

  const cellStateOf = useCallback((key: string): CellState => ({
    value: valuesRef.current.get(key) ?? '',
    formula: formulasRef.current.get(key) ?? '',
    note: notesRef.current.get(key) ?? '',
  }), []);

  const matchesSnapshot = useCallback((key: string, st: CellState): boolean => {
    const snap = snapshotRef.current;
    return st.value === (snap.values.get(key) ?? '') && st.formula === (snap.formulas.get(key) ?? '') && st.note === (snap.notes.get(key) ?? '');
  }, []);

  /** 重算若干 key 的脏标记(增量,不做全量扫描) */
  const recomputeDirty = useCallback((keys: Iterable<string>) => {
    const next = new Set(dirtyCellsRef.current);
    for (const key of keys) {
      if (matchesSnapshot(key, cellStateOf(key))) next.delete(key); else next.add(key);
    }
    commitState({ dirty: next });
  }, [cellStateOf, commitState, matchesSnapshot]);

  const pushUndo = useCallback((delta: GridDelta) => {
    if (delta.cells.length === 0 && !delta.external) return;
    undoStackRef.current.push(delta);
    if (undoStackRef.current.length > UNDO_LIMIT) undoStackRef.current.shift();
    redoStackRef.current = [];
    setUndoDepth(undoStackRef.current.length);
    setRedoDepth(0);
  }, []);

  /** 外部编辑(汇总格备注等页面级状态)提交后入统一撤销栈,与明细操作按发生顺序混排 */
  const pushExternalUndo = useCallback((label: string, entry: ExternalUndoEntry) => {
    pushUndo({ label, cells: [], external: entry });
  }, [pushUndo]);

  /* ============ 统一写入入口 ============ */
  const applyCells = useCallback((updates: CellUpdate[], label: string): ApplyResult => {
    const res: ApplyResult = { written: 0, skipped: 0, typeSkipped: 0, invalid: 0, writtenKeys: [] };
    if (updates.length === 0) return res;

    const nextValues = new Map(valuesRef.current);
    const nextFormulas = new Map(formulasRef.current);
    const nextNotes = new Map(notesRef.current);
    const nextInvalid = new Set(invalidCellsRef.current);
    const touched = new Set<string>();
    const deltaCells: DeltaCell[] = [];

    for (const u of updates) {
      const [colIdStr, rowIdStr] = u.key.split(':');
      const rowId = Number(rowIdStr); const colId = Number(colIdStr);
      if (!optsRef.current.isCellEditable(rowId, colId)) { res.skipped++; continue; }
      const type = u.type ?? typeOfRow(rowId);
      const before = cellStateOf(u.key);
      const after: CellState = { ...before };

      if (u.value !== undefined) after.value = u.value;
      if (u.formula !== undefined) after.formula = u.formula ?? '';
      if (u.note !== undefined) after.note = u.note ?? '';

      // 公式绑定:值为公式或显式传入公式 -> 求值并存绑定;普通数值粘贴清除旧公式(除非 valuesOnly)
      if (u.value !== undefined && isFormula(after.value)) {
        const evalRes = evaluateFormula(after.value, decimalsFor(type));
        if (evalRes.ok && evalRes.value !== null) {
          after.formula = after.value;
          after.value = evalRes.display!;
        }
      } else if (u.formula !== undefined && isFormula(after.formula)) {
        const evalRes = evaluateFormula(after.formula, decimalsFor(type));
        if (evalRes.ok && evalRes.value !== null) after.value = evalRes.display!;
      }

      if (after.value === before.value && after.formula === before.formula && after.note === before.note) continue;

      if (after.value !== '') nextValues.set(u.key, after.value); else nextValues.delete(u.key);
      if (after.formula !== '') nextFormulas.set(u.key, after.formula); else nextFormulas.delete(u.key);
      if (after.note !== '') nextNotes.set(u.key, after.note); else nextNotes.delete(u.key);

      const ok = validateValue(after.value, type);
      if (ok) nextInvalid.delete(u.key); else nextInvalid.add(u.key);
      if (!ok) res.invalid++;

      touched.add(u.key);
      deltaCells.push({ key: u.key, before, after });
      res.written++;
      res.writtenKeys.push(u.key);
    }

    if (res.written > 0) {
      commitState({ values: nextValues, formulas: nextFormulas, notes: nextNotes, invalid: nextInvalid });
      recomputeDirty(touched);
      pushUndo({ label, cells: deltaCells });
    }
    return res;
  }, [cellStateOf, commitState, decimalsFor, pushUndo, recomputeDirty, typeOfRow, validateValue]);

  /* ============ 生命周期 ============ */
  const resetData = useCallback((v: Map<string, string>, f?: Map<string, string>, n?: Map<string, string>) => {
    const fv = f ?? new Map<string, string>();
    const fn = n ?? new Map<string, string>();
    snapshotRef.current = { values: new Map(v), formulas: new Map(fv), notes: new Map(fn) };
    undoStackRef.current = []; redoStackRef.current = [];
    setUndoDepth(0); setRedoDepth(0);
    editSnapshotRef.current = null;
    setFormulaPreview(null);
    commitState({ values: new Map(v), formulas: new Map(fv), notes: new Map(fn), invalid: new Set(), dirty: new Set() });
  }, [commitState]);

  /** 保存成功:快照前移、脏格清零,撤销栈保留(与 Excel 一致)。
   *  exceptKeys:本次未随保存落库的格子(如仅附注无数值),保持脏标记,避免"看似已存实际未存"。 */
  const markSaved = useCallback((exceptKeys?: ReadonlySet<string>) => {
    snapshotRef.current = { values: new Map(valuesRef.current), formulas: new Map(formulasRef.current), notes: new Map(notesRef.current) };
    commitState({ dirty: exceptKeys && exceptKeys.size > 0 ? new Set(exceptKeys) : new Set() });
  }, [commitState]);

  /**
   * 异步自动保存成功:以“实际发送到服务端”的快照前移基线,再与当前编辑态重算脏格。
   * 保存请求在途期间继续录入的内容不会被误标为已保存。
   */
  const markPersisted = useCallback((
    v: Map<string, string>,
    f: Map<string, string>,
    n: Map<string, string>,
  ) => {
    const saved = { values: new Map(v), formulas: new Map(f), notes: new Map(n) };
    snapshotRef.current = saved;
    const keys = new Set([
      ...valuesRef.current.keys(), ...formulasRef.current.keys(), ...notesRef.current.keys(),
      ...saved.values.keys(), ...saved.formulas.keys(), ...saved.notes.keys(),
    ]);
    const nextDirty = new Set<string>();
    for (const key of keys) {
      if ((valuesRef.current.get(key) ?? '') !== (saved.values.get(key) ?? '')
        || (formulasRef.current.get(key) ?? '') !== (saved.formulas.get(key) ?? '')
        || (notesRef.current.get(key) ?? '') !== (saved.notes.get(key) ?? '')) {
        nextDirty.add(key);
      }
    }
    commitState({ dirty: nextDirty });
  }, [commitState]);

  /** 丢弃编辑(dirty 置零但不动数据;随后一般紧跟 resetData) */
  const markClean = useCallback(() => {
    commitState({ dirty: new Set() });
  }, [commitState]);

  /* ============ 撤销/重做 ============ */
  const replayDelta = useCallback((delta: GridDelta, dir: 'undo' | 'redo') => {
    const nextValues = new Map(valuesRef.current);
    const nextFormulas = new Map(formulasRef.current);
    const nextNotes = new Map(notesRef.current);
    const nextInvalid = new Set(invalidCellsRef.current);
    const touched = new Set<string>();
    const typeCache = new Map<string, string>();
    for (const cell of delta.cells) {
      // 只读守卫与写入一致:冻结/范围变化后不可编辑的格不允许被撤销重放改写
      const [colIdStr, rowIdStr] = cell.key.split(':');
      if (!optsRef.current.isCellEditable(Number(rowIdStr), Number(colIdStr))) continue;
      const st = dir === 'undo' ? cell.before : cell.after;
      if (st.value !== '') nextValues.set(cell.key, st.value); else nextValues.delete(cell.key);
      if (st.formula !== '') nextFormulas.set(cell.key, st.formula); else nextFormulas.delete(cell.key);
      if (st.note !== '') nextNotes.set(cell.key, st.note); else nextNotes.delete(cell.key);
      const rowId = Number(rowIdStr);
      let type = typeCache.get(cell.key);
      if (!type) { type = typeOfRow(rowId); typeCache.set(cell.key, type); }
      if (validateValue(st.value, type)) nextInvalid.delete(cell.key); else nextInvalid.add(cell.key);
      touched.add(cell.key);
    }
    if (touched.size === 0) return false;
    commitState({ values: nextValues, formulas: nextFormulas, notes: nextNotes, invalid: nextInvalid });
    recomputeDirty(touched);
    return true;
  }, [commitState, recomputeDirty, typeOfRow, validateValue]);

  const undo = useCallback(() => {
    const delta = undoStackRef.current.pop();
    if (!delta) { notify('info', '没有可撤销的操作'); return; }
    // 外部编辑条目(汇总格备注等):重放前复核可编辑性,只读/历史任务下拒绝写入并丢弃该步
    if (delta.external) {
      if (!delta.external.canApply()) {
        setUndoDepth(undoStackRef.current.length);
        notify('info', `「${delta.label}」当前不可撤销(目标已只读),已跳过`);
        return;
      }
      delta.external.undo();
      redoStackRef.current.push(delta);
      setUndoDepth(undoStackRef.current.length);
      setRedoDepth(redoStackRef.current.length);
      notify('success', `已撤销: ${delta.label}`);
      return;
    }
    const applied = replayDelta(delta, 'undo');
    if (!applied) {
      // 全部格已不可编辑:丢弃该步避免重做栈错乱
      setUndoDepth(undoStackRef.current.length);
      notify('info', '该操作涉及的单元格已不可编辑,无法撤销');
      return;
    }
    redoStackRef.current.push(delta);
    setUndoDepth(undoStackRef.current.length);
    setRedoDepth(redoStackRef.current.length);
    notify('success', `已撤销: ${delta.label}(${delta.cells.length} 格)`);
  }, [notify, replayDelta]);

  const redo = useCallback(() => {
    const delta = redoStackRef.current.pop();
    if (!delta) { notify('info', '没有可重做的操作'); return; }
    if (delta.external) {
      if (!delta.external.canApply()) {
        setRedoDepth(redoStackRef.current.length);
        notify('info', `「${delta.label}」当前不可重做(目标已只读),已跳过`);
        return;
      }
      delta.external.redo();
      undoStackRef.current.push(delta);
      setUndoDepth(undoStackRef.current.length);
      setRedoDepth(redoStackRef.current.length);
      notify('success', `已重做: ${delta.label}`);
      return;
    }
    const applied = replayDelta(delta, 'redo');
    if (!applied) {
      setRedoDepth(redoStackRef.current.length);
      notify('info', '该操作涉及的单元格已不可编辑,无法重做');
      return;
    }
    undoStackRef.current.push(delta);
    setUndoDepth(undoStackRef.current.length);
    setRedoDepth(redoStackRef.current.length);
    notify('success', `已重做: ${delta.label}(${delta.cells.length} 格)`);
  }, [notify, replayDelta]);

  /* ============ 焦点与选区 ============ */
  const selection: SelRect | null = useMemo(() => {
    if (!active) return null;
    const a = anchor ?? active;
    return {
      r1: Math.min(a.r, active.r), r2: Math.max(a.r, active.r),
      c1: Math.min(a.c, active.c), c2: Math.max(a.c, active.c),
    };
  }, [active, anchor]);

  const isInSelection = useCallback((r: number, c: number) => {
    if (!selection) return false;
    return r >= selection.r1 && r <= selection.r2 && c >= selection.c1 && c <= selection.c2;
  }, [selection]);

  const focusCell = useCallback((r: number, c: number, extend = false) => {
    const R = rowsRef.current; const C = colsRef.current;
    if (r < 0 || c < 0 || r >= R.length || c >= C.length) return;
    activeRef.current = { r, c };
    setActive({ r, c });
    if (!extend) setAnchor({ r, c });
    const el = document.getElementById(optsRef.current.cellDomId(R[r].id, C[c].id));
    if (el) {
      el.focus();
      el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    }
  }, []);

  /** 纵向/横向移动到下一个可编辑格(跳过只读行/列,与 Tab 序一致) */
  const moveFocus = useCallback((r: number, c: number, dr: number, dc: number, wrap = false) => {
    const R = rowsRef.current; const C = colsRef.current;
    const editableAt = (rr: number, cc: number) => optsRef.current.isCellEditable(R[rr].id, C[cc].id);
    let rr = r; let cc = c;
    if (dc !== 0) {
      cc += dc;
      if (cc < 0 || cc >= C.length) {
        if (!wrap) { cc = Math.max(0, Math.min(C.length - 1, cc)); if (!editableAt(rr, cc)) return; focusCell(rr, cc); return; }
        cc = dc > 0 ? 0 : C.length - 1;
        rr += dc > 0 ? 1 : -1;
        if (rr < 0 || rr >= R.length) { return; }
      }
    } else {
      rr += dr;
      if (rr < 0 || rr >= R.length) return;
    }
    // 沿方向扫描至下一个可编辑格
    let guard = R.length * C.length + 2;
    while (guard-- > 0 && !editableAt(rr, cc)) {
      if (dc !== 0) {
        cc += dc;
        if (cc < 0 || cc >= C.length) {
          if (!wrap) return;
          cc = dc > 0 ? 0 : C.length - 1;
          rr += dc > 0 ? 1 : -1;
          if (rr < 0 || rr >= R.length) return;
        }
      } else {
        rr += dr;
        if (rr < 0 || rr >= R.length) return;
      }
    }
    focusCell(rr, cc);
  }, [focusCell]);

  /** Ctrl+方向键:跳到连续数据块边界;空格出发跳到下一个非空格 */
  const jumpEdge = useCallback((r: number, c: number, dr: number, dc: number) => {
    const R = rowsRef.current; const C = colsRef.current;
    const hasVal = (rr: number, cc: number) => (valuesRef.current.get(`${C[cc].id}:${R[rr].id}`) ?? '') !== '';
    const step = (rr: number, cc: number): boolean => (dr !== 0 ? rr + dr >= 0 && rr + dr < R.length : cc + dc >= 0 && cc + dc < C.length);
    const advance = (rr: number, cc: number): [number, number] => (dr !== 0 ? [rr + dr, cc] : [rr, cc + dc]);
    let [rr, cc] = [r, c];
    if (hasVal(r, c)) {
      while (step(rr, cc) && hasVal(...advance(rr, cc))) [rr, cc] = advance(rr, cc);
      if (rr === r && cc === c) {
        // 单格孤岛:继续跳到下一个非空块
        while (step(rr, cc) && !hasVal(...advance(rr, cc))) [rr, cc] = advance(rr, cc);
      }
    } else {
      while (step(rr, cc) && !hasVal(...advance(rr, cc))) [rr, cc] = advance(rr, cc);
    }
    focusCell(rr, cc);
  }, [focusCell]);

  const handleCellFocus = useCallback((r: number, c: number) => {
    const key = keyOf(r, c);
    editSnapshotRef.current = { key, ...cellStateOf(key) };
    activeRef.current = { r, c };
    setActive({ r, c });
    setAnchor({ r, c });
  }, [cellStateOf, keyOf]);

  /** Shift+点击扩展选区(不抢焦点,不改锚点) */
  const handleCellMouseDown = useCallback((e: ReactMouseEvent, r: number, c: number) => {
    if (!e.shiftKey) return;
    e.preventDefault();
    activeRef.current = { r, c };
    setActive({ r, c });
    const el = document.getElementById(optsRef.current.cellDomId(rowsRef.current[r]?.id, colsRef.current[c]?.id));
    if (el) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, []);

  /* ============ 单格输入(commit 于失焦/回车/导航) ============ */
  const setCellInput = useCallback((r: number, c: number, value: string) => {
    const R = rowsRef.current; const C = colsRef.current;
    const row = R[r]; if (!row) return;
    const key = `${C[c]?.id}:${row.id}`;
    const nextValues = new Map(valuesRef.current);
    nextValues.set(key, value);
    // 直接输入普通数字时清理遗留公式绑定(与旧版行为一致)
    let nextFormulas = formulasRef.current;
    if (!isFormula(value) && formulasRef.current.has(key)) {
      nextFormulas = new Map(formulasRef.current);
      nextFormulas.delete(key);
    }
    const nextInvalid = new Set(invalidCellsRef.current);
    if (validateValue(value, row.type)) nextInvalid.delete(key); else nextInvalid.add(key);
    commitState({ values: nextValues, formulas: nextFormulas, invalid: nextInvalid });
    recomputeDirty([key]);
    if (isFormula(value)) setFormulaPreview({ key, res: evaluateFormula(value, decimalsFor(row.type)) });
    else setFormulaPreview(null);
  }, [commitState, decimalsFor, recomputeDirty, validateValue]);

  /** 失焦/Enter 提交:公式求值绑定 + 数字规范化 + 单格撤销入栈 */
  const commitCell = useCallback((r: number, c: number) => {
    const R = rowsRef.current; const C = colsRef.current;
    const row = R[r]; if (!row) return;
    const key = `${C[c]?.id}:${row.id}`;
    const snap = editSnapshotRef.current;
    const current = valuesRef.current.get(key) ?? '';
    setFormulaPreview(null);

    let after: CellState = { value: normalizeNumericInput(current), formula: formulasRef.current.get(key) ?? '', note: notesRef.current.get(key) ?? '' };
    if (isFormula(after.value)) {
      const evalRes = evaluateFormula(after.value, decimalsFor(row.type));
      if (evalRes.ok && evalRes.value !== null) {
        after = { ...after, value: evalRes.display!, formula: after.value };
      }
    } else if (after.value !== '' && !validateValue(after.value, row.type)) {
      after = { ...after, formula: '' };
    }
    editSnapshotRef.current = null;

    const before: CellState = snap && snap.key === key
      ? { value: snap.value, formula: snap.formula, note: snap.note }
      : { value: current, formula: formulasRef.current.get(key) ?? '', note: notesRef.current.get(key) ?? '' };

    const sameValue = after.value === before.value
      || (!isFormula(after.value) && !isFormula(before.value) && cellValueEquivalent(after.value, before.value));
    if (sameValue && after.formula === before.formula && after.note === before.note) return;

    const nextValues = new Map(valuesRef.current);
    const nextFormulas = new Map(formulasRef.current);
    const nextInvalid = new Set(invalidCellsRef.current);
    if (after.value !== '') nextValues.set(key, after.value); else nextValues.delete(key);
    if (after.formula !== '') nextFormulas.set(key, after.formula); else nextFormulas.delete(key);
    if (validateValue(after.value, row.type)) nextInvalid.delete(key); else nextInvalid.add(key);
    commitState({ values: nextValues, formulas: nextFormulas, invalid: nextInvalid });
    recomputeDirty([key]);
    pushUndo({ label: '单格编辑', cells: [{ key, before, after }] });
  }, [commitState, decimalsFor, pushUndo, recomputeDirty, validateValue]);

  /** Esc 还原进入编辑前的值(不入撤销栈) */
  const cancelEdit = useCallback(() => {
    const snap = editSnapshotRef.current;
    if (!snap) return;
    const nextValues = new Map(valuesRef.current);
    const nextFormulas = new Map(formulasRef.current);
    const nextInvalid = new Set(invalidCellsRef.current);
    if (snap.value !== '') nextValues.set(snap.key, snap.value); else nextValues.delete(snap.key);
    if (snap.formula !== '') nextFormulas.set(snap.key, snap.formula); else nextFormulas.delete(snap.key);
    const rowId = Number(snap.key.split(':')[1]);
    if (validateValue(snap.value, typeOfRow(rowId))) nextInvalid.delete(snap.key); else nextInvalid.add(snap.key);
    commitState({ values: nextValues, formulas: nextFormulas, invalid: nextInvalid });
    recomputeDirty([snap.key]);
    editSnapshotRef.current = null;
    setFormulaPreview(null);
  }, [commitState, recomputeDirty, typeOfRow, validateValue]);

  /* ============ 批量操作 ============ */
  const clearSelectionValues = useCallback((clearAll: boolean) => {
    if (!selection) return;
    const R = rowsRef.current; const C = colsRef.current;
    const updates: CellUpdate[] = [];
    for (let r = selection.r1; r <= selection.r2; r++) {
      for (let c = selection.c1; c <= selection.c2; c++) {
        updates.push({
          key: `${C[c].id}:${R[r].id}`, value: '', formula: null,
          note: clearAll ? null : undefined, type: R[r].type,
        });
      }
    }
    const res = applyCells(updates, clearAll ? '清除全部' : '清空数值');
    const extra = res.skipped > 0 ? `；跳过只读 ${res.skipped} 格` : '';
    notify(res.written > 0 ? 'success' : 'warning', res.written > 0 ? `已清空 ${res.written} 格${extra}` : `没有可清空的单元格${extra}`);
  }, [applyCells, notify, selection]);

  const fillBy = useCallback((mode: 'down' | 'right') => {
    if (!selection) return;
    const R = rowsRef.current; const C = colsRef.current;
    const { r1, c1, r2, c2 } = selection;
    const updates: CellUpdate[] = [];
    let typeSkipped = 0;
    if (mode === 'down') {
      if (r2 === r1) { notify('info', '请先选中多行(Shift+方向键或 Shift+点击)再向下填充'); return; }
      for (let r = r1 + 1; r <= r2; r++) {
        for (let c = c1; c <= c2; c++) {
          if (R[r].type !== R[r1].type) { typeSkipped++; continue; }
          const src = cellStateOf(`${C[c].id}:${R[r1].id}`);
          updates.push({ key: `${C[c].id}:${R[r].id}`, value: src.value, formula: src.formula || null, note: src.note || null, type: R[r].type });
        }
      }
    } else {
      if (c2 === c1) { notify('info', '请先选中多列(Shift+方向键或 Shift+点击)再向右填充'); return; }
      for (let c = c1 + 1; c <= c2; c++) {
        for (let r = r1; r <= r2; r++) {
          // 横向填充同行复制,无行类型差异,不做类型跳过
          const src = cellStateOf(`${C[c1].id}:${R[r].id}`);
          updates.push({ key: `${C[c].id}:${R[r].id}`, value: src.value, formula: src.formula || null, note: src.note || null, type: R[r].type });
        }
      }
    }
    const label = mode === 'down' ? '向下填充' : '向右填充';
    const res = applyCells(updates, label);
    const parts: string[] = [];
    if (res.written) parts.push(`已填充 ${res.written} 格`);
    if (res.skipped) parts.push(`跳过只读 ${res.skipped} 格`);
    if (typeSkipped) parts.push(`类型不匹配跳过 ${typeSkipped} 格`);
    if (parts.length === 0) parts.push('没有可填充的单元格');
    notify(res.written ? 'success' : 'warning', `${label}: ${parts.join('；')}`);
  }, [applyCells, cellStateOf, notify, selection]);

  /** 拖拽填充柄:从 from 格沿主轴填到 to 格 */
  const fillFromTo = useCallback((from: CellPos, to: CellPos) => {
    const R = rowsRef.current; const C = colsRef.current;
    const dr = Math.abs(to.r - from.r); const dc = Math.abs(to.c - from.c);
    const updates: CellUpdate[] = [];
    let typeSkipped = 0;
    if (dc >= dr) {
      const step = to.c >= from.c ? 1 : -1;
      for (let c = from.c + step; step > 0 ? c <= to.c : c >= to.c; c += step) {
        // 横向填充同行复制,无行类型差异,不做类型跳过
        const src = cellStateOf(`${C[from.c].id}:${R[from.r].id}`);
        updates.push({ key: `${C[c].id}:${R[from.r].id}`, value: src.value, formula: src.formula || null, note: src.note || null, type: R[from.r].type });
      }
    } else {
      const step = to.r >= from.r ? 1 : -1;
      for (let r = from.r + step; step > 0 ? r <= to.r : r >= to.r; r += step) {
        if (R[r].type !== R[from.r].type) { typeSkipped++; continue; }
        const src = cellStateOf(`${C[from.c].id}:${R[from.r].id}`);
        updates.push({ key: `${C[from.c].id}:${R[r].id}`, value: src.value, formula: src.formula || null, note: src.note || null, type: R[r].type });
      }
    }
    if (updates.length === 0 && typeSkipped === 0) return;
    const res = applyCells(updates, '拖拽填充');
    notify(res.written ? 'success' : 'warning', res.written ? `拖拽填充: 已填充 ${res.written} 格${typeSkipped ? `；类型不匹配跳过 ${typeSkipped} 格` : ''}` : '没有可填充的单元格');
    focusCell(to.r, to.c);
  }, [applyCells, cellStateOf, focusCell, notify]);

  /** 填充柄拖拽:由 state 驱动挂载 window mouseup(按 data-gr/data-gc 命中目标格),卸载时自动清理 */
  const [fillDrag, setFillDrag] = useState<CellPos | null>(null);
  const beginFillDrag = useCallback((e: ReactMouseEvent, r: number, c: number) => {
    e.preventDefault();
    e.stopPropagation();
    setFillDrag({ r, c });
  }, []);
  useEffect(() => {
    if (!fillDrag) return;
    const from = fillDrag;
    const onMouseUp = (ev: MouseEvent) => {
      setFillDrag(null);
      const el = document.elementFromPoint(ev.clientX, ev.clientY) as HTMLElement | null;
      const td = el?.closest('td[data-gr]') as HTMLTableCellElement | null;
      if (!td) return;
      const tr = Number(td.getAttribute('data-gr'));
      const tc = Number(td.getAttribute('data-gc'));
      if (Number.isNaN(tr) || Number.isNaN(tc)) return;
      if (tr === from.r && tc === from.c) return;
      fillFromTo(from, { r: tr, c: tc });
    };
    window.addEventListener('mouseup', onMouseUp);
    return () => window.removeEventListener('mouseup', onMouseUp);
  }, [fillDrag, fillFromTo]);

  /* ============ 粘贴引擎 ============ */
  const pasteText = useCallback((text: string, r: number, c: number, pasteOpts: PasteOptions = {}): PasteOutcome => {
    const R = rowsRef.current; const C = colsRef.current;
    let grid = parseClipboardGrid(text);
    if (pasteOpts.transpose) grid = transposeGrid(grid);
    const outcome: PasteOutcome = { written: 0, skipped: 0, typeSkipped: 0, invalid: 0, writtenKeys: [], writtenRows: 0, writtenCols: 0, outRows: 0, outCols: 0, firstInvalid: null };
    const updates: CellUpdate[] = [];
    grid.forEach((line, rOffset) => {
      const targetR = r + rOffset;
      if (targetR >= R.length) { outcome.outRows++; return; }
      outcome.outCols = Math.max(outcome.outCols, Math.max(0, c + line.length - C.length));
      line.forEach((rawCell, cOffset) => {
        const targetC = c + cOffset;
        if (targetC >= C.length) return;
        let val = cleanPastedValue(rawCell);
        if (pasteOpts.skipEmpty && val === '') return;
        const key = `${C[targetC].id}:${R[targetR].id}`;
        if (!optsRef.current.isCellEditable(R[targetR].id, C[targetC].id)) { outcome.skipped++; return; }
        updates.push({ key, value: val, formula: pasteOpts.valuesOnly ? undefined : null, type: R[targetR].type });
      });
    });
    const res = applyCells(updates, '批量粘贴');
    // 逐字段合并:outcome.skipped 已在上方按只读守卫累计,Object.assign 整体覆盖会将其清零
    outcome.written = res.written;
    outcome.skipped += res.skipped;
    outcome.typeSkipped += res.typeSkipped;
    outcome.invalid = res.invalid;
    outcome.writtenKeys = res.writtenKeys;
    // 统计真实写入的行列:applyCells 跳过"值未变化"的格,不应计入反馈
    const rowSet = new Set<number>();
    const colSet = new Set<number>();
    for (const key of res.writtenKeys) {
      const [colIdStr, rowIdStr] = key.split(':');
      const ri = R.findIndex((x) => x.id === Number(rowIdStr));
      const ci = C.findIndex((x) => x.id === Number(colIdStr));
      if (ri >= 0) rowSet.add(ri);
      if (ci >= 0) colSet.add(ci);
    }
    outcome.writtenRows = rowSet.size;
    outcome.writtenCols = colSet.size;
    // UX-23-5:按粘贴顺序找到首个格式非法格,供定位(焦点移动在 reportPaste 中完成)
    if (res.invalid > 0) {
      for (const k of res.writtenKeys) {
        if (!invalidCellsRef.current.has(k)) continue;
        const [colIdStr, rowIdStr] = k.split(':');
        const ri = R.findIndex((x) => x.id === Number(rowIdStr));
        const ci = C.findIndex((x) => x.id === Number(colIdStr));
        if (ri >= 0 && ci >= 0) outcome.firstInvalid = { r: ri, c: ci };
        break;
      }
    }
    return outcome;
  }, [applyCells]);

  const reportPaste = useCallback((o: PasteOutcome) => {
    const parts: string[] = [];
    if (o.written > 0) parts.push(`已写入 ${o.writtenRows} 行 × ${o.writtenCols} 列(共 ${o.written} 格)`);
    if (o.outRows > 0 || o.outCols > 0) parts.push(`越界忽略 ${o.outRows} 行 ${o.outCols} 列`);
    if (o.skipped > 0) parts.push(`跳过只读 ${o.skipped} 格`);
    if (o.invalid > 0) parts.push(`${o.invalid} 格格式非法已标红`);
    if (parts.length === 0) parts.push('剪贴板内容为空,未写入任何单元格');
    // UX-23-5:定位首个问题格,并明示整次粘贴可一步撤销
    if (o.firstInvalid) focusCell(o.firstInvalid.r, o.firstInvalid.c);
    if (o.invalid > 0) parts.push(o.firstInvalid ? '已定位首个格式错误格' : '可用网格内查找定位标红格');
    if (o.written > 0) parts.push('可 Ctrl+Z 撤销整次粘贴');
    notify(o.written > 0 ? (o.invalid > 0 ? 'warning' : 'success') : 'warning', `批量粘贴: ${parts.join('；')}`);
  }, [focusCell, notify]);

  const handleCellPaste = useCallback((e: ReactClipboardEvent<HTMLInputElement>, r: number, c: number) => {
    const text = e.clipboardData.getData('text');
    if (!text || (!text.includes('\t') && !text.includes('\n'))) return; // 单值粘贴保持原生行为
    e.preventDefault();
    reportPaste(pasteText(text, r, c));
  }, [pasteText, reportPaste]);

  /* ============ 批量复制(表格 -> Excel,TSV;Alt+C 含表头) ============ */
  const buildSelectionTsv = useCallback((withHeader: boolean): string | null => {
    const rect = selection;
    if (!rect) return null;
    const R = rowsRef.current; const C = colsRef.current;
    const lines: string[] = [];
    if (withHeader) lines.push(['科目\\组织', ...Array.from({ length: rect.c2 - rect.c1 + 1 }, (_, i) => C[rect.c1 + i]?.label ?? '')].join('\t'));
    for (let r = rect.r1; r <= rect.r2; r++) {
      const cells: string[] = [];
      if (withHeader) cells.push(R[r]?.label ?? '');
      for (let c = rect.c1; c <= rect.c2; c++) {
        cells.push(valuesRef.current.get(`${C[c].id}:${R[r].id}`) ?? '');
      }
      lines.push(cells.join('\t'));
    }
    return lines.join('\n');
  }, [selection]);

  const selectionSize = selection ? (selection.r2 - selection.r1 + 1) * (selection.c2 - selection.c1 + 1) : 0;

  /** 剪贴板事件不带修饰键,用全局按键状态跟踪 Alt(Alt+C = 复制含表头) */
  const altHeldRef = useRef(false);
  useEffect(() => {
    const track = (e: KeyboardEvent) => { if (e.key === 'Alt') altHeldRef.current = e.altKey; };
    const reset = () => { altHeldRef.current = false; };
    window.addEventListener('keydown', track);
    window.addEventListener('keyup', track);
    window.addEventListener('blur', reset);
    return () => {
      window.removeEventListener('keydown', track);
      window.removeEventListener('keyup', track);
      window.removeEventListener('blur', reset);
    };
  }, []);

  const handleCopy = useCallback((e: ReactClipboardEvent<HTMLInputElement>) => {
    if (selectionSize <= 1) return; // 单格复制保持原生行为
    const withHeader = altHeldRef.current;
    const tsv = buildSelectionTsv(withHeader);
    if (tsv == null) return;
    e.preventDefault();
    e.clipboardData.setData('text/plain', tsv);
    notify('success', `已复制 ${selection!.r2 - selection!.r1 + 1} 行 × ${selection!.c2 - selection!.c1 + 1} 列${withHeader ? '(含表头)' : ''},可直接粘贴到 Excel`);
  }, [buildSelectionTsv, notify, selection, selectionSize]);

  /** 右键菜单「复制」动作(无剪贴板事件,写剪贴板 API + 降级) */
  const copySelectionAsync = useCallback(async (withHeader: boolean) => {
    const tsv = buildSelectionTsv(withHeader);
    if (tsv == null || selectionSize <= 1) { notify('info', '请先选中要复制的区域(Shift+方向键或 Shift+点击)'); return; }
    try {
      await navigator.clipboard.writeText(tsv);
      notify('success', `已复制 ${selection!.r2 - selection!.r1 + 1} 行 × ${selection!.c2 - selection!.c1 + 1} 列${withHeader ? '(含表头)' : ''}`);
    } catch {
      const ta = document.createElement('textarea');
      ta.value = tsv;
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      document.body.removeChild(ta);
      notify(ok ? 'success' : 'warning', ok ? '已复制选区(TSV)' : '复制失败,请手动 Ctrl+C');
    }
  }, [buildSelectionTsv, notify, selection, selectionSize]);

  /** 右键菜单「粘贴到此处」:优先剪贴板 API,失败提示改用键盘粘贴 */
  const pasteAtActiveAsync = useCallback(async (pasteOpts: PasteOptions = {}) => {
    if (!active) { notify('info', '请先点击一个起始单元格'); return; }
    let text = '';
    try {
      text = await navigator.clipboard.readText();
    } catch {
      notify('warning', '浏览器限制无法读取剪贴板,请点击起始单元格后直接 Ctrl+V');
      return;
    }
    if (!text) { notify('info', '剪贴板为空'); return; }
    reportPaste(pasteText(text, active.r, active.c, pasteOpts));
  }, [active, notify, pasteText, reportPaste]);

  /* ============ 键盘路由(编辑态/导航态状态机) ============ */
  /** Shift+方向键扩展选区:只移动活动格与视口,不移动输入焦点(保持锚点与编辑上下文) */
  const extendSelection = useCallback((dr: number, dc: number) => {
    const prev = activeRef.current;
    if (!prev) return;
    const nr = Math.max(0, Math.min(rowsRef.current.length - 1, prev.r + dr));
    const nc = Math.max(0, Math.min(colsRef.current.length - 1, prev.c + dc));
    if (nr === prev.r && nc === prev.c) return;
    activeRef.current = { r: nr, c: nc };
    setActive({ r: nr, c: nc });
    const el = document.getElementById(optsRef.current.cellDomId(rowsRef.current[nr]?.id, colsRef.current[nc]?.id));
    if (el) el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }, []);

  const inputModified = useCallback((e: ReactKeyboardEvent<HTMLInputElement>): boolean => {
    const snap = editSnapshotRef.current;
    if (!snap) return false;
    return e.currentTarget.value !== snap.value;
  }, []);

  const handleCellKeyDown = useCallback((e: ReactKeyboardEvent<HTMLInputElement>, r: number, c: number) => {
    if (e.nativeEvent.isComposing) return; // 中文输入法候选框操作不触发导航
    const mod = e.ctrlKey || e.metaKey;
    const key = e.key;

    if (e.shiftKey && key === 'F2') { e.preventDefault(); optsRef.current.onOpenNote?.(rowsRef.current[r]?.id, colsRef.current[c]?.id); return; }

    if (mod && !e.altKey) {
      const lower = key.toLowerCase();
      if (lower === 'z' && !e.shiftKey) { e.preventDefault(); undo(); return; }
      if (lower === 'z' && e.shiftKey) { e.preventDefault(); redo(); return; }
      if (lower === 'y') { e.preventDefault(); redo(); return; }
      if (lower === 'd') { e.preventDefault(); fillBy('down'); return; }
      if (lower === 'r') { e.preventDefault(); fillBy('right'); return; }
      if (lower === 'f') { e.preventDefault(); optsRef.current.onOpenFind?.('find'); return; }
      if (lower === 'h') { e.preventDefault(); optsRef.current.onOpenFind?.('replace'); return; }
      if (key === 'Home' || key === 'End') {
        e.preventDefault();
        focusCell(key === 'Home' ? 0 : rowsRef.current.length - 1, key === 'Home' ? 0 : colsRef.current.length - 1);
        return;
      }
      if (key === 'ArrowDown' || key === 'ArrowUp' || key === 'ArrowLeft' || key === 'ArrowRight') {
        e.preventDefault();
        commitCell(r, c);
        jumpEdge(r, c, key === 'ArrowDown' ? 1 : key === 'ArrowUp' ? -1 : 0, key === 'ArrowRight' ? 1 : key === 'ArrowLeft' ? -1 : 0);
        return;
      }
      return; // 其余 Ctrl 组合(复制等)走原生
    }
    if (mod && e.altKey && key.toLowerCase() === 'v') { e.preventDefault(); optsRef.current.onOpenPasteSpecial?.(); return; }

    switch (key) {
      case 'Escape':
        e.preventDefault();
        cancelEdit();
        return;
      case 'Enter':
        e.preventDefault();
        commitCell(r, c);
        moveFocus(r, c, e.shiftKey ? -1 : 1, 0);
        return;
      case 'Tab': {
        e.preventDefault();
        commitCell(r, c);
        if (colsRef.current.length > 1) moveFocus(r, c, 0, e.shiftKey ? -1 : 1, true);
        else moveFocus(r, c, e.shiftKey ? -1 : 1, 0);
        return;
      }
      case 'ArrowDown': case 'ArrowUp':
        e.preventDefault();
        if (e.shiftKey) { extendSelection(key === 'ArrowDown' ? 1 : -1, 0); return; }
        commitCell(r, c);
        moveFocus(r, c, key === 'ArrowDown' ? 1 : -1, 0);
        return;
      case 'ArrowRight': case 'ArrowLeft': {
        if (e.shiftKey) { e.preventDefault(); extendSelection(0, key === 'ArrowRight' ? 1 : -1); return; }
        const el = e.currentTarget;
        const atEnd = el.selectionStart === el.value.length && el.selectionEnd === el.value.length;
        const atStart = el.selectionStart === 0 && el.selectionEnd === 0;
        if ((key === 'ArrowRight' && atEnd) || (key === 'ArrowLeft' && atStart)) {
          e.preventDefault();
          commitCell(r, c);
          moveFocus(r, c, 0, key === 'ArrowRight' ? 1 : -1);
        }
        return; // 光标在文本中间时移动光标(编辑态)
      }
      case 'Home': case 'End': {
        if (inputModified(e)) return; // 编辑态保持原生光标移动
        e.preventDefault();
        commitCell(r, c);
        focusCell(r, key === 'Home' ? 0 : colsRef.current.length - 1);
        return;
      }
      case 'PageUp': case 'PageDown': {
        if (inputModified(e)) return;
        e.preventDefault();
        commitCell(r, c);
        const target = Math.max(0, Math.min(rowsRef.current.length - 1, r + (key === 'PageDown' ? 12 : -12)));
        moveFocus(target, c, target > r ? 1 : target < r ? -1 : 0, 0);
        return;
      }
      case 'Delete': case 'Backspace': {
        if (selectionSize > 1) { e.preventDefault(); clearSelectionValues(false); return; }
        if (!inputModified(e) && e.currentTarget.value !== '') {
          e.preventDefault();
          clearSelectionValues(false); // 未修改态 Delete 清格(Excel 手感)
        }
        return; // 编辑态走原生文本删除;空格上按 Delete 无动作
      }
      default:
        return;
    }
  }, [cancelEdit, clearSelectionValues, commitCell, extendSelection, fillBy, focusCell, inputModified, jumpEdge, moveFocus, redo, selectionSize, undo]);

  /* ============ 选区聚合统计 ============ */
  const selectionStats: SelectionStats | null = useMemo(() => {
    if (!selection) return null;
    const R = geometry.rows; const C = geometry.cols;
    const stats: SelectionStats = { count: 0, nonEmpty: 0, moneyCount: 0, qtyCount: 0, invalidCount: 0, sum: 0, directional: 0, avg: null };
    for (let r = selection.r1; r <= selection.r2; r++) {
      for (let c = selection.c1; c <= selection.c2; c++) {
        stats.count++;
        const key = `${C[c]?.id}:${R[r]?.id}`;
        const raw = (values.get(key) ?? '').trim();
        if (raw === '') continue;
        stats.nonEmpty++;
        if (invalidCells.has(key)) { stats.invalidCount++; continue; }
        const num = Number(raw.replace(/,/g, ''));
        if (Number.isNaN(num)) { stats.invalidCount++; continue; }
        const type = R[r]?.type ?? 'expense';
        if (type === 'quantity') stats.qtyCount++;
        else { stats.moneyCount++; stats.sum += num; stats.directional += num * signOfType(type); }
      }
    }
    stats.avg = stats.moneyCount > 0 ? stats.sum / stats.moneyCount : null;
    return stats;
  }, [selection, geometry, values, invalidCells]);

  /* ============ 网格内查找/替换 ============ */
  const findMatches = useCallback((query: string, scopes: { label?: boolean; value?: boolean; formula?: boolean; note?: boolean }): FindMatch[] => {
    const q = query.trim().toLowerCase();
    if (!q) return [];
    const out: FindMatch[] = [];
    geometry.rows.forEach((row, r) => {
      geometry.cols.forEach((col, c) => {
        const key = `${col.id}:${row.id}`;
        if (scopes.label !== false && row.label.toLowerCase().includes(q)) {
          out.push({ r, c, key, kind: 'label', preview: `${col.label} · ${row.label}` });
          return;
        }
        const val = (valuesRef.current.get(key) ?? '').trim();
        if (scopes.value !== false && val.toLowerCase().includes(q)) {
          out.push({ r, c, key, kind: 'value', preview: `${col.label} · ${row.label} = ${val}` });
          return;
        }
        const f = (formulasRef.current.get(key) ?? '').trim();
        if (scopes.formula && f.toLowerCase().includes(q)) {
          out.push({ r, c, key, kind: 'formula', preview: `${col.label} · ${row.label} 公式 ${f}` });
          return;
        }
        const n = (notesRef.current.get(key) ?? '').trim();
        if (scopes.note && n.toLowerCase().includes(q)) {
          out.push({ r, c, key, kind: 'note', preview: `${col.label} · ${row.label} 附注 ${n.slice(0, 50)}` });
        }
      });
    });
    return out;
  }, [geometry]);

  const jumpToMatch = useCallback((m: FindMatch) => {
    focusCell(m.r, m.c);
  }, [focusCell]);

  /** 替换预览命中的格(值/公式/附注均按命中类型替换子串,与 Excel 查找替换语义一致) */
  const replaceMatches = useCallback((matches: FindMatch[], replacement: string, query: string): number => {
    const updates: CellUpdate[] = [];
    const re = new RegExp(escapeRegExp(query), 'gi');
    for (const m of matches) {
      if (m.kind === 'label') continue;
      const rowId = Number(m.key.split(':')[1]);
      const type = typeOfRow(rowId);
      if (m.kind === 'value') {
        if (replacement === '') { updates.push({ key: m.key, value: '', formula: null, type }); continue; }
        const old = valuesRef.current.get(m.key) ?? '';
        const next = old.replace(re, replacement);
        if (next !== old) updates.push({ key: m.key, value: next, formula: null, type });
      } else if (m.kind === 'formula') {
        const old = formulasRef.current.get(m.key) ?? '';
        const next = old.replace(re, replacement);
        if (next !== old) updates.push({ key: m.key, value: next, type });
      } else if (m.kind === 'note') {
        const old = notesRef.current.get(m.key) ?? '';
        const next = old.replace(re, replacement);
        if (next !== old) updates.push({ key: m.key, note: next, type });
      }
    }
    const res = applyCells(updates, '替换');
    return res.written;
  }, [applyCells, typeOfRow]);

  /* ============ 焦点位置记忆(sessionStorage) ============ */
  useEffect(() => {
    if (!opts.persistKey || !active) return;
    try {
      const rowId = rowsRef.current[active.r]?.id;
      const colId = colsRef.current[active.c]?.id;
      if (rowId != null && colId != null) {
        sessionStorage.setItem(`${opts.persistKey}:gridpos`, JSON.stringify({ rowId, colId }));
      }
    } catch { /* 忽略存储异常 */ }
  }, [active, opts.persistKey]);

  const restoreFocus = useCallback(() => {
    if (!opts.persistKey) return;
    try {
      const raw = readBrowserStorage(sessionStorage, `${opts.persistKey}:gridpos`);
      if (!raw) return;
      const { rowId, colId } = JSON.parse(raw) as { rowId: number; colId: number };
      const r = rowsRef.current.findIndex((x) => x.id === rowId);
      const c = colsRef.current.findIndex((x) => x.id === colId);
      if (r >= 0 && c >= 0) focusCell(r, c);
    } catch { /* 忽略 */ }
  }, [focusCell, opts.persistKey]);

  const activeIds = useMemo(() => {
    if (!active) return null;
    const row = geometry.rows[active.r]; const col = geometry.cols[active.c];
    if (!row || !col) return null;
    return { rowId: row.id, colId: col.id, rowLabel: row.label, colLabel: col.label };
  }, [active, geometry]);

  return {
    // 数据
    values, formulas, notes, invalidCells,
    dirty: dirtyCells.size > 0, dirtyCount: dirtyCells.size,
    /** 脏单元格键集合(`${colId}:${rowId}`)：助手草稿序列化只取这些格子(§5.7)。 */
    dirtyKeys: dirtyCells,
    // 焦点/选区
    active, activeIds, selection, isInSelection, selectionSize,
    formulaPreview,
    // 写入
    applyCells, setCellInput, commitCell, cancelEdit,
    resetData, markSaved, markPersisted, markClean,
    // 撤销
    undo, redo, canUndo: undoDepth > 0, canRedo: redoDepth > 0, undoDepth,
    /** 外部编辑(汇总格备注)入统一撤销栈(UX-23-6) */
    pushExternalUndo,
    // 事件挂载
    handleCellFocus, handleCellMouseDown, handleCellKeyDown, handleCellPaste, handleCopy,
    // 批量操作
    clearSelectionValues, fillBy, fillDown: () => fillBy('down'), fillRight: () => fillBy('right'),
    beginFillDrag,
    // 粘贴/复制
    pasteText, reportPaste, copySelectionAsync, pasteAtActiveAsync, buildSelectionTsv,
    // 统计与查找
    selectionStats, findMatches, jumpToMatch, replaceMatches, extendSelection,
    // 导航
    focusCell, moveFocus, jumpEdge,
    // 位置记忆
    restoreFocus,
  };
}

export type GridInteraction = ReturnType<typeof useGridInteraction>;
