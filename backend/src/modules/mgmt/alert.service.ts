/**
 * 管理会计预警(AC-F14):扫描指定计算运行的有效快照,按指标阈值(上下限 warning/critical、实际相对预算的偏差比例)生成预警。
 * 同一指标 + 组织 + 期间 + 类型的未关闭预警在重复扫描时只更新,不重复创建。流程:确认(原因分类 + 说明)→ 关闭。
 */
import type { DB } from '../../db/connection';
import { writeLog } from '../audit/log';
import { notVisible, orgInScope } from '../security/scope';
import { ratioScaled } from '../../core/decimal';
import { maThresholds, MA_ALERT_CAUSE_LABELS, type MaAlertDto, type MaAlertScanDto, type MaThresholds } from '../../contracts/mgmt';
import { assertVersion, big, conflict, currentUserId, formatValue, nowIso, orgName, parseByUnit, ratio, scope } from './common';
import { getCalcRunRow, snapshotRows, type MetricRow } from './metric.service';

interface AlertRow {
  id: number; metric_id: number; org_id: number; period: string; alert_type: MaAlertDto['alertType']; level: MaAlertDto['level']; status: MaAlertDto['status'];
  snapshot_id: number; run_id: number; value_text: string; threshold_text: string; message: string; hit_count: number; cause_category: string | null;
  ack_note: string | null; acknowledged_at: string | null; close_note: string | null; closed_at: string | null; version: number; created_at: string; updated_at: string;
  code: string; name: string;
}

