import { useMemo } from 'react';
import { centsToWan, wanToCents, signOfType, quantityToScaled, formatQuantity } from '../../utils/money';
import { POWER_STATION_ORG_CODES, findSheet, type SheetDef } from '../../utils/sheets';
import type { MatrixResponse, MetricItem, AccIndex, GridRow, Row } from './types';

/**
 * 预算编制页取值与汇总(自底向上记忆化):
 * 单元格取值 → 组织列勾稽(电站费用分流) → 指标计算 → 行合计与显示格式。
 */
export function useBudgetTotals(opts: {
  values: Map<string, string>;
  data?: MatrixResponse;
  metricsData?: { items: MetricItem[] };
  sheetKey: string;
  dbSheets: SheetDef[];
  rowIndex: AccIndex;
  rowById: Map<number, Row>;
  orgIndex: { byId: Map<number, { id: number; code: string; name: string }>; children: Map<number, number[]>; leavesUnder: (id: number) => number[] };
  orgCols: number[];
}) {
  const { values, data, metricsData, sheetKey, dbSheets, rowIndex, rowById, orgIndex, orgCols } = opts;

  const leafCents = (orgId: number, row: Row, display: string): number => {
    if (row.type === 'quantity') return 0;
    const cents = wanToCents(display);
    if (cents == null) return 0;
    return cents * signOfType(row.type);
  };

  const totalCache = useMemo(() => {
    const cache = new Map<string, number>(); // `${rowId}:${orgId}` -> 带符号金额(10^4 为数量)
    const calc = (rowId: number, orgId: number): number => {
      const key = `${rowId}:${orgId}`;
      const hit = cache.get(key);
      if (hit !== undefined) return hit;
      const row = rowById.get(rowId);
      if (!row) return 0;
      const raw = values.get(`${orgId}:${rowId}`) ?? '';
      let v: number;
      if (row.isLeaf) {
        if (row.type === 'quantity') {
          v = raw.trim() === '' ? 0 : (quantityToScaled(raw) ?? 0);
        } else {
          v = leafCents(orgId, row, raw);
        }
      } else {
        v = row.childIds.reduce((s, c) => s + calc(c, orgId), 0);
      }
      cache.set(key, v);
      return v;
    };
    return calc;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values, rowById]);

  /* ---------- 利润表指标:按组织列从全部科目明细实时勾稽计算(支持电站管理类费用转制造费用及人工资本化扣除) ---------- */
  const orgAccTotals = useMemo(() => {
    const build = (orgIds: number[]): Map<number, Map<number, number>> => {
      const result = new Map<number, Map<number, number>>();
      const e2Node = rowIndex.nodes.find((n) => n.code === 'E2');
      const c1101Node = rowIndex.nodes.find((n) => n.code === 'C1101');
      const c1Node = rowIndex.nodes.find((n) => n.code === 'C1');
      const capLaborNode = rowIndex.nodes.find((n) => n.code === 'E20199'); // 在建工程/资本化人工

      for (const oid of orgIds) {
        const orgNode = orgIndex.byId.get(oid);
        const isPowerStation = orgNode ? POWER_STATION_ORG_CODES.has(orgNode.code) : false;
        const totals = new Map<number, number>();

        // 第一遍:标准树汇总(排除资本化人工科目 E20199 进入费用汇总)
        for (const n of rowIndex.nodes) {
          const raw = values.get(`${oid}:${n.id}`) ?? '';
          if (raw.trim() === '') continue;
          const cents = wanToCents(raw);
          if (cents == null || cents === 0) continue;

          // E20199 为扣减项/不进损益项目,不向 E2 及损益汇总向上冒泡
          if (capLaborNode && n.id === capLaborNode.id) continue;

          const signed = cents * signOfType(n.type);
          let cur: { id: number; parent_id: number | null } | undefined = n;
          const seen = new Set<number>();
          while (cur && !seen.has(cur.id)) {
            seen.add(cur.id);
            totals.set(cur.id, (totals.get(cur.id) ?? 0) + signed);
            cur = cur.parent_id != null ? rowIndex.byId.get(cur.parent_id) : undefined;
          }
        }

        // 第二遍:电站组织分流——若为 5 大电站，其 E2 管理类费用总额转入 C1101 制造费用(营业成本)，E2 损益归零
        if (isPowerStation && e2Node) {
          const e2TotalSigned = totals.get(e2Node.id) ?? 0;
          if (e2TotalSigned !== 0) {
            // E2 期间费用清空
            totals.set(e2Node.id, 0);
            // 归入 C1101 制造费用 (金额为负数)
            if (c1101Node) {
              totals.set(c1101Node.id, (totals.get(c1101Node.id) ?? 0) + e2TotalSigned);
            }
            // 向上累加至 C1 营业成本
            if (c1Node) {
              totals.set(c1Node.id, (totals.get(c1Node.id) ?? 0) + e2TotalSigned);
            }
          }
        }

        result.set(oid, totals);
      }
      return result;
    };
    return build(orgCols);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [values, orgCols, rowIndex, orgIndex]);

  const globalAccTotals = useMemo(() => {
    const totals = new Map<number, number>();
    for (const per of orgAccTotals.values()) {
      for (const [id, c] of per) totals.set(id, (totals.get(id) ?? 0) + c);
    }
    return totals;
  }, [orgAccTotals]);

  const metricValue = (metricId: number, totals: Map<number, number>): number => {
    const defs = metricsData?.items ?? [];
    const byId = new Map(defs.map((m) => [m.id, m]));
    const seen = new Set<number>();
    const calc = (id: number): number => {
      if (seen.has(id)) return 0;
      seen.add(id);
      const m = byId.get(id);
      if (!m) return 0;
      let sum = 0;
      for (const t of m.terms) {
        if (t.source_type === 'account' && t.source_account_id != null) sum += (totals.get(t.source_account_id) ?? 0) * t.coefficient;
        else if (t.source_type === 'metric' && t.source_metric_id != null) sum += calc(t.source_metric_id) * t.coefficient;
      }
      return sum;
    };
    return calc(metricId);
  };

  const rowTotal = (row: Row): number => orgCols.reduce((s, o) => s + totalCache(row.id, o), 0);

  const displayTotal = (row: Row, v: number): string => {
    if (row.type === 'quantity') {
      if (row.quantityAgg === 'none') return '—';
      if (v === 0) return '';
      return formatQuantity(v);
    }
    if (v === 0) return '';
    return centsToWan(v * signOfType(row.type));
  };

  const rowHasValue = (r: GridRow): boolean => {
    if (r.kind === 'metric') {
      const global = metricValue(r.id, globalAccTotals);
      if (global !== 0) return true;
      return orgCols.some((o) => metricValue(r.id, orgAccTotals.get(o) ?? new Map()) !== 0);
    }
    if (findSheet(sheetKey, dbSheets)?.metric) {
      /* 利润表科目取数行:按各组织带符号汇总判断 */
      if ((globalAccTotals.get(r.id) ?? 0) !== 0) return true;
      return orgCols.some((o) => (orgAccTotals.get(o)?.get(r.id) ?? 0) !== 0);
    }
    return orgCols.some((o) => totalCache(r.id, o) !== 0);
  };

  return { totalCache, orgAccTotals, globalAccTotals, metricValue, rowTotal, displayTotal, rowHasValue };
}
