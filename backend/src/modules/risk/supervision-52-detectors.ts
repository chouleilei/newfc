import type { DB } from '../../db/connection';
import { centsToDecimalString } from '../../core/decimal';
import { calendarDaysBetween, todayUtcDate, workingDaysBetween } from '../../core/workdays';
import { procurementTier, type ProcurementTier } from '../../contracts/contract-legal-review';
import type { ChangeApprovalTier, ContractBudgetType } from '../../contracts/project-contract';
import type { RiskEvidenceStatus, RiskLevel, RiskSource, RiskThresholdKind } from '../../contracts/risk';
import { getSetting, workingCalendar } from '../settings/business-settings';
import { CHANGE_TIER_RANK } from '../contracts/contract-change.service';
import { computeBudgetPoolUsage } from '../contracts/contract-funding';
import { isMidFiveYearsTitle, isSeniorTitle } from '../contracts/contract-procurement.service';
import { previewContractPaymentTier } from '../contracts/contract-settlement.service';
import type { RiskHit, RuleRow } from './risk.service';

export interface SupervisionDetectorDef {
  name: string;
  source: RiskSource;
  thresholdKind: RiskThresholdKind | null;
  thresholdLabel: string | null;
  defaultThreshold: string | null;
  run: (db: DB, rule: RuleRow, t: bigint) => RiskHit[];
}

const POLICY_EFFECTIVE_DATE = '2026-06-25';

const PAYMENT_TIER_RANK: Record<string, number> = {
  secondary_unit_head: 1,
  finance_vp: 1,
  unit_head: 2,
  general_manager: 3,
  collective_decision: 4,
};

function isHistoricalContract(c: { sign_date: string | null; origin?: string }): boolean {
  return c.origin === 'legacy_migration' || (c.sign_date !== null && c.sign_date < POLICY_EFFECTIVE_DATE);
}

function parseJsonArr<T>(raw: string | null | undefined): T[] {
  if (!raw) return [];
  try {
    const p = JSON.parse(raw);
    return Array.isArray(p) ? (p as T[]) : [];
  } catch {
    return [];
  }
}

interface ProcRecRow {
  id: number;
  procurement_code: string | null;
  procurement_title: string;
  project_id: number | null;
  org_id: number;
  org_kind: string;
  procurement_target: 'construction' | 'goods' | 'service' | null;
  procurement_method: string | null;
  procurement_tier: ProcurementTier | null;
  estimated_cents: bigint | null;
  is_tender: number;
  is_legally_mandatory_tender: number;
  undertaker_unit_type: string | null;
  approval_tier: string;
  approver_name: string;
  mgm_decision_doc: string;
  invited_vendor_count: number | null;
  committee_size: number | null;
  committee_qualified_count: number | null;
  supplier_in_pool: number | null;
  direct_procurement_grounds_json: string;
  comparison_quotes_json: string;
  created_at: string;
}

function loadProcRecords(db: DB): ProcRecRow[] {
  return (
    db
      .prepare(
        `SELECT pr.*, o.org_kind
         FROM ct_procurement_record pr
         JOIN org o ON o.id = pr.org_id
         ORDER BY pr.id ASC`,
      )
      .safeIntegers(true)
      .all() as Record<string, unknown>[]
  ).map((r) => ({
    ...(r as unknown as ProcRecRow),
    id: Number(r.id),
    project_id: r.project_id == null ? null : Number(r.project_id),
    org_id: Number(r.org_id),
    is_tender: Number(r.is_tender ?? 0),
    is_legally_mandatory_tender: Number(r.is_legally_mandatory_tender ?? 0),
    invited_vendor_count: r.invited_vendor_count == null ? null : Number(r.invited_vendor_count),
    committee_size: r.committee_size == null ? null : Number(r.committee_size),
    committee_qualified_count: r.committee_qualified_count == null ? null : Number(r.committee_qualified_count),
    supplier_in_pool: r.supplier_in_pool == null ? null : Number(r.supplier_in_pool),
  }));
}

interface FullContractScanRow {
  id: number;
  contract_no: string;
  normalized_no: string;
  name: string;
  contract_type: string;
  org_id: number;
  org_kind: string;
  is_direct_station: number;
  project_id: number | null;
  supplier_id: number | null;
  supplier_in_pool: number | null;
  original_cents: bigint;
  approved_change_cents: bigint;
  estimated_ceiling_cents: bigint | null;
  bid_award_cents: bigint | null;
  annual_plan_alloc_cents: bigint | null;
  budget_pool_account_id: number | null;
  budget_pool_cap_cents: bigint | null;
  settled_gross_cents: bigint;
  settled_net_cents: bigint;
  paid_cents: bigint;
  received_cents: bigint;
  currency: string;
  exchange_rate_scaled: bigint | null;
  currency_struct_status: 'single' | 'structured_multi' | 'partial_unstructured';
  stage: string;
  status: string;
  source: string;
  origin: string;
  migration_mode: 'normal' | 'legacy_tolerant';
  direction: 'expense' | 'income';
  pricing_mode: 'lump_sum' | 'unit_price';
  legal_category: string;
  report_category: string;
  signing_entity_level: string;
  is_procurement: number;
  procurement_target: 'construction' | 'goods' | 'service' | null;
  procurement_method: string | null;
  procurement_tier: ProcurementTier | null;
  procurement_record_id: number | null;
  is_important: number;
  is_triple_major: number;
  decision_method: string | null;
  is_emergency: number;
  emergency_start_date: string | null;
  budget_type: ContractBudgetType;
  plan_item_id: number | null;
  external_no_exempt: number;
  duplicate_conflict_group: string;
  sign_date: string | null;
  effective_date: string | null;
  term_start_date: string | null;
  undertaker_name: string;
  distribution_status: string;
  company_filed_at: string | null;
  archive_status: string;
  archive_checked_at: string | null;
  archive_transferred_at: string | null;
  is_internal_group_tx: number;
  created_at: string;
}

function loadContracts(db: DB): FullContractScanRow[] {
  return (
    db
      .prepare(
        `SELECT c.*, o.org_kind, o.is_direct_station, s.is_in_pool AS supplier_in_pool
         FROM ct_contract c
         JOIN org o ON o.id = c.org_id
         LEFT JOIN md_supplier s ON s.id = c.supplier_id
         WHERE c.status <> 'voided'
         ORDER BY c.id ASC`,
      )
      .safeIntegers(true)
      .all() as Record<string, unknown>[]
  ).map((r) => ({
    ...(r as unknown as FullContractScanRow),
    id: Number(r.id),
    org_id: Number(r.org_id),
    is_direct_station: Number(r.is_direct_station ?? 0),
    project_id: r.project_id == null ? null : Number(r.project_id),
    supplier_id: r.supplier_id == null ? null : Number(r.supplier_id),
    supplier_in_pool: r.supplier_in_pool == null ? null : Number(r.supplier_in_pool),
    budget_pool_account_id: r.budget_pool_account_id == null ? null : Number(r.budget_pool_account_id),
    procurement_record_id: r.procurement_record_id == null ? null : Number(r.procurement_record_id),
    plan_item_id: r.plan_item_id == null ? null : Number(r.plan_item_id),
    is_procurement: Number(r.is_procurement ?? 1),
    is_important: Number(r.is_important ?? 0),
    is_triple_major: Number(r.is_triple_major ?? 0),
    is_emergency: Number(r.is_emergency ?? 0),
    external_no_exempt: Number(r.external_no_exempt ?? 0),
    is_internal_group_tx: Number(r.is_internal_group_tx ?? 0),
  }));
}

/* ---------- PW-01 & CW-02 同源采购等级自动判定不符 ---------- */
function detectPw01TierMismatch(db: DB, rule: RuleRow): RiskHit[] {
  const hits: RiskHit[] = [];
  for (const pr of loadProcRecords(db)) {
    if (!pr.procurement_target && !pr.procurement_method) continue;
    const expected = procurementTier(true, pr.procurement_target, pr.estimated_cents ?? 0n, pr.procurement_method);
    if (expected && pr.procurement_tier && pr.procurement_tier !== expected) {
      hits.push({
        ruleCode: rule.code,
        level: rule.level,
        subjectType: 'procurement_record',
        subjectId: pr.id,
        orgId: pr.org_id,
        projectId: pr.project_id,
        title: `${pr.procurement_code ?? pr.procurement_title} 采购等级判定不符`,
        description: `采购项目「${pr.procurement_title}」当前登记等级为 ${pr.procurement_tier}，按采购类别、金额及招标提级规则重算应为 ${expected}。`,
        amountCents: pr.estimated_cents,
        metric: expected,
        evidence: { procurementRecordId: pr.id, recordedTier: pr.procurement_tier, expectedTier: expected },
      });
    }
  }
  for (const c of loadContracts(db)) {
    if (c.direction !== 'expense' || !c.is_procurement) continue;
    if (!c.procurement_tier || (!c.procurement_target && !c.procurement_method)) continue;
    const amt =
      c.pricing_mode === 'unit_price' && c.original_cents === 0n && c.estimated_ceiling_cents != null
        ? c.estimated_ceiling_cents
        : c.original_cents + c.approved_change_cents;
    const expected = procurementTier(true, c.procurement_target, amt, c.procurement_method);
    if (expected && c.procurement_tier !== expected) {
      hits.push({
        ruleCode: rule.code,
        level: rule.level,
        subjectType: 'contract',
        subjectId: c.id,
        orgId: c.org_id,
        projectId: c.project_id,
        title: `${c.contract_no} ${c.name} 采购等级不符`,
        description: `合同 ${c.contract_no} 登记采购等级为 ${c.procurement_tier}，系统重算应为 ${expected}。`,
        amountCents: amt,
        metric: expected,
        evidence: { contractId: c.id, recordedTier: c.procurement_tier, expectedTier: expected },
        evidenceStatus: isHistoricalContract(c) ? 'insufficient_evidence' : 'confirmed_hit',
      });
    }
  }
  return hits;
}

/* ---------- PW-02 & CW-07 承办人未指定或调离未及时交接 ---------- */
function detectUndertakerHandover(db: DB, rule: RuleRow, procurementOnly: boolean): RiskHit[] {
  const hits: RiskHit[] = [];
  for (const c of loadContracts(db)) {
    if (procurementOnly && (!c.is_procurement || c.direction !== 'expense')) continue;
    if (c.status === 'active' && c.undertaker_name.trim() === '' && (c.sign_date !== null || c.origin !== 'manual')) {
      hits.push({
        ruleCode: rule.code,
        level: rule.level,
        subjectType: 'contract',
        subjectId: c.id,
        orgId: c.org_id,
        projectId: c.project_id,
        title: `${c.contract_no} ${c.name} 未指定承办人`,
        description: `合同 ${c.contract_no} 未登记当前承办人姓名。`,
        amountCents: null,
        metric: null,
        evidence: { contractId: c.id },
        evidenceStatus: isHistoricalContract(c) ? 'insufficient_evidence' : 'confirmed_hit',
      });
    }
  }
  const handovers = db
    .prepare(
      `SELECT h.id, h.contract_id, h.from_undertaker, h.to_undertaker, h.left_post_date, h.handover_date,
              c.contract_no, c.name, c.org_id, c.project_id, c.is_procurement, c.direction
       FROM ct_undertaker_handover h
       JOIN ct_contract c ON c.id = h.contract_id
       WHERE c.status <> 'voided' AND h.left_post_date IS NOT NULL`,
    )
    .all() as {
    id: number;
    contract_id: number;
    from_undertaker: string;
    to_undertaker: string;
    left_post_date: string;
    handover_date: string;
    contract_no: string;
    name: string;
    org_id: number;
    project_id: number | null;
    is_procurement: number;
    direction: string;
  }[];
  for (const h of handovers) {
    if (procurementOnly && (!h.is_procurement || h.direction !== 'expense')) continue;
    const wd = workingDaysBetween(h.left_post_date, h.handover_date, workingCalendar(db));
    if (wd === null || wd <= 15) continue;
    hits.push({
      ruleCode: rule.code,
      level: rule.level,
      subjectType: 'contract',
      subjectId: h.contract_id,
      sub: `handover_${h.id}`,
      orgId: h.org_id,
      projectId: h.project_id,
      title: `${h.contract_no} ${h.name} 承办人交接超15个工作日`,
      description: `原承办人 ${h.from_undertaker} 调离(${h.left_post_date})至交接(${h.handover_date})历时 ${wd} 个工作日。`,
      amountCents: null,
      metric: String(wd),
      evidence: { contractId: h.contract_id, handoverId: h.id, workingDays: wd },
    });
  }
  return hits;
}

