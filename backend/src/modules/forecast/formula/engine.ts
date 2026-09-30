/**
 * 预测工作簿求值引擎(T-5,AC-F11)。纯计算:不读写库,由 Worker 调用。
 *
 * - 数值为 bigint 定点(18 位,乘除 HALF_UP);^ 只支持整数指数。
 * - 只计算输出单元格的依赖闭包:建依赖图 → 拓扑排序(Kahn)→ 按序求值;剩余节点即循环引用。
 * - 步数上限(节点求值 + 区域读取)防止失控计算,超出抛 ResourceLimitError。
 */
import {
  type Fx, FX_ONE, FX_ZERO, abs, div, divRound, fx, mul, powInt, quantize, toFixed, FX_SCALE,
} from '../../../core/fixed';
import { npvExact, irr } from '../../investment/feasibility-calc';
import { type Ast, type ErrorCode, cellAddress, collectRefs, parseCellAddress, parseFormula, ERROR_CODES, type FormulaIssue } from './parser';

export type CellInput = { f: string } | { n: string } | { s: string } | { b: boolean } | { e: ErrorCode };
export interface WorkbookJson { sheets: { name: string; cells: Record<string, CellInput> }[] }

export type Val =
  | { t: 'n'; v: Fx }
  | { t: 's'; v: string }
  | { t: 'b'; v: boolean }
  | { t: 'e'; v: ErrorCode }
  | { t: 'blank' };
type Matrix = { rows: number; cols: number; get(r: number, c: number): Val };
type Arg = Val | Matrix;

export const MAX_SHEETS = 50;
export const MAX_CELLS = 200_000;
const MAX_RANGE_CELLS = 1_000_000;

export class CycleError extends Error { constructor(readonly cells: string[]) { super(`存在循环引用:${cells.slice(0, 10).join('、')}`); } }
export class ResourceLimitError extends Error {}

const BLANK: Val = { t: 'blank' };
const E = (v: ErrorCode): Val => ({ t: 'e', v });
const N = (v: Fx): Val => ({ t: 'n', v });
const isMatrix = (a: Arg): a is Matrix => (a as Matrix).get !== undefined;

// 键:(sheet * 2^20 + row) * 2^14 + col,sheet ≤ 50 时在安全整数内
const key = (s: number, r: number, c: number) => (s * 1_048_576 + r) * 16_384 + c;

interface CompiledCell { s: number; r: number; c: number; input: CellInput; ast?: Ast | null; issues?: FormulaIssue[] }

export interface CompiledWorkbook {
  sheetNames: string[];
  sheetIndex: Map<string, number>;
  cells: Map<number, CompiledCell>;
  /** 每个工作表的单元格键,用于大区域按已有单元格迭代 */
  sheetCells: number[][];
}

export function compileWorkbook(wb: WorkbookJson): CompiledWorkbook {
  const sheetNames = wb.sheets.map((s) => s.name);
  const sheetIndex = new Map(sheetNames.map((n, i) => [n.toLowerCase(), i]));
  const cells = new Map<number, CompiledCell>();
  const sheetCells: number[][] = sheetNames.map(() => []);
  wb.sheets.forEach((sheet, s) => {
    for (const [addr, input] of Object.entries(sheet.cells)) {
      const a = parseCellAddress(addr);
      if (!a) continue;
      const k = key(s, a.row, a.col);
      const cell: CompiledCell = { s, r: a.row, c: a.col, input };
      if ('f' in input) {
        const p = parseFormula(input.f);
        cell.ast = p.ast;
        cell.issues = p.issues;
      }
      cells.set(k, cell);
      sheetCells[s].push(k);
    }
  });
  return { sheetNames, sheetIndex, cells, sheetCells };
}

export const cellLabel = (wb: CompiledWorkbook, k: number) => {
  const c = k % 16_384;
  const r = Math.floor(k / 16_384) % 1_048_576;
  const s = Math.floor(k / 16_384 / 1_048_576);
  return `${wb.sheetNames[s]}!${cellAddress(r, c)}`;
};

