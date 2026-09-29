/**
 * AC-F21 agent_observability:成功/失败/取消/中断可区分,重启不丢任务状态;模型调用可观测且不含正文。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { openDatabase, type DB } from '../src/db/connection';
import { applyMigrations } from '../src/db/migrations';
import { AppError } from '../src/core/errors';
import { runWithContext, systemContext } from '../src/core/request-context';
import { loadAuthContext, ensureBuiltinRoles, updateUser } from '../src/modules/security/security.service';
import { buildFixture } from './helpers';
import { createJob, claimJob, getJobRow, jobConcurrency, listSteps, submitJob } from '../src/modules/jobs/job.service';
import { insertModelCall, listModelCalls, modelCallStats } from '../src/modules/jobs/model-calls';
import { EnvChatModel, classifyModelError, estimateTokens, setChannelResolver, setModelCallRecorder } from '../src/assistant/model';
import { createTestApp, createScopedUser, ensureAdmin, fetchAs } from './http-helpers';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

function tempDb(): { db: DB; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'newfc-jobs-'));
  const file = path.join(dir, 'newfc.sqlite');
  const db = openDatabase(file);
  applyMigrations(db);
  ensureBuiltinRoles(db);
  cleanups.push(() => { try { db.close(); } catch { /* closed */ } });
  return { db, file };
}

function asUser<T>(db: DB, userId: number, fn: () => T): T {
  return runWithContext({ requestId: 'req-test-0001', source: 'http', auth: loadAuthContext(db, userId)! }, fn);
}

