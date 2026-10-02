import { pageSnapshot } from './assistant-context';
import { describe, it, expect, afterEach, vi } from 'vitest';
import { createTestApp, authFetch } from './http-helpers';
import { detectIntents, looksLikeFollowUp, needsBudgetVersion, withInheritedIntents } from '../src/assistant/intent';
import { contextDigest, resolveMessageContext } from '../src/assistant/message-context';
import { queryFacts } from '../src/assistant/facts';
import * as assistant from '../src/assistant/service';
import { executeTool } from '../src/assistant/tools';
import { testDb, buildFixture, standardBudgetVersion, saveActualSnapshot, budget, actual, org } from './helpers';

/**
 * 助手可用性修复的回归测试。
 *
 * 覆盖：意图路由去重与同义词、上下文自动解析、模型优先路由与兜底、
 * 写操作参数抽取、真流式 SSE、多轮追问事实回灌、工具参数收紧。
 */

function fixtureWithActual() {
  const db = testDb();
  const fx = buildFixture(db);
  const version = standardBudgetVersion(fx, 2026, 'V1');
  // setCurrentVersion 只接受定稿版本，先定稿再设为当前生效。
  budget.lockVersion(db, version.id);
  budget.setCurrentVersion(db, version.id);
  saveActualSnapshot(fx, 2026, '2026-06-30', [
    { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '40.00' },
    { orgId: fx.orgIds.shanghai, accountId: fx.accIds.costSub, amount: '35.00' },
    { orgId: fx.orgIds.hangzhou, accountId: fx.accIds.incomeMain, amount: '30.00' },
  ]);
  return { db, fx, version };
}

/** 构造一个按调用顺序返回预设响应的 fetch 替身。 */
function stubModel(responses: any[]) {
  process.env.AI_BASE_URL = 'http://model.test/v1';
  process.env.AI_API_KEY = 'test';
  let call = 0;
  const bodies: any[] = [];
  const fetchMock = vi.fn(async (_url: string, options: any) => {
    bodies.push(JSON.parse(options.body));
    const payload = responses[Math.min(call, responses.length - 1)];
    call += 1;
    return { ok: true, json: async () => payload };
  });
  vi.stubGlobal('fetch', fetchMock);
  return { bodies, calls: () => call };
}

const toolCallResponse = (name: string, args: unknown) => ({
  choices: [{ message: { content: '', tool_calls: [{ id: `t-${name}`, function: { name, arguments: JSON.stringify(args) } }] } }],
});
const textResponse = (content: string) => ({ choices: [{ message: { content } }] });

describe('AI 助手:意图识别去重与同义词', () => {
  it('语义蕴含去重:报告意图不再重复触发执行/归因/异常/质量/趋势', () => {
    const detection = detectIntents('生成本年执行月报，说明完成率、异常和归因');
    expect(detection.read).toContain('report');
    expect(detection.read).not.toContain('execution');
    expect(detection.read).not.toContain('attribution');
    expect(detection.read).not.toContain('anomalies');
    expect(detection.suppressed).toContain('execution');
    expect(detection.suppressed).toContain('attribution');
  });

  it('归因蕴含执行分析:同一份 completionReport 不会被算两遍', () => {
    const detection = detectIntents('本年利润为什么低于预算');
    expect(detection.read).toContain('attribution');
    expect(detection.read).not.toContain('execution');
  });

  it('口语化说法可被路由(过去这些问题一条事实都取不到)', () => {
    expect(detectIntents('哪个组织亏得最多').read).toContain('attribution');
    expect(detectIntents('谁拖后腿了').read).toContain('attribution');
    expect(detectIntents('费用超支了没').read).toContain('execution');
    expect(detectIntents('进度是不是太慢了').read).toContain('execution');
    expect(detectIntents('给我排个名').read).toContain('attribution');
  });

  it('宽泛词不再误判:裸「对比」不要求 targetVersionId，「为什么是负数」不触发归因', () => {
    expect(detectIntents('和去年对比怎么样').read).not.toContain('version_variance');
    expect(detectIntents('版本对比一下').read).toContain('version_variance');
    const explain = detectIntents('成本费用为什么是负数');
    expect(explain.read).not.toContain('attribution');
  });

  it('needsBudgetVersion 只对真正需要版本的意图为真', () => {
    expect(needsBudgetVersion(detectIntents('分析执行情况'))).toBe(true);
    expect(needsBudgetVersion(detectIntents('列出预算版本'))).toBe(false);
    expect(needsBudgetVersion(detectIntents('组织树有哪些组织'))).toBe(false);
  });
});

