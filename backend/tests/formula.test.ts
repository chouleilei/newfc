import { describe, it, expect } from 'vitest';
import { evaluateFormula, isFormula } from '../../frontend/src/utils/formula';

describe('公式引擎 (formula.ts)', () => {
  it('识别公式 isFormula', () => {
    expect(isFormula('=1+1')).toBe(true);
    expect(isFormula(' = 35 * 12 ')).toBe(true);
    expect(isFormula('100.50')).toBe(false);
    expect(isFormula('')).toBe(false);
    expect(isFormula(null)).toBe(false);
  });

  it('四则运算与运算符优先级', () => {
    const res1 = evaluateFormula('=35*1.2*12');
    expect(res1.ok).toBe(true);
    expect(res1.value).toBe(504);

    const res2 = evaluateFormula('=10 + 20 * 3');
    expect(res2.ok).toBe(true);
    expect(res2.value).toBe(70);

    const res3 = evaluateFormula('=(10 + 20) * 3');
    expect(res3.ok).toBe(true);
    expect(res3.value).toBe(90);
  });

  it('百分比与税率计算 (如 13%)', () => {
    const res = evaluateFormula('=300 / (1 + 13%)', 2);
    expect(res.ok).toBe(true);
    expect(res.value).toBe(265.49);
    expect(res.display).toBe('265.49');
  });

  it('负数与一元运算符', () => {
    const res1 = evaluateFormula('=-10 + 5');
    expect(res1.ok).toBe(true);
    expect(res1.value).toBe(-5);

    const res2 = evaluateFormula('=- (20 + 30) * 2');
    expect(res2.ok).toBe(true);
    expect(res2.value).toBe(-100);
  });

  it('千分位逗号与空格容错', () => {
    const res = evaluateFormula(' = 1,200.50 + 800.50 ');
    expect(res.ok).toBe(true);
    expect(res.value).toBe(2001);
  });

  it('异常处理 (除以零、括号不匹配、非法字符)', () => {
    const divZero = evaluateFormula('=100 / 0');
    expect(divZero.ok).toBe(false);
    expect(divZero.error).toContain('除数不能为 0');

    const unclosed = evaluateFormula('=(10 + 20');
    expect(unclosed.ok).toBe(false);
    expect(unclosed.error).toContain('括号不匹配');

    const invalidChar = evaluateFormula('=10 + abc');
    expect(invalidChar.ok).toBe(false);
    expect(invalidChar.error).toContain('无法识别');
  });
});
