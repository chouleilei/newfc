/**
 * 风险与投资专题(AC-F18):确定性组稿。事实全部来自风险台账、投资控制最新对比快照与可行性最新基准运行,
 * 按组织范围(含下级)取数;模型只改写叙述,不改数字。
 */
import type { DB } from '../../db/connection';
import { centsToDecimalString, parseDecimalToCents } from '../../core/decimal';
import { currentOrgScope, scopeFilterSql } from '../security/scope';
import { listRiskEvents, riskSummary } from '../risk/risk.service';
import { RISK_LEVEL_LABELS, RISK_STATUS_LABELS } from '../../contracts/risk';
import type { IcComparisonSummaryDto } from '../../contracts/investment-control';
import type { FeasResultDto } from '../../contracts/investment-feasibility';

export interface DraftSection { key: string; title: string; bullets: string[]; data: unknown; citations: { source: string; asOf: string; [k: string]: unknown }[] }
export interface RiskInvestmentDraft { title: string; sections: DraftSection[]; factTerms: string[] }

const subtreeSql = (col: string) => `${col} IN (WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT o.id FROM org o JOIN sub ON o.parent_id = sub.id) SELECT id FROM sub)`;
const wan = (yuan: string) => {
  const cents = parseDecimalToCents(yuan);
  const neg = cents < 0n; const abs = neg ? -cents : cents;
  const w = (abs + 50n) / 100n; // 元,四舍五入
  const s = `${w / 10000n}.${String((w % 10000n) / 100n).padStart(2, '0')}`;
  return `${neg ? '-' : ''}${s}`;
};

