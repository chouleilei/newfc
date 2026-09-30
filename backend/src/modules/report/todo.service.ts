import type { DB } from '../../db/connection';
import { currentAuth } from '../../core/request-context';
import { currentOrgScope, scopeFilterSql } from '../security/scope';
import type { Permission } from '../security/permissions';

/**
 * 工作台待办数(T-4):按权限与组织范围统计项目合同与费用审核的待处理事项。
 * 没有对应权限的项不返回(而不是返回 0),页面据此决定是否显示入口。
 */
export interface TodoItem { key: string; label: string; count: number; path: string }

export function workbenchTodos(db: DB): { items: TodoItem[] } {
  const auth = currentAuth();
  const can = (p: Permission) => !auth || auth.permissions.has(p);
  const scope = currentOrgScope(db);
  const ct = scopeFilterSql(scope, 'c.org_id');
  const ex = scopeFilterSql(scope, 'org_id');
  const countContracts = (from: string, where: string) =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ${from} JOIN ct_contract c ON c.id = x.contract_id WHERE c.status = 'active' AND ${where} AND ${ct.sql}`).get(...ct.params) as { n: number }).n;
  const countClaims = (status: string) =>
    (db.prepare(`SELECT COUNT(*) AS n FROM ex_claim WHERE status = ? AND ${ex.sql}`).get(status, ...ex.params) as { n: number }).n;
  const items: TodoItem[] = [];
  if (can('contract:review')) {
    items.push({ key: 'contract_review', label: '待审核合同', count: countContracts('ct_review x', "x.status = 'submitted'"), path: '/contracts?todo=review' });
    items.push({ key: 'contract_change', label: '待复核合同变更', count: countContracts('ct_change x', "x.status = 'submitted'"), path: '/contracts?todo=change' });
    items.push({ key: 'contract_payment_review', label: '待复核付款申请', count: countContracts('ct_payment x', "x.status = 'submitted'"), path: '/contracts?todo=payment' });
  }
  if (can('contract:write')) {
    items.push({ key: 'contract_payment_pay', label: '已批准待支付', count: countContracts('ct_payment x', "x.status = 'approved'"), path: '/contracts?todo=pay' });
  }
  if (can('expense:review')) items.push({ key: 'expense_review', label: '待复核报销', count: countClaims('audited'), path: '/expense?status=audited' });
  if (can('expense:submit')) items.push({ key: 'expense_supplement', label: '退回补件报销', count: countClaims('supplement'), path: '/expense?status=supplement' });
  return { items };
}
