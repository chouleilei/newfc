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
import { createHash } from 'node:crypto';
import type { DB } from '../../db/connection';
import { centsToDecimalString } from '../../core/decimal';
import { AppError } from '../../core/errors';
import { writeLog } from '../audit/log';
import { currentAuth } from '../../core/request-context';
import { currentOrgScope, orgInScope } from '../security/scope';
import { getSetting } from '../settings/business-settings';
import { recognizeAttachment, type OcrConfig, type OcrText } from './ocr-client';
import type { ObjectStore } from '../files/object-store';
import { submitJob, type JobHandle } from '../jobs/job.service';
import { EnvChatModel, modelConfigured } from '../../assistant/model';
import { expenseAuditPrompt } from '../../assistant/prompts';
import type { AuditRunDto, EvidenceRef, FindingSeverity, FindingSource, RiskLevel } from '../../contracts/expense';
import {
  claimAttachments, claimContentHash, claimLines, clauseApplies, effectiveClauses, isPriceComparisonAttachment, normalizeText, visibleClaim,
  type AttachmentRow, type ClaimRow, type ClauseRow, type LineRow,
} from './expense.service';

export interface DraftFinding {
  source: FindingSource; code: string; severity: FindingSeverity; message: string; evidence: EvidenceRef[]; clauseId: number | null;
}

interface OcrOutcome { status: AuditRunDto['ocrStatus']; texts: Map<number, OcrText>; findings: DraftFinding[] }
interface ModelOutcome { status: AuditRunDto['modelStatus']; findings: DraftFinding[] }

const OCR_EXTENSIONS = new Set(['.pdf', '.png', '.jpg', '.jpeg', '.bmp', '.tif', '.tiff', '.webp', '.ofd']);
const MAX_MODEL_FINDINGS = 10;
const MODEL_EXCERPT_CHARS = 2_000;

/** 消息中的金额:千分位 + 两位小数(只用于文字,不参与计算)。 */
const money = (c: bigint) => centsToDecimalString(c).replace(/^(-?\d+)/, (i) => i.replace(/\B(?=(\d{3})+$)/g, ','));
const clauseRef = (c: ClauseRow): EvidenceRef => ({ kind: 'clause', ref: String(c.id), text: `${c.policy_code} v${c.policy_version} 第 ${c.clause_no} 条` });
const lineRef = (l: LineRow): EvidenceRef => ({ kind: 'line', ref: String(l.line_no), text: `${l.expense_type} ${money(l.amount_cents)}` });
const fieldRef = (field: string, text?: string): EvidenceRef => ({ kind: 'field', ref: field, ...(text !== undefined ? { text } : {}) });
const attachmentRef = (a: AttachmentRow): EvidenceRef => ({ kind: 'attachment', ref: String(a.id), text: a.name });