/* ---------- PW-03 / PW-04 / PW-05 采购方案审批层级 ---------- */
function detectPwSchemeApprovalTier(db: DB, rule: RuleRow, targetTier: 'tier_1' | 'tier_2' | 'tier_3'): RiskHit[] {
  const hits: RiskHit[] = [];
  const validMap: Record<'tier_1' | 'tier_2' | 'tier_3', string[]> = {
    tier_1: ['company_mgm', '经营层', '集团经营层', '总经理办公会', '董事会'],
    tier_2: ['vp', 'company_mgm', '分管副总', '分管归口副总', '经营层', '集团经营层', '总经理办公会'],
    tier_3: ['mgmt_dept', 'vp', 'company_mgm', '归口管理部门', '归口部门', '分管副总', '经营层', '集团经营层'],
  };
  for (const pr of loadProcRecords(db)) {
    const calcTier = procurementTier(true, pr.procurement_target, pr.estimated_cents ?? 0n, pr.procurement_method);
    const effectiveTier = pr.procurement_tier ?? calcTier;
    if (effectiveTier !== targetTier) continue;
    if (targetTier === 'tier_3' && pr.undertaker_unit_type !== 'dept_center' && pr.org_kind !== 'hq_dept') continue;
    const tierText = pr.approval_tier.trim();
    if (!tierText || !validMap[targetTier].includes(tierText)) {
      hits.push({
        ruleCode: rule.code,
        level: rule.level,
        subjectType: 'procurement_record',
        subjectId: pr.id,
        orgId: pr.org_id,
        projectId: pr.project_id,
        title: `${pr.procurement_code ?? pr.procurement_title} 采购方案审批层级不符`,
        description: `采购项目「${pr.procurement_title}」（${targetTier}）方案审批层级为「${tierText || '未填'}」，不符合制度规定。`,
        amountCents: pr.estimated_cents,
        metric: tierText || 'missing',
        evidence: { procurementRecordId: pr.id, tier: effectiveTier, approvalTier: tierText },
      });
    }
  }
  return hits;
}

/* ---------- PW-06 招标项目未按一级采购管理 ---------- */
function detectPw06TenderNotTier1(db: DB, rule: RuleRow): RiskHit[] {
  const hits: RiskHit[] = [];
  for (const pr of loadProcRecords(db)) {
    const isTender = pr.is_tender === 1 || pr.procurement_method === 'public_tender' || pr.procurement_method === 'invited_tender';
    if (isTender && pr.procurement_tier && pr.procurement_tier !== 'tier_1') {
      hits.push({
        ruleCode: rule.code,
        level: rule.level,
        subjectType: 'procurement_record',
        subjectId: pr.id,
        orgId: pr.org_id,
        projectId: pr.project_id,
        title: `${pr.procurement_code ?? pr.procurement_title} 招标项目未按一级采购管理`,
        description: `招标项目「${pr.procurement_title}」采购等级被登记为 ${pr.procurement_tier}，制度规定招标采购一律按一级管理。`,
        amountCents: pr.estimated_cents,
        metric: pr.procurement_tier,
        evidence: { procurementRecordId: pr.id, recordedTier: pr.procurement_tier },
      });
    }
  }
  for (const c of loadContracts(db)) {
    if (
      (c.procurement_method === 'public_tender' || c.procurement_method === 'invited_tender') &&
      c.procurement_tier &&
      c.procurement_tier !== 'tier_1'
    ) {
      hits.push({
        ruleCode: rule.code,
        level: rule.level,
        subjectType: 'contract',
        subjectId: c.id,
        orgId: c.org_id,
        projectId: c.project_id,
        title: `${c.contract_no} ${c.name} 招标项目未按一级管理`,
        description: `招标合同 ${c.contract_no} 采购等级登记为 ${c.procurement_tier}，应为 tier_1。`,
        amountCents: c.original_cents + c.approved_change_cents,
        metric: c.procurement_tier,
        evidence: { contractId: c.id, recordedTier: c.procurement_tier },
        evidenceStatus: isHistoricalContract(c) ? 'insufficient_evidence' : 'confirmed_hit',
      });
    }
  }
  return hits;
}

/* ---------- PW-07 一级采购未公开招标且无经营层决策 ---------- */
function detectPw07Tier1NotPublicTender(db: DB, rule: RuleRow): RiskHit[] {
  const hits: RiskHit[] = [];
  for (const pr of loadProcRecords(db)) {
    const tier = pr.procurement_tier ?? procurementTier(true, pr.procurement_target, pr.estimated_cents ?? 0n, pr.procurement_method);
    if (tier !== 'tier_1' || !pr.procurement_method || pr.procurement_method === 'public_tender') continue;
    if (pr.is_legally_mandatory_tender === 1 || !pr.mgm_decision_doc.trim()) {
      hits.push({
        ruleCode: rule.code,
        level: rule.level,
        subjectType: 'procurement_record',
        subjectId: pr.id,
        orgId: pr.org_id,
        projectId: pr.project_id,
        title: `${pr.procurement_code ?? pr.procurement_title} 一级采购未公开招标缺经营层决策`,
        description: `一级采购「${pr.procurement_title}」采用 ${pr.procurement_method}，${pr.is_legally_mandatory_tender === 1 ? '属依法必招项目不得规避公开招标' : '缺少集团经营层决策文号'}。`,
        amountCents: pr.estimated_cents,
        metric: pr.procurement_method,
        evidence: { procurementRecordId: pr.id, method: pr.procurement_method, mgmDecisionDoc: pr.mgm_decision_doc },
      });
    }
  }
  for (const c of loadContracts(db)) {
    if (c.procurement_record_id || c.direction !== 'expense' || !c.is_procurement || !c.procurement_method) continue;
    const amt = c.original_cents + c.approved_change_cents;
    const tier = procurementTier(true, c.procurement_target, amt, c.procurement_method);
    if (tier === 'tier_1' && c.procurement_method !== 'public_tender') {
      const hasDecDoc = !!db
        .prepare(
          "SELECT 1 FROM ct_document WHERE contract_id = ? AND withdrawn_at IS NULL AND evidence_kind IN ('company_approval','triple_major_decision') LIMIT 1",
        )
        .get(c.id);
      if (!hasDecDoc) {
        hits.push({
          ruleCode: rule.code,
          level: rule.level,
          subjectType: 'contract',
          subjectId: c.id,
          orgId: c.org_id,
          projectId: c.project_id,
          title: `${c.contract_no} ${c.name} 一级采购未公开招标缺决策依据`,
          description: `一级采购合同 ${c.contract_no} 未采用公开招标且缺少经营层决策记录。`,
          amountCents: amt,
          metric: c.procurement_method,
          evidence: { contractId: c.id, method: c.procurement_method },
          evidenceStatus: isHistoricalContract(c) ? 'insufficient_evidence' : 'confirmed_hit',
        });
      }
    }
  }
  return hits;
}

/* ---------- PW-08 / PW-09 / PW-10 / PW-11 供应商家数不足 ---------- */
function detectPwVendorCount(db: DB, rule: RuleRow, method: string, minVendors: number): RiskHit[] {
  const hits: RiskHit[] = [];
  for (const pr of loadProcRecords(db)) {
    if (pr.procurement_method !== method) continue;
    const cnt = pr.invited_vendor_count ?? 0;
    if (cnt < minVendors) {
      hits.push({
        ruleCode: rule.code,
        level: rule.level,
        subjectType: 'procurement_record',
        subjectId: pr.id,
        orgId: pr.org_id,
        projectId: pr.project_id,
        title: `${pr.procurement_code ?? pr.procurement_title} 参与供应商不足${minVendors}家`,
        description: `采购项目「${pr.procurement_title}」（${method}）有效参与供应商 ${cnt} 家，低于法定最低 ${minVendors} 家门槛。`,
        amountCents: pr.estimated_cents,
        metric: String(cnt),
        evidence: { procurementRecordId: pr.id, method, vendorCount: cnt, minVendors },
      });
    }
  }
  return hits;
}

/* ---------- PW-12 直接采购缺合法情形或审批 ---------- */
function detectPw12DirectNoGrounds(db: DB, rule: RuleRow): RiskHit[] {
  const hits: RiskHit[] = [];
  for (const pr of loadProcRecords(db)) {
    if (pr.procurement_method !== 'direct') continue;
    const grounds = parseJsonArr<string>(pr.direct_procurement_grounds_json);
    const missingMgmDoc = grounds.includes('ground_6_group_strategic_mgm') && !pr.mgm_decision_doc.trim();
    if (grounds.length === 0 || missingMgmDoc || !pr.approval_tier.trim()) {
      hits.push({
        ruleCode: rule.code,
        level: rule.level,
        subjectType: 'procurement_record',
        subjectId: pr.id,
        orgId: pr.org_id,
        projectId: pr.project_id,
        title: `${pr.procurement_code ?? pr.procurement_title} 直接采购缺法定情形或审批`,
        description: `直接采购项目「${pr.procurement_title}」缺少 §8.1.6 法定情形、审批层级或经营层决策文号。`,
        amountCents: pr.estimated_cents,
        metric: String(grounds.length),
        evidence: { procurementRecordId: pr.id, grounds, approvalTier: pr.approval_tier },
      });
    }
  }
  for (const c of loadContracts(db)) {
    if (c.procurement_method !== 'direct' || c.procurement_record_id) continue;
    hits.push({
      ruleCode: rule.code,
      level: rule.level,
      subjectType: 'contract',
      subjectId: c.id,
      orgId: c.org_id,
      projectId: c.project_id,
      title: `${c.contract_no} ${c.name} 直接采购缺法定情形审批台账`,
      description: `直接采购合同 ${c.contract_no} 未登记直接采购法定情形（§8.1.6）及方案审批记录。`,
      amountCents: c.original_cents + c.approved_change_cents,
      metric: '0',
      evidence: { contractId: c.id },
      evidenceStatus: isHistoricalContract(c) ? 'insufficient_evidence' : 'confirmed_hit',
    });
  }
  return hits;
}

