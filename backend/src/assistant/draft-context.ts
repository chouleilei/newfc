/**
 * 请求内草稿(方案《小澧助手全页面回答范围自动对齐开发计划》§5.7、§9.6)。
 *
 * 草稿直接随本轮 POST 请求发送，后端只在本次请求内存中解析和使用，请求结束立即释放。
 * 原始 changes 的五条禁令：
 *   1. 不写数据库；
 *   2. 不写 ai_message 或 operation_log(只允许 kind/变更数量摘要)；
 *   3. 不交给模型(模型只看脱敏范围与事实)；
 *   4. 不用于 preview、confirm、导入确认、年度关闭或恢复；
 *   5. 不在任何缓存/快照表中留存(本 MVP 不建设 overlayToken/TTL/LRU)。
 *
 * 基线校验：数据库 revision、updatedAt、版本状态或树快照变化时返回 DRAFT_STALE。
 */
import type { DB } from '../db/connection';
import { AppError } from '../core/errors';
import { displayToSignedCents, isQuantityType, quantityStringToScaled, signOfType, wanStringToCents, type AccountType } from '../core/money';
import { computeLeafIds, type TreeNodeRow } from '../core/tree';
import { rollup, type RollupResult } from '../core/rollup';
import { loadSnapshotNodes } from '../modules/tree/snapshot';
import { listRows } from '../modules/actual/actual.helpers';
import { listMetricsForVersion } from '../modules/metric/metric.service';
import type { DraftKind } from './page-capabilities';

/** 草稿 wire 格式(§5.7)：kind + base(最小基线) + changes(对应保存接口的受控 DTO)。 */
export interface DraftDescriptor {
  kind: DraftKind;
  base: Record<string, unknown>;
  changes: unknown;
}

export interface DraftBudgetOverlayEntry extends OverlayCellBase {
  formula: string;
  note: string;
}

export interface DraftActualOverlayEntry extends OverlayCellBase {
  memo: string;
}

export interface NormalizedDraft {
  kind: DraftKind;
  /** 变更数量。响应、日志与历史只允许看到这个摘要，绝不含原值。 */
  changeCount: number;
  /** 人类可读的基线描述，如「版本 #3 · 修订 12」。 */
  baseline: string;
  /** 配置类草稿的确定性校验问题(依赖检查/冲突说明)。 */
  issues: string[];
  /** 请求内只读计算视图：budget_grid / actual_grid 的解析后变更。 */
  overlay?: {
    budget?: { versionId: number; entries: DraftBudgetOverlayEntry[] };
    actual?: { year: number; entries: DraftActualOverlayEntry[] };
  };  /** 配置类草稿的受控字段(校验用，不进模型)。 */
  config?: { targetId: number | null; clientKey: string | null; fields: Record<string, unknown> };
}

/** overlay 单元格上删除/清空信号的表达：与保存链路「整包替换」语义对齐。 */
export interface OverlayCellBase {
  orgId: number;
  accountId: number;
  amountCents: number;
  quantity: number | null;
  /** true = 用户把格子清空/置零，保存时这行会被删除；删除格不参与金额合并。 */
  cleared: boolean;
}

function draftInvalid(message: string, snapshotId?: string, field = 'draft'): never {
  throw new AppError('CONTEXT_INVALID', message, 400, undefined, { field, snapshotId, reason: message });
}

function draftStale(message: string, snapshotId?: string): never {
  throw new AppError('DRAFT_STALE', message, 409, undefined, { snapshotId, reason: '草稿基线与数据库当前状态不同' });
}

function safeInt(value: unknown, field: string, snapshotId?: string): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) draftInvalid(`${field} 必须是正整数`, snapshotId, field);
  return n;
}

function text(value: unknown, field: string, max: number, snapshotId?: string): string {
  if (typeof value !== 'string') draftInvalid(`${field} 必须是字符串`, snapshotId, field);
  if (value.length > max) draftInvalid(`${field} 不能超过 ${max} 字符`, snapshotId, field);
  return value.trim();
}

interface BaseWithIdentity {
  targetId: number | null;
  clientKey: string | null;
  updatedAt: string | null;
}

/** 新建但尚无数据库 ID 的表单项使用本轮临时 clientKey，只在 draft 内部引用。 */
function parseIdentity(base: Record<string, unknown>, snapshotId?: string): BaseWithIdentity {
  const targetId = base.id != null ? safeInt(base.id, 'draft.base.id', snapshotId) : null;
  const clientKey = base.clientKey != null ? text(base.clientKey, 'draft.base.clientKey', 80, snapshotId) : null;
  const updatedAt = base.updatedAt != null ? text(base.updatedAt, 'draft.base.updatedAt', 40, snapshotId) : null;
  if (targetId == null && clientKey == null) draftInvalid('draft.base 必须携带 id(已有记录)或 clientKey(新建)', snapshotId, 'draft.base');
  if (targetId != null && updatedAt == null) draftInvalid('draft.base 必须携带读取时的 updatedAt 作为基线', snapshotId, 'draft.base.updatedAt');
  return { targetId, clientKey, updatedAt };
}

