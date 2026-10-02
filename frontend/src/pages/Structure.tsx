import { useCallback, useEffect, useMemo, useRef, useState, type Key } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import {
  Alert, Card, Select, Space, Collapse, Descriptions, Empty, Result, Button, TreeSelect, Grid,
  Typography, Tag, Input, Row, Col, Statistic, Tooltip,
} from 'antd';
import type { TableColumnsType } from 'antd';
import { EnhancedTable as Table } from '../components/EnhancedTable';
import { api, download } from '../api/client';
import { errorText } from '../components/TreeNodePage';
import { centsToWan, formatQuantity, formatRatio, formatRatioDelta } from '../utils/money';
import MoneyText from '../components/MoneyText';
import { treeIndentReserve } from '../utils/tableColumns';
import { escapeHtml } from '../utils/escapeHtml';
import { SPECIAL_SHEETS, useSheets } from '../utils/sheets';
import EChart from '../components/EChart';
import { chartTheme, useThemeMode, withAlpha, statusColor } from '../theme';
import { RankBarRow } from '../components/RankBarRow';
import { VerifyBar, type VerifyItem } from '../components/VerifyBar';
import { useAssistantPageContext } from '../assistant/contextHooks';
import { useOptionalAssistantRegistry } from '../assistant/AssistantContextRegistry';
import type { ChartSemanticClick } from '../components/EChart';

/**
 * 结构占比分析(共同比报表)。
 *
 * 与「年度执行分析」的区别:这里看的是**构成比重**而不是完成率。
 * 占比不可跨行相加(唯一例外是同一上级下的各子项),差异是结构百分点差。
 */

type BasisMode = 'parent' | 'account' | 'metric';

interface StructureShare {
  scaled: number | null;
  special: null | 'na_zero_basis' | 'na_negative_basis';
  numeratorCents: number;
  basisCents: number;
}

interface StructureRow {
  accountId: number;
  parentId: number | null;
  code: string;
  name: string;
  type: string;
  level: number;
  isLeaf: boolean;
  budgetCents: number;
  actualCents: number;
  budget: StructureShare;
  actual: StructureShare;
  deltaScaled: number | null;
  basisLabel: string;
  children?: StructureRow[];
}

interface Reconciliation {
  parentId: number;
  parentCode: string;
  parentName: string;
  childCount: number;
  budgetChildSumCents: number;
  budgetParentCents: number;
  actualChildSumCents: number;
  actualParentCents: number;
  amountReconciled: boolean;
  budgetShareSumScaled: number | null;
  actualShareSumScaled: number | null;
}

interface UnbudgetedActualEntry {
  orgId: number;
  orgCode: string;
  orgName: string;
  accountId: number;
  accountCode: string;
  accountName: string;
  accountType: string;
  amountCents: number;
  quantity: number | null;
  reason: string;
}

interface StructureReport {
  version: { id: number; year: number; name: string; kind: 'budget' | 'forecast' };
  asOfDate: string | null;
  actualSource: string;
  actualBatchId: number | null;
  treeBasis: { org: string; account: string };
  scopeBasis: { sheetKey: string; sheetName: string; orgScopeId: number | null; accountScopeId: number | null; summaryLevel: number | null };
  basis: { mode: BasisMode; id: number | null; label: string };
  rows: StructureRow[];
  reconciliation: Reconciliation[];
  unbudgetedActual: { count: number; amountCents: number; entries: UnbudgetedActualEntry[] };
  actualReconciliation: { sourceActualCents: number; displayedActualCents: number; differenceCents: number };
  /** 核验事实(§9.5):reconciliation/subtotal/unbudgeted/actual_none,页面与助手共用 */
  verificationFacts: VerificationFactItem[];
  notes: string[];
}

/** 后端核验事实(与 backend/src/modules/report/verification.ts 对应)。 */
interface VerificationFactItem {
  factKey: string;
  serverLevel: 'ok' | 'warn' | 'bad';
  scope: { versionId: number | null; batchId: number | null; orgScopeId: number | null; accountScopeId: number | null; sheetKey: string | null };
  label: string;
  details: string[];
  facts: Record<string, number | string | null>;
  actionTarget: { kind: 'anchor'; anchor: string; hint: string } | null;
}

const SHARE_SPECIAL: Record<string, string> = {
  na_zero_basis: '不适用（占比基准为 0）',
  na_negative_basis: '不适用（占比基准归一后为负）',
};

const positiveInt = (value: string | null): number | null => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const buildQuery = (values: Record<string, string | number | null | undefined>) => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value != null && value !== '' && value !== 0) query.set(key, String(value));
  return query.toString();
};

/** 扁平行转树(按 parentId),便于按科目层级折叠查看构成 */
function buildTreeRows(rows: StructureRow[]): StructureRow[] {
  const source = rows.map((row) => ({ ...row, children: [] as StructureRow[] }));
  const byId = new Map(source.map((row) => [row.accountId, row]));
  const roots: typeof source = [];
  for (const row of source) {
    const parent = row.parentId == null ? undefined : byId.get(row.parentId);
    if (parent) parent.children.push(row);
    else roots.push(row);
  }
  const clean = (items: typeof source): StructureRow[] => items.map((item) => {
    item.children.sort((a, b) => a.code.localeCompare(b.code));
    if (item.children.length === 0) delete (item as { children?: StructureRow[] }).children;
    return item as StructureRow;
  });
  return clean(roots.sort((a, b) => a.code.localeCompare(b.code)));
}

