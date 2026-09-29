import { describe, it, expect } from 'vitest';
// 跨端比对先例见 formula.test.ts:直接从 backend 测试 import 前端工具,
// 让同一数值同时过两端实现,断言方案二.1「前后端换算必须一致」。
import { centsToWan, centsToYuan, wanToCents, yuanToCents } from '../../frontend/src/utils/money';
import {
  AmountFormatError,
  centsToYuanString,
  wanStringToCents,
  yuanStringToCents,
} from '../src/core/money';

/** 元 → 分:前端 yuanToCents(非法返回 null)与后端 yuanStringToCents(非法抛错) */
const YUAN_CASES: { input: string; cents: number }[] = [
  { input: '0.00', cents: 0 },
  { input: '0.01', cents: 1 }, // 最小单位 0.01 元
  { input: '0.29', cents: 29 }, // 浮点敏感值
  { input: '1234.56', cents: 123456 },
  { input: '-9876.54', cents: -987654 }, // 负值
  { input: '1000000.00', cents: 100000000 }, // 大额 1,000,000.00 元
];

/** 万元 → 分:前端 wanToCents 与后端 wanStringToCents */
const WAN_CASES: { input: string; cents: number }[] = [
  { input: '0.00', cents: 0 },
  { input: '0.01', cents: 10000 }, // 最小万元录入单位 = 100 元
  { input: '123.45', cents: 123450000 },
  { input: '-987.65', cents: -987650000 },
  { input: '100.00', cents: 100000000 }, // 100 万 = 1,000,000.00 元
  { input: '1,000,000.00', cents: 1_000_000_000_000 }, // 千分位展示值(两端均去 ASCII 逗号)
];

/** 分 → 元字符串:前端 centsToYuan 与后端 centsToYuanString */
const CENTS_TO_YUAN_CASES: { cents: number; yuan: string }[] = [
  { cents: 0, yuan: '0.00' },
  { cents: 1, yuan: '0.01' },
  { cents: 123456, yuan: '1234.56' },
  { cents: -987654, yuan: '-9876.54' },
  { cents: 100000000, yuan: '1000000.00' },
];

describe('前后端换算一致性(方案二.1)', () => {
  it.each(YUAN_CASES)('元→分: $input', ({ input, cents }) => {
    expect(yuanToCents(input)).toBe(cents);
    expect(yuanStringToCents(input)).toBe(cents);
  });

  it.each(WAN_CASES)('万元→分: $input', ({ input, cents }) => {
    expect(wanToCents(input)).toBe(cents);
    expect(wanStringToCents(input)).toBe(cents);
  });

  it.each(CENTS_TO_YUAN_CASES)('分→元: $cents 分', ({ cents, yuan }) => {
    // 两端输出字符串逐字相等(均无千分位、两位小数、带符号)
    expect(centsToYuan(cents)).toBe(yuan);
    expect(centsToYuanString(cents)).toBe(yuan);
  });

  describe('分→万元展示(前端 centsToWan,后端无对等函数,以 wanStringToCents 回读做数值比对)', () => {
    const EXACT_CASES: { cents: number; wan: string }[] = [
      { cents: 0, wan: '0.00' },
      { cents: 10000, wan: '0.01' },
      { cents: 123450000, wan: '123.45' },
      { cents: -987650000, wan: '-987.65' },
      { cents: 1_000_000_000_000, wan: '1,000,000.00' },
    ];
    it.each(EXACT_CASES)('$cents 分 → "$wan" 万元', ({ cents, wan }) => {
      const display = centsToWan(cents);
      expect(display).toBe(wan);
      // 千分位逗号是合法格式差异:后端解析时去逗号,断言数值等价而非字符串全等
      expect(wanStringToCents(display)).toBe(cents);
    });

    it('非百元整倍数按两位小数万元口径舍入(方案二.1 规定的展示精度,非缺陷)', () => {
      // 123456 分 = 1234.56 元 = 0.123456 万 → 两位小数万元展示为 0.12 万
      const display = centsToWan(123456);
      expect(display).toBe('0.12');
      // 回读后与原始分值差一个百元以内的舍入量,数值等于「分按万元两位小数四舍五入」
      expect(wanStringToCents(display)).toBe(Math.round(123456 / 10000) * 10000);
      expect(wanStringToCents(display)).not.toBe(123456);
    });
  });

  describe('两端合法格式差异(断言现状,不修改代码)', () => {
    it('中文千分位逗号:前端容错接受,后端只去 ASCII 逗号', () => {
      expect(wanToCents('1，000.00')).toBe(1_000_000_000);
      expect(() => wanStringToCents('1，000.00')).toThrow(AmountFormatError);
    });

    it('万元小数位:后端接受最多 6 位(可到分),前端录入口径最多 2 位', () => {
      expect(wanStringToCents('0.000001')).toBe(1); // 0.000001 万 = 0.01 元
      expect(wanToCents('0.000001')).toBeNull();
    });
  });
});
