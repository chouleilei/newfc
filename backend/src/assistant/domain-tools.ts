import { z } from 'zod';
import { maAnalysisQuery } from '../contracts/mgmt';
import { AppError } from '../core/errors';
import type { DB } from '../db/connection';
import { listContractsPage } from '../modules/contracts/contract.service';
import { listFeasProjects } from '../modules/investment/feasibility.service';
import { listIcProjects } from '../modules/investment/control.service';
import { contractListQuery } from '../contracts/project-contract';
import { claimListQuery } from '../contracts/expense';
import { riskListQuery } from '../contracts/risk';
import { rptListQuery } from '../contracts/analysis-reports';
import { requirePermission } from '../modules/security/scope';
import { getStatementBatch, statementItems, statementTrends } from '../modules/statements/statement.service';
import { getProjectBudgetBatch, projectBudgetEntries } from '../modules/project-budget/project-budget.service';
import { getPlanBatch, planItems } from '../modules/plan-execution/plan.service';
import { getBatch as getEasBatch, batchLines, listLocks, listCorrections, listAuxRequirements } from '../modules/eas/eas.service';
import { responsibilityCenters } from '../modules/mgmt/center.service';
import { listMetrics, analyze } from '../modules/mgmt/metric.service';
import { listDimensions } from '../modules/mgmt/dimension.service';
import { listPools } from '../modules/mgmt/allocation.service';
import { listScores } from '../modules/mgmt/performance.service';
import { listBudgetAdjustments } from '../modules/mgmt/budget-adjust.service';
import { getFeasReport, listFeasReports } from '../modules/investment/feasibility-report.service';
import { listForecastPublications, listForecastReviewQueue } from '../modules/forecast/forecast-workflow.service';
import { listRiskScans, listRiskRules } from '../modules/risk/risk.service';
import { currentAuth } from '../core/request-context';
import { getProjectProfile } from '../modules/master/project-profile.service';
import { listProjects, listSuppliers } from '../modules/master/master.service';
import { getClaimDetail, listPolicies, listClaimsPage } from '../modules/expense/expense.service';
import { getIssue, listIssues } from '../modules/governance/governance.service';
import { getReport, listReports } from '../modules/standard-reports/standard-report.service';
import { getAnalysisReport, redactDeep, reportListForAssistant } from '../modules/analysis-reports/report.service';
import { getRiskEvent, listRiskEvents } from '../modules/risk/risk.service';
import { getForecastVersion, getForecastRun, compareForecastRun, listForecastModels } from '../modules/forecast/forecast.service';
import { getJobFor, listJobsFor } from '../modules/jobs/job.service';
import { listBusinessSettings } from '../modules/settings/business-settings';
import { listChannels, listBindings } from '../modules/settings/ai-channels.service';
import { GOV_ISSUE_STATUSES, GOV_SOURCE_TYPES } from '../contracts/governance';
import { STD_REPORT_TYPES } from '../contracts/standard-reports';
import { defineTools } from './tool-definition';
const bounded = <T>(rows: T[], limit = 30) => ({ items: rows.slice(0, limit), total: rows.length, hidden: Math.max(0, rows.length - limit) });
function within(db: DB, root: number | undefined, org: number | null) {
  return root == null || (org != null && !!db.prepare('WITH RECURSIVE sub(id) AS (SELECT ? UNION SELECT o.id FROM org o JOIN sub ON o.parent_id=sub.id) SELECT id FROM sub WHERE id=?').get(root, org));
}
const permit = (permission: Parameters<typeof requirePermission>[1]) => { const auth = currentAuth(); if (auth) requirePermission(auth, permission); };

