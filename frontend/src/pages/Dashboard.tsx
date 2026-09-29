import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode, type KeyboardEvent as ReactKeyboardEvent } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  Alert, Button, Card, Col, Row, Select, Segmented, Skeleton, Space, Tag, Tooltip, Typography, theme,
} from 'antd';
import { EnhancedTable as Table } from '../components/EnhancedTable';
import { Link, useNavigate } from 'react-router-dom';
import { api } from '../api/client';
import { centsToYuan, formatRate, formatRateOrReason, formatProgress, RATE_SPECIAL_TEXT } from '../utils/money';
import MoneyText from '../components/MoneyText';
import { escapeHtml } from '../utils/escapeHtml';
import { chartTheme, useThemeMode, areaGradient, glowLineStyle, statusColor, withAlpha } from '../theme';
import EChart from '../components/EChart';
import { EvidenceDrawer, type EvidenceTarget } from '../components/EvidenceDrawer';
import { BdEmpty } from '../components/BdEmpty';
import { CardSkeleton, TableSkeleton } from '../components/Skeletons';
import { QueryErrorResult } from '../components/QueryErrorResult';
import { useAssistantPageContext } from '../assistant/contextHooks';
import { useOptionalAssistantRegistry } from '../assistant/AssistantContextRegistry';
import { buildScopedPath } from '../assistant/context';
import { useUrlScopeSync } from '../hooks/useUrlScopeSync';
import { useUserPrefs } from '../hooks/useUserPrefs';
import { MAX_RECENTS } from '../utils/userPrefs';
import { relativeTime } from '../utils/relativeTime';
import type { ScopeIssue } from '../utils/workspaceScope';
import { buildNextActions, type NextAction } from './dashboard/nextActions';
import type { ChartSemanticClick } from '../components/EChart';

/**
 * 把 Card/div 这类非语义元素当按钮用时补齐可达性:role/tabIndex/aria-label +
 * Enter/Space 键盘等价物,否则纯键盘用户无法进入首页的引导与快捷入口。
 */
function clickableProps(onActivate: () => void, label: string) {
  return {
    role: 'button' as const,
    tabIndex: 0,
    'aria-label': label,
    onClick: onActivate,
    onKeyDown: (e: ReactKeyboardEvent<HTMLDivElement>) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onActivate(); }
    },
  };
}

interface DashboardData {
  counts: { orgs: number; accounts: number; metrics: number; versions: number; batches: number };
  currentVersions: { id: number; year: number; name: string }[];
  years: { year: number; status: string; final_batch_id: number | null }[];
  lastActual: { year: number; snapshot_date: string } | null;
  structure: { org: { ok: boolean; problems: string[] }; account: { ok: boolean; problems: string[] } };
  /** UX-24 下一步事实源:最近草稿 / 定稿未采用缺口 / 各年度最新快照(全部来自后台状态)。 */
  workState: {
    recentDraft: { id: number; year: number; name: string; kind: string; updated_at: string } | null;
    pendingAdoption: { year: number; kind: string; lockedCount: number; latestLockedName: string | null }[];
    yearActuals: { year: number; latest_snapshot: string; batch_count: number }[];
  };
  recentLogs: { id: number; action: string; entity_type: string; created_at: string; detail_json: string }[];
}

interface CompletionCell {
  budgetCents: number;
  actualCents: number;
  varianceCents: number;
  rate: number | null;
  rateSpecial: string | null;
  favorable: string;
}

interface CompletionReport {
  version: { id: number; year: number; name: string };
  asOfDate: string | null;
  timeProgressValue: number | null;
  actualSource: string;
  byAccount: { accountId: number; name: string; type: string; isLeaf: boolean; cell: CompletionCell }[];
  /**
   * 组织行自带层级(parentId/level),可直接建树。
   * unbudgeted=true 的行属于「当前实际树」命名空间,其 parentId 可能指向预算快照里不存在的节点,
   * 建树时必须单独挂接,否则出现悬空父节点。
   */
  byOrg: { orgId: number; parentId: number | null; code: string; name: string; level: number; isLeaf: boolean; unbudgeted: boolean; budgetVolumeCents: number; cell: CompletionCell }[];
  metrics: { metricId: number; code: string; name: string; displaySign: 1 | -1; cell: CompletionCell }[];
}

interface TrendPoint { date: string; rate: number | null; timeProgress: number }

const ACTION_LABEL: Record<string, string> = {
  'org.create': '新建组织', 'org.update': '更新组织', 'org.move': '移动组织',
  'org.deactivate': '停用组织', 'org.activate': '启用组织',
  'account.create': '新建科目', 'account.update': '更新科目', 'account.move': '移动科目',
  'account.deactivate': '停用科目', 'account.activate': '启用科目',
  'metric.create': '新建指标', 'metric.update': '更新指标', 'metric.delete': '删除指标',
  'sheet.create': '新建表格', 'sheet.update': '更新表格', 'sheet.delete': '删除表格',
  'budget.create': '新建版本', 'budget.save': '保存预算（旧记录）', 'budget.checkpoint': '编制记录', 'budget.lock': '定稿版本',
  'budget.set_current': '设为当前生效', 'budget.copy': '复制版本', 'budget.rename': '重命名版本',
  'budget.archive': '归档版本', 'budget.clear': '清空预算', 'budget.delete': '删除版本',
  'actual.save': '保存实际数', 'actual.import': '导入实际数', 'actual.history_import': '历史补录', 'import.failed': '导入失败',
  'backup.create': '创建备份', 'backup.restore': '恢复备份',
  'year.freeze': '年度关闭', 'year.reopen': '年度重开', 'migration.apply': '执行迁移',
  'auth.login': '登录', 'auth.logout': '登出', 'auth.login_failed': '登录失败',
};

/** 完成率 = |实际|/|预算|;预算为 0 或与实际反向时无法给出有意义的比率 */
function overallRate(budgetCents: number, actualCents: number): number | null {
  if (budgetCents === 0) return null;
  if (budgetCents > 0 !== actualCents >= 0) return null;
  return Math.abs(actualCents) / Math.abs(budgetCents);
}

/* ── 最近操作紧凑日志行:实体名与入口由前端从 detail_json / entity_type 派生 ── */

const ENTITY_TYPE_LABEL: Record<string, string> = {
  /* 与后端 writeLog 第三参数持久化的 25 类真实 entity_type 逐字对齐;
     键名不匹配时行内回退显示原始类型,不再出现裸露英文 */
  org: '组织', account: '科目', metric: '指标', preset_sheet: '预算表格',
  budget_version: '预算版本', budget_import: '预算导入', budget_calculation_rule: '测算规则',
  actual_import: '实际数导入', actual_snapshot_batch: '实际快照', actual_year: '实际年度',
  import_batch: '导入批次', import_mapping_template: '导入模板', import_name_alias: '导入别名',
  cleaning_upload: '清洗导入',
  finance_source_profile: '财务数据源', finance_mapping_version: '财务映射',
  finance_conversion_batch: '财务转换', finance_parallel_trial: '并行试运行',
  ai_action: 'AI 操作', ai_conversation: 'AI 会话', ai_insight: 'AI 洞察',
  backup: '备份', schema_migration: '迁移', settings: '系统设置', auth: '登录',
};

