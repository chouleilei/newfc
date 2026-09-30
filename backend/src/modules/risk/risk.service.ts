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
import crypto from 'crypto';
import type { DB } from '../../db/connection';
import { AppError, Errors } from '../../core/errors';
import { currentAuth } from '../../core/request-context';
import { centsToDecimalOrNull, centsToDecimalString, parseDecimalToCents, parseScaled, ratioScaled, ratioString, RATIO_SCALE } from '../../core/decimal';
import { writeLog } from '../audit/log';
import { currentOrgScope, notVisible, orgInScope, requireCurrentAllOrgs, requirePermission, scopeFilterSql, type OrgScope } from '../security/scope';
import { assertDistinctReviewer } from '../security/review';
import { storeFile, type ObjectStore } from '../files/object-store';
import { feasibilityRiskHits } from '../investment/feasibility-calc';
import type { FeasResultDto } from '../../contracts/investment-feasibility';
import type { IcComparisonSummaryDto } from '../../contracts/investment-control';
import {
  RISK_ACTION_LABELS, RISK_LEVELS, RISK_STATUSES, type RiskActionDto, type RiskActionForm, type RiskCommand, type RiskEventDetailDto, type RiskEventDto,
  type RiskLevel, type RiskListQuery, type RiskRuleDto, type RiskRuleUpdate, type RiskScanDto, type RiskSource, type RiskStatus, type RiskSummaryDto,
} from '../../contracts/risk';

const nowIso = () => new Date().toISOString();
const today = () => nowIso().slice(0, 10);
const conflict = (message: string) => new AppError('RISK_STATE', message, 409);

/* ================= 规则 ================= */

interface RuleRow {
  code: string; name: string; source: RiskSource; level: RiskLevel; threshold: string | null; enabled: number; suggestion: string; version: number; updated_at: string | null;
}
const THRESHOLD_RULES = new Set(['PB_LOW_EXEC', 'PLAN_LOW_EXEC']);

const ruleDto = (r: RuleRow): RiskRuleDto => ({
  code: r.code, name: r.name, source: r.source, level: r.level, threshold: r.threshold, thresholdApplies: THRESHOLD_RULES.has(r.code), enabled: r.enabled === 1,
  suggestion: r.suggestion, version: r.version, updatedAt: r.updated_at,
});

export function listRiskRules(db: DB): RiskRuleDto[] {
  return (db.prepare('SELECT * FROM risk_rule ORDER BY source, code').all() as RuleRow[]).map(ruleDto);
}

export function updateRiskRule(db: DB, code: string, input: RiskRuleUpdate): RiskRuleDto {
  requirePermission(currentAuth(), 'risk:review');
  requireCurrentAllOrgs('调整风险规则');
  db.transaction(() => {
    const r = db.prepare('SELECT * FROM risk_rule WHERE code = ?').get(code) as RuleRow | undefined;
    if (!r) throw notVisible('风险规则');
    if (r.version !== input.expectedVersion) throw new AppError('VERSION_CONFLICT', '规则已被他人修改,请刷新后重试', 409);
    if (input.threshold !== undefined && !THRESHOLD_RULES.has(code)) throw Errors.validation('该规则没有可调阈值');
    if (THRESHOLD_RULES.has(code) && input.threshold === null) throw Errors.validation('该规则阈值不能为空');
    const next = {
      enabled: input.enabled === undefined ? r.enabled : input.enabled ? 1 : 0, level: input.level ?? r.level,
      threshold: input.threshold === undefined ? r.threshold : input.threshold, suggestion: input.suggestion ?? r.suggestion,
    };
    db.prepare('UPDATE risk_rule SET enabled = ?, level = ?, threshold = ?, suggestion = ?, version = version + 1, updated_by_user_id = ?, updated_at = ? WHERE code = ?')
      .run(next.enabled, next.level, next.threshold, next.suggestion, currentAuth()?.userId ?? null, nowIso(), code);
    writeLog(db, 'risk.rule.update', 'risk_rule', code, { code, before: { enabled: r.enabled === 1, level: r.level, threshold: r.threshold }, after: { ...next, enabled: next.enabled === 1 } });
  }).immediate();
  return ruleDto(db.prepare('SELECT * FROM risk_rule WHERE code = ?').get(code) as RuleRow);
}

/* ================= 命中计算(事务外) ================= */

