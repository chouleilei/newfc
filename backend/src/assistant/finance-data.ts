/**
 * T-3 财务数据与管理会计的助手只读视图(AC-F05/F10/F14)。
 *
 * 边界:
 * - 只读,直接调用页面同源 service;组织范围由 tool-policy 的 org_scope 改写 orgScopeId,
 *   service 内部再按 AuthContext 裁剪(双重校验,范围外 404)。
 * - 有界:快照/预警截断到固定条数并给出隐藏条数,避免撑爆模型上下文。
 */
import type { DB } from '../db/connection';
import { periodStatus } from '../modules/eas/eas.service';
import { statementOverview } from '../modules/statements/statement.service';
import { listSnapshots } from '../modules/mgmt/metric.service';
import { listAlerts } from '../modules/mgmt/alert.service';
import type { StatementScope } from '../contracts/statements';
import { RULE_LABELS } from '../modules/governance/governance.sources';

const ROW_LIMIT = 100;

/** orgScopeId 的全部下级(含自身);null 表示不按组织过滤(范围裁剪仍由 service 完成)。 */
function subtree(db: DB, rootId: number | null): Set<number> | null {
  if (rootId == null) return null;
  const rows = db.prepare(`WITH RECURSIVE sub(id) AS (
      SELECT id FROM org WHERE id = ?
      UNION SELECT o.id FROM org o JOIN sub ON o.parent_id = sub.id
    ) SELECT id FROM sub`).all(rootId) as { id: number }[];
  return new Set(rows.map((r) => r.id));
}

function bounded<T>(rows: T[]): { items: T[]; total: number; hidden: number } {
  return { items: rows.slice(0, ROW_LIMIT), total: rows.length, hidden: Math.max(0, rows.length - ROW_LIMIT) };
}

export function easPeriodStatusView(db: DB, input: { orgScopeId: number | null; period: string }) {
  if (input.orgScopeId == null) throw new Error('请指定组织(orgScopeId):EAS 期间状态按单个组织查询');
  const s = periodStatus(db, input.orgScopeId, input.period);
  const set = s.currentSet;
  return {
    orgId: s.orgId, orgName: s.orgName, period: s.period,
    currentSet: set ? {
      id: set.id, status: set.status, version: set.version, errorCount: set.errorCount, warningCount: set.warningCount, activatedAt: set.activatedAt,
      results: set.results.map((r) => ({ ruleCode: r.ruleCode, ruleName: RULE_LABELS[r.ruleCode] ?? r.ruleCode, status: r.status, diffCount: r.diffCount, diffAmount: r.diffAmount })),
    } : null,
    lock: s.lock ? { status: s.lock.status, lockedAt: s.lock.lockedAt } : null,
    pendingCorrection: s.pendingCorrection ? { id: s.pendingCorrection.id, status: s.pendingCorrection.status } : null,
    candidateBatchCount: s.candidateBatches.length,
  };
}

export function statementOverviewView(db: DB, input: { orgScopeId: number | null; period?: string; scope?: StatementScope }) {
  return statementOverview(db, { orgId: input.orgScopeId ?? undefined, period: input.period, scope: input.scope });
}

export function mgmtSnapshotsView(db: DB, input: { orgScopeId: number | null; period?: string; metricId?: number }) {
  const within = subtree(db, input.orgScopeId);
  const rows = listSnapshots(db, { period: input.period, metricId: input.metricId, status: 'valid' })
    .filter((r) => !within || within.has(r.orgId))
    .reverse()
    .map((r) => ({ id: r.id, metricCode: r.metricCode, metricName: r.metricName, unit: r.unit, orgId: r.orgId, orgName: r.orgName,
      period: r.period, value: r.value, compareValue: r.compareValue, runId: r.runId, allocRunId: r.allocRunId, adjustmentId: r.adjustmentId }));
  return bounded(rows);
}

export function mgmtAlertsView(db: DB, input: { orgScopeId: number | null; status?: string; period?: string }) {
  const within = subtree(db, input.orgScopeId);
  const rows = listAlerts(db, { status: input.status ?? 'unclosed', period: input.period })
    .filter((r) => !within || within.has(r.orgId))
    .map((r) => ({ id: r.id, metricCode: r.metricCode, metricName: r.metricName, orgId: r.orgId, orgName: r.orgName, period: r.period,
      alertType: r.alertType, level: r.level, status: r.status, value: r.value, threshold: r.threshold, message: r.message, hitCount: r.hitCount }));
  return bounded(rows);
}
