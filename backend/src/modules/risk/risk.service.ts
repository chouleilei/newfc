import { rmbCents } from '../contracts/contract-funding';
import { workingCalendar } from '../settings/business-settings';
/**
 * 风险闭环(T-5,AC-F17)。
 *
 * - 扫描:先在事务外按启用规则计算命中(当前项目预算批次、当前计划批次、进行中合同、每个投资控制项目的最新对比快照、
 *   每个可行性方案的最新基准运行),再在一个短事务里按 event_key 批量写入:
 *   新 key 建单(detect);未关闭再次命中更新金额与说明并记 redetect;已关闭重开为 open(reopen);误报只记次数(suppressed);
 *   范围内本次未命中的未关闭事件只标记 last_scan_hit = 0,不自动关闭。受限用户只扫描并写入范围内组织的对象。
 * - 状态机:open→confirmed/false_positive;confirmed→rectifying/false_positive;rectifying→rectified(须整改说明);
 *   rectified→closed(复核通过)/rectifying(退回)。复核、退回、误报需要 risk:review,复核人 ≠ 提交整改的人(管理员须写例外原因)。
 *   每次转换在同一短事务里写时间线与审计;时间线只追加。
 */
import { promptSupplement } from '../../modules/settings/prompt-supplements.service';
import crypto from 'crypto';
import type { DB } from '../../db/connection';
import { AppError, Errors } from '../../core/errors';
import { currentAuth } from '../../core/request-context';
import { centsToDecimalOrNull, centsToDecimalString, formatScaled, parseDecimalToCents, parseScaled, ratioScaled, ratioString, RATIO_SCALE } from '../../core/decimal';
import { calendarDaysBetween, workingDaysBetween } from '../../core/workdays';
import { writeLog } from '../audit/log';
import { currentOrgScope, notVisible, orgInScope, requireCurrentAllOrgs, requirePermission, scopeFilterSql, type OrgScope } from '../security/scope';
import { assertDistinctReviewer } from '../security/review';
import { storeFile, type ObjectStore } from '../files/object-store';
import { feasibilityRiskHits } from '../investment/feasibility-calc';
import { procurementTier } from '../contracts/legal-context';
import { CHANGE_TIER_RANK } from '../contracts/contract-change.service';
import type { ProcurementTier } from '../../contracts/contract-legal-review';
import type { ChangeApprovalTier } from '../../contracts/project-contract';
import type { FeasResultDto } from '../../contracts/investment-feasibility';
import type { IcComparisonSummaryDto } from '../../contracts/investment-control';
import {
  RISK_ACTION_LABELS, RISK_LEVELS, RISK_STATUSES, type RiskActionDto, type RiskActionForm, type RiskCommand, type RiskEventDetailDto, type RiskEventDto,
  type RiskLevel, type RiskListQuery, type RiskRuleCreate, type RiskRuleDto, type RiskRuleUpdate, type RiskScanDto, type RiskSource, type RiskStatus, type RiskSummaryDto,
  type RiskThresholdKind, type RiskExplanationDto, type RiskChecklistDto, type RiskChecklistItemDto,
} from '../../contracts/risk';
import { rewriteTemplateNarrative } from '../../assistant/narrative';
import { PROMPT_VERSION, RISK_EXPLAIN_REWRITE_TASK } from '../../assistant/prompts';
import { riskExplainAiEnabled } from '../../assistant/feature-flags';

const nowIso = () => new Date().toISOString();
const today = () => nowIso().slice(0, 10);
const conflict = (message: string) => new AppError('RISK_STATE', message, 409);
export { calendarDaysBetween, workingDaysBetween };

/* ================= 规则 ================= */

interface RuleRow {
  code: string; name: string; source: RiskSource; detector: string; builtin: number; org_id: number | null; level: RiskLevel; threshold: string | null;
  enabled: number; suggestion: string; version: number; created_at: string | null; updated_at: string | null; org_name?: string | null;
}

/** 命中计算器:内置规则一对一;自定义规则复用计算器并可改阈值/等级/组织范围。 */
interface Detector {
  name: string; source: RiskSource; thresholdKind: RiskThresholdKind | null; thresholdLabel: string | null; defaultThreshold: string | null;
  run: (db: DB, rule: RuleRow, t: bigint) => RiskHit[];
}

const RULE_SELECT = 'SELECT r.*, o.name AS org_name FROM risk_rule r LEFT JOIN org o ON o.id = r.org_id';

const ruleDto = (r: RuleRow): RiskRuleDto => {
  const d = DETECTORS[r.detector];
  return {
    code: r.code, name: r.name, source: r.source, level: r.level, threshold: r.threshold, thresholdApplies: !!d?.thresholdKind, enabled: r.enabled === 1,
    suggestion: r.suggestion, version: r.version, updatedAt: r.updated_at, detector: r.detector, detectorName: d?.name ?? r.detector, builtin: r.builtin === 1,
    orgId: r.org_id, orgName: r.org_name ?? null, thresholdKind: d?.thresholdKind ?? null, thresholdLabel: d?.thresholdLabel ?? null,
  };
};

export function listRiskRules(db: DB): RiskRuleDto[] {
  return (db.prepare(`${RULE_SELECT} ORDER BY r.source, r.builtin DESC, r.code`).all() as RuleRow[]).map(ruleDto);
}

const ruleByCode = (db: DB, code: string) => db.prepare(`${RULE_SELECT} WHERE r.code = ?`).get(code) as RuleRow | undefined;

/** 阈值按计算器类型校验并规范化;无阈值的计算器只接受空。 */
function normalizeThreshold(d: Detector, value: string | null | undefined): string | null {
  if (!d.thresholdKind) {
    if (value != null) throw Errors.validation('该规则没有可调阈值');
    return null;
  }
  if (value == null || value === '') throw Errors.validation(`${d.thresholdLabel ?? '阈值'}不能为空`);
  if (d.thresholdKind === 'ratio') {
    const v = parseScaled(value, RATIO_SCALE, { label: '阈值' });
    if (v < 0n || v > 10n ** BigInt(RATIO_SCALE)) throw Errors.validation('比率阈值应在 0～1 之间');
    return value;
  }
  const cents = parseDecimalToCents(value, { label: '金额阈值' });
  if (cents <= 0n) throw Errors.validation('金额阈值应大于 0');
  return centsToDecimalString(cents);
}

export function updateRiskRule(db: DB, code: string, input: RiskRuleUpdate): RiskRuleDto {
  requirePermission(currentAuth(), 'risk:review');
  requireCurrentAllOrgs('调整风险规则');
  db.transaction(() => {
    const r = ruleByCode(db, code);
    if (!r) throw notVisible('风险规则');
    if (r.version !== input.expectedVersion) throw new AppError('VERSION_CONFLICT', '规则已被他人修改,请刷新后重试', 409);
    const d = DETECTORS[r.detector];
    if (!d) throw Errors.validation('规则计算器不存在');
    if (input.name !== undefined && r.builtin === 1 && input.name !== r.name) throw Errors.validation('内置规则不能改名');
    const next = {
      enabled: input.enabled === undefined ? r.enabled : input.enabled ? 1 : 0, level: input.level ?? r.level, name: input.name ?? r.name,
      threshold: input.threshold === undefined ? r.threshold : normalizeThreshold(d, input.threshold), suggestion: input.suggestion ?? r.suggestion,
    };
    db.prepare('UPDATE risk_rule SET enabled = ?, level = ?, name = ?, threshold = ?, suggestion = ?, version = version + 1, updated_by_user_id = ?, updated_at = ? WHERE code = ?')
      .run(next.enabled, next.level, next.name, next.threshold, next.suggestion, currentAuth()?.userId ?? null, nowIso(), code);
    writeLog(db, 'risk.rule.update', 'risk_rule', code, {
      code, before: { enabled: r.enabled === 1, level: r.level, threshold: r.threshold, name: r.name }, after: { ...next, enabled: next.enabled === 1 },
    });
  }).immediate();
  return ruleDto(ruleByCode(db, code)!);
}

/** 自定义规则:复用内置计算器,编码不可与现有规则重复;只停用不删除。 */
export function createRiskRule(db: DB, input: RiskRuleCreate): RiskRuleDto {
  requirePermission(currentAuth(), 'risk:review');
  requireCurrentAllOrgs('新增风险规则');
  const d = DETECTORS[input.detector];
  if (!d) throw Errors.validation('请选择有效的规则计算器');
  const threshold = normalizeThreshold(d, input.threshold === undefined ? d.defaultThreshold : input.threshold);
  if (input.orgId && !db.prepare('SELECT 1 FROM org WHERE id = ?').get(input.orgId)) throw notVisible('组织');
  db.transaction(() => {
    if (db.prepare('SELECT 1 FROM risk_rule WHERE code = ?').get(input.code)) throw new AppError('CODE_TAKEN', `规则编码 ${input.code} 已存在`, 409);
    const now = nowIso();
    db.prepare(`INSERT INTO risk_rule (code, name, source, detector, builtin, org_id, level, threshold, suggestion, created_by_user_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?, ?)`).run(
      input.code, input.name, d.source, input.detector, input.orgId ?? null, input.level, threshold, input.suggestion ?? '', currentAuth()?.userId ?? null, now, now);
    writeLog(db, 'risk.rule.create', 'risk_rule', input.code, { code: input.code, detector: input.detector, level: input.level, threshold, orgId: input.orgId ?? null });
  }).immediate();
  return ruleDto(ruleByCode(db, input.code)!);
}

/* ================= 命中计算(事务外) ================= */

export interface RiskHit {
  ruleCode: string; level: RiskLevel; subjectType: string; subjectId: number; sub?: string; orgId: number; projectId: number | null;
  title: string; description: string; amountCents: bigint | null; metric: string | null; evidence: Record<string, unknown>;
}
export const eventKeyOf = (h: Pick<RiskHit, 'ruleCode' | 'subjectType' | 'subjectId' | 'sub'>) =>
  `${h.ruleCode}:${h.subjectType}:${h.subjectId}${h.sub ? `:${h.sub}` : ''}`;

const shortHash = (s: string) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
const RATIO_ONE = 10n ** BigInt(RATIO_SCALE);

interface PbProjectRow { project_id: bigint; org_id: bigint; code: string; name: string; budget: bigint; executed: bigint }
function currentPbBatch(db: DB) {
  return db.prepare('SELECT id, year, period FROM pb_batch WHERE is_current = 1 ORDER BY year DESC, period DESC LIMIT 1').get() as
    { id: number; year: number; period: string } | undefined;
}
function pbProjectRows(db: DB, batchId: number): PbProjectRow[] {
  return db.prepare(`SELECT e.project_id, e.org_id, MAX(e.project_code) AS code, MAX(e.project_name) AS name,
      SUM(e.budget_cents) AS budget, SUM(e.executed_cents) AS executed
    FROM pb_entry e WHERE e.batch_id = ? GROUP BY e.project_id, e.org_id ORDER BY e.project_id, e.org_id`).safeIntegers(true).all(batchId) as PbProjectRow[];
}

function pbOverBudgetHits(db: DB, rule: RuleRow): RiskHit[] {
  const batch = currentPbBatch(db);
  if (!batch) return [];
  return pbProjectRows(db, batch.id).filter((r) => r.executed > r.budget).map((r) => ({
    subjectType: 'project', subjectId: Number(r.project_id), sub: `org${r.org_id}`, orgId: Number(r.org_id), projectId: Number(r.project_id),
    ruleCode: rule.code, level: rule.level, title: `${r.code} ${r.name} 预算超支`,
    description: `${batch.period} 项目预算已执行 ${centsToDecimalString(r.executed)} 元,超过年度预算 ${centsToDecimalString(r.budget)} 元。`,
    amountCents: r.executed - r.budget, metric: ratioString(r.executed, r.budget),
    evidence: { batchId: batch.id, year: batch.year, period: batch.period, budget: centsToDecimalString(r.budget), executed: centsToDecimalString(r.executed) },
  }));
}

function pbLowExecHits(db: DB, rule: RuleRow, t: bigint): RiskHit[] {
  const batch = currentPbBatch(db);
  if (!batch) return [];
  const hits: RiskHit[] = [];
  for (const r of pbProjectRows(db, batch.id)) {
    const rate = ratioScaled(r.executed, r.budget);
    if (rate === null || rate >= t) continue;
    hits.push({
      subjectType: 'project', subjectId: Number(r.project_id), sub: `org${r.org_id}`, orgId: Number(r.org_id), projectId: Number(r.project_id),
      ruleCode: rule.code, level: rule.level, title: `${r.code} ${r.name} 预算执行率偏低`,
      description: `${batch.period} 项目预算执行率 ${ratioString(r.executed, r.budget)},低于阈值 ${rule.threshold}。`,
      amountCents: r.budget - r.executed, metric: ratioString(r.executed, r.budget),
      evidence: { batchId: batch.id, year: batch.year, period: batch.period, budget: centsToDecimalString(r.budget), executed: centsToDecimalString(r.executed), threshold: rule.threshold },
    });
  }
  return hits;
}

const PLAN_SHEET_NAMES: Record<string, string> = { investment: '投资计划', purchase: '购置计划', maintenance: '运维计划' };

function currentPlanBatch(db: DB) {
  return db.prepare('SELECT id, year, actual_period FROM plan_batch WHERE is_current = 1 ORDER BY year DESC, actual_period DESC LIMIT 1').get() as
    { id: number; year: number; actual_period: string } | undefined;
}

interface PlanRow {
  id: bigint; sheet_code: string; item_name: string; item_key: string; project_id: bigint | null; org_id: bigint; project_code: string | null;
  facts: Map<string, { amount: bigint | null; scaled: bigint | null }>;
}
/** 当前计划批次的明细行及其事实(金额分、比率按 RATIO_SCALE 缩放)。 */
function planDetailRows(db: DB, batchId: number, sheet?: string): PlanRow[] {
  const rows = db.prepare(`SELECT i.id, i.sheet_code, i.item_name, i.item_key, i.project_id, i.org_id, p.code AS project_code
    FROM plan_item i LEFT JOIN md_project p ON p.id = i.project_id WHERE i.batch_id = ? AND i.item_type = 'detail' ${sheet ? 'AND i.sheet_code = ?' : ''}
    ORDER BY i.sheet_code, i.row_no`).safeIntegers(true).all(...(sheet ? [batchId, sheet] : [batchId])) as Omit<PlanRow, 'facts'>[];
  const facts = db.prepare('SELECT item_id, field_key, amount_cents, scaled_value FROM plan_fact WHERE batch_id = ?').safeIntegers(true).all(batchId) as
    { item_id: bigint; field_key: string; amount_cents: bigint | null; scaled_value: bigint | null }[];
  const byItem = new Map<bigint, PlanRow['facts']>();
  for (const f of facts) {
    const m = byItem.get(f.item_id) ?? new Map();
    m.set(f.field_key, { amount: f.amount_cents, scaled: f.scaled_value });
    byItem.set(f.item_id, m);
  }
  return rows.map((r) => ({ ...r, facts: byItem.get(r.id) ?? new Map() }));
}

