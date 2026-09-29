/**
 * 主数据基础(AC-F07):项目、供应商与跨域编码映射/解析。
 *
 * - 组织/科目沿用继承模块;这里只补项目、供应商与“外部编码 → 规范实体”的映射层。
 * - 停用只改状态;历史事实按 id 引用并保存发生时名称,不因停用/改名重算。
 * - 映射按有效期版本化:变更 = 退役旧行 + 新增行;resolve 支持 asOf 复现历史口径。
 * - 项目归属组织,受组织数据范围约束;供应商无组织属性。
 */
import type { DB } from '../../db/connection';
import { AppError, Errors } from '../../core/errors';
import { currentAuth, type AuthContext } from '../../core/request-context';
import { writeLog } from '../audit/log';
import { assertOrgVisible, orgInScope, resolveOrgScope } from '../security/scope';

export type MasterEntityType = 'org' | 'account' | 'project' | 'supplier';
const ENTITY_TYPES: readonly MasterEntityType[] = ['org', 'account', 'project', 'supplier'];
const nowIso = () => new Date().toISOString();

/** 名称归一化:NFKC、去空白与常见标点、小写(与清洗侧 normalizeSourceText 同源并去标点)。 */
export function normalizeName(value: string): string {
  return value.normalize('NFKC').trim().replace(/\s+/g, '').replace(/[()（）【】[\]{}、，,.;；:：/\\|]+/g, '').toLocaleLowerCase('zh-CN');
}

const ORG_SUFFIXES = ['有限责任公司', '有限公司', '分公司', '水电站', '公司', '部门', '中心', '部'];
/** 去掉组织常见后缀后的紧凑键,仅用于“规范化名称”级别的候选匹配。 */
export function compactOrgName(value: string): string {
  let text = normalizeName(value);
  for (let changed = true; changed;) {
    changed = false;
    for (const suffix of ORG_SUFFIXES) {
      if (text.endsWith(suffix) && text.length > suffix.length) { text = text.slice(0, -suffix.length); changed = true; }
    }
  }
  return text;
}

function text(value: unknown, name: string, max: number, required = true): string {
  if (value === undefined || value === null || value === '') {
    if (required) throw Errors.validation(`${name}不能为空`);
    return '';
  }
  if (typeof value !== 'string') throw Errors.validation(`${name}必须是字符串`);
  const v = value.trim();
  if (required && !v) throw Errors.validation(`${name}不能为空`);
  if (v.length > max) throw Errors.validation(`${name}不能超过 ${max} 个字符`);
  return v;
}

function code(value: unknown, name: string): string {
  const v = text(value, name, 64);
  if (!/^[A-Za-z0-9][A-Za-z0-9_.\-/]*$/.test(v)) throw Errors.validation(`${name}只能包含字母、数字和 _ . - /`);
  return v;
}

function extra(value: unknown): string {
  if (value === undefined || value === null) return '{}';
  if (typeof value !== 'object' || Array.isArray(value)) throw Errors.validation('扩展字段必须是对象');
  const json = JSON.stringify(value);
  if (json.length > 8_000) throw Errors.validation('扩展字段过大');
  return json;
}

function status(value: unknown): 'active' | 'inactive' {
  if (value !== 'active' && value !== 'inactive') throw Errors.validation('状态只能是 active 或 inactive');
  return value;
}

/* ============ 项目 ============ */

interface ProjectRow {
  id: number; code: string; name: string; project_type: string; org_id: number; status: 'active' | 'inactive';
  extra_json: string; created_at: string; updated_at: string;
}

export interface PublicProject {
  id: number; code: string; name: string; projectType: string; orgId: number; orgName: string; status: 'active' | 'inactive';
  extra: Record<string, unknown>; createdAt: string; updatedAt: string;
}

