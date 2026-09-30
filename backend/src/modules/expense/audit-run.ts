/**
 * 报销单审核运行(AC-F22):OCR → 确定性规则 → 模型语义建议 → 输出校验,结果只追加。
 *
 * - 以后台任务执行;OCR 与模型调用都在事务外,最终在一个短事务里写入运行与发现,
 *   写入前复核报销单仍是同一 review_version 与内容哈希(否则丢弃,不覆盖新提交)。
 * - OCR 仅在配置 integration.ocr_base_url 时调用(适配契约见 docs/operations-runbook.md「OCR 适配」),
 *   结果按附件 sha256 缓存;未配置/失败记录 OCR_UNAVAILABLE / OCR_FAILED,不当作通过。
 * - 规则阈值与材料要求全部来自发生日期当时有效的制度条款;没有适用条款记 POLICY_BASIS_MISSING。
 * - 模型输出须引用输入中存在的字段/明细/附件与条款,否则丢弃并记 MODEL_OUTPUT_INVALID;
 *   未配置记 MODEL_UNAVAILABLE(info)。任何结果都只是“待复核”,不自动通过。
 */
import path from 'node:path';
import type { DB } from '../../db/connection';
import { centsToDecimalString } from '../../core/decimal';
import { AppError } from '../../core/errors';
import { writeLog } from '../audit/log';
import { currentAuth } from '../../core/request-context';
import { getSetting } from '../settings/business-settings';
import type { ObjectStore } from '../files/object-store';
import { submitJob, type JobHandle } from '../jobs/job.service';
import { EnvChatModel, modelConfigured } from '../../assistant/model';
import { expenseAuditPrompt } from '../../assistant/prompts';
import type { AuditRunDto, EvidenceRef, FindingSeverity, FindingSource, RiskLevel } from '../../contracts/expense';
import {
  claimAttachments, claimContentHash, claimLines, clauseApplies, effectiveClauses, normalizeText, visibleClaim,
  type AttachmentRow, type ClaimRow, type ClauseRow, type LineRow,
} from './expense.service';

export interface DraftFinding {
  source: FindingSource; code: string; severity: FindingSeverity; message: string; evidence: EvidenceRef[]; clauseId: number | null;
}

interface OcrText { text: string; pages: { page: number; text: string }[] }
interface OcrOutcome { status: AuditRunDto['ocrStatus']; texts: Map<number, OcrText>; findings: DraftFinding[] }
interface ModelOutcome { status: AuditRunDto['modelStatus']; findings: DraftFinding[] }

const OCR_EXTENSIONS = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.bmp', '.tif', '.tiff', '.webp', '.ofd']);
const OCR_TIMEOUT_MS = 30_000;
const MAX_OCR_CHARS = 200_000;
const MAX_MODEL_FINDINGS = 10;
const MODEL_EXCERPT_CHARS = 2_000;

/** 消息中的金额:千分位 + 两位小数(只用于文字,不参与计算)。 */
const money = (c: bigint) => centsToDecimalString(c).replace(/^(-?\d+)/, (i) => i.replace(/\B(?=(\d{3})+$)/g, ','));
const clauseRef = (c: ClauseRow): EvidenceRef => ({ kind: 'clause', ref: String(c.id), text: `${c.policy_code} v${c.policy_version} 第 ${c.clause_no} 条` });
const lineRef = (l: LineRow): EvidenceRef => ({ kind: 'line', ref: String(l.line_no), text: `${l.expense_type} ${money(l.amount_cents)}` });
const fieldRef = (field: string, text?: string): EvidenceRef => ({ kind: 'field', ref: field, ...(text !== undefined ? { text } : {}) });
const attachmentRef = (a: AttachmentRow): EvidenceRef => ({ kind: 'attachment', ref: String(a.id), text: a.name });

/* ================= OCR ================= */

/**
 * OCR 适配:POST {base_url},JSON {fileName, contentType, contentBase64};可选 Bearer 密钥。
 * 响应 {text?: string, pages?: [{page, text}]},两者至少其一。
 */
