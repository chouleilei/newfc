import type { DB } from '../../db/connection';
import type { ContractRow } from './contract.service';
import { AppError } from '../../core/errors';
import { mulCents, RATIO_SCALE } from '../../core/decimal';
import { signOfType } from '../../core/money';
import { workingDaysBetween } from '../../core/workdays';
import { workingCalendar } from '../settings/business-settings';
import { requireEvidence } from './contract-controls';

const fail = (code: string, message: string) => new AppError(code, message, 409);
export function rmbCents(c: Pick<ContractRow, 'currency' | 'exchange_rate_scaled'>, value: bigint): bigint {
  if (c.currency === '人民币') return value;
  if (!c.exchange_rate_scaled || c.exchange_rate_scaled <= 0n) throw fail('EXCHANGE_RATE_REQUIRED', '关联人民币计划/预算或付款分级时，外币合同须登记参考汇率');
  return mulCents(value, c.exchange_rate_scaled, RATIO_SCALE);
}

export function tryRmbCents(
  c: Pick<ContractRow, 'currency' | 'exchange_rate_scaled' | 'currency_struct_status'>,
  value: bigint,
): bigint | null {
  if (c.currency_struct_status && c.currency_struct_status !== 'single') return null;
  if (c.currency === '人民币') return value;
  if (!c.exchange_rate_scaled || c.exchange_rate_scaled <= 0n) return null;
  return mulCents(value, c.exchange_rate_scaled, RATIO_SCALE);
}

export interface BudgetPoolUsageInfo {
  capCents: bigint | null;
  usedOtherCents: bigint;
  thisCents: bigint;
  totalUsedCents: bigint;
  remainingCents: bigint | null;
}

function contractAnnualPoolRmb(r: Pick<ContractRow, 'currency' | 'exchange_rate_scaled' | 'currency_struct_status' | 'migration_mode' | 'pricing_mode' | 'estimated_ceiling_cents' | 'original_cents' | 'approved_change_cents' | 'annual_plan_alloc_cents'>, delta = 0n): bigint {
  const base =
    r.annual_plan_alloc_cents !== null && r.annual_plan_alloc_cents !== undefined
      ? BigInt(r.annual_plan_alloc_cents) + delta
      : (r.pricing_mode === 'unit_price'
          ? (r.estimated_ceiling_cents ?? 0n) + delta
          : BigInt(r.original_cents) + BigInt(r.approved_change_cents) + delta);
  if (r.migration_mode === 'legacy_tolerant') {
    return tryRmbCents(r, base) ?? 0n;
  }
  return rmbCents(r, base);
}

