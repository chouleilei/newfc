import { DOMAIN_ID_FIELDS, type DomainContext, type DomainIdField } from '../contracts/assistant';
/** 助手跨域上下文的纯类型、白名单与格式校验；不加载业务服务。 */
export function normalizeDomainContext(raw: Record<string, unknown>): DomainContext {
  const out: DomainContext = {};
  for (const field of DOMAIN_ID_FIELDS) {
    if (raw[field] == null || raw[field] === '') continue;
    const v = raw[field];
    if ((typeof v !== 'number' && typeof v !== 'string') || !Number.isSafeInteger(Number(v)) || Number(v) <= 0) throw new Error(`${field} 必须是正整数`);
    out[field] = Number(v);
  }
  if (raw.period != null && raw.period !== '') {
    if (typeof raw.period !== 'string' || !/^(?:19|20|[3-9]\d)\d{2}(?:-(?:0[1-9]|1[0-2]))?$/.test(raw.period)) throw new Error('period 必须是 YYYY 或 YYYY-MM');
    out.period = raw.period;
  }
  for (const field of ['periodFrom', 'periodTo'] as const) { if (raw[field] != null) { if (typeof raw[field] !== 'string' || !/^(?:19|20)\d{2}-(?:0[1-9]|1[0-2])$/.test(raw[field] as string)) throw new Error(`${field} 必须是 YYYY-MM`); out[field] = raw[field] as string; } }
  if (out.periodFrom && out.periodTo && out.periodFrom > out.periodTo) throw new Error('趋势起始期间不能晚于截止期间');
  if (raw.statementScope != null) {
    if (!['parent', 'subsidiary', 'consolidated'].includes(String(raw.statementScope))) throw new Error('statementScope 不合法');
    out.statementScope = raw.statementScope as DomainContext['statementScope'];
  }
  return out;
}

export const DOMAIN_ENTITY_FIELDS: Record<string, DomainIdField> = {
  statement_batch: 'statementBatchId', project_budget_batch: 'projectBudgetBatchId', plan_batch: 'planBatchId', eas_batch: 'easBatchId', feasibility_report: 'feasReportId', job: 'jobId', project: 'projectId', contract: 'contractId', expense_claim: 'claimId', feasibility_project: 'feasProjectId', feasibility_scenario: 'scenarioId',
  investment_project: 'icProjectId', investment_comparison: 'comparisonId', forecast_model: 'modelId', forecast_version: 'forecastVersionId', forecast_run: 'forecastRunId',
  risk_event: 'riskId', analysis_report: 'reportId', standard_report: 'standardReportId', governance_issue: 'governanceIssueId', mgmt_metric: 'mgmtMetricId',
};
