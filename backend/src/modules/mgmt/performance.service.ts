/**
 * 绩效(AC-F14):方案 = 指标 × 权重 × 目标 × 方向。评分基于指定计算运行的有效快照,保存评分明细;
 * 复核可以确认或调整分数,但原分与明细不改,调整必须写原因;提交人(评分人)≠ 复核人。
 *
 * 口径:达成率 = 实际/目标(越高越好)或 目标/实际(越低越好),截在 [0, 1.2];
 * 单项得分 = 达成率 × 权重 × 100,四舍五入到 2 位小数;总分 = 单项得分之和。权重合计必须为 1。
 */
import type { DB } from '../../db/connection';
import { AppError, Errors } from '../../core/errors';
import { currentAuth } from '../../core/request-context';
import { formatScaled, parseScaled, ratioScaled } from '../../core/decimal';
import { writeLog } from '../audit/log';
import { notVisible, orgInScope } from '../security/scope';
import { assertDistinctReviewer } from '../security/review';
import type { MaPerfReviewRequest, MaPerfSchemeCreate, MaPerfSchemeDto, MaPerfScoreDto } from '../../contracts/mgmt';
import { big, conflict, currentUserId, formatValue, nowIso, orgName, parseByUnit, parseRatio, ratio, scope } from './common';
import { getCalcRunRow, getMetricRow, snapshotRows } from './metric.service';

const ONE = 1_000_000n;
const CAP = 1_200_000n;
const score2 = (v: bigint) => formatScaled(v, 2, true);

interface SchemeRow { id: number; code: string; name: string; status: 'active' | 'inactive'; version: number; created_at: string }
interface ItemRow { id: number; scheme_id: number; metric_id: number; weight_scaled: number; target_text: string; direction: 'higher_better' | 'lower_better'; sort_order: number }
interface ScoreRow {
  id: number; scheme_id: number; scheme_version: number; run_id: number; org_id: number; period: string; score_scaled: number; details_json: string;
  status: 'scored' | 'reviewed'; review_action: 'confirm' | 'adjust' | null; adjusted_score_scaled: number | null; adjust_reason: string | null;
  review_comment: string | null; exception_reason: string | null; self_review: number; scored_by_user_id: number | null; scored_at: string;
  reviewed_by_user_id: number | null; reviewed_at: string | null;
}

function items(db: DB, schemeId: number): ItemRow[] {
  return db.prepare('SELECT * FROM ma_perf_item WHERE scheme_id = ? ORDER BY sort_order').all(schemeId) as ItemRow[];
}

function schemeDto(db: DB, s: SchemeRow): MaPerfSchemeDto {
  return {
    id: s.id, code: s.code, name: s.name, status: s.status, version: s.version, createdAt: s.created_at,
    items: items(db, s.id).map((i) => {
      const m = getMetricRow(db, i.metric_id);
      return { id: i.id, metricId: m.id, metricCode: m.code, metricName: m.name, unit: m.unit, weight: ratio(i.weight_scaled), target: i.target_text, direction: i.direction };
    }),
  };
}

function getSchemeRow(db: DB, id: number): SchemeRow {
  const s = db.prepare('SELECT * FROM ma_perf_scheme WHERE id = ?').get(id) as SchemeRow | undefined;
  if (!s) throw notVisible('绩效方案');
  return s;
}

export function listSchemes(db: DB): MaPerfSchemeDto[] {
  return (db.prepare('SELECT * FROM ma_perf_scheme ORDER BY code').all() as SchemeRow[]).map((s) => schemeDto(db, s));
}

export function getScheme(db: DB, id: number): MaPerfSchemeDto {
  return schemeDto(db, getSchemeRow(db, id));
}

