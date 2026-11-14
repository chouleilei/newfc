import { reportPeriod } from './contract-controls';
import { officialSheet, writeOfficialWorkbook } from './supervision-official-workbook';
/**
 * 上级《纪巡财审》报送完整性预检、6 表官方 Excel + 4 类附件目录树 ZIP 打包导出服务（T-12.3）。
 */
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import type { DB } from '../../db/connection';
import { AppError } from '../../core/errors';
import { centsToDecimalString } from '../../core/decimal';
import type { ObjectStore } from '../files/object-store';
import { currentOrgScope, type OrgScope } from '../security/scope';
import type {
  ChangeKind, ContractDecisionMethod, ContractMeetingType,
  SupervisionPreflightDto, SupervisionPreflightItemDto,
} from '../../contracts/project-contract';
import {
  ACQUISITION_TO_LABEL, CATEGORY_TO_LABEL, CHANGE_KIND_TO_SUPERVISION, DECISION_TO_LABEL,
  EXPENSE_BASE_HEADERS, EXPENSE_BASE_NOTES, EXPENSE_CHANGE_HEADERS, EXPENSE_EXEC_HEADERS, EXPENSE_EXEC_PAY_HEADERS,
  FUNDING_TO_LABEL, INCOME_BASE_HEADERS, INCOME_CHANGE_HEADERS, INCOME_EXEC_HEADERS, INCOME_EXEC_RECEIVE_HEADERS,
  MEETING_TO_LABEL, PRICING_TO_LABEL, PROCUREMENT_TO_LABEL, SUPERVISION_ATTACHMENT_SLOTS, SUPERVISION_CURRENCIES,
  TENDER_BODY_TO_LABEL, TERM_TYPE_TO_LABEL, escapeSupplementFolderName, sanitizeFolderSegment,
} from './supervision-template-spec';
import {
  centsToWanString, exportMonthlyLedgerXlsx, getSupervisionPortal, listSupervisionExportLogs,
  mapSupervisionExecStatus, queryScopedContracts, recordExportLog, type ExportContractRow,
} from './contract-export-monthly';

export { centsToWanString, exportMonthlyLedgerXlsx, getSupervisionPortal, listSupervisionExportLogs };

const todayPeriod = () => new Date().toISOString().slice(0, 7);
export const MAX_SUPERVISION_ZIP_BYTES = 200 * 1024 * 1024;

function filterSupervisionContracts(db: DB, scope: OrgScope, opts: { period?: string; orgId?: number; scopeMode?: 'changed' | 'all_active' }): {
  period: string; scopeMode: 'changed' | 'all_active'; contracts: ExportContractRow[];
} {
  const period = reportPeriod(opts.period);
  const year = period.slice(0, 4);
  const scopeMode = opts.scopeMode ?? 'all_active';
  const all = queryScopedContracts(db, scope, { orgId: opts.orgId });
  const contracts = all.filter((c) => {
    if (!c.sign_date || ['initiation','procurement','drafting','approval'].includes(c.stage)) return false;
    if (scopeMode === 'all_active') {
      return c.status !== 'closed' || (c.sign_date?.startsWith(year) ?? false) || (c.completed_date?.startsWith(year) ?? false);
    }
    if ((c.sign_date?.startsWith(period) ?? false) || c.updated_at.startsWith(period)) return true;
    if (db.prepare("SELECT 1 FROM ct_payment WHERE contract_id = ? AND status = 'paid' AND substr(paid_date, 1, 7) = ? LIMIT 1").get(c.id, period)) return true;
    if (db.prepare("SELECT 1 FROM ct_receipt WHERE contract_id = ? AND status = 'received' AND substr(received_date, 1, 7) = ? LIMIT 1").get(c.id, period)) return true;
    return !!db.prepare("SELECT 1 FROM ct_change WHERE contract_id = ? AND status = 'approved' AND substr(COALESCE(reviewed_at, submitted_at), 1, 7) = ? LIMIT 1").get(c.id, period);
  });
  return { period, scopeMode, contracts };
}