/** 引用所在工作表索引;未知工作表返回 -1。 */
function refSheet(wb: CompiledWorkbook, from: number, sheet: string | null): number {
  if (sheet == null) return from;
  return wb.sheetIndex.get(sheet.toLowerCase()) ?? -1;
}

/** 公式单元格的直接依赖(只含公式单元格;常量无需排序)。 */
function dependencies(wb: CompiledWorkbook, cell: CompiledCell): number[] {
  if (!cell.ast) return [];
  const out: number[] = [];
  for (const ref of collectRefs(cell.ast)) {
    const s = refSheet(wb, cell.s, ref.sheet);
    if (s < 0) continue;
    if (ref.k === 'ref') {
      const k = key(s, ref.row, ref.col);
      if (wb.cells.get(k)?.ast !== undefined) out.push(k);
      continue;
    }
    const area = (ref.r2 - ref.r1 + 1) * (ref.c2 - ref.c1 + 1);
    if (area <= wb.sheetCells[s].length) {
      for (let r = ref.r1; r <= ref.r2; r += 1) for (let c = ref.c1; c <= ref.c2; c += 1) {
        const k = key(s, r, c);
        if (wb.cells.get(k)?.ast !== undefined) out.push(k);
      }
    } else {
      for (const k of wb.sheetCells[s]) {
        const x = wb.cells.get(k)!;
        if (x.ast !== undefined && x.r >= ref.r1 && x.r <= ref.r2 && x.c >= ref.c1 && x.c <= ref.c2) out.push(k);
      }
    }
  }
  return out;
}

/** 拓扑排序给定公式单元格集合(roots 的依赖闭包);有环抛 CycleError。 */
export function evaluationOrder(wb: CompiledWorkbook, roots: number[]): number[] {
  const deps = new Map<number, number[]>();
  const stack = roots.filter((k) => wb.cells.get(k)?.ast !== undefined);
  while (stack.length) {
    const k = stack.pop()!;
    if (deps.has(k)) continue;
    const d = dependencies(wb, wb.cells.get(k)!);
    deps.set(k, d);
    for (const x of d) if (!deps.has(x)) stack.push(x);
  }
  const indeg = new Map<number, number>();
  const users = new Map<number, number[]>();
  for (const [k, d] of deps) {
    indeg.set(k, d.length);
    for (const x of d) {
      const list = users.get(x);
      if (list) list.push(k); else users.set(x, [k]);
    }
  }
  const queue = [...deps.keys()].filter((k) => indeg.get(k) === 0);
  const order: number[] = [];
  while (queue.length) {
    const k = queue.pop()!;
    order.push(k);
    for (const u of users.get(k) ?? []) {
      const n = indeg.get(u)! - 1;
      indeg.set(u, n);
      if (n === 0) queue.push(u);
    }
  }
  if (order.length < deps.size) {
    const left = [...deps.keys()].filter((k) => indeg.get(k)! > 0);
    throw new CycleError(left.map((k) => cellLabel(wb, k)));
  }
  return order;
}

/** 全部公式单元格的环检测(诊断用)。 */
export function findCycle(wb: CompiledWorkbook): string[] | null {
  const all = [...wb.cells.entries()].filter(([, c]) => c.ast !== undefined).map(([k]) => k);
  try { evaluationOrder(wb, all); return null; } catch (e) { if (e instanceof CycleError) return e.cells; throw e; }
}

// ---------------- 值转换 ----------------

export function inputValue(input: CellInput): Val {
  if ('n' in input) return N(fx(input.n));
  if ('s' in input) return { t: 's', v: input.s };
  if ('b' in input) return { t: 'b', v: input.b };
  if ('e' in input) return E(input.e);
  return BLANK;
}

