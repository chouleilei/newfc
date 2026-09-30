/**
 * PageCapabilityMap(方案《小澧助手全页面回答范围自动对齐开发计划》§7、§9.2、§9.4)。
 *
 * 一个普通 TypeScript Record：
 *   pageKey → 允许的 view 字段 → 允许的 entity/fact/draft 类型 → 默认领域能力 → 可使用的领域能力。
 *
 * 它不保存 UI 文案以外的任何组件逻辑、不生成路由，也不为每个页面复制工具。
 * 前端 pageKey 目录(frontend/src/assistant/context.ts PAGE_KEYS)与本表由契约测试
 * tests/page-capabilities.contract.test.ts 双向比较，发现遗漏即失败。
 *
 * 页面决定默认范围和允许能力，问题决定本轮具体调用。未知 pageKey 不回退 dashboard。
 */

/** 领域能力(§9.3)：助手内部的确定性调用边界，包装已有业务服务。 */
export type DomainCapability =
  | 'overview'
  | 'assistant_content'
  | 'master_data'
  | 'budget'
  | 'actual'
  | 'execution'
  | 'comparison'
  | 'import_conversion'
  | 'evidence'
  | 'operations'
  | 'finance_data'
  | 'project_data'
  | 'risk_investment';

/** 通用语义 entity 类型全集(§3.6、§5.5)：行/树节点/卡片/异常/日志/核验闸门等统一为 entity。 */
export type AssistantEntityType =
  | 'row'
  | 'tree_node'
  | 'card'
  | 'anomaly'
  | 'log_entry'
  | 'verification_gate'
  | 'budget_version'
  | 'actual_snapshot'
  | 'org'
  | 'account'
  | 'metric'
  | 'insight'
  | 'report_section'
  | 'conversion'
  | 'mapping_version'
  | 'import_batch'
  | 'cleaning_template'
  | 'alias_rule'
  | 'calculation_rule'
  | 'backup'
  | 'migration_task'
  | 'check_item'
  | 'progress_row'
  | 'yearclose_item'
  | 'ai_channel'
  | 'feature_binding'
  | 'export_task';

/** 请求内草稿类型(§9.6)。 */
export type DraftKind =
  | 'budget_grid'
  | 'actual_grid'
  | 'org_form'
  | 'account_form'
  | 'metric_formula'
  | 'calculation_rule'
  | 'cleaning_template'
  | 'alias_rule';

export interface PageCapability {
  /** 页面中文名：contextSummary 与导航共用，与前端 PAGE_LABEL 一致。 */
  label: string;
  /** view 白名单字段：页签、显示模式、受控筛选与搜索。不在表内的键一律拒绝。 */
  viewFields: string[];
  /** 本页允许出现的 entity 类型。 */
  entityTypes: AssistantEntityType[];
  /** 本页允许的 factType(§5.5 目前只有 verification)。 */
  factTypes: string[];
  /** 本页允许的 draft.kind(§9.6)。 */
  draftKinds: DraftKind[];
  /** 未识别到更具体意图时的默认领域能力。 */
  defaultCapability: DomainCapability;
  /** 本页可调用的全部领域能力。 */
  capabilities: DomainCapability[];
}

/** 跨页通用的树/行/卡片焦点。 */
const TREE_ROW_CARD: AssistantEntityType[] = ['row', 'tree_node', 'card'];

