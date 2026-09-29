/**
 * analysisLocate(UX-03)单元测试:
 * - 预警维度 → 分析范围字段的映射(account→accountScopeId,org→orgScopeId,其余为空)
 * - 与 buildScopeSearch 组合生成分析页参数契约(year/version/batch/org/account)
 * - resolveLocateStatus 四级判定的优先级:展示 > 计算口径 > 主数据存活 > 查无此对象
 */
import { describe, expect, it } from 'vitest';
import { anomalyLocateScope, resolveLocateStatus } from './analysisLocate';
import { buildScopeSearch } from './workspaceScope';

describe('anomalyLocateScope', () => {
  it('科目维度定位 accountScopeId,组织维度定位 orgScopeId', () => {
    expect(anomalyLocateScope({ dimension: 'account', accountId: 12 })).toEqual({ accountScopeId: 12 });
    expect(anomalyLocateScope({ dimension: 'org', orgId: 7 })).toEqual({ orgScopeId: 7 });
  });

  it('total/quality 维度或缺少 ID 时不携带对象参数', () => {
    expect(anomalyLocateScope({ dimension: 'total' })).toEqual({});
    expect(anomalyLocateScope({ dimension: 'quality' })).toEqual({});
    expect(anomalyLocateScope({ dimension: 'account' })).toEqual({});
  });

  it('与 buildScopeSearch 组合生成分析页现有参数契约', () => {
    const search = buildScopeSearch('analysis', {
      year: 2025,
      budgetVersionId: 3,
      actualSnapshotId: 7,
      ...anomalyLocateScope({ dimension: 'account', accountId: 12 }),
    });
    expect(search).toBe('year=2025&version=3&batch=7&account=12');
    const orgSearch = buildScopeSearch('analysis', {
      year: 2025,
      budgetVersionId: 3,
      ...anomalyLocateScope({ dimension: 'org', orgId: 7 }),
    });
    expect(orgSearch).toBe('year=2025&version=3&org=7');
  });
});

describe('resolveLocateStatus', () => {
  const ctx = {
    displayIds: new Set([1, 2]),
    scopeIds: new Set([1, 2, 3]),
    masterIds: new Set([1, 2, 3, 4]),
  };

  it('按 展示 > 计算口径 > 主数据 > 查无 的顺序判定', () => {
    expect(resolveLocateStatus(1, ctx)).toBe('visible');
    expect(resolveLocateStatus(3, ctx)).toBe('hidden_by_display');
    expect(resolveLocateStatus(4, ctx)).toBe('not_in_snapshot');
    expect(resolveLocateStatus(9, ctx)).toBe('not_found');
  });
});
