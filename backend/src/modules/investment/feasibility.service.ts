/**
 * 投资可行性测算(AC-F12)。规则见 specs/implementation.md T-5「投资可行性测算」。
 *
 * - 项目按 org_id 裁剪范围,范围外 404;关联主数据项目时组织取主数据。
 * - 方案输入为 standard-1.0 JSON(契约校验后规范化);修改需期望版本号。
 * - 测算在事务外计算,再在短事务里写入冻结的运行记录(输入、hash、结果);运行不可修改/删除。
 * - 方案当前 hash(项目年份 + 输入)与最新运行不同即“结果需重算”。
 * - 敏感性分析作为后台任务执行(重任务并发 1),结果冻结为 sensitivity 运行。
 * - T-7:每项目至多一个基准方案;方案软删除(已有可行性报告的方案不能删除),删除后与不存在同为 404,运行记录保留。
 */
import type { DB } from '../../db/connection';
import { AppError, Errors, type RowError } from '../../core/errors';
import { currentAuth } from '../../core/request-context';
import { canonicalHash } from '../../core/canonical';
import { writeLog } from '../audit/log';
import { currentOrgScope, notVisible, orgInScope, scopeFilterSql } from '../security/scope';
import { submitJob, type JobHandle } from '../jobs/job.service';
import { fx, sub, toFixed } from '../../core/fixed';
import {
  feasibilityAssumptions, SENSITIVITY_CODES, type FeasibilityAssumptions, type FeasResultDto, type FeasSensitivityItemDto, type SensitivityCode,
} from '../../contracts/investment-feasibility';
import { applySensitivity, calculateFeasibility, FeasCalcError, MODEL_VERSION, type FeasProjectYears } from './feasibility-calc';
import { feasibilityResultBuffer, feasibilityTemplateBuffer, parseFeasibilityTemplate } from './feasibility-template';
import { storeFile, type ObjectStore } from '../files/object-store';

const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

const nowIso = () => new Date().toISOString();
const conflict = (code: string, message: string, details?: unknown) => new AppError(code, message, 409, undefined, details);

export interface FeasProjectRow {
  id: number; code: string; name: string; org_id: number; md_project_id: number | null; description: string;
  construction_start_year: number; operation_start_year: number; horizon_years: number; status: 'active' | 'archived'; version: number;
  created_by_user_id: number | null; created_at: string; updated_at: string;
}
export interface ScenarioRow {
  id: number; project_id: number; code: string; name: string; assumptions_json: string; assumptions_hash: string;
  source_file_object_id: number | null; source_file_name: string | null; version: number; created_by_user_id: number | null; created_at: string; updated_at: string;
  is_baseline: number; deleted_at: string | null; deleted_by_user_id: number | null;
}
export interface RunRow {
  id: number; scenario_id: number; kind: 'base' | 'sensitivity'; scenario_version: number; project_years_json: string; assumptions_json: string; parameter_hash: string;
  model_version: string; status: 'succeeded' | 'failed'; all_checks_passed: number | null; result_json: string | null; error_message: string | null;
  created_by_user_id: number | null; created_at: string;
}

export const userName = (db: DB, id: number | null): string | null =>
  id == null ? null : ((db.prepare('SELECT COALESCE(NULLIF(display_name, \'\'), username) AS n FROM app_user WHERE id = ?').get(id) as { n: string } | undefined)?.n ?? null);

export function visibleFeasProject(db: DB, id: number): FeasProjectRow {
  const row = db.prepare('SELECT * FROM if_project WHERE id = ?').get(id) as FeasProjectRow | undefined;
  if (!row || !orgInScope(currentOrgScope(db), row.org_id)) throw notVisible('可行性项目');
  return row;
}
export function visibleScenario(db: DB, id: number): { scenario: ScenarioRow; project: FeasProjectRow } {
  const scenario = db.prepare('SELECT * FROM if_scenario WHERE id = ?').get(id) as ScenarioRow | undefined;
  if (!scenario || scenario.deleted_at) throw notVisible('测算方案');
  const project = db.prepare('SELECT * FROM if_project WHERE id = ?').get(scenario.project_id) as FeasProjectRow;
  if (!orgInScope(currentOrgScope(db), project.org_id)) throw notVisible('测算方案');
  return { scenario, project };
}
export function assertActiveProject(p: FeasProjectRow): void {
  if (p.status !== 'active') throw conflict('FEAS_STATE', '项目已归档,不能修改方案或测算');
}

