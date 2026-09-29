/**
 * 数据治理(AC-F06):扫描来源事实生成质量问题 → 处置 → 复核 → 生效证明。规则见 specs/implementation.md T-3「数据治理」。
 *
 * - 来源:EAS 最新预检中失败的规则(eas_recon)、当前生效凭证里无法解析的项目编码/供应商(eas_master)、
 *   财报校验警告(statement,见 governance.sources.ts)。
 * - 问题按 issue_key 去重;已解决的问题再次出现时重新打开,误报只在来源事实变化后重新打开。
 * - 治理从不改写原始事实;source_hash 是问题所依据事实的快照,提交、复核和重验时重算,不一致即 GOVERNANCE_FACT_MUTATED。
 * - 组织范围按 org_id 裁剪,范围外 404。
 */
import type { DB } from '../../db/connection';
import { AppError, Errors } from '../../core/errors';
import { currentAuth } from '../../core/request-context';
import { writeLog } from '../audit/log';
import { resolveEntity, upsertMapping } from '../master/master.service';
import { notVisible, orgInScope, requireCurrentAllOrgs, resolveOrgScope, type OrgScope } from '../security/scope';
import { assertDistinctReviewer } from '../security/review';
import { EAS_SOURCE_SYSTEM } from '../eas/eas.service';
import type {
  GovDispositionCreate, GovDispositionDto, GovIssueDto, GovIssueStatus, GovReviewRequest, GovScanRequest, GovScanResultDto,
  GovSourceType, GovVerifyDto,
} from '../../contracts/governance';
import { collectCandidates, hashOfSource, sha256Json, type IssueCandidate } from './governance.sources';

const nowIso = () => new Date().toISOString();

function scope(db: DB): OrgScope {
  const auth = currentAuth();
  return auth ? resolveOrgScope(db, auth) : { all: true };
}

function conflict(code: string, message: string, details?: unknown): AppError {
  return new AppError(code, message, 409, undefined, details);
}

interface IssueRow {
  id: number; issue_key: string; source_type: GovSourceType; problem_type: string; source_ref: string; org_id: number | null; period: string;
  severity: 'error' | 'warning'; title: string; detail_json: string; source_hash: string; status: GovIssueStatus; reopen_count: number;
  version: number; first_seen_at: string; last_seen_at: string; closed_at: string | null;
}
interface DispositionRow {
  id: number; issue_id: number; kind: GovDispositionDto['kind']; payload_json: string; reason: string; status: GovDispositionDto['status'];
  source_hash_before: string; submitted_by_user_id: number | null; submitted_at: string;
}

function visible(db: DB, orgId: number | null): boolean {
  const s = scope(db);
  return s.all || (orgId !== null && orgInScope(s, orgId));
}

function orgName(db: DB, orgId: number | null): string | null {
  if (orgId === null) return null;
  return (db.prepare('SELECT name FROM org WHERE id = ?').get(orgId) as { name: string } | undefined)?.name ?? null;
}

function dispositionDto(db: DB, d: DispositionRow): GovDispositionDto {
  const review = db.prepare(`SELECT action, comment, exception_reason AS exceptionReason, reviewer_user_id AS reviewerUserId, created_at AS createdAt
    FROM gov_review WHERE disposition_id = ?`).get(d.id) as GovDispositionDto['review'] | undefined;
  const proof = db.prepare('SELECT before_hash, after_hash, verified, detail_json, created_at FROM gov_effect_proof WHERE disposition_id = ?').get(d.id) as
    { before_hash: string; after_hash: string; verified: number; detail_json: string; created_at: string } | undefined;
  return {
    id: d.id, kind: d.kind, payload: JSON.parse(d.payload_json) as Record<string, unknown>, reason: d.reason, status: d.status,
    sourceHashBefore: d.source_hash_before, submittedByUserId: d.submitted_by_user_id, submittedAt: d.submitted_at, review: review ?? null,
    proof: proof ? { beforeHash: proof.before_hash, afterHash: proof.after_hash, verified: proof.verified === 1, detail: JSON.parse(proof.detail_json) as Record<string, unknown>, createdAt: proof.created_at } : null,
  };
}

function issueDto(db: DB, r: IssueRow, withDispositions = false): GovIssueDto {
  const dto: GovIssueDto = {
    id: r.id, sourceType: r.source_type, problemType: r.problem_type, sourceRef: r.source_ref, orgId: r.org_id, orgName: orgName(db, r.org_id),
    period: r.period, severity: r.severity, title: r.title, detail: JSON.parse(r.detail_json) as Record<string, unknown>, sourceHash: r.source_hash,
    status: r.status, reopenCount: r.reopen_count, version: r.version, firstSeenAt: r.first_seen_at, lastSeenAt: r.last_seen_at, closedAt: r.closed_at,
  };
  if (withDispositions) {
    dto.dispositions = (db.prepare('SELECT * FROM gov_disposition WHERE issue_id = ? ORDER BY id').all(r.id) as DispositionRow[]).map((d) => dispositionDto(db, d));
  }
  return dto;
}