const NUMERIC_TEXT = /^[+-]?(\d+(\.\d*)?|\.\d+)$/;
function toNumber(v: Val): Fx | ErrorCode {
  switch (v.t) {
    case 'n': return v.v;
    case 'b': return v.v ? FX_ONE : FX_ZERO;
    case 'blank': return FX_ZERO;
    case 'e': return v.v;
    case 's': {
      const t = v.v.trim();
      if (t === '') return FX_ZERO;
      if (NUMERIC_TEXT.test(t)) return fx(t);
      if (/^[+-]?(\d+(\.\d*)?|\.\d+)%$/.test(t)) return div(fx(t.slice(0, -1)), fx(100));
      return '#VALUE!';
    }
    default: return '#VALUE!';
  }
}
function toBool(v: Val): boolean | ErrorCode {
  switch (v.t) {
    case 'b': return v.v;
    case 'n': return v.v !== FX_ZERO;
    case 'blank': return false;
    case 'e': return v.v;
    case 's': {
      const t = v.v.trim().toUpperCase();
      if (t === 'TRUE') return true;
      if (t === 'FALSE') return false;
      return '#VALUE!';
    }
    default: return '#VALUE!';
  }
}
/** 定点 → 最短十进制文本(去尾零)。 */
export function fxText(v: Fx): string {
  const s = toFixed(v, FX_SCALE);
  return s.includes('.') ? s.replace(/0+$/, '').replace(/\.$/, '') : s;
}
function toText(v: Val): string | ErrorCode {
  switch (v.t) {
    case 's': return v.v;
    case 'n': return fxText(v.v);
    case 'b': return v.v ? 'TRUE' : 'FALSE';
    case 'blank': return '';
    case 'e': return v.v;
    default: return '';
  }
}
const isErr = (x: unknown): x is ErrorCode => typeof x === 'string' && (ERROR_CODES as readonly string[]).includes(x);

function compare(a: Val, b: Val): number {
  // Excel:数字 < 文本 < 逻辑值;空单元格按对方类型取 0 / "" / FALSE
  const norm = (x: Val, other: Val): Val => (x.t !== 'blank' ? x : other.t === 's' ? { t: 's', v: '' } : other.t === 'b' ? { t: 'b', v: false } : N(FX_ZERO));
  const x = norm(a, b);
  const y = norm(b, a);
  const rank = (v: Val) => (v.t === 'n' ? 0 : v.t === 's' ? 1 : 2);
  if (rank(x) !== rank(y)) return rank(x) - rank(y);
  if (x.t === 'n' && y.t === 'n') return x.v === y.v ? 0 : x.v < y.v ? -1 : 1;
  if (x.t === 's' && y.t === 's') { const p = x.v.toLowerCase(); const q = y.v.toLowerCase(); return p === q ? 0 : p < q ? -1 : 1; }
  if (x.t === 'b' && y.t === 'b') return Number(x.v) - Number(y.v);
  return 0;
}

// ---------------- 求值 ----------------

export interface EvalContext {
  wb: CompiledWorkbook;
  values: Map<number, Val>;
  steps: number;
  maxSteps: number;
  /** 参数覆盖:单元格键 → 值 */
  overrides: Map<number, Val>;
}

function tick(ctx: EvalContext, n = 1): void {
  ctx.steps += n;
  if (ctx.steps > ctx.maxSteps) throw new ResourceLimitError(`计算步数超过上限 ${ctx.maxSteps}`);
}

export function cellValue(ctx: EvalContext, k: number): Val {
  const o = ctx.overrides.get(k);
  if (o) return o;
  const cell = ctx.wb.cells.get(k);
  if (!cell) return BLANK;
  if (cell.ast !== undefined) return ctx.values.get(k) ?? BLANK;
  return inputValue(cell.input);
}

function rangeMatrix(ctx: EvalContext, s: number, r1: number, c1: number, r2: number, c2: number): Matrix | Val {
  if (s < 0) return E('#REF!');
  const rows = r2 - r1 + 1;
  const cols = c2 - c1 + 1;
  if (rows * cols > MAX_RANGE_CELLS) throw new ResourceLimitError('区域过大');
  tick(ctx, rows * cols);
  return { rows, cols, get: (r, c) => cellValue(ctx, key(s, r1 + r, c1 + c)) };
}