function toProject(db: DB, r: ProjectRow): PublicProject {
  const org = db.prepare('SELECT name FROM org WHERE id = ?').get(r.org_id) as { name: string } | undefined;
  return {
    id: r.id, code: r.code, name: r.name, projectType: r.project_type, orgId: r.org_id, orgName: org?.name ?? '',
    status: r.status, extra: JSON.parse(r.extra_json), createdAt: r.created_at, updatedAt: r.updated_at,
  };
}

function projectRow(db: DB, id: number, auth: AuthContext | undefined): ProjectRow {
  const row = db.prepare('SELECT * FROM md_project WHERE id = ?').get(id) as ProjectRow | undefined;
  if (!row) throw Errors.notFound('项目');
  if (auth) assertOrgVisible(db, auth, row.org_id); // 范围外与不存在同为 404
  return row;
}

export function listProjects(db: DB, q: { status?: string; orgId?: number; keyword?: string } = {}): PublicProject[] {
  const auth = currentAuth();
  const where: string[] = [];
  const params: unknown[] = [];
  const orgScope = auth ? resolveOrgScope(db, auth) : null;
  if (orgScope && !orgScope.all) {
    const scope = [...orgScope.orgIds];
    if (scope.length === 0) return [];
    where.push(`org_id IN (${scope.map(() => '?').join(',')})`);
    params.push(...scope);
  }
  if (q.status) { where.push('status = ?'); params.push(status(q.status)); }
  if (q.orgId) {
    if (auth) assertOrgVisible(db, auth, q.orgId);
    where.push(`org_id IN (WITH RECURSIVE sub(id) AS (SELECT ? UNION ALL SELECT o.id FROM org o JOIN sub ON o.parent_id = sub.id) SELECT id FROM sub)`);
    params.push(q.orgId);
  }
  if (q.keyword) { where.push('(code LIKE ? OR name LIKE ?)'); const k = `%${q.keyword.replace(/[%_]/g, '')}%`; params.push(k, k); }
  const rows = db.prepare(`SELECT * FROM md_project ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY code`).all(...params) as ProjectRow[];
  return rows.map((r) => toProject(db, r));
}

export function getProject(db: DB, id: number): PublicProject {
  return toProject(db, projectRow(db, id, currentAuth()));
}

export function createProject(db: DB, input: Record<string, unknown>): PublicProject {
  const auth = currentAuth();
  const c = code(input.code, '项目编码');
  const name = text(input.name, '项目名称', 200);
  const orgId = Number(input.orgId);
  if (!Number.isSafeInteger(orgId) || orgId <= 0) throw Errors.validation('请选择归属组织');
  if (auth) assertOrgVisible(db, auth, orgId);
  const org = db.prepare('SELECT status FROM org WHERE id = ?').get(orgId) as { status: string } | undefined;
  if (!org) throw Errors.notFound('组织');
  if (org.status !== 'active') throw Errors.validation('归属组织已停用');
  const tx = db.transaction(() => {
    if (db.prepare('SELECT 1 FROM md_project WHERE code = ?').get(c)) throw new AppError('CODE_TAKEN', `项目编码 ${c} 已存在`, 409);
    const now = nowIso();
    const id = Number(db.prepare('INSERT INTO md_project (code, name, project_type, org_id, status, extra_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)')
      .run(c, name, text(input.projectType, '项目类型', 64, false), orgId, 'active', extra(input.extra), now, now).lastInsertRowid);
    writeLog(db, 'master.project.create', 'md_project', id, { code: c, name, orgId });
    return id;
  });
  return getProject(db, tx());
}

