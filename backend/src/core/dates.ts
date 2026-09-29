/** 日期工具:YYYY-MM-DD 校验与自然日进度(方案九.4 均匀进度) */

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function isValidDate(s: string): boolean {
  if (!DATE_RE.test(s)) return false;
  const [y, m, d] = s.split('-').map(Number);
  if (m < 1 || m > 12 || d < 1 || d > 31) return false;
  const dt = new Date(Date.UTC(y, m - 1, d));
  return dt.getUTCFullYear() === y && dt.getUTCMonth() === m - 1 && dt.getUTCDate() === d;
}

export function yearOfDate(s: string): number {
  return Number(s.slice(0, 4));
}

export function daysInYear(year: number): number {
  return (year % 4 === 0 && year % 100 !== 0) || year % 400 === 0 ? 366 : 365;
}

/** 年初至该日的天数(含当日),如 2026-01-01 -> 1 */
export function dayOfYear(s: string): number {
  const [y, m, d] = s.split('-').map(Number);
  const start = Date.UTC(y, 0, 1);
  const cur = Date.UTC(y, m - 1, d);
  return Math.round((cur - start) / 86400000) + 1;
}

/** 均匀自然日进度 T = 已过天数 / 年度总天数,返回 0~1 */
export function timeProgress(dateStr: string): number {
  const y = yearOfDate(dateStr);
  return dayOfYear(dateStr) / daysInYear(y);
}

export function compareDate(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}
