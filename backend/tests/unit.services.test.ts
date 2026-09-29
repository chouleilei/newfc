import { describe, it, expect, beforeEach } from 'vitest';
import { testDb, buildFixture, standardBudgetVersion, org, account, metric, budget, actual } from './helpers';
import { completionReport } from '../src/modules/report/report.service';

describe('指标:嵌套与循环引用(方案八.3)', () => {
  beforeEach(() => {});
  it('嵌套指标按拓扑序计算(营业利润引用毛利)', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const v = standardBudgetVersion(fx);
    const s = budget.versionSummary(db, v.id);
    // 收入 150,成本 90,费用 30 -> 毛利 60,营业利润 30
    expect(s.rollup.metrics.get(fx.metricIds.gross)).toBe(6000);
    expect(s.rollup.metrics.get(fx.metricIds.operating)).toBe(3000);
  });

  it('直接循环引用被拦截', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const a = metric.createMetric(db, {
      code: 'M1', name: 'M1',
      terms: [{ sourceType: 'account', sourceAccountId: fx.accIds.incomeMain, coefficient: 1 }],
    });
    expect(() =>
      metric.createMetric(db, {
        code: 'M2', name: 'M2',
        terms: [{ sourceType: 'metric', sourceMetricId: a.id, coefficient: 1 }],
      })
    ).not.toThrow();
    // M1 引用 M2 形成环
    expect(() =>
      metric.updateMetric(db, a.id, {
        terms: [{ sourceType: 'metric', sourceMetricId: (metric.listMetrics(db).find((m) => m.code === 'M2')!.id), coefficient: 1 }],
      })
    ).toThrow(/循环引用/);
  });

  it('自引用被拦截', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const m = metric.createMetric(db, {
      code: 'SELF', name: '自引用',
      terms: [{ sourceType: 'account', sourceAccountId: fx.accIds.incomeMain, coefficient: 1 }],
    });
    expect(() =>
      metric.updateMetric(db, m.id, {
        terms: [{ sourceType: 'metric', sourceMetricId: m.id, coefficient: 1 }],
      })
    ).toThrow(/循环|自身/);
  });

  it('公式引用停用科目继续计算并标记', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const m = metric.createMetric(db, {
      code: 'M', name: '引用停用科目',
      terms: [{ sourceType: 'account', sourceAccountId: fx.accIds.expenseSales, coefficient: 1 }],
    });
    account.setAccountStatus(db, fx.accIds.expenseSales, 'inactive');
    expect(metric.metricsWithDisabledAccount(db).has(m.id)).toBe(true);
    const v = standardBudgetVersion(fx);
    const s = budget.versionSummary(db, v.id);
    expect(s.rollup.metrics.get(m.id)).toBe(-1000); // 仍参与计算
  });

  it('预算定稿后指标公式修改不影响版本汇总和完成情况', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const v = standardBudgetVersion(fx);
    budget.lockVersion(db, v.id);
    expect(budget.versionSummary(db, v.id).rollup.metrics.get(fx.metricIds.gross)).toBe(6000);
    metric.updateMetric(db, fx.metricIds.gross, {
      terms: [{ sourceType: 'account', sourceAccountId: fx.accIds.incomeMain, coefficient: 1 }],
    });
    expect(budget.versionSummary(db, v.id).rollup.metrics.get(fx.metricIds.gross)).toBe(6000);
    expect(completionReport(db, { versionId: v.id }).metrics.find((m) => m.metricId === fx.metricIds.gross)?.cell.budgetCents).toBe(6000);
  });
});

