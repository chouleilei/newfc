import { useMemo } from 'react';
import { centsToWan, quantityToScaled, signOfType, formatQuantity } from '../../utils/money';
import { POWER_STATION_ORG_CODES, findSheet, type SheetDef } from '../../utils/sheets';
import type { YearData, MetricItem, AccountNode, GridRow } from './types';

/**
 * 历史数据维护页取值与汇总:每叶子组织×(年度,方向)的科目树汇总缓存
 * (支持电站管理类费用转制造费用与人工资本化扣除),再按组织范围合并。
 */
export function useActualTotals(opts: {
  years: number[];
  yearData: Record<number, YearData>;
  scopeLeaves: number[];
  accIndex: { rows: AccountNode[]; byId: Map<number, AccountNode>; children: Map<number, number[]> };
  orgIndex: { byId: Map<number, { id: number; code: string; name: string }>; children: Map<number, number[]>; leavesUnder: (id: number) => number[] };
  metrics: { items: MetricItem[] } | undefined;
  sheetKey: string;
  dbSheets: SheetDef[];
}) {
  const { years, yearData, scopeLeaves, accIndex, orgIndex, metrics, sheetKey, dbSheets } = opts;

  /** 每个叶子组织的(年度,方向)独立科目汇总缓存 */
  const leafTotalsCache = useMemo(() => {
    const cache = new Map<string, { cents: Map<number, number>; qty: Map<number, number> }>();
    const e2Node = accIndex.rows.find((n) => n.code === 'E2');
    const c1101Node = accIndex.rows.find((n) => n.code === 'C1101');
    const c1Node = accIndex.rows.find((n) => n.code === 'C1');
    const capLaborNode = accIndex.rows.find((n) => n.code === 'E20199');

    const buildLeaf = (yd: YearData | undefined, side: 'budget' | 'actual', orgId: number) => {
      const cents = new Map<number, number>();
      const qty = new Map<number, number>();
      if (!yd) return { cents, qty };
      const entries = side === 'budget' ? yd.budgetEntries : yd.actualEntries;
      const orgNode = orgIndex.byId.get(orgId);
      const isPowerStation = orgNode ? POWER_STATION_ORG_CODES.has(orgNode.code) : false;

      for (const e of entries.values()) {
        if (e.orgId !== orgId) continue;
        const acc = accIndex.byId.get(e.accountId);
        if (!acc) continue;

        const qtyNum = e.quantity != null && e.quantity !== '' ? (quantityToScaled(e.quantity) ?? 0) : 0;
        if (qtyNum !== 0 && acc.quantity_agg !== 'none') {
          let qCur: { id: number; parent_id: number | null; quantity_agg?: string } | undefined = acc;
          const quantitySeen = new Set<number>();
          while (qCur && !quantitySeen.has(qCur.id)) {
            quantitySeen.add(qCur.id);
            qty.set(qCur.id, (qty.get(qCur.id) ?? 0) + qtyNum);
            qCur = qCur.parent_id != null ? accIndex.byId.get(qCur.parent_id) : undefined;
          }
        }

        // 资本化人工科目 E20199 不向上汇总到管理费用与损益
        if (capLaborNode && acc.id === capLaborNode.id) continue;

        let cur: { id: number; parent_id: number | null } | undefined = acc;
        const seen = new Set<number>();
        while (cur && !seen.has(cur.id)) {
          seen.add(cur.id);
          cents.set(cur.id, (cents.get(cur.id) ?? 0) + e.amountCents);
          cur = cur.parent_id != null ? accIndex.byId.get(cur.parent_id) : undefined;
        }
      }

      // 电站组织分流: E2 费用转入 C1101 制造费用(营业成本)
      if (isPowerStation && e2Node) {
        const e2Signed = cents.get(e2Node.id) ?? 0;
        if (e2Signed !== 0) {
          cents.set(e2Node.id, 0);
          if (c1101Node) cents.set(c1101Node.id, (cents.get(c1101Node.id) ?? 0) + e2Signed);
          if (c1Node) cents.set(c1Node.id, (cents.get(c1Node.id) ?? 0) + e2Signed);
        }
      }

      return { cents, qty };
    };

    for (const y of years) {
      for (const orgId of scopeLeaves) {
        cache.set(`${y}:budget:${orgId}`, buildLeaf(yearData[y], 'budget', orgId));
        cache.set(`${y}:actual:${orgId}`, buildLeaf(yearData[y], 'actual', orgId));
      }
    }
    return cache;
  }, [years, yearData, scopeLeaves, accIndex, orgIndex]);

  /** 按(年度,方向)预计算:组织范围内每个科目节点的带符号金额与数量汇总 */
  const totalsCache = useMemo(() => {
    const cache = new Map<string, { cents: Map<number, number>; qty: Map<number, number> }>();
    for (const y of years) {
      for (const side of ['budget', 'actual'] as const) {
        const combined = { cents: new Map<number, number>(), qty: new Map<number, number>() };
        for (const orgId of scopeLeaves) {
          const t = leafTotalsCache.get(`${y}:${side}:${orgId}`);
          if (t) {
            for (const [aid, c] of t.cents) combined.cents.set(aid, (combined.cents.get(aid) ?? 0) + c);
            for (const [aid, q] of t.qty) combined.qty.set(aid, (combined.qty.get(aid) ?? 0) + q);
          }
        }
        cache.set(`${y}:${side}`, combined);
      }
    }
    return cache;
  }, [years, scopeLeaves, leafTotalsCache]);

  /** 同一组织列会为每个科目行重复取值，按叶子集合缓存一次合并结果。 */
  const orgColumnTotalsCache = useMemo(
    () => new Map<string, { cents: Map<number, number>; qty: Map<number, number> }>(),
    [leafTotalsCache],
  );

  const totalsForOrgColumn = (y: number, side: 'budget' | 'actual', leafIds: number[]) => {
    const key = `${y}:${side}:${leafIds.join(',')}`;
    const cached = orgColumnTotalsCache.get(key);
    if (cached) return cached;
    const combined = { cents: new Map<number, number>(), qty: new Map<number, number>() };
    for (const leafId of leafIds) {
      const leaf = leafTotalsCache.get(`${y}:${side}:${leafId}`);
      if (!leaf) continue;
      for (const [accountId, cents] of leaf.cents) combined.cents.set(accountId, (combined.cents.get(accountId) ?? 0) + cents);
      for (const [accountId, quantity] of leaf.qty) combined.qty.set(accountId, (combined.qty.get(accountId) ?? 0) + quantity);
    }
    orgColumnTotalsCache.set(key, combined);
    return combined;
  };

  /** 指标值(利润方向,分):科目节点汇总的 ±1 线性组合,递归含嵌套指标 */
  const metricValue = (metricId: number, totals: { cents: Map<number, number> }): number => {
    const defs = metrics?.items ?? [];
    const byId = new Map(defs.map((m) => [m.id, m]));
    const seen = new Set<number>();
    const calc = (id: number): number => {
      if (seen.has(id)) return 0;
      seen.add(id);
      const m = byId.get(id);
      if (!m) return 0;
      let sum = 0;
      for (const t of m.terms) {
        if (t.source_type === 'account' && t.source_account_id != null) sum += (totals.cents.get(t.source_account_id) ?? 0) * t.coefficient;
        else if (t.source_type === 'metric' && t.source_metric_id != null) sum += calc(t.source_metric_id) * t.coefficient;
      }
      return sum;
    };
    return calc(metricId);
  };

  /** 不可加总(quantity_agg='none')数量叶子的原始值:只在单一叶子组织口径下有意义,
   *  跨组织合并显示 '—'(与预算页 displayTotal 同口径);无值返回 ''。 */
  const rawQuantityOf = (accountId: number, y: number, leafIds: number[], side: 'budget' | 'actual'): string => {
    if (leafIds.length !== 1) return '—';
    const yd = yearData[y];
    if (!yd) return '';
    const entries = side === 'budget' ? yd.budgetEntries : yd.actualEntries;
    const raw = entries.get(`${leafIds[0]}:${accountId}`)?.quantity;
    if (raw == null || raw === '') return '';
    const scaled = quantityToScaled(raw);
    return scaled == null ? '' : formatQuantity(scaled);
  };

  /** 数量行只读展示:'none' 叶子读原始值,'none' 非叶子与跨组织口径显示 '—'(单价类不可加总) */
  const quantityDisplay = (row: GridRow & { kind: 'account' }, y: number, leafIds: number[], side: 'budget' | 'actual', qty: Map<number, number>): string => {
    if (row.quantityAgg === 'none') {
      return row.isLeaf ? rawQuantityOf(row.id, y, leafIds, side) : '—';
    }
    const q = qty.get(row.id);
    if (q == null || q === 0) return '';
    return formatQuantity(q);
  };

  /** 显示值:金额=万元;普通科目行按界面口径(成本费用为正);利润表行/指标行=利润方向带符号;数量=原值 */
  const displayOf = (row: GridRow, y: number, side: 'budget' | 'actual'): string => {
    const totals = totalsCache.get(`${y}:${side}`);
    if (!totals) return '';
    if (row.kind === 'metric') {
      const v = metricValue(row.id, totals);
      return v === 0 ? '' : centsToWan(v);
    }
    /* 利润表科目取数行:带符号(利润方向) */
    if (findSheet(sheetKey, dbSheets)?.metric) {
      const c = totals.cents.get(row.id) ?? 0;
      return c === 0 ? '' : centsToWan(c);
    }
    if (row.type === 'quantity') {
      return quantityDisplay(row, y, scopeLeaves, side, totals.qty);
    }
    const c = totals.cents.get(row.id) ?? 0;
    if (c === 0) return '';
    return centsToWan(c * signOfType(row.type));
  };

  /** 多组织列显示值 */
  const displayOfOrg = (row: GridRow, y: number, leafIds: number[], side: 'budget' | 'actual'): string => {
    const combinedTotals = totalsForOrgColumn(y, side, leafIds);

    if (row.kind === 'metric') {
      const v = metricValue(row.id, combinedTotals);
      return v === 0 ? '' : centsToWan(v);
    }
    if (findSheet(sheetKey, dbSheets)?.metric) {
      const c = combinedTotals.cents.get(row.id) ?? 0;
      return c === 0 ? '' : centsToWan(c);
    }
    if (row.type === 'quantity') {
      return quantityDisplay(row, y, leafIds, side, combinedTotals.qty);
    }
    const c = combinedTotals.cents.get(row.id) ?? 0;
    if (c === 0) return '';
    return centsToWan(c * signOfType(row.type));
  };

  return { leafTotalsCache, totalsCache, metricValue, displayOf, displayOfOrg };
}
