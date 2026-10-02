/**
 * 后端单元测试(现行 specs/ai.md 页面上下文契约§13.2)。
 *
 * 覆盖:
 * - 页面快照 schema、字段白名单和大小限制;
 * - 年度、版本、快照和树关系校验;
 * - focus / selection / surface 与页面 scope 的归属和优先级;
 * - 28 个 pageKey 能力映射与未允许领域能力拒绝;
 * - verification fact 忽略客户端 label/level/details;
 * - 草稿基线校验(DRAFT_STALE)、草稿不进入 preview。
 */
import { describe, expect, it } from 'vitest';
import { CONTEXT_MAX_BYTES, DRAFT_MAX_CHANGES } from '../src/contracts/assistant';
import { parseAssistantPageContext, resolveAssistantContext, buildContextSummary, detectOverrides } from '../src/assistant/page-context';
import { normalizeDraftInput, computeDraftImpact, draftSummary } from '../src/assistant/draft-context';
import { pageDefinition, PAGE_IDS } from '../src/contracts/page-catalog';
import { filterIntentsByCapability } from '../src/assistant/page-capabilities';
import { AppError } from '../src/core/errors';
import { buildFixture, standardBudgetVersion, saveActualSnapshot, testDb, budget, type Fixture } from './helpers';


/** standardBudgetVersion 录数后 revision 已递增,重新读取拿到当前基线。 */
function freshVersion(fx: Fixture, id: number) {
  return budget.getVersion(fx.db, id);
}