const planSubject = (r: PlanRow, tag: string) => (r.project_id !== null
  ? { subjectType: 'project', subjectId: Number(r.project_id), sub: r.sheet_code === 'investment' ? `plan_${tag}` : `plan_${tag}_${r.sheet_code}_${shortHash(r.item_key)}` }
  : { subjectType: 'org', subjectId: Number(r.org_id), sub: `plan_${tag}_${r.sheet_code}_${shortHash(r.item_key)}` });
const planLabel = (r: PlanRow) => `${PLAN_SHEET_NAMES[r.sheet_code] ?? r.sheet_code}:${r.project_code ? `${r.project_code} ` : ''}${r.item_name}`;

function planLowExecHits(db: DB, rule: RuleRow, t: bigint): RiskHit[] {
  const batch = currentPlanBatch(db);
  if (!batch) return [];
  const hits: RiskHit[] = [];
  for (const r of planDetailRows(db, batch.id)) {
    const plan = r.facts.get('annual_plan')?.amount ?? null; const actual = r.facts.get('annual_actual')?.amount ?? null;
    if (plan === null || actual === null) continue;
    const rate = ratioScaled(actual, plan);
    if (rate === null || rate >= t) continue;
    const rateText = ratioString(actual, plan);
    // 事件键沿用 V56 口径(投资计划按项目,其余按行键),避免升级后同一风险换键重建
    const subject = r.project_id !== null
      ? { subjectType: 'project', subjectId: Number(r.project_id), sub: r.sheet_code === 'investment' ? 'plan_investment' : `plan_${r.sheet_code}_${shortHash(r.item_key)}` }
      : { subjectType: 'org', subjectId: Number(r.org_id), sub: `plan_${r.sheet_code}_${shortHash(r.item_key)}` };
    hits.push({
      ...subject, ruleCode: rule.code, level: rule.level, orgId: Number(r.org_id), projectId: r.project_id === null ? null : Number(r.project_id),
      title: `${planLabel(r)} 执行率偏低`,
      description: `${batch.actual_period} 年度累计实际 ${centsToDecimalString(actual)} 元,年度计划 ${centsToDecimalString(plan)} 元,执行率 ${rateText},低于阈值 ${rule.threshold}。`,
      amountCents: plan - actual, metric: rateText,
      evidence: { batchId: batch.id, year: batch.year, actualPeriod: batch.actual_period, itemId: Number(r.id), sheet: r.sheet_code, annualPlan: centsToDecimalString(plan), annualActual: centsToDecimalString(actual), threshold: rule.threshold },
    });
  }
  return hits;
}

/** 付款进度(累计已付款 ÷ 批复概算,缺概算用总投资)超前形象进度超过阈值。 */
function planPayAheadHits(db: DB, rule: RuleRow, t: bigint): RiskHit[] {
  const batch = currentPlanBatch(db);
  if (!batch) return [];
  const hits: RiskHit[] = [];
  for (const r of planDetailRows(db, batch.id, 'investment')) {
    const approved = r.facts.get('approved_budget')?.amount ?? null; const total = r.facts.get('total_investment')?.amount ?? null;
    const base = approved && approved > 0n ? approved : total && total > 0n ? total : null;
    const paid = r.facts.get('paid_cumulative')?.amount ?? null; const progress = r.facts.get('physical_progress')?.scaled ?? null;
    if (base === null || paid === null || progress === null) continue;
    const payRate = ratioScaled(paid, base)!;
    if (payRate - progress <= t) continue;
    const progressCents = (base * progress) / RATIO_ONE;
    hits.push({
      ...planSubject(r, 'pay_ahead'), ruleCode: rule.code, level: rule.level, orgId: Number(r.org_id), projectId: r.project_id === null ? null : Number(r.project_id),
      title: `${planLabel(r)} 付款进度超前形象进度`,
      description: `${batch.actual_period} 累计已付款 ${centsToDecimalString(paid)} 元,占${approved && approved > 0n ? '批复概算' : '总投资'} ${centsToDecimalString(base)} 元的 ${ratioString(paid, base)},`
        + `形象进度 ${formatScaled(progress, RATIO_SCALE)},差额超过阈值 ${rule.threshold}。`,
      amountCents: paid - progressCents, metric: formatScaled(payRate - progress, RATIO_SCALE),
      evidence: { batchId: batch.id, actualPeriod: batch.actual_period, itemId: Number(r.id), base: centsToDecimalString(base), paid: centsToDecimalString(paid), payRate: formatScaled(payRate, RATIO_SCALE), progress: formatScaled(progress, RATIO_SCALE), threshold: rule.threshold },
    });
  }
  return hits;
}

/** 开工累计完成投资占批复概算超过阈值且形象进度未满。 */
function planEstimateNearLimitHits(db: DB, rule: RuleRow, t: bigint): RiskHit[] {
  const batch = currentPlanBatch(db);
  if (!batch) return [];
  const hits: RiskHit[] = [];
  for (const r of planDetailRows(db, batch.id, 'investment')) {
    const approved = r.facts.get('approved_budget')?.amount ?? null; const completed = r.facts.get('completed_investment')?.amount ?? null;
    const progress = r.facts.get('physical_progress')?.scaled ?? null;
    if (approved === null || approved <= 0n || completed === null) continue;
    if (progress !== null && progress >= RATIO_ONE) continue;
    const rate = ratioScaled(completed, approved)!;
    if (rate <= t) continue;
    hits.push({
      ...planSubject(r, 'estimate'), ruleCode: rule.code, level: rule.level, orgId: Number(r.org_id), projectId: r.project_id === null ? null : Number(r.project_id),
      title: `${planLabel(r)} 完成投资逼近批复概算`,
      description: `${batch.actual_period} 开工累计完成投资 ${centsToDecimalString(completed)} 元,占批复概算 ${centsToDecimalString(approved)} 元的 ${ratioString(completed, approved)},`
        + `超过阈值 ${rule.threshold}${progress !== null ? `,形象进度 ${formatScaled(progress, RATIO_SCALE)}` : ''}。`,
      amountCents: approved - completed, metric: ratioString(completed, approved),
      evidence: { batchId: batch.id, actualPeriod: batch.actual_period, itemId: Number(r.id), approved: centsToDecimalString(approved), completed: centsToDecimalString(completed), progress: progress === null ? null : formatScaled(progress, RATIO_SCALE), threshold: rule.threshold },
    });
  }
  return hits;
}

/** 投资计划明细未关联主数据项目(缺项目编码影响跨系统核对)。 */
function planProjectUnmappedHits(db: DB, rule: RuleRow): RiskHit[] {
  const batch = currentPlanBatch(db);
  if (!batch) return [];
  return planDetailRows(db, batch.id, 'investment').filter((r) => r.project_id === null).map((r) => {
    const amount = r.facts.get('annual_plan')?.amount ?? r.facts.get('approved_budget')?.amount ?? null;
    return {
      ...planSubject(r, 'unmapped'), ruleCode: rule.code, level: rule.level, orgId: Number(r.org_id), projectId: null,
      title: `${planLabel(r)} 未关联项目`,
      description: `${batch.actual_period} 投资计划明细“${r.item_name}”未关联主数据项目,无法与项目预算、合同与 EAS 凭证核对。`,
      amountCents: amount, metric: null, evidence: { batchId: batch.id, actualPeriod: batch.actual_period, itemId: Number(r.id), itemName: r.item_name },
    };
  });
}

function contractOverCapHits(db: DB, rule: RuleRow): RiskHit[] {
  const rows = db.prepare(`SELECT id, contract_no, name, org_id, project_id, original_cents, approved_change_cents, paid_cents, payment_cap_ratio_scaled AS cap, stage, version
    FROM ct_contract WHERE status = 'active' AND stage NOT IN ('settlement','warranty','closed') AND payment_cap_ratio_scaled IS NOT NULL ORDER BY id`).safeIntegers(true).all() as
    { id: bigint; contract_no: string; name: string; org_id: bigint; project_id: bigint | null; original_cents: bigint; approved_change_cents: bigint; paid_cents: bigint; cap: bigint; stage: string; version: bigint }[];
  const hits: RiskHit[] = [];
  for (const r of rows) {
    const current = r.original_cents + r.approved_change_cents;
    if (current <= 0n) continue;
    // 付款比例 > 上限比例 ⇔ paid × 10^6 > cap × current(整数比较,不经舍入)
    if (r.paid_cents * RATIO_ONE <= r.cap * current) continue;
    const capCents = (r.cap * current) / RATIO_ONE;
    const capText = ratioString(r.cap, RATIO_ONE)!;
    hits.push({
      ruleCode: rule.code, level: rule.level, subjectType: 'contract', subjectId: Number(r.id), orgId: Number(r.org_id), projectId: r.project_id === null ? null : Number(r.project_id),
      title: `${r.contract_no} ${r.name} 付款超过上限比例`,
      description: `合同当前金额 ${centsToDecimalString(current)} 元,累计已付 ${centsToDecimalString(r.paid_cents)} 元,付款比例 ${ratioString(r.paid_cents, current)} 超过上限 ${capText}(尚未进入结算)。`,
      amountCents: r.paid_cents - capCents, metric: ratioString(r.paid_cents, current),
      evidence: { contractId: Number(r.id), contractVersion: Number(r.version), stage: r.stage, current: centsToDecimalString(current), paid: centsToDecimalString(r.paid_cents), capRatio: capText },
    });
  }
  return hits;
}

/** 已支付的正常付款缺凭证号(付款追溯断点);导入基线不在此列。 */
function contractPayNoVoucherHits(db: DB, rule: RuleRow): RiskHit[] {
  const rows = db.prepare(`SELECT p.id, p.node_name, p.amount_cents, p.paid_date, c.id AS contract_id, c.contract_no, c.name, c.org_id, c.project_id
    FROM ct_payment p JOIN ct_contract c ON c.id = p.contract_id
    WHERE p.status = 'paid' AND p.kind = 'normal' AND (p.voucher_no IS NULL OR trim(p.voucher_no) = '') AND c.status <> 'voided' ORDER BY p.id`).safeIntegers(true).all() as
    { id: bigint; node_name: string; amount_cents: bigint; paid_date: string; contract_id: bigint; contract_no: string; name: string; org_id: bigint; project_id: bigint | null }[];
  return rows.map((r) => ({
    ruleCode: rule.code, level: rule.level, subjectType: 'ct_payment', subjectId: Number(r.id), orgId: Number(r.org_id), projectId: r.project_id === null ? null : Number(r.project_id),
    title: `${r.contract_no} ${r.name}:${r.node_name} 已支付缺凭证号`,
    description: `合同 ${r.contract_no} 付款节点“${r.node_name}”于 ${r.paid_date} 支付 ${centsToDecimalString(r.amount_cents)} 元,未登记 EAS 凭证号,付款无法追溯到凭证。`,
    amountCents: r.amount_cents, metric: null,
    evidence: { contractId: Number(r.contract_id), paymentId: Number(r.id), paidDate: r.paid_date, amount: centsToDecimalString(r.amount_cents) },
  }));
}

/** 同一供应商(按合同所属组织)已支付记录不少于 2 笔且合计超过金额阈值。 */
function supplierLargePaymentHits(db: DB, rule: RuleRow, t: bigint): RiskHit[] {
  const rows = db.prepare(`SELECT s.id AS supplier_id, s.name AS supplier_name, c.org_id, COUNT(p.id) AS n, SUM(p.amount_cents) AS total, COUNT(DISTINCT c.id) AS contracts
    FROM ct_payment p JOIN ct_contract c ON c.id = p.contract_id JOIN md_supplier s ON s.id = c.supplier_id
    WHERE p.status = 'paid' AND c.status <> 'voided' GROUP BY s.id, c.org_id ORDER BY s.id, c.org_id`).safeIntegers(true).all() as
    { supplier_id: bigint; supplier_name: string; org_id: bigint; n: bigint; total: bigint; contracts: bigint }[];
  return rows.filter((r) => r.n >= 2n && r.total > t).map((r) => ({
    ruleCode: rule.code, level: rule.level, subjectType: 'supplier', subjectId: Number(r.supplier_id), sub: `org${r.org_id}`, orgId: Number(r.org_id), projectId: null,
    title: `${r.supplier_name} 大额集中付款`,
    description: `供应商 ${r.supplier_name} 在 ${r.contracts} 份合同下已支付 ${r.n} 笔,合计 ${centsToDecimalString(r.total)} 元,超过阈值 ${rule.threshold} 元。`,
    amountCents: r.total, metric: null,
    evidence: { supplierId: Number(r.supplier_id), paymentCount: Number(r.n), contractCount: Number(r.contracts), total: centsToDecimalString(r.total), threshold: rule.threshold },
  }));
}

/* ================= T-12.1 新增 10 条合同全生命周期量化预警 ================= */

const PROCUREMENT_TIER_RANK: Record<ProcurementTier, number> = {
  non_procurement: 0,
  exempt_small: 1,
  tier_3: 2,
  tier_2: 3,
  tier_1: 4,
};

interface LifecycleContractRow {
  id: bigint; contract_no: string; name: string; org_id: bigint; project_id: bigint | null; supplier_id: bigint | null;
  original_cents: bigint; approved_change_cents: bigint; estimated_ceiling_cents: bigint | null;
  paid_cents: bigint; received_cents: bigint; settled_net_cents: bigint;
  stage: string; status: string; source: string; direction: string; pricing_mode: string;
  legal_category: string; report_category: string; signing_entity_level: string;
  is_procurement: bigint; procurement_target: 'construction' | 'goods' | 'service' | null;
  procurement_method: string | null; procurement_tier: ProcurementTier | null;
  is_emergency: bigint; emergency_start_date: string | null; budget_type: string; plan_item_id: bigint | null;
  sign_date: string | null; effective_date: string | null; procurement_start_date: string | null; supplier_confirm_date: string | null;
  term_type: string; term_start_date: string | null; term_end_date: string | null;
  undertaker_name: string; farmer_wage_account: string;
  distribution_status: string; company_filed_at: string | null; created_at: string;
}

function activeLifecycleContracts(db: DB): LifecycleContractRow[] {
  return db.prepare(`SELECT id, contract_no, name, org_id, project_id, supplier_id,
      original_cents, approved_change_cents, estimated_ceiling_cents, paid_cents, received_cents, settled_net_cents,
      stage, status, source, direction, pricing_mode, legal_category, report_category, signing_entity_level,
      is_procurement, procurement_target, procurement_method, procurement_tier,
      is_emergency, emergency_start_date, budget_type, plan_item_id,
      sign_date, effective_date, procurement_start_date, supplier_confirm_date,
      term_type, term_start_date, term_end_date, undertaker_name, farmer_wage_account,
      distribution_status, company_filed_at, created_at
    FROM ct_contract WHERE status <> 'voided' ORDER BY id`).safeIntegers(true).all() as LifecycleContractRow[];
}