/* ---------- PW-13 3万以内发票报账无比价报告 ---------- */
function detectPw13SmallNoComparison(db: DB, rule: RuleRow): RiskHit[] {
  const hits: RiskHit[] = [];
  for (const pr of loadProcRecords(db)) {
    if (pr.procurement_method !== 'direct_reimburse') continue;
    const quotes = parseJsonArr<unknown>(pr.comparison_quotes_json);
    if (quotes.length < 2) {
      hits.push({
        ruleCode: rule.code,
        level: rule.level,
        subjectType: 'procurement_record',
        subjectId: pr.id,
        orgId: pr.org_id,
        projectId: pr.project_id,
        title: `${pr.procurement_code ?? pr.procurement_title} 3万以内发票报账无比价记录`,
        description: `小额报账项目「${pr.procurement_title}」登记比价单位 ${quotes.length} 家（要求书面市场比价报告）。`,
        amountCents: pr.estimated_cents,
        metric: String(quotes.length),
        evidence: { procurementRecordId: pr.id, quoteCount: quotes.length },
      });
    }
  }
  for (const c of loadContracts(db)) {
    if (c.procurement_method !== 'direct_reimburse' || c.procurement_record_id) continue;
    const hasDoc = !!db
      .prepare("SELECT 1 FROM ct_document WHERE contract_id = ? AND withdrawn_at IS NULL AND doc_type = 'procurement' LIMIT 1")
      .get(c.id);
    if (!hasDoc) {
      hits.push({
        ruleCode: rule.code,
        level: rule.level,
        subjectType: 'contract',
        subjectId: c.id,
        orgId: c.org_id,
        projectId: c.project_id,
        title: `${c.contract_no} ${c.name} 3万以内发票报账缺比价报告`,
        description: `3万元以内发票报账合同 ${c.contract_no} 未上传书面市场比价报告。`,
        amountCents: c.original_cents,
        metric: '0',
        evidence: { contractId: c.id },
        evidenceStatus: isHistoricalContract(c) ? 'insufficient_evidence' : 'confirmed_hit',
      });
    }
  }
  const claims = db
    .prepare(
      `SELECT id, claim_no, org_id, expense_type, amount_cents, price_compare_doc_count
       FROM ex_claim
       WHERE is_procurement_expense = 1 AND (conclusion IS NULL OR conclusion <> 'reject') AND amount_cents <= 3000000 AND price_compare_doc_count < 1`,
    )
    .safeIntegers(true)
    .all() as {
    id: bigint;
    claim_no: string;
    org_id: bigint;
    expense_type: string;
    amount_cents: bigint;
    price_compare_doc_count: bigint;
  }[];
  for (const ex of claims) {
    hits.push({
      ruleCode: rule.code,
      level: rule.level,
      subjectType: 'ex_claim',
      subjectId: Number(ex.id),
      orgId: Number(ex.org_id),
      projectId: null,
      title: `报销单 ${ex.claim_no} 小额采购报账缺少比价报告`,
      description: `采购类报销单 ${ex.claim_no}（${ex.expense_type}，金额 ${centsToDecimalString(ex.amount_cents)} 元）未附书面市场比价依据。`,
      amountCents: ex.amount_cents,
      metric: '0',
      evidence: { claimId: Number(ex.id), claimNo: ex.claim_no },
    });
  }
  return hits;
}

/* ---------- PW-14 3万以下经常性项目违规走发票报账（30日滚动拆单线索） ---------- */
function detectPw14FrequentSplitReimburse(db: DB, rule: RuleRow): RiskHit[] {
  const hits: RiskHit[] = [];
  interface SmallItem {
    kind: 'contract' | 'ex_claim';
    id: number;
    orgId: number;
    projectId: number | null;
    groupKey: string;
    groupLabel: string;
    date: string;
    cents: bigint;
  }
  const items: SmallItem[] = [];
  for (const c of loadContracts(db)) {
    if (c.procurement_method !== 'direct_reimburse') continue;
    const amt = c.original_cents + c.approved_change_cents;
    if (amt <= 0n || amt >= 3_000_000n) continue;
    const d = c.sign_date || c.created_at.slice(0, 10);
    const gk = c.supplier_id ? `sup:${c.supplier_id}` : `type:${c.contract_type || c.legal_category}`;
    items.push({
      kind: 'contract',
      id: c.id,
      orgId: c.org_id,
      projectId: c.project_id,
      groupKey: `${c.org_id}:${gk}`,
      groupLabel: c.contract_no,
      date: d,
      cents: amt,
    });
  }
  const exRows = db
    .prepare(
      `SELECT id, claim_no, org_id, expense_type, occurred_date, amount_cents
       FROM ex_claim
       WHERE is_procurement_expense = 1 AND (conclusion IS NULL OR conclusion <> 'reject') AND amount_cents > 0 AND amount_cents < 3000000`,
    )
    .safeIntegers(true)
    .all() as {
    id: bigint;
    claim_no: string;
    org_id: bigint;
    expense_type: string;
    occurred_date: string;
    amount_cents: bigint;
  }[];
  for (const ex of exRows) {
    items.push({
      kind: 'ex_claim',
      id: Number(ex.id),
      orgId: Number(ex.org_id),
      projectId: null,
      groupKey: `${Number(ex.org_id)}:exp:${ex.expense_type}`,
      groupLabel: ex.claim_no,
      date: ex.occurred_date,
      cents: ex.amount_cents,
    });
  }
  const byGroup = new Map<string, SmallItem[]>();
  for (const it of items) {
    const arr = byGroup.get(it.groupKey) ?? [];
    arr.push(it);
    byGroup.set(it.groupKey, arr);
  }
  for (const [gk, list] of byGroup.entries()) {
    if (list.length < 2) continue;
    list.sort((a, b) => a.date.localeCompare(b.date));
    for (let i = 0; i < list.length; i++) {
      const windowItems = list.filter((x) => {
        const diff = calendarDaysBetween(list[i].date, x.date);
        return diff !== null && diff >= 0 && diff <= 30;
      });
      const sum = windowItems.reduce((s, x) => s + x.cents, 0n);
      if (windowItems.length >= 2 && sum >= 3_000_000n) {
        const anchor = windowItems[windowItems.length - 1];
        hits.push({
          ruleCode: rule.code,
          level: rule.level,
          subjectType: anchor.kind,
          subjectId: anchor.id,
          sub: `split_${gk.replace(/[^a-zA-Z0-9_]/g, '_')}`,
          orgId: anchor.orgId,
          projectId: anchor.projectId,
          title: `30日内同口径小额报账累计 ${centsToDecimalString(sum)} 元疑似拆单`,
          description: `同一单位30日内发生 ${windowItems.length} 笔 3万元以下同类小额报账（${windowItems.map((w) => w.groupLabel).join('、')}），累计 ${centsToDecimalString(sum)} 元突破 30,000.00 元，应按年度/批次集中履行采购程序。`,
          amountCents: sum,
          metric: String(windowItems.length),
          evidence: { itemCount: windowItems.length, items: windowItems.map((w) => ({ kind: w.kind, id: w.id, label: w.groupLabel, date: w.date })) },
          evidenceStatus: 'suspected_clue',
        });
        break;
      }
    }
  }
  return hits;
}

/* ---------- PW-15 / PW-16 评审委员会人数不足或偶数 ---------- */
function detectPwCommitteeSize(db: DB, rule: RuleRow, tierGroup: 'tier_1_2' | 'tier_3'): RiskHit[] {
  const hits: RiskHit[] = [];
  const minSize = tierGroup === 'tier_1_2' ? 5 : 3;
  for (const pr of loadProcRecords(db)) {
    if (!pr.procurement_method || ['direct', 'direct_reimburse'].includes(pr.procurement_method)) continue;
    const tier = procurementTier(true, pr.procurement_target, pr.estimated_cents ?? 0n, pr.procurement_method) ?? pr.procurement_tier;
    if (tierGroup === 'tier_1_2') {
      if (pr.is_tender === 1 || (tier !== 'tier_1' && tier !== 'tier_2')) continue;
    } else if (tier !== 'tier_3') {
      continue;
    }
    const size = pr.committee_size ?? 0;
    if (size < minSize || size % 2 === 0) {
      hits.push({
        ruleCode: rule.code,
        level: rule.level,
        subjectType: 'procurement_record',
        subjectId: pr.id,
        orgId: pr.org_id,
        projectId: pr.project_id,
        title: `${pr.procurement_code ?? pr.procurement_title} 评审人数不合规（${size}人）`,
        description: `采购项目「${pr.procurement_title}」评审人数为 ${size} 人，不满足「${minSize}人及以上单数」规定。`,
        amountCents: pr.estimated_cents,
        metric: String(size),
        evidence: { procurementRecordId: pr.id, committeeSize: size, minSize },
      });
    }
  }
  return hits;
}

/* ---------- PW-17 / PW-18 / PW-19 评委职称与执业资格 ---------- */
function detectPwReviewerQual(db: DB, rule: RuleRow, mode: 'pw17_owner_senior' | 'pw18_tier12' | 'pw19_tier3'): RiskHit[] {
  const hits: RiskHit[] = [];
  const reviewersByRec = new Map<
    number,
    { id: number; reviewer_name: string; identity: string; title_level: string; mid_title_years: number | null; has_reg_qualification: number }[]
  >();
  const allRevs = db.prepare('SELECT * FROM ct_procurement_reviewer ORDER BY id ASC').all() as {
    id: number;
    procurement_record_id: number;
    reviewer_name: string;
    identity: string;
    title_level: string;
    mid_title_years: number | null;
    has_reg_qualification: number;
  }[];
  for (const rv of allRevs) {
    const list = reviewersByRec.get(rv.procurement_record_id) ?? [];
    list.push(rv);
    reviewersByRec.set(rv.procurement_record_id, list);
  }
  for (const pr of loadProcRecords(db)) {
    const revs = reviewersByRec.get(pr.id) ?? [];
    if (!revs.length) continue;
    const tier = procurementTier(true, pr.procurement_target, pr.estimated_cents ?? 0n, pr.procurement_method) ?? pr.procurement_tier;
    const isTender = pr.is_tender === 1 || pr.procurement_method === 'public_tender' || pr.procurement_method === 'invited_tender';
    let bad: string[] = [];
    if (mode === 'pw17_owner_senior') {
      if (!isTender) continue;
      bad = revs.filter((r) => r.identity === 'owner' && !isSeniorTitle(r.title_level)).map((r) => r.reviewer_name);
    } else if (mode === 'pw18_tier12') {
      if (isTender || (tier !== 'tier_1' && tier !== 'tier_2')) continue;
      bad = revs
        .filter((r) => !(isSeniorTitle(r.title_level) || isMidFiveYearsTitle(r.title_level, r.mid_title_years) || r.has_reg_qualification === 1))
        .map((r) => r.reviewer_name);
    } else {
      if (tier !== 'tier_3') continue;
      bad = revs
        .filter((r) => r.identity !== 'external' && !(isSeniorTitle(r.title_level) || isMidFiveYearsTitle(r.title_level, r.mid_title_years)))
        .map((r) => r.reviewer_name);
    }
    if (bad.length > 0) {
      hits.push({
        ruleCode: rule.code,
        level: rule.level,
        subjectType: 'procurement_record',
        subjectId: pr.id,
        orgId: pr.org_id,
        projectId: pr.project_id,
        title: `${pr.procurement_code ?? pr.procurement_title} 评委资格不达标`,
        description: `采购项目「${pr.procurement_title}」评委 ${bad.join('、')} 职称/年限/执业资格不符合制度 §10.2 规定。`,
        amountCents: pr.estimated_cents,
        metric: String(bad.length),
        evidence: { procurementRecordId: pr.id, unqualifiedReviewers: bad },
      });
    }
  }
  return hits;
}

