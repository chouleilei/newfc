/**
 * 多模板合同导入解析器（公司万元月报 & 上级《纪巡财审》收/支基本信息、执行及逐笔收付款、变更纠纷）。
 */
import type { DB } from '../../db/connection';
import type { RowError } from '../../core/errors';
import { centsToDecimalString, formatScaled, parseScaled, RATIO_SCALE } from '../../core/decimal';
import { orgInScope, type OrgScope } from '../security/scope';
import { normalizeHeaderText, sheetTable, type ReadSheet, type ReadTable } from '../io/table-reader';
import { amountCents, CellError, dateCell, findHeader, headerKey, headerUnit } from '../io/cell-values';
import { resolveEntity } from '../master/master.service';
import { getSetting } from '../settings/business-settings';
import type {
  ChangeApprovalTier,
  ChangeKind, ContractAcquisitionMethod, ContractDecisionMethod, ContractDirection, ContractFundingSource,
  ContractImportAction, ContractImportKind, ContractImportRowDto, ContractMeetingType,
  ContractPricingMode, ContractReportCategory, ContractStage, ContractStatus, ContractTenderBodyType, ContractTermType,
} from '../../contracts/project-contract';
import { CONTRACT_CURRENCIES } from '../../contracts/contract-lifecycle';
import type { LegalMetadata } from '../../contracts/contract-legal-review';
type ProcurementMethod = LegalMetadata['procurementMethod'];
import { procurementTier } from './legal-context';
import {
  LABEL_TO_ACQUISITION, LABEL_TO_CATEGORY, LABEL_TO_CHANGE_KIND, LABEL_TO_DECISION, LABEL_TO_FUNDING,
  LABEL_TO_MEETING, LABEL_TO_PRICING, LABEL_TO_PROCUREMENT, LABEL_TO_TENDER_BODY, LABEL_TO_TERM_TYPE,
} from './supervision-template-spec';
import { normalizeContractNo } from './contract.service';
import { CHANGE_TIER_RANK, computeChangeApprovalTier, normalizeSupplementNo } from './contract-change.service';

const CURRENCY_SET = new Set<string>(CONTRACT_CURRENCIES);
export const MIN_SIGN_DATE = '1990-01-01';
export function maxSignDate(): string {
  const d = new Date();
  d.setUTCFullYear(d.getUTCFullYear() + 1);
  return d.toISOString().slice(0, 10);
}

function flexibleDateCell(raw: string, label: string): string | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (/^\d{5}$/.test(trimmed)) {
    const serial = Number(trimmed);
    if (serial >= 30000 && serial <= 80000) {
      return new Date(Date.UTC(1899, 11, 30) + serial * 86_400_000).toISOString().slice(0, 10);
    }
  }
  return dateCell(trimmed, label);
}

function parseYesNo(raw: string, label: string, required = false): boolean | null {
  const v = raw.trim();
  if (!v) {
    if (required) throw new CellError(`${label}不能为空`);
    return null;
  }
  if (v === '是') return true;
  if (v === '否') return false;
  throw new CellError(`${label}「${v}」只能填写“是”或“否”`);
}

export function parseExchangeRateCell(raw: string, label = '参考汇率'): bigint | null {
  const trimmed = raw.trim();
  if (!trimmed) return null;
  if (!/^\d+(\.\d{1,6})?$/.test(trimmed)) {
    throw new CellError(`${label}「${trimmed}」应为最多 6 位小数的正数`);
  }
  const scaled = parseScaled(trimmed, RATIO_SCALE, { label });
  if (scaled <= 0n) throw new CellError(`${label}必须大于 0`);
  return scaled;
}

function isTemplateInstructionRow(values: Record<string, string>, keys: string[]): boolean {
  const first = keys.map((k) => values[k] ?? '').find((s) => s.trim() !== '') ?? '';
  return /^[(（]1[)）]/.test(first) || first.includes('要求：第1-') || (first.includes('不允许重复') && first.includes('必填'));
}

function skipInstructionRows(table: ReadTable): ReadTable {
  const keys = table.headers;
  return { ...table, rows: table.rows.filter((r) => !isTemplateInstructionRow(r.values, keys)) };
}

export function deriveLegalCategory(cat: ContractReportCategory): LegalMetadata['legalCategory'] {
  if (cat === 'engineering') return 'construction';
  if (cat === 'goods') return 'goods_procurement';
  if (cat === 'service') return 'general_service';
  return 'other';
}

export function deriveProcurementTarget(cat: ContractReportCategory): LegalMetadata['procurementTarget'] {
  if (cat === 'engineering') return 'construction';
  if (cat === 'goods') return 'goods';
  if (cat === 'service') return 'service';
  return null;
}

export function hasHeaderSet(sheet: ReadSheet, required: string[]): boolean {
  return sheet.rows.slice(0, 10).some((r) => {
    const keys = r.cells.map((c) => headerKey(normalizeHeaderText(c)));
    return required.every((k) => keys.includes(k));
  });
}

function resolveOrgCandidate(db: DB, scope: OrgScope, candidates: string[], defaultOrgId?: number | null): { orgId: number | null; error?: string } {
  const clean = candidates.map((s) => s.trim()).filter(Boolean);
  const allOrgs = db.prepare('SELECT id, code, name, report_full_name, parent_id, status FROM org').all() as {
    id: number; code: string; name: string; report_full_name: string; parent_id: number | null; status: string;
  }[];
  for (const text of clean) {
    const byFull = allOrgs.filter((o) => o.report_full_name && o.report_full_name.trim() === text);
    if (byFull.length === 1 && orgInScope(scope, byFull[0].id)) return { orgId: byFull[0].id };
    const res = resolveEntity(db, 'org', { code: text, name: text, sourceSystem: 'contract' });
    if (res.targetId !== null && orgInScope(scope, res.targetId)) return { orgId: res.targetId };
    if (res.matchedBy === 'ambiguous') {
      const cands = res.candidates.filter((c) => orgInScope(scope, c.id)).map((c) => c.name);
      if (cands.length) return { orgId: null, error: `单位“${text}”对应多个组织:${cands.join('、')}` };
    }
    const byExactName = allOrgs.filter((o) => o.name === text && orgInScope(scope, o.id));
    if (byExactName.length === 1) return { orgId: byExactName[0].id };
  }
  if (defaultOrgId != null && orgInScope(scope, defaultOrgId)) return { orgId: defaultOrgId };
  if (!scope.all && scope.orgIds.size === 1) return { orgId: [...scope.orgIds][0] };
  const scopedOrgs = allOrgs.filter((o) => orgInScope(scope, o.id) && o.status === 'active');
  if (scopedOrgs.length === 1) return { orgId: scopedOrgs[0].id };
  const roots = scopedOrgs.filter((o) => o.parent_id === null);
  if (roots.length === 1 && clean.length === 0) return { orgId: roots[0].id };
  return { orgId: null, error: clean.length ? `单位“${clean[0]}”未匹配到所属组织，请检查组织名称或 report_full_name` : '未能确定合同所属组织' };
}

function tryMatchSupplier(db: DB, raw: string): number | null {
  const first = raw.split(',')[0]?.trim() ?? '';
  if (!first) return null;
  const res = resolveEntity(db, 'supplier', { code: first, name: first, sourceSystem: 'contract' });
  return res.targetId;
}

export interface MonthlyPlanRow {
  row: number; contractNo: string; normalizedNo: string; name: string; contractType: string; reportCategory: ContractReportCategory;
  orgId: number; supplierId: number | null; direction: ContractDirection; pricingMode: ContractPricingMode; unitPriceDesc: string;
  currency: string; exchangeRateScaled: bigint | null;
  originalCents: bigint; signDate: string | null; termConditionText: string; counterpartyNames: string;
  procurementMethod: ProcurementMethod; undertakerDept: string; undertakerName: string; remark: string;
  targetStage: ContractStage; targetStatus: ContractStatus;
  subChangeDeltaCents: bigint; subSettledCents: bigint; subPaidOrReceivedCents: bigint;
  action: ContractImportAction; contractId: number | null; contractVersion: number | null; changes: Record<string, [string | null, string | null]>;
}