function contractSignBeforeProcurementHits(db: DB, rule: RuleRow): RiskHit[] {
  const hits: RiskHit[] = [];
  const hasProcDoc = db.prepare("SELECT 1 FROM ct_document WHERE contract_id = ? AND doc_type = 'procurement' LIMIT 1");
  for (const c of activeLifecycleContracts(db)) {
    const reasons: string[] = [];
    if (c.procurement_start_date && c.supplier_confirm_date && c.procurement_start_date > c.supplier_confirm_date) {
      reasons.push(`开始采购(${c.procurement_start_date})晚于确定供应商(${c.supplier_confirm_date})`);
    }
    if (c.procurement_start_date && c.sign_date && c.procurement_start_date > c.sign_date) {
      reasons.push(`开始采购(${c.procurement_start_date})晚于签署日(${c.sign_date})`);
    }
    if (c.supplier_confirm_date && c.sign_date && c.supplier_confirm_date > c.sign_date) {
      reasons.push(`确定供应商(${c.supplier_confirm_date})晚于签署日(${c.sign_date})`);
    }
    if (c.sign_date && c.direction === 'expense' && Number(c.is_procurement) === 1 && c.procurement_tier !== 'exempt_small' && !hasProcDoc.get(c.id)) {
      reasons.push('已签署采购合同缺少招采审批依据文档');
    }
    if (!reasons.length) continue;
    const current = c.original_cents + c.approved_change_cents;
    hits.push({
      ruleCode: rule.code, level: rule.level, subjectType: 'contract', subjectId: Number(c.id),
      orgId: Number(c.org_id), projectId: c.project_id === null ? null : Number(c.project_id),
      title: `${c.contract_no} ${c.name} 采购日期倒置或未批先签`,
      description: `合同 ${c.contract_no} 存在采购合规风险：${reasons.join('；')}。`,
      amountCents: current > 0n ? current : c.estimated_ceiling_cents, metric: null,
      evidence: { contractId: Number(c.id), reasons },
    });
  }
  return hits;
}

function contractPerformBeforeEffectiveHits(db: DB, rule: RuleRow): RiskHit[] {
  const hits: RiskHit[] = [];
  const minPayStmt = db.prepare("SELECT MIN(paid_date) AS d FROM ct_payment WHERE contract_id = ? AND status = 'paid' AND paid_date IS NOT NULL");
  const minRecStmt = db.prepare("SELECT MIN(received_date) AS d FROM ct_receipt WHERE contract_id = ? AND status = 'received' AND received_date IS NOT NULL");
  for (const c of activeLifecycleContracts(db)) {
    if (Number(c.is_emergency) === 1) continue;
    const reasons: string[] = [];
    if (c.term_start_date && c.sign_date && c.term_start_date < c.sign_date) {
      reasons.push(`履约开始日(${c.term_start_date})早于签署日(${c.sign_date})`);
    }
    if (c.term_start_date && c.effective_date && c.term_start_date < c.effective_date) {
      reasons.push(`履约开始日(${c.term_start_date})早于生效日(${c.effective_date})`);
    }
    const minEffective = c.effective_date ?? c.sign_date;
    if (minEffective) {
      const minPay = (minPayStmt.get(c.id) as { d: string | null } | undefined)?.d ?? null;
      const minRec = (minRecStmt.get(c.id) as { d: string | null } | undefined)?.d ?? null;
      if (minPay && minPay < minEffective) reasons.push(`实际付款日(${minPay})早于生效/签署日(${minEffective})`);
      if (minRec && minRec < minEffective) reasons.push(`实际收款日(${minRec})早于生效/签署日(${minEffective})`);
    }
    if (!reasons.length) continue;
    const current = c.original_cents + c.approved_change_cents;
    hits.push({
      ruleCode: rule.code, level: rule.level, subjectType: 'contract', subjectId: Number(c.id),
      orgId: Number(c.org_id), projectId: c.project_id === null ? null : Number(c.project_id),
      title: `${c.contract_no} ${c.name} 未签/未生效先履行`,
      description: `非应急合同 ${c.contract_no}：${reasons.join('；')}。`,
      amountCents: current > 0n ? current : c.estimated_ceiling_cents, metric: null,
      evidence: { contractId: Number(c.id), reasons },
    });
  }
  return hits;
}

function contractEmergencyOverdueHits(db: DB, rule: RuleRow): RiskHit[] {
  const hits: RiskHit[] = [];
  const asOf = today();
  for (const c of activeLifecycleContracts(db)) {
    if (c.status !== 'active' || Number(c.is_emergency) !== 1 || !c.emergency_start_date) continue;
    const wd = workingDaysBetween(c.emergency_start_date, asOf, workingCalendar(db));
    if (wd === null) continue;
    const unsignedPreStage = ['initiation', 'procurement', 'drafting', 'approval'].includes(c.stage);
    const missingPlan = c.budget_type === 'emergency_unplanned' && c.plan_item_id === null && wd > 5;
    if (!(unsignedPreStage && wd >= 12) && !missingPlan) continue;
    const reasons: string[] = [];
    if (missingPlan) reasons.push(`应急开工已过 ${wd} 个工作日仍未补办计划立项（限 5 工作日）`);
    if (unsignedPreStage && wd >= 12) reasons.push(`应急开工已过 ${wd} 个工作日仍未完成正式合同审批签署（限 15 工作日）`);
    const level: RiskLevel = (unsignedPreStage && wd > 15) || missingPlan ? rule.level : 'medium';
    const current = c.original_cents + c.approved_change_cents;
    hits.push({
      ruleCode: rule.code, level, subjectType: 'contract', subjectId: Number(c.id),
      orgId: Number(c.org_id), projectId: c.project_id === null ? null : Number(c.project_id),
      title: `${c.contract_no} ${c.name} 应急项目补批逾期`,
      description: `应急合同 ${c.contract_no}（开工日 ${c.emergency_start_date}）：${reasons.join('；')}。`,
      amountCents: current > 0n ? current : c.estimated_ceiling_cents, metric: String(wd),
      evidence: { contractId: Number(c.id), emergencyStartDate: c.emergency_start_date, workingDays: wd, reasons },
    });
  }
  return hits;
}

function contractDistributionOverdueHits(db: DB, rule: RuleRow): RiskHit[] {
  const hits: RiskHit[] = [];
  const asOf = today();
  for (const c of activeLifecycleContracts(db)) {
    if (!c.sign_date) continue;
    const wd = workingDaysBetween(c.sign_date, asOf, workingCalendar(db));
    if (wd === null || wd <= 10) continue;
    const pendingDist = c.distribution_status === 'pending';
    const pendingSubIncomeFile = c.direction === 'income' && c.signing_entity_level === 'secondary_unit' && !c.company_filed_at;
    if (!pendingDist && !pendingSubIncomeFile) continue;
    const reasons: string[] = [];
    if (pendingDist) reasons.push('超签署日 10 个工作日未上传盖章扫描件完成分发备案');
    if (pendingSubIncomeFile) reasons.push('二级单位资金进项合同超 10 个工作日未报公司企管部与结算中心备案');
    hits.push({
      ruleCode: rule.code, level: rule.level, subjectType: 'contract', subjectId: Number(c.id),
      orgId: Number(c.org_id), projectId: c.project_id === null ? null : Number(c.project_id),
      title: `${c.contract_no} ${c.name} 签署后分发/备案超期`,
      description: `合同 ${c.contract_no} 签署日 ${c.sign_date}（已过 ${wd} 个工作日）：${reasons.join('；')}。`,
      amountCents: null, metric: String(wd),
      evidence: { contractId: Number(c.id), signDate: c.sign_date, workingDays: wd, reasons },
    });
  }
  return hits;
}

function contractUndertakerUnassignedHits(db: DB, rule: RuleRow): RiskHit[] {
  const hits: RiskHit[] = [];
  for (const c of activeLifecycleContracts(db)) {
    if (c.status === 'active' && c.undertaker_name.trim() === '' && (c.sign_date !== null || c.source === 'import')) {
      hits.push({
        ruleCode: rule.code, level: rule.level, subjectType: 'contract', subjectId: Number(c.id),
        orgId: Number(c.org_id), projectId: c.project_id === null ? null : Number(c.project_id),
        title: `${c.contract_no} ${c.name} 缺少承办人`,
        description: `在途合同 ${c.contract_no} 未登记当前承办人姓名，影响履约责任跟踪。`,
        amountCents: null, metric: null,
        evidence: { contractId: Number(c.id), stage: c.stage },
      });
    }
  }
  const handovers = db.prepare(`SELECT h.id, h.contract_id, h.from_undertaker, h.to_undertaker, h.left_post_date, h.handover_date,
      c.contract_no, c.name, c.org_id, c.project_id
    FROM ct_undertaker_handover h JOIN ct_contract c ON c.id = h.contract_id
    WHERE c.status <> 'voided' AND h.left_post_date IS NOT NULL ORDER BY h.id`).safeIntegers(true).all() as {
      id: bigint; contract_id: bigint; from_undertaker: string; to_undertaker: string; left_post_date: string; handover_date: string;
      contract_no: string; name: string; org_id: bigint; project_id: bigint | null;
    }[];
  for (const h of handovers) {
    const wd = workingDaysBetween(h.left_post_date, h.handover_date, workingCalendar(db));
    if (wd === null || wd <= 15) continue;
    hits.push({
      ruleCode: rule.code, level: rule.level, subjectType: 'contract', subjectId: Number(h.contract_id), sub: `handover_${h.id}`,
      orgId: Number(h.org_id), projectId: h.project_id === null ? null : Number(h.project_id),
      title: `${h.contract_no} ${h.name} 承办人交接超 15 工作日`,
      description: `原承办人 ${h.from_undertaker} 于 ${h.left_post_date} 调离，${h.handover_date} 才交接至 ${h.to_undertaker}（耗时 ${wd} 个工作日，超过 15 工作日要求）。`,
      amountCents: null, metric: String(wd),
      evidence: { contractId: Number(h.contract_id), handoverId: Number(h.id), leftPostDate: h.left_post_date, handoverDate: h.handover_date, workingDays: wd },
    });
  }
  return hits;
}

function contractChangeTierMismatchHits(db: DB, rule: RuleRow): RiskHit[] {
  const hits: RiskHit[] = [];
  const asOf = today();
  const rows = db.prepare(`SELECT ch.id, ch.contract_id, ch.change_kind, ch.delta_cents, ch.status, ch.required_approval_tier, ch.actual_approval_tier,
      ch.supplement_no, ch.discipline_filed_at, ch.tech_review_applied_at, ch.tech_review_replied_at,
      c.contract_no, c.name, c.org_id, c.project_id
    FROM ct_change ch JOIN ct_contract c ON c.id = ch.contract_id
    WHERE c.status <> 'voided' ORDER BY ch.id`).safeIntegers(true).all() as {
      id: bigint; contract_id: bigint; change_kind: string; delta_cents: bigint; status: string;
      required_approval_tier: ChangeApprovalTier; actual_approval_tier: ChangeApprovalTier | null;
      supplement_no: string | null; discipline_filed_at: string | null; tech_review_applied_at: string | null; tech_review_replied_at: string | null;
      contract_no: string; name: string; org_id: bigint; project_id: bigint | null;
    }[];
  for (const r of rows) {
    const reasons: string[] = [];
    if (r.actual_approval_tier && CHANGE_TIER_RANK[r.actual_approval_tier] < CHANGE_TIER_RANK[r.required_approval_tier]) {
      reasons.push(`实际审批层级(${r.actual_approval_tier})低于附件5要求(${r.required_approval_tier})`);
    }
    if (r.status === 'approved' && r.delta_cents > 0n && ['change', 'claim_by_contractor'].includes(r.change_kind)) {
      if (!r.supplement_no || !r.supplement_no.trim()) reasons.push('已批准增额变更缺少补充协议编号');
      if (!r.discipline_filed_at) reasons.push('已批准增额变更未报纪审部备案');
    }
    if (r.tech_review_applied_at) {
      const days = calendarDaysBetween(r.tech_review_applied_at, r.tech_review_replied_at ?? asOf);
      if (days !== null && days > 10) {
        reasons.push(`技术方案/反索赔审查耗时 ${days} 日（超过 10 日时限）`);
      }
    }
    if (!reasons.length) continue;
    hits.push({
      ruleCode: rule.code, level: rule.level, subjectType: 'ct_change', subjectId: Number(r.id),
      orgId: Number(r.org_id), projectId: r.project_id === null ? null : Number(r.project_id),
      title: `${r.contract_no} ${r.name} 变更审批或备案不合规`,
      description: `变更单 #${r.id}：${reasons.join('；')}。`,
      amountCents: r.delta_cents < 0n ? -r.delta_cents : r.delta_cents, metric: null,
      evidence: { contractId: Number(r.contract_id), changeId: Number(r.id), reasons },
    });
  }
  return hits;
}

