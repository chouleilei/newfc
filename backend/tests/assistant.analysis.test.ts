import { describe, it, expect } from 'vitest';
import { attributionReport } from '../src/assistant/attribution';
import { reportDraft, centsToWanText, normalizeReportKind } from '../src/assistant/report-draft';
import { importHelpReport } from '../src/assistant/import-help';
import { queryFacts } from '../src/assistant/facts';
import * as assistant from '../src/assistant/service';
import * as imports from '../src/modules/import/import.service';
import { executeTool } from '../src/assistant/tools';
import { createApp } from '../src/server';
import { testDb, buildFixture, budget, account, actual } from './helpers';

/**
 * 方案《AI助手完整方案》4.3 差异归因(逐层展开)与报告生成、4.1 导入辅助。
 *
 * 夹具口径(元,后端存整数分;万元 = 元 / 10000):
 *   预算 上海 收入 12,000,000 / 成本 6,000,000 / 费用 2,000,000 → 净额 400 万元
 *        杭州 收入  6,000,000 / 成本 3,000,000 / 费用 1,000,000 → 净额 200 万元
 *   实际 上海 收入 10,800,000 / 成本 6,000,000 / 费用 2,500,000 → 净额 230 万元
 *        杭州 与预算一致                                        → 净额 200 万元
 *   合计差异 = 430 - 600 = -170 万元(不利);I01 -120 万元、E01 -50 万元
 */
function budgetRows(fx: ReturnType<typeof buildFixture>) {
  return [
    { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '12000000.00' },
    { orgId: fx.orgIds.shanghai, accountId: fx.accIds.costSub, amount: '6000000.00' },
    { orgId: fx.orgIds.shanghai, accountId: fx.accIds.expenseAdmin, amount: '2000000.00' },
    { orgId: fx.orgIds.hangzhou, accountId: fx.accIds.incomeMain, amount: '6000000.00' },
    { orgId: fx.orgIds.hangzhou, accountId: fx.accIds.costSub, amount: '3000000.00' },
    { orgId: fx.orgIds.hangzhou, accountId: fx.accIds.expenseSales, amount: '1000000.00' },
  ];
}

function fixtureWithActual(name = '归因版本') {
  const db = testDb();
  const fx = buildFixture(db);
  const version = budget.createVersion(db, { year: 2026, name });
  budget.saveEntries(db, version.id, budgetRows(fx));
  actual.saveActual(db, {
    year: 2026, snapshotDate: '2026-06-30', source: 'manual', mode: 'replace',
    entries: [
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '10800000.00' },
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.costSub, amount: '6000000.00' },
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.expenseAdmin, amount: '2500000.00' },
      { orgId: fx.orgIds.hangzhou, accountId: fx.accIds.incomeMain, amount: '6000000.00' },
      { orgId: fx.orgIds.hangzhou, accountId: fx.accIds.costSub, amount: '3000000.00' },
      { orgId: fx.orgIds.hangzhou, accountId: fx.accIds.expenseSales, amount: '1000000.00' },
    ],
  });
  return { db, fx, version };
}

