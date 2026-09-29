import { describe, it, expect } from 'vitest';
import { anomalyReport } from '../src/assistant/anomaly';
import { explainTerms, GLOSSARY } from '../src/assistant/glossary';
import { navigationCatalog, resolveNavigation } from '../src/assistant/navigation';
import { queryFacts } from '../src/assistant/facts';
import * as assistant from '../src/assistant/service';
import { executeTool } from '../src/assistant/tools';
import { createApp } from '../src/server';
import { freezeYear } from '../src/modules/report/report.service';
import { testDb, buildFixture, standardBudgetVersion, saveActualSnapshot, budget, account, actual, org } from './helpers';

/** 方案《AI助手完整方案》4.1 页面导航 / 业务解释、4.2 异常与质量检查、5.4 ai_insight */
describe('AI 助手:导航、业务解释与异常检查', () => {
  it('导航意图必须同时命中动作词与页面词，并返回真实前端路由', () => {
    expect(resolveNavigation('打开预算执行分析', {})).toMatchObject({ page: 'analysis', path: '/analysis' });
    expect(resolveNavigation('帮我进入组织树维护', {})).toMatchObject({ page: 'org', path: '/org' });
    expect(resolveNavigation('跳转到编制页面', { budgetVersionId: 7 })).toMatchObject({ page: 'budget_edit', path: '/budget/7' });
    expect(resolveNavigation('去看操作日志', {})).toMatchObject({ page: 'logs', path: '/data?tab=logs' });
    // 普通查询不应被判成跳转
    expect(resolveNavigation('分析预算执行差异', {})).toBeNull();
    expect(resolveNavigation('', {})).toBeNull();
    const catalog = navigationCatalog();
    expect(catalog.length).toBeGreaterThanOrEqual(15);
    expect(catalog.every((page) => page.path.startsWith('/'))).toBe(true);
  });

  it('chat 返回 navigation 字段并给出上下文相关建议', async () => {
    const db = testDb(); const fx = buildFixture(db); const version = standardBudgetVersion(fx);
    const nav: any = await assistant.chat(db, { message: '打开本年执行分析页面', context: { year: 2026, budgetVersionId: version.id } });
    expect(nav.navigation).toMatchObject({ page: 'analysis', path: '/analysis' });
    expect(nav.navigation.params).toMatchObject({ year: 2026, versionId: version.id });
    expect(nav.suggestions.some((s: string) => s.includes('打开「年度执行分析」页面'))).toBe(true);
    expect(nav.text).toContain('/analysis');

    const plain: any = await assistant.chat(db, { message: '列出预算版本', context: { year: 2026 } });
    expect(plain.navigation).toBeNull();
    expect(plain.suggestions.some((s: string) => s.includes('选择预算版本'))).toBe(true);
    expect(plain.suggestions.length).toBeGreaterThan(0);
    db.close();
  });

  it('业务解释在没有模型时也返回确定性口径(金额方向/单位换算/完成率)', async () => {
    const db = testDb();
    const facts = queryFacts(db, '解释一下万元、元、分怎么换算', {});
    const glossary: any = facts.find((f) => f.type === 'glossary');
    expect(glossary).toBeTruthy();
    expect(glossary.data.entries.some((e: any) => e.key === 'unit_conversion')).toBe(true);

    const answer: any = await assistant.chat(db, { message: '解释一下成本费用金额方向为什么是负数' });
    expect(answer.text).toContain('利润方向');
    expect(answer.facts.some((f: any) => f.type === 'glossary')).toBe(true);
    expect(answer.facts.length).toBe(answer.citations.length);

    const rate = explainTerms('完成率怎么算', 2);
    expect(rate[0].key).toBe('completion_rate');
    // 示例由 core/money 真实计算得出
    const unit = GLOSSARY.find((e) => e.key === 'unit_conversion')!;
    expect(unit.examples).toContain('1.00 万元 = 10000.00 元 = 1000000 分');
    expect(executeTool(db, 'explain_terms', { query: '快照' }).matched[0].key).toBe('snapshot');
    db.close();
  });

  it('异常检查覆盖方案 4.2 全部七类规则并保持数量隔离', () => {
    const db = testDb(); const fx = buildFixture(db);
    const quantityId = account.createAccount(db, { parentId: null, code: 'Q01', name: '发电量', type: 'quantity', unit: '万千瓦时' }).id;
    // 上一年度实际:收入 100(上海)/50(杭州),成本 60/30,费用 20/10
    saveActualSnapshot(fx, 2025, '2025-12-31', [
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '100.00' },
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.costSub, amount: '60.00' },
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.expenseAdmin, amount: '20.00' },
      { orgId: fx.orgIds.hangzhou, accountId: fx.accIds.incomeMain, amount: '50.00' },
    ]);
    // 本年预算:收入较上年 +100%(触发同比)、其他费用 0 预算、销售费用有预算无实际
    const version = budget.createVersion(db, { year: 2026, name: '异常检查版本' });
    budget.saveEntries(db, version.id, [
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '300.00' },
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.costSub, amount: '60.00' },
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.expenseAdmin, amount: '20.00' },
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.expenseSales, amount: '15.00' },
      { orgId: fx.orgIds.shanghai, accountId: quantityId, quantity: '120.0000' },
      { orgId: fx.orgIds.hangzhou, accountId: fx.accIds.incomeMain, amount: '50.00' },
    ]);
    // 本年实际:收入只完成一半、其他费用零预算却有实际、销售费用无实际
    actual.saveActual(db, {
      year: 2026, snapshotDate: '2026-06-30', source: 'manual', mode: 'replace',
      entries: [
        { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '150.00' },
        { orgId: fx.orgIds.shanghai, accountId: fx.accIds.costSub, amount: '60.00' },
        { orgId: fx.orgIds.shanghai, accountId: fx.accIds.expenseAdmin, amount: '20.00' },
        { orgId: fx.orgIds.shanghai, accountId: fx.accIds.expenseOther, amount: '7.00' },
        { orgId: fx.orgIds.shanghai, accountId: quantityId, quantity: '60.0000' },
        { orgId: fx.orgIds.hangzhou, accountId: fx.accIds.incomeMain, amount: '50.00' },
      ],
    });
    const result = anomalyReport(db, { versionId: version.id, threshold: 0.2, yoyThreshold: 0.3 });
    const codes = new Set(result.anomalies.map((item) => item.code));
    expect(codes.has('ZERO_BUDGET_WITH_ACTUAL')).toBe(true);
    expect(codes.has('RATE_DEVIATION')).toBe(true);
    expect(codes.has('BUDGET_WITHOUT_ACTUAL')).toBe(true);
    expect(codes.has('YOY_GROWTH_EXCEEDED')).toBe(true);
    // 年度未关闭,基准是时间进度(2026-06-30 → 181/365 = 49.59%)而不是全年 100%。
    // 实际利润完成率 113/205 = 55.12%,偏离基准仅 5.53%,属于按节奏推进,不该报异常;
    // 旧实现拿完成率跟 1 比(偏离 44.88%)会把按计划执行判成异常。
    expect(result.rateBaseline).toBeCloseTo(181 / 365, 6);
    expect(result.yearClosed).toBe(false);
    expect(codes.has('PROFIT_TARGET_MISMATCH')).toBe(false);
    // 收紧阈值到 5% 后才应命中,证明规则本身仍然有效、只是基准换了
    const tightened = anomalyReport(db, { versionId: version.id, threshold: 0.05, yoyThreshold: 0.3 });
    expect(new Set(tightened.anomalies.map((item) => item.code)).has('PROFIT_TARGET_MISMATCH')).toBe(true);
    expect(result.checks.map((c) => c.code)).toContain('PROFIT_TARGET_MISMATCH');
    expect(result.checks.map((c) => c.code)).toContain('PEER_DEVIATION');
    expect(result.checks.map((c) => c.code)).toContain('QUANTITY_AMOUNT_MISMATCH');
    expect(result.checks.length).toBe(11);
    expect(result.previousYear.year).toBe(2025);
    expect(result.anomalyCount).toBe(result.anomalies.length);
    expect(result.countsByCode.RATE_DEVIATION).toBeGreaterThan(0);

    // 销售费用有预算无实际
    const withoutActual = result.anomalies.find((item) => item.code === 'BUDGET_WITHOUT_ACTUAL' && item.nodeCode === 'E02');
    expect(withoutActual).toBeTruthy();
    // 其他费用零预算有实际
    const zeroBudget = result.anomalies.find((item) => item.code === 'ZERO_BUDGET_WITH_ACTUAL' && item.nodeCode === 'E03');
    expect(zeroBudget?.cell?.actualCents).toBe(-700);
    // 同比:收入预算 300 vs 上年实际 150 → +100%
    const yoy = result.anomalies.find((item) => item.code === 'YOY_GROWTH_EXCEEDED' && item.nodeCode === 'I01');
    expect((yoy?.metrics as any)?.previousYear).toBe(2025);
    expect(Math.abs(Number((yoy?.metrics as any)?.growth))).toBeGreaterThan(0.3);
    // 数量科目独立:数量异常条目只带数量口径，金额为 0
    const quantityItems = result.anomalies.filter((item) => item.type === 'quantity');
    for (const item of quantityItems) {
      expect(item.cell?.budgetCents).toBe(0);
      expect(item.cell?.actualCents).toBe(0);
      expect(item.cell?.budgetQuantity).toBe(1_200_000);
    }
    // 阈值必须校验
    expect(() => anomalyReport(db, { versionId: version.id, threshold: 99 })).toThrow(/threshold/);
    db.close();
  });

  it('同类组织偏离在兄弟节点足够多时命中 PEER_DEVIATION', () => {
    const db = testDb(); const fx = buildFixture(db);
    const extra = [1, 2, 3].map((i) => ({ id: org.createOrg(db, { parentId: fx.orgIds.east, code: `EX${i}`, name: `扩展公司${i}` }).id }));
    const version = budget.createVersion(db, { year: 2026, name: '同类偏离' });
    budget.saveEntries(db, version.id, [
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '100.00' },
      { orgId: fx.orgIds.hangzhou, accountId: fx.accIds.incomeMain, amount: '100.00' },
      ...extra.map((o) => ({ orgId: o.id, accountId: fx.accIds.incomeMain, amount: '100.00' })),
    ]);
    actual.saveActual(db, {
      year: 2026, snapshotDate: '2026-06-30', source: 'manual', mode: 'replace',
      entries: [
        { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '100.00' },
        { orgId: fx.orgIds.hangzhou, accountId: fx.accIds.incomeMain, amount: '100.00' },
        { orgId: extra[0].id, accountId: fx.accIds.incomeMain, amount: '100.00' },
        { orgId: extra[1].id, accountId: fx.accIds.incomeMain, amount: '20.00' },
        { orgId: extra[2].id, accountId: fx.accIds.incomeMain, amount: '100.00' },
      ],
    });
    const result = anomalyReport(db, { versionId: version.id });
    const peer = result.anomalies.filter((item) => item.code === 'PEER_DEVIATION');
    expect(peer.length).toBeGreaterThan(0);
    expect(peer.some((item) => item.nodeCode === 'EX2')).toBe(true);
    expect((peer[0].metrics as any).peerCount).toBeGreaterThanOrEqual(3);
    db.close();
  });

  it('洞察由后端重新计算并保存引用，不接受前端传入的数字', () => {
    const db = testDb(); const fx = buildFixture(db); const version = standardBudgetVersion(fx);
    saveActualSnapshot(fx, 2026, '2026-06-30', [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '40.00' }]);
    const saved: any = assistant.saveInsight(db, { title: '本年执行洞察', kind: 'execution', params: { versionId: version.id, budgetCents: 999 } }, 'tester');
    expect(saved.result.kind).toBe('execution');
    expect(saved.result.summary.version.id).toBe(version.id);
    expect(saved.citations[0].budgetVersionId).toBe(version.id);
    expect(saved.citations[0].treeSnapshotIds.org).toBeGreaterThan(0);
    expect(JSON.stringify(saved.result.summary)).not.toContain('999');
    const fetched: any = assistant.insight(db, saved.id);
    expect(fetched.title).toBe('本年执行洞察');
    expect(assistant.insights(db).some((row: any) => row.id === saved.id)).toBe(true);

    const anomalyInsight: any = assistant.saveInsight(db, { kind: 'anomalies', params: { versionId: version.id } });
    expect(anomalyInsight.result.summary.checks.length).toBe(11);
    expect(anomalyInsight.result.summary.thresholds.rate).toBe(0.2);

    expect(() => assistant.saveInsight(db, { kind: 'unknown_kind', params: {} })).toThrow(/洞察类型/);
    expect(() => assistant.saveInsight(db, { kind: 'execution', params: {} })).toThrow(/versionId/);
    expect((db.prepare("SELECT COUNT(*) c FROM operation_log WHERE action='ai.insight'").get() as any).c).toBe(2);
    db.close();
  });

  it('HTTP 暴露 glossary / navigation / insights 接口', async () => {
    const dbPath = `/tmp/assistant-ext-${Date.now()}.sqlite`;
    const { app } = await createApp({ dbPath, auth: { username: '', password: '' } });
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const port = (server.address() as any).port;
    const base = `http://127.0.0.1:${port}/api/assistant`;

    const glossary: any = await (await fetch(`${base}/glossary?q=完成率`)).json();
    expect(glossary.matched[0].key).toBe('completion_rate');
    expect(glossary.catalog.length).toBe(GLOSSARY.length);

    const navigation: any = await (await fetch(`${base}/navigation`)).json();
    expect(navigation.pages.some((p: any) => p.page === 'analysis')).toBe(true);

    const bad = await fetch(`${base}/insights`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ kind: 'nope' }) });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { code: string }).code).toBe('VALIDATION_FAILED');

    const list: any = await (await fetch(`${base}/insights`)).json();
    expect(Array.isArray(list.items)).toBe(true);
    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});


