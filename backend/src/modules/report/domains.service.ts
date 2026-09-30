import type { DB } from '../../db/connection';
import { currentAuth } from '../../core/request-context';
import { currentOrgScope, scopeFilterSql } from '../security/scope';
import type { Permission } from '../security/permissions';
import { contractSummary } from '../contracts/contract.service';
import { projectBudgetSummary } from '../project-budget/project-budget.service';
import { riskSummary } from '../risk/risk.service';
import type { DashboardDomainsDto, DomainBlockDto as DomainBlock } from '../../contracts/dashboard';

/**
 * 工作台“业务概况”(T-6,AC-F03 收口):各域同源 service 的范围内统计。
 * 没有读权限的块不返回;无数据时如实给 0/空,不可用的指标给 null 并附说明,不当作 0。
 */
export function dashboardDomains(db: DB): DashboardDomainsDto {
  const auth = currentAuth();
  const can = (p: Permission) => !auth || auth.permissions.has(p);
  const scope = currentOrgScope(db);
  const sc = scopeFilterSql(scope, 'org_id');
  const count = (sql: string, ...params: unknown[]) => (db.prepare(sql).get(...params, ...sc.params) as { n: number }).n;
  const blocks: DomainBlock[] = [];

  if (can('contract:read')) {
    const s = contractSummary(db);
    blocks.push({ key: 'contract', label: '合同', path: '/contracts', metrics: [
      { label: '履约中合同', value: s.byStatus.active, unit: 'count' },
      { label: '合同额', value: s.currentAmount, unit: 'money' },
      { label: '付款比例', value: s.paymentRate, unit: 'ratio' },
    ] });
  }
  if (can('expense:read')) {
    blocks.push({ key: 'expense', label: '费用报销', path: '/expense?status=audited', metrics: [
      { label: '待复核', value: count(`SELECT COUNT(*) AS n FROM ex_claim WHERE status = 'audited' AND ${sc.sql}`), unit: 'count' },
      { label: '退回补件', value: count(`SELECT COUNT(*) AS n FROM ex_claim WHERE status = 'supplement' AND ${sc.sql}`), unit: 'count' },
    ] });
  }
  if (can('project_budget:read')) {
    const s = projectBudgetSummary(db);
    blocks.push({ key: 'project_budget', label: '项目预算', path: '/project-budget', metrics: s.batch ? [
      { label: `执行率(${s.batch.period})`, value: s.totals.executionRate, unit: 'ratio' },
      { label: '预算', value: s.totals.budget, unit: 'money' },
    ] : [{ label: '执行率', value: null, unit: 'ratio', note: s.notes[0] ?? '没有已激活的项目预算批次' }] });
  }
  if (can('risk:read')) {
    const s = riskSummary(db);
    const scanned = (db.prepare('SELECT 1 FROM risk_scan LIMIT 1').get()) !== undefined;
    blocks.push({ key: 'risk', label: '风险', path: '/risk', metrics: [
      { label: '未关闭', value: s.openCount, unit: 'count' },
      scanned ? { label: '未关闭金额', value: s.openAmount, unit: 'money' } : { label: '未关闭金额', value: null, unit: 'money', note: '尚未执行风险扫描' },
      { label: '已逾期', value: s.overdue, unit: 'count' },
    ] });
  }
  if (can('investment:read')) {
    const ic = scopeFilterSql(scope, 'p.org_id');
    const rows = db.prepare(`SELECT c.summary_json FROM ic_comparison c JOIN ic_project p ON p.id = c.project_id
      WHERE p.status = 'active' AND ${ic.sql} AND c.id = (SELECT MAX(id) FROM ic_comparison WHERE project_id = c.project_id)`).all(...ic.params) as { summary_json: string }[];
    const exceeded = rows.filter((r) => {
      const s = JSON.parse(r.summary_json) as { totalLevel?: string; exceedCount?: number };
      return s.totalLevel === 'exceed' || (s.exceedCount ?? 0) > 0;
    }).length;
    blocks.push({ key: 'investment', label: '投资控制', path: '/investment-control', metrics: [
      { label: '有对比快照的项目', value: rows.length, unit: 'count' },
      { label: '最新快照超限项目', value: exceeded, unit: 'count' },
    ] });
  }
  if (can('report:read')) {
    blocks.push({ key: 'report', label: '分析报告', path: '/analysis-reports', metrics: [
      { label: '待审批', value: count(`SELECT COUNT(*) AS n FROM rpt_report WHERE status = 'pending_approval' AND ${sc.sql}`), unit: 'count' },
      { label: '待发布', value: count(`SELECT COUNT(*) AS n FROM rpt_report WHERE status = 'approved' AND ${sc.sql}`), unit: 'count' },
      { label: '已发布', value: count(`SELECT COUNT(*) AS n FROM rpt_report WHERE status = 'published' AND ${sc.sql}`), unit: 'count' },
    ] });
  }
  return { blocks };
}