describe('持久任务生命周期', () => {
  it('成功任务:步骤、进度、结果、审计与创建者上下文', async () => {
    const { db } = tempDb();
    const adminId = ensureAdmin(db);
    let seenJobId: number | undefined;
    const { job, done } = asUser(db, adminId, () => submitJob(() => db, { kind: 'report.generate', title: '生成月报', input: { month: '2026-08', apiKey: 'sk-should-hide' } }, async (h) => {
      h.step({ name: '读取数据', type: 'tool', output: { rows: 3 }, sourceRefs: [{ type: 'table', name: 'budget_entry' }] });
      h.progress(500, '已读取');
      seenJobId = (await import('../src/core/request-context')).currentContext()?.jobId;
      return { pages: 2 };
    }));
    expect(job.status).toBe('queued');
    await done;
    const row = getJobRow(db, job.id);
    expect(row).toMatchObject({ status: 'succeeded', progress_permille: 1000, created_by: adminId, request_id: 'req-test-0001', attempts: 1 });
    expect(JSON.parse(row.result_json!)).toEqual({ pages: 2 });
    expect(row.input_json).not.toContain('sk-should-hide');
    expect(seenJobId).toBe(job.id);
    expect(listSteps(db, job.id)).toMatchObject([{ seq: 1, name: '读取数据', type: 'tool', status: 'success', output: { rows: 3 } }]);
    const audit = db.prepare("SELECT actor, result, source FROM operation_log WHERE action = 'task.succeeded' AND entity_id = ?").get(String(job.id));
    expect(audit).toMatchObject({ actor: 'test-admin', result: 'success', source: 'task' });
  });

  it('失败任务:业务错误保留错误码,未知异常不外泄内部信息', async () => {
    const { db } = tempDb();
    const a = runWithContext(systemContext('cli'), () => submitJob(() => db, { kind: 'import.run', title: 'A' }, async () => { throw new AppError('IMPORT_VALIDATION_FAILED', '第 3 行组织不存在', 400); }));
    const b = runWithContext(systemContext('cli'), () => submitJob(() => db, { kind: 'import.run', title: 'B' }, async () => { throw new Error('SQLITE_BUSY at /root/newfc/x.ts:12'); }));
    await Promise.all([a.done, b.done]);
    expect(getJobRow(db, a.job.id)).toMatchObject({ status: 'failed', error_code: 'IMPORT_VALIDATION_FAILED', error_message: '第 3 行组织不存在' });
    expect(getJobRow(db, b.job.id)).toMatchObject({ status: 'failed', error_code: 'JOB_FAILED', error_message: '任务执行失败' });
  });

  it('幂等键:同一用户同类任务重复提交返回原任务,不重复执行', async () => {
    const { db } = tempDb();
    const adminId = ensureAdmin(db);
    let runs = 0;
    const body = async () => { runs += 1; return {}; };
    const first = asUser(db, adminId, () => submitJob(() => db, { kind: 'forecast.recalc', title: '重算', idempotencyKey: 'k-1' }, body));
    const second = asUser(db, adminId, () => submitJob(() => db, { kind: 'forecast.recalc', title: '重算', idempotencyKey: 'k-1' }, body));
    await Promise.all([first.done, second.done]);
    expect(second.created).toBe(false);
    expect(second.job.id).toBe(first.job.id);
    expect(runs).toBe(1);
  });

  it('并发有界:同时提交多个任务,同时运行数不超过上限', async () => {
    const { db } = tempDb();
    const { limit } = jobConcurrency();
    let running = 0;
    let peak = 0;
    const handles = Array.from({ length: limit + 3 }, (_, i) => runWithContext(systemContext('cli'), () => submitJob(() => db, { kind: 'knowledge.index', title: `索引 ${i}` }, async () => {
      running += 1;
      peak = Math.max(peak, running);
      await new Promise((r) => setTimeout(r, 20));
      running -= 1;
      return {};
    })));
    await Promise.all(handles.map((h) => h.done));
    expect(peak).toBeLessThanOrEqual(limit);
    expect(handles.every((h) => getJobRow(db, h.job.id).status === 'succeeded')).toBe(true);
    expect(jobConcurrency()).toMatchObject({ active: 0, waiting: 0 });
  });

  it('执行前重新授权:排队期间停用、失去权限或组织范围的任务以 AUTH_REVOKED 失败,不执行任务体', async () => {
    const { db } = tempDb();
    ensureAdmin(db);
    const fx = runWithContext(systemContext('cli'), () => buildFixture(db));
    const { limit } = jobConcurrency();
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const blockers = Array.from({ length: limit }, (_, i) => runWithContext(systemContext('cli'), () => submitJob(() => db, { kind: 'demo.block', title: `占位 ${i}` }, async () => { await gate; return {}; })));
    const disabled = createScopedUser(db, { username: 'job-disabled', roleCodes: ['data_maintainer'], allOrgs: true });
    const demoted = createScopedUser(db, { username: 'job-demoted', roleCodes: ['data_maintainer'], allOrgs: true });
    const moved = createScopedUser(db, { username: 'job-moved', roleCodes: ['data_maintainer'], orgIds: [fx.orgIds.east] });
    const kept = createScopedUser(db, { username: 'job-kept', roleCodes: ['data_maintainer'], orgIds: [fx.orgIds.east] });
    const ran: string[] = [];
    const submit = (userId: number, name: string, orgScopeId?: number) => asUser(db, userId, () => submitJob(() => db, { kind: 'import.run', title: name, permission: 'import:run', orgScopeId }, async () => { ran.push(name); return {}; }));
    const a = submit(disabled.userId, 'disabled');
    const b = submit(demoted.userId, 'demoted');
    const c = submit(moved.userId, 'moved', fx.orgIds.shanghai);
    const d = submit(kept.userId, 'kept', fx.orgIds.shanghai);
    const viewerRole = (db.prepare("SELECT id FROM app_role WHERE code = 'viewer'").get() as { id: number }).id;
    runWithContext(systemContext('cli'), () => {
      updateUser(db, disabled.userId, { status: 'disabled' });
      updateUser(db, demoted.userId, { roleIds: [viewerRole] });
      updateUser(db, moved.userId, { orgIds: [fx.orgIds.west] });
    });
    release();
    await Promise.all([...blockers, a, b, c, d].map((h) => h.done));
    for (const h of [a, b, c]) expect(getJobRow(db, h.job.id)).toMatchObject({ status: 'failed', error_code: 'AUTH_REVOKED' });
    expect(getJobRow(db, d.job.id).status).toBe('succeeded');
    expect(ran).toEqual(['kept']);
  });
});