describe('AI 助手:上下文自动解析', () => {
  it('从自然语言解析年度、组织、科目，并回退到当前生效版本', () => {
    const { db, fx, version } = fixtureWithActual();
    const { context, resolution } = resolveMessageContext(
      db,
      '2026 年上海公司的主营业务收入执行得怎么样',
      {},
      {},
      { defaultVersion: true },
    );
    expect(context.year).toBe(2026);
    expect(context.orgScopeId).toBe(fx.orgIds.shanghai);
    expect(context.accountScopeId).toBe(fx.accIds.incomeMain);
    expect(context.budgetVersionId).toBe(version.id);
    expect(resolution.find((r) => r.field === 'budgetVersionId')?.origin).toBe('default');
    expect(resolution.find((r) => r.field === 'budgetVersionId')?.reason).toContain('当前生效');
    expect(resolution.find((r) => r.field === 'orgScopeId')?.label).toBe('上海公司');
    db.close();
  });

  it('相对年度与版本名/编号可解析，句子里写明的年度优先于筛选器', () => {
    const { db, version } = fixtureWithActual();
    const current = new Date().getFullYear();
    expect(resolveMessageContext(db, '去年执行情况如何', {}, {}, {}).context.year).toBe(current - 1);
    expect(resolveMessageContext(db, '今年怎么样', {}, {}, {}).context.year).toBe(current);

    const byName = resolveMessageContext(db, '看看 V1 的执行情况', {}, {}, { defaultVersion: true });
    expect(byName.context.budgetVersionId).toBe(version.id);
    expect(byName.context.year).toBe(2026);

    // 筛选器里的年度多是上次用过的默认值，只读提问时句子里写明的年度应当覆盖它并说明替换了什么
    const overridden = resolveMessageContext(db, '2020 年怎么样', { year: 2026 }, {}, { yearOverride: true });
    expect(overridden.context.year).toBe(2020);
    expect(overridden.resolution.find((r) => r.field === 'year')?.reason).toContain('已覆盖筛选器里的 2026 年');

    // 裸四位数信号太弱(可能是编码或金额)，不覆盖已选年度
    const bare = resolveMessageContext(db, '看看 2020 这个数', { year: 2026 }, {}, { yearOverride: true });
    expect(bare.context.year).toBe(2026);

    // 未开启覆盖(写操作场景)时请求里的年度不动，目标年度交由 action 参数处理
    const kept = resolveMessageContext(db, '复制成 2027 年草案', { year: 2026 }, {}, {});
    expect(kept.context.year).toBe(2026);
    db.close();
  });

  it('编码匹配要求两侧无字母数字，短编码不参与匹配', () => {
    const { db, fx } = fixtureWithActual();
    // 「SH」独立出现时命中上海公司
    expect(resolveMessageContext(db, '查一下 SH 的情况', {}, {}, {}).context.orgScopeId).toBe(fx.orgIds.shanghai);
    // 嵌在其他字母数字里时不命中
    expect(resolveMessageContext(db, '查一下 XSH1 的情况', {}, {}, {}).context.orgScopeId).toBeUndefined();
    // 单字符科目编码 I 不会命中任意含 I 的文本
    expect(resolveMessageContext(db, 'AI 助手能做什么', {}, {}, {}).context.accountScopeId).toBeUndefined();
    db.close();
  });

  it('快照可按日期、截至月份和「最新快照」解析', () => {
    const { db, fx } = fixtureWithActual();
    saveActualSnapshot(fx, 2026, '2026-09-30', [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '60.00' }]);
    const batches = actual.listBatches(db, 2026);
    const june = batches.find((b) => b.snapshot_date === '2026-06-30')!;
    const september = batches.find((b) => b.snapshot_date === '2026-09-30')!;

    expect(resolveMessageContext(db, '2026 年截至 2026-06-30 的实际数', {}, {}, {}).context.actualSnapshotId).toBe(june.id);
    expect(resolveMessageContext(db, '2026 年截至 7 月的实际完成情况', {}, {}, {}).context.actualSnapshotId).toBe(june.id);
    expect(resolveMessageContext(db, '2026 年按最新快照看执行', {}, {}, {}).context.actualSnapshotId).toBe(september.id);
    db.close();
  });

  it('消息年度与已选版本冲突时以消息年度为准，不再抛校验错误', async () => {
    const { db, fx } = fixtureWithActual();
    const older = budget.createVersion(db, { year: 2025, name: '2025 版' });
    budget.saveEntries(db, older.id, [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '80.00' }]);
    budget.lockVersion(db, older.id);
    budget.setCurrentVersion(db, older.id);
    // 下拉框选的是 2026 版本，但问题指向 2025 年
    const answer: any = await assistant.chat(db, { message: '2025 年执行情况怎么样', pageContext: pageSnapshot({ budgetVersionId: fixtureVersionId(db) }) });
    expect(answer.effectiveContext.year).toBe(2025);
    expect(answer.effectiveContext.budgetVersionId).toBe(older.id);
    db.close();
  });

  it('只读提问时消息年度覆盖筛选器，写操作时保留已选版本(年份是目标年度)', async () => {
    const { db, version } = fixtureWithActual();
    // 只读：句子里的 2025 年覆盖筛选器里的 2026 年，并放弃 2026 年的已选版本
    const read: any = await assistant.chat(db, { message: '2025 年执行情况怎么样', pageContext: pageSnapshot({ year: 2026, budgetVersionId: version.id }) });
    expect(read.effectiveContext.year).toBe(2025);
    expect(read.effectiveContext.budgetVersionId).toBeUndefined();

    // 写操作：2027 是复制的目标年度，分析年度与源版本都不能被它带走
    const write: any = await assistant.chat(db, { message: '把这个版本复制成 2027 年草案', pageContext: pageSnapshot({ year: 2026, budgetVersionId: version.id }) });
    expect(write.effectiveContext.year).toBe(2026);
    expect(write.effectiveContext.budgetVersionId).toBe(version.id);
    expect(write.action.type).toBe('copy_budget');
    expect(write.action.params.sourceVersionId).toBe(version.id);
    expect(write.action.params.targetYear).toBe(2027);
    db.close();
  });

  /**
   * 页面上下文(如 /budget/:id 抽屉提问)只给版本、消息里没有年份时的年度来源。
   *
   * 原行为：年度落到 defaultYear() 的当前自然年兜底，与非当前年度的版本冲突，
   * 被 validateContextConsistency 判成「context.year 与 budgetVersionId 年度不一致」，
   * 整轮直接报错——而用户一个条件都没选错。
   */
  it('请求显式带版本、消息不带年份时年度取自该版本，不再误报「年度不一致」', async () => {
    const { db, fx } = fixtureWithActual();
    // 当前自然年是 2026(夹具年度)，这里刻意建一个 2025 年的版本
    const older = budget.createVersion(db, { year: 2025, name: '2025年度预算V1' });
    budget.saveEntries(db, older.id, [
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '80.00' },
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.expenseAdmin, amount: '10.00' },
    ]);

    const resolved = resolveMessageContext(
      db,
      '这个版本执行得怎么样',
      { budgetVersionId: older.id, pageKey: 'budget_edit' },
      {},
      { defaultVersion: true, yearOverride: true },
    );
    expect(resolved.context.year).toBe(2025);
    expect(resolved.context.budgetVersionId).toBe(older.id);
    const yearItem = resolved.resolution.find((r) => r.field === 'year');
    expect(yearItem?.origin).toBe('request');
    expect(yearItem?.reason).toContain('2025年度预算V1');

    // 上一轮聊的是 2026 年：页面切到 2025 年的版本后，年度同样要跟着请求里的版本走
    const first: any = await assistant.chat(db, { message: '2026 年执行情况怎么样', pageContext: pageSnapshot() });
    expect(first.effectiveContext.year).toBe(2026);
    const second: any = await assistant.chat(db, { conversationId: first.conversationId, message: '这个版本执行得怎么样', pageContext: pageSnapshot({ budgetVersionId: older.id, pageKey: 'budget_edit' }) });
    expect(second.effectiveContext.year).toBe(2025);
    expect(second.effectiveContext.budgetVersionId).toBe(older.id);
    expect(second.text).not.toContain('年度不一致');
    db.close();
  });

  it('contextDigest 只输出 ID/名称/状态，不含任何金额', () => {
    const { db, version } = fixtureWithActual();
    const { context, resolution } = resolveMessageContext(db, '2026 年执行情况', {}, {}, { defaultVersion: true });
    const digest = contextDigest(db, context, resolution);
    expect(digest.years).toContain(2026);
    expect(digest.versions.some((v) => v.id === version.id && v.isCurrent)).toBe(true);
    expect(digest.snapshots.length).toBeGreaterThan(0);
    const json = JSON.stringify(digest);
    expect(json).not.toMatch(/amount|Cents|cents/);
    db.close();
  });
});

