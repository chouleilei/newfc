/**
 * 财务预测(AC-F11)。规则见 specs/implementation.md T-5「财务预测」。
 *
 * - 模型按 org_id 裁剪范围,范围外 404。
 * - 版本:草稿可改单元格与映射(期望版本号);冻结要求诊断无错误且至少一个输出;冻结后只能复制为新草稿。
 * - 运行只针对冻结版本,作为后台任务在 Worker 中计算(重任务并发受任务槽限制);
 *   失败只保存错误与诊断,不保存部分输出;每个版本最多一个成功的基准运行。
 */
import type { DB } from '../../db/connection';
import { AppError, Errors } from '../../core/errors';
import { currentAuth } from '../../core/request-context';
import { canonicalHash } from '../../core/canonical';
import { fx, sub, div, toFixed, FX_ZERO } from '../../core/fixed';
import { writeLog } from '../audit/log';
import { currentOrgScope, notVisible, orgInScope, scopeFilterSql } from '../security/scope';
import { submitJob } from '../jobs/job.service';
import { storeFile, type ObjectStore } from '../files/object-store';
import type { ForecastDiagnostic, ForecastOutput, ForecastParam, WorkbookJsonInput } from '../../contracts/finance-forecast';
import { diagnoseWorkbook, hasErrors, workbookFromXlsx } from './forecast-workbook';
import { forecastLimits, runForecastInWorker } from './forecast-runner';
import { getSetting } from '../settings/business-settings';
import type { CellInput, WorkbookJson } from './formula/engine';

const nowIso = () => new Date().toISOString();
const conflict = (code: string, message: string, details?: unknown) => new AppError(code, message, 409, undefined, details);
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MAX_STEPS = 50_000_000;

interface ModelRow {
  id: number; name: string; org_id: number; base_year: number; horizon_years: number; description: string; status: 'active' | 'archived'; version: number;
  created_by_user_id: number | null; created_at: string; updated_at: string;
}
interface VersionRow {
  id: number; model_id: number; version_no: number; status: 'draft' | 'frozen'; workbook_json: string; params_json: string; outputs_json: string; diagnostics_json: string;
  content_hash: string; source_file_object_id: number | null; source_file_name: string | null; note: string; version: number; created_by_user_id: number | null;
  created_at: string; updated_at: string; frozen_by_user_id: number | null; frozen_at: string | null;
}
interface RunRow {
  id: number; version_id: number; kind: 'baseline' | 'scenario'; scenario_name: string; params_json: string; status: 'queued' | 'running' | 'succeeded' | 'failed';
  outputs_json: string | null; error_code: string | null; error_message: string | null; diagnostics_json: string | null; job_id: number | null; duration_ms: number | null;
  created_by_user_id: number | null; created_at: string; finished_at: string | null;
}

const userName = (db: DB, id: number | null): string | null =>
  id == null ? null : ((db.prepare('SELECT COALESCE(NULLIF(display_name, \'\'), username) AS n FROM app_user WHERE id = ?').get(id) as { n: string } | undefined)?.n ?? null);

function visibleModel(db: DB, id: number): ModelRow {
  const m = db.prepare('SELECT * FROM ff_model WHERE id = ?').get(id) as ModelRow | undefined;
  if (!m || !orgInScope(currentOrgScope(db), m.org_id)) throw notVisible('预测模型');
  return m;
}
function visibleVersion(db: DB, id: number): { version: VersionRow; model: ModelRow } {
  const v = db.prepare('SELECT * FROM ff_version WHERE id = ?').get(id) as VersionRow | undefined;
  if (!v) throw notVisible('预测版本');
  const model = db.prepare('SELECT * FROM ff_model WHERE id = ?').get(v.model_id) as ModelRow;
  if (!orgInScope(currentOrgScope(db), model.org_id)) throw notVisible('预测版本');
  return { version: v, model };
}
function assertActive(m: ModelRow): void {
  if (m.status !== 'active') throw conflict('FORECAST_VERSION_STATE', '模型已归档,不能修改或运行');
}
function assertDraft(v: VersionRow, expectedVersion: number): void {
  if (v.status === 'frozen') throw conflict('FORECAST_VERSION_FROZEN', '版本已冻结,不能修改;请复制为新草稿');
  if (v.version !== expectedVersion) throw conflict('VERSION_CONFLICT', '版本已被其他人修改,请刷新后重试', { currentVersion: v.version });
}

