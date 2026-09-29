import { describe, it, expect } from 'vitest';
import { decimalSign, formatByUnit, formatMoney, formatRatioPercent } from './decimal';

describe('十进制字符串展示', () => {
  it('金额千分位,不经过 number', () => {
    expect(formatMoney('1000000.00')).toBe('1,000,000.00');
    expect(formatMoney('-900000.5')).toBe('-900,000.50');
    expect(formatMoney('92233720368547758.07')).toBe('92,233,720,368,547,758.07');
    expect(formatMoney('0')).toBe('0.00');
    expect(formatMoney(null)).toBe('—');
  });
  it('比率转百分比,截断不四舍五入', () => {
    expect(formatRatioPercent('0.420000')).toBe('42.00%');
    expect(formatRatioPercent('0.933333')).toBe('93.33%');
    expect(formatRatioPercent('1.200000')).toBe('120.00%');
    expect(formatRatioPercent('-0.05')).toBe('-5.00%');
    expect(formatRatioPercent(null)).toBe('—');
    expect(formatByUnit('0.8', 'ratio')).toBe('80.00%');
    expect(formatByUnit('80', 'money')).toBe('80.00');
  });
  it('符号', () => {
    expect(decimalSign('-0.00')).toBe(0);
    expect(decimalSign('-1.00')).toBe(-1);
    expect(decimalSign('0.01')).toBe(1);
  });
});
