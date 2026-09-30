/**
 * 投资控制(四算对比,AC-F13)。规则见 specs/implementation.md T-5「投资控制」。
 *
 * - 项目必须关联主数据项目,组织取主数据;范围外 404。
 * - 版本由科目表导入(预览 → 确认核对 sha256)生成草稿;确认后科目冻结(触发器),同类型只有一个当前稿。
 * - 红线 = 已确认调整概算当前稿,否则设计概算当前稿。映射以红线(无红线时以估算当前稿)科目树为规范科目。
 * - 对比冻结为快照(不可修改/删除);版本作废或新导入不改变旧快照。
 * - 金额库内整数分,读取用 safeIntegers,聚合用 bigint。
 */
import ExcelJS from 'exceljs';
import type { DB } from '../../db/connection';
import { AppError, Errors, type RowError } from '../../core/errors';
import { currentAuth } from '../../core/request-context';
import { canonicalHash } from '../../core/canonical';
import { centsToDecimalString, centsToDecimalOrNull, parseDecimalToCents, parseScaled, ratioString, RATIO_SCALE } from '../../core/decimal';
import { writeLog } from '../audit/log';
import { currentOrgScope, notVisible, orgInScope, scopeFilterSql } from '../security/scope';
import { storeFile, type ObjectStore } from '../files/object-store';
import { readTable } from '../io/table-reader';
import { amountCents, CellError, findHeader, headerKey, headerUnit } from '../io/cell-values';
import { icDefaultThresholds } from '../settings/business-settings';
import {
  IC_VERSION_TYPE_LABELS, type IcChainItemDto, type IcComparisonRowDto, type IcComparisonSummaryDto, type IcLevel, type IcVersionType,
} from '../../contracts/investment-control';

const nowIso = () => new Date().toISOString();
const conflict = (code: string, message: string, details?: unknown) => new AppError(code, message, 409, undefined, details);
const XLSX_TYPE = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MAX_ITEMS = 5000;
/** 出厂默认阈值,与业务设置 investment.ic_threshold_* 的默认值一致;实际取值见 icDefaultThresholds。 */
export const IC_DEFAULT_THRESHOLDS = { normal: '0.03', attention: '0.08', warning: '0.10' };

interface ProjectRow {
  id: number; md_project_id: number; org_id: number; approved_cents: bigint | null; approval_doc_no: string; status: 'active' | 'archived'; version: number;
  created_at: string; updated_at: string;
}
interface VersionRow {
  id: number; project_id: number; version_type: IcVersionType; version_no: number; name: string; status: 'draft' | 'confirmed' | 'voided'; is_current: number;
  static_cents: bigint; dynamic_cents: bigint; approval_doc_no: string; approval_date: string | null; source_file_name: string | null; content_hash: string | null;
  void_reason: string | null; version: number; created_by_user_id: number | null; created_at: string; confirmed_by_user_id: number | null; confirmed_at: string | null;
}
interface ItemRow {
  id: number; version_id: number; row_no: number; item_code: string; parent_code: string | null; level: number; name: string; category: string;
  static_cents: bigint; dynamic_cents: bigint; source_cell: string | null; canonical_code: string | null;
  mapping_status: 'matched' | 'need_mapping' | 'manual' | 'ignored'; mapping_method: string | null;
}

/** 读金额列:整数统一 bigint,再把 id 等小整数转回 number。 */
function bigGet<T>(db: DB, sql: string, ...params: unknown[]): T | undefined {
  const row = db.prepare(sql).safeIntegers(true).get(...params) as Record<string, unknown> | undefined;
  return row ? (fromBig(row) as T) : undefined;
}
function bigAll<T>(db: DB, sql: string, ...params: unknown[]): T[] {
  return (db.prepare(sql).safeIntegers(true).all(...params) as Record<string, unknown>[]).map((r) => fromBig(r) as T);
}
function fromBig(row: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(row)) out[k] = typeof v === 'bigint' && !k.endsWith('_cents') ? Number(v) : v;
  return out;
}

const userName = (db: DB, id: number | null): string | null =>
  id == null ? null : ((db.prepare('SELECT COALESCE(NULLIF(display_name, \'\'), username) AS n FROM app_user WHERE id = ?').get(id) as { n: string } | undefined)?.n ?? null);

function visibleProject(db: DB, id: number): ProjectRow {
  const p = bigGet<ProjectRow>(db, 'SELECT * FROM ic_project WHERE id = ?', id);
  if (!p || !orgInScope(currentOrgScope(db), p.org_id)) throw notVisible('投资控制项目');
  return p;
}
function visibleVersion(db: DB, id: number): { version: VersionRow; project: ProjectRow } {
  const v = bigGet<VersionRow>(db, 'SELECT * FROM ic_version WHERE id = ?', id);
  if (!v) throw notVisible('投资版本');
  const project = bigGet<ProjectRow>(db, 'SELECT * FROM ic_project WHERE id = ?', v.project_id)!;
  if (!orgInScope(currentOrgScope(db), project.org_id)) throw notVisible('投资版本');
  return { version: v, project };
}
function assertActive(p: ProjectRow): void {
  if (p.status !== 'active') throw conflict('IC_VERSION_STATE', '项目已归档,不能修改');
}

// ---------------- 项目 ----------------

function projectDto(db: DB, p: ProjectRow) {
  const md = db.prepare('SELECT m.code, m.name, o.name AS org_name FROM md_project m JOIN org o ON o.id = m.org_id WHERE m.id = ?').get(p.md_project_id) as
    { code: string; name: string; org_name: string };
  const redline = redlineVersion(db, p.id);
  const versions = bigAll<VersionRow>(db, "SELECT * FROM ic_version WHERE project_id = ? AND is_current = 1", p.id);
  return {
    id: p.id, mdProjectId: p.md_project_id, code: md.code, name: md.name, orgId: p.org_id, orgName: md.org_name,
    approvedAmount: centsToDecimalOrNull(p.approved_cents), approvalDocNo: p.approval_doc_no, status: p.status, version: p.version,
    redlineVersionId: redline?.id ?? null, redlineAmount: redline ? centsToDecimalString(redline.static_cents) : null,
    current: Object.fromEntries(versions.map((v) => [v.version_type, { id: v.id, versionNo: v.version_no, staticTotal: centsToDecimalString(v.static_cents) }])),
    createdAt: p.created_at, updatedAt: p.updated_at,
  };
}