/** 取 2026 年当前生效版本 ID(用于冲突用例)。 */
function fixtureVersionId(db: any): number {
  const row = db.prepare("SELECT id FROM budget_version WHERE year=2026 ORDER BY id LIMIT 1").get() as { id: number };
  return row.id;
}

describe('AI 助手:模型优先路由与兜底', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.AI_BASE_URL;
    delete process.env.AI_API_KEY;
    delete process.env.AI_STREAM;
    delete process.env.AI_TIMEOUT_MS;
  });

  it('模型自主调用只读工具时 routing=model，且不预先计算重型报表', async () => {
    const { db, version } = fixtureWithActual();
    const stub = stubModel([
      toolCallResponse('calculate_attribution', { versionId: version.id, topN: 3 }),
      textResponse('上海公司收入未达预算是主要原因。'),
    ]);
    const answer: any = await assistant.chat(db, { message: '哪个组织亏得最多', pageContext: pageSnapshot({ year: 2026 }) });
    expect(answer.routing).toBe('model');
    expect(answer.text).toBe('上海公司收入未达预算是主要原因。');
    expect(answer.facts.some((f: any) => f.type === 'tool:calculate_attribution')).toBe(true);
    // 路由由模型决定，后端没有另外再算一份 attribution 事实
    expect(answer.facts.some((f: any) => f.type === 'attribution')).toBe(false);
    expect(answer.facts.length).toBe(answer.citations.length);
    // 第一轮提示词里只有上下文摘要，没有完成率/金额
    expect(JSON.stringify(stub.bodies[0].messages[0].content)).not.toMatch(/budgetCents/);
    db.close();
  });

  it('模型一次工具都没调用时回退到关键词事实，再让模型据实作答', async () => {
    const { db } = fixtureWithActual();
    const stub = stubModel([
      textResponse(''),
      textResponse('按后端事实：收入完成率偏低。'),
    ]);
    const answer: any = await assistant.chat(db, { message: '本年执行情况如何', pageContext: pageSnapshot({ year: 2026 }) });
    expect(answer.routing).toBe('model');
    expect(answer.text).toBe('按后端事实：收入完成率偏低。');
    expect(answer.facts.some((f: any) => f.type === 'execution')).toBe(true);
    // 兜底轮把事实注入到提示词
    expect(JSON.stringify(stub.bodies[1].messages).includes('没有调用任何工具')).toBe(true);
    db.close();
  });

  it('模型不可用时 routing=rules，模板回答带真实数字', async () => {
    const { db } = fixtureWithActual();
    const answer: any = await assistant.chat(db, { message: '本年执行情况如何', pageContext: pageSnapshot({ year: 2026 }) });
    expect(answer.routing).toBe('rules');
    expect(answer.modelError).toBeNull();
    expect(answer.text).toContain('预算执行事实查询');
    // 模板模式必须给出金额与完成率，而不是「已查询到 N 组事实」
    // 夹具金额以元录入(收入 100+50 元、实际 40+30 元)，万元口径下显示 0.02 / 0.01
    expect(answer.text).toContain('收入预算 0.02 / 实际 0.01 万元，完成率 46.7%');
    expect(answer.text).toContain('时间进度');
    expect(answer.text).toContain('指标：毛利');
    db.close();
  });

  it('模型异常时降级为确定性结果并记录 modelError', async () => {
    const { db } = fixtureWithActual();
    stubModel([]);
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: false, status: 503, text: async () => 'unavailable' })));
    const answer: any = await assistant.chat(db, { message: '本年执行情况如何', pageContext: pageSnapshot({ year: 2026 }) });
    expect(answer.routing).toBe('rules');
    expect(answer.modelError).toContain('503');
    expect(answer.text).toContain('预算执行事实查询');
    db.close();
  });

  it('模型全程返回空内容时标为 rules 并写明原因，不伪装成模型路由', async () => {
    const { db } = fixtureWithActual();
    // 两轮都返回空正文、无工具调用：答案实际来自确定性兜底，
    // 此时 routing 必须是 rules，否则前端会显示「模型路由」却拿到模板文案。
    stubModel([textResponse(''), textResponse('')]);
    const answer: any = await assistant.chat(db, { message: '本年执行情况如何', pageContext: pageSnapshot({ year: 2026 }) });
    expect(answer.routing).toBe('rules');
    expect(answer.modelError).toContain('模型未返回可用内容');
    expect(answer.text).toContain('预算执行事实查询');
    expect(answer.facts.map((f: any) => f.type)).toContain('execution');
    db.close();
  });
});

