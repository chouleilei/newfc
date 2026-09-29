/**
 * 多年趋势同口径对比(AI 功能增强计划 §四.阶段五,确定性原语)验收:
 * - N 年泛化:历史年取与基准年同期(±7 天)的 active 快照,超窗如实跳过;
 * - 跨年按编码对齐,可与各年冻结快照对账;
 * - 可比性声明:编码新增/消失、不可比窗口均有测试;
 * - 组织过滤按年求值:去年有、今年没有的组织如实声明,不静默丢弃;
 * - 维度下探:科目维度(展示口径)与组织维度(利润方向)逐年值与同比。
 */
import { describe, expect, it } from 'vitest';
import { testDb, buildFixture, saveActualSnapshot } from './helpers';
import { freezeYear } from '../src/modules/report/report.service';
import { multiYearTrend, samePeriodBatch, yearCaliberData } from '../src/modules/report/multi-year';
import * as actual from '../src/modules/actual/actual.service';
import { listBatches } from '../src/modules/actual/actual.service';

function setupThreeYears(db: ReturnType<typeof testDb>) {
  const fx = buildFixture(db);
  // 2024:6-30 快照(收入 SH 80 / HZ 40,成本 SH 50)
  saveActualSnapshot(fx, 2024, '2024-06-30', [
    { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '80.00' },
    { orgId: fx.orgIds.hangzhou, accountId: fx.accIds.incomeMain, amount: '40.00' },
    { orgId: fx.orgIds.shanghai, accountId: fx.accIds.costSub, amount: '50.00' },
  ]);
  // 2025:6-28 同期快照(收入 SH 100 / HZ 50,成本 SH 60)并关闭
  const b25 = saveActualSnapshot(fx, 2025, '2025-06-28', [
    { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '100.00' },
    { orgId: fx.orgIds.hangzhou, accountId: fx.accIds.incomeMain, amount: '50.00' },
    { orgId: fx.orgIds.shanghai, accountId: fx.accIds.costSub, amount: '60.00' },
  ]);
  freezeYear(db, 2025, b25.batchId);
  // 2026 基准年:6-30 当前实际(收入 SH 120 / HZ 60 / NJ 30,成本 SH 70)
  saveActualSnapshot(fx, 2026, '2026-06-30', [
    { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '120.00' },
    { orgId: fx.orgIds.hangzhou, accountId: fx.accIds.incomeMain, amount: '60.00' },
    { orgId: fx.orgIds.nanjing, accountId: fx.accIds.incomeMain, amount: '30.00' },
    { orgId: fx.orgIds.shanghai, accountId: fx.accIds.costSub, amount: '70.00' },
  ]);
  return fx;
}

