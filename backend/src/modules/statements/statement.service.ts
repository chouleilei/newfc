/**
 * 财务报表(AC-F10):预览 → 导入 → 激活 → 总览。规则见 specs/implementation.md T-3「财务报表」。
 *
 * - 预览只解析,不写库、不落原件;导入有 error 时拒绝(STATEMENT_INVALID 422),按 组织 + 期间 + 口径 + sha256 幂等。
 * - 激活须带页面看到的当前批次(expectedCurrentBatchId),不一致返回 CURRENT_BATCH_CHANGED;作废须填原因。
 * - 总览只读当前批次;组织范围按报表单位 org_id 裁剪,范围外 404。
 */
import type { DB } from '../../db/connection';
import { AppError, Errors } from '../../core/errors';
import { currentAuth } from '../../core/request-context';
import { centsToDecimalOrNull, centsToDecimalString, ratioString } from '../../core/decimal';
import { writeLog } from '../audit/log';
import { notVisible, orgInScope, resolveOrgScope, type OrgScope } from '../security/scope';
import { storeFile, type ObjectStore } from '../files/object-store';
import {
  STATEMENT_FLOW_METRICS, STATEMENT_METRICS, type StatementBatchDto, type StatementCheckDto, type StatementItemDto, type StatementMetricsDto, type StatementOverviewDto,
  type StatementPreviewDto, type StatementRatiosDto, type StatementScope, type StatementSheetCode, type StatementTrendDto, type StatementTrendPointDto, type StatementUploadForm,
} from '../../contracts/statements';
import { PREFERRED_FIELD, STATEMENT_TEMPLATE_VERSION, parseStatementWorkbook, type ParsedStatement, type SheetCode } from './statement.parse';

const nowIso = () => new Date().toISOString();
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const SCOPE_ORDER: StatementScope[] = ['consolidated', 'parent', 'subsidiary'];

function scope(db: DB): OrgScope {
  const auth = currentAuth();
  return auth ? resolveOrgScope(db, auth) : { all: true };
}
function scopeSql(db: DB, column: string): { sql: string; params: number[] } {
  const s = scope(db);
  if (s.all) return { sql: '1=1', params: [] };
  if (s.orgIds.size === 0) return { sql: '0=1', params: [] };
  return { sql: `${column} IN (${[...s.orgIds].map(() => '?').join(',')})`, params: [...s.orgIds] };
}
const conflict = (code: string, message: string, details?: unknown) => new AppError(code, message, 409, undefined, details);
const orgName = (db: DB, id: number) => (db.prepare('SELECT name FROM org WHERE id = ?').get(id) as { name: string } | undefined)?.name ?? `#${id}`;

interface BatchRow {
  id: number; org_id: number; period: string; scope: StatementScope; file_object_id: number; file_sha256: string; file_name: string;
  template_version: string; status: StatementBatchDto['status']; is_current: number; item_count: number; fact_count: number; warning_count: number;
  checks_json: string; sheets_json: string; version: number; created_at: string; activated_at: string | null; voided_at: string | null; void_reason: string | null;
}

function batchDto(db: DB, b: BatchRow, extra: Partial<StatementBatchDto> = {}): StatementBatchDto {
  return {
    id: b.id, orgId: b.org_id, orgName: orgName(db, b.org_id), period: b.period, scope: b.scope, fileName: b.file_name, fileSha256: b.file_sha256,
    templateVersion: b.template_version, status: b.status, isCurrent: b.is_current === 1, itemCount: b.item_count, factCount: b.fact_count,
    warningCount: b.warning_count, checks: JSON.parse(b.checks_json) as StatementCheckDto[], sheets: JSON.parse(b.sheets_json) as StatementBatchDto['sheets'],
    version: b.version, createdAt: b.created_at, activatedAt: b.activated_at, voidedAt: b.voided_at, voidReason: b.void_reason, ...extra,
  };
}

function getBatchRow(db: DB, id: number): BatchRow {
  const row = db.prepare('SELECT * FROM stmt_batch WHERE id = ?').get(id) as BatchRow | undefined;
  if (!row || !orgInScope(scope(db), row.org_id)) throw notVisible('财务报表批次');
  return row;
}

