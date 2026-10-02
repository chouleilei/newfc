import { TOOL_REGISTRY, toolDefinition } from './tools';
import { pageDefinition } from '../contracts/page-catalog';
import type { PageDefinition, DomainCapability } from '../contracts/page-catalog';
type PageCapability = PageDefinition;

/**
 * 领域能力 → 允许调用的模型只读工具(§9.3)。
 * 模型工具仍使用严格 schema，但只暴露本轮 PageCapabilityMap 允许的领域能力。
 */
/** Capabilities and universal visibility are derived from each tool definition. */
export function allowedToolsForCapabilities(capabilities: DomainCapability[]): string[] {
  return Object.entries(TOOL_REGISTRY).filter(([, d]) => d.universal || d.capabilities.some((c) => capabilities.includes(c))).map(([name]) => name);
}
export function capabilityOfTool(tool: string): DomainCapability | null {
  return toolDefinition(tool)?.capabilities[0] ?? null;
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
  eas_status: 'finance_data', statements: 'finance_data', mgmt_metrics: 'finance_data', mgmt_alerts: 'finance_data',
  project_budget: 'project_data', plan_execution: 'project_data', contracts: 'project_data', expenses: 'project_data',
  feasibility: 'risk_investment', investment_control: 'risk_investment', forecast: 'risk_investment', risks: 'risk_investment', analysis_reports: 'risk_investment',
  authorization: 'domain_support', policies: 'domain_support', standard_reports: 'domain_support', governance: 'domain_support', project_profile: 'domain_support', master_entities: 'domain_support',
  cross_search: 'domain_support', tasks: 'domain_support', configuration: 'domain_support',
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