async function callOcr(baseUrl: string, apiKey: string | null, file: { name: string; content: Buffer }): Promise<OcrText> {
  const res = await fetch(baseUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}) },
    body: JSON.stringify({ fileName: file.name, contentType: ocrContentType(file.name), contentBase64: file.content.toString('base64') }),
    signal: AbortSignal.timeout(OCR_TIMEOUT_MS),
  });
  if (!res.ok) throw new Error(`OCR 服务返回 HTTP ${res.status}`);
  const body = await res.json() as { text?: unknown; pages?: unknown };
  const pages = Array.isArray(body.pages)
    ? body.pages.filter((p): p is { page: number; text: string } => !!p && typeof p === 'object' && Number.isSafeInteger((p as { page: unknown }).page) && typeof (p as { text: unknown }).text === 'string')
    : [];
  const text = typeof body.text === 'string' ? body.text : pages.map((p) => p.text).join('\n');
  if (typeof body.text !== 'string' && pages.length === 0) throw new Error('OCR 响应缺少 text/pages');
  return { text: text.slice(0, MAX_OCR_CHARS), pages: pages.map((p) => ({ page: p.page, text: p.text.slice(0, MAX_OCR_CHARS) })) };
}

function ocrContentType(name: string): string {
  const ext = path.extname(name).toLowerCase();
  return ext === '.pdf' ? 'application/pdf' : ext === '.ofd' ? 'application/ofd' : `image/${ext === '.jpg' ? 'jpeg' : ext === '.tif' ? 'tiff' : ext.slice(1)}`;
}

async function runOcr(db: DB, store: ObjectStore, attachments: AttachmentRow[]): Promise<OcrOutcome> {
  const texts = new Map<number, OcrText>();
  const targets = attachments.filter((a) => OCR_EXTENSIONS.has(path.extname(a.name).toLowerCase()));
  if (targets.length === 0) return { status: 'not_needed', texts, findings: [] };
  const baseUrl = getSetting<string | null>(db, 'integration.ocr_base_url');
  if (!baseUrl) {
    return {
      status: 'unavailable', texts,
      findings: [{
        source: 'ocr', code: 'OCR_UNAVAILABLE', severity: 'low', clauseId: null, evidence: targets.map(attachmentRef),
        message: `未配置 OCR 服务,${targets.length} 个扫描件/图片附件未识别内容;材料核对只依据附件名称,需人工查看原件`,
      }],
    };
  }
  const apiKey = getSetting<string | null>(db, 'integration.ocr_api_key');
  const findings: DraftFinding[] = [];
  const cacheGet = db.prepare('SELECT text_content, pages_json FROM ex_ocr_cache WHERE sha256 = ?');
  for (const a of targets) {
    const cached = cacheGet.get(a.file_sha256) as { text_content: string; pages_json: string } | undefined;
    if (cached) {
      texts.set(a.id, { text: cached.text_content, pages: JSON.parse(cached.pages_json) });
      continue;
    }
    try {
      const result = await callOcr(baseUrl, apiKey, { name: a.name, content: store.read(a.file_sha256) });
      texts.set(a.id, result);
      db.prepare('INSERT OR IGNORE INTO ex_ocr_cache (sha256, text_content, pages_json, created_at) VALUES (?, ?, ?, ?)')
        .run(a.file_sha256, result.text, JSON.stringify(result.pages), new Date().toISOString());
    } catch (error) {
      const reason = error instanceof Error && error.name === 'TimeoutError' ? '识别超时' : '识别失败';
      findings.push({
        source: 'ocr', code: 'OCR_FAILED', severity: 'medium', clauseId: null, evidence: [attachmentRef(a)],
        message: `附件「${a.name}」OCR ${reason},内容未核对,需人工查看原件`,
      });
    }
  }
  return { status: findings.length > 0 ? 'failed' : 'ok', texts, findings };
}

/* ================= 确定性规则 ================= */

export interface AuditInput {
  claim: ClaimRow; lines: LineRow[]; attachments: AttachmentRow[]; clauses: ClauseRow[]; ocrTexts: Map<number, OcrText>;
}