export function listIcProjects(db: DB, q: { orgId?: number; status?: 'active' | 'archived'; keyword?: string }) {
  const f = scopeFilterSql(currentOrgScope(db), 'p.org_id');
  const where = [f.sql];
  const params: unknown[] = [...f.params];
  if (q.orgId) { where.push('p.org_id = ?'); params.push(q.orgId); }
  if (q.status) { where.push('p.status = ?'); params.push(q.status); }
  if (q.keyword) { where.push('(m.code LIKE ? OR m.name LIKE ?)'); params.push(`%${q.keyword}%`, `%${q.keyword}%`); }
  const rows = bigAll<ProjectRow>(db, `SELECT p.* FROM ic_project p JOIN md_project m ON m.id = p.md_project_id WHERE ${where.join(' AND ')} ORDER BY p.id DESC LIMIT 500`, ...params);
  return { items: rows.map((r) => projectDto(db, r)) };
}

export function createIcProject(db: DB, input: { mdProjectId: number; approvedAmount?: string | null; approvalDocNo?: string }) {
  const md = db.prepare('SELECT org_id, status FROM md_project WHERE id = ?').get(input.mdProjectId) as { org_id: number; status: string } | undefined;
  if (!md || !orgInScope(currentOrgScope(db), md.org_id)) throw notVisible('项目');
  if (md.status !== 'active') throw Errors.validation('主数据项目已停用');
  const approved = input.approvedAmount == null ? null : parseDecimalToCents(input.approvedAmount, { label: '批复概算' });
  return db.transaction(() => {
    if (db.prepare('SELECT 1 FROM ic_project WHERE md_project_id = ?').get(input.mdProjectId)) throw conflict('DUPLICATE', '该项目已建立投资控制');
    const now = nowIso();
    const id = Number(db.prepare(`INSERT INTO ic_project (md_project_id, org_id, approved_cents, approval_doc_no, created_by_user_id, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?)`).run(input.mdProjectId, md.org_id, approved, input.approvalDocNo ?? '', currentAuth()?.userId ?? null, now, now).lastInsertRowid);
    writeLog(db, 'investment.control.project.create', 'ic_project', id, { mdProjectId: input.mdProjectId });
    return getIcProject(db, id);
  })();
}

export function updateIcProject(db: DB, id: number, input: { expectedVersion: number; approvedAmount?: string | null; approvalDocNo?: string; status?: 'active' | 'archived' }) {
  return db.transaction(() => {
    const p = visibleProject(db, id);
    if (p.version !== input.expectedVersion) throw conflict('VERSION_CONFLICT', '项目已被其他人修改,请刷新后重试', { currentVersion: p.version });
    const approved = input.approvedAmount === undefined ? p.approved_cents : input.approvedAmount == null ? null : parseDecimalToCents(input.approvedAmount, { label: '批复概算' });
    db.prepare('UPDATE ic_project SET approved_cents = ?, approval_doc_no = ?, status = ?, version = version + 1, updated_at = ? WHERE id = ?')
      .run(approved, input.approvalDocNo ?? p.approval_doc_no, input.status ?? p.status, nowIso(), id);
    writeLog(db, 'investment.control.project.update', 'ic_project', id, { status: input.status ?? p.status });
    return getIcProject(db, id);
  }).immediate();
}

export function getIcProject(db: DB, id: number) {
  const p = visibleProject(db, id);
  const versions = bigAll<VersionRow>(db, 'SELECT * FROM ic_version WHERE project_id = ? ORDER BY version_type, version_no DESC', id);
  const redline = redlineVersion(db, id);
  return { ...projectDto(db, p), versions: versions.map((v) => versionDto(db, v, redline?.id ?? null)) };
}

// ---------------- 版本 ----------------

export function redlineVersion(db: DB, projectId: number): VersionRow | undefined {
  return bigGet<VersionRow>(db, "SELECT * FROM ic_version WHERE project_id = ? AND is_current = 1 AND version_type = 'adjusted_estimate'", projectId)
    ?? bigGet<VersionRow>(db, "SELECT * FROM ic_version WHERE project_id = ? AND is_current = 1 AND version_type = 'design_estimate'", projectId);
}
/** 规范科目树来源:红线,否则估算当前稿;排除版本自身。 */
function referenceVersion(db: DB, projectId: number, excludeId: number): VersionRow | undefined {
  const r = redlineVersion(db, projectId);
  if (r && r.id !== excludeId) return r;
  const e = bigGet<VersionRow>(db, "SELECT * FROM ic_version WHERE project_id = ? AND is_current = 1 AND version_type = 'estimate'", projectId);
  return e && e.id !== excludeId ? e : undefined;
}

function versionDto(db: DB, v: VersionRow, redlineId: number | null) {
  const counts = Object.fromEntries((db.prepare('SELECT mapping_status AS s, COUNT(*) AS n FROM ic_item WHERE version_id = ? GROUP BY mapping_status').all(v.id) as { s: string; n: number }[])
    .map((r) => [r.s, r.n]));
  return {
    id: v.id, projectId: v.project_id, versionType: v.version_type, typeLabel: IC_VERSION_TYPE_LABELS[v.version_type], versionNo: v.version_no, name: v.name,
    status: v.status, isCurrent: v.is_current === 1, isRedline: v.id === redlineId,
    staticTotal: centsToDecimalString(v.static_cents), dynamicTotal: centsToDecimalString(v.dynamic_cents),
    approvalDocNo: v.approval_doc_no, approvalDate: v.approval_date, sourceFileName: v.source_file_name, contentHash: v.content_hash, voidReason: v.void_reason,
    version: v.version, createdAt: v.created_at, createdBy: userName(db, v.created_by_user_id), confirmedAt: v.confirmed_at, confirmedBy: userName(db, v.confirmed_by_user_id),
    mappingCounts: { matched: counts.matched ?? 0, need_mapping: counts.need_mapping ?? 0, manual: counts.manual ?? 0, ignored: counts.ignored ?? 0 },
  };
}