describe('AI 助手:差异归因逐层展开', () => {
  it('总差异守恒:组织维度与科目维度根层合计相等,且每层子节点合计等于父节点', () => {
    const { db, version } = fixtureWithActual();
    const result = attributionReport(db, { versionId: version.id });
    // 预算净额 600 万元 = 600_000_000 分;实际净额 430 万元
    expect(result.totals.budgetCents).toBe(600_000_000);
    expect(result.totals.actualCents).toBe(430_000_000);
    expect(result.totals.varianceCents).toBe(-170_000_000);
    expect(result.totals.favorable).toBe('unfavorable');
    expect(result.reconciliation.orgRootVarianceCents).toBe(-170_000_000);
    expect(result.reconciliation.accountRootVarianceCents).toBe(-170_000_000);
    expect(result.reconciliation.orgLeafVarianceCents).toBe(-170_000_000);
    expect(result.reconciliation.accountLeafVarianceCents).toBe(-170_000_000);
    expect(result.reconciliation.matched).toBe(true);
    expect(result.reconciliation.unreconciledNodeCount).toBe(0);
    db.close();
  });

  it('逐层展开父子占比,并对 topN / maxDepth 截断如实反馈', () => {
    const { db, fx, version } = fixtureWithActual();
    const full = attributionReport(db, { versionId: version.id, maxDepth: 3, topN: 10 });
    expect(full.byOrg.length).toBe(1);
    const group = full.byOrg[0];
    expect(group.code).toBe('GROUP');
    expect(group.shareOfParent).toBeNull();
    expect(group.shareOfTotal).toBeCloseTo(-1, 10);
    // 华东承担全部差异,西部为 0
    const east = group.children.find((node) => node.code === 'EAST')!;
    const west = group.children.find((node) => node.code === 'WEST')!;
    expect(east.varianceCents).toBe(-170_000_000);
    expect(east.shareOfParent).toBeCloseTo(-1, 10);
    expect(west.varianceCents).toBe(0);
    // 第三层:上海全部、杭州为 0
    const shanghai = east.children.find((node) => node.id === fx.orgIds.shanghai)!;
    expect(shanghai.varianceCents).toBe(-170_000_000);
    expect(shanghai.isLeaf).toBe(true);
    expect(shanghai.children.length).toBe(0);

    // maxDepth=1 时不展开子层,但仍报出完整子层合计
    const shallow = attributionReport(db, { versionId: version.id, maxDepth: 1, topN: 10 });
    expect(shallow.byOrg[0].children.length).toBe(0);
    expect(shallow.byOrg[0].childrenVarianceCents).toBe(-170_000_000);
    expect(shallow.byOrg[0].reconciled).toBe(true);
    expect(shallow.byOrg[0].hiddenChildCount).toBe(2);
    expect(shallow.byOrg[0].hiddenVarianceCents).toBe(-170_000_000);

    // topN=1 时只展开影响最大的子节点,隐藏部分金额可核对
    const narrow = attributionReport(db, { versionId: version.id, maxDepth: 3, topN: 1 });
    expect(narrow.byOrg[0].children.length).toBe(1);
    expect(narrow.byOrg[0].children[0].code).toBe('EAST');
    expect(narrow.byOrg[0].hiddenChildCount).toBe(1);
    expect(narrow.byOrg[0].hiddenVarianceCents).toBe(0);
    db.close();
  });

  it('按方向排序与筛选叶子贡献,含完成率与路径', () => {
    const { db, version } = fixtureWithActual();
    const all = attributionReport(db, { versionId: version.id, topN: 10 });
    // 科目叶子:I01 -120 万元、E01 -50 万元、C0101 0、E02 0
    expect(all.rankedAccountLeaves[0].code).toBe('I01');
    expect(all.rankedAccountLeaves[0].varianceCents).toBe(-120_000_000);
    expect(all.rankedAccountLeaves[0].favorable).toBe('unfavorable');
    expect(all.rankedAccountLeaves[0].shareOfTotal).toBeCloseTo(-120 / 170, 10);
    expect(all.rankedAccountLeaves[1].code).toBe('E01');
    expect(all.rankedAccountLeaves[1].varianceCents).toBe(-50_000_000);
    expect(all.rankedOrgLeaves[0].path).toContain('集团');
    expect(all.rankedOrgLeaves[0].path).toContain('上海公司');

    const unfavorable = attributionReport(db, { versionId: version.id, direction: 'unfavorable', topN: 10 });
    expect(unfavorable.rankedAccountLeaves.every((row) => row.varianceCents < 0)).toBe(true);
    expect(unfavorable.rankedAccountLeaves.map((row) => row.code)).toEqual(['I01', 'E01']);

    const favorable = attributionReport(db, { versionId: version.id, direction: 'favorable', topN: 10 });
    expect(favorable.rankedAccountLeaves.length).toBe(0);
    expect(favorable.rankedOrgLeaves.length).toBe(0);

    expect(() => attributionReport(db, { versionId: version.id, direction: 'both' as any })).toThrow(/direction/);
    expect(() => attributionReport(db, { versionId: version.id, maxDepth: 0 })).toThrow(/maxDepth/);
    expect(() => attributionReport(db, { versionId: version.id, topN: 999 })).toThrow(/topN/);
    db.close();
  });

  it('数量科目不进入金额归因,单独输出且不影响守恒', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const quantityId = account.createAccount(db, { parentId: null, code: 'Q01', name: '发电量', type: 'quantity', unit: '万千瓦时' }).id;
    const version = budget.createVersion(db, { year: 2026, name: '数量归因' });
    budget.saveEntries(db, version.id, [
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '1000000.00' },
      { orgId: fx.orgIds.shanghai, accountId: quantityId, quantity: '120.0000' },
    ]);
    actual.saveActual(db, {
      year: 2026, snapshotDate: '2026-06-30', source: 'manual', mode: 'replace',
      entries: [
        { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '800000.00' },
        { orgId: fx.orgIds.shanghai, accountId: quantityId, quantity: '60.0000' },
      ],
    });
    const result = attributionReport(db, { versionId: version.id, topN: 10 });
    expect(result.totals.varianceCents).toBe(-20_000_000);
    expect(result.reconciliation.matched).toBe(true);
    // 金额归因树与排行榜中不出现数量科目
    const codes = new Set(result.rankedAccountLeaves.map((row) => row.code));
    expect(codes.has('Q01')).toBe(false);
    const flat: string[] = [];
    const walk = (nodes: any[]) => { for (const node of nodes) { flat.push(node.code); walk(node.children); } };
    walk(result.byAccount);
    expect(flat).not.toContain('Q01');
    // 数量差异单独输出,按 10^4 缩放整数
    expect(result.quantityVariances).toHaveLength(1);
    expect(result.quantityVariances[0]).toMatchObject({ code: 'Q01', unit: '万千瓦时', budgetQuantity: 1_200_000, actualQuantity: 600_000, varianceQuantity: -600_000 });
    db.close();
  });

  it('chat 在归因意图下返回确定性归因事实与引用', async () => {
    const { db, version } = fixtureWithActual();
    const facts = queryFacts(db, '本年利润为什么低于预算，按组织和科目归因', { year: 2026, budgetVersionId: version.id });
    const attribution = facts.find((f) => f.type === 'attribution');
    expect(attribution).toBeTruthy();
    expect((attribution!.data as any).totals.varianceCents).toBe(-170_000_000);
    expect(attribution!.source.budgetVersionId).toBe(version.id);

    const answer: any = await assistant.chat(db, { message: '本年差异归因是什么原因', context: { year: 2026, budgetVersionId: version.id } });
    expect(answer.facts.length).toBe(answer.citations.length);
    expect(answer.text).toContain('净差异 -170.00 万元(不利)');
    expect(answer.text).toContain('已核对一致');

    // 只给年度时自动回退到该年度的当前生效版本，并如实记录来源(问题2:上下文自动解析)
    const resolved: any = await assistant.chat(db, { message: '差异归因原因是什么', context: { year: 2026 } });
    expect(resolved.resolvedContext.budgetVersionId).toBe(version.id);
    expect(resolved.resolution.some((r: any) => r.field === 'budgetVersionId' && r.origin === 'default')).toBe(true);
    expect(resolved.facts.some((f: any) => f.type === 'attribution')).toBe(true);
    expect(resolved.facts.some((f: any) => f.type === 'missing_context')).toBe(false);

    // 确实没有任何版本可用时才返回缺失条件，而不是编造数字
    const empty = testDb();
    const none: any = await assistant.chat(empty, { message: '差异归因原因是什么', context: { year: 2026 } });
    expect(none.facts.some((f: any) => f.type === 'missing_context')).toBe(true);
    empty.close();
    db.close();
  });
});