describe('组织与科目管理规则', () => {
  it('编码唯一且不可变', () => {
    const db = testDb();
    buildFixture(db);
    expect(() => org.createOrg(db, { parentId: null, code: 'GROUP', name: '重复' })).toThrow(/已存在/);
    expect(() => account.createAccount(db, { parentId: null, code: 'I01', name: '重复', type: 'income' })).toThrow(/已存在/);
  });
  it('移动到自身后代被拦截', () => {
    const db = testDb();
    const fx = buildFixture(db);
    expect(() => org.moveOrg(db, fx.orgIds.root, fx.orgIds.shanghai)).toThrow(/后代/);
    expect(() => account.moveAccount(db, fx.accIds.incomeRoot, fx.accIds.incomeMain)).toThrow(/后代/);
    // 合法移动:上海挂到西部下
    org.moveOrg(db, fx.orgIds.shanghai, fx.orgIds.west);
    const rows = org.listOrgRows(db);
    expect(rows.find((r) => r.id === fx.orgIds.shanghai)!.parent_id).toBe(fx.orgIds.west);
  });
  it('科目子类类型必须与父类一致', () => {
    const db = testDb();
    const fx = buildFixture(db);
    expect(() =>
      account.createAccount(db, { parentId: fx.accIds.incomeRoot, code: 'X1', name: '成本挂收入下', type: 'cost' })
    ).toThrow(/类型不一致/);
  });
  it('有明细的叶子科目不能直接增加子科目', () => {
    const db = testDb();
    const fx = buildFixture(db);
    standardBudgetVersion(fx); // expenseAdmin 有明细
    expect(() =>
      account.createAccount(db, { parentId: fx.accIds.expenseAdmin, code: 'E0101', name: '子费用', type: 'expense' })
    ).toThrow(/不能直接增加子科目/);
    // 无明细的叶子可以增加子科目
    expect(() =>
      account.createAccount(db, { parentId: fx.accIds.expenseOther, code: 'E0301', name: '子项', type: 'expense' })
    ).not.toThrow();
  });
  it('被业务数据引用的节点不能物理删除,可停用', () => {
    const db = testDb();
    const fx = buildFixture(db);
    standardBudgetVersion(fx);
    expect(() => account.deleteAccount(db, fx.accIds.expenseAdmin)).toThrow(/不能物理删除/);
    account.setAccountStatus(db, fx.accIds.expenseAdmin, 'inactive');
    const rows = account.listAccountRows(db);
    expect(rows.find((r) => r.id === fx.accIds.expenseAdmin)!.status).toBe('inactive');
  });
  it('结构检查通过', () => {
    const db = testDb();
    buildFixture(db);
    expect(org.checkOrgStructure(db).ok).toBe(true);
    expect(account.checkAccountStructure(db).ok).toBe(true);
  });
});

describe('树快照复用(方案四.3)', () => {
  it('内容不变时复用同一快照', async () => {
    const db = testDb();
    const fx = buildFixture(db);
    const { createOrReuseSnapshot } = await import('../src/modules/tree/snapshot');
    const s1 = createOrReuseSnapshot(db, 'org');
    const s2 = createOrReuseSnapshot(db, 'org');
    expect(s1).toBe(s2);
    org.updateOrg(db, fx.orgIds.root, { name: '集团总部' });
    const s3 = createOrReuseSnapshot(db, 'org');
    expect(s3).not.toBe(s1);
  });
  it('快照包含停用节点', () => {
    const db = testDb();
    const fx = buildFixture(db);
    org.setOrgStatus(db, fx.orgIds.nanjing, 'inactive');
    const v = budget.createVersion(db, { year: 2026, name: 'snap' });
    const matrix = budget.getEditMatrix(db, v.id);
    const nanjing = matrix.orgNodes.find((o) => o.id === fx.orgIds.nanjing);
    expect(nanjing).toBeDefined();
    expect(nanjing!.status).toBe('inactive');
  });
});

describe('预算保存规则(方案六.5)', () => {
  it('零金额不保存,改为零即删除', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const v = budget.createVersion(db, { year: 2026, name: 'V' });
    budget.saveEntries(db, v.id, [
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '100.00', formula: '=50*2', note: '电量测算依据' },
    ]);
    let matrix = budget.getEditMatrix(db, v.id);
    expect(matrix.entries.length).toBe(1);
    expect(matrix.entries[0].formula).toBe('=50*2');
    expect(matrix.entries[0].note).toBe('电量测算依据');

    // 复制版本保留公式与附注
    budget.lockVersion(db, v.id);
    const copied = budget.copyVersion(db, v.id, 'V_COPY');
    const copiedMatrix = budget.getEditMatrix(db, copied.id);
    expect(copiedMatrix.entries[0].formula).toBe('=50*2');
    expect(copiedMatrix.entries[0].note).toBe('电量测算依据');

    budget.saveEntries(db, copied.id, [
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '0.00' },
    ]);
    matrix = budget.getEditMatrix(db, copied.id);
    expect(matrix.entries.length).toBe(0);
  });
  it('非叶子组织/科目被拒绝', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const v = budget.createVersion(db, { year: 2026, name: 'V' });
    expect(() =>
      budget.saveEntries(db, v.id, [{ orgId: fx.orgIds.east, accountId: fx.accIds.incomeMain, amount: '1.00' }])
    ).toThrow(/叶子/);
    expect(() =>
      budget.saveEntries(db, v.id, [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeRoot, amount: '1.00' }])
    ).toThrow(/叶子/);
  });
  it('重复组合被拒绝', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const v = budget.createVersion(db, { year: 2026, name: 'V' });
    expect(() =>
      budget.saveEntries(db, v.id, [
        { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '1.00' },
        { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '2.00' },
      ])
    ).toThrow(/重复/);
  });
  it('结构调整后版本仍按绑定快照校验(历史口径不变)', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const v = standardBudgetVersion(fx); // 绑定当前树
    // 之后给无数据的叶子科目新增子科目(树结构变化,版本快照不变)
    account.createAccount(db, { parentId: fx.accIds.expenseOther, code: 'E0301X', name: '后来新增', type: 'expense' });
    // 版本矩阵中 expenseOther 仍是叶子(快照口径)
    const matrix = budget.getEditMatrix(db, v.id);
    expect(matrix.leafAccountIds).toContain(fx.accIds.expenseOther);
    // 保存仍允许写 expenseOther(按版本快照校验)
    expect(() =>
      budget.saveEntries(db, v.id, [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.expenseOther, amount: '1.00' }])
    ).not.toThrow();
  });
});

