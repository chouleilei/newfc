import type { DB } from '../../../db/connection';
import { Errors } from '../../../core/errors';
import { writeLog } from '../../audit/log';
import type { CleaningTargetKind } from './plan';

export interface ImportMappingTemplateRow {
  id: number;
  name: string;
  target_kind: CleaningTargetKind;
  config_json: string;
  created_by: string;
  created_at: string;
  updated_at: string;
}

function targetKind(value: unknown): CleaningTargetKind {
  if (value !== 'budget' && value !== 'actual-current') throw Errors.validation('targetKind 必须为 budget 或 actual-current');
  return value;
}

function name(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw Errors.validation('模板名称不能为空');
  if (value.trim().length > 100) throw Errors.validation('模板名称不能超过 100 字符');
  return value.trim();
}

/** 模板只保存结构配置；批次目标、金额数据、绝对结束行和本次绝对排除行一律剔除。 */
function templateConfig(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw Errors.validation('config 必须是对象');
  const input = value as Record<string, unknown>;
  const allowed = new Set(['preferredSheetName', 'sheetNamePattern', 'headerRow', 'dataStartRow', 'columns', 'valueKind', 'amountUnit', 'signConvention', 'filterRules', 'multiSheet', 'clearBlankNotes']);
  const config = Object.fromEntries(Object.entries(input).filter(([key]) => allowed.has(key)));
  if (!Array.isArray(config.columns) || config.columns.length < 3) throw Errors.validation('模板 config.columns 至少包含组织、科目和值列映射');
  const serialized = JSON.stringify(config);
  if (Buffer.byteLength(serialized, 'utf8') > 100 * 1024) throw Errors.validation('模板配置不能超过 100KB');
  return config;
}

export function listTemplates(db: DB, filter?: CleaningTargetKind): ImportMappingTemplateRow[] {
  return (filter
    ? db.prepare('SELECT * FROM import_mapping_template WHERE target_kind = ? ORDER BY updated_at DESC, id DESC').all(filter)
    : db.prepare('SELECT * FROM import_mapping_template ORDER BY updated_at DESC, id DESC').all()) as ImportMappingTemplateRow[];
}

export function getTemplate(db: DB, id: number): ImportMappingTemplateRow {
  const row = db.prepare('SELECT * FROM import_mapping_template WHERE id = ?').get(id) as ImportMappingTemplateRow | undefined;
  if (!row) throw Errors.notFound('导入模板');
  return row;
}

export function createTemplate(db: DB, input: { name?: unknown; targetKind?: unknown; config?: unknown }, actor = ''): ImportMappingTemplateRow {
  const now = new Date().toISOString();
  const config = templateConfig(input.config);
  const info = db.transaction(() => {
    const result = db.prepare(
      `INSERT INTO import_mapping_template(name, target_kind, config_json, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(name(input.name), targetKind(input.targetKind), JSON.stringify(config), actor, now, now);
    const id = Number(result.lastInsertRowid);
    writeLog(db, 'template.create', 'import_mapping_template', id, { actor });
    return result;
  })();
  return getTemplate(db, Number(info.lastInsertRowid));
}

export function updateTemplate(db: DB, id: number, input: { name?: unknown; targetKind?: unknown; config?: unknown }, actor = ''): ImportMappingTemplateRow {
  const old = getTemplate(db, id);
  const nextName = input.name === undefined ? old.name : name(input.name);
  const nextKind = input.targetKind === undefined ? old.target_kind : targetKind(input.targetKind);
  const nextConfig = input.config === undefined ? JSON.parse(old.config_json) as Record<string, unknown> : templateConfig(input.config);
  db.transaction(() => {
    db.prepare('UPDATE import_mapping_template SET name = ?, target_kind = ?, config_json = ?, updated_at = ? WHERE id = ?')
      .run(nextName, nextKind, JSON.stringify(nextConfig), new Date().toISOString(), id);
    writeLog(db, 'template.update', 'import_mapping_template', id, { actor });
  })();
  return getTemplate(db, id);
}

export function deleteTemplate(db: DB, id: number, actor = ''): void {
  getTemplate(db, id);
  db.transaction(() => {
    db.prepare('DELETE FROM import_mapping_template WHERE id = ?').run(id);
    writeLog(db, 'template.delete', 'import_mapping_template', id, { actor });
  })();
}
