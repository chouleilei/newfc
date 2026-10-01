/**
 * 分析报告(T-5,AC-F18)。
 *
 * - 生成:沿用助手确定性组稿(执行月报/年度复盘/预算讨论材料,同一授权)并新增“风险与投资专题”;模型只改写叙述,
 *   在事务外调用,失败或改动事实时保留模板叙述,并记录 model_status。
 * - 流转:draft →(提交,空章节阻断 REPORT_INCONSISTENT)→ pending_approval →(退回)draft /(审批,report:approve,
 *   审批人 ≠ 提交人,管理员须例外原因)approved →(发布任务,report:publish)published;published 只能修订为新修订号的 draft,
 *   新修订发布后旧版 superseded。审批后内容冻结(触发器兜底)。
 * - 发布:任务内由同一脱敏快照渲染 DOCX 与 PDF 并保存为文件对象;已发布下载保存的产物(字节一致),其余即时渲染带“草稿”水印。
 */
import { promptSupplement } from '../../modules/settings/prompt-supplements.service';
import type { DB } from '../../db/connection';
import { AppError } from '../../core/errors';
import { currentAuth } from '../../core/request-context';
import { canonicalHash, canonicalJson } from '../../core/canonical';
import { writeLog } from '../audit/log';
import { currentOrgScope, currentOrgScopeId, notVisible, orgInScope, requirePermission } from '../security/scope';
import { assertDistinctReviewer } from '../security/review';
import { storeFile, type ObjectStore } from '../files/object-store';
import { submitJob } from '../jobs/job.service';
import { reportDraft as assistantReportDraft } from '../../assistant/service';
import { rewriteTemplateNarrative } from '../../assistant/narrative';
import { PROMPT_VERSION, REPORT_REWRITE_TASK } from '../../assistant/prompts';
import { riskInvestmentDraft } from './risk-investment-draft';
import { renderDocx, renderPdf, type RenderDoc } from './render';
import {
  RPT_KIND_LABELS, RPT_STATUS_LABELS, type RptGenerate, type RptKind, type RptListQuery, type RptReportDto, type RptReportListItemDto, type RptSectionDto,
  type RptSectionEditDto, type RptStatus,
} from '../../contracts/analysis-reports';

const nowIso = () => new Date().toISOString();
const stateError = (message: string) => new AppError('REPORT_STATE', message, 409);
const versionConflict = () => new AppError('VERSION_CONFLICT', '报告已被他人修改,请刷新后重试', 409);

/* ================= 脱敏 ================= */

const ID_NO = /(?<![0-9A-Za-z])(\d{6})\d{8}(\d{3}[0-9Xx])(?![0-9A-Za-z])/g;
const PHONE = /(?<![\d.])(1[3-9]\d)\d{4}(\d{4})(?![\d.])/g;
export function redactText(s: string): string {
  return s.replace(ID_NO, '$1********$2').replace(PHONE, '$1****$2');
}
export function redactDeep<T>(v: T): T {
  if (typeof v === 'string') return redactText(v) as T;
  if (Array.isArray(v)) return v.map((x) => redactDeep(x)) as T;
  if (v && typeof v === 'object') return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, redactDeep(x)])) as T;
  return v;
}

/* ================= 行与可见性 ================= */

interface ReportRow {
  id: number; series_no: string; revision_no: number; previous_report_id: number | null; title: string; kind: RptKind; params_json: string; org_id: number | null;
  year: number | null; status: RptStatus; model_status: string; version: number; created_by_user_id: number | null; created_at: string; updated_at: string;
  submitted_by_user_id: number | null; submitted_at: string | null; approved_by_user_id: number | null; approved_at: string | null; approval_comment: string | null;
  exception_reason: string | null; self_approval: number; return_comment: string | null; published_by_user_id: number | null; published_at: string | null;
}
interface SectionRow { id: number; report_id: number; sort_order: number; key: string; title: string; body: string; facts_json: string; citations_json: string; edited: number; updated_at: string }

