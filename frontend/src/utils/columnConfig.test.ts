import { describe, expect, it } from 'vitest';
import {
  configuredItemsByKey,
  reconcileMatrixColumnState,
  restoreMatrixColumnState,
  stableColumnKey,
  visibleMatrixColumnKeys,
} from './columnConfig';

describe('矩阵列配置', () => {
  it('把旧版缺失的可见 key 迁移成显式隐藏列', () => {
    const state = restoreMatrixColumnState({ keys: ['a'], fixed: false }, ['a', 'b']);
    expect(state).toEqual({ order: ['a', 'b'], hidden: ['b'], fixed: false });
    expect(visibleMatrixColumnKeys(state, ['a', 'b'])).toEqual(['a']);
  });

  it('查询尚未返回列时仍保留旧版可见键，待列到达后可识别隐藏项', () => {
    const loading = restoreMatrixColumnState({ keys: ['a'] }, []);
    expect(loading.order).toEqual(['a']);
    const loaded = restoreMatrixColumnState({ keys: ['a'] }, ['a', 'b']);
    expect(loaded.hidden).toEqual(['b']);
  });

  it('隐藏列不自我恢复，真正新增列默认可见', () => {
    const old = { order: ['a', 'b'], hidden: ['b'], fixed: true };
    const next = reconcileMatrixColumnState(old, ['a', 'b', 'c']);
    expect(visibleMatrixColumnKeys(next, ['a', 'b', 'c'])).toEqual(['a', 'c']);
    expect(visibleMatrixColumnKeys(reconcileMatrixColumnState(next, ['a']), ['a'])).toEqual(['a']);
    expect(visibleMatrixColumnKeys(next, ['a', 'b'])).toEqual(['a']);
  });
});

describe('通用表格稳定列键', () => {
  it('重排后仍按原始索引 key 隐藏对应列', () => {
    const columns = [{ title: 'A' }, { title: 'B' }];
    const entries = columns.map((column, index) => ({ key: stableColumnKey(column, index), column }));
    expect(configuredItemsByKey(entries, ['column-1', 'column-0'], ['column-1']).map((entry) => entry.column.title)).toEqual(['A']);
  });
});
