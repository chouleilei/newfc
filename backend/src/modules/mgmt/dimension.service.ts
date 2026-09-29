/**
 * 管理会计维度(AC-F14):维度 + 成员。成员引用主数据(组织/项目/科目)或自定义编码。
 * 成员映射先预览后确认:确认时按同一输入重算预览哈希,不一致或存在错误即拒绝;
 * 引用对象必须存在、启用且在当前用户的组织范围内(科目与自定义成员不带组织)。
 */
import crypto from 'crypto';
import type { DB } from '../../db/connection';
import { AppError, Errors } from '../../core/errors';
import { writeLog } from '../audit/log';
import { notVisible, orgInScope } from '../security/scope';
import type {
  MaDimensionDto, MaMemberConfirmRequest, MaMemberDto, MaMemberPreviewDto, MaMemberPreviewRequest, MaMemberPreviewRowDto, MaMemberType,
} from '../../contracts/mgmt';
import { assertVersion, conflict, currentUserId, nowIso, scope } from './common';

interface DimensionRow { id: number; code: string; name: string; member_type: MaMemberType; status: 'active' | 'inactive'; version: number; created_at: string; updated_at: string }
interface MemberRow { id: number; dimension_id: number; code: string; name: string; ref_type: MaMemberType; ref_id: number | null; org_id: number | null; status: 'active' | 'inactive'; created_at: string }

function dimensionDto(db: DB, r: DimensionRow): MaDimensionDto {
  const count = (db.prepare("SELECT COUNT(*) AS n FROM ma_dimension_member WHERE dimension_id = ? AND status = 'active'").get(r.id) as { n: number }).n;
  return { id: r.id, code: r.code, name: r.name, memberType: r.member_type, status: r.status, version: r.version, memberCount: count, createdAt: r.created_at, updatedAt: r.updated_at };
}

function refCodeOf(db: DB, type: MaMemberType, refId: number | null): string | null {
  if (refId === null) return null;
  const table = type === 'org' ? 'org' : type === 'project' ? 'md_project' : type === 'account' ? 'account' : null;
  if (!table) return null;
  return (db.prepare(`SELECT code FROM ${table} WHERE id = ?`).get(refId) as { code: string } | undefined)?.code ?? null;
}

function memberDto(db: DB, r: MemberRow): MaMemberDto {
  return {
    id: r.id, dimensionId: r.dimension_id, code: r.code, name: r.name, refType: r.ref_type, refId: r.ref_id, refCode: refCodeOf(db, r.ref_type, r.ref_id),
    orgId: r.org_id, status: r.status, createdAt: r.created_at,
  };
}

function getDimensionRow(db: DB, id: number): DimensionRow {
  const row = db.prepare('SELECT * FROM ma_dimension WHERE id = ?').get(id) as DimensionRow | undefined;
  if (!row) throw notVisible('维度');
  return row;
}

export function listDimensions(db: DB): MaDimensionDto[] {
  return (db.prepare('SELECT * FROM ma_dimension ORDER BY code').all() as DimensionRow[]).map((r) => dimensionDto(db, r));
}

export function getDimension(db: DB, id: number): MaDimensionDto & { members: MaMemberDto[] } {
  const row = getDimensionRow(db, id);
  const s = scope(db);
  const members = (db.prepare('SELECT * FROM ma_dimension_member WHERE dimension_id = ? ORDER BY code').all(id) as MemberRow[])
    .filter((m) => m.org_id === null || orgInScope(s, m.org_id));
  return { ...dimensionDto(db, row), members: members.map((m) => memberDto(db, m)) };
}

