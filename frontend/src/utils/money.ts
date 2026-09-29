/** 前端金额工具:金额一律字符串传输,展示两位小数(与后端口径一致) */

import { z } from 'zod';

/** 网格录入口径为万元(最多两位小数;11 位整数上限与 wanToCents 一致,换算后元位数 ≤ 15) */
const AMOUNT_RE = /^[+-]?\d{1,11}(\.\d{1,2})?$/;

/** 网格展示可能带千分位；校验与精确换算统一先去除中英文逗号。 */
function ungroupNumber(value: string): string {
  return value.trim().replace(/[,，]/g, '');
}

export const amountSchema = z
  .string()
  .trim()
  .refine((value) => AMOUNT_RE.test(ungroupNumber(value)), '金额格式不正确(万元,最多两位小数,不超过 11 位整数)')
  .refine((value) => wanToCents(value) != null, '金额超过系统可精确表示的最大值');

/** 数量型科目录入(最多四位小数,不超过 12 位整数) */
const QUANTITY_RE = /^[+-]?\d{1,12}(\.\d{1,4})?$/;

export const quantitySchema = z
  .string()
  .trim()
  .refine((value) => QUANTITY_RE.test(ungroupNumber(value)), '数量格式不正确(最多四位小数)')
  .refine((value) => quantityToScaled(value) != null, '数量超过系统可精确表示的最大值');

