/**
 * 管理会计指标与计算(AC-F14):指标定义 → 计算器取数 → ma_calc_run + ma_metric_snapshot。
 *
 * - 计算器只读来源事实:当前采用预算、年度最新实际、当前 EAS 集合、当前财报批次、已确认分摊。
 * - 缺少来源时快照状态为 unavailable 并列出原因,数值为 null,绝不以 0 代替;一次运行全部不可用时整体返回 CALCULATOR_UNAVAILABLE,不落库。
 * - 取数在写事务外完成,落库是一个短事务。快照只追加,失效只改状态。
 */
import type { DB } from '../../db/connection';
import { AppError, Errors } from '../../core/errors';
import { ratioScaled, sumCents } from '../../core/decimal';
import { SIGN_BY_TYPE } from '../../core/money';
import type { TreeNodeRow } from '../../core/tree';
import { writeLog } from '../audit/log';
import { notVisible, orgInScope } from '../security/scope';
import { loadSnapshotNodes } from '../tree/snapshot';
import { resolveActualSource } from '../report/report.service';
import { currentBalanceTotals } from '../eas/eas.service';
import { currentStatementBatch, statementMetrics } from '../statements/statement.service';
import {
  maMetricParams, maThresholds, type MaAnalysisDto, type MaAnalysisQuery, type MaCalcRunDto, type MaCalcRunRequest, type MaCalculator, type MaMetricCreate,
  type MaMetricDto, type MaMetricParams, type MaMetricUpdate, type MaSnapshotDto, type MaThresholds, type MaUnavailableReason,
} from '../../contracts/mgmt';
import { assertVersion, big, currentUserId, formatValue, money, nowIso, orgName, parseByUnit, scope } from './common';
import { orgMembersOf } from './dimension.service';
import { contractPaidInPeriod, contractPaymentTotals } from '../contracts/contract.service';
import { planExecutionRate } from '../plan-execution/plan.service';

export interface MetricRow {
  id: number; code: string; name: string; unit: 'money' | 'ratio'; calculator: MaCalculator; params_json: string; thresholds_json: string;
  builtin: number; status: 'active' | 'inactive'; version: number; created_at: string; updated_at: string;
}

const UNIT_OF: Record<MaCalculator, 'money' | 'ratio'> = {
  budget_amount: 'money', actual_amount: 'money', execution_rate: 'ratio', eas_balance: 'money', statement_item: 'money', allocated_cost: 'money',
  contract_paid: 'money', contract_payment_rate: 'ratio', plan_execution_rate: 'ratio',
};