export interface RiskHit {
  ruleCode: string; level: RiskLevel; subjectType: string; subjectId: number; sub?: string; orgId: number; projectId: number | null;
  title: string; description: string; amountCents: bigint | null; metric: string | null; evidence: Record<string, unknown>;
}
export const eventKeyOf = (h: Pick<RiskHit, 'ruleCode' | 'subjectType' | 'subjectId' | 'sub'>) =>
  `${h.ruleCode}:${h.subjectType}:${h.subjectId}${h.sub ? `:${h.sub}` : ''}`;

const shortHash = (s: string) => crypto.createHash('sha1').update(s).digest('hex').slice(0, 12);
const thresholdScaled = (r: RuleRow, fallback: string) => parseScaled(r.threshold ?? fallback, RATIO_SCALE);

function projectBudgetHits(db: DB, rules: Map<string, RuleRow>): RiskHit[] {
  const low = rules.get('PB_LOW_EXEC'); const over = rules.get('PB_OVER_BUDGET');
  if (!low && !over) return [];
  const batch = db.prepare('SELECT id, year, period FROM pb_batch WHERE is_current = 1 ORDER BY year DESC, period DESC LIMIT 1').get() as
    { id: number; year: number; period: string } | undefined;
  if (!batch) return [];
  const rows = db.prepare(`SELECT e.project_id, e.org_id, MAX(e.project_code) AS code, MAX(e.project_name) AS name,
      SUM(e.budget_cents) AS budget, SUM(e.executed_cents) AS executed
    FROM pb_entry e WHERE e.batch_id = ? GROUP BY e.project_id, e.org_id ORDER BY e.project_id, e.org_id`).safeIntegers(true).all(batch.id) as
    { project_id: bigint; org_id: bigint; code: string; name: string; budget: bigint; executed: bigint }[];
  const hits: RiskHit[] = [];
  const t = low ? thresholdScaled(low, '0.3') : 0n;
  for (const r of rows) {
    const base = {
      subjectType: 'project', subjectId: Number(r.project_id), sub: `org${r.org_id}`, orgId: Number(r.org_id), projectId: Number(r.project_id),
    };
    const evidence = { batchId: batch.id, year: batch.year, period: batch.period, budget: centsToDecimalString(r.budget), executed: centsToDecimalString(r.executed) };
    if (over && r.executed > r.budget) {
      hits.push({
        ...base, ruleCode: over.code, level: over.level, title: `${r.code} ${r.name} 预算超支`,
        description: `${batch.period} 项目预算已执行 ${centsToDecimalString(r.executed)} 元,超过年度预算 ${centsToDecimalString(r.budget)} 元。`,
        amountCents: r.executed - r.budget, metric: ratioString(r.executed, r.budget), evidence,
      });
    }
    const rate = ratioScaled(r.executed, r.budget);
    if (low && rate !== null && rate < t) {
      hits.push({
        ...base, ruleCode: low.code, level: low.level, title: `${r.code} ${r.name} 预算执行率偏低`,
        description: `${batch.period} 项目预算执行率 ${ratioString(r.executed, r.budget)},低于阈值 ${low.threshold}。`,
        amountCents: r.budget - r.executed, metric: ratioString(r.executed, r.budget), evidence: { ...evidence, threshold: low.threshold },
      });
    }
  }
  return hits;
}

const PLAN_SHEET_NAMES: Record<string, string> = { investment: '投资计划', purchase: '购置计划', maintenance: '运维计划' };

