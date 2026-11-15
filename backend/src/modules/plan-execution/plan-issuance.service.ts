/**
 * T-14 / GAP-06, GAP-07, GAP-08, GAP-10:
 * 年度综合计划与预算合一下达周期、8单元拆包与多级归并、含税/五项费用勾稽、分单位签收、
 * 6类调整与5类服务端派生审批机构、规范公文 <w:tbl> .docx 与全集团 .zip 打包导出。
 */
import crypto from 'node:crypto';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import type { DB } from '../../db/connection';
import { AppError, Errors } from '../../core/errors';
import {
  centsToDecimalString,
  centsToSafeNumber,
  formatScaled,
  parseDecimalToCents,
  parseScaled,
  roundHalfUpStep,
  roundHalfUpDiv,
  toCentsBig,
} from '../../core/decimal';
import { currentAuth } from '../../core/request-context';
import { todayUtcDate, workingDaysBetween } from '../../core/workdays';
import { writeLog } from '../audit/log';
import { renderDocx, type RenderDoc, type RenderSection } from '../analysis-reports/render';
import { workingCalendar } from '../settings/business-settings';
import { assertDistinctReviewer } from '../security/review';
import { parseInput } from '../../core/validate';
import { currentOrgScope, orgInScope, requireAllOrgs, type OrgScope } from '../security/scope';
import {
  PLAN_ADJUST_TYPE_LABELS,
  PLAN_APPROVAL_BODY_LABELS,
  PLAN_ISSUANCE_STAGE_LABELS,
  PLAN_SHEET_LABELS,
  PLAN_SHEETS,
  planIssuanceCycleCreateRequest,
  type PlanAdjustmentCreateRequest,
  type PlanAdjustmentDto,
  type PlanAdjustmentLineDto,
  type PlanAdjustmentReviewRequest,
  type PlanAdjustType,
  type PlanApprovalBody,
  type PlanAttachmentSummaryDto,
  type PlanIssuanceCycleCreateRequest,
  type PlanIssuanceCycleDto,
  type PlanPackAcknowledgeRequest,
  type PlanReconcileReportDto,
  type PlanReconcileRequest,
  type PlanSheetCode,
  type PlanTaxCheckItemDto,
  type PlanUnitPackDto,
  type PlanWarningDto,
} from '../../contracts/plan-execution';
import {
  DEFAULT_MAINTENANCE_VAT_BP,
  verifyMgmtFeeHierarchy,
  verifyVatMaintenanceReconcile,
  verifyWan2DecIssuedStep,
  WAN_2DEC_STEP_CENTS,
} from './plan-tax-reconcile';

const nowIso = () => new Date().toISOString();
const FIXED_ZIP_DATE = new Date('2000-01-01T00:00:00Z');
/** 公文金额：整数分 -> 两位小数万元，只按 10000 分步长舍入一次。 */
function issuedWanText(cents: bigint): string {
  return formatScaled(roundHalfUpStep(cents, WAN_2DEC_STEP_CENTS) / WAN_2DEC_STEP_CENTS, 2);
}

interface OrgMetaRow {
  id: number;
  parent_id: number | null;
  code: string;
  name: string;
  sort_order: number;
  status: string;
  org_kind: 'legal_entity' | 'hq_dept' | 'direct_unit' | 'closed_history';
  plan_issuance_root_id: number | null;
  is_plan_excluded: number;
  is_direct_station: number;
  report_full_name: string;
}

interface CycleRow {
  id: number;
  year: number;
  cycle_code: string;
  issuance_stage: PlanIssuanceCycleDto['issuanceStage'];
  source_plan_batch_id: number | null;
  source_budget_version_id: number | null;
  decision_doc_meta: string;
  frozen_snapshot_json: string;
  snapshot_sha256: string;
  status: PlanIssuanceCycleDto['status'];
  version: number;
  created_by_user_id: number | null;
  created_at: string;
  updated_at: string;
}

interface PackRow {
  id: number;
  cycle_id: number;
  unit_org_id: number;
  doc_no: string;
  issued_date: string | null;
  attachment_count: number;
  has_responsibility_letter: number;
  responsibility_letter_no: string;
  pack_summary_json: string;
  budget_version_id: number | null;
  sign_off_status: PlanUnitPackDto['signOffStatus'];
  ack_user_id: number | null;
  ack_at: string | null;
  ack_note: string;
  version: number;
  created_at: string;
  updated_at: string;
}

interface PlanItemDbRow {
  id: number;
  batch_id: number;
  sheet_code: PlanSheetCode;
  row_no: number;
  seq_no: string;
  item_name: string;
  item_type: string;
  path: string;
  project_id: number | null;
  org_id: number | null;
  undertake_org_id: number | null;
  item_key: string;
  stable_item_uid: string;
  parent_item_key: string;
  estimate_subitem: string;
  cost_nature: string;
  funding_channel: string;
  submitted_cents: bigint | number | null;
  exact_calc_cents: bigint | number | null;
  approved_cents: bigint | number | null;
  rounding_rule: string;
  diff_reason_code: string;
  warnings_json: string;
}

interface PackSummaryStored {
  metrics: PlanUnitPackDto['metrics'];
  attachments: PlanAttachmentSummaryDto[];
  undertakeItems: NonNullable<PlanUnitPackDto['undertakeItems']>;
  mergedChildOrgs: { id: number; code: string; name: string }[];
}

function loadAllOrgs(db: DB): OrgMetaRow[] {
  return db.prepare(`
    SELECT id, parent_id, code, name, sort_order, status, org_kind,
           plan_issuance_root_id, is_plan_excluded, is_direct_station, report_full_name
    FROM org
    ORDER BY sort_order, id
  `).all() as OrgMetaRow[];
}

/**
 * 按 org.plan_issuance_root_id 与组织层级解析归口下达单元 ID：
 * - is_plan_excluded = 1 或 closed_history/inactive 不归入下达单元包（返回 null，进入排除调节项）；
 * - hq_dept 自动并入集团根组织（公司总部）；
 * - 子孙主体沿 plan_issuance_root_id 或树父节点回溯至一级下达单元。
 */
export function resolveIssuanceUnitOrgId(
  orgId: number | null,
  orgById: Map<number, OrgMetaRow>,
  rootOrgId: number | null,
): number | null {
  if (orgId === null) return rootOrgId;
  const start = orgById.get(orgId);
  if (!start) return null;
  if (start.status !== 'active' || start.org_kind === 'closed_history' || start.is_plan_excluded === 1) {
    return null;
  }
  if (start.plan_issuance_root_id != null) {
    const explicitRoot = orgById.get(start.plan_issuance_root_id);
    if (explicitRoot && explicitRoot.status === 'active' && explicitRoot.is_plan_excluded === 0) {
      return explicitRoot.id;
    }
  }
  if (start.org_kind === 'hq_dept') return rootOrgId;
  if (rootOrgId !== null && start.id === rootOrgId) return rootOrgId;

  let cur: OrgMetaRow | undefined = start;
  const visited = new Set<number>();
  while (cur && !visited.has(cur.id)) {
    visited.add(cur.id);
    if (cur.plan_issuance_root_id != null) {
      const target = orgById.get(cur.plan_issuance_root_id);
      if (target && target.status === 'active' && target.is_plan_excluded === 0) return target.id;
    }
    if (cur.org_kind === 'hq_dept') return rootOrgId;
    if (rootOrgId !== null && cur.parent_id === rootOrgId) return cur.id;
    if (cur.parent_id === null) return cur.id;
    cur = orgById.get(cur.parent_id);
  }
  return start.id;
}

function listIssuanceTargetUnits(allOrgs: OrgMetaRow[], rootOrgId: number | null, itemOrgIds: Set<number>): OrgMetaRow[] {
  const orgById = new Map(allOrgs.map((o) => [o.id, o]));
  const unitIds = new Set<number>();
  for (const o of allOrgs) {
    if (o.status !== 'active' || o.org_kind === 'closed_history' || o.is_plan_excluded === 1) continue;
    if (o.org_kind === 'hq_dept') {
      if (rootOrgId !== null) unitIds.add(rootOrgId);
      continue;
    }
    const resolved = resolveIssuanceUnitOrgId(o.id, orgById, rootOrgId);
    if (resolved !== null) {
      if (resolved === rootOrgId) {
        const hasHqChildren = allOrgs.some((c) => c.status === 'active' && (c.org_kind === 'hq_dept' || c.plan_issuance_root_id === rootOrgId));
        const hasDirectItems = rootOrgId !== null && itemOrgIds.has(rootOrgId);
        const nonRootActive = allOrgs.filter((c) => c.status === 'active' && c.id !== rootOrgId && c.is_plan_excluded === 0);
        if (hasHqChildren || hasDirectItems || nonRootActive.length === 0) {
          unitIds.add(resolved);
        }
      } else {
        unitIds.add(resolved);
      }
    }
  }
  return allOrgs.filter((o) => unitIds.has(o.id));
}

function loadBatchItemsAndAnnualPlan(db: DB, batchId: number | null): {
  items: PlanItemDbRow[];
  annualCentsByItem: Map<number, bigint>;
  warnings: PlanWarningDto[];
} {
  if (batchId === null) return { items: [], annualCentsByItem: new Map(), warnings: [] };
  const items = db.prepare(`
    SELECT id, batch_id, sheet_code, row_no, seq_no, item_name, item_type, path, project_id,
           org_id, undertake_org_id, item_key, stable_item_uid, cost_nature, funding_channel,
           submitted_cents, exact_calc_cents, approved_cents, rounding_rule, diff_reason_code, warnings_json
    FROM plan_item
    WHERE batch_id = ?
    ORDER BY sheet_code, row_no, id
  `).safeIntegers(true).all(batchId) as unknown as PlanItemDbRow[];

  const facts = db.prepare(`
    SELECT f.item_id, f.field_key, f.measure, f.value_type, f.amount_cents
    FROM plan_fact f
    JOIN plan_item i ON i.id = f.item_id
    WHERE i.batch_id = ? AND f.value_type = 'amount' AND f.amount_cents IS NOT NULL
  `).safeIntegers(true).all(batchId) as unknown as {
    item_id: number;
    field_key: string;
    measure: string;
    value_type: string;
    amount_cents: bigint | number;
  }[];

  const annualCentsByItem = new Map<number, bigint>();
  for (const it of items) {
    const idNum = Number(it.id);
    if (it.approved_cents !== null && it.approved_cents !== undefined) {
      annualCentsByItem.set(idNum, toCentsBig(it.approved_cents));
    } else if (it.exact_calc_cents !== null && it.exact_calc_cents !== undefined) {
      annualCentsByItem.set(idNum, toCentsBig(it.exact_calc_cents));
    }
  }
  for (const f of facts) {
    const idNum = Number(f.item_id);
    if (!annualCentsByItem.has(idNum) && (f.field_key === 'annual_plan' || f.measure === 'annual_plan')) {
      annualCentsByItem.set(idNum, toCentsBig(f.amount_cents));
    }
  }

  const warnings: PlanWarningDto[] = [];
  for (const it of items) {
    try {
      const parsed = JSON.parse(it.warnings_json || '[]') as PlanWarningDto[];
      for (const w of parsed) warnings.push(w);
    } catch {
      // ignore malformed warning json
    }
  }
  return { items, annualCentsByItem, warnings };
}

function isLeafDetailRow(it: PlanItemDbRow): boolean {
  return it.item_type === 'detail' || it.item_type === 'leaf';
}

function centsFromMetaOverride(val: unknown): bigint | null {
  if (val === null || val === undefined || val === '') return null;
  if (typeof val === 'bigint') return val;
  if (typeof val === 'string' || typeof val === 'number') {
    try {
      return parseDecimalToCents(val, { rounding: 'half-up' });
    } catch {
      return null;
    }
  }
  return null;
}

