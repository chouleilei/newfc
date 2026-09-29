import type { DB } from '../../db/connection';
import type { TreeNodeRow } from '../../core/tree';

/** 读取 org / account 表全部行(含停用节点);account 附带 type/unit 供模板与范围校验使用 */
export function listRows(db: DB, table: 'org' | 'account'): TreeNodeRow[] {
  const columns = table === 'account'
    ? new Set((db.pragma('table_info(account)') as { name: string }[]).map((row) => row.name))
    : new Set<string>();
  const extraSel = table === 'account'
    ? `type, unit, quantity_agg, ${columns.has('budget_required') ? 'budget_required, basis_required,' : '0 AS budget_required, 0 AS basis_required,'}`
    : '';
  return db
    .prepare(`SELECT id, parent_id, code, name, ${extraSel} sort_order, status FROM ${table} ORDER BY sort_order, id`)
    .all() as unknown as TreeNodeRow[];
}

export { computeLeafIds } from '../../core/tree';
