import crypto from 'crypto';
import type { DB } from '../../db/connection';
import type { TreeNodeRow } from '../../core/tree';

/** 树快照(方案四.3):内容不变复用;包含停用节点,保证历史口径完整。 */

export interface SnapshotNode {
  id: number;
  parentId: number | null;
  code: string;
  name: string;
  type?: string;
  unit?: string; // 数量型科目:计量单位
  quantityAgg?: string; // 数量型科目:sum/none
  budgetRequired?: boolean;
  basisRequired?: boolean;
  sortOrder: number;
  status: string;
}

export interface TreeSnapshotContent {
  nodes: SnapshotNode[];
}

export interface TreeSnapshotRow {
  id: number;
  tree_type: string;
  content_json: string;
  content_hash: string;
  created_at: string;
}

function nodeOf(row: TreeNodeRow): SnapshotNode {
  const node: SnapshotNode = {
    id: row.id,
    parentId: row.parent_id,
    code: row.code,
    name: row.name,
    sortOrder: row.sort_order,
    status: row.status,
  };
  if (row.type !== undefined) node.type = row.type;
  if (row.unit !== undefined && row.unit !== '') node.unit = row.unit;
  if (row.quantity_agg !== undefined && row.quantity_agg !== 'sum') node.quantityAgg = row.quantity_agg;
  if (row.budget_required === 1) node.budgetRequired = true;
  if (row.basis_required === 1) node.basisRequired = true;
  return node;
}

function stableHash(nodes: SnapshotNode[]): string {
  const sorted = [...nodes].sort((a, b) => a.id - b.id);
  return crypto.createHash('sha256').update(JSON.stringify(sorted)).digest('hex');
}

/** 读取当前树全部节点并生成快照;内容未变化时复用已有快照。返回快照 id。 */
export function createOrReuseSnapshot(db: DB, treeType: 'org' | 'account'): number {
  const table = treeType === 'org' ? 'org' : 'account';
  const columns = treeType === 'account'
    ? new Set((db.pragma('table_info(account)') as { name: string }[]).map((row) => row.name))
    : new Set<string>();
  const extraSel = treeType === 'account'
    ? `type, unit, quantity_agg, ${columns.has('budget_required') ? 'budget_required, basis_required,' : '0 AS budget_required, 0 AS basis_required,'}`
    : '';
  const rows = db
    .prepare(`SELECT id, parent_id, code, name, ${extraSel} sort_order, status FROM ${table} ORDER BY id`)
    .all() as unknown as TreeNodeRow[];
  const nodes = rows.map(nodeOf);
  const content: TreeSnapshotContent = { nodes };
  const json = JSON.stringify(content);
  const hash = stableHash(nodes);
  const existing = db
    .prepare('SELECT id FROM tree_snapshot WHERE tree_type = ? AND content_hash = ?')
    .get(treeType, hash) as { id: number } | undefined;
  if (existing) return existing.id;
  const info = db
    .prepare('INSERT INTO tree_snapshot (tree_type, content_json, content_hash, created_at) VALUES (?, ?, ?, ?)')
    .run(treeType, json, hash, new Date().toISOString());
  return Number(info.lastInsertRowid);
}

export function getSnapshot(db: DB, id: number): TreeSnapshotRow | undefined {
  return db.prepare('SELECT * FROM tree_snapshot WHERE id = ?').get(id) as TreeSnapshotRow | undefined;
}

/** 解析快照内容为树节点行 */
export function parseSnapshot(row: TreeSnapshotContent | TreeSnapshotRow | string): TreeNodeRow[] {
  const content: TreeSnapshotContent =
    typeof row === 'string'
      ? JSON.parse(row)
      : 'content_json' in (row as TreeSnapshotRow)
        ? JSON.parse((row as TreeSnapshotRow).content_json)
        : (row as TreeSnapshotContent);
  return content.nodes.map((n) => ({
    id: n.id,
    parent_id: n.parentId,
    code: n.code,
    name: n.name,
    type: n.type,
    unit: n.unit,
    quantity_agg: n.quantityAgg ?? 'sum',
    budget_required: n.budgetRequired ? 1 : 0,
    basis_required: n.basisRequired ? 1 : 0,
    sort_order: n.sortOrder,
    status: n.status,
  }));
}

export function loadSnapshotNodes(db: DB, snapshotId: number): TreeNodeRow[] {
  const row = getSnapshot(db, snapshotId);
  if (!row) throw new Error(`树快照 ${snapshotId} 不存在`);
  return parseSnapshot(row);
}

/** 列出全部快照(管理界面用) */
export function listSnapshots(
  db: DB,
  opts: { treeType?: 'org' | 'account'; page?: number; pageSize?: number } = {}
): { total: number; items: TreeSnapshotRow[] } {
  const page = Math.max(1, opts.page ?? 1);
  const pageSize = Math.min(200, Math.max(1, opts.pageSize ?? 50));
  const where = opts.treeType ? 'WHERE tree_type = ?' : '';
  const params = opts.treeType ? [opts.treeType] : [];
  const total = (db.prepare(`SELECT COUNT(*) AS c FROM tree_snapshot ${where}`).get(...params) as { c: number }).c;
  const items = db
    .prepare(`SELECT * FROM tree_snapshot ${where} ORDER BY id DESC LIMIT ? OFFSET ?`)
    .all(...params, pageSize, (page - 1) * pageSize) as TreeSnapshotRow[];
  return { total, items };
}
