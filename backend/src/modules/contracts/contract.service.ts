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
import { AppError } from '../../core/errors';
import { currentAuth } from '../../core/request-context';
import { centsToDecimalString, formatScaled, mulCents, parseDecimalToCents, parseScaled, ratioString, RATIO_SCALE } from '../../core/decimal';
import { writeLog } from '../audit/log';
import { assertDistinctReviewer } from '../security/review';
import { currentOrgScope, notVisible, orgInScope, scopeFilterSql } from '../security/scope';
import { storeFile, type ObjectStore } from '../files/object-store';
import {
  CONTRACT_DOC_TYPE_LABELS, CONTRACT_STAGE_LABELS, CONTRACT_STAGES, CONTRACT_STATUSES, type BlockerDto, type ContractChangeDto, type ContractCreateRequest,
  type ContractDetailDto, type ContractDocType, type ContractDocumentDto, type ContractDto, type ContractEventDto, type ContractListQuery, type ContractPaymentDto,
  type ContractReviewDto, type ContractStage, type ContractStatus, type ContractSummaryDto, type ContractUpdateRequest, type DecisionRequest,
} from '../../contracts/project-contract';

const nowIso = () => new Date().toISOString();
const conflict = (code: string, message: string, details?: unknown) => new AppError(code, message, 409, undefined, details);

export interface ContractRow {
  id: number; contract_no: string; normalized_no: string; name: string; contract_type: string; org_id: number; project_id: number | null; supplier_id: number | null;
  original_cents: bigint; approved_change_cents: bigint; paid_cents: bigint; payment_cap_ratio_scaled: bigint | null; stage: ContractStage; status: ContractStatus;
  status_reason: string | null; sign_date: string | null; effective_date: string | null; source: 'manual' | 'import'; import_id: number | null; version: number;
  created_by_user_id: number | null; created_at: string; updated_at: string;
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
    import_id: n(r.import_id), version: Number(r.version), created_by_user_id: n(r.created_by_user_id),
  };
}

/** 读取范围内合同;不存在或范围外 404。 */
export function visibleContract(db: DB, id: number): ContractRow {
  const row = readRow(db, id);
  if (!row || !orgInScope(currentOrgScope(db), row.org_id)) throw notVisible('合同');
  return row;
}

function assertActive(c: ContractRow, what: string): void {
  if (c.status !== 'active') throw conflict('CONTRACT_STATE', `合同${CONTRACT_STATUS_TEXT[c.status]},不能${what}`);
}
const CONTRACT_STATUS_TEXT: Record<ContractStatus, string> = { active: '进行中', closed: '已关闭', terminated: '已终止', voided: '已作废' };

function assertVersion(c: ContractRow, expected: number): void {
  if (c.version !== expected) throw conflict('VERSION_CONFLICT', '合同已被其他人修改,请刷新后重试', { currentVersion: c.version });
}

function bump(db: DB, id: number): void {
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
  const org = db.prepare('SELECT name FROM org WHERE id = ?').get(c.org_id) as { name: string } | undefined;
  const project = c.project_id ? db.prepare('SELECT code, name FROM md_project WHERE id = ?').get(c.project_id) as { code: string; name: string } | undefined : undefined;
  const supplier = c.supplier_id ? db.prepare('SELECT name FROM md_supplier WHERE id = ?').get(c.supplier_id) as { name: string } | undefined : undefined;
  const counts = db.prepare(`SELECT
      (SELECT COUNT(*) FROM ct_review WHERE contract_id = ? AND status = 'submitted') AS reviews,
      (SELECT COUNT(*) FROM ct_change WHERE contract_id = ? AND status = 'submitted') AS changes,
      (SELECT COUNT(*) FROM ct_payment WHERE contract_id = ? AND status IN ('submitted','approved')) AS payments`).get(c.id, c.id, c.id) as { reviews: number; changes: number; payments: number };
  const current = currentCents(c);
  return {
    id: c.id, contractNo: c.contract_no, name: c.name, contractType: c.contract_type, orgId: c.org_id, orgName: org?.name ?? `#${c.org_id}`,
    projectId: c.project_id, projectCode: project?.code ?? null, projectName: project?.name ?? null, supplierId: c.supplier_id, supplierName: supplier?.name ?? null,
    originalAmount: centsToDecimalString(c.original_cents), approvedChange: centsToDecimalString(c.approved_change_cents), currentAmount: centsToDecimalString(current),
    paidAmount: centsToDecimalString(c.paid_cents), paymentRate: ratioString(c.paid_cents, current),
    paymentCapRatio: c.payment_cap_ratio_scaled === null ? null : formatScaled(c.payment_cap_ratio_scaled, RATIO_SCALE),
    stage: c.stage, status: c.status, statusReason: c.status_reason, signDate: c.sign_date, effectiveDate: c.effective_date, source: c.source, version: c.version,
    pendingReviews: counts.reviews, pendingChanges: counts.changes, openPayments: counts.payments, createdAt: c.created_at, updatedAt: c.updated_at,
  };
}

