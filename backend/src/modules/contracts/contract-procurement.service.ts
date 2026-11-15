import type { DB } from '../../db/connection';
import { AppError, Errors } from '../../core/errors';
import { currentAuth } from '../../core/request-context';
import { centsToDecimalString, parseDecimalToCents } from '../../core/decimal';
import { writeLog } from '../audit/log';
import { currentOrgScope, notVisible, orgInScope, scopeFilterSql } from '../security/scope';
import {
  procurementTier,
  type ProcurementMethod,
  type ProcurementTarget,
  type ProcurementTier,
} from '../../contracts/contract-legal-review';
import type {
  DirectProcurementGround,
  MonthlyReportLogDto,
  MonthlyReportLogRequest,
  ProcurementRecordDto,
  ProcurementRecordSaveRequest,
  ProcurementReviewerDto,
  ProcurementReviewerInput,
} from '../../contracts/project-contract';
import { syncContractCountersigns } from './contract-countersign.service';
import type { ContractRow } from './contract.service';

const nowIso = () => new Date().toISOString();

export function isSeniorTitle(titleLevel: string): boolean {
  const t = titleLevel.trim();
  if (!t) return false;
  return (
    t.includes('正高') ||
    t.includes('高级') ||
    t.includes('副高') ||
    t.includes('教授') ||
    t.includes('研究员')
  );
}

export function isMidFiveYearsTitle(titleLevel: string, midTitleYears: number | null | undefined): boolean {
  if (isSeniorTitle(titleLevel)) return true;
  const t = titleLevel.trim();
  const hasMid =
    t.includes('中级') ||
    t.includes('工程师') ||
    t.includes('经济师') ||
    t.includes('会计师') ||
    t.includes('审计师') ||
    t.includes('讲师');
  return hasMid && (midTitleYears ?? 0) >= 5;
}

export function evaluateReviewerQualified(
  r: Pick<ProcurementReviewerInput, 'identity' | 'titleLevel' | 'midTitleYears' | 'hasRegQualification'>,
  isTender: boolean,
  tier: ProcurementTier | null,
): boolean {
  const title = r.titleLevel ?? '';
  const reg = !!r.hasRegQualification;
  if (isTender && r.identity === 'owner') {
    // PW-17: 招标项目业主评委须具备高级及以上职称
    return isSeniorTitle(title);
  }
  if (tier === 'tier_1' || tier === 'tier_2' || isTender) {
    // PW-18: 一、二级非招标及专家评委须满足高级职称 / 中级满5年 / 注册执业资格之一
    return isSeniorTitle(title) || isMidFiveYearsTitle(title, r.midTitleYears) || reg;
  }
  // PW-19: 三级采购职工评委须满足中级职称满5年及以上（或高级/外部注册执业资格）
  if (r.identity === 'external' && reg) return true;
  return isSeniorTitle(title) || isMidFiveYearsTitle(title, r.midTitleYears);
}

function parseJsonArray<T>(raw: string | null | undefined): T[] {
  if (!raw) return [];
  try {
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed) ? (parsed as T[]) : [];
  } catch {
    return [];
  }
}