/** 分 -> 元字符串 */
export function centsToYuan(cents: number): string {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  return `${neg ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}

/** 分 -> 元字符串(千分位,精确到分)。供「万元概览 / 精确元核对」的查看层使用,与显示舍入无关 */
export function centsToYuanGrouped(cents: number): string {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  return `${neg && abs !== 0 ? '-' : ''}${Math.floor(abs / 100).toLocaleString('zh-CN')}.${String(abs % 100).padStart(2, '0')}`;
}

/** 后端 rateSpecial(完成率特殊状态)的业务原因文案,替代光秃秃的 N/A */
export const RATE_SPECIAL_TEXT: Record<string, string> = {
  na_zero_budget: '预算为 0，完成率不适用',
  na_negative_budget: '预算为负，完成率不适用',
  opposite_direction: '实际与预算方向相反，完成率仅供参考',
};

/** 完成率展示:有值给百分比;无值给服务端特殊状态对应的原因,都没有则为「不适用」 */
export function formatRateOrReason(rate: number | null | undefined, rateSpecial?: string | null): string {
  if (rate != null && !Number.isNaN(rate)) return formatRate(rate);
  return (rateSpecial != null && RATE_SPECIAL_TEXT[rateSpecial]) || '不适用';
}

/** 按类型还原界面展示金额(成本费用显示正数) */
export function displayAmount(cents: number, type?: string): string {
  if (type === 'cost' || type === 'expense') return centsToYuan(-cents);
  return centsToYuan(cents);
}

export function formatRate(rate: number | null | undefined): string {
  if (rate == null || Number.isNaN(rate)) return 'N/A';
  return `${(rate * 100).toFixed(2)}%`;
}

export function formatProgress(v: number | null | undefined): string {
  return v == null ? 'N/A' : `${(v * 100).toFixed(2)}%`;
}

export const ACCOUNT_TYPE_LABEL: Record<string, string> = {
  income: '收入',
  cost: '成本',
  expense: '费用',
  quantity: '数量',
};

export const SIGN_OF_TYPE: Record<string, 1 | -1> = { income: 1, cost: -1, expense: -1, quantity: 1 };

/** 展示符号:成本/费用为 -1,其余(收入/数量/未知)为 +1;数量型金额恒为 0,符号无影响 */
export function signOfType(type: string | undefined): 1 | -1 {
  return type === 'cost' || type === 'expense' ? -1 : 1;
}

/* ============ 万元口径(界面展示与录入统一单位:万元,2 位小数;存储仍为分) ============ */

/** 每万元对应的分数:10000 元 × 100 */
const CENTS_PER_WAN = 1_000_000;

function group2(n: number): string {
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** 分 -> 万元字符串(2 位小数,千分位),如 123456789 -> '123.46'。纯整数运算(四舍五入到百元),与后端 centsToWanText 同口径,无浮点舍入误差 */
export function centsToWan(cents: number): string {
  const neg = cents < 0;
  const abs = Math.abs(cents);
  // 1 万元 = 1_000_000 分;保留两位小数 => 以 10_000 分(百元)为最小单位
  const units = Math.floor((abs + 5_000) / 10_000);
  const integerPart = Math.floor(units / 100);
  const decimalPart = units % 100;
  const s = `${integerPart.toLocaleString('zh-CN')}.${String(decimalPart).padStart(2, '0')}`;
  return neg && units !== 0 ? `-${s}` : s;
}

/** 万元字符串 -> 分(字符串精确解析,最多 2 位小数;11 位整数上限保证换算后元位数 ≤ 15)。非法返回 null */
export function wanToCents(display: string): number | null {
  const t = ungroupNumber(display);
  if (!/^[+-]?\d{1,11}(\.\d{1,2})?$/.test(t)) return null;
  const neg = t.startsWith('-');
  const body = t.replace(/^[+-]/, '');
  const [i, f = ''] = body.split('.');
  const cents = Number(i) * CENTS_PER_WAN + Number((f + '00').slice(0, 2)) * 10_000;
  if (!Number.isSafeInteger(cents)) return null;
  return neg ? -cents : cents;
}

/** 元字符串(后端传输口径) -> 分。非法返回 null */
export function yuanToCents(yuan: string): number | null {
  const t = yuan.trim();
  if (!/^[+-]?\d{1,15}(\.\d{1,2})?$/.test(t)) return null;
  const neg = t.startsWith('-');
  const body = t.replace(/^[+-]/, '');
  const [i, f = ''] = body.split('.');
  const cents = Number(i) * 100 + Number((f + '00').slice(0, 2));
  if (!Number.isSafeInteger(cents)) return null;
  return neg ? -cents : cents;
}

/** 后端返回的元字符串 -> 万元显示字符串(加载方向换算) */
export function yuanToWanDisplay(yuan: string): string {
  const cents = yuanToCents(yuan);
  return cents == null ? yuan : centsToWan(cents);
}

/** 万元显示字符串 -> 元字符串(保存方向换算,供 API 提交)。非法返回 null */
export function wanDisplayToYuan(display: string): string | null {
  const cents = wanToCents(display);
  return cents == null ? null : centsToYuan(cents);
}

/** 两个网格单元格显示值是否等价(数值相等即视为一致,忽略 "1234.5" 与 "1234.50" 这类格式差异;
 *  用于保存后回读比对,避免无谓重置撤销栈) */
export function cellValueEquivalent(a: string, b: string): boolean {
  if (a === b) return true;
  const na = wanToCents(a);
  const nb = wanToCents(b);
  if (na != null && nb != null) return na === nb;
  return a.trim() === b.trim();
}

/** 大额智能缩写(仪表盘卡片):≥1 亿显示「x.xx 亿」、≥1 万显示「x.xx 万」、否则元两位小数 */
export function centsCompact(cents: number): string {
  const neg = cents < 0;
  const yuan = Math.abs(cents) / 100;
  let s: string;
  if (yuan >= 1e8) s = `${group2(yuan / 1e8)} 亿`;
  else if (yuan >= 1e4) s = `${group2(yuan / 1e4)} 万`;
  else s = group2(yuan);
  return neg && yuan !== 0 ? `-${s}` : s;
}

/* ============ 数量口径(10^4 缩放整数) ============ */

/** 数量型科目的存储精度:按 10^4 缩放的整数(与后端 QUANTITY_SCALE 一致) */
export const QUANTITY_SCALE = 10_000;

/** 数量字符串 -> 10^4 缩放整数；全程按十进制拆分，不经过浮点乘法。 */
export function quantityToScaled(display: string): number | null {
  const text = ungroupNumber(display);
  if (!QUANTITY_RE.test(text)) return null;
  const negative = text.startsWith('-');
  const body = text.replace(/^[+-]/, '');
  const [integer, fraction = ''] = body.split('.');
  const scaled = Number(integer) * QUANTITY_SCALE + Number((fraction + '0000').slice(0, 4));
  if (!Number.isSafeInteger(scaled)) return null;
  return negative && scaled !== 0 ? -scaled : scaled;
}

/** 10^4 缩放数量 -> 展示字符串(千分位,去掉多余尾零,最多四位小数);可附加计量单位 */
export function formatQuantity(scaled: number, unit?: string): string {
  const neg = scaled < 0;
  const abs = Math.abs(scaled);
  const integer = Math.floor(abs / QUANTITY_SCALE);
  const fraction = String(abs % QUANTITY_SCALE).padStart(4, '0').replace(/0+$/, '');
  const text = `${neg && abs !== 0 ? '-' : ''}${integer.toLocaleString('zh-CN')}${fraction ? `.${fraction}` : ''}`;
  return unit ? `${text} ${unit}` : text;
}

/* ============ 比率口径(10^6 缩放定点数,与后端 RATIO_SCALE 一致) ============ */

/** 比率型指标的存储精度:按 10^6 缩放的定点整数 */
export const RATIO_SCALE = 1_000_000;

/**
 * 比率展示。null 一律显示 N/A —— 分母为 0 时不伪造 0。
 * percent:比率 × 100 加百分号;number:自然单位数值,单位由指标自行声明。
 */
export function formatRatio(
  scaled: number | null | undefined,
  displayFormat: 'percent' | 'number',
  unit?: string,
): string {
  if (scaled == null) return 'N/A';
  if (displayFormat === 'percent') return `${group2((scaled / RATIO_SCALE) * 100)}%`;
  const text = group2(scaled / RATIO_SCALE);
  return unit ? `${text} ${unit}` : text;
}

/**
 * 比率的预实差异:百分比口径下是百分点(pp),自然单位口径下是单位差值。
 * 注意这不是完成率 —— 比率差异只能用差,不能用比。
 */
export function formatRatioDelta(
  scaled: number | null | undefined,
  displayFormat: 'percent' | 'number',
  unit?: string,
): string {
  if (scaled == null) return 'N/A';
  const value = displayFormat === 'percent' ? (scaled / RATIO_SCALE) * 100 : scaled / RATIO_SCALE;
  const sign = value > 0 ? '+' : '';
  const suffix = displayFormat === 'percent' ? ' pp' : unit ? ` ${unit}` : '';
  return `${sign}${group2(value)}${suffix}`;
}