/**
 * 异常检查的比较基准(方案 4.2)。
 *
 * 原实现把完成率跟 1(全年完成)比：时间进度 64% 时一个完全按节奏走的科目完成率就是 64%，
 * |0.64-1|=0.36 必然超过 0.2 阈值，于是「按计划执行」被判成异常。真实库上 409 条异常里
 * 212 条是这样来的，其中 168 条进度偏离不到 5 个百分点。实际侧同比同理：拿本年 8 个月
 * 累计去比上年整年，必然得出「同比下降 36%」。
 */
describe('AI 助手:异常检查的比较基准', () => {
  it('年度未关闭时按节奏执行的科目不报完成率异常，跑偏的才报', () => {
    const db = testDb(); const fx = buildFixture(db);
    const version = budget.createVersion(db, { year: 2026, name: '基准口径版本' });
    budget.saveEntries(db, version.id, [
      // 上海主营收入 1000:按节奏应完成约 495.89(181/365)
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '1000.00' },
      // 杭州主营收入 1000:实际只完成 100,严重滞后
      { orgId: fx.orgIds.hangzhou, accountId: fx.accIds.incomeMain, amount: '1000.00' },
    ]);
    actual.saveActual(db, {
      year: 2026, snapshotDate: '2026-06-30', source: 'manual', mode: 'replace',
      entries: [
        { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '495.89' },
        { orgId: fx.orgIds.hangzhou, accountId: fx.accIds.incomeMain, amount: '100.00' },
      ],
    });
    const result = anomalyReport(db, { versionId: version.id, threshold: 0.2 });
    expect(result.yearClosed).toBe(false);
    expect(result.rateBaseline).toBeCloseTo(181 / 365, 6);
    expect(result.rateBaselineBasis).toContain('时间进度');

    const rateItems = result.anomalies.filter((item) => item.code === 'RATE_DEVIATION');
    const flagged = new Set(rateItems.map((item) => item.nodeCode));
    // 上海按节奏(完成率 49.59% ≈ 基准 49.59%)→ 不报
    expect(flagged.has('SH')).toBe(false);
    // 杭州完成率 10% 偏离基准 39.59 个百分点 → 报
    expect(flagged.has('HZ')).toBe(true);
    const hangzhou = rateItems.find((item) => item.nodeCode === 'HZ');
    expect(hangzhou?.reasons[0]).toContain('偏离基准');
    expect((hangzhou?.metrics as any)?.baseline).toBeCloseTo(181 / 365, 6);
    expect((hangzhou?.metrics as any)?.yearClosed).toBe(false);
    db.close();
  });

  it('年度关闭后基准回到全年 100%，按节奏的中间口径反而应被判为未完成', () => {
    const db = testDb(); const fx = buildFixture(db);
    const version = budget.createVersion(db, { year: 2026, name: '关闭年度版本' });
    budget.saveEntries(db, version.id, [
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '1000.00' },
    ]);
    const batch = actual.saveActual(db, {
      year: 2026, snapshotDate: '2026-06-30', source: 'manual', mode: 'replace',
      entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '495.89' }],
    });
    // 未关闭:49.59% 就是按节奏,不报
    expect(anomalyReport(db, { versionId: version.id, threshold: 0.2 })
      .anomalies.some((item) => item.code === 'RATE_DEVIATION' && item.nodeCode === 'SH')).toBe(false);
    // 关闭年度后全年只完成 49.59%,基准变成 1,必须报
    freezeYear(db, 2026, batch.batchId);
    const closed = anomalyReport(db, { versionId: version.id, threshold: 0.2 });
    expect(closed.yearClosed).toBe(true);
    expect(closed.rateBaseline).toBe(1);
    expect(closed.rateBaselineBasis).toContain('年度已关闭');
    expect(closed.anomalies.some((item) => item.code === 'RATE_DEVIATION' && item.nodeCode === 'SH')).toBe(true);
    db.close();
  });

  it('实际侧同比比上年同期，预算侧仍比上年整年', () => {
    const db = testDb(); const fx = buildFixture(db);
    // 上年:6-30 同期累计 100,12-31 整年 200
    saveActualSnapshot(fx, 2025, '2025-06-30', [
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '100.00' },
    ]);
    saveActualSnapshot(fx, 2025, '2025-12-31', [
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '200.00' },
    ]);
    const version = budget.createVersion(db, { year: 2026, name: '同期口径版本' });
    budget.saveEntries(db, version.id, [
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '210.00' },
    ]);
    // 本年 6-30 累计 105:相对上年同期 100 只增长 5%,不该报同比异常
    actual.saveActual(db, {
      year: 2026, snapshotDate: '2026-06-30', source: 'manual', mode: 'replace',
      entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '105.00' }],
    });
    const result = anomalyReport(db, { versionId: version.id, threshold: 0.2, yoyThreshold: 0.3 });
    expect(result.previousSamePeriod?.asOfDate).toBe('2025-06-30');
    expect(result.previousYear.asOfDate).toBe('2025-12-31');
    const yoy = result.anomalies.filter((item) => item.code === 'YOY_GROWTH_EXCEEDED');
    // 实际 105 vs 上年同期 100 = +5%,不命中；旧实现拿 105 比上年整年 200 会算出 -47.5% 误报
    expect(yoy.some((item) => (item.metrics as any)?.comparison === 'same_period')).toBe(false);
    // 预算 210 vs 上年整年 200 = +5%,也不命中
    expect(yoy.some((item) => (item.metrics as any)?.comparison === 'full_year')).toBe(false);

    // 预算调到 400(相对上年整年 +100%)时预算侧应命中,且基准写明是整年
    budget.saveEntries(db, version.id, [
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '400.00' },
    ]);
    const grown = anomalyReport(db, { versionId: version.id, threshold: 0.2, yoyThreshold: 0.3 });
    const budgetYoy = grown.anomalies.find((item) => item.code === 'YOY_GROWTH_EXCEEDED' && (item.metrics as any)?.comparison === 'full_year');
    expect(budgetYoy?.basis).toContain('整年实际');
    expect((budgetYoy?.metrics as any)?.previousDisplay).toBe(20_000); // 200.00 元 = 20000 分
    db.close();
  });

  it('上年快照与本年截至日窗口差太多时跳过实际侧同比,并说明原因', () => {
    const db = testDb(); const fx = buildFixture(db);
    // 上年只有 06-30 快照,本年截至 08-22:两个累计窗口相差 53 天,
    // 234/181 = 1.29 会给每个科目凭空加 29% 增长 —— 这种口径错配必须跳过而不是硬比
    saveActualSnapshot(fx, 2025, '2025-06-30', [
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '100.00' },
    ]);
    const version = budget.createVersion(db, { year: 2026, name: '窗口错配版本' });
    budget.saveEntries(db, version.id, [
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '105.00' },
    ]);
    actual.saveActual(db, {
      year: 2026, snapshotDate: '2026-08-22', source: 'manual', mode: 'replace',
      entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '129.00' }],
    });
    const result = anomalyReport(db, { versionId: version.id, threshold: 0.2, yoyThreshold: 0.3 });
    expect(result.previousSamePeriod).toBeNull();
    expect(result.previousSamePeriodSkipReason).toContain('相差 53 天');
    expect(result.previousSamePeriodSkipReason).toContain('不可比');
    expect(result.anomalies.some((item) => item.code === 'YOY_GROWTH_EXCEEDED' && (item.metrics as any)?.comparison === 'same_period')).toBe(false);
    db.close();
  });

  it('找不到上年同期时点时如实跳过实际侧同比，而不是拿整年硬比', () => {
    const db = testDb(); const fx = buildFixture(db);
    // 上年只有 12-31 一个快照,本年截至 6-30 → 没有 MM-DD ≤ 06-30 的可比时点
    saveActualSnapshot(fx, 2025, '2025-12-31', [
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '200.00' },
    ]);
    const version = budget.createVersion(db, { year: 2026, name: '无同期版本' });
    budget.saveEntries(db, version.id, [
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '210.00' },
    ]);
    actual.saveActual(db, {
      year: 2026, snapshotDate: '2026-06-30', source: 'manual', mode: 'replace',
      entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '105.00' }],
    });
    const result = anomalyReport(db, { versionId: version.id, threshold: 0.2, yoyThreshold: 0.3 });
    expect(result.previousSamePeriod).toBeNull();
    expect(result.anomalies.some((item) => item.code === 'YOY_GROWTH_EXCEEDED' && (item.metrics as any)?.comparison === 'same_period')).toBe(false);
    db.close();
  });
});