function extractMonthlySubSheetTotals(allSheets: ReadSheet[], mainSheet: ReadSheet): {
  changeByNo: Map<string, bigint>;
  settledByNo: Map<string, bigint>;
  paidByNo: Map<string, bigint>;
} {
  const changeByNo = new Map<string, bigint>();
  const settledByNo = new Map<string, bigint>();
  const paidByNo = new Map<string, bigint>();
  for (const s of allSheets) {
    if (s === mainSheet || s.hidden) continue;
    const isChange = s.name.includes('变更');
    const isSettle = s.name.includes('结算') || s.name.includes('付款') || s.name.includes('收款');
    if (!isChange && !isSettle) continue;
    const hdrIdx = s.rows.slice(0, 8).findIndex((r) => r.cells.some((c) => headerKey(c).includes('合同编号')));
    if (hdrIdx < 0) continue;
    const hdrCells = s.rows[hdrIdx].cells.map((c) => headerKey(normalizeHeaderText(c)));
    const subHdrCells = s.rows[hdrIdx + 1]?.cells.map((c) => headerKey(normalizeHeaderText(c))) ?? [];
    const noIdx = hdrCells.findIndex((k) => k === '合同编号' || k === '原合同编号');
    if (noIdx < 0) continue;
    let amtIdx = -1;
    for (let i = 0; i < Math.max(hdrCells.length, subHdrCells.length); i++) {
      const h = hdrCells[i] ?? '';
      const sh = subHdrCells[i] ?? '';
      if (isChange && (sh === '累计' || h.includes('累计变更') || h.includes('变更金额'))) { amtIdx = i; break; }
      if (isSettle && (sh === '累计' || h.includes('累计结算') || h.includes('结算金额'))) { amtIdx = i; break; }
    }
    let paidIdx = -1;
    if (isSettle) {
      paidIdx = hdrCells.findIndex((h) => h.includes('已付') || h.includes('实付') || h.includes('已收') || h.includes('实收'));
    }
    if (amtIdx < 0 && paidIdx < 0) continue;
    const startRow = subHdrCells.includes('累计') ? hdrIdx + 2 : hdrIdx + 1;
    for (const r of s.rows.slice(startRow)) {
      const rawNo = (r.cells[noIdx] ?? '').trim();
      if (!rawNo || /^(合计|小计|累计|总计)/.test(rawNo)) continue;
      const norm = normalizeContractNo(rawNo);
      if (amtIdx >= 0) {
        const rawVal = (r.cells[amtIdx] ?? '').trim().replace(/^\+/, '');
        if (rawVal && rawVal !== '/') {
          try {
            const c = amountCents(rawVal, 'wan', '分表累计金额');
            if (c !== null) {
              if (isChange) changeByNo.set(norm, (changeByNo.get(norm) ?? 0n) + c);
              else settledByNo.set(norm, (settledByNo.get(norm) ?? 0n) + c);
            }
          } catch {
            // ignore unparseable subsheet cells
          }
        }
      }
      if (paidIdx >= 0) {
        const rawPaid = (r.cells[paidIdx] ?? '').trim();
        if (rawPaid && rawPaid !== '/') {
          try {
            const p = amountCents(rawPaid, 'wan', '分表累计收付');
            if (p !== null && p > 0n) paidByNo.set(norm, (paidByNo.get(norm) ?? 0n) + p);
          } catch {
            // ignore
          }
        }
      }
    }
  }
  return { changeByNo, settledByNo, paidByNo };
}

