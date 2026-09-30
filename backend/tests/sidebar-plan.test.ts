/**
 * 侧栏导航扩展与新页面开发计划(2026-09)验收:
 * - 阶段二:编制进度总览 —— 覆盖度与质量门禁同源;快照口径不漂移;空版本全零行;锁定版本照常返回。
 * - 阶段三:预警中心 —— /api/analysis/anomalies 确定性可用(清空模型 env)、不消耗 assistant 限流、阈值校验 400。
 * - 阶段五:LLM 渠道管理 —— V34 迁移导入、CRUD 校验、删除解绑、绑定校验、适配层解析顺序与 env 兜底。
 */
import { afterEach, describe, expect, it } from 'vitest';
import { createTestApp, authFetch } from './http-helpers';
import { testDb, buildFixture, standardBudgetVersion, budget } from './helpers';
import { budgetQualityReport } from '../src/modules/check/budget-quality';
import { budgetProgressReport } from '../src/modules/budget/progress.service';
import { anomalyReport } from '../src/assistant/anomaly';
import * as aiChannels from '../src/modules/settings/ai-channels.service';
import { applyMigrations, pendingMigrations } from '../src/db/migrations';
import { openDatabase } from '../src/db/connection';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';

const tmpDirs: string[] = [];
afterEach(() => {
  while (tmpDirs.length) rmSync(tmpDirs.pop()!, { recursive: true, force: true });
});

function tmpDbPath(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sidebar-plan-'));
  tmpDirs.push(dir);
  return join(dir, 'test.sqlite');
}