function computeProcurementWarnings(row: {
  procurement_method: ProcurementMethod | null;
  procurement_tier: ProcurementTier | null;
  is_tender: number;
  is_legally_mandatory_tender: number;
  undertaker_unit_type: string | null;
  approval_tier: string;
  mgm_decision_doc: string;
  invited_vendor_count: number | null;
  committee_size: number | null;
  committee_qualified_count: number | null;
  supplier_in_pool: number | null;
  direct_procurement_grounds_json: string;
  comparison_quotes_json: string;
  announcement_date: string | null;
  doc_sale_start_date: string | null;
  bid_open_date: string | null;
  eval_report_submit_date: string | null;
  candidate_publicity_start: string | null;
  award_notice_date: string | null;
}): string[] {
  const warnings: string[] = [];
  const method = row.procurement_method;
  const tier = row.procurement_tier;
  const grounds = parseJsonArray<string>(row.direct_procurement_grounds_json);
  const quotes = parseJsonArray<{ vendorName: string; quoteAmount: string }>(row.comparison_quotes_json);

  if (tier === 'tier_1' && row.approval_tier && !['company_mgm', '经营层', '集团经营层', '总经理办公会'].includes(row.approval_tier)) {
    warnings.push('PW-03：一级采购（含招标项目）方案须经集团经营层审批');
  }
  if (tier === 'tier_2' && row.approval_tier && !['vp', 'company_mgm', '分管副总', '分管归口副总', '经营层'].includes(row.approval_tier)) {
    warnings.push('PW-04：二级采购方案须经分管归口副总经理及以上审批');
  }
  if (
    tier === 'tier_3' &&
    row.undertaker_unit_type === 'dept_center' &&
    row.approval_tier &&
    !['mgmt_dept', 'vp', 'company_mgm', '归口管理部门', '归口部门', '分管副总', '经营层'].includes(row.approval_tier)
  ) {
    warnings.push('PW-05：职能部门/中心承办三级采购方案须经归口管理部门审批');
  }
  if (tier === 'tier_1' && method && method !== 'public_tender' && !row.mgm_decision_doc.trim()) {
    warnings.push('PW-07：一级采购未公开招标须补充非依法必招认定及集团经营层决策文号');
  }
  if (method === 'invited_tender' && row.invited_vendor_count !== null && row.invited_vendor_count < 3) {
    warnings.push('PW-08：邀请招标有效投标单位不足3家');
  }
  if (method === 'negotiation' && row.invited_vendor_count !== null && row.invited_vendor_count < 2) {
    warnings.push('PW-09：谈判采购参与供应商不足2家');
  }
  if (method === 'inquiry' && row.invited_vendor_count !== null && row.invited_vendor_count < 3) {
    warnings.push('PW-10：询比采购有效报价供应商不足3家');
  }
  if (method === 'bidding' && row.invited_vendor_count !== null && row.invited_vendor_count < 3) {
    warnings.push('PW-11：竞价采购有效报价供应商不足3家');
  }
  if (method === 'direct' && grounds.length === 0) {
    warnings.push('PW-12：直接采购未勾选法定情形（§8.1.6）');
  }
  if (method === 'direct_reimburse' && quotes.length < 2) {
    warnings.push('PW-13：3万元以内发票报账建议登记不少于2家书面市场比价记录');
  }
  const size = row.committee_size ?? 0;
  const qual = row.committee_qualified_count ?? 0;
  if (size > 0 && method && !['direct', 'direct_reimburse'].includes(method)) {
    if ((tier === 'tier_1' || tier === 'tier_2') && !row.is_tender && (size < 5 || size % 2 === 0)) {
      warnings.push('PW-15：一、二级非招标评审委员会人数须为5人及以上单数');
    }
    if (tier === 'tier_3' && (size < 3 || size % 2 === 0)) {
      warnings.push('PW-16：三级采购评审委员会人数须为3人及以上单数');
    }
    if (qual < size) {
      warnings.push(`评审委员会共有 ${size - qual} 名评委未满足制度职称/年限/执业资格要求`);
    }
  }
  if (!row.is_tender && method && method !== 'direct_reimburse' && row.supplier_in_pool === 0) {
    warnings.push('PW-20：非招标采购拟选供应商不在合格供应商库内');
  }
  if (row.announcement_date && row.bid_open_date && row.announcement_date > row.bid_open_date) {
    warnings.push('时间顺序异常：招标公告日期晚于开标日期');
  }
  if (row.bid_open_date && row.eval_report_submit_date && row.bid_open_date > row.eval_report_submit_date) {
    warnings.push('时间顺序异常：开标日期晚于评标报告提交日期');
  }
  if (row.candidate_publicity_start && row.award_notice_date && row.candidate_publicity_start > row.award_notice_date) {
    warnings.push('时间顺序异常：候选人公示起始日期晚于中标通知书发出日期');
  }
  return warnings;
}