const itemDto = (i: ItemRow, canonicalNames: Map<string, string>) => ({
  id: i.id, rowNo: i.row_no, code: i.item_code, parentCode: i.parent_code, level: i.level, name: i.name, category: i.category,
  staticAmount: centsToDecimalString(i.static_cents), dynamicAmount: centsToDecimalString(i.dynamic_cents), sourceCell: i.source_cell,
  canonicalCode: i.canonical_code, canonicalName: i.canonical_code ? canonicalNames.get(i.canonical_code) ?? null : null,
  mappingStatus: i.mapping_status, mappingMethod: i.mapping_method,
});

export function getIcVersion(db: DB, id: number) {
  const { version, project } = visibleVersion(db, id);
  const items = bigAll<ItemRow>(db, 'SELECT * FROM ic_item WHERE version_id = ? ORDER BY row_no', id);
  const ref = referenceVersion(db, project.id, id);
  const refItems = ref ? bigAll<ItemRow>(db, 'SELECT * FROM ic_item WHERE version_id = ? ORDER BY row_no', ref.id) : [];
  const names = new Map((ref ? refItems : items).map((i) => [i.item_code, i.name]));
  return {
    ...versionDto(db, version, redlineVersion(db, project.id)?.id ?? null),
    referenceVersionId: ref?.id ?? null,
    canonicalItems: refItems.map((i) => ({ code: i.item_code, name: i.name, level: i.level })),
    items: items.map((i) => itemDto(i, names)),
  };
}

export function normalizeItemName(name: string): string {
  return name.replace(/[\s　]/g, '')
    .replace(/^[（(]?[一二三四五六七八九十百\d]+[)）、.．]/, '')
    .replace(/[()（）【】[\]、,，.。:：;；\-—_]/g, '')
    .toLowerCase();
}

/** 自动映射(保留用户已确认/忽略的行)。无参照版本时本版本科目即规范科目。 */
function automap(db: DB, v: VersionRow): void {
  const ref = referenceVersion(db, v.project_id, v.id);
  const items = db.prepare("SELECT id, item_code, name FROM ic_item WHERE version_id = ? AND mapping_status NOT IN ('manual','ignored')").all(v.id) as
    { id: number; item_code: string; name: string }[];
  const upd = db.prepare('UPDATE ic_item SET canonical_code = ?, mapping_status = ?, mapping_method = ? WHERE id = ?');
  if (!ref) {
    for (const i of items) upd.run(i.item_code, 'matched', 'self', i.id);
    return;
  }
  const refItems = db.prepare('SELECT item_code, name FROM ic_item WHERE version_id = ?').all(ref.id) as { item_code: string; name: string }[];
  const codes = new Set(refItems.map((r) => r.item_code));
  const byName = new Map<string, string[]>();
  for (const r of refItems) {
    const k = normalizeItemName(r.name);
    byName.set(k, [...(byName.get(k) ?? []), r.item_code]);
  }
  for (const i of items) {
    if (codes.has(i.item_code)) { upd.run(i.item_code, 'matched', 'code', i.id); continue; }
    const hit = byName.get(normalizeItemName(i.name));
    if (hit?.length === 1) upd.run(hit[0], 'need_mapping', 'name_suggested', i.id);
    else upd.run(null, 'need_mapping', null, i.id);
  }
}

export function updateIcMapping(db: DB, versionId: number, input: { expectedVersion: number; items: { itemId: number; action: 'map' | 'ignore' | 'reset'; canonicalCode?: string }[] }) {
  return db.transaction(() => {
    const { version, project } = visibleVersion(db, versionId);
    assertActive(project);
    if (version.status !== 'draft') throw conflict('IC_VERSION_STATE', '只有草稿版本可以调整映射');
    if (version.version !== input.expectedVersion) throw conflict('VERSION_CONFLICT', '版本已被其他人修改,请刷新后重试', { currentVersion: version.version });
    const ref = referenceVersion(db, project.id, versionId);
    const canonical = new Set((db.prepare('SELECT item_code FROM ic_item WHERE version_id = ?').all(ref?.id ?? versionId) as { item_code: string }[]).map((r) => r.item_code));
    const upd = db.prepare('UPDATE ic_item SET canonical_code = ?, mapping_status = ?, mapping_method = ? WHERE id = ? AND version_id = ?');
    for (const it of input.items) {
      let changes: number;
      if (it.action === 'map') {
        if (!canonical.has(it.canonicalCode!)) throw Errors.validation(`规范科目 ${it.canonicalCode} 不存在`);
        changes = upd.run(it.canonicalCode, 'manual', 'manual', it.itemId, versionId).changes;
      } else if (it.action === 'ignore') changes = upd.run(null, 'ignored', 'manual', it.itemId, versionId).changes;
      else changes = upd.run(null, 'need_mapping', null, it.itemId, versionId).changes;
      if (!changes) throw Errors.validation(`科目行 ${it.itemId} 不属于该版本`);
    }
    automap(db, version);
    db.prepare('UPDATE ic_version SET version = version + 1, updated_at = ? WHERE id = ?').run(nowIso(), versionId);
    writeLog(db, 'investment.control.mapping', 'ic_version', versionId, { items: input.items.length });
    return getIcVersion(db, versionId);
  }).immediate();
}