describe('阶段五:N 年同口径对比原语', () => {
  it('同期批次选择:±7 天内取最近,超窗如实跳过', () => {
    const db = testDb();
    const fx = buildFixture(db);
    // 快照日期递增约束:先 3-01 后 6-28
    saveActualSnapshot(fx, 2025, '2025-03-01', [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '10.00' }]);
    saveActualSnapshot(fx, 2025, '2025-06-28', [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '100.00' }]);
    // 目标 06-30:06-28 差 2 天,命中
    const hit = samePeriodBatch(db, 2025, '06-30');
    expect(hit.batchId).not.toBeNull();
    // 目标 12-31:最近 06-28 差 186 天,超窗跳过
    const skip = samePeriodBatch(db, 2025, '12-31');
    expect(skip.batchId).toBeNull();
    expect((skip as { reason: string }).reason).toContain('不可比');
    // 无快照年份
    const none = samePeriodBatch(db, 2023, '06-30');
    expect(none.batchId).toBeNull();
    expect((none as { reason: string }).reason).toContain('没有可用快照');
    db.close();
  });

  it('跨年数字按编码对齐并可与冻结快照对账;维度下探含同比', () => {
    const db = testDb();
    const fx = setupThreeYears(db);
    const result = multiYearTrend(db, { baseYear: 2026, depth: 3 });
    expect(result.years.map((point) => point.year)).toEqual([2024, 2025, 2026]);
    expect(result.years.every((point) => point.comparable)).toBe(true);
    // 2025 已关闭,应取最终快照(06-28 同期)
    expect(result.years.find((point) => point.year === 2025)!.asOfDate).toBe('2025-06-28');

    const income = result.accounts.find((row) => row.code === 'I01')!;
    expect(income.values[2024]).toBe(12_000); // (80+40) 元 -> 整数分
    expect(income.values[2025]).toBe(15_000);
    expect(income.values[2026]).toBe(21_000);
    expect(income.yoy[2025]).toBeCloseTo(0.25, 6);
    expect(income.yoy[2026]).toBeCloseTo(0.4, 6);
    // 成本展示口径为业务正数
    const cost = result.accounts.find((row) => row.code === 'C0101')!;
    expect(cost.values[2025]).toBe(6_000);

    // 组织维度:SH 利润方向(收入-成本),2025=40 元
    const sh = result.orgs.find((row) => row.code === 'SH')!;
    expect(sh.values[2025]).toBe(4_000);
    expect(sh.values[2026]).toBe(5_000);
    expect(sh.yoy[2026]).toBeCloseTo(0.25, 6);

    // 与冻结快照直接对账:2025 批次明细重算 = 趋势值
    const batchEntries = actual.getBatchEntries(db, actual.getBatch(db, result.years.find((point) => point.year === 2025)!.batchId!).id);
    const incomeTotal = batchEntries
      .filter((entry) => entry.accountId === fx.accIds.incomeMain)
      .reduce((total, entry) => total + entry.amountCents, 0);
    expect(incomeTotal).toBe(income.values[2025]);
    db.close();
  });

  it('可比性声明:编码新增(NJ 2026 出现)如实列出,消失编码不静默丢弃', () => {
    const db = testDb();
    const fx = setupThreeYears(db);
    const result = multiYearTrend(db, { baseYear: 2026, depth: 3 });
    // NJ 只在 2026 出现 -> 相对最早可比年 2024 为新增编码
    expect(result.comparability.addedOrgCodes).toContain('NJ');
    expect(result.comparability.matchedOrgCodes).toEqual(expect.arrayContaining(['SH', 'HZ']));
    expect(result.comparability.removedOrgCodes).toEqual([]);
    expect(result.orgs.find((row) => row.code === 'NJ')!.values[2026]).toBe(3_000);
    expect(result.orgs.find((row) => row.code === 'NJ')!.values[2025]).toBeUndefined();

    // 构造消失:2026 追加一条仅 2024 存在的科目编码(通过删除 2025/2026 的 E02 数据模拟 -> 改为手工验证 removed)
    const custom = multiYearTrend(db, { baseYear: 2026, depth: 3, orgCodes: ['SH', 'HZ'] });
    expect(custom.comparability.addedOrgCodes).not.toContain('NJ');
    expect(custom.orgs.find((row) => row.code === 'NJ')).toBeUndefined();
    db.close();
  });

  it('组织过滤按年求值:去年有今年没有的组织出现在 removed 而非被丢弃', () => {
    const db = testDb();
    const fx = buildFixture(db);
    // 2024 有 HZ,2025 没有 HZ(只有 SH),基准年 2025
    saveActualSnapshot(fx, 2024, '2024-06-30', [
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '80.00' },
      { orgId: fx.orgIds.hangzhou, accountId: fx.accIds.incomeMain, amount: '40.00' },
    ]);
    const b25 = saveActualSnapshot(fx, 2025, '2025-06-30', [
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '100.00' },
    ]);
    freezeYear(db, 2025, b25.batchId);
    const result = multiYearTrend(db, { baseYear: 2025, depth: 2 });
    // HZ 在 2024 有值、2025 无值:如实体现在行内(values 缺 2025),而不是整行消失
    const hz = result.orgs.find((row) => row.code === 'HZ');
    expect(hz).toBeDefined();
    expect(hz!.values[2024]).toBe(4_000);
    expect(hz!.values[2025]).toBeUndefined();
    expect(result.comparability.removedOrgCodes).toContain('HZ');
    db.close();
  });

  it('不可比窗口(无快照年份)在 years 中如实声明,不参与维度值', () => {
    const db = testDb();
    const fx = buildFixture(db);
    saveActualSnapshot(fx, 2026, '2026-06-30', [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '120.00' }]);
    const result = multiYearTrend(db, { baseYear: 2026, depth: 3 });
    const y2025 = result.years.find((point) => point.year === 2025)!;
    const y2024 = result.years.find((point) => point.year === 2024)!;
    expect(y2025.comparable).toBe(false);
    expect(y2025.reason).toContain('没有可用快照');
    expect(y2024.comparable).toBe(false);
    // 只有基准年参与维度行
    const income = result.accounts.find((row) => row.code === 'I01')!;
    expect(Object.keys(income.values)).toEqual(['2026']);
    db.close();
  });

  it('输入校验:baseYear/depth 边界', () => {
    const db = testDb();
    buildFixture(db);
    expect(() => multiYearTrend(db, { baseYear: 1999 })).toThrow(/baseYear/);
    expect(() => multiYearTrend(db, { baseYear: 2026, depth: 0 })).toThrow(/depth/);
    expect(() => multiYearTrend(db, { baseYear: 2026, depth: 11 })).toThrow(/depth/);
    db.close();
  });
});