/** 已有记录的 updatedAt 基线校验。 */
function requireFresh(updatedAt: string | null, current: string | undefined, what: string, snapshotId?: string): void {
  if (current == null) draftInvalid(`${what}不存在`, snapshotId, 'draft.base.id');
  if (updatedAt !== current) draftStale(`${what}已被修改(基线 ${updatedAt} ≠ 当前 ${current})，请刷新后重试`, snapshotId);
}

/* ============ budget_grid / actual_grid(§9.6：复用保存 DTO、金额解析、数量解析) ============ */

interface RawGridEntry {
  orgId: number;
  accountId: number;
  amount?: string;
  amountWan?: string;
  amountCents?: number;
  quantity?: string;
  formula?: string;
  note?: string;
  memo?: string;
}

function parseGridEntries(raw: unknown, snapshotId: string): RawGridEntry[] {
  if (!Array.isArray(raw)) draftInvalid('draft.changes 必须是明细数组', snapshotId, 'draft.changes');
  return raw.map((item, index) => {
    if (item == null || typeof item !== 'object' || Array.isArray(item)) draftInvalid(`draft.changes[${index}] 必须是对象`, snapshotId, 'draft.changes');
    const entry = item as Record<string, unknown>;
    const orgId = safeInt(entry.orgId, `draft.changes[${index}].orgId`, snapshotId);
    const accountId = safeInt(entry.accountId, `draft.changes[${index}].accountId`, snapshotId);
    const out: RawGridEntry = { orgId, accountId };
    if (entry.amount != null) out.amount = text(entry.amount, `draft.changes[${index}].amount`, 40, snapshotId);
    if (entry.amountWan != null) out.amountWan = text(entry.amountWan, `draft.changes[${index}].amountWan`, 40, snapshotId);
    if (entry.amountCents != null) {
      const cents = Number(entry.amountCents);
      if (!Number.isSafeInteger(cents)) draftInvalid(`draft.changes[${index}].amountCents 必须是安全整数`, snapshotId, 'draft.changes');
      out.amountCents = cents;
    }
    if (entry.quantity != null) out.quantity = text(entry.quantity, `draft.changes[${index}].quantity`, 40, snapshotId);
    if (entry.formula != null) out.formula = text(entry.formula, `draft.changes[${index}].formula`, 500, snapshotId);
    if (entry.note != null) out.note = text(entry.note, `draft.changes[${index}].note`, 2000, snapshotId);
    if (entry.memo != null) out.memo = text(entry.memo, `draft.changes[${index}].memo`, 2000, snapshotId);
    return out;
  });
}

/** 金额三口径：amountCents(带符号存储分) > amountWan(万元展示) > amount(元展示)。负数表示冲销。 */
function parseEntryCents(entry: RawGridEntry, type: AccountType, index: number, snapshotId: string): number {
  try {
    if (entry.amountCents != null) return entry.amountCents;
    if (isQuantityType(type)) return 0;
    // 万元直接乘符号方向，不经过浮点除法(与保存链路 displayToSignedCents 同口径)。
    if (entry.amountWan != null) return wanStringToCents(entry.amountWan) * signOfType(type);
    if (entry.amount != null) return displayToSignedCents(entry.amount, type);
  } catch (err) {
    draftInvalid(`draft.changes[${index}] 金额格式不正确：${err instanceof Error ? err.message : String(err)}`, snapshotId, 'draft.changes');
  }
  draftInvalid(`draft.changes[${index}] 金额科目必须提供 amount、amountWan 或 amountCents`, snapshotId, 'draft.changes');
}

function parseEntryQuantity(entry: RawGridEntry, index: number, snapshotId: string): number {
  if (entry.quantity == null || !String(entry.quantity).trim()) {
    draftInvalid(`draft.changes[${index}] 数量科目必须提供 quantity`, snapshotId, 'draft.changes');
  }
  try {
    return quantityStringToScaled(entry.quantity!);
  } catch (err) {
    draftInvalid(`draft.changes[${index}] 数量格式不正确：${err instanceof Error ? err.message : String(err)}`, snapshotId, 'draft.changes');
  }
}

/**
 * 判断格子在保存链路里是否会被「删除」：
 * 前端整包保存对金额格跳过「0 元且无公式/备注」的条目、数量格跳过空数量
 * (整包替换模式下不提交 = 服务端删除该行)。草稿影响必须复用同一语义，
 * 否则「清空单元格」在草稿 diff 里会被算成「改成 0 元的行」而不是删除。
 */
