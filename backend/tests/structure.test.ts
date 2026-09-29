import { describe, it, expect } from 'vitest';
import { testDb, buildFixture, standardBudgetVersion, saveActualSnapshot, account, metric, budget } from './helpers';
import { RATIO_SCALE } from '../src/core/money';
import { structureReport } from '../src/modules/report/structure.service';
import { structureVerificationFacts } from '../src/modules/report/verification';
import { exportStructure } from '../src/modules/io/export.service';

/**
 * 结构占比分析(共同比报表)。
 *
 * 标准夹具的预算数(元):
 *   收入 I > I01 = 150(上海 100 + 杭州 50)
 *   成本 C > C01 > C0101 = 90(上海 60 + 杭州 30)
 *   费用 E > E01 管理 20(上海) / E02 销售 10(杭州) / E03 其他 0
 *   指标 GROSS 毛利 = I01 + C01 = 150 - 90 = 60
 */

const pct = (n: number) => n * RATIO_SCALE; // 0.6 -> 600000
const row = (rep: ReturnType<typeof structureReport>, code: string) => rep.rows.find((r) => r.code === code)!;

describe('结构占比:占直接上级', () => {
  it('逐行占上级,成本费用经符号归一读成正数', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const v = standardBudgetVersion(fx);
    const rep = structureReport(db, { versionId: v.id, basisMode: 'parent' });

    // E01 管理费用 20 占 E 费用 30 = 66.6667%
    const e01 = row(rep, 'E01');
    expect(e01.budget.scaled).toBe(666667);
    // 归一后分子分母都是正数(费用存的是负数)
    expect(e01.budget.numeratorCents).toBe(2_000);
    expect(e01.budget.basisCents).toBe(3_000);
    expect(e01.basisLabel).toContain('E 费用');

    // E02 销售费用 10 占 E = 33.3333%
    expect(row(rep, 'E02').budget.scaled).toBe(333333);
    // E03 其他费用 0 占 E = 0%(是 0 不是 N/A —— 分子为零而基准正常)
    expect(row(rep, 'E03').budget.scaled).toBe(0);
    expect(row(rep, 'E03').budget.special).toBeNull();

    // C0101 是 C01 的唯一子项 -> 100%
    expect(row(rep, 'C0101').budget.scaled).toBe(pct(1));
    db.close();
  });

  it('顶层科目没有上级,显示 N/A 并说明原因', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const v = standardBudgetVersion(fx);
    const rep = structureReport(db, { versionId: v.id, basisMode: 'parent' });
    for (const code of ['I', 'C', 'E']) {
      expect(row(rep, code).budget.scaled).toBeNull();
      expect(row(rep, code).basisLabel).toContain('无上级');
    }
    db.close();
  });

  it('同上级子项:金额逐分守恒,占比之和约等于 100%', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const v = standardBudgetVersion(fx);
    const rep = structureReport(db, { versionId: v.id, basisMode: 'parent' });

    const underE = rep.reconciliation.find((item) => item.parentCode === 'E')!;
    expect(underE.childCount).toBe(3);
    // 子项金额之和必须等于父节点(rollup 沿祖先链累计的结构性保证)
    expect(underE.budgetChildSumCents).toBe(underE.budgetParentCents);
    expect(underE.amountReconciled).toBe(true);
    // 占比之和:666667 + 333333 + 0 = 10^6,允许几个 10^-6 的舍入偏差
    expect(Math.abs((underE.budgetShareSumScaled ?? 0) - RATIO_SCALE)).toBeLessThanOrEqual(3);

    // 全部父节点都必须金额守恒
    expect(rep.reconciliation.every((item) => item.amountReconciled)).toBe(true);
    // 只有一个子项的父节点(C01)不进核对表
    expect(rep.reconciliation.map((i) => i.parentCode)).not.toContain('C01');
    db.close();
  });
});

