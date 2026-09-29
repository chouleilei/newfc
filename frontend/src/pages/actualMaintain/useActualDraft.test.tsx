// @vitest-environment jsdom
/**
 * 实际数草稿(UX-09/UX-10)与期间规则(UX-08)单元测试:
 * - 纯函数:有效截止日解析 / 保存期间校验 / 待保存项归并与可见隐藏计数
 * - hook:基线采纳(脏时拒绝 refetch 覆盖)、目标切换重置、放弃=真正回滚基线、
 *   保存后基线前移(仅附注格保持脏)、汇总备注只在当前任务前移
 */
import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import {
  useActualDraft,
  resolveEffectiveCutoff,
  checkSavePeriod,
  collectDraftDirtyItems,
  summarizeDirtyItems,
  EMPTY_BASELINE,
  type ActualDraftBaseline,
  type ActualDraftTarget,
} from './useActualDraft';
import { useGridInteraction, type GridInteraction } from '../../hooks/useGridInteraction';

const ROWS = [
  { id: 1, type: 'expense', label: '费用A' },
  { id: 2, type: 'expense', label: '费用B' },
];
const COLS = [
  { id: 101, label: '电站甲' },
  { id: 102, label: '电站乙' },
];

const baselineOf = (values: [string, string][], notes: [string, string][] = [], summaryMemos: [string, string][] = []): ActualDraftBaseline => ({
  values: new Map(values),
  notes: new Map(notes),
  summaryMemos: new Map(summaryMemos),
});

interface HarnessProps {
  target: ActualDraftTarget;
  baseline: ActualDraftBaseline | null;
  /** 模拟视图:可见的组织列 id 集合 */
  visibleOrgIds: Set<number>;
}

function setup(initial: HarnessProps) {
  return renderHook(
    (props: HarnessProps) => {
      const grid = useGridInteraction({
        getRows: () => ROWS,
        getCols: () => COLS,
        isCellEditable: () => true,
        cellDomId: (rowId, colId) => `cell-${rowId}-${colId}`,
        notify: () => {},
      });
      const draft = useActualDraft({
        grid,
        target: props.target,
        baseline: props.baseline,
        isCellKeyVisible: (key) => props.visibleOrgIds.has(Number(key.split(':')[0])),
        isSummaryKeyVisible: () => true,
      });
      return { grid, draft };
    },
    { initialProps: initial },
  );
}

const CURRENT_TARGET: ActualDraftTarget = { year: 2026, task: 'current', historyCutoff: null };

/* ============ 纯函数:有效截止日(UX-08) ============ */

describe('resolveEffectiveCutoff(有效累计截止日)', () => {
  it('显式选择优先于服务器截止日', () => {
    expect(resolveEffectiveCutoff('2026-06-30', 'current', '2026-08-31')).toBe('2026-06-30');
  });
  it('当前任务回落到服务器现有累计截止日', () => {
    expect(resolveEffectiveCutoff(null, 'current', '2026-08-31')).toBe('2026-08-31');
  });
  it('本年度尚无实际时当前任务无默认期间', () => {
    expect(resolveEffectiveCutoff(null, 'current', null)).toBeNull();
  });
  it('历史任务绝不自动默认(不能把服务器截止或今天当成历史目标日期)', () => {
    expect(resolveEffectiveCutoff(null, 'history', '2026-08-31')).toBeNull();
  });
});

/* ============ 纯函数:保存期间校验(UX-08) ============ */

describe('checkSavePeriod(保存前期间校验)', () => {
  it('当前任务未选截止日:要求选择', () => {
    const issue = checkSavePeriod({ task: 'current', cutoff: null, serverCutoff: null });
    expect(issue?.code).toBe('missing_cutoff');
  });
  it('历史任务未选截止日:要求明确选择历史日期', () => {
    const issue = checkSavePeriod({ task: 'history', cutoff: null, serverCutoff: '2026-08-31' });
    expect(issue?.code).toBe('missing_cutoff');
    expect(issue?.message).toContain('历史');
  });
  it('普通更新早于当前累计截止日:拒绝并指向历史补录', () => {
    const issue = checkSavePeriod({ task: 'current', cutoff: '2026-06-30', serverCutoff: '2026-08-31' });
    expect(issue?.code).toBe('earlier_than_current');
    expect(issue?.message).toContain('2026-08-31');
  });
  it('历史任务允许任意历史日期;当前任务不早于服务器截止即可', () => {
    expect(checkSavePeriod({ task: 'history', cutoff: '2026-03-31', serverCutoff: '2026-08-31' })).toBeNull();
    expect(checkSavePeriod({ task: 'current', cutoff: '2026-09-30', serverCutoff: '2026-08-31' })).toBeNull();
  });
});

