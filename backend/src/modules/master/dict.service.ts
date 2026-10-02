/**
 * 主数据字典项(T-7,AC-F07):全局主数据,读需 master:read,写需 master:write 且全组织(路由表)。
 * 类型与取值是引用键(自定义字段下拉等),创建后不可改;显示名、排序、状态可改,带期望版本;停用代替删除。
 */
import type { DB } from '../../db/connection';
import { AppError, Errors } from '../../core/errors';
import { writeLog } from '../audit/log';
import type { DictItemCreate, DictItemDto, DictItemUpdate, DictTypeDto } from '../../contracts/master-dict';

interface DictRow {
  id: number; dict_type: string; item_value: string; item_label: string; sort_order: number; status: 'active' | 'inactive';
  version: number; created_at: string; updated_at: string;
}
const toDto = (r: DictRow): DictItemDto => ({
  id: r.id, dictType: r.dict_type, itemValue: r.item_value, itemLabel: r.item_label, sortOrder: r.sort_order, status: r.status,
  version: r.version, createdAt: r.created_at, updatedAt: r.updated_at,
});

export function listDictTypes(db: DB): DictTypeDto[] {
  return (db.prepare(`SELECT dict_type, COUNT(*) AS n, SUM(status = 'active') AS a FROM md_dict_item GROUP BY dict_type ORDER BY dict_type`).all() as
    { dict_type: string; n: number; a: number }[]).map((r) => ({ dictType: r.dict_type, itemCount: r.n, activeCount: r.a }));
}

export function listDictItems(db: DB, q: { dictType?: string; status?: 'active' | 'inactive' } = {}): DictItemDto[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.dictType) { where.push('dict_type = ?'); params.push(q.dictType); }
  if (q.status) { where.push('status = ?'); params.push(q.status); }
  return (db.prepare(`SELECT * FROM md_dict_item ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY dict_type, sort_order, id LIMIT 2000`)
    .all(...params) as DictRow[]).map(toDto);
}

/** 有效取值集合(自定义字段校验用)。 */
export function activeDictValues(db: DB, dictType: string): Map<string, string> {
  const rows = db.prepare("SELECT item_value, item_label FROM md_dict_item WHERE dict_type = ? AND status = 'active'").all(dictType) as { item_value: string; item_label: string }[];
  return new Map(rows.map((r) => [r.item_value, r.item_label]));
}

function row(db: DB, id: number): DictRow {
  const r = db.prepare('SELECT * FROM md_dict_item WHERE id = ?').get(id) as DictRow | undefined;
  if (!r) throw Errors.notFound('字典项');
  return r;
}

export function createDictItem(db: DB, input: DictItemCreate): DictItemDto {
  const id = db.transaction(() => {
    const dup = db.prepare('SELECT id, status FROM md_dict_item WHERE dict_type = ? AND item_value = ?').get(input.dictType, input.itemValue) as { id: number; status: string } | undefined;
    if (dup) throw new AppError('DUPLICATE', `字典“${input.dictType}”中已有取值“${input.itemValue}”${dup.status === 'inactive' ? '(已停用,可重新启用)' : ''}`, 409);
    const now = new Date().toISOString();
    const sort = input.sortOrder ?? ((db.prepare('SELECT COALESCE(MAX(sort_order), 0) + 10 AS s FROM md_dict_item WHERE dict_type = ?').get(input.dictType) as { s: number }).s);
    const newId = Number(db.prepare(`INSERT INTO md_dict_item (dict_type, item_value, item_label, sort_order, status, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'active', ?, ?)`).run(input.dictType, input.itemValue, input.itemLabel, sort, now, now).lastInsertRowid);
    writeLog(db, 'master.dict.create', 'md_dict_item', newId, { dictType: input.dictType, itemValue: input.itemValue, itemLabel: input.itemLabel });
    return newId;
  })();
  return toDto(row(db, id));
}

export function updateDictItem(db: DB, id: number, input: DictItemUpdate): DictItemDto {
  db.transaction(() => {
    const r = row(db, id);
    if (r.version !== input.expectedVersion) throw new AppError('VERSION_CONFLICT', '字典项已被其他人更新,请刷新后重试', 409, undefined, { currentVersion: r.version });
    const next = { label: input.itemLabel ?? r.item_label, sort: input.sortOrder ?? r.sort_order, status: input.status ?? r.status };
    if (next.label === r.item_label && next.sort === r.sort_order && next.status === r.status) return;
    db.prepare('UPDATE md_dict_item SET item_label = ?, sort_order = ?, status = ?, version = version + 1, updated_at = ? WHERE id = ?')
      .run(next.label, next.sort, next.status, new Date().toISOString(), id);
    const action: `master.dict.${string}` = next.status !== r.status ? `master.dict.${next.status === 'inactive' ? 'deactivate' : 'activate'}` : 'master.dict.update';
    writeLog(db, action, 'md_dict_item', id, { dictType: r.dict_type, itemValue: r.item_value, label: next.label !== r.item_label ? [r.item_label, next.label] : undefined });
  })();
  return toDto(row(db, id));
}