describe('AI 助手:写操作参数抽取', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.AI_BASE_URL;
    delete process.env.AI_API_KEY;
  });

  it('规则兜底解析基准来源、基准年度、目标年度与名称(不再硬编码)', async () => {
    const { db } = fixtureWithActual();
    const answer: any = await assistant.chat(db, { message: '按 2024 年实际增长 8% 生成 2027 年草案，叫做「2027 年冲刺版」', pageContext: pageSnapshot({ year: 2026 }) });
    expect(answer.action).toMatchObject({
      type: 'budget_draft',
      source: 'rules',
      params: { year: 2027, baseFrom: 'actual', baseYear: 2024, growthRate: 0.08, name: '2027 年冲刺版' },
    });
    db.close();
  });

  it('下调与情景分类增长率按方向取负值', async () => {
    const { db, version } = fixtureWithActual();
    const answer: any = await assistant.chat(db, { message: '做个情景测算：收入下降 5%，成本上升 3%，费用压减 2%', pageContext: pageSnapshot({ year: 2026, budgetVersionId: version.id }) });
    expect(answer.action).toMatchObject({
      type: 'scenario',
      params: { incomeGrowth: -0.05, costGrowth: 0.03, expenseGrowth: -0.02 },
    });
    db.close();
  });

  it('模型抽参优先，且只保留白名单字段', async () => {
    const { db, version } = fixtureWithActual();
    stubModel([textResponse(JSON.stringify({
      type: 'copy_budget',
      params: { sourceVersionId: version.id, targetYear: 2027, name: '模型草案', growthRate: 0.05, evil: 'DROP TABLE' },
      reason: '用户要求复制并增长 5%',
    }))]);
    const answer: any = await assistant.chat(db, { message: '把这个版本复制成 2027 年草案，整体增长 5%', pageContext: pageSnapshot({ year: 2026, budgetVersionId: version.id }) });
    expect(answer.action.source).toBe('model');
    expect(answer.action.previewable).toBe(true);
    expect(answer.action.reason).toContain('增长 5%');
    expect(answer.action.params).toEqual({ sourceVersionId: version.id, targetYear: 2027, name: '模型草案', growthRate: 0.05 });
    expect(Object.keys(answer.action.params)).not.toContain('evil');
    db.close();
  });

  it('模型给出不可构造的参数时退回规则推断，且始终不写库', async () => {
    const { db, version } = fixtureWithActual();
    stubModel([textResponse(JSON.stringify({ type: 'copy_budget', params: { sourceVersionId: 999_999, targetYear: 2027 } }))]);
    const answer: any = await assistant.chat(db, { message: '把这个版本复制成 2027 年草案', pageContext: pageSnapshot({ year: 2026, budgetVersionId: version.id }) });
    expect(answer.action.source).toBe('rules');
    expect(answer.action.params.sourceVersionId).toBe(version.id);
    // 建议阶段不产生任何 action 行
    expect((db.prepare('SELECT COUNT(*) c FROM ai_action').get() as any).c).toBe(0);
    db.close();
  });

  it('模型不得提出 bulk_adjustment(逐格金额只能由用户给出)', async () => {
    const { db, version } = fixtureWithActual();
    stubModel([textResponse(JSON.stringify({
      type: 'bulk_adjustment',
      params: { versionId: version.id, entries: [{ orgId: 1, accountId: 1, amount: '999.00' }] },
    }))]);
    const answer: any = await assistant.chat(db, { message: '批量调整所有费用', pageContext: pageSnapshot({ year: 2026, budgetVersionId: version.id }) });
    expect(answer.action).toBeNull();
    expect((db.prepare('SELECT COUNT(*) c FROM budget_entry WHERE amount_cents=99900').get() as any).c).toBe(0);
    db.close();
  });
});