/** 确定性规则。阈值与材料要求来自条款,不写死。 */
export function evaluateRules(input: AuditInput): { findings: DraftFinding[]; usedClauses: ClauseRow[] } {
  const { claim, lines, attachments, clauses, ocrTexts } = input;
  const findings: DraftFinding[] = [];
  const add = (code: string, severity: FindingSeverity, message: string, evidence: EvidenceRef[], clauseId: number | null = null) =>
    findings.push({ source: 'rule', code, severity, message, evidence, clauseId });

  // 必填
  if (!claim.description.trim()) add('DESCRIPTION_MISSING', 'low', '报销事由为空', [fieldRef('description')]);
  if (lines.length === 0) {
    add('LINES_MISSING', 'medium', '报销单没有费用明细,无法核对发票', [fieldRef('amount', money(claim.amount_cents))]);
  } else {
    // 明细合计 = 单据金额
    const total = lines.reduce((s, l) => s + l.amount_cents, 0n);
    if (total !== claim.amount_cents) {
      add('LINE_TOTAL_MISMATCH', 'high', `明细合计 ${money(total)} 与报销金额 ${money(claim.amount_cents)} 不一致`, [fieldRef('amount', money(claim.amount_cents)), ...lines.map(lineRef)]);
    }
    for (const l of lines) {
      if (!l.invoice_no) add('INVOICE_NO_MISSING', 'medium', `明细 ${l.line_no} 缺少发票号`, [lineRef(l)]);
    }
    // 同单重复发票号
    const byInvoice = new Map<string, LineRow[]>();
    for (const l of lines) {
      if (!l.invoice_no) continue;
      const k = normalizeText(l.invoice_no);
      byInvoice.set(k, [...(byInvoice.get(k) ?? []), l]);
    }
    for (const group of byInvoice.values()) {
      if (group.length > 1) add('DUPLICATE_INVOICE', 'high', `发票号「${group[0].invoice_no}」在明细 ${group.map((l) => l.line_no).join('、')} 重复`, group.map(lineRef));
    }
    // 发票日期早于发生月
    const monthStart = `${claim.occurred_date.slice(0, 7)}-01`;
    for (const l of lines) {
      if (l.invoice_date && l.invoice_date < monthStart) {
        add('INVOICE_BEFORE_OCCURRED_MONTH', 'medium', `明细 ${l.line_no} 发票日期 ${l.invoice_date} 早于发生月 ${claim.occurred_date.slice(0, 7)}`, [lineRef(l), fieldRef('occurredDate', claim.occurred_date)]);
      }
    }
  }
  // 同单重复附件
  const bySha = new Map<string, AttachmentRow[]>();
  for (const a of attachments) bySha.set(a.file_sha256, [...(bySha.get(a.file_sha256) ?? []), a]);
  for (const group of bySha.values()) {
    if (group.length > 1) add('DUPLICATE_ATTACHMENT', 'medium', `附件 ${group.map((a) => `「${a.name}」`).join('、')} 内容相同`, group.map(attachmentRef));
  }
  // 发生日期晚于提交日期
  const submittedDate = (claim.submitted_at ?? new Date().toISOString()).slice(0, 10);
  if (claim.occurred_date > submittedDate) {
    add('OCCURRED_AFTER_SUBMIT', 'high', `发生日期 ${claim.occurred_date} 晚于提交日期 ${submittedDate}`, [fieldRef('occurredDate', claim.occurred_date)]);
  }

  // 制度依据:按费用类型取适用条款
  const types = new Map<string, string>();
  types.set(normalizeText(claim.expense_type), claim.expense_type);
  for (const l of lines) types.set(normalizeText(l.expense_type), l.expense_type);
  const used = new Map<number, ClauseRow>();
  for (const type of types.values()) {
    const applicable = clauses.filter((c) => clauseApplies(c, type));
    if (applicable.length === 0) {
      const ev = lines.filter((l) => normalizeText(l.expense_type) === normalizeText(type)).map(lineRef);
      add('POLICY_BASIS_MISSING', 'medium', `费用类型「${type}」在发生日期 ${claim.occurred_date} 没有有效的制度条款,需人工判断依据`, [fieldRef('expenseType', type), ...ev]);
    }
    for (const c of applicable) used.set(c.id, c);
  }

  // 条款金额上限:按条款适用的费用类型归集金额
  for (const c of used.values()) {
    if (c.limit_cents === null) continue;
    const matched = lines.filter((l) => clauseApplies(c, l.expense_type));
    const amount = lines.length === 0 ? (clauseApplies(c, claim.expense_type) ? claim.amount_cents : 0n) : matched.reduce((s, l) => s + l.amount_cents, 0n);
    if (amount > c.limit_cents) {
      const label = c.expense_types.length ? c.expense_types.join('/') : claim.expense_type;
      add('LIMIT_EXCEEDED', 'high', `${label}金额 ${money(amount)} 超过${c.policy_title}第 ${c.clause_no} 条上限 ${money(c.limit_cents)}`,
        [...(matched.length ? matched.map(lineRef) : [fieldRef('amount', money(claim.amount_cents))]), clauseRef(c)], c.id);
    }
  }

  // 材料齐套:条款关键字对照附件名称、类型提示与 OCR 文本
  const haystack = attachments.map((a) => normalizeText([a.name, a.kind_hint, ocrTexts.get(a.id)?.text ?? ''].join(' ')));
  for (const c of used.values()) {
    const missing = c.required_keywords.filter((kw) => {
      const k = normalizeText(kw);
      return k && !haystack.some((h) => h.includes(k));
    });
    if (c.keyword_min_matches === null) {
      for (const kw of missing) {
        add('MATERIAL_MISSING', 'medium', `缺少「${kw}」相关材料(${c.policy_title}第 ${c.clause_no} 条要求)`, [clauseRef(c), ...attachments.map(attachmentRef)], c.id);
      }
      continue;
    }
    // 至少命中 N 项(lishui 口径):不足时一条发现,列出已识别与未识别的材料
    const hit = c.required_keywords.length - missing.length;
    if (hit < c.keyword_min_matches) {
      const found = c.required_keywords.filter((kw) => !missing.includes(kw));
      add('MATERIAL_MISSING', 'medium',
        `材料不足:${c.policy_title}第 ${c.clause_no} 条要求「${c.required_keywords.join('、')}」至少 ${c.keyword_min_matches} 项,仅识别到 ${found.length ? found.map((k) => `「${k}」`).join('、') : '0 项'}`,
        [clauseRef(c), ...attachments.map(attachmentRef)], c.id);
    }
  }
  return { findings, usedClauses: [...used.values()] };
}

