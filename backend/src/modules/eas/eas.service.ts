/**
 * EAS 原始事实与期间控制(AC-F05)。规则见 specs/implementation.md T-3「EAS」。
 *
 * - 解析/校验与原件落盘在写事务之外;写入是一个 BEGIN IMMEDIATE 短事务(批次 + 全部行)。
 * - 原始行不可改(迁移 V44 触发器);激活/锁定/更正只改批次、集合、锁的状态。
 * - 组织范围:所有读写先按服务端 AuthContext 校验批次/集合/锁/更正所属组织,范围外一律 404。
 */
import type { DB } from '../../db/connection';
import { AppError } from '../../core/errors';
import { currentAuth } from '../../core/request-context';
import { centsToDecimalString } from '../../core/decimal';
import { writeLog } from '../audit/log';
import { resolveEntity } from '../master/master.service';
import { notVisible, orgInScope, resolveOrgScope, type OrgScope } from '../security/scope';
import { assertDistinctReviewer, requireAdmin } from '../security/review';
import { storeFile, type ObjectStore } from '../files/object-store';
import { readTable } from '../io/table-reader';
import { easExtraAliases } from '../settings/import-aliases.service';
import { EAS_PARSER_VERSION, parseEasTable, type AuxLine, type BalanceLine, type ParsedEas, type VoucherLine } from './eas.parse';
import type {
  EasActivateRequest, EasAuxRequirementCreate, EasBatchDto, EasBatchLinesDto, EasCorrectionCreate, EasCorrectionDto, EasCorrectionReview,
  EasDataType, EasImportForm, EasLockRequest, EasPeriodLockDto, EasPeriodStatusDto, EasPrecheckRequest, EasReconResultDto,
  EasReconSetDto, EasRuleStatus,
} from '../../contracts/eas';

const nowIso = () => new Date().toISOString();
const TOLERANCE = 1n;
/** 主数据映射的来源系统标识(映射要求小写)。 */
export const EAS_SOURCE_SYSTEM = 'eas';
const REQUIRED_TYPES: EasDataType[] = ['voucher', 'balance', 'auxiliary'];
const PENDING_CORRECTION = ['submitted', 'candidate_import', 'pending_review'];

/* ================= 范围 ================= */

function scope(db: DB): OrgScope {
  const auth = currentAuth();
  return auth ? resolveOrgScope(db, auth) : { all: true };
}

function assertOrg(db: DB, orgId: number, what: string): void {
  if (!orgInScope(scope(db), orgId)) throw notVisible(what);
}

function orgScopeSql(db: DB, column: string): { sql: string; params: number[] } {
  const s = scope(db);
  if (s.all) return { sql: '1=1', params: [] };
  if (s.orgIds.size === 0) return { sql: '0=1', params: [] };
  const ids = [...s.orgIds];
  return { sql: `${column} IN (${ids.map(() => '?').join(',')})`, params: ids };
}

function orgName(db: DB, orgId: number): string {
  return (db.prepare('SELECT name FROM org WHERE id = ?').get(orgId) as { name: string } | undefined)?.name ?? `#${orgId}`;
}

function conflict(code: string, message: string, details?: unknown): AppError {
  return new AppError(code, message, 409, undefined, details);
}

/* ================= 行映射 ================= */

interface BatchRow {
  id: number; data_type: EasDataType; org_id: number; source_company: string; period: string; file_object_id: number;
  file_sha256: string; file_name: string; row_count: number; debit_total_cents: bigint; credit_total_cents: bigint;
  status: 'candidate' | 'active' | 'superseded'; is_current: number; correction_id: number | null; created_by_user_id: number | null; created_at: string;
}
interface SetRow {
  id: number; org_id: number; period: string; status: 'incomplete' | 'failed' | 'passed'; is_current: number; correction_id: number | null;
  error_count: number; warning_count: number; summary_json: string; version: number; created_by_user_id: number | null; created_at: string;
  activated_at: string | null;
}
interface LockRow {
  id: number; org_id: number; period: string; status: 'locked' | 'unlocked'; set_id: number; reason: string; version: number;
  locked_at: string | null; unlocked_at: string | null;
}
interface CorrectionRow {
  id: number; org_id: number; period: string; status: EasCorrectionDto['status']; reason: string; expected_current_set_id: number;
  candidate_set_id: number | null; version: number; submitted_by_user_id: number | null; submitted_at: string;
  reviewed_by_user_id: number | null; reviewed_at: string | null; review_comment: string | null;
}

/** 读批次(金额列用 safeIntegers,再把非金额整数转回 number)。 */
function batchRows(db: DB, where: string, params: unknown[]): BatchRow[] {
  const rows = db.prepare(`SELECT * FROM eas_batch WHERE ${where}`).safeIntegers(true).all(...params) as Record<string, unknown>[];
  return rows.map((r) => ({
    ...(r as unknown as BatchRow),
    id: Number(r.id), org_id: Number(r.org_id), file_object_id: Number(r.file_object_id), row_count: Number(r.row_count),
    is_current: Number(r.is_current), correction_id: r.correction_id == null ? null : Number(r.correction_id),
    created_by_user_id: r.created_by_user_id == null ? null : Number(r.created_by_user_id),
    debit_total_cents: r.debit_total_cents as bigint, credit_total_cents: r.credit_total_cents as bigint,
  }));
}

function batchDto(db: DB, b: BatchRow, extra: Partial<EasBatchDto> = {}): EasBatchDto {
  return {
    id: b.id, dataType: b.data_type, orgId: b.org_id, orgName: orgName(db, b.org_id), sourceCompany: b.source_company, period: b.period,
    fileName: b.file_name, fileSha256: b.file_sha256, rowCount: b.row_count, debitTotal: centsToDecimalString(b.debit_total_cents),
    creditTotal: centsToDecimalString(b.credit_total_cents), status: b.status, isCurrent: b.is_current === 1, correctionId: b.correction_id,
    createdAt: b.created_at, ...extra,
  };
}

function getSetRow(db: DB, id: number): SetRow {
  const row = db.prepare('SELECT * FROM eas_recon_set WHERE id = ?').get(id) as SetRow | undefined;
  if (!row || !orgInScope(scope(db), row.org_id)) throw notVisible('对账集合');
  return row;
}