describe('AI 助手:报告生成', () => {
  it('万元格式化为纯整数运算,四舍五入到百元', () => {
    expect(centsToWanText(0)).toBe('0.00');
    expect(centsToWanText(1_000_000)).toBe('1.00');
    expect(centsToWanText(-1_000_000)).toBe('-1.00');
    expect(centsToWanText(1_234_567)).toBe('1.23');
    expect(centsToWanText(-1_234_567)).toBe('-1.23');
    expect(centsToWanText(5_000)).toBe('0.01');
    expect(centsToWanText(4_999)).toBe('0.00');
    expect(centsToWanText(123_456_789)).toBe('123.46');
  });

  it('报告类型别名归一,非法类型拒绝', () => {
    expect(normalizeReportKind('monthly')).toBe('monthly_execution');
    expect(normalizeReportKind('月报')).toBe('monthly_execution');
    expect(normalizeReportKind('annual-review')).toBe('annual_review');
    expect(normalizeReportKind('讨论材料')).toBe('budget_discussion');
    expect(() => normalizeReportKind('weekly')).toThrow(/报告类型/);
  });

  it('执行月报:章节完整,数字与归因一致,并附结构化引用', () => {
    const { db, version } = fixtureWithActual();
    const draft = reportDraft(db, { kind: 'monthly_execution', versionId: version.id, topN: 3 });
    expect(draft.kind).toBe('monthly_execution');
    expect(draft.kindLabel).toBe('预算执行月报');
    expect(draft.narrativeSource).toBe('template');
    expect(draft.sections.map((section) => section.key)).toEqual(['overview', 'metrics', 'attribution', 'quantity', 'anomalies', 'trend']);
    expect(draft.scope.versionId).toBe(version.id);
    expect(draft.scope.treeSnapshotIds.org).toBeGreaterThan(0);
    expect(draft.period.year).toBe(2026);
    expect(draft.period.asOfDate).toBe('2026-06-30');
    // 归因节数字与 attributionReport 完全一致
    const attribution = attributionReport(db, { versionId: version.id, maxDepth: 2, topN: 3 });
    expect((draft.sections[2].data as any).totals).toEqual(attribution.totals);
    // 叙述中的金额按万元展示,且总差异可核对
    expect(draft.narrative).toContain('净差异 -170.00 万元(不利)');
    expect(draft.narrative).toContain('范围内预算合计 600.00 万元,实际合计 430.00 万元');
    expect(draft.narrative).toContain('# 2026 年归因版本 预算执行月报');
    expect(draft.narrative).toContain('## 建议(AI 生成,仅供参考)');
    // 每节引用都带年度与版本
    for (const section of draft.sections) {
      for (const citation of section.citations) {
        expect(citation.year).toBe(2026);
        expect(citation.budgetVersionId).toBe(version.id);
        expect(citation.asOf).toBeTruthy();
      }
    }
    expect(draft.citations.length).toBe(draft.facts.length);
    expect(draft.suggestions.length).toBeGreaterThan(0);
    db.close();
  });

  it('年度复盘:年度未关闭时如实降级,不编造准确率', () => {
    const { db, version } = fixtureWithActual();
    const draft = reportDraft(db, { kind: 'annual_review', year: 2026, versionId: version.id });
    expect(draft.kind).toBe('annual_review');
    expect(draft.sections.map((section) => section.key)).toEqual(['result', 'accuracy', 'history', 'trend', 'attribution']);
    expect(draft.sections[0].bullets[0]).toContain('尚未关闭');
    expect(draft.sections[1].bullets[0]).toContain('预算准确率暂不可用');
    expect((draft.sections[1].data as any).unavailable).toContain('2026');
    expect(draft.sections[2].bullets[0]).toContain('尚无已关闭年度');
    // 指定版本后仍给出确定性归因
    expect(draft.sections[4].bullets[0]).toContain('净差异 -170.00 万元');
    // 不给版本时不编造归因
    const withoutVersion = reportDraft(db, { kind: 'annual_review', year: 2026 });
    expect(withoutVersion.sections[4].bullets[0]).toContain('未指定预算版本');
    expect(withoutVersion.sections[4].data).toBeNull();
    expect(() => reportDraft(db, { kind: 'annual_review' })).toThrow(/year/);
    db.close();
  });

  it('预算讨论材料:版本概况、结构、质量与版本对比', () => {
    const { db, fx, version } = fixtureWithActual();
    const other = budget.createVersion(db, { year: 2026, name: '对比版本' });
    budget.saveEntries(db, other.id, [
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '14000000.00' },
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.costSub, amount: '6000000.00' },
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.expenseAdmin, amount: '2000000.00' },
      { orgId: fx.orgIds.hangzhou, accountId: fx.accIds.incomeMain, amount: '6000000.00' },
      { orgId: fx.orgIds.hangzhou, accountId: fx.accIds.costSub, amount: '3000000.00' },
      { orgId: fx.orgIds.hangzhou, accountId: fx.accIds.expenseSales, amount: '1000000.00' },
    ]);
    const draft = reportDraft(db, { kind: 'budget_discussion', versionId: version.id, targetVersionId: other.id, topN: 5 });
    expect(draft.sections.map((section) => section.key)).toEqual(['overview', 'structure', 'quality', 'compare', 'agenda']);
    expect(draft.sections[0].bullets[0]).toContain('归因版本');
    expect(draft.sections[0].bullets[1]).toContain('绑定树快照');
    // 结构:收入 1800 万元、成本 -900 万元、费用 -300 万元 => 利润 600 万元
    const structure = draft.sections[1].data as any;
    expect(structure.typeTotals).toEqual({ income: 1_800_000_000, cost: -900_000_000, expense: -300_000_000 });
    expect(structure.profitBudget).toBe(600_000_000);
    expect(draft.narrative).toContain('利润(收入+成本+费用,带符号)600.00 万元');
    // 代表性叶子组织按预算体量排名,文案同时给出体量与净额:上海体量 2000 万元、净额 400 万元
    expect(structure.orgLeaves[0].code).toBe('SH');
    expect(structure.orgLeaves[0].budgetVolumeCents).toBe(2_000_000_000);
    expect(draft.sections[1].bullets.some((b: string) => b.includes('上海公司') && b.includes('预算体量 2000.00 万元') && b.includes('预算净额 400.00 万元'))).toBe(true);
    // 版本对比:上海收入 1200 → 1400 万元
    const compare = draft.sections[3].data as any;
    expect(compare.treeSame).toBe(true);
    expect(compare.leafChanges.some((change: any) => change.orgCode === 'SH' && change.accountCode === 'I01' && change.deltaCents === 200_000_000)).toBe(true);
    expect(draft.scope.targetVersionId).toBe(other.id);
    expect(draft.citations.some((citation) => citation.targetVersionId === other.id)).toBe(true);
    // 不给对比版本时不编造对比
    const alone = reportDraft(db, { kind: 'budget_discussion', versionId: version.id });
    expect(alone.sections[3].bullets[0]).toContain('未指定 targetVersionId');
    db.close();
  });

  it('预算讨论材料:代表性组织按体量而非净额排名', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const version = budget.createVersion(db, { year: 2026, name: '体量排名' });
    budget.saveEntries(db, version.id, [
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '10000000.00' },
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.costSub, amount: '9900000.00' },
      { orgId: fx.orgIds.hangzhou, accountId: fx.accIds.expenseAdmin, amount: '1000000.00' },
    ]);
    const draft = reportDraft(db, { kind: 'budget_discussion', versionId: version.id, topN: 5 });
    const structure = draft.sections[1].data as any;
    // 上海:体量 1990 万元、净额仅 10 万元;杭州:体量 100 万元、净额 -100 万元。
    // 按 |净额| 排名杭州在前,按体量排名上海在前——大业务组织不应被净额抵消埋没。
    // 南京无预算,体量为零排最后。
    expect(structure.orgLeaves.map((row: any) => row.code)).toEqual(['SH', 'HZ', 'NJ']);
    db.close();
  });

  it('模型不可用时报告仍可用,并保持模板叙述', async () => {
    const { db, version } = fixtureWithActual();
    const result = await assistant.reportDraft(db, { kind: 'monthly_execution', versionId: version.id });
    expect(result.model).toBe('template');
    expect(result.narrativeSource).toBe('template');
    expect(result.narrative).toContain('净差异 -170.00 万元');
    // 通过工具入口也能获得同样的确定性结果
    const viaTool: any = executeTool(db, 'generate_report', { kind: 'monthly_execution', versionId: version.id });
    expect(viaTool.sections.length).toBe(6);
    db.close();
  });

  it('报告可保存为洞察,数字由后端重新计算', () => {
    const { db, version } = fixtureWithActual();
    const saved = assistant.saveInsight(db, { kind: 'report', params: { reportKind: 'monthly_execution', versionId: version.id }, title: '6 月执行月报' });
    expect(saved.title).toBe('6 月执行月报');
    expect(saved.result.kind).toBe('report');
    expect(saved.result.summary.kind).toBe('monthly_execution');
    expect(saved.result.summary.narrative).toContain('净差异 -170.00 万元');
    expect(saved.citations.length).toBeGreaterThan(0);
    expect(saved.citations[0].budgetVersionId).toBe(version.id);

    const attribution = assistant.saveInsight(db, { kind: 'attribution', params: { versionId: version.id, maxDepth: 2, topN: 5 } });
    expect(attribution.result.summary.totals.varianceCents).toBe(-170_000_000);
    expect(attribution.result.summary.reconciliation.matched).toBe(true);
    db.close();
  });

  it('chat 在报告意图下直接返回可用的模板报告', async () => {
    const { db, version } = fixtureWithActual();
    const answer: any = await assistant.chat(db, { message: '生成本年度执行月报', context: { year: 2026, budgetVersionId: version.id } });
    expect(answer.facts.some((f: any) => f.type === 'report_draft')).toBe(true);
    expect(answer.text).toContain('预算执行月报');
    expect(answer.facts.length).toBe(answer.citations.length);

    const discussion: any = await assistant.chat(db, { message: '准备预算讨论材料', context: { year: 2026, budgetVersionId: version.id } });
    const draft = discussion.facts.find((f: any) => f.type === 'report_draft');
    expect(draft.data.kind).toBe('budget_discussion');
    db.close();
  });
});

