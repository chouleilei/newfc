import { describe, expect, it } from 'vitest';
import { testDb, buildFixture, standardBudgetVersion, budget, saveActualSnapshot } from './helpers';
import { dashboardOverview } from '../src/modules/report/dashboard.service';

/**
 * UX-24 首页「下一步」事实源(dashboardOverview.workState)的行为测试:
 * - recentDraft 只认草稿,取最近更新者;定稿/归档后不再出现;
 * - pendingAdoption 只陈述「有定稿但该年度该用途无当前采用」的事实,归档不计入;
 * - yearActuals 按年度聚合 active 快照的最大截止日,不含任何逾期推断。
 */
describe('首页工作台工作状态事实(UX-24)', () => {
  it('空库:无草稿、无待采用、无实际快照', () => {
    const db = testDb();
    const ws = dashboardOverview(db).workState;
    expect(ws.recentDraft).toBeNull();
    expect(ws.pendingAdoption).toEqual([]);
    expect(ws.yearActuals).toEqual([]);
    db.close();
  });

  it('recentDraft 取最近更新的草稿;全部定稿后返回 null', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const v1 = standardBudgetVersion(fx, 2026, 'V1');
    const v2 = budget.createVersion(db, { year: 2026, name: 'V2 草稿' });
    // 后建的 V2 updated_at 不早于 V1,并列时取 id 较大者
    expect(dashboardOverview(db).workState.recentDraft).toMatchObject({ id: v2.id, name: 'V2 草稿', kind: 'budget' });
    // 再次保存 V1 明细推进其 updated_at 后,recentDraft 应切换到 V1
    budget.saveEntries(db, v1.id, [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '120.00' }]);
    db.prepare("UPDATE budget_version SET updated_at = '2999-01-01 00:00:00' WHERE id = ?").run(v1.id);
    expect(dashboardOverview(db).workState.recentDraft).toMatchObject({ id: v1.id });
    // 两个版本都定稿后不再有待编制草稿
    budget.lockVersion(db, v1.id);
    budget.lockVersion(db, v2.id);
    expect(dashboardOverview(db).workState.recentDraft).toBeNull();
    db.close();
  });

  it('pendingAdoption:定稿未采用列出并给出最新定稿名;设为当前采用后消失', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const v1 = standardBudgetVersion(fx, 2026, 'V1');
    budget.lockVersion(db, v1.id);
    let gaps = dashboardOverview(db).workState.pendingAdoption;
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ year: 2026, kind: 'budget', lockedCount: 1, latestLockedName: 'V1' });
    // 同年度再定稿一版,仍未采用 → lockedCount 增加,最新定稿名跟进
    const v2 = standardBudgetVersion(fx, 2026, 'V2');
    budget.lockVersion(db, v2.id);
    gaps = dashboardOverview(db).workState.pendingAdoption;
    expect(gaps).toHaveLength(1);
    expect(gaps[0]).toMatchObject({ year: 2026, kind: 'budget', lockedCount: 2 });
    // 设为当前采用后缺口关闭
    budget.setCurrentVersion(db, v2.id);
    expect(dashboardOverview(db).workState.pendingAdoption).toEqual([]);
    db.close();
  });

  it('pendingAdoption:预算与预测各自独立;归档版本不计入定稿缺口', () => {
    const db = testDb();
    const fx = buildFixture(db);
    // 预测定稿未采用 → 仅预测出现缺口,不影响预算
    const forecast = budget.createVersion(db, { year: 2026, name: 'F1', kind: 'forecast' });
    budget.lockVersion(db, forecast.id);
    let gaps = dashboardOverview(db).workState.pendingAdoption;
    expect(gaps).toEqual([expect.objectContaining({ year: 2026, kind: 'forecast' })]);
    // 预算定稿后又归档(未采用):归档不算「可采用的定稿」,不产生预算缺口
    const v = standardBudgetVersion(fx, 2026, 'V1');
    budget.lockVersion(db, v.id);
    budget.archiveVersion(db, v.id);
    gaps = dashboardOverview(db).workState.pendingAdoption;
    expect(gaps).toEqual([expect.objectContaining({ year: 2026, kind: 'forecast' })]);
    db.close();
  });

  it('yearActuals:按年度聚合 active 快照的最大截止日与批次数', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const entries = [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '10.00' }];
    saveActualSnapshot(fx, 2026, '2026-06-30', entries);
    saveActualSnapshot(fx, 2026, '2026-08-31', entries);
    saveActualSnapshot(fx, 2025, '2025-12-31', entries);
    const rows = dashboardOverview(db).workState.yearActuals;
    expect(rows).toHaveLength(2);
    expect(rows[0]).toMatchObject({ year: 2026, latest_snapshot: '2026-08-31', batch_count: 2 });
    expect(rows[1]).toMatchObject({ year: 2025, latest_snapshot: '2025-12-31', batch_count: 1 });
    db.close();
  });
});
