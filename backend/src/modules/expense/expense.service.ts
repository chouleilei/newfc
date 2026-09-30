/**
 * 费用审核(AC-F22)。规则见 specs/implementation.md T-4「费用审核」。
 *
 * - 报销单在本系统原生登记(不接 EAS 推送/回调)。草稿可改;提交后内容冻结(content_sha256),
 *   只有退回补件后才能追加附件,补件后重新提交生成新的审核运行与新的复核。
 * - 制度依据按条款维护:修改 = 发布新版本;规则阈值与材料要求来自条款,不写死。制度是集团口径,
 *   只有全组织范围的 expense:review 用户可以维护(受限用户 SCOPE_RESTRICTED)。
 * - 审核运行由后台任务执行(audit-run.ts),AI/规则结果只是“待复核”;结论只由人工复核给出。
 * - 人工复核:复核人 ≠ 提交人;pass/reject 须处置全部发现;高风险 pass 须填例外原因;
 *   supplement_required 至少一项标为缺失材料。复核记录不可改删,pass/reject 为终态。
 * - 组织范围按报销单 org_id;范围外 404。
 */
import { createHash } from 'node:crypto';
import path from 'node:path';
import type { DB } from '../../db/connection';
import { AppError } from '../../core/errors';
import { currentAuth } from '../../core/request-context';
import { centsToDecimalString, parseDecimalToCents } from '../../core/decimal';
import { writeLog } from '../audit/log';
import { assertDistinctReviewer } from '../security/review';
import { currentOrgScope, notVisible, orgInScope, requireCurrentAllOrgs, scopeFilterSql } from '../security/scope';
import { storeFile, type ObjectStore } from '../files/object-store';
import {
  CLAIM_STATUSES, type AuditRunDto, type ClaimAttachmentDto, type ClaimCreateRequest, type ClaimDetailDto, type ClaimDto, type ClaimLineDto,
  type ClaimListQuery, type ClaimReviewDto, type ClaimReviewRequest, type ClaimStatus, type ClaimUpdateRequest, type EvidenceRef, type ExpenseQueueDto,
  type FindingDto, type PolicyClauseDto, type PolicyCreateRequest, type PolicyDto, type RiskLevel,
} from '../../contracts/expense';

const nowIso = () => new Date().toISOString();
const conflict = (code: string, message: string, details?: unknown) => new AppError(code, message, 409, undefined, details);
const parseJson = <T>(text: string | null, fallback: T): T => {
  if (!text) return fallback;
  try { return JSON.parse(text) as T; } catch { return fallback; }
};
const userName = (db: DB, id: number | null): string | null =>
  id === null ? null : (db.prepare('SELECT display_name FROM app_user WHERE id = ?').get(id) as { display_name: string } | undefined)?.display_name ?? `#${id}`;

/** 费用类型/关键字比对口径:NFKC、去空白、小写。 */
export const normalizeText = (s: string) => s.normalize('NFKC').replace(/\s+/g, '').toLowerCase();

/* ================= 制度依据 ================= */

export interface ClauseRow {
  id: number; policy_id: number; clause_no: string; clause_text: string; expense_types: string[]; limit_cents: bigint | null; required_keywords: string[];
  policy_code: string; policy_version: number; policy_title: string;
}

interface PolicyRow {
  id: number; code: string; title: string; version: number; effective_from: string; effective_to: string | null; file_object_id: number | null;
  status: 'active' | 'retired'; created_at: string; updated_at: string;
}

function clauseRows(db: DB, policyIds: number[]): ClauseRow[] {
  if (policyIds.length === 0) return [];
  const rows = db.prepare(`SELECT c.*, p.code AS policy_code, p.version AS policy_version, p.title AS policy_title
      FROM ex_policy_clause c JOIN ex_policy p ON p.id = c.policy_id
      WHERE c.policy_id IN (${policyIds.map(() => '?').join(',')}) ORDER BY c.policy_id, c.sort_order, c.id`)
    .safeIntegers(true).all(...policyIds) as Record<string, unknown>[];
  return rows.map((r) => ({
    id: Number(r.id), policy_id: Number(r.policy_id), clause_no: String(r.clause_no), clause_text: String(r.clause_text),
    expense_types: parseJson<string[]>(r.expense_types_json as string, []), limit_cents: r.limit_cents === null ? null : BigInt(r.limit_cents as bigint),
    required_keywords: parseJson<string[]>(r.required_keywords_json as string, []), policy_code: String(r.policy_code),
    policy_version: Number(r.policy_version), policy_title: String(r.policy_title),
  }));
}

