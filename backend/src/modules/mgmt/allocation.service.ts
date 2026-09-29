/**
 * 成本分摊与分摊调整(AC-F14):成本池(归属组织、期间、总额)+ 规则(目标组织 × 权重)。
 *
 * - 流程为预览 → 确认 → 作废。按 allocateCentsTail 分摊,最后一个正权重项吸收尾差,合计严格等于总额。
 * - 确认时写入 allocation 类计算运行和各目标组织的分摊成本快照;作废时这些快照随之失效。
 * - 同一成本池同时只有一个已确认运行;存在已确认运行时不能改池子和规则(ALLOCATION_STATE),先作废再重算。
 * - 调整 = 同一运行内两个结果之间转移金额(守恒),提交后由不同的人复核(mgmt:review);批准时重写两个结果的快照。
 * - 血缘链:成本池 → 规则/权重 → 运行 → 结果 → 调整 → 快照。
 * - 组织范围按成本池归属组织裁剪;规则目标组织必须在编辑人范围内。
 */
import type { DB } from '../../db/connection';
import { Errors } from '../../core/errors';
import { currentAuth } from '../../core/request-context';
import { allocateCentsTail, sumCents } from '../../core/decimal';
import { writeLog } from '../audit/log';
import { notVisible, orgInScope } from '../security/scope';
import { assertDistinctReviewer } from '../security/review';
import type {
  MaAllocAdjustmentCreate, MaAllocAdjustmentDto, MaAllocPreviewDto, MaAllocResultDto, MaAllocRulesRequest, MaAllocRunDto, MaCostPoolCreate, MaCostPoolDto,
  MaCostPoolUpdate, MaLineageDto, MaReviewRequest,
} from '../../contracts/mgmt';
import { assertOrgInScope, assertVersion, conflict, currentUserId, money, nowIso, orgName, parseMoney, parseRatio, ratio, scope } from './common';
import {
  insertCalcRun, insertSnapshot, invalidateSnapshots, refreshRunCounts, snapshotsWhere, staleAllocatedCostWhere,
} from './metric.service';

interface PoolRow { id: number; name: string; org_id: number; period: string; total_cents: bigint; note: string; version: number; created_at: string; updated_at: string }
interface RuleRow { id: number; pool_id: number; target_org_id: number; weight_scaled: bigint; sort_order: number; created_at: string; retired_at: string | null }
interface RunRow {
  id: number; pool_id: number; pool_version: number; period: string; total_cents: bigint; calc_run_id: number | null; status: 'confirmed' | 'voided'; version: number;
  confirmed_by_user_id: number | null; confirmed_at: string; voided_at: string | null; void_reason: string | null;
}
interface ResultRow { id: number; run_id: number; rule_id: number | null; target_org_id: number; weight_scaled: bigint; base_cents: bigint; amount_cents: bigint; sort_order: number }
interface AdjustmentRow {
  id: number; run_id: number; from_result_id: number; to_result_id: number; amount_cents: bigint; reason: string; status: MaAllocAdjustmentDto['status'];
  submitted_by_user_id: number | null; submitted_at: string; reviewed_by_user_id: number | null; reviewed_at: string | null; review_comment: string | null;
  exception_reason: string | null; self_review: number;
}

/** 读行时把 INTEGER 统一取为 bigint,再把 ID/版本等小整数还原为 number。 */
function rows<T>(db: DB, sql: string, ...params: unknown[]): T[] {
  return (db.prepare(sql).safeIntegers(true).all(...params) as Record<string, unknown>[]).map(normalize) as T[];
}
const BIG_COLUMNS = new Set(['total_cents', 'weight_scaled', 'base_cents', 'amount_cents']);
function normalize(r: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(r)) out[k] = typeof v === 'bigint' && !BIG_COLUMNS.has(k) ? Number(v) : v;
  return out;
}

const allocationState = (message: string) => conflict('ALLOCATION_STATE', message);

function builtinMetricId(db: DB): number {
  return (db.prepare("SELECT id FROM ma_metric WHERE code = 'ALLOCATED_COST' AND builtin = 1").get() as { id: number }).id;
}

