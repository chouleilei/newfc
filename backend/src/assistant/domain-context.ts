/** 新领域上下文：ID 的命名空间独立，按页面同源 service 验证权限与归属。 */
import { getStatementBatch } from '../modules/statements/statement.service';
import { getProjectBudgetBatch } from '../modules/project-budget/project-budget.service';
import { getPlanBatch } from '../modules/plan-execution/plan.service';
import { getBatch as getEasBatch } from '../modules/eas/eas.service';
import { getFeasReport } from '../modules/investment/feasibility-report.service';
import { getJobFor } from '../modules/jobs/job.service';
import type { DB } from '../db/connection';
import { AppError } from '../core/errors';
import { currentAuth } from '../core/request-context';
import { assertOrgVisible, requirePermission } from '../modules/security/scope';
import { getProject } from '../modules/master/master.service';
import { getContractDetail } from '../modules/contracts/contract.service';
import { getClaimDetail } from '../modules/expense/expense.service';
import { getFeasProject, getFeasScenario } from '../modules/investment/feasibility.service';
import { getIcProject, getIcComparison } from '../modules/investment/control.service';
import { getForecastModel, getForecastVersion, getForecastRun } from '../modules/forecast/forecast.service';
import { getRiskEvent } from '../modules/risk/risk.service';
import { getAnalysisReport } from '../modules/analysis-reports/report.service';
import { getReport } from '../modules/standard-reports/standard-report.service';
import { getIssue } from '../modules/governance/governance.service';

import { DOMAIN_ID_FIELDS, type DomainIdField, type DomainContext } from './domain-scope';
export { DOMAIN_ID_FIELDS, DOMAIN_ENTITY_FIELDS, normalizeDomainContext } from './domain-scope';
export type { DomainContext, DomainIdField } from './domain-scope';