export const PAGE_CAPABILITY_MAP: Record<string, PageCapability> = {
  dashboard: {
    label: '首页工作台',
    viewFields: ['dashboardSubject'],
    entityTypes: [...TREE_ROW_CARD, 'org', 'account', 'metric', 'anomaly', 'budget_version', 'actual_snapshot'],
    factTypes: ['verification'],
    draftKinds: [],
    defaultCapability: 'overview',
    capabilities: ['overview', 'execution', 'evidence', 'finance_data', 'project_data', 'risk_investment'],
  },
  assistant: {
    label: '小澧助手',
    viewFields: [],
    entityTypes: ['insight', 'report_section', 'card'],
    factTypes: [],
    draftKinds: [],
    defaultCapability: 'assistant_content',
    capabilities: ['assistant_content', 'execution', 'comparison', 'budget', 'actual', 'master_data', 'import_conversion', 'operations', 'overview', 'evidence', 'finance_data', 'project_data', 'risk_investment'],
  },
  insights: {
    label: '洞察报告',
    viewFields: ['kind', 'status'],
    entityTypes: ['insight', 'report_section', 'card'],
    factTypes: [],
    draftKinds: [],
    defaultCapability: 'assistant_content',
    capabilities: ['assistant_content'],
  },
  master_health: {
    label: '主数据健康',
    viewFields: ['dimension', 'issueType', 'status', 'search'],
    entityTypes: [...TREE_ROW_CARD, 'org', 'account', 'metric'],
    factTypes: [],
    draftKinds: [],
    defaultCapability: 'master_data',
    capabilities: ['master_data'],
  },
  cleaning_config: {
    label: '清洗配置',
    viewFields: ['tab', 'targetKind', 'status', 'search'],
    entityTypes: ['row', 'cleaning_template', 'alias_rule'],
    factTypes: [],
    draftKinds: ['cleaning_template', 'alias_rule'],
    defaultCapability: 'import_conversion',
    capabilities: ['import_conversion'],
  },
  budget_progress: {
    label: '编制进度',
    viewFields: ['status'],
    entityTypes: ['card', 'row', 'progress_row', 'org'],
    factTypes: [],
    draftKinds: [],
    defaultCapability: 'budget',
    capabilities: ['budget', 'overview', 'execution'],
  },
  anomaly_center: {
    label: '异常预警中心',
    viewFields: ['anomalyType', 'severity', 'status', 'threshold', 'yoyThreshold', 'peerThreshold'],
    entityTypes: ['anomaly', 'row', 'org', 'account'],
    factTypes: [],
    draftKinds: [],
    defaultCapability: 'execution',
    capabilities: ['overview', 'execution'],
  },
  metric_trend: {
    label: '指标趋势',
    viewFields: ['series', 'versionIds'],
    entityTypes: ['metric', 'card'],
    factTypes: [],
    draftKinds: [],
    defaultCapability: 'comparison',
    capabilities: ['comparison', 'evidence'],
  },
  ai_settings: {
    label: 'AI 渠道设置',
    viewFields: ['tab', 'testStatus'],
    // 脱敏渠道或绑定详情；密钥输入永不登记(§7.2)。
    entityTypes: ['ai_channel', 'feature_binding', 'row'],
    factTypes: [],
    draftKinds: [],
    defaultCapability: 'operations',
    capabilities: ['operations'],
  },
  org: {
    label: '组织管理',
    viewFields: ['status', 'search'],
    entityTypes: ['tree_node', 'row', 'org'],
    factTypes: [],
    draftKinds: ['org_form'],
    defaultCapability: 'master_data',
    capabilities: ['master_data'],
  },
  account: {
    label: '科目管理',
    viewFields: ['type', 'sheetKey', 'scopeKey', 'search'],
    entityTypes: ['tree_node', 'row', 'account'],
    factTypes: [],
    draftKinds: ['account_form'],
    defaultCapability: 'master_data',
    capabilities: ['master_data'],
  },
  metric: {
    label: '报表指标',
    viewFields: ['category', 'status'],
    entityTypes: ['row', 'metric'],
    factTypes: [],
    draftKinds: ['metric_formula'],
    defaultCapability: 'master_data',
    capabilities: ['master_data'],
  },
  budget_versions: {
    label: '预算与预测版本',
    viewFields: ['kind', 'status', 'sort'],
    entityTypes: ['row', 'budget_version'],
    factTypes: [],
    draftKinds: [],
    defaultCapability: 'budget',
    capabilities: ['budget'],
  },
  budget_edit: {
    label: '预算编制表格',
    viewFields: ['sheetKey', 'orgView', 'accountView', 'keyword', 'nonZeroOnly', 'collapseLevel'],
    entityTypes: ['row', 'tree_node', 'org', 'account', 'budget_version', 'check_item'],
    factTypes: ['verification'],
    draftKinds: ['budget_grid'],
    defaultCapability: 'budget',
    capabilities: ['budget', 'evidence'],
  },
  actual: {
    label: '实际录入与快照',
    viewFields: ['sheetKey', 'viewMode', 'historyMode', 'keyword', 'nonZeroOnly', 'collapseLevel', 'cutoff'],
    entityTypes: ['row', 'tree_node', 'org', 'account', 'actual_snapshot'],
    factTypes: [],
    draftKinds: ['actual_grid'],
    defaultCapability: 'actual',
    capabilities: ['actual', 'evidence'],
  },
  finance_import: {
    label: '财务系统转换',
    viewFields: ['step', 'status'],
    entityTypes: ['row', 'conversion', 'mapping_version', 'verification_gate'],
    factTypes: [],
    draftKinds: [],
    defaultCapability: 'import_conversion',
    capabilities: ['import_conversion'],
  },
  analysis: {
    label: '年度执行分析',
    viewFields: ['sheetKey', 'summaryLevel', 'threshold', 'trend', 'accountSearch'],
    entityTypes: ['row', 'org', 'account', 'metric', 'card'],
    factTypes: ['verification'],
    draftKinds: [],
    defaultCapability: 'execution',
    capabilities: ['execution', 'evidence'],
  },
  structure: {
    label: '结构分析',
    viewFields: ['sheetKey', 'summaryLevel', 'basisMode', 'basisId', 'accountSearch'],
    entityTypes: ['row', 'tree_node', 'org', 'account', 'metric'],
    factTypes: ['verification'],
    draftKinds: [],
    defaultCapability: 'comparison',
    capabilities: ['comparison', 'evidence'],
  },
  history: {
    label: '历年对比与趋势',
    viewFields: ['versionRule', 'dimension'],
    entityTypes: ['row', 'metric', 'account', 'org'],
    factTypes: [],
    draftKinds: [],
    defaultCapability: 'comparison',
    capabilities: ['comparison'],
  },
  version_compare: {
    label: '版本对比',
    viewFields: ['direction', 'sort', 'sheetKey'],
    entityTypes: ['row', 'org', 'account', 'metric', 'budget_version'],
    // 版本对比页打开指标凭据抽屉(EvidenceDrawer)时会登记 evidence:metric 核验焦点，
    // 与 VERIFICATION_OWNER_PAGES.evidence 的页面清单保持一致，否则抽屉一打开焦点就被判 CONTEXT_INVALID。
    factTypes: ['verification'],
    draftKinds: [],
    defaultCapability: 'comparison',
    capabilities: ['comparison', 'evidence'],
  },
  calculations: {
    label: '测算模板',
    viewFields: ['ruleType', 'status', 'search'],
    entityTypes: ['row', 'calculation_rule'],
    factTypes: [],
    draftKinds: ['calculation_rule'],
    defaultCapability: 'budget',
    capabilities: ['budget'],
  },
  imports: {
    label: '导入批次',
    viewFields: ['importType', 'status', 'dateFrom', 'dateTo'],
    entityTypes: ['row', 'import_batch'],
    factTypes: [],
    draftKinds: [],
    defaultCapability: 'import_conversion',
    capabilities: ['import_conversion'],
  },
  data_check: {
    label: '一致性检查',
    viewFields: ['severity', 'result'],
    entityTypes: ['card', 'row', 'check_item'],
    factTypes: [],
    draftKinds: [],
    defaultCapability: 'operations',
    capabilities: ['operations'],
  },
  yearclose: {
    label: '年度关闭',
    viewFields: ['status'],
    entityTypes: ['row', 'yearclose_item', 'check_item'],
    factTypes: [],
    draftKinds: [],
    defaultCapability: 'operations',
    capabilities: ['operations'],
  },
  backup: {
    label: '备份与迁移',
    viewFields: ['backupType', 'status'],
    entityTypes: ['row', 'backup'],
    factTypes: [],
    draftKinds: [],
    defaultCapability: 'operations',
    capabilities: ['operations'],
  },
  migration: {
    label: '迁移管理',
    viewFields: ['direction', 'status', 'table'],
    entityTypes: ['row', 'migration_task'],
    factTypes: [],
    draftKinds: [],
    defaultCapability: 'operations',
    capabilities: ['operations'],
  },
  data_export: {
    label: '数据导出',
    viewFields: ['exportType'],
    entityTypes: ['row', 'export_task'],
    factTypes: [],
    draftKinds: [],
    defaultCapability: 'operations',
    capabilities: ['operations'],
  },
  logs: {
    label: '操作日志',
    viewFields: ['action', 'entityType', 'user', 'result', 'dateFrom', 'dateTo'],
    entityTypes: ['row', 'log_entry'],
    factTypes: [],
    draftKinds: [],
    defaultCapability: 'operations',
    capabilities: ['operations'],
  },
};

