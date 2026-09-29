import { describe, it, expect } from 'vitest';
import { testDb, buildFixture, budget, actual, account, org } from './helpers';
import { freezeYear } from '../src/modules/report/report.service';

/**
 * 汇总格备注:非叶子组织列/非叶子科目行的批注(budget_cell_note / actual_cell_note)。
 * 与叶子明细的 note/memo 互补:不带金额、不参与汇总与快照;整包替换、同 revision/批次并发保护。
 */
describe('预算汇总格备注(budget_cell_note)', () => {
  it('保存并回读汇总格备注;矩阵响应携带 cellNotes', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const v = budget.createVersion(db, { year: 2026, name: 'V1' });
    const r = budget.saveEntries(db, v.id, [
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '100.00' },
    ], undefined, [
      { orgId: fx.orgIds.east, accountId: fx.accIds.incomeMain, note: ' 华东收入口径:含托管项目 ' },
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.expenseRoot, note: '费用大类整体说明' },
      { orgId: fx.orgIds.root, accountId: fx.accIds.expenseRoot, note: '集团费用备注' },
    ]);
    expect(r.cellNotesSaved).toBe(3);
    const m = budget.getEditMatrix(db, v.id);
    const notes = new Map(m.cellNotes.map((n) => [`${n.orgId}:${n.accountId}`, n.note]));
    // 写入时 trim 落库
    expect(notes.get(`${fx.orgIds.east}:${fx.accIds.incomeMain}`)).toBe('华东收入口径:含托管项目');
    expect(notes.get(`${fx.orgIds.shanghai}:${fx.accIds.expenseRoot}`)).toBe('费用大类整体说明');
    expect(notes.get(`${fx.orgIds.root}:${fx.accIds.expenseRoot}`)).toBe('集团费用备注');
  });

  it('叶子×叶子组合被拒绝(附注归明细行),非快照节点被拒绝,重复与超长被拒绝', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const v = budget.createVersion(db, { year: 2026, name: 'V1' });
    // 叶子×叶子
    expect(() => budget.saveEntries(db, v.id, [], undefined, [
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, note: 'x' },
    ])).toThrow(/叶子组织 × 叶子科目/);
    // 快照外节点
    expect(() => budget.saveEntries(db, v.id, [], undefined, [
      { orgId: 99999, accountId: fx.accIds.incomeMain, note: 'x' },
    ])).toThrow(/不在版本绑定的组织树快照中/);
    // 重复键
    expect(() => budget.saveEntries(db, v.id, [], undefined, [
      { orgId: fx.orgIds.east, accountId: fx.accIds.incomeMain, note: 'a' },
      { orgId: fx.orgIds.east, accountId: fx.accIds.incomeMain, note: 'b' },
    ])).toThrow(/重复/);
    // 超长
    expect(() => budget.saveEntries(db, v.id, [], undefined, [
      { orgId: fx.orgIds.east, accountId: fx.accIds.incomeMain, note: 'x'.repeat(2001) },
    ])).toThrow(/2000/);
  });

  it('整包替换:未提交的汇总备注被删除,空备注剔除;不传 cellNotes 时既有备注保留(导入/助手路径)', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const v = budget.createVersion(db, { year: 2026, name: 'V1' });
    budget.saveEntries(db, v.id, [], undefined, [
      { orgId: fx.orgIds.east, accountId: fx.accIds.incomeMain, note: '保留我' },
      { orgId: fx.orgIds.west, accountId: fx.accIds.incomeMain, note: '删掉我' },
    ]);
    // 不传 cellNotes:导入/助手等只写明细的链路不动汇总备注
    const keep = budget.saveEntries(db, v.id, [
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '1.00' },
    ]);
    expect(keep.cellNotesSaved).toBe(0);
    expect(budget.getEditMatrix(db, v.id).cellNotes).toHaveLength(2);
    // 整包替换:只提交一条 + 一条空备注(剔除)
    const r = budget.saveEntries(db, v.id, [
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '1.00' },
    ], undefined, [
      { orgId: fx.orgIds.east, accountId: fx.accIds.incomeMain, note: '改写' },
      { orgId: fx.orgIds.west, accountId: fx.accIds.incomeMain, note: '   ' },
    ]);
    expect(r.cellNotesSaved).toBe(1);
    expect(r.cellNotesDeleted).toBe(1);
    const notes = budget.getEditMatrix(db, v.id).cellNotes;
    expect(notes).toHaveLength(1);
    expect(notes[0]).toMatchObject({ orgId: fx.orgIds.east, accountId: fx.accIds.incomeMain, note: '改写' });
  });

  it('汇总备注随明细保存推进 revision,并发基线冲突被拒', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const v = budget.createVersion(db, { year: 2026, name: 'V1' });
    const base = budget.getVersion(db, v.id).revision;
    const r = budget.saveEntries(db, v.id, [], base, [
      { orgId: fx.orgIds.east, accountId: fx.accIds.incomeMain, note: 'n' },
    ]);
    expect(r.revision).toBe(base + 1);
    expect(() => budget.saveEntries(db, v.id, [], base, [
      { orgId: fx.orgIds.east, accountId: fx.accIds.incomeMain, note: 'late' },
    ])).toThrow(/修订/);
  });

  it('锁定版本拒绝写汇总备注;清空草稿同时清汇总备注;删除版本级联清理', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const v = budget.createVersion(db, { year: 2026, name: 'V1' });
    budget.saveEntries(db, v.id, [], undefined, [
      { orgId: fx.orgIds.east, accountId: fx.accIds.incomeMain, note: 'n' },
    ]);
    // 清空
    budget.clearEntries(db, v.id);
    expect(budget.getEditMatrix(db, v.id).cellNotes).toHaveLength(0);
    // 锁定后拒写
    budget.saveEntries(db, v.id, [
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '1.00' },
    ], undefined, [{ orgId: fx.orgIds.east, accountId: fx.accIds.incomeMain, note: 'n' }]);
    budget.lockVersion(db, v.id);
    expect(() => budget.saveEntries(db, v.id, [], undefined, [
      { orgId: fx.orgIds.east, accountId: fx.accIds.incomeMain, note: 'x' },
    ])).toThrow(/草稿/);
    // 删除草稿级联清理
    const v2 = budget.copyVersion(db, v.id, 'V2-修订');
    expect(budget.getEditMatrix(db, v2.id).cellNotes).toHaveLength(1);
    budget.deleteVersion(db, v2.id);
    const left = db.prepare('SELECT COUNT(*) AS c FROM budget_cell_note WHERE version_id = ?').get(v2.id) as { c: number };
    expect(left.c).toBe(0);
  });

  it('同年复制携带汇总备注;跨年复制按目标快照过滤(目标树退化为叶子×叶子的组合不携带)', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const v = budget.createVersion(db, { year: 2026, name: 'V1' });
    budget.saveEntries(db, v.id, [], undefined, [
      { orgId: fx.orgIds.east, accountId: fx.accIds.expenseSales, note: '备注:华东×销售费用' },
    ]);
    budget.lockVersion(db, v.id);
    // 同年复制:树快照一致,全部沿用
    const sameYear = budget.copyVersion(db, v.id, 'V1-修订');
    expect(budget.getEditMatrix(db, sameYear.id).cellNotes).toHaveLength(1);
    // 让 EAST 在当前树中退化为叶子(上海/杭州无任何业务引用,可物理删除)
    org.deleteOrg(db, fx.orgIds.shanghai);
    org.deleteOrg(db, fx.orgIds.hangzhou);
    const cross = budget.copyVersion(db, v.id, 'V2027', undefined, 2027);
    // east 变叶子后 east×expenseSales(叶子) 组合退化为叶子×叶子,备注归明细行,不再携带
    expect(budget.getEditMatrix(db, cross.id).cellNotes).toHaveLength(0);
  });

  it('被汇总格备注引用的叶子科目/组织不能物理删除(可停用)', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const v = budget.createVersion(db, { year: 2026, name: 'V1' });
    budget.saveEntries(db, v.id, [], undefined, [
      { orgId: fx.orgIds.east, accountId: fx.accIds.expenseOther, note: '其他费用在华东的口径' },
    ]);
    expect(() => account.deleteAccount(db, fx.accIds.expenseOther)).toThrow(/不能物理删除/);
  });

  it('编制记录 diff 覆盖汇总备注(新增/修改均计数,定稿前记录不遗漏)', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const v = budget.createVersion(db, { year: 2026, name: 'V1' });
    // 首次记录:新增一条汇总备注
    budget.saveEntries(db, v.id, [], undefined, [
      { orgId: fx.orgIds.east, accountId: fx.accIds.incomeMain, note: '第一版口径' },
    ]);
    let status = budget.listCompilationCheckpoints(db, v.id);
    expect(status.unrecordedChangeCount).toBe(1);
    const r1 = budget.recordCompilationCheckpoint(db, v.id, { title: '首轮' });
    expect(r1.created).toBe(true);
    expect(r1.checkpoint!.changes).toHaveLength(1);
    expect(r1.checkpoint!.changes[0]).toMatchObject({
      orgId: fx.orgIds.east,
      accountId: fx.accIds.incomeMain,
      kind: 'note',
      before: { note: '' },
      after: { note: '第一版口径' },
    });
    // 修改汇总备注再次被识别
    budget.saveEntries(db, v.id, [], undefined, [
      { orgId: fx.orgIds.east, accountId: fx.accIds.incomeMain, note: '第二版口径' },
    ]);
    status = budget.listCompilationCheckpoints(db, v.id);
    expect(status.unrecordedChangeCount).toBe(1);
    // 单元格历史同样覆盖汇总格
    const history = budget.getBudgetCellHistory(db, v.id, fx.orgIds.east, fx.accIds.incomeMain);
    expect(history.changes).toHaveLength(1);
  });
});