describe('结构占比:占指定科目 / 指定指标(共同比报表)', () => {
  it('全表统一以营业收入为基准', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const v = standardBudgetVersion(fx);
    const rep = structureReport(db, { versionId: v.id, basisMode: 'account', basisId: fx.accIds.incomeMain });

    expect(rep.basis.mode).toBe('account');
    expect(rep.basis.label).toContain('I01');
    // 成本 90 / 收入 150 = 60%
    expect(row(rep, 'C01').budget.scaled).toBe(pct(0.6));
    // 管理费用 20 / 150 = 13.3333%
    expect(row(rep, 'E01').budget.scaled).toBe(133333);
    // 基准自身占自身 = 100%
    expect(row(rep, 'I01').budget.scaled).toBe(pct(1));
    db.close();
  });

  it('以金额指标为基准,指标已是利润方向不再翻符号', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const v = standardBudgetVersion(fx);
    const rep = structureReport(db, { versionId: v.id, basisMode: 'metric', basisId: fx.metricIds.gross });
    // 毛利 = 150 - 90 = 60;管理费用 20 / 60 = 33.3333%
    expect(row(rep, 'E01').budget.scaled).toBe(333333);
    expect(row(rep, 'E01').budget.basisCents).toBe(6_000);
    db.close();
  });

  it('基准为零或归一后为负时显示 N/A 并区分原因,不伪造 0', () => {
    const db = testDb();
    const fx = buildFixture(db);

    // 空版本:所有基准为零
    const empty = budget.createVersion(db, { year: 2026, name: 'EMPTY' });
    const zeroRep = structureReport(db, { versionId: empty.id, basisMode: 'account', basisId: fx.accIds.incomeMain });
    expect(row(zeroRep, 'C01').budget.scaled).toBeNull();
    expect(row(zeroRep, 'C01').budget.special).toBe('na_zero_basis');

    // 亏损版本:成本 120 > 收入 100 -> 毛利 -20,拿它当基准无业务含义
    const loss = budget.createVersion(db, { year: 2027, name: 'LOSS' });
    budget.saveEntries(db, loss.id, [
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '100.00' },
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.costSub, amount: '120.00' },
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.expenseAdmin, amount: '20.00' },
    ]);
    const lossRep = structureReport(db, { versionId: loss.id, basisMode: 'metric', basisId: fx.metricIds.gross });
    expect(row(lossRep, 'E01').budget.scaled).toBeNull();
    expect(row(lossRep, 'E01').budget.special).toBe('na_negative_basis');
    db.close();
  });

  it('基准落在筛选范围外时直接拒绝,不给出无法解释的占比', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const v = standardBudgetVersion(fx);
    // 科目范围只取费用子树,却拿收入当基准
    expect(() => structureReport(db, {
      versionId: v.id, accountScopeId: fx.accIds.expenseRoot,
      basisMode: 'account', basisId: fx.accIds.incomeMain,
    })).toThrow(/不在当前预算表格\/科目范围内/);
    db.close();
  });

  it('数量科目与比率指标都不能作基准', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const qty = account.createAccount(db, { parentId: null, code: 'Q1', name: '上网电量', type: 'quantity', unit: '万度', quantityAgg: 'sum' }).id;
    const ratio = metric.createMetric(db, {
      code: 'R_GM', name: '毛利率', kind: 'ratio', displayFormat: 'percent',
      terms: [
        { sourceType: 'metric', sourceMetricId: fx.metricIds.gross, coefficient: 1, role: 'numerator' },
        { sourceType: 'account', sourceAccountId: fx.accIds.incomeMain, coefficient: 1, role: 'denominator' },
      ],
    }).id;
    const v = standardBudgetVersion(fx);
    expect(() => structureReport(db, { versionId: v.id, basisMode: 'account', basisId: qty }))
      .toThrow(/数量科目不能作为结构占比的基准/);
    expect(() => structureReport(db, { versionId: v.id, basisMode: 'metric', basisId: ratio }))
      .toThrow(/比率型指标不能作为结构占比的基准/);
    db.close();
  });

  it('数量科目不出现在结构占比行里(金额恒为零,占比无意义)', () => {
    const db = testDb();
    const fx = buildFixture(db);
    account.createAccount(db, { parentId: null, code: 'Q1', name: '上网电量', type: 'quantity', unit: '万度', quantityAgg: 'sum' });
    const v = standardBudgetVersion(fx);
    const rep = structureReport(db, { versionId: v.id, basisMode: 'parent' });
    expect(rep.rows.map((r) => r.code)).not.toContain('Q1');
    db.close();
  });
});

