/**
 * 持久任务(AC-F21):导入、报告、预测重算、知识索引等较长操作的统一状态、步骤与进度。
 *
 * - 状态写入都是短事务;任务体(含模型调用)在事务之外执行。
 * - 进程内有界并发(NEWFC_JOB_CONCURRENCY,默认 1,与运行规范的开发基线一致),超出排队;不引入外部队列。
 * - 启动时把上个进程遗留的 queued/running 标为 interrupted,不静默丢失也不假装完成。
 * - 任务在创建者的身份上下文中执行(source='task')。开始执行前按当前库重新加载身份:
 *   用户已停用或已失去任务所需权限时直接失败(AUTH_REVOKED),不用排队时的旧授权读数据。
 */
import type { DB } from '../../db/connection';
import { AppError, Errors } from '../../core/errors';
import { currentContext, runWithContext, type AuthContext } from '../../core/request-context';
import { sanitizeDetail, writeLog } from '../audit/log';
import { loadAuthContext } from '../security/security.service';
import type { Permission } from '../security/permissions';
import { orgInScope, resolveOrgScope } from '../security/scope';

export type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';
export type StepType = 'rule' | 'tool' | 'model' | 'io' | 'system';

export interface JobRow {
  id: number;
  kind: string;
  title: string;
  status: JobStatus;
  progress_permille: number;
  progress_message: string;
  created_by: number | null;
  org_scope_id: number | null;
  request_id: string;
  idempotency_key: string | null;
  input_json: string;
  result_json: string | null;
  error_code: string;
  error_message: string;
  cancel_requested: 0 | 1;
  attempts: number;
  created_at: string;
  started_at: string | null;
  finished_at: string | null;
  heartbeat_at: string | null;
  updated_at: string;
}

export interface JobStepRow {
  id: number;
  job_id: number;
  seq: number;
  name: string;
  step_type: StepType;
  status: 'success' | 'error' | 'skipped';
  detail: string;
  input_json: string | null;
  output_json: string | null;
  source_refs_json: string | null;
  error_message: string;
  elapsed_ms: number | null;
  created_at: string;
}

export interface PublicJob {
  id: number;
  kind: string;
  title: string;
  status: JobStatus;
  progress: { permille: number; message: string };
  createdBy: number | null;
  orgScopeId: number | null;
  requestId: string;
  input: unknown;
  result: unknown;
  error: { code: string; message: string } | null;
  cancelRequested: boolean;
  attempts: number;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
  heartbeatAt: string | null;
}

const TERMINAL: ReadonlySet<JobStatus> = new Set(['succeeded', 'failed', 'cancelled', 'interrupted']);
const nowIso = () => new Date().toISOString();

function parseJson(text: string | null): unknown {
  if (text === null || text === '') return null;
  try { return JSON.parse(text); } catch { return null; }
}

/** 超长 JSON 截断为摘要,避免把大结果集塞进任务表。 */
function compactJson(value: unknown, limit = 64_000): string {
  const text = JSON.stringify(sanitizeDetail(value ?? {}));
  return text.length <= limit ? text : JSON.stringify({ truncated: true, bytes: text.length, preview: text.slice(0, 2_000) });
}

export function toPublicJob(row: JobRow): PublicJob {
  return {
    id: row.id,
    kind: row.kind,
    title: row.title,
    status: row.status,
    progress: { permille: row.progress_permille, message: row.progress_message },
    createdBy: row.created_by,
    orgScopeId: row.org_scope_id,
    requestId: row.request_id,
    input: parseJson(row.input_json),
    result: parseJson(row.result_json),
    error: row.error_code || row.error_message ? { code: row.error_code, message: row.error_message } : null,
    cancelRequested: row.cancel_requested === 1,
    attempts: row.attempts,
    createdAt: row.created_at,
    startedAt: row.started_at,
    finishedAt: row.finished_at,
    heartbeatAt: row.heartbeat_at,
  };
}

export function getJobRow(db: DB, id: number): JobRow {
  const row = db.prepare('SELECT * FROM app_job WHERE id = ?').get(id) as JobRow | undefined;
  if (!row) throw Errors.notFound('任务');
  return row;
}

/** 可见性:本人任务;持有 tasks:read 且为全部组织范围的用户可见全部任务。不可见一律 404。 */
export function canSeeJob(auth: AuthContext | undefined, row: JobRow): boolean {
  if (!auth) return true; // 系统/CLI 上下文
  if (row.created_by === auth.userId) return true;
  return auth.allOrgs && auth.permissions.has('tasks:read');
}

export function getJobFor(db: DB, auth: AuthContext | undefined, id: number): PublicJob & { steps: PublicJobStep[] } {
  const row = getJobRow(db, id);
  if (!canSeeJob(auth, row)) throw Errors.notFound('任务');
  return { ...toPublicJob(row), steps: listSteps(db, id) };
}

