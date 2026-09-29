/**
 * 差异归因(方案《AI助手完整方案》4.3「差异归因:按组织、科目和方向排序,支持逐层展开」)。
 *
 * 全部为后端确定性计算:唯一数据源是 report.completionReport,不重新实现任何
 * 汇总或符号规则。金额为整数分且按利润方向带符号(实际-预算,正数有利);
 * 数量科目不进入金额归因,单独输出。
 *
 * 逐层展开语义:按维度树自顶向下展开,每层按 |差异| 降序取前 topN,截断部分
 * 以 hiddenChildCount / hiddenVarianceCents 如实反馈,保证「展示的 + 隐藏的 =
 * 父节点差异」可核对。
 */
import type { DB } from '../db/connection';
import * as report from '../modules/report/report.service';
import { isQuantityType, safeIntegerAdd } from '../core/money';

export type AttributionDirection = 'favorable' | 'unfavorable' | 'all';

export interface AttributionInput extends report.CompletionInput {
  /** 展开层级上限,默认 3(1 = 只看根层) */
  maxDepth?: number;
  /** 每层保留条目数,默认 10 */
  topN?: number;
  /** 方向筛选,只作用于叶子排行榜,树始终完整可核对 */
  direction?: AttributionDirection;
}

export interface AttributionNode {
  dimension: 'org' | 'account';
  id: number;
  parentId: number | null;
  code: string;
  name: string;
  level: number;
  isLeaf: boolean;
  /** 科目维度的科目类型;组织维度为 undefined */
  type?: string;
  budgetCents: number;
  actualCents: number;
  varianceCents: number;
  favorable: 'favorable' | 'unfavorable' | 'none';
  rate: number | null;
  rateSpecial: report.CompletionCell['rateSpecial'];
  progressDeviation: number | null;
  pace: report.CompletionCell['pace'];
  /** 占父节点差异绝对值比重;父差异为 0 时为 null */
  shareOfParent: number | null;
  /** 占总差异绝对值比重;总差异为 0 时为 null */
  shareOfTotal: number | null;
  /** 子节点差异合计(完整子层,不受 topN 截断影响) */
  childrenVarianceCents: number;
  /** 子层差异合计是否等于本节点差异 */
  reconciled: boolean;
  /** 因 topN / maxDepth 未展开的子节点数量 */
  hiddenChildCount: number;
  /** 未展开子节点的差异合计 */
  hiddenVarianceCents: number;
  children: AttributionNode[];
}

export interface AttributionLeaf {
  dimension: 'org' | 'account';
  id: number;
  code: string;
  name: string;
  type?: string;
  path: string;
  budgetCents: number;
  actualCents: number;
  varianceCents: number;
  favorable: 'favorable' | 'unfavorable' | 'none';
  rate: number | null;
  rateSpecial: report.CompletionCell['rateSpecial'];
  shareOfTotal: number | null;
}

export interface AttributionQuantityRow {
  accountId: number;
  code: string;
  name: string;
  unit: string;
  budgetQuantity: number;
  actualQuantity: number;
  varianceQuantity: number;
  rate: number | null;
}

export interface AttributionReport {
  version: report.CompletionReport['version'];
  asOfDate: string | null;
  timeProgressValue: number | null;
  actualSource: report.CompletionReport['actualSource'];
  actualBatchId: number | null;
  treeBasis: report.CompletionReport['treeBasis'];
  scopeBasis: report.CompletionReport['scopeBasis'];
  params: { maxDepth: number; topN: number; direction: AttributionDirection };
  totals: { budgetCents: number; actualCents: number; varianceCents: number; favorable: 'favorable' | 'unfavorable' | 'none' };
  byOrg: AttributionNode[];
  byAccount: AttributionNode[];
  /** 方向 + |差异| 排序的叶子贡献榜 */
  rankedOrgLeaves: AttributionLeaf[];
  rankedAccountLeaves: AttributionLeaf[];
  /** 数量科目差异单独列出,不参与金额归因 */
  quantityVariances: AttributionQuantityRow[];
  reconciliation: {
    orgRootVarianceCents: number;
    accountRootVarianceCents: number;
    orgLeafVarianceCents: number;
    accountLeafVarianceCents: number;
    /** 两个维度根层合计与叶子合计是否一致 */
    matched: boolean;
    /** 逐层子层合计不等于父节点的节点数(正常应为 0) */
    unreconciledNodeCount: number;
  };
  notes: string[];
}

