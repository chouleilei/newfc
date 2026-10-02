/** 新领域 ID 不与经营预算 ID 混用；目录由后端契约测试核对。 */
export const DOMAIN_ID_FIELDS = ['projectId', 'contractId', 'claimId', 'feasProjectId', 'scenarioId', 'icProjectId', 'comparisonId', 'modelId', 'forecastVersionId', 'forecastRunId', 'riskId', 'reportId', 'standardReportId', 'governanceIssueId', 'mgmtMetricId', 'statementBatchId', 'projectBudgetBatchId', 'planBatchId', 'easBatchId', 'feasReportId', 'jobId'] as const;
export type DomainContext = Partial<Record<typeof DOMAIN_ID_FIELDS[number], number>> & { period?: string; periodFrom?: string; periodTo?: string; statementScope?: 'parent' | 'subsidiary' | 'consolidated' };

export const DOMAIN_PAGES = {
  eas: { label: 'EAS 工作区', path: '/eas', permission: 'eas:read', prompts: ['当前期间对账有哪些错误与警告', '当前期间是否锁定，有没有待复核更正'] },
  governance: { label: '数据治理', path: '/governance', permission: 'governance:read', prompts: ['当前数据治理问题有哪些', '治理问题的来源与处置状态是什么'] },
  statements: { label: '财务报表', path: '/statements', permission: 'statements:read', prompts: ['当前财务报表的资产负债与净利润是多少', '当前财务报表来源批次和口径是什么'] },
  mgmt: { label: '管理会计', path: '/mgmt', permission: 'mgmt:read', prompts: ['当前管理会计指标快照有哪些', '当前有哪些管理会计预警'] },
  standard_reports: { label: '标准报表', path: '/standard-reports', permission: 'report:read', prompts: ['有哪些冻结标准报表', '当前标准报表的来源和复核状态是什么'] },
  project_budget: { label: '项目预算', path: '/project-budget', permission: 'project_budget:read', prompts: ['当前项目预算与已执行金额是多少', '项目预算按资金来源如何分布'] },
  plan: { label: '计划执行', path: '/plan', permission: 'plan:read', prompts: ['当前年度计划执行与累计进度如何', '当前计划执行的来源批次是什么'] },
  contracts: { label: '合同台账', path: '/contracts', permission: 'contract:read', prompts: ['当前合同金额、已付款和阶段状态是什么', '当前合同有哪些付款节点与阶段阻碍'] },
  contract_import: { label: '合同导入', path: '/contracts/import', permission: 'contract:import', prompts: ['合同导入后如何核对金额与状态', '打开合同台账核对当前合同'] },
  expense: { label: '费用审核', path: '/expense', permission: 'expense:read', prompts: ['哪些报销单待复核', '当前报销单有哪些审核发现与制度依据'] },
  expense_policies: { label: '制度依据', path: '/expense/policies', permission: 'expense:read', prompts: ['当前有哪些制度条款与生效版本', '检索制度“差旅”条款'] },
  feasibility: { label: '可行性测算', path: '/feasibility', permission: 'investment:read', prompts: ['当前可研方案的指标与检查结果是什么', '当前可研结果是否过期，有哪些未通过检查'] },
  investment_control: { label: '投资控制', path: '/investment-control', permission: 'investment:read', prompts: ['当前投资控制偏差与红线情况如何', '当前投资对比快照有哪些超限科目'] },
  forecast: { label: '财务预测', path: '/forecast', permission: 'forecast:read', prompts: ['当前财务预测基准与情景运行结果是什么', '当前预测版本的冻结与复核状态是什么'] },
  risk: { label: '风险台账', path: '/risk', permission: 'risk:read', prompts: ['当前有哪些高风险与逾期整改', '当前风险的证据和整改状态是什么'] },
  analysis_reports: { label: '分析报告', path: '/analysis-reports', permission: 'report:read', prompts: ['有哪些已发布分析报告', '当前分析报告的结论和来源是什么'] },
  master_entities: { label: '主数据', path: '/master-entities', permission: 'master:read', prompts: ['主数据项目目录有哪些', '供应商目录有哪些'] },
  project_profile: { label: '项目全景', path: '/projects', permission: 'project:read', prompts: ['这个项目的预算执行、合同付款和风险情况如何', '这个项目有哪些投资控制和可研依据'] },
  search: { label: '跨域检索', path: '/search', permission: 'search:use', prompts: ['搜索“水库”', '查找“工程”'] },
  jobs: { label: '任务中心', path: '/jobs', permission: 'tasks:read', prompts: ['后台任务的状态如何', '有哪些失败或中断的后台任务'] },
  business_settings: { label: '业务设置', path: '/settings/business', permission: 'settings:read', prompts: ['当前业务设置与模型渠道是什么', '模型未配置时助手可以查询什么'] },
  security: { label: '授权管理', path: '/settings/security', permission: 'security:manage', prompts: ['助手查询如何遵守组织授权', '为什么助手无法查询其他组织数据'] },
} satisfies Record<string, { label: string; path: string; permission: string; prompts: string[] }>;