function visibleOrg(db: DB, orgId: number | null): boolean {
  const scope = currentOrgScope(db);
  return orgId === null ? scope.all : orgInScope(scope, orgId);
}

function reportRow(db: DB, id: number): ReportRow {
  const r = db.prepare('SELECT * FROM rpt_report WHERE id = ?').get(id) as ReportRow | undefined;
  if (!r || !visibleOrg(db, r.org_id)) throw notVisible('分析报告');
  return r;
}

const userName = (db: DB, id: number | null) => (id === null ? null
  : (db.prepare('SELECT COALESCE(display_name, username) AS n FROM app_user WHERE id = ?').get(id) as { n: string } | undefined)?.n ?? null);
const orgNameOf = (db: DB, id: number | null) => (id === null ? null : (db.prepare('SELECT name FROM org WHERE id = ?').get(id) as { name: string } | undefined)?.name ?? null);

function listItem(db: DB, r: ReportRow): RptReportListItemDto {
  return {
    id: r.id, seriesNo: r.series_no, revisionNo: r.revision_no, previousReportId: r.previous_report_id, title: r.title, kind: r.kind, kindLabel: RPT_KIND_LABELS[r.kind],
    orgId: r.org_id, orgName: orgNameOf(db, r.org_id), year: r.year, status: r.status, modelStatus: r.model_status, version: r.version,
    createdByUserId: r.created_by_user_id, createdByName: userName(db, r.created_by_user_id), createdAt: r.created_at, updatedAt: r.updated_at,
    submittedByUserId: r.submitted_by_user_id, submittedAt: r.submitted_at, approvedByUserId: r.approved_by_user_id, approvedAt: r.approved_at,
    publishedByUserId: r.published_by_user_id, publishedAt: r.published_at,
  };
}

const sectionsOf = (db: DB, reportId: number) => db.prepare('SELECT * FROM rpt_section WHERE report_id = ? ORDER BY sort_order, id').all(reportId) as SectionRow[];
const sectionDto = (s: SectionRow): RptSectionDto => ({
  id: s.id, sortOrder: s.sort_order, key: s.key, title: s.title, body: s.body, facts: JSON.parse(s.facts_json), citations: JSON.parse(s.citations_json) as unknown[],
  edited: s.edited === 1, updatedAt: s.updated_at,
});

function allowedActions(db: DB, r: ReportRow): RptReportDto['allowed'] {
  const auth = currentAuth();
  const can = (p: 'report:write' | 'report:approve' | 'report:publish') => !auth || auth.permissions.has(p);
  const out: RptReportDto['allowed'] = [];
  if (r.status === 'draft' && can('report:write')) out.push('edit', 'submit', 'delete');
  if (r.status === 'pending_approval' && can('report:approve')) out.push('return', 'approve');
  if (r.status === 'approved' && can('report:publish')) out.push('publish');
  if (r.status === 'published' && can('report:write') && !db.prepare("SELECT 1 FROM rpt_report WHERE series_no = ? AND status IN ('draft','pending_approval','approved')").get(r.series_no)) out.push('revise');
  return out;
}

export function getAnalysisReport(db: DB, id: number): RptReportDto {
  const r = reportRow(db, id);
  const pub = db.prepare('SELECT id, snapshot_sha256, docx_file_object_id, pdf_file_object_id, created_at FROM rpt_publication WHERE report_id = ?').get(id) as
    { id: number; snapshot_sha256: string; docx_file_object_id: number; pdf_file_object_id: number; created_at: string } | undefined;
  return {
    ...listItem(db, r), params: JSON.parse(r.params_json) as Record<string, unknown>, sections: sectionsOf(db, id).map(sectionDto),
    approvalComment: r.approval_comment, exceptionReason: r.exception_reason, selfApproval: r.self_approval === 1, returnComment: r.return_comment,
    publication: pub ? { id: pub.id, snapshotSha256: pub.snapshot_sha256, docxFileObjectId: pub.docx_file_object_id, pdfFileObjectId: pub.pdf_file_object_id, createdAt: pub.created_at } : null,
    editCount: (db.prepare('SELECT COUNT(*) AS n FROM rpt_section_edit WHERE report_id = ?').get(id) as { n: number }).n,
    allowed: allowedActions(db, r),
  };
}

