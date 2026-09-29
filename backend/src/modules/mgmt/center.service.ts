/**
 * 责任中心(AC-F14):按授权范围内的组织汇总最新指标快照、未关闭预警、分摊成本与待办
 * (待确认预警、待复核分摊调整/预算调整、待复核绩效)。只读,数据均来自各子功能的同一组 service 表。
 */
import type { DB } from '../../db/connection';
import { notVisible, orgInScope } from '../security/scope';
import type { MaResponsibilityCenterDto } from '../../contracts/mgmt';
import { money, scope } from './common';
import { snapshotsWhere } from './metric.service';
import { allocatedCostOf } from './allocation.service';

function activeOrgIds(db: DB, period: string): number[] {
  const rows = db.prepare(`SELECT org_id FROM ma_metric_snapshot WHERE period = ? AND status = 'valid'
    UNION SELECT org_id FROM ma_alert WHERE period = ? AND status <> 'closed'
    UNION SELECT r.target_org_id FROM ma_alloc_result r JOIN ma_alloc_run ar ON ar.id = r.run_id WHERE ar.period = ? AND ar.status = 'confirmed'
    UNION SELECT org_id FROM ma_budget_adjustment WHERE status = 'pending'
    UNION SELECT org_id FROM ma_perf_score WHERE period = ? AND status = 'scored'`).all(period, period, period, period) as { org_id: number }[];
  return rows.map((r) => r.org_id);
}

export function responsibilityCenters(db: DB, q: { period: string; orgId?: number }): MaResponsibilityCenterDto[] {
  const s = scope(db);
  if (q.orgId && (!orgInScope(s, q.orgId) || !db.prepare('SELECT 1 FROM org WHERE id = ?').get(q.orgId))) throw notVisible('组织');
  const orgIds = q.orgId ? [q.orgId] : activeOrgIds(db, q.period).filter((id) => orgInScope(s, id));
  const orgs = orgIds.length
    ? db.prepare(`SELECT id, code, name FROM org WHERE id IN (${orgIds.map(() => '?').join(',')}) ORDER BY sort_order, id`).all(...orgIds) as { id: number; code: string; name: string }[]
    : [];
  return orgs.map((o) => {
    const all = snapshotsWhere(db, "s.org_id = ? AND s.period = ? AND s.status = 'valid'", [o.id, q.period]);
    const latest = new Map<number, (typeof all)[number]>();
    for (const snap of all) latest.set(snap.metricId, snap); // 按 id 升序,后者覆盖前者
    const alerts = db.prepare("SELECT id, level, status, message FROM ma_alert WHERE org_id = ? AND period = ? AND status <> 'closed' ORDER BY id").all(o.id, q.period) as
      { id: number; level: 'warning' | 'critical'; status: 'open' | 'acknowledged'; message: string }[];
    const todos: MaResponsibilityCenterDto['todos'] = alerts.filter((a) => a.status === 'open').map((a) => ({ kind: 'alert_ack', id: a.id, title: a.message }));
    const adj = db.prepare(`SELECT DISTINCT a.id, a.reason FROM ma_alloc_adjustment a JOIN ma_alloc_run ar ON ar.id = a.run_id JOIN ma_alloc_result f ON f.id = a.from_result_id
      JOIN ma_alloc_result t ON t.id = a.to_result_id JOIN ma_cost_pool p ON p.id = ar.pool_id
      WHERE a.status = 'pending' AND ar.period = ? AND (p.org_id = ? OR f.target_org_id = ? OR t.target_org_id = ?)`).all(q.period, o.id, o.id, o.id) as { id: number; reason: string }[];
    todos.push(...adj.map((a) => ({ kind: 'alloc_adjustment_review' as const, id: a.id, title: `分摊调整待复核:${a.reason}` })));
    const badj = db.prepare("SELECT id, reason FROM ma_budget_adjustment WHERE org_id = ? AND status = 'pending'").all(o.id) as { id: number; reason: string }[];
    todos.push(...badj.map((a) => ({ kind: 'budget_adjustment_review' as const, id: a.id, title: `预算调整待复核:${a.reason}` })));
    const perf = db.prepare("SELECT id FROM ma_perf_score WHERE org_id = ? AND period = ? AND status = 'scored'").all(o.id, q.period) as { id: number }[];
    todos.push(...perf.map((p) => ({ kind: 'perf_review' as const, id: p.id, title: `绩效评分 #${p.id} 待复核` })));
    return {
      orgId: o.id, orgName: o.name, orgCode: o.code, period: q.period, snapshots: [...latest.values()],
      openAlerts: {
        warning: alerts.filter((a) => a.status === 'open' && a.level === 'warning').length,
        critical: alerts.filter((a) => a.status === 'open' && a.level === 'critical').length,
        acknowledged: alerts.filter((a) => a.status === 'acknowledged').length,
      },
      allocatedCost: money(allocatedCostOf(db, o.id, q.period)),
      todos,
    };
  });
}
