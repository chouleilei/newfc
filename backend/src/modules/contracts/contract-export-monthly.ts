import { orgReportPath, reportPeriod } from './contract-controls';
/**
 * 公司每月 28 日 5 表合同月报 Excel 生成器 & OA 监督门户只读查询（T-12.3 / T-12.4）。
 */
import crypto from 'node:crypto';
import ExcelJS from 'exceljs';
import type { DB } from '../../db/connection';
import { currentAuth } from '../../core/request-context';
import { centsToDecimalString, ratioString } from '../../core/decimal';
import { writeLog } from '../audit/log';
import { currentOrgScope, notVisible, orgInScope, scopeFilterSql, type OrgScope } from '../security/scope';
import type {
  ContractAcquisitionMethod, ContractDecisionMethod, ContractDirection, ContractFundingSource,
  ContractMeetingType, ContractPricingMode, ContractReportCategory, ContractStage, ContractStatus,
  ContractTenderBodyType, ContractTermType, SupervisionExportLogDto, SupervisionPortalItemDto,
  SupervisionPortalResponseDto,
} from '../../contracts/project-contract';
import type { LegalMetadata } from '../../contracts/contract-legal-review';
import { tryRmbCents } from './contract-funding';
import { procurementTier } from './legal-context';
import { recordMonthlyReportExported } from './contract-procurement.service';
import { CATEGORY_TO_LABEL, PROCUREMENT_TO_LABEL } from './supervision-template-spec';

const nowIso = () => new Date().toISOString();
const todayPeriod = () => nowIso().slice(0, 7);

export interface ExportContractRow {
  id: number; contract_no: string; name: string; contract_type: string; org_id: number;
  org_name: string; org_report_full_name: string; project_name: string | null; supplier_name: string | null;
  direction: ContractDirection; pricing_mode: ContractPricingMode; unit_price_desc: string;
  estimated_ceiling_cents: bigint | null; currency: string; report_category: ContractReportCategory;
  exchange_rate_scaled: bigint | null;
  summary_text: string; remark: string;
  is_procurement: number; procurement_target: LegalMetadata['procurementTarget'];
  procurement_method: LegalMetadata['procurementMethod']; procurement_method_other: string;
  procurement_plan_text: string; procurement_start_date: string | null; supplier_confirm_date: string | null;
  response_docs_complete: number | null; credit_checked: number | null;
  funding_source: ContractFundingSource; funding_source_detail: string;
  source_income_no: string | null; source_income_name: string | null;
  entrust_reason: string; is_triple_major: number; decision_method: ContractDecisionMethod | null;
  decision_method_other: string; meeting_type: ContractMeetingType | null; meeting_type_other: string;
  final_approver_name: string; final_approver_title: string; is_gov_procurement: number;
  counterparty_names: string; undertaker_name: string; undertaker_dept: string;
  dept_reviewer_name: string; related_mgmt_depts: string; related_mgmt_reviewers: string;
  unit_approver_name: string; unit_approver_title: string;
  acquisition_method: ContractAcquisitionMethod | null; acquisition_method_other: string;
  tender_body_type: ContractTenderBodyType | null; consortium_members: string;
  sign_date: string | null; term_type: ContractTermType; term_start_date: string | null;
  term_end_date: string | null; term_condition_text: string;
  our_signatory_name: string; our_signatory_title: string; our_signatory_is_legal_rep: number | null;
  counterparty_signatory_is_legal_rep: number | null;
  deliverable_submitted: number | null; final_accepted: number;
  original_cents: bigint; approved_change_cents: bigint; settled_net_cents: bigint;
  paid_cents: bigint; received_cents: bigint;
  stage: ContractStage; status: ContractStatus; archive_status: string;
  version: number; updated_at: string; created_at: string; completed_date: string | null; project_id: number | null;
  plan_item_id: number | null; plan_item_name: string | null; procurement_record_id: number | null;
  origin: 'manual' | 'standard_import' | 'legacy_migration';
  migration_mode: 'normal' | 'legacy_tolerant';
  is_reversal: number;
  currency_struct_status: 'single' | 'structured_multi' | 'partial_unstructured';
  duplicate_conflict_group: string;
  missing_fields_json: string;
}

export interface MonthlyStatsCurrencyRow {
  currency: string;
  newSignedCount: number;
  newSignedWan: string;
  closedCount: number;
  closedWan: string;
  changeCount: number;
  changeDeltaWan: string;
  settlementCount: number;
  settlementNetWan: string;
}

interface ProcurementRecordRow {
  id: number;
  tender_agency: string;
  announcement_date: string | null;
  prequal_sale_start: string | null;
  prequal_sale_end: string | null;
  doc_sale_start_date: string | null;
  clarification_site_date: string | null;
  bid_open_date: string | null;
  eval_report_submit_date: string | null;
  eval_report_receive_date: string | null;
  candidate_publicity_start: string | null;
  candidate_publicity_end: string | null;
  award_notice_date: string | null;
  candidate_ranking_json: string;
  protest_flag: number;
  protest_detail: string;
}

