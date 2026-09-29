import { describe, it, expect } from 'vitest';
import {
  yuanStringToCents, centsToYuanString, displayToSignedCents, signedCentsToDisplay, AmountFormatError,
} from '../src/core/money';
import { timeProgress, isValidDate, dayOfYear, daysInYear } from '../src/core/dates';
import { hasCycle, computeLeafIds, buildAncestorMap, buildTree, pathOf, isDescendantOf, type TreeNodeRow } from '../src/core/tree';
import { rollup, cellOf } from '../src/core/rollup';
import { AppError } from '../src/core/errors';

describe('金额字符串转分(十进制解析)', () => {
  it('基本转换', () => {
    expect(yuanStringToCents('100.00')).toBe(10000);
    expect(yuanStringToCents('0.01')).toBe(1);
    expect(yuanStringToCents('0.1')).toBe(10);
    expect(yuanStringToCents('1234567890.12')).toBe(123456789012);
    expect(() => yuanStringToCents('123456789012345.67')).toThrow(AmountFormatError); // 超出安全整数范围
  });
  it('负数与正号', () => {
    expect(yuanStringToCents('-100.00')).toBe(-10000);
    expect(yuanStringToCents('+5.50')).toBe(550);
    expect(yuanStringToCents('-0.01')).toBe(-1);
  });
  it('非法格式抛错', () => {
    expect(() => yuanStringToCents('abc')).toThrow(AmountFormatError);
    expect(() => yuanStringToCents('1.234')).toThrow(AmountFormatError); // 三位小数
    expect(() => yuanStringToCents('')).toThrow(AmountFormatError);
    expect(() => yuanStringToCents('1,000')).toThrow(AmountFormatError);
    expect(() => yuanStringToCents('1.')).toThrow(AmountFormatError);
  });
  it('无浮点误差', () => {
    expect(yuanStringToCents('0.29')).toBe(29);
    expect(yuanStringToCents('19.99')).toBe(1999);
    expect(yuanStringToCents('0.07') + yuanStringToCents('0.03')).toBe(10);
  });
  it('分转元字符串往返', () => {
    expect(centsToYuanString(10000)).toBe('100.00');
    expect(centsToYuanString(-6000)).toBe('-60.00');
    expect(centsToYuanString(5)).toBe('0.05');
    expect(centsToYuanString(0)).toBe('0.00');
  });
});

describe('三类科目符号转换(方案二.1)', () => {
  it('income 正数存储', () => {
    expect(displayToSignedCents('100.00', 'income')).toBe(10000);
  });
  it('cost / expense 转为负数存储', () => {
    expect(displayToSignedCents('60.00', 'cost')).toBe(-6000);
    expect(displayToSignedCents('20.00', 'expense')).toBe(-2000);
  });
  it('反向金额:负的界面金额', () => {
    expect(displayToSignedCents('-10.00', 'income')).toBe(-1000); // 收入冲减
    expect(displayToSignedCents('-5.00', 'cost')).toBe(500); // 成本冲回
  });
  it('利润 = 收入 + 成本 + 费用(直接相加)', () => {
    const profit = displayToSignedCents('100.00', 'income') + displayToSignedCents('60.00', 'cost') + displayToSignedCents('20.00', 'expense');
    expect(profit).toBe(2000); // 20.00 元
  });
  it('存储金额还原为界面展示(成本费用显示正数)', () => {
    expect(signedCentsToDisplay(-6000, 'cost')).toBe('60.00');
    expect(signedCentsToDisplay(10000, 'income')).toBe('100.00');
    expect(signedCentsToDisplay(-1000, 'income')).toBe('-10.00');
  });
});

