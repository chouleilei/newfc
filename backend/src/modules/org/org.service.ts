import { z } from 'zod';
import { validateInput, positiveId, sortOrder, nodeStatus } from '../../core/input';
import type { DB } from '../../db/connection';
import type { OrgKind, TreeNodeDto, TreeNodeRow } from '../../core/tree';
import { ORG_KINDS, buildTree, computeLeafIds, isDescendantOf } from '../../core/tree';
import { AppError, Errors } from '../../core/errors';
import { writeLog } from '../audit/log';

const orgExtraSchema = {
  orgKind: z.enum(ORG_KINDS).optional(),
  creditCode: z.string().max(32).optional(),
  planIssuanceRootId: positiveId.nullable().optional(),
  isPlanExcluded: z.boolean().optional(),
  contractPrefixCode: z.string().max(32).optional(),
  isDirectStation: z.boolean().optional(),
  reportFullName: z.string().max(255).optional(),
};

export const createOrgSchema = z.object({
  parentId: positiveId.nullable(),
  code: z.string().min(1).max(128),
  name: z.string().min(1).max(255),
  sortOrder: sortOrder.optional(),
  status: nodeStatus.optional(),
  ...orgExtraSchema,
}).strict();

export const updateOrgSchema = z.object({
  name: z.string().min(1).max(255).optional(),
  sortOrder: sortOrder.optional(),
  ...orgExtraSchema,
}).strict();

export const moveInputSchema = z.object({ parentId: positiveId.nullable() }).strict();
export const statusInputSchema = z.object({ status: nodeStatus }).strict();

const SELECT = `SELECT id, parent_id, code, name, sort_order, status,
  org_kind, credit_code, plan_issuance_root_id, is_plan_excluded, contract_prefix_code, is_direct_station, report_full_name,
  created_at, updated_at FROM org`;

export interface OrgRow extends TreeNodeRow {
  org_kind: OrgKind;
  credit_code: string;
  plan_issuance_root_id: number | null;
  is_plan_excluded: number;
  contract_prefix_code: string;
  is_direct_station: number;
  report_full_name: string;
  created_at: string;
  updated_at: string;
}

export interface OrgResponseDto extends OrgRow {
  parentId: number | null;
  sortOrder: number;
  orgKind: OrgKind;
  creditCode: string;
  planIssuanceRootId: number | null;
  isPlanExcluded: boolean;
  contractPrefixCode: string;
  isDirectStation: boolean;
  reportFullName: string;
}

export interface ExternalBlockedPatterns {
  prefixes: string[];
  names: string[];
}

export function toOrgResponse(row: OrgRow): OrgResponseDto {
  return {
    ...row,
    parentId: row.parent_id,
    sortOrder: row.sort_order,
    orgKind: row.org_kind,
    creditCode: row.credit_code,
    planIssuanceRootId: row.plan_issuance_root_id,
    isPlanExcluded: row.is_plan_excluded === 1,
    contractPrefixCode: row.contract_prefix_code,
    isDirectStation: row.is_direct_station === 1,
    reportFullName: row.report_full_name,
  };
}

function tableExists(db: DB, name: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name));
}

/**
 * 从配置表动态读取禁止录入组织树的外部合作方/非并表主体特征（公开源码零硬编码真实机构名）。
 * 来源：
 * 1) ct_prefix_org_map WHERE entity_status = 'external'（提取 raw_prefix 及括号/冒号标注的外部简称）
 * 2) md_dict_item WHERE dict_type = 'org_external_blocklist' AND status = 'active'（item_value 为前缀/编码，item_label 为禁止名称关键词）
 */
export function listExternalBlockedPatterns(db: DB): ExternalBlockedPatterns {
  const prefixes = new Set<string>();
  const names = new Set<string>();
  if (tableExists(db, 'ct_prefix_org_map')) {
    const rows = db.prepare("SELECT raw_prefix, note FROM ct_prefix_org_map WHERE entity_status = 'external'").all() as {
      raw_prefix: string;
      note: string;
    }[];
    for (const r of rows) {
      for (const seg of r.raw_prefix.split(/[\/,;，；]/)) {
        const p = seg.trim().toUpperCase();
        if (p && /^[A-Z0-9_-]{2,24}$/.test(p) && p !== 'EXT') prefixes.add(p);
      }
      // 若备注显式登记「外部主体:XXX」或「外部排除:XXX」，提取受控简称用于拦截
      const explicit = r.note.match(/外部(?:排除|禁止录入|隔离主体)[:：]\s*([^;；,，()（）]+)/g) ?? [];
      for (const m of explicit) {
        const label = m.replace(/^外部(?:排除|禁止录入|隔离主体)[:：]\s*/, '').trim();
        if (label.length >= 2) names.add(label);
      }
    }
  }
  if (tableExists(db, 'md_dict_item')) {
    const items = db.prepare(
      "SELECT item_value, item_label FROM md_dict_item WHERE dict_type = 'org_external_blocklist' AND status = 'active'"
    ).all() as { item_value: string; item_label: string }[];
    for (const it of items) {
      const p = it.item_value.trim().toUpperCase();
      if (p && p !== '-') prefixes.add(p);
      const n = it.item_label.trim();
      if (n.length >= 2) names.add(n);
    }
  }
  return { prefixes: [...prefixes].sort(), names: [...names].sort() };
}

