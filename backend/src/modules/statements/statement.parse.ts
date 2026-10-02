/**
 * 财务报表四表模板解析(AC-F10)。版式见本项目标准模板:资产负债表左右两栏、利润表/现金流量表单栏、
 * 所有者权益变动表多栏。每个事实保存来源单元格、公式文本和文本值;金额为整数分,不可解析的文本保留原文并告警,不当作 0。
 *
 * 勾稽(容差 1 元):资产总计 = 负债和所有者权益总计(BALANCE_NOT_EQUAL);负债合计 + 权益合计 = 总计(LIAB_EQUITY_SUM_MISMATCH);
 * 期初现金 + 净增加额 = 期末现金(CASH_FLOW_RECONCILE_MISMATCH)。合计行缺失给 warning。
 */
import ExcelJS from 'exceljs';
import { Errors } from '../../core/errors';
import { parseDecimalToCents } from '../../core/decimal';
import { assertSafeXlsx } from '../io/xlsx-guard';

export const STATEMENT_TEMPLATE_VERSION = 'fs-2026-09-v1';
const TOLERANCE = 100n; // 1 元
const MAX_ROWS_PER_SHEET = 2_000;
const MAX_SHEETS = 12;

export type SheetCode = 'balance_sheet' | 'income_statement' | 'cash_flow_statement' | 'equity_change_statement';
export const SHEETS: { code: SheetCode; name: string }[] = [
  { code: 'balance_sheet', name: '资产负债表' },
  { code: 'income_statement', name: '利润表' },
  { code: 'cash_flow_statement', name: '现金流量表' },
  { code: 'equity_change_statement', name: '所有者权益变动表' },
];

export interface StatementCheck { code: string; level: 'error' | 'warning'; message: string; sheetCode?: SheetCode; sourceCell?: string; extra?: Record<string, string> }
export interface ParsedItem { sheetCode: SheetCode; side: 'asset' | 'liability_equity' | null; rowNo: number; lineNo: string | null; itemName: string; semanticKey: string | null; itemType: 'total' | 'subtotal' | 'detail' }
export interface ParsedFact { itemIndex: number; fieldKey: string; fieldName: string; amount: bigint | null; textValue: string | null; formulaText: string | null; sourceCell: string }
export interface ParsedStatement {
  sheets: { code: SheetCode; name: string; itemCount: number; factCount: number; formulaCount: number }[];
  ignoredSheets: string[];
  items: ParsedItem[];
  facts: ParsedFact[];
  checks: StatementCheck[];
  /** 语义指标(分):键名带口径后缀 _period_end / _ytd */
  metrics: Record<string, bigint>;
}

export const normalizeText = (v: string) => v.replace(/[\s　]+/g, '').replace(/（/g, '(').replace(/）/g, ')').replace(/：/g, ':');

/** 语义指标:按表、栏和名称匹配,同一语义取第一次出现的行。 */
const SEMANTIC_RULES: { sheet: SheetCode; side?: 'asset' | 'liability_equity'; key: string; test: (n: string) => boolean }[] = [
  { sheet: 'balance_sheet', side: 'asset', key: 'total_assets', test: (n) => n.includes('资产总计') },
  { sheet: 'balance_sheet', side: 'liability_equity', key: 'liability_equity_total', test: (n) => n.includes('负债和所有者') && (n.includes('合计') || n.includes('总计')) },
  { sheet: 'balance_sheet', side: 'liability_equity', key: 'total_liabilities', test: (n) => n.includes('负债合计') && !n.includes('权益') },
  { sheet: 'balance_sheet', side: 'liability_equity', key: 'owner_equity', test: (n) => n.includes('所有者权益') && n.includes('合计') && !n.includes('负债') },
  { sheet: 'income_statement', key: 'revenue', test: (n) => n.includes('营业总收入') },
  { sheet: 'income_statement', key: 'revenue', test: (n) => n.includes('营业收入') && !n.includes('营业外') },
  { sheet: 'income_statement', key: 'cost', test: (n) => n.includes('营业总成本') },
  { sheet: 'income_statement', key: 'operating_profit', test: (n) => n.includes('营业利润') },
  { sheet: 'income_statement', key: 'total_profit', test: (n) => n.includes('利润总额') },
  { sheet: 'income_statement', key: 'net_profit', test: (n) => n.includes('净利润') && !n.includes('其他综合收益') },
  { sheet: 'cash_flow_statement', key: 'operating_cash_flow', test: (n) => n.includes('经营活动产生的现金流量净额') },
  { sheet: 'cash_flow_statement', key: 'investing_cash_flow', test: (n) => n.includes('投资活动产生的现金流量净额') },
  { sheet: 'cash_flow_statement', key: 'financing_cash_flow', test: (n) => n.includes('筹资活动产生的现金流量净额') },
  { sheet: 'cash_flow_statement', key: 'cash_net_increase', test: (n) => n.includes('现金及现金等价物净增加额') },
  { sheet: 'cash_flow_statement', key: 'cash_beginning', test: (n) => n.includes('期初现金及现金等价物余额') },
  { sheet: 'cash_flow_statement', key: 'cash_ending', test: (n) => n.includes('期末现金及现金等价物余额') },
];
/** 取数口径:资产负债表取期末余额,利润表与现金流量表取本年累计。 */
export const PREFERRED_FIELD: Partial<Record<SheetCode, { field: string; suffix: '_period_end' | '_ytd' }>> = {
  balance_sheet: { field: 'period_end', suffix: '_period_end' },
  income_statement: { field: 'year_to_date', suffix: '_ytd' },
  cash_flow_statement: { field: 'year_to_date', suffix: '_ytd' },
};