// ---------------- 模型 ----------------

function modelDto(db: DB, m: ModelRow) {
  const counts = db.prepare("SELECT COUNT(*) AS n, SUM(status = 'frozen') AS frozen FROM ff_version WHERE model_id = ?").get(m.id) as { n: number; frozen: number | null };
  return {
    id: m.id, name: m.name, orgId: m.org_id, orgName: (db.prepare('SELECT name FROM org WHERE id = ?').get(m.org_id) as { name: string } | undefined)?.name ?? '',
    baseYear: m.base_year, horizonYears: m.horizon_years, description: m.description, status: m.status, version: m.version,
    versionCount: counts.n, frozenCount: counts.frozen ?? 0, createdAt: m.created_at, updatedAt: m.updated_at, createdBy: userName(db, m.created_by_user_id),
  };
}

export function listForecastModels(db: DB, q: { orgId?: number; status?: 'active' | 'archived'; keyword?: string }) {
  const f = scopeFilterSql(currentOrgScope(db), 'org_id');
  const where = [f.sql];
  const params: unknown[] = [...f.params];
  if (q.orgId) { where.push('org_id = ?'); params.push(q.orgId); }
  if (q.status) { where.push('status = ?'); params.push(q.status); }
  if (q.keyword) { where.push('name LIKE ?'); params.push(`%${q.keyword}%`); }
  const rows = db.prepare(`SELECT * FROM ff_model WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT 500`).all(...params) as ModelRow[];
  return { items: rows.map((m) => modelDto(db, m)) };
}

export function createForecastModel(db: DB, input: { name: string; orgId: number; baseYear: number; horizonYears: number; description?: string }) {
  if (!orgInScope(currentOrgScope(db), input.orgId)) throw notVisible('组织');
  const now = nowIso();
  const id = db.transaction(() => {
    const mid = Number(db.prepare(`INSERT INTO ff_model (name, org_id, base_year, horizon_years, description, created_by_user_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`).run(input.name, input.orgId, input.baseYear, input.horizonYears, input.description ?? '', currentAuth()?.userId ?? null, now, now).lastInsertRowid);
    writeLog(db, 'forecast.model.create', 'ff_model', mid, { name: input.name, orgId: input.orgId });
    return mid;
  })();
  return getForecastModel(db, id);
}

export function updateForecastModel(db: DB, id: number, input: { expectedVersion: number; name?: string; description?: string; status?: 'active' | 'archived' }) {
  db.transaction(() => {
    const m = visibleModel(db, id);
    if (m.version !== input.expectedVersion) throw conflict('VERSION_CONFLICT', '模型已被其他人修改,请刷新后重试', { currentVersion: m.version });
    db.prepare('UPDATE ff_model SET name = ?, description = ?, status = ?, version = version + 1, updated_at = ? WHERE id = ?')
      .run(input.name ?? m.name, input.description ?? m.description, input.status ?? m.status, nowIso(), id);
    writeLog(db, 'forecast.model.update', 'ff_model', id, { status: input.status ?? m.status });
  }).immediate();
  return getForecastModel(db, id);
}

export function getForecastModel(db: DB, id: number) {
  const m = visibleModel(db, id);
  const versions = db.prepare('SELECT * FROM ff_version WHERE model_id = ? ORDER BY version_no DESC').all(id) as VersionRow[];
  return { ...modelDto(db, m), versions: versions.map((v) => versionSummary(db, v)) };
}