/* ================= 成本池与规则 ================= */

function getPoolRow(db: DB, id: number): PoolRow {
  const row = rows<PoolRow>(db, 'SELECT * FROM ma_cost_pool WHERE id = ?', id)[0];
  if (!row || !orgInScope(scope(db), row.org_id)) throw notVisible('成本池');
  return row;
}

function activeRules(db: DB, poolId: number): RuleRow[] {
  return rows<RuleRow>(db, 'SELECT * FROM ma_alloc_rule WHERE pool_id = ? AND retired_at IS NULL ORDER BY sort_order, id', poolId);
}

function confirmedRunId(db: DB, poolId: number): number | null {
  return (db.prepare("SELECT id FROM ma_alloc_run WHERE pool_id = ? AND status = 'confirmed'").get(poolId) as { id: number } | undefined)?.id ?? null;
}

function poolDto(db: DB, p: PoolRow): MaCostPoolDto {
  return {
    id: p.id, name: p.name, orgId: p.org_id, orgName: orgName(db, p.org_id), period: p.period, total: money(p.total_cents), note: p.note, version: p.version,
    rules: activeRules(db, p.id).map((r) => ({ id: r.id, targetOrgId: r.target_org_id, targetOrgName: orgName(db, r.target_org_id), weight: ratio(r.weight_scaled), sortOrder: r.sort_order })),
    confirmedRunId: confirmedRunId(db, p.id), createdAt: p.created_at, updatedAt: p.updated_at,
  };
}

export function listPools(db: DB, q: { period?: string; orgId?: number } = {}): MaCostPoolDto[] {
  const s = scope(db);
  if (q.orgId && !orgInScope(s, q.orgId)) throw notVisible('组织');
  const where: string[] = ['1 = 1'];
  const params: unknown[] = [];
  if (q.period) { where.push('period = ?'); params.push(q.period); }
  if (q.orgId) { where.push('org_id = ?'); params.push(q.orgId); }
  return rows<PoolRow>(db, `SELECT * FROM ma_cost_pool WHERE ${where.join(' AND ')} ORDER BY period DESC, id DESC`, ...params)
    .filter((p) => orgInScope(s, p.org_id)).map((p) => poolDto(db, p));
}

export function getPool(db: DB, id: number): MaCostPoolDto {
  return poolDto(db, getPoolRow(db, id));
}

function positiveTotal(total: string): bigint {
  const cents = parseMoney(total, '成本池总额');
  if (cents <= 0n) throw Errors.validation('成本池总额必须大于 0');
  return cents;
}