function buildPackSummaries(
  db: DB,
  unitOrgs: OrgMetaRow[],
  allOrgs: OrgMetaRow[],
  rootOrgId: number | null,
  planBatchId: number | null,
  budgetVersionId: number | null,
  decisionMeta: Record<string, unknown>,
): Map<number, PackSummaryStored> {
  const orgById = new Map(allOrgs.map((o) => [o.id, o]));
  const { items, annualCentsByItem } = loadBatchItemsAndAnnualPlan(db, planBatchId);
  const annualFacts = new Map((planBatchId === null ? [] : db.prepare(`
    SELECT item_id, value_type, scaled_value, text_value FROM plan_fact WHERE batch_id = ? AND field_key = 'annual_plan'
  `).safeIntegers(true).all(planBatchId) as { item_id: bigint; value_type: string; scaled_value: bigint | null; text_value: string | null }[])
    .map((fact) => [Number(fact.item_id), fact]));

  const budgetEntries = budgetVersionId !== null
    ? (db.prepare(`
        SELECT e.org_id, e.amount_cents, a.code AS account_code, a.name AS account_name, a.type AS account_type
        FROM budget_entry e
        JOIN account a ON a.id = e.account_id
        WHERE e.version_id = ?
      `).safeIntegers(true).all(budgetVersionId) as unknown as {
        org_id: number;
        amount_cents: bigint | number;
        account_code: string;
        account_name: string;
        account_type: string;
      }[])
    : [];

  const unitOverrides = (decisionMeta.unitMetrics as Record<string, Record<string, unknown>> | undefined) ?? {};
  const attachmentOverrides = (decisionMeta.unitAttachments as Record<string, PlanAttachmentSummaryDto[]> | undefined) ?? {};
  const out = new Map<number, PackSummaryStored>();

  for (const u of unitOrgs) {
    const mergedChildren = allOrgs
      .filter((o) => o.id !== u.id && o.status === 'active' && o.is_plan_excluded === 0 && resolveIssuanceUnitOrgId(o.id, orgById, rootOrgId) === u.id)
      .map((o) => ({ id: o.id, code: o.code, name: o.name }));
    const coveredOrgIds = new Set<number>([u.id, ...mergedChildren.map((c) => c.id)]);

    const unitLeafItems = items.filter((it) => {
      if (!isLeafDetailRow(it)) return false;
      const resolvedUnit = resolveIssuanceUnitOrgId(it.org_id !== null ? Number(it.org_id) : null, orgById, rootOrgId);
      return resolvedUnit === u.id;
    });

    const hasSeparatePurchaseSheet = unitLeafItems.some((it) => it.sheet_code === 'purchase');
    let investmentCents = 0n;
    let purchaseCents = 0n;
    let maintenanceCents = 0n;
    let safetyInputCents = 0n;
    let fiveExpensesExactCents = 0n;
    let mgmtControllableOtherCents = 0n;
    let operatingRevenueCents = 0n;
    let nonOperatingRevenueCents = 0n;
    let profitBeforeTaxCents = 0n;
    let netProfitCents = 0n;

    const bySheet = new Map<PlanSheetCode, PlanItemDbRow[]>();
    for (const it of unitLeafItems) {
      const idNum = Number(it.id);
      const amt = annualCentsByItem.get(idNum) ?? 0n;
      const list = bySheet.get(it.sheet_code) ?? [];
      list.push(it);
      bySheet.set(it.sheet_code, list);

      if (
        it.sheet_code === 'investment' ||
        it.sheet_code === 'investment_tech_renovation' ||
        it.sheet_code === 'investment_info' ||
        it.sheet_code === 'investment_other'
      ) {
        if (hasSeparatePurchaseSheet && (it.item_type === 'cross_ref_summary' || /固定资产购置/.test(it.item_name))) {
          continue;
        }
        investmentCents += amt;
      } else if (it.sheet_code === 'purchase') {
        purchaseCents += amt;
        investmentCents += amt;
      } else if (it.sheet_code === 'maintenance') {
        maintenanceCents += amt;
      } else if (it.sheet_code === 'safety_input') {
        safetyInputCents += amt;
      } else if (it.sheet_code === 'five_expenses') {
        fiveExpensesExactCents += amt;
      } else if (it.sheet_code === 'mgmt_fee' || it.sheet_code === 'mfg_fee') {
        if (/可控其他|其他可控/.test(it.item_name)) mgmtControllableOtherCents += amt;
      } else if (it.sheet_code === 'profit_budget') {
        if (/^营业总收入$|^一[、.\s]*营业总收入|^营业收入$/.test(it.item_name.trim())) operatingRevenueCents += amt;
        else if (/营业外收入/.test(it.item_name)) nonOperatingRevenueCents += amt;
        else if (/利润总额/.test(it.item_name)) profitBeforeTaxCents += amt;
        else if (/净利润/.test(it.item_name)) netProfitCents += amt;
      }
    }

    if (operatingRevenueCents === 0n && profitBeforeTaxCents === 0n && budgetEntries.length > 0) {
      let bIncome = 0n;
      let bCostExp = 0n;
      for (const be of budgetEntries) {
        if (!coveredOrgIds.has(Number(be.org_id))) continue;
        const v = toCentsBig(be.amount_cents);
        if (be.account_type === 'income') bIncome += v;
        else if (be.account_type === 'cost' || be.account_type === 'expense') bCostExp += v;
      }
      operatingRevenueCents = bIncome;
      profitBeforeTaxCents = bIncome - bCostExp;
      netProfitCents = profitBeforeTaxCents;
    }

    const ov = unitOverrides[u.code] ?? unitOverrides[String(u.id)] ?? {};
    operatingRevenueCents = centsFromMetaOverride(ov.operatingRevenue) ?? operatingRevenueCents;
    const totalRevenueCents = centsFromMetaOverride(ov.totalRevenue) ?? (operatingRevenueCents + nonOperatingRevenueCents);
    profitBeforeTaxCents = centsFromMetaOverride(ov.profitBeforeTax) ?? profitBeforeTaxCents;
    netProfitCents = centsFromMetaOverride(ov.netProfit) ?? netProfitCents;
    investmentCents = centsFromMetaOverride(ov.investmentTotal) ?? investmentCents;
    purchaseCents = centsFromMetaOverride(ov.purchaseTotal) ?? purchaseCents;
    maintenanceCents = centsFromMetaOverride(ov.maintenanceTotal) ?? maintenanceCents;
    safetyInputCents = centsFromMetaOverride(ov.safetyInputTotal) ?? safetyInputCents;
    fiveExpensesExactCents = centsFromMetaOverride(ov.fiveExpensesExact) ?? fiveExpensesExactCents;
    const fiveExpensesIssuedCents = centsFromMetaOverride(ov.fiveExpensesIssued)
      ?? roundHalfUpStep(fiveExpensesExactCents, WAN_2DEC_STEP_CENTS);
    const controllableExactCents = centsFromMetaOverride(ov.controllableMgmtFeeExact)
      ?? (fiveExpensesExactCents + mgmtControllableOtherCents);
    const controllableIssuedCents = centsFromMetaOverride(ov.controllableMgmtFeeIssued)
      ?? roundHalfUpStep(controllableExactCents, WAN_2DEC_STEP_CENTS);

    const customAttachments = attachmentOverrides[u.code] ?? attachmentOverrides[String(u.id)];
    const attachments: PlanAttachmentSummaryDto[] = customAttachments
      ? customAttachments
      : [...bySheet.entries()].map(([sheetCode, rows], idx) => {
          let exactSum = 0n;
          const subSet = new Set<string>();
          const undertakeSet = new Set<string>();
          const tableRows = rows.map((r, rIdx) => {
            const idNum = Number(r.id);
            const amt = annualCentsByItem.get(idNum) ?? 0n;
            const fact = annualFacts.get(idNum);
            const isAmount = !fact || fact.value_type === 'amount';
            exactSum += amt;
            const rowOrg = r.org_id !== null ? orgById.get(Number(r.org_id)) : undefined;
            const undOrg = r.undertake_org_id !== null ? orgById.get(Number(r.undertake_org_id)) : undefined;
            if (rowOrg && rowOrg.id !== u.id) subSet.add(rowOrg.name);
            if (undOrg && undOrg.id !== u.id) undertakeSet.add(undOrg.name);
            return {
              seqNo: r.seq_no || String(rIdx + 1),
              itemName: r.item_name,
              unit: isAmount ? '万元' : fact.value_type === 'quantity' ? '数量（原表口径）' : fact.value_type === 'ratio' ? '比率' : '文本',
              amountOrValue: isAmount ? issuedWanText(amt) : fact.value_type === 'text' ? fact.text_value ?? '' : formatScaled(fact.scaled_value ?? 0n, fact.value_type === 'quantity' ? 4 : 6, false),
              undertakeOrgName: undOrg?.name ?? rowOrg?.name ?? null,
              note: r.cost_nature || '',
            };
          });
          const issuedSum = sheetCode === 'five_expenses' ? fiveExpensesIssuedCents : exactSum;
          return {
            attachmentNo: idx + 1,
            title: `${u.name}${PLAN_SHEET_LABELS[sheetCode]}`,
            sheetCode,
            unitOfMeasure: tableRows.every((r) => r.unit === '万元') ? '万元' : '按行量纲',
            leafRowCount: rows.length,
            exactTotalAmount: centsToDecimalString(exactSum),
            issuedTotalAmount: centsToDecimalString(issuedSum),
            diffReasonCode: issuedSum === exactSum ? '' : 'DISPLAY_WAN_2DEC_HALF_UP',
            subEntities: [...subSet],
            undertakeDepts: [...undertakeSet],
            rows: tableRows,
          };
        });

    const undertakeItems: NonNullable<PlanUnitPackDto['undertakeItems']> = [];
    for (const it of items) {
      if (!isLeafDetailRow(it)) continue;
      const idNum = Number(it.id);
      const ownerUnitId = resolveIssuanceUnitOrgId(it.org_id !== null ? Number(it.org_id) : null, orgById, rootOrgId);
      const actualUndertakeId = it.undertake_org_id !== null ? Number(it.undertake_org_id) : (it.org_id !== null ? Number(it.org_id) : null);
      if (ownerUnitId === null || actualUndertakeId === null) continue;
      const undertakeUnitRoot = resolveIssuanceUnitOrgId(actualUndertakeId, orgById, rootOrgId);
      const involvesThisPack = ownerUnitId === u.id || coveredOrgIds.has(actualUndertakeId) || undertakeUnitRoot === u.id;
      if (!involvesThisPack) continue;
      const ownerOrg = orgById.get(ownerUnitId);
      const undOrg = orgById.get(actualUndertakeId);
      if (!ownerOrg || !undOrg) continue;
      undertakeItems.push({
        itemId: idNum,
        sheetCode: it.sheet_code,
        itemName: it.item_name,
        ownerUnitOrgId: ownerUnitId,
        ownerUnitOrgName: ownerOrg.name,
        undertakeOrgId: actualUndertakeId,
        undertakeOrgName: undOrg.name,
        approvedAmount: centsToDecimalString(annualCentsByItem.get(idNum) ?? 0n),
      });
    }

    out.set(u.id, {
      mergedChildOrgs: mergedChildren,
      metrics: {
        operatingRevenue: centsToDecimalString(operatingRevenueCents),
        totalRevenue: centsToDecimalString(totalRevenueCents),
        profitBeforeTax: centsToDecimalString(profitBeforeTaxCents),
        netProfit: centsToDecimalString(netProfitCents),
        investmentTotal: centsToDecimalString(investmentCents),
        purchaseTotal: centsToDecimalString(purchaseCents),
        maintenanceTotal: centsToDecimalString(maintenanceCents),
        safetyInputTotal: centsToDecimalString(safetyInputCents),
        fiveExpensesExact: centsToDecimalString(fiveExpensesExactCents),
        fiveExpensesIssued: centsToDecimalString(fiveExpensesIssuedCents),
        controllableMgmtFeeExact: centsToDecimalString(controllableExactCents),
        controllableMgmtFeeIssued: centsToDecimalString(controllableIssuedCents),
      },
      attachments,
      undertakeItems,
    });
  }
  return out;
}

function packRowToDto(db: DB, p: PackRow, orgById: Map<number, OrgMetaRow>, includeDetails: boolean): PlanUnitPackDto {
  const uOrg = orgById.get(p.unit_org_id);
  const summary = JSON.parse(p.pack_summary_json || '{}') as Partial<PackSummaryStored>;
  const ackUser = p.ack_user_id
    ? (db.prepare('SELECT display_name, username FROM app_user WHERE id = ?').get(p.ack_user_id) as { display_name: string; username: string } | undefined)
    : undefined;
  const defaultMetrics: PlanUnitPackDto['metrics'] = {
    operatingRevenue: '0.00',
    totalRevenue: '0.00',
    profitBeforeTax: '0.00',
    netProfit: '0.00',
    investmentTotal: '0.00',
    purchaseTotal: '0.00',
    maintenanceTotal: '0.00',
    safetyInputTotal: '0.00',
    fiveExpensesExact: '0.00',
    fiveExpensesIssued: '0.00',
    controllableMgmtFeeExact: '0.00',
    controllableMgmtFeeIssued: '0.00',
  };
  return {
    id: p.id,
    cycleId: p.cycle_id,
    unitOrgId: p.unit_org_id,
    unitOrgCode: uOrg?.code ?? '',
    unitOrgName: uOrg?.name ?? `#${p.unit_org_id}`,
    docNo: p.doc_no,
    issuedDate: p.issued_date,
    attachmentCount: p.attachment_count,
    hasResponsibilityLetter: p.has_responsibility_letter === 1,
    responsibilityLetterNo: p.responsibility_letter_no,
    budgetVersionId: p.budget_version_id,
    signOffStatus: p.sign_off_status,
    ackUserId: p.ack_user_id,
    ackUserName: ackUser ? (ackUser.display_name || ackUser.username) : null,
    ackAt: p.ack_at,
    ackNote: p.ack_note,
    version: p.version,
    mergedChildOrgs: summary.mergedChildOrgs ?? [],
    metrics: summary.metrics ?? defaultMetrics,
    ...(includeDetails
      ? {
          attachments: summary.attachments ?? [],
          undertakeItems: summary.undertakeItems ?? [],
        }
      : {}),
    createdAt: p.created_at,
    updatedAt: p.updated_at,
  };
}

function getCycleRowOrThrow(db: DB, cycleId: number): CycleRow {
  const row = db.prepare('SELECT * FROM plan_issuance_cycle WHERE id = ?').get(cycleId) as CycleRow | undefined;
  if (!row) throw Errors.notFound('综合计划下达周期不存在');
  return row;
}

