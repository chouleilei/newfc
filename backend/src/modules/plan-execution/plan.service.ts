/**
 * 计划执行与形象进度(AC-F15):预览 → 导入 → 激活 → 概览/项目进度。规则见 specs/implementation.md T-4「计划执行与形象进度」。
 *
 * - 同年取数规则(概览、项目进度、管理会计计算器、助手、报表共用 resolvePlanBatch):
 *   对指定年度取实际期间 ≤ asOfPeriod(缺省最新)的最新当前批次;当期 = 本期年度累计实际 − 同年上一实际期间当前批次的年度累计实际,
 *   没有上期批次时为 null 并说明原因,跨年不相减。
 * - 指标只按口径取数:年度执行率只用 annual_plan / annual_actual_ytd,没有年度实际即不可计算,不用开工累计兜底;
 *   形象进度只来自形象进度列。
 * - 组织范围:明细行 org_id;分类/小计行只对全组织用户可见。写操作要求批次涉及的全部组织在范围内。
 */
import { planExtraAliases } from '../settings/import-aliases.service';
import type { DB } from '../../db/connection';
import { AppError, type RowError } from '../../core/errors';
import { currentAuth } from '../../core/request-context';
import { centsToDecimalOrNull, centsToDecimalString, ratioScaled, ratioString } from '../../core/decimal';
import { writeLog } from '../audit/log';
import { assertFullScope, currentOrgScope, notVisible, orgInScope, scopeFilterSql, type OrgScope } from '../security/scope';
import { storeFile, type ObjectStore } from '../files/object-store';
import { readWorkbookSheets } from '../io/table-reader';
import { normalizeName, resolveEntity } from '../master/master.service';
import {
  PLAN_SHEET_LABELS, PLAN_SHEETS, type PeriodValueDto, type PlanBatchDto, type PlanFactDto, type PlanItemDto, type PlanOverviewDto, type PlanPreviewDto,
  type PlanProjectProgressDto, type PlanProjectProgressListDto, type PlanQuery, type PlanRowStatus, type PlanSheetCode, type PlanSheetOverviewDto,
  type PlanSheetSummaryDto, type PlanUploadForm,
} from '../../contracts/plan-execution';
import { factValueText, fieldLabel, parsePlanWorkbook, type ParsedPlanItem, type ParsedPlanSheet } from './plan.parse';

const nowIso = () => new Date().toISOString();
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const conflict = (code: string, message: string, details?: unknown) => new AppError(code, message, 409, undefined, details);
const ONE = 1_000_000n;
const SLOW = 300_000n;

/* ================= 解析 + 主数据归属 ================= */

interface ResolvedItem extends ParsedPlanItem { projectId: number | null; orgId: number | null; itemKey: string }
interface ResolvedPlan { sheets: (ParsedPlanSheet & { items: ResolvedItem[] })[]; ignoredSheets: string[]; errors: RowError[] }