export function listAnalysisReports(db: DB, q: RptListQuery = {}): RptReportListItemDto[] {
  if (q.orgId && !visibleOrg(db, q.orgId)) throw notVisible('组织');
  const where = ['1 = 1']; const params: unknown[] = [];
  if (q.kind) { where.push('kind = ?'); params.push(q.kind); }
  if (q.status) { where.push('status = ?'); params.push(q.status); }
  if (q.orgId) { where.push('org_id = ?'); params.push(q.orgId); }
  if (q.keyword) { where.push("(title LIKE ? ESCAPE '\\' OR series_no LIKE ? ESCAPE '\\')"); const k = `%${q.keyword.replace(/[\\%_]/g, (c) => `\\${c}`)}%`; params.push(k, k); }
  return (db.prepare(`SELECT * FROM rpt_report WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT 500`).all(...params) as ReportRow[])
    .filter((r) => visibleOrg(db, r.org_id)).map((r) => listItem(db, r));
}

export function listReportRevisions(db: DB, id: number): RptReportListItemDto[] {
  const r = reportRow(db, id);
  return (db.prepare('SELECT * FROM rpt_report WHERE series_no = ? ORDER BY revision_no').all(r.series_no) as ReportRow[]).map((x) => listItem(db, x));
}

export function listSectionEdits(db: DB, id: number): RptSectionEditDto[] {
  reportRow(db, id);
  return (db.prepare(`SELECT e.*, s.title AS section_title, COALESCE(u.display_name, u.username) AS actor_name FROM rpt_section_edit e JOIN rpt_section s ON s.id = e.section_id
    LEFT JOIN app_user u ON u.id = e.actor_user_id WHERE e.report_id = ? ORDER BY e.id`).all(id) as
    { id: number; section_id: number; section_title: string; before_body: string; after_body: string; actor_user_id: number | null; actor_name: string | null; created_at: string }[])
    .map((e) => ({ id: e.id, sectionId: e.section_id, sectionTitle: e.section_title, beforeBody: e.before_body, afterBody: e.after_body, actorUserId: e.actor_user_id, actorName: e.actor_name, createdAt: e.created_at }));
}

/* ================= 生成 ================= */

interface NewSection { key: string; title: string; body: string; facts: unknown; citations: unknown[] }

const bulletsBody = (bullets: string[]) => bullets.map((b) => `- ${b}`).join('\n');

/** 把改写后的整份叙述按“## 标题”切回章节;标题对不上的章节保留模板正文。 */
function mapNarrative(narrative: string, sections: NewSection[]): { sections: NewSection[]; mapped: number } {
  const blocks = new Map<string, string>();
  let cur: string | null = null; let buf: string[] = [];
  const flush = () => { if (cur !== null) blocks.set(cur, buf.join('\n').trim()); };
  for (const line of narrative.split(/\r?\n/)) {
    const m = /^##\s+(.+?)\s*$/.exec(line);
    if (m) { flush(); cur = m[1]; buf = []; } else if (cur !== null) buf.push(line);
  }
  flush();
  let mapped = 0;
  const out = sections.map((s) => {
    const b = blocks.get(s.title);
    if (b && b.trim()) { mapped++; return { ...s, body: b }; }
    return s;
  });
  return { sections: out, mapped };
}

