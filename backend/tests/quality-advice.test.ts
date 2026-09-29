/**
 * AI 功能增强计划 §四.阶段一(AI 薄层)验收:
 * - 处理建议:模型关闭时回退确定性模板,守卫失败回退模板,命中缓存不重复调用模型;
 * - 叙述限流桶与聊天桶互相隔离,后台服务级配额再独立一层;
 * - 清洗结构建议端点(模型入口)同样挂在独立叙述桶上。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, authFetch } from './http-helpers';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { testDb, buildFixture, standardBudgetVersion } from './helpers';
import * as budget from '../src/modules/budget/budget.service';
import { qualityAdvice, qualityAdviceTemplate } from '../src/assistant/quality-advice';
import { resetNarrativeCache, narrativeNumbersIntact } from '../src/assistant/narrative';
import {
  resetAssistantRateLimit, assistantRateLimit, assistantNarrativeRateLimit, tryConsumeNarrativeBudget,
} from '../src/assistant/rate-limit';
import { PROMPT_VERSION } from '../src/assistant/prompts';

function fakeReq(): any {
  return { ip: '127.0.0.1', authUser: 'tester', socket: { remoteAddress: '127.0.0.1' } };
}

describe('定稿质量门禁:处理建议(AI 薄层)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env.AI_BASE_URL = '';
    process.env.AI_API_KEY = '';
    resetNarrativeCache();
  });

  it('模型未配置时回退确定性模板稿,内容与分组统计一致', async () => {
    const db = testDb();
    const fx = buildFixture(db);
    db.prepare('UPDATE account SET budget_required = 1 WHERE id = ?').run(fx.accIds.incomeMain);
    const v = budget.createVersion(db, { year: 2026, name: 'V1' });
    const result = await qualityAdvice(db, v.id);
    expect(result.source).toBe('template');
    expect(result.model).toBe('template');
    expect(result.canFinalize).toBe(false);
    expect(result.blockingCount).toBe(3);
    expect(result.advice).toContain('阻断 3 条');
    expect(result.advice).toContain('REQUIRED_VALUE_MISSING');
    expect(result.advice).toContain('3 家单位共 3 个必填科目未填报');
    expect(result.promptVersion).toBe(PROMPT_VERSION.qualityAdvice);
  });

  it('模板稿确定性:阻断先于提醒、结构先于填报', () => {
    const template = qualityAdviceTemplate({
      versionName: 'V1',
      versionStatus: 'draft',
      canFinalize: false,
      blockingCount: 2,
      warningCount: 1,
      groups: [
        { code: 'CALCULATION_OUTPUT_MISSING', severity: 'warning', count: 1, orgCount: 1, accountCount: 1, summary: '1 家单位共 1 个测算模板输出未试算' },
        { code: 'REQUIRED_VALUE_MISSING', severity: 'blocking', count: 2, orgCount: 1, accountCount: 2, summary: '1 家单位共 2 个必填科目未填报' },
      ],
      issues: [
        { code: 'REQUIRED_VALUE_MISSING', severity: 'blocking', message: 'x' },
        { code: 'CALCULATION_OUTPUT_MISSING', severity: 'warning', message: 'y' },
      ],
    });
    const requiredAt = template.indexOf('REQUIRED_VALUE_MISSING:');
    const calcAt = template.indexOf('CALCULATION_OUTPUT_MISSING:');
    expect(requiredAt).toBeGreaterThan(-1);
    // 处理顺序中阻断的 REQUIRED_VALUE_MISSING 排在提醒之前
    const orderSection = template.slice(template.indexOf('## 建议处理顺序'));
    expect(orderSection.indexOf('1. 先处理 REQUIRED_VALUE_MISSING')).toBeGreaterThan(-1);
    expect(orderSection.indexOf('REQUIRED_VALUE_MISSING')).toBeLessThan(orderSection.indexOf('CALCULATION_OUTPUT_MISSING'));
    expect(requiredAt).toBeLessThan(template.length);
  });

  it('模型改写通过守卫时返回模型稿;改动数字时退回模板稿', async () => {
    const db = testDb();
    const fx = buildFixture(db);
    db.prepare('UPDATE account SET budget_required = 1 WHERE id = ?').run(fx.accIds.incomeMain);
    const v = budget.createVersion(db, { year: 2026, name: 'V1' });

    process.env.AI_BASE_URL = 'http://model.test/v1';
    process.env.AI_API_KEY = 'test';
    const baseline = await qualityAdvice(db, v.id); // 先拿模板稿供模型“复述”
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1;
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: baseline.advice.replace('## 问题概况', '## 问题概况(模型整理)') } }] }),
      };
    }));
    const rewritten = await qualityAdvice(db, v.id);
    expect(rewritten.source).toBe('model');
    expect(rewritten.advice).toContain('模型整理');
    // 数字守卫:改写稿事实 token 与模板一致
    expect(narrativeNumbersIntact(baseline.advice, rewritten.advice).ok).toBe(true);

    // 缓存命中:同样的草稿再次请求不再调用模型
    const cached = await qualityAdvice(db, v.id);
    expect(cached.cached).toBe(true);
    expect(cached.source).toBe('model');
    expect(calls).toBe(1);

    // 守卫失败:模型新增数字 → 退回模板
    resetNarrativeCache();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: `${baseline.advice}\n另发现 99 条隐藏问题` } }] }),
    })));
    const guarded = await qualityAdvice(db, v.id);
    expect(guarded.source).toBe('template');
    expect(guarded.guardFailure).toBeDefined();
    expect(guarded.advice).toBe(baseline.advice);
  });

  it('模型调用失败时回退模板稿', async () => {
    const db = testDb();
    const fx = buildFixture(db);
    const v = standardBudgetVersion(fx);
    process.env.AI_BASE_URL = 'http://model.test/v1';
    vi.stubGlobal('fetch', vi.fn(async () => { throw new Error('network down'); }));
    const result = await qualityAdvice(db, v.id);
    expect(result.source).toBe('template');
    expect(result.advice).toContain('定稿质量门禁处理建议');
  });
});

describe('叙述限流桶与聊天桶隔离', () => {
  afterEach(() => {
    resetAssistantRateLimit();
    delete process.env.AI_NARRATIVE_RATE_LIMIT_PER_MIN;
  });

  it('叙述桶打满不影响聊天桶', () => {
    process.env.AI_NARRATIVE_RATE_LIMIT_PER_MIN = '2';
    resetAssistantRateLimit();
    const run = (middleware: typeof assistantRateLimit) => {
      let status = 200;
      const res: any = {
        setHeader: () => undefined,
        status: (code: number) => { status = code; return { json: () => undefined }; },
      };
      middleware(fakeReq(), res, () => undefined);
      return status;
    };
    expect(run(assistantNarrativeRateLimit)).toBe(200);
    expect(run(assistantNarrativeRateLimit)).toBe(200);
    expect(run(assistantNarrativeRateLimit)).toBe(429);
    // 叙述桶已满,聊天桶仍然可用(默认 30/min)
    expect(run(assistantRateLimit)).toBe(200);
  });

  it('服务级后台配额与 HTTP 叙述桶独立计数', () => {
    process.env.AI_NARRATIVE_RATE_LIMIT_PER_MIN = '1';
    resetAssistantRateLimit();
    const run = (middleware: typeof assistantRateLimit) => {
      let status = 200;
      const res: any = {
        setHeader: () => undefined,
        status: (code: number) => { status = code; return { json: () => undefined }; },
      };
      middleware(fakeReq(), res, () => undefined);
      return status;
    };
    // 后台桶用满不影响 HTTP 叙述桶
    expect(tryConsumeNarrativeBudget('narrative:checkpoint_summary')).toBe(true);
    expect(tryConsumeNarrativeBudget('narrative:checkpoint_summary')).toBe(false);
    expect(run(assistantNarrativeRateLimit)).toBe(200);
    // 不同任务种类各自独立
    expect(tryConsumeNarrativeBudget('narrative:other')).toBe(true);
  });
});

describe('清洗结构建议端点挂在独立叙述桶上', () => {
  afterEach(() => {
    resetAssistantRateLimit();
    delete process.env.AI_NARRATIVE_RATE_LIMIT_PER_MIN;
  });

  it('/api/io/cleaning/suggest 超过叙述桶上限返回 429,而聊天配额不受影响', async () => {
    process.env.AI_NARRATIVE_RATE_LIMIT_PER_MIN = '1';
    resetAssistantRateLimit();
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleaning-suggest-limit-'));
    const dbPath = path.join(dir, 'test.sqlite');
    const { app } = await createTestApp({ dbPath });
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    try {
      const post = () => authFetch(`${base}/api/io/cleaning/suggest`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: 'missing-token', targetKind: 'budget' }),
      });
      // 第一次通过限流(token 不存在 -> 业务 404,说明请求已进入处理器)
      const first = await post();
      expect(first.status).toBe(404);
      // 第二次被叙述桶挡住
      const second = await post();
      expect(second.status).toBe(429);
      expect((await second.json() as { code: string }).code).toBe('AI_RATE_LIMITED');
      // 聊天桶未被消耗:同一 actor 的聊天入口仍可进入处理器
      const chat = await authFetch(`${base}/api/assistant/glossary`);
      expect(chat.status).toBe(200);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