export function createIssuanceCycle(db: DB, input: PlanIssuanceCycleCreateRequest): PlanIssuanceCycleDto {
  const auth = currentAuth();
  if (auth) requireAllOrgs(auth, '创建综合计划与预算合一下达周期');

  const existing = db.prepare('SELECT id FROM plan_issuance_cycle WHERE cycle_code = ?').get(input.cycleCode) as { id: number } | undefined;
  if (existing) throw new AppError('CYCLE_CODE_EXISTS', `周期编码 ${input.cycleCode} 已存在`, 409);

  let sourceBatchId = input.sourcePlanBatchId ?? null;
  if (sourceBatchId !== null) {
    const b = db.prepare('SELECT id, year, status FROM plan_batch WHERE id = ?').get(sourceBatchId) as { id: number; year: number; status: string } | undefined;
    if (!b || b.status === 'voided') throw Errors.validation('关联的综合计划批次不存在或已作废');
    if (b.year !== input.year) throw Errors.validation(`综合计划批次年度（${b.year}）与下达周期年度（${input.year}）不一致`);
  } else {
    const cur = db.prepare(`SELECT id FROM plan_batch WHERE year = ? AND status = 'imported' ORDER BY is_current DESC, id DESC LIMIT 1`).get(input.year) as { id: number } | undefined;
    sourceBatchId = cur?.id ?? null;
  }

  let sourceBudgetId = input.sourceBudgetVersionId ?? null;
  if (sourceBudgetId !== null) {
    const bv = db.prepare('SELECT id, year FROM budget_version WHERE id = ?').get(sourceBudgetId) as { id: number; year: number } | undefined;
    if (!bv) throw Errors.validation('关联的经营预算版本不存在');
    if (bv.year !== input.year) throw Errors.validation(`经营预算版本年度（${bv.year}）与下达周期年度（${input.year}）不一致`);
  } else {
    const curBv = db.prepare(`SELECT id FROM budget_version WHERE year = ? AND kind = 'budget' AND status != 'archived' ORDER BY is_current DESC, id DESC LIMIT 1`).get(input.year) as { id: number } | undefined;
    sourceBudgetId = curBv?.id ?? null;
  }

  const allOrgs = loadAllOrgs(db);
  const rootOrg = allOrgs.find((o) => o.parent_id === null && o.status === 'active') ?? allOrgs.find((o) => o.status === 'active') ?? null;
  if (!rootOrg) throw Errors.validation('尚未初始化组织树，无法拆包下达');

  const itemOrgRows = sourceBatchId !== null
    ? (db.prepare('SELECT DISTINCT org_id FROM plan_item WHERE batch_id = ? AND org_id IS NOT NULL').all(sourceBatchId) as { org_id: number }[])
    : [];
  const itemOrgIds = new Set(itemOrgRows.map((r) => r.org_id));
  const unitOrgs = listIssuanceTargetUnits(allOrgs, rootOrg.id, itemOrgIds);
  if (unitOrgs.length === 0) throw Errors.validation('没有符合下达条件的有效一级单元');

  const decisionMeta = { ...(input.decisionDocMeta ?? {}) };
  if (input.annualSpecialCaps) decisionMeta.annualSpecialCaps = input.annualSpecialCaps;
  if (decisionMeta.annualSpecialCaps !== undefined) {
    decisionMeta.annualSpecialCaps = parseInput(planIssuanceCycleCreateRequest.shape.annualSpecialCaps, decisionMeta.annualSpecialCaps) ?? [];
    const keys = new Set<string>();
    for (const raw of decisionMeta.annualSpecialCaps as NonNullable<PlanIssuanceCycleCreateRequest['annualSpecialCaps']>) {
      const cap = raw as { unitOrgId: number; sheetCode: PlanSheetCode; amount: string };
      if (!unitOrgs.some((o) => o.id === cap.unitOrgId) || !PLAN_SHEETS.includes(cap.sheetCode) || typeof cap.amount !== 'string' || parseDecimalToCents(cap.amount) < 0n) throw Errors.validation('年度专项上限的单位、工作表或金额无效');
      const key = `${cap.unitOrgId}:${cap.sheetCode}`;
      if (keys.has(key)) throw Errors.validation('同一单位工作表不能重复配置年度专项上限');
      keys.add(key);
    }
  }
  if (decisionMeta.unitAttachments !== undefined) {
    const allowed = new Set(unitOrgs.flatMap((o) => [o.code,String(o.id)]));
    if (typeof decisionMeta.unitAttachments !== 'object' || decisionMeta.unitAttachments === null || Array.isArray(decisionMeta.unitAttachments) ||
        Object.keys(decisionMeta.unitAttachments).some((key) => !allowed.has(key))) throw Errors.validation('正式附表单位映射不属于本周期下达单元，请核对单位编码或ID');
  }
  const packSummaries = buildPackSummaries(db, unitOrgs, allOrgs, rootOrg.id, sourceBatchId, sourceBudgetId, decisionMeta);
  const now = nowIso();
  const prefix = (input.docNoPrefix || '综计发').trim();

  const cycleId = db.transaction(() => {
    const res = db.prepare(`
      INSERT INTO plan_issuance_cycle (
        year, cycle_code, issuance_stage, source_plan_batch_id, source_budget_version_id,
        decision_doc_meta, frozen_snapshot_json, snapshot_sha256, status, version,
        created_by_user_id, created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, '{}', '', 'draft', 1, ?, ?, ?)
    `).run(
      input.year,
      input.cycleCode,
      input.issuanceStage,
      sourceBatchId,
      sourceBudgetId,
      JSON.stringify(decisionMeta),
      auth?.userId ?? null,
      now,
      now,
    );
    const cid = Number(res.lastInsertRowid);

    let letterSeq = 0;
    unitOrgs.forEach((u, idx) => {
      const summary = packSummaries.get(u.id)!;
      const isGroupHq = u.id === rootOrg.id && unitOrgs.length > 1;
      const hasLetter = isGroupHq ? 0 : 1;
      if (hasLetter) letterSeq++;
      const docNo = `${prefix}〔${input.year}〕${idx + 1}号`;
      const letterNo = hasLetter ? `目责字〔${input.year}〕${String(letterSeq).padStart(2, '0')}号` : '';
      db.prepare(`
        INSERT INTO plan_issuance_unit_pack (
          cycle_id, unit_org_id, doc_no, issued_date, attachment_count,
          has_responsibility_letter, responsibility_letter_no, pack_summary_json,
          budget_version_id, sign_off_status, ack_note, version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'draft', '', 1, ?, ?)
      `).run(
        cid,
        u.id,
        docNo,
        input.issuedDate ?? null,
        summary.attachments.length,
        hasLetter,
        letterNo,
        JSON.stringify(summary),
        sourceBudgetId,
        now,
        now,
      );
    });

    writeLog(db, 'plan.issuance.create_cycle', 'plan_issuance_cycle', cid, {
      year: input.year,
      cycleCode: input.cycleCode,
      unitPackCount: unitOrgs.length,
    });
    return cid;
  }).immediate();

  return getIssuanceCycle(db, cycleId);
}

export function listIssuanceCycles(db: DB, q: { year?: number; status?: string } = {}): PlanIssuanceCycleDto[] {
  const scope = currentOrgScope(db);
  const where: string[] = ['1 = 1'];
  const params: unknown[] = [];
  if (q.year !== undefined) { where.push('year = ?'); params.push(q.year); }
  if (q.status) { where.push('status = ?'); params.push(q.status); }
  const rows = db.prepare(`SELECT * FROM plan_issuance_cycle WHERE ${where.join(' AND ')} ORDER BY year DESC, id DESC`).all(...params) as CycleRow[];
  const allOrgs = loadAllOrgs(db);
  const excludedOrgs = allOrgs.filter((o) => o.is_plan_excluded === 1).map((o) => ({ id: o.id, code: o.code, name: o.name }));

  return rows
    .filter((c) => {
      if (scope.all) return true;
      if (c.status === 'draft') return false;
      const packs = db.prepare('SELECT unit_org_id FROM plan_issuance_unit_pack WHERE cycle_id = ?').all(c.id) as { unit_org_id: number }[];
      return packs.some((p) => orgInScope(scope, p.unit_org_id));
    })
    .map((c) => {
      const visiblePacks = (db.prepare('SELECT unit_org_id, sign_off_status FROM plan_issuance_unit_pack WHERE cycle_id = ?')
        .all(c.id) as { unit_org_id: number; sign_off_status: string }[])
        .filter((p) => orgInScope(scope, p.unit_org_id));
      return {
        id: c.id,
        year: c.year,
        cycleCode: c.cycle_code,
        issuanceStage: c.issuance_stage,
        sourcePlanBatchId: c.source_plan_batch_id,
        sourceBudgetVersionId: c.source_budget_version_id,
        decisionDocMeta: scope.all ? JSON.parse(c.decision_doc_meta || '{}') as Record<string, unknown> : {},
        frozenSnapshot: scope.all ? JSON.parse(c.frozen_snapshot_json || '{}') as Record<string, unknown> : {},
        snapshotSha256: c.snapshot_sha256,
        status: c.status,
        version: c.version,
        unitPackCount: visiblePacks.length,
        acknowledgedCount: visiblePacks.filter((p) => p.sign_off_status === 'acknowledged').length,
        excludedOrgs: scope.all ? excludedOrgs : [],
        createdByUserId: c.created_by_user_id,
        createdAt: c.created_at,
        updatedAt: c.updated_at,
      };
    });
}

export function getIssuanceCycle(db: DB, cycleId: number): PlanIssuanceCycleDto {
  const scope = currentOrgScope(db);
  const c = getCycleRowOrThrow(db, cycleId);
  if (!scope.all && c.status === 'draft') throw Errors.notFound('综合计划下达周期不存在');
  const allOrgs = loadAllOrgs(db);
  const orgById = new Map(allOrgs.map((o) => [o.id, o]));
  const rawPacks = db.prepare('SELECT * FROM plan_issuance_unit_pack WHERE cycle_id = ? ORDER BY id').all(c.id) as PackRow[];
  const visiblePacks = scope.all ? rawPacks : rawPacks.filter((p) => orgInScope(scope, p.unit_org_id));
  if (!scope.all && visiblePacks.length === 0) throw Errors.notFound('综合计划下达周期不存在');

  const excludedOrgs = allOrgs.filter((o) => o.is_plan_excluded === 1).map((o) => ({ id: o.id, code: o.code, name: o.name }));
  return {
    id: c.id,
    year: c.year,
    cycleCode: c.cycle_code,
    issuanceStage: c.issuance_stage,
    sourcePlanBatchId: c.source_plan_batch_id,
    sourceBudgetVersionId: c.source_budget_version_id,
    decisionDocMeta: scope.all ? JSON.parse(c.decision_doc_meta || '{}') as Record<string, unknown> : {},
    frozenSnapshot: scope.all ? (JSON.parse(c.frozen_snapshot_json || '{}') as Record<string, unknown>) : {},
    snapshotSha256: c.snapshot_sha256,
    status: c.status,
    version: c.version,
    unitPackCount: visiblePacks.length,
    acknowledgedCount: visiblePacks.filter((p) => p.sign_off_status === 'acknowledged').length,
    excludedOrgs: scope.all ? excludedOrgs : [],
    packs: visiblePacks.map((p) => packRowToDto(db, p, orgById, false)),
    reconcileReport: scope.all ? reconcileCycleTotals(db, c.id) : null,
    createdByUserId: c.created_by_user_id,
    createdAt: c.created_at,
    updatedAt: c.updated_at,
  };
}