async function buildDraft(db: DB, input: RptGenerate): Promise<{ title: string; orgId: number | null; year: number | null; sections: NewSection[]; modelStatus: string; params: Record<string, unknown> }> {
  const useModel = input.useModel !== false;
  if (input.kind === 'risk_investment') {
    if (input.orgId && !db.prepare('SELECT 1 FROM org WHERE id = ?').get(input.orgId)) throw notVisible('组织');
    const orgId = currentOrgScopeId(db, input.orgId ?? null);
    if (orgId !== null && !visibleOrg(db, orgId)) throw notVisible('组织');
    const orgName = orgNameOf(db, orgId) ?? '全组织';
    const d = riskInvestmentDraft(db, { orgId, orgName, year: input.year ?? null });
    let sections: NewSection[] = d.sections.map((s) => ({ key: s.key, title: s.title, body: bulletsBody(s.bullets), facts: s.data, citations: s.citations }));
    const template = [`# ${d.title}`, ...d.sections.map((s) => [`## ${s.title}`, ...s.bullets.map((b) => `- ${b}`)].join('\n'))].join('\n\n');
    const rewrite = await rewriteTemplateNarrative({ enabled: useModel, promptVersion: PROMPT_VERSION.reportRewrite, task: REPORT_REWRITE_TASK, supplement: promptSupplement(db, 'reportRewrite'), template, factTerms: d.factTerms });
    let modelStatus = 'template';
    if (rewrite.guardFailure) modelStatus = 'template:guard_failed';
    else if (rewrite.source === 'model') {
      const m = mapNarrative(rewrite.text, sections);
      sections = m.sections;
      modelStatus = m.mapped === sections.length ? `model:${rewrite.model}` : `model_partial:${rewrite.model}`;
    }
    return { title: input.title ?? d.title, orgId, year: input.year ?? null, sections, modelStatus, params: { kind: input.kind, orgId, year: input.year ?? null } };
  }
  const draft = await assistantReportDraft(db, {
    kind: input.kind, versionId: input.versionId ?? null, year: input.year ?? null, batchId: input.batchId ?? null, targetVersionId: input.targetVersionId ?? null,
    orgScopeId: input.orgId ?? null, narrative: useModel,
  });
  let sections: NewSection[] = draft.sections.map((s) => ({ key: s.key, title: s.title, body: bulletsBody(s.bullets), facts: s.data ?? {}, citations: s.citations }));
  let modelStatus = draft.model === 'template' ? (draft.notes.some((n) => n.includes('已丢弃改写')) ? 'template:guard_failed' : 'template') : `model:${draft.model}`;
  if (draft.narrativeSource === 'model') {
    const m = mapNarrative(draft.narrative, sections);
    sections = m.sections;
    if (m.mapped < sections.length) modelStatus = `model_partial:${draft.model}`;
  }
  if (draft.suggestions.length) sections.push({ key: 'suggestions', title: '建议(AI 生成,仅供参考)', body: bulletsBody(draft.suggestions), facts: {}, citations: [] });
  if (draft.notes.length) sections.push({ key: 'notes', title: '口径说明', body: bulletsBody(draft.notes), facts: {}, citations: [] });
  const params = { kind: input.kind, versionId: draft.scope.versionId, targetVersionId: draft.scope.targetVersionId, actualBatchId: draft.scope.actualBatchId, orgScopeId: draft.scope.orgScopeId, year: draft.period.year };
  return { title: input.title ?? draft.title, orgId: draft.scope.orgScopeId, year: draft.period.year, sections, modelStatus, params };
}

