import { useEffect, useMemo, useRef, useState } from 'react';
import { createBrowserRouter, RouterProvider, Outlet, useLocation, useNavigate, useNavigationType, Navigate, Link } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { Layout, Menu, Typography, Button, theme, Dropdown, Avatar, Spin, Space, App as AntdApp, Tooltip } from 'antd';
import type { MenuProps } from 'antd';
import dayjs from 'dayjs';
import 'dayjs/locale/zh-cn';
import { useThemeMode, SIDER_INSET, SIDER_MENU_MARGIN } from './theme';
import { api, can, getSession, setSession, AUTH_EXPIRED_EVENT, PASSWORD_CHANGE_EVENT, DOWNLOAD_FEEDBACK_EVENT, type DownloadFeedbackDetail, type SessionInfo } from './api/client';
import { assistantApi } from './api/assistant';
import { relativeTime } from './utils/relativeTime';
import { AssistantProvider } from './assistant/AssistantProvider';
import { AssistantDock } from './components/assistant/AssistantDock';
import { BrandLogo } from './components/BrandLogo';
import { HeaderSearch } from './components/HeaderSearch';
import { derivePageContext } from './assistant/pageContext';
import { isPageKey } from './assistant/context';
import { UserPrefsProvider, useUserPrefs } from './hooks/useUserPrefs';
import { entryPathFor, prefsNamespaceFor, MAX_FAVORITES } from './utils/userPrefs';
import Login from './pages/Login';
import ChangePassword from './pages/ChangePassword';
import { Suspense } from 'react';
import { lazyWithRetry } from './utils/lazyWithRetry';
import { useRouteScrollMemory } from './hooks/useRouteScrollMemory';
const Dashboard = lazyWithRetry(() => import('./pages/Dashboard'));
const OrgManage = lazyWithRetry(() => import('./pages/OrgManage'));
const AccountManage = lazyWithRetry(() => import('./pages/AccountManage'));
const MetricManage = lazyWithRetry(() => import('./pages/MetricManage'));
const BudgetVersions = lazyWithRetry(() => import('./pages/BudgetVersions'));
const BudgetEdit = lazyWithRetry(() => import('./pages/BudgetEdit'));
const ActualMaintain = lazyWithRetry(() => import('./pages/ActualMaintain'));
const Analysis = lazyWithRetry(() => import('./pages/Analysis'));
const Structure = lazyWithRetry(() => import('./pages/Structure'));
const History = lazyWithRetry(() => import('./pages/History'));
const VersionCompare = lazyWithRetry(() => import('./pages/VersionCompare'));
const DataManage = lazyWithRetry(() => import('./pages/DataManage'));
const FinanceImport = lazyWithRetry(() => import('./pages/FinanceImport'));
const Assistant = lazyWithRetry(() => import('./pages/Assistant'));
const Insights = lazyWithRetry(() => import('./pages/Insights'));
const MasterDataHealthPage = lazyWithRetry(() => import('./pages/MasterDataHealthPage'));
const CleaningConfig = lazyWithRetry(() => import('./pages/CleaningConfig'));
const BudgetProgress = lazyWithRetry(() => import('./pages/BudgetProgress'));
const AnomalyCenter = lazyWithRetry(() => import('./pages/AnomalyCenter'));
const MetricTrend = lazyWithRetry(() => import('./pages/MetricTrend'));
const SettingsAi = lazyWithRetry(() => import('./pages/SettingsAi'));
const SecurityAdmin = lazyWithRetry(() => import('./pages/SecurityAdmin'));
const SettingsBusiness = lazyWithRetry(() => import('./pages/SettingsBusiness'));
const MasterEntities = lazyWithRetry(() => import('./pages/MasterEntities'));
const JobsCenter = lazyWithRetry(() => import('./pages/JobsCenter'));
const EasWorkspace = lazyWithRetry(() => import('./pages/financeData/EasWorkspace'));
const Governance = lazyWithRetry(() => import('./pages/financeData/Governance'));
const Statements = lazyWithRetry(() => import('./pages/financeData/Statements'));
const ManagementAccounting = lazyWithRetry(() => import('./pages/ManagementAccounting'));
const StandardReports = lazyWithRetry(() => import('./pages/StandardReports'));
const ProjectBudget = lazyWithRetry(() => import('./pages/project/ProjectBudget'));
const PlanExecution = lazyWithRetry(() => import('./pages/project/PlanExecution'));
const Contracts = lazyWithRetry(() => import('./pages/project/Contracts'));
const ProjectProfile = lazyWithRetry(() => import('./pages/project/ProjectProfile'));
const ContractImport = lazyWithRetry(() => import('./pages/project/ContractImport'));
const ExpenseClaims = lazyWithRetry(() => import('./pages/expense/ExpenseClaims'));
const ExpensePolicies = lazyWithRetry(() => import('./pages/expense/ExpensePolicies'));
const Feasibility = lazyWithRetry(() => import('./pages/invest/Feasibility'));
const InvestmentControl = lazyWithRetry(() => import('./pages/invest/InvestmentControl'));
const Forecast = lazyWithRetry(() => import('./pages/invest/Forecast'));
const RiskLedger = lazyWithRetry(() => import('./pages/risk/RiskLedger'));
const AnalysisReports = lazyWithRetry(() => import('./pages/risk/AnalysisReports'));
const Search = lazyWithRetry(() => import('./pages/Search'));

const { Sider, Header, Content, Footer } = Layout;

const DEFAULT_OPEN = ['grp-plan', 'grp-actual', 'grp-analysis', 'grp-fav'];