/* ================= 模型语义建议 ================= */

const MODEL_FIELDS = new Set(['claimNo', 'applicant', 'department', 'expenseType', 'amount', 'occurredDate', 'description']);
const SEVERITIES = new Set<FindingSeverity>(['info', 'low', 'medium', 'high']);

/** 白名单校验模型发现:证据必须引用输入中存在的字段/明细/附件,条款 ID 必须来自输入。 */
export function sanitizeModelFindings(value: unknown, input: AuditInput, clauseIds: Set<number>): { findings: DraftFinding[]; dropped: number } | null {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !Array.isArray((value as { findings?: unknown }).findings)) return null;
  const lineNos = new Map(input.lines.map((l) => [String(l.line_no), l]));
  const atts = new Map(input.attachments.map((a) => [String(a.id), a]));
  const findings: DraftFinding[] = [];
  let dropped = 0;
  for (const item of (value as { findings: unknown[] }).findings) {
    const f = item as { severity?: unknown; message?: unknown; evidence?: unknown; clauseId?: unknown };
    const severity = typeof f?.severity === 'string' && SEVERITIES.has(f.severity as FindingSeverity) ? f.severity as FindingSeverity : null;
    const message = typeof f?.message === 'string' ? f.message.trim().slice(0, 300) : '';
    const clauseId = f?.clauseId === null || f?.clauseId === undefined ? null : Number(f.clauseId);
    const evidence: EvidenceRef[] = [];
    let valid = !!severity && !!message && (clauseId === null || clauseIds.has(clauseId)) && Array.isArray(f.evidence) && f.evidence.length > 0;
    for (const e of Array.isArray(f?.evidence) ? f.evidence : []) {
      const m = typeof e === 'string' ? /^(field|line|attachment):(.+)$/.exec(e.trim()) : null;
      if (!m) { valid = false; break; }
      if (m[1] === 'field' && MODEL_FIELDS.has(m[2])) evidence.push(fieldRef(m[2]));
      else if (m[1] === 'line' && lineNos.has(m[2])) evidence.push(lineRef(lineNos.get(m[2])!));
      else if (m[1] === 'attachment' && atts.has(m[2])) evidence.push(attachmentRef(atts.get(m[2])!));
      else { valid = false; break; }
    }
    if (!valid || findings.length >= MAX_MODEL_FINDINGS) { dropped += 1; continue; }
    findings.push({ source: 'model', code: 'MODEL_SUGGESTION', severity: severity!, message, evidence, clauseId });
  }
  return { findings, dropped };
}

