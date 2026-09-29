/**
 * EAS 事件钩子:数据治理(T-3 治理)订阅导入/预检结果生成问题单,EAS 本身不依赖治理模块。
 * 钩子在调用方事务内同步执行(预检)或事务外执行(公司未解析),异常照常抛出以保证一致。
 */
import type { DB } from '../../db/connection';

export interface EasUnresolvedEvent { company: string; period: string; dataType: string; fileName: string }
export interface EasPrecheckSet { id: number; org_id: number; period: string; status: string; correction_id: number | null }
export interface EasPrecheckRule { ruleCode: string; status: string; diffCount: number; diffCents: bigint; details: Record<string, unknown> }

type UnresolvedHandler = (db: DB, event: EasUnresolvedEvent) => void;
type PrecheckHandler = (db: DB, set: EasPrecheckSet, results: EasPrecheckRule[]) => void;

const unresolvedHandlers: UnresolvedHandler[] = [];
const precheckHandlers: PrecheckHandler[] = [];

export function onEasCompanyUnresolvedSubscribe(fn: UnresolvedHandler): void { unresolvedHandlers.push(fn); }
export function onEasPrecheckSubscribe(fn: PrecheckHandler): void { precheckHandlers.push(fn); }

export function onEasCompanyUnresolved(db: DB, event: EasUnresolvedEvent): void {
  for (const fn of unresolvedHandlers) fn(db, event);
}
export function onEasPrecheck(db: DB, set: EasPrecheckSet, results: EasPrecheckRule[]): void {
  for (const fn of precheckHandlers) fn(db, set, results);
}