function getIssueRow(db: DB, id: number): IssueRow {
  const row = db.prepare('SELECT * FROM gov_issue WHERE id = ?').get(id) as IssueRow | undefined;
  if (!row || !visible(db, row.org_id)) throw notVisible('质量问题');
  return row;
}

/** 重算问题来源事实的哈希;与登记值不一致说明原始事实被改动(治理不应发生)。 */
function assertSourceUnchanged(db: DB, issue: IssueRow, expected: string): void {
  const actual = hashOfSource(db, issue.source_ref);
  if (actual !== expected) {
    throw conflict('GOVERNANCE_FACT_MUTATED', '问题所依据的原始事实已变化,不能继续处置;请重新扫描后核对', { sourceRef: issue.source_ref });
  }
}

/* ================= 扫描 ================= */

export function scanIssues(db: DB, input: GovScanRequest): GovScanResultDto {
  const s = scope(db);
  if (input.orgId && !orgInScope(s, input.orgId)) throw notVisible('组织');
  const result = db.transaction((): GovScanResultDto => {
    const candidates = collectCandidates(db, s, input);
    const now = nowIso();
    const counts = { created: 0, updated: 0, reopened: 0, unchanged: 0 };
    for (const c of candidates) upsertCandidate(db, c, now, counts);
    writeLog(db, 'governance.scan', 'gov_issue', input.orgId ?? 'scope', { ...input, ...counts });
    return { ...counts, scannedAt: now };
  }).immediate();
  return result;
}

function upsertCandidate(db: DB, c: IssueCandidate, now: string, counts: Record<'created' | 'updated' | 'reopened' | 'unchanged', number>): void {
  const existing = db.prepare('SELECT * FROM gov_issue WHERE issue_key = ?').get(c.issueKey) as IssueRow | undefined;
  const detail = JSON.stringify(c.detail);
  if (!existing) {
    db.prepare(`INSERT INTO gov_issue (issue_key, source_type, problem_type, source_ref, org_id, period, severity, title, detail_json, source_hash,
      status, first_seen_at, last_seen_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'open', ?, ?)`).run(
      c.issueKey, c.sourceType, c.problemType, c.sourceRef, c.orgId, c.period, c.severity, c.title, detail, c.sourceHash, now, now);
    counts.created++;
    return;
  }
  const changed = existing.source_hash !== c.sourceHash || existing.source_ref !== c.sourceRef;
  const reopen = existing.status === 'resolved' || (existing.status === 'dismissed' && changed);
  if (reopen) {
    db.prepare(`UPDATE gov_issue SET status = 'open', source_ref = ?, source_hash = ?, title = ?, detail_json = ?, severity = ?, last_seen_at = ?,
      closed_at = NULL, reopen_count = reopen_count + 1, version = version + 1 WHERE id = ?`).run(c.sourceRef, c.sourceHash, c.title, detail, c.severity, now, existing.id);
    counts.reopened++;
  } else if (existing.status === 'open' && changed) {
    db.prepare('UPDATE gov_issue SET source_ref = ?, source_hash = ?, title = ?, detail_json = ?, severity = ?, last_seen_at = ?, version = version + 1 WHERE id = ?')
      .run(c.sourceRef, c.sourceHash, c.title, detail, c.severity, now, existing.id);
    counts.updated++;
  } else {
    // 待复核的问题不换来源引用,保证复核看到的是提交时的事实
    db.prepare('UPDATE gov_issue SET last_seen_at = ? WHERE id = ?').run(now, existing.id);
    counts.unchanged++;
  }
}

/* ================= 查询 ================= */

export function listIssues(db: DB, q: { status?: string; sourceType?: string; orgId?: number; period?: string } = {}): GovIssueDto[] {
  const s = scope(db);
  const where: string[] = [];
  const params: unknown[] = [];
  if (!s.all) {
    if (s.orgIds.size === 0) return [];
    where.push(`org_id IN (${[...s.orgIds].map(() => '?').join(',')})`);
    params.push(...s.orgIds);
  }
  if (q.status) { where.push('status = ?'); params.push(q.status); }
  if (q.sourceType) { where.push('source_type = ?'); params.push(q.sourceType); }
  if (q.orgId) { where.push('org_id = ?'); params.push(q.orgId); }
  if (q.period) { where.push('period = ?'); params.push(q.period); }
  const rows = db.prepare(`SELECT * FROM gov_issue ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY CASE status WHEN 'open' THEN 0 WHEN 'pending_review' THEN 1 ELSE 2 END, severity, id DESC LIMIT 500`).all(...params) as IssueRow[];
  return rows.map((r) => issueDto(db, r));
}

