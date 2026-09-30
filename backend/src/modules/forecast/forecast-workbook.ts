/**
 * 预测工作簿:xlsx → 工作簿 JSON(值与公式)与静态诊断(AC-F11)。
 *
 * 诊断(error 阻止冻结):语法错误、不支持的函数/名称、外部引用、#REF!、未知工作表、循环引用、
 * 参数单元格不是数值常量或越界、输出引用无效;超过 50 个工作表或 200,000 个单元格直接拒绝。
 */
import ExcelJS from 'exceljs';
import { Errors } from '../../core/errors';
import { fx } from '../../core/fixed';
import { assertSafeXlsx } from '../io/xlsx-guard';
import { cellAddress, collectRefs, expandExponent, ERROR_CODES, type ErrorCode } from './formula/parser';
import { compileWorkbook, findCycle, parseRef, MAX_CELLS, MAX_SHEETS, type CellInput, type WorkbookJson } from './formula/engine';
import type { ForecastDiagnostic, ForecastOutput, ForecastParam } from '../../contracts/finance-forecast';

const MAX_DIAGNOSTICS = 500;

export async function workbookFromXlsx(buffer: Buffer): Promise<{ workbook: WorkbookJson; diagnostics: ForecastDiagnostic[] }> {
  await assertSafeXlsx(buffer, MAX_CELLS, MAX_SHEETS);
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(buffer as unknown as ArrayBuffer);
  } catch {
    throw Errors.validation('不是有效的 xlsx 文件');
  }
  if (wb.worksheets.length > MAX_SHEETS) throw Errors.validation(`工作表超过 ${MAX_SHEETS} 个`);
  const diagnostics: ForecastDiagnostic[] = [];
  const workbook: WorkbookJson = { sheets: [] };
  let count = 0;
  for (const ws of wb.worksheets) {
    const name = ws.name.trim().slice(0, 31);
    const cells: Record<string, CellInput> = {};
    ws.eachRow({ includeEmpty: false }, (row, rowNo) => {
      row.eachCell({ includeEmpty: false }, (cell, colNo) => {
        const addr = cellAddress(rowNo - 1, colNo - 1);
        const where = `${name}!${addr}`;
        const input = cellInputOf(cell, where, diagnostics);
        if (!input) return;
        count += 1;
        if (count > MAX_CELLS) throw Errors.validation(`单元格超过 ${MAX_CELLS} 个`);
        cells[addr] = input;
      });
    });
    workbook.sheets.push({ name, cells });
  }
  return { workbook, diagnostics };
}

function cellInputOf(cell: ExcelJS.Cell, where: string, diagnostics: ForecastDiagnostic[]): CellInput | null {
  const v = cell.value as unknown;
  if (v == null) return null;
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) { diagnostics.push({ severity: 'error', code: 'VALUE', cell: where, message: '数值无效' }); return null; }
    return { n: expandExponent(String(v)) };
  }
  if (typeof v === 'string') return { s: v };
  if (typeof v === 'boolean') return { b: v };
  if (v instanceof Date) {
    diagnostics.push({ severity: 'warning', code: 'DATE', cell: where, message: '日期按文本保存,不参与计算' });
    return { s: v.toISOString().slice(0, 10) };
  }
  const o = v as Record<string, unknown>;
  if ('formula' in o || 'sharedFormula' in o) {
    if (o.shareType === 'array' || 'ref' in o && o.shareType) {
      diagnostics.push({ severity: 'error', code: 'ARRAY_FORMULA', cell: where, message: '不支持数组公式' });
    }
    const f = cell.formula;
    if (!f) { diagnostics.push({ severity: 'error', code: 'PARSE', cell: where, message: '无法读取公式' }); return { e: '#NAME?' }; }
    return { f: `=${f}` };
  }
  if ('error' in o) {
    const code = String(o.error) as ErrorCode;
    return ERROR_CODES.includes(code) ? { e: code } : { e: '#VALUE!' };
  }
  if (Array.isArray(o.richText)) return { s: (o.richText as { text: string }[]).map((t) => t.text).join('') };
  if ('text' in o) return { s: String(o.text) };
  diagnostics.push({ severity: 'warning', code: 'UNKNOWN', cell: where, message: '无法识别的单元格内容,已忽略' });
  return null;
}