describe('AI 助手:多轮追问', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.AI_BASE_URL;
    delete process.env.AI_API_KEY;
  });

  it('第二轮继承上一轮解析出的上下文', async () => {
    const { db, fx, version } = fixtureWithActual();
    const first: any = await assistant.chat(db, { message: '2026 年上海公司执行情况如何', pageContext: pageSnapshot() });
    expect(first.effectiveContext.budgetVersionId).toBe(version.id);
    expect(first.effectiveContext.orgScopeId).toBe(fx.orgIds.shanghai);
    expect(first.contextTrace.used).toContainEqual(expect.objectContaining({ field: 'budgetVersionId', value: version.id, label: version.name }));
    expect(first.contextTrace.used).toContainEqual(expect.objectContaining({ field: 'orgScopeId', value: fx.orgIds.shanghai, label: '上海公司' }));

    const second: any = await assistant.chat(db, { conversationId: first.conversationId, message: '那完成率呢', pageContext: pageSnapshot() });
    expect(second.effectiveContext.year).toBe(2026);
    expect(second.effectiveContext.budgetVersionId).toBe(version.id);
    expect(second.effectiveContext.orgScopeId).toBe(fx.orgIds.shanghai);
    expect(second.contextTrace.used.some((r: any) => r.origin === 'conversation')).toBe(true);
    db.close();
  });

  it('历史消息回灌上一轮结构化事实摘要，而不只是纯文本', async () => {
    const { db, version } = fixtureWithActual();
    const first: any = await assistant.chat(db, { message: '本年差异归因', pageContext: pageSnapshot({ year: 2026, budgetVersionId: version.id }) });
    expect(first.facts.some((f: any) => f.type === 'attribution')).toBe(true);

    const stub = stubModel([textResponse('第二名是杭州公司。')]);
    await assistant.chat(db, { conversationId: first.conversationId, message: '那第二名呢', pageContext: pageSnapshot() });
    const history = JSON.stringify(stub.bodies[0].messages);
    expect(history).toContain('上一轮结构化事实');
    expect(history).toContain('rankedOrgLeaves');
    db.close();
  });

  it('纯追问沿用上一轮意图，不再退化成版本列表', async () => {
    const { db } = fixtureWithActual();
    const first: any = await assistant.chat(db, { message: '哪个组织亏得最多', pageContext: pageSnapshot() });
    expect(first.intents.read).toContain('attribution');

    for (const message of ['那第二名呢', '上海公司呢', '再往下拆一层']) {
      const next: any = await assistant.chat(db, { conversationId: first.conversationId, message, pageContext: pageSnapshot() });
      expect(next.intents.inheritedRead, message).toContain('attribution');
      expect(next.facts.map((f: any) => f.type), message).toContain('attribution');
      // 退化时的表现是只剩版本列表，这里必须不再出现。
      expect(next.facts.map((f: any) => f.type), message).not.toContain('budget_versions');
    }
    db.close();
  });

  it('纯缩范围追问(只给组织名)也沿用上一轮意图并换范围', async () => {
    const { db, fx } = fixtureWithActual();
    const first: any = await assistant.chat(db, { message: '本年执行情况怎么样', pageContext: pageSnapshot() });
    expect(first.intents.read).toContain('execution');

    const second: any = await assistant.chat(db, { conversationId: first.conversationId, message: '杭州公司', pageContext: pageSnapshot() });
    expect(second.intents.inheritedRead).toContain('execution');
    expect(second.effectiveContext.orgScopeId).toBe(fx.orgIds.hangzhou);
    expect(second.facts.map((f: any) => f.type)).toContain('execution');
    db.close();
  });

  it('换了新话题时不沿用：有自己的意图、或没有追问信号都不继承', async () => {
    const { db } = fixtureWithActual();
    const first: any = await assistant.chat(db, { message: '哪个组织亏得最多', pageContext: pageSnapshot() });

    // 有自己的意图 → 用自己的
    const own: any = await assistant.chat(db, { conversationId: first.conversationId, message: '列出预算版本', pageContext: pageSnapshot() });
    expect(own.intents.read).toContain('budget_versions');
    expect(own.intents.inheritedRead).toEqual([]);

    // 没有任何追问信号的新消息 → 不继承
    const unrelated: any = await assistant.chat(db, { conversationId: first.conversationId, message: '你好', pageContext: pageSnapshot() });
    expect(unrelated.intents.inheritedRead).toEqual([]);
    expect(unrelated.facts.map((f: any) => f.type)).not.toContain('attribution');
    db.close();
  });

  it('报告意图的追问改为继承差异归因，不重新组一份完整报告', () => {
    const report = detectIntents('生成本年执行月报');
    expect(report.read).toContain('report');
    const followUp = withInheritedIntents(detectIntents('那第二名呢'), report.read, '那第二名呢');
    expect(followUp.read).toEqual(['attribution']);
    expect(followUp.inheritedRead).toEqual(['attribution']);
  });

  it('写意图追问不继承只读意图，避免把新的写请求当成旧话题', () => {
    const previous = detectIntents('本年差异归因');
    const followUp = withInheritedIntents(detectIntents('那再导出一份完成率表'), previous.read, '那再导出一份完成率表');
    expect(followUp.write).toContain('export');
    expect(followUp.inheritedRead).toEqual([]);
  });

  it('追问信号识别边界', () => {
    expect(looksLikeFollowUp('那第二名呢')).toBe(true);
    expect(looksLikeFollowUp('上海公司呢')).toBe(true);
    expect(looksLikeFollowUp('再往下拆一层')).toBe(true);
    expect(looksLikeFollowUp('继续')).toBe(true);
    expect(looksLikeFollowUp('刚才那个组织')).toBe(true);
    expect(looksLikeFollowUp('你好')).toBe(false);
    expect(looksLikeFollowUp('导出一份完成率表')).toBe(false);
    expect(looksLikeFollowUp('')).toBe(false);
  });
});