function metricsDto(metrics: Record<string, bigint>): StatementMetricsDto {
  return Object.fromEntries(STATEMENT_METRICS.map((k) => [k, centsToDecimalOrNull(metrics[k])])) as StatementMetricsDto;
}

function ratiosOf(m: Record<string, bigint>): StatementRatiosDto {
  const r = (a: bigint | undefined, b: bigint | undefined) => (a === undefined || b === undefined ? null : ratioString(a, b));
  return {
    debt_asset_ratio: r(m.total_liabilities_period_end, m.total_assets_period_end),
    equity_ratio: r(m.owner_equity_period_end, m.total_assets_period_end),
    net_profit_margin: r(m.net_profit_ytd, m.revenue_ytd),
  };
}

function parsedItemsDto(parsed: ParsedStatement, limit: number): StatementItemDto[] {
  return parsed.items.slice(0, limit).map((item, index) => ({
    ...item, sheetCode: item.sheetCode as StatementSheetCode,
    facts: parsed.facts.filter((f) => f.itemIndex === index).map((f) => ({
      fieldKey: f.fieldKey, fieldName: f.fieldName, amount: centsToDecimalOrNull(f.amount), textValue: f.textValue, formulaText: f.formulaText, sourceCell: f.sourceCell,
    })),
  }));
}

/* ================= 预览 / 导入 ================= */

export async function previewStatement(db: DB, content: Buffer, form: StatementUploadForm): Promise<StatementPreviewDto> {
  if (!orgInScope(scope(db), form.orgId)) throw notVisible('组织');
  const parsed = await parseStatementWorkbook(content);
  return {
    valid: !parsed.checks.some((c) => c.level === 'error'), checks: parsed.checks as StatementCheckDto[], sheets: parsed.sheets as StatementPreviewDto['sheets'],
    ignoredSheets: parsed.ignoredSheets, metrics: metricsDto(parsed.metrics), itemCount: parsed.items.length, factCount: parsed.facts.length,
    previewItems: parsedItemsDto(parsed, 40),
  };
}