interface RawNode {
  id: number;
  parentId: number | null;
  code: string;
  name: string;
  level: number;
  isLeaf: boolean;
  type?: string;
  cell: report.CompletionCell;
}

function bounded(value: unknown, fallback: number, min: number, max: number, label: string): number {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n) || n < min || n > max) throw new Error(`${label}必须是 ${min} 到 ${max} 的整数`);
  return n;
}

function normalizeDirection(value: unknown): AttributionDirection {
  if (value == null || value === '') return 'all';
  const v = String(value).toLowerCase();
  if (v !== 'favorable' && v !== 'unfavorable' && v !== 'all') throw new Error('direction必须是 favorable、unfavorable 或 all');
  return v;
}

function favorableOf(varianceCents: number): 'favorable' | 'unfavorable' | 'none' {
  return varianceCents > 0 ? 'favorable' : varianceCents < 0 ? 'unfavorable' : 'none';
}

function share(part: number, whole: number): number | null {
  const denominator = Math.abs(whole);
  if (denominator === 0) return null;
  return part / denominator;
}

/** 逐层展开:children 按 |差异| 降序取 topN,其余以隐藏统计如实反馈。 */
function buildTree(
  dimension: 'org' | 'account',
  nodes: RawNode[],
  totalVarianceCents: number,
  maxDepth: number,
  topN: number,
): { roots: AttributionNode[]; unreconciledNodeCount: number } {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  const childrenOf = new Map<number | null, RawNode[]>();
  for (const node of nodes) {
    // 范围裁剪后父节点可能不在集合内,此时按范围内根节点处理。
    const parentKey = node.parentId != null && byId.has(node.parentId) ? node.parentId : null;
    const list = childrenOf.get(parentKey);
    if (list) list.push(node);
    else childrenOf.set(parentKey, [node]);
  }
  let unreconciledNodeCount = 0;

  const expand = (node: RawNode, depth: number, parentVarianceCents: number | null): AttributionNode => {
    const allChildren = childrenOf.get(node.id) ?? [];
    let childrenVarianceCents = 0;
    for (const child of allChildren) childrenVarianceCents = safeIntegerAdd(childrenVarianceCents, child.cell.varianceCents, '归因子层合计');
    const reconciled = allChildren.length === 0 || childrenVarianceCents === node.cell.varianceCents;
    if (!reconciled) unreconciledNodeCount += 1;

    const sorted = [...allChildren].sort((a, b) => {
      const diff = Math.abs(b.cell.varianceCents) - Math.abs(a.cell.varianceCents);
      return diff !== 0 ? diff : a.code.localeCompare(b.code);
    });
    const kept = depth >= maxDepth ? [] : sorted.slice(0, topN);
    const hidden = sorted.slice(kept.length);
    let hiddenVarianceCents = 0;
    for (const child of hidden) hiddenVarianceCents = safeIntegerAdd(hiddenVarianceCents, child.cell.varianceCents, '归因隐藏合计');

    return {
      dimension,
      id: node.id,
      parentId: node.parentId,
      code: node.code,
      name: node.name,
      level: node.level,
      isLeaf: node.isLeaf,
      ...(node.type == null ? {} : { type: node.type }),
      budgetCents: node.cell.budgetCents,
      actualCents: node.cell.actualCents,
      varianceCents: node.cell.varianceCents,
      favorable: favorableOf(node.cell.varianceCents),
      rate: node.cell.rate,
      rateSpecial: node.cell.rateSpecial,
      progressDeviation: node.cell.progressDeviation,
      pace: node.cell.pace,
      shareOfParent: parentVarianceCents == null ? null : share(node.cell.varianceCents, parentVarianceCents),
      shareOfTotal: share(node.cell.varianceCents, totalVarianceCents),
      childrenVarianceCents,
      reconciled,
      hiddenChildCount: hidden.length,
      hiddenVarianceCents,
      children: kept.map((child) => expand(child, depth + 1, node.cell.varianceCents)),
    };
  };

  const roots = (childrenOf.get(null) ?? [])
    .sort((a, b) => {
      const diff = Math.abs(b.cell.varianceCents) - Math.abs(a.cell.varianceCents);
      return diff !== 0 ? diff : a.code.localeCompare(b.code);
    })
    .map((node) => expand(node, 1, null));
  return { roots, unreconciledNodeCount };
}