function isCellCleared(entry: RawGridEntry, type: AccountType): boolean {
  if (isQuantityType(type)) {
    const q = String(entry.quantity ?? '').trim();
    return q === '';
  }
  try {
    if (entry.amountCents != null) return entry.amountCents === 0 && !entry.formula?.trim() && !entry.note?.trim();
    if (entry.amountWan != null) return wanStringToCents(entry.amountWan) === 0 && !entry.formula?.trim() && !entry.note?.trim();
    if (entry.amount != null) {
      const cents = displayToSignedCents(entry.amount, type);
      return cents === 0 && !entry.formula?.trim() && !entry.note?.trim() && !entry.memo?.trim();
    }
  } catch {
    return false;
  }
  return true;
}

function normalizeBudgetGrid(db: DB, draft: DraftDescriptor, snapshotId: string): NormalizedDraft {  const versionId = safeInt(draft.base.versionId, 'draft.base.versionId', snapshotId);
  const version = db.prepare('SELECT id, year, name, status, revision, org_tree_snapshot_id, account_tree_snapshot_id FROM budget_version WHERE id=?').get(versionId) as
    | { id: number; year: number; name: string; status: string; revision: number; org_tree_snapshot_id: number; account_tree_snapshot_id: number }
    | undefined;
  if (!version) draftInvalid(`预算版本 #${versionId} 不存在`, snapshotId, 'draft.base.versionId');
  if (version.status !== 'draft') draftStale(`版本「${version.name}」已${version.status === 'locked' ? '定稿' : '归档'}，草稿基线已失效`, snapshotId);
  const revision = Number(draft.base.revision);
  if (!Number.isSafeInteger(revision) || revision < 0) draftInvalid('draft.base.revision 必须是非负整数', snapshotId, 'draft.base.revision');
  if (version.revision !== revision) {
    draftStale(`预算草稿已被更新(当前修订 ${version.revision}，草稿基线 ${revision})，请刷新后重试`, snapshotId);
  }
  if (draft.base.orgTreeSnapshotId != null && Number(draft.base.orgTreeSnapshotId) !== version.org_tree_snapshot_id) {
    draftStale('组织树快照已变化，草稿基线已失效', snapshotId);
  }
  if (draft.base.accountTreeSnapshotId != null && Number(draft.base.accountTreeSnapshotId) !== version.account_tree_snapshot_id) {
    draftStale('科目树快照已变化，草稿基线已失效', snapshotId);
  }

  // 叶子校验与科目类型必须取自版本绑定的树快照(与 saveEntries 同口径)。
  const orgRows = loadSnapshotNodes(db, version.org_tree_snapshot_id);
  const accRows = loadSnapshotNodes(db, version.account_tree_snapshot_id);
  const leafOrgs = computeLeafIds(orgRows);
  const leafAccs = computeLeafIds(accRows);
  const typeOf = new Map(accRows.map((row) => [row.id, (row.type ?? 'expense') as AccountType]));

  const seen = new Set<string>();
  const entries: DraftBudgetOverlayEntry[] = parseGridEntries(draft.changes, snapshotId).map((entry, index) => {
    const key = `${entry.orgId}:${entry.accountId}`;
    if (seen.has(key)) draftInvalid(`draft.changes[${index}] 与之前的明细重复`, snapshotId, 'draft.changes');
    seen.add(key);
    if (!leafOrgs.has(entry.orgId)) draftInvalid(`draft.changes[${index}] 组织 #${entry.orgId} 不在版本绑定的组织树快照中或不是叶子`, snapshotId, 'draft.changes');
    if (!leafAccs.has(entry.accountId)) draftInvalid(`draft.changes[${index}] 科目 #${entry.accountId} 不在版本绑定的科目树快照中或不是叶子`, snapshotId, 'draft.changes');
    const type = typeOf.get(entry.accountId) ?? 'expense';
    return {
      orgId: entry.orgId,
      accountId: entry.accountId,
      amountCents: isQuantityType(type) ? 0 : parseEntryCents(entry, type, index, snapshotId),
      quantity: isQuantityType(type) && !isCellCleared(entry, type) ? parseEntryQuantity(entry, index, snapshotId) : null,
      // 清空/置零格 = 删除行(与保存链路的整包替换语义一致，见 diffOverlay)。
      cleared: isCellCleared(entry, type),
      formula: entry.formula ?? '',
      note: entry.note ?? '',
    };
  });
  return {
    kind: 'budget_grid',
    changeCount: entries.length,
    baseline: `版本 #${version.id}「${version.name}」· 修订 ${version.revision}`,
    issues: [],
    overlay: { budget: { versionId, entries } },
  };
}