export function findExternalBlockMatch(
  patterns: ExternalBlockedPatterns,
  candidate: { code?: string; name?: string; contractPrefixCode?: string },
  existingOrgCodes?: ReadonlySet<string>
): string | null {
  const codeUpper = (candidate.code ?? '').trim().toUpperCase();
  const prefixUpper = (candidate.contractPrefixCode ?? '').trim().toUpperCase();
  const nameNorm = (candidate.name ?? '').normalize('NFKC').trim();
  for (const p of patterns.prefixes) {
    if (existingOrgCodes?.has(p)) continue;
    if (codeUpper && codeUpper === p) return `编码 ${codeUpper} 命中外部相对方前缀 ${p}`;
    if (prefixUpper && prefixUpper === p) return `合同前缀 ${prefixUpper} 命中外部相对方前缀 ${p}`;
  }
  for (const blockedName of patterns.names) {
    if (nameNorm && (nameNorm === blockedName || nameNorm.includes(blockedName))) {
      return `名称“${nameNorm}”命中外部非并表主体清单（${blockedName}）`;
    }
  }
  return null;
}

function assertNotBlockedExternalOrg(
  db: DB,
  candidate: { code?: string; name?: string; contractPrefixCode?: string }
): void {
  const existingCodes = new Set(
    (db.prepare('SELECT UPPER(code) AS c FROM org').all() as { c: string }[]).map((r) => r.c)
  );
  const reason = findExternalBlockMatch(listExternalBlockedPatterns(db), candidate, existingCodes);
  if (reason) {
    throw new AppError(
      'EXTERNAL_ENTITY_FORBIDDEN',
      `外部合作方/非并表参考主体严禁录入组织树（${reason}），请前往主数据「供应商」页签维护`,
      400
    );
  }
}

function normalizeCreditCode(raw: string | undefined): string {
  const v = (raw ?? '').trim().toUpperCase();
  if (!v) return '';
  if (!/^[0-9A-Z]{18}$/.test(v)) {
    throw Errors.validation('统一社会信用代码必须为空或 18 位大写字母与数字');
  }
  return v;
}

function normalizeContractPrefix(raw: string | undefined): string {
  const v = (raw ?? '').trim().toUpperCase();
  if (!v) return '';
  if (!/^[A-Z0-9][A-Z0-9_-]{0,23}$/.test(v)) {
    throw Errors.validation('合同前缀简码只能包含大写字母、数字、下划线或连字符（最长 24 位）');
  }
  return v;
}

export function listOrgRows(db: DB): OrgRow[] {
  return db.prepare(`${SELECT} ORDER BY sort_order, id`).all() as OrgRow[];
}

export function getOrgTree(
  db: DB,
  visible?: (orgId: number) => boolean
): { tree: TreeNodeDto[]; rows: OrgRow[]; leafIds: number[]; externalBlockedPatterns: ExternalBlockedPatterns } {
  const all = listOrgRows(db);
  const externalBlockedPatterns = listExternalBlockedPatterns(db);
  if (!visible) return { tree: buildTree(all), rows: all, leafIds: [...computeLeafIds(all)], externalBlockedPatterns };
  // 受限用户:只返回授权范围(授权根及其下级);授权根的上级不可见,在返回中作为根节点
  const rows = all.filter((r) => visible(r.id)).map((r) => (r.parent_id != null && !visible(r.parent_id) ? { ...r, parent_id: null } : r));
  const leaves = computeLeafIds(all);
  return { tree: buildTree(rows), rows, leafIds: rows.map((r) => r.id).filter((id) => leaves.has(id)), externalBlockedPatterns };
}

export function getOrg(db: DB, id: number): OrgRow {
  const row = db.prepare(`${SELECT} WHERE id = ?`).get(id) as OrgRow | undefined;
  if (!row) throw Errors.notFound('组织');
  return row;
}

function assertCodeFree(db: DB, code: string): void {
  if (db.prepare('SELECT 1 FROM org WHERE code = ?').get(code)) {
    throw Errors.conflict(`组织编码 ${code} 已存在(编码不可变且全局唯一)`);
  }
}

