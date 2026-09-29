/**
 * 本轮审查缺陷的回归用例。
 *
 * 每个 it 对应一处已修复的缺陷，命名里写清「原来错在哪」，避免以后被重构回旧行为。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createTestApp, authFetch } from './http-helpers';
import * as assistant from '../src/assistant/service';
import { executeTool } from '../src/assistant/tools';
import { modelConfig, EnvChatModel } from '../src/assistant/model';
import { resetAssistantRateLimit } from '../src/assistant/rate-limit';
import { openDatabase } from '../src/db/connection';
import { loadSnapshotNodes } from '../src/modules/tree/snapshot';
import { testDb, tempFileDb, buildFixture, standardBudgetVersion, budget, org, account } from './helpers';

describe('缺陷修复回归:预算草案与跨年复制', () => {
  it('来源里「科目不适用于该组织」的脏数据既不进预览合计，也不会被写进新版本', () => {
    const db = testDb();
    // 用真实编码触发适用范围规则：010102=江垭电站(发电)，I1201 只适用于公司总部 010101。
    const station = org.createOrg(db, { parentId: null, code: '010102', name: '江垭电站' }).id;
    const hq = org.createOrg(db, { parentId: null, code: '010101', name: '公司总部' }).id;
    const income = account.createAccount(db, { parentId: null, code: 'I1201', name: '总部专属收入', type: 'income' }).id;
    const generic = account.createAccount(db, { parentId: null, code: 'I01', name: '通用收入', type: 'income' }).id;
    const source = budget.createVersion(db, { year: 2026, name: '来源版本' });
    budget.saveEntries(db, source.id, [
      { orgId: hq, accountId: income, amount: '100.00' },
      { orgId: station, accountId: generic, amount: '50.00' },
    ]);
    // 直接写库模拟存量脏数据：适用范围规则生效之前录进去的「电站 × 总部专属科目」。
    db.prepare('INSERT INTO budget_entry(version_id,org_id,account_id,amount_cents,quantity,formula,note,updated_at) VALUES(?,?,?,?,NULL,\'\',\'\',?)')
      .run(source.id, station, income, 777_00, new Date().toISOString());
    budget.lockVersion(db, source.id);
    budget.setCurrentVersion(db, source.id);

    const preview = budget.previewVersionGenerationDetails(db, { year: 2027, name: '草案', baseFrom: 'budget', baseYear: 2026, growthRate: 0 });
    expect(preview.outOfScopeCount).toBe(1);
    expect(preview.outOfScopeAmountCents).toBe(777_00);
    // 来源合计只统计真正会写入的组合：100 + 50，不含被剔除的 777。
    expect(preview.sourceAmountCents).toBe(150_00);
    expect(preview.generatedAmountCents).toBe(150_00);
    expect(preview.generatedCount).toBe(2);
    expect(preview.skippedCount).toBe(1);
    expect(preview.items.some((item) => item.orgId === station && item.accountId === income)).toBe(false);

    const created = budget.createVersion(db, { year: 2027, name: '草案', baseFrom: 'budget', baseYear: 2026, growthRate: 0 });
    const written = db.prepare('SELECT org_id,account_id,amount_cents FROM budget_entry WHERE version_id=?').all(created.id) as any[];
    expect(written).toHaveLength(2);
    expect(written.some((row) => row.org_id === station && row.account_id === income)).toBe(false);
    const total = written.reduce((sum, row) => sum + row.amount_cents, 0);
    expect(total).toBe(preview.generatedAmountCents);
    db.close();
  });

  it('跨年复制绑定目标年度当前树快照，同年复制仍沿用源快照', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const source = standardBudgetVersion(fx, 2026, '源版本');
    budget.lockVersion(db, source.id);
    // 复制之前新增一个组织：跨年草稿必须能看到它。
    const newOrg = org.createOrg(db, { parentId: fx.orgIds.west, code: 'CD', name: '成都公司' }).id;

    const crossYear = budget.copyVersion(db, source.id, '2027 草案', '', 2027);
    expect(crossYear.year).toBe(2027);
    expect(crossYear.org_tree_snapshot_id).not.toBe(source.org_tree_snapshot_id);
    const crossOrgIds = loadSnapshotNodes(db, crossYear.org_tree_snapshot_id).map((node) => node.id);
    expect(crossOrgIds).toContain(newOrg);
    // 明细照常复制(新组织没有来源值，不会凭空造行)。
    expect((db.prepare('SELECT COUNT(*) c FROM budget_entry WHERE version_id=?').get(crossYear.id) as any).c).toBe(6);

    const sameYear = budget.copyVersion(db, source.id, '2026 修订', '');
    expect(sameYear.year).toBe(2026);
    expect(sameYear.org_tree_snapshot_id).toBe(source.org_tree_snapshot_id);
    const sameOrgIds = loadSnapshotNodes(db, sameYear.org_tree_snapshot_id).map((node) => node.id);
    expect(sameOrgIds).not.toContain(newOrg);
    db.close();
  });
});

describe('缺陷修复回归:导出与预览载荷', () => {
  it('导出 options 不能覆盖已校验的 versionId，也不接受未知字段', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const version = standardBudgetVersion(fx);
    expect(() => assistant.preview(db, { type: 'export', params: { kind: 'completion', format: 'csv', versionId: version.id, options: { versionId: version.id + 1 } } }))
      .toThrow(/不能覆盖 versionId/);
    expect(() => assistant.preview(db, { type: 'export', params: { kind: 'completion', format: 'csv', versionId: version.id, options: { evil: 1 } } }))
      .toThrow(/不支持的字段/);
    expect(() => assistant.preview(db, { type: 'export', params: { kind: 'completion', format: 'csv', versionId: version.id, options: { sheetKey: { nested: true } } } }))
      .toThrow();
    const ok = assistant.preview(db, { type: 'export', params: { kind: 'completion', format: 'csv', versionId: version.id, options: { orgScopeId: fx.orgIds.east } } });
    expect((ok.preview as any).kind).toBe('completion');
    db.close();
  });

  it('确认时生成的导出文件被复用，下载不再重新生成', async () => {
    const db = testDb();
    const fx = buildFixture(db);
    const version = standardBudgetVersion(fx);
    assistant.resetArtifactCache();
    const action = assistant.preview(db, { type: 'export', params: { kind: 'budget_detail', versionId: version.id, format: 'csv' } });
    await assistant.confirmAsync(db, action.id, '', action.confirmationToken);
    const first = await assistant.exportArtifact(db, action.id);
    const second = await assistant.exportArtifact(db, action.id);
    // 同一个 Buffer 实例即证明命中缓存(重新生成会得到新对象)。
    expect(second.buffer).toBe(first.buffer);
    assistant.resetArtifactCache();
    const rebuilt = await assistant.exportArtifact(db, action.id);
    expect(rebuilt.buffer).not.toBe(first.buffer);
    expect(rebuilt.buffer.toString('utf8')).toBe(first.buffer.toString('utf8'));
    db.close();
  });

  it('复制与批量调整的预览不再重复携带全量明细,最大变化行按 |变化额| 排序', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const source = standardBudgetVersion(fx, 2026, '复制源');
    budget.lockVersion(db, source.id);
    const copy = assistant.preview(db, { type: 'copy_budget', params: { sourceVersionId: source.id, targetYear: 2027, name: '复制草案' } });
    const copyPreview = copy.preview as any;
    expect(copyPreview.changes).toBeUndefined();
    expect(copyPreview.changeCount).toBe(6);
    expect(copyPreview.largestChanges.length).toBeLessThanOrEqual(50);

    const draft = budget.createVersion(db, { year: 2028, name: '批量调整目标' });
    const bulk = assistant.preview(db, {
      type: 'bulk_adjustment',
      params: { versionId: draft.id, entries: [
        { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '10.00' },
        { orgId: fx.orgIds.hangzhou, accountId: fx.accIds.costSub, amount: '500.00' },
        { orgId: fx.orgIds.nanjing, accountId: fx.accIds.expenseAdmin, amount: '80.00' },
      ] },
    });
    const bulkPreview = bulk.preview as any;
    expect(bulkPreview.changes).toBeUndefined();
    expect(bulkPreview.changeCount).toBe(3);
    // changeCents 曾整列缺失,排序恒为 0,「最大变化行」实际是前 50 条输入;
    // 金额为存储口径(成本费用为负),排序按绝对值
    expect(bulkPreview.largestChanges.map((row: any) => row.changeCents)).toEqual([-50_000, -8_000, 1_000]);
    db.close();
  });

  it('get_budget_cell_history 按声明参数分发而非把整个 args 当 versionId', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const version = standardBudgetVersion(fx);
    // 该工具此前落入 default 分支,args 对象被当作 versionId 传给 SQL 绑定,必然抛错
    const history = executeTool(db, 'get_budget_cell_history', {
      versionId: version.id, orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain,
    }) as unknown;
    expect(Array.isArray(history) || history != null).toBe(true);
    expect(() => executeTool(db, 'get_budget_cell_history', { versionId: version.id, orgId: 0, accountId: fx.accIds.incomeMain })).toThrow(/orgId/);
    db.close();
  });
});

describe('缺陷修复回归:会话载荷与参数校验', () => {
  it('会话详情只回解析后的 response，不再把 response_json 原样传一遍', async () => {
    const db = testDb();
    const chat = await assistant.chat(db as any, { message: '列出预算版本', context: { year: 2026 } });
    const detail: any = assistant.conversation(db as any, chat.conversationId);
    expect(detail.messages.length).toBeGreaterThan(0);
    for (const message of detail.messages) {
      expect(message.response_json).toBeUndefined();
      expect(Object.keys(message).sort()).toEqual(['content', 'created_at', 'id', 'model', 'response', 'role']);
    }
    const insightId = assistant.saveInsight(db as any, { kind: 'historical_comparison', title: '历年对比' }).id;
    const insight: any = assistant.insight(db as any, insightId);
    expect(insight.result_json).toBeUndefined();
    expect(insight.citations_json).toBeUndefined();
    expect(insight.result.kind).toBe('historical_comparison');
    db.close();
  });

  it('情景测算的 targetProfitCents 在缺 versionId 时也要校验', () => {
    const db = testDb();
    expect(() => assistant.preview(db, { type: 'scenario', params: { targetProfitCents: 'abc' } })).toThrow(/targetProfitCents/);
    expect(() => assistant.preview(db, { type: 'scenario', params: { targetProfitCents: 1.5 } })).toThrow(/targetProfitCents/);
    const ok = assistant.preview(db, { type: 'scenario', params: { targetProfitCents: 12_345 } });
    expect((ok.preview as any).targetProfitCents).toBe(12_345);
    db.close();
  });

  it('重型只读工具按显式白名单校验参数，不透传模型给的任意属性', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const version = standardBudgetVersion(fx);
    expect(() => executeTool(db, 'calculate_attribution', { versionId: version.id, direction: '随便写' })).toThrow(/direction/);
    expect(() => executeTool(db, 'calculate_anomalies', { versionId: version.id, threshold: '不是数字' })).toThrow(/threshold/);
    expect(() => executeTool(db, 'calculate_execution', { versionId: version.id, sheetKey: { nested: 1 } })).toThrow(/sheetKey/);
    expect(() => executeTool(db, 'generate_report', { kind: 'monthly_execution', versionId: version.id, topN: 999 })).toThrow(/topN/);
    const attribution: any = executeTool(db, 'calculate_attribution', { versionId: version.id, direction: 'unfavorable', maxDepth: 2, topN: 5, evil: { drop: true } });
    // 白名单只放行已知字段：evil 被丢弃，params 只回显受支持的三个参数。
    expect(attribution.version.id).toBe(version.id);
    expect(attribution.params).toEqual({ maxDepth: 2, topN: 5, direction: 'unfavorable' });
    db.close();
  });
});

describe('缺陷修复回归:路由与限流', () => {
  it('带副作用的 GET /api/assistant/chat/stream 已删除', async () => {
    const { dbPath, db, dir } = tempFileDb();
    db.close();
    const { app, holder } = await createTestApp({ dbPath });
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const port = (server.address() as any).port;
    try {
      const response = await authFetch(`http://127.0.0.1:${port}/api/assistant/chat/stream?message=${encodeURIComponent('列出预算版本')}`);
      expect(response.status).toBe(404);
      await response.arrayBuffer();
      // GET 不应创建任何会话
      const check = openDatabase(dbPath);
      expect((check.prepare('SELECT COUNT(*) c FROM ai_conversation').get() as any).c).toBe(0);
      check.close();
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      holder.getDb().close();
      try { require('fs').rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响断言 */ }
    }
  });

  it('确认、取消与下载三个入口都受限流保护', async () => {
    const { dbPath, db, dir } = tempFileDb();
    const fx = buildFixture(db);
    const version = standardBudgetVersion(fx, 2026, 'V1');
    budget.lockVersion(db, version.id);
    const pending = [1, 2, 3].map(() => assistant.preview(db, { type: 'copy_budget', params: { sourceVersionId: version.id, targetYear: 2027, name: `候选${Math.random()}` } }));
    db.close();
    const previous = process.env.AI_RATE_LIMIT_PER_MIN;
    process.env.AI_RATE_LIMIT_PER_MIN = '1';
    resetAssistantRateLimit();
    const { app, holder } = await createTestApp({ dbPath });
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const port = (server.address() as any).port;
    const base = `http://127.0.0.1:${port}/api/assistant`;
    try {
      const first = await authFetch(`${base}/actions/${pending[0].id}/cancel`, { method: 'POST' });
      expect(first.status).toBe(200);
      const second = await authFetch(`${base}/actions/${pending[1].id}/cancel`, { method: 'POST' });
      expect(second.status).toBe(429);
      expect((await second.json() as any).code).toBe('AI_RATE_LIMITED');
      const download = await authFetch(`${base}/actions/${pending[2].id}/download`);
      expect(download.status).toBe(429);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      holder.getDb().close();
      process.env.AI_RATE_LIMIT_PER_MIN = previous;
      resetAssistantRateLimit();
      try { require('fs').rmSync(dir, { recursive: true, force: true }); } catch { /* 清理失败不影响断言 */ }
    }
  });
});

