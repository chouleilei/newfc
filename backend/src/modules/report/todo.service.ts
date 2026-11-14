import { workingCalendar } from '../settings/business-settings';
import type { DB } from '../../db/connection';
import { currentAuth } from '../../core/request-context';
import { addCalendarDays, todayUtcDate, workingDayCutoffBefore } from '../../core/workdays';
import { currentOrgScope, scopeFilterSql } from '../security/scope';
import type { Permission } from '../../contracts/permissions';

/**
 * 工作台待办数(T-4/T-5):按权限与组织范围统计项目合同、费用审核、风险处理与分析报告的待处理事项。
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
    items.push({ key: 'contract_settlement_review', label: '待复核结算单', count: countContracts('ct_settlement x', "x.status = 'submitted'"), path: '/contracts?todo=settlement' });
    items.push({ key: 'contract_payment_review', label: '待复核付款申请', count: countContracts('ct_payment x', "x.status = 'submitted'"), path: '/contracts?todo=payment' });
    items.push({ key: 'contract_receipt_review', label: '待复核收款申请', count: countContracts('ct_receipt x', "x.status = 'submitted'"), path: '/contracts?todo=receipt' });
  }
  if (can('contract:write')) {
    const today = todayUtcDate();
    const distCutoff = workingDayCutoffBefore(today, 10, workingCalendar(db));
    const guaranteeDeadline = addCalendarDays(today, 30)!;
    items.push({ key: 'contract_payment_pay', label: '已批准待支付', count: countContracts('ct_payment x', "x.status = 'approved'"), path: '/contracts?todo=pay' });
    items.push({ key: 'contract_receipt_receive', label: '已批准待收款', count: countContracts('ct_receipt x', "x.status = 'approved'"), path: '/contracts?todo=receipt' });
    items.push({
      key: 'contract_distribution',
      label: '签署超 10 工作日待分发',
      count: (db.prepare(`SELECT COUNT(*) AS n FROM ct_contract WHERE status = 'active' AND sign_date IS NOT NULL AND sign_date <= ? AND distribution_status = 'pending' AND ${scopeFilterSql(scope, 'org_id').sql}`).get(distCutoff, ...scopeFilterSql(scope, 'org_id').params) as { n: number }).n,
      path: '/contracts?todo=distribution',
    });
    items.push({
      key: 'contract_guarantee_warranty',
      label: '临期保函/待签证质保',
      count: (db.prepare(`SELECT COUNT(*) AS n FROM ct_contract c WHERE c.status = 'active' AND ${scopeFilterSql(scope, 'c.org_id').sql} AND (EXISTS (SELECT 1 FROM ct_guarantee g WHERE g.contract_id = c.id AND g.status = 'active' AND g.expiry_date IS NOT NULL AND g.expiry_date <= ?) OR (c.has_warranty = 1 AND c.stage = 'warranty' AND NOT EXISTS (SELECT 1 FROM ct_warranty w WHERE w.contract_id = c.id AND w.inspection_conclusion = 'passed' AND w.visa_document_id IS NOT NULL) AND EXISTS (SELECT 1 FROM ct_warranty w2 WHERE w2.contract_id = c.id AND w2.end_date IS NOT NULL AND w2.end_date <= ?)))`).get(...scopeFilterSql(scope, 'c.org_id').params, guaranteeDeadline, today) as { n: number }).n,
      path: '/contracts?todo=guarantee_warranty',
    });
  }
  if (can('expense:review')) items.push({ key: 'expense_review', label: '待复核报销', count: countClaims('audited'), path: '/expense?status=audited' });
  if (can('expense:submit')) items.push({ key: 'expense_supplement', label: '退回补件报销', count: countClaims('supplement'), path: '/expense?status=supplement' });
  const rk = scopeFilterSql(scope, 'org_id');
  const countRisks = (status: string) =>
    (db.prepare(`SELECT COUNT(*) AS n FROM risk_event WHERE status = ? AND ${rk.sql}`).get(status, ...rk.params) as { n: number }).n;
  // 无组织的集团报告只计入全组织用户(受限用户的 IN 过滤天然排除 NULL)
  const countReports = (status: string) =>
    (db.prepare(`SELECT COUNT(*) AS n FROM rpt_report WHERE status = ? AND ${rk.sql}`).get(status, ...rk.params) as { n: number }).n;
  if (can('risk:handle')) items.push({ key: 'risk_confirm', label: '待确认风险', count: countRisks('open'), path: '/risk?status=open' });
  if (can('risk:review')) items.push({ key: 'risk_review', label: '待复核整改', count: countRisks('rectified'), path: '/risk?status=rectified' });
  if (can('report:approve')) items.push({ key: 'report_approve', label: '待审批报告', count: countReports('pending_approval'), path: '/analysis-reports?status=pending_approval' });
  if (can('report:publish')) items.push({ key: 'report_publish', label: '待发布报告', count: countReports('approved'), path: '/analysis-reports?status=approved' });
  if (can('forecast:review') && can('forecast:read')) {
    const ff = scopeFilterSql(scope, 'm.org_id');
    const count = (db.prepare(`SELECT COUNT(*) AS n FROM ff_version v JOIN ff_model m ON m.id = v.model_id
      WHERE m.status = 'active' AND v.status = 'frozen'
        AND NOT EXISTS (SELECT 1 FROM ff_version_review r WHERE r.version_id = v.id) AND ${ff.sql}`)
      .get(...ff.params) as { n: number }).n;
    items.push({ key: 'forecast_review', label: '待复核预测版本', count, path: '/forecast?tab=reviews' });
  }
  if (can('investment:review') && can('investment:read')) {
    const feas = scopeFilterSql(scope, 'p.org_id');
    const count = (db.prepare(`SELECT COUNT(*) AS n FROM if_report r JOIN if_scenario s ON s.id = r.scenario_id
      JOIN if_project p ON p.id = s.project_id WHERE r.status = 'pending_review' AND ${feas.sql}`)
      .get(...feas.params) as { n: number }).n;
    items.push({ key: 'feasibility_review', label: '待复核可研报告', count, path: '/feasibility?tab=reports&status=pending_review' });
  }
  return { items };
}
