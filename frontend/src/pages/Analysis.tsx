import { useCallback, useEffect, useMemo, useRef, useState, type Key } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useSearchParams, useLocation, useNavigationType } from 'react-router-dom';
import {
  Alert,
  App,
  Button,
  Card,
  Col,
  Collapse,
  Descriptions,
  Empty,
  Grid,
  Input,
  InputNumber,
  Modal,
  Popconfirm,
  Popover,
  Result,
  Row,
  Select,
  Space,
  Statistic,
  Table,
  Tag,
  Tooltip,
  TreeSelect,
  Typography,
} from 'antd';
import type { TableColumnsType } from 'antd';
import { api, download } from '../api/client';
import { centsToWan, formatProgress, formatRate, formatRateOrReason, formatQuantity, formatRatio, formatRatioDelta, RATE_SPECIAL_TEXT } from '../utils/money';
import MoneyText from '../components/MoneyText';
import { CODE_WIDTH, codeColumn, treeIndentReserve } from '../utils/tableColumns';
import { escapeHtml } from '../utils/escapeHtml';
import { SPECIAL_SHEETS, useSheets } from '../utils/sheets';
import EChart from '../components/EChart';
import { withAlpha, chartTheme, useThemeMode, statusColor, financeColor, NUMERIC_FONT_FAMILY } from '../theme';
import { EvidenceDrawer, type EvidenceTarget } from '../components/EvidenceDrawer';
import { CardSkeleton, TableSkeleton } from '../components/Skeletons';
import { RankBarRow } from '../components/RankBarRow';
import { VerifyBar, type VerifyItem } from '../components/VerifyBar';
import { useAssistantPageContext } from '../assistant/contextHooks';
import { useOptionalAssistantRegistry } from '../assistant/AssistantContextRegistry';
import type { ChartSemanticClick } from '../components/EChart';
import WorkspaceScopeBar from '../components/WorkspaceScopeBar';
import type { ScopeIssue } from '../utils/workspaceScope';
import { normalizeScopeSearch } from '../utils/workspaceScope';
import { useUserPrefs } from '../hooks/useUserPrefs';
import { MAX_SAVED_VIEWS, type SavedViewEntry } from '../utils/userPrefs';
import { resolveLocateStatus } from '../utils/analysisLocate';

type Pace = 'ahead' | 'lagging' | 'on_track' | 'na';

interface CompletionCell {
  budgetCents: number;
  actualCents: number;
  budgetQuantity: number;
  actualQuantity: number;
  varianceQuantity: number;
  varianceCents: number;
  rate: number | null;
  rateSpecial: string | null;
  favorable: string;
  progressDeviation: number | null;
  pace: Pace;
}

interface AccountRow {
  accountId: number;
  parentId: number | null;
  code: string;
  name: string;
  type: string;
  unit: string;
  level: number;
  isLeaf: boolean;
  unbudgeted: boolean;
  cell: CompletionCell;
  /** 后端统一预警分类(§9.5):页面散点图、预警表与核验条共用,不再本地判定 */
  paceClass?: 'overspend' | 'lagging' | 'healthy' | null;
  children?: AccountRow[];
}

interface OrgRow {
  orgId: number;
  parentId: number | null;
  code: string;
  name: string;
  level: number;
  isLeaf: boolean;
  unbudgeted: boolean;
  cell: CompletionCell;
  children?: OrgRow[];
}

interface MetricRow { metricId: number; code: string; name: string; displaySign: 1 | -1; cell: CompletionCell }

interface RatioValue {
  scaled: number | null;
  special: null | 'na_zero_denominator';
  numeratorRaw: number;
  denominatorRaw: number;
  numeratorBasis: 'money' | 'quantity';
  denominatorBasis: 'money' | 'quantity';
}

