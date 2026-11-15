import { describe, expect, it } from 'vitest';
import { groupByType } from './Search';
import { SEARCH_TYPE_OPTIONS, type SearchItemDto } from '../api/search';

const item = (type: SearchItemDto['type'], id: number): SearchItemDto => ({
  type, typeLabel: '', id, code: null, title: `t${id}`, subtitle: '', orgName: null, status: '', path: '/', updatedAt: null,
});

describe('跨域检索结果分组', () => {
  it('按固定类型顺序分组,组内保持服务端排序', () => {
    const groups = groupByType([item('risk_event', 1), item('project', 2), item('risk_event', 3), item('contract', 4)]);
    expect(groups.map((g) => g.type)).toEqual(['project', 'contract', 'risk_event']);
    expect(groups[2].items.map((i) => i.id)).toEqual([1, 3]);
  });
  it('包含综合计划明细 plan_item 检索类型并支持深链定位分组 (F-GAP-10)', () => {
    expect(SEARCH_TYPE_OPTIONS.some((o) => o.value === 'plan_item' && o.label === '综合计划明细')).toBe(true);
    const planEntry: SearchItemDto = {
      ...item('plan_item', 501),
      title: '示范枢纽安全生产技改项目',
      path: '/plan?batchId=7&itemId=501',
    };
    const groups = groupByType([planEntry, item('contract', 8)]);
    expect(groups.map((g) => g.type)).toEqual(['contract', 'plan_item']);
    expect(groups[1].items[0].path).toBe('/plan?batchId=7&itemId=501');
  });
  it('空结果没有分组', () => {
    expect(groupByType([])).toEqual([]);
  });
});
