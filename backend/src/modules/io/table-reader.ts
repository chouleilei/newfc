/**
 * 通用表格读取(CSV / xlsx → 表头 + 文本行),供新领域导入(EAS 等)先解析、再全量校验。
 *
 * - CSV 必须是 UTF-8(可带 BOM),非法字节直接拒绝,不猜测编码。
 * - xlsx 先经 assertSafeXlsx 流式限流,再读取第一个工作表;公式单元格缺缓存值时报错,不当作空。
 * - 数值单元格按 Excel 显示精度(15 位有效数字)转文本,去掉二进制浮点噪声;是否允许小数位由调用方的金额解析决定。
 * - 行数上限与标准导入一致(MAX_IMPORT_ROWS,不含表头)。
 */
import path from 'path';
import ExcelJS from 'exceljs';
import { Errors } from '../../core/errors';
import { MAX_IMPORT_ROWS, MAX_WORKBOOK_SHEETS } from './import-limits';
import { assertSafeXlsx } from './xlsx-guard';
import { isOle2Buffer, readXlsWorkbookSheets } from './xls-reader';

export interface TableRow { rowNo: number; values: Record<string, string> }
export interface ReadTable { headers: string[]; rows: TableRow[]; headerRowNo?: number }

export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = '';
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else quoted = false;
      } else field += ch;
      continue;
    }
    if (ch === '"' && field === '') quoted = true;
    else if (ch === ',') { row.push(field); field = ''; }
    else if (ch === '\n' || ch === '\r') {
      if (ch === '\r' && text[i + 1] === '\n') i++;
      row.push(field); rows.push(row); row = []; field = '';
    } else field += ch;
  }
  if (quoted) throw Errors.validation('CSV 引号未闭合');
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

export interface WorkbookReadOptions {
  allowUncachedFormulas?: boolean;
  warnings?: string[];
}

function cellText(cell: ExcelJS.Cell, opts?: WorkbookReadOptions): string {
  const value = cell.value;
  if (value == null) return '';
  if (typeof value === 'number') return String(Number(value.toPrecision(15)));
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    if ('formula' in value || 'sharedFormula' in value) {
      const result = (value as ExcelJS.CellFormulaValue).result;
      if (result == null) {
        if (opts?.allowUncachedFormulas) {
          opts.warnings?.push(`公式单元格 ${cell.worksheet.name}!${cell.address} 缺少缓存计算值`);
          return '';
        }
        throw Errors.validation(`公式单元格 ${cell.address} 缺少缓存计算值,请在 Excel 中重新计算保存后上传`);
      }
      if (typeof result === 'number') return String(Number(result.toPrecision(15)));
      if (result instanceof Date) return result.toISOString().slice(0, 10);
      if (typeof result === 'object' && 'error' in result) {
        if (opts?.allowUncachedFormulas) {
          opts.warnings?.push(`单元格 ${cell.worksheet.name}!${cell.address} 公式错误值 ${result.error}`);
          return '';
        }
        throw Errors.validation(`单元格 ${cell.address} 是错误值 ${result.error}`);
      }
      return String(result).trim();
    }
    if ('richText' in value) return value.richText.map((part) => part.text).join('').trim();
    if ('text' in value) return String(value.text).trim();
    if ('error' in value) {
      if (opts?.allowUncachedFormulas) {
        opts.warnings?.push(`单元格 ${cell.worksheet.name}!${cell.address} 错误值 ${value.error}`);
        return '';
      }
      throw Errors.validation(`单元格 ${cell.address} 是错误值 ${value.error}`);
    }
  }
  return String(value).trim();
}

function normalizeHeader(value: string): string {
  return value.replace(/^﻿/, '').replace(/\s+/g, '').trim();
}

