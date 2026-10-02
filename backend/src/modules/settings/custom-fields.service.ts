/**
 * 自定义字段(T-7,AC-F23):项目/供应商的扩展字段定义。
 *
 * - 值仍存于 md_project/md_supplier.extra_json,保存时按有效定义校验:必填、文本长度、数值为十进制字符串
 *   (不走浮点)、日期 YYYY-MM-DD、下拉取值须为字典有效项(更新时未改动的旧值即使选项已停用也保留)。
 * - 未定义的键原样保留(兼容历史数据);停用字段不再校验。
 * - 定义的领域、编码、类型不可改(触发器兜底),停用代替删除。
 */
import type { DB } from '../../db/connection';
import { AppError, Errors } from '../../core/errors';
import { writeLog } from '../audit/log';
import { activeDictValues } from '../master/dict.service';
import type { CustomFieldCreate, CustomFieldDomain, CustomFieldDto, CustomFieldType, CustomFieldUpdate } from '../../contracts/system-settings';

interface FieldRow {
  id: number; domain: CustomFieldDomain; field_code: string; field_name: string; field_type: CustomFieldType; required: number;
  dict_type: string | null; description: string; sort_order: number; status: 'active' | 'inactive'; version: number; created_at: string; updated_at: string;
}

function dictOptions(db: DB, dictType: string): { value: string; label: string }[] {
  return (db.prepare("SELECT item_value, item_label FROM md_dict_item WHERE dict_type = ? AND status = 'active' ORDER BY sort_order, id").all(dictType) as
    { item_value: string; item_label: string }[]).map((r) => ({ value: r.item_value, label: r.item_label }));
}

const toDto = (db: DB, r: FieldRow): CustomFieldDto => ({
  id: r.id, domain: r.domain, fieldCode: r.field_code, fieldName: r.field_name, fieldType: r.field_type, required: r.required === 1,
  dictType: r.dict_type, description: r.description, sortOrder: r.sort_order, status: r.status, version: r.version,
  ...(r.dict_type ? { options: dictOptions(db, r.dict_type) } : {}),
  createdAt: r.created_at, updatedAt: r.updated_at,
});

export function listCustomFields(db: DB, q: { domain?: CustomFieldDomain; activeOnly?: boolean } = {}): CustomFieldDto[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.domain) { where.push('domain = ?'); params.push(q.domain); }
  if (q.activeOnly) where.push("status = 'active'");
  return (db.prepare(`SELECT * FROM sys_custom_field ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY domain, sort_order, id`).all(...params) as FieldRow[])
    .map((r) => toDto(db, r));
}

function row(db: DB, id: number): FieldRow {
  const r = db.prepare('SELECT * FROM sys_custom_field WHERE id = ?').get(id) as FieldRow | undefined;
  if (!r) throw Errors.notFound('自定义字段');
  return r;
}

/** 内置字段名(不可用作自定义字段编码,避免与主表字段混淆)。 */
const RESERVED: Record<CustomFieldDomain, string[]> = {
  project: ['id', 'code', 'name', 'project_type', 'org_id', 'status'],
  supplier: ['id', 'code', 'name', 'supplier_type', 'credit_code', 'status'],
};