function itemType(name: string): ParsedItem['itemType'] {
  const n = normalizeText(name);
  if (['小计', '合计', '总计', '净额', '利润总额', '净利润'].some((k) => n.includes(k))) return 'total';
  if (/^(一|二|三|四|五|六|七|八|九|十)、/.test(name) || name.startsWith('（') || name.startsWith('(')) return 'subtotal';
  return 'detail';
}

function cellText(cell: ExcelJS.Cell): string {
  const v = cell.value;
  if (v == null) return '';
  if (typeof v === 'object' && 'richText' in v) return v.richText.map((p) => p.text).join('').trim();
  if (typeof v === 'object' && 'result' in v) return v.result == null ? '' : String(v.result).trim();
  if (v instanceof Date) return v.toISOString().slice(0, 10);
  return String(v).trim();
}

/** 单元格 → 金额/文本/公式。“-”“—”视为空;括号负数与千分位逗号显式处理;超过两位小数或非数字文本保留原文。 */
function readValueCell(cell: ExcelJS.Cell): { amount: bigint | null; text: string | null; formula: string | null; cacheMissing: boolean; unparseable: boolean } {
  const formula = cell.formula ? `=${cell.formula}` : null;
  let raw: unknown = cell.value;
  if (raw && typeof raw === 'object' && ('formula' in raw || 'sharedFormula' in raw)) {
    raw = (raw as ExcelJS.CellFormulaValue).result;
    if (raw == null) return { amount: null, text: null, formula, cacheMissing: true, unparseable: false };
    if (typeof raw === 'object' && 'error' in (raw as object)) return { amount: null, text: String((raw as { error: string }).error), formula, cacheMissing: false, unparseable: true };
  }
  if (raw == null) return { amount: null, text: null, formula, cacheMissing: false, unparseable: false };
  if (typeof raw === 'number') {
    try {
      return { amount: parseDecimalToCents(String(Number(raw.toPrecision(15)))), text: null, formula, cacheMissing: false, unparseable: false };
    } catch {
      return { amount: null, text: String(raw), formula, cacheMissing: false, unparseable: true };
    }
  }
  const text = typeof raw === 'object' && raw && 'richText' in raw ? (raw as ExcelJS.CellRichTextValue).richText.map((p) => p.text).join('') : String(raw);
  const t = text.trim();
  if (!t || /^[-—－–]+$/.test(t)) return { amount: null, text: null, formula, cacheMissing: false, unparseable: false };
  const negative = /^\(.*\)$/.test(t) || /^（.*）$/.test(t);
  const body = t.replace(/^[(（]|[)）]$/g, '').replace(/,/g, '').trim();
  if (/^-?\d+(\.\d+)?$/.test(body)) {
    try {
      const cents = parseDecimalToCents(body);
      return { amount: negative ? -cents : cents, text: null, formula, cacheMissing: false, unparseable: false };
    } catch { /* 超过两位小数等:按文本保留 */ }
  }
  return { amount: null, text: t.slice(0, 200), formula, cacheMissing: false, unparseable: true };
}

type Field = { column: number; key: string; name: string };

function colLetter(n: number): string {
  let s = '';
  for (let x = n; x > 0; x = Math.floor((x - 1) / 26)) s = String.fromCharCode(65 + ((x - 1) % 26)) + s;
  return s;
}

function headerText(ws: ExcelJS.Worksheet): string {
  const parts: string[] = [];
  for (let r = 1; r <= Math.min(4, ws.rowCount); r++) {
    for (let c = 1; c <= ws.columnCount; c++) parts.push(cellText(ws.getRow(r).getCell(c)));
  }
  return normalizeText(parts.join(' '));
}