/** 静态诊断:公式、引用、循环、参数与输出映射。 */
export function diagnoseWorkbook(workbook: WorkbookJson, params: ForecastParam[], outputs: ForecastOutput[], base: ForecastDiagnostic[] = []): ForecastDiagnostic[] {
  const out: ForecastDiagnostic[] = [...base];
  const push = (d: ForecastDiagnostic) => { if (out.length < MAX_DIAGNOSTICS) out.push(d); };
  if (workbook.sheets.length > MAX_SHEETS) push({ severity: 'error', code: 'LIMIT', cell: null, message: `工作表超过 ${MAX_SHEETS} 个` });
  const total = workbook.sheets.reduce((n, s) => n + Object.keys(s.cells).length, 0);
  if (total > MAX_CELLS) push({ severity: 'error', code: 'LIMIT', cell: null, message: `单元格超过 ${MAX_CELLS} 个` });
  const names = new Set<string>();
  for (const s of workbook.sheets) {
    if (names.has(s.name.toLowerCase())) push({ severity: 'error', code: 'SHEET_DUPLICATE', cell: null, message: `工作表名称重复:${s.name}` });
    names.add(s.name.toLowerCase());
  }
  const wb = compileWorkbook(workbook);
  for (const cell of wb.cells.values()) {
    if (cell.ast === undefined) continue;
    const where = `${wb.sheetNames[cell.s]}!${cellAddress(cell.r, cell.c)}`;
    for (const i of cell.issues ?? []) push({ severity: 'error', code: i.code, cell: where, message: i.message });
    if (cell.ast) {
      for (const ref of collectRefs(cell.ast)) {
        if (ref.sheet != null && !wb.sheetIndex.has(ref.sheet.toLowerCase())) push({ severity: 'error', code: 'UNKNOWN_SHEET', cell: where, message: `引用了不存在的工作表“${ref.sheet}”` });
      }
    }
  }
  const cycle = findCycle(wb);
  if (cycle) push({ severity: 'error', code: 'CYCLE', cell: cycle[0], message: `循环引用:${cycle.slice(0, 10).join('、')}` });

  const keys = new Set<string>();
  for (const p of params) {
    if (keys.has(p.key)) push({ severity: 'error', code: 'PARAM', cell: p.cell, message: `参数编码重复:${p.key}` });
    keys.add(p.key);
    const ref = parseRef(wb, p.cell);
    const cell = ref ? wb.cells.get((ref.s * 1_048_576 + ref.row) * 16_384 + ref.c1) : undefined;
    if (!ref) { push({ severity: 'error', code: 'PARAM', cell: p.cell, message: `参数“${p.name}”的单元格无效` }); continue; }
    if (!cell || !('n' in cell.input)) { push({ severity: 'error', code: 'PARAM', cell: p.cell, message: `参数“${p.name}”的单元格必须是数值常量` }); continue; }
    const v = fx(cell.input.n);
    if (p.min != null && p.max != null && fx(p.min) > fx(p.max)) push({ severity: 'error', code: 'PARAM', cell: p.cell, message: `参数“${p.name}”下限大于上限` });
    if ((p.min != null && v < fx(p.min)) || (p.max != null && v > fx(p.max))) push({ severity: 'error', code: 'PARAM', cell: p.cell, message: `参数“${p.name}”当前值超出上下限` });
  }
  const okeys = new Set<string>();
  for (const o of outputs) {
    if (okeys.has(o.key)) push({ severity: 'error', code: 'OUTPUT', cell: o.ref, message: `输出编码重复:${o.key}` });
    okeys.add(o.key);
    const ref = parseRef(wb, o.ref);
    if (!ref) push({ severity: 'error', code: 'OUTPUT', cell: o.ref, message: `输出“${o.name}”的引用无效(须为单元格或一行区域)` });
    else if (ref.c2 - ref.c1 >= 100) push({ severity: 'error', code: 'OUTPUT', cell: o.ref, message: `输出“${o.name}”超过 100 列` });
  }
  if (!outputs.length) push({ severity: 'warning', code: 'OUTPUT', cell: null, message: '尚未配置输出映射,冻结前需要至少一个输出' });
  return out;
}

export const hasErrors = (d: ForecastDiagnostic[]) => d.some((x) => x.severity === 'error');
