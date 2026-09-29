import { describe, expect, it } from 'vitest';
import { testDb, buildFixture, account, metric } from './helpers';
import { applyMigrations } from '../src/db/migrations';
import { computeMetrics } from '../src/modules/metric/metric.service';

describe('管理口径总收入/总成本/利润指标迁移', () => {
  it('不含增值税并满足用户确认的三项勾稽关系', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const i2 = account.createAccount(db, { parentId: null, code: 'I2', name: '投资收益', type: 'income' });
    const i3 = account.createAccount(db, { parentId: null, code: 'I3', name: '营业外收入', type: 'income' });
    const c2 = account.createAccount(db, { parentId: null, code: 'C2', name: '增值税', type: 'cost' });
    const c5 = account.createAccount(db, { parentId: null, code: 'C5', name: '营业外支出', type: 'cost' });
    const c6 = account.createAccount(db, { parentId: null, code: 'C6', name: '所得税费用', type: 'cost' });
    const p01 = metric.createMetric(db, { code: 'P01', name: '营业总收入', terms: [{ sourceType: 'account', sourceAccountId: fx.accIds.incomeRoot, coefficient: 1 }] });
    const p02 = metric.createMetric(db, { code: 'P02', name: '营业总成本', terms: [{ sourceType: 'account', sourceAccountId: fx.accIds.costRoot, coefficient: 1 }, { sourceType: 'account', sourceAccountId: fx.accIds.expenseRoot, coefficient: 1 }] });
    const p03 = metric.createMetric(db, { code: 'P03', name: '营业利润', terms: [{ sourceType: 'metric', sourceMetricId: p01.id, coefficient: 1 }, { sourceType: 'metric', sourceMetricId: p02.id, coefficient: 1 }] });
    const p04 = metric.createMetric(db, { code: 'P04', name: '利润总额', terms: [{ sourceType: 'metric', sourceMetricId: p03.id, coefficient: 1 }] });
    const p05 = metric.createMetric(db, { code: 'P05', name: '净利润', terms: [{ sourceType: 'metric', sourceMetricId: p04.id, coefficient: 1 }, { sourceType: 'account', sourceAccountId: c6.id, coefficient: 1 }] });
    metric.createMetric(db, { code: 'P06', name: '总成本（含增值税）', terms: [{ sourceType: 'metric', sourceMetricId: p02.id, coefficient: 1 }, { sourceType: 'account', sourceAccountId: c2.id, coefficient: 1 }] });

    db.prepare('DELETE FROM schema_migration WHERE version = 14').run();
    applyMigrations(db);

    const definitions = metric.listMetrics(db);
    const totalIncome = definitions.find((item) => item.code === 'P07')!;
    const totalCost = definitions.find((item) => item.code === 'P06')!;
    const profitTotal = definitions.find((item) => item.code === 'P04')!;
    const netProfit = definitions.find((item) => item.code === 'P05')!;
    expect(totalCost.name).toBe('总成本');
    expect(totalCost.terms.some((term) => term.source_account_id === c2.id)).toBe(false);

    const values = computeMetrics(new Map([
      [fx.accIds.incomeRoot, 100_000], [i2.id, 5_000], [i3.id, 3_000],
      [fx.accIds.costRoot, -40_000], [fx.accIds.expenseRoot, -20_000],
      [c2.id, -13_000], [c5.id, -2_000], [c6.id, -6_000],
    ]), definitions);
    expect(values.get(totalIncome.id)).toBe(108_000);
    expect(values.get(totalCost.id)).toBe(-68_000);
    expect(values.get(netProfit.id)).toBe(40_000);
    expect(values.get(profitTotal.id)).toBe(46_000);
  });
});