/** 各实体对应的管理入口(日志行 meta 的「进入」链接;没有明确入口的实体不渲染链接) */
const ENTITY_PATH: Record<string, string> = {
  org: '/org', account: '/account', metric: '/metric',
  preset_sheet: '/budget', budget_version: '/budget', budget_import: '/budget',
  budget_calculation_rule: '/data?tab=calculations',
  actual_import: '/actual', actual_snapshot_batch: '/actual', actual_year: '/data?tab=yearclose',
  import_batch: '/data?tab=imports', cleaning_upload: '/data?tab=imports',
  import_mapping_template: '/cleaning-config', import_name_alias: '/cleaning-config',
  finance_source_profile: '/finance', finance_mapping_version: '/finance',
  finance_conversion_batch: '/finance', finance_parallel_trial: '/finance',
  ai_action: '/assistant', ai_conversation: '/assistant', ai_insight: '/insights',
  backup: '/data?tab=backup', schema_migration: '/data?tab=migration', settings: '/settings/ai',
};

/** 从 detail_json 里尽力取一个可读的实体名;取不到返回空串(行内回退显示实体类型) */
function logEntityName(detailJson: string): string {
  try {
    const detail = JSON.parse(detailJson) as Record<string, unknown>;
    for (const key of ['name', 'title', 'newName', 'versionName', 'label', 'snapshotDate', 'fileName']) {
      const value = detail[key];
      if (typeof value === 'string' && value.trim()) return value.trim();
    }
  } catch { /* 非 JSON 的旧记录:留空,由实体类型兜底 */ }
  return '';
}

/* ── 月度执行状态矩阵(方案《排版工具与数据组件》二.1) ── */

type MonthState = 'covered' | 'miss' | 'current' | 'future' | 'frozen';

const MONTH_STATE_LABEL: Record<MonthState, string> = {
  covered: '已覆盖',
  miss: '应录未录',
  current: '进行中',
  future: '未来',
  frozen: '年度已冻结',
};

/** 该月最后一天的 ISO 日期(day 0 of next month) */
function monthEndDate(year: number, month: number): string {
  const last = new Date(year, month, 0).getDate();
  return `${year}-${String(month).padStart(2, '0')}-${String(last).padStart(2, '0')}`;
}

/**
 * 逐格判定。语义映射严格遵守「红绿只表达好坏」:
 * 已覆盖(过去月且有快照进入该月,即 maxSnapshot ≥ 该月 1 日)= 主色实心,是正向事实不用绿表态;
 * 快照是累计口径,月内中途快照(如 08-22)同样记为已覆盖,不要求 ≥ 月末,中途快照在提示里注明「月内」;
 * 应录未录(过去月无快照进入该月)= 红;进行中 = 主色 30%;未来 = 斜纹;年度冻结 = 中性灰。
 */
function monthCellState(year: number, month: number, maxSnapshot: string | null, frozen: boolean): { state: MonthState; tip: string } {
  const label = `${year}-${String(month).padStart(2, '0')}`;
  if (frozen) return { state: 'frozen', tip: `${label} · 年度已冻结` };
  const now = new Date();
  if (now.getFullYear() === year && now.getMonth() + 1 === month) return { state: 'current', tip: `${label} · 进行中` };
  const isPast = now.getFullYear() > year || (now.getFullYear() === year && now.getMonth() + 1 > month);
  if (isPast) {
    const monthStart = `${label}-01`;
    if (maxSnapshot && maxSnapshot >= monthStart) {
      const tip = maxSnapshot >= monthEndDate(year, month)
        ? `${label} · 已覆盖（快照截至 ${maxSnapshot}）`
        : `${label} · 已覆盖（月内快照截至 ${maxSnapshot}）`;
      return { state: 'covered', tip };
    }
    return { state: 'miss', tip: `${label} · 应录未录` };
  }
  return { state: 'future', tip: `${label} · 未来` };
}

const MONTH_AXIS_TICKS = new Set([1, 3, 6, 9, 12]);
const MONTH_LEGEND: { state: MonthState; label: string }[] = [
  { state: 'covered', label: '已覆盖' },
  { state: 'miss', label: '应录未录' },
  { state: 'current', label: '进行中' },
  { state: 'future', label: '未来' },
];

/**
 * 月度执行覆盖:一行 12 格的状态矩阵,跟随当前选中年度重算。
 * 数据来自现有 GET /api/actual/batches?year=(全部批次的 snapshot_date),
 * 取最大截止日期与今日对比即可逐格判定,不新增后端接口。
 */
function MonthCoverageCard({ year, frozen, batches, loading }: {
  year: number;
  frozen: boolean;
  batches: { snapshot_date: string }[] | undefined;
  loading: boolean;
}) {
  const maxSnapshot = useMemo(() => {
    const dates = (batches ?? []).map((b) => b.snapshot_date).filter(Boolean).sort();
    return dates.length > 0 ? dates[dates.length - 1] : null;
  }, [batches]);
  const cells = useMemo(
    () => Array.from({ length: 12 }, (_, i) => monthCellState(year, i + 1, maxSnapshot, frozen)),
    [year, maxSnapshot, frozen],
  );
  return (
    <div>
      <div className="bd-eyebrow">01 / 月度执行覆盖</div>
      <Card size="small" data-testid="month-coverage-card">
        {loading ? (
          /* 骨架:12 个灰色格子占位,复用既有骨架手法,不转圈 */
          <div className="bd-month-strip" aria-busy="true" aria-label="月度覆盖加载中">
            {Array.from({ length: 12 }, (_, i) => (
              <Skeleton.Button key={i} active block size="small" style={{ height: 14, borderRadius: 3 }} />
            ))}
          </div>
        ) : (
          <>
            <div className="bd-month-strip">
              {cells.map((cell, i) => (
                /* UX-28:状态不只靠颜色/悬停——格子可聚焦,焦点与读屏都能拿到完整月份状态 */
                <Tooltip key={i} title={cell.tip}>
                  <span className={`bd-month-cell bd-month-cell-${cell.state}`} data-testid={`month-cell-${i + 1}`} tabIndex={0} role="img" aria-label={cell.tip} />
                </Tooltip>
              ))}
            </div>
            <div className="bd-month-axis" aria-hidden>
              {Array.from({ length: 12 }, (_, i) => (
                <span key={i} style={{ textAlign: 'center' }}>{i + 1}月</span>
              ))}
            </div>
            <div className="bd-month-legend">
              {MONTH_LEGEND.map((item) => (
                <span key={item.state} className="bd-month-legend-item">
                  <span className={`bd-month-legend-swatch bd-month-cell-${item.state}`} aria-hidden />
                  {item.label}
                </span>
              ))}
              {frozen && (
                <span className="bd-month-legend-item">
                  <span className="bd-month-legend-swatch bd-month-cell-frozen" aria-hidden />
                  年度已冻结
                </span>
              )}
            </div>
          </>
        )}
        {/* 口径说明与数据同命:骨架期只渲染骨架占位,
            否则 maxSnapshot 返回瞬间兜底文案跳变造成文字闪烁 */}
        {loading ? (
          <Skeleton.Input active size="small" block style={{ margin: '10px 0 0' }} />
        ) : (
          <p className="bd-quote" style={{ margin: '10px 0 0' }}>
            {frozen
              ? `${year} 年度已冻结,快照不再变动`
              : maxSnapshot
                ? `快照最晚截至 ${maxSnapshot},过去月份无当月内快照记为应录未录`
                : '本年度尚无实际快照,过去月份无当月内快照记为应录未录'}
          </p>
        )}
      </Card>
    </div>
  );
}