describe('AI 助手:真流式 SSE', () => {
  it('先落响应头与 open 事件，token 逐块下发，done 带完整结构化响应', async () => {
    const dbPath = `/tmp/assistant-stream-${Date.now()}.sqlite`;
    const { app } = await createTestApp({ dbPath });
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const port = (server.address() as any).port;
    const response = await authFetch(`http://127.0.0.1:${port}/api/assistant/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '列出预算版本', pageContext: pageSnapshot({ year: 2026 }) }),
    });
    expect(response.status).toBe(200);
    expect(response.headers.get('x-accel-buffering')).toBe('no');
    const body = await response.text();
    expect(body.indexOf('event: open')).toBe(0);
    expect(body).toContain('event: token');
    expect(body.indexOf('event: token')).toBeLessThan(body.indexOf('event: done'));
    expect(body).toContain('"done":true');
    expect(body).toContain('"routing":"rules"');
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });

  it('请求体非法时仍返回结构化 400，而不是半截 SSE', async () => {
    const dbPath = `/tmp/assistant-stream-bad-${Date.now()}.sqlite`;
    const { app } = await createTestApp({ dbPath });
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const port = (server.address() as any).port;
    const response = await authFetch(`http://127.0.0.1:${port}/api/assistant/chat/stream`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ message: '' }),
    });
    expect(response.status).toBe(400);
    expect(((await response.json()) as { code: string }).code).toBe('CONTEXT_INVALID');
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});

describe('AI 助手:只读工具参数收紧', () => {
  it('get_operation_log 只接受白名单参数', () => {
    const db = testDb();
    expect(executeTool(db, 'get_operation_log', { page: 1, pageSize: 5 })).toHaveProperty('items');
    expect(() => executeTool(db, 'get_operation_log', { page: 0 })).toThrow(/page/);
    expect(() => executeTool(db, 'get_operation_log', { pageSize: 5_000 })).toThrow(/pageSize/);
    expect(() => executeTool(db, 'get_operation_log', { entityType: 123 })).toThrow(/entityType/);
    db.close();
  });

  it('意图路由后 queryFacts 不再对同一问题重复取执行分析', () => {
    const { db, version } = fixtureWithActual();
    const facts = queryFacts(db, '本年利润为什么低于预算', { year: 2026, budgetVersionId: version.id });
    expect(facts.filter((f) => f.type === 'attribution')).toHaveLength(1);
    expect(facts.filter((f) => f.type === 'execution')).toHaveLength(0);
    db.close();
  });

  it('组织范围会传递给确定性查询', () => {
    const { db, fx, version } = fixtureWithActual();
    const facts = queryFacts(db, '上海公司执行情况', { year: 2026, budgetVersionId: version.id, orgScopeId: fx.orgIds.shanghai });
    const execution: any = facts.find((f) => f.type === 'execution')?.data;
    expect(execution).toBeTruthy();
    expect(execution.byOrg.every((row: any) => row.orgId !== fx.orgIds.hangzhou)).toBe(true);
    db.close();
  });
});

describe('AI 助手:组织与科目名称解析边界', () => {
  it('最长名称优先，避免父级组织抢走子级命中', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const sub = org.createOrg(db, { parentId: fx.orgIds.shanghai, code: 'SHPD', name: '上海公司浦东分部' }).id;
    const hit = resolveMessageContext(db, '上海公司浦东分部完成得怎么样', {}, {}, {});
    expect(hit.context.orgScopeId).toBe(sub);
    db.close();
  });
});