export function metricDto(r: MetricRow): MaMetricDto {
  return {
    id: r.id, code: r.code, name: r.name, unit: r.unit, calculator: r.calculator, params: { calculator: r.calculator, ...JSON.parse(r.params_json) } as MaMetricParams,
    thresholds: JSON.parse(r.thresholds_json) as MaThresholds, builtin: r.builtin === 1, status: r.status, version: r.version, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

export function getMetricRow(db: DB, id: number): MetricRow {
  const row = db.prepare('SELECT * FROM ma_metric WHERE id = ?').get(id) as MetricRow | undefined;
  if (!row) throw notVisible('指标');
  return row;
}

export function listMetrics(db: DB, q: { status?: string } = {}): MaMetricDto[] {
  const rows = q.status
    ? db.prepare('SELECT * FROM ma_metric WHERE status = ? ORDER BY builtin DESC, code').all(q.status)
    : db.prepare('SELECT * FROM ma_metric ORDER BY builtin DESC, code').all();
  return (rows as MetricRow[]).map(metricDto);
}

/** 阈值按指标单位校验可解析;偏差阈值只对 actual_amount 有意义。 */
function validateThresholds(unit: 'money' | 'ratio', calculator: MaCalculator, t: MaThresholds): void {
  for (const key of ['upperWarning', 'upperCritical', 'lowerWarning', 'lowerCritical'] as const) {
    if (t[key] !== undefined) parseByUnit(unit, t[key]!, `阈值 ${key}`);
  }
  if ((t.deviationWarning || t.deviationCritical) && calculator !== 'actual_amount') {
    throw Errors.validation('偏差比例阈值只适用于实际金额(actual_amount)指标');
  }
  for (const key of ['deviationWarning', 'deviationCritical'] as const) {
    if (t[key] !== undefined && parseByUnit('ratio', t[key]!, `阈值 ${key}`) < 0n) throw Errors.validation('偏差比例阈值不能为负');
  }
}

function paramsJson(params: MaMetricParams): string {
  const { calculator: _c, ...rest } = params;
  return JSON.stringify(rest);
}

export function createMetric(db: DB, input: MaMetricCreate): MaMetricDto {
  const calculator = input.params.calculator;
  const unit = UNIT_OF[calculator];
  validateThresholds(unit, calculator, input.thresholds);
  if (db.prepare('SELECT 1 FROM ma_metric WHERE code = ?').get(input.code)) throw Errors.conflict(`指标编码 ${input.code} 已存在`);
  const now = nowIso();
  const id = db.transaction(() => {
    const info = db.prepare(`INSERT INTO ma_metric (code, name, unit, calculator, params_json, thresholds_json, created_by_user_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(input.code, input.name, unit, calculator, paramsJson(input.params), JSON.stringify(input.thresholds), currentUserId(), now, now);
    const newId = Number(info.lastInsertRowid);
    writeLog(db, 'mgmt.metric.create', 'ma_metric', newId, { code: input.code, calculator, params: input.params, thresholds: input.thresholds });
    return newId;
  }).immediate();
  return metricDto(getMetricRow(db, id));
}

export function updateMetric(db: DB, id: number, input: MaMetricUpdate): MaMetricDto {
  db.transaction(() => {
    const row = getMetricRow(db, id);
    assertVersion(row.version, input.expectedVersion, '指标');
    if (row.builtin && (input.params || input.status === 'inactive')) throw Errors.conflict('内置指标的计算器参数与状态不可修改');
    const params = input.params ?? maMetricParams.parse({ calculator: row.calculator, ...JSON.parse(row.params_json) });
    if (params.calculator !== row.calculator) throw Errors.validation('指标计算器创建后不可更换,请新建指标');
    const thresholds = input.thresholds ?? maThresholds.parse(JSON.parse(row.thresholds_json));
    validateThresholds(row.unit, row.calculator, thresholds);
    db.prepare('UPDATE ma_metric SET name = ?, params_json = ?, thresholds_json = ?, status = ?, version = version + 1, updated_at = ? WHERE id = ?')
      .run(input.name ?? row.name, paramsJson(params), JSON.stringify(thresholds), input.status ?? row.status, nowIso(), id);
    writeLog(db, 'mgmt.metric.update', 'ma_metric', id, { name: input.name, params: input.params, thresholds: input.thresholds, status: input.status });
  }).immediate();
  return metricDto(getMetricRow(db, id));
}

/* ================= 计算器 ================= */

export interface CalcOutcome {
  status: 'valid' | 'unavailable';
  valueCents: bigint | null;
  valueScaled: bigint | null;
  compareCents: bigint | null;
  reasons: MaUnavailableReason[];
  evidence: Record<string, unknown>;
}

const unavailable = (...reasons: MaUnavailableReason[]): CalcOutcome =>
  ({ status: 'unavailable', valueCents: null, valueScaled: null, compareCents: null, reasons, evidence: {} });

function subtree(rows: TreeNodeRow[], rootId: number): Set<number> {
  const children = new Map<number, number[]>();
  for (const r of rows) if (r.parent_id !== null) children.set(r.parent_id, [...(children.get(r.parent_id) ?? []), r.id]);
  const out = new Set<number>();
  if (!rows.some((r) => r.id === rootId)) return out;
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop()!;
    out.add(id);
    stack.push(...(children.get(id) ?? []));
  }
  return out;
}

interface BudgetSide { versionId: number; versionName: string; displayCents: bigint }

type AmountResult = { ok: true; value: BudgetSide } | { ok: false; reason: MaUnavailableReason };

/** 当前采用预算(经营预算用途)在组织子树 × 科目子树上的合计,按科目类型还原为界面口径(成本费用为正)。 */
function budgetAmount(db: DB, orgId: number, year: number, accountCode: string): AmountResult {
  const v = db.prepare("SELECT id, name, org_tree_snapshot_id, account_tree_snapshot_id FROM budget_version WHERE year = ? AND kind = 'budget' AND is_current = 1")
    .get(year) as { id: number; name: string; org_tree_snapshot_id: number; account_tree_snapshot_id: number } | undefined;
  if (!v) return { ok: false, reason: { code: 'BUDGET_VERSION_MISSING', message: `${year} 年没有当前采用的经营预算版本` } };
  const orgRows = loadSnapshotNodes(db, v.org_tree_snapshot_id);
  const accRows = loadSnapshotNodes(db, v.account_tree_snapshot_id);
  const acc = accRows.find((a) => a.code === accountCode);
  if (!acc) return { ok: false, reason: { code: 'ACCOUNT_NOT_IN_BUDGET', message: `科目 ${accountCode} 不在预算版本「${v.name}」的科目树中` } };
  if (!acc.type || acc.type === 'quantity') return { ok: false, reason: { code: 'ACCOUNT_NOT_MONEY', message: `科目 ${accountCode} 是数量科目,不适用金额指标` } };
  const orgs = subtree(orgRows, orgId);
  if (!orgs.size) return { ok: false, reason: { code: 'ORG_NOT_IN_BUDGET', message: `组织不在预算版本「${v.name}」的组织树中` } };
  const accs = subtree(accRows, acc.id);
  const rows = db.prepare('SELECT org_id, account_id, amount_cents FROM budget_entry WHERE version_id = ?').all(v.id) as { org_id: number; account_id: number; amount_cents: number }[];
  const signed = sumCents(rows.filter((r) => orgs.has(r.org_id) && accs.has(r.account_id)).map((r) => r.amount_cents));
  return { ok: true, value: { versionId: v.id, versionName: v.name, displayCents: signed * BigInt(SIGN_BY_TYPE[acc.type as 'income' | 'cost' | 'expense']) } };
}

interface ActualSide { source: string; batchId: number | null; asOfDate: string | null; displayCents: bigint }
type ActualResult = { ok: true; value: ActualSide } | { ok: false; reason: MaUnavailableReason };

/** 年度最新实际(未关闭年度取当前实际,已关闭取最终快照;与完成情况表同一取数入口)。 */
function actualAmount(db: DB, orgId: number, year: number, accountCode: string): ActualResult {
  const src = resolveActualSource(db, year);
  if (src.source === 'none') return { ok: false, reason: { code: 'ACTUAL_MISSING', message: `${year} 年没有实际数快照` } };
  const acc = src.accRows.find((a) => a.code === accountCode);
  if (!acc) return { ok: false, reason: { code: 'ACCOUNT_NOT_IN_ACTUAL', message: `科目 ${accountCode} 不在实际数科目树中` } };
  if (!acc.type || acc.type === 'quantity') return { ok: false, reason: { code: 'ACCOUNT_NOT_MONEY', message: `科目 ${accountCode} 是数量科目,不适用金额指标` } };
  const orgs = subtree(src.orgRows, orgId);
  if (!orgs.size) return { ok: false, reason: { code: 'ORG_NOT_IN_ACTUAL', message: '组织不在实际数组织树中' } };
  const accs = subtree(src.accRows, acc.id);
  const signed = sumCents(src.entries.filter((e) => orgs.has(e.orgId) && accs.has(e.accountId)).map((e) => e.amountCents));
  return { ok: true, value: { source: src.source, batchId: src.batchId, asOfDate: src.asOfDate, displayCents: signed * BigInt(SIGN_BY_TYPE[acc.type as 'income' | 'cost' | 'expense']) } };
}

function orgSubtreeNow(db: DB, orgId: number): number[] {
  return (db.prepare(`WITH RECURSIVE sub(id) AS (SELECT ? UNION SELECT o.id FROM org o JOIN sub ON o.parent_id = sub.id) SELECT id FROM sub`).all(orgId) as { id: number }[]).map((r) => r.id);
}

export function runCalculator(db: DB, metric: MetricRow, orgId: number, period: string): CalcOutcome {
  const params = maMetricParams.parse({ calculator: metric.calculator, ...JSON.parse(metric.params_json) });
  const year = Number(period.slice(0, 4));
  switch (params.calculator) {
    case 'budget_amount': {
      const b = budgetAmount(db, orgId, year, params.accountCode);
      if (!b.ok) return unavailable(b.reason);
      return { status: 'valid', valueCents: b.value.displayCents, valueScaled: null, compareCents: null, reasons: [], evidence: { source: 'budget_version', versionId: b.value.versionId, versionName: b.value.versionName, accountCode: params.accountCode, year } };
    }
    case 'actual_amount': {
      const a = actualAmount(db, orgId, year, params.accountCode);
      if (!a.ok) return unavailable(a.reason);
      const b = budgetAmount(db, orgId, year, params.accountCode);
      return {
        status: 'valid', valueCents: a.value.displayCents, valueScaled: null, compareCents: b.ok ? b.value.displayCents : null, reasons: [],
        evidence: { source: 'actual', actualSource: a.value.source, actualBatchId: a.value.batchId, asOfDate: a.value.asOfDate, accountCode: params.accountCode, year, budgetVersionId: b.ok ? b.value.versionId : null },
      };
    }
    case 'execution_rate': {
      const reasons: MaUnavailableReason[] = [];
      const b = budgetAmount(db, orgId, year, params.accountCode);
      const a = actualAmount(db, orgId, year, params.accountCode);
      if (!b.ok) reasons.push(b.reason);
      if (!a.ok) reasons.push(a.reason);
      if (!b.ok || !a.ok) return unavailable(...reasons);
      const r = ratioScaled(a.value.displayCents, b.value.displayCents);
      if (r === null) return unavailable({ code: 'BUDGET_ZERO', message: '预算为 0,执行率不可计算' });
      return {
        status: 'valid', valueCents: null, valueScaled: r, compareCents: null, reasons: [],
        evidence: { source: 'budget_vs_actual', versionId: b.value.versionId, actualSource: a.value.source, actualBatchId: a.value.batchId, asOfDate: a.value.asOfDate, budget: money(b.value.displayCents), actual: money(a.value.displayCents), accountCode: params.accountCode },
      };
    }
    case 'eas_balance': {
      const cur = currentBalanceTotals(db, orgId, period);
      if (!cur) return unavailable({ code: 'EAS_SET_MISSING', message: `${period} 没有当前 EAS 集合或集合缺少余额表` });
      const t = cur.totals.get(params.accountCode);
      if (!t) return unavailable({ code: 'EAS_ACCOUNT_MISSING', message: `当前 EAS 余额表中没有科目 ${params.accountCode}` });
      const value = params.field === 'end_net' ? t.endDebit - t.endCredit : params.field === 'end_debit' ? t.endDebit
        : params.field === 'end_credit' ? t.endCredit : params.field === 'period_debit' ? t.debit : t.credit;
      return { status: 'valid', valueCents: value, valueScaled: null, compareCents: null, reasons: [], evidence: { source: 'eas_recon_set', setId: cur.setId, batchId: cur.batchId, accountCode: params.accountCode, field: params.field } };
    }
    case 'statement_item': {
      const batch = currentStatementBatch(db, { orgId, period, scope: params.scope });
      if (!batch) return unavailable({ code: 'STATEMENT_MISSING', message: `${period} 没有当前财务报表批次` });
      const v = statementMetrics(db, batch.id)[params.metricKey];
      if (v === undefined) return unavailable({ code: 'STATEMENT_ITEM_MISSING', message: `当前财报批次缺少语义指标 ${params.metricKey}` });
      return { status: 'valid', valueCents: v, valueScaled: null, compareCents: null, reasons: [], evidence: { source: 'stmt_batch', batchId: batch.id, scope: batch.scope, metricKey: params.metricKey } };
    }
    case 'allocated_cost': {
      const orgs = orgSubtreeNow(db, orgId);
      const rows = db.prepare(`SELECT r.run_id, r.amount_cents FROM ma_alloc_result r JOIN ma_alloc_run ar ON ar.id = r.run_id
        WHERE ar.status = 'confirmed' AND ar.period = ? AND r.target_org_id IN (${orgs.map(() => '?').join(',')})`).safeIntegers(true).all(period, ...orgs) as { run_id: bigint; amount_cents: bigint }[];
      if (!rows.length) return unavailable({ code: 'ALLOCATION_MISSING', message: `${period} 没有已确认的分摊结果` });
      const allocRunIds = [...new Set(rows.map((r) => Number(r.run_id)))].sort((a, b) => a - b);
      return { status: 'valid', valueCents: sumCents(rows.map((r) => r.amount_cents)), valueScaled: null, compareCents: null, reasons: [], evidence: { source: 'ma_alloc_run', allocRunIds } };
    }
    case 'contract_paid': {
      // 组织(含下级)期间内登记支付的合同付款;作废合同不计。没有付款时为 0(已付是确定的 0,不是缺数)
      const orgs = orgSubtreeNow(db, orgId);
      const paid = contractPaidInPeriod(db, orgs, period);
      const n = (db.prepare(`SELECT COUNT(*) AS n FROM ct_contract WHERE status <> 'voided' AND org_id IN (${orgs.map(() => '?').join(',')})`).get(...orgs) as { n: number }).n;
      if (!n) return unavailable({ code: 'CONTRACT_MISSING', message: '组织范围内没有有效合同' });
      return { status: 'valid', valueCents: paid, valueScaled: null, compareCents: null, reasons: [], evidence: { source: 'ct_payment', period, contractCount: n } };
    }
    case 'contract_payment_rate': {
      // 计算时点的有效合同(进行中/关闭/终止)累计已付 / 当前金额
      const t = contractPaymentTotals(db, orgSubtreeNow(db, orgId));
      const r = ratioScaled(t.paid, t.current);
      if (r === null) return unavailable({ code: 'CONTRACT_MISSING', message: '组织范围内没有当前金额大于 0 的有效合同' });
      return { status: 'valid', valueCents: null, valueScaled: r, compareCents: null, reasons: [], evidence: { source: 'ct_contract', paid: money(t.paid), current: money(t.current), asOf: nowIso() } };
    }
    case 'plan_execution_rate': {
      // 同年取数:该年截至期间已激活的最新计划执行批次;年度累计实际 / 年度计划
      const p = planExecutionRate(db, orgId, period);
      if (p.annualPlanCents === null || p.annualActualCents === null) return unavailable({ code: 'PLAN_MISSING', message: p.note ?? '没有可用的计划执行数据' });
      const r = ratioScaled(p.annualActualCents, p.annualPlanCents);
      if (r === null) return unavailable({ code: 'PLAN_ZERO', message: '年度计划为 0,执行率不可计算' });
      return {
        status: 'valid', valueCents: null, valueScaled: r, compareCents: null, reasons: [],
        evidence: { source: 'plan_batch', batchId: p.batchId, annualPlan: money(p.annualPlanCents), annualActual: money(p.annualActualCents), rowCount: p.rowCount },
      };
    }
  }
}

/* ================= 计算运行与快照 ================= */

export interface SnapshotRow {
  id: bigint; run_id: bigint; metric_id: bigint; org_id: bigint; period: string; status: MaSnapshotDto['status']; value_cents: bigint | null; value_scaled: bigint | null;
  compare_cents: bigint | null; reasons_json: string; evidence_json: string; alloc_run_id: bigint | null; adjustment_id: bigint | null;
  invalidated_at: string | null; invalidated_reason: string | null; created_at: string; code: string; name: string; unit: 'money' | 'ratio';
}

const SNAPSHOT_SELECT = 'SELECT s.*, m.code, m.name, m.unit FROM ma_metric_snapshot s JOIN ma_metric m ON m.id = s.metric_id';

function snapshotDto(db: DB, r: SnapshotRow): MaSnapshotDto {
  return {
    id: Number(r.id), runId: Number(r.run_id), metricId: Number(r.metric_id), metricCode: r.code, metricName: r.name, unit: r.unit, orgId: Number(r.org_id),
    orgName: orgName(db, Number(r.org_id)), period: r.period, status: r.status, value: formatValue(r.unit, big(r.value_cents), big(r.value_scaled)),
    compareValue: r.compare_cents === null ? null : money(r.compare_cents), reasons: JSON.parse(r.reasons_json) as MaUnavailableReason[],
    evidence: JSON.parse(r.evidence_json) as Record<string, unknown>, allocRunId: r.alloc_run_id === null ? null : Number(r.alloc_run_id),
    adjustmentId: r.adjustment_id === null ? null : Number(r.adjustment_id), invalidatedAt: r.invalidated_at, invalidatedReason: r.invalidated_reason, createdAt: r.created_at,
  };
}

export function snapshotRows(db: DB, where: string, params: unknown[]): SnapshotRow[] {
  const s = scope(db);
  return (db.prepare(`${SNAPSHOT_SELECT} WHERE ${where} ORDER BY s.id`).safeIntegers(true).all(...params) as SnapshotRow[])
    .filter((r) => orgInScope(s, Number(r.org_id)));
}

export function snapshotsWhere(db: DB, where: string, params: unknown[]): MaSnapshotDto[] {
  return snapshotRows(db, where, params).map((r) => snapshotDto(db, r));
}

export function insertSnapshot(db: DB, v: {
  runId: number; metricId: number; orgId: number; period: string; outcome: CalcOutcome; allocRunId?: number | null; adjustmentId?: number | null; now: string;
}): number {
  const o = v.outcome;
  const info = db.prepare(`INSERT INTO ma_metric_snapshot (run_id, metric_id, org_id, period, status, value_cents, value_scaled, compare_cents, reasons_json, evidence_json,
    alloc_run_id, adjustment_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    v.runId, v.metricId, v.orgId, v.period, o.status, o.valueCents, o.valueScaled, o.compareCents, JSON.stringify(o.reasons), JSON.stringify(o.evidence),
    v.allocRunId ?? null, v.adjustmentId ?? null, v.now);
  return Number(info.lastInsertRowid);
}

export function insertCalcRun(db: DB, kind: 'calc' | 'allocation', period: string, request: Record<string, unknown>, now: string): number {
  return Number(db.prepare('INSERT INTO ma_calc_run (kind, period, request_json, created_by_user_id, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(kind, period, JSON.stringify(request), currentUserId(), now).lastInsertRowid);
}

export function refreshRunCounts(db: DB, runId: number): void {
  db.prepare(`UPDATE ma_calc_run SET snapshot_count = (SELECT COUNT(*) FROM ma_metric_snapshot WHERE run_id = ?),
    unavailable_count = (SELECT COUNT(*) FROM ma_metric_snapshot WHERE run_id = ? AND status = 'unavailable') WHERE id = ?`).run(runId, runId, runId);
}

/** 失效快照:只把 valid 改为 invalidated 并记原因。 */
export function invalidateSnapshots(db: DB, where: string, params: unknown[], reason: string, now: string): number {
  return db.prepare(`UPDATE ma_metric_snapshot SET status = 'invalidated', invalidated_at = ?, invalidated_reason = ? WHERE status = 'valid' AND (${where})`)
    .run(now, reason, ...params).changes;
}

/** 计算运行引用某分摊运行的 allocated_cost 快照(证据 allocRunIds 含该运行)。 */
export function staleAllocatedCostWhere(allocRunId: number): { where: string; params: unknown[] } {
  return {
    where: `metric_id IN (SELECT id FROM ma_metric WHERE calculator = 'allocated_cost') AND alloc_run_id IS NULL
      AND EXISTS (SELECT 1 FROM json_each(evidence_json, '$.allocRunIds') j WHERE j.value = ?)`,
    params: [allocRunId],
  };
}

export function createCalcRun(db: DB, input: MaCalcRunRequest): MaCalcRunDto {
  const s = scope(db);
  const metrics = input.metricIds
    ? input.metricIds.map((id) => {
      const m = getMetricRow(db, id);
      if (m.status !== 'active') throw Errors.conflict(`指标 ${m.code} 已停用`);
      return m;
    })
    : (db.prepare("SELECT * FROM ma_metric WHERE status = 'active' ORDER BY code").all() as MetricRow[]);
  if (!metrics.length) throw Errors.validation('没有可计算的启用指标');
  let orgIds: number[];
  if (input.orgIds) {
    for (const id of input.orgIds) {
      if (!db.prepare('SELECT 1 FROM org WHERE id = ?').get(id) || !orgInScope(s, id)) throw notVisible('组织');
    }
    orgIds = [...new Set(input.orgIds)];
  } else {
    orgIds = (db.prepare("SELECT id FROM org WHERE status = 'active' ORDER BY sort_order, id").all() as { id: number }[]).map((r) => r.id).filter((id) => orgInScope(s, id));
  }
  if (!orgIds.length) throw Errors.validation('授权范围内没有可计算的组织');
  if (metrics.length * orgIds.length > 5000) throw Errors.validation('单次计算最多 5000 个指标 × 组织组合,请缩小范围');

  // 取数在写事务之外完成
  const outcomes = metrics.flatMap((m) => orgIds.map((orgId) => ({ m, orgId, o: runCalculator(db, m, orgId, input.period) })));
  if (outcomes.every((x) => x.o.status === 'unavailable')) {
    throw new AppError('CALCULATOR_UNAVAILABLE', '所选指标在该期间都缺少来源数据,未生成计算结果', 409, undefined, {
      items: outcomes.map((x) => ({ metricCode: x.m.code, orgId: x.orgId, orgName: orgName(db, x.orgId), reasons: x.o.reasons })),
    });
  }
  const runId = db.transaction(() => {
    const now = nowIso();
    const id = insertCalcRun(db, 'calc', input.period, { metricIds: metrics.map((m) => m.id), orgIds }, now);
    for (const x of outcomes) insertSnapshot(db, { runId: id, metricId: x.m.id, orgId: x.orgId, period: input.period, outcome: x.o, now });
    refreshRunCounts(db, id);
    writeLog(db, 'mgmt.calc.run', 'ma_calc_run', id, { period: input.period, metrics: metrics.map((m) => m.code), orgCount: orgIds.length, unavailable: outcomes.filter((x) => x.o.status === 'unavailable').length });
    return id;
  }).immediate();
  return getCalcRun(db, runId);
}

interface CalcRunRow { id: number; kind: 'calc' | 'allocation'; period: string; request_json: string; snapshot_count: number; unavailable_count: number; created_by_user_id: number | null; created_at: string }

function runDto(r: CalcRunRow): MaCalcRunDto {
  return { id: r.id, kind: r.kind, period: r.period, request: JSON.parse(r.request_json) as Record<string, unknown>, snapshotCount: r.snapshot_count, unavailableCount: r.unavailable_count, createdByUserId: r.created_by_user_id, createdAt: r.created_at };
}

/** 运行可见:运行中至少有一个快照在授权范围内(全组织用户全部可见)。 */
function runVisible(db: DB, runId: number): boolean {
  const s = scope(db);
  if (s.all) return true;
  const orgs = db.prepare('SELECT DISTINCT org_id FROM ma_metric_snapshot WHERE run_id = ?').all(runId) as { org_id: number }[];
  return orgs.some((o) => orgInScope(s, o.org_id));
}

export function getCalcRunRow(db: DB, id: number): CalcRunRow {
  const row = db.prepare('SELECT * FROM ma_calc_run WHERE id = ?').get(id) as CalcRunRow | undefined;
  if (!row || !runVisible(db, id)) throw notVisible('计算运行');
  return row;
}

export function getCalcRun(db: DB, id: number): MaCalcRunDto {
  const row = getCalcRunRow(db, id);
  return { ...runDto(row), snapshots: snapshotsWhere(db, 's.run_id = ?', [id]) };
}

export function listCalcRuns(db: DB, q: { period?: string; kind?: string } = {}): MaCalcRunDto[] {
  const where: string[] = ['1 = 1'];
  const params: unknown[] = [];
  if (q.period) { where.push('period = ?'); params.push(q.period); }
  if (q.kind) { where.push('kind = ?'); params.push(q.kind); }
  return (db.prepare(`SELECT * FROM ma_calc_run WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT 200`).all(...params) as CalcRunRow[])
    .filter((r) => runVisible(db, r.id)).map(runDto);
}

export function listSnapshots(db: DB, q: { metricId?: number; orgId?: number; period?: string; status?: string; runId?: number }): MaSnapshotDto[] {
  const where: string[] = ['1 = 1'];
  const params: unknown[] = [];
  if (q.orgId) {
    if (!orgInScope(scope(db), q.orgId)) throw notVisible('组织');
    where.push('s.org_id = ?'); params.push(q.orgId);
  }
  if (q.metricId) { where.push('s.metric_id = ?'); params.push(q.metricId); }
  if (q.period) { where.push('s.period = ?'); params.push(q.period); }
  if (q.status) { where.push('s.status = ?'); params.push(q.status); }
  if (q.runId) { where.push('s.run_id = ?'); params.push(q.runId); }
  return snapshotsWhere(db, where.join(' AND '), params).slice(-2000);
}

/**
 * 某指标 × 组织 × 期间的“当前值”:优先取计算运行的最新有效快照;
 * 分摊成本指标没有计算快照时,取该组织各有效分摊快照之和(每个分摊运行一条)。
 */
export function latestValue(db: DB, metric: MetricRow, orgId: number, period: string): { value: string | null; snapshotId: number | null; runId: number | null } {
  const calc = db.prepare(`SELECT s.* FROM ma_metric_snapshot s JOIN ma_calc_run r ON r.id = s.run_id
    WHERE s.metric_id = ? AND s.org_id = ? AND s.period = ? AND s.status = 'valid' AND r.kind = 'calc' ORDER BY s.id DESC LIMIT 1`)
    .safeIntegers(true).get(metric.id, orgId, period) as SnapshotRow | undefined;
  if (calc) return { value: formatValue(metric.unit, big(calc.value_cents), big(calc.value_scaled)), snapshotId: Number(calc.id), runId: Number(calc.run_id) };
  if (metric.calculator === 'allocated_cost') {
    const rows = db.prepare(`SELECT id, run_id, value_cents FROM ma_metric_snapshot WHERE metric_id = ? AND org_id = ? AND period = ? AND status = 'valid' ORDER BY id DESC`)
      .safeIntegers(true).all(metric.id, orgId, period) as { id: bigint; run_id: bigint; value_cents: bigint }[];
    if (rows.length) return { value: money(sumCents(rows.map((r) => r.value_cents))), snapshotId: Number(rows[0].id), runId: Number(rows[0].run_id) };
  }
  return { value: null, snapshotId: null, runId: null };
}

/** 多维分析:指标 × 期间 × 组织/组织型维度成员,值取自快照并返回来源运行。 */
export function analyze(db: DB, q: MaAnalysisQuery): MaAnalysisDto {
  const s = scope(db);
  const metrics = q.metricIds.map((id) => getMetricRow(db, id));
  let groups: { key: string; name: string; orgId: number }[];
  if (q.groupBy === 'dimension') {
    if (!q.dimensionId) throw Errors.validation('按维度分组需要指定 dimensionId');
    groups = orgMembersOf(db, q.dimensionId).map((m) => ({ key: m.code, name: m.name, orgId: m.orgId }));
  } else {
    let orgIds = q.orgIds?.length ? q.orgIds : null;
    if (orgIds) {
      for (const id of orgIds) if (!orgInScope(s, id)) throw notVisible('组织');
    } else {
      const ph = q.periods.map(() => '?').join(',');
      const mh = q.metricIds.map(() => '?').join(',');
      orgIds = (db.prepare(`SELECT DISTINCT org_id FROM ma_metric_snapshot WHERE status = 'valid' AND period IN (${ph}) AND metric_id IN (${mh})`)
        .all(...q.periods, ...q.metricIds) as { org_id: number }[]).map((r) => r.org_id).filter((id) => orgInScope(s, id));
    }
    groups = orgIds.map((id) => ({ key: String((db.prepare('SELECT code FROM org WHERE id = ?').get(id) as { code: string } | undefined)?.code ?? id), name: orgName(db, id), orgId: id }));
  }
  const rows: MaAnalysisDto['rows'] = [];
  for (const m of metrics) {
    for (const period of q.periods) {
      for (const g of groups) {
        const v = latestValue(db, m, g.orgId, period);
        rows.push({ metricId: m.id, metricCode: m.code, metricName: m.name, unit: m.unit, period, groupKey: g.key, groupName: g.name, orgId: g.orgId, ...v });
      }
    }
  }
  return { groupBy: q.groupBy, rows };
}

