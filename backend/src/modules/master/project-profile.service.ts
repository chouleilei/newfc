/**
 * 项目档案(360 视图):主数据 + 项目预算、计划执行、合同与付款、EAS 凭证、风险、投资控制/可研、相关报告、操作日志。
 * 只读;项目本身按组织范围可见(范围外 404),各分区再按该域读权限裁剪(无权限返回 null),
 * 分区内的行也按组织范围过滤——与各域列表接口同一口径,不因从档案进入而放宽。
 */
import type { DB } from '../../db/connection';
import { currentAuth } from '../../core/request-context';
import { centsToDecimalOrNull, centsToDecimalString, ratioString } from '../../core/decimal';
import { currentOrgScope, hasPermission, scopeFilterSql, type OrgScope } from '../security/scope';
import type { Permission } from '../security/permissions';
import { getProject } from './master.service';
import { factValueText, fieldLabel, type PlanValueType } from '../plan-execution/plan.parse';
import type { PlanSheetCode } from '../../contracts/plan-execution';
import type { IcComparisonSummaryDto } from '../../contracts/investment-control';
import type {
  ProjectProfileBudgetDto, ProjectProfileContractsDto, ProjectProfileDto, ProjectProfileInvestmentDto, ProjectProfileLogDto, ProjectProfilePlanDto,
  ProjectProfileReportDto, ProjectProfileRisksDto, ProjectProfileVouchersDto,
} from '../../contracts/project-profile';

const VOUCHER_LINE_LIMIT = 50;
const PAYMENT_LIMIT = 30;
const LOG_LIMIT = 50;

function allowed(permission: Permission): boolean {
  const auth = currentAuth();
  return !auth || hasPermission(auth, permission);
}

const orgName = (db: DB, id: number | null) => (id === null ? null : (db.prepare('SELECT name FROM org WHERE id = ?').get(id) as { name: string } | undefined)?.name ?? null);

function budgetSection(db: DB, projectId: number, scope: OrgScope): ProjectProfileBudgetDto {
  const batch = db.prepare('SELECT id, year, period FROM pb_batch WHERE is_current = 1 ORDER BY year DESC, period DESC LIMIT 1').get() as
    { id: number; year: number; period: string } | undefined;
  if (!batch) return { batch: null, budget: '0.00', executed: '0.00', rate: null, rows: [] };
  const f = scopeFilterSql(scope, 'e.org_id');
  const rows = db.prepare(`SELECT e.fund_source, e.expense_category, e.exec_month, o.name AS org_name, e.budget_cents, e.executed_cents
    FROM pb_entry e JOIN org o ON o.id = e.org_id WHERE e.batch_id = ? AND e.project_id = ? AND ${f.sql} ORDER BY e.row_no`)
    .safeIntegers(true).all(batch.id, projectId, ...f.params) as
    { fund_source: string; expense_category: string; exec_month: string; org_name: string; budget_cents: bigint; executed_cents: bigint }[];
  const budget = rows.reduce((s, r) => s + r.budget_cents, 0n);
  const executed = rows.reduce((s, r) => s + r.executed_cents, 0n);
  return {
    batch, budget: centsToDecimalString(budget), executed: centsToDecimalString(executed), rate: ratioString(executed, budget),
    rows: rows.map((r) => ({
      fundSource: r.fund_source, expenseCategory: r.expense_category ?? '', orgName: r.org_name, execMonth: r.exec_month ?? '',
      budget: centsToDecimalString(r.budget_cents), executed: centsToDecimalString(r.executed_cents),
    })),
  };
}

function planSection(db: DB, projectId: number, scope: OrgScope): ProjectProfilePlanDto {
  const batch = db.prepare('SELECT id, year, actual_period FROM plan_batch WHERE is_current = 1 ORDER BY year DESC, actual_period DESC LIMIT 1').get() as
    { id: number; year: number; actual_period: string } | undefined;
  if (!batch) return { batch: null, items: [] };
  const f = scopeFilterSql(scope, 'i.org_id');
  const items = db.prepare(`SELECT i.id, i.sheet_code, i.item_name, o.name AS org_name FROM plan_item i LEFT JOIN org o ON o.id = i.org_id
    WHERE i.batch_id = ? AND i.project_id = ? AND ${f.sql} ORDER BY i.sheet_code, i.row_no`).all(batch.id, projectId, ...f.params) as
    { id: number; sheet_code: PlanSheetCode; item_name: string; org_name: string | null }[];
  const facts = db.prepare('SELECT field_key, value_type, amount_cents, scaled_value, text_value FROM plan_fact WHERE item_id = ? ORDER BY id').safeIntegers(true);
  return {
    batch: { id: batch.id, year: batch.year, actualPeriod: batch.actual_period },
    items: items.map((it) => ({
      itemId: it.id, sheetCode: it.sheet_code, itemName: it.item_name, orgName: it.org_name ?? '',
      facts: (facts.all(it.id) as { field_key: string; value_type: PlanValueType; amount_cents: bigint | null; scaled_value: bigint | null; text_value: string | null }[])
        .map((x) => ({
          key: x.field_key, label: fieldLabel(it.sheet_code, x.field_key), valueType: x.value_type,
          value: factValueText({ valueType: x.value_type, amount: x.amount_cents, scaled: x.scaled_value, text: x.text_value }),
        })),
    })),
  };
}