function normalizeActualGrid(db: DB, draft: DraftDescriptor, snapshotId: string): NormalizedDraft {
  const year = safeInt(draft.base.year, 'draft.base.year', snapshotId);
  const state = db.prepare('SELECT year, status, current_batch_id FROM actual_year_state WHERE year=?').get(year) as
    | { year: number; status: string; current_batch_id: number | null }
    | undefined;
  if (state && state.status !== 'open') draftStale(`${year} 年度已冻结，草稿基线已失效`, snapshotId);
  const currentBatchId = state?.current_batch_id ?? null;
  const baseBatchId = draft.base.batchId == null ? null : safeInt(draft.base.batchId, 'draft.base.batchId', snapshotId);
  if (baseBatchId !== currentBatchId) {
    draftStale(`当前实际批次已变化(当前 ${currentBatchId ?? '无'}，草稿基线 ${baseBatchId ?? '无'})，请刷新后重试`, snapshotId);
  }

  // 实际数以当前树为准(与 saveActual 同口径)。
  const orgRows = db.prepare('SELECT id, parent_id, code, name, status, sort_order, type FROM org').all() as never[];
  const accRows = db.prepare('SELECT id, parent_id, code, name, status, sort_order, type FROM account').all() as never[];
  const leafOrgs = computeLeafIds(orgRows as never);
  const leafAccs = computeLeafIds(accRows as never);
  const typeOf = new Map((accRows as { id: number; type: string }[]).map((row) => [row.id, (row.type ?? 'expense') as AccountType]));

  const seen = new Set<string>();
  const entries: DraftActualOverlayEntry[] = parseGridEntries(draft.changes, snapshotId).map((entry, index) => {
    const key = `${entry.orgId}:${entry.accountId}`;
    if (seen.has(key)) draftInvalid(`draft.changes[${index}] 与之前的明细重复`, snapshotId, 'draft.changes');
    seen.add(key);
    if (!leafOrgs.has(entry.orgId)) draftInvalid(`draft.changes[${index}] 组织 #${entry.orgId} 不是当前树的叶子组织`, snapshotId, 'draft.changes');
    if (!leafAccs.has(entry.accountId)) draftInvalid(`draft.changes[${index}] 科目 #${entry.accountId} 不是当前树的叶子科目`, snapshotId, 'draft.changes');
    const type = typeOf.get(entry.accountId) ?? 'expense';
    return {
      orgId: entry.orgId,
      accountId: entry.accountId,
      amountCents: isQuantityType(type) ? 0 : parseEntryCents(entry, type, index, snapshotId),
      quantity: isQuantityType(type) && !isCellCleared(entry, type) ? parseEntryQuantity(entry, index, snapshotId) : null,
      cleared: isCellCleared(entry, type),
      memo: entry.memo ?? entry.note ?? '',
    };
  });
  return {
    kind: 'actual_grid',
    changeCount: entries.length,
    baseline: `${year} 年当前实际 · 批次 ${currentBatchId ?? '无'}`,
    issues: [],
    overlay: { actual: { year, entries } },
  };
}

/* ============ 配置类草稿(确定性校验、依赖检查和冲突说明) ============ */

const CONFIG_FIELD_WHITELIST: Record<string, string[]> = {
  org_form: ['code', 'name', 'parentId', 'status', 'sortOrder'],
  account_form: ['code', 'name', 'parentId', 'type', 'unit', 'status', 'sortOrder', 'sheetCodes'],
  metric_formula: ['code', 'name', 'displaySign', 'status', 'displayOrder', 'terms'],
  calculation_rule: ['code', 'name', 'ruleType', 'sheetCode', 'config', 'status'],
  cleaning_template: ['name', 'targetKind', 'config'],
  alias_rule: ['targetKind', 'mappingKind', 'sourceText', 'targetCode'],
};

function parseConfigChanges(kind: DraftKind, raw: unknown, snapshotId?: string): Record<string, unknown> {
  if (raw == null || typeof raw !== 'object' || Array.isArray(raw)) draftInvalid('draft.changes 必须是表单字段对象', snapshotId, 'draft.changes');
  const allowed = CONFIG_FIELD_WHITELIST[kind] ?? [];
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw as Record<string, unknown>)) {
    if (!allowed.includes(key)) draftInvalid(`draft.changes 不支持字段「${key}」`, snapshotId, `draft.changes.${key}`);
    if (typeof value === 'string' && value.length > 4000) draftInvalid(`draft.changes.${key} 过长`, snapshotId, `draft.changes.${key}`);
    out[key] = value;
  }
  return out;
}