export async function importStatement(db: DB, store: ObjectStore, content: Buffer, fileName: string, form: StatementUploadForm): Promise<StatementBatchDto> {
  if (!orgInScope(scope(db), form.orgId)) throw notVisible('组织');
  const parsed = await parseStatementWorkbook(content);
  const errors = parsed.checks.filter((c) => c.level === 'error');
  if (errors.length) {
    throw new AppError('STATEMENT_INVALID', `财务报表校验未通过(${errors.length} 项错误),未写入任何数据`, 422, undefined, { checks: parsed.checks });
  }
  const file = storeFile(db, store, content, { originalName: fileName, contentType: XLSX_TYPE });
  const auth = currentAuth();
  return db.transaction((): StatementBatchDto => {
    const existing = db.prepare('SELECT * FROM stmt_batch WHERE org_id = ? AND period = ? AND scope = ? AND file_sha256 = ?')
      .get(form.orgId, form.period, form.scope, file.sha256) as BatchRow | undefined;
    if (existing) return batchDto(db, existing, { replayed: true });
    const warnings = parsed.checks.filter((c) => c.level === 'warning').length;
    const batchId = Number(db.prepare(`INSERT INTO stmt_batch (org_id, period, scope, file_object_id, file_sha256, file_name, template_version, status, is_current,
      item_count, fact_count, warning_count, checks_json, sheets_json, created_by_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'imported', 0, ?, ?, ?, ?, ?, ?, ?)`).run(
      form.orgId, form.period, form.scope, file.id, file.sha256, fileName.slice(0, 255), STATEMENT_TEMPLATE_VERSION, parsed.items.length, parsed.facts.length,
      warnings, JSON.stringify(parsed.checks), JSON.stringify(parsed.sheets), auth?.userId ?? null, nowIso()).lastInsertRowid);
    const insItem = db.prepare('INSERT INTO stmt_item (batch_id, sheet_code, side, row_no, line_no, item_name, semantic_key, item_type) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
    const insFact = db.prepare(`INSERT INTO stmt_fact (batch_id, item_id, field_key, field_name, amount_cents, text_value, formula_text, source_cell)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    const itemIds = parsed.items.map((i) => Number(insItem.run(batchId, i.sheetCode, i.side, i.rowNo, i.lineNo, i.itemName.slice(0, 200), i.semanticKey, i.itemType).lastInsertRowid));
    for (const f of parsed.facts) insFact.run(batchId, itemIds[f.itemIndex], f.fieldKey, f.fieldName.slice(0, 200), f.amount, f.textValue, f.formulaText, f.sourceCell);
    writeLog(db, 'statement.import', 'stmt_batch', batchId, { orgId: form.orgId, period: form.period, scope: form.scope, fileSha256: file.sha256, items: parsed.items.length, warnings });
    return batchDto(db, db.prepare('SELECT * FROM stmt_batch WHERE id = ?').get(batchId) as BatchRow);
  }).immediate();
}

/* ================= 激活 / 作废 ================= */

export function activateStatement(db: DB, id: number, expectedCurrentBatchId: number | null): StatementBatchDto {
  const row = db.transaction(() => {
    const b = getBatchRow(db, id);
    if (b.status === 'voided') throw conflict('STATEMENT_VOIDED', '已作废的批次不能激活');
    const current = db.prepare('SELECT id FROM stmt_batch WHERE org_id = ? AND period = ? AND scope = ? AND is_current = 1').get(b.org_id, b.period, b.scope) as { id: number } | undefined;
    if ((current?.id ?? null) !== expectedCurrentBatchId) {
      throw conflict('CURRENT_BATCH_CHANGED', '当前生效批次已被其他人更换,请刷新后确认', { currentBatchId: current?.id ?? null });
    }
    if (current?.id === b.id) return b;
    const auth = currentAuth();
    if (current) db.prepare("UPDATE stmt_batch SET is_current = 0, status = 'superseded', version = version + 1 WHERE id = ?").run(current.id);
    db.prepare("UPDATE stmt_batch SET is_current = 1, status = 'active', version = version + 1, activated_by_user_id = ?, activated_at = ? WHERE id = ?")
      .run(auth?.userId ?? null, nowIso(), b.id);
    writeLog(db, 'statement.activate', 'stmt_batch', b.id, { orgId: b.org_id, period: b.period, scope: b.scope, replaced: current?.id ?? null });
    return db.prepare('SELECT * FROM stmt_batch WHERE id = ?').get(b.id) as BatchRow;
  }).immediate();
  return batchDto(db, row);
}

export function voidStatement(db: DB, id: number, reason: string): StatementBatchDto {
  const row = db.transaction(() => {
    const b = getBatchRow(db, id);
    if (b.status === 'voided') return b;
    db.prepare("UPDATE stmt_batch SET status = 'voided', is_current = 0, version = version + 1, voided_by_user_id = ?, voided_at = ?, void_reason = ? WHERE id = ?")
      .run(currentAuth()?.userId ?? null, nowIso(), reason, b.id);
    writeLog(db, 'statement.void', 'stmt_batch', b.id, { orgId: b.org_id, period: b.period, scope: b.scope, wasCurrent: b.is_current === 1, reason });
    return db.prepare('SELECT * FROM stmt_batch WHERE id = ?').get(b.id) as BatchRow;
  }).immediate();
  return batchDto(db, row);
}

/* ================= 查询 ================= */

export function listStatementBatches(db: DB, q: { orgId?: number; period?: string; scope?: StatementScope; status?: string } = {}): StatementBatchDto[] {
  const sc = scopeSql(db, 'org_id');
  const where = [sc.sql];
  const params: unknown[] = [...sc.params];
  if (q.orgId) { where.push('org_id = ?'); params.push(q.orgId); }
  if (q.period) { where.push('period = ?'); params.push(q.period); }
  if (q.scope) { where.push('scope = ?'); params.push(q.scope); }
  if (q.status) { where.push('status = ?'); params.push(q.status); }
  return (db.prepare(`SELECT * FROM stmt_batch WHERE ${where.join(' AND ')} ORDER BY period DESC, id DESC LIMIT 300`).all(...params) as BatchRow[]).map((b) => batchDto(db, b));
}

export function getStatementBatch(db: DB, id: number): StatementBatchDto {
  return batchDto(db, getBatchRow(db, id));
}

export function statementItems(db: DB, id: number, sheet?: StatementSheetCode): StatementItemDto[] {
  getBatchRow(db, id);
  const items = db.prepare(`SELECT * FROM stmt_item WHERE batch_id = ? ${sheet ? 'AND sheet_code = ?' : ''} ORDER BY sheet_code, row_no, side`)
    .all(...(sheet ? [id, sheet] : [id])) as { id: number; sheet_code: StatementSheetCode; side: StatementItemDto['side']; row_no: number; line_no: string | null; item_name: string; semantic_key: string | null; item_type: StatementItemDto['itemType'] }[];
  const facts = db.prepare('SELECT * FROM stmt_fact WHERE batch_id = ? ORDER BY id').safeIntegers(true).all(id) as Record<string, unknown>[];
  const byItem = new Map<number, StatementItemDto['facts']>();
  for (const f of facts) {
    const list = byItem.get(Number(f.item_id)) ?? [];
    list.push({ fieldKey: String(f.field_key), fieldName: String(f.field_name), amount: f.amount_cents == null ? null : centsToDecimalString(f.amount_cents as bigint),
      textValue: f.text_value == null ? null : String(f.text_value), formulaText: f.formula_text == null ? null : String(f.formula_text), sourceCell: String(f.source_cell) });
    byItem.set(Number(f.item_id), list);
  }
  return items.map((i) => ({ sheetCode: i.sheet_code, side: i.side, rowNo: i.row_no, lineNo: i.line_no, itemName: i.item_name, semanticKey: i.semantic_key, itemType: i.item_type, facts: byItem.get(i.id) ?? [] }));
}

/** 批次的语义指标(分)。供总览、管理会计 statement_item 计算器与标准报表共用。 */
export function statementMetrics(db: DB, batchId: number): Record<string, bigint> {
  const rows = db.prepare(`SELECT i.sheet_code, i.semantic_key, f.field_key, f.amount_cents FROM stmt_item i JOIN stmt_fact f ON f.item_id = i.id
    WHERE i.batch_id = ? AND i.semantic_key IS NOT NULL AND f.amount_cents IS NOT NULL`).safeIntegers(true).all(batchId) as
    { sheet_code: SheetCode; semantic_key: string; field_key: string; amount_cents: bigint }[];
  const out: Record<string, bigint> = {};
  for (const r of rows) {
    const pref = PREFERRED_FIELD[r.sheet_code];
    if (pref && r.field_key === pref.field) out[`${r.semantic_key}${pref.suffix}`] = r.amount_cents;
  }
  return out;
}

/** 当前批次(范围内):按组织/期间/口径过滤,默认取最新期间、合并口径优先。 */
export function currentStatementBatch(db: DB, q: { orgId?: number; period?: string; scope?: StatementScope } = {}): BatchRow | null {
  if (q.orgId && !orgInScope(scope(db), q.orgId)) throw notVisible('组织');
  const sc = scopeSql(db, 'org_id');
  const where = ['is_current = 1', sc.sql];
  const params: unknown[] = [...sc.params];
  if (q.orgId) { where.push('org_id = ?'); params.push(q.orgId); }
  if (q.period) { where.push('period = ?'); params.push(q.period); }
  if (q.scope) { where.push('scope = ?'); params.push(q.scope); }
  const rows = db.prepare(`SELECT * FROM stmt_batch WHERE ${where.join(' AND ')} ORDER BY period DESC, org_id`).all(...params) as BatchRow[];
  if (!rows.length) return null;
  const latest = rows.filter((r) => r.period === rows[0].period);
  latest.sort((a, b) => SCOPE_ORDER.indexOf(a.scope) - SCOPE_ORDER.indexOf(b.scope) || a.org_id - b.org_id);
  return latest[0];
}

export function statementOverview(db: DB, q: { orgId?: number; period?: string; scope?: StatementScope } = {}): StatementOverviewDto {
  const batch = currentStatementBatch(db, q);
  if (!batch) return { batch: null, metrics: null, ratios: null, unitComparison: [] };
  const metrics = statementMetrics(db, batch.id);
  const sc = scopeSql(db, 'org_id');
  const peers = db.prepare(`SELECT * FROM stmt_batch WHERE is_current = 1 AND period = ? AND ${sc.sql} ORDER BY org_id, scope`).all(batch.period, ...sc.params) as BatchRow[];
  return {
    batch: batchDto(db, batch), metrics: metricsDto(metrics), ratios: ratiosOf(metrics),
    unitComparison: peers.map((p) => {
      const m = p.id === batch.id ? metrics : statementMetrics(db, p.id);
      return { batchId: p.id, orgId: p.org_id, orgName: orgName(db, p.org_id), scope: p.scope, period: p.period,
        totalAssets: centsToDecimalOrNull(m.total_assets_period_end), netProfitYtd: centsToDecimalOrNull(m.net_profit_ytd), debtAssetRatio: ratiosOf(m).debt_asset_ratio };
    }),
  };
}

const TREND_DEFAULT_SPAN = 12;
const TREND_MAX_SPAN = 60;
function addMonths(period: string, n: number): string {
  const [y, m] = period.split('-').map(Number);
  const t = y * 12 + (m - 1) + n;
  return `${Math.floor(t / 12)}-${String((t % 12) + 1).padStart(2, '0')}`;
}
function monthsBetween(from: string, to: string): number {
  const [fy, fm] = from.split('-').map(Number); const [ty, tm] = to.split('-').map(Number);
  return (ty * 12 + tm) - (fy * 12 + fm);
}

/**
 * 多期趋势:报表单位与口径缺省取总览同口径的当前批次;区间缺省为截至最新期间的 12 个月,最长 60 个月。
 * 当月发生额 = 本期累计 − 上期累计(同一年度;1 月取累计数),上期缺失时为 null,不做插补。
 */
export function statementTrends(db: DB, q: { orgId?: number; scope?: StatementScope; from?: string; to?: string } = {}): StatementTrendDto {
  const anchorBatch = currentStatementBatch(db, { orgId: q.orgId, scope: q.scope, period: q.to });
  const base = anchorBatch ?? (q.to ? currentStatementBatch(db, { orgId: q.orgId, scope: q.scope }) : null);
  if (!base) return { orgId: q.orgId ?? null, orgName: q.orgId ? orgName(db, q.orgId) : null, scope: q.scope ?? null, from: q.from ?? null, to: q.to ?? null, points: [], missingPeriods: [] };
  const orgId = q.orgId ?? base.org_id;
  const sc = q.scope ?? base.scope;
  const to = q.to ?? base.period;
  const from = q.from ?? addMonths(to, -(TREND_DEFAULT_SPAN - 1));
  if (monthsBetween(from, to) < 0) throw Errors.validation('起始期间不能晚于截止期间');
  if (monthsBetween(from, to) >= TREND_MAX_SPAN) throw Errors.validation(`趋势区间最长 ${TREND_MAX_SPAN} 个月`);
  const rows = db.prepare(`SELECT * FROM stmt_batch WHERE is_current = 1 AND org_id = ? AND scope = ? AND period BETWEEN ? AND ? ORDER BY period`)
    .all(orgId, sc, addMonths(from, -1), to) as BatchRow[];
  const byPeriod = new Map(rows.map((r) => [r.period, statementMetrics(db, r.id)]));
  const points: StatementTrendPointDto[] = [];
  const missingPeriods: string[] = [];
  for (let p = from; monthsBetween(p, to) >= 0; p = addMonths(p, 1)) {
    const batch = rows.find((r) => r.period === p);
    if (!batch) { missingPeriods.push(p); continue; }
    const m = byPeriod.get(p)!;
    const prev = p.endsWith('-01') ? null : byPeriod.get(addMonths(p, -1));
    const monthly = Object.fromEntries(STATEMENT_FLOW_METRICS.map((k) => {
      const cur = m[k];
      if (cur === undefined) return [k, null];
      if (p.endsWith('-01')) return [k, centsToDecimalString(cur)];
      const before = prev?.[k];
      return [k, before === undefined ? null : centsToDecimalString(cur - before)];
    })) as StatementTrendPointDto['monthly'];
    points.push({ period: p, batchId: batch.id, metrics: metricsDto(m), ratios: ratiosOf(m), monthly });
  }
  return { orgId, orgName: orgName(db, orgId), scope: sc, from, to, points, missingPeriods };
}

export function statementOriginal(db: DB, store: ObjectStore, id: number): { fileName: string; contentType: string; content: Buffer } {
  const b = getBatchRow(db, id);
  writeLog(db, 'statement.download', 'stmt_batch', id, { fileSha256: b.file_sha256 });
  return { fileName: b.file_name, contentType: XLSX_TYPE, content: store.read(b.file_sha256) };
}