export function createDimension(db: DB, input: { code: string; name: string; memberType: MaMemberType }): MaDimensionDto {
  if (db.prepare('SELECT 1 FROM ma_dimension WHERE code = ?').get(input.code)) throw Errors.conflict(`维度编码 ${input.code} 已存在`);
  const now = nowIso();
  const id = db.transaction(() => {
    const info = db.prepare('INSERT INTO ma_dimension (code, name, member_type, created_by_user_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
      .run(input.code, input.name, input.memberType, currentUserId(), now, now);
    const newId = Number(info.lastInsertRowid);
    writeLog(db, 'mgmt.dimension.create', 'ma_dimension', newId, input);
    return newId;
  }).immediate();
  return dimensionDto(db, getDimensionRow(db, id));
}

export function updateDimension(db: DB, id: number, input: { expectedVersion: number; name?: string; status?: 'active' | 'inactive' }): MaDimensionDto {
  db.transaction(() => {
    const row = getDimensionRow(db, id);
    assertVersion(row.version, input.expectedVersion, '维度');
    db.prepare('UPDATE ma_dimension SET name = ?, status = ?, version = version + 1, updated_at = ? WHERE id = ?')
      .run(input.name ?? row.name, input.status ?? row.status, nowIso(), id);
    writeLog(db, 'mgmt.dimension.update', 'ma_dimension', id, { name: input.name, status: input.status });
  }).immediate();
  return dimensionDto(db, getDimensionRow(db, id));
}

interface ResolvedRef { refId: number | null; refName: string | null; orgId: number | null; error: string | null }

function resolveRef(db: DB, type: MaMemberType, refCode: string | undefined): ResolvedRef {
  if (type === 'custom') return { refId: null, refName: null, orgId: null, error: refCode ? '自定义维度成员不引用主数据,请不要填写引用编码' : null };
  if (!refCode) return { refId: null, refName: null, orgId: null, error: '缺少引用编码' };
  const s = scope(db);
  if (type === 'org') {
    const r = db.prepare("SELECT id, name FROM org WHERE code = ? AND status = 'active'").get(refCode) as { id: number; name: string } | undefined;
    if (!r || !orgInScope(s, r.id)) return { refId: null, refName: null, orgId: null, error: `组织 ${refCode} 不存在、已停用或不在授权范围内` };
    return { refId: r.id, refName: r.name, orgId: r.id, error: null };
  }
  if (type === 'project') {
    const r = db.prepare("SELECT id, name, org_id FROM md_project WHERE code = ? AND status = 'active'").get(refCode) as { id: number; name: string; org_id: number } | undefined;
    if (!r || !orgInScope(s, r.org_id)) return { refId: null, refName: null, orgId: null, error: `项目 ${refCode} 不存在、已停用或不在授权范围内` };
    return { refId: r.id, refName: r.name, orgId: r.org_id, error: null };
  }
  const r = db.prepare("SELECT id, name FROM account WHERE code = ? AND status = 'active'").get(refCode) as { id: number; name: string } | undefined;
  if (!r) return { refId: null, refName: null, orgId: null, error: `科目 ${refCode} 不存在或已停用` };
  return { refId: r.id, refName: r.name, orgId: null, error: null };
}

function buildPreview(db: DB, dim: DimensionRow, input: MaMemberPreviewRequest): MaMemberPreviewDto {
  const existing = new Map((db.prepare('SELECT * FROM ma_dimension_member WHERE dimension_id = ?').all(dim.id) as MemberRow[]).map((m) => [m.code, m]));
  const seen = new Set<string>();
  const rows: MaMemberPreviewRowDto[] = input.members.map((m, i) => {
    const ref = resolveRef(db, dim.member_type, m.refCode);
    const name = m.name ?? ref.refName ?? m.code;
    const base = { row: i + 1, code: m.code, name, refCode: m.refCode ?? null, refId: ref.refId, refName: ref.refName, orgId: ref.orgId };
    if (seen.has(m.code)) return { ...base, action: 'error', message: `成员编码 ${m.code} 在本次提交中重复` };
    seen.add(m.code);
    if (ref.error) return { ...base, action: 'error', message: ref.error };
    const old = existing.get(m.code);
    if (old) {
      if (old.ref_id !== ref.refId) return { ...base, action: 'error', message: `成员 ${m.code} 已映射到其他对象;如需改映射请先停用该维度并新建` };
      return { ...base, action: 'unchanged', message: null };
    }
    return { ...base, action: 'create', message: null };
  });
  const canonical = JSON.stringify({ dimensionId: dim.id, version: dim.version, rows: rows.map((r) => [r.code, r.name, r.refId, r.orgId, r.action]) });
  const count = (a: MaMemberPreviewRowDto['action']) => rows.filter((r) => r.action === a).length;
  return {
    valid: count('error') === 0, previewHash: crypto.createHash('sha256').update(canonical).digest('hex'), rows,
    createCount: count('create'), unchangedCount: count('unchanged'), errorCount: count('error'),
  };
}

export function previewMembers(db: DB, dimensionId: number, input: MaMemberPreviewRequest): MaMemberPreviewDto {
  const dim = getDimensionRow(db, dimensionId);
  if (dim.status !== 'active') throw Errors.conflict('维度已停用');
  return buildPreview(db, dim, input);
}

export function confirmMembers(db: DB, dimensionId: number, input: MaMemberConfirmRequest): { created: number; unchanged: number; members: MaMemberDto[] } {
  const result = db.transaction(() => {
    const dim = getDimensionRow(db, dimensionId);
    if (dim.status !== 'active') throw Errors.conflict('维度已停用');
    const preview = buildPreview(db, dim, input);
    if (!preview.valid) throw new AppError('VALIDATION_FAILED', '成员映射存在错误,不能确认', 400, preview.rows.filter((r) => r.action === 'error').map((r) => ({ row: r.row, field: 'code', message: r.message ?? '' })));
    if (preview.previewHash !== input.previewHash) throw conflict('PREVIEW_STALE', '预览后映射结果已变化,请重新预览后确认');
    const now = nowIso();
    const insert = db.prepare(`INSERT INTO ma_dimension_member (dimension_id, code, name, ref_type, ref_id, org_id, created_by_user_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)`);
    for (const r of preview.rows) {
      if (r.action === 'create') insert.run(dim.id, r.code, r.name, dim.member_type, r.refId, r.orgId, currentUserId(), now);
    }
    db.prepare('UPDATE ma_dimension SET version = version + 1, updated_at = ? WHERE id = ?').run(now, dim.id);
    writeLog(db, 'mgmt.dimension.members', 'ma_dimension', dim.id, { created: preview.createCount, unchanged: preview.unchangedCount, codes: preview.rows.map((r) => r.code) });
    return { created: preview.createCount, unchanged: preview.unchangedCount };
  }).immediate();
  return { ...result, members: getDimension(db, dimensionId).members };
}

/** 维度成员(组织型)→ 组织 ID,供多维分析分组。 */
export function orgMembersOf(db: DB, dimensionId: number): { code: string; name: string; orgId: number }[] {
  const dim = getDimensionRow(db, dimensionId);
  if (dim.member_type !== 'org') throw Errors.validation('只有组织型维度可以按快照分组(快照按组织计算)');
  const s = scope(db);
  return (db.prepare("SELECT code, name, org_id AS orgId FROM ma_dimension_member WHERE dimension_id = ? AND status = 'active' AND org_id IS NOT NULL ORDER BY code").all(dimensionId) as { code: string; name: string; orgId: number }[])
    .filter((m) => orgInScope(s, m.orgId));
}