function validateOrgForm(db: DB, fields: Record<string, unknown>, targetId: number | null): string[] {
  const issues: string[] = [];
  const code = typeof fields.code === 'string' ? fields.code.trim() : '';
  const name = typeof fields.name === 'string' ? fields.name.trim() : '';
  if (!code) issues.push('组织编码不能为空');
  if (!name) issues.push('组织名称不能为空');
  if (code) {
    const dup = db.prepare('SELECT id FROM org WHERE code=?').get(code) as { id: number } | undefined;
    if (dup && dup.id !== targetId) issues.push(`组织编码「${code}」已被 #${dup.id} 占用`);
  }
  if (fields.parentId != null) {
    const parentId = Number(fields.parentId);
    if (!Number.isSafeInteger(parentId)) issues.push('parentId 必须是整数');
    else {
      if (targetId != null && parentId === targetId) issues.push('上级组织不能是自身');
      const parent = db.prepare('SELECT id FROM org WHERE id=?').get(parentId);
      if (!parent) issues.push(`上级组织 #${parentId} 不存在`);
    }
  }
  if (fields.status != null && !['active', 'inactive'].includes(String(fields.status))) issues.push('status 必须是 active 或 inactive');
  return issues;
}

function validateAccountForm(db: DB, fields: Record<string, unknown>, targetId: number | null): string[] {
  const issues: string[] = [];
  const code = typeof fields.code === 'string' ? fields.code.trim() : '';
  const name = typeof fields.name === 'string' ? fields.name.trim() : '';
  if (!code) issues.push('科目编码不能为空');
  if (!name) issues.push('科目名称不能为空');
  if (fields.type != null && !['income', 'cost', 'expense', 'quantity'].includes(String(fields.type))) issues.push('type 必须是 income/cost/expense/quantity');
  if (code) {
    const dup = db.prepare('SELECT id FROM account WHERE code=?').get(code) as { id: number } | undefined;
    if (dup && dup.id !== targetId) issues.push(`科目编码「${code}」已被 #${dup.id} 占用`);
  }
  if (fields.parentId != null) {
    const parentId = Number(fields.parentId);
    if (!Number.isSafeInteger(parentId)) issues.push('parentId 必须是整数');
    else {
      if (targetId != null && parentId === targetId) issues.push('上级科目不能是自身');
      const parent = db.prepare('SELECT id FROM account WHERE id=?').get(parentId);
      if (!parent) issues.push(`上级科目 #${parentId} 不存在`);
    }
  }
  return issues;
}

function validateMetricFormula(db: DB, fields: Record<string, unknown>, targetId: number | null): string[] {
  const issues: string[] = [];
  const code = typeof fields.code === 'string' ? fields.code.trim() : '';
  if (!code) issues.push('指标编码不能为空');
  if (typeof fields.name === 'string' && !fields.name.trim()) issues.push('指标名称不能为空');
  if (code) {
    const dup = db.prepare('SELECT id FROM report_metric WHERE code=?').get(code) as { id: number } | undefined;
    if (dup && dup.id !== targetId) issues.push(`指标编码「${code}」已被 #${dup.id} 占用`);
  }
  if (fields.terms != null) {
    if (!Array.isArray(fields.terms)) issues.push('terms 必须是数组');
    else {
      for (const [index, term] of (fields.terms as unknown[]).entries()) {
        if (term == null || typeof term !== 'object') { issues.push(`公式项 ${index + 1} 必须是对象`); continue; }
        const t = term as Record<string, unknown>;
        const sourceType = String(t.sourceType ?? '');
        if (!['account', 'metric'].includes(sourceType)) { issues.push(`公式项 ${index + 1} 的 sourceType 必须是 account 或 metric`); continue; }
        const sourceId = Number(t.sourceId);
        if (!Number.isSafeInteger(sourceId) || sourceId <= 0) { issues.push(`公式项 ${index + 1} 的 sourceId 必须是正整数`); continue; }
        if (sourceType === 'account' && !db.prepare('SELECT id FROM account WHERE id=?').get(sourceId)) issues.push(`公式项 ${index + 1} 引用的科目 #${sourceId} 不存在`);
        if (sourceType === 'metric') {
          if (targetId != null && sourceId === targetId) issues.push(`公式项 ${index + 1} 不能引用指标自身`);
          if (!db.prepare('SELECT id FROM report_metric WHERE id=?').get(sourceId)) issues.push(`公式项 ${index + 1} 引用的指标 #${sourceId} 不存在`);
        }
        const coefficient = Number(t.coefficient);
        if (coefficient !== 1 && coefficient !== -1) issues.push(`公式项 ${index + 1} 的系数必须是 +1 或 -1`);
      }
    }
  }
  return issues;
}