/**
 * 侧栏菜单(范式 A:图标只留一级)。
 * 二级菜单项不带 icon:antd inline 菜单会把二级图标画在文字前,一级、二级各占
 * 一列图标,三组同展开时左缘锯齿;二级纯文字缩进后与一级「文字」对齐,形成
 * 「一条图标列 + 一条文字列」。折叠成图标栏时子菜单走浮层,纯文字子项不受影响。
 * 分组结构、路由与 dataMenuKey 逻辑保持不变(本方案只做对齐,不再分组)。
 */
export const menuItems: MenuProps['items'] = [
  { key: '/', icon: <i className="ri-dashboard-line" aria-hidden />, label: '首页' },
  {
    key: 'grp-ai',
    /* AI 相关图标单独用紫色系,与主色可点击项区分开(方案《AI助手体验升级与界面格调提升方案》) */
    icon: <i className="ri-robot-2-line bd-icon-ai" aria-hidden />,
    label: '小澧助手',
    children: [
      /* 子项避免与组名重名:组名「小澧助手」+子项同名在面包屑/标题里无法区分 */
      { key: '/assistant', label: '对话' },
      { key: '/insights', label: '洞察报告' },
    ],
  },
  {
    key: 'grp-plan',
    icon: <i className="ri-edit-box-line" aria-hidden />,
    label: '编制',
    /* 「测算模板」已从侧栏移除:它是预算编制的前置配置,入口收进「预算与预测」页。
       路由 /data?tab=calculations 保留,书签与页内跳转仍然有效。 */
    children: [
      { key: '/budget', label: '预算与预测' },
      { key: '/progress', label: '进度总览' },
    ],
  },
  {
    key: 'grp-actual',
    icon: <i className="ri-database-2-line" aria-hidden />,
    label: '实际',
    /* 「导入批次」曾因与录入页强耦合收进「实际录入与快照」页的「更多」菜单,
       现恢复为独立侧栏入口;录入页「更多」菜单入口保留。 */
    children: [
      { key: '/actual', label: '实际录入与快照' },
      { key: '/data?tab=imports', label: '导入批次' },
      { key: '/cleaning-config', label: '清洗模板与别名' },
      { key: '/finance', label: '财务系统转换' },
    ],
  },
  {
    key: 'grp-analysis',
    icon: <i className="ri-bar-chart-2-line" aria-hidden />,
    label: '分析',
    children: [
      { key: '/analysis', label: '年度执行分析' },
      { key: '/alerts', label: '预警中心' },
      { key: '/structure', label: '结构占比' },
      { key: '/metric-trend', label: '指标趋势' },
      { key: '/history', label: '历年对比' },
      { key: '/compare', label: '版本对比' },
    ],
  },
  {
    key: 'grp-finance',
    icon: <i className="ri-bank-line" aria-hidden />,
    label: '财务数据',
    /* T-3(AC-F05/F06/F10):EAS 原始事实、数据治理与财务报表;与预算实际数(「实际」组)是两条事实链。 */
    children: [
      { key: '/eas', label: 'EAS 工作区' },
      { key: '/governance', label: '数据治理' },
      { key: '/statements', label: '财务报表' },
    ],
  },
  {
    key: 'grp-project',
    icon: <i className="ri-building-2-line" aria-hidden />,
    label: '项目与合同',
    /* T-4(AC-F09/F15/F16/F04):项目预算与计划执行是项目口径事实,与经营预算(「编制」组)互不读写。 */
    children: [
      { key: '/project-budget', label: '项目预算' },
      { key: '/plan', label: '计划执行' },
      { key: '/contracts', label: '合同台账' },
      { key: '/contracts/import', label: '合同导入' },
    ],
  },
  {
    key: 'grp-expense',
    icon: <i className="ri-receipt-line" aria-hidden />,
    label: '费用审核',
    children: [
      { key: '/expense', label: '报销单' },
      { key: '/expense/policies', label: '制度依据' },
    ],
  },
  {
    key: 'grp-invest',
    icon: <i className="ri-line-chart-line" aria-hidden />,
    label: '投资与预测',
    children: [
      { key: '/feasibility', label: '可行性测算' },
      { key: '/investment-control', label: '投资控制' },
      { key: '/forecast', label: '财务预测' },
    ],
  },
  {
    key: 'grp-risk',
    icon: <i className="ri-shield-check-line" aria-hidden />,
    label: '风险与报告',
    children: [
      { key: '/risk', label: '风险台账' },
      { key: '/analysis-reports', label: '分析报告' },
    ],
  },
  { key: '/mgmt', icon: <i className="ri-scales-3-line" aria-hidden />, label: '管理会计' },
  { key: '/standard-reports', icon: <i className="ri-file-list-3-line" aria-hidden />, label: '标准报表' },
  {
    key: 'grp-master',
    icon: <i className="ri-organization-chart" aria-hidden />,
    label: '主数据',
    children: [
      { key: '/org', label: '组织' },
      { key: '/account', label: '科目' },
      { key: '/metric', label: '指标' },
      { key: '/master-entities', label: '项目·供应商·映射' },
      { key: '/master-health', label: '健康体检' },
    ],
  },
  {
    key: 'grp-system',
    icon: <i className="ri-settings-3-line" aria-hidden />,
    label: '系统',
    children: [
      { key: '/data?tab=check', label: '一致性检查' },
      { key: '/data?tab=yearclose', label: '年度关闭' },
      { key: '/data?tab=backup', label: '备份与迁移' },
      { key: '/data?tab=logs', label: '操作日志' },
      { key: '/jobs', label: '任务中心' },
      { key: '/settings/business', label: '业务设置' },
      { key: '/settings/ai', label: 'AI 渠道设置' },
      { key: '/settings/security', label: '用户与权限' },
    ],
  },
];

