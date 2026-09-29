import ExcelJS from 'exceljs';
import { Errors } from '../../../core/errors';
import { assertSafeXlsx } from '../xlsx-guard';
import { MAX_CLEANING_COLUMNS, MAX_CLEANING_SHEETS, MAX_IMPORT_ROWS } from '../import-limits';

export interface WorkbookCellPreview {
  column: number;
  address: string;
  text: string;
  formula: boolean;
  merged: boolean;
}

export interface WorkbookRowPreview {
  row: number;
  hidden: boolean;
  cells: WorkbookCellPreview[];
}

export interface WorkbookSheetSummary {
  name: string;
  state: 'visible' | 'hidden' | 'veryHidden';
  rowCount: number;
  columnCount: number;
  mergedRangeCount: number;
  formulaCellCount: number;
  hiddenRowCount: number;
  hiddenColumnCount: number;
  sampleRows: WorkbookRowPreview[];
}

export interface WorkbookInspection {
  sheets: WorkbookSheetSummary[];
}

export async function loadCleaningWorkbook(buffer: Buffer): Promise<ExcelJS.Workbook> {
  await assertSafeXlsx(buffer, MAX_IMPORT_ROWS, MAX_CLEANING_SHEETS);
  const workbook = new ExcelJS.Workbook();
  try {
    await workbook.xlsx.load(buffer as unknown as ExcelJS.Buffer);
  } catch {
    throw Errors.validation('不是有效的 xlsx 文件');
  }
  if (workbook.worksheets.length < 1) throw Errors.validation('Excel 中没有工作表');
  if (workbook.worksheets.length > MAX_CLEANING_SHEETS) throw Errors.validation(`工作表数量不能超过 ${MAX_CLEANING_SHEETS} 个`);
  for (const sheet of workbook.worksheets) {
    if (sheet.columnCount > MAX_CLEANING_COLUMNS) throw Errors.validation(`工作表“${sheet.name}”有效列超过 ${MAX_CLEANING_COLUMNS} 列`);
    if (sheet.rowCount > MAX_IMPORT_ROWS) throw Errors.validation(`工作表“${sheet.name}”超过 ${MAX_IMPORT_ROWS} 行`);
  }
  return workbook;
}

export function cellHasFormula(cell: ExcelJS.Cell): boolean {
  const value = cell.value;
  return Boolean(value && typeof value === 'object' && ('formula' in value || 'sharedFormula' in value));
}

/** Excel 日期是无时区日历值，固定取 UTC 年月日，避免服务器时区造成前后偏移。 */
export function displayCellValue(cell: ExcelJS.Cell): string {
  const value = cell.value;
  if (value == null) return '';
  if (value instanceof Date) {
    if (Number.isNaN(value.getTime())) return '';
    return `${value.getUTCFullYear()}-${String(value.getUTCMonth() + 1).padStart(2, '0')}-${String(value.getUTCDate()).padStart(2, '0')}`;
  }
  if (typeof value !== 'object') return String(value).trim();
  if ('result' in value) {
    const result = (value as { result?: unknown }).result;
    if (result instanceof Date) {
      return `${result.getUTCFullYear()}-${String(result.getUTCMonth() + 1).padStart(2, '0')}-${String(result.getUTCDate()).padStart(2, '0')}`;
    }
    return result == null ? '' : String(result).trim();
  }
  if ('richText' in value) return (value as { richText?: { text: string }[] }).richText?.map((item) => item.text).join('').trim() ?? '';
  if ('text' in value) return String((value as { text?: unknown }).text ?? '').trim();
  if ('error' in value) return String((value as { error?: unknown }).error ?? '').trim();
  return '';
}

function previewRow(sheet: ExcelJS.Worksheet, rowNumber: number, startColumn: number, endColumn: number): WorkbookRowPreview {
  const row = sheet.getRow(rowNumber);
  const cells: WorkbookCellPreview[] = [];
  for (let column = startColumn; column <= endColumn; column++) {
    const cell = row.getCell(column);
    cells.push({
      column,
      address: cell.address,
      text: displayCellValue(cell),
      formula: cellHasFormula(cell),
      merged: cell.isMerged,
    });
  }
  return { row: rowNumber, hidden: row.hidden === true, cells };
}

/**
 * 采样行号(AI 功能增强计划阶段四.1)。
 *
 * 三段构成,升序去重:
 * - 表头段:前 SAMPLE_HEAD_ROWS 行,定位表头与数据起始行;
 * - 中间段:按等距步进最多取 SAMPLE_MIDDLE_ROWS 行。中间区域原来完全不可见,
 *   而「跨页表头重复、中途小计、中途空段」恰恰只出现在中间;
 * - 表尾段:最后 SAMPLE_TAIL_ROWS 行,定位合计与表尾。
 *
 * 每行的数字在送模型前一律被 numericPlaceholder 脱敏,识别行角色只靠标签文本,
 * 因此扩大行覆盖不会扩大数据外泄面;总行数上限固定,不随工作表规模增长。
 */
export const SAMPLE_HEAD_ROWS = 20;
export const SAMPLE_MIDDLE_ROWS = 30;
export const SAMPLE_TAIL_ROWS = 5;