function validateCalculationRule(db: DB, fields: Record<string, unknown>, targetId: number | null): string[] {
  const issues: string[] = [];
  const code = typeof fields.code === 'string' ? fields.code.trim() : '';
  if (!code) issues.push('规则编码不能为空');
  if (fields.ruleType != null && !['quantity_price_net_tax', 'multiply'].includes(String(fields.ruleType))) issues.push('ruleType 必须是 quantity_price_net_tax 或 multiply');
  if (code) {
    const dup = db.prepare('SELECT id FROM budget_calculation_rule WHERE code=?').get(code) as { id: number } | undefined;
    if (dup && dup.id !== targetId) issues.push(`规则编码「${code}」已被 #${dup.id} 占用`);
  }
  return issues;
}

function validateCleaningTemplate(db: DB, fields: Record<string, unknown>, targetId: number | null): string[] {
  const issues: string[] = [];
  if (fields.targetKind != null && !['budget', 'actual-current'].includes(String(fields.targetKind))) issues.push('targetKind 必须是 budget 或 actual-current');
  if (typeof fields.name === 'string' && !fields.name.trim()) issues.push('模板名称不能为空');
  if (targetId != null && !db.prepare('SELECT id FROM import_mapping_template WHERE id=?').get(targetId)) issues.push(`模板 #${targetId} 不存在`);
  return issues;
}

function validateAliasRule(db: DB, fields: Record<string, unknown>, _targetId: number | null): string[] {
  const issues: string[] = [];
  if (fields.targetKind != null && !['budget', 'actual-current'].includes(String(fields.targetKind))) issues.push('targetKind 必须是 budget 或 actual-current');
  if (fields.mappingKind != null && !['org', 'account'].includes(String(fields.mappingKind))) issues.push('mappingKind 必须是 org 或 account');
  if (fields.sourceText != null && !String(fields.sourceText).trim()) issues.push('来源名称不能为空');
  const targetCode = typeof fields.targetCode === 'string' ? fields.targetCode.trim() : '';
  if (targetCode) {
    const table = String(fields.mappingKind ?? 'org') === 'account' ? 'account' : 'org';
    if (!db.prepare(`SELECT id FROM ${table} WHERE code=?`).get(targetCode)) issues.push(`目标编码「${targetCode}」在${table === 'org' ? '组织' : '科目'}中不存在`);
  }
  return issues;
}

const CONFIG_VALIDATORS: Record<string, (db: DB, fields: Record<string, unknown>, targetId: number | null) => string[]> = {
  org_form: validateOrgForm,
  account_form: validateAccountForm,
  metric_formula: validateMetricFormula,
  calculation_rule: validateCalculationRule,
  cleaning_template: validateCleaningTemplate,
  alias_rule: validateAliasRule,
};

/** 已有配置记录的 updatedAt 基线校验。 */
const CONFIG_TABLES: Record<string, string> = {
  org_form: 'org',
  account_form: 'account',
  metric_formula: 'report_metric',
  calculation_rule: 'budget_calculation_rule',
  cleaning_template: 'import_mapping_template',
  alias_rule: 'import_name_alias',
};

/**
 * 解析并校验草稿(§9.6)。只做白名单解析与基线/确定性校验，不写任何表。
 */
export function normalizeDraftInput(db: DB, draft: DraftDescriptor, options: { snapshotId?: string } = {}): NormalizedDraft {
  const { snapshotId } = options;
  if (draft.kind === 'budget_grid') return normalizeBudgetGrid(db, draft, snapshotId ?? '');
  if (draft.kind === 'actual_grid') return normalizeActualGrid(db, draft, snapshotId ?? '');

  const identity = parseIdentity(draft.base, snapshotId);
  const fields = parseConfigChanges(draft.kind, draft.changes, snapshotId);
  if (identity.targetId != null) {
    const table = CONFIG_TABLES[draft.kind];
    const row = db.prepare(`SELECT updated_at FROM ${table} WHERE id=?`).get(identity.targetId) as { updated_at: string } | undefined;
    requireFresh(identity.updatedAt, row?.updated_at, `${draft.kind} #${identity.targetId}`, snapshotId);
  }
  const issues = (CONFIG_VALIDATORS[draft.kind] ?? (() => []))(db, fields, identity.targetId);
  return {
    kind: draft.kind,
    changeCount: Object.keys(fields).length,
    baseline: identity.targetId != null ? `${draft.kind} #${identity.targetId} · ${identity.updatedAt ?? ''}` : `新建 ${draft.kind} · ${identity.clientKey}`,
    issues,
    config: { targetId: identity.targetId, clientKey: identity.clientKey, fields },
  };
}