describe('AI 助手:导入辅助', () => {
  const errors = [
    { row: 3, field: 'orgCode', message: '组织编码不存在: SH1' },
    { row: 4, field: 'orgCode', message: '组织编码不存在: SH1' },
    { row: 5, field: 'accountCode', message: '科目编码不存在: I011' },
    { row: 6, field: 'accountCode', message: '与第 5 行重复(同组织科目组合)' },
    { row: 7, field: 'amount', message: '金额格式不正确: 1,200.00(最多两位小数)' },
    { row: 8, field: 'quantity', message: '数量格式不正确: 1.123456(最多四位小数)' },
    { row: 9, field: 'orgCode', message: '组织 EAST 不是叶子组织' },
    { row: 10, field: '截止日期', message: '截止日期格式必须为 YYYY-MM-DD: 2026/06/30' },
    { row: 0, field: 'file', message: '文件中没有数据行' },
  ];

  it('错误按类分组并给出固化解释与处理建议', () => {
    const db = testDb();
    buildFixture(db);
    const help = importHelpReport(db, { errors });
    expect(help.errorCount).toBe(errors.length);
    const categories = help.groups.map((group) => group.category);
    expect(categories).toContain('ORG_CODE_UNKNOWN');
    expect(categories).toContain('ACCOUNT_CODE_UNKNOWN');
    expect(categories).toContain('DUPLICATE_ROW');
    expect(categories).toContain('AMOUNT_FORMAT');
    expect(categories).toContain('QUANTITY_FORMAT');
    expect(categories).toContain('ORG_NOT_LEAF');
    expect(categories).toContain('DATE_FORMAT');
    expect(categories).toContain('FILE_LEVEL');
    // 每组都必须有解释与处理建议,且行号可定位
    for (const group of help.groups) {
      expect(group.explanation.length).toBeGreaterThan(5);
      expect(group.fix.length).toBeGreaterThan(5);
      expect(group.count).toBeGreaterThan(0);
      expect(group.samples.length).toBeGreaterThan(0);
    }
    const orgUnknown = help.groups.find((group) => group.category === 'ORG_CODE_UNKNOWN')!;
    expect(orgUnknown.count).toBe(2);
    expect(orgUnknown.rows).toEqual([3, 4]);
    const notLeaf = help.groups.find((group) => group.category === 'ORG_NOT_LEAF')!;
    expect(notLeaf.explanation).toContain('叶子组织');
    db.close();
  });

  it('未匹配编码给出组织/科目候选建议,不编造编码', () => {
    const db = testDb();
    buildFixture(db);
    const help = importHelpReport(db, { errors, suggestionLimit: 3 });
    expect(help.unmatched.org).toHaveLength(1);
    expect(help.unmatched.org[0]).toMatchObject({ kind: 'org', code: 'SH1', rows: [3, 4] });
    const orgCandidate = help.unmatched.org[0].candidates[0];
    expect(orgCandidate.code).toBe('SH');
    expect(orgCandidate.isLeaf).toBe(true);
    expect(orgCandidate.score).toBeGreaterThan(0.5);
    expect(orgCandidate.reason).toContain('编码前缀一致');

    expect(help.unmatched.account).toHaveLength(1);
    expect(help.unmatched.account[0].code).toBe('I011');
    const accountCandidate = help.unmatched.account[0].candidates[0];
    expect(accountCandidate.code).toBe('I01');
    expect(accountCandidate.name).toBe('主营业务收入');
    expect(accountCandidate.type).toBe('income');
    expect(accountCandidate.isLeaf).toBe(true);
    // 候选只能来自真实树,数量不超过 suggestionLimit
    const allCodes = new Set([...help.unmatched.org, ...help.unmatched.account].flatMap((item) => item.candidates.map((c) => c.code)));
    for (const code of allCodes) {
      const exists = db.prepare('SELECT 1 FROM org WHERE code=? UNION ALL SELECT 1 FROM account WHERE code=?').get(code, code);
      expect(exists).toBeTruthy();
    }
    expect(help.unmatched.account[0].candidates.length).toBeLessThanOrEqual(3);
    db.close();
  });

  it('列出重复项并解析首次出现行,给出处理顺序', () => {
    const db = testDb();
    buildFixture(db);
    const help = importHelpReport(db, { errors });
    expect(help.duplicates).toHaveLength(1);
    expect(help.duplicates[0]).toMatchObject({ row: 6, firstRow: 5 });
    expect(help.nextSteps.some((step) => step.includes('未匹配'))).toBe(true);
    expect(help.nextSteps.some((step) => step.includes('重复行'))).toBe(true);
    expect(help.nextSteps.some((step) => step.includes('万元两位小数'))).toBe(true);
    expect(help.notes.some((note) => note.includes('人工确认'))).toBe(true);
    db.close();
  });

  it('参数校验:必须提供 batchId 或 errors,并支持已持久化批次', () => {
    const db = testDb();
    const fx = buildFixture(db);
    expect(() => importHelpReport(db, {})).toThrow(/batchId|errors/);
    expect(() => assistant.importHelp(db, { errors: 'x' })).toThrow(/errors/);
    expect(() => assistant.importHelp(db, { batchId: 0 })).toThrow(/batchId/);

    const version = budget.createVersion(db, { year: 2026, name: '导入批次' });
    budget.saveEntries(db, version.id, budgetRows(fx));
    const batch = imports.createBatch(db, {
      kind: 'budget',
      targetVersionId: version.id,
      originalName: 'budget.xlsx',
      file: Buffer.from('demo'),
      payload: { versionId: version.id, entries: [] } as any,
      summary: { rowCount: 0, errors: [{ row: 2, field: 'accountCode', message: '科目编码不存在: C0102' }] },
    });
    const help = assistant.importHelp(db, { batchId: batch.id });
    expect(help.batch?.id).toBe(batch.id);
    expect(help.batch?.status).toBe('pending');
    expect(help.errorCount).toBe(1);
    expect(help.unmatched.account[0].code).toBe('C0102');
    expect(help.unmatched.account[0].candidates.some((candidate: any) => candidate.code === 'C0101')).toBe(true);
    db.close();
  });

  it('chat 在导入上下文下返回确定性诊断', async () => {
    const db = testDb();
    const fx = buildFixture(db);
    const version = budget.createVersion(db, { year: 2026, name: '导入诊断' });
    budget.saveEntries(db, version.id, budgetRows(fx));
    const batch = imports.createBatch(db, {
      kind: 'budget',
      targetVersionId: version.id,
      originalName: 'budget.xlsx',
      file: Buffer.from('demo'),
      payload: { versionId: version.id, entries: [] } as any,
      summary: { rowCount: 0, errors: [{ row: 2, field: 'orgCode', message: '组织编码不存在: SH0' }] },
    });
    const answer: any = await assistant.chat(db, { message: '导入报错了,帮我解释错误并列出未匹配项', context: { year: 2026, importBatchId: batch.id } });
    expect(answer.facts.some((f: any) => f.type === 'import_help')).toBe(true);
    expect(answer.text).toContain('导入诊断');
    expect(answer.text).toContain('未匹配组织编码 1 个');
    expect(answer.facts.length).toBe(answer.citations.length);
    db.close();
  });
});

