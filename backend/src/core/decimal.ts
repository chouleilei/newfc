/**
 * newfc 金额/定点数契约(OPEN-02)。
 *
 * - 金额:整数分,新领域以 bigint 计算,范围为 SQLite 有符号 64 位;API 一律返回十进制字符串。
 * - 数量、单价、比率:各自显式 scale 的缩放 bigint(scaled = value * 10^scale),不经过浮点。
 * - 舍入只在明确步骤发生,模式为 ROUND_HALF_UP(远离零);解析输入默认拒绝超精度而不是静默舍入。
 * - 继承的 number 金额(core/money.ts)保持安全整数校验;两者交界处用 centsToSafeNumber / toCentsBig 显式转换。
 * - SQLite 读取可能超安全范围的金额列时,语句必须 .safeIntegers(true):better-sqlite3 默认模式会静默转成
 *   不精确的 number(见 tests/decimal-contract.test.ts)。
 */
import { AppError } from './errors';

export const INT64_MAX = 9_223_372_036_854_775_807n;
export const INT64_MIN = -9_223_372_036_854_775_808n;

export type Rounding = 'reject' | 'half-up' | 'down';

export class DecimalFormatError extends AppError {
  constructor(input: unknown, hint: string) {
    super('VALIDATION_FAILED', `数值格式不正确: "${String(input)}"(${hint})`, 400);
    this.name = 'DecimalFormatError';
  }
}

export class DecimalRangeError extends AppError {
  constructor(label: string) {
    super('VALUE_OUT_OF_RANGE', `${label}超出可支持范围(有符号 64 位定点数)`, 400);
    this.name = 'DecimalRangeError';
  }
}

const DECIMAL_RE = /^([+-])?(\d+)(?:\.(\d+))?$/;
const GROUPED_RE = /^[+-]?\d{1,3}(,\d{3})+(\.\d+)?$/;

function checkRange(value: bigint, label: string): bigint {
  if (value > INT64_MAX || value < INT64_MIN) throw new DecimalRangeError(label);
  return value;
}

function roundDiv(numerator: bigint, denominator: bigint, rounding: Exclude<Rounding, 'reject'>): bigint {
  if (denominator === 0n) throw new Error('除数为零');
  const neg = (numerator < 0n) !== (denominator < 0n);
  const n = numerator < 0n ? -numerator : numerator;
  const d = denominator < 0n ? -denominator : denominator;
  let q = n / d;
  if (rounding === 'half-up' && (n % d) * 2n >= d) q += 1n;
  return neg ? -q : q;
}

/**
 * 十进制字符串 -> scale 位缩放 bigint。
 * 允许规范千分位逗号;超过 scale 位小数时按 rounding 处理(默认拒绝)。
 * number 输入只接受安全整数,避免浮点二进制误差进入金额。
 */
export function parseScaled(input: string | number | bigint, scale: number, opts: { rounding?: Rounding; label?: string } = {}): bigint {
  const label = opts.label ?? '数值';
  if (typeof input === 'bigint') return checkRange(input * 10n ** BigInt(scale), label);
  if (typeof input === 'number') {
    if (!Number.isSafeInteger(input)) throw new DecimalFormatError(input, `${label}的非整数请以十进制字符串传入`);
    return checkRange(BigInt(input) * 10n ** BigInt(scale), label);
  }
  let s = String(input).trim();
  if (s.includes(',')) {
    if (!GROUPED_RE.test(s)) throw new DecimalFormatError(input, '千分位逗号位置不规范');
    s = s.replace(/,/g, '');
  }
  const m = DECIMAL_RE.exec(s);
  if (!m) throw new DecimalFormatError(input, `${label}须为十进制数字`);
  const [, sign, intPart, frac = ''] = m;
  if (intPart.length > 19) throw new DecimalRangeError(label);
  let scaled: bigint;
  if (frac.length <= scale) {
    scaled = BigInt(intPart + frac.padEnd(scale, '0'));
  } else {
    const rounding = opts.rounding ?? 'reject';
    if (rounding === 'reject' && /[1-9]/.test(frac.slice(scale))) {
      throw new DecimalFormatError(input, `${label}最多 ${scale} 位小数`);
    }
    const full = BigInt(intPart + frac);
    scaled = rounding === 'reject' ? full / 10n ** BigInt(frac.length - scale) : roundDiv(full, 10n ** BigInt(frac.length - scale), rounding);
  }
  return checkRange(sign === '-' ? -scaled : scaled, label);
}

/** 缩放 bigint -> 十进制字符串。fixed=true 保留全部 scale 位(金额),否则去尾零(数量/比率)。 */
export function formatScaled(value: bigint | number, scale: number, fixed = true): string {
  const v = typeof value === 'bigint' ? value : toBigIntStrict(value);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  if (scale === 0) return `${neg ? '-' : ''}${abs}`;
  const base = 10n ** BigInt(scale);
  let frac = (abs % base).toString().padStart(scale, '0');
  if (!fixed) frac = frac.replace(/0+$/, '');
  return `${neg ? '-' : ''}${abs / base}${frac ? '.' + frac : ''}`;
}

