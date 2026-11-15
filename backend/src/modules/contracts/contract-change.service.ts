import { assertContractFunding } from './contract-funding';
import { legalEntityOrgId, requireEvidence } from './contract-controls';
import type { DB } from '../../db/connection';
import type { ProcurementTier } from '../../contracts/contract-legal-review';
import { AppError } from '../../core/errors';
import { currentAuth } from '../../core/request-context';
import { centsToDecimalString, parseDecimalToCents, ratioString } from '../../core/decimal';
import { assertDistinctReviewer } from '../security/review';
import { notVisible } from '../security/scope';
import { getSetting } from '../settings/business-settings';
import type {
  ChangeApprovalTier, ChangeKind, ChangeTierPreviewDto, ContractChangeFilingRequest, ContractChangeRequest, ContractDetailDto, DecisionRequest,
} from '../../contracts/project-contract';
import { procurementTier } from './legal-context';
import { sumPayments, sumReceipts } from './contract-settlement.service';
import {
  assertActive, bump, contractDoc, currentCents, getContractDetail, recordEvent, visibleContract, type ContractRow,
} from './contract.service';

const nowIso = () => new Date().toISOString();
const conflict = (code: string, message: string, details?: unknown) => new AppError(code, message, 409, undefined, details);
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

const CHANGE_STAGES = ['performance', 'settlement', 'warranty'] as const;

export const CHANGE_TIER_RANK: Record<ChangeApprovalTier, number> = {
  undertaker_unit: 1,
  undertaker_vp: 2,
  tech_and_undertaker_vp: 3,
  dual_vp: 4,
  general_manager: 5,
  management_board: 6,
};

export const CHANGE_TIER_LABEL: Record<ChangeApprovalTier, string> = {
  undertaker_unit: '承办单位自行审批（报技术归口与企管部备案）',
  undertaker_vp: '承办单位分管副总审批',
  tech_and_undertaker_vp: '技术归口审查 + 承办单位分管副总审批',
  dual_vp: '承办单位分管副总 + 合同归口分管副总审批',
  general_manager: '公司总经理审批',
  management_board: '公司经营层审批',
};

export function normalizeSupplementNo(no: string): string {
  return no.normalize('NFKC').replace(/\s+/g, '').toUpperCase();
}

/** 附件 5 变更/索赔分级纯函数（全部整数分比较，零浮点误差）。 */
export function computeChangeApprovalTier(params: {
  originalCents: bigint;
  estimatedCeilingCents?: bigint | null;
  priorApprovedPositiveCents: bigint;
  deltaCents: bigint;
  changeKind: ChangeKind;
  procurementTier: ProcurementTier | null;
  involvesBizOrEntityChange: boolean;
  involvesTechChange: boolean;
  orMode: 'min' | 'max';
}): {
  tier: ChangeApprovalTier;
  requireTechSpecialAudit: boolean;
  requireDisciplineFiling: boolean;
} {
  const baseCents = params.originalCents > 0n ? params.originalCents : (params.estimatedCeilingCents ?? 0n);
  if (params.changeKind === 'terminate') {
    return { tier: 'general_manager', requireTechSpecialAudit: false, requireDisciplineFiling: false };
  }
  if (params.changeKind === 'suspend') {
    return {
      tier: params.involvesTechChange ? 'tech_and_undertaker_vp' : 'undertaker_vp',
      requireTechSpecialAudit: false,
      requireDisciplineFiling: false,
    };
  }
  if (params.changeKind === 'counter_claim') {
    return {
      tier: params.involvesTechChange ? 'tech_and_undertaker_vp' : 'undertaker_unit',
      requireTechSpecialAudit: false,
      requireDisciplineFiling: false,
    };
  }
  if (params.deltaCents <= 0n) {
    if (params.involvesTechChange) {
      return { tier: 'dual_vp', requireTechSpecialAudit: false, requireDisciplineFiling: false };
    }
    if (params.involvesBizOrEntityChange && (params.procurementTier === 'tier_1' || params.procurementTier === 'tier_2')) {
      return { tier: 'undertaker_vp', requireTechSpecialAudit: false, requireDisciplineFiling: false };
    }
    return { tier: 'undertaker_unit', requireTechSpecialAudit: false, requireDisciplineFiling: false };
  }

  const requireTechSpecialAudit = baseCents > 0n && (
    params.deltaCents * 10n > baseCents ||
    (params.priorApprovedPositiveCents + params.deltaCents) * 10n > baseCents
  );
  const requireDisciplineFiling = true;

  const hitCumulativeThreshold = params.priorApprovedPositiveCents >= 500_000_000n ||
    (baseCents > 0n && params.priorApprovedPositiveCents * 10n >= baseCents);
  if (hitCumulativeThreshold) {
    return { tier: 'management_board', requireTechSpecialAudit, requireDisciplineFiling };
  }

  const fits = (pct: bigint, fixedCents: bigint): boolean => {
    if (baseCents <= 0n) return params.deltaCents <= fixedCents;
    const pctOk = params.deltaCents * 100n <= baseCents * pct;
    const fixedOk = params.deltaCents <= fixedCents;
    return params.orMode === 'min' ? (pctOk && fixedOk) : (pctOk || fixedOk);
  };

  let tier: ChangeApprovalTier;
  if (fits(2n, 20_000_000n)) {
    tier = params.involvesTechChange ? 'tech_and_undertaker_vp' : 'undertaker_unit';
  } else if (fits(4n, 50_000_000n)) {
    tier = 'dual_vp';
  } else if (fits(6n, 100_000_000n)) {
    tier = 'general_manager';
  } else {
    tier = 'management_board';
  }

  return { tier, requireTechSpecialAudit, requireDisciplineFiling };
}