export function riskInvestmentDraft(db: DB, input: { orgId: number | null; orgName: string; year: number | null }): RiskInvestmentDraft {
  const asOf = new Date().toISOString();
  const scope = currentOrgScope(db);
  const orgFilter = (col: string) => {
    const sc = scopeFilterSql(scope, col);
    const where = [sc.sql]; const params: unknown[] = [...sc.params];
    if (input.orgId) { where.push(subtreeSql(col)); params.push(input.orgId); }
    return { sql: where.join(' AND '), params };
  };
  const sections: DraftSection[] = [];
  const terms = new Set<string>([input.orgName]);

  // 一、风险概况
  const sum = riskSummary(db, input.orgId ? { orgId: input.orgId } : {});
  sections.push({
    key: 'risk_overview', title: '一、风险概况',
    bullets: [
      `风险台账共 ${sum.total} 条,未关闭 ${sum.openCount} 条,未关闭风险涉及金额 ${wan(sum.openAmount)} 万元。`,
      `未关闭风险按等级:高 ${sum.byLevel.high} 条、中 ${sum.byLevel.medium} 条、低 ${sum.byLevel.low} 条;待确认 ${sum.pendingConfirm} 条,待复核 ${sum.pendingReview} 条,逾期 ${sum.overdue} 条。`,
      ...(sum.byRule.length ? [`未关闭风险主要来自:${sum.byRule.slice(0, 5).map((r) => `${r.ruleName} ${r.count} 条`).join(';')}。`] : ['当前没有未关闭风险。']),
    ],
    data: sum, citations: [{ source: 'risk_event', asOf }],
  });
  for (const r of sum.byRule) terms.add(r.ruleName);

  // 二、重点风险(未关闭高等级,最多 10 条)
  const top = listRiskEvents(db, { open: '1', level: 'high', ...(input.orgId ? { orgId: input.orgId } : {}) }).slice(0, 10);
  sections.push({
    key: 'risk_top', title: '二、重点风险',
    bullets: top.length
      ? top.map((e) => `${e.title}(${RISK_LEVEL_LABELS[e.level]}风险,${RISK_STATUS_LABELS[e.status]}${e.amount ? `,涉及 ${wan(e.amount)} 万元` : ''}${e.deadline ? `,整改期限 ${e.deadline}` : ''}${e.overdue ? ',已逾期' : ''})。`)
      : ['没有未关闭的高等级风险。'],
    data: top.map((e) => ({ id: e.id, eventKey: e.eventKey, title: e.title, status: e.status, amount: e.amount, deadline: e.deadline, version: e.version })),
    citations: top.map((e) => ({ source: 'risk_event', asOf, riskEventId: e.id, version: e.version })),
  });
  for (const e of top) terms.add(e.title);

  // 三、投资控制超限
  const f = orgFilter('p.org_id');
  const cmps = db.prepare(`SELECT c.id, c.summary_json, c.content_sha256, m.code, m.name FROM ic_comparison c JOIN ic_project p ON p.id = c.project_id JOIN md_project m ON m.id = p.md_project_id
    WHERE p.status = 'active' AND c.id = (SELECT MAX(id) FROM ic_comparison WHERE project_id = c.project_id) AND ${f.sql} ORDER BY m.code`).all(...f.params) as
    { id: number; summary_json: string; content_sha256: string; code: string; name: string }[];
  let devSum = 0n; let baseSum = 0n;
  const icBullets: string[] = [];
  const icData = cmps.map((c) => {
    const s = JSON.parse(c.summary_json) as IcComparisonSummaryDto;
    devSum += parseDecimalToCents(s.totalDeviation); baseSum += parseDecimalToCents(s.baseTotalStatic);
    if (s.exceedCount > 0 || s.controlChain.length) {
      icBullets.push(`${c.code} ${c.name}:静态投资偏差 ${wan(s.totalDeviation)} 万元,偏差率 ${s.totalDeviationRate ?? '不可计算'},超限科目 ${s.exceedCount} 个${s.controlChain.length ? `;${s.controlChain.map((x) => x.message).join('、')}` : ''}。`);
      terms.add(c.name);
    }
    return { comparisonId: c.id, project: `${c.code} ${c.name}`, totalDeviation: s.totalDeviation, totalDeviationRate: s.totalDeviationRate, exceedCount: s.exceedCount, chain: s.controlChain.map((x) => x.status), contentSha256: c.content_sha256 };
  });
  sections.push({
    key: 'investment_control', title: '三、投资控制超限',
    bullets: [
      `纳入统计的投资控制项目 ${cmps.length} 个(各取最新对比快照),静态投资偏差合计 ${wan(centsToDecimalString(devSum))} 万元,基准合计 ${wan(centsToDecimalString(baseSum))} 万元。`,
      ...(icBullets.length ? icBullets : ['各项目最新对比快照均未出现超限科目或控制链突破。']),
    ],
    data: icData, citations: cmps.map((c) => ({ source: 'ic_comparison', asOf, comparisonId: c.id, contentSha256: c.content_sha256 })),
  });

  // 四、可行性指标
  const g = orgFilter('p.org_id');
  const runs = db.prepare(`SELECT r.id, r.parameter_hash, r.result_json, r.all_checks_passed, s.name AS scenario, p.code, p.name FROM if_run r
    JOIN if_scenario s ON s.id = r.scenario_id JOIN if_project p ON p.id = s.project_id
    WHERE p.status = 'active' AND r.id = (SELECT MAX(id) FROM if_run WHERE scenario_id = s.id AND kind = 'base') AND r.status = 'succeeded' AND ${g.sql} ORDER BY p.code, s.id`).all(...g.params) as
    { id: number; parameter_hash: string; result_json: string; all_checks_passed: number | null; scenario: string; code: string; name: string }[];
  const feasData = runs.map((r) => {
    const res = JSON.parse(r.result_json) as FeasResultDto;
    const ind = new Map(res.indicators.map((i) => [i.code, i.value]));
    return { runId: r.id, project: `${r.code} ${r.name}`, scenario: r.scenario, projectNpv: ind.get('project_npv') ?? null, projectIrr: ind.get('project_irr') ?? null, minDscr: ind.get('min_dscr') ?? null, allChecksPassed: r.all_checks_passed === 1, parameterHash: r.parameter_hash };
  });
  for (const r of runs) { terms.add(r.name); terms.add(r.scenario); }
  sections.push({
    key: 'feasibility', title: '四、可行性指标',
    bullets: feasData.length
      ? feasData.map((d) => `${d.project} / ${d.scenario}:项目净现值 ${d.projectNpv ?? '—'} 万元,项目内部收益率 ${d.projectIrr ?? '无解'},最低偿债覆盖率 ${d.minDscr ?? '—'},模型检查${d.allChecksPassed ? '全部通过' : '未全部通过'}。`)
      : ['范围内没有成功的可行性基准测算。'],
    data: feasData, citations: runs.map((r) => ({ source: 'if_run', asOf, runId: r.id, parameterHash: r.parameter_hash })),
  });
  const title = `${input.year ? `${input.year} 年` : ''}风险与投资专题 · ${input.orgName}`;
  return { title, sections, factTerms: [...terms].filter((t) => t && t.length >= 2) };
}