function contractSplitEvadeTenderHits(db: DB, rule: RuleRow): RiskHit[] {
  const hits: RiskHit[] = [];
  const groups = new Map<string, {
    orgId: number; projectId: number; supplierId: number; target: 'construction' | 'goods' | 'service'; year: string;
    items: { id: number; contractNo: string; amt: bigint; method: string | null; tierRank: number }[];
  }>();
  for (const c of activeLifecycleContracts(db)) {
    if (c.direction !== 'expense' || Number(c.is_procurement) !== 1 || c.project_id === null || c.supplier_id === null || !c.procurement_target) continue;
    const year = (c.sign_date ?? c.created_at).slice(0, 4);
    const amt = c.pricing_mode === 'unit_price' && c.original_cents === 0n && c.estimated_ceiling_cents !== null
      ? c.estimated_ceiling_cents
      : (c.original_cents + c.approved_change_cents);
    if (amt <= 0n) continue;
    const t = procurementTier(true, c.procurement_target, amt, c.procurement_method as never) ?? 'tier_3';
    const key = `${c.org_id}:${c.project_id}:${c.supplier_id}:${c.procurement_target}:${year}`;
    const g = groups.get(key) ?? {
      orgId: Number(c.org_id), projectId: Number(c.project_id), supplierId: Number(c.supplier_id),
      target: c.procurement_target, year, items: [],
    };
    g.items.push({ id: Number(c.id), contractNo: c.contract_no, amt, method: c.procurement_method, tierRank: PROCUREMENT_TIER_RANK[t] });
    groups.set(key, g);
  }
  for (const [key, g] of groups) {
    if (g.items.length < 2) continue;
    const sumCents = g.items.reduce((s, x) => s + x.amt, 0n);
    const groupTier = procurementTier(true, g.target, sumCents, null) ?? 'tier_3';
    const groupRank = PROCUREMENT_TIER_RANK[groupTier];
    const maxIndividualRank = Math.max(...g.items.map((x) => x.tierRank));
    const tier1Threshold = g.target === 'construction' ? 300_000_000n : g.target === 'goods' ? 150_000_000n : 100_000_000n;
    const crossedTier = groupRank > maxIndividualRank;
    const evadedPublicTender = sumCents >= tier1Threshold && g.items.some((x) => x.amt < tier1Threshold && x.method !== 'public_tender');
    if (!crossedTier && !evadedPublicTender) continue;
    hits.push({
      ruleCode: rule.code, level: rule.level, subjectType: 'project', subjectId: g.projectId, sub: `split_${shortHash(key)}`,
      orgId: g.orgId, projectId: g.projectId,
      title: `${g.year} 年同项目同相对方疑拆分合同规避采购层级`,
      description: `${g.year} 年同一项目与同一供应商签订 ${g.items.length} 份${g.target}类采购合同（${g.items.map((x) => x.contractNo).join('、')}），合并金额 ${centsToDecimalString(sumCents)} 元，跨入 ${groupTier} 采购层级。`,
      amountCents: sumCents, metric: String(g.items.length),
      evidence: {
        year: g.year, projectId: g.projectId, supplierId: g.supplierId, target: g.target,
        groupTier, totalAmount: centsToDecimalString(sumCents),
        contracts: g.items.map((x) => ({ id: x.id, contractNo: x.contractNo, amount: centsToDecimalString(x.amt), method: x.method })),
      },
    });
  }
  return hits;
}

function contractOverSettleOrPayHits(db: DB, rule: RuleRow): RiskHit[] {
  const hits: RiskHit[] = [];
  const setStmt = db.prepare(`SELECT COUNT(*) AS cnt, COALESCE(SUM(net_payable_cents), 0) AS net_sum,
      COALESCE(SUM(deduct_prepayment_cents), 0) AS ded_prepay,
      MAX(CASE WHEN settlement_kind = 'final' THEN 1 ELSE 0 END) AS has_final
    FROM ct_settlement WHERE contract_id = ? AND status = 'approved'`).safeIntegers(true);
  const nonPrepayStmt = db.prepare("SELECT COALESCE(SUM(amount_cents), 0) AS s FROM ct_payment WHERE contract_id = ? AND payment_type NOT IN ('prepayment','warranty_release') AND status IN ('approved','paid')").safeIntegers(true);
  const prepayPaidStmt = db.prepare("SELECT COALESCE(SUM(amount_cents), 0) AS s FROM ct_payment WHERE contract_id = ? AND payment_type = 'prepayment' AND status = 'paid'").safeIntegers(true);
  for (const c of activeLifecycleContracts(db)) {
    const reasons: string[] = [];
    let riskAmt = 0n;
    const cap = c.pricing_mode === 'unit_price' ? c.estimated_ceiling_cents : (c.original_cents + c.approved_change_cents);
    if (cap !== null && c.settled_net_cents > cap) {
      reasons.push(`累计净结算(${centsToDecimalString(c.settled_net_cents)})超过合同上限(${centsToDecimalString(cap)})`);
      if (c.settled_net_cents - cap > riskAmt) riskAmt = c.settled_net_cents - cap;
    }
    if (cap !== null && c.paid_cents > cap) {
      reasons.push(`累计已付(${centsToDecimalString(c.paid_cents)})超过合同上限(${centsToDecimalString(cap)})`);
      if (c.paid_cents - cap > riskAmt) riskAmt = c.paid_cents - cap;
    }
    const st = setStmt.get(c.id) as { cnt: bigint; net_sum: bigint; ded_prepay: bigint; has_final: bigint };
    if (st.cnt > 0n) {
      const nonPrepay = (nonPrepayStmt.get(c.id) as { s: bigint }).s;
      if (nonPrepay > st.net_sum) {
        reasons.push(`非预付款进度/结算支付(${centsToDecimalString(nonPrepay)})超过累计净应结(${centsToDecimalString(st.net_sum)})`);
        if (nonPrepay - st.net_sum > riskAmt) riskAmt = nonPrepay - st.net_sum;
      }
      const prepayPaid = (prepayPaidStmt.get(c.id) as { s: bigint }).s;
      if (prepayPaid > 0n && st.has_final === 1n && st.ded_prepay < prepayPaid) {
        reasons.push(`已付预付款 ${centsToDecimalString(prepayPaid)} 元，竣工结算累计扣回仅 ${centsToDecimalString(st.ded_prepay)} 元`);
        if (prepayPaid - st.ded_prepay > riskAmt) riskAmt = prepayPaid - st.ded_prepay;
      }
    }
    const isConstruction = c.report_category === 'engineering' || c.legal_category === 'construction' || c.legal_category === 'small_construction';
    if (c.direction === 'expense' && c.sign_date !== null && isConstruction && c.farmer_wage_account.trim() === '') {
      reasons.push('施工合同未登记农民工工资专用账户');
    }
    if (!reasons.length) continue;
    hits.push({
      ruleCode: rule.code, level: rule.level, subjectType: 'contract', subjectId: Number(c.id),
      orgId: Number(c.org_id), projectId: c.project_id === null ? null : Number(c.project_id),
      title: `${c.contract_no} ${c.name} 结算支付或专户异常`,
      description: `合同 ${c.contract_no}：${reasons.join('；')}。`,
      amountCents: riskAmt > 0n ? riskAmt : null, metric: null,
      evidence: { contractId: Number(c.id), reasons },
    });
  }
  const projects = db.prepare('SELECT id, md_project_id, org_id, approved_cents FROM ic_project WHERE approved_cents IS NOT NULL AND approved_cents > 0').safeIntegers(true).all() as { id: bigint; md_project_id: bigint; org_id: bigint; approved_cents: bigint }[];
  for (const p of projects) {
    const contracts = db.prepare("SELECT currency, exchange_rate_scaled, original_cents, approved_change_cents, pricing_mode, estimated_ceiling_cents, settled_gross_cents FROM ct_contract WHERE project_id = ? AND direction = 'expense' AND status <> 'voided' AND stage IN ('performance','settlement','warranty','closed')").safeIntegers(true).all(p.md_project_id) as { currency: string; exchange_rate_scaled: bigint | null; original_cents: bigint; approved_change_cents: bigint; pricing_mode: string; estimated_ceiling_cents: bigint | null; settled_gross_cents: bigint }[];
    let committed = 0n; let settled = 0n;
    for (const c of contracts) {
      if (c.currency !== '人民币' && !c.exchange_rate_scaled) continue;
      committed += rmbCents(c, c.pricing_mode === 'unit_price' ? c.estimated_ceiling_cents ?? 0n : c.original_cents + c.approved_change_cents);
      settled += rmbCents(c, c.settled_gross_cents);
    }
    const used = committed > settled ? committed : settled;
    if (used * 10n < p.approved_cents * 9n) continue;
    hits.push({ ruleCode: rule.code, level: used >= p.approved_cents ? 'high' : 'medium', subjectType: 'project', subjectId: Number(p.md_project_id), sub: 'investment_90_100',
      orgId: Number(p.org_id), projectId: Number(p.md_project_id), title: '项目合同/结算达到概算90%预警线',
      description: `项目累计合同或结算达到批复概算${used >= p.approved_cents ? '100%红线' : '90%黄色预警线'}，须复核投资额度。`,
      amountCents: used, metric: ratioString(used, p.approved_cents), evidence: { committed: centsToDecimalString(committed), settled: centsToDecimalString(settled), approved: centsToDecimalString(p.approved_cents) } });
  }
  return hits;
}

function contractLongUnsettledHits(db: DB, rule: RuleRow): RiskHit[] {
  const hits: RiskHit[] = [];
  const asOf = today();
  const hasFinalStmt = db.prepare("SELECT 1 FROM ct_settlement WHERE contract_id = ? AND settlement_kind = 'final' AND status = 'approved' LIMIT 1");
  for (const c of activeLifecycleContracts(db)) {
    if (c.status !== 'active' || ['warranty', 'closed'].includes(c.stage) || c.term_type !== 'fixed' || !c.term_end_date) continue;
    const days = calendarDaysBetween(c.term_end_date, asOf);
    if (days === null || days <= 180 || hasFinalStmt.get(c.id)) continue;
    const current = c.original_cents + c.approved_change_cents;
    hits.push({
      ruleCode: rule.code, level: rule.level, subjectType: 'contract', subjectId: Number(c.id),
      orgId: Number(c.org_id), projectId: c.project_id === null ? null : Number(c.project_id),
      title: `${c.contract_no} ${c.name} 完工超 180 天未最终结算`,
      description: `合同 ${c.contract_no} 履约结束日 ${c.term_end_date}，已逾期 ${days} 天仍未完成竣工/最终结算。`,
      amountCents: current > 0n ? current : c.estimated_ceiling_cents, metric: String(days),
      evidence: { contractId: Number(c.id), termEndDate: c.term_end_date, overdueDays: days },
    });
  }
  return hits;
}

function contractGuaranteeWarrantyDueHits(db: DB, rule: RuleRow): RiskHit[] {
  const hits: RiskHit[] = [];
  const asOf = today();
  const guarantees = db.prepare(`SELECT g.id, g.contract_id, g.guarantee_no, g.amount_cents, g.status, g.expiry_date, g.claim_occurred_at, g.claim_reported_at,
      c.contract_no, c.name, c.org_id, c.project_id, c.status AS c_status
    FROM ct_guarantee g JOIN ct_contract c ON c.id = g.contract_id WHERE c.status <> 'voided' ORDER BY g.id`).safeIntegers(true).all() as {
      id: bigint; contract_id: bigint; guarantee_no: string; amount_cents: bigint; status: string;
      expiry_date: string | null; claim_occurred_at: string | null; claim_reported_at: string | null;
      contract_no: string; name: string; org_id: bigint; project_id: bigint | null; c_status: string;
    }[];
  for (const g of guarantees) {
    if (g.status === 'active' && ['active', 'suspended'].includes(g.c_status) && g.expiry_date) {
      const remDays = calendarDaysBetween(asOf, g.expiry_date);
      if (remDays !== null && remDays <= 30) {
        hits.push({
          ruleCode: rule.code, level: rule.level, subjectType: 'ct_guarantee', subjectId: Number(g.id), sub: 'expiry',
          orgId: Number(g.org_id), projectId: g.project_id === null ? null : Number(g.project_id),
          title: `${g.contract_no} 保函 ${g.guarantee_no || '#' + g.id} 临期/已到期`,
          description: remDays >= 0
            ? `合同 ${g.contract_no} 有效保函距到期日(${g.expiry_date})仅剩 ${remDays} 天，请及时续期或清理。`
            : `合同 ${g.contract_no} 有效保函已于 ${g.expiry_date} 到期（逾期 ${-remDays} 天）仍未退还/清理。`,
          amountCents: g.amount_cents, metric: String(remDays),
          evidence: { contractId: Number(g.contract_id), guaranteeId: Number(g.id), expiryDate: g.expiry_date, remainingDays: remDays },
        });
      }
    }
    if (g.status === 'claimed' && g.claim_occurred_at) {
      const d = calendarDaysBetween(g.claim_occurred_at, g.claim_reported_at ?? asOf);
      if (d !== null && d > 2) {
        hits.push({
          ruleCode: rule.code, level: 'high', subjectType: 'ct_guarantee', subjectId: Number(g.id), sub: 'claim_report',
          orgId: Number(g.org_id), projectId: g.project_id === null ? null : Number(g.project_id),
          title: `${g.contract_no} 保函索赔超 2 日未书面报告`,
          description: `合同 ${g.contract_no} 保函于 ${g.claim_occurred_at} 发生索赔/冻结，${g.claim_reported_at ? `迟至 ${g.claim_reported_at} 报告` : '至今未登记书面报告'}（已超 ${d} 日，资金办法 9.3 限 2 日内）。`,
          amountCents: g.amount_cents, metric: String(d),
          evidence: { contractId: Number(g.contract_id), guaranteeId: Number(g.id), claimOccurredAt: g.claim_occurred_at, claimReportedAt: g.claim_reported_at },
        });
      }
    }
  }

  const warranties = db.prepare(`SELECT w.contract_id, w.end_date, w.retention_cents, w.inspection_conclusion,
      c.contract_no, c.name, c.org_id, c.project_id
    FROM ct_warranty w JOIN ct_contract c ON c.id = w.contract_id
    WHERE c.status = 'active' AND w.end_date IS NOT NULL AND w.inspection_conclusion IS NULL ORDER BY w.id`).safeIntegers(true).all() as {
      contract_id: bigint; end_date: string; retention_cents: bigint; inspection_conclusion: string | null;
      contract_no: string; name: string; org_id: bigint; project_id: bigint | null;
    }[];
  for (const w of warranties) {
    const d = calendarDaysBetween(w.end_date, asOf);
    if (d === null || d <= 30) continue;
    hits.push({
      ruleCode: rule.code, level: rule.level, subjectType: 'contract', subjectId: Number(w.contract_id), sub: 'warranty_due',
      orgId: Number(w.org_id), projectId: w.project_id === null ? null : Number(w.project_id),
      title: `${w.contract_no} ${w.name} 质保期满超 30 天未办签证`,
      description: `合同 ${w.contract_no} 质保期已于 ${w.end_date} 届满（已超 ${d} 天），尚未登记期满验收签证结论。`,
      amountCents: w.retention_cents > 0n ? w.retention_cents : null, metric: String(d),
      evidence: { contractId: Number(w.contract_id), endDate: w.end_date, overdueDays: d },
    });
  }

  const disputes = db.prepare(`SELECT d.id, d.contract_id, d.occurred_date, d.reported_to_dept_at, d.stage, d.dispute_cents,
      d.filed_to_mgmt_at, d.filed_to_discipline_at, d.case_no, c.contract_no, c.name, c.org_id, c.project_id
    FROM ct_dispute d JOIN ct_contract c ON c.id = d.contract_id WHERE c.status <> 'voided' ORDER BY d.id`).safeIntegers(true).all() as {
      id: bigint; contract_id: bigint; occurred_date: string; reported_to_dept_at: string | null; stage: string; dispute_cents: bigint;
      filed_to_mgmt_at: string | null; filed_to_discipline_at: string | null; case_no: string;
      contract_no: string; name: string; org_id: bigint; project_id: bigint | null;
    }[];
  for (const d of disputes) {
    const repWd = workingDaysBetween(d.occurred_date, d.reported_to_dept_at ?? asOf, workingCalendar(db));
    if (repWd !== null && repWd > 2) {
      hits.push({
        ruleCode: rule.code, level: rule.level, subjectType: 'ct_dispute', subjectId: Number(d.id), sub: 'dispute_report',
        orgId: Number(d.org_id), projectId: d.project_id === null ? null : Number(d.project_id),
        title: `${d.contract_no} 纠纷超 2 工作日未向归口部门报告`,
        description: `合同 ${d.contract_no} 纠纷发生于 ${d.occurred_date}，${d.reported_to_dept_at ? `迟至 ${d.reported_to_dept_at} 报告` : '尚未书面报告'}（已过 ${repWd} 个工作日）。`,
        amountCents: d.dispute_cents > 0n ? d.dispute_cents : null, metric: String(repWd),
        evidence: { contractId: Number(d.contract_id), disputeId: Number(d.id), occurredDate: d.occurred_date, reportedToDeptAt: d.reported_to_dept_at },
      });
    }
    if (d.stage === 'closed' && (!d.filed_to_mgmt_at || !d.filed_to_discipline_at)) {
      hits.push({
        ruleCode: rule.code, level: rule.level, subjectType: 'ct_dispute', subjectId: Number(d.id), sub: 'dispute_filing',
        orgId: Number(d.org_id), projectId: d.project_id === null ? null : Number(d.project_id),
        title: `${d.contract_no} 结案纠纷未完成企管/纪审双备案`,
        description: `合同 ${d.contract_no} 纠纷（${d.case_no || '#' + d.id}）已结案，仍缺少${[!d.filed_to_mgmt_at ? '企管部备案' : '', !d.filed_to_discipline_at ? '纪审部备案' : ''].filter(Boolean).join('、')}。`,
        amountCents: d.dispute_cents > 0n ? d.dispute_cents : null, metric: null,
        evidence: { contractId: Number(d.contract_id), disputeId: Number(d.id), filedToMgmtAt: d.filed_to_mgmt_at, filedToDisciplineAt: d.filed_to_discipline_at },
      });
    }
  }
  return hits;
}

