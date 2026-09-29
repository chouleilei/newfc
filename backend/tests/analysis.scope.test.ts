import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { testDb, buildFixture, standardBudgetVersion, budget, actual } from './helpers';
import { createSheet } from '../src/modules/sheet/sheet.service';
import { completionReport, yearTrend } from '../src/modules/report/report.service';
import { exportCompletion } from '../src/modules/io/export.service';

describe('完成率 N/A 与异常边界(方案九.3,真实服务路径)', () => {
  // 直接断言 completionReport 输出的 cell.rate / cell.rateSpecial(界面口径标记),
  // 替代 unit.core.test.ts 中手工三元表达式的自证式边界用例。
  function setup() {
    const db = testDb();
    const fx = buildFixture(db);
    const version = budget.createVersion(db, { year: 2026, name: 'V边界' });
    budget.saveEntries(db, version.id, [
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '100.00' },
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.costSub, amount: '-60.00' }, // 成本冲回:预算展示口径为负
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.expenseAdmin, amount: '20.00' },
      // expenseSales 不录入预算:预算展示口径为 0
    ]);
    actual.saveActual(db, {
      year: 2026,
      snapshotDate: '2026-06-30',
      source: 'manual',
      mode: 'replace',
      entries: [
        { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '120.00' },
        { orgId: fx.orgIds.shanghai, accountId: fx.accIds.expenseAdmin, amount: '-5.00' }, // 费用冲回:实际展示口径为负
      ],
    });
    return { fx, report: completionReport(db, { versionId: version.id }) };
  }

  it('预算为 0 → 完成率 N/A(null + na_zero_budget 标记)', () => {
    const { fx, report } = setup();
    const row = report.byAccount.find((r) => r.accountId === fx.accIds.expenseSales)!;
    expect(row.cell.budgetCents).toBe(0);
    expect(row.cell.rate).toBeNull();
    expect(row.cell.rateSpecial).toBe('na_zero_budget');
  });

  it('预算为负(特殊预算) → N/A(null + na_negative_budget 标记)', () => {
    const { fx, report } = setup();
    const row = report.byAccount.find((r) => r.accountId === fx.accIds.costSub)!;
    expect(row.cell.budgetCents).toBe(6_000); // 成本冲回:存储为 +6000,展示口径为 -60.00
    expect(row.cell.rate).toBeNull();
    expect(row.cell.rateSpecial).toBe('na_negative_budget');
  });

  it('实际与预算方向相反 → opposite_direction 异常标记', () => {
    const { fx, report } = setup();
    const row = report.byAccount.find((r) => r.accountId === fx.accIds.expenseAdmin)!;
    expect(row.cell.rateSpecial).toBe('opposite_direction');
    // 现状:makeCell 在标记的同时保留 completionRate 的带符号结果(-5/20),并不置 null
    expect(row.cell.rate).toBeCloseTo(-0.25, 10);
  });

  it('正例:完成率超过 100% 正常返回且无特殊标记', () => {
    const { fx, report } = setup();
    const row = report.byAccount.find((r) => r.accountId === fx.accIds.incomeMain)!;
    expect(row.cell.rate).toBeCloseTo(1.2, 10); // 120/100
    expect(row.cell.rateSpecial).toBeNull();
  });
});

