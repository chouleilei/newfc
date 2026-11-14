import { getSetting, workingCalendar } from '../settings/business-settings';
import { assertContractFunding } from './contract-funding';
import { assertWarrantyReleased, contractHasWarranty, deriveContractSixDim, requireEvidence } from './contract-controls';
import { validateNewContractNoWithPrefixMap } from './prefix-map.service';
import { legalAccess } from './legal-access';
import { assertGuarantorConsent, CHANGE_TIER_RANK } from './contract-change.service';
import { getContractEvaluation, getContractWarranty, listContractDisputes, listContractGuarantees } from './contract-safeguard.service';
import { legalSnapshot, legalEnabled, legalSigningDateConflict, procurementTier } from './legal-context';
import { legalRunCurrent, assertLegalDecision } from './legal-review-gate';
import { isValidLegacyDocUpload, legacyDoc } from './document-parser';
import { listContractSettlements } from './contract-settlement.service';
import type { EvidenceKind, LegalMetadata } from '../../contracts/contract-legal-review';
/**
 * 合同生命周期(AC-F16)。规则见 specs/implementation.md T-4「合同生命周期」。
 *
 * - 阶段只能前进到下一阶段;推进前服务端重算 blockers,有 blocker 返回 CONTRACT_STAGE_BLOCKED。
 * - 当前金额 = 原始金额 + 已批准变更;已付只由支付登记累加。付款申请与批准时校验 已批准未付 + 已付 + 本次 ≤ 可付上限。
 * - 变更只在履约执行/变更结算阶段提交、须附证据;批准在同一事务里累加,导致当前金额 < 已付时拒绝。
 * - 审核/变更/付款复核:复核人 ≠ 提交人(管理员同人复核须填例外原因)。每一步写合同事件与审计。
 * - 已关闭、终止或作废的合同拒绝其余写操作(CONTRACT_STATE);重开需要 contract:review。
 * - 组织范围按合同 org_id;范围外 404。
 */
import type { DB } from '../../db/connection';
import type { PageDto, PageQuery } from '../../contracts/common';
import { AppError } from '../../core/errors';
import { currentAuth } from '../../core/request-context';
import { centsToDecimalString, formatScaled, mulCents, parseDecimalToCents, parseScaled, ratioString, RATIO_SCALE } from '../../core/decimal';
import { addCalendarDays, todayUtcDate, workingDayCutoffBefore } from '../../core/workdays';
import { writeLog } from '../audit/log';
import { assertDistinctReviewer, isAdminUser } from '../security/review';
import { currentOrgScope, notVisible, orgInScope, scopeFilterSql } from '../security/scope';
import { storeFile, type ObjectStore } from '../files/object-store';
import {
  CONTRACT_DOC_TYPE_LABELS, CONTRACT_STAGE_LABELS, CONTRACT_STAGES, CONTRACT_STATUSES, type BlockerDto, type ChangeApprovalTier, type ChangeKind, type ContractChangeDto, type ContractCommandRequest, type ContractCreateRequest,
  type ContractDetailDto, type ContractDocType, type ContractDocumentDto, type ContractDto, type ContractEventDto, type ContractListQuery, type ContractPaymentDto, type ContractTodo,
  type ContractReviewDto, type ContractStage, type ContractStatus, type ContractSummaryDto, type ContractUpdateRequest, type DecisionRequest,
  type ContractAcquisitionMethod, type ContractArchiveStatus, type ContractArchiveStatusRequest, type ContractBudgetType, type ContractDecisionMethod, type ContractDirection,
  type ContractDistributionRequest, type ContractDistributionStatus, type ContractFundingSource, type ContractHandoverRequest, type ContractMeetingType,
  type ContractPaymentApprovalTier, type ContractPaymentType, type ContractPricingMode, type ContractReceiptDto, type ContractReportCategory,
  type ContractSettlementDto, type ContractTenderBodyType, type ContractTermType, type ContractUndertakerHandoverDto,
  type ContractCurrencyLineDto,
} from '../../contracts/project-contract';

const nowIso = () => new Date().toISOString();
const conflict = (code: string, message: string, details?: unknown) => new AppError(code, message, 409, undefined, details);
const todayIso = () => nowIso().slice(0, 10);
const isDirectPowerStationOrg = (db: DB, orgId: number) => {
  const row = db.prepare('SELECT is_direct_station FROM org WHERE id = ?').get(orgId) as { is_direct_station: number } | undefined;
  return row?.is_direct_station === 1;
};
const deriveReportCategory = (target: LegalMetadata['procurementTarget'], category: LegalMetadata['legalCategory'], explicit?: ContractReportCategory): ContractReportCategory => {
  if (explicit) return explicit;
  if (target === 'construction' || category === 'small_construction' || category === 'construction') return 'engineering';
  if (target === 'goods' || category === 'goods_procurement') return 'goods';
  if (target === 'service' || category === 'tech_service' || category === 'general_service') return 'service';
  return 'other';
};

export interface ContractRow {
  id: number; contract_no: string; normalized_no: string; name: string; contract_type: string; org_id: number; project_id: number | null; supplier_id: number | null;
  original_cents: bigint; approved_change_cents: bigint; paid_cents: bigint; payment_cap_ratio_scaled: bigint | null; stage: ContractStage; status: ContractStatus;
  status_reason: string | null; sign_date: string | null; effective_date: string | null; source: 'manual' | 'import'; import_id: number | null; version: number;
  created_by_user_id: number | null; created_at: string; updated_at: string;
  legal_category: LegalMetadata['legalCategory']; party_role: LegalMetadata['partyRole']; signing_entity_level: LegalMetadata['signingEntityLevel']; is_procurement: number; procurement_target: LegalMetadata['procurementTarget']; procurement_method: LegalMetadata['procurementMethod']; procurement_tier: LegalMetadata['procurementTier']; is_important: number;
  direction: ContractDirection; pricing_mode: ContractPricingMode; unit_price_desc: string; estimated_ceiling_cents: bigint | null;
  currency: string; exchange_rate_scaled: bigint | null; report_category: ContractReportCategory; summary_text: string; remark: string;
  out_of_plan_approved_date: string | null;
  plan_item_id: number | null; budget_type: ContractBudgetType; is_emergency: number; emergency_start_date: string | null;
  funding_source: ContractFundingSource; funding_source_detail: string; source_income_contract_id: number | null; parent_contract_id: number | null; external_no_exempt: number;
  counterparty_names: string; undertaker_name: string; undertaker_dept: string;
  our_signatory_name: string; our_signatory_title: string; our_signatory_is_legal_rep: number | null;
  counterparty_signatory_name: string; counterparty_signatory_title: string; counterparty_signatory_is_legal_rep: number | null;
  entrust_reason: string; is_triple_major: number; decision_method: ContractDecisionMethod | null; decision_method_other: string;
  meeting_type: ContractMeetingType | null; meeting_type_other: string; final_approver_name: string; final_approver_title: string;
  is_gov_procurement: number; procurement_method_other: string; procurement_plan_text: string; procurement_start_date: string | null; supplier_confirm_date: string | null;
  response_docs_complete: number | null; credit_checked: number | null; bid_award_cents: bigint | null;
  acquisition_method: ContractAcquisitionMethod | null; acquisition_method_other: string; tender_body_type: ContractTenderBodyType | null; consortium_members: string;
  dept_reviewer_name: string; related_mgmt_depts: string; related_mgmt_reviewers: string; unit_approver_name: string; unit_approver_title: string; farmer_wage_account: string;
  term_type: ContractTermType; term_start_date: string | null; term_end_date: string | null; term_condition_text: string;
  deliverable_submitted: number | null; final_accepted: number; has_warranty: number; warranty_months: number | null; warranty_retention_ratio_scaled: bigint | null;
  settled_gross_cents: bigint; settled_net_cents: bigint; received_cents: bigint;
  distribution_status: ContractDistributionStatus; distributed_at: string | null; company_filed_at: string | null;
  archive_status: ContractArchiveStatus; archive_checked_at: string | null; archive_transferred_at: string | null; archive_transfer_no: string | null; archive_defer_note: string | null;
  completed_date: string | null;
  procurement_record_id: number | null;
  origin: 'manual' | 'standard_import' | 'legacy_migration';
  migration_mode: 'normal' | 'legacy_tolerant';
  duplicate_conflict_group: string;
  amount_fact_source: 'confirmed_contract' | 'unit_price_open' | 'voucher_debit_clue' | 'unverified_forecast';
  clue_voucher_debit_cents: bigint | null;
  legacy_settled_baseline_cents: bigint | null;
  legacy_invoiced_baseline_cents: bigint | null;
  legacy_revenue_baseline_cents: bigint | null;
  baseline_as_of_date: string | null;
  legacy_prefix_code: string;
  raw_amount_text: string;
  raw_sign_date_text: string;
  missing_fields_json: string;
  cross_ref_source: string;
  is_reversal: number;
  synthetic_no_flag: number;
  signing_org_id: number | null;
  signing_subject_org_id: number | null;
  legal_entity_org_id: number | null;
  historical_legal_entity_org_id: number | null;
  is_internal_group_tx: number;
  internal_group_agreement_key: string;
  counterparty_contract_id: number | null;
  co_managed_org_id: number | null;
  currency_struct_status: 'single' | 'structured_multi' | 'partial_unstructured';
  legacy_raw_no: string;
  no_exempt_reason: string;
  foreign_amount_text: string;
}

/** 合同编号规范化:NFKC、去空白、大写。 */
export function normalizeContractNo(no: string): string {
  return no.normalize('NFKC').replace(/\s+/g, '').toUpperCase();
}

export const currentCents = (c: Pick<ContractRow, 'original_cents' | 'approved_change_cents'>) => BigInt(c.original_cents) + BigInt(c.approved_change_cents);

function readRow(db: DB, id: number): ContractRow | undefined {
  const r = db.prepare('SELECT * FROM ct_contract WHERE id = ?').safeIntegers(true).get(id) as Record<string, unknown> | undefined;
  return r ? normalizeRow(r) : undefined;
}
function normalizeRow(r: Record<string, unknown>): ContractRow {
  const n = (v: unknown) => (v === null || v === undefined ? null : Number(v));
  return {
    ...(r as unknown as ContractRow), id: Number(r.id), org_id: Number(r.org_id), project_id: n(r.project_id), supplier_id: n(r.supplier_id),
    plan_item_id: n(r.plan_item_id), source_income_contract_id: n(r.source_income_contract_id), parent_contract_id: n(r.parent_contract_id),
    procurement_record_id: n(r.procurement_record_id),
    signing_org_id: n(r.signing_org_id), signing_subject_org_id: n(r.signing_subject_org_id),
    legal_entity_org_id: n(r.legal_entity_org_id), historical_legal_entity_org_id: n(r.historical_legal_entity_org_id),
    counterparty_contract_id: n(r.counterparty_contract_id), co_managed_org_id: n(r.co_managed_org_id),
    is_procurement: Number(r.is_procurement ?? 1), is_important: Number(r.is_important ?? 0),
    is_emergency: Number(r.is_emergency ?? 0), external_no_exempt: Number(r.external_no_exempt ?? 0),
    is_reversal: Number(r.is_reversal ?? 0), synthetic_no_flag: Number(r.synthetic_no_flag ?? 0),
    is_internal_group_tx: Number(r.is_internal_group_tx ?? 0),
    our_signatory_is_legal_rep: n(r.our_signatory_is_legal_rep), counterparty_signatory_is_legal_rep: n(r.counterparty_signatory_is_legal_rep),
    is_triple_major: Number(r.is_triple_major ?? 0), is_gov_procurement: Number(r.is_gov_procurement ?? 0),
    response_docs_complete: n(r.response_docs_complete), credit_checked: n(r.credit_checked),
    deliverable_submitted: n(r.deliverable_submitted), final_accepted: Number(r.final_accepted ?? 0),
    has_warranty: Number(r.has_warranty ?? 0), warranty_months: n(r.warranty_months),
    import_id: n(r.import_id), version: Number(r.version), created_by_user_id: n(r.created_by_user_id),
  };
}

/** 读取范围内合同;不存在或范围外 404。 */
export function visibleContract(db: DB, id: number): ContractRow {
  const row = readRow(db, id);
  if (!row || !orgInScope(currentOrgScope(db), row.org_id)) throw notVisible('合同');
  return row;
}

export function assertActive(c: ContractRow, what: string): void {
  if (c.status !== 'active') throw conflict('CONTRACT_STATE', `合同${CONTRACT_STATUS_TEXT[c.status]},不能${what}`);
}
const CONTRACT_STATUS_TEXT: Record<ContractStatus, string> = { active: '进行中', suspended: '已中止', closed: '已完成', terminated: '已终止', voided: '已作废' };

function assertVersion(c: ContractRow, expected: number): void {
  if (c.version !== expected) throw conflict('VERSION_CONFLICT', '合同已被其他人修改,请刷新后重试', { currentVersion: c.version });
}

export function bump(db: DB, id: number): void {
  db.prepare('UPDATE ct_contract SET version = version + 1, updated_at = ? WHERE id = ?').run(nowIso(), id);
}