describe('缺陷修复回归:契约一致性', () => {
  it('assistant-openapi.json 与实际注册的路由逐个对齐', () => {
    const spec = require('../assistant-openapi.json') as { paths: Record<string, Record<string, unknown>> };
    const documented = new Set<string>();
    for (const [routePath, ops] of Object.entries(spec.paths)) {
      for (const method of Object.keys(ops)) documented.add(`${method.toUpperCase()} ${routePath}`);
    }
    const source = require('fs').readFileSync(require('path').join(__dirname, '../src/assistant/controller.ts'), 'utf8') as string;
    const implemented = new Set<string>();
    for (const match of source.matchAll(/app\.(get|post|patch|delete)\('([^']+)'/g)) {
      implemented.add(`${match[1].toUpperCase()} ${match[2].replace(/:([a-zA-Z]+)/g, '{$1}')}`);
    }
    expect([...implemented].filter((route) => !documented.has(route))).toEqual([]);
    expect([...documented].filter((route) => !implemented.has(route))).toEqual([]);
    // 删除的 GET 流式入口不能再出现在契约里
    expect(documented.has('GET /api/assistant/chat/stream')).toBe(false);
  });
});

describe('缺陷修复回归:模型超时口径', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.AI_BASE_URL;
    delete process.env.AI_API_KEY;
    delete process.env.AI_TIMEOUT_MS;
    delete process.env.AI_TOTAL_TIMEOUT_MS;
  });

  it('AI_TIMEOUT_MS 只约束首字与空闲，长流式回答不再被从中间掐断', async () => {
    process.env.AI_BASE_URL = 'http://model.test/v1';
    process.env.AI_TIMEOUT_MS = '150';
    const config = modelConfig();
    expect(config.timeoutMs).toBe(150);
    expect(config.totalTimeoutMs).toBeGreaterThanOrEqual(120_000);

    const encoder = new TextEncoder();
    // 每 60ms 吐一块，共 8 块 ≈ 480ms：远超 AI_TIMEOUT_MS=150，但每块间隔都在阈值内。
    const chunks = Array.from({ length: 8 }, (_, i) => `data: ${JSON.stringify({ choices: [{ delta: { content: `块${i}` } }] })}\n\n`);
    vi.stubGlobal('fetch', vi.fn(async (_url: string, options: any) => {
      let index = 0;
      return {
        ok: true,
        body: {
          getReader: () => ({
            read: () => new Promise((resolve, reject) => {
              const timer = setTimeout(() => {
                if (index >= chunks.length) resolve({ done: true, value: undefined });
                else resolve({ done: false, value: encoder.encode(chunks[index++]) });
              }, 60);
              options.signal?.addEventListener('abort', () => {
                clearTimeout(timer);
                const error: any = new Error('aborted');
                error.name = 'AbortError';
                reject(error);
              });
            }),
          }),
        },
      };
    }));

    let text = '';
    for await (const event of new EnvChatModel().streamChat({ messages: [{ role: 'user', content: 'hi' }] })) {
      if (event.type === 'text') text += event.text;
    }
    expect(text).toBe('块0块1块2块3块4块5块6块7');
  });

  it('流式响应长时间没有新数据时按空闲超时中断', async () => {
    process.env.AI_BASE_URL = 'http://model.test/v1';
    process.env.AI_TIMEOUT_MS = '60';
    vi.stubGlobal('fetch', vi.fn(async (_url: string, options: any) => ({
      ok: true,
      body: {
        getReader: () => ({
          read: () => new Promise((_resolve, reject) => {
            options.signal?.addEventListener('abort', () => {
              const error: any = new Error('aborted');
              error.name = 'AbortError';
              reject(error);
            });
          }),
        }),
      },
    })));
    await expect((async () => {
      for await (const _event of new EnvChatModel().streamChat({ messages: [{ role: 'user', content: 'hi' }] })) { /* 等待中断 */ }
    })()).rejects.toThrow(/超时/);
  });
});
