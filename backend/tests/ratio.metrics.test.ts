import { describe, it, expect } from 'vitest';
import { testDb, buildFixture, standardBudgetVersion, saveActualSnapshot, account, metric, budget } from './helpers';
import { scaledRatio, RATIO_SCALE, QUANTITY_SCALE } from '../src/core/money';
import { rollup } from '../src/core/rollup';
import { completionReport, yearTrend } from '../src/modules/report/report.service';
import { metricEvidence } from '../src/modules/evidence/evidence.service';
import { loadSnapshotNodes } from '../src/modules/tree/snapshot';

/**
 * 比率型指标(方案四.10 扩展)。重点验证四件事:
 * 1. 定点除法用 BigInt 精确完成,金额分值乘 10^6 不溢出;
 * 2. 分母为 0 返回 N/A 而不是 0;
 * 3. 符号系数把成本费用归一成业务读法(费用率读正数);
 * 4. 比率与金额指标彻底分离:不混进 metrics、不可被引用、不参与穿透与趋势。
 */

describe('比率定点除法(core/money.scaledRatio)', () => {
  it('金额÷金额得无量纲比率,两侧同为分则约掉换算系数', () => {
    // 毛利 40 元 ÷ 收入 100 元 = 0.4
    expect(scaledRatio(4000, 10000, 100, 100)).toBe(0.4 * RATIO_SCALE);
  });

  it('四舍五入远离零,保留到 10^-6', () => {
    // 1 ÷ 3 = 0.333333…  -> 333333
    expect(scaledRatio(100, 300, 100, 100)).toBe(333333);
    // 2 ÷ 3 = 0.666666…  -> 666667(向上进位)
    expect(scaledRatio(200, 300, 100, 100)).toBe(666667);
    // 负数同样远离零:-2 ÷ 3 -> -666667
    expect(scaledRatio(-200, 300, 100, 100)).toBe(-666667);
  });

  it('大额不溢出:分值乘 10^6 超出安全整数,BigInt 路径仍精确', () => {
    // 9 亿元收入 = 90_000_000_000 分;乘 10^6 远超 Number.MAX_SAFE_INTEGER
    const income = 90_000_000_000;
    expect(income * RATIO_SCALE).toBeGreaterThan(Number.MAX_SAFE_INTEGER);
    // 毛利 2.7 亿 ÷ 收入 9 亿 = 0.3,必须精确
    expect(scaledRatio(27_000_000_000, income, 100, 100)).toBe(0.3 * RATIO_SCALE);
  });

  it('金额÷数量按各自自然单位换算:元 ÷ 计量单位', () => {
    // 收入 3000 元(300000 分) ÷ 电量 1 万度(10000 缩放) = 3000 元/万度
    expect(scaledRatio(300_000, 1 * QUANTITY_SCALE, 100, QUANTITY_SCALE)).toBe(3000 * RATIO_SCALE);
  });

  it('分母为 0 返回 null,不伪造 0', () => {
    expect(scaledRatio(12345, 0, 100, 100)).toBeNull();
  });

  it('非整数入参直接报错,不静默取整', () => {
    expect(() => scaledRatio(1.5, 100, 100, 100)).toThrow(/非法整数/);
  });
});