function contractsSection(db: DB, projectId: number, scope: OrgScope): ProjectProfileContractsDto {
  const f = scopeFilterSql(scope, 'c.org_id');
  const rows = db.prepare(`SELECT c.id, c.contract_no, c.name, s.name AS supplier_name, o.name AS org_name, c.stage, c.status, c.sign_date,
      c.original_cents + c.approved_change_cents AS current_cents, c.paid_cents
    FROM ct_contract c JOIN org o ON o.id = c.org_id LEFT JOIN md_supplier s ON s.id = c.supplier_id
    WHERE c.project_id = ? AND ${f.sql} ORDER BY c.id DESC`).safeIntegers(true).all(projectId, ...f.params) as
    { id: bigint; contract_no: string; name: string; supplier_name: string | null; org_name: string; stage: string; status: string; sign_date: string | null; current_cents: bigint; paid_cents: bigint }[];
  const docs = db.prepare('SELECT doc_type, COUNT(*) AS n FROM ct_document WHERE contract_id = ? GROUP BY doc_type');
  const live = rows.filter((r) => r.status !== 'voided');
  const current = live.reduce((s, r) => s + r.current_cents, 0n);
  const paid = live.reduce((s, r) => s + r.paid_cents, 0n);
  const ids = rows.map((r) => Number(r.id));
  const payments = ids.length === 0 ? [] : db.prepare(`SELECT p.id, p.contract_id, c.contract_no, p.node_name, p.amount_cents, p.status, p.paid_date, p.voucher_no
    FROM ct_payment p JOIN ct_contract c ON c.id = p.contract_id WHERE p.contract_id IN (${ids.map(() => '?').join(',')})
    ORDER BY COALESCE(p.paid_date, p.submitted_at) DESC, p.id DESC LIMIT ${PAYMENT_LIMIT}`).safeIntegers(true).all(...ids) as
    { id: bigint; contract_id: bigint; contract_no: string; node_name: string; amount_cents: bigint; status: string; paid_date: string | null; voucher_no: string | null }[];
  return {
    count: rows.length, currentTotal: centsToDecimalString(current), paidTotal: centsToDecimalString(paid), paidRate: ratioString(paid, current),
    rows: rows.map((r) => ({
      id: Number(r.id), contractNo: r.contract_no, name: r.name, supplierName: r.supplier_name, orgName: r.org_name, stage: r.stage, status: r.status,
      current: centsToDecimalString(r.current_cents), paid: centsToDecimalString(r.paid_cents), signDate: r.sign_date,
      documents: Object.fromEntries((docs.all(Number(r.id)) as { doc_type: string; n: number }[]).map((d) => [d.doc_type, d.n])),
    })),
    payments: payments.map((p) => ({
      id: Number(p.id), contractId: Number(p.contract_id), contractNo: p.contract_no, nodeName: p.node_name, amount: centsToDecimalString(p.amount_cents),
      status: p.status, paidDate: p.paid_date, voucherNo: p.voucher_no,
    })),
  };
}

