import { STATEMENT_METRIC_LABELS } from '../contracts/statements';
import { CONTRACT_STAGE_LABELS, CONTRACT_STATUS_LABELS, type ContractStage, type ContractStatus } from '../contracts/project-contract';
import type { DB } from '../db/connection';
import type { AssistantScope } from '../contracts/assistant';
import type { AssistantFact as FactRecord, FactSource } from '../contracts/assistant';
import { executeTool, toolLabel } from './tools';
import { isDomainIntent, DOMAIN_PAGE_INTENTS, domainWriteRequest } from './domain-intents';
import { DOMAIN_ID_FIELDS } from '../contracts/assistant';
import { domainBatchContext } from './domain-context';
import { normalizeDomainContext } from './domain-scope';
import type { ReadIntent } from './intent';
import { crossDomainSearch } from '../modules/search/search.service';
import type { SearchType } from '../contracts/search';
import { currentAuth } from '../core/request-context';

export function resolveDomainMessage(db: DB, message: string, context: AssistantScope, inherited: AssistantScope, read: ReadIntent[], followUp: boolean): { clarification: FactRecord | null; trace: { field: string; value: number | string; origin: string; reason: string }[] } {
  const trace: { field: string; value: number | string; origin: string; reason: string }[] = [];
  const month = message.match(/((?:19|20)\d{2})\s*(?:年\s*|[-/])\s*(0?[1-9]|1[0-2])\s*(?:月|期间)?/);
  if (month) { context.period = `${month[1]}-${month[2].padStart(2, '0')}`; context.year = Number(month[1]); trace.push({ field: 'period', value: context.period, origin: 'message', reason: '采用问题明确指定的期间' }); }
  else if (followUp && read.some(isDomainIntent) && context.period == null && inherited.period && (context.year == null || inherited.period.startsWith(String(context.year)))) { context.period = inherited.period; trace.push({ field: 'period', value: context.period, origin: 'conversation', reason: '沿用上一轮期间' }); }
  if (!month && context.period && context.year != null && !context.period.startsWith(String(context.year))) { delete context.period; trace.push({ field: 'year', value: context.year, origin: 'message', reason: '年度变化后不沿用旧期间，请指定新年度的月份' }); }
  const explicit: [RegExp, typeof DOMAIN_ID_FIELDS[number]][] = [
    [/(?:主数据项目|(?<!可研|投资|可行性)项目)\s*(?:ID|id|编号)?\s*#\s*(\d+)/, 'projectId'], [/(?:合同)\s*(?:ID|id)?\s*#\s*(\d+)/, 'contractId'],
    [/(?:报销单|报销)\s*(?:ID|id)?\s*#\s*(\d+)/, 'claimId'], [/(?:可研项目|可行性项目)\s*#\s*(\d+)/, 'feasProjectId'],
    [/(?:方案)\s*#\s*(\d+)/, 'scenarioId'], [/(?:投资项目)\s*#\s*(\d+)/, 'icProjectId'], [/(?:对比快照|投资快照)\s*#\s*(\d+)/, 'comparisonId'],
    [/(?:模型|预测模型)\s*#\s*(\d+)/, 'modelId'], [/(?:预测版本)\s*#\s*(\d+)/, 'forecastVersionId'], [/(?:预测运行|运行)\s*#\s*(\d+)/, 'forecastRunId'],
    [/(?:风险)\s*#\s*(\d+)/, 'riskId'], [/(?:分析报告)\s*#\s*(\d+)/, 'reportId'], [/(?:标准报表)\s*#\s*(\d+)/, 'standardReportId'], [/(?:治理问题)\s*#\s*(\d+)/, 'governanceIssueId'],
    [/(?:财报批次|财务报表批次)\s*#\s*(\d+)/, 'statementBatchId'], [/(?:项目预算批次)\s*#\s*(\d+)/, 'projectBudgetBatchId'], [/(?:计划批次)\s*#\s*(\d+)/, 'planBatchId'], [/(?:EAS 批次|EAS批次)\s*#\s*(\d+)/i, 'easBatchId'], [/(?:可研报告|可行性报告)\s*#\s*(\d+)/, 'feasReportId'], [/(?:后台任务)\s*#\s*(\d+)/, 'jobId'],
  ];
  for (const [pattern, field] of explicit) { const hit = message.match(pattern); if (hit) { context[field] = Number(hit[1]); trace.push({ field, value: context[field]!, origin: 'message', reason: `问题指定 ${field}` }); } }
  const fieldsByIntent: Partial<Record<ReadIntent, string[]>> = { contracts: ['contractId','projectId'], expenses: ['claimId'], feasibility: ['feasProjectId','scenarioId','feasReportId'], investment_control: ['icProjectId','comparisonId'], forecast: ['modelId','forecastVersionId','forecastRunId'], risks: ['riskId'], analysis_reports: ['reportId'], standard_reports: ['standardReportId'], statements: ['statementBatchId'], project_budget: ['projectId','projectBudgetBatchId'], plan_execution: ['projectId','planBatchId'], project_profile: ['projectId'], eas_status: ['easBatchId'], governance: ['governanceIssueId'], mgmt_metrics: ['mgmtMetricId'], tasks: ['jobId'] };
  const inheritedFields = new Set(read.flatMap((intent) => fieldsByIntent[intent] ?? []));
  if (followUp && read.some(isDomainIntent)) for (const field of DOMAIN_ID_FIELDS) {
    if (!inheritedFields.has(field)) continue;
    if (context[field] == null && inherited[field] != null && !trace.some((t) => DOMAIN_ID_FIELDS.includes(t.field as any))) { context[field] = inherited[field]; trace.push({ field, value: context[field]!, origin: 'conversation', reason: '沿用上一轮业务对象' }); }
  }
  const token = extractSearchKeyword(message);
  const types: SearchType[] = [];
  if (read.includes('contracts')) types.push('contract');
  if (read.includes('expenses')) types.push('expense_claim');
  if (read.includes('forecast')) types.push('forecast_model');
  if (read.includes('feasibility')) types.push('feasibility_project');
  if (read.includes('investment_control')) types.push('investment_project');
  if (read.includes('project_profile') || read.includes('project_budget') || read.includes('plan_execution')) types.push('project');
  if (token && types.length && !read.includes('cross_search')) {
    if (currentAuth() && !currentAuth()!.permissions.has('search:use')) return { trace, clarification: { type: 'domain_clarification', data: { query: token, candidates: [], reason: '当前没有名称检索权限，请在业务页面打开对象或提供带 # 的 ID。' }, source: {} } };
    const result = crossDomainSearch(db, { q: token, types, limit: 20 });
    const fieldOf: Partial<Record<SearchType, typeof DOMAIN_ID_FIELDS[number]>> = { contract: 'contractId', expense_claim: 'claimId', forecast_model: 'modelId', feasibility_project: 'feasProjectId', investment_project: 'icProjectId', project: 'projectId' };
    const exact = result.items.filter((i) => i.code === token || i.title === token);
    const candidates = exact.length ? exact : result.items;
    if (candidates.length === 1 && !Object.keys(result.truncated).length) {
      const row = candidates[0], field = fieldOf[row.type];
      if (field) { context[field] = row.id; trace.push({ field, value: row.id, origin: 'message', reason: `按名称/编码匹配「${row.title}」` }); }
    } else {
      return { trace, clarification: { type: 'domain_clarification', data: { query: token, candidates: candidates.slice(0, 20), reason: candidates.length ? '名称对应多个对象，请选择完整名称或带 # 的 ID 后再查询。' : '未找到有权限的匹配对象，请核对名称、编码或从业务页面打开详情。' }, source: { asOf: new Date().toISOString() } } };
    }
  }
  const batchNamed = trace.some((t) => ['statementBatchId', 'projectBudgetBatchId', 'planBatchId', 'easBatchId'].includes(t.field));
  const batchScope = domainBatchContext(db, { ...context, ...(batchNamed && !/(?:19|20)\d{2}\s*年|(?:19|20)\d{2}-/.test(message) ? { year: undefined, period: undefined } : {}) });
  Object.assign(context, batchScope);
  if (batchScope.period) trace.push({ field: 'period', value: batchScope.period, origin: 'source', reason: '按指定来源批次的实际期间' });
  return { trace, clarification: null };
}
export function extractSearchKeyword(message: string): string | undefined {
  const quote = message.match(/[“「"]([^”」"]{1,64})[”」"]/);
  if (quote) return quote[1].trim();
  const code = message.match(/\b(?:HT|BX|XM|IC|FEAS|FF|RPT|PRJ)[-_][A-Za-z0-9_-]+\b/i);
  if (code) return code[0];
  const named = message.match(/(?:查询|查看|核对|分析)\s*(?:合同|报销单|可研项目|投资项目|预测模型|项目)\s*([^，。？?]{2,40}?)(?:的(?:金额|付款|执行|预算|状态|结果|风险)|情况)/);
  if (named && !/^(?:当前|这个|该|全部|所有|当前范围|本年度|今年|本年|本月|金额|付款|状态|执行|预算|风险|结果|数量|总额|合计|的|明细|详情|节点)/.test(named[1])) return named[1].trim();
  const request = message.match(/(?:搜索|检索|查找|找一下|帮我找)\s*[:：]?\s*(.{1,64})/);
  return request?.[1].replace(/[？?。]$/, '').trim() || undefined;
}

/** 对应业务工具的可追溯来源：对象 ID/冻结 hash 只从授权工具结果提取。 */
export function domainSource(tool: string, args: Record<string, unknown>, data: any): FactSource {
  const references: NonNullable<FactSource['references']> = [];
  const ref = (kind: string, id: unknown, label: string, path: string, hash?: string) => {
    if (typeof id === 'number' && Number.isSafeInteger(id) && id > 0) references.push({ kind, id, label, path, ...(hash ? { hash } : {}) });
  };
  if (tool === 'domain_batch_read') { const paths: Record<string,string> = { statement: '/statements?tab=batches', project_budget: '/project-budget?', plan: '/plan?', eas: '/eas?' }; ref(`${data.kind}_batch`, data.batch?.id, `${data.batch?.fileName ?? data.batch?.name ?? '来源批次'}`, `${paths[data.kind]}${data.kind === 'statement' ? '&' : ''}batchId=${data.batch?.id}`, data.batch?.fileSha256); }
  if (tool === 'feasibility_report_read') for (const r of data.items ?? []) ref('feasibility_report', r.id, r.title, `/feasibility?tab=reports&reportId=${r.id}`, r.parameterHash);
  if (tool === 'contract_detail') ref('contract', data.id, data.contractNo, `/contracts?id=${data.id}`);
  if (tool === 'expense_detail') { ref('expense_claim', data.id, data.claimNo, `/expense?id=${data.id}`); ref('expense_audit', data.audit?.id, '当前审核运行', `/expense?id=${data.id}`); }
  if (tool === 'project_profile') ref('project', data.project?.id, data.project?.name, `/projects/${data.project?.id}`);
  if (tool === 'project_budget_summary') ref('project_budget_batch', data.batch?.id, data.batch?.name, `/project-budget?batchId=${data.batch?.id}`);
  if (tool === 'eas_period_status') ref('eas_set', data.currentSet?.id, `${data.orgName} ${data.period} 对账集合`, `/eas?orgId=${data.orgId}&period=${data.period}`);
  if (tool === 'statement_overview') ref('statement_batch', data.batch?.id, '财报来源批次', `/statements?orgId=${data.batch?.orgId}&period=${data.batch?.period}`);
  if (tool === 'feasibility_result') { ref('feasibility_scenario', data.scenario?.id, data.scenario?.name, `/feasibility?id=${data.scenario?.project?.id}`); ref('feasibility_run', data.latestRun?.id, '冻结测算运行', `/feasibility?id=${data.scenario?.project?.id}`, data.latestRun?.parameterHash); }
  if (tool === 'investment_comparison') ref('investment_comparison', data.comparison?.id, '投资对比快照', `/investment-control?id=${data.comparison?.projectId}`, data.comparison?.contentSha256);
  if (tool === 'forecast_result') { ref('forecast_version', data.version?.id, '预测版本', `/forecast?versionId=${data.version?.id}`); ref('forecast_run', data.run?.id, '预测运行', `/forecast?versionId=${data.version?.id ?? ''}`); }
  if (tool === 'risk_detail') ref('risk_event', data.id, data.title, `/risk?id=${data.id}`);
  if (tool === 'analysis_report_read') ref('analysis_report', data.id, data.title, `/analysis-reports?id=${data.id}`, data.publication?.snapshotSha256);
  if (tool === 'standard_report_read') ref('standard_report', data.report?.id, data.report?.title, `/standard-reports?id=${data.report?.id}`, data.report?.contentSha256);
  if (tool === 'policy_search') for (const c of data.items ?? []) ref('policy_clause', c.id, `${c.policyCode} V${c.version} 条款${c.clauseNo}`, `/expense/policies?id=${c.policyId}`);
  return { period: typeof data.batch?.period === 'string' ? data.batch.period : typeof data.batch?.actualPeriod === 'string' ? data.batch.actualPeriod : typeof data.period === 'string' ? data.period : typeof args.period === 'string' ? args.period : undefined,
    orgScopeId: typeof args.orgScopeId === 'number' ? args.orgScopeId : data.orgId ?? data.batch?.orgId ?? undefined, references,
    asOf: data.generatedAt ?? data.report?.generatedAt ?? data.comparison?.createdAt ?? data.latestRun?.createdAt ?? data.run?.createdAt ?? data.batch?.createdAt ?? new Date().toISOString() };
}

export function queryDomainFacts(db: DB, message: string, context: AssistantScope, read: ReadIntent[], view: Record<string, unknown> = {}): FactRecord[] {
  const facts: FactRecord[] = [];
  const add = (name: string, args: Record<string, unknown>) => {
    const cleanArgs = Object.fromEntries(Object.entries(args).filter(([, v]) => v !== undefined && v !== null));
    try { const data = executeTool(db, name, cleanArgs); facts.push({ type: `tool:${name}`, data, source: domainSource(name, cleanArgs, data) }); }
    catch (error) { facts.push({ type: 'query_error', data: { requested: toolLabel(name), code: (error as { code?: string }).code ?? 'QUERY_UNAVAILABLE', message: error instanceof Error ? error.message : '查询暂不可用' }, source: { asOf: new Date().toISOString() } }); }
  };
  const need = (field: string, reason: string) => facts.push({ type: 'missing_context', data: { field, reason }, source: {} });
  const orgScopeId = context.orgScopeId ?? null, period = context.period;
  const ledger = (kind: string) => add('domain_ledger', { kind, orgScopeId, status: view.status, keyword: view.keyword || undefined, folder: view.folder, level: view.level, reportKind: view.kind, projectId: context.projectId, todo: view.todo, stage: view.stage });
  const filtered = Object.entries(view).some(([k,v]) => ['status','keyword','level','folder','kind','todo','stage'].includes(k) && v != null && v !== '');
  for (const intent of read) {
    switch (intent) {
      case 'eas_status': if (context.easBatchId) { add('domain_batch_read', { kind: 'eas', batchId: context.easBatchId, orgScopeId }); break; } if (['locks','corrections','aux'].includes(String(view.tab))) { add('domain_workspace', { kind: `eas_${view.tab}`, orgScopeId, period, status: view.status, pendingOnly: view.pendingOnly }); break; } if (!period || !period.includes('-')) need('period', 'EAS 对账需指定 YYYY-MM 期间'); else add('eas_period_status', { orgScopeId, period }); break;
      case 'statements': if (context.statementBatchId) { add('domain_batch_read', { kind: 'statement', batchId: context.statementBatchId, orgScopeId }); break; } if (view.tab === 'trends') { add('statement_trends', { orgScopeId, from: context.periodFrom, to: context.periodTo, scope: context.statementScope }); break; } add('statement_overview', { orgScopeId, period, scope: context.statementScope }); break;
      case 'mgmt_metrics': if (view.tab === 'analysis') { if (!(view.metricIds as unknown[])?.length) need('mgmtMetricId', '多维分析需先在页面选择指标'); else add('mgmt_analysis', { orgScopeId, metricIds: view.metricIds, periods: view.periods, groupBy: view.groupBy, dimensionId: view.dimensionId }); break; } if (view.tab === 'alerts') { add('mgmt_alerts', { orgScopeId, period, status: view.status }); break; } if (['centers','metrics','dimensions','allocation','performance','budget-adjust'].includes(String(view.tab))) { add('mgmt_workspace', { kind: view.tab, orgScopeId, period, status: view.status, schemeId: view.schemeId }); break; } add('mgmt_metric_snapshots', { orgScopeId, period, metricId: context.mgmtMetricId }); break;
      case 'mgmt_alerts': add('mgmt_alerts', { orgScopeId, period, status: view.status }); break;
      case 'project_budget': if (context.projectBudgetBatchId) { add('domain_batch_read', { kind: 'project_budget', batchId: context.projectBudgetBatchId, orgScopeId }); break; } add('project_budget_summary', { orgScopeId, year: context.year, period, projectId: context.projectId }); break;
      case 'plan_execution': if (context.planBatchId) { add('domain_batch_read', { kind: 'plan', batchId: context.planBatchId, orgScopeId }); break; } if (!context.year) need('year', '计划执行需指定年度'); else add('plan_execution_overview', { orgScopeId, year: context.year, asOfPeriod: period?.includes('-') ? period : undefined, projectId: context.projectId }); break;
      case 'contracts': if (context.contractId) add('contract_detail', { contractId: context.contractId }); else if (filtered) ledger('contracts'); else add('contract_summary', { orgScopeId, projectId: context.projectId }); break;
      case 'expenses': if (context.claimId) add('expense_detail', { claimId: context.claimId }); else if (filtered) ledger('expense'); else add('expense_audit_queue', { orgScopeId }); break;
      case 'policies': add('policy_search', { q: extractSearchKeyword(message), includeRetired: view.includeRetired, expenseType: view.expenseType }); break;
      case 'feasibility': if (!context.feasProjectId && !context.scenarioId && !context.feasReportId && view.tab !== 'reports' && filtered) { ledger('feasibility'); break; } if (context.feasReportId || view.tab === 'reports') { add('feasibility_report_read', { reportId: context.feasReportId, projectId: context.feasProjectId, scenarioId: context.scenarioId, status: view.status }); break; } add('feasibility_result', { orgScopeId, projectId: context.feasProjectId, scenarioId: context.scenarioId }); break;
      case 'investment_control': if (!context.icProjectId && !context.comparisonId && filtered) { ledger('investment'); break; } add('investment_comparison', { orgScopeId, projectId: context.icProjectId, comparisonId: context.comparisonId }); break;
      case 'forecast': if (!context.forecastRunId && !context.forecastVersionId && ['reviews','publications'].includes(String(view.tab))) { add('domain_workspace', { kind: `forecast_${view.tab}`, orgScopeId, includeWithdrawn: view.includeWithdrawn }); break; } if (context.forecastRunId || context.forecastVersionId) add('forecast_result', { versionId: context.forecastVersionId, runId: context.forecastRunId }); else if (!context.modelId && filtered) ledger('forecast'); else add('forecast_runs', { orgScopeId, modelId: context.modelId }); break;
      case 'risks': if (['scans','rules'].includes(String(view.tab))) { add('domain_workspace', { kind: `risk_${view.tab}`, orgScopeId }); break; } if (context.riskId) add('risk_detail', { riskId: context.riskId }); else if (filtered) ledger('risk'); else add('risk_summary', { orgScopeId, level: /高风险|高等级|高危/.test(message) ? 'high' : /中风险/.test(message) ? 'medium' : /低风险/.test(message) ? 'low' : view.level }); break;
      case 'analysis_reports': if (context.reportId) add('analysis_report_read', { reportId: context.reportId }); else if (filtered) ledger('reports'); else add('report_list', { orgScopeId }); break;
      case 'standard_reports': add('standard_report_read', { orgScopeId, period, reportId: context.standardReportId, reportType: view.reportType }); break;
      case 'governance': add('governance_issues', { orgScopeId, period, issueId: context.governanceIssueId, status: view.status, sourceType: view.sourceType }); break;
      case 'project_profile': if (context.projectId) add('project_profile', { projectId: context.projectId }); else need('projectId', '请打开项目全景，或给出完整项目名称/编码/项目 #ID'); break;
      case 'master_entities': add('master_entities', { orgScopeId, keyword: extractSearchKeyword(message) ?? (view.keyword || undefined), kind: /供应商/.test(message) ? 'supplier' : /项目/.test(message) ? 'project' : view.tab === 'suppliers' ? 'supplier' : 'project' }); break;
      case 'cross_search': { const q = extractSearchKeyword(message) ?? view.keyword; if (q) add('cross_search', { q }); else need('keyword', '请提供要检索的名称或编码，例如：搜索“水库”'); break; }
      case 'tasks': add('task_status', { status: view.status, jobId: context.jobId }); break;
      case 'authorization': add('authorization_scope', {}); break;
      case 'configuration': add('configuration_overview', {}); break;
    }
  }
  if (domainWriteRequest(message, context.pageKey)) facts.unshift({ type: 'domain_write_guidance', data: { message: '助手只读取事实并提供建议。导入、测算、扫描、付款、复核、审批、发布和导出请在对应业务页面核对后显式操作；本轮没有执行这些操作。' }, source: {} });
  return facts;
}

function scalar(value: unknown): string { return value == null ? '未提供' : typeof value === 'object' ? '' : String(value).replace(/\|/g, '／').replace(/[\r\n]/g, ' '); }
function table(rows: any[], columns: [string, string][]): string {
  if (!rows.length) return '当前范围没有可用记录；这不代表业务已通过检查。';
  return `| ${columns.map(([, label]) => label).join(' | ')} |\n| ${columns.map(() => '---').join(' | ')} |\n` + rows.slice(0, 10).map((r) => `| ${columns.map(([k]) => scalar(r[k])).join(' | ')} |`).join('\n');
}
/** 规则回答精确转述字符串，不用浮点计算金额或比例。 */
const DOMAIN_TOOL_NAMES = new Set(['domain_ledger', 'mgmt_analysis', 'authorization_scope', 'domain_batch_read', 'statement_trends', 'mgmt_workspace', 'domain_workspace', 'feasibility_report_read', 'eas_period_status', 'statement_overview', 'mgmt_metric_snapshots', 'mgmt_alerts', 'project_budget_summary', 'plan_execution_overview', 'contract_summary', 'contract_detail', 'expense_audit_queue', 'feasibility_result', 'investment_comparison', 'forecast_runs', 'risk_summary', 'report_list', 'cross_search', 'project_profile', 'master_entities', 'expense_detail', 'policy_search', 'governance_issues', 'standard_report_read', 'analysis_report_read', 'risk_detail', 'forecast_result', 'task_status', 'configuration_overview']);
const domainFact = (f: FactRecord) => f.type.startsWith('domain_') || (f.type.startsWith('tool:') && DOMAIN_TOOL_NAMES.has(f.type.slice(5)));
export function summarizeDomainFacts(facts: FactRecord[]): string | null {
  if (!facts.some(domainFact)) return null;
  const lines: string[] = [];
  for (const f of facts) {
    const d: any = f.data;
    if (d?.error) { lines.push(`查询未完成：${d.error}。`); continue; }
    if (f.type === 'domain_write_guidance') { lines.push(d.message); continue; }
    if (f.type === 'domain_clarification') { lines.push(d.reason, table(d.candidates, [['typeLabel', '类型'], ['id', 'ID'], ['code', '编码'], ['title', '名称']])); continue; }
    if (f.type === 'query_error') { lines.push(`查询未完成：${d.message}。`); continue; }
    if (f.type === 'missing_context') { lines.push(`需要补充 ${d.field}：${d.reason}。`); continue; }
    if (!f.type.startsWith('tool:')) continue;
    const tool = f.type.slice(5);
    lines.push(`### ${toolLabel(tool)}`);
    switch (tool) {
      case 'contract_summary': lines.push(`可见合同 ${d.count} 份；当前金额 ${scalar(d.currentAmount)} 元，已付 ${scalar(d.paidAmount)} 元，付款比率 ${scalar(d.paymentRate)}（0–1 比率）。`, `状态：${Object.entries(d.byStatus ?? d.counts ?? {}).map(([k,v]) => `${k} ${v}`).join('，') || '详见事实'}`); break;
      case 'contract_detail': lines.push(`${d.contractNo} ${d.name}；阶段 ${CONTRACT_STAGE_LABELS[d.stage as ContractStage] ?? d.stage}，状态 ${CONTRACT_STATUS_LABELS[d.status as ContractStatus] ?? d.status}。当前金额 ${d.currentAmount} 元，已付 ${d.paidAmount} 元。`, table(d.payments ?? [], [['nodeName','付款节点'],['amount','金额（元）'],['status','状态']]), ...(d.blockers ?? []).map((b: any) => typeof b === 'string' ? b : scalar(b.message))); break;
      case 'expense_audit_queue': lines.push(`各状态单据：${Object.entries(d.counts).map(([k,v]) => `${k} ${v}`).join('，')}。`, table(d.awaitingReview.items, [['claimNo','单号'],['orgName','组织'],['amount','金额（元）'],['riskLevel','风险等级']])); break;
      case 'expense_detail': lines.push(`${d.claimNo}；状态 ${d.status}，金额 ${d.amount} 元，人工结论 ${scalar(d.conclusion)}。`, d.audit ? `当前审核 #${d.audit.id}；OCR ${d.audit.ocrStatus}，模型 ${d.audit.modelStatus}。\n${table(d.audit.findings.items, [['code','发现'],['severity','等级'],['message','说明'],['clauseLabel','条款']])}` : '当前内容没有有效审核结果。'); break;
      case 'project_budget_summary': lines.push(d.batch ? `${d.year} 年 ${d.period}，来源批次 #${d.batch.id}「${d.batch.name}」。` : '没有当前生效的项目预算批次。', table(d.byProject.items, [['projectCode','项目编码'],['label','项目'],['budget','预算（元）'],['executed','已执行（元）']])); break;
      case 'plan_execution_overview': lines.push(`${d.year} 年计划执行；${d.batch ? '已取得来源批次' : '没有当前生效批次'}。`, table(d.sheets ?? [], [['name','计划表'],['annualPlan','年度计划（元）'],['annualActualYtd','累计执行（元）'],['annualRate','执行比率']])); break;
      case 'eas_period_status': lines.push(`${d.orgName} ${d.period}：${d.currentSet ? `当前集合 #${d.currentSet.id}，错误 ${d.currentSet.errorCount}，警告 ${d.currentSet.warningCount}` : '没有当前对账集合'}；${d.lock ? `期间 ${d.lock.status}` : '未锁定'}。`, table(d.currentSet?.results ?? [], [['ruleName','核对规则'],['status','状态'],['diffAmount','差额（元）']])); break;
      case 'statement_overview': lines.push(d.batch ? `来源批次 #${d.batch.id}，${d.batch.period}，${d.batch.scope} 口径。` : '当前范围没有财务报表批次。', table(Object.entries(d.metrics ?? {}).map(([name, value]) => ({ name: (STATEMENT_METRIC_LABELS as Record<string,string>)[name] ?? name, value })), [['name','指标'],['value','金额（元）']]), table(Object.entries(d.ratios ?? {}).map(([name, value]) => ({ name: (STATEMENT_METRIC_LABELS as Record<string,string>)[name] ?? name, value })), [['name','比率'],['value','数值（0–1）']])); break;
      case 'mgmt_metric_snapshots': lines.push(table(d.items, [['metricName','指标'],['orgName','组织'],['period','期间'],['value','数值'],['unit','单位']])); break;
      case 'mgmt_alerts': lines.push(table(d.items, [['metricName','指标'],['period','期间'],['status','状态'],['message','说明']])); break;
      case 'policy_search': lines.push(table(d.items, [['policyName','制度'],['version','版本'],['clauseNo','条款'],['clauseText','摘要'],['limit','上限（元）']])); break;
      case 'governance_issues': lines.push(table(d.items, [['title','问题'],['period','期间'],['status','状态'],['severity','等级'],['sourceRef','来源']])); break;
      case 'feasibility_result': lines.push(d.scenario ? `${d.scenario.name}：${d.scenario.stale ? '依据已过期，需重算' : '当前依据'}。\n${table(d.latestRun?.indicators ?? [], [['name','指标'],['value','数值'],['unit','单位'],['status','状态']])}` : table(d.scenarios.items, [['projectName','项目'],['scenarioName','方案'],['runStatus','运行状态'],['stale','是否过期']])); if (d.latestRun?.failedChecks?.length) lines.push(table(d.latestRun.failedChecks, [['code','检查'],['severity','等级'],['message','说明']])); break;
      case 'investment_comparison': lines.push(d.comparison ? `冻结对比 #${d.comparison.id}；偏差 ${d.comparison.summary.totalDeviation} 元，比率 ${scalar(d.comparison.summary.totalDeviationRate)}。` : table(d.projects.items, [['projectName','项目'],['totalDeviation','偏差（元）'],['totalDeviationRate','偏差比率'],['totalLevel','等级']])); break;
      case 'forecast_runs': lines.push(d.model ? `${d.model.name}；版本 ${d.versions.length} 个。\n${table(d.versions.flatMap((v: any) => v.runs), [['id','运行 ID'],['kind','类型'],['scenarioName','情景'],['status','状态']])}` : table(d.models.items, [['name','模型'],['baseYear','基准年'],['versionCount','版本数'],['frozenCount','冻结数']])); break;
      case 'forecast_result': lines.push(d.run ? `运行 #${d.run.id}，${d.run.kind}，状态 ${d.run.status}。\n${table(Object.entries(d.run.outputs ?? {}).flatMap(([name, values]) => (values as string[]).map((value, index) => ({ name, yearIndex: index + 1, value }))), [['name','输出'],['yearIndex','序年'],['value','数值（单位见预测定义）']])}` : `预测版本 #${d.version.id}，状态 ${d.version.status}。`); break;
      case 'risk_summary': lines.push(`未关闭风险金额 ${scalar(d.summary.openAmount)} 元。`, table(d.openRisks.items, [['title','风险'],['level','等级'],['status','状态'],['amount','金额（元）'],['overdue','是否逾期']])); break;
      case 'risk_detail': lines.push(`${d.title}；等级 ${d.level}，状态 ${d.status}，金额 ${scalar(d.amount)} 元，截止 ${scalar(d.deadline)}。`, table(d.actions, [['action','整改动作'],['createdAt','时间']])); break;
      case 'report_list': lines.push(table(d.reports.items, [['title','报告'],['status','状态'],['revisionNo','修订号'],['publishedAt','发布时间']])); break;
      case 'analysis_report_read': lines.push(`${d.title}（修订 ${d.revisionNo}），状态 ${d.status}。`, ...d.sections.map((s: any) => `#### ${s.title}\n${s.body}${s.truncated ? '\n正文已截取，请打开报告查看全文。' : ''}`)); break;
      case 'standard_report_read': lines.push(d.report ? `${d.report.title}；${d.report.period}，状态 ${d.report.status}。\n${table(d.summary, [['label','指标'],['value','值']])}` : table(d.items, [['title','报表'],['period','期间'],['status','状态'],['rowCount','行数']])); break;
      case 'project_profile': lines.push(`${d.project.code} ${d.project.name}（${d.project.orgName}）。`, ...(d.budget ? [d.budget.batch ? `项目预算 ${d.budget.budget} 元，已执行 ${d.budget.executed} 元，来源批次 #${d.budget.batch.id}。` : '项目预算没有当前来源批次。'] : ['项目预算未返回（权限不足）。']), ...(d.contracts ? [`合同 ${d.contracts.count} 份，当前金额 ${d.contracts.currentTotal} 元，已付 ${d.contracts.paidTotal} 元。`, table(d.contracts.payments, [['contractNo','合同'],['nodeName','付款节点'],['amount','金额（元）'],['status','状态']])] : ['合同未返回（权限不足）。']), ...(d.risks ? [`未关闭风险 ${d.risks.openCount} 项。`, table(d.risks.rows, [['ruleName','风险'],['level','等级'],['status','状态']])] : ['风险未返回（权限不足）。']), '各部分按本账号权限分别取数；缺失数据不当作零或合规。'); break;
      case 'cross_search': lines.push(table(d.items, [['typeLabel','类型'],['code','编码'],['title','名称'],['status','状态']])); if (Object.keys(d.truncated ?? {}).length) lines.push('部分类型结果已截断，请缩小关键词后重查。'); break;
      case 'master_entities': lines.push(table(d.items, [['code','编码'],['name','名称'],['orgName','组织'],['status','状态']])); break;
      case 'domain_ledger': lines.push(`当前筛选可用记录 ${d.total} 条。`, table(d.items, [['contractNo','合同编号'],['claimNo','报销单号'],['name','名称'],['title','标题'],['currentAmount','当前合同金额（元）'],['amount','金额（元）'],['status','状态']])); break;
      case 'domain_batch_read': lines.push(`指定来源批次 #${d.batch.id}，状态 ${d.batch.status}，${d.batch.period ?? d.batch.actualPeriod ?? d.batch.year}。`, d.kind === 'statement' ? table(d.items.flatMap((r: any) => r.facts.map((f: any) => ({ itemName: r.itemName, fieldName: f.fieldName, amount: f.amount }))), [['itemName','科目'],['fieldName','字段'],['amount','金额（元）']]) : d.kind === 'plan' ? table(d.items.flatMap((r: any) => r.facts.map((f: any) => ({ itemName: r.itemName, ...f }))), [['itemName','项目'],['fieldName','字段'],['valueType','数值类型'],['value','值（金额为元）']]) : d.kind === 'eas' ? table(d.items, [['accountName','科目'],['debit','借方（元）'],['credit','贷方（元）']]) : table(d.items, [['projectName','项目'],['budget','预算（元）'],['executed','执行（元）']])); break;
      case 'statement_trends': lines.push(table((d.points ?? []).map((r: any) => ({ period: r.period, batchId: r.batchId, revenue: r.metrics?.revenue_ytd, netProfit: r.metrics?.net_profit_ytd })), [['period','期间'],['batchId','批次'],['revenue','营业收入累计（元）'],['netProfit','净利润累计（元）']]), ...(d.missingPeriods?.length ? [`缺失期间：${d.missingPeriods.join('、')}，不补零。`] : [])); break;
      case 'domain_workspace': case 'mgmt_workspace': lines.push(`当前页签：${d.kind}。`, table(d.items, [['id','ID'],['name','名称'],['title','标题'],['period','期间'],['status','状态']])); break;
      case 'feasibility_report_read': lines.push(table(d.items, [['title','报告'],['projectName','项目'],['status','状态'],['stale','依据已过期']])); break;
      case 'task_status': lines.push(table(d.items, [['id','任务 ID'],['kind','类型'],['title','名称'],['status','状态'],['errorCode','错误码']])); break;
      case 'mgmt_analysis': lines.push('按所选指标、期间及分组读取保存的快照；数值、单位和来源见事实明细。'); break;
      case 'authorization_scope': lines.push(d.allOrgs ? '服务端授权为全部组织；各业务仍需对应操作权限。' : '只可查询服务端授权组织及其下级。', table(d.orgRoots, [['code','组织编码'],['name','组织名称']])); break;
      case 'configuration_overview': lines.push(table(d.channels, [['name','渠道'],['model','模型'],['enabled','启用']])); break;
    }
    if (Array.isArray(d.notes)) lines.push(...d.notes);
    const lists = [d, d.byProject, d.awaitingReview, d.openRisks, d.scenarios, d.projects, d.models, d.reports].filter(Boolean);
    if (lists.some((l) => l.hidden > 0)) lines.push('结果有条数限制，更多记录请在对应台账中查看。');
  }
  return lines.join('\n\n');
}

export function domainSuggestions(facts: FactRecord[], context: AssistantScope): string[] | null {
  const domain = facts.some(domainFact) || !!(context.pageKey && DOMAIN_PAGE_INTENTS[context.pageKey]);
  if (!domain) return null;
  const options: Record<string, string[]> = {
    contracts: ['查看合同付款节点与当前阶段阻碍', '打开合同台账'], expense: ['查看当前报销单审核发现与制度依据', '打开费用审核'],
    risk: ['查看当前高风险与逾期整改', '打开风险台账'], forecast: ['查看当前预测模型基准与情景运行', '打开财务预测'],
    feasibility: ['查看当前方案指标与未通过检查', '打开可行性测算'], project_profile: ['这个项目的预算执行、合同付款和风险情况如何', '打开项目全景'],
  };
  return options[context.pageKey ?? ''] ?? ['打开相关业务页面核对来源', '搜索“项目”'];
}
