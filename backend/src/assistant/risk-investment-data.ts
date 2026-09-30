/**
 * T-5 投资、预测、风险与报告的助手只读视图(AC-F11/F12/F13/F17/F18)。
 *
 * 边界同 project-data.ts:
 * - 只读,调用页面同源 service;组织范围由 tool-policy 的 org_scope 改写 orgScopeId,service 再按 AuthContext 裁剪(范围外 404);
 * - 写操作(测算、导入、确认、扫描、状态流转、审批、发布)不暴露给助手;
 * - 有界:列表截断到固定条数并给出隐藏条数;风险证据、报告正文等长文本不下发。
 */
import type { DB } from '../db/connection';
import { getFeasRun, getFeasScenario, listFeasProjects, getFeasProject } from '../modules/investment/feasibility.service';
import { getIcComparison, listIcComparisons, listIcProjects } from '../modules/investment/control.service';
import { compareForecastRun, getForecastModel, listForecastModels, listForecastRuns } from '../modules/forecast/forecast.service';
import { listRiskEvents, riskSummary } from '../modules/risk/risk.service';
import { reportListForAssistant } from '../modules/analysis-reports/report.service';
import type { RptKind } from '../contracts/analysis-reports';
import type { FeasIndicatorDto, FeasResultDto } from '../contracts/investment-feasibility';

const ROW_LIMIT = 30;
function bounded<T>(rows: T[], limit = ROW_LIMIT): { items: T[]; total: number; hidden: number } {
  return { items: rows.slice(0, limit), total: rows.length, hidden: Math.max(0, rows.length - limit) };
}

function subtree(db: DB, orgId: number | null): Set<number> | null {
  if (orgId == null) return null;
  return new Set((db.prepare('WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT o.id FROM org o JOIN sub ON o.parent_id = sub.id) SELECT id FROM sub').all(orgId) as { id: number }[]).map((r) => r.id));
}

const KEY_INDICATORS = ['project_npv', 'project_irr', 'equity_irr', 'min_dscr', 'peak_funding_gap', 'affordability_score'];
function indicatorView(indicators: FeasIndicatorDto[] | null, all = false) {
  return (indicators ?? []).filter((i) => all || KEY_INDICATORS.includes(i.code)).map((i) => ({ code: i.code, name: i.name, value: i.value, unit: i.unit, status: i.status }));
}

/** 可行性测算:scenarioId 给出单方案最新基准运行的全部指标与未通过检查;否则列出范围内项目各方案最新基准运行的关键指标。 */
export function feasibilityResultView(db: DB, input: { orgScopeId: number | null; projectId?: number; scenarioId?: number }) {
  if (input.scenarioId) {
    const s = getFeasScenario(db, input.scenarioId);
    const run = s.latestRun ? getFeasRun(db, s.latestRun.id) : null;
    const result = run?.status === 'succeeded' ? run.result as FeasResultDto : null;
    return {
      scenario: { id: s.id, code: s.code, name: s.name, stale: s.stale, project: { id: s.project.id, code: s.project.code, name: s.project.name } },
      latestRun: run ? {
        id: run.id, status: run.status, createdAt: run.createdAt, parameterHash: run.parameterHash, errorMessage: run.errorMessage,
        allChecksPassed: run.allChecksPassed, indicators: indicatorView(result?.indicators ?? null, true),
        failedChecks: (result?.checks ?? []).filter((c) => !c.passed).map((c) => ({ code: c.code, severity: c.severity, message: c.message })),
      } : null,
      notes: [...(run ? [] : ['该方案尚未测算']), ...(s.stale ? ['参数已修改或最新测算失败,结果需重算'] : [])],
    };
  }
  const orgs = subtree(db, input.orgScopeId);
  const projects = listFeasProjects(db, {}).items.filter((p) => (!orgs || orgs.has(p.orgId)) && (!input.projectId || p.id === input.projectId));
  const rows = projects.flatMap((p) => getFeasProject(db, p.id).scenarios.map((s) => ({
    projectId: p.id, projectCode: p.code, projectName: p.name, scenarioId: s.id, scenarioName: s.name, stale: s.stale,
    runId: s.latestRun?.id ?? null, runStatus: s.latestRun?.status ?? null, runAt: s.latestRun?.createdAt ?? null,
    allChecksPassed: s.latestRun?.allChecksPassed ?? null, indicators: indicatorView(s.latestRun?.indicators ?? null),
  })));
  return { scenarios: bounded(rows), notes: ['金额单位为万元,比率为 6 位小数;stale=true 表示参数已修改或未成功测算'] };
}