/**
 * 持久化与日志允许的草稿摘要：类型 + 基线 + 变更数 + 校验问题数，不含任何原值。
 * baseline 是人类可读的基线描述(「版本 #3 · 修订 12」)，与 OpenAPI DraftAppliedSummary 契约一致。
 */
export function draftSummary(draft: NormalizedDraft): { kind: DraftKind; baseline: string; changeCount: number; issueCount: number } {
  return { kind: draft.kind, baseline: draft.baseline, changeCount: draft.changeCount, issueCount: draft.issues.length };
}

/* ============ 请求内草稿影响重算(§9.6：预算/实际草稿叠加基线重算) ============ */

export interface DraftImpactCell {
  orgId: number;
  accountId: number;
  accountCode?: string;
  accountName?: string;
  beforeCents: number;
  afterCents: number;
  deltaCents: number;
}

export interface DraftImpact {
  kind: 'budget_grid' | 'actual_grid';
  changeCount: number;
  baseline: string;
  /** 变更单元格的前后值(按 |delta| 降序，最多 50 条)。 */
  changedCells: DraftImpactCell[];
  /** 全部变更的带符号合计(利润方向，分)。 */
  totalDeltaCents: number;
  /** 受影响的科目节点子树合计变化(含父级，按 |delta| 降序，最多 20 条)。 */
  accountDeltas: { accountId: number; code: string; name: string; deltaCents: number }[];
  /** 受影响的线性指标(仅 budget_grid；按 |delta| 降序，最多 20 条)。 */
  metricDeltas: { metricId: number; code: string; name: string; beforeCents: number; afterCents: number; deltaCents: number }[];
  /** 数量变更(与金额完全隔离) */
  quantityChanges: { accountId: number; before: number | null; after: number | null }[];
}

/** 参与重算的最小单元格结构(budget/actual 草稿共用)。 */
interface OverlayCellInput extends OverlayCellBase { }

/**
 * 草稿影响重算：基线叠加 changes 后由 rollup 服务重算， diff 出单元格、科目与指标变化。
 * 全程只在请求内存中计算，不写数据库(§9.6)。
 */
export function computeDraftImpact(db: DB, draft: NormalizedDraft): DraftImpact | null {
  if (draft.kind === 'budget_grid' && draft.overlay?.budget) {
    const { versionId, entries } = draft.overlay.budget;
    const version = db.prepare('SELECT id, org_tree_snapshot_id, account_tree_snapshot_id FROM budget_version WHERE id=?').get(versionId) as
      { id: number; org_tree_snapshot_id: number; account_tree_snapshot_id: number } | undefined;
    if (!version) return null;
    const orgRows = loadSnapshotNodes(db, version.org_tree_snapshot_id);
    const accRows = loadSnapshotNodes(db, version.account_tree_snapshot_id);
    const metricDefinitions = listMetricsForVersion(db, versionId);
    const baseEntries = (db.prepare('SELECT org_id, account_id, amount_cents, quantity FROM budget_entry WHERE version_id=?').all(versionId) as
      { org_id: number; account_id: number; amount_cents: number; quantity: number | null }[])
      .map((r) => ({ orgId: r.org_id, accountId: r.account_id, amountCents: r.amount_cents, quantity: r.quantity }));
    return diffOverlay(draft, orgRows, accRows, baseEntries, entries.map((e) => ({ ...e })), metricDefinitions);
  }
  if (draft.kind === 'actual_grid' && draft.overlay?.actual) {
    const { year, entries } = draft.overlay.actual;
    const orgRows = listRows(db, 'org');
    const accRows = listRows(db, 'account');
    const baseEntries = (db.prepare('SELECT org_id, account_id, amount_cents, quantity FROM actual_current WHERE year=?').all(year) as
      { org_id: number; account_id: number; amount_cents: number; quantity: number | null }[])
      .map((r) => ({ orgId: r.org_id, accountId: r.account_id, amountCents: r.amount_cents, quantity: r.quantity }));
    return diffOverlay(draft, orgRows, accRows, baseEntries, entries.map((e) => ({ ...e })), []);
  }
  return null;
}