export function nextStage(stage: ContractStage): ContractStage | null {
  const i = CONTRACT_STAGES.indexOf(stage);
  return i >= 0 && i < CONTRACT_STAGES.length - 1 ? CONTRACT_STAGES[i + 1] : null;
}

const hasDoc = (db: DB, contractId: number, ...types: ContractDocType[]) =>
  !!db.prepare(`SELECT 1 FROM ct_document WHERE contract_id = ? AND doc_type IN (${types.map(() => '?').join(',')}) LIMIT 1`).get(contractId, ...types);

/** 离开当前阶段(推进到下一阶段)的阻断项。 */
export function computeBlockers(db: DB, c: ContractRow): BlockerDto[] {
  const out: BlockerDto[] = [];
  const add = (code: string, message: string) => out.push({ code, message });
  if (c.status !== 'active') add('CONTRACT_NOT_ACTIVE', `合同${CONTRACT_STATUS_TEXT[c.status]}`);
  switch (c.stage) {
    case 'initiation':
      if (!c.project_id) add('PROJECT_REQUIRED', '需求立项需关联项目');
      if (!c.contract_type) add('TYPE_REQUIRED', '需求立项需填写合同类型');
      break;
    case 'procurement':
      if (!hasDoc(db, c.id, 'procurement')) add('PROCUREMENT_DOC', '招采准备需上传招采文件');
      break;
    case 'drafting':
      if (BigInt(c.original_cents) <= 0n) add('AMOUNT_REQUIRED', '合同起草需填写大于 0 的合同金额');
      if (!c.supplier_id) add('SUPPLIER_REQUIRED', '合同起草需指定供应商');
      if (!hasDoc(db, c.id, 'contract_text')) add('CONTRACT_TEXT_DOC', '合同起草需上传合同正文');
      break;
    case 'approval': {
      const latestText = db.prepare("SELECT MAX(id) AS id FROM ct_document WHERE contract_id = ? AND doc_type = 'contract_text'").get(c.id) as { id: number | null };
      const approved = db.prepare("SELECT document_id FROM ct_review WHERE contract_id = ? AND status = 'approved' ORDER BY id DESC LIMIT 1").get(c.id) as { document_id: number } | undefined;
      if (!approved) add('REVIEW_APPROVED', '审批签署需合同审核通过');
      else if (latestText.id !== approved.document_id) add('REVIEW_OUTDATED', '合同正文在审核通过后有更新,需重新提交审核');
      if (!c.sign_date) add('SIGN_DATE', '审批签署需填写签订日期');
      if (!hasDoc(db, c.id, 'signed')) add('SIGNED_DOC', '审批签署需上传签署件');
      break;
    }
    case 'performance':
      if (!hasDoc(db, c.id, 'performance', 'acceptance')) add('PERFORMANCE_DOC', '履约执行需上传履约记录或验收文件');
      break;
    case 'settlement': {
      const open = db.prepare(`SELECT
          (SELECT COUNT(*) FROM ct_change WHERE contract_id = ? AND status = 'submitted') AS changes,
          (SELECT COUNT(*) FROM ct_payment WHERE contract_id = ? AND status IN ('submitted','approved')) AS payments`).get(c.id, c.id) as { changes: number; payments: number };
      if (open.changes) add('OPEN_CHANGES', `有 ${open.changes} 项变更未复核`);
      if (open.payments) add('OPEN_PAYMENTS', `有 ${open.payments} 笔付款未结`);
      if (BigInt(c.paid_cents) > currentCents(c)) add('OVERPAID', '已付超过当前金额');
      if (!hasDoc(db, c.id, 'acceptance')) add('ACCEPTANCE_DOC', '归档前需上传验收文件');
      break;
    }
    case 'archived':
      add('ARCHIVED', '合同已归档');
      break;
  }
  return out;
}

