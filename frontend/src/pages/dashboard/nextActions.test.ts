import { describe, expect, it } from 'vitest';
import { buildNextActions, MAX_ACTIONS, type NextActionsInput } from './nextActions';

/** UX-24:首页按真实工作状态给出确定的下一步。 */

function base(overrides: Partial<NextActionsInput> = {}): NextActionsInput {
  return {
    year: 2026,
    currentVersion: { id: 11, name: '年初预算' },
    orgCount: 6,
    accountCount: 9,
    structureOk: true,
    structureProblemCount: 0,
    recentDraft: null,
    pendingAdoption: [],
    yearActuals: [],
    overspendCount: 0,
    today: new Date('2026-09-20T12:00:00'),
    ...overrides,
  };
}

describe('buildNextActions(UX-24)', () => {
  it('组织/科目未就绪:定位配置入口,且优先级最高', () => {
    const actions = buildNextActions(base({ orgCount: 0, accountCount: 0, currentVersion: null }));
    expect(actions[0]).toMatchObject({ key: 'setup-org', path: '/org' });
    expect(actions[1]).toMatchObject({ key: 'setup-account', path: '/account' });
  });

  it('主数据存在但结构检查未通过:指向健康体检,不重复配置入口', () => {
    const actions = buildNextActions(base({ structureOk: false, structureProblemCount: 2 }));
    expect(actions.some((a) => a.key === 'structure' && a.path === '/master-health')).toBe(true);
    expect(actions.some((a) => a.key === 'setup-org')).toBe(false);
    expect(actions.find((a) => a.key === 'structure')!.desc).toContain('2 个问题');
  });

  it('已有草稿:进入最近编制,携带版本 ID', () => {
    const actions = buildNextActions(base({
      recentDraft: { id: 42, year: 2026, name: '9 月修订稿', kind: 'budget', updated_at: '2026-09-18 10:20:30' },
    }));
    const draft = actions.find((a) => a.key === 'draft')!;
    expect(draft.path).toBe('/budget/42');
    expect(draft.title).toContain('9 月修订稿');
    expect(draft.desc).toContain('2026 年预算草稿');
    expect(draft.desc).toContain('2026-09-18 10:20');
  });

  it('已有草稿时不再用「打开当前预算」凑数', () => {
    const actions = buildNextActions(base({
      recentDraft: { id: 42, year: 2026, name: '草稿', kind: 'budget', updated_at: '2026-09-18 10:20:30' },
    }));
    expect(actions.some((a) => a.key === 'open-current')).toBe(false);
  });

  it('定稿未采用:提示选择,跳版本列表对应年度', () => {
    const actions = buildNextActions(base({
      pendingAdoption: [{ year: 2026, kind: 'budget', lockedCount: 2, latestLockedName: 'V2' }],
    }));
    const adopt = actions.find((a) => a.key === 'adopt-2026-budget')!;
    expect(adopt.path).toBe('/budget?year=2026');
    expect(adopt.title).toContain('选择 2026 年预算的当前采用版本');
    expect(adopt.desc).toContain('2 个定稿版本');
    expect(adopt.desc).toContain('V2');
    expect(adopt.desc).toContain('尚未设为当前采用');
  });

  it('首次使用(本年度无实际快照):客观表述,不出现逾期/漏报结论', () => {
    const actions = buildNextActions(base({ yearActuals: [] }));
    const actual = actions.find((a) => a.key === 'actual')!;
    expect(actual.title).toBe('录入 2026 年实际');
    expect(actual.desc).toBe('本年度尚无实际快照');
    expect(actual.path).toBe('/actual?year=2026');
  });

  it('已有实际数据:显示最新快照截至日,跳对应年度', () => {
    const actions = buildNextActions(base({
      yearActuals: [{ year: 2026, latest_snapshot: '2026-08-31', batch_count: 2 }],
    }));
    const actual = actions.find((a) => a.key === 'actual')!;
    expect(actual.title).toBe('更新 2026 年实际');
    expect(actual.desc).toBe('最新快照截至 2026-08-31');
    expect(actual.path).toBe('/actual?year=2026');
  });

  it('无月末快照只客观表述「尚无截至 X 月末的快照」;已覆盖到月末则不追加', () => {
    const behind = buildNextActions(base({
      yearActuals: [{ year: 2026, latest_snapshot: '2026-07-15', batch_count: 1 }],
    })).find((a) => a.key === 'actual')!;
    // 今天 2026-09-20:最近完整月为 8 月,最新快照 07-15 早于 08-31
    expect(behind.desc).toContain('最新快照截至 2026-07-15');
    expect(behind.desc).toContain('尚无截至 8 月末的快照');
    expect(behind.desc).not.toMatch(/应录|漏报|逾期/);

    const covered = buildNextActions(base({
      yearActuals: [{ year: 2026, latest_snapshot: '2026-08-31', batch_count: 1 }],
    })).find((a) => a.key === 'actual')!;
    expect(covered.desc).toBe('最新快照截至 2026-08-31');
  });

  it('非当前年度不做月末快照推断(历史年度只陈述事实)', () => {
    const actions = buildNextActions(base({
      year: 2025,
      yearActuals: [{ year: 2025, latest_snapshot: '2025-03-31', batch_count: 1 }],
    }));
    const actual = actions.find((a) => a.key === 'actual')!;
    expect(actual.desc).toBe('最新快照截至 2025-03-31');
  });

  it('有异常:指向预警中心并携带年度与版本筛选', () => {
    const actions = buildNextActions(base({ overspendCount: 3 }));
    const anomaly = actions.find((a) => a.key === 'anomaly')!;
    expect(anomaly.path).toBe('/alerts?year=2026&version=11');
    expect(anomaly.desc).toContain('3 个成本费用科目');
    expect(anomaly.tone).toBe('bad');
  });

  it('一切就绪:补稳定入口,至少 MIN 条', () => {
    const actions = buildNextActions(base({
      yearActuals: [{ year: 2026, latest_snapshot: '2026-08-31', batch_count: 2 }],
    }));
    expect(actions.length).toBeGreaterThanOrEqual(3);
    expect(actions.some((a) => a.key === 'open-current' && a.path === '/budget/11')).toBe(true);
    expect(actions.some((a) => a.key === 'finance' && a.path === '/finance')).toBe(true);
  });

  it('入口数量有限:全部状态同时触发也不超过 MAX_ACTIONS,且高优先级在前', () => {
    const actions = buildNextActions(base({
      orgCount: 0,
      accountCount: 0,
      recentDraft: { id: 42, year: 2026, name: '草稿', kind: 'budget', updated_at: '2026-09-18 10:20:30' },
      pendingAdoption: [{ year: 2026, kind: 'budget', lockedCount: 1, latestLockedName: 'V1' }],
      overspendCount: 5,
    }));
    expect(actions.length).toBeLessThanOrEqual(MAX_ACTIONS);
    expect(actions[0].key).toBe('setup-org');
    expect(actions[1].key).toBe('setup-account');
    expect(actions[2].key).toBe('draft');
  });
});