function dto(db: DB, r: AlertRow): MaAlertDto {
  return {
    id: r.id, metricId: r.metric_id, metricCode: r.code, metricName: r.name, orgId: r.org_id, orgName: orgName(db, r.org_id), period: r.period,
    alertType: r.alert_type, level: r.level, status: r.status, snapshotId: r.snapshot_id, runId: r.run_id, value: r.value_text, threshold: r.threshold_text,
    message: r.message, hitCount: r.hit_count, causeCategory: r.cause_category, ackNote: r.ack_note, acknowledgedAt: r.acknowledged_at, closeNote: r.close_note,
    closedAt: r.closed_at, version: r.version, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

const SELECT = 'SELECT a.*, m.code, m.name FROM ma_alert a JOIN ma_metric m ON m.id = a.metric_id';

function getRow(db: DB, id: number): AlertRow {
  const r = db.prepare(`${SELECT} WHERE a.id = ?`).get(id) as AlertRow | undefined;
  if (!r || !orgInScope(scope(db), r.org_id)) throw notVisible('预警');
  return r;
}

interface Hit { type: MaAlertDto['alertType']; level: MaAlertDto['level']; value: string; threshold: string; message: string }

/** 按阈值判定一个快照的命中(每种类型取最严重的级别)。 */
export function evaluate(metric: MetricRow, t: MaThresholds, valueCents: bigint | null, valueScaled: bigint | null, compareCents: bigint | null): Hit[] {
  const unit = metric.unit;
  const v = unit === 'money' ? valueCents : valueScaled;
  if (v === null) return [];
  const shown = formatValue(unit, valueCents, valueScaled)!;
  const hits: Hit[] = [];
  const bound = (key: keyof MaThresholds) => (t[key] === undefined ? null : parseByUnit(unit, t[key]!, key));
  const uc = bound('upperCritical'); const uw = bound('upperWarning');
  const lc = bound('lowerCritical'); const lw = bound('lowerWarning');
  if (uc !== null && v > uc) hits.push({ type: 'upper', level: 'critical', value: shown, threshold: t.upperCritical!, message: `${metric.name} ${shown} 超过上限(严重)${t.upperCritical}` });
  else if (uw !== null && v > uw) hits.push({ type: 'upper', level: 'warning', value: shown, threshold: t.upperWarning!, message: `${metric.name} ${shown} 超过上限(警告)${t.upperWarning}` });
  if (lc !== null && v < lc) hits.push({ type: 'lower', level: 'critical', value: shown, threshold: t.lowerCritical!, message: `${metric.name} ${shown} 低于下限(严重)${t.lowerCritical}` });
  else if (lw !== null && v < lw) hits.push({ type: 'lower', level: 'warning', value: shown, threshold: t.lowerWarning!, message: `${metric.name} ${shown} 低于下限(警告)${t.lowerWarning}` });
  if (metric.calculator === 'actual_amount' && compareCents !== null && valueCents !== null && (t.deviationWarning || t.deviationCritical)) {
    const denom = compareCents < 0n ? -compareCents : compareCents;
    const dev = ratioScaled(valueCents - compareCents, denom);
    if (dev !== null) {
      const absDev = dev < 0n ? -dev : dev;
      const dc = t.deviationCritical ? parseByUnit('ratio', t.deviationCritical, 'deviationCritical') : null;
      const dw = t.deviationWarning ? parseByUnit('ratio', t.deviationWarning, 'deviationWarning') : null;
      const devText = ratio(dev);
      if (dc !== null && absDev > dc) hits.push({ type: 'deviation', level: 'critical', value: devText, threshold: t.deviationCritical!, message: `${metric.name} 实际相对预算偏差 ${devText} 超过 ${t.deviationCritical}(严重)` });
      else if (dw !== null && absDev > dw) hits.push({ type: 'deviation', level: 'warning', value: devText, threshold: t.deviationWarning!, message: `${metric.name} 实际相对预算偏差 ${devText} 超过 ${t.deviationWarning}(警告)` });
    }
  }
  return hits;
}

export function scanAlerts(db: DB, runId: number): MaAlertScanDto {
  getCalcRunRow(db, runId);
  return db.transaction((): MaAlertScanDto => {
    const snaps = snapshotRows(db, "s.run_id = ? AND s.status = 'valid'", [runId]);
    const counts = { created: 0, updated: 0, unchanged: 0, evaluated: snaps.length };
    const now = nowIso();
    for (const s of snaps) {
      const metric = db.prepare('SELECT * FROM ma_metric WHERE id = ?').get(Number(s.metric_id)) as MetricRow;
      const t = maThresholds.parse(JSON.parse(metric.thresholds_json));
      for (const h of evaluate(metric, t, big(s.value_cents), big(s.value_scaled), big(s.compare_cents))) {
        const existing = db.prepare("SELECT * FROM ma_alert WHERE metric_id = ? AND org_id = ? AND period = ? AND alert_type = ? AND status <> 'closed'")
          .get(metric.id, Number(s.org_id), s.period, h.type) as AlertRow | undefined;
        if (!existing) {
          db.prepare(`INSERT INTO ma_alert (metric_id, org_id, period, alert_type, level, snapshot_id, run_id, value_text, threshold_text, message, created_at, updated_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(metric.id, Number(s.org_id), s.period, h.type, h.level, Number(s.id), runId, h.value, h.threshold, h.message, now, now);
          counts.created++;
        } else if (existing.snapshot_id === Number(s.id)) {
          counts.unchanged++;
        } else {
          db.prepare(`UPDATE ma_alert SET level = ?, snapshot_id = ?, run_id = ?, value_text = ?, threshold_text = ?, message = ?, hit_count = hit_count + 1,
            version = version + 1, updated_at = ? WHERE id = ?`).run(h.level, Number(s.id), runId, h.value, h.threshold, h.message, now, existing.id);
          counts.updated++;
        }
      }
    }
    writeLog(db, 'mgmt.alert.scan', 'ma_calc_run', runId, counts);
    return counts;
  }).immediate();
}

export function listAlerts(db: DB, q: { status?: string; orgId?: number; period?: string; metricId?: number } = {}): MaAlertDto[] {
  const s = scope(db);
  if (q.orgId && !orgInScope(s, q.orgId)) throw notVisible('组织');
  const where: string[] = ['1 = 1'];
  const params: unknown[] = [];
  if (q.status === 'unclosed') where.push("a.status <> 'closed'");
  else if (q.status) { where.push('a.status = ?'); params.push(q.status); }
  if (q.orgId) { where.push('a.org_id = ?'); params.push(q.orgId); }
  if (q.period) { where.push('a.period = ?'); params.push(q.period); }
  if (q.metricId) { where.push('a.metric_id = ?'); params.push(q.metricId); }
  return (db.prepare(`${SELECT} WHERE ${where.join(' AND ')} ORDER BY CASE a.level WHEN 'critical' THEN 0 ELSE 1 END, a.updated_at DESC LIMIT 500`).all(...params) as AlertRow[])
    .filter((r) => orgInScope(s, r.org_id)).map((r) => dto(db, r));
}

export function getAlert(db: DB, id: number): MaAlertDto {
  return dto(db, getRow(db, id));
}

export function acknowledgeAlert(db: DB, id: number, input: { expectedVersion: number; causeCategory: keyof typeof MA_ALERT_CAUSE_LABELS; note: string }): MaAlertDto {
  db.transaction(() => {
    const r = getRow(db, id);
    assertVersion(r.version, input.expectedVersion, '预警');
    if (r.status !== 'open') throw conflict('ALERT_STATE', '只有未确认的预警可以确认');
    const now = nowIso();
    db.prepare(`UPDATE ma_alert SET status = 'acknowledged', cause_category = ?, ack_note = ?, acknowledged_by_user_id = ?, acknowledged_at = ?, version = version + 1, updated_at = ? WHERE id = ?`)
      .run(input.causeCategory, input.note, currentUserId(), now, now, id);
    writeLog(db, 'mgmt.alert.acknowledge', 'ma_alert', id, { causeCategory: input.causeCategory, note: input.note });
  }).immediate();
  return getAlert(db, id);
}

export function closeAlert(db: DB, id: number, input: { expectedVersion: number; note?: string }): MaAlertDto {
  db.transaction(() => {
    const r = getRow(db, id);
    assertVersion(r.version, input.expectedVersion, '预警');
    if (r.status !== 'acknowledged') throw conflict('ALERT_STATE', '预警需先确认原因再关闭');
    const now = nowIso();
    db.prepare(`UPDATE ma_alert SET status = 'closed', close_note = ?, closed_by_user_id = ?, closed_at = ?, version = version + 1, updated_at = ? WHERE id = ?`)
      .run(input.note ?? null, currentUserId(), now, now, id);
    writeLog(db, 'mgmt.alert.close', 'ma_alert', id, { note: input.note });
  }).immediate();
  return getAlert(db, id);
}