export function preflightSupervisionExport(db: DB, opts: { period?: string; orgId?: number; scopeMode?: 'changed' | 'all_active' } = {}): SupervisionPreflightDto {
  const scope = currentOrgScope(db);
  const { period, scopeMode, contracts } = filterSupervisionContracts(db, scope, opts);
  const items: SupervisionPreflightItemDto[] = [];

  for (const c of contracts) {
    const missingFields: string[] = [];
    const missingAttachments: string[] = [];
    const warnings: string[] = [];

    if (!c.sign_date) missingFields.push('合同签署日期');
    if (!c.counterparty_names && !c.supplier_name) missingFields.push(c.direction === 'expense' ? '合同收款方' : '合同付款方');
    if (!c.summary_text.trim()) missingFields.push('合同主要内容');
    if (!c.undertaker_name.trim()) warnings.push('未登记承办人姓名');
    if (c.pricing_mode === 'lump_sum' && c.original_cents <= 0n) missingFields.push('合同总价');
    if (c.pricing_mode === 'unit_price' && !c.unit_price_desc.trim()) missingFields.push('合同单价说明');
    if (!c.decision_method) missingFields.push('三重一大决策方式');
    if (!c.final_approver_name.trim()) missingFields.push('最终审批人姓名');
    if (!c.final_approver_title.trim()) missingFields.push('最终审批人身份');
    if (c.summary_text.length > 1000) missingFields.push('主要内容超过1000字');
    if (c.remark.length > 500) missingFields.push('备注超过500字');
    if (c.decision_method === 'other' && !c.decision_method_other.trim()) missingFields.push('其他决策方式');
    if (c.meeting_type === 'other' && !c.meeting_type_other.trim()) missingFields.push('其他会议形式');
    if (c.term_type !== 'unspecified' && !c.term_start_date) missingFields.push('履约开始日期');
    if (!c.undertaker_name.trim()) missingFields.push('承办人姓名');
    if (c.decision_method === 'meeting' && !c.meeting_type) missingFields.push('会议形式');
    if (c.term_type === 'fixed' && (!c.term_start_date || !c.term_end_date)) missingFields.push('固定履约起止日期');
    if (c.term_type === 'conditional' && !c.term_condition_text.trim()) missingFields.push('条件期限说明');
    if (!c.our_signatory_name.trim() || !c.our_signatory_title.trim()) missingFields.push('本方签署人姓名及身份');
    if (c.our_signatory_is_legal_rep === null) missingFields.push('本方签署人是否法定代表人');

    if (c.direction === 'expense') {
      if (c.funding_source === 'self_owned_other' && !c.funding_source_detail.trim()) missingFields.push('其他资金来源说明');
      if (c.procurement_method === null || !(c.procurement_method in PROCUREMENT_TO_LABEL) && !c.procurement_method_other.trim()) missingFields.push('采购方式/其他采购方式说明');
      if (c.response_docs_complete === null) missingFields.push('响应文件是否完整');
      if (c.credit_checked === null) missingFields.push('是否展开资信调查');
      if (!c.related_mgmt_depts.trim() || !c.related_mgmt_reviewers.trim() || !c.unit_approver_title.trim()) missingFields.push('相关管理部门及审核人/单位审批人身份');
      if (c.report_category === 'other' && !c.contract_type.trim()) missingFields.push('其他合同类型');
      if (c.procurement_start_date && c.supplier_confirm_date && (c.procurement_start_date > c.supplier_confirm_date || c.supplier_confirm_date > c.sign_date!)) missingFields.push('采购时间链倒置');
      if (!c.entrust_reason.trim()) missingFields.push('委托理由');
      if (c.funding_source === 'income_contract' && !c.source_income_no) missingFields.push('关联收入合同编号');
      if (!c.procurement_plan_text.trim()) missingFields.push('采购计划');
      if (!c.procurement_start_date || !c.supplier_confirm_date) missingFields.push('采购起止时间(开始采购/确定供应商)');
      if (!c.dept_reviewer_name.trim() || !c.unit_approver_name.trim()) missingFields.push('审核/审批链人员(部门审核人/单位审批人)');
      if (c.counterparty_signatory_is_legal_rep === null) missingFields.push('收款方签署人是否法定代表人');
      const missingPayApprover = db.prepare("SELECT COUNT(*) AS n FROM ct_payment WHERE contract_id = ? AND status = 'paid' AND (trim(approver_name) = '' OR trim(approver_title) = '')").get(c.id) as { n: number };
      if (missingPayApprover.n > 0) missingFields.push(`有 ${missingPayApprover.n} 笔实付记录缺最高审批人姓名/身份`);
    } else {
      if (c.acquisition_method === 'other' && !c.acquisition_method_other.trim()) missingFields.push('其他取得方式说明');
      if (c.tender_body_type === 'consortium' && !c.consortium_members.trim()) missingFields.push('联合体成员');
      if (!c.acquisition_method) missingFields.push('合同取得方式');
      if (c.acquisition_method === 'tender' && !c.tender_body_type) missingFields.push('投标主体类型');
    }

    const docs = db.prepare('SELECT doc_type, evidence_kind, change_id FROM ct_document WHERE contract_id = ?').all(c.id) as {
      doc_type: string; evidence_kind: string | null; change_id: number | null;
    }[];
    const hasSlot = (kinds: readonly string[], types: readonly string[]) =>
      docs.some((d) => (d.evidence_kind && kinds.includes(d.evidence_kind)) || types.includes(d.doc_type));

    if (c.direction === 'expense') {
      if (!hasSlot(SUPERVISION_ATTACHMENT_SLOTS.expenseContract[0].evidenceKinds, [])) missingAttachments.push('01决策附件');
      if (!hasSlot(SUPERVISION_ATTACHMENT_SLOTS.expenseContract[1].evidenceKinds, SUPERVISION_ATTACHMENT_SLOTS.expenseContract[1].docTypes)) missingAttachments.push('02供应商资格审查');
      if (!hasSlot([], ['signed'])) missingAttachments.push('03合同文本');
      if (c.our_signatory_is_legal_rep === 0 && !hasSlot(['our_signatory_auth'], [])) missingAttachments.push('04付款方合同签署人授权附件');
      if (c.counterparty_signatory_is_legal_rep === 0 && !hasSlot(['counterparty_signatory_auth'], [])) missingAttachments.push('05收款方合同签署人授权附件');
    } else {
      if (!hasSlot(SUPERVISION_ATTACHMENT_SLOTS.incomeContract[0].evidenceKinds, [])) missingAttachments.push('01决策附件');
      if (!hasSlot([], ['signed'])) missingAttachments.push('02合同文本');
      if (c.our_signatory_is_legal_rep === 0 && !hasSlot(['our_signatory_auth'], [])) missingAttachments.push('03收款方合同签署人授权附件');
    }

    const chgs = db.prepare("SELECT id, supplement_no, change_matter, final_approver_name, decision_method, meeting_type FROM ct_change WHERE contract_id = ? AND status = 'approved'").all(c.id) as {
      id: number; supplement_no: string | null; change_matter: string; final_approver_name: string; decision_method: string | null; meeting_type: string | null;
    }[];
    for (const ch of chgs) {
      if (!ch.supplement_no) missingFields.push(`变更 #${ch.id} 缺唯一补充协议编号`);
      if (!ch.change_matter.trim()) missingFields.push(`变更 #${ch.id} 缺变更主要事项`);
      if (!ch.final_approver_name.trim()) missingFields.push(`变更 #${ch.id} 缺最终审批人姓名`);
      if (!ch.decision_method || ch.decision_method === 'meeting' && !ch.meeting_type) missingFields.push(`变更 #${ch.id} 缺决策方式/会议形式`);
      const slots = c.direction === 'expense' ? SUPERVISION_ATTACHMENT_SLOTS.expenseChange : SUPERVISION_ATTACHMENT_SLOTS.incomeChange;
      for (const slot of slots) if (!docs.some(d => d.change_id === ch.id && ((d.evidence_kind && (slot.evidenceKinds as readonly string[]).includes(d.evidence_kind)) || (slot.docTypes as readonly string[]).includes(d.doc_type)))) missingAttachments.push(`变更 #${ch.id} ${slot.dir}`);
    }

    const ready = missingFields.length === 0 && missingAttachments.length === 0;
    items.push({ contractId: c.id, contractNo: c.contract_no, name: c.name, direction: c.direction, missingFields, missingAttachments, warnings, ready });
  }

  const readyCount = items.filter((i) => i.ready).length;
  return { scopeMode, period, totalCount: items.length, readyCount, incompleteCount: items.length - readyCount, items };
}

