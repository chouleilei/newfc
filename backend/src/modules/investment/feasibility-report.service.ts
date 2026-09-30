/**
 * 投资可行性报告(T-7,AC-F12,对应 lishui `/investment-feasibility/reports`)。
 *
 * - 由方案最新一次成功基准运行生成,且运行参数须与方案当前参数一致(否则先重算);正文为确定性模板 + 可选模型改写,
 *   模型调用在事务外。正文与依据运行生成后不可改,需要修改请重新生成。
 * - 草稿 → 提交复核(investment:write)→ 通过/退回(investment:review);提交人 ≠ 复核人,管理员同人复核须写例外原因;
 *   退回可重新提交;通过后冻结。报告存在即作为证据,方案不能删除。
 * - 列表与详情按项目组织范围裁剪,范围外 404。
 */
import type { DB } from '../../db/connection';
import { AppError } from '../../core/errors';
import { currentAuth } from '../../core/request-context';
import { fx, FX_ZERO, sub, toFixed } from '../../core/fixed';
import { writeLog } from '../audit/log';
import { currentOrgScope, notVisible, orgInScope, requirePermission, scopeFilterSql } from '../security/scope';
import { assertDistinctReviewer } from '../security/review';
import { rewriteTemplateNarrative } from '../../assistant/narrative';
import { FEASIBILITY_REPORT_REWRITE_TASK, PROMPT_VERSION } from '../../assistant/prompts';
import { feasibilityReportAiEnabled } from '../../assistant/feature-flags';
import type { FeasibilityAssumptions, FeasReportDto, FeasReportStatus, FeasResultDto, FeasSensitivityItemDto } from '../../contracts/investment-feasibility';
import {
  assertActiveProject, currentParameterHash, latestBaseRun, orgName, userName, visibleScenario, type FeasProjectRow, type RunRow, type ScenarioRow,
} from './feasibility.service';

const nowIso = () => new Date().toISOString();
const conflict = (code: string, message: string, details?: unknown) => new AppError(code, message, 409, undefined, details);

interface ReportRow {
  id: number; scenario_id: number; run_id: number; title: string; content: string; source: 'template' | 'model'; model: string; prompt_version: string;
  status: FeasReportStatus; submitted_by_user_id: number | null; submitted_at: string | null; reviewer_user_id: number | null; reviewed_at: string | null;
  review_comment: string | null; exception_reason: string | null; self_review: number; version: number;
  created_by_user_id: number | null; created_at: string; updated_at: string;
}