function setDto(db: DB, s: SetRow): EasReconSetDto {
  const batches = db.prepare(`SELECT sb.data_type AS dataType, sb.batch_id AS batchId, b.file_name AS fileName
    FROM eas_recon_set_batch sb JOIN eas_batch b ON b.id = sb.batch_id WHERE sb.set_id = ? ORDER BY sb.data_type`).all(s.id) as EasReconSetDto['batches'];
  const results = (db.prepare('SELECT * FROM eas_recon_result WHERE set_id = ? ORDER BY id').safeIntegers(true).all(s.id) as Record<string, unknown>[])
    .map((r): EasReconResultDto => ({
      ruleCode: String(r.rule_code), status: r.status as EasRuleStatus, diffCount: Number(r.diff_count),
      diffAmount: centsToDecimalString(r.diff_cents as bigint), details: JSON.parse(String(r.details_json)) as Record<string, unknown>,
    }));
  return {
    id: s.id, orgId: s.org_id, orgName: orgName(db, s.org_id), period: s.period, status: s.status, isCurrent: s.is_current === 1,
    correctionId: s.correction_id, errorCount: s.error_count, warningCount: s.warning_count, version: s.version, createdAt: s.created_at,
    activatedAt: s.activated_at, batches, results,
  };
}

function lockDto(db: DB, l: LockRow): EasPeriodLockDto {
  return {
    id: l.id, orgId: l.org_id, orgName: orgName(db, l.org_id), period: l.period, status: l.status, setId: l.set_id, reason: l.reason,
    version: l.version, lockedAt: l.locked_at, unlockedAt: l.unlocked_at,
  };
}

function correctionDto(db: DB, c: CorrectionRow): EasCorrectionDto {
  const reviews = db.prepare(`SELECT action, comment, exception_reason AS exceptionReason, reviewer_user_id AS reviewerUserId, created_at AS createdAt
    FROM eas_correction_review WHERE correction_id = ? ORDER BY id`).all(c.id) as EasCorrectionDto['reviews'];
  return {
    id: c.id, orgId: c.org_id, orgName: orgName(db, c.org_id), period: c.period, status: c.status, reason: c.reason,
    expectedCurrentSetId: c.expected_current_set_id, candidateSetId: c.candidate_set_id, version: c.version,
    submittedByUserId: c.submitted_by_user_id, submittedAt: c.submitted_at, reviewedByUserId: c.reviewed_by_user_id,
    reviewedAt: c.reviewed_at, reviewComment: c.review_comment,
    candidateBatches: batchRows(db, 'correction_id = ? ORDER BY id', [c.id]).map((b) => batchDto(db, b)),
    reviews,
  };
}

function lockedRow(db: DB, orgId: number, period: string): LockRow | undefined {
  return db.prepare("SELECT * FROM eas_period_lock WHERE org_id = ? AND period = ? AND status = 'locked'").get(orgId, period) as LockRow | undefined;
}

function currentSetRow(db: DB, orgId: number, period: string): SetRow | undefined {
  return db.prepare('SELECT * FROM eas_recon_set WHERE org_id = ? AND period = ? AND is_current = 1').get(orgId, period) as SetRow | undefined;
}

/* ================= 导入 ================= */

/** EAS 公司 → 组织:只接受精确编码、精确名称或显式映射(sourceSystem=eas);去后缀的模糊匹配不自动采用。 */
export function resolveEasCompany(db: DB, company: string): { orgId: number } {
  const result = resolveEntity(db, 'org', { code: company, name: company, sourceSystem: EAS_SOURCE_SYSTEM });
  if (result.targetId && ['exact_code', 'mapping_code', 'exact_name', 'mapping_name'].includes(result.matchedBy)) return { orgId: result.targetId };
  const candidates = result.candidates.length ? result.candidates : result.targetId ? [{ id: result.targetId, code: result.targetCode ?? '', name: result.targetName ?? '' }] : [];
  throw new AppError('EAS_COMPANY_UNRESOLVED',
    `文件中的公司“${company}”无法唯一确定组织:请在主数据映射中为来源系统 eas 登记该名称,或使用组织编码`, 422, undefined,
    { company, matchedBy: result.matchedBy, candidates: candidates.map((c) => ({ code: c.code, name: c.name })) });
}

export interface EasImportInput { content: Buffer; fileName: string; contentType?: string; form: EasImportForm }

export async function importEasFile(db: DB, store: ObjectStore, input: EasImportInput): Promise<EasBatchDto> {
  const table = await readTable(input.content, input.fileName);
  const parsed = parseEasTable(table, input.form.dataType, easExtraAliases(db, input.form.dataType));
  const { orgId } = resolveEasCompany(db, parsed.company);
  if (!orgInScope(scope(db), orgId)) {
    throw new AppError('SCOPE_RESTRICTED', '文件中的公司不在当前账号的授权组织范围内', 403);
  }
  if (input.form.orgId && input.form.orgId !== orgId) {
    throw new AppError('EAS_ORG_MISMATCH', `文件中的公司属于“${orgName(db, orgId)}”,与页面所选组织不一致`, 409);
  }
  // 原件落盘在写事务之外;登记是一条幂等语句
  const file = storeFile(db, store, input.content, { originalName: input.fileName, contentType: input.contentType });
  const auth = currentAuth();
  const write = db.transaction((): EasBatchDto => {
    const correctionId = input.form.correctionId ?? null;
    const existing = batchRows(db, 'org_id = ? AND period = ? AND data_type = ? AND file_sha256 = ? AND IFNULL(correction_id, 0) = ?',
      [orgId, parsed.period, parsed.dataType, file.sha256, correctionId ?? 0])[0];
    if (existing) return batchDto(db, existing, { replayed: true });

    const lock = lockedRow(db, orgId, parsed.period);
    if (lock && !correctionId) {
      throw conflict('EAS_PERIOD_LOCKED', `${orgName(db, orgId)} ${parsed.period} 已锁定,请提交锁后更正申请并在申请下导入候选文件`);
    }
    if (!lock && correctionId) throw conflict('EAS_CORRECTION_NOT_REQUIRED', '该期间未锁定,不需要走更正通道,请直接导入');
    if (correctionId) {
      const c = db.prepare('SELECT * FROM eas_correction WHERE id = ?').get(correctionId) as CorrectionRow | undefined;
      if (!c || c.org_id !== orgId || c.period !== parsed.period) throw notVisible('更正申请');
      if (!['submitted', 'candidate_import'].includes(c.status)) throw conflict('EAS_CORRECTION_STATE', '更正申请当前不能继续导入候选文件');
      if (auth && c.submitted_by_user_id !== auth.userId) throw new AppError('FORBIDDEN', '只能向本人提交的更正申请导入候选文件', 403);
      db.prepare("UPDATE eas_correction SET status = 'candidate_import', version = version + 1 WHERE id = ?").run(c.id);
    }

    let info: { lastInsertRowid: number | bigint };
    try {
      info = db.prepare(`INSERT INTO eas_batch (data_type, org_id, source_company, period, file_object_id, file_sha256, file_name, row_count,
      debit_total_cents, credit_total_cents, status, is_current, correction_id, parser_version, created_by_user_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'candidate', 0, ?, ?, ?, ?)`).run(
      parsed.dataType, orgId, parsed.company, parsed.period, file.id, file.sha256, input.fileName.slice(0, 255), parsed.lines.length,
      parsed.debitTotal, parsed.creditTotal, correctionId, EAS_PARSER_VERSION, auth?.userId ?? null, nowIso());
    } catch (err) {
      // 幂等键唯一索引兜底(写事务已串行,正常不会触发)
      if (err instanceof Error && err.message.includes('idx_eas_batch_idem')) throw conflict('EAS_IDEMPOTENCY_CONFLICT', '同一文件正在被导入,请刷新后查看');
      throw err;
    }
    const batchId = Number(info.lastInsertRowid);
    insertLines(db, batchId, parsed);
    writeLog(db, 'eas.import', 'eas_batch', batchId, {
      dataType: parsed.dataType, orgId, period: parsed.period, rows: parsed.lines.length, fileSha256: file.sha256, correctionId,
    });
    return batchDto(db, batchRows(db, 'id = ?', [batchId])[0]);
  });
  return write.immediate();
}