export interface JobListQuery { status?: string; kind?: string; page?: number; pageSize?: number }

export function listJobsFor(db: DB, auth: AuthContext | undefined, q: JobListQuery = {}): { total: number; items: PublicJob[] } {
  const where: string[] = [];
  const params: unknown[] = [];
  if (auth && !(auth.allOrgs && auth.permissions.has('tasks:read'))) { where.push('created_by = ?'); params.push(auth.userId); }
  if (q.status) { where.push('status = ?'); params.push(q.status); }
  if (q.kind) { where.push('kind = ?'); params.push(q.kind); }
  const clause = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const pageSize = Math.min(200, Math.max(1, q.pageSize ?? 50));
  const page = Math.max(1, q.page ?? 1);
  const total = (db.prepare(`SELECT COUNT(*) AS c FROM app_job ${clause}`).get(...params) as { c: number }).c;
  const rows = db.prepare(`SELECT * FROM app_job ${clause} ORDER BY id DESC LIMIT ? OFFSET ?`).all(...params, pageSize, (page - 1) * pageSize) as JobRow[];
  return { total, items: rows.map(toPublicJob) };
}

export interface PublicJobStep {
  seq: number;
  name: string;
  type: StepType;
  status: 'success' | 'error' | 'skipped';
  detail: string;
  input: unknown;
  output: unknown;
  sourceRefs: unknown;
  errorMessage: string;
  elapsedMs: number | null;
  createdAt: string;
}

export function listSteps(db: DB, jobId: number): PublicJobStep[] {
  const rows = db.prepare('SELECT * FROM app_job_step WHERE job_id = ? ORDER BY seq').all(jobId) as JobStepRow[];
  return rows.map((r) => ({
    seq: r.seq,
    name: r.name,
    type: r.step_type,
    status: r.status,
    detail: r.detail,
    input: parseJson(r.input_json),
    output: parseJson(r.output_json),
    sourceRefs: parseJson(r.source_refs_json),
    errorMessage: r.error_message,
    elapsedMs: r.elapsed_ms,
    createdAt: r.created_at,
  }));
}

/* ============ 状态迁移(短事务) ============ */

export interface CreateJobInput {
  kind: string;
  title: string;
  input?: unknown;
  orgScopeId?: number | null;
  idempotencyKey?: string | null;
  /** 执行前重新授权时要求的操作权限 */
  permission?: Permission;
}

/** 创建任务;同一用户同一 kind 的相同幂等键返回已有任务(created=false)。 */
export function createJob(db: DB, input: CreateJobInput): { job: PublicJob; created: boolean } {
  if (!/^[a-z][a-z0-9_.]{1,63}$/.test(input.kind)) throw Errors.validation('任务类型不合法');
  const title = String(input.title ?? '').trim().slice(0, 200);
  if (!title) throw Errors.validation('任务标题不能为空');
  const ctx = currentContext();
  const userId = ctx?.auth?.userId ?? null;
  const key = input.idempotencyKey ? String(input.idempotencyKey).slice(0, 128) : null;
  const tx = db.transaction(() => {
    if (key) {
      const existing = db.prepare('SELECT * FROM app_job WHERE kind = ? AND created_by IS ? AND idempotency_key = ?').get(input.kind, userId, key) as JobRow | undefined;
      if (existing) return { row: existing, created: false };
    }
    const now = nowIso();
    const id = Number(db.prepare(`INSERT INTO app_job (kind, title, status, created_by, org_scope_id, request_id, idempotency_key, input_json, created_at, updated_at)
      VALUES (?, ?, 'queued', ?, ?, ?, ?, ?, ?, ?)`).run(
      input.kind, title, userId, input.orgScopeId ?? null, ctx?.requestId ?? '', key, compactJson(input.input), now, now,
    ).lastInsertRowid);
    writeLog(db, 'task.create', 'app_job', id, { kind: input.kind, title });
    return { row: getJobRow(db, id), created: true };
  });
  const { row, created } = tx();
  return { job: toPublicJob(row), created };
}

/** 原子抢占:仅 queued 且未请求取消的任务可置 running;返回是否抢到。 */
export function claimJob(db: DB, id: number): boolean {
  const now = nowIso();
  return db.prepare(`UPDATE app_job SET status = 'running', attempts = attempts + 1, started_at = ?, heartbeat_at = ?, updated_at = ?
    WHERE id = ? AND status = 'queued' AND cancel_requested = 0`).run(now, now, now, id).changes === 1;
}