/** 投资控制:comparisonId 给出单快照摘要与偏差最大的科目;否则列出范围内项目的最新对比快照摘要。 */
export function investmentComparisonView(db: DB, input: { orgScopeId: number | null; projectId?: number; comparisonId?: number }) {
  if (input.comparisonId) {
    const c = getIcComparison(db, input.comparisonId);
    const rows = (c.rows ?? []).filter((r) => r.alertLevel === 'exceed' || r.alertLevel === 'warning' || r.status !== 'compared');
    return { comparison: { id: c.id, projectId: c.projectId, summary: c.summary, contentSha256: c.contentSha256, createdAt: c.createdAt }, flaggedRows: bounded(rows) };
  }
  const orgs = subtree(db, input.orgScopeId);
  const projects = listIcProjects(db, { status: 'active' }).items.filter((p) => (!orgs || orgs.has(p.orgId)) && (!input.projectId || p.id === input.projectId));
  const rows = projects.map((p) => {
    const latest = listIcComparisons(db, p.id).items[0];
    return {
      projectId: p.id, projectCode: p.code, projectName: p.name, comparisonId: latest?.id ?? null,
      totalDeviation: latest?.summary.totalDeviation ?? null, totalDeviationRate: latest?.summary.totalDeviationRate ?? null, totalLevel: latest?.summary.totalLevel ?? null,
      exceedCount: latest?.summary.exceedCount ?? null, controlChain: latest?.summary.controlChain.map((x) => x.message) ?? [],
    };
  });
  return { projects: bounded(rows), notes: ['偏差 = 目标 − 基准(静态投资,元);偏差率为 6 位小数;没有快照的项目 comparisonId 为 null'] };
}

/** 财务预测:modelId 给出各版本的运行(含情景与基准差异);否则列出范围内模型及最新基准运行状态。 */
export function forecastRunsView(db: DB, input: { orgScopeId: number | null; modelId?: number }) {
  if (input.modelId) {
    const m = getForecastModel(db, input.modelId);
    const versions = m.versions.slice(0, 5).map((v) => {
      const runs = listForecastRuns(db, v.id).items.slice(0, 10).map((r) => {
        const base = { id: r.id, kind: r.kind, scenarioName: r.scenarioName, status: r.status, errorCode: r.errorCode, outputs: r.outputs, createdAt: r.createdAt };
        if (r.kind === 'scenario' && r.status === 'succeeded') {
          try { return { ...base, comparison: compareForecastRun(db, r.id) }; } catch { return base; }
        }
        return base;
      });
      return { id: v.id, versionNo: v.versionNo, status: v.status, baselineRunId: v.baselineRunId, runs };
    });
    return { model: { id: m.id, name: m.name, baseYear: m.baseYear, horizonYears: m.horizonYears }, versions };
  }
  const orgs = subtree(db, input.orgScopeId);
  const models = listForecastModels(db, { status: 'active' }).items.filter((m) => !orgs || orgs.has(m.orgId));
  return { models: bounded(models.map((m) => ({ id: m.id, name: m.name, orgName: m.orgName, baseYear: m.baseYear, horizonYears: m.horizonYears, versionCount: m.versionCount, frozenCount: m.frozenCount }))) };
}

/** 风险概况:按状态/等级/规则统计与未关闭风险列表(不含证据明细)。 */
export function riskSummaryView(db: DB, input: { orgScopeId: number | null; level?: 'high' | 'medium' | 'low' }) {
  const q = input.orgScopeId ? { orgId: input.orgScopeId } : {};
  const summary = riskSummary(db, q);
  const open = listRiskEvents(db, { ...q, open: '1', ...(input.level ? { level: input.level } : {}) }).map((e) => ({
    id: e.id, ruleCode: e.ruleCode, ruleName: e.ruleName, level: e.level, status: e.status, orgName: e.orgName, title: e.title, amount: e.amount,
    deadline: e.deadline, overdue: e.overdue, occurrenceCount: e.occurrenceCount, lastScanHit: e.lastScanHit,
  }));
  return { summary, openRisks: bounded(open), notes: ['金额为元;lastScanHit=false 表示最近一次扫描未再命中(不会自动关闭)'] };
}

/** 分析报告列表:已发布(含已替代)或本人创建的报告。 */
export function reportListView(db: DB, input: { orgScopeId: number | null; kind?: RptKind }) {
  const orgs = subtree(db, input.orgScopeId);
  const rows = reportListForAssistant(db, { kind: input.kind, limit: 500 }).filter((r) => {
    if (!orgs) return true;
    const org = db.prepare('SELECT org_id FROM rpt_report WHERE id = ?').get(r.id) as { org_id: number | null };
    return org.org_id !== null && orgs.has(org.org_id);
  });
  return { reports: bounded(rows) };
}