/** 28 个 pageKey：与前端 PAGE_KEYS 一一对应，契约测试双向比较。 */
export const PAGE_KEYS = Object.keys(PAGE_CAPABILITY_MAP);

export function isPageKey(value: string): boolean {
  return Object.prototype.hasOwnProperty.call(PAGE_CAPABILITY_MAP, value);
}

export function pageCapability(pageKey: string): PageCapability | null {
  return PAGE_CAPABILITY_MAP[pageKey] ?? null;
}

/**
 * 领域能力 → 允许调用的模型只读工具(§9.3)。
 * 模型工具仍使用严格 schema，但只暴露本轮 PageCapabilityMap 允许的领域能力。
 */
const CAPABILITY_TOOLS: Record<DomainCapability, string[]> = {
  overview: ['calculate_accuracy', 'get_historical_comparison', 'get_dashboard_overview'],
  assistant_content: ['generate_report', 'list_insights'],
  master_data: ['get_org_tree', 'get_account_tree', 'list_metrics', 'get_master_data_health'],
  budget: ['get_budget_matrix', 'get_budget_cell_history', 'get_budget_quality', 'get_budget_progress', 'list_calculation_rules', 'get_cell_notes'],
  actual: ['get_actual_snapshot', 'get_year_states', 'get_cell_notes'],
  execution: ['calculate_execution', 'calculate_trend', 'calculate_anomalies', 'calculate_attribution', 'calculate_accuracy'],
  comparison: ['calculate_variance', 'get_historical_comparison', 'calculate_trend', 'calculate_structure', 'calculate_multi_year_trend'],
  import_conversion: [
    'validate_import', 'get_import_batch', 'explain_import',
    'list_finance_conversions', 'get_finance_conversion',
    'list_finance_mapping_versions', 'get_finance_mapping_version',
    'list_finance_parallel_trials', 'list_finance_source_profiles',
    'list_cleaning_templates', 'list_cleaning_aliases',
  ],
  evidence: ['get_metric_evidence', 'get_cell_evidence', 'get_cell_notes', 'calculate_execution'],
  operations: ['get_operation_log', 'validate_import', 'check_consistency', 'list_backups', 'get_year_states'],
  // T-3 财务数据:EAS 对账、财务报表、管理会计(只读,同源 service,org_scope)
  finance_data: ['eas_period_status', 'statement_overview', 'mgmt_metric_snapshots', 'mgmt_alerts'],
  // T-4 项目、合同与费用(只读,同源 service,org_scope;合同详情由 service 判定可见性)
  project_data: ['project_budget_summary', 'plan_execution_overview', 'contract_summary', 'contract_detail', 'expense_audit_queue'],
  // T-5 可研测算、投资控制、财务预测、风险与分析报告(只读,同源 service,org_scope;按 ID 读取由 service 判定可见性)
  risk_investment: ['feasibility_result', 'investment_comparison', 'forecast_runs', 'risk_summary', 'report_list'],
};