describe('预算执行分析统一口径', () => {
  function setup() {
    const db = testDb();
    const fx = buildFixture(db);
    createSheet(db, { code: 'INCOME_ONLY', name: '收入预算表', rootCodes: ['I'] });
    const version = standardBudgetVersion(fx);
    budget.lockVersion(db, version.id);
    budget.setCurrentVersion(db, version.id);
    const first = actual.saveActual(db, {
      year: 2026,
      snapshotDate: '2026-03-31',
      source: 'manual',
      mode: 'replace',
      entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '30.00' }],
    });
    const second = actual.saveActual(db, {
      year: 2026,
      snapshotDate: '2026-06-30',
      source: 'manual',
      mode: 'replace',
      entries: [
        { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '60.00' },
        { orgId: fx.orgIds.hangzhou, accountId: fx.accIds.incomeMain, amount: '30.00' },
      ],
    });
    return { db, fx, version, first, second };
  }

  it('预算表格同时约束科目、组织净额、指标和进度偏差', () => {
    const { db, fx, version } = setup();
    const report = completionReport(db, { versionId: version.id, sheetKey: 'INCOME_ONLY' });
    expect(report.scopeBasis).toMatchObject({ sheetKey: 'INCOME_ONLY', sheetName: '收入预算表' });
    expect(report.byAccount.map((row) => row.code)).toEqual(['I', 'I01']);
    expect(report.byAccount.some((row) => row.code.startsWith('C') || row.code.startsWith('E'))).toBe(false);
    const group = report.byOrg.find((row) => row.orgId === fx.orgIds.root)!;
    expect(group.cell.budgetCents).toBe(15_000);
    expect(group.cell.actualCents).toBe(9_000);
    const income = report.byAccount.find((row) => row.accountId === fx.accIds.incomeMain)!;
    expect(income.cell.progressDeviation).toBeCloseTo(0.6 - 181 / 365, 10);
    expect(report.metrics.find((row) => row.code === 'GROSS')?.cell.budgetCents).toBe(15_000);
  });

  it('汇总层级只影响展示，不改变底层计算', () => {
    const { db, fx, version } = setup();
    const report = completionReport(db, { versionId: version.id, sheetKey: 'all', summaryLevel: 1 });
    expect(report.byAccount.every((row) => row.level === 0)).toBe(true);
    expect(report.byOrg.every((row) => row.level === 0)).toBe(true);
    expect(report.byAccount.find((row) => row.code === 'I')?.cell.budgetCents).toBe(15_000);
    expect(report.byOrg.find((row) => row.orgId === fx.orgIds.root)?.cell.budgetCents).toBe(3_000);
  });

  it('组织预算体量按一级科目绝对值合计，与净额口径分离', () => {
    const { db, fx, version } = setup();
    const report = completionReport(db, { versionId: version.id });
    // 上海:收入100/成本60/费用20 → 净额 +20 元,体量 180 元
    const shanghai = report.byOrg.find((row) => row.orgId === fx.orgIds.shanghai)!;
    expect(shanghai.cell.budgetCents).toBe(2_000);
    expect(shanghai.budgetVolumeCents).toBe(18_000);
    // 集团:净额 30 元,体量 |150| + |-90| + |-30| = 270 元
    const group = report.byOrg.find((row) => row.orgId === fx.orgIds.root)!;
    expect(group.cell.budgetCents).toBe(3_000);
    expect(group.budgetVolumeCents).toBe(27_000);
    // 收入预算表范围:体量只计收入顶行,不混入范围外科目
    const scoped = completionReport(db, { versionId: version.id, sheetKey: 'INCOME_ONLY' });
    expect(scoped.byOrg.find((row) => row.orgId === fx.orgIds.root)!.budgetVolumeCents).toBe(15_000);
  });

  it('同一级科目下的红字冲减先抵销再取绝对值', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const version = budget.createVersion(db, { year: 2026, name: 'V1' });
    budget.saveEntries(db, version.id, [
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.expenseAdmin, amount: '100.00' },
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.expenseOther, amount: '-30.00' },
    ]);
    const report = completionReport(db, { versionId: version.id });
    const shanghai = report.byOrg.find((row) => row.orgId === fx.orgIds.shanghai)!;
    // 费用顶行内 100 与 -30 抵销为 -70,体量 70 元;按叶子绝对值会虚增为 130 元
    expect(shanghai.cell.budgetCents).toBe(-7_000);
    expect(shanghai.budgetVolumeCents).toBe(7_000);
  });

  it('指定快照会截断同口径趋势', () => {
    const { db, fx, version, first } = setup();
    const trend = yearTrend(db, { year: 2026, versionId: version.id, sheetKey: 'INCOME_ONLY', batchId: first.batchId });
    expect(trend.points).toHaveLength(1);
    expect(trend.points[0].date).toBe('2026-03-31');
    expect(trend.points[0].progressDeviation).toBeCloseTo((30 / 150) - trend.points[0].timeProgress, 10);

    const accountTrend = yearTrend(db, { year: 2026, versionId: version.id, trendKind: 'account', trendId: fx.accIds.incomeMain });
    expect(accountTrend.target).toMatchObject({ kind: 'account', code: 'I01' });
    expect(accountTrend.points.at(-1)?.rate).toBeCloseTo(90 / 150, 10);

    const metricTrend = yearTrend(db, { year: 2026, versionId: version.id, trendKind: 'metric', trendId: fx.metricIds.gross });
    expect(metricTrend.target).toMatchObject({ kind: 'metric', code: 'GROSS' });
    expect(metricTrend.points.at(-1)?.rate).toBeCloseTo(90 / 60, 10);
  });

  it('Excel 导出沿用组织、表格、层级和预测筛选', async () => {
    const { db, fx, version } = setup();
    const forecast = budget.createVersion(db, { year: 2026, name: '预测', kind: 'forecast' });
    budget.saveEntries(db, forecast.id, [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '120.00' }]);
    budget.lockVersion(db, forecast.id);
    const buffer = await exportCompletion(db, version.id, {
      sheetKey: 'INCOME_ONLY',
      orgScopeId: fx.orgIds.east,
      summaryLevel: 2,
      forecastVersionId: forecast.id,
    });
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer as unknown as ArrayBuffer);
    const sheet = workbook.getWorksheet('预算完成情况')!;
    const rawValues = sheet.getSheetValues().flatMap((row) => Array.isArray(row) ? row : []);
    const values = rawValues.map(String);
    expect(values.some((value) => value.includes('收入预算表(INCOME_ONLY)'))).toBe(true);
    expect(values).toContain('全年预测(元/数量)');
    expect(rawValues).toContain(120);
    expect(values).not.toContain('C0101');
  });

  it('Excel 导出拒绝普通预算或其他年度的预测版本', async () => {
    const { db, version } = setup();
    const ordinary = budget.createVersion(db, { year: 2026, name: '普通预算' });
    const otherYear = budget.createVersion(db, { year: 2027, name: '跨年预测', kind: 'forecast' });

    await expect(exportCompletion(db, version.id, { forecastVersionId: ordinary.id }))
      .rejects.toThrow(/必须是预测版本/);
    await expect(exportCompletion(db, version.id, { forecastVersionId: otherYear.id }))
      .rejects.toThrow(/年度不一致/);
  });
});