function mapProcurementDto(db: DB, rawRow: Record<string, unknown>): ProcurementRecordDto {
  const scope = currentOrgScope(db);
  const id = Number(rawRow.id);
  const orgId = Number(rawRow.org_id);
  const orgRow = db.prepare('SELECT name FROM org WHERE id = ?').get(orgId) as { name: string } | undefined;
  const reviewers = (
    db.prepare('SELECT * FROM ct_procurement_reviewer WHERE procurement_record_id = ? ORDER BY id ASC').all(id) as {
      id: number;
      reviewer_name: string;
      identity: 'owner' | 'staff' | 'external';
      title_level: string;
      mid_title_years: number | null;
      has_reg_qualification: number;
      is_qualified: number;
    }[]
  ).map(
    (r): ProcurementReviewerDto => ({
      id: r.id,
      reviewerName: r.reviewer_name,
      identity: r.identity,
      titleLevel: r.title_level,
      midTitleYears: r.mid_title_years,
      hasRegQualification: r.has_reg_qualification === 1,
      isQualified: r.is_qualified === 1,
    }),
  );

  const linkedRaw = db.prepare(
    `SELECT c.id, c.contract_no, c.name, c.org_id, o.name AS org_name
     FROM ct_contract c
     JOIN org o ON o.id = c.org_id
     WHERE c.procurement_record_id = ? AND c.status <> 'voided'
     ORDER BY c.id ASC`,
  ).all(id) as { id: number; contract_no: string; name: string; org_id: number; org_name: string }[];

  const linkedContracts = linkedRaw.map((lc) => {
    if (orgInScope(scope, lc.org_id)) {
      return {
        id: lc.id,
        contractNo: lc.contract_no,
        name: lc.name,
        orgId: lc.org_id,
        orgName: lc.org_name,
      };
    }
    return {
      id: lc.id,
      contractNo: '跨单位合同（已脱敏）',
      name: '无权查看他单位关联合同详情',
      orgId: lc.org_id,
      orgName: lc.org_name,
      redacted: true,
    };
  });

  const estCents = rawRow.estimated_cents == null ? null : BigInt(rawRow.estimated_cents as bigint | number);
  const method = (rawRow.procurement_method as ProcurementMethod | null) ?? null;
  const target = (rawRow.procurement_target as ProcurementTarget | null) ?? null;
  const tier = (rawRow.procurement_tier as ProcurementTier | null) ?? null;
  const isTender = Number(rawRow.is_tender ?? 0) === 1;

  return {
    id,
    procurementCode: (rawRow.procurement_code as string | null) ?? null,
    procurementTitle: String(rawRow.procurement_title ?? ''),
    projectId: rawRow.project_id == null ? null : Number(rawRow.project_id),
    orgId,
    orgName: orgRow?.name ?? null,
    procurementTarget: target,
    procurementMethod: method,
    procurementTier: tier,
    estimatedAmount: estCents === null ? null : centsToDecimalString(estCents),
    isTender,
    isLegallyMandatoryTender: Number(rawRow.is_legally_mandatory_tender ?? 0) === 1,
    undertakerUnitType: (rawRow.undertaker_unit_type as 'dept_center' | 'secondary_unit' | null) ?? null,
    approvalTier: String(rawRow.approval_tier ?? ''),
    approverName: String(rawRow.approver_name ?? ''),
    twiceTenderFailed: Number(rawRow.twice_tender_failed ?? 0) === 1,
    isInvoiceReimburse: Number(rawRow.is_invoice_reimburse ?? 0) === 1,
    mgmDecisionDoc: String(rawRow.mgm_decision_doc ?? ''),
    tenderAgency: String(rawRow.tender_agency ?? ''),
    planSubmittedAt: (rawRow.plan_submitted_at as string | null) ?? null,
    announcementDate: (rawRow.announcement_date as string | null) ?? null,
    prequalSaleStart: (rawRow.prequal_sale_start as string | null) ?? null,
    prequalSaleEnd: (rawRow.prequal_sale_end as string | null) ?? null,
    docSaleStartDate: (rawRow.doc_sale_start_date as string | null) ?? null,
    clarificationSiteDate: (rawRow.clarification_site_date as string | null) ?? null,
    bidOpenDate: (rawRow.bid_open_date as string | null) ?? null,
    evalReportSubmitDate: (rawRow.eval_report_submit_date as string | null) ?? null,
    evalReportReceiveDate: (rawRow.eval_report_receive_date as string | null) ?? null,
    candidatePublicityStart: (rawRow.candidate_publicity_start as string | null) ?? null,
    candidatePublicityEnd: (rawRow.candidate_publicity_end as string | null) ?? null,
    awardNoticeDate: (rawRow.award_notice_date as string | null) ?? null,
    invitedVendorCount: rawRow.invited_vendor_count == null ? null : Number(rawRow.invited_vendor_count),
    committeeSize: Number(rawRow.committee_size ?? reviewers.length),
    committeeQualifiedCount: Number(rawRow.committee_qualified_count ?? reviewers.filter((r) => r.isQualified).length),
    supplierInPool: rawRow.supplier_in_pool == null ? null : Number(rawRow.supplier_in_pool) === 1,
    directProcurementGrounds: parseJsonArray<DirectProcurementGround>(rawRow.direct_procurement_grounds_json as string),
    candidateRanking: parseJsonArray<{ rank: number; vendorName: string; bidAmount: string }>(
      rawRow.candidate_ranking_json as string,
    ),
    comparisonQuotes: parseJsonArray<{ vendorName: string; quoteAmount: string; selected: boolean }>(
      rawRow.comparison_quotes_json as string,
    ),
    protestFlag: Number(rawRow.protest_flag ?? 0) === 1,
    protestDetail: String(rawRow.protest_detail ?? ''),
    protestResolvedAt: (rawRow.protest_resolved_at as string | null) ?? null,
    reviewers,
    linkedContracts,
    linkedContractCount: linkedRaw.length,
    warnings: computeProcurementWarnings({
      procurement_method: method,
      procurement_tier: tier,
      is_tender: isTender ? 1 : 0,
      is_legally_mandatory_tender: Number(rawRow.is_legally_mandatory_tender ?? 0),
      undertaker_unit_type: (rawRow.undertaker_unit_type as string | null) ?? null,
      approval_tier: String(rawRow.approval_tier ?? ''),
      mgm_decision_doc: String(rawRow.mgm_decision_doc ?? ''),
      invited_vendor_count: rawRow.invited_vendor_count == null ? null : Number(rawRow.invited_vendor_count),
      committee_size: Number(rawRow.committee_size ?? reviewers.length),
      committee_qualified_count: Number(rawRow.committee_qualified_count ?? reviewers.filter((r) => r.isQualified).length),
      supplier_in_pool: rawRow.supplier_in_pool == null ? null : Number(rawRow.supplier_in_pool),
      direct_procurement_grounds_json: String(rawRow.direct_procurement_grounds_json ?? '[]'),
      comparison_quotes_json: String(rawRow.comparison_quotes_json ?? '[]'),
      announcement_date: (rawRow.announcement_date as string | null) ?? null,
      doc_sale_start_date: (rawRow.doc_sale_start_date as string | null) ?? null,
      bid_open_date: (rawRow.bid_open_date as string | null) ?? null,
      eval_report_submit_date: (rawRow.eval_report_submit_date as string | null) ?? null,
      candidate_publicity_start: (rawRow.candidate_publicity_start as string | null) ?? null,
      award_notice_date: (rawRow.award_notice_date as string | null) ?? null,
    }),
    createdAt: String(rawRow.created_at),
    updatedAt: String(rawRow.updated_at),
  };
}