function pathOf(nodes: Map<number, RawNode>, node: RawNode): string {
  const parts: string[] = [];
  let cursor: RawNode | undefined = node;
  const guard = new Set<number>();
  while (cursor && !guard.has(cursor.id)) {
    guard.add(cursor.id);
    parts.unshift(cursor.name || cursor.code);
    cursor = cursor.parentId == null ? undefined : nodes.get(cursor.parentId);
  }
  return parts.join(' / ');
}

function rankLeaves(
  dimension: 'org' | 'account',
  nodes: RawNode[],
  totalVarianceCents: number,
  direction: AttributionDirection,
  topN: number,
): AttributionLeaf[] {
  const byId = new Map(nodes.map((node) => [node.id, node]));
  return nodes
    .filter((node) => node.isLeaf)
    .filter((node) => (direction === 'all'
      ? true
      : direction === 'favorable'
        ? node.cell.varianceCents > 0
        : node.cell.varianceCents < 0))
    .sort((a, b) => {
      const diff = Math.abs(b.cell.varianceCents) - Math.abs(a.cell.varianceCents);
      return diff !== 0 ? diff : a.code.localeCompare(b.code);
    })
    .slice(0, topN)
    .map((node) => ({
      dimension,
      id: node.id,
      code: node.code,
      name: node.name,
      ...(node.type == null ? {} : { type: node.type }),
      path: pathOf(byId, node),
      budgetCents: node.cell.budgetCents,
      actualCents: node.cell.actualCents,
      varianceCents: node.cell.varianceCents,
      favorable: favorableOf(node.cell.varianceCents),
      rate: node.cell.rate,
      rateSpecial: node.cell.rateSpecial,
      shareOfTotal: share(node.cell.varianceCents, totalVarianceCents),
    }));
}

function sumRoots(nodes: RawNode[]): number {
  const ids = new Set(nodes.map((node) => node.id));
  let total = 0;
  for (const node of nodes) {
    if (node.parentId != null && ids.has(node.parentId)) continue;
    total = safeIntegerAdd(total, node.cell.varianceCents, '归因根层合计');
  }
  return total;
}

function sumLeaves(nodes: RawNode[]): number {
  let total = 0;
  for (const node of nodes) if (node.isLeaf) total = safeIntegerAdd(total, node.cell.varianceCents, '归因叶子合计');
  return total;
}

/**
 * 差异归因报告。数字全部取自 completionReport,本模块只做排序、层级展开与占比。
 */
