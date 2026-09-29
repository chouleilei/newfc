/** 管理会计各子功能共用:组织范围、冲突错误、金额/比率转换。 */
import type { DB } from '../../db/connection';
import { AppError } from '../../core/errors';
import { currentAuth } from '../../core/request-context';
import { centsToDecimalString, formatScaled, parseDecimalToCents, parseScaled, RATIO_SCALE } from '../../core/decimal';
import { notVisible, orgInScope, resolveOrgScope, type OrgScope } from '../security/scope';

export const nowIso = () => new Date().toISOString();

export function scope(db: DB): OrgScope {
  const auth = currentAuth();
  return auth ? resolveOrgScope(db, auth) : { all: true };
}

export function currentUserId(): number | null {
  return currentAuth()?.userId ?? null;
}

export function conflict(code: string, message: string, details?: unknown): AppError {
  return new AppError(code, message, 409, undefined, details);
}

export function assertVersion(actual: number, expected: number, what: string): void {
  if (actual !== expected) throw conflict('VERSION_CONFLICT', `${what}已被修改(当前版本 ${actual},提交基线 ${expected}),请刷新后重试`);
}

export function assertOrgInScope(db: DB, orgId: number, what = '组织'): void {
  const exists = db.prepare('SELECT 1 FROM org WHERE id = ?').get(orgId);
  if (!exists || !orgInScope(scope(db), orgId)) throw notVisible(what);
}

export function orgName(db: DB, orgId: number): string {
  return (db.prepare('SELECT name FROM org WHERE id = ?').get(orgId) as { name: string } | undefined)?.name ?? `#${orgId}`;
}

export const money = (cents: bigint | number) => centsToDecimalString(cents);
export const ratio = (scaled: bigint | number) => formatScaled(scaled, RATIO_SCALE, true);
export const parseMoney = (s: string, label = '金额') => parseDecimalToCents(s, { label });
export const parseRatio = (s: string, label = '比率') => parseScaled(s, RATIO_SCALE, { label });

/** 按指标单位把缩放整数格式化为字符串:money 为分,ratio 为 10^6。 */
export function formatValue(unit: 'money' | 'ratio', cents: bigint | null, scaled: bigint | null): string | null {
  if (unit === 'money') return cents === null ? null : money(cents);
  return scaled === null ? null : ratio(scaled);
}

/** 按指标单位解析阈值等输入:money 返回分,ratio 返回 10^6 缩放。 */
export function parseByUnit(unit: 'money' | 'ratio', s: string, label: string): bigint {
  return unit === 'money' ? parseDecimalToCents(s, { label }) : parseScaled(s, RATIO_SCALE, { label });
}

export function big(v: unknown): bigint | null {
  if (v === null || v === undefined) return null;
  return typeof v === 'bigint' ? v : BigInt(v as number);
}