describe('结构占比:预实结构对比与范围', () => {
  it('实际结构与预算结构分别算,差异是百分点差', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const v = standardBudgetVersion(fx);
    budget.lockVersion(db, v.id);
    budget.setCurrentVersion(db, v.id);
    // 实际:收入 200,成本 90(与预算同),管理费用 20
    saveActualSnapshot(fx, 2026, '2026-06-30', [
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '200.00' },
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.costSub, amount: '90.00' },
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.expenseAdmin, amount: '20.00' },
    ]);
    const rep = structureReport(db, { versionId: v.id, basisMode: 'account', basisId: fx.accIds.incomeMain });

    const c01 = row(rep, 'C01');
    // 预算成本率 90/150 = 60%;实际 90/200 = 45%
    expect(c01.budget.scaled).toBe(pct(0.6));
    expect(c01.actual.scaled).toBe(pct(0.45));
    // 结构差异 = 45% - 60% = -15 个百分点
    expect(c01.deltaScaled).toBe(pct(-0.15));
    db.close();
  });

  it('组织范围收窄后按该范围重新汇总分子分母,不是各组织占比之和', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const v = standardBudgetVersion(fx);
    const all = structureReport(db, { versionId: v.id, basisMode: 'account', basisId: fx.accIds.incomeMain });
    const sh = structureReport(db, { versionId: v.id, orgScopeId: fx.orgIds.shanghai, basisMode: 'account', basisId: fx.accIds.incomeMain });
    const hz = structureReport(db, { versionId: v.id, orgScopeId: fx.orgIds.hangzhou, basisMode: 'account', basisId: fx.accIds.incomeMain });

    // 上海 60/100 = 60%;杭州 30/50 = 60%;合计 90/150 = 60%
    expect(row(sh, 'C01').budget.scaled).toBe(pct(0.6));
    expect(row(hz, 'C01').budget.scaled).toBe(pct(0.6));
    expect(row(all, 'C01').budget.scaled).toBe(pct(0.6));
    // 关键:合计不是两地占比相加
    expect(row(all, 'C01').budget.scaled).not.toBe(
      (row(sh, 'C01').budget.scaled ?? 0) + (row(hz, 'C01').budget.scaled ?? 0)
    );
    // 管理费用只在上海:上海 20/100 = 20%,杭州 0%,合计 20/150 = 13.33%
    expect(row(sh, 'E01').budget.scaled).toBe(pct(0.2));
    expect(row(hz, 'E01').budget.scaled).toBe(0);
    expect(row(all, 'E01').budget.scaled).toBe(133333);
    db.close();
  });

  it('汇总层级只影响展示行数,不改变占比与守恒核对', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const v = standardBudgetVersion(fx);
    const full = structureReport(db, { versionId: v.id, basisMode: 'parent' });
    const level1 = structureReport(db, { versionId: v.id, basisMode: 'parent', summaryLevel: 1 });
    // 一级只留顶层科目
    expect(level1.rows.every((r) => r.level === 0)).toBe(true);
    expect(level1.rows.length).toBeLessThan(full.rows.length);
    // 守恒核对不受展示层级影响(按完整计算范围)
    expect(level1.reconciliation.length).toBe(full.reconciliation.length);
    db.close();
  });

  it('锁定版本沿用绑定树快照:之后新增科目不进历史结构表', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const v = standardBudgetVersion(fx);
    budget.lockVersion(db, v.id);
    const before = structureReport(db, { versionId: v.id, basisMode: 'parent' }).rows.length;
    account.createAccount(db, { parentId: fx.accIds.expenseRoot, code: 'E04', name: '新增费用', type: 'expense' });
    const after = structureReport(db, { versionId: v.id, basisMode: 'parent' });
    expect(after.rows.length).toBe(before);
    expect(after.rows.map((r) => r.code)).not.toContain('E04');
    db.close();
  });

  it('混合可解释与不可解释断链时,聚合核验仍保持 bad', () => {
    const facts = structureVerificationFacts({
      actualSource: 'current',
      reconciliation: { sourceActualCents: 100, displayedActualCents: 100, differenceCents: 0 },
      unbudgetedActual: { count: 1, amountCents: 20, entries: [] },
      unbudgetedAccountIds: new Set([10]),
      brokenReconciliation: [
        { parentId: 10, parentCode: 'I', parentName: '收入' },
        { parentId: 20, parentCode: 'C', parentName: '成本' },
      ],
      scope: { versionId: 1, batchId: 1, orgScopeId: null, accountScopeId: null, sheetKey: 'all' },
    });
    const subtotal = facts.find((fact) => fact.factKey === 'subtotal');
    expect(subtotal?.serverLevel).toBe('bad');
    expect(subtotal?.facts).toMatchObject({ brokenCount: 2, carriedCount: 1, unexplainedCount: 1 });
    expect(subtotal?.details.join('\n')).toContain('C 成本');
  });

  it('全部断链均由新增分支解释时,聚合核验为 warn', () => {
    const facts = structureVerificationFacts({
      actualSource: 'current',
      reconciliation: { sourceActualCents: 100, displayedActualCents: 100, differenceCents: 0 },
      unbudgetedActual: { count: 2, amountCents: 20, entries: [] },
      unbudgetedAccountIds: new Set([10, 20]),
      brokenReconciliation: [
        { parentId: 10, parentCode: 'I', parentName: '收入' },
        { parentId: 20, parentCode: 'C', parentName: '成本' },
      ],
      scope: { versionId: 1, batchId: 1, orgScopeId: null, accountScopeId: null, sheetKey: 'all' },
    });
    const subtotal = facts.find((fact) => fact.factKey === 'subtotal');
    expect(subtotal?.serverLevel).toBe('warn');
    expect(subtotal?.facts).toMatchObject({ brokenCount: 2, carriedCount: 2, unexplainedCount: 0 });
  });

  it('导出结构占比表可生成且带基准与守恒说明', async () => {
    const db = testDb();
    const fx = buildFixture(db);
    const v = standardBudgetVersion(fx);
    const buffer = await exportStructure(db, { versionId: v.id, basisMode: 'account', basisId: fx.accIds.incomeMain });
    expect(buffer.byteLength).toBeGreaterThan(1000);
    db.close();
  });
});