export function createPool(db: DB, input: MaCostPoolCreate): MaCostPoolDto {
  assertOrgInScope(db, input.orgId);
  const total = positiveTotal(input.total);
  const now = nowIso();
  const id = db.transaction(() => {
    const info = db.prepare('INSERT INTO ma_cost_pool (name, org_id, period, total_cents, note, created_by_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(input.name, input.orgId, input.period, total, input.note ?? '', currentUserId(), now, now);
    const newId = Number(info.lastInsertRowid);
    writeLog(db, 'mgmt.pool.create', 'ma_cost_pool', newId, { name: input.name, orgId: input.orgId, period: input.period, total: money(total) });
    return newId;
  }).immediate();
  return getPool(db, id);
}

export function updatePool(db: DB, id: number, input: MaCostPoolUpdate): MaCostPoolDto {
  db.transaction(() => {
    const p = getPoolRow(db, id);
    assertVersion(p.version, input.expectedVersion, '成本池');
    if (confirmedRunId(db, id)) throw allocationState('成本池已有已确认的分摊,请先作废再修改');
    const total = input.total !== undefined ? positiveTotal(input.total) : p.total_cents;
    db.prepare('UPDATE ma_cost_pool SET name = ?, total_cents = ?, note = ?, version = version + 1, updated_at = ? WHERE id = ?')
      .run(input.name ?? p.name, total, input.note ?? p.note, nowIso(), id);
    writeLog(db, 'mgmt.pool.update', 'ma_cost_pool', id, { name: input.name, total: input.total, note: input.note });
  }).immediate();
  return getPool(db, id);
}

/** 替换规则:旧规则退役(保留供血缘追溯),新增规则;权重按 6 位小数定点保存。 */
export function setRules(db: DB, id: number, input: MaAllocRulesRequest): MaCostPoolDto {
  const s = scope(db);
  const parsed = input.rules.map((r, i) => {
    if (!db.prepare('SELECT 1 FROM org WHERE id = ?').get(r.targetOrgId) || !orgInScope(s, r.targetOrgId)) throw notVisible('目标组织');
    const w = parseRatio(r.weight, `第 ${i + 1} 条权重`);
    if (w < 0n) throw Errors.validation(`第 ${i + 1} 条权重不能为负`);
    return { targetOrgId: r.targetOrgId, weight: w, sortOrder: i + 1 };
  });
  if (new Set(parsed.map((r) => r.targetOrgId)).size !== parsed.length) throw Errors.validation('同一目标组织只能有一条规则');
  if (parsed.every((r) => r.weight === 0n)) throw Errors.validation('权重合计必须大于 0');
  db.transaction(() => {
    const p = getPoolRow(db, id);
    assertVersion(p.version, input.expectedVersion, '成本池');
    if (confirmedRunId(db, id)) throw allocationState('成本池已有已确认的分摊,请先作废再修改规则');
    const now = nowIso();
    db.prepare('UPDATE ma_alloc_rule SET retired_at = ? WHERE pool_id = ? AND retired_at IS NULL').run(now, id);
    const insert = db.prepare('INSERT INTO ma_alloc_rule (pool_id, target_org_id, weight_scaled, sort_order, created_at) VALUES (?, ?, ?, ?, ?)');
    for (const r of parsed) insert.run(id, r.targetOrgId, r.weight, r.sortOrder, now);
    db.prepare('UPDATE ma_cost_pool SET version = version + 1, updated_at = ? WHERE id = ?').run(now, id);
    writeLog(db, 'mgmt.pool.rules', 'ma_cost_pool', id, { rules: parsed.map((r) => ({ targetOrgId: r.targetOrgId, weight: ratio(r.weight) })) });
  }).immediate();
  return getPool(db, id);
}

/* ================= 预览 / 确认 / 作废 ================= */

function compute(db: DB, p: PoolRow): { rule: RuleRow; amount: bigint }[] {
  const rules = activeRules(db, p.id);
  if (!rules.length) throw allocationState('成本池还没有分摊规则');
  const amounts = allocateCentsTail(p.total_cents, rules.map((r) => r.weight_scaled));
  return rules.map((rule, i) => ({ rule, amount: amounts[i] }));
}

export function previewAllocation(db: DB, poolId: number): MaAllocPreviewDto {
  const p = getPoolRow(db, poolId);
  return {
    poolId: p.id, poolVersion: p.version, total: money(p.total_cents),
    results: compute(db, p).map((x) => ({ targetOrgId: x.rule.target_org_id, targetOrgName: orgName(db, x.rule.target_org_id), weight: ratio(x.rule.weight_scaled), amount: money(x.amount) })),
  };
}

export function confirmAllocation(db: DB, poolId: number, expectedVersion: number): MaAllocRunDto {
  const runId = db.transaction(() => {
    const p = getPoolRow(db, poolId);
    assertVersion(p.version, expectedVersion, '成本池');
    if (confirmedRunId(db, poolId)) throw allocationState('成本池已有已确认的分摊,不能重复确认');
    const results = compute(db, p);
    if (sumCents(results.map((r) => r.amount)) !== p.total_cents) throw new Error('分摊不守恒');
    const now = nowIso();
    const calcRunId = insertCalcRun(db, 'allocation', p.period, { poolId, poolVersion: p.version }, now);
    const id = Number(db.prepare(`INSERT INTO ma_alloc_run (pool_id, pool_version, period, total_cents, calc_run_id, status, confirmed_by_user_id, confirmed_at)
      VALUES (?, ?, ?, ?, ?, 'confirmed', ?, ?)`).run(poolId, p.version, p.period, p.total_cents, calcRunId, currentUserId(), now).lastInsertRowid);
    const insert = db.prepare(`INSERT INTO ma_alloc_result (run_id, rule_id, target_org_id, weight_scaled, base_cents, amount_cents, sort_order) VALUES (?, ?, ?, ?, ?, ?, ?)`);
    const metricId = builtinMetricId(db);
    for (const r of results) {
      const resultId = Number(insert.run(id, r.rule.id, r.rule.target_org_id, r.rule.weight_scaled, r.amount, r.amount, r.rule.sort_order).lastInsertRowid);
      insertSnapshot(db, {
        runId: calcRunId, metricId, orgId: r.rule.target_org_id, period: p.period, allocRunId: id, now,
        outcome: { status: 'valid', valueCents: r.amount, valueScaled: null, compareCents: null, reasons: [], evidence: { source: 'ma_alloc_result', poolId, allocRunId: id, resultId, ruleId: r.rule.id, weight: ratio(r.rule.weight_scaled) } },
      });
    }
    refreshRunCounts(db, calcRunId);
    // 该期间已算好的分摊成本汇总快照不再反映最新分摊
    invalidateSnapshots(db, `metric_id = ? AND alloc_run_id IS NULL AND period = ?`, [metricId, p.period], `分摊运行 #${id} 已确认,请重新计算`, now);
    writeLog(db, 'mgmt.allocation.confirm', 'ma_alloc_run', id, { poolId, poolVersion: p.version, total: money(p.total_cents), results: results.map((r) => ({ orgId: r.rule.target_org_id, amount: money(r.amount) })) });
    return id;
  }).immediate();
  return getRun(db, runId);
}

export function voidAllocation(db: DB, runId: number, reason: string): MaAllocRunDto {
  db.transaction(() => {
    const run = getRunRow(db, runId);
    if (run.status !== 'confirmed') throw allocationState('只有已确认的分摊可以作废');
    const now = nowIso();
    db.prepare("UPDATE ma_alloc_run SET status = 'voided', version = version + 1, voided_by_user_id = ?, voided_at = ?, void_reason = ? WHERE id = ?")
      .run(currentUserId(), now, reason, runId);
    const invalidated = invalidateSnapshots(db, 'alloc_run_id = ?', [runId], `分摊运行 #${runId} 已作废`, now);
    const stale = staleAllocatedCostWhere(runId);
    const staleCount = invalidateSnapshots(db, stale.where, stale.params, `分摊运行 #${runId} 已作废`, now);
    const cancelled = db.prepare("UPDATE ma_alloc_adjustment SET status = 'cancelled', reviewed_at = ?, review_comment = '分摊已作废' WHERE run_id = ? AND status = 'pending'").run(now, runId).changes;
    writeLog(db, 'mgmt.allocation.void', 'ma_alloc_run', runId, { reason, invalidatedSnapshots: invalidated + staleCount, cancelledAdjustments: cancelled });
  }).immediate();
  return getRun(db, runId);
}

/* ================= 运行查询 ================= */

function getRunRow(db: DB, id: number): RunRow {
  const run = rows<RunRow>(db, 'SELECT * FROM ma_alloc_run WHERE id = ?', id)[0];
  if (!run) throw notVisible('分摊运行');
  getPoolRowOr404(db, run.pool_id, '分摊运行');
  return run;
}

function getPoolRowOr404(db: DB, poolId: number, what: string): PoolRow {
  try { return getPoolRow(db, poolId); } catch { throw notVisible(what); }
}

function resultDto(db: DB, r: ResultRow): MaAllocResultDto {
  return { id: r.id, targetOrgId: r.target_org_id, targetOrgName: orgName(db, r.target_org_id), weight: ratio(r.weight_scaled), baseAmount: money(r.base_cents), amount: money(r.amount_cents), sortOrder: r.sort_order };
}

function adjustmentDto(db: DB, a: AdjustmentRow, results: Map<number, ResultRow>): MaAllocAdjustmentDto {
  const org = (rid: number) => { const r = results.get(rid); return r ? orgName(db, r.target_org_id) : `#${rid}`; };
  return {
    id: a.id, runId: a.run_id, fromResultId: a.from_result_id, toResultId: a.to_result_id, fromOrgName: org(a.from_result_id), toOrgName: org(a.to_result_id),
    amount: money(a.amount_cents), reason: a.reason, status: a.status, submittedByUserId: a.submitted_by_user_id, submittedAt: a.submitted_at,
    reviewedByUserId: a.reviewed_by_user_id, reviewedAt: a.reviewed_at, reviewComment: a.review_comment, exceptionReason: a.exception_reason, selfReview: a.self_review === 1,
  };
}

function resultsOf(db: DB, runId: number): ResultRow[] {
  return rows<ResultRow>(db, 'SELECT * FROM ma_alloc_result WHERE run_id = ? ORDER BY sort_order, id', runId);
}

function runDto(db: DB, run: RunRow): MaAllocRunDto {
  const results = resultsOf(db, run.id);
  const byId = new Map(results.map((r) => [r.id, r]));
  const pool = db.prepare('SELECT name FROM ma_cost_pool WHERE id = ?').get(run.pool_id) as { name: string };
  return {
    id: run.id, poolId: run.pool_id, poolName: pool.name, poolVersion: run.pool_version, period: run.period, total: money(run.total_cents), calcRunId: run.calc_run_id,
    status: run.status, version: run.version, confirmedByUserId: run.confirmed_by_user_id, confirmedAt: run.confirmed_at, voidedAt: run.voided_at, voidReason: run.void_reason,
    results: results.map((r) => resultDto(db, r)),
    adjustments: rows<AdjustmentRow>(db, 'SELECT * FROM ma_alloc_adjustment WHERE run_id = ? ORDER BY id', run.id).map((a) => adjustmentDto(db, a, byId)),
  };
}

export function getRun(db: DB, id: number): MaAllocRunDto {
  return runDto(db, getRunRow(db, id));
}

export function listRuns(db: DB, q: { poolId?: number; status?: string } = {}): MaAllocRunDto[] {
  if (q.poolId) getPoolRow(db, q.poolId);
  const s = scope(db);
  const where: string[] = ['1 = 1'];
  const params: unknown[] = [];
  if (q.poolId) { where.push('r.pool_id = ?'); params.push(q.poolId); }
  if (q.status) { where.push('r.status = ?'); params.push(q.status); }
  return rows<RunRow & { pool_org_id: number }>(db, `SELECT r.*, p.org_id AS pool_org_id FROM ma_alloc_run r JOIN ma_cost_pool p ON p.id = r.pool_id
    WHERE ${where.join(' AND ')} ORDER BY r.id DESC LIMIT 200`, ...params)
    .filter((r) => orgInScope(s, r.pool_org_id)).map((r) => runDto(db, r));
}

/* ================= 分摊调整 ================= */

function getAdjustmentRow(db: DB, id: number): AdjustmentRow {
  const a = rows<AdjustmentRow>(db, 'SELECT * FROM ma_alloc_adjustment WHERE id = ?', id)[0];
  if (!a) throw notVisible('分摊调整');
  try { getRunRow(db, a.run_id); } catch { throw notVisible('分摊调整'); }
  return a;
}

export function createAdjustment(db: DB, runId: number, input: MaAllocAdjustmentCreate): MaAllocAdjustmentDto {
  if (input.fromResultId === input.toResultId) throw Errors.validation('调出与调入必须是不同的分摊结果');
  const amount = parseMoney(input.amount, '调整金额');
  if (amount <= 0n) throw Errors.validation('调整金额必须大于 0');
  const id = db.transaction(() => {
    const run = getRunRow(db, runId);
    if (run.status !== 'confirmed') throw allocationState('只能调整已确认的分摊');
    const results = new Map(resultsOf(db, runId).map((r) => [r.id, r]));
    const from = results.get(input.fromResultId);
    const to = results.get(input.toResultId);
    if (!from || !to) throw Errors.validation('调出与调入必须是同一分摊运行内的结果');
    if (from.amount_cents < amount) throw Errors.validation(`调出金额超过该结果当前金额 ${money(from.amount_cents)}`);
    const info = db.prepare(`INSERT INTO ma_alloc_adjustment (run_id, from_result_id, to_result_id, amount_cents, reason, submitted_by_user_id, submitted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(runId, from.id, to.id, amount, input.reason, currentUserId(), nowIso());
    const newId = Number(info.lastInsertRowid);
    writeLog(db, 'mgmt.adjustment.submit', 'ma_alloc_adjustment', newId, { runId, fromResultId: from.id, toResultId: to.id, amount: money(amount), reason: input.reason });
    return newId;
  }).immediate();
  return getAdjustment(db, id);
}

export function getAdjustment(db: DB, id: number): MaAllocAdjustmentDto {
  const a = getAdjustmentRow(db, id);
  return adjustmentDto(db, a, new Map(resultsOf(db, a.run_id).map((r) => [r.id, r])));
}

export function listPendingAdjustments(db: DB): MaAllocAdjustmentDto[] {
  const s = scope(db);
  return rows<AdjustmentRow & { pool_org_id: number }>(db, `SELECT a.*, p.org_id AS pool_org_id FROM ma_alloc_adjustment a JOIN ma_alloc_run r ON r.id = a.run_id
    JOIN ma_cost_pool p ON p.id = r.pool_id WHERE a.status = 'pending' ORDER BY a.id`)
    .filter((a) => orgInScope(s, a.pool_org_id)).map((a) => adjustmentDto(db, a, new Map(resultsOf(db, a.run_id).map((r) => [r.id, r]))));
}

export function reviewAdjustment(db: DB, id: number, input: MaReviewRequest): MaAllocAdjustmentDto {
  db.transaction(() => {
    const a = getAdjustmentRow(db, id);
    if (a.status !== 'pending') throw conflict('MGMT_ALREADY_REVIEWED', '该分摊调整已处理,不能重复复核');
    const { selfReview } = assertDistinctReviewer(db, currentAuth(), a.submitted_by_user_id, input.exceptionReason, '分摊调整');
    const now = nowIso();
    if (input.action === 'approve') {
      const run = getRunRow(db, a.run_id);
      if (run.status !== 'confirmed') throw allocationState('分摊已作废,不能批准调整');
      const results = new Map(resultsOf(db, a.run_id).map((r) => [r.id, r]));
      const from = results.get(a.from_result_id)!;
      const to = results.get(a.to_result_id)!;
      if (from.amount_cents < a.amount_cents) throw allocationState(`调出结果当前金额 ${money(from.amount_cents)} 不足以调出 ${money(a.amount_cents)}`);
      db.prepare('UPDATE ma_alloc_result SET amount_cents = amount_cents - ? WHERE id = ?').run(a.amount_cents, from.id);
      db.prepare('UPDATE ma_alloc_result SET amount_cents = amount_cents + ? WHERE id = ?').run(a.amount_cents, to.id);
      const after = resultsOf(db, a.run_id);
      if (sumCents(after.map((r) => r.amount_cents)) !== run.total_cents) throw new Error('分摊调整后不守恒');
      // 重写两个结果的快照:旧快照失效,按调整后金额新增
      const metricId = builtinMetricId(db);
      invalidateSnapshots(db, 'alloc_run_id = ? AND org_id IN (?, ?)', [run.id, from.target_org_id, to.target_org_id], `分摊调整 #${id} 已生效`, now);
      for (const r of after.filter((x) => x.id === from.id || x.id === to.id)) {
        insertSnapshot(db, {
          runId: run.calc_run_id!, metricId, orgId: r.target_org_id, period: run.period, allocRunId: run.id, adjustmentId: id, now,
          outcome: { status: 'valid', valueCents: r.amount_cents, valueScaled: null, compareCents: null, reasons: [], evidence: { source: 'ma_alloc_result', poolId: run.pool_id, allocRunId: run.id, resultId: r.id, adjustmentId: id, baseAmount: money(r.base_cents) } },
        });
      }
      refreshRunCounts(db, run.calc_run_id!);
      const stale = staleAllocatedCostWhere(run.id);
      invalidateSnapshots(db, stale.where, stale.params, `分摊调整 #${id} 已生效,请重新计算`, now);
    }
    db.prepare(`UPDATE ma_alloc_adjustment SET status = ?, reviewed_by_user_id = ?, reviewed_at = ?, review_comment = ?, exception_reason = ?, self_review = ? WHERE id = ?`)
      .run(input.action === 'approve' ? 'approved' : 'rejected', currentUserId(), now, input.comment ?? null, input.exceptionReason ?? null, selfReview ? 1 : 0, id);
    writeLog(db, 'mgmt.adjustment.review', 'ma_alloc_adjustment', id, { action: input.action, comment: input.comment, selfReview, exceptionReason: input.exceptionReason });
  }).immediate();
  return getAdjustment(db, id);
}

/* ================= 血缘 ================= */

export function lineage(db: DB, runId: number): MaLineageDto {
  const runRow = getRunRow(db, runId);
  const run = runDto(db, runRow);
  const pool = getPool(db, runRow.pool_id);
  const results = resultsOf(db, runId);
  const ruleIds = results.map((r) => r.rule_id).filter((x): x is number => x !== null);
  const rulesAtConfirm = ruleIds.length
    ? rows<RuleRow>(db, `SELECT * FROM ma_alloc_rule WHERE id IN (${ruleIds.map(() => '?').join(',')}) ORDER BY sort_order`, ...ruleIds)
    : [];
  const snapshots = snapshotsWhere(db, 's.alloc_run_id = ?', [runId]);
  const chain: MaLineageDto['chain'] = [{ kind: 'pool', id: pool.id, parent: null, label: `${pool.name}(${pool.period},${pool.total})` }];
  for (const r of rulesAtConfirm) chain.push({ kind: 'rule', id: r.id, parent: `pool:${pool.id}`, label: `${orgName(db, r.target_org_id)} 权重 ${ratio(r.weight_scaled)}` });
  chain.push({ kind: 'run', id: run.id, parent: `pool:${pool.id}`, label: `分摊运行 #${run.id}(${run.status === 'confirmed' ? '已确认' : '已作废'})` });
  for (const r of results) chain.push({ kind: 'result', id: r.id, parent: r.rule_id ? `rule:${r.rule_id}` : `run:${run.id}`, label: `${orgName(db, r.target_org_id)} ${money(r.base_cents)} → ${money(r.amount_cents)}` });
  for (const a of run.adjustments) chain.push({ kind: 'adjustment', id: a.id, parent: `result:${a.fromResultId}`, label: `${a.fromOrgName} → ${a.toOrgName} ${a.amount}(${a.status})` });
  for (const snap of snapshots) {
    chain.push({ kind: 'snapshot', id: snap.id, parent: snap.adjustmentId ? `adjustment:${snap.adjustmentId}` : `result:${String(snap.evidence.resultId)}`, label: `${snap.orgName} ${snap.value}(${snap.status})` });
  }
  return { pool, run, rulesAtConfirm: rulesAtConfirm.map((r) => ({ targetOrgId: r.target_org_id, weight: ratio(r.weight_scaled) })), snapshots, chain };
}

/** 责任中心:组织在期间内已确认分摊结果(直接目标)的合计。 */
export function allocatedCostOf(db: DB, orgId: number, period: string): bigint {
  const r = db.prepare(`SELECT COALESCE(SUM(r.amount_cents), 0) AS total FROM ma_alloc_result r JOIN ma_alloc_run ar ON ar.id = r.run_id
    WHERE ar.status = 'confirmed' AND ar.period = ? AND r.target_org_id = ?`).safeIntegers(true).get(period, orgId) as { total: bigint };
  return r.total;
}