export const projectYears = (p: Pick<FeasProjectRow, 'construction_start_year' | 'operation_start_year'>): FeasProjectYears =>
  ({ construction_start_year: p.construction_start_year, operation_start_year: p.operation_start_year });
/** 方案当前参数 hash:与计算结果 parameterHash 同口径(项目年份 + 规范化输入)。 */
export const currentParameterHash = (p: FeasProjectRow, a: FeasibilityAssumptions) => canonicalHash({ project: projectYears(p), assumptions: a });

export function orgName(db: DB, id: number): string {
  return (db.prepare('SELECT name FROM org WHERE id = ?').get(id) as { name: string } | undefined)?.name ?? '';
}

function toProjectDto(db: DB, p: FeasProjectRow) {
  const md = p.md_project_id == null ? null : db.prepare('SELECT code, name FROM md_project WHERE id = ?').get(p.md_project_id) as { code: string; name: string } | undefined;
  const scenarioCount = (db.prepare('SELECT COUNT(*) AS n FROM if_scenario WHERE project_id = ? AND deleted_at IS NULL').get(p.id) as { n: number }).n;
  return {
    id: p.id, code: p.code, name: p.name, orgId: p.org_id, orgName: orgName(db, p.org_id), mdProjectId: p.md_project_id, mdProjectCode: md?.code ?? null,
    description: p.description, constructionStartYear: p.construction_start_year, operationStartYear: p.operation_start_year, horizonYears: p.horizon_years,
    status: p.status, version: p.version, scenarioCount, createdAt: p.created_at, updatedAt: p.updated_at,
  };
}

function runSummary(db: DB, r: RunRow) {
  const result = r.result_json ? JSON.parse(r.result_json) : null;
  return {
    id: r.id, scenarioId: r.scenario_id, kind: r.kind, status: r.status, parameterHash: r.parameter_hash, modelVersion: r.model_version,
    scenarioVersion: r.scenario_version, allChecksPassed: r.all_checks_passed == null ? null : r.all_checks_passed === 1,
    indicators: r.kind === 'base' && result ? (result as FeasResultDto).indicators : null,
    errorMessage: r.error_message, createdAt: r.created_at, createdBy: userName(db, r.created_by_user_id),
  };
}

export function latestBaseRun(db: DB, scenarioId: number): RunRow | undefined {
  return db.prepare("SELECT * FROM if_run WHERE scenario_id = ? AND kind = 'base' ORDER BY id DESC LIMIT 1").get(scenarioId) as RunRow | undefined;
}

function toScenarioDto(db: DB, s: ScenarioRow, p: FeasProjectRow) {
  const assumptions = JSON.parse(s.assumptions_json) as FeasibilityAssumptions;
  const latest = latestBaseRun(db, s.id);
  const hash = currentParameterHash(p, assumptions);
  return {
    id: s.id, projectId: s.project_id, code: s.code, name: s.name, assumptions, parameterHash: hash, sourceFileName: s.source_file_name,
    isBaseline: s.is_baseline === 1,
    reportCount: (db.prepare('SELECT COUNT(*) AS n FROM if_report WHERE scenario_id = ?').get(s.id) as { n: number }).n,
    version: s.version, createdAt: s.created_at, updatedAt: s.updated_at,
    latestRun: latest ? runSummary(db, latest) : null,
    /** 最新运行的参数与当前不同(或尚未测算):页面提示“参数已修改,结果需重算” */
    stale: !latest || latest.status !== 'succeeded' || latest.parameter_hash !== hash,
  };
}

// ---------------- 项目 ----------------