describe('比率指标定义校验', () => {
  it('必须恰好一个分子和一个分母', () => {
    const db = testDb();
    const fx = buildFixture(db);
    expect(() => metric.createMetric(db, {
      code: 'R_BAD', name: '缺分母', kind: 'ratio',
      terms: [{ sourceType: 'account', sourceAccountId: fx.accIds.incomeMain, coefficient: 1, role: 'numerator' }],
    })).toThrow(/恰好有一个分子和一个分母/);
    db.close();
  });

  it('线性指标的公式项不能带分子分母角色,比率的公式项必须指明角色', () => {
    const db = testDb();
    const fx = buildFixture(db);
    expect(() => metric.createMetric(db, {
      code: 'L_BAD', name: '线性带角色', kind: 'linear',
      terms: [{ sourceType: 'account', sourceAccountId: fx.accIds.incomeMain, coefficient: 1, role: 'numerator' }],
    })).toThrow(/不能设置分子\/分母角色/);
    expect(() => metric.createMetric(db, {
      code: 'R_BAD2', name: '比率缺角色', kind: 'ratio',
      terms: [
        { sourceType: 'account', sourceAccountId: fx.accIds.incomeMain, coefficient: 1 },
        { sourceType: 'account', sourceAccountId: fx.accIds.costMain, coefficient: -1 },
      ],
    })).toThrow(/必须指明分子或分母/);
    db.close();
  });

  it('比率不能被任何指标引用(线性项与比率两侧都不行)', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const ratio = metric.createMetric(db, {
      code: 'R_GM', name: '毛利率', kind: 'ratio', displayFormat: 'percent',
      terms: [
        { sourceType: 'metric', sourceMetricId: fx.metricIds.gross, coefficient: 1, role: 'numerator' },
        { sourceType: 'account', sourceAccountId: fx.accIds.incomeMain, coefficient: 1, role: 'denominator' },
      ],
    }).id;
    expect(() => metric.createMetric(db, {
      code: 'L_REF', name: '想加比率', kind: 'linear',
      terms: [{ sourceType: 'metric', sourceMetricId: ratio, coefficient: 1 }],
    })).toThrow(/比率指标不能被其他指标引用/);
    expect(() => metric.createMetric(db, {
      code: 'R_REF', name: '比率的比率', kind: 'ratio',
      terms: [
        { sourceType: 'metric', sourceMetricId: ratio, coefficient: 1, role: 'numerator' },
        { sourceType: 'account', sourceAccountId: fx.accIds.incomeMain, coefficient: 1, role: 'denominator' },
      ],
    })).toThrow(/比率指标不能被其他指标引用/);
    db.close();
  });

  it('线性指标仍然禁止引用数量科目;比率只接受可累计的数量科目', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const sumQty = account.createAccount(db, { parentId: null, code: 'Q1', name: '上网电量', type: 'quantity', unit: '万度', quantityAgg: 'sum' }).id;
    const noneQty = account.createAccount(db, { parentId: null, code: 'Q2', name: '上网电价', type: 'quantity', unit: '元/度', quantityAgg: 'none' }).id;

    expect(() => metric.createMetric(db, {
      code: 'L_QTY', name: '线性引数量', kind: 'linear',
      terms: [{ sourceType: 'account', sourceAccountId: sumQty, coefficient: 1 }],
    })).toThrow(/不能引用数量型科目/);

    expect(() => metric.createMetric(db, {
      code: 'R_NONE', name: '拿单价当分母', kind: 'ratio', displayFormat: 'number', unit: '元/度',
      terms: [
        { sourceType: 'account', sourceAccountId: fx.accIds.incomeMain, coefficient: 1, role: 'numerator' },
        { sourceType: 'account', sourceAccountId: noneQty, coefficient: 1, role: 'denominator' },
      ],
    })).toThrow(/汇总方式=可加总/);

    // 可累计数量科目作分母是允许的
    expect(() => metric.createMetric(db, {
      code: 'R_PRICE', name: '平均电价', kind: 'ratio', displayFormat: 'number', unit: '元/万度',
      terms: [
        { sourceType: 'account', sourceAccountId: fx.accIds.incomeMain, coefficient: 1, role: 'numerator' },
        { sourceType: 'account', sourceAccountId: sumQty, coefficient: 1, role: 'denominator' },
      ],
    })).not.toThrow();
    db.close();
  });

  it('被引用的线性指标不能改成比率;改类型必须同时给新公式', () => {
    const db = testDb();
    const fx = buildFixture(db);
    // 毛利被营业利润引用
    expect(() => metric.updateMetric(db, fx.metricIds.gross, {
      kind: 'ratio',
      terms: [
        { sourceType: 'account', sourceAccountId: fx.accIds.incomeMain, coefficient: 1, role: 'numerator' },
        { sourceType: 'account', sourceAccountId: fx.accIds.incomeMain, coefficient: 1, role: 'denominator' },
      ],
    })).toThrow(/不能改为比率型/);
    expect(() => metric.updateMetric(db, fx.metricIds.operating, { kind: 'ratio' }))
      .toThrow(/必须同时提交新的公式定义/);
    db.close();
  });
});

