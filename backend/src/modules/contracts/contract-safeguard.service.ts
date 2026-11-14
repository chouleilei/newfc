import { requireEvidence } from './contract-controls';
import type { DB } from '../../db/connection';
import { AppError } from '../../core/errors';
import { currentAuth } from '../../core/request-context';
import { centsToDecimalOrNull, centsToDecimalString, formatScaled, parseDecimalToCents, parseScaled, RATIO_SCALE } from '../../core/decimal';
import { hasPermission, notVisible } from '../security/scope';
import type {
  ContractDetailDto, ContractDisputeCreateRequest, ContractDisputeDto, ContractDisputeUpdateRequest,
  ContractGuaranteeCreateRequest, ContractGuaranteeDto, ContractGuaranteeUpdateRequest,
  ContractWarrantyDto, ContractWarrantyUpsertRequest, DisputeStage, GuaranteeDirection, GuaranteeStatus, GuaranteeType, WarrantyConclusion,
  ContractEvaluationDto, ContractEvaluationRequest, EvaluationRecommendation,
} from '../../contracts/project-contract';
import { assertActive, bump, contractDoc, getContractDetail, recordEvent, visibleContract } from './contract.service';

const nowIso = () => new Date().toISOString();
const todayIso = () => nowIso().slice(0, 10);
const conflict = (code: string, message: string, details?: unknown) => new AppError(code, message, 409, undefined, details);
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const userName = (db: DB, id: number | null): string | null =>
  id === null ? null : (db.prepare('SELECT display_name FROM app_user WHERE id = ?').get(id) as { display_name: string } | undefined)?.display_name ?? `#${id}`;

/* ================= 保函 / 保证金 / 工程保险 ct_guarantee ================= */

