/**
 * 预测工作簿受限公式:词法 + 语法分析(T-5,AC-F11,OPEN-06 公式部分)。
 *
 * 支持:四则、^、比较、&、百分号、单元格/区域/跨表引用、白名单函数。
 * 不支持的函数、外部引用、#REF! 与语法错误都会在分析结果中列出(导入诊断用),
 * 求值时对应节点为错误值。数字字面量解析为 bigint 定点(core/fixed),不经过浮点。
 */
import { type Fx, fx } from '../../../core/fixed';

export const FORMULA_FUNCTIONS = ['SUM', 'AVERAGE', 'MIN', 'MAX', 'COUNT', 'ABS', 'ROUND', 'ROUNDUP', 'ROUNDDOWN', 'IF', 'IFERROR', 'AND', 'OR', 'NOT',
  'SUMPRODUCT', 'NPV', 'IRR', 'PMT'] as const;
const FUNCTION_SET = new Set<string>(FORMULA_FUNCTIONS);

export const ERROR_CODES = ['#DIV/0!', '#VALUE!', '#REF!', '#NAME?', '#NUM!', '#N/A', '#NULL!'] as const;
export type ErrorCode = (typeof ERROR_CODES)[number];

export type Ast =
  | { k: 'num'; v: Fx }
  | { k: 'str'; v: string }
  | { k: 'bool'; v: boolean }
  | { k: 'err'; v: ErrorCode }
  | { k: 'ref'; sheet: string | null; row: number; col: number }
  | { k: 'range'; sheet: string | null; r1: number; c1: number; r2: number; c2: number }
  | { k: 'un'; op: '-' | '+'; a: Ast }
  | { k: 'pct'; a: Ast }
  | { k: 'bin'; op: BinOp; a: Ast; b: Ast }
  | { k: 'fn'; name: string; args: Ast[] };
export type BinOp = '+' | '-' | '*' | '/' | '^' | '&' | '=' | '<>' | '<' | '>' | '<=' | '>=';

export interface FormulaIssue { code: 'PARSE' | 'UNSUPPORTED_FUNCTION' | 'EXTERNAL_REF' | 'REF_ERROR' | 'NAME'; message: string }
export interface ParsedFormula { ast: Ast | null; issues: FormulaIssue[] }

type Tok =
  | { t: 'num'; v: string }
  | { t: 'str'; v: string }
  | { t: 'err'; v: ErrorCode }
  | { t: 'ref'; sheet: string | null; a: string; b: string | null }
  | { t: 'id'; v: string }
  | { t: 'op'; v: string }
  | { t: 'ext' };

