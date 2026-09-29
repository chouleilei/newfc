/**
 * 多年趋势叙述层(AI 功能增强计划 §四.阶段五.AI 薄层)验收:
 * - NEWFC_TREND_AI=0 时年度复盘保留模板稿(含「年度节奏对比」确定性要点);
 * - 模型改写改变事实 token(数字/编码)时 narrativeNumbersIntact 守卫回退模板;
 * - 叙述开关只影响 annual_review,其余报告类型不受影响;
 * - 同步路径零模型调用(改写只在 reportDraft 的异步叙述阶段)。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { testDb, buildFixture, standardBudgetVersion, saveActualSnapshot, budget } from './helpers';
import { reportDraft } from '../src/assistant/service';
import { sectionMarkdown } from '../src/assistant/report-draft';
import { resetNarrativeCache } from '../src/assistant/narrative';
import { freezeYear } from '../src/modules/report/report.service';

function setupAnnual(db: ReturnType<typeof testDb>) {
  const fx = buildFixture(db);
  const version = standardBudgetVersion(fx);
  budget.lockVersion(db, version.id);
  const batch = saveActualSnapshot(fx, 2026, '2026-12-31', [
    { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '95.00' },
    { orgId: fx.orgIds.shanghai, accountId: fx.accIds.costSub, amount: '55.00' },
    { orgId: fx.orgIds.shanghai, accountId: fx.accIds.expenseAdmin, amount: '18.00' },
    { orgId: fx.orgIds.hangzhou, accountId: fx.accIds.incomeMain, amount: '48.00' },
    { orgId: fx.orgIds.hangzhou, accountId: fx.accIds.costSub, amount: '28.00' },
    { orgId: fx.orgIds.hangzhou, accountId: fx.accIds.expenseSales, amount: '9.00' },
  ]);
  freezeYear(db, 2026, batch.batchId);
  // 上年同期快照,使节奏对比可比
  saveActualSnapshot(fx, 2025, '2025-12-31', [
    { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '80.00' },
    { orgId: fx.orgIds.shanghai, accountId: fx.accIds.costSub, amount: '50.00' },
  ]);
  return { fx, version };
}

describe('年度节奏对比叙述层(AI 薄层)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env.AI_BASE_URL = '';
    process.env.AI_API_KEY = '';
    delete process.env.NEWFC_TREND_AI;
    resetNarrativeCache();
  });

  it('NEWFC_TREND_AI=0 时年度复盘保留模板稿,章节完整', async () => {
    const db = testDb();
    setupAnnual(db);
    process.env.NEWFC_TREND_AI = '0';
    process.env.AI_BASE_URL = 'http://model.test/v1';
    process.env.AI_API_KEY = 'test';
    const fetchSpy = vi.fn();
    vi.stubGlobal('fetch', fetchSpy);
    const draft = await reportDraft(db, { kind: 'annual_review', year: 2026 });
    expect(draft.model).toBe('template');
    expect(draft.narrativeSource).toBe('template');
    expect(draft.sections.map((section) => section.key)).toContain('trend');
    expect(draft.narrative).toContain('年度节奏对比');
    expect(fetchSpy).not.toHaveBeenCalled();
    db.close();
  });

  it('守卫失败:模型改写新增数字 -> 回退模板稿', async () => {
    const db = testDb();
    setupAnnual(db);
    process.env.AI_BASE_URL = 'http://model.test/v1';
    process.env.AI_API_KEY = 'test';
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: '模型自由发挥:利润暴增 999.99 万元,异常编码 FAKE01 需要关注' } }] }),
    })));
    const draft = await reportDraft(db, { kind: 'annual_review', year: 2026 });
    expect(draft.narrativeSource).toBe('template');
    expect(draft.model).toBe('template');
    expect(draft.notes?.some((note) => note.includes('已丢弃改写'))).toBe(true);
    db.close();
  });

  it('叙述开关只影响 annual_review,其余报告类型照常改写', async () => {
    const db = testDb();
    const { version } = setupAnnual(db);
    process.env.NEWFC_TREND_AI = '0';
    process.env.AI_BASE_URL = 'http://model.test/v1';
    process.env.AI_API_KEY = 'test';
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1;
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: '保持全部数字与编码不变的改写' } }] }),
      };
    }));
    // annual_review:开关关闭 -> 模板
    const annual = await reportDraft(db, { kind: 'annual_review', year: 2026 });
    expect(annual.narrativeSource).toBe('template');
    expect(calls).toBe(0);
    // monthly_execution 的守卫失败路径也会回退,但开关不拦截:fetch 会被调用
    const monthly = await reportDraft(db, { kind: 'monthly_execution', versionId: version.id });
    expect(calls).toBe(1);
    expect(monthly.narrativeSource).toBe('template'); // 守卫:改写丢了全部事实 token -> 回退
    db.close();
  });

  it('模型改写只作用于「年度节奏对比」章节,其余章节逐字保留', async () => {
    const db = testDb();
    setupAnnual(db);
    process.env.AI_BASE_URL = 'http://model.test/v1';
    process.env.AI_API_KEY = 'test';
    // 先取模板稿,拿到 trend 章节块
    const template = await reportDraft(db, { kind: 'annual_review', year: 2026, narrative: false });
    const trendSection = template.sections.find((section) => section.key === 'trend')!;
    const block = sectionMarkdown(trendSection);
    const otherBlocks = template.sections
      .filter((section) => section.key !== 'trend')
      .map((section) => sectionMarkdown(section));

    let sentTemplate = '';
    vi.stubGlobal('fetch', vi.fn(async (_url: string, init: { body: string }) => {
      const payload = JSON.parse(init.body) as { messages: { role: string; content: string }[] };
      sentTemplate = payload.messages.find((message) => message.role === 'user')!.content;
      // 只重排章节内的要点顺序,不动任何事实 token
      const lines = block.split('\n');
      return {
        ok: true,
        json: async () => ({ choices: [{ message: { content: [lines[0], ...lines.slice(1).reverse()].join('\n') } }] }),
      };
    }));
    const draft = await reportDraft(db, { kind: 'annual_review', year: 2026 });
    // 送给模型的只有 trend 章节,不是整份报告
    expect(sentTemplate).toBe(block);
    expect(sentTemplate).not.toContain('## 一、年度结果');
    expect(draft.narrativeSource).toBe('model');
    // 其余章节在最终叙述里逐字不变
    for (const other of otherBlocks) expect(draft.narrative).toContain(other);
    // trend 章节已被替换
    expect(draft.narrative).not.toContain(block);
    expect(draft.narrative).toContain('## 四、年度节奏对比');
    expect(draft.notes?.some((note) => note.includes('仅作用于'))).toBe(true);
    db.close();
  });

  it('年度节奏对比章节继承报告范围:组织范围写进要点且趋势事实带 scope', async () => {
    const db = testDb();
    const { fx } = setupAnnual(db);
    const draft = await reportDraft(db, { kind: 'annual_review', year: 2026, orgScopeId: fx.orgIds.east, narrative: false });
    const trend = draft.sections.find((section) => section.key === 'trend')!;
    const data = trend.data as { scope: { orgScopeId: number | null; orgCodes: string[] | null } };
    expect(data.scope.orgScopeId).toBe(fx.orgIds.east);
    expect(data.scope.orgCodes).toEqual(['EAST', 'HZ', 'SH']);
    expect(trend.bullets.some((line) => line.includes('组织限定 3 个编码'))).toBe(true);
    // 未指定范围时明确声明全量,不让读者误以为漏了筛选
    const full = await reportDraft(db, { kind: 'annual_review', year: 2026, narrative: false });
    const fullTrend = full.sections.find((section) => section.key === 'trend')!;
    expect(fullTrend.bullets.some((line) => line.includes('组织全量') && line.includes('科目全量'))).toBe(true);
    db.close();
  });
});
