import { assertWarrantyReleased, legalEntityOrgId, requireEvidence } from './contract-controls';
import { assertContractFunding, rmbCents, tryRmbCents } from './contract-funding';
import { getSetting } from '../settings/business-settings';
import type { DB } from '../../db/connection';
import { AppError } from '../../core/errors';
import { currentAuth } from '../../core/request-context';
import { centsToDecimalString, mulCents, parseDecimalToCents, RATIO_SCALE } from '../../core/decimal';
import { assertDistinctReviewer } from '../security/review';
import { notVisible } from '../security/scope';
import type {
  ContractDetailDto, ContractPaymentApprovalTier, ContractPaymentType, ContractReceiptCreateRequest,
  ContractReceiptDto, ContractReceiptReceiveRequest, ContractSettlementCreateRequest, ContractSettlementDto, DecisionRequest,
  PaymentTierPreviewDto,
} from '../../contracts/project-contract';
import {
  assertActive, bump, contractDoc, currentCents, getContractDetail, recordEvent, visibleContract, type ContractRow,
} from './contract.service';

const nowIso = () => new Date().toISOString();
const conflict = (code: string, message: string, details?: unknown) => new AppError(code, message, 409, undefined, details);
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
const userName = (db: DB, id: number | null): string | null =>
  id === null ? null : (db.prepare('SELECT display_name FROM app_user WHERE id = ?').get(id) as { display_name: string } | undefined)?.display_name ?? `#${id}`;

const TIER_RANK: Record<ContractPaymentApprovalTier, number> = {
  secondary_unit_head: 1,
  finance_vp: 2,
  general_manager: 3,
  collective_decision: 4,
};
const TIER_LABEL: Record<ContractPaymentApprovalTier, string> = {
  secondary_unit_head: '二级单位主要负责人',
  finance_vp: '公司分管财务副总',
  general_manager: '公司主要负责人(总经理)',
  collective_decision: '公司集体决策(会议纪要)',
};
const FIFTY_WAN_CENTS = 50_000_000n;
const FIVE_HUNDRED_WAN_CENTS = 500_000_000n;

const hasDoc = (db: DB, contractId: number, ...docTypes: string[]) =>
  !!db.prepare(`SELECT 1 FROM ct_document WHERE contract_id = ? AND doc_type IN (${docTypes.map(() => '?').join(',')}) LIMIT 1`).get(contractId, ...docTypes);

const hasEvidence = (db: DB, contractId: number, ...kinds: string[]) =>
  !!db.prepare(`SELECT 1 FROM ct_document WHERE contract_id = ? AND evidence_kind IN (${kinds.map(() => '?').join(',')}) LIMIT 1`).get(contractId, ...kinds);

export function contractCapCents(c: ContractRow, withRatio = true): bigint | null {
  const base = c.pricing_mode === 'unit_price'
    ? (c.estimated_ceiling_cents === null ? null : BigInt(c.estimated_ceiling_cents))
    : currentCents(c);
  if (base === null) return null;
  return withRatio && c.payment_cap_ratio_scaled !== null
    ? mulCents(base, BigInt(c.payment_cap_ratio_scaled), RATIO_SCALE, 'down')
    : base;
}

export function sumPayments(db: DB, contractId: number, statuses: string[]): bigint {
  const r = db.prepare(`SELECT COALESCE(SUM(amount_cents), 0) AS s FROM ct_payment WHERE contract_id = ? AND status IN (${statuses.map(() => '?').join(',')})`)
    .safeIntegers(true).get(contractId, ...statuses) as { s: bigint };
  return r.s;
}

export function sumReceipts(db: DB, contractId: number, statuses: string[]): bigint {
  const r = db.prepare(`SELECT COALESCE(SUM(amount_cents), 0) AS s FROM ct_receipt WHERE contract_id = ? AND status IN (${statuses.map(() => '?').join(',')})`)
    .safeIntegers(true).get(contractId, ...statuses) as { s: bigint };
  return r.s;
}

function assertPaymentFits(db: DB, c: ContractRow, amount: bigint, excludePaymentId?: number): void {
  const limit = contractCapCents(c, true);
  if (limit === null) return;
  let approvedUnpaid = sumPayments(db, c.id, ['approved']);
  if (excludePaymentId) {
    const own = db.prepare("SELECT amount_cents FROM ct_payment WHERE id = ? AND status = 'approved'").safeIntegers(true).get(excludePaymentId) as { amount_cents: bigint; [key: string]: unknown } | undefined;
    if (own) approvedUnpaid -= own.amount_cents;
  }
  const total = approvedUnpaid + BigInt(c.paid_cents) + amount;
  if (total > limit) {
    throw conflict('CONTRACT_PAYMENT_EXCEEDS', `已批准未付 + 已付 + 本次 = ${centsToDecimalString(total)},超过可付上限 ${centsToDecimalString(limit)}`, {
      approvedUnpaid: centsToDecimalString(approvedUnpaid), paid: centsToDecimalString(c.paid_cents), amount: centsToDecimalString(amount), limit: centsToDecimalString(limit),
    });
  }
}

