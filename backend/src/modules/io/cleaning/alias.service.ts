import { z } from 'zod';
import { aliasFilterSchema, type AliasFilter } from '../../../contracts/list-filters';
import { validateInput } from '../../../core/input';
import type { DB } from '../../../db/connection';
import { Errors } from '../../../core/errors';
import { writeLog } from '../../audit/log';
import { normalizeSourceText, type CleaningTargetKind } from './plan';

export const aliasInputSchema = z.object({ targetKind: z.enum(['budget', 'actual-current', 'finance']).optional(), mappingKind: z.enum(['org', 'account']).optional(), sourceText: z.string().max(500).optional(), targetCode: z.string().max(128).optional() }).strict();


/** 别名去向:清洗导入(budget/actual-current) + 财务转换映射(finance,AI 功能增强计划阶段二.5)。 */
export type AliasTargetKind = CleaningTargetKind | 'finance';

export interface ImportNameAliasRow {
  id: number;
  target_kind: AliasTargetKind;
  mapping_kind: 'org' | 'account';
  source_text: string;
  target_code: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

function parseTargetKind(value: unknown): AliasTargetKind {
  if (value !== 'budget' && value !== 'actual-current' && value !== 'finance') throw Errors.validation('targetKind 必须为 budget、actual-current 或 finance');
  return value;
}

function parseMappingKind(value: unknown): 'org' | 'account' {
  if (value !== 'org' && value !== 'account') throw Errors.validation('mappingKind 必须为 org 或 account');
  return value;
}

function text(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string' || !value.trim()) throw Errors.validation(`${label} 不能为空`);
  if (value.trim().length > max) throw Errors.validation(`${label} 不能超过 ${max} 字符`);
  return value.trim();
}

function assertNormalizedUnique(db: DB, targetKind: AliasTargetKind, mappingKind: 'org' | 'account', sourceText: string, excludeId?: number): void {
  const rows = db.prepare(
    'SELECT id, source_text FROM import_name_alias WHERE target_kind = ? AND mapping_kind = ?',
  ).all(targetKind, mappingKind) as { id: number; source_text: string }[];
  const normalized = normalizeSourceText(sourceText);
  if (rows.some((row) => row.id !== excludeId && normalizeSourceText(row.source_text) === normalized)) throw Errors.conflict('相同源文本已存在别名映射');
}

function aliasWhere(filter: AliasFilter) {
  validateInput(aliasFilterSchema, filter);
  const clauses: string[] = [];
  const params: unknown[] = [];
  if (filter.targetKind) { clauses.push('target_kind = ?'); params.push(filter.targetKind); }
  if (filter.mappingKind) { clauses.push('mapping_kind = ?'); params.push(filter.mappingKind); }
  if (filter.search) { clauses.push('(instr(source_text, ?) > 0 OR instr(target_code, ?) > 0)'); params.push(filter.search, filter.search); }
  return { sql: clauses.length ? 'WHERE ' + clauses.join(' AND ') : '', params };
}
export function countAliases(db: DB, filter: AliasFilter = {}): number {
  const { sql, params } = aliasWhere(filter);
  return (db.prepare('SELECT count(*) count FROM import_name_alias ' + sql).get(...params) as { count: number }).count;
}
export function listAliases(db: DB, filter: AliasFilter = {}, ids?: number[]): ImportNameAliasRow[] {
  const { sql, params } = aliasWhere(filter);
  const idClause = ids ? (sql ? ' AND' : ' WHERE') + ' id IN (' + (ids.map(() => '?').join(',') || 'NULL') + ')' : '';
  return db.prepare('SELECT * FROM import_name_alias ' + sql + idClause + ' ORDER BY updated_at DESC, id DESC')
    .all(...params, ...(ids ?? [])) as ImportNameAliasRow[];
}

export function getAlias(db: DB, id: number): ImportNameAliasRow {
  const row = db.prepare('SELECT * FROM import_name_alias WHERE id = ?').get(id) as ImportNameAliasRow | undefined;
  if (!row) throw Errors.notFound('名称别名');
  return row;
}

/** 规范化重名、目标有效性与保存使用相同校验。 */
export function validateAliasInput(db: DB, input: { targetKind?: unknown; mappingKind?: unknown; sourceText?: unknown; targetCode?: unknown }, id?: number) {
  validateInput(aliasInputSchema, input);
  const old = id == null ? null : getAlias(db, id);
  const kind = parseTargetKind(input.targetKind === undefined ? old?.target_kind : input.targetKind);
  const mapping = parseMappingKind(input.mappingKind === undefined ? old?.mapping_kind : input.mappingKind);
  const source = text(input.sourceText === undefined ? old?.source_text : input.sourceText, 'sourceText', 500);
  const code = text(input.targetCode === undefined ? old?.target_code : input.targetCode, 'targetCode', 128);
  assertNormalizedUnique(db, kind, mapping, source, id);
  const target = db.prepare(`SELECT id, status FROM ${mapping} WHERE code = ?`).get(code) as { id: number; status: string } | undefined;
  if (!target || target.status !== 'active') throw Errors.validation('别名目标不存在或已停用');
  return { kind, mapping, source, code, targetId: target.id };
}

export function createAlias(db: DB, input: { targetKind?: unknown; mappingKind?: unknown; sourceText?: unknown; targetCode?: unknown }, actor = ''): ImportNameAliasRow {
  const { kind, mapping, source, code } = validateAliasInput(db, input);
  const now = new Date().toISOString();
  const id = db.transaction(() => {
    /* 唯一性校验移进事务:此前 assert 在事务外 SELECT,两个并发 create 都通过后各自
       INSERT,产生归一化后重复的别名(表上无唯一约束兜底)。better-sqlite3 单连接串行,
       事务内的 SELECT-then-INSERT 是原子的,第二个请求会读到第一个的结果并冲突。 */
    validateAliasInput(db, input);
    const result = db.prepare(
      `INSERT INTO import_name_alias(target_kind, mapping_kind, source_text, target_code, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    ).run(kind, mapping, source, code, actor, now, now);
    const createdId = Number(result.lastInsertRowid);
    writeLog(db, 'alias.create', 'import_name_alias', createdId, { actor, targetKind: kind, mappingKind: mapping });
    return createdId;
  })();
  return getAlias(db, id);
}

export function updateAlias(db: DB, id: number, input: { targetKind?: unknown; mappingKind?: unknown; sourceText?: unknown; targetCode?: unknown }, actor = ''): ImportNameAliasRow {
  const { kind, mapping, source, code } = validateAliasInput(db, input, id);
  db.transaction(() => {
    /* 唯一性校验移进事务(与 createAlias 同理),避免并发 update 各自通过 SELECT 后都改成功 */
    validateAliasInput(db, input, id);
    db.prepare('UPDATE import_name_alias SET target_kind = ?, mapping_kind = ?, source_text = ?, target_code = ?, updated_at = ? WHERE id = ?')
      .run(kind, mapping, source, code, new Date().toISOString(), id);
    writeLog(db, 'alias.update', 'import_name_alias', id, { actor, targetKind: kind, mappingKind: mapping });
  })();
  return getAlias(db, id);
}

export function deleteAlias(db: DB, id: number, actor = ''): void {
  getAlias(db, id);
  db.transaction(() => {
    db.prepare('DELETE FROM import_name_alias WHERE id = ?').run(id);
    writeLog(db, 'alias.delete', 'import_name_alias', id, { actor });
  })();
}