export function confirmIcVersion(db: DB, versionId: number, expectedVersion: number) {
  return db.transaction(() => {
    const { version, project } = visibleVersion(db, versionId);
    assertActive(project);
    if (version.status !== 'draft') throw conflict('IC_VERSION_STATE', '只有草稿版本可以确认');
    if (version.version !== expectedVersion) throw conflict('VERSION_CONFLICT', '版本已被其他人修改,请刷新后重试', { currentVersion: version.version });
    automap(db, version);
    const unmapped = bigAll<ItemRow>(db, "SELECT * FROM ic_item WHERE version_id = ? AND mapping_status = 'need_mapping' AND (static_cents <> 0 OR dynamic_cents <> 0) ORDER BY row_no", versionId);
    if (unmapped.length) {
      throw conflict('IC_UNMAPPED_ITEMS', `还有 ${unmapped.length} 个非零科目未映射,请确认映射或忽略`, {
        items: unmapped.slice(0, 200).map((i) => ({ itemId: i.id, code: i.item_code, name: i.name, suggestion: i.canonical_code })),
      });
    }
    const now = nowIso();
    db.prepare("UPDATE ic_version SET is_current = 0, updated_at = ? WHERE project_id = ? AND version_type = ? AND is_current = 1").run(now, project.id, version.version_type);
    db.prepare("UPDATE ic_version SET status = 'confirmed', is_current = 1, confirmed_by_user_id = ?, confirmed_at = ?, version = version + 1, updated_at = ? WHERE id = ?")
      .run(currentAuth()?.userId ?? null, now, now, versionId);
    writeLog(db, 'investment.control.version.confirm', 'ic_version', versionId, { versionType: version.version_type, versionNo: version.version_no, contentHash: version.content_hash });
    return getIcVersion(db, versionId);
  }).immediate();
}

export function voidIcVersion(db: DB, versionId: number, expectedVersion: number, reason: string) {
  return db.transaction(() => {
    const { version, project } = visibleVersion(db, versionId);
    assertActive(project);
    if (version.status === 'voided') throw conflict('IC_VERSION_STATE', '版本已作废');
    if (version.version !== expectedVersion) throw conflict('VERSION_CONFLICT', '版本已被其他人修改,请刷新后重试', { currentVersion: version.version });
    const now = nowIso();
    db.prepare("UPDATE ic_version SET status = 'voided', is_current = 0, void_reason = ?, version = version + 1, updated_at = ? WHERE id = ?").run(reason, now, versionId);
    if (version.is_current) {
      // 作废当前稿:同类型最近的已确认稿恢复为当前稿
      const prev = db.prepare("SELECT id FROM ic_version WHERE project_id = ? AND version_type = ? AND status = 'confirmed' ORDER BY version_no DESC LIMIT 1")
        .get(project.id, version.version_type) as { id: number } | undefined;
      if (prev) db.prepare('UPDATE ic_version SET is_current = 1, updated_at = ? WHERE id = ?').run(now, prev.id);
    }
    writeLog(db, 'investment.control.version.void', 'ic_version', versionId, { reason, wasCurrent: version.is_current === 1 });
    return getIcVersion(db, versionId);
  }).immediate();
}

// ---------------- 导入 ----------------

const COLUMNS = {
  code: ['科目编码', '编码', '项目编码', '序号'],
  name: ['科目名称', '名称', '工程或费用名称', '项目名称'],
  category: ['分类', '类别', '费用类别'],
  static: ['静态投资', '静态金额', '静态总投资'],
  dynamic: ['动态投资', '动态金额', '动态总投资', '总投资'],
} as const;

interface ParsedItem { rowNo: number; code: string; parentCode: string | null; level: number; name: string; category: string; staticCents: string; dynamicCents: string; sourceCell: string }
interface ParsedImport { items: ParsedItem[]; errors: RowError[]; hash: string }

export const codeLevel = (code: string) => code.split('.').length;
const parentOf = (code: string) => (code.includes('.') ? code.slice(0, code.lastIndexOf('.')) : null);
export function compareCodes(a: string, b: string): number {
  const x = a.split('.').map(Number);
  const y = b.split('.').map(Number);
  for (let i = 0; i < Math.max(x.length, y.length); i += 1) {
    if (x[i] === undefined) return -1;
    if (y[i] === undefined) return 1;
    if (x[i] !== y[i]) return x[i] - y[i];
  }
  return 0;
}