function evalArg(ctx: EvalContext, ast: Ast, sheet: number): Arg {
  if (ast.k === 'range') return rangeMatrix(ctx, refSheet(ctx.wb, sheet, ast.sheet), ast.r1, ast.c1, ast.r2, ast.c2);
  return evalNode(ctx, ast, sheet);
}

function scalar(a: Arg): Val {
  if (!isMatrix(a)) return a;
  return a.rows === 1 && a.cols === 1 ? a.get(0, 0) : E('#VALUE!');
}

export function evalNode(ctx: EvalContext, ast: Ast, sheet: number): Val {
  tick(ctx);
  switch (ast.k) {
    case 'num': return N(ast.v);
    case 'str': return { t: 's', v: ast.v };
    case 'bool': return { t: 'b', v: ast.v };
    case 'err': return E(ast.v);
    case 'ref': {
      const s = refSheet(ctx.wb, sheet, ast.sheet);
      return s < 0 ? E('#REF!') : cellValue(ctx, key(s, ast.row, ast.col));
    }
    case 'range': return scalar(evalArg(ctx, ast, sheet));
    case 'un': {
      const v = toNumber(evalNode(ctx, ast.a, sheet));
      if (isErr(v)) return E(v);
      return N(ast.op === '-' ? -v : v);
    }
    case 'pct': {
      const v = toNumber(evalNode(ctx, ast.a, sheet));
      return isErr(v) ? E(v) : N(div(v, fx(100)));
    }
    case 'bin': return evalBinary(ctx, ast.op, evalNode(ctx, ast.a, sheet), evalNode(ctx, ast.b, sheet));
    case 'fn': return evalFunction(ctx, ast.name, ast.args, sheet);
    default: return E('#VALUE!');
  }
}

function evalBinary(_ctx: EvalContext, op: string, a: Val, b: Val): Val {
  if (a.t === 'e') return a;
  if (b.t === 'e') return b;
  if (op === '&') {
    const x = toText(a);
    const y = toText(b);
    return { t: 's', v: `${x}${y}` };
  }
  if (['=', '<>', '<', '>', '<=', '>='].includes(op)) {
    const c = compare(a, b);
    const r = op === '=' ? c === 0 : op === '<>' ? c !== 0 : op === '<' ? c < 0 : op === '>' ? c > 0 : op === '<=' ? c <= 0 : c >= 0;
    return { t: 'b', v: r };
  }
  const x = toNumber(a);
  if (isErr(x)) return E(x);
  const y = toNumber(b);
  if (isErr(y)) return E(y);
  switch (op) {
    case '+': return N(x + y);
    case '-': return N(x - y);
    case '*': return N(mul(x, y));
    case '/': return y === FX_ZERO ? E('#DIV/0!') : N(div(x, y));
    case '^': {
      if (y % FX_ONE !== 0n) return E('#NUM!');
      const e = y / FX_ONE;
      if (e > 10_000n || e < -10_000n) return E('#NUM!');
      if (x === FX_ZERO && e <= 0n) return E(e === 0n ? '#NUM!' : '#DIV/0!');
      try { return N(powInt(x, Number(e))); } catch { return E('#NUM!'); }
    }
    default: return E('#VALUE!');
  }
}

/** 逐个展开参数中的数值:区域内只取数字(忽略文本/逻辑/空),直接参数强制转换。 */
function collectNumbers(ctx: EvalContext, args: Ast[], sheet: number): Fx[] | ErrorCode {
  const out: Fx[] = [];
  for (const a of args) {
    const v = evalArg(ctx, a, sheet);
    if (isMatrix(v)) {
      for (let r = 0; r < v.rows; r += 1) for (let c = 0; c < v.cols; c += 1) {
        const x = v.get(r, c);
        if (x.t === 'e') return x.v;
        if (x.t === 'n') out.push(x.v);
      }
    } else {
      if (v.t === 'blank') continue;
      const n = toNumber(v);
      if (isErr(n)) return n;
      out.push(n);
    }
  }
  return out;
}