function assertParentOk(db: DB, parentId: number | null): void {
  if (parentId == null) return;
  getOrg(db, parentId);
}

export interface CreateOrgInput {
  parentId: number | null;
  code: string;
  name: string;
  sortOrder?: number;
  status?: 'active' | 'inactive';
  orgKind?: OrgKind;
  creditCode?: string;
  planIssuanceRootId?: number | null;
  isPlanExcluded?: boolean;
  contractPrefixCode?: string;
  isDirectStation?: boolean;
  reportFullName?: string;
}

export interface UpdateOrgInput {
  name?: string;
  sortOrder?: number;
  orgKind?: OrgKind;
  creditCode?: string;
  planIssuanceRootId?: number | null;
  isPlanExcluded?: boolean;
  contractPrefixCode?: string;
  isDirectStation?: boolean;
  reportFullName?: string;
}

export function validateCreateOrg(
  db: DB,
  input: CreateOrgInput
) {
  validateInput(createOrgSchema, input);
  if (!input.code?.trim()) throw Errors.validation('组织编码不能为空');
  if (!input.name?.trim()) throw Errors.validation('组织名称不能为空');
  normalizeCreditCode(input.creditCode);
  normalizeContractPrefix(input.contractPrefixCode);
  assertNotBlockedExternalOrg(db, {
    code: input.code,
    name: input.name,
    contractPrefixCode: input.contractPrefixCode,
  });
  const orgKind = input.orgKind ?? 'legal_entity';
  if (orgKind === 'closed_history' && input.status === 'active') {
    throw Errors.validation('历史关停主体（closed_history）状态必须为 inactive');
  }
  if (input.isDirectStation && orgKind !== 'direct_unit') {
    throw Errors.validation('仅直属非法人分支机构（direct_unit）可勾选直属水电站标志');
  }
  assertCodeFree(db, input.code.trim());
  assertParentOk(db, input.parentId);
  if (input.planIssuanceRootId != null) {
    getOrg(db, input.planIssuanceRootId);
  }
  if (input.parentId != null) {
    const rows = listOrgRows(db);
    const parent = rows.find((row) => row.id === input.parentId)!;
    const hasChildren = rows.some((row) => row.parent_id === parent.id);
    if (!hasChildren) {
      const inBudget = db.prepare('SELECT 1 FROM budget_entry WHERE org_id = ? LIMIT 1').get(parent.id);
      const inCurrentActual = db.prepare('SELECT 1 FROM actual_current WHERE org_id = ? LIMIT 1').get(parent.id);
      if (inBudget || inCurrentActual) {
        throw Errors.conflict(`组织 ${parent.code} 已有预算或当前实际明细，不能直接增加子组织；请先迁移存量数据`);
      }
    }
  }
  return undefined;
}