async function parseIcImport(content: Buffer, fileName: string, versionType: IcVersionType): Promise<ParsedImport> {
  const table = await readTable(content, fileName, MAX_ITEMS, {
    label: '投资科目表头(科目编码/科目名称/静态投资/动态投资)',
    isHeader: (cells) => { const keys = cells.map(headerKey); return COLUMNS.code.some((a) => keys.includes(a)) && COLUMNS.name.some((a) => keys.includes(a)); },
  });
  const col = {
    code: findHeader(table.headers, COLUMNS.code), name: findHeader(table.headers, COLUMNS.name), category: findHeader(table.headers, COLUMNS.category),
    static: findHeader(table.headers, COLUMNS.static), dynamic: findHeader(table.headers, COLUMNS.dynamic),
  };
  const errors: RowError[] = [];
  if (!col.static) errors.push({ row: 0, field: '表头', message: '缺少“静态投资”列' });
  if (!col.dynamic) errors.push({ row: 0, field: '表头', message: '缺少“动态投资”列' });
  const unit = (h: string | null) => (h && headerUnit(h)) || 'wan';
  const items: ParsedItem[] = [];
  const byCode = new Map<string, ParsedItem>();
  for (const r of table.rows) {
    const v = (h: string | null) => (h ? (r.values[h] ?? '').trim() : '');
    const code = v(col.code).replace(/\.$/, '');
    const name = v(col.name);
    if (!code && !name && !v(col.static) && !v(col.dynamic)) continue;
    const err = (field: string, message: string) => errors.push({ row: r.rowNo, field, message });
    if (!/^\d{1,4}(\.\d{1,4}){0,7}$/.test(code)) { err('科目编码', `科目编码“${code}”格式不正确(应为 1、1.1、1.1.1)`); continue; }
    if (!name) err('科目名称', '科目名称不能为空');
    if (byCode.has(code)) { err('科目编码', `科目编码 ${code} 重复`); continue; }
    const amount = (h: string | null, label: string): bigint => {
      try {
        const cents = amountCents(v(h), unit(h), label) ?? 0n;
        if (cents < 0n) { err(label, `${label}不能为负`); return 0n; }
        return cents;
      } catch (e) {
        if (e instanceof CellError) { err(label, e.message); return 0n; }
        throw e;
      }
    };
    const item: ParsedItem = {
      rowNo: r.rowNo, code, parentCode: parentOf(code), level: codeLevel(code), name: name.slice(0, 200), category: v(col.category).slice(0, 64),
      staticCents: String(amount(col.static, '静态投资')), dynamicCents: String(amount(col.dynamic, '动态投资')), sourceCell: `第${r.rowNo}行`,
    };
    items.push(item);
    byCode.set(code, item);
  }
  if (!items.length && !errors.length) errors.push({ row: 0, field: '文件', message: '没有科目行' });
  // 父级存在;父级金额 = 子级合计(差额超过 1 分为错误)
  const children = new Map<string, ParsedItem[]>();
  for (const it of items) {
    if (!it.parentCode) continue;
    if (!byCode.has(it.parentCode)) { errors.push({ row: it.rowNo, field: '科目编码', message: `父级科目 ${it.parentCode} 不存在` }); continue; }
    children.set(it.parentCode, [...(children.get(it.parentCode) ?? []), it]);
  }
  for (const [code, kids] of children) {
    const parent = byCode.get(code)!;
    for (const [key, label] of [['staticCents', '静态投资'], ['dynamicCents', '动态投资']] as const) {
      const sum = kids.reduce((s, k) => s + BigInt(k[key]), 0n);
      const diff = BigInt(parent[key]) - sum;
      if (diff > 1n || diff < -1n) {
        errors.push({ row: parent.rowNo, field: label, message: `科目 ${code} ${label} ${centsToDecimalString(BigInt(parent[key]))} 元与子级合计 ${centsToDecimalString(sum)} 元不一致` });
      }
    }
  }
  items.sort((a, b) => a.rowNo - b.rowNo);
  const hash = canonicalHash({ versionType, items: items.map((i) => [i.code, i.name, i.category, i.staticCents, i.dynamicCents]) });
  return { items, errors, hash };
}

interface IcImportRow {
  id: number; project_id: number; version_type: IcVersionType; file_object_id: number; file_sha256: string; file_name: string; row_count: number; error_count: number;
  items_json: string; errors_json: string; status: 'previewed' | 'confirmed'; version_id: number | null; created_by_user_id: number | null; created_at: string; confirmed_at: string | null;
}
interface ImportMeta { name: string; approvalDocNo: string; approvalDate: string | null; hash: string }

function importDto(r: IcImportRow) {
  const payload = JSON.parse(r.items_json) as { meta: ImportMeta; items: ParsedItem[] };
  const sumLevel1 = (key: 'staticCents' | 'dynamicCents') => payload.items.filter((i) => i.level === 1).reduce((s, i) => s + BigInt(i[key]), 0n);
  return {
    id: r.id, projectId: r.project_id, versionType: r.version_type, fileName: r.file_name, sha256: r.file_sha256, status: r.status, rowCount: r.row_count,
    errorCount: r.error_count, errors: JSON.parse(r.errors_json) as RowError[], name: payload.meta.name, versionId: r.version_id,
    staticTotal: centsToDecimalString(sumLevel1('staticCents')), dynamicTotal: centsToDecimalString(sumLevel1('dynamicCents')),
    items: payload.items.slice(0, 500).map((i) => ({ ...i, staticAmount: centsToDecimalString(BigInt(i.staticCents)), dynamicAmount: centsToDecimalString(BigInt(i.dynamicCents)) })),
    createdAt: r.created_at, confirmedAt: r.confirmed_at,
  };
}