// ---------------- 版本 ----------------

const cellCount = (wb: WorkbookJson) => wb.sheets.reduce((n, s) => n + Object.keys(s.cells).length, 0);

function versionSummary(db: DB, v: VersionRow) {
  const diagnostics = JSON.parse(v.diagnostics_json) as { items?: ForecastDiagnostic[] };
  const items = diagnostics.items ?? [];
  const wb = JSON.parse(v.workbook_json) as WorkbookJson;
  const baseline = db.prepare("SELECT id FROM ff_run WHERE version_id = ? AND kind = 'baseline' AND status = 'succeeded'").get(v.id) as { id: number } | undefined;
  return {
    id: v.id, modelId: v.model_id, versionNo: v.version_no, status: v.status, note: v.note, contentHash: v.content_hash, sourceFileName: v.source_file_name,
    sheets: wb.sheets.map((s) => ({ name: s.name, cellCount: Object.keys(s.cells).length })), cellCount: cellCount(wb),
    params: JSON.parse(v.params_json) as ForecastParam[], outputs: JSON.parse(v.outputs_json) as ForecastOutput[],
    errorCount: items.filter((d) => d.severity === 'error').length, warningCount: items.filter((d) => d.severity === 'warning').length,
    baselineRunId: baseline?.id ?? null, version: v.version, createdAt: v.created_at, createdBy: userName(db, v.created_by_user_id),
    frozenAt: v.frozen_at, frozenBy: userName(db, v.frozen_by_user_id),
  };
}

export function getForecastVersion(db: DB, id: number) {
  const { version } = visibleVersion(db, id);
  const d = JSON.parse(version.diagnostics_json) as { items?: ForecastDiagnostic[] };
  return { ...versionSummary(db, version), diagnostics: d.items ?? [] };
}

/** 读取一个工作表的单元格(页面分表加载)。 */
export function getForecastSheet(db: DB, id: number, sheetName: string) {
  const { version } = visibleVersion(db, id);
  const wb = JSON.parse(version.workbook_json) as WorkbookJson;
  const sheet = wb.sheets.find((s) => s.name === sheetName);
  if (!sheet) throw notVisible('工作表');
  return { versionId: id, name: sheet.name, cells: sheet.cells };
}

const contentHash = (wb: WorkbookJson, params: ForecastParam[], outputs: ForecastOutput[]) => canonicalHash({ wb, params, outputs });