export function reconcileCycleTotals(
  db: DB,
  cycleId: number,
  req: PlanReconcileRequest = {},
): PlanReconcileReportDto {
  const auth = currentAuth();
  if (auth) requireAllOrgs(auth, '核对集团综合计划下达总额');
  const c = getCycleRowOrThrow(db, cycleId);
  const meta = JSON.parse(c.decision_doc_meta || '{}') as Record<string, unknown>;
  const mode: 'strict_compile' | 'legacy_reconcile' = req.mode
    ?? (meta.reconcileMode === 'legacy_reconcile' ? 'legacy_reconcile' : 'strict_compile');
  const vatRateBp = req.vatRateBp ?? (typeof meta.vatRateBp === 'number' ? meta.vatRateBp : DEFAULT_MAINTENANCE_VAT_BP);

  const allOrgs = loadAllOrgs(db);
  const orgById = new Map(allOrgs.map((o) => [o.id, o]));
  const packs = db.prepare('SELECT * FROM plan_issuance_unit_pack WHERE cycle_id = ? ORDER BY id').all(c.id) as PackRow[];
  const packDtos = packs.map((p) => packRowToDto(db, p, orgById, false));

  let sum8Rev = 0n;
  let sum8Profit = 0n;
  let sumInvest = 0n;
  let sumSafety = 0n;
  let sumFiveExact = 0n;
  let sumFiveIssued = 0n;
  const checks: PlanTaxCheckItemDto[] = [];

  for (const p of packDtos) {
    sum8Rev += parseDecimalToCents(p.metrics.operatingRevenue);
    sum8Profit += parseDecimalToCents(p.metrics.profitBeforeTax);
    sumInvest += parseDecimalToCents(p.metrics.investmentTotal);
    sumSafety += parseDecimalToCents(p.metrics.safetyInputTotal);
    const feExact = parseDecimalToCents(p.metrics.fiveExpensesExact);
    const feIssued = parseDecimalToCents(p.metrics.fiveExpensesIssued);
    sumFiveExact += feExact;
    sumFiveIssued += feIssued;

    if (feExact > 0n || feIssued > 0n) {
      checks.push(verifyWan2DecIssuedStep({
        unitOrgId: p.unitOrgId,
        unitName: p.unitOrgName,
        metricLabel: '五项费用',
        exactCalcCents: feExact,
        approvedIssuedCents: feIssued,
        kind: 'controllable_mgmt_step',
      }));
    }
    if (p.hasResponsibilityLetter) {
      const ctrlExact = parseDecimalToCents(p.metrics.controllableMgmtFeeExact);
      const ctrlIssued = parseDecimalToCents(p.metrics.controllableMgmtFeeIssued);
      if (ctrlExact > 0n || ctrlIssued > 0n) {
        checks.push(verifyWan2DecIssuedStep({
          unitOrgId: p.unitOrgId,
          unitName: p.unitOrgName,
          metricLabel: '目标责任书可控管理费(R19+R20)',
          exactCalcCents: ctrlExact,
          approvedIssuedCents: ctrlIssued,
          kind: 'controllable_mgmt_step',
        }));
      }
    }
  }

  const excludedMeta = (meta.excludedOrgMetrics as Record<string, { operatingRevenue?: string; profitBeforeTax?: string }> | undefined) ?? {};
  const { items, annualCentsByItem, warnings: batchWarnings } = loadBatchItemsAndAnnualPlan(db, c.source_plan_batch_id);
  let excludedRev = 0n;
  let excludedProfit = 0n;
  const excludedList: PlanReconcileReportDto['consolidation']['excludedOrgs'] = [];

  for (const eo of allOrgs.filter((o) => o.is_plan_excluded === 1)) {
    let eoRev = 0n;
    let eoProfit = 0n;
    for (const it of items) {
      if (!isLeafDetailRow(it) || Number(it.org_id) !== eo.id) continue;
      const amt = annualCentsByItem.get(Number(it.id)) ?? 0n;
      if (it.sheet_code === 'profit_budget') {
        if (/^营业总收入$|^一[、.\s]*营业总收入|^营业收入$/.test(it.item_name.trim())) eoRev += amt;
        else if (/利润总额/.test(it.item_name)) eoProfit += amt;
      }
    }
    if (eoRev === 0n && eoProfit === 0n && c.source_budget_version_id !== null) {
      const bRows = db.prepare(`
        SELECT e.amount_cents, a.type AS account_type
        FROM budget_entry e JOIN account a ON a.id = e.account_id
        WHERE e.version_id = ? AND e.org_id = ?
      `).safeIntegers(true).all(c.source_budget_version_id, eo.id) as unknown as { amount_cents: bigint | number; account_type: string }[];
      let inc = 0n;
      let cost = 0n;
      for (const r of bRows) {
        if (r.account_type === 'income') inc += toCentsBig(r.amount_cents);
        else if (r.account_type === 'cost' || r.account_type === 'expense') cost += toCentsBig(r.amount_cents);
      }
      eoRev = inc;
      eoProfit = inc - cost;
    }
    const em = excludedMeta[eo.code] ?? excludedMeta[String(eo.id)];
    if (em?.operatingRevenue !== undefined) eoRev = parseDecimalToCents(em.operatingRevenue);
    if (em?.profitBeforeTax !== undefined) eoProfit = parseDecimalToCents(em.profitBeforeTax);
    excludedRev += eoRev;
    excludedProfit += eoProfit;
    excludedList.push({
      orgId: eo.id,
      orgCode: eo.code,
      orgName: eo.name,
      operatingRevenue: centsToDecimalString(eoRev),
      profitBeforeTax: centsToDecimalString(eoProfit),
    });
  }

  const expectedGroupRev = sum8Rev + excludedRev;
  const groupConsolidatedRev = req.groupConsolidatedOperatingRevenue !== undefined
    ? parseDecimalToCents(req.groupConsolidatedOperatingRevenue)
    : centsFromMetaOverride(meta.groupConsolidatedOperatingRevenue) ?? expectedGroupRev;
  const revDiff = groupConsolidatedRev - expectedGroupRev;
  const absRevDiff = revDiff < 0n ? -revDiff : revDiff;
  const revPassed = absRevDiff <= 1n;
  checks.push({
    unitOrgId: null,
    unitName: '集团合并总表',
    kind: 'consolidation_balance',
    passed: revPassed,
    blocking: !revPassed,
    planInclusiveAmount: null,
    expectedBudgetExclAmount: centsToDecimalString(expectedGroupRev),
    actualBudgetExclAmount: centsToDecimalString(groupConsolidatedRev),
    diffAmount: centsToDecimalString(revDiff),
    reasonCode: revPassed ? (revDiff === 0n ? 'EXACT_MATCH' : 'SUB_CENT_ROUND_1C') : 'CONSOLIDATION_REVENUE_MISMATCH',
    message: revPassed
      ? `营业总收入合并核对通过：下达单元合计 ${centsToDecimalString(sum8Rev)}元 + 排除单发主体 ${centsToDecimalString(excludedRev)}元 vs 合并总表 ${centsToDecimalString(groupConsolidatedRev)}元（差额 ${centsToDecimalString(revDiff)}元）`
      : `营业总收入合并失衡：下达单元合计 + 排除主体 = ${centsToDecimalString(expectedGroupRev)}元，与合并总表 ${centsToDecimalString(groupConsolidatedRev)}元相差 ${centsToDecimalString(revDiff)}元`,
  });

  const expectedGroupProfit = sum8Profit + excludedProfit;
  const groupConsolidatedProfit = req.groupConsolidatedProfitBeforeTax !== undefined
    ? parseDecimalToCents(req.groupConsolidatedProfitBeforeTax)
    : centsFromMetaOverride(meta.groupConsolidatedProfitBeforeTax) ?? expectedGroupProfit;
  const profitDiff = groupConsolidatedProfit - expectedGroupProfit;
  const profitPassed = profitDiff === 0n;
  checks.push({
    unitOrgId: null,
    unitName: '集团合并总表',
    kind: 'consolidation_balance',
    passed: profitPassed,
    blocking: !profitPassed,
    planInclusiveAmount: null,
    expectedBudgetExclAmount: centsToDecimalString(expectedGroupProfit),
    actualBudgetExclAmount: centsToDecimalString(groupConsolidatedProfit),
    diffAmount: centsToDecimalString(profitDiff),
    reasonCode: profitPassed ? 'EXACT_MATCH' : 'CONSOLIDATION_PROFIT_MISMATCH',
    message: profitPassed
      ? `利润总额合并核对精确闭合：下达单元合计 ${centsToDecimalString(sum8Profit)}元 + 排除单发主体 ${centsToDecimalString(excludedProfit)}元 === 合并总表 ${centsToDecimalString(groupConsolidatedProfit)}元`
      : `利润总额合并失衡：下达单元合计 + 排除主体 = ${centsToDecimalString(expectedGroupProfit)}元，与合并总表 ${centsToDecimalString(groupConsolidatedProfit)}元相差 ${centsToDecimalString(profitDiff)}元`,
  });

  const explicitVatChecks = Array.isArray(meta.vatChecks) ? (meta.vatChecks as Record<string, unknown>[]) : [];
  for (const vc of explicitVatChecks) {
    checks.push(verifyVatMaintenanceReconcile({
      unitOrgId: typeof vc.unitOrgId === 'number' ? vc.unitOrgId : null,
      unitName: String(vc.unitName ?? '运维成本勾稽'),
      planInclusiveCents: centsFromMetaOverride(vc.planInclusiveAmount) ?? 0n,
      budgetExclCents: centsFromMetaOverride(vc.budgetExclAmount) ?? 0n,
      adjustmentDeductionCents: centsFromMetaOverride(vc.adjustmentDeductionAmount) ?? 0n,
      vatRateBp: typeof vc.vatRateBp === 'number' ? vc.vatRateBp : vatRateBp,
    }));
  }
  if (explicitVatChecks.length === 0 && c.source_budget_version_id !== null) {
    const maintBudgetRows = db.prepare(`
      SELECT e.org_id, SUM(e.amount_cents) AS total_cents
      FROM budget_entry e JOIN account a ON a.id = e.account_id
      WHERE e.version_id = ? AND (a.code LIKE '%MAINT%' OR a.name LIKE '%运行维护%' OR a.name LIKE '%运维费%')
      GROUP BY e.org_id
    `).safeIntegers(true).all(c.source_budget_version_id) as unknown as { org_id: number; total_cents: bigint | number }[];
    const maintBudgetByUnit = new Map<number, bigint>();
    const rootOrgId = allOrgs.find((o) => o.parent_id === null)?.id ?? null;
    for (const r of maintBudgetRows) {
      const uid = resolveIssuanceUnitOrgId(Number(r.org_id), orgById, rootOrgId);
      if (uid !== null) maintBudgetByUnit.set(uid, (maintBudgetByUnit.get(uid) ?? 0n) + toCentsBig(r.total_cents));
    }
    for (const p of packDtos) {
      const planIncl = parseDecimalToCents(p.metrics.maintenanceTotal);
      const budgetExcl = maintBudgetByUnit.get(p.unitOrgId);
      if (planIncl > 0n && budgetExcl !== undefined) {
        checks.push(verifyVatMaintenanceReconcile({
          unitOrgId: p.unitOrgId,
          unitName: p.unitOrgName,
          planInclusiveCents: planIncl,
          budgetExclCents: budgetExcl,
          vatRateBp,
        }));
      }
    }
  }

  const explicitMgmtChecks = Array.isArray(meta.mgmtHierarchyChecks) ? (meta.mgmtHierarchyChecks as Record<string, unknown>[]) : [];
  for (const mc of explicitMgmtChecks) {
    checks.push(verifyMgmtFeeHierarchy({
      unitOrgId: typeof mc.unitOrgId === 'number' ? mc.unitOrgId : null,
      unitName: String(mc.unitName ?? '管理类费用预算表'),
      r17TotalCents: centsFromMetaOverride(mc.r17TotalAmount) ?? 0n,
      r18LaborCents: centsFromMetaOverride(mc.r18LaborAmount) ?? 0n,
      r19FiveExpensesCents: centsFromMetaOverride(mc.r19FiveExpensesAmount) ?? 0n,
      r20ControllableOtherCents: centsFromMetaOverride(mc.r20ControllableOtherAmount) ?? 0n,
      r21TaxDeprCents: centsFromMetaOverride(mc.r21TaxDeprAmount) ?? 0n,
      mode,
    }));
  }

  const metaCrossErrors = Array.isArray(meta.crossUnitFormulaErrors) ? (meta.crossUnitFormulaErrors as PlanWarningDto[]) : [];
  const crossUnitFormulaErrors: PlanWarningDto[] = [
    ...batchWarnings.filter((w) => w.code === 'CROSS_UNIT_CELL_REF'),
    ...metaCrossErrors.filter((w) => w.code === 'CROSS_UNIT_CELL_REF'),
  ];
  for (const ferr of crossUnitFormulaErrors) {
    checks.push({
      unitOrgId: null,
      unitName: ferr.sheet,
      kind: 'cross_unit_formula',
      passed: false,
      blocking: mode === 'strict_compile',
      planInclusiveAmount: null,
      expectedBudgetExclAmount: null,
      actualBudgetExclAmount: null,
      diffAmount: '0.00',
      reasonCode: 'CROSS_UNIT_CELL_REF',
      message: ferr.message,
    });
  }

  const blockingCount = checks.filter((ck) => ck.blocking && !ck.passed).length;
  const warningCount = checks.filter((ck) => (!ck.blocking && !ck.passed) || (ck.passed && ck.reasonCode !== 'EXACT_MATCH')).length;

  return {
    cycleId: c.id,
    mode,
    passed: blockingCount === 0,
    blockingCount,
    warningCount,
    vatRateBp,
    consolidation: {
      sum8UnitsOperatingRevenue: centsToDecimalString(sum8Rev),
      excludedOrgsOperatingRevenue: centsToDecimalString(excludedRev),
      groupConsolidatedOperatingRevenue: centsToDecimalString(groupConsolidatedRev),
      operatingRevenueSubCentDiff: centsToDecimalString(revDiff),
      sum8UnitsProfitBeforeTax: centsToDecimalString(sum8Profit),
      excludedOrgsProfitBeforeTax: centsToDecimalString(excludedProfit),
      groupConsolidatedProfitBeforeTax: centsToDecimalString(groupConsolidatedProfit),
      profitDiff: centsToDecimalString(profitDiff),
      investmentTotal: centsToDecimalString(sumInvest),
      safetyInputTotal: centsToDecimalString(sumSafety),
      fiveExpensesExactTotal: centsToDecimalString(sumFiveExact),
      fiveExpensesIssuedTotal: centsToDecimalString(sumFiveIssued),
      fiveExpensesStepDiff: centsToDecimalString(sumFiveIssued - sumFiveExact),
      excludedOrgs: excludedList,
    },
    checks,
    crossUnitFormulaErrors,
  };
}

export function publishIssuanceCycle(db: DB, cycleId: number): PlanIssuanceCycleDto {
  const auth = currentAuth();
  if (auth) requireAllOrgs(auth, '发布综合计划与预算合一下达周期');
  return db.transaction(() => {
  const c = getCycleRowOrThrow(db, cycleId);
  if (c.status !== 'draft') {
    throw new AppError('CYCLE_INVALID_STATE', `当前周期状态为 ${c.status}，不可重复发布`, 409);
  }

  // 编校后预算和组织可能变化，必须按发布时事实重编单元包并在同一事务内稽核、冻结。
  const orgs = loadAllOrgs(db);
  const rootId = orgs.find((o) => o.parent_id === null && o.status === 'active')?.id ?? null;
  const unitRows = db.prepare('SELECT unit_org_id FROM plan_issuance_unit_pack WHERE cycle_id = ?').all(cycleId) as { unit_org_id: number }[];
  const unitIds = new Set(unitRows.map((p) => p.unit_org_id));
  const summaries = buildPackSummaries(db, orgs.filter((o) => unitIds.has(o.id)), orgs, rootId, c.source_plan_batch_id, c.source_budget_version_id, JSON.parse(c.decision_doc_meta || '{}'));
  for (const [unitId, summary] of summaries) db.prepare('UPDATE plan_issuance_unit_pack SET pack_summary_json = ?, attachment_count = ? WHERE cycle_id = ? AND unit_org_id = ?')
    .run(JSON.stringify(summary), summary.attachments.length, cycleId, unitId);

  const report = reconcileCycleTotals(db, cycleId);
  if (!report.passed) {
    throw new AppError(
      'PLAN_RECONCILE_BLOCKED',
      `存在 ${report.blockingCount} 项阻断性勾稽/公式异常，禁止正式发布下达`,
      409,
      undefined,
      report,
    );
  }

  const batchRow = c.source_plan_batch_id !== null
    ? (db.prepare('SELECT id, file_sha256, version FROM plan_batch WHERE id = ?').get(c.source_plan_batch_id) as { id: number; file_sha256: string; version: number } | undefined)
    : undefined;
  const packs = db.prepare('SELECT id, unit_org_id, doc_no, pack_summary_json FROM plan_issuance_unit_pack WHERE cycle_id = ? ORDER BY id').all(cycleId) as {
    id: number; unit_org_id: number; doc_no: string; pack_summary_json: string;
  }[];
  const issuedDate = todayUtcDate();
  const now = nowIso();

  const snapshotPayload = {
    cycleId: c.id,
    year: c.year,
    cycleCode: c.cycle_code,
    issuanceStage: c.issuance_stage,
    sourcePlanBatch: batchRow ?? null,
    sourceBudgetVersionId: c.source_budget_version_id,
    vatRateBp: report.vatRateBp,
    roundingStepCents: WAN_2DEC_STEP_CENTS.toString(),
    reconcileConsolidation: report.consolidation,
    packs: packs.map((p) => ({
      packId: p.id,
      unitOrgId: p.unit_org_id,
      docNo: p.doc_no,
      summarySha256: crypto.createHash('sha256').update(p.pack_summary_json).digest('hex'),
    })),
    frozenAt: now,
  };
  const frozenJson = JSON.stringify(snapshotPayload);
  const snapshotSha256 = crypto.createHash('sha256').update(frozenJson).digest('hex');

  db.transaction(() => {
    db.prepare(`
      UPDATE plan_issuance_cycle
      SET status = 'published', frozen_snapshot_json = ?, snapshot_sha256 = ?, version = version + 1, updated_at = ?
      WHERE id = ?
    `).run(frozenJson, snapshotSha256, now, cycleId);

    db.prepare(`
      UPDATE plan_issuance_unit_pack
      SET sign_off_status = 'issued', issued_date = COALESCE(issued_date, ?), version = version + 1, updated_at = ?
      WHERE cycle_id = ? AND sign_off_status = 'draft'
    `).run(issuedDate, now, cycleId);

    writeLog(db, 'plan.issuance.publish_cycle', 'plan_issuance_cycle', cycleId, {
      cycleCode: c.cycle_code,
      snapshotSha256,
      packCount: packs.length,
    });
  }).immediate();

  return getIssuanceCycle(db, cycleId);
  }).immediate();
}

export function listUnitPacks(
  db: DB,
  q: { cycleId?: number; year?: number; status?: string; view?: 'unit' | 'undertake' } = {},
): PlanUnitPackDto[] {
  const scope = currentOrgScope(db);
  const where: string[] = ['1 = 1'];
  const params: unknown[] = [];
  if (q.cycleId !== undefined) { where.push('p.cycle_id = ?'); params.push(q.cycleId); }
  if (q.year !== undefined) { where.push('c.year = ?'); params.push(q.year); }
  if (q.status) { where.push('p.sign_off_status = ?'); params.push(q.status); }
  if (!scope.all) { where.push("c.status != 'draft'"); }

  const rows = db.prepare(`
    SELECT p.*
    FROM plan_issuance_unit_pack p
    JOIN plan_issuance_cycle c ON c.id = p.cycle_id
    WHERE ${where.join(' AND ')}
    ORDER BY c.year DESC, p.cycle_id DESC, p.id ASC
  `).all(...params) as PackRow[];

  const allOrgs = loadAllOrgs(db);
  const orgById = new Map(allOrgs.map((o) => [o.id, o]));
  const viewMode = q.view ?? 'unit';

  return rows
    .map((p) => packRowToDto(db, p, orgById, viewMode === 'undertake'))
    .filter((dto) => {
      if (scope.all) return true;
      if (orgInScope(scope, dto.unitOrgId)) return true;
      if (viewMode === 'undertake' && dto.undertakeItems?.some((it) => orgInScope(scope, it.undertakeOrgId))) {
        return true;
      }
      return false;
    })
    .map((dto) => {
      if (!scope.all && !orgInScope(scope, dto.unitOrgId) && dto.undertakeItems) {
        return {
          ...dto,
          undertakeItems: dto.undertakeItems.filter((it) => orgInScope(scope, it.undertakeOrgId)),
        };
      }
      return dto;
    });
}

