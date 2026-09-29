import { afterEach, describe, expect, it } from 'vitest';
import { testDb, buildFixture, budget, actual, org, account } from './helpers';
import { cellNotes } from '../src/assistant/cell-notes';
import { executeTool, toolLabel } from '../src/assistant/tools';
import { detectIntents } from '../src/assistant/intent';
import { queryFacts } from '../src/assistant/facts';
import * as assistant from '../src/assistant/service';
import { resetAssistantRateLimit } from '../src/assistant/rate-limit';

/**
 * 单元格备注读取能力(get_cell_notes)。
 *
 * 覆盖三层：
 * 1. 查询函数本身——预算/实际两侧的叶子格+汇总格并集、子树过滤、快照口径名称、口径声明;
 * 2. 工具接线——schema/标签/参数白名单;
 * 3. 确定性兜底(无模型)——意图命中、queryFacts 双侧取数、模板回答原文陈列、定位导航。
 */

function fixtureWithNotes() {
  const db = testDb();
  const fx = buildFixture(db);
  const version = budget.createVersion(db, { year: 2026, name: 'V1' });
  budget.saveEntries(db, version.id, [
    { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '100.00', note: '按已签合同 500 万计提' },
    { orgId: fx.orgIds.shanghai, accountId: fx.accIds.costSub, amount: '60.00', note: '含新产线试产损耗' },
    { orgId: fx.orgIds.hangzhou, accountId: fx.accIds.incomeMain, amount: '50.00' },
  ], undefined, [
    { orgId: fx.orgIds.east, accountId: fx.accIds.incomeRoot, note: '含并购口径,详见并购协议' },
  ]);
  actual.saveActual(db, {
    year: 2026,
    snapshotDate: '2026-06-30',
    source: 'manual',
    mode: 'replace',
    entries: [
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '45.00', memo: '二季度合同延后确认' },
    ],
    cellNotes: [
      { orgId: fx.orgIds.east, accountId: fx.accIds.incomeRoot, memo: '华东汇总口径待财务复核' },
    ],
  });
  return { db, fx, version };
}

