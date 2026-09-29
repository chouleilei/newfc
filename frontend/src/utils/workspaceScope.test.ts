import { describe, expect, it } from 'vitest';
import {
  buildScopeSearch,
  isScopeRestorable,
  normalizeScopeSearch,
  parseWorkspaceScope,
  resolveActualMode,
  resolveEffectiveYear,
  resolveWorkspaceScope,
  validateScopeOwnership,
  type ScopeCatalog,
  type WorkspaceScope,
} from './workspaceScope';

const catalog: ScopeCatalog = {
  versions: [
    { id: 11, year: 2025 },
    { id: 12, year: 2026 },
    { id: 13, year: 2026, disabled: true },
  ],
  snapshotBatches: [
    { id: 21, year: 2025 },
    { id: 22, year: 2026 },
  ],
  orgs: [
    { id: 31 },
    { id: 32, disabled: true },
  ],
  accounts: [{ id: 41 }],
  sheetKeys: ['profit', 'all'],
};

describe('parseWorkspaceScope:URL 解析与格式检查', () => {
  it('解析 analysis 现行参数为业务字段', () => {
    const { scope, issues } = parseWorkspaceScope('analysis', '?year=2026&version=12&forecast=14&batch=22&org=31&account=41&sheet=profit&level=2&threshold=20');
    expect(issues).toEqual([]);
    expect(scope).toEqual({
      year: 2026,
      budgetVersionId: 12,
      targetVersionId: 14,
      actualSnapshotId: 22,
      orgScopeId: 31,
      accountScopeId: 41,
      sheet: 'profit',
      level: 2,
      threshold: 20,
    });
  });

  it('无参数时得到空范围且无问题', () => {
    const { scope, issues, adapted } = parseWorkspaceScope('analysis', '');
    expect(scope).toEqual({});
    expect(issues).toEqual([]);
    expect(adapted).toEqual([]);
  });

  it('非法 ID 给出明确失败原因且不进入范围', () => {
    for (const raw of ['abc', '0', '-3', '1.5', '1e5']) {
      const { scope, issues } = parseWorkspaceScope('analysis', `?version=${raw}`);
      expect(scope.budgetVersionId).toBeUndefined();
      expect(issues).toHaveLength(1);
      expect(issues[0]).toMatchObject({ key: 'version', field: 'budgetVersionId', raw, reason: 'invalid_format' });
      expect(issues[0].detail).toContain(raw);
    }
  });

  it('超出安全整数的编号被拒绝', () => {
    const { scope, issues } = parseWorkspaceScope('analysis', '?org=99999999999999999999');
    expect(scope.orgScopeId).toBeUndefined();
    expect(issues[0].reason).toBe('invalid_format');
  });

  it('非法年度与非所选年度格式的截止日被拒绝', () => {
    const bad = parseWorkspaceScope('actual', '?year=26');
    expect(bad.scope.year).toBeUndefined();
    expect(bad.issues[0].reason).toBe('invalid_format');

    for (const raw of ['2026-8-31', '2026-02-30', '2026/08/31', '20260831']) {
      const { scope, issues } = parseWorkspaceScope('actual', `?cutoff=${encodeURIComponent(raw)}`);
      expect(scope.cutoff).toBeUndefined();
      expect(issues[0]).toMatchObject({ field: 'cutoff', reason: 'invalid_format' });
    }
    const ok = parseWorkspaceScope('actual', '?cutoff=2026-08-31');
    expect(ok.scope.cutoff).toBe('2026-08-31');
    expect(ok.issues).toEqual([]);
  });

  it('view/mode 只接受枚举值', () => {
    const badView = parseWorkspaceScope('actual', '?view=weird');
    expect(badView.scope.view).toBeUndefined();
    expect(badView.issues[0]).toMatchObject({ field: 'view', reason: 'unknown_value' });

    const badMode = parseWorkspaceScope('actual', '?mode=past');
    expect(badMode.scope.mode).toBeUndefined();
    expect(badMode.issues[0]).toMatchObject({ field: 'mode', reason: 'unknown_value' });

    const good = parseWorkspaceScope('actual', '?view=years&mode=history');
    expect(good.scope).toMatchObject({ view: 'years', mode: 'history' });
  });

  it('路由不支持的参数被忽略,不产生问题', () => {
    const { scope, issues } = parseWorkspaceScope('dashboard', '?year=2025&version=12&foo=bar');
    expect(scope).toEqual({ year: 2025 });
    expect(issues).toEqual([]);
  });

  it('阈值必须在 0–100', () => {
    expect(parseWorkspaceScope('anomaly_center', '?threshold=120').issues[0].reason).toBe('out_of_range');
    expect(parseWorkspaceScope('anomaly_center', '?threshold=NaN').issues[0].reason).toBe('out_of_range');
    expect(parseWorkspaceScope('anomaly_center', '?threshold=0').scope.threshold).toBe(0);
  });
});