/** 编码不可改(历史引用与外部映射依赖编码);改名/改类型/停用/转移组织均留审计。 */
export function updateProject(db: DB, id: number, input: Record<string, unknown>): PublicProject {
  const auth = currentAuth();
  const tx = db.transaction(() => {
    const row = projectRow(db, id, auth);
    if (input.code !== undefined && input.code !== row.code) throw Errors.validation('项目编码不可修改;如需更换请新建项目并建立映射');
    const changes: Record<string, unknown> = {};
    const next = { ...row };
    if (input.name !== undefined) { next.name = text(input.name, '项目名称', 200); changes.name = [row.name, next.name]; }
    if (input.projectType !== undefined) { next.project_type = text(input.projectType, '项目类型', 64, false); changes.projectType = next.project_type; }
    if (input.status !== undefined) { next.status = status(input.status); changes.status = next.status; }
    if (input.extra !== undefined) { next.extra_json = extra(input.extra); changes.extra = true; }
    if (input.orgId !== undefined) {
      const orgId = Number(input.orgId);
      if (!Number.isSafeInteger(orgId) || orgId <= 0) throw Errors.validation('归属组织不合法');
      if (auth) assertOrgVisible(db, auth, orgId);
      if (!db.prepare("SELECT 1 FROM org WHERE id = ? AND status = 'active'").get(orgId)) throw Errors.validation('归属组织不存在或已停用');
      next.org_id = orgId;
      changes.orgId = [row.org_id, orgId];
    }
    db.prepare('UPDATE md_project SET name = ?, project_type = ?, org_id = ?, status = ?, extra_json = ?, updated_at = ? WHERE id = ?')
      .run(next.name, next.project_type, next.org_id, next.status, next.extra_json, nowIso(), id);
    writeLog(db, next.status !== row.status ? `master.project.${next.status === 'inactive' ? 'deactivate' : 'activate'}` : 'master.project.update', 'md_project', id, changes);
  });
  tx();
  return getProject(db, id);
}

/* ============ 供应商 ============ */

interface SupplierRow {
  id: number; code: string | null; name: string; normalized_name: string; supplier_type: string; credit_code: string;
  status: 'active' | 'inactive'; extra_json: string; created_at: string; updated_at: string;
}

export interface PublicSupplier {
  id: number; code: string | null; name: string; supplierType: string; creditCode: string; status: 'active' | 'inactive';
  extra: Record<string, unknown>; createdAt: string; updatedAt: string;
}

const toSupplier = (r: SupplierRow): PublicSupplier => ({
  id: r.id, code: r.code, name: r.name, supplierType: r.supplier_type, creditCode: r.credit_code, status: r.status,
  extra: JSON.parse(r.extra_json), createdAt: r.created_at, updatedAt: r.updated_at,
});

function creditCode(value: unknown): string {
  const v = text(value, '统一社会信用代码', 18, false).toUpperCase();
  if (v && !/^[0-9A-HJ-NPQRTUWXY]{18}$/.test(v)) throw Errors.validation('统一社会信用代码格式不正确');
  return v;
}

export function listSuppliers(db: DB, q: { status?: string; keyword?: string } = {}): PublicSupplier[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.status) { where.push('status = ?'); params.push(status(q.status)); }
  if (q.keyword) { where.push('(code LIKE ? OR name LIKE ? OR normalized_name LIKE ?)'); const k = `%${q.keyword.replace(/[%_]/g, '')}%`; params.push(k, k, `%${normalizeName(q.keyword)}%`); }
  return (db.prepare(`SELECT * FROM md_supplier ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY name`).all(...params) as SupplierRow[]).map(toSupplier);
}

export function getSupplier(db: DB, id: number): PublicSupplier {
  const row = db.prepare('SELECT * FROM md_supplier WHERE id = ?').get(id) as SupplierRow | undefined;
  if (!row) throw Errors.notFound('供应商');
  return toSupplier(row);
}

