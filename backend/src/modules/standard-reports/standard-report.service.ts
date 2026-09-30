/**
 * 标准报表(AC-F19):生成时冻结列、行、摘要和来源引用(批次、集合、版本),此后页面与导出只读冻结内容。
 *
 * - 经营预算执行表复用 report/completion 的同一取数(completionReport);财务报表摘要读当前财报批次(statementOverview);
 *   EAS 对账结果表读当前集合的规则结果(periodStatus);合同付款台账读合同当前状态与期间内支付,冻结每份合同的版本号。
 * - 复核:report:approve,生成人 ≠ 复核人(管理员同人须写例外原因);只能复核一次(REPORT_ALREADY_REVIEWED)。
 * - 组织范围:报表带组织时按组织裁剪(范围外 404);全组织口径的报表只对全组织用户开放。
 */
import crypto from 'crypto';
import ExcelJS from 'exceljs';
import type { DB } from '../../db/connection';
import { AppError } from '../../core/errors';
import { currentAuth } from '../../core/request-context';
import { centsToDecimalString, ratioString } from '../../core/decimal';
import { SIGN_BY_TYPE } from '../../core/money';
import { writeLog } from '../audit/log';
import { notVisible, orgInScope, requireCurrentAllOrgs, resolveOrgScope, type OrgScope } from '../security/scope';
import { assertDistinctReviewer } from '../security/review';
import { completionReport } from '../report/report.service';
import { getVersion } from '../budget/budget.service';
import { statementOverview } from '../statements/statement.service';
import { periodStatus } from '../eas/eas.service';
import { RULE_LABELS } from '../governance/governance.sources';
import { STATEMENT_METRICS, STATEMENT_METRIC_LABELS } from '../../contracts/statements';
import { CONTRACT_STAGE_LABELS, CONTRACT_STATUS_LABELS, type ContractStage, type ContractStatus } from '../../contracts/project-contract';
import {
  STD_REPORT_TYPE_LABELS, type StdCellValue, type StdColumnDto, type StdReportDto, type StdReportGenerate, type StdReportListItemDto, type StdReportReview,
  type StdReportType,
} from '../../contracts/standard-reports';

const nowIso = () => new Date().toISOString();

function scope(db: DB): OrgScope {
  const auth = currentAuth();
  return auth ? resolveOrgScope(db, auth) : { all: true };
}

function orgName(db: DB, orgId: number | null): string | null {
  if (orgId === null) return null;
  return (db.prepare('SELECT name FROM org WHERE id = ?').get(orgId) as { name: string } | undefined)?.name ?? null;
}

function assertOrg(db: DB, orgId: number): void {
  if (!db.prepare('SELECT 1 FROM org WHERE id = ?').get(orgId) || !orgInScope(scope(db), orgId)) throw notVisible('组织');
}

const sourceMissing = (message: string) => new AppError('REPORT_SOURCE_MISSING', message, 409);

interface Frozen {
  title: string; orgId: number | null; period: string; params: Record<string, unknown>;
  columns: StdColumnDto[]; rows: Record<string, StdCellValue>[]; summary: { label: string; value: string }[]; sources: Record<string, unknown>;
}

/* ================= 三类报表的取数 ================= */

