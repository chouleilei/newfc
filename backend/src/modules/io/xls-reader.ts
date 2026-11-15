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
import type { FormulaCellRef, MatrixRow, ReadSheet, WorkbookReadOptions } from './table-reader';

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
  opts?: WorkbookReadOptions,
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
    const formulas: FormulaCellRef[] = [];
    // 按实际单元格遍历，避免稀疏 !ref 扩大为数百万次空网格扫描。
    const rowCells = new Map<number, Map<number, string>>();
    for (const addr of Object.keys(ws)) {
        if (!/^[A-Z]+[1-9]\d*$/.test(addr)) continue;
        const position = XLSX.utils.decode_cell(addr);
        const r = position.r; const offset = position.c - range.s.c;
        if (r < range.s.r || r > range.e.r || offset < 0 || offset >= totalCols) continue;
        const cell = ws[addr] as XLSX.CellObject;
        if ((cell?.f && typeof cell.f === 'string') || cell?.t === 'e') {
          const cacheIssue = cell.t === 'e' ? 'error_value' : cell.v == null ? 'missing_cache' : undefined;
          formulas.push({ rowNo: r + 1, colIndex: offset, address: addr, formula: cell.f ?? '', ...(cacheIssue ? { cacheIssue } : {}) });
          if (cacheIssue) {
            const message = `公式单元格 ${rawName}!${addr} ${cell.t === 'e' ? '计算错误' : '缺少缓存计算值'}`;
            if (!opts?.allowUncachedFormulas) throw Errors.validation(message);
            opts.warnings?.push(message);
          }
        }
        const text = formatXlsCell(cell);
        if (text === '') continue;
        const entries = rowCells.get(r) ?? new Map<number, string>();
        entries.set(offset, text); rowCells.set(r, entries);
    }
    for (const [r, entries] of [...rowCells].sort(([a], [b]) => a - b)) {
      if (rows.length >= maxRows + 50) {
        throw Errors.validation(`工作表“${rawName}”非空行数超过安全上限 ${maxRows} 行`);
      }
      const cells = Array.from({ length: totalCols }, (_, offset) => entries.get(offset) ?? '');
      rows.push({ rowNo: r + 1, cells });
    }
    out.push({ name: rawName.trim(), hidden, rows, ...(formulas.length > 0 ? { formulas } : {}) });
  });

  return out;
}