export function createSupplier(db: DB, input: Record<string, unknown>): PublicSupplier {
  const name = text(input.name, '供应商名称', 200);
  const normalized = normalizeName(name);
  const c = input.code === undefined || input.code === null || input.code === '' ? null : code(input.code, '供应商编码');
  const tx = db.transaction(() => {
    const dup = db.prepare('SELECT id, name FROM md_supplier WHERE normalized_name = ? OR (code IS NOT NULL AND code = ?)').get(normalized, c) as { id: number; name: string } | undefined;
    if (dup) throw new AppError('DUPLICATE_SUPPLIER', `供应商已存在:${dup.name}(id=${dup.id})`, 409);
    const now = nowIso();
    const id = Number(db.prepare(`INSERT INTO md_supplier (code, name, normalized_name, supplier_type, credit_code, status, extra_json, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'active', ?, ?, ?)`).run(c, name, normalized, text(input.supplierType, '供应商类型', 64, false), creditCode(input.creditCode), extra(input.extra), now, now).lastInsertRowid);
    writeLog(db, 'master.supplier.create', 'md_supplier', id, { code: c, name });
    return id;
  });
  return getSupplier(db, tx());
}

export function updateSupplier(db: DB, id: number, input: Record<string, unknown>): PublicSupplier {
  const tx = db.transaction(() => {
    const row = db.prepare('SELECT * FROM md_supplier WHERE id = ?').get(id) as SupplierRow | undefined;
    if (!row) throw Errors.notFound('供应商');
    if (input.code !== undefined && (input.code || null) !== row.code) {
      if (row.code) throw Errors.validation('供应商编码不可修改');
    }
    const next = { ...row };
    const changes: Record<string, unknown> = {};
    if (input.code !== undefined && !row.code && input.code) { next.code = code(input.code, '供应商编码'); changes.code = next.code; }
    if (input.name !== undefined) {
      next.name = text(input.name, '供应商名称', 200);
      next.normalized_name = normalizeName(next.name);
      const dup = db.prepare('SELECT id FROM md_supplier WHERE normalized_name = ? AND id != ?').get(next.normalized_name, id);
      if (dup) throw new AppError('DUPLICATE_SUPPLIER', '改名后与已有供应商重名', 409);
      changes.name = [row.name, next.name];
    }
    if (input.supplierType !== undefined) { next.supplier_type = text(input.supplierType, '供应商类型', 64, false); changes.supplierType = next.supplier_type; }
    if (input.creditCode !== undefined) { next.credit_code = creditCode(input.creditCode); changes.creditCode = true; }
    if (input.status !== undefined) { next.status = status(input.status); changes.status = next.status; }
    if (input.extra !== undefined) { next.extra_json = extra(input.extra); changes.extra = true; }
    db.prepare(`UPDATE md_supplier SET code = ?, name = ?, normalized_name = ?, supplier_type = ?, credit_code = ?, status = ?, extra_json = ?, updated_at = ? WHERE id = ?`)
      .run(next.code, next.name, next.normalized_name, next.supplier_type, next.credit_code, next.status, next.extra_json, nowIso(), id);
    writeLog(db, next.status !== row.status ? `master.supplier.${next.status === 'inactive' ? 'deactivate' : 'activate'}` : 'master.supplier.update', 'md_supplier', id, changes);
  });
  tx();
  return getSupplier(db, id);
}

/* ============ 跨域编码映射 ============ */

interface MappingRow {
  id: number; source_system: string; entity_type: MasterEntityType; match_kind: 'code' | 'name'; source_key: string; source_label: string;
  target_id: number; valid_from: string; valid_to: string | null; note: string; created_by: number | null; created_at: string;
  retired_at: string | null; retired_by: number | null;
}

export interface PublicMapping {
  id: number; sourceSystem: string; entityType: MasterEntityType; matchKind: 'code' | 'name'; sourceKey: string; sourceLabel: string;
  targetId: number; targetCode: string; targetName: string; validFrom: string; validTo: string | null; note: string; active: boolean;
}

const TABLE_OF: Record<MasterEntityType, string> = { org: 'org', account: 'account', project: 'md_project', supplier: 'md_supplier' };