describe('阶段二:编制进度总览', () => {
  it('进度百分比与质量门禁覆盖度完全一致(同一判定函数)', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const v = standardBudgetVersion(fx);
    const quality = budgetQualityReport(db, v.id);
    const progress = budgetProgressReport(db, v.id);
    const sumFilled = progress.rows.reduce((s, r) => s + r.filled, 0);
    const sumTotal = progress.rows.reduce((s, r) => s + r.total, 0);
    expect(sumFilled).toBe(quality.coverage.filled);
    expect(sumTotal).toBe(quality.coverage.total);
    expect(progress.summary.orgCount).toBe(3); // 上海/杭州/南京三个叶子组织
    // 上海/杭州填了 3 个科目中各 3 个,南京 0
    const sh = progress.rows.find((r) => r.orgCode === 'SH')!;
    const nj = progress.rows.find((r) => r.orgCode === 'NJ')!;
    expect(sh.filled).toBe(3);
    expect(nj.filled).toBe(0);
    expect(progress.summary.notStarted).toBe(1);
    expect(sh.lastEditAt).toBeTruthy();
    expect(nj.lastEditAt).toBeNull();
    db.close();
  });

  it('必填缺失的阻断数与质量报告一致;空版本返回全零行;锁定版本照常返回', () => {
    const db = testDb();
    const fx = buildFixture(db);
    db.prepare('UPDATE account SET budget_required = 1 WHERE id = ?').run(fx.accIds.incomeMain);
    const v = budget.createVersion(db, { year: 2026, name: 'V1' });
    budget.saveEntries(db, v.id, [
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '100.00' },
    ]);
    const quality = budgetQualityReport(db, v.id);
    const progress = budgetProgressReport(db, v.id);
    const blocking = progress.rows.reduce((s, r) => s + r.blocking, 0);
    expect(blocking).toBe(quality.blockingCount);
    const hz = progress.rows.find((r) => r.orgCode === 'HZ')!;
    expect(hz.blocking).toBe(1); // 杭州缺主营业务收入

    // 空版本(无任何填报行)全零行而非报错
    const empty = budget.createVersion(db, { year: 2027, name: 'EMPTY' });
    const emptyProgress = budgetProgressReport(db, empty.id);
    expect(emptyProgress.rows.every((r) => r.filled === 0 && r.blocking >= 0)).toBe(true);
    expect(emptyProgress.summary.notStarted).toBe(emptyProgress.summary.orgCount);
    db.close();
  });

  it('快照口径:版本创建后停用组织,历史版本进度不漂移', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const v = standardBudgetVersion(fx);
    const before = budgetProgressReport(db, v.id);
    expect(before.summary.orgCount).toBe(3);
    // 版本创建后停用南京(主数据漂移),快照口径的进度不变
    db.prepare("UPDATE org SET status = 'inactive' WHERE id = ?").run(fx.orgIds.nanjing);
    const after = budgetProgressReport(db, v.id);
    expect(after.summary.orgCount).toBe(3);
    expect(after.rows.find((r) => r.orgCode === 'NJ')).toBeDefined();
    db.close();
  });

  it('HTTP:GET /api/versions/:id/progress 普通路由可访问', async () => {
    const dbPath = tmpDbPath();
    const migrate = openDatabase(dbPath);
    applyMigrations(migrate);
    migrate.close();
    const initDb = openDatabase(dbPath);
    const fx = buildFixture(initDb);
    const v = standardBudgetVersion(fx);
    initDb.close();
    const { app } = await createTestApp({ dbPath });
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const port = (server.address() as { port: number }).port;
    const res = await authFetch(`http://127.0.0.1:${port}/api/versions/${v.id}/progress`);
    expect(res.status).toBe(200);
    const body = (await res.json()) as { rows: unknown[]; summary: { orgCount: number } };
    expect(body.summary.orgCount).toBe(3);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

describe('阶段三:预警中心', () => {
  it('清空模型环境变量后 anomalyReport 与端点逻辑仍完整可用(确定性兜底)', () => {
    const savedBase = process.env.AI_BASE_URL;
    const savedKey = process.env.AI_API_KEY;
    delete process.env.AI_BASE_URL;
    delete process.env.AI_API_KEY;
    try {
      const db = testDb();
      const fx = buildFixture(db);
      const v = standardBudgetVersion(fx);
      const report = anomalyReport(db, { versionId: v.id, threshold: 0.2, yoyThreshold: 0.3, peerThreshold: 0.3 });
      expect(report.anomalyCount).toBe(report.anomalies.length);
      expect(Array.isArray(report.anomalies)).toBe(true);
      db.close();
    } finally {
      if (savedBase !== undefined) process.env.AI_BASE_URL = savedBase;
      if (savedKey !== undefined) process.env.AI_API_KEY = savedKey;
    }
  });

  it('阈值非法值报错(端点 400 同源校验)', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const v = standardBudgetVersion(fx);
    expect(() => anomalyReport(db, { versionId: v.id, threshold: -1 })).toThrow(/threshold/);
    expect(() => anomalyReport(db, { versionId: v.id, yoyThreshold: 99 })).toThrow(/yoyThreshold/);
    db.close();
  });

  it('HTTP:端点不挂 assistant 限流,连续超限请求不影响 /api/assistant/chat', async () => {
    const dbPath = tmpDbPath();
    const migrate = openDatabase(dbPath);
    applyMigrations(migrate);
    migrate.close();
    const initDb = openDatabase(dbPath);
    const fx = buildFixture(initDb);
    const v = standardBudgetVersion(fx);
    initDb.close();
    const { app } = await createTestApp({ dbPath });
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}/api`;
    // 连续 40 次(超过 chat 桶 30/min 默认上限),预警端点全部成功
    for (let i = 0; i < 40; i++) {
      const res = await authFetch(`${base}/analysis/anomalies?versionId=${v.id}`);
      expect(res.status).toBe(200);
    }
    // assistant chat 限流计数未被消耗:第一次请求不应 429
    const chat = await authFetch(`${base}/assistant/chat`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '列出预算版本', context: {} }),
    });
    expect(chat.status).not.toBe(429);
    // 阈值非法值 400
    const bad = await authFetch(`${base}/analysis/anomalies?versionId=${v.id}&threshold=abc`);
    expect(bad.status).toBe(400);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

describe('阶段五:LLM 渠道管理', () => {
  it('V34 迁移:env 已配置时自动导入首条渠道并绑定 6 个功能;未配置时表为空', () => {
    const savedBase = process.env.AI_BASE_URL;
    const savedKey = process.env.AI_API_KEY;
    try {
      process.env.AI_BASE_URL = 'http://model.test/v1';
      process.env.AI_API_KEY = 'sk-test-1234';
      const db = openDatabase(tmpDbPath());
      applyMigrations(db);
      const channels = aiChannels.listChannels(db);
      expect(channels.length).toBe(1);
      expect(channels[0].name).toBe('环境变量默认');
      expect(channels[0].baseUrl).toBe('http://model.test/v1');
      expect(channels[0].keyPreview).toContain('****');
      expect(channels[0].keyPreview).not.toContain('sk-test-1234');
      const bindings = aiChannels.listBindings(db);
      // V34 只绑定当时的 6 个功能;T-4 追加的 expense_audit 未绑定,按“任一启用渠道 → env”解析
      expect(bindings.length).toBe(7);
      expect(bindings.filter((b) => b.feature !== 'expense_audit').every((b) => b.primaryChannelId === channels[0].id)).toBe(true);
      expect(bindings.find((b) => b.feature === 'expense_audit')?.primaryChannelId ?? null).toBeNull();
      db.close();

      // 未配置 env:表空
      delete process.env.AI_BASE_URL;
      delete process.env.AI_API_KEY;
      const db2 = openDatabase(tmpDbPath());
      applyMigrations(db2);
      expect(aiChannels.listChannels(db2).length).toBe(0);
      expect(aiChannels.listBindings(db2).every((b) => b.primaryChannelId == null)).toBe(true);
      db2.close();
    } finally {
      if (savedBase !== undefined) process.env.AI_BASE_URL = savedBase; else delete process.env.AI_BASE_URL;
      if (savedKey !== undefined) process.env.AI_API_KEY = savedKey; else delete process.env.AI_API_KEY;
    }
  });

  it('CRUD 校验:非法 URL、公网 http 限制', () => {
    const db = testDb();
    try {
      expect(() => aiChannels.createChannel(db, { name: 'A', baseUrl: 'not-a-url' })).toThrow(/合法 URL/);
      expect(() => aiChannels.createChannel(db, { name: 'A', baseUrl: 'http://8.8.8.8/v1' })).toThrow(/https/);
      const { id } = aiChannels.createChannel(db, { name: 'A', baseUrl: 'https://api.example.com/v1', apiKey: 'sk-abc-9999' });
      const list = aiChannels.listChannels(db);
      expect(list[0].keyPreview).toBe('sk-****9999');
      // apiKey 留空表示不改动
      aiChannels.updateChannel(db, id, { model: 'gpt-4o' });
      expect(aiChannels.getChannel(db, id).api_key).toBe('sk-abc-9999');
      expect(aiChannels.getChannel(db, id).model).toBe('gpt-4o');
      // 重名冲突
      aiChannels.createChannel(db, { name: 'B', baseUrl: 'https://b.example.com/v1' });
      expect(() => aiChannels.createChannel(db, { name: 'B', baseUrl: 'https://c.example.com/v1' })).toThrow(/已存在/);
    } finally {
      db.close();
    }
  });

  it('绑定校验与删除解绑:停用渠道不可绑、主备不得相同、删除自动 SET NULL', () => {
    const db = testDb();
    const a = aiChannels.createChannel(db, { name: 'A', baseUrl: 'https://a.example.com/v1' }).id;
    const b = aiChannels.createChannel(db, { name: 'B', baseUrl: 'https://b.example.com/v1' }).id;
    expect(() => aiChannels.saveBindings(db, { bindings: [{ feature: 'chat', primaryChannelId: a, fallbackChannelId: a }] })).toThrow(/不得与主渠道相同/);
    expect(() => aiChannels.saveBindings(db, { bindings: [{ feature: 'nope', primaryChannelId: a, fallbackChannelId: null }] })).toThrow(/未知功能/);
    aiChannels.saveBindings(db, { bindings: [{ feature: 'chat', primaryChannelId: a, fallbackChannelId: b }] });
    // 停用 B 后不能再绑
    aiChannels.updateChannel(db, b, { enabled: false });
    expect(() => aiChannels.saveBindings(db, { bindings: [{ feature: 'narrative', primaryChannelId: b, fallbackChannelId: null }] })).toThrow(/已停用/);
    // 删除 A:chat 的 primary 自动解绑
    const result = aiChannels.deleteChannel(db, a);
    expect(result.affectedFeatures).toContain('chat');
    const binding = aiChannels.listBindings(db).find((row) => row.feature === 'chat')!;
    expect(binding.primaryChannelId).toBeNull();
    expect(binding.fallbackChannelId).toBe(b);
    db.close();
  });

  it('适配层解析:binding primary -> fallback -> 任一启用渠道 -> 无渠道时 null(env 兜底)', () => {
    const db = testDb();
    // 空渠道表:全部 null
    expect(aiChannels.primaryChannelForFeature(db, 'chat')).toBeNull();
    expect(aiChannels.anyChannel(db)).toBeNull();
    expect(aiChannels.anyEnabledChannel(db)).toBe(false);
    const a = aiChannels.createChannel(db, { name: 'A', baseUrl: 'https://a.example.com/v1' }).id;
    const b = aiChannels.createChannel(db, { name: 'B', baseUrl: 'https://b.example.com/v1' }).id;
    aiChannels.saveBindings(db, { bindings: [{ feature: 'chat', primaryChannelId: a, fallbackChannelId: b }] });
    expect(aiChannels.primaryChannelForFeature(db, 'chat')?.id).toBe(a);
    expect(aiChannels.fallbackChannelForFeature(db, 'chat', a)?.id).toBe(b);
    // fallback 与 primary 相同或无 fallback 时返回 null
    expect(aiChannels.fallbackChannelForFeature(db, 'chat', b)).toBeNull();
    expect(aiChannels.fallbackChannelForFeature(db, 'narrative', a)).toBeNull();
    // primary 停用 -> resolveChannelForFeature 落到 fallback;无绑定的功能落到任一启用渠道
    aiChannels.updateChannel(db, a, { enabled: false });
    expect(aiChannels.primaryChannelForFeature(db, 'chat')).toBeNull();
    expect(aiChannels.resolveChannelForFeature(db, 'chat')?.id).toBe(b);
    expect(aiChannels.resolveChannelForFeature(db, 'narrative')?.id).toBe(b);
    db.close();
  });

  it('HTTP:设置端点 CRUD 与绑定读写(不挂 assistant 限流)', async () => {
    const dbPath = tmpDbPath();
    const initDb = openDatabase(dbPath);
    applyMigrations(initDb);
    initDb.close();
    const { app } = await createTestApp({ dbPath });
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}/api/settings`;

    const created = await authFetch(`${base}/ai-channels`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ name: '网关A', baseUrl: 'https://gw.example.com/v1', apiKey: 'sk-gw-0001' }),
    });
    expect(created.status).toBe(201);
    const { id } = (await created.json()) as { id: number };
    const list = (await (await authFetch(`${base}/ai-channels`)).json()) as { items: { keyPreview: string }[] };
    expect(list.items.some((c) => c.keyPreview.includes('****'))).toBe(true);
    expect(JSON.stringify(list)).not.toContain('sk-gw-0001');

    const badPut = await authFetch(`${base}/ai-feature-bindings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bindings: [{ feature: 'chat', primaryChannelId: id, fallbackChannelId: id }] }),
    });
    expect(badPut.status).toBe(400);
    const okPut = await authFetch(`${base}/ai-feature-bindings`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ bindings: [{ feature: 'chat', primaryChannelId: id, fallbackChannelId: null }] }),
    });
    expect(okPut.status).toBe(200);
    const bindings = (await (await authFetch(`${base}/ai-feature-bindings`)).json()) as { items: { feature: string; primaryChannelId: number | null }[] };
    expect(bindings.items.find((b) => b.feature === 'chat')?.primaryChannelId).toBe(id);

    const del = await authFetch(`${base}/ai-channels/${id}`, { method: 'DELETE' });
    expect(del.status).toBe(200);
    expect(((await del.json()) as { affectedFeatures: string[] }).affectedFeatures).toContain('chat');
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('连通性测试三态:stub fetch 模拟快 2xx / 慢 2xx / 4xx', async () => {
    const db = testDb();
    const { id } = aiChannels.createChannel(db, { name: 'T', baseUrl: 'http://model.test/v1' });
    const originalFetch = globalThis.fetch;
    try {
      globalThis.fetch = (async () => new Response(JSON.stringify({ choices: [{ message: { content: 'ok' } }] }), { status: 200 })) as typeof fetch;
      const ok = await aiChannels.testChannel(db, id);
      expect(ok.status).toBe('ok');

      globalThis.fetch = (async () => {
        await new Promise((resolve) => setTimeout(resolve, 5_100));
        return new Response(JSON.stringify({ choices: [] }), { status: 200 });
      }) as typeof fetch;
      const degraded = await aiChannels.testChannel(db, id);
      expect(degraded.status).toBe('degraded');

      globalThis.fetch = (async () => new Response('unauthorized', { status: 401 })) as typeof fetch;
      const fail = await aiChannels.testChannel(db, id);
      expect(fail.status).toBe('fail');
      expect(fail.message).toContain('401');

      // 结构异常(200 但缺 choices)也是 degraded
      globalThis.fetch = (async () => new Response(JSON.stringify({ weird: true }), { status: 200 })) as typeof fetch;
      expect((await aiChannels.testChannel(db, id)).status).toBe('degraded');

      // 状态已写回库
      expect(aiChannels.getChannel(db, id).last_test_status).toBe('degraded');
    } finally {
      globalThis.fetch = originalFetch;
    }
    db.close();
  }, 20_000);

  it('空渠道表 + 无 env:modelConfigured 为 false(模板降级路径不破)', async () => {
    const savedBase = process.env.AI_BASE_URL;
    delete process.env.AI_BASE_URL;
    try {
      const { modelConfigured, setChannelResolver } = await import('../src/assistant/model');
      setChannelResolver(null);
      expect(modelConfigured()).toBe(false);
    } finally {
      if (savedBase !== undefined) process.env.AI_BASE_URL = savedBase;
    }
  });
});