function assertSettledCapFits(
  db: DB,
  c: ContractRow,
  paymentType: ContractPaymentType,
  settlementId: number | null,
  amount: bigint,
  excludePaymentId?: number,
): void {
  if (paymentType === 'prepayment') {
    if (c.pricing_mode === 'unit_price' && c.estimated_ceiling_cents === null) throw conflict('CONTRACT_SETTLEMENT_REQUIRED', '无估算上限单价合同不能无上限预付');
    return;
  }
  const approvedStats = db.prepare("SELECT COUNT(*) AS cnt, COALESCE(SUM(net_payable_cents), 0) AS net_sum, COALESCE(SUM(deduct_retention_cents), 0) AS ret_sum FROM ct_settlement WHERE contract_id = ? AND status = 'approved'")
    .safeIntegers(true).get(c.id) as { cnt: bigint; net_sum: bigint; ret_sum: bigint };
  const hasApprovedSettlement = approvedStats.cnt > 0n;

  if (settlementId !== null) {
    const s = db.prepare('SELECT id, status, net_payable_cents, deduct_retention_cents FROM ct_settlement WHERE id = ? AND contract_id = ?')
      .safeIntegers(true).get(settlementId, c.id) as { id: bigint; status: string; net_payable_cents: bigint; deduct_retention_cents: bigint } | undefined;
    if (!s) throw notVisible('结算单');
    if (s.status !== 'approved') throw conflict('CONTRACT_STATE', '只能关联已批准的结算单申请付款');
    if (paymentType !== 'warranty_release') {
      const usedOnSettlement = (db.prepare(`SELECT COALESCE(SUM(amount_cents), 0) AS s FROM ct_payment WHERE contract_id = ? AND settlement_id = ? AND payment_type NOT IN ('prepayment','warranty_release') AND status IN ('approved','paid') ${excludePaymentId ? 'AND id <> ?' : ''}`)
        .safeIntegers(true).get(...(excludePaymentId ? [c.id, settlementId, excludePaymentId] : [c.id, settlementId])) as { s: bigint }).s;
      if (usedOnSettlement + amount > s.net_payable_cents) {
        throw conflict('CONTRACT_PAYMENT_EXCEEDS_SETTLED', `关联结算单累计应付 ${centsToDecimalString(usedOnSettlement + amount)} 超过该结算单净应付 ${centsToDecimalString(s.net_payable_cents)}`);
      }
    }
  }

  if (paymentType === 'warranty_release') {
    if (!hasApprovedSettlement || approvedStats.ret_sum <= 0n) throw conflict('CONTRACT_PAYMENT_EXCEEDS_SETTLED', '未有已批准的结算保留金，不能支付质保金尾款');
    if (hasApprovedSettlement && approvedStats.ret_sum > 0n) {
      const usedRetention = (db.prepare(`SELECT COALESCE(SUM(amount_cents), 0) AS s FROM ct_payment WHERE contract_id = ? AND payment_type = 'warranty_release' AND status IN ('approved','paid') ${excludePaymentId ? 'AND id <> ?' : ''}`)
        .safeIntegers(true).get(...(excludePaymentId ? [c.id, excludePaymentId] : [c.id])) as { s: bigint }).s;
      if (usedRetention + amount > approvedStats.ret_sum) {
        throw conflict('CONTRACT_PAYMENT_EXCEEDS_SETTLED', `质保金累计支付 ${centsToDecimalString(usedRetention + amount)} 超过结算预留质保金 ${centsToDecimalString(approvedStats.ret_sum)}`);
      }
    }
    return;
  }

  if (!hasApprovedSettlement) {
    if (c.pricing_mode === 'unit_price') {
      throw conflict('CONTRACT_SETTLEMENT_REQUIRED', '未设置估算上限的单价合同，请先提交并批准结算单后再申请进度/结算付款');
    }
    return;
  }

  const usedNonPrepay = (db.prepare(`SELECT COALESCE(SUM(amount_cents), 0) AS s FROM ct_payment WHERE contract_id = ? AND payment_type NOT IN ('prepayment','warranty_release') AND status IN ('approved','paid') ${excludePaymentId ? 'AND id <> ?' : ''}`)
    .safeIntegers(true).get(...(excludePaymentId ? [c.id, excludePaymentId] : [c.id])) as { s: bigint }).s;
  if (usedNonPrepay + amount > approvedStats.net_sum) {
    throw conflict('CONTRACT_PAYMENT_EXCEEDS_SETTLED', `非预付款累计支付 ${centsToDecimalString(usedNonPrepay + amount)} 超过累计已批净结算额 ${centsToDecimalString(approvedStats.net_sum)}`, {
      usedNonPrepay: centsToDecimalString(usedNonPrepay), amount: centsToDecimalString(amount), settledNet: centsToDecimalString(approvedStats.net_sum),
    });
  }
}

export interface PaymentSubmitInput {
  nodeName: string;
  amount: string;
  plannedDate?: string | null;
  evidenceDocumentId?: number | null;
  settlementId?: number | null;
  paymentType?: ContractPaymentType;
  currency?: string;
  approvalTier?: ContractPaymentApprovalTier | null;
  approverName?: string;
  approverTitle?: string;
  approvalDocId?: number | null;
  isFarmerWageTransfer?: boolean;
  feasibilityDocId?: number | null;
}

function evaluatePaymentTier(
  db: DB,
  c: ContractRow,
  rmbAmount: bigint | null,
  plannedDate?: string | null,
): {
  minTier: ContractPaymentApprovalTier;
  large: boolean;
  netAssetFound: boolean;
  onePercentCents: bigint | null;
  entity: number;
  priorYear: number;
} {
  const assets = JSON.parse(getSetting<string>(db, 'contract.prior_year_net_assets') || '[]') as {
    orgId: number;
    year: number;
    amount: string;
  }[];
  const entity = legalEntityOrgId(db, c.org_id, c.signing_entity_level);
  const priorYear = Number((plannedDate || new Date().toISOString()).slice(0, 4)) - 1;
  const asset = assets.find((a) => a.orgId === entity && a.year === priorYear);
  const netAssetCents = asset ? parseDecimalToCents(asset.amount) : null;
  const onePercentCents = netAssetCents !== null ? netAssetCents / 100n : null;
  const large =
    rmbAmount === null ||
    rmbAmount >= FIVE_HUNDRED_WAN_CENTS ||
    netAssetCents === null ||
    rmbAmount * 100n >= netAssetCents;
  const minTier: ContractPaymentApprovalTier = large
    ? 'collective_decision'
    : c.signing_entity_level === 'company'
      ? rmbAmount > FIFTY_WAN_CENTS
        ? 'general_manager'
        : 'finance_vp'
      : 'secondary_unit_head';
  return { minTier, large, netAssetFound: netAssetCents !== null, onePercentCents, entity, priorYear };
}

export function previewContractPaymentTier(
  db: DB,
  contractId: number,
  opts: { amount?: string; plannedDate?: string } = {},
): PaymentTierPreviewDto {
  const c = visibleContract(db, contractId);
  const rawAmount = opts.amount ? parseDecimalToCents(opts.amount, { label: '付款金额' }) : 0n;
  const rmbAmount = tryRmbCents(c, rawAmount < 0n ? 0n : rawAmount);
  const info = evaluatePaymentTier(db, c, rmbAmount, opts.plannedDate ?? null);
  return {
    requiredTier: info.minTier,
    requiredTierLabel: TIER_LABEL[info.minTier],
    netAssetFound: info.netAssetFound,
    onePercentAmount: info.onePercentCents === null ? null : centsToDecimalString(info.onePercentCents),
    ceilingAmount: centsToDecimalString(FIVE_HUNDRED_WAN_CENTS),
    rmbAmount: rmbAmount === null ? null : centsToDecimalString(rmbAmount),
    legalEntityOrgId: info.entity,
    priorYear: info.priorYear,
  };
}

