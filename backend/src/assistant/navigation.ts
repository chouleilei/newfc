import { currentAuth } from '../core/request-context';
/**
 * 页面导航意图(方案《AI助手完整方案》4.1「页面导航」)。
 *
 * 后端只输出确定性的导航目标(路由 + 查询参数 + 命中原因)，由前端决定是否跳转。
 * 路由与 frontend/src/App.tsx 的 router 定义保持一致。
 */
import type { AssistantContext } from './schemas';

export interface NavigationTarget {
  /** 页面标识,与前端路由一一对应 */
  page: string;
  /** 前端可直接使用的相对路径 */
  path: string;
  label: string;
  /** 命中的关键词/上下文原因 */
  reason: string;
  params?: Record<string, string | number>;
}

interface Rule {
  page: string;
  label: string;
  pattern: RegExp;
  /** 路径构造：可用 context 补全版本 ID 等参数 */
  build: (context: AssistantContext) => { path: string; params?: Record<string, string | number> };
}

const DOMAIN_NAV: [string, string, RegExp, string][] = [
  ['standard_reports', '标准报表', /标准报表|冻结报表|合同付款台账|风险整改台账/, '/standard-reports'],
  ['project_profile', '项目全景', /项目全景|项目档案/, '/projects'],
  ['eas', 'EAS 工作区', /EAS|eas|对账集合|期间锁/, '/eas'], ['governance', '数据治理', /数据治理|治理问题/, '/governance'],
  ['statements', '财务报表', /财务报表|资产负债表|现金流量表/, '/statements'], ['mgmt', '管理会计', /管理会计|分摊|责任中心|绩效/, '/mgmt'],
  ['project_budget', '项目预算', /项目预算/, '/project-budget'], ['plan', '计划执行', /计划执行|形象进度/, '/plan'],
  ['contract_import', '合同导入', /合同导入/, '/contracts/import'], ['contracts', '合同台账', /合同|付款节点/, '/contracts'],
  ['expense_policies', '制度依据', /制度|条款/, '/expense/policies'], ['expense', '费用审核', /费用审核|报销|费用复核/, '/expense'],
  ['feasibility', '可行性测算', /可行性|可研/, '/feasibility'], ['investment_control', '投资控制', /投资控制|概算|四算/, '/investment-control'],
  ['forecast', '财务预测', /财务预测|预测模型|预测运行/, '/forecast'], ['risk', '风险台账', /风险|整改/, '/risk'],
  ['analysis_reports', '分析报告', /分析报告|专题报告|报告发布/, '/analysis-reports'], ['master_entities', '主数据', /主数据|供应商/, '/master-entities'],
  ['search', '跨域检索', /跨域检索|搜索/, '/search'], ['jobs', '任务中心', /任务中心|后台任务/, '/jobs'],
  ['business_settings', '业务设置', /业务设置/, '/settings/business'], ['security', '授权管理', /授权管理|账号权限/, '/settings/security'],
];
const PAGE_PERMISSION: Record<string, string> = {
  eas: 'eas:read', governance: 'governance:read', statements: 'statements:read', mgmt: 'mgmt:read', standard_reports: 'report:read', project_profile: 'project:read',
  project_budget: 'project_budget:read', plan: 'plan:read', contracts: 'contract:read', contract_import: 'contract:import', expense: 'expense:read', expense_policies: 'expense:read',
  feasibility: 'investment:read', investment_control: 'investment:read', forecast: 'forecast:read', risk: 'risk:read', analysis_reports: 'report:read', master_entities: 'master:read',
  search: 'search:use', jobs: 'tasks:read', business_settings: 'settings:read', security: 'security:manage',
};
function visiblePage(page: string) { const auth = currentAuth(); return !auth || !PAGE_PERMISSION[page] || auth.permissions.has(PAGE_PERMISSION[page] as any); }
const RULES: Rule[] = [
  ...DOMAIN_NAV.map(([page, label, pattern, path]) => ({ page, label, pattern, build: (c: AssistantContext) => ({ path: page === 'project_profile' && c.projectId ? `/projects/${c.projectId}` : page === 'project_profile' ? '/master-entities?tab=projects' : path }) })),
  { page: 'dashboard', label: '首页工作台', pattern: /首页|工作台|仪表盘|总览|看板/, build: () => ({ path: '/' }) },
  {
    page: 'budget_edit',
    label: '预算编制表格',
    pattern: /编制|填报|录预算|编预算|预算表格|填数/,
    build: (context) => (context.budgetVersionId != null
      ? { path: `/budget/${context.budgetVersionId}`, params: { versionId: context.budgetVersionId } }
      : { path: '/budget' }),
  },
  {
    page: 'budget_versions',
    label: '预算与预测版本',
    pattern: /版本|预算列表|预测|定稿|归档|草案|复制版本/,
    build: () => ({ path: '/budget' }),
  },
  {
    page: 'actual',
    label: '实际录入与快照',
    pattern: /实际录入|录实际|实际数维护|历史数据维护|快照|补录|实际数/,
    build: (context) => ({ path: '/actual', ...(context.year == null ? {} : { params: { year: context.year } }) }),
  },
  { page: 'finance_import', label: '财务系统转换', pattern: /财务转换|财务系统|余额表|利润表导入|凭证/, build: () => ({ path: '/finance' }) },
  {
    page: 'analysis',
    label: '年度执行分析',
    pattern: /执行分析|完成情况|完成率|差异分析|预警|归因|执行情况/,
    build: (context) => ({
      path: '/analysis',
      ...(context.budgetVersionId == null && context.year == null ? {} : {
        params: {
          ...(context.year == null ? {} : { year: context.year }),
          ...(context.budgetVersionId == null ? {} : { versionId: context.budgetVersionId }),
        },
      }),
    }),
  },
  { page: 'history', label: '历年对比与趋势', pattern: /历年|往年|年度趋势|历史对比|准确率/, build: () => ({ path: '/history' }) },
  { page: 'version_compare', label: '版本对比', pattern: /版本对比|版本差异|两个版本/, build: () => ({ path: '/compare' }) },
  { page: 'org', label: '组织管理', pattern: /组织树|组织管理|组织维护|新增组织/, build: () => ({ path: '/org' }) },
  { page: 'account', label: '科目管理', pattern: /科目树|科目管理|科目维护|新增科目|预设表/, build: () => ({ path: '/account' }) },
  { page: 'metric', label: '报表指标', pattern: /指标|毛利|营业利润配置/, build: () => ({ path: '/metric' }) },
  { page: 'calculations', label: '测算模板', pattern: /测算模板|量价|模板配置/, build: () => ({ path: '/data?tab=calculations', params: { tab: 'calculations' } }) },
  { page: 'imports', label: '导入批次', pattern: /导入批次|导入记录|撤销导入|批次列表/, build: () => ({ path: '/data?tab=imports', params: { tab: 'imports' } }) },
  { page: 'yearclose', label: '年度关闭', pattern: /年度关闭|关闭年度|重开年度/, build: () => ({ path: '/data?tab=yearclose', params: { tab: 'yearclose' } }) },
  { page: 'backup', label: '备份与迁移', pattern: /备份|恢复|迁移|一致性检查/, build: () => ({ path: '/data?tab=backup', params: { tab: 'backup' } }) },
  { page: 'logs', label: '操作日志', pattern: /操作日志|审计|日志/, build: () => ({ path: '/data?tab=logs', params: { tab: 'logs' } }) },
];

/** 是否是"打开/跳转"这类导航请求。 */
export function looksLikeNavigation(message: string): boolean {
  return /打开|跳转|进入|去到|去看|带我|切换到|导航|哪个页面|在哪里|怎么找到|哪儿看/.test(String(message || ''));
}

/**
 * 解析导航意图。只有同时命中「导航动词」和「页面关键词」才返回目标，
 * 避免普通查询被误判成跳转。
 */
export function resolveNavigation(message: string, context: AssistantContext = {}): NavigationTarget | null {
  const text = String(message || '');
  if (!text.trim() || !looksLikeNavigation(text)) return null;
  for (const rule of RULES) {
    if (!visiblePage(rule.page)) continue;
    const match = text.match(rule.pattern);
    if (!match) continue;
    const built = rule.build(context);
    return { page: rule.page, path: built.path, label: rule.label, reason: `命中关键词「${match[0]}」`, ...(built.params ? { params: built.params } : {}) };
  }
  return null;
}

/** 全部可导航页面,供前端渲染快捷入口与文档核对。 */
export function navigationCatalog(): { page: string; label: string; path: string }[] {
  return RULES.filter((r) => visiblePage(r.page)).map((rule) => ({ page: rule.page, label: rule.label, path: rule.build({}).path }));
}