export function listFeasProjects(db: DB, q: { orgId?: number; status?: 'active' | 'archived'; keyword?: string }) {
  const scope = currentOrgScope(db);
  const f = scopeFilterSql(scope, 'p.org_id');
  const where = [f.sql];
  const params: unknown[] = [...f.params];
  if (q.orgId) { where.push('p.org_id = ?'); params.push(q.orgId); }
  if (q.status) { where.push('p.status = ?'); params.push(q.status); }
  if (q.keyword) { where.push('(p.code LIKE ? OR p.name LIKE ?)'); params.push(`%${q.keyword}%`, `%${q.keyword}%`); }
  const rows = db.prepare(`SELECT p.* FROM if_project p WHERE ${where.join(' AND ')} ORDER BY p.id DESC LIMIT 500`).all(...params) as FeasProjectRow[];
  return { items: rows.map((r) => toProjectDto(db, r)) };
}

function assertMdProject(db: DB, mdProjectId: number, orgId: number): void {
  const p = db.prepare('SELECT org_id, status FROM md_project WHERE id = ?').get(mdProjectId) as { org_id: number; status: string } | undefined;
  if (!p || !orgInScope(currentOrgScope(db), p.org_id)) throw notVisible('项目');
  if (p.status !== 'active') throw Errors.validation('主数据项目已停用');
  if (p.org_id !== orgId) throw Errors.validation('组织须与主数据项目归属组织一致');
}