function getPackRowScopedOrThrow(db: DB, packId: number, scope: OrgScope): PackRow {
  const row = db.prepare('SELECT * FROM plan_issuance_unit_pack WHERE id = ?').get(packId) as PackRow | undefined;
  if (!row || !orgInScope(scope, row.unit_org_id)) {
    throw Errors.notFound('本单位综合计划下达包不存在');
  }
  const cycle = getCycleRowOrThrow(db, row.cycle_id);
  if (!scope.all && cycle.status === 'draft') {
    throw Errors.notFound('本单位综合计划下达包不存在');
  }
  return row;
}

export function getUnitPack(db: DB, packId: number): PlanUnitPackDto {
  const scope = currentOrgScope(db);
  const row = getPackRowScopedOrThrow(db, packId, scope);
  const allOrgs = loadAllOrgs(db);
  const orgById = new Map(allOrgs.map((o) => [o.id, o]));
  return packRowToDto(db, row, orgById, true);
}

export function acknowledgeUnitPack(db: DB, packId: number, input: PlanPackAcknowledgeRequest): PlanUnitPackDto {
  const scope = currentOrgScope(db);
  const auth = currentAuth();
  const now = nowIso();

  db.transaction(() => {
    const row = getPackRowScopedOrThrow(db, packId, scope);
    if (row.version !== input.expectedVersion) {
      throw new AppError('VERSION_CONFLICT', '下达包已被其他人更新，请刷新后重试', 409);
    }
    if (row.sign_off_status !== 'issued' && row.sign_off_status !== 'adjust_requested') {
      throw new AppError('PACK_INVALID_STATE', `当前下达包状态为 ${row.sign_off_status}，无法执行签收`, 409);
    }
    db.prepare(`
      UPDATE plan_issuance_unit_pack
      SET sign_off_status = 'acknowledged', ack_user_id = ?, ack_at = ?, ack_note = ?,
          version = version + 1, updated_at = ?
      WHERE id = ?
    `).run(auth?.userId ?? null, now, input.ackNote ?? '', now, packId);

    writeLog(db, 'plan.issuance.acknowledge_pack', 'plan_issuance_unit_pack', packId, {
      cycleId: row.cycle_id,
      unitOrgId: row.unit_org_id,
      ackNote: input.ackNote ?? '',
    });
  }).immediate();

  return getUnitPack(db, packId);
}

export function derivePlanApprovalBody(
  unitOrg: OrgMetaRow,
  adjustType: PlanAdjustType,
  exceedsOverallTarget = false,
): PlanApprovalBody {
  const isHqOrDirectStation = unitOrg.parent_id === null || unitOrg.org_kind === 'hq_dept' || unitOrg.is_direct_station === 1;
  if (adjustType === 'overall_target_change' || exceedsOverallTarget) {
    return 'board_of_directors';
  }
  if (adjustType === 'within_total_realloc') {
    return 'gm_office';
  }
  if (adjustType === 'unplanned_hq_or_station') {
    return 'joint_review_company';
  }
  if (adjustType === 'unplanned_subsidiary_within_cap') {
    return isHqOrDirectStation ? 'joint_review_company' : 'subsidiary_self_decision';
  }
  if (adjustType === 'unplanned_subsidiary_over_cap') {
    return isHqOrDirectStation ? 'joint_review_company' : 'company_approval';
  }
  return isHqOrDirectStation ? 'joint_review_company' : 'company_approval';
}

/** 页面、受控草稿共用：只有冻结周期中的正式专项上限能支持子公司自行决策。 */
export function resolvePlanAdjustmentApprovalBody(db: DB, input: {
  unitOrgId: number; unitPackId?: number; cycleId?: number; adjustType: PlanAdjustType;
  exceedsOverallTarget?: boolean; lines?: PlanAdjustmentCreateRequest['lines'];
}): PlanApprovalBody {
  const unitOrg = loadAllOrgs(db).find((org) => org.id === input.unitOrgId);
  if (!unitOrg || !orgInScope(currentOrgScope(db), unitOrg.id)) throw Errors.notFound('申请单位不存在');
  const lines = input.lines ?? [];
  const parsedLines = lines.map(parseAdjustmentLineValues);
  const changesCoreTarget = lines.some((line, index) =>
    ['annual_kpi', 'profit_budget', 'responsibility_kpi'].includes(line.targetSheetCode) && parsedLines[index].beforeVal !== parsedLines[index].afterVal);
  let body = derivePlanApprovalBody(unitOrg, input.adjustType, Boolean(input.exceedsOverallTarget) || changesCoreTarget);
  if (body !== 'subsidiary_self_decision') return body;
  if (!input.unitPackId || !lines.length) return 'company_approval';
  const pack = getPackRowScopedOrThrow(db, input.unitPackId, currentOrgScope(db));
  const cycle = getCycleRowOrThrow(db, pack.cycle_id);
  if (pack.unit_org_id !== input.unitOrgId || (input.cycleId && cycle.id !== input.cycleId)) throw Errors.validation('申请单位与下达周期/单元包不一致');
  const meta = JSON.parse(cycle.decision_doc_meta || '{}') as Record<string, unknown>;
  const caps = (Array.isArray(meta.annualSpecialCaps) ? meta.annualSpecialCaps : []) as { unitOrgId: number; sheetCode: PlanSheetCode; amount: string }[];
  const summary = JSON.parse(pack.pack_summary_json || '{}') as PackSummaryStored;
  const withinCap = cycle.status === 'published' && lines.every((line) => {
    const cap = caps.find((c) => c.unitOrgId === pack.unit_org_id && c.sheetCode === line.targetSheetCode);
    if (!cap || line.valueType !== 'amount_cents') return false;
    const beforeTotal = (summary.attachments ?? []).filter((a) => a.sheetCode === line.targetSheetCode)
      .reduce((sum, a) => sum + parseDecimalToCents(a.issuedTotalAmount), 0n);
    const delta = lines.reduce((sum, l, i) => sum + (l.targetSheetCode === line.targetSheetCode ? parsedLines[i].deltaCents : 0n), 0n);
    return beforeTotal + delta <= parseDecimalToCents(cap.amount);
  });
  return withinCap ? 'subsidiary_self_decision' : 'company_approval';
}

function parseAdjustmentLineValues(line: PlanAdjustmentCreateRequest['lines'][number]): {
  beforeVal: string;
  afterVal: string;
  deltaVal: string;
  beforeCents: bigint;
  afterCents: bigint;
  deltaCents: bigint;
} {
  if (line.valueType === 'amount_cents') {
    const b = parseDecimalToCents(line.beforeVal || '0');
    const a = parseDecimalToCents(line.afterVal || '0');
    const d = a - b;
    return {
      beforeVal: centsToDecimalString(b),
      afterVal: centsToDecimalString(a),
      deltaVal: centsToDecimalString(d),
      beforeCents: b,
      afterCents: a,
      deltaCents: d,
    };
  }
  if (line.valueType === 'scaled_int' || line.valueType === 'rate_bp') {
    // 与 plan_fact 的固定精度一致，客户端 scale 不得改变原计划的量纲精度。
    const sc = line.valueType === 'rate_bp' ? 6 : 4;
    const b = parseScaled(line.beforeVal || '0', sc);
    const a = parseScaled(line.afterVal || '0', sc);
    const d = a - b;
    return {
      beforeVal: formatScaled(b, sc, false) || '0',
      afterVal: formatScaled(a, sc, false) || '0',
      deltaVal: formatScaled(d, sc, false) || '0',
      beforeCents: 0n,
      afterCents: 0n,
      deltaCents: 0n,
    };
  }
  return {
    beforeVal: line.beforeVal,
    afterVal: line.afterVal,
    deltaVal: `${line.beforeVal} -> ${line.afterVal}`,
    beforeCents: 0n,
    afterCents: 0n,
    deltaCents: 0n,
  };
}

function adjustmentRowToDto(db: DB, row: Record<string, unknown>): PlanAdjustmentDto {
  const idNum = Number(row.id);
  const cycle = db.prepare('SELECT cycle_code FROM plan_issuance_cycle WHERE id = ?').get(Number(row.cycle_id)) as { cycle_code: string } | undefined;
  const pack = db.prepare('SELECT unit_org_id FROM plan_issuance_unit_pack WHERE id = ?').get(Number(row.unit_pack_id)) as { unit_org_id: number } | undefined;
  const org = pack ? (db.prepare('SELECT name FROM org WHERE id = ?').get(pack.unit_org_id) as { name: string } | undefined) : undefined;
  const subUser = row.submitted_by_user_id
    ? (db.prepare('SELECT display_name, username FROM app_user WHERE id = ?').get(Number(row.submitted_by_user_id)) as { display_name: string; username: string } | undefined)
    : undefined;
  const revUser = row.reviewed_by_user_id
    ? (db.prepare('SELECT display_name, username FROM app_user WHERE id = ?').get(Number(row.reviewed_by_user_id)) as { display_name: string; username: string } | undefined)
    : undefined;

  const lines = db.prepare('SELECT * FROM plan_adjustment_line WHERE adjustment_id = ? ORDER BY id').safeIntegers(true).all(idNum) as unknown as Record<string, unknown>[];
  const lineDtos: PlanAdjustmentLineDto[] = lines.map((l) => ({
    id: Number(l.id),
    planItemId: l.plan_item_id !== null ? Number(l.plan_item_id) : null,
    stableItemUid: String(l.stable_item_uid ?? ''),
    targetSheetCode: l.target_sheet_code as PlanSheetCode,
    targetItemName: String(l.target_item_name),
    valueType: l.value_type as PlanAdjustmentLineDto['valueType'],
    scale: Number(l.scale ?? 2),
    unit: String(l.unit ?? '元'),
    beforeVal: String(l.before_val ?? '0'),
    afterVal: String(l.after_val ?? '0'),
    deltaVal: String(l.delta_val ?? '0'),
    beforeAmount: centsToDecimalString(toCentsBig(l.before_cents as bigint | number)),
    afterAmount: centsToDecimalString(toCentsBig(l.after_cents as bigint | number)),
    deltaAmount: centsToDecimalString(toCentsBig(l.delta_cents as bigint | number)),
    budgetAccountId: l.budget_account_id !== null ? Number(l.budget_account_id) : null,
    note: String(l.note ?? ''),
  }));

  const submittedDate = String(row.submitted_at).slice(0, 10);
  const emergencyStart = row.emergency_start_date ? String(row.emergency_start_date) : null;
  const wdays = emergencyStart ? (workingDaysBetween(emergencyStart, submittedDate, workingCalendar(db)) ?? 0) : 0;
  const adjustType = row.adjust_type as PlanAdjustType;
  const approvalBody = row.approval_body as PlanApprovalBody;

  return {
    id: idNum,
    cycleId: Number(row.cycle_id),
    cycleCode: cycle?.cycle_code ?? '',
    unitPackId: Number(row.unit_pack_id),
    unitOrgId: pack?.unit_org_id ?? 0,
    unitOrgName: org?.name ?? '',
    adjustType,
    adjustTypeLabel: PLAN_ADJUST_TYPE_LABELS[adjustType],
    approvalBody,
    approvalBodyLabel: PLAN_APPROVAL_BODY_LABELS[approvalBody],
    decisionDocNo: String(row.decision_doc_no ?? ''),
    decisionAttachmentId: row.decision_attachment_id !== null ? Number(row.decision_attachment_id) : null,
    emergencyStartDate: emergencyStart,
    emergencyOverdue5Workdays: adjustType === 'emergency_retroactive' && wdays > 5,
    reason: String(row.reason ?? ''),
    status: row.status as PlanAdjustmentDto['status'],
    newCycleId: row.new_cycle_id !== null ? Number(row.new_cycle_id) : null,
    submittedByUserId: row.submitted_by_user_id !== null ? Number(row.submitted_by_user_id) : null,
    submittedByName: subUser ? (subUser.display_name || subUser.username) : null,
    submittedAt: String(row.submitted_at),
    reviewedByUserId: row.reviewed_by_user_id !== null ? Number(row.reviewed_by_user_id) : null,
    reviewedByName: revUser ? (revUser.display_name || revUser.username) : null,
    reviewedAt: row.reviewed_at ? String(row.reviewed_at) : null,
    reviewComment: row.review_comment ? String(row.review_comment) : null,
    exceptionReason: row.exception_reason ? String(row.exception_reason) : null,
    selfReview: Number(row.self_review) === 1,
    lines: lineDtos,
  };
}

