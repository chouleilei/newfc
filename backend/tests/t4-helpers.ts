/** T-4 测试公共夹具:xlsx 构造、项目/供应商主数据、事实表快照。 */
import ExcelJS from 'exceljs';
import type { DB } from '../src/db/connection';
import { json, post, type Session } from './t3-helpers';

export type Cell = string | number | null;

/** 多工作表 xlsx:{ 表名: 行矩阵 }。 */
export async function xlsxSheets(sheets: Record<string, Cell[][]>): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  for (const [name, rows] of Object.entries(sheets)) {
    const ws = wb.addWorksheet(name);
    for (const r of rows) ws.addRow(r.map((c) => (c === null ? undefined : c)));
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

export const xlsx = (rows: Cell[][]) => xlsxSheets({ Sheet1: rows });

export async function createProject(base: string, s: Session, code: string, name: string, orgId: number): Promise<number> {
  const res = await post(base, s, '/api/master/projects', { code, name, orgId });
  if (res.status !== 201 && res.status !== 200) throw new Error(`create project ${code}: ${res.status} ${await res.text()}`);
  return (await json(res)).id;
}

export async function createSupplier(base: string, s: Session, code: string, name: string): Promise<number> {
  const res = await post(base, s, '/api/master/suppliers', { code, name });
  if (res.status !== 201 && res.status !== 200) throw new Error(`create supplier ${code}: ${res.status} ${await res.text()}`);
  return (await json(res)).id;
}

/** 经营预算与实际数相关表的行数与内容摘要,用于核对“导入前后不变”。 */
export function factTablesDigest(db: DB): Record<string, string> {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND (name LIKE 'budget%' OR name LIKE 'actual%')").all() as { name: string }[]).map((t) => t.name);
  const out: Record<string, string> = {};
  for (const t of tables) out[t] = JSON.stringify(db.prepare(`SELECT * FROM "${t}" ORDER BY rowid`).safeIntegers(true).all(), (_k, v) => (typeof v === 'bigint' ? v.toString() : v));
  return out;
}

export const count = (db: DB, table: string, where = '1=1', ...params: unknown[]) =>
  (db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE ${where}`).get(...params) as { c: number }).c;