describe('实际数快照同日替代(方案四.8)', () => {
  it('同日重保存生成新修订并替代旧快照', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const r1 = actual.saveActual(db, {
      year: 2026, snapshotDate: '2026-03-31', source: 'manual', mode: 'replace',
      entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '100.00' }],
    });
    const r2 = actual.saveActual(db, {
      year: 2026, snapshotDate: '2026-03-31', source: 'manual', mode: 'replace',
      entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '120.00' }],
    });
    expect(r2.batchId).not.toBe(r1.batchId);
    const batches = actual.listBatches(db, 2026).filter((b) => b.snapshot_date === '2026-03-31');
    expect(batches.length).toBe(2);
    expect(batches.filter((b) => b.status === 'active').length).toBe(1);
    const superseded = batches.find((b) => b.status === 'superseded')!;
    expect(superseded.revision).toBe(1);
    const active = batches.find((b) => b.status === 'active')!;
    expect(active.revision).toBe(2);
  });
  it('正常更新日期不能倒退', () => {
    const db = testDb();
    const fx = buildFixture(db);
    actual.saveActual(db, {
      year: 2026, snapshotDate: '2026-06-30', source: 'manual', mode: 'replace',
      entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '10.00' }],
    });
    expect(() =>
      actual.saveActual(db, {
        year: 2026, snapshotDate: '2026-03-31', source: 'manual', mode: 'replace',
        entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '5.00' }],
      })
    ).toThrow(/早于当前最新截止日期/);
  });
  it('历史补录不更新当前实际', () => {
    const db = testDb();
    const fx = buildFixture(db);
    actual.saveActual(db, {
      year: 2026, snapshotDate: '2026-06-30', source: 'manual', mode: 'replace',
      entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '100.00' }],
    });
    const before = db.prepare('SELECT * FROM actual_current WHERE year = 2026').all();
    const r = actual.saveActual(db, {
      year: 2026, snapshotDate: '2026-01-31', source: 'manual', mode: 'upsert',
      history: true,
      entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '40.00' }],
    });
    const after = db.prepare('SELECT * FROM actual_current WHERE year = 2026').all();
    expect(after).toEqual(before); // 当前实际未被覆盖
    const batch = actual.getBatch(db, r.batchId);
    expect(batch.source).toBe('history_import');
    expect(batch.updates_current).toBe(0);
    const ents = actual.getBatchEntries(db, r.batchId);
    expect(ents.length).toBe(1);
    expect(ents[0].amountCents).toBe(4000);
    // 年度当前快照仍指向 6-30 批次
    const state = actual.getYearState(db, 2026);
    const currentBatch = actual.getBatch(db, state!.current_batch_id!);
    expect(currentBatch.snapshot_date).toBe('2026-06-30');
  });
  it('截止日期必须属于年度', () => {
    const db = testDb();
    const fx = buildFixture(db);
    expect(() =>
      actual.saveActual(db, {
        year: 2026, snapshotDate: '2025-12-31', source: 'manual', mode: 'replace',
        entries: [],
      })
    ).toThrow(/属于所选年度/);
  });
  it('停用节点的存量行允许继续修改,但不接受新增引用', () => {
    const db = testDb();
    const fx = buildFixture(db);
    actual.saveActual(db, {
      year: 2026, snapshotDate: '2026-06-30', source: 'manual', mode: 'replace',
      entries: [{ orgId: fx.orgIds.nanjing, accountId: fx.accIds.incomeMain, amount: '10.00' }],
    });
    org.setOrgStatus(db, fx.orgIds.nanjing, 'inactive');
    // 存量行修改 OK
    expect(() =>
      actual.saveActual(db, {
        year: 2026, snapshotDate: '2026-06-30', source: 'manual', mode: 'replace',
        entries: [{ orgId: fx.orgIds.nanjing, accountId: fx.accIds.incomeMain, amount: '12.00' }],
      })
    ).not.toThrow();
    // 新增引用被拒
    expect(() =>
      actual.saveActual(db, {
        year: 2026, snapshotDate: '2026-06-30', source: 'manual', mode: 'upsert',
        entries: [{ orgId: fx.orgIds.nanjing, accountId: fx.accIds.expenseAdmin, amount: '1.00' }],
      })
    ).toThrow(/已停用/);
  });
});