/** EAS 凭证:当前凭证批次中项目编码等于主数据编码,或经有效项目编码映射指向本项目的分录。 */
function vouchersSection(db: DB, projectId: number, code: string, scope: OrgScope): ProjectProfileVouchersDto {
  const mapped = (db.prepare(`SELECT source_key FROM md_code_mapping WHERE entity_type = 'project' AND match_kind = 'code' AND target_id = ? AND valid_to IS NULL`)
    .all(projectId) as { source_key: string }[]).map((m) => m.source_key);
  const codes = [...new Set([code, ...mapped])];
  const f = scopeFilterSql(scope, 'b.org_id');
  const where = `b.data_type = 'voucher' AND b.is_current = 1 AND trim(l.project_code) IN (${codes.map(() => '?').join(',')}) AND ${f.sql}`;
  const params = [...codes, ...f.params];
  const total = db.prepare(`SELECT COUNT(*) AS n, COALESCE(SUM(l.debit_cents), 0) AS debit, COALESCE(SUM(l.credit_cents), 0) AS credit
    FROM eas_voucher_line l JOIN eas_batch b ON b.id = l.batch_id WHERE ${where}`).safeIntegers(true).get(...params) as { n: bigint; debit: bigint; credit: bigint };
  const lines = db.prepare(`SELECT l.batch_id, b.period, o.name AS org_name, l.voucher_date, l.voucher_no, l.account_code, l.account_name, l.summary, l.debit_cents, l.credit_cents
    FROM eas_voucher_line l JOIN eas_batch b ON b.id = l.batch_id JOIN org o ON o.id = b.org_id WHERE ${where}
    ORDER BY b.period DESC, l.voucher_date DESC, l.id DESC LIMIT ${VOUCHER_LINE_LIMIT}`).safeIntegers(true).all(...params) as
    { batch_id: bigint; period: string; org_name: string; voucher_date: string | null; voucher_no: string; account_code: string; account_name: string; summary: string | null; debit_cents: bigint; credit_cents: bigint }[];
  return {
    projectCodes: codes, lineCount: Number(total.n), debitTotal: centsToDecimalString(total.debit), creditTotal: centsToDecimalString(total.credit),
    lines: lines.map((l) => ({
      batchId: Number(l.batch_id), period: l.period, orgName: l.org_name, voucherDate: l.voucher_date, voucherNo: l.voucher_no, accountCode: l.account_code,
      accountName: l.account_name, summary: l.summary, debit: centsToDecimalString(l.debit_cents), credit: centsToDecimalString(l.credit_cents),
    })),
  };
}

function risksSection(db: DB, projectId: number, scope: OrgScope): ProjectProfileRisksDto {
  const f = scopeFilterSql(scope, 'e.org_id');
  const rows = db.prepare(`SELECT e.id, e.rule_code, r.name AS rule_name, e.level, e.status, e.title, e.amount_cents, e.last_detected_at
    FROM risk_event e JOIN risk_rule r ON r.code = e.rule_code WHERE e.project_id = ? AND ${f.sql}
    ORDER BY CASE WHEN e.status IN ('closed','false_positive') THEN 1 ELSE 0 END, e.last_detected_at DESC, e.id DESC`).safeIntegers(true).all(projectId, ...f.params) as
    { id: bigint; rule_code: string; rule_name: string; level: string; status: string; title: string; amount_cents: bigint | null; last_detected_at: string }[];
  return {
    total: rows.length, openCount: rows.filter((r) => !['closed', 'false_positive'].includes(r.status)).length,
    rows: rows.map((r) => ({
      id: Number(r.id), ruleCode: r.rule_code, ruleName: r.rule_name, level: r.level, status: r.status, title: r.title,
      amount: centsToDecimalOrNull(r.amount_cents), lastDetectedAt: r.last_detected_at,
    })),
  };
}

function investmentSection(db: DB, projectId: number, scope: OrgScope): ProjectProfileInvestmentDto {
  const f = scopeFilterSql(scope, 'org_id');
  const ic = db.prepare(`SELECT id, approved_cents, status FROM ic_project WHERE md_project_id = ? AND ${f.sql}`).safeIntegers(true).get(projectId, ...f.params) as
    { id: bigint; approved_cents: bigint | null; status: string } | undefined;
  let control: ProjectProfileInvestmentDto['control'] = null;
  if (ic) {
    const icId = Number(ic.id);
    const versions = db.prepare(`SELECT id, version_type, name, static_cents, dynamic_cents, approval_date FROM ic_version
      WHERE project_id = ? AND is_current = 1 ORDER BY id`).safeIntegers(true).all(icId) as
      { id: bigint; version_type: string; name: string; static_cents: bigint; dynamic_cents: bigint; approval_date: string | null }[];
    const cmp = db.prepare('SELECT id, created_at, summary_json FROM ic_comparison WHERE project_id = ? ORDER BY id DESC LIMIT 1').get(icId) as
      { id: number; created_at: string; summary_json: string } | undefined;
    const summary = cmp ? JSON.parse(cmp.summary_json) as IcComparisonSummaryDto : null;
    control = {
      id: icId, approved: centsToDecimalOrNull(ic.approved_cents), status: ic.status,
      versions: versions.map((v) => ({
        id: Number(v.id), versionType: v.version_type, name: v.name, staticAmount: centsToDecimalString(v.static_cents),
        dynamicAmount: centsToDecimalString(v.dynamic_cents), approvalDate: v.approval_date,
      })),
      latestComparison: cmp && summary ? { id: cmp.id, createdAt: cmp.created_at, totalDeviation: summary.totalDeviation, totalDeviationRate: summary.totalDeviationRate ?? null } : null,
    };
  }
  const feasibility = db.prepare(`SELECT p.id, p.code, p.name, p.status, (SELECT COUNT(*) FROM if_scenario s WHERE s.project_id = p.id) AS scenarios
    FROM if_project p WHERE p.md_project_id = ? AND ${scopeFilterSql(scope, 'p.org_id').sql} ORDER BY p.id`)
    .all(projectId, ...scopeFilterSql(scope, 'p.org_id').params) as { id: number; code: string; name: string; status: string; scenarios: number }[];
  return { control, feasibility: feasibility.map((p) => ({ id: p.id, code: p.code, name: p.name, status: p.status, scenarioCount: p.scenarios })) };
}