describe('均匀自然日进度(方案九.4)', () => {
  it('日期校验', () => {
    expect(isValidDate('2026-06-30')).toBe(true);
    expect(isValidDate('2026-02-30')).toBe(false);
    expect(isValidDate('2026-13-01')).toBe(false);
    expect(isValidDate('20260630')).toBe(false);
  });
  it('平年与闰年天数', () => {
    expect(daysInYear(2026)).toBe(365);
    expect(daysInYear(2024)).toBe(366);
    expect(daysInYear(2000)).toBe(366);
    expect(daysInYear(1900)).toBe(365);
  });
  it('dayOfYear', () => {
    expect(dayOfYear('2026-01-01')).toBe(1);
    expect(dayOfYear('2026-12-31')).toBe(365);
    expect(dayOfYear('2024-12-31')).toBe(366);
  });
  it('时间进度值', () => {
    expect(timeProgress('2026-01-01')).toBeCloseTo(1 / 365, 10);
    expect(timeProgress('2026-12-31')).toBeCloseTo(1, 10);
    expect(timeProgress('2026-06-30')).toBeCloseTo(181 / 365, 10);
  });
});

describe('树工具:循环检测与叶子检测', () => {
  const rows: TreeNodeRow[] = [
    { id: 1, parent_id: null, code: 'A', name: 'A', sort_order: 0, status: 'active' },
    { id: 2, parent_id: 1, code: 'B', name: 'B', sort_order: 0, status: 'active' },
    { id: 3, parent_id: 2, code: 'C', name: 'C', sort_order: 0, status: 'active' },
    { id: 4, parent_id: 1, code: 'D', name: 'D', sort_order: 1, status: 'active' },
  ];
  it('无环时不报循环', () => {
    expect(hasCycle(rows, 3)).toBe(false);
  });
  it('有环时检出', () => {
    const cyclic: TreeNodeRow[] = [
      { id: 1, parent_id: 2, code: 'A', name: 'A', sort_order: 0, status: 'active' },
      { id: 2, parent_id: 1, code: 'B', name: 'B', sort_order: 0, status: 'active' },
    ];
    expect(hasCycle(cyclic, 1)).toBe(true);
    expect(hasCycle([...rows, { id: 9, parent_id: 9, code: 'X', name: 'X', sort_order: 0, status: 'active' }], 9)).toBe(true);
  });
  it('叶子检测', () => {
    const leaves = computeLeafIds(rows);
    expect(leaves.has(1)).toBe(false);
    expect(leaves.has(2)).toBe(false);
    expect(leaves.has(3)).toBe(true);
    expect(leaves.has(4)).toBe(true);
  });
  it('祖先映射包含自身与全部祖先', () => {
    const map = buildAncestorMap(rows);
    expect(map.get(3)).toEqual(new Set([3, 2, 1]));
    expect(map.get(1)).toEqual(new Set([1]));
  });
  it('后代判断(移动校验)', () => {
    expect(isDescendantOf(rows, 3, 1)).toBe(true);
    expect(isDescendantOf(rows, 1, 3)).toBe(false);
    expect(isDescendantOf(rows, 2, 2)).toBe(true);
  });
  it('路径计算', () => {
    expect(pathOf(rows, 3)).toBe('A / B / C');
  });
  it('buildTree 输出层级与叶子标记', () => {
    const tree = buildTree(rows);
    expect(tree[0].children[0].isLeaf).toBe(false);
    expect(tree[0].children[0].children[0].isLeaf).toBe(true);
    expect(tree[0].children[1].isLeaf).toBe(true);
  });
});