function planHits(db: DB, rules: Map<string, RuleRow>): RiskHit[] {
  const rule = rules.get('PLAN_LOW_EXEC');
  if (!rule) return [];
  const batch = db.prepare('SELECT id, year, actual_period FROM plan_batch WHERE is_current = 1 ORDER BY year DESC, actual_period DESC LIMIT 1').get() as
    { id: number; year: number; actual_period: string } | undefined;
  if (!batch) return [];
  const rows = db.prepare(`SELECT i.id, i.sheet_code, i.item_name, i.item_key, i.project_id, i.org_id, p.code AS project_code,
      (SELECT amount_cents FROM plan_fact WHERE item_id = i.id AND field_key = 'annual_plan') AS plan,
      (SELECT amount_cents FROM plan_fact WHERE item_id = i.id AND field_key = 'annual_actual') AS actual
    FROM plan_item i LEFT JOIN md_project p ON p.id = i.project_id WHERE i.batch_id = ? AND i.item_type = 'detail' ORDER BY i.sheet_code, i.row_no`)
    .safeIntegers(true).all(batch.id) as { id: bigint; sheet_code: string; item_name: string; item_key: string; project_id: bigint | null; org_id: bigint; project_code: string | null; plan: bigint | null; actual: bigint | null }[];
  const t = thresholdScaled(rule, '0.5');
  const hits: RiskHit[] = [];
  for (const r of rows) {
    if (r.plan === null || r.actual === null) continue;
    const rate = ratioScaled(r.actual, r.plan);
    if (rate === null || rate >= t) continue;
    const subject = r.project_id !== null
      ? { subjectType: 'project', subjectId: Number(r.project_id), sub: r.sheet_code === 'investment' ? 'plan_investment' : `plan_${r.sheet_code}_${shortHash(r.item_key)}` }
      : { subjectType: 'org', subjectId: Number(r.org_id), sub: `plan_${r.sheet_code}_${shortHash(r.item_key)}` };
    const rateText = ratioString(r.actual, r.plan);
    hits.push({
      ...subject, ruleCode: rule.code, level: rule.level, orgId: Number(r.org_id), projectId: r.project_id === null ? null : Number(r.project_id),
      title: `${PLAN_SHEET_NAMES[r.sheet_code] ?? r.sheet_code}:${r.project_code ? `${r.project_code} ` : ''}${r.item_name} 执行率偏低`,
      description: `${batch.actual_period} 年度累计实际 ${centsToDecimalString(r.actual)} 元,年度计划 ${centsToDecimalString(r.plan)} 元,执行率 ${rateText},低于阈值 ${rule.threshold}。`,
      amountCents: r.plan - r.actual, metric: rateText,
      evidence: { batchId: batch.id, year: batch.year, actualPeriod: batch.actual_period, itemId: Number(r.id), sheet: r.sheet_code, annualPlan: centsToDecimalString(r.plan), annualActual: centsToDecimalString(r.actual), threshold: rule.threshold },
    });
  }
  return hits;
}