export function createOrg(
  db: DB,
  input: CreateOrgInput
): OrgResponseDto {
  validateCreateOrg(db, input);
  const now = new Date().toISOString();
  const orgKind = input.orgKind ?? 'legal_entity';
  const effectiveStatus = orgKind === 'closed_history' ? 'inactive' : (input.status ?? 'active');
  const creditCode = normalizeCreditCode(input.creditCode);
  const contractPrefixCode = normalizeContractPrefix(input.contractPrefixCode);
  const reportFullName = (input.reportFullName ?? '').trim();
  const tx = db.transaction(() => {
    validateCreateOrg(db, input);
    const info = db
      .prepare(
        `INSERT INTO org (
          parent_id, code, name, sort_order, status,
          org_kind, credit_code, plan_issuance_root_id, is_plan_excluded, contract_prefix_code, is_direct_station, report_full_name,
          created_at, updated_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
      )
      .run(
        input.parentId,
        input.code.trim(),
        input.name.trim(),
        input.sortOrder ?? 0,
        effectiveStatus,
        orgKind,
        creditCode,
        input.planIssuanceRootId ?? null,
        input.isPlanExcluded ? 1 : 0,
        contractPrefixCode,
        input.isDirectStation ? 1 : 0,
        reportFullName,
        now,
        now
      );
    const id = Number(info.lastInsertRowid);
    writeLog(db, 'org.create', 'org', id, {
      code: input.code.trim(),
      name: input.name.trim(),
      parentId: input.parentId,
      orgKind,
      isDirectStation: Boolean(input.isDirectStation),
      isPlanExcluded: Boolean(input.isPlanExcluded),
    });
    return id;
  });
  const id = tx();
  return toOrgResponse(getOrg(db, id));
}

export function validateUpdateOrg(db: DB, id: number, input: UpdateOrgInput) {
  validateInput(updateOrgSchema, input);
  const org = getOrg(db, id);
  if (input.name !== undefined) {
    if (!input.name.trim()) throw Errors.validation('组织名称不能为空');
  }
  if (input.creditCode !== undefined) normalizeCreditCode(input.creditCode);
  if (input.contractPrefixCode !== undefined) normalizeContractPrefix(input.contractPrefixCode);
  assertNotBlockedExternalOrg(db, {
    name: input.name ?? org.name,
    contractPrefixCode: input.contractPrefixCode ?? org.contract_prefix_code,
  });
  const nextKind = input.orgKind ?? org.org_kind;
  const nextDirectStation = input.isDirectStation !== undefined ? input.isDirectStation : org.is_direct_station === 1;
  if (nextDirectStation && nextKind !== 'direct_unit') {
    throw Errors.validation('仅直属非法人分支机构（direct_unit）可勾选直属水电站标志');
  }
  if (input.planIssuanceRootId !== undefined && input.planIssuanceRootId !== null) {
    getOrg(db, input.planIssuanceRootId);
  }
  return org;
}

export function updateOrg(db: DB, id: number, input: UpdateOrgInput): OrgResponseDto {
  const org = validateUpdateOrg(db, id, input);
  const now = new Date().toISOString();
  db.transaction(() => {
    validateUpdateOrg(db, id, input);
    const nextKind = input.orgKind ?? org.org_kind;
    const nextStatus = nextKind === 'closed_history' ? 'inactive' : org.status;
    const nextCredit = input.creditCode !== undefined ? normalizeCreditCode(input.creditCode) : org.credit_code;
    const nextRoot = input.planIssuanceRootId !== undefined ? input.planIssuanceRootId : org.plan_issuance_root_id;
    const nextExcluded = input.isPlanExcluded !== undefined ? (input.isPlanExcluded ? 1 : 0) : org.is_plan_excluded;
    const nextPrefix = input.contractPrefixCode !== undefined ? normalizeContractPrefix(input.contractPrefixCode) : org.contract_prefix_code;
    const nextStation = input.isDirectStation !== undefined ? (input.isDirectStation ? 1 : 0) : org.is_direct_station;
    const nextFullName = input.reportFullName !== undefined ? input.reportFullName.trim() : org.report_full_name;
    db.prepare(
      `UPDATE org SET
        name = ?, sort_order = ?, status = ?,
        org_kind = ?, credit_code = ?, plan_issuance_root_id = ?, is_plan_excluded = ?,
        contract_prefix_code = ?, is_direct_station = ?, report_full_name = ?,
        updated_at = ?
      WHERE id = ?`
    ).run(
      input.name !== undefined ? input.name.trim() : org.name,
      input.sortOrder ?? org.sort_order,
      nextStatus,
      nextKind,
      nextCredit,
      nextRoot,
      nextExcluded,
      nextPrefix,
      nextStation,
      nextFullName,
      now,
      id
    );
    writeLog(db, 'org.update', 'org', id, {
      name: input.name,
      sortOrder: input.sortOrder,
      orgKind: input.orgKind,
      isDirectStation: input.isDirectStation,
      isPlanExcluded: input.isPlanExcluded,
      contractPrefixCode: input.contractPrefixCode,
    });
  })();
  return toOrgResponse(getOrg(db, id));
}

/** 移动组织:目标父不能是自身及其后代(方案五.1) */
export function validateMoveOrg(db: DB, id: number, newParentId: number | null) {
  validateInput(moveInputSchema, { parentId: newParentId });
  getOrg(db, id);
  if (newParentId != null) {
    const target = getOrg(db, newParentId);
    if (target.id === id) throw Errors.validation('目标父节点不能是自身');
    if (isDescendantOf(listOrgRows(db), newParentId, id)) {
      throw Errors.validation('目标父节点不能是自身的后代');
    }
    const targetHasChildren = db.prepare('SELECT 1 FROM org WHERE parent_id = ? LIMIT 1').get(target.id);
    if (!targetHasChildren && orgReferenced(db, target.id)) {
      throw Errors.conflict(`组织 ${target.code} 已有预算、实际明细或财务映射引用，不能通过移动节点将其变为父组织；请先迁移存量数据`);
    }
  }
  return undefined;
}

export function moveOrg(db: DB, id: number, newParentId: number | null): OrgRow {
  validateMoveOrg(db, id, newParentId);
  db.transaction(() => {
    validateMoveOrg(db, id, newParentId);
    db.prepare('UPDATE org SET parent_id = ?, updated_at = ? WHERE id = ?').run(
      newParentId,
      new Date().toISOString(),
      id
    );
    writeLog(db, 'org.move', 'org', id, { newParentId });
  })();
  return toOrgResponse(getOrg(db, id));
}

/** 停用/启用:只影响新增引用,存量数据保留参与汇总(方案五.3) */
export function validateSetOrgStatus(db: DB, id: number, status: 'active' | 'inactive') {
  validateInput(statusInputSchema, { status });
  if (status !== 'active' && status !== 'inactive') throw Errors.validation('状态必须是 active 或 inactive');
  const org = getOrg(db, id);
  if (org.org_kind === 'closed_history' && status === 'active') {
    throw Errors.validation('历史关停主体（closed_history）不可直接启用，请先调整主体分类');
  }
  return undefined;
}

export function setOrgStatus(db: DB, id: number, status: 'active' | 'inactive'): OrgRow {
  validateSetOrgStatus(db, id, status);
  const action = status === 'inactive' ? 'org.deactivate' : 'org.activate';
  db.transaction(() => {
    validateSetOrgStatus(db, id, status);
    db.prepare('UPDATE org SET status = ?, updated_at = ? WHERE id = ?').run(status, new Date().toISOString(), id);
    writeLog(db, action, 'org', id, { status });
  })();
  return toOrgResponse(getOrg(db, id));
}

/** 组织被业务数据引用后不能物理删除 */
export function orgReferenced(db: DB, id: number): boolean {
  const inBudget = db.prepare('SELECT 1 FROM budget_entry WHERE org_id = ? LIMIT 1').get(id);
  const inActual = db.prepare('SELECT 1 FROM actual_current WHERE org_id = ? LIMIT 1').get(id);
  const inSnapshot = db.prepare('SELECT 1 FROM actual_snapshot_entry WHERE org_id = ? LIMIT 1').get(id);
  // 财务映射目标组织:target_org_id 建表无外键,删除后非停用映射成悬空引用,要到下次转换才暴露
  // (低版本库无此表——迁移中途状态/旧备份恢复场景按无引用处理)
  const inMapping = db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='finance_org_mapping'").get()
    ? db.prepare(
      `SELECT 1 FROM finance_org_mapping m JOIN finance_mapping_version v ON v.id = m.mapping_version_id
       WHERE m.target_org_id = ? AND v.status != 'retired' LIMIT 1`
    ).get(id)
    : undefined;
  return Boolean(inBudget || inActual || inSnapshot || inMapping);
}

/** 汇总格备注引用(仅物理删除保护用;不阻塞移动等结构操作——备注在节点变为非叶子后依然合法) */
function orgNoteReferenced(db: DB, id: number): boolean {
  const inBudgetNote = db.prepare('SELECT 1 FROM budget_cell_note WHERE org_id = ? LIMIT 1').get(id);
  const inActualNote = db.prepare('SELECT 1 FROM actual_cell_note WHERE org_id = ? LIMIT 1').get(id);
  return Boolean(inBudgetNote || inActualNote);
}

export function deleteOrg(db: DB, id: number): void {
  const org = getOrg(db, id);
  const childCount = db.prepare('SELECT COUNT(*) AS c FROM org WHERE parent_id = ?').get(id) as { c: number };
  if (childCount.c > 0) throw Errors.conflict('存在下级组织,不能删除');
  // 汇总格备注的组织侧可以是叶子(另一侧非叶子),物理删除会留下悬挂批注
  if (orgReferenced(db, id) || orgNoteReferenced(db, id)) {
    throw Errors.conflict('组织已被预算/实际数据或财务映射引用,不能物理删除(可停用)');
  }
  db.transaction(() => {
    db.prepare('DELETE FROM org WHERE id = ?').run(id);
    writeLog(db, 'org.delete', 'org', id, { deleted: true, code: org.code });
  })();
}

/** 结构检查:循环、孤儿、同级编码排序 */
export function checkOrgStructure(db: DB): { ok: boolean; problems: string[] } {
  const rows = listOrgRows(db);
  const problems: string[] = [];
  const ids = new Set(rows.map((r) => r.id));
  for (const r of rows) {
    if (r.parent_id != null) {
      if (r.parent_id === r.id) problems.push(`组织 ${r.code} 的父节点是自身`);
      else if (!ids.has(r.parent_id)) problems.push(`组织 ${r.code} 的父节点 ${r.parent_id} 不存在(孤儿节点)`);
    }
    if (r.status !== 'active' && r.status !== 'inactive') problems.push(`组织 ${r.code} 状态非法: ${r.status}`);
  }
  // 链式循环检测
  const byId = new Map(rows.map((r) => [r.id, r]));
  for (const r of rows) {
    const seen = new Set<number>();
    let cur: OrgRow | undefined = r;
    while (cur && cur.parent_id != null) {
      if (seen.has(cur.id)) { problems.push(`组织 ${r.code} 所在链路存在循环`); break; }
      seen.add(cur.id);
      cur = byId.get(cur.parent_id);
    }
  }
  return { ok: problems.length === 0, problems };
}

/* ============ 批量组织树导入（GAP-01 / GAP-02） ============ */

export interface OrgImportRowInput {
  code?: unknown;
  parentCode?: unknown;
  name?: unknown;
  shortName?: unknown;
  reportFullName?: unknown;
  creditCode?: unknown;
  orgKind?: unknown;
  contractPrefixCode?: unknown;
  planIssuanceRootCode?: unknown;
  isPlanExcluded?: unknown;
  isDirectStation?: unknown;
  status?: unknown;
  sortOrder?: unknown;
}

export interface OrgImportPreviewRow {
  row: number;
  code: string;
  parentCode: string | null;
  name: string;
  orgKind: OrgKind;
  creditCode: string;
  planIssuanceRootCode: string | null;
  contractPrefixCode: string;
  isPlanExcluded: boolean;
  isDirectStation: boolean;
  reportFullName: string;
  status: 'active' | 'inactive';
  sortOrder: number;
  action: 'create' | 'update';
  errors: string[];
}

export interface OrgBatchImportResult {
  mode: 'preview' | 'confirm';
  previewRows: OrgImportPreviewRow[];
  errors: { row: number; field: string; message: string }[];
  created: number;
  updated: number;
}

function parseBoolFlag(v: unknown, label: string): boolean {
  if (typeof v === 'boolean') return v;
  if (v === 1 || v === '1' || v === 'true' || v === '是') return true;
  if (v === 0 || v === '0' || v === 'false' || v === '否' || v === '' || v === undefined || v === null) return false;
  throw new Error(`${label} 取值无效（仅允许 0/1/true/false/是/否）`);
}

export function previewOrgBatchImport(db: DB, rawRows: unknown): OrgBatchImportResult {
  if (!Array.isArray(rawRows) || rawRows.length === 0) {
    throw Errors.validation('请提供非空的组织导入行数组 rows');
  }
  if (rawRows.length > 1000) {
    throw Errors.validation('单次批量导入组织不能超过 1000 行');
  }
  const existing = listOrgRows(db);
  const existingByCode = new Map(existing.map((r) => [r.code, r]));
  const existingCodesUpper = new Set(existing.map((r) => r.code.toUpperCase()));
  const blocked = listExternalBlockedPatterns(db);

  const seenCodes = new Map<string, number>();
  const previewRows: OrgImportPreviewRow[] = [];
  const errors: { row: number; field: string; message: string }[] = [];
  const pushErr = (rowNo: number, rowErrors: string[], field: string, message: string) => {
    rowErrors.push(message);
    errors.push({ row: rowNo, field, message });
  };

  rawRows.forEach((rawItem, idx) => {
    const rowNo = idx + 1;
    const item = (rawItem && typeof rawItem === 'object' ? rawItem : {}) as OrgImportRowInput;
    const rowErrors: string[] = [];
    const code = typeof item.code === 'string' ? item.code.trim() : String(item.code ?? '').trim();
    const parentCodeRaw = typeof item.parentCode === 'string' ? item.parentCode.trim() : String(item.parentCode ?? '').trim();
    const parentCode = parentCodeRaw || null;
    const name = typeof item.name === 'string' ? item.name.trim() : String(item.name ?? '').trim();
    const orgKindRaw = typeof item.orgKind === 'string' && item.orgKind.trim() ? item.orgKind.trim() : 'legal_entity';
    const orgKind: OrgKind = (ORG_KINDS as readonly string[]).includes(orgKindRaw)
      ? (orgKindRaw as OrgKind)
      : 'legal_entity';
    if (!(ORG_KINDS as readonly string[]).includes(orgKindRaw)) {
      pushErr(rowNo, rowErrors, 'orgKind', `主体分类非法: ${orgKindRaw}`);
    }
    if (!code) pushErr(rowNo, rowErrors, 'code', '组织编码不能为空');
    else if (code.length > 128) pushErr(rowNo, rowErrors, 'code', '组织编码不能超过 128 个字符');
    else if (seenCodes.has(code)) {
      pushErr(rowNo, rowErrors, 'code', `批次内组织编码 ${code} 与第 ${seenCodes.get(code)} 行重复`);
    } else {
      seenCodes.set(code, rowNo);
    }
    if (!name) pushErr(rowNo, rowErrors, 'name', '组织名称不能为空');

    let creditCode = '';
    const creditRaw = typeof item.creditCode === 'string' ? item.creditCode.trim().toUpperCase() : String(item.creditCode ?? '').trim().toUpperCase();
    if (creditRaw) {
      if (!/^[0-9A-Z]{18}$/.test(creditRaw)) pushErr(rowNo, rowErrors, 'creditCode', '统一社会信用代码必须为 18 位大写字母数字');
      else creditCode = creditRaw;
    }

    let contractPrefixCode = '';
    const prefixRaw = typeof item.contractPrefixCode === 'string' ? item.contractPrefixCode.trim().toUpperCase() : String(item.contractPrefixCode ?? '').trim().toUpperCase();
    if (prefixRaw) {
      if (!/^[A-Z0-9][A-Z0-9_-]{0,23}$/.test(prefixRaw)) {
        pushErr(rowNo, rowErrors, 'contractPrefixCode', '合同前缀简码格式不合法');
      } else {
        contractPrefixCode = prefixRaw;
      }
    }

    const rootCodeRaw = typeof item.planIssuanceRootCode === 'string' ? item.planIssuanceRootCode.trim() : String(item.planIssuanceRootCode ?? '').trim();
    const planIssuanceRootCode = rootCodeRaw || null;

    let isPlanExcluded = false;
    try {
      isPlanExcluded = parseBoolFlag(item.isPlanExcluded, 'isPlanExcluded');
    } catch (e) {
      pushErr(rowNo, rowErrors, 'isPlanExcluded', (e as Error).message);
    }

    let isDirectStation = false;
    try {
      isDirectStation = parseBoolFlag(item.isDirectStation, 'isDirectStation');
    } catch (e) {
      pushErr(rowNo, rowErrors, 'isDirectStation', (e as Error).message);
    }
    if (isDirectStation && orgKind !== 'direct_unit') {
      pushErr(rowNo, rowErrors, 'isDirectStation', '仅 direct_unit 可设置 isDirectStation=1');
    }

    const statusRaw = typeof item.status === 'string' && item.status.trim()
      ? item.status.trim()
      : orgKind === 'closed_history'
        ? 'inactive'
        : 'active';
    let status: 'active' | 'inactive' = 'active';
    if (statusRaw !== 'active' && statusRaw !== 'inactive') {
      pushErr(rowNo, rowErrors, 'status', `状态非法: ${statusRaw}`);
    } else {
      status = statusRaw;
    }
    if (orgKind === 'closed_history' && status !== 'inactive') {
      pushErr(rowNo, rowErrors, 'status', '历史关停主体（closed_history）状态必须为 inactive');
    }

    const sortNum = item.sortOrder === undefined || item.sortOrder === '' || item.sortOrder === null
      ? idx + 1
      : Number(item.sortOrder);
    const sortVal = Number.isSafeInteger(sortNum) ? sortNum : idx + 1;
    if (!Number.isSafeInteger(sortNum)) {
      pushErr(rowNo, rowErrors, 'sortOrder', 'sortOrder 必须是整数');
    }

    const reportFullName = typeof item.reportFullName === 'string' ? item.reportFullName.trim() : String(item.reportFullName ?? '').trim();
    const extHit = findExternalBlockMatch(blocked, { code, name, contractPrefixCode }, existingCodesUpper);
    if (extHit) {
      pushErr(rowNo, rowErrors, 'name', `外部合作方严禁录入组织树（${extHit}），请维护至主数据供应商`);
    }

    previewRows.push({
      row: rowNo,
      code,
      parentCode,
      name,
      orgKind,
      creditCode,
      planIssuanceRootCode,
      contractPrefixCode,
      isPlanExcluded,
      isDirectStation,
      reportFullName,
      status,
      sortOrder: sortVal,
      action: existingByCode.has(code) ? 'update' : 'create',
      errors: rowErrors,
    });
  });

  // 父节点存在性与完整链路循环检测（结合存量树 + 本批覆盖关系）
  const parentOfCode = new Map<string, string | null>();
  const idToCode = new Map(existing.map((r) => [r.id, r.code]));
  for (const r of existing) {
    parentOfCode.set(r.code, r.parent_id != null ? idToCode.get(r.parent_id) ?? null : null);
  }
  for (const pr of previewRows) {
    if (pr.code) parentOfCode.set(pr.code, pr.parentCode);
  }

  for (const pr of previewRows) {
    if (!pr.code) continue;
    if (pr.parentCode !== null) {
      if (pr.parentCode === pr.code) {
        pushErr(pr.row, pr.errors, 'parentCode', `组织 ${pr.code} 的父节点不能是自身`);
      } else if (!parentOfCode.has(pr.parentCode)) {
        pushErr(pr.row, pr.errors, 'parentCode', `父组织编码 ${pr.parentCode} 不存在`);
      } else {
        const visited = new Set<string>([pr.code]);
        let cur: string | null = pr.parentCode;
        while (cur !== null) {
          if (visited.has(cur)) {
            pushErr(pr.row, pr.errors, 'parentCode', `组织 ${pr.code} 所在父子链存在循环引用`);
            break;
          }
          visited.add(cur);
          cur = parentOfCode.get(cur) ?? null;
        }
      }
    }
    if (pr.planIssuanceRootCode !== null && !parentOfCode.has(pr.planIssuanceRootCode)) {
      pushErr(pr.row, pr.errors, 'planIssuanceRootCode', `计划归口一级单位编码 ${pr.planIssuanceRootCode} 不存在`);
    }
  }

  const created = previewRows.filter((r) => r.action === 'create' && r.errors.length === 0).length;
  const updated = previewRows.filter((r) => r.action === 'update' && r.errors.length === 0).length;
  return { mode: 'preview', previewRows, errors, created, updated };
}

export function confirmOrgBatchImport(db: DB, rawRows: unknown): OrgBatchImportResult {
  const preview = previewOrgBatchImport(db, rawRows);
  if (preview.errors.length > 0) {
    throw new AppError('VALIDATION_FAILED', `组织批量导入校验未通过（共 ${preview.errors.length} 处错误）`, 400, preview.errors);
  }

  // 按拓扑顺序排定插入/更新顺序：无父节点或父节点已在库内但不在本批次的先执行
  const batchByCode = new Map(preview.previewRows.map((r) => [r.code, r]));
  const ordered: OrgImportPreviewRow[] = [];
  const placed = new Set<string>();
  const place = (row: OrgImportPreviewRow) => {
    if (placed.has(row.code)) return;
    if (row.parentCode && batchByCode.has(row.parentCode)) {
      place(batchByCode.get(row.parentCode)!);
    }
    placed.add(row.code);
    ordered.push(row);
  };
  for (const r of preview.previewRows) place(r);

  const now = new Date().toISOString();
  let created = 0;
  let updated = 0;
  db.transaction(() => {
    const codeToId = new Map<string, number>(
      (db.prepare('SELECT id, code FROM org').all() as { id: number; code: string }[]).map((r) => [r.code, r.id])
    );
    const ins = db.prepare(`
      INSERT INTO org (
        parent_id, code, name, sort_order, status,
        org_kind, credit_code, plan_issuance_root_id, is_plan_excluded, contract_prefix_code, is_direct_station, report_full_name,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, NULL, ?, ?, ?, ?, ?, ?)
    `);
    const upd = db.prepare(`
      UPDATE org SET
        parent_id = ?, name = ?, sort_order = ?, status = ?,
        org_kind = ?, credit_code = ?, is_plan_excluded = ?, contract_prefix_code = ?, is_direct_station = ?, report_full_name = ?,
        updated_at = ?
      WHERE id = ?
    `);

    for (const r of ordered) {
      const parentId = r.parentCode ? (codeToId.get(r.parentCode) ?? null) : null;
      if (r.parentCode && parentId == null) {
        throw Errors.validation(`父组织编码 ${r.parentCode} 解析失败`);
      }
      const existingId = codeToId.get(r.code);
      if (existingId != null) {
        upd.run(
          parentId,
          r.name,
          r.sortOrder,
          r.status,
          r.orgKind,
          r.creditCode,
          r.isPlanExcluded ? 1 : 0,
          r.contractPrefixCode,
          r.isDirectStation ? 1 : 0,
          r.reportFullName,
          now,
          existingId
        );
        updated++;
      } else {
        const info = ins.run(
          parentId,
          r.code,
          r.name,
          r.sortOrder,
          r.status,
          r.orgKind,
          r.creditCode,
          r.isPlanExcluded ? 1 : 0,
          r.contractPrefixCode,
          r.isDirectStation ? 1 : 0,
          r.reportFullName,
          now,
          now
        );
        codeToId.set(r.code, Number(info.lastInsertRowid));
        created++;
      }
    }

    const setRoot = db.prepare('UPDATE org SET plan_issuance_root_id = ? WHERE id = ?');
    for (const r of ordered) {
      const id = codeToId.get(r.code)!;
      const rootId = r.planIssuanceRootCode ? (codeToId.get(r.planIssuanceRootCode) ?? null) : null;
      setRoot.run(rootId, id);
    }

    const check = checkOrgStructure(db);
    if (!check.ok) {
      throw Errors.validation(`导入后组织树结构检查未通过: ${check.problems.join('; ')}`);
    }
    writeLog(db, 'org.batch_import', 'org', '-', { total: ordered.length, created, updated });
  })();

  return { mode: 'confirm', previewRows: preview.previewRows, errors: [], created, updated };
}