export interface MatrixRow { rowNo: number; cells: string[] }
export interface FormulaCellRef { rowNo: number; colIndex: number; address: string; formula: string; cacheIssue?: 'missing_cache' | 'error_value' }
export interface ReadSheet { name: string; hidden: boolean; rows: MatrixRow[]; formulas?: FormulaCellRef[] }
/** 表头定位:缺省取第一个非空行;给出 isHeader 时在前 within 行内找第一行满足条件的行(模板常有标题/单位行)。 */
export interface HeaderLocator {
  isHeader: (cells: string[]) => boolean;
  within?: number;
  label?: string;
  allowDuplicateHeaders?: boolean;
}

function toTable(matrix: MatrixRow[], maxRows: number, locator?: HeaderLocator): ReadTable {
  const headerIndex = locator
    ? matrix.slice(0, locator.within ?? 20).findIndex((r) => locator.isHeader(r.cells.map(normalizeHeader)))
    : matrix.findIndex((r) => r.cells.some((c) => c.trim() !== ''));
  if (headerIndex < 0) throw Errors.validation(locator ? `前 ${locator.within ?? 20} 行内未找到${locator.label ?? '表头'}` : '文件没有表头');
  const rawHeaders = matrix[headerIndex].cells.map(normalizeHeader);
  const seenCounts = new Map<string, number>();
  const headers: string[] = [];
  for (const h of rawHeaders) {
    if (!h) continue;
    const prev = seenCounts.get(h) ?? 0;
    if (prev > 0) {
      if (!locator?.allowDuplicateHeaders) throw Errors.validation(`表头“${h}”重复`);
      seenCounts.set(h, prev + 1);
      headers.push(`${h}#${prev + 1}`);
    } else {
      seenCounts.set(h, 1);
      headers.push(h);
    }
  }
  const rows: TableRow[] = [];
  const colHeaders: string[] = [];
  const colSeen = new Map<string, number>();
  for (const h of rawHeaders) {
    if (!h) {
      colHeaders.push('');
      continue;
    }
    const prev = colSeen.get(h) ?? 0;
    colSeen.set(h, prev + 1);
    colHeaders.push(prev > 0 ? `${h}#${prev + 1}` : h);
  }
  for (const r of matrix.slice(headerIndex + 1)) {
    if (!r.cells.some((c) => c.trim() !== '')) continue;
    if (rows.length >= maxRows) throw Errors.validation(`数据行超过安全上限 ${maxRows} 行(不含表头)`);
    const values: Record<string, string> = {};
    colHeaders.forEach((h, i) => { if (h) values[h] = (r.cells[i] ?? '').trim(); });
    rows.push({ rowNo: r.rowNo, values });
  }
  return { headers, rows, headerRowNo: matrix[headerIndex].rowNo };
}

export function normalizeHeaderText(value: string): string {
  return normalizeHeader(value);
}

/** 已读入的工作表矩阵 → 表头 + 文本行(多 sheet 模板逐表调用)。 */
export function sheetTable(sheet: ReadSheet, locator?: HeaderLocator, maxRows = MAX_IMPORT_ROWS): ReadTable {
  return toTable(sheet.rows, maxRows, locator);
}

async function loadWorkbook(content: Buffer, maxRows: number, maxWorksheets = 1): Promise<ExcelJS.Workbook> {
  if (!content.length) throw Errors.validation('上传文件为空');
  await assertSafeXlsx(content, maxRows, maxWorksheets);
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(content as unknown as ExcelJS.Buffer, { ignoreNodes: ['dataValidations'] });
  } catch {
    throw Errors.validation('不是有效的 xlsx 文件');
  }
  return wb;
}

