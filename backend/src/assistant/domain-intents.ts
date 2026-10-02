/** 新领域意图：模型与规则共用；具体金额仍由工具/service 提供。 */
export const DOMAIN_READ_RULES = [
  { intent: 'eas_status', pattern: /EAS|eas|对账集合|期间锁|三件套|对账状态/, label: 'EAS 对账' },
  { intent: 'statements', pattern: /财务报表|资产负债|净资产|现金流量表|合并报表|母公司报表/, label: '财务报表' },
  { intent: 'mgmt_metrics', pattern: /管理会计|指标快照|分摊结果|责任中心|绩效/, label: '管理会计' },
  { intent: 'mgmt_alerts', pattern: /管理会计预警|指标预警/, label: '管理会计预警' },
  { intent: 'project_budget', pattern: /项目预算|资金来源|项目.{0,8}预算/, label: '项目预算' },
  { intent: 'plan_execution', pattern: /计划执行|计划完成|年度计划|形象进度|完成投资/, label: '计划执行' },
  { intent: 'contracts', pattern: /合同|付款节点|应付合同|待付款/, label: '合同与付款' },
  { intent: 'expenses', pattern: /报销|费用审核|费用复核|发票审核|单据审核|缺.{0,3}附件/, label: '费用审核' },
  { intent: 'policies', pattern: /制度|条款|合规依据|报销标准|差旅标准/, label: '制度条款' },
  { intent: 'feasibility', pattern: /可研|可行性|净现值|内部收益率|偿债|NPV|IRR|DSCR/i, label: '可行性测算' },
  { intent: 'investment_control', pattern: /投资控制|四算|概算|施工图预算|结算超|投资偏差|红线/, label: '投资控制' },
  { intent: 'forecast', pattern: /财务预测|预测模型|预测运行|预测结果|预测版本复核|基准运行|情景运行|预测工作簿/, label: '财务预测' },
  { intent: 'risks', pattern: /风险|整改|风险复核/, label: '风险与整改' },
  { intent: 'analysis_reports', pattern: /分析报告|专题报告|报告发布|已发布.{0,6}报告|报告审批/, label: '分析报告' },
  { intent: 'standard_reports', pattern: /标准报表|冻结报表|报表摘要|对账结果表|合同付款台账|风险整改台账/, label: '标准报表' },
  { intent: 'governance', pattern: /数据治理|治理问题|质量问题处置|映射覆盖|生效证明/, label: '数据治理' },
  { intent: 'project_profile', pattern: /项目全景|项目档案|项目整体|这个项目|该项目|项目.{0,6}(?:合同|风险|付款|执行)/, label: '项目全景' },
  { intent: 'master_entities', pattern: /主数据项目|项目目录|项目列表|供应商|项目主数据/, label: '项目与供应商' },
  { intent: 'cross_search', pattern: /搜索|检索|查找|找一下|帮我找/, label: '跨域检索' },
  { intent: 'tasks', pattern: /任务中心|后台任务|任务状态|任务失败|重算任务/, label: '任务状态' },
  { intent: 'authorization', pattern: /组织授权|授权范围|没有.{0,3}权限|无权.{0,5}查询|权限.{0,4}范围/, label: '权限与范围' },
  { intent: 'configuration', pattern: /模型渠道|AI 渠道|模型配置|系统设置|业务设置|OCR 配置/, label: '配置与能力' },
] as const;
export type DomainReadIntent = typeof DOMAIN_READ_RULES[number]['intent'];
export const DOMAIN_PAGE_INTENTS: Record<string, DomainReadIntent> = {
  eas: 'eas_status', statements: 'statements', mgmt: 'mgmt_metrics', project_budget: 'project_budget', plan: 'plan_execution', contracts: 'contracts', contract_import: 'contracts',
  expense: 'expenses', expense_policies: 'policies', feasibility: 'feasibility', investment_control: 'investment_control', forecast: 'forecast', risk: 'risks',
  analysis_reports: 'analysis_reports', standard_reports: 'standard_reports', governance: 'governance', project_profile: 'project_profile', master_entities: 'master_entities',
  security: 'authorization', search: 'cross_search', jobs: 'tasks', business_settings: 'configuration',
};
export function isDomainIntent(value: string): value is DomainReadIntent { return DOMAIN_READ_RULES.some((r) => r.intent === value); }
/** 新财务写操作只指向业务页；不要被继承的“测算/导出”误判成经营预算操作。 */
export function domainWriteRequest(message: string, page?: string): boolean {
  const domain = DOMAIN_READ_RULES.some((r) => r.pattern.test(message)) || !!(page && DOMAIN_PAGE_INTENTS[page]);
  return domain && !/经营预算/.test(message) && /(?:帮我|请|直接|立即|重新|生成|提交|批准|审核|复核|发布|扫描|导入|激活|删除|作废|付款|支付|测算|重算|导出|下载)/.test(message)
    && !/为什么|原因|有哪些|什么|如何|怎么|状态|结果|情况|明细|详情|多少|能否|是否|查看|查询|解释|列出|核对/.test(message);
}