/** 全页面都允许的通用只读工具。 */
const UNIVERSAL_TOOLS = ['explain_terms', 'get_navigation_catalog', 'list_budget_versions', 'list_actual_snapshots', 'list_metrics', 'list_sheets', 'cross_search'];

/** 本轮允许暴露给模型的工具集合(页面能力并集 + 通用工具)。 */
export function allowedToolsForCapabilities(capabilities: DomainCapability[]): string[] {
  const allowed = new Set<string>(UNIVERSAL_TOOLS);
  for (const capability of capabilities) {
    for (const tool of CAPABILITY_TOOLS[capability] ?? []) allowed.add(tool);
  }
  return [...allowed];
}

/** 工具 → 所属领域能力（用于把工具错误如实翻译成 CAPABILITY_UNAVAILABLE）。 */
export function capabilityOfTool(tool: string): DomainCapability | null {
  for (const [capability, tools] of Object.entries(CAPABILITY_TOOLS) as [DomainCapability, string[]][]) {
    if (tools.includes(tool)) return capability;
  }
  return null;
}

/**
 * 读意图 → 领域能力(§9.4)：问题决定本轮具体调用，页面决定允许范围。
 */
export const INTENT_CAPABILITY: Record<string, DomainCapability> = {
  budget_versions: 'budget',
  actual_snapshots: 'actual',
  org_tree: 'master_data',
  account_tree: 'master_data',
  import: 'import_conversion',
  finance_conversion: 'import_conversion',
  operation_log: 'operations',
  execution: 'execution',
  attribution: 'execution',
  report: 'assistant_content',
  trend: 'execution',
  version_variance: 'comparison',
  anomalies: 'execution',
  budget_quality: 'budget',
  accuracy: 'execution',
  historical_comparison: 'comparison',
  budget_progress: 'budget',
  structure: 'comparison',
  metric_catalog: 'master_data',
  insights: 'assistant_content',
  master_health: 'master_data',
  consistency_check: 'operations',
  calculation_rules: 'budget',
  cleaning_config: 'import_conversion',
  // 单元格备注查询:get_cell_notes 在 budget/actual/evidence 能力下均暴露,
  // 预算编辑与实际维护页都带 evidence,归此与模型工具路径同口径
  cell_note: 'evidence',
};

/**
 * 选择本轮实际使用的领域能力：按意图顺序取第一个页面允许的能力；
 * 核验焦点(fact)优先路由到 evidence；都没有时退回页面默认能力。
 */
export function pickCapability(
  page: PageCapability,
  readIntents: string[],
  options: { hasVerificationFocus?: boolean; needsEvidence?: boolean } = {},
): DomainCapability {
  if ((options.hasVerificationFocus || options.needsEvidence) && page.capabilities.includes('evidence')) return 'evidence';
  for (const intent of readIntents) {
    const capability = INTENT_CAPABILITY[intent];
    if (capability && page.capabilities.includes(capability)) return capability;
  }
  return page.defaultCapability;
}

/** 过滤出页面允许的读意图；返回 [允许的意图, 被拒绝的意图]。 */
export function filterIntentsByCapability(page: PageCapability, readIntents: string[]): [string[], string[]] {
  const allowed: string[] = [];
  const denied: string[] = [];
  for (const intent of readIntents) {
    const capability = INTENT_CAPABILITY[intent];
    if (!capability || page.capabilities.includes(capability)) allowed.push(intent);
    else denied.push(intent);
  }
  return [allowed, denied];
}
