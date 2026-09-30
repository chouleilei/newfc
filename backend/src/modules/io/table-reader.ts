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
import { MAX_IMPORT_ROWS } from './import-limits';
import { assertSafeXlsx } from './xlsx-guard';

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

function cellText(cell: ExcelJS.Cell): string {
  const value = cell.value;
  if (value == null) return '';
  if (typeof value === 'number') return String(Number(value.toPrecision(15)));
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  if (typeof value === 'object') {
    if ('formula' in value || 'sharedFormula' in value) {
      const result = (value as ExcelJS.CellFormulaValue).result;
      if (result == null) throw Errors.validation(`公式单元格 ${cell.address} 缺少缓存计算值,请在 Excel 中重新计算保存后上传`);
      if (typeof result === 'number') return String(Number(result.toPrecision(15)));
      if (result instanceof Date) return result.toISOString().slice(0, 10);
      if (typeof result === 'object' && 'error' in result) throw Errors.validation(`单元格 ${cell.address} 是错误值 ${result.error}`);
      return String(result).trim();
    }
    if ('richText' in value) return value.richText.map((part) => part.text).join('').trim();
    if ('text' in value) return String(value.text).trim();
    if ('error' in value) throw Errors.validation(`单元格 ${cell.address} 是错误值 ${value.error}`);
  }
  return String(value).trim();
}

function normalizeHeader(value: string): string {
  return value.replace(/^﻿/, '').replace(/\s+/g, '').trim();
}

export interface MatrixRow { rowNo: number; cells: string[] }
export interface ReadSheet { name: string; hidden: boolean; rows: MatrixRow[] }
/** 表头定位:缺省取第一个非空行;给出 isHeader 时在前 within 行内找第一行满足条件的行(模板常有标题/单位行)。 */
export interface HeaderLocator { isHeader: (cells: string[]) => boolean; within?: number; label?: string }

function toTable(matrix: MatrixRow[], maxRows: number, locator?: HeaderLocator): ReadTable {
  const headerIndex = locator
    ? matrix.slice(0, locator.within ?? 20).findIndex((r) => locator.isHeader(r.cells.map(normalizeHeader)))
    : matrix.findIndex((r) => r.cells.some((c) => c.trim() !== ''));
  if (headerIndex < 0) throw Errors.validation(locator ? `前 ${locator.within ?? 20} 行内未找到${locator.label ?? '表头'}` : '文件没有表头');
  const headers = matrix[headerIndex].cells.map(normalizeHeader);
  const seen = new Set<string>();
  for (const h of headers) {
    if (!h) continue;
    if (seen.has(h)) throw Errors.validation(`表头“${h}”重复`);
    seen.add(h);
  }
  const rows: TableRow[] = [];
  for (const r of matrix.slice(headerIndex + 1)) {
    if (!r.cells.some((c) => c.trim() !== '')) continue;
    if (rows.length >= maxRows) throw Errors.validation(`数据行超过安全上限 ${maxRows} 行(不含表头)`);
    const values: Record<string, string> = {};
    headers.forEach((h, i) => { if (h) values[h] = (r.cells[i] ?? '').trim(); });
    rows.push({ rowNo: r.rowNo, values });
  }
  return { headers: headers.filter(Boolean), rows, headerRowNo: matrix[headerIndex].rowNo };
}

export function normalizeHeaderText(value: string): string {
  return normalizeHeader(value);
}

/** 已读入的工作表矩阵 → 表头 + 文本行(多 sheet 模板逐表调用)。 */
export function sheetTable(sheet: ReadSheet, locator?: HeaderLocator, maxRows = MAX_IMPORT_ROWS): ReadTable {
  return toTable(sheet.rows, maxRows, locator);
}

async function loadWorkbook(content: Buffer, maxRows: number): Promise<ExcelJS.Workbook> {
  if (!content.length) throw Errors.validation('上传文件为空');
  await assertSafeXlsx(content, maxRows);
  const wb = new ExcelJS.Workbook();
  try {
    await wb.xlsx.load(content as unknown as ExcelJS.Buffer);
  } catch {
    throw Errors.validation('不是有效的 xlsx 文件');
  }
  return wb;
}

function sheetMatrix(sheet: ExcelJS.Worksheet): MatrixRow[] {
  const matrix: MatrixRow[] = [];
  // 隐藏行同样读入:原始事实不能因为显示状态被静默丢弃
  sheet.eachRow({ includeEmpty: false }, (row, rowNo) => {
    const cells: string[] = [];
    for (let c = 1; c <= sheet.columnCount; c++) cells.push(cellText(row.getCell(c)));
    matrix.push({ rowNo, cells });
  });
  return matrix;
}

/** 读取 xlsx 全部工作表为文本矩阵(含隐藏表,由调用方决定是否忽略并列出)。 */
export async function readWorkbookSheets(content: Buffer, maxRows = MAX_IMPORT_ROWS): Promise<ReadSheet[]> {
  const wb = await loadWorkbook(content, maxRows);
  return wb.worksheets.map((ws) => ({ name: ws.name.trim(), hidden: ws.state !== 'visible', rows: sheetMatrix(ws) }));
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
    return toTable(sheetMatrix(sheet), maxRows, locator);
  }
  throw Errors.validation('仅支持 .csv 或 .xlsx 文件');
}
