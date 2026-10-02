import type { DB } from '../../db/connection';
import type { AssistantScope, SelectionDescriptor } from '../../contracts/assistant';
import { AppError } from '../../core/errors';
import { centsToDecimalString, formatScaled, sumCents } from '../../core/decimal';
import { computeLeafIds, isDescendantOf, type TreeNodeRow } from '../../core/tree';
import { currentAuth } from '../../core/request-context';
import { assertOrgVisible, requireAllOrgs } from '../security/scope';
import { listRows } from '../actual/actual.helpers';
import { loadSnapshotNodes } from '../tree/snapshot';
import { listSheets } from '../sheet/sheet.service';

export interface GridSelectionScope { orgIds: number[]; accountIds: number[]; sheetKey?: string }
const invalid = (text: string): never => { throw new AppError('CONTEXT_CONFLICT', text, 409); };
const bounded = (count: number) => { if (count > 500) throw new AppError('CONTEXT_TOO_LARGE', '选区超过 500 个单元格，请缩小范围', 400); };
function leafSelection(rows: TreeNodeRow[], ids: number[]) {
  const known = new Set(rows.map((r) => r.id));
  if (!ids.length || ids.some((id) => !known.has(id))) invalid('选区为空或对象已失效，请重新选择');
  const leaves = computeLeafIds(rows);
  return [...leaves].filter((id) => ids.some((root) => isDescendantOf(rows, id, root)));
}

/** 同一叶子格只读一次；按真实工作表与组织范围求交，金额与数量分别返回。 */
export function resolveGridSelection(db: DB, scope: AssistantScope, view: Record<string, unknown>, selection: SelectionDescriptor): GridSelectionScope {
  const auth = currentAuth();
  if (auth) {
    const permission = scope.pageKey === 'budget_edit' ? 'budget:read' : 'actual:read';
    if (!auth.permissions.has(permission)) throw new AppError('FORBIDDEN', '没有读取选区的权限', 403);
    requireAllOrgs(auth, '网格选择范围');
  }
  if (selection.mode !== 'bounds' || !['budget_edit', 'actual'].includes(scope.pageKey ?? '')) invalid('该页面不支持网格选区');
  const bounds = selection.mode === 'bounds' ? selection.bounds : {};
  if (bounds.sheetKey !== view.sheetKey) invalid('选区与当前工作表不一致');
  let orgRows = listRows(db, 'org'); let accRows = listRows(db, 'account');
  if (scope.pageKey === 'budget_edit') {
    const v = db.prepare('SELECT org_tree_snapshot_id, account_tree_snapshot_id FROM budget_version WHERE id=?').get(scope.budgetVersionId) as { org_tree_snapshot_id: number; account_tree_snapshot_id: number } | undefined;
    if (!v) return invalid('请指定有效的预算版本');
    orgRows = loadSnapshotNodes(db, v.org_tree_snapshot_id); accRows = loadSnapshotNodes(db, v.account_tree_snapshot_id);
  } else if (view.historyMode === true || view.viewMode === 'years') {
    throw new AppError('CAPABILITY_UNAVAILABLE', '历史补录与多年视图不支持当前累计选区分析，请切回当前实际组织视图', 400);
  }
  const orgIds = leafSelection(orgRows, bounds.orgIds ?? []);
  const accountIds = leafSelection(accRows, bounds.accountIds ?? []);
  for (const id of orgIds) {
    if (auth) assertOrgVisible(db, auth, id);
    if (scope.orgScopeId != null && !isDescendantOf(orgRows, id, scope.orgScopeId)) invalid('选区组织超出当前页面范围');
  }
  if (scope.accountScopeId != null && accountIds.some((id) => !isDescendantOf(accRows, id, scope.accountScopeId!))) invalid('选区科目超出当前页面范围');
  if (bounds.sheetKey && !['all', 'overview', 'profit'].includes(bounds.sheetKey)) {
    const sheet = listSheets(db).find((s) => s.code === bounds.sheetKey && s.status === 'active');
    if (!sheet) return invalid('工作表已失效');
    const roots = accRows.filter((r) => sheet.rootCodes.includes(r.code)).map((r) => r.id);
    if (accountIds.some((id) => !roots.some((root) => isDescendantOf(accRows, id, root)))) invalid('选区科目不属于当前工作表');
  }
  bounded(orgIds.length * accountIds.length);
  return { orgIds, accountIds, sheetKey: bounds.sheetKey };
}