export function createPlanAdjustment(db: DB, input: PlanAdjustmentCreateRequest): PlanAdjustmentDto {
  const scope = currentOrgScope(db);
  const auth = currentAuth();
  const cycle = getCycleRowOrThrow(db, input.cycleId);
  if (cycle.status !== 'published') {
    throw new AppError('CYCLE_NOT_PUBLISHED', '仅已正式发布的计划周期可发起年中调整或计划外申请', 409);
  }
  const pack = getPackRowScopedOrThrow(db, input.unitPackId, scope);
  if (pack.cycle_id !== cycle.id) {
    throw Errors.validation('下达包不属于所选综合计划周期');
  }
  if (input.adjustType === 'emergency_retroactive' && !input.emergencyStartDate) {
    throw Errors.validation('应急先开工后补立项必须填写实际应急开工日期');
  }
  const unitOrg = db.prepare(`
    SELECT id, parent_id, code, name, sort_order, status, org_kind,
           plan_issuance_root_id, is_plan_excluded, is_direct_station, report_full_name
    FROM org WHERE id = ?
  `).get(pack.unit_org_id) as OrgMetaRow | undefined;
  if (!unitOrg) throw Errors.notFound('组织不存在');

  const allOrgs = loadAllOrgs(db);
  const orgById = new Map(allOrgs.map((o) => [o.id, o]));
  const rootId = allOrgs.find((o) => o.parent_id === null && o.status === 'active')?.id ?? null;
  const seenItems = new Set<number>();
  const normalizedLines = input.lines.map((line) => {
    let item: PlanItemDbRow | undefined;
    if (line.planItemId) {
      item = db.prepare('SELECT * FROM plan_item WHERE id = ?').safeIntegers(true).get(line.planItemId) as unknown as PlanItemDbRow | undefined;
      if (!item || Number(item.batch_id) !== cycle.source_plan_batch_id ||
          resolveIssuanceUnitOrgId(item.org_id === null ? null : Number(item.org_id), orgById, rootId) !== pack.unit_org_id ||
          (item.org_id !== null && !orgInScope(scope, Number(item.org_id)))) {
        throw Errors.notFound('申请单位当前周期的计划明细不存在');
      }
      if (item.sheet_code !== line.targetSheetCode) throw Errors.validation('调整工作表与关联计划明细不一致');
    } else if (cycle.source_plan_batch_id !== null) {
      const matches = (db.prepare('SELECT * FROM plan_item WHERE batch_id = ? AND sheet_code = ? AND item_name = ?')
        .safeIntegers(true).all(cycle.source_plan_batch_id, line.targetSheetCode, line.targetItemName) as unknown as PlanItemDbRow[])
        .filter((pi) => resolveIssuanceUnitOrgId(pi.org_id === null ? null : Number(pi.org_id), orgById, rootId) === pack.unit_org_id &&
          (pi.org_id === null || orgInScope(scope, Number(pi.org_id))));
      if (matches.length > 1) throw Errors.validation('同名计划明细不唯一，请明确关联 planItemId');
      item = matches[0];
    }
    if (item) {
      const itemId = Number(item.id);
      if (seenItems.has(itemId)) throw Errors.validation('一份申请不能重复调整同一计划明细');
      seenItems.add(itemId);
      if (line.stableItemUid && line.stableItemUid !== item.stable_item_uid) throw Errors.validation('计划明细稳定标识不匹配');
      const fact = db.prepare("SELECT value_type, amount_cents, scaled_value, text_value FROM plan_fact WHERE item_id = ? AND field_key = 'annual_plan'")
        .safeIntegers(true).get(itemId) as { value_type: string; amount_cents: bigint | null; scaled_value: bigint | null; text_value: string | null } | undefined;
      const expectedType = { amount_cents: 'amount', scaled_int: 'quantity', rate_bp: 'ratio', text: 'text' }[line.valueType];
      if (fact && fact.value_type !== expectedType) throw Errors.validation('调整量纲与原计划明细不一致');
      const currentVal = line.valueType === 'amount_cents'
        ? centsToDecimalString(toCentsBig(item.approved_cents ?? fact?.amount_cents ?? 0n))
        : line.valueType === 'text' ? fact?.text_value ?? ''
          : formatScaled(fact?.scaled_value ?? 0n, line.valueType === 'scaled_int' ? 4 : 6, false);
      const compareScale = line.valueType === 'amount_cents' ? 2 : line.valueType === 'scaled_int' ? 4 : 6;
      const sameBefore = line.valueType === 'text' ? line.beforeVal === currentVal
        : parseScaled(line.beforeVal || '0', compareScale) === parseScaled(currentVal, compareScale);
      if (!sameBefore) throw new AppError('ADJUSTMENT_BASELINE_STALE', '调整前值与原周期计划明细不一致，请重新核对', 409);
      return { ...line, targetItemName: item.item_name, planItemId: itemId, stableItemUid: item.stable_item_uid };
    }
    if (line.stableItemUid) throw Errors.validation('新增明细不能引用未匹配的稳定标识');
    if (line.valueType === 'text' ? !['', '0'].includes(line.beforeVal) : parseScaled(line.beforeVal || '0', line.valueType === 'amount_cents' ? 2 : line.scale) !== 0n) {
      throw Errors.validation('新增计划明细的调整前值必须为零；调整既有项目请关联计划明细或填写原项目名称');
    }
    return line;
  });
  const parsedLines = normalizedLines.map(parseAdjustmentLineValues);
  const approvalBody = resolvePlanAdjustmentApprovalBody(db, { ...input, unitOrgId: unitOrg.id, lines: normalizedLines });
  const now = nowIso();

  const adjId = db.transaction(() => {
    const res = db.prepare(`
      INSERT INTO plan_adjustment (
        cycle_id, unit_pack_id, adjust_type, approval_body, decision_doc_no,
        decision_attachment_id, emergency_start_date, reason, status,
        submitted_by_user_id, submitted_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'submitted', ?, ?)
    `).run(
      cycle.id,
      pack.id,
      input.adjustType,
      approvalBody,
      (input.decisionDocNo ?? '').trim(),
      input.decisionAttachmentId ?? null,
      input.emergencyStartDate ?? null,
      input.reason,
      auth?.userId ?? null,
      now,
    );
    const aid = Number(res.lastInsertRowid);
    normalizedLines.forEach((l, idx) => {
      const pv = parsedLines[idx];
      let stableUid = (l.stableItemUid ?? '').trim();
      if (!stableUid && l.planItemId) {
        const pi = db.prepare('SELECT stable_item_uid FROM plan_item WHERE id = ?').get(l.planItemId) as { stable_item_uid: string } | undefined;
        stableUid = pi?.stable_item_uid ?? '';
      }
      db.prepare(`
        INSERT INTO plan_adjustment_line (
          adjustment_id, plan_item_id, stable_item_uid, target_sheet_code, target_item_name,
          value_type, scale, unit, before_val, after_val, delta_val,
          before_cents, after_cents, delta_cents, budget_account_id, note
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `).safeIntegers(true).run(
        aid,
        l.planItemId ?? null,
        stableUid,
        l.targetSheetCode,
        l.targetItemName,
        l.valueType,
        l.valueType === 'amount_cents' ? 2 : l.valueType === 'scaled_int' ? 4 : l.valueType === 'rate_bp' ? 6 : 0,
        l.unit,
        pv.beforeVal,
        pv.afterVal,
        pv.deltaVal,
        pv.beforeCents,
        pv.afterCents,
        pv.deltaCents,
        l.budgetAccountId ?? null,
        l.note ?? '',
      );
    });
    writeLog(db, 'plan.issuance.create_adjustment', 'plan_adjustment', aid, {
      cycleId: cycle.id,
      unitPackId: pack.id,
      adjustType: input.adjustType,
      approvalBody,
    });
    return aid;
  }).immediate();

  const row = db.prepare('SELECT * FROM plan_adjustment WHERE id = ?').get(adjId) as Record<string, unknown>;
  return adjustmentRowToDto(db, row);
}

export function listPlanAdjustments(db: DB, q: { cycleId?: number; status?: string } = {}): PlanAdjustmentDto[] {
  const scope = currentOrgScope(db);
  const where: string[] = ['1 = 1'];
  const params: unknown[] = [];
  if (q.cycleId !== undefined) { where.push('a.cycle_id = ?'); params.push(q.cycleId); }
  if (q.status) { where.push('a.status = ?'); params.push(q.status); }

  const rows = db.prepare(`
    SELECT a.*, p.unit_org_id
    FROM plan_adjustment a
    JOIN plan_issuance_unit_pack p ON p.id = a.unit_pack_id
    WHERE ${where.join(' AND ')}
    ORDER BY a.id DESC
  `).all(...params) as (Record<string, unknown> & { unit_org_id: number })[];

  return rows
    .filter((r) => scope.all || orgInScope(scope, r.unit_org_id))
    .map((r) => adjustmentRowToDto(db, r));
}