function assertPaymentApprovalTier(db: DB, c: ContractRow, amount: bigint, input: PaymentSubmitInput): void {
  const tier = input.approvalTier ?? null;
  const approverName = (input.approverName ?? '').trim();
  const approverTitle = (input.approverTitle ?? '').trim();
  const fallback = input.evidenceDocumentId && db.prepare("SELECT id FROM ct_document WHERE id = ? AND contract_id = ? AND evidence_kind = 'payment_approval_form'").get(input.evidenceDocumentId, c.id) as { id: number } | undefined;
  const approvalDoc = input.approvalDocId ?? (fallback ? fallback.id : null);
  const rmbAmount = rmbCents(c, amount);
  const { minTier, large, netAssetFound } = evaluatePaymentTier(db, c, rmbAmount, input.plannedDate ?? null);
  if (!tier || TIER_RANK[tier] < TIER_RANK[minTier]) throw conflict('CONTRACT_APPROVAL_TIER_REQUIRED', `${!netAssetFound ? '未配置上年净资产，按集体决策从严核验；' : ''}本笔付款要求「${TIER_LABEL[minTier]}」`, { requiredTier: minTier, actualTier: tier });
  if (input.approvalDocId) requireEvidence(db, c.id, input.approvalDocId, ['payment_approval_form']);
  if (!approverName || !approverTitle) throw conflict('CONTRACT_APPROVER_REQUIRED', '须填写最高审批人姓名及身份/职务');
  if ((large || minTier === 'general_manager') && !approvalDoc) throw conflict('EVIDENCE_REQUIRED', '须选择对应付款签批单或集体决策会议文件');
  if (large) requireEvidence(db, c.id, input.feasibilityDocId, ['funding_feasibility']);

}

function assertPaymentExecution(db: DB, c: ContractRow, p: Record<string, unknown>, amount: bigint, id: number, actualDate?: string) {
  if (p.currency !== c.currency) throw conflict('CONTRACT_CURRENCY_MISMATCH', '付款币种与合同不一致');
  const paymentType = p.payment_type as ContractPaymentType;
  if (paymentType === 'warranty_release') assertWarrantyReleased(db, c.id, actualDate);
  assertPaymentApprovalTier(db, c, amount, { nodeName: String(p.node_name), amount: centsToDecimalString(amount),
    approvalTier: p.approval_tier as ContractPaymentApprovalTier | null, approverName: String(p.approver_name ?? ''), approverTitle: String(p.approver_title ?? ''),
    approvalDocId: num(p.approval_doc_id), evidenceDocumentId: num(p.evidence_document_id), feasibilityDocId: num(p.feasibility_doc_id),
    plannedDate: actualDate ?? p.planned_date as string | null });
  assertPaymentFits(db, c, amount, id);
  const own = p.status === 'approved' ? amount : 0n;
  assertContractFunding(db, c, { paymentTotal: BigInt(c.paid_cents) + sumPayments(db, c.id, ['approved']) - own + amount, paymentDate: actualDate ?? p.planned_date as string | null });
}

/* ================= 结算单 ct_settlement ================= */

function mapSettlementRow(db: DB, r: Record<string, unknown>): ContractSettlementDto {
  return {
    id: Number(r.id),
    periodNo: Number(r.period_no),
    settlementKind: r.settlement_kind as ContractSettlementDto['settlementKind'],
    settlementDate: String(r.settlement_date),
    inContractAmount: centsToDecimalString(r.in_contract_cents as bigint),
    changeClaimAmount: centsToDecimalString(r.change_claim_cents as bigint),
    otherAddAmount: centsToDecimalString(r.other_add_cents as bigint),
    grossPayableAmount: centsToDecimalString(r.gross_payable_cents as bigint),
    deductPrepaymentAmount: centsToDecimalString(r.deduct_prepayment_cents as bigint),
    deductRetentionAmount: centsToDecimalString(r.deduct_retention_cents as bigint),
    deductPenaltyAmount: centsToDecimalString(r.deduct_penalty_cents as bigint),
    totalDeductAmount: centsToDecimalString(r.total_deduct_cents as bigint),
    netPayableAmount: centsToDecimalString(r.net_payable_cents as bigint),
    note: String(r.note ?? ''),
    evidenceDocumentId: num(r.evidence_document_id),
    status: r.status as ContractSettlementDto['status'],
    submittedBy: userName(db, num(r.submitted_by_user_id)),
    submittedAt: String(r.submitted_at),
    reviewedBy: userName(db, num(r.reviewed_by_user_id)),
    reviewedAt: (r.reviewed_at as string | null) ?? null,
    comment: (r.review_comment as string | null) ?? null,
    exceptionReason: (r.exception_reason as string | null) ?? null,
    selfReview: Number(r.self_review ?? 0) === 1,
  };
}

export function listContractSettlements(db: DB, id: number): ContractSettlementDto[] {
  visibleContract(db, id);
  const rows = db.prepare('SELECT * FROM ct_settlement WHERE contract_id = ? ORDER BY period_no ASC, id ASC').safeIntegers(true).all(id) as Record<string, unknown>[];
  let runGross = 0n;
  let runDeduct = 0n;
  let runNet = 0n;
  const ytdByYear = new Map<string, { gross: bigint; deduct: bigint; net: bigint }>();
  return rows.map((r) => {
    const curGross = r.gross_payable_cents as bigint;
    const curDeduct = r.total_deduct_cents as bigint;
    const curNet = r.net_payable_cents as bigint;
    const yr = String(r.settlement_date).slice(0, 4);
    const ytdPrev = ytdByYear.get(yr) ?? { gross: 0n, deduct: 0n, net: 0n };
    const priorGross = runGross;
    const priorDeduct = runDeduct;
    const priorNet = runNet;
    const ytdGross = ytdPrev.gross + curGross;
    const ytdDeduct = ytdPrev.deduct + curDeduct;
    const ytdNet = ytdPrev.net + curNet;
    const cumGross = priorGross + curGross;
    const cumDeduct = priorDeduct + curDeduct;
    const cumNet = priorNet + curNet;
    if (r.status !== 'rejected') {
      runGross = cumGross;
      runDeduct = cumDeduct;
      runNet = cumNet;
      ytdByYear.set(yr, { gross: ytdGross, deduct: ytdDeduct, net: ytdNet });
    }
    return {
      ...mapSettlementRow(db, r),
      priorGrossAmount: centsToDecimalString(priorGross),
      priorTotalDeductAmount: centsToDecimalString(priorDeduct),
      priorNetPayableAmount: centsToDecimalString(priorNet),
      ytdGrossAmount: centsToDecimalString(ytdGross),
      ytdTotalDeductAmount: centsToDecimalString(ytdDeduct),
      ytdNetPayableAmount: centsToDecimalString(ytdNet),
      cumulativeGrossAmount: centsToDecimalString(cumGross),
      cumulativeTotalDeductAmount: centsToDecimalString(cumDeduct),
      cumulativeNetPayableAmount: centsToDecimalString(cumNet),
    };
  });
}

