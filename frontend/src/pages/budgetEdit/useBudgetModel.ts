import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { api } from '../../api/client';
import { SPECIAL_SHEETS, PROFIT_ROWS, SHEET_METRIC_ROWS, findSheet, type SheetDef } from '../../utils/sheets';
import { buildOrgDisplayCols, type OrgColDef, type OrgTreeIndex } from '../../utils/grid';
import type { MatrixNode, MatrixResponse, MetricItem, AccIndex, GridRow, Row } from './types';

/**
 * 预算编制页数据模型:矩阵/指标查询 + 科目行模型(预设表展开) + 组织列模型(多级展开)。
 * 与渲染、交互层(useGridInteraction)完全解耦,只产出可展示的行列结构。
 */
export function useBudgetModel(versionId: number, sheetKey: string, orgColScopeId: number | null, dbSheets: SheetDef[]) {
  const validVersionId = Number.isInteger(versionId) && versionId > 0;
  const matrixQuery = useQuery({
    queryKey: ['budget-matrix', versionId],
    queryFn: () => api.get<MatrixResponse>(`/versions/${versionId}/matrix`),
    enabled: validVersionId,
  });
  const metricsQuery = useQuery({
    queryKey: ['metrics'],
    queryFn: () => api.get<{ items: MetricItem[] }>('/metrics'),
  });
  const data = matrixQuery.data;
  const metricsData = metricsQuery.data;

  /* ---------- 科目行模型(版本绑定快照口径) ---------- */
  const rowIndex: AccIndex = useMemo(() => {
    const nodes = data?.accountNodes ?? [];
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const children = new Map<number, number[]>();
    nodes.forEach((n) => { const p = n.parent_id; if (p != null) children.set(p, [...(children.get(p) ?? []), n.id]); });
    return { nodes, byId, children };
  }, [data]);

  const rows: GridRow[] = useMemo(() => {
    const sheet = findSheet(sheetKey, dbSheets);
    if (!sheet) return [];
    /* 利润表 = 模板 15 行(5 个指标小计行 + 10 个科目取数行),全部只读自动勾稽 */
    if (sheet.metric) {
      const metricByCode = new Map((metricsData?.items ?? []).map((m) => [m.code, m]));
      const out: GridRow[] = [];
      for (const pr of PROFIT_ROWS) {
        if (pr.kind === 'metric') {
          const m = metricByCode.get(pr.code);
          if (m) out.push({ kind: 'metric', id: m.id, code: m.code, name: m.name, label: pr.label, indent: pr.indent, bold: pr.bold });
        } else {
          const a = rowIndex.nodes.find((n) => n.code === pr.code);
          if (a) out.push({
            kind: 'account', id: a.id, code: a.code, name: a.name, depth: pr.indent, type: a.type ?? 'expense',
            isLeaf: false, collapsedHere: false, status: a.status, childIds: [], label: pr.label, indent: pr.indent, bold: pr.bold,
          });
        }
      }
      return out;
    }
    /* 普通表:根科目展开(折叠清单内只留汇总行);模板计算行(如收入成本表的总收入/总成本)按锚点插入。
       一级汇总(overview)与全部科目(all)直接按版本绑定快照的根科目构造,不依赖任何自定义模板:
       overview 全部折叠为单行汇总;all 完全展开到可填写末级(UX-06)。 */
    const snapshotRootCodes = (data?.accountNodes ?? []).filter((n) => n.parent_id == null).map((n) => n.code);
    const isSnapshotSheet = sheet.key === 'overview' || sheet.key === 'all';
    const rootCodes = isSnapshotSheet ? snapshotRootCodes : sheet.roots;
    const collapsed = new Set(sheet.key === 'overview' ? snapshotRootCodes : sheet.key === 'all' ? [] : (sheet.collapsed ?? []));
    const metricByCode = new Map((metricsData?.items ?? []).map((m) => [m.code, m]));
    const metricDefs = isSnapshotSheet ? [] : (SHEET_METRIC_ROWS[sheet.key] ?? []);
    const pushMetric = (list: GridRow[], def: { metricCode: string; label: string }) => {
      const m = metricByCode.get(def.metricCode);
      if (m) list.push({ kind: 'metric', id: m.id, code: m.code, name: m.name, label: def.label, indent: 0, bold: true });
    };
    const out: GridRow[] = [];
    const walk = (nodeId: number, depth: number) => {
      const n = rowIndex.byId.get(nodeId);
      if (!n) return;
      const allKids = rowIndex.children.get(nodeId) ?? [];
      const collapsedHere = collapsed.has(n.code);
      const kids = collapsedHere ? [] : allKids;
      out.push({ kind: 'account', id: n.id, code: n.code, name: n.name, depth, type: n.type ?? 'expense', unit: n.unit, quantityAgg: n.quantity_agg, isLeaf: allKids.length === 0, collapsedHere, status: n.status, childIds: allKids });
      kids.forEach((k) => walk(k, depth + 1));
    };
    for (const code of rootCodes) {
      for (const def of metricDefs.filter((x) => x.beforeRoot === code)) pushMetric(out, def);
      const root = rowIndex.nodes.find((n) => n.code === code);
      if (root) walk(root.id, 0);
    }
    for (const def of metricDefs.filter((x) => !x.beforeRoot)) pushMetric(out, def);
    return out;
  }, [sheetKey, dbSheets, rowIndex, data, metricsData]);

  const rowById = useMemo(() => new Map(rows.filter((r): r is Row => r.kind === 'account').map((r) => [r.id, r])), [rows]);

  /* ---------- 组织列(叶子,可按子树筛选) ---------- */
  const orgIndex = useMemo(() => {
    const nodes = data?.orgNodes ?? [];
    const byId = new Map(nodes.map((n) => [n.id, n]));
    const children = new Map<number, number[]>();
    nodes.forEach((n) => { const p = n.parent_id; if (p != null) children.set(p, [...(children.get(p) ?? []), n.id]); });
    const leavesUnder = (id: number): number[] => {
      const kids = children.get(id) ?? [];
      return kids.length ? kids.flatMap(leavesUnder) : [id];
    };
    return { byId, children, leavesUnder };
  }, [data]);

  const rootOrgId = useMemo(() => {
    const nodes = data?.orgNodes ?? [];
    return nodes.find((n) => n.parent_id == null)?.id ?? null;
  }, [data]);

  const effectiveOrgScope = orgColScopeId ?? rootOrgId;
  const orgCols = useMemo(() => {
    if (!data) return [];
    const leafSet = new Set(data.leafOrgIds);
    const scope = effectiveOrgScope == null ? [] : orgIndex.leavesUnder(effectiveOrgScope);
    return scope.filter((id) => leafSet.has(id));
  }, [data, effectiveOrgScope, orgIndex]);

  /* ---------- 多级组织列体系(最左侧根汇总 + 板块小计 + 末级子电站/单位展开与折叠) ---------- */
  const [collapsedOrgCols, setCollapsedOrgCols] = useState<Set<number>>(new Set());

  const toggleCollapseOrgCol = (orgId: number) => {
    setCollapsedOrgCols((prev) => {
      const next = new Set(prev);
      if (next.has(orgId)) next.delete(orgId);
      else next.add(orgId);
      return next;
    });
  };

  const orgDisplayCols: OrgColDef[] = useMemo(
    () => buildOrgDisplayCols(orgIndex as OrgTreeIndex, effectiveOrgScope, orgCols, collapsedOrgCols),
    [orgIndex, effectiveOrgScope, orgCols, collapsedOrgCols],
  );

  /** 键盘导航与矩阵粘贴按"当前实际展示的叶子列"顺序进行:
   *  折叠小计的后代列不在 orgDisplayCols 中,若按全量 orgCols 索引,
   *  Tab 会指向不存在的输入框、多列粘贴会写入不可见组织 */
  const orgNavCols = useMemo(() => orgDisplayCols.filter((c) => c.isLeaf).map((c) => c.id), [orgDisplayCols]);

  const orgTreeData = useMemo(() => {
    interface TNode { value: number; title: string; children: TNode[] }
    const build = (nodes: MatrixNode[]): TNode[] =>
      nodes.map((n) => ({ value: n.id, title: `${n.code} ${n.name}`, children: build((data?.orgNodes ?? []).filter((c) => c.parent_id === n.id)) }));
    return build((data?.orgNodes ?? []).filter((n) => n.parent_id == null));
  }, [data]);

  return {
    data, metricsData,
    error: matrixQuery.error ?? metricsQuery.error,
    isLoading: matrixQuery.isLoading || metricsQuery.isLoading,
    refetch: () => Promise.all([matrixQuery.refetch(), metricsQuery.refetch()]),
    rowIndex, rows, rowById,
    orgIndex: orgIndex as OrgTreeIndex, rootOrgId, effectiveOrgScope, orgCols,
    orgDisplayCols, collapsedOrgCols, toggleCollapseOrgCol, orgNavCols,
    orgTreeData,
  };
}