function stripFence(text: string): string {
  const t = text.trim();
  const m = /^```(?:json)?\s*([\s\S]*?)\s*```$/.exec(t);
  return m ? m[1] : t;
}

async function runModel(input: AuditInput, usedClauses: ClauseRow[]): Promise<ModelOutcome> {
  if (!modelConfigured()) {
    return { status: 'unavailable', findings: [{ source: 'model', code: 'MODEL_UNAVAILABLE', severity: 'info', clauseId: null, evidence: [], message: '未配置模型,本次没有语义审核建议;结论以规则与人工复核为准' }] };
  }
  const { claim } = input;
  const payload = {
    claim: {
      claimNo: claim.claim_no, applicant: claim.applicant, department: claim.department, expenseType: claim.expense_type,
      amount: centsToDecimalString(claim.amount_cents), occurredDate: claim.occurred_date, description: claim.description,
    },
    lines: input.lines.map((l) => ({ lineNo: l.line_no, expenseType: l.expense_type, amount: centsToDecimalString(l.amount_cents), invoiceNo: l.invoice_no, invoiceDate: l.invoice_date, description: l.description })),
    attachments: input.attachments.map((a) => ({ id: a.id, name: a.name, kindHint: a.kind_hint, ocrExcerpt: (input.ocrTexts.get(a.id)?.text ?? '').slice(0, MODEL_EXCERPT_CHARS) })),
    clauses: usedClauses.map((c) => ({ id: c.id, policy: `${c.policy_code} v${c.policy_version}`, clauseNo: c.clause_no, text: c.clause_text, limit: c.limit_cents === null ? null : centsToDecimalString(c.limit_cents), requiredKeywords: c.required_keywords, keywordMinMatches: c.keyword_min_matches })),
  };
  let text: string;
  try {
    const result = await new EnvChatModel('expense_audit').complete({
      messages: [{ role: 'system', content: expenseAuditPrompt(MAX_MODEL_FINDINGS) }, { role: 'user', content: JSON.stringify(payload) }],
    });
    text = result.text;
  } catch {
    return { status: 'failed', findings: [{ source: 'model', code: 'MODEL_FAILED', severity: 'low', clauseId: null, evidence: [], message: '模型调用失败(超时或服务错误),本次没有语义审核建议' }] };
  }
  let parsed: unknown;
  try { parsed = JSON.parse(stripFence(text)); } catch { parsed = undefined; }
  const sanitized = sanitizeModelFindings(parsed, input, new Set(usedClauses.map((c) => c.id)));
  if (!sanitized) {
    return { status: 'invalid', findings: [{ source: 'model', code: 'MODEL_OUTPUT_INVALID', severity: 'info', clauseId: null, evidence: [], message: '模型输出不是约定的 JSON 结构,已全部丢弃' }] };
  }
  const findings = [...sanitized.findings];
  if (sanitized.dropped > 0) {
    findings.push({ source: 'model', code: 'MODEL_OUTPUT_INVALID', severity: 'info', clauseId: null, evidence: [], message: `模型有 ${sanitized.dropped} 条建议缺少有效证据或条款引用,已丢弃` });
  }
  return { status: 'ok', findings };
}

/* ================= 运行 ================= */

export function riskLevelOf(findings: DraftFinding[]): RiskLevel {
  if (findings.some((f) => f.severity === 'high')) return 'high';
  if (findings.some((f) => f.severity === 'medium')) return 'medium';
  return 'low';
}

export interface AuditRunResult { runId: number | null; skipped?: string; riskLevel?: RiskLevel; findingCount?: number }

/**
 * 执行一次审核运行。reviewVersion 是启动时的报销单版本;写入前若报销单已变化则丢弃结果。
 */