export function assertGuarantorConsent(db: DB, contractId: number, guarantorConsentDocId?: number | null, evidenceDocId?: number | null, changeId: number | null = null): void {
  const activeG = (db.prepare("SELECT COUNT(*) AS n FROM ct_guarantee WHERE contract_id = ? AND status = 'active'").get(contractId) as { n: number }).n;
  if (activeG === 0) {
    if (guarantorConsentDocId) requireEvidence(db, contractId, guarantorConsentDocId, ['guarantor_consent'], changeId);
    return;
  }
  if (guarantorConsentDocId) {
    requireEvidence(db, contractId, guarantorConsentDocId, ['guarantor_consent'], changeId);
    return;
  }
  if (evidenceDocId) {
    const d = db.prepare('SELECT evidence_kind, change_id FROM ct_document WHERE id = ? AND contract_id = ? AND withdrawn_at IS NULL').get(evidenceDocId, contractId) as { evidence_kind: string | null; change_id: number | null } | undefined;
    if (d?.evidence_kind === 'guarantor_consent' && (d.change_id === null || d.change_id === changeId)) return;
  }
  throw conflict('GUARANTOR_CONSENT_REQUIRED', '合同存在有效担保/保函记录，发生变更、中止或解除须附担保单位书面同意函（制度 10.8/10.9）');
}

export function assertChangeKeepsPaid(c: ContractRow, delta: bigint): void {
  if (c.pricing_mode === 'unit_price') return;
  const after = currentCents(c) + delta;
  if (after < BigInt(c.paid_cents)) {
    throw conflict('CONTRACT_AMOUNT_BELOW_PAID', `变更后当前金额 ${centsToDecimalString(after)} 将低于已付 ${centsToDecimalString(c.paid_cents)}`,
      { currentAmount: centsToDecimalString(currentCents(c)), paidAmount: centsToDecimalString(c.paid_cents), afterChange: centsToDecimalString(after) });
  }
  if (after < BigInt(c.settled_gross_cents)) throw conflict('CONTRACT_AMOUNT_BELOW_SETTLED', '变更后金额低于累计已批准结算总额');
  if (after < BigInt(c.received_cents)) {
    throw conflict('CONTRACT_AMOUNT_BELOW_RECEIVED', `变更后当前金额 ${centsToDecimalString(after)} 将低于已收 ${centsToDecimalString(c.received_cents)}`,
      { currentAmount: centsToDecimalString(currentCents(c)), receivedAmount: centsToDecimalString(c.received_cents), afterChange: centsToDecimalString(after) });
  }
}