export function sampleRowNumbers(rowCount: number): number[] {
  if (rowCount <= 0) return [];
  const picked = new Set<number>();
  for (let row = 1; row <= Math.min(rowCount, SAMPLE_HEAD_ROWS); row++) picked.add(row);
  const middleFrom = SAMPLE_HEAD_ROWS + 1;
  const middleTo = rowCount - SAMPLE_TAIL_ROWS;
  const middleCount = middleTo - middleFrom + 1;
  if (middleCount > 0) {
    const take = Math.min(SAMPLE_MIDDLE_ROWS, middleCount);
    // 等距步进:两端都取到,内部均匀铺开
    for (let index = 0; index < take; index++) {
      const offset = take === 1 ? 0 : Math.round((index * (middleCount - 1)) / (take - 1));
      picked.add(middleFrom + offset);
    }
  }
  for (let row = Math.max(1, rowCount - SAMPLE_TAIL_ROWS + 1); row <= rowCount; row++) picked.add(row);
  return [...picked].sort((a, b) => a - b);
}

export function inspectWorkbook(workbook: ExcelJS.Workbook): WorkbookInspection {
  return {
    sheets: workbook.worksheets.map((sheet): WorkbookSheetSummary => {
      let formulaCellCount = 0;
      let hiddenRowCount = 0;
      for (let rowNumber = 1; rowNumber <= sheet.rowCount; rowNumber++) {
        const row = sheet.getRow(rowNumber);
        if (row.hidden) hiddenRowCount++;
        row.eachCell({ includeEmpty: false }, (cell) => { if (cellHasFormula(cell)) formulaCellCount++; });
      }
      let hiddenColumnCount = 0;
      for (let column = 1; column <= sheet.columnCount; column++) if (sheet.getColumn(column).hidden) hiddenColumnCount++;
      const sampleEndColumn = Math.min(Math.max(sheet.columnCount, 1), 30);
      const sampleRows: WorkbookRowPreview[] = [];
      for (const row of sampleRowNumbers(sheet.rowCount)) sampleRows.push(previewRow(sheet, row, 1, sampleEndColumn));
      const model = sheet.model as ExcelJS.WorksheetModel & { merges?: string[] };
      return {
        name: sheet.name,
        state: sheet.state,
        rowCount: sheet.rowCount,
        columnCount: sheet.columnCount,
        mergedRangeCount: model.merges?.length ?? 0,
        formulaCellCount,
        hiddenRowCount,
        hiddenColumnCount,
        sampleRows,
      };
    }),
  };
}

function boundedInt(value: unknown, name: string, fallback?: number): number {
  if ((value === undefined || value === null || value === '') && fallback !== undefined) return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw Errors.validation(`${name} 必须是正整数`);
  return parsed;
}

export interface RegionRequest {
  sheet: string;
  startRow: number;
  endRow: number;
  startCol: number;
  endCol: number;
  page: number;
  pageSize: number;
}

export function parseRegionRequest(query: Record<string, unknown>): RegionRequest {
  if (typeof query.sheet !== 'string' || !query.sheet.trim()) throw Errors.validation('sheet 不能为空');
  const startRow = boundedInt(query.startRow, 'startRow', 1);
  const endRow = boundedInt(query.endRow, 'endRow');
  const startCol = boundedInt(query.startCol, 'startCol', 1);
  const endCol = boundedInt(query.endCol, 'endCol');
  const page = boundedInt(query.page, 'page', 1);
  const pageSize = boundedInt(query.pageSize, 'pageSize', 100);
  if (endRow < startRow) throw Errors.validation('endRow 不能早于 startRow');
  if (endCol < startCol) throw Errors.validation('endCol 不能早于 startCol');
  if (endCol > MAX_CLEANING_COLUMNS) throw Errors.validation(`endCol 不能超过 ${MAX_CLEANING_COLUMNS}`);
  if (endRow - startRow + 1 > MAX_IMPORT_ROWS) throw Errors.validation(`区域行数不能超过 ${MAX_IMPORT_ROWS}`);
  if (pageSize > 200) throw Errors.validation('pageSize 不能超过 200');
  return { sheet: query.sheet.trim(), startRow, endRow, startCol, endCol, page, pageSize };
}

export function readRegion(workbook: ExcelJS.Workbook, request: RegionRequest): { total: number; page: number; pageSize: number; rows: WorkbookRowPreview[] } {
  const sheet = workbook.getWorksheet(request.sheet);
  if (!sheet) throw Errors.notFound('工作表');
  if (request.endRow > sheet.rowCount) throw Errors.validation(`endRow 超出工作表“${sheet.name}”使用范围 ${sheet.rowCount}`);
  if (request.endCol > Math.max(sheet.columnCount, 1)) throw Errors.validation(`endCol 超出工作表“${sheet.name}”使用范围 ${sheet.columnCount}`);
  const total = request.endRow - request.startRow + 1;
  const first = request.startRow + (request.page - 1) * request.pageSize;
  const last = Math.min(request.endRow, first + request.pageSize - 1);
  const rows: WorkbookRowPreview[] = [];
  if (first <= request.endRow) for (let row = first; row <= last; row++) rows.push(previewRow(sheet, row, request.startCol, request.endCol));
  return { total, page: request.page, pageSize: request.pageSize, rows };
}