export async function parseStatementWorkbook(content: Buffer): Promise<ParsedStatement> {
  await assertSafeXlsx(content, MAX_ROWS_PER_SHEET, MAX_SHEETS);
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(content as unknown as ExcelJS.Buffer);
  } catch {
    throw Errors.validation('不是有效的 xlsx 文件');
  }
  const checks: StatementCheck[] = [];
  const items: ParsedItem[] = [];
  const facts: ParsedFact[] = [];
  const sheets: ParsedStatement['sheets'] = [];
  const byName = new Map(wb.worksheets.map((ws) => [normalizeText(ws.name), ws]));
  const known = new Set(SHEETS.map((s) => normalizeText(s.name)));
  const ignoredSheets = wb.worksheets.map((ws) => ws.name).filter((n) => !known.has(normalizeText(n)));

  for (const sheet of SHEETS) {
    const ws = byName.get(normalizeText(sheet.name));
    if (!ws) {
      checks.push({ code: 'TARGET_SHEET_MISSING', level: 'error', message: `缺少工作表:${sheet.name}`, sheetCode: sheet.code });
      continue;
    }
    const header = headerText(ws);
    const expected = sheet.code === 'balance_sheet' ? ['资产', '行次', '期末余额', '年初余额', '负债和所有者权益']
      : sheet.code === 'equity_change_statement' ? ['项目', '行次', '本年金额', '上年金额'] : ['项目', '行次'];
    for (const e of expected) {
      if (!header.includes(normalizeText(e)) && !(e === '项目' && header.includes('项'))) {
        checks.push({ code: 'HEADER_MISMATCH', level: 'error', message: `${ws.name} 未识别到表头“${e}”`, sheetCode: sheet.code });
      }
    }
    const before = { items: items.length, facts: facts.length };
    const layouts: { side: ParsedItem['side']; itemCol: number; lineCol: number; fields: Field[] }[] =
      sheet.code === 'balance_sheet' ? [
        { side: 'asset', itemCol: 1, lineCol: 2, fields: [{ column: 3, key: 'period_end', name: '期末余额' }, { column: 4, key: 'year_begin', name: '年初余额' }] },
        { side: 'liability_equity', itemCol: 5, lineCol: 6, fields: [{ column: 7, key: 'period_end', name: '期末余额' }, { column: 8, key: 'year_begin', name: '年初余额' }] },
      ] : sheet.code === 'income_statement' ? [
        { side: null, itemCol: 1, lineCol: 2, fields: [{ column: 3, key: 'current_month', name: '本月金额' }, { column: 4, key: 'year_to_date', name: '本年累计' }, { column: 5, key: 'last_year_same_period', name: '上年同期' }, { column: 6, key: 'last_year_to_date', name: '上年累计' }] },
      ] : sheet.code === 'cash_flow_statement' ? [
        { side: null, itemCol: 1, lineCol: 2, fields: [{ column: 3, key: 'current_period', name: '本期发生额' }, { column: 4, key: 'year_to_date', name: '本年累计数' }] },
      ] : [{
        side: null, itemCol: 1, lineCol: 2,
        fields: Array.from({ length: Math.max(0, Math.min(ws.columnCount, 25) - 2) }, (_, i) => {
          const column = i + 3;
          const label = [1, 2, 3, 4].map((r) => cellText(ws.getRow(r).getCell(column))).filter(Boolean).join(' / ');
          return { column, key: `column_${colLetter(column).toLowerCase()}`, name: label || colLetter(column) };
        }),
      }];
    const firstRow = sheet.code === 'equity_change_statement' ? 5 : 2;
    for (let r = firstRow; r <= ws.rowCount; r++) {
      const row = ws.getRow(r);
      for (const layout of layouts) {
        const itemName = cellText(row.getCell(layout.itemCol));
        const lineNo = cellText(row.getCell(layout.lineCol));
        if (!itemName && !lineNo) continue;
        const itemIndex = items.length;
        items.push({ sheetCode: sheet.code, side: layout.side, rowNo: r, lineNo: lineNo || null, itemName: itemName || `未命名行${r}`, semanticKey: null, itemType: itemType(itemName) });
        for (const f of layout.fields) {
          const cell = row.getCell(f.column);
          if (cell.isMerged && cell.master !== cell) continue;
          const v = readValueCell(cell);
          if (v.amount === null && v.text === null && v.formula === null) continue;
          const sourceCell = `${ws.name}!${colLetter(f.column)}${r}`;
          if (v.cacheMissing) checks.push({ code: 'FORMULA_CACHE_MISSING', level: 'warning', message: `${sourceCell} 是公式单元格但没有缓存计算值`, sheetCode: sheet.code, sourceCell });
          if (v.unparseable) checks.push({ code: 'AMOUNT_UNPARSEABLE', level: 'warning', message: `${sourceCell} 的内容“${v.text}”不是金额,已按原文保留`, sheetCode: sheet.code, sourceCell });
          facts.push({ itemIndex, fieldKey: f.key, fieldName: f.name, amount: v.amount, textValue: v.text, formulaText: v.formula, sourceCell });
        }
      }
    }
    const sheetFacts = facts.slice(before.facts);
    sheets.push({ code: sheet.code, name: ws.name, itemCount: items.length - before.items, factCount: sheetFacts.length, formulaCount: sheetFacts.filter((f) => f.formulaText).length });
  }

  // 语义标注与指标
  const metrics: Record<string, bigint> = {};
  const taken = new Set<string>();
  items.forEach((item, index) => {
    const n = normalizeText(item.itemName);
    const rule = SEMANTIC_RULES.find((x) => x.sheet === item.sheetCode && (!x.side || x.side === item.side) && !taken.has(x.key) && x.test(n));
    if (!rule) return;
    taken.add(rule.key);
    item.semanticKey = rule.key;
    const pref = PREFERRED_FIELD[item.sheetCode];
    const fact = pref && facts.find((f) => f.itemIndex === index && f.fieldKey === pref.field);
    if (pref && fact?.amount != null) metrics[`${rule.key}${pref.suffix}`] = fact.amount;
  });
  checks.push(...reconcile(metrics));
  return { sheets, ignoredSheets, items, facts, checks, metrics };
}