export async function runClaimAudit(db: DB, store: ObjectStore, claimId: number, reviewVersion: number, handle?: JobHandle): Promise<AuditRunResult> {
  const claim = visibleClaim(db, claimId);
  if (claim.review_version !== reviewVersion || !['submitted', 'audited'].includes(claim.status) || !claim.content_sha256) {
    return { runId: null, skipped: '报销单已变化或不在审核状态,本次运行不写入' };
  }
  const lines = claimLines(db, claimId);
  const attachments = claimAttachments(db, claimId);
  const clauses = effectiveClauses(db, claim.occurred_date);

  const t0 = Date.now();
  const ocr = await runOcr(db, store, attachments);
  handle?.step({ name: 'OCR', type: 'tool', status: ocr.status === 'failed' ? 'error' : ocr.status === 'ok' ? 'success' : 'skipped', detail: ocr.status, elapsedMs: Date.now() - t0 });
  handle?.checkCancelled();
  handle?.progress(400, 'OCR 完成');

  const input: AuditInput = { claim, lines, attachments, clauses, ocrTexts: ocr.texts };
  const rules = evaluateRules(input);
  handle?.step({ name: '规则核对', type: 'rule', status: 'success', detail: `${rules.findings.length} 项发现`, sourceRefs: rules.usedClauses.map((c) => ({ clauseId: c.id })) });
  handle?.progress(600, '规则核对完成');

  const t1 = Date.now();
  const model = await runModel(input, rules.usedClauses);
  handle?.step({ name: '模型语义建议', type: 'model', status: model.status === 'ok' ? 'success' : model.status === 'unavailable' ? 'skipped' : 'error', detail: model.status, elapsedMs: Date.now() - t1 });
  handle?.checkCancelled();

  const findings = [...ocr.findings, ...rules.findings, ...model.findings];
  const risk = riskLevelOf(findings);
  const policyRefs = [...new Map(rules.usedClauses.map((c) => [c.policy_id, { policyId: c.policy_id, code: c.policy_code, version: c.policy_version }])).values()];

  return db.transaction((): AuditRunResult => {
    const fresh = visibleClaim(db, claimId);
    if (fresh.review_version !== reviewVersion || !['submitted', 'audited'].includes(fresh.status)
      || fresh.content_sha256 !== claimContentHash(fresh, claimLines(db, claimId), claimAttachments(db, claimId))) {
      return { runId: null, skipped: '报销单在审核期间已变化,本次运行不写入' };
    }
    const now = new Date().toISOString();
    const runId = Number(db.prepare(`INSERT INTO ex_audit_run (claim_id, review_version, content_sha256, job_id, risk_level, ocr_status, model_status, policy_refs_json, created_by_user_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(claimId, reviewVersion, fresh.content_sha256, handle?.id ?? null, risk, ocr.status, model.status, JSON.stringify(policyRefs), currentAuth()?.userId ?? null, now).lastInsertRowid);
    const ins = db.prepare('INSERT INTO ex_finding (run_id, source, code, severity, message, evidence_json, clause_id) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const f of findings) ins.run(runId, f.source, f.code, f.severity, f.message, JSON.stringify(f.evidence), f.clauseId);
    if (fresh.status === 'submitted') db.prepare("UPDATE ex_claim SET status = 'audited', updated_at = ? WHERE id = ?").run(now, claimId);
    writeLog(db, 'expense.claim.audit', 'ex_claim', claimId, {
      claimNo: fresh.claim_no, runId, jobId: handle?.id ?? null, riskLevel: risk, ocrStatus: ocr.status, modelStatus: model.status, findingCount: findings.length, policyRefs,
    });
    return { runId, riskLevel: risk, findingCount: findings.length };
  }).immediate();
}

/**
 * 以后台任务启动审核运行。提交触发的运行按 (报销单, 版本) 幂等;复核人手动重跑不幂等。
 */
export function startClaimAudit(db: () => DB, store: () => ObjectStore, claimId: number, trigger: 'submit' | 'rerun'): { jobId: number; done: Promise<void> } {
  const claim = visibleClaim(db(), claimId);
  if (!['submitted', 'audited'].includes(claim.status)) {
    throw new AppError('CLAIM_STATE', '只有审核中或待复核的报销单可以运行审核', 409);
  }
  const { job, done } = submitJob(db, {
    kind: 'expense.audit',
    title: `报销单 ${claim.claim_no} 审核`,
    input: { claimId, reviewVersion: claim.review_version, trigger },
    orgScopeId: claim.org_id,
    idempotencyKey: trigger === 'submit' ? `claim-${claimId}-v${claim.review_version}` : null,
    permission: 'expense:read',
  }, async (handle) => runClaimAudit(db(), store(), claimId, claim.review_version, handle));
  return { jobId: job.id, done };
}
