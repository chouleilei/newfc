/**
 * 项目预算(AC-F09):预览 → 导入 → 激活 → 汇总。规则见 specs/implementation.md T-4「项目预算」。
 *
 * - 只接受 xlsx;表头在前 20 行内按别名定位。项目必须存在、启用且名称与编码一致;组织取 md_project.org_id。
 * - 预览不写库;导入全量校验通过后在一个短事务写入,按 年度 + 期间 + sha256 幂等。
 * - 激活须带页面看到的当前批次;作废须填原因。导入/激活/作废要求批次涉及的全部组织在范围内。
 * - 只读写 pb_* 与文件对象,不触碰经营预算与实际快照表。
 */
import type { DB } from '../../db/connection';
import { AppError, type RowError } from '../../core/errors';
import { currentAuth } from '../../core/request-context';
import { centsToDecimalString, ratioString } from '../../core/decimal';
import { writeLog } from '../audit/log';
import { assertFullScope, currentOrgScope, notVisible, orgInScope, scopeFilterSql, type OrgScope } from '../security/scope';
import { storeFile, type ObjectStore } from '../files/object-store';
import { readTable, type ReadTable } from '../io/table-reader';
import { amountCents, CellError, findHeader, headerKey, headerUnit, monthCell } from '../io/cell-values';
import type {
  PbBatchDto, PbEntryDto, PbGroupDto, PbPreviewDto, PbSummaryDto, PbSummaryQuery, PbTotalsDto, PbUploadForm,
} from '../../contracts/project-budget';

const nowIso = () => new Date().toISOString();
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const conflict = (code: string, message: string, details?: unknown) => new AppError(code, message, 409, undefined, details);

const COLUMNS = {
  projectCode: ['项目编码', '项目代码', '项目编号'],
  projectName: ['项目名称'],
  orgName: ['组织', '责任组织', '单位', '所属单位'],
  fundSource: ['资金来源', '资金渠道'],
  expenseCategory: ['费用类别', '费用类型', '支出类别'],
  budget: ['年度预算', '年度预算金额', '预算金额'],
  executed: ['已执行金额', '执行金额', '已执行', '累计执行金额'],
  execMonth: ['执行月份', '月份', '执行期间'],
} as const;
const REQUIRED: (keyof typeof COLUMNS)[] = ['projectCode', 'projectName', 'fundSource', 'budget', 'executed', 'execMonth'];
const LABEL: Record<keyof typeof COLUMNS, string> = {
  projectCode: '项目编码', projectName: '项目名称', orgName: '组织', fundSource: '资金来源', expenseCategory: '费用类别',
  budget: '年度预算', executed: '已执行金额', execMonth: '执行月份',
};

interface ParsedEntry {
  rowNo: number; projectId: number; projectCode: string; projectName: string; orgId: number; fundSource: string; expenseCategory: string;
  budget: bigint; executed: bigint; execMonth: string;
}
interface ParsedFile { entries: ParsedEntry[]; errors: RowError[] }

const orgNameOf = (db: DB) => {
  const cache = new Map<number, string>();
  return (id: number) => {
    if (!cache.has(id)) cache.set(id, (db.prepare('SELECT name FROM org WHERE id = ?').get(id) as { name: string } | undefined)?.name ?? `#${id}`);
    return cache.get(id)!;
  };
};

function totalsOf(budget: bigint, executed: bigint): PbTotalsDto {
  return {
    budget: centsToDecimalString(budget), executed: centsToDecimalString(executed), remaining: centsToDecimalString(budget - executed),
    executionRate: ratioString(executed, budget),
  };
}

/* ================= 解析与校验 ================= */

async function readBudgetTable(content: Buffer): Promise<ReadTable> {
  return readTable(content, 'budget.xlsx', undefined, {
    label: '项目预算表头(项目编码/项目名称/年度预算…)',
    isHeader: (cells) => {
      const keys = cells.map(headerKey);
      return REQUIRED.every((k) => COLUMNS[k].some((a) => keys.includes(a)));
    },
  });
}

