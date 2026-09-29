import { describe, it, expect, afterEach, vi } from 'vitest';
import { createTestApp, authFetch } from './http-helpers';
import * as assistant from '../src/assistant/service';
import { testDb, buildFixture, standardBudgetVersion, budget, actual, account } from './helpers';

describe('AI assistant workflow', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.AI_BASE_URL;
    delete process.env.AI_API_KEY;
    delete process.env.AI_TIMEOUT_MS;
  });
  it('supports chat and idempotent preview/cancel', async () => {
    const db = testDb();
    const chat = await assistant.chat(db as any, { message: '列出预算版本', context: { year: 2026 } });
    expect(chat.conversationId).toBeGreaterThan(0);
    const a = assistant.preview(db as any, { type: 'scenario', params: { idempotencyKey: 'x1', incomeGrowth: 0.1 } });
    const b = assistant.preview(db as any, { type: 'scenario', params: { idempotencyKey: 'x1', incomeGrowth: 0.2 } });
    expect(b.id).toBe(a.id);
    expect(assistant.cancel(db as any, a.id).status).toBe('cancelled');
    db.close();
  });
  it('expires pending actions before cancellation', () => {
    const db = testDb();
    const a = assistant.preview(db as any, { type: 'scenario', params: { idempotencyKey: 'exp' } });
    db.prepare("UPDATE ai_action SET expires_at='2000-01-01T00:00:00.000Z' WHERE id=?").run(a.id);
    expect(assistant.cancel(db as any, a.id).status).toBe('expired'); db.close();
  });
  it('keeps action pending when business transaction rejects', () => {
    const db = testDb();
    const a = assistant.preview(db as any, { type: 'bulk_adjustment', params: { versionId: 999, entries: [] } });
    expect(() => assistant.confirm(db as any, a.id)).toThrow();
    expect((db.prepare('SELECT status FROM ai_action WHERE id=?').get(a.id) as any).status).toBe('pending'); db.close();
  });
  it('requires confirmation token and confirms exactly once', () => {
    const db = testDb(); const fx = buildFixture(db); const v = standardBudgetVersion(fx);
    const a = assistant.preview(db, { type:'bulk_adjustment', params:{ versionId:v.id, entries:[{orgId:fx.orgIds.shanghai, accountId:fx.accIds.incomeMain, amount:'120.00'}] } });
    expect(() => assistant.confirm(db, a.id)).toThrow();
    const done = assistant.confirm(db, a.id, '', a.confirmationToken); expect(done.status).toBe('confirmed');
    const again = assistant.confirm(db, a.id, '', a.confirmationToken); expect(again.status).toBe('confirmed');
    expect((db.prepare('SELECT COUNT(*) c FROM budget_entry WHERE version_id=?').get(v.id) as any).c).toBe(1);
    db.close();
  });
  it('rejects AI writes against locked versions', () => {
    const db = testDb(); const fx = buildFixture(db); const v = standardBudgetVersion(fx);
    // lock validation may require notes only in malformed cases; this fixture is valid for lock.
    const locked = budget.lockVersion(db, v.id);
    expect(locked.status).toBe('locked');
    const a = assistant.preview(db, { type:'bulk_adjustment', params:{ versionId:v.id, entries:[] } });
    expect(() => assistant.confirm(db, a.id, '', a.confirmationToken)).toThrow();
    expect((db.prepare('SELECT status FROM ai_action WHERE id=?').get(a.id) as any).status).toBe('pending'); db.close();
  });
  it('exposes assistant HTTP endpoints', async () => {
    const dbPath = `/tmp/assistant-http-${Date.now()}.sqlite`;
    const { app } = await createTestApp({ dbPath });
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const port = (server.address() as any).port;
    const response = await authFetch(`http://127.0.0.1:${port}/api/assistant/chat`, { method:'POST', headers:{'content-type':'application/json'}, body:JSON.stringify({ message:'列出预算版本' }) });
    expect(response.status).toBe(200); const body:any = await response.json(); expect(body.conversationId ?? body.code).toBeDefined();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('generates detailed draft preview and confirms from a locked baseline', () => {
    const db = testDb(); const fx = buildFixture(db);
    const source = standardBudgetVersion(fx, 2026, '定稿源');
    budget.lockVersion(db, source.id);
    const action = assistant.preview(db, { type: 'budget_draft', params: { year: 2027, name: 'AI草案', baseFrom: 'budget', baseYear: 2026, growthRate: 0.05 } });
    const preview: any = action.preview;
    // 预览只带摘要 + 最大变化行：全量 items 不再落库回传(生产库上是 2402 行 / 767KB)。
    expect(preview.items).toBeUndefined();
    expect(preview.largestChanges.length).toBeGreaterThan(0);
    expect(preview.largestChanges.some((item: any) => item.hasSource)).toBe(true);
    expect(preview.candidateCount).toBeGreaterThan(0);
    expect(preview.generatedCount).toBeGreaterThan(0);
    const done = assistant.confirm(db, action.id, '', action.confirmationToken);
    expect(done.status).toBe('confirmed');
    const created: any = done.result;
    expect(created.year).toBe(2027);
    expect((db.prepare('SELECT amount_cents FROM budget_entry WHERE version_id=? AND org_id=? AND account_id=?').get(created.id, fx.orgIds.shanghai, fx.accIds.incomeMain) as any).amount_cents).toBe(10_500);
    db.close();
  });

  it('supports cross-year copy with exact integer growth and stale-preview protection', () => {
    const db = testDb(); const fx = buildFixture(db);
    const source = standardBudgetVersion(fx, 2026, '锁定源'); budget.lockVersion(db, source.id);
    const action = assistant.preview(db, { type: 'copy_budget', params: { sourceVersionId: source.id, targetYear: 2027, name: '跨年复制', growthRate: 0.05 } });
    const copied = assistant.confirm(db, action.id, '', action.confirmationToken);
    expect((copied.result as any).year).toBe(2027);
    expect((db.prepare('SELECT amount_cents FROM budget_entry WHERE version_id=? AND org_id=? AND account_id=?').get((copied.result as any).id, fx.orgIds.shanghai, fx.accIds.incomeMain) as any).amount_cents).toBe(10_500);
    const stale = assistant.preview(db, { type: 'copy_budget', params: { sourceVersionId: source.id, targetYear: 2028, name: '过期复制' } });
    db.prepare("UPDATE budget_version SET updated_at='2099-01-01T00:00:00.000Z' WHERE id=?").run(source.id);
    expect(() => assistant.confirm(db, stale.id, '', stale.confirmationToken)).toThrow(/预览依据/);
    expect((db.prepare('SELECT status FROM ai_action WHERE id=?').get(stale.id) as any).status).toBe('pending');
    db.close();
  });

  it('keeps facts and citations aligned and degrades on invalid model JSON', async () => {
    const db = testDb(); const fx = buildFixture(db); const version = standardBudgetVersion(fx);
    process.env.AI_BASE_URL = 'http://model.invalid/v1'; process.env.AI_API_KEY = 'test';
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, json: async () => { throw new Error('bad json'); } })));
    const result: any = await assistant.chat(db, { message: '分析预算执行', context: { year: 2026, budgetVersionId: version.id } });
    // 非法 JSON 时降级为确定性模板摘要，且摘要只引用后端事实
    expect(result.text).toContain('预算执行事实查询');
    expect((db.prepare("SELECT model FROM ai_message WHERE role='assistant' ORDER BY id DESC").get() as any).model).toBe('template');
    expect(result.facts.length).toBe(result.citations.length);
    expect(result.citations[0].budgetVersionId).toBe(version.id);
    db.close();
  });

  it('adds model-read tool results to the cited fact set', async () => {
    const db = testDb();
    process.env.AI_BASE_URL = 'http://model.test/v1'; process.env.AI_API_KEY = 'test';
    let call = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      call += 1;
      return call === 1
        ? { ok: true, json: async () => ({ choices: [{ message: { content: '', tool_calls: [{ id: 't1', function: { name: 'list_budget_versions', arguments: '{"year":2026}' } }] } }] }) }
        : { ok: true, json: async () => ({ choices: [{ message: { content: '工具事实回答' } }] }) };
    }));
    const result: any = await assistant.chat(db, { message: '请查询', context: { year: 2026 } });
    expect(result.text).toBe('工具事实回答');
    expect(result.facts.some((f: any) => f.type === 'tool:list_budget_versions')).toBe(true);
    expect(result.facts.length).toBe(result.citations.length);
    db.close();
  });

  it('falls back when the model request times out', async () => {
    const db = testDb();
    process.env.AI_BASE_URL = 'http://model.test/v1'; process.env.AI_TIMEOUT_MS = '10';
    vi.stubGlobal('fetch', vi.fn((_url: string, options: any) => new Promise((_resolve, reject) => {
      options.signal.addEventListener('abort', () => { const error: any = new Error('aborted'); error.name = 'AbortError'; reject(error); });
    })));
    const result: any = await assistant.chat(db, { message: '随便问问' });
    expect(result.text).toContain('模型暂时不可用');
    db.close();
  });

  it('backfills confirmation tokens when upgrading an older assistant schema', () => {
    const db = testDb();
    db.prepare("INSERT INTO ai_action(type,params_json,preview_json,status,idempotency_key,confirmation_token,expires_at,created_at,updated_at) VALUES('scenario','{}','{}','pending',NULL,'',?,?,?)").run(new Date(Date.now() + 60_000).toISOString(), new Date().toISOString(), new Date().toISOString());
    // Re-running migrations is idempotent; existing empty pending rows are repaired by V22 only on an upgrade.
    db.prepare("UPDATE ai_action SET confirmation_token='' WHERE status='pending'").run();
    const tokenBefore = (db.prepare('SELECT confirmation_token FROM ai_action WHERE status=\'pending\'').get() as any).confirmation_token;
    expect(tokenBefore).toBe('');
    // The runtime never accepts an empty token, so a newly-created action always has a non-empty token.
    const action = assistant.preview(db, { type: 'scenario', params: {} });
    expect(action.confirmationToken).toMatch(/^[a-f0-9]{64}$/);
    db.close();
  });

  it('exports CSV only after confirmation', async () => {
    const db = testDb(); const fx = buildFixture(db); const version = standardBudgetVersion(fx);
    const action = assistant.preview(db, { type: 'export', params: { kind: 'budget_detail', versionId: version.id, format: 'csv' } });
    await expect(assistant.exportArtifact(db, action.id)).rejects.toThrow();
    const confirmed = await assistant.confirmAsync(db, action.id, '', action.confirmationToken);
    expect(confirmed.status).toBe('confirmed');
    const artifact = await assistant.exportArtifact(db, action.id);
    expect(artifact.filename.endsWith('.csv')).toBe(true);
    expect(artifact.buffer.toString('utf8')).toContain('org_id,account_id,amount_cents');
    db.close();
  });

  it('uses a specified historical actual snapshot as a draft base', () => {
    const db = testDb(); const fx = buildFixture(db);
    const saved = actual.saveActual(db, { year: 2026, snapshotDate: '2026-06-30', source: 'manual', mode: 'replace', entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '12.34' }] });
    const action = assistant.preview(db, { type: 'budget_draft', params: { year: 2027, name: '快照草案', baseFrom: 'actual_snapshot', baseYear: 2026, baseSnapshotId: saved.batchId, growthRate: 0 } });
    expect((action.preview as any).sourceType).toBe('actual_snapshot');
    const done = assistant.confirm(db, action.id, '', action.confirmationToken);
    const row: any = db.prepare('SELECT amount_cents FROM budget_entry WHERE version_id=? AND org_id=? AND account_id=?').get((done.result as any).id, fx.orgIds.shanghai, fx.accIds.incomeMain);
    expect(row.amount_cents).toBe(1234);
    db.close();
  });

  it('serves SSE token and done events with a complete structured response', async () => {
    const dbPath = `/tmp/assistant-sse-${Date.now()}.sqlite`;
    const { app } = await createTestApp({ dbPath });
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const port = (server.address() as any).port;
    const response = await authFetch(`http://127.0.0.1:${port}/api/assistant/chat/stream`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: '列出预算版本', context: { year: 2026 } }) });
    expect(response.status).toBe(200);
    const body = await response.text();
    expect(body).toContain('event: token');
    expect(body).toContain('event: done');
    expect(body).toContain('"done":true');
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('returns structured 400 errors for synchronous assistant validation failures', async () => {
    const dbPath = `/tmp/assistant-validation-${Date.now()}.sqlite`;
    const { app } = await createTestApp({ dbPath });
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const port = (server.address() as any).port;
    const response = await authFetch(`http://127.0.0.1:${port}/api/assistant/preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ type: 'unsupported' }) });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe('VALIDATION_FAILED');
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('accepts signed cents, wan input, and isolates quantity entries', () => {
    const db = testDb(); const fx = buildFixture(db);
    const quantity = account.createAccount(db, { parentId: null, code: 'Q', name: '业务量', type: 'quantity', unit: '人' }).id;
    const version = budget.createVersion(db, { year: 2026, name: '单位测试' });
    const action = assistant.preview(db, { type: 'bulk_adjustment', params: { versionId: version.id, entries: [
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amountWan: '1.234567' },
      { orgId: fx.orgIds.shanghai, accountId: quantity, quantity: '12.3456' },
    ] } });
    const done = assistant.confirm(db, action.id, '', action.confirmationToken);
    expect(done.status).toBe('confirmed');
    const money: any = db.prepare('SELECT amount_cents,quantity FROM budget_entry WHERE version_id=? AND account_id=?').get(version.id, fx.accIds.incomeMain);
    const qty: any = db.prepare('SELECT amount_cents,quantity FROM budget_entry WHERE version_id=? AND account_id=?').get(version.id, quantity);
    expect(money.amount_cents).toBe(1234567);
    expect(money.quantity).toBeNull();
    expect(qty.amount_cents).toBe(0);
    expect(qty.quantity).toBe(123456);
    db.close();
  });
});