function insertVersion(db: DB, modelId: number, wb: WorkbookJson, params: ForecastParam[], outputs: ForecastOutput[], diagnostics: ForecastDiagnostic[],
  note: string, source?: { fileObjectId: number; fileName: string }): number {
  const no = (db.prepare('SELECT COALESCE(MAX(version_no), 0) + 1 AS n FROM ff_version WHERE model_id = ?').get(modelId) as { n: number }).n;
  const now = nowIso();
  return Number(db.prepare(`INSERT INTO ff_version (model_id, version_no, workbook_json, params_json, outputs_json, diagnostics_json, content_hash, source_file_object_id,
    source_file_name, note, created_by_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    modelId, no, JSON.stringify(wb), JSON.stringify(params), JSON.stringify(outputs), JSON.stringify({ items: diagnostics }), contentHash(wb, params, outputs),
    source?.fileObjectId ?? null, source?.fileName ?? null, note, currentAuth()?.userId ?? null, now, now,
  ).lastInsertRowid);
}

export function createForecastVersion(db: DB, modelId: number, input: { workbook: WorkbookJsonInput; params: ForecastParam[]; outputs: ForecastOutput[]; note?: string }) {
  const m = visibleModel(db, modelId);
  assertActive(m);
  const wb = input.workbook as WorkbookJson;
  const diagnostics = diagnoseWorkbook(wb, input.params, input.outputs);
  const id = db.transaction(() => {
    const vid = insertVersion(db, modelId, wb, input.params, input.outputs, diagnostics, input.note ?? '');
    writeLog(db, 'forecast.version.create', 'ff_version', vid, { modelId, cells: cellCount(wb), errors: diagnostics.filter((d) => d.severity === 'error').length });
    return vid;
  })();
  return getForecastVersion(db, id);
}

/** xlsx 导入为新草稿:事务外读取与诊断,短事务写入。 */
export async function importForecastVersion(db: DB, store: ObjectStore, modelId: number, content: Buffer, fileName: string, note?: string) {
  const m = visibleModel(db, modelId);
  assertActive(m);
  const { workbook, diagnostics: readDiag } = await workbookFromXlsx(content);
  const diagnostics = diagnoseWorkbook(workbook, [], [], readDiag);
  const file = storeFile(db, store, content, { originalName: fileName, contentType: XLSX_TYPE });
  const id = db.transaction(() => {
    const vid = insertVersion(db, modelId, workbook, [], [], diagnostics, note ?? '', { fileObjectId: file.id, fileName });
    writeLog(db, 'forecast.version.import', 'ff_version', vid, { modelId, sha256: file.sha256, cells: cellCount(workbook), errors: diagnostics.filter((d) => d.severity === 'error').length });
    return vid;
  })();
  return getForecastVersion(db, id);
}

export function updateForecastVersion(db: DB, id: number, input: {
  expectedVersion: number; cells?: { sheet: string; cell: string; value: CellInput | null }[]; params?: ForecastParam[]; outputs?: ForecastOutput[]; note?: string;
}) {
  const { version, model } = visibleVersion(db, id);
  assertActive(model);
  assertDraft(version, input.expectedVersion);
  const wb = JSON.parse(version.workbook_json) as WorkbookJson;
  for (const c of input.cells ?? []) {
    const sheet = wb.sheets.find((s) => s.name === c.sheet);
    if (!sheet) throw Errors.validation(`工作表“${c.sheet}”不存在`);
    if (c.value == null) delete sheet.cells[c.cell];
    else sheet.cells[c.cell] = c.value;
  }
  const params = input.params ?? JSON.parse(version.params_json);
  const outputs = input.outputs ?? JSON.parse(version.outputs_json);
  // 诊断在事务外;事务内核对版本号
  const diagnostics = diagnoseWorkbook(wb, params, outputs);
  db.transaction(() => {
    const fresh = db.prepare('SELECT status, version FROM ff_version WHERE id = ?').get(id) as { status: string; version: number };
    if (fresh.status === 'frozen') throw conflict('FORECAST_VERSION_FROZEN', '版本已冻结,不能修改;请复制为新草稿');
    if (fresh.version !== input.expectedVersion) throw conflict('VERSION_CONFLICT', '版本已被其他人修改,请刷新后重试', { currentVersion: fresh.version });
    db.prepare(`UPDATE ff_version SET workbook_json = ?, params_json = ?, outputs_json = ?, diagnostics_json = ?, content_hash = ?, note = ?, version = version + 1,
      updated_at = ? WHERE id = ?`).run(JSON.stringify(wb), JSON.stringify(params), JSON.stringify(outputs), JSON.stringify({ items: diagnostics }),
      contentHash(wb, params, outputs), input.note ?? version.note, nowIso(), id);
    writeLog(db, 'forecast.version.update', 'ff_version', id, { cells: input.cells?.length ?? 0, params: params.length, outputs: outputs.length });
  }).immediate();
  return getForecastVersion(db, id);
}

export function freezeForecastVersion(db: DB, id: number, expectedVersion: number) {
  const { version, model } = visibleVersion(db, id);
  assertActive(model);
  assertDraft(version, expectedVersion);
  const params = JSON.parse(version.params_json) as ForecastParam[];
  const outputs = JSON.parse(version.outputs_json) as ForecastOutput[];
  const diagnostics = diagnoseWorkbook(JSON.parse(version.workbook_json), params, outputs);
  if (hasErrors(diagnostics)) {
    throw conflict('FORECAST_VERSION_STATE', `诊断有 ${diagnostics.filter((d) => d.severity === 'error').length} 项错误,不能冻结`, { diagnostics: diagnostics.filter((d) => d.severity === 'error').slice(0, 100) });
  }
  if (!outputs.length) throw conflict('FORECAST_VERSION_STATE', '至少配置一个输出后才能冻结');
  db.transaction(() => {
    const fresh = db.prepare('SELECT status, version FROM ff_version WHERE id = ?').get(id) as { status: string; version: number };
    if (fresh.status === 'frozen' || fresh.version !== expectedVersion) throw conflict('VERSION_CONFLICT', '版本已被其他人修改,请刷新后重试', { currentVersion: fresh.version });
    const now = nowIso();
    db.prepare("UPDATE ff_version SET status = 'frozen', diagnostics_json = ?, frozen_by_user_id = ?, frozen_at = ?, version = version + 1, updated_at = ? WHERE id = ?")
      .run(JSON.stringify({ items: diagnostics }), currentAuth()?.userId ?? null, now, now, id);
    writeLog(db, 'forecast.version.freeze', 'ff_version', id, { contentHash: version.content_hash });
  }).immediate();
  return getForecastVersion(db, id);
}

export function copyForecastVersion(db: DB, id: number, note?: string) {
  const { version, model } = visibleVersion(db, id);
  assertActive(model);
  const wb = JSON.parse(version.workbook_json) as WorkbookJson;
  const params = JSON.parse(version.params_json) as ForecastParam[];
  const outputs = JSON.parse(version.outputs_json) as ForecastOutput[];
  const diagnostics = diagnoseWorkbook(wb, params, outputs);
  const newId = db.transaction(() => {
    const vid = insertVersion(db, model.id, wb, params, outputs, diagnostics, note ?? `复制自第 ${version.version_no} 版`);
    writeLog(db, 'forecast.version.copy', 'ff_version', vid, { fromVersionId: id });
    return vid;
  })();
  return getForecastVersion(db, newId);
}

// ---------------- 运行 ----------------

function runDto(db: DB, r: RunRow) {
  return {
    id: r.id, versionId: r.version_id, kind: r.kind, scenarioName: r.scenario_name, params: JSON.parse(r.params_json) as Record<string, string>, status: r.status,
    outputs: r.outputs_json ? JSON.parse(r.outputs_json) as Record<string, string[]> : null, errorCode: r.error_code, errorMessage: r.error_message,
    diagnostics: r.diagnostics_json ? JSON.parse(r.diagnostics_json) as unknown[] : [], jobId: r.job_id, durationMs: r.duration_ms,
    createdAt: r.created_at, finishedAt: r.finished_at, createdBy: userName(db, r.created_by_user_id),
  };
}

/** 任务在执行前被取消/中断/拒绝授权时,运行记录同步记为失败。 */
function reconcileRuns(db: DB, versionId: number): void {
  const stuck = db.prepare(`SELECT r.id, j.status AS job_status, j.error_code, j.error_message FROM ff_run r JOIN app_job j ON j.id = r.job_id
    WHERE r.version_id = ? AND r.status IN ('queued','running') AND j.status IN ('failed','cancelled','interrupted')`).all(versionId) as
    { id: number; job_status: string; error_code: string | null; error_message: string | null }[];
  if (!stuck.length) return;
  const upd = db.prepare("UPDATE ff_run SET status = 'failed', error_code = ?, error_message = ?, finished_at = ? WHERE id = ? AND status IN ('queued','running')");
  db.transaction(() => {
    for (const s of stuck) upd.run(s.error_code ?? 'FORECAST_RECALC_FAILED', s.error_message ?? `任务${s.job_status === 'cancelled' ? '已取消' : '未完成'}`, nowIso(), s.id);
  })();
}

export function listForecastRuns(db: DB, versionId: number) {
  visibleVersion(db, versionId);
  reconcileRuns(db, versionId);
  const rows = db.prepare('SELECT * FROM ff_run WHERE version_id = ? ORDER BY id DESC LIMIT 200').all(versionId) as RunRow[];
  return { items: rows.map((r) => runDto(db, r)) };
}

export function getForecastRun(db: DB, runId: number) {
  const r0 = db.prepare('SELECT version_id FROM ff_run WHERE id = ?').get(runId) as { version_id: number } | undefined;
  if (!r0) throw notVisible('预测运行');
  visibleVersion(db, r0.version_id);
  reconcileRuns(db, r0.version_id);
  return runDto(db, db.prepare('SELECT * FROM ff_run WHERE id = ?').get(runId) as RunRow);
}

export function startForecastRun(db: () => DB, versionId: number, input: { kind: 'baseline' | 'scenario'; scenarioName?: string; params: Record<string, string> }) {
  const d = db();
  const { version, model } = visibleVersion(d, versionId);
  assertActive(model);
  if (version.status !== 'frozen') throw conflict('FORECAST_VERSION_STATE', '只有冻结版本可以正式运行');
  reconcileRuns(d, versionId);
  const paramDefs = JSON.parse(version.params_json) as ForecastParam[];
  for (const k of Object.keys(input.params)) if (!paramDefs.some((p) => p.key === k)) throw Errors.validation(`参数 ${k} 不在该版本的参数映射中`);
  if (input.kind === 'baseline') {
    const existing = d.prepare("SELECT * FROM ff_run WHERE version_id = ? AND kind = 'baseline' AND status IN ('queued','running','succeeded') ORDER BY id DESC LIMIT 1").get(versionId) as RunRow | undefined;
    if (existing?.status === 'succeeded') throw conflict('FORECAST_VERSION_STATE', '该版本已有成功的基准运行', { runId: existing.id });
    if (existing) return { run: runDto(d, existing), done: Promise.resolve() };
  } else if (!d.prepare("SELECT 1 FROM ff_run WHERE version_id = ? AND kind = 'baseline' AND status = 'succeeded'").get(versionId)) {
    throw conflict('FORECAST_VERSION_STATE', '请先完成基准运行,情景结果需要与基准对比');
  }
  const runId = d.transaction(() => {
    const rid = Number(d.prepare(`INSERT INTO ff_run (version_id, kind, scenario_name, params_json, created_by_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
      .run(versionId, input.kind, input.scenarioName ?? '', JSON.stringify(input.params), currentAuth()?.userId ?? null, nowIso()).lastInsertRowid);
    writeLog(d, 'forecast.run.submit', 'ff_run', rid, { versionId, kind: input.kind, scenarioName: input.scenarioName ?? '' });
    return rid;
  })();
  const { job, done } = submitJob(db, {
    kind: 'forecast.recalc', title: `预测重算:${model.name} 第 ${version.version_no} 版${input.kind === 'scenario' ? ` / ${input.scenarioName}` : ''}`,
    input: { runId, versionId }, orgScopeId: model.org_id, permission: 'forecast:write',
  }, async (handle) => {
    const started = Date.now();
    db().prepare("UPDATE ff_run SET status = 'running' WHERE id = ? AND status = 'queued'").run(runId);
    handle.progress(100, '计算中');
    const finish = (out: { ok: true; outputs: Record<string, string[]> } | { ok: false; code: string; message: string; diagnostics: unknown[] }) => {
      db().transaction(() => {
        const ms = Date.now() - started;
        if (out.ok) {
          db().prepare("UPDATE ff_run SET status = 'succeeded', outputs_json = ?, diagnostics_json = '[]', duration_ms = ?, finished_at = ? WHERE id = ?")
            .run(JSON.stringify(out.outputs), ms, nowIso(), runId);
        } else {
          db().prepare("UPDATE ff_run SET status = 'failed', error_code = ?, error_message = ?, diagnostics_json = ?, duration_ms = ?, finished_at = ? WHERE id = ?")
            .run(out.code, out.message.slice(0, 1000), JSON.stringify(out.diagnostics.slice(0, 200)), ms, nowIso(), runId);
        }
        writeLog(db(), 'forecast.run.finish', 'ff_run', runId, { status: out.ok ? 'succeeded' : 'failed', errorCode: out.ok ? null : out.code, durationMs: ms }, out.ok ? 'success' : 'failure');
      }).immediate();
      if (!out.ok) throw new AppError('FORECAST_RECALC_FAILED', `${out.code}:${out.message}`.slice(0, 500), 422);
      return { runId, status: 'succeeded' };
    };
    // 参数越界:不启动 Worker,直接记失败
    const overrides: Record<string, string> = {};
    for (const [k, value] of Object.entries(input.params)) {
      const p = paramDefs.find((x) => x.key === k)!;
      const v = fx(value);
      if ((p.min != null && v < fx(p.min)) || (p.max != null && v > fx(p.max))) {
        return finish({ ok: false, code: 'FORECAST_PARAM_INVALID', message: `参数“${p.name}”取值 ${value} 超出范围 [${p.min ?? '-∞'}, ${p.max ?? '+∞'}]`, diagnostics: [{ param: k, value, min: p.min, max: p.max }] });
      }
      overrides[p.cell] = value;
    }
    const outputs = (JSON.parse(version.outputs_json) as ForecastOutput[]).map((o) => ({ key: o.key, ref: o.ref }));
    const out = await runForecastInWorker({ workbook: JSON.parse(version.workbook_json), overrides, outputs, maxSteps: MAX_STEPS }, forecastLimits(getSetting<number>(db(), 'forecast.timeout_seconds')));
    return finish(out);
  });
  d.prepare('UPDATE ff_run SET job_id = ? WHERE id = ? AND status IN (\'queued\',\'running\')').run(job.id, runId);
  return { run: runDto(d, d.prepare('SELECT * FROM ff_run WHERE id = ?').get(runId) as RunRow), done };
}

