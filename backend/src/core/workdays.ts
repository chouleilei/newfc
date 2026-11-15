/**
 * 日历日与工作日纯函数计算工具（基于 YYYY-MM-DD UTC 日期）。
 * 供风险扫描、工作台待办与合同台账筛选共用，保证口径一致。
 */

export function todayUtcDate(): string {
  return new Date().toISOString().slice(0, 10);
}

export function parseUtcDate(s: string | null | undefined): Date | null {
  if (!s || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return null;
  const [y, m, d] = s.split('-').map(Number);
  const date = new Date(Date.UTC(y, m - 1, d));
  return formatUtcDate(date) === s ? date : null;
}

export function formatUtcDate(d: Date): string {
  return d.toISOString().slice(0, 10);
}

export function addCalendarDays(dateStr: string, days: number): string | null {
  const d = parseUtcDate(dateStr);
  if (!d) return null;
  return formatUtcDate(new Date(d.getTime() + days * 86_400_000));
}

export function calendarDaysBetween(fromDate: string, toDate: string): number | null {
  const a = parseUtcDate(fromDate);
  const b = parseUtcDate(toDate);
  if (!a || !b) return null;
  return Math.floor((b.getTime() - a.getTime()) / 86_400_000);
}

export interface WorkingCalendar { holidays: ReadonlySet<string>; workdays: ReadonlySet<string> }
export function isWorkingDay(date: string, calendar?: WorkingCalendar): boolean {
  if (calendar?.workdays.has(date)) return true;
  if (calendar?.holidays.has(date)) return false;
  const dow = parseUtcDate(date)?.getUTCDay();
  return dow !== undefined && dow !== 0 && dow !== 6;
}
export function workingDaysBetween(fromDate: string, toDate: string, calendar?: WorkingCalendar): number | null {
  const a = parseUtcDate(fromDate);
  const b = parseUtcDate(toDate);
  if (!a || !b) return null;
  if (b.getTime() <= a.getTime()) return 0;
  let count = 0;
  for (let time = a.getTime() + 86_400_000; time <= b.getTime(); time += 86_400_000) {
    if (isWorkingDay(formatUtcDate(new Date(time)), calendar)) count++;
  }
  return count;
}

export function addWorkingDays(fromDate: string, workingDays: number, calendar?: WorkingCalendar): string | null {
  const start = parseUtcDate(fromDate);
  if (!start) return null;
  if (workingDays <= 0) return fromDate;
  let cur = start.getTime();
  let left = Math.trunc(workingDays);
  while (left > 0) {
    cur += 86_400_000;
    if (isWorkingDay(formatUtcDate(new Date(cur)), calendar)) {
      left--;
    }
  }
  return formatUtcDate(new Date(cur));
}

/**
 * 返回使得 workingDaysBetween(d, toDate) > minWorkingDays 成立的最大日期 d（YYYY-MM-DD）。
 * 用于 SQL 中高效筛选“距今已超过 N 个工作日”的日期列（d <= cutoff）。
 */
export function workingDayCutoffBefore(toDate: string, minWorkingDays: number, calendar?: WorkingCalendar): string {
  const end = parseUtcDate(toDate);
  if (!end) throw new Error(`非法日期格式: ${toDate}`);
  if (minWorkingDays < 0) return toDate;
  let cur = end.getTime();
  let weekdays = 0;
  while (true) {
    if (isWorkingDay(formatUtcDate(new Date(cur)), calendar)) {
      weekdays++;
      if (weekdays > minWorkingDays) {
        return formatUtcDate(new Date(cur - 86_400_000));
      }
    }
    cur -= 86_400_000;
  }
}