export function parseMonthlyLedgerSheet(
  db: DB,
  scope: OrgScope,
  sheet: ReadSheet,
  defaultOrgId?: number | null,
  allSheets: ReadSheet[] = [sheet],
) {
  const table = sheetTable(sheet, {
    label: '公司月报合同台账总表表头',
    isHeader: (cells) => {
      const keys = cells.map(headerKey);
      return keys.includes('合同编号') && keys.includes('合同名称') && keys.includes('初始签订合同金额');
    },
  });
  const col = {
    contractNo: findHeader(table.headers, ['合同编号', '合同编码']),
    name: findHeader(table.headers, ['合同名称']),
    category: findHeader(table.headers, ['类别', '合同类型', '业务分类']),
    amount: findHeader(table.headers, ['初始签订合同金额']),
    direction: findHeader(table.headers, ['支出/收入', '收支方向']),
    signDate: findHeader(table.headers, ['签订日期', '签约日期']),
    term: findHeader(table.headers, ['工期', '履约期限']),
    counterparty: findHeader(table.headers, ['对方单位名称', '对方单位']),
    procMethod: findHeader(table.headers, ['采购方式']),
    dept: findHeader(table.headers, ['承办部门']),
    undertaker: findHeader(table.headers, ['承办人']),
    execStatus: findHeader(table.headers, ['执行情况']),
    remark: findHeader(table.headers, ['备注']),
    org: findHeader(table.headers, ['责任组织', '承办单位']),
    currency: findHeader(table.headers, ['币种', '合同币种']),
    exchangeRate: findHeader(table.headers, ['参考汇率', '汇率']),
    settledAmt: findHeader(table.headers, ['累计结算金额']),
    changeAmt: findHeader(table.headers, ['累计变更金额']),
    paidAmt: findHeader(table.headers, ['累计已付金额', '已付金额', '累计已收金额', '已收金额']),
  };
  const subTotals = extractMonthlySubSheetTotals(allSheets, sheet);
  const errors: RowError[] = [];
  const rows: MonthlyPlanRow[] = [];
  const display: ContractImportRowDto[] = [];
  const seen = new Map<string, number>();
  const orgNames = new Map((db.prepare('SELECT id, name FROM org').all() as { id: number; name: string }[]).map((o) => [o.id, o.name]));
  const maxDate = maxSignDate();
  let dataRowCount = 0;

  for (const r of table.rows) {
    const v = (k: keyof typeof col) => (col[k] ? (r.values[col[k]!] ?? '').trim() : '');
    const contractNoRaw = v('contractNo');
    const nameRaw = v('name');
    if (/^(合计|小计|累计|总计|年度之和)/.test(contractNoRaw) || (!contractNoRaw && /^(合计|小计|累计|总计)/.test(nameRaw))) continue;
    if (!contractNoRaw && !nameRaw) continue;
    dataRowCount++;
    const rowErrors: RowError[] = [];
    const err = (field: string, message: string) => rowErrors.push({ row: r.rowNo, field, message });
    if (!contractNoRaw) err('合同编号', '合同编号不能为空');
    if (!nameRaw) err('合同名称', '合同名称不能为空');
    const contractNo = contractNoRaw.slice(0, 64);
    const normalizedNo = contractNo ? normalizeContractNo(contractNo) : '';
    if (normalizedNo) {
      if (seen.has(normalizedNo)) err('合同编号', `合同编号与第 ${seen.get(normalizedNo)} 行重复`);
      else seen.set(normalizedNo, r.rowNo);
    }

    let direction: ContractDirection = 'expense';
    if (v('direction')) {
      if (v('direction').includes('收入') || v('direction') === 'income') direction = 'income';
      else if (v('direction').includes('支出') || v('direction') === 'expense') direction = 'expense';
      else err('支出/收入', `收支方向「${v('direction')}」无效`);
    }

    const currency = v('currency') || '人民币';
    if (!CURRENCY_SET.has(currency)) err('币种', `币种「${currency}」不在官方 20 种币种枚举内`);
    let exchangeRateScaled: bigint | null = null;
    if (v('exchangeRate')) {
      try { exchangeRateScaled = parseExchangeRateCell(v('exchangeRate')); }
      catch (e) { if (e instanceof CellError) err('参考汇率', e.message); else throw e; }
    }

    let pricingMode: ContractPricingMode = 'lump_sum';
    let unitPriceDesc = '';
    let originalCents = 0n;
    const rawAmt = v('amount');
    if (!rawAmt || rawAmt === '/' || rawAmt === '单价' || rawAmt === '按实结算') {
      pricingMode = 'unit_price';
      unitPriceDesc = rawAmt === '/' || !rawAmt ? '按合同约定单价' : rawAmt.slice(0, 500);
    } else if (/[元吨米千瓦时项台套次人月年]/i.test(rawAmt) || rawAmt.includes('/')) {
      pricingMode = 'unit_price';
      unitPriceDesc = rawAmt.slice(0, 500);
    } else {
      try {
        const parsed = amountCents(rawAmt, 'wan', '初始签订合同金额(万元)');
        if (parsed === null || parsed < 0n) err('初始签订合同金额', '初始签订合同金额不能为负');
        else originalCents = parsed;
      } catch (e) {
        if (e instanceof CellError) err('初始签订合同金额', e.message);
        else throw e;
      }
    }

    let signDate: string | null = null;
    if (v('signDate')) {
      try {
        signDate = flexibleDateCell(v('signDate'), '签订日期');
        if (signDate && (signDate < MIN_SIGN_DATE || signDate > maxDate)) err('签订日期', `签订日期 ${signDate} 超出合理范围`);
      } catch (e) {
        if (e instanceof CellError) err('签订日期', e.message);
        else throw e;
      }
    }

    let subChangeDeltaCents = normalizedNo ? (subTotals.changeByNo.get(normalizedNo) ?? 0n) : 0n;
    if (subChangeDeltaCents === 0n && v('changeAmt') && v('changeAmt') !== '/') {
      try { subChangeDeltaCents = amountCents(v('changeAmt').replace(/^\+/, ''), 'wan', '累计变更金额(万元)') ?? 0n; }
      catch (e) { if (e instanceof CellError) err('累计变更金额', e.message); else throw e; }
    }
    let subSettledCents = normalizedNo ? (subTotals.settledByNo.get(normalizedNo) ?? 0n) : 0n;
    if (subSettledCents === 0n && v('settledAmt') && v('settledAmt') !== '/') {
      try { subSettledCents = amountCents(v('settledAmt'), 'wan', '累计结算金额(万元)') ?? 0n; }
      catch (e) { if (e instanceof CellError) err('累计结算金额', e.message); else throw e; }
    }
    let subPaidOrReceivedCents = normalizedNo ? (subTotals.paidByNo.get(normalizedNo) ?? 0n) : 0n;
    if (subPaidOrReceivedCents === 0n && v('paidAmt') && v('paidAmt') !== '/') {
      try {
        const p = amountCents(v('paidAmt'), 'wan', '累计收付金额(万元)') ?? 0n;
        if (p < 0n) err('累计收付金额', '累计收付金额不能为负');
        else subPaidOrReceivedCents = p;
      } catch (e) { if (e instanceof CellError) err('累计收付金额', e.message); else throw e; }
    }

    const catText = v('category');
    const reportCategory: ContractReportCategory = LABEL_TO_CATEGORY[catText] ?? (catText.includes('工程') || catText.includes('施工') ? 'engineering' : catText.includes('货') ? 'goods' : catText.includes('服') ? 'service' : 'other');
    const procurementMethod: ProcurementMethod = LABEL_TO_PROCUREMENT[v('procMethod')] ?? null;
    const execText = v('execStatus');
    let targetStatus: ContractStatus = 'active';
    let targetStage: ContractStage = signDate ? 'performance' : 'drafting';
    if (execText === '完成' || execText === '已完成') { targetStatus = 'closed'; targetStage = 'closed'; }
    else if (execText === '未执行') { targetStage = 'drafting'; }

    const orgRes = resolveOrgCandidate(db, scope, [v('org'), v('dept')], defaultOrgId);
    if (orgRes.orgId === null) err('承办部门', orgRes.error ?? '未能匹配组织');

    const supplierId = tryMatchSupplier(db, v('counterparty'));
    let action: ContractImportAction | null = null;
    let contractId: number | null = null;
    let contractVersion: number | null = null;
    const changes: Record<string, [string | null, string | null]> = {};

    if (normalizedNo && !rowErrors.length) {
      const ex = db.prepare('SELECT * FROM ct_contract WHERE normalized_no = ?').safeIntegers(true).get(normalizedNo) as Record<string, unknown> | undefined;
      if (!ex) action = 'create';
      else if (!orgInScope(scope, Number(ex.org_id))) err('合同编号', `合同编号 ${contractNo} 已被其他组织使用`);
      else {
        contractId = Number(ex.id);
        contractVersion = Number(ex.version);
        if (orgRes.orgId !== Number(ex.org_id)) err('承办部门', '组织与已有合同不一致');
        if (pricingMode === 'lump_sum' && originalCents !== (ex.original_cents as bigint)) {
          err('初始签订合同金额', `金额 ${centsToDecimalString(originalCents)} 与已有合同原始金额 ${centsToDecimalString(ex.original_cents as bigint)} 不一致`);
        }
        const diff = (k: string, a: string | null, b: string | null) => { if (a !== b) changes[k] = [a, b]; };
        diff('name', String(ex.name), nameRaw.slice(0, 200));
        if (signDate) diff('signDate', (ex.sign_date as string | null) ?? null, signDate);
        if (v('undertaker')) diff('undertakerName', String(ex.undertaker_name ?? ''), v('undertaker').slice(0, 100));
        if (v('dept')) diff('undertakerDept', String(ex.undertaker_dept ?? ''), v('dept').slice(0, 100));
        if (v('counterparty')) diff('counterpartyNames', String(ex.counterparty_names ?? ''), v('counterparty').slice(0, 1000));
        if (exchangeRateScaled !== null && String(ex.exchange_rate_scaled ?? '') !== String(exchangeRateScaled)) {
          diff('exchangeRate', ex.exchange_rate_scaled == null ? null : formatScaled(ex.exchange_rate_scaled as bigint, RATIO_SCALE), formatScaled(exchangeRateScaled, RATIO_SCALE));
        }
        if (String(ex.status) !== 'active' && Object.keys(changes).length) err('合同编号', '非在途合同不能更新');
        action = Object.keys(changes).length ? 'update' : 'unchanged';
      }
    }

    display.push({
      row: r.rowNo, contractNo, name: nameRaw, action: rowErrors.length ? null : action, contractId,
      orgName: orgRes.orgId ? orgNames.get(orgRes.orgId) ?? null : null,
      projectCode: null, supplierName: v('counterparty') || null,
      amount: pricingMode === 'unit_price' ? '0.00' : centsToDecimalString(originalCents),
      paid: subPaidOrReceivedCents > 0n ? centsToDecimalString(subPaidOrReceivedCents) : null,
      signDate,
      direction, pricingMode, currency,
      exchangeRate: exchangeRateScaled === null ? null : formatScaled(exchangeRateScaled, RATIO_SCALE),
      detailSummary: pricingMode === 'unit_price' ? `单价: ${unitPriceDesc}` : '万元月报导入',
      changes,
    });
    if (rowErrors.length) { errors.push(...rowErrors); continue; }
    rows.push({
      row: r.rowNo, contractNo, normalizedNo, name: nameRaw.slice(0, 200),
      contractType: (catText || '其他').slice(0, 50), reportCategory,
      orgId: orgRes.orgId!, supplierId, direction, pricingMode, unitPriceDesc, currency, exchangeRateScaled, originalCents, signDate,
      termConditionText: v('term').slice(0, 50), counterpartyNames: v('counterparty').slice(0, 1000),
      procurementMethod, undertakerDept: v('dept').slice(0, 100), undertakerName: v('undertaker').slice(0, 100),
      remark: v('remark').slice(0, 2000), targetStage, targetStatus,
      subChangeDeltaCents, subSettledCents, subPaidOrReceivedCents,
      action: action!, contractId, contractVersion, changes,
    });
  }
  if (dataRowCount === 0) errors.push({ row: 0, field: '文件', message: '公司月报合同台账总表中没有数据行' });
  return { rows, errors, rowCount: dataRowCount, display };
}

export interface SupBasePlanRow {
  row: number; direction: ContractDirection; contractNo: string; normalizedNo: string; name: string; orgId: number;
  supplierId: number | null; pricingMode: ContractPricingMode; currency: string; exchangeRateScaled: bigint | null; originalCents: bigint; unitPriceDesc: string;
  counterpartyNames: string; summaryText: string; remark: string;
  fundingSource: ContractFundingSource; fundingSourceDetail: string; sourceIncomeContractId: number | null;
  entrustReason: string; isTripleMajor: boolean; decisionMethod: ContractDecisionMethod | null; decisionMethodOther: string;
  meetingType: ContractMeetingType | null; meetingTypeOther: string; finalApproverName: string; finalApproverTitle: string;
  isGovProcurement: boolean; procurementMethod: ProcurementMethod; procurementMethodOther: string; procurementPlanText: string;
  procurementStartDate: string | null; supplierConfirmDate: string | null; responseDocsComplete: boolean | null; creditChecked: boolean | null;
  undertakerName: string; deptReviewerName: string; relatedMgmtDepts: string; relatedMgmtReviewers: string;
  unitApproverName: string; unitApproverTitle: string; reportCategory: ContractReportCategory; contractType: string;
  acquisitionMethod: ContractAcquisitionMethod | null; acquisitionMethodOther: string; tenderBodyType: ContractTenderBodyType | null; consortiumMembers: string;
  signDate: string | null; termType: ContractTermType; termStartDate: string | null; termEndDate: string | null; termConditionText: string;
  ourSignatoryName: string; ourSignatoryTitle: string; ourSignatoryIsLegalRep: boolean | null; counterpartySignatoryIsLegalRep: boolean | null;
  action: ContractImportAction; contractId: number | null; contractVersion: number | null; changes: Record<string, [string | null, string | null]>;
}