const clauseDto = (c: ClauseRow): PolicyClauseDto => ({
  id: c.id, clauseNo: c.clause_no, clauseText: c.clause_text, expenseTypes: c.expense_types,
  limit: c.limit_cents === null ? null : centsToDecimalString(c.limit_cents), requiredKeywords: c.required_keywords,
});

function policyDto(db: DB, p: PolicyRow): PolicyDto {
  return {
    id: p.id, code: p.code, title: p.title, version: p.version, effectiveFrom: p.effective_from, effectiveTo: p.effective_to, status: p.status,
    hasSource: p.file_object_id !== null, clauses: clauseRows(db, [p.id]).map(clauseDto), createdAt: p.created_at, updatedAt: p.updated_at,
  };
}

function readPolicy(db: DB, id: number): PolicyRow {
  const p = db.prepare('SELECT * FROM ex_policy WHERE id = ?').get(id) as PolicyRow | undefined;
  if (!p) throw notVisible('制度');
  return p;
}

export function listPolicies(db: DB, q: { includeRetired?: boolean } = {}): PolicyDto[] {
  const rows = db.prepare(`SELECT * FROM ex_policy ${q.includeRetired ? '' : "WHERE status = 'active'"} ORDER BY code, version DESC`).all() as PolicyRow[];
  return rows.map((p) => policyDto(db, p));
}

export function getPolicy(db: DB, id: number): PolicyDto {
  return policyDto(db, readPolicy(db, id));
}

/** 发布制度:同编码已存在时生成新版本(旧版本保留,按生效期与版本号取用)。 */
export function createPolicy(db: DB, input: PolicyCreateRequest): PolicyDto {
  requireCurrentAllOrgs('制度依据维护');
  const clauses = input.clauses.map((c, i) => ({
    ...c,
    limitCents: c.limit == null ? null : parseDecimalToCents(c.limit, { label: `条款 ${c.clauseNo} 金额上限` }),
    expenseTypes: [...new Set(c.expenseTypes.map((t) => t.trim()))],
    requiredKeywords: [...new Set(c.requiredKeywords.map((k) => k.trim()))],
    sortOrder: i,
  }));
  const id = db.transaction(() => {
    const now = nowIso();
    const max = (db.prepare('SELECT MAX(version) AS v FROM ex_policy WHERE code = ?').get(input.code) as { v: number | null }).v ?? 0;
    const pid = Number(db.prepare(`INSERT INTO ex_policy (code, title, version, effective_from, effective_to, status, created_by_user_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`).run(input.code, input.title, max + 1, input.effectiveFrom, input.effectiveTo ?? null, currentAuth()?.userId ?? null, now, now).lastInsertRowid);
    const ins = db.prepare(`INSERT INTO ex_policy_clause (policy_id, clause_no, clause_text, expense_types_json, limit_cents, required_keywords_json, sort_order)
      VALUES (?, ?, ?, ?, ?, ?, ?)`);
    for (const c of clauses) ins.run(pid, c.clauseNo, c.clauseText, JSON.stringify(c.expenseTypes), c.limitCents, JSON.stringify(c.requiredKeywords), c.sortOrder);
    writeLog(db, 'expense.policy.create', 'ex_policy', pid, {
      code: input.code, version: max + 1, effectiveFrom: input.effectiveFrom, effectiveTo: input.effectiveTo ?? null, clauseCount: clauses.length,
    });
    return pid;
  }).immediate();
  return getPolicy(db, id);
}

export function retirePolicy(db: DB, id: number, reason: string): PolicyDto {
  requireCurrentAllOrgs('制度依据维护');
  db.transaction(() => {
    const p = readPolicy(db, id);
    if (p.status === 'retired') throw conflict('POLICY_STATE', '该制度版本已停用');
    db.prepare("UPDATE ex_policy SET status = 'retired', updated_at = ? WHERE id = ?").run(nowIso(), id);
    writeLog(db, 'expense.policy.retire', 'ex_policy', id, { code: p.code, version: p.version, reason });
  }).immediate();
  return getPolicy(db, id);
}

export function attachPolicySource(db: DB, store: ObjectStore, id: number, content: Buffer, fileName: string): PolicyDto {
  requireCurrentAllOrgs('制度依据维护');
  readPolicy(db, id);
  const file = storeFile(db, store, content, { originalName: fileName, contentType: contentTypeFor(fileName) });
  db.transaction(() => {
    const p = readPolicy(db, id);
    db.prepare('UPDATE ex_policy SET file_object_id = ?, updated_at = ? WHERE id = ?').run(file.id, nowIso(), id);
    writeLog(db, 'expense.policy.source', 'ex_policy', id, { code: p.code, version: p.version, fileSha256: file.sha256, previousFileObjectId: p.file_object_id });
  }).immediate();
  return getPolicy(db, id);
}