function roundTo(x: Fx, digits: Fx | ErrorCode, mode: 'half' | 'up' | 'down'): Val {
  if (isErr(digits)) return E(digits);
  const d = Number(digits / FX_ONE);
  if (d >= FX_SCALE) return N(x);
  if (d < -15) return N(FX_ZERO);
  if (mode === 'half') return N(quantize(x, d));
  const unit = 10n ** BigInt(FX_SCALE - d);
  const q = x / unit; // 向零截断
  if (mode === 'down' || x % unit === 0n) return N(q * unit);
  return N((q + (x < 0n ? -1n : 1n)) * unit);
}

function evalFunction(ctx: EvalContext, name: string, args: Ast[], sheet: number): Val {
  const arity = (min: number, max: number) => args.length >= min && args.length <= max;
  const num = (i: number): Fx | ErrorCode => toNumber(scalar(evalArg(ctx, args[i], sheet)));
  switch (name) {
    case 'SUM': {
      const xs = collectNumbers(ctx, args, sheet);
      return isErr(xs) ? E(xs) : N(xs.reduce((s, x) => s + x, FX_ZERO));
    }
    case 'AVERAGE': {
      const xs = collectNumbers(ctx, args, sheet);
      if (isErr(xs)) return E(xs);
      if (!xs.length) return E('#DIV/0!');
      return N(divRound(xs.reduce((s, x) => s + x, FX_ZERO), BigInt(xs.length)));
    }
    case 'MIN': case 'MAX': {
      const xs = collectNumbers(ctx, args, sheet);
      if (isErr(xs)) return E(xs);
      if (!xs.length) return N(FX_ZERO);
      return N(xs.reduce((m, x) => (name === 'MIN' ? (x < m ? x : m) : (x > m ? x : m))));
    }
    case 'COUNT': {
      let n = 0;
      for (const a of args) {
        const v = evalArg(ctx, a, sheet);
        if (isMatrix(v)) { for (let r = 0; r < v.rows; r += 1) for (let c = 0; c < v.cols; c += 1) if (v.get(r, c).t === 'n') n += 1; }
        else if (v.t === 'n' || v.t === 'b' || (v.t === 's' && NUMERIC_TEXT.test(v.v.trim()))) n += 1;
      }
      return N(BigInt(n) * FX_ONE);
    }
    case 'ABS': {
      if (!arity(1, 1)) return E('#VALUE!');
      const x = num(0);
      return isErr(x) ? E(x) : N(abs(x));
    }
    case 'ROUND': case 'ROUNDUP': case 'ROUNDDOWN': {
      if (!arity(1, 2)) return E('#VALUE!');
      const x = num(0);
      if (isErr(x)) return E(x);
      return roundTo(x, args.length > 1 ? num(1) : FX_ZERO, name === 'ROUND' ? 'half' : name === 'ROUNDUP' ? 'up' : 'down');
    }
    case 'IF': {
      if (!arity(1, 3)) return E('#VALUE!');
      const c = toBool(scalar(evalArg(ctx, args[0], sheet)));
      if (isErr(c)) return E(c);
      if (c) return args.length > 1 ? scalar(evalArg(ctx, args[1], sheet)) : { t: 'b', v: true };
      return args.length > 2 ? scalar(evalArg(ctx, args[2], sheet)) : { t: 'b', v: false };
    }
    case 'IFERROR': {
      if (!arity(2, 2)) return E('#VALUE!');
      const v = scalar(evalArg(ctx, args[0], sheet));
      return v.t === 'e' ? scalar(evalArg(ctx, args[1], sheet)) : v;
    }
    case 'AND': case 'OR': {
      if (!args.length) return E('#VALUE!');
      const bools: boolean[] = [];
      for (const a of args) {
        const v = evalArg(ctx, a, sheet);
        if (isMatrix(v)) {
          for (let r = 0; r < v.rows; r += 1) for (let c = 0; c < v.cols; c += 1) {
            const x = v.get(r, c);
            if (x.t === 'e') return x;
            if (x.t === 'n' || x.t === 'b') bools.push(toBool(x) as boolean);
          }
        } else {
          const b = toBool(v);
          if (isErr(b)) return E(b);
          bools.push(b);
        }
      }
      if (!bools.length) return E('#VALUE!');
      return { t: 'b', v: name === 'AND' ? bools.every(Boolean) : bools.some(Boolean) };
    }
    case 'NOT': {
      if (!arity(1, 1)) return E('#VALUE!');
      const b = toBool(scalar(evalArg(ctx, args[0], sheet)));
      return isErr(b) ? E(b) : { t: 'b', v: !b };
    }
    case 'SUMPRODUCT': {
      if (!args.length) return E('#VALUE!');
      const ms = args.map((a) => evalArg(ctx, a, sheet));
      const shape = ms.map((m) => (isMatrix(m) ? [m.rows, m.cols] : [1, 1]));
      if (shape.some((s) => s[0] !== shape[0][0] || s[1] !== shape[0][1])) return E('#VALUE!');
      let total = FX_ZERO;
      for (let r = 0; r < shape[0][0]; r += 1) for (let c = 0; c < shape[0][1]; c += 1) {
        let p = FX_ONE;
        for (const m of ms) {
          const x = isMatrix(m) ? m.get(r, c) : m;
          if (x.t === 'e') return x;
          p = mul(p, x.t === 'n' ? x.v : FX_ZERO);
        }
        total += p;
      }
      tick(ctx, shape[0][0] * shape[0][1]);
      return N(total);
    }
    case 'NPV': {
      if (args.length < 2) return E('#VALUE!');
      const rate = num(0);
      if (isErr(rate)) return E(rate);
      const xs = collectNumbers(ctx, args.slice(1), sheet);
      if (isErr(xs)) return E(xs);
      if (rate <= -FX_ONE) return E('#NUM!');
      tick(ctx, xs.length * 4);
      return N(npvExact(xs, rate));
    }
    case 'IRR': {
      if (!arity(1, 2)) return E('#VALUE!');
      const xs = collectNumbers(ctx, [args[0]], sheet);
      if (isErr(xs)) return E(xs);
      tick(ctx, xs.length * 400);
      const r = irr(xs);
      return r.status === 'success' && r.value != null ? N(r.value) : E('#NUM!');
    }
    case 'PMT': {
      if (!arity(3, 5)) return E('#VALUE!');
      const rate = num(0); const nper = num(1); const pv = num(2);
      const fv = args.length > 3 ? num(3) : FX_ZERO;
      const type = args.length > 4 ? num(4) : FX_ZERO;
      for (const x of [rate, nper, pv, fv, type]) if (isErr(x)) return E(x);
      const [r, n, p, f, t] = [rate, nper, pv, fv, type] as Fx[];
      if (n === FX_ZERO) return E('#NUM!');
      if (r === FX_ZERO) return N(-div(p + f, n));
      if (n % FX_ONE !== 0n) return E('#NUM!');
      const g = powInt(FX_ONE + r, Number(n / FX_ONE));
      const denom = mul(FX_ONE + (t !== FX_ZERO ? r : FX_ZERO), g - FX_ONE);
      if (denom === FX_ZERO) return E('#NUM!');
      return N(-div(mul(r, f + mul(p, g)), denom));
    }
    default: return E('#NAME?');
  }
}

