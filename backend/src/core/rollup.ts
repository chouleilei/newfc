import type { TreeNodeRow } from './tree';
import { buildAncestorMap, computeLeafIds } from './tree';
import { computeMetrics, computeMetricRatios, type MetricRow, type MetricRatioValue } from '../modules/metric/metric.service';
import { safeIntegerAdd } from './money';

/**
 * 交叉汇总(方案八.1):每条叶子明细金额累计到「组织祖先 × 科目祖先」全部组合,
 * 带符号直接求和,不做二次方向转换。预算与实际共用。
 */

export interface LeafEntry {
  orgId: number;
  accountId: number;
  amountCents: number;
  /** 数量型科目的 10^4 缩放值;金额科目为 null/undefined */
  quantity?: number | null;
}

export interface RollupResult {
  /** orgNodeId -> accountId -> 带符号金额 */
  cell: Map<number, Map<number, number>>;
  /** 线性指标计算结果 metricId -> 金额(需传入 metrics) */
  metrics: Map<number, number>;
  /** 比率指标计算结果 metricId -> 定点比率(RATIO_SCALE 缩放;分母为 0 时 scaled=null) */
  metricRatios: Map<number, MetricRatioValue>;
  /** 数量汇总 orgNodeId -> accountId -> 10^4 缩放数量(仅 quantity_agg=sum 的科目节点) */
  quantityCell: Map<number, Map<number, number>>;
  /** 汇总时已构建的组织祖先链(调用方复用,避免同一请求内重复构建) */
  orgAncestors: Map<number, Set<number>>;
  /** 汇总时已构建的科目祖先链 */
  accountAncestors: Map<number, Set<number>>;
  leafOrgIds: number[];
  leafAccountIds: number[];
}

/** 空汇总结果(无明细、无树时的占位,避免各处手工拼字面量漏字段) */
export function emptyRollup(): RollupResult {
  return {
    cell: new Map(),
    metrics: new Map(),
    metricRatios: new Map(),
    quantityCell: new Map(),
    orgAncestors: new Map(),
    accountAncestors: new Map(),
    leafOrgIds: [],
    leafAccountIds: [],
  };
}

export interface AccountTypeInfo {
  /** accountId -> income/cost/expense/quantity(来自科目树节点,含中间节点) */
  typeOf: Map<number, string>;
}

export function rollup(
  orgRows: TreeNodeRow[],
  accountRows: TreeNodeRow[],
  entries: LeafEntry[],
  metrics: MetricRow[] = []
): RollupResult {
  const orgAncestors = buildAncestorMap(orgRows);
  const accAncestors = buildAncestorMap(accountRows);
  const accById = new Map(accountRows.map((r) => [r.id, r]));
  const cell = new Map<number, Map<number, number>>();
  const put = (orgId: number, accId: number, amount: number) => {
    let row = cell.get(orgId);
    if (!row) { row = new Map(); cell.set(orgId, row); }
    row.set(accId, safeIntegerAdd(row.get(accId) ?? 0, amount, '金额汇总'));
  };
  for (const e of entries) {
    if (e.amountCents === 0) continue;
    const orgs = orgAncestors.get(e.orgId);
    const accs = accAncestors.get(e.accountId);
    if (!orgs || !accs) continue; // 明细引用不在当前树的组合按零处理
    for (const og of orgs) for (const ag of accs) put(og, ag, e.amountCents);
  }
  // 数量汇总:自叶子沿祖先链向上,仅累计 quantity_agg=sum 的节点,遇到 none 停止上溯
  const quantityCell = new Map<number, Map<number, number>>();
  const putQ = (orgId: number, accId: number, v: number) => {
    let row = quantityCell.get(orgId);
    if (!row) { row = new Map(); quantityCell.set(orgId, row); }
    row.set(accId, safeIntegerAdd(row.get(accId) ?? 0, v, '数量汇总'));
  };
  // 比率口径的数量合计:与金额的 accountTotals 同理,只沿科目祖先链累计,不做组织交叉
  const quantityTotals = new Map<number, number>();
  for (const e of entries) {
    if (e.quantity == null || e.quantity === 0) continue;
    const orgs = orgAncestors.get(e.orgId);
    const accs = accAncestors.get(e.accountId);
    if (!orgs || !accs) continue;
    for (const ag of accs) {
      if (accById.get(ag)?.quantity_agg === 'none') break; // 叶子为 none 则完全不汇总;上级为 none 则停止上溯
      for (const og of orgs) putQ(og, ag, e.quantity);
      quantityTotals.set(ag, safeIntegerAdd(quantityTotals.get(ag) ?? 0, e.quantity, '科目数量汇总'));
    }
  }
  // 指标计算:科目节点汇总 = 每条明细按科目祖先链直接累计(避免交叉矩阵重复计数)
  const accountTotals = new Map<number, number>();
  for (const e of entries) {
    if (e.amountCents === 0) continue;
    const accs = accAncestors.get(e.accountId);
    if (!accs) continue;
    for (const ag of accs) accountTotals.set(ag, safeIntegerAdd(accountTotals.get(ag) ?? 0, e.amountCents, '科目金额汇总'));
  }
  const metricValues = computeMetrics(accountTotals, metrics);
  const accountTypeOf = new Map([...accById].map(([id, row]) => [id, String(row.type ?? '')]));
  const metricRatios = computeMetricRatios(
    { money: accountTotals, quantity: quantityTotals, linear: metricValues },
    metrics,
    accountTypeOf,
  );
  return {
    cell,
    metrics: metricValues,
    metricRatios,
    quantityCell,
    orgAncestors,
    accountAncestors: accAncestors,
    leafOrgIds: [...computeLeafIds(orgRows)],
    leafAccountIds: [...computeLeafIds(accountRows)],
  };
}

/** 取某个组织节点 × 科目节点的汇总值(缺失补零,方案八.2) */
export function cellOf(r: RollupResult, orgId: number, accountId: number): number {
  return r.cell.get(orgId)?.get(accountId) ?? 0;
}

/** 取某个组织节点 × 数量型科目节点的数量汇总值(10^4 缩放,缺失补零;仅 sum 科目有值) */
export function quantityCellOf(r: RollupResult, orgId: number, accountId: number): number {
  return r.quantityCell.get(orgId)?.get(accountId) ?? 0;
}