describe('cellNotes 查询函数', () => {
  it('预算侧:叶子格测算依据与汇总格批注并集返回,名称取版本树快照口径', () => {
    const { db, fx, version } = fixtureWithNotes();
    // 版本创建后改主数据名称,备注回答仍应按版本绑定快照的名称展示
    org.updateOrg(db, fx.orgIds.shanghai, { name: '上海当前新名称' });
    account.updateAccount(db, fx.accIds.incomeMain, { name: '收入当前新名称' });

    const result = cellNotes(db, { source: 'budget', versionId: version.id });
    expect(result.source).toBe('budget');
    expect(result.version).toMatchObject({ id: version.id, year: 2026, name: 'V1', status: 'draft' });
    expect(result.totalCount).toBe(3);
    expect(result.truncated).toBe(false);
    const leaf = result.notes.find((n) => n.cell === 'leaf' && n.orgId === fx.orgIds.shanghai && n.accountId === fx.accIds.incomeMain)!;
    expect(leaf).toMatchObject({
      kind: 'user_annotation',
      orgName: '上海公司',
      accountName: '主营业务收入',
      note: '按已签合同 500 万计提',
    });
    const summary = result.notes.find((n) => n.cell === 'summary')!;
    expect(summary).toMatchObject({
      kind: 'user_annotation',
      orgId: fx.orgIds.east,
      accountId: fx.accIds.incomeRoot,
      orgName: '华东大区',
      note: '含并购口径,详见并购协议',
    });
    expect(result.caveat).toContain('未经系统核实');
    expect(result.caveat).toContain('不参与数值汇总');
    db.close();
  });

  it('子树过滤:大区组织命中自身与下属单元格,科目同理;范围外不返回', () => {
    const { db, fx, version } = fixtureWithNotes();
    const east = cellNotes(db, { source: 'budget', versionId: version.id, orgId: fx.orgIds.east });
    expect(east.totalCount).toBe(3);
    expect(east.filters.orgName).toBe('华东大区');
    const nanjing = cellNotes(db, { source: 'budget', versionId: version.id, orgId: fx.orgIds.nanjing });
    expect(nanjing.totalCount).toBe(0);

    const income = cellNotes(db, { source: 'budget', versionId: version.id, accountId: fx.accIds.incomeRoot });
    expect(income.notes.map((n) => n.accountId).sort()).toEqual([fx.accIds.incomeRoot, fx.accIds.incomeMain].sort((a, b) => a - b));

    const cell = cellNotes(db, {
      source: 'budget', versionId: version.id,
      orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain,
    });
    expect(cell.totalCount).toBe(1);
    expect(cell.notes[0].note).toBe('按已签合同 500 万计提');
    db.close();
  });

  it('实际侧:当前累计批注与汇总格批注并集,口径声明随结果返回', () => {
    const { db, fx } = fixtureWithNotes();
    const result = cellNotes(db, { source: 'actual', year: 2026 });
    expect(result.source).toBe('actual');
    expect(result.year).toBe(2026);
    expect(result.totalCount).toBe(2);
    const leaf = result.notes.find((n) => n.cell === 'leaf')!;
    expect(leaf).toMatchObject({ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, note: '二季度合同延后确认' });
    const summary = result.notes.find((n) => n.cell === 'summary')!;
    expect(summary.note).toBe('华东汇总口径待财务复核');
    expect(result.caveat).toContain('不随快照批次冻结');

    const empty = cellNotes(db, { source: 'actual', year: 2027 });
    expect(empty.totalCount).toBe(0);
    expect(empty.notes).toEqual([]);
    db.close();
  });

  it('参数校验:缺 versionId/year、过滤节点不在口径树内均明确报错', () => {
    const { db, fx, version } = fixtureWithNotes();
    expect(() => cellNotes(db, { source: 'budget' })).toThrow(/versionId/);
    expect(() => cellNotes(db, { source: 'actual' })).toThrow(/year/);
    expect(() => cellNotes(db, { source: 'budget', versionId: 99999 })).toThrow(/预算版本/);
    const outsider = org.createOrg(db, { parentId: null, code: 'OUTSIDE', name: '版本外组织' });
    expect(() => cellNotes(db, { source: 'budget', versionId: version.id, orgId: outsider.id }))
      .toThrow(/不在该预算版本的树快照中/);
    expect(() => cellNotes(db, { source: 'actual', year: 2026, accountId: 99999 })).toThrow(/科目/);
    expect(fx.orgIds.root).toBeGreaterThan(0);
    db.close();
  });
});

describe('get_cell_notes 工具接线', () => {
  it('schema/标签/白名单:非法参数拒绝,合法参数透传', () => {
    const { db, version } = fixtureWithNotes();
    expect(toolLabel('get_cell_notes')).toBe('读取单元格备注');
    expect(() => executeTool(db, 'get_cell_notes', {})).toThrow(/source/);
    expect(() => executeTool(db, 'get_cell_notes', { source: 'x' })).toThrow(/source/);
    expect(() => executeTool(db, 'get_cell_notes', { source: 'budget' })).toThrow(/versionId/);
    expect(() => executeTool(db, 'get_cell_notes', { source: 'actual', year: 1800 })).toThrow(/year/);
    expect(() => executeTool(db, 'get_cell_notes', { source: 'budget', versionId: -1 })).toThrow(/versionId/);
    const result = executeTool(db, 'get_cell_notes', { source: 'budget', versionId: version.id }) as any;
    expect(result.totalCount).toBe(3);
    db.close();
  });
});