describe('AI 助手:模型适配层真流式', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.AI_BASE_URL;
    delete process.env.AI_API_KEY;
    delete process.env.AI_STREAM;
  });

  /** 用一个可迭代的 ReadableStream 模拟供应商 SSE。 */
  function sseResponse(chunks: string[]) {
    const encoder = new TextEncoder();
    let index = 0;
    return {
      ok: true,
      headers: { get: () => 'text/event-stream' },
      body: {
        getReader: () => ({
          read: async () => (index < chunks.length
            ? { done: false, value: encoder.encode(chunks[index++]) }
            : { done: true, value: undefined }),
        }),
      },
    };
  }

  it('逐块转发 delta.content，并按 index 拼接分片的 tool_calls 参数', async () => {
    process.env.AI_BASE_URL = 'http://model.test/v1';
    const { EnvChatModel } = await import('../src/assistant/model');
    vi.stubGlobal('fetch', vi.fn(async (_url: string, options: any) => {
      expect(JSON.parse(options.body).stream).toBe(true);
      return sseResponse([
        'data: {"choices":[{"delta":{"content":"上海"}}]}\n\n',
        'data: {"choices":[{"delta":{"content":"公司"}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"c1","function":{"name":"calculate_execution","arguments":"{\\"versi"}}]}}]}\n\n',
        'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"function":{"arguments":"onId\\":7}"}}]}}]}\n\n',
        'data: [DONE]\n\n',
      ]);
    }));
    const chunks: string[] = [];
    let result: any = null;
    for await (const event of new EnvChatModel().streamChat({ messages: [{ role: 'user', content: 'x' }] })) {
      if (event.type === 'text') chunks.push(event.text);
      else result = event.result;
    }
    // 真流式：正文按供应商分片逐块到达，而不是一次性整段
    expect(chunks).toEqual(['上海', '公司']);
    expect(result.text).toBe('上海公司');
    expect(result.toolCalls).toEqual([{ id: 'c1', name: 'calculate_execution', arguments: { versionId: 7 } }]);
  });

  it('供应商返回普通 JSON(无流式 body)时按一次性响应解析，不重复请求', async () => {
    process.env.AI_BASE_URL = 'http://model.test/v1';
    const { EnvChatModel } = await import('../src/assistant/model');
    const fetchMock = vi.fn(async () => ({ ok: true, json: async () => textResponse('一次性回答') }));
    vi.stubGlobal('fetch', fetchMock);
    const events: any[] = [];
    for await (const event of new EnvChatModel().streamChat({ messages: [{ role: 'user', content: 'x' }] })) events.push(event);
    expect(events[0]).toEqual({ type: 'text', text: '一次性回答' });
    expect(events[1].result.text).toBe('一次性回答');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('供应商忽略 stream:true、用流式 body 送普通 JSON 时仍按一次性响应解析', async () => {
    process.env.AI_BASE_URL = 'http://model.test/v1';
    const { EnvChatModel } = await import('../src/assistant/model');
    // 有 body.getReader，但内容里没有任何 data: 行，只是一整份 completion JSON。
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse([JSON.stringify(textResponse('忽略流式的回答'))])));
    const events: any[] = [];
    for await (const event of new EnvChatModel().streamChat({ messages: [{ role: 'user', content: 'x' }] })) events.push(event);
    expect(events[0]).toEqual({ type: 'text', text: '忽略流式的回答' });
    expect(events[1].result.text).toBe('忽略流式的回答');
  });

  it('响应既不是 SSE 也不是合法 JSON 时显式报错，而不是静默返回空结果', async () => {
    process.env.AI_BASE_URL = 'http://model.test/v1';
    const { EnvChatModel } = await import('../src/assistant/model');
    vi.stubGlobal('fetch', vi.fn(async () => sseResponse(['这不是 JSON，也不是 SSE'])));
    await expect(async () => {
      for await (const _ of new EnvChatModel().streamChat({ messages: [{ role: 'user', content: 'x' }] })) { /* 消费到抛错 */ }
    }).rejects.toThrow(/既不是 SSE 流也不是合法 JSON/);
  });

  it('AI_STREAM=0 时退回一次性响应', async () => {
    process.env.AI_BASE_URL = 'http://model.test/v1';
    process.env.AI_STREAM = '0';
    const { EnvChatModel } = await import('../src/assistant/model');
    const fetchMock = vi.fn(async (_url: string, options: any) => {
      expect(JSON.parse(options.body).stream).toBeUndefined();
      return { ok: true, json: async () => textResponse('非流式') };
    });
    vi.stubGlobal('fetch', fetchMock);
    const events: any[] = [];
    for await (const event of new EnvChatModel().streamChat({ messages: [{ role: 'user', content: 'x' }] })) events.push(event);
    expect(events[1].result.text).toBe('非流式');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('chat 的 onToken 回调按增量回调，SSE 首字不必等完整回答', async () => {
    const { db } = fixtureWithActual();
    process.env.AI_BASE_URL = 'http://model.test/v1';
    let call = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      call += 1;
      return call === 1
        ? sseResponse([
          'data: {"choices":[{"delta":{"tool_calls":[{"index":0,"id":"t1","function":{"name":"list_budget_versions","arguments":"{\\"year\\":2026}"}}]}}]}\n\n',
          'data: [DONE]\n\n',
        ])
        : sseResponse([
          'data: {"choices":[{"delta":{"content":"2026 年"}}]}\n\n',
          'data: {"choices":[{"delta":{"content":"共 1 个版本。"}}]}\n\n',
          'data: [DONE]\n\n',
        ]);
    }));
    const tokens: string[] = [];
    const answer: any = await assistant.chat(db, { message: '列出预算版本', pageContext: pageSnapshot({ year: 2026 }) }, '', {
      onToken: (chunk) => tokens.push(chunk),
    });
    expect(tokens).toEqual(['2026 年', '共 1 个版本。']);
    expect(answer.text).toBe('2026 年共 1 个版本。');
    expect(answer.facts.some((f: any) => f.type === 'tool:list_budget_versions')).toBe(true);
    db.close();
  });

  it('无模型时确定性摘要也分块回调，前端观感一致', async () => {
    const { db } = fixtureWithActual();
    const tokens: string[] = [];
    const answer: any = await assistant.chat(db, { message: '本年执行情况如何', pageContext: pageSnapshot({ year: 2026 }) }, '', {
      onToken: (chunk) => tokens.push(chunk),
    });
    expect(tokens.length).toBeGreaterThan(1);
    expect(tokens.join('')).toBe(answer.text);
    db.close();
  });
});



