/**
 * 高精度定点小数(T-5 投资/预测计算,OPEN-06)。
 *
 * 值为 bigint,按 10^18 缩放;加减精确,乘除在第 18 位小数按 HALF_UP(远离零)舍入,
 * 幂只支持整数指数。对外输出前用 quantize(x, dp) 量化(同 Python Decimal quantize ROUND_HALF_UP)。
 * 全程不经过 number 浮点;解析拒绝科学计数与非有限值。
 */

export type Fx = bigint;

export const FX_SCALE = 18;
export const FX_ONE: Fx = 10n ** 18n;
export const FX_ZERO: Fx = 0n;

const DECIMAL_RE = /^([+-])?(\d+)(?:\.(\d+))?$/;

export class FxError extends Error {
  constructor(message: string, readonly code: 'FX_FORMAT' | 'FX_DIV_ZERO' | 'FX_RANGE' = 'FX_FORMAT') {
    super(message);
  }
}

/** 整数除法,HALF_UP(远离零)。 */
export function divRound(n: bigint, d: bigint): bigint {
  if (d === 0n) throw new FxError('除数为零', 'FX_DIV_ZERO');
  const q = n / d;
  const r = n % d;
  if (r === 0n) return q;
  const absR2 = (r < 0n ? -r : r) * 2n;
  const absD = d < 0n ? -d : d;
  if (absR2 >= absD) return q + ((n < 0n) !== (d < 0n) ? -1n : 1n);
  return q;
}

/** 解析十进制字符串/整数;超过 18 位小数按 HALF_UP 舍入。maxDp 给定时超过即报错。 */
export function fx(input: string | number | bigint, opts: { maxDp?: number; label?: string } = {}): Fx {
  const label = opts.label ?? '数值';
  if (typeof input === 'bigint') return input * FX_ONE;
  if (typeof input === 'number') {
    if (!Number.isFinite(input)) throw new FxError(`${label}不是有限数`);
    if (Number.isInteger(input)) {
      if (!Number.isSafeInteger(input)) throw new FxError(`${label}超出安全整数范围`, 'FX_RANGE');
      return BigInt(input) * FX_ONE;
    }
    input = String(input);
    if (/e/i.test(input)) throw new FxError(`${label}不支持科学计数`);
  }
  const text = input.trim();
  const m = DECIMAL_RE.exec(text);
  if (!m) throw new FxError(`${label}格式无效:${text.slice(0, 40)}`);
  const [, sign, intPart, fracRaw = ''] = m;
  if (opts.maxDp != null && fracRaw.replace(/0+$/, '').length > opts.maxDp) throw new FxError(`${label}最多 ${opts.maxDp} 位小数`);
  let value: bigint;
  if (fracRaw.length <= FX_SCALE) {
    value = BigInt(intPart) * FX_ONE + BigInt((fracRaw + '0'.repeat(FX_SCALE)).slice(0, FX_SCALE) || '0');
  } else {
    const extra = fracRaw.length - FX_SCALE;
    value = divRound(BigInt(intPart + fracRaw), 10n ** BigInt(extra));
  }
  return sign === '-' ? -value : value;
}

export const fxInt = (n: number): Fx => {
  if (!Number.isSafeInteger(n)) throw new FxError('整数超出范围', 'FX_RANGE');
  return BigInt(n) * FX_ONE;
};

export const add = (...xs: Fx[]): Fx => xs.reduce((a, b) => a + b, 0n);
export const sub = (a: Fx, b: Fx): Fx => a - b;
export const neg = (a: Fx): Fx => -a;
export const mul = (a: Fx, b: Fx): Fx => divRound(a * b, FX_ONE);
export const div = (a: Fx, b: Fx): Fx => {
  if (b === 0n) throw new FxError('除数为零', 'FX_DIV_ZERO');
  return divRound(a * FX_ONE, b);
};
export const abs = (a: Fx): Fx => (a < 0n ? -a : a);
export const sign = (a: Fx): -1 | 0 | 1 => (a > 0n ? 1 : a < 0n ? -1 : 0);
export const max = (a: Fx, b: Fx): Fx => (a >= b ? a : b);
export const min = (a: Fx, b: Fx): Fx => (a <= b ? a : b);

/** 整数次幂;负指数取倒数。结果按 18 位舍入(平方-乘法,每步舍入)。 */
export function powInt(base: Fx, exp: number): Fx {
  if (!Number.isInteger(exp)) throw new FxError('只支持整数次幂', 'FX_RANGE');
  if (Math.abs(exp) > 10_000) throw new FxError('指数过大', 'FX_RANGE');
  if (exp < 0) return div(FX_ONE, powInt(base, -exp));
  let result = FX_ONE;
  let b = base;
  let e = exp;
  while (e > 0) {
    if (e & 1) result = mul(result, b);
    e >>= 1;
    if (e > 0) b = mul(b, b);
  }
  return result;
}

/** 量化到 dp 位小数(HALF_UP),结果仍是 Fx。 */
export function quantize(a: Fx, dp: number): Fx {
  if (dp >= FX_SCALE) return a;
  const unit = 10n ** BigInt(FX_SCALE - dp);
  return divRound(a, unit) * unit;
}

/** 固定 dp 位小数的字符串(先 HALF_UP 量化)。 */
export function toFixed(a: Fx, dp: number): string {
  const q = quantize(a, dp);
  const negative = q < 0n;
  const absq = negative ? -q : q;
  const intPart = absq / FX_ONE;
  if (dp === 0) return `${negative && intPart !== 0n ? '-' : ''}${intPart}`;
  const frac = (absq % FX_ONE).toString().padStart(FX_SCALE, '0').slice(0, dp);
  const isZero = intPart === 0n && /^0*$/.test(frac);
  return `${negative && !isZero ? '-' : ''}${intPart}.${frac}`;
}

/** 转为向零取整的 JS 整数(仅用于年份/序号等小整数)。 */
export function toIntTrunc(a: Fx): number {
  const n = a / FX_ONE;
  if (n > BigInt(Number.MAX_SAFE_INTEGER) || n < BigInt(Number.MIN_SAFE_INTEGER)) throw new FxError('整数超出范围', 'FX_RANGE');
  return Number(n);
}

/** Fx(元)→ 整数分(HALF_UP)。 */
export function toCents(a: Fx): bigint {
  return divRound(a, 10n ** BigInt(FX_SCALE - 2));
}

/** 整数分 → Fx(元)。 */
export function fromCents(cents: bigint | number): Fx {
  return BigInt(cents) * 10n ** BigInt(FX_SCALE - 2);
}

/** 万元(Fx)→ 整数分:×10000 后取分,超过分精度时报错(不静默舍入)。 */
export function wanToCentsExact(a: Fx, label = '金额'): bigint {
  const yuanScaled = a * 10_000n;
  const unit = 10n ** BigInt(FX_SCALE - 2);
  if (yuanScaled % unit !== 0n) throw new FxError(`${label}折合元超过两位小数`);
  return yuanScaled / unit;
}