/* ================= OCR ================= */

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
  const config: OcrConfig = {
    baseUrl, provider: getSetting(db, 'integration.ocr_provider'), apiKey: getSetting(db, 'integration.ocr_api_key'),
    username: getSetting(db, 'integration.ocr_username'), password: getSetting(db, 'integration.ocr_password'),
    apiType: getSetting(db, 'integration.ocr_api_type'), timeoutSeconds: getSetting(db, 'integration.ocr_timeout_seconds'),
  };
  const findings: DraftFinding[] = [];
  const cacheGet = db.prepare('SELECT text_content, pages_json FROM ex_ocr_cache WHERE sha256 = ?');
  for (const a of targets) {
    const cached = cacheGet.get(a.file_sha256) as { text_content: string; pages_json: string } | undefined;
    if (cached) {
      texts.set(a.id, { text: cached.text_content, pages: JSON.parse(cached.pages_json) });
      continue;
    }
    try {
      const result = await recognizeAttachment(config, { name: a.name, content: store.read(a.file_sha256) });
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

export interface SplitClusterHit {
  normalizedCategory: string;
  supplierOrPayee: string | null;
  windowDays: number;
  anchorDate: string;
  windowStart: string;
  windowEnd: string;
  claimIds: number[];
  claimNos: string[];
  totalCents: bigint;
  fingerprint: string;
}

export interface AuditInput {
  claim: ClaimRow; lines: LineRow[]; attachments: AttachmentRow[]; clauses: ClauseRow[]; ocrTexts: Map<number, OcrText>;
  smallProcLimitCents?: bigint;
  linkedContractComparisonRef?: string | null;
  splitCluster?: SplitClusterHit | null;
}

const SPLIT_ELIGIBLE_TYPE_RE = /采购|维修|修缮|工程|设备|材料|物资|外包|劳务|租赁|印刷|耗材|软件|服务|备件|检测|维护/;

function daysBetweenDates(a: string, b: string): number | null {
  const ta = Date.parse(`${a}T00:00:00Z`);
  const tb = Date.parse(`${b}T00:00:00Z`);
  if (!Number.isFinite(ta) || !Number.isFinite(tb)) return null;
  return Math.round((tb - ta) / 86_400_000);
}

export function detectClaimSplitCluster(db: DB, claim: ClaimRow, limitCents: bigint, windowDays: number): SplitClusterHit | null {
  if (claim.amount_cents <= 0n || claim.amount_cents > limitCents) return null;
  const normType = normalizeText(claim.expense_type);
  const isSplitCandidate = claim.is_procurement_expense === 1 || claim.contract_id !== null || SPLIT_ELIGIBLE_TYPE_RE.test(claim.expense_type);
  if (!isSplitCandidate) return null;

  const contractSupplier = claim.contract_id !== null
    ? (db.prepare('SELECT supplier_id, counterparty_names FROM ct_contract WHERE id = ?').get(claim.contract_id) as { supplier_id: number | null; counterparty_names: string | null } | undefined)
    : undefined;
  const supplierKey = contractSupplier?.supplier_id
    ? `sup:${contractSupplier.supplier_id}`
    : contractSupplier?.counterparty_names?.trim()
      ? `payee:${normalizeText(contractSupplier.counterparty_names)}`
      : null;

  const peers = db.prepare(
    `SELECT c.id, c.claim_no, c.expense_type, c.amount_cents, c.occurred_date, c.contract_id, c.is_procurement_expense,
            ct.supplier_id, ct.counterparty_names
     FROM ex_claim c
     LEFT JOIN ct_contract ct ON ct.id = c.contract_id
     WHERE c.org_id = ?
       AND c.occurred_date >= date(?, ?) AND c.occurred_date <= date(?, ?)
       AND (c.id = ? OR c.status IN ('submitted','audited','reviewed','supplement'))
       AND (c.conclusion IS NULL OR c.conclusion <> 'reject')
       AND c.amount_cents > 0 AND c.amount_cents <= ?`
  ).safeIntegers(true).all(claim.org_id, claim.occurred_date, `${1 - windowDays} days`, claim.occurred_date, `${windowDays - 1} days`, claim.id, limitCents) as {
    id: bigint; claim_no: string; expense_type: string; amount_cents: bigint; occurred_date: string;
    contract_id: bigint | null; is_procurement_expense: bigint; supplier_id: bigint | null; counterparty_names: string | null;
  }[];

  const matched = peers
    .map((p) => {
      const pId = Number(p.id);
      const pContractId = p.contract_id === null ? null : Number(p.contract_id);
      const pSupKey = p.supplier_id !== null
        ? `sup:${Number(p.supplier_id)}`
        : p.counterparty_names?.trim()
          ? `payee:${normalizeText(p.counterparty_names)}`
          : null;
      const sameType = normalizeText(p.expense_type) === normType;
      const sameContract = claim.contract_id !== null && pContractId === claim.contract_id;
      const sameSupplier = supplierKey !== null && pSupKey === supplierKey;
      return {
        id: pId,
        claimNo: p.claim_no,
        date: p.occurred_date,
        cents: BigInt(p.amount_cents),
        groups: [sameType ? `type:${normType}` : null, sameContract ? `contract:${claim.contract_id}` : null, sameSupplier ? supplierKey : null].filter((key): key is string => key !== null),
      };
    })
    .filter((p) => p.groups.length > 0)
    .filter((p) => {
      const diff = daysBetweenDates(p.date, claim.occurred_date);
      return diff !== null && Math.abs(diff) < windowDays;
    });

  if (matched.length < 2) return null;
  matched.sort((a, b) => a.date.localeCompare(b.date) || a.id - b.id);

  // 每个候选窗口必须共享同一分组键，不能混合“同类别”和“同供应商”的不相干单据。
  let bestWindow: typeof matched | null = null;
  let bestSum = 0n;
  let groupCategory = '';
  const keys = [...new Set(matched.flatMap((p) => p.groups))].sort();
  for (const group of keys) {
    const peersInGroup = matched.filter((p) => p.groups.includes(group));
    for (let i = 0; i < peersInGroup.length; i += 1) {
      const win = peersInGroup.slice(i).filter((p) => {
        const d = daysBetweenDates(peersInGroup[i].date, p.date);
        return d !== null && d >= 0 && d < windowDays;
      });
      if (!win.some((p) => p.id === claim.id)) continue;
      const sum = win.reduce((total, p) => total + p.cents, 0n);
      if (win.length >= 2 && sum >= limitCents && sum > bestSum) {
        bestWindow = win;
        bestSum = sum;
        groupCategory = group;
      }
    }
  }
  if (!bestWindow) return null;
  const byId = [...bestWindow].sort((a, b) => a.id - b.id);
  const claimIds = byId.map((w) => w.id);
  const claimNos = byId.map((w) => w.claimNo);
  const fingerprint = createHash('sha256')
    .update(JSON.stringify({ orgId: claim.org_id, groupCategory, claimIds }))
    .digest('hex');
  return {
    normalizedCategory: groupCategory,
    supplierOrPayee: contractSupplier?.counterparty_names?.trim() ? contractSupplier.counterparty_names : null,
    windowDays,
    anchorDate: bestWindow[bestWindow.length - 1].date,
    windowStart: bestWindow[0].date,
    windowEnd: bestWindow[bestWindow.length - 1].date,
    claimIds,
    claimNos,
    totalCents: bestSum,
    fingerprint,
  };
}

export function resolveLinkedContractComparisonRef(db: DB, contractId: number | null): string | null {
  if (contractId === null) return null;
  const contract = db.prepare('SELECT org_id, status FROM ct_contract WHERE id = ?').get(contractId) as { org_id: number; status: string } | undefined;
  if (!contract || contract.status === 'voided' || !orgInScope(currentOrgScope(db), contract.org_id)) return null;
  const rec = db.prepare(
    `SELECT pr.id, pr.procurement_method, pr.comparison_quotes_json
     FROM ct_contract c JOIN ct_procurement_record pr ON pr.id = c.procurement_record_id
     WHERE c.id = ? LIMIT 1`
  ).get(contractId) as { id: number; procurement_method: string | null; comparison_quotes_json: string } | undefined;
  let hasQuotes = false;
  if (rec) {
    try {
      const quotes: unknown = JSON.parse(rec.comparison_quotes_json);
      hasQuotes = Array.isArray(quotes) && quotes.some((quote) => quote && typeof quote.vendorName === 'string' && quote.vendorName.trim() && typeof quote.quoteAmount === 'string' && /^\d+(?:\.\d{1,2})?$/.test(quote.quoteAmount));
    } catch { /* 无效留痕不能作为比价证据。 */ }
  }
  if (rec && hasQuotes) return `关联合同采购记录 #${rec.id}(${rec.procurement_method ?? 'recorded'})`;
  const doc = db.prepare(
    `SELECT id, name FROM ct_document
     WHERE contract_id = ? AND withdrawn_at IS NULL AND doc_type = 'procurement'
       AND (name LIKE '%比价%' OR name LIKE '%询价%' OR name LIKE '%市场调研%' OR name LIKE '%三家报价%')
     ORDER BY id DESC LIMIT 1`
  ).get(contractId) as { id: number; name: string } | undefined;
  return doc ? `关联合同比价附件「${doc.name}」` : null;
}

function persistSplitAlertAndRiskClue(db: DB, claim: ClaimRow, cluster: SplitClusterHit, now: string): number | null {
  const hasRule = db.prepare("SELECT enabled, source, level FROM risk_rule WHERE code = 'PW_14'").get() as { enabled: number; source: string; level: 'high' | 'medium' | 'low' } | undefined;
  let riskEventId: number | null = null;
  const userId = currentAuth()?.userId ?? null;

  if (hasRule && hasRule.enabled === 1) {
    const subjectId = cluster.claimIds[0];
    const eventKey = `PW_14:ex_claim:${subjectId}:split_${cluster.fingerprint.slice(0, 24)}`;
    const title = `${cluster.windowDays}日内同口径小额报账累计 ${centsToDecimalString(cluster.totalCents)} 元疑似拆单`;
    const description = `同一单位 ${cluster.windowStart} 至 ${cluster.windowEnd} 连续 ${cluster.windowDays} 日内发生 ${cluster.claimIds.length} 笔小额报销（${cluster.claimNos.join('、')}），累计 ${centsToDecimalString(cluster.totalCents)} 元已达 30,000.00 元限额，疑似拆单规避集中采购（§8.1.7 / PW_14）。`;
    const evidenceJson = JSON.stringify({
      claimIds: cluster.claimIds,
      claimNos: cluster.claimNos,
      windowDays: cluster.windowDays,
      windowStart: cluster.windowStart,
      windowEnd: cluster.windowEnd,
      totalAmount: centsToDecimalString(cluster.totalCents),
      contractId: claim.contract_id,
    });
    const existing = db.prepare('SELECT id, status FROM risk_event WHERE event_key = ?').get(eventKey) as { id: number; status: string } | undefined;
    if (!existing) {
      riskEventId = Number(
        db.prepare(
          `INSERT INTO risk_event (
             event_key, rule_code, source, level, org_id, project_id, subject_type, subject_id,
             title, description, amount_cents, metric, evidence_json, evidence_status,
             first_detected_at, last_detected_at, created_at, updated_at
           ) VALUES (?, 'PW_14', ?, ?, ?, NULL, 'ex_claim', ?, ?, ?, ?, ?, ?, 'suspected_clue', ?, ?, ?, ?)`
        ).run(
          eventKey, hasRule.source, hasRule.level, claim.org_id, subjectId,
          title, description, cluster.totalCents, String(cluster.claimIds.length), evidenceJson,
          now, now, now, now,
        ).lastInsertRowid
      );
      db.prepare(
        'INSERT INTO risk_action (event_id, action, from_status, to_status, comment, scan_id, actor_user_id, created_at) VALUES (?, ?, ?, ?, ?, NULL, ?, ?)'
      ).run(riskEventId, 'detect', null, 'open', description, userId, now);
    } else {
      riskEventId = existing.id;
      if (existing.status !== 'false_positive') {
        db.prepare(
          `UPDATE risk_event SET title = ?, description = ?, amount_cents = ?, metric = ?, evidence_json = ?,
             evidence_status = 'suspected_clue', occurrence_count = occurrence_count + 1, last_detected_at = ?, updated_at = ?, version = version + 1
           WHERE id = ?`
        ).run(title, description, cluster.totalCents, String(cluster.claimIds.length), evidenceJson, now, now, existing.id);
      }
    }
  }

  db.prepare(
    `INSERT INTO ex_split_alert_log (
       org_id, normalized_category, supplier_or_payee, window_days, anchor_date,
       claim_ids_json, claim_nos_json, claim_count, total_cents, risk_event_id, fingerprint, detected_at, updated_at
     ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(fingerprint) DO UPDATE SET
       anchor_date = excluded.anchor_date,
       claim_nos_json = excluded.claim_nos_json,
       claim_count = excluded.claim_count,
       total_cents = excluded.total_cents,
       risk_event_id = COALESCE(excluded.risk_event_id, ex_split_alert_log.risk_event_id),
       updated_at = excluded.updated_at`
  ).run(
    claim.org_id, cluster.normalizedCategory, cluster.supplierOrPayee, cluster.windowDays, cluster.anchorDate,
    JSON.stringify(cluster.claimIds), JSON.stringify(cluster.claimNos), cluster.claimIds.length, cluster.totalCents,
    riskEventId, cluster.fingerprint, now, now,
  );
  return riskEventId;
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
    // 至少命中 N 项:不足时一条发现,列出已识别与未识别的材料
    const hit = c.required_keywords.length - missing.length;
    if (hit < c.keyword_min_matches) {
      const found = c.required_keywords.filter((kw) => !missing.includes(kw));
      add('MATERIAL_MISSING', 'medium',
        `材料不足:${c.policy_title}第 ${c.clause_no} 条要求「${c.required_keywords.join('、')}」至少 ${c.keyword_min_matches} 项,仅识别到 ${found.length ? found.map((k) => `「${k}」`).join('、') : '0 项'}`,
        [clauseRef(c), ...attachments.map(attachmentRef)], c.id);
    }
  }

  // GAP-20 / §8.1.7 采购类小额直接报销书面比价报告核验（EXP_SMALL_PROC_NO_COMPARISON）
  const limitCents = input.smallProcLimitCents ?? 3_000_000n;
  const compareAttachments = attachments.filter((a) =>
    isPriceComparisonAttachment(a) || /比价|询价|市场调研|三家报价|比选/.test(ocrTexts.get(a.id)?.text ?? '')
  );
  if (
    claim.is_procurement_expense === 1 &&
    claim.amount_cents > 0n &&
    claim.amount_cents <= limitCents &&
    compareAttachments.length === 0 &&
    !input.linkedContractComparisonRef
  ) {
    const sev: FindingSeverity = claim.amount_cents >= 1_000_000n && claim.contract_id === null ? 'high' : 'medium';
    add(
      'EXP_SMALL_PROC_NO_COMPARISON',
      sev,
      `采购类直接报销金额 ${money(claim.amount_cents)} 元（≤ ${money(limitCents)} 元）未上传书面市场比价报告，请按《采购管理办法》§8.1.7 补充市场比价依据`,
      [fieldRef('amount', money(claim.amount_cents)), fieldRef('expenseType', claim.expense_type)],
    );
  }

  // GAP-20 / §8.1.7 & PW_14 同组织滚动窗口高频小额拆单监测（EXP_SPLIT_BELOW_30K）
  if (input.splitCluster) {
    const sc = input.splitCluster;
    add(
      'EXP_SPLIT_BELOW_30K',
      'high',
      `同单位连续 ${sc.windowDays} 日内（${sc.windowStart}～${sc.windowEnd}）同类小额报销共 ${sc.claimIds.length} 笔（${sc.claimNos.join('、')}），累计 ${money(sc.totalCents)} 元 ≥ ${money(limitCents)} 元，疑似拆单规避集中采购程序`,
      [fieldRef('amount', money(claim.amount_cents)), fieldRef('occurredDate', claim.occurred_date)],
    );
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

  const smallProcLimitCents = BigInt(getSetting<number>(db, 'expense.small_procurement_limit_cents'));
  const splitWindowDays = getSetting<number>(db, 'expense.split_window_days');
  const linkedContractComparisonRef = resolveLinkedContractComparisonRef(db, claim.contract_id);
  const splitCluster = detectClaimSplitCluster(db, claim, smallProcLimitCents, splitWindowDays);
  const input: AuditInput = {
    claim, lines, attachments, clauses, ocrTexts: ocr.texts,
    smallProcLimitCents, linkedContractComparisonRef, splitCluster,
  };
  const rules = evaluateRules(input);
  handle?.step({ name: '规则核对', type: 'rule', status: 'success', detail: `${rules.findings.length} 项发现`, sourceRefs: rules.usedClauses.map((c) => ({ clauseId: c.id })) });
  handle?.progress(600, '规则核对完成');

  const t1 = Date.now();
  const model = await runModel(input, rules.usedClauses);
  handle?.step({ name: '模型语义建议', type: 'model', status: model.status === 'ok' ? 'success' : model.status === 'unavailable' ? 'skipped' : 'error', detail: model.status, elapsedMs: Date.now() - t1 });
  handle?.checkCancelled();

  const policyRefs = [...new Map(rules.usedClauses.map((c) => [c.policy_id, { policyId: c.policy_id, code: c.policy_code, version: c.policy_version }])).values()];

  return db.transaction((): AuditRunResult => {
    const fresh = visibleClaim(db, claimId);
    if (fresh.review_version !== reviewVersion || !['submitted', 'audited'].includes(fresh.status)
      || fresh.content_sha256 !== claimContentHash(fresh, claimLines(db, claimId), claimAttachments(db, claimId))) {
      return { runId: null, skipped: '报销单在审核期间已变化,本次运行不写入' };
    }
    const now = new Date().toISOString();
    // 模型在事务外运行期间，其他报销单可能被驳回；落库前以最新有效单据重算客观证据。
    const liveSplit = detectClaimSplitCluster(db, fresh, smallProcLimitCents, splitWindowDays);
    const finalRules = evaluateRules({ ...input, claim: fresh, splitCluster: liveSplit,
      linkedContractComparisonRef: resolveLinkedContractComparisonRef(db, fresh.contract_id) });
    const findings = [...ocr.findings, ...finalRules.findings, ...model.findings];
    const risk = riskLevelOf(findings);
    const runId = Number(db.prepare(`INSERT INTO ex_audit_run (claim_id, review_version, content_sha256, job_id, risk_level, ocr_status, model_status, policy_refs_json, created_by_user_id, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(claimId, reviewVersion, fresh.content_sha256, handle?.id ?? null, risk, ocr.status, model.status, JSON.stringify(policyRefs), currentAuth()?.userId ?? null, now).lastInsertRowid);
    const ins = db.prepare('INSERT INTO ex_finding (run_id, source, code, severity, message, evidence_json, clause_id) VALUES (?, ?, ?, ?, ?, ?, ?)');
    for (const f of findings) ins.run(runId, f.source, f.code, f.severity, f.message, JSON.stringify(f.evidence), f.clauseId);
    if (fresh.status === 'submitted') db.prepare("UPDATE ex_claim SET status = 'audited', updated_at = ? WHERE id = ?").run(now, claimId);
    if (liveSplit) {
      persistSplitAlertAndRiskClue(db, fresh, liveSplit, now);
    }
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