/* ============ 纯函数:待保存项归并(UX-09) ============ */

describe('collectDraftDirtyItems / summarizeDirtyItems', () => {
  it('区分数值/明细备注/汇总备注,并统计可见与隐藏', () => {
    const items = collectDraftDirtyItems({
      dirtyKeys: new Set(['101:1', '102:1', '102:2']),
      values: new Map([['101:1', '10'], ['102:1', '20'], ['102:2', '5']]),
      notes: new Map([['102:2', '仅改备注']]),
      baselineValues: new Map([['101:1', '1'], ['102:1', '2'], ['102:2', '5']]),
      baselineNotes: new Map(),
      summaryMemos: new Map([['100:9', '汇总说明']]),
      baselineSummaryMemos: new Map(),
      isCellKeyVisible: (key) => key.startsWith('101:'),
      isSummaryKeyVisible: () => false,
    });
    expect(items).toHaveLength(4);
    const byKey = new Map(items.map((i) => [`${i.kind}:${i.key}`, i]));
    expect(byKey.get('value:101:1')).toMatchObject({ before: '1', after: '10', visible: true });
    expect(byKey.get('value:102:1')?.visible).toBe(false);
    expect(byKey.get('note:102:2')).toMatchObject({ before: '', after: '仅改备注' });
    expect(byKey.get('summaryMemo:100:9')?.visible).toBe(false);
    expect(summarizeDirtyItems(items)).toEqual({ total: 4, hidden: 3 });
  });

  it('汇总备注与基线一致时不产生待保存项', () => {
    const items = collectDraftDirtyItems({
      dirtyKeys: new Set(),
      values: new Map(),
      notes: new Map(),
      baselineValues: new Map(),
      baselineNotes: new Map(),
      summaryMemos: new Map([['100:9', '同']]),
      baselineSummaryMemos: new Map([['100:9', '同']]),
      isCellKeyVisible: () => true,
      isSummaryKeyVisible: () => true,
    });
    expect(items).toHaveLength(0);
  });
});

/* ============ hook:基线采纳与目标切换(UX-09) ============ */