export function listProcurementRecords(
  db: DB,
  q: { orgId?: number; keyword?: string; procurementMethod?: string } = {},
): ProcurementRecordDto[] {
  const scope = currentOrgScope(db);
  if (q.orgId && !orgInScope(scope, q.orgId)) throw notVisible('组织');
  const sc = scopeFilterSql(scope, 'pr.org_id');
  const scLink = scopeFilterSql(scope, 'c.org_id');
  const where: string[] = [`(${sc.sql} OR EXISTS (SELECT 1 FROM ct_contract c WHERE c.procurement_record_id = pr.id AND ${scLink.sql}))`];
  const params: unknown[] = [...sc.params, ...scLink.params];

  if (q.orgId) {
    where.push('pr.org_id = ?');
    params.push(q.orgId);
  }
  if (q.procurementMethod) {
    where.push('pr.procurement_method = ?');
    params.push(q.procurementMethod);
  }
  if (q.keyword?.trim()) {
    const k = `%${q.keyword.trim().replace(/[%_]/g, '')}%`;
    where.push('(pr.procurement_code LIKE ? OR pr.procurement_title LIKE ?)');
    params.push(k, k);
  }

  const rows = db
    .prepare(`SELECT pr.* FROM ct_procurement_record pr WHERE ${where.join(' AND ')} ORDER BY pr.id DESC LIMIT 300`)
    .safeIntegers(true)
    .all(...params) as Record<string, unknown>[];
  return rows.map((r) => mapProcurementDto(db, r));
}

export function getProcurementRecord(db: DB, pid: number): ProcurementRecordDto {
  const scope = currentOrgScope(db);
  const row = db
    .prepare('SELECT * FROM ct_procurement_record WHERE id = ?')
    .safeIntegers(true)
    .get(pid) as Record<string, unknown> | undefined;
  if (!row) throw notVisible('招采项目记录');
  const orgOk = orgInScope(scope, Number(row.org_id));
  if (!orgOk) {
    const scLink = scopeFilterSql(scope, 'c.org_id');
    const linkedVisible = db
      .prepare(`SELECT 1 FROM ct_contract c WHERE c.procurement_record_id = ? AND ${scLink.sql} LIMIT 1`)
      .get(pid, ...scLink.params);
    if (!linkedVisible) throw notVisible('招采项目记录');
  }
  return mapProcurementDto(db, row);
}

function validateAndDeriveProcurementPayload(input: ProcurementRecordSaveRequest) {
  const estCents = input.estimatedAmount == null
    ? null
    : parseDecimalToCents(input.estimatedAmount, { label: '采购估算金额' });
  if (estCents !== null && estCents < 0n) {
    throw Errors.validation('采购估算金额不能为负');
  }
  const isTender = input.procurementMethod === 'public_tender' || input.procurementMethod === 'invited_tender';
  const isInvoiceReimburse = input.procurementMethod === 'direct_reimburse';
  if (isInvoiceReimburse && estCents !== null && estCents > 3_000_000n) {
    throw Errors.validation('3万元以内发票报账（direct_reimburse）估算金额不得超过 30,000.00 元');
  }
  const rawTier = procurementTier(true, input.procurementTarget, estCents ?? 0n, input.procurementMethod);
  const tier = rawTier === 'non_procurement' ? null : rawTier;

  // 严格分流 direct（直接采购 §8.1.6 八情形）与 direct_reimburse（发票报账 §8.1.7 比价）
  let grounds: DirectProcurementGround[] = [];
  if (input.procurementMethod === 'direct') {
    grounds = [...new Set(input.directProcurementGrounds ?? [])];
    if (grounds.length === 0) {
      throw Errors.validation('直接采购须至少选择 1 项法定情形（§8.1.6）');
    }
    if (grounds.includes('ground_6_group_strategic_mgm') && !(input.mgmDecisionDoc ?? '').trim()) {
      throw Errors.validation('选择情形6（集团经营层专题决策）时须填写经营层决策文号');
    }
  }

  if (input.protestFlag && !(input.protestDetail ?? '').trim()) {
    throw Errors.validation('存在质疑/澄清/投诉/举报情形时，请填写具体情况说明');
  }

  const evaluatedReviewers = (input.reviewers ?? []).map((r) => ({
    reviewerName: r.reviewerName.trim(),
    identity: r.identity,
    titleLevel: (r.titleLevel ?? '').trim(),
    midTitleYears: r.midTitleYears ?? null,
    hasRegQualification: !!r.hasRegQualification,
    isQualified: evaluateReviewerQualified(r, isTender, tier),
  }));
  const committeeSize = evaluatedReviewers.length;
  const committeeQualifiedCount = evaluatedReviewers.filter((r) => r.isQualified).length;

  return {
    estCents,
    isTender,
    isInvoiceReimburse,
    tier,
    grounds,
    evaluatedReviewers,
    committeeSize,
    committeeQualifiedCount,
  };
}