const VERSION_TYPE_OF = (db: DB, versionId: number) =>
  (db.prepare('SELECT version_type FROM ic_version WHERE id = ?').get(versionId) as { version_type: string } | undefined)?.version_type ?? String(versionId);

interface IcLatestRow { id: number; project_id: number; summary_json: string; rows_json: string; content_sha256: string; org_id: number; md_project_id: number; code: string; name: string }
function icLatestComparisons(db: DB): IcLatestRow[] {
  return db.prepare(`SELECT c.id, c.project_id, c.summary_json, c.rows_json, c.content_sha256, p.org_id, p.md_project_id, m.code, m.name
    FROM ic_comparison c JOIN ic_project p ON p.id = c.project_id JOIN md_project m ON m.id = p.md_project_id
    WHERE p.status = 'active' AND c.id = (SELECT MAX(id) FROM ic_comparison WHERE project_id = c.project_id) ORDER BY c.project_id`).all() as IcLatestRow[];
}

/** 四算控制链:结算超预算归 IC_CONTROL_BREAK,其余超红线/上级归 IC_OVER_REDLINE。 */
function icChainHits(db: DB, rule: RuleRow, settlement: boolean): RiskHit[] {
  const hits: RiskHit[] = [];
  for (const c of icLatestComparisons(db)) {
    const summary = JSON.parse(c.summary_json) as IcComparisonSummaryDto;
    for (const item of summary.controlChain ?? []) {
      if ((item.status === 'settlement_over_budget') !== settlement) continue;
      const vt = VERSION_TYPE_OF(db, item.subjectVersionId);
      const ref = parseDecimalToCents(item.referenceAmount);
      const diff = parseDecimalToCents(item.subjectAmount) - ref;
      hits.push({
        subjectType: 'ic_project', subjectId: c.project_id, orgId: c.org_id, projectId: c.md_project_id, ruleCode: rule.code, level: rule.level, sub: `${item.status}_${vt}`,
        title: `${c.code} ${c.name}:${item.message}`,
        description: `${item.message}:${item.subjectAmount} 元 > ${item.referenceAmount} 元(对比快照 #${c.id})。`,
        amountCents: diff, metric: ratioString(diff, ref),
        evidence: { comparisonId: c.id, contentSha256: c.content_sha256, chainStatus: item.status, subjectVersionId: item.subjectVersionId, referenceVersionId: item.referenceVersionId, subjectAmount: item.subjectAmount, referenceAmount: item.referenceAmount },
      });
    }
  }
  return hits;
}

function icDeviationHits(db: DB, rule: RuleRow): RiskHit[] {
  const hits: RiskHit[] = [];
  for (const c of icLatestComparisons(db)) {
    const summary = JSON.parse(c.summary_json) as IcComparisonSummaryDto;
    if (summary.exceedCount <= 0) continue;
    const exceedRows = (JSON.parse(c.rows_json) as { canonicalCode: string; name: string; deviation: string; deviationRate: string | null; alertLevel: string | null }[])
      .filter((r) => r.alertLevel === 'exceed');
    const amount = exceedRows.reduce((s, r) => s + parseDecimalToCents(r.deviation), 0n);
    hits.push({
      subjectType: 'ic_project', subjectId: c.project_id, orgId: c.org_id, projectId: c.md_project_id, ruleCode: rule.code, level: rule.level,
      title: `${c.code} ${c.name}:${summary.exceedCount} 个科目投资偏差超限`,
      description: `对比快照 #${c.id} 中 ${summary.exceedCount} 个科目偏差率超过预警上限:${exceedRows.slice(0, 5).map((r) => `${r.name}(${r.deviationRate ?? '—'})`).join('、')}${exceedRows.length > 5 ? ' 等' : ''}。`,
      amountCents: amount, metric: summary.totalDeviationRate,
      evidence: { comparisonId: c.id, contentSha256: c.content_sha256, exceedCount: summary.exceedCount, items: exceedRows.slice(0, 20).map((r) => ({ code: r.canonicalCode, name: r.name, deviation: r.deviation, rate: r.deviationRate })) },
    });
  }
  return hits;
}

function feasibilityHits(db: DB, rule: RuleRow): RiskHit[] {
  const rows = db.prepare(`SELECT r.id AS run_id, r.parameter_hash, r.result_json, s.id AS scenario_id, s.name AS scenario_name, p.code, p.name, p.org_id, p.md_project_id
    FROM if_run r JOIN if_scenario s ON s.id = r.scenario_id JOIN if_project p ON p.id = s.project_id
    WHERE p.status = 'active' AND s.deleted_at IS NULL AND r.id = (SELECT MAX(id) FROM if_run WHERE scenario_id = s.id AND kind = 'base') AND r.status = 'succeeded' ORDER BY s.id`).all() as
    { run_id: number; parameter_hash: string; result_json: string; scenario_id: number; scenario_name: string; code: string; name: string; org_id: number; md_project_id: number | null }[];
  const hits: RiskHit[] = [];
  for (const r of rows) {
    for (const h of feasibilityRiskHits(JSON.parse(r.result_json) as FeasResultDto)) {
      if (h.code !== rule.detector) continue;
      hits.push({
        ruleCode: rule.code, level: rule.level, subjectType: 'if_scenario', subjectId: r.scenario_id, sub: h.sub, orgId: r.org_id, projectId: r.md_project_id,
        title: `${r.code} ${r.name} / ${r.scenario_name}:${h.title}`, description: h.description, amountCents: null, metric: h.metric,
        evidence: { ...h.evidence, runId: r.run_id, parameterHash: r.parameter_hash },
      });
    }
  }
  return hits;
}

/** 各组织最新期间的当前(已激活)凭证批次;EAS 规则只看最新期间,避免历史期间重复告警。 */
function latestVoucherBatches(db: DB): { id: number; org_id: number; period: string }[] {
  return db.prepare(`SELECT b.id, b.org_id, b.period FROM eas_batch b WHERE b.data_type = 'voucher' AND b.is_current = 1
    AND b.period = (SELECT MAX(period) FROM eas_batch x WHERE x.data_type = 'voucher' AND x.is_current = 1 AND x.org_id = b.org_id) ORDER BY b.org_id`).all() as
    { id: number; org_id: number; period: string }[];
}

/** 现金、银行存款、其他货币资金借方不要求项目辅助核算。 */
const CASH_ACCOUNT_PREFIXES = ['1001', '1002', '1012'];

function easProjectMissingHits(db: DB, rule: RuleRow, t: bigint): RiskHit[] {
  const hits: RiskHit[] = [];
  const lines = db.prepare(`SELECT id, voucher_date, voucher_no, entry_no, account_code, account_name, summary, debit_cents FROM eas_voucher_line
    WHERE batch_id = ? AND (project_code IS NULL OR trim(project_code) = '') AND debit_cents > ? ORDER BY id`).safeIntegers(true);
  for (const b of latestVoucherBatches(db)) {
    for (const l of lines.all(b.id, t) as { id: bigint; voucher_date: string; voucher_no: string; entry_no: string; account_code: string; account_name: string; summary: string | null; debit_cents: bigint }[]) {
      if (CASH_ACCOUNT_PREFIXES.some((p) => l.account_code.startsWith(p))) continue;
      hits.push({
        ruleCode: rule.code, level: rule.level, subjectType: 'org', subjectId: b.org_id, sub: `v_${shortHash(`${b.period}|${l.voucher_no}|${l.entry_no}`)}`, orgId: b.org_id, projectId: null,
        title: `${b.period} 凭证 ${l.voucher_no} ${l.account_name} 缺少项目`,
        description: `${l.voucher_date} 凭证 ${l.voucher_no} 第 ${l.entry_no} 行 ${l.account_code} ${l.account_name} 借方 ${centsToDecimalString(l.debit_cents)} 元,超过阈值 ${rule.threshold} 元且未挂项目辅助核算${l.summary ? `(摘要:${l.summary})` : ''}。`,
        amountCents: l.debit_cents, metric: null,
        evidence: { batchId: b.id, period: b.period, lineId: Number(l.id), voucherNo: l.voucher_no, entryNo: l.entry_no, accountCode: l.account_code, debit: centsToDecimalString(l.debit_cents), threshold: rule.threshold },
      });
    }
  }
  return hits;
}

const UNCLEARED_KEYWORDS = ['预付', '暂估', '挂账'];

/** 凭证摘要含预付/暂估/挂账(按关键词触发),按凭证聚合。 */
function easUnclearedHits(db: DB, rule: RuleRow): RiskHit[] {
  const hits: RiskHit[] = [];
  const lines = db.prepare(`SELECT voucher_no, MIN(voucher_date) AS voucher_date, GROUP_CONCAT(DISTINCT summary) AS summaries, SUM(debit_cents) AS debit, COUNT(*) AS n
    FROM eas_voucher_line WHERE batch_id = ? AND (${UNCLEARED_KEYWORDS.map(() => 'summary LIKE ?').join(' OR ')}) GROUP BY voucher_no ORDER BY voucher_no`).safeIntegers(true);
  for (const b of latestVoucherBatches(db)) {
    for (const v of lines.all(b.id, ...UNCLEARED_KEYWORDS.map((k) => `%${k}%`)) as { voucher_no: string; voucher_date: string; summaries: string; debit: bigint; n: bigint }[]) {
      const found = UNCLEARED_KEYWORDS.filter((k) => v.summaries.includes(k));
      hits.push({
        ruleCode: rule.code, level: rule.level, subjectType: 'org', subjectId: b.org_id, sub: `u_${shortHash(`${b.period}|${v.voucher_no}`)}`, orgId: b.org_id, projectId: null,
        title: `${b.period} 凭证 ${v.voucher_no} 含${found.join('/')}事项`,
        description: `${v.voucher_date} 凭证 ${v.voucher_no} 摘要含“${found.join('、')}”:${v.summaries.slice(0, 120)}。请核对是否已按合同与发票清理(首版按关键词识别,未接入账龄)。`,
        amountCents: v.debit, metric: null,
        evidence: { batchId: b.id, period: b.period, voucherNo: v.voucher_no, lineCount: Number(v.n), keywords: found },
      });
    }
  }
  return hits;
}

/** 当前项目预算批次的执行数与同年度当前 EAS 凭证按项目入账数(借 − 贷)差异率超过阈值。 */
function easBudgetDiffHits(db: DB, rule: RuleRow, t: bigint): RiskHit[] {
  const batch = currentPbBatch(db);
  if (!batch) return [];
  const projects = db.prepare(`SELECT e.project_id, MAX(e.project_code) AS code, MAX(e.project_name) AS name, SUM(e.executed_cents) AS executed, p.org_id
    FROM pb_entry e JOIN md_project p ON p.id = e.project_id WHERE e.batch_id = ? GROUP BY e.project_id ORDER BY e.project_id`).safeIntegers(true).all(batch.id) as
    { project_id: bigint; code: string; name: string; executed: bigint; org_id: bigint }[];
  if (!projects.length) return [];
  const from = `${batch.year}-01`;
  const easBatches = db.prepare(`SELECT id, org_id FROM eas_batch WHERE data_type = 'voucher' AND is_current = 1 AND period BETWEEN ? AND ?`).all(from, batch.period) as { id: number; org_id: number }[];
  if (!easBatches.length) return [];
  const easOrgs = new Set(easBatches.map((b) => b.org_id));
  // EAS 项目编码 → 主数据项目:编码一致,或有效的项目编码映射
  const byCode = new Map((db.prepare('SELECT id, code FROM md_project').all() as { id: number; code: string }[]).map((p) => [p.code, p.id]));
  for (const m of db.prepare("SELECT source_key, target_id FROM md_code_mapping WHERE entity_type = 'project' AND match_kind = 'code' AND valid_to IS NULL").all() as { source_key: string; target_id: number }[]) {
    if (!byCode.has(m.source_key)) byCode.set(m.source_key, m.target_id);
  }
  const posted = new Map<number, bigint>();
  const sums = db.prepare(`SELECT project_code, SUM(debit_cents) - SUM(credit_cents) AS amount FROM eas_voucher_line
    WHERE batch_id = ? AND project_code IS NOT NULL AND trim(project_code) <> '' GROUP BY project_code`).safeIntegers(true);
  for (const b of easBatches) {
    for (const s of sums.all(b.id) as { project_code: string; amount: bigint }[]) {
      const pid = byCode.get(s.project_code.trim());
      if (pid !== undefined) posted.set(pid, (posted.get(pid) ?? 0n) + s.amount);
    }
  }
  const hits: RiskHit[] = [];
  for (const p of projects) {
    const orgId = Number(p.org_id);
    if (!easOrgs.has(orgId)) continue; // 项目所属组织没有当年 EAS 凭证时不比较
    const eas = posted.get(Number(p.project_id)) ?? 0n;
    const diff = eas - p.executed;
    if (diff === 0n) continue;
    const rate = p.executed === 0n ? null : ratioScaled(diff < 0n ? -diff : diff, p.executed)!;
    if (rate !== null && rate <= t) continue;
    hits.push({
      ruleCode: rule.code, level: rule.level, subjectType: 'project', subjectId: Number(p.project_id), sub: 'eas_diff', orgId, projectId: Number(p.project_id),
      title: `${p.code} ${p.name} 预算执行与 EAS 入账不一致`,
      description: `${batch.period} 项目预算执行 ${centsToDecimalString(p.executed)} 元,${from}～${batch.period} EAS 凭证按项目入账 ${centsToDecimalString(eas)} 元,`
        + `差异 ${centsToDecimalString(diff)} 元${rate === null ? '' : `,差异率 ${formatScaled(rate, RATIO_SCALE)} 超过阈值 ${rule.threshold}`}。`,
      amountCents: diff < 0n ? -diff : diff, metric: rate === null ? null : formatScaled(rate, RATIO_SCALE),
      evidence: { pbBatchId: batch.id, period: batch.period, from, executed: centsToDecimalString(p.executed), easPosted: centsToDecimalString(eas), diff: centsToDecimalString(diff), threshold: rule.threshold },
    });
  }
  return hits;
}

