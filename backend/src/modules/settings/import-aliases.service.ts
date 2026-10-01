/**
 * 导入字段模板(T-7,AC-F23,对应 lishui sys_import_field_template):为解析器目标字段追加表头别名。
 *
 * - 只扩展“表头 → 字段”的识别,不改变字段类型、必填与换算口径(这些仍由解析器固定);
 * - 别名与任一内置别名或同类型其他有效别名相同即拒绝,避免一列命中两个字段;
 * - 类型/目标/别名建立后不可改,停用代替删除;解析时只取有效别名。
 */
import type { DB } from '../../db/connection';
import { AppError, Errors } from '../../core/errors';
import { writeLog } from '../audit/log';
import { headerKey } from '../io/cell-values';
import { EAS_FIELD_CATALOG } from '../eas/eas.parse';
import { PLAN_FIELDS, PLAN_ID_COLUMNS, type PlanExtraAliases } from '../plan-execution/plan.parse';
import { PLAN_SHEETS, PLAN_SHEET_LABELS, type PlanSheetCode } from '../../contracts/plan-execution';
import type { EasDataType } from '../../contracts/eas';
import type { ImportAliasCreate, ImportAliasDataType, ImportAliasDto, ImportAliasUpdate, ImportTargetCatalogDto } from '../../contracts/system-settings';

const PLAN_ID_LABELS: Record<keyof typeof PLAN_ID_COLUMNS, string> = { seq: '序号', projectCode: '项目编码', name: '名称', orgName: '承办单位' };
const EAS_LABELS: Record<EasDataType, string> = { voucher: 'EAS 凭证', balance: 'EAS 科目余额', auxiliary: 'EAS 辅助余额' };

function catalog(): ImportTargetCatalogDto[] {
  const eas = (Object.keys(EAS_FIELD_CATALOG) as EasDataType[]).map((t) => ({
    dataType: `eas_${t}` as ImportAliasDataType, label: EAS_LABELS[t],
    fields: EAS_FIELD_CATALOG[t].map((f) => ({ key: f.key, label: f.label, required: f.required, builtinAliases: [...new Set(f.aliases)] })),
  }));
  const plan = PLAN_SHEETS.map((sheet) => ({
    dataType: `plan_${sheet}` as ImportAliasDataType, label: `计划执行·${PLAN_SHEET_LABELS[sheet]}`,
    fields: [
      ...(Object.keys(PLAN_ID_COLUMNS) as (keyof typeof PLAN_ID_COLUMNS)[]).map((k) => ({
        key: k, label: PLAN_ID_LABELS[k], required: k === 'name' || (sheet === 'investment' && k === 'projectCode'), builtinAliases: [...PLAN_ID_COLUMNS[k]],
      })),
      ...PLAN_FIELDS[sheet].map((f) => ({ key: f.key, label: f.label, required: f.key === 'annual_plan', builtinAliases: [...f.aliases] })),
    ],
  }));
  return [...eas, ...plan];
}
const CATALOG = catalog();
export function importTargetCatalog(): ImportTargetCatalogDto[] { return CATALOG; }

/** 与解析器一致的表头规整:EAS 只去空白;计划执行去空白、括注与 * : 标记。 */
const normalizeAlias = (dataType: ImportAliasDataType, alias: string) => (dataType.startsWith('plan_') ? headerKey(alias) : alias.replace(/\s+/g, ''));

interface AliasRow {
  id: number; data_type: ImportAliasDataType; target_field: string; source_alias: string; note: string; status: 'active' | 'inactive';
  version: number; created_at: string; updated_at: string;
}
const toDto = (r: AliasRow): ImportAliasDto => ({
  id: r.id, dataType: r.data_type, targetField: r.target_field,
  targetLabel: CATALOG.find((c) => c.dataType === r.data_type)?.fields.find((f) => f.key === r.target_field)?.label ?? r.target_field,
  sourceAlias: r.source_alias, note: r.note, status: r.status, version: r.version, createdAt: r.created_at, updatedAt: r.updated_at,
});