describe('任务 HTTP:取消、可见性与重启恢复', () => {
  it('运行中任务在检查点响应取消;排队任务直接取消;已结束任务不可取消', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'newfc-jobs-http-'));
    const { app, holder, session } = await createTestApp({ dbPath: path.join(dir, 'newfc.sqlite') });
    const server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    cleanups.push(async () => { await new Promise<void>((r) => server.close(() => r())); holder.getDb().close(); });
    const db = holder.getDb();
    const adminId = ensureAdmin(db);

    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    const running = asUser(db, adminId, () => submitJob(() => db, { kind: 'report.generate', title: '长任务' }, async (h) => {
      await gate;
      h.checkCancelled();
      return { never: true };
    }));
    await new Promise((r) => setTimeout(r, 10));
    expect(getJobRow(db, running.job.id).status).toBe('running');
    const cancel = await fetchAs(session, `${base}/api/jobs/${running.job.id}/cancel`, { method: 'POST' });
    expect(cancel.status).toBe(200);
    expect(await cancel.json()).toMatchObject({ status: 'running', cancelRequested: true });
    release();
    await running.done;
    expect(getJobRow(db, running.job.id)).toMatchObject({ status: 'cancelled', error_code: 'CANCELLED' });
    const again = await fetchAs(session, `${base}/api/jobs/${running.job.id}/cancel`, { method: 'POST' });
    expect(again.status).toBe(409);

    const queued = asUser(db, adminId, () => createJob(db, { kind: 'report.generate', title: '排队中' }));
    const cq = await fetchAs(session, `${base}/api/jobs/${queued.job.id}/cancel`, { method: 'POST' });
    expect(await cq.json()).toMatchObject({ status: 'cancelled' });
    expect(claimJob(db, queued.job.id)).toBe(false);
  });

  it('他人任务 404;持有 tasks:read 的全组织用户可见;列表只含本人任务', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'newfc-jobs-http-'));
    const { app, holder, session } = await createTestApp({ dbPath: path.join(dir, 'newfc.sqlite') });
    const server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    cleanups.push(async () => { await new Promise<void>((r) => server.close(() => r())); holder.getDb().close(); });
    const db = holder.getDb();
    const viewer = createScopedUser(db, { username: 'viewer-jobs', roleCodes: ['viewer'], allOrgs: true });
    const mine = asUser(db, viewer.userId, () => createJob(db, { kind: 'report.generate', title: '我的' }));
    const adminId = ensureAdmin(db);
    const others = asUser(db, adminId, () => createJob(db, { kind: 'report.generate', title: '管理员的' }));

    expect((await fetchAs(viewer.session, `${base}/api/jobs/${others.job.id}`)).status).toBe(404);
    const list = await (await fetchAs(viewer.session, `${base}/api/jobs`)).json() as { items: { id: number }[] };
    expect(list.items.map((i) => i.id)).toEqual([mine.job.id]);
    expect((await fetchAs(viewer.session, `${base}/api/model-calls`)).status).toBe(403);
    // 管理员(tasks:read + 全部组织)可见全部
    expect((await fetchAs(session, `${base}/api/jobs/${mine.job.id}`)).status).toBe(200);
    const all = await (await fetchAs(session, `${base}/api/jobs`)).json() as { total: number };
    expect(all.total).toBe(2);
  });

  it('重启:上个进程遗留的 queued/running 标记为 interrupted,已完成任务不变', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'newfc-jobs-restart-'));
    const dbPath = path.join(dir, 'newfc.sqlite');
    const first = await createTestApp({ dbPath });
    const db = first.holder.getDb();
    const adminId = ensureAdmin(db);
    const q = asUser(db, adminId, () => createJob(db, { kind: 'import.run', title: '排队' }));
    const r = asUser(db, adminId, () => createJob(db, { kind: 'import.run', title: '运行' }));
    claimJob(db, r.job.id);
    const ok = asUser(db, adminId, () => submitJob(() => db, { kind: 'import.run', title: '已完成' }, async () => ({ ok: 1 })));
    await ok.done;
    db.close();

    const second = await createTestApp({ dbPath });
    const server = second.app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    cleanups.push(async () => { await new Promise<void>((res) => server.close(() => res())); second.holder.getDb().close(); });
    for (const id of [q.job.id, r.job.id]) {
      const body = await (await fetchAs(second.session, `${base}/api/jobs/${id}`)).json();
      expect(body).toMatchObject({ status: 'interrupted', error: { code: 'SERVICE_RESTARTED' } });
    }
    expect(await (await fetchAs(second.session, `${base}/api/jobs/${ok.job.id}`)).json()).toMatchObject({ status: 'succeeded', result: { ok: 1 } });
  });
});