// ---------------- 运行入口 ----------------

export interface RunInput {
  workbook: WorkbookJson;
  /** 参数覆盖:Sheet!A1 → 十进制字符串 */
  overrides: Record<string, string>;
  /** 输出:key → 单元格或一行区域 */
  outputs: { key: string; ref: string }[];
  maxSteps: number;
}
export type RunOutput =
  | { ok: true; outputs: Record<string, string[]>; steps: number }
  | { ok: false; code: 'FORECAST_CYCLE' | 'FORECAST_FORMULA_ERROR' | 'FORECAST_RESOURCE_LIMIT' | 'FORECAST_PARAM_INVALID'; message: string; diagnostics: unknown[] };

/** 解析 "Sheet!B5" 或 "Sheet!B5:F5"(只允许一行)。 */
export function parseRef(wb: CompiledWorkbook, ref: string): { s: number; row: number; c1: number; c2: number } | null {
  const m = /^(?:'((?:[^']|'')+)'|([^!]+))!(\$?[A-Za-z]{1,3}\$?\d+)(?::(\$?[A-Za-z]{1,3}\$?\d+))?$/.exec(ref.trim());
  if (!m) return null;
  const s = wb.sheetIndex.get((m[1] ?? m[2]).replace(/''/g, "'").toLowerCase());
  const a = parseCellAddress(m[3]);
  const b = m[4] ? parseCellAddress(m[4]) : a;
  if (s == null || !a || !b || a.row !== b.row) return null;
  return { s, row: a.row, c1: Math.min(a.col, b.col), c2: Math.max(a.col, b.col) };
}