/** 相关报告:项目所属组织及其上级组织(含全组织报告)的已审批/已发布分析报告,按可见范围过滤。 */
function reportsSection(db: DB, orgId: number, scope: OrgScope): ProjectProfileReportDto[] {
  const chain = (db.prepare('WITH RECURSIVE up(id, parent_id) AS (SELECT id, parent_id FROM org WHERE id = ? UNION ALL SELECT o.id, o.parent_id FROM org o JOIN up ON o.id = up.parent_id) SELECT id FROM up')
    .all(orgId) as { id: number }[]).map((r) => r.id).filter((id) => scope.all || scope.orgIds.has(id));
  const orgCond = [...(scope.all ? ['org_id IS NULL'] : []), ...(chain.length ? [`org_id IN (${chain.map(() => '?').join(',')})`] : [])];
  if (orgCond.length === 0) return [];
  const rows = db.prepare(`SELECT id, title, kind, year, status, org_id, updated_at FROM rpt_report
    WHERE status IN ('approved','published') AND (${orgCond.join(' OR ')}) ORDER BY updated_at DESC, id DESC LIMIT 20`).all(...chain) as
    { id: number; title: string; kind: string; year: number | null; status: string; org_id: number | null; updated_at: string }[];
  return rows.map((r) => ({ id: r.id, title: r.title, kind: r.kind, year: r.year, status: r.status, orgName: orgName(db, r.org_id), updatedAt: r.updated_at }));
}

/** 操作日志:项目主数据本身与其下合同的变更记录(需审计查看权限)。 */
function logsSection(db: DB, projectId: number, contractIds: number[]): ProjectProfileLogDto[] {
  const cond = ["(entity_type = 'md_project' AND entity_id = ?)"];
  const params: string[] = [String(projectId)];
  if (contractIds.length) { cond.push(`(entity_type = 'ct_contract' AND entity_id IN (${contractIds.map(() => '?').join(',')}))`); params.push(...contractIds.map(String)); }
  const rows = db.prepare(`SELECT id, action, entity_type, entity_id, actor, result, created_at FROM operation_log WHERE ${cond.join(' OR ')}
    ORDER BY id DESC LIMIT ${LOG_LIMIT}`).all(...params) as { id: number; action: string; entity_type: string; entity_id: string; actor: string; result: string; created_at: string }[];
  return rows.map((r) => ({ id: r.id, action: r.action, entityType: r.entity_type, entityId: r.entity_id, actor: r.actor || null, result: r.result, createdAt: r.created_at }));
}

export function getProjectProfile(db: DB, id: number): ProjectProfileDto {
  const project = getProject(db, id); // 范围外与不存在同为 404
  const scope = currentOrgScope(db);
  const contracts = allowed('contract:read') ? contractsSection(db, id, scope) : null;
  return {
    project,
    budget: allowed('project_budget:read') ? budgetSection(db, id, scope) : null,
    plan: allowed('plan:read') ? planSection(db, id, scope) : null,
    contracts,
    vouchers: allowed('eas:read') ? vouchersSection(db, id, project.code, scope) : null,
    risks: allowed('risk:read') ? risksSection(db, id, scope) : null,
    investment: allowed('investment:read') ? investmentSection(db, id, scope) : null,
    reports: allowed('report:read') ? reportsSection(db, project.orgId, scope) : null,
    logs: allowed('audit:read') ? logsSection(db, id, contracts?.rows.map((c) => c.id) ?? []) : null,
    generatedAt: new Date().toISOString(),
  };
}