export function attributionReport(db: DB, input: AttributionInput): AttributionReport {
  const maxDepth = bounded(input.maxDepth, 3, 1, 10, 'maxDepth');
  const topN = bounded(input.topN, 10, 1, 100, 'topN');
  const direction = normalizeDirection(input.direction);
  // summaryLevel 只影响展示层级,归因必须拿到完整树才能逐层核对。
  const completion = report.completionReport(db, { ...input, summaryLevel: null });

  const orgNodes: RawNode[] = completion.byOrg.map((row) => ({
    id: row.orgId, parentId: row.parentId, code: row.code, name: row.name, level: row.level, isLeaf: row.isLeaf, cell: row.cell,
  }));
  const moneyAccounts: RawNode[] = completion.analysisAccounts
    .filter((row) => !isQuantityType(row.type))
    .map((row) => ({
      id: row.accountId, parentId: row.parentId, code: row.code, name: row.name, level: row.level, isLeaf: row.isLeaf, type: row.type, cell: row.cell,
    }));

  const orgRootVarianceCents = sumRoots(orgNodes);
  const accountRootVarianceCents = sumRoots(moneyAccounts);
  const orgLeafVarianceCents = sumLeaves(orgNodes);
  const accountLeafVarianceCents = sumLeaves(moneyAccounts);
  const totalVarianceCents = orgRootVarianceCents;
  let totalBudgetCents = 0;
  let totalActualCents = 0;
  {
    const ids = new Set(orgNodes.map((node) => node.id));
    for (const node of orgNodes) {
      if (node.parentId != null && ids.has(node.parentId)) continue;
      totalBudgetCents = safeIntegerAdd(totalBudgetCents, node.cell.budgetCents, '归因预算合计');
      totalActualCents = safeIntegerAdd(totalActualCents, node.cell.actualCents, '归因实际合计');
    }
  }

  const orgTree = buildTree('org', orgNodes, totalVarianceCents, maxDepth, topN);
  const accountTree = buildTree('account', moneyAccounts, totalVarianceCents, maxDepth, topN);

  const quantityVariances: AttributionQuantityRow[] = completion.analysisAccounts
    .filter((row) => isQuantityType(row.type) && row.isLeaf && row.cell.varianceQuantity !== 0)
    .sort((a, b) => {
      const diff = Math.abs(b.cell.varianceQuantity) - Math.abs(a.cell.varianceQuantity);
      return diff !== 0 ? diff : a.code.localeCompare(b.code);
    })
    .slice(0, topN)
    .map((row) => ({
      accountId: row.accountId,
      code: row.code,
      name: row.name,
      unit: row.unit,
      budgetQuantity: row.cell.budgetQuantity,
      actualQuantity: row.cell.actualQuantity,
      varianceQuantity: row.cell.varianceQuantity,
      rate: row.cell.rate,
    }));

  return {
    version: completion.version,
    asOfDate: completion.asOfDate,
    timeProgressValue: completion.timeProgressValue,
    actualSource: completion.actualSource,
    actualBatchId: completion.actualBatchId,
    treeBasis: completion.treeBasis,
    scopeBasis: completion.scopeBasis,
    params: { maxDepth, topN, direction },
    totals: {
      budgetCents: totalBudgetCents,
      actualCents: totalActualCents,
      varianceCents: totalVarianceCents,
      favorable: favorableOf(totalVarianceCents),
    },
    byOrg: orgTree.roots,
    byAccount: accountTree.roots,
    rankedOrgLeaves: rankLeaves('org', orgNodes, totalVarianceCents, direction, topN),
    rankedAccountLeaves: rankLeaves('account', moneyAccounts, totalVarianceCents, direction, topN),
    quantityVariances,
    reconciliation: {
      orgRootVarianceCents,
      accountRootVarianceCents,
      orgLeafVarianceCents,
      accountLeafVarianceCents,
      matched: orgRootVarianceCents === accountRootVarianceCents
        && orgRootVarianceCents === orgLeafVarianceCents
        && accountRootVarianceCents === accountLeafVarianceCents,
      unreconciledNodeCount: orgTree.unreconciledNodeCount + accountTree.unreconciledNodeCount,
    },
    notes: [
      '差异为带符号利润方向口径(实际-预算,正数有利);占比按差异绝对值计算',
      '逐层展开每层按差异绝对值降序取前 topN,未展开部分见 hiddenChildCount 与 hiddenVarianceCents',
      '数量科目不参与金额归因,单独在 quantityVariances 中按缩放整数输出',
      '组织维度与科目维度的根层差异合计应完全相等,见 reconciliation',
    ],
  };
}
