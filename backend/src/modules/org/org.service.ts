import type { DB } from '../../db/connection';
import type { TreeNodeDto, TreeNodeRow } from '../../core/tree';
import { buildTree, computeLeafIds, isDescendantOf } from '../../core/tree';
import { Errors } from '../../core/errors';
import { writeLog } from '../audit/log';

const SELECT = 'SELECT id, parent_id, code, name, sort_order, status, created_at, updated_at FROM org';

export interface OrgRow extends TreeNodeRow {
  created_at: string;
  updated_at: string;
}

export function listOrgRows(db: DB): OrgRow[] {
  return db.prepare(`${SELECT} ORDER BY sort_order, id`).all() as OrgRow[];
}

export function getOrgTree(db: DB): { tree: TreeNodeDto[]; rows: OrgRow[]; leafIds: number[] } {
  const rows = listOrgRows(db);
  return { tree: buildTree(rows), rows, leafIds: [...computeLeafIds(rows)] };
}

export function getOrg(db: DB, id: number): OrgRow {
  const row = db.prepare(`${SELECT} WHERE id = ?`).get(id) as OrgRow | undefined;
  if (!row) throw Errors.notFound('组织');
  return row;
}

function assertCodeFree(db: DB, code: string): void {
  if (db.prepare('SELECT 1 FROM org WHERE code = ?').get(code)) {
    throw Errors.conflict(`组织编码 ${code} 已存在(编码不可变且全局唯一)`);
  }
}

function assertParentOk(db: DB, parentId: number | null): void {
  if (parentId == null) return;
  getOrg(db, parentId);
}

export function createOrg(
  db: DB,
  input: { parentId: number | null; code: string; name: string; sortOrder?: number }
): OrgRow {
  if (!input.code?.trim()) throw Errors.validation('组织编码不能为空');
  if (!input.name?.trim()) throw Errors.validation('组织名称不能为空');
  assertCodeFree(db, input.code.trim());
  assertParentOk(db, input.parentId);
  if (input.parentId != null) {
    const rows = listOrgRows(db);
    const parent = rows.find((row) => row.id === input.parentId)!;
    const hasChildren = rows.some((row) => row.parent_id === parent.id);
    if (!hasChildren) {
      const inBudget = db.prepare('SELECT 1 FROM budget_entry WHERE org_id = ? LIMIT 1').get(parent.id);
      const inCurrentActual = db.prepare('SELECT 1 FROM actual_current WHERE org_id = ? LIMIT 1').get(parent.id);
      if (inBudget || inCurrentActual) {
        throw Errors.conflict(`组织 ${parent.code} 已有预算或当前实际明细，不能直接增加子组织；请先迁移存量数据`);
      }
    }
  }
  const now = new Date().toISOString();
  const tx = db.transaction(() => {
    const info = db
      .prepare(
        'INSERT INTO org (parent_id, code, name, sort_order, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)'
      )
      .run(input.parentId, input.code.trim(), input.name.trim(), input.sortOrder ?? 0, 'active', now, now);
    const id = Number(info.lastInsertRowid);
    writeLog(db, 'org.create', 'org', id, { code: input.code.trim(), name: input.name.trim(), parentId: input.parentId });
    return id;
  });
  const id = tx();
  return getOrg(db, id);
}

export function updateOrg(db: DB, id: number, input: { name?: string; sortOrder?: number }): OrgRow {
  const org = getOrg(db, id);
  if (input.name !== undefined) {
    if (!input.name.trim()) throw Errors.validation('组织名称不能为空');
  }
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare('UPDATE org SET name = ?, sort_order = ?, updated_at = ? WHERE id = ?').run(
      input.name !== undefined ? input.name.trim() : org.name,
      input.sortOrder ?? org.sort_order,
      now,
      id
    );
    writeLog(db, 'org.update', 'org', id, { name: input.name, sortOrder: input.sortOrder });
  })();
  return getOrg(db, id);
}

/** 移动组织:目标父不能是自身及其后代(方案五.1) */
export function moveOrg(db: DB, id: number, newParentId: number | null): OrgRow {
  getOrg(db, id);
  if (newParentId != null) {
    const target = getOrg(db, newParentId);
    if (target.id === id) throw Errors.validation('目标父节点不能是自身');
    if (isDescendantOf(listOrgRows(db), newParentId, id)) {
      throw Errors.validation('目标父节点不能是自身的后代');
    }
    const targetHasChildren = db.prepare('SELECT 1 FROM org WHERE parent_id = ? LIMIT 1').get(target.id);
    if (!targetHasChildren && orgReferenced(db, target.id)) {
      throw Errors.conflict(`组织 ${target.code} 已有预算、实际明细或财务映射引用，不能通过移动节点将其变为父组织；请先迁移存量数据`);
    }
  }
  db.transaction(() => {
    db.prepare('UPDATE org SET parent_id = ?, updated_at = ? WHERE id = ?').run(
      newParentId,
      new Date().toISOString(),
      id
    );
    writeLog(db, 'org.move', 'org', id, { newParentId });
  })();
  return getOrg(db, id);
}