export function validateDomainContext(db: DB, c: DomainContext & { orgId?: number; year?: number; page?: string }): void {
  const auth = currentAuth();
  const permit = (p: Parameters<typeof requirePermission>[1]) => { if (auth) requirePermission(auth, p); };
  const relation = (field: DomainIdField, actual: number | null | undefined) => {
    if (c[field] != null && actual !== c[field]) throw new AppError('CONTEXT_CONFLICT', `${field} 与当前对象不属于同一业务范围`, 409);
  };
  // 组织过滤为子树范围；对象组织必须在该范围内。只查 ID，金额由 service 精确读取。
  const org = (id: number | null | undefined) => {
    if (id != null && auth) assertOrgVisible(db, auth, id);
    if (id != null && c.orgId != null && !db.prepare('WITH RECURSIVE sub(id) AS (SELECT ? UNION SELECT o.id FROM org o JOIN sub ON o.parent_id=sub.id) SELECT id FROM sub WHERE id=?').get(c.orgId, id)) {
      throw new AppError('CONTEXT_CONFLICT', '当前对象与指定组织范围不一致', 409);
    }
  };
  if (c.statementBatchId != null) { permit('statements:read'); org(getStatementBatch(db, c.statementBatchId).orgId); }
  if (c.projectBudgetBatchId != null) { permit('project_budget:read'); getProjectBudgetBatch(db, c.projectBudgetBatchId); }
  if (c.planBatchId != null) { permit('plan:read'); getPlanBatch(db, c.planBatchId); }
  if (c.easBatchId != null) { permit('eas:read'); org(getEasBatch(db, c.easBatchId).orgId); }
  if (c.feasReportId != null) { permit('investment:read'); const r = getFeasReport(db, c.feasReportId); relation('scenarioId', r.scenarioId); relation('feasProjectId', r.projectId); org(getFeasProject(db, r.projectId).orgId); }
  if (c.jobId != null) { permit('tasks:read'); getJobFor(db, auth, c.jobId); }
  if (c.projectId != null) { permit(c.page === 'project_budget' ? 'project_budget:read' : c.page === 'plan' ? 'plan:read' : c.page === 'contracts' ? 'contract:read' : 'project:read'); org(getProject(db, c.projectId).orgId); }
  if (c.contractId != null) { permit('contract:read'); const d = getContractDetail(db, c.contractId); org(d.orgId); relation('projectId', d.projectId); }
  if (c.claimId != null) { permit('expense:read'); org(getClaimDetail(db, c.claimId).orgId); }
  if (c.feasProjectId != null) { permit('investment:read'); org(getFeasProject(db, c.feasProjectId).orgId); }
  if (c.scenarioId != null) { permit('investment:read'); const d = getFeasScenario(db, c.scenarioId); org(d.project.orgId); relation('feasProjectId', d.project.id); }
  if (c.icProjectId != null) { permit('investment:read'); org(getIcProject(db, c.icProjectId).orgId); }
  if (c.comparisonId != null) { permit('investment:read'); const d = getIcComparison(db, c.comparisonId); relation('icProjectId', d.projectId); org(getIcProject(db, d.projectId).orgId); }
  if (c.modelId != null) { permit('forecast:read'); org(getForecastModel(db, c.modelId).orgId); }
  if (c.forecastVersionId != null) { permit('forecast:read'); const d = getForecastVersion(db, c.forecastVersionId); relation('modelId', d.modelId); org(getForecastModel(db, d.modelId).orgId); }
  if (c.forecastRunId != null) { permit('forecast:read'); const d = getForecastRun(db, c.forecastRunId); relation('forecastVersionId', d.versionId); const v = getForecastVersion(db, d.versionId); relation('modelId', v.modelId); org(getForecastModel(db, v.modelId).orgId); }
  if (c.riskId != null) { permit('risk:read'); org(getRiskEvent(db, c.riskId).orgId); }
  if (c.reportId != null) { permit('report:read'); const report = getAnalysisReport(db, c.reportId); if (auth && !['published', 'superseded'].includes(report.status) && report.createdByUserId !== auth.userId) throw new AppError('NOT_FOUND', '报告不存在或不在助手可读范围内', 404); org(report.orgId); }
  if (c.standardReportId != null) { permit('report:read'); org(getReport(db, c.standardReportId).orgId); }
  if (c.governanceIssueId != null) { permit('governance:read'); org(getIssue(db, c.governanceIssueId).orgId); }
  if (c.mgmtMetricId != null) {
    permit('mgmt:read');
    if (!db.prepare('SELECT id FROM ma_metric WHERE id=?').get(c.mgmtMetricId)) throw new AppError('NOT_FOUND', '管理会计指标不存在或无权访问', 404);
  }
}

/** 指定批次的期间来自已核验的来源；明确冲突不能被当前年度默认值掩盖。 */
export function domainBatchContext(db: DB, c: DomainContext & { orgId?: number; year?: number; page?: string }): { year?: number; period?: string; statementScope?: DomainContext['statementScope'] } {
  validateDomainContext(db, c);
  const sources = [
    c.statementBatchId == null ? null : (() => { const b = getStatementBatch(db, c.statementBatchId); return { period: b.period, year: Number(b.period.slice(0, 4)), statementScope: b.scope }; })(),
    c.projectBudgetBatchId == null ? null : getProjectBudgetBatch(db, c.projectBudgetBatchId),
    c.planBatchId == null ? null : (() => { const b = getPlanBatch(db, c.planBatchId); return { period: b.actualPeriod, year: b.year }; })(),
    c.easBatchId == null ? null : (() => { const b = getEasBatch(db, c.easBatchId); return { period: b.period, year: Number(b.period.slice(0, 4)) }; })(),
  ].filter((b) => b != null);
  if (!sources.length) return {};
  const first = sources[0];
  if (sources.some((b) => b.period !== first.period || b.year !== first.year) || (c.period != null && c.period !== first.period) || (c.year != null && c.year !== first.year)) throw new AppError('CONTEXT_CONFLICT', '指定批次与期间或年度不一致，请核对来源批次', 409);
  const statementScope = ('statementScope' in first ? first.statementScope : undefined) as DomainContext['statementScope'];
  if (statementScope && c.statementScope != null && c.statementScope !== statementScope) throw new AppError('CONTEXT_CONFLICT', '指定财报批次与报表口径不一致', 409);
  return { year: first.year, period: first.period, ...(statementScope ? { statementScope } : {}) };
}