const SHEET_PREFIX = /^(?:'((?:[^']|'')+)'|([^\s!'"(),:;+\-*/^&=<>%{}[\]#$]+))!/;
const CELL = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})(?![\w(])/;
const NUMBER = /^(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?/;

/** 列字母 → 0 起索引。 */
export function colIndex(letters: string): number {
  let n = 0;
  for (const ch of letters.toUpperCase()) n = n * 26 + (ch.charCodeAt(0) - 64);
  return n - 1;
}
export function colLetters(index: number): string {
  let n = index + 1;
  let s = '';
  while (n > 0) {
    const r = (n - 1) % 26;
    s = String.fromCharCode(65 + r) + s;
    n = Math.floor((n - 1) / 26);
  }
  return s;
}
/** "B12" → {row: 11, col: 1};非法返回 null。 */
export function parseCellAddress(addr: string): { row: number; col: number } | null {
  const m = /^\$?([A-Za-z]{1,3})\$?(\d{1,7})$/.exec(addr.trim());
  if (!m) return null;
  const row = Number(m[2]) - 1;
  const col = colIndex(m[1]);
  if (row < 0 || row >= 1_048_576 || col >= 16_384) return null;
  return { row, col };
}
export const cellAddress = (row: number, col: number) => `${colLetters(col)}${row + 1}`;

/** 科学计数 → 普通十进制字符串(精确,不经过浮点)。 */
export function expandExponent(text: string): string {
  const m = /^([+-]?)(\d*)(?:\.(\d*))?[eE]([+-]?\d+)$/.exec(text);
  if (!m) return text;
  const [, sign, i, f = '', e] = m;
  const digits = (i || '0') + f;
  const point = (i || '0').length + Number(e);
  let body: string;
  if (point <= 0) body = `0.${'0'.repeat(-point)}${digits}`;
  else if (point >= digits.length) body = digits + '0'.repeat(point - digits.length);
  else body = `${digits.slice(0, point)}.${digits.slice(point)}`;
  body = body.replace(/^0+(?=\d)/, '');
  return `${sign === '-' ? '-' : ''}${body}`;
}

class ParseError extends Error {}

function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  while (i < src.length) {
    const ch = src[i];
    if (/\s/.test(ch)) { i += 1; continue; }
    const rest = src.slice(i);
    if (ch === '[') { out.push({ t: 'ext' }); const end = src.indexOf(']', i); i = end < 0 ? src.length : end + 1; continue; }
    if (ch === '"') {
      let j = i + 1;
      let s = '';
      for (;;) {
        if (j >= src.length) throw new ParseError('字符串缺少结束引号');
        if (src[j] === '"') { if (src[j + 1] === '"') { s += '"'; j += 2; continue; } j += 1; break; }
        s += src[j]; j += 1;
      }
      out.push({ t: 'str', v: s });
      i = j;
      continue;
    }
    if (ch === '#') {
      const code = ERROR_CODES.find((c) => rest.toUpperCase().startsWith(c));
      if (!code) throw new ParseError(`无法识别的错误值 ${rest.slice(0, 8)}`);
      out.push({ t: 'err', v: code });
      i += code.length;
      continue;
    }
    const sheetM = SHEET_PREFIX.exec(rest);
    if (sheetM) {
      const sheet = sheetM[1] != null ? sheetM[1].replace(/''/g, "'") : sheetM[2];
      const after = rest.slice(sheetM[0].length);
      if (after.toUpperCase().startsWith('#REF!')) { out.push({ t: 'err', v: '#REF!' }); i += sheetM[0].length + 5; continue; }
      const a = CELL.exec(after);
      if (!a) throw new ParseError(`工作表“${sheet}”后缺少单元格引用`);
      let len = sheetM[0].length + a[0].length;
      let b: string | null = null;
      const tail = after.slice(a[0].length);
      if (tail.startsWith(':')) {
        const bm = CELL.exec(tail.slice(1)) ?? CELL.exec(tail.slice(1).replace(SHEET_PREFIX, ''));
        if (!bm) throw new ParseError('区域引用不完整');
        const skipSheet = CELL.exec(tail.slice(1)) ? 0 : (SHEET_PREFIX.exec(tail.slice(1))?.[0].length ?? 0);
        b = bm[0]; len += 1 + skipSheet + bm[0].length;
      }
      out.push({ t: 'ref', sheet, a: a[0], b });
      i += len;
      continue;
    }
    const cell = CELL.exec(rest);
    if (cell && !/^(TRUE|FALSE)$/i.test(cell[0])) {
      let len = cell[0].length;
      let b: string | null = null;
      if (rest[len] === ':') {
        const bm = CELL.exec(rest.slice(len + 1));
        if (!bm) throw new ParseError('区域引用不完整');
        b = bm[0]; len += 1 + bm[0].length;
      }
      out.push({ t: 'ref', sheet: null, a: cell[0], b });
      i += len;
      continue;
    }
    const num = NUMBER.exec(rest);
    if (num && /[\d.]/.test(ch)) { out.push({ t: 'num', v: num[0] }); i += num[0].length; continue; }
    const id = /^[A-Za-z_一-龥][\w.一-龥]*/.exec(rest);
    if (id) { out.push({ t: 'id', v: id[0] }); i += id[0].length; continue; }
    const op = /^(<=|>=|<>|[-+*/^&=<>%(),;:])/.exec(rest);
    if (op) { out.push({ t: 'op', v: op[0] === ';' ? ',' : op[0] }); i += op[0].length; continue; }
    throw new ParseError(`无法识别的字符“${ch}”`);
  }
  return out;
}

/** 解析公式文本(可带前导 =)。 */
export function parseFormula(text: string): ParsedFormula {
  const issues: FormulaIssue[] = [];
  const src = text.trim().replace(/^=/, '');
  let toks: Tok[];
  try {
    toks = tokenize(src);
  } catch (e) {
    if (e instanceof ParseError) return { ast: null, issues: [{ code: 'PARSE', message: e.message }] };
    throw e;
  }
  let pos = 0;
  const peek = () => toks[pos];
  const isOp = (v: string) => peek()?.t === 'op' && (peek() as { v: string }).v === v;
  const expectOp = (v: string) => { if (!isOp(v)) throw new ParseError(`缺少“${v}”`); pos += 1; };

  const primary = (): Ast => {
    const t = toks[pos];
    if (!t) throw new ParseError('公式不完整');
    pos += 1;
    switch (t.t) {
      case 'num': {
        try { return { k: 'num', v: fx(expandExponent(t.v)) }; } catch { throw new ParseError(`数值无效 ${t.v}`); }
      }
      case 'str': return { k: 'str', v: t.v };
      case 'err':
        if (t.v === '#REF!') issues.push({ code: 'REF_ERROR', message: '公式包含 #REF! 无效引用' });
        return { k: 'err', v: t.v };
      case 'ext':
        issues.push({ code: 'EXTERNAL_REF', message: '不支持外部工作簿引用' });
        // 跳过紧随的 Sheet!A1 引用
        if (toks[pos]?.t === 'ref') pos += 1;
        return { k: 'err', v: '#REF!' };
      case 'ref': {
        const a = parseCellAddress(t.a);
        if (!a) throw new ParseError(`单元格引用无效 ${t.a}`);
        if (!t.b) return { k: 'ref', sheet: t.sheet, row: a.row, col: a.col };
        const b = parseCellAddress(t.b);
        if (!b) throw new ParseError(`单元格引用无效 ${t.b}`);
        return { k: 'range', sheet: t.sheet, r1: Math.min(a.row, b.row), c1: Math.min(a.col, b.col), r2: Math.max(a.row, b.row), c2: Math.max(a.col, b.col) };
      }
      case 'id': {
        const name = t.v.toUpperCase();
        if (isOp('(')) {
          pos += 1;
          const args: Ast[] = [];
          if (!isOp(')')) {
            for (;;) {
              // 空参数(如 IF(A1,,1))按空串处理
              if (isOp(',') || isOp(')')) args.push({ k: 'str', v: '' });
              else args.push(expr());
              if (isOp(',')) { pos += 1; continue; }
              break;
            }
          }
          expectOp(')');
          if (!FUNCTION_SET.has(name)) issues.push({ code: 'UNSUPPORTED_FUNCTION', message: `不支持的函数 ${name}` });
          return { k: 'fn', name, args };
        }
        if (name === 'TRUE' || name === 'FALSE') return { k: 'bool', v: name === 'TRUE' };
        issues.push({ code: 'NAME', message: `不支持的名称 ${t.v}(命名区域或未知标识)` });
        return { k: 'err', v: '#NAME?' };
      }
      case 'op':
        if (t.v === '(') { const e = expr(); expectOp(')'); return e; }
        throw new ParseError(`意外的运算符“${t.v}”`);
      default:
        throw new ParseError('公式无效');
    }
  };
  const postfix = (): Ast => {
    let a = primary();
    while (isOp('%')) { pos += 1; a = { k: 'pct', a }; }
    return a;
  };
  const unary = (): Ast => {
    if (isOp('-') || isOp('+')) { const op = (toks[pos] as { v: '-' | '+' }).v; pos += 1; return { k: 'un', op, a: unary() }; }
    return postfix();
  };
  const binary = (next: () => Ast, ops: string[]) => (): Ast => {
    let a = next();
    while (peek()?.t === 'op' && ops.includes((peek() as { v: string }).v)) {
      const op = (toks[pos] as { v: BinOp }).v;
      pos += 1;
      a = { k: 'bin', op, a, b: next() };
    }
    return a;
  };
  const pow = binary(unary, ['^']);
  const mul = binary(pow, ['*', '/']);
  const add = binary(mul, ['+', '-']);
  const concat = binary(add, ['&']);
  const expr: () => Ast = binary(concat, ['=', '<>', '<', '>', '<=', '>=']);

  try {
    if (!toks.length) throw new ParseError('公式为空');
    const ast = expr();
    if (pos < toks.length) throw new ParseError('公式末尾有多余内容');
    return { ast, issues };
  } catch (e) {
    if (e instanceof ParseError) return { ast: null, issues: [...issues, { code: 'PARSE', message: e.message }] };
    throw e;
  }
}

/** 收集公式中的引用(单元格与区域)。 */
export function collectRefs(ast: Ast, out: (Extract<Ast, { k: 'ref' }> | Extract<Ast, { k: 'range' }>)[] = []) {
  switch (ast.k) {
    case 'ref': case 'range': out.push(ast); break;
    case 'un': case 'pct': collectRefs(ast.a, out); break;
    case 'bin': collectRefs(ast.a, out); collectRefs(ast.b, out); break;
    case 'fn': for (const a of ast.args) collectRefs(a, out); break;
    default: break;
  }
  return out;
}