/* ---------- PW-20 非招标项目未用合格库内供应商 ---------- */
function detectPw20SupplierNotInPool(db: DB, rule: RuleRow): RiskHit[] {
  const hits: RiskHit[] = [];
  for (const pr of loadProcRecords(db)) {
    const isTender = pr.is_tender === 1 || pr.procurement_method === 'public_tender' || pr.procurement_method === 'invited_tender';
    if (isTender || !pr.procurement_method || pr.procurement_method === 'direct_reimburse') continue;
    const grounds = parseJsonArr<string>(pr.direct_procurement_grounds_json);
    if (grounds.includes('ground_4_emergency_rescue')) continue;
    if (pr.supplier_in_pool === 0) {
      hits.push({
        ruleCode: rule.code,
        level: rule.level,
        subjectType: 'procurement_record',
        subjectId: pr.id,
        orgId: pr.org_id,
        projectId: pr.project_id,
        title: `${pr.procurement_code ?? pr.procurement_title} 非招标采购未选用库内供应商`,
        description: `非招标采购项目「${pr.procurement_title}」拟选供应商不在合格供应商库内且无紧急采购豁免依据。`,
        amountCents: pr.estimated_cents,
        metric: '0',
        evidence: { procurementRecordId: pr.id },
      });
    }
  }
  for (const c of loadContracts(db)) {
    if (c.procurement_record_id || c.direction !== 'expense' || !c.is_procurement || c.is_emergency === 1) continue;
    if (!c.procurement_method || ['public_tender', 'invited_tender', 'direct_reimburse'].includes(c.procurement_method)) continue;
    if (c.supplier_id !== null && c.supplier_in_pool === 0) {
      hits.push({
        ruleCode: rule.code,
        level: rule.level,
        subjectType: 'contract',
        subjectId: c.id,
        orgId: c.org_id,
        projectId: c.project_id,
        title: `${c.contract_no} ${c.name} 供应商未入合格库`,
        description: `非招标采购合同 ${c.contract_no} 关联供应商未纳入合格供应商库管理。`,
        amountCents: c.original_cents + c.approved_change_cents,
        metric: '0',
        evidence: { contractId: c.id, supplierId: c.supplier_id },
        evidenceStatus: isHistoricalContract(c) ? 'insufficient_evidence' : 'confirmed_hit',
      });
    }
  }
  return hits;
}

/* ---------- CW-01（合并 CW-03）合同编号格式与分类/重号校验 ---------- */
const STD_CONTRACT_NO_RE = /^[A-Z0-9]+[-－](JG|SG|SJ|CW|TH|XF|QT)[-－][A-Z0-9()（）补/]+[-－]\d{2,4}$/i;
function detectCw01ContractNoRule(db: DB, rule: RuleRow): RiskHit[] {
  const hits: RiskHit[] = [];
  const hasPrefixTable = (db.prepare('SELECT COUNT(*) AS n FROM ct_prefix_org_map WHERE allow_new_contract = 1').get() as { n: number }).n > 0;
  for (const c of loadContracts(db)) {
    if (c.external_no_exempt === 1) continue;
    // 跳过尚未签署且无前缀映射表的纯草稿占位记录
    if (!c.sign_date && c.origin === 'manual' && !hasPrefixTable && !c.duplicate_conflict_group) continue;
    const reasons: string[] = [];
    if (c.duplicate_conflict_group) {
      reasons.push(`与同年度/同主体合同编号存在重号冲突(${c.duplicate_conflict_group})`);
    }
    const m = c.contract_no.trim().match(/^[A-Z0-9]+[-－](JG|SG|SJ|CW|TH|XF|QT)[-－]/i);
    if (!STD_CONTRACT_NO_RE.test(c.contract_no.trim())) {
      if (hasPrefixTable || c.origin !== 'manual' || c.contract_no.includes('-SG-') || c.contract_no.includes('－')) {
        reasons.push('编号格式不匹配“单位码-YY-序号/年份-流水号”标准规则');
      }
    } else if (m) {
      const yy = m[1].toUpperCase();
      if ((c.legal_category === 'construction' || c.legal_category === 'small_construction') && !['SG', 'JG'].includes(yy)) {
        reasons.push(`工程施工类合同编号业务段为 ${yy}，应为 SG/JG`);
      } else if (c.legal_category === 'goods_procurement' && !['CW', 'SG', 'QT'].includes(yy)) {
        reasons.push(`物资采购类合同编号业务段为 ${yy}，与业务性质不一致`);
      }
    }
    if (!reasons.length) continue;
    hits.push({
      ruleCode: rule.code,
      level: rule.level,
      subjectType: 'contract',
      subjectId: c.id,
      orgId: c.org_id,
      projectId: c.project_id,
      title: `${c.contract_no} ${c.name} 合同编号不合规或重号`,
      description: `合同 ${c.contract_no}：${reasons.join('；')}。`,
      amountCents: c.original_cents + c.approved_change_cents,
      metric: null,
      evidence: { contractId: c.id, contractNo: c.contract_no, reasons },
      evidenceStatus: isHistoricalContract(c) && !c.duplicate_conflict_group ? 'insufficient_evidence' : 'confirmed_hit',
    });
  }
  return hits;
}

/* ---------- CW-04 重要合同无法律意见 / CW-06 重要合同无三重一大审批 ---------- */
function detectCwImportantGate(db: DB, rule: RuleRow, kind: 'legal_opinion' | 'triple_major'): RiskHit[] {
  const hits: RiskHit[] = [];
  for (const c of loadContracts(db)) {
    const isTarget =
      kind === 'legal_opinion'
        ? c.is_important === 1 || c.legal_category === 'important_special'
        : c.is_important === 1 || c.is_triple_major === 1 || c.legal_category === 'important_special';
    if (!isTarget || !c.sign_date) continue;
    if (kind === 'legal_opinion') {
      const hasOpinion = !!db
        .prepare("SELECT 1 FROM ct_document WHERE contract_id = ? AND withdrawn_at IS NULL AND evidence_kind = 'legal_opinion' LIMIT 1")
        .get(c.id);
      const hasRun = !!db.prepare('SELECT 1 FROM ct_legal_run WHERE contract_id = ? LIMIT 1').get(c.id);
      if (!hasOpinion && !hasRun) {
        hits.push({
          ruleCode: rule.code,
          level: rule.level,
          subjectType: 'contract',
          subjectId: c.id,
          orgId: c.org_id,
          projectId: c.project_id,
          title: `${c.contract_no} ${c.name} 重要合同缺少法律意见书`,
          description: `重要合同 ${c.contract_no} 已签署但未上传法律意见书且无专项法审记录。`,
          amountCents: c.original_cents + c.approved_change_cents,
          metric: null,
          evidence: { contractId: c.id },
          evidenceStatus: isHistoricalContract(c) ? 'insufficient_evidence' : 'confirmed_hit',
        });
      }
    } else {
      const hasTripleDoc = !!db
        .prepare("SELECT 1 FROM ct_document WHERE contract_id = ? AND withdrawn_at IS NULL AND evidence_kind = 'triple_major_decision' LIMIT 1")
        .get(c.id);
      if (!hasTripleDoc && !c.decision_method) {
        hits.push({
          ruleCode: rule.code,
          level: rule.level,
          subjectType: 'contract',
          subjectId: c.id,
          orgId: c.org_id,
          projectId: c.project_id,
          title: `${c.contract_no} ${c.name} 重要合同缺“三重一大”决策记录`,
          description: `重要合同 ${c.contract_no} 签署前缺少“三重一大”集体决策批件或纪要。`,
          amountCents: c.original_cents + c.approved_change_cents,
          metric: null,
          evidence: { contractId: c.id },
          evidenceStatus: isHistoricalContract(c) ? 'insufficient_evidence' : 'confirmed_hit',
        });
      }
    }
  }
  return hits;
}

/* ---------- CW-05 合同签订依据缺失 ---------- */
function detectCw05SigningBasisMissing(db: DB, rule: RuleRow): RiskHit[] {
  const hits: RiskHit[] = [];
  for (const c of loadContracts(db)) {
    if (!c.sign_date) continue;
    let missingReason = '';
    if (c.direction === 'expense' && c.is_procurement === 1 && c.procurement_tier !== 'exempt_small') {
      const hasProc =
        c.procurement_record_id !== null ||
        !!db
          .prepare(
            "SELECT 1 FROM ct_document WHERE contract_id = ? AND withdrawn_at IS NULL AND (doc_type = 'procurement' OR evidence_kind IN ('procurement_scheme_approval','bid_award_approval','award_notice')) LIMIT 1",
          )
          .get(c.id);
      if (!hasProc) missingReason = '采购合同缺少招采阶段审批依据';
    } else if (c.direction === 'expense' && c.is_procurement === 0) {
      const hasAppr = !!db
        .prepare(
          "SELECT 1 FROM ct_document WHERE contract_id = ? AND withdrawn_at IS NULL AND evidence_kind IN ('company_approval','triple_major_decision') LIMIT 1",
        )
        .get(c.id);
      if (!hasAppr) missingReason = '非采购类合同缺少公司批准文件或领导批示';
    } else if (c.direction === 'income' && c.is_internal_group_tx === 0) {
      const hasOffer = !!db
        .prepare(
          "SELECT 1 FROM ct_document WHERE contract_id = ? AND withdrawn_at IS NULL AND evidence_kind IN ('client_written_offer','company_approval','award_notice') LIMIT 1",
        )
        .get(c.id);
      if (!hasOffer) missingReason = '资金进项/销售服务合同缺少相对方书面邀约或中标/批准依据';
    }
    if (!missingReason) continue;
    hits.push({
      ruleCode: rule.code,
      level: rule.level,
      subjectType: 'contract',
      subjectId: c.id,
      orgId: c.org_id,
      projectId: c.project_id,
      title: `${c.contract_no} ${c.name} 合同签订依据缺失`,
      description: `已签署合同 ${c.contract_no}：${missingReason}。`,
      amountCents: c.original_cents + c.approved_change_cents,
      metric: null,
      evidence: { contractId: c.id, reason: missingReason },
      evidenceStatus: isHistoricalContract(c) ? 'insufficient_evidence' : 'confirmed_hit',
    });
  }
  return hits;
}

/* ---------- CW-08 生效前实质履行 / CW-09 应急项目超期补办 ---------- */
function detectCw08PerformBeforeEffective(db: DB, rule: RuleRow): RiskHit[] {
  const hits: RiskHit[] = [];
  for (const c of loadContracts(db)) {
    if (c.is_emergency === 1) continue;
    if (c.sign_date && c.term_start_date && c.term_start_date < c.sign_date) {
      hits.push({
        ruleCode: rule.code,
        level: rule.level,
        subjectType: 'contract',
        subjectId: c.id,
        orgId: c.org_id,
        projectId: c.project_id,
        title: `${c.contract_no} ${c.name} 合同生效前实质履行`,
        description: `合同 ${c.contract_no} 履约开始日期(${c.term_start_date})早于签署日期(${c.sign_date})。`,
        amountCents: c.original_cents + c.approved_change_cents,
        metric: null,
        evidence: { contractId: c.id, signDate: c.sign_date, termStartDate: c.term_start_date },
        evidenceStatus: isHistoricalContract(c) ? 'insufficient_evidence' : 'confirmed_hit',
      });
    }
  }
  return hits;
}

function detectCw09EmergencyOverdue(db: DB, rule: RuleRow): RiskHit[] {
  const hits: RiskHit[] = [];
  const asOf = todayUtcDate();
  for (const c of loadContracts(db)) {
    if (c.is_emergency !== 1 || !c.emergency_start_date) continue;
    const endRef = c.sign_date ?? asOf;
    const wd = workingDaysBetween(c.emergency_start_date, endRef, workingCalendar(db));
    if (wd !== null && wd > 15) {
      hits.push({
        ruleCode: rule.code,
        level: rule.level,
        subjectType: 'contract',
        subjectId: c.id,
        orgId: c.org_id,
        projectId: c.project_id,
        title: `${c.contract_no} ${c.name} 应急项目超15个工作日补办合同`,
        description: `应急合同 ${c.contract_no} 开工日(${c.emergency_start_date})至${c.sign_date ? `签署(${c.sign_date})` : '当前'}已逾 ${wd} 个工作日。`,
        amountCents: c.original_cents + c.approved_change_cents,
        metric: String(wd),
        evidence: { contractId: c.id, emergencyStartDate: c.emergency_start_date, workingDays: wd },
      });
    }
  }
  return hits;
}