function formatCandidateRanking(jsonText: string): string {
  if (!jsonText) return '';
  try {
    const parsed = JSON.parse(jsonText);
    if (!Array.isArray(parsed) || parsed.length === 0) return '';
    return parsed
      .map((item, idx) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object') {
          const r = item as { rank?: number | string; name?: string; supplierName?: string };
          const label = r.name ?? r.supplierName ?? '';
          const rk = r.rank ?? idx + 1;
          return label ? `第${rk}名:${label}` : '';
        }
        return '';
      })
      .filter(Boolean)
      .join('；');
  } catch {
    return jsonText;
  }
}

/** 整数分精确转万元十进制字符串（1 万元 = 1,000,000 分），无浮点误差。 */
export function centsToWanString(cents: bigint, signed = false): string {
  const neg = cents < 0n;
  const abs = neg ? -cents : cents;
  const whole = abs / 1_000_000n;
  const frac = (abs % 1_000_000n).toString().padStart(6, '0');
  const trimmed = frac.replace(/0+$/, '');
  const decimals = trimmed.length <= 2 ? frac.slice(0, 2) : trimmed;
  const prefix = neg ? '-' : (signed && abs > 0n ? '+' : '');
  return `${prefix}${whole}.${decimals}`;
}

export function mapSupervisionExecStatus(status: ContractStatus, stage: ContractStage, signDate: string | null): SupervisionPortalItemDto['supervisionExecStatus'] {
  if (status === 'closed') return '已完成';
  if (status === 'terminated') return '未完成已终止';
  if (status === 'suspended') return '未完成已中止';
  if (!signDate && ['initiation', 'procurement', 'drafting', 'approval'].includes(stage)) return '未签署';
  return '执行中';
}

export function mapMonthlyExecStatus(status: ContractStatus, stage: ContractStage): string {
  if (status === 'closed' || status === 'terminated') return '完成';
  if (status === 'suspended') return '执行中';
  if (['initiation', 'procurement', 'drafting', 'approval'].includes(stage)) return '未执行';
  return '执行中';
}

export function queryScopedContracts(
  db: DB,
  scope: OrgScope,
  opts: { orgId?: number; includeVoided?: boolean } = {},
): ExportContractRow[] {
  if (opts.orgId !== undefined && !orgInScope(scope, opts.orgId)) throw notVisible('组织');
  const sc = scopeFilterSql(scope, 'c.org_id');
  const where = [sc.sql];
  if (!opts.includeVoided) where.push("c.status <> 'voided'");
  const params: unknown[] = [...sc.params];
  if (opts.orgId !== undefined) {
    where.push('c.org_id IN (WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT o.id FROM org o JOIN sub ON o.parent_id = sub.id) SELECT id FROM sub)');
    params.push(opts.orgId);
  }
  const raw = db.prepare(`SELECT c.*, o.name AS org_name, o.report_full_name AS org_report_full_name,
      p.name AS project_name, pi.item_name AS plan_item_name, s.name AS supplier_name,
      inc.contract_no AS source_income_no, inc.name AS source_income_name
    FROM ct_contract c
    JOIN org o ON o.id = c.org_id
    LEFT JOIN md_project p ON p.id = c.project_id
    LEFT JOIN plan_item pi ON pi.id = c.plan_item_id
    LEFT JOIN md_supplier s ON s.id = c.supplier_id
    LEFT JOIN ct_contract inc ON inc.id = c.source_income_contract_id
    WHERE ${where.join(' AND ')}
    ORDER BY c.contract_no ASC, c.id ASC`).safeIntegers(true).all(...params) as Record<string, unknown>[];
  return raw.map((r) => ({
    ...(r as unknown as ExportContractRow),
    id: Number(r.id),
    org_id: Number(r.org_id),
    project_id: r.project_id == null ? null : Number(r.project_id),
    plan_item_id: r.plan_item_id == null ? null : Number(r.plan_item_id),
    plan_item_name: r.plan_item_name == null ? null : String(r.plan_item_name),
    procurement_record_id: r.procurement_record_id == null ? null : Number(r.procurement_record_id),
    exchange_rate_scaled: r.exchange_rate_scaled == null ? null : BigInt(r.exchange_rate_scaled as bigint),
    is_procurement: Number(r.is_procurement ?? 1),
    is_triple_major: Number(r.is_triple_major ?? 0),
    is_gov_procurement: Number(r.is_gov_procurement ?? 0),
    response_docs_complete: r.response_docs_complete == null ? null : Number(r.response_docs_complete),
    credit_checked: r.credit_checked == null ? null : Number(r.credit_checked),
    our_signatory_is_legal_rep: r.our_signatory_is_legal_rep == null ? null : Number(r.our_signatory_is_legal_rep),
    counterparty_signatory_is_legal_rep: r.counterparty_signatory_is_legal_rep == null ? null : Number(r.counterparty_signatory_is_legal_rep),
    deliverable_submitted: r.deliverable_submitted == null ? null : Number(r.deliverable_submitted),
    final_accepted: Number(r.final_accepted ?? 0),
    version: Number(r.version),
    origin: (r.origin as ExportContractRow['origin']) ?? 'manual',
    migration_mode: (r.migration_mode as ExportContractRow['migration_mode']) ?? 'normal',
    is_reversal: Number(r.is_reversal ?? 0),
    currency_struct_status: (r.currency_struct_status as ExportContractRow['currency_struct_status']) ?? 'single',
    duplicate_conflict_group: String(r.duplicate_conflict_group ?? ''),
    missing_fields_json: String(r.missing_fields_json ?? '[]'),
    org_report_full_name: orgReportPath(db, Number(r.org_id)),
  }));
}

