import type { DB } from '../../db/connection';
import { AppError, Errors } from '../../core/errors';
import { computeLeafIds, type TreeNodeRow } from '../../core/tree';
import { isAccountVisibleForScope } from '../../core/accountScope';
import type { FinanceProfileConfig } from './finance.types';

interface ProfileRow { id: number; code: string; name: string; config_json: string }

export interface FinanceOwnedConflict {
  profileId: number;
  profileCode: string;
  profileName: string;
  orgId: number;
  orgCode: string;
  accountId: number;
  accountCode: string;
}

export interface ExpandedOwnedScope {
  orgIds: Set<number>;
  accountIds: Set<number>;
  orgCodes: Set<string>;
  accountCodes: Set<string>;
}

export interface FinanceOwnedCell {
  profileId: number;
  profileName: string;
  orgId: number;
  orgCode: string;
  accountId: number;
  accountCode: string;
}

export function descendantIds(rows: Pick<TreeNodeRow, 'id' | 'parent_id' | 'code'>[], rootCodes: string[]): Set<number> {
  const selected = new Set(rows.filter((row) => rootCodes.includes(row.code)).map((row) => row.id));
  let changed = true;
  while (changed) {
    changed = false;
    for (const row of rows) {
      if (row.parent_id != null && selected.has(row.parent_id) && !selected.has(row.id)) {
        selected.add(row.id);
        changed = true;
      }
    }
  }
  return selected;
}

export function expandOwnedLeafScope(db: DB, config: FinanceProfileConfig): ExpandedOwnedScope {
  const orgRows = db.prepare('SELECT id, parent_id, code, name, sort_order, status FROM org ORDER BY id').all() as TreeNodeRow[];
  const accountRows = db.prepare(
    'SELECT id, parent_id, code, name, type, unit, quantity_agg, sort_order, status FROM account ORDER BY id',
  ).all() as TreeNodeRow[];
  const ownedOrgs = descendantIds(orgRows, config.ownedOrgCodes ?? []);
  const ownedAccounts = descendantIds(accountRows, config.ownedAccountCodes ?? []);
  const orgLeaves = computeLeafIds(orgRows);
  const accountLeaves = computeLeafIds(accountRows);
  const orgs = orgRows.filter((row) => ownedOrgs.has(row.id) && orgLeaves.has(row.id) && row.status === 'active');
  const accounts = accountRows.filter((row) => ownedAccounts.has(row.id) && accountLeaves.has(row.id) && row.status === 'active' && row.type !== 'quantity');
  return {
    orgIds: new Set(orgs.map((row) => row.id)),
    accountIds: new Set(accounts.map((row) => row.id)),
    orgCodes: new Set(orgs.map((row) => row.code)),
    accountCodes: new Set(accounts.map((row) => row.code)),
  };
}

export function findFinanceOwnedConflicts(
  db: DB,
  cells: { orgId: number; accountId: number }[],
): FinanceOwnedConflict[] {
  if (cells.length === 0) return [];
  const orgRows = db.prepare('SELECT id, code FROM org').all() as { id: number; code: string }[];
  const accountRows = db.prepare('SELECT id, code FROM account').all() as { id: number; code: string }[];
  const orgCode = new Map(orgRows.map((row) => [row.id, row.code]));
  const accountCode = new Map(accountRows.map((row) => [row.id, row.code]));
  const profiles = db.prepare("SELECT id, code, name, config_json FROM finance_source_profile WHERE status = 'active' ORDER BY id").all() as ProfileRow[];
  const uniqueCells = new Map(cells.map((cell) => [`${cell.orgId}:${cell.accountId}`, cell]));
  const conflicts: FinanceOwnedConflict[] = [];
  for (const profile of profiles) {
    let config: FinanceProfileConfig;
    try { config = JSON.parse(profile.config_json) as FinanceProfileConfig; }
    catch { throw Errors.conflict(`active 财务数据源 ${profile.name} 的拥有范围配置损坏，请先修复配置`); }
    const scope = expandOwnedLeafScope(db, config);
    for (const cell of uniqueCells.values()) {
      const oCode = orgCode.get(cell.orgId);
      const aCode = accountCode.get(cell.accountId);
      if (!oCode || !aCode || !scope.orgIds.has(cell.orgId) || !scope.accountIds.has(cell.accountId)) continue;
      if (!isAccountVisibleForScope(aCode, new Set([oCode]))) continue;
      conflicts.push({
        profileId: profile.id,
        profileCode: profile.code,
        profileName: profile.name,
        orgId: cell.orgId,
        orgCode: oCode,
        accountId: cell.accountId,
        accountCode: aCode,
      });
    }
  }
  return conflicts.sort((a, b) => a.profileId - b.profileId || a.orgCode.localeCompare(b.orgCode) || a.accountCode.localeCompare(b.accountCode));
}

/** 当前树上所有有效拥有单元格，供手工维护界面做非阻断提示。 */
export function listFinanceOwnedCells(db: DB): FinanceOwnedCell[] {
  const orgRows = db.prepare('SELECT id, code FROM org').all() as { id: number; code: string }[];
  const accountRows = db.prepare('SELECT id, code FROM account').all() as { id: number; code: string }[];
  const orgCodeById = new Map(orgRows.map((row) => [row.id, row.code]));
  const accountCodeById = new Map(accountRows.map((row) => [row.id, row.code]));
  const profiles = db.prepare("SELECT id, code, name, config_json FROM finance_source_profile WHERE status = 'active' ORDER BY id").all() as ProfileRow[];
  const result: FinanceOwnedCell[] = [];
  for (const profile of profiles) {
    let config: FinanceProfileConfig;
    try { config = JSON.parse(profile.config_json) as FinanceProfileConfig; }
    catch { throw Errors.conflict(`active 财务数据源 ${profile.name} 的拥有范围配置损坏，请先修复配置`); }
    const scope = expandOwnedLeafScope(db, config);
    for (const orgId of scope.orgIds) for (const accountId of scope.accountIds) {
      const orgCode = orgCodeById.get(orgId);
      const accountCode = accountCodeById.get(accountId);
      if (!orgCode || !accountCode || !isAccountVisibleForScope(accountCode, new Set([orgCode]))) continue;
      result.push({ profileId: profile.id, profileName: profile.name, orgId, orgCode, accountId, accountCode });
    }
  }
  return result;
}

export function assertNoFinanceOwnedConflicts(db: DB, cells: { orgId: number; accountId: number }[]): void {
  const conflicts = findFinanceOwnedConflicts(db, cells);
  if (conflicts.length === 0) return;
  const profiles = [...new Set(conflicts.map((item) => item.profileName))].join('、');
  throw new AppError(
    'FINANCE_OWNED_CONFLICT',
    `目标单元格属于 active 财务数据源“${profiles}”的有效拥有范围，请改走财务系统转换链路`,
    409,
    undefined,
    { total: conflicts.length, conflicts: conflicts.slice(0, 100) },
  );
}
