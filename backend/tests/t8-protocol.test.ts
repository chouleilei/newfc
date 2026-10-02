import { afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import type { Server } from 'node:http';
import { openDatabase, openReadonlyDatabase, type DB } from '../src/db/connection';
import { applyMigrations, appliedMigrations } from '../src/db/migrations';
import { createBackup, restoreBackup, verifyBackupBundle } from '../src/modules/backup/backup.service';
import { parseChatRequest } from '../src/assistant/schemas';
import { createTestApp, authFetch, ensureAdmin } from './http-helpers';
import { pageSnapshot } from './assistant-context';
import { buildFixture, standardBudgetVersion } from './helpers';
import { chat } from '../src/assistant/service';
import { runWithContext } from '../src/core/request-context';
import type { AuthContext } from '../src/core/request-context';

const cleanups: (() => void | Promise<void>)[] = [];
afterEach(async () => { vi.unstubAllGlobals(); vi.unstubAllEnvs(); while (cleanups.length) await cleanups.pop()!(); });
function historicalDb() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'newfc-t8-history-'));
  let db = openDatabase(path.join(dir, 'fixture.sqlite'));
  applyMigrations(db, 65);
  const now = '2026-10-02T12:00:00Z';
  db.prepare('INSERT INTO ai_conversation(id,title,created_at,updated_at) VALUES(1,?,?,?)').run('历史', now, now);
  const insert = (response: unknown, content = '历史回答') => Number(db.prepare("INSERT INTO ai_message(conversation_id,role,content,response_json,created_at) VALUES(1,'assistant',?,?,?)").run(content, JSON.stringify(response), now).lastInsertRowid);
  cleanups.push(() => { if (db.open) db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  return { dir, dbPath: path.join(dir, 'fixture.sqlite'), get db() { return db; }, insert, handle: { getDb: () => db, reopenWith: (value: DB) => { db = value; } } };
}

describe('T-8.3 / AC-T8-04 唯一协议与 HTTP/SSE 预检', () => {
  it('共享 schema 只接受快照，拒绝旧单传/双传/缺失/未知版本', () => {
    expect(parseChatRequest({ message: '解释口径', pageContext: pageSnapshot() }).pageContext.pageKey).toBe('assistant');
    for (const value of [{ message: '解释', context: {} }, { message: '解释', context: {}, pageContext: pageSnapshot() }, { message: '解释' }]) {
      expect(() => parseChatRequest(value)).toThrow(expect.objectContaining({ code: 'CONTEXT_INVALID' }));
    }
    expect(() => parseChatRequest({ message: '解释', pageContext: { ...pageSnapshot(), schemaVersion: 3 } })).toThrow(expect.objectContaining({ code: 'CONTEXT_PROTOCOL_UNSUPPORTED', status: 409 }));
  });
  it('格式与数据库冲突在 SSE 响应头前拒绝，且不落会话或调用账本', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'newfc-t8-http-'));
    const { app, holder } = await createTestApp({ dbPath: path.join(dir, 'fixture.sqlite') });
    const server: Server = app.listen(0);
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    cleanups.push(async () => { await new Promise<void>((done) => server.close(() => done())); holder.getDb().close(); fs.rmSync(dir, { recursive: true, force: true }); });
    const db = holder.getDb();
    const version = standardBudgetVersion(buildFixture(db));
    const invalid = [
      { message: '解释', context: {} }, { message: '解释', context: {}, pageContext: pageSnapshot() }, { message: '解释' },
      { message: '解释', pageContext: { ...pageSnapshot(), schemaVersion: 1 } },
      { message: '解释', pageContext: { ...pageSnapshot(), pageKey: 'unknown' } },
      { message: '解释', pageContext: pageSnapshot({ year: 2025, budgetVersionId: version.id }) },
      { message: '解释', pageContext: pageSnapshot({ budgetVersionId: 999999 }) },
    ];
    for (const endpoint of ['chat', 'chat/stream']) for (const [i, body] of invalid.entries()) {
      const response = await authFetch(`${base}/api/assistant/${endpoint}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
      expect(response.status).toBe(i === 3 || i === 5 ? 409 : 400);
      expect(response.headers.get('content-type')).toContain('application/json');
    }
    expect(db.prepare('SELECT count(*) AS n FROM ai_conversation').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) AS n FROM ai_message').get()).toEqual({ n: 0 });
    expect(db.prepare('SELECT count(*) AS n FROM ai_model_call').get()).toEqual({ n: 0 });
    const valid = await authFetch(`${base}/api/assistant/chat`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ message: '解释预算口径', pageContext: pageSnapshot() }) });
    expect(valid.status).toBe(200);
    const result = await valid.json() as Record<string, unknown>;
    expect(result).toHaveProperty('effectiveContext'); expect(result).toHaveProperty('contextTrace');
    expect(result).not.toHaveProperty('resolvedContext'); expect(result).not.toHaveProperty('resolution');
  });
});

describe('T-8.3 / AC-T8-06 V65→V66 历史规范化及恢复', () => {
  it('保留正文、事实、引用及归属；备份完整，恢复后再次应用迁移', async () => {
    const fx = historicalDb();
    const old = { text: '金额 90071992547409.91 元', facts: [{ type: 'amount', data: { amount: '90071992547409.91' } }], citations: [{ source: '冻结快照', references: [{ id: 17 }] }], resolvedContext: { year: 2026, page: 'analysis', orgId: 4 }, resolution: [{ field: 'orgId', value: 4, origin: 'request', reason: '页面' }] };
    const id = fx.insert(old);
    const before = fx.db.prepare('SELECT content,conversation_id,created_at FROM ai_message WHERE id=?').get(id);
    const backup = await createBackup(fx.db, path.join(fx.dir, 'backups'), 'pre-v66');
    const backupFile = path.join(fx.dir, 'backups', backup.file);
    expect(verifyBackupBundle(backupFile).ok).toBe(true);
    const original = openReadonlyDatabase(backupFile);
    expect(JSON.parse((original.prepare('SELECT response_json FROM ai_message WHERE id=?').get(id) as { response_json: string }).response_json)).toEqual(old);
    original.close();
    expect(applyMigrations(fx.db).map((m) => m.version)).toEqual([66]);
    const raw = (fx.db.prepare('SELECT response_json FROM ai_message WHERE id=?').get(id) as { response_json: string }).response_json;
    const result = JSON.parse(raw);
    expect(result.effectiveContext).toEqual({ historical: true, reusable: true, year: 2026, pageKey: 'analysis', orgScopeId: 4 });
    expect(result.contextTrace.used[0].field).toBe('orgScopeId');
    expect(result.facts).toEqual(old.facts); expect(result.citations).toEqual(old.citations); expect(result.text).toBe(old.text);
    expect(fx.db.prepare('SELECT content,conversation_id,created_at FROM ai_message WHERE id=?').get(id)).toEqual(before);
    expect(applyMigrations(fx.db)).toEqual([]);
    expect((fx.db.prepare('SELECT response_json FROM ai_message WHERE id=?').get(id) as { response_json: string }).response_json).toBe(raw);
    const restored = await restoreBackup(fx.handle, fx.dbPath, backupFile, true);
    expect(restored.originalVersion).toBe(65); expect(restored.finalVersion).toBe(66);
    expect(JSON.parse((fx.db.prepare('SELECT response_json FROM ai_message WHERE id=?').get(id) as { response_json: string }).response_json)).toEqual(result);
  });
  it('不确定历史范围保留原始元数据并拒绝含糊追问', async () => {
    const fx = historicalDb();
    fx.insert({ resolvedContext: { page: 'obsolete', arbitraryRange: '未知范围' }, intents: { read: ['execution'] } });
    applyMigrations(fx.db);
    const result = JSON.parse((fx.db.prepare('SELECT response_json FROM ai_message').get() as { response_json: string }).response_json);
    expect(result.effectiveContext.reusable).toBe(false);
    expect(result.effectiveContext.historicalRange).toEqual({ page: 'obsolete', arbitraryRange: '未知范围' });
    await expect(chat(fx.db, { conversationId: 1, message: '那第二名呢', pageContext: pageSnapshot() })).rejects.toMatchObject({ code: 'CONTEXT_NOT_READY' });
  });
  it('损坏 JSON 报记录 ID，已转换前序记录及版本记录都回滚', () => {
    const fx = historicalDb(); const id = fx.insert({ resolvedContext: { year: 2026 } });
    const bad = fx.insert({}); fx.db.prepare('UPDATE ai_message SET response_json=? WHERE id=?').run('{broken', bad);
    expect(() => applyMigrations(fx.db)).toThrow(new RegExp(`ai_message #${bad}`));
    expect(appliedMigrations(fx.db).at(-1)?.version).toBe(65);
    expect(JSON.parse((fx.db.prepare('SELECT response_json FROM ai_message WHERE id=?').get(id) as { response_json: string }).response_json)).toEqual({ resolvedContext: { year: 2026 } });
  });
  it('已知历史范围追问按现时组织授权拒绝，不能沿用撤销的授权', async () => {
    const fx = historicalDb(); const data = buildFixture(fx.db); const version = standardBudgetVersion(data);
    fx.insert({ resolvedContext: { page: 'analysis', year: 2026, budgetVersionId: version.id, orgId: data.orgIds.hangzhou }, intents: { read: ['execution'] } });
    applyMigrations(fx.db);
    const auth: AuthContext = { userId: 1, username: 'scope', displayName: 'scope', permissions: new Set(['assistant:use', 'budget:read', 'actual:read']), allOrgs: false, orgRootIds: [data.orgIds.shanghai] };
    // 历史会话仍归当前账号；改变的只有现时组织范围。
    const owner = ensureAdmin(fx.db);
    fx.db.prepare('UPDATE ai_conversation SET owner_user_id=? WHERE id=1').run(owner);
    auth.userId = owner;
    await expect(runWithContext({ requestId: 't8', source: 'http', auth }, () => chat(fx.db, { conversationId: 1, message: '那第二名呢', pageContext: pageSnapshot() }))).rejects.toMatchObject({ status: 404 });
  });
  it('显式选择新范围时不把已撤销范围的历史正文或事实送入模型', async () => {
    const fx = historicalDb(); const data = buildFixture(fx.db); const version = standardBudgetVersion(data);
    const owner = ensureAdmin(fx.db);
    fx.db.prepare('UPDATE ai_conversation SET owner_user_id=? WHERE id=1').run(owner);
    fx.insert({ resolvedContext: { page: 'analysis', year: 2026, orgId: data.orgIds.hangzhou }, facts: [{ type: 'execution', data: { secret: 'REVOKED_RANGE_98765' } }] }, 'REVOKED_RANGE_98765');
    applyMigrations(fx.db);
    vi.stubEnv('AI_BASE_URL', 'https://example.invalid/v1'); vi.stubEnv('AI_API_KEY', 'synthetic-test-key'); vi.stubEnv('AI_STREAM', '0');
    const requests: unknown[] = [];
    vi.stubGlobal('fetch', vi.fn(async (_url, init) => {
      requests.push(JSON.parse(init.body));
      return { ok: true, json: async () => ({ choices: [{ message: { content: '已按当前范围重新查询。' } }] }) };
    }));
    const auth: AuthContext = { userId: owner, username: 'scope', displayName: 'scope', permissions: new Set(['assistant:use', 'budget:read', 'actual:read']), allOrgs: false, orgRootIds: [data.orgIds.shanghai] };
    await runWithContext({ requestId: 't8-history-model', source: 'http', auth }, () => chat(fx.db, { conversationId: 1, message: '当前范围的预算执行情况', pageContext: pageSnapshot({ budgetVersionId: version.id, orgScopeId: data.orgIds.shanghai }) }));
    expect(requests.length).toBeGreaterThan(0);
    expect(JSON.stringify(requests)).not.toContain('REVOKED_RANGE_98765');
  });

});