/** 情景与基准逐项对比(差额与变化率,6 位小数)。 */
export function compareForecastRun(db: DB, runId: number) {
  const run = getForecastRun(db, runId);
  if (run.status !== 'succeeded' || !run.outputs) throw conflict('FORECAST_VERSION_STATE', '运行未成功,不能对比');
  const baseRow = db.prepare("SELECT * FROM ff_run WHERE version_id = ? AND kind = 'baseline' AND status = 'succeeded'").get(run.versionId) as RunRow | undefined;
  if (!baseRow) throw conflict('FORECAST_VERSION_STATE', '该版本没有成功的基准运行');
  const base = JSON.parse(baseRow.outputs_json!) as Record<string, string[]>;
  const { version } = visibleVersion(db, run.versionId);
  const outputs = JSON.parse(version.outputs_json) as ForecastOutput[];
  return {
    runId, baselineRunId: baseRow.id, scenarioName: run.scenarioName, params: run.params,
    items: outputs.map((o) => ({
      key: o.key, name: o.name, unit: o.unit,
      values: (run.outputs![o.key] ?? []).map((v, i) => {
        const b = base[o.key]?.[i] ?? null;
        const diff = b == null ? null : sub(fx(v), fx(b));
        return {
          index: i, baseline: b, scenario: v, diff: diff == null ? null : toFixed(diff, 6),
          rate: diff == null || fx(b!) === FX_ZERO ? null : toFixed(div(diff, fx(b!) < FX_ZERO ? -fx(b!) : fx(b!)), 6),
        };
      }),
    })),
  };
}
