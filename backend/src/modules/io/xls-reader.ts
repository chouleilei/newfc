/**
 * 受控 .xls (BIFF8 / OLE2) 纯数据矩阵读取器（基于离线锁定 xlsx@0.20.3）。
 *
 * 安全门禁：
 * 1. 强制校验头部 8 字节 OLE2 魔数（D0 CF 11 E0 A1 B1 1A E1）与最大上传字节数；
 * 2. 禁用宏（bookVBA: false）、HTML 富文本（cellHTML: false）与公式动态求值；
 * 3. 限制工作表页数上限（默认 40，历史台账迁移可显式传 MAX_LEGACY_SHEETS=100）与单表最大行数；
 * 4. 剥离 __proto__ / constructor / prototype 危险属性键；日期走 SSF.parse_date_code 避免本地时区偏移。
 */
import * as XLSX from 'xlsx';
import { Errors } from '../../core/errors';
import { MAX_IMPORT_ROWS, MAX_UPLOAD_BYTES, MAX_WORKBOOK_SHEETS } from './import-limits';
import type { MatrixRow, ReadSheet } from './table-reader';

export const OLE2_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
const FORBIDDEN_KEYS = new Set(['__proto__', 'constructor', 'prototype']);

export function isOle2Buffer(content: Buffer): boolean {
  return content.length >= 8 && content.subarray(0, 8).equals(OLE2_MAGIC);
}

function formatXlsCell(cell: XLSX.CellObject | undefined): string {
  if (!cell || cell.t === 'z') return '';
  if (cell.t === 'e') {
    return typeof cell.w === 'string' && cell.w.trim() ? cell.w.trim() : '#ERROR!';
  }
  if (cell.t === 'b') {
    return cell.v ? 'TRUE' : 'FALSE';
  }
  if (cell.t === 'd' && cell.v instanceof Date) {
    return cell.v.toISOString().slice(0, 10);
  }
  if (cell.t === 'n') {
    const num = Number(cell.v);
    if (!Number.isFinite(num)) return '';
    const fmt = typeof cell.z === 'string' ? cell.z : '';
    if (fmt && XLSX.SSF.is_date(fmt) && num > 0 && num < 2958465) {
      const parsed = XLSX.SSF.parse_date_code(num);
      if (parsed && parsed.y >= 1900 && parsed.m >= 1 && parsed.d >= 1) {
        return `${String(parsed.y).padStart(4, '0')}-${String(parsed.m).padStart(2, '0')}-${String(parsed.d).padStart(2, '0')}`;
      }
    }
    return String(Number(num.toPrecision(15)));
  }
  return String(cell.v ?? cell.w ?? '').trim();
}

export function readXlsWorkbookSheets(
  content: Buffer,
  maxRows = MAX_IMPORT_ROWS,
  maxWorksheets = MAX_WORKBOOK_SHEETS,
): ReadSheet[] {
  if (!content.length) throw Errors.validation('上传文件为空');
  if (content.length > MAX_UPLOAD_BYTES) {
    throw Errors.validation(`文件体积超过安全上限 ${MAX_UPLOAD_BYTES} 字节`);
  }
  if (!isOle2Buffer(content)) {
    throw Errors.validation('不是有效的 .xls (OLE2/BIFF8) 文件');
  }

  let wb: XLSX.WorkBook;
  try {
    wb = XLSX.read(content, {
      type: 'buffer',
      cellFormula: true,
      cellHTML: false,
      cellStyles: false,
      cellNF: true,
      cellDates: false,
      bookVBA: false,
      WTF: false,
    });
  } catch {
    throw Errors.validation('无法解析 .xls 工作簿，文件可能已损坏或受密码保护');
  }

  const sheetNames = wb.SheetNames ?? [];
  if (sheetNames.length === 0) throw Errors.validation('工作簿没有工作表');
  if (sheetNames.length > maxWorksheets) {
    throw Errors.validation(`工作表数量 ${sheetNames.length} 超过安全上限 ${maxWorksheets}`);
  }

  const sheetMeta = wb.Workbook?.Sheets ?? [];
  const out: ReadSheet[] = [];

  sheetNames.forEach((rawName, idx) => {
    if (FORBIDDEN_KEYS.has(rawName)) {
      throw Errors.validation('工作表名称包含非法保留键');
    }
    const ws = wb.Sheets[rawName];
    const hidden = Boolean(sheetMeta[idx]?.Hidden);
    if (!ws || !ws['!ref']) {
      out.push({ name: rawName.trim(), hidden, rows: [] });
      return;
    }
    const range = XLSX.utils.decode_range(ws['!ref']);
    const totalCols = Math.min(range.e.c - range.s.c + 1, 256);
    const rows: MatrixRow[] = [];
    for (let r = range.s.r; r <= range.e.r; r++) {
      const cells: string[] = [];
      let hasNonEmpty = false;
      for (let offset = 0; offset < totalCols; offset++) {
        const addr = XLSX.utils.encode_cell({ r, c: range.s.c + offset });
        const cell = Object.prototype.hasOwnProperty.call(ws, addr) ? (ws[addr] as XLSX.CellObject) : undefined;
        const text = formatXlsCell(cell);
        if (text !== '') hasNonEmpty = true;
        cells.push(text);
      }
      if (!hasNonEmpty) continue;
      if (rows.length >= maxRows + 50) {
        throw Errors.validation(`工作表“${rawName}”非空行数超过安全上限 ${maxRows} 行`);
      }
      rows.push({ rowNo: r + 1, cells });
    }
    out.push({ name: rawName.trim(), hidden, rows });
  });

  return out;
}