/** 计算生产经营总额包干池（lump_sum_pool）同组织/同科目/同计划项跨合同年度占用与剩余可用额度。 */
export function computeBudgetPoolUsage(
  db: DB,
  c: Pick<
    ContractRow,
    | 'id'
    | 'org_id'
    | 'direction'
    | 'budget_type'
    | 'budget_pool_account_id'
    | 'budget_pool_cap_cents'
    | 'plan_item_id'
    | 'sign_date'
    | 'created_at'
    | 'currency'
    | 'exchange_rate_scaled'
    | 'currency_struct_status'
    | 'migration_mode'
    | 'pricing_mode'
    | 'estimated_ceiling_cents'
    | 'original_cents'
    | 'approved_change_cents'
    | 'annual_plan_alloc_cents'
  >,
  delta = 0n,
): BudgetPoolUsageInfo | null {
  if (c.direction !== 'expense' || c.budget_type !== 'lump_sum_pool') return null;
  const yearStr = (c.sign_date || c.created_at || new Date().toISOString()).slice(0, 4);
  const yearNum = Number(yearStr) || new Date().getUTCFullYear();

  let capCents: bigint | null = c.budget_pool_cap_cents != null ? BigInt(c.budget_pool_cap_cents) : null;
  if (capCents === null && c.budget_pool_account_id != null) {
    const entryCap = db
      .prepare(
        `SELECT SUM(be.amount_cents) AS cap, a.type AS account_type
         FROM budget_entry be
         JOIN budget_version bv ON bv.id = be.version_id
         JOIN account a ON a.id = be.account_id
         WHERE be.org_id = ? AND be.account_id = ? AND bv.year = ? AND bv.kind = 'budget' AND bv.status IN ('locked','draft')
         GROUP BY bv.id, a.type
         ORDER BY bv.is_current DESC, CASE bv.status WHEN 'locked' THEN 0 ELSE 1 END, bv.id DESC
         LIMIT 1`,
      )
      .safeIntegers(true)
      .get(c.org_id, c.budget_pool_account_id, yearNum) as { cap: bigint | null; account_type: string } | undefined;
    if (entryCap?.cap != null) {
      capCents = BigInt(entryCap.cap) * BigInt(signOfType(entryCap.account_type));
    }
  }
  if (capCents === null && c.plan_item_id != null) {
    const planCap = db
      .prepare(
        `SELECT f.amount_cents AS cap
         FROM plan_fact f
         JOIN plan_item i ON i.id = f.item_id
         JOIN plan_batch b ON b.id = i.batch_id
         WHERE i.item_key = (SELECT item_key FROM plan_item WHERE id = ?)
           AND COALESCE(i.org_id, -1) = COALESCE((SELECT org_id FROM plan_item WHERE id = ?), -1)
           AND b.year = (SELECT b2.year FROM plan_item i2 JOIN plan_batch b2 ON b2.id = i2.batch_id WHERE i2.id = ?)
           AND b.is_current = 1 AND b.status <> 'voided'
           AND f.measure = 'annual_plan' AND f.field_key = 'annual_plan' AND f.value_type = 'amount'
         ORDER BY b.year DESC, b.actual_period DESC LIMIT 1`,
      )
      .safeIntegers(true)
      .get(c.plan_item_id, c.plan_item_id, c.plan_item_id) as { cap: bigint | null } | undefined;
    if (planCap?.cap != null) capCents = BigInt(planCap.cap);
  }

  const yearExpr = "substr(COALESCE(NULLIF(sign_date, ''), created_at), 1, 4) = ?";
  const poolWhere =
    c.budget_pool_account_id != null
      ? `budget_pool_account_id = ? AND ${yearExpr}`
      : c.plan_item_id != null
        ? `plan_item_id IN (
             SELECT i2.id FROM plan_item i2
             JOIN plan_batch b2 ON b2.id = i2.batch_id
             WHERE i2.item_key = (SELECT item_key FROM plan_item WHERE id = ?)
               AND COALESCE(i2.org_id, -1) = COALESCE((SELECT org_id FROM plan_item WHERE id = ?), -1)
               AND b2.year = (SELECT b3.year FROM plan_item i3 JOIN plan_batch b3 ON b3.id = i3.batch_id WHERE i3.id = ?)
           )`
        : `budget_pool_account_id IS NULL AND plan_item_id IS NULL AND ${yearExpr}`;
  const poolParams: unknown[] =
    c.budget_pool_account_id != null
      ? [c.budget_pool_account_id, yearStr]
      : c.plan_item_id != null
        ? [c.plan_item_id, c.plan_item_id, c.plan_item_id]
        : [yearStr];

  if (capCents === null) {
    // 继承同组织同年度同池其他合同已登记的池上限
    const peerCap = db
      .prepare(
        `SELECT MAX(budget_pool_cap_cents) AS cap
         FROM ct_contract
         WHERE org_id = ? AND budget_type = 'lump_sum_pool' AND status <> 'voided'
           AND id <> ? AND budget_pool_cap_cents IS NOT NULL
           AND (${poolWhere})`,
      )
      .safeIntegers(true)
      .get(c.org_id, c.id || 0, ...poolParams) as { cap: bigint | null } | undefined;
    if (peerCap?.cap != null) capCents = BigInt(peerCap.cap);
  }

  const peers = db
    .prepare(
      `SELECT currency, exchange_rate_scaled, currency_struct_status, migration_mode,
              pricing_mode, estimated_ceiling_cents, original_cents, approved_change_cents, annual_plan_alloc_cents
       FROM ct_contract
       WHERE org_id = ? AND budget_type = 'lump_sum_pool' AND direction = 'expense'
         AND status <> 'voided' AND id <> ? AND ${poolWhere}`,
    )
    .safeIntegers(true)
    .all(c.org_id, c.id || 0, ...poolParams) as ContractRow[];

  const usedOtherCents = peers.reduce((sum, p) => sum + contractAnnualPoolRmb(p, 0n), 0n);
  const thisCents = contractAnnualPoolRmb(c, delta);
  const totalUsedCents = usedOtherCents + thisCents;
  const remainingCents = capCents === null ? null : capCents - totalUsedCents;
  return { capCents, usedOtherCents, thisCents, totalUsedCents, remainingCents };
}

