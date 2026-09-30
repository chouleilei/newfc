import { describe, expect, it } from 'vitest';
import { groupByType } from './Search';
import type { SearchItemDto } from '../api/search';

const item = (type: SearchItemDto['type'], id: number): SearchItemDto => ({
  type, typeLabel: '', id, code: null, title: `t${id}`, subtitle: '', orgName: null, status: '', path: '/', updatedAt: null,
});

describe('跨域检索结果分组', () => {
  it('按固定类型顺序分组,组内保持服务端排序', () => {
    const groups = groupByType([item('risk_event', 1), item('project', 2), item('risk_event', 3), item('contract', 4)]);
    expect(groups.map((g) => g.type)).toEqual(['project', 'contract', 'risk_event']);
    expect(groups[2].items.map((i) => i.id)).toEqual([1, 3]);
  });
  it('空结果没有分组', () => {
    expect(groupByType([])).toEqual([]);
  });
});