export const DOMAIN_TOOL_DEFINITIONS = defineTools({
  domain_ledger: {
    label: "当前台账筛选结果",
    capabilities: ["domain_support"], universal: false,
    policy: (p: any) => ({ permission: ({ contracts: 'contract:read', expense: 'expense:read', forecast: 'forecast:read', risk: 'risk:read', feasibility: 'investment:read', investment: 'investment:read', reports: 'report:read' } as const)[p.kind as 'contracts'], scope: 'org_scope' as const }),
    schema: z.object({ orgScopeId: z.number().int().safe().min(1).optional(), kind: z.enum(["contracts","expense","forecast","risk","feasibility","investment","reports"]), status: z.string().min(1).max(64).optional(), keyword: z.string().min(1).max(64).optional(), level: z.string().min(1).max(64).optional(), folder: z.string().min(1).max(64).optional(), reportKind: z.string().min(1).max(64).optional(), projectId: z.number().int().safe().min(1).optional(), todo: z.string().min(1).max(64).optional(), stage: z.string().min(1).max(64).optional() }).strict(),
    execute: (db: DB, p: any) => {
    permit(({ contracts: 'contract:read', expense: 'expense:read', forecast: 'forecast:read', risk: 'risk:read', feasibility: 'investment:read', investment: 'investment:read', reports: 'report:read' } as const)[p.kind as 'contracts']);
    const q = { orgId: p.orgScopeId, status: p.status, keyword: p.keyword };
    let rows: any[], total: number | undefined;
    if (p.kind === 'contracts') { const result = listContractsPage(db, { ...contractListQuery.parse({ ...q, projectId: p.projectId, todo: p.todo, stage: p.stage }), page: 1, pageSize: 30 }); rows = result.items; total = result.total; }
    else if (p.kind === 'expense') { const result = listClaimsPage(db, { ...claimListQuery.parse(q), page: 1, pageSize: 30 }); rows = result.items.map(({ id, claimNo, orgName, amount, status, expenseType, occurredDate }) => ({ id, claimNo, orgName, amount, status, expenseType, occurredDate })); total = result.total; }
    else if (p.kind === 'forecast') rows = listForecastModels(db, { ...q, status: p.status, folder: p.folder }).items;
    else if (p.kind === 'feasibility') rows = listFeasProjects(db, { ...q, status: p.status }).items;
    else if (p.kind === 'investment') rows = listIcProjects(db, { ...q, status: p.status }).items;
    else if (p.kind === 'risk') rows = listRiskEvents(db, riskListQuery.parse({ ...q, level: p.level }));
    else rows = reportListForAssistant(db, rptListQuery.parse({ ...q, kind: p.reportKind }));
    const b = bounded(redactDeep(rows));
    return { kind: p.kind, filters: q, ...b, ...(total != null ? { total, hidden: Math.max(0, total - b.items.length) } : {}), notes: ['按当前筛选读取授权台账；金额为元，最多展示 30 条，未汇总这些行之外的金额；固定上限列表不声称为全库总数'] };
  },
  },
  domain_batch_read: {
    label: "指定来源批次",
    capabilities: ["domain_support"], universal: false,
    policy: (p: any) => ({ permission: ({ statement: 'statements:read', project_budget: 'project_budget:read', plan: 'plan:read', eas: 'eas:read' } as const)[p.kind as 'statement'], scope: 'org_scope' as const }),
    schema: z.object({ kind: z.enum(["statement","project_budget","plan","eas"]), batchId: z.number().int().safe().min(1), orgScopeId: z.number().int().safe().min(1).optional() }).strict(),
    execute: (db: DB, p: any) => {
    permit(({ statement: 'statements:read', project_budget: 'project_budget:read', plan: 'plan:read', eas: 'eas:read' } as const)[p.kind as 'statement']);
    if (p.kind === 'statement') { const batch = getStatementBatch(db, p.batchId); if (!within(db, p.orgScopeId, batch.orgId)) throw new AppError('CONTEXT_CONFLICT', '批次与组织范围不一致', 409); return { kind: p.kind, batch, ...bounded(statementItems(db, p.batchId)), notes: ['指定历史批次的原始事实（元）；不替换为当前生效批次'] }; }
    if (p.kind === 'project_budget') return { kind: p.kind, batch: getProjectBudgetBatch(db, p.batchId), ...bounded(projectBudgetEntries(db, p.batchId).filter((r) => within(db, p.orgScopeId, r.orgId))), notes: ['指定批次的授权明细；金额为元，未经激活的批次不是当前业务口径'] };
    if (p.kind === 'plan') return { kind: p.kind, batch: getPlanBatch(db, p.batchId), ...bounded(planItems(db, p.batchId).filter((r) => within(db, p.orgScopeId, r.orgId))), notes: ['原始计划事实：金额为元，数量/比率按明细 valueType 与 fieldName；不按历史批次推算当前执行率'] };
    const batch = getEasBatch(db, p.batchId); if (!within(db, p.orgScopeId, batch.orgId)) throw new AppError('CONTEXT_CONFLICT', '批次与组织范围不一致', 409);
    const result = batchLines(db, p.batchId, 1, 30); return { kind: p.kind, batch, items: result.lines, total: result.total, notes: ['EAS 原始批次，最多展示 30 行；不重新对账、不激活、不加锁'] };
  },
  },
  statement_trends: {
    label: "财务报表趋势",
    capabilities: ["domain_support"], universal: false,
    policy: {"permission":"statements:read","scope":"org_scope"},
    schema: z.object({ orgScopeId: z.number().int().safe().min(1).optional(), from: z.string().max(200).optional(), to: z.string().max(200).optional(), scope: z.enum(["parent","subsidiary","consolidated"]).optional() }).strict(),
    execute: (db: DB, p: any) => statementTrends(db, { orgId: p.orgScopeId, from: p.from, to: p.to, scope: p.scope }),
  },
  mgmt_analysis: {
    label: "管理会计多维分析",
    capabilities: ["domain_support"], universal: false,
    policy: {"permission":"mgmt:read","scope":"org_scope"},
    schema: z.object({ orgScopeId: z.number().int().safe().min(1).optional(), metricIds: z.array(z.number().int().safe().min(1)).min(1).max(50), periods: z.array(z.string().max(200)).min(1).max(36), groupBy: z.enum(["org","dimension"]).optional(), dimensionId: z.number().int().safe().min(1).optional() }).strict(),
    execute: (db: DB, p: any) => {
    permit('mgmt:read');
    const orgIds = p.orgScopeId ? (db.prepare('WITH RECURSIVE sub(id) AS (SELECT id FROM org WHERE id=? UNION SELECT o.id FROM org o JOIN sub ON o.parent_id=sub.id) SELECT id FROM sub').all(p.orgScopeId) as { id: number }[]).map((r) => r.id) : undefined;
    return analyze(db, maAnalysisQuery.parse({ metricIds: p.metricIds, periods: p.periods, groupBy: p.groupBy, dimensionId: p.dimensionId, orgIds }));
  },
  },
  mgmt_workspace: {
    label: "管理会计页签事实",
    capabilities: ["domain_support"], universal: false,
    policy: {"permission":"mgmt:read","scope":"org_scope"},
    schema: z.object({ orgScopeId: z.number().int().safe().min(1).optional(), period: z.string().max(200).regex(/^\d{4}(?:-(?:0[1-9]|1[0-2]))?$/).optional(), status: z.string().min(1).max(64).optional(), schemeId: z.number().int().safe().min(1).optional(), kind: z.enum(["centers","metrics","dimensions","allocation","performance","budget-adjust"]) }).strict(),
    execute: (db: DB, p: any) => {
    permit('mgmt:read');
    let rows: any[];
    switch (p.kind) {
      case 'centers': if (!p.period) throw new Error('责任中心需指定期间'); rows = responsibilityCenters(db, { period: p.period, orgId: p.orgScopeId }); break;
      case 'metrics': rows = listMetrics(db, {}); break;
      case 'dimensions': rows = listDimensions(db); break;
      case 'allocation': rows = listPools(db, { period: p.period, orgId: p.orgScopeId }); break;
      case 'performance': rows = listScores(db, { period: p.period, orgId: p.orgScopeId, schemeId: p.schemeId }); break;
      default: rows = listBudgetAdjustments(db, { status: p.status });
    }
    return { kind: p.kind, period: p.period, ...bounded(redactDeep(rows)), notes: ['读取已保存的结果与配置；不计算、不分摊、不评分、不审批'] };
  },
  },
  domain_workspace: {
    label: "业务页签记录",
    capabilities: ["domain_support"], universal: false,
    policy: (p: any) => ({ permission: p.kind.startsWith('eas_') ? 'eas:read' as const : p.kind.startsWith('risk_') ? 'risk:read' as const : p.kind === 'forecast_reviews' ? 'forecast:review' as const : 'forecast:read' as const, scope: 'org_scope' as const }),
    schema: z.object({ orgScopeId: z.number().int().safe().min(1).optional(), period: z.string().max(200).regex(/^\d{4}(?:-(?:0[1-9]|1[0-2]))?$/).optional(), status: z.string().min(1).max(64).optional(), pendingOnly: z.boolean().optional(), includeWithdrawn: z.boolean().optional(), kind: z.enum(["eas_locks","eas_corrections","eas_aux","risk_scans","risk_rules","forecast_reviews","forecast_publications"]) }).strict(),
    execute: (db: DB, p: any) => {
    const kind: string = p.kind;
    permit(kind.startsWith('eas_') ? 'eas:read' : kind.startsWith('risk_') ? 'risk:read' : kind === 'forecast_reviews' ? 'forecast:review' : 'forecast:read');
    const rows: any[] = kind === 'eas_locks' ? listLocks(db) : kind === 'eas_corrections' ? listCorrections(db, { status: p.pendingOnly ? 'pending' : p.status }) : kind === 'eas_aux' ? listAuxRequirements(db, p.orgScopeId) : kind === 'risk_scans' ? listRiskScans(db) : kind === 'risk_rules' ? listRiskRules(db) : kind === 'forecast_reviews' ? listForecastReviewQueue(db, { orgId: p.orgScopeId }).items : listForecastPublications(db, { orgId: p.orgScopeId, includeWithdrawn: p.includeWithdrawn ? '1' : '0' }).items;
    return { kind, ...bounded(redactDeep(rows.filter((r) => r.orgId == null || within(db, p.orgScopeId, r.orgId)).filter((r) => !p.period || !r.period || r.period === p.period))), notes: ['只读已保存记录；不锁期、不扫描、不复核、不发布'] };
  },
  },
  feasibility_report_read: {
    label: "可行性报告",
    capabilities: ["domain_support"], universal: false,
    policy: {"permission":"investment:read","scope":"global"},
    schema: z.object({ reportId: z.number().int().safe().min(1).optional(), projectId: z.number().int().safe().min(1).optional(), scenarioId: z.number().int().safe().min(1).optional(), status: z.string().min(1).max(64).optional() }).strict(),
    execute: (db: DB, p: any) => {
    permit('investment:read');
    const rows = p.reportId ? [getFeasReport(db, p.reportId)] : listFeasReports(db, { projectId: p.projectId, scenarioId: p.scenarioId, status: p.status }).items;
    return { ...bounded(redactDeep(rows.map((r) => ({ id: r.id, title: r.title, projectId: r.projectId, projectName: r.projectName, scenarioId: r.scenarioId, runId: r.runId, parameterHash: r.parameterHash, status: r.status, stale: r.stale, content: r.content.slice(0, 4000), truncated: r.content.length > 4000, createdAt: r.createdAt })))), notes: ['报告文本是历史分析，不作为新的金额事实；过期依据明确标记，不生成或批准报告'] };
  },
  },
  project_profile: {
    label: "项目全景",
    capabilities: ["domain_support"], universal: false,
    policy: {"permission":"project:read","scope":"global"},
    schema: z.object({ projectId: z.number().int().safe().min(1) }).strict(),
    execute: (db: DB, p: any) => {
    const d = getProjectProfile(db, p.projectId);
    // 不发送项目扩展字段或操作人文本。分节已由 service 按领域权限裁剪。
    return { ...d, project: { id: d.project.id, code: d.project.code, name: d.project.name, orgId: d.project.orgId, orgName: d.project.orgName, status: d.project.status }, logs: null };
  },
  },
  master_entities: {
    label: "项目与供应商目录",
    capabilities: ["domain_support"], universal: false,
    policy: {"permission":"master:read","scope":"org_scope"},
    schema: z.object({ orgScopeId: z.number().int().safe().min(1).optional(), keyword: z.string().min(1).max(64).optional(), kind: z.enum(["project","supplier"]).optional() }).strict(),
    execute: (db: DB, p: any) => {
    const rows = p.kind === 'supplier' ? listSuppliers(db, { keyword: p.keyword }).map(({ id, code, name, status }) => ({ id, code, name, status }))
      : listProjects(db, { keyword: p.keyword }).filter((r) => within(db, p.orgScopeId, r.orgId)).map(({ id, code, name, orgName, status }) => ({ id, code, name, orgName, status }));
    return { kind: p.kind ?? 'project', ...bounded(rows), notes: ['目录为当前主数据；不等于经营预算组织/科目树'] };
  },
  },
  expense_detail: {
    label: "报销审核详情",
    capabilities: ["domain_support"], universal: false,
    policy: {"permission":"expense:read","scope":"global"},
    schema: z.object({ claimId: z.number().int().safe().min(1) }).strict(),
    execute: (db: DB, p: any) => {
    const d = getClaimDetail(db, p.claimId);
    const run = d.runs.find((r) => r.id === d.currentRunId);
    return redactDeep({ id: d.id, claimNo: d.claimNo, orgName: d.orgName, expenseType: d.expenseType, amount: d.amount, occurredDate: d.occurredDate, status: d.status,
      conclusion: d.conclusion, reviewVersion: d.reviewVersion, currentRunId: d.currentRunId,
      lines: bounded(d.lines.map((l) => ({ id: l.id, expenseType: l.expenseType, amount: l.amount }))),
      audit: run ? { id: run.id, createdAt: run.createdAt, riskLevel: run.riskLevel, ocrStatus: run.ocrStatus, modelStatus: run.modelStatus,
        policyRefs: run.policyRefs, findings: bounded(run.findings.map((f) => ({ code: f.code, severity: f.severity, message: f.message, clauseId: f.clauseId, clauseLabel: f.clauseLabel,
          evidence: f.evidence.map((e) => ({ kind: e.kind, ref: e.ref })) }))) } : null,
      reviews: d.reviews.map((r) => ({ id: r.id, runId: r.runId, conclusion: r.conclusion, createdAt: r.createdAt })),
      notes: run ? ['审核发现为待人工复核的建议，不代表批准报销'] : ['当前内容尚无有效审核结果；历史审核运行不能替代当前结论'] });
  },
  },
  policy_search: {
    label: "制度条款检索",
    capabilities: ["domain_support"], universal: false,
    policy: {"permission":"expense:read","scope":"global"},
    schema: z.object({ q: z.string().min(1).max(64).optional(), date: z.string().max(200).regex(/^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/).optional(), expenseType: z.string().min(1).max(64).optional(), includeRetired: z.boolean().optional() }).strict(),
    execute: (db: DB, p: any) => {
    const q = p.q ?? '';
    const rows = listPolicies(db, { includeRetired: p.includeRetired }).flatMap((policy) => policy.clauses.filter((c) =>
      (!p.expenseType || c.expenseTypes.length === 0 || c.expenseTypes.includes(p.expenseType)) &&
      (!p.date || (policy.effectiveFrom <= p.date && (policy.effectiveTo == null || p.date <= policy.effectiveTo))) &&
      (!q || [policy.title, policy.code, c.clauseNo, c.clauseText].some((s) => String(s ?? '').includes(q)))
    ).map((clause) => ({ policyId: policy.id, policyCode: policy.code, policyName: policy.title, version: policy.version, status: policy.status,
      effectiveFrom: policy.effectiveFrom, effectiveTo: policy.effectiveTo, hasSource: policy.hasSource, ...clause })));
    return { query: q, ...bounded(rows), notes: ['关键词检索，不是语义检索；条款摘要不等于完整正式制度。请核对版本、生效期和来源定位；无命中不代表合规。'] };
  },
  },
  governance_issues: {
    label: "数据治理问题",
    capabilities: ["domain_support"], universal: false,
    policy: {"permission":"governance:read","scope":"org_scope"},
    schema: z.object({ orgScopeId: z.number().int().safe().min(1).optional(), period: z.string().max(200).regex(/^\d{4}(?:-(?:0[1-9]|1[0-2]))?$/).optional(), status: z.enum(["open","pending_review","resolved","dismissed"]).optional(), sourceType: z.enum(["eas_recon","eas_master","statement"]).optional(), issueId: z.number().int().safe().min(1).optional() }).strict(),
    execute: (db: DB, p: any) => {
    const rows = p.issueId ? [getIssue(db, p.issueId)] : listIssues(db, { period: p.period, status: p.status, sourceType: p.sourceType });
    return { ...bounded(rows.filter((r) => within(db, p.orgScopeId, r.orgId)).map((r) => ({ id: r.id, title: r.title, sourceType: r.sourceType, sourceRef: r.sourceRef, sourceHash: r.sourceHash, orgName: r.orgName, period: r.period, status: r.status, severity: r.severity, version: r.version, lastSeenAt: r.lastSeenAt }))), notes: ['列表反映已有扫描结果，不触发扫描或自动处置；最多读取 service 的前 500 条'] };
  },
  },
  standard_report_read: {
    label: "冻结标准报表",
    capabilities: ["domain_support"], universal: false,
    policy: {"permission":"report:read","scope":"org_scope"},
    schema: z.object({ orgScopeId: z.number().int().safe().min(1).optional(), period: z.string().max(200).regex(/^\d{4}(?:-(?:0[1-9]|1[0-2]))?$/).optional(), reportId: z.number().int().safe().min(1).optional(), reportType: z.enum(["budget_execution","statement_summary","eas_recon","contract_payment_ledger","risk_rectification_ledger"]).optional() }).strict(),
    execute: (db: DB, p: any) => {
    if (p.reportId) { const d = getReport(db, p.reportId); return { report: { id: d.id, title: d.title, period: d.period, orgName: d.orgName, status: d.status, generatedAt: d.generatedAt, contentSha256: d.contentSha256 }, summary: d.summary, sources: d.sources, columns: d.columns, ...bounded(d.rows) }; }
    return { ...bounded(listReports(db, { period: p.period, reportType: p.reportType }).filter((r) => within(db, p.orgScopeId, r.orgId))), notes: ['只读已生成的冻结报表；不会生成、复核或导出新报表'] };
  },
  },
  analysis_report_read: {
    label: "分析报告详情",
    capabilities: ["domain_support"], universal: false,
    policy: {"permission":"report:read","scope":"global"},
    schema: z.object({ reportId: z.number().int().safe().min(1) }).strict(),
    execute: (db: DB, p: any) => {
    const d = getAnalysisReport(db, p.reportId);
    const auth = currentAuth();
    if (auth && !['published', 'superseded'].includes(d.status) && d.createdByUserId !== auth.userId) throw new AppError('NOT_FOUND', '报告不存在或不在助手可读范围内', 404);
    return redactDeep({ id: d.id, title: d.title, kind: d.kind, status: d.status, revisionNo: d.revisionNo, orgName: d.orgName, year: d.year, publishedAt: d.publishedAt,
      sections: d.sections.map((s) => ({ title: s.title, body: s.body.slice(0, 4000), truncated: s.body.length > 4000, citations: s.citations })), publication: d.publication ? { snapshotSha256: d.publication.snapshotSha256, createdAt: d.publication.createdAt } : null });
  },
  },
  risk_detail: {
    label: "风险详情与整改",
    capabilities: ["domain_support"], universal: false,
    policy: {"permission":"risk:read","scope":"global"},
    schema: z.object({ riskId: z.number().int().safe().min(1) }).strict(),
    execute: (db: DB, p: any) => {
    const d = getRiskEvent(db, p.riskId);
    return redactDeep({ id: d.id, title: d.title, ruleCode: d.ruleCode, level: d.level, status: d.status, orgName: d.orgName, amount: d.amount,
      deadline: d.deadline, overdue: d.overdue, evidence: d.evidence, actions: d.actions.map((a) => ({ action: a.action, createdAt: a.createdAt })),
      notes: ['整改、提交复核和关闭风险均由页面显式操作完成；工具不重新扫描'] });
  },
  },
  forecast_result: {
    label: "指定预测版本或运行",
    capabilities: ["domain_support"], universal: false,
    policy: {"permission":"forecast:read","scope":"global"},
    schema: z.object({ versionId: z.number().int().safe().min(1).optional(), runId: z.number().int().safe().min(1).optional() }).strict(),
    execute: (db: DB, p: any) => {
    if (p.runId) { const r = getForecastRun(db, p.runId); let comparison = null; if (r.kind === 'scenario' && r.status === 'succeeded') comparison = compareForecastRun(db, r.id); const version = getForecastVersion(db, r.versionId); if (p.versionId && version.id !== p.versionId) throw new AppError('CONTEXT_CONFLICT', '运行与预测版本不一致', 409); return { run: { id: r.id, versionId: r.versionId, kind: r.kind, scenarioName: r.scenarioName, status: r.status, outputs: r.outputs, createdAt: r.createdAt, errorCode: r.errorCode }, version: { id: version.id, modelId: version.modelId, versionNo: version.versionNo, status: version.status, reviewStatus: version.reviewStatus }, comparison }; }
    if (p.versionId) return { version: getForecastVersion(db, p.versionId) };
    throw new Error('请指定预测 versionId 或 runId，不能把经营预算版本用作财务预测版本');
  },
  },
  task_status: {
    label: "任务状态",
    capabilities: ["domain_support"], universal: false,
    policy: {"permission":"tasks:read","scope":"global"},
    schema: z.object({ jobId: z.number().int().safe().min(1).optional(), status: z.enum(["queued","running","succeeded","failed","cancelled","interrupted"]).optional() }).strict(),
    execute: (db: DB, p: any) => {
    const rows = p.jobId ? [getJobFor(db, currentAuth(), p.jobId)] : listJobsFor(db, currentAuth(), { status: p.status, pageSize: 30 }).items;
    return bounded(rows.map((r) => ({ id: r.id, kind: r.kindLabel, title: r.title, status: r.status, progress: r.progress, errorCode: r.error?.code, createdAt: r.createdAt, finishedAt: r.finishedAt })));
  },
  },
  authorization_scope: {
    label: "我的查询权限与组织范围",
    capabilities: ["domain_support"], universal: false,
    policy: {"permission":"assistant:use","scope":"global"},
    schema: z.object({  }).strict(),
    execute: (db: DB) => { const auth = currentAuth(); return { allOrgs: auth?.allOrgs ?? false, permissions: [...(auth?.permissions ?? [])].filter((p) => /:read$|search:use/.test(p)), orgRoots: (auth?.orgRootIds ?? []).map((id) => db.prepare('SELECT id,code,name FROM org WHERE id=?').get(id)), notes: ['范围来自服务端登录身份，客户端不能扩大；同源页面、任务、搜索与助手逐次校验权限，范围外对象按不存在处理'] }; },
  },
  configuration_overview: {
    label: "配置与模型能力",
    capabilities: ["domain_support"], universal: false,
    policy: {"permission":"settings:read","scope":"global"},
    schema: z.object({  }).strict(),
    execute: (db: DB) => ({
    settings: listBusinessSettings(db).filter((s) => !s.key.startsWith('integration.')).map((s) => ({ label: s.label, value: s.value })),
    channels: listChannels(db).map((c) => ({ id: c.id, name: c.name, model: c.model, enabled: c.enabled })), bindings: listBindings(db).map((b) => ({ feature: b.feature, enabled: b.primaryChannelId != null })),
    notes: ['不返回密钥、账号、服务地址、余额或网络连接信息；配置修改在设置页面确认'] }),
  },
});