export function recordEvent(db: DB, contractId: number, eventType: string, detail: Record<string, unknown> = {}, stages: { from?: ContractStage | null; to?: ContractStage | null } = {}): void {
  db.prepare('INSERT INTO ct_event (contract_id, event_type, from_stage, to_stage, detail_json, actor_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
    .run(contractId, eventType, stages.from ?? null, stages.to ?? null, JSON.stringify(detail), currentAuth()?.userId ?? null, nowIso());
  writeLog(db, `contract.${eventType}`, 'ct_contract', contractId, { ...detail, ...(stages.from || stages.to ? { fromStage: stages.from ?? null, toStage: stages.to ?? null } : {}) });
}

const userName = (db: DB, id: number | null): string | null =>
  id === null ? null : (db.prepare('SELECT display_name FROM app_user WHERE id = ?').get(id) as { display_name: string } | undefined)?.display_name ?? `#${id}`;

/* ================= DTO ================= */

function toDto(db: DB, c: ContractRow): ContractDto {
  const orgNameById = (oid: number | null | undefined) =>
    oid == null ? null : ((db.prepare('SELECT name FROM org WHERE id = ?').get(oid) as { name: string } | undefined)?.name ?? `#${oid}`);
  const orgName = orgNameById(c.org_id) ?? `#${c.org_id}`;
  const project = c.project_id ? db.prepare('SELECT code, name FROM md_project WHERE id = ?').get(c.project_id) as { code: string; name: string } | undefined : undefined;
  const supplier = c.supplier_id ? db.prepare('SELECT name FROM md_supplier WHERE id = ?').get(c.supplier_id) as { name: string } | undefined : undefined;
  const srcIncome = c.source_income_contract_id
    ? db.prepare('SELECT contract_no, name FROM ct_contract WHERE id = ?').get(c.source_income_contract_id) as { contract_no: string; name: string } | undefined
    : undefined;
  let missingFields: string[] = [];
  try {
    const parsedMissing = JSON.parse(c.missing_fields_json || '[]');
    if (Array.isArray(parsedMissing)) missingFields = parsedMissing.map(String);
  } catch {
    missingFields = [];
  }
  const currencyLines = (db.prepare('SELECT * FROM ct_contract_currency_line WHERE contract_id = ? ORDER BY line_no ASC').safeIntegers(true).all(c.id) as Record<string, unknown>[]).map(
    (cl): ContractCurrencyLineDto => ({
      lineNo: Number(cl.line_no),
      currency: String(cl.currency),
      amount: centsToDecimalString(cl.amount_cents as bigint),
      amountRole: cl.amount_role as ContractCurrencyLineDto['amountRole'],
      fxRate: cl.fx_rate_scaled == null ? null : formatScaled(cl.fx_rate_scaled as bigint, RATIO_SCALE),
      fxRateDate: (cl.fx_rate_date as string | null) ?? null,
      fxRateSource: String(cl.fx_rate_source ?? ''),
    }),
  );
  const counts = db.prepare(`SELECT
      (SELECT COUNT(*) FROM ct_review WHERE contract_id = ? AND status = 'submitted') AS reviews,
      (SELECT COUNT(*) FROM ct_change WHERE contract_id = ? AND status = 'submitted') AS changes,
      (SELECT COUNT(*) FROM ct_payment WHERE contract_id = ? AND status IN ('submitted','approved')) AS payments,
      (SELECT COUNT(*) FROM ct_settlement WHERE contract_id = ? AND status = 'submitted') AS settlements,
      (SELECT COUNT(*) FROM ct_receipt WHERE contract_id = ? AND status IN ('submitted','approved')) AS receipts`).get(c.id, c.id, c.id, c.id, c.id) as {
        reviews: number; changes: number; payments: number; settlements: number; receipts: number;
      };
  const current = currentCents(c);
  const tierAmount = c.pricing_mode === 'unit_price' && BigInt(c.original_cents) === 0n && c.estimated_ceiling_cents != null
    ? BigInt(c.estimated_ceiling_cents)
    : current;
  return {
    legalCategory:c.legal_category, partyRole:c.party_role, signingEntityLevel:c.signing_entity_level, isProcurement:!!c.is_procurement, procurementTarget:c.procurement_target, procurementMethod:c.procurement_method, procurementTier:procurementTier(!!c.is_procurement,c.procurement_target,tierAmount,c.procurement_method), isImportant:!!c.is_important,
    id: c.id, contractNo: c.contract_no, name: c.name, contractType: c.contract_type, orgId: c.org_id, orgName,
    projectId: c.project_id, projectCode: project?.code ?? null, projectName: project?.name ?? null, supplierId: c.supplier_id, supplierName: supplier?.name ?? null,
    originalAmount: centsToDecimalString(c.original_cents), approvedChange: centsToDecimalString(c.approved_change_cents), currentAmount: centsToDecimalString(current),
    paidAmount: centsToDecimalString(c.paid_cents), paymentRate: ratioString(c.paid_cents, current),
    paymentCapRatio: c.payment_cap_ratio_scaled === null ? null : formatScaled(c.payment_cap_ratio_scaled, RATIO_SCALE),
    stage: c.stage, status: c.status, statusReason: c.status_reason, signDate: c.sign_date, effectiveDate: c.effective_date, source: c.source, version: c.version,
    pendingReviews: counts.reviews, pendingChanges: counts.changes, openPayments: counts.payments, createdAt: c.created_at, updatedAt: c.updated_at,
    pendingSettlements: counts.settlements, openReceipts: counts.receipts,
    direction: c.direction, pricingMode: c.pricing_mode, unitPriceDesc: c.unit_price_desc,
    estimatedCeilingAmount: c.estimated_ceiling_cents === null ? null : centsToDecimalString(c.estimated_ceiling_cents),
    currency: c.currency, exchangeRate: c.exchange_rate_scaled === null ? null : formatScaled(c.exchange_rate_scaled, RATIO_SCALE),
    reportCategory: c.report_category, summaryText: c.summary_text, remark: c.remark,
    outOfPlanApprovedDate: c.out_of_plan_approved_date ?? null,
    planItemId: c.plan_item_id, budgetType: c.budget_type, isEmergency: !!c.is_emergency, emergencyStartDate: c.emergency_start_date,
    fundingSource: c.funding_source, fundingSourceDetail: c.funding_source_detail,
    sourceIncomeContractId: c.source_income_contract_id, sourceIncomeContractNo: srcIncome?.contract_no ?? null, sourceIncomeContractName: srcIncome?.name ?? null,
    parentContractId: c.parent_contract_id, externalNoExempt: !!c.external_no_exempt,
    counterpartyNames: c.counterparty_names, undertakerName: c.undertaker_name, undertakerDept: c.undertaker_dept,
    ourSignatoryName: c.our_signatory_name, ourSignatoryTitle: c.our_signatory_title,
    ourSignatoryIsLegalRep: c.our_signatory_is_legal_rep === null ? null : !!c.our_signatory_is_legal_rep,
    counterpartySignatoryName: c.counterparty_signatory_name, counterpartySignatoryTitle: c.counterparty_signatory_title,
    counterpartySignatoryIsLegalRep: c.counterparty_signatory_is_legal_rep === null ? null : !!c.counterparty_signatory_is_legal_rep,
    entrustReason: c.entrust_reason, isTripleMajor: !!c.is_triple_major,
    decisionMethod: c.decision_method, decisionMethodOther: c.decision_method_other,
    meetingType: c.meeting_type, meetingTypeOther: c.meeting_type_other,
    finalApproverName: c.final_approver_name, finalApproverTitle: c.final_approver_title,
    isGovProcurement: !!c.is_gov_procurement, procurementMethodOther: c.procurement_method_other, procurementPlanText: c.procurement_plan_text,
    procurementStartDate: c.procurement_start_date, supplierConfirmDate: c.supplier_confirm_date,
    responseDocsComplete: c.response_docs_complete === null ? null : !!c.response_docs_complete,
    creditChecked: c.credit_checked === null ? null : !!c.credit_checked,
    bidAwardAmount: c.bid_award_cents === null ? null : centsToDecimalString(c.bid_award_cents),
    acquisitionMethod: c.acquisition_method, acquisitionMethodOther: c.acquisition_method_other,
    tenderBodyType: c.tender_body_type, consortiumMembers: c.consortium_members,
    deptReviewerName: c.dept_reviewer_name, relatedMgmtDepts: c.related_mgmt_depts, relatedMgmtReviewers: c.related_mgmt_reviewers,
    unitApproverName: c.unit_approver_name, unitApproverTitle: c.unit_approver_title, farmerWageAccount: c.farmer_wage_account,
    termType: c.term_type, termStartDate: c.term_start_date, termEndDate: c.term_end_date, termConditionText: c.term_condition_text,
    deliverableSubmitted: c.deliverable_submitted === null ? null : !!c.deliverable_submitted,
    finalAccepted: !!c.final_accepted, hasWarranty: !!c.has_warranty, warrantyMonths: c.warranty_months,
    warrantyRetentionRatio: c.warranty_retention_ratio_scaled === null ? null : formatScaled(c.warranty_retention_ratio_scaled, RATIO_SCALE),
    settledGrossAmount: centsToDecimalString(c.settled_gross_cents), settledNetAmount: centsToDecimalString(c.settled_net_cents),
    receivedAmount: centsToDecimalString(c.received_cents), receiptRate: ratioString(c.received_cents, current),
    distributionStatus: c.distribution_status, distributedAt: c.distributed_at, companyFiledAt: c.company_filed_at,
    archiveStatus: c.archive_status, archiveCheckedAt: c.archive_checked_at, archiveTransferredAt: c.archive_transferred_at,
    archiveTransferNo: c.archive_transfer_no, archiveDeferNote: c.archive_defer_note,
    origin: c.origin,
    migrationMode: c.migration_mode,
    duplicateConflictGroup: c.duplicate_conflict_group || '',
    amountFactSource: c.amount_fact_source,
    clueVoucherDebitAmount: c.clue_voucher_debit_cents == null ? null : centsToDecimalString(c.clue_voucher_debit_cents),
    legacySettledBaselineAmount: c.legacy_settled_baseline_cents == null ? null : centsToDecimalString(c.legacy_settled_baseline_cents),
    legacyInvoicedBaselineAmount: c.legacy_invoiced_baseline_cents == null ? null : centsToDecimalString(c.legacy_invoiced_baseline_cents),
    legacyRevenueBaselineAmount: c.legacy_revenue_baseline_cents == null ? null : centsToDecimalString(c.legacy_revenue_baseline_cents),
    baselineAsOfDate: c.baseline_as_of_date ?? null,
    signingOrgId: c.signing_org_id,
    signingOrgName: orgNameById(c.signing_org_id),
    signingSubjectOrgId: c.signing_subject_org_id,
    signingSubjectOrgName: orgNameById(c.signing_subject_org_id),
    legalEntityOrgId: c.legal_entity_org_id,
    legalEntityOrgName: orgNameById(c.legal_entity_org_id),
    historicalLegalEntityOrgId: c.historical_legal_entity_org_id,
    historicalLegalEntityOrgName: orgNameById(c.historical_legal_entity_org_id),
    isInternalGroupTx: !!c.is_internal_group_tx,
    internalGroupAgreementKey: c.internal_group_agreement_key || '',
    counterpartyContractId: c.counterparty_contract_id,
    coManagedOrgId: c.co_managed_org_id,
    coManagedOrgName: orgNameById(c.co_managed_org_id),
    currencyStructStatus: c.currency_struct_status,
    currencyLines,
    legacyRawNo: c.legacy_raw_no || '',
    legacyPrefixCode: c.legacy_prefix_code || '',
    rawAmountText: c.raw_amount_text || '',
    rawSignDateText: c.raw_sign_date_text || '',
    missingFields,
    noExemptReason: c.no_exempt_reason || '',
    foreignAmountText: c.foreign_amount_text || '',
    isReversal: !!c.is_reversal,
    syntheticNoFlag: !!c.synthetic_no_flag,
    changeOrMode: getSetting<'min' | 'max'>(db, 'contract.change_or_mode') === 'max' ? 'max' : 'min',
  };
}

export function nextStage(stage: ContractStage, hasWarranty = false): ContractStage | null {
  if (stage === 'settlement') return hasWarranty ? 'warranty' : 'closed';
  if (stage === 'warranty') return 'closed';
  if (stage === 'closed') return null;
  const i = CONTRACT_STAGES.indexOf(stage);
  return i >= 0 && i < CONTRACT_STAGES.length - 1 ? CONTRACT_STAGES[i + 1] : null;
}

const hasDoc = (db: DB, contractId: number, ...types: ContractDocType[]) =>
  !!db.prepare(`SELECT 1 FROM ct_document WHERE contract_id = ? AND doc_type IN (${types.map(() => '?').join(',')}) LIMIT 1`).get(contractId, ...types);
const hasEvidence = (db: DB, contractId: number, ...kinds: EvidenceKind[]) =>
  !!db.prepare(`SELECT 1 FROM ct_document WHERE contract_id = ? AND evidence_kind IN (${kinds.map(() => '?').join(',')}) LIMIT 1`).get(contractId, ...kinds);

/** 离开当前阶段(推进到下一阶段)的阻断项。 */
export function computeBlockers(db: DB, c: ContractRow): BlockerDto[] {
  const out: BlockerDto[] = [];
  const add = (code: string, message: string) => out.push({ code, message });
  if (c.status !== 'active') add('CONTRACT_NOT_ACTIVE', `合同${CONTRACT_STATUS_TEXT[c.status]}`);
  switch (c.stage) {
    case 'initiation':
      if (c.direction === 'expense' && c.budget_type !== 'lump_sum_pool' && !c.project_id) add('PROJECT_REQUIRED', '需求立项需关联项目');
      if (!c.contract_type) add('TYPE_REQUIRED', '需求立项需填写合同类型');
      if (c.direction === 'expense' && c.funding_source === 'income_contract' && !c.source_income_contract_id) {
        add('SOURCE_INCOME_REQUIRED', '资金来源为“收入合同”时须绑定关联收入合同');
      }
      if (c.direction === 'income' && isDirectPowerStationOrg(db, c.org_id) && c.signing_entity_level !== 'company') {
        add('DIRECT_STATION_INCOME_ENTITY', '直属电站资金进项合同须以公司名义签订');
      }
      break;
    case 'procurement':
      if (c.direction === 'expense' && c.is_procurement && c.procurement_tier !== 'exempt_small' && !hasDoc(db, c.id, 'procurement')) {
        add('PROCUREMENT_DOC', '招采准备需上传招采文件');
      }
      if (c.procurement_start_date && c.supplier_confirm_date && c.procurement_start_date > c.supplier_confirm_date) {
        add('PROCUREMENT_DATE_CONFLICT', '开始实施采购时间不能晚于供应商确定时间');
      }
      break;
    case 'drafting':
      if (c.pricing_mode === 'lump_sum') {
        if (BigInt(c.original_cents) <= 0n) add('AMOUNT_REQUIRED', '合同起草需填写大于 0 的合同金额');
        if (c.bid_award_cents !== null && BigInt(c.original_cents) > BigInt(c.bid_award_cents)) {
          add('BID_AWARD_EXCEEDED', '合同原始金额不能高于审定中标金额');
        }
      } else if (!c.unit_price_desc.trim()) {
        add('UNIT_PRICE_DESC_REQUIRED', '单价合同起草需填写单价及计价标准说明');
      }
      if (!c.supplier_id && !c.counterparty_names.trim()) add('SUPPLIER_REQUIRED', '合同起草需指定供应商');
      if (!hasDoc(db, c.id, 'contract_text')) add('CONTRACT_TEXT_DOC', '合同起草需上传合同正文');
      if (c.term_type === 'fixed' && (!c.term_start_date || !c.term_end_date || c.term_start_date > c.term_end_date)) {
        add('TERM_DATES_INVALID', '固定期限合同须填写有效的履约起止日期');
      }
      if (c.term_type === 'conditional' && !c.term_condition_text.trim()) {
        add('TERM_CONDITION_REQUIRED', '条件期限合同须填写履约期限条件');
      }
      break;
    case 'approval': {
      try { assertContractFunding(db, c); } catch (err) { if (!(err instanceof AppError)) throw err; add(err.code, err.message); }
      const latestText = db.prepare("SELECT MAX(id) AS id FROM ct_document WHERE contract_id = ? AND doc_type = 'contract_text'").get(c.id) as { id: number | null };
      const approved = db.prepare("SELECT document_id,legal_run_id FROM ct_review WHERE contract_id = ? AND status = 'approved' ORDER BY id DESC LIMIT 1").get(c.id) as { document_id: number; legal_run_id: number|null } | undefined;
      if (!approved) add('REVIEW_APPROVED', '审批签署需合同审核通过');
      else if (latestText.id !== approved.document_id) add('REVIEW_OUTDATED', '合同正文在审核通过后有更新,需重新提交审核');
      if (legalEnabled(db,c)) {
        const bound=approved?.legal_run_id ? db.prepare('SELECT * FROM ct_legal_run WHERE id=? AND contract_id=?').get(approved.legal_run_id,c.id) : undefined;
        if(!legalRunCurrent(db,bound,legalSnapshot(db,c.id).fingerprint)) add('LEGAL_REVIEW_OUTDATED','智能法审缺失或合同正文、要素、依据已变化，需重新审核');
        if(legalSigningDateConflict(db,c)) add('DATE_SEQUENCE_CONFLICT','签订、生效及履行日期顺序冲突，请先更正日期');
      }
      if ((c.procurement_start_date && c.sign_date && c.procurement_start_date > c.sign_date) ||
          (c.supplier_confirm_date && c.sign_date && c.supplier_confirm_date > c.sign_date)) {
        add('PROCUREMENT_DATE_CONFLICT', '采购时间（开始采购/确定供应商）不能晚于签署日期');
      }
      if (c.direction === 'income' && isDirectPowerStationOrg(db, c.org_id) && c.signing_entity_level !== 'company') {
        add('DIRECT_STATION_INCOME_ENTITY', '直属电站资金进项合同须以公司名义签订');
      }
      if (!c.sign_date) add('SIGN_DATE', '审批签署需填写签订日期');
      if (!c.our_signatory_name.trim() || !c.our_signatory_title.trim() || c.our_signatory_is_legal_rep === null) add('OUR_SIGNATORY_REQUIRED', '须填写我方签署人姓名、身份并确认是否法定代表人');
      if (c.direction === 'expense' && c.counterparty_signatory_is_legal_rep === null) add('COUNTERPARTY_SIGNATORY_REQUIRED', '须确认对方签署人是否法定代表人');
      if (c.our_signatory_is_legal_rep === 0 && !hasEvidence(db, c.id, 'our_signatory_auth')) {
        add('OUR_SIGNATORY_AUTH_REQUIRED', '我方签署人非法定代表人，须上传我方《授权委托书》');
      }
      if (c.direction === 'expense' && c.counterparty_signatory_is_legal_rep === 0 && !hasEvidence(db, c.id, 'counterparty_signatory_auth')) {
        add('COUNTERPARTY_SIGNATORY_AUTH_REQUIRED', '对方签署人非法定代表人，须上传对方《授权委托书》');
      }
      if (!hasDoc(db, c.id, 'signed')) add('SIGNED_DOC', '审批签署需上传签署件');
      break;
    }
    case 'performance':
      if (!hasDoc(db, c.id, 'performance', 'acceptance')) add('PERFORMANCE_DOC', '履约执行需上传履约记录或验收文件');
      if (c.deliverable_submitted === 0) add('DELIVERABLE_NOT_SUBMITTED', '尚未确认按约定提交成果');
      break;
    case 'settlement': {
      const open = db.prepare(`SELECT
          (SELECT COUNT(*) FROM ct_change WHERE contract_id = ? AND status = 'submitted') AS changes,
          (SELECT COUNT(*) FROM ct_settlement WHERE contract_id = ? AND status = 'submitted') AS settlements,
          (SELECT COUNT(*) FROM ct_payment WHERE contract_id = ? AND status IN ('submitted','approved')) AS payments,
          (SELECT COUNT(*) FROM ct_receipt WHERE contract_id = ? AND status IN ('submitted','approved')) AS receipts`).get(c.id, c.id, c.id, c.id) as {
            changes: number; settlements: number; payments: number; receipts: number;
          };
      if (open.changes) add('OPEN_CHANGES', `有 ${open.changes} 项变更未复核`);
      if (open.settlements) add('OPEN_SETTLEMENTS', `有 ${open.settlements} 项结算单未复核`);
      if (open.payments) add('OPEN_PAYMENTS', `有 ${open.payments} 笔付款未结`);
      if (open.receipts) add('OPEN_RECEIPTS', `有 ${open.receipts} 笔收款未结`);
      if (c.pricing_mode === 'lump_sum' && BigInt(c.paid_cents) > currentCents(c)) add('OVERPAID', '已付超过当前金额');
      if (c.pricing_mode === 'unit_price' && c.estimated_ceiling_cents !== null && BigInt(c.paid_cents) > BigInt(c.estimated_ceiling_cents)) {
        add('OVERPAID', '已付超过估算上限');
      }
      if (!hasDoc(db, c.id, 'acceptance')) add('ACCEPTANCE_DOC', '归档前需上传验收文件');
      if (!c.final_accepted) add('FINAL_ACCEPTANCE_REQUIRED', '须确认最终验收通过');
      if (!['checked', 'transferred'].includes(c.archive_status)) add('CONTRACT_ARCHIVE_INCOMPLETE', '须完成档案完整性验收');
      if (!db.prepare("SELECT 1 FROM ct_settlement WHERE contract_id = ? AND settlement_kind = 'final' AND status = 'approved'").get(c.id)) add('FINAL_SETTLEMENT_REQUIRED', '须完成并批准最终/竣工结算');
      if (!contractHasWarranty(db, c)) out.push(...closureBlockers(db, c));
      break;
    }
    case 'warranty': {
      out.push(...closureBlockers(db, c));
      try { assertWarrantyReleased(db, c.id); } catch (err) {
        if (!(err instanceof AppError)) throw err;
        add(err.code, err.message);
      }
      break;
    }
    case 'closed':
      add('ARCHIVED', '合同已履约完结');
      break;
  }
  return out;
}

function closureBlockers(db: DB, c: ContractRow): BlockerDto[] {
  const out: BlockerDto[] = [];
  const add = (code: string, message: string) => out.push({ code, message });
  for (const [table, code, label, states] of [
    ['ct_change', 'OPEN_CHANGES', '变更', "'submitted'"], ['ct_settlement', 'OPEN_SETTLEMENTS', '结算单', "'submitted'"],
    ['ct_payment', 'OPEN_PAYMENTS', '付款', "'submitted','approved'"], ['ct_receipt', 'OPEN_RECEIPTS', '收款', "'submitted','approved'"],
  ]) {
    if (db.prepare(`SELECT 1 FROM ${table} WHERE contract_id = ? AND status IN (${states}) LIMIT 1`).get(c.id)) add(code, `尚有待处理${label}`);
  }
  if (!c.final_accepted || !hasDoc(db, c.id, 'acceptance')) add('FINAL_ACCEPTANCE_REQUIRED', '须完成最终验收并上传验收文件');
  if (!db.prepare("SELECT 1 FROM ct_settlement WHERE contract_id = ? AND settlement_kind = 'final' AND status = 'approved'").get(c.id)) add('FINAL_SETTLEMENT_REQUIRED', '须批准最终/竣工结算');
  if (c.archive_status !== 'transferred' && !(c.archive_status === 'checked' && c.archive_defer_note?.trim())) add('ARCHIVE_TRANSFER_REQUIRED', '须移交档案，或由管理员登记待批次移交说明');
  const due = (db.prepare(`SELECT COALESCE(SUM(net_payable_cents + deduct_prepayment_cents + deduct_retention_cents), 0) AS s FROM ct_settlement WHERE contract_id = ? AND status = 'approved'`).safeIntegers(true).get(c.id) as { s: bigint }).s;
  const recordedRetention = (db.prepare('SELECT retention_cents FROM ct_warranty WHERE contract_id = ?').safeIntegers(true).get(c.id) as { retention_cents: bigint } | undefined)?.retention_cents ?? 0n;
  const settledRetention = (db.prepare("SELECT COALESCE(SUM(deduct_retention_cents),0) AS s FROM ct_settlement WHERE contract_id = ? AND status = 'approved'").safeIntegers(true).get(c.id) as { s: bigint }).s;
  if (recordedRetention > settledRetention) add('WARRANTY_RETENTION_MISMATCH', '质保台账金额超过已批准结算保留金，须先核对质保金记录');
  if (BigInt(c.direction === 'income' ? c.received_cents : c.paid_cents) !== due) add('CONTRACT_NOT_CLEARED', `款项尚未按最终结算结清（应清 ${centsToDecimalString(due)}）`);
  if (db.prepare("SELECT 1 FROM ct_guarantee WHERE contract_id = ? AND (status IN ('active','claimed') OR (deposit_cents > 0 AND status <> 'returned')) LIMIT 1").get(c.id)) add('ACTIVE_GUARANTEES_UNRETURNED', '尚有保函/押金未退还或清理');
  if (db.prepare("SELECT 1 FROM ct_dispute WHERE contract_id = ? AND stage <> 'closed' LIMIT 1").get(c.id)) add('OPEN_DISPUTES', '尚有未结案纠纷');
  return out;
}

function documents(db: DB, contractId: number): ContractDocumentDto[] {
  return (db.prepare(`SELECT d.*, f.sha256, f.size_bytes FROM ct_document d JOIN file_object f ON f.id = d.file_object_id WHERE d.contract_id = ? ORDER BY d.id`).all(contractId) as
    { id: number; doc_type: ContractDocType; evidence_kind: EvidenceKind|null; change_id: number|null; name: string; sha256: string; size_bytes: number; uploaded_by_user_id: number | null; uploaded_at: string }[])
    .map((d) => ({ id: d.id, evidenceKind:d.evidence_kind, changeId: d.change_id ?? null, docType: d.doc_type, name: d.name, fileSha256: d.sha256, sizeBytes: d.size_bytes, uploadedBy: userName(db, d.uploaded_by_user_id), uploadedAt: d.uploaded_at }));
}

type ReviewCols = { reviewed_by_user_id: number | null; reviewed_at: string | null; review_comment: string | null; exception_reason: string | null; self_review: number; submitted_by_user_id: number | null; submitted_at: string };
const reviewPart = (db: DB, r: ReviewCols) => ({
  submittedBy: userName(db, r.submitted_by_user_id), submittedAt: r.submitted_at, reviewedBy: userName(db, r.reviewed_by_user_id), reviewedAt: r.reviewed_at,
  comment: r.review_comment, exceptionReason: r.exception_reason, selfReview: r.self_review === 1,
});

export function getContractDetail(db: DB, id: number): ContractDetailDto {
  const c = visibleContract(db, id);
  const docs = documents(db, id);
  const docName = new Map(docs.map((d) => [d.id, d.name]));
  const reviews = (db.prepare('SELECT * FROM ct_review WHERE contract_id = ? ORDER BY id').all(id) as (ReviewCols & { id: number; document_id: number; status: ContractReviewDto['status']; submit_note: string; legal_run_id: number|null; override_high_risk: number })[])
    .map((r) => ({ id: r.id, legalRunId:r.legal_run_id, overrideHighRisk:!!r.override_high_risk, documentId: r.document_id, documentName: docName.get(r.document_id) ?? '', status: r.status, note: r.submit_note, ...reviewPart(db, r) }));
  const changes = (db.prepare('SELECT * FROM ct_change WHERE contract_id = ? ORDER BY id').safeIntegers(true).all(id) as Record<string, unknown>[])
    .map((r): ContractChangeDto => ({
      ...reviewPart(db, { ...(r as unknown as ReviewCols), reviewed_by_user_id: num(r.reviewed_by_user_id), submitted_by_user_id: num(r.submitted_by_user_id), self_review: Number(r.self_review) }),
      id: Number(r.id), delta: centsToDecimalString(r.delta_cents as bigint), reason: String(r.reason),
      evidenceDocumentId: Number(r.evidence_document_id), status: r.status as ContractChangeDto['status'],
      changeKind: (r.change_kind as ChangeKind | undefined) ?? 'change',
      changeMatter: String(r.change_matter ?? ''),
      orgRootId: num(r.org_root_id),
      involvesBizOrEntityChange: Number(r.involves_biz_or_entity_change ?? 0) === 1,
      involvesTechChange: Number(r.involves_tech_change ?? 0) === 1,
      isIndependentDelegable: Number(r.is_independent_delegable ?? 0) === 1,
      decisionMethod: (r.decision_method as ContractDecisionMethod | null | undefined) ?? null,
      decisionMethodOther: String(r.decision_method_other ?? ''),
      meetingType: (r.meeting_type as ContractMeetingType | null | undefined) ?? null,
      meetingTypeOther: String(r.meeting_type_other ?? ''),
      finalApproverName: String(r.final_approver_name ?? ''),
      finalApproverTitle: String(r.final_approver_title ?? ''),
      requiredApprovalTier: (r.required_approval_tier as ChangeApprovalTier | undefined) ?? 'undertaker_unit',
      actualApprovalTier: (r.actual_approval_tier as ChangeApprovalTier | null | undefined) ?? null,
      supplementNo: (r.supplement_no as string | null | undefined) ?? null,
      hasDispute: Number(r.has_dispute ?? 0) === 1,
      techReviewAppliedAt: (r.tech_review_applied_at as string | null | undefined) ?? null,
      techReviewRepliedAt: (r.tech_review_replied_at as string | null | undefined) ?? null,
      techSpecialAuditDocId: num(r.tech_special_audit_doc_id),
      outOfPlanDocId: num(r.out_of_plan_doc_id),
      guarantorConsentDocId: num(r.guarantor_consent_doc_id),
      disciplineFiledAt: (r.discipline_filed_at as string | null | undefined) ?? null,
    }));
  const payments = (db.prepare('SELECT * FROM ct_payment WHERE contract_id = ? ORDER BY id').safeIntegers(true).all(id) as Record<string, unknown>[]).map((r): ContractPaymentDto => ({
    ...reviewPart(db, { ...(r as unknown as ReviewCols), reviewed_by_user_id: num(r.reviewed_by_user_id), submitted_by_user_id: num(r.submitted_by_user_id), self_review: Number(r.self_review) }),
    id: Number(r.id), kind: r.kind as ContractPaymentDto['kind'], nodeName: String(r.node_name), amount: centsToDecimalString(r.amount_cents as bigint),
    settlementId: num(r.settlement_id), paymentType: (r.payment_type as ContractPaymentType | undefined) ?? 'progress',
    currency: (r.currency as string | undefined) ?? '人民币',
    approvalTier: (r.approval_tier as ContractPaymentApprovalTier | null | undefined) ?? null,
    approverName: (r.approver_name as string | undefined) ?? '', approverTitle: (r.approver_title as string | undefined) ?? '',
    approvalDocId: num(r.approval_doc_id), isFarmerWageTransfer: Number(r.is_farmer_wage_transfer ?? 0) === 1,
    plannedDate: (r.planned_date as string | null) ?? null, evidenceDocumentId: num(r.evidence_document_id), status: r.status as ContractPaymentDto['status'],
    paidDate: (r.paid_date as string | null) ?? null, voucherNo: (r.voucher_no as string | null) ?? null, invoiceDocumentId: num(r.invoice_document_id),
  }));
  const settlements = listContractSettlements(db, id);
  const receipts = (db.prepare('SELECT * FROM ct_receipt WHERE contract_id = ? ORDER BY id').safeIntegers(true).all(id) as Record<string, unknown>[])
    .map((r): ContractReceiptDto => ({
      ...reviewPart(db, { ...(r as unknown as ReviewCols), reviewed_by_user_id: num(r.reviewed_by_user_id), submitted_by_user_id: num(r.submitted_by_user_id), self_review: Number(r.self_review) }),
      id: Number(r.id), kind: r.kind as ContractReceiptDto['kind'], settlementId: num(r.settlement_id),
      nodeName: String(r.node_name), currency: String(r.currency ?? '人民币'), amount: centsToDecimalString(r.amount_cents as bigint),
      plannedDate: (r.planned_date as string | null) ?? null, invoiceDocumentId: num(r.invoice_document_id),
      status: r.status as ContractReceiptDto['status'], receivedDate: (r.received_date as string | null) ?? null,
      voucherNo: (r.voucher_no as string | null) ?? null, receivedBy: userName(db, num(r.received_by_user_id)),
      receivedAt: (r.received_at as string | null) ?? null,
    }));
  const handovers = (db.prepare('SELECT * FROM ct_undertaker_handover WHERE contract_id = ? ORDER BY id').all(id) as {
    id: number; from_undertaker: string; to_undertaker: string; to_dept: string; reason: string; left_post_date: string | null; handover_date: string; actor_user_id: number | null; created_at: string;
  }[]).map((h): ContractUndertakerHandoverDto => ({
    id: h.id, fromUndertaker: h.from_undertaker, toUndertaker: h.to_undertaker, toDept: h.to_dept,
    reason: h.reason, leftPostDate: h.left_post_date, handoverDate: h.handover_date,
    actor: userName(db, h.actor_user_id), createdAt: h.created_at,
  }));
  const events = (db.prepare('SELECT * FROM ct_event WHERE contract_id = ? ORDER BY id').all(id) as { id: number; event_type: string; from_stage: ContractStage | null; to_stage: ContractStage | null; detail_json: string; actor_user_id: number | null; created_at: string }[])
    .map((e): ContractEventDto => ({ id: e.id, eventType: e.event_type, fromStage: e.from_stage, toStage: e.to_stage, detail: JSON.parse(e.detail_json), actor: userName(db, e.actor_user_id), createdAt: e.created_at }));
  const guarantees = listContractGuarantees(db, id);
  const warranty = getContractWarranty(db, id);
  const disputes = listContractDisputes(db, id);
  const evaluation = getContractEvaluation(db, id);
  return { ...toDto(db, c), legalReviewEnabled: legalEnabled(db,c), nextStage: c.status === 'active' ? nextStage(c.stage, contractHasWarranty(db, c)) : null, blockers: computeBlockers(db, c), documents: docs, reviews, changes, settlements, payments, receipts, guarantees, warranty, disputes, handovers, evaluation, events };
}
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export function getContract(db: DB, id: number): ContractDto {
  return toDto(db, visibleContract(db, id));
}

/** 与工作台待办计数(report/todo.service.ts)同口径。 */
function todoCondition(db: DB, todo: ContractTodo): { sql: string; params: unknown[] } {
  const today = todayUtcDate();
  switch (todo) {
    case 'review': return { sql: "EXISTS (SELECT 1 FROM ct_review x WHERE x.contract_id = ct_contract.id AND x.status = 'submitted')", params: [] };
    case 'change': return { sql: "EXISTS (SELECT 1 FROM ct_change x WHERE x.contract_id = ct_contract.id AND x.status = 'submitted')", params: [] };
    case 'payment': return { sql: "EXISTS (SELECT 1 FROM ct_payment x WHERE x.contract_id = ct_contract.id AND x.status = 'submitted')", params: [] };
    case 'pay': return { sql: "EXISTS (SELECT 1 FROM ct_payment x WHERE x.contract_id = ct_contract.id AND x.status = 'approved')", params: [] };
    case 'settlement': return { sql: "EXISTS (SELECT 1 FROM ct_settlement x WHERE x.contract_id = ct_contract.id AND x.status = 'submitted')", params: [] };
    case 'receipt': return { sql: "EXISTS (SELECT 1 FROM ct_receipt x WHERE x.contract_id = ct_contract.id AND x.status IN ('submitted','approved'))", params: [] };
    case 'distribution': return {
      sql: "ct_contract.sign_date IS NOT NULL AND ct_contract.sign_date <= ? AND ct_contract.distribution_status = 'pending'",
      params: [workingDayCutoffBefore(today, 10, workingCalendar(db))],
    };
    case 'guarantee_warranty': return {
      sql: "(EXISTS (SELECT 1 FROM ct_guarantee g WHERE g.contract_id = ct_contract.id AND g.status = 'active' AND g.expiry_date IS NOT NULL AND g.expiry_date <= ?) OR (ct_contract.has_warranty = 1 AND ct_contract.stage = 'warranty' AND NOT EXISTS (SELECT 1 FROM ct_warranty w WHERE w.contract_id = ct_contract.id AND w.inspection_conclusion = 'passed' AND w.visa_document_id IS NOT NULL) AND EXISTS (SELECT 1 FROM ct_warranty w2 WHERE w2.contract_id = ct_contract.id AND w2.end_date IS NOT NULL AND w2.end_date <= ?)))",
      params: [addCalendarDays(today, 30)!, today],
    };
  }
}

function contractListFilter(db: DB, q: ContractListQuery) {
  const scope = currentOrgScope(db);
  if (q.orgId && !orgInScope(scope, q.orgId)) throw notVisible('组织');
  const sc = scopeFilterSql(scope, 'org_id');
  const where = [sc.sql];
  const params: unknown[] = [...sc.params];
  if (q.status) { where.push('status = ?'); params.push(q.status); }
  if (q.stage) { where.push('stage = ?'); params.push(q.stage); }
  if (q.direction) { where.push('direction = ?'); params.push(q.direction); }
  if (q.pricingMode) { where.push('pricing_mode = ?'); params.push(q.pricingMode); }
  if (q.archiveStatus) { where.push('archive_status = ?'); params.push(q.archiveStatus); }
  if (q.orgId) {
    where.push('org_id IN (WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT o.id FROM org o JOIN sub ON o.parent_id = sub.id) SELECT id FROM sub)');
    params.push(q.orgId);
  }
  if (q.projectId) { where.push('project_id = ?'); params.push(q.projectId); }
  if (q.keyword) { const k = `%${q.keyword.replace(/[%_]/g, '')}%`; where.push('(contract_no LIKE ? OR name LIKE ?)'); params.push(k, k); }
  if (q.todo) {
    const cond = todoCondition(db, q.todo);
    where.push(`status = 'active' AND ${cond.sql}`);
    params.push(...cond.params);
  }
  return { clause: where.join(' AND '), params };
}

export function listContracts(db: DB, q: ContractListQuery = {}): ContractDto[] {
  const { clause, params } = contractListFilter(db, q);
  return (db.prepare(`SELECT * FROM ct_contract WHERE ${clause} ORDER BY updated_at DESC, id DESC LIMIT 500`).safeIntegers(true).all(...params) as Record<string, unknown>[])
    .map((r) => toDto(db, normalizeRow(r)));
}

export function listContractsPage(db: DB, q: ContractListQuery & PageQuery): PageDto<ContractDto> {
  const { clause, params } = contractListFilter(db, q);
  return db.transaction(() => {
    const { total } = db.prepare(`SELECT COUNT(*) AS total FROM ct_contract WHERE ${clause}`).get(...params) as { total: number };
    const page = Math.min(q.page, Math.max(1, Math.ceil(total / q.pageSize)));
    const rows = db.prepare(`SELECT * FROM ct_contract WHERE ${clause} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`)
      .safeIntegers(true).all(...params, q.pageSize, (page - 1) * q.pageSize) as Record<string, unknown>[];
    return { items: rows.map((r) => toDto(db, normalizeRow(r))), total, page, pageSize: q.pageSize };
  })();
}

/** 范围内合同汇总(助手 contract_summary、工作台待办共用)。 */
export function contractSummary(db: DB, q: { orgId?: number; projectId?: number } = {}): ContractSummaryDto {
  const scope = currentOrgScope(db);
  if (q.orgId && !orgInScope(scope, q.orgId)) throw notVisible('组织');
  const sc = scopeFilterSql(scope, 'c.org_id');
  const where = [sc.sql];
  const params: unknown[] = [...sc.params];
  if (q.orgId) {
    where.push('c.org_id IN (WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT o.id FROM org o JOIN sub ON o.parent_id = sub.id) SELECT id FROM sub)');
    params.push(q.orgId);
  }
  if (q.projectId) { where.push('c.project_id = ?'); params.push(q.projectId); }
  const rows = db.prepare(`SELECT c.id, c.status, c.stage, c.direction, c.currency, c.original_cents, c.approved_change_cents, c.paid_cents, c.received_cents FROM ct_contract c WHERE ${where.join(' AND ')}`)
    .safeIntegers(true).all(...params) as { id: bigint; status: ContractStatus; stage: ContractStage; direction: ContractDirection; currency: string; original_cents: bigint; approved_change_cents: bigint; paid_cents: bigint; received_cents: bigint }[];
  const byStatus = Object.fromEntries(CONTRACT_STATUSES.map((s) => [s, 0])) as Record<ContractStatus, number>;
  const byStage = Object.fromEntries(CONTRACT_STAGES.map((s) => [s, 0])) as Record<ContractStage, number>;
  let current = 0n; let paid = 0n;
  let incomeCurrent = 0n; let received = 0n; let foreignCurrencyCount = 0;
  for (const r of rows) {
    byStatus[r.status]++; byStage[r.stage]++;
    if (r.status !== 'voided') {
      if (r.currency !== '人民币') { foreignCurrencyCount++; continue; }
      if (r.direction === 'income') { incomeCurrent += r.original_cents + r.approved_change_cents; received += r.received_cents; }
      else { current += r.original_cents + r.approved_change_cents; paid += r.paid_cents; }
    }
  }
  const ids = rows.map((r) => Number(r.id));
  const pending = { reviews: 0, changes: 0, payments: 0, unpaidApproved: 0 };
  if (ids.length) {
    const inIds = `(${ids.map(() => '?').join(',')})`;
    pending.reviews = (db.prepare(`SELECT COUNT(*) AS n FROM ct_review WHERE status = 'submitted' AND contract_id IN ${inIds}`).get(...ids) as { n: number }).n;
    pending.changes = (db.prepare(`SELECT COUNT(*) AS n FROM ct_change WHERE status = 'submitted' AND contract_id IN ${inIds}`).get(...ids) as { n: number }).n;
    pending.payments = (db.prepare(`SELECT COUNT(*) AS n FROM ct_payment WHERE status = 'submitted' AND contract_id IN ${inIds}`).get(...ids) as { n: number }).n;
    pending.unpaidApproved = (db.prepare(`SELECT COUNT(*) AS n FROM ct_payment WHERE status = 'approved' AND contract_id IN ${inIds}`).get(...ids) as { n: number }).n;
  }
  return {
    count: rows.length, byStatus, byStage,
    currentAmount: centsToDecimalString(current), paidAmount: centsToDecimalString(paid), paymentRate: ratioString(paid, current),
    incomeCurrentAmount: centsToDecimalString(incomeCurrent), receivedAmount: centsToDecimalString(received), receiptRate: ratioString(received, incomeCurrent),
    foreignCurrencyCount, pending,
  };
}

/* ================= 创建 / 修改 ================= */

function assertProject(db: DB, projectId: number, orgId: number): void {
  const p = db.prepare('SELECT org_id, status FROM md_project WHERE id = ?').get(projectId) as { org_id: number; status: string } | undefined;
  if (!p || !orgInScope(currentOrgScope(db), p.org_id)) throw notVisible('项目');
  if (p.status !== 'active') throw new AppError('VALIDATION_FAILED', '项目已停用', 400);
  if (p.org_id !== orgId) throw new AppError('VALIDATION_FAILED', '合同组织须与项目归属组织一致', 400);
}
function assertSupplier(db: DB, supplierId: number): void {
  const s = db.prepare('SELECT status FROM md_supplier WHERE id = ?').get(supplierId) as { status: string } | undefined;
  if (!s) throw notVisible('供应商');
  if (s.status !== 'active') throw new AppError('VALIDATION_FAILED', '供应商已停用', 400);
}
const capScaled = (v: string | null | undefined) => (v == null ? null : parseScaled(v, RATIO_SCALE, { label: '付款上限比例' }));
const rateScaled = (v: string | null | undefined) => (v == null ? null : parseScaled(v, RATIO_SCALE, { label: '参考汇率' }));
const optCents = (v: string | null | undefined, label: string) => {
  if (v == null) return null;
  const c = parseDecimalToCents(v, { label });
  if (c < 0n) throw new AppError('VALIDATION_FAILED', `${label}不能为负`, 400);
  return c;
};

function assertLifecycleConsistency(db: DB, params: {
  selfId?: number;
  orgId: number;
  direction: ContractDirection;
  partyRole: LegalMetadata['partyRole'];
  signingEntityLevel: LegalMetadata['signingEntityLevel'];
  pricingMode: ContractPricingMode;
  originalCents: bigint;
  bidAwardCents: bigint | null;
  fundingSource: ContractFundingSource;
  sourceIncomeContractId: number | null;
  planItemId: number | null;
  parentContractId: number | null;
  procurementStartDate: string | null;
  supplierConfirmDate: string | null;
  signDate: string | null;
  termStartDate: string | null;
  termEndDate: string | null;
}) : void {
  if (params.direction === 'income' && ['buyer', 'employer', 'client'].includes(params.partyRole)) {
    throw new AppError('VALIDATION_FAILED', '收入合同的我方立场应为卖方/承包人/服务方/其他', 400);
  }
  if (params.direction === 'expense' && ['seller', 'contractor', 'provider'].includes(params.partyRole)) {
    throw new AppError('VALIDATION_FAILED', '支出合同的我方立场应为买方/发包人/委托方/其他', 400);
  }
  if (params.direction === 'income' && isDirectPowerStationOrg(db, params.orgId) && params.signingEntityLevel !== 'company') {
    throw conflict('CONTRACT_DIRECT_STATION_ENTITY', '直属水电站资金进项合同须以公司名义（company）签订');
  }
  if (params.direction === 'expense' && params.fundingSource === 'income_contract') {
    if (!params.sourceIncomeContractId) throw new AppError('VALIDATION_FAILED', '资金来源为“收入合同”时须指定关联收入合同', 400);
    const src = db.prepare('SELECT id, org_id, direction, status FROM ct_contract WHERE id = ?').get(params.sourceIncomeContractId) as
      { id: number; org_id: number; direction: string; status: string } | undefined;
    if (!src || !orgInScope(currentOrgScope(db), src.org_id)) throw notVisible('关联收入合同');
    if (src.direction !== 'income' || src.status === 'voided') {
      throw new AppError('VALIDATION_FAILED', '关联的资金来源合同必须为有效收入合同', 400);
    }
  }
  if (params.planItemId) {
    const pi = db.prepare('SELECT org_id FROM plan_item WHERE id = ?').get(params.planItemId) as { org_id: number | null } | undefined;
    if (!pi || (pi.org_id !== null && !orgInScope(currentOrgScope(db), pi.org_id))) throw notVisible('综合计划项');
  }
  if (params.parentContractId) {
    if (params.selfId && params.parentContractId === params.selfId) throw new AppError('VALIDATION_FAILED', '主合同不能指向自身', 400);
    visibleContract(db, params.parentContractId);
  }
  if (params.procurementStartDate && params.supplierConfirmDate && params.procurementStartDate > params.supplierConfirmDate) {
    throw new AppError('VALIDATION_FAILED', '开始实施采购时间不能晚于供应商确定时间', 400);
  }
  if (params.supplierConfirmDate && params.signDate && params.supplierConfirmDate > params.signDate) {
    throw new AppError('VALIDATION_FAILED', '供应商确定时间不能晚于合同签署日期', 400);
  }
  if (params.procurementStartDate && params.signDate && params.procurementStartDate > params.signDate) {
    throw new AppError('VALIDATION_FAILED', '开始实施采购时间不能晚于合同签署日期', 400);
  }
  if (params.termStartDate && params.termEndDate && params.termStartDate > params.termEndDate) {
    throw new AppError('VALIDATION_FAILED', '履约开始日期不能晚于履约结束日期', 400);
  }
  if (params.pricingMode === 'lump_sum' && params.bidAwardCents !== null && params.originalCents > params.bidAwardCents) {
    throw new AppError('VALIDATION_FAILED', '合同原始金额不能高于审定中标金额', 400);
  }
}

const LIFECYCLE_COLUMN_SQL = [
  'direction', 'pricing_mode', 'unit_price_desc', 'estimated_ceiling_cents', 'currency', 'exchange_rate_scaled',
  'report_category', 'summary_text', 'remark', 'plan_item_id', 'budget_type', 'is_emergency', 'emergency_start_date',
  'funding_source', 'funding_source_detail', 'source_income_contract_id', 'parent_contract_id', 'external_no_exempt',
  'counterparty_names', 'undertaker_name', 'undertaker_dept', 'our_signatory_name', 'our_signatory_title', 'our_signatory_is_legal_rep',
  'counterparty_signatory_name', 'counterparty_signatory_title', 'counterparty_signatory_is_legal_rep',
  'entrust_reason', 'is_triple_major', 'decision_method', 'decision_method_other', 'meeting_type', 'meeting_type_other',
  'final_approver_name', 'final_approver_title', 'is_gov_procurement', 'procurement_method_other', 'procurement_plan_text',
  'procurement_start_date', 'supplier_confirm_date', 'response_docs_complete', 'credit_checked', 'bid_award_cents',
  'acquisition_method', 'acquisition_method_other', 'tender_body_type', 'consortium_members',
  'dept_reviewer_name', 'related_mgmt_depts', 'related_mgmt_reviewers', 'unit_approver_name', 'unit_approver_title', 'farmer_wage_account',
  'term_type', 'term_start_date', 'term_end_date', 'term_condition_text', 'deliverable_submitted', 'final_accepted',
  'has_warranty', 'warranty_months', 'warranty_retention_ratio_scaled', 'out_of_plan_approved_date',
] as const;

export function createContract(db: DB, input: ContractCreateRequest): ContractDetailDto {
  const scope = currentOrgScope(db);
  if (!orgInScope(scope, input.orgId)) throw notVisible('组织');
  const orgCheck = db.prepare('SELECT id, status, org_kind FROM org WHERE id = ?').get(input.orgId) as { id: number; status: string; org_kind: string } | undefined;
  if (!orgCheck) throw new AppError('VALIDATION_FAILED', '组织不存在或已停用', 400);
  if (orgCheck.org_kind === 'closed_history') throw conflict('CONTRACT_ORG_CLOSED_HISTORY', '历史关停/吸收注销主体禁止新签合同');
  if (orgCheck.status !== 'active') throw new AppError('VALIDATION_FAILED', '组织不存在或已停用', 400);
  if (input.projectId) assertProject(db, input.projectId, input.orgId);
  if (input.supplierId) assertSupplier(db, input.supplierId);
  const original = parseDecimalToCents(input.originalAmount, { label: '合同金额' });
  if (original < 0n) throw new AppError('VALIDATION_FAILED', '合同金额不能为负', 400);
  const direction: ContractDirection = input.direction ?? (input.legalCategory === 'income_sales' && !['buyer', 'employer', 'client'].includes(input.partyRole ?? '') ? 'income' : 'expense');
  const partyRole: LegalMetadata['partyRole'] = input.partyRole ?? (direction === 'income' ? 'seller' : 'buyer');
  const pricingMode: ContractPricingMode = input.pricingMode ?? 'lump_sum';
  const estimatedCeiling = optCents(input.estimatedCeilingAmount, '估算上限金额');
  const bidAward = optCents(input.bidAwardAmount, '审定中标金额');
  const exchangeRate = rateScaled(input.exchangeRate);
  const warrantyRatio = input.warrantyRetentionRatio == null ? null : parseScaled(input.warrantyRetentionRatio, RATIO_SCALE, { label: '质保金比例' });
  const fundingSource: ContractFundingSource = input.fundingSource ?? 'self_owned_other';
  const signingEntityLevel = input.signingEntityLevel ?? 'company';
  const prefixValidation = validateNewContractNoWithPrefixMap(db, {
    contractNo: input.contractNo,
    orgId: input.orgId,
    coManagedOrgId: input.coManagedOrgId ?? null,
    externalNoExempt: !!input.externalNoExempt,
    projectId: input.projectId ?? null,
  });
  const sixDim = deriveContractSixDim(db, {
    orgId: input.orgId,
    signingSubjectOrgId: input.signingSubjectOrgId ?? null,
    signingLevel: signingEntityLevel,
    prefixLegalEntityOrgId: prefixValidation.prefixRow?.legal_entity_org_id ?? null,
    prefixSuccessorOrgId: prefixValidation.prefixRow?.successor_org_id ?? null,
  });
  assertLifecycleConsistency(db, {
    orgId: input.orgId, direction, partyRole, signingEntityLevel, pricingMode, originalCents: original, bidAwardCents: bidAward,
    fundingSource, sourceIncomeContractId: input.sourceIncomeContractId ?? null,
    planItemId: input.planItemId ?? null, parentContractId: input.parentContractId ?? null,
    procurementStartDate: input.procurementStartDate ?? null, supplierConfirmDate: input.supplierConfirmDate ?? null,
    signDate: input.signDate ?? null, termStartDate: input.termStartDate ?? null, termEndDate: input.termEndDate ?? null,
  });
  const normalized = normalizeContractNo(input.contractNo);
  const id = db.transaction(() => {
    if (
      db.prepare('SELECT 1 FROM ct_contract WHERE COALESCE(legal_entity_org_id, org_id) = ? AND normalized_no = ?').get(
        sixDim.legalEntityOrgId,
        normalized,
      )
    ) {
      throw conflict('CONTRACT_NO_EXISTS', `合同编号 ${input.contractNo} 在同一法人单位下已存在`);
    }
    const now = nowIso();
    const category = input.legalCategory ?? (direction === 'income' ? 'income_sales' : 'other');
    const reportCategory = deriveReportCategory(input.procurementTarget ?? null, category, input.reportCategory);
    const newId = Number(db.prepare(`INSERT INTO ct_contract (contract_no, normalized_no, name, contract_type, org_id, project_id, supplier_id, original_cents, payment_cap_ratio_scaled,
      sign_date, effective_date, source, origin, migration_mode, signing_org_id, signing_subject_org_id, legal_entity_org_id, historical_legal_entity_org_id, co_managed_org_id,
      created_by_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', 'manual', 'normal', ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      input.contractNo.trim(), normalized, input.name, input.contractType ?? '', input.orgId, input.projectId ?? null, input.supplierId ?? null, original,
      capScaled(input.paymentCapRatio), input.signDate ?? null, input.effectiveDate ?? null,
      sixDim.signingOrgId, sixDim.signingSubjectOrgId, sixDim.legalEntityOrgId, sixDim.historicalLegalEntityOrgId, input.coManagedOrgId ?? null,
      currentAuth()?.userId ?? null, now, now).lastInsertRowid);
    const lcVals: unknown[] = [
      direction, pricingMode, input.unitPriceDesc ?? '', estimatedCeiling, input.currency ?? '人民币', exchangeRate,
      reportCategory, input.summaryText ?? '', input.remark ?? '', input.planItemId ?? null, input.budgetType ?? 'single_listed',
      input.isEmergency ? 1 : 0, input.emergencyStartDate ?? null, fundingSource, input.fundingSourceDetail ?? '',
      input.sourceIncomeContractId ?? null, input.parentContractId ?? null, input.externalNoExempt ? 1 : 0,
      input.counterpartyNames ?? '', input.undertakerName ?? '', input.undertakerDept ?? '',
      input.ourSignatoryName ?? '', input.ourSignatoryTitle ?? '', input.ourSignatoryIsLegalRep == null ? null : (input.ourSignatoryIsLegalRep ? 1 : 0),
      input.counterpartySignatoryName ?? '', input.counterpartySignatoryTitle ?? '', input.counterpartySignatoryIsLegalRep == null ? null : (input.counterpartySignatoryIsLegalRep ? 1 : 0),
      input.entrustReason ?? '', input.isTripleMajor ? 1 : 0, input.decisionMethod ?? null, input.decisionMethodOther ?? '',
      input.meetingType ?? null, input.meetingTypeOther ?? '', input.finalApproverName ?? '', input.finalApproverTitle ?? '',
      input.isGovProcurement ? 1 : 0, input.procurementMethodOther ?? '', input.procurementPlanText ?? '',
      input.procurementStartDate ?? null, input.supplierConfirmDate ?? null,
      input.responseDocsComplete == null ? null : (input.responseDocsComplete ? 1 : 0),
      input.creditChecked == null ? null : (input.creditChecked ? 1 : 0), bidAward,
      input.acquisitionMethod ?? null, input.acquisitionMethodOther ?? '', input.tenderBodyType ?? null, input.consortiumMembers ?? '',
      input.deptReviewerName ?? '', input.relatedMgmtDepts ?? '', input.relatedMgmtReviewers ?? '', input.unitApproverName ?? '', input.unitApproverTitle ?? '', input.farmerWageAccount ?? '',
      input.termType ?? 'unspecified', input.termStartDate ?? null, input.termEndDate ?? null, input.termConditionText ?? '',
      input.deliverableSubmitted == null ? null : (input.deliverableSubmitted ? 1 : 0), input.finalAccepted ? 1 : 0,
      input.hasWarranty ? 1 : 0, input.warrantyMonths ?? null, warrantyRatio, input.outOfPlanApprovedDate ?? null,
    ];
    db.prepare(`UPDATE ct_contract SET ${LIFECYCLE_COLUMN_SQL.map((c) => `${c} = ?`).join(', ')} WHERE id = ?`).run(...lcVals, newId);
    saveLegalMetadata(db, newId, { ...input, legalCategory: category, partyRole, signingEntityLevel }, original, estimatedCeiling);
    recordEvent(db, newId, 'create', { contractNo: input.contractNo.trim(), direction, pricingMode, originalAmount: centsToDecimalString(original) }, { to: 'initiation' });
    return newId;
  }).immediate();
  return getContractDetail(db, id);
}

const EARLY: ContractStage[] = ['initiation', 'procurement', 'drafting'];

export function updateContract(db: DB, id: number, input: ContractUpdateRequest): ContractDetailDto {
  db.transaction(() => {
    const c = visibleContract(db, id);
    assertActive(c, '修改');
    assertVersion(c, input.expectedVersion);
    const sets: string[] = [];
    const params: unknown[] = [];
    const changed: Record<string, unknown> = {};
    const approved=db.prepare("SELECT legal_run_id FROM ct_review WHERE contract_id=? AND status='approved' ORDER BY id DESC LIMIT 1").get(id) as {legal_run_id:number|null}|undefined;
    const bound=approved?.legal_run_id?db.prepare('SELECT * FROM ct_legal_run WHERE id=?').get(approved.legal_run_id):undefined;
    const correction=c.stage==='approval' && legalEnabled(db,c) && !hasDoc(db,id,'signed') && (!approved || !legalRunCurrent(db,bound,legalSnapshot(db,id).fingerprint));
    const early = EARLY.includes(c.stage)||correction;
    const legalKeys=['legalCategory','partyRole','signingEntityLevel','isProcurement','procurementTarget','procurementMethod','isImportant','direction','pricingMode','unitPriceDesc'] as const;
    const curLegal = {
      legalCategory: c.legal_category, partyRole: c.party_role, signingEntityLevel: c.signing_entity_level,
      isProcurement: !!c.is_procurement, procurementTarget: c.procurement_target, procurementMethod: c.procurement_method, isImportant: !!c.is_important,
      direction: c.direction, pricingMode: c.pricing_mode, unitPriceDesc: c.unit_price_desc,
    };
    const metadataChanged = legalKeys.some((k) => input[k] !== undefined && input[k] !== curLegal[k]);
    if (metadataChanged && !early) throw conflict('CONTRACT_STATE', '签署或有效审核后不能修改法审信息，请先退回或重新送审');
    const set = (col: string, value: unknown, label: string) => { sets.push(`${col} = ?`); params.push(value); changed[label] = value; };
    if (input.name !== undefined && input.name !== c.name) set('name', input.name, 'name');
    if (input.contractType !== undefined && input.contractType !== c.contract_type) set('contract_type', input.contractType, 'contractType');
    if (input.projectId !== undefined && (input.projectId ?? null) !== c.project_id) {
      if (!early) throw conflict('CONTRACT_STATE', '合同起草之后不能更换项目');
      if (input.projectId) assertProject(db, input.projectId, c.org_id);
      set('project_id', input.projectId ?? null, 'projectId');
    }
    if (input.supplierId !== undefined && (input.supplierId ?? null) !== c.supplier_id) {
      if (!early) throw conflict('CONTRACT_STATE', '合同起草之后不能更换供应商');
      if (input.supplierId) assertSupplier(db, input.supplierId);
      set('supplier_id', input.supplierId ?? null, 'supplierId');
    }
    if (input.originalAmount !== undefined) {
      const cents = parseDecimalToCents(input.originalAmount, { label: '合同金额' });
      if (cents !== BigInt(c.original_cents)) {
        if (!early) throw conflict('CONTRACT_STATE', '合同起草之后金额只能通过变更调整');
        if (cents < 0n) throw new AppError('VALIDATION_FAILED', '合同金额不能为负', 400);
        set('original_cents', cents, 'originalAmount');
        changed.originalAmount = centsToDecimalString(cents);
      }
    }
    if (input.paymentCapRatio !== undefined) {
      const cap = capScaled(input.paymentCapRatio);
      if ((cap === null ? null : cap.toString()) !== (c.payment_cap_ratio_scaled === null ? null : BigInt(c.payment_cap_ratio_scaled).toString())) set('payment_cap_ratio_scaled', cap, 'paymentCapRatio');
    }
    if (input.signDate !== undefined && (input.signDate ?? null) !== c.sign_date) set('sign_date', input.signDate ?? null, 'signDate');
    if (input.effectiveDate !== undefined && (input.effectiveDate ?? null) !== c.effective_date) set('effective_date', input.effectiveDate ?? null, 'effectiveDate');
    const optBool = (col: string, val: boolean | null | undefined, cur: number | null, label: string) => {
      if (val === undefined) return;
      const nextVal = val === null ? null : (val ? 1 : 0);
      if (nextVal !== cur) set(col, nextVal, label);
    };
    const reqBool = (col: string, val: boolean | undefined, cur: number, label: string) => {
      if (val === undefined) return;
      const nextVal = val ? 1 : 0;
      if (nextVal !== cur) set(col, nextVal, label);
    };
    const optVal = (col: string, val: unknown, cur: unknown, label: string) => {
      if (val === undefined) return;
      const nextVal = val ?? null;
      if (nextVal !== cur) set(col, nextVal, label);
    };
    optVal('direction', input.direction, c.direction, 'direction');
    optVal('pricing_mode', input.pricingMode, c.pricing_mode, 'pricingMode');
    if (input.unitPriceDesc !== undefined && input.unitPriceDesc !== c.unit_price_desc) set('unit_price_desc', input.unitPriceDesc, 'unitPriceDesc');
    const nextEstimated = input.estimatedCeilingAmount === undefined ? c.estimated_ceiling_cents : optCents(input.estimatedCeilingAmount, '估算上限金额');
    if (input.estimatedCeilingAmount !== undefined && String(nextEstimated) !== String(c.estimated_ceiling_cents)) set('estimated_ceiling_cents', nextEstimated, 'estimatedCeilingAmount');
    if ((input.currency !== undefined && input.currency !== c.currency) || (input.direction !== undefined && input.direction !== c.direction)) {
      const facts = db.prepare(`SELECT 1 FROM ct_payment WHERE contract_id = ? UNION ALL SELECT 1 FROM ct_receipt WHERE contract_id = ? UNION ALL SELECT 1 FROM ct_settlement WHERE contract_id = ? UNION ALL SELECT 1 FROM ct_change WHERE contract_id = ? UNION ALL SELECT 1 FROM ct_guarantee WHERE contract_id = ? LIMIT 1`).get(id, id, id, id, id);
      if (facts || c.paid_cents > 0n || c.received_cents > 0n || c.settled_net_cents > 0n) throw conflict('CONTRACT_CURRENCY_LOCKED', '已有金融事实的合同不能修改币种或收支方向');
    }
    optVal('currency', input.currency, c.currency, 'currency');
    if (input.exchangeRate !== undefined) {
      const xr = rateScaled(input.exchangeRate);
      if (String(xr) !== String(c.exchange_rate_scaled)) set('exchange_rate_scaled', xr, 'exchangeRate');
    }
    optVal('report_category', input.reportCategory, c.report_category, 'reportCategory');
    if (input.summaryText !== undefined && input.summaryText !== c.summary_text) set('summary_text', input.summaryText, 'summaryText');
    if (input.remark !== undefined && input.remark !== c.remark) set('remark', input.remark, 'remark');
    optVal('out_of_plan_approved_date', input.outOfPlanApprovedDate, c.out_of_plan_approved_date, 'outOfPlanApprovedDate');
    optVal('plan_item_id', input.planItemId, c.plan_item_id, 'planItemId');
    optVal('budget_type', input.budgetType, c.budget_type, 'budgetType');
    reqBool('is_emergency', input.isEmergency, c.is_emergency, 'isEmergency');
    optVal('emergency_start_date', input.emergencyStartDate, c.emergency_start_date, 'emergencyStartDate');
    optVal('funding_source', input.fundingSource, c.funding_source, 'fundingSource');
    if (input.fundingSourceDetail !== undefined && input.fundingSourceDetail !== c.funding_source_detail) set('funding_source_detail', input.fundingSourceDetail, 'fundingSourceDetail');
    optVal('source_income_contract_id', input.sourceIncomeContractId, c.source_income_contract_id, 'sourceIncomeContractId');
    optVal('parent_contract_id', input.parentContractId, c.parent_contract_id, 'parentContractId');
    if (input.coManagedOrgId !== undefined && (input.coManagedOrgId ?? null) !== c.co_managed_org_id) {
      if (!early) throw conflict('CONTRACT_STATE', '合同起草之后不能修改统筹代办组织');
      set('co_managed_org_id', input.coManagedOrgId ?? null, 'coManagedOrgId');
    }
    if (input.signingSubjectOrgId !== undefined || input.signingEntityLevel !== undefined) {
      if (!early && (input.signingSubjectOrgId ?? c.signing_subject_org_id) !== c.signing_subject_org_id) {
        throw conflict('CONTRACT_STATE', '合同起草之后不能修改对外签约名义组织');
      }
      if (c.migration_mode !== 'legacy_tolerant') {
        const nextSixDim = deriveContractSixDim(db, {
          orgId: c.org_id,
          signingSubjectOrgId: input.signingSubjectOrgId === undefined ? c.signing_subject_org_id : input.signingSubjectOrgId,
          signingLevel: input.signingEntityLevel ?? c.signing_entity_level,
        });
        if (nextSixDim.signingSubjectOrgId !== c.signing_subject_org_id) set('signing_subject_org_id', nextSixDim.signingSubjectOrgId, 'signingSubjectOrgId');
        if (nextSixDim.legalEntityOrgId !== c.legal_entity_org_id) set('legal_entity_org_id', nextSixDim.legalEntityOrgId, 'legalEntityOrgId');
      }
    }
    reqBool('external_no_exempt', input.externalNoExempt, c.external_no_exempt, 'externalNoExempt');
    if (input.counterpartyNames !== undefined && input.counterpartyNames !== c.counterparty_names) set('counterparty_names', input.counterpartyNames, 'counterpartyNames');
    if (input.undertakerName !== undefined && input.undertakerName !== c.undertaker_name) set('undertaker_name', input.undertakerName, 'undertakerName');
    if (input.undertakerDept !== undefined && input.undertakerDept !== c.undertaker_dept) set('undertaker_dept', input.undertakerDept, 'undertakerDept');
    if (input.ourSignatoryName !== undefined && input.ourSignatoryName !== c.our_signatory_name) set('our_signatory_name', input.ourSignatoryName, 'ourSignatoryName');
    if (input.ourSignatoryTitle !== undefined && input.ourSignatoryTitle !== c.our_signatory_title) set('our_signatory_title', input.ourSignatoryTitle, 'ourSignatoryTitle');
    optBool('our_signatory_is_legal_rep', input.ourSignatoryIsLegalRep, c.our_signatory_is_legal_rep, 'ourSignatoryIsLegalRep');
    if (input.counterpartySignatoryName !== undefined && input.counterpartySignatoryName !== c.counterparty_signatory_name) set('counterparty_signatory_name', input.counterpartySignatoryName, 'counterpartySignatoryName');
    if (input.counterpartySignatoryTitle !== undefined && input.counterpartySignatoryTitle !== c.counterparty_signatory_title) set('counterparty_signatory_title', input.counterpartySignatoryTitle, 'counterpartySignatoryTitle');
    optBool('counterparty_signatory_is_legal_rep', input.counterpartySignatoryIsLegalRep, c.counterparty_signatory_is_legal_rep, 'counterpartySignatoryIsLegalRep');
    if (input.entrustReason !== undefined && input.entrustReason !== c.entrust_reason) set('entrust_reason', input.entrustReason, 'entrustReason');
    reqBool('is_triple_major', input.isTripleMajor, c.is_triple_major, 'isTripleMajor');
    optVal('decision_method', input.decisionMethod, c.decision_method, 'decisionMethod');
    if (input.decisionMethodOther !== undefined && input.decisionMethodOther !== c.decision_method_other) set('decision_method_other', input.decisionMethodOther, 'decisionMethodOther');
    optVal('meeting_type', input.meetingType, c.meeting_type, 'meetingType');
    if (input.meetingTypeOther !== undefined && input.meetingTypeOther !== c.meeting_type_other) set('meeting_type_other', input.meetingTypeOther, 'meetingTypeOther');
    if (input.finalApproverName !== undefined && input.finalApproverName !== c.final_approver_name) set('final_approver_name', input.finalApproverName, 'finalApproverName');
    if (input.finalApproverTitle !== undefined && input.finalApproverTitle !== c.final_approver_title) set('final_approver_title', input.finalApproverTitle, 'finalApproverTitle');
    reqBool('is_gov_procurement', input.isGovProcurement, c.is_gov_procurement, 'isGovProcurement');
    if (input.procurementMethodOther !== undefined && input.procurementMethodOther !== c.procurement_method_other) set('procurement_method_other', input.procurementMethodOther, 'procurementMethodOther');
    if (input.procurementPlanText !== undefined && input.procurementPlanText !== c.procurement_plan_text) set('procurement_plan_text', input.procurementPlanText, 'procurementPlanText');
    optVal('procurement_start_date', input.procurementStartDate, c.procurement_start_date, 'procurementStartDate');
    optVal('supplier_confirm_date', input.supplierConfirmDate, c.supplier_confirm_date, 'supplierConfirmDate');
    optBool('response_docs_complete', input.responseDocsComplete, c.response_docs_complete, 'responseDocsComplete');
    optBool('credit_checked', input.creditChecked, c.credit_checked, 'creditChecked');
    const nextBidAward = input.bidAwardAmount === undefined ? c.bid_award_cents : optCents(input.bidAwardAmount, '审定中标金额');
    if (input.bidAwardAmount !== undefined && String(nextBidAward) !== String(c.bid_award_cents)) set('bid_award_cents', nextBidAward, 'bidAwardAmount');
    optVal('acquisition_method', input.acquisitionMethod, c.acquisition_method, 'acquisitionMethod');
    if (input.acquisitionMethodOther !== undefined && input.acquisitionMethodOther !== c.acquisition_method_other) set('acquisition_method_other', input.acquisitionMethodOther, 'acquisitionMethodOther');
    optVal('tender_body_type', input.tenderBodyType, c.tender_body_type, 'tenderBodyType');
    if (input.consortiumMembers !== undefined && input.consortiumMembers !== c.consortium_members) set('consortium_members', input.consortiumMembers, 'consortiumMembers');
    if (input.deptReviewerName !== undefined && input.deptReviewerName !== c.dept_reviewer_name) set('dept_reviewer_name', input.deptReviewerName, 'deptReviewerName');
    if (input.relatedMgmtDepts !== undefined && input.relatedMgmtDepts !== c.related_mgmt_depts) set('related_mgmt_depts', input.relatedMgmtDepts, 'relatedMgmtDepts');
    if (input.relatedMgmtReviewers !== undefined && input.relatedMgmtReviewers !== c.related_mgmt_reviewers) set('related_mgmt_reviewers', input.relatedMgmtReviewers, 'relatedMgmtReviewers');
    if (input.unitApproverName !== undefined && input.unitApproverName !== c.unit_approver_name) set('unit_approver_name', input.unitApproverName, 'unitApproverName');
    if (input.unitApproverTitle !== undefined && input.unitApproverTitle !== c.unit_approver_title) set('unit_approver_title', input.unitApproverTitle, 'unitApproverTitle');
    if (input.farmerWageAccount !== undefined && input.farmerWageAccount !== c.farmer_wage_account) set('farmer_wage_account', input.farmerWageAccount, 'farmerWageAccount');
    optVal('term_type', input.termType, c.term_type, 'termType');
    optVal('term_start_date', input.termStartDate, c.term_start_date, 'termStartDate');
    optVal('term_end_date', input.termEndDate, c.term_end_date, 'termEndDate');
    if (input.termConditionText !== undefined && input.termConditionText !== c.term_condition_text) set('term_condition_text', input.termConditionText, 'termConditionText');
    optBool('deliverable_submitted', input.deliverableSubmitted, c.deliverable_submitted, 'deliverableSubmitted');
    reqBool('final_accepted', input.finalAccepted, c.final_accepted, 'finalAccepted');
    reqBool('has_warranty', input.hasWarranty, c.has_warranty, 'hasWarranty');
    optVal('warranty_months', input.warrantyMonths, c.warranty_months, 'warrantyMonths');
    if (input.warrantyRetentionRatio !== undefined) {
      const wr = input.warrantyRetentionRatio == null ? null : parseScaled(input.warrantyRetentionRatio, RATIO_SCALE, { label: '质保金比例' });
      if (String(wr) !== String(c.warranty_retention_ratio_scaled)) set('warranty_retention_ratio_scaled', wr, 'warrantyRetentionRatio');
    }
    const nextOriginal = input.originalAmount === undefined ? BigInt(c.original_cents) : parseDecimalToCents(input.originalAmount, { label: '合同金额' });
    assertLifecycleConsistency(db, {
      selfId: id,
      orgId: c.org_id,
      direction: input.direction ?? c.direction,
      partyRole: input.partyRole ?? c.party_role,
      signingEntityLevel: input.signingEntityLevel ?? c.signing_entity_level,
      pricingMode: input.pricingMode ?? c.pricing_mode,
      originalCents: nextOriginal,
      bidAwardCents: nextBidAward ?? null,
      fundingSource: input.fundingSource ?? c.funding_source,
      sourceIncomeContractId: input.sourceIncomeContractId === undefined ? c.source_income_contract_id : (input.sourceIncomeContractId ?? null),
      planItemId: input.planItemId === undefined ? c.plan_item_id : (input.planItemId ?? null),
      parentContractId: input.parentContractId === undefined ? c.parent_contract_id : (input.parentContractId ?? null),
      procurementStartDate: input.procurementStartDate === undefined ? c.procurement_start_date : (input.procurementStartDate ?? null),
      supplierConfirmDate: input.supplierConfirmDate === undefined ? c.supplier_confirm_date : (input.supplierConfirmDate ?? null),
      signDate: input.signDate === undefined ? c.sign_date : (input.signDate ?? null),
      termStartDate: input.termStartDate === undefined ? c.term_start_date : (input.termStartDate ?? null),
      termEndDate: input.termEndDate === undefined ? c.term_end_date : (input.termEndDate ?? null),
    });
    if (!sets.length&&!metadataChanged) return;
    saveLegalMetadata(db,id,input,nextOriginal,nextEstimated??null);
    if(!sets.length) { bump(db,id); recordEvent(db,id,'update',{changed:legalKeys}); return; }
    db.prepare(`UPDATE ct_contract SET ${sets.join(', ')}, version = version + 1, updated_at = ? WHERE id = ?`).run(...params, nowIso(), id);
    recordEvent(db, id, 'update', { changed: Object.keys(changed) });
  }).immediate();
  return getContractDetail(db, id);
}

/* ================= 阶段与命令 ================= */

export function advanceContract(db: DB, id: number, expectedVersion: number, toStage: ContractStage): ContractDetailDto {
  db.transaction(() => {
    const c = visibleContract(db, id);
    assertActive(c, '推进阶段');
    assertVersion(c, expectedVersion);
    const next = nextStage(c.stage, contractHasWarranty(db, c));
    if (toStage !== next) {
      throw conflict('CONTRACT_STAGE_BLOCKED', `只能从「${CONTRACT_STAGE_LABELS[c.stage]}」推进到下一阶段${next ? `「${CONTRACT_STAGE_LABELS[next]}」` : ''}`, { blockers: [{ code: 'STAGE_SKIP', message: '不能跳阶段或回退' }] });
    }
    const blockers = computeBlockers(db, c);
    if (blockers.length) throw conflict('CONTRACT_STAGE_BLOCKED', `推进到「${CONTRACT_STAGE_LABELS[toStage]}」前还有 ${blockers.length} 项未满足`, { blockers });
    const closing = toStage === 'closed';
    db.prepare(`UPDATE ct_contract SET stage = ?, status = ?, completed_date = CASE WHEN ? = 'closed' THEN ? ELSE completed_date END, version = version + 1, updated_at = ? WHERE id = ?`).run(toStage, closing ? 'closed' : 'active', toStage, todayIso(), nowIso(), id);
    recordEvent(db, id, closing ? 'archive' : 'advance', {}, { from: c.stage, to: toStage });
  }).immediate();
  return getContractDetail(db, id);
}

export function terminateContract(db: DB, id: number, expectedVersion: number, reason: string, extra?: Pick<ContractCommandRequest, 'guarantorConsentDocumentId' | 'approvalTier' | 'terminationAgreementDocumentId'>): ContractDetailDto {
  return statusCommand(db, id, expectedVersion, reason, 'terminated', 'terminate', extra);
}

export function voidContract(db: DB, id: number, expectedVersion: number, reason: string): ContractDetailDto {
  return statusCommand(db, id, expectedVersion, reason, 'voided', 'void');
}

function statusCommand(db: DB, id: number, expectedVersion: number, reason: string, status: 'terminated' | 'voided', event: string, extra?: Pick<ContractCommandRequest, 'guarantorConsentDocumentId' | 'approvalTier' | 'terminationAgreementDocumentId'>): ContractDetailDto {
  db.transaction(() => {
    const c = visibleContract(db, id);
    if (!(status === 'terminated' && c.status === 'suspended')) assertActive(c, status === 'voided' ? '作废' : '终止');
    assertVersion(c, expectedVersion);
    if (status === 'terminated') {
      assertGuarantorConsent(db, id, extra?.guarantorConsentDocumentId ?? null);
      if (!extra?.approvalTier || CHANGE_TIER_RANK[extra.approvalTier] < CHANGE_TIER_RANK.general_manager) throw conflict('CONTRACT_CHANGE_TIER_MISMATCH', '合同解除须经总经理及以上批准');
      requireEvidence(db, id, extra?.terminationAgreementDocumentId, ['termination_agreement']);
    }
    if (status === 'voided' && (BigInt(c.paid_cents) > 0n || BigInt(c.received_cents) > 0n || db.prepare("SELECT 1 FROM ct_settlement WHERE contract_id = ? AND status = 'approved'").get(id))) throw conflict('CONTRACT_STATE', '已有实际收付款或生效结算的合同不能作废，请办理解除清算');
    const open = db.prepare("SELECT COUNT(*) AS n FROM ct_payment WHERE contract_id = ? AND status IN ('submitted','approved')").get(id) as { n: number };
    if (open.n) throw conflict('CONTRACT_STATE', `有 ${open.n} 笔付款未结,请先驳回或完成支付`);
    const openRec = db.prepare("SELECT COUNT(*) AS n FROM ct_receipt WHERE contract_id = ? AND status IN ('submitted','approved')").get(id) as { n: number };
    if (openRec.n) throw conflict('CONTRACT_STATE', `有 ${openRec.n} 笔收款未结,请先驳回或完成到账`);
    const openSet = db.prepare("SELECT COUNT(*) AS n FROM ct_settlement WHERE contract_id = ? AND status = 'submitted'").get(id) as { n: number };
    if (openSet.n) throw conflict('CONTRACT_STATE', `有 ${openSet.n} 项结算单待复核,请先处理`);
    db.prepare('UPDATE ct_contract SET status = ?, status_reason = ?, completed_date = ?, version = version + 1, updated_at = ? WHERE id = ?').run(status, reason, status === 'terminated' ? todayIso() : null, nowIso(), id);
    recordEvent(db, id, event, { reason, ...extra }, { from: c.stage, to: c.stage });
  }).immediate();
  return getContractDetail(db, id);
}

/** 重开:已关闭或已终止的合同回到指定的非归档阶段;作废不可重开。需要 contract:review(路由把关)。 */
export function reopenContract(db: DB, id: number, expectedVersion: number, reason: string, targetStage: ContractStage): ContractDetailDto {
  db.transaction(() => {
    const c = visibleContract(db, id);
    assertVersion(c, expectedVersion);
    if (c.status !== 'closed' && c.status !== 'terminated') throw conflict('CONTRACT_STATE', c.status === 'voided' ? '已作废的合同不能重开' : '只有已关闭或已终止的合同可以重开');
    if (targetStage === 'closed') throw new AppError('VALIDATION_FAILED', '重开目标阶段不能是履约完结', 400);
    db.prepare("UPDATE ct_contract SET status = 'active', stage = ?, status_reason = ?, completed_date = NULL, version = version + 1, updated_at = ? WHERE id = ?").run(targetStage, reason, nowIso(), id);
    recordEvent(db, id, 'reopen', { reason, previousStatus: c.status }, { from: c.stage, to: targetStage });
  }).immediate();
  return getContractDetail(db, id);
}

export function suspendContract(db: DB, id: number, expectedVersion: number, reason: string, guarantorConsentDocumentId?: number | null): ContractDetailDto {
  db.transaction(() => {
    const c = visibleContract(db, id);
    assertActive(c, '中止');
    assertVersion(c, expectedVersion);
    if (!['performance', 'settlement', 'warranty'].includes(c.stage)) {
      throw conflict('CONTRACT_STATE', '只能中止已进入履约/结算/质保阶段的合同');
    }
    assertGuarantorConsent(db, id, guarantorConsentDocumentId ?? null);
    db.prepare("UPDATE ct_contract SET status = 'suspended', status_reason = ?, version = version + 1, updated_at = ? WHERE id = ?").run(reason, nowIso(), id);
    recordEvent(db, id, 'suspend', { reason, guarantorConsentDocumentId: guarantorConsentDocumentId ?? null }, { from: c.stage, to: c.stage });
  }).immediate();
  return getContractDetail(db, id);
}

export function resumeContract(db: DB, id: number, expectedVersion: number, reason: string): ContractDetailDto {
  db.transaction(() => {
    const c = visibleContract(db, id);
    assertVersion(c, expectedVersion);
    if (c.status !== 'suspended') throw conflict('CONTRACT_STATE', '只有已中止的合同可以恢复履行');
    db.prepare("UPDATE ct_contract SET status = 'active', status_reason = ?, version = version + 1, updated_at = ? WHERE id = ?").run(reason, nowIso(), id);
    recordEvent(db, id, 'resume', { reason }, { from: c.stage, to: c.stage });
  }).immediate();
  return getContractDetail(db, id);
}

export function updateContractDistribution(db: DB, id: number, input: ContractDistributionRequest): ContractDetailDto {
  db.transaction(() => {
    const c = visibleContract(db, id);
    if (c.status === 'voided') throw conflict('CONTRACT_STATE', '已作废合同不能登记分发备案');
    assertVersion(c, input.expectedVersion);
    if (!c.sign_date && !hasDoc(db, id, 'signed')) {
      throw conflict('CONTRACT_STATE', '请先填写签署日期或上传盖章签署件后再登记分发备案');
    }
    db.prepare("UPDATE ct_contract SET distribution_status = 'completed', distributed_at = ?, company_filed_at = ?, version = version + 1, updated_at = ? WHERE id = ?")
      .run(input.distributedAt, input.companyFiledAt ?? null, nowIso(), id);
    recordEvent(db, id, 'distribution', { distributedAt: input.distributedAt, companyFiledAt: input.companyFiledAt ?? null, note: input.note ?? '' });
  }).immediate();
  return getContractDetail(db, id);
}

export function updateContractArchiveStatus(db: DB, id: number, input: ContractArchiveStatusRequest): ContractDetailDto {
  db.transaction(() => {
    const c = visibleContract(db, id);
    if (c.status === 'voided') throw conflict('CONTRACT_STATE', '已作废合同不能更新归档状态');
    assertVersion(c, input.expectedVersion);
    const d = input.actionDate ?? todayIso();
    if (input.deferNote?.trim() && (!currentAuth() || !isAdminUser(db, currentAuth()!.userId))) throw new AppError('FORBIDDEN', '批次移交容缺说明仅管理员可登记', 403);
    if (input.archiveStatus === 'checked') {
      db.prepare("UPDATE ct_contract SET archive_status = 'checked', archive_checked_at = COALESCE(archive_checked_at, ?), archive_defer_note = ?, version = version + 1, updated_at = ? WHERE id = ?")
        .run(d, input.deferNote?.trim() || null, nowIso(), id);
    } else {
      db.prepare("UPDATE ct_contract SET archive_status = 'transferred', archive_checked_at = COALESCE(archive_checked_at, ?), archive_transferred_at = ?, archive_transfer_no = ?, archive_defer_note = ?, version = version + 1, updated_at = ? WHERE id = ?")
        .run(d, d, input.transferNo ?? null, input.deferNote ?? null, nowIso(), id);
    }
    recordEvent(db, id, 'archive_status', { archiveStatus: input.archiveStatus, actionDate: d, transferNo: input.transferNo ?? null, deferNote: input.deferNote ?? null });
  }).immediate();
  return getContractDetail(db, id);
}

export function handoverUndertaker(db: DB, id: number, input: ContractHandoverRequest): ContractDetailDto {
  db.transaction(() => {
    const c = visibleContract(db, id);
    if (c.status === 'voided') throw conflict('CONTRACT_STATE', '已作废合同不能交接承办人');
    assertVersion(c, input.expectedVersion);
    const now = nowIso();
    const nextDept = input.toDept ?? c.undertaker_dept;
    db.prepare(`INSERT INTO ct_undertaker_handover (contract_id, from_undertaker, to_undertaker, to_dept, reason, left_post_date, handover_date, actor_user_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, c.undertaker_name, input.toUndertaker, nextDept, input.reason ?? '', input.leftPostDate ?? null, input.handoverDate, currentAuth()?.userId ?? null, now);
    db.prepare('UPDATE ct_contract SET undertaker_name = ?, undertaker_dept = ?, version = version + 1, updated_at = ? WHERE id = ?')
      .run(input.toUndertaker, nextDept, now, id);
    recordEvent(db, id, 'undertaker.handover', { from: c.undertaker_name, to: input.toUndertaker, toDept: nextDept, handoverDate: input.handoverDate });
  }).immediate();
  return getContractDetail(db, id);
}

/* ================= 文档 ================= */

export function addContractDocument(db: DB, store: ObjectStore, id: number, content: Buffer, fileName: string, docType: ContractDocType, name?: string, evidenceKind?: EvidenceKind, changeId?: number): ContractDocumentDto {
  const c = visibleContract(db, id);
  if (c.status !== 'suspended') assertActive(c, '上传文档');
  if (docType === 'contract_text' && legalEnabled(db, c) && legacyDoc(fileName, content) && !isValidLegacyDocUpload(content)) {
    throw new AppError('VALIDATION_FAILED', '损坏或超限的 .doc 文件，请上传有效老版 Word 文档或另存为 .docx / 导出 .pdf 后上传', 400);
  }
  if (docType === 'contract_text' && !legalEnabled(db,c) && db.prepare("SELECT 1 FROM ct_review WHERE contract_id = ? AND status = 'submitted'").get(id)) {
    throw conflict('CONTRACT_STATE', '合同审核进行中,不能替换合同正文;请等待审核结论后再上传');
  }
  if (changeId !== undefined && !db.prepare('SELECT 1 FROM ct_change WHERE id = ? AND contract_id = ?').get(changeId, id)) {
    throw notVisible('合同变更');
  }
  const file = storeFile(db, store, content, { originalName: fileName });
  const docId = db.transaction(() => {
    const fresh = visibleContract(db, id);
    if (fresh.status !== 'suspended') assertActive(fresh, '上传文档');
    const newId = Number(db.prepare('INSERT INTO ct_document (contract_id, doc_type, file_object_id, name, uploaded_by_user_id, uploaded_at, evidence_kind, change_id) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(id, docType, file.id, (name || fileName).slice(0, 200), currentAuth()?.userId ?? null, nowIso(), evidenceKind ?? null, changeId ?? null).lastInsertRowid);
    bump(db, id);
    recordEvent(db, id, 'document', { documentId: newId, docType, docTypeLabel: CONTRACT_DOC_TYPE_LABELS[docType], fileSha256: file.sha256, evidenceKind:evidenceKind??null, changeId: changeId ?? null });
    return newId;
  }).immediate();
  return documents(db, id).find((d) => d.id === docId)!;
}

export function contractDocumentContent(db: DB, store: ObjectStore, id: number, docId: number): { fileName: string; contentType: string; content: Buffer } {
  visibleContract(db, id);
  const d = db.prepare('SELECT d.name, f.sha256, f.content_type FROM ct_document d JOIN file_object f ON f.id = d.file_object_id WHERE d.id = ? AND d.contract_id = ?').get(docId, id) as
    { name: string; sha256: string; content_type: string } | undefined;
  if (!d) throw notVisible('合同文档');
  return { fileName: d.name, contentType: d.content_type, content: store.read(d.sha256) };
}

export function contractDoc(db: DB, contractId: number, docId: number): { id: number; doc_type: ContractDocType } {
  const d = db.prepare('SELECT id, doc_type FROM ct_document WHERE id = ? AND contract_id = ?').get(docId, contractId) as { id: number; doc_type: ContractDocType } | undefined;
  if (!d) throw notVisible('合同文档');
  return d;
}

/* ================= 审核 ================= */

export function submitContractReview(db: DB, id: number, documentId: number, note?: string): ContractDetailDto {
  db.transaction(() => {
    const c = visibleContract(db, id);
    assertActive(c, '提交审核');
    if (c.stage !== 'approval') throw conflict('CONTRACT_STATE', '只能在「审批签署」阶段提交合同审核');
    const doc = contractDoc(db, id, documentId);
    if (doc.doc_type !== 'contract_text') throw new AppError('VALIDATION_FAILED', '合同审核须绑定合同正文文档', 400);
    const latest = db.prepare("SELECT MAX(id) AS id FROM ct_document WHERE contract_id = ? AND doc_type = 'contract_text'").get(id) as { id: number };
    if (latest.id !== documentId) throw new AppError('VALIDATION_FAILED', '只能提交最新的合同正文', 400);
    if (db.prepare("SELECT 1 FROM ct_review WHERE contract_id = ? AND status = 'submitted'").get(id)) throw conflict('CONTRACT_STATE', '已有待处理的合同审核');
    const rid = Number(db.prepare('INSERT INTO ct_review (contract_id, document_id, submit_note, submitted_by_user_id, submitted_at) VALUES (?, ?, ?, ?, ?)')
      .run(id, documentId, note ?? '', currentAuth()?.userId ?? null, nowIso()).lastInsertRowid);
    bump(db, id);
    recordEvent(db, id, 'review.submit', { reviewId: rid, documentId });
  }).immediate();
  return getContractDetail(db, id);
}

export function decideContractReview(db: DB, id: number, reviewId: number, input: DecisionRequest): ContractDetailDto {
  const auth = currentAuth();
  db.transaction(() => {
    const c = visibleContract(db, id);
    assertActive(c, '审核');
    const r = db.prepare('SELECT * FROM ct_review WHERE id = ? AND contract_id = ?').get(reviewId, id) as { id: number; status: string; submitted_by_user_id: number | null; document_id:number } | undefined;
    if (!r) throw notVisible('合同审核');
    if (r.status !== 'submitted') throw conflict('CONTRACT_STATE', '该审核已处理,结论不可更改');
    const { selfReview } = assertDistinctReviewer(db, auth, r.submitted_by_user_id, input.exceptionReason, '合同审核');
    if(legalEnabled(db,c))legalAccess(auth,['contract:review']);
    const binding=legalEnabled(db,c)?assertLegalDecision(db,id,r.document_id,input.decision==='approve',input.comment):{runId:null,override:false};
    const status = input.decision === 'approve' ? 'approved' : 'rejected';
    db.prepare('UPDATE ct_review SET status = ?, reviewed_by_user_id = ?, reviewed_at = ?, review_comment = ?, exception_reason = ?, self_review = ?, legal_run_id=?,override_high_risk=? WHERE id = ?')
      .run(status, auth?.userId ?? null, nowIso(), input.comment ?? null, input.exceptionReason ?? null, selfReview ? 1 : 0,binding.runId,binding.override?1:0, reviewId);
    bump(db, id);
    recordEvent(db, id, `review.${status === 'approved' ? 'approve' : 'reject'}`, { reviewId, legalRunId:binding.runId, overrideHighRisk:binding.override, comment: input.comment ?? null, selfReview, exceptionReason: input.exceptionReason ?? null });
  }).immediate();
  return getContractDetail(db, id);
}

export { computeChangeApprovalTier, submitContractChange, decideContractChange, updateContractChangeFiling } from './contract-change.service';

export {
  contractPaidInPeriod, contractPaymentTotals, contractReceivedInPeriod, contractReceiptTotals,
  submitContractPayment, decideContractPayment, payContractPayment,
  listContractSettlements, submitContractSettlement, decideContractSettlement,
  listContractReceipts, submitContractReceipt, decideContractReceipt, receiveContractReceipt,
} from './contract-settlement.service';

export {
  listContractGuarantees, createContractGuarantee, updateContractGuarantee,
  getContractWarranty, upsertContractWarranty,
  listContractDisputes, createContractDispute, updateContractDispute,
} from './contract-safeguard.service';

function saveLegalMetadata(db:DB,id:number,input:Partial<ContractUpdateRequest>,amount:bigint,estimatedCeiling?:bigint|null):void {
 const c=visibleContract(db,id);
 const category=input.legalCategory??c.legal_category;
 const important=input.isImportant??!!c.is_important;
 const procurement=input.isProcurement??!!c.is_procurement;
 const target=input.procurementTarget===undefined?c.procurement_target:input.procurementTarget;
 const method=input.procurementMethod===undefined?c.procurement_method:input.procurementMethod;
 const pricingMode=input.pricingMode??c.pricing_mode;
 const ceiling=estimatedCeiling===undefined?c.estimated_ceiling_cents:estimatedCeiling;
 const tierAmount=pricingMode==='unit_price'&&amount===0n&&ceiling!=null?BigInt(ceiling):amount;
 if(procurement&&['goods_procurement','small_construction','tech_service'].includes(category)&&(!target||!method))throw new AppError('VALIDATION_FAILED','采购合同必须选择采购对象和方式',400);
 db.prepare('UPDATE ct_contract SET legal_category=?,party_role=?,signing_entity_level=?,is_procurement=?,procurement_target=?,procurement_method=?,procurement_tier=?,is_important=? WHERE id=?').run(category,input.partyRole??c.party_role,input.signingEntityLevel??c.signing_entity_level,procurement?1:0,target,method,procurementTier(procurement,target,tierAmount,method),category==='important_special'||important||/股权|资产置换|资产委托管理|借贷|融资|担保|并购|重组|合资|长期合作|涉外/.test(input.name??c.name)?1:0,id);
}