export function reviewPlanAdjustment(db: DB, adjustmentId: number, input: PlanAdjustmentReviewRequest): PlanAdjustmentDto {
  const auth = currentAuth();
  if (auth) requireAllOrgs(auth, '复核综合计划调整申请');

  db.transaction(() => {
    const adj = db.prepare('SELECT * FROM plan_adjustment WHERE id = ?').get(adjustmentId) as Record<string, unknown> | undefined;
    if (!adj) throw Errors.notFound('计划调整申请不存在');
    if (adj.status !== 'submitted') {
      throw new AppError('ADJUSTMENT_ALREADY_REVIEWED', '该计划调整申请已复核处理', 409);
    }

    const { selfReview } = assertDistinctReviewer(
      db,
      auth,
      adj.submitted_by_user_id !== null ? Number(adj.submitted_by_user_id) : null,
      input.exceptionReason,
      '综合计划调整',
    );

    const now = nowIso();
    const finalDocNo = (input.decisionDocNo ?? String(adj.decision_doc_no ?? '')).trim();
    const finalAttachmentId = input.decisionAttachmentId ?? (adj.decision_attachment_id !== null ? Number(adj.decision_attachment_id) : null);

    if (input.action === 'reject') {
      db.prepare(`
        UPDATE plan_adjustment
        SET status = 'rejected', reviewed_by_user_id = ?, reviewed_at = ?, review_comment = ?,
            exception_reason = ?, self_review = ?
        WHERE id = ?
      `).run(auth?.userId ?? null, now, input.comment ?? null, input.exceptionReason ?? null, selfReview ? 1 : 0, adjustmentId);
      writeLog(db, 'plan.issuance.reject_adjustment', 'plan_adjustment', adjustmentId, { selfReview });
      return;
    }

    if (!finalDocNo) {
      throw Errors.validation('批准综合计划调整必须填写审定会议纪要/批复文号（decisionDocNo）');
    }
    if (adj.approval_body === 'board_of_directors' && finalAttachmentId === null) {
      throw Errors.validation('涉及总体指标的董事会审批调整必须关联批复决议附件（decisionAttachmentId）');
    }

    const oldCycle = getCycleRowOrThrow(db, Number(adj.cycle_id));
    if (oldCycle.status !== 'published') {
      throw new AppError('ADJUSTMENT_STALE', '原下达周期已被修订或归档，请基于最新周期重新申请', 409);
    }
    const adjPack = db.prepare('SELECT * FROM plan_issuance_unit_pack WHERE id = ?').get(Number(adj.unit_pack_id)) as PackRow;
    const lines = db.prepare('SELECT * FROM plan_adjustment_line WHERE adjustment_id = ? ORDER BY id').safeIntegers(true).all(adjustmentId) as unknown as Record<string, unknown>[];

    let newPlanBatchId = oldCycle.source_plan_batch_id;
    if (oldCycle.source_plan_batch_id !== null) {
      const srcBatch = db.prepare('SELECT * FROM plan_batch WHERE id = ?').get(oldCycle.source_plan_batch_id) as Record<string, unknown> | undefined;
      if (srcBatch) {
        const revSha = crypto.createHash('sha256').update(`${srcBatch.file_sha256}:adj:${adjustmentId}:${now}`).digest('hex');
        db.prepare('UPDATE plan_batch SET is_current = 0 WHERE year = ? AND is_current = 1').run(oldCycle.year);
        const bRes = db.prepare(`
          INSERT INTO plan_batch (
            year, actual_period, file_object_id, file_name, file_sha256, amount_unit,
            status, is_current, item_count, fact_count, sheets_json, ignored_sheets_json,
            created_by_user_id, created_at, activated_at, version
          ) VALUES (?, ?, ?, ?, ?, ?, 'imported', 1, ?, ?, ?, ?, ?, ?, ?, 1)
        `).run(
          srcBatch.year,
          srcBatch.actual_period,
          srcBatch.file_object_id,
          `${String(srcBatch.file_name)} (修订#${adjustmentId})`,
          revSha,
          srcBatch.amount_unit,
          Number(srcBatch.item_count),
          Number(srcBatch.fact_count),
          srcBatch.sheets_json,
          srcBatch.ignored_sheets_json,
          auth?.userId ?? null,
          now,
          now,
        );
        newPlanBatchId = Number(bRes.lastInsertRowid);

        const srcItems = db.prepare('SELECT * FROM plan_item WHERE batch_id = ? ORDER BY id').safeIntegers(true).all(oldCycle.source_plan_batch_id) as unknown as PlanItemDbRow[];
        const lineByPlanItemId = new Map<number, Record<string, unknown>>();
        for (const l of lines) {
          if (l.plan_item_id !== null) lineByPlanItemId.set(Number(l.plan_item_id), l);
        }
        let addedItems = 0;
        for (const it of srcItems) {
          const oldId = Number(it.id);
          const matchLine = lineByPlanItemId.get(oldId);
          const approvedCents = matchLine && matchLine.value_type === 'amount_cents'
            ? toCentsBig(matchLine.after_cents as bigint | number)
            : (it.approved_cents !== null ? toCentsBig(it.approved_cents) : null);
          const iRes = db.prepare(`
            INSERT INTO plan_item (
              batch_id, sheet_code, row_no, seq_no, item_name, item_type, path,
              project_id, org_id, undertake_org_id, item_key, stable_item_uid,
              cost_nature, funding_channel, submitted_cents, exact_calc_cents,
              approved_cents, rounding_rule, diff_reason_code, warnings_json, parent_item_key, estimate_subitem
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
          `).safeIntegers(true).run(
            newPlanBatchId,
            it.sheet_code,
            it.row_no,
            it.seq_no,
            it.item_name,
            it.item_type,
            it.path,
            it.project_id,
            it.org_id,
            it.undertake_org_id,
            it.item_key,
            it.stable_item_uid,
            it.cost_nature,
            it.funding_channel,
            it.submitted_cents,
            approvedCents ?? it.exact_calc_cents,
            approvedCents,
            it.rounding_rule,
            it.diff_reason_code,
            it.warnings_json,
            it.parent_item_key,
            it.estimate_subitem,
          );
          const newItemId = Number(iRes.lastInsertRowid);
          const srcFacts = db.prepare('SELECT * FROM plan_fact WHERE item_id = ?').safeIntegers(true).all(oldId) as unknown as Record<string, unknown>[];
          for (const f of srcFacts) {
            const isAdjusted = matchLine && f.field_key === 'annual_plan';
            const nextAmt = isAdjusted && matchLine.value_type === 'amount_cents'
              ? toCentsBig(matchLine.after_cents as bigint | number)
              : (f.amount_cents as bigint | number | null);
            const nextScaled = isAdjusted && ['scaled_int', 'rate_bp'].includes(String(matchLine.value_type))
              ? parseScaled(String(matchLine.after_val), matchLine.value_type === 'scaled_int' ? 4 : 6)
              : f.scaled_value;
            const nextText = isAdjusted && matchLine.value_type === 'text' ? matchLine.after_val : f.text_value;
            db.prepare(`
              INSERT INTO plan_fact (batch_id, item_id, field_key, measure, value_type, amount_cents, scaled_value, text_value, source_cell)
              VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            `).safeIntegers(true).run(
              newPlanBatchId,
              newItemId,
              f.field_key,
              f.measure,
              f.value_type,
              nextAmt,
              nextScaled,
              nextText,
              f.source_cell,
            );
          }
        }
        for (const l of lines) {
          if (l.plan_item_id !== null) continue;
          addedItems++;
          const rowNo = 9000 + addedItems;
          const afterCents = toCentsBig(l.after_cents as bigint | number);
          const uid = String(l.stable_item_uid || `PUID-ADJ-${adjustmentId}-${addedItems}`);
          const iRes = db.prepare(`
            INSERT INTO plan_item (
              batch_id, sheet_code, row_no, seq_no, item_name, item_type, path,
              project_id, org_id, undertake_org_id, item_key, stable_item_uid,
              cost_nature, funding_channel, submitted_cents, exact_calc_cents, approved_cents
            ) VALUES (?, ?, ?, ?, ?, 'detail', '计划调整增补', NULL, ?, ?, ?, ?, 'special', '', ?, ?, ?)
          `).safeIntegers(true).run(
            newPlanBatchId,
            l.target_sheet_code,
            rowNo,
            `补${addedItems}`,
            l.target_item_name,
            adjPack.unit_org_id,
            adjPack.unit_org_id,
            `adj:${adjustmentId}:${addedItems}`,
            uid,
            afterCents,
            afterCents,
            afterCents,
          );
          const factType = { amount_cents: 'amount', scaled_int: 'quantity', rate_bp: 'ratio', text: 'text' }[String(l.value_type)];
          db.prepare(`
            INSERT INTO plan_fact (batch_id, item_id, field_key, measure, value_type, amount_cents, scaled_value, text_value, source_cell)
            VALUES (?, ?, 'annual_plan', 'annual_plan', ?, ?, ?, ?, 'ADJ')
          `).safeIntegers(true).run(newPlanBatchId, Number(iRes.lastInsertRowid), factType,
            l.value_type === 'amount_cents' ? afterCents : null,
            ['scaled_int', 'rate_bp'].includes(String(l.value_type)) ? parseScaled(String(l.after_val), l.value_type === 'scaled_int' ? 4 : 6) : null,
            l.value_type === 'text' ? l.after_val : null);
        }
        if (addedItems > 0) {
          db.prepare('UPDATE plan_batch SET item_count = item_count + ?, fact_count = fact_count + ? WHERE id = ?')
            .run(addedItems, addedItems, newPlanBatchId);
        }
      }
    }

    let newBudgetVersionId = oldCycle.source_budget_version_id;
    if (oldCycle.source_budget_version_id !== null) {
      const srcBv = db.prepare('SELECT * FROM budget_version WHERE id = ?').get(oldCycle.source_budget_version_id) as Record<string, unknown> | undefined;
      if (srcBv) {
        const bvRes = db.prepare(`
          INSERT INTO budget_version (
            year, name, status, is_current, kind, org_tree_snapshot_id, account_tree_snapshot_id,
            source_version_id, note, created_at, updated_at, locked_at, generation_json, revision
          ) VALUES (?, ?, 'locked', 0, 'budget', ?, ?, ?, ?, ?, ?, ?, ?, 1)
        `).run(
          srcBv.year,
          `${String(srcBv.name)}-调整版#${adjustmentId}`,
          srcBv.org_tree_snapshot_id,
          srcBv.account_tree_snapshot_id,
          srcBv.id,
          `由综合计划调整 #${adjustmentId}（${finalDocNo}）联动派生`,
          now,
          now,
          now,
          srcBv.generation_json ?? '{}',
        );
        newBudgetVersionId = Number(bvRes.lastInsertRowid);
        db.prepare(`
          INSERT INTO budget_entry (version_id, org_id, account_id, amount_cents, quantity, formula, note, updated_at)
          SELECT ?, org_id, account_id, amount_cents, quantity, formula, note, ?
          FROM budget_entry WHERE version_id = ?
        `).run(newBudgetVersionId, now, oldCycle.source_budget_version_id);

        for (const l of lines) {
          if (l.budget_account_id !== null && l.value_type === 'amount_cents') {
            const account = db.prepare('SELECT type FROM account WHERE id = ?').get(Number(l.budget_account_id)) as { type: string } | undefined;
            if (!account) throw Errors.validation('预算联动科目不存在');
            const cycleMeta = JSON.parse(oldCycle.decision_doc_meta || '{}') as Record<string, unknown>;
            const vatBp = BigInt(typeof cycleMeta.vatRateBp === 'number' ? cycleMeta.vatRateBp : DEFAULT_MAINTENANCE_VAT_BP);
            const budgetDelta = l.target_sheet_code === 'maintenance'
              ? roundHalfUpDiv(toCentsBig(l.after_cents as bigint | number) * 10000n, 10000n + vatBp) - roundHalfUpDiv(toCentsBig(l.before_cents as bigint | number) * 10000n, 10000n + vatBp)
              : toCentsBig(l.delta_cents as bigint | number);
            const existingEntry = db.prepare('SELECT amount_cents FROM budget_entry WHERE version_id = ? AND org_id = ? AND account_id = ?')
              .safeIntegers(true).get(newBudgetVersionId, adjPack.unit_org_id, Number(l.budget_account_id)) as { amount_cents: bigint } | undefined;
            const directionSign = ['cost', 'expense'].includes(account.type) && (!existingEntry || existingEntry.amount_cents < 0n) ? -1n : 1n;
            const deltaNum = centsToSafeNumber(budgetDelta * directionSign, '预算联动调整额');
            if (existingEntry) {
              db.prepare('UPDATE budget_entry SET amount_cents = ?, updated_at = ? WHERE version_id = ? AND org_id = ? AND account_id = ?')
                .run(centsToSafeNumber(existingEntry.amount_cents + BigInt(deltaNum), '调整后预算额'), now, newBudgetVersionId, adjPack.unit_org_id, Number(l.budget_account_id));
            } else {
              db.prepare(`
                INSERT INTO budget_entry (version_id, org_id, account_id, amount_cents, quantity, formula, note, updated_at)
                VALUES (?, ?, ?, ?, NULL, '', ?, ?)
              `).run(newBudgetVersionId, adjPack.unit_org_id, Number(l.budget_account_id), deltaNum, finalDocNo, now);
            }
          }
        }
      }
    }

    db.prepare(`UPDATE plan_issuance_cycle SET status = 'superseded', version = version + 1, updated_at = ? WHERE id = ?`)
      .run(now, oldCycle.id);

    const baseCode = oldCycle.cycle_code.replace(/-ADJ-\d+$/, '');
    const revCount = (db.prepare(`SELECT COUNT(*) AS n FROM plan_issuance_cycle WHERE cycle_code LIKE ?`).get(`${baseCode}-ADJ-%`) as { n: number }).n + 1;
    const newCycleCode = `${baseCode}-ADJ-${revCount}`;
    const oldMeta = JSON.parse(oldCycle.decision_doc_meta || '{}') as Record<string, unknown>;
    const newMeta: Record<string, unknown> = { ...oldMeta, adjustedFromCycleId: oldCycle.id, adjustmentId, decisionDocNo: finalDocNo };
    // 正式公文导入的附表也必须随修订更新，不能继续复用旧冻结值。
    const overrides = newMeta.unitAttachments as Record<string, PlanAttachmentSummaryDto[]> | undefined;
    const unitCode = (db.prepare('SELECT code FROM org WHERE id = ?').get(adjPack.unit_org_id) as { code: string }).code;
    const sourceAttachments = overrides?.[unitCode] ?? overrides?.[String(adjPack.unit_org_id)];
    if (sourceAttachments) {
      const nameKey = (text: string) => text.replace(/\s+/g, '');
      for (const line of lines) {
        const matches = sourceAttachments.filter((a) => a.sheetCode === line.target_sheet_code);
        if (matches.length > 1) throw Errors.validation('同一工作表存在多份历史附表，请先核对来源');
        let attachment = matches[0];
        if (!attachment) {
          attachment = { attachmentNo:sourceAttachments.length+1, title:String(line.target_item_name), sheetCode:line.target_sheet_code as PlanSheetCode,
            unitOfMeasure:line.value_type === 'amount_cents' ? '万元' : '按行量纲', leafRowCount:0, exactTotalAmount:'0.00', issuedTotalAmount:'0.00', diffReasonCode:'', subEntities:[], undertakeDepts:[], rows:[] };
          sourceAttachments.push(attachment);
        }
        const matchingRows = attachment.rows.filter((r) => nameKey(r.itemName) === nameKey(String(line.target_item_name)));
        if (matchingRows.length > 1) throw Errors.validation('正式附表中同名明细不唯一，请先核对来源');
        const row = matchingRows[0];
        if (!row && !['','0','0.00'].includes(String(line.before_val))) throw Errors.validation('正式附表找不到调整原项，不能沿用旧冻结值');
        if (row) {
          const raw = row.amountOrValue.replace(/\s+/g, '');
          const before = String(line.before_val);
          const equal = line.value_type === 'amount_cents'
            ? parseScaled(raw, row.unit === '万元' ? 6 : 2) === toCentsBig(line.before_cents as bigint | number)
            : line.value_type === 'text' ? raw === before.replace(/\s+/g, '')
              : parseScaled(raw.replace(/%$/, ''), line.value_type === 'scaled_int' ? 4 : 6) === parseScaled(before, line.value_type === 'scaled_int' ? 4 : 6) * (row.unit === '%' || raw.endsWith('%') ? 100n : 1n);
          if (!equal) throw new AppError('ADJUSTMENT_BASELINE_STALE', '正式附表原值与调整基线不一致，请重新核对', 409);
          row.amountOrValue = line.value_type === 'amount_cents'
            ? formatScaled(toCentsBig(line.after_cents as bigint | number), row.unit === '万元' ? 6 : 2, false)
            : line.value_type === 'rate_bp' && (row.unit === '%' || raw.endsWith('%'))
              ? formatScaled(parseScaled(String(line.after_val), 6) * 100n, 6, false)
              : String(line.after_val);
        } else attachment.rows.push({ seqNo:String(attachment.rows.length+1), itemName:String(line.target_item_name), unit:line.value_type === 'amount_cents' ? '万元' : String(line.unit),
          amountOrValue:line.value_type === 'amount_cents' ? formatScaled(toCentsBig(line.after_cents as bigint | number),6,false) : String(line.after_val), undertakeOrgName:null, note:'修订新增' });
        if (!row) attachment.leafRowCount++;
        if (line.value_type === 'amount_cents') {
          const delta = toCentsBig(line.delta_cents as bigint | number);
          const exactAmount = centsToDecimalString(parseDecimalToCents(attachment.exactTotalAmount)+delta);
          const issuedAmount = centsToDecimalString(parseDecimalToCents(attachment.issuedTotalAmount)+delta);
          parseDecimalToCents(exactAmount); parseDecimalToCents(issuedAmount);
          attachment.exactTotalAmount = exactAmount;
          attachment.issuedTotalAmount = issuedAmount;
        }
      }
    }
    const metricOverrides = newMeta.unitMetrics as Record<string, Record<string, unknown>> | undefined;
    const metrics = metricOverrides?.[unitCode] ?? metricOverrides?.[String(adjPack.unit_org_id)];
    if (metrics) {
      const add = (key:string,delta:bigint) => {
        if (typeof metrics[key] === 'string') {
          const value = centsToDecimalString(parseDecimalToCents(metrics[key] as string)+delta);
          parseDecimalToCents(value); metrics[key]=value;
        }
      };
      for (const line of lines) if (line.value_type === 'amount_cents') {
        const delta=toCentsBig(line.delta_cents as bigint | number);
        const sheet=String(line.target_sheet_code); const name=String(line.target_item_name).replace(/\s+/g,'');
        const keys:Record<string,string[]>={purchase:['purchaseTotal','investmentTotal'],investment:['investmentTotal'],investment_tech_renovation:['investmentTotal'],investment_info:['investmentTotal'],investment_other:['investmentTotal'],maintenance:['maintenanceTotal'],safety_input:['safetyInputTotal'],five_expenses:['fiveExpensesExact','controllableMgmtFeeExact']};
        for (const key of keys[sheet] ?? []) add(key,delta);
        if (sheet === 'profit_budget') {
          if (/营业总收入/.test(name)) { metrics.operatingRevenue=centsToDecimalString(toCentsBig(line.after_cents as bigint | number)); add('totalRevenue',delta); }
          else if (/营业外收入/.test(name)) add('totalRevenue',delta);
          else if (/利润总额/.test(name)) metrics.profitBeforeTax=centsToDecimalString(toCentsBig(line.after_cents as bigint | number));
          else if (/净利润/.test(name)) metrics.netProfit=centsToDecimalString(toCentsBig(line.after_cents as bigint | number));
        }
        if (sheet === 'annual_kpi') {
          if (name === '固定资产投资') metrics.investmentTotal=centsToDecimalString(toCentsBig(line.after_cents as bigint | number));
          if (name === '总收入') metrics.totalRevenue=centsToDecimalString(toCentsBig(line.after_cents as bigint | number));
        }
        if (['mgmt_fee','mfg_fee'].includes(sheet) && /可控.*其他|其他.*可控/.test(name)) add('controllableMgmtFeeExact',delta);
      }
      for (const [exact,issued] of [['fiveExpensesExact','fiveExpensesIssued'],['controllableMgmtFeeExact','controllableMgmtFeeIssued']]) {
        if (typeof metrics[exact] === 'string') metrics[issued]=centsToDecimalString(roundHalfUpStep(parseDecimalToCents(metrics[exact] as string),WAN_2DEC_STEP_CENTS));
      }
    }

    const allOrgs = loadAllOrgs(db);
    const rootOrg = allOrgs.find((o) => o.parent_id === null && o.status === 'active') ?? allOrgs[0];
    const oldPacks = db.prepare('SELECT * FROM plan_issuance_unit_pack WHERE cycle_id = ? ORDER BY id').all(oldCycle.id) as PackRow[];
    const unitOrgs = oldPacks.map((p) => allOrgs.find((o) => o.id === p.unit_org_id)!).filter(Boolean);
    const rebuiltSummaries = buildPackSummaries(db, unitOrgs, allOrgs, rootOrg?.id ?? null, newPlanBatchId, newBudgetVersionId, newMeta);

    const newSnapObj = {
      adjustedFromCycleId: oldCycle.id,
      adjustmentId,
      decisionDocNo: finalDocNo,
      sourcePlanBatchId: newPlanBatchId,
      sourceBudgetVersionId: newBudgetVersionId,
      frozenAt: now,
    };
    const newSnapJson = JSON.stringify(newSnapObj);
    const newSnapSha = crypto.createHash('sha256').update(newSnapJson).digest('hex');

    const cRes = db.prepare(`
      INSERT INTO plan_issuance_cycle (
        year, cycle_code, issuance_stage, source_plan_batch_id, source_budget_version_id,
        decision_doc_meta, frozen_snapshot_json, snapshot_sha256, status, version,
        created_by_user_id, created_at, updated_at
      ) VALUES (?, ?, 'adjusted', ?, ?, ?, ?, ?, 'published', 1, ?, ?, ?)
    `).run(
      oldCycle.year,
      newCycleCode,
      newPlanBatchId,
      newBudgetVersionId,
      JSON.stringify(newMeta),
      newSnapJson,
      newSnapSha,
      auth?.userId ?? null,
      now,
      now,
    );
    const newCycleId = Number(cRes.lastInsertRowid);

    const today = todayUtcDate();
    for (const op of oldPacks) {
      const summary = rebuiltSummaries.get(op.unit_org_id) ?? (JSON.parse(op.pack_summary_json || '{}') as PackSummaryStored);
      const isTargetPack = op.id === adjPack.id;
      db.prepare(`
        INSERT INTO plan_issuance_unit_pack (
          cycle_id, unit_org_id, doc_no, issued_date, attachment_count,
          has_responsibility_letter, responsibility_letter_no, pack_summary_json,
          budget_version_id, sign_off_status, ack_user_id, ack_at, ack_note,
          version, created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, ?, ?)
      `).run(
        newCycleId,
        op.unit_org_id,
        `${op.doc_no}（修${revCount}）`,
        today,
        summary.attachments?.length ?? op.attachment_count,
        op.has_responsibility_letter,
        op.responsibility_letter_no,
        JSON.stringify(summary),
        newBudgetVersionId,
        isTargetPack ? 'issued' : op.sign_off_status,
        isTargetPack ? null : op.ack_user_id,
        isTargetPack ? null : op.ack_at,
        isTargetPack ? '' : op.ack_note,
        now,
        now,
      );
    }

    const revisedReport = reconcileCycleTotals(db, newCycleId);
    if (!revisedReport.passed) throw new AppError('PLAN_RECONCILE_BLOCKED', '修订周期存在勾稽失衡，未批准或写入任何修订结果', 409, undefined, revisedReport);
    const frozenPacks = (db.prepare('SELECT unit_org_id, pack_summary_json FROM plan_issuance_unit_pack WHERE cycle_id = ? ORDER BY id')
      .all(newCycleId) as { unit_org_id: number; pack_summary_json: string }[])
      .map((p) => ({ unitOrgId: p.unit_org_id, summarySha256: crypto.createHash('sha256').update(p.pack_summary_json).digest('hex') }));
    const finalSnapshot = JSON.stringify({ ...newSnapObj, reconcileConsolidation: revisedReport.consolidation, vatRateBp: revisedReport.vatRateBp, packs: frozenPacks });
    db.prepare('UPDATE plan_issuance_cycle SET frozen_snapshot_json = ?, snapshot_sha256 = ? WHERE id = ?')
      .run(finalSnapshot, crypto.createHash('sha256').update(finalSnapshot).digest('hex'), newCycleId);

    db.prepare(`
      UPDATE plan_adjustment
      SET status = 'approved', decision_doc_no = ?, decision_attachment_id = ?,
          new_cycle_id = ?, reviewed_by_user_id = ?, reviewed_at = ?, review_comment = ?,
          exception_reason = ?, self_review = ?
      WHERE id = ?
    `).run(
      finalDocNo,
      finalAttachmentId,
      newCycleId,
      auth?.userId ?? null,
      now,
      input.comment ?? null,
      input.exceptionReason ?? null,
      selfReview ? 1 : 0,
      adjustmentId,
    );

    writeLog(db, 'plan.issuance.approve_adjustment', 'plan_adjustment', adjustmentId, {
      oldCycleId: oldCycle.id,
      newCycleId,
      newCycleCode,
      decisionDocNo: finalDocNo,
      selfReview,
    });
  }).immediate();

  const updated = db.prepare('SELECT * FROM plan_adjustment WHERE id = ?').get(adjustmentId) as Record<string, unknown>;
  return adjustmentRowToDto(db, updated);
}