const feas = (name: string): Detector => ({ name, source: 'feasibility', thresholdKind: null, thresholdLabel: null, defaultThreshold: null, run: (db, r) => feasibilityHits(db, r) });

/** 计算器注册表;键与内置规则编码一致(V61 起 risk_rule.detector 引用)。 */
const DETECTORS: Record<string, Detector> = {
  PB_LOW_EXEC: { name: '项目预算执行率偏低', source: 'project_budget', thresholdKind: 'ratio', thresholdLabel: '执行率低于', defaultThreshold: '0.3', run: pbLowExecHits },
  PB_OVER_BUDGET: { name: '项目预算超支', source: 'project_budget', thresholdKind: null, thresholdLabel: null, defaultThreshold: null, run: (db, r) => pbOverBudgetHits(db, r) },
  PLAN_LOW_EXEC: { name: '年度投资计划执行率偏低', source: 'plan', thresholdKind: 'ratio', thresholdLabel: '执行率低于', defaultThreshold: '0.5', run: planLowExecHits },
  PLAN_PAY_AHEAD_PROGRESS: { name: '付款进度超前于形象进度', source: 'plan', thresholdKind: 'ratio', thresholdLabel: '超前差额大于', defaultThreshold: '0.2', run: planPayAheadHits },
  PLAN_ESTIMATE_NEAR_LIMIT: { name: '累计完成投资逼近批复概算', source: 'plan', thresholdKind: 'ratio', thresholdLabel: '占概算比例大于', defaultThreshold: '0.9', run: planEstimateNearLimitHits },
  PLAN_PROJECT_UNMAPPED: { name: '投资计划明细未关联项目', source: 'plan', thresholdKind: null, thresholdLabel: null, defaultThreshold: null, run: (db, r) => planProjectUnmappedHits(db, r) },
  CONTRACT_PAY_OVER_CAP: { name: '合同付款超过付款上限比例', source: 'contract', thresholdKind: null, thresholdLabel: null, defaultThreshold: null, run: (db, r) => contractOverCapHits(db, r) },
  CONTRACT_PAY_NO_VOUCHER: { name: '已支付款项缺少凭证号', source: 'contract', thresholdKind: null, thresholdLabel: null, defaultThreshold: null, run: (db, r) => contractPayNoVoucherHits(db, r) },
  SUPPLIER_LARGE_PAYMENTS: { name: '供应商大额集中付款', source: 'contract', thresholdKind: 'amount', thresholdLabel: '合计金额大于(元)', defaultThreshold: '1000000', run: supplierLargePaymentHits },
  CONTRACT_SIGN_BEFORE_PROCUREMENT: { name: '采购日期倒置或未批先签', source: 'contract', thresholdKind: null, thresholdLabel: null, defaultThreshold: null, run: (db, r) => contractSignBeforeProcurementHits(db, r) },
  CONTRACT_PERFORM_BEFORE_EFFECTIVE: { name: '未签先履约或早于生效日付款', source: 'contract', thresholdKind: null, thresholdLabel: null, defaultThreshold: null, run: (db, r) => contractPerformBeforeEffectiveHits(db, r) },
  CONTRACT_EMERGENCY_OVERDUE: { name: '应急项目逾期未补立项或未完成签约', source: 'contract', thresholdKind: null, thresholdLabel: null, defaultThreshold: null, run: (db, r) => contractEmergencyOverdueHits(db, r) },
  CONTRACT_DISTRIBUTION_OVERDUE: { name: '签署超 10 工作日未分发或未报公司备案', source: 'contract', thresholdKind: null, thresholdLabel: null, defaultThreshold: null, run: (db, r) => contractDistributionOverdueHits(db, r) },
  CONTRACT_UNDERTAKER_UNASSIGNED: { name: '在途合同缺承办人或调离超 15 工作日未交接', source: 'contract', thresholdKind: null, thresholdLabel: null, defaultThreshold: null, run: (db, r) => contractUndertakerUnassignedHits(db, r) },
  CONTRACT_CHANGE_TIER_MISMATCH: { name: '变更越权审批、缺补充协议或未备案超时', source: 'contract', thresholdKind: null, thresholdLabel: null, defaultThreshold: null, run: (db, r) => contractChangeTierMismatchHits(db, r) },
  CONTRACT_SPLIT_EVADE_TENDER: { name: '疑似拆分合同规避采购层级或公开招标', source: 'contract', thresholdKind: null, thresholdLabel: null, defaultThreshold: null, run: (db, r) => contractSplitEvadeTenderHits(db, r) },
  CONTRACT_OVER_SETTLE_OR_PAY: { name: '超结算超额支付、漏扣款或施工缺专户', source: 'contract', thresholdKind: null, thresholdLabel: null, defaultThreshold: null, run: (db, r) => contractOverSettleOrPayHits(db, r) },
  CONTRACT_LONG_UNSETTLED: { name: '合同到期超 180 天未完成最终结算', source: 'contract', thresholdKind: null, thresholdLabel: null, defaultThreshold: null, run: (db, r) => contractLongUnsettledHits(db, r) },
  CONTRACT_GUARANTEE_WARRANTY_DUE: { name: '保函临期/索赔未报、质保超期或纠纷未双备案', source: 'contract', thresholdKind: null, thresholdLabel: null, defaultThreshold: null, run: (db, r) => contractGuaranteeWarrantyDueHits(db, r) },
  IC_OVER_REDLINE: { name: '投资超出批复概算红线', source: 'investment_control', thresholdKind: null, thresholdLabel: null, defaultThreshold: null, run: (db, r) => icChainHits(db, r, false) },
  IC_CONTROL_BREAK: { name: '四算控制链被突破', source: 'investment_control', thresholdKind: null, thresholdLabel: null, defaultThreshold: null, run: (db, r) => icChainHits(db, r, true) },
  IC_DEVIATION_EXCEED: { name: '科目投资偏差超限', source: 'investment_control', thresholdKind: null, thresholdLabel: null, defaultThreshold: null, run: (db, r) => icDeviationHits(db, r) },
  FEAS_NPV_NEGATIVE: feas('可行性测算净现值为负'),
  FEAS_IRR_LOW: feas('可行性测算收益率未达标或无解'),
  FEAS_DSCR_LOW: feas('偿债覆盖率不足'),
  FEAS_FUNDING_GAP: feas('测算期存在资金缺口'),
  FEAS_MODEL_CHECK: feas('测算模型检查未通过'),
  EAS_PROJECT_CODE_MISSING: { name: '大额凭证缺少项目辅助核算', source: 'eas', thresholdKind: 'amount', thresholdLabel: '借方金额大于(元)', defaultThreshold: '100000', run: easProjectMissingHits },
  EAS_LONG_UNCLEARED: { name: '预付/暂估/挂账事项待清理', source: 'eas', thresholdKind: null, thresholdLabel: null, defaultThreshold: null, run: (db, r) => easUnclearedHits(db, r) },
  EAS_BUDGET_DIFF: { name: '项目预算执行与 EAS 入账差异', source: 'eas', thresholdKind: 'ratio', thresholdLabel: '差异率大于', defaultThreshold: '0.1', run: easBudgetDiffHits },
};

function thresholdValue(d: Detector, rule: RuleRow): bigint {
  const raw = rule.threshold ?? d.defaultThreshold;
  if (!d.thresholdKind || raw == null) return 0n;
  return d.thresholdKind === 'ratio' ? parseScaled(raw, RATIO_SCALE) : parseDecimalToCents(raw);
}

/** 按启用规则计算全部命中(不写库)。自定义规则限定组织时只保留该组织(含下级)的命中。 */
export function computeRiskHits(db: DB): RiskHit[] {
  const rules = db.prepare('SELECT * FROM risk_rule WHERE enabled = 1 ORDER BY builtin DESC, code').all() as RuleRow[];
  const hits: RiskHit[] = [];
  for (const rule of rules) {
    const d = DETECTORS[rule.detector];
    if (!d) continue;
    let found = d.run(db, rule, thresholdValue(d, rule));
    if (rule.org_id !== null) {
      const sub = subtreeIds(db, rule.org_id);
      found = found.filter((h) => sub.has(h.orgId));
    }
    hits.push(...found);
  }
  const seen = new Set<string>();
  return hits.filter((h) => { const k = eventKeyOf(h); if (seen.has(k)) return false; seen.add(k); return true; });
}

/* ================= 扫描写入 ================= */

function subtreeIds(db: DB, orgId: number): Set<number> {
  return new Set((db.prepare('WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT o.id FROM org o JOIN sub ON o.parent_id = sub.id) SELECT id FROM sub').all(orgId) as { id: number }[]).map((r) => r.id));
}

export function scanRisks(db: DB, input: { orgId?: number } = {}): RiskScanDto & { hits: number } {
  const scope = currentOrgScope(db);
  if (input.orgId && (!db.prepare('SELECT 1 FROM org WHERE id = ?').get(input.orgId) || !orgInScope(scope, input.orgId))) throw notVisible('组织');
  const limit = input.orgId ? subtreeIds(db, input.orgId) : null;
  const inRange = (orgId: number) => orgInScope(scope, orgId) && (!limit || limit.has(orgId));
  // 事务外计算
  const hits = computeRiskHits(db).filter((h) => inRange(h.orgId));
  const enabledRules = new Set((db.prepare('SELECT code FROM risk_rule WHERE enabled = 1').all() as { code: string }[]).map((r) => r.code));
  const scopeJson = { all: scope.all && !limit, orgId: input.orgId ?? null, orgIds: scope.all ? null : [...scope.orgIds].sort((a, b) => a - b) };
  const userId = currentAuth()?.userId ?? null;
  const scanId = db.transaction(() => {
    const now = nowIso();
    const scan = Number(db.prepare('INSERT INTO risk_scan (scope_json, created_by_user_id, created_at) VALUES (?, ?, ?)').run(JSON.stringify(scopeJson), userId, now).lastInsertRowid);
    const counts = { created: 0, updated: 0, reopened: 0, suppressed: 0, cleared: 0 };
    const byKey = db.prepare('SELECT id, status, version FROM risk_event WHERE event_key = ?');
    const addAction = db.prepare(`INSERT INTO risk_action (event_id, action, from_status, to_status, comment, scan_id, actor_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const hitKeys = new Set<string>();
    for (const h of hits) {
      const key = eventKeyOf(h);
      hitKeys.add(key);
      const amount = h.amountCents;
      const ev = byKey.get(key) as { id: number; status: RiskStatus; version: number } | undefined;
      if (!ev) {
        const eid = Number(db.prepare(`INSERT INTO risk_event (event_key, rule_code, source, level, org_id, project_id, subject_type, subject_id, title, description, amount_cents, metric,
            evidence_json, first_detected_at, last_detected_at, last_scan_id, created_at, updated_at)
          VALUES (?, ?, (SELECT source FROM risk_rule WHERE code = ?), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
          key, h.ruleCode, h.ruleCode, h.level, h.orgId, h.projectId, h.subjectType, h.subjectId, h.title, h.description, amount, h.metric, JSON.stringify(h.evidence),
          now, now, scan, now, now).lastInsertRowid);
        addAction.run(eid, 'detect', null, 'open', h.description, scan, userId, now);
        counts.created++;
        continue;
      }
      if (ev.status === 'false_positive') {
        db.prepare('UPDATE risk_event SET occurrence_count = occurrence_count + 1, last_detected_at = ?, last_scan_id = ?, last_scan_hit = 1 WHERE id = ?').run(now, scan, ev.id);
        addAction.run(ev.id, 'suppressed', 'false_positive', 'false_positive', h.description, scan, userId, now);
        counts.suppressed++;
        continue;
      }
      const reopen = ev.status === 'closed';
      db.prepare(`UPDATE risk_event SET level = ?, org_id = ?, project_id = ?, title = ?, description = ?, amount_cents = ?, metric = ?, evidence_json = ?,
          occurrence_count = occurrence_count + 1, last_detected_at = ?, last_scan_id = ?, last_scan_hit = 1, updated_at = ?, version = version + 1
          ${reopen ? ", status = 'open', reopened_count = reopened_count + 1, closed_at = NULL, submitted_by_user_id = NULL, reviewed_by_user_id = NULL, rectify_note = NULL" : ''}
        WHERE id = ?`).run(h.level, h.orgId, h.projectId, h.title, h.description, amount, h.metric, JSON.stringify(h.evidence), now, scan, now, ev.id);
      addAction.run(ev.id, reopen ? 'reopen' : 'redetect', ev.status, reopen ? 'open' : ev.status, h.description, scan, userId, now);
      if (reopen) counts.reopened++; else counts.updated++;
    }
    // 范围内、启用规则下本次未命中的未关闭事件:只标记最近扫描未命中
    const stale = db.prepare(`SELECT id, event_key, org_id, rule_code FROM risk_event WHERE status NOT IN ('closed','false_positive') AND last_scan_hit = 1`).all() as
      { id: number; event_key: string; org_id: number; rule_code: string }[];
    const clear = db.prepare('UPDATE risk_event SET last_scan_hit = 0, last_scan_id = ? WHERE id = ?');
    for (const e of stale) {
      if (hitKeys.has(e.event_key) || !inRange(e.org_id) || !enabledRules.has(e.rule_code)) continue;
      clear.run(scan, e.id);
      counts.cleared++;
    }
    db.prepare('UPDATE risk_scan SET created_count = ?, updated_count = ?, reopened_count = ?, suppressed_count = ?, cleared_count = ? WHERE id = ?')
      .run(counts.created, counts.updated, counts.reopened, counts.suppressed, counts.cleared, scan);
    writeLog(db, 'risk.scan', 'risk_scan', scan, { scope: scopeJson, hits: hits.length, ...counts });
    return scan;
  }).immediate();
  return { ...getRiskScan(db, scanId), hits: hits.length };
}