export function listImportAliases(db: DB, q: { dataType?: ImportAliasDataType } = {}): ImportAliasDto[] {
  const rows = (q.dataType
    ? db.prepare('SELECT * FROM sys_import_field_alias WHERE data_type = ? ORDER BY target_field, id').all(q.dataType)
    : db.prepare('SELECT * FROM sys_import_field_alias ORDER BY data_type, target_field, id').all()) as AliasRow[];
  return rows.map(toDto);
}

function row(db: DB, id: number): AliasRow {
  const r = db.prepare('SELECT * FROM sys_import_field_alias WHERE id = ?').get(id) as AliasRow | undefined;
  if (!r) throw Errors.notFound('导入字段别名');
  return r;
}

export function createImportAlias(db: DB, input: ImportAliasCreate): ImportAliasDto {
  const entry = CATALOG.find((c) => c.dataType === input.dataType)!;
  const field = entry.fields.find((f) => f.key === input.targetField);
  if (!field) throw Errors.validation(`${entry.label}没有目标字段 ${input.targetField}`);
  const alias = normalizeAlias(input.dataType, input.sourceAlias);
  if (!alias) throw Errors.validation('表头别名规整后为空(括注与 * : 会被忽略)');
  const builtin = entry.fields.find((f) => f.builtinAliases.some((a) => normalizeAlias(input.dataType, a) === alias));
  if (builtin) throw new AppError('DUPLICATE', `“${alias}”已是字段“${builtin.label}”的内置表头`, 409);
  const id = db.transaction(() => {
    const dup = db.prepare('SELECT target_field, status FROM sys_import_field_alias WHERE data_type = ? AND source_alias = ?').get(input.dataType, alias) as
      { target_field: string; status: string } | undefined;
    if (dup) throw new AppError('DUPLICATE', `“${alias}”已登记为字段 ${dup.target_field} 的别名${dup.status === 'inactive' ? '(已停用,可重新启用)' : ''}`, 409);
    const now = new Date().toISOString();
    const newId = Number(db.prepare(`INSERT INTO sys_import_field_alias (data_type, target_field, source_alias, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(input.dataType, input.targetField, alias, input.note ?? '', now, now).lastInsertRowid);
    writeLog(db, 'settings.import_alias.create', 'sys_import_field_alias', newId, { dataType: input.dataType, targetField: input.targetField, sourceAlias: alias });
    return newId;
  })();
  return toDto(row(db, id));
}

export function updateImportAlias(db: DB, id: number, input: ImportAliasUpdate): ImportAliasDto {
  db.transaction(() => {
    const r = row(db, id);
    if (r.version !== input.expectedVersion) throw new AppError('VERSION_CONFLICT', '别名已被其他人更新,请刷新后重试', 409, undefined, { currentVersion: r.version });
    const status = input.status ?? r.status;
    db.prepare('UPDATE sys_import_field_alias SET note = ?, status = ?, version = version + 1, updated_at = ? WHERE id = ?')
      .run(input.note ?? r.note, status, new Date().toISOString(), id);
    const action: `settings.import_alias.${string}` = status !== r.status ? `settings.import_alias.${status === 'inactive' ? 'deactivate' : 'activate'}` : 'settings.import_alias.update';
    writeLog(db, action, 'sys_import_field_alias', id, { dataType: r.data_type, targetField: r.target_field, sourceAlias: r.source_alias });
  })();
  return toDto(row(db, id));
}

function activeAliases(db: DB, dataType: ImportAliasDataType): Record<string, string[]> {
  const out: Record<string, string[]> = {};
  for (const r of db.prepare("SELECT target_field, source_alias FROM sys_import_field_alias WHERE data_type = ? AND status = 'active' ORDER BY id").all(dataType) as { target_field: string; source_alias: string }[]) {
    (out[r.target_field] ??= []).push(r.source_alias);
  }
  return out;
}

/** EAS 解析用:字段 key → 追加别名。 */
export function easExtraAliases(db: DB, dataType: EasDataType): Record<string, string[]> {
  return activeAliases(db, `eas_${dataType}`);
}

/** 计划执行解析用:表 → 字段 key → 追加别名。 */
export function planExtraAliases(db: DB): PlanExtraAliases {
  return Object.fromEntries(PLAN_SHEETS.map((s: PlanSheetCode) => [s, activeAliases(db, `plan_${s}`)]));
}