function insertLines(db: DB, batchId: number, parsed: ParsedEas): void {
  if (parsed.dataType === 'voucher') {
    const stmt = db.prepare(`INSERT INTO eas_voucher_line (batch_id, source_row, voucher_date, voucher_no, entry_no, account_code, account_name, summary,
      debit_cents, credit_cents, project_code, project_name, dept_name, supplier_name, fund_source) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const l of parsed.lines as VoucherLine[]) {
      stmt.run(batchId, l.sourceRow, l.voucherDate, l.voucherNo, l.entryNo, l.accountCode, l.accountName, l.summary, l.debit, l.credit,
        l.projectCode, l.projectName, l.deptName, l.supplierName, l.fundSource);
    }
  } else if (parsed.dataType === 'balance') {
    const stmt = db.prepare(`INSERT INTO eas_balance_line (batch_id, source_row, account_code, account_name, begin_debit_cents, begin_credit_cents,
      debit_cents, credit_cents, end_debit_cents, end_credit_cents, project_code, project_name, dept_name, supplier_name)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const l of parsed.lines as BalanceLine[]) {
      stmt.run(batchId, l.sourceRow, l.accountCode, l.accountName, l.beginDebit, l.beginCredit, l.debit, l.credit, l.endDebit, l.endCredit,
        l.projectCode, l.projectName, l.deptName, l.supplierName);
    }
  } else {
    const stmt = db.prepare(`INSERT INTO eas_aux_line (batch_id, source_row, aux_type, aux_code, aux_name, account_code, account_name,
      begin_cents, debit_cents, credit_cents, end_cents, supplier_name) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const l of parsed.lines as AuxLine[]) {
      stmt.run(batchId, l.sourceRow, l.auxType, l.auxCode, l.auxName, l.accountCode, l.accountName, l.begin, l.debit, l.credit, l.end, l.supplierName);
    }
  }
}

/* ================= 预检(对账) ================= */

type Totals = Map<string, { beginDebit: bigint; beginCredit: bigint; debit: bigint; credit: bigint; endDebit: bigint; endCredit: bigint }>;

function voucherTotals(db: DB, batchId: number): Map<string, { debit: bigint; credit: bigint }> {
  const rows = db.prepare(`SELECT account_code, SUM(debit_cents) AS d, SUM(credit_cents) AS c FROM eas_voucher_line WHERE batch_id = ? GROUP BY account_code`)
    .safeIntegers(true).all(batchId) as { account_code: string; d: bigint; c: bigint }[];
  return new Map(rows.map((r) => [r.account_code, { debit: r.d, credit: r.c }]));
}

function balanceTotals(db: DB, batchId: number): Totals {
  const rows = db.prepare(`SELECT account_code, SUM(begin_debit_cents) AS bd, SUM(begin_credit_cents) AS bc, SUM(debit_cents) AS d,
    SUM(credit_cents) AS c, SUM(end_debit_cents) AS ed, SUM(end_credit_cents) AS ec FROM eas_balance_line WHERE batch_id = ? GROUP BY account_code`)
    .safeIntegers(true).all(batchId) as Record<string, bigint | string>[];
  return new Map(rows.map((r) => [String(r.account_code), {
    beginDebit: r.bd as bigint, beginCredit: r.bc as bigint, debit: r.d as bigint, credit: r.c as bigint, endDebit: r.ed as bigint, endCredit: r.ec as bigint,
  }]));
}

function auxTotals(db: DB, batchId: number): Map<string, { begin: bigint; debit: bigint; credit: bigint; end: bigint }> {
  const rows = db.prepare(`SELECT account_code, aux_type, SUM(begin_cents) AS b, SUM(debit_cents) AS d, SUM(credit_cents) AS c, SUM(end_cents) AS e
    FROM eas_aux_line WHERE batch_id = ? GROUP BY account_code, aux_type`).safeIntegers(true).all(batchId) as Record<string, bigint | string>[];
  return new Map(rows.map((r) => [`${r.account_code}|${r.aux_type}`, { begin: r.b as bigint, debit: r.d as bigint, credit: r.c as bigint, end: r.e as bigint }]));
}

const abs = (v: bigint) => (v < 0n ? -v : v);
const s = (v: bigint) => centsToDecimalString(v);

export function previousPeriod(period: string): string {
  const [y, m] = period.split('-').map(Number);
  return m === 1 ? `${y - 1}-12` : `${y}-${String(m - 1).padStart(2, '0')}`;
}

interface RuleResult { ruleCode: string; status: EasRuleStatus; diffCount: number; diffCents: bigint; details: Record<string, unknown> }

function runRules(db: DB, orgId: number, period: string, batches: Partial<Record<EasDataType, BatchRow>>): RuleResult[] {
  const results: RuleResult[] = [];
  const missing = REQUIRED_TYPES.filter((t) => !batches[t]);
  results.push({ ruleCode: 'required_files', status: missing.length ? 'incomplete' : 'passed', diffCount: missing.length, diffCents: 0n, details: { missingDataTypes: missing } });

  const balance = batches.balance ? balanceTotals(db, batches.balance.id) : null;
  if (batches.voucher && balance) {
    const voucher = voucherTotals(db, batches.voucher.id);
    const diffs: Record<string, string>[] = [];
    let total = 0n;
    for (const code of [...new Set([...voucher.keys(), ...balance.keys()])].sort()) {
      const v = voucher.get(code) ?? { debit: 0n, credit: 0n };
      const b = balance.get(code);
      const dd = abs(v.debit - (b?.debit ?? 0n));
      const cd = abs(v.credit - (b?.credit ?? 0n));
      if (dd > TOLERANCE || cd > TOLERANCE) {
        total += dd + cd;
        diffs.push({ accountCode: code, voucherDebit: s(v.debit), balanceDebit: s(b?.debit ?? 0n), voucherCredit: s(v.credit), balanceCredit: s(b?.credit ?? 0n) });
      }
    }
    results.push({ ruleCode: 'voucher_balance_movement', status: diffs.length ? 'failed' : 'passed', diffCount: diffs.length, diffCents: total, details: { accounts: diffs.slice(0, 100) } });
  }

  if (balance) {
    const prevPeriod = previousPeriod(period);
    const prevSet = currentSetRow(db, orgId, prevPeriod);
    const prevBalanceId = prevSet
      ? (db.prepare("SELECT batch_id FROM eas_recon_set_batch WHERE set_id = ? AND data_type = 'balance'").get(prevSet.id) as { batch_id: number } | undefined)?.batch_id
      : undefined;
    if (!prevBalanceId) {
      results.push({ ruleCode: 'period_continuity', status: 'warning', diffCount: 0, diffCents: 0n, details: { previousPeriod: prevPeriod, message: '未找到上期已激活集合,本期作为对账基线' } });
    } else {
      const prev = balanceTotals(db, prevBalanceId);
      const diffs: Record<string, string>[] = [];
      let total = 0n;
      for (const code of [...new Set([...prev.keys(), ...balance.keys()])].sort()) {
        const p = prev.get(code); const c = balance.get(code);
        const prevEnd = (p?.endDebit ?? 0n) - (p?.endCredit ?? 0n);
        const curBegin = (c?.beginDebit ?? 0n) - (c?.beginCredit ?? 0n);
        const d = abs(prevEnd - curBegin);
        if (d > TOLERANCE) { total += d; diffs.push({ accountCode: code, previousEnding: s(prevEnd), currentOpening: s(curBegin) }); }
      }
      results.push({ ruleCode: 'period_continuity', status: diffs.length ? 'failed' : 'passed', diffCount: diffs.length, diffCents: total, details: { previousPeriod: prevPeriod, previousSetId: prevSet!.id, accounts: diffs.slice(0, 100) } });
    }
  }

  const reqs = db.prepare("SELECT account_code, aux_type FROM eas_aux_requirement WHERE org_id = ? AND status = 'active' ORDER BY account_code, aux_type").all(orgId) as { account_code: string; aux_type: string }[];
  if (!reqs.length) {
    results.push({ ruleCode: 'auxiliary_requirements', status: 'warning', diffCount: 0, diffCents: 0n, details: { message: '未配置辅助核算要求,未配置范围不参与阻断' } });
  } else if (!batches.auxiliary || !balance) {
    results.push({ ruleCode: 'auxiliary_requirements', status: 'incomplete', diffCount: reqs.length, diffCents: 0n, details: { message: '已配置辅助核算要求,但缺少辅助核算或余额文件' } });
  } else {
    const aux = auxTotals(db, batches.auxiliary.id);
    const diffs: Record<string, string>[] = [];
    let total = 0n;
    for (const req of reqs) {
      const a = aux.get(`${req.account_code}|${req.aux_type}`);
      const b = balance.get(req.account_code);
      if (!a || !b) { diffs.push({ accountCode: req.account_code, auxType: req.aux_type, reason: '缺少辅助核算或余额数据' }); continue; }
      // 辅助核算期初/期末为带符号余额(借正贷负),与余额表借贷差比较
      const expected = { begin: b.beginDebit - b.beginCredit, debit: b.debit, credit: b.credit, end: b.endDebit - b.endCredit };
      const d = abs(a.begin - expected.begin) + abs(a.debit - expected.debit) + abs(a.credit - expected.credit) + abs(a.end - expected.end);
      const any = [abs(a.begin - expected.begin), abs(a.debit - expected.debit), abs(a.credit - expected.credit), abs(a.end - expected.end)].some((x) => x > TOLERANCE);
      if (any) { total += d; diffs.push({ accountCode: req.account_code, auxType: req.aux_type, auxEnding: s(a.end), balanceEnding: s(expected.end), difference: s(d) }); }
    }
    results.push({ ruleCode: 'auxiliary_requirements', status: diffs.length ? 'failed' : 'passed', diffCount: diffs.length, diffCents: total, details: { requirements: diffs.slice(0, 100) } });
  }
  return results;
}

function selectBatches(db: DB, orgId: number, period: string, batchIds: number[] | undefined, correction: CorrectionRow | null): Partial<Record<EasDataType, BatchRow>> {
  const selected: Partial<Record<EasDataType, BatchRow>> = {};
  const current = currentSetRow(db, orgId, period);
  const currentBatches = current
    ? batchRows(db, 'id IN (SELECT batch_id FROM eas_recon_set_batch WHERE set_id = ?)', [current.id])
    : batchRows(db, "org_id = ? AND period = ? AND status = 'active'", [orgId, period]);
  if (correction) {
    if (!current || current.id !== correction.expected_current_set_id) throw conflict('EAS_CURRENT_SET_CHANGED', '更正申请的原生效集合已变化');
    for (const b of currentBatches) selected[b.data_type] = b;
    const candidates = batchRows(db, 'correction_id = ? ORDER BY id', [correction.id]);
    if (!candidates.length) throw conflict('EAS_CORRECTION_STATE', '更正申请尚未导入任何候选文件');
    for (const b of candidates) selected[b.data_type] = b; // 同类取最新
    return selected;
  }
  if (batchIds?.length) {
    const rows = batchRows(db, `org_id = ? AND period = ? AND correction_id IS NULL AND id IN (${batchIds.map(() => '?').join(',')})`, [orgId, period, ...batchIds]);
    if (rows.length !== new Set(batchIds).size) throw notVisible('候选批次');
    for (const b of rows) {
      if (selected[b.data_type]) throw new AppError('VALIDATION_FAILED', '每类数据只能选择一个批次', 400);
      selected[b.data_type] = b;
    }
    return selected;
  }
  // 默认:每类取最新候选;某类没有候选时沿用当前生效批次(只重导其中一类的常见情形)
  for (const b of batchRows(db, "org_id = ? AND period = ? AND status = 'candidate' AND correction_id IS NULL ORDER BY id DESC", [orgId, period])) {
    selected[b.data_type] ??= b;
  }
  for (const b of currentBatches) selected[b.data_type] ??= b;
  return selected;
}

function precheckInTx(db: DB, orgId: number, period: string, batchIds: number[] | undefined, correction: CorrectionRow | null): SetRow {
  const batches = selectBatches(db, orgId, period, batchIds, correction);
  if (!Object.keys(batches).length) throw new AppError('EAS_NO_BATCH', '该组织期间还没有导入任何 EAS 文件', 409);
  const results = runRules(db, orgId, period, batches);
  const errorCount = results.filter((r) => r.status === 'failed' || r.status === 'incomplete').length;
  const warningCount = results.filter((r) => r.status === 'warning').length;
  const status = results.some((r) => r.status === 'failed') ? 'failed' : results.some((r) => r.status === 'incomplete') ? 'incomplete' : 'passed';
  const summary = {
    selectedBatches: Object.fromEntries(Object.entries(batches).map(([t, b]) => [t, b!.id])),
    tolerance: '0.01',
    resultCounts: Object.fromEntries(['passed', 'warning', 'incomplete', 'failed'].map((st) => [st, results.filter((r) => r.status === st).length])),
  };
  const auth = currentAuth();
  const setId = Number(db.prepare(`INSERT INTO eas_recon_set (org_id, period, status, is_current, correction_id, error_count, warning_count, summary_json,
    version, created_by_user_id, created_at) VALUES (?, ?, ?, 0, ?, ?, ?, ?, 1, ?, ?)`).run(
    orgId, period, status, correction?.id ?? null, errorCount, warningCount, JSON.stringify(summary), auth?.userId ?? null, nowIso()).lastInsertRowid);
  const link = db.prepare('INSERT INTO eas_recon_set_batch (set_id, data_type, batch_id) VALUES (?, ?, ?)');
  for (const [t, b] of Object.entries(batches)) link.run(setId, t, b!.id);
  const ins = db.prepare('INSERT INTO eas_recon_result (set_id, rule_code, status, diff_count, diff_cents, details_json) VALUES (?, ?, ?, ?, ?, ?)');
  for (const r of results) ins.run(setId, r.ruleCode, r.status, r.diffCount, r.diffCents, JSON.stringify(r.details));
  if (correction) {
    db.prepare('UPDATE eas_correction SET candidate_set_id = ?, status = ?, version = version + 1 WHERE id = ?')
      .run(setId, status === 'passed' ? 'pending_review' : 'candidate_import', correction.id);
  }
  writeLog(db, 'eas.precheck', 'eas_recon_set', setId, { orgId, period, status, errorCount, warningCount, correctionId: correction?.id ?? null });
  return db.prepare('SELECT * FROM eas_recon_set WHERE id = ?').get(setId) as SetRow;
}

export function precheck(db: DB, input: EasPrecheckRequest): EasReconSetDto {
  assertOrg(db, input.orgId, '组织');
  const row = db.transaction(() => precheckInTx(db, input.orgId, input.period, input.batchIds, null)).immediate();
  return setDto(db, row);
}

/* ================= 激活 ================= */

function activateSetInTx(db: DB, target: SetRow): void {
  const auth = currentAuth();
  const newBatchIds = (db.prepare('SELECT batch_id FROM eas_recon_set_batch WHERE set_id = ?').all(target.id) as { batch_id: number }[]).map((r) => r.batch_id);
  const olds = db.prepare('SELECT id FROM eas_recon_set WHERE org_id = ? AND period = ? AND is_current = 1 AND id <> ?').all(target.org_id, target.period, target.id) as { id: number }[];
  for (const old of olds) {
    db.prepare('UPDATE eas_recon_set SET is_current = 0, version = version + 1 WHERE id = ?').run(old.id);
  }
  // 旧的生效批次中不属于新集合的全部置为 superseded;新集合批次置为生效
  const placeholders = newBatchIds.map(() => '?').join(',');
  db.prepare(`UPDATE eas_batch SET status = 'superseded', is_current = 0 WHERE org_id = ? AND period = ? AND is_current = 1 AND id NOT IN (${placeholders})`)
    .run(target.org_id, target.period, ...newBatchIds);
  db.prepare(`UPDATE eas_batch SET status = 'active', is_current = 1 WHERE id IN (${placeholders})`).run(...newBatchIds);
  db.prepare('UPDATE eas_recon_set SET is_current = 1, version = version + 1, activated_by_user_id = ?, activated_at = ? WHERE id = ?')
    .run(auth?.userId ?? null, nowIso(), target.id);
}

export function activateSet(db: DB, setId: number, input: EasActivateRequest): EasReconSetDto {
  const row = db.transaction(() => {
    const target = getSetRow(db, setId);
    if (target.correction_id) throw conflict('EAS_CORRECTION_REVIEW_REQUIRED', '更正候选集合只能通过复核批准生效');
    if (target.version !== input.expectedVersion) throw conflict('VERSION_CONFLICT', '对账集合已被其他人更新,请刷新后重试', { currentVersion: target.version });
    if (target.is_current) return target;
    if (target.status !== 'passed') throw conflict('EAS_RECON_NOT_PASSED', '对账未通过,不能激活');
    if (lockedRow(db, target.org_id, target.period)) throw conflict('EAS_PERIOD_LOCKED', '已锁期间不能直接激活新集合,请走锁后更正');
    const current = currentSetRow(db, target.org_id, target.period);
    if ((current?.id ?? null) !== input.expectedCurrentSetId) {
      throw conflict('EAS_CURRENT_SET_CHANGED', '当前生效集合已被其他人更换,请刷新后确认', { currentSetId: current?.id ?? null });
    }
    activateSetInTx(db, target);
    writeLog(db, 'eas.activate', 'eas_recon_set', target.id, { orgId: target.org_id, period: target.period });
    return db.prepare('SELECT * FROM eas_recon_set WHERE id = ?').get(target.id) as SetRow;
  }).immediate();
  return setDto(db, row);
}

/* ================= 期间锁 ================= */

function addLockEvent(db: DB, lock: LockRow, action: 'lock' | 'unlock' | 'correction_switch', setId: number, reason: string): void {
  db.prepare('INSERT INTO eas_period_lock_event (lock_id, action, set_id, reason, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(lock.id, action, setId, reason, currentAuth()?.userId ?? null, nowIso());
}

export function lockPeriod(db: DB, input: EasLockRequest): EasPeriodLockDto {
  assertOrg(db, input.orgId, '组织');
  const row = db.transaction(() => {
    const set = getSetRow(db, input.setId);
    if (set.org_id !== input.orgId || set.period !== input.period || set.status !== 'passed' || !set.is_current) {
      throw conflict('EAS_RECON_NOT_ACTIVE', '只能锁定已通过且当前生效的对账集合');
    }
    const existing = db.prepare('SELECT * FROM eas_period_lock WHERE org_id = ? AND period = ?').get(input.orgId, input.period) as LockRow | undefined;
    if (existing?.status === 'locked') {
      if (existing.set_id === set.id) return existing;
      throw conflict('EAS_PERIOD_ALREADY_LOCKED', '该期间已由另一对账集合锁定');
    }
    const auth = currentAuth();
    let lockId: number;
    if (existing) {
      db.prepare(`UPDATE eas_period_lock SET status = 'locked', set_id = ?, reason = ?, version = version + 1, locked_by_user_id = ?, locked_at = ?,
        unlocked_by_user_id = NULL, unlocked_at = NULL WHERE id = ?`).run(set.id, input.reason, auth?.userId ?? null, nowIso(), existing.id);
      lockId = existing.id;
    } else {
      lockId = Number(db.prepare(`INSERT INTO eas_period_lock (org_id, period, status, set_id, reason, version, locked_by_user_id, locked_at)
        VALUES (?, ?, 'locked', ?, ?, 1, ?, ?)`).run(input.orgId, input.period, set.id, input.reason, auth?.userId ?? null, nowIso()).lastInsertRowid);
    }
    const lock = db.prepare('SELECT * FROM eas_period_lock WHERE id = ?').get(lockId) as LockRow;
    addLockEvent(db, lock, 'lock', set.id, input.reason);
    writeLog(db, 'eas.period_lock', 'eas_period_lock', lockId, { orgId: input.orgId, period: input.period, setId: set.id, reason: input.reason });
    return lock;
  }).immediate();
  return lockDto(db, row);
}

export function unlockPeriod(db: DB, lockId: number, input: { expectedVersion: number; reason: string }): EasPeriodLockDto {
  requireAdmin(db, currentAuth(), '解锁 EAS 期间');
  const row = db.transaction(() => {
    const lock = db.prepare('SELECT * FROM eas_period_lock WHERE id = ?').get(lockId) as LockRow | undefined;
    if (!lock || !orgInScope(scope(db), lock.org_id)) throw notVisible('期间锁');
    if (lock.version !== input.expectedVersion) throw conflict('VERSION_CONFLICT', '期间锁已被其他人更新,请刷新后重试', { currentVersion: lock.version });
    if (lock.status !== 'locked') throw conflict('EAS_PERIOD_NOT_LOCKED', '该期间当前未锁定');
    const pending = db.prepare(`SELECT 1 FROM eas_correction WHERE org_id = ? AND period = ? AND status IN ('submitted','candidate_import','pending_review')`).get(lock.org_id, lock.period);
    if (pending) throw conflict('EAS_CORRECTION_PENDING', '存在待处理的更正申请,不能解锁');
    db.prepare(`UPDATE eas_period_lock SET status = 'unlocked', reason = ?, version = version + 1, unlocked_by_user_id = ?, unlocked_at = ? WHERE id = ?`)
      .run(input.reason, currentAuth()?.userId ?? null, nowIso(), lock.id);
    addLockEvent(db, lock, 'unlock', lock.set_id, input.reason);
    writeLog(db, 'eas.period_unlock', 'eas_period_lock', lock.id, { orgId: lock.org_id, period: lock.period, reason: input.reason });
    return db.prepare('SELECT * FROM eas_period_lock WHERE id = ?').get(lock.id) as LockRow;
  }).immediate();
  return lockDto(db, row);
}

/* ================= 锁后更正 ================= */

function getCorrectionRow(db: DB, id: number): CorrectionRow {
  const row = db.prepare('SELECT * FROM eas_correction WHERE id = ?').get(id) as CorrectionRow | undefined;
  if (!row || !orgInScope(scope(db), row.org_id)) throw notVisible('更正申请');
  return row;
}

export function createCorrection(db: DB, input: EasCorrectionCreate): EasCorrectionDto {
  assertOrg(db, input.orgId, '组织');
  const row = db.transaction(() => {
    const lock = lockedRow(db, input.orgId, input.period);
    if (!lock) throw conflict('EAS_PERIOD_NOT_LOCKED', '只有已锁期间可以申请锁后更正');
    if (lock.set_id !== input.expectedCurrentSetId) throw conflict('EAS_CURRENT_SET_CHANGED', '当前生效对账集合已变化,请刷新后重试');
    const pending = db.prepare(`SELECT id FROM eas_correction WHERE org_id = ? AND period = ? AND status IN ('submitted','candidate_import','pending_review')`).get(input.orgId, input.period);
    if (pending) throw conflict('EAS_CORRECTION_PENDING', '该公司期间已有待处理的更正申请');
    const id = Number(db.prepare(`INSERT INTO eas_correction (org_id, period, status, reason, expected_current_set_id, version, submitted_by_user_id, submitted_at)
      VALUES (?, ?, 'submitted', ?, ?, 1, ?, ?)`).run(input.orgId, input.period, input.reason, input.expectedCurrentSetId, currentAuth()?.userId ?? null, nowIso()).lastInsertRowid);
    writeLog(db, 'eas.correction_submit', 'eas_correction', id, { orgId: input.orgId, period: input.period, reason: input.reason });
    return db.prepare('SELECT * FROM eas_correction WHERE id = ?').get(id) as CorrectionRow;
  }).immediate();
  return correctionDto(db, row);
}

export function precheckCorrection(db: DB, correctionId: number): EasReconSetDto {
  const row = db.transaction(() => {
    const c = getCorrectionRow(db, correctionId);
    const auth = currentAuth();
    if (auth && c.submitted_by_user_id !== auth.userId) throw new AppError('FORBIDDEN', '只能预检本人提交的更正申请', 403);
    if (!['submitted', 'candidate_import'].includes(c.status)) throw conflict('EAS_CORRECTION_STATE', '更正申请当前不能预检');
    return precheckInTx(db, c.org_id, c.period, undefined, c);
  }).immediate();
  return setDto(db, row);
}

export function reviewCorrection(db: DB, correctionId: number, input: EasCorrectionReview): EasCorrectionDto {
  const row = db.transaction(() => {
    const c = getCorrectionRow(db, correctionId);
    if (c.version !== input.expectedVersion) throw conflict('VERSION_CONFLICT', '更正申请已被其他人更新,请刷新后重试', { currentVersion: c.version });
    if (c.status !== 'pending_review' || !c.candidate_set_id) throw conflict('EAS_CORRECTION_STATE', '只有对账通过的待复核更正可以处理');
    const auth = currentAuth();
    const { selfReview } = assertDistinctReviewer(db, auth, c.submitted_by_user_id, input.exceptionReason, '更正申请');
    db.prepare('INSERT INTO eas_correction_review (correction_id, action, comment, exception_reason, reviewer_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(c.id, input.action, input.comment ?? null, input.exceptionReason ?? null, auth?.userId ?? null, nowIso());
    if (input.action === 'return') {
      db.prepare(`UPDATE eas_correction SET status = 'returned', review_comment = ?, reviewed_by_user_id = ?, reviewed_at = ?, version = version + 1 WHERE id = ?`)
        .run(input.comment ?? null, auth?.userId ?? null, nowIso(), c.id);
    } else {
      const candidate = db.prepare('SELECT * FROM eas_recon_set WHERE id = ?').get(c.candidate_set_id) as SetRow | undefined;
      if (!candidate || candidate.correction_id !== c.id || candidate.status !== 'passed') throw conflict('EAS_CANDIDATE_SET_INVALID', '更正候选对账集合无效');
      const current = currentSetRow(db, c.org_id, c.period);
      if (!current || current.id !== c.expected_current_set_id) throw conflict('EAS_CURRENT_SET_CHANGED', '当前生效集合已变化,不能覆盖');
      const lock = lockedRow(db, c.org_id, c.period);
      if (!lock || lock.set_id !== c.expected_current_set_id) throw conflict('EAS_PERIOD_LOCK_CHANGED', '期间锁定基线已变化,不能批准');
      activateSetInTx(db, candidate);
      db.prepare('UPDATE eas_period_lock SET set_id = ?, version = version + 1 WHERE id = ?').run(candidate.id, lock.id);
      addLockEvent(db, lock, 'correction_switch', candidate.id, c.reason);
      db.prepare(`UPDATE eas_correction SET status = 'approved', review_comment = ?, reviewed_by_user_id = ?, reviewed_at = ?, version = version + 1 WHERE id = ?`)
        .run(input.comment ?? null, auth?.userId ?? null, nowIso(), c.id);
    }
    writeLog(db, 'eas.correction_review', 'eas_correction', c.id, {
      action: input.action, orgId: c.org_id, period: c.period, selfReview, exceptionReason: selfReview ? input.exceptionReason : undefined,
    });
    return db.prepare('SELECT * FROM eas_correction WHERE id = ?').get(c.id) as CorrectionRow;
  }).immediate();
  return correctionDto(db, row);
}

/* ================= 辅助核算要求 ================= */

export function listAuxRequirements(db: DB, orgId?: number) {
  const sc = orgScopeSql(db, 'org_id');
  const params: unknown[] = [...sc.params];
  let sql = `SELECT id, org_id AS orgId, account_code AS accountCode, aux_type AS auxType, status, created_at AS createdAt FROM eas_aux_requirement WHERE ${sc.sql}`;
  if (orgId) { sql += ' AND org_id = ?'; params.push(orgId); }
  return (db.prepare(`${sql} ORDER BY org_id, account_code, aux_type`).all(...params) as { orgId: number }[]).map((r) => ({ ...r, orgName: orgName(db, r.orgId) }));
}

export function upsertAuxRequirement(db: DB, input: EasAuxRequirementCreate) {
  assertOrg(db, input.orgId, '组织');
  db.prepare(`INSERT INTO eas_aux_requirement (org_id, account_code, aux_type, status, created_by_user_id, created_at) VALUES (?, ?, ?, 'active', ?, ?)
    ON CONFLICT(org_id, account_code, aux_type) DO UPDATE SET status = 'active'`).run(input.orgId, input.accountCode, input.auxType, currentAuth()?.userId ?? null, nowIso());
  writeLog(db, 'eas.aux_requirement', 'eas_aux_requirement', `${input.orgId}:${input.accountCode}:${input.auxType}`, { ...input, status: 'active' });
  return listAuxRequirements(db, input.orgId);
}

export function deactivateAuxRequirement(db: DB, id: number) {
  const row = db.prepare('SELECT org_id FROM eas_aux_requirement WHERE id = ?').get(id) as { org_id: number } | undefined;
  if (!row || !orgInScope(scope(db), row.org_id)) throw notVisible('辅助核算要求');
  db.prepare("UPDATE eas_aux_requirement SET status = 'inactive' WHERE id = ?").run(id);
  writeLog(db, 'eas.aux_requirement', 'eas_aux_requirement', id, { status: 'inactive' });
  return listAuxRequirements(db, row.org_id);
}

/* ================= 查询 ================= */

export function listBatches(db: DB, q: { orgId?: number; period?: string; dataType?: string; status?: string } = {}): EasBatchDto[] {
  const sc = orgScopeSql(db, 'org_id');
  const where = [sc.sql];
  const params: unknown[] = [...sc.params];
  if (q.orgId) { where.push('org_id = ?'); params.push(q.orgId); }
  if (q.period) { where.push('period = ?'); params.push(q.period); }
  if (q.dataType) { where.push('data_type = ?'); params.push(q.dataType); }
  if (q.status) { where.push('status = ?'); params.push(q.status); }
  return batchRows(db, `${where.join(' AND ')} ORDER BY id DESC LIMIT 300`, params).map((b) => batchDto(db, b));
}

export function getBatch(db: DB, id: number): EasBatchDto {
  const b = batchRows(db, 'id = ?', [id])[0];
  if (!b || !orgInScope(scope(db), b.org_id)) throw notVisible('EAS 批次');
  return batchDto(db, b);
}

export function batchLines(db: DB, id: number, page = 1, pageSize = 100): EasBatchLinesDto {
  const batch = getBatch(db, id);
  const size = Math.min(500, Math.max(1, pageSize));
  const offset = (Math.max(1, page) - 1) * size;
  const table = batch.dataType === 'voucher' ? 'eas_voucher_line' : batch.dataType === 'balance' ? 'eas_balance_line' : 'eas_aux_line';
  const total = (db.prepare(`SELECT COUNT(*) AS c FROM ${table} WHERE batch_id = ?`).get(id) as { c: number }).c;
  const rows = db.prepare(`SELECT * FROM ${table} WHERE batch_id = ? ORDER BY source_row LIMIT ? OFFSET ?`).safeIntegers(true).all(id, size, offset) as Record<string, unknown>[];
  const m = (v: unknown) => centsToDecimalString(v as bigint);
  const t = (v: unknown) => (v == null ? null : String(v));
  const lines = rows.map((r) => {
    if (batch.dataType === 'voucher') {
      return { sourceRow: Number(r.source_row), voucherDate: String(r.voucher_date), voucherNo: String(r.voucher_no), entryNo: String(r.entry_no),
        accountCode: String(r.account_code), accountName: String(r.account_name), summary: t(r.summary), debit: m(r.debit_cents), credit: m(r.credit_cents),
        projectCode: t(r.project_code), projectName: t(r.project_name), deptName: t(r.dept_name), supplierName: t(r.supplier_name), fundSource: t(r.fund_source) };
    }
    if (batch.dataType === 'balance') {
      return { sourceRow: Number(r.source_row), accountCode: String(r.account_code), accountName: String(r.account_name),
        beginDebit: m(r.begin_debit_cents), beginCredit: m(r.begin_credit_cents), debit: m(r.debit_cents), credit: m(r.credit_cents),
        endDebit: m(r.end_debit_cents), endCredit: m(r.end_credit_cents), projectCode: t(r.project_code), deptName: t(r.dept_name), supplierName: t(r.supplier_name) };
    }
    return { sourceRow: Number(r.source_row), auxType: String(r.aux_type), auxCode: String(r.aux_code), auxName: String(r.aux_name),
      accountCode: String(r.account_code), accountName: String(r.account_name), begin: m(r.begin_cents), debit: m(r.debit_cents),
      credit: m(r.credit_cents), end: m(r.end_cents), supplierName: t(r.supplier_name) };
  });
  return { batch, total, lines } as EasBatchLinesDto;
}

/** 原件下载:先按批次鉴权(组织范围),再读对象;不存在按 ID 直接下载的入口。 */
export function batchOriginal(db: DB, store: ObjectStore, id: number): { fileName: string; contentType: string; content: Buffer } {
  const batch = getBatch(db, id);
  const file = db.prepare('SELECT f.sha256, f.content_type FROM eas_batch b JOIN file_object f ON f.id = b.file_object_id WHERE b.id = ?').get(id) as { sha256: string; content_type: string };
  writeLog(db, 'eas.download', 'eas_batch', id, { fileSha256: file.sha256 });
  return { fileName: batch.fileName, contentType: file.content_type, content: store.read(file.sha256) };
}

export function listSets(db: DB, q: { orgId?: number; period?: string } = {}): EasReconSetDto[] {
  const sc = orgScopeSql(db, 'org_id');
  const where = [sc.sql];
  const params: unknown[] = [...sc.params];
  if (q.orgId) { where.push('org_id = ?'); params.push(q.orgId); }
  if (q.period) { where.push('period = ?'); params.push(q.period); }
  const rows = db.prepare(`SELECT * FROM eas_recon_set WHERE ${where.join(' AND ')} ORDER BY id DESC LIMIT 200`).all(...params) as SetRow[];
  return rows.map((r) => setDto(db, r));
}

export function getSet(db: DB, id: number): EasReconSetDto {
  return setDto(db, getSetRow(db, id));
}

export function listLocks(db: DB): EasPeriodLockDto[] {
  const sc = orgScopeSql(db, 'org_id');
  return (db.prepare(`SELECT * FROM eas_period_lock WHERE ${sc.sql} ORDER BY period DESC, id DESC LIMIT 300`).all(...sc.params) as LockRow[]).map((l) => lockDto(db, l));
}

export function lockEvents(db: DB, lockId: number) {
  const lock = db.prepare('SELECT * FROM eas_period_lock WHERE id = ?').get(lockId) as LockRow | undefined;
  if (!lock || !orgInScope(scope(db), lock.org_id)) throw notVisible('期间锁');
  return db.prepare('SELECT id, action, set_id AS setId, reason, user_id AS userId, created_at AS createdAt FROM eas_period_lock_event WHERE lock_id = ? ORDER BY id').all(lockId);
}

export function listCorrections(db: DB, q: { status?: string } = {}): EasCorrectionDto[] {
  const sc = orgScopeSql(db, 'org_id');
  const params: unknown[] = [...sc.params];
  let sql = `SELECT * FROM eas_correction WHERE ${sc.sql}`;
  if (q.status === 'pending') {
    sql += ` AND status IN (${PENDING_CORRECTION.map(() => '?').join(',')})`;
    params.push(...PENDING_CORRECTION);
  }
  return (db.prepare(`${sql} ORDER BY id DESC LIMIT 200`).all(...params) as CorrectionRow[]).map((c) => correctionDto(db, c));
}

export function getCorrection(db: DB, id: number): EasCorrectionDto {
  return correctionDto(db, getCorrectionRow(db, id));
}

/** 期间状态:页面顶部与助手工具同源。 */
export function periodStatus(db: DB, orgId: number, period: string): EasPeriodStatusDto {
  assertOrg(db, orgId, '组织');
  const current = currentSetRow(db, orgId, period);
  const lock = db.prepare('SELECT * FROM eas_period_lock WHERE org_id = ? AND period = ?').get(orgId, period) as LockRow | undefined;
  const pending = db.prepare(`SELECT * FROM eas_correction WHERE org_id = ? AND period = ? AND status IN ('submitted','candidate_import','pending_review')`).get(orgId, period) as CorrectionRow | undefined;
  return {
    orgId, orgName: orgName(db, orgId), period,
    currentSet: current ? setDto(db, current) : null,
    lock: lock ? lockDto(db, lock) : null,
    pendingCorrection: pending ? correctionDto(db, pending) : null,
    candidateBatches: batchRows(db, "org_id = ? AND period = ? AND status = 'candidate' AND correction_id IS NULL ORDER BY id DESC", [orgId, period]).map((b) => batchDto(db, b)),
  };
}

/** 当前生效余额(按科目汇总):供管理会计 eas_balance 计算器与报表使用。无当前集合返回 null。 */
export function currentBalanceTotals(db: DB, orgId: number, period: string): { setId: number; batchId: number; totals: Totals } | null {
  const current = currentSetRow(db, orgId, period);
  if (!current) return null;
  const link = db.prepare("SELECT batch_id FROM eas_recon_set_batch WHERE set_id = ? AND data_type = 'balance'").get(current.id) as { batch_id: number } | undefined;
  if (!link) return null;
  return { setId: current.id, batchId: link.batch_id, totals: balanceTotals(db, link.batch_id) };
}