export function parseSupervisionBaseSheet(db: DB, scope: OrgScope, sheet: ReadSheet, direction: ContractDirection, defaultOrgId?: number | null) {
  const table = skipInstructionRows(sheetTable(sheet, {
    label: `${direction === 'expense' ? '支出' : '收入'}合同基本信息表头`,
    isHeader: (cells) => {
      const keys = cells.map(headerKey);
      return keys.includes('合同编号') && keys.includes('合同名称') && keys.includes('计价方式') && keys.includes('合同币种');
    },
  }));
  const col = (alias: string[]) => findHeader(table.headers, alias);
  const errors: RowError[] = [];
  const rows: SupBasePlanRow[] = [];
  const display: ContractImportRowDto[] = [];
  const seen = new Map<string, number>();
  const orgNames = new Map((db.prepare('SELECT id, name FROM org').all() as { id: number; name: string }[]).map((o) => [o.id, o.name]));
  const maxDate = maxSignDate();
  if (table.rows.length === 0) errors.push({ row: 0, field: '文件', message: '没有数据行' });

  const cMap = {
    contractNo: col(['合同编号']), name: col(['合同名称']), pricing: col(['计价方式']), currency: col(['合同币种']),
    exchangeRate: col(['参考汇率', '汇率']),
    total: col(['合同总价']), unitPrice: col(['合同单价']), payer: col(['合同付款方']), payee: col(['合同收款方']),
    summary: col(['合同主要内容']), remark: col(['备注']),
    fundingSource: col(['资金来源']), fundingOther: col(['其他来源']), incomeNo: col(['收入合同编号']),
    entrustReason: col(['委托理由']), tripleMajor: col(["是否达到'三重一大'决策限额", '是否达到三重一大决策限额']),
    decisionMethod: col(['决策方式']), meetingType: col(['会议形式']), decisionOther: col(['其他决策方式']), meetingOther: col(['其他会议形式']),
    finalApproverName: col(['最终审批人姓名']), finalApproverTitle: col(['最终审批人身份']),
    govProc: col(['是否政府采购']), procMethod: col(['采购方式']), procOther: col(['其他采购方式']), procPlan: col(['采购计划']),
    procStart: col(['开始实施采购时间']), supplierConfirm: col(['供应商确定时间']), respComplete: col(['响应文件是否完整']),
    creditChecked: col(['是否展开资信调查', '是否进行业主资信调查']),
    undertaker: col(['承办人姓名']), deptReviewer: col(['承办部门审核人姓名']),
    mgmtDepts: col(['涉及的相关管理部门名称']), mgmtReviewers: col(['相关管理部门审核人姓名']),
    unitApproverName: col(['单位审批人姓名']), unitApproverTitle: col(['单位审批人身份']),
    category: col(['合同类型']), categoryOther: col(['其他合同类型']),
    acqMethod: col(['合同取得方式']), acqOther: col(['其他取得方式']), tenderBody: col(['投标主体']), consortium: col(['联合体投标']),
    signDate: col(['合同签署日期']), termType: col(['履约期限']), termStart: col(['履约开始日期']), termEnd: col(['履约结束日期']),
    ourSignName: col(['付款方合同签署人姓名', '收款方合同签署人姓名']),
    ourSignTitle: col(['付款方合同签署人身份', '收款方合同签署人身份']),
    ourIsRep: col(['付款方合同签署人是否是单位法定代表人', '收款方合同签署人是否是单位法定代表人']),
    cpIsRep: col(['收款方合同签署人是否是单位法定代表人']),
  };

  for (const r of table.rows) {
    const v = (k: keyof typeof cMap) => (cMap[k] ? (r.values[cMap[k]!] ?? '').trim() : '');
    const rowErrors: RowError[] = [];
    const err = (field: string, message: string) => rowErrors.push({ row: r.rowNo, field, message });
    const parseBool = (k: keyof typeof cMap, label: string) => {
      try { return parseYesNo(v(k), label, false); } catch (e) { if (e instanceof CellError) { err(label, e.message); return null; } throw e; }
    };
    const parseDate = (k: keyof typeof cMap, label: string) => {
      try { return flexibleDateCell(v(k), label); } catch (e) { if (e instanceof CellError) { err(label, e.message); return null; } throw e; }
    };

    const contractNo = v('contractNo').slice(0, 64);
    const name = v('name').slice(0, 200);
    if (!contractNo) err('合同编号', '合同编号不能为空');
    if (!name) err('合同名称', '合同名称不能为空');
    const normalizedNo = contractNo ? normalizeContractNo(contractNo) : '';
    if (normalizedNo) {
      if (seen.has(normalizedNo)) err('合同编号', `合同编号与第 ${seen.get(normalizedNo)} 行重复`);
      else seen.set(normalizedNo, r.rowNo);
    }

    const pricingMode = LABEL_TO_PRICING[v('pricing')];
    if (!pricingMode) err('计价方式', `计价方式「${v('pricing')}」只能为总价或单价`);
    const currency = v('currency') || '人民币';
    if (!CURRENCY_SET.has(currency)) err('合同币种', `币种「${currency}」不在官方 20 种币种枚举内`);
    let exchangeRateScaled: bigint | null = null;
    if (v('exchangeRate')) {
      try { exchangeRateScaled = parseExchangeRateCell(v('exchangeRate')); }
      catch (e) { if (e instanceof CellError) err('参考汇率', e.message); else throw e; }
    }

    let originalCents = 0n;
    const unitPriceDesc = v('unitPrice').slice(0, 500);
    if (pricingMode === 'lump_sum') {
      if (!v('total')) err('合同总价', '总价合同必须填写合同总价');
      else {
        try {
          const c = amountCents(v('total'), 'yuan', '合同总价');
          if (c === null || c <= 0n) err('合同总价', '总价合同总价必须大于 0');
          else originalCents = c;
        } catch (e) { if (e instanceof CellError) err('合同总价', e.message); else throw e; }
      }
    } else if (!unitPriceDesc) {
      err('合同单价', '单价合同必须填写合同单价说明');
    }

    const ourEntityText = direction === 'expense' ? v('payer') : v('payee');
    const counterpartyNames = (direction === 'expense' ? v('payee') : v('payer')).slice(0, 1000);
    if (!ourEntityText) err(direction === 'expense' ? '合同付款方' : '合同收款方', '本方单位名称不能为空');
    if (!counterpartyNames) err(direction === 'expense' ? '合同收款方' : '合同付款方', '相对方名称不能为空');
    const orgRes = resolveOrgCandidate(db, scope, [ourEntityText], defaultOrgId);
    if (orgRes.orgId === null) err(direction === 'expense' ? '合同付款方' : '合同收款方', orgRes.error ?? '未匹配到组织');

    let fundingSource: ContractFundingSource = 'self_owned_other';
    let sourceIncomeContractId: number | null = null;
    if (direction === 'expense') {
      const fs = LABEL_TO_FUNDING[v('fundingSource')];
      if (!fs) err('资金来源', `资金来源「${v('fundingSource')}」只能为财政拨款、收入合同或其他`);
      else fundingSource = fs;
      if (fundingSource === 'income_contract') {
        const incNo = v('incomeNo');
        if (!incNo) err('收入合同编号', '资金来源为收入合同时必须填写收入合同编号');
        else {
          const inc = db.prepare('SELECT id, org_id, direction, status FROM ct_contract WHERE normalized_no = ?').get(normalizeContractNo(incNo)) as
            { id: number; org_id: number; direction: string; status: string } | undefined;
          if (!inc || !orgInScope(scope, inc.org_id) || inc.direction !== 'income' || inc.status === 'voided') {
            err('收入合同编号', `未找到有效收入合同「${incNo}」（请先导入收入合同基本信息）`);
          } else sourceIncomeContractId = inc.id;
        }
      }
    }

    const isTripleMajor = parseBool('tripleMajor', "是否达到'三重一大'决策限额") ?? false;
    const decisionMethod = v('decisionMethod') ? (LABEL_TO_DECISION[v('decisionMethod')] ?? null) : null;
    if (v('decisionMethod') && !decisionMethod) err('决策方式', `决策方式「${v('decisionMethod')}」无效`);
    const meetingType = v('meetingType') ? (LABEL_TO_MEETING[v('meetingType')] ?? null) : null;
    if (decisionMethod === 'meeting' && !meetingType) err('会议形式', '决策方式为会议时必须填写会议形式');

    const isGovProcurement = direction === 'expense' ? (parseBool('govProc', '是否政府采购') ?? false) : false;
    const procurementMethod: ProcurementMethod = direction === 'expense' ? (LABEL_TO_PROCUREMENT[v('procMethod')] ?? null) : null;
    if (direction === 'expense' && v('procMethod') && !(v('procMethod') in LABEL_TO_PROCUREMENT)) {
      err('采购方式', `采购方式「${v('procMethod')}」无效`);
    }

    const procurementStartDate = parseDate('procStart', '开始实施采购时间');
    const supplierConfirmDate = parseDate('supplierConfirm', '供应商确定时间');
    const signDate = parseDate('signDate', '合同签署日期');
    if (signDate && (signDate < MIN_SIGN_DATE || signDate > maxDate)) err('合同签署日期', `签署日期 ${signDate} 超出合理范围`);
    if (procurementStartDate && supplierConfirmDate && procurementStartDate > supplierConfirmDate) err('供应商确定时间', '开始实施采购时间不能晚于供应商确定时间');
    if (supplierConfirmDate && signDate && supplierConfirmDate > signDate) err('合同签署日期', '供应商确定时间不能晚于合同签署日期');
    if (procurementStartDate && signDate && procurementStartDate > signDate) err('合同签署日期', '开始实施采购时间不能晚于合同签署日期');

    const termType: ContractTermType = v('termType') ? (LABEL_TO_TERM_TYPE[v('termType')] ?? 'unspecified') : 'unspecified';
    if (v('termType') && !LABEL_TO_TERM_TYPE[v('termType')]) err('履约期限', `履约期限「${v('termType')}」无效`);
    const termStartDate = parseDate('termStart', '履约开始日期');
    let termEndDate: string | null = null;
    let termConditionText = '';
    if (termType === 'fixed') {
      if (!termStartDate) err('履约开始日期', '固定期限合同时履约开始日期必填');
      termEndDate = parseDate('termEnd', '履约结束日期');
      if (!termEndDate) err('履约结束日期', '固定期限合同时履约结束日期必填');
      if (termStartDate && termEndDate && termStartDate > termEndDate) err('履约结束日期', '履约开始日期不能晚于履约结束日期');
    } else if (termType === 'conditional') {
      termConditionText = v('termEnd').slice(0, 50);
      if (!termConditionText) err('履约结束日期', '条件期限合同时须填写期限条件描述');
    }

    const responseDocsComplete = direction === 'expense' ? parseBool('respComplete', '响应文件是否完整') : null;
    const creditChecked = parseBool('creditChecked', direction === 'expense' ? '是否展开资信调查' : '是否进行业主资信调查');
    const ourSignatoryIsLegalRep = parseBool('ourIsRep', direction === 'expense' ? '付款方合同签署人是否是单位法定代表人' : '收款方合同签署人是否是单位法定代表人');
    const counterpartySignatoryIsLegalRep = direction === 'expense' ? parseBool('cpIsRep', '收款方合同签署人是否是单位法定代表人') : null;

    const reportCategory: ContractReportCategory = direction === 'expense' ? (LABEL_TO_CATEGORY[v('category')] ?? 'other') : 'service';
    const contractType = (direction === 'expense' ? (v('category') === '其他' && v('categoryOther') ? v('categoryOther') : v('category')) : '收入合同').slice(0, 50);
    const acquisitionMethod = direction === 'income' && v('acqMethod') ? (LABEL_TO_ACQUISITION[v('acqMethod')] ?? null) : null;
    const tenderBodyType = direction === 'income' && v('tenderBody') ? (LABEL_TO_TENDER_BODY[v('tenderBody')] ?? null) : null;

    const supplierId = tryMatchSupplier(db, counterpartyNames);
    let action: ContractImportAction | null = null;
    let contractId: number | null = null;
    let contractVersion: number | null = null;
    const changes: Record<string, [string | null, string | null]> = {};

    if (normalizedNo && !rowErrors.length) {
      const ex = db.prepare('SELECT * FROM ct_contract WHERE normalized_no = ?').safeIntegers(true).get(normalizedNo) as Record<string, unknown> | undefined;
      if (!ex) action = 'create';
      else if (!orgInScope(scope, Number(ex.org_id))) err('合同编号', `合同编号 ${contractNo} 已被其他组织使用`);
      else {
        contractId = Number(ex.id);
        contractVersion = Number(ex.version);
        if (String(ex.direction) !== direction) err('合同编号', '合同收支方向与已有合同不一致');
        if (orgRes.orgId !== Number(ex.org_id)) err('合同付款方', '组织与已有合同不一致');
        if (pricingMode === 'lump_sum' && originalCents !== (ex.original_cents as bigint)) {
          err('合同总价', `金额 ${centsToDecimalString(originalCents)} 与已有合同原始金额 ${centsToDecimalString(ex.original_cents as bigint)} 不一致`);
        }
        const diff = (k: string, a: string | null, b: string | null) => { if (a !== b) changes[k] = [a, b]; };
        diff('name', String(ex.name), name);
        if (signDate) diff('signDate', (ex.sign_date as string | null) ?? null, signDate);
        if (v('summary')) diff('summaryText', String(ex.summary_text ?? ''), v('summary').slice(0, 2000));
        if (v('undertaker')) diff('undertakerName', String(ex.undertaker_name ?? ''), v('undertaker').slice(0, 100));
        if (exchangeRateScaled !== null && String(ex.exchange_rate_scaled ?? '') !== String(exchangeRateScaled)) {
          diff('exchangeRate', ex.exchange_rate_scaled == null ? null : formatScaled(ex.exchange_rate_scaled as bigint, RATIO_SCALE), formatScaled(exchangeRateScaled, RATIO_SCALE));
        }
        if (String(ex.status) !== 'active' && Object.keys(changes).length) err('合同编号', '非在途合同不能更新');
        action = Object.keys(changes).length ? 'update' : 'unchanged';
      }
    }

    display.push({
      row: r.rowNo, contractNo, name, action: rowErrors.length ? null : action, contractId,
      orgName: orgRes.orgId ? orgNames.get(orgRes.orgId) ?? null : null,
      projectCode: null, supplierName: counterpartyNames || null,
      amount: pricingMode === 'unit_price' ? '0.00' : centsToDecimalString(originalCents), paid: null, signDate,
      direction, pricingMode: pricingMode ?? 'lump_sum', currency,
      exchangeRate: exchangeRateScaled === null ? null : formatScaled(exchangeRateScaled, RATIO_SCALE),
      detailSummary: `${currency} · ${pricingMode === 'unit_price' ? '单价' : '总价'}`,
      changes,
    });
    if (rowErrors.length) { errors.push(...rowErrors); continue; }
    rows.push({
      row: r.rowNo, direction, contractNo, normalizedNo, name, orgId: orgRes.orgId!, supplierId,
      pricingMode: pricingMode!, currency, exchangeRateScaled, originalCents, unitPriceDesc,
      counterpartyNames, summaryText: v('summary').slice(0, 2000), remark: v('remark').slice(0, 2000),
      fundingSource, fundingSourceDetail: v('fundingOther').slice(0, 500), sourceIncomeContractId,
      entrustReason: v('entrustReason').slice(0, 1000), isTripleMajor, decisionMethod, decisionMethodOther: v('decisionOther').slice(0, 200),
      meetingType, meetingTypeOther: v('meetingOther').slice(0, 200),
      finalApproverName: v('finalApproverName').slice(0, 100), finalApproverTitle: v('finalApproverTitle').slice(0, 100),
      isGovProcurement, procurementMethod, procurementMethodOther: v('procOther').slice(0, 200),
      procurementPlanText: v('procPlan').slice(0, 500), procurementStartDate, supplierConfirmDate, responseDocsComplete, creditChecked,
      undertakerName: v('undertaker').slice(0, 100), deptReviewerName: v('deptReviewer').slice(0, 100),
      relatedMgmtDepts: v('mgmtDepts').slice(0, 500), relatedMgmtReviewers: v('mgmtReviewers').slice(0, 500),
      unitApproverName: v('unitApproverName').slice(0, 100), unitApproverTitle: v('unitApproverTitle').slice(0, 100),
      reportCategory, contractType,
      acquisitionMethod, acquisitionMethodOther: v('acqOther').slice(0, 200), tenderBodyType, consortiumMembers: v('consortium').slice(0, 1000),
      signDate, termType, termStartDate, termEndDate, termConditionText,
      ourSignatoryName: v('ourSignName').slice(0, 100), ourSignatoryTitle: v('ourSignTitle').slice(0, 100),
      ourSignatoryIsLegalRep, counterpartySignatoryIsLegalRep,
      action: action!, contractId, contractVersion, changes,
    });
  }

  return { rows, errors, rowCount: table.rows.length, display };
}