function sheetMatrixWithFormulas(sheet: ExcelJS.Worksheet, opts?: WorkbookReadOptions): { rows: MatrixRow[]; formulas: FormulaCellRef[] } {
  const matrix: MatrixRow[] = [];
  const formulas: FormulaCellRef[] = [];
  // 隐藏行同样读入:原始事实不能因为显示状态被静默丢弃
  sheet.eachRow({ includeEmpty: false }, (row, rowNo) => {
    let maxCol = 0;
    const entries: [number, string][] = [];
    row.eachCell({ includeEmpty: false }, (cell, colNumber) => {
      if (colNumber > 512) return;
      const value = cell.value;
      if (value && typeof value === 'object' && ('formula' in value || 'sharedFormula' in value || 'error' in value)) {
        const formula = cell.formula ?? '';
        const result = 'error' in value ? value : (value as ExcelJS.CellFormulaValue).result;
        const cacheIssue = result == null ? 'missing_cache' : typeof result === 'object' && 'error' in result ? 'error_value' : undefined;
        formulas.push({
          rowNo,
          colIndex: colNumber - 1,
          address: cell.address,
          formula,
          ...(cacheIssue ? { cacheIssue } : {}),
        });
      }
      const txt = cellText(cell, opts);
      if (txt !== '') {
        entries.push([colNumber, txt]);
        if (colNumber > maxCol) maxCol = colNumber;
      }
    });
    const cells = new Array<string>(maxCol).fill('');
    for (const [colNumber, txt] of entries) cells[colNumber - 1] = txt;
    matrix.push({ rowNo, cells });
  });
  return { rows: matrix, formulas };
}

/** 读取 xlsx 全部工作表为文本矩阵(含隐藏表,由调用方决定是否忽略并列出)。 */
export async function readWorkbookSheets(
  content: Buffer,
  maxRows = MAX_IMPORT_ROWS,
  maxWorksheets = MAX_WORKBOOK_SHEETS,
  opts?: WorkbookReadOptions,
): Promise<ReadSheet[]> {
  if (!content.length) throw Errors.validation('上传文件为空');
  if (isOle2Buffer(content)) {
    return readXlsWorkbookSheets(content, maxRows, maxWorksheets, opts);
  }
  const wb = await loadWorkbook(content, maxRows, maxWorksheets);
  return wb.worksheets.map((ws) => {
    const { rows, formulas } = sheetMatrixWithFormulas(ws, opts);
    return { name: ws.name.trim(), hidden: ws.state !== 'visible', rows, ...(formulas.length > 0 ? { formulas } : {}) };
  });
}

export async function readTable(content: Buffer, fileName: string, maxRows = MAX_IMPORT_ROWS, locator?: HeaderLocator): Promise<ReadTable> {
  const ext = path.extname(fileName).toLowerCase();
  if (!content.length) throw Errors.validation('上传文件为空');
  if (ext === '.csv') {
    let text: string;
    try {
      text = new TextDecoder('utf-8', { fatal: true }).decode(content);
    } catch {
      throw Errors.validation('CSV 必须使用 UTF-8 编码');
    }
    const matrix = parseCsv(text.replace(/^﻿/, '')).map((cells, i) => ({ rowNo: i + 1, cells }));
    if (matrix.length > maxRows + 1 + 1000) throw Errors.validation(`数据行超过安全上限 ${maxRows} 行(不含表头)`);
    return toTable(matrix, maxRows, locator);
  }
  if (ext === '.xlsx') {
    const wb = await loadWorkbook(content, maxRows);
    const sheet = wb.worksheets[0];
    if (!sheet) throw Errors.validation('工作簿没有工作表');
    return toTable(sheetMatrixWithFormulas(sheet).rows, maxRows, locator);
  }
  if (ext === '.xls') {
    const sheets = readXlsWorkbookSheets(content, maxRows, MAX_WORKBOOK_SHEETS);
    const sheet = sheets[0];
    if (!sheet) throw Errors.validation('工作簿没有工作表');
    return toTable(sheet.rows, maxRows, { ...locator, isHeader: locator?.isHeader ?? ((cells) => cells.some((c) => c !== '')), allowDuplicateHeaders: locator?.allowDuplicateHeaders ?? true });
  }
  throw Errors.validation('仅支持 .csv、.xlsx 或 .xls 文件');
}