async function parseBudgetFile(db: DB, scope: OrgScope, content: Buffer, form: PbUploadForm): Promise<ParsedFile> {
  const table = await readBudgetTable(content);
  const col = Object.fromEntries(Object.entries(COLUMNS).map(([k, aliases]) => [k, findHeader(table.headers, aliases)])) as Record<keyof typeof COLUMNS, string | null>;
  const unitOf = (h: string | null) => (h && headerUnit(h)) || 'yuan';
  const errors: RowError[] = [];
  const entries: ParsedEntry[] = [];
  const keys = new Map<string, number>();
  if (table.rows.length === 0) errors.push({ row: 0, field: '文件', message: '没有数据行' });
  const projects = new Map<string, { id: number; code: string; name: string; org_id: number; status: string }>();
  for (const p of db.prepare('SELECT id, code, name, org_id, status FROM md_project').all() as { id: number; code: string; name: string; org_id: number; status: string }[]) {
    projects.set(p.code, p);
  }
  const orgName = orgNameOf(db);

  for (const r of table.rows) {
    const v = (k: keyof typeof COLUMNS) => (col[k] ? r.values[col[k]!] ?? '' : '');
    const rowErrors: RowError[] = [];
    const err = (field: keyof typeof COLUMNS, message: string) => rowErrors.push({ row: r.rowNo, field: LABEL[field], message });
    const cell = <T>(field: keyof typeof COLUMNS, fn: () => T): T | null => {
      try { return fn(); } catch (e) { if (e instanceof CellError) { err(field, e.message); return null; } throw e; }
    };
    for (const k of REQUIRED) if (!v(k)) err(k, `${LABEL[k]}不能为空`);
    const code = v('projectCode');
    const project = code ? projects.get(code) : undefined;
    // 范围外项目与不存在同样处理,不泄露存在
    if (code && (!project || !orgInScope(scope, project.org_id))) err('projectCode', `项目编码 ${code} 不存在或无权访问`);
    else if (project && project.status !== 'active') err('projectCode', `项目 ${code} 已停用`);
    else if (project && v('projectName') && v('projectName') !== project.name) err('projectName', `项目名称“${v('projectName')}”与主数据“${project.name}”不一致`);
    if (project && v('orgName') && v('orgName') !== orgName(project.org_id)) err('orgName', `组织“${v('orgName')}”与项目归属组织“${orgName(project.org_id)}”不一致`);
    const budget = v('budget') ? cell('budget', () => amountCents(v('budget'), unitOf(col.budget), '年度预算')) : null;
    const executed = v('executed') ? cell('executed', () => amountCents(v('executed'), unitOf(col.executed), '已执行金额')) : null;
    if (budget != null && budget < 0n) err('budget', '年度预算不能为负');
    if (executed != null && executed < 0n) err('executed', '已执行金额不能为负');
    const month = v('execMonth') ? cell('execMonth', () => monthCell(v('execMonth'), '执行月份')) : null;
    if (month && month !== form.period) err('execMonth', `执行月份 ${month} 与本次导入期间 ${form.period} 不一致`);
    if (v('fundSource').length > 100) err('fundSource', '资金来源不能超过 100 个字符');
    if (!rowErrors.length && project && budget != null && executed != null && month) {
      const key = [project.id, v('fundSource'), project.org_id, v('expenseCategory'), month].join('\u0000');
      if (keys.has(key)) err('projectCode', `与第 ${keys.get(key)} 行的 项目 + 资金来源 + 费用类别 + 月份 重复`);
      else keys.set(key, r.rowNo);
    }
    if (rowErrors.length) { errors.push(...rowErrors); continue; }
    entries.push({
      rowNo: r.rowNo, projectId: project!.id, projectCode: project!.code, projectName: project!.name, orgId: project!.org_id,
      fundSource: v('fundSource'), expenseCategory: v('expenseCategory').slice(0, 100), budget: budget!, executed: executed!, execMonth: month!,
    });
  }
  return { entries, errors };
}

function entryDto(e: ParsedEntry, orgName: (id: number) => string): PbEntryDto {
  return {
    rowNo: e.rowNo, projectId: e.projectId, projectCode: e.projectCode, projectName: e.projectName, orgId: e.orgId, orgName: orgName(e.orgId),
    fundSource: e.fundSource, expenseCategory: e.expenseCategory, execMonth: e.execMonth, ...totalsOf(e.budget, e.executed),
  };
}

/* ================= 预览 / 导入 ================= */

export async function previewProjectBudget(db: DB, content: Buffer, form: PbUploadForm): Promise<PbPreviewDto> {
  const parsed = await parseBudgetFile(db, currentOrgScope(db), content, form);
  const orgName = orgNameOf(db);
  const budget = parsed.entries.reduce((s, e) => s + e.budget, 0n);
  const executed = parsed.entries.reduce((s, e) => s + e.executed, 0n);
  return {
    valid: parsed.errors.length === 0, rowCount: parsed.entries.length + new Set(parsed.errors.map((e) => e.row)).size, errors: parsed.errors.slice(0, 500),
    totals: totalsOf(budget, executed), orgNames: [...new Set(parsed.entries.map((e) => orgName(e.orgId)))],
    rows: parsed.entries.slice(0, 100).map((e) => entryDto(e, orgName)),
  };
}

