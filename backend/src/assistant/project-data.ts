/**
 * T-4 项目、合同与费用的助手只读视图(AC-F09/F15/F16/F22)。
 *
 * 边界同 finance-data.ts:
 * - 只读,直接调用页面同源 service;组织范围由 tool-policy 的 org_scope 改写 orgScopeId,
 *   service 内部再按 AuthContext 裁剪(双重校验,范围外 404)。contract_detail 按合同 org_id 由 service 判定可见性。
 * - 写操作(导入、激活、审核、付款、复核)不暴露给助手。
 * - 有界:明细列表截断到固定条数并给出隐藏条数;报销事由/附件等用户文本不下发给模型。
 */
import type { DB } from '../db/connection';
import { projectBudgetSummary } from '../modules/project-budget/project-budget.service';
import { planOverview } from '../modules/plan-execution/plan.service';
import { contractSummary, getContractDetail } from '../modules/contracts/contract.service';
import { expenseQueue } from '../modules/expense/expense.service';

const ROW_LIMIT = 50;

function bounded<T>(rows: T[]): { items: T[]; total: number; hidden: number } {
  return { items: rows.slice(0, ROW_LIMIT), total: rows.length, hidden: Math.max(0, rows.length - ROW_LIMIT) };
}

export function projectBudgetSummaryView(db: DB, input: { orgScopeId: number | null; year?: number; period?: string; projectId?: number }) {
  const s = projectBudgetSummary(db, { orgId: input.orgScopeId ?? undefined, year: input.year, period: input.period, projectId: input.projectId });
  return {
    batch: s.batch ? { id: s.batch.id, year: s.batch.year, period: s.batch.period, name: s.batch.name, status: s.batch.status } : null,
    year: s.year, period: s.period, totals: s.totals, byProject: bounded(s.byProject), byOrg: bounded(s.byOrg), byFundSource: s.byFundSource, notes: s.notes,
  };
}

export function planExecutionOverviewView(db: DB, input: { orgScopeId: number | null; year: number; asOfPeriod?: string; projectId?: number }) {
  return planOverview(db, { year: input.year, asOfPeriod: input.asOfPeriod, orgId: input.orgScopeId ?? undefined, projectId: input.projectId });
}

export function contractSummaryView(db: DB, input: { orgScopeId: number | null; projectId?: number }) {
  return contractSummary(db, { orgId: input.orgScopeId ?? undefined, projectId: input.projectId });
}

export function contractDetailView(db: DB, input: { contractId: number }) {
  const d = getContractDetail(db, input.contractId);
  return {
    id: d.id, contractNo: d.contractNo, name: d.name, orgName: d.orgName, projectCode: d.projectCode, projectName: d.projectName, supplierName: d.supplierName,
    stage: d.stage, status: d.status, originalAmount: d.originalAmount, approvedChange: d.approvedChange, currentAmount: d.currentAmount, paidAmount: d.paidAmount,
    paymentRate: d.paymentRate, blockers: d.blockers, nextStage: d.nextStage,
    changes: d.changes.map((c) => ({ id: c.id, delta: c.delta, status: c.status, submittedAt: c.submittedAt })),
    payments: d.payments.map((p) => ({ id: p.id, nodeName: p.nodeName, amount: p.amount, status: p.status, paidDate: p.paidDate })),
    reviews: d.reviews.map((r) => ({ id: r.id, status: r.status, submittedAt: r.submittedAt })),
    documents: d.documents.map((doc) => ({ id: doc.id, docType: doc.docType, name: doc.name })),
    recentEvents: d.events.slice(-20).map((e) => ({ eventType: e.eventType, fromStage: e.fromStage, toStage: e.toStage, createdAt: e.createdAt })),
  };
}

export function expenseAuditQueueView(db: DB, input: { orgScopeId: number | null }) {
  const q = expenseQueue(db, { orgId: input.orgScopeId ?? undefined });
  return { counts: q.counts, awaitingReview: bounded(q.awaitingReview) };
}