export async function previewIcImport(db: DB, store: ObjectStore, projectId: number, content: Buffer, fileName: string,
  form: { versionType: IcVersionType; name?: string; approvalDocNo?: string; approvalDate?: string }) {
  const p = visibleProject(db, projectId);
  assertActive(p);
  const parsed = await parseIcImport(content, fileName, form.versionType);
  const file = storeFile(db, store, content, { originalName: fileName, contentType: fileName.toLowerCase().endsWith('.csv') ? 'text/csv' : XLSX_TYPE });
  const meta: ImportMeta = { name: form.name || IC_VERSION_TYPE_LABELS[form.versionType], approvalDocNo: form.approvalDocNo ?? '', approvalDate: form.approvalDate ?? null, hash: parsed.hash };
  const id = db.transaction(() => {
    const rid = Number(db.prepare(`INSERT INTO ic_import (project_id, version_type, file_object_id, file_sha256, file_name, row_count, error_count, items_json, errors_json,
      created_by_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(projectId, form.versionType, file.id, file.sha256, fileName, parsed.items.length,
      parsed.errors.length, JSON.stringify({ meta, items: parsed.items }), JSON.stringify(parsed.errors.slice(0, 500)), currentAuth()?.userId ?? null, nowIso()).lastInsertRowid);
    writeLog(db, 'investment.control.import.preview', 'ic_import', rid, { projectId, versionType: form.versionType, rows: parsed.items.length, errors: parsed.errors.length });
    return rid;
  })();
  return importDto(db.prepare('SELECT * FROM ic_import WHERE id = ?').get(id) as IcImportRow);
}

export async function confirmIcImport(db: DB, store: ObjectStore, importId: number, sha256: string) {
  const imp = db.prepare('SELECT * FROM ic_import WHERE id = ?').get(importId) as IcImportRow | undefined;
  if (!imp) throw notVisible('导入预览');
  const p = visibleProject(db, imp.project_id);
  assertActive(p);
  if (imp.created_by_user_id !== (currentAuth()?.userId ?? null)) throw new AppError('PREVIEW_OWNER_MISMATCH', '只能由预览人确认本次导入', 403);
  if (imp.status === 'confirmed') return { ...importDto(imp), replayed: true };
  if (sha256 !== imp.file_sha256) throw conflict('PREVIEW_STALE', '确认的文件与预览不一致,请重新预览');
  if (imp.error_count > 0) throw new AppError('IMPORT_INVALID', `预览有 ${imp.error_count} 项错误,不能确认`, 422, JSON.parse(imp.errors_json));
  const { meta } = JSON.parse(imp.items_json) as { meta: ImportMeta };
  const parsed = await parseIcImport(store.read(imp.file_sha256), imp.file_name, imp.version_type);
  if (parsed.errors.length) throw new AppError('IMPORT_INVALID', `重新校验发现 ${parsed.errors.length} 项错误,未写入任何数据`, 422, parsed.errors.slice(0, 500));
  if (parsed.hash !== meta.hash) throw conflict('PREVIEW_STALE', '按原件重新解析的结果与预览不一致,请重新预览');
  db.transaction(() => {
    const fresh = db.prepare('SELECT status FROM ic_import WHERE id = ?').get(importId) as { status: string };
    if (fresh.status === 'confirmed') return;
    const now = nowIso();
    const no = (db.prepare('SELECT COALESCE(MAX(version_no), 0) + 1 AS n FROM ic_version WHERE project_id = ? AND version_type = ?').get(imp.project_id, imp.version_type) as { n: number }).n;
    const level1 = parsed.items.filter((i) => i.level === 1);
    const staticTotal = level1.reduce((s, i) => s + BigInt(i.staticCents), 0n);
    const dynamicTotal = level1.reduce((s, i) => s + BigInt(i.dynamicCents), 0n);
    const vid = Number(db.prepare(`INSERT INTO ic_version (project_id, version_type, version_no, name, static_cents, dynamic_cents, approval_doc_no, approval_date,
      source_file_object_id, source_file_name, content_hash, created_by_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      imp.project_id, imp.version_type, no, meta.name, staticTotal, dynamicTotal, meta.approvalDocNo, meta.approvalDate, imp.file_object_id, imp.file_name, parsed.hash,
      currentAuth()?.userId ?? null, now, now,
    ).lastInsertRowid);
    const ins = db.prepare(`INSERT INTO ic_item (version_id, row_no, item_code, parent_code, level, name, category, static_cents, dynamic_cents, source_cell, mapping_status)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'need_mapping')`);
    for (const i of parsed.items) ins.run(vid, i.rowNo, i.code, i.parentCode, i.level, i.name, i.category, BigInt(i.staticCents), BigInt(i.dynamicCents), i.sourceCell);
    automap(db, bigGet<VersionRow>(db, 'SELECT * FROM ic_version WHERE id = ?', vid)!);
    db.prepare("UPDATE ic_import SET status = 'confirmed', version_id = ?, confirmed_at = ? WHERE id = ?").run(vid, now, importId);
    writeLog(db, 'investment.control.import.confirm', 'ic_import', importId, { versionId: vid, versionType: imp.version_type, versionNo: no, contentHash: parsed.hash });
  }).immediate();
  return { ...importDto(db.prepare('SELECT * FROM ic_import WHERE id = ?').get(importId) as IcImportRow), replayed: false };
}

export async function icTemplateBuffer(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('投资科目');
  ws.addRow(['科目编码', '科目名称', '分类', '静态投资(万元)', '动态投资(万元)']).font = { bold: true };
  ws.addRow(['1', '工程部分', '工程', '0', '0']);
  ws.addRow(['1.1', '建筑工程', '工程', '0', '0']);
  ws.columns.forEach((c) => { c.width = 18; });
  const note = wb.addWorksheet('说明');
  [
    '科目编码按层级写 1、1.1、1.1.1,父级必须存在;父级金额须等于子级合计(差额不超过 0.01 元)。',
    '金额单位万元,最多 6 位小数(折合到分);不允许负数。',
  ].forEach((t) => note.addRow([t]));
  return Buffer.from(await wb.xlsx.writeBuffer());
}

// ---------------- 对比 ----------------

interface ComparisonRow {
  id: number; project_id: number; base_version_id: number; target_version_id: number; base_content_hash: string; target_content_hash: string;
  redline_version_id: number | null; thresholds_json: string; rows_json: string; summary_json: string; content_sha256: string; created_by_user_id: number | null; created_at: string;
}

function aggregate(db: DB, versionId: number): Map<string, { staticCents: bigint; dynamicCents: bigint; name: string }> {
  const items = bigAll<ItemRow>(db, 'SELECT * FROM ic_item WHERE version_id = ?', versionId);
  const byCode = new Map(items.map((i) => [i.item_code, i]));
  const out = new Map<string, { staticCents: bigint; dynamicCents: bigint; name: string }>();
  for (const i of items) {
    if (!i.canonical_code || (i.mapping_status !== 'matched' && i.mapping_status !== 'manual')) continue;
    // 父子映射到同一规范科目时只计父级,避免重复
    let anc = i.parent_code ? byCode.get(i.parent_code) : undefined;
    let dup = false;
    while (anc) {
      if (anc.canonical_code === i.canonical_code && (anc.mapping_status === 'matched' || anc.mapping_status === 'manual')) { dup = true; break; }
      anc = anc.parent_code ? byCode.get(anc.parent_code) : undefined;
    }
    if (dup) continue;
    const cur = out.get(i.canonical_code) ?? { staticCents: 0n, dynamicCents: 0n, name: i.name };
    cur.staticCents += i.static_cents;
    cur.dynamicCents += i.dynamic_cents;
    out.set(i.canonical_code, cur);
  }
  return out;
}

export function alertLevelOf(rateScaled: bigint | null, t: { normal: bigint; attention: bigint; warning: bigint }): IcLevel | null {
  if (rateScaled == null) return null;
  const a = rateScaled < 0n ? -rateScaled : rateScaled;
  if (a <= t.normal) return 'normal';
  if (a <= t.attention) return 'attention';
  if (a <= t.warning) return 'warning';
  return 'exceed';
}
const rateScaledOf = (dev: bigint, base: bigint): bigint | null => (base === 0n ? null : parseScaled(ratioString(dev, base)!, RATIO_SCALE));

/** 控制链:按项目各类型当前稿(静态金额)。 */
export function controlChain(db: DB, projectId: number): { chain: IcChainItemDto[]; redline: VersionRow | undefined } {
  const cur = (t: IcVersionType) => bigGet<VersionRow>(db, 'SELECT * FROM ic_version WHERE project_id = ? AND version_type = ? AND is_current = 1', projectId, t);
  const redline = redlineVersion(db, projectId);
  const budget = cur('construction_budget');
  const settlement = cur('settlement');
  const finalAccount = cur('final_account');
  const chain: IcChainItemDto[] = [];
  const push = (status: IcChainItemDto['status'], message: string, s: VersionRow, r: VersionRow) => chain.push({
    status, message, subjectVersionId: s.id, referenceVersionId: r.id, subjectAmount: centsToDecimalString(s.static_cents), referenceAmount: centsToDecimalString(r.static_cents),
  });
  if (budget && redline && budget.static_cents > redline.static_cents) push('budget_over_estimate', '施工图预算超过概算(红线)', budget, redline);
  if (settlement && budget && settlement.static_cents > budget.static_cents) push('settlement_over_budget', '竣工结算超过施工图预算', settlement, budget);
  if (settlement && redline && settlement.static_cents > redline.static_cents) push('over_redline', '竣工结算超过概算红线', settlement, redline);
  if (finalAccount && redline && finalAccount.static_cents > redline.static_cents) push('over_redline', '竣工决算超过概算红线', finalAccount, redline);
  return { chain, redline };
}

export function createIcComparison(db: DB, input: { baseVersionId: number; targetVersionId: number; thresholds?: { normal: string; attention: string; warning: string } }) {
  const { version: base, project } = visibleVersion(db, input.baseVersionId);
  const { version: target } = visibleVersion(db, input.targetVersionId);
  if (target.project_id !== base.project_id) throw Errors.validation('基准与目标版本必须属于同一项目');
  for (const v of [base, target]) if (v.status !== 'confirmed') throw conflict('IC_VERSION_STATE', `版本“${v.name}”未确认或已作废,不能对比`);
  const thresholds = input.thresholds ?? icDefaultThresholds(db);
  const t = {
    normal: parseScaled(thresholds.normal, RATIO_SCALE), attention: parseScaled(thresholds.attention, RATIO_SCALE), warning: parseScaled(thresholds.warning, RATIO_SCALE),
  };
  const b = aggregate(db, base.id);
  const g = aggregate(db, target.id);
  const codes = [...new Set([...b.keys(), ...g.keys()])].sort(compareCodes);
  const rows: IcComparisonRowDto[] = codes.map((code) => {
    const x = b.get(code) ?? { staticCents: 0n, dynamicCents: 0n, name: '' };
    const y = g.get(code) ?? { staticCents: 0n, dynamicCents: 0n, name: '' };
    const dev = y.staticCents - x.staticCents;
    let status: IcComparisonRowDto['status'] = 'compared';
    let rate: bigint | null = rateScaledOf(dev, x.staticCents);
    if (x.staticCents === 0n && y.staticCents !== 0n) status = 'new_item';
    else if (x.staticCents !== 0n && y.staticCents === 0n) { status = 'removed_or_zero'; rate = -1_000_000n; }
    return {
      canonicalCode: code, name: x.name || y.name, level: codeLevel(code),
      baseStatic: centsToDecimalString(x.staticCents), targetStatic: centsToDecimalString(y.staticCents),
      baseDynamic: centsToDecimalString(x.dynamicCents), targetDynamic: centsToDecimalString(y.dynamicCents),
      deviation: centsToDecimalString(dev), deviationRate: rate == null ? null : ratioString(rate, 1_000_000n),
      dynamicDeviation: centsToDecimalString(y.dynamicCents - x.dynamicCents), status, alertLevel: alertLevelOf(rate, t),
    };
  });
  const totalDev = target.static_cents - base.static_cents;
  const totalRate = rateScaledOf(totalDev, base.static_cents);
  const levelCounts: Record<IcLevel, number> = { normal: 0, attention: 0, warning: 0, exceed: 0 };
  for (const r of rows) if (r.alertLevel) levelCounts[r.alertLevel] += 1;
  const { chain, redline } = controlChain(db, project.id);
  const summary: IcComparisonSummaryDto = {
    baseTotalStatic: centsToDecimalString(base.static_cents), targetTotalStatic: centsToDecimalString(target.static_cents),
    baseTotalDynamic: centsToDecimalString(base.dynamic_cents), targetTotalDynamic: centsToDecimalString(target.dynamic_cents),
    totalDeviation: centsToDecimalString(totalDev), totalDeviationRate: totalRate == null ? null : ratioString(totalRate, 1_000_000n),
    totalLevel: alertLevelOf(totalRate, t), levelCounts, exceedCount: levelCounts.exceed,
    newItemCount: rows.filter((r) => r.status === 'new_item').length, removedCount: rows.filter((r) => r.status === 'removed_or_zero').length,
    redlineVersionId: redline?.id ?? null, redlineAmount: redline ? centsToDecimalString(redline.static_cents) : null, controlChain: chain,
  };
  const sha = canonicalHash({ base: base.content_hash, target: target.content_hash, redline: redline?.id ?? null, thresholds, rows, summary });
  const id = db.transaction(() => {
    // 事务内核对版本状态未变
    for (const v of [base, target]) {
      const fresh = db.prepare('SELECT status FROM ic_version WHERE id = ?').get(v.id) as { status: string };
      if (fresh.status !== 'confirmed') throw conflict('IC_VERSION_STATE', `版本“${v.name}”已作废,不能对比`);
    }
    const cid = Number(db.prepare(`INSERT INTO ic_comparison (project_id, base_version_id, target_version_id, base_content_hash, target_content_hash, redline_version_id,
      thresholds_json, rows_json, summary_json, content_sha256, created_by_user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(
      project.id, base.id, target.id, base.content_hash, target.content_hash, redline?.id ?? null, JSON.stringify(thresholds), JSON.stringify(rows),
      JSON.stringify(summary), sha, currentAuth()?.userId ?? null, nowIso(),
    ).lastInsertRowid);
    writeLog(db, 'investment.control.compare', 'ic_comparison', cid, { baseVersionId: base.id, targetVersionId: target.id, exceed: levelCounts.exceed, chain: chain.map((c) => c.status) });
    return cid;
  }).immediate();
  return getIcComparison(db, id);
}

function comparisonDto(db: DB, c: ComparisonRow, withRows: boolean) {
  const v = (id: number) => db.prepare('SELECT version_type, version_no, name, status FROM ic_version WHERE id = ?').get(id) as { version_type: IcVersionType; version_no: number; name: string; status: string };
  const label = (id: number) => { const x = v(id); return { id, versionType: x.version_type, typeLabel: IC_VERSION_TYPE_LABELS[x.version_type], versionNo: x.version_no, name: x.name, status: x.status }; };
  return {
    id: c.id, projectId: c.project_id, base: { ...label(c.base_version_id), contentHash: c.base_content_hash }, target: { ...label(c.target_version_id), contentHash: c.target_content_hash },
    redlineVersionId: c.redline_version_id, thresholds: JSON.parse(c.thresholds_json) as typeof IC_DEFAULT_THRESHOLDS,
    summary: JSON.parse(c.summary_json) as IcComparisonSummaryDto, rows: withRows ? JSON.parse(c.rows_json) as IcComparisonRowDto[] : undefined,
    contentSha256: c.content_sha256, createdAt: c.created_at, createdBy: userName(db, c.created_by_user_id),
  };
}

export function listIcComparisons(db: DB, projectId: number) {
  visibleProject(db, projectId);
  const rows = db.prepare('SELECT * FROM ic_comparison WHERE project_id = ? ORDER BY id DESC LIMIT 200').all(projectId) as ComparisonRow[];
  return { items: rows.map((r) => comparisonDto(db, r, false)) };
}

export function getIcComparison(db: DB, id: number) {
  const c = db.prepare('SELECT * FROM ic_comparison WHERE id = ?').get(id) as ComparisonRow | undefined;
  if (!c) throw notVisible('对比快照');
  visibleProject(db, c.project_id);
  return comparisonDto(db, c, true);
}

const LEVEL_LABEL: Record<IcLevel, string> = { normal: '正常', attention: '关注', warning: '预警', exceed: '超限' };
const STATUS_LABEL: Record<string, string> = { compared: '', new_item: '新增科目', removed_or_zero: '取消或为零' };

/** 金额(元,两位小数字符串)能被 double 精确往返时写数值单元格,否则写文本。 */
function exactNumber(v: string | null): string | number | null {
  if (v == null) return null;
  const n = Number(v);
  return Number.isFinite(n) && n.toFixed(v.includes('.') ? v.split('.')[1].length : 0) === v && Math.abs(n) < 2 ** 53 / 100 ? n : v;
}

export async function exportIcComparison(db: DB, id: number): Promise<{ fileName: string; buffer: Buffer }> {
  const c = getIcComparison(db, id);
  const p = getIcProject(db, c.projectId);
  const wb = new ExcelJS.Workbook();
  const s = wb.addWorksheet('汇总');
  const sum = c.summary;
  s.addRows([
    ['项目', `${p.code} ${p.name}`], ['快照编号', c.id], ['基准版本', `${c.base.typeLabel} 第${c.base.versionNo}稿 ${c.base.name}`],
    ['目标版本', `${c.target.typeLabel} 第${c.target.versionNo}稿 ${c.target.name}`], ['红线金额(元)', exactNumber(sum.redlineAmount)],
    ['基准静态合计(元)', exactNumber(sum.baseTotalStatic)], ['目标静态合计(元)', exactNumber(sum.targetTotalStatic)], ['偏差额(元)', exactNumber(sum.totalDeviation)],
    ['偏差率', exactNumber(sum.totalDeviationRate)], ['总体等级', sum.totalLevel ? LEVEL_LABEL[sum.totalLevel] : ''], ['超限科目数', sum.exceedCount],
    ['阈值', `正常≤${c.thresholds.normal} 关注≤${c.thresholds.attention} 预警≤${c.thresholds.warning}`],
    ['控制链', sum.controlChain.map((x) => x.message).join(';') || '无'], ['快照摘要', c.contentSha256], ['生成时间', c.createdAt], ['生成人', c.createdBy ?? ''],
  ]);
  s.getColumn(1).width = 20; s.getColumn(2).width = 60;
  const d = wb.addWorksheet('对比明细');
  d.addRow(['规范科目编码', '科目名称', '层级', '基准静态(元)', '目标静态(元)', '偏差额(元)', '偏差率', '等级', '状态', '基准动态(元)', '目标动态(元)', '动态偏差(元)']).font = { bold: true };
  for (const r of c.rows!) {
    d.addRow([r.canonicalCode, r.name, r.level, exactNumber(r.baseStatic), exactNumber(r.targetStatic), exactNumber(r.deviation), exactNumber(r.deviationRate),
      r.alertLevel ? LEVEL_LABEL[r.alertLevel] : '', STATUS_LABEL[r.status], exactNumber(r.baseDynamic), exactNumber(r.targetDynamic), exactNumber(r.dynamicDeviation)]);
  }
  d.columns.forEach((col) => { col.width = 16; });
  writeLog(db, 'investment.control.export', 'ic_comparison', id, {});
  return { fileName: `${p.code}-四算对比-${id}.xlsx`, buffer: Buffer.from(await wb.xlsx.writeBuffer()) };
}