function documents(db: DB, contractId: number): ContractDocumentDto[] {
  return (db.prepare(`SELECT d.*, f.sha256, f.size_bytes FROM ct_document d JOIN file_object f ON f.id = d.file_object_id WHERE d.contract_id = ? ORDER BY d.id`).all(contractId) as
    { id: number; doc_type: ContractDocType; name: string; sha256: string; size_bytes: number; uploaded_by_user_id: number | null; uploaded_at: string }[])
    .map((d) => ({ id: d.id, docType: d.doc_type, name: d.name, fileSha256: d.sha256, sizeBytes: d.size_bytes, uploadedBy: userName(db, d.uploaded_by_user_id), uploadedAt: d.uploaded_at }));
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
  const reviews = (db.prepare('SELECT * FROM ct_review WHERE contract_id = ? ORDER BY id').all(id) as (ReviewCols & { id: number; document_id: number; status: ContractReviewDto['status']; submit_note: string })[])
    .map((r) => ({ id: r.id, documentId: r.document_id, documentName: docName.get(r.document_id) ?? '', status: r.status, note: r.submit_note, ...reviewPart(db, r) }));
  const changes = (db.prepare('SELECT * FROM ct_change WHERE contract_id = ? ORDER BY id').safeIntegers(true).all(id) as (ReviewCols & { id: bigint; delta_cents: bigint; reason: string; evidence_document_id: bigint; status: ContractChangeDto['status']; self_review: number })[])
    .map((r) => ({ ...reviewPart(db, { ...r, reviewed_by_user_id: num(r.reviewed_by_user_id), submitted_by_user_id: num(r.submitted_by_user_id), self_review: Number(r.self_review) }),
      id: Number(r.id), delta: centsToDecimalString(r.delta_cents), reason: r.reason, evidenceDocumentId: Number(r.evidence_document_id), status: r.status }));
  const payments = (db.prepare('SELECT * FROM ct_payment WHERE contract_id = ? ORDER BY id').safeIntegers(true).all(id) as Record<string, unknown>[]).map((r): ContractPaymentDto => ({
    ...reviewPart(db, { ...(r as unknown as ReviewCols), reviewed_by_user_id: num(r.reviewed_by_user_id), submitted_by_user_id: num(r.submitted_by_user_id), self_review: Number(r.self_review) }),
    id: Number(r.id), kind: r.kind as ContractPaymentDto['kind'], nodeName: String(r.node_name), amount: centsToDecimalString(r.amount_cents as bigint),
    plannedDate: (r.planned_date as string | null) ?? null, evidenceDocumentId: num(r.evidence_document_id), status: r.status as ContractPaymentDto['status'],
    paidDate: (r.paid_date as string | null) ?? null, voucherNo: (r.voucher_no as string | null) ?? null, invoiceDocumentId: num(r.invoice_document_id),
  }));
  const events = (db.prepare('SELECT * FROM ct_event WHERE contract_id = ? ORDER BY id').all(id) as { id: number; event_type: string; from_stage: ContractStage | null; to_stage: ContractStage | null; detail_json: string; actor_user_id: number | null; created_at: string }[])
    .map((e): ContractEventDto => ({ id: e.id, eventType: e.event_type, fromStage: e.from_stage, toStage: e.to_stage, detail: JSON.parse(e.detail_json), actor: userName(db, e.actor_user_id), createdAt: e.created_at }));
  return { ...toDto(db, c), nextStage: c.status === 'active' ? nextStage(c.stage) : null, blockers: computeBlockers(db, c), documents: docs, reviews, changes, payments, events };
}
const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export function getContract(db: DB, id: number): ContractDto {
  return toDto(db, visibleContract(db, id));
}