describe('parseWorkspaceScope:旧参数适配', () => {
  it('budget_edit 旧链接 org/account 映射为现行 orgId/accountId', () => {
    const { scope, issues, adapted } = parseWorkspaceScope('budget_edit', '?org=31&account=41&sheet=all');
    expect(issues).toEqual([]);
    expect(scope).toEqual({ orgScopeId: 31, accountScopeId: 41, sheet: 'all' });
    expect(adapted).toEqual([
      { from: 'org', to: 'orgId', value: '31' },
      { from: 'account', to: 'accountId', value: '41' },
    ]);
  });

  it('现行参数与旧参数同时存在时以现行参数为准', () => {
    const { scope, adapted } = parseWorkspaceScope('budget_edit', '?org=31&orgId=9');
    expect(scope.orgScopeId).toBe(9);
    expect(adapted).toEqual([]);
  });

  it('旧参数值非法时同样给出失败原因而不是沿用', () => {
    const { scope, issues } = parseWorkspaceScope('budget_edit', '?org=abc');
    expect(scope.orgScopeId).toBeUndefined();
    expect(issues[0]).toMatchObject({ key: 'orgId', field: 'orgScopeId', reason: 'invalid_format' });
  });

  it('analysis 既有书签参数原样有效', () => {
    const { scope, issues } = parseWorkspaceScope('analysis', '?year=2024&version=3&batch=7&org=2&account=9');
    expect(issues).toEqual([]);
    expect(scope).toMatchObject({ year: 2024, budgetVersionId: 3, actualSnapshotId: 7, orgScopeId: 2, accountScopeId: 9 });
  });
});

describe('validateScopeOwnership:范围归属校验', () => {
  it('合法范围无问题', () => {
    const scope: WorkspaceScope = { year: 2026, budgetVersionId: 12, actualSnapshotId: 22, orgScopeId: 31, accountScopeId: 41, sheet: 'profit', cutoff: '2026-08-31' };
    expect(validateScopeOwnership(scope, catalog)).toEqual([]);
  });

  it('不存在的版本/快照/组织/科目返回 not_found 且不被替换', () => {
    const scope: WorkspaceScope = { year: 2026, budgetVersionId: 99, actualSnapshotId: 99, orgScopeId: 99, accountScopeId: 99 };
    const issues = validateScopeOwnership(scope, catalog);
    expect(issues.map((item) => item.reason)).toEqual(['not_found', 'not_found', 'not_found', 'not_found']);
    expect(scope.budgetVersionId).toBe(99);
  });

  it('停用对象返回 inactive', () => {
    const issues = validateScopeOwnership({ budgetVersionId: 13, orgScopeId: 32 }, catalog);
    expect(issues.map((item) => item.reason)).toEqual(['inactive', 'inactive']);
  });

  it('跨年度快照与跨年度版本返回 scope_mismatch', () => {
    const issues = validateScopeOwnership({ year: 2026, budgetVersionId: 11, actualSnapshotId: 21 }, catalog);
    expect(issues).toHaveLength(2);
    expect(issues.every((item) => item.reason === 'scope_mismatch')).toBe(true);
    expect(issues[0].detail).toContain('2025');
    expect(issues[1].detail).toContain('2025');
  });

  it('截止日必须属于所选年度', () => {
    const issues = validateScopeOwnership({ year: 2026, cutoff: '2025-12-31' }, catalog);
    expect(issues[0]).toMatchObject({ field: 'cutoff', reason: 'out_of_range' });
  });

  it('未知科目表返回 not_found', () => {
    const issues = validateScopeOwnership({ sheet: 'ghost' }, catalog);
    expect(issues[0]).toMatchObject({ field: 'sheet', reason: 'not_found' });
  });

  it('目录未提供的集合不做判断', () => {
    const scope: WorkspaceScope = { budgetVersionId: 999, orgScopeId: 999 };
    expect(validateScopeOwnership(scope, {})).toEqual([]);
    expect(validateScopeOwnership(scope, { versions: catalog.versions })).toHaveLength(1);
  });
});