describe('阶段五:趋势范围继承(orgScopeId / accountScopeId / baseBatchId)', () => {
  it('组织范围按子树解析成编码集合后跨年对齐,范围外组织不进结果', () => {
    const db = testDb();
    const fx = setupThreeYears(db);
    // 华东大区子树 = EAST/SH/HZ,不含 NJ
    const scoped = multiYearTrend(db, { baseYear: 2026, depth: 3, orgScopeId: fx.orgIds.east });
    expect(scoped.scope.orgScopeId).toBe(fx.orgIds.east);
    expect(scoped.scope.orgCodes).toEqual(['EAST', 'HZ', 'SH']);
    expect(scoped.orgs.map((row) => row.code).sort()).toEqual(['HZ', 'SH']);
    expect(scoped.comparability.addedOrgCodes).not.toContain('NJ');
    // 全量口径含 NJ,证明差异确实来自范围而不是数据缺失
    const full = multiYearTrend(db, { baseYear: 2026, depth: 3 });
    expect(full.orgs.map((row) => row.code)).toContain('NJ');
    // 单个叶子范围
    const leaf = multiYearTrend(db, { baseYear: 2026, depth: 3, orgScopeId: fx.orgIds.shanghai });
    expect(leaf.orgs.map((row) => row.code)).toEqual(['SH']);
    db.close();
  });

  it('科目范围按子树解析,收入子树不含成本科目', () => {
    const db = testDb();
    const fx = setupThreeYears(db);
    const scoped = multiYearTrend(db, { baseYear: 2026, depth: 3, accountScopeId: fx.accIds.incomeRoot });
    expect(scoped.scope.accountCodes).toEqual(['I', 'I01']);
    expect(scoped.accounts.map((row) => row.code)).toEqual(['I01']);
    // 组织维度合计随科目范围收敛:SH 只剩收入
    expect(scoped.orgs.find((row) => row.code === 'SH')!.values[2026]).toBe(12_000);
    db.close();
  });

  it('baseBatchId 固定基准年批次,同期窗口随之改变', () => {
    const db = testDb();
    const fx = buildFixture(db);
    saveActualSnapshot(fx, 2025, '2025-03-05', [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '10.00' }]);
    saveActualSnapshot(fx, 2026, '2026-03-01', [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '20.00' }]);
    const march = saveActualSnapshot(fx, 2026, '2026-12-31', [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '99.00' }]);
    // 默认取当前实际(最新 12-31):2025 只有 03-05,超窗跳过
    const latest = multiYearTrend(db, { baseYear: 2026, depth: 2 });
    expect(latest.years.find((point) => point.year === 2025)!.comparable).toBe(false);
    // 指定基准年 3 月批次:2025-03-05 落在 ±7 天窗口内,可比
    const batches = listBatches(db, 2026) as { id: number; snapshot_date: string }[];
    const marchBatch = batches.find((batch) => batch.snapshot_date === '2026-03-01')!;
    const pinned = multiYearTrend(db, { baseYear: 2026, depth: 2, baseBatchId: marchBatch.id });
    expect(pinned.scope.baseBatchId).toBe(marchBatch.id);
    expect(pinned.years.find((point) => point.year === 2025)!.comparable).toBe(true);
    expect(pinned.accounts.find((row) => row.code === 'I01')!.values[2026]).toBe(2_000);
    void march;
    db.close();
  });

  it('范围节点不在基准年绑定树中时明确报错,不静默退化为全量', () => {
    const db = testDb();
    const fx = setupThreeYears(db);
    expect(() => multiYearTrend(db, { baseYear: 2026, orgScopeId: 999_999 })).toThrow(/组织范围节点/);
    expect(() => multiYearTrend(db, { baseYear: 2026, accountScopeId: 999_999 })).toThrow(/科目范围节点/);
    void fx;
    db.close();
  });
});