export function createCustomField(db: DB, input: CustomFieldCreate): CustomFieldDto {
  if (RESERVED[input.domain].includes(input.fieldCode)) throw Errors.validation(`字段编码 ${input.fieldCode} 与内置字段重名`);
  const id = db.transaction(() => {
    if (input.dictType && !db.prepare("SELECT 1 FROM md_dict_item WHERE dict_type = ? AND status = 'active'").get(input.dictType)) {
      throw Errors.validation(`字典类型 ${input.dictType} 没有有效字典项,请先在主数据“字典项”中维护`);
    }
    if (db.prepare('SELECT 1 FROM sys_custom_field WHERE domain = ? AND field_code = ?').get(input.domain, input.fieldCode)) {
      throw new AppError('DUPLICATE', `字段编码 ${input.fieldCode} 已存在`, 409);
    }
    const now = new Date().toISOString();
    const sort = input.sortOrder ?? ((db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 10 AS s FROM sys_custom_field WHERE domain = ?').get(input.domain) as { s: number }).s);
    const newId = Number(db.prepare(`INSERT INTO sys_custom_field (domain, field_code, field_name, field_type, required, dict_type, description, sort_order, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(input.domain, input.fieldCode, input.fieldName, input.fieldType, input.required ? 1 : 0, input.dictType ?? null,
      input.description ?? '', sort, now, now).lastInsertRowid);
    writeLog(db, 'settings.custom_field.create', 'sys_custom_field', newId, { domain: input.domain, fieldCode: input.fieldCode, fieldType: input.fieldType, required: !!input.required });
    return newId;
  })();
  return toDto(db, row(db, id));
}

export function updateCustomField(db: DB, id: number, input: CustomFieldUpdate): CustomFieldDto {
  db.transaction(() => {
    const r = row(db, id);
    if (r.version !== input.expectedVersion) throw new AppError('VERSION_CONFLICT', '自定义字段已被其他人更新,请刷新后重试', 409, undefined, { currentVersion: r.version });
    const next = {
      name: input.fieldName ?? r.field_name, required: input.required === undefined ? r.required : input.required ? 1 : 0,
      description: input.description ?? r.description, sort: input.sortOrder ?? r.sort_order, status: input.status ?? r.status,
    };
    db.prepare('UPDATE sys_custom_field SET field_name = ?, required = ?, description = ?, sort_order = ?, status = ?, version = version + 1, updated_at = ? WHERE id = ?')
      .run(next.name, next.required, next.description, next.sort, next.status, new Date().toISOString(), id);
    const action: `settings.custom_field.${string}` = next.status !== r.status ? `settings.custom_field.${next.status === 'inactive' ? 'deactivate' : 'activate'}` : 'settings.custom_field.update';
    writeLog(db, action, 'sys_custom_field', id, { domain: r.domain, fieldCode: r.field_code, required: next.required === 1 });
  })();
  return toDto(db, row(db, id));
}

const DECIMAL = /^-?\d{1,15}(\.\d{1,6})?$/;
function validDate(v: string): boolean {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(v);
  if (!m) return false;
  const d = new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3])));
  return d.getUTCFullYear() === Number(m[1]) && d.getUTCMonth() === Number(m[2]) - 1 && d.getUTCDate() === Number(m[3]);
}

/**
 * 校验并规整 extra(返回 JSON 文本)。previousJson 为 null 表示新建;更新时只有传入 extra 才调用。
 * 空值(undefined/null/空串)的已定义字段从结果中移除;数值统一保存为十进制字符串。
 */
export function validateCustomExtra(db: DB, domain: CustomFieldDomain, raw: unknown, previousJson: string | null): string {
  if (raw !== undefined && raw !== null && (typeof raw !== 'object' || Array.isArray(raw))) throw Errors.validation('扩展字段必须是对象');
  const obj: Record<string, unknown> = { ...((raw ?? {}) as Record<string, unknown>) };
  const previous = previousJson ? JSON.parse(previousJson) as Record<string, unknown> : {};
  const fields = db.prepare("SELECT * FROM sys_custom_field WHERE domain = ? AND status = 'active' ORDER BY sort_order, id").all(domain) as FieldRow[];
  const problems: string[] = [];
  for (const f of fields) {
    let v = obj[f.field_code];
    if (typeof v === 'string') v = v.trim();
    if (v === undefined || v === null || v === '') {
      delete obj[f.field_code];
      if (f.required) problems.push(`${f.field_name}不能为空`);
      continue;
    }
    switch (f.field_type) {
      case 'text':
        if (typeof v !== 'string') problems.push(`${f.field_name}必须是文本`);
        else if (v.length > 500) problems.push(`${f.field_name}不能超过 500 个字符`);
        break;
      case 'number':
        if (typeof v === 'number' && Number.isSafeInteger(v)) v = String(v);
        if (typeof v !== 'string' || !DECIMAL.test(v)) problems.push(`${f.field_name}应为数字(最多 15 位整数、6 位小数)`);
        break;
      case 'date':
        if (typeof v !== 'string' || !validDate(v)) problems.push(`${f.field_name}应为 YYYY-MM-DD 日期`);
        break;
      case 'select':
        if (typeof v !== 'string') problems.push(`${f.field_name}必须是字典取值`);
        else if (!activeDictValues(db, f.dict_type!).has(v) && previous[f.field_code] !== v) problems.push(`${f.field_name}的取值“${v}”不是有效选项`);
        break;
    }
    obj[f.field_code] = v;
  }
  if (problems.length) throw Errors.validation(problems.join(';'));
  const json = JSON.stringify(obj);
  if (json.length > 8_000) throw Errors.validation('扩展字段过大');
  return json;
}