function entityType(value: unknown): MasterEntityType {
  if (typeof value !== 'string' || !ENTITY_TYPES.includes(value as MasterEntityType)) throw Errors.validation('实体类型只能是 org/account/project/supplier');
  return value as MasterEntityType;
}

function targetOf(db: DB, type: MasterEntityType, id: number): { id: number; code: string; name: string; status: string; orgId: number | null } | undefined {
  const table = TABLE_OF[type];
  const orgCol = type === 'org' ? 'id' : type === 'project' ? 'org_id' : 'NULL';
  return db.prepare(`SELECT id, COALESCE(code, '') AS code, name, status, ${orgCol} AS orgId FROM ${table} WHERE id = ?`).get(id) as ReturnType<typeof targetOf>;
}

function toMapping(db: DB, r: MappingRow): PublicMapping {
  const t = targetOf(db, r.entity_type, r.target_id);
  return {
    id: r.id, sourceSystem: r.source_system, entityType: r.entity_type, matchKind: r.match_kind, sourceKey: r.source_key, sourceLabel: r.source_label,
    targetId: r.target_id, targetCode: t?.code ?? '', targetName: t?.name ?? '', validFrom: r.valid_from, validTo: r.valid_to, note: r.note, active: r.valid_to === null,
  };
}

function sourceKeyOf(kind: 'code' | 'name', raw: string): string {
  return kind === 'name' ? normalizeName(raw) : raw.trim();
}

export function listMappings(db: DB, q: { sourceSystem?: string; entityType?: string; includeRetired?: boolean } = {}): PublicMapping[] {
  const where: string[] = [];
  const params: unknown[] = [];
  if (q.sourceSystem) { where.push('source_system = ?'); params.push(q.sourceSystem); }
  if (q.entityType) { where.push('entity_type = ?'); params.push(entityType(q.entityType)); }
  if (!q.includeRetired) where.push('valid_to IS NULL');
  const rows = db.prepare(`SELECT * FROM md_code_mapping ${where.length ? `WHERE ${where.join(' AND ')}` : ''} ORDER BY entity_type, source_system, source_key, id`).all(...params) as MappingRow[];
  return rows.map((r) => toMapping(db, r));
}

/**
 * 建立映射:同一 (来源系统, 实体, 匹配方式, 键) 已有生效映射时,退役旧行并新增(不原地改目标)。
 * validFrom 缺省为当前时间;退役旧行的 valid_to = 新行 valid_from,保证区间不重叠。
 */