/* ---------- CW-10 ~ CW-19, CW-21, CW-22, CW-23 变更与解除系列 ---------- */
interface ChangeScanRow {
  id: number;
  contract_id: number;
  change_kind: string;
  delta_cents: bigint;
  status: string;
  required_approval_tier: ChangeApprovalTier;
  actual_approval_tier: ChangeApprovalTier | null;
  involves_biz_or_entity_change: number;
  is_independent_delegable: number;
  supplement_no: string | null;
  tech_review_applied_at: string | null;
  tech_review_replied_at: string | null;
  tech_special_audit_doc_id: number | null;
  out_of_plan_doc_id: number | null;
  guarantor_consent_doc_id: number | null;
  discipline_filed_at: string | null;
  adverse_occurred_at: string | null;
  adverse_reported_at: string | null;
  submitted_at: string;
}

function loadChanges(db: DB): ChangeScanRow[] {
  return (
    db
      .prepare("SELECT * FROM ct_change WHERE status <> 'rejected' ORDER BY id ASC")
      .safeIntegers(true)
      .all() as Record<string, unknown>[]
  ).map((r) => ({
    ...(r as unknown as ChangeScanRow),
    id: Number(r.id),
    contract_id: Number(r.contract_id),
    involves_biz_or_entity_change: Number(r.involves_biz_or_entity_change ?? 0),
    is_independent_delegable: Number(r.is_independent_delegable ?? 0),
    tech_special_audit_doc_id: r.tech_special_audit_doc_id == null ? null : Number(r.tech_special_audit_doc_id),
    out_of_plan_doc_id: r.out_of_plan_doc_id == null ? null : Number(r.out_of_plan_doc_id),
    guarantor_consent_doc_id: r.guarantor_consent_doc_id == null ? null : Number(r.guarantor_consent_doc_id),
  }));
}

function detectCwChangeRules(
  db: DB,
  rule: RuleRow,
  mode: 'cw10' | 'cw11' | 'cw12' | 'cw13' | 'cw14' | 'cw17' | 'cw18' | 'cw19' | 'cw21' | 'cw22' | 'cw23',
): RiskHit[] {
  const hits: RiskHit[] = [];
  const asOf = todayUtcDate();
  const ctMap = new Map(loadContracts(db).map((c) => [c.id, c]));
  const changes = loadChanges(db);
  const cumPosBefore = new Map<number, bigint>();

  for (const ch of changes) {
    const c = ctMap.get(ch.contract_id);
    if (!c) continue;
    const prevCum = cumPosBefore.get(c.id) ?? 0n;
    if (ch.status === 'approved' && ch.delta_cents > 0n) {
      cumPosBefore.set(c.id, prevCum + ch.delta_cents);
    }
    const actualRank = ch.actual_approval_tier ? CHANGE_TIER_RANK[ch.actual_approval_tier] : 0;
    const reqRank = CHANGE_TIER_RANK[ch.required_approval_tier] ?? 1;
    const evStatus: RiskEvidenceStatus = isHistoricalContract(c) ? 'insufficient_evidence' : 'confirmed_hit';

    if (mode === 'cw10') {
      const twoPct = (c.original_cents * 2n) / 100n;
      const gate = twoPct < 20_000_000n ? twoPct : 20_000_000n;
      if (ch.delta_cents > gate && actualRank < reqRank) {
        hits.push({
          ruleCode: rule.code,
          level: rule.level,
          subjectType: 'contract',
          subjectId: c.id,
          sub: `chg_${ch.id}`,
          orgId: c.org_id,
          projectId: c.project_id,
          title: `${c.contract_no} 限额以上变更越权审批`,
          description: `合同 ${c.contract_no} 单次变更增额 ${centsToDecimalString(ch.delta_cents)} 元，实际审批层级低于 ${ch.required_approval_tier}。`,
          amountCents: ch.delta_cents,
          metric: ch.actual_approval_tier ?? 'missing',
          evidence: { contractId: c.id, changeId: ch.id },
          evidenceStatus: evStatus,
        });
      }
    } else if (mode === 'cw11') {
      const nextCum = prevCum + (ch.delta_cents > 0n ? ch.delta_cents : 0n);
      const tenPct = c.original_cents > 0n ? c.original_cents / 10n : 0n;
      if (
        ch.delta_cents > 0n &&
        (nextCum >= 500_000_000n || (tenPct > 0n && nextCum >= tenPct)) &&
        ch.actual_approval_tier !== 'management_board'
      ) {
        hits.push({
          ruleCode: rule.code,
          level: rule.level,
          subjectType: 'contract',
          subjectId: c.id,
          sub: `chg_${ch.id}`,
          orgId: c.org_id,
          projectId: c.project_id,
          title: `${c.contract_no} 累计变更达门槛未报集团经营层`,
          description: `合同 ${c.contract_no} 累计正变更达 ${centsToDecimalString(nextCum)} 元，未报集团经营层审批。`,
          amountCents: nextCum,
          metric: ch.actual_approval_tier ?? 'missing',
          evidence: { contractId: c.id, changeId: ch.id, cumulativeDelta: centsToDecimalString(nextCum) },
          evidenceStatus: evStatus,
        });
      }
    } else if (mode === 'cw12') {
      const base = c.bid_award_cents ?? c.original_cents;
      if (base > 0n && ch.delta_cents * 10n > base && !ch.tech_special_audit_doc_id) {
        const hasDoc = !!db
          .prepare("SELECT 1 FROM ct_document WHERE contract_id = ? AND withdrawn_at IS NULL AND evidence_kind = 'tech_special_audit' LIMIT 1")
          .get(c.id);
        if (!hasDoc) {
          hits.push({
            ruleCode: rule.code,
            level: rule.level,
            subjectType: 'contract',
            subjectId: c.id,
            sub: `chg_${ch.id}`,
            orgId: c.org_id,
            projectId: c.project_id,
            title: `${c.contract_no} 重大变更超中标价10%缺专项审核`,
            description: `合同 ${c.contract_no} 变更额 ${centsToDecimalString(ch.delta_cents)} 元超中标/合同价 10%，缺少技术归口部门专项审核意见。`,
            amountCents: ch.delta_cents,
            metric: null,
            evidence: { contractId: c.id, changeId: ch.id },
            evidenceStatus: evStatus,
          });
        }
      }
    } else if (mode === 'cw13' || mode === 'cw14') {
      const isCounter = ch.change_kind === 'counter_claim';
      if ((mode === 'cw14') !== isCounter || !ch.tech_review_applied_at) continue;
      const days = calendarDaysBetween(ch.tech_review_applied_at, ch.tech_review_replied_at ?? asOf);
      if (days !== null && days > 10) {
        hits.push({
          ruleCode: rule.code,
          level: rule.level,
          subjectType: 'contract',
          subjectId: c.id,
          sub: `chg_${ch.id}`,
          orgId: c.org_id,
          projectId: c.project_id,
          title: `${c.contract_no} ${isCounter ? '反索赔' : '技术方案'}审查超10日`,
          description: `合同 ${c.contract_no} 自 ${ch.tech_review_applied_at} 提交审查已逾 ${days} 日历日。`,
          amountCents: null,
          metric: String(days),
          evidence: { contractId: c.id, changeId: ch.id, calendarDays: days },
        });
      }
    } else if (mode === 'cw17') {
      if (ch.status === 'approved' && c.direction === 'expense' && ch.delta_cents > 0n && !ch.discipline_filed_at) {
        hits.push({
          ruleCode: rule.code,
          level: rule.level,
          subjectType: 'contract',
          subjectId: c.id,
          sub: `chg_${ch.id}`,
          orgId: c.org_id,
          projectId: c.project_id,
          title: `${c.contract_no} 涉支付增加变更未向纪审部备案`,
          description: `合同 ${c.contract_no} 已批准增额变更 ${centsToDecimalString(ch.delta_cents)} 元尚未登记纪审部备案日期。`,
          amountCents: ch.delta_cents,
          metric: null,
          evidence: { contractId: c.id, changeId: ch.id },
          evidenceStatus: evStatus,
        });
      }
    } else if (mode === 'cw18') {
      if (ch.status === 'approved' && (ch.delta_cents !== 0n || ch.involves_biz_or_entity_change === 1) && !ch.supplement_no) {
        const hasConfirmDoc = !!db
          .prepare(
            "SELECT 1 FROM ct_document WHERE contract_id = ? AND withdrawn_at IS NULL AND (change_id = ? OR evidence_kind = 'change_agreement') LIMIT 1",
          )
          .get(c.id, ch.id);
        if (!hasConfirmDoc) {
          hits.push({
            ruleCode: rule.code,
            level: rule.level,
            subjectType: 'contract',
            subjectId: c.id,
            sub: `chg_${ch.id}`,
            orgId: c.org_id,
            projectId: c.project_id,
            title: `${c.contract_no} 已批变更未签补充协议或合法确认文件`,
            description: `合同 ${c.contract_no} 变更 #${ch.id} 已批准但未登记补充协议编号且无变更确认协议附件。`,
            amountCents: ch.delta_cents < 0n ? -ch.delta_cents : ch.delta_cents,
            metric: null,
            evidence: { contractId: c.id, changeId: ch.id },
            evidenceStatus: evStatus,
          });
        }
      }
    } else if (mode === 'cw19') {
      const tier = c.procurement_tier ?? procurementTier(!!c.is_procurement, c.procurement_target, c.original_cents, c.procurement_method);
      if (
        ch.involves_biz_or_entity_change === 1 &&
        (tier === 'tier_1' || tier === 'tier_2') &&
        actualRank < CHANGE_TIER_RANK.undertaker_vp
      ) {
        hits.push({
          ruleCode: rule.code,
          level: rule.level,
          subjectType: 'contract',
          subjectId: c.id,
          sub: `chg_${ch.id}`,
          orgId: c.org_id,
          projectId: c.project_id,
          title: `${c.contract_no} 商务/工商主体变更未报分管领导审批`,
          description: `一/二级采购合同 ${c.contract_no} 发生实质商务或主体变更，审批层级低于承办单位分管领导。`,
          amountCents: null,
          metric: ch.actual_approval_tier ?? 'missing',
          evidence: { contractId: c.id, changeId: ch.id },
          evidenceStatus: evStatus,
        });
      }
    } else if (mode === 'cw21') {
      if (ch.is_independent_delegable === 1) {
        hits.push({
          ruleCode: rule.code,
          level: rule.level,
          subjectType: 'contract',
          subjectId: c.id,
          sub: `chg_${ch.id}`,
          orgId: c.org_id,
          projectId: c.project_id,
          title: `${c.contract_no} 违规以合同变更规避重新采购`,
          description: `合同 ${c.contract_no} 变更事项具备独立委托条件或与原合同范围无关，严禁以变更规避采购。`,
          amountCents: ch.delta_cents,
          metric: null,
          evidence: { contractId: c.id, changeId: ch.id },
        });
      }
    } else if (mode === 'cw22') {
      if (ch.change_kind === 'terminate' && actualRank < CHANGE_TIER_RANK.general_manager) {
        hits.push({
          ruleCode: rule.code,
          level: rule.level,
          subjectType: 'contract',
          subjectId: c.id,
          sub: `chg_${ch.id}`,
          orgId: c.org_id,
          projectId: c.project_id,
          title: `${c.contract_no} 合同解除未经总经理批准`,
          description: `合同 ${c.contract_no} 解除变更审批层级低于总经理。`,
          amountCents: null,
          metric: ch.actual_approval_tier ?? 'missing',
          evidence: { contractId: c.id, changeId: ch.id },
          evidenceStatus: evStatus,
        });
      }
    } else if (mode === 'cw23') {
      const hasActiveGuar = !!db
        .prepare("SELECT 1 FROM ct_guarantee WHERE contract_id = ? AND status IN ('active','claimed') LIMIT 1")
        .get(c.id);
      if (hasActiveGuar && !ch.guarantor_consent_doc_id) {
        const hasConsent = !!db
          .prepare("SELECT 1 FROM ct_document WHERE contract_id = ? AND withdrawn_at IS NULL AND evidence_kind = 'guarantor_consent' LIMIT 1")
          .get(c.id);
        if (!hasConsent) {
          hits.push({
            ruleCode: rule.code,
            level: rule.level,
            subjectType: 'contract',
            subjectId: c.id,
            sub: `chg_${ch.id}`,
            orgId: c.org_id,
            projectId: c.project_id,
            title: `${c.contract_no} 附担保合同变更/解除缺担保人书面同意`,
            description: `附有效保函/担保的合同 ${c.contract_no} 办理变更或解除时缺少担保单位书面同意文件。`,
            amountCents: null,
            metric: null,
            evidence: { contractId: c.id, changeId: ch.id },
            evidenceStatus: evStatus,
          });
        }
      }
    }
  }

  if (mode === 'cw22') {
    for (const c of ctMap.values()) {
      if (c.status !== 'terminated') continue;
      const termEv = db
        .prepare("SELECT detail_json FROM ct_event WHERE contract_id = ? AND event_type = 'terminate' ORDER BY id DESC LIMIT 1")
        .get(c.id) as { detail_json: string } | undefined;
      let okTier = false;
      if (termEv) {
        try {
          const d = JSON.parse(termEv.detail_json) as { approvalTier?: ChangeApprovalTier };
          okTier = !!d.approvalTier && CHANGE_TIER_RANK[d.approvalTier] >= CHANGE_TIER_RANK.general_manager;
        } catch {
          okTier = false;
        }
      }
      const hasTermChange = changes.some(
        (ch) =>
          ch.contract_id === c.id &&
          ch.change_kind === 'terminate' &&
          ch.actual_approval_tier &&
          CHANGE_TIER_RANK[ch.actual_approval_tier] >= CHANGE_TIER_RANK.general_manager,
      );
      if (!okTier && !hasTermChange) {
        hits.push({
          ruleCode: rule.code,
          level: rule.level,
          subjectType: 'contract',
          subjectId: c.id,
          orgId: c.org_id,
          projectId: c.project_id,
          title: `${c.contract_no} 合同解除缺少总经理批准记录`,
          description: `已终止合同 ${c.contract_no} 未查见总经理及以上批准层级记录。`,
          amountCents: null,
          metric: null,
          evidence: { contractId: c.id },
          evidenceStatus: isHistoricalContract(c) ? 'insufficient_evidence' : 'confirmed_hit',
        });
      }
    }
  }
  return hits;
}