function reportDto(db: DB, r: ReportRow): FeasReportDto {
  const s = db.prepare('SELECT * FROM if_scenario WHERE id = ?').get(r.scenario_id) as ScenarioRow;
  const p = db.prepare('SELECT * FROM if_project WHERE id = ?').get(s.project_id) as FeasProjectRow;
  const run = db.prepare('SELECT parameter_hash FROM if_run WHERE id = ?').get(r.run_id) as { parameter_hash: string };
  return {
    id: r.id, scenarioId: s.id, scenarioCode: s.code, scenarioName: s.name, projectId: p.id, projectCode: p.code, projectName: p.name, orgName: orgName(db, p.org_id),
    runId: r.run_id, parameterHash: run.parameter_hash, title: r.title, content: r.content, source: r.source, model: r.model, promptVersion: r.prompt_version,
    status: r.status, submittedBy: userName(db, r.submitted_by_user_id), submittedAt: r.submitted_at,
    reviewer: userName(db, r.reviewer_user_id), reviewedAt: r.reviewed_at, reviewComment: r.review_comment, exceptionReason: r.exception_reason, selfReview: r.self_review === 1,
    stale: !s.deleted_at && run.parameter_hash !== currentParameterHash(p, JSON.parse(s.assumptions_json) as FeasibilityAssumptions),
    version: r.version, createdBy: userName(db, r.created_by_user_id), createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

function visibleReport(db: DB, id: number): ReportRow {
  const r = db.prepare('SELECT * FROM if_report WHERE id = ?').get(id) as ReportRow | undefined;
  if (!r) throw notVisible('可行性报告');
  const orgId = (db.prepare('SELECT p.org_id FROM if_scenario s JOIN if_project p ON p.id = s.project_id WHERE s.id = ?').get(r.scenario_id) as { org_id: number }).org_id;
  if (!orgInScope(currentOrgScope(db), orgId)) throw notVisible('可行性报告');
  return r;
}

export function getFeasReport(db: DB, id: number): FeasReportDto {
  return reportDto(db, visibleReport(db, id));
}

export function listFeasReports(db: DB, q: { status?: FeasReportStatus; projectId?: number; scenarioId?: number }): { items: FeasReportDto[] } {
  const f = scopeFilterSql(currentOrgScope(db), 'p.org_id');
  const where = [f.sql];
  const params: unknown[] = [...f.params];
  if (q.status) { where.push('r.status = ?'); params.push(q.status); }
  if (q.projectId) { where.push('p.id = ?'); params.push(q.projectId); }
  if (q.scenarioId) { where.push('r.scenario_id = ?'); params.push(q.scenarioId); }
  const rows = db.prepare(`SELECT r.* FROM if_report r JOIN if_scenario s ON s.id = r.scenario_id JOIN if_project p ON p.id = s.project_id
    WHERE ${where.join(' AND ')} ORDER BY r.id DESC LIMIT 500`).all(...params) as ReportRow[];
  return { items: rows.map((r) => reportDto(db, r)) };
}

/* ---------------- 生成 ---------------- */

const trimNum = (v: string) => (v.includes('.') ? v.replace(/0+$/, '').replace(/\.$/, '') : v);
const SENS_LABEL: Record<string, string> = {
  electricity_price: '电价', power_generation: '发电量', operating_cost: '经营成本', construction_investment: '建设投资',
  construction_delay: '建设期延长', loan_interest_rate: '贷款利率', opening_input_vat_credit: '期初进项税留抵',
};
function changeText(mode: string, change: string): string {
  const v = fx(change);
  const sign = v > FX_ZERO ? '+' : v < FX_ZERO ? '-' : '';
  const abs = v < FX_ZERO ? toFixed(sub(FX_ZERO, v), 6) : toFixed(v, 6);
  if (mode === 'year_delta') return `${sign}${trimNum(abs)} 年`;
  if (mode === 'percentage_point') return `${sign}${trimNum(toFixed(fx(abs) * 100n, 4))} 个百分点`;
  return `${sign}${trimNum(toFixed(fx(abs) * 100n, 4))}%`;
}

/** 确定性草稿:项目概况、测算依据、主要指标、模型检查、敏感性(参数一致的最新敏感性运行)、结论提示。 */
export function feasReportTemplate(db: DB, project: FeasProjectRow, scenario: ScenarioRow, run: RunRow, title: string): { text: string; factTerms: string[] } {
  const result = JSON.parse(run.result_json!) as FeasResultDto;
  const md = project.md_project_id == null ? null : db.prepare('SELECT code, name FROM md_project WHERE id = ?').get(project.md_project_id) as { code: string; name: string } | undefined;
  const lines = [
    `# ${title}`,
    '## 一、项目概况',
    `- 项目:${project.code} ${project.name}(${orgName(db, project.org_id)})${md ? `,对应主数据项目 ${md.code} ${md.name}` : ''}`,
    `- 建设起年 ${project.construction_start_year},运营起年 ${project.operation_start_year},计算期 ${project.horizon_years} 年`,
    '## 二、测算依据',
    `- 方案:${scenario.code} ${scenario.name}${scenario.is_baseline === 1 ? '(基准方案)' : ''}`,
    `- 测算运行 #${run.id},模型 ${result.modelVersion},参数指纹 ${run.parameter_hash.slice(0, 12)},测算时间 ${run.created_at.slice(0, 10)}`,
    '## 三、主要指标',
  ];
  for (const i of result.indicators) {
    const v = i.status === 'no_solution' || i.value == null ? '无解' : `${trimNum(i.value)}${i.unit ? ` ${i.unit}` : ''}`;
    lines.push(`- ${i.name}:${v}${i.status === 'warning' ? '(预警)' : ''}`);
  }
  lines.push('## 四、模型检查');
  const failed = result.checks.filter((c) => !c.passed);
  if (!failed.length) lines.push(`- ${result.checks.length} 项检查全部通过`);
  else for (const c of failed) lines.push(`- 未通过(${c.severity === 'error' ? '错误' : '提示'}):${c.message}`);

  lines.push('## 五、敏感性分析');
  const sens = db.prepare("SELECT * FROM if_run WHERE scenario_id = ? AND kind = 'sensitivity' AND status = 'succeeded' AND parameter_hash = ? ORDER BY id DESC LIMIT 1")
    .get(scenario.id, run.parameter_hash) as RunRow | undefined;
  if (!sens) lines.push('- 尚未执行与本次测算参数一致的敏感性分析');
  else {
    const items = (JSON.parse(sens.result_json!) as { items: FeasSensitivityItemDto[] }).items;
    const npv = items.flatMap((it) => {
      const d = it.status === 'ok' ? it.indicators.find((x) => x.code === 'project_npv')?.delta : null;
      return d == null ? [] : [{ it, d: fx(d) }];
    }).sort((a, b) => ((b.d < FX_ZERO ? -b.d : b.d) > (a.d < FX_ZERO ? -a.d : a.d) ? 1 : -1));
    lines.push(`- 依据敏感性运行 #${sens.id},按项目净现值变动绝对值排序:`);
    for (const { it, d } of npv.slice(0, 6)) {
      const dir = d > FX_ZERO ? '增加' : d < FX_ZERO ? '减少' : '不变';
      lines.push(`  - ${SENS_LABEL[it.code] ?? it.code} ${changeText(it.mode, it.change)}:项目净现值${dir} ${trimNum(toFixed(d < FX_ZERO ? -d : d, 6))} 万元`);
    }
    const bad = items.filter((it) => it.status === 'failed');
    if (bad.length) lines.push(`- ${bad.length} 项变动测算失败:${bad.map((b) => SENS_LABEL[b.code] ?? b.code).join('、')}`);
  }

  lines.push('## 六、结论提示');
  const by = new Map(result.indicators.map((i) => [i.code, i]));
  const npvInd = by.get('project_npv');
  if (npvInd?.value != null) lines.push(fx(npvInd.value) >= FX_ZERO ? '- 项目净现值非负,在当前假设下项目层面财务可行' : '- 项目净现值为负,在当前假设下项目层面财务不可行');
  if (by.get('project_irr')?.status === 'no_solution') lines.push('- 项目内部收益率无解,需结合现金流符号变化复核');
  const dscr = by.get('min_dscr');
  if (dscr?.status === 'warning') lines.push('- 最低偿债覆盖率低于门槛,存在偿债压力');
  if (failed.length) lines.push('- 存在未通过的模型检查,结论须在修正后重新测算');
  lines.push('- 本报告由冻结测算结果确定性生成,正式使用须经复核通过');
  const factTerms = [project.code, project.name, scenario.code, scenario.name, ...result.indicators.map((i) => i.name)];
  return { text: lines.join('\n'), factTerms };
}

export async function createFeasReport(db: DB, scenarioId: number, input: { title?: string }): Promise<FeasReportDto> {
  const { scenario, project } = visibleScenario(db, scenarioId);
  assertActiveProject(project);
  const run = latestBaseRun(db, scenarioId);
  const hash = currentParameterHash(project, JSON.parse(scenario.assumptions_json) as FeasibilityAssumptions);
  if (!run || run.status !== 'succeeded' || !run.result_json) throw conflict('FEAS_STATE', '方案还没有成功的测算结果,请先测算');
  if (run.parameter_hash !== hash) throw conflict('FEAS_STATE', '方案参数已修改,请先重新测算再生成报告');
  const title = input.title?.trim() || `${project.name}-${scenario.name}投资可行性分析报告`;
  const tpl = feasReportTemplate(db, project, scenario, run, title);
  const rewrite = await rewriteTemplateNarrative({
    enabled: feasibilityReportAiEnabled(), promptVersion: PROMPT_VERSION.feasibilityReport, task: FEASIBILITY_REPORT_REWRITE_TASK,
    template: tpl.text, factTerms: tpl.factTerms, maxChars: 12000,
  });
  const id = db.transaction(() => {
    visibleScenario(db, scenarioId); // 生成期间被删除则 404
    const now = nowIso();
    const rid = Number(db.prepare(`INSERT INTO if_report (scenario_id, run_id, title, content, source, model, prompt_version, created_by_user_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(scenarioId, run.id, title, rewrite.text, rewrite.source, rewrite.model, rewrite.promptVersion,
      currentAuth()?.userId ?? null, now, now).lastInsertRowid);
    writeLog(db, 'investment.feasibility.report.create', 'if_report', rid, { scenarioId, runId: run.id, source: rewrite.source, guardFailed: !!rewrite.guardFailure });
    return rid;
  }).immediate();
  return getFeasReport(db, id);
}

/* ---------------- 提交与复核 ---------------- */

export function submitFeasReport(db: DB, id: number, expectedVersion: number): FeasReportDto {
  const auth = requirePermission(currentAuth(), 'investment:write');
  db.transaction(() => {
    const r = visibleReport(db, id);
    if (r.version !== expectedVersion) throw conflict('VERSION_CONFLICT', '报告已被其他人修改,请刷新后重试', { currentVersion: r.version });
    if (r.status !== 'draft' && r.status !== 'returned') throw conflict('FEAS_REPORT_STATE', '只有草稿或已退回的报告可以提交复核');
    db.prepare(`UPDATE if_report SET status = 'pending_review', submitted_by_user_id = ?, submitted_at = ?, reviewer_user_id = NULL, reviewed_at = NULL,
      review_comment = NULL, exception_reason = NULL, self_review = 0, version = version + 1, updated_at = ? WHERE id = ?`).run(auth.userId, nowIso(), nowIso(), id);
    writeLog(db, 'investment.feasibility.report.submit', 'if_report', id, { from: r.status });
  }).immediate();
  return getFeasReport(db, id);
}

export function reviewFeasReport(db: DB, id: number, input: { expectedVersion: number; decision: 'approve' | 'return'; comment?: string; exceptionReason?: string }): FeasReportDto {
  const auth = requirePermission(currentAuth(), 'investment:review');
  db.transaction(() => {
    const r = visibleReport(db, id);
    if (r.version !== input.expectedVersion) throw conflict('VERSION_CONFLICT', '报告已被其他人修改,请刷新后重试', { currentVersion: r.version });
    if (r.status !== 'pending_review') throw conflict('FEAS_REPORT_STATE', '只有待复核的报告可以复核');
    const { selfReview } = assertDistinctReviewer(db, auth, r.submitted_by_user_id, input.exceptionReason, '可行性报告');
    const now = nowIso();
    db.prepare(`UPDATE if_report SET status = ?, reviewer_user_id = ?, reviewed_at = ?, review_comment = ?, exception_reason = ?, self_review = ?,
      version = version + 1, updated_at = ? WHERE id = ?`).run(input.decision === 'approve' ? 'approved' : 'returned', auth.userId, now,
      input.comment?.trim() || null, selfReview ? input.exceptionReason!.trim() : null, selfReview ? 1 : 0, now, id);
    writeLog(db, 'investment.feasibility.report.review', 'if_report', id, { decision: input.decision, selfReview, runId: r.run_id });
  }).immediate();
  return getFeasReport(db, id);
}