interface RatioMetricRow {
  metricId: number;
  code: string;
  name: string;
  direction: 'higher_better' | 'lower_better';
  displayFormat: 'percent' | 'number';
  unit: string;
  budget: RatioValue;
  actual: RatioValue;
  deltaScaled: number | null;
  favorable: 'favorable' | 'unfavorable' | 'none';
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

interface CompletionReport {
  version: { id: number; year: number; name: string; kind: 'budget' | 'forecast' };
  asOfDate: string | null;
  timeProgressValue: number | null;
  actualSource: string;
  actualBatchId: number | null;
  treeBasis: { org: string; account: string };
  scopeBasis: { sheetKey: string; sheetName: string; orgScopeId: number | null; accountScopeId: number | null; summaryLevel: number | null };
  byAccount: AccountRow[];
  analysisAccounts: AccountRow[];
  byOrg: OrgRow[];
  metrics: MetricRow[];
  ratioMetrics: RatioMetricRow[];
  unbudgetedActual: { count: number; amountCents: number; entries: UnbudgetedActualEntry[] };
  reconciliation: { sourceActualCents: number; displayedActualCents: number; differenceCents: number };
  /** 核验事实(§9.5):核验条与助手共用,客户端不自行判定级别 */
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

interface TrendPoint {
  date: string;
  batchId: number;
  rate: number | null;
  timeProgress: number;
  progressDeviation: number | null;
  actualDisplayCents: number;
  unbudgetedActualCount: number;
  unbudgetedActualCents: number;
  reconciliation: { sourceActualCents: number; displayedActualCents: number; differenceCents: number };
}

interface TrendTarget {
  kind: 'metric' | 'account' | 'composite';
  id: number | null;
  code: string;
  name: string;
  type: string;
  unit: string;
}

interface CalculationRule {
  id: number;
  name: string;
  rule_type: 'quantity_price_net_tax' | 'multiply';
  sheet_code: string;
  config_json: string;
  status: string;
}

/** 超支预警表的页内锚点:核验条上的徽标点击后滚到这张表,而不是再叠一条 Alert。 */
const OVERSPEND_ANCHOR = 'overspend-alerts';

const positiveInt = (value: string | null): number | null => {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? parsed : null;
};

const buildQuery = (values: Record<string, string | number | null | undefined>) => {
  const query = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value != null && value !== '' && value !== 0) query.set(key, String(value));
  return query.toString();
};

function buildTreeRows<T extends { parentId: number | null; code: string; accountId?: number; orgId?: number }>(rows: T[]): T[] {
  const source = rows.map((row) => ({ ...row, children: [] as T[] }));
  const idOf = (row: T) => row.accountId ?? row.orgId;
  const byId = new Map(source.map((row) => [idOf(row), row]));
  const roots: typeof source = [];
  for (const row of source) {
    const parent = row.parentId == null ? undefined : byId.get(row.parentId);
    if (parent) parent.children.push(row);
    else roots.push(row);
  }
  const clean = (items: typeof source): T[] => items.map((item) => {
    item.children.sort((a, b) => a.code.localeCompare(b.code));
    if (item.children.length === 0) delete (item as { children?: T[] }).children;
    return item as T;
  });
  return clean(roots.sort((a, b) => a.code.localeCompare(b.code)));
}

function filterAccountTree(rows: AccountRow[], keyword: string): AccountRow[] {
  if (!keyword.trim()) return rows;
  const needle = keyword.trim().toLowerCase();
  const walk = (items: AccountRow[]): AccountRow[] => items.flatMap((row) => {
    const children = walk(row.children ?? []);
    if (`${row.code} ${row.name}`.toLowerCase().includes(needle) || children.length > 0) return [{ ...row, children: children.length ? children : undefined }];
    return [];
  });
  return walk(rows);
}

/** 金额单元格:成本费用以界面口径显示正数(翻转归调用方),表头已带「万元」故不重复单位 */
const displayValue = (row: AccountRow, field: 'budget' | 'actual' | 'variance') => {
  if (row.type === 'quantity') {
    const value = field === 'budget' ? row.cell.budgetQuantity : field === 'actual' ? row.cell.actualQuantity : row.cell.varianceQuantity;
    return formatQuantity(value, row.unit);
  }
  const value = field === 'budget' ? row.cell.budgetCents : field === 'actual' ? row.cell.actualCents : row.cell.varianceCents;
  const cents = field === 'variance' || row.type === 'income' ? value : -value;
  return <MoneyText cents={cents} hideUnit />;
};

/** 业务口径金额(万元):成本费用取反,与界面展示一致 */
const businessWan = (cents: number, type: string) => (type === 'income' ? cents : -cents) / 1_000_000;

const BRIDGE_TYPES: { type: string; label: string }[] = [
  { type: 'income', label: '收入' },
  { type: 'cost', label: '成本' },
  { type: 'expense', label: '费用' },
];

export default function Analysis() {
  const { message } = App.useApp();
  const { mode } = useThemeMode();
  const screens = Grid.useBreakpoint();
  /**
   * 窄屏(<md)让预警表格保持内容自然宽度并自行横向滚动：这两张表列窄、卡片只占半行，
   * 手机上不给横向滚动就会把整页撑宽(页面级横向滚动条)。宽屏保持默认铺满卡片。
   */
  const narrowScroll = screens.md === false ? { x: 'max-content' as const } : undefined;
  const [params, setParams] = useSearchParams();
  const [evidenceTarget, setEvidenceTarget] = useState<EvidenceTarget | null>(null);
  const [accountSearch, setAccountSearch] = useState('');
  const { sheets: dbSheets, loading: sheetsLoading } = useSheets();
  /** 显式 URL 参数被自动纠正时的可见说明(不静默换成另一个口径) */
  const [scopeIssues, setScopeIssues] = useState<ScopeIssue[]>([]);
  const latchScopeIssues = (issues: ScopeIssue[]) => {
    if (issues.length === 0) return;
    setScopeIssues((prev) => [...prev, ...issues.filter((issue) => !prev.some((p) => p.key === issue.key && p.raw === issue.raw))]);
  };

  const year = positiveInt(params.get('year')) ?? undefined;
  const versionId = positiveInt(params.get('version')) ?? undefined;
  const forecastId = positiveInt(params.get('forecast')) ?? undefined;
  const batchId = positiveInt(params.get('batch'));
  const orgScopeId = positiveInt(params.get('org'));
  const accountScopeId = positiveInt(params.get('account'));
  const sheetKey = params.get('sheet') || 'all';
  const summaryLevel = positiveInt(params.get('level'));
  const thresholdParam = params.get('threshold');
  // URL 里的 threshold 必须收敛为有限数：NaN/Infinity 会以「NaN」字符串进查询串与页面上下文，
  // 后端一律 400；非法值回默认 20,0 是合法阈值不能丢。
  const thresholdParsed = thresholdParam == null || thresholdParam === '' ? 20 : Number(thresholdParam);
  const thresholdNumber = Number.isFinite(thresholdParsed) ? thresholdParsed : 20;
  const warningThreshold = Math.min(100, Math.max(0, thresholdNumber)) / 100;
  const trendSelection = params.get('trend') || '';

  const setFilter = (key: string, value: string | number | null | undefined, resets: string[] = []) => {
    const next = new URLSearchParams(params);
    if (value == null || value === '') next.delete(key); else next.set(key, String(value));
    resets.forEach((item) => next.delete(item));
    setParams(next, { replace: true });
  };

  /* 预警阈值:正在输入的值与已应用的查询条件分离(§5.1),失焦/回车才写入 URL */
  const [thresholdInput, setThresholdInput] = useState<number | null>(null);
  const commitThreshold = () => {
    if (thresholdInput == null) return;
    setFilter('threshold', thresholdInput === 20 ? null : thresholdInput);
    setThresholdInput(null);
  };

  /**
   * UX-25 命名分析视图:把当前 URL 白名单筛选存为命名入口(如「A 电站年度执行」),
   * 个人查询偏好,不落业务数据;应用视图只是导航回该组参数,目标失效(版本删除等)
   * 由下方 URL 契约纠偏逻辑给出可见说明并等待重选,不自动提交任何内容。
   */
  const { savedViewsFor, saveView, renameView, deleteView } = useUserPrefs();
  const savedViews = savedViewsFor('analysis');
  const [viewsOpen, setViewsOpen] = useState(false);
  const [viewModal, setViewModal] = useState<{ mode: 'save' } | { mode: 'rename'; id: string } | null>(null);
  const [viewName, setViewName] = useState('');
  const currentViewSearch = useMemo(() => normalizeScopeSearch('analysis', params.toString()), [params]);
  const openSaveViewModal = () => { setViewName(''); setViewModal({ mode: 'save' }); };
  const openRenameViewModal = (view: SavedViewEntry) => { setViewName(view.name); setViewModal({ mode: 'rename', id: view.id }); };
  const commitViewModal = () => {
    if (!viewModal) return;
    const name = viewName.trim();
    if (!name) { message.warning('请填写视图名称'); return; }
    if (viewModal.mode === 'save') {
      const entry = saveView({ name, pageKey: 'analysis', search: currentViewSearch });
      if (!entry) {
        message.warning(`最多保存 ${MAX_SAVED_VIEWS} 个常用视图,请先删除不再使用的`);
        return;
      }
      message.success(`已保存视图「${entry.name}」`);
    } else {
      renameView(viewModal.id, name);
      message.success('视图已改名');
    }
    setViewModal(null);
  };
  const applyView = (view: SavedViewEntry) => {
    setViewsOpen(false);
    setParams(new URLSearchParams(view.search));
  };

  const versionsQuery = useQuery({
    queryKey: ['versions'],
    queryFn: () => api.get<{ id: number; year: number; name: string; status: string; is_current: 0 | 1; kind: 'budget' | 'forecast' }[]>('/versions'),
  });
  const versions = versionsQuery.data ?? [];
  const years = useMemo(() => [...new Set(versions.filter((item) => item.kind === 'budget').map((item) => item.year))].sort((a, b) => b - a), [versions]);

  useEffect(() => {
    if (!versions.length) return;
    const selectedYear = year && years.includes(year) ? year : (versions.find((item) => item.kind === 'budget' && item.is_current)?.year ?? years[0]);
    const budgets = versions.filter((item) => item.kind === 'budget' && item.year === selectedYear);
    const selectedVersion = budgets.find((item) => item.id === versionId) ?? budgets.find((item) => item.is_current) ?? budgets.find((item) => item.status !== 'draft') ?? budgets[0];
    /* 显式 URL 参数被纠正时必须可见(§4.1:无效版本/年度不静默换成另一个口径) */
    const issues: ScopeIssue[] = [];
    if (year != null && !years.includes(year)) {
      issues.push({ key: 'year', field: 'year', raw: String(year), reason: 'not_found', detail: `链接中的 ${year} 年没有预算版本,已改为 ${selectedYear} 年` });
    }
    if (versionId != null && !budgets.some((item) => item.id === versionId)) {
      const anywhere = versions.find((item) => item.id === versionId);
      issues.push({
        key: 'version', field: 'budgetVersionId', raw: String(versionId), reason: anywhere ? 'scope_mismatch' : 'not_found',
        detail: anywhere
          ? `链接中的预算版本 ${versionId} 属于 ${anywhere.year} 年,与所选 ${selectedYear} 年不一致,已改用「${selectedVersion?.name ?? '默认版本'}」`
          : `链接中的预算版本 ${versionId} 不存在或已删除,已改用「${selectedVersion?.name ?? '默认版本'}」`,
      });
    }
    if (issues.length > 0) latchScopeIssues(issues);
    const next = new URLSearchParams(params);
    let changed = false;
    if (selectedYear && String(selectedYear) !== params.get('year')) { next.set('year', String(selectedYear)); changed = true; }
    if (selectedVersion && String(selectedVersion.id) !== params.get('version')) { next.set('version', String(selectedVersion.id)); changed = true; }
    if (changed) setParams(next, { replace: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params, setParams, versionId, versions, year, years]);

  const current = versions.find((item) => item.id === versionId);
  const budgetVersions = versions.filter((item) => item.kind === 'budget' && item.year === year);
  const forecastVersions = versions.filter((item) => item.kind === 'forecast' && item.year === year);

  useEffect(() => {
    if (!year || params.has('forecast') || forecastVersions.length === 0) return;
    const selected = forecastVersions.find((item) => item.is_current) ?? forecastVersions.find((item) => item.status !== 'draft') ?? forecastVersions[0];
    const next = new URLSearchParams(params);
    next.set('forecast', String(selected.id));
    setParams(next, { replace: true });
  }, [forecastVersions, params, setParams, year]);

  const batchesQuery = useQuery({
    queryKey: ['batches-for-analysis', year],
    enabled: Boolean(year),
    queryFn: () => api.get<{ id: number; snapshot_date: string; revision: number; status: string; year: number }[]>(`/actual/batches?year=${year}`),
  });
  const accountTreeQuery = useQuery({
    queryKey: ['tree', 'account'],
    queryFn: () => api.get<{ rows: { id: number; parent_id: number | null; code: string; name: string }[] }>('/account/tree'),
  });
  const orgTreeQuery = useQuery({
    queryKey: ['tree', 'org'],
    queryFn: () => api.get<{ tree: { id: number; code: string; name: string; children: unknown[] }[] }>('/org/tree'),
  });
  const rulesQuery = useQuery({
    queryKey: ['calculation-rules'],
    queryFn: () => api.get<{ items: CalculationRule[] }>('/calculation-rules'),
  });

  const reportParams = {
    batchId,
    orgScopeId,
    accountScopeId,
    sheetKey,
    summaryLevel,
    /** 节奏预警阈值同步给后端:核验结论(verificationFacts)与页面散点图共用同一阈值。 */
    warningThreshold: thresholdNumber,
  };
  const buildReportQueryString = (queryVersionId: number | undefined) => {
    const base = buildQuery({ ...reportParams, versionId: queryVersionId, warningThreshold: undefined });
    // threshold=0 是合法阈值,buildQuery 会把 0 丢掉;显式带上,与后端默认 20 的语义分开。
    const threshold = reportParams.warningThreshold === 20 ? '' : `warningThreshold=${reportParams.warningThreshold}`;
    return [base, threshold].filter(Boolean).join('&');
  };
  const reportQueryString = buildReportQueryString(versionId);
  const reportQuery = useQuery({
    queryKey: ['completion-analysis', reportQueryString],
    enabled: Boolean(versionId),
    queryFn: () => api.get<CompletionReport>(`/report/completion?${reportQueryString}`),
  });
  const forecastQueryString = buildReportQueryString(forecastId);
  const forecastQuery = useQuery({
    queryKey: ['forecast-analysis', forecastQueryString],
    enabled: Boolean(forecastId),
    queryFn: () => api.get<CompletionReport>(`/report/completion?${forecastQueryString}`),
  });
  const report = reportQuery.data;
  const forecastReport = forecastQuery.data;
  /** 尚无实际批次:实际/差异/完成率等列显示「—」,不能把无数据渲染成 0.00(与已保存零值区分) */
  const noActual = report?.actualSource === 'none';
  const noActualCell = (
    <Typography.Text type="secondary" title="该年度尚无实际批次，并非已填报零值">—</Typography.Text>
  );

  /**
   * 小澧助手页面登记(§7.3)：sheet、level、threshold、trend 都会改变查询或核验，属于有效上下文；
   * accountSearch 默认只属于 view——用户说「当前筛出的科目」时由后端用同一筛选重建 selection。
   * 异步默认值(年度/版本)写入 URL 之前不宣称已对齐。
   */
  useAssistantPageContext({
    pageKey: 'analysis',
    ready: Boolean(year && versionId) && !versionsQuery.isLoading && !sheetsLoading,
    readyState: versionsQuery.isError || reportQuery.isError ? 'error' : 'loading',
    notReadyReason: versionsQuery.isError
      ? '预算版本列表读取失败'
      : reportQuery.isError ? '执行分析报表读取失败' : '正在读取执行分析的默认年度与版本',
    scope: {
      year,
      budgetVersionId: versionId ?? undefined,
      targetVersionId: forecastId ?? undefined,
      actualSnapshotId: batchId ?? undefined,
      orgScopeId: orgScopeId ?? undefined,
      accountScopeId: accountScopeId ?? undefined,
    },
    view: {
      sheetKey,
      ...(summaryLevel != null ? { summaryLevel } : {}),
      threshold: thresholdNumber,
      ...(trendSelection ? { trend: trendSelection } : {}),
      ...(accountSearch.trim() ? { accountSearch: accountSearch.trim() } : {}),
    },
  });

  /* 节奏象限点击 → chart_point 焦点(§8.4):系列内 dataIndex 与 paceSeriesRows 一一对应。 */
  const assistantRegistry = useOptionalAssistantRegistry();
  const paceFocusTokenRef = useRef<symbol | null>(null);
  const handlePaceClick = useCallback((point: ChartSemanticClick) => {
    const registry = assistantRegistry;
    if (!registry || !report) return;
    const row = report.analysisAccounts.find((item) => `${item.code} ${item.name}` === point.name);
    if (!row) return;
    if (paceFocusTokenRef.current) registry.clearFocus(paceFocusTokenRef.current);
    paceFocusTokenRef.current = registry.setFocus(
      { kind: 'chart_point', seriesKey: 'pace', dimensionType: 'account', dimensionId: row.accountId },
      `节奏象限 · ${row.code} ${row.name}`,
    );
  }, [assistantRegistry, report]);
  useEffect(() => () => {
    if (paceFocusTokenRef.current) assistantRegistry?.clearFocus(paceFocusTokenRef.current);
  }, [assistantRegistry]);

  const trendOptions = useMemo(() => {
    if (!report) return [] as { label: string; options: { value: string; label: string }[] }[];
    const metricOrder = ['P07', 'P06', 'P04', 'P05', 'P01', 'P02', 'P03'];
    const accountOrder = ['C1101', 'E201', 'I1101', 'Q101'];
    const metrics = metricOrder.flatMap((code) => {
      const row = report.metrics.find((item) => item.code === code);
      return row && row.cell.budgetCents !== 0 ? [{ value: `metric:${row.metricId}`, label: `${row.code} ${row.name}` }] : [];
    });
    const accounts = accountOrder.flatMap((code) => {
      const row = report.analysisAccounts.find((item) => item.code === code);
      const hasBudget = row && (row.type === 'quantity' ? row.cell.budgetQuantity !== 0 : row.cell.budgetCents !== 0);
      return row && hasBudget ? [{ value: `account:${row.accountId}`, label: `${row.code} ${row.name}${row.code === 'E201' ? '（含资本化人工）' : ''}` }] : [];
    });
    return [
      { label: '核心经营指标', options: metrics },
      { label: '专项指标', options: accounts },
      { label: '综合口径', options: [{ value: 'composite', label: '所选范围综合完成率' }] },
    ].filter((group) => group.options.length > 0);
  }, [report]);
  const validTrendSelections = useMemo(() => new Set(trendOptions.flatMap((group) => group.options.map((option) => option.value))), [trendOptions]);
  useEffect(() => {
    if (!report || (trendSelection && validTrendSelections.has(trendSelection))) return;
    const netProfit = report.metrics.find((metric) => metric.code === 'P05' && metric.cell.budgetCents !== 0);
    const fallback = netProfit ? `metric:${netProfit.metricId}` : trendOptions[0]?.options[0]?.value ?? 'composite';
    const next = new URLSearchParams(params);
    next.set('trend', fallback);
    setParams(next, { replace: true });
  }, [params, report, setParams, trendOptions, trendSelection, validTrendSelections]);
  const [trendKindRaw, trendIdRaw] = trendSelection.split(':');
  const trendKind = trendSelection === 'composite' ? 'composite' : trendKindRaw === 'metric' || trendKindRaw === 'account' ? trendKindRaw : null;
  const trendId = positiveInt(trendIdRaw ?? null);
  const trendQueryString = buildQuery({ year, versionId, batchId, orgScopeId, accountScopeId, sheetKey, trendKind, trendId });
  const trendQuery = useQuery({
    queryKey: ['trend-analysis', trendQueryString],
    enabled: Boolean(year && versionId && trendKind && (trendKind === 'composite' || trendId)),
    queryFn: () => api.get<{ points: TrendPoint[]; budgetDisplayCents: number; target: TrendTarget }>(`/report/trend?${trendQueryString}`),
  });

  const trend = trendQuery.data;
  const forecastAccounts = useMemo(() => new Map(forecastReport?.byAccount.map((row) => [row.code, row]) ?? []), [forecastReport]);
  const forecastOrgs = useMemo(() => new Map(forecastReport?.byOrg.map((row) => [row.code, row]) ?? []), [forecastReport]);
  const forecastMetrics = useMemo(() => new Map(forecastReport?.metrics.map((row) => [row.code, row]) ?? []), [forecastReport]);

  const orgTreeData = useMemo(() => {
    interface Node { id: number; code: string; name: string; children: Node[] }
    interface TreeItem { value: number; title: string; children: TreeItem[] }
    const build = (nodes: Node[]): TreeItem[] => nodes.map((node) => ({ value: node.id, title: `${node.code} ${node.name}`, children: build(node.children) }));
    return build((orgTreeQuery.data?.tree ?? []) as Node[]);
  }, [orgTreeQuery.data]);

  /** 范围条按名称显示组织(UX-04):组织树 id → 名称 */
  const orgNameById = useMemo(() => {
    const map = new Map<number, string>();
    interface Node { id: number; name: string; children?: Node[] }
    const walk = (nodes: Node[]) => nodes.forEach((node) => { map.set(node.id, node.name); walk(node.children ?? []); });
    walk((orgTreeQuery.data?.tree ?? []) as Node[]);
    return map;
  }, [orgTreeQuery.data]);

  /* ── 跨页定位(UX-03):URL 的 org/account 既是筛选范围,也是预警/证据下钻的定位目标。
     目标被预算表格折叠或汇总层级收起时自动展开一层再定位;目标不存在于版本绑定
     快照或主数据中时给出具体原因,不做错误高亮、不静默。
     每个历史条目(location.key)+ 对象组合只处理一次:replace 筛选不重复打扰。 */
  const location = useLocation();
  const navType = useNavigationType();
  const [locateNotices, setLocateNotices] = useState<{ type: 'info' | 'warning'; text: string }[]>([]);
  const accountMasterIds = useMemo(() => new Set((accountTreeQuery.data?.rows ?? []).map((row) => row.id)), [accountTreeQuery.data]);
  const locateGuardsRef = useRef<{ account: string; org: string; expanded: string; scrolled: string }>({ account: '', org: '', expanded: '', scrolled: '' });
  useEffect(() => {
    if (!report) return;
    if (accountScopeId == null && orgScopeId == null) return;
    const guards = locateGuardsRef.current;
    const pushNotice = (notice: { type: 'info' | 'warning'; text: string }) => {
      setLocateNotices((prev) => (prev.some((item) => item.text === notice.text) ? prev : [...prev, notice]));
    };

    if (accountScopeId != null) {
      const sig = `${location.key}:a${accountScopeId}`;
      const hit = (accountTreeQuery.data?.rows ?? []).find((row) => row.id === accountScopeId);
      const label = hit ? `${hit.code} ${hit.name}` : `#${accountScopeId}`;
      const status = resolveLocateStatus(accountScopeId, {
        displayIds: new Set(report.byAccount.map((row) => row.accountId)),
        scopeIds: new Set(report.analysisAccounts.map((row) => row.accountId)),
        masterIds: accountMasterIds,
      });
      if (status === 'hidden_by_display' && sheetKey !== 'all') {
        if (guards.expanded !== sig) {
          guards.expanded = sig;
          pushNotice({ type: 'info', text: `目标科目 ${label} 不在「${report.scopeBasis.sheetName}」的展示范围内,已切换为全部科目定位` });
          setFilter('sheet', 'all');
        }
      } else if (status !== 'visible' && guards.account !== sig) {
        guards.account = sig;
        pushNotice({ type: 'warning', text: status === 'hidden_by_display'
          ? `目标科目 ${label} 不在当前预算表格的展示范围内,无法定位`
          : status === 'not_in_snapshot'
            ? `科目 ${label} 在当前科目树中存在,但不在版本「${report.version.name}」绑定的科目树快照中(定稿后的树结构调整不影响历史口径),无法在同口径下定位`
            : `链接中的科目 ${label} 不存在或已删除,无法定位` });
      }
    }

    if (orgScopeId != null) {
      const sig = `${location.key}:o${orgScopeId}`;
      const inDisplay = report.byOrg.some((row) => row.orgId === orgScopeId);
      if (!inDisplay && summaryLevel != null && orgNameById.has(orgScopeId)) {
        if (guards.expanded !== sig) {
          guards.expanded = sig;
          pushNotice({ type: 'info', text: '目标组织超出当前汇总层级的显示范围,已切换为全部层级定位' });
          setFilter('level', null);
        }
      } else if (!inDisplay && guards.org !== sig) {
        guards.org = sig;
        const name = orgNameById.get(orgScopeId);
        pushNotice({ type: 'warning', text: name != null
          ? `组织 ${name} 在当前组织树中存在,但不在版本「${report.version.name}」绑定的组织树快照中,无法在同口径下定位`
          : `链接中的组织 #${orgScopeId} 不存在或已删除,无法定位` });
      }
    }

    const scrollSig = `${location.key}:${accountScopeId ?? ''}:${orgScopeId ?? ''}`;
    if (guards.scrolled !== scrollSig) {
      const el = document.getElementById(accountScopeId != null ? 'analysis-locate-account' : 'analysis-locate-org');
      if (el) {
        guards.scrolled = scrollSig;
        /* POP 返回时不重复定位滚动:位置恢复由路由记忆负责(返回后保持离开时的位置) */
        if (navType !== 'POP') el.scrollIntoView({ behavior: 'smooth', block: 'center' });
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [report, accountScopeId, orgScopeId, sheetKey, summaryLevel, accountMasterIds, orgNameById, location.key, navType]);

  /**
   * 利润桥:预算利润 → 收入/成本/费用差异 → 实际利润。
   * 三项差异取叶子科目在利润方向口径下的合计,该口径下收入+成本+费用恰好等于利润,
   * 因此 Σ差异 严格等于利润差异,能逐分平账(未预算承接区预算为 0,自然纳入)。
   */
  const bridge = useMemo(() => {
    if (!report) return null;
    const deltas = BRIDGE_TYPES.map(({ type, label }) => {
      const cents = report.analysisAccounts
        .filter((row) => row.isLeaf && row.type === type)
        .reduce((sum, row) => sum + row.cell.varianceCents, 0);
      return { type, label, cents, wan: cents / 1_000_000 };
    });
    const budgetProfit = report.analysisAccounts
      .filter((row) => row.isLeaf && BRIDGE_TYPES.some((b) => b.type === row.type))
      .reduce((sum, row) => sum + row.cell.budgetCents, 0);
    const actualProfit = budgetProfit + deltas.reduce((sum, d) => sum + d.cents, 0);
    return { budgetProfit, actualProfit, deltas };
  }, [report]);

  const bridgeOption = useMemo(() => {
    if (!bridge) return {};
    const t = chartTheme(mode);
    /* 瀑布图的有利/不利是状态语义,必须取 STATUS_COLOR 而不是 chartTheme 的系列色:
       系列色为区分类型而避开了红绿,这里却需要红绿来直读「这一步是增利还是减利」。 */
    const status = statusColor(mode);
    const steps = bridge.deltas.filter((d) => d.cents !== 0);
    const categories = ['预算利润', ...steps.map((d) => `${d.label}差异`), '实际利润'];
    /**
     * 逐柱构造:起止柱为整段实体,中间差异柱为「透明占位 + 实体增量」堆叠,
     * 两类柱都从 0 起画,避免绘图库不支持内置瀑布类型。
     */
    /**
     * 降音量(3.6②):柱体由全饱和改为 78% 填充 + 1px 本色描边。
     * 与同文件散点气泡(withAlpha(color, 0.78) + 本色描边)是同一手法,属推广非新造 ——
     * 满饱和的宽柱并排会把整块图表涂成色块阵列,压过折线与留白构成的秩序。
     */
    const barStyle = (color: string) => ({
      color: withAlpha(color, 0.78),
      borderColor: color,
      borderWidth: 1,
      borderRadius: [3, 3, 0, 0],
    });
    const placeholder: (number | null)[] = [];
    const bars: { value: number; itemStyle: { color: string; borderColor: string; borderWidth: number; borderRadius: number[] } }[] = [];
    let running = bridge.budgetProfit / 1_000_000;

    const push = (base: number, delta: number, color: string) => {
      const floor = Math.min(base, base + delta);
      placeholder.push(Number.isFinite(floor) ? floor : null);
      bars.push({ value: Math.abs(delta), itemStyle: barStyle(color) });
    };

    // 起始柱:预算利润整段
    placeholder.push(0);
    bars.push({ value: running, itemStyle: barStyle(t.colors[0]) });
    // 中间:三类的有利/不利配色(利润方向为正即有利)
    for (const step of steps) {
      push(running, step.wan, step.wan >= 0 ? status.good : status.bad);
      running += step.wan;
    }
    // 终止柱:实际利润整段
    push(0, bridge.actualProfit / 1_000_000, t.colors[0]);

    const tip = (index: number) => {
      if (index === 0) return `预算利润 ${centsToWan(bridge.budgetProfit)} 万元`;
      if (index === categories.length - 1) return `实际利润 ${centsToWan(bridge.actualProfit)} 万元`;
      const step = steps[index - 1];
      return `${step.label}差异 ${centsToWan(step.cents)} 万元<br/>（利润方向，正为有利）`;
    };

    return {
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        formatter: (params: { dataIndex: number }[]) => tip(params[0]?.dataIndex ?? 0),
      },
      legend: { show: false },
      grid: { top: 28, left: 58, right: 24, bottom: 34 },
      xAxis: { type: 'category', data: categories },
      // 数据已是万元(step.wan / budgetProfit / 1e6),用千分位格式化;
      // 不能用 wanAxisLabel,它会再除一次 1e6 导致刻度全变 0
      yAxis: { type: 'value', axisLabel: { formatter: (v: number) => v.toLocaleString('zh-CN', { maximumFractionDigits: 0 }) } },
      series: [
        { name: '累计占位', type: 'bar', stack: 'bridge', stackStrategy: 'all', itemStyle: { color: 'transparent' }, emphasis: { itemStyle: { color: 'transparent' } }, silent: true, data: placeholder },
        {
          name: '金额', type: 'bar', stack: 'bridge', stackStrategy: 'all', barMaxWidth: 38, barWidth: '40%',
          label: {
            show: true,
            position: 'top',
            fontSize: 12,
            color: t.subText,
            fontFamily: NUMERIC_FONT_FAMILY,
            formatter: (p: { dataIndex: number }) => {
              if (p.dataIndex === 0) return centsToWan(bridge.budgetProfit);
              if (p.dataIndex === categories.length - 1) return centsToWan(bridge.actualProfit);
              const step = steps[p.dataIndex - 1];
              return `${step.wan >= 0 ? '+' : '-'}${centsToWan(Math.abs(step.cents))}`;
            },
          },
          data: bars,
        },
      ],
    };
  }, [bridge, mode]);

  /**
   * 执行节奏象限:x=业务口径预算(万元),y=进度偏差(pp),点大小=|差异额|。
   * 右上角「体量大 + 严重滞后」的点即需优先处理项。
   */
  const paceOption = useMemo(() => {
    if (!report) return {};
    const t = chartTheme(mode);
    const points = report.analysisAccounts
      .filter((row) => row.isLeaf && row.type !== 'quantity' && row.cell.rate != null && row.cell.budgetCents !== 0 && row.paceClass != null)
      .map((row) => ({ row, category: row.paceClass as 'overspend' | 'lagging' | 'healthy' }));
    if (points.length === 0) return {};

    const group = (category: string) => points.filter((p) => p.category === category);
    const sizes = points.map((p) => Math.abs(p.row.cell.varianceCents));
    const maxSize = Math.max(...sizes, 1);
    const scale = (cents: number) => 8 + (Math.sqrt(Math.abs(cents) / maxSize) * 26);
    const tp = report.timeProgressValue;

    /* 健康 / 偏离 / 超支是三档状态语义(绿 / 橙 / 红),取 STATUS_COLOR。
       若沿用 chartTheme 系列色,「超支」会变成青色,失去预警的直读性。 */
    const status = statusColor(mode);
    const series = [
      { key: 'healthy', name: '节奏健康', color: status.good },
      { key: 'lagging', name: '节奏偏离', color: status.warn },
      { key: 'overspend', name: '年度超支', color: status.bad },
    ].map(({ key, name, color }) => ({
      name,
      type: 'scatter',
      symbolSize: (data: unknown[]) => scale(Number(data[2])),
      itemStyle: { color: withAlpha(color, 0.78), borderColor: color, borderWidth: 1 },
      // x≈0 的气泡以轴线为圆心,默认 clip 会切掉半圆
      clip: false,
      data: group(key).map(({ row }) => ({
        value: [businessWan(row.cell.budgetCents, row.type), (row.cell.progressDeviation ?? 0) * 100, Math.abs(row.cell.varianceCents)],
        name: `${row.code} ${row.name}`,
      })),
    }));

    const thresholdPp = warningThreshold * 100;
    return {
      tooltip: {
        trigger: 'item',
        formatter: (p: { seriesName: string; name: string; value: number[] }) =>
          `${escapeHtml(p.name)}<br/>${escapeHtml(p.seriesName)}<br/>年度预算 ${p.value[0].toFixed(2)} 万元<br/>进度偏差 ${p.value[1] >= 0 ? '+' : ''}${p.value[1].toFixed(2)}pp<br/>预算差异 ${centsToWan(p.value[2])} 万元`,
      },
      legend: { data: series.map((s) => s.name), top: 4, icon: 'circle', itemWidth: 10, itemHeight: 10 },
      grid: { top: 34, left: 62, right: 26, bottom: 44 },
      xAxis: {
        type: 'value', name: '年度预算(万元)', nameLocation: 'middle', nameGap: 26,
        axisLabel: { formatter: (v: number) => v.toLocaleString('zh-CN', { maximumFractionDigits: 0 }) },
      },
      yAxis: {
        type: 'value', name: '进度偏差(pp)', nameLocation: 'middle', nameGap: 42,
        axisLabel: { formatter: (v: number) => `${v.toFixed(0)}pp` },
      },
      series: series.map((s, i) => i === 0 ? {
        ...s,
        markLine: {
          silent: true, symbol: 'none',
          lineStyle: { type: 'dashed', color: t.colors[1], width: 1 },
          label: { formatter: `预警 ±${thresholdPp.toFixed(0)}pp`, position: 'insideEndTop', fontSize: 12 },
          data: tp == null ? [] : [
            { yAxis: thresholdPp },
            { yAxis: -thresholdPp },
          ],
        },
      } : s),
    };
  }, [report, mode, warningThreshold]);

  const alertAnalysis = useMemo(() => {
    const empty = { overspend: [] as AccountRow[], lagging: [] as AccountRow[], healthy: 0, eligible: 0 };
    if (!report || report.timeProgressValue == null || report.actualSource === 'none') return empty;
    for (const item of report.analysisAccounts) {
      // 分类唯一来源是后端 paceClass(verification.ts classifyPace),页面不再重复判定。
      const category = item.paceClass ?? null;
      if (category == null) continue;
      empty.eligible += 1;
      if (category === 'overspend') empty.overspend.push(item);
      else if (category === 'lagging') empty.lagging.push(item);
      else empty.healthy += 1;
    }
    empty.overspend.sort((a, b) => Math.abs(b.cell.varianceCents) - Math.abs(a.cell.varianceCents));
    empty.lagging.sort((a, b) => Math.abs(b.cell.progressDeviation ?? 0) - Math.abs(a.cell.progressDeviation ?? 0));
    return empty;
  }, [report]);

  /**
   * 页面自检结论(§9.5)：直接渲染后端 verificationFacts，页面不再本地判定
   * reconciliation/overspend/lagging 的级别与差额——助手、导出与本页共用同一份结论。
   * 每项携带 assistantTarget，打开明细即成为助手的核验焦点。
   */
  const verifyItems = useMemo<VerifyItem[]>(() => {
    if (!report) return [];
    return report.verificationFacts.map((fact) => ({
      key: fact.factKey.replace(/_/g, '-'),
      level: fact.serverLevel,
      label: fact.label,
      details: fact.details.length ? fact.details : undefined,
      assistantTarget: {
        ownerKey: 'analysis:root',
        factKey: fact.factKey,
        scopeRef: {
          ...(fact.scope.versionId != null ? { versionId: fact.scope.versionId } : {}),
          ...(fact.scope.batchId != null ? { batchId: fact.scope.batchId } : {}),
          ...(fact.scope.orgScopeId != null ? { orgScopeId: fact.scope.orgScopeId } : {}),
          ...(fact.scope.accountScopeId != null ? { accountScopeId: fact.scope.accountScopeId } : {}),
          ...(fact.scope.sheetKey != null ? { sheetKey: fact.scope.sheetKey } : {}),
        },
      },
      ...(fact.actionTarget?.kind === 'anchor'
        ? {
          onClick: () => document.getElementById(fact.actionTarget!.anchor)?.scrollIntoView({ behavior: 'smooth', block: 'start' }),
          actionHint: fact.actionTarget.hint,
        }
        : {}),
    }));
  }, [report]);

  const attributions = useMemo(() => {
    if (!report) return [];
    const active = (rulesQuery.data?.items ?? []).filter((rule) => rule.status === 'active' && rule.rule_type === 'quantity_price_net_tax');
    return active.flatMap((rule) => {
      let config: { quantityAccountCode?: string; priceAccountCode?: string; taxAccountCode?: string; outputAccountCode?: string; defaultTaxRate?: string };
      try { config = JSON.parse(rule.config_json); } catch { return []; }
      const find = (code?: string) => report.analysisAccounts.find((row) => row.code === code);
      const quantity = find(config.quantityAccountCode);
      const price = find(config.priceAccountCode);
      const tax = find(config.taxAccountCode);
      const income = find(config.outputAccountCode);
      if (!quantity || !price || !income || quantity.cell.budgetQuantity === 0 || price.cell.budgetQuantity === 0) return [];
      const qb = quantity.cell.budgetQuantity / 10_000;
      const qa = quantity.cell.actualQuantity / 10_000;
      const pb = price.cell.budgetQuantity / 10_000;
      const pa = price.cell.actualQuantity / 10_000;
      const defaultTax = Number(config.defaultTaxRate) || 0;
      const tb = tax?.cell.budgetQuantity ? tax.cell.budgetQuantity / 10_000 : defaultTax;
      const ta = tax?.cell.actualQuantity ? tax.cell.actualQuantity / 10_000 : tb;
      const budgetNetPrice = pb / (1 + tb / 100);
      const actualNetPrice = (pa || pb) / (1 + ta / 100);
      const volumeImpact = (qa - qb) * budgetNetPrice;
      const priceTaxImpact = qa * (actualNetPrice - budgetNetPrice);
      const totalDifference = (income.cell.actualCents - income.cell.budgetCents) / 1_000_000;
      const residual = totalDifference - volumeImpact - priceTaxImpact;
      return [{ rule, config, qb, qa, pb, pa, tb, ta, volumeImpact, priceTaxImpact, totalDifference, residual }];
    });
  }, [report, rulesQuery.data]);

  const chartOption = useMemo(() => {
    if (!trend) return {};
    const status = statusColor(mode);
    const t = chartTheme(mode);
    const dates = trend.points.map((point) => point.date);
    const costTarget = trend.target.type === 'cost';
    const favorable = (deviation: number | null) => costTarget ? (deviation ?? 0) <= 0 : (deviation ?? 0) >= 0;
    const markArea = trend.points.slice(0, -1).map((point, index) => ([
      { xAxis: point.date, itemStyle: { color: withAlpha(favorable(point.progressDeviation) ? status.good : status.warn, 0.09) } },
      { xAxis: trend.points[index + 1].date },
    ]));
    const completionName = `${trend.target.name}完成率`;
    return {
      tooltip: { trigger: 'axis', valueFormatter: (value: number) => `${(value * 100).toFixed(2)}%` },
      legend: { data: [completionName, '时间进度', '进度偏差'], top: 4 },
      grid: { top: 36, left: 58, right: 58, bottom: 46 },
      xAxis: { type: 'category', data: dates },
      yAxis: [
        { type: 'value', axisLabel: { formatter: (value: number) => `${(value * 100).toFixed(0)}%` } },
        { type: 'value', axisLabel: { formatter: (value: number) => `${(value * 100).toFixed(0)}pp` }, splitLine: { show: false } },
      ],
      series: [
        { name: completionName, type: 'line', smooth: false, connectNulls: false, data: trend.points.map((point) => point.rate), lineStyle: { width: 3, color: t.colors[0] }, itemStyle: { color: t.colors[0] }, markArea: { silent: true, data: markArea } },
        { name: '时间进度', type: 'line', step: 'end', data: trend.points.map((point) => point.timeProgress), lineStyle: { type: 'dashed', color: t.colors[1] }, itemStyle: { color: t.colors[1] } },
        { name: '进度偏差', type: 'bar', yAxisIndex: 1, barMaxWidth: 38, data: trend.points.map((point) => {
          const c = favorable(point.progressDeviation) ? status.good : status.bad;
          return { value: point.progressDeviation, itemStyle: { color: withAlpha(c, 0.78), borderColor: c, borderWidth: 1, borderRadius: [3, 3, 0, 0] } };
        }) },
      ],
    };
  }, [trend, mode]);

  /* 趋势图点击 → chart_point(period) 焦点:x 轴类目即快照日期。 */
  const trendFocusTokenRef = useRef<symbol | null>(null);
  const handleTrendClick = useCallback((point: ChartSemanticClick) => {
    const registry = assistantRegistry;
    if (!registry || !trend || !point.name) return;
    if (!trend.points.some((item) => item.date === point.name)) return;
    if (trendFocusTokenRef.current) registry.clearFocus(trendFocusTokenRef.current);
    trendFocusTokenRef.current = registry.setFocus(
      { kind: 'chart_point', seriesKey: 'trend', dimensionType: 'period', period: point.name },
      `执行趋势 · ${trend.target.name} · ${point.name}`,
    );
  }, [assistantRegistry, trend]);
  useEffect(() => () => {
    if (trendFocusTokenRef.current) assistantRegistry?.clearFocus(trendFocusTokenRef.current);
  }, [assistantRegistry]);

  const accountRows = useMemo(() => filterAccountTree(buildTreeRows(report?.byAccount ?? []), accountSearch), [accountSearch, report?.byAccount]);
  const orgRows = useMemo(() => buildTreeRows(report?.byOrg ?? []), [report?.byOrg]);

  /**
   * 组织完成率排行速览带(方案《界面细节提升方案-排版工具与数据组件》二.2):
   * 一级组织按完成率取前 6,数值与下方完整组织表同源(byOrg 树)。
   * 单根集团树(parentId=null 仅集团总公司 1 行)时取根节点的直属下级成员单位;
   * 多根森林时取各根节点本身,保证速览带始终有可比对象。
   * 颜色与执行节奏象限同口径 —— 完成率−时间进度分三档状态色(绿=快于进度、
   * 橙=慢于进度、红=慢超 20pp),无进度基准时退回绝对完成率分档。
   */
  const orgRateRank = useMemo(() => {
    if (!report || noActual) return [];
    const status = statusColor(mode);
    const tp = report.timeProgressValue;
    const NEUTRAL = mode === 'dark' ? '#4e5969' : '#c9cdd4';
    const paceColor = (rate: number | null) => {
      if (rate == null) return NEUTRAL;
      if (tp == null) {
        if (rate < 0.5) return status.bad;
        if (rate < 0.8) return status.warn;
        return status.good;
      }
      const dev = rate - tp;
      if (dev < -0.2) return status.bad;
      if (dev < 0) return status.warn;
      return status.good;
    };
    const rootIds = new Set(report.byOrg.filter((row) => row.parentId === null).map((row) => row.orgId));
    return report.byOrg
      .filter((row) => (rootIds.has(row.parentId ?? -1) || (rootIds.size > 1 && row.parentId === null)) && row.cell.budgetCents !== 0)
      .sort((a, b) => (b.cell.rate ?? -Infinity) - (a.cell.rate ?? -Infinity))
      .slice(0, 6)
      .map((row) => ({
        key: row.orgId,
        color: paceColor(row.cell.rate),
        label: `${row.code} ${row.name}`,
        value: formatRateOrReason(row.cell.rate, row.cell.rateSpecial),
        share: row.cell.rate == null ? 0 : Math.min(Math.max(row.cell.rate, 0), 1),
        shareLabel: `预算 ${centsToWan(row.cell.budgetCents)}`,
      }));
  }, [report, mode, noActual]);
  const expandedSearchKeys = useMemo<Key[]>(() => {
    if (!accountSearch.trim()) return [];
    const keys: number[] = [];
    const walk = (rows: AccountRow[]) => rows.forEach((row) => { keys.push(row.accountId); walk(row.children ?? []); });
    walk(accountRows);
    return keys;
  }, [accountRows, accountSearch]);
  const [controlledExpandedKeys, setControlledExpandedKeys] = useState<readonly Key[]>([]);
  useEffect(() => {
    if (accountSearch.trim()) setControlledExpandedKeys(expandedSearchKeys);
  }, [accountSearch, expandedSearchKeys]);

  const sourceButtons = (row: AccountRow) => <Space size={0}>
    {!row.unbudgeted && <Button size="small" type="link" onClick={() => setEvidenceTarget({ type: 'budget', sourceId: versionId!, accountId: row.accountId, orgId: orgScopeId ?? undefined })}>预算</Button>}
    {report?.actualBatchId != null && <Button size="small" type="link" onClick={() => setEvidenceTarget({ type: 'actual', sourceId: report.actualBatchId!, accountId: row.accountId, orgId: orgScopeId ?? undefined })}>实际</Button>}
    {forecastId && forecastAccounts.has(row.code) && <Button size="small" type="link" onClick={() => setEvidenceTarget({ type: 'budget', sourceId: forecastId, accountId: forecastAccounts.get(row.code)!.accountId, orgId: orgScopeId ?? undefined })}>预测</Button>}
  </Space>;

  const deviationTag = (cell: CompletionCell, type?: string) => {
    if (noActual) return noActualCell;
    /* 进度偏差为空时给出原因:完成率本身不适用,或缺实际截至日期导致无时间进度基准 */
    if (cell.progressDeviation == null) {
      const reason = cell.rate == null ? formatRateOrReason(cell.rate, cell.rateSpecial) : '无时间进度基准（缺实际截至日期）';
      return <Typography.Text type="secondary" title={reason}>—</Typography.Text>;
    }
    const bad = type === 'cost' || type === 'expense' ? cell.progressDeviation > 0 : cell.progressDeviation < 0;
    return <Tag color={Math.abs(cell.progressDeviation) < 0.0000001 ? 'default' : bad ? 'orange' : 'green'}>{cell.progressDeviation >= 0 ? '+' : ''}{(cell.progressDeviation * 100).toFixed(2)}pp</Tag>;
  };

  const accountColumns: TableColumnsType<AccountRow> = [
    {
      title: '科目',
      fixed: screens.lg ? 'left' : undefined,
      /* 树形首列:基础宽(编码12+名称+Tag) + 层级缩进补偿(最深 4 级×16px+展开钮 24px),
         编码 nowrap、名称与 Tag 允许尾部省略,深层行不折行撑高(方案一.4/三.2) */
      width: 280 + treeIndentReserve(4, 16, 24),
      onCell: () => ({ style: { whiteSpace: 'nowrap' } }),
      render: (_value, row) => (
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 0, minWidth: 0 }}>
          <Typography.Text strong={!row.isLeaf} copyable={false} style={{ whiteSpace: 'nowrap' }}>{row.code}</Typography.Text>
          {' '}
          <Typography.Text strong={!row.isLeaf} ellipsis style={{ minWidth: 0, flex: '0 1 auto' }} title={row.name}>{row.name}</Typography.Text>
          {!row.isLeaf && <Tag style={{ marginLeft: 6, flex: '0 0 auto' }}>汇总</Tag>}
          {row.unbudgeted && <Tag color="orange" style={{ marginLeft: 6, flex: '0 0 auto' }}>未预算承接</Tag>}
        </span>
      ),
    },
    { title: '类型', width: 72, render: (_value, row) => row.type === 'income' ? '收入' : row.type === 'cost' ? '成本' : row.type === 'expense' ? '费用' : '数量' },
    { title: '来源', width: 148, render: (_value, row) => sourceButtons(row) },
    { title: rowTitle('年度预算'), align: 'right', width: 130, sorter: (a, b) => (a.type === 'quantity' ? a.cell.budgetQuantity - b.cell.budgetQuantity : a.cell.budgetCents - b.cell.budgetCents), render: (_value, row) => displayValue(row, 'budget') },
    { title: rowTitle('累计实际'), align: 'right', width: 130, sorter: (a, b) => (a.type === 'quantity' ? a.cell.actualQuantity - b.cell.actualQuantity : a.cell.actualCents - b.cell.actualCents), render: (_value, row) => noActual ? noActualCell : displayValue(row, 'actual') },
    ...(forecastId ? [{ title: rowTitle('全年预测'), align: 'right' as const, width: 130, render: (_value: unknown, row: AccountRow) => { const found = forecastAccounts.get(row.code); return found ? displayValue(found, 'budget') : <Typography.Text type="secondary" title="该科目不在所选预测版本中">—</Typography.Text>; } }] : []),
    /* favorable 由后端判定,差异是典型「已判定好坏」的场合,经 tone 显式传色 */
    { title: '预算差异', align: 'right', width: 125, sorter: (a, b) => Math.abs(a.cell.varianceCents) - Math.abs(b.cell.varianceCents), render: (_value, row) => noActual ? noActualCell : (row.type === 'quantity' ? displayValue(row, 'variance') : <MoneyText cents={row.type === 'income' ? row.cell.varianceCents : -row.cell.varianceCents} hideUnit tone={row.cell.favorable === 'unfavorable' ? 'bad' : row.cell.favorable === 'favorable' ? 'good' : 'neutral'} />) },
    ...(forecastId ? [{ title: '预测较预算', align: 'right' as const, width: 125, render: (_value: unknown, row: AccountRow) => { const found = forecastAccounts.get(row.code); if (!found) return '-'; if (row.type === 'quantity') return formatQuantity(found.cell.budgetQuantity - row.cell.budgetQuantity, row.unit); return <MoneyText cents={found.cell.budgetCents - row.cell.budgetCents} hideUnit />; } }] : []),
    { title: '完成率', align: 'right', width: 145, sorter: (a, b) => (a.cell.rate ?? -Infinity) - (b.cell.rate ?? -Infinity), render: (_value, row) => {
      if (noActual) return noActualCell;
      /* 无完成率时直接给服务端原因(零预算/负预算等),不再只显示 N/A */
      if (row.cell.rate == null) return <Typography.Text type="secondary">{formatRateOrReason(row.cell.rate, row.cell.rateSpecial)}</Typography.Text>;
      return <span>{formatRate(row.cell.rate)}{row.cell.rateSpecial && <Tooltip title={RATE_SPECIAL_TEXT[row.cell.rateSpecial]}><Tag color="orange" style={{ marginLeft: 4 }}>注意</Tag></Tooltip>}</span>;
    } },
    { title: '进度偏差', width: 112, sorter: (a, b) => (a.cell.progressDeviation ?? -Infinity) - (b.cell.progressDeviation ?? -Infinity), render: (_value, row) => deviationTag(row.cell, row.type) },
    { title: '判断', width: 90, render: (_value, row) => row.type === 'quantity' ? <Tag>业务量</Tag> : row.cell.favorable === 'favorable' ? <Tag color="green">有利</Tag> : row.cell.favorable === 'unfavorable' ? <Tag color="red">不利</Tag> : <Tag>无差异</Tag> },
  ];

  function rowTitle(text: string) { return <span>{text}<br /><Typography.Text type="secondary" style={{ fontSize: 12 }}>万元/数量</Typography.Text></span>; }

  const netColumns = (forecastMap: Map<string, OrgRow | MetricRow>, metricDrill = false): TableColumnsType<OrgRow | MetricRow> => [
    /* 按预算组织/报表指标两表复用。树形组织树最深 4 级,编码列须含缩进补偿
       (方案二.A:105px 在深 4 级时编码被裁,用户首报) */
    codeColumn<OrgRow | MetricRow>({ title: '编码', dataIndex: 'code', width: CODE_WIDTH.org + treeIndentReserve(4, 15, 24) }),
    {
      title: '名称',
      width: 210,
      ellipsis: { showTitle: false },
      render: (_value, row) => (
        <Tooltip title={row.name}>
          <span>{row.name}{'unbudgeted' in row && row.unbudgeted && <Tag color="orange" style={{ marginLeft: 6 }}>未预算承接</Tag>}</span>
        </Tooltip>
      ),
    },
    { title: '年度预算(万元)', align: 'right', render: (_value, row) => <MoneyText cents={row.cell.budgetCents * ('displaySign' in row ? row.displaySign : 1)} hideUnit /> },
    { title: '累计实际(万元)', align: 'right', render: (_value, row) => noActual ? noActualCell : <MoneyText cents={row.cell.actualCents * ('displaySign' in row ? row.displaySign : 1)} hideUnit /> },
    ...(forecastId ? [{ title: '全年预测(万元)', align: 'right' as const, render: (_value: unknown, row: OrgRow | MetricRow) => { const found = forecastMap.get(row.code); return found ? <MoneyText cents={found.cell.budgetCents * ('displaySign' in found ? found.displaySign : 1)} hideUnit /> : '-'; } }] : []),
    /* 差异的「有利/不利」由后端判定(favorable),是典型已判定好坏的场合 —— 显式传 tone */
    { title: '预算差异(万元)', align: 'right', sorter: (a, b) => Math.abs(a.cell.varianceCents) - Math.abs(b.cell.varianceCents), render: (_value, row) => noActual ? noActualCell : <MoneyText cents={row.cell.varianceCents} hideUnit tone={row.cell.favorable === 'unfavorable' ? 'bad' : row.cell.favorable === 'favorable' ? 'good' : 'neutral'} /> },
    { title: '完成率', align: 'right', render: (_value, row) => noActual ? noActualCell : <Typography.Text type={row.cell.rate == null ? 'secondary' : undefined}>{formatRateOrReason(row.cell.rate, row.cell.rateSpecial)}</Typography.Text> },
    { title: '进度偏差', render: (_value, row) => deviationTag(row.cell) },
    // 指标行可穿透到公式项:范围参数与当前筛选一致,保证穿透数字与本表逐分相等
    ...(metricDrill ? [{
      title: '来源',
      width: 92,
      render: (_value: unknown, row: OrgRow | MetricRow) => ('metricId' in row ? (
        <Button size="small" type="link" style={{ paddingInline: 4 }} onClick={() => setEvidenceTarget({
          type: 'metric',
          versionId: versionId!,
          metricId: row.metricId,
          batchId: batchId ?? null,
          orgScopeId: orgScopeId ?? null,
          accountScopeId: accountScopeId ?? null,
          sheetKey,
        })}>穿透</Button>
      ) : null),
    }] : []),
  ];

  /**
   * 比率指标列。与金额指标表刻意分开:
   * - 没有「完成率」列 —— 比率的预实对比是百分点差,做成比率的比率没有业务含义;
   * - 分母为 0 显示「不适用（分母为 0）」,不显示 0;
   * - 有利/不利读指标自身声明的 direction(费用率越低越好),不是「差异为正即有利」。
   */
  const ratioColumns: TableColumnsType<RatioMetricRow> = [
    { title: '编码', dataIndex: 'code', width: 100 },
    { title: '名称', dataIndex: 'name', width: 160 },
    {
      title: '口径', width: 130,
      render: (_value, row) => (
        <Space size={4}>
          <Tag color={row.displayFormat === 'percent' ? 'geekblue' : 'purple'}>
            {row.displayFormat === 'percent' ? '百分比' : row.unit || '自然单位'}
          </Tag>
          {row.direction === 'lower_better' ? <Tag color="orange">越低越好</Tag> : <Tag color="green">越高越好</Tag>}
        </Space>
      ),
    },
    {
      title: '预算比率', align: 'right', width: 130,
      render: (_value, row) => row.budget.scaled == null
        ? <Typography.Text type="secondary">不适用（分母为 0）</Typography.Text>
        : formatRatio(row.budget.scaled, row.displayFormat, row.unit),
    },
    {
      title: '实际比率', align: 'right', width: 130,
      render: (_value, row) => row.actual.scaled == null
        ? <Typography.Text type="secondary">不适用（分母为 0）</Typography.Text>
        : formatRatio(row.actual.scaled, row.displayFormat, row.unit),
    },
    {
      title: '差异（实际−预算）', align: 'right', width: 150,
      render: (_value, row) => (
        <Typography.Text type={row.favorable === 'unfavorable' ? 'danger' : row.favorable === 'favorable' ? 'success' : undefined}>
          {row.deltaScaled == null ? '不适用（分母为 0）' : formatRatioDelta(row.deltaScaled, row.displayFormat, row.unit)}
        </Typography.Text>
      ),
    },
    {
      title: '判断', width: 90,
      render: (_value, row) => (row.favorable === 'favorable'
        ? <Tag color="green">有利</Tag>
        : row.favorable === 'unfavorable' ? <Tag color="red">不利</Tag> : <Tag>无差异</Tag>),
    },
    {
      title: '分子 / 分母（实际）', width: 260,
      render: (_value, row) => (
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {row.actual.numeratorBasis === 'quantity' ? formatQuantity(row.actual.numeratorRaw) : <MoneyText cents={row.actual.numeratorRaw} size="sm" />}
          {' ÷ '}
          {row.actual.denominatorBasis === 'quantity' ? formatQuantity(row.actual.denominatorRaw) : <MoneyText cents={row.actual.denominatorRaw} size="sm" />}
          {row.actual.special === 'na_zero_denominator' ? '（分母为零）' : ''}
        </Typography.Text>
      ),
    },
  ];

  const exportAnalysis = async () => {
    if (!versionId) return;
    const query = buildQuery({ batchId, orgScopeId, accountScopeId, sheetKey, summaryLevel, forecastVersionId: forecastId });
    // 成功/失败提示由 download() 广播,App 内 DownloadFeedback 统一弹出
    await download(`/io/export/completion/${versionId}?${query}`, `${year}-${report?.scopeBasis.sheetName ?? '预算'}-执行分析.xlsx`);
  };

  const resetFilters = () => {
    const next = new URLSearchParams();
    if (year) next.set('year', String(year));
    if (versionId) next.set('version', String(versionId));
    setParams(next, { replace: true });
    setAccountSearch('');
  };

  const reportError = versionsQuery.error ?? reportQuery.error;
  const actionButtons = <Space><Button icon={<i className="ri-refresh-line" aria-hidden />} onClick={() => { void reportQuery.refetch(); void forecastQuery.refetch(); void trendQuery.refetch(); }}>刷新</Button><Button icon={<i className="ri-download-2-line" aria-hidden />} disabled={!versionId || !report} title={!versionId ? '请先选择预算版本' : !report ? '执行数据加载中,稍候即可导出' : '按当前筛选口径导出 Excel'} onClick={() => void exportAnalysis()}>按当前口径导出</Button></Space>;

  return <>
    {/* 无壳 + 无标题:本页挂载在 /analysis 路由下,顶栏已显示「年度执行分析」 */}
    <Card className="bd-root-card" extra={screens.sm ? actionButtons : undefined}>
      {/* 眉题:每页仅首个内容区块带,避免满屏编号 */}
      <div className="bd-eyebrow">执行分析</div>
      {!screens.sm && <div style={{ marginBottom: 12 }}>{actionButtons}</div>}
      <Space wrap size={[10, 10]} style={{ marginBottom: 8 }}>
        <Select aria-label="年份" placeholder="选择年份" style={{ width: 120 }} value={year} onChange={(value) => setFilter('year', value, ['version', 'forecast', 'batch'])} options={years.map((value) => ({ value, label: `${value} 年` }))} loading={versionsQuery.isLoading} />
        <Select aria-label="预算版本" showSearch optionFilterProp="label" placeholder="预算版本" style={{ width: 230 }} value={versionId} onChange={(value) => setFilter('version', value, ['forecast', 'batch'])} options={budgetVersions.map((item) => ({ value: item.id, label: `${item.name}（${item.status}）` }))} />
        <TreeSelect aria-label="预算组织" style={{ width: 220 }} treeData={orgTreeData} value={orgScopeId ?? undefined} allowClear treeDefaultExpandAll showSearch treeNodeFilterProp="title" placeholder="预算组织（默认全部）" onChange={(value) => setFilter('org', value as number | null)} />
        <Select aria-label="预算表格" style={{ width: 180 }} value={sheetKey} loading={sheetsLoading} onChange={(value) => setFilter('sheet', value)} options={[...SPECIAL_SHEETS, ...dbSheets].map((item) => ({ value: item.key, label: item.name }))} />
      </Space>
      <Collapse ghost items={[{ key: 'adv', label: '高级筛选', children: (
        <Space wrap size={[10, 10]}>
          <Select aria-label="科目范围" allowClear showSearch optionFilterProp="label" placeholder="科目范围（默认全部）" style={{ width: 205 }} value={accountScopeId ?? undefined} onChange={(value) => setFilter('account', value)} options={(accountTreeQuery.data?.rows ?? []).map((item) => ({ value: item.id, label: `${item.code} ${item.name}` }))} />
          <Select aria-label="汇总层级" style={{ width: 145 }} value={summaryLevel ?? 0} onChange={(value) => setFilter('level', value)} options={[{ value: 0, label: '全部层级' }, ...[1, 2, 3, 4, 5].map((value) => ({ value, label: `显示至 ${value} 级` }))]} />
          <Select aria-label="实际快照" style={{ width: 265 }} value={batchId ?? 0} onChange={(value) => setFilter('batch', value)} options={[{ value: 0, label: '默认实际（当前/最终快照）' }, ...(batchesQuery.data ?? []).filter((item) => item.status === 'active').map((item) => ({ value: item.id, label: `${item.snapshot_date} · 修订 ${item.revision}` }))]} disabled={!current} />
          <Select aria-label="全年预测" allowClear showSearch optionFilterProp="label" placeholder="全年预测（可选）" style={{ width: 220 }} value={forecastId} onChange={(value) => { const next = new URLSearchParams(params); next.set('forecast', value ? String(value) : 'none'); setParams(next, { replace: true }); }} options={forecastVersions.map((item) => ({ value: item.id, label: `${item.name}（${item.status}）` }))} />
          <Space.Compact><InputNumber aria-label="预警阈值" min={0} max={100} precision={0} value={thresholdInput ?? warningThreshold * 100} onChange={(value) => setThresholdInput(value)} onBlur={commitThreshold} onPressEnter={commitThreshold} addonBefore="节奏预警" addonAfter="pp" style={{ width: 175 }} /></Space.Compact>
          <Button onClick={resetFilters}>重置筛选</Button>
        </Space>
      ) }]} />

      {/* UX-25 命名视图:保存/应用/改名/删除当前筛选口径(个人偏好,仅存入口与范围) */}
      <Space wrap size={[10, 10]} style={{ marginBottom: 8 }}>
        <Popover
          trigger="click"
          placement="bottomLeft"
          open={viewsOpen}
          onOpenChange={setViewsOpen}
          content={(
            <div style={{ width: 320, maxHeight: 320, overflowY: 'auto' }}>
              {savedViews.length === 0 && (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  还没有保存的视图。调好上方筛选后点「保存当前为视图」,下次一键回到同一口径。
                </Typography.Text>
              )}
              {savedViews.map((view) => (
                <div key={view.id} style={{ display: 'flex', alignItems: 'center', gap: 2, padding: '2px 0', borderBottom: '1px solid var(--bd-border)' }}>
                  <Button
                    type="link"
                    size="small"
                    style={{ flex: '1 1 auto', minWidth: 0, paddingInline: 0, justifyContent: 'flex-start', height: 'auto' }}
                    title="应用该视图(仅切换筛选条件,不改动任何数据)"
                    onClick={() => applyView(view)}
                  >
                    <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{view.name}</span>
                  </Button>
                  <Button type="text" size="small" aria-label={`重命名视图 ${view.name}`} icon={<i className="ri-edit-line" aria-hidden />} onClick={() => openRenameViewModal(view)} />
                  <Popconfirm
                    title={`删除视图「${view.name}」?`}
                    description="只删除这条查询偏好,不影响任何业务数据"
                    okText="删除"
                    cancelText="取消"
                    onConfirm={() => deleteView(view.id)}
                  >
                    <Button type="text" size="small" danger aria-label={`删除视图 ${view.name}`} icon={<i className="ri-delete-bin-line" aria-hidden />} />
                  </Popconfirm>
                </div>
              ))}
            </div>
          )}
        >
          <Button icon={<i className="ri-bookmark-2-line" aria-hidden />}>
            常用视图{savedViews.length > 0 ? ` ${savedViews.length}` : ''}
          </Button>
        </Popover>
        <Button icon={<i className="ri-save-3-line" aria-hidden />} onClick={openSaveViewModal}>保存当前为视图</Button>
      </Space>
      <Modal
        open={viewModal != null}
        title={viewModal?.mode === 'rename' ? '重命名视图' : '保存当前为视图'}
        okText="保存"
        cancelText="取消"
        onOk={commitViewModal}
        onCancel={() => setViewModal(null)}
        destroyOnClose
      >
        <Input
          autoFocus
          aria-label="视图名称"
          maxLength={40}
          showCount
          value={viewName}
          onChange={(event) => setViewName(event.target.value)}
          onPressEnter={commitViewModal}
          placeholder="如:A 电站年度执行"
        />
      </Modal>

      {scopeIssues.length > 0 && (
        <Alert
          type="warning"
          showIcon
          closable
          style={{ marginBottom: 12 }}
          onClose={() => setScopeIssues([])}
          message="链接中的范围参数已忽略"
          description={scopeIssues.map((issue) => issue.detail).join('；')}
        />
      )}
      {locateNotices.length > 0 && (
        <Alert
          type={locateNotices.some((notice) => notice.type === 'warning') ? 'warning' : 'info'}
          showIcon
          closable
          style={{ marginBottom: 12 }}
          onClose={() => setLocateNotices([])}
          message="定位结果说明"
          description={locateNotices.map((notice) => notice.text).join('；')}
        />
      )}
      {/* UX-04:分析口径常驻一行(年度 · 组织 · 版本 · 实际截至 · 金额单位),
          大表滚动后仍能确认当前范围 */}
      <WorkspaceScopeBar
        year={year}
        orgName={orgScopeId != null ? (orgNameById.get(orgScopeId) ?? `组织 #${orgScopeId}`) : null}
        versionName={current?.name ?? null}
        statusLabel={current ? `${current.status === 'draft' ? '草稿' : current.status === 'locked' ? '已定稿' : '已归档'}${current.is_current ? ' · 当前采用' : ''}` : null}
        status={versionsQuery.isLoading ? 'loading' : 'ready'}
        asOfDate={report?.asOfDate ?? null}
        extra={report ? <span className="bd-scope-bar-label">{report.scopeBasis.sheetName}</span> : undefined}
        style={{ marginBottom: 12 }}
      />

      {reportError && <Result status="error" title="执行分析加载失败" subTitle={reportError instanceof Error ? reportError.message : '请稍后重试'} extra={<Button onClick={() => { void versionsQuery.refetch(); void reportQuery.refetch(); }}>重试</Button>} />}
      {!reportError && (reportQuery.isLoading || versionsQuery.isLoading) && <Card><TableSkeleton columns={5} rows={6} /></Card>}
      {!reportError && !reportQuery.isLoading && !report && <Empty description="所选条件下暂无预算执行数据" />}

      {report && <>
        {forecastQuery.error && <Alert type="error" showIcon style={{ marginBottom: 12 }} message="全年预测加载失败" description={forecastQuery.error instanceof Error ? forecastQuery.error.message : '请稍后重试'} action={<Button size="small" onClick={() => void forecastQuery.refetch()}>重试预测</Button>} />}
        <Descriptions size="small" bordered column={screens.lg ? 4 : screens.sm ? 2 : 1} style={{ marginBottom: 12 }}>
          <Descriptions.Item label="分析年度">{report.version.year}</Descriptions.Item>
          <Descriptions.Item label="预算版本">{report.version.name}</Descriptions.Item>
          <Descriptions.Item label="预算组织">{orgScopeId ? `组织节点 #${orgScopeId} 及下级` : '全部预算组织'}</Descriptions.Item>
          <Descriptions.Item label="预算表格">{report.scopeBasis.sheetName}</Descriptions.Item>
          <Descriptions.Item label="实际截至">{report.asOfDate ?? '尚无实际批次'}</Descriptions.Item>
          <Descriptions.Item label="时间进度">{formatProgress(report.timeProgressValue)}（均匀自然日）</Descriptions.Item>
          <Descriptions.Item label="实际来源">{report.actualSource === 'current' ? '当前累计实际' : report.actualSource === 'final' ? '年度最终快照' : report.actualSource === 'snapshot' ? '指定快照' : '尚无实际批次'}</Descriptions.Item>
          <Descriptions.Item label="汇总层级">{summaryLevel ? `显示至 ${summaryLevel} 级` : '全部层级'}</Descriptions.Item>
          <Descriptions.Item label="组织树口径" span={screens.lg ? 2 : 1}>{report.treeBasis.org}</Descriptions.Item>
          <Descriptions.Item label="科目树口径" span={screens.lg ? 2 : 1}>{report.treeBasis.account}</Descriptions.Item>
        </Descriptions>
        {/* 口径说明收敛为一行 + Tooltip:原文 73 字常驻首屏,把利润桥挤到折叠线以下。
            金额单位已在顶栏芯片常驻,不必在这里再说一遍。 */}
        <Space size={6} style={{ marginBottom: 12, alignItems: 'flex-start' }}>
          <span className="bd-quote">
            差异为实际－预算(利润方向),进度偏差＝完成率－时间进度
          </span>
          <Tooltip title="金额统一以万元展示；预算差异为实际－预算的利润方向口径；完成率为业务金额口径；进度偏差＝完成率－均匀自然日进度。成本费用进度偏差为正表示发生偏快。">
            <i className="ri-information-line" style={{ color: 'var(--bd-text-tertiary)', fontSize: 13, cursor: 'pointer', marginTop: 5 }} aria-hidden />
          </Tooltip>
        </Space>
        {noActual && <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="尚无实际批次：本页实际、差异、完成率与进度偏差均显示「—」，不代表已保存的零值；录入并保存实际数后自动更新。"
        />}
        {/* 核验条:勾稽/承接/超支/节奏的结论一行收住,通过项不占块级空间。
            此前「逐分勾稽」「无实际数据」「承接区说明」是三个独立色块,共约 12 行。 */}
        <VerifyBar items={verifyItems} style={{ marginBottom: 12 }} />
        {bridge && bridge.deltas.some((d) => d.cents !== 0) && <Card
          size="small"
          title="利润桥（预算利润 → 实际利润）"
          extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>利润方向口径：正为有利</Typography.Text>}
          style={{ marginBottom: 12 }}
        >
          <EChart option={bridgeOption} height={340} />
        </Card>}
        {report.unbudgetedActual.count > 0 && <Card
          size="small"
          title={<Space><i className="ri-alarm-warning-line" style={{ color: statusColor(mode).warn }} aria-hidden /><Typography.Text strong>未预算 / 新增结构实际承接区</Typography.Text><Tag color="orange">{report.unbudgetedActual.count} 条</Tag></Space>}
          extra={<Typography.Text type="secondary">净额 <MoneyText cents={report.unbudgetedActual.amountCents} /></Typography.Text>}
          style={{ marginBottom: 12 }}
        >
          <Table<UnbudgetedActualEntry>
            size="small"
            rowKey={(row) => `${row.orgId}:${row.accountId}`}
            pagination={{ pageSize: 10, hideOnSinglePage: true }}
            dataSource={report.unbudgetedActual.entries}
            columns={[
              { title: '实际组织', width: 190, render: (_value, row) => `${row.orgCode} ${row.orgName}` },
              { title: '实际科目', width: 210, render: (_value, row) => `${row.accountCode} ${row.accountName}` },
              { title: '原因', dataIndex: 'reason', width: 220, render: (value) => <Tag color="orange">{String(value)}</Tag> },
              {
                title: '实际金额（万元）', align: 'right', width: 150,
                render: (_value, row) => row.accountType === 'quantity'
                  ? '-'
                  : <MoneyText cents={row.accountType === 'income' ? row.amountCents : -row.amountCents} hideUnit />,
              },
              {
                title: '实际数量', align: 'right', width: 140,
                render: (_value, row) => row.quantity == null ? '-' : formatQuantity(row.quantity),
              },
            ]}
            scroll={{ x: 910 }}
          />
        </Card>}

        {!noActual && report.metrics.length > 0 && <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
          {report.metrics.slice(0, 4).map((metric) => <Col xs={24} sm={12} lg={6} key={metric.metricId}><Card size="small"><Statistic title={metric.name} value={Number(centsToWan(metric.cell.actualCents * metric.displaySign).replace(/,/g, ''))} precision={2} suffix="万元" valueStyle={{ color: metric.cell.favorable === 'unfavorable' ? statusColor(mode).bad : financeColor(mode).income }} /><Space><Tag>预算 <MoneyText cents={metric.cell.budgetCents * metric.displaySign} size="sm" hideUnit /></Tag><Tag color={metric.cell.progressDeviation != null && metric.cell.progressDeviation < 0 ? 'orange' : 'green'}>{formatRateOrReason(metric.cell.rate, metric.cell.rateSpecial)}</Tag></Space></Card></Col>)}
        </Row>}

        <Row gutter={[12, 12]} style={{ marginBottom: 12 }}>
          <Col xs={24} sm={8}><Card size="small"><Statistic title="年度预算超支（红灯）" value={alertAnalysis.overspend.length} prefix={<i className="ri-alarm-warning-line" aria-hidden />} valueStyle={{ color: statusColor(mode).bad }} /></Card></Col>
          <Col xs={24} sm={8}><Card size="small"><Statistic title={`节奏偏离 ≥ ${(warningThreshold * 100).toFixed(0)}pp（黄灯）`} value={alertAnalysis.lagging.length} prefix={<i className="ri-alarm-warning-line" aria-hidden />} valueStyle={{ color: statusColor(mode).warn }} /></Card></Col>
          <Col xs={24} sm={8}><Card size="small"><Statistic title="节奏健康（绿灯）" value={alertAnalysis.healthy} suffix={alertAnalysis.eligible ? `/ ${alertAnalysis.eligible}` : ''} prefix={<i className="ri-checkbox-circle-line" aria-hidden />} valueStyle={{ color: statusColor(mode).good }} /></Card></Col>
        </Row>

        {report.timeProgressValue != null && Object.keys(paceOption).length > 0 && <Card
          size="small"
          title="执行节奏象限"
          extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>气泡大小＝预算差异绝对值；虚线为预警阈值</Typography.Text>}
          style={{ marginBottom: 12 }}
        >
          <EChart option={paceOption} height={360} onSemanticClick={handlePaceClick} />
        </Card>}

        {(alertAnalysis.overspend.length > 0 || alertAnalysis.lagging.length > 0) && <Row gutter={[12, 12]} style={{ marginBottom: 12 }} id={OVERSPEND_ANCHOR}>
          {alertAnalysis.overspend.length > 0 && <Col xs={24} lg={12}><Card size="small" title={<Space><i className="ri-alarm-warning-line" style={{ color: statusColor(mode).bad }} aria-hidden /><Typography.Text type="danger" strong>成本费用超支预警（实际超过年度预算）</Typography.Text></Space>}><Table size="small" rowKey="accountId" pagination={{ pageSize: 8 }} dataSource={alertAnalysis.overspend} columns={[{ title: '科目', render: (_value, row) => `${row.code} ${row.name}` }, { title: '超支额(万元)', align: 'right', render: (_value, row) => <MoneyText cents={Math.abs(row.cell.varianceCents)} hideUnit /> }, { title: '来源', render: (_value, row) => sourceButtons(row) }]} scroll={narrowScroll} /></Card></Col>}
          {alertAnalysis.lagging.length > 0 && <Col xs={24} lg={12}><Card size="small" title={<Space><i className="ri-alarm-warning-line" style={{ color: statusColor(mode).warn }} aria-hidden /><Typography.Text style={{ color: statusColor(mode).warn }} strong>执行节奏显著偏离</Typography.Text></Space>}><Table size="small" rowKey="accountId" pagination={{ pageSize: 8 }} dataSource={alertAnalysis.lagging} columns={[{ title: '科目', render: (_value, row) => `${row.code} ${row.name}` }, { title: '完成率', align: 'right', render: (_value, row) => formatRate(row.cell.rate) }, { title: '进度偏差', render: (_value, row) => deviationTag(row.cell, row.type) }, { title: '来源', render: (_value, row) => sourceButtons(row) }]} scroll={narrowScroll} /></Card></Col>}
        </Row>}

        {attributions.map((item) => <Card key={item.rule.id} size="small" title={<Space><i className="ri-flashlight-line" style={{ color: financeColor(mode).income }} aria-hidden /><b>发电量价利归因分析 · {item.rule.name}</b><Tag>{item.rule.sheet_code || '通用模板'}</Tag></Space>} style={{ marginBottom: 12 }}>
          <Row gutter={[12, 12]}>
            <Col xs={24} sm={12} lg={6}><Statistic title="收入总差异" value={item.totalDifference} precision={2} suffix="万元" valueStyle={{ color: item.totalDifference >= 0 ? statusColor(mode).good : statusColor(mode).bad }} /></Col>
            <Col xs={24} sm={12} lg={6}><Statistic title="业务量影响" value={item.volumeImpact} precision={2} suffix="万元" /><Typography.Text type="secondary">实际 {item.qa.toFixed(2)} / 预算 {item.qb.toFixed(2)}</Typography.Text></Col>
            <Col xs={24} sm={12} lg={6}><Statistic title="价格及税率影响" value={item.priceTaxImpact} precision={2} suffix="万元" /><Typography.Text type="secondary">价格 {item.pa.toFixed(4)} / {item.pb.toFixed(4)}；税率 {item.ta}% / {item.tb}%</Typography.Text></Col>
            <Col xs={24} sm={12} lg={6}><Statistic title="其他因素/残差" value={item.residual} precision={2} suffix="万元" valueStyle={{ color: Math.abs(item.residual) > 0.05 ? statusColor(mode).warn : statusColor(mode).good }} /><Typography.Text type="secondary">记录收入与量×净价模型的未解释差额</Typography.Text></Col>
          </Row>
        </Card>)}

        <Card size="small" title={`预算 / 实际${forecastId ? ' / 全年预测' : ''}统一对比 · ${report.scopeBasis.sheetName}`} extra={<Input.Search allowClear placeholder="搜索科目编码/名称" value={accountSearch} onChange={(event) => setAccountSearch(event.target.value)} style={{ width: screens.sm ? 240 : 170 }} />} style={{ marginBottom: 12 }}>
          <Table size="small" rowKey="accountId" pagination={{ pageSize: 30, showSizeChanger: true, pageSizeOptions: [20, 30, 50, 100], showTotal: (total) => `共 ${total} 个顶层节点` }} expandable={accountSearch.trim() ? { expandedRowKeys: controlledExpandedKeys, onExpandedRowsChange: setControlledExpandedKeys } : { defaultExpandAllRows: false }} dataSource={accountRows} columns={accountColumns} scroll={{ x: 1450 }} locale={{ emptyText: '当前预算表格和科目范围内没有数据' }}
            /* UX-03 跨页定位:预警/证据下钻的科目行给锚点 id 与高亮,供定位效应滚动 */
            onRow={(row) => ({ id: row.accountId === accountScopeId ? 'analysis-locate-account' : undefined })}
            rowClassName={(row) => (row.accountId === accountScopeId ? 'bd-row-locate' : '')} />
        </Card>
        <Card size="small" title="按预算组织（所选预算表格净额）" style={{ marginBottom: 12 }}>
          {/* 速览带:一级组织完成率前 6 的排行行;完整树表保留在下方 */}
          {orgRateRank.length > 0 && (
            <div style={{ marginBottom: 10 }}>
              <div className="bd-metric-label" style={{ marginBottom: 4 }}>一级组织完成率 · 前 6 速览</div>
              {/* min(250px, 100%):窄容器(嵌套卡 ~235px)装不下 250px 硬最小轨道会撑出页面级横向滚动 */}
              <div style={{ display: 'grid', gridTemplateColumns: 'repeat(auto-fit, minmax(min(250px, 100%), 1fr))', gap: '0 24px' }}>
                {orgRateRank.map((row) => (
                  <RankBarRow key={row.key} color={row.color} label={row.label} value={row.value} share={row.share} shareLabel={row.shareLabel} />
                ))}
              </div>
            </div>
          )}
          <Table size="small" rowKey={(row) => 'orgId' in row ? row.orgId : row.code} pagination={false} expandable={{ defaultExpandAllRows: true, indentSize: 15 }} dataSource={orgRows}
            /* UX-03 跨页定位:预警/证据下钻的组织行给锚点 id 与高亮 */
            onRow={(row) => ({ id: 'orgId' in row && row.orgId === orgScopeId ? 'analysis-locate-org' : undefined })}
            rowClassName={(row) => ('orgId' in row && row.orgId === orgScopeId ? 'bd-row-locate' : '')}
            /* 树形表格不在首列强插窄 # 排名列:展开图标与层级缩进由首列承载,
               44px 定宽会挤压变形,且 rc-table 给子节点传的是兄弟组内局部索引,序号无全局意义 */
            columns={netColumns(forecastOrgs)}
            scroll={{ x: 950 }} />
        </Card>
        {report.metrics.length > 0 && <Card size="small" title="报表指标（所选组织与预算表格范围）" extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>点「穿透」查看指标由哪些公式项构成</Typography.Text>} style={{ marginBottom: 12 }}><Table size="small" rowKey="metricId" pagination={false} dataSource={report.metrics} columns={netColumns(forecastMetrics, true)} scroll={{ x: 1000 }} /></Card>}
        {report.ratioMetrics.length > 0 && <Card
          size="small"
          title="比率指标（所选组织与预算表格范围）"
          extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>比率按「先汇总分子分母再相除」重算，差异为百分点差而非完成率</Typography.Text>}
          style={{ marginBottom: 12 }}
        >
          <Table size="small" rowKey="metricId" pagination={false} dataSource={report.ratioMetrics} columns={ratioColumns} scroll={{ x: 1100 }} />
        </Card>}
        <Card size="small" title="年内执行趋势" extra={<Select aria-label="趋势指标" showSearch optionFilterProp="label" value={trendSelection || undefined} onChange={(value) => setFilter('trend', value)} options={trendOptions} style={{ width: screens.sm ? 250 : 190 }} />} style={{ marginBottom: 12 }}>
          {trendQuery.error ? <Result status="error" title="趋势加载失败" subTitle={trendQuery.error instanceof Error ? trendQuery.error.message : '请稍后重试'} extra={<Button onClick={() => void trendQuery.refetch()}>重试趋势</Button>} /> : trendQuery.isLoading ? <CardSkeleton chart /> : trend && trend.points.length > 0 ? <EChart option={chartOption} height={380} onSemanticClick={handleTrendClick} /> : <Empty description="所选年度和口径内暂无 active 实际快照趋势" />}
        </Card>
        {/* 后端 notes 与核验条同源:勾稽、承接这两条已在上方 VerifyBar 呈现,
            这里滤掉同义句,避免同一结论在页首页尾各读一遍。notes 本身不改动,
            导出与审计证据仍带完整口径说明。 */}
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          {report.notes.filter((note) => !note.includes('逐分勾稽') && !note.includes('未预算实际承接区')).join('；')}
        </Typography.Text>
      </>}
    </Card>
    <EvidenceDrawer target={evidenceTarget} onTargetChange={setEvidenceTarget} />
  </>;
}
