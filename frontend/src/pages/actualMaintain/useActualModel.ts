import { useMemo, useState } from 'react';
import { PROFIT_ROWS, SHEET_METRIC_ROWS, findSheet, type SheetDef } from '../../utils/sheets';
import { isAccountVisibleForScope } from '../../utils/accountScope';
import { buildOrgDisplayCols, type OrgColDef } from '../../utils/grid';
import type { OrgTreeResponse, AccountTreeResponse, MetricItem, GridRow } from './types';

/**
 * 历史数据维护页行/列模型:组织树索引 + 多级组织列 + 科目行(预设表展开)。
 */
export function useActualModel(
  orgTree: OrgTreeResponse | undefined,
  accTree: AccountTreeResponse | undefined,
  metrics: { items: MetricItem[] } | undefined,
  sheetKey: string,
  dbSheets: SheetDef[],
  orgScopeId: number | null,
) {
  /** 组织树索引与范围叶子 */
  const orgIndex = useMemo(() => {
    const rows = orgTree?.rows ?? [];
    const children = new Map<number, number[]>();
    rows.forEach((r) => { const p = r.parent_id; if (p != null) children.set(p, [...(children.get(p) ?? []), r.id]); });
    const byId = new Map(rows.map((r) => [r.id, r]));
    const leavesUnder = (id: number): number[] => {
      const kids = children.get(id) ?? [];
      return kids.length ? kids.flatMap(leavesUnder) : [id];
    };
    return { byId, children, leavesUnder };
  }, [orgTree]);

  const effectiveScopeId = orgScopeId ?? orgTree?.tree[0]?.id ?? null;
  const scopeLeaves = useMemo(() => (effectiveScopeId == null ? [] : orgIndex.leavesUnder(effectiveScopeId)), [effectiveScopeId, orgIndex]);
  const scopeLeafSet = useMemo(() => new Set(scopeLeaves), [scopeLeaves]);
  const singleLeafScope = scopeLeaves.length === 1 ? scopeLeaves[0] : null;

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
    () => buildOrgDisplayCols(orgIndex, effectiveScopeId, scopeLeaves, collapsedOrgCols),
    [orgIndex, effectiveScopeId, scopeLeaves, collapsedOrgCols],
  );

  const scopeLeafOrgCodes = useMemo(() => {
    const s = new Set<string>();
    for (const orgId of scopeLeaves) {
      const code = orgIndex.byId.get(orgId)?.code;
      if (code) s.add(code);
    }
    return s;
  }, [scopeLeaves, orgIndex]);

  /** 科目树索引 */
  const accIndex = useMemo(() => {
    const rows = accTree?.rows ?? [];
    const byId = new Map(rows.map((r) => [r.id, r]));
    const children = new Map<number, number[]>();
    rows.forEach((r) => { const p = r.parent_id; if (p != null) children.set(p, [...(children.get(p) ?? []), r.id]); });
    return { rows, byId, children };
  }, [accTree]);

  const accById = useMemo(() => new Map(accTree?.rows.map((r) => [r.id, r]) ?? []), [accTree]);

  const orgTreeData = useMemo(() => {
    interface OrgNode { id: number; code: string; name: string; children: OrgNode[] }
    interface TreeItem { value: number; title: string; children: TreeItem[] }
    const build = (nodes: OrgNode[]): TreeItem[] =>
      nodes.map((n) => ({ value: n.id, title: `${n.code} ${n.name}`, children: build(n.children) }));
    return build((orgTree?.tree ?? []) as OrgNode[]);
  }, [orgTree]);

  /** 行模型:按预设表展开科目(利润表=模板 15 行) */
  const rows: GridRow[] = useMemo(() => {
    const sheet = findSheet(sheetKey, dbSheets);
    if (!sheet) return [];
    if (sheet.metric) {
      const metricByCode = new Map((metrics?.items ?? []).map((m) => [m.code, m]));
      const out: GridRow[] = [];
      for (const pr of PROFIT_ROWS) {
        if (pr.kind === 'metric') {
          const m = metricByCode.get(pr.code);
          if (m) out.push({ kind: 'metric', id: m.id, code: m.code, name: m.name, label: pr.label, indent: pr.indent, bold: pr.bold });
        } else {
          const a = accIndex.rows.find((r) => r.code === pr.code);
          if (a) out.push({ kind: 'account', id: a.id, code: a.code, name: a.name, depth: pr.indent, type: a.type ?? 'expense', isLeaf: false, collapsedHere: false, label: pr.label, indent: pr.indent, bold: pr.bold });
        }
      }
      return out;
    }
    /* 一级汇总:根=当前科目树全部一级科目,且全部折叠为单行;其他表按模板计算行锚点插入指标行 */
    const treeRootCodes = (accTree?.rows ?? []).filter((r) => r.parent_id == null).map((r) => r.code);
    const rootCodes = sheet.key === 'overview' ? treeRootCodes : sheet.roots;
    const collapsed = new Set(sheet.key === 'overview' ? treeRootCodes : (sheet.collapsed ?? []));
    const metricByCode = new Map((metrics?.items ?? []).map((m) => [m.code, m]));
    const metricDefs = sheet.key === 'overview' ? [] : (SHEET_METRIC_ROWS[sheet.key] ?? []);
    const pushMetric = (list: GridRow[], def: { metricCode: string; label: string }) => {
      const m = metricByCode.get(def.metricCode);
      if (m) list.push({ kind: 'metric', id: m.id, code: m.code, name: m.name, label: def.label, indent: 0, bold: true });
    };
    const out: GridRow[] = [];
    const walk = (id: number, depth: number) => {
      const a = accIndex.byId.get(id);
      if (!a) return;
      if (!isAccountVisibleForScope(a.code, scopeLeafOrgCodes)) return;

      const rawKids = accIndex.children.get(id) ?? [];
      const allKids = rawKids.filter((kidId) => {
        const kid = accIndex.byId.get(kidId);
        return kid ? isAccountVisibleForScope(kid.code, scopeLeafOrgCodes) : true;
      });

      const collapsedHere = collapsed.has(a.code);
      // 叶子判定必须用结构子级(rawKids):范围过滤只影响展示,子级全被隐藏的
      // 汇总科目(如 010102 视角下的 I12)仍是后端树的非叶子,误标为可编辑会导致整包保存被拒
      out.push({ kind: 'account', id: a.id, code: a.code, name: a.name, depth, type: a.type ?? 'expense', unit: a.unit, quantityAgg: a.quantity_agg, isLeaf: rawKids.length === 0, collapsedHere });
      if (!collapsedHere) allKids.forEach((k) => walk(k, depth + 1));
    };
    for (const code of rootCodes) {
      if (!isAccountVisibleForScope(code, scopeLeafOrgCodes)) continue;
      for (const def of metricDefs.filter((x) => x.beforeRoot === code)) pushMetric(out, def);
      const root = accIndex.rows.find((r) => r.code === code);
      if (root) walk(root.id, 0);
    }
    for (const def of metricDefs.filter((x) => !x.beforeRoot)) pushMetric(out, def);
    return out;
  }, [sheetKey, dbSheets, accIndex, accTree, metrics, scopeLeafOrgCodes]);

  return {
    orgIndex, effectiveScopeId, scopeLeaves, scopeLeafSet, singleLeafScope,
    orgDisplayCols, collapsedOrgCols, toggleCollapseOrgCol, scopeLeafOrgCodes,
    accIndex, accById, orgTreeData, rows,
  };
}