function assertSettlementAllowed(db: DB, c: ContractRow, changeClaim: bigint, net: bigint, excludeSettlementId?: number, gross = net): void {
  assertContractFunding(db, c, { settlementGross: gross });
  if (changeClaim > 0n) {
    const chg = db.prepare("SELECT COUNT(*) AS cnt, COALESCE(SUM(CASE WHEN delta_cents > 0 THEN delta_cents ELSE 0 END), 0) AS pos FROM ct_change WHERE contract_id = ? AND status = 'approved'")
      .safeIntegers(true).get(c.id) as { cnt: bigint; pos: bigint };
    if (chg.cnt === 0n || chg.pos <= 0n) {
      throw conflict('UNAPPROVED_CHANGE_IN_SETTLEMENT', '存在变更/索赔应结金额，但合同尚无已批准的增额变更单或补充协议');
    }
    const priorClaim = (db.prepare(`SELECT COALESCE(SUM(CASE WHEN change_claim_cents > 0 THEN change_claim_cents ELSE 0 END), 0) AS s FROM ct_settlement WHERE contract_id = ? AND status IN ('submitted','approved') ${excludeSettlementId ? 'AND id <> ?' : ''}`)
      .safeIntegers(true).get(...(excludeSettlementId ? [c.id, excludeSettlementId] : [c.id])) as { s: bigint }).s;
    if (priorClaim + changeClaim > chg.pos) {
      throw conflict('UNAPPROVED_CHANGE_IN_SETTLEMENT', `累计变更索赔应结额 ${centsToDecimalString(priorClaim + changeClaim)} 超过已批准正变更总额 ${centsToDecimalString(chg.pos)}`);
    }
  }
  const limit = contractCapCents(c, false);
  if (limit !== null) {
    const existingNet = (db.prepare(`SELECT COALESCE(SUM(net_payable_cents), 0) AS s FROM ct_settlement WHERE contract_id = ? AND status IN ('submitted','approved') ${excludeSettlementId ? 'AND id <> ?' : ''}`)
      .safeIntegers(true).get(...(excludeSettlementId ? [c.id, excludeSettlementId] : [c.id])) as { s: bigint }).s;
    if (existingNet + net > limit) {
      throw conflict('CONTRACT_SETTLEMENT_EXCEEDS', `累计净结算额 ${centsToDecimalString(existingNet + net)} 超过合同当前金额/上限 ${centsToDecimalString(limit)}`, {
        existingNet: centsToDecimalString(existingNet), net: centsToDecimalString(net), limit: centsToDecimalString(limit),
      });
    }
  }
}

