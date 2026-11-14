import type { DB } from '../../db/connection';
import type { ContractRow } from './contract.service';
import { AppError } from '../../core/errors';
import { mulCents, RATIO_SCALE } from '../../core/decimal';
import { workingDaysBetween } from '../../core/workdays';
import { workingCalendar } from '../settings/business-settings';
import { requireEvidence } from './contract-controls';

const fail = (code: string, message: string) => new AppError(code, message, 409);
export function rmbCents(c: Pick<ContractRow, 'currency' | 'exchange_rate_scaled'>, value: bigint): bigint {
  if (c.currency === '人民币') return value;
  if (!c.exchange_rate_scaled || c.exchange_rate_scaled <= 0n) throw fail('EXCHANGE_RATE_REQUIRED', '关联人民币计划/预算或付款分级时，外币合同须登记参考汇率');
  return mulCents(value, c.exchange_rate_scaled, RATIO_SCALE);
}

/** 签署、变更、结算和支付共用同一额度口径。仅正式采用的来源批次参与计算。 */
export function assertContractFunding(db: DB, c: ContractRow, opts: { delta?: bigint; settlementGross?: bigint; paymentTotal?: bigint; outOfPlanDocId?: number | null; paymentDate?: string | null } = {}): void {
  if (c.direction !== 'expense') return;
  const candidate = c.pricing_mode === 'unit_price' ? c.estimated_ceiling_cents ?? 0n : BigInt(c.original_cents) + BigInt(c.approved_change_cents);
  const amount = candidate + (opts.delta ?? 0n);
  const override = opts.outOfPlanDocId ?? (opts.delta !== undefined ? undefined : (db.prepare("SELECT id FROM ct_document WHERE contract_id = ? AND evidence_kind = 'out_of_plan_approval' ORDER BY id DESC LIMIT 1").get(c.id) as { id: number } | undefined)?.id);
  if (override) requireEvidence(db, c.id, override, ['out_of_plan_approval']);
  const sumOther = (column: 'commitment' | 'settled' | 'paid', key: 'project_id' | 'plan_item_id', id: number): bigint => {
    const rows = db.prepare(`SELECT currency, exchange_rate_scaled, original_cents, approved_change_cents, pricing_mode, estimated_ceiling_cents, settled_gross_cents, paid_cents + COALESCE((SELECT SUM(amount_cents) FROM ct_payment p WHERE p.contract_id = ct_contract.id AND p.status = 'approved'),0) AS paid_cents FROM ct_contract
      WHERE ${key === 'plan_item_id' ? 'plan_item_id IN (SELECT id FROM plan_item WHERE item_key=(SELECT item_key FROM plan_item WHERE id=?) AND org_id=(SELECT org_id FROM plan_item WHERE id=?))' : 'project_id = ?'} AND id <> ? AND direction = 'expense' AND status <> 'voided' AND stage IN ('performance','settlement','warranty','closed')`).safeIntegers(true).all(...(key === 'plan_item_id' ? [id,id,c.id] : [id,c.id])) as ContractRow[];
    return rows.reduce((s, r) => s + rmbCents(r, column === 'settled' ? r.settled_gross_cents : column === 'paid' ? r.paid_cents : r.pricing_mode === 'unit_price' ? r.estimated_ceiling_cents ?? 0n : r.original_cents + r.approved_change_cents), 0n);
  };
  if (c.plan_item_id && (opts.delta === undefined || opts.delta > 0n)) {
    const plan = db.prepare(`SELECT f.amount_cents AS cap FROM plan_fact f JOIN plan_item i ON i.id = f.item_id JOIN plan_batch b ON b.id = i.batch_id
      WHERE i.item_key = (SELECT item_key FROM plan_item WHERE id = ?) AND i.org_id = (SELECT org_id FROM plan_item WHERE id = ?)
      AND b.is_current = 1 AND b.status <> 'voided' AND f.measure = 'annual_plan' AND f.field_key = 'annual_plan' AND f.value_type = 'amount'
      ORDER BY b.year DESC, b.actual_period DESC LIMIT 1`).safeIntegers(true).get(c.plan_item_id, c.plan_item_id) as { cap: bigint } | undefined;
    if (!plan) throw fail('PLAN_SOURCE_MISSING', '关联计划未有正式采用的年度金额，请先确认计划');
    const used = sumOther('commitment', 'plan_item_id', c.plan_item_id) + rmbCents(c, amount);
    if (used > plan.cap && !override) throw fail('OUT_OF_PLAN_APPROVAL_REQUIRED', '合同及变更占用超过综合计划额度，须先办理计划外审批');
  }
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