describe('实际数汇总格备注(actual_cell_note)', () => {
  it('随整包保存写入并回读;不进快照批次', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const r = actual.saveActual(db, {
      year: 2026,
      snapshotDate: '2026-03-31',
      entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '100.00' }],
      source: 'manual',
      mode: 'replace',
      cellNotes: [
        { orgId: fx.orgIds.east, accountId: fx.accIds.incomeMain, memo: '华东实际口径' },
        { orgId: fx.orgIds.root, accountId: fx.accIds.expenseRoot, memo: '集团费用备注' },
      ],
    });
    expect(r.cellNotesSaved).toBe(2);
    const m = actual.getActualMatrix(db, 2026);
    const notes = new Map(m.cellNotes.map((n) => [`${n.orgId}:${n.accountId}`, n.memo]));
    expect(notes.get(`${fx.orgIds.east}:${fx.accIds.incomeMain}`)).toBe('华东实际口径');
    // 快照条目只含叶子明细,汇总备注不在快照里
    const batchEntries = actual.getBatchEntries(db, r.batchId);
    expect(batchEntries.every((e) => e.accountId !== fx.accIds.expenseRoot)).toBe(true);
  });

  it('校验:叶子×叶子拒绝/未知节点拒绝/历史补录拒收', () => {
    const db = testDb();
    const fx = buildFixture(db);
    expect(() => actual.saveActual(db, {
      year: 2026, snapshotDate: '2026-03-31', entries: [], source: 'manual', mode: 'replace', allowEmptyReplace: true,
      cellNotes: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, memo: 'x' }],
    })).toThrow(/叶子组织 × 叶子科目/);
    expect(() => actual.saveActual(db, {
      year: 2026, snapshotDate: '2026-03-31', entries: [], source: 'manual', mode: 'replace', allowEmptyReplace: true,
      cellNotes: [{ orgId: 99999, accountId: fx.accIds.incomeMain, memo: 'x' }],
    })).toThrow(/不在当前组织树/);
    expect(() => actual.saveActual(db, {
      year: 2026, snapshotDate: '2026-03-31', entries: [], source: 'manual', mode: 'replace', history: true,
      cellNotes: [{ orgId: fx.orgIds.east, accountId: fx.accIds.incomeMain, memo: 'x' }],
    })).toThrow(/历史补录不支持汇总格备注/);
  });

  it('整包替换:未提交的删除;不传 cellNotes 保留(导入/财务转换路径)', () => {
    const db = testDb();
    const fx = buildFixture(db);
    actual.saveActual(db, {
      year: 2026, snapshotDate: '2026-03-31', entries: [], source: 'manual', mode: 'replace', allowEmptyReplace: true,
      cellNotes: [
        { orgId: fx.orgIds.east, accountId: fx.accIds.incomeMain, memo: '保留' },
        { orgId: fx.orgIds.west, accountId: fx.accIds.incomeMain, memo: '删' },
      ],
    });
    // 不传:保留
    actual.saveActual(db, {
      year: 2026, snapshotDate: '2026-04-30', entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '1.00' }],
      source: 'manual', mode: 'replace',
    });
    expect(actual.getActualMatrix(db, 2026).cellNotes).toHaveLength(2);
    // 整包替换
    actual.saveActual(db, {
      year: 2026, snapshotDate: '2026-05-31', entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '1.00' }],
      source: 'manual', mode: 'replace',
      cellNotes: [{ orgId: fx.orgIds.east, accountId: fx.accIds.incomeMain, memo: '保留' }],
    });
    const notes = actual.getActualMatrix(db, 2026).cellNotes;
    expect(notes).toHaveLength(1);
    expect(notes[0].memo).toBe('保留');
  });

  it('年度冻结后禁止更新汇总备注', () => {
    const db = testDb();
    const fx = buildFixture(db);
    actual.saveActual(db, {
      year: 2026, snapshotDate: '2026-12-31',
      entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '1.00' }],
      source: 'manual', mode: 'replace',
      cellNotes: [{ orgId: fx.orgIds.east, accountId: fx.accIds.incomeMain, memo: '冻结前' }],
    });
    const batchId = actual.getYearState(db, 2026)!.current_batch_id!;
    freezeYear(db, 2026, batchId);
    expect(() => actual.saveActual(db, {
      year: 2026, snapshotDate: '2026-12-31', entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '2.00' }],
      source: 'manual', mode: 'replace',
      cellNotes: [{ orgId: fx.orgIds.east, accountId: fx.accIds.incomeMain, memo: '冻结后' }],
    })).toThrow(/已冻结/);
  });
});
