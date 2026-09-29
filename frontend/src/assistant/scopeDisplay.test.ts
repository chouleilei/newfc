/**
 * scopeDisplay(UX-26)纯函数测试：
 * - 范围名称优先、ID 补充、目录缺失回退 #id
 * - 当前对象动作文案
 * - 迟到响应(来源页与当前页不同)判定
 */
import { describe, expect, it } from 'vitest';
import { describeScopeEntry, focusActions, isTurnOriginStale, type ScopeLookups } from './scopeDisplay';

const lookups: ScopeLookups = {
  versionName: (id) => (id === 3 ? '年初预算' : undefined),
  batchLabel: (id) => (id === 9 ? '截至 2026-08-31 rev2' : undefined),
  org: (id) => (id === 5 ? { code: 'JY', name: '江垭电站' } : undefined),
  account: (id) => (id === 7 ? { code: 'E201', name: '人工费' } : undefined),
};

describe('describeScopeEntry', () => {
  it('版本字段优先显示名称，ID 作补充', () => {
    expect(describeScopeEntry('budgetVersionId', 3, lookups)).toBe('预算版本 年初预算（#3）');
    expect(describeScopeEntry('targetVersionId', 3, lookups)).toBe('对比版本 年初预算（#3）');
  });

  it('名称目录未命中时回退 #id，不编造名称', () => {
    expect(describeScopeEntry('budgetVersionId', 99, lookups)).toBe('预算版本 #99');
    expect(describeScopeEntry('orgScopeId', 42, lookups)).toBe('组织范围 #42');
    expect(describeScopeEntry('actualSnapshotId', 1, {})).toBe('实际快照 #1');
  });

  it('实际快照优先显示截止日与修订号', () => {
    expect(describeScopeEntry('actualSnapshotId', 9, lookups)).toBe('实际快照 截至 2026-08-31 rev2（#9）');
  });

  it('组织/科目显示名称与编码', () => {
    expect(describeScopeEntry('orgScopeId', 5, lookups)).toBe('组织范围 江垭电站（JY）');
    expect(describeScopeEntry('accountScopeId', 7, lookups)).toBe('科目范围 人工费（E201）');
  });

  it('年度、日期与其他 ID 字段原样表达', () => {
    expect(describeScopeEntry('year', 2026, lookups)).toBe('年度 2026');
    expect(describeScopeEntry('asOfDate', '2026-08-31', lookups)).toBe('截至日期 2026-08-31');
    expect(describeScopeEntry('importBatchId', 12, lookups)).toBe('导入批次 #12');
  });
});

describe('focusActions', () => {
  it('围绕当前对象生成解释与依据两条入口', () => {
    const actions = focusActions('江垭电站 × 人工费');
    expect(actions.map((a) => a.label)).toEqual(['解释这个差异', '查看计算依据']);
    expect(actions[0].prompt).toContain('江垭电站 × 人工费');
    expect(actions[1].prompt).toContain('计算依据');
  });
});

describe('isTurnOriginStale', () => {
  it('来源页与当前页不同即为迟到响应', () => {
    expect(isTurnOriginStale('analysis', 'budget_edit')).toBe(true);
    expect(isTurnOriginStale('analysis', 'assistant')).toBe(true);
  });

  it('同页或当前页未知时不标注', () => {
    expect(isTurnOriginStale('analysis', 'analysis')).toBe(false);
    expect(isTurnOriginStale('analysis', 'unknown')).toBe(false);
    expect(isTurnOriginStale('analysis', undefined)).toBe(false);
    expect(isTurnOriginStale(undefined, 'analysis')).toBe(false);
  });
});