export function createFeasProject(db: DB, input: {
  code: string; name: string; orgId: number; mdProjectId?: number | null; description?: string;
  constructionStartYear: number; operationStartYear: number; horizonYears: number;
}) {
  if (!orgInScope(currentOrgScope(db), input.orgId)) throw notVisible('组织');
  if (input.mdProjectId) assertMdProject(db, input.mdProjectId, input.orgId);
  const now = nowIso();
  return db.transaction(() => {
    if (db.prepare('SELECT 1 FROM if_project WHERE code = ?').get(input.code)) throw conflict('DUPLICATE', `项目编码 ${input.code} 已存在`);
    const id = Number(db.prepare(`INSERT INTO if_project (code, name, org_id, md_project_id, description, construction_start_year, operation_start_year, horizon_years,
      created_by_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      input.code, input.name, input.orgId, input.mdProjectId ?? null, input.description ?? '', input.constructionStartYear, input.operationStartYear,
      input.horizonYears, currentAuth()?.userId ?? null, now, now,
    ).lastInsertRowid);
    writeLog(db, 'investment.feasibility.project.create', 'if_project', id, { code: input.code, orgId: input.orgId });
    return getFeasProject(db, id);
  })();
}

export function updateFeasProject(db: DB, id: number, input: {
  expectedVersion: number; name?: string; description?: string; constructionStartYear?: number; operationStartYear?: number; horizonYears?: number; status?: 'active' | 'archived';
}) {
  return db.transaction(() => {
    const p = visibleFeasProject(db, id);
    if (p.version !== input.expectedVersion) throw conflict('VERSION_CONFLICT', '项目已被其他人修改,请刷新后重试', { currentVersion: p.version });
    if (p.status === 'archived' && input.status !== 'active') throw conflict('FEAS_STATE', '项目已归档,只能恢复');
    const next = {
      name: input.name ?? p.name, description: input.description ?? p.description,
      cs: input.constructionStartYear ?? p.construction_start_year, os: input.operationStartYear ?? p.operation_start_year,
      hy: input.horizonYears ?? p.horizon_years, status: input.status ?? p.status,
    };
    if (next.os <= next.cs) throw Errors.validation('运营起年必须晚于建设起年');
    db.prepare(`UPDATE if_project SET name = ?, description = ?, construction_start_year = ?, operation_start_year = ?, horizon_years = ?, status = ?,
      version = version + 1, updated_at = ? WHERE id = ?`).run(next.name, next.description, next.cs, next.os, next.hy, next.status, nowIso(), id);
    writeLog(db, 'investment.feasibility.project.update', 'if_project', id, { before: { status: p.status, cs: p.construction_start_year, os: p.operation_start_year }, after: next });
    return getFeasProject(db, id);
  }).immediate();
}

export function getFeasProject(db: DB, id: number) {
  const p = visibleFeasProject(db, id);
  const scenarios = db.prepare('SELECT * FROM if_scenario WHERE project_id = ? AND deleted_at IS NULL ORDER BY is_baseline DESC, id').all(id) as ScenarioRow[];
  return { ...toProjectDto(db, p), scenarios: scenarios.map((s) => toScenarioDto(db, s, p)) };
}

// ---------------- 方案 ----------------

function insertScenario(db: DB, projectId: number, code: string, name: string, a: FeasibilityAssumptions, source?: { fileObjectId: number; fileName: string }): number {
  const dup = db.prepare('SELECT deleted_at FROM if_scenario WHERE project_id = ? AND code = ?').get(projectId, code) as { deleted_at: string | null } | undefined;
  if (dup) throw conflict('DUPLICATE', dup.deleted_at ? `方案编码 ${code} 已被已删除的方案占用,请换一个编码` : `方案编码 ${code} 已存在`);
  const now = nowIso();
  return Number(db.prepare(`INSERT INTO if_scenario (project_id, code, name, assumptions_json, assumptions_hash, source_file_object_id, source_file_name,
    created_by_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    projectId, code, name, JSON.stringify(a), canonicalHash(a), source?.fileObjectId ?? null, source?.fileName ?? null, currentAuth()?.userId ?? null, now, now,
  ).lastInsertRowid);
}

export function createFeasScenario(db: DB, projectId: number, input: { code: string; name: string; assumptions: FeasibilityAssumptions }) {
  return db.transaction(() => {
    const p = visibleFeasProject(db, projectId);
    assertActiveProject(p);
    const id = insertScenario(db, projectId, input.code, input.name, input.assumptions);
    writeLog(db, 'investment.feasibility.scenario.create', 'if_scenario', id, { projectId, code: input.code });
    return getFeasScenario(db, id);
  })();
}

export function updateFeasScenario(db: DB, id: number, input: { expectedVersion: number; name?: string; assumptions?: FeasibilityAssumptions }) {
  return db.transaction(() => {
    const { scenario, project } = visibleScenario(db, id);
    assertActiveProject(project);
    if (scenario.version !== input.expectedVersion) throw conflict('VERSION_CONFLICT', '方案已被其他人修改,请刷新后重试', { currentVersion: scenario.version });
    const a = input.assumptions ?? JSON.parse(scenario.assumptions_json);
    db.prepare('UPDATE if_scenario SET name = ?, assumptions_json = ?, assumptions_hash = ?, version = version + 1, updated_at = ? WHERE id = ?')
      .run(input.name ?? scenario.name, JSON.stringify(a), canonicalHash(a), nowIso(), id);
    writeLog(db, 'investment.feasibility.scenario.update', 'if_scenario', id, { beforeHash: scenario.assumptions_hash, afterHash: canonicalHash(a) });
    return getFeasScenario(db, id);
  }).immediate();
}

export function copyFeasScenario(db: DB, id: number, input: { code: string; name: string }) {
  return db.transaction(() => {
    const { scenario, project } = visibleScenario(db, id);
    assertActiveProject(project);
    const newId = insertScenario(db, project.id, input.code, input.name, JSON.parse(scenario.assumptions_json));
    writeLog(db, 'investment.feasibility.scenario.copy', 'if_scenario', newId, { fromScenarioId: id });
    return getFeasScenario(db, newId);
  })();
}

/** 设为基准方案:同项目原基准自动取消(两者版本号均递增)。 */
export function setFeasBaseline(db: DB, id: number, expectedVersion: number) {
  db.transaction(() => {
    const { scenario, project } = visibleScenario(db, id);
    assertActiveProject(project);
    if (scenario.version !== expectedVersion) throw conflict('VERSION_CONFLICT', '方案已被其他人修改,请刷新后重试', { currentVersion: scenario.version });
    if (scenario.is_baseline === 1) return;
    const now = nowIso();
    const prev = db.prepare('SELECT id FROM if_scenario WHERE project_id = ? AND is_baseline = 1').get(project.id) as { id: number } | undefined;
    if (prev) db.prepare('UPDATE if_scenario SET is_baseline = 0, version = version + 1, updated_at = ? WHERE id = ?').run(now, prev.id);
    db.prepare('UPDATE if_scenario SET is_baseline = 1, version = version + 1, updated_at = ? WHERE id = ?').run(now, id);
    writeLog(db, 'investment.feasibility.scenario.baseline', 'if_scenario', id, { projectId: project.id, previousBaselineId: prev?.id ?? null });
  }).immediate();
  return getFeasScenario(db, id);
}

/** 删除方案(软删):已有可行性报告的方案保留为证据,不能删除;基准方案删除后项目暂无基准。运行记录保留。 */
export function deleteFeasScenario(db: DB, id: number, expectedVersion: number): void {
  db.transaction(() => {
    const { scenario, project } = visibleScenario(db, id);
    assertActiveProject(project);
    if (scenario.version !== expectedVersion) throw conflict('VERSION_CONFLICT', '方案已被其他人修改,请刷新后重试', { currentVersion: scenario.version });
    const reports = (db.prepare('SELECT COUNT(*) AS n FROM if_report WHERE scenario_id = ?').get(id) as { n: number }).n;
    if (reports) throw conflict('FEAS_SCENARIO_HAS_REPORTS', `方案已有 ${reports} 份可行性报告,作为证据保留,不能删除`);
    db.prepare('UPDATE if_scenario SET is_baseline = 0, deleted_at = ?, deleted_by_user_id = ?, version = version + 1, updated_at = ? WHERE id = ?')
      .run(nowIso(), currentAuth()?.userId ?? null, nowIso(), id);
    writeLog(db, 'investment.feasibility.scenario.delete', 'if_scenario', id, { projectId: project.id, code: scenario.code, wasBaseline: scenario.is_baseline === 1 });
  }).immediate();
}

export function getFeasScenario(db: DB, id: number) {
  const { scenario, project } = visibleScenario(db, id);
  return { ...toScenarioDto(db, scenario, project), project: toProjectDto(db, project) };
}

export function listFeasRuns(db: DB, scenarioId: number) {
  visibleScenario(db, scenarioId);
  const rows = db.prepare('SELECT * FROM if_run WHERE scenario_id = ? ORDER BY id DESC LIMIT 200').all(scenarioId) as RunRow[];
  return { items: rows.map((r) => runSummary(db, r)) };
}

export function getFeasRun(db: DB, runId: number) {
  const r = db.prepare('SELECT * FROM if_run WHERE id = ?').get(runId) as RunRow | undefined;
  if (!r) throw notVisible('测算运行');
  const { scenario, project } = visibleScenario(db, r.scenario_id);
  return {
    ...runSummary(db, r), scenarioCode: scenario.code, scenarioName: scenario.name, projectId: project.id, projectName: project.name,
    projectYears: JSON.parse(r.project_years_json) as FeasProjectYears,
    assumptions: JSON.parse(r.assumptions_json) as FeasibilityAssumptions,
    result: r.result_json ? JSON.parse(r.result_json) : null,
  };
}

function insertRun(db: DB, scenario: ScenarioRow, project: FeasProjectRow, kind: 'base' | 'sensitivity', a: FeasibilityAssumptions,
  outcome: { status: 'succeeded'; result: unknown; allChecksPassed: boolean | null; parameterHash: string } | { status: 'failed'; error: string; parameterHash: string }): number {
  return Number(db.prepare(`INSERT INTO if_run (scenario_id, kind, scenario_version, project_years_json, assumptions_json, parameter_hash, model_version, status,
    all_checks_passed, result_json, error_message, created_by_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    scenario.id, kind, scenario.version, JSON.stringify(projectYears(project)), JSON.stringify(a), outcome.parameterHash, MODEL_VERSION, outcome.status,
    outcome.status === 'succeeded' && outcome.allChecksPassed != null ? (outcome.allChecksPassed ? 1 : 0) : null,
    outcome.status === 'succeeded' ? JSON.stringify(outcome.result) : null, outcome.status === 'failed' ? outcome.error : null,
    currentAuth()?.userId ?? null, nowIso(),
  ).lastInsertRowid);
}

/** 测算:事务外计算,短事务写入冻结运行。计算失败也留痕(failed 运行),并返回 FEAS_CALC_FAILED。 */
export function runFeasScenario(db: DB, id: number, expectedVersion: number) {
  const { scenario, project } = visibleScenario(db, id);
  assertActiveProject(project);
  if (scenario.version !== expectedVersion) throw conflict('VERSION_CONFLICT', '方案已被其他人修改,请刷新后重试', { currentVersion: scenario.version });
  // 旧数据或手工改动的输入也要先过契约
  const parsed = feasibilityAssumptions.safeParse(JSON.parse(scenario.assumptions_json));
  if (!parsed.success) throw new AppError('FEAS_ASSUMPTIONS_INVALID', '方案输入不符合标准模型', 422, parsed.error.issues.map((i) => ({ row: 0, field: i.path.join('.'), message: i.message })));
  const a = parsed.data;
  const hash = currentParameterHash(project, a);
  let outcome: Parameters<typeof insertRun>[5];
  try {
    const out = calculateFeasibility(projectYears(project), a);
    outcome = { status: 'succeeded', result: out.result, allChecksPassed: out.result.allChecksPassed, parameterHash: hash };
  } catch (e) {
    if (!(e instanceof FeasCalcError)) throw e;
    outcome = { status: 'failed', error: e.message, parameterHash: hash };
  }
  const runId = db.transaction(() => {
    const fresh = db.prepare('SELECT version FROM if_scenario WHERE id = ?').get(id) as { version: number };
    if (fresh.version !== scenario.version) throw conflict('VERSION_CONFLICT', '方案在测算期间被修改,请重试', { currentVersion: fresh.version });
    const rid = insertRun(db, scenario, project, 'base', a, outcome);
    writeLog(db, 'investment.feasibility.run', 'if_run', rid, { scenarioId: id, status: outcome.status, parameterHash: hash }, outcome.status === 'failed' ? 'failure' : 'success');
    return rid;
  }).immediate();
  if (outcome.status === 'failed') throw new AppError('FEAS_CALC_FAILED', `测算失败:${outcome.error}`, 422, undefined, { runId });
  return getFeasRun(db, runId);
}

// ---------------- 敏感性 ----------------

const DEFAULT_SENSITIVITY: { code: SensitivityCode; mode: 'relative' | 'percentage_point' | 'year_delta'; changes: string[] }[] = [
  { code: 'electricity_price', mode: 'relative', changes: ['-0.1', '0.1'] },
  { code: 'power_generation', mode: 'relative', changes: ['-0.1', '0.1'] },
  { code: 'operating_cost', mode: 'relative', changes: ['-0.1', '0.1'] },
  { code: 'construction_investment', mode: 'relative', changes: ['-0.1', '0.1'] },
  { code: 'construction_delay', mode: 'year_delta', changes: ['1'] },
  { code: 'loan_interest_rate', mode: 'percentage_point', changes: ['0.01'] },
  { code: 'opening_input_vat_credit', mode: 'relative', changes: ['-0.1', '0.1'] },
];
const SENSITIVITY_INDICATORS = ['project_npv', 'project_irr', 'equity_npv', 'equity_irr', 'min_dscr', 'dynamic_payback_years'];

/** 纯计算:逐项施加变动并重算(延期时折现基准锁定在原建设起年)。 */
export function computeSensitivity(project: FeasProjectYears, a: FeasibilityAssumptions,
  variables: { code: SensitivityCode; mode: 'relative' | 'percentage_point' | 'year_delta'; changes: string[] }[], onProgress?: (done: number, total: number) => void) {
  const base = calculateFeasibility(project, a);
  const baseValue = new Map(base.result.indicators.map((i) => [i.code, i.value]));
  const items: FeasSensitivityItemDto[] = [];
  const total = variables.reduce((n, v) => n + v.changes.length, 0);
  for (const v of variables) {
    for (const change of v.changes) {
      const p = { ...project };
      const copy = structuredClone(a);
      try {
        applySensitivity(p, copy, v.code, change, v.mode);
        const out = calculateFeasibility(p, copy, { discountBaseYear: project.construction_start_year });
        const byCode = new Map(out.result.indicators.map((i) => [i.code, i.value]));
        items.push({
          code: v.code, mode: v.mode, change, status: 'ok',
          indicators: SENSITIVITY_INDICATORS.map((c) => {
            const value = byCode.get(c) ?? null;
            const b = baseValue.get(c) ?? null;
            return { code: c, value, baseValue: b, delta: value != null && b != null ? toFixed(sub(fx(value), fx(b)), 6) : null };
          }),
        });
      } catch (e) {
        if (!(e instanceof FeasCalcError)) throw e;
        items.push({ code: v.code, mode: v.mode, change, status: 'failed', error: e.message, indicators: [] });
      }
      onProgress?.(items.length, total);
    }
  }
  return { baseIndicators: base.result.indicators, parameterHash: base.result.parameterHash, items };
}

export function startFeasSensitivity(db: () => DB, id: number, input: { expectedVersion: number; variables?: { code: SensitivityCode; mode: 'relative' | 'percentage_point' | 'year_delta'; changes: string[] }[] }) {
  const { scenario, project } = visibleScenario(db(), id);
  assertActiveProject(project);
  if (scenario.version !== input.expectedVersion) throw conflict('VERSION_CONFLICT', '方案已被其他人修改,请刷新后重试', { currentVersion: scenario.version });
  const a = JSON.parse(scenario.assumptions_json) as FeasibilityAssumptions;
  const variables = input.variables?.length ? input.variables : a.sensitivity.variables.length ? a.sensitivity.variables : DEFAULT_SENSITIVITY;
  if (variables.some((v) => !SENSITIVITY_CODES.includes(v.code))) throw Errors.validation('敏感性变量不合法');
  const { job, done } = submitJob(db, {
    kind: 'investment.sensitivity', title: `敏感性分析:${project.name} / ${scenario.name}`,
    input: { scenarioId: id, scenarioVersion: scenario.version }, orgScopeId: project.org_id, permission: 'investment:write',
  }, async (handle: JobHandle) => {
    const out = computeSensitivity(projectYears(project), a, variables, (d, t) => handle.progress(Math.round((d / Math.max(1, t)) * 900), `已完成 ${d}/${t} 项`));
    const hash = currentParameterHash(project, a);
    const runId = db().transaction(() => {
      const rid = insertRun(db(), scenario, project, 'sensitivity', a, { status: 'succeeded', result: { variables, ...out }, allChecksPassed: null, parameterHash: hash });
      writeLog(db(), 'investment.feasibility.sensitivity', 'if_run', rid, { scenarioId: id, items: out.items.length });
      return rid;
    }).immediate();
    return { runId, items: out.items.length };
  });
  return { jobId: job.id, done };
}

// ---------------- 模板导入/导出 ----------------

interface ImportRow {
  id: number; project_id: number; file_object_id: number; file_sha256: string; file_name: string; status: 'previewed' | 'confirmed';
  assumptions_json: string | null; errors_json: string; scenario_id: number | null; created_by_user_id: number | null; created_at: string; confirmed_at: string | null;
}
const importDto = (r: ImportRow) => ({
  id: r.id, projectId: r.project_id, fileName: r.file_name, sha256: r.file_sha256, status: r.status,
  errors: JSON.parse(r.errors_json) as RowError[], assumptions: r.assumptions_json ? JSON.parse(r.assumptions_json) as FeasibilityAssumptions : null,
  scenarioId: r.scenario_id, createdAt: r.created_at, confirmedAt: r.confirmed_at,
});

/** 预览:原件落盘并登记(事务外解析),记录 if_import;不写方案。 */
export async function previewFeasImport(db: DB, store: ObjectStore, projectId: number, content: Buffer, fileName: string) {
  const p = visibleFeasProject(db, projectId);
  assertActiveProject(p);
  const parsed = await parseFeasibilityTemplate(content);
  const file = storeFile(db, store, content, { originalName: fileName, contentType: XLSX_TYPE });
  const id = db.transaction(() => {
    const rid = Number(db.prepare(`INSERT INTO if_import (project_id, file_object_id, file_sha256, file_name, assumptions_json, errors_json, created_by_user_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(projectId, file.id, file.sha256, fileName, parsed.assumptions ? JSON.stringify(parsed.assumptions) : null,
      JSON.stringify(parsed.errors.slice(0, 500)), currentAuth()?.userId ?? null, nowIso()).lastInsertRowid);
    writeLog(db, 'investment.feasibility.import.preview', 'if_import', rid, { projectId, sha256: file.sha256, errors: parsed.errors.length });
    return rid;
  })();
  return importDto(db.prepare('SELECT * FROM if_import WHERE id = ?').get(id) as ImportRow);
}

/** 确认:只能由预览人确认;核对 sha256,按原件重新解析并与预览一致后,短事务创建方案。 */
export async function confirmFeasImport(db: DB, store: ObjectStore, importId: number, input: { sha256: string; code: string; name: string }) {
  const imp = db.prepare('SELECT * FROM if_import WHERE id = ?').get(importId) as ImportRow | undefined;
  if (!imp) throw notVisible('导入预览');
  const p = visibleFeasProject(db, imp.project_id);
  assertActiveProject(p);
  if (imp.created_by_user_id !== (currentAuth()?.userId ?? null)) throw new AppError('PREVIEW_OWNER_MISMATCH', '只能由预览人确认本次导入', 403);
  if (imp.status === 'confirmed') return { ...importDto(imp), replayed: true };
  if (input.sha256 !== imp.file_sha256) throw conflict('PREVIEW_STALE', '确认的文件与预览不一致,请重新预览');
  const errors = JSON.parse(imp.errors_json) as RowError[];
  if (errors.length || !imp.assumptions_json) throw new AppError('IMPORT_INVALID', `预览有 ${errors.length} 项错误,不能确认`, 422, errors);
  const parsed = await parseFeasibilityTemplate(store.read(imp.file_sha256));
  if (!parsed.assumptions || canonicalHash(parsed.assumptions) !== canonicalHash(JSON.parse(imp.assumptions_json))) {
    throw conflict('PREVIEW_STALE', '按原件重新解析的结果与预览不一致,请重新预览');
  }
  const a = parsed.assumptions;
  db.transaction(() => {
    const fresh = db.prepare('SELECT status FROM if_import WHERE id = ?').get(importId) as { status: string };
    if (fresh.status === 'confirmed') return;
    const sid = insertScenario(db, imp.project_id, input.code, input.name, a, { fileObjectId: imp.file_object_id, fileName: imp.file_name });
    db.prepare("UPDATE if_import SET status = 'confirmed', scenario_id = ?, confirmed_at = ? WHERE id = ?").run(sid, nowIso(), importId);
    writeLog(db, 'investment.feasibility.import.confirm', 'if_import', importId, { scenarioId: sid, sha256: imp.file_sha256 });
  }).immediate();
  return { ...importDto(db.prepare('SELECT * FROM if_import WHERE id = ?').get(importId) as ImportRow), replayed: false };
}

/** 模板导出:不带方案时为空白模板;带方案时预填当前输入。 */
export async function exportFeasTemplate(db: DB, scenarioId?: number): Promise<{ fileName: string; buffer: Buffer }> {
  if (scenarioId == null) return { fileName: '可行性测算标准模板.xlsx', buffer: await feasibilityTemplateBuffer() };
  const { scenario, project } = visibleScenario(db, scenarioId);
  return { fileName: `${project.code}-${scenario.code}-测算输入.xlsx`, buffer: await feasibilityTemplateBuffer(JSON.parse(scenario.assumptions_json)) };
}

/** 结果导出:数值取冻结运行结果;敏感性运行附“敏感性”表。 */
export async function exportFeasRun(db: DB, runId: number): Promise<{ fileName: string; buffer: Buffer }> {
  const run = getFeasRun(db, runId);
  if (run.status !== 'succeeded' || !run.result) throw conflict('FEAS_STATE', '失败的运行没有可导出的结果');
  let result: FeasResultDto;
  let sensitivity: FeasSensitivityItemDto[] | null = null;
  if (run.kind === 'base') result = run.result as FeasResultDto;
  else {
    // 敏感性运行冻结的是指标变化;现金流等按冻结输入重算基准(同一模型版本,结果确定)
    result = calculateFeasibility(run.projectYears, run.assumptions).result;
    sensitivity = (run.result as { items: FeasSensitivityItemDto[] }).items;
  }
  writeLog(db, 'investment.feasibility.export', 'if_run', runId, { kind: run.kind });
  return {
    fileName: `${run.projectName}-${run.scenarioName}-测算结果-${runId}.xlsx`,
    buffer: await feasibilityResultBuffer({
      projectName: run.projectName, scenarioName: run.scenarioName, runId, createdAt: run.createdAt, createdBy: run.createdBy,
      assumptions: run.assumptions, result, sensitivity,
    }),
  };
}