function toBigIntStrict(value: number): bigint {
  if (!Number.isSafeInteger(value)) throw new Error(`非法定点数: ${value}`);
  return BigInt(value);
}

/* ---------------- 金额(分) ---------------- */

/** 元字符串 -> 分(bigint)。默认拒绝超过两位小数。 */
export function parseDecimalToCents(input: string | number | bigint, opts: { rounding?: Rounding; label?: string } = {}): bigint {
  return parseScaled(input, 2, { label: opts.label ?? '金额', rounding: opts.rounding });
}

/** 分(bigint 或安全整数)-> 两位小数元字符串,API 返回金额的唯一序列化方式。 */
export function centsToDecimalString(cents: bigint | number): string {
  return formatScaled(cents, 2, true);
}

/** 可空金额:缺失(null/undefined)与零严格区分。 */
export function centsToDecimalOrNull(cents: bigint | number | null | undefined): string | null {
  return cents === null || cents === undefined ? null : centsToDecimalString(cents);
}

/** 读自 SQLite 的整数列(number 或 safeIntegers 模式下的 bigint)统一为 bigint。 */
export function toCentsBig(value: bigint | number | null | undefined): bigint {
  if (value === null || value === undefined) return 0n;
  return typeof value === 'bigint' ? value : toBigIntStrict(value);
}

/** 交给继承的 number 金额路径前的显式收窄;超安全整数范围时报错而不是丢精度。 */
export function centsToSafeNumber(cents: bigint, label = '金额'): number {
  if (cents > BigInt(Number.MAX_SAFE_INTEGER) || cents < BigInt(Number.MIN_SAFE_INTEGER)) {
    throw new DecimalRangeError(`${label}(超过 JavaScript 安全整数)`);
  }
  return Number(cents);
}

/** 带 64 位溢出检查的求和。 */
export function sumCents(values: Iterable<bigint | number | null | undefined>, label = '金额汇总'): bigint {
  let total = 0n;
  for (const v of values) total = checkRange(total + toCentsBig(v), label);
  return total;
}

/** 金额 × 定点系数(如单价×数量、比例分摊),结果回到分并按指定舍入。 */
export function mulCents(cents: bigint, factorScaled: bigint, factorScale: number, rounding: Exclude<Rounding, 'reject'> = 'half-up'): bigint {
  return checkRange(roundDiv(cents * factorScaled, 10n ** BigInt(factorScale), rounding), '金额乘积');
}

/**
 * 按权重分摊金额,最大余数法保证各份之和严格等于总额(分摊守恒)。
 * 权重为非负 bigint;全部为零时报错,由调用方决定缺省口径。
 */
export function allocateCents(total: bigint, weights: readonly bigint[]): bigint[] {
  if (weights.some((w) => w < 0n)) throw new DecimalFormatError(weights.join(','), '分摊权重不可为负');
  const weightSum = weights.reduce((a, b) => a + b, 0n);
  if (weightSum === 0n) throw new AppError('ALLOCATION_BASIS_EMPTY', '分摊基数合计为零,无法分摊', 422);
  const neg = total < 0n;
  const abs = neg ? -total : total;
  const shares = weights.map((w) => (abs * w) / weightSum);
  const remainders = weights.map((w, i) => ({ i, r: (abs * w) % weightSum }));
  let left = abs - shares.reduce((a, b) => a + b, 0n);
  remainders.sort((a, b) => (a.r === b.r ? a.i - b.i : a.r > b.r ? -1 : 1));
  for (const { i } of remainders) {
    if (left === 0n) break;
    shares[i] += 1n;
    left -= 1n;
  }
  return neg ? shares.map((s) => -s) : shares;
}

/* ---------------- 比率 ---------------- */

/** 比率默认 6 位小数(0.123456 = 12.3456%);分母为零返回 null(不可计算,不等于 0)。 */
export const RATIO_SCALE = 6;

export function ratioScaled(numerator: bigint | number, denominator: bigint | number, scale = RATIO_SCALE): bigint | null {
  const n = typeof numerator === 'bigint' ? numerator : toBigIntStrict(numerator);
  const d = typeof denominator === 'bigint' ? denominator : toBigIntStrict(denominator);
  if (d === 0n) return null;
  return roundDiv(n * 10n ** BigInt(scale), d, 'half-up');
}

/** 比率字符串(0～1 口径,不是百分数)。 */
export function ratioString(numerator: bigint | number, denominator: bigint | number, scale = RATIO_SCALE): string | null {
  const r = ratioScaled(numerator, denominator, scale);
  return r === null ? null : formatScaled(r, scale, false);
}

/** 显示用百分数字符串:仅用于界面/报告文本,不回写计算。 */
export function ratioToPercentText(ratio: string | null, digits = 2): string | null {
  if (ratio === null) return null;
  const scaled = parseScaled(ratio, digits + 2, { rounding: 'half-up', label: '比率' });
  return `${formatScaled(scaled, digits, true)}%`;
}