function diffOverlay(
  draft: NormalizedDraft,
  orgRows: TreeNodeRow[],
  accRows: TreeNodeRow[],
  baseEntries: { orgId: number; accountId: number; amountCents: number; quantity: number | null }[],
  changes: OverlayCellInput[],
  metricDefinitions: ReturnType<typeof listMetricsForVersion>,
): DraftImpact {
  // 基线索引：diff 阶段的所有 before 查询共用，避免逐变更线性扫描。
  const baseByCell = new Map(baseEntries.map((entry) => [`${entry.orgId}:${entry.accountId}`, entry]));
  const merged = new Map<string, { orgId: number; accountId: number; amountCents: number; quantity: number | null }>();
  for (const entry of baseEntries) merged.set(`${entry.orgId}:${entry.accountId}`, { ...entry });
  for (const change of changes) {
    const key = `${change.orgId}:${change.accountId}`;
    // 清空/置零格 = 整包替换语义下的删除：不提交该行，基线行随之消失。
    if (change.cleared) { merged.delete(key); continue; }
    // 其余草稿语义与整包保存一致：提供的单元格覆盖基线值。
    merged.set(key, {
      orgId: change.orgId, accountId: change.accountId, amountCents: change.amountCents, quantity: change.quantity,
    });
  }
  const baselineRoll = rollup(orgRows, accRows, baseEntries, metricDefinitions);
  const draftRoll = rollup(orgRows, accRows, [...merged.values()], metricDefinitions);

  const accById = new Map(accRows.map((row) => [row.id, row]));
  const changedCells: DraftImpactCell[] = changes.map((change) => {
    const before = baseByCell.get(`${change.orgId}:${change.accountId}`);
    const node = accById.get(change.accountId);
    return {
      orgId: change.orgId,
      accountId: change.accountId,
      ...(node ? { accountCode: node.code, accountName: node.name } : {}),
      beforeCents: before?.amountCents ?? 0,
      afterCents: change.cleared ? 0 : change.amountCents,
      deltaCents: (change.cleared ? 0 : change.amountCents) - (before?.amountCents ?? 0),
    };
  }).sort((a, b) => Math.abs(b.deltaCents) - Math.abs(a.deltaCents)).slice(0, 50);

  let totalDeltaCents = 0;
  for (const cell of changes) {
    const after = cell.cleared ? 0 : cell.amountCents;
    totalDeltaCents = safeAdd(totalDeltaCents, after - (baseByCell.get(`${cell.orgId}:${cell.accountId}`)?.amountCents ?? 0));
  }

  // 科目子树合计 diff:取组织树根节点行(其值已含全部后代组织),多根森林时跨根相加。
  // rollup.cell 以真实 orgId 为键、不存在虚拟 0 行，不能直接 cell.get(0)。
  const rootOrgIds = orgRows.filter((row) => row.parent_id == null).map((row) => row.id);
  const accountTotalAtRoots = (roll: RollupResult): Map<number, number> => {
    const totals = new Map<number, number>();
    for (const rootId of rootOrgIds) {
      const row = roll.cell.get(rootId);
      if (!row) continue;
      for (const [accountId, cents] of row) totals.set(accountId, (totals.get(accountId) ?? 0) + cents);
    }
    return totals;
  };
  const accountDeltas: DraftImpact['accountDeltas'] = [];
  const baselineCell = accountTotalAtRoots(baselineRoll);
  const draftCell = accountTotalAtRoots(draftRoll);
  for (const accountId of new Set([...baselineCell.keys(), ...draftCell.keys()])) {
    const delta = (draftCell.get(accountId) ?? 0) - (baselineCell.get(accountId) ?? 0);
    if (delta === 0) continue;
    const node = accById.get(accountId);
    if (!node) continue;
    accountDeltas.push({ accountId, code: node.code, name: node.name, deltaCents: delta });
  }
  accountDeltas.sort((a, b) => Math.abs(b.deltaCents) - Math.abs(a.deltaCents));

  const metricDeltas: DraftImpact['metricDeltas'] = [];
  for (const metric of metricDefinitions) {
    if (metric.kind === 'ratio') continue;
    const before = baselineRoll.metrics.get(metric.id) ?? 0;
    const after = draftRoll.metrics.get(metric.id) ?? 0;
    if (after === before) continue;
    metricDeltas.push({ metricId: metric.id, code: metric.code, name: metric.name, beforeCents: before, afterCents: after, deltaCents: after - before });
  }
  metricDeltas.sort((a, b) => Math.abs(b.deltaCents) - Math.abs(a.deltaCents));

  const quantityChanges = changes
    .filter((change) => change.quantity != null || change.cleared)
    .map((change) => ({
      accountId: change.accountId,
      before: baseByCell.get(`${change.orgId}:${change.accountId}`)?.quantity ?? null,
      after: change.cleared ? null : change.quantity,
    }));

  return {
    kind: draft.kind as 'budget_grid' | 'actual_grid',
    changeCount: draft.changeCount,
    baseline: draft.baseline,
    changedCells,
    totalDeltaCents,
    accountDeltas: accountDeltas.slice(0, 20),
    metricDeltas: metricDeltas.slice(0, 20),
    quantityChanges: quantityChanges.slice(0, 50),
  };
}

function safeAdd(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new AppError('VALIDATION_FAILED', '草稿影响汇总超出安全整数范围', 400);
  return result;
}