export function createProcurementRecord(db: DB, input: ProcurementRecordSaveRequest): ProcurementRecordDto {
  const scope = currentOrgScope(db);
  if (!orgInScope(scope, input.orgId)) throw notVisible('组织');
  const derived = validateAndDeriveProcurementPayload(input);
  const codeTrimmed = (input.procurementCode ?? '').trim() || null;

  const pid = db.transaction(() => {
    if (codeTrimmed) {
      const dup = db.prepare('SELECT id FROM ct_procurement_record WHERE procurement_code = ?').get(codeTrimmed);
      if (dup) throw new AppError('PROCUREMENT_CODE_EXISTS', `采购项目编号 ${codeTrimmed} 已存在`, 409);
    }
    const now = nowIso();
    const newId = Number(
      db.prepare(
        `INSERT INTO ct_procurement_record (
          procurement_code, procurement_title, project_id, org_id,
          procurement_target, procurement_method, procurement_tier, estimated_cents,
          is_tender, is_legally_mandatory_tender, undertaker_unit_type, approval_tier, approver_name,
          twice_tender_failed, is_invoice_reimburse, mgm_decision_doc, tender_agency,
          plan_submitted_at, announcement_date, prequal_sale_start, prequal_sale_end,
          doc_sale_start_date, clarification_site_date, bid_open_date,
          eval_report_submit_date, eval_report_receive_date,
          candidate_publicity_start, candidate_publicity_end, award_notice_date,
          invited_vendor_count, committee_size, committee_qualified_count, supplier_in_pool,
          direct_procurement_grounds_json, candidate_ranking_json, comparison_quotes_json,
          protest_flag, protest_detail, protest_resolved_at,
          created_by_user_id, created_at, updated_at
        ) VALUES (
          ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?,
          ?, ?,
          ?, ?, ?,
          ?, ?, ?, ?,
          ?, ?, ?,
          ?, ?, ?,
          ?, ?, ?
        )`,
      ).run(
        codeTrimmed,
        input.procurementTitle.trim(),
        input.projectId ?? null,
        input.orgId,
        input.procurementTarget,
        input.procurementMethod,
        derived.tier,
        derived.estCents,
        derived.isTender ? 1 : 0,
        input.isLegallyMandatoryTender ? 1 : 0,
        input.undertakerUnitType ?? null,
        (input.approvalTier ?? '').trim(),
        (input.approverName ?? '').trim(),
        input.twiceTenderFailed ? 1 : 0,
        derived.isInvoiceReimburse ? 1 : 0,
        (input.mgmDecisionDoc ?? '').trim(),
        (input.tenderAgency ?? '').trim(),
        input.planSubmittedAt ?? null,
        input.announcementDate ?? null,
        input.prequalSaleStart ?? null,
        input.prequalSaleEnd ?? null,
        input.docSaleStartDate ?? null,
        input.clarificationSiteDate ?? null,
        input.bidOpenDate ?? null,
        input.evalReportSubmitDate ?? null,
        input.evalReportReceiveDate ?? null,
        input.candidatePublicityStart ?? null,
        input.candidatePublicityEnd ?? null,
        input.awardNoticeDate ?? null,
        input.invitedVendorCount ?? null,
        derived.committeeSize,
        derived.committeeQualifiedCount,
        input.supplierInPool == null ? null : input.supplierInPool ? 1 : 0,
        JSON.stringify(derived.grounds),
        JSON.stringify(input.candidateRanking ?? []),
        JSON.stringify(input.comparisonQuotes ?? []),
        input.protestFlag ? 1 : 0,
        input.protestFlag ? (input.protestDetail ?? '').trim() : '',
        input.protestFlag ? (input.protestResolvedAt ?? null) : null,
        currentAuth()?.userId ?? null,
        now,
        now,
      ).lastInsertRowid,
    );

    const insRev = db.prepare(
      `INSERT INTO ct_procurement_reviewer (
        procurement_record_id, reviewer_name, identity, title_level, mid_title_years, has_reg_qualification, is_qualified
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const r of derived.evaluatedReviewers) {
      insRev.run(
        newId,
        r.reviewerName,
        r.identity,
        r.titleLevel,
        r.midTitleYears,
        r.hasRegQualification ? 1 : 0,
        r.isQualified ? 1 : 0,
      );
    }
    writeLog(db, 'contract.procurement.create', 'ct_procurement_record', newId, {
      procurementCode: codeTrimmed,
      title: input.procurementTitle.trim(),
      method: input.procurementMethod,
      tier: derived.tier,
    });
    return newId;
  }).immediate();

  return getProcurementRecord(db, pid);
}

export function updateProcurementRecord(
  db: DB,
  pid: number,
  input: ProcurementRecordSaveRequest,
): ProcurementRecordDto {
  const scope = currentOrgScope(db);
  const existing = db
    .prepare('SELECT * FROM ct_procurement_record WHERE id = ?')
    .safeIntegers(true)
    .get(pid) as Record<string, unknown> | undefined;
  if (!existing) throw notVisible('招采项目记录');
  if (!orgInScope(scope, Number(existing.org_id))) throw notVisible('招采项目记录');
  if (!orgInScope(scope, input.orgId)) throw notVisible('组织');

  const linked = db
    .prepare("SELECT * FROM ct_contract WHERE procurement_record_id = ? AND status <> 'voided' ORDER BY id ASC")
    .safeIntegers(true)
    .all(pid) as Record<string, unknown>[];

  // 1:N 共享权限校验：操作人必须对全部关联合同具备范围权限
  for (const lc of linked) {
    if (!orgInScope(scope, Number(lc.org_id))) {
      throw new AppError(
        'SHARED_PROCUREMENT_SCOPE_DENIED',
        '该招采记录已被其他单位合同共享引用，当前账号无全范围编辑权限',
        403,
      );
    }
  }
  if (linked.length > 1 && !input.updateShared) {
    throw new AppError(
      'SHARED_PROCUREMENT_CONFIRM_REQUIRED',
      `该招采项目已关联 ${linked.length} 份合同，修改将同步影响所有关联合同，请确认共享更新 (updateShared: true)`,
      409,
      undefined,
      { linkedContractCount: linked.length },
    );
  }

  const derived = validateAndDeriveProcurementPayload(input);
  const codeTrimmed = (input.procurementCode ?? '').trim() || null;
  const beforeDto = mapProcurementDto(db, existing);

  db.transaction(() => {
    if (codeTrimmed && codeTrimmed !== existing.procurement_code) {
      const dup = db
        .prepare('SELECT id FROM ct_procurement_record WHERE procurement_code = ? AND id <> ?')
        .get(codeTrimmed, pid);
      if (dup) throw new AppError('PROCUREMENT_CODE_EXISTS', `采购项目编号 ${codeTrimmed} 已存在`, 409);
    }
    const now = nowIso();
    db.prepare(
      `UPDATE ct_procurement_record SET
        procurement_code = ?, procurement_title = ?, project_id = ?, org_id = ?,
        procurement_target = ?, procurement_method = ?, procurement_tier = ?, estimated_cents = ?,
        is_tender = ?, is_legally_mandatory_tender = ?, undertaker_unit_type = ?, approval_tier = ?, approver_name = ?,
        twice_tender_failed = ?, is_invoice_reimburse = ?, mgm_decision_doc = ?, tender_agency = ?,
        plan_submitted_at = ?, announcement_date = ?, prequal_sale_start = ?, prequal_sale_end = ?,
        doc_sale_start_date = ?, clarification_site_date = ?, bid_open_date = ?,
        eval_report_submit_date = ?, eval_report_receive_date = ?,
        candidate_publicity_start = ?, candidate_publicity_end = ?, award_notice_date = ?,
        invited_vendor_count = ?, committee_size = ?, committee_qualified_count = ?, supplier_in_pool = ?,
        direct_procurement_grounds_json = ?, candidate_ranking_json = ?, comparison_quotes_json = ?,
        protest_flag = ?, protest_detail = ?, protest_resolved_at = ?,
        updated_at = ?
      WHERE id = ?`,
    ).run(
      codeTrimmed,
      input.procurementTitle.trim(),
      input.projectId ?? null,
      input.orgId,
      input.procurementTarget,
      input.procurementMethod,
      derived.tier,
      derived.estCents,
      derived.isTender ? 1 : 0,
      input.isLegallyMandatoryTender ? 1 : 0,
      input.undertakerUnitType ?? null,
      (input.approvalTier ?? '').trim(),
      (input.approverName ?? '').trim(),
      input.twiceTenderFailed ? 1 : 0,
      derived.isInvoiceReimburse ? 1 : 0,
      (input.mgmDecisionDoc ?? '').trim(),
      (input.tenderAgency ?? '').trim(),
      input.planSubmittedAt ?? null,
      input.announcementDate ?? null,
      input.prequalSaleStart ?? null,
      input.prequalSaleEnd ?? null,
      input.docSaleStartDate ?? null,
      input.clarificationSiteDate ?? null,
      input.bidOpenDate ?? null,
      input.evalReportSubmitDate ?? null,
      input.evalReportReceiveDate ?? null,
      input.candidatePublicityStart ?? null,
      input.candidatePublicityEnd ?? null,
      input.awardNoticeDate ?? null,
      input.invitedVendorCount ?? null,
      derived.committeeSize,
      derived.committeeQualifiedCount,
      input.supplierInPool == null ? null : input.supplierInPool ? 1 : 0,
      JSON.stringify(derived.grounds),
      JSON.stringify(input.candidateRanking ?? []),
      JSON.stringify(input.comparisonQuotes ?? []),
      input.protestFlag ? 1 : 0,
      input.protestFlag ? (input.protestDetail ?? '').trim() : '',
      input.protestFlag ? (input.protestResolvedAt ?? null) : null,
      now,
      pid,
    );

    db.prepare('DELETE FROM ct_procurement_reviewer WHERE procurement_record_id = ?').run(pid);
    const insRev = db.prepare(
      `INSERT INTO ct_procurement_reviewer (
        procurement_record_id, reviewer_name, identity, title_level, mid_title_years, has_reg_qualification, is_qualified
      ) VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const r of derived.evaluatedReviewers) {
      insRev.run(
        pid,
        r.reviewerName,
        r.identity,
        r.titleLevel,
        r.midTitleYears,
        r.hasRegQualification ? 1 : 0,
        r.isQualified ? 1 : 0,
      );
    }

    // 同步刷新早期阶段关联合同摘要字段，并在要素变化时触发会签状态重评
    const materialChanged =
      existing.procurement_method !== input.procurementMethod ||
      existing.procurement_target !== input.procurementTarget ||
      existing.procurement_tier !== derived.tier ||
      String(existing.estimated_cents ?? '') !== String(derived.estCents ?? '');

    for (const lc of linked) {
      const cid = Number(lc.id);
      if (['initiation', 'procurement', 'drafting'].includes(String(lc.stage)) && lc.status === 'active') {
        db.prepare(
          `UPDATE ct_contract
           SET procurement_target = ?, procurement_method = ?, procurement_tier = ?, version = version + 1, updated_at = ?
           WHERE id = ?`,
        ).run(input.procurementTarget, input.procurementMethod, derived.tier, now, cid);
      } else if (materialChanged) {
        db.prepare('UPDATE ct_contract SET version = version + 1, updated_at = ? WHERE id = ?').run(now, cid);
      }
      if (materialChanged && lc.status === 'active') {
        const refreshed = db.prepare('SELECT * FROM ct_contract WHERE id = ?').safeIntegers(true).get(cid) as unknown as ContractRow;
        syncContractCountersigns(db, { ...refreshed, id: Number(refreshed.id), org_id: Number(refreshed.org_id), procurement_record_id: Number(refreshed.procurement_record_id) });
      }
    }

    const afterRow = db.prepare('SELECT * FROM ct_procurement_record WHERE id = ?').safeIntegers(true).get(pid) as Record<string, unknown>;
    const afterDto = mapProcurementDto(db, afterRow);
    db.prepare(
      `INSERT INTO ct_procurement_revision_log (
        procurement_record_id, before_json, after_json, affected_contract_ids_json, actor_user_id, created_at
      ) VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(
      pid,
      JSON.stringify(beforeDto),
      JSON.stringify(afterDto),
      JSON.stringify(linked.map((l) => Number(l.id))),
      currentAuth()?.userId ?? null,
      now,
    );
    writeLog(db, 'contract.procurement.update', 'ct_procurement_record', pid, {
      affectedContractCount: linked.length,
      materialChanged,
    });
  }).immediate();

  return getProcurementRecord(db, pid);
}

export function getContractProcurement(db: DB, contractRow: ContractRow): ProcurementRecordDto | null {
  if (!contractRow.procurement_record_id) return null;
  const row = db
    .prepare('SELECT * FROM ct_procurement_record WHERE id = ?')
    .safeIntegers(true)
    .get(contractRow.procurement_record_id) as Record<string, unknown> | undefined;
  if (!row) return null;
  return mapProcurementDto(db, row);
}

export function saveContractProcurement(
  db: DB,
  contractRow: ContractRow,
  body: Record<string, unknown>,
): ProcurementRecordDto | null {
  if (contractRow.status === 'voided') {
    throw new AppError('CONTRACT_STATE', '已作废合同不能编辑招采过程记录', 409);
  }
  // 支持仅关联或解绑已有采购记录
  if ('linkProcurementRecordId' in body && !('procurementTitle' in body)) {
    const linkId = body.linkProcurementRecordId == null ? null : Number(body.linkProcurementRecordId);
    const now = nowIso();
    if (linkId === null) {
      db.prepare('UPDATE ct_contract SET procurement_record_id = NULL, version = version + 1, updated_at = ? WHERE id = ?').run(
        now,
        contractRow.id,
      );
      return null;
    }
    const target = getProcurementRecord(db, linkId);
    db.transaction(() => {
      if (['initiation', 'procurement', 'drafting'].includes(contractRow.stage) && contractRow.status === 'active') {
        db.prepare(
          `UPDATE ct_contract
           SET procurement_record_id = ?, procurement_target = COALESCE(?, procurement_target),
               procurement_method = COALESCE(?, procurement_method), procurement_tier = COALESCE(?, procurement_tier),
               version = version + 1, updated_at = ?
           WHERE id = ?`,
        ).run(linkId, target.procurementTarget, target.procurementMethod, target.procurementTier, now, contractRow.id);
      } else {
        db.prepare('UPDATE ct_contract SET procurement_record_id = ?, version = version + 1, updated_at = ? WHERE id = ?').run(
          linkId,
          now,
          contractRow.id,
        );
      }
      const refreshed = db.prepare('SELECT * FROM ct_contract WHERE id = ?').safeIntegers(true).get(contractRow.id) as unknown as ContractRow;
      syncContractCountersigns(db, { ...refreshed, id: Number(refreshed.id), org_id: Number(refreshed.org_id), procurement_record_id: Number(refreshed.procurement_record_id) });
    }).immediate();
    return getProcurementRecord(db, linkId);
  }

  const parsed = body as ProcurementRecordSaveRequest;
  const targetId = parsed.linkProcurementRecordId ?? contractRow.procurement_record_id;
  if (targetId) {
    if (targetId !== contractRow.procurement_record_id) {
      db.prepare('UPDATE ct_contract SET procurement_record_id = ?, version = version + 1, updated_at = ? WHERE id = ?').run(
        targetId,
        nowIso(),
        contractRow.id,
      );
    }
    return updateProcurementRecord(db, targetId, parsed);
  }

  const created = createProcurementRecord(db, parsed);
  const now = nowIso();
  if (['initiation', 'procurement', 'drafting'].includes(contractRow.stage) && contractRow.status === 'active') {
    db.prepare(
      `UPDATE ct_contract
       SET procurement_record_id = ?, procurement_target = ?, procurement_method = ?, procurement_tier = ?,
           version = version + 1, updated_at = ?
       WHERE id = ?`,
    ).run(created.id, created.procurementTarget, created.procurementMethod, created.procurementTier, now, contractRow.id);
  } else {
    db.prepare('UPDATE ct_contract SET procurement_record_id = ?, version = version + 1, updated_at = ? WHERE id = ?').run(
      created.id,
      now,
      contractRow.id,
    );
  }
  return getProcurementRecord(db, created.id);
}

/* ================= 月度合同 5 表导出与 OA 正式报送日志（CW-28 联动） ================= */

export function recordMonthlyReportExported(db: DB, orgId: number, reportMonth: string): void {
  const now = nowIso();
  db.prepare(
    `INSERT INTO ct_monthly_report_log (org_id, report_month, exported_at)
     VALUES (?, ?, ?)
     ON CONFLICT(org_id, report_month) DO UPDATE SET exported_at = excluded.exported_at`,
  ).run(orgId, reportMonth, now);
}

export function listMonthlyReportLogs(
  db: DB,
  q: { orgId?: number; reportMonth?: string } = {},
): MonthlyReportLogDto[] {
  const scope = currentOrgScope(db);
  if (q.orgId && !orgInScope(scope, q.orgId)) throw notVisible('组织');
  const sc = scopeFilterSql(scope, 'l.org_id');
  const where = [sc.sql];
  const params: unknown[] = [...sc.params];
  if (q.orgId) {
    where.push('l.org_id = ?');
    params.push(q.orgId);
  }
  if (q.reportMonth) {
    where.push('l.report_month = ?');
    params.push(q.reportMonth);
  }
  const rows = db.prepare(
    `SELECT l.*, o.name AS org_name, COALESCE(u.display_name, u.username) AS submitted_by_name
     FROM ct_monthly_report_log l
     JOIN org o ON o.id = l.org_id
     LEFT JOIN app_user u ON u.id = l.submitted_by_user_id
     WHERE ${where.join(' AND ')}
     ORDER BY l.report_month DESC, l.org_id ASC LIMIT 200`,
  ).all(...params) as {
    id: number;
    org_id: number;
    org_name: string;
    report_month: string;
    exported_at: string | null;
    submitted_at: string | null;
    oa_ref_no: string;
    receipt_attachment_id: number | null;
    submitted_by_name: string | null;
  }[];
  return rows.map((r) => ({
    id: r.id,
    orgId: r.org_id,
    orgName: r.org_name,
    reportMonth: r.report_month,
    exportedAt: r.exported_at,
    submittedAt: r.submitted_at,
    oaRefNo: r.oa_ref_no,
    receiptAttachmentId: r.receipt_attachment_id,
    submittedByName: r.submitted_by_name,
  }));
}

export function submitMonthlyReportLog(db: DB, input: MonthlyReportLogRequest): MonthlyReportLogDto {
  const scope = currentOrgScope(db);
  const auth = currentAuth();
  let targetOrgId = input.orgId;
  if (!targetOrgId) {
    if (!scope.all && scope.orgIds.size > 0) {
      targetOrgId = [...scope.orgIds][0];
    } else {
      const root = db.prepare("SELECT id FROM org WHERE parent_id IS NULL AND status = 'active' ORDER BY id LIMIT 1").get() as
        | { id: number }
        | undefined;
      targetOrgId = root?.id;
    }
  }
  if (!targetOrgId || !orgInScope(scope, targetOrgId)) throw notVisible('组织');
  if (!db.prepare('SELECT 1 FROM org WHERE id = ?').get(targetOrgId)) throw notVisible('组织');
  const oaRef = input.oaRefNo.trim();
  if (!oaRef) throw Errors.validation('请填写 OA 报送流程单号或回执号');

  const now = nowIso();
  db.prepare(
    `INSERT INTO ct_monthly_report_log (
      org_id, report_month, submitted_at, oa_ref_no, receipt_attachment_id, submitted_by_user_id
    ) VALUES (?, ?, ?, ?, ?, ?)
    ON CONFLICT(org_id, report_month) DO UPDATE SET
      submitted_at = excluded.submitted_at,
      oa_ref_no = excluded.oa_ref_no,
      receipt_attachment_id = COALESCE(excluded.receipt_attachment_id, ct_monthly_report_log.receipt_attachment_id),
      submitted_by_user_id = excluded.submitted_by_user_id`,
  ).run(targetOrgId, input.reportMonth, now, oaRef, input.receiptAttachmentId ?? null, auth?.userId ?? null);

  writeLog(db, 'contract.monthly_report.submit', 'ct_monthly_report_log', targetOrgId, {
    orgId: targetOrgId,
    reportMonth: input.reportMonth,
    oaRefNo: oaRef,
  });
  return listMonthlyReportLogs(db, { orgId: targetOrgId, reportMonth: input.reportMonth })[0]!;
}