/** 完成率与时间进度的节奏对比标签 */
function PaceTag({ rate, timeProgress, unfavorableWhenFast = false }: { rate: number | null; timeProgress: number | null; unfavorableWhenFast?: boolean }) {
  if (rate == null || timeProgress == null) return null;
  const diff = rate - timeProgress;
  const pp = Math.abs(diff * 100).toFixed(1);
  if (Math.abs(diff) < 0.01) return <Tag>持平</Tag>;
  const favorable = diff > 0 ? !unfavorableWhenFast : unfavorableWhenFast;
  return <Tag color={favorable ? 'green' : 'red'}>{diff > 0 ? `快 ${pp}pp` : `慢 ${pp}pp`}</Tag>;
}

function paceSentence(name: string, rate: number | null, timeProgress: number | null, unfavorableWhenFast = false): string {
  if (rate == null || timeProgress == null) return `${name}尚无法与时间进度对比`;
  const diff = rate - timeProgress;
  if (Math.abs(diff) < 0.01) return `${name}完成率与时间进度基本持平`;
  const fast = diff > 0;
  const favorable = fast ? !unfavorableWhenFast : unfavorableWhenFast;
  return `${name}完成率较时间进度${fast ? '快' : '慢'} ${Math.abs(diff * 100).toFixed(1)} 个百分点，${favorable ? '有利' : '不利'}`;
}

/**
 * 深色 KPI 概览带里的一项:num 为 null 表示数据未就绪,用骨架块占位。
 * spark(可选)是数字背后垫的 30px 迷你走势线(方案《排版工具与数据组件》二.4):
 * 数据点 < 2 或全部为 null 时不渲染,退回纯数字。
 */
function HeroItem({ label, num, sub, spark, onClick, actionHint, tone }: {
  label: string;
  /** 已排版的主数字节点:金额走 <MoneyText format="compact">,比率/pp/计数等直接给文本 */
  num: ReactNode | null;
  sub: string;
  spark?: (number | null)[];
  /** 有跳转时才把整块变成按钮:超支数是一个入口,不只是一个读数 */
  onClick?: () => void;
  actionHint?: string;
  /** 顶签色:默认朱红;warn/bad 换赭金/绛红,预警在纸面升格(年度账册签名) */
  tone?: 'warn' | 'bad';
}) {
  const sparkOption = useMemo(() => {
    const points = (spark ?? []).filter((v): v is number => v != null);
    if (points.length < 2) return null;
    return {
      /* 背景元素:不做入场动画(prefers-reduced-motion 无需另行处理) */
      animation: false,
      tooltip: { show: false },
      grid: { top: 0, left: 0, right: 0, bottom: 0 },
      xAxis: { type: 'category', show: false, data: (spark ?? []).map((_, i) => i) },
      yAxis: {
        type: 'value', show: false,
        min: (v: { min: number }) => v.min,
        max: (v: { max: number }) => v.max,
      },
      series: [{
        type: 'line',
        data: spark,
        /* 3.4:与下方「执行趋势」同一 rate 序列,同源同形 —— 同样不做插值与跨接 */
        smooth: false,
        symbol: 'none',
        connectNulls: false,
        /* 原为游离独立色相(不在品牌色板与 chartTheme 中的蓝色系),改用系列色 */
        lineStyle: { width: 1.5, color: chartTheme(useThemeMode().mode).colors[0] },
        areaStyle: {
          color: {
            type: 'linear' as const, x: 0, y: 0, x2: 0, y2: 1,
            colorStops: [
              { offset: 0, color: areaGradient(chartTheme(useThemeMode().mode).colors[0], 0.20, 0).colorStops[0].color },
              { offset: 1, color: areaGradient(chartTheme(useThemeMode().mode).colors[0], 0.20, 0).colorStops[1].color },
            ],
          },
        },
      }],
    };
  }, [spark]);
  return (
    <div
      className={`bd-hero-item${onClick ? ' bd-hero-item-action' : ''}`}
      data-tone={tone}
      role={onClick ? 'button' : undefined}
      tabIndex={onClick ? 0 : undefined}
      title={onClick ? actionHint : undefined}
      onClick={onClick}
      onKeyDown={onClick
        ? (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); onClick(); } }
        : undefined}
    >
      <div className="bd-hero-label">{label}</div>
      <div className="bd-hero-num">
        {num != null ? num : <Skeleton.Input active size="small" style={{ width: 96, minWidth: 96 }} />}
      </div>
      {sparkOption ? (
        <div className="bd-hero-spark">
          <EChart option={sparkOption} height={22} />
        </div>
      ) : null}
      <div className="bd-hero-sub">{sub}</div>
    </div>
  );
}