function mapGuarantee(db: DB, r: Record<string, unknown>): ContractGuaranteeDto {
  return {
    id: Number(r.id),
    guaranteeType: r.guarantee_type as GuaranteeType,
    direction: r.direction as GuaranteeDirection,
    issuerName: String(r.issuer_name ?? ''),
    guaranteeNo: String(r.guarantee_no ?? ''),
    amount: centsToDecimalString(r.amount_cents as bigint),
    depositAmount: centsToDecimalString(r.deposit_cents as bigint),
    ratio: r.ratio_scaled == null ? null : formatScaled(r.ratio_scaled as bigint, RATIO_SCALE),
    effectiveDate: (r.effective_date as string | null) ?? null,
    expiryDate: (r.expiry_date as string | null) ?? null,
    status: r.status as GuaranteeStatus,
    claimOccurredAt: (r.claim_occurred_at as string | null) ?? null,
    claimReportedAt: (r.claim_reported_at as string | null) ?? null,
    returnedDate: (r.returned_date as string | null) ?? null,
    documentId: num(r.document_id),
    note: String(r.note ?? ''),
    createdBy: userName(db, num(r.created_by_user_id)),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export function listContractGuarantees(db: DB, contractId: number): ContractGuaranteeDto[] {
  visibleContract(db, contractId);
  return (db.prepare('SELECT * FROM ct_guarantee WHERE contract_id = ? ORDER BY id').safeIntegers(true).all(contractId) as Record<string, unknown>[])
    .map((r) => mapGuarantee(db, r));
}

export function createContractGuarantee(db: DB, id: number, input: ContractGuaranteeCreateRequest): ContractDetailDto {
  const amount = parseDecimalToCents(input.amount, { label: '保函/保险金额' });
  const deposit = parseDecimalToCents(input.depositAmount, { label: '押金金额' });
  if (amount < 0n || deposit < 0n) throw new AppError('VALIDATION_FAILED', '保函/押金金额不能为负', 400);
  const ratioScaled = input.ratio == null ? null : parseScaled(input.ratio, RATIO_SCALE, { label: '担保比例' });
  if (input.effectiveDate && input.expiryDate && input.effectiveDate > input.expiryDate) {
    throw new AppError('VALIDATION_FAILED', '保函生效日期不能晚于到期日期', 400);
  }
  db.transaction(() => {
    const c = visibleContract(db, id);
    assertActive(c, '登记保函/保证金');
    if (input.documentId) contractDoc(db, id, input.documentId);
    const now = nowIso();
    const gid = Number(db.prepare(`INSERT INTO ct_guarantee (
      contract_id, guarantee_type, direction, issuer_name, guarantee_no, amount_cents, deposit_cents, ratio_scaled,
      effective_date, expiry_date, status, document_id, note, created_by_user_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'active', ?, ?, ?, ?, ?)`).run(
      id, input.guaranteeType, input.direction, input.issuerName, input.guaranteeNo, amount, deposit, ratioScaled,
      input.effectiveDate ?? null, input.expiryDate ?? null, input.documentId ?? null, input.note ?? '',
      currentAuth()?.userId ?? null, now, now,
    ).lastInsertRowid);
    bump(db, id);
    recordEvent(db, id, 'guarantee.create', {
      guaranteeId: gid, guaranteeType: input.guaranteeType, guaranteeNo: input.guaranteeNo, amount: centsToDecimalString(amount),
    });
  }).immediate();
  return getContractDetail(db, id);
}

export function updateContractGuarantee(db: DB, id: number, guaranteeId: number, input: ContractGuaranteeUpdateRequest): ContractDetailDto {
  db.transaction(() => {
    const c = visibleContract(db, id);
    if (c.status === 'voided') throw conflict('CONTRACT_STATE', '已作废合同不能修改保函记录');
    const row = db.prepare('SELECT * FROM ct_guarantee WHERE id = ? AND contract_id = ?').safeIntegers(true).get(guaranteeId, id) as Record<string, unknown> | undefined;
    if (!row) throw notVisible('保函/保险记录');
    if (input.documentId) contractDoc(db, id, input.documentId);
    const nextStatus = input.status ?? (row.status as GuaranteeStatus);
    const nextEffective = input.effectiveDate !== undefined ? input.effectiveDate : (row.effective_date as string | null);
    const nextExpiry = input.expiryDate !== undefined ? input.expiryDate : (row.expiry_date as string | null);
    const nextReturned = input.returnedDate !== undefined ? input.returnedDate : (row.returned_date as string | null);
    const nextClaimedAt = input.claimOccurredAt !== undefined ? input.claimOccurredAt : (row.claim_occurred_at as string | null);
    const nextClaimReportedAt = input.claimReportedAt !== undefined ? input.claimReportedAt : (row.claim_reported_at as string | null);
    if (nextEffective && nextExpiry && nextEffective > nextExpiry) {
      throw new AppError('VALIDATION_FAILED', '保函生效日期不能晚于到期日期', 400);
    }
    if (nextStatus === 'returned' && !nextReturned) {
      throw new AppError('VALIDATION_FAILED', '保函/保证金标记退还清理时须填写退还日期', 400);
    }
    if (nextStatus === 'claimed' && !nextClaimedAt) {
      throw new AppError('VALIDATION_FAILED', '保函索赔/冻结须填写发生日期', 400);
    }
    if (nextClaimedAt && nextClaimReportedAt && nextClaimReportedAt < nextClaimedAt) {
      throw new AppError('VALIDATION_FAILED', '保函索赔报告日期不能早于索赔发生日期', 400);
    }
    db.prepare(`UPDATE ct_guarantee SET status = ?, effective_date = ?, expiry_date = ?, claim_occurred_at = ?, claim_reported_at = ?, returned_date = ?, document_id = COALESCE(?, document_id), note = COALESCE(?, note), updated_at = ? WHERE id = ?`)
      .run(nextStatus, nextEffective, nextExpiry, nextClaimedAt, nextClaimReportedAt, nextReturned, input.documentId ?? null, input.note ?? null, nowIso(), guaranteeId);
    bump(db, id);
    recordEvent(db, id, 'guarantee.update', {
      guaranteeId, status: nextStatus, expiryDate: nextExpiry, returnedDate: nextReturned, claimOccurredAt: nextClaimedAt, claimReportedAt: nextClaimReportedAt,
    });
  }).immediate();
  return getContractDetail(db, id);
}

/* ================= 质保期与签证 ct_warranty ================= */

function mapWarranty(db: DB, r: Record<string, unknown>): ContractWarrantyDto {
  return {
    id: Number(r.id),
    startDate: (r.start_date as string | null) ?? null,
    endDate: (r.end_date as string | null) ?? null,
    retentionAmount: centsToDecimalString(r.retention_cents as bigint),
    defectRecords: JSON.parse(String(r.defect_records_json || '[]')),
    inspectionDate: (r.inspection_date as string | null) ?? null,
    inspectionConclusion: (r.inspection_conclusion as WarrantyConclusion | null) ?? null,
    visaDocumentId: num(r.visa_document_id),
    releasedPaymentId: num(r.released_payment_id),
    reviewedBy: userName(db, num(r.reviewed_by_user_id)),
    reviewedAt: (r.reviewed_at as string | null) ?? null,
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export function getContractWarranty(db: DB, contractId: number): ContractWarrantyDto | null {
  visibleContract(db, contractId);
  const row = db.prepare('SELECT * FROM ct_warranty WHERE contract_id = ?').safeIntegers(true).get(contractId) as Record<string, unknown> | undefined;
  return row ? mapWarranty(db, row) : null;
}

export function upsertContractWarranty(db: DB, id: number, input: ContractWarrantyUpsertRequest): ContractDetailDto {
  const auth = currentAuth();
  const confirmingVisa = input.inspectionConclusion === 'passed' || (input.visaDocumentId !== undefined && input.visaDocumentId !== null);
  const reviewingInspection = confirmingVisa || (input.inspectionConclusion !== undefined && input.inspectionConclusion !== null);
  if (reviewingInspection && auth && !hasPermission(auth, 'contract:review')) {
    throw new AppError('FORBIDDEN', '质保期满签证确认需要 contract:review 权限', 403);
  }
  if (!reviewingInspection && auth && !hasPermission(auth, 'contract:write')) {
    throw new AppError('FORBIDDEN', '维护质保期与缺陷记录需要 contract:write 权限', 403);
  }
  const retention = input.retentionAmount !== undefined ? parseDecimalToCents(input.retentionAmount, { label: '质保金额' }) : undefined;
  if (retention !== undefined && retention < 0n) throw new AppError('VALIDATION_FAILED', '质保金额不能为负', 400);
  db.transaction(() => {
    const c = visibleContract(db, id);
    assertActive(c, '维护质保记录');
    if (input.visaDocumentId) requireEvidence(db, id, input.visaDocumentId, ['warranty_release_visa']);
    if (input.releasedPaymentId && !db.prepare("SELECT 1 FROM ct_payment WHERE id = ? AND contract_id = ? AND payment_type = 'warranty_release' AND status = 'paid'").get(input.releasedPaymentId, id)) {
      throw notVisible('质保尾款付款记录');
    }
    const existing = db.prepare('SELECT * FROM ct_warranty WHERE contract_id = ?').safeIntegers(true).get(id) as Record<string, unknown> | undefined;
    const value = (key: keyof ContractWarrantyUpsertRequest, column: string) => input[key] !== undefined ? input[key] : existing?.[column] ?? null;
    const nextStart = value('startDate', 'start_date') as string | null;
    const nextEnd = value('endDate', 'end_date') as string | null;
    const inspectionDate = value('inspectionDate', 'inspection_date') as string | null;
    const conclusion = value('inspectionConclusion', 'inspection_conclusion') as string | null;
    const visaId = value('visaDocumentId', 'visa_document_id') as number | bigint | null;
    const defects = input.defectRecords ?? JSON.parse(String(existing?.defect_records_json ?? '[]')) as { resolved: boolean }[];
    if (nextStart && nextEnd && nextStart > nextEnd) throw new AppError('VALIDATION_FAILED', '质保开始日期不能晚于结束日期', 400);
    if (conclusion === 'passed') {
      if (auth && !hasPermission(auth, 'contract:review')) throw new AppError('FORBIDDEN', '修改已通过的质保签证需要复核权限', 403);
      if (!nextStart || !nextEnd || !inspectionDate || inspectionDate < nextEnd || nextEnd > todayIso() || inspectionDate > todayIso()) throw conflict('WARRANTY_NOT_EXPIRED', '质保期满验收须具备有效起止日期，验收日不得早于期满或晚于实际日期');
      requireEvidence(db, id, visaId == null ? null : Number(visaId), ['warranty_release_visa']);
      if (defects.some(d => !d.resolved)) throw conflict('WARRANTY_DEFECTS_OPEN', '须先处理全部质保缺陷');
    }
    const now = nowIso();
    db.prepare(`INSERT INTO ct_warranty (contract_id, start_date, end_date, retention_cents, defect_records_json,
      inspection_date, inspection_conclusion, visa_document_id, released_payment_id, reviewed_by_user_id, reviewed_at, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(contract_id) DO UPDATE SET start_date = excluded.start_date, end_date = excluded.end_date,
      retention_cents = excluded.retention_cents, defect_records_json = excluded.defect_records_json,
      inspection_date = excluded.inspection_date, inspection_conclusion = excluded.inspection_conclusion,
      visa_document_id = excluded.visa_document_id, released_payment_id = excluded.released_payment_id,
      reviewed_by_user_id = excluded.reviewed_by_user_id, reviewed_at = excluded.reviewed_at, updated_at = excluded.updated_at`).run(
        id, nextStart, nextEnd, retention ?? existing?.retention_cents ?? 0n, JSON.stringify(defects), inspectionDate, conclusion,
        visaId, value('releasedPaymentId', 'released_payment_id'),
        reviewingInspection ? auth?.userId ?? null : existing?.reviewed_by_user_id ?? null,
        reviewingInspection ? now : existing?.reviewed_at ?? null, existing?.created_at ?? now, now,
      );
    bump(db, id);
    recordEvent(db, id, 'warranty.update', {
      inspectionConclusion: input.inspectionConclusion ?? null,
      inspectionDate: input.inspectionDate ?? null,
      visaDocumentId: input.visaDocumentId ?? null,
      releasedPaymentId: input.releasedPaymentId ?? null,
    });
  }).immediate();
  return getContractDetail(db, id);
}

/* ================= 纠纷与诉讼仲裁 ct_dispute (17 列台账) ================= */

function mapDispute(db: DB, r: Record<string, unknown>): ContractDisputeDto {
  return {
    id: Number(r.id),
    changeId: num(r.change_id),
    occurredDate: String(r.occurred_date),
    reportedToDeptAt: (r.reported_to_dept_at as string | null) ?? null,
    litigationType: String(r.litigation_type ?? ''),
    causeOfAction: String(r.cause_of_action ?? ''),
    counterpartyAndRole: String(r.counterparty_and_role ?? ''),
    stage: r.stage as DisputeStage,
    institutionName: String(r.institution_name ?? ''),
    caseNo: String(r.case_no ?? ''),
    involvedOrgName: String(r.involved_org_name ?? ''),
    ourLitigationRole: String(r.our_litigation_role ?? ''),
    acceptedDate: (r.accepted_date as string | null) ?? null,
    caseSummary: String(r.case_summary ?? ''),
    gmApprovedAt: (r.gm_approved_at as string | null) ?? null,
    legalDocForm: String(r.legal_doc_form ?? ''),
    closedDate: (r.closed_date as string | null) ?? null,
    disputeAmount: centsToDecimalString(r.dispute_cents as bigint),
    judgmentResult: String(r.judgment_result ?? ''),
    actualSettledAmount: centsToDecimalOrNull(r.actual_settled_cents as bigint | null),
    lawFirmAndLawyer: String(r.law_firm_and_lawyer ?? ''),
    filedToMgmtAt: (r.filed_to_mgmt_at as string | null) ?? null,
    filedToDisciplineAt: (r.filed_to_discipline_at as string | null) ?? null,
    createdBy: userName(db, num(r.created_by_user_id)),
    createdAt: String(r.created_at),
    updatedAt: String(r.updated_at),
  };
}

export function listContractDisputes(db: DB, contractId: number): ContractDisputeDto[] {
  visibleContract(db, contractId);
  return (db.prepare('SELECT * FROM ct_dispute WHERE contract_id = ? ORDER BY id').safeIntegers(true).all(contractId) as Record<string, unknown>[])
    .map((r) => mapDispute(db, r));
}

export function createContractDispute(db: DB, id: number, input: ContractDisputeCreateRequest): ContractDetailDto {
  const disputeCents = parseDecimalToCents(input.disputeAmount, { label: '涉案金额' });
  const actualCents = input.actualSettledAmount == null ? null : parseDecimalToCents(input.actualSettledAmount, { label: '实际获赔/支付金额' });
  if (disputeCents < 0n || (actualCents !== null && actualCents < 0n)) throw new AppError('VALIDATION_FAILED', '纠纷涉案金额不能为负', 400);
  db.transaction(() => {
    const c = visibleContract(db, id);
    if (c.status === 'voided') throw conflict('CONTRACT_STATE', '已作废合同不能登记纠纷记录');
    if (input.changeId && !db.prepare('SELECT 1 FROM ct_change WHERE id = ? AND contract_id = ?').get(input.changeId, id)) {
      throw notVisible('关联合同变更');
    }
    const now = nowIso();
    const closedDate = input.stage === 'closed' ? (input.closedDate ?? todayIso()) : (input.closedDate ?? null);
    const did = Number(db.prepare(`INSERT INTO ct_dispute (
      contract_id, change_id, occurred_date, reported_to_dept_at, litigation_type, cause_of_action, counterparty_and_role,
      stage, institution_name, case_no, involved_org_name, our_litigation_role, accepted_date, case_summary,
      gm_approved_at, legal_doc_form, closed_date, dispute_cents, judgment_result, actual_settled_cents,
      law_firm_and_lawyer, filed_to_mgmt_at, filed_to_discipline_at, created_by_user_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, input.changeId ?? null, input.occurredDate, input.reportedToDeptAt ?? null, input.litigationType ?? '',
      input.causeOfAction ?? '', input.counterpartyAndRole ?? '', input.stage, input.institutionName ?? '', input.caseNo ?? '',
      input.involvedOrgName ?? '', input.ourLitigationRole ?? '', input.acceptedDate ?? null, input.caseSummary ?? '',
      input.gmApprovedAt ?? null, input.legalDocForm ?? '', closedDate, disputeCents, input.judgmentResult ?? '', actualCents,
      input.lawFirmAndLawyer ?? '', input.filedToMgmtAt ?? null, input.filedToDisciplineAt ?? null, currentAuth()?.userId ?? null, now, now,
    ).lastInsertRowid);
    if (input.changeId) {
      db.prepare('UPDATE ct_change SET has_dispute = 1 WHERE id = ? AND contract_id = ?').run(input.changeId, id);
    }
    bump(db, id);
    recordEvent(db, id, 'dispute.create', { disputeId: did, stage: input.stage, disputeAmount: centsToDecimalString(disputeCents), caseNo: input.caseNo ?? '' });
  }).immediate();
  return getContractDetail(db, id);
}

export function updateContractDispute(db: DB, id: number, disputeId: number, input: ContractDisputeUpdateRequest): ContractDetailDto {
  const disputeCents = input.disputeAmount !== undefined ? parseDecimalToCents(input.disputeAmount, { label: '涉案金额' }) : undefined;
  const actualCents = input.actualSettledAmount === undefined ? undefined : (input.actualSettledAmount === null ? null : parseDecimalToCents(input.actualSettledAmount, { label: '实际获赔/支付金额' }));
  if ((disputeCents !== undefined && disputeCents < 0n) || (actualCents !== undefined && actualCents !== null && actualCents < 0n)) {
    throw new AppError('VALIDATION_FAILED', '纠纷涉案金额不能为负', 400);
  }
  db.transaction(() => {
    const c = visibleContract(db, id);
    if (c.status === 'voided') throw conflict('CONTRACT_STATE', '已作废合同不能更新纠纷记录');
    const row = db.prepare('SELECT * FROM ct_dispute WHERE id = ? AND contract_id = ?').safeIntegers(true).get(disputeId, id) as Record<string, unknown> | undefined;
    if (!row) throw notVisible('合同纠纷记录');
    if (input.changeId && !db.prepare('SELECT 1 FROM ct_change WHERE id = ? AND contract_id = ?').get(input.changeId, id)) {
      throw notVisible('关联合同变更');
    }
    const nextChangeId = input.changeId !== undefined ? input.changeId : num(row.change_id);
    const nextOccurredDate = input.occurredDate ?? String(row.occurred_date);
    const nextStage = input.stage ?? (row.stage as DisputeStage);
    const nextClosedDate = input.closedDate !== undefined ? input.closedDate : (nextStage === 'closed' ? ((row.closed_date as string | null) ?? todayIso()) : (row.closed_date as string | null));
    db.prepare(`UPDATE ct_dispute SET
      change_id = ?, occurred_date = ?,
      reported_to_dept_at = COALESCE(?, reported_to_dept_at), litigation_type = COALESCE(?, litigation_type),
      cause_of_action = COALESCE(?, cause_of_action), counterparty_and_role = COALESCE(?, counterparty_and_role),
      stage = ?, institution_name = COALESCE(?, institution_name), case_no = COALESCE(?, case_no),
      involved_org_name = COALESCE(?, involved_org_name), our_litigation_role = COALESCE(?, our_litigation_role),
      accepted_date = COALESCE(?, accepted_date), case_summary = COALESCE(?, case_summary),
      gm_approved_at = COALESCE(?, gm_approved_at), legal_doc_form = COALESCE(?, legal_doc_form),
      closed_date = ?, dispute_cents = COALESCE(?, dispute_cents), judgment_result = COALESCE(?, judgment_result),
      actual_settled_cents = ?, law_firm_and_lawyer = COALESCE(?, law_firm_and_lawyer),
      filed_to_mgmt_at = COALESCE(?, filed_to_mgmt_at), filed_to_discipline_at = COALESCE(?, filed_to_discipline_at), updated_at = ? WHERE id = ?`).run(
      nextChangeId, nextOccurredDate,
      input.reportedToDeptAt ?? null, input.litigationType ?? null, input.causeOfAction ?? null, input.counterpartyAndRole ?? null,
      nextStage, input.institutionName ?? null, input.caseNo ?? null, input.involvedOrgName ?? null, input.ourLitigationRole ?? null,
      input.acceptedDate ?? null, input.caseSummary ?? null, input.gmApprovedAt ?? null, input.legalDocForm ?? null, nextClosedDate,
      disputeCents ?? null, input.judgmentResult ?? null,
      actualCents !== undefined ? actualCents : (row.actual_settled_cents as bigint | null),
      input.lawFirmAndLawyer ?? null, input.filedToMgmtAt ?? null, input.filedToDisciplineAt ?? null, nowIso(), disputeId,
    );
    if (nextChangeId) {
      db.prepare('UPDATE ct_change SET has_dispute = 1 WHERE id = ? AND contract_id = ?').run(nextChangeId, id);
    }
    bump(db, id);
    recordEvent(db, id, 'dispute.update', { disputeId, stage: nextStage, filedToMgmtAt: input.filedToMgmtAt ?? null, filedToDisciplineAt: input.filedToDisciplineAt ?? null });
  }).immediate();
  return getContractDetail(db, id);
}

/* ================= 履约后评价 ct_evaluation（联动供应商库） ================= */

function mapEvaluation(db: DB, r: Record<string, unknown>): ContractEvaluationDto {
  return {
    id: Number(r.id),
    contractId: Number(r.contract_id),
    supplierId: num(r.supplier_id),
    qualityScore: Number(r.quality_score),
    scheduleScore: Number(r.schedule_score),
    serviceScore: Number(r.service_score),
    totalScore: Number(r.total_score),
    recommendation: r.recommendation as EvaluationRecommendation,
    comment: String(r.comment ?? ''),
    evaluatedBy: userName(db, num(r.evaluated_by_user_id)),
    evaluatedAt: String(r.evaluated_at),
  };
}

export function getContractEvaluation(db: DB, contractId: number): ContractEvaluationDto | null {
  visibleContract(db, contractId);
  const row = db.prepare('SELECT * FROM ct_evaluation WHERE contract_id = ?').get(contractId) as Record<string, unknown> | undefined;
  return row ? mapEvaluation(db, row) : null;
}

export function upsertContractEvaluation(db: DB, id: number, input: ContractEvaluationRequest): ContractDetailDto {
  db.transaction(() => {
    const c = visibleContract(db, id);
    if (c.status !== 'closed') {
      throw conflict('CONTRACT_STATE', '只有履约完结(closed)的合同才能进行履约后评价');
    }
    const total = input.qualityScore + input.scheduleScore + input.serviceScore;
    const now = nowIso();
    const userId = currentAuth()?.userId ?? null;
    const existing = db.prepare('SELECT id FROM ct_evaluation WHERE contract_id = ?').get(id) as { id: number } | undefined;
    if (!existing) {
      db.prepare(`INSERT INTO ct_evaluation (contract_id, supplier_id, quality_score, schedule_score, service_score, total_score, recommendation, comment, evaluated_by_user_id, evaluated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
        id, c.supplier_id, input.qualityScore, input.scheduleScore, input.serviceScore, total, input.recommendation, input.comment ?? '', userId, now,
      );
    } else {
      db.prepare(`UPDATE ct_evaluation SET supplier_id = ?, quality_score = ?, schedule_score = ?, service_score = ?, total_score = ?,
        recommendation = ?, comment = ?, evaluated_by_user_id = ?, evaluated_at = ? WHERE contract_id = ?`).run(
        c.supplier_id, input.qualityScore, input.scheduleScore, input.serviceScore, total, input.recommendation, input.comment ?? '', userId, now, id,
      );
    }
    bump(db, id);
    if (c.supplier_id) db.prepare(`INSERT INTO md_supplier_evaluation (contract_id, supplier_id, quality_score, schedule_score, service_score, recommendation, comment, evaluated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?) ON CONFLICT(contract_id) DO UPDATE SET supplier_id = excluded.supplier_id,
      quality_score = excluded.quality_score, schedule_score = excluded.schedule_score, service_score = excluded.service_score,
      recommendation = excluded.recommendation, comment = excluded.comment, evaluated_at = excluded.evaluated_at`).run(
        id, c.supplier_id, input.qualityScore, input.scheduleScore, input.serviceScore, input.recommendation, input.comment ?? '', now);
    recordEvent(db, id, 'evaluation.upsert', {
      supplierId: c.supplier_id, totalScore: total, recommendation: input.recommendation,
    });
  }).immediate();
  return getContractDetail(db, id);
}