interface ScanRow { id: number; scope_json: string; created_count: number; updated_count: number; reopened_count: number; suppressed_count: number; cleared_count: number; created_by_user_id: number | null; created_at: string }
const scanDto = (r: ScanRow): RiskScanDto => ({
  id: r.id, scope: JSON.parse(r.scope_json) as Record<string, unknown>, createdCount: r.created_count, updatedCount: r.updated_count, reopenedCount: r.reopened_count,
  suppressedCount: r.suppressed_count, clearedCount: r.cleared_count, hitCount: r.created_count + r.updated_count + r.reopened_count + r.suppressed_count,
  createdByUserId: r.created_by_user_id, createdAt: r.created_at,
});

function scanVisible(scope: OrgScope, r: ScanRow): boolean {
  if (scope.all) return true;
  const s = JSON.parse(r.scope_json) as { all?: boolean; orgId?: number | null; orgIds?: number[] | null };
  if (s.orgId) return orgInScope(scope, s.orgId);
  return !s.all && !!s.orgIds?.length && s.orgIds.every((id) => orgInScope(scope, id));
}

export function getRiskScan(db: DB, id: number): RiskScanDto {
  const r = db.prepare('SELECT * FROM risk_scan WHERE id = ?').get(id) as ScanRow | undefined;
  if (!r || !scanVisible(currentOrgScope(db), r)) throw notVisible('风险扫描');
  return scanDto(r);
}

export function listRiskScans(db: DB): RiskScanDto[] {
  const scope = currentOrgScope(db);
  return (db.prepare('SELECT * FROM risk_scan ORDER BY id DESC LIMIT 100').all() as ScanRow[]).filter((r) => scanVisible(scope, r)).map(scanDto);
}

/* ================= 查询 ================= */

interface EventRow {
  id: number; event_key: string; rule_code: string; source: RiskSource; level: RiskLevel; org_id: number; project_id: number | null; subject_type: string; subject_id: number;
  title: string; description: string; amount_cents: bigint | null; metric: string | null; evidence_json: string; status: RiskStatus; occurrence_count: number;
  first_detected_at: string; last_detected_at: string; last_scan_id: number | null; last_scan_hit: number; handler_user_id: number | null; deadline: string | null;
  rectify_note: string | null; submitted_by_user_id: number | null; reviewed_by_user_id: number | null; closed_at: string | null; reopened_count: number;
  version: number; created_at: string; updated_at: string;
  rule_name: string; suggestion: string; org_name: string | null; project_code: string | null; project_name: string | null; handler_name: string | null;
}
const EVENT_SELECT = `SELECT e.*, r.name AS rule_name, r.suggestion, o.name AS org_name, p.code AS project_code, p.name AS project_name,
    COALESCE(u.display_name, u.username) AS handler_name
  FROM risk_event e JOIN risk_rule r ON r.code = e.rule_code LEFT JOIN org o ON o.id = e.org_id LEFT JOIN md_project p ON p.id = e.project_id
  LEFT JOIN app_user u ON u.id = e.handler_user_id`;

function fromBigRow(row: Record<string, unknown>): EventRow {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = typeof v === 'bigint' && k !== 'amount_cents' ? Number(v) : v;
  return out as unknown as EventRow;
}

const isOpenStatus = (s: RiskStatus) => s !== 'closed' && s !== 'false_positive';
const isOverdue = (r: { deadline: string | null; status: RiskStatus }) => !!r.deadline && isOpenStatus(r.status) && r.deadline < today();