describe('比率指标求值与报表口径', () => {
  /** 在标准夹具上加两个比率:毛利率(百分比) 与 费用率(越低越好,分子取反) */
  const withRatios = () => {
    const db = testDb();
    const fx = buildFixture(db);
    const grossMargin = metric.createMetric(db, {
      code: 'R_GM', name: '毛利率', displayOrder: 10, kind: 'ratio',
      direction: 'higher_better', displayFormat: 'percent',
      terms: [
        { sourceType: 'metric', sourceMetricId: fx.metricIds.gross, coefficient: 1, role: 'numerator' },
        { sourceType: 'account', sourceAccountId: fx.accIds.incomeMain, coefficient: 1, role: 'denominator' },
      ],
    }).id;
    const expenseRatio = metric.createMetric(db, {
      code: 'R_ER', name: '管理费用率', displayOrder: 11, kind: 'ratio',
      direction: 'lower_better', displayFormat: 'percent',
      terms: [
        // 费用存的是负数,系数 -1 归一成业务读法(正数)
        { sourceType: 'account', sourceAccountId: fx.accIds.expenseAdmin, coefficient: -1, role: 'numerator' },
        { sourceType: 'account', sourceAccountId: fx.accIds.incomeMain, coefficient: 1, role: 'denominator' },
      ],
    }).id;
    return { db, fx, grossMargin, expenseRatio };
  };

  it('rollup 只把线性值放进 metrics,比率单独进 metricRatios', () => {
    const { db, fx, grossMargin } = withRatios();
    const v = standardBudgetVersion(fx);
    const orgRows = loadSnapshotNodes(db, v.org_tree_snapshot_id);
    const accRows = loadSnapshotNodes(db, v.account_tree_snapshot_id);
    const entries = [
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amountCents: 10_000_000 },
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.costSub, amountCents: -6_000_000 },
    ];
    const roll = rollup(orgRows, accRows, entries, metric.listMetrics(db));

    // 线性指标仍是分:毛利 = 100 - 60 = 40 万... 这里金额单位是分,100 元 = 10000 分
    expect(roll.metrics.get(fx.metricIds.gross)).toBe(4_000_000);
    // 比率不在 metrics 里,避免被当成金额展示
    expect(roll.metrics.has(grossMargin)).toBe(false);
    // 毛利率 = 40 / 100 = 0.4
    expect(roll.metricRatios.get(grossMargin)?.scaled).toBe(0.4 * RATIO_SCALE);
    db.close();
  });

  it('完成情况表:比率进 ratioMetrics,金额指标数量不变;差异是百分点差且按 direction 判有利', () => {
    const { db, fx, grossMargin, expenseRatio } = withRatios();
    const v = standardBudgetVersion(fx);
    budget.lockVersion(db, v.id);
    budget.setCurrentVersion(db, v.id);
    // 实际:收入 120(超),成本 60(同),管理费用 30(超)
    saveActualSnapshot(fx, 2026, '2026-06-30', [
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '120.00' },
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.costSub, amount: '60.00' },
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.expenseAdmin, amount: '30.00' },
    ]);

    const rep = completionReport(db, { versionId: v.id });

    // 金额指标表里没有比率
    expect(rep.metrics.map((m) => m.code)).not.toContain('R_GM');
    expect(rep.metrics.map((m) => m.code)).toEqual(expect.arrayContaining(['GROSS', 'OP']));

    const gm = rep.ratioMetrics.find((m) => m.code === 'R_GM')!;
    // 预算:收入 150(上海100+杭州50),毛利 = 150 - 90 = 60 -> 0.4
    expect(gm.budget.scaled).toBe(0.4 * RATIO_SCALE);
    // 实际:收入 120,成本 60,毛利 60 -> 0.5
    expect(gm.actual.scaled).toBe(0.5 * RATIO_SCALE);
    // 差异 = 实际 - 预算 = +0.1 = +10 个百分点,越高越好 -> 有利
    expect(gm.deltaScaled).toBe(0.1 * RATIO_SCALE);
    expect(gm.favorable).toBe('favorable');
    // 比率行不带完成率字段语义:分子分母原值可核对
    expect(gm.actual.numeratorBasis).toBe('money');
    expect(gm.actual.denominatorBasis).toBe('money');

    const er = rep.ratioMetrics.find((m) => m.code === 'R_ER')!;
    // 分子取反后为正:预算管理费用 20 / 收入 150
    expect(er.budget.numeratorRaw).toBeGreaterThan(0);
    expect(er.budget.scaled).toBe(scaledRatio(2_000_000, 15_000_000, 100, 100));
    // 实际 30 / 120 = 0.25 高于预算 0.1333,越低越好 -> 不利
    expect(er.actual.scaled).toBe(0.25 * RATIO_SCALE);
    expect(er.favorable).toBe('unfavorable');
    db.close();
  });

  it('分母为零时比率为 N/A,差异也为 N/A(不退化成 0)', () => {
    const { db, fx, grossMargin } = withRatios();
    const v = budget.createVersion(db, { year: 2026, name: 'EMPTY' });
    // 只录费用,收入为 0 -> 毛利率分母为零
    budget.saveEntries(db, v.id, [
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.expenseAdmin, amount: '20.00' },
    ]);
    const rep = completionReport(db, { versionId: v.id });
    const gm = rep.ratioMetrics.find((m) => m.metricId === grossMargin)!;
    expect(gm.budget.scaled).toBeNull();
    expect(gm.budget.special).toBe('na_zero_denominator');
    expect(gm.deltaScaled).toBeNull();
    expect(gm.favorable).toBe('none');
    db.close();
  });

  it('金额÷可累计数量:范围内数量作分母,得元/计量单位', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const qty = account.createAccount(db, { parentId: null, code: 'Q1', name: '上网电量', type: 'quantity', unit: '万度', quantityAgg: 'sum' }).id;
    const price = metric.createMetric(db, {
      code: 'R_PRICE', name: '平均上网电价', kind: 'ratio', displayFormat: 'number', unit: '元/万度',
      terms: [
        { sourceType: 'account', sourceAccountId: fx.accIds.incomeMain, coefficient: 1, role: 'numerator' },
        { sourceType: 'account', sourceAccountId: qty, coefficient: 1, role: 'denominator' },
      ],
    }).id;
    const v = budget.createVersion(db, { year: 2026, name: 'QTY' });
    budget.saveEntries(db, v.id, [
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '3000.00' },
      { orgId: fx.orgIds.shanghai, accountId: qty, quantity: '1' },
      { orgId: fx.orgIds.hangzhou, accountId: fx.accIds.incomeMain, amount: '3000.00' },
      { orgId: fx.orgIds.hangzhou, accountId: qty, quantity: '1' },
    ]);
    const rep = completionReport(db, { versionId: v.id });
    const row = rep.ratioMetrics.find((m) => m.metricId === price)!;
    // 收入 6000 元 ÷ 电量 2 万度 = 3000 元/万度;数量跨组织求和,不是平均
    expect(row.budget.denominatorBasis).toBe('quantity');
    expect(row.budget.denominatorRaw).toBe(2 * QUANTITY_SCALE);
    expect(row.budget.scaled).toBe(3000 * RATIO_SCALE);
    db.close();
  });

  it('比率不可加总:组织范围收窄后按该范围的分子分母重算,而不是各组织比率之和', () => {
    const { db, fx, grossMargin } = withRatios();
    const v = standardBudgetVersion(fx);
    // 上海 100/60 -> 毛利率 0.4;杭州 50/30 -> 0.4;合计 150/90 -> 0.4
    const all = completionReport(db, { versionId: v.id }).ratioMetrics.find((m) => m.metricId === grossMargin)!;
    const sh = completionReport(db, { versionId: v.id, orgScopeId: fx.orgIds.shanghai }).ratioMetrics.find((m) => m.metricId === grossMargin)!;
    expect(all.budget.scaled).toBe(0.4 * RATIO_SCALE);
    expect(sh.budget.scaled).toBe(0.4 * RATIO_SCALE);
    // 关键:合计不是 0.4 + 0.4 = 0.8
    expect(all.budget.scaled).not.toBe(2 * (sh.budget.scaled ?? 0));
    db.close();
  });

  it('比率不参与线性穿透与年内趋势,报错信息明确', () => {
    const { db, fx, grossMargin } = withRatios();
    const v = standardBudgetVersion(fx);
    budget.lockVersion(db, v.id);
    budget.setCurrentVersion(db, v.id);
    saveActualSnapshot(fx, 2026, '2026-06-30', [
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '120.00' },
    ]);
    expect(() => metricEvidence(db, { versionId: v.id, metricId: grossMargin }))
      .toThrow(/比率型指标/);
    expect(() => yearTrend(db, { year: 2026, versionId: v.id, trendKind: 'metric', trendId: grossMargin }))
      .toThrow(/不能与自然日进度比较/);
    db.close();
  });

  it('定稿固化比率定义:改了主表公式,锁定版本的比率不变', () => {
    const { db, fx, grossMargin } = withRatios();
    const v = standardBudgetVersion(fx);
    budget.lockVersion(db, v.id);
    const before = completionReport(db, { versionId: v.id }).ratioMetrics.find((m) => m.metricId === grossMargin)!;
    expect(before.budget.scaled).toBe(0.4 * RATIO_SCALE);

    // 把分母从主营收入改成管理费用(主表改动),锁定版本应读固化快照
    metric.updateMetric(db, grossMargin, {
      kind: 'ratio', direction: 'higher_better', displayFormat: 'percent',
      terms: [
        { sourceType: 'metric', sourceMetricId: fx.metricIds.gross, coefficient: 1, role: 'numerator' },
        { sourceType: 'account', sourceAccountId: fx.accIds.expenseAdmin, coefficient: -1, role: 'denominator' },
      ],
    });
    const after = completionReport(db, { versionId: v.id }).ratioMetrics.find((m) => m.metricId === grossMargin)!;
    expect(after.budget.scaled).toBe(0.4 * RATIO_SCALE);
    db.close();
  });
});