async function parseAndResolve(db: DB, scope: OrgScope, content: Buffer, form: PlanUploadForm): Promise<ResolvedPlan> {
  const parsed = parsePlanWorkbook(await readWorkbookSheets(content), form.year, planExtraAliases(db));
  const errors = [...parsed.errors];
  const projects = new Map((db.prepare('SELECT id, code, name, org_id, status FROM md_project').all() as { id: number; code: string; name: string; org_id: number; status: string }[]).map((p) => [p.code, p]));
  const asOf = `${form.actualPeriod}-28T00:00:00.000Z`;
  const sheets = parsed.sheets.map((sheet) => {
    const label = PLAN_SHEET_LABELS[sheet.code];
    const keys = new Map<string, number>();
    const items: ResolvedItem[] = sheet.items.map((item) => {
      const err = (field: string, message: string) => errors.push({ row: item.rowNo, field: `${label}·${field}`, message });
      let projectId: number | null = null;
      let orgId: number | null = null;
      if (item.projectCode) {
        const p = projects.get(item.projectCode);
        if (!p || !orgInScope(scope, p.org_id)) err('项目编码', `项目编码 ${item.projectCode} 不存在或无权访问`);
        else if (p.status !== 'active') err('项目编码', `项目 ${item.projectCode} 已停用`);
        else { projectId = p.id; orgId = p.org_id; }
      }
      if (item.orgText && item.itemType === 'detail') {
        const r = resolveEntity(db, 'org', { name: item.orgText, sourceSystem: 'plan', asOf });
        const visible = r.targetId !== null && orgInScope(scope, r.targetId);
        if (!visible) {
          const candidates = r.candidates.filter((c) => orgInScope(scope, c.id)).map((c) => c.name);
          err('承办单位', r.matchedBy === 'ambiguous' && candidates.length
            ? `承办单位“${item.orgText}”对应多个组织:${candidates.join('、')},请在主数据映射(来源 plan)中指定`
            : `承办单位“${item.orgText}”未匹配到组织,请在主数据映射(来源 plan)中补充`);
        } else if (orgId !== null && r.targetId !== orgId) {
          err('承办单位', `承办单位“${item.orgText}”与项目归属组织不一致`);
        } else orgId = r.targetId;
      }
      const itemKey = item.itemType !== 'detail' ? `${item.itemType}:${item.rowNo}`
        : projectId !== null ? `p:${projectId}:${sheet.code === 'investment' ? '' : normalizeName(item.itemName)}` : `o:${orgId}:${normalizeName(item.itemName)}`;
      if (item.itemType === 'detail' && orgId !== null) {
        if (keys.has(itemKey)) err('名称', `与第 ${keys.get(itemKey)} 行重复(同一${sheet.code === 'investment' ? '项目' : '组织与名称'})`);
        else keys.set(itemKey, item.rowNo);
      }
      return { ...item, projectId, orgId, itemKey };
    });
    return { ...sheet, items };
  });
  return { sheets, ignoredSheets: parsed.ignoredSheets, errors };
}

const orgNameOf = (db: DB) => {
  const cache = new Map<number, string>();
  return (id: number | null) => {
    if (id === null) return null;
    if (!cache.has(id)) cache.set(id, (db.prepare('SELECT name FROM org WHERE id = ?').get(id) as { name: string } | undefined)?.name ?? `#${id}`);
    return cache.get(id)!;
  };
};

function sheetSummaries(plan: ResolvedPlan): PlanSheetSummaryDto[] {
  return plan.sheets.map((s) => ({
    code: s.code, name: PLAN_SHEET_LABELS[s.code], sourceName: s.sourceName, itemCount: s.items.length,
    detailCount: s.items.filter((i) => i.itemType === 'detail').length, unit: s.unit,
  }));
}

export async function previewPlan(db: DB, content: Buffer, form: PlanUploadForm): Promise<PlanPreviewDto> {
  const plan = await parseAndResolve(db, currentOrgScope(db), content, form);
  const orgName = orgNameOf(db);
  const items = plan.sheets.flatMap((s) => s.items);
  return {
    valid: plan.errors.length === 0, errors: plan.errors.slice(0, 500), sheets: sheetSummaries(plan), ignoredSheets: plan.ignoredSheets,
    itemCount: items.length, factCount: items.reduce((n, i) => n + i.facts.length, 0),
    previewItems: items.slice(0, 60).map((i, index) => ({
      id: -(index + 1), sheetCode: i.sheetCode, rowNo: i.rowNo, seqNo: i.seqNo, itemName: i.itemName, itemType: i.itemType, path: i.path,
      projectId: i.projectId, projectCode: i.projectCode || null, orgId: i.orgId, orgName: orgName(i.orgId),
      facts: i.facts.map((f) => ({ fieldKey: f.fieldKey, fieldName: fieldLabel(i.sheetCode, f.fieldKey), measure: f.measure, valueType: f.valueType, value: factValueText(f), sourceCell: f.sourceCell })),
    })),
  };
}