/**
 * 非累计型数量科目(quantity_agg != 'sum',如电价、税率)是时点值不是累计值,
 * 任何时点的完成率都该接近 100%,拿它跟时间进度比必然误报。
 * report.yearTrend 里已有同一条规则(非累计型数量指标不能与自然日进度比较)。
 */
describe('AI 助手:非累计型数量科目的基准', () => {
  it('电价/税率类时点值按 100% 基准判断，不与时间进度比较', () => {
    const db = testDb(); const fx = buildFixture(db);
    const priceId = account.createAccount(db, { parentId: null, code: 'QP', name: '含税电价', type: 'quantity', unit: '元/度', quantityAgg: 'none' }).id;
    const volumeId = account.createAccount(db, { parentId: null, code: 'QV', name: '上网电量', type: 'quantity', unit: '万度', quantityAgg: 'sum' }).id;
    const version = budget.createVersion(db, { year: 2026, name: '时点值版本' });
    budget.saveEntries(db, version.id, [
      { orgId: fx.orgIds.shanghai, accountId: priceId, quantity: '0.4000' },
      { orgId: fx.orgIds.shanghai, accountId: volumeId, quantity: '1000.0000' },
    ]);
    actual.saveActual(db, {
      year: 2026, snapshotDate: '2026-06-30', source: 'manual', mode: 'replace',
      entries: [
        // 电价实际 0.4080:相对 0.4000 只高 2%,是正常时点值,不该报异常
        { orgId: fx.orgIds.shanghai, accountId: priceId, quantity: '0.4080' },
        // 电量实际 495.89:按节奏(49.59%),也不该报
        { orgId: fx.orgIds.shanghai, accountId: volumeId, quantity: '495.8900' },
      ],
    });
    const result = anomalyReport(db, { versionId: version.id, threshold: 0.2 });
    const flagged = result.anomalies.filter((item) => item.code === 'RATE_DEVIATION').map((item) => item.nodeCode);
    // 旧实现里电价完成率 102% 会被判成「偏离基准 64.11% 超过 20% 阈值」
    expect(flagged).not.toContain('QP');
    expect(flagged).not.toContain('QV');

    // 电价实际掉到 0.2400(相对 0.4000 只完成 60%)才是真异常
    actual.saveActual(db, {
      year: 2026, snapshotDate: '2026-06-30', source: 'manual', mode: 'replace',
      entries: [
        { orgId: fx.orgIds.shanghai, accountId: priceId, quantity: '0.2400' },
        { orgId: fx.orgIds.shanghai, accountId: volumeId, quantity: '495.8900' },
      ],
    });
    const dropped = anomalyReport(db, { versionId: version.id, threshold: 0.2 });
    const priceItem = dropped.anomalies.find((item) => item.code === 'RATE_DEVIATION' && item.nodeCode === 'QP');
    expect(priceItem).toBeTruthy();
    expect((priceItem?.metrics as any)?.baseline).toBe(1);
    expect(priceItem?.basis).toContain('非累计型数量科目');
    db.close();
  });
});