function baseContext(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    schemaVersion: 2,
    snapshotId: 'snap-test-1',
    pageKey: 'analysis',
    routeInstanceId: 'route-1',
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

function expectError(fn: () => unknown, code: string): AppError {
  try {
    fn();
  } catch (err) {
    expect(err).toBeInstanceOf(AppError);
    expect((err as AppError).code).toBe(code);
    return err as AppError;
  }
  throw new Error(`预期抛出 ${code}，实际未抛出`);
}

describe('parseAssistantPageContext · schema 与白名单', () => {
  it('null/undefined 明确拒绝', () => {
    expectError(() => parseAssistantPageContext(null), 'CONTEXT_INVALID');
    expectError(() => parseAssistantPageContext(undefined), 'CONTEXT_INVALID');
  });

  it('schemaVersion 非 2 报 CONTEXT_PROTOCOL_UNSUPPORTED', () => {
    expectError(() => parseAssistantPageContext(baseContext({ schemaVersion: 1 })), 'CONTEXT_PROTOCOL_UNSUPPORTED');
  });

  it('未知 pageKey 报 CONTEXT_INVALID 且不回退 dashboard', () => {
    const err = expectError(() => parseAssistantPageContext(baseContext({ pageKey: 'dashboard_x' })), 'CONTEXT_INVALID');
    expect(err.message).toContain('未知页面');
  });

  it('scope 白名单外字段被拒绝', () => {
    expectError(() => parseAssistantPageContext(baseContext({ scope: { hackerField: 1 } })), 'CONTEXT_INVALID');
  });

  it('view 白名单外字段被拒绝', () => {
    expectError(() => parseAssistantPageContext(baseContext({ view: { secretToken: 'abc' } })), 'CONTEXT_INVALID');
  });

  it('上下文超过 64KiB 报 CONTEXT_TOO_LARGE', () => {
    const big = 'x'.repeat(CONTEXT_MAX_BYTES);
    expectError(() => parseAssistantPageContext(baseContext({ view: { keyword: big } })), 'CONTEXT_TOO_LARGE');
  });

  it('草稿变更超过 10000 项报 CONTEXT_TOO_LARGE', () => {
    const changes = Array.from({ length: DRAFT_MAX_CHANGES + 1 }, (_, i) => ({ orgId: 1, accountId: 2, amount: `${i}.00` }));
    expectError(() => parseAssistantPageContext(baseContext({
      pageKey: 'budget_edit',
      draft: { kind: 'budget_grid', base: { versionId: 1 }, changes },
    })), 'CONTEXT_TOO_LARGE');
  });

  it('页面不接受的草稿类型报 CONTEXT_INVALID', () => {
    // analysis 页不接受 budget_grid 草稿(只有 budget_edit 接受)
    expectError(() => parseAssistantPageContext(baseContext({
      draft: { kind: 'budget_grid', base: { versionId: 1 }, changes: [] },
    })), 'CONTEXT_INVALID');
  });

  it('selection refs 超过 500 报 CONTEXT_TOO_LARGE', () => {
    const refs = Array.from({ length: 501 }, (_, i) => ({ entityType: 'metric', id: i + 1 }));
    expectError(() => parseAssistantPageContext(baseContext({
      pageKey: 'metric', selection: { mode: 'refs', refs },
    })), 'CONTEXT_TOO_LARGE');
  });

  it('28 个 pageKey 都能通过 parseAssistantPageContext', () => {
    for (const pageKey of PAGE_IDS) {
      const parsed = parseAssistantPageContext(baseContext({ pageKey }));
      expect(parsed?.pageKey).toBe(pageKey);
    }
  });
});

describe('resolveAssistantContext · 资源与关系校验', () => {
  let fx: Fixture;
  let versionId: number;

  function setup() {
    fx = buildFixture(testDb());
    versionId = standardBudgetVersion(fx).id;
  }

  it('不存在的版本 ID 报 CONTEXT_INVALID', () => {
    setup();
    expectError(() => resolveAssistantContext(fx.db, baseContext({ scope: { budgetVersionId: 99999 } })), 'CONTEXT_INVALID');
  });

  it('页面年度与版本年度冲突报 CONTEXT_CONFLICT', () => {
    setup();
    expectError(() => resolveAssistantContext(fx.db, baseContext({ scope: { year: 2025, budgetVersionId: versionId } })), 'CONTEXT_CONFLICT');
  });

  it('年度与版本一致时正常解析', () => {
    setup();
    const resolved = resolveAssistantContext(fx.db, baseContext({ scope: { year: 2026, budgetVersionId: versionId } }));
    expect(resolved?.scope.budgetVersionId).toBe(versionId);
    expect(resolved?.scope.year).toBe(2026);
  });

  it('不存在的实际快照报 CONTEXT_INVALID', () => {
    setup();
    expectError(() => resolveAssistantContext(fx.db, baseContext({ scope: { actualSnapshotId: 424242 } })), 'CONTEXT_INVALID');
  });

  it('组织不在版本绑定树快照中报 CONTEXT_CONFLICT', () => {
    setup();
    // 版本快照绑定的是建版本时刻的树；新建一个版本外的组织
    const outside = fx.db.prepare("INSERT INTO org(parent_id, code, name, status, created_at, updated_at) VALUES(NULL,'OUT','外部','active','2026-01-01','2026-01-01')").run();
    const outsideId = Number(outside.lastInsertRowid);
    expectError(() => resolveAssistantContext(fx.db, baseContext({
      scope: { budgetVersionId: versionId, orgScopeId: outsideId },
    })), 'CONTEXT_CONFLICT');
  });

  it('组织在版本树快照内时正常解析', () => {
    setup();
    const resolved = resolveAssistantContext(fx.db, baseContext({
      scope: { budgetVersionId: versionId, orgScopeId: fx.orgIds.shanghai },
    }));
    expect(resolved?.scope.orgScopeId).toBe(fx.orgIds.shanghai);
  });

  it('focus 指向其他版本的单元格报 CONTEXT_STALE', () => {
    setup();
    const other = standardBudgetVersion(fx, 2027, 'V-next');
    expectError(() => resolveAssistantContext(fx.db, baseContext({
      pageKey: 'budget_edit',
      scope: { budgetVersionId: versionId },
      focus: { kind: 'cell', source: 'budget', sourceId: other.id, orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain },
    })), 'CONTEXT_STALE');
  });

  it('cell 焦点把 org/account 并入 scope(§6 focus > scope)', () => {
    setup();
    const resolved = resolveAssistantContext(fx.db, baseContext({
      pageKey: 'budget_edit',
      scope: { budgetVersionId: versionId },
      focus: { kind: 'cell', source: 'budget', sourceId: versionId, orgId: fx.orgIds.shanghai, accountId: fx.accIds.costSub },
    }));
    expect(resolved?.scope.orgScopeId).toBe(fx.orgIds.shanghai);
    expect(resolved?.scope.accountScopeId).toBe(fx.accIds.costSub);
  });

  it('surface 实体覆盖 focus 与页面 scope(§6 surface 最优先)', () => {
    setup();
    const resolved = resolveAssistantContext(fx.db, baseContext({
      scope: { budgetVersionId: versionId, orgScopeId: fx.orgIds.shanghai },
      focus: { kind: 'entity', entityType: 'account', id: fx.accIds.incomeMain },
      surfaces: [{ id: 's1', kind: 'drawer', key: 'evidence_detail', entity: { entityType: 'account', id: fx.accIds.costSub } }],
    }));
    expect(resolved?.scope.accountScopeId).toBe(fx.accIds.costSub);
  });

  it('surface 引用的实体不存在时报 CONTEXT_INVALID', () => {
    setup();
    expectError(() => resolveAssistantContext(fx.db, baseContext({
      surfaces: [{ id: 's1', kind: 'drawer', key: 'evidence_detail', entity: { entityType: 'account', id: 999999 } }],
    })), 'CONTEXT_INVALID');
  });

  it('selection refs 中的实体不存在时报 CONTEXT_INVALID', () => {
    setup();
    expectError(() => resolveAssistantContext(fx.db, baseContext({
      pageKey: 'metric', selection: { mode: 'refs', refs: [{ entityType: 'metric', id: 888888 }] },
    })), 'CONTEXT_INVALID');
  });

  it('chart_point 焦点的 metric 并入 extras', () => {
    setup();
    const resolved = resolveAssistantContext(fx.db, baseContext({
      pageKey: 'metric_trend',
      scope: {},
      focus: { kind: 'chart_point', seriesKey: 'metric_trend', dimensionType: 'metric', dimensionId: fx.metricIds.gross },
    }));
    expect(resolved?.extras.metricId).toBe(fx.metricIds.gross);
  });

  it('chart_point 的日期期间覆盖年度、截至日期与对应快照', () => {
    setup();
    const batchId = saveActualSnapshot(fx, 2025, '2025-03-31', [
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '12.00' },
    ]).batchId;
    const resolved = resolveAssistantContext(fx.db, baseContext({
      scope: { year: 2026 },
      focus: { kind: 'chart_point', seriesKey: 'trend', dimensionType: 'period', period: '2025-03-31' },
    }));
    expect(resolved?.scope.year).toBe(2025);
    expect(resolved?.scope.actualSnapshotId).toBe(batchId);
    expect(resolved?.extras.asOfDate).toBe('2025-03-31');
  });

  it('chart_point 的年度期间覆盖页面年度', () => {
    setup();
    const resolved = resolveAssistantContext(fx.db, baseContext({
      pageKey: 'history',
      scope: { year: 2026 },
      focus: { kind: 'chart_point', seriesKey: 'history_year', dimensionType: 'period', period: '2025' },
    }));
    expect(resolved?.scope.year).toBe(2025);
  });

  it('版本对比 scope 映射到既有 budgetVersionId/targetVersionId 且必须同年度', () => {
    setup();
    const base = standardBudgetVersion(fx, 2026, '基准');
    const compare = budget.createVersion(fx.db, { year: 2026, name: '目标' });
    const resolved = resolveAssistantContext(fx.db, baseContext({
      pageKey: 'version_compare',
      scope: { baseVersionId: base.id, compareVersionId: compare.id },
    }));
    expect(resolved?.scope.budgetVersionId).toBe(base.id);
    expect(resolved?.scope.targetVersionId).toBe(compare.id);

    const otherYear = budget.createVersion(fx.db, { year: 2025, name: '跨年目标' });
    expectError(() => resolveAssistantContext(fx.db, baseContext({
      pageKey: 'version_compare',
      scope: { baseVersionId: base.id, compareVersionId: otherYear.id },
    })), 'CONTEXT_CONFLICT');
  });

  it('periodStart 晚于 periodEnd 报 CONTEXT_CONFLICT', () => {
    setup();
    expectError(() => resolveAssistantContext(fx.db, baseContext({
      scope: { periodStart: '2026-06-01', periodEnd: '2026-01-01' },
    })), 'CONTEXT_CONFLICT');
  });
});