const abs = (v: bigint) => (v < 0n ? -v : v);
const yuan = (c: bigint) => { const a = abs(c); return `${c < 0n ? '-' : ''}${a / 100n}.${String(a % 100n).padStart(2, '0')}`; };

function reconcile(m: Record<string, bigint>): StatementCheck[] {
  const out: StatementCheck[] = [];
  const assets = m.total_assets_period_end;
  const total = m.liability_equity_total_period_end;
  const liab = m.total_liabilities_period_end;
  const equity = m.owner_equity_period_end;
  if (assets === undefined || total === undefined) {
    out.push({ code: 'BALANCE_TOTAL_MISSING', level: 'warning', message: '资产负债表未识别到资产总计或负债和所有者权益总计,无法勾稽', sheetCode: 'balance_sheet' });
  } else if (abs(assets - total) > TOLERANCE) {
    out.push({ code: 'BALANCE_NOT_EQUAL', level: 'error', message: `资产总计 ${yuan(assets)} 与负债和所有者权益总计 ${yuan(total)} 不相等`, sheetCode: 'balance_sheet', extra: { totalAssets: yuan(assets), liabilityEquityTotal: yuan(total) } });
  } else if (liab !== undefined && equity !== undefined && abs(liab + equity - total) > TOLERANCE) {
    out.push({ code: 'LIAB_EQUITY_SUM_MISMATCH', level: 'error', message: `负债合计 ${yuan(liab)} 加所有者权益合计 ${yuan(equity)} 不等于总计 ${yuan(total)}`, sheetCode: 'balance_sheet' });
  }
  const begin = m.cash_beginning_ytd; const end = m.cash_ending_ytd; const inc = m.cash_net_increase_ytd;
  if (begin === undefined || end === undefined || inc === undefined) {
    out.push({ code: 'CASH_FLOW_RECONCILE_MISSING', level: 'warning', message: '现金流量表未识别到期初/期末现金余额或净增加额,无法勾稽', sheetCode: 'cash_flow_statement' });
  } else if (abs(begin + inc - end) > TOLERANCE) {
    out.push({ code: 'CASH_FLOW_RECONCILE_MISMATCH', level: 'error', message: `期初现金 ${yuan(begin)} 加净增加额 ${yuan(inc)} 不等于期末现金 ${yuan(end)}`, sheetCode: 'cash_flow_statement' });
  }
  if (m.net_profit_ytd === undefined) out.push({ code: 'NET_PROFIT_MISSING', level: 'warning', message: '利润表未识别到本年累计净利润', sheetCode: 'income_statement' });
  if (m.operating_cash_flow_ytd === undefined) out.push({ code: 'OPERATING_CASH_FLOW_MISSING', level: 'warning', message: '现金流量表未识别到经营活动现金流量净额', sheetCode: 'cash_flow_statement' });
  return out;
}