export function runWorkbook(input: RunInput): RunOutput {
  const wb = compileWorkbook(input.workbook);
  const overrides = new Map<number, Val>();
  for (const [ref, value] of Object.entries(input.overrides)) {
    const p = parseRef(wb, ref);
    if (!p || p.c1 !== p.c2) return { ok: false, code: 'FORECAST_PARAM_INVALID', message: `参数单元格无效 ${ref}`, diagnostics: [] };
    overrides.set(key(p.s, p.row, p.c1), N(fx(value)));
  }
  const targets: { key: string; cells: number[] }[] = [];
  for (const o of input.outputs) {
    const p = parseRef(wb, o.ref);
    if (!p) return { ok: false, code: 'FORECAST_FORMULA_ERROR', message: `输出单元格无效 ${o.ref}`, diagnostics: [{ output: o.key, ref: o.ref, error: '#REF!' }] };
    targets.push({ key: o.key, cells: Array.from({ length: p.c2 - p.c1 + 1 }, (_, i) => key(p.s, p.row, p.c1 + i)) });
  }
  const ctx: EvalContext = { wb, values: new Map(), steps: 0, maxSteps: input.maxSteps, overrides };
  try {
    const order = evaluationOrder(wb, targets.flatMap((t) => t.cells).filter((k) => !overrides.has(k)));
    for (const k of order) {
      if (overrides.has(k)) continue;
      const cell = wb.cells.get(k)!;
      const v = cell.ast ? evalNode(ctx, cell.ast, cell.s) : E(cell.issues?.some((i) => i.code === 'PARSE') ? '#NAME?' : '#VALUE!');
      ctx.values.set(k, v);
    }
  } catch (e) {
    if (e instanceof CycleError) return { ok: false, code: 'FORECAST_CYCLE', message: e.message, diagnostics: e.cells.slice(0, 50).map((c) => ({ cell: c })) };
    if (e instanceof ResourceLimitError) return { ok: false, code: 'FORECAST_RESOURCE_LIMIT', message: e.message, diagnostics: [] };
    throw e;
  }
  const outputs: Record<string, string[]> = {};
  const errors: { output: string; cell: string; error: string }[] = [];
  for (const t of targets) {
    outputs[t.key] = t.cells.map((k) => {
      const v = cellValue(ctx, k);
      if (v.t === 'e') { errors.push({ output: t.key, cell: cellLabel(wb, k), error: v.v }); return ''; }
      const n = toNumber(v);
      if (isErr(n)) { errors.push({ output: t.key, cell: cellLabel(wb, k), error: n }); return ''; }
      return toFixed(n, 6);
    });
  }
  if (errors.length) {
    return { ok: false, code: 'FORECAST_FORMULA_ERROR', message: `输出单元格计算错误:${errors.slice(0, 5).map((e) => `${e.cell} ${e.error}`).join('、')}`, diagnostics: errors.slice(0, 200) };
  }
  return { ok: true, outputs, steps: ctx.steps };
}