/**
 * 正文数字核对。
 *
 * 实测(gemini-flash-latest,真实库)发现模型会在转述工具结果时改坏数字:同一个问题问三次，
 * 有一次把 2024 年预算发电量 399666.86 写成 439666.86，其余数字都对。后端事实是对的，
 * 错在转述那一步，所以只能在正文侧做事后核对。
 *
 * 与报告的数字守卫处置方式不同：报告有确定性模板稿可以退回，对不上就整篇丢弃改写；
 * 正文没有等价替代品，丢弃只会退回「已查询到 N 组后端事实数据」这句没信息的套话，
 * 因此正文侧只核对并在 numberCheck 里标注，不改写正文。
 */
describe('AI 助手:正文数字核对', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.AI_BASE_URL;
    delete process.env.AI_API_KEY;
    delete process.env.AI_STREAM;
  });

  it('模型正文里的数值能与事实对上时 status=ok', async () => {
    const { db, version } = fixtureWithActual();
    stubModel([
      toolCallResponse('calculate_execution', { versionId: version.id }),
      // 0.02 = centsToWanText(15000)(收入预算 150.00 元)；46.67% = 实际 7000 分 / 预算 15000 分
      textResponse('范围内收入预算 0.02 万元，收入完成率 46.67%。'),
    ]);
    const out: any = await assistant.chat(db, { message: '2026年执行情况', pageContext: pageSnapshot({ year: 2026, budgetVersionId: version.id }) });
    expect(out.routing).toBe('model');
    expect(out.numberCheck.status).toBe('ok');
    expect(out.numberCheck.unverified).toEqual([]);
    expect(out.numberCheck.checked).toBeGreaterThan(0);
    db.close();
  });

  it('模型把数字改坏时 status=unverified 并列出对不上的数值，但不丢弃正文', async () => {
    const { db, version } = fixtureWithActual();
    stubModel([
      toolCallResponse('calculate_execution', { versionId: version.id }),
      // 439666.86 在事实里根本不存在(复刻真实观测到的改坏一位数字)
      textResponse('范围内预算合计 439666.86 万元，收入完成率 46.67%。'),
    ]);
    const out: any = await assistant.chat(db, { message: '2026年执行情况', pageContext: pageSnapshot({ year: 2026, budgetVersionId: version.id }) });
    expect(out.numberCheck.status).toBe('unverified');
    expect(out.numberCheck.unverified).toContain('439666.86');
    expect(out.numberCheck.note).toContain('复核');
    // 正文原样保留：核对失败不等于要把回答换成没信息的模板
    expect(out.text).toContain('439666.86');
    db.close();
  });

  it('模型自行换算单位也会被标出来(事实里只有分,没有亿元)', async () => {
    const { db, version } = fixtureWithActual();
    stubModel([
      toolCallResponse('calculate_execution', { versionId: version.id }),
      textResponse('范围内预算合计约 1.93 亿元。'),
    ]);
    const out: any = await assistant.chat(db, { message: '2026年执行情况', pageContext: pageSnapshot({ year: 2026, budgetVersionId: version.id }) });
    expect(out.numberCheck.status).toBe('unverified');
    expect(out.numberCheck.unverified).toContain('1.93');
    db.close();
  });

  it('纯整数(年度/版本号/章节序号)不参与核对，不会因为模型编号而误报', async () => {
    const { db, version } = fixtureWithActual();
    stubModel([
      toolCallResponse('calculate_execution', { versionId: version.id }),
      textResponse(`第 1 节 2026 年版本 #${version.id} 共 3 个组织：收入完成率 46.67%。`),
    ]);
    const out: any = await assistant.chat(db, { message: '2026年执行情况', pageContext: pageSnapshot({ year: 2026, budgetVersionId: version.id }) });
    expect(out.numberCheck.status).toBe('ok');
    db.close();
  });

  it('正文没有数值、或本轮没有事实时 status=skipped', async () => {
    const { db, version } = fixtureWithActual();
    stubModel([
      toolCallResponse('calculate_execution', { versionId: version.id }),
      textResponse('该版本已锁定，无法修改。'),
    ]);
    const out: any = await assistant.chat(db, { message: '2026年执行情况', pageContext: pageSnapshot({ year: 2026, budgetVersionId: version.id }) });
    expect(out.numberCheck.status).toBe('skipped');
    expect(out.numberCheck.checked).toBe(0);
    db.close();
  });

  it('模板正文不做自我核对(数字本来就是后端按事实格式化出来的)', async () => {
    const { db, version } = fixtureWithActual();
    const out: any = await assistant.chat(db, { message: '2026年执行情况', pageContext: pageSnapshot({ year: 2026, budgetVersionId: version.id }) });
    expect(out.routing).toBe('rules');
    expect(out.numberCheck.status).toBe('skipped');
    expect(out.numberCheck.note).toContain('确定性模板');
    db.close();
  });
});

describe('AI 助手:工具 Schema 兼容性与合法性', () => {
  it('所有工具 parameters 中的 enum 都不包含 null 或 undefined(兼容 Gemini 等严格模式供应商)', async () => {
    const { toolDefinitions } = await import('../src/assistant/tools');
    expect(toolDefinitions.length).toBeGreaterThan(0);
    for (const tool of toolDefinitions) {
      const params = tool.function.parameters as any;
      if (!params || !params.properties) continue;
      for (const [propName, prop] of Object.entries<any>(params.properties)) {
        if (Array.isArray(prop?.enum)) {
          expect(prop.enum).not.toContain(null);
          expect(prop.enum).not.toContain(undefined);
          for (const item of prop.enum) {
            expect(typeof item).toBe('string');
            expect(item.length).toBeGreaterThan(0);
          }
        }
      }
    }
  });
});