export function recordExportLog(
  db: DB,
  entry: { exportKind: 'monthly_ledger' | 'supervision_package'; orgId?: number; period: string; scopeMode: string; contractCount: number; fileName: string; buf: Buffer },
): void {
  const sha = crypto.createHash('sha256').update(entry.buf).digest('hex');
  const now = nowIso();
  const logId = Number(db.prepare(`INSERT INTO ct_supervision_export_log (export_kind, org_id, period, scope_mode, contract_count, file_name, file_sha256, byte_size, created_by_user_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
    entry.exportKind, entry.orgId ?? null, entry.period, entry.scopeMode, entry.contractCount,
    entry.fileName, sha, entry.buf.length, currentAuth()?.userId ?? null, now,
  ).lastInsertRowid);
  writeLog(db, `contract.export.${entry.exportKind}`, 'ct_supervision_export_log', logId, {
    period: entry.period, scopeMode: entry.scopeMode, contractCount: entry.contractCount, fileName: entry.fileName, byteSize: entry.buf.length,
  });
}

export function listSupervisionExportLogs(db: DB, limit = 30): SupervisionExportLogDto[] {
  const scope = currentOrgScope(db);
  const sc = scopeFilterSql(scope, 'org_id');
  const sqlWhere = scope.all ? '1=1' : `(org_id IS NULL OR ${sc.sql})`;
  const rows = db.prepare(`SELECT * FROM ct_supervision_export_log WHERE ${sqlWhere} ORDER BY id DESC LIMIT ?`)
    .all(...(scope.all ? [] : sc.params), limit) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: Number(r.id),
    exportKind: r.export_kind as SupervisionExportLogDto['exportKind'],
    orgId: r.org_id == null ? null : Number(r.org_id),
    period: String(r.period),
    scopeMode: String(r.scope_mode),
    contractCount: Number(r.contract_count),
    fileName: String(r.file_name),
    fileSha256: String(r.file_sha256),
    byteSize: Number(r.byte_size),
    createdAt: String(r.created_at),
  }));
}

export function buildMonthlyLedger(db: DB, opts: { period?: string; orgId?: number } = {}) {
  const period = reportPeriod(opts.period);
  const year = period.slice(0, 4);
  const month = period.slice(5, 7);
  const scope = currentOrgScope(db);
  const cutoff = `${period}-31`;
  const contracts = queryScopedContracts(db, scope, { orgId: opts.orgId }).filter(c => (c.sign_date || c.created_at.slice(0,10)) <= cutoff);
  const cIds = contracts.map((c) => c.id);
  const inIds = cIds.length ? `(${cIds.map(() => '?').join(',')})` : '(NULL)';

  const settlements = cIds.length ? (db.prepare(`SELECT id, contract_id, settlement_date, net_payable_cents FROM ct_settlement WHERE contract_id IN ${inIds} AND status = 'approved' AND settlement_date <= '${cutoff}' ORDER BY settlement_date, id`)
    .safeIntegers(true).all(...cIds) as { id: bigint; contract_id: bigint; settlement_date: string; net_payable_cents: bigint }[]) : [];
  const changes = cIds.length ? (db.prepare(`SELECT id, contract_id, delta_cents, reason, change_matter, COALESCE(reviewed_at, submitted_at) AS chg_at FROM ct_change WHERE contract_id IN ${inIds} AND status = 'approved' AND substr(COALESCE(reviewed_at, submitted_at),1,10) <= '${cutoff}' ORDER BY id`)
    .safeIntegers(true).all(...cIds) as { id: bigint; contract_id: bigint; delta_cents: bigint; reason: string; change_matter: string; chg_at: string }[]) : [];
  const openRisks = contractRiskRows(db, contracts).filter(r => r.created_at.slice(0,10) <= cutoff && !['closed','false_positive'].includes(r.status));

  const settlementsByCid = new Map<number, typeof settlements>();
  for (const s of settlements) {
    const cid = Number(s.contract_id);
    const arr = settlementsByCid.get(cid) ?? [];
    arr.push(s);
    settlementsByCid.set(cid, arr);
  }
  const changesByCid = new Map<number, typeof changes>();
  for (const ch of changes) {
    const cid = Number(ch.contract_id);
    const arr = changesByCid.get(cid) ?? [];
    arr.push(ch);
    changesByCid.set(cid, arr);
  }
  const risksByCid = new Map<number, string[]>();
  for (const r of openRisks) {
    const arr = risksByCid.get(r.contractId) ?? [];
    arr.push(r.title);
    risksByCid.set(r.contractId, arr);
  }

  for (const c of contracts) {
    c.approved_change_cents = (changesByCid.get(c.id) ?? []).reduce((s, ch) => s + ch.delta_cents, 0n);
    c.settled_net_cents = (settlementsByCid.get(c.id) ?? []).reduce((s, st) => s + st.net_payable_cents, 0n);
    c.paid_cents = (db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS s FROM ct_payment WHERE contract_id = ? AND status = 'paid' AND paid_date <= ?").safeIntegers(true).get(c.id, cutoff) as { s: bigint }).s;
    c.received_cents = (db.prepare("SELECT COALESCE(SUM(amount_cents),0) AS s FROM ct_receipt WHERE contract_id = ? AND status = 'received' AND received_date <= ?").safeIntegers(true).get(c.id, cutoff) as { s: bigint }).s;
    if (c.completed_date && c.completed_date > cutoff) { c.status = 'active'; c.stage = 'settlement'; }
    const event = db.prepare("SELECT event_type FROM ct_event WHERE contract_id = ? AND event_type IN ('suspend','resume','terminate','archive','reopen') AND substr(created_at,1,10) <= ? ORDER BY id DESC LIMIT 1").get(c.id, cutoff) as { event_type: string } | undefined;
    if (!event && db.prepare("SELECT 1 FROM ct_event WHERE contract_id = ? AND event_type IN ('suspend','resume','terminate','archive','reopen') AND substr(created_at,1,10) > ? LIMIT 1").get(c.id, cutoff)) c.status = 'active';
    if (event) c.status = ({ suspend: 'suspended', resume: 'active', terminate: 'terminated', archive: 'closed', reopen: 'active' } as const)[event.event_type as 'suspend'];
  }
  const wb = new ExcelJS.Workbook();
  const s1 = wb.addWorksheet('01_月度统计表');
  s1.addRow([`${year}年${month}月度统计（金额单位：万本币）`]);
  s1.mergeCells('A1:R1');
  s1.addRow(['序号', '本月新签', '', '', '本月执行完毕', '', '', '本月变更', '', '', '', '本月结算', '', '', '币种标示', '', '', '']);
  s1.mergeCells('A2:A3'); s1.mergeCells('B2:D2'); s1.mergeCells('E2:G2'); s1.mergeCells('H2:K2'); s1.mergeCells('L2:N2'); s1.mergeCells('O2:R2');
  s1.getRow(3).values = ['序号', '合同编号', '合同名称', '金额', '合同编号', '合同名称', '实际金额', '合同编号', '合同名称', '变更金额', '变更比例', '合同编号', '合同名称', '结算金额', '新签币种', '完结币种', '变更币种', '结算币种'];
  const newSigned = contracts.filter((c) => c.sign_date?.startsWith(period));
  const closedMonth = contracts.filter((c) => ['closed','terminated'].includes(c.status) && c.completed_date?.startsWith(period));
  const chgMonth = changes.filter((ch) => ch.chg_at.startsWith(period));
  const stlMonth = settlements.filter((s) => s.settlement_date.startsWith(period));
  const cById = new Map(contracts.map((c) => [c.id, c]));
  const maxLen1 = Math.max(newSigned.length, closedMonth.length, chgMonth.length, stlMonth.length);
  for (let i = 0; i < maxLen1; i++) {
    const a = newSigned[i]; const b = closedMonth[i];
    const ch = chgMonth[i]; const chc = ch ? cById.get(Number(ch.contract_id)) : undefined;
    const st = stlMonth[i]; const stc = st ? cById.get(Number(st.contract_id)) : undefined;
    s1.addRow([
      i + 1,
      a?.contract_no ?? '', a?.name ?? '', a ? (a.pricing_mode === 'unit_price' && a.original_cents === 0n ? '/' : centsToWanString(a.original_cents)) : '',
      b?.contract_no ?? '', b?.name ?? '', b ? centsToWanString(b.original_cents + b.approved_change_cents) : '',
      chc?.contract_no ?? '', chc?.name ?? '', ch ? centsToWanString(ch.delta_cents, true) : '', ch && chc ? (ratioString(ch.delta_cents, chc.original_cents) ?? '') : '',
      stc?.contract_no ?? '', stc?.name ?? '', st ? centsToWanString(st.net_payable_cents) : '', a?.currency ?? '', b?.currency ?? '', chc?.currency ?? '', stc?.currency ?? '',
    ]);
  }
  const statCurrencies = new Set<string>(['人民币']);
  for (const x of newSigned) statCurrencies.add(x.currency);
  for (const x of closedMonth) statCurrencies.add(x.currency);
  for (const ch of chgMonth) { const x = cById.get(Number(ch.contract_id)); if (x) statCurrencies.add(x.currency); }
  for (const st of stlMonth) { const x = cById.get(Number(st.contract_id)); if (x) statCurrencies.add(x.currency); }
  const monthlyStats: MonthlyStatsCurrencyRow[] = [];
  for (const cur of statCurrencies) {
    const nsCur = newSigned.filter((x) => x.currency === cur);
    const clCur = closedMonth.filter((x) => x.currency === cur);
    const chCur = chgMonth.filter((ch) => (cById.get(Number(ch.contract_id))?.currency ?? '人民币') === cur);
    const stCur = stlMonth.filter((st) => (cById.get(Number(st.contract_id))?.currency ?? '人民币') === cur);
    const nsSum = nsCur.reduce((s, x) => s + x.original_cents, 0n);
    const clSum = clCur.reduce((s, x) => s + x.original_cents + x.approved_change_cents, 0n);
    const chSum = chCur.reduce((s, x) => s + x.delta_cents, 0n);
    const stSum = stCur.reduce((s, x) => s + x.net_payable_cents, 0n);
    const rowSummary: MonthlyStatsCurrencyRow = {
      currency: cur,
      newSignedCount: nsCur.length,
      newSignedWan: centsToWanString(nsSum),
      closedCount: clCur.length,
      closedWan: centsToWanString(clSum),
      changeCount: chCur.length,
      changeDeltaWan: centsToWanString(chSum, true),
      settlementCount: stCur.length,
      settlementNetWan: centsToWanString(stSum),
    };
    monthlyStats.push(rowSummary);
    s1.addRow([
      `小计(${cur})`,
      `${nsCur.length}份`, '', rowSummary.newSignedWan,
      `${clCur.length}份`, '', rowSummary.closedWan,
      `${chCur.length}次`, '', rowSummary.changeDeltaWan, '',
      `${stCur.length}笔`, '', rowSummary.settlementNetWan,
      cur, cur, cur, cur,
    ]);
  }

  const s2 = wb.addWorksheet('02_合同台账总表');
  s2.addRow([]);
  s2.addRow(['合同台账（总表）']);
  s2.mergeCells('A2:U2');
  s2.addRow([
    '序号', '类别', '合同编号', '合同名称', '年度计划项目名称', '初始签订合同金额 (万元)', '支出/收入', '签订日期', '工期',
    '对方单位名称（全称）', '采购方式', '承办部门(简称)', '承办人', '合同变更（详见变更表）', '累计变更金额(万元)',
    '合同结算（详见结算表）', '累计结算金额(万元)', '执行情况', '合同存在的风险', '备注', '币种（金额单位：万本币）',
  ]);
  contracts.forEach((c, idx) => {
    const chList = changesByCid.get(c.id) ?? [];
    const stList = settlementsByCid.get(c.id) ?? [];
    const initAmt = c.pricing_mode === 'unit_price' && c.original_cents === 0n ? (c.unit_price_desc || '/') : centsToWanString(c.original_cents);
    const settledAmt = c.settled_net_cents;
    const settledCnt = stList.length > 0 ? stList.length : (settledAmt > 0n ? 1 : 0);
    const noteParts = [c.remark];
    if (c.status === 'suspended') noteParts.push('已中止');
    if (c.status === 'terminated') noteParts.push('已解除清算');
    s2.addRow([
      idx + 1, CATEGORY_TO_LABEL[c.report_category] ?? c.contract_type, c.contract_no, c.name, c.plan_item_name ?? c.project_name ?? '', initAmt,
      c.direction === 'income' ? '收入' : '支出', c.sign_date ?? '',
      c.term_type === 'fixed' && c.term_start_date && c.term_end_date ? `${c.term_start_date}~${c.term_end_date}` : (c.term_condition_text || ''),
      c.counterparty_names || c.supplier_name || '', c.procurement_method ? (PROCUREMENT_TO_LABEL[c.procurement_method] ?? '') : '',
      c.undertaker_dept || c.org_name, c.undertaker_name, chList.length, centsToWanString(c.approved_change_cents, true),
      settledCnt, centsToWanString(settledAmt), mapMonthlyExecStatus(c.status, c.stage),
      (risksByCid.get(c.id) ?? []).join('；'), noteParts.filter(Boolean).join('；'), c.currency,
    ]);
  });

  const s3 = wb.addWorksheet('03_结算动态分表');
  s3.addRow([]); s3.addRow(['合同台账（结算分表）']); s3.mergeCells('A2:X2');
  s3.addRow(['序号', '合同编号', '合同名称', '初始签订合同金额', '结算金额', '', '', '结算次数', '', '', '月结算金额', '', '', '', '', '', '', '', '', '', '', '', '', '备注']);
  s3.mergeCells('E3:G3'); s3.mergeCells('H3:J3'); s3.mergeCells('K3:W3');
  s3.addRow(['', '', '', '', '累计', '往年', '本年', '累计', '往年', '本年', '1月', '2月', '3月', '4月', '5月', '6月', '7月', '8月', '9月', '10月', '11月', '12月', '本年合计', '', '币种（金额单位：万本币）']);
  contracts.forEach((c, idx) => {
    const list = settlementsByCid.get(c.id) ?? [];
    let priorAmt = 0n; let curAmt = 0n; let priorCnt = 0; let curCnt = 0;
    const months = Array.from({ length: 12 }, () => 0n);
    for (const s of list) {
      const sy = s.settlement_date.slice(0, 4);
      if (sy < year) { priorAmt += s.net_payable_cents; priorCnt++; }
      else if (sy === year) {
        curAmt += s.net_payable_cents; curCnt++;
        const m = Number(s.settlement_date.slice(5, 7));
        if (m >= 1 && m <= 12) months[m - 1] += s.net_payable_cents;
      }
    }
    s3.addRow([
      idx + 1, c.contract_no, c.name,
      c.pricing_mode === 'unit_price' && c.original_cents === 0n ? '/' : centsToWanString(c.original_cents),
      centsToWanString(priorAmt + curAmt), centsToWanString(priorAmt), centsToWanString(curAmt),
      priorCnt + curCnt, priorCnt, curCnt, ...months.map((m) => centsToWanString(m)), centsToWanString(curAmt),
      mapMonthlyExecStatus(c.status, c.stage), c.currency,
    ]);
  });

  const s4 = wb.addWorksheet('04_变更动态分表');
  const maxChanges = Math.max(4, ...contracts.map((c) => (changesByCid.get(c.id) ?? []).length));
  const s4TotalCols = 9 + maxChanges * 3 + 1;
  s4.addRow(['合同台账（变更分表）']);
  s4.mergeCells(1, 1, 1, s4TotalCols);
  const s4Row2: string[] = ['序号', '合同编号', '合同名称', '变更金额(+/-)', '', '', '变更次数', '', ''];
  const s4Row3: string[] = ['序号', '合同编号', '合同名称', '累计', '往年', '本年', '累计', '往年', '本年'];
  for (let i = 0; i < maxChanges; i++) {
    s4Row2.push(`第${i + 1}次`, '', '');
    s4Row3.push('金额', '日期', '原因');
  }
  s4Row2.push('币种（金额单位：万本币）');
  s4Row3.push('币种（金额单位：万本币）');
  s4.addRow(s4Row2);
  s4.addRow(s4Row3);
  s4.mergeCells(2, 1, 3, 1);
  s4.mergeCells(2, 2, 3, 2);
  s4.mergeCells(2, 3, 3, 3);
  s4.mergeCells(2, 4, 2, 6);
  s4.mergeCells(2, 7, 2, 9);
  for (let i = 0; i < maxChanges; i++) {
    const startCol = 10 + i * 3;
    s4.mergeCells(2, startCol, 2, startCol + 2);
  }
  s4.mergeCells(2, s4TotalCols, 3, s4TotalCols);
  let chgSeq = 0;
  for (const c of contracts) {
    const list = changesByCid.get(c.id) ?? [];
    if (!list.length) continue;
    chgSeq++;
    let priorAmt = 0n; let curAmt = 0n; let priorCnt = 0; let curCnt = 0;
    for (const ch of list) {
      const cy = ch.chg_at.slice(0, 4);
      if (cy < year) { priorAmt += ch.delta_cents; priorCnt++; }
      else if (cy === year) { curAmt += ch.delta_cents; curCnt++; }
    }
    const slots: string[] = [];
    for (let i = 0; i < maxChanges; i++) {
      const item = list[i];
      slots.push(item ? centsToWanString(item.delta_cents, true) : '', item ? item.chg_at.slice(0, 10) : '', item ? (item.change_matter || item.reason) : '');
    }
    s4.addRow([
      chgSeq, c.contract_no, c.name,
      centsToWanString(priorAmt + curAmt, true), centsToWanString(priorAmt, true), centsToWanString(curAmt, true),
      priorCnt + curCnt, priorCnt, curCnt, ...slots, c.currency,
    ]);
  }

  const s5 = wb.addWorksheet('05_招标项目清查表');
  s5.addRow(['《招标项目清查表》']); s5.mergeCells('A1:V1');
  s5.addRow([
    '序号', '合同名称', '合同编号', '中标单位', '公示的其他单位及其排名', '代理机构', '招标公告发布日期',
    '资格预审文件出售时间段', '开始出售招标文件日期', '澄清与现场查看日期', '投标截止日期/开标',
    '提交评标报告日期', '收到评标报告日期', '公示中标候选人时间段', '中标通知书发出时间', '合同签订日期',
    '有无质疑、澄清、投诉、举报等情形', '归档资料是否齐备', '资料是否集中归档', '是否存在违规情况', '备注', '币种',
  ]);
  const procIds = [...new Set(contracts.map((c) => c.procurement_record_id).filter((id): id is number => id !== null))];
  const procById = new Map<number, ProcurementRecordRow>();
  if (procIds.length > 0) {
    const inProcIds = `(${procIds.map(() => '?').join(',')})`;
    const procRows = db.prepare(`SELECT * FROM ct_procurement_record WHERE id IN ${inProcIds}`).all(...procIds) as ProcurementRecordRow[];
    for (const pr of procRows) procById.set(Number(pr.id), pr);
  }
  let bidSeq = 0;
  for (const c of contracts) {
    if (c.procurement_method !== 'public_tender' && c.procurement_method !== 'invited_tender') continue;
    bidSeq++;
    const pr = c.procurement_record_id !== null ? procById.get(c.procurement_record_id) : undefined;
    const prequalPeriod = pr?.prequal_sale_start
      ? (pr.prequal_sale_end ? `${pr.prequal_sale_start}~${pr.prequal_sale_end}` : pr.prequal_sale_start)
      : '';
    const pubPeriod = pr?.candidate_publicity_start
      ? (pr.candidate_publicity_end ? `${pr.candidate_publicity_start}~${pr.candidate_publicity_end}` : pr.candidate_publicity_start)
      : '';
    const protestCol = !pr
      ? '待补录'
      : Number(pr.protest_flag) === 1
        ? (pr.protest_detail?.trim() ? `有：${pr.protest_detail.trim()}` : '有')
        : '无';
    s5.addRow([
      bidSeq, c.name, c.contract_no, c.counterparty_names || c.supplier_name || '',
      pr ? formatCandidateRanking(pr.candidate_ranking_json) : '',
      pr?.tender_agency ?? '',
      pr?.announcement_date ?? c.procurement_start_date ?? '',
      prequalPeriod,
      pr?.doc_sale_start_date ?? '',
      pr?.clarification_site_date ?? '',
      pr?.bid_open_date ?? '',
      pr?.eval_report_submit_date ?? '',
      pr?.eval_report_receive_date ?? '',
      pubPeriod,
      pr?.award_notice_date ?? c.supplier_confirm_date ?? '',
      c.sign_date ?? '',
      protestCol,
      c.archive_status === 'checked' || c.archive_status === 'transferred' ? '是' : '否',
      c.archive_status === 'transferred' ? '是' : '否', (risksByCid.get(c.id)?.length ?? 0) > 0 ? '待核查' : '否', c.remark, c.currency,
    ]);
  }

  return { wb, contracts, period, monthlyStats };
}

export async function exportMonthlyLedgerXlsx(db: DB, opts: { period?: string; orgId?: number } = {}): Promise<{ fileName: string; contentType: string; content: Buffer }> {
  const { wb, contracts, period } = buildMonthlyLedger(db, opts);
  const buf = Buffer.from(await wb.xlsx.writeBuffer());
  const fileName = `合同月报5表_${period}.xlsx`;
  recordExportLog(db, { exportKind: 'monthly_ledger', orgId: opts.orgId, period, scopeMode: 'all', contractCount: contracts.length, fileName, buf });
  if (opts.orgId) {
    recordMonthlyReportExported(db, opts.orgId, period);
  } else {
    const orgIds = new Set(contracts.map((c) => c.org_id));
    for (const oid of orgIds) recordMonthlyReportExported(db, oid, period);
  }
  return { fileName, contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', content: buf };
}

/** 变更、担保、纠纷规则均以主合同为 subject；项目拆分风险归集至同组织的关联主合同。 */
export function contractRiskRows(db: DB, contracts: ExportContractRow[]) {
  if (!contracts.length) return [];
  const scope = scopeFilterSql(currentOrgScope(db), 'r.org_id');
  const risks = db.prepare(`SELECT r.id, r.subject_type, r.subject_id, r.project_id, r.org_id, r.title, r.status, r.created_at FROM risk_event r WHERE r.source = 'contract' AND ${scope.sql}`).all(...scope.params) as { id: number; subject_type: string; subject_id: number; project_id: number | null; org_id: number | null; title: string; status: string; created_at: string }[];
  return contracts.flatMap(c => risks.filter(r => r.subject_type === 'contract' ? r.subject_id === c.id : r.subject_type === 'project' && r.subject_id === c.project_id && r.org_id === c.org_id).map(r => ({ ...r, contractId: c.id })));
}

export function getSupervisionPortal(
  db: DB,
  opts: { mode: 'full' | 'incremental'; since?: string; cursorId?: number; orgId?: number },
): SupervisionPortalResponseDto {
  const scope = currentOrgScope(db);
  const candidates = queryScopedContracts(db, scope, { orgId: opts.orgId, includeVoided: opts.mode === 'incremental' });
  const allContracts = candidates.filter(c => c.status !== 'voided');
  const filtered = opts.mode === 'incremental' && opts.since
    ? candidates.filter((c) => c.updated_at > opts.since! || (c.updated_at === opts.since && opts.cursorId != null && c.id > opts.cursorId))
    : allContracts;
  const sorted = [...filtered].sort((a, b) => (a.updated_at === b.updated_at ? a.id - b.id : (a.updated_at < b.updated_at ? -1 : 1)));

  const sc = scopeFilterSql(scope, 'org_id');
  const riskWhere = opts.orgId !== undefined
    ? `${sc.sql} AND org_id IN (WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT o.id FROM org o JOIN sub ON o.parent_id = sub.id) SELECT id FROM sub)`
    : sc.sql;
  const riskParams = opts.orgId !== undefined ? [...sc.params, opts.orgId] : sc.params;
  const riskCounts = db.prepare(`SELECT COUNT(*) AS total, SUM(CASE WHEN status IN ('closed','false_positive') THEN 1 ELSE 0 END) AS closed_cnt
    FROM risk_event WHERE source = 'contract' AND ${riskWhere}`).get(...riskParams) as { total: number; closed_cnt: number | null };

  const openByContract = new Map<number, number>();
  for (const risk of contractRiskRows(db, allContracts)) if (!['closed','false_positive'].includes(risk.status)) openByContract.set(risk.contractId, (openByContract.get(risk.contractId) ?? 0) + 1);

  let expenseCount = 0; let incomeCount = 0;
  let totalSigned = 0n; let totalSettled = 0n; let totalPaid = 0n; let totalReceived = 0n; let totalChange = 0n;
  let totalSignedKnownFxRmb = 0n; let missingFxContractCount = 0;
  const byCurMap = new Map<string, { count: number; signed: bigint; settled: bigint; paid: bigint; received: bigint }>();
  let conCount = 0; let conAmt = 0n; let conSettled = 0n; let conPaid = 0n;
  let tier1Count = 0; let tier2Count = 0; let tier3Count = 0; let directCount = 0; let inquiryCount = 0; let procTotal = 0;

  for (const c of allContracts) {
    if (c.direction === 'income') incomeCount++; else expenseCount++;
    const current = c.original_cents + c.approved_change_cents;
    const tierAmt = c.pricing_mode === 'unit_price' && c.original_cents === 0n && c.estimated_ceiling_cents != null ? c.estimated_ceiling_cents : current;
    const tier = procurementTier(!!c.is_procurement, c.procurement_target, tierAmt, c.procurement_method);
    if (c.is_procurement) {
      procTotal++;
      if (tier === 'tier_1') tier1Count++;
      else if (tier === 'tier_2') tier2Count++;
      else if (tier === 'tier_3') tier3Count++;
      if (c.procurement_method === 'direct' || c.procurement_method === 'direct_reimburse') directCount++;
      if (c.procurement_method === 'inquiry') inquiryCount++;
    }
    const curBucket = byCurMap.get(c.currency) ?? { count: 0, signed: 0n, settled: 0n, paid: 0n, received: 0n };
    curBucket.count++;
    curBucket.signed += current;
    curBucket.settled += c.settled_net_cents;
    curBucket.paid += c.paid_cents;
    curBucket.received += c.received_cents;
    byCurMap.set(c.currency, curBucket);
    if (c.currency === '人民币') {
      totalSigned += current; totalSettled += c.settled_net_cents; totalPaid += c.paid_cents; totalReceived += c.received_cents; totalChange += c.approved_change_cents;
      totalSignedKnownFxRmb += current;
      if (c.report_category === 'engineering') { conCount++; conAmt += current; conSettled += c.settled_net_cents; conPaid += c.paid_cents; }
    } else {
      const rmbEq = tryRmbCents(c, current);
      if (rmbEq !== null) totalSignedKnownFxRmb += rmbEq;
      else missingFxContractCount++;
    }
  }

  const items: SupervisionPortalItemDto[] = sorted.map((c) => {
    const current = c.original_cents + c.approved_change_cents;
    const tierAmt = c.pricing_mode === 'unit_price' && c.original_cents === 0n && c.estimated_ceiling_cents != null ? c.estimated_ceiling_cents : current;
    return {
      id: c.id, status: c.status, deleted: c.status === 'voided', contractNo: c.contract_no, name: c.name, direction: c.direction, reportCategory: c.report_category,
      orgId: c.org_id, orgName: c.org_name, orgFullName: c.org_report_full_name,
      counterpartyNames: c.counterparty_names || c.supplier_name || '', pricingMode: c.pricing_mode, currency: c.currency,
      originalAmount: centsToDecimalString(c.original_cents), approvedChangeAmount: centsToDecimalString(c.approved_change_cents),
      currentAmount: centsToDecimalString(current), settledNetAmount: centsToDecimalString(c.settled_net_cents),
      paidAmount: centsToDecimalString(c.paid_cents), receivedAmount: centsToDecimalString(c.received_cents),
      procurementTier: procurementTier(!!c.is_procurement, c.procurement_target, tierAmt, c.procurement_method),
      procurementMethod: c.procurement_method, supervisionExecStatus: mapSupervisionExecStatus(c.status, c.stage, c.sign_date),
      signDate: c.sign_date, ourSignatoryName: c.our_signatory_name, ourSignatoryTitle: c.our_signatory_title,
      ourSignatoryIsLegalRep: c.our_signatory_is_legal_rep === null ? null : !!c.our_signatory_is_legal_rep,
      counterpartySignatoryIsLegalRep: c.counterparty_signatory_is_legal_rep === null ? null : !!c.counterparty_signatory_is_legal_rep,
      openRiskCount: openByContract.get(c.id) ?? 0, version: c.version, updatedAt: c.updated_at,
    };
  });

  const last = sorted[sorted.length - 1];
  return {
    generatedAt: nowIso(), mode: opts.mode, since: opts.since ?? null,
    nextSince: last?.updated_at ?? (opts.since ?? null), nextCursorId: last?.id ?? (opts.cursorId ?? null),
    summary: {
      totalContracts: allContracts.length, expenseCount, incomeCount,
      totalSignedAmount: centsToDecimalString(totalSigned), totalSettledAmount: centsToDecimalString(totalSettled),
      totalPaidAmount: centsToDecimalString(totalPaid), totalReceivedAmount: centsToDecimalString(totalReceived),
      totalApprovedChangeAmount: centsToDecimalString(totalChange),
      constructionSummary: { count: conCount, contractAmount: centsToDecimalString(conAmt), settledAmount: centsToDecimalString(conSettled), paidAmount: centsToDecimalString(conPaid) },
      procurementDistribution: {
        tier1Count, tier2Count, tier3Count, directCount,
        directRatio: procTotal > 0 ? ratioString(BigInt(directCount), BigInt(procTotal)) : null,
        inquiryCount, inquiryRatio: procTotal > 0 ? ratioString(BigInt(inquiryCount), BigInt(procTotal)) : null,
      },
      riskStats: { totalAlerts: riskCounts.total ?? 0, rectifiedClosedAlerts: riskCounts.closed_cnt ?? 0 },
      byCurrency: [...byCurMap.entries()].map(([currency, b]) => ({
        currency,
        contractCount: b.count,
        signedAmount: centsToDecimalString(b.signed),
        settledAmount: centsToDecimalString(b.settled),
        paidAmount: centsToDecimalString(b.paid),
        receivedAmount: centsToDecimalString(b.received),
      })),
      totalSignedWithKnownFxRmb: centsToDecimalString(totalSignedKnownFxRmb),
      missingFxContractCount,
    },
    items,
  };
}