export function createScheme(db: DB, input: MaPerfSchemeCreate): MaPerfSchemeDto {
  if (db.prepare('SELECT 1 FROM ma_perf_scheme WHERE code = ?').get(input.code)) throw Errors.conflict(`绩效方案编码 ${input.code} 已存在`);
  if (new Set(input.items.map((i) => i.metricId)).size !== input.items.length) throw Errors.validation('同一指标在方案中只能出现一次');
  const parsed = input.items.map((it, i) => {
    const m = getMetricRow(db, it.metricId);
    const weight = parseRatio(it.weight, `第 ${i + 1} 项权重`);
    if (weight <= 0n) throw Errors.validation(`第 ${i + 1} 项权重必须大于 0`);
    if (parseByUnit(m.unit, it.target, `第 ${i + 1} 项目标`) <= 0n) throw Errors.validation(`第 ${i + 1} 项目标必须大于 0`);
    return { ...it, weight, metric: m };
  });
  const total = parsed.reduce((a, b) => a + b.weight, 0n);
  if (total !== ONE) throw Errors.validation(`权重合计应为 1,当前为 ${ratio(total)}`);
  const now = nowIso();
  const id = db.transaction(() => {
    const newId = Number(db.prepare('INSERT INTO ma_perf_scheme (code, name, created_by_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(input.code, input.name, currentUserId(), now, now).lastInsertRowid);
    const insert = db.prepare('INSERT INTO ma_perf_item (scheme_id, metric_id, weight_scaled, target_text, direction, sort_order) VALUES (?, ?, ?, ?, ?, ?)');
    parsed.forEach((p, i) => insert.run(newId, p.metricId, p.weight, p.target, p.direction, i + 1));
    writeLog(db, 'mgmt.perf.scheme_create', 'ma_perf_scheme', newId, { code: input.code, items: input.items });
    return newId;
  }).immediate();
  return getScheme(db, id);
}

function scoreDto(db: DB, r: ScoreRow): MaPerfScoreDto {
  const scheme = getSchemeRow(db, r.scheme_id);
  const score = score2(BigInt(r.score_scaled));
  const adjusted = r.adjusted_score_scaled === null ? null : score2(BigInt(r.adjusted_score_scaled));
  return {
    id: r.id, schemeId: r.scheme_id, schemeName: scheme.name, runId: r.run_id, orgId: r.org_id, orgName: orgName(db, r.org_id), period: r.period,
    score, finalScore: adjusted ?? score, details: JSON.parse(r.details_json) as MaPerfScoreDto['details'], status: r.status, reviewAction: r.review_action,
    adjustedScore: adjusted, adjustReason: r.adjust_reason, reviewComment: r.review_comment, exceptionReason: r.exception_reason, selfReview: r.self_review === 1,
    scoredByUserId: r.scored_by_user_id, scoredAt: r.scored_at, reviewedByUserId: r.reviewed_by_user_id, reviewedAt: r.reviewed_at,
  };
}

function achievementOf(direction: ItemRow['direction'], value: bigint, target: bigint): bigint {
  let a: bigint | null;
  if (direction === 'higher_better') a = value <= 0n ? 0n : ratioScaled(value, target);
  else a = value <= 0n ? CAP : ratioScaled(target, value);
  a = a ?? 0n;
  return a > CAP ? CAP : a < 0n ? 0n : a;
}

export function scorePerformance(db: DB, schemeId: number, input: { runId: number; orgIds?: number[] }): { scores: MaPerfScoreDto[]; skipped: { orgId: number; orgName: string; reasons: string[] }[] } {
  const scheme = getSchemeRow(db, schemeId);
  if (scheme.status !== 'active') throw Errors.conflict('绩效方案已停用');
  const run = getCalcRunRow(db, input.runId);
  const s = scope(db);
  const snaps = snapshotRows(db, 's.run_id = ?', [run.id]);
  let orgIds = input.orgIds ?? [...new Set(snaps.map((x) => Number(x.org_id)))];
  for (const id of orgIds) if (!orgInScope(s, id)) throw notVisible('组织');
  orgIds = [...new Set(orgIds)];
  const its = items(db, schemeId);
  const scored: { orgId: number; total: bigint; details: MaPerfScoreDto['details'] }[] = [];
  const skipped: { orgId: number; orgName: string; reasons: string[] }[] = [];
  for (const orgId of orgIds) {
    const reasons: string[] = [];
    const details: MaPerfScoreDto['details'] = [];
    let total = 0n;
    for (const it of its) {
      const m = getMetricRow(db, it.metric_id);
      const snap = snaps.find((x) => Number(x.metric_id) === m.id && Number(x.org_id) === orgId && x.status === 'valid');
      if (!snap) { reasons.push(`指标 ${m.name} 在运行 #${run.id} 中没有有效快照`); continue; }
      const value = m.unit === 'money' ? big(snap.value_cents)! : big(snap.value_scaled)!;
      const target = parseByUnit(m.unit, it.target_text, '目标');
      const achievement = achievementOf(it.direction, value, target);
      // 达成率(1e6) × 权重(1e6) × 100,四舍五入到 2 位小数(1e12 → 1e2)
      const itemScore = (achievement * BigInt(it.weight_scaled) * 100n * 100n + ONE * ONE / 2n) / (ONE * ONE);
      total += itemScore;
      details.push({
        metricId: m.id, metricName: m.name, value: formatValue(m.unit, big(snap.value_cents), big(snap.value_scaled))!, target: it.target_text, direction: it.direction,
        weight: ratio(it.weight_scaled), achievement: ratio(achievement), itemScore: score2(itemScore), snapshotId: Number(snap.id),
      });
    }
    if (reasons.length) skipped.push({ orgId, orgName: orgName(db, orgId), reasons });
    else scored.push({ orgId, total, details });
  }
  if (!scored.length) {
    throw new AppError('CALCULATOR_UNAVAILABLE', '所选组织缺少评分所需的指标快照,未生成评分', 409, undefined, { skipped });
  }
  const ids = db.transaction(() => {
    const now = nowIso();
    const insert = db.prepare(`INSERT INTO ma_perf_score (scheme_id, scheme_version, run_id, org_id, period, score_scaled, details_json, scored_by_user_id, scored_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const out = scored.map((x) => Number(insert.run(schemeId, scheme.version, run.id, x.orgId, run.period, x.total, JSON.stringify(x.details), currentUserId(), now).lastInsertRowid));
    writeLog(db, 'mgmt.perf.score', 'ma_perf_scheme', schemeId, { runId: run.id, scores: scored.map((x) => ({ orgId: x.orgId, score: score2(x.total) })), skipped: skipped.map((x) => x.orgId) });
    return out;
  }).immediate();
  return { scores: ids.map((id) => getScore(db, id)), skipped };
}

function getScoreRow(db: DB, id: number): ScoreRow {
  const r = db.prepare('SELECT * FROM ma_perf_score WHERE id = ?').get(id) as ScoreRow | undefined;
  if (!r || !orgInScope(scope(db), r.org_id)) throw notVisible('绩效评分');
  return r;
}

export function getScore(db: DB, id: number): MaPerfScoreDto {
  return scoreDto(db, getScoreRow(db, id));
}

export function listScores(db: DB, q: { schemeId?: number; period?: string; status?: string; orgId?: number } = {}): MaPerfScoreDto[] {
  const s = scope(db);
  if (q.orgId && !orgInScope(s, q.orgId)) throw notVisible('组织');
  const where: string[] = ['1 = 1'];
  const params: unknown[] = [];
  if (q.schemeId) { where.push('scheme_id = ?'); params.push(q.schemeId); }
  if (q.period) { where.push('period = ?'); params.push(q.period); }
  if (q.status) { where.push('status = ?'); params.push(q.status); }
  if (q.orgId) { where.push('org_id = ?'); params.push(q.orgId); }
  return (db.prepare(`SELECT * FROM ma_perf_score WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT 500`).all(...params) as ScoreRow[])
    .filter((r) => orgInScope(s, r.org_id)).map((r) => scoreDto(db, r));
}

export function reviewScore(db: DB, id: number, input: MaPerfReviewRequest): MaPerfScoreDto {
  let adjusted: bigint | null = null;
  if (input.action === 'adjust') {
    if (!input.adjustedScore) throw Errors.validation('调整分数时必须填写调整后分数');
    if (!input.reason?.trim()) throw Errors.validation('调整分数必须填写原因');
    adjusted = parseScaled(input.adjustedScore, 2, { label: '调整后分数' });
    if (adjusted < 0n || adjusted > 12000n) throw Errors.validation('调整后分数应在 0～120 之间');
  }
  db.transaction(() => {
    const r = getScoreRow(db, id);
    if (r.status !== 'scored') throw conflict('MGMT_ALREADY_REVIEWED', '该绩效评分已复核,不能重复复核');
    const { selfReview } = assertDistinctReviewer(db, currentAuth(), r.scored_by_user_id, input.exceptionReason, '绩效评分');
    db.prepare(`UPDATE ma_perf_score SET status = 'reviewed', review_action = ?, adjusted_score_scaled = ?, adjust_reason = ?, review_comment = ?, exception_reason = ?,
      self_review = ?, reviewed_by_user_id = ?, reviewed_at = ? WHERE id = ?`)
      .run(input.action, adjusted, input.action === 'adjust' ? input.reason!.trim() : null, input.comment ?? null, input.exceptionReason ?? null, selfReview ? 1 : 0, currentUserId(), nowIso(), id);
    writeLog(db, 'mgmt.perf.review', 'ma_perf_score', id, {
      action: input.action, originalScore: score2(BigInt(r.score_scaled)), adjustedScore: adjusted === null ? null : score2(adjusted), reason: input.reason, selfReview, exceptionReason: input.exceptionReason,
    });
  }).immediate();
  return getScore(db, id);
}