describe('AI 助手:新增只读接口的 HTTP 契约', () => {
  it('attribution / report / import-help 三个接口返回确定性结果', async () => {
    const dbPath = `/tmp/assistant-analysis-${Date.now()}.sqlite`;
    const { app, holder } = await createApp({ dbPath, auth: { username: '', password: '' } });
    const db = holder.getDb() as any;
    const fx = buildFixture(db);
    const version = budget.createVersion(db, { year: 2026, name: 'HTTP 版本' });
    budget.saveEntries(db, version.id, budgetRows(fx));
    actual.saveActual(db, {
      year: 2026, snapshotDate: '2026-06-30', source: 'manual', mode: 'replace',
      entries: [
        { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '10800000.00' },
        { orgId: fx.orgIds.shanghai, accountId: fx.accIds.costSub, amount: '6000000.00' },
        { orgId: fx.orgIds.shanghai, accountId: fx.accIds.expenseAdmin, amount: '2500000.00' },
      ],
    });
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const port = (server.address() as any).port;
    const post = async (path: string, body: unknown) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
      });
      return { status: response.status, body: await response.json() as any };
    };

    const attribution = await post('/api/assistant/attribution', { versionId: version.id, maxDepth: 2, topN: 5, direction: 'unfavorable' });
    expect(attribution.status).toBe(200);
    expect(attribution.body.reconciliation.matched).toBe(true);
    expect(attribution.body.params).toMatchObject({ maxDepth: 2, topN: 5, direction: 'unfavorable' });

    const report = await post('/api/assistant/report', { kind: 'monthly_execution', versionId: version.id });
    expect(report.status).toBe(200);
    expect(report.body.sections.length).toBe(6);
    expect(report.body.narrativeSource).toBe('template');

    const help = await post('/api/assistant/import-help', { errors: [{ row: 2, field: 'orgCode', message: '组织编码不存在: SH9' }] });
    expect(help.status).toBe(200);
    expect(help.body.unmatched.org[0].candidates[0].code).toBe('SH');

    const invalid = await post('/api/assistant/report', { kind: 'weekly' });
    expect(invalid.status).toBe(400);
    expect(invalid.body.code).toBe('VALIDATION_FAILED');

    const missing = await post('/api/assistant/import-help', {});
    expect(missing.status).toBe(400);

    await new Promise<void>((resolve) => server.close(() => resolve()));
  });
});