export async function importPlan(db: DB, store: ObjectStore, content: Buffer, fileName: string, form: PlanUploadForm): Promise<PlanBatchDto> {
  const scope = currentOrgScope(db);
  const plan = await parseAndResolve(db, scope, content, form);
  if (plan.errors.length) throw new AppError('IMPORT_INVALID', `计划执行校验未通过(${plan.errors.length} 项错误),未写入任何数据`, 422, plan.errors.slice(0, 500));
  const items = plan.sheets.flatMap((s) => s.items);
  assertFullScope(scope, items.filter((i) => i.orgId !== null).map((i) => i.orgId!), '计划执行批次');
  // 分类/小计行不归属组织,只有全组织用户能导入含这类行的批次(否则会写入自己看不到的汇总行)
  if (!scope.all && items.some((i) => i.itemType !== 'detail')) {
    throw new AppError('SCOPE_RESTRICTED', '计划执行批次含分类/合计行,只能由全组织用户导入', 403);
  }
  const file = storeFile(db, store, content, { originalName: fileName, contentType: XLSX_TYPE });
  const auth = currentAuth();
  const result = db.transaction((): { id: number; replayed: boolean } => {
    const existing = db.prepare('SELECT id FROM plan_batch WHERE year = ? AND actual_period = ? AND file_sha256 = ?').get(form.year, form.actualPeriod, file.sha256) as { id: number } | undefined;
    if (existing) return { id: existing.id, replayed: true };
    const factCount = items.reduce((n, i) => n + i.facts.length, 0);
    const batchId = Number(db.prepare(`INSERT INTO plan_batch (year, actual_period, file_object_id, file_sha256, file_name, amount_unit, item_count, fact_count,
      sheets_json, ignored_sheets_json, created_by_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      form.year, form.actualPeriod, file.id, file.sha256, fileName.slice(0, 255), plan.sheets[0]?.unit ?? 'wan', items.length, factCount,
      JSON.stringify(sheetSummaries(plan)), JSON.stringify(plan.ignoredSheets), auth?.userId ?? null, nowIso()).lastInsertRowid);
    const insItem = db.prepare(`INSERT INTO plan_item (batch_id, sheet_code, row_no, seq_no, item_name, item_type, path, item_key, project_id, org_id)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    const insFact = db.prepare(`INSERT INTO plan_fact (batch_id, item_id, field_key, measure, value_type, amount_cents, scaled_value, text_value, source_cell)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const i of items) {
      const itemId = Number(insItem.run(batchId, i.sheetCode, i.rowNo, i.seqNo, i.itemName, i.itemType, i.path, i.itemKey, i.projectId, i.orgId).lastInsertRowid);
      for (const f of i.facts) insFact.run(batchId, itemId, f.fieldKey, f.measure, f.valueType, f.amount, f.scaled, f.text, f.sourceCell);
    }
    writeLog(db, 'plan.import', 'plan_batch', batchId, { year: form.year, actualPeriod: form.actualPeriod, fileSha256: file.sha256, items: items.length, facts: factCount });
    return { id: batchId, replayed: false };
  }).immediate();
  return { ...getPlanBatch(db, result.id), ...(result.replayed ? { replayed: true } : {}) };
}

/* ================= 批次 ================= */

interface BatchRow {
  id: number; year: number; actual_period: string; file_object_id: number; file_sha256: string; file_name: string; amount_unit: 'yuan' | 'wan';
  status: 'imported' | 'voided'; is_current: number; item_count: number; fact_count: number; sheets_json: string; ignored_sheets_json: string;
  version: number; created_at: string; activated_at: string | null; voided_at: string | null; void_reason: string | null;
}

function batchOrgIds(db: DB, batchId: number): number[] {
  return (db.prepare('SELECT DISTINCT org_id FROM plan_item WHERE batch_id = ? AND org_id IS NOT NULL').all(batchId) as { org_id: number }[]).map((r) => r.org_id);
}
function batchHasUnownedRows(db: DB, batchId: number): boolean {
  return !!db.prepare('SELECT 1 FROM plan_item WHERE batch_id = ? AND org_id IS NULL LIMIT 1').get(batchId);
}
function assertBatchWritable(db: DB, scope: OrgScope, batchId: number, what: string): void {
  assertFullScope(scope, batchOrgIds(db, batchId), what);
  if (!scope.all && batchHasUnownedRows(db, batchId)) throw new AppError('SCOPE_RESTRICTED', `${what}含分类/合计行,只能由全组织用户操作`, 403);
}

function batchVisible(db: DB, scope: OrgScope, batchId: number): boolean {
  return scope.all || batchOrgIds(db, batchId).some((o) => scope.orgIds.has(o));
}

function visibleBatchRow(db: DB, scope: OrgScope, id: number): BatchRow {
  const row = db.prepare('SELECT * FROM plan_batch WHERE id = ?').get(id) as BatchRow | undefined;
  if (!row || !batchVisible(db, scope, id)) throw notVisible('计划执行批次');
  return row;
}

function batchDto(db: DB, scope: OrgScope, b: BatchRow): PlanBatchDto {
  const orgs = batchOrgIds(db, b.id);
  const orgName = orgNameOf(db);
  const visible = orgs.filter((o) => orgInScope(scope, o));
  return {
    id: b.id, year: b.year, actualPeriod: b.actual_period, fileName: b.file_name, fileSha256: b.file_sha256, amountUnit: b.amount_unit, status: b.status,
    isCurrent: b.is_current === 1, itemCount: b.item_count, factCount: b.fact_count, sheets: JSON.parse(b.sheets_json), ignoredSheets: JSON.parse(b.ignored_sheets_json),
    partial: visible.length < orgs.length || (!scope.all && batchHasUnownedRows(db, b.id)), orgNames: visible.map((o) => orgName(o)!),
    version: b.version, createdAt: b.created_at, activatedAt: b.activated_at, voidedAt: b.voided_at, voidReason: b.void_reason,
  };
}

export function getPlanBatch(db: DB, id: number): PlanBatchDto {
  const scope = currentOrgScope(db);
  return batchDto(db, scope, visibleBatchRow(db, scope, id));
}

export function listPlanBatches(db: DB, q: { year?: number; status?: string } = {}): PlanBatchDto[] {
  const scope = currentOrgScope(db);
  const sc = scopeFilterSql(scope, 'i.org_id');
  const where = [scope.all ? '1=1' : `EXISTS (SELECT 1 FROM plan_item i WHERE i.batch_id = b.id AND ${sc.sql})`];
  const params: unknown[] = scope.all ? [] : [...sc.params];
  if (q.year) { where.push('b.year = ?'); params.push(q.year); }
  if (q.status) { where.push('b.status = ?'); params.push(q.status); }
  return (db.prepare(`SELECT b.* FROM plan_batch b WHERE ${where.join(' AND ')} ORDER BY b.actual_period DESC, b.id DESC LIMIT 300`).all(...params) as BatchRow[])
    .map((b) => batchDto(db, scope, b));
}

export function planOriginal(db: DB, store: ObjectStore, id: number): { fileName: string; contentType: string; content: Buffer } {
  const scope = currentOrgScope(db);
  const b = visibleBatchRow(db, scope, id);
  assertBatchWritable(db, scope, id, '计划执行原件');
  const f = db.prepare('SELECT sha256, content_type FROM file_object WHERE id = ?').get(b.file_object_id) as { sha256: string; content_type: string };
  return { fileName: b.file_name, contentType: f.content_type, content: store.read(f.sha256) };
}

export function activatePlan(db: DB, id: number, expectedCurrentBatchId: number | null): PlanBatchDto {
  const scope = currentOrgScope(db);
  db.transaction(() => {
    const b = visibleBatchRow(db, scope, id);
    assertBatchWritable(db, scope, id, '计划执行批次');
    if (b.status === 'voided') throw conflict('BATCH_VOIDED', '已作废的批次不能激活');
    const current = db.prepare('SELECT id FROM plan_batch WHERE year = ? AND actual_period = ? AND is_current = 1').get(b.year, b.actual_period) as { id: number } | undefined;
    if ((current?.id ?? null) !== expectedCurrentBatchId) {
      throw conflict('CURRENT_BATCH_CHANGED', '当前生效批次已被其他人更换,请刷新后确认', { currentBatchId: current?.id ?? null });
    }
    if (current?.id === b.id) return;
    if (current) {
      assertBatchWritable(db, scope, current.id, '被替换的当前计划执行批次');
      db.prepare('UPDATE plan_batch SET is_current = 0, version = version + 1 WHERE id = ?').run(current.id);
    }
    db.prepare('UPDATE plan_batch SET is_current = 1, version = version + 1, activated_by_user_id = ?, activated_at = ? WHERE id = ?').run(currentAuth()?.userId ?? null, nowIso(), b.id);
    writeLog(db, 'plan.activate', 'plan_batch', b.id, { year: b.year, actualPeriod: b.actual_period, replaced: current?.id ?? null });
  }).immediate();
  return getPlanBatch(db, id);
}

export function voidPlan(db: DB, id: number, reason: string): PlanBatchDto {
  const scope = currentOrgScope(db);
  db.transaction(() => {
    const b = visibleBatchRow(db, scope, id);
    assertBatchWritable(db, scope, id, '计划执行批次');
    if (b.status === 'voided') return;
    db.prepare("UPDATE plan_batch SET status = 'voided', is_current = 0, version = version + 1, voided_by_user_id = ?, voided_at = ?, void_reason = ? WHERE id = ?")
      .run(currentAuth()?.userId ?? null, nowIso(), reason, b.id);
    writeLog(db, 'plan.void', 'plan_batch', b.id, { year: b.year, actualPeriod: b.actual_period, wasCurrent: b.is_current === 1, reason });
  }).immediate();
  return getPlanBatch(db, id);
}

/* ================= 行与事实 ================= */

interface ItemRow { id: number; sheet_code: PlanSheetCode; row_no: number; seq_no: string; item_name: string; item_type: PlanItemDto['itemType']; path: string; item_key: string; project_id: number | null; org_id: number | null }
interface FactRow { item_id: number; field_key: string; measure: PlanFactDto['measure']; value_type: PlanFactDto['valueType']; amount_cents: bigint | null; scaled_value: bigint | null; text_value: string | null; source_cell: string }

function loadItems(db: DB, scope: OrgScope, batchId: number, opts: { sheet?: PlanSheetCode; detailOnly?: boolean; orgId?: number; projectId?: number } = {}) {
  const sc = scopeFilterSql(scope, 'org_id');
  const where = ['batch_id = ?', scope.all ? '1=1' : sc.sql];
  const params: unknown[] = [batchId, ...(scope.all ? [] : sc.params)];
  if (opts.sheet) { where.push('sheet_code = ?'); params.push(opts.sheet); }
  if (opts.detailOnly) where.push("item_type = 'detail'");
  if (opts.orgId) {
    where.push('org_id IN (WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT o.id FROM org o JOIN sub ON o.parent_id = sub.id) SELECT id FROM sub)');
    params.push(opts.orgId);
  }
  if (opts.projectId) { where.push('project_id = ?'); params.push(opts.projectId); }
  const items = db.prepare(`SELECT * FROM plan_item WHERE ${where.join(' AND ')} ORDER BY sheet_code, row_no`).all(...params) as ItemRow[];
  const facts = db.prepare('SELECT item_id, field_key, measure, value_type, amount_cents, scaled_value, text_value, source_cell FROM plan_fact WHERE batch_id = ?')
    .safeIntegers(true).all(batchId) as (Omit<FactRow, 'item_id'> & { item_id: bigint })[];
  const byItem = new Map<number, Map<string, FactRow>>();
  for (const f of facts) {
    const m = byItem.get(Number(f.item_id)) ?? new Map<string, FactRow>();
    m.set(f.field_key, { ...f, item_id: Number(f.item_id) });
    byItem.set(Number(f.item_id), m);
  }
  return items.map((i) => ({ item: i, facts: byItem.get(i.id) ?? new Map<string, FactRow>() }));
}

export function planItems(db: DB, batchId: number, sheet?: PlanSheetCode): PlanItemDto[] {
  const scope = currentOrgScope(db);
  visibleBatchRow(db, scope, batchId);
  const orgName = orgNameOf(db);
  const codes = new Map((db.prepare('SELECT id, code FROM md_project').all() as { id: number; code: string }[]).map((p) => [p.id, p.code]));
  return loadItems(db, scope, batchId, { sheet }).map(({ item: i, facts }) => ({
    id: i.id, sheetCode: i.sheet_code, rowNo: i.row_no, seqNo: i.seq_no, itemName: i.item_name, itemType: i.item_type, path: i.path,
    projectId: i.project_id, projectCode: i.project_id ? codes.get(i.project_id) ?? null : null, orgId: i.org_id, orgName: orgName(i.org_id),
    facts: [...facts.values()].map((f) => ({
      fieldKey: f.field_key, fieldName: fieldLabel(i.sheet_code, f.field_key), measure: f.measure, valueType: f.value_type,
      value: factValueText({ valueType: f.value_type, amount: f.amount_cents, scaled: f.scaled_value, text: f.text_value }), sourceCell: f.source_cell,
    })),
  }));
}

/* ================= 同年取数规则 ================= */

/**
 * 对指定年度取实际期间 ≤ asOfPeriod 的最新当前批次(对当前用户可见),以及同年上一实际期间的当前批次。
 * 概览、项目进度、管理会计计算器、助手工具与报表共用。
 */
export function resolvePlanBatch(db: DB, scope: OrgScope, year: number, asOfPeriod?: string): { batch: BatchRow | null; previous: BatchRow | null } {
  const rows = db.prepare(`SELECT * FROM plan_batch WHERE year = ? AND is_current = 1 ${asOfPeriod ? 'AND actual_period <= ?' : ''} ORDER BY actual_period DESC`)
    .all(...(asOfPeriod ? [year, asOfPeriod] : [year])) as BatchRow[];
  const visible = rows.filter((b) => batchVisible(db, scope, b.id));
  return { batch: visible[0] ?? null, previous: visible[1] ?? null };
}

const amount = (facts: Map<string, FactRow>, key: string): bigint | null => facts.get(key)?.amount_cents ?? null;

export function rowStatus(rate: bigint | null): PlanRowStatus {
  if (rate === null) return 'not_computable';
  if (rate > ONE) return 'over_plan';
  if (rate < SLOW) return 'slow';
  return 'normal';
}

function periodValue(current: bigint | null, previous: { batch: BatchRow | null; value: bigint | null }): PeriodValueDto {
  const base = { previousBatchId: previous.batch?.id ?? null, previousPeriod: previous.batch?.actual_period ?? null };
  if (current === null) return { value: null, reason: '本期无年度累计实际', ...base };
  if (!previous.batch) return { value: null, reason: '无同年上期批次', ...base };
  if (previous.value === null) return { value: null, reason: '上期批次无年度累计实际', ...base };
  return { value: centsToDecimalString(current - previous.value), reason: null, ...base };
}

function sumBoth(rows: { facts: Map<string, FactRow> }[], a: string, b: string): { a: bigint; b: bigint; n: number; skipped: number } {
  let sa = 0n; let sb = 0n; let n = 0; let skipped = 0;
  for (const r of rows) {
    const va = amount(r.facts, a); const vb = amount(r.facts, b);
    if (va === null || vb === null) { skipped++; continue; }
    sa += va; sb += vb; n++;
  }
  return { a: sa, b: sb, n, skipped };
}
function sumOf(rows: { facts: Map<string, FactRow> }[], key: string): bigint | null {
  let s: bigint | null = null;
  for (const r of rows) { const v = amount(r.facts, key); if (v !== null) s = (s ?? 0n) + v; }
  return s;
}

export function planOverview(db: DB, q: PlanQuery): PlanOverviewDto {
  const scope = currentOrgScope(db);
  if (q.orgId && !orgInScope(scope, q.orgId)) throw notVisible('组织');
  const { batch, previous } = resolvePlanBatch(db, scope, q.year, q.asOfPeriod);
  if (!batch) return { year: q.year, asOfPeriod: q.asOfPeriod ?? null, batch: null, sheets: [], notes: [`${q.year} 年${q.asOfPeriod ? `截至 ${q.asOfPeriod} ` : ''}没有已激活的计划执行批次`] };
  const sheets: PlanSheetOverviewDto[] = [];
  const present = new Set((db.prepare('SELECT DISTINCT sheet_code FROM plan_item WHERE batch_id = ?').all(batch.id) as { sheet_code: PlanSheetCode }[]).map((r) => r.sheet_code));
  for (const code of PLAN_SHEETS) {
    if (!present.has(code)) continue;
    const rows = loadItems(db, scope, batch.id, { sheet: code, detailOnly: true, orgId: q.orgId });
    const prevRows = previous ? loadItems(db, scope, previous.id, { sheet: code, detailOnly: true, orgId: q.orgId }) : [];
    const notes: string[] = [];
    const both = sumBoth(rows, 'annual_plan', 'annual_actual');
    if (both.skipped && both.n) notes.push(`${both.skipped} 行缺年度计划或年度累计实际,未计入执行率`);
    const actual = sumOf(rows, 'annual_actual');
    if (actual === null) notes.push('没有年度累计实际列或全部为空:执行率不可计算(不用开工累计兜底)');
    const statusCounts: Record<PlanRowStatus, number> = { not_computable: 0, over_plan: 0, slow: 0, normal: 0 };
    for (const r of rows) {
      const p = amount(r.facts, 'annual_plan'); const a = amount(r.facts, 'annual_actual');
      statusCounts[rowStatus(p === null || a === null ? null : ratioScaled(a, p))]++;
    }
    const cum = code === 'investment' ? sumBoth(rows, 'completed_investment', 'total_investment') : null;
    sheets.push({
      code, name: PLAN_SHEET_LABELS[code], detailCount: rows.length,
      annualPlan: centsToDecimalOrNull(sumOf(rows, 'annual_plan')), annualActualYtd: centsToDecimalOrNull(actual),
      annualRate: both.n ? ratioString(both.b, both.a) : null,
      period: periodValue(actual, { batch: previous, value: previous ? sumOf(prevRows, 'annual_actual') : null }),
      cumulativeRate: cum && cum.n ? ratioString(cum.a, cum.b) : null,
      completedCumulative: code === 'investment' ? centsToDecimalOrNull(sumOf(rows, 'completed_investment')) : null,
      totalInvestment: code === 'investment' ? centsToDecimalOrNull(sumOf(rows, 'total_investment')) : null,
      statusCounts, notes,
    });
  }
  const notes = previous ? [] : ['无同年上期批次:当期发生额不可计算'];
  return { year: q.year, asOfPeriod: q.asOfPeriod ?? null, batch: batchDto(db, scope, batch), sheets, notes };
}

export function planProjectProgress(db: DB, q: PlanQuery): PlanProjectProgressListDto {
  const scope = currentOrgScope(db);
  if (q.orgId && !orgInScope(scope, q.orgId)) throw notVisible('组织');
  const { batch, previous } = resolvePlanBatch(db, scope, q.year, q.asOfPeriod);
  if (!batch) return { year: q.year, asOfPeriod: q.asOfPeriod ?? null, batch: null, rows: [], notes: [`${q.year} 年没有已激活的计划执行批次`] };
  const rows = loadItems(db, scope, batch.id, { sheet: 'investment', detailOnly: true, orgId: q.orgId, projectId: q.projectId });
  const prev = new Map(previous ? loadItems(db, scope, previous.id, { sheet: 'investment', detailOnly: true }).map((r) => [r.item.item_key, r]) : []);
  const projects = new Map((db.prepare('SELECT id, code, name FROM md_project').all() as { id: number; code: string; name: string }[]).map((p) => [p.id, p]));
  const orgName = orgNameOf(db);
  const out: PlanProjectProgressDto[] = rows.map(({ item, facts }) => {
    const plan = amount(facts, 'annual_plan'); const actual = amount(facts, 'annual_actual');
    const completed = amount(facts, 'completed_investment'); const total = amount(facts, 'total_investment');
    const rate = plan === null || actual === null ? null : ratioScaled(actual, plan);
    const p = projects.get(item.project_id!);
    const prevRow = prev.get(item.item_key);
    return {
      itemId: item.id, rowNo: item.row_no, projectId: item.project_id!, projectCode: p?.code ?? '', projectName: p?.name ?? item.item_name, orgName: orgName(item.org_id) ?? '',
      approvedBudget: centsToDecimalOrNull(amount(facts, 'approved_budget')), totalInvestment: centsToDecimalOrNull(total),
      completedCumulative: centsToDecimalOrNull(completed), cumulativeRate: completed === null || total === null ? null : ratioString(completed, total),
      annualPlan: centsToDecimalOrNull(plan), annualActualYtd: centsToDecimalOrNull(actual), annualRate: plan === null || actual === null ? null : ratioString(actual, plan),
      period: periodValue(actual, { batch: previous, value: prevRow ? amount(prevRow.facts, 'annual_actual') : null }),
      physicalProgress: facts.get('physical_progress')?.scaled_value != null ? ratioStringScaled(facts.get('physical_progress')!.scaled_value!) : null,
      progressNote: facts.get('progress_note')?.text_value ?? null, paidCumulative: centsToDecimalOrNull(amount(facts, 'paid_cumulative')), status: rowStatus(rate),
    };
  });
  return { year: q.year, asOfPeriod: q.asOfPeriod ?? null, batch: batchDto(db, scope, batch), rows: out, notes: previous ? [] : ['无同年上期批次:当期发生额不可计算'] };
}

function ratioStringScaled(v: bigint): string {
  return factValueText({ valueType: 'ratio', amount: null, scaled: v, text: null });
}

/** 管理会计计算器 plan_execution_rate:按同年取数规则的年度执行率(投资 + 购置 + 运维 合计,只计同时有计划与实际的行)。 */
export function planExecutionRate(db: DB, orgId: number | null, period: string): {
  rate: string | null; batchId: number | null; note: string | null; annualPlanCents: bigint | null; annualActualCents: bigint | null; rowCount: number;
} {
  const scope = currentOrgScope(db);
  const year = Number(period.slice(0, 4));
  const { batch } = resolvePlanBatch(db, scope, year, period);
  if (!batch) return { rate: null, batchId: null, note: `${year} 年截至 ${period} 没有已激活的计划执行批次`, annualPlanCents: null, annualActualCents: null, rowCount: 0 };
  const rows = loadItems(db, scope, batch.id, { detailOnly: true, orgId: orgId ?? undefined });
  const both = sumBoth(rows, 'annual_plan', 'annual_actual');
  if (!both.n) return { rate: null, batchId: batch.id, note: '没有同时具备年度计划与年度累计实际的明细行', annualPlanCents: null, annualActualCents: null, rowCount: 0 };
  return { rate: ratioString(both.b, both.a), batchId: batch.id, note: null, annualPlanCents: both.a, annualActualCents: both.b, rowCount: both.n };
}