export function policySourceContent(db: DB, store: ObjectStore, id: number): { fileName: string; contentType: string; content: Buffer } {
  const p = readPolicy(db, id);
  const f = p.file_object_id === null ? undefined
    : db.prepare('SELECT sha256, content_type, original_name FROM file_object WHERE id = ?').get(p.file_object_id) as { sha256: string; content_type: string; original_name: string } | undefined;
  if (!f) throw notVisible('制度原件');
  return { fileName: f.original_name, contentType: f.content_type, content: store.read(f.sha256) };
}

/**
 * 发生日期当时有效的条款:每个制度编码取覆盖该日期的最高有效版本(停用版本不参与)。
 */
export function effectiveClauses(db: DB, date: string): ClauseRow[] {
  const rows = db.prepare(`SELECT id, code, version FROM ex_policy
      WHERE status = 'active' AND effective_from <= ? AND (effective_to IS NULL OR effective_to >= ?) ORDER BY code, version DESC`)
    .all(date, date) as { id: number; code: string; version: number }[];
  const picked = new Map<string, number>();
  for (const r of rows) if (!picked.has(r.code)) picked.set(r.code, r.id);
  return clauseRows(db, [...picked.values()]);
}

/** 条款是否适用某费用类型:未限定费用类型的条款适用全部类型。 */
export function clauseApplies(c: ClauseRow, expenseType: string): boolean {
  if (c.expense_types.length === 0) return true;
  const t = normalizeText(expenseType);
  return c.expense_types.some((x) => normalizeText(x) === t);
}

/* ================= 报销单 ================= */

export interface ClaimRow {
  id: number; claim_no: string; org_id: number; applicant: string; department: string; expense_type: string; amount_cents: bigint; occurred_date: string;
  description: string; status: ClaimStatus; conclusion: 'pass' | 'reject' | null; review_version: number; content_sha256: string | null; submit_round: number;
  submitted_by_user_id: number | null; submitted_at: string | null; created_by_user_id: number | null; created_at: string; updated_at: string;
}
export interface LineRow { id: number; line_no: number; expense_type: string; amount_cents: bigint; invoice_no: string; invoice_date: string | null; description: string }
export interface AttachmentRow { id: number; file_object_id: number; file_sha256: string; name: string; kind_hint: string; submit_round: number; uploaded_at: string }

const num = (v: unknown) => (v === null || v === undefined ? null : Number(v));

function readClaim(db: DB, id: number): ClaimRow | undefined {
  const r = db.prepare('SELECT * FROM ex_claim WHERE id = ?').safeIntegers(true).get(id) as Record<string, unknown> | undefined;
  return r ? normalizeClaim(r) : undefined;
}
function normalizeClaim(r: Record<string, unknown>): ClaimRow {
  return {
    ...(r as unknown as ClaimRow), id: Number(r.id), org_id: Number(r.org_id), review_version: Number(r.review_version), submit_round: Number(r.submit_round),
    submitted_by_user_id: num(r.submitted_by_user_id), created_by_user_id: num(r.created_by_user_id), amount_cents: BigInt(r.amount_cents as bigint),
  };
}

/** 读取范围内报销单;不存在或范围外 404。 */
export function visibleClaim(db: DB, id: number): ClaimRow {
  const row = readClaim(db, id);
  if (!row || !orgInScope(currentOrgScope(db), row.org_id)) throw notVisible('报销单');
  return row;
}

export function claimLines(db: DB, claimId: number): LineRow[] {
  return (db.prepare('SELECT * FROM ex_claim_line WHERE claim_id = ? ORDER BY line_no').safeIntegers(true).all(claimId) as Record<string, unknown>[]).map((r) => ({
    id: Number(r.id), line_no: Number(r.line_no), expense_type: String(r.expense_type), amount_cents: BigInt(r.amount_cents as bigint),
    invoice_no: String(r.invoice_no), invoice_date: (r.invoice_date as string | null) ?? null, description: String(r.description),
  }));
}

export function claimAttachments(db: DB, claimId: number): AttachmentRow[] {
  return db.prepare('SELECT id, file_object_id, file_sha256, name, kind_hint, submit_round, uploaded_at FROM ex_attachment WHERE claim_id = ? ORDER BY id')
    .all(claimId) as AttachmentRow[];
}