/**
 * 侧栏入口所需权限:无权限的入口不显示(只是体验优化,后端仍逐请求校验)。
 * 未登记的键(任务中心、助手会话项等)对所有已登录用户可见。
 */
export const MENU_PERMISSION: Record<string, string> = {
  '/': 'dashboard:read',
  '/assistant': 'assistant:use',
  '/insights': 'assistant:use',
  '/budget': 'budget:read',
  '/progress': 'budget:read',
  '/actual': 'actual:read',
  '/data?tab=imports': 'import:run',
  '/cleaning-config': 'import:run',
  '/finance': 'finance_import:manage',
  '/analysis': 'analysis:read',
  '/alerts': 'analysis:read',
  '/structure': 'analysis:read',
  '/metric-trend': 'analysis:read',
  '/history': 'analysis:read',
  '/compare': 'analysis:read',
  '/eas': 'eas:read',
  '/governance': 'governance:read',
  '/statements': 'statements:read',
  '/project-budget': 'project_budget:read',
  '/plan': 'plan:read',
  '/contracts': 'contract:read',
  '/contracts/import': 'contract:import',
  '/expense': 'expense:read',
  '/expense/policies': 'expense:read',
  '/feasibility': 'investment:read',
  '/investment-control': 'investment:read',
  '/forecast': 'forecast:read',
  '/risk': 'risk:read',
  '/analysis-reports': 'report:read',
  '/mgmt': 'mgmt:read',
  '/standard-reports': 'report:read',
  '/org': 'master:read',
  '/account': 'master:read',
  '/metric': 'master:read',
  '/master-entities': 'master:read',
  '/master-health': 'master:read',
  '/data?tab=check': 'master:read',
  '/data?tab=yearclose': 'actual:finalize',
  '/data?tab=backup': 'system:backup',
  '/data?tab=logs': 'audit:read',
  '/settings/business': 'settings:read',
  '/settings/ai': 'settings:read',
  '/settings/security': 'security:manage',
};

/**
 * 集团口径页面:主体数据是整版矩阵、全组织对比或系统级检查,后端对只授权部分组织的
 * 账号返回 SCOPE_RESTRICTED(AC-X04)。对这类账号直接不展示入口,而不是点进去才报错。
 * 执行分析、结构、趋势、预警与工作台按授权范围裁剪,照常展示。
 */
export const MENU_ALL_ORGS = new Set([
  '/budget', '/progress', '/actual', '/data?tab=imports', '/cleaning-config', '/finance',
  '/history', '/compare', '/master-health', '/data?tab=check', '/data?tab=yearclose', '/data?tab=backup',
]);

/** 按权限裁剪菜单:去掉无权限的叶子,子项全被裁掉的分组一并去掉;受限范围账号再去掉集团口径入口。 */
export function filterMenuByPermission(items: MenuProps['items'], has: (permission: string) => boolean, allOrgs = true): MenuProps['items'] {
  const out: NonNullable<MenuProps['items']> = [];
  for (const item of items ?? []) {
    if (!item) continue;
    if ('children' in item && item.children) {
      const children = filterMenuByPermission(item.children, has, allOrgs) ?? [];
      if (children.length) out.push({ ...item, children });
      continue;
    }
    const key = 'key' in item && typeof item.key === 'string' ? item.key : '';
    const need = MENU_PERMISSION[key];
    if (!allOrgs && MENU_ALL_ORGS.has(key)) continue;
    if (!need || has(need)) out.push(item);
  }
  return out;
}

function leafLabel(key: string): string {
  const walk = (nodes?: MenuProps['items']): string | undefined => {
    for (const n of nodes ?? []) {
      if (!n || !('key' in n)) continue;
      if (n.key === key && 'label' in n) return String(n.label);
      if ('children' in n && n.children) {
        const hit = walk(n.children as MenuProps['items']);
        if (hit) return hit;
      }
    }
    return undefined;
  };
  return walk(menuItems) ?? '';
}

export function pageTitle(pathname: string, search: string, selected: string): string {
  if (pathname === '/search') return '跨域检索';
  if (pathname.startsWith('/projects/')) return '项目档案';
  if (pathname.split('/')[1] === 'data') {
    const tab = new URLSearchParams(search).get('tab');
    if (tab === 'calculations') return '测算模板';
    if (tab === 'imports') return '导入批次';
    if (tab === 'check') return '一致性检查';
  }
  return leafLabel(selected);
}

function groupOf(key: string): string | undefined {
  if (key === '/assistant' || key === '/insights' || key.startsWith('ai-')) return 'grp-ai';
  for (const n of menuItems ?? []) {
    if (!n || !('children' in n) || !n.children) continue;
    const hit = (n.children as { key?: string }[]).some((c) => c.key === key);
    if (hit && typeof n.key === 'string') return n.key;
  }
  return undefined;
}

/**
 * /data 子页归并到侧栏对应入口。
 *
 * 注意 calculations 的情况:它已从侧栏移除,入口收进了宿主页(测算模板 → 预算与预测),
 * 所以这里返回的必须是宿主页的 key,否则侧栏会拿一个不存在的 key 去匹配,
 * 结果整条侧栏没有任何高亮。/data?tab=... 仍然可用 —— 只是不再作为侧栏的一项出现。
 * 「导入批次」与「一致性检查」已恢复为独立侧栏入口,这里返回其自身的 key。
 */