describe('resolveWorkspaceScope:来源优先级', () => {
  it('有效显式 URL > 最近使用 > 页面默认', () => {
    const parsed = parseWorkspaceScope('analysis', '?year=2026&version=12');
    const resolved = resolveWorkspaceScope(parsed, { year: 2025, orgScopeId: 31 }, { year: 2024, orgScopeId: 1, sheet: 'profit' });
    expect(resolved.scope).toEqual({ year: 2026, budgetVersionId: 12, orgScopeId: 31, sheet: 'profit' });
    expect(resolved.sources).toMatchObject({ year: 'url', budgetVersionId: 'url', orgScopeId: 'recent', sheet: 'default' });
  });

  it('URL 存在但非法时不回落,写目标不被自动替换', () => {
    const parsed = parseWorkspaceScope('analysis', '?version=abc');
    const resolved = resolveWorkspaceScope(parsed, { budgetVersionId: 12 }, { budgetVersionId: 11 });
    expect(resolved.scope.budgetVersionId).toBeUndefined();
    expect(resolved.sources.budgetVersionId).toBe('invalid_url');
    expect(resolved.issues[0].reason).toBe('invalid_format');
  });

  it('无 URL 无最近使用时使用页面默认,三者皆无为 none', () => {
    const parsed = parseWorkspaceScope('actual', '');
    const resolved = resolveWorkspaceScope(parsed, undefined, { year: 2026 });
    expect(resolved.scope.year).toBe(2026);
    expect(resolved.sources.year).toBe('default');
    expect(resolved.sources.orgScopeId).toBeUndefined();
  });
});

describe('resolveEffectiveYear:版本绑定年度', () => {
  it('版本年度优先于显式 year,不被全局年度覆盖', () => {
    const result = resolveEffectiveYear({ year: 2026, budgetVersionId: 11 }, catalog);
    expect(result).toEqual({ year: 2025, source: 'version' });
  });

  it('版本查不到时回退显式 year,两者皆无为 none', () => {
    expect(resolveEffectiveYear({ year: 2026, budgetVersionId: 99 }, catalog)).toEqual({ year: 2026, source: 'scope' });
    expect(resolveEffectiveYear({}, catalog)).toEqual({ source: 'none' });
  });
});

describe('resolveActualMode:当前/历史模式', () => {
  it('缺省为更新当前累计,不按年份推断历史', () => {
    expect(resolveActualMode({})).toBe('current');
    expect(resolveActualMode({ mode: undefined })).toBe('current');
  });

  it('仅显式 mode=history 进入历史补录', () => {
    expect(resolveActualMode({ mode: 'history' })).toBe('history');
    expect(resolveActualMode({ mode: 'current' })).toBe('current');
  });
});

describe('规范化往返与白名单', () => {
  it('合法范围 parse → build → parse 往返不变', () => {
    const cases: [Parameters<typeof parseWorkspaceScope>[0], string][] = [
      ['analysis', '?year=2026&version=12&forecast=14&batch=22&org=31&account=41&sheet=profit&level=2&threshold=20&trend=p01'],
      ['actual', '?year=2026&org=31&sheet=all&view=years&mode=history&cutoff=2026-06-30'],
      ['budget_edit', '?orgId=31&accountId=41&sheet=all'],
      ['version_compare', '?base=11&target=12&org=31&sheet=profit'],
      ['dashboard', '?year=2025'],
      ['finance_import', '?tab=convert&sourceProfileId=3&cutoff=2026-08-31&revisionOfId=8'],
    ];
    for (const [pageKey, search] of cases) {
      const first = parseWorkspaceScope(pageKey, search);
      expect(first.issues).toEqual([]);
      const rebuilt = buildScopeSearch(pageKey, first.scope);
      const second = parseWorkspaceScope(pageKey, rebuilt);
      expect(second.scope).toEqual(first.scope);
      expect(normalizeScopeSearch(pageKey, rebuilt)).toBe(rebuilt);
    }
  });

  it('旧参数链接规范化后改写为现行参数且范围不变', () => {
    const normalized = normalizeScopeSearch('budget_edit', '?org=31&account=41');
    expect(normalized).toBe('orgId=31&accountId=41');
    const reparsed = parseWorkspaceScope('budget_edit', normalized);
    expect(reparsed.scope).toEqual({ orgScopeId: 31, accountScopeId: 41 });
    expect(reparsed.adapted).toEqual([]);
  });

  it('规范化剥离非白名单参数与非法值', () => {
    expect(normalizeScopeSearch('dashboard', '?year=2025&version=12&debug=1')).toBe('year=2025');
    expect(normalizeScopeSearch('analysis', '?year=2026&version=abc')).toBe('year=2026');
    expect(normalizeScopeSearch('analysis', '')).toBe('');
  });

  it('路由白名单决定哪些页面可保存恢复范围', () => {
    expect(isScopeRestorable('analysis')).toBe(true);
    expect(isScopeRestorable('actual')).toBe(true);
    expect(isScopeRestorable('budget_edit')).toBe(true);
    expect(isScopeRestorable('org')).toBe(false);
    expect(isScopeRestorable('assistant')).toBe(false);
    expect(isScopeRestorable('logs')).toBe(false);
  });
});