describe('模型调用观测', () => {
  const envKeys = ['AI_BASE_URL', 'AI_API_KEY', 'AI_STREAM', 'AI_TIMEOUT_MS', 'AI_TOTAL_TIMEOUT_MS'] as const;
  const saved = new Map(envKeys.map((k) => [k, process.env[k]]));
  afterEach(() => {
    for (const k of envKeys) { const v = saved.get(k); if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.unstubAllGlobals();
    setModelCallRecorder(null);
    setChannelResolver(null);
  });

  const completion = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('成功调用记录供应商 usage;失败按超时/HTTP/非法响应分类;正文与密钥不落库', async () => {
    const { db } = tempDb();
    const adminId = ensureAdmin(db);
    setChannelResolver(null);
    setModelCallRecorder((r) => insertModelCall(db, r));
    process.env.AI_BASE_URL = 'https://model.example.com/v1';
    process.env.AI_API_KEY = 'sk-live-secret-123456';
    process.env.AI_STREAM = '0';
    const secretPrompt = '机密问题:本年度上海公司利润是多少';

    vi.stubGlobal('fetch', vi.fn(async () => completion({ choices: [{ message: { content: '利润为 12.00 元' } }], usage: { prompt_tokens: 42, completion_tokens: 7 } })));
    await asUser(db, adminId, () => new EnvChatModel('chat').complete({ messages: [{ role: 'user', content: secretPrompt }] }));

    vi.stubGlobal('fetch', vi.fn(async () => completion({ error: 'boom' }, 503)));
    await expect(asUser(db, adminId, () => new EnvChatModel('narrative').complete({ messages: [{ role: 'user', content: 'x' }] }))).rejects.toThrow();

    vi.stubGlobal('fetch', vi.fn(async () => new Response('not json', { status: 200 })));
    await expect(asUser(db, adminId, () => new EnvChatModel('narrative').complete({ messages: [{ role: 'user', content: 'x' }] }))).rejects.toThrow();

    const calls = listModelCalls(db).items.reverse();
    expect(calls).toHaveLength(3);
    expect(calls[0]).toMatchObject({ feature: 'chat', status: 'success', promptTokens: 42, completionTokens: 7, tokensEstimated: false, actorUserId: adminId, requestId: 'req-test-0001', source: 'http' });
    expect(calls[1]).toMatchObject({ feature: 'narrative', status: 'error', errorType: 'http_5xx' });
    expect(calls[2]).toMatchObject({ status: 'error', errorType: 'invalid_response' });
    const dump = JSON.stringify(db.prepare('SELECT * FROM ai_model_call').all());
    expect(dump).not.toContain('机密问题');
    expect(dump).not.toContain('利润为');
    expect(dump).not.toContain('sk-live-secret');
    const stats = modelCallStats(db) as { feature: string; status: string; calls: number; reportedTokens: number }[];
    expect(stats.find((s) => s.feature === 'chat')).toMatchObject({ status: 'success', calls: 1, reportedTokens: 49 });
  });

  it('流式调用无 usage 时按字符估算;调用方中途停止记为 cancelled;任务内调用关联 job_id', async () => {
    const { db } = tempDb();
    setChannelResolver(null);
    setModelCallRecorder((r) => insertModelCall(db, r));
    process.env.AI_BASE_URL = 'https://model.example.com/v1';
    process.env.AI_STREAM = '1';
    const sse = (parts: string[]) => new Response(new ReadableStream({
      start(controller) {
        for (const p of parts) controller.enqueue(new TextEncoder().encode(`data: ${JSON.stringify({ choices: [{ delta: { content: p } }] })}\n\n`));
        controller.enqueue(new TextEncoder().encode('data: [DONE]\n\n'));
        controller.close();
      },
    }), { status: 200, headers: { 'content-type': 'text/event-stream' } });
    vi.stubGlobal('fetch', vi.fn(async () => sse(['你好', '，世界'])));

    const job = runWithContext(systemContext('cli'), () => submitJob(() => db, { kind: 'assistant.narrative', title: '叙述' }, async () => {
      let text = '';
      for await (const ev of new EnvChatModel('narrative').streamChat({ messages: [{ role: 'user', content: '写一段话' }] })) if (ev.type === 'text') text += ev.text;
      return { text };
    }));
    await job.done;

    vi.stubGlobal('fetch', vi.fn(async () => sse(['第一段', '第二段', '第三段'])));
    for await (const ev of new EnvChatModel('chat').streamChat({ messages: [{ role: 'user', content: 'q' }] })) { void ev; break; }

    const [stopped, streamed] = listModelCalls(db).items as Record<string, unknown>[];
    expect(streamed).toMatchObject({ feature: 'narrative', stream: true, status: 'success', tokensEstimated: true, jobId: job.job.id, source: 'task' });
    expect(streamed.completionTokens).toBe(estimateTokens('你好，世界'));
    expect(stopped).toMatchObject({ feature: 'chat', status: 'cancelled', errorType: 'consumer_stopped' });
  });

  it('未配置模型时走模板,不产生模型调用记录;错误分类覆盖取消与网络', async () => {
    const { db } = tempDb();
    setModelCallRecorder((r) => insertModelCall(db, r));
    delete process.env.AI_BASE_URL;
    const result = await new EnvChatModel('chat').complete({ messages: [{ role: 'user', content: 'hi' }] });
    expect(result.model).toBe('template');
    expect(listModelCalls(db).total).toBe(0);
    const abort = new Error('客户端已取消请求'); abort.name = 'AbortError';
    expect(classifyModelError(abort)).toEqual({ status: 'cancelled', errorType: 'cancelled' });
    expect(classifyModelError(new Error('AI 模型请求超时(等待响应超过 15000ms)'))).toEqual({ status: 'timeout', errorType: 'timeout' });
    expect(classifyModelError(new Error('AI 模型请求失败: fetch failed'))).toEqual({ status: 'error', errorType: 'network' });
    expect(classifyModelError(new Error('AI provider returned 401: bad key'))).toEqual({ status: 'error', errorType: 'http_4xx' });
  });
});