export function dataMenuKey(tab: string | null): string {
  if (tab === 'calculations') return '/budget';
  if (tab === 'imports') return '/data?tab=imports';
  if (tab === 'check') return '/data?tab=check';
  if (tab === 'yearclose') return '/data?tab=yearclose';
  if (tab === 'logs') return '/data?tab=logs';
  return '/data?tab=backup';
}

export function selectedKey(pathname: string, search: string): string {
  const seg = '/' + (pathname.split('/')[1] ?? '');
  if (seg === '/' || seg === '') return '/';
  if (seg === '/budget') return '/budget';
  if (seg === '/settings') {
    if (pathname.startsWith('/settings/ai')) return '/settings/ai';
    if (pathname.startsWith('/settings/security')) return '/settings/security';
    if (pathname.startsWith('/settings/business')) return '/settings/business';
    return '/';
  }
  if (seg === '/data') return dataMenuKey(new URLSearchParams(search).get('tab'));
  if (seg === '/projects') return '/master-entities'; // 项目档案归属主数据菜单
  if (pathname.startsWith('/contracts/import')) return '/contracts/import';
  if (pathname.startsWith('/expense/policies')) return '/expense/policies';
  const leaves = ['/org', '/account', '/metric', '/actual', '/finance', '/analysis', '/structure', '/history', '/compare', '/assistant', '/insights', '/master-health', '/cleaning-config', '/progress', '/alerts', '/metric-trend', '/master-entities', '/jobs', '/eas', '/governance', '/statements', '/mgmt', '/standard-reports', '/project-budget', '/plan', '/contracts', '/expense', '/feasibility', '/investment-control', '/forecast', '/risk', '/analysis-reports'];
  return leaves.includes(seg) ? seg : '/';
}

function Brand({ collapsed }: { collapsed: boolean }) {
  const { token } = theme.useToken();
  return (
    <div
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 10,
        height: 54,
        flexShrink: 0,
        padding: collapsed ? 0 : `0 ${SIDER_INSET}px`,
        justifyContent: collapsed ? 'center' : 'flex-start',
        overflow: 'hidden',
        borderBottom: `1px solid ${token.colorBorderSecondary}`,
      }}
    >
      <BrandLogo size={28} />
      {!collapsed && (
        <div style={{ lineHeight: 1.3, minWidth: 0 }}>
          {/* 年度账册:主标墨色加粗,副题小号大写字距档签 */}
          <div className="bd-page-title" style={{ fontSize: 14, color: token.colorText, whiteSpace: 'nowrap' }}>
            年度预算管理
          </div>
          <div
            className="bd-brand-sub"
            style={{
              fontSize: 9,
              color: 'var(--bd-accent)',
              whiteSpace: 'nowrap',
              marginTop: 1,
            }}
          >
            ANNUAL LEDGER
          </div>
        </div>
      )}
    </div>
  );
}

/**
 * UX-25:偏好 Provider 按登录用户名命名空间挂在壳层,侧栏收藏/页头星标/最近访问
 * 与分析页命名视图共用同一份偏好;本机模式(无账号)落 default 命名空间。
 */
function Page({ username, onLogout, onChangePassword }: { username: string; onLogout: () => void; onChangePassword: () => void }) {
  return (
    <UserPrefsProvider namespace={prefsNamespaceFor(username)}>
      <PageInner username={username} onLogout={onLogout} onChangePassword={onChangePassword} />
    </UserPrefsProvider>
  );
}

