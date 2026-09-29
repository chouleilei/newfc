/**
 * OPEN-02 金额/定点数契约:边界、舍入、范围、缺失与零、SQLite 64 位往返、分摊守恒。
 */
import { describe, it, expect } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import Database from 'better-sqlite3';
import {
  allocateCents, centsToDecimalOrNull, centsToDecimalString, centsToSafeNumber, formatScaled, INT64_MAX, INT64_MIN,
  mulCents, parseDecimalToCents, parseScaled, ratioString, ratioToPercentText, sumCents, toCentsBig,
} from '../src/core/decimal';

describe('金额解析与序列化', () => {
  it('十进制解析不经浮点;千分位合法;超两位小数默认拒绝', () => {
    expect(parseDecimalToCents('0.1')).toBe(10n);
    expect(parseDecimalToCents('-1,234,567.89')).toBe(-123456789n);
    expect(parseDecimalToCents('12.300')).toBe(1230n);
    expect(() => parseDecimalToCents('12.345')).toThrow(/最多 2 位小数/);
    expect(parseDecimalToCents('12.345', { rounding: 'half-up' })).toBe(1235n);
    expect(parseDecimalToCents('-12.345', { rounding: 'half-up' })).toBe(-1235n);
    expect(parseDecimalToCents('12.349', { rounding: 'down' })).toBe(1234n);
    for (const bad of ['1,23,4', '1e5', '', ' ', '.5', 'NaN', '12..3', '--1']) expect(() => parseDecimalToCents(bad)).toThrow();
    expect(() => parseDecimalToCents(0.1)).toThrow(/十进制字符串/);
    expect(parseDecimalToCents(12)).toBe(1200n);
  });

  it('Numeric(18,2) 量程在 64 位内可精确表示;超出 64 位报 VALUE_OUT_OF_RANGE', () => {
    const max182 = '9999999999999999.99';
    const cents = parseDecimalToCents(max182);
    expect(cents).toBe(999999999999999999n);
    expect(centsToDecimalString(cents)).toBe(max182);
    expect(centsToDecimalString(INT64_MAX)).toBe('92233720368547758.07');
    expect(() => parseDecimalToCents('92233720368547758.08')).toThrow(expect.objectContaining({ code: 'VALUE_OUT_OF_RANGE' }));
    expect(parseDecimalToCents('-92233720368547758.08')).toBe(INT64_MIN);
    expect(() => sumCents([INT64_MAX, 1n])).toThrow(expect.objectContaining({ code: 'VALUE_OUT_OF_RANGE' }));
  });

  it('与继承 number 金额的交界显式收窄,超安全整数报错而不是丢精度', () => {
    expect(centsToSafeNumber(123n)).toBe(123);
    expect(() => centsToSafeNumber(BigInt(Number.MAX_SAFE_INTEGER) + 1n)).toThrow(/安全整数/);
    expect(toCentsBig(-5)).toBe(-5n);
    expect(() => toCentsBig(1.5)).toThrow();
  });

  it('缺失与零严格区分', () => {
    expect(centsToDecimalOrNull(null)).toBeNull();
    expect(centsToDecimalOrNull(undefined)).toBeNull();
    expect(centsToDecimalOrNull(0n)).toBe('0.00');
    expect(centsToDecimalString(-5)).toBe('-0.05');
  });

  it('SQLite INTEGER 64 位往返:safeIntegers 模式无损,默认模式会静默丢精度(故新领域金额列必须 safeIntegers)', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'newfc-decimal-'));
    const db = new Database(path.join(dir, 't.sqlite'));
    try {
      db.exec('CREATE TABLE m (amount_cents INTEGER NOT NULL)');
      const big = parseDecimalToCents('9999999999999999.99');
      db.prepare('INSERT INTO m VALUES (?)').run(big);
      db.prepare('INSERT INTO m VALUES (?)').run(1n);
      const row = db.prepare('SELECT amount_cents AS a FROM m ORDER BY rowid LIMIT 1').safeIntegers(true).get() as { a: bigint };
      expect(row.a).toBe(big);
      const lossy = db.prepare('SELECT amount_cents AS a FROM m ORDER BY rowid LIMIT 1').get() as { a: number };
      expect(typeof lossy.a).toBe('number');
      expect(BigInt(lossy.a)).not.toBe(big);
      const total = db.prepare('SELECT SUM(amount_cents) AS s FROM m').safeIntegers(true).get() as { s: bigint };
      expect(centsToDecimalString(total.s)).toBe('10000000000000000.00');
      // BigInt 不能直接 JSON 序列化:API 必须经 centsToDecimalString
      expect(() => JSON.stringify({ a: row.a })).toThrow(TypeError);
      expect(JSON.stringify({ a: centsToDecimalString(row.a) })).toBe('{"a":"9999999999999999.99"}');
    } finally {
      db.close();
    }
  });
});

describe('定点乘法、分摊与比率', () => {
  it('单价×数量按 half-up 舍入到分', () => {
    // 3 件 × 单价 33.333333(scale 6)= 99.999999 元 -> 100.00 元
    const unitPriceCents = parseScaled('3333.3333', 4); // 单价(分)的 4 位小数
    expect(mulCents(3n, unitPriceCents, 4)).toBe(10000n);
    expect(mulCents(-3n, unitPriceCents, 4)).toBe(-10000n);
    expect(mulCents(100n, parseScaled('0.125', 3), 3, 'down')).toBe(12n);
  });

  it('分摊守恒:各份之和严格等于总额,余数按最大余数、并列按顺序', () => {
    expect(allocateCents(100n, [1n, 1n, 1n])).toEqual([34n, 33n, 33n]);
    expect(allocateCents(-100n, [1n, 1n, 1n])).toEqual([-34n, -33n, -33n]);
    expect(allocateCents(1000n, [0n, 3n, 7n])).toEqual([0n, 300n, 700n]);
    const weights = [17n, 29n, 31n, 1n, 0n, 1000003n];
    const parts = allocateCents(999999999999999999n, weights);
    expect(parts.reduce((a, b) => a + b, 0n)).toBe(999999999999999999n);
    expect(parts[4]).toBe(0n);
    expect(() => allocateCents(10n, [0n, 0n])).toThrow(expect.objectContaining({ code: 'ALLOCATION_BASIS_EMPTY' }));
    expect(() => allocateCents(10n, [-1n, 2n])).toThrow();
  });

  it('比率为 0～1 口径字符串;分母为零返回 null 而非 0;百分数只做展示', () => {
    expect(ratioString(1, 3)).toBe('0.333333');
    expect(ratioString(2, 3)).toBe('0.666667');
    expect(ratioString(-1, 8)).toBe('-0.125000');
    expect(ratioString(5, 0)).toBeNull();
    expect(ratioString(0, 5)).toBe('0.000000');
    expect(ratioToPercentText('0.123456')).toBe('12.35%');
    expect(ratioToPercentText(null)).toBeNull();
    expect(formatScaled(1234500n, 4, false)).toBe('123.45');
  });
});