function buildNoticeRenderDoc(cycle: CycleRow, pack: PlanUnitPackDto, issuerName: string): RenderDoc {
  const sections: RenderSection[] = [
    {
      title: '一、年度综合计划与财务预算核心指标',
      body: `${pack.unitOrgName}：\n经审定，现将你单位${cycle.year}年度综合计划与全面预算合一下达如下。请严格按批复指标与归口项目组织实施，未经法定审批程序不得突破年度计划及预算总额。`,
      table: {
        headers: ['序号', '核心指标名称', '计量单位', '精确核算值（元）', '发文批复值（元）'],
        colWidths: [900, 2800, 1200, 2369, 2369],
        rows: [
          ['1', '营业总收入', '元', pack.metrics.operatingRevenue, pack.metrics.operatingRevenue],
          ['2', '利润总额', '元', pack.metrics.profitBeforeTax, pack.metrics.profitBeforeTax],
          ['3', '固定资产投资计划', '元', pack.metrics.investmentTotal, pack.metrics.investmentTotal],
          ['4', '运行维护费计划（含税）', '元', pack.metrics.maintenanceTotal, pack.metrics.maintenanceTotal],
          ['5', '安全生产投入计划', '元', pack.metrics.safetyInputTotal, pack.metrics.safetyInputTotal],
          ['6', '五项费用预算', '元', pack.metrics.fiveExpensesExact, pack.metrics.fiveExpensesIssued],
        ],
      },
    },
  ];

  for (const att of pack.attachments ?? []) {
    const rows = att.rows.map((r) => [
      r.seqNo,
      r.itemName,
      r.unit,
      r.amountOrValue,
      r.undertakeOrgName ?? pack.unitOrgName,
      r.note,
    ]);
    rows.push(['合计', `${att.title}合计`, att.unitOfMeasure, att.unitOfMeasure === '万元' ? issuedWanText(parseDecimalToCents(att.issuedTotalAmount)) : '—', '', att.diffReasonCode]);
    sections.push({
      title: `附表${att.attachmentNo}：${att.title}`,
      body: `共 ${att.leafRowCount} 项明细，计量单位：${att.unitOfMeasure}。`,
      table: {
        headers: ['序号', '项目/指标名称', '单位', '批复计划/预算', '承办单位/部门', '备注'],
        colWidths: [800, 3000, 900, 1800, 1700, 1438],
        rows,
      },
    });
  }

  if (pack.hasResponsibilityLetter) {
    sections.push({
      title: `经营管理目标责任书（${pack.responsibilityLetterNo}）`,
      body: `依据年度综合计划及全面预算，核定${pack.unitOrgName}${cycle.year}年度经营管理目标责任书核心考核指标如下：`,
      table: {
        headers: ['序号', '责任书考核指标', '口径说明', '精确测算（元）', '责任书批复（元）'],
        colWidths: [900, 2600, 2300, 1919, 1919],
        rows: [
          ['1', '营业总收入', '年度预算批复口径', pack.metrics.operatingRevenue, pack.metrics.operatingRevenue],
          ['2', '利润总额', '年度经营考核口径', pack.metrics.profitBeforeTax, pack.metrics.profitBeforeTax],
          ['3', '可控管理费', '五项费用(R19)+可控其他管理费(R20)', pack.metrics.controllableMgmtFeeExact, pack.metrics.controllableMgmtFeeIssued],
          ['4', '安全生产投入', '足额提取专项投入', pack.metrics.safetyInputTotal, pack.metrics.safetyInputTotal],
        ],
      },
    });
  }

  return {
    redHead: {
      issuer: `${issuerName}文件`,
      docNo: pack.docNo || `综计发〔${cycle.year}〕号`,
      signOff: issuerName,
      issueDate: pack.issuedDate ?? cycle.created_at.slice(0, 10),
    },
    title: `关于下达${pack.unitOrgName}${cycle.year}年度综合计划及财务预算的通知`,
    meta: [`周期编码：${cycle.cycle_code}`, `阶段：${PLAN_ISSUANCE_STAGE_LABELS[cycle.issuance_stage]}`],
    sections,
    watermark: cycle.status === 'draft' ? '草稿待审' : null,
  };
}

function buildResponsibilityLetterDoc(cycle: CycleRow, pack: PlanUnitPackDto, issuerName: string): RenderDoc {
  return {
    redHead: {
      issuer: `${issuerName}经营业绩考核文件`,
      docNo: pack.responsibilityLetterNo || `目责字〔${cycle.year}〕号`,
      signOff: issuerName,
      issueDate: pack.issuedDate ?? cycle.created_at.slice(0, 10),
    },
    title: `${pack.unitOrgName}${cycle.year}年度经营管理目标责任书`,
    meta: [`关联下达文号：${pack.docNo}`],
    sections: [
      {
        title: '一、年度经营考核核心目标',
        body: `为落实${cycle.year}年度综合计划与全面预算刚性约束，明确如下目标责任指标：`,
        table: {
          headers: ['序号', '指标名称', '计算口径', '考核目标值（元）'],
          colWidths: [1000, 3000, 3200, 2438],
          rows: [
            ['1', '营业总收入', '利润预算表主营及其他业务收入', pack.metrics.operatingRevenue],
            ['2', '利润总额', '利润预算表税前利润总额', pack.metrics.profitBeforeTax],
            ['3', '可控管理费', '管理费用表 R19(五项费用) + R20(可控其他)', pack.metrics.controllableMgmtFeeIssued],
            ['4', '安全生产投入', '年度安全生产投入计划足额实施', pack.metrics.safetyInputTotal],
          ],
        },
      },
    ],
    watermark: cycle.status === 'draft' ? '草稿待审' : null,
  };
}

export async function exportUnitPackDocx(db: DB, packId: number): Promise<{ fileName: string; buffer: Buffer }> {
  const pack = getUnitPack(db, packId);
  const cycle = getCycleRowOrThrow(db, pack.cycleId);
  const rootOrg = db.prepare('SELECT name FROM org WHERE parent_id IS NULL ORDER BY id LIMIT 1').get() as { name: string } | undefined;
  const issuerName = rootOrg?.name ?? '集团公司';
  const doc = buildNoticeRenderDoc(cycle, pack, issuerName);
  const buffer = await renderDocx(doc);
  const safeName = `${cycle.year}年度综合计划及预算下达通知_${pack.unitOrgName}.docx`.replace(/[\\/:*?"<>|]/g, '_');
  writeLog(db, 'plan.issuance.export_pack_docx', 'plan_issuance_unit_pack', packId, { cycleId: cycle.id });
  return { fileName: safeName, buffer };
}

export async function exportCycleZip(db: DB, cycleId: number): Promise<{ fileName: string; buffer: Buffer }> {
  const auth = currentAuth();
  if (auth) requireAllOrgs(auth, '打包下载全集团综合计划下达公文包');

  const cycle = getCycleRowOrThrow(db, cycleId);
  const allOrgs = loadAllOrgs(db);
  const orgById = new Map(allOrgs.map((o) => [o.id, o]));
  const rootOrg = allOrgs.find((o) => o.parent_id === null) ?? allOrgs[0];
  const issuerName = rootOrg?.name ?? '集团公司';
  const packRows = db.prepare('SELECT * FROM plan_issuance_unit_pack WHERE cycle_id = ? ORDER BY id').all(cycle.id) as PackRow[];
  const packs = packRows.map((p) => packRowToDto(db, p, orgById, true));
  const reconcile = reconcileCycleTotals(db, cycle.id);

  const zip = new JSZip();
  let letterIndex = 0;
  for (let i = 0; i < packs.length; i++) {
    const p = packs[i];
    const noticeBuf = await renderDocx(buildNoticeRenderDoc(cycle, p, issuerName));
    const safeUnit = p.unitOrgName.replace(/[\\/:*?"<>|]/g, '_');
    zip.file(`01_下达通知及附表/${String(i + 1).padStart(2, '0')}_${safeUnit}_${cycle.year}年度综合计划及预算下达通知.docx`, noticeBuf, { date: FIXED_ZIP_DATE });
    if (p.hasResponsibilityLetter) {
      letterIndex++;
      const letterBuf = await renderDocx(buildResponsibilityLetterDoc(cycle, p, issuerName));
      zip.file(`02_经营管理目标责任书/${String(letterIndex).padStart(2, '0')}_${safeUnit}_${cycle.year}年目标责任书.docx`, letterBuf, { date: FIXED_ZIP_DATE });
    }
  }

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('合一下达汇总底稿');
  ws.addRow([
    '序号', '下达单元编码', '下达单元名称', '发文字号', '附表数', '目标责任书编号', '签收状态',
    '营业总收入(元)', '利润总额(元)', '固定资产投资(元)', '运行维护费(元)', '安全生产投入(元)',
    '五项费用精确值(元)', '五项费用批复值(元)', '可控管理费批复值(元)',
  ]).font = { bold: true };
  packs.forEach((p, idx) => {
    ws.addRow([
      idx + 1,
      p.unitOrgCode,
      p.unitOrgName,
      p.docNo,
      p.attachmentCount,
      p.responsibilityLetterNo || '—',
      p.signOffStatus,
      p.metrics.operatingRevenue,
      p.metrics.profitBeforeTax,
      p.metrics.investmentTotal,
      p.metrics.maintenanceTotal,
      p.metrics.safetyInputTotal,
      p.metrics.fiveExpensesExact,
      p.metrics.fiveExpensesIssued,
      p.metrics.controllableMgmtFeeIssued,
    ]);
  });
  ws.addRow([
    '合计',
    '',
    '下达单元小计',
    '',
    packs.reduce((a, b) => a + b.attachmentCount, 0),
    `共${letterIndex}份`,
    '',
    reconcile.consolidation.sum8UnitsOperatingRevenue,
    reconcile.consolidation.sum8UnitsProfitBeforeTax,
    reconcile.consolidation.investmentTotal,
    '',
    reconcile.consolidation.safetyInputTotal,
    reconcile.consolidation.fiveExpensesExactTotal,
    reconcile.consolidation.fiveExpensesIssuedTotal,
    '',
  ]).font = { bold: true };
  for (const ex of reconcile.consolidation.excludedOrgs) {
    ws.addRow([
      '调节项',
      ex.orgCode,
      `${ex.orgName}（合并范围·不单发通知）`,
      '—',
      0,
      '—',
      '—',
      ex.operatingRevenue,
      ex.profitBeforeTax,
      '0.00',
      '0.00',
      '0.00',
      '0.00',
      '0.00',
      '0.00',
    ]);
  }
  ws.addRow([
    '集团合并',
    '',
    '集团合并总表口径',
    '',
    '',
    '',
    reconcile.passed ? '勾稽通过' : '存在失衡',
    reconcile.consolidation.groupConsolidatedOperatingRevenue,
    reconcile.consolidation.groupConsolidatedProfitBeforeTax,
    reconcile.consolidation.investmentTotal,
    '',
    reconcile.consolidation.safetyInputTotal,
    reconcile.consolidation.fiveExpensesExactTotal,
    reconcile.consolidation.fiveExpensesIssuedTotal,
    '',
  ]).font = { bold: true };

  const xlsxBuf = Buffer.from(await wb.xlsx.writeBuffer());
  zip.file(`03_合并勾稽底稿/${cycle.cycle_code}_综合计划及预算下达汇总底稿.xlsx`, xlsxBuf, { date: FIXED_ZIP_DATE });

  const zipBuf = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
  const safeZipName = `${cycle.cycle_code}_全集团综合计划及预算下达公文包.zip`.replace(/[\\/:*?"<>|]/g, '_');
  writeLog(db, 'plan.issuance.export_cycle_zip', 'plan_issuance_cycle', cycleId, {
    packCount: packs.length,
    letterCount: letterIndex,
  });
  return { fileName: safeZipName, buffer: zipBuf };
}