function addDataValidationCol(ws: ExcelJS.Worksheet, colLetter: string, startRow: number, endRow: number, list: readonly string[]): void {
  const sqref = `${colLetter}${startRow}:${colLetter}${Math.max(endRow, 500)}`;
  const dv = (ws as unknown as { dataValidations?: { add: (ref: string, rule: ExcelJS.DataValidation) => void } }).dataValidations;
  dv?.add(sqref, { type: 'list', allowBlank: true, formulae: [`"${list.join(',')}"`] });
}

function setupSupervisionSheet1(
  wb: ExcelJS.Workbook,
  sheetName: string,
  title: string,
  groups: { range: string; label: string }[],
  headers: readonly string[],
  notes: readonly string[],
): ExcelJS.Worksheet {
  return officialSheet(wb, sheetName);
}

export async function exportSupervisionPackageZip(
  db: DB,
  store: ObjectStore,
  opts: { period?: string; orgId?: number; scopeMode?: 'changed' | 'all_active'; maxZipBytes?: number } = {},
): Promise<{ fileName: string; contentType: string; content: Buffer; preflight: SupervisionPreflightDto }> {
  const scope = currentOrgScope(db);
  const { period, scopeMode, contracts } = filterSupervisionContracts(db, scope, opts);
  const preflight = preflightSupervisionExport(db, { period, orgId: opts.orgId, scopeMode });
  if (preflight.incompleteCount) throw new AppError('SUPERVISION_PREFLIGHT_FAILED', '报送资料不完整，请按预检清单补齐后导出', 409, undefined, preflight);
  const maxBytes = opts.maxZipBytes ?? MAX_SUPERVISION_ZIP_BYTES;

  const expenses = contracts.filter((c) => c.direction === 'expense');
  const incomes = contracts.filter((c) => c.direction === 'income');
  const yesNo = (v: number | null | boolean) => (v === null ? '' : (v ? '是' : '否'));

  const wbExpBase = new ExcelJS.Workbook();
  const wsExpBase = setupSupervisionSheet1(
    wbExpBase, '支出合同基本信息', '支出合同管理',
    [{ range: 'A3:N3', label: '合同基本信息' }, { range: 'O3:V3', label: '合同决策或审批' }, { range: 'W3:AD3', label: '采购环节' }, { range: 'AE3:AT3', label: '合同审签与订立' }],
    EXPENSE_BASE_HEADERS, EXPENSE_BASE_NOTES,
  );
  for (const c of expenses) {
    wsExpBase.addRow([
      c.contract_no, c.name, PRICING_TO_LABEL[c.pricing_mode], c.currency,
      c.pricing_mode === 'lump_sum' ? centsToDecimalString(c.original_cents) : '',
      c.pricing_mode === 'unit_price' ? c.unit_price_desc : '',
      c.org_report_full_name, c.counterparty_names || c.supplier_name || '', c.summary_text,
      FUNDING_TO_LABEL[c.funding_source], c.funding_source === 'self_owned_other' ? c.funding_source_detail : '',
      c.funding_source === 'income_contract' ? (c.source_income_no ?? '') : '',
      c.funding_source === 'income_contract' ? (c.source_income_name ?? '') : '',
      c.remark, c.entrust_reason, yesNo(c.is_triple_major),
      c.decision_method ? DECISION_TO_LABEL[c.decision_method] : '', c.meeting_type ? MEETING_TO_LABEL[c.meeting_type] : '',
      c.decision_method_other, c.meeting_type_other, c.final_approver_name, c.final_approver_title,
      yesNo(c.is_gov_procurement), c.procurement_method ? PROCUREMENT_TO_LABEL[c.procurement_method] : '其他方式',
      c.procurement_method_other, c.procurement_plan_text, c.procurement_start_date ?? '', c.supplier_confirm_date ?? '',
      yesNo(c.response_docs_complete), yesNo(c.credit_checked), c.undertaker_name, c.dept_reviewer_name,
      c.related_mgmt_depts, c.related_mgmt_reviewers, c.unit_approver_name, c.unit_approver_title,
      CATEGORY_TO_LABEL[c.report_category], c.report_category === 'other' ? c.contract_type : '',
      c.sign_date ?? '', TERM_TYPE_TO_LABEL[c.term_type], c.term_start_date ?? '',
      c.term_type === 'fixed' ? (c.term_end_date ?? '') : (c.term_type === 'conditional' ? c.term_condition_text : ''),
      c.our_signatory_name, c.our_signatory_title, yesNo(c.our_signatory_is_legal_rep), yesNo(c.counterparty_signatory_is_legal_rep),
    ]);
  }
  addDataValidationCol(wsExpBase, 'C', 6, 6 + expenses.length, ['总价', '单价']);
  addDataValidationCol(wsExpBase, 'D', 6, 6 + expenses.length, SUPERVISION_CURRENCIES);
  addDataValidationCol(wsExpBase, 'J', 6, 6 + expenses.length, ['财政拨款', '收入合同', '其他']);
  addDataValidationCol(wsExpBase, 'AN', 6, 6 + expenses.length, ['固定期限', '条件期限', '未约定']);

  const wbExpExec = new ExcelJS.Workbook();
  const wsExpExec = setupSupervisionSheet1(
    wbExpExec, '支出合同执行信息', '支出合同执行信息',
    [{ range: 'A3:B3', label: '合同基本信息' }, { range: 'C3:E3', label: '合同履行' }],
    EXPENSE_EXEC_HEADERS, ['（1）必填', '（1）必填', '（1）执行中/未完成已中止/未完成已终止/已完成', '（1）是/否', '（1）是/否'],
  );
  const wsExpPay = officialSheet(wbExpExec, '实际支付时间与金额');
  for (const c of expenses) {
    const st = mapSupervisionExecStatus(c.status, c.stage, c.sign_date);
    wsExpExec.addRow([c.contract_no, c.name, st, c.deliverable_submitted == null ? '' : (c.deliverable_submitted ? '是' : '否'), c.final_accepted ? '是' : '否']);
    const pays = db.prepare("SELECT paid_date, currency, amount_cents, approver_name, approver_title FROM ct_payment WHERE contract_id = ? AND status = 'paid' ORDER BY paid_date ASC, id ASC")
      .safeIntegers(true).all(c.id) as { paid_date: string; currency: string; amount_cents: bigint; approver_name: string; approver_title: string }[];
    for (const p of pays) {
      wsExpPay.addRow([c.contract_no, c.name, p.paid_date, p.currency || c.currency || '人民币', centsToDecimalString(p.amount_cents), p.approver_name || '', p.approver_title || '']);
    }
  }

  const wbExpChg = new ExcelJS.Workbook();
  const wsExpChg = setupSupervisionSheet1(
    wbExpChg, '支出合同变更', '支出合同变更管理',
    [{ range: 'A3:J3', label: '合同变更（含中止和解除）/纠纷' }],
    EXPENSE_CHANGE_HEADERS, ['（1）原合同编号', '（1）原合同名称', '（1）变更/中止/解除', '（1）变更主要事项(<=500字)', '（1）变更原因(<=500字)', '（1）会议/审批/其他', '（1）会议形式', '（1）最终审批人姓名', '（1）唯一补充协议编号', '（1）是/否'],
  );
  for (const c of expenses) {
    const chgs = db.prepare("SELECT * FROM ct_change WHERE contract_id = ? AND status = 'approved' ORDER BY id ASC").safeIntegers(true).all(c.id) as Record<string, unknown>[];
    for (const ch of chgs) {
      wsExpChg.addRow([
        c.contract_no, c.name, CHANGE_KIND_TO_SUPERVISION[ch.change_kind as ChangeKind] ?? '变更',
        String(ch.change_matter || ch.reason || ''), String(ch.reason || ''),
        ch.decision_method ? DECISION_TO_LABEL[ch.decision_method as ContractDecisionMethod] : '',
        ch.meeting_type ? MEETING_TO_LABEL[ch.meeting_type as ContractMeetingType] : '',
        String(ch.final_approver_name || ''), String(ch.supplement_no || ''), Number(ch.has_dispute) ? '是' : '否',
      ]);
    }
  }

  const wbIncBase = new ExcelJS.Workbook();
  const wsIncBase = setupSupervisionSheet1(
    wbIncBase, '收入合同基本信息', '收入合同管理',
    [{ range: 'A3:J3', label: '合同基本信息' }, { range: 'K3:V3', label: '合同决策或审批' }, { range: 'W3:AC3', label: '合同审签与订立' }],
    INCOME_BASE_HEADERS, INCOME_BASE_HEADERS.map(() => '按官方模板规范填写'),
  );
  for (const c of incomes) {
    wsIncBase.addRow([
      c.contract_no, c.name, PRICING_TO_LABEL[c.pricing_mode], c.currency,
      c.pricing_mode === 'lump_sum' ? centsToDecimalString(c.original_cents) : '',
      c.pricing_mode === 'unit_price' ? c.unit_price_desc : '',
      c.counterparty_names || c.supplier_name || '', c.org_report_full_name, c.summary_text, c.remark,
      yesNo(c.credit_checked), yesNo(c.is_triple_major),
      c.decision_method ? DECISION_TO_LABEL[c.decision_method] : '', c.meeting_type ? MEETING_TO_LABEL[c.meeting_type] : '',
      c.decision_method_other, c.meeting_type_other, c.final_approver_name, c.final_approver_title,
      c.acquisition_method ? ACQUISITION_TO_LABEL[c.acquisition_method] : '', c.acquisition_method_other,
      c.tender_body_type ? TENDER_BODY_TO_LABEL[c.tender_body_type] : '', c.consortium_members,
      c.sign_date ?? '', TERM_TYPE_TO_LABEL[c.term_type], c.term_start_date ?? '',
      c.term_type === 'fixed' ? (c.term_end_date ?? '') : (c.term_type === 'conditional' ? c.term_condition_text : ''),
      c.our_signatory_name, c.our_signatory_title, yesNo(c.our_signatory_is_legal_rep),
    ]);
  }

  const wbIncExec = new ExcelJS.Workbook();
  const wsIncExec = setupSupervisionSheet1(
    wbIncExec, '收入合同执行信息', '收入合同执行信息',
    [{ range: 'A3:B3', label: '合同基本信息' }, { range: 'C3:D3', label: '合同履行' }],
    INCOME_EXEC_HEADERS, ['（1）必填', '（1）必填', '（1）执行中/未完成已中止/未完成已终止/已完成', '（1）是/否'],
  );
  const wsIncRec = officialSheet(wbIncExec, '实际收款时间与金额');
  for (const c of incomes) {
    const st = mapSupervisionExecStatus(c.status, c.stage, c.sign_date);
    wsIncExec.addRow([c.contract_no, c.name, st, c.final_accepted ? '是' : '否']);
    const recs = db.prepare("SELECT received_date, currency, amount_cents FROM ct_receipt WHERE contract_id = ? AND status = 'received' ORDER BY received_date ASC, id ASC")
      .safeIntegers(true).all(c.id) as { received_date: string; currency: string; amount_cents: bigint }[];
    for (const rec of recs) {
      wsIncRec.addRow([c.contract_no, c.name, rec.received_date, rec.currency || c.currency || '人民币', centsToDecimalString(rec.amount_cents)]);
    }
  }

  const wbIncChg = new ExcelJS.Workbook();
  const wsIncChg = setupSupervisionSheet1(
    wbIncChg, '收入合同变更', '收入合同变更管理',
    [{ range: 'A3:H3', label: '合同变更（含中止和解除）/纠纷' }],
    INCOME_CHANGE_HEADERS, ['（1）原合同编号', '（1）原合同名称', '（1）变更/中止/解除', '（1）变更主要事项', '（1）变更原因', '（1）最终审批人姓名', '（1）唯一补充协议编号', '（1）是/否'],
  );
  for (const c of incomes) {
    const chgs = db.prepare("SELECT * FROM ct_change WHERE contract_id = ? AND status = 'approved' ORDER BY id ASC").safeIntegers(true).all(c.id) as Record<string, unknown>[];
    for (const ch of chgs) {
      wsIncChg.addRow([
        c.contract_no, c.name, CHANGE_KIND_TO_SUPERVISION[ch.change_kind as ChangeKind] ?? '变更',
        String(ch.change_matter || ch.reason || ''), String(ch.reason || ''),
        String(ch.final_approver_name || ''), String(ch.supplement_no || ''), Number(ch.has_dispute) ? '是' : '否',
      ]);
    }
  }

  const zip = new JSZip();
  let totalBytes = 0;
  const addEntry = (entryPath: string, data: Buffer | string) => {
    const size = typeof data === 'string' ? Buffer.byteLength(data) : data.length;
    totalBytes += size;
    if (totalBytes > maxBytes) {
      throw new AppError('EXPORT_SIZE_EXCEEDED', `报送包未压缩总大小超过 ${Math.round(maxBytes / 1024 / 1024)} MiB 上限，请按组织或期间分批导出`, 413);
    }
    zip.file(entryPath, data);
  };

  const workbooks: [string, ExcelJS.Workbook][] = [
    ['支出合同基本信息.xlsx', wbExpBase],
    ['支出合同执行信息.xlsx', wbExpExec],
    ['支出合同变更与纠纷基本信息.xlsx', wbExpChg],
    ['收入合同基本信息.xlsx', wbIncBase],
    ['收入合同执行信息.xlsx', wbIncExec],
    ['收入合同变更与纠纷基本信息.xlsx', wbIncChg],
  ];
  for (const [name, wb] of workbooks) {
    addEntry(name, await writeOfficialWorkbook(wb));
  }

  const folderEscapes: { supplementNo: string; folderName: string }[] = [];
  for (const c of contracts) {
    const cFolder = sanitizeFolderSegment(c.contract_no);
    const docs = db.prepare(`SELECT d.id, d.doc_type, d.evidence_kind, d.change_id, d.name, f.sha256, f.original_name, f.size_bytes
      FROM ct_document d JOIN file_object f ON f.id = d.file_object_id WHERE d.contract_id = ? ORDER BY d.id ASC`)
      .all(c.id) as { id: number; doc_type: string; evidence_kind: string | null; change_id: number | null; name: string; sha256: string; original_name: string; size_bytes: number }[];

    const rootDir = c.direction === 'expense' ? '支出合同附件' : '收入合同附件';
    const slots = c.direction === 'expense' ? SUPERVISION_ATTACHMENT_SLOTS.expenseContract : SUPERVISION_ATTACHMENT_SLOTS.incomeContract;
    const chgs = db.prepare("SELECT id, supplement_no FROM ct_change WHERE contract_id = ? AND status = 'approved' AND supplement_no IS NOT NULL").all(c.id) as { id: number; supplement_no: string }[];
    const chgById = new Map(chgs.map((x) => [x.id, x.supplement_no]));

    const latestSigned = docs.filter(d => d.doc_type === 'signed' && !d.change_id).at(-1)?.id;
    for (const d of docs) {
      if (!d.change_id && ['signed','contract_text'].includes(d.doc_type) && d.id !== latestSigned) continue;
      const fname = sanitizeFolderSegment(d.original_name || d.name || `doc_${d.id}`);
      if (d.change_id && chgById.has(d.change_id)) {
        const suppNo = chgById.get(d.change_id)!;
        const esc = escapeSupplementFolderName(suppNo);
        if (esc !== suppNo) folderEscapes.push({ supplementNo: suppNo, folderName: esc });
        const chgRoot = c.direction === 'expense' ? '支出合同变更与纠纷附件' : '收入合同变更与纠纷附件';
        const chgSlots = c.direction === 'expense' ? SUPERVISION_ATTACHMENT_SLOTS.expenseChange : SUPERVISION_ATTACHMENT_SLOTS.incomeChange;
        const slot = chgSlots.find((s) => (d.evidence_kind && (s.evidenceKinds as readonly string[]).includes(d.evidence_kind)) || (s.docTypes as readonly string[]).includes(d.doc_type));
        if (!slot) continue;
        if (totalBytes + d.size_bytes > maxBytes) {
          throw new AppError('EXPORT_SIZE_EXCEEDED', `报送包未压缩总大小超过 ${Math.round(maxBytes / 1024 / 1024)} MiB 上限，请按组织或期间分批导出`, 413);
        }
        addEntry(`${chgRoot}/${esc}/${slot.dir}/${d.id}_${fname}`, store.read(d.sha256));
        continue;
      }
      const slot = slots.find((s) => (d.evidence_kind && (s.evidenceKinds as readonly string[]).includes(d.evidence_kind)) || (s.docTypes as readonly string[]).includes(d.doc_type));
      if (!slot) continue;
      if (totalBytes + d.size_bytes > maxBytes) {
        throw new AppError('EXPORT_SIZE_EXCEEDED', `报送包未压缩总大小超过 ${Math.round(maxBytes / 1024 / 1024)} MiB 上限，请按组织或期间分批导出`, 413);
      }
      addEntry(`${rootDir}/${cFolder}/${slot.dir}/${d.id}_${fname}`, store.read(d.sha256));
    }
  }
  if (folderEscapes.length > 0) {
    addEntry('补充协议目录转义清单.json', JSON.stringify(folderEscapes, null, 2));
  }

  const zipBuf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const fileName = `纪巡财审报送包_${period}_${scopeMode}.zip`;
  recordExportLog(db, { exportKind: 'supervision_package', orgId: opts.orgId, period, scopeMode, contractCount: contracts.length, fileName, buf: zipBuf });
  return { fileName, contentType: 'application/zip', content: zipBuf, preflight };
}