export default function Dashboard() {
  const { token } = theme.useToken();
  const { mode } = useThemeMode();
  const navigate = useNavigate();
  const { prefs } = useUserPrefs();

  const { data: dash, isLoading, isError, error: dashError, refetch: refetchDash } = useQuery({ queryKey: ['dashboard'], queryFn: () => api.get<DashboardData>('/dashboard') });
  const [year, setYear] = useState<number>();
  const [hero, setHero] = useState<string>('net');
  const [evidenceTarget, setEvidenceTarget] = useState<EvidenceTarget | null>(null);

  /* URL 范围契约(UX-02):首页 year 进 URL,刷新/书签恢复同一年度;非法或不存在
     的年度给出可见说明后回落默认年度,不静默伪装成已有数据。
     issues 锁存到本地 state 并由用户关闭:URL 自愈改写后会再次解析(无 issue),
     若直接随解析结果覆盖,说明会一闪而过。 */
  const [scopeIssues, setScopeIssues] = useState<ScopeIssue[]>([]);
  const urlYearRef = useRef<number | null>(null);
  useUrlScopeSync('dashboard', { year }, (parsed) => {
    urlYearRef.current = parsed.scope.year ?? null;
    if (parsed.scope.year != null) setYear((prev) => (prev === parsed.scope.year ? prev : parsed.scope.year!));
    if (parsed.issues.length > 0) {
      setScopeIssues((prev) => [...prev, ...parsed.issues.filter((issue) => !prev.some((p) => p.key === issue.key && p.raw === issue.raw))]);
    }
  });

  useEffect(() => {
    if (year == null && urlYearRef.current == null && dash && dash.currentVersions.length > 0) setYear(dash.currentVersions[0].year);
  }, [dash, year]);

  /* 归属校验:年度只能来自 Select 选项或 URL;落在当前生效版本集合之外的年度
     必然来自被篡改/过期的链接,提示并回落默认年度(同一页内改 URL 也会触发)。 */
  useEffect(() => {
    if (!dash || dash.currentVersions.length === 0 || year == null) return;
    if (!dash.currentVersions.some((v) => v.year === year)) {
      const invalidYear = year;
      const fallback = dash.currentVersions[0].year;
      urlYearRef.current = null;
      setScopeIssues((prev) => (prev.some((p) => p.key === 'year' && p.raw === String(invalidYear)) ? prev : [...prev, {
        key: 'year', field: 'year', raw: String(invalidYear), reason: 'not_found',
        detail: `链接中的 ${invalidYear} 年没有当前生效的预算版本,已改为显示 ${fallback} 年`,
      }]));
      setYear(fallback);
    }
  }, [dash, year]);

  const version = useMemo(() => dash?.currentVersions.find((v) => v.year === year), [dash, year]);

  /**
   * 小澧助手页面登记(§7.3)：year 的异步默认值与对应 version 就绪前保持 loading；
   * 主数字 hero 为 m:metricId 时转换为 dashboardSubject=metric + metricId。
   */
  const heroMetricId = hero.startsWith('m:') ? Number(hero.slice(2)) : null;
  useAssistantPageContext({
    pageKey: 'dashboard',
    ready: Boolean(dash && year != null && version),
    readyState: isLoading || !isError ? 'loading' : 'error',
    notReadyReason: isError ? '首页工作台数据读取失败' : '正在读取首页默认年度与当前生效版本',
    scope: {
      year,
      budgetVersionId: version?.id,
      ...(heroMetricId != null && Number.isSafeInteger(heroMetricId) && heroMetricId > 0 ? { metricId: heroMetricId } : {}),
    },
    view: { dashboardSubject: heroMetricId != null ? 'metric' : hero },
  });
  /** 带业务范围的跳转(§7.4)：目标页采用源页面口径，不重新跳回默认年度。 */
  const analysisPath = useCallback(
    () => buildScopedPath('/analysis', { year, budgetVersionId: version?.id }),
    [year, version],
  );

  /* 切年度瞬间 version 还是旧年度的版本(completion/trend 因 enabled 停发但 React Query
     会保留旧数据):用「version 与所选 year 是否一致」门控,不一致时视为加载中,
     避免 Hero 数字与 spark 显示旧年度数据却标着新年度标签。 */
  const versionMatchesYear = version != null && version.year === year;
  const { data: completionRaw } = useQuery({
    queryKey: ['completion', version?.id],
    enabled: versionMatchesYear,
    queryFn: () => api.get<CompletionReport>(`/report/completion?versionId=${version!.id}`),
  });
  const completion = versionMatchesYear ? completionRaw : undefined;
  const { data: trendRaw } = useQuery({
    queryKey: ['trend', year, version?.id],
    enabled: versionMatchesYear && !!year,
    queryFn: () => api.get<{ points: TrendPoint[] }>(`/report/trend?year=${year}&versionId=${version!.id}`),
  });
  const trend = versionMatchesYear ? trendRaw : undefined;
  /* 月度执行覆盖矩阵:复用现有批次列表接口,只取 snapshot_date 逐格判定(不新增后端接口) */
  const { data: monthBatches, isLoading: monthBatchesLoading } = useQuery({
    queryKey: ['dashboard-month-batches', year],
    enabled: year != null,
    queryFn: () => api.get<{ snapshot_date: string }[]>(`/actual/batches?year=${year}`),
  });

  /* 收入/成本/费用按叶子科目合计(带符号利润方向),净额=三者之和 */
  const totals = useMemo(() => {
    const t = { income: { b: 0, a: 0 }, cost: { b: 0, a: 0 }, expense: { b: 0, a: 0 } };
    for (const r of completion?.byAccount ?? []) {
      if (!r.isLeaf) continue;
      const slot = t[r.type as keyof typeof t];
      if (!slot) continue;
      slot.b += r.cell.budgetCents;
      slot.a += r.cell.actualCents;
    }
    const net = {
      b: t.income.b + t.cost.b + t.expense.b,
      a: t.income.a + t.cost.a + t.expense.a,
    };
    return { ...t, net };
  }, [completion]);

  const noActual = completion?.actualSource === 'none';
  const tp = completion?.timeProgressValue ?? null;
  const yearState = dash?.years.find((y) => y.year === year)?.status;

  // 首页快速超支识别
  const overspendCount = useMemo(() => {
    if (!completion) return 0;
    return completion.byAccount.filter((a) => a.isLeaf && (a.type === 'cost' || a.type === 'expense') && -a.cell.actualCents > -a.cell.budgetCents && -a.cell.budgetCents > 0).length;
  }, [completion]);

  /* UX-24 下一步:全部依据后台事实(版本状态/快照存在性/结构检查)生成,
     不因月份过去断言漏报;无月末快照只客观表述,是否录入由用户判断。 */
  const nextActions = useMemo(() => {
    if (!dash) return [] as NextAction[];
    return buildNextActions({
      year: year ?? null,
      currentVersion: version ? { id: version.id, name: version.name } : null,
      orgCount: dash.counts.orgs,
      accountCount: dash.counts.accounts,
      structureOk: dash.structure.org.ok && dash.structure.account.ok,
      structureProblemCount: dash.structure.org.problems.length + dash.structure.account.problems.length,
      recentDraft: dash.workState.recentDraft,
      pendingAdoption: dash.workState.pendingAdoption,
      yearActuals: dash.workState.yearActuals,
      overspendCount,
    });
  }, [dash, year, version, overspendCount]);

  /**
   * 组织树图:面积 = 预算体量(budgetVolumeCents,一级金额科目绝对值合计的毛量),
   * 颜色 = 完成率。不能用净额当面积:收入成本互抵后大组织会显示成小方块,
   * 净额为零的组织会直接消失。净额仍在 tooltip 里单独展示。
   * 只取预算快照内的组织(unbudgeted=false)建树,未预算承接区另作说明,
   * 否则两套 ID 命名空间混用会产生悬空父节点。
   */
  const orgTreemap = useMemo(() => {
    const rows = (completion?.byOrg ?? []).filter((row) => !row.unbudgeted);
    if (rows.length === 0) return null;
    const build = (parentId: number | null): unknown[] => rows
      .filter((row) => row.parentId === parentId)
      .flatMap((row) => {
        const children = build(row.orgId);
        if (row.budgetVolumeCents === 0 && children.length === 0) return [];
        const node: Record<string, unknown> = { name: row.name, value: row.budgetVolumeCents / 1_000_000, orgId: row.orgId, rate: row.cell.rate, rateSpecial: row.cell.rateSpecial, budgetWan: row.cell.budgetCents / 1_000_000, actualWan: row.cell.actualCents / 1_000_000 };
        if (children.length > 0) node.children = children;
        return [node];
      });
    // 父节点被过滤掉时(预算为 0)把子树挂到更上层,避免整支丢失
    const roots = build(null);
    if (roots.length === 0) return null;
    return { data: roots, count: rows.filter((r) => r.isLeaf).length };
  }, [completion]);

  const treemapOption = useMemo(() => {
    if (!orgTreemap) return {};
    const t = chartTheme(mode);
    /* 颜色 = 进度偏差(完成率−时间进度),与执行节奏象限的 ±20pp 预警口径一致,
       避免年中按绝对完成率分档把所有正常组织都涂成警告色。
       大面积块只铺低饱和底色,靠色相区分状态,避免整版实色刺眼。 */
    const status = statusColor(mode);
    const NEUTRAL = mode === 'dark' ? '#4e5969' : '#c9cdd4';
    const paceColor = (rate: number | null) => {
      if (rate == null) return NEUTRAL;
      if (tp == null) {
        // 无时间进度基准时退回绝对完成率分档
        if (rate < 0.5) return status.bad;
        if (rate < 0.8) return status.warn;
        return status.good;
      }
      const dev = rate - tp;
      if (dev < -0.2) return status.bad;
      if (dev < 0) return status.warn;
      return status.good;
    };
    /* canvas 不解析 CSS 变量,块描边用亮暗成对实色(与 NEUTRAL 同款 mode 三元) */
    const blockBorder = mode === 'dark' ? '#17171a' : '#ffffff';
    const paint = (nodes: Record<string, unknown>[]): Record<string, unknown>[] => nodes.map((node) => {
      const children = node.children as Record<string, unknown>[] | undefined;
      /* 只给叶子铺色:父块若同铺 18%,子块叠在其上会把两层透明度合成 ~33%,
         父子状态不同档时两种语义色直接混出土黄/棕灰,「颜色=进度偏差」编码失真 */
      if (children) return { ...node, itemStyle: { color: 'transparent', borderColor: blockBorder, borderWidth: 1 }, children: paint(children) };
      /* 无数据(NEUTRAL)同样走浅铺,不再用实色压过有数据的告警块 */
      const c = paceColor(node.rate as number | null);
      return { ...node, itemStyle: { color: withAlpha(c, mode === 'dark' ? 0.26 : 0.18), borderColor: blockBorder, borderWidth: 1 } };
    });
    return {
      tooltip: {
        formatter: (p: { name: string; value: number; data: { rate: number | null; rateSpecial: string | null; budgetWan: number; actualWan: number } }) =>
          `${escapeHtml(p.name)}<br/>预算体量 ${p.value.toFixed(2)} 万元<br/>预算净额 ${p.data.budgetWan.toFixed(2)} 万元<br/>实际净额 ${p.data.actualWan.toFixed(2)} 万元<br/>完成率 ${noActual ? '尚无实际批次' : formatRateOrReason(p.data.rate, p.data.rateSpecial)}${p.data.rate != null && tp != null ? `<br/>进度偏差 ${p.data.rate - tp >= 0 ? '+' : ''}${((p.data.rate - tp) * 100).toFixed(1)}pp` : ''}`,
      },
      series: [{
        type: 'treemap',
        roam: false,
        nodeClick: false,
        breadcrumb: { show: false },
        data: paint(orgTreemap.data as Record<string, unknown>[]),
        top: 8,
        bottom: 8,
        left: 8,
        right: 8,
        label: { show: true, formatter: (p: { name: string }) => p.name, fontSize: 12, overflow: 'truncate', color: t.text },
        itemStyle: { gapWidth: 2 },
      }],
    };
  }, [orgTreemap, mode, tp, noActual]);

  const trendOption = useMemo(() => {
    if (!trend) return {};
    const t = chartTheme(mode);
    return {
      tooltip: { trigger: 'axis', axisPointer: { type: 'line', lineStyle: { color: t.colors[0], width: 1, type: 'dashed' } } },
      legend: { data: ['完成率', '时间进度'], top: 4, icon: 'roundRect', itemWidth: 12, itemHeight: 4 },
      grid: { top: 30, left: 50, right: 24, bottom: 28 },
      xAxis: { type: 'category', boundaryGap: false, data: trend.points.map((p) => p.date) },
      yAxis: { type: 'value', axisLabel: { formatter: (v: number) => `${(v * 100).toFixed(0)}%` } },
      series: [
        {
          /* 3.4:月度离散数据不做点间插值,缺失月留空(不虚构中间值) */
          name: '完成率', type: 'line', data: trend.points.map((p) => p.rate), connectNulls: false,
          smooth: false, symbolSize: 7, symbol: 'circle',
          lineStyle: glowLineStyle(t.colors[0]),
          itemStyle: { color: t.colors[0], borderColor: t.tooltipBg, borderWidth: 2 },
          areaStyle: { color: areaGradient(t.colors[0]) },
          label: { show: true, formatter: (d: { value: number | null }) => (d.value == null ? '' : `${(d.value * 100).toFixed(0)}%`) },
        },
        {
          name: '时间进度', type: 'line', data: trend.points.map((p) => p.timeProgress), step: 'end',
          symbol: 'none', lineStyle: { type: 'dashed', width: 1.5, color: t.colors[1] }, itemStyle: { color: t.colors[1] },
        },
      ],
    };
  }, [trend, mode]);

  /* 图表点击 → chart_point 焦点(§8.4):趋势图给期间,treemap 直取节点自带 orgId(组织允许同名,按名反查会指错)。 */
  const assistantRegistry = useOptionalAssistantRegistry();
  const chartFocusTokenRef = useRef<symbol | null>(null);
  const setChartFocus = useCallback((focus: Parameters<NonNullable<typeof assistantRegistry>['setFocus']>[0], label: string) => {
    if (!assistantRegistry) return;
    if (chartFocusTokenRef.current) assistantRegistry.clearFocus(chartFocusTokenRef.current);
    chartFocusTokenRef.current = assistantRegistry.setFocus(focus, label);
  }, [assistantRegistry]);
  useEffect(() => () => {
    if (chartFocusTokenRef.current) assistantRegistry?.clearFocus(chartFocusTokenRef.current);
  }, [assistantRegistry]);
  const handleTrendClick = useCallback((point: ChartSemanticClick) => {
    if (!trend || !point.name || !trend.points.some((item) => item.date === point.name)) return;
    setChartFocus({ kind: 'chart_point', seriesKey: 'trend', dimensionType: 'period', period: point.name }, `执行趋势 · ${point.name}`);
  }, [trend, setChartFocus]);
  const handleTreemapClick = useCallback((point: ChartSemanticClick) => {
    const orgId = Number((point.data as { orgId?: unknown } | undefined)?.orgId);
    if (!Number.isInteger(orgId)) return;
    const name = (completion?.byOrg ?? []).find((item) => item.orgId === orgId)?.name ?? point.name;
    setChartFocus({ kind: 'chart_point', seriesKey: 'treemap', dimensionType: 'org', dimensionId: orgId }, `组织构成 · ${name}`);
  }, [completion, setChartFocus]);

  if (isError) {
    return (
      <div className="bd-page-narrow">
        <QueryErrorResult title="首页工作台数据加载失败" error={dashError} refetch={() => void refetchDash()} />
      </div>
    );
  }

  if (isLoading || !dash) {
    return (
      <div className="bd-page-narrow">
        {/* 首屏骨架:深色带轮廓 + 卡片/表格骨架,替代整屏转圈 */}
        <div className="bd-hero-band" style={{ marginBottom: 16 }}>
          {[0, 1, 2, 3].map((i) => <HeroItem key={i} label="加载中" num={null} sub="" />)}
        </div>
        <Row gutter={[16, 16]}>
          <Col xs={24} lg={12}><Card><CardSkeleton chart /></Card></Col>
          <Col xs={24} lg={12}><Card><CardSkeleton chart /></Card></Col>
          <Col span={24}><Card><TableSkeleton columns={4} rows={5} /></Card></Col>
        </Row>
      </div>
    );
  }

  const structureOk = dash.structure.org.ok && dash.structure.account.ok;
  const yearOptions = dash.currentVersions.map((v) => ({ value: v.year, label: `${v.year} 年 · ${v.name}` }));

  /* 无任何当前生效版本:引导初始化。
     每步标注 已完成/待处理/非当前前提(UX-24):指标、清洗模板、财务数据源
     都不是开始编制的前提,避免首次使用者误以为要全部配完才能动手。
     已有草稿或定稿未采用时,在指引下方直接给出可继续的工作。 */
  if (dash.currentVersions.length === 0) {
    const steps = [
      { icon: <i className="ri-organization-chart" aria-hidden />, title: '建立组织树', desc: `已建 ${dash.counts.orgs} 个组织节点`, path: '/org', done: dash.counts.orgs > 0, optional: false },
      { icon: <i className="ri-node-tree" aria-hidden />, title: '建立科目树', desc: `已建 ${dash.counts.accounts} 个科目节点`, path: '/account', done: dash.counts.accounts > 0, optional: false },
      { icon: <i className="ri-functions" aria-hidden />, title: '配置报表指标', desc: `已配 ${dash.counts.metrics} 个(如毛利);不是开始编制的前提`, path: '/metric', done: dash.counts.metrics > 0, optional: true },
      { icon: <i className="ri-edit-box-line" aria-hidden />, title: '创建预算版本', desc: '编制→记录→定稿→设为当前采用', path: '/budget', done: dash.counts.versions > 0, optional: false },
    ];
    const draft = dash.workState.recentDraft;
    const gaps = dash.workState.pendingAdoption;
    return (
      <div className="bd-page-narrow">
      <Space direction="vertical" size={16} style={{ width: '100%' }}>
        {!structureOk && (
          <Alert
            type="warning"
            showIcon
            icon={<span className="bd-status-icon bd-status-icon-warn"><i className="ri-alert-line" aria-hidden /></span>}
            message="主数据结构检查发现问题"
            description={[...dash.structure.org.problems, ...dash.structure.account.problems].join(';')} />
        )}
        <Card>
          <Typography.Title level={4} style={{ marginTop: 0 }}>欢迎使用年度预算管理系统</Typography.Title>
          <Typography.Paragraph type="secondary">
            尚未设置任何「当前采用」的预算版本。完成必要步骤后,仪表盘将展示年度执行总览;标注「非当前前提」的配置可在需要时再处理。
          </Typography.Paragraph>
          <Row gutter={[16, 16]}>
            {steps.map((s, i) => (
              <Col xs={24} sm={12} lg={6} key={s.title}>
                {/* 幽灵数字承担「第几步」的视觉张力,标题里不再写 "1." 前缀 */}
                <Card size="small" className="quick-tile bd-ghost-host" {...clickableProps(() => navigate(s.path), `${s.title}:${s.desc}`)}
                  styles={{ body: { padding: 18 } }}>
                  <span className="bd-ghost-num" aria-hidden>{i + 1}</span>
                  <Space align="start" size={12}>
                    <span style={{
                      display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                      width: 36, height: 36, borderRadius: 10, fontSize: 18,
                      color: token.colorPrimary, background: token.colorPrimaryBg,
                    }}>{s.icon}</span>
                    <div>
                      <Space size={6}>
                        <Typography.Text strong>{s.title}</Typography.Text>
                        {s.done
                          ? <Tag color="green" style={{ marginInlineEnd: 0 }}>已完成</Tag>
                          : s.optional
                            ? <Tag style={{ marginInlineEnd: 0 }}>非当前前提</Tag>
                            : <Tag color="orange" style={{ marginInlineEnd: 0 }}>待处理</Tag>}
                      </Space>
                      <div><Typography.Text type="secondary" style={{ fontSize: 12 }}>{s.desc}</Typography.Text></div>
                    </div>
                  </Space>
                </Card>
              </Col>
            ))}
          </Row>
        </Card>
        {(draft || gaps.length > 0) && (
          <Card size="small" title="当前可以继续的工作">
            <Row gutter={[12, 12]}>
              {draft && (
                <Col xs={24} sm={gaps.length > 0 ? 12 : 24}>
                  <Card size="small" className="quick-tile" {...clickableProps(() => navigate(`/budget/${draft.id}`), `继续编制${draft.name}`)} styles={{ body: { padding: 16 } }}>
                    <Space>
                      <span style={{
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        width: 32, height: 32, borderRadius: 8, color: token.colorPrimary, background: token.colorPrimaryBg,
                      }}><i className="ri-edit-box-line" aria-hidden /></span>
                      <div>
                        <div style={{ fontWeight: 600 }}>继续编制「{draft.name}」</div>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          {draft.year} 年{draft.kind === 'forecast' ? '预测' : '预算'}草稿 · 最近更新 {draft.updated_at.slice(0, 16).replace('T', ' ')}
                        </Typography.Text>
                      </div>
                    </Space>
                  </Card>
                </Col>
              )}
              {gaps.map((gap) => (
                <Col xs={24} sm={12} key={`${gap.year}-${gap.kind}`}>
                  <Card size="small" className="quick-tile" {...clickableProps(() => navigate(`/budget?year=${gap.year}`), `选择${gap.year}年当前采用版本`)} styles={{ body: { padding: 16 } }}>
                    <Space>
                      <span style={{
                        display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                        width: 32, height: 32, borderRadius: 8, color: token.colorWarning, background: token.colorWarningBg,
                      }}><i className="ri-flag-line" aria-hidden /></span>
                      <div>
                        <div style={{ fontWeight: 600 }}>选择 {gap.year} 年{gap.kind === 'forecast' ? '预测' : '预算'}的当前采用版本</div>
                        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                          已有 {gap.lockedCount} 个定稿版本{gap.latestLockedName ? `(最新「${gap.latestLockedName}」)` : ''},尚未设为当前采用
                        </Typography.Text>
                      </div>
                    </Space>
                  </Card>
                </Col>
              ))}
            </Row>
          </Card>
        )}
      </Space>
      </div>
    );
  }

  return (
    <div className="bd-page-narrow">
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {scopeIssues.length > 0 && (
        <Alert
          type="warning"
          showIcon
          closable
          onClose={() => setScopeIssues([])}
          message="链接中的范围参数已忽略"
          description={scopeIssues.map((issue) => issue.detail).join('；')}
        />
      )}
      {/* 深色 KPI 概览带:年度预算总额 / 当前执行率(带迷你走势线) / 进度偏差 / 异常预警 */}
      {(() => {
        const incomeRate = overallRate(totals.income.b, totals.income.a);
        const deviation = !noActual && incomeRate != null && tp != null ? incomeRate - tp : null;
        return (
          <div className="bd-hero-band">
            {/* 图注位:主数据结构检查通过时以 ok 档状态圆图标常驻,与告警 Alert 互斥 */}
            {structureOk && (
              <Tooltip title="组织与科目结构检查均通过">
                <span className="bd-hero-note" data-testid="structure-ok-note">
                  <span className="bd-status-icon bd-status-icon-ok bd-hero-note-icon"><i className="ri-check-line" aria-hidden /></span>
                  主数据结构检查通过
                </span>
              </Tooltip>
            )}
            <HeroItem
              label={`年度预算总额 · ${year ?? ''} 收入`}
              num={completion ? <MoneyText cents={totals.income.b} format="compact" size="lg" style={{ fontSize: 36 }} /> : null}
              sub={version ? `${version.name} · 单位 万元` : '版本加载中'}
            />
            <HeroItem
              label="当前执行率"
              num={completion ? (noActual ? '待录入' : formatRate(incomeRate)) : null}
              sub={completion?.asOfDate ? `收入完成率 · 实际截至 ${completion.asOfDate}` : '收入完成率'}
              /* 走势线与下方「执行趋势」大图同一 rate 序列(同源同形);数据不足 2 点自动隐藏 */
              spark={trend?.points.map((p) => p.rate)}
            />
            <HeroItem
              label="进度偏差"
              num={completion ? (deviation != null ? `${deviation >= 0 ? '+' : ''}${(deviation * 100).toFixed(1)}pp` : '—') : null}
              sub={deviation == null ? '收入完成率 − 时间进度' : deviation >= 0 ? '收入进度快于时间进度' : '收入进度慢于时间进度'}
              tone={deviation != null && deviation < 0 ? 'warn' : undefined}
            />
            <HeroItem
              label="异常预警"
              num={completion ? `${overspendCount}` : null}
              sub="个成本费用科目累计超全年预算"
              /* 超支是入口不是读数:整块可点进执行分析页的「成本费用超支预警」表,
                 取代原先同屏的 error Alert 与「N 个科目超支」快捷卡片。 */
              onClick={overspendCount > 0 ? () => navigate(analysisPath()) : undefined}
              actionHint={overspendCount > 0 ? '查看超支科目' : undefined}
              tone={overspendCount > 0 ? 'bad' : undefined}
            />
          </div>
        );
      })()}

      {/* 月度执行覆盖:深色带正下方的状态矩阵,跟随当前选中年度重算 */}
      <MonthCoverageCard
        year={year ?? new Date().getFullYear()}
        frozen={yearState === 'frozen'}
        batches={monthBatches}
        loading={monthBatchesLoading || year == null}
      />

      {/* 页头:年度切换与数据口径 */}
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', flexWrap: 'wrap', gap: 12 }}>
        <Space size={10} wrap>
          <Select value={year} onChange={setYear} options={yearOptions} style={{ width: 260 }} />
          {yearState && (yearState === 'frozen' ? <Tag color="blue">年度已冻结</Tag> : <Tag color="green">年度开放</Tag>)}
          {completion?.asOfDate
            ? <Tag color="geekblue">实际数据截至 {completion.asOfDate}</Tag>
            : completion ? <Tag color="orange">本年尚无实际数据</Tag> : <Tag>实际数据加载中</Tag>}
        {/* 主数据规模与口径公式都不是每次都要读的信息:
            规模收进 Tooltip(悬停可见),公式收进「口径」链接,首屏只留年度与状态。 */}
        <Tooltip title={`组织 ${dash.counts.orgs} · 科目 ${dash.counts.accounts} · 指标 ${dash.counts.metrics} · 版本 ${dash.counts.versions} · 快照批次 ${dash.counts.batches}`}>
          <Typography.Text type="secondary" style={{ fontSize: 12, cursor: 'help', borderBottom: '1px dashed var(--bd-border)' }}>
            主数据
          </Typography.Text>
        </Tooltip>
        </Space>
        <Tooltip title={`完成率 = 累计实际 / 年度预算;节奏差 = 完成率 − 时间进度(当前 ${formatProgress(tp)})`}>
          <Typography.Text type="secondary" style={{ fontSize: 12, cursor: 'help', borderBottom: '1px dashed var(--bd-border)' }}>
            口径
          </Typography.Text>
        </Tooltip>
      </div>

      {!structureOk && (
        <Alert
          type="warning"
          showIcon
          icon={<span className="bd-status-icon bd-status-icon-warn"><i className="ri-alert-line" aria-hidden /></span>}
          message="主数据结构检查发现问题"
          description={[...dash.structure.org.problems, ...dash.structure.account.problems].join(';')} />
      )}

      {/* 超支数在下方 hero 带「异常预警」里已给出,且那块可直接点击进入执行分析;
          这里不再重复一条 error Alert —— 同一结论同屏出现三次会互相稀释注意力。 */}

      {(() => {
        /**
         * 音量守恒(《视觉高级感提升方案》一.5):页面级大数字一律墨色(--bd-text),
         * 主色只留给小面积「签」。因此下表不再携带 color 字段 —— .kpi-value 的
         * 类定义即 var(--bd-text),删掉内联 color 后自动生效。
         */
        const metricOpts = [...(completion?.metrics ?? [])].sort((a, b) => a.code.localeCompare(b.code)).map((m) => ({
          value: `m:${m.metricId}`, label: m.name, b: m.cell.budgetCents, a: m.cell.actualCents,
          invert: m.displaySign === -1, unfavorableWhenFast: m.displaySign === -1,
          rate: m.cell.rate, rateSpecial: m.cell.rateSpecial,
        }));
        const options = [
          { value: 'net', label: '利润净额', b: totals.net.b, a: totals.net.a, invert: false, unfavorableWhenFast: false, rate: overallRate(totals.net.b, totals.net.a), rateSpecial: null as string | null },
          { value: 'income', label: '收入', b: totals.income.b, a: totals.income.a, invert: false, unfavorableWhenFast: false, rate: overallRate(totals.income.b, totals.income.a), rateSpecial: null },
          { value: 'cost', label: '成本', b: totals.cost.b, a: totals.cost.a, invert: true, unfavorableWhenFast: true, rate: overallRate(-totals.cost.b, -totals.cost.a), rateSpecial: null },
          { value: 'expense', label: '费用', b: totals.expense.b, a: totals.expense.a, invert: true, unfavorableWhenFast: true, rate: overallRate(-totals.expense.b, -totals.expense.a), rateSpecial: null },
          ...metricOpts,
        ];
        const current = options.find((o) => o.value === hero) ?? options[0];
        const disp = current.invert ? -current.a : current.a;
        const budgetDisp = current.invert ? -current.b : current.b;
        /* 下一步入口由 buildNextActions 按后台事实生成(见组件内 nextActions);
           一切就绪时回落到「打开当前预算 / 从财务系统转换」等稳定入口。 */
        const actionSpan = nextActions.length >= 4 ? { xs: 24, sm: 12, lg: 6 } : { xs: 24, sm: 8 };
        return (
          <>
            <div>
              <div className="bd-eyebrow">02 / 本年主数字</div>
              <Card styles={{ body: { padding: '28px 32px' } }}>
                <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', flexWrap: 'wrap', gap: 8, marginBottom: 8 }}>
                  <span className="bd-metric-label">本年主数字 · {current.label}</span>
                  <div style={{ minWidth: 0, maxWidth: '100%', overflowX: 'auto', WebkitOverflowScrolling: 'touch', paddingBottom: 2 }}>
                    <Segmented size="small" value={current.value} onChange={(v) => setHero(String(v))} options={options.map((o) => ({ value: o.value, label: o.label }))} />
                  </div>
                </div>
                <div className="kpi-value kpi-hero">
                  {noActual
                    ? <Typography.Text type="secondary" style={{ fontSize: 24 }}>待录入</Typography.Text>
                    : <Tooltip title={`精确值:${centsToYuan(disp)} 元`}><MoneyText cents={disp} format="compact" size="lg" /></Tooltip>}
                </div>
                <Space wrap style={{ marginTop: 8 }}>
                  <Typography.Text type="secondary">年度预算 <MoneyText cents={budgetDisp} format="compact" size="sm" /></Typography.Text>
                  <Tag>完成率 {noActual ? '—' : formatRateOrReason(current.rate, current.rateSpecial)}</Tag>
                  {!noActual && current.rate != null && current.rateSpecial && <Tooltip title={RATE_SPECIAL_TEXT[current.rateSpecial] ?? '特殊口径,完成率不可比'}><Tag color="orange">注意</Tag></Tooltip>}
                  <Tag>时间进度 {formatProgress(tp)}</Tag>
                  <PaceTag rate={noActual ? null : current.rate} timeProgress={tp} unfavorableWhenFast={current.unfavorableWhenFast} />
                  {current.value.startsWith('m:') && version && (
                    <Button size="small" icon={<i className="ri-flow-chart" aria-hidden />} onClick={() => setEvidenceTarget({
                      type: 'metric',
                      versionId: version.id,
                      metricId: Number(current.value.slice(2)),
                    })}>看数字来源</Button>
                  )}
                </Space>
                <Typography.Paragraph style={{ margin: '10px 0 0' }}>
                  {paceSentence(current.label, noActual ? null : current.rate, tp, current.unfavorableWhenFast)}
                </Typography.Paragraph>
              </Card>
            </div>
            <Row gutter={[8, 8]}>
              {options.filter((o) => o.value !== current.value).slice(0, 3).map((o) => (
                <Col xs={24} sm={8} key={o.value}>
                  <Card size="small" hoverable className="quick-tile" onClick={() => setHero(o.value)}>
                    <span className="bd-metric-label">{o.label}</span>
                    <div className="kpi-value" style={{ fontSize: 24, marginTop: 4 }}>
                      {noActual ? '—' : <MoneyText cents={o.invert ? -o.a : o.a} format="compact" size="lg" />}
                    </div>
                  </Card>
                </Col>
              ))}
            </Row>
            <Row gutter={[12, 12]}>
              <Col xs={24} lg={12}>
                <div className="bd-eyebrow">03 / 执行趋势</div>
                <Card size="small" title={`${year} 年完成率 vs 时间进度`} extra={<Button size="small" type="link" onClick={() => navigate(analysisPath())}>年度执行分析</Button>}>
                  {trend && trend.points.length > 0
                    ? <EChart option={trendOption} height={320} onSemanticClick={handleTrendClick} />
                    : <BdEmpty kind="data" description="暂无实际快照，请先录入实际数" style={{ padding: '48px 0' }} />}
                </Card>
              </Col>
              <Col xs={24} lg={12}>
                <div className="bd-eyebrow">04 / 组织构成</div>
                <Card
                  size="small"
                  title="组织预算体量分布"
                  extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>面积＝预算体量（一级科目绝对值合计），颜色＝进度偏差（完成率−时间进度）</Typography.Text>}
                >
                  {orgTreemap
                    ? <EChart option={treemapOption} height={320} onSemanticClick={handleTreemapClick} />
                    : <BdEmpty kind="data" description="暂无组织预算数据" style={{ padding: '48px 0' }} />}
                </Card>
              </Col>
            </Row>
            <div>
              <div className="bd-eyebrow">05 / 下一步</div>
              <Row gutter={[12, 12]} style={{ marginBottom: 16 }}>
                {nextActions.map((s) => (
                  <Col {...actionSpan} key={s.key}>
                    <Card size="small" className="quick-tile" {...clickableProps(() => navigate(s.path), `${s.title}:${s.desc}`)} styles={{ body: { padding: 16 } }}>
                      <Space>
                        <span style={{
                          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                          width: 32, height: 32, borderRadius: 8,
                          color: s.tone === 'bad' ? token.colorError : s.tone === 'warn' ? token.colorWarning : token.colorPrimary,
                          background: s.tone === 'bad' ? token.colorErrorBg : s.tone === 'warn' ? token.colorWarningBg : token.colorPrimaryBg,
                        }}><i className={s.icon} aria-hidden /></span>
                        <div>
                          <div style={{ fontWeight: 600 }}>{s.title}</div>
                          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{s.desc}</Typography.Text>
                        </div>
                      </Space>
                    </Card>
                  </Col>
                ))}
              </Row>
            </div>
          </>
        );
      })()}

      {/* UX-25 最近访问:入口含当时的白名单筛选范围;目标失效由目标页说明并要求重选(恢复只是导航) */}
      {prefs.recents.length > 0 && (
        <div>
          <div className="bd-eyebrow">06 / 最近访问</div>
          <Card size="small" title="最近访问" extra={<Typography.Text type="secondary" style={{ fontSize: 12 }}>记录入口与当时范围,最多 {MAX_RECENTS} 条</Typography.Text>}>
            {prefs.recents.slice(0, 6).map((item) => (
              <div className="bd-log-row" key={`${item.pageKey}:${item.path}`}>
                <div className="bd-log-row-main">
                  <Typography.Text ellipsis style={{ minWidth: 0 }} title={item.label}>{item.label}</Typography.Text>
                </div>
                <div className="bd-log-row-meta">
                  <span>{relativeTime(new Date(item.visitedAt).toISOString())}</span>
                  <Link to={item.path}>打开 →</Link>
                </div>
              </div>
            ))}
          </Card>
        </div>
      )}

      {/* 年度版本与最近操作 */}
      <Row gutter={[16, 16]}>
        <Col xs={24} lg={12}>
          <div className="bd-eyebrow">07 / 年度版本</div>
          <Card size="small" title="各年度当前生效预算版本" extra={<Button size="small" type="link" onClick={() => navigate('/budget')}>版本管理</Button>}>
            <Table
              size="small" rowKey="id" pagination={false} dataSource={dash.currentVersions}
              columns={[
                { title: '年度', dataIndex: 'year', width: 80 },
                { title: '当前生效版本', dataIndex: 'name' },
                {
                  title: '年度状态', dataIndex: 'status', width: 110,
                  render: (_, r) => {
                    const st = dash.years.find((y) => y.year === r.year)?.status ?? 'open';
                    return st === 'frozen' ? <Tag color="blue">已冻结</Tag> : <Tag color="green">开放</Tag>;
                  },
                },
                {
                  title: '操作', width: 130,
                  render: (_, r) => (
                    <Space size={4}>
                      <Button size="small" type="link" style={{ paddingInline: 4 }} onClick={() => navigate(`/budget/${r.id}`)}>编制</Button>
                      <Button size="small" type="link" style={{ paddingInline: 4 }} onClick={() => navigate(buildScopedPath('/analysis', { year: r.year ?? year, budgetVersionId: r.id }))}>分析</Button>
                    </Space>
                  ),
                },
              ]}
            />
          </Card>
        </Col>
        <Col xs={24} lg={12}>
          <div className="bd-eyebrow">08 / 最近操作</div>
          <Card size="small" title="最近操作" extra={<Button size="small" type="link" onClick={() => navigate('/data?tab=logs')}>全部日志</Button>}>
            {/* 紧凑日志行:发丝线分隔,主行=操作标签+实体名,meta 行=时间+入口链接。
                数据管理页的全量日志仍是表格,不动。 */}
            {dash.recentLogs.slice(0, 5).map((log) => {
              const entityName = logEntityName(log.detail_json);
              const entityLabel = ENTITY_TYPE_LABEL[log.entity_type] ?? log.entity_type;
              const entryPath = ENTITY_PATH[log.entity_type];
              const actionText = ACTION_LABEL[log.action] ?? log.action;
              // 实体名为空且实体标签与操作相同时(如登录),主行回落展示系统事件,避免一行三个「登录」重复
              const mainTitle = entityName || (entityLabel !== actionText ? entityLabel : '系统会话');
              return (
                <div className="bd-log-row" key={log.id}>
                  <div className="bd-log-row-main">
                    <Tag bordered={false} style={{ flex: '0 0 auto' }}>{actionText}</Tag>
                    <Typography.Text ellipsis style={{ minWidth: 0 }} title={mainTitle}>
                      {mainTitle}
                    </Typography.Text>
                  </div>
                  <div className="bd-log-row-meta">
                    <span>{log.created_at.slice(0, 19).replace('T', ' ')}</span>
                    {entryPath
                      ? <Link to={entryPath}>{entityLabel} →</Link>
                      : <span>{entityLabel}</span>}
                  </div>
                </div>
              );
            })}
          </Card>
        </Col>
      </Row>
      <EvidenceDrawer target={evidenceTarget} onTargetChange={setEvidenceTarget} />
    </Space>
    </div>
  );
}