function PageInner({ username, onLogout, onChangePassword }: { username: string; onLogout: () => void; onChangePassword: () => void }) {
  const loc = useLocation();
  const navigate = useNavigate();
  const navType = useNavigationType();
  const { message, modal } = AntdApp.useApp();
  const { prefs, favoriteFor, toggleFavoriteEntry, removeFavoriteEntry, recordRecent, resetPrefs } = useUserPrefs();
  const { mode, toggle } = useThemeMode();
  const { token } = theme.useToken();
  const [collapsed, setCollapsed] = useState(false);
  const [userMenuOpen, setUserMenuOpen] = useState(false);
  /* 独立双滚动:.bd-main 是唯一滚动容器;路由位置由 useRouteScrollMemory 管理(UX-03):
     范围切换(replace)不动位置,跨页下钻(push)回顶,浏览器返回(pop)恢复离开时的位置。 */
  const mainRef = useRef<HTMLDivElement | null>(null);
  useRouteScrollMemory(mainRef);
  const selected = useMemo(() => selectedKey(loc.pathname, loc.search), [loc.pathname, loc.search]);

  /* UX-25 最近使用:真实导航(PUSH/POP)才记一次访问;页面内范围切换是 replace,不重复计数。
     只记录受支持页面的「入口 + 白名单范围」,首页自身无回看价值不记录。 */
  useEffect(() => {
    if (navType === 'REPLACE') return;
    const routeInfo = derivePageContext(loc.pathname, loc.search);
    if (!isPageKey(routeInfo.page) || routeInfo.page === 'dashboard') return;
    recordRecent({
      pageKey: routeInfo.page,
      path: entryPathFor(routeInfo.page, loc.pathname, loc.search),
      label: pageTitle(loc.pathname, loc.search, selectedKey(loc.pathname, loc.search)),
    });
  }, [loc.pathname, loc.search, navType, recordRecent]);

  /* UX-25 页头收藏星标:收藏 = 当前页面入口 + 当前白名单范围;范围变化后星标跟随
     精确路径,同页不同范围是不同收藏。 */
  const currentRouteInfo = derivePageContext(loc.pathname, loc.search);
  const currentPageKey = isPageKey(currentRouteInfo.page) ? currentRouteInfo.page : null;
  const currentPath = currentPageKey ? entryPathFor(currentPageKey, loc.pathname, loc.search) : null;
  const currentFav = currentPageKey && currentPath ? favoriteFor(currentPageKey, currentPath) : undefined;

  const { data: dash } = useQuery({
    queryKey: ['dashboard'],
    queryFn: () => api.get<{ counts: { orgs: number; accounts: number } }>('/dashboard'),
  });
  const setupIncomplete = (dash?.counts.orgs ?? 1) === 0 || (dash?.counts.accounts ?? 1) === 0;

  const [openKeys, setOpenKeys] = useState<string[]>(() => [...DEFAULT_OPEN]);
  useEffect(() => {
    setOpenKeys((prev) => {
      const next = new Set(prev);
      if (setupIncomplete) next.add('grp-master');
      const g = groupOf(selected);
      if (g) next.add(g);
      // 当处于非助手页面时，自动收起 grp-ai 分组（火山方舟模式：不点击不显示会话）
      if (selected !== '/assistant' && selected !== '/insights' && !selected.startsWith('ai-')) {
        next.delete('grp-ai');
      }
      return [...next];
    });
  }, [selected, setupIncomplete]);

  const isAssistantPage = loc.pathname === '/assistant';

  const { data: convData } = useQuery({
    queryKey: ['assistant-conversations'],
    queryFn: () => assistantApi.conversations(),
    staleTime: 15_000,
    enabled: isAssistantPage,
  });

  const recentConversations = useMemo(
    () => (convData?.items ?? []).filter((r) => r.title?.trim()).slice(0, 5),
    [convData],
  );

  /**
   * 动态生成侧栏菜单（火山方舟体验对齐）：
   * 1. 当处于非助手页面时，「小澧助手」仅作为普通一级分类，子项仅为「对话」与「洞察报告」，不展示任何会话记录；
   * 2. 只有点击进入「小澧助手」/处于对话页面时，才在侧栏动态展开最近会话历史与新建对话，主工作区直接铺满，无重复内侧栏。
   */
  const dynamicMenuItems = useMemo<MenuProps['items']>(() => {
    return (filterMenuByPermission(menuItems, can, getSession()?.user.allOrgs ?? true) ?? []).map((item) => {
      if (!item || !('key' in item) || item.key !== 'grp-ai') return item;

      // 非对话页面：保持纯净功能入口，不展开会话记录
      if (!isAssistantPage) {
        return {
          ...item,
          children: [
            { key: '/assistant', label: '对话' },
            { key: '/insights', label: '洞察报告' },
          ],
        };
      }

      const aiChildren: NonNullable<MenuProps['items']> = [
        { key: '/assistant', label: '对话' },
        {
          key: 'ai-new-chat',
          label: (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, color: 'var(--bd-primary)' }}>
              <i className="ri-add-line" aria-hidden style={{ fontSize: 13 }} />
              <span>新建对话</span>
            </span>
          ),
        },
      ];

      if (recentConversations.length > 0) {
        recentConversations.forEach((conv) => {
          aiChildren.push({
            key: `ai-conv-${conv.id}`,
            label: (
              <Tooltip title={conv.title} placement="right" mouseEnterDelay={0.4}>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', overflow: 'hidden' }}>
                  <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13, flex: '1 1 auto' }}>
                    {conv.title}
                  </span>
                  <span style={{ fontSize: 12, color: token.colorTextTertiary, flexShrink: 0, marginLeft: 4 }}>
                    {relativeTime(conv.updated_at)}
                  </span>
                </div>
              </Tooltip>
            ),
          });
        });

        aiChildren.push({
          key: 'ai-view-all',
          label: (
            <span style={{ display: 'inline-flex', alignItems: 'center', gap: 4, fontSize: 12, color: token.colorTextSecondary }}>
              <span>查看全部历史</span>
              <i className="ri-arrow-right-line" aria-hidden style={{ fontSize: 12 }} />
            </span>
          ),
        });
      }

      aiChildren.push({ key: '/insights', label: '洞察报告' });

      return {
        ...item,
        children: aiChildren,
      };
    });
  }, [isAssistantPage, recentConversations, token]);

  /**
   * UX-25 收藏分组:紧跟「首页」之后的稳定位置,与 grp-ai 会话行同一动态组手法;
   * 行内 ✕ 直接取消收藏(仅删入口偏好,不动业务数据)。无收藏时整组不出现。
   */
  const menuWithFavorites = useMemo<MenuProps['items']>(() => {
    if (prefs.favorites.length === 0) return dynamicMenuItems;
    const [first, ...rest] = dynamicMenuItems ?? [];
    const favChildren: NonNullable<MenuProps['items']> = prefs.favorites.map((fav) => ({
      key: `fav:${fav.id}`,
      label: (
        <Tooltip title={fav.path} placement="right" mouseEnterDelay={0.4}>
          <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', width: '100%', overflow: 'hidden' }}>
            <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontSize: 13, flex: '1 1 auto' }}>
              {fav.label}
            </span>
            <span
              role="button"
              tabIndex={0}
              aria-label={`取消收藏 ${fav.label}`}
              title="取消收藏"
              onClick={(e) => { e.stopPropagation(); removeFavoriteEntry(fav.id); }}
              onKeyDown={(e) => {
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); e.stopPropagation(); removeFavoriteEntry(fav.id); }
              }}
              style={{ flexShrink: 0, marginLeft: 4, color: token.colorTextTertiary, cursor: 'pointer' }}
            >
              <i className="ri-close-line" aria-hidden style={{ fontSize: 12 }} />
            </span>
          </div>
        </Tooltip>
      ),
    }));
    return [
      first,
      { key: 'grp-fav', icon: <i className="ri-star-line" aria-hidden />, label: '收藏', children: favChildren },
      ...rest,
    ];
  }, [dynamicMenuItems, prefs.favorites, removeFavoriteEntry, token]);

  /**
   * 侧栏目录:年度账册沿用「图标只留一级」的菜单结构,并给**顶层**条目在文字前
   * 补等宽编号(01/02/…)——账册的「条目秩序」签名,编号颜色走点缀朱红。
   * 子菜单行(AI 会话行、对话/洞察报告等)一律不编号。
   */
  const ledgerMenuItems = useMemo<MenuProps['items']>(() => {
    let n = 0;
    return (menuWithFavorites ?? []).map((item) => {
      if (!item || !('key' in item)) return item;
      const label = 'label' in item ? item.label : '';
      if (typeof label !== 'string') return item;
      n += 1;
      return {
        ...item,
        label: (
          <span className="bd-menu-label">
            <span className="bd-menu-no">{String(n).padStart(2, '0')}</span>
            {label}
          </span>
        ),
      };
    });
  }, [menuWithFavorites]);

  const dark = mode === 'dark';

  return (
    /**
     * 助手 Provider 必须是唯一实例，且位于 Content 的 `key={loc.pathname}` 包装器**之外**：
     * 那个 key 会在每次路由变化时重建子树，Provider 放进去等于每换一页就清空会话、
     * 掐断在途的 SSE 流。
     */
    <AssistantProvider>
    <Layout className="bd-shell">
      <Sider
        className="bd-sider"
        theme={dark ? 'dark' : 'light'}
        width={216}
        collapsed={collapsed}
        onCollapse={setCollapsed}
        collapsible
        breakpoint="lg"
      >
        <Brand collapsed={collapsed} />
        <div className="bd-sider-menu" style={{ padding: '8px 0' }}>
          <Menu
            theme={dark ? 'dark' : 'light'}
            mode="inline"
            inlineIndent={SIDER_INSET - SIDER_MENU_MARGIN}
            selectedKeys={[selected, ...(currentFav ? [`fav:${currentFav.id}`] : [])]}
            openKeys={collapsed ? undefined : openKeys}
            onOpenChange={(keys) => setOpenKeys(keys)}
            items={ledgerMenuItems}
            onClick={({ key }) => {
              if (String(key).startsWith('grp-')) return;
              if (String(key).startsWith('fav:')) {
                /* 恢复只是导航:目标失效(版本删除/口径不兼容)由目标页 URL 契约说明并要求重选 */
                const fav = prefs.favorites.find((item) => `fav:${item.id}` === key);
                if (fav) navigate(fav.path);
                return;
              }
              if (key === 'ai-new-chat') {
                navigate('/assistant', { state: { newConversation: true } });
                window.dispatchEvent(new CustomEvent('bd:new-assistant-conversation'));
                return;
              }
              if (key === 'ai-view-all') {
                navigate('/assistant', { state: { expandConversations: true } });
                window.dispatchEvent(new CustomEvent('bd:open-assistant-history'));
                return;
              }
              if (String(key).startsWith('ai-conv-')) {
                const convId = Number(String(key).replace('ai-conv-', ''));
                if (!Number.isNaN(convId)) {
                  navigate('/assistant', { state: { openConversationId: convId } });
                  window.dispatchEvent(new CustomEvent('bd:open-assistant-conversation', { detail: { conversationId: convId } }));
                }
                return;
              }
              navigate(key);
            }}
            style={{ borderInlineEnd: 'none', background: 'transparent' }}
          />
        </div>
      </Sider>
      <Layout className="bd-main" ref={mainRef}>
        <Header
          className="bd-header"
          style={{
            position: 'sticky',
            top: 0,
            zIndex: 20,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            padding: '0 24px',
            height: 54,
            lineHeight: '54px',
          }}
        >
          <Space size={10}>
            {/* 页级标题:18px 是梯度最高档,页面内区块标题(15px)与正文(13px)依次降档;
                bd-page-title 提供 text-wrap: balance,换行时行宽均衡 */}
            <Typography.Text strong className="bd-page-title" style={{ fontSize: 18, fontWeight: 500, color: token.colorText }}>
              {pageTitle(loc.pathname, loc.search, selected)}
            </Typography.Text>
            {/* UX-25 收藏入口:收藏当前页面 + 当前白名单筛选范围;再次点击取消 */}
            {currentPageKey && currentPath && (
              <Tooltip title={currentFav ? '取消收藏本页(含当前范围)' : '收藏本页(含当前范围),之后可从侧栏「收藏」直接进入'}>
                <Button
                  type="text"
                  size="small"
                  aria-label={currentFav ? '取消收藏本页' : '收藏本页'}
                  icon={<i className={currentFav ? 'ri-star-fill' : 'ri-star-line'} aria-hidden />}
                  style={{ color: currentFav ? 'var(--bd-accent)' : token.colorTextTertiary }}
                  onClick={() => {
                    if (!currentFav && prefs.favorites.length >= MAX_FAVORITES) {
                      message.warning(`最多收藏 ${MAX_FAVORITES} 个页面入口,请先在侧栏「收藏」中删除不再使用的`);
                      return;
                    }
                    toggleFavoriteEntry({
                      pageKey: currentPageKey,
                      path: currentPath,
                      label: pageTitle(loc.pathname, loc.search, selected),
                    });
                  }}
                />
              </Tooltip>
            )}
          </Space>
          <div style={{ display: 'flex', alignItems: 'center', gap: 14, lineHeight: 'normal' }}>
            {/* AC-F26 跨域检索入口:输入联想(前缀命中),回车进入 /search?q= */}
            {can('search:use') && <HeaderSearch />}
            <Tooltip title="金额统一以万元录入与展示（1.00 万元 = 10,000 元，两位小数）；成本费用按正数填写，负数表示冲回；悬停金额数字可查看精确到元的原始值">
              <span className="bd-chip">
                <span className="bd-status-dot" aria-hidden />
                单位: 万元
              </span>
            </Tooltip>
            <Typography.Text type="secondary" className="tabular-numbers bd-header-date" style={{ fontSize: 12 }}>
              {dayjs().locale('zh-cn').format('YYYY年M月D日 dddd')}
            </Typography.Text>
            <Button
              type="text"
              aria-label="切换主题"
              icon={<i className={dark ? 'ri-sun-line' : 'ri-moon-line'} aria-hidden />}
              onClick={toggle}
              style={{ color: token.colorTextSecondary }}
            />
            <Dropdown
              placement="bottomRight"
              open={userMenuOpen}
              onOpenChange={setUserMenuOpen}
              menu={{
                items: [
                  /* UX-25 重置入口:只清个人偏好(localStorage bd:prefs:*),不触碰任何业务数据 */
                  { key: 'reset-prefs', icon: <i className="ri-eraser-line" aria-hidden />, label: '清空视图与收藏' },
                  { key: 'password', icon: <i className="ri-key-2-line" aria-hidden />, label: '修改口令' },
                  { key: 'logout', icon: <i className="ri-logout-box-r-line" aria-hidden />, label: '退出登录', danger: true },
                ],
                onClick: ({ key }) => {
                  if (key === 'logout') onLogout();
                  if (key === 'password') onChangePassword();
                  if (key === 'reset-prefs') {
                    modal.confirm({
                      title: '清空个人偏好?',
                      content: '将删除本账号保存的分析视图、页面收藏和最近访问记录;预算、实际与主数据等业务数据不受影响。',
                      okText: '清空',
                      okButtonProps: { danger: true },
                      cancelText: '取消',
                      onOk: () => { resetPrefs(); message.success('个人偏好已清空'); },
                    });
                  }
                },
              }}
            >
              {/* 触发器是 div,必须自带 role/tabIndex/键盘事件,否则纯键盘用户无法退出登录 */}
              <div
                role="button"
                tabIndex={0}
                aria-haspopup="menu"
                aria-expanded={userMenuOpen}
                aria-label={`当前登录 ${username},打开用户菜单`}
                onKeyDown={(e) => {
                  if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setUserMenuOpen((v) => !v); }
                  else if (e.key === 'Escape' && userMenuOpen) { e.preventDefault(); setUserMenuOpen(false); }
                }}
                style={{
                  display: 'flex',
                  alignItems: 'center',
                  gap: 8,
                  cursor: 'pointer',
                  padding: '3px 10px 3px 4px',
                  borderRadius: 20,
                  border: `1px solid ${token.colorBorderSecondary}`,
                  background: 'var(--bd-bg-subtle)',
                  transition: 'border-color 0.15s ease, background 0.15s ease',
                }}
              >
                <Avatar
                  size={22}
                  icon={<i className="ri-user-3-line" aria-hidden />}
                  style={{ background: 'var(--bd-primary)' }}
                />
                <Typography.Text style={{ fontSize: 12, fontWeight: 500 }}>{username}</Typography.Text>
              </div>
            </Dropdown>
          </div>
        </Header>
        <Content style={{ margin: '16px 20px' }}>
          <Suspense fallback={<div style={{ padding: 48, textAlign: 'center' }}><Spin /></div>}><div key={loc.pathname} className="page-fade bd-content"><Outlet /></div></Suspense>
        </Content>
        {/* 「金额单位:万元」在顶栏芯片已常驻,这里不再重复;只留系统名与符号口径 */}
        <Footer style={{ textAlign: 'center', padding: '12px 0', fontSize: 12, color: token.colorTextTertiary, background: 'transparent' }}>
          newfc 水利财务分析 · 收入为正，成本费用界面展示为正数
        </Footer>
      </Layout>
      <AssistantDock />
    </Layout>
    </AssistantProvider>
  );
}