/* ---------- CW-15 未审批变更进入结算 ---------- */
function detectCw15UnapprovedChangeInSettlement(db: DB, rule: RuleRow): RiskHit[] {
  const hits: RiskHit[] = [];
  const rows = db
    .prepare(
      `SELECT s.id, s.contract_id, s.change_claim_cents, c.contract_no, c.name, c.org_id, c.project_id, c.sign_date, c.origin
       FROM ct_settlement s
       JOIN ct_contract c ON c.id = s.contract_id
       WHERE c.status <> 'voided' AND s.status <> 'rejected' AND s.change_claim_cents > 0`,
    )
    .safeIntegers(true)
    .all() as {
    id: bigint;
    contract_id: bigint;
    change_claim_cents: bigint;
    contract_no: string;
    name: string;
    org_id: bigint;
    project_id: bigint | null;
    sign_date: string | null;
    origin: string;
  }[];
  for (const s of rows) {
    const cid = Number(s.contract_id);
    const approvedSum = (
      db
        .prepare("SELECT COALESCE(SUM(CASE WHEN delta_cents > 0 THEN delta_cents ELSE 0 END), 0) AS v FROM ct_change WHERE contract_id = ? AND status = 'approved'")
        .safeIntegers(true)
        .get(cid) as { v: bigint }
    ).v;
    if (s.change_claim_cents > approvedSum) {
      hits.push({
        ruleCode: rule.code,
        level: rule.level,
        subjectType: 'contract',
        subjectId: cid,
        sub: `settle_${Number(s.id)}`,
        orgId: Number(s.org_id),
        projectId: s.project_id === null ? null : Number(s.project_id),
        title: `${s.contract_no} 未审批变更金额进入结算单`,
        description: `结算单含变更索赔额 ${centsToDecimalString(s.change_claim_cents)} 元，超过已批准正变更合计 ${centsToDecimalString(approvedSum)} 元。`,
        amountCents: s.change_claim_cents - approvedSum,
        metric: null,
        evidence: { contractId: cid, settlementId: Number(s.id) },
        evidenceStatus: isHistoricalContract(s) ? 'insufficient_evidence' : 'confirmed_hit',
      });
    }
  }
  return hits;
}

/* ---------- CW-16 变更超计划未办计划外审批 / CW-20 总额包干超池 ---------- */
function detectCw16OverPlanNoApproval(db: DB, rule: RuleRow): RiskHit[] {
  const hits: RiskHit[] = [];
  for (const c of loadContracts(db)) {
    if (!c.plan_item_id || c.direction !== 'expense') continue;
    const plan = db
      .prepare(
        `SELECT f.amount_cents AS cap
         FROM plan_fact f JOIN plan_item i ON i.id = f.item_id JOIN plan_batch b ON b.id = i.batch_id
         WHERE i.id = ? AND b.is_current = 1 AND b.status <> 'voided'
           AND f.measure = 'annual_plan' AND f.field_key = 'annual_plan' AND f.value_type = 'amount'
         LIMIT 1`,
      )
      .safeIntegers(true)
      .get(c.plan_item_id) as { cap: bigint } | undefined;
    if (!plan) continue;
    const used = c.annual_plan_alloc_cents ?? c.original_cents + c.approved_change_cents;
    if (used > plan.cap) {
      const hasOutDoc = !!db
        .prepare("SELECT 1 FROM ct_document WHERE contract_id = ? AND withdrawn_at IS NULL AND evidence_kind = 'out_of_plan_approval' LIMIT 1")
        .get(c.id);
      if (!hasOutDoc) {
        hits.push({
          ruleCode: rule.code,
          level: rule.level,
          subjectType: 'contract',
          subjectId: c.id,
          orgId: c.org_id,
          projectId: c.project_id,
          title: `${c.contract_no} 合同及变更超计划额度未办计划外审批`,
          description: `合同 ${c.contract_no} 占用额度 ${centsToDecimalString(used)} 元，超过综合计划额度 ${centsToDecimalString(plan.cap)} 元且无计划外批件。`,
          amountCents: used - plan.cap,
          metric: null,
          evidence: { contractId: c.id, planItemId: c.plan_item_id, used: centsToDecimalString(used), cap: centsToDecimalString(plan.cap) },
        });
      }
    }
  }
  return hits;
}

function detectCw20BudgetPoolExceeded(db: DB, rule: RuleRow): RiskHit[] {
  const hits: RiskHit[] = [];
  for (const c of loadContracts(db)) {
    if (c.budget_type !== 'lump_sum_pool' || c.direction !== 'expense') continue;
    const usage = computeBudgetPoolUsage(db, c, 0n);
    if (usage && usage.capCents !== null && usage.totalUsedCents > usage.capCents) {
      hits.push({
        ruleCode: rule.code,
        level: rule.level,
        subjectType: 'contract',
        subjectId: c.id,
        orgId: c.org_id,
        projectId: c.project_id,
        title: `${c.contract_no} 生产经营总额包干项目突破年度包干总池`,
        description: `同组织包干池累计占用 ${centsToDecimalString(usage.totalUsedCents)} 元，突破池上限 ${centsToDecimalString(usage.capCents)} 元。`,
        amountCents: usage.totalUsedCents - usage.capCents,
        metric: null,
        evidence: {
          contractId: c.id,
          poolCap: centsToDecimalString(usage.capCents),
          poolUsed: centsToDecimalString(usage.totalUsedCents),
        },
      });
    }
  }
  return hits;
}

/* ---------- CW-24 纠纷结案未双备案 ---------- */
function detectCw24DisputeClosedUnfiled(db: DB, rule: RuleRow): RiskHit[] {
  const hits: RiskHit[] = [];
  const rows = db
    .prepare(
      `SELECT d.id, d.contract_id, d.case_no, d.filed_to_mgmt_at, d.filed_to_discipline_at,
              c.contract_no, c.name, c.org_id, c.project_id
       FROM ct_dispute d
       JOIN ct_contract c ON c.id = d.contract_id
       WHERE c.status <> 'voided' AND d.stage = 'closed'
         AND (d.filed_to_mgmt_at IS NULL OR d.filed_to_discipline_at IS NULL)`,
    )
    .all() as {
    id: number;
    contract_id: number;
    case_no: string;
    filed_to_mgmt_at: string | null;
    filed_to_discipline_at: string | null;
    contract_no: string;
    name: string;
    org_id: number;
    project_id: number | null;
  }[];
  for (const d of rows) {
    hits.push({
      ruleCode: rule.code,
      level: rule.level,
      subjectType: 'contract',
      subjectId: d.contract_id,
      sub: `dispute_${d.id}`,
      orgId: d.org_id,
      projectId: d.project_id,
      title: `${d.contract_no} 纠纷结案后未完成归口与纪审双备案`,
      description: `合同 ${d.contract_no} 纠纷案件(${d.case_no || `#${d.id}`})已结案，尚未补齐合同归口部门与纪审部双备案日期。`,
      amountCents: null,
      metric: null,
      evidence: { contractId: d.contract_id, disputeId: d.id },
    });
  }
  return hits;
}

/* ---------- CW-25 无验收意见或档案不完整即竣工结算 ---------- */
function detectCw25FinalSettleNoAcceptance(db: DB, rule: RuleRow): RiskHit[] {
  const hits: RiskHit[] = [];
  const finals = db
    .prepare(
      `SELECT s.id, s.contract_id, s.net_payable_cents, c.contract_no, c.name, c.org_id, c.project_id, c.archive_status, c.sign_date, c.origin
       FROM ct_settlement s
       JOIN ct_contract c ON c.id = s.contract_id
       WHERE c.status <> 'voided' AND s.settlement_kind = 'final' AND s.status = 'approved'`,
    )
    .safeIntegers(true)
    .all() as {
    id: bigint;
    contract_id: bigint;
    net_payable_cents: bigint;
    contract_no: string;
    name: string;
    org_id: bigint;
    project_id: bigint | null;
    archive_status: string;
    sign_date: string | null;
    origin: string;
  }[];
  for (const s of finals) {
    const cid = Number(s.contract_id);
    const hasAcc = !!db
      .prepare("SELECT 1 FROM ct_document WHERE contract_id = ? AND withdrawn_at IS NULL AND doc_type = 'acceptance' LIMIT 1")
      .get(cid);
    const archiveOk = ['checked', 'transferred'].includes(s.archive_status);
    if (!hasAcc || !archiveOk) {
      hits.push({
        ruleCode: rule.code,
        level: rule.level,
        subjectType: 'contract',
        subjectId: cid,
        sub: `final_settle_${Number(s.id)}`,
        orgId: Number(s.org_id),
        projectId: s.project_id === null ? null : Number(s.project_id),
        title: `${s.contract_no} 缺少书面验收意见或档案核验即办竣工结算`,
        description: `合同 ${s.contract_no} 已办理最终结算，但${!hasAcc ? '缺少书面验收合格文件' : ''}${!hasAcc && !archiveOk ? '且' : ''}${!archiveOk ? '档案尚未验收' : ''}。`,
        amountCents: s.net_payable_cents,
        metric: null,
        evidence: { contractId: cid, settlementId: Number(s.id), hasAcceptanceDoc: hasAcc, archiveStatus: s.archive_status },
        evidenceStatus: isHistoricalContract(s) ? 'insufficient_evidence' : 'confirmed_hit',
      });
    }
  }
  return hits;
}