describe('领域能力调度', () => {
  it('28 个 pageKey 均有能力映射', () => {
    expect(PAGE_IDS.length).toBe(50);
    for (const key of PAGE_IDS) {
      const page = pageDefinition(key);
      expect(page, key).not.toBeNull();
      expect(page!.capabilities.length).toBeGreaterThan(0);
    }
  });

  it('未允许领域能力的意图被拒绝(filterIntentsByCapability)', () => {
    // logs 页只有 operations 能力,不允许 execution 意图
    const page = pageDefinition('logs')!;
    const [allowed, denied] = filterIntentsByCapability(page, ['execution', 'operation_log']);
    expect(allowed).toEqual(['operation_log']);
    expect(denied).toEqual(['execution']);
  });

  it('主数据页不允许写类能力', () => {
    const page = pageDefinition('org')!;
    expect(page.capabilities).toContain('master_data');
    expect(page.capabilities).not.toContain('execution');
  });
});

describe('buildContextSummary / detectOverrides', () => {
  it('摘要使用后端核验的名称,不回显客户端文案', () => {
    const fx = buildFixture(testDb());
    const versionId = standardBudgetVersion(fx).id;
    const summary = buildContextSummary(
      fx.db,
      '年度执行分析',
      { pageKey: 'analysis', year: 2026, budgetVersionId: versionId, orgScopeId: fx.orgIds.shanghai },
      {},
      {},
    );
    expect(summary).toContain('年度执行分析');
    expect(summary).toContain('2026 年');
    expect(summary).toContain('V1');
    expect(summary).toContain('上海公司');
  });

  it('问题明确指定的范围与页面不同 → 产生 override 记录', () => {
    const overrides = detectOverrides(
      { pageKey: 'analysis', year: 2026 },
      [{ field: 'year', value: 2025, origin: 'message', reason: '问题指定 2025 年' }],
    );
    expect(overrides).toHaveLength(1);
    expect(overrides[0]).toMatchObject({ field: 'year', from: 2026, to: 2025 });
  });

  it('问题值与页面一致时不产生 override', () => {
    const overrides = detectOverrides(
      { pageKey: 'analysis', year: 2026 },
      [{ field: 'year', value: 2026, origin: 'message', reason: '问题重述 2026 年' }],
    );
    expect(overrides).toHaveLength(0);
  });

  it('会话继承补齐(origin=conversation)不算 override', () => {
    const overrides = detectOverrides(
      { pageKey: 'analysis', year: 2026 },
      [{ field: 'budgetVersionId', value: 3, origin: 'conversation', reason: '沿用上一轮' }],
    );
    expect(overrides).toHaveLength(0);
  });
});

