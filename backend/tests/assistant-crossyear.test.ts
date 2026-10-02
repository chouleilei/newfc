import { pageSnapshot } from './assistant-context';
/**
 * 跨年提问回归测试(审查 Blocker 修复)。
 *
 * 修复前的三条可达路径都以 400 VALIDATION_FAILED 裸错误把聊天问挂,或更糟——
 * 残留 targetVersionId 造成静默跨年对比:
 *   A. 页面(2026)选着版本,问题点名另一年度(2025)的版本 → 版本覆盖后
 *      targetVersionId/actualSnapshotId 残留跨年冲突 → 400;
 *   B. 页面(2026)选着快照,问题只写裸月份(「3月的完成情况」) → matchSnapshot
 *      不按年度过滤,命中最新年度(2025)的 3 月快照 → 400;
 *   C. 请求直接同时传 year=2026 与 2025 年快照 → validateContextConsistency
 *      抛裸 VALIDATION_FAILED(现在改为 CONTEXT_CONFLICT 409)。
 *
 * 修复后:
 *   - 版本覆盖分支同步清理跨年 targetVersionId/actualSnapshotId(对齐 364-379 既有模式);
 *   - 裸月份只在页面年度内匹配快照,显式日期/编号/「最新快照」才允许跨年;
 *   - validateContextConsistency 补 targetVersionId 检查,错误码统一为 CONTEXT_CONFLICT。
 */
import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { applyMigrations } from '../src/db/migrations';
import * as assistant from '../src/assistant/service';
import { buildFixture, standardBudgetVersion, saveActualSnapshot, budget, actual } from './helpers';
import type { DB } from '../src/db/connection';

function makeDb() {
  const db = new Database(':memory:');
  applyMigrations(db as unknown as DB);
  return db as unknown as DB;
}

function v2Context(overrides: Record<string, unknown> = {}) {
  return {
    schemaVersion: 2,
    snapshotId: `snap-${Math.random().toString(36).slice(2, 10)}`,
    pageKey: 'analysis',
    routeInstanceId: 'route-it-1',
    contextVersion: 1,
    scope: {},
    view: {},
    surfaces: [],
    focus: null,
    selection: null,
    draft: null,
    ...overrides,
  };
}

/** 2026 年页面 + 2025 年历史数据(2025-03-31 快照比 2026 的更新日期更早、但按 snapshot_date 排序靠后)。 */
function fixtureWithCrossYear() {
  const db = makeDb();
  const fx = buildFixture(db);
  const v2026 = standardBudgetVersion(fx, 2026, 'V1');
  budget.lockVersion(db, v2026.id);
  budget.setCurrentVersion(db, v2026.id);
  const v2025 = budget.createVersion(db, { year: 2025, name: '2025正式' });
  budget.saveEntries(db, v2025.id, [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '80.00' }]);
  budget.lockVersion(db, v2025.id);
  const b2026 = saveActualSnapshot(fx, 2026, '2026-06-30', [
    { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '40.00' },
    { orgId: fx.orgIds.shanghai, accountId: fx.accIds.costSub, amount: '35.00' },
  ]).batchId;
  const b2025 = saveActualSnapshot(fx, 2025, '2025-03-31', [
    { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '12.00' },
  ]).batchId;
  return { db, fx, v2026, v2025, b2026, b2025 };
}

describe('跨年提问不再把聊天问挂(审查 Blocker 回归)', () => {
  it('路径A:问题点名另一年度版本时,清掉跨年对比版本与快照,而不是 400', async () => {
    const { db, fx, v2026, v2025, b2026 } = fixtureWithCrossYear();
    // 页面:2026 年 + V1 + 2026-06-30 快照;目标对比版本是 2026 的另一个版本
    const v2026b = budget.createVersion(db, { year: 2026, name: 'V2-追赶' });
    const answer: any = await assistant.chat(db, { message: '2025正式 这个版本的执行情况怎么样', pageContext: v2Context({ scope: { year: 2026, budgetVersionId: v2026.id, targetVersionId: v2026b.id, actualSnapshotId: b2026 } }) });
    expect(answer.ok).not.toBe(false);
    expect(answer.effectiveContext.budgetVersionId).toBe(v2025.id);
    expect(answer.effectiveContext.year).toBe(2025);
    // 跨年的对比版本与快照必须被清理,validateContextConsistency 不应再报冲突
    expect(answer.effectiveContext.targetVersionId).toBeUndefined();
    expect(answer.effectiveContext.actualSnapshotId).toBeUndefined();
    expect(fx.orgIds.shanghai).toBeGreaterThan(0);
    db.close();
  });

  it('路径B:裸月份只在本年度快照内匹配,不跨年命中前年快照', async () => {
    const { db, v2026, b2026 } = fixtureWithCrossYear();
    // 2026 年只有 6-30 快照;问「3月的完成情况」时 2025-03-31 不该被跨年命中
    const answer: any = await assistant.chat(db, { message: '3月的完成情况怎么样', pageContext: v2Context({ scope: { year: 2026, budgetVersionId: v2026.id, actualSnapshotId: b2026 } }) });
    expect(answer.ok).not.toBe(false);
    // 快照保持页面已选的 2026-06-30(3 月之前没有 2026 快照时不动页面值),年度仍是 2026
    expect(answer.effectiveContext.year).toBe(2026);
    expect(answer.effectiveContext.actualSnapshotId).toBe(b2026);
    db.close();
  });

  it('路径B2:显式日期允许跨年,年度、快照与预算基线一起切换', async () => {
    const { db, v2026, v2025, b2025, b2026 } = fixtureWithCrossYear();
    const answer: any = await assistant.chat(db, { message: '看看 2025-03-31 快照的完成情况', pageContext: v2Context({ scope: { year: 2026, budgetVersionId: v2026.id, actualSnapshotId: b2026 } }) });
    expect(answer.ok).not.toBe(false);
    expect(answer.effectiveContext.actualSnapshotId).toBe(b2025);
    // 快照跨年后,页面的跨年预算版本必须替换为快照年度的确定性默认版本。
    expect(answer.effectiveContext.year).toBe(2025);
    expect(answer.effectiveContext.budgetVersionId).toBe(v2025.id);
    expect(answer.contextStatus).toBe('explicit_override');
    db.close();
  });

  it('路径C:请求自带矛盾年度与快照时报 CONTEXT_CONFLICT(409)而非裸 VALIDATION_FAILED(400)', async () => {
    const { db, b2025 } = fixtureWithCrossYear();
    await expect(assistant.chat(db, { message: '执行情况怎么样', pageContext: pageSnapshot({ year: 2026, actualSnapshotId: b2025 }) })).rejects.toMatchObject({ code: 'CONTEXT_CONFLICT', status: 409 });
    db.close();
  });

  it('targetVersionId 与 year 跨年矛盾同样被 CONTEXT_CONFLICT 拦下(不再静默跨年对比)', async () => {
    const { db, fx, v2026, v2025 } = fixtureWithCrossYear();
    void fx;
    // 修复前这里会静默返回「2025 预算 vs 2026 对比版本」的错误口径
    await expect(assistant.chat(db, { message: '执行情况怎么样', pageContext: pageSnapshot({ year: 2025, budgetVersionId: v2025.id, targetVersionId: v2026.id }) })).rejects.toMatchObject({ code: 'CONTEXT_CONFLICT', status: 409 });
    db.close();
  });
});