export interface SupExecTxn {
  row: number; contractNo: string; normalizedNo: string; occurredDate: string; currency: string;
  amountCents: bigint; approverName: string; approverTitle: string;
}
export interface SupExecContractRow {
  row: number; contractNo: string; normalizedNo: string; name: string; contractId: number; contractVersion: number; orgId: number;
  targetStatus: ContractStatus; targetStage: ContractStage; deliverableSubmitted: boolean | null; finalAccepted: boolean;
  txns: SupExecTxn[]; action: ContractImportAction; changes: Record<string, [string | null, string | null]>;
}

const EXEC_STATUS_MAP: Record<string, ContractStatus> = {
  执行中: 'active', 未完成已中止: 'suspended', 未完成已终止: 'terminated', 已完成: 'closed',
};

export function parseSupervisionExecSheets(db: DB, scope: OrgScope, sheets: ReadSheet[], direction: ContractDirection) {
  const mainSheet = sheets.find((s) => !s.hidden && s.rows.some((r) => r.cells.some((c) => headerKey(c) === '合同执行状态'))) ?? sheets[0];
  const subSheet = sheets.find((s) => !s.hidden && s !== mainSheet && (
    s.name.includes('实际支付') || s.name.includes('实际收款') ||
    s.rows.some((r) => r.cells.some((c) => ['实际支付时间', '实际收款时间'].includes(headerKey(c))))
  ));

  const mainTable = skipInstructionRows(sheetTable(mainSheet, {
    label: `${direction === 'expense' ? '支出' : '收入'}合同执行信息表头`,
    isHeader: (cells) => {
      const keys = cells.map(headerKey);
      return keys.includes('合同编号') && keys.includes('合同名称') && keys.includes('合同执行状态');
    },
  }));
  const mc = {
    contractNo: findHeader(mainTable.headers, ['合同编号']),
    name: findHeader(mainTable.headers, ['合同名称']),
    execStatus: findHeader(mainTable.headers, ['合同执行状态']),
    deliverable: findHeader(mainTable.headers, ['是否按照约定提交成果']),
    accepted: findHeader(mainTable.headers, ['是否最终验收', '是否验收']),
  };

  const errors: RowError[] = [];
  const txnsByNo = new Map<string, SupExecTxn[]>();
  const mainContractNos = new Set<string>();
  for (const r of mainTable.rows) {
    const no = (r.values[mc.contractNo!] ?? '').trim();
    if (no) mainContractNos.add(normalizeContractNo(no));
  }

  if (subSheet) {
    const subTable = skipInstructionRows(sheetTable(subSheet, {
      label: direction === 'expense' ? '实际支付时间与金额表头' : '实际收款时间与金额表头',
      isHeader: (cells) => {
        const keys = cells.map(headerKey);
        return keys.includes('合同编号') && keys.includes(direction === 'expense' ? '实际支付时间' : '实际收款时间');
      },
    }));
    const sc = {
      contractNo: findHeader(subTable.headers, ['合同编号']),
      date: findHeader(subTable.headers, ['实际支付时间', '实际收款时间']),
      currency: findHeader(subTable.headers, ['付款币种', '收款币种']),
      amount: findHeader(subTable.headers, ['实际支付金额', '实际收款金额']),
      approverName: findHeader(subTable.headers, ['资金支付审批人姓名']),
      approverTitle: findHeader(subTable.headers, ['资金支付审批人身份']),
    };
    for (const r of subTable.rows) {
      const v = (k: keyof typeof sc) => (sc[k] ? (r.values[sc[k]!] ?? '').trim() : '');
      const no = v('contractNo');
      if (!no) { errors.push({ row: r.rowNo, field: '明细表合同编号', message: '收付款明细行缺少合同编号' }); continue; }
      const normNo = normalizeContractNo(no);
      if (!mainContractNos.has(normNo)) {
        errors.push({ row: r.rowNo, field: '明细表合同编号', message: `明细合同编号 ${no} 未出现在执行信息主表中` });
        continue;
      }
      let occurredDate: string | null = null;
      try { occurredDate = flexibleDateCell(v('date'), direction === 'expense' ? '实际支付时间' : '实际收款时间'); }
      catch (e) { if (e instanceof CellError) errors.push({ row: r.rowNo, field: '收付款时间', message: e.message }); else throw e; }
      if (!occurredDate) errors.push({ row: r.rowNo, field: '收付款时间', message: '实际收付款时间不能为空' });
      const currency = v('currency') || '人民币';
      if (!CURRENCY_SET.has(currency)) errors.push({ row: r.rowNo, field: '币种', message: `币种「${currency}」不在官方枚举内` });
      let amt: bigint | null = null;
      try { amt = amountCents(v('amount'), 'yuan', '实际收付款金额'); }
      catch (e) { if (e instanceof CellError) errors.push({ row: r.rowNo, field: '金额', message: e.message }); else throw e; }
      if (amt === null || amt <= 0n) errors.push({ row: r.rowNo, field: '金额', message: '实际收付款金额必须大于 0' });
      if (direction === 'expense' && (!v('approverName') || !v('approverTitle'))) {
        errors.push({ row: r.rowNo, field: '审批人', message: '支出实际支付明细必须填写资金支付审批人姓名与身份' });
      }
      if (occurredDate && amt !== null && amt > 0n) {
        const list = txnsByNo.get(normNo) ?? [];
        list.push({
          row: r.rowNo, contractNo: no, normalizedNo: normNo, occurredDate, currency, amountCents: amt,
          approverName: v('approverName').slice(0, 100), approverTitle: v('approverTitle').slice(0, 100),
        });
        txnsByNo.set(normNo, list);
      }
    }
  }

  const rows: SupExecContractRow[] = [];
  const display: ContractImportRowDto[] = [];
  const seen = new Map<string, number>();
  const orgNames = new Map((db.prepare('SELECT id, name FROM org').all() as { id: number; name: string }[]).map((o) => [o.id, o.name]));
  if (mainTable.rows.length === 0) errors.push({ row: 0, field: '文件', message: '执行信息主表没有数据行' });

  for (const r of mainTable.rows) {
    const v = (k: keyof typeof mc) => (mc[k] ? (r.values[mc[k]!] ?? '').trim() : '');
    const rowErrors: RowError[] = [];
    const err = (field: string, message: string) => rowErrors.push({ row: r.rowNo, field, message });
    const contractNo = v('contractNo').slice(0, 64);
    const normalizedNo = contractNo ? normalizeContractNo(contractNo) : '';
    if (!contractNo) err('合同编号', '合同编号不能为空');
    if (normalizedNo) {
      if (seen.has(normalizedNo)) err('合同编号', `合同编号与第 ${seen.get(normalizedNo)} 行重复`);
      else seen.set(normalizedNo, r.rowNo);
    }
    const targetStatus = EXEC_STATUS_MAP[v('execStatus')];
    if (!targetStatus) err('合同执行状态', `合同执行状态「${v('execStatus')}」无效`);
    let deliverableSubmitted: boolean | null = null;
    let finalAccepted = false;
    try {
      if (direction === 'expense' && v('deliverable')) deliverableSubmitted = parseYesNo(v('deliverable'), '是否按照约定提交成果', false);
      if (v('accepted')) finalAccepted = parseYesNo(v('accepted'), '是否最终验收', false) ?? false;
    } catch (e) { if (e instanceof CellError) err('验收标记', e.message); else throw e; }

    const txns = normalizedNo ? (txnsByNo.get(normalizedNo) ?? []) : [];
    let contractId: number | null = null;
    let contractVersion: number | null = null;
    let orgId = 0;
    let targetStage: ContractStage = 'performance';
    let contractName = v('name');
    const changes: Record<string, [string | null, string | null]> = {};
    let totalTxnCents = 0n;
    for (const t of txns) totalTxnCents += t.amountCents;

    if (normalizedNo && !rowErrors.length) {
      const ex = db.prepare('SELECT * FROM ct_contract WHERE normalized_no = ?').safeIntegers(true).get(normalizedNo) as Record<string, unknown> | undefined;
      if (!ex || !orgInScope(scope, Number(ex.org_id))) err('合同编号', `未找到合同「${contractNo}」或无权访问`);
      else if (String(ex.direction) !== direction) err('合同编号', `合同「${contractNo}」收支方向不匹配`);
      else if (String(ex.status) === 'voided') err('合同编号', `合同「${contractNo}」已作废`);
      else {
        contractId = Number(ex.id);
        contractVersion = Number(ex.version);
        orgId = Number(ex.org_id);
        contractName = contractName || String(ex.name);
        const curStage = String(ex.stage) as ContractStage;
        targetStage = targetStatus === 'closed' ? 'closed' : (['initiation', 'procurement', 'drafting', 'approval'].includes(curStage) ? 'performance' : curStage);

        for (const t of txns) if (t.currency !== ex.currency) err('币种', `第 ${t.row} 行流水币种 ${t.currency} 与合同币种 ${String(ex.currency)} 不一致`);
        const pricingMode = String(ex.pricing_mode);
        const cap = pricingMode === 'unit_price'
          ? (ex.estimated_ceiling_cents === null ? null : (ex.estimated_ceiling_cents as bigint))
          : ((ex.original_cents as bigint) + (ex.approved_change_cents as bigint));
        const normalSum = direction === 'expense'
          ? (db.prepare("SELECT COALESCE(SUM(amount_cents), 0) AS s FROM ct_payment WHERE contract_id = ? AND kind = 'normal' AND status = 'paid'").safeIntegers(true).get(contractId) as { s: bigint }).s
          : (db.prepare("SELECT COALESCE(SUM(amount_cents), 0) AS s FROM ct_receipt WHERE contract_id = ? AND kind = 'normal' AND status = 'received'").safeIntegers(true).get(contractId) as { s: bigint }).s;
        if (txns.length > 0 && cap !== null && normalSum + totalTxnCents > cap) {
          err('实际收付款金额', `累计实付/实收 ${centsToDecimalString(normalSum + totalTxnCents)} 超过合同限额 ${centsToDecimalString(cap)}`);
        }
        if (String(ex.status) !== targetStatus) changes.status = [String(ex.status), targetStatus];
        if (curStage !== targetStage) changes.stage = [curStage, targetStage];
        if (deliverableSubmitted !== null && Number(ex.deliverable_submitted ?? -1) !== (deliverableSubmitted ? 1 : 0)) {
          changes.deliverableSubmitted = [ex.deliverable_submitted == null ? null : String(!!ex.deliverable_submitted), String(deliverableSubmitted)];
        }
        if (Number(ex.final_accepted ?? 0) !== (finalAccepted ? 1 : 0)) {
          changes.finalAccepted = [String(!!ex.final_accepted), String(finalAccepted)];
        }
        if (txns.length > 0) {
          changes[direction === 'expense' ? 'payments' : 'receipts'] = [
            `原基线 ${centsToDecimalString((direction === 'expense' ? ex.paid_cents : ex.received_cents) as bigint)}`,
            `${txns.length} 笔共 ${centsToDecimalString(totalTxnCents)}`,
          ];
        }
      }
    }

    display.push({
      row: r.rowNo, contractNo, name: contractName, action: rowErrors.length ? null : (Object.keys(changes).length ? 'update' : 'unchanged'),
      contractId, orgName: orgId ? orgNames.get(orgId) ?? null : null,
      projectCode: null, supplierName: null, amount: null,
      paid: txns.length ? centsToDecimalString(totalTxnCents) : null, signDate: txns[0]?.occurredDate ?? null,
      direction, detailSummary: txns.length ? `${txns.length} 笔明细 (${txns.map((t) => t.occurredDate).join(', ')})` : '仅更新执行状态',
      changes,
    });
    if (rowErrors.length) { errors.push(...rowErrors); continue; }
    rows.push({
      row: r.rowNo, contractNo, normalizedNo, name: contractName, contractId: contractId!, contractVersion: contractVersion!,
      orgId, targetStatus: targetStatus!, targetStage, deliverableSubmitted, finalAccepted, txns,
      action: Object.keys(changes).length ? 'update' : 'unchanged', changes,
    });
  }
  return { rows, errors, rowCount: mainTable.rows.length, display };
}