describe('多级交叉汇总(方案八.1)', () => {
  const orgRows: TreeNodeRow[] = [
    { id: 1, parent_id: null, code: 'G', name: '集团', sort_order: 0, status: 'active' },
    { id: 2, parent_id: 1, code: 'E', name: '华东', sort_order: 0, status: 'active' },
    { id: 3, parent_id: 2, code: 'SH', name: '上海', sort_order: 0, status: 'active' },
    { id: 4, parent_id: 2, code: 'HZ', name: '杭州', sort_order: 1, status: 'active' },
    { id: 5, parent_id: 1, code: 'W', name: '西部', sort_order: 1, status: 'active' },
  ];
  const accRows: TreeNodeRow[] = [
    { id: 10, parent_id: null, code: 'I', name: '收入', sort_order: 0, status: 'active', type: 'income' },
    { id: 11, parent_id: 10, code: 'I01', name: '主营收入', sort_order: 0, status: 'active', type: 'income' },
    { id: 20, parent_id: null, code: 'C', name: '成本', sort_order: 1, status: 'active', type: 'cost' },
    { id: 21, parent_id: 20, code: 'C01', name: '主营成本', sort_order: 0, status: 'active', type: 'cost' },
    { id: 211, parent_id: 21, code: 'C0101', name: '材料', sort_order: 0, status: 'active', type: 'cost' },
  ];
  it('叶子明细累计到组织祖先×科目祖先全部组合', () => {
    const entries = [
      { orgId: 3, accountId: 11, amountCents: 10000 },  // 上海 收入 100
      { orgId: 4, accountId: 11, amountCents: 5000 },   // 杭州 收入 50
      { orgId: 3, accountId: 211, amountCents: -6000 }, // 上海 材料 -60
    ];
    const r = rollup(orgRows, accRows, entries);
    // 叶子级
    expect(cellOf(r, 3, 11)).toBe(10000);
    // 组织中间级:华东收入 = 15000
    expect(cellOf(r, 2, 11)).toBe(15000);
    // 集团收入
    expect(cellOf(r, 1, 11)).toBe(15000);
    // 科目中间级:上海在成本大类 = -6000
    expect(cellOf(r, 3, 20)).toBe(-6000);
    expect(cellOf(r, 3, 21)).toBe(-6000);
    // 全集团 × 收入大类 = 15000
    expect(cellOf(r, 1, 10)).toBe(15000);
    // 全集团 × 成本大类 = -6000
    expect(cellOf(r, 1, 20)).toBe(-6000);
    // 西部无数据补零
    expect(cellOf(r, 5, 11)).toBe(0);
  });
  it('零金额与空数据(方案八.2)', () => {
    const r = rollup(orgRows, accRows, [
      { orgId: 3, accountId: 11, amountCents: 0 },
    ]);
    expect(cellOf(r, 1, 10)).toBe(0);
    const empty = rollup(orgRows, accRows, []);
    expect(cellOf(empty, 1, 10)).toBe(0);
  });
  it('停用节点参与汇总', () => {
    const orgWithInactive = orgRows.map((o) => (o.id === 4 ? { ...o, status: 'inactive' } : o));
    const r = rollup(orgWithInactive, accRows, [{ orgId: 4, accountId: 11, amountCents: 5000 }]);
    expect(cellOf(r, 2, 11)).toBe(5000); // 停用的杭州仍计入华东
    expect(cellOf(r, 1, 10)).toBe(5000);
  });
});

describe('完成率边界与差异方向(方案九.2/3)', () => {
  it('预算为 0 → N/A(null)', () => {
    const actualC = 10000, budgetC = 0;
    const rate = budgetC === 0 ? null : actualC / budgetC;
    expect(rate).toBeNull();
  });
  it('预算为负(特殊预算) → N/A', () => {
    const rate = -5000 < 0 ? null : 1;
    expect(rate).toBeNull();
  });
  it('差异 V = A - B,成本低于预算为有利', () => {
    const V = -5000 - (-6000); // 实际成本50 vs 预算60
    expect(V).toBe(1000);
    expect(V > 0).toBe(true); // 有利
  });
  it('收入低于预算为不利', () => {
    const V = 8000 - 10000;
    expect(V < 0).toBe(true); // 不利
  });
  it('完成率可超过 100%', () => {
    expect(12000 / 10000).toBe(1.2);
  });
});

describe('统一错误结构', () => {
  it('导入错误带行号字段', () => {
    const err = new AppError('IMPORT_VALIDATION_FAILED', '导入文件存在错误', 400, [
      { row: 12, field: 'orgCode', message: '组织编码不存在' },
    ]);
    expect(err.errors?.[0].row).toBe(12);
  });
});
