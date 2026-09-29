/**
 * 通用树工具:循环检测、叶子检测、祖先映射、路径计算。
 * 组织树与科目树共用。
 */

export interface TreeNodeRow {
  id: number;
  parent_id: number | null;
  code: string;
  name: string;
  type?: string; // 科目树专用
  unit?: string; // 数量型科目专用:计量单位(如 万度 / 元每度 / % / 人)
  quantity_agg?: string; // 数量型科目专用:上级汇总方式 sum=可加总 / none=不汇总
  budget_required?: number; // 预算/预测叶子科目是否要求每个适用叶子组织填报
  basis_required?: number; // 有预算值时是否必须填写测算依据
  sort_order: number;
  status: string;
}

export class TreeCycleError extends Error {
  constructor(public nodeId: number) {
    super(`检测到循环层级,涉及节点 id=${nodeId}`);
    this.name = 'TreeCycleError';
  }
}

/** 检测 parent 链是否存在循环;返回 true 表示存在循环 */
export function hasCycle(rows: TreeNodeRow[], nodeId: number): boolean {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const seen = new Set<number>();
  let cur: number | null = nodeId;
  while (cur != null) {
    if (seen.has(cur)) return true;
    seen.add(cur);
    const node = byId.get(cur);
    if (!node) return false;
    cur = node.parent_id;
  }
  return false;
}

/** 移动校验:目标父节点不能是自身及其后代 */
export function isDescendantOf(rows: TreeNodeRow[], candidateId: number, ancestorId: number): boolean {
  const byId = new Map(rows.map((r) => [r.id, r]));
  let cur = byId.get(candidateId);
  const guard = new Set<number>();
  while (cur) {
    if (guard.has(cur.id)) throw new TreeCycleError(cur.id);
    guard.add(cur.id);
    if (cur.id === ancestorId) return true;
    cur = cur.parent_id != null ? byId.get(cur.parent_id) : undefined;
  }
  return false;
}

/** 是否叶子节点(无子节点;停用节点的叶子语义同样按结构计算) */
export function computeLeafIds(rows: TreeNodeRow[]): Set<number> {
  const parentIds = new Set(rows.map((r) => r.parent_id).filter((p): p is number => p != null));
  const leaves = new Set<number>();
  for (const r of rows) if (!parentIds.has(r.id)) leaves.add(r.id);
  return leaves;
}

/** 节点 -> 祖先链(含自身),自底向上 [自身, 父, 祖父, ...] */
export function ancestorChain(rows: TreeNodeRow[], nodeId: number): number[] {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const chain: number[] = [];
  let cur = byId.get(nodeId);
  const guard = new Set<number>();
  while (cur) {
    if (guard.has(cur.id)) throw new TreeCycleError(cur.id);
    guard.add(cur.id);
    chain.push(cur.id);
    cur = cur.parent_id != null ? byId.get(cur.parent_id) : undefined;
  }
  return chain;
}

/** leaf id -> 自身及全部祖先 id 的集合(汇总映射) */
export function buildAncestorMap(rows: TreeNodeRow[]): Map<number, Set<number>> {
  const result = new Map<number, Set<number>>();
  for (const r of rows) {
    result.set(r.id, new Set(ancestorChain(rows, r.id)));
  }
  return result;
}

/** 完整路径名称,如 "集团 / 华东 / 上海公司" */
export function pathOf(rows: TreeNodeRow[], nodeId: number, sep = ' / '): string {
  const byId = new Map(rows.map((r) => [r.id, r]));
  const names: string[] = [];
  let cur = byId.get(nodeId);
  const guard = new Set<number>();
  while (cur) {
    if (guard.has(cur.id)) throw new TreeCycleError(cur.id);
    guard.add(cur.id);
    names.unshift(cur.name);
    cur = cur.parent_id != null ? byId.get(cur.parent_id) : undefined;
  }
  return names.join(sep);
}

/** 按排序构建嵌套树结构(用于界面展示与快照 JSON) */
export interface TreeNodeDto {
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
  children: TreeNodeDto[];
  path: string;
  isLeaf: boolean;
}

export function buildTree(rows: TreeNodeRow[]): TreeNodeDto[] {
  const byId = new Map<number, TreeNodeDto>();
  for (const r of rows) {
    byId.set(r.id, {
      id: r.id,
      parentId: r.parent_id,
      code: r.code,
      name: r.name,
      type: r.type,
      unit: r.unit,
      quantityAgg: r.quantity_agg,
      budgetRequired: r.budget_required === 1,
      basisRequired: r.basis_required === 1,
      sortOrder: r.sort_order,
      status: r.status,
      children: [],
      path: '',
      isLeaf: false,
    });
  }
  const roots: TreeNodeDto[] = [];
  for (const node of byId.values()) {
    if (node.parentId != null && byId.has(node.parentId)) byId.get(node.parentId)!.children.push(node);
    else roots.push(node);
  }
  const sortRec = (nodes: TreeNodeDto[]) => {
    nodes.sort((a, b) => a.sortOrder - b.sortOrder || a.id - b.id);
    for (const n of nodes) sortRec(n.children);
  };
  sortRec(roots);
  const decorate = (nodes: TreeNodeDto[], prefix: string) => {
    for (const n of nodes) {
      n.path = prefix ? `${prefix} / ${n.name}` : n.name;
      n.isLeaf = n.children.length === 0;
      decorate(n.children, n.path);
    }
  };
  decorate(roots, '');
  return roots;
}