function budgetExecution(db: DB, input: Extract<StdReportGenerate, { reportType: 'budget_execution' }>): Frozen {
  if (input.orgId) assertOrg(db, input.orgId);
  else requireCurrentAllOrgs('全组织经营预算执行表');
  let versionId = input.versionId;
  if (!versionId) {
    const cur = db.prepare("SELECT id FROM budget_version WHERE year = ? AND kind = 'budget' AND is_current = 1").get(input.year) as { id: number } | undefined;
    if (!cur) throw sourceMissing(`${input.year} 年没有当前采用的经营预算版本`);
    versionId = cur.id;
  }
  const version = getVersion(db, versionId);
  if (version.year !== input.year || version.kind !== 'budget') throw new AppError('VALIDATION_FAILED', '预算版本与所选年度或用途不一致', 400);
  const report = completionReport(db, { versionId, orgScopeId: input.orgId ?? null });
  const rows: Frozen['rows'] = [];
  for (const a of report.byAccount) {
    if (a.type === 'quantity') continue;
    const sign = BigInt(SIGN_BY_TYPE[a.type as 'income' | 'cost' | 'expense']);
    const budget = BigInt(a.cell.budgetCents) * sign;
    const actual = BigInt(a.cell.actualCents) * sign;
    rows.push({
      code: a.code, name: `${'  '.repeat(Math.max(0, a.level - 1))}${a.name}`, level: a.level,
      budget: centsToDecimalString(budget), actual: centsToDecimalString(actual), variance: centsToDecimalString(actual - budget),
      rate: ratioString(actual, budget),
    });
  }
  const scopeName = input.orgId ? orgName(db, input.orgId)! : '全组织';
  return {
    title: `${input.year} 年经营预算执行表 · ${scopeName}`, orgId: input.orgId ?? null, period: String(input.year),
    params: { year: input.year, versionId, orgId: input.orgId ?? null },
    columns: [
      { key: 'code', label: '科目编码', kind: 'text' }, { key: 'name', label: '科目', kind: 'text' }, { key: 'level', label: '层级', kind: 'integer' },
      { key: 'budget', label: '全年预算', kind: 'money' }, { key: 'actual', label: '累计实际', kind: 'money' },
      { key: 'variance', label: '差异(实际−预算)', kind: 'money' }, { key: 'rate', label: '执行率', kind: 'ratio' },
    ],
    rows,
    summary: [
      { label: '预算版本', value: `${version.name}(#${version.id})` },
      { label: '实际数来源', value: report.actualSource === 'none' ? '无实际数' : `${report.actualSource}${report.actualBatchId ? ` 批次 #${report.actualBatchId}` : ''}` },
      { label: '实际截至', value: report.asOfDate ?? '—' },
      { label: '组织范围', value: scopeName },
    ],
    sources: { budgetVersionId: versionId, actualSource: report.actualSource, actualBatchId: report.actualBatchId, asOfDate: report.asOfDate },
  };
}

function statementSummary(db: DB, input: Extract<StdReportGenerate, { reportType: 'statement_summary' }>): Frozen {
  assertOrg(db, input.orgId);
  const ov = statementOverview(db, { orgId: input.orgId, period: input.period, scope: input.scope });
  if (!ov.batch || !ov.metrics || !ov.ratios) throw sourceMissing(`${orgName(db, input.orgId)} ${input.period} 没有当前财务报表批次`);
  const b = ov.batch;
  return {
    title: `${input.period} 财务报表摘要 · ${b.orgName}`, orgId: input.orgId, period: input.period, params: { orgId: input.orgId, period: input.period, scope: input.scope ?? null },
    columns: [{ key: 'key', label: '指标键', kind: 'text' }, { key: 'item', label: '项目', kind: 'text' }, { key: 'amount', label: '金额', kind: 'money' }],
    rows: STATEMENT_METRICS.map((k) => ({ key: k, item: STATEMENT_METRIC_LABELS[k], amount: ov.metrics![k] })),
    summary: [
      { label: '报表批次', value: `#${b.id} ${b.fileName}` }, { label: '口径', value: b.scope },
      { label: '资产负债率', value: ov.ratios.debt_asset_ratio ?? '—' }, { label: '权益比率', value: ov.ratios.equity_ratio ?? '—' },
      { label: '净利率', value: ov.ratios.net_profit_margin ?? '—' },
    ],
    sources: { statementBatchId: b.id, statementBatchVersion: b.version, fileSha256: b.fileSha256, scope: b.scope },
  };
}

function easRecon(db: DB, input: Extract<StdReportGenerate, { reportType: 'eas_recon' }>): Frozen {
  assertOrg(db, input.orgId);
  const st = periodStatus(db, input.orgId, input.period);
  const set = st.currentSet;
  if (!set) throw sourceMissing(`${st.orgName} ${input.period} 没有当前 EAS 集合`);
  return {
    title: `${input.period} EAS 对账结果表 · ${st.orgName}`, orgId: input.orgId, period: input.period, params: { orgId: input.orgId, period: input.period },
    columns: [
      { key: 'ruleCode', label: '规则编码', kind: 'text' }, { key: 'rule', label: '规则', kind: 'text' }, { key: 'status', label: '结果', kind: 'text' },
      { key: 'diffCount', label: '差异条数', kind: 'integer' }, { key: 'diffAmount', label: '差异金额', kind: 'money' }, { key: 'note', label: '说明', kind: 'text' },
    ],
    rows: set.results.map((r) => ({
      ruleCode: r.ruleCode, rule: RULE_LABELS[r.ruleCode] ?? r.ruleCode, status: r.status, diffCount: r.diffCount, diffAmount: r.diffAmount,
      note: typeof r.details.message === 'string' ? r.details.message : '',
    })),
    summary: [
      { label: '对账集合', value: `#${set.id}(版本 ${set.version})` }, { label: '集合状态', value: set.status },
      { label: '期间锁', value: st.lock ? '已锁定' : '未锁定' }, { label: '批次', value: set.batches.map((b) => `${b.dataType}#${b.batchId}`).join(', ') },
    ],
    sources: { easSetId: set.id, easSetVersion: set.version, batches: set.batches.map((b) => ({ dataType: b.dataType, batchId: b.batchId })), locked: !!st.lock },
  };
}

function contractPaymentLedger(db: DB, input: Extract<StdReportGenerate, { reportType: 'contract_payment_ledger' }>): Frozen {
  if (input.orgId) assertOrg(db, input.orgId);
  else requireCurrentAllOrgs('全组织合同付款台账');
  const where = ["c.status <> 'voided'"];
  const params: unknown[] = [];
  if (input.orgId) {
    where.push('c.org_id IN (WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT o.id FROM org o JOIN sub ON o.parent_id = sub.id) SELECT id FROM sub)');
    params.push(input.orgId);
  }
  if (input.projectId) { where.push('c.project_id = ?'); params.push(input.projectId); }
  const rows = db.prepare(`SELECT c.id, c.contract_no, c.name, c.stage, c.status, c.version, c.original_cents, c.approved_change_cents, c.paid_cents,
      o.name AS org_name, p.code AS project_code, p.name AS project_name, s.name AS supplier_name,
      (SELECT COALESCE(SUM(amount_cents), 0) FROM ct_payment WHERE contract_id = c.id AND status = 'paid' AND substr(paid_date, 1, 7) = ?) AS period_paid
    FROM ct_contract c JOIN org o ON o.id = c.org_id LEFT JOIN md_project p ON p.id = c.project_id LEFT JOIN md_supplier s ON s.id = c.supplier_id
    WHERE ${where.join(' AND ')} ORDER BY c.contract_no`).safeIntegers(true).all(input.period, ...params) as {
    id: bigint; contract_no: string; name: string; stage: ContractStage; status: ContractStatus; version: bigint; original_cents: bigint; approved_change_cents: bigint;
    paid_cents: bigint; org_name: string; project_code: string | null; project_name: string | null; supplier_name: string | null; period_paid: bigint;
  }[];
  let totalCurrent = 0n; let totalPaid = 0n; let totalPeriod = 0n;
  const out = rows.map((r) => {
    const current = r.original_cents + r.approved_change_cents;
    totalCurrent += current; totalPaid += r.paid_cents; totalPeriod += r.period_paid;
    return {
      contractNo: r.contract_no, name: r.name, org: r.org_name, project: r.project_code ? `${r.project_code} ${r.project_name}` : '', supplier: r.supplier_name ?? '',
      stage: CONTRACT_STAGE_LABELS[r.stage], status: CONTRACT_STATUS_LABELS[r.status], original: centsToDecimalString(r.original_cents),
      change: centsToDecimalString(r.approved_change_cents), current: centsToDecimalString(current), periodPaid: centsToDecimalString(r.period_paid),
      paid: centsToDecimalString(r.paid_cents), unpaid: centsToDecimalString(current - r.paid_cents), rate: ratioString(r.paid_cents, current), version: Number(r.version),
    };
  });
  const scopeName = input.orgId ? orgName(db, input.orgId)! : '全组织';
  return {
    title: `${input.period} 合同付款台账 · ${scopeName}`, orgId: input.orgId ?? null, period: input.period,
    params: { period: input.period, orgId: input.orgId ?? null, projectId: input.projectId ?? null },
    columns: [
      { key: 'contractNo', label: '合同编号', kind: 'text' }, { key: 'name', label: '合同名称', kind: 'text' }, { key: 'org', label: '组织', kind: 'text' },
      { key: 'project', label: '项目', kind: 'text' }, { key: 'supplier', label: '供应商', kind: 'text' }, { key: 'stage', label: '阶段', kind: 'text' },
      { key: 'status', label: '状态', kind: 'text' }, { key: 'original', label: '原始金额', kind: 'money' }, { key: 'change', label: '已批准变更', kind: 'money' },
      { key: 'current', label: '当前金额', kind: 'money' }, { key: 'periodPaid', label: '本期已付', kind: 'money' }, { key: 'paid', label: '累计已付', kind: 'money' },
      { key: 'unpaid', label: '未付', kind: 'money' }, { key: 'rate', label: '付款比例', kind: 'ratio' }, { key: 'version', label: '合同版本', kind: 'integer' },
    ],
    rows: out,
    summary: [
      { label: '合同数', value: String(out.length) }, { label: '当前金额合计', value: centsToDecimalString(totalCurrent) },
      { label: '本期已付合计', value: centsToDecimalString(totalPeriod) }, { label: '累计已付合计', value: centsToDecimalString(totalPaid) },
      { label: '整体付款比例', value: ratioString(totalPaid, totalCurrent) ?? '—' }, { label: '组织范围', value: scopeName },
    ],
    sources: { contracts: rows.map((r) => ({ id: Number(r.id), version: Number(r.version) })), period: input.period },
  };
}

/* ================= 生成 / 查询 / 复核 / 导出 ================= */

interface ReportRow {
  id: number; report_type: StdReportType; title: string; org_id: number | null; period: string; params_json: string; columns_json: string; rows_json: string;
  summary_json: string; sources_json: string; content_sha256: string; status: 'generated' | 'reviewed'; generated_by_user_id: number | null; generated_at: string;
  reviewed_by_user_id: number | null; reviewed_at: string | null; review_comment: string | null; exception_reason: string | null; self_review: number;
}

function visible(db: DB, orgId: number | null): boolean {
  const s = scope(db);
  return s.all || (orgId !== null && orgInScope(s, orgId));
}

function listItem(db: DB, r: ReportRow): StdReportListItemDto {
  return {
    id: r.id, reportType: r.report_type, title: r.title, orgId: r.org_id, orgName: orgName(db, r.org_id), period: r.period, status: r.status,
    rowCount: (JSON.parse(r.rows_json) as unknown[]).length, generatedByUserId: r.generated_by_user_id, generatedAt: r.generated_at,
    reviewedByUserId: r.reviewed_by_user_id, reviewedAt: r.reviewed_at,
  };
}

function dto(db: DB, r: ReportRow): StdReportDto {
  return {
    ...listItem(db, r), params: JSON.parse(r.params_json) as Record<string, unknown>, columns: JSON.parse(r.columns_json) as StdColumnDto[],
    rows: JSON.parse(r.rows_json) as Record<string, StdCellValue>[], summary: JSON.parse(r.summary_json) as { label: string; value: string }[],
    sources: JSON.parse(r.sources_json) as Record<string, unknown>, contentSha256: r.content_sha256, reviewComment: r.review_comment,
    exceptionReason: r.exception_reason, selfReview: r.self_review === 1,
  };
}

function getRow(db: DB, id: number): ReportRow {
  const r = db.prepare('SELECT * FROM std_report WHERE id = ?').get(id) as ReportRow | undefined;
  if (!r || !visible(db, r.org_id)) throw notVisible('标准报表');
  return r;
}

export function generateReport(db: DB, input: StdReportGenerate): StdReportDto {
  // 取数在写事务之外;冻结内容一次性写入
  const f = input.reportType === 'budget_execution' ? budgetExecution(db, input) : input.reportType === 'statement_summary' ? statementSummary(db, input)
    : input.reportType === 'eas_recon' ? easRecon(db, input) : contractPaymentLedger(db, input);
  const content = JSON.stringify({ columns: f.columns, rows: f.rows, summary: f.summary, sources: f.sources });
  const sha = crypto.createHash('sha256').update(content).digest('hex');
  const id = db.transaction(() => {
    const info = db.prepare(`INSERT INTO std_report (report_type, title, org_id, period, params_json, columns_json, rows_json, summary_json, sources_json, content_sha256,
      generated_by_user_id, generated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      input.reportType, f.title, f.orgId, f.period, JSON.stringify(f.params), JSON.stringify(f.columns), JSON.stringify(f.rows), JSON.stringify(f.summary),
      JSON.stringify(f.sources), sha, currentAuth()?.userId ?? null, nowIso());
    const newId = Number(info.lastInsertRowid);
    writeLog(db, 'report.standard.generate', 'std_report', newId, { reportType: input.reportType, title: f.title, orgId: f.orgId, period: f.period, sources: f.sources, rowCount: f.rows.length, contentSha256: sha });
    return newId;
  }).immediate();
  return getReport(db, id);
}

export function getReport(db: DB, id: number): StdReportDto {
  return dto(db, getRow(db, id));
}

export function listReports(db: DB, q: { reportType?: StdReportType; status?: string; period?: string } = {}): StdReportListItemDto[] {
  const where: string[] = ['1 = 1'];
  const params: unknown[] = [];
  if (q.reportType) { where.push('report_type = ?'); params.push(q.reportType); }
  if (q.status) { where.push('status = ?'); params.push(q.status); }
  if (q.period) { where.push('period = ?'); params.push(q.period); }
  return (db.prepare(`SELECT * FROM std_report WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT 500`).all(...params) as ReportRow[])
    .filter((r) => visible(db, r.org_id)).map((r) => listItem(db, r));
}

export function reviewReport(db: DB, id: number, input: StdReportReview): StdReportDto {
  db.transaction(() => {
    const r = getRow(db, id);
    if (r.status !== 'generated') throw new AppError('REPORT_ALREADY_REVIEWED', '该报表已复核,不能再次复核', 409);
    const { selfReview } = assertDistinctReviewer(db, currentAuth(), r.generated_by_user_id, input.exceptionReason, '标准报表');
    db.prepare(`UPDATE std_report SET status = 'reviewed', reviewed_by_user_id = ?, reviewed_at = ?, review_comment = ?, exception_reason = ?, self_review = ? WHERE id = ?`)
      .run(currentAuth()?.userId ?? null, nowIso(), input.comment ?? null, input.exceptionReason ?? null, selfReview ? 1 : 0, id);
    writeLog(db, 'report.standard.review', 'std_report', id, { comment: input.comment, selfReview, exceptionReason: input.exceptionReason, contentSha256: r.content_sha256 });
  }).immediate();
  return getReport(db, id);
}

/** Excel 与页面同源:只写冻结的列与行,金额列按两位小数数字格式,比率按 6 位小数。 */
export async function exportReport(db: DB, id: number): Promise<{ fileName: string; buffer: Buffer }> {
  const r = getReport(db, id);
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(STD_REPORT_TYPE_LABELS[r.reportType]);
  ws.addRow([r.title]).font = { bold: true, size: 14 };
  ws.addRow([`状态:${r.status === 'reviewed' ? '已复核' : '待复核'}`, `生成时间:${r.generatedAt}`, `内容摘要:${r.contentSha256.slice(0, 16)}`]);
  ws.addRow([]);
  const header = ws.addRow(r.columns.map((c) => c.label));
  header.font = { bold: true };
  const HEADER_ROW = header.number;
  for (const row of r.rows) {
    ws.addRow(r.columns.map((c) => {
      const v = row[c.key];
      if (v === null || v === undefined) return null;
      if ((c.kind === 'money' || c.kind === 'ratio') && typeof v === 'string') {
        const n = Number(v);
        // 超出双精度可精确表示范围的金额按文本写出,保证与页面一致
        return Number.isFinite(n) && Math.abs(n) < 1e13 && n.toFixed(c.kind === 'money' ? 2 : 6) === v ? n : v;
      }
      return v;
    }));
  }
  r.columns.forEach((c, i) => {
    const col = ws.getColumn(i + 1);
    col.width = c.kind === 'text' ? 28 : 18;
    if (c.kind === 'money') col.numFmt = '#,##0.00';
    if (c.kind === 'ratio') col.numFmt = '0.000000';
  });
  ws.addRow([]);
  for (const s of r.summary) ws.addRow([s.label, s.value]);
  ws.views = [{ state: 'frozen', ySplit: HEADER_ROW }];
  const buffer = Buffer.from(await wb.xlsx.writeBuffer());
  writeLog(db, 'report.standard.export', 'std_report', id, { contentSha256: r.contentSha256, rowCount: r.rows.length });
  return { fileName: `${r.title.replace(/[\\/:*?"<>|]/g, '_')}.xlsx`, buffer };
}
