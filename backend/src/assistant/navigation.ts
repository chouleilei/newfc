import { currentAuth } from '../core/request-context';
import { PAGE_CATALOG, PAGE_IDS, pagePath, pageVisible, type PageId } from '../contracts/page-catalog';
import type { AssistantScope } from '../contracts/assistant';
export interface NavigationTarget {
  page: PageId;
  path: string;
  label: string;
  reason: string;
  params?: Record<string, string | number>;
}
/** Navigation vocabulary references pages; routes, labels and authorization live in the catalog. */
const RULES: { page: PageId; pattern: RegExp }[] = [
  { page: 'standard_reports', pattern: /标准报表|冻结报表|合同付款台账|风险整改台账/ },
  { page: 'project_profile', pattern: /项目全景|项目档案/ },
  { page: 'eas', pattern: /EAS|eas|对账集合|期间锁/ },
  { page: 'governance', pattern: /数据治理|治理问题/ },
  { page: 'statements', pattern: /财务报表|资产负债表|现金流量表/ },
  { page: 'mgmt', pattern: /管理会计|分摊|责任中心|绩效/ },
  { page: 'project_budget', pattern: /项目预算/ },
  { page: 'plan', pattern: /计划执行|形象进度/ },
  { page: 'contract_import', pattern: /合同导入/ },
  { page: 'contracts', pattern: /合同|付款节点/ },
  { page: 'expense_policies', pattern: /制度|条款/ },
  { page: 'expense', pattern: /费用审核|报销|费用复核/ },
  { page: 'feasibility', pattern: /可行性|可研/ },
  { page: 'investment_control', pattern: /投资控制|概算|四算/ },
  { page: 'forecast', pattern: /财务预测|预测模型|预测运行/ },
  { page: 'risk', pattern: /风险|整改/ },
  { page: 'analysis_reports', pattern: /分析报告|专题报告|报告发布/ },
  { page: 'master_entities', pattern: /主数据|供应商/ },
  { page: 'search', pattern: /跨域检索|搜索/ },
  { page: 'jobs', pattern: /任务中心|后台任务/ },
  { page: 'business_settings', pattern: /业务设置/ },
  { page: 'security', pattern: /授权管理|账号权限/ },
  { page: 'dashboard', pattern: /首页|工作台|仪表盘|总览|看板/ },
  { page: 'budget_edit', pattern: /编制|填报|录预算|编预算|预算表格|填数/ },
  { page: 'budget_versions', pattern: /版本|预算列表|预测|定稿|归档|草案|复制版本/ },
  { page: 'actual', pattern: /实际录入|录实际|实际数维护|历史数据维护|快照|补录|实际数/ },
  { page: 'finance_import', pattern: /财务转换|财务系统|余额表|利润表导入|凭证/ },
  { page: 'analysis', pattern: /执行分析|完成情况|完成率|差异分析|预警|归因|执行情况/ },
  { page: 'history', pattern: /历年|往年|年度趋势|历史对比|准确率/ },
  { page: 'version_compare', pattern: /版本对比|版本差异|两个版本/ },
  { page: 'org', pattern: /组织树|组织管理|组织维护|新增组织/ },
  { page: 'account', pattern: /科目树|科目管理|科目维护|新增科目|预设表/ },
  { page: 'metric', pattern: /指标|毛利|营业利润配置/ },
  { page: 'calculations', pattern: /测算模板|量价|模板配置/ },
  { page: 'imports', pattern: /导入批次|导入记录|撤销导入|批次列表/ },
  { page: 'yearclose', pattern: /年度关闭|关闭年度|重开年度/ },
  { page: 'backup', pattern: /备份|恢复|迁移|一致性检查/ },
  { page: 'logs', pattern: /操作日志|审计|日志/ }, ];
function visiblePage(page: PageId): boolean {
  const auth = currentAuth();
  return !auth || pageVisible(page, (permission) => auth.permissions.has(permission), auth.allOrgs);
}
export function looksLikeNavigation(message: string): boolean {
  return /打开|跳转|进入|去到|去看|带我|切换到|导航|哪个页面|在哪里|怎么找到|哪儿看/.test(message);
}
export function resolveNavigation(message: string, context: AssistantScope = {}): NavigationTarget | null {
  if (!looksLikeNavigation(message)) return null;
  for (const rule of RULES) {
    if (!visiblePage(rule.page)) continue;
    const match = message.match(rule.pattern);
    if (!match) continue;
    const id = rule.page === 'budget_edit' ? context.budgetVersionId : rule.page === 'project_profile' ? context.projectId : undefined;
    const params: Record<string, string | number> = {};
    if (rule.page === 'budget_edit' && id) params.versionId = id;
    if ((rule.page === 'actual' || rule.page === 'analysis') && context.year) params.year = context.year;
    if (rule.page === 'analysis' && context.budgetVersionId) params.versionId = context.budgetVersionId;
    return { page: rule.page, path: pagePath(rule.page, id ? { id } : {}), label: PAGE_CATALOG[rule.page].label, reason: `命中关键词「${match[0]}」`, ...(Object.keys(params).length ? { params } : {}) };
  }
  return null;
}
export function navigationCatalog(): { page: PageId; label: string; path: string }[] {
  return PAGE_IDS.filter(visiblePage).map((page) => ({ page, label: PAGE_CATALOG[page].label, path: pagePath(page) }));
}