function filterTree(rows: StructureRow[], keyword: string): StructureRow[] {
  if (!keyword.trim()) return rows;
  const needle = keyword.trim().toLowerCase();
  const walk = (items: StructureRow[]): StructureRow[] => items.flatMap((row) => {
    const children = walk(row.children ?? []);
    if (`${row.code} ${row.name}`.toLowerCase().includes(needle) || children.length > 0) {
      return [{ ...row, children: children.length ? children : undefined }];
    }
    return [];
  });
  return walk(rows);
}

export default function Structure() {
  const screens = Grid.useBreakpoint();
  const { mode } = useThemeMode();
  const [params, setParams] = useSearchParams();
  const [accountSearch, setAccountSearch] = useState('');
  const { sheets: dbSheets, loading: sheetsLoading } = useSheets();

  const year = positiveInt(params.get('year')) ?? undefined;
  const versionId = positiveInt(params.get('version')) ?? undefined;
  const batchId = positiveInt(params.get('batch'));
  const orgScopeId = positiveInt(params.get('org'));
  const accountScopeId = positiveInt(params.get('account'));
  const sheetKey = params.get('sheet') || 'all';
  const summaryLevel = positiveInt(params.get('level'));
  const basisModeRaw = params.get('basisMode');
  const basisMode: BasisMode = basisModeRaw === 'account' || basisModeRaw === 'metric' ? basisModeRaw : 'parent';
  const basisId = positiveInt(params.get('basisId'));

  const setFilter = (key: string, value: string | number | null | undefined, resets: string[] = []) => {
    const next = new URLSearchParams(params);
    if (value == null || value === '' || value === 0) next.delete(key); else next.set(key, String(value));
    resets.forEach((item) => next.delete(item));
    setParams(next, { replace: true });
  };

  const versionsQuery = useQuery({
    queryKey: ['versions'],
    queryFn: () => api.get<{ id: number; year: number; name: string; status: string; is_current: 0 | 1; kind: 'budget' | 'forecast' }[]>('/versions'),
  });
  const versions = versionsQuery.data ?? [];
  const years = useMemo(() => [...new Set(versions.filter((item) => item.kind === 'budget').map((item) => item.year))].sort((a, b) => b - a), [versions]);

  // 默认落到当前生效预算版本(与年度执行分析页一致)
  useEffect(() => {
    if (!versions.length) return;
    const selectedYear = year && years.includes(year) ? year : (versions.find((item) => item.kind === 'budget' && item.is_current)?.year ?? years[0]);
    const budgets = versions.filter((item) => item.kind === 'budget' && item.year === selectedYear);
    const selectedVersion = budgets.find((item) => item.id === versionId)
      ?? budgets.find((item) => item.is_current)
      ?? budgets.find((item) => item.status !== 'draft')
      ?? budgets[0];
    const next = new URLSearchParams(params);
    let changed = false;
    if (selectedYear && String(selectedYear) !== params.get('year')) { next.set('year', String(selectedYear)); changed = true; }
    if (selectedVersion && String(selectedVersion.id) !== params.get('version')) { next.set('version', String(selectedVersion.id)); changed = true; }
    if (changed) setParams(next, { replace: true });
  }, [params, setParams, versionId, versions, year, years]);

  const budgetVersions = versions.filter((item) => item.kind === 'budget' && item.year === year);

  const batchesQuery = useQuery({
    queryKey: ['batches-for-analysis', year],
    enabled: Boolean(year),
    queryFn: () => api.get<{ id: number; snapshot_date: string; revision: number; status: string; year: number }[]>(`/actual/batches?year=${year}`),
  });
  const versionMetadataQuery = useQuery({
    queryKey: ['budget-matrix', versionId],
    enabled: Boolean(versionId),
    queryFn: () => api.get<{
      orgNodes: { id: number; parent_id: number | null; code: string; name: string }[];
      accountNodes: { id: number; parent_id: number | null; code: string; name: string; type?: string }[];
    }>(`/versions/${versionId}/matrix`),
  });
  const metricsQuery = useQuery({
    queryKey: ['version-metrics', versionId],
    enabled: Boolean(versionId),
    queryFn: () => api.get<{ items: { id: number; code: string; name: string; kind: 'linear' | 'ratio'; status: string }[] }>(`/versions/${versionId}/metrics`),
  });

  const orgTreeData = useMemo(() => {
    interface Node { id: number; parent_id: number | null; code: string; name: string }
    interface TreeItem { value: number; title: string; children: TreeItem[] }
    const rows = (versionMetadataQuery.data?.orgNodes ?? []) as Node[];
    const children = new Map<number | null, Node[]>();
    rows.forEach((node) => children.set(node.parent_id, [...(children.get(node.parent_id) ?? []), node]));
    const build = (parentId: number | null): TreeItem[] => (children.get(parentId) ?? []).map((node) => ({
      value: node.id,
      title: `${node.code} ${node.name}`,
      children: build(node.id),
    }));
    return build(null);
  }, [versionMetadataQuery.data]);

  /** 基准科目候选:排除数量科目(金额恒为零,不能作基准) */
  const basisAccountOptions = useMemo(
    () => (versionMetadataQuery.data?.accountNodes ?? [])
      .filter((row) => row.type !== 'quantity')
      .map((row) => ({ value: row.id, label: `${row.code} ${row.name}` })),
    [versionMetadataQuery.data],
  );
  /** 基准指标候选:只有金额型(比率不是金额,不能作基准) */
  const basisMetricOptions = useMemo(
    () => (metricsQuery.data?.items ?? [])
      .filter((item) => item.kind !== 'ratio' && item.status === 'active')
      .map((item) => ({ value: item.id, label: `${item.code} ${item.name}` })),
    [metricsQuery.data],
  );

  // URL 可能携带上一版本的快照 ID；版本切换后及时清理失效值，
  // 避免把当前主数据 ID 或另一历史版本 ID 提交给后端。
  useEffect(() => {
    if (!versionMetadataQuery.data || !versionId) return;
    const orgIds = new Set(versionMetadataQuery.data.orgNodes.map((item) => item.id));
    const accountIds = new Set(versionMetadataQuery.data.accountNodes.map((item) => item.id));
    const metricIds = new Set((metricsQuery.data?.items ?? []).filter((item) => item.kind !== 'ratio' && item.status === 'active').map((item) => item.id));
    const next = new URLSearchParams(params);
    let changed = false;
    if (orgScopeId != null && !orgIds.has(orgScopeId)) { next.delete('org'); changed = true; }
    if (accountScopeId != null && !accountIds.has(accountScopeId)) { next.delete('account'); changed = true; }
    if (basisId != null && basisMode === 'account' && !accountIds.has(basisId)) { next.delete('basisId'); changed = true; }
    if (basisId != null && basisMode === 'metric' && metricsQuery.data && !metricIds.has(basisId)) { next.delete('basisId'); changed = true; }
    if (changed) setParams(next, { replace: true });
  }, [accountScopeId, basisId, basisMode, metricsQuery.data, orgScopeId, params, setParams, versionId, versionMetadataQuery.data]);

  const queryString = buildQuery({
    versionId, batchId, orgScopeId, accountScopeId, sheetKey, summaryLevel, basisMode, basisId,
  });
  const reportQuery = useQuery({
    queryKey: ['structure-analysis', queryString],
    enabled: Boolean(versionId) && (basisMode === 'parent' || Boolean(basisId)),
    queryFn: () => api.get<StructureReport>(`/report/structure?${queryString}`),
  });
  const report = reportQuery.data;

  /**
   * 财务助手页面登记(§7.3)：basisMode 与 basisId 决定占比基准，一起进入 view 由后端校验；
   * accountSearch 默认只属于 view。异步默认值(年度/版本)写入 URL 之前不宣称已对齐。
   */
  useAssistantPageContext({
    pageKey: 'structure',
    ready: Boolean(year && versionId) && !versionsQuery.isLoading && !sheetsLoading,
    notReadyReason: '正在读取结构分析的默认年度与版本',
    readyState: 'loading',
    scope: {
      year,
      budgetVersionId: versionId ?? undefined,
      actualSnapshotId: batchId ?? undefined,
      orgScopeId: orgScopeId ?? undefined,
      accountScopeId: accountScopeId ?? undefined,
    },
    view: {
      sheetKey,
      ...(summaryLevel != null ? { summaryLevel } : {}),
      basisMode,
      ...(basisId != null ? { basisId } : {}),
      ...(accountSearch.trim() ? { accountSearch: accountSearch.trim() } : {}),
    },
  });

  /* 图表点击 → chart_point(account) 焦点(§8.4):占比变化条形按「code name」类目反查,
     构成环图按切片名反查一级/子级科目。 */
  const assistantRegistry = useOptionalAssistantRegistry();
  const chartFocusTokenRef = useRef<symbol | null>(null);
  const focusAccount = useCallback((seriesKey: string, accountId: number, label: string) => {
    if (!assistantRegistry) return;
    if (chartFocusTokenRef.current) assistantRegistry.clearFocus(chartFocusTokenRef.current);
    chartFocusTokenRef.current = assistantRegistry.setFocus(
      { kind: 'chart_point', seriesKey, dimensionType: 'account', dimensionId: accountId },
      label,
    );
  }, [assistantRegistry]);
  useEffect(() => () => {
    if (chartFocusTokenRef.current) assistantRegistry?.clearFocus(chartFocusTokenRef.current);
  }, [assistantRegistry]);
  const handleShareShiftClick = useCallback((point: ChartSemanticClick) => {
    const row = report?.rows.find((item) => `${item.code} ${item.name}` === point.name);
    if (row) focusAccount('share_shift', row.accountId, `占比变化 · ${row.code} ${row.name}`);
  }, [report, focusAccount]);
  const treeRows = useMemo(
    () => filterTree(buildTreeRows(report?.rows ?? []), accountSearch),
    [report, accountSearch],
  );
  const expandedKeys = useMemo<Key[]>(() => {
    if (!accountSearch.trim()) return [];
    const keys: number[] = [];
    const walk = (items: StructureRow[]) => items.forEach((item) => { keys.push(item.accountId); walk(item.children ?? []); });
    walk(treeRows);
    return keys;
  }, [accountSearch, treeRows]);
  const [controlledExpandedKeys, setControlledExpandedKeys] = useState<readonly Key[]>([]);
  useEffect(() => {
    if (accountSearch.trim()) setControlledExpandedKeys(expandedKeys);
  }, [accountSearch, expandedKeys]);

  const brokenReconciliation = (report?.reconciliation ?? []).filter((item) => !item.amountReconciled);

  /**
   * 页面自检结论(§9.5)：直接渲染后端 verificationFacts——
   * 「守恒不平且存在承接区是可解释的正常态(warn)，没有承接区却不平才是结构异常(bad)」
   * 这一区分只在后端判定一次，页面与助手读取同一份结论。
   */
  const verifyItems = useMemo<VerifyItem[]>(() => {
    if (!report) return [];
    return report.verificationFacts.map((fact) => ({
      key: fact.factKey.replace(/_/g, '-'),
      level: fact.serverLevel,
      label: fact.label,
      details: fact.details.length ? fact.details : undefined,
      assistantTarget: {
        ownerKey: 'structure:root',
        factKey: fact.factKey,
        scopeRef: {
          ...(fact.scope.versionId != null ? { versionId: fact.scope.versionId } : {}),
          ...(fact.scope.batchId != null ? { batchId: fact.scope.batchId } : {}),
          ...(fact.scope.orgScopeId != null ? { orgScopeId: fact.scope.orgScopeId } : {}),
          ...(fact.scope.accountScopeId != null ? { accountScopeId: fact.scope.accountScopeId } : {}),
          ...(fact.scope.sheetKey != null ? { sheetKey: fact.scope.sheetKey } : {}),
        },
      },
    }));
  }, [report]);

  /**
   * 结构占比变化:预算占比 vs 实际占比的双向条形。
   * deltaScaled 是 1e6 缩放定点数,除 1e4 得百分点。只取有占比的行,
   * 按 |百分点差| 排序后取前 12 —— 结构变化本身无好坏,故不着红绿。
   */
  const shareShift = useMemo(() => {
    if (!report) return null;
    const rows = report.rows
      .filter((row) => row.budget.scaled != null || row.actual.scaled != null)
      .map((row) => ({
        code: row.code,
        name: row.name,
        budgetPp: row.budget.scaled == null ? null : row.budget.scaled / 10_000,
        actualPp: row.actual.scaled == null ? null : row.actual.scaled / 10_000,
        deltaPp: row.deltaScaled == null ? null : row.deltaScaled / 10_000,
      }))
      .sort((a, b) => Math.abs(b.deltaPp ?? 0) - Math.abs(a.deltaPp ?? 0));
    return rows.length === 0 ? null : { rows: rows.slice(0, 12), total: rows.length };
  }, [report]);

  const shareShiftOption = useMemo(() => {
    if (!shareShift) return {};
    const t = chartTheme(mode);
    const rows = [...shareShift.rows].reverse();
    return {
      tooltip: { trigger: 'axis', axisPointer: { type: 'shadow' } },
      legend: { data: ['预算占比', '实际占比'], top: 4, icon: 'roundRect', itemWidth: 12, itemHeight: 8 },
      grid: { top: 30, left: 8, right: 26, bottom: 20, containLabel: true },
      xAxis: { type: 'value', axisLabel: { formatter: (v: number) => `${v.toFixed(0)}%` } },
      yAxis: { type: 'category', data: rows.map((row) => `${row.code} ${row.name}`), axisTick: { show: false } },
      series: [
        {
          name: '预算占比', type: 'bar', barWidth: '38%',
          data: rows.map((row) => row.budgetPp),
          itemStyle: { color: withAlpha(t.colors[0], 0.55), borderRadius: [0, 3, 3, 0] },
        },
        {
          name: '实际占比', type: 'bar', barWidth: '38%',
          data: rows.map((row) => row.actualPp),
          itemStyle: { color: t.colors[1], borderRadius: [0, 3, 3, 0] },
          label: {
            show: true, position: 'right', fontSize: 12,
            formatter: (p: { dataIndex: number }) => {
              const delta = rows[p.dataIndex].deltaPp;
              return delta == null ? '' : `${delta > 0 ? '+' : ''}${delta.toFixed(2)}pp`;
            },
          },
        },
      ],
    };
  }, [shareShift, mode]);

  /**
   * 科目构成双层环图 + Top 8 构成排行行(同一份数据源、同一套色阶派生):
   * - 环图:内环=一级科目(水平内嵌标签,始终可读),外环=直属子科目
   *   (引导线外置标签,线段+拐点指向切片)。旭日图不支持引导线,径向旋转文字在
   *   小切片上必然挤压,故改用饼图系列;更深层级卷积到直属子项,细节交给 tooltip。
   * - 排行行:一级科目按构成额取前 8,色样与环图切片同色(同一 deltaColor),
   *   数值与环图 tooltip 的「预算」逐分相等,构成速览不必悬停逐片查。
   * 只有 parent 基准下各层占比才有统一的层级语义,故仅在此时展示。
   */
  const composition = useMemo(() => {
    if (!report || report.basis.mode !== 'parent') return { option: {}, rank: [], clickRows: { inner: [], outer: [] } };
    const t = chartTheme(mode);
    const rows = report.rows.filter((row) => row.budget.numeratorCents !== 0 || row.actual.numeratorCents !== 0);
    if (rows.length === 0) return { option: {}, rank: [], clickRows: { inner: [], outer: [] } };
    type RowT = (typeof rows)[number];
    const childrenOf = (parentId: number): RowT[] => rows.filter((row) => row.parentId === parentId);
    // numeratorCents 已由后端沿祖先链汇总，不能再次累加子行，否则层级越深重复越多。
    const subtreeWan = (row: RowT): number => Math.abs(row.budget.numeratorCents) / 1_000_000;
    const decorate = (row: RowT, value: number) => ({
      name: row.name,
      value,
      deltaPp: row.deltaScaled == null ? null : row.deltaScaled / 10_000,
      budgetWan: row.budget.numeratorCents / 1_000_000,
      actualWan: row.actual.numeratorCents / 1_000_000,
    });
    const innerRows = rows.filter((row) => row.parentId === null);
    const inner = innerRows.map((row) => decorate(row, subtreeWan(row)));
    if (inner.length === 0) return { option: {}, rank: [], clickRows: { inner: [], outer: [] } };
    const outerRows = rows
      .filter((row) => row.parentId === null)
      .flatMap((root) => childrenOf(root.accountId));
    const outer = outerRows.map((child) => decorate(child, subtreeWan(child)));
    /** 变化幅度色阶:|Δ| 越大越暖,无占比的行走中性灰 */
    const deltaColor = (deltaPp: number | null) => {
      if (deltaPp == null) return mode === 'dark' ? '#4e5969' : '#c9cdd4';
      const magnitude = Math.min(Math.abs(deltaPp) / 5, 1);
      return magnitude < 0.02 ? (mode === 'dark' ? '#4e5969' : '#c9cdd4') : withAlpha(t.colors[1], 0.35 + magnitude * 0.6);
    };
    const paint = (nodes: { name: string; value: number; deltaPp: number | null; budgetWan: number; actualWan: number }[]) =>
      nodes.map((node) => ({ ...node, itemStyle: { color: deltaColor(node.deltaPp) } }));
    const border = { borderColor: mode === 'dark' ? '#1d1d1f' : '#fff', borderWidth: 1.5 };
    /* Top 8 构成排行行:share 用一级科目构成额(绝对值)占同级合计的比例;
       数值直接取原始行的 numeratorCents,与环图 tooltip 的「预算」逐分相等。
       占比用整数分(同源、不经过万元浮点)计算,避免 wan/totalWan 双重浮点往返
       导致排行标签与环图 share 末位差 1pp。 */
    const totalCents = innerRows.reduce((sum, row) => sum + Math.abs(row.budget.numeratorCents), 0);
    const rank = totalCents === 0 ? [] : innerRows
      .map((row) => ({ row, cents: Math.abs(row.budget.numeratorCents) }))
      .sort((a, b) => b.cents - a.cents)
      .slice(0, 8)
      .map(({ row, cents }) => ({
        key: row.accountId,
        color: deltaColor(row.deltaScaled == null ? null : row.deltaScaled / 10_000),
        label: row.name,
        value: centsToWan(row.budget.numeratorCents),
        share: cents / totalCents,
        shareLabel: formatRatio(Math.round((cents / totalCents) * 1_000_000), 'percent'),
      }));
    return {
      option: {
        tooltip: {
          formatter: (p: { name: string; data: { deltaPp: number | null; budgetWan: number; actualWan: number } }) =>
            `${escapeHtml(p.name)}<br/>预算 ${p.data.budgetWan.toFixed(2)} 万元<br/>实际 ${p.data.actualWan.toFixed(2)} 万元<br/>占比变化 ${p.data.deltaPp == null ? '不适用（基准为 0）' : `${p.data.deltaPp > 0 ? '+' : ''}${p.data.deltaPp.toFixed(2)}pp`}`,
        },
        series: [
          {
            // 内环:一级科目,水平内嵌标签(饼图默认不旋转,任何位置都正立可读)
            name: 'inner',
            type: 'pie',
            radius: ['24%', '44%'],
            data: paint(inner),
            itemStyle: border,
            minShowLabelAngle: 20,
            label: { fontSize: 12, color: t.text },
            labelLine: { show: false },
          },
          {
            // 外环:子科目,引导线外置标签;过小的切片不渲染文字,悬停可读;标签做 5 字截断避免引线过长被图表容器切断
            name: 'outer',
            type: 'pie',
            radius: ['48%', '62%'],
            data: paint(outer),
            itemStyle: border,
            minShowLabelAngle: 18,
            label: {
              position: 'outside',
              fontSize: 12,
              color: t.text,
              formatter: (p: { name: string }) => (p.name.length > 5 ? `${p.name.slice(0, 5)}…` : p.name),
            },
            labelLine: {
              show: true, length: 8, length2: 10, smooth: true,
              lineStyle: { color: mode === 'dark' ? '#4e5969' : '#a9b0bd' },
            },
            labelLayout: { hideOverlap: true },
          },
        ],
      },
      rank,
      // 点击反查用行列:环图两圈 series 与 EChart 的 dataIndex 一一对应;
      // 按名称反查会在同名科目或内外圈重名时指错焦点。
      clickRows: { inner: innerRows, outer: outerRows },
    };
  }, [report, mode]);

  const handleCompositionClick = useCallback((point: ChartSemanticClick) => {
    // 两圈 series 各自命名(inner/outer):dataIndex 直接索引到构造 series 数据的
    // 原始行;按名称反查会在同名科目或内外圈重名时指错焦点。
    const row = point.seriesKey === 'outer'
      ? composition.clickRows.outer[point.dataIndex]
      : composition.clickRows.inner[point.dataIndex];
    if (row) focusAccount('composition', row.accountId, `科目构成 · ${row.code} ${row.name}`);
  }, [composition, focusAccount]);

  const columns: TableColumnsType<StructureRow> = [
    /* 树形首列:编码 nowrap,名称省略 + Tooltip,深层行不折行撑高(方案一.4/三.2) */
    {
      title: '科目',
      width: 260 + treeIndentReserve(4, 16, 24),
      fixed: screens.lg ? 'left' : undefined,
      onCell: () => ({ style: { whiteSpace: 'nowrap' } }),
      render: (_v, row) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', minWidth: 0 }}>
          <span style={{ whiteSpace: 'nowrap' }}>{row.code}</span>
          {' '}
          <Tooltip title={row.name}>
            <span style={{ display: 'inline-block', maxWidth: 120, overflow: 'hidden', textOverflow: 'ellipsis', verticalAlign: 'bottom' }}>{row.name}</span>
          </Tooltip>
          {row.isLeaf ? null : <Typography.Text type="secondary" style={{ marginLeft: 2, flex: '0 0 auto' }}> ·</Typography.Text>}
        </span>
      ),
    },
    {
      title: '年度预算(万元)', align: 'right', width: 130,
      render: (_v, row) => <MoneyText cents={row.budget.numeratorCents} hideUnit />,
    },
    {
      title: '累计实际(万元)', align: 'right', width: 130,
      render: (_v, row) => <MoneyText cents={row.actual.numeratorCents} hideUnit />,
    },
    {
      title: '预算占比', align: 'right', width: 110,
      render: (_v, row) => (row.budget.scaled == null
        ? <Typography.Text type="secondary">{SHARE_SPECIAL[row.budget.special ?? ''] ?? '不适用'}</Typography.Text>
        : formatRatio(row.budget.scaled, 'percent')),
    },
    {
      title: '实际占比', align: 'right', width: 110,
      render: (_v, row) => (row.actual.scaled == null
        ? <Typography.Text type="secondary">{SHARE_SPECIAL[row.actual.special ?? ''] ?? '不适用'}</Typography.Text>
        : formatRatio(row.actual.scaled, 'percent')),
    },
    {
      title: '结构差异', align: 'right', width: 120,
      sorter: (a, b) => Math.abs(a.deltaScaled ?? 0) - Math.abs(b.deltaScaled ?? 0),
      render: (_v, row) => {
        if (row.deltaScaled == null) return <Typography.Text type="secondary" title="预算或实际占比不适用，无法计算差异">不适用</Typography.Text>;
        // 结构变化本身无好坏之分(收入结构变化 ≠ 不利),只用强弱标注幅度,不着红绿
        const strong = Math.abs(row.deltaScaled) >= 10_000; // ≥1 个百分点
        return <Typography.Text strong={strong}>{formatRatioDelta(row.deltaScaled, 'percent')}</Typography.Text>;
      },
    },
    ...(basisMode === 'parent'
      ? [{ title: '占比基准', width: 200, render: (_v: unknown, row: StructureRow) => <Typography.Text type="secondary" style={{ fontSize: 12 }}>{row.basisLabel}</Typography.Text> }]
      : []),
  ];

  const exportStructure = async () => {
    if (!versionId) return;
    const query = buildQuery({ batchId, orgScopeId, accountScopeId, sheetKey, summaryLevel, basisMode, basisId });
    await download(`/io/export/structure/${versionId}?${query}`, `${year}-${report?.scopeBasis.sheetName ?? '预算'}-结构占比.xlsx`);
  };

  const resetFilters = () => {
    const next = new URLSearchParams();
    if (year) next.set('year', String(year));
    if (versionId) next.set('version', String(versionId));
    setParams(next, { replace: true });
    setAccountSearch('');
  };

  return (
    /* 无壳:外层 .newfc-content 已是唯一的岛,这里再画一个框就成了「框套框」 */
    <Card
      className="newfc-root-card"
      extra={<Button icon={<i className="ri-download-2-line" aria-hidden />} onClick={() => void exportStructure()} disabled={!report}>导出</Button>}
    >
      {/* 眉题:每页仅首个内容区块带,避免满屏编号 */}
      <div className="newfc-eyebrow">结构占比</div>
      {(versionsQuery.error ?? versionMetadataQuery.error ?? metricsQuery.error ?? batchesQuery.error) && (
        /* 初始化数据失败要显式提示:空下拉/「请选择版本」会把失败伪装成未选择 */
        <Alert
          type="error" showIcon style={{ marginBottom: 12 }}
          message="结构分析的初始化数据加载失败"
          description={errorText(versionsQuery.error ?? versionMetadataQuery.error ?? metricsQuery.error ?? batchesQuery.error)}
          action={<Button size="small" onClick={() => { void versionsQuery.refetch(); void versionMetadataQuery.refetch(); void metricsQuery.refetch(); void batchesQuery.refetch(); }}>重试</Button>}
        />
      )}
      <Space wrap style={{ marginBottom: 8 }}>
        <Select
          aria-label="年度" placeholder="年度" style={{ width: 110 }} value={year}
          onChange={(value) => setFilter('year', value, ['version', 'batch'])}
          options={years.map((item) => ({ value: item, label: `${item} 年` }))}
        />
        <Select
          aria-label="预算版本" placeholder="预算版本" style={{ width: 230 }} value={versionId}
          onChange={(value) => setFilter('version', value, ['org', 'account', 'basisId'])}
          options={budgetVersions.map((item) => ({ value: item.id, label: `${item.name}${item.is_current ? '（当前生效）' : ''}` }))}
        />
        <TreeSelect
          aria-label="预算组织" placeholder="预算组织（默认全部）" style={{ width: 230 }} value={orgScopeId ?? undefined}
          onChange={(value) => setFilter('org', value)}
          treeData={orgTreeData} showSearch treeNodeFilterProp="title" treeDefaultExpandAll allowClear
        />
        <Select
          aria-label="预算表格" placeholder="预算表格" style={{ width: 180 }} value={sheetKey} loading={sheetsLoading}
          onChange={(value) => setFilter('sheet', value)}
          options={[...SPECIAL_SHEETS, ...dbSheets].map((item) => ({ value: item.key, label: item.name }))}
        />
      </Space>

      <div style={{ marginBottom: 8 }}>
        <Space wrap>
          <Typography.Text strong>占比基准</Typography.Text>
          <Select
            aria-label="占比基准" style={{ width: 180 }} value={basisMode}
            onChange={(value) => setFilter('basisMode', value, ['basisId'])}
            options={[
              { value: 'parent', label: '占直接上级科目' },
              { value: 'account', label: '占指定科目' },
              { value: 'metric', label: '占指定金额指标' },
            ]}
          />
          {basisMode === 'account' && (
            <Select
              aria-label="基准科目" placeholder="选择基准科目（如营业收入）" style={{ width: 300 }}
              value={basisId ?? undefined} onChange={(value) => setFilter('basisId', value)}
              showSearch optionFilterProp="label" options={basisAccountOptions}
            />
          )}
          {basisMode === 'metric' && (
            <Select
              aria-label="基准指标" placeholder="选择基准指标（如营业总收入）" style={{ width: 300 }}
              value={basisId ?? undefined} onChange={(value) => setFilter('basisId', value)}
              showSearch optionFilterProp="label" options={basisMetricOptions}
            />
          )}
        </Space>
      </div>

      <Collapse
        ghost
        items={[{
          key: 'adv',
          label: '高级筛选',
          children: (
            <Space wrap>
              <Select
                aria-label="科目范围" placeholder="科目范围（默认全部）" style={{ width: 260 }} value={accountScopeId ?? undefined}
                onChange={(value) => setFilter('account', value)} allowClear showSearch optionFilterProp="label"
                options={(versionMetadataQuery.data?.accountNodes ?? []).map((item) => ({ value: item.id, label: `${item.code} ${item.name}` }))}
              />
              <Select
                aria-label="汇总层级" placeholder="汇总层级（默认全部）" style={{ width: 160 }} value={summaryLevel ?? undefined}
                onChange={(value) => setFilter('level', value)} allowClear
                options={[1, 2, 3, 4, 5].map((item) => ({ value: item, label: `展示到 ${item} 级` }))}
              />
              <Select
                aria-label="实际快照" placeholder="实际快照（默认当前）" style={{ width: 240 }} value={batchId ?? undefined}
                onChange={(value) => setFilter('batch', value)} allowClear
                options={(batchesQuery.data ?? []).filter((item) => item.status === 'active').map((item) => ({
                  value: item.id, label: `${item.snapshot_date} 修订${item.revision}`,
                }))}
              />
              <Button onClick={resetFilters}>重置筛选</Button>
            </Space>
          ),
        }]}
      />

      {reportQuery.error ? (
        <Result
          status="error"
          title="结构占比加载失败"
          subTitle={reportQuery.error instanceof Error ? reportQuery.error.message : String(reportQuery.error)}
          extra={<Button onClick={() => void reportQuery.refetch()}>重试</Button>}
        />
      ) : basisMode !== 'parent' && !basisId ? (
        <Empty description={`请先选择基准${basisMode === 'account' ? '科目' : '指标'}`} />
      ) : reportQuery.isLoading ? (
        <Card loading />
      ) : !report ? (
        /* 版本列表失败时上面已有错误提示,这里不再显示「请选择」伪装成待输入状态 */
        versionsQuery.error ? null : <Empty description="请选择年度与预算版本" />
      ) : (
        <>
          <Descriptions size="small" bordered column={screens.lg ? 4 : screens.sm ? 2 : 1} style={{ marginBottom: 12 }}>
            <Descriptions.Item label="年度">{report.version.year}</Descriptions.Item>
            <Descriptions.Item label="预算版本">{report.version.name}</Descriptions.Item>
            <Descriptions.Item label="预算表格">{report.scopeBasis.sheetName}</Descriptions.Item>
            <Descriptions.Item label="占比基准">{report.basis.label}</Descriptions.Item>
            <Descriptions.Item label="实际数截至">{report.asOfDate ?? '无实际数据'}</Descriptions.Item>
            <Descriptions.Item label="实际数来源">{report.actualSource}</Descriptions.Item>
            <Descriptions.Item label="汇总层级">{report.scopeBasis.summaryLevel ?? '全部'}</Descriptions.Item>
            <Descriptions.Item label="组织范围">{report.scopeBasis.orgScopeId ?? '全部'}</Descriptions.Item>
          </Descriptions>

          {(shareShift || Object.keys(composition.option).length > 0) && (
            <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
              {Object.keys(composition.option).length > 0 && <Col xs={24} lg={12}>
                <Card
                  size="small"
                  title="科目构成"
                  extra={<Typography.Text type="secondary" style={{ fontSize: 12, whiteSpace: 'nowrap' }}>面积＝预算，颜色深浅＝占比变化幅度</Typography.Text>}
                >
                  {/* 左环图右排行,仅 ≥1200px(xl) 并排:中屏 180px 侧栏会把排行行名称压至 0 宽,
                      低于 xl 一律上下堆叠;排行行与环图同源同色 */}
                  <Row gutter={[12, 4]} align="middle">
                    <Col xs={24} xl={composition.rank.length > 0 ? 13 : 24}>
                      <EChart option={composition.option} height={340} onSemanticClick={handleCompositionClick} />
                    </Col>
                    {composition.rank.length > 0 && (
                      <Col xs={24} xl={11}>
                        <div className="newfc-metric-label" style={{ marginBottom: 4 }}>构成额 · 前 {composition.rank.length}</div>
                        {composition.rank.map((row) => (
                          <RankBarRow key={row.key} color={row.color} label={row.label} value={row.value} share={row.share} shareLabel={row.shareLabel} />
                        ))}
                      </Col>
                    )}
                  </Row>
                </Card>
              </Col>}
              {shareShift && <Col xs={24} lg={12}>
                <Card
                  size="small"
                  title="结构占比变化"
                  extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>
                    {shareShift.total > shareShift.rows.length ? `前 ${shareShift.rows.length} / 共 ${shareShift.total} 项` : `共 ${shareShift.total} 项`}
                  </Typography.Text>}
                >
                  <EChart option={shareShiftOption} height={340} onSemanticClick={handleShareShiftClick} />
                </Card>
              </Col>}
            </Row>
          )}

          {/* 核验条:守恒、勾稽、承接、无实际数据的结论一行收住。
              此前「子项守恒」+「逐分勾稽」是两个独立色块,共约 8 行。 */}
          <VerifyBar items={verifyItems} style={{ marginBottom: 12 }} />

          {report.unbudgetedActual.count > 0 && (
            <Card size="small" title={<Space><i className="ri-error-warning-line" style={{ color: statusColor(mode).warn }} aria-hidden />未预算实际承接区<Tag color="orange">{report.unbudgetedActual.count} 条</Tag></Space>} style={{ marginBottom: 12 }}>
              <Table<UnbudgetedActualEntry>
                tableKey="structure-unbudgeted-actual"
                size="small"
                rowKey={(row) => `${row.orgId}:${row.accountId}`}
                dataSource={report.unbudgetedActual.entries}
                pagination={{ pageSize: 10, hideOnSinglePage: true }}
                columns={[
                  { title: '实际组织', width: 190, render: (_value, row) => `${row.orgCode} ${row.orgName}` },
                  { title: '实际科目', width: 210, render: (_value, row) => `${row.accountCode} ${row.accountName}` },
                  { title: '原因', dataIndex: 'reason', width: 220, render: (value) => <Tag color="orange">{String(value)}</Tag> },
                  { title: '金额（万元）', align: 'right', width: 140, render: (_value, row) => row.accountType === 'quantity' ? '-' : <MoneyText cents={row.accountType === 'income' ? row.amountCents : -row.amountCents} hideUnit /> },
                  { title: '数量', align: 'right', width: 120, render: (_value, row) => row.quantity == null ? '-' : formatQuantity(row.quantity) },
                ]}
                scroll={{ x: 880 }}
              />
            </Card>
          )}

          {report.reconciliation.length > 0 && (
            <Card size="small" title="同上级子项守恒核对" style={{ marginBottom: 12 }}>
              <Row gutter={[12, 12]}>
                <Col xs={24} sm={8}>
                  <Statistic
                    /* 标题写明分母口径:34/34 曾被读成「只有 34 个科目」——
                       分母是范围内含 ≥2 个子项的父节点数,不是全部科目数 */
                    title={`父级分组金额守恒（范围内 ${report.reconciliation.length} 个父级分组）`}
                    value={`${report.reconciliation.filter((i) => i.amountReconciled).length} / ${report.reconciliation.length} 通过`}
                    valueStyle={{ color: brokenReconciliation.length === 0 ? statusColor(mode).good : statusColor(mode).bad }}
                  />
                </Col>
                <Col xs={24} sm={16}>
                  {/* 101 字断言说明收进 Tooltip:它是「为什么能守恒」的论证,
                      不是读表必须的信息,Statistic 的比值已经给出结论。 */}
                  <Space size={6} style={{ alignItems: 'flex-start' }}>
                    <span className="newfc-quote">
                      子项之和必然逐分等于上级,此处算出来当断言
                    </span>
                    <Tooltip title="汇总沿科目祖先链累计，因此同一上级下各子项金额之和必然逐分等于上级；这里把它算出来当断言。各子项「占上级」比重之和理论为 100%，实际可能相差百万分之几，那是每行独立四舍五入的正常结果，不是错账。">
                      <i className="ri-information-line" style={{ color: 'var(--newfc-text-tertiary)', fontSize: 13, cursor: 'pointer', marginTop: 5 }} aria-hidden />
                    </Tooltip>
                  </Space>
                </Col>
              </Row>
            </Card>
          )}

          <Card
            size="small"
            title="结构占比 · 全部科目"
            extra={(
              <Input.Search
                allowClear placeholder="搜索科目编码/名称" value={accountSearch}
                onChange={(event) => setAccountSearch(event.target.value)}
                style={{ width: screens.sm ? 240 : 170 }}
              />
            )}
            style={{ marginBottom: 12 }}
          >
            {/* 口径自解释(方案七):列明范围内科目总数与默认折叠行为,
                与分页「共 N 个顶层节点」并列,避免「只有 12 个」的同类误读;
                表格自述注记不是结论句,用普通二级文本,不套 newfc-quote 竖线 */}
            <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: '0 0 8px' }}>
              范围内共 {report.rows.length} 个金额科目（含叶子与父级分组，{report.scopeBasis.sheetName}），默认折叠至顶层，展开查看子级。
            </Typography.Paragraph>
            <Table
              tableKey="structure-share"
              size="small"
              rowKey="accountId"
              dataSource={treeRows}
              columns={columns}
              expandable={accountSearch.trim() ? { expandedRowKeys: controlledExpandedKeys, onExpandedRowsChange: setControlledExpandedKeys } : { defaultExpandAllRows: false }}
              pagination={{ pageSize: 30, showSizeChanger: true, pageSizeOptions: [20, 30, 50, 100], showTotal: (total) => `共 ${total} 个顶层节点（范围内全部科目 ${report.rows.length} 个）` }}
              scroll={{ x: 1150 }}
              locale={{ emptyText: '当前预算表格和科目范围内没有金额科目' }}
            />
          </Card>

          {/* 后端 notes 与核验条同源:勾稽、未预算实际、无实际数据这三类已在上方
              VerifyBar 呈现,这里滤掉同义句,避免同一结论读两遍。notes 本身不改动。 */}
          <Space direction="vertical" size={2}>
            {report.notes
              .filter((note) => !note.includes('逐分勾稽') && !note.includes('未预算实际'))
              .map((note) => (
                <Typography.Text key={note} type="secondary" style={{ fontSize: 12 }}>· {note}</Typography.Text>
              ))}
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              · 树口径：{report.treeBasis.account}
            </Typography.Text>
          </Space>
          {basisMode === 'parent' && (
            <div style={{ marginTop: 12 }}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                <i className="ri-information-line" style={{ marginRight: 4, verticalAlign: -1 }} aria-hidden />
                提示：想做「各项占营业收入」的共同比报表，把占比基准切到「占指定科目」并选营业收入
              </Typography.Text>
            </div>
          )}
        </>
      )}
    </Card>
  );
}