export function getIssue(db: DB, id: number): GovIssueDto {
  return issueDto(db, getIssueRow(db, id), true);
}

export function verifyIssue(db: DB, id: number): GovVerifyDto {
  const issue = getIssueRow(db, id);
  assertSourceUnchanged(db, issue, issue.source_hash);
  return { issueId: issue.id, sourceHash: issue.source_hash, unchanged: true, checkedAt: nowIso() };
}

/* ================= 处置 ================= */

function mappingTarget(db: DB, issue: IssueRow, targetId: number) {
  const detail = JSON.parse(issue.detail_json) as { entity?: 'project' | 'supplier'; value?: string };
  if (issue.source_type !== 'eas_master' || !detail.entity || !detail.value) throw Errors.validation('只有“主数据无法解析”类问题可以用映射覆盖处置');
  // 映射是全局主数据,与主数据映射接口一致只对全组织用户开放
  requireCurrentAllOrgs('映射覆盖');
  const table = detail.entity === 'project' ? 'md_project' : 'md_supplier';
  const target = db.prepare(`SELECT id, code, name, status${detail.entity === 'project' ? ', org_id' : ''} FROM ${table} WHERE id = ?`).get(targetId) as
    { id: number; code: string; name: string; status: string; org_id?: number } | undefined;
  if (!target || (target.org_id !== undefined && !orgInScope(scope(db), target.org_id))) throw notVisible('映射目标');
  if (target.status !== 'active') throw Errors.validation('映射目标已停用');
  return {
    entityType: detail.entity, matchKind: detail.entity === 'project' ? 'code' : 'name', sourceKey: detail.value,
    targetId: target.id, targetCode: target.code, targetName: target.name,
  };
}

function reimportTarget(db: DB, issue: IssueRow, setId: number) {
  if (issue.source_type !== 'eas_recon') throw Errors.validation('只有 EAS 预检类问题可以用重新导入处置');
  const set = db.prepare('SELECT id, org_id, period, status, is_current FROM eas_recon_set WHERE id = ?').get(setId) as
    { id: number; org_id: number; period: string; status: string; is_current: number } | undefined;
  if (!set || set.org_id !== issue.org_id || set.period !== issue.period) throw notVisible('对账集合');
  const detail = JSON.parse(issue.detail_json) as { setId?: number; ruleCode?: string };
  if (!set.is_current || set.status !== 'passed' || set.id <= (detail.setId ?? 0)) {
    throw conflict('GOVERNANCE_REIMPORT_INVALID', '重新导入必须关联问题出现之后新激活、且对账通过的集合');
  }
  return { setId: set.id, ruleCode: detail.ruleCode };
}

export function submitDisposition(db: DB, issueId: number, input: GovDispositionCreate): GovIssueDto {
  const row = db.transaction(() => {
    const issue = getIssueRow(db, issueId);
    if (issue.version !== input.expectedVersion) throw conflict('VERSION_CONFLICT', '问题已被其他人更新,请刷新后重试', { currentVersion: issue.version });
    if (issue.status !== 'open') throw conflict('GOVERNANCE_ISSUE_STATE', '只有待处理的问题可以提交处置');
    assertSourceUnchanged(db, issue, issue.source_hash);
    const payload = input.kind === 'mapping_override' ? mappingTarget(db, issue, input.targetId)
      : input.kind === 'reimport' ? reimportTarget(db, issue, input.setId) : {};
    const auth = currentAuth();
    const id = Number(db.prepare(`INSERT INTO gov_disposition (issue_id, kind, payload_json, reason, status, source_hash_before, submitted_by_user_id, submitted_at)
      VALUES (?, ?, ?, ?, 'pending_review', ?, ?, ?)`).run(issue.id, input.kind, JSON.stringify(payload), input.reason, issue.source_hash, auth?.userId ?? null, nowIso()).lastInsertRowid);
    db.prepare("UPDATE gov_issue SET status = 'pending_review', version = version + 1 WHERE id = ?").run(issue.id);
    writeLog(db, 'governance.disposition_submit', 'gov_disposition', id, { issueId: issue.id, kind: input.kind, payload, reason: input.reason });
    return db.prepare('SELECT * FROM gov_issue WHERE id = ?').get(issue.id) as IssueRow;
  }).immediate();
  return issueDto(db, row, true);
}