export async function importProjectBudget(db: DB, store: ObjectStore, content: Buffer, fileName: string, form: PbUploadForm): Promise<PbBatchDto> {
  const scope = currentOrgScope(db);
  const parsed = await parseBudgetFile(db, scope, content, form);
  if (parsed.errors.length) throw new AppError('IMPORT_INVALID', `项目预算校验未通过(${parsed.errors.length} 项错误),未写入任何数据`, 422, parsed.errors.slice(0, 500));
  assertFullScope(scope, parsed.entries.map((e) => e.orgId), '项目预算批次');
  const file = storeFile(db, store, content, { originalName: fileName, contentType: XLSX_TYPE });
  const auth = currentAuth();
  const id = db.transaction((): { id: number; replayed: boolean } => {
    const existing = db.prepare('SELECT id FROM pb_batch WHERE year = ? AND period = ? AND file_sha256 = ?').get(form.year, form.period, file.sha256) as { id: number } | undefined;
    if (existing) return { id: existing.id, replayed: true };
    const batchId = Number(db.prepare(`INSERT INTO pb_batch (year, period, name, file_object_id, file_sha256, file_name, row_count, created_by_user_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(form.year, form.period, (form.name || fileName).slice(0, 100), file.id, file.sha256, fileName.slice(0, 255),
      parsed.entries.length, auth?.userId ?? null, nowIso()).lastInsertRowid);
    const ins = db.prepare(`INSERT INTO pb_entry (batch_id, row_no, project_id, project_code, project_name, org_id, fund_source, expense_category, budget_cents, executed_cents, exec_month)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const e of parsed.entries) ins.run(batchId, e.rowNo, e.projectId, e.projectCode, e.projectName, e.orgId, e.fundSource, e.expenseCategory, e.budget, e.executed, e.execMonth);
    writeLog(db, 'project_budget.import', 'pb_batch', batchId, { year: form.year, period: form.period, fileSha256: file.sha256, rows: parsed.entries.length });
    return { id: batchId, replayed: false };
  }).immediate();
  return { ...getProjectBudgetBatch(db, id.id), ...(id.replayed ? { replayed: true } : {}) };
}

/* ================= 批次 ================= */

interface BatchRow {
  id: number; year: number; period: string; name: string; file_name: string; file_sha256: string; file_object_id: number; status: 'imported' | 'voided';
  is_current: number; row_count: number; version: number; created_at: string; activated_at: string | null; voided_at: string | null; void_reason: string | null;
}

function batchOrgIds(db: DB, batchId: number): number[] {
  return (db.prepare('SELECT DISTINCT org_id FROM pb_entry WHERE batch_id = ?').all(batchId) as { org_id: number }[]).map((r) => r.org_id);
}

/** 批次可见:全组织,或至少一行明细在范围内。 */
function visibleBatchRow(db: DB, scope: OrgScope, id: number): BatchRow {
  const row = db.prepare('SELECT * FROM pb_batch WHERE id = ?').get(id) as BatchRow | undefined;
  if (!row) throw notVisible('项目预算批次');
  if (!scope.all && !batchOrgIds(db, id).some((o) => scope.orgIds.has(o))) throw notVisible('项目预算批次');
  return row;
}

function batchDto(db: DB, scope: OrgScope, b: BatchRow): PbBatchDto {
  const sc = scopeFilterSql(scope, 'org_id');
  const sums = db.prepare(`SELECT COALESCE(SUM(budget_cents), 0) AS b, COALESCE(SUM(executed_cents), 0) AS e FROM pb_entry WHERE batch_id = ? AND ${sc.sql}`)
    .safeIntegers(true).get(b.id, ...sc.params) as { b: bigint; e: bigint };
  const orgs = batchOrgIds(db, b.id);
  const orgName = orgNameOf(db);
  const visible = orgs.filter((o) => orgInScope(scope, o));
  return {
    id: b.id, year: b.year, period: b.period, name: b.name, fileName: b.file_name, fileSha256: b.file_sha256, status: b.status, isCurrent: b.is_current === 1,
    rowCount: b.row_count, totals: totalsOf(sums.b, sums.e), partial: visible.length < orgs.length, orgNames: visible.map(orgName), version: b.version,
    createdAt: b.created_at, activatedAt: b.activated_at, voidedAt: b.voided_at, voidReason: b.void_reason,
  };
}

export function getProjectBudgetBatch(db: DB, id: number): PbBatchDto {
  const scope = currentOrgScope(db);
  return batchDto(db, scope, visibleBatchRow(db, scope, id));
}

export function listProjectBudgetBatches(db: DB, q: { year?: number; period?: string; status?: string } = {}): PbBatchDto[] {
  const scope = currentOrgScope(db);
  const sc = scopeFilterSql(scope, 'e.org_id');
  const where = [scope.all ? '1=1' : `EXISTS (SELECT 1 FROM pb_entry e WHERE e.batch_id = b.id AND ${sc.sql})`];
  const params: unknown[] = scope.all ? [] : [...sc.params];
  if (q.year) { where.push('b.year = ?'); params.push(q.year); }
  if (q.period) { where.push('b.period = ?'); params.push(q.period); }
  if (q.status) { where.push('b.status = ?'); params.push(q.status); }
  return (db.prepare(`SELECT b.* FROM pb_batch b WHERE ${where.join(' AND ')} ORDER BY b.period DESC, b.id DESC LIMIT 300`).all(...params) as BatchRow[])
    .map((b) => batchDto(db, scope, b));
}

export function projectBudgetEntries(db: DB, id: number): PbEntryDto[] {
  const scope = currentOrgScope(db);
  visibleBatchRow(db, scope, id);
  const sc = scopeFilterSql(scope, 'org_id');
  const rows = db.prepare(`SELECT * FROM pb_entry WHERE batch_id = ? AND ${sc.sql} ORDER BY row_no`).safeIntegers(true).all(id, ...sc.params) as Record<string, bigint | string>[];
  const orgName = orgNameOf(db);
  return rows.map((r) => entryDto({
    rowNo: Number(r.row_no), projectId: Number(r.project_id), projectCode: String(r.project_code), projectName: String(r.project_name), orgId: Number(r.org_id),
    fundSource: String(r.fund_source), expenseCategory: String(r.expense_category), budget: r.budget_cents as bigint, executed: r.executed_cents as bigint, execMonth: String(r.exec_month),
  }, orgName));
}

export function projectBudgetOriginal(db: DB, store: ObjectStore, id: number): { fileName: string; contentType: string; content: Buffer } {
  const scope = currentOrgScope(db);
  const b = visibleBatchRow(db, scope, id);
  assertFullScope(scope, batchOrgIds(db, id), '项目预算原件');
  const f = db.prepare('SELECT sha256, content_type FROM file_object WHERE id = ?').get(b.file_object_id) as { sha256: string; content_type: string };
  return { fileName: b.file_name, contentType: f.content_type, content: store.read(f.sha256) };
}

export function activateProjectBudget(db: DB, id: number, expectedCurrentBatchId: number | null): PbBatchDto {
  const scope = currentOrgScope(db);
  db.transaction(() => {
    const b = visibleBatchRow(db, scope, id);
    assertFullScope(scope, batchOrgIds(db, id), '项目预算批次');
    if (b.status === 'voided') throw conflict('BATCH_VOIDED', '已作废的批次不能激活');
    const current = db.prepare('SELECT id FROM pb_batch WHERE year = ? AND period = ? AND is_current = 1').get(b.year, b.period) as { id: number } | undefined;
    if ((current?.id ?? null) !== expectedCurrentBatchId) {
      throw conflict('CURRENT_BATCH_CHANGED', '当前生效批次已被其他人更换,请刷新后确认', { currentBatchId: current?.id ?? null });
    }
    if (current?.id === b.id) return;
    if (current) {
      assertFullScope(scope, batchOrgIds(db, current.id), '被替换的当前项目预算批次');
      db.prepare('UPDATE pb_batch SET is_current = 0, version = version + 1 WHERE id = ?').run(current.id);
    }
    db.prepare('UPDATE pb_batch SET is_current = 1, version = version + 1, activated_by_user_id = ?, activated_at = ? WHERE id = ?')
      .run(currentAuth()?.userId ?? null, nowIso(), b.id);
    writeLog(db, 'project_budget.activate', 'pb_batch', b.id, { year: b.year, period: b.period, replaced: current?.id ?? null });
  }).immediate();
  return getProjectBudgetBatch(db, id);
}

export function voidProjectBudget(db: DB, id: number, reason: string): PbBatchDto {
  const scope = currentOrgScope(db);
  db.transaction(() => {
    const b = visibleBatchRow(db, scope, id);
    assertFullScope(scope, batchOrgIds(db, id), '项目预算批次');
    if (b.status === 'voided') return;
    db.prepare("UPDATE pb_batch SET status = 'voided', is_current = 0, version = version + 1, voided_by_user_id = ?, voided_at = ?, void_reason = ? WHERE id = ?")
      .run(currentAuth()?.userId ?? null, nowIso(), reason, b.id);
    writeLog(db, 'project_budget.void', 'pb_batch', b.id, { year: b.year, period: b.period, wasCurrent: b.is_current === 1, reason });
  }).immediate();
  return getProjectBudgetBatch(db, id);
}

/* ================= 汇总 ================= */

/**
 * 汇总:指定批次,或 年度(+期间)的当前批次;未给期间时取该年度最新期间的当前批次。
 * 只统计范围内明细;执行率在预算为 0 时为 null。
 */
export function projectBudgetSummary(db: DB, q: PbSummaryQuery = {}): PbSummaryDto {
  const scope = currentOrgScope(db);
  const notes: string[] = [];
  let batch: BatchRow | null = null;
  if (q.batchId) batch = visibleBatchRow(db, scope, q.batchId);
  else {
    const sc = scopeFilterSql(scope, 'e.org_id');
    const where = ['b.is_current = 1', scope.all ? '1=1' : `EXISTS (SELECT 1 FROM pb_entry e WHERE e.batch_id = b.id AND ${sc.sql})`];
    const params: unknown[] = scope.all ? [] : [...sc.params];
    if (q.year) { where.push('b.year = ?'); params.push(q.year); }
    if (q.period) { where.push('b.period = ?'); params.push(q.period); }
    batch = (db.prepare(`SELECT b.* FROM pb_batch b WHERE ${where.join(' AND ')} ORDER BY b.period DESC LIMIT 1`).get(...params) as BatchRow | undefined) ?? null;
    if (!batch) notes.push(q.period ? `${q.period} 没有已激活的项目预算批次` : q.year ? `${q.year} 年没有已激活的项目预算批次` : '没有已激活的项目预算批次');
  }
  if (q.orgId && !orgInScope(scope, q.orgId)) throw notVisible('组织');
  const empty = totalsOf(0n, 0n);
  if (!batch) return { batch: null, year: q.year ?? null, period: q.period ?? null, totals: empty, byProject: [], byOrg: [], byFundSource: [], notes };

  const sc = scopeFilterSql(scope, 'org_id');
  const where = ['batch_id = ?', sc.sql];
  const params: unknown[] = [batch.id, ...sc.params];
  if (q.orgId) {
    where.push('org_id IN (WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT o.id FROM org o JOIN sub ON o.parent_id = sub.id) SELECT id FROM sub)');
    params.push(q.orgId);
  }
  if (q.projectId) { where.push('project_id = ?'); params.push(q.projectId); }
  const rows = db.prepare(`SELECT project_id, project_code, project_name, org_id, fund_source, budget_cents, executed_cents FROM pb_entry WHERE ${where.join(' AND ')}`)
    .safeIntegers(true).all(...params) as { project_id: bigint; project_code: string; project_name: string; org_id: bigint; fund_source: string; budget_cents: bigint; executed_cents: bigint }[];
  const orgName = orgNameOf(db);
  const group = <K extends string | number>(keyOf: (r: typeof rows[number]) => K) => {
    const m = new Map<K, { b: bigint; e: bigint; row: typeof rows[number] }>();
    for (const r of rows) {
      const k = keyOf(r);
      const g = m.get(k) ?? { b: 0n, e: 0n, row: r };
      g.b += r.budget_cents; g.e += r.executed_cents;
      m.set(k, g);
    }
    return [...m.entries()];
  };
  const total = rows.reduce((s, r) => ({ b: s.b + r.budget_cents, e: s.e + r.executed_cents }), { b: 0n, e: 0n });
  const byProject = group((r) => Number(r.project_id)).map(([pid, g]) => ({
    key: String(pid), label: g.row.project_name, projectId: pid, projectCode: g.row.project_code, orgName: orgName(Number(g.row.org_id)), ...totalsOf(g.b, g.e),
  })).sort((a, b) => a.projectCode.localeCompare(b.projectCode));
  const byOrg = group((r) => Number(r.org_id)).map(([oid, g]) => ({ key: String(oid), label: orgName(oid), orgId: oid, ...totalsOf(g.b, g.e) }));
  const byFundSource: PbGroupDto[] = group((r) => r.fund_source).map(([fs, g]) => ({ key: fs, label: fs, ...totalsOf(g.b, g.e) }));
  return { batch: batchDto(db, scope, batch), year: batch.year, period: batch.period, totals: totalsOf(total.b, total.e), byProject, byOrg, byFundSource, notes };
}
