/**
 * 金额处理:统一利润方向符号,整数分存储。
 *
 * - 收入 income:正数;成本 cost / 费用 expense:负数。
 * - 界面录入正数,后端按科目类型转换符号;允许录入负的界面金额(冲减、冲回、更正)。
 * - 金额字符串十进制解析转分,不使用浮点乘法。
 */

import { AppError } from './errors';

export type AccountType = 'income' | 'cost' | 'expense' | 'quantity';

/** 科目类型 -> 界面金额符号系数(income=+1, cost/expense=-1;quantity 无金额) */
export const SIGN_BY_TYPE: Record<Exclude<AccountType, 'quantity'>, 1 | -1> = {
  income: 1,
  cost: -1,
  expense: -1,
};

export function isQuantityType(type: string | undefined): type is 'quantity' {
  return type === 'quantity';
}

/** 展示符号:成本/费用为 -1,其余(收入/数量/未知)为 +1;数量型金额恒为 0,符号无影响 */
export function signOfType(type: string | undefined): 1 | -1 {
  return type === 'cost' || type === 'expense' ? -1 : 1;
}

const AMOUNT_RE = /^[+-]?\d{1,15}(\.\d{1,2})?$/;

export class AmountFormatError extends AppError {
  constructor(input: string, hint = '最多两位小数,不超过 15 位整数') {
    super('VALIDATION_FAILED', `金额格式不正确: "${input}"(${hint})`, 400);
    this.name = 'AmountFormatError';
  }
}

/** 数量型科目的存储精度:按 10^4 缩放的整数(如 12345.6789 万度 -> 123456789) */
export const QUANTITY_SCALE = 10_000;

const QUANTITY_RE = /^[+-]?\d{1,12}(\.\d{1,4})?$/;

export class QuantityFormatError extends AppError {
  constructor(input: string) {
    super('VALIDATION_FAILED', `数量格式不正确: "${input}"(最多四位小数,不超过 12 位整数)`, 400);
    this.name = 'QuantityFormatError';
  }
}

/** 数量字符串(界面口径) -> 10^4 缩放整数。十进制解析,不用浮点乘法。 */
export function quantityStringToScaled(input: string | number): number {
  const s = String(input).trim();
  if (!QUANTITY_RE.test(s)) throw new QuantityFormatError(String(input));
  const neg = s.startsWith('-');
  const body = s.replace(/^[+-]/, '');
  const [intPart, fracPart = ''] = body.split('.');
  const frac4 = (fracPart + '0000').slice(0, 4);
  const scaled = Number(intPart) * QUANTITY_SCALE + Number(frac4);
  if (!Number.isSafeInteger(scaled)) throw new QuantityFormatError(String(input));
  return neg ? -scaled : scaled;
}