export function reviewDisposition(db: DB, dispositionId: number, input: GovReviewRequest): GovIssueDto {
  const row = db.transaction(() => {
    const d = db.prepare('SELECT * FROM gov_disposition WHERE id = ?').get(dispositionId) as DispositionRow | undefined;
    if (!d) throw notVisible('处置');
    const issue = getIssueRow(db, d.issue_id);
    if (d.status !== 'pending_review') throw conflict('GOVERNANCE_ALREADY_REVIEWED', '该处置已复核,同一处置只能复核一次');
    const auth = currentAuth();
    const { selfReview } = assertDistinctReviewer(db, auth, d.submitted_by_user_id, input.exceptionReason, '治理处置');
    assertSourceUnchanged(db, issue, d.source_hash_before);
    const now = nowIso();
    db.prepare('INSERT INTO gov_review (disposition_id, action, comment, exception_reason, reviewer_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(d.id, input.action, input.comment ?? null, input.exceptionReason ?? null, auth?.userId ?? null, now);
    if (input.action === 'return') {
      db.prepare("UPDATE gov_disposition SET status = 'returned' WHERE id = ?").run(d.id);
      db.prepare("UPDATE gov_issue SET status = 'open', version = version + 1 WHERE id = ?").run(issue.id);
    } else {
      const proof = applyEffect(db, issue, d);
      db.prepare('INSERT INTO gov_effect_proof (disposition_id, before_hash, after_hash, verified, detail_json, created_at) VALUES (?, ?, ?, ?, ?, ?)')
        .run(d.id, d.source_hash_before, proof.afterHash, proof.verified ? 1 : 0, JSON.stringify(proof.detail), now);
      db.prepare("UPDATE gov_disposition SET status = 'approved' WHERE id = ?").run(d.id);
      db.prepare('UPDATE gov_issue SET status = ?, closed_at = ?, version = version + 1 WHERE id = ?')
        .run(d.kind === 'false_positive' ? 'dismissed' : 'resolved', now, issue.id);
    }
    writeLog(db, 'governance.review', 'gov_disposition', d.id, {
      issueId: issue.id, action: input.action, kind: d.kind, selfReview, exceptionReason: selfReview ? input.exceptionReason : undefined,
    });
    return db.prepare('SELECT * FROM gov_issue WHERE id = ?').get(issue.id) as IssueRow;
  }).immediate();
  return issueDto(db, row, true);
}

/** 批准处置的生效动作与证明。映射覆盖经主数据 service(退役旧行 + 新增行);重新导入只核对新集合仍为当前且通过。 */
function applyEffect(db: DB, issue: IssueRow, d: DispositionRow): { afterHash: string; verified: boolean; detail: Record<string, unknown> } {
  const payload = JSON.parse(d.payload_json) as Record<string, unknown>;
  if (d.kind === 'false_positive') return { afterHash: d.source_hash_before, verified: true, detail: { effect: 'none' } };
  if (d.kind === 'mapping_override') {
    const mapping = upsertMapping(db, {
      sourceSystem: EAS_SOURCE_SYSTEM, entityType: payload.entityType, matchKind: payload.matchKind, sourceKey: payload.sourceKey,
      targetId: payload.targetId, note: `数据治理处置 #${d.id}`,
    });
    const input = payload.matchKind === 'code' ? { code: String(payload.sourceKey) } : { name: String(payload.sourceKey) };
    const resolved = resolveEntity(db, payload.entityType as 'project' | 'supplier', { ...input, sourceSystem: EAS_SOURCE_SYSTEM });
    const after = { matchedBy: resolved.matchedBy, targetId: resolved.targetId };
    return { afterHash: sha256Json(after), verified: resolved.targetId === payload.targetId, detail: { mappingId: mapping.id, ...after } };
  }
  const set = db.prepare('SELECT id, status, is_current FROM eas_recon_set WHERE id = ?').get(payload.setId) as { id: number; status: string; is_current: number } | undefined;
  if (!set || !set.is_current || set.status !== 'passed') throw conflict('EAS_CURRENT_SET_CHANGED', '关联的集合已不是当前生效集合,请重新提交处置');
  const result = db.prepare('SELECT id, status FROM eas_recon_result WHERE set_id = ? AND rule_code = ?').get(set.id, payload.ruleCode) as { id: number; status: string } | undefined;
  const afterRef = result ? `eas_recon_result:${result.id}` : `eas_recon_set:${set.id}`;
  return { afterHash: hashOfSource(db, afterRef), verified: !result || result.status !== 'failed', detail: { setId: set.id, afterRef, ruleStatus: result?.status ?? null } };
}