export function assertBudgetPoolCap(
  db: DB,
  c: Parameters<typeof computeBudgetPoolUsage>[1],
  opts: { delta?: bigint; hasOverride?: boolean } = {},
): void {
  const usage = computeBudgetPoolUsage(db, c, opts.delta ?? 0n);
  if (!usage || usage.capCents === null || opts.hasOverride) return;
  if (usage.thisCents > 0n && usage.totalUsedCents > usage.capCents) {
    throw fail(
      'BUDGET_POOL_EXCEEDED',
      '生产经营总额包干项目跨合同累计占用突破年度包干总额池上限，须先调增包干额度或办理计划外审批',
    );
  }
}

/** 签署、变更、结算和支付共用同一额度口径。仅正式采用的来源批次参与计算。 */
export function assertContractFunding(db: DB, c: ContractRow, opts: { delta?: bigint; settlementGross?: bigint; paymentTotal?: bigint; outOfPlanDocId?: number | null; paymentDate?: string | null } = {}): void {
  if (c.direction !== 'expense') return;
  // 历史容缺外币/复币合同在未补录汇率且非新发起付款锁定时，不阻断只读与基础维护
  if (
    c.migration_mode === 'legacy_tolerant' &&
    opts.paymentTotal === undefined &&
    tryRmbCents(c, 0n) === null
  ) {
    return;
  }
  const candidate = c.pricing_mode === 'unit_price' ? c.estimated_ceiling_cents ?? 0n : BigInt(c.original_cents) + BigInt(c.approved_change_cents);
  const amount = candidate + (opts.delta ?? 0n);
  const override = opts.outOfPlanDocId ?? (opts.delta !== undefined ? undefined : (db.prepare("SELECT id FROM ct_document WHERE contract_id = ? AND evidence_kind = 'out_of_plan_approval' AND withdrawn_at IS NULL ORDER BY id DESC LIMIT 1").get(c.id) as { id: number } | undefined)?.id);
  if (override) requireEvidence(db, c.id, override, ['out_of_plan_approval']);
  const sumOther = (column: 'commitment' | 'settled' | 'paid', key: 'project_id' | 'plan_item_id', id: number): bigint => {
    const rows = db.prepare(`SELECT currency, exchange_rate_scaled, migration_mode, currency_struct_status, original_cents, approved_change_cents, annual_plan_alloc_cents, pricing_mode, estimated_ceiling_cents, settled_gross_cents, paid_cents + COALESCE((SELECT SUM(amount_cents) FROM ct_payment p WHERE p.contract_id = ct_contract.id AND p.status = 'approved'),0) AS paid_cents FROM ct_contract
      WHERE ${key === 'plan_item_id' ? 'plan_item_id IN (SELECT id FROM plan_item WHERE item_key=(SELECT item_key FROM plan_item WHERE id=?) AND org_id=(SELECT org_id FROM plan_item WHERE id=?))' : 'project_id = ?'} AND id <> ? AND direction = 'expense' AND status <> 'voided' AND stage IN ('performance','settlement','warranty','closed')`).safeIntegers(true).all(...(key === 'plan_item_id' ? [id,id,c.id] : [id,c.id])) as ContractRow[];
    return rows.reduce((s, r) => {
      const raw =
        column === 'settled'
          ? r.settled_gross_cents
          : column === 'paid'
            ? r.paid_cents
            : key === 'plan_item_id' && r.annual_plan_alloc_cents != null
              ? BigInt(r.annual_plan_alloc_cents)
              : r.pricing_mode === 'unit_price'
                ? r.estimated_ceiling_cents ?? 0n
                : r.original_cents + r.approved_change_cents;
      if (r.migration_mode === 'legacy_tolerant') {
        return s + (tryRmbCents(r, raw) ?? 0n);
      }
      return s + rmbCents(r, raw);
    }, 0n);
  };
  if (c.plan_item_id && (opts.delta === undefined || opts.delta > 0n)) {
    const plan = db.prepare(`SELECT f.amount_cents AS cap FROM plan_fact f JOIN plan_item i ON i.id = f.item_id JOIN plan_batch b ON b.id = i.batch_id
      WHERE i.item_key = (SELECT item_key FROM plan_item WHERE id = ?) AND i.org_id = (SELECT org_id FROM plan_item WHERE id = ?)
      AND b.is_current = 1 AND b.status <> 'voided' AND f.measure = 'annual_plan' AND f.field_key = 'annual_plan' AND f.value_type = 'amount'
      ORDER BY b.year DESC, b.actual_period DESC LIMIT 1`).safeIntegers(true).get(c.plan_item_id, c.plan_item_id) as { cap: bigint } | undefined;
    if (!plan) throw fail('PLAN_SOURCE_MISSING', '关联计划未有正式采用的年度金额，请先确认计划');
    const annualBasis = c.annual_plan_alloc_cents != null ? BigInt(c.annual_plan_alloc_cents) + (opts.delta ?? 0n) : amount;
    const used = sumOther('commitment', 'plan_item_id', c.plan_item_id) + rmbCents(c, annualBasis);
    if (used > plan.cap && !override) throw fail('OUT_OF_PLAN_APPROVAL_REQUIRED', '合同及变更占用超过综合计划额度，须先办理计划外审批');
  }
  assertBudgetPoolCap(db, c, { delta: opts.delta, hasOverride: !!override });
  if (!c.project_id) return;
  const budget = db.prepare(`SELECT SUM(e.budget_cents) AS cap FROM pb_entry e WHERE e.project_id = ? AND e.batch_id = (
    SELECT b.id FROM pb_batch b JOIN pb_entry e2 ON e2.batch_id = b.id WHERE e2.project_id = ? AND b.is_current = 1 AND b.status <> 'voided' ORDER BY b.year DESC, b.period DESC LIMIT 1)`)
    .safeIntegers(true).get(c.project_id, c.project_id) as { cap: bigint | null };
  if (budget.cap !== null && (opts.delta === undefined || opts.delta > 0n)) {
    const used = sumOther(opts.paymentTotal !== undefined ? 'paid' : 'commitment', 'project_id', c.project_id) + rmbCents(c, opts.paymentTotal ?? amount);
    if (used > budget.cap && !override) throw fail('PROJECT_BUDGET_EXCEEDED', '项目合同/付款总额超过正式项目预算，须先办理超预算审批');
    if (used > budget.cap && opts.paymentTotal !== undefined && (!c.out_of_plan_approved_date || (workingDaysBetween(c.out_of_plan_approved_date, opts.paymentDate || new Date().toISOString().slice(0,10), workingCalendar(db)) ?? 0) < 5)) throw fail('BUDGET_APPROVAL_NOTICE_REQUIRED', '超预算支付须登记审批日期并提前5个工作日报批');
  }
  const investment = db.prepare('SELECT approved_cents FROM ic_project WHERE md_project_id = ?').safeIntegers(true).get(c.project_id) as { approved_cents: bigint | null } | undefined;
  if (investment?.approved_cents != null) {
    const commitments = sumOther('commitment', 'project_id', c.project_id) + rmbCents(c, amount);
    const settled = sumOther('settled', 'project_id', c.project_id) + rmbCents(c, c.settled_gross_cents + (opts.settlementGross ?? 0n));
    const paid = sumOther('paid', 'project_id', c.project_id) + rmbCents(c, opts.paymentTotal ?? c.paid_cents);
    if (commitments >= investment.approved_cents || settled >= investment.approved_cents || paid >= investment.approved_cents) throw fail('INVESTMENT_ESTIMATE_EXCEEDED', '项目累计合同、结算或支付达到批复概算100%红线，须先调整批准概算');
  }
}