export async function generateAnalysisReport(db: DB, input: RptGenerate): Promise<RptReportDto> {
  // 取数与模型改写都在写事务之外
  const d = await buildDraft(db, input);
  const userId = currentAuth()?.userId ?? null;
  const id = db.transaction(() => {
    const now = nowIso();
    const seq = ((db.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM rpt_report').get() as { m: number }).m + 1);
    const series = `RPT-${now.slice(0, 4)}${now.slice(5, 7)}-${String(seq).padStart(5, '0')}`;
    const rid = Number(db.prepare(`INSERT INTO rpt_report (series_no, title, kind, params_json, org_id, year, model_status, created_by_user_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(series, d.title, input.kind, JSON.stringify(d.params), d.orgId, d.year, d.modelStatus, userId, now, now).lastInsertRowid);
    insertSections(db, rid, d.sections, now);
    writeLog(db, 'report.analysis.generate', 'rpt_report', rid, { seriesNo: series, kind: input.kind, orgId: d.orgId, modelStatus: d.modelStatus, sections: d.sections.length });
    return rid;
  }).immediate();
  return getAnalysisReport(db, id);
}

function insertSections(db: DB, reportId: number, sections: { key: string; title: string; body: string; facts: unknown; citations: unknown[]; edited?: boolean }[], now: string) {
  const ins = db.prepare('INSERT INTO rpt_section (report_id, sort_order, key, title, body, facts_json, citations_json, edited, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)');
  sections.forEach((s, i) => ins.run(reportId, (i + 1) * 10, s.key, s.title, s.body, JSON.stringify(s.facts ?? {}), JSON.stringify(s.citations ?? []), s.edited ? 1 : 0, now));
}

/* ================= 编辑与流转 ================= */

function lockedDraft(db: DB, id: number, expectedVersion: number, what: string): ReportRow {
  const r = reportRow(db, id);
  if (r.version !== expectedVersion) throw versionConflict();
  if (r.status !== 'draft') throw stateError(`报告当前为“${RPT_STATUS_LABELS[r.status]}”,不能${what}`);
  return r;
}

export function updateReportSection(db: DB, id: number, sectionId: number, input: { expectedVersion: number; body: string; title?: string }): RptReportDto {
  db.transaction(() => {
    lockedDraft(db, id, input.expectedVersion, '编辑');
    const s = db.prepare('SELECT * FROM rpt_section WHERE id = ? AND report_id = ?').get(sectionId, id) as SectionRow | undefined;
    if (!s) throw notVisible('报告章节');
    const title = input.title ?? s.title;
    if (s.body === input.body && s.title === title) return;
    const now = nowIso();
    db.prepare('UPDATE rpt_section SET body = ?, title = ?, edited = 1, updated_at = ? WHERE id = ?').run(input.body, title, now, sectionId);
    db.prepare('INSERT INTO rpt_section_edit (report_id, section_id, before_body, after_body, actor_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(id, sectionId, s.body, input.body, currentAuth()?.userId ?? null, now);
    db.prepare('UPDATE rpt_report SET version = version + 1, updated_at = ? WHERE id = ?').run(now, id);
    writeLog(db, 'report.analysis.edit', 'rpt_report', id, { sectionId, key: s.key, beforeLength: s.body.length, afterLength: input.body.length, titleChanged: title !== s.title });
  }).immediate();
  return getAnalysisReport(db, id);
}

export function submitAnalysisReport(db: DB, id: number, expectedVersion: number): RptReportDto {
  db.transaction(() => {
    lockedDraft(db, id, expectedVersion, '提交');
    const sections = sectionsOf(db, id);
    const empty = sections.filter((s) => !s.body.trim());
    if (!sections.length || empty.length) {
      throw new AppError('REPORT_INCONSISTENT', sections.length ? `以下章节为空,不能提交:${empty.map((s) => s.title).join('、')}` : '报告没有章节,不能提交', 409,
        undefined, { emptySections: empty.map((s) => ({ id: s.id, key: s.key, title: s.title })) });
    }
    const now = nowIso();
    db.prepare("UPDATE rpt_report SET status = 'pending_approval', submitted_by_user_id = ?, submitted_at = ?, version = version + 1, updated_at = ? WHERE id = ?")
      .run(currentAuth()?.userId ?? null, now, now, id);
    writeLog(db, 'report.analysis.submit', 'rpt_report', id, { sections: sections.length });
  }).immediate();
  return getAnalysisReport(db, id);
}

export function returnAnalysisReport(db: DB, id: number, input: { expectedVersion: number; comment: string }): RptReportDto {
  requirePermission(currentAuth(), 'report:approve');
  db.transaction(() => {
    const r = reportRow(db, id);
    if (r.version !== input.expectedVersion) throw versionConflict();
    if (r.status !== 'pending_approval') throw stateError(`报告当前为“${RPT_STATUS_LABELS[r.status]}”,不能退回`);
    db.prepare("UPDATE rpt_report SET status = 'draft', return_comment = ?, version = version + 1, updated_at = ? WHERE id = ?").run(input.comment, nowIso(), id);
    writeLog(db, 'report.analysis.return', 'rpt_report', id, { comment: input.comment });
  }).immediate();
  return getAnalysisReport(db, id);
}

export function approveAnalysisReport(db: DB, id: number, input: { expectedVersion: number; comment?: string; exceptionReason?: string }): RptReportDto {
  const auth = requirePermission(currentAuth(), 'report:approve');
  db.transaction(() => {
    const r = reportRow(db, id);
    if (r.version !== input.expectedVersion) throw versionConflict();
    if (r.status !== 'pending_approval') throw stateError(`报告当前为“${RPT_STATUS_LABELS[r.status]}”,不能审批`);
    const { selfReview } = assertDistinctReviewer(db, auth, r.submitted_by_user_id, input.exceptionReason, '分析报告');
    const now = nowIso();
    db.prepare(`UPDATE rpt_report SET status = 'approved', approved_by_user_id = ?, approved_at = ?, approval_comment = ?, exception_reason = ?, self_approval = ?,
      version = version + 1, updated_at = ? WHERE id = ?`).run(auth.userId, now, input.comment ?? null, selfReview ? input.exceptionReason ?? null : null, selfReview ? 1 : 0, now, id);
    writeLog(db, 'report.analysis.approve', 'rpt_report', id, { comment: input.comment, selfApproval: selfReview, exceptionReason: selfReview ? input.exceptionReason : undefined });
  }).immediate();
  return getAnalysisReport(db, id);
}

export function deleteAnalysisDraft(db: DB, id: number, expectedVersion: number): void {
  db.transaction(() => {
    const r = lockedDraft(db, id, expectedVersion, '删除');
    db.prepare('DELETE FROM rpt_section_edit WHERE report_id = ?').run(id);
    db.prepare('DELETE FROM rpt_section WHERE report_id = ?').run(id);
    db.prepare('DELETE FROM rpt_report WHERE id = ?').run(id);
    writeLog(db, 'report.analysis.delete', 'rpt_report', id, { seriesNo: r.series_no, revisionNo: r.revision_no });
  }).immediate();
}

export function reviseAnalysisReport(db: DB, id: number, expectedVersion: number): RptReportDto {
  const newId = db.transaction(() => {
    const r = reportRow(db, id);
    if (r.version !== expectedVersion) throw versionConflict();
    if (r.status !== 'published') throw stateError(`只有已发布的报告可以修订(当前为“${RPT_STATUS_LABELS[r.status]}”)`);
    if (db.prepare("SELECT 1 FROM rpt_report WHERE series_no = ? AND status IN ('draft','pending_approval','approved')").get(r.series_no)) throw stateError('该报告已有进行中的修订');
    const rev = (db.prepare('SELECT MAX(revision_no) AS m FROM rpt_report WHERE series_no = ?').get(r.series_no) as { m: number }).m + 1;
    const now = nowIso();
    const nid = Number(db.prepare(`INSERT INTO rpt_report (series_no, revision_no, previous_report_id, title, kind, params_json, org_id, year, model_status, created_by_user_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(r.series_no, rev, r.id, r.title, r.kind, r.params_json, r.org_id, r.year, r.model_status, currentAuth()?.userId ?? null, now, now).lastInsertRowid);
    insertSections(db, nid, sectionsOf(db, id).map((s) => ({ key: s.key, title: s.title, body: s.body, facts: JSON.parse(s.facts_json), citations: JSON.parse(s.citations_json) as unknown[], edited: s.edited === 1 })), now);
    writeLog(db, 'report.analysis.revise', 'rpt_report', nid, { seriesNo: r.series_no, revisionNo: rev, previousReportId: r.id });
    return nid;
  }).immediate();
  return getAnalysisReport(db, newId);
}

/* ================= 快照、渲染与发布 ================= */

export interface ReportSnapshot {
  report: { id: number; seriesNo: string; revisionNo: number; title: string; kind: RptKind; kindLabel: string; orgName: string | null; year: number | null; params: Record<string, unknown> };
  sections: { key: string; title: string; body: string; facts: unknown; citations: unknown[] }[];
  approval: { approvedBy: string | null; approvedAt: string | null; comment: string | null; selfApproval: boolean; exceptionReason: string | null };
  publishedAt: string | null;
}

function snapshotOf(db: DB, r: ReportRow, publishedAt: string | null): ReportSnapshot {
  return redactDeep({
    report: { id: r.id, seriesNo: r.series_no, revisionNo: r.revision_no, title: r.title, kind: r.kind, kindLabel: RPT_KIND_LABELS[r.kind], orgName: orgNameOf(db, r.org_id), year: r.year, params: JSON.parse(r.params_json) as Record<string, unknown> },
    sections: sectionsOf(db, r.id).map((s) => ({ key: s.key, title: s.title, body: s.body, facts: JSON.parse(s.facts_json), citations: JSON.parse(s.citations_json) as unknown[] })),
    approval: { approvedBy: userName(db, r.approved_by_user_id), approvedAt: r.approved_at, comment: r.approval_comment, selfApproval: r.self_approval === 1, exceptionReason: r.exception_reason },
    publishedAt,
  });
}

function docOf(s: ReportSnapshot, status: RptStatus, watermark: string | null): RenderDoc {
  const r = s.report;
  return {
    title: r.title,
    meta: [
      `${r.kindLabel} · ${r.orgName ?? '全组织'}${r.year ? ` · ${r.year} 年` : ''}`,
      `编号 ${r.seriesNo} · 修订 ${r.revisionNo}`,
      s.publishedAt ? `发布时间 ${s.publishedAt.slice(0, 19).replace('T', ' ')}${s.approval.approvedBy ? ` · 审批 ${s.approval.approvedBy}` : ''}` : `状态 ${RPT_STATUS_LABELS[status]}`,
    ],
    sections: s.sections.map((x) => ({ title: x.title, body: x.body })),
    watermark,
  };
}

export function publishAnalysisReport(dbf: () => DB, store: ObjectStore, id: number, expectedVersion: number): { jobId: number; created: boolean; done: Promise<void> } {
  requirePermission(currentAuth(), 'report:publish');
  const r = reportRow(dbf(), id);
  if (r.version !== expectedVersion) throw versionConflict();
  if (r.status !== 'approved') throw stateError(`只有已审批的报告可以发布(当前为“${RPT_STATUS_LABELS[r.status]}”)`);
  const { job, created, done } = submitJob(dbf, {
    kind: 'report.publish', title: `发布报告:${r.title}`, input: { reportId: id, version: r.version }, orgScopeId: r.org_id,
    idempotencyKey: `report.publish:${id}:${r.version}`, permission: 'report:publish',
  }, async (handle) => {
    const db = dbf();
    const fresh = reportRow(db, id);
    if (fresh.status !== 'approved' || fresh.version !== r.version) throw stateError('报告状态已变化,发布取消');
    const publishedAt = nowIso();
    const snapshot = snapshotOf(db, fresh, publishedAt);
    const doc = docOf(snapshot, 'published', null);
    handle.progress(300, '渲染 DOCX');
    const docx = await renderDocx(doc);
    handle.progress(600, '渲染 PDF');
    const pdf = renderPdf(doc);
    const base = `${snapshot.report.seriesNo}-R${snapshot.report.revisionNo}`;
    const docxFile = storeFile(db, store, docx, { originalName: `${base}.docx`, contentType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' });
    const pdfFile = storeFile(db, store, pdf, { originalName: `${base}.pdf`, contentType: 'application/pdf' });
    const snapshotJson = canonicalJson(snapshot);
    const sha = canonicalHash(snapshot);
    db.transaction(() => {
      const cur = reportRow(db, id);
      if (cur.status !== 'approved' || cur.version !== r.version) throw stateError('报告状态已变化,发布取消');
      db.prepare('INSERT INTO rpt_publication (report_id, snapshot_json, snapshot_sha256, docx_file_object_id, pdf_file_object_id, created_by_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(id, snapshotJson, sha, docxFile.id, pdfFile.id, currentAuth()?.userId ?? null, publishedAt);
      const superseded = db.prepare("UPDATE rpt_report SET status = 'superseded', version = version + 1, updated_at = ? WHERE series_no = ? AND status = 'published' AND id <> ?")
        .run(publishedAt, cur.series_no, id).changes;
      db.prepare("UPDATE rpt_report SET status = 'published', published_by_user_id = ?, published_at = ?, version = version + 1, updated_at = ? WHERE id = ?")
        .run(currentAuth()?.userId ?? null, publishedAt, publishedAt, id);
      writeLog(db, 'report.analysis.publish', 'rpt_report', id, { snapshotSha256: sha, docxSha256: docxFile.sha256, pdfSha256: pdfFile.sha256, superseded });
    }).immediate();
    return { reportId: id, snapshotSha256: sha };
  });
  return { jobId: job.id, created, done };
}

export async function exportAnalysisReport(db: DB, store: ObjectStore, id: number, format: 'docx' | 'pdf'): Promise<{ fileName: string; contentType: string; buffer: Buffer }> {
  const r = reportRow(db, id);
  const contentType = format === 'docx' ? 'application/vnd.openxmlformats-officedocument.wordprocessingml.document' : 'application/pdf';
  const safe = r.title.replace(/[\\/:*?"<>|]/g, '_');
  const pub = db.prepare(`SELECT f.sha256 FROM rpt_publication p JOIN file_object f ON f.id = ${format === 'docx' ? 'p.docx_file_object_id' : 'p.pdf_file_object_id'} WHERE p.report_id = ?`).get(id) as { sha256: string } | undefined;
  if (pub) {
    writeLog(db, 'report.analysis.download', 'rpt_report', id, { format, published: true });
    return { fileName: `${safe}-修订${r.revision_no}.${format}`, contentType, buffer: store.read(pub.sha256) };
  }
  const doc = docOf(snapshotOf(db, r, null), r.status, '草稿');
  const buffer = format === 'docx' ? await renderDocx(doc) : renderPdf(doc);
  writeLog(db, 'report.analysis.download', 'rpt_report', id, { format, published: false });
  return { fileName: `${safe}-草稿.${format}`, contentType, buffer };
}

/** 助手 report_list:已发布(含已替代)或本人创建的报告,按组织范围裁剪。 */
export function reportListForAssistant(db: DB, q: { kind?: RptKind; limit?: number } = {}) {
  const userId = currentAuth()?.userId ?? null;
  return listAnalysisReports(db, q.kind ? { kind: q.kind } : {})
    .filter((r) => r.status === 'published' || r.status === 'superseded' || (userId !== null && r.createdByUserId === userId))
    .slice(0, q.limit ?? 20)
    .map((r) => ({ id: r.id, seriesNo: r.seriesNo, revisionNo: r.revisionNo, title: r.title, kind: r.kind, status: r.status, orgName: r.orgName, publishedAt: r.publishedAt }));
}