function changeInputFromRow(ch: Record<string, unknown>): ContractChangeRequest {
  return {
    changeKind: ch.change_kind as ChangeKind, delta: centsToDecimalString(ch.delta_cents as bigint),
    reason: String(ch.reason), changeMatter: String(ch.change_matter ?? ''), evidenceDocumentId: Number(ch.evidence_document_id),
    actualApprovalTier: ch.actual_approval_tier as ChangeApprovalTier | null,
    decisionMethod: ch.decision_method as ContractChangeRequest['decisionMethod'], meetingType: ch.meeting_type as ContractChangeRequest['meetingType'],
    decisionMethodOther: String(ch.decision_method_other ?? ''), meetingTypeOther: String(ch.meeting_type_other ?? ''),
    finalApproverName: String(ch.final_approver_name ?? ''), finalApproverTitle: String(ch.final_approver_title ?? ''),
    involvesBizOrEntityChange: !!Number(ch.involves_biz_or_entity_change), involvesTechChange: !!Number(ch.involves_tech_change),
    isIndependentDelegable: !!Number(ch.is_independent_delegable), techReviewAppliedAt: ch.tech_review_applied_at as string | null,
    techReviewRepliedAt: ch.tech_review_replied_at as string | null,
    techSpecialAuditDocId: num(ch.tech_special_audit_doc_id), outOfPlanDocId: num(ch.out_of_plan_doc_id),
    guarantorConsentDocumentId: num(ch.guarantor_consent_doc_id),
  };
}

function assertChangeGovernance(db: DB, c: ContractRow, input: ContractChangeRequest, delta: bigint, changeId: number | null = null) {
  const prior = (db.prepare("SELECT COALESCE(SUM(delta_cents), 0) AS s FROM ct_change WHERE contract_id = ? AND status = 'approved' AND delta_cents > 0 AND change_kind IN ('change','claim_by_contractor')").safeIntegers(true).get(c.id) as { s: bigint }).s;
  const info = computeChangeApprovalTier({ originalCents: BigInt(c.original_cents), estimatedCeilingCents: c.estimated_ceiling_cents,
    priorApprovedPositiveCents: prior, deltaCents: delta, changeKind: input.changeKind ?? 'change',
    procurementTier: procurementTier(!!c.is_procurement, c.procurement_target, currentCents(c), c.procurement_method),
    involvesBizOrEntityChange: !!input.involvesBizOrEntityChange, involvesTechChange: !!input.involvesTechChange,
    orMode: getSetting<'min' | 'max'>(db, 'contract.change_or_mode') });
  if (!input.actualApprovalTier || CHANGE_TIER_RANK[input.actualApprovalTier] < CHANGE_TIER_RANK[info.tier]) throw conflict('CONTRACT_CHANGE_TIER_MISMATCH', `按最新累计事实要求「${CHANGE_TIER_LABEL[info.tier]}」`, { requiredTier: info.tier });
  if (!input.changeMatter?.trim() || !input.finalApproverName?.trim() || !input.finalApproverTitle?.trim() || !input.decisionMethod) throw conflict('CONTRACT_CHANGE_GOVERNANCE_REQUIRED', '须填写变更事项、决策方式及最终审批人姓名和身份');
  if (input.isIndependentDelegable) throw conflict('CONTRACT_CHANGE_EVADE_PROCUREMENT', '独立委托事项须重新采购');
  if (input.decisionMethod === 'meeting' && !input.meetingType) throw conflict('CONTRACT_CHANGE_GOVERNANCE_REQUIRED', '会议决策须填写会议形式');
  if (input.decisionMethod === 'other' && !input.decisionMethodOther?.trim()) throw conflict('CONTRACT_CHANGE_GOVERNANCE_REQUIRED', '其他决策方式须说明');
  if (input.meetingType === 'other' && !input.meetingTypeOther?.trim()) throw conflict('CONTRACT_CHANGE_GOVERNANCE_REQUIRED', '其他会议形式须说明');
  if (info.requireTechSpecialAudit || input.involvesTechChange) {
    if (!input.techSpecialAuditDocId) throw conflict('TECH_SPECIAL_AUDIT_REQUIRED', '增额超过10%或技术方案/质量标准变更须技术归口专项复核意见');
    requireEvidence(db, c.id, input.techSpecialAuditDocId, ['tech_special_audit'], changeId);
  }
  if (input.changeKind === 'terminate') requireEvidence(db, c.id, input.evidenceDocumentId, ['termination_agreement'], changeId);
  assertGuarantorConsent(db, c.id, input.guarantorConsentDocumentId, input.evidenceDocumentId, changeId);
  assertContractFunding(db, c, { delta, outOfPlanDocId: input.outOfPlanDocId });
  return info;
}

