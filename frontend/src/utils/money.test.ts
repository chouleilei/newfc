import { describe, expect, it } from 'vitest';
import { amountSchema, centsToWan, centsToYuan, centsToYuanGrouped, formatQuantity, formatRateOrReason, quantitySchema, quantityToScaled, wanToCents } from './money';

describe('万元与数量定点口径', () => {
  it('千分位展示值仍可校验并精确换回分', () => {
    const display = centsToWan(1_000_000_000);
    expect(display).toBe('1,000.00');
    expect(amountSchema.safeParse(display).success).toBe(true);
    expect(wanToCents(display)).toBe(1_000_000_000);
  });

  it('数量按十进制四位精确解析并拒绝超界', () => {
    expect(quantityToScaled('1,234.5678')).toBe(12_345_678);
    expect(quantityToScaled('-0.0001')).toBe(-1);
    expect(quantitySchema.safeParse('999999999999.9999').success).toBe(false);
  });
});

describe('centsToWan(整数路径舍入,与后端 centsToWanText 同口径)', () => {
  it('半边界按四舍五入到百元,不走浮点路径', () => {
    // 0.145 万元:浮点路径曾因二进制表示误舍为 0.14
    expect(centsToWan(145_000)).toBe('0.15');
    expect(centsToWan(-145_000)).toBe('-0.15');
    expect(centsToWan(5_000)).toBe('0.01');
    expect(centsToWan(15_000)).toBe('0.02');
    expect(centsToWan(25_000)).toBe('0.03');
    expect(centsToWan(4_999)).toBe('0.00');
    expect(centsToWan(-4_999)).toBe('0.00');
    expect(centsToWan(-5_000)).toBe('-0.01');
  });

  it('大额 halfway 值与后端整数口径一致', () => {
    // 浮点路径曾输出 5,306,103.26
    expect(centsToWan(5_306_103_265_000)).toBe('5,306,103.27');
    expect(centsToWan(0)).toBe('0.00');
    expect(centsToWan(123_456_789)).toBe('123.46');
  });

  it('与 wanToCents 回读互逆(展示精度内)', () => {
    expect(wanToCents(centsToWan(145_000))).toBe(150_000);
    expect(wanToCents(centsToWan(5_306_103_265_000))).toBe(5_306_103_270_000);
  });
});

describe('centsToYuan(清洗导入变化额等元口径)', () => {
  it('正数、负数、零都精确到分', () => {
    expect(centsToYuan(0)).toBe('0.00');
    expect(centsToYuan(1)).toBe('0.01');
    expect(centsToYuan(-1)).toBe('-0.01');
    expect(centsToYuan(123_456)).toBe('1234.56');
    expect(centsToYuan(-123_456)).toBe('-1234.56');
    // 尾零保留两位
    expect(centsToYuan(100)).toBe('1.00');
    expect(centsToYuan(10)).toBe('0.10');
  });

  it('大安全整数不经过浮点丢失精度', () => {
    expect(centsToYuan(9_007_199_254_740_991)).toBe('90071992547409.91');
    expect(centsToYuan(-9_007_199_254_740_991)).toBe('-90071992547409.91');
  });
});

describe('centsToYuanGrouped(精确元查看层)', () => {
  it('千分位且精确到分,与 centsToYuan 同值', () => {
    expect(centsToYuanGrouped(0)).toBe('0.00');
    expect(centsToYuanGrouped(1)).toBe('0.01');
    expect(centsToYuanGrouped(123_456_789)).toBe('1,234,567.89');
    expect(centsToYuanGrouped(-123_456_789)).toBe('-1,234,567.89');
    expect(centsToYuanGrouped(9_007_199_254_740_991)).toBe('90,071,992,547,409.91');
  });
});

describe('formatRateOrReason(完成率特殊状态原因文案)', () => {
  it('有值给百分比,无值给服务端 special 对应原因', () => {
    expect(formatRateOrReason(0.8321)).toBe('83.21%');
    expect(formatRateOrReason(null, 'na_zero_budget')).toBe('预算为 0，完成率不适用');
    expect(formatRateOrReason(null, 'na_negative_budget')).toBe('预算为负，完成率不适用');
    expect(formatRateOrReason(null, 'opposite_direction')).toBe('实际与预算方向相反，完成率仅供参考');
    expect(formatRateOrReason(null, null)).toBe('不适用');
    expect(formatRateOrReason(undefined)).toBe('不适用');
    expect(formatRateOrReason(null, 'unknown_code')).toBe('不适用');
  });
});

describe('formatQuantity(10^4 缩放数量展示)', () => {  it('最小缩放单位 1 显示为 0.0001,不被吞成 0', () => {
    expect(formatQuantity(1)).toBe('0.0001');
    expect(formatQuantity(-1)).toBe('-0.0001');
  });

  it('去掉多余尾零并加千分位', () => {
    expect(formatQuantity(12_345_678)).toBe('1,234.5678');
    expect(formatQuantity(10_000)).toBe('1');
    expect(formatQuantity(15_000)).toBe('1.5');
    expect(formatQuantity(123_456_780)).toBe('12,345.678');
  });

  it('零与负零缩放值都显示为 0,不带负号', () => {
    expect(formatQuantity(0)).toBe('0');
  });

  it('负数带千分位与四位小数', () => {
    expect(formatQuantity(-12_345_678)).toBe('-1,234.5678');
  });

  it('可附加计量单位', () => {
    expect(formatQuantity(12_345_678, '万度')).toBe('1,234.5678 万度');
  });

  it('大安全整数不丢失精度', () => {
    expect(formatQuantity(9_007_199_254_740_991)).toBe('900,719,925,474.0991');
  });
});