export function analyzeGridSelection(db: DB, scope: AssistantScope, selection: GridSelectionScope, overlay: { orgId: number; accountId: number; amountCents: number; quantity: number | null; cleared: boolean }[] = []) {
  const budget = scope.pageKey === 'budget_edit';
  const orgParams = selection.orgIds.map(() => '?').join(',');
  const accParams = selection.accountIds.map(() => '?').join(',');
  const table = budget ? 'budget_entry' : 'actual_current';
  const amountColumn = budget ? 'amount_cents' : 'cumulative_amount_cents';
  const rows = db.prepare('SELECT org_id, account_id, ' + amountColumn + ' amount, quantity FROM ' + table +
    ' WHERE ' + (budget ? 'version_id' : 'year') + '=? AND org_id IN (' + orgParams + ') AND account_id IN (' + accParams + ')')
    .safeIntegers(true).all(budget ? scope.budgetVersionId : scope.year, ...selection.orgIds, ...selection.accountIds) as { org_id: bigint; account_id: bigint; amount: bigint; quantity: bigint | null }[];
  const byCell = new Map(rows.map((r) => [String(r.org_id) + ':' + String(r.account_id), { amount: r.amount, quantity: r.quantity }]));
  const orgSet = new Set(selection.orgIds); const accSet = new Set(selection.accountIds);
  for (const e of overlay) if (orgSet.has(e.orgId) && accSet.has(e.accountId)) {
    const key = e.orgId + ':' + e.accountId;
    if (e.cleared) byCell.delete(key); else byCell.set(key, { amount: BigInt(e.amountCents), quantity: e.quantity == null ? null : BigInt(e.quantity) });
  }
  const accountRows = budget ? loadSnapshotNodes(db, (db.prepare('SELECT account_tree_snapshot_id id FROM budget_version WHERE id=?').get(scope.budgetVersionId) as { id: number }).id) : listRows(db, 'account');
  const accounts = new Map(accountRows.map((a) => [a.id, a]));
  const orgRows = budget ? loadSnapshotNodes(db, (db.prepare('SELECT org_tree_snapshot_id id FROM budget_version WHERE id=?').get(scope.budgetVersionId) as { id: number }).id) : listRows(db, 'org');
  const orgs = new Map(orgRows.map((o) => [o.id, o]));
  let total = 0n;
  const quantityTotals = new Map<number, bigint>();
  const cells = [];
  for (const orgId of selection.orgIds) for (const accountId of selection.accountIds) {
    const account = accounts.get(accountId)!;
    const e = byCell.get(orgId + ':' + accountId);
    const quantity = account.type === 'quantity';
    if (!quantity) total = sumCents([total, e?.amount ?? 0n]);
    else if (account.quantity_agg === 'sum') quantityTotals.set(accountId, sumCents([quantityTotals.get(accountId) ?? 0n, e?.quantity ?? 0n], '数量汇总'));
    if (cells.length < 30) cells.push({ orgId, accountId, orgName: orgs.get(orgId)?.name, accountCode: account.code, accountName: account.name, amount: quantity ? null : centsToDecimalString(e?.amount ?? 0n), quantity: quantity && e?.quantity != null ? formatScaled(e.quantity, 4) : null, unit: quantity ? account.unit : '元' });
  }
  const count = selection.orgIds.length * selection.accountIds.length;
  return { mode: 'bounds', count, ...selection, amount: centsToDecimalString(total), quantities: [...quantityTotals].map(([accountId, q]) => ({ accountId, unit: accounts.get(accountId)?.unit, quantity: formatScaled(q, 4) })), cells, truncated: count > cells.length, omitted: count - cells.length, unsaved: overlay.length > 0, explanation: '金额按利润方向汇总；数量只按同科目及可加总口径汇总，单价与比率不相加。详情最多 30 格，汇总覆盖全部选中格。' };
}