function contractHits(db: DB, rules: Map<string, RuleRow>): RiskHit[] {
  const rule = rules.get('CONTRACT_PAY_OVER_CAP');
  if (!rule) return [];
  const rows = db.prepare(`SELECT id, contract_no, name, org_id, project_id, original_cents, approved_change_cents, paid_cents, payment_cap_ratio_scaled AS cap, stage, version
    FROM ct_contract WHERE status = 'active' AND stage NOT IN ('settlement','archived') AND payment_cap_ratio_scaled IS NOT NULL ORDER BY id`).safeIntegers(true).all() as
    { id: bigint; contract_no: string; name: string; org_id: bigint; project_id: bigint | null; original_cents: bigint; approved_change_cents: bigint; paid_cents: bigint; cap: bigint; stage: string; version: bigint }[];
  const hits: RiskHit[] = [];
  const unit = 10n ** BigInt(RATIO_SCALE);
  for (const r of rows) {
    const current = r.original_cents + r.approved_change_cents;
    if (current <= 0n) continue;
    // 付款比例 > 上限比例 ⇔ paid × 10^6 > cap × current(整数比较,不经舍入)
    if (r.paid_cents * unit <= r.cap * current) continue;
    const capCents = (r.cap * current) / unit;
    const capText = ratioString(r.cap, unit)!;
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

const VERSION_TYPE_OF = (db: DB, versionId: number) =>
  (db.prepare('SELECT version_type FROM ic_version WHERE id = ?').get(versionId) as { version_type: string } | undefined)?.version_type ?? String(versionId);

function investmentControlHits(db: DB, rules: Map<string, RuleRow>): RiskHit[] {
  const over = rules.get('IC_OVER_REDLINE'); const brk = rules.get('IC_CONTROL_BREAK'); const dev = rules.get('IC_DEVIATION_EXCEED');
  if (!over && !brk && !dev) return [];
  const rows = db.prepare(`SELECT c.id, c.project_id, c.summary_json, c.rows_json, c.content_sha256, p.org_id, p.md_project_id, m.code, m.name
    FROM ic_comparison c JOIN ic_project p ON p.id = c.project_id JOIN md_project m ON m.id = p.md_project_id
    WHERE p.status = 'active' AND c.id = (SELECT MAX(id) FROM ic_comparison WHERE project_id = c.project_id) ORDER BY c.project_id`).all() as
    { id: number; project_id: number; summary_json: string; rows_json: string; content_sha256: string; org_id: number; md_project_id: number; code: string; name: string }[];
  const hits: RiskHit[] = [];
  for (const c of rows) {
    const summary = JSON.parse(c.summary_json) as IcComparisonSummaryDto;
    const base = { subjectType: 'ic_project', subjectId: c.project_id, orgId: c.org_id, projectId: c.md_project_id };
    const evidenceBase = { comparisonId: c.id, contentSha256: c.content_sha256 };
    for (const item of summary.controlChain ?? []) {
      const rule = item.status === 'settlement_over_budget' ? brk : over;
      if (!rule) continue;
      const vt = VERSION_TYPE_OF(db, item.subjectVersionId);
      const ref = parseDecimalToCents(item.referenceAmount);
      const diff = parseDecimalToCents(item.subjectAmount) - ref;
      hits.push({
        ...base, ruleCode: rule.code, level: rule.level, sub: `${item.status}_${vt}`,
        title: `${c.code} ${c.name}:${item.message}`,
        description: `${item.message}:${item.subjectAmount} 元 > ${item.referenceAmount} 元(对比快照 #${c.id})。`,
        amountCents: diff, metric: ratioString(diff, ref),
        evidence: { ...evidenceBase, chainStatus: item.status, subjectVersionId: item.subjectVersionId, referenceVersionId: item.referenceVersionId, subjectAmount: item.subjectAmount, referenceAmount: item.referenceAmount },
      });
    }
    if (dev && summary.exceedCount > 0) {
      const exceedRows = (JSON.parse(c.rows_json) as { canonicalCode: string; name: string; deviation: string; deviationRate: string | null; alertLevel: string | null }[])
        .filter((r) => r.alertLevel === 'exceed');
      const amount = exceedRows.reduce((s, r) => s + parseDecimalToCents(r.deviation), 0n);
      hits.push({
        ...base, ruleCode: dev.code, level: dev.level, title: `${c.code} ${c.name}:${summary.exceedCount} 个科目投资偏差超限`,
        description: `对比快照 #${c.id} 中 ${summary.exceedCount} 个科目偏差率超过预警上限:${exceedRows.slice(0, 5).map((r) => `${r.name}(${r.deviationRate ?? '—'})`).join('、')}${exceedRows.length > 5 ? ' 等' : ''}。`,
        amountCents: amount, metric: summary.totalDeviationRate,
        evidence: { ...evidenceBase, exceedCount: summary.exceedCount, items: exceedRows.slice(0, 20).map((r) => ({ code: r.canonicalCode, name: r.name, deviation: r.deviation, rate: r.deviationRate })) },
      });
    }
  }
  return hits;
}

function feasibilityHits(db: DB, rules: Map<string, RuleRow>): RiskHit[] {
  if (![...rules.values()].some((r) => r.source === 'feasibility')) return [];
  const rows = db.prepare(`SELECT r.id AS run_id, r.parameter_hash, r.result_json, s.id AS scenario_id, s.name AS scenario_name, p.code, p.name, p.org_id, p.md_project_id
    FROM if_run r JOIN if_scenario s ON s.id = r.scenario_id JOIN if_project p ON p.id = s.project_id
    WHERE p.status = 'active' AND r.id = (SELECT MAX(id) FROM if_run WHERE scenario_id = s.id AND kind = 'base') AND r.status = 'succeeded' ORDER BY s.id`).all() as
    { run_id: number; parameter_hash: string; result_json: string; scenario_id: number; scenario_name: string; code: string; name: string; org_id: number; md_project_id: number | null }[];
  const hits: RiskHit[] = [];
  for (const r of rows) {
    for (const h of feasibilityRiskHits(JSON.parse(r.result_json) as FeasResultDto)) {
      if (!rules.has(h.code)) continue;
      hits.push({
        ruleCode: h.code, level: h.level, subjectType: 'if_scenario', subjectId: r.scenario_id, sub: h.sub, orgId: r.org_id, projectId: r.md_project_id,
        title: `${r.code} ${r.name} / ${r.scenario_name}:${h.title}`, description: h.description, amountCents: null, metric: h.metric,
        evidence: { ...h.evidence, runId: r.run_id, parameterHash: r.parameter_hash },
      });
    }
  }
  return hits;
}

/** 按启用规则计算全部命中(不写库)。 */
export function computeRiskHits(db: DB): RiskHit[] {
  const rules = new Map((db.prepare('SELECT * FROM risk_rule WHERE enabled = 1').all() as RuleRow[]).map((r) => [r.code, r]));
  const hits = [
    ...projectBudgetHits(db, rules), ...planHits(db, rules), ...contractHits(db, rules), ...investmentControlHits(db, rules), ...feasibilityHits(db, rules),
  ];
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
  return { ...eventDto(r), actions, allowed: allowedCommands(db, r) };
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