describe('useActualDraft(草稿与视图解耦)', () => {
  it('干净时采纳服务器基线;采纳后不脏', () => {
    const { result } = setup({
      target: CURRENT_TARGET,
      baseline: baselineOf([['101:1', '100']]),
      visibleOrgIds: new Set([101, 102]),
    });
    expect(result.current.grid.values.get('101:1')).toBe('100');
    expect(result.current.draft.anyDirty).toBe(false);
  });

  it('有本地修改时,后台 refetch(新基线对象)不覆盖本地编辑', () => {
    const { result, rerender } = setup({
      target: CURRENT_TARGET,
      baseline: baselineOf([['101:1', '100']]),
      visibleOrgIds: new Set([101, 102]),
    });
    act(() => { result.current.grid.applyCells([{ key: '102:1', value: '777' }], '编辑'); });
    expect(result.current.draft.anyDirty).toBe(true);
    // 服务器数据变化(refetch 产生新 Map/新对象):不得覆盖在录内容
    rerender({
      target: CURRENT_TARGET,
      baseline: baselineOf([['101:1', '100'], ['102:1', '200']]),
      visibleOrgIds: new Set([101, 102]),
    });
    expect(result.current.grid.values.get('102:1')).toBe('777');
    expect(result.current.draft.anyDirty).toBe(true);
  });

  it('干净时 refetch 数据变化则采纳新基线', () => {
    const { result, rerender } = setup({
      target: CURRENT_TARGET,
      baseline: baselineOf([['101:1', '100']]),
      visibleOrgIds: new Set([101, 102]),
    });
    rerender({
      target: CURRENT_TARGET,
      baseline: baselineOf([['101:1', '150']]),
      visibleOrgIds: new Set([101, 102]),
    });
    expect(result.current.grid.values.get('101:1')).toBe('150');
  });

  it('目标切换到历史任务:干净草稿重置为空白待补录(不预填当前累计)', () => {
    const { result, rerender } = setup({
      target: CURRENT_TARGET,
      baseline: baselineOf([['101:1', '100']]),
      visibleOrgIds: new Set([101, 102]),
    });
    expect(result.current.grid.values.get('101:1')).toBe('100');
    rerender({
      target: { year: 2026, task: 'history', historyCutoff: '2026-06-30' },
      baseline: EMPTY_BASELINE,
      visibleOrgIds: new Set([101, 102]),
    });
    expect(result.current.grid.values.size).toBe(0);
    expect(result.current.draft.anyDirty).toBe(false);
  });

  it('视图收窄不重置草稿:修改保留,隐藏计数增加(同一目标内切组织)', () => {
    const { result, rerender } = setup({
      target: CURRENT_TARGET,
      baseline: baselineOf([['101:1', '100']]),
      visibleOrgIds: new Set([101, 102]),
    });
    act(() => { result.current.grid.applyCells([{ key: '102:1', value: '777' }], '编辑'); });
    // 视图收窄到只剩 101 列(模拟切换组织范围)
    rerender({
      target: CURRENT_TARGET,
      baseline: baselineOf([['101:1', '100']]),
      visibleOrgIds: new Set([101]),
    });
    expect(result.current.grid.values.get('102:1')).toBe('777');
    expect(result.current.draft.totalDirty).toBe(1);
    expect(result.current.draft.hiddenDirty).toBe(1);
    // 切回全量视图后隐藏计数归零,值仍在
    rerender({
      target: CURRENT_TARGET,
      baseline: baselineOf([['101:1', '100']]),
      visibleOrgIds: new Set([101, 102]),
    });
    expect(result.current.draft.hiddenDirty).toBe(0);
    expect(result.current.grid.values.get('102:1')).toBe('777');
  });

  it('放弃修改真正回滚到基线(不只是清脏标记)', () => {
    const { result } = setup({
      target: CURRENT_TARGET,
      baseline: baselineOf([['101:1', '100']], [], [['100:9', '原汇总备注']]),
      visibleOrgIds: new Set([101, 102]),
    });
    act(() => {
      result.current.grid.applyCells([{ key: '101:1', value: '999' }], '编辑');
      result.current.draft.setSummaryMemo('100:9', '改过的汇总备注');
    });
    expect(result.current.draft.anyDirty).toBe(true);
    act(() => { result.current.draft.discardToBaseline(); });
    expect(result.current.grid.values.get('101:1')).toBe('100');
    expect(result.current.draft.summaryMemos.get('100:9')).toBe('原汇总备注');
    expect(result.current.draft.anyDirty).toBe(false);
  });

  it('保存后基线前移:脏格清零、撤销栈保留;仅附注未落库的格保持脏', () => {
    const { result } = setup({
      target: CURRENT_TARGET,
      baseline: baselineOf([['101:1', '100']]),
      visibleOrgIds: new Set([101, 102]),
    });
    act(() => {
      result.current.grid.applyCells([{ key: '101:1', value: '200' }], '编辑');
      result.current.grid.applyCells([{ key: '102:2', note: '仅附注' }], '备注');
    });
    expect(result.current.draft.totalDirty).toBe(2);
    act(() => { result.current.draft.markSaved(new Set(['102:2']), true); });
    expect(result.current.draft.totalDirty).toBe(1);
    expect(result.current.draft.dirtyItems[0]).toMatchObject({ key: '102:2', kind: 'note' });
    expect(result.current.grid.canUndo).toBe(true);
  });

  it('汇总备注基线仅当前任务前移(advanceSummary=false 时保持脏)', () => {
    const { result } = setup({
      target: CURRENT_TARGET,
      baseline: baselineOf([['101:1', '100']]),
      visibleOrgIds: new Set([101, 102]),
    });
    act(() => { result.current.draft.setSummaryMemo('100:9', '新备注'); });
    expect(result.current.draft.summaryMemosDirty).toBe(true);
    act(() => { result.current.draft.markSaved(undefined, false); });
    expect(result.current.draft.summaryMemosDirty).toBe(true);
    act(() => { result.current.draft.markSaved(undefined, true); });
    expect(result.current.draft.summaryMemosDirty).toBe(false);
  });

  it('基线未就绪(null)时不清空网格', () => {
    const { result, rerender } = setup({
      target: CURRENT_TARGET,
      baseline: baselineOf([['101:1', '100']]),
      visibleOrgIds: new Set([101, 102]),
    });
    rerender({ target: CURRENT_TARGET, baseline: null, visibleOrgIds: new Set([101, 102]) });
    expect(result.current.grid.values.get('101:1')).toBe('100');
  });
});