/** 停用/启用:只影响新增引用,存量数据保留参与汇总(方案五.3) */
export function setOrgStatus(db: DB, id: number, status: 'active' | 'inactive'): OrgRow {
  getOrg(db, id);
  const action = status === 'inactive' ? 'org.deactivate' : 'org.activate';
  db.transaction(() => {
    db.prepare('UPDATE org SET status = ?, updated_at = ? WHERE id = ?').run(status, new Date().toISOString(), id);
    writeLog(db, action, 'org', id, { status });
  })();
  return getOrg(db, id);
}

/** 组织被业务数据引用后不能物理删除 */
export function orgReferenced(db: DB, id: number): boolean {
  const inBudget = db.prepare('SELECT 1 FROM budget_entry WHERE org_id = ? LIMIT 1').get(id);
  const inActual = db.prepare('SELECT 1 FROM actual_current WHERE org_id = ? LIMIT 1').get(id);
  const inSnapshot = db.prepare('SELECT 1 FROM actual_snapshot_entry WHERE org_id = ? LIMIT 1').get(id);
  // 财务映射目标组织:target_org_id 建表无外键,删除后非停用映射成悬空引用,要到下次转换才暴露
  // (低版本库无此表——迁移中途状态/旧备份恢复场景按无引用处理)
  const inMapping = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='finance_org_mapping'").get()
    ? db.prepare(
      `SELECT 1 FROM finance_org_mapping m JOIN finance_mapping_version v ON v.id = m.mapping_version_id
       WHERE m.target_org_id = ? AND v.status != 'retired' LIMIT 1`
    ).get(id)
    : undefined;
  return Boolean(inBudget || inActual || inSnapshot || inMapping);
}

/** 汇总格备注引用(仅物理删除保护用;不阻塞移动等结构操作——备注在节点变为非叶子后依然合法) */
function orgNoteReferenced(db: DB, id: number): boolean {
  const inBudgetNote = db.prepare('SELECT 1 FROM budget_cell_note WHERE org_id = ? LIMIT 1').get(id);
  const inActualNote = db.prepare('SELECT 1 FROM actual_cell_note WHERE org_id = ? LIMIT 1').get(id);
  return Boolean(inBudgetNote || inActualNote);
}

export function deleteOrg(db: DB, id: number): void {
  const org = getOrg(db, id);
  const childCount = db.prepare('SELECT COUNT(*) AS c FROM org WHERE parent_id = ?').get(id) as { c: number };
  if (childCount.c > 0) throw Errors.conflict('存在下级组织,不能删除');
  // 汇总格备注的组织侧可以是叶子(另一侧非叶子),物理删除会留下悬挂批注
  if (orgReferenced(db, id) || orgNoteReferenced(db, id)) {
    throw Errors.conflict('组织已被预算/实际数据或财务映射引用,不能物理删除(可停用)');
  }
  db.transaction(() => {
    db.prepare('DELETE FROM org WHERE id = ?').run(id);
    writeLog(db, 'org.delete', 'org', id, { deleted: true, code: org.code });
  })();
}

/** 结构检查:循环、孤儿、同级编码排序 */
export function checkOrgStructure(db: DB): { ok: boolean; problems: string[] } {
  const rows = listOrgRows(db);
  const problems: string[] = [];
  const ids = new Set(rows.map((r) => r.id));
  for (const r of rows) {
    if (r.parent_id != null) {
      if (r.parent_id === r.id) problems.push(`组织 ${r.code} 的父节点是自身`);
      else if (!ids.has(r.parent_id)) problems.push(`组织 ${r.code} 的父节点 ${r.parent_id} 不存在(孤儿节点)`);
    }
    if (r.status !== 'active' && r.status !== 'inactive') problems.push(`组织 ${r.code} 状态非法: ${r.status}`);
  }
  // 链式循环检测
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const r of rows) {
    const seen = new Set<number>();
    let cur: OrgRow | undefined = r;
    while (cur && cur.parent_id != null) {
      if (seen.has(cur.id)) { problems.push(`组织 ${r.code} 所在链路存在循环`); break; }
      seen.add(cur.id);
      cur = byId.get(cur.parent_id);
    }
  }
  return { ok: problems.length === 0, problems };
}