export function listContracts(db: DB, q: ContractListQuery = {}): ContractDto[] {
  const scope = currentOrgScope(db);
  if (q.orgId && !orgInScope(scope, q.orgId)) throw notVisible('组织');
  const sc = scopeFilterSql(scope, 'org_id');
  const where = [sc.sql];
  const params: unknown[] = [...sc.params];
  if (q.status) { where.push('status = ?'); params.push(q.status); }
  if (q.stage) { where.push('stage = ?'); params.push(q.stage); }
  if (q.orgId) {
    where.push('org_id IN (WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT o.id FROM org o JOIN sub ON o.parent_id = sub.id) SELECT id FROM sub)');
    params.push(q.orgId);
  }
  if (q.projectId) { where.push('project_id = ?'); params.push(q.projectId); }
  if (q.keyword) { const k = `%${q.keyword.replace(/[%_]/g, '')}%`; where.push('(contract_no LIKE ? OR name LIKE ?)'); params.push(k, k); }
  return (db.prepare(`SELECT * FROM ct_contract WHERE ${where.join(' AND ')} ORDER BY updated_at DESC, id DESC LIMIT 500`).safeIntegers(true).all(...params) as Record<string, unknown>[])
    .map((r) => toDto(db, normalizeRow(r)));
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
  const rows = db.prepare(`SELECT c.id, c.status, c.stage, c.original_cents, c.approved_change_cents, c.paid_cents FROM ct_contract c WHERE ${where.join(' AND ')}`)
    .safeIntegers(true).all(...params) as { id: bigint; status: ContractStatus; stage: ContractStage; original_cents: bigint; approved_change_cents: bigint; paid_cents: bigint }[];
  const byStatus = Object.fromEntries(CONTRACT_STATUSES.map((s) => [s, 0])) as Record<ContractStatus, number>;
  const byStage = Object.fromEntries(CONTRACT_STAGES.map((s) => [s, 0])) as Record<ContractStage, number>;
  let current = 0n; let paid = 0n;
  for (const r of rows) {
    byStatus[r.status]++; byStage[r.stage]++;
    if (r.status !== 'voided') { current += r.original_cents + r.approved_change_cents; paid += r.paid_cents; }
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
  return { count: rows.length, byStatus, byStage, currentAmount: centsToDecimalString(current), paidAmount: centsToDecimalString(paid), paymentRate: ratioString(paid, current), pending };
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

export function createContract(db: DB, input: ContractCreateRequest): ContractDetailDto {
  const scope = currentOrgScope(db);
  if (!orgInScope(scope, input.orgId)) throw notVisible('组织');
  if (!db.prepare("SELECT 1 FROM org WHERE id = ? AND status = 'active'").get(input.orgId)) throw new AppError('VALIDATION_FAILED', '组织不存在或已停用', 400);
  if (input.projectId) assertProject(db, input.projectId, input.orgId);
  if (input.supplierId) assertSupplier(db, input.supplierId);
  const original = parseDecimalToCents(input.originalAmount, { label: '合同金额' });
  if (original < 0n) throw new AppError('VALIDATION_FAILED', '合同金额不能为负', 400);
  const normalized = normalizeContractNo(input.contractNo);
  const id = db.transaction(() => {
    if (db.prepare('SELECT 1 FROM ct_contract WHERE normalized_no = ?').get(normalized)) throw conflict('CONTRACT_NO_EXISTS', `合同编号 ${input.contractNo} 已存在`);
    const now = nowIso();
    const newId = Number(db.prepare(`INSERT INTO ct_contract (contract_no, normalized_no, name, contract_type, org_id, project_id, supplier_id, original_cents, payment_cap_ratio_scaled,
      sign_date, effective_date, source, created_by_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'manual', ?, ?, ?)`).run(
      input.contractNo.trim(), normalized, input.name, input.contractType ?? '', input.orgId, input.projectId ?? null, input.supplierId ?? null, original,
      capScaled(input.paymentCapRatio), input.signDate ?? null, input.effectiveDate ?? null, currentAuth()?.userId ?? null, now, now).lastInsertRowid);
    recordEvent(db, newId, 'create', { contractNo: input.contractNo.trim(), originalAmount: centsToDecimalString(original) }, { to: 'initiation' });
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
    const early = EARLY.includes(c.stage);
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
    if (!sets.length) return;
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
    const next = nextStage(c.stage);
    if (toStage !== next) {
      throw conflict('CONTRACT_STAGE_BLOCKED', `只能从「${CONTRACT_STAGE_LABELS[c.stage]}」推进到下一阶段${next ? `「${CONTRACT_STAGE_LABELS[next]}」` : ''}`, { blockers: [{ code: 'STAGE_SKIP', message: '不能跳阶段或回退' }] });
    }
    const blockers = computeBlockers(db, c);
    if (blockers.length) throw conflict('CONTRACT_STAGE_BLOCKED', `推进到「${CONTRACT_STAGE_LABELS[toStage]}」前还有 ${blockers.length} 项未满足`, { blockers });
    const closing = toStage === 'archived';
    db.prepare(`UPDATE ct_contract SET stage = ?, status = ?, version = version + 1, updated_at = ? WHERE id = ?`).run(toStage, closing ? 'closed' : 'active', nowIso(), id);
    recordEvent(db, id, closing ? 'archive' : 'advance', {}, { from: c.stage, to: toStage });
  }).immediate();
  return getContractDetail(db, id);
}

export function terminateContract(db: DB, id: number, expectedVersion: number, reason: string): ContractDetailDto {
  return statusCommand(db, id, expectedVersion, reason, 'terminated', 'terminate');
}

export function voidContract(db: DB, id: number, expectedVersion: number, reason: string): ContractDetailDto {
  return statusCommand(db, id, expectedVersion, reason, 'voided', 'void');
}

function statusCommand(db: DB, id: number, expectedVersion: number, reason: string, status: 'terminated' | 'voided', event: string): ContractDetailDto {
  db.transaction(() => {
    const c = visibleContract(db, id);
    assertActive(c, status === 'voided' ? '作废' : '终止');
    assertVersion(c, expectedVersion);
    if (status === 'voided' && BigInt(c.paid_cents) > 0n) throw conflict('CONTRACT_STATE', '已有付款的合同不能作废,请改为终止');
    const open = db.prepare("SELECT COUNT(*) AS n FROM ct_payment WHERE contract_id = ? AND status IN ('submitted','approved')").get(id) as { n: number };
    if (open.n) throw conflict('CONTRACT_STATE', `有 ${open.n} 笔付款未结,请先驳回或完成支付`);
    db.prepare('UPDATE ct_contract SET status = ?, status_reason = ?, version = version + 1, updated_at = ? WHERE id = ?').run(status, reason, nowIso(), id);
    recordEvent(db, id, event, { reason }, { from: c.stage, to: c.stage });
  }).immediate();
  return getContractDetail(db, id);
}

/** 重开:已关闭或已终止的合同回到指定的非归档阶段;作废不可重开。需要 contract:review(路由把关)。 */
export function reopenContract(db: DB, id: number, expectedVersion: number, reason: string, targetStage: ContractStage): ContractDetailDto {
  db.transaction(() => {
    const c = visibleContract(db, id);
    assertVersion(c, expectedVersion);
    if (c.status !== 'closed' && c.status !== 'terminated') throw conflict('CONTRACT_STATE', c.status === 'voided' ? '已作废的合同不能重开' : '只有已关闭或已终止的合同可以重开');
    if (targetStage === 'archived') throw new AppError('VALIDATION_FAILED', '重开目标阶段不能是归档关闭', 400);
    db.prepare("UPDATE ct_contract SET status = 'active', stage = ?, status_reason = ?, version = version + 1, updated_at = ? WHERE id = ?").run(targetStage, reason, nowIso(), id);
    recordEvent(db, id, 'reopen', { reason, previousStatus: c.status }, { from: c.stage, to: targetStage });
  }).immediate();
  return getContractDetail(db, id);
}

/* ================= 文档 ================= */

export function addContractDocument(db: DB, store: ObjectStore, id: number, content: Buffer, fileName: string, docType: ContractDocType, name?: string): ContractDocumentDto {
  const c = visibleContract(db, id);
  assertActive(c, '上传文档');
  if (docType === 'contract_text' && db.prepare("SELECT 1 FROM ct_review WHERE contract_id = ? AND status = 'submitted'").get(id)) {
    throw conflict('CONTRACT_STATE', '合同审核进行中,不能替换合同正文;请等待审核结论后再上传');
  }
  const file = storeFile(db, store, content, { originalName: fileName });
  const docId = db.transaction(() => {
    const fresh = visibleContract(db, id);
    assertActive(fresh, '上传文档');
    const newId = Number(db.prepare('INSERT INTO ct_document (contract_id, doc_type, file_object_id, name, uploaded_by_user_id, uploaded_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, docType, file.id, (name || fileName).slice(0, 200), currentAuth()?.userId ?? null, nowIso()).lastInsertRowid);
    bump(db, id);
    recordEvent(db, id, 'document', { documentId: newId, docType, docTypeLabel: CONTRACT_DOC_TYPE_LABELS[docType], fileSha256: file.sha256 });
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

function contractDoc(db: DB, contractId: number, docId: number): { id: number; doc_type: ContractDocType } {
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
    const r = db.prepare('SELECT * FROM ct_review WHERE id = ? AND contract_id = ?').get(reviewId, id) as { id: number; status: string; submitted_by_user_id: number | null } | undefined;
    if (!r) throw notVisible('合同审核');
    if (r.status !== 'submitted') throw conflict('CONTRACT_STATE', '该审核已处理,结论不可更改');
    const { selfReview } = assertDistinctReviewer(db, auth, r.submitted_by_user_id, input.exceptionReason, '合同审核');
    const status = input.decision === 'approve' ? 'approved' : 'rejected';
    db.prepare('UPDATE ct_review SET status = ?, reviewed_by_user_id = ?, reviewed_at = ?, review_comment = ?, exception_reason = ?, self_review = ? WHERE id = ?')
      .run(status, auth?.userId ?? null, nowIso(), input.comment ?? null, input.exceptionReason ?? null, selfReview ? 1 : 0, reviewId);
    bump(db, id);
    recordEvent(db, id, `review.${status === 'approved' ? 'approve' : 'reject'}`, { reviewId, comment: input.comment ?? null, selfReview, exceptionReason: input.exceptionReason ?? null });
  }).immediate();
  return getContractDetail(db, id);
}

/* ================= 变更 ================= */

const CHANGE_STAGES: ContractStage[] = ['performance', 'settlement'];

export function submitContractChange(db: DB, id: number, input: { delta: string; reason: string; evidenceDocumentId: number }): ContractDetailDto {
  const delta = parseDecimalToCents(input.delta, { label: '变更金额' });
  if (delta === 0n) throw new AppError('VALIDATION_FAILED', '变更金额不能为 0', 400);
  db.transaction(() => {
    const c = visibleContract(db, id);
    assertActive(c, '提交变更');
    if (!CHANGE_STAGES.includes(c.stage)) throw conflict('CONTRACT_STATE', '只能在「履约执行」「变更结算」阶段提交变更');
    contractDoc(db, id, input.evidenceDocumentId);
    assertChangeKeepsPaid(c, delta);
    const cid = Number(db.prepare('INSERT INTO ct_change (contract_id, delta_cents, reason, evidence_document_id, submitted_by_user_id, submitted_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, delta, input.reason, input.evidenceDocumentId, currentAuth()?.userId ?? null, nowIso()).lastInsertRowid);
    bump(db, id);
    recordEvent(db, id, 'change.submit', { changeId: cid, delta: centsToDecimalString(delta), reason: input.reason });
  }).immediate();
  return getContractDetail(db, id);
}

function assertChangeKeepsPaid(c: ContractRow, delta: bigint): void {
  const after = currentCents(c) + delta;
  if (after < BigInt(c.paid_cents)) {
    throw conflict('CONTRACT_AMOUNT_BELOW_PAID', `变更后当前金额 ${centsToDecimalString(after)} 将低于已付 ${centsToDecimalString(c.paid_cents)}`,
      { currentAmount: centsToDecimalString(currentCents(c)), paidAmount: centsToDecimalString(c.paid_cents), afterChange: centsToDecimalString(after) });
  }
}

export function decideContractChange(db: DB, id: number, changeId: number, input: DecisionRequest): ContractDetailDto {
  const auth = currentAuth();
  db.transaction(() => {
    const c = visibleContract(db, id);
    assertActive(c, '复核变更');
    const ch = db.prepare('SELECT id, status, delta_cents, submitted_by_user_id FROM ct_change WHERE id = ? AND contract_id = ?').safeIntegers(true).get(changeId, id) as
      { id: bigint; status: string; delta_cents: bigint; submitted_by_user_id: bigint | null } | undefined;
    if (!ch) throw notVisible('合同变更');
    if (ch.status !== 'submitted') throw conflict('CONTRACT_STATE', '该变更已复核,结论不可更改');
    const { selfReview } = assertDistinctReviewer(db, auth, num(ch.submitted_by_user_id), input.exceptionReason, '合同变更');
    const approve = input.decision === 'approve';
    if (approve) {
      assertChangeKeepsPaid(c, ch.delta_cents);
      const approvedUnpaid = sumPayments(db, id, ['approved']);
      if (currentCents(c) + ch.delta_cents < BigInt(c.paid_cents) + approvedUnpaid) {
        throw conflict('CONTRACT_AMOUNT_BELOW_PAID', '变更后当前金额将低于 已付 + 已批准未付', { approvedUnpaid: centsToDecimalString(approvedUnpaid) });
      }
      db.prepare('UPDATE ct_contract SET approved_change_cents = approved_change_cents + ? WHERE id = ?').run(ch.delta_cents, id);
    }
    db.prepare('UPDATE ct_change SET status = ?, reviewed_by_user_id = ?, reviewed_at = ?, review_comment = ?, exception_reason = ?, self_review = ? WHERE id = ?')
      .run(approve ? 'approved' : 'rejected', auth?.userId ?? null, nowIso(), input.comment ?? null, input.exceptionReason ?? null, selfReview ? 1 : 0, changeId);
    bump(db, id);
    recordEvent(db, id, `change.${approve ? 'approve' : 'reject'}`, {
      changeId, delta: centsToDecimalString(ch.delta_cents), currentAmountAfter: centsToDecimalString(currentCents(c) + (approve ? ch.delta_cents : 0n)), selfReview,
      exceptionReason: input.exceptionReason ?? null,
    });
  }).immediate();
  return getContractDetail(db, id);
}

/* ================= 付款 ================= */

function sumPayments(db: DB, contractId: number, statuses: string[]): bigint {
  const r = db.prepare(`SELECT COALESCE(SUM(amount_cents), 0) AS s FROM ct_payment WHERE contract_id = ? AND status IN (${statuses.map(() => '?').join(',')})`)
    .safeIntegers(true).get(contractId, ...statuses) as { s: bigint };
  return r.s;
}

/** 可付上限:当前金额;设置了付款上限比例时取 当前金额 × 比例。 */
function payLimit(c: ContractRow): bigint {
  const current = currentCents(c);
  return c.payment_cap_ratio_scaled === null ? current : mulCents(current, BigInt(c.payment_cap_ratio_scaled), RATIO_SCALE, 'down');
}

function assertPaymentFits(db: DB, c: ContractRow, amount: bigint, excludePaymentId?: number): void {
  let approvedUnpaid = sumPayments(db, c.id, ['approved']);
  if (excludePaymentId) {
    const own = db.prepare("SELECT amount_cents FROM ct_payment WHERE id = ? AND status = 'approved'").safeIntegers(true).get(excludePaymentId) as { amount_cents: bigint } | undefined;
    if (own) approvedUnpaid -= own.amount_cents;
  }
  const limit = payLimit(c);
  const total = approvedUnpaid + BigInt(c.paid_cents) + amount;
  if (total > limit) {
    throw conflict('CONTRACT_PAYMENT_EXCEEDS', `已批准未付 + 已付 + 本次 = ${centsToDecimalString(total)},超过可付上限 ${centsToDecimalString(limit)}`, {
      approvedUnpaid: centsToDecimalString(approvedUnpaid), paid: centsToDecimalString(c.paid_cents), amount: centsToDecimalString(amount), limit: centsToDecimalString(limit),
    });
  }
}

export function submitContractPayment(db: DB, id: number, input: { nodeName: string; amount: string; plannedDate?: string | null; evidenceDocumentId?: number | null }): ContractDetailDto {
  const amount = parseDecimalToCents(input.amount, { label: '付款金额' });
  if (amount <= 0n) throw new AppError('VALIDATION_FAILED', '付款金额必须大于 0', 400);
  db.transaction(() => {
    const c = visibleContract(db, id);
    assertActive(c, '申请付款');
    if (!CHANGE_STAGES.includes(c.stage)) throw conflict('CONTRACT_STATE', '只能在「履约执行」「变更结算」阶段申请付款');
    if (input.evidenceDocumentId) contractDoc(db, id, input.evidenceDocumentId);
    assertPaymentFits(db, c, amount);
    const pid = Number(db.prepare(`INSERT INTO ct_payment (contract_id, node_name, amount_cents, planned_date, evidence_document_id, submitted_by_user_id, submitted_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(id, input.nodeName, amount, input.plannedDate ?? null, input.evidenceDocumentId ?? null, currentAuth()?.userId ?? null, nowIso()).lastInsertRowid);
    bump(db, id);
    recordEvent(db, id, 'payment.submit', { paymentId: pid, nodeName: input.nodeName, amount: centsToDecimalString(amount) });
  }).immediate();
  return getContractDetail(db, id);
}

export function decideContractPayment(db: DB, id: number, paymentId: number, input: DecisionRequest): ContractDetailDto {
  const auth = currentAuth();
  db.transaction(() => {
    const c = visibleContract(db, id);
    assertActive(c, '复核付款');
    const p = db.prepare('SELECT id, status, amount_cents, submitted_by_user_id FROM ct_payment WHERE id = ? AND contract_id = ?').safeIntegers(true).get(paymentId, id) as
      { id: bigint; status: string; amount_cents: bigint; submitted_by_user_id: bigint | null } | undefined;
    if (!p) throw notVisible('付款申请');
    if (p.status !== 'submitted') throw conflict('CONTRACT_STATE', '该付款申请已复核,结论不可更改');
    const { selfReview } = assertDistinctReviewer(db, auth, num(p.submitted_by_user_id), input.exceptionReason, '付款申请');
    const approve = input.decision === 'approve';
    if (approve) assertPaymentFits(db, c, p.amount_cents);
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
    const p = db.prepare('SELECT id, status, amount_cents FROM ct_payment WHERE id = ? AND contract_id = ?').safeIntegers(true).get(paymentId, id) as
      { id: bigint; status: string; amount_cents: bigint } | undefined;
    if (!p) throw notVisible('付款申请');
    if (p.status !== 'approved') throw conflict('CONTRACT_STATE', '只有已批准的付款可以登记支付');
    const doc = db.prepare('SELECT doc_type FROM ct_document WHERE id = ? AND contract_id = ?').get(input.invoiceDocumentId, id) as { doc_type: string } | undefined;
    if (!doc || doc.doc_type !== 'invoice') throw conflict('EVIDENCE_REQUIRED', '登记支付须附本合同的发票文档');
    if (BigInt(c.paid_cents) + p.amount_cents > currentCents(c)) {
      throw conflict('CONTRACT_PAYMENT_EXCEEDS', '支付后已付将超过当前金额');
    }
    db.prepare("UPDATE ct_payment SET status = 'paid', paid_date = ?, voucher_no = ?, invoice_document_id = ?, paid_by_user_id = ?, paid_at = ? WHERE id = ?")
      .run(input.paidDate, input.voucherNo ?? null, input.invoiceDocumentId, currentAuth()?.userId ?? null, nowIso(), paymentId);
    db.prepare('UPDATE ct_contract SET paid_cents = paid_cents + ? WHERE id = ?').run(p.amount_cents, id);
    bump(db, id);
    recordEvent(db, id, 'payment.pay', { paymentId, amount: centsToDecimalString(p.amount_cents), paidDate: input.paidDate, voucherNo: input.voucherNo ?? null });
  }).immediate();
  return getContractDetail(db, id);
}

/** 管理会计 contract_paid:组织(含下级)在期间内登记支付的金额(分)。 */
export function contractPaidInPeriod(db: DB, orgIds: number[] | null, period: string): bigint {
  const where = ["p.status = 'paid'", "substr(p.paid_date, 1, 7) = ?", "c.status <> 'voided'"];
  const params: unknown[] = [period];
  if (orgIds) { where.push(`c.org_id IN (${orgIds.map(() => '?').join(',') || 'NULL'})`); params.push(...orgIds); }
  return (db.prepare(`SELECT COALESCE(SUM(p.amount_cents), 0) AS s FROM ct_payment p JOIN ct_contract c ON c.id = p.contract_id WHERE ${where.join(' AND ')}`)
    .safeIntegers(true).get(...params) as { s: bigint }).s;
}

/** 管理会计 contract_payment_rate:截至期末,组织(含下级)有效合同 已付 / 当前金额。 */
export function contractPaymentTotals(db: DB, orgIds: number[] | null): { paid: bigint; current: bigint } {
  const where = ["status IN ('active','closed','terminated')"];
  const params: unknown[] = [];
  if (orgIds) { where.push(`org_id IN (${orgIds.map(() => '?').join(',') || 'NULL'})`); params.push(...orgIds); }
  return db.prepare(`SELECT COALESCE(SUM(paid_cents), 0) AS paid, COALESCE(SUM(original_cents + approved_change_cents), 0) AS current FROM ct_contract WHERE ${where.join(' AND ')}`)
    .safeIntegers(true).get(...params) as { paid: bigint; current: bigint };
}