export interface SupChangePlanRow {
  row: number; contractNo: string; normalizedNo: string; name: string; contractId: number; contractVersion: number; orgId: number;
  changeKind: ChangeKind; deltaCents: bigint; requiredApprovalTier: ChangeApprovalTier; actualApprovalTier: ChangeApprovalTier;
  flagNegativeTotalWarning: boolean;
  changeMatter: string; reason: string; decisionMethod: ContractDecisionMethod | null;
  meetingType: ContractMeetingType | null; finalApproverName: string; supplementNo: string; normalizedSupplementNo: string;
  hasDispute: boolean; action: ContractImportAction; changes: Record<string, [string | null, string | null]>;
}

function deriveImportedActualTier(
  requiredTier: ChangeApprovalTier,
  decisionMethod: ContractDecisionMethod | null,
  meetingType: ContractMeetingType | null,
  explicitText: string,
): ChangeApprovalTier {
  const t = explicitText.trim();
  let candidate: ChangeApprovalTier | null = null;
  if (t.includes('经营层') || t.includes('董事会') || t.includes('党组') || t.includes('党委') || t === 'management_board') candidate = 'management_board';
  else if (t.includes('总经理') || t === 'general_manager') candidate = 'general_manager';
  else if (t.includes('双分管') || t.includes('合同归口') || t === 'dual_vp') candidate = 'dual_vp';
  else if (t.includes('技术') && t.includes('副总') || t === 'tech_and_undertaker_vp') candidate = 'tech_and_undertaker_vp';
  else if (t.includes('分管') || t.includes('副总') || t === 'undertaker_vp') candidate = 'undertaker_vp';
  else if (t.includes('承办单位') || t === 'undertaker_unit') candidate = 'undertaker_unit';
  else if (decisionMethod === 'meeting' && meetingType && ['party_committee', 'board', 'gm_office'].includes(meetingType)) {
    candidate = 'management_board';
  }
  if (!candidate) return requiredTier;
  return CHANGE_TIER_RANK[candidate] >= CHANGE_TIER_RANK[requiredTier] ? candidate : requiredTier;
}