function eventDto(r: EventRow): RiskEventDto {
  return {
    id: r.id, eventKey: r.event_key, ruleCode: r.rule_code, ruleName: r.rule_name, source: r.source, level: r.level, orgId: r.org_id, orgName: r.org_name,
    projectId: r.project_id, projectCode: r.project_code, projectName: r.project_name, subjectType: r.subject_type, subjectId: r.subject_id,
    title: r.title, description: r.description, amount: centsToDecimalOrNull(r.amount_cents), metric: r.metric, evidence: JSON.parse(r.evidence_json) as Record<string, unknown>,
    status: r.status, occurrenceCount: r.occurrence_count, firstDetectedAt: r.first_detected_at, lastDetectedAt: r.last_detected_at, lastScanId: r.last_scan_id,
    lastScanHit: r.last_scan_hit === 1, handlerUserId: r.handler_user_id, handlerName: r.handler_name, deadline: r.deadline, overdue: isOverdue(r),
    rectifyNote: r.rectify_note, submittedByUserId: r.submitted_by_user_id, reviewedByUserId: r.reviewed_by_user_id, closedAt: r.closed_at,
    reopenedCount: r.reopened_count, version: r.version, suggestion: r.suggestion, createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

function eventRow(db: DB, id: number): EventRow {
  const row = db.prepare(`${EVENT_SELECT} WHERE e.id = ?`).safeIntegers(true).get(id) as Record<string, unknown> | undefined;
  const r = row ? fromBigRow(row) : undefined;
  if (!r || !orgInScope(currentOrgScope(db), r.org_id)) throw notVisible('风险');
  return r;
}

export function listRiskEvents(db: DB, q: RiskListQuery = {}): RiskEventDto[] {
  const scope = currentOrgScope(db);
  if (q.orgId && !orgInScope(scope, q.orgId)) throw notVisible('组织');
  const sc = scopeFilterSql(scope, 'e.org_id');
  const where = [sc.sql];
  const params: unknown[] = [...sc.params];
  if (q.status) { where.push('e.status = ?'); params.push(q.status); }
  if (q.open) where.push("e.status NOT IN ('closed','false_positive')");
  if (q.level) { where.push('e.level = ?'); params.push(q.level); }
  if (q.source) { where.push('e.source = ?'); params.push(q.source); }
  if (q.ruleCode) { where.push('e.rule_code = ?'); params.push(q.ruleCode); }
  if (q.projectId) { where.push('e.project_id = ?'); params.push(q.projectId); }
  if (q.lastScanHit) { where.push('e.last_scan_hit = ?'); params.push(Number(q.lastScanHit)); }
  if (q.orgId) {
    where.push('e.org_id IN (WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT o.id FROM org o JOIN sub ON o.parent_id = sub.id) SELECT id FROM sub)');
    params.push(q.orgId);
  }
  if (q.keyword) { where.push("(e.title LIKE ? ESCAPE '\\' OR e.description LIKE ? ESCAPE '\\')"); const k = `%${q.keyword.replace(/[\\%_]/g, (c) => `\\${c}`)}%`; params.push(k, k); }
  const rows = db.prepare(`${EVENT_SELECT} WHERE ${where.join(' AND ')}
    ORDER BY CASE e.status WHEN 'open' THEN 0 WHEN 'rectified' THEN 1 WHEN 'confirmed' THEN 2 WHEN 'rectifying' THEN 3 ELSE 4 END,
      CASE e.level WHEN 'high' THEN 0 WHEN 'medium' THEN 1 ELSE 2 END, e.id DESC LIMIT 1000`).safeIntegers(true).all(...params) as Record<string, unknown>[];
  return rows.map((r) => eventDto(fromBigRow(r)));
}

interface ActionRow {
  id: number; action: string; from_status: RiskStatus | null; to_status: RiskStatus | null; comment: string; attachment_file_object_id: number | null; attachment_name: string | null;
  scan_id: number | null; exception_reason: string | null; actor_user_id: number | null; actor_name: string | null; created_at: string;
}

function allowedCommands(db: DB, r: EventRow): RiskCommand[] {
  const auth = currentAuth();
  const can = (p: 'risk:handle' | 'risk:review') => !auth || auth.permissions.has(p);
  const out: RiskCommand[] = [];
  for (const cmd of Object.keys(TRANSITIONS) as RiskCommand[]) {
    const t = TRANSITIONS[cmd];
    if (t.from && !t.from.includes(r.status)) continue;
    if (!can(t.permission)) continue;
    out.push(cmd);
  }
  return out;
}

export function getRiskEvent(db: DB, id: number): RiskEventDetailDto {
  const r = eventRow(db, id);
  const actions = (db.prepare(`SELECT a.*, COALESCE(u.display_name, u.username) AS actor_name FROM risk_action a LEFT JOIN app_user u ON u.id = a.actor_user_id
    WHERE a.event_id = ? ORDER BY a.id`).all(id) as ActionRow[]).map((a): RiskActionDto => ({
    id: a.id, action: a.action, actionLabel: RISK_ACTION_LABELS[a.action] ?? a.action, fromStatus: a.from_status, toStatus: a.to_status, comment: a.comment,
    attachmentName: a.attachment_name, hasAttachment: a.attachment_file_object_id !== null, scanId: a.scan_id, exceptionReason: a.exception_reason,
    actorUserId: a.actor_user_id, actorName: a.actor_name, createdAt: a.created_at,
  }));
  return { ...eventDto(r), actions, allowed: allowedCommands(db, r), explanations: listExplanations(db, id) };
}

/* ================= 风险解释与整改清单 ================= */

interface NoteRow { id: number; event_id: number; content: string; source: 'template' | 'model'; model: string; prompt_version: string; event_version: number; created_by: string | null; created_at: string }

function listExplanations(db: DB, eventId: number): RiskExplanationDto[] {
  return (db.prepare(`SELECT n.*, COALESCE(u.display_name, u.username) AS created_by FROM risk_ai_note n LEFT JOIN app_user u ON u.id = n.created_by_user_id
    WHERE n.event_id = ? AND n.kind = 'explain' ORDER BY n.id DESC LIMIT 10`).all(eventId) as NoteRow[]).map((n) => ({
    id: n.id, eventId: n.event_id, content: n.content, source: n.source, model: n.model, promptVersion: n.prompt_version, eventVersion: n.event_version,
    createdBy: n.created_by, createdAt: n.created_at,
  }));
}

/** 各来源的常见成因(确定性文本,模型只能改写行文)。 */
const CAUSE_HINTS: Record<RiskSource, string[]> = {
  project_budget: ['项目进度或资金拨付节奏与年度预算编制不一致', '预算执行数统计口径与项目实际支出存在差异'],
  plan: ['工程形象进度、付款与投资完成统计不同步', '计划编制依据变化后未及时调整年度计划或概算'],
  contract: ['付款节点与合同约定、履约确认或发票登记不一致', '付款登记缺少凭证等追溯信息'],
  investment_control: ['设计变更、价格或工程量变化导致投资突破控制层级', '概算/预算/结算版本编制依据不一致'],
  feasibility: ['收入、成本、投资或融资参数假设偏乐观', '测算模型检查项未通过或参数不完整'],
  eas: ['凭证辅助核算登记不完整或与项目编码不一致', '往来款项未按合同与发票及时清理'],
};

/** 生成并保存一次风险解释:确定性模板 + 可选模型改写(数字/名称护栏);不改风险事实与状态。 */
export async function explainRisk(db: DB, id: number): Promise<RiskExplanationDto> {
  requirePermission(currentAuth(), 'risk:handle');
  const e = eventDto(eventRow(db, id));
  const lines = [
    '## 风险概况',
    `- 规则:${e.ruleName}(${e.ruleCode}),等级:${RISK_LEVEL_TEXT[e.level]},状态:${STATUS_TEXT[e.status]}`,
    `- 对象:${e.orgName ?? '—'}${e.projectCode ? ` / ${e.projectCode} ${e.projectName ?? ''}`.trimEnd() : ''}`,
    `- 触发事实:${e.description}`,
    ...(e.amount ? [`- 涉及金额:${e.amount} 元${e.metric ? `;指标:${e.metric}` : ''}`] : e.metric ? [`- 指标:${e.metric}`] : []),
    `- 命中情况:首次 ${e.firstDetectedAt.slice(0, 10)},最近 ${e.lastDetectedAt.slice(0, 10)},共 ${e.occurrenceCount} 次${e.reopenedCount ? `,重开 ${e.reopenedCount} 次` : ''}${e.lastScanHit ? '' : ';最近一次扫描未再命中'}`,
    '## 可能原因',
    ...CAUSE_HINTS[e.source].map((c) => `- ${c}`),
    '## 整改建议',
    ...(e.suggestion ? [`- ${e.suggestion}`] : []),
    '- 明确责任人与整改期限,整改完成后上传支撑材料并提交复核',
    '## 提示',
    '- 本解释按规则命中事实生成,仅作辅助参考,结论需经财务人员复核确认。',
  ];
  const template = lines.join('\n');
  const factTerms = [e.ruleName, e.orgName, e.projectCode, e.projectName].filter((x): x is string => !!x);
  const rewrite = await rewriteTemplateNarrative({
    enabled: riskExplainAiEnabled(), promptVersion: PROMPT_VERSION.riskExplain, task: RISK_EXPLAIN_REWRITE_TASK, supplement: promptSupplement(db, 'riskExplain'), template, factTerms, maxChars: 8000,
  });
  const noteId = db.transaction(() => {
    const nid = Number(db.prepare(`INSERT INTO risk_ai_note (event_id, kind, content, source, model, prompt_version, event_version, created_by_user_id, created_at)
      VALUES (?, 'explain', ?, ?, ?, ?, ?, ?, ?)`).run(id, rewrite.text, rewrite.source, rewrite.model, rewrite.promptVersion, e.version, currentAuth()?.userId ?? null, nowIso()).lastInsertRowid);
    writeLog(db, 'risk.event.explain', 'risk_event', id, { noteId: nid, source: rewrite.source, model: rewrite.model, guardFailed: !!rewrite.guardFailure });
    return nid;
  }).immediate();
  return listExplanations(db, id).find((n) => n.id === noteId)!;
}

const RISK_LEVEL_TEXT: Record<RiskLevel, string> = { high: '高', medium: '中', low: '低' };

const CONTRACT_DOC_LABELS: Record<string, string> = { signed: '签订版合同', performance: '履约记录', acceptance: '验收文件', invoice: '发票' };

/** 风险对应的业务页面(结果可回到真实页面)。 */
function sourceRefs(db: DB, e: RiskEventDto): { label: string; path: string }[] {
  const refs: { label: string; path: string }[] = [];
  const ev = e.evidence;
  if (e.projectId) refs.push({ label: `项目档案 ${e.projectCode ?? ''}`.trim(), path: `/projects/${e.projectId}` });
  switch (e.source) {
    case 'project_budget': refs.push({ label: '项目预算', path: ev.batchId ? `/project-budget?batchId=${String(ev.batchId)}` : '/project-budget' }); break;
    case 'plan': refs.push({ label: '计划执行', path: '/plan' }); break;
    case 'contract':
      if (typeof ev.contractId === 'number') refs.push({ label: '合同详情', path: `/contracts?id=${ev.contractId}` });
      if (e.subjectType === 'supplier') refs.push({ label: '供应商', path: '/master-entities?tab=suppliers' });
      break;
    case 'investment_control': refs.push({ label: '投资控制', path: `/investment-control?id=${e.subjectId}` }); break;
    case 'feasibility': {
      const s = db.prepare('SELECT project_id FROM if_scenario WHERE id = ?').get(e.subjectId) as { project_id: number } | undefined;
      refs.push({ label: '可行性测算', path: s ? `/feasibility?id=${s.project_id}` : '/feasibility' });
      break;
    }
    case 'eas': refs.push({ label: 'EAS 工作台', path: '/eas' }); if (e.ruleCode === 'EAS_BUDGET_DIFF' || e.subjectType === 'project') refs.push({ label: '项目预算', path: '/project-budget' }); break;
  }
  return refs;
}

/** 整改清单:按风险来源、当前状态与证据确定性生成,不写库。 */
export function riskChecklist(db: DB, id: number): RiskChecklistDto {
  const r = eventRow(db, id);
  const e = eventDto(r);
  const refs = sourceRefs(db, e);
  const hasAttachment = !!db.prepare('SELECT 1 FROM risk_action WHERE event_id = ? AND attachment_file_object_id IS NOT NULL LIMIT 1').get(id);
  const missing: { key: string; label: string }[] = [];
  const contractId = typeof e.evidence.contractId === 'number' ? e.evidence.contractId : e.subjectType === 'contract' ? e.subjectId : null;
  if (contractId) {
    const types = new Set((db.prepare('SELECT DISTINCT doc_type FROM ct_document WHERE contract_id = ?').all(contractId) as { doc_type: string }[]).map((d) => d.doc_type));
    for (const t of ['signed', 'performance', 'invoice']) if (!types.has(t) && !(t === 'performance' && types.has('acceptance'))) missing.push({ key: `contract_${t}`, label: CONTRACT_DOC_LABELS[t] });
  }
  if (['rectifying', 'rectified'].includes(e.status) && !hasAttachment) missing.push({ key: 'rectify_attachment', label: '整改支撑材料(附件)' });
  const items: RiskChecklistItemDto[] = [
    { key: 'fact', question: '风险触发事实、金额、项目和规则是否与业务明细一致?', required: true, done: e.status === 'open' ? null : true, hint: '打开业务页面逐项核对命中证据;不一致时认定误报并写明理由。', refs },
    { key: 'owner', question: '是否已明确责任人与整改期限?', required: true, done: !!e.handlerUserId && !!e.deadline, hint: e.overdue ? `已超过整改期限 ${e.deadline}` : '确认或开始整改时指定责任人与期限。', refs: [] },
  ];
  const sourceItem: Record<RiskSource, RiskChecklistItemDto> = {
    project_budget: { key: 'budget', question: '项目预算执行数、资金拨付与 EAS 凭证是否已核对,差异原因是否可解释?', required: true, done: null, hint: '必要时发起预算调整。', refs },
    plan: { key: 'plan', question: '形象进度、完成投资与付款统计是否同口径,滞后或超前原因是否已说明?', required: true, done: null, hint: '对照计划执行表的截至期间与项目主数据。', refs },
    contract: { key: 'contract', question: '合同条款、付款节点、审批与凭证链是否已针对性复核?', required: true, done: missing.every((m) => !m.key.startsWith('contract_')), hint: missing.length ? `缺少:${missing.filter((m) => m.key.startsWith('contract_')).map((m) => m.label).join('、') || '—'}` : '合同证据链完整。', refs },
    investment_control: { key: 'ic', question: '超限科目的变更依据、审批与责任是否已落实?', required: true, done: null, hint: '按对比快照逐科目核对概算/预算/结算依据。', refs },
    feasibility: { key: 'feas', question: '测算参数是否已复核,敏感性结果是否支持方案结论?', required: true, done: null, hint: '修正参数后重新测算,不得绕过模型检查。', refs },
    eas: { key: 'eas', question: '相关凭证的辅助核算与往来清理是否已完成?', required: true, done: null, hint: '在 EAS 中补录辅助核算或清理往来后重新导入当期数据。', refs },
  };
  items.push(sourceItem[e.source]);
  items.push({ key: 'rectify', question: '整改说明是否写明处理动作、完成时间与支撑材料?', required: true, done: e.rectifyNote ? hasAttachment : null, hint: hasAttachment ? '已上传整改材料。' : '提交复核前上传支撑材料。', refs: [] });
  items.push({ key: 'review', question: '复核人是否独立于整改提交人?', required: true, done: e.status === 'closed' ? true : null, hint: '复核通过或退回需 risk:review,且复核人 ≠ 提交人。', refs: [] });
  const next: Record<RiskStatus, RiskStatus | null> = {
    open: 'confirmed', confirmed: 'rectifying', rectifying: missing.length ? 'rectifying' : 'rectified', rectified: 'closed', closed: null, false_positive: null,
  };
  return { eventId: id, eventVersion: e.version, status: e.status, items, missingMaterials: missing, suggestedNextStatus: next[e.status], generatedAt: nowIso() };
}

export function riskActionAttachment(db: DB, store: ObjectStore, eventId: number, actionId: number): { fileName: string; contentType: string; content: Buffer } {
  eventRow(db, eventId);
  const a = db.prepare(`SELECT a.attachment_name, f.sha256, f.content_type FROM risk_action a JOIN file_object f ON f.id = a.attachment_file_object_id
    WHERE a.id = ? AND a.event_id = ?`).get(actionId, eventId) as { attachment_name: string; sha256: string; content_type: string } | undefined;
  if (!a) throw notVisible('风险附件');
  writeLog(db, 'risk.attachment.download', 'risk_event', eventId, { actionId });
  return { fileName: a.attachment_name, contentType: a.content_type, content: store.read(a.sha256) };
}

export function riskSummary(db: DB, q: { orgId?: number } = {}): RiskSummaryDto {
  const events = listRiskEvents(db, q.orgId ? { orgId: q.orgId } : {});
  const byStatus = Object.fromEntries(RISK_STATUSES.map((s) => [s, 0])) as Record<RiskStatus, number>;
  const byLevel = Object.fromEntries(RISK_LEVELS.map((s) => [s, 0])) as Record<RiskLevel, number>;
  const byRule = new Map<string, { ruleCode: string; ruleName: string; count: number }>();
  let openAmount = 0n; let openCount = 0; let overdue = 0;
  for (const e of events) {
    byStatus[e.status]++;
    if (!isOpenStatus(e.status)) continue;
    openCount++;
    byLevel[e.level]++;
    if (e.overdue) overdue++;
    if (e.amount) openAmount += parseDecimalToCents(e.amount);
    const g = byRule.get(e.ruleCode) ?? { ruleCode: e.ruleCode, ruleName: e.ruleName, count: 0 };
    g.count++; byRule.set(e.ruleCode, g);
  }
  return {
    total: events.length, openCount, openAmount: centsToDecimalString(openAmount), byStatus, byLevel,
    byRule: [...byRule.values()].sort((a, b) => b.count - a.count || a.ruleCode.localeCompare(b.ruleCode)),
    pendingConfirm: byStatus.open, pendingReview: byStatus.rectified, overdue,
  };
}

/** 管理会计计算器 risk_open_amount:组织(含下级)内未关闭风险金额合计(分)。 */
export function riskOpenAmountCents(db: DB, orgId: number | null): { cents: bigint; count: number } {
  const scope = currentOrgScope(db);
  const sc = scopeFilterSql(scope, 'org_id');
  const where = ["status NOT IN ('closed','false_positive')", sc.sql];
  const params: unknown[] = [...sc.params];
  if (orgId) {
    where.push('org_id IN (WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT o.id FROM org o JOIN sub ON o.parent_id = sub.id) SELECT id FROM sub)');
    params.push(orgId);
  }
  const r = db.prepare(`SELECT COALESCE(SUM(amount_cents), 0) AS cents, COUNT(*) AS n FROM risk_event WHERE ${where.join(' AND ')}`).safeIntegers(true).get(...params) as { cents: bigint; n: bigint };
  return { cents: r.cents, count: Number(r.n) };
}

/* ================= 状态流转 ================= */

const TRANSITIONS: Record<RiskCommand, { from: RiskStatus[] | null; to: RiskStatus | null; permission: 'risk:handle' | 'risk:review' }> = {
  confirm: { from: ['open'], to: 'confirmed', permission: 'risk:handle' },
  start: { from: ['confirmed'], to: 'rectifying', permission: 'risk:handle' },
  submit: { from: ['rectifying'], to: 'rectified', permission: 'risk:handle' },
  approve: { from: ['rectified'], to: 'closed', permission: 'risk:review' },
  return: { from: ['rectified'], to: 'rectifying', permission: 'risk:review' },
  false_positive: { from: ['open', 'confirmed'], to: 'false_positive', permission: 'risk:review' },
  comment: { from: null, to: null, permission: 'risk:handle' },
};

const STATUS_TEXT: Record<RiskStatus, string> = { open: '待确认', confirmed: '已确认', rectifying: '整改中', rectified: '待复核', closed: '已关闭', false_positive: '误报' };

export function actOnRisk(db: DB, store: ObjectStore, id: number, input: RiskActionForm, file?: { buffer: Buffer; name: string; contentType?: string }): RiskEventDetailDto {
  const t = TRANSITIONS[input.action];
  const auth = currentAuth();
  requirePermission(auth, t.permission);
  const comment = input.comment?.trim() ?? '';
  if (input.action === 'submit' && !comment) throw Errors.validation('提交复核必须填写整改说明');
  if ((input.action === 'return' || input.action === 'false_positive') && !comment) throw Errors.validation(input.action === 'return' ? '退回必须填写意见' : '认定误报必须说明理由');
  if (input.action === 'comment' && !comment && !file) throw Errors.validation('备注需要填写说明或上传附件');
  if (input.handlerUserId && !db.prepare("SELECT 1 FROM app_user WHERE id = ? AND status = 'active'").get(input.handlerUserId)) throw Errors.validation('责任人不存在或已停用');
  eventRow(db, id);
  // 附件落盘在写事务之外
  const attachment = file ? storeFile(db, store, file.buffer, { originalName: file.name, contentType: file.contentType }) : null;
  db.transaction(() => {
    const r = eventRow(db, id);
    if (r.version !== input.expectedVersion) throw new AppError('VERSION_CONFLICT', '风险已被他人处理,请刷新后重试', 409);
    if (t.from && !t.from.includes(r.status)) {
      throw conflict(`当前状态“${STATUS_TEXT[r.status]}”不能执行“${RISK_ACTION_LABELS[input.action]}”`);
    }
    let selfReview = false;
    if (input.action === 'approve' || input.action === 'return') {
      selfReview = assertDistinctReviewer(db, auth, r.submitted_by_user_id, input.exceptionReason, '风险整改').selfReview;
    }
    const to = t.to ?? r.status;
    const sets: string[] = ['version = version + 1', 'updated_at = ?'];
    const params: unknown[] = [nowIso()];
    if (t.to) { sets.push('status = ?'); params.push(t.to); }
    if (input.handlerUserId !== undefined && (input.action === 'confirm' || input.action === 'start' || input.action === 'comment')) { sets.push('handler_user_id = ?'); params.push(input.handlerUserId); }
    if (input.deadline !== undefined && (input.action === 'confirm' || input.action === 'start' || input.action === 'comment')) { sets.push('deadline = ?'); params.push(input.deadline); }
    if (input.action === 'start' && !r.handler_user_id && input.handlerUserId === undefined) { sets.push('handler_user_id = ?'); params.push(auth?.userId ?? null); }
    if (input.action === 'submit') { sets.push('rectify_note = ?', 'submitted_by_user_id = ?'); params.push(comment, auth?.userId ?? null); }
    if (input.action === 'approve') { sets.push('reviewed_by_user_id = ?', 'closed_at = ?'); params.push(auth?.userId ?? null, nowIso()); }
    if (input.action === 'return') { sets.push('reviewed_by_user_id = ?'); params.push(auth?.userId ?? null); }
    db.prepare(`UPDATE risk_event SET ${sets.join(', ')} WHERE id = ?`).run(...params, id);
    db.prepare(`INSERT INTO risk_action (event_id, action, from_status, to_status, comment, attachment_file_object_id, attachment_name, exception_reason, actor_user_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, input.action, r.status, to, comment, attachment?.id ?? null, attachment ? file!.name.slice(0, 200) : null,
      selfReview ? input.exceptionReason ?? null : null, auth?.userId ?? null, nowIso());
    writeLog(db, `risk.event.${input.action}`, 'risk_event', id, {
      eventKey: r.event_key, from: r.status, to, handlerUserId: input.handlerUserId, deadline: input.deadline, selfReview,
      exceptionReason: selfReview ? input.exceptionReason : undefined, attachmentSha256: attachment?.sha256,
    });
  }).immediate();
  return getRiskEvent(db, id);
}

/* ================= 整改台账(标准报表取数) ================= */

export interface RiskLedgerRow {
  eventId: number; riskNo: string; ruleCode: string; ruleName: string; level: RiskLevel; status: RiskStatus; orgName: string | null; project: string;
  title: string; amount: string | null; handler: string | null; deadline: string | null; overdue: boolean; lastAction: string | null; lastActionAt: string | null;
  occurrenceCount: number; version: number;
}

/** 风险整改台账:按范围读取风险当前状态与最近动作;调用方负责冻结。 */
export function riskLedgerRows(db: DB, input: { orgId?: number; includeClosed?: boolean }): RiskLedgerRow[] {
  const events = listRiskEvents(db, input.orgId ? { orgId: input.orgId } : {})
    .filter((e) => input.includeClosed !== false || isOpenStatus(e.status))
    .sort((a, b) => a.id - b.id);
  const last = db.prepare('SELECT action, created_at FROM risk_action WHERE event_id = ? ORDER BY id DESC LIMIT 1');
  return events.map((e) => {
    const a = last.get(e.id) as { action: string; created_at: string } | undefined;
    return {
      eventId: e.id, riskNo: `RISK-${String(e.id).padStart(6, '0')}`, ruleCode: e.ruleCode, ruleName: e.ruleName, level: e.level, status: e.status, orgName: e.orgName,
      project: e.projectCode ? `${e.projectCode} ${e.projectName ?? ''}`.trim() : '', title: e.title, amount: e.amount, handler: e.handlerName, deadline: e.deadline,
      overdue: e.overdue, lastAction: a ? RISK_ACTION_LABELS[a.action] ?? a.action : null, lastActionAt: a?.created_at ?? null, occurrenceCount: e.occurrenceCount, version: e.version,
    };
  });
}
