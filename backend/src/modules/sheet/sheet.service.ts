import type { DB } from '../../db/connection';
import { Errors } from '../../core/errors';
import { writeLog } from '../audit/log';

/**
 * 预设表(模板表格)注册:每张表 = 科目根编码范围 + 折叠汇总科目。
 * 科目管理按表筛选展示;编制/历史/分析/版本对比按表取数口径。
 * 新增表格为纯配置数据,页面自助维护,无需改代码。
 */

export interface PresetSheetRow {
  id: number;
  code: string;
  name: string;
  root_codes: string; // JSON 数组:科目根编码
  collapsed_codes: string; // JSON 数组:本表内折叠为单行汇总的科目编码
  sort_order: number;
  status: 'active' | 'inactive';
  created_at: string;
  updated_at: string;
}

export interface PresetSheetDto extends Omit<PresetSheetRow, 'root_codes' | 'collapsed_codes'> {
  rootCodes: string[];
  collapsedCodes: string[];
}

const SELECT = 'SELECT id, code, name, root_codes, collapsed_codes, sort_order, status, created_at, updated_at FROM preset_sheet';

function toDto(row: PresetSheetRow): PresetSheetDto {
  let rootCodes: string[] = [];
  let collapsedCodes: string[] = [];
  try { rootCodes = JSON.parse(row.root_codes); } catch { rootCodes = []; }
  try { collapsedCodes = JSON.parse(row.collapsed_codes); } catch { collapsedCodes = []; }
  const { root_codes: _r, collapsed_codes: _c, ...rest } = row;
  void _r; void _c;
  return { ...rest, rootCodes, collapsedCodes };
}

export function listSheets(db: DB): PresetSheetDto[] {
  const rows = db.prepare(`${SELECT} ORDER BY sort_order, id`).all() as PresetSheetRow[];
  return rows.map(toDto);
}

function assertCodesExist(db: DB, codes: string[], field: string): void {
  if (!Array.isArray(codes) || codes.some((c) => typeof c !== 'string')) {
    throw Errors.validation(`${field} 必须是科目编码数组`);
  }
  const known = new Set((db.prepare('SELECT code FROM account').all() as { code: string }[]).map((r) => r.code));
  const unknown = codes.filter((c) => !known.has(c));
  if (unknown.length) throw Errors.validation(`${field} 引用了不存在的科目编码: ${unknown.join(', ')}`);
}

function assertUniqueCodes(codes: string[]): void {
  if (new Set(codes).size !== codes.length) throw Errors.validation('编码数组内存在重复');
}

export function createSheet(
  db: DB,
  input: { code: string; name: string; rootCodes: string[]; collapsedCodes?: string[]; sortOrder?: number }
): PresetSheetDto {
  if (!input.code?.trim()) throw Errors.validation('表格编码不能为空');
  if (!input.name?.trim()) throw Errors.validation('表格名称不能为空');
  if (db.prepare('SELECT 1 FROM preset_sheet WHERE code = ?').get(input.code.trim())) {
    throw Errors.conflict(`表格编码 ${input.code.trim()} 已存在`);
  }
  if (!Array.isArray(input.rootCodes) || input.rootCodes.length === 0) throw Errors.validation('至少选择一个科目根');
  assertUniqueCodes(input.rootCodes);
  assertCodesExist(db, input.rootCodes, '科目根');
  const collapsed = input.collapsedCodes ?? [];
  assertUniqueCodes(collapsed);
  assertCodesExist(db, collapsed, '折叠科目');
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    const info = db
      .prepare('INSERT INTO preset_sheet (code, name, root_codes, collapsed_codes, sort_order, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(input.code.trim(), input.name.trim(), JSON.stringify(input.rootCodes), JSON.stringify(collapsed), input.sortOrder ?? 0, 'active', now, now);
    const id = Number(info.lastInsertRowid);
    writeLog(db, 'sheet.create', 'preset_sheet', id, { code: input.code.trim(), name: input.name.trim(), rootCodes: input.rootCodes, collapsedCodes: collapsed });
    return id;
  });
  const id = tx();
  return toDto(db.prepare(`${SELECT} WHERE id = ?`).get(id) as PresetSheetRow);
}

export function updateSheet(
  db: DB,
  id: number,
  input: { name?: string; rootCodes?: string[]; collapsedCodes?: string[]; sortOrder?: number }
): PresetSheetDto {
  const row = db.prepare(`${SELECT} WHERE id = ?`).get(id) as PresetSheetRow | undefined;
  if (!row) throw Errors.notFound('预设表');
  if (input.name !== undefined && !input.name.trim()) throw Errors.validation('表格名称不能为空');
  if (input.rootCodes !== undefined) {
    if (input.rootCodes.length === 0) throw Errors.validation('至少选择一个科目根');
    assertUniqueCodes(input.rootCodes);
    assertCodesExist(db, input.rootCodes, '科目根');
  }
  if (input.collapsedCodes !== undefined) {
    assertUniqueCodes(input.collapsedCodes);
    assertCodesExist(db, input.collapsedCodes, '折叠科目');
  }
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare('UPDATE preset_sheet SET name = ?, root_codes = ?, collapsed_codes = ?, sort_order = ?, updated_at = ? WHERE id = ?').run(
      input.name !== undefined ? input.name.trim() : row.name,
      input.rootCodes !== undefined ? JSON.stringify(input.rootCodes) : row.root_codes,
      input.collapsedCodes !== undefined ? JSON.stringify(input.collapsedCodes) : row.collapsed_codes,
      input.sortOrder ?? row.sort_order,
      now,
      id
    );
    writeLog(db, 'sheet.update', 'preset_sheet', id, { name: input.name, rootCodes: input.rootCodes, collapsedCodes: input.collapsedCodes });
  })();
  return toDto(db.prepare(`${SELECT} WHERE id = ?`).get(id) as PresetSheetRow);
}

export function deleteSheet(db: DB, id: number): void {
  const row = db.prepare(`${SELECT} WHERE id = ?`).get(id) as PresetSheetRow | undefined;
  if (!row) throw Errors.notFound('预设表');
  db.transaction(() => {
    db.prepare('DELETE FROM preset_sheet WHERE id = ?').run(id);
    writeLog(db, 'sheet.delete', 'preset_sheet', id, { code: row.code, name: row.name });
  })();
}
