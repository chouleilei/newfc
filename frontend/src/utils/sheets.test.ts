import { describe, expect, it } from 'vitest';
import { pickWritableSheet, type SheetDef } from './sheets';

/** UX-31 遗留:实际录入页默认落点必须是可填写的预设表,而不是只读的利润表。 */

const master: SheetDef = { key: 'master', name: '收入成本表', roots: ['I1', 'C1'], collapsed: ['I12'] };
const power: SheetDef = { key: 'power', name: '发电收入', roots: ['I11'] };

describe('pickWritableSheet(实际录入默认视图)', () => {
  it('返回排序第一的预设表:后端按 sort_order 返回,主表即首选录入落点', () => {
    expect(pickWritableSheet([master, power])).toBe('master');
  });

  it('跳过无根科目的预设表,不把录入页落到空表上', () => {
    const empty: SheetDef = { key: 'empty', name: '空表', roots: [] };
    expect(pickWritableSheet([empty, master])).toBe('master');
  });

  it('无可用预设表时返回 null,由调用方给出切换引导', () => {
    expect(pickWritableSheet([])).toBeNull();
    expect(pickWritableSheet([{ key: 'empty', name: '空表', roots: [] }])).toBeNull();
  });

  it('内置只读特殊视图不作为落点候选(它们不出现在 dbSheets 中,仍显式排除)', () => {
    const profit: SheetDef = { key: 'profit', name: '利润表', roots: [], metric: true, special: true };
    expect(pickWritableSheet([profit, master])).toBe('master');
  });
});