function supplementNoExists(db: DB, orgRootId: number, norm: string, excludeId = 0): boolean {
  const rows = db.prepare(`SELECT c.org_id, c.signing_entity_level FROM ct_change ch JOIN ct_contract c ON c.id = ch.contract_id WHERE ch.normalized_supplement_no = ? AND ch.id <> ?`).all(norm, excludeId) as { org_id: number; signing_entity_level: string }[];
  return rows.some(c => legalEntityOrgId(db, c.org_id, c.signing_entity_level) === orgRootId);
}

export function submitContractChange(db: DB, id: number, input: ContractChangeRequest): ContractDetailDto {
  const delta = parseDecimalToCents(input.delta ?? '0', { label: '变更金额' });
  const changeKind: ChangeKind = input.changeKind ?? 'change';
  if (changeKind === 'suspend' || changeKind === 'terminate') {
    if (delta !== 0n) throw new AppError('VALIDATION_FAILED', '中止或解除记录的变更金额应为 0', 400);
  }
  if (input.isIndependentDelegable) {
    throw conflict('CONTRACT_CHANGE_EVADE_PROCUREMENT', '与原合同无关或具备独立委托条件且超范围事项，不得通过变更办理，请按《采购管理办法》重新选定相对方（制度 9.1.4）');
  }

  db.transaction(() => {
    const c = visibleContract(db, id);
    if (!(c.status === 'suspended' && changeKind === 'terminate')) assertActive(c, '提交变更');
    if (!(CHANGE_STAGES as readonly string[]).includes(c.stage)) {
      throw conflict('CONTRACT_STATE', '只能在「履约执行」「验收结算」「质保维护」阶段提交变更/索赔/中止/解除');
    }
    if (c.stage === 'warranty' && !['change', 'suspend', 'terminate', 'counter_claim'].includes(changeKind)) {
      throw conflict('CONTRACT_STATE', '质保维护阶段不能提交承包人增项索赔');
    }
    contractDoc(db, id, input.evidenceDocumentId);
    if (input.techSpecialAuditDocId) requireEvidence(db, id, input.techSpecialAuditDocId, ['tech_special_audit']);
    assertGuarantorConsent(db, id, input.guarantorConsentDocumentId ?? null, input.evidenceDocumentId);

    if (changeKind === 'terminate') {
      requireEvidence(db, id, input.evidenceDocumentId, ['termination_agreement']);
    }

    const priorPos = (db.prepare("SELECT COALESCE(SUM(CASE WHEN delta_cents > 0 THEN delta_cents ELSE 0 END), 0) AS s FROM ct_change WHERE contract_id = ? AND status = 'approved' AND change_kind IN ('change','claim_by_contractor')")
      .safeIntegers(true).get(id) as { s: bigint }).s;
    const tierAmt = c.pricing_mode === 'unit_price' && BigInt(c.original_cents) === 0n && c.estimated_ceiling_cents !== null
      ? BigInt(c.estimated_ceiling_cents) : currentCents(c);
    const pTier = procurementTier(!!c.is_procurement, c.procurement_target, tierAmt, c.procurement_method);
    const orMode = getSetting<'min' | 'max'>(db, 'contract.change_or_mode');
    const tierInfo = computeChangeApprovalTier({
      originalCents: BigInt(c.original_cents),
      estimatedCeilingCents: c.estimated_ceiling_cents,
      priorApprovedPositiveCents: priorPos,
      deltaCents: delta,
      changeKind,
      procurementTier: pTier,
      involvesBizOrEntityChange: !!input.involvesBizOrEntityChange,
      involvesTechChange: !!input.involvesTechChange,
      orMode,
    });

    if (changeKind === 'terminate' && (!input.actualApprovalTier || CHANGE_TIER_RANK[input.actualApprovalTier] < CHANGE_TIER_RANK.general_manager)) {
      throw conflict('CONTRACT_CHANGE_TIER_MISMATCH', '合同解除须经公司总经理及以上批准（制度 10.8）', { requiredTier: 'general_manager', actualTier: input.actualApprovalTier ?? null });
    }
    if (!input.actualApprovalTier || CHANGE_TIER_RANK[input.actualApprovalTier] < CHANGE_TIER_RANK[tierInfo.tier]) {
      throw conflict('CONTRACT_CHANGE_TIER_MISMATCH', `实际审批层级低于附件 5 要求层级「${CHANGE_TIER_LABEL[tierInfo.tier]}」`, {
        requiredTier: tierInfo.tier, actualTier: input.actualApprovalTier,
      });
    }
    if (tierInfo.requireTechSpecialAudit && !input.techSpecialAuditDocId) {
      throw conflict('TECH_SPECIAL_AUDIT_REQUIRED', '单次或累计增额超过原合同金额 10%，须上传技术归口部门专项全面复核意见（制度 9.1.2）');
    }

    assertChangeGovernance(db, c, input, delta);
    assertChangeKeepsPaid(c, delta);

    const orgRootId = legalEntityOrgId(db, c.org_id, c.signing_entity_level);
    const suppNo = input.supplementNo?.trim() || null;
    const normSuppNo = suppNo ? normalizeSupplementNo(suppNo) : null;
    if (normSuppNo && supplementNoExists(db, orgRootId, normSuppNo)) {
      throw conflict('SUPPLEMENT_NO_EXISTS', `同一法人单位下补充协议编号 ${suppNo} 已存在`);
    }

    const cid = Number(db.prepare(`INSERT INTO ct_change (
      contract_id, org_root_id, change_kind, delta_cents, change_matter, reason, evidence_document_id,
      involves_biz_or_entity_change, involves_tech_change, is_independent_delegable,
      decision_method, decision_method_other, meeting_type, meeting_type_other, final_approver_name, final_approver_title,
      required_approval_tier, actual_approval_tier, supplement_no, normalized_supplement_no, has_dispute,
      tech_review_applied_at, tech_review_replied_at, tech_special_audit_doc_id, out_of_plan_doc_id, guarantor_consent_doc_id, discipline_filed_at,
      adverse_occurred_at, adverse_reported_at,
      submitted_by_user_id, submitted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, orgRootId, changeKind, delta, input.changeMatter ?? '', input.reason, input.evidenceDocumentId,
      input.involvesBizOrEntityChange ? 1 : 0, input.involvesTechChange ? 1 : 0, 0,
      input.decisionMethod ?? null, input.decisionMethodOther ?? '', input.meetingType ?? null, input.meetingTypeOther ?? '',
      input.finalApproverName ?? '', input.finalApproverTitle ?? '',
      tierInfo.tier, input.actualApprovalTier ?? null, suppNo, normSuppNo, input.hasDispute ? 1 : 0,
      input.techReviewAppliedAt ?? null, input.techReviewRepliedAt ?? null, input.techSpecialAuditDocId ?? null,
      input.outOfPlanDocId ?? null, input.guarantorConsentDocumentId ?? null, input.disciplineFiledAt ?? null,
      input.adverseOccurredAt ?? null, input.adverseReportedAt ?? null,
      currentAuth()?.userId ?? null, nowIso(),
    ).lastInsertRowid);

    bump(db, id);
    recordEvent(db, id, 'change.submit', {
      changeId: cid, changeKind, delta: centsToDecimalString(delta), requiredApprovalTier: tierInfo.tier,
      actualApprovalTier: input.actualApprovalTier ?? null, supplementNo: suppNo, reason: input.reason,
    });
  }).immediate();
  return getContractDetail(db, id);
}

export function decideContractChange(db: DB, id: number, changeId: number, input: DecisionRequest): ContractDetailDto {
  const auth = currentAuth();
  db.transaction(() => {
    const c = visibleContract(db, id);
    const ch = db.prepare('SELECT * FROM ct_change WHERE id = ? AND contract_id = ?')
      .safeIntegers(true).get(changeId, id) as
      { id: bigint; status: string; change_kind: ChangeKind; delta_cents: bigint; reason: string; submitted_by_user_id: bigint | null; [key: string]: unknown } | undefined;
    if (!ch) throw notVisible('合同变更');
    if (!(c.status === 'suspended' && ch.change_kind === 'terminate')) assertActive(c, '复核变更');
    if (ch.status !== 'submitted') throw conflict('CONTRACT_STATE', '该变更已复核,结论不可更改');
    const { selfReview } = assertDistinctReviewer(db, auth, num(ch.submitted_by_user_id), input.exceptionReason, '合同变更');
    const approve = input.decision === 'approve';
    if (approve) {
      const governance = changeInputFromRow(ch);
      const required = assertChangeGovernance(db, c, governance, ch.delta_cents, changeId);
      db.prepare('UPDATE ct_change SET required_approval_tier = ? WHERE id = ?').run(required.tier, changeId);
      assertChangeKeepsPaid(c, ch.delta_cents);
      if (c.pricing_mode === 'lump_sum') {
        const approvedUnpaid = sumPayments(db, id, ['approved']);
        if (currentCents(c) + ch.delta_cents < BigInt(c.paid_cents) + approvedUnpaid) {
          throw conflict('CONTRACT_AMOUNT_BELOW_PAID', '变更后当前金额将低于 已付 + 已批准未付', { approvedUnpaid: centsToDecimalString(approvedUnpaid) });
        }
        const approvedUnreceived = sumReceipts(db, id, ['approved']);
        if (currentCents(c) + ch.delta_cents < BigInt(c.received_cents) + approvedUnreceived) {
          throw conflict('CONTRACT_AMOUNT_BELOW_RECEIVED', '变更后当前金额将低于 已收 + 已批准未收', { approvedUnreceived: centsToDecimalString(approvedUnreceived) });
        }
      }
      if (ch.change_kind === 'terminate') {
        const openPay = (db.prepare("SELECT COUNT(*) AS n FROM ct_payment WHERE contract_id = ? AND status IN ('submitted','approved')").get(id) as { n: number }).n;
        const openRec = (db.prepare("SELECT COUNT(*) AS n FROM ct_receipt WHERE contract_id = ? AND status IN ('submitted','approved')").get(id) as { n: number }).n;
        const openSet = (db.prepare("SELECT COUNT(*) AS n FROM ct_settlement WHERE contract_id = ? AND status = 'submitted'").get(id) as { n: number }).n;
        if (openPay || openRec || openSet) throw conflict('CONTRACT_STATE', '存在未结清的收付款或待复核结算单，不能批准解除');
      }
      if (ch.delta_cents !== 0n) {
        db.prepare('UPDATE ct_contract SET approved_change_cents = approved_change_cents + ? WHERE id = ?').run(ch.delta_cents, id);
      }
      if (ch.change_kind === 'suspend') {
        db.prepare("UPDATE ct_contract SET status = 'suspended', status_reason = ? WHERE id = ?").run(ch.reason, id);
        recordEvent(db, id, 'suspend', { reason: ch.reason, changeId }, { from: c.stage, to: c.stage });
      } else if (ch.change_kind === 'terminate') {
        db.prepare("UPDATE ct_contract SET status = 'terminated', status_reason = ?, completed_date = ? WHERE id = ?").run(ch.reason, nowIso().slice(0,10), id);
        recordEvent(db, id, 'terminate', { reason: ch.reason, changeId }, { from: c.stage, to: c.stage });
      }
    }
    db.prepare('UPDATE ct_change SET status = ?, reviewed_by_user_id = ?, reviewed_at = ?, review_comment = ?, exception_reason = ?, self_review = ? WHERE id = ?')
      .run(approve ? 'approved' : 'rejected', auth?.userId ?? null, nowIso(), input.comment ?? null, input.exceptionReason ?? null, selfReview ? 1 : 0, changeId);
    bump(db, id);
    recordEvent(db, id, `change.${approve ? 'approve' : 'reject'}`, {
      changeId, changeKind: ch.change_kind, delta: centsToDecimalString(ch.delta_cents),
      currentAmountAfter: centsToDecimalString(currentCents(c) + (approve ? ch.delta_cents : 0n)), selfReview,
      exceptionReason: input.exceptionReason ?? null,
    });
  }).immediate();
  return getContractDetail(db, id);
}

export function updateContractChangeFiling(db: DB, id: number, changeId: number, input: ContractChangeFilingRequest): ContractDetailDto {
  db.transaction(() => {
    const c = visibleContract(db, id);
    if (c.status === 'voided') throw conflict('CONTRACT_STATE', '已作废合同不能更新变更备案信息');
    const ch = db.prepare('SELECT id, org_root_id FROM ct_change WHERE id = ? AND contract_id = ?').get(changeId, id) as { id: number; org_root_id: number | null } | undefined;
    if (!ch) throw notVisible('合同变更');
    const orgRootId = legalEntityOrgId(db, c.org_id, c.signing_entity_level);
    if (input.supplementNo !== undefined) {
      const suppNo = input.supplementNo?.trim() || null;
      const norm = suppNo ? normalizeSupplementNo(suppNo) : null;
      if (norm && supplementNoExists(db, orgRootId, norm, changeId)) {
        throw conflict('SUPPLEMENT_NO_EXISTS', `同一法人单位下补充协议编号 ${suppNo} 已存在`);
      }
      db.prepare('UPDATE ct_change SET supplement_no = ?, normalized_supplement_no = ?, org_root_id = ? WHERE id = ?').run(suppNo, norm, orgRootId, changeId);
    }
    if (input.disciplineFiledAt !== undefined) {
      db.prepare('UPDATE ct_change SET discipline_filed_at = ? WHERE id = ?').run(input.disciplineFiledAt, changeId);
    }
    if (input.techReviewRepliedAt !== undefined) {
      db.prepare('UPDATE ct_change SET tech_review_replied_at = ? WHERE id = ?').run(input.techReviewRepliedAt, changeId);
    }
    if (input.hasDispute !== undefined) {
      db.prepare('UPDATE ct_change SET has_dispute = ? WHERE id = ?').run(input.hasDispute ? 1 : 0, changeId);
    }
    if (input.adverseOccurredAt !== undefined) {
      db.prepare('UPDATE ct_change SET adverse_occurred_at = ? WHERE id = ?').run(input.adverseOccurredAt, changeId);
    }
    if (input.adverseReportedAt !== undefined) {
      db.prepare('UPDATE ct_change SET adverse_reported_at = ? WHERE id = ?').run(input.adverseReportedAt, changeId);
    }
    bump(db, id);
    recordEvent(db, id, 'change.filing', { changeId, ...input });
  }).immediate();
  return getContractDetail(db, id);
}
export function previewContractChangeTier(
  db: DB,
  contractId: number,
  opts: {
    delta?: string;
    changeKind?: ChangeKind;
    involvesBizOrEntityChange?: boolean;
    involvesTechChange?: boolean;
  } = {},
): ChangeTierPreviewDto {
  const c = visibleContract(db, contractId);
  const deltaCents = opts.delta ? parseDecimalToCents(opts.delta, { label: '变更金额' }) : 0n;
  const orMode: 'min' | 'max' = getSetting(db, 'contract.change_or_mode') === 'max' ? 'max' : 'min';
  const priorPos = (
    db
      .prepare("SELECT COALESCE(SUM(CASE WHEN delta_cents > 0 THEN delta_cents ELSE 0 END), 0) AS s FROM ct_change WHERE contract_id = ? AND status = 'approved'")
      .safeIntegers(true)
      .get(contractId) as { s: bigint }
  ).s;
  const originalCents = BigInt(c.original_cents);
  const estCents = c.estimated_ceiling_cents === null ? null : BigInt(c.estimated_ceiling_cents);
  const tierAmt = c.pricing_mode === 'unit_price' && originalCents === 0n && estCents !== null ? estCents : originalCents;
  const procTier = procurementTier(!!c.is_procurement, c.procurement_target, tierAmt, c.procurement_method);
  const computed = computeChangeApprovalTier({
    originalCents,
    estimatedCeilingCents: estCents,
    priorApprovedPositiveCents: priorPos,
    deltaCents,
    changeKind: opts.changeKind ?? 'change',
    procurementTier: procTier,
    involvesBizOrEntityChange: !!opts.involvesBizOrEntityChange,
    involvesTechChange: !!opts.involvesTechChange,
    orMode,
  });
  const baseCents = originalCents > 0n ? originalCents : (estCents ?? 0n);
  const deltaRatio = baseCents > 0n ? ratioString(deltaCents < 0n ? -deltaCents : deltaCents, baseCents) : null;
  const notes: string[] = [CHANGE_TIER_LABEL[computed.tier]];
  if (computed.requireTechSpecialAudit) notes.push('须经技术归口部门专门论证审查');
  if (computed.requireDisciplineFiling) notes.push('批准后须报企管部与纪检审计部备案');
  return {
    requiredTier: computed.tier,
    requiredTierLabel: CHANGE_TIER_LABEL[computed.tier],
    orMode,
    deltaRatio,
    reason: notes.join('；'),
  };
}