/**
 * 全局下载反馈:api/client 的 download() 会广播开始/成功/失败事件,统一在此提示。
 * 各页面历史写法 `onClick={() => download(...)}` 无法自行捕获异常,集中处理可保证
 * 导出/下载失败一定有可见提示,慢导出也有「正在生成」的进度感。
 */
function DownloadFeedback() {
  const { message } = AntdApp.useApp();
  useEffect(() => {
    const onFeedback = (event: Event) => {
      const detail = (event as CustomEvent<DownloadFeedbackDetail>).detail;
      if (!detail) return;
      const key = `download-${detail.id}`;
      if (detail.phase === 'start') message.open({ key, type: 'loading', content: `正在生成 ${detail.filename}…`, duration: 0 });
      else if (detail.phase === 'done') message.open({ key, type: 'success', content: `已开始下载 ${detail.filename}`, duration: 2 });
      else message.open({ key, type: 'error', content: `下载失败(${detail.filename}):${detail.message ?? '请稍后重试'}`, duration: 6 });
    };
    window.addEventListener(DOWNLOAD_FEEDBACK_EVENT, onFeedback);
    return () => window.removeEventListener(DOWNLOAD_FEEDBACK_EVENT, onFeedback);
  }, [message]);
  return null;
}

/** 鉴权门卫:启动时用 Cookie 校验会话并取回 CSRF 令牌;未登录渲染登录页;需改口令时先进入改口令页 */
type AuthState =
  | { status: 'checking' }
  | { status: 'guest' }
  | { status: 'user'; session: SessionInfo; changingPassword: boolean };