/* ---------- CW-26 单次支付审批层级不符 ---------- */
function detectCw26PaymentTierMismatch(db: DB, rule: RuleRow): RiskHit[] {
  const hits: RiskHit[] = [];
  const rows = db
    .prepare(
      `SELECT p.id, p.contract_id, p.amount_cents, p.approval_tier, p.planned_date, p.paid_date,
              c.contract_no, c.name, c.org_id, c.project_id, c.sign_date, c.origin
       FROM ct_payment p
       JOIN ct_contract c ON c.id = p.contract_id
       WHERE c.status <> 'voided' AND p.kind = 'normal' AND p.status IN ('submitted','approved','paid')`,
    )
    .safeIntegers(true)
    .all() as {
    id: bigint;
    contract_id: bigint;
    amount_cents: bigint;
    approval_tier: string | null;
    planned_date: string | null;
    paid_date: string | null;
    contract_no: string;
    name: string;
    org_id: bigint;
    project_id: bigint | null;
    sign_date: string | null;
    origin: string;
  }[];
  for (const p of rows) {
    // 跳过早期纯 SQL 夹具中无签署日且付款早于制度生效日且未填审批层级的合成记录
    if (!p.approval_tier && !p.sign_date && p.origin === 'manual' && (p.paid_date ?? p.planned_date ?? '2000-01-01') < POLICY_EFFECTIVE_DATE) {
      continue;
    }
    const cid = Number(p.contract_id);
    let reqTier = 'finance_vp';
    try {
      const preview = previewContractPaymentTier(db, cid, {
        amount: centsToDecimalString(p.amount_cents),
        plannedDate: p.paid_date ?? p.planned_date ?? undefined,
      });
      reqTier = preview.requiredTier;
    } catch {
      reqTier = p.amount_cents > 50_000_000n ? 'unit_head' : 'finance_vp';
    }
    const actualRank = p.approval_tier ? (PAYMENT_TIER_RANK[p.approval_tier] ?? 0) : 0;
    const reqRank = PAYMENT_TIER_RANK[reqTier] ?? 1;
    if (actualRank < reqRank) {
      const isHist = isHistoricalContract(p) && !p.approval_tier;
      hits.push({
        ruleCode: rule.code,
        level: rule.level,
        subjectType: 'contract',
        subjectId: cid,
        sub: `pay_${Number(p.id)}`,
        orgId: Number(p.org_id),
        projectId: p.project_id === null ? null : Number(p.project_id),
        title: `${p.contract_no} 单次付款审批层级不符`,
        description: `付款 ${centsToDecimalString(p.amount_cents)} 元登记审批层级为「${p.approval_tier ?? '未登记'}」，低于应批层级「${reqTier}」。`,
        amountCents: p.amount_cents,
        metric: p.approval_tier ?? 'missing',
        evidence: { contractId: cid, paymentId: Number(p.id), actualTier: p.approval_tier, requiredTier: reqTier },
        evidenceStatus: isHist ? 'insufficient_evidence' : 'confirmed_hit',
      });
    }
  }
  return hits;
}

/* ---------- CW-27 超结超付 ---------- */
function detectCw27OverSettleOrPay(db: DB, rule: RuleRow): RiskHit[] {
  const hits: RiskHit[] = [];
  for (const c of loadContracts(db)) {
    if (c.direction !== 'expense') continue;
    const cap =
      c.pricing_mode === 'unit_price'
        ? c.estimated_ceiling_cents
        : c.original_cents + c.approved_change_cents;
    if (cap === null || cap <= 0n) continue;
    if (c.settled_net_cents > cap || c.paid_cents > cap) {
      const over = (c.paid_cents > c.settled_net_cents ? c.paid_cents : c.settled_net_cents) - cap;
      hits.push({
        ruleCode: rule.code,
        level: rule.level,
        subjectType: 'contract',
        subjectId: c.id,
        orgId: c.org_id,
        projectId: c.project_id,
        title: `${c.contract_no} ${c.name} 超结超付`,
        description: `合同 ${c.contract_no} 有效总额上限 ${centsToDecimalString(cap)} 元，累计结算 ${centsToDecimalString(c.settled_net_cents)} 元、累计支付 ${centsToDecimalString(c.paid_cents)} 元。`,
        amountCents: over,
        metric: null,
        evidence: { contractId: c.id, cap: centsToDecimalString(cap), settled: centsToDecimalString(c.settled_net_cents), paid: centsToDecimalString(c.paid_cents) },
      });
    }
  }
  return hits;
}

/* ---------- CW-28 月度合同信息未按时通过 OA 正式报送（仅导出不消警） ---------- */
function detectCw28MonthlyReportOverdue(db: DB, rule: RuleRow): RiskHit[] {
  const hits: RiskHit[] = [];
  const asOf = todayUtcDate();
  const curMonth = asOf.slice(0, 7);
  const dayOfMonth = Number(asOf.slice(8, 10));

  // 1) 已在 ct_monthly_report_log 有导出记录但未正式登记 OA 报送且已过该月28日
  const logs = db
    .prepare(
      `SELECT l.id, l.org_id, l.report_month, l.exported_at, l.submitted_at, l.oa_ref_no, o.name AS org_name
       FROM ct_monthly_report_log l
       JOIN org o ON o.id = l.org_id
       WHERE l.submitted_at IS NULL OR TRIM(l.oa_ref_no) = ''`,
    )
    .all() as {
    id: number;
    org_id: number;
    report_month: string;
    exported_at: string | null;
    submitted_at: string | null;
    oa_ref_no: string;
    org_name: string;
  }[];
  const flaggedOrgMonth = new Set<string>();
  for (const l of logs) {
    const isPast28 = l.report_month < curMonth || (l.report_month === curMonth && dayOfMonth > 28);
    if (!isPast28) continue;
    flaggedOrgMonth.add(`${l.org_id}:${l.report_month}`);
    hits.push({
      ruleCode: rule.code,
      level: rule.level,
      subjectType: 'org',
      subjectId: l.org_id,
      sub: `month_${l.report_month}`,
      orgId: l.org_id,
      projectId: null,
      title: `${l.org_name} ${l.report_month} 月度合同5表未完成 OA 正式报送`,
      description: `${l.org_name} ${l.report_month} 月报${l.exported_at ? '虽已下载导出 Excel，但' : ''}未在每月28日前登记 OA 正式报送流程单号。`,
      amountCents: null,
      metric: l.report_month,
      evidence: { orgId: l.org_id, reportMonth: l.report_month, exportedAt: l.exported_at },
    });
  }

  // 2) 当月已过28日且有新签制度生效后合同的单位，完全无当月 OA 报送记录
  if (dayOfMonth > 28) {
    const activeOrgs = db
      .prepare(
        `SELECT DISTINCT c.org_id, o.name AS org_name
         FROM ct_contract c
         JOIN org o ON o.id = c.org_id
         WHERE c.status <> 'voided' AND c.sign_date IS NOT NULL AND c.sign_date >= ?`,
      )
      .all(POLICY_EFFECTIVE_DATE) as { org_id: number; org_name: string }[];
    for (const o of activeOrgs) {
      if (flaggedOrgMonth.has(`${o.org_id}:${curMonth}`)) continue;
      const ok = db
        .prepare(
          "SELECT 1 FROM ct_monthly_report_log WHERE org_id = ? AND report_month = ? AND submitted_at IS NOT NULL AND TRIM(oa_ref_no) <> ''",
        )
        .get(o.org_id, curMonth);
      if (!ok) {
        hits.push({
          ruleCode: rule.code,
          level: rule.level,
          subjectType: 'org',
          subjectId: o.org_id,
          sub: `month_${curMonth}`,
          orgId: o.org_id,
          projectId: null,
          title: `${o.org_name} ${curMonth} 月度合同信息未按时报送`,
          description: `${o.org_name} 未在 ${curMonth}-28 前通过 OA 报送月度合同5表。`,
          amountCents: null,
          metric: curMonth,
          evidence: { orgId: o.org_id, reportMonth: curMonth },
        });
      }
    }
  }
  return hits;
}

/* ---------- CW-29 异常情形（不利变更/索赔/纠纷）超 2 个工作日报告 ---------- */
function detectCw29AbnormalReportOverdue(db: DB, rule: RuleRow): RiskHit[] {
  const hits: RiskHit[] = [];
  const asOf = todayUtcDate();
  const cal = workingCalendar(db);
  const ctMap = new Map(loadContracts(db).map((c) => [c.id, c]));
  for (const ch of loadChanges(db)) {
    const c = ctMap.get(ch.contract_id);
    if (!c) continue;
    const occ = ch.adverse_occurred_at;
    if (!occ) continue;
    const wd = workingDaysBetween(occ, ch.adverse_reported_at ?? asOf, cal);
    if (wd !== null && wd > 2) {
      hits.push({
        ruleCode: rule.code,
        level: rule.level,
        subjectType: 'contract',
        subjectId: c.id,
        sub: `adv_chg_${ch.id}`,
        orgId: c.org_id,
        projectId: c.project_id,
        title: `${c.contract_no} 不利变更/索赔超2个工作日未报告`,
        description: `合同 ${c.contract_no} 异常情形发生于 ${occ}，${ch.adverse_reported_at ? `至 ${ch.adverse_reported_at} 才报告` : '至今未书面报告'}（历时 ${wd} 个工作日，超 2 工作日时限）。`,
        amountCents: ch.delta_cents < 0n ? -ch.delta_cents : ch.delta_cents,
        metric: String(wd),
        evidence: { contractId: c.id, changeId: ch.id, occurredAt: occ, reportedAt: ch.adverse_reported_at, workingDays: wd },
      });
    }
  }
  const disputes = db
    .prepare(
      `SELECT d.id, d.contract_id, d.occurred_date, d.reported_to_dept_at, d.dispute_cents,
              c.contract_no, c.org_id, c.project_id
       FROM ct_dispute d
       JOIN ct_contract c ON c.id = d.contract_id
       WHERE c.status <> 'voided'`,
    )
    .safeIntegers(true)
    .all() as {
    id: bigint;
    contract_id: bigint;
    occurred_date: string;
    reported_to_dept_at: string | null;
    dispute_cents: bigint;
    contract_no: string;
    org_id: bigint;
    project_id: bigint | null;
  }[];
  for (const d of disputes) {
    const wd = workingDaysBetween(d.occurred_date, d.reported_to_dept_at ?? asOf, cal);
    if (wd !== null && wd > 2) {
      hits.push({
        ruleCode: rule.code,
        level: rule.level,
        subjectType: 'contract',
        subjectId: Number(d.contract_id),
        sub: `adv_disp_${Number(d.id)}`,
        orgId: Number(d.org_id),
        projectId: d.project_id === null ? null : Number(d.project_id),
        title: `${d.contract_no} 合同纠纷超2个工作日未书面报告`,
        description: `合同 ${d.contract_no} 纠纷发生于 ${d.occurred_date}，历时 ${wd} 个工作日（超 2 工作日上限）。`,
        amountCents: d.dispute_cents,
        metric: String(wd),
        evidence: { contractId: Number(d.contract_id), disputeId: Number(d.id), workingDays: wd },
      });
    }
  }
  return hits;
}