describe('草稿解析与基线(§9.6)', () => {
  it('预算草稿基线 revision 不一致报 DRAFT_STALE', () => {
    const fx = buildFixture(testDb());
    const created = standardBudgetVersion(fx);
    const version = freshVersion(fx, created.id);
    const draft = {
      kind: 'budget_grid' as const,
      base: {
        versionId: version.id,
        revision: version.revision + 1, // 过期基线
        orgTreeSnapshotId: version.org_tree_snapshot_id,
        accountTreeSnapshotId: version.account_tree_snapshot_id,
      },
      changes: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '120.00' }],
    };
    expectError(() => normalizeDraftInput(fx.db, draft), 'DRAFT_STALE');
  });

  it('预算草稿基线一致时通过校验并给出摘要', () => {
    const fx = buildFixture(testDb());
    const created = standardBudgetVersion(fx);
    const version = freshVersion(fx, created.id);
    const draft = {
      kind: 'budget_grid' as const,
      base: {
        versionId: version.id,
        revision: version.revision,
        orgTreeSnapshotId: version.org_tree_snapshot_id,
        accountTreeSnapshotId: version.account_tree_snapshot_id,
      },
      changes: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '120.00' }],
    };
    const normalized = normalizeDraftInput(fx.db, draft);
    expect(normalized.changeCount).toBe(1);
    const summary = draftSummary(normalized);
    // 摘要含可审计基线与数量,但不含草稿单元格原值。
    expect(summary).toEqual({
      kind: 'budget_grid',
      baseline: `版本 #${version.id}「${version.name}」· 修订 ${version.revision}`,
      changeCount: 1,
      issueCount: 0,
    });
    expect(JSON.stringify(summary)).not.toContain('120');
  });

  it('草稿影响 = 基线 + 本轮 changes 的重算结果', () => {
    const fx = buildFixture(testDb());
    const created = standardBudgetVersion(fx);
    const version = freshVersion(fx, created.id);
    const draft = {
      kind: 'budget_grid' as const,
      base: {
        versionId: version.id,
        revision: version.revision,
        orgTreeSnapshotId: version.org_tree_snapshot_id,
        accountTreeSnapshotId: version.account_tree_snapshot_id,
      },
      // 上海主营收入 100 → 120(+20 万)
      changes: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '120.00' }],
    };
    const normalized = normalizeDraftInput(fx.db, draft);
    const impact = computeDraftImpact(fx.db, normalized);
    expect(impact).not.toBeNull();
    expect(impact!.changeCount).toBe(1);
    const cell = impact!.changedCells.find((c) => c.orgId === fx.orgIds.shanghai && c.accountId === fx.accIds.incomeMain);
    expect(cell?.beforeCents).toBe(100_00);
    expect(cell?.afterCents).toBe(120_00);
    expect(cell?.deltaCents).toBe(20_00);
    // 收入符号 +1:总差异为 +20 万(利润方向)
    expect(impact!.totalDeltaCents).toBe(20_00);
    // 父级科目也受影响(收入根 I 的合计 +20 万)
    const parentDelta = impact!.accountDeltas.find((d) => d.accountId === fx.accIds.incomeRoot);
    expect(parentDelta?.deltaCents).toBe(20_00);
  });

  it('成本类草稿减少为利润方向正差异', () => {
    const fx = buildFixture(testDb());
    const created = standardBudgetVersion(fx);
    const version = freshVersion(fx, created.id);
    const draft = {
      kind: 'budget_grid' as const,
      base: {
        versionId: version.id,
        revision: version.revision,
        orgTreeSnapshotId: version.org_tree_snapshot_id,
        accountTreeSnapshotId: version.account_tree_snapshot_id,
      },
      // 上海材料成本 60 → 50(成本减少 10 万 = 利润方向 +10 万)
      changes: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.costSub, amount: '50.00' }],
    };
    const impact = computeDraftImpact(fx.db, normalizeDraftInput(fx.db, draft));
    expect(impact!.totalDeltaCents).toBe(10_00);
  });

  it('非叶子科目的预算变更被拒绝(CONTEXT_INVALID)', () => {
    const fx = buildFixture(testDb());
    const created = standardBudgetVersion(fx);
    const version = freshVersion(fx, created.id);
    const draft = {
      kind: 'budget_grid' as const,
      base: {
        versionId: version.id,
        revision: version.revision,
        orgTreeSnapshotId: version.org_tree_snapshot_id,
        accountTreeSnapshotId: version.account_tree_snapshot_id,
      },
      changes: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.costMain, amount: '70.00' }],
    };
    expectError(() => normalizeDraftInput(fx.db, draft), 'CONTEXT_INVALID');
  });
});
