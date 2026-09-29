/**
 * 新接口(T-3 起)的金额/比率以十进制字符串返回(docs/money-contract.md)。
 * 展示只做字符串排版,不转 number,避免超过 2^53 或浮点误差改变数字。
 */

const DECIMAL = /^(-)?(\d+)(?:\.(\d+))?$/;

/** 千分位分组:'1234567.8' → '1,234,567.80'(金额固定两位小数);非法输入原样返回。 */
export function formatMoney(value: string | null | undefined): string {
  if (value == null || value === '') return '—';
  const m = DECIMAL.exec(value.trim());
  if (!m) return value;
  const [, sign, int, frac = ''] = m;
  const grouped = int.replace(/^0+(?=\d)/, '').replace(/\B(?=(\d{3})+(?!\d))/g, ',');
  return `${sign ?? ''}${grouped}.${(frac + '00').slice(0, Math.max(2, frac.length))}`;
}

/** 比率字符串 → 百分比字符串(小数点右移两位,保留 digits 位,截断不四舍五入以免与后端口径不一致)。 */
export function formatRatioPercent(value: string | null | undefined, digits = 2): string {
  if (value == null || value === '') return '—';
  const m = DECIMAL.exec(value.trim());
  if (!m) return value;
  const [, sign, int, frac = ''] = m;
  const padded = frac.padEnd(2 + digits, '0');
  const whole = (int + padded.slice(0, 2)).replace(/^0+(?=\d)/, '');
  const rest = padded.slice(2, 2 + digits);
  return `${sign ?? ''}${whole}${digits > 0 ? `.${rest}` : ''}%`;
}

/** 按单位格式化:money → 金额,ratio → 百分比。 */
export function formatByUnit(value: string | null | undefined, unit: 'money' | 'ratio'): string {
  return unit === 'ratio' ? formatRatioPercent(value) : formatMoney(value);
}

/** 十进制字符串的符号:用于上色,不做数值运算。 */
export function decimalSign(value: string | null | undefined): -1 | 0 | 1 {
  if (value == null) return 0;
  const m = DECIMAL.exec(value.trim());
  if (!m) return 0;
  if (/^0*$/.test(m[2]) && /^0*$/.test(m[3] ?? '')) return 0;
  return m[1] ? -1 : 1;
}

/** dayjs 月份 → 'YYYY-MM'。 */
export function periodOf(d: { format: (f: string) => string } | null | undefined): string | undefined {
  return d ? d.format('YYYY-MM') : undefined;
}