export function submitContractSettlement(db: DB, id: number, input: ContractSettlementCreateRequest): ContractDetailDto {
  const inContract = parseDecimalToCents(input.inContractAmount, { label: '合同内应结金额' });
  const changeClaim = parseDecimalToCents(input.changeClaimAmount, { label: '变更索赔应结金额' });
  const otherAdd = parseDecimalToCents(input.otherAddAmount, { label: '其他应结金额' });
  const deductPrepayment = parseDecimalToCents(input.deductPrepaymentAmount, { label: '扣回预付款' });
  const deductRetention = parseDecimalToCents(input.deductRetentionAmount, { label: '扣留质保金' });
  const deductPenalty = parseDecimalToCents(input.deductPenaltyAmount, { label: '违约及考核扣款' });
  if (inContract < 0n || otherAdd < 0n) {
    throw new AppError('VALIDATION_FAILED', '合同内应结与其他应结金额不能为负', 400);
  }
  const gross = inContract + changeClaim + otherAdd;
  const totalDeduct = deductPrepayment + deductRetention + deductPenalty;
  const net = gross - totalDeduct;
  if (gross < 0n) throw new AppError('VALIDATION_FAILED', '本期应结小计不能为负', 400);
  if (net < 0n) throw new AppError('VALIDATION_FAILED', '本期净应付/应收额不能为负', 400);
  if (
    inContract === 0n &&
    changeClaim === 0n &&
    otherAdd === 0n &&
    deductPrepayment === 0n &&
    deductRetention === 0n &&
    deductPenalty === 0n
  ) {
    throw new AppError('VALIDATION_FAILED', '结算金额不能全为 0', 400);
  }

  db.transaction(() => {
    const c = visibleContract(db, id);
    assertActive(c, '提交结算单');
    if (!['performance', 'settlement'].includes(c.stage)) {
      throw conflict('CONTRACT_STATE', '只能在「履约执行」「验收结算」阶段提交结算单');
    }
    if (input.evidenceDocumentId) contractDoc(db, id, input.evidenceDocumentId);
    if (input.settlementKind === 'final') {
      const dupFinal = db.prepare("SELECT 1 FROM ct_settlement WHERE contract_id = ? AND settlement_kind = 'final' AND status IN ('submitted','approved')").get(id);
      if (dupFinal) throw conflict('CONTRACT_STATE', '该合同已存在有效或待审的最终/竣工结算单');
      if (!hasDoc(db, id, 'acceptance')) throw conflict('EVIDENCE_REQUIRED', '提交最终/竣工结算单前须先上传验收文件');
      if (!['checked', 'transferred'].includes(c.archive_status)) {
        throw conflict('CONTRACT_ARCHIVE_INCOMPLETE', '档案资料未验收完整，不得进行最终/竣工结算（制度 12.1）');
      }
    }
    assertSettlementAllowed(db, c, changeClaim, net, undefined, gross);
    const nextNo = (db.prepare('SELECT COALESCE(MAX(period_no), 0) + 1 AS n FROM ct_settlement WHERE contract_id = ?').get(id) as { n: number }).n;
    const sid = Number(db.prepare(`INSERT INTO ct_settlement (
      contract_id, period_no, settlement_kind, settlement_date, in_contract_cents, change_claim_cents, other_add_cents,
      gross_payable_cents, deduct_prepayment_cents, deduct_retention_cents, deduct_penalty_cents, total_deduct_cents, net_payable_cents,
      note, evidence_document_id, submitted_by_user_id, submitted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, nextNo, input.settlementKind, input.settlementDate, inContract, changeClaim, otherAdd,
      gross, deductPrepayment, deductRetention, deductPenalty, totalDeduct, net,
      input.note ?? '', input.evidenceDocumentId ?? null, currentAuth()?.userId ?? null, nowIso(),
    ).lastInsertRowid);
    bump(db, id);
    recordEvent(db, id, 'settlement.submit', {
      settlementId: sid, periodNo: nextNo, settlementKind: input.settlementKind,
      grossPayable: centsToDecimalString(gross), totalDeduct: centsToDecimalString(totalDeduct), netPayable: centsToDecimalString(net),
    });
  }).immediate();
  return getContractDetail(db, id);
}

export function decideContractSettlement(db: DB, id: number, settlementId: number, input: DecisionRequest): ContractDetailDto {
  const auth = currentAuth();
  db.transaction(() => {
    const c = visibleContract(db, id);
    assertActive(c, '复核结算单');
    const s = db.prepare('SELECT id, status, period_no, settlement_kind, change_claim_cents, gross_payable_cents, net_payable_cents, submitted_by_user_id FROM ct_settlement WHERE id = ? AND contract_id = ?')
      .safeIntegers(true).get(settlementId, id) as {
        id: bigint; status: string; period_no: bigint; settlement_kind: string; change_claim_cents: bigint;
        gross_payable_cents: bigint; net_payable_cents: bigint; submitted_by_user_id: bigint | null;
      } | undefined;
    if (!s) throw notVisible('结算单');
    if (s.status !== 'submitted') throw conflict('CONTRACT_STATE', '该结算单已复核,结论不可更改');
    const { selfReview } = assertDistinctReviewer(db, auth, num(s.submitted_by_user_id), input.exceptionReason, '结算单');
    const approve = input.decision === 'approve';
    if (approve) {
      if (s.settlement_kind === 'final' && (!hasDoc(db, id, 'acceptance') || !['checked', 'transferred'].includes(c.archive_status))) throw conflict('CONTRACT_ARCHIVE_INCOMPLETE', '最终结算批准前须核验验收文件与档案完整');
      assertSettlementAllowed(db, c, s.change_claim_cents, s.net_payable_cents, settlementId, s.gross_payable_cents);
      db.prepare('UPDATE ct_contract SET settled_gross_cents = settled_gross_cents + ?, settled_net_cents = settled_net_cents + ? WHERE id = ?')
        .run(s.gross_payable_cents, s.net_payable_cents, id);
    }
    db.prepare('UPDATE ct_settlement SET status = ?, reviewed_by_user_id = ?, reviewed_at = ?, review_comment = ?, exception_reason = ?, self_review = ? WHERE id = ?')
      .run(approve ? 'approved' : 'rejected', auth?.userId ?? null, nowIso(), input.comment ?? null, input.exceptionReason ?? null, selfReview ? 1 : 0, settlementId);
    bump(db, id);
    recordEvent(db, id, `settlement.${approve ? 'approve' : 'reject'}`, {
      settlementId, periodNo: Number(s.period_no), settlementKind: s.settlement_kind,
      grossPayable: centsToDecimalString(s.gross_payable_cents), netPayable: centsToDecimalString(s.net_payable_cents),
      selfReview, exceptionReason: input.exceptionReason ?? null,
    });
  }).immediate();
  return getContractDetail(db, id);
}

/* ================= 支出付款 ct_payment ================= */

export function submitContractPayment(db: DB, id: number, input: PaymentSubmitInput): ContractDetailDto {
  const amount = parseDecimalToCents(input.amount, { label: '付款金额' });
  if (amount <= 0n) throw new AppError('VALIDATION_FAILED', '付款金额必须大于 0', 400);
  const paymentType: ContractPaymentType = input.paymentType ?? 'progress';
  db.transaction(() => {
    const c = visibleContract(db, id);
    assertActive(c, '申请付款');
    if (c.direction === 'income') throw conflict('CONTRACT_DIRECTION_MISMATCH', '收入合同请使用收款登记（ct_receipt），不能提交支出付款申请');
    if (!['performance', 'settlement', 'warranty'].includes(c.stage)) {
      throw conflict('CONTRACT_STATE', '只能在「履约执行」「验收结算」「质保维护」阶段申请付款');
    }
    if (c.stage === 'warranty' && paymentType !== 'warranty_release') {
      throw conflict('CONTRACT_STATE', '质保维护阶段只能申请质保金尾款支付（warranty_release）');
    }
    if (c.stage === 'performance' && paymentType === 'warranty_release') {
      throw conflict('CONTRACT_STATE', '履约执行阶段不能申请质保金尾款支付');
    }
    if (paymentType === 'warranty_release') assertWarrantyReleased(db, id);
    const currency = input.currency ?? c.currency ?? '人民币';
    if (currency !== c.currency) {
      throw new AppError('VALIDATION_FAILED', `付款币种(${currency})须与合同约定币种(${c.currency})一致`, 400);
    }
    if (input.evidenceDocumentId) contractDoc(db, id, input.evidenceDocumentId);
    assertPaymentApprovalTier(db, c, amount, input);
    assertContractFunding(db, c, { paymentTotal: BigInt(c.paid_cents) + sumPayments(db, id, ['approved']) + amount, paymentDate: input.plannedDate });
    assertSettledCapFits(db, c, paymentType, input.settlementId ?? null, amount);
    assertPaymentFits(db, c, amount);
    const pid = Number(db.prepare(`INSERT INTO ct_payment (
      contract_id, settlement_id, payment_type, node_name, currency, amount_cents, planned_date, evidence_document_id,
      approval_tier, approver_name, approver_title, approval_doc_id, is_farmer_wage_transfer, submitted_by_user_id, submitted_at, feasibility_doc_id
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, input.settlementId ?? null, paymentType, input.nodeName, currency, amount, input.plannedDate ?? null, input.evidenceDocumentId ?? null,
      input.approvalTier ?? null, (input.approverName ?? '').trim(), (input.approverTitle ?? '').trim(), input.approvalDocId ?? null,
      input.isFarmerWageTransfer ? 1 : 0, currentAuth()?.userId ?? null, nowIso(), input.feasibilityDocId ?? null,
    ).lastInsertRowid);
    bump(db, id);
    recordEvent(db, id, 'payment.submit', {
      paymentId: pid, nodeName: input.nodeName, paymentType, settlementId: input.settlementId ?? null,
      approvalTier: input.approvalTier ?? null, amount: centsToDecimalString(amount),
    });
  }).immediate();
  return getContractDetail(db, id);
}

export function decideContractPayment(db: DB, id: number, paymentId: number, input: DecisionRequest): ContractDetailDto {
  const auth = currentAuth();
  db.transaction(() => {
    const c = visibleContract(db, id);
    assertActive(c, '复核付款');
    const p = db.prepare('SELECT * FROM ct_payment WHERE id = ? AND contract_id = ?')
      .safeIntegers(true).get(paymentId, id) as
      { id: bigint; status: string; payment_type: ContractPaymentType; settlement_id: bigint | null; amount_cents: bigint; submitted_by_user_id: bigint | null; [key: string]: unknown } | undefined;
    if (!p) throw notVisible('付款申请');
    if (p.status !== 'submitted') throw conflict('CONTRACT_STATE', '该付款申请已复核,结论不可更改');
    const { selfReview } = assertDistinctReviewer(db, auth, num(p.submitted_by_user_id), input.exceptionReason, '付款申请');
    const approve = input.decision === 'approve';
    if (approve) {
      assertPaymentExecution(db, c, p, p.amount_cents, paymentId);
      assertSettledCapFits(db, c, p.payment_type, num(p.settlement_id), p.amount_cents, paymentId);
      assertPaymentFits(db, c, p.amount_cents, paymentId);
    }
    db.prepare('UPDATE ct_payment SET status = ?, reviewed_by_user_id = ?, reviewed_at = ?, review_comment = ?, exception_reason = ?, self_review = ? WHERE id = ?')
      .run(approve ? 'approved' : 'rejected', auth?.userId ?? null, nowIso(), input.comment ?? null, input.exceptionReason ?? null, selfReview ? 1 : 0, paymentId);
    bump(db, id);
    recordEvent(db, id, `payment.${approve ? 'approve' : 'reject'}`, { paymentId, amount: centsToDecimalString(p.amount_cents), selfReview, exceptionReason: input.exceptionReason ?? null });
  }).immediate();
  return getContractDetail(db, id);
}

export function payContractPayment(db: DB, id: number, paymentId: number, input: { paidDate: string; voucherNo?: string; invoiceDocumentId: number }): ContractDetailDto {
  db.transaction(() => {
    const c = visibleContract(db, id);
    assertActive(c, '登记支付');
    const p = db.prepare('SELECT * FROM ct_payment WHERE id = ? AND contract_id = ?')
      .safeIntegers(true).get(paymentId, id) as
      { id: bigint; status: string; payment_type: ContractPaymentType; settlement_id: bigint | null; amount_cents: bigint; [key: string]: unknown } | undefined;
    if (!p) throw notVisible('付款申请');
    if (p.status !== 'approved') throw conflict('CONTRACT_STATE', '只有已批准的付款可以登记支付');
    const doc = db.prepare('SELECT doc_type FROM ct_document WHERE id = ? AND contract_id = ?').get(input.invoiceDocumentId, id) as { doc_type: string } | undefined;
    if (!doc || doc.doc_type !== 'invoice') throw conflict('EVIDENCE_REQUIRED', '登记支付须附本合同的发票文档');
    assertPaymentExecution(db, c, p, p.amount_cents, paymentId, input.paidDate);
    assertSettledCapFits(db, c, p.payment_type, num(p.settlement_id), p.amount_cents, paymentId);
    const ceiling = contractCapCents(c, false);
    if (ceiling !== null && BigInt(c.paid_cents) + p.amount_cents > ceiling) {
      throw conflict('CONTRACT_PAYMENT_EXCEEDS', '支付后已付将超过当前金额/上限');
    }
    db.prepare("UPDATE ct_payment SET status = 'paid', paid_date = ?, voucher_no = ?, invoice_document_id = ?, paid_by_user_id = ?, paid_at = ? WHERE id = ?")
      .run(input.paidDate, input.voucherNo ?? null, input.invoiceDocumentId, currentAuth()?.userId ?? null, nowIso(), paymentId);
    db.prepare('UPDATE ct_contract SET paid_cents = paid_cents + ? WHERE id = ?').run(p.amount_cents, id);
    if (p.payment_type === 'warranty_release') {
      db.prepare('UPDATE ct_warranty SET released_payment_id = COALESCE(released_payment_id, ?), updated_at = ? WHERE contract_id = ?')
        .run(paymentId, nowIso(), id);
    }
    bump(db, id);
    recordEvent(db, id, 'payment.pay', { paymentId, amount: centsToDecimalString(p.amount_cents), paidDate: input.paidDate, voucherNo: input.voucherNo ?? null });
  }).immediate();
  return getContractDetail(db, id);
}

/* ================= 收入收款 ct_receipt ================= */

function mapReceiptRow(db: DB, r: Record<string, unknown>): ContractReceiptDto {
  return {
    id: Number(r.id),
    kind: r.kind as ContractReceiptDto['kind'],
    settlementId: num(r.settlement_id),
    nodeName: String(r.node_name),
    currency: String(r.currency ?? '人民币'),
    amount: centsToDecimalString(r.amount_cents as bigint),
    plannedDate: (r.planned_date as string | null) ?? null,
    invoiceDocumentId: num(r.invoice_document_id),
    status: r.status as ContractReceiptDto['status'],
    submittedBy: userName(db, num(r.submitted_by_user_id)),
    submittedAt: String(r.submitted_at),
    reviewedBy: userName(db, num(r.reviewed_by_user_id)),
    reviewedAt: (r.reviewed_at as string | null) ?? null,
    comment: (r.review_comment as string | null) ?? null,
    exceptionReason: (r.exception_reason as string | null) ?? null,
    selfReview: Number(r.self_review ?? 0) === 1,
    receivedDate: (r.received_date as string | null) ?? null,
    voucherNo: (r.voucher_no as string | null) ?? null,
    receivedBy: userName(db, num(r.received_by_user_id)),
    receivedAt: (r.received_at as string | null) ?? null,
  };
}

export function listContractReceipts(db: DB, id: number): ContractReceiptDto[] {
  visibleContract(db, id);
  return (db.prepare('SELECT * FROM ct_receipt WHERE contract_id = ? ORDER BY id').safeIntegers(true).all(id) as Record<string, unknown>[])
    .map((r) => mapReceiptRow(db, r));
}

function assertReceiptFits(db: DB, c: ContractRow, amount: bigint, excludeReceiptId?: number, settlementId?: number | null): void {
  if (settlementId !== undefined && settlementId !== null) {
    const s = db.prepare('SELECT id, status, net_payable_cents FROM ct_settlement WHERE id = ? AND contract_id = ?')
      .safeIntegers(true).get(settlementId, c.id) as { id: bigint; status: string; net_payable_cents: bigint } | undefined;
    if (!s) throw notVisible('结算单');
    if (s.status !== 'approved') throw conflict('CONTRACT_STATE', '只能关联已批准的结算单申请收款');
    const used = (db.prepare(`SELECT COALESCE(SUM(amount_cents), 0) AS s FROM ct_receipt WHERE contract_id = ? AND settlement_id = ? AND status IN ('approved','received') ${excludeReceiptId ? 'AND id <> ?' : ''}`)
      .safeIntegers(true).get(...(excludeReceiptId ? [c.id, settlementId, excludeReceiptId] : [c.id, settlementId])) as { s: bigint }).s;
    if (used + amount > s.net_payable_cents) {
      throw conflict('CONTRACT_RECEIPT_EXCEEDS_SETTLED', `关联结算单累计应收 ${centsToDecimalString(used + amount)} 超过该结算单净应收 ${centsToDecimalString(s.net_payable_cents)}`);
    }
  } else if (c.pricing_mode === 'unit_price' && c.estimated_ceiling_cents === null) {
    const approvedCount = (db.prepare("SELECT COUNT(*) AS n FROM ct_settlement WHERE contract_id = ? AND status = 'approved'").get(c.id) as { n: number }).n;
    if (approvedCount === 0) {
      throw conflict('CONTRACT_SETTLEMENT_REQUIRED', '未设置估算上限的单价收入合同须先批准结算单后再登记收款');
    }
  }

  const limit = contractCapCents(c, false);
  let approvedUnreceived = sumReceipts(db, c.id, ['approved']);
  if (excludeReceiptId) {
    const own = db.prepare("SELECT amount_cents FROM ct_receipt WHERE id = ? AND status = 'approved'").safeIntegers(true).get(excludeReceiptId) as { amount_cents: bigint; [key: string]: unknown } | undefined;
    if (own) approvedUnreceived -= own.amount_cents;
  }
  const total = approvedUnreceived + BigInt(c.received_cents) + amount;
  const settled = (db.prepare("SELECT COALESCE(SUM(net_payable_cents),0) AS s FROM ct_settlement WHERE contract_id = ? AND status = 'approved'").safeIntegers(true).get(c.id) as { s: bigint }).s;
  if (c.pricing_mode === 'unit_price' && total > settled) throw conflict('CONTRACT_RECEIPT_EXCEEDS_SETTLED', '单价收入合同累计收款及已批准未收不得超过累计已批准净应收额');
  if (limit !== null && total > limit) {
    throw conflict('CONTRACT_RECEIPT_EXCEEDS', `已批准未收 + 已收 + 本次 = ${centsToDecimalString(total)},超过合同应收上限 ${centsToDecimalString(limit)}`);
  }
}

export function submitContractReceipt(db: DB, id: number, input: ContractReceiptCreateRequest): ContractDetailDto {
  const amount = parseDecimalToCents(input.amount, { label: '收款金额' });
  if (amount <= 0n) throw new AppError('VALIDATION_FAILED', '收款金额必须大于 0', 400);
  db.transaction(() => {
    const c = visibleContract(db, id);
    assertActive(c, '申请收款');
    if (c.direction !== 'income') throw conflict('CONTRACT_DIRECTION_MISMATCH', '只有收入合同才能登记收款');
    if (!['performance', 'settlement', 'warranty'].includes(c.stage)) {
      throw conflict('CONTRACT_STATE', '只能在「履约执行」「验收结算」「质保维护」阶段登记收款');
    }
    const currency = input.currency ?? c.currency ?? '人民币';
    if (currency !== c.currency) {
      throw new AppError('VALIDATION_FAILED', `收款币种(${currency})须与合同约定币种(${c.currency})一致`, 400);
    }
    if (input.invoiceDocumentId) contractDoc(db, id, input.invoiceDocumentId);
    assertReceiptFits(db, c, amount, undefined, input.settlementId ?? null);
    const rid = Number(db.prepare(`INSERT INTO ct_receipt (
      contract_id, settlement_id, node_name, currency, amount_cents, planned_date, invoice_document_id, submitted_by_user_id, submitted_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      id, input.settlementId ?? null, input.nodeName, currency, amount, input.plannedDate ?? null,
      input.invoiceDocumentId ?? null, currentAuth()?.userId ?? null, nowIso(),
    ).lastInsertRowid);
    bump(db, id);
    recordEvent(db, id, 'receipt.submit', { receiptId: rid, nodeName: input.nodeName, settlementId: input.settlementId ?? null, amount: centsToDecimalString(amount) });
  }).immediate();
  return getContractDetail(db, id);
}

export function decideContractReceipt(db: DB, id: number, receiptId: number, input: DecisionRequest): ContractDetailDto {
  const auth = currentAuth();
  db.transaction(() => {
    const c = visibleContract(db, id);
    assertActive(c, '复核收款');
    const r = db.prepare('SELECT id, status, settlement_id, amount_cents, submitted_by_user_id FROM ct_receipt WHERE id = ? AND contract_id = ?')
      .safeIntegers(true).get(receiptId, id) as
      { id: bigint; status: string; settlement_id: bigint | null; amount_cents: bigint; submitted_by_user_id: bigint | null; [key: string]: unknown } | undefined;
    if (!r) throw notVisible('收款申请');
    if (r.status !== 'submitted') throw conflict('CONTRACT_STATE', '该收款申请已复核,结论不可更改');
    const { selfReview } = assertDistinctReviewer(db, auth, num(r.submitted_by_user_id), input.exceptionReason, '收款申请');
    const approve = input.decision === 'approve';
    if (approve) assertReceiptFits(db, c, r.amount_cents, receiptId, num(r.settlement_id));
    db.prepare('UPDATE ct_receipt SET status = ?, reviewed_by_user_id = ?, reviewed_at = ?, review_comment = ?, exception_reason = ?, self_review = ? WHERE id = ?')
      .run(approve ? 'approved' : 'rejected', auth?.userId ?? null, nowIso(), input.comment ?? null, input.exceptionReason ?? null, selfReview ? 1 : 0, receiptId);
    bump(db, id);
    recordEvent(db, id, `receipt.${approve ? 'approve' : 'reject'}`, { receiptId, amount: centsToDecimalString(r.amount_cents), selfReview, exceptionReason: input.exceptionReason ?? null });
  }).immediate();
  return getContractDetail(db, id);
}

export function receiveContractReceipt(db: DB, id: number, receiptId: number, input: ContractReceiptReceiveRequest): ContractDetailDto {
  db.transaction(() => {
    const c = visibleContract(db, id);
    assertActive(c, '登记收款到账');
    const r = db.prepare('SELECT id, status, settlement_id, amount_cents, invoice_document_id FROM ct_receipt WHERE id = ? AND contract_id = ?')
      .safeIntegers(true).get(receiptId, id) as
      { id: bigint; status: string; settlement_id: bigint | null; amount_cents: bigint; invoice_document_id: bigint | null } | undefined;
    if (!r) throw notVisible('收款申请');
    if (r.status !== 'approved') throw conflict('CONTRACT_STATE', '只有已批准的收款申请可以登记到账');
    if (input.invoiceDocumentId) {
      const doc = db.prepare('SELECT doc_type FROM ct_document WHERE id = ? AND contract_id = ?').get(input.invoiceDocumentId, id) as { doc_type: string } | undefined;
      if (!doc || doc.doc_type !== 'invoice') throw conflict('EVIDENCE_REQUIRED', '所选附件须为本合同的发票文档');
    }
    assertReceiptFits(db, c, r.amount_cents, receiptId, num(r.settlement_id));
    const ceiling = contractCapCents(c, false);
    if (ceiling !== null && BigInt(c.received_cents) + r.amount_cents > ceiling) {
      throw conflict('CONTRACT_RECEIPT_EXCEEDS', '到账后累计已收将超过合同当前金额/上限');
    }
    db.prepare("UPDATE ct_receipt SET status = 'received', received_date = ?, voucher_no = ?, invoice_document_id = COALESCE(?, invoice_document_id), received_by_user_id = ?, received_at = ? WHERE id = ?")
      .run(input.receivedDate, input.voucherNo ?? null, input.invoiceDocumentId ?? null, currentAuth()?.userId ?? null, nowIso(), receiptId);
    db.prepare('UPDATE ct_contract SET received_cents = received_cents + ? WHERE id = ?').run(r.amount_cents, id);
    bump(db, id);
    recordEvent(db, id, 'receipt.receive', { receiptId, amount: centsToDecimalString(r.amount_cents), receivedDate: input.receivedDate, voucherNo: input.voucherNo ?? null });
  }).immediate();
  return getContractDetail(db, id);
}

/* ================= 跨模块收支隔离统计 ================= */

/** 管理会计 contract_paid:组织(含下级)在期间内登记支付的人民币支出合同金额(分)。 */
export function contractPaidInPeriod(db: DB, orgIds: number[] | null, period: string): bigint {
  const where = ["p.status = 'paid'", "substr(p.paid_date, 1, 7) = ?", "c.status <> 'voided'", "c.direction = 'expense'", "c.currency = '人民币'"];
  const params: unknown[] = [period];
  if (orgIds) { where.push(`c.org_id IN (${orgIds.map(() => '?').join(',') || 'NULL'})`); params.push(...orgIds); }
  return (db.prepare(`SELECT COALESCE(SUM(p.amount_cents), 0) AS s FROM ct_payment p JOIN ct_contract c ON c.id = p.contract_id WHERE ${where.join(' AND ')}`)
    .safeIntegers(true).get(...params) as { s: bigint }).s;
}

/** 管理会计 contract_payment_rate:截至期末,组织(含下级)有效人民币支出合同 已付 / 当前金额。 */
export function contractPaymentTotals(db: DB, orgIds: number[] | null): { paid: bigint; current: bigint } {
  const where = ["status IN ('active','suspended','closed','terminated')", "direction = 'expense'", "currency = '人民币'"];
  const params: unknown[] = [];
  if (orgIds) { where.push(`org_id IN (${orgIds.map(() => '?').join(',') || 'NULL'})`); params.push(...orgIds); }
  return db.prepare(`SELECT COALESCE(SUM(paid_cents), 0) AS paid, COALESCE(SUM(original_cents + approved_change_cents), 0) AS current FROM ct_contract WHERE ${where.join(' AND ')}`)
    .safeIntegers(true).get(...params) as { paid: bigint; current: bigint };
}

/** 收入合同期间收款总额(人民币,分)。 */
export function contractReceivedInPeriod(db: DB, orgIds: number[] | null, period: string): bigint {
  const where = ["r.status = 'received'", "substr(r.received_date, 1, 7) = ?", "c.status <> 'voided'", "c.direction = 'income'", "c.currency = '人民币'"];
  const params: unknown[] = [period];
  if (orgIds) { where.push(`c.org_id IN (${orgIds.map(() => '?').join(',') || 'NULL'})`); params.push(...orgIds); }
  return (db.prepare(`SELECT COALESCE(SUM(r.amount_cents), 0) AS s FROM ct_receipt r JOIN ct_contract c ON c.id = r.contract_id WHERE ${where.join(' AND ')}`)
    .safeIntegers(true).get(...params) as { s: bigint }).s;
}

/** 收入合同累计收款/合同总额(人民币,分)。 */
export function contractReceiptTotals(db: DB, orgIds: number[] | null): { received: bigint; current: bigint } {
  const where = ["status IN ('active','suspended','closed','terminated')", "direction = 'income'", "currency = '人民币'"];
  const params: unknown[] = [];
  if (orgIds) { where.push(`org_id IN (${orgIds.map(() => '?').join(',') || 'NULL'})`); params.push(...orgIds); }
  return db.prepare(`SELECT COALESCE(SUM(received_cents), 0) AS received, COALESCE(SUM(original_cents + approved_change_cents), 0) AS current FROM ct_contract WHERE ${where.join(' AND ')}`)
    .safeIntegers(true).get(...params) as { received: bigint; current: bigint };
}