function assertVersion(c: ClaimRow, expected: number): void {
  if (c.review_version !== expected) throw conflict('VERSION_CONFLICT', '报销单已被其他人修改,请刷新后重试', { currentReviewVersion: c.review_version });
}

const STATUS_TEXT: Record<ClaimStatus, string> = { draft: '草稿', submitted: '审核中', audited: '待复核', reviewed: '已复核', supplement: '退回补件' };
function assertStatus(c: ClaimRow, allowed: ClaimStatus[], what: string): void {
  if (!allowed.includes(c.status)) throw conflict('CLAIM_STATE', `报销单当前为「${STATUS_TEXT[c.status]}」,不能${what}`);
}

function assertOrg(db: DB, orgId: number): void {
  const exists = db.prepare('SELECT 1 FROM org WHERE id = ?').get(orgId);
  if (!exists || !orgInScope(currentOrgScope(db), orgId)) throw notVisible('组织');
}

/** 单据内容哈希:字段 + 明细 + 附件摘要。提交时冻结,审核运行与复核均绑定此哈希。 */
export function claimContentHash(c: ClaimRow, lines: LineRow[], attachments: AttachmentRow[]): string {
  const canonical = {
    claimNo: c.claim_no, orgId: c.org_id, applicant: c.applicant, department: c.department, expenseType: c.expense_type, amountCents: c.amount_cents.toString(),
    occurredDate: c.occurred_date, description: c.description,
    lines: lines.map((l) => [l.line_no, l.expense_type, l.amount_cents.toString(), l.invoice_no, l.invoice_date, l.description]),
    attachments: attachments.map((a) => [a.id, a.file_sha256, a.name, a.kind_hint]),
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

function parseClaimInput(input: Pick<ClaimCreateRequest, 'amount' | 'lines'>): { amountCents: bigint; lines: { expenseType: string; amountCents: bigint; invoiceNo: string; invoiceDate: string | null; description: string }[] } {
  return {
    amountCents: parseDecimalToCents(input.amount, { label: '报销金额' }),
    lines: input.lines.map((l, i) => ({
      expenseType: l.expenseType, amountCents: parseDecimalToCents(l.amount, { label: `明细 ${i + 1} 金额` }), invoiceNo: l.invoiceNo.trim(),
      invoiceDate: l.invoiceDate ?? null, description: l.description,
    })),
  };
}

function writeLines(db: DB, claimId: number, lines: ReturnType<typeof parseClaimInput>['lines']): void {
  db.prepare('DELETE FROM ex_claim_line WHERE claim_id = ?').run(claimId);
  const ins = db.prepare('INSERT INTO ex_claim_line (claim_id, line_no, expense_type, amount_cents, invoice_no, invoice_date, description) VALUES (?, ?, ?, ?, ?, ?, ?)');
  lines.forEach((l, i) => ins.run(claimId, i + 1, l.expenseType, l.amountCents, l.invoiceNo, l.invoiceDate, l.description));
}

function nextClaimNo(db: DB): string {
  const day = nowIso().slice(0, 10).replace(/-/g, '');
  const prefix = `BX${day}-`;
  const row = db.prepare('SELECT claim_no FROM ex_claim WHERE claim_no LIKE ? ORDER BY claim_no DESC LIMIT 1').get(`${prefix}%`) as { claim_no: string } | undefined;
  const seq = row ? Number(row.claim_no.slice(prefix.length)) + 1 : 1;
  return `${prefix}${String(Number.isFinite(seq) ? seq : 1).padStart(4, '0')}`;
}

export function createClaim(db: DB, input: ClaimCreateRequest): ClaimDetailDto {
  const parsed = parseClaimInput(input);
  const id = db.transaction(() => {
    assertOrg(db, input.orgId);
    const claimNo = input.claimNo?.trim() || nextClaimNo(db);
    if (db.prepare('SELECT 1 FROM ex_claim WHERE claim_no = ?').get(claimNo)) throw conflict('CLAIM_NO_DUPLICATE', `报销单号「${claimNo}」已存在`);
    const now = nowIso();
    const cid = Number(db.prepare(`INSERT INTO ex_claim (claim_no, org_id, applicant, department, expense_type, amount_cents, occurred_date, description,
        status, created_by_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, 'draft', ?, ?, ?)`)
      .run(claimNo, input.orgId, input.applicant, input.department, input.expenseType, parsed.amountCents, input.occurredDate, input.description,
        currentAuth()?.userId ?? null, now, now).lastInsertRowid);
    writeLines(db, cid, parsed.lines);
    writeLog(db, 'expense.claim.create', 'ex_claim', cid, { claimNo, orgId: input.orgId, amount: centsToDecimalString(parsed.amountCents), lineCount: parsed.lines.length });
    return cid;
  }).immediate();
  return getClaimDetail(db, id);
}

/** 草稿整单修改(字段 + 明细替换)。提交后内容冻结。 */
export function updateClaim(db: DB, id: number, input: ClaimUpdateRequest): ClaimDetailDto {
  const parsed = parseClaimInput(input);
  db.transaction(() => {
    const c = visibleClaim(db, id);
    assertStatus(c, ['draft'], '修改(提交后内容冻结)');
    assertVersion(c, input.expectedReviewVersion);
    assertOrg(db, input.orgId);
    db.prepare(`UPDATE ex_claim SET org_id = ?, applicant = ?, department = ?, expense_type = ?, amount_cents = ?, occurred_date = ?, description = ?,
        review_version = review_version + 1, updated_at = ? WHERE id = ?`)
      .run(input.orgId, input.applicant, input.department, input.expenseType, parsed.amountCents, input.occurredDate, input.description, nowIso(), id);
    writeLines(db, id, parsed.lines);
    writeLog(db, 'expense.claim.update', 'ex_claim', id, { claimNo: c.claim_no, orgId: input.orgId, amount: centsToDecimalString(parsed.amountCents), lineCount: parsed.lines.length });
  }).immediate();
  return getClaimDetail(db, id);
}

const CONTENT_TYPES: Record<string, string> = {
  '.pdf': 'application/pdf', '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.bmp': 'image/bmp', '.tif': 'image/tiff', '.tiff': 'image/tiff',
  '.webp': 'image/webp', '.txt': 'text/plain; charset=utf-8', '.xlsx': 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  '.docx': 'application/vnd.openxmlformats-officedocument.wordprocessingml.document', '.ofd': 'application/ofd',
};
export const ATTACHMENT_EXTENSIONS = Object.keys(CONTENT_TYPES);
export function contentTypeFor(fileName: string): string {
  return CONTENT_TYPES[path.extname(fileName).toLowerCase()] ?? 'application/octet-stream';
}

/** 附件:草稿阶段或退回补件后追加;归属下一次提交轮次。 */
export function addClaimAttachment(db: DB, store: ObjectStore, id: number, content: Buffer, fileName: string, kindHint?: string, name?: string): ClaimAttachmentDto {
  const c = visibleClaim(db, id);
  assertStatus(c, ['draft', 'supplement'], '追加附件');
  const file = storeFile(db, store, content, { originalName: fileName, contentType: contentTypeFor(fileName) });
  const attId = db.transaction(() => {
    const fresh = visibleClaim(db, id);
    assertStatus(fresh, ['draft', 'supplement'], '追加附件');
    const aid = Number(db.prepare(`INSERT INTO ex_attachment (claim_id, file_object_id, file_sha256, name, kind_hint, submit_round, uploaded_by_user_id, uploaded_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, file.id, file.sha256, (name || fileName).slice(0, 200), kindHint ?? '', fresh.submit_round + 1, currentAuth()?.userId ?? null, nowIso()).lastInsertRowid);
    db.prepare('UPDATE ex_claim SET review_version = review_version + 1, updated_at = ? WHERE id = ?').run(nowIso(), id);
    writeLog(db, 'expense.claim.attachment', 'ex_claim', id, { claimNo: fresh.claim_no, attachmentId: aid, fileSha256: file.sha256, submitRound: fresh.submit_round + 1 });
    return aid;
  }).immediate();
  return attachmentDto(claimAttachments(db, id).find((a) => a.id === attId)!);
}

/** 只能移除本轮(尚未提交)追加的附件;已提交轮次的附件随审核运行留痕。 */
export function removeClaimAttachment(db: DB, id: number, attachmentId: number): ClaimDetailDto {
  db.transaction(() => {
    const c = visibleClaim(db, id);
    assertStatus(c, ['draft', 'supplement'], '移除附件');
    const a = db.prepare('SELECT id, submit_round, file_sha256 FROM ex_attachment WHERE id = ? AND claim_id = ?').get(attachmentId, id) as { id: number; submit_round: number; file_sha256: string } | undefined;
    if (!a) throw notVisible('报销附件');
    if (a.submit_round !== c.submit_round + 1) throw conflict('CLAIM_STATE', '已提交轮次的附件不能移除');
    db.prepare('DELETE FROM ex_attachment WHERE id = ?').run(attachmentId);
    db.prepare('UPDATE ex_claim SET review_version = review_version + 1, updated_at = ? WHERE id = ?').run(nowIso(), id);
    writeLog(db, 'expense.claim.attachment_remove', 'ex_claim', id, { claimNo: c.claim_no, attachmentId, fileSha256: a.file_sha256 });
  }).immediate();
  return getClaimDetail(db, id);
}

export function claimAttachmentContent(db: DB, store: ObjectStore, id: number, attachmentId: number): { fileName: string; contentType: string; content: Buffer } {
  visibleClaim(db, id);
  const a = db.prepare('SELECT a.name, a.file_sha256, f.content_type FROM ex_attachment a JOIN file_object f ON f.id = a.file_object_id WHERE a.id = ? AND a.claim_id = ?')
    .get(attachmentId, id) as { name: string; file_sha256: string; content_type: string } | undefined;
  if (!a) throw notVisible('报销附件');
  return { fileName: a.name, contentType: a.content_type, content: store.read(a.file_sha256) };
}

/**
 * 提交(或补件后重新提交):冻结内容哈希,轮次 +1,状态进入“审核中”。
 * 审核运行由调用方在事务外以后台任务启动(见 audit-run.ts startClaimAudit)。
 */
export function submitClaim(db: DB, id: number, expectedReviewVersion: number): ClaimRow {
  db.transaction(() => {
    const c = visibleClaim(db, id);
    assertStatus(c, ['draft', 'supplement'], '提交');
    assertVersion(c, expectedReviewVersion);
    const lines = claimLines(db, id);
    const attachments = claimAttachments(db, id);
    if (c.status === 'supplement' && !attachments.some((a) => a.submit_round === c.submit_round + 1)) {
      throw new AppError('VALIDATION_FAILED', '退回补件后须至少追加一个附件再重新提交', 400);
    }
    const sha = claimContentHash(c, lines, attachments);
    const now = nowIso();
    db.prepare(`UPDATE ex_claim SET status = 'submitted', conclusion = NULL, content_sha256 = ?, submit_round = submit_round + 1, review_version = review_version + 1,
        submitted_by_user_id = ?, submitted_at = ?, updated_at = ? WHERE id = ?`).run(sha, currentAuth()?.userId ?? null, now, now, id);
    writeLog(db, 'expense.claim.submit', 'ex_claim', id, { claimNo: c.claim_no, contentSha256: sha, submitRound: c.submit_round + 1, resubmit: c.status === 'supplement' });
  }).immediate();
  return visibleClaim(db, id);
}

/* ================= 人工复核 ================= */

interface RunRow {
  id: number; claim_id: number; review_version: number; content_sha256: string; job_id: number | null; risk_level: RiskLevel;
  ocr_status: AuditRunDto['ocrStatus']; model_status: AuditRunDto['modelStatus']; policy_refs_json: string; created_at: string;
}

export function latestRun(db: DB, claimId: number): RunRow | undefined {
  return db.prepare('SELECT * FROM ex_audit_run WHERE claim_id = ? ORDER BY id DESC LIMIT 1').get(claimId) as RunRow | undefined;
}

export function reviewClaim(db: DB, id: number, input: ClaimReviewRequest): ClaimDetailDto {
  const auth = currentAuth();
  db.transaction(() => {
    const c = visibleClaim(db, id);
    assertStatus(c, ['audited'], '复核');
    assertVersion(c, input.expectedReviewVersion);
    const run = latestRun(db, id);
    if (!run || run.id !== input.runId || run.review_version !== c.review_version || run.content_sha256 !== c.content_sha256) {
      throw conflict('EXPENSE_RUN_STALE', '复核须基于当前内容的最新审核运行,请刷新后重试', { currentRunId: run?.id ?? null });
    }
    const { selfReview } = assertDistinctReviewer(db, auth, c.submitted_by_user_id, input.exceptionReason, '报销复核');
    const findings = db.prepare('SELECT id, severity FROM ex_finding WHERE run_id = ? ORDER BY id').all(run.id) as { id: number; severity: string }[];
    const known = new Set(findings.map((f) => f.id));
    const seen = new Set<number>();
    for (const d of input.dispositions) {
      if (!known.has(d.findingId)) throw new AppError('VALIDATION_FAILED', `发现 #${d.findingId} 不属于该审核运行`, 400);
      if (seen.has(d.findingId)) throw new AppError('VALIDATION_FAILED', `发现 #${d.findingId} 重复处置`, 400);
      seen.add(d.findingId);
    }
    const missingMaterial = input.dispositions.some((d) => d.disposition === 'missing_material');
    if (input.conclusion === 'supplement_required') {
      if (!missingMaterial) throw new AppError('EXPENSE_REVIEW_INCOMPLETE', '退回补件至少要把一项发现标为“缺失材料”', 422);
    } else {
      const undisposed = findings.filter((f) => !seen.has(f.id)).map((f) => f.id);
      if (undisposed.length > 0) {
        throw new AppError('EXPENSE_REVIEW_INCOMPLETE', `还有 ${undisposed.length} 项发现未处置,通过或驳回前须逐项处置`, 422, undefined, { undisposedFindingIds: undisposed });
      }
      if (input.conclusion === 'pass' && missingMaterial) throw new AppError('VALIDATION_FAILED', '存在标为“缺失材料”的发现时不能通过,请退回补件', 400);
      if (input.conclusion === 'pass' && run.risk_level === 'high' && !input.exceptionReason?.trim()) {
        throw new AppError('EXPENSE_EXCEPTION_REQUIRED', '高风险报销通过必须填写例外原因', 422);
      }
    }
    const now = nowIso();
    const rid = Number(db.prepare(`INSERT INTO ex_review (claim_id, run_id, review_version, conclusion, dispositions_json, comment, exception_reason, self_review, reviewer_user_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, run.id, c.review_version, input.conclusion, JSON.stringify(input.dispositions), input.comment ?? '', input.exceptionReason?.trim() || null,
        selfReview ? 1 : 0, auth?.userId ?? null, now).lastInsertRowid);
    if (input.conclusion === 'supplement_required') {
      db.prepare("UPDATE ex_claim SET status = 'supplement', review_version = review_version + 1, updated_at = ? WHERE id = ?").run(now, id);
    } else {
      db.prepare("UPDATE ex_claim SET status = 'reviewed', conclusion = ?, review_version = review_version + 1, updated_at = ? WHERE id = ?").run(input.conclusion, now, id);
    }
    writeLog(db, 'expense.claim.review', 'ex_claim', id, {
      claimNo: c.claim_no, reviewId: rid, runId: run.id, riskLevel: run.risk_level, conclusion: input.conclusion, dispositionCount: input.dispositions.length,
      selfReview, exceptionReason: input.exceptionReason?.trim() || null,
    });
  }).immediate();
  return getClaimDetail(db, id);
}

/* ================= 查询 ================= */

function findingDtos(db: DB, runId: number): FindingDto[] {
  const rows = db.prepare(`SELECT f.*, c.clause_no, p.code AS policy_code, p.version AS policy_version FROM ex_finding f
      LEFT JOIN ex_policy_clause c ON c.id = f.clause_id LEFT JOIN ex_policy p ON p.id = c.policy_id WHERE f.run_id = ? ORDER BY f.id`).all(runId) as
    { id: number; source: FindingDto['source']; code: string; severity: FindingDto['severity']; message: string; evidence_json: string; clause_id: number | null;
      clause_no: string | null; policy_code: string | null; policy_version: number | null }[];
  return rows.map((r) => ({
    id: r.id, source: r.source, code: r.code, severity: r.severity, message: r.message, evidence: parseJson<EvidenceRef[]>(r.evidence_json, []),
    clauseId: r.clause_id, clauseLabel: r.clause_id === null ? null : `${r.policy_code} v${r.policy_version} 第 ${r.clause_no} 条`,
  }));
}

function runDto(db: DB, r: RunRow): AuditRunDto {
  return {
    id: r.id, reviewVersion: r.review_version, contentSha256: r.content_sha256, jobId: r.job_id, riskLevel: r.risk_level, ocrStatus: r.ocr_status,
    modelStatus: r.model_status, policyRefs: parseJson(r.policy_refs_json, []), findings: findingDtos(db, r.id), createdAt: r.created_at,
  };
}

const lineDto = (l: LineRow): ClaimLineDto => ({
  id: l.id, lineNo: l.line_no, expenseType: l.expense_type, amount: centsToDecimalString(l.amount_cents), invoiceNo: l.invoice_no, invoiceDate: l.invoice_date,
  description: l.description,
});
const attachmentDto = (a: AttachmentRow): ClaimAttachmentDto => ({
  id: a.id, name: a.name, kindHint: a.kind_hint, sha256: a.file_sha256, submitRound: a.submit_round, uploadedAt: a.uploaded_at,
});

function claimDto(db: DB, c: ClaimRow): ClaimDto {
  const org = db.prepare('SELECT name FROM org WHERE id = ?').get(c.org_id) as { name: string } | undefined;
  const run = latestRun(db, c.id);
  return {
    id: c.id, claimNo: c.claim_no, orgId: c.org_id, orgName: org?.name ?? `#${c.org_id}`, applicant: c.applicant, department: c.department,
    expenseType: c.expense_type, amount: centsToDecimalString(c.amount_cents), occurredDate: c.occurred_date, description: c.description, status: c.status,
    conclusion: c.conclusion, reviewVersion: c.review_version, submitRound: c.submit_round, contentSha256: c.content_sha256,
    submittedByName: userName(db, c.submitted_by_user_id), submittedAt: c.submitted_at, latestRiskLevel: run?.risk_level ?? null, createdAt: c.created_at, updatedAt: c.updated_at,
  };
}

export function getClaimDetail(db: DB, id: number): ClaimDetailDto {
  const c = visibleClaim(db, id);
  const runs = db.prepare('SELECT * FROM ex_audit_run WHERE claim_id = ? ORDER BY id DESC').all(id) as RunRow[];
  const reviews = db.prepare('SELECT * FROM ex_review WHERE claim_id = ? ORDER BY id DESC').all(id) as
    { id: number; run_id: number; review_version: number; conclusion: ClaimReviewDto['conclusion']; dispositions_json: string; comment: string; exception_reason: string | null;
      self_review: number; reviewer_user_id: number | null; created_at: string }[];
  const latest = runs[0];
  return {
    ...claimDto(db, c),
    lines: claimLines(db, id).map(lineDto),
    attachments: claimAttachments(db, id).map(attachmentDto),
    runs: runs.map((r) => runDto(db, r)),
    reviews: reviews.map((r) => ({
      id: r.id, runId: r.run_id, reviewVersion: r.review_version, conclusion: r.conclusion, dispositions: parseJson(r.dispositions_json, []), comment: r.comment,
      exceptionReason: r.exception_reason, selfReview: r.self_review === 1, reviewerName: userName(db, r.reviewer_user_id), createdAt: r.created_at,
    })),
    currentRunId: latest && latest.review_version === c.review_version && latest.content_sha256 === c.content_sha256 ? latest.id : null,
  };
}

export function listClaims(db: DB, q: ClaimListQuery = {}): ClaimDto[] {
  const scope = scopeFilterSql(currentOrgScope(db), 'org_id');
  const where = [scope.sql];
  const params: unknown[] = [...scope.params];
  if (q.status) { where.push('status = ?'); params.push(q.status); }
  if (q.orgId) { where.push('org_id = ?'); params.push(q.orgId); }
  if (q.keyword) { where.push('(claim_no LIKE ? OR applicant LIKE ? OR description LIKE ?)'); const k = `%${q.keyword}%`; params.push(k, k, k); }
  const rows = db.prepare(`SELECT * FROM ex_claim WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT 500`).safeIntegers(true).all(...params) as Record<string, unknown>[];
  return rows.map((r) => claimDto(db, normalizeClaim(r)));
}

/** 待办队列:按状态计数与待复核列表(工作台、助手 expense_audit_queue 共用)。 */
export function expenseQueue(db: DB, q: { orgId?: number } = {}): ExpenseQueueDto {
  const scope = scopeFilterSql(currentOrgScope(db), 'c.org_id');
  const where = [scope.sql];
  const params: unknown[] = [...scope.params];
  if (q.orgId) { where.push('c.org_id = ?'); params.push(q.orgId); }
  const counts = Object.fromEntries(CLAIM_STATUSES.map((s) => [s, 0])) as Record<ClaimStatus, number>;
  for (const r of db.prepare(`SELECT c.status, COUNT(*) AS n FROM ex_claim c WHERE ${where.join(' AND ')} GROUP BY c.status`).all(...params) as { status: ClaimStatus; n: number }[]) {
    counts[r.status] = r.n;
  }
  const rows = db.prepare(`SELECT c.id, c.claim_no, o.name AS org_name, c.applicant, c.amount_cents, c.submitted_at,
        (SELECT risk_level FROM ex_audit_run r WHERE r.claim_id = c.id ORDER BY r.id DESC LIMIT 1) AS risk_level
      FROM ex_claim c JOIN org o ON o.id = c.org_id WHERE ${where.join(' AND ')} AND c.status = 'audited' ORDER BY c.submitted_at, c.id LIMIT 200`)
    .safeIntegers(true).all(...params) as { id: bigint; claim_no: string; org_name: string; applicant: string; amount_cents: bigint; submitted_at: string | null; risk_level: RiskLevel | null }[];
  return {
    counts,
    awaitingReview: rows.map((r) => ({
      id: Number(r.id), claimNo: r.claim_no, orgName: r.org_name, applicant: r.applicant, amount: centsToDecimalString(r.amount_cents), riskLevel: r.risk_level,
      submittedAt: r.submitted_at,
    })),
  };
}