export function parseSupervisionChangeSheet(db: DB, scope: OrgScope, sheet: ReadSheet, direction: ContractDirection) {
  const table = skipInstructionRows(sheetTable(sheet, {
    label: `${direction === 'expense' ? '支出' : '收入'}合同变更与纠纷表头`,
    isHeader: (cells) => {
      const keys = cells.map(headerKey);
      return keys.includes('原合同编号') && keys.includes('变动类型') && keys.includes('变更补充协议编号');
    },
  }));
  const c = {
    contractNo: findHeader(table.headers, ['原合同编号']),
    name: findHeader(table.headers, ['原合同名称']),
    kind: findHeader(table.headers, ['变动类型']),
    delta: findHeader(table.headers, ['变更金额', '变动金额', '增减金额']),
    matter: findHeader(table.headers, ['变更主要事项']),
    reason: findHeader(table.headers, ['变更原因']),
    decision: findHeader(table.headers, ['变更决策方式']),
    meeting: findHeader(table.headers, ['会议形式']),
    approver: findHeader(table.headers, ['变更最终审批人姓名']),
    approvalTier: findHeader(table.headers, ['变更审批层级', '实际审批层级']),
    supplementNo: findHeader(table.headers, ['变更补充协议编号']),
    dispute: findHeader(table.headers, ['是否产生合同纠纷']),
  };
  const deltaUnit = (c.delta && headerUnit(c.delta)) || 'yuan';
  const orMode: 'min' | 'max' = getSetting(db, 'contract.change_or_mode') === 'max' ? 'max' : 'min';

  const errors: RowError[] = [];
  const rows: SupChangePlanRow[] = [];
  const display: ContractImportRowDto[] = [];
  const seenSupp = new Map<string, number>();
  const orgNames = new Map((db.prepare('SELECT id, name FROM org').all() as { id: number; name: string }[]).map((o) => [o.id, o.name]));
  if (table.rows.length === 0) errors.push({ row: 0, field: '文件', message: '没有数据行' });

  for (const r of table.rows) {
    const v = (k: keyof typeof c) => (c[k] ? (r.values[c[k]!] ?? '').trim() : '');
    const rowErrors: RowError[] = [];
    const err = (field: string, message: string) => rowErrors.push({ row: r.rowNo, field, message });
    const contractNo = v('contractNo').slice(0, 64);
    const normalizedNo = contractNo ? normalizeContractNo(contractNo) : '';
    if (!contractNo) err('原合同编号', '原合同编号不能为空');
    const changeKind = LABEL_TO_CHANGE_KIND[v('kind')];
    if (!changeKind) err('变动类型', `变动类型「${v('kind')}」只能为变更、中止或解除`);
    let deltaCents = 0n;
    if (v('delta')) {
      try {
        deltaCents = amountCents(v('delta').replace(/^\+/, ''), deltaUnit, '变更金额') ?? 0n;
      } catch (e) {
        if (e instanceof CellError) err('变更金额', e.message);
        else throw e;
      }
    }
    const changeMatter = v('matter').slice(0, 500);
    const reason = v('reason').slice(0, 500);
    if (!changeMatter) err('变更主要事项', '变更主要事项不能为空');
    if (!reason) err('变更原因', '变更原因不能为空');
    const finalApproverName = v('approver').slice(0, 100);
    if (!finalApproverName) err('变更最终审批人姓名', '变更最终审批人姓名不能为空');
    const supplementNo = v('supplementNo').slice(0, 100);
    const normalizedSupplementNo = supplementNo ? normalizeSupplementNo(supplementNo) : '';
    if (!supplementNo) err('变更补充协议编号', '变更补充协议编号不能为空');
    let hasDispute = false;
    try { hasDispute = parseYesNo(v('dispute'), '是否产生合同纠纷', true) ?? false; }
    catch (e) { if (e instanceof CellError) err('是否产生合同纠纷', e.message); else throw e; }

    let decisionMethod: ContractDecisionMethod | null = null;
    if (v('decision')) {
      decisionMethod = LABEL_TO_DECISION[v('decision')] ?? null;
      if (!decisionMethod) err('变更决策方式', `决策方式「${v('decision')}」无效`);
    }
    let meetingType: ContractMeetingType | null = null;
    if (v('meeting')) {
      meetingType = LABEL_TO_MEETING[v('meeting')] ?? null;
      if (!meetingType) err('会议形式', `会议形式「${v('meeting')}」无效`);
    }
    if (decisionMethod === 'meeting' && !meetingType) err('会议形式', '决策方式为会议时必须填写会议形式');

    let contractId: number | null = null;
    let contractVersion: number | null = null;
    let orgId = 0;
    let contractName = v('name');
    let requiredApprovalTier: ChangeApprovalTier = 'undertaker_unit';
    let actualApprovalTier: ChangeApprovalTier = 'undertaker_unit';
    let flagNegativeTotalWarning = false;
    let action: ContractImportAction | null = null;
    const changes: Record<string, [string | null, string | null]> = {};

    if (normalizedNo && normalizedSupplementNo) {
      if (seenSupp.has(normalizedSupplementNo)) err('变更补充协议编号', `补充协议编号「${supplementNo}」与第 ${seenSupp.get(normalizedSupplementNo)} 行重复`);
      else seenSupp.set(normalizedSupplementNo, r.rowNo);
    }

    if (normalizedNo && !rowErrors.length) {
      const ex = db.prepare('SELECT * FROM ct_contract WHERE normalized_no = ?').safeIntegers(true).get(normalizedNo) as Record<string, unknown> | undefined;
      if (!ex || !orgInScope(scope, Number(ex.org_id))) err('原合同编号', `未找到合同「${contractNo}」或无权访问`);
      else if (String(ex.direction) !== direction) err('原合同编号', `合同「${contractNo}」收支方向不匹配`);
      else if (String(ex.status) === 'voided') err('原合同编号', `合同「${contractNo}」已作废`);
      else {
        contractId = Number(ex.id);
        contractVersion = Number(ex.version);
        orgId = Number(ex.org_id);
        contractName = contractName || String(ex.name);
        const origCents = ex.original_cents as bigint;
        const curApprovedChg = ex.approved_change_cents as bigint;
        const ceilingCents = ex.estimated_ceiling_cents === null ? null : (ex.estimated_ceiling_cents as bigint);
        const priorPos = (
          db.prepare("SELECT COALESCE(SUM(delta_cents), 0) AS s FROM ct_change WHERE contract_id = ? AND status = 'approved' AND delta_cents > 0")
            .safeIntegers(true)
            .get(contractId) as { s: bigint }
        ).s;
        const pTier = procurementTier(
          Boolean(ex.is_procurement),
          (ex.procurement_target as LegalMetadata['procurementTarget']) ?? null,
          origCents > 0n ? origCents : (ceilingCents ?? 0n),
          (ex.procurement_method as LegalMetadata['procurementMethod']) ?? null,
        );
        requiredApprovalTier = computeChangeApprovalTier({
          originalCents: origCents,
          estimatedCeilingCents: ceilingCents,
          priorApprovedPositiveCents: priorPos,
          deltaCents,
          changeKind: changeKind!,
          procurementTier: pTier,
          involvesBizOrEntityChange: false,
          involvesTechChange: false,
          orMode,
        }).tier;
        actualApprovalTier = deriveImportedActualTier(requiredApprovalTier, decisionMethod, meetingType, v('approvalTier'));
        if (String(ex.pricing_mode) === 'lump_sum' && origCents + curApprovedChg + deltaCents < 0n) {
          if (String(ex.migration_mode) === 'legacy_tolerant') {
            flagNegativeTotalWarning = true;
          } else {
            err('变更金额', `变更后合同总金额 ${centsToDecimalString(origCents + curApprovedChg + deltaCents)} 不能小于 0`);
          }
        }
        const dup = db.prepare('SELECT id, contract_id FROM ct_change WHERE org_root_id = ? AND normalized_supplement_no = ?')
          .get(orgId, normalizedSupplementNo) as { id: number; contract_id: number } | undefined;
        if (dup) {
          if (dup.contract_id !== contractId) err('变更补充协议编号', `补充协议编号「${supplementNo}」已在同单位其他合同中使用`);
          else action = 'unchanged';
        } else {
          action = 'update';
          changes.supplement = [null, `${v('kind')} · ${supplementNo}`];
          if (deltaCents !== 0n) changes.delta = ['0.00', centsToDecimalString(deltaCents)];
          if (hasDispute) changes.dispute = ['否', '是'];
        }
      }
    }

    display.push({
      row: r.rowNo, contractNo, name: contractName, action: rowErrors.length ? null : action,
      contractId, orgName: orgId ? orgNames.get(orgId) ?? null : null,
      projectCode: null, supplierName: null, amount: centsToDecimalString(deltaCents), paid: null, signDate: null,
      direction, detailSummary: `${v('kind')} · ${supplementNo}${deltaCents !== 0n ? ` · ${centsToDecimalString(deltaCents)}` : ''}${hasDispute ? ' · 涉纠纷' : ''}`,
      changes,
    });
    if (rowErrors.length) { errors.push(...rowErrors); continue; }
    rows.push({
      row: r.rowNo, contractNo, normalizedNo, name: contractName, contractId: contractId!, contractVersion: contractVersion!,
      orgId, changeKind: changeKind!, deltaCents, requiredApprovalTier, actualApprovalTier, flagNegativeTotalWarning,
      changeMatter, reason, decisionMethod, meetingType,
      finalApproverName, supplementNo, normalizedSupplementNo, hasDispute, action: action!, changes,
    });
  }
  return { rows, errors, rowCount: table.rows.length, display };
}