/** 10^4 缩放整数 -> 数量字符串(去除多余的尾零,如 123450000 -> "12345",123400010 -> "1234.0001") */
export function scaledToQuantityString(scaled: number): string {
  if (!Number.isSafeInteger(scaled)) throw new Error(`非法数量(缩放值): ${scaled}`);
  const neg = scaled < 0;
  const abs = Math.abs(scaled);
  const intPart = Math.floor(abs / QUANTITY_SCALE);
  const frac = String(abs % QUANTITY_SCALE).padStart(4, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${intPart}${frac ? '.' + frac : ''}`;
}

/**
 * 金额字符串(元)转整数分。十进制解析,不用浮点乘法。
 * 支持 "123.45"、"-123.45"、"+123"、"123.4"(视为 123.40)。
 */
export function yuanStringToCents(input: string | number): number {
  const s = String(input).trim();
  if (!AMOUNT_RE.test(s)) throw new AmountFormatError(String(input));
  const neg = s.startsWith('-');
  const body = s.replace(/^[+-]/, '');
  const [intPart, fracPart = ''] = body.split('.');
  const frac2 = (fracPart + '00').slice(0, 2);
  const cents = Number(intPart) * 100 + Number(frac2);
  if (!Number.isSafeInteger(cents)) throw new AmountFormatError(String(input));
  return neg ? -cents : cents;
}

/** 整数分 -> 元字符串(两位小数,带符号) */
export function centsToYuanString(cents: number): string {
  if (!Number.isSafeInteger(cents)) throw new Error(`非法金额(分): ${cents}`);
  const neg = cents < 0;
  const abs = Math.abs(cents);
  const yuan = Math.floor(abs / 100);
  const frac = String(abs % 100).padStart(2, '0');
  return `${neg ? '-' : ''}${yuan}.${frac}`;
}

/**
 * 万元字符串转整数分。十进制解析,不用浮点乘法。
 * 1 万元 = 10,000 元 = 1,000,000 分。
 * 支持 "123.45"、"-123.45"、"0.5" 等(最多 6 位小数)。
 */
export function wanStringToCents(input: string | number): number {
  const raw = String(input).trim();
  const hint = '万元口径:最多六位小数,不超过 11 位整数,可含规范千分位逗号';
  // 先按原始串校验:逗号只允许出现在规范千分位分组位置,拒绝 "1,2,3" 这类错位分组
  if (!/^[+-]?(\d{1,3}(,\d{3})+|\d+)(\.\d{1,6})?$/.test(raw)) throw new AmountFormatError(String(input), hint);
  const s = raw.replace(/,/g, '');
  if (!/^[+-]?\d{1,11}(\.\d{1,6})?$/.test(s)) throw new AmountFormatError(String(input), hint);
  const neg = s.startsWith('-');
  const body = s.replace(/^[+-]/, '');
  const [intPart, fracPart = ''] = body.split('.');
  const frac6 = (fracPart + '000000').slice(0, 6);
  const cents = Number(intPart) * 1_000_000 + Number(frac6);
  if (!Number.isSafeInteger(cents)) throw new AmountFormatError(String(input), hint);
  return neg ? -cents : cents;
}

/** 万元字符串转标准元字符串(两位小数) */
export function wanStringToYuanString(input: string | number): string {
  return centsToYuanString(wanStringToCents(input));
}

/**
 * 分 → 万元文本(两位小数)。纯整数运算,四舍五入到百元,无浮点误差。
 * 万元两位小数对应百元精度,与前端 utils/money 口径一致。
 */
export function centsToWanText(cents: number): string {
  if (!Number.isSafeInteger(cents)) throw new Error(`非法金额(分): ${cents}`);
  const negative = cents < 0;
  const abs = Math.abs(cents);
  // 1 万元 = 1_000_000 分;保留两位小数 => 以 10_000 分(百元)为最小单位。
  const units = Math.floor((abs + 5_000) / 10_000);
  const integerPart = Math.floor(units / 100);
  const decimalPart = units % 100;
  return `${negative && units !== 0 ? '-' : ''}${integerPart}.${String(decimalPart).padStart(2, '0')}`;
}

/**
 * 界面金额(元)按科目类型转带符号存储金额(分)。
 * income:+1,cost/expense:-1;允许负的界面金额。
 */
export function displayToSignedCents(input: string | number, type: Exclude<AccountType, 'quantity'>): number {
  /* +0 归一 -0:cost/expense 显式填 0 时 yuanStringToCents('0.00') * -1 = -0,
     -0 经 JSON.stringify 序列化为 -0、JSON.parse 还原为 -0,与既有 0 不等,
     会让导入撤销的 before/after JSON 比对失败(明明都是 0 却判不一致)。 */
  return yuanStringToCents(input) * SIGN_BY_TYPE[type] + 0;
}

/** 带符号存储金额(分)按科目类型还原为界面展示金额字符串(成本费用显示正数) */
export function signedCentsToDisplay(cents: number, type: Exclude<AccountType, 'quantity'>): string {
  return centsToYuanString(cents * SIGN_BY_TYPE[type]);
}

/** 多个带符号金额求和(利润方向,直接相加) */
export function sumSignedCents(values: number[]): number {
  let total = 0;
  for (const v of values) {
    if (!Number.isSafeInteger(v)) throw new Error(`非法金额(分): ${v}`);
    total += v;
    if (!Number.isSafeInteger(total)) throw new Error('金额汇总超出 JavaScript 安全整数范围');
  }
  return total;
}

/** 定点整数安全加法：金额分值和 10^4 缩放数量的所有核心汇总共用。 */
export function safeIntegerAdd(left: number, right: number, label = '定点数汇总'): number {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right)) throw new Error(`${label}包含非法整数`);
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new Error(`${label}超出 JavaScript 安全整数范围`);
  return result;
}

/**
 * 完成率(展示口径):R = 实际展示金额 / 预算展示金额。
 * 输入为同方向的展示口径金额(非负语义下的业务金额)。
 * 预算为 0 或负数 -> null (N/A);实际为负时返回负比率,由调用方用 actualDisplay < 0 自行标记异常方向。
 */
export function completionRate(actualDisplay: number, budgetDisplay: number): number | null {
  if (budgetDisplay <= 0) return null;
  return actualDisplay / budgetDisplay;
}

/**
 * 比率型指标的存储精度:按 10^6 缩放的定点整数。
 * 百分比口径下 1 个百分点 = 10_000,即百分比保留四位小数。
 */
export const RATIO_SCALE = 1_000_000;

/** 金额(分)换算为自然单位(元)的除数 */
export const MONEY_NATURAL_DIVISOR = 100;

/**
 * 定点比率:(numerator / numeratorDivisor) ÷ (denominator / denominatorDivisor),
 * 结果按 RATIO_SCALE 缩放并四舍五入(远离零)为整数。
 *
 * 用 BigInt 精确运算而非浮点:金额分值乘 10^6 会超出 JavaScript 安全整数范围
 * (约 9007 万元即溢出),浮点除法又会让同一组数在不同调用路径上出现末位差异,
 * 无法满足「穿透明细与报表逐分相等」的守恒要求。
 *
 * @returns 缩放后的整数;分母为 0 时返回 null(N/A,不伪造 0)
 */
export function scaledRatio(
  numerator: number,
  denominator: number,
  numeratorDivisor: number,
  denominatorDivisor: number,
  scale = RATIO_SCALE,
): number | null {
  if (!Number.isSafeInteger(numerator) || !Number.isSafeInteger(denominator)) {
    throw new Error(`比率计算包含非法整数: ${numerator} / ${denominator}`);
  }
  if (denominator === 0) return null;
  // ratio = numerator × denominatorDivisor ÷ (denominator × numeratorDivisor)
  const n = BigInt(numerator) * BigInt(denominatorDivisor) * BigInt(scale);
  const d = BigInt(denominator) * BigInt(numeratorDivisor);
  const negative = (n < 0n) !== (d < 0n);
  const an = n < 0n ? -n : n;
  const ad = d < 0n ? -d : d;
  // 四舍五入远离零:floor(an/ad + 1/2) = (2·an + ad) / (2·ad)
  const q = (2n * an + ad) / (2n * ad);
  const result = negative ? -q : q;
  if (result > BigInt(Number.MAX_SAFE_INTEGER) || result < BigInt(Number.MIN_SAFE_INTEGER)) {
    // 极小分母会产生无法安全表示、也无法可靠展示的比率。按 N/A 降级，
    // 不能让一个异常格拖垮整张报表或使已定稿版本永久 500。
    return null;
  }
  return Number(result);
}

/** 缩放比率 -> 百分比字符串(两位小数);null 显示 N/A */
export function ratioToPercentString(scaled: number | null, fractionDigits = 2): string {
  if (scaled == null) return 'N/A';
  return `${(scaled / RATIO_SCALE * 100).toFixed(fractionDigits)}%`;
}

/** 缩放比率 -> 自然数值字符串(四位小数);null 显示 N/A */
export function ratioToNumberString(scaled: number | null, fractionDigits = 4): string {
  if (scaled == null) return 'N/A';
  return (scaled / RATIO_SCALE).toFixed(fractionDigits);
}