function AuthGate() {
  const [auth, setAuth] = useState<AuthState>({ status: 'checking' });

  const enter = (session: SessionInfo) => {
    setSession(session);
    setAuth({ status: 'user', session, changingPassword: session.user.mustChangePassword });
  };
  const refresh = () => api.get<SessionInfo>('/auth/session').then(enter);

  useEffect(() => {
    let alive = true;
    api.get<SessionInfo>('/auth/session')
      .then((s) => { if (alive) enter(s); })
      .catch(() => { if (alive) { setSession(null); setAuth({ status: 'guest' }); } });
    const onExpired = () => setAuth({ status: 'guest' });
    const onPasswordChange = () => setAuth((prev) => prev.status === 'user' ? { ...prev, changingPassword: true } : prev);
    window.addEventListener(AUTH_EXPIRED_EVENT, onExpired);
    window.addEventListener(PASSWORD_CHANGE_EVENT, onPasswordChange);
    return () => {
      alive = false;
      window.removeEventListener(AUTH_EXPIRED_EVENT, onExpired);
      window.removeEventListener(PASSWORD_CHANGE_EVENT, onPasswordChange);
    };
  }, []);

  if (auth.status === 'checking') {
    return (
      <div style={{ minHeight: '100vh', display: 'flex', alignItems: 'center', justifyContent: 'center' }}>
        <Spin size="large" />
      </div>
    );
  }
  if (auth.status === 'guest') {
    return <Login onSuccess={enter} />;
  }

  const logout = async () => {
    try { await api.post('/auth/logout'); } catch { /* 会话已失效也照常回登录页 */ }
    setSession(null);
    setAuth({ status: 'guest' });
  };
  const { session } = auth;
  if (auth.changingPassword) {
    const forced = session.user.mustChangePassword;
    return (
      <ChangePassword
        forced={forced}
        username={session.user.username}
        onDone={() => { void refresh().catch(() => setAuth({ status: 'guest' })); }}
        onCancel={forced ? () => void logout() : () => setAuth({ ...auth, changingPassword: false })}
      />
    );
  }
  return (
    <>
      <DownloadFeedback />
      <Page
        username={session.user.displayName || session.user.username}
        onLogout={logout}
        onChangePassword={() => setAuth({ ...auth, changingPassword: true })}
      />
    </>
  );
}