export function upsertMapping(db: DB, input: Record<string, unknown>): PublicMapping {
  const auth = currentAuth();
  const sourceSystem = text(input.sourceSystem, '来源系统', 32);
  if (!/^[a-z][a-z0-9_]*$/.test(sourceSystem)) throw Errors.validation('来源系统标识只能是小写字母、数字、下划线');
  const type = entityType(input.entityType);
  const kind = input.matchKind === 'name' ? 'name' : input.matchKind === undefined || input.matchKind === 'code' ? 'code' : null;
  if (!kind) throw Errors.validation('匹配方式只能是 code 或 name');
  const rawKey = text(input.sourceKey, '来源键', 200);
  const key = sourceKeyOf(kind, rawKey);
  const targetId = Number(input.targetId);
  if (!Number.isSafeInteger(targetId) || targetId <= 0) throw Errors.validation('请选择映射目标');
  const validFrom = input.validFrom === undefined ? nowIso() : text(input.validFrom, '生效时间', 40);
  if (Number.isNaN(Date.parse(validFrom))) throw Errors.validation('生效时间格式不正确');
  const tx = db.transaction(() => {
    const target = targetOf(db, type, targetId);
    if (!target) throw Errors.notFound('映射目标');
    if (target.status !== 'active') throw Errors.validation('映射目标已停用');
    if (auth && target.orgId !== null) assertOrgVisible(db, auth, target.orgId);
    const current = db.prepare('SELECT * FROM md_code_mapping WHERE source_system = ? AND entity_type = ? AND match_kind = ? AND source_key = ? AND valid_to IS NULL')
      .get(sourceSystem, type, kind, key) as MappingRow | undefined;
    if (current) {
      if (current.target_id === targetId) return current.id; // 幂等:目标未变
      if (validFrom <= current.valid_from) throw Errors.validation('新映射的生效时间必须晚于当前映射');
      db.prepare('UPDATE md_code_mapping SET valid_to = ?, retired_at = ?, retired_by = ? WHERE id = ?').run(validFrom, nowIso(), auth?.userId ?? null, current.id);
    }
    const id = Number(db.prepare(`INSERT INTO md_code_mapping (source_system, entity_type, match_kind, source_key, source_label, target_id, valid_from, note, created_by, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(sourceSystem, type, kind, key, rawKey, targetId, validFrom, text(input.note, '备注', 500, false), auth?.userId ?? null, nowIso()).lastInsertRowid);
    writeLog(db, current ? 'master.mapping.replace' : 'master.mapping.create', 'md_code_mapping', id, { sourceSystem, entityType: type, matchKind: kind, sourceKey: rawKey, targetId, replaced: current?.id });
    return id;
  });
  const id = tx();
  return toMapping(db, db.prepare('SELECT * FROM md_code_mapping WHERE id = ?').get(id) as MappingRow);
}

/** 退役映射:保留历史行(按 asOf 仍可解析到当时目标)。 */
export function retireMapping(db: DB, id: number): PublicMapping {
  const auth = currentAuth();
  const tx = db.transaction(() => {
    const row = db.prepare('SELECT * FROM md_code_mapping WHERE id = ?').get(id) as MappingRow | undefined;
    if (!row) throw Errors.notFound('映射');
    if (row.valid_to !== null) throw new AppError('MAPPING_RETIRED', '映射已退役', 409);
    const now = nowIso();
    db.prepare('UPDATE md_code_mapping SET valid_to = ?, retired_at = ?, retired_by = ? WHERE id = ?').run(now, now, auth?.userId ?? null, id);
    writeLog(db, 'master.mapping.retire', 'md_code_mapping', id, {});
  });
  tx();
  return toMapping(db, db.prepare('SELECT * FROM md_code_mapping WHERE id = ?').get(id) as MappingRow);
}

/* ============ 解析 ============ */

export type MatchedBy = 'exact_code' | 'mapping_code' | 'exact_name' | 'mapping_name' | 'normalized_name' | 'ambiguous' | 'unmatched';

export interface ResolveResult {
  input: { code?: string; name?: string };
  matchedBy: MatchedBy;
  targetId: number | null;
  targetCode: string | null;
  targetName: string | null;
  /** 规则匹配置信度(0～1 字符串),不是模型概率 */
  confidence: string;
  candidates: { id: number; code: string; name: string }[];
  mappingId?: number;
}

/**
 * 外部编码/名称 → 规范实体。顺序:精确编码 → 编码映射 → 精确名称 → 名称映射 → 规范化名称(仅组织去后缀)。
 * 只匹配启用实体;多个候选时返回 ambiguous 与候选,不擅自选择。asOf 用于复现历史口径(仅影响映射层)。
 */
export function resolveEntity(db: DB, type: MasterEntityType, input: { code?: string; name?: string; sourceSystem?: string; asOf?: string }): ResolveResult {
  const table = TABLE_OF[type];
  const base = { input: { code: input.code, name: input.name } };
  const hit = (matchedBy: MatchedBy, row: { id: number; code: string; name: string }, confidence: string, mappingId?: number): ResolveResult =>
    ({ ...base, matchedBy, targetId: row.id, targetCode: row.code, targetName: row.name, confidence, candidates: [], ...(mappingId ? { mappingId } : {}) });
  const active = db.prepare(`SELECT id, COALESCE(code, '') AS code, name FROM ${table} WHERE status = 'active'`).all() as { id: number; code: string; name: string }[];
  const byId = new Map(active.map((r) => [r.id, r]));
  const asOf = input.asOf ?? nowIso();
  const mapped = (kind: 'code' | 'name', key: string) => {
    const params: unknown[] = [type, kind, key, asOf, asOf];
    let sql = 'SELECT id, target_id FROM md_code_mapping WHERE entity_type = ? AND match_kind = ? AND source_key = ? AND valid_from <= ? AND (valid_to IS NULL OR valid_to > ?)';
    if (input.sourceSystem) { sql += ' AND source_system = ?'; params.push(input.sourceSystem); }
    return db.prepare(`${sql} ORDER BY valid_from DESC, id DESC`).all(...params) as { id: number; target_id: number }[];
  };

  const c = input.code?.trim();
  if (c) {
    const exact = active.filter((r) => r.code === c);
    if (exact.length === 1) return hit('exact_code', exact[0], '1');
    const m = mapped('code', c).filter((r) => byId.has(r.target_id));
    const targets = [...new Set(m.map((r) => r.target_id))];
    if (targets.length === 1) return hit('mapping_code', byId.get(targets[0])!, '1', m[0].id);
    if (targets.length > 1) return { ...base, matchedBy: 'ambiguous', targetId: null, targetCode: null, targetName: null, confidence: '0', candidates: targets.map((id) => byId.get(id)!) };
  }
  const n = input.name?.trim();
  if (n) {
    const key = normalizeName(n);
    const exact = active.filter((r) => normalizeName(r.name) === key);
    if (exact.length === 1) return hit('exact_name', exact[0], '1');
    if (exact.length > 1) return { ...base, matchedBy: 'ambiguous', targetId: null, targetCode: null, targetName: null, confidence: '0', candidates: exact };
    const m = mapped('name', key).filter((r) => byId.has(r.target_id));
    const targets = [...new Set(m.map((r) => r.target_id))];
    if (targets.length === 1) return hit('mapping_name', byId.get(targets[0])!, '0.9', m[0].id);
    if (type === 'org') {
      const compact = compactOrgName(n);
      const loose = compact ? active.filter((r) => compactOrgName(r.name) === compact) : [];
      if (loose.length === 1) return hit('normalized_name', loose[0], '0.86');
      if (loose.length > 1) return { ...base, matchedBy: 'ambiguous', targetId: null, targetCode: null, targetName: null, confidence: '0', candidates: loose };
    }
  }
  return { ...base, matchedBy: 'unmatched', targetId: null, targetCode: null, targetName: null, confidence: '0', candidates: [] };
}

/** 批量解析预览(导入前核对);对受限用户,范围外的组织/项目结果按未匹配返回,不泄露存在。 */
export function resolvePreview(db: DB, type: MasterEntityType, items: { code?: string; name?: string }[], opts: { sourceSystem?: string; asOf?: string } = {}): ResolveResult[] {
  if (!Array.isArray(items) || items.length === 0) throw Errors.validation('请提供待解析条目');
  if (items.length > 500) throw Errors.validation('单次最多解析 500 条');
  const auth = currentAuth();
  const scope = auth ? resolveOrgScope(db, auth) : null;
  return items.map((item) => {
    const result = resolveEntity(db, type, { ...item, ...opts });
    if (!scope || scope.all || result.targetId === null || (type !== 'org' && type !== 'project')) return result;
    const orgId = type === 'org' ? result.targetId : (db.prepare('SELECT org_id FROM md_project WHERE id = ?').get(result.targetId) as { org_id: number }).org_id;
    return orgInScope(scope, orgId) ? result : { ...result, matchedBy: 'unmatched' as const, targetId: null, targetCode: null, targetName: null, confidence: '0', candidates: [], mappingId: undefined };
  });
}