export function reportProgress(db: DB, id: number, permille: number, message = ''): void {
  const p = Math.max(0, Math.min(1000, Math.trunc(permille)));
  const now = nowIso();
  db.prepare(`UPDATE app_job SET progress_permille = ?, progress_message = ?, heartbeat_at = ?, updated_at = ? WHERE id = ? AND status = 'running'`)
    .run(p, message.slice(0, 200), now, now, id);
}

export interface StepInput {
  name: string;
  type?: StepType;
  status?: 'success' | 'error' | 'skipped';
  detail?: string;
  input?: unknown;
  output?: unknown;
  sourceRefs?: unknown;
  errorMessage?: string;
  elapsedMs?: number;
}

export function recordStep(db: DB, jobId: number, step: StepInput): void {
  const tx = db.transaction(() => {
    const seq = ((db.prepare('SELECT MAX(seq) AS m FROM app_job_step WHERE job_id = ?').get(jobId) as { m: number | null }).m ?? 0) + 1;
    db.prepare(`INSERT INTO app_job_step (job_id, seq, name, step_type, status, detail, input_json, output_json, source_refs_json, error_message, elapsed_ms, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      jobId, seq, step.name.slice(0, 200), step.type ?? 'rule', step.status ?? 'success', (step.detail ?? '').slice(0, 2_000),
      step.input === undefined ? null : compactJson(step.input, 16_000),
      step.output === undefined ? null : compactJson(step.output, 16_000),
      step.sourceRefs === undefined ? null : compactJson(step.sourceRefs, 16_000),
      (step.errorMessage ?? '').slice(0, 2_000), step.elapsedMs ?? null, nowIso(),
    );
    db.prepare('UPDATE app_job SET heartbeat_at = ?, updated_at = ? WHERE id = ?').run(nowIso(), nowIso(), jobId);
  });
  tx();
}

function finish(db: DB, id: number, status: Exclude<JobStatus, 'queued' | 'running'>, fields: { result?: unknown; errorCode?: string; errorMessage?: string }): void {
  const now = nowIso();
  const tx = db.transaction(() => {
    const changed = db.prepare(`UPDATE app_job SET status = ?, result_json = ?, error_code = ?, error_message = ?,
      progress_permille = CASE WHEN ? = 'succeeded' THEN 1000 ELSE progress_permille END,
      finished_at = ?, heartbeat_at = ?, updated_at = ? WHERE id = ? AND status IN ('queued','running')`).run(
      status, fields.result === undefined ? null : compactJson(fields.result), fields.errorCode ?? '', (fields.errorMessage ?? '').slice(0, 2_000),
      status, now, now, now, id,
    ).changes;
    if (changed) writeLog(db, `task.${status}`, 'app_job', id, fields.errorCode ? { errorCode: fields.errorCode } : {}, status === 'succeeded' ? 'success' : 'failure');
  });
  tx();
}

export function completeJob(db: DB, id: number, result: unknown): void { finish(db, id, 'succeeded', { result }); }
export function failJob(db: DB, id: number, code: string, message: string): void { finish(db, id, 'failed', { errorCode: code, errorMessage: message }); }

/** 请求取消:排队中直接取消;运行中置 cancel_requested,由任务体在检查点响应。 */
export function requestCancel(db: DB, auth: AuthContext | undefined, id: number): PublicJob {
  const row = getJobRow(db, id);
  if (!canSeeJob(auth, row)) throw Errors.notFound('任务');
  if (TERMINAL.has(row.status)) throw new AppError('JOB_FINISHED', '任务已结束,无法取消', 409);
  if (row.status === 'queued') finish(db, id, 'cancelled', { errorCode: 'CANCELLED', errorMessage: '用户取消' });
  else db.prepare('UPDATE app_job SET cancel_requested = 1, updated_at = ? WHERE id = ?').run(nowIso(), id);
  return toPublicJob(getJobRow(db, id));
}

export function isCancelRequested(db: DB, id: number): boolean {
  return (db.prepare('SELECT cancel_requested FROM app_job WHERE id = ?').get(id) as { cancel_requested: number } | undefined)?.cancel_requested === 1;
}

/** 启动恢复:上个进程遗留的 queued/running 一律标为 interrupted,返回数量。 */
export function recoverInterruptedJobs(db: DB): number {
  const now = nowIso();
  const rows = db.prepare(`SELECT id FROM app_job WHERE status IN ('queued','running')`).all() as { id: number }[];
  if (rows.length === 0) return 0;
  const tx = db.transaction(() => {
    db.prepare(`UPDATE app_job SET status = 'interrupted', error_code = 'SERVICE_RESTARTED', error_message = '服务重启时任务未完成,请重新提交',
      finished_at = ?, updated_at = ? WHERE status IN ('queued','running')`).run(now, now);
    for (const r of rows) writeLog(db, 'task.interrupted', 'app_job', r.id, { reason: 'SERVICE_RESTARTED' }, 'failure');
  });
  tx();
  return rows.length;
}

/** 清理超过保留期的已结束任务(步骤级联删除,模型调用记录保留但解除关联)。 */
export function purgeExpiredJobs(db: DB, retentionDays: number): number {
  if (!Number.isSafeInteger(retentionDays) || retentionDays < 1) throw new Error('retentionDays must be a positive integer');
  const cutoff = new Date(Date.now() - retentionDays * 86_400_000).toISOString();
  const removed = db.prepare(`DELETE FROM app_job WHERE status IN ('succeeded','failed','cancelled','interrupted') AND finished_at IS NOT NULL AND finished_at < ?`).run(cutoff).changes;
  if (removed > 0) writeLog(db, 'task.purge', 'app_job', '-', { removed, retentionDays });
  return removed;
}

/* ============ 进程内执行器 ============ */

export class JobCancelledError extends Error {
  constructor() { super('任务已取消'); this.name = 'JobCancelledError'; }
}

export interface JobHandle {
  id: number;
  progress(permille: number, message?: string): void;
  step(step: StepInput): void;
  /** 在检查点调用:已请求取消时抛出 JobCancelledError */
  checkCancelled(): void;
}

export type JobBody = (handle: JobHandle) => Promise<unknown>;

const limit = (() => {
  const raw = Number(process.env.NEWFC_JOB_CONCURRENCY || 1);
  return Number.isSafeInteger(raw) && raw >= 1 && raw <= 8 ? raw : 1;
})();
let active = 0;
const waiting: (() => void)[] = [];

async function acquire(): Promise<() => void> {
  if (active >= limit) await new Promise<void>((resolve) => waiting.push(resolve));
  active += 1;
  return () => {
    active -= 1;
    waiting.shift()?.();
  };
}

export function jobConcurrency(): { limit: number; active: number; waiting: number } {
  return { limit, active, waiting: waiting.length };
}

/**
 * 提交并在后台执行任务体。返回任务(queued);执行结果写回任务表。
 * 任务体在创建者上下文中运行(source='task',带 jobId),其模型调用与审计据此关联。
 */
export function submitJob(db: () => DB, input: CreateJobInput, body: JobBody): { job: PublicJob; created: boolean; done: Promise<void> } {
  const { job, created } = createJob(db(), input);
  if (!created) return { job, created, done: Promise.resolve() };
  const parent = currentContext();
  const done = (async () => {
    const release = await acquire();
    try {
      // 执行前重新授权:排队期间用户可能被停用、改角色或改组织范围
      const auth = parent?.auth ? loadAuthContext(db(), parent.auth.userId, parent.auth.sessionId) : undefined;
      const ctx = { requestId: parent?.requestId ?? '', source: 'task' as const, ip: parent?.ip, auth: auth ?? undefined, jobId: job.id };
      await runWithContext(ctx, async () => {
        if (!claimJob(db(), job.id)) return; // 排队期间已取消
        if (parent?.auth && (!auth || (input.permission && !auth.permissions.has(input.permission)))) {
          failJob(db(), job.id, 'AUTH_REVOKED', '提交者已停用或已失去执行该任务的权限');
          return;
        }
        if (auth && input.orgScopeId != null && !auth.allOrgs && !orgInScope(resolveOrgScope(db(), auth), input.orgScopeId)) {
          failJob(db(), job.id, 'AUTH_REVOKED', '提交者已失去该组织的数据范围');
          return;
        }
        const handle: JobHandle = {
          id: job.id,
          progress: (p, m) => reportProgress(db(), job.id, p, m),
          step: (s) => recordStep(db(), job.id, s),
          checkCancelled: () => { if (isCancelRequested(db(), job.id)) throw new JobCancelledError(); },
        };
        try {
          const result = await body(handle);
          completeJob(db(), job.id, result);
        } catch (error) {
          if (error instanceof JobCancelledError) {
            finish(db(), job.id, 'cancelled', { errorCode: 'CANCELLED', errorMessage: '用户取消' });
          } else {
            const code = error instanceof AppError ? error.code : 'JOB_FAILED';
            const message = error instanceof AppError ? error.message : '任务执行失败';
            failJob(db(), job.id, code, message);
            if (!(error instanceof AppError)) console.error(`[job ${job.id}] ${input.kind} 失败:`, error);
          }
        }
      });
    } catch (error) {
      // 数据库已关闭等基础设施失败:任务状态无法写回,留给下次启动恢复为 interrupted
      console.error(`[job ${job.id}] 无法写回任务状态:`, error);
    } finally {
      release();
    }
  })();
  return { job, created, done };
}