/* ---------- CW-30 档案验收后超可配置天数未移交 ---------- */
function detectCw30ArchiveTransferOverdue(db: DB, rule: RuleRow): RiskHit[] {
  const hits: RiskHit[] = [];
  const slaDays = Number(getSetting<number>(db, 'contract.archive_transfer_sla_days') ?? 0);
  const customRuleDays = rule.version > 1 && rule.threshold ? Math.round(Number(rule.threshold)) : 0;
  const limitDays = slaDays > 0 ? slaDays : customRuleDays;
  if (!limitDays || limitDays <= 0) return [];
  const asOf = todayUtcDate();
  for (const c of loadContracts(db)) {
    if (c.archive_status !== 'checked' || !c.archive_checked_at) continue;
    const days = calendarDaysBetween(c.archive_checked_at, asOf);
    if (days !== null && days > limitDays) {
      hits.push({
        ruleCode: rule.code,
        level: rule.level,
        subjectType: 'contract',
        subjectId: c.id,
        orgId: c.org_id,
        projectId: c.project_id,
        title: `${c.contract_no} 档案验收后超 ${limitDays} 日未移交档案室`,
        description: `合同 ${c.contract_no} 于 ${c.archive_checked_at} 完成档案核验，已逾 ${days} 日仍未办理集中归档移交。`,
        amountCents: null,
        metric: String(days),
        evidence: { contractId: c.id, archiveCheckedAt: c.archive_checked_at, days, limitDays },
      });
    }
  }
  return hits;
}

/* ---------- CW-31 直属电站进项合同签约主体 / CW-32 分子公司外部进项合同10工作日备案 ---------- */
function detectCw31DirectStationIncome(db: DB, rule: RuleRow): RiskHit[] {
  const hits: RiskHit[] = [];
  for (const c of loadContracts(db)) {
    if (c.direction !== 'income' || c.is_direct_station !== 1) continue;
    if (c.signing_entity_level !== 'company') {
      hits.push({
        ruleCode: rule.code,
        level: rule.level,
        subjectType: 'contract',
        subjectId: c.id,
        orgId: c.org_id,
        projectId: c.project_id,
        title: `${c.contract_no} 直属电站资金进项合同未以集团母公司名义签订`,
        description: `直属水电站进项合同 ${c.contract_no} 签约主体层级为 ${c.signing_entity_level}，违反直属电站统一以集团公司名义对外签约规定。`,
        amountCents: c.original_cents + c.approved_change_cents,
        metric: c.signing_entity_level,
        evidence: { contractId: c.id, signingEntityLevel: c.signing_entity_level },
        evidenceStatus: isHistoricalContract(c) ? 'insufficient_evidence' : 'confirmed_hit',
      });
    }
  }
  return hits;
}

function detectCw32SubsidiaryIncomeFiling(db: DB, rule: RuleRow): RiskHit[] {
  const hits: RiskHit[] = [];
  const asOf = todayUtcDate();
  const cal = workingCalendar(db);
  for (const c of loadContracts(db)) {
    // 严格区分直属电站(is_direct_station=1)与分子公司(is_direct_station=0)，并排除集团内部关联交易(is_internal_group_tx=1)
    if (c.direction !== 'income' || c.is_direct_station === 1 || c.is_internal_group_tx === 1) continue;
    if (c.signing_entity_level !== 'secondary_unit' || !c.sign_date) continue;
    const wd = workingDaysBetween(c.sign_date, c.company_filed_at ?? asOf, cal);
    if (wd !== null && wd > 10 && (!c.company_filed_at || wd > 10)) {
      hits.push({
        ruleCode: rule.code,
        level: rule.level,
        subjectType: 'contract',
        subjectId: c.id,
        orgId: c.org_id,
        projectId: c.project_id,
        title: `${c.contract_no} 分/子公司外部进项合同超10个工作日未报备`,
        description: `分/子公司进项合同 ${c.contract_no} 签署于 ${c.sign_date}，${c.company_filed_at ? `至 ${c.company_filed_at} 才报备` : '至今未报归口部门与财务结算中心备案'}（历时 ${wd} 个工作日）。`,
        amountCents: c.original_cents + c.approved_change_cents,
        metric: String(wd),
        evidence: { contractId: c.id, signDate: c.sign_date, companyFiledAt: c.company_filed_at, workingDays: wd },
        evidenceStatus: isHistoricalContract(c) && !c.company_filed_at ? 'insufficient_evidence' : 'confirmed_hit',
      });
    }
  }
  return hits;
}

const det = (
  name: string,
  run: (db: DB, rule: RuleRow, t: bigint) => RiskHit[],
  source: RiskSource = 'contract',
): SupervisionDetectorDef => ({
  name,
  source,
  thresholdKind: null,
  thresholdLabel: null,
  defaultThreshold: null,
  run,
});

export const SUPERVISION_52_DETECTORS: Record<string, SupervisionDetectorDef> = {
  PW_01: det('采购等级自动判定不符', (db, r) => detectPw01TierMismatch(db, r)),
  PW_02: det('承办人变更后未指定新承办人', (db, r) => detectUndertakerHandover(db, r, true)),
  PW_03: det('一级采购方案未经经营层审批', (db, r) => detectPwSchemeApprovalTier(db, r, 'tier_1')),
  PW_04: det('二级采购方案未经分管归口副总审批', (db, r) => detectPwSchemeApprovalTier(db, r, 'tier_2')),
  PW_05: det('三级采购（职能部门承办）方案未经归口部门审批', (db, r) => detectPwSchemeApprovalTier(db, r, 'tier_3')),
  PW_06: det('招标项目未按一级采购管理', (db, r) => detectPw06TenderNotTier1(db, r)),
  PW_07: det('一级采购未公开招标且无经营层决策', (db, r) => detectPw07Tier1NotPublicTender(db, r)),
  PW_08: det('邀请招标邀请数量不足', (db, r) => detectPwVendorCount(db, r, 'invited_tender', 3)),
  PW_09: det('谈判采购供应商不足2家', (db, r) => detectPwVendorCount(db, r, 'negotiation', 2)),
  PW_10: det('询比采购供应商不足4家（制度门槛不足3家）', (db, r) => detectPwVendorCount(db, r, 'inquiry', 3)),
  PW_11: det('竞价采购供应商不足4家（制度门槛不足3家）', (db, r) => detectPwVendorCount(db, r, 'bidding', 3)),
  PW_12: det('直接采购缺合法情形或审批', (db, r) => detectPw12DirectNoGrounds(db, r)),
  PW_13: det('3万以内发票报账无比价报告', (db, r) => detectPw13SmallNoComparison(db, r)),
  PW_14: det('3万以下经常性项目违规走发票报账', (db, r) => detectPw14FrequentSplitReimburse(db, r)),
  PW_15: det('一、二级非招标评审人数不足', (db, r) => detectPwCommitteeSize(db, r, 'tier_1_2')),
  PW_16: det('三级采购评审人数不足', (db, r) => detectPwCommitteeSize(db, r, 'tier_3')),
  PW_17: det('业主评委职称不达标', (db, r) => detectPwReviewerQual(db, r, 'pw17_owner_senior')),
  PW_18: det('一、二级非招标评委资格不达标', (db, r) => detectPwReviewerQual(db, r, 'pw18_tier12')),
  PW_19: det('三级采购评委资格不达标', (db, r) => detectPwReviewerQual(db, r, 'pw19_tier3')),
  PW_20: det('非招标项目未用库内供应商', (db, r) => detectPw20SupplierNotInPool(db, r)),
  CW_01: det('合同编号不符合编号规则（合并CW-03）', (db, r) => detectCw01ContractNoRule(db, r)),
  CW_02: det('采购等级自动判定不符（复用PW-01）', (db, r) => detectPw01TierMismatch(db, r)),
  CW_04: det('重要合同谈判无法律顾问参与或法律意见', (db, r) => detectCwImportantGate(db, r, 'legal_opinion')),
  CW_05: det('合同签订依据缺失', (db, r) => detectCw05SigningBasisMissing(db, r)),
  CW_06: det('重要合同未经“三重一大”审批', (db, r) => detectCwImportantGate(db, r, 'triple_major')),
  CW_07: det('承办人未指定或未及时交接', (db, r) => detectUndertakerHandover(db, r, false)),
  CW_08: det('合同生效前实质履行', (db, r) => detectCw08PerformBeforeEffective(db, r)),
  CW_09: det('应急项目超期补办合同', (db, r) => detectCw09EmergencyOverdue(db, r)),
  CW_10: det('限额以上变更未经对应层级审批', (db, r) => detectCwChangeRules(db, r, 'cw10')),
  CW_11: det('累计变更达门槛后未报经营层', (db, r) => detectCwChangeRules(db, r, 'cw11')),
  CW_12: det('重大变更缺专项审核', (db, r) => detectCwChangeRules(db, r, 'cw12')),
  CW_13: det('技术方案审查超时', (db, r) => detectCwChangeRules(db, r, 'cw13')),
  CW_14: det('反索赔审查超时', (db, r) => detectCwChangeRules(db, r, 'cw14')),
  CW_15: det('未审批变更进入结算', (db, r) => detectCw15UnapprovedChangeInSettlement(db, r)),
  CW_16: det('变更超计划未办计划外审批', (db, r) => detectCw16OverPlanNoApproval(db, r)),
  CW_17: det('涉支付增加未向纪审部备案', (db, r) => detectCwChangeRules(db, r, 'cw17')),
  CW_18: det('变更后应签补充协议未签', (db, r) => detectCwChangeRules(db, r, 'cw18')),
  CW_19: det('商务条款/工商信息变更未报分管领导审批', (db, r) => detectCwChangeRules(db, r, 'cw19')),
  CW_20: det('生产经营总额包干项目突破包干总额', (db, r) => detectCw20BudgetPoolExceeded(db, r)),
  CW_21: det('违规以变更规避采购', (db, r) => detectCwChangeRules(db, r, 'cw21')),
  CW_22: det('合同解除未经总经理批准', (db, r) => detectCwChangeRules(db, r, 'cw22')),
  CW_23: det('担保合同变更/解除无担保单位书面同意', (db, r) => detectCwChangeRules(db, r, 'cw23')),
  CW_24: det('纠纷案结后未备案', (db, r) => detectCw24DisputeClosedUnfiled(db, r)),
  CW_25: det('无验收意见或档案不完整即结算', (db, r) => detectCw25FinalSettleNoAcceptance(db, r)),
  CW_26: det('单次支付审批层级不符', (db, r) => detectCw26PaymentTierMismatch(db, r)),
  CW_27: det('超结超付', (db, r) => detectCw27OverSettleOrPay(db, r)),
  CW_28: det('月度合同信息未按时报送', (db, r) => detectCw28MonthlyReportOverdue(db, r)),
  CW_29: det('异常情形超期报告', (db, r) => detectCw29AbnormalReportOverdue(db, r)),
  CW_30: {
    name: '验收后超期未归档',
    source: 'contract',
    thresholdKind: 'amount',
    thresholdLabel: '移交超期天数',
    defaultThreshold: '30',
    run: (db, r) => detectCw30ArchiveTransferOverdue(db, r),
  },
  CW_31: det('直属电站资金进项合同未以集团公司名义签订', (db, r) => detectCw31DirectStationIncome(db, r)),
  CW_32: det('分/子公司资金进项合同超期未报备', (db, r) => detectCw32SubsidiaryIncomeFiling(db, r)),
};