/** 路由:data router,支持编辑页 useBlocker(未保存离开拦截)。
    惰性创建:菜单纯函数(selectedKey/dataMenuKey/pageTitle)的单测在无 DOM 环境 import 本模块,
    顶层立即 createBrowserRouter 会因 document 缺失而崩溃。 */
let router: ReturnType<typeof createBrowserRouter> | null = null;
function getRouter() {
  if (!router) router = createBrowserRouter([
  {
    path: '/',
    element: <AuthGate />,
    children: [
      { index: true, element: <Dashboard /> },
      { path: 'assistant', element: <Assistant /> },
      { path: 'insights', element: <Insights /> },
      { path: 'master-health', element: <MasterDataHealthPage /> },
      { path: 'cleaning-config', element: <CleaningConfig /> },
      { path: 'progress', element: <BudgetProgress /> },
      { path: 'alerts', element: <AnomalyCenter /> },
      { path: 'metric-trend', element: <MetricTrend /> },
      { path: 'settings/ai', element: <SettingsAi /> },
      { path: 'settings/security', element: <SecurityAdmin /> },
      { path: 'settings/business', element: <SettingsBusiness /> },
      { path: 'master-entities', element: <MasterEntities /> },
      { path: 'projects/:id', element: <ProjectProfile /> },
      { path: 'jobs', element: <JobsCenter /> },
      { path: 'eas', element: <EasWorkspace /> },
      { path: 'governance', element: <Governance /> },
      { path: 'statements', element: <Statements /> },
      { path: 'mgmt', element: <ManagementAccounting /> },
      { path: 'standard-reports', element: <StandardReports /> },
      { path: 'project-budget', element: <ProjectBudget /> },
      { path: 'plan', element: <PlanExecution /> },
      { path: 'contracts', element: <Contracts /> },
      { path: 'contracts/import', element: <ContractImport /> },
      { path: 'expense', element: <ExpenseClaims /> },
      { path: 'expense/policies', element: <ExpensePolicies /> },
      { path: 'feasibility', element: <Feasibility /> },
      { path: 'investment-control', element: <InvestmentControl /> },
      { path: 'forecast', element: <Forecast /> },
      { path: 'risk', element: <RiskLedger /> },
      { path: 'analysis-reports', element: <AnalysisReports /> },
      { path: 'search', element: <Search /> },
      { path: 'org', element: <OrgManage /> },
      { path: 'account', element: <AccountManage /> },
      { path: 'metric', element: <MetricManage /> },
      { path: 'budget', element: <BudgetVersions /> },
      { path: 'budget/:id', element: <BudgetEdit /> },
      { path: 'actual', element: <ActualMaintain /> },
      { path: 'finance', element: <FinanceImport /> },
      { path: 'analysis', element: <Analysis /> },
      { path: 'structure', element: <Structure /> },
      { path: 'history', element: <History /> },
      { path: 'compare', element: <VersionCompare /> },
      { path: 'data', element: <DataManage /> },
      { path: '*', element: <Navigate to="/" replace /> },
    ],
  },
  ]);
  return router;
}

export default function App() {
  return <RouterProvider router={getRouter()} />;
}