describe('确定性兜底路径(无模型)', () => {
  afterEach(() => {
    delete process.env.AI_BASE_URL;
    delete process.env.AI_API_KEY;
    resetAssistantRateLimit();
  });

  it('意图:备注问法命中 cell_note;导入语境的「备注」被抑制;「缺依据」归质量检查', () => {
    expect(detectIntents('上海公司的主营业务收入有备注吗').read).toContain('cell_note');
    expect(detectIntents('这个数的依据是什么').read).toContain('cell_note');
    expect(detectIntents('华东大区有哪些附注').read).toContain('cell_note');
    // 「导入模板的备注列」里的备注指导入文件列,不是单元格备注
    const importing = detectIntents('导入模板的备注列怎么填');
    expect(importing.read).toContain('import');
    expect(importing.read).not.toContain('cell_note');
    expect(importing.suppressed).toContain('cell_note');
    // 「缺依据」是定稿质量门禁视角,不触发备注陈列
    const quality = detectIntents('哪些科目缺依据,能不能定稿');
    expect(quality.read).toContain('budget_quality');
    expect(quality.read).not.toContain('cell_note');
  });

  it('queryFacts:版本与年度齐备时预算/实际双侧取数,来源元数据齐全', () => {
    const { db, version } = fixtureWithNotes();
    const facts = queryFacts(db, '有哪些备注', { budgetVersionId: version.id, year: 2026 }, { includeExtras: false });
    const budgetFact = facts.find((f) => f.type === 'cell_notes_budget')!;
    const actualFact = facts.find((f) => f.type === 'cell_notes_actual')!;
    expect((budgetFact.data as any).totalCount).toBe(3);
    expect(budgetFact.source.budgetVersionId).toBe(version.id);
    expect((actualFact.data as any).totalCount).toBe(2);
    expect(actualFact.source.year).toBe(2026);
    db.close();
  });

  it('queryFacts:只有年度时只查实际侧;两侧都缺时报 missing_context', () => {
    const { db } = fixtureWithNotes();
    const actualOnly = queryFacts(db, '有哪些备注', { year: 2026 }, { includeExtras: false });
    expect(actualOnly.some((f) => f.type === 'cell_notes_actual')).toBe(true);
    expect(actualOnly.some((f) => f.type === 'cell_notes_budget')).toBe(false);
    const none = queryFacts(db, '有哪些备注', {}, { includeExtras: false });
    expect(none.some((f) => f.type === 'missing_context')).toBe(true);
    db.close();
  });

  it('模板回答:陈列备注原文并标注口径,引用含版本,导航定位到单元格', async () => {
    delete process.env.AI_BASE_URL;
    delete process.env.AI_API_KEY;
    const { db, fx, version } = fixtureWithNotes();
    const answer = await assistant.chat(db, {
      message: '上海公司主营业务收入有备注吗',
      context: { year: 2026, budgetVersionId: version.id },
    });
    expect(answer.routing).toBe('rules');
    expect(answer.text).toContain('按已签合同 500 万计提');
    expect(answer.text).toContain('上海公司 × 主营业务收入');
    expect(answer.text).toContain('来自单元格备注');
    // 实际侧同年也有一张批注,同一条回答里如实陈列
    expect(answer.text).toContain('二季度合同延后确认');
    expect(answer.text).toContain('不随快照批次冻结');
    const citation = answer.citations.find((c) => c.source === 'cell_notes_budget');
    expect(citation?.budgetVersionId).toBe(version.id);
    expect(answer.navigation).toMatchObject({ page: 'budget_edit', label: '预算编制表格' });
    expect(answer.navigation?.path).toBe(`/budget/${version.id}?orgId=${fx.orgIds.shanghai}&accountId=${fx.accIds.incomeMain}`);
    expect(answer.numberCheck.status).toBe('skipped');
    db.close();
  });

  it('模板回答:范围内没有备注时如实说「没有」,不给「看不到」式结论', async () => {
    delete process.env.AI_BASE_URL;
    delete process.env.AI_API_KEY;
    const { db, fx, version } = fixtureWithNotes();
    const answer = await assistant.chat(db, {
      message: '南京公司有什么备注吗',
      context: { year: 2026, budgetVersionId: version.id },
    });
    expect(answer.text).toContain('没有查询到单元格备注');
    // 空结果不挂定位导航
    expect(answer.navigation).toBeNull();
    expect(fx.orgIds.nanjing).toBeGreaterThan(0);
    db.close();
  });
});
