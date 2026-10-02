import { validateDomainContext, domainBatchContext } from './domain-context';
import { DOMAIN_ID_FIELDS, DOMAIN_ENTITY_FIELDS, normalizeDomainContext, type DomainContext } from './domain-scope';
/**
 * AssistantPageContextV2 后端解析入口(现行 specs/ai.md 页面上下文契约§5、§9.1)。
 *
 * 浏览器输入不可信(§3.4)：前端传入的 ID、级别、金额、图表值和核验结果都只是定位线索。
 * 本模块在调用任何业务工具之前完成四件事：
 *   1. 校验 V2 schema、pageKey、请求大小和页面 view 白名单；
 *   2. 查询数据库验证版本、快照、组织、科目、指标及其他资源 ID；
 *   3. 验证 surface、focus 和 selection 是否属于页面范围；
 *   4. 按 §6 优先级把 surface > focus > 页面 scope 合并成统一的页面取数范围。
 *
 * 失败时不扩大范围(§3.7)：任何校验失败都以 CONTEXT_* 错误拒绝，绝不静默退回全集团或首页。
 */
import { AppError, Errors } from '../core/errors';
import type { DB } from '../db/connection';
import { insightRowsFilter } from './ownership';
import type { AssistantContext } from './schemas';
import { PAGE_CATALOG, pageDefinition } from '../contracts/page-catalog';
import { type DomainCapability, type DraftKind, type PageDefinition as PageCapability } from '../contracts/page-catalog';

import { normalizeDraftInput, type DraftDescriptor, type NormalizedDraft } from './draft-context';

export type { DraftDescriptor, NormalizedDraft } from './draft-context';

/* ============ 错误码(§11)：不为每个组件或资源类型创造独立错误码 ============ */

export type ContextErrorCode =
  | 'CONTEXT_INVALID'
  | 'CONTEXT_NOT_READY'
  | 'CONTEXT_STALE'
  | 'CONTEXT_CONFLICT'
  | 'CONTEXT_TOO_LARGE'
  | 'DRAFT_STALE'
  | 'CAPABILITY_UNAVAILABLE';

const CONTEXT_ERROR_STATUS: Record<ContextErrorCode, number> = {
  CONTEXT_INVALID: 400,
  CONTEXT_NOT_READY: 409,
  CONTEXT_STALE: 409,
  CONTEXT_CONFLICT: 409,
  CONTEXT_TOO_LARGE: 413,
  DRAFT_STALE: 409,
  CAPABILITY_UNAVAILABLE: 400,
};

export function contextError(code: ContextErrorCode, message: string, details?: { snapshotId?: string; field?: string; reason?: string }): AppError {
  return new AppError(code, message, CONTEXT_ERROR_STATUS[code], undefined, details);
}

export function capabilityUnavailable(message: string): AppError {
  return contextError('CAPABILITY_UNAVAILABLE', message);
}

/* ============ 大小与数量限制(§5.8) ============ */

/** 常规上下文最大 64 KiB。 */
export const CONTEXT_MAX_BYTES = 64 * 1024;
/** 带草稿请求中草稿部分最大 5 MiB。 */
export const DRAFT_MAX_BYTES = 5 * 1024 * 1024;
/** 草稿最多 10000 项变更。 */
export const DRAFT_MAX_CHANGES = 10_000;
/** refs 选区最多 500 个稳定业务引用；超过必须用 bounds 或 query。 */
export const SELECTION_MAX_REFS = 500;

/* ============ V2 类型(§5) ============ */

export interface PageScope extends DomainContext {
  year?: number;
  periodStart?: string;
  periodEnd?: string;
  asOfDate?: string;
  budgetVersionId?: number;
  targetVersionId?: number;
  actualSnapshotId?: number;
  importBatchId?: number;
  orgScopeId?: number;
  accountScopeId?: number;
  metricId?: number;
  insightId?: number;
  conversionId?: number;
  mappingVersionId?: number;
  templateId?: number;
  baseVersionId?: number;
  compareVersionId?: number;
}

export type SurfaceKind = 'drawer' | 'modal' | 'popover' | 'context_menu';

export interface SurfaceEntityRef {
  entityType: string;
  id: number;
}

export interface SurfaceDescriptor {
  id: string;
  kind: SurfaceKind;
  key: string;
  entity?: SurfaceEntityRef | null;
  parentId?: string | null;
}

export type FocusDescriptor =
  | { kind: 'entity'; entityType: string; id: number }
  | { kind: 'cell'; source: 'budget' | 'actual'; sourceId: number; orgId: number; accountId: number; valueKind?: 'amount' | 'quantity' | 'formula' | 'note' }
  | { kind: 'chart_point'; seriesKey: string; dimensionType: 'org' | 'account' | 'metric' | 'period' | 'version'; dimensionId?: number; period?: string }
  | { kind: 'fact'; factType: 'verification'; ownerKey: string; factKey: string; scopeRef?: Record<string, number | string> }
  | { kind: 'form_field'; formKind: string; field: string };

export type SelectionDescriptor =
  | { mode: 'refs'; refs: SurfaceEntityRef[] }
  | { mode: 'bounds'; bounds: { sheetKey?: string; orgIds?: number[]; accountIds?: number[] } }
  | { mode: 'query'; query: Record<string, string | number | boolean | null> };

export interface AssistantPageContextV2 {
  schemaVersion: 2;
  snapshotId: string;
  pageKey: string;
  routeInstanceId: string;
  contextVersion: number;
  scope?: PageScope;
  view?: Record<string, unknown>;
  surfaces?: SurfaceDescriptor[];
  focus?: FocusDescriptor | null;
  selection?: SelectionDescriptor | null;
  draft?: DraftDescriptor | null;
}

/* ============ schema 校验 ============ */

const SURFACE_KINDS: ReadonlySet<string> = new Set(['drawer', 'modal', 'popover', 'context_menu']);
const SCOPE_INT_FIELDS: (keyof PageScope)[] = [
  'budgetVersionId', 'targetVersionId', 'actualSnapshotId', 'importBatchId',
  'orgScopeId', 'accountScopeId', 'metricId', 'insightId', 'conversionId', 'mappingVersionId', 'templateId',
  'baseVersionId', 'compareVersionId', ...DOMAIN_ID_FIELDS,
];
const SCOPE_TEXT_FIELDS = ['period', 'periodFrom', 'periodTo', 'statementScope'];
const SCOPE_DATE_FIELDS: (keyof PageScope)[] = ['periodStart', 'periodEnd', 'asOfDate'];
const DRAFT_KINDS: ReadonlySet<string> = new Set([
  'budget_grid', 'actual_grid', 'org_form', 'account_form', 'metric_formula', 'calculation_rule', 'cleaning_template', 'alias_rule',
]);

function fail(message: string, field?: string, snapshotId?: string): never {
  throw contextError('CONTEXT_INVALID', message, { field, snapshotId, reason: message });
}

function safeId(value: unknown, field: string, snapshotId?: string): number {
  if (typeof value !== 'number' && typeof value !== 'string') fail(`${field} 必须是正整数`, field, snapshotId);
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) fail(`${field} 必须是正整数`, field, snapshotId);
  return n;
}

function shortText(value: unknown, field: string, max: number, snapshotId?: string): string {
  if (typeof value !== 'string') fail(`${field} 必须是字符串`, field, snapshotId);
  const text = value.trim();
  if (!text || text.length > max) fail(`${field} 长度必须为 1-${max}`, field, snapshotId);
  return text;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function byteLength(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value) ?? '', 'utf8');
}

function parseView(raw: unknown, page: PageCapability, snapshotId: string): Record<string, unknown> {
  if (raw == null) return {};
  if (!isPlainObject(raw)) fail('view 必须是对象', 'view', snapshotId);
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!page.viewFields.includes(key)) {
      throw contextError('CONTEXT_INVALID', `页面 ${page.label} 不接受 view 字段「${key}」`, { field: `view.${key}`, snapshotId, reason: 'view 字段不在页面白名单内' });
    }
    if (value == null) continue;
    const valueOk = typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean'
      || (Array.isArray(value) && value.every((item) => ['string', 'number', 'boolean'].includes(typeof item)));
    if (!valueOk) fail(`view.${key} 只允许字符串、数字、布尔或其数组`, `view.${key}`, snapshotId);
    if (typeof value === 'string' && value.length > 200) fail(`view.${key} 过长`, `view.${key}`, snapshotId);
    if (Array.isArray(value) && value.length > 100) fail(`view.${key} 数组过长`, `view.${key}`, snapshotId);
    out[key] = value;
  }
  return out;
}

function parseEntityRef(raw: unknown, page: PageCapability, field: string, snapshotId: string): SurfaceEntityRef {
  if (!isPlainObject(raw)) fail(`${field} 必须是对象`, field, snapshotId);
  const entityType = typeof raw.entityType === 'string' ? raw.entityType.trim() : '';
  if (!entityType || entityType.length > 40) fail(`${field}.entityType 必须是 1-40 字符`, `${field}.entityType`, snapshotId);
  if (!page.entityTypes.includes(entityType as never)) {
    throw contextError('CONTEXT_INVALID', `页面 ${page.label} 不接受 entity 类型「${entityType}」`, { field: `${field}.entityType`, snapshotId, reason: 'entity 类型不在页面白名单内' });
  }
  return { entityType, id: safeId(raw.id, `${field}.id`, snapshotId) };
}

function parseSurfaces(raw: unknown, page: PageCapability, snapshotId: string): SurfaceDescriptor[] {
  if (raw == null) return [];
  if (!Array.isArray(raw)) fail('surfaces 必须是数组', 'surfaces', snapshotId);
  if (raw.length > 20) fail('surfaces 最多 20 层', 'surfaces', snapshotId);
  const seen = new Set<string>();
  return raw.map((item, index) => {
    if (!isPlainObject(item)) fail(`surfaces[${index}] 必须是对象`, 'surfaces', snapshotId);
    const id = shortText(item.id, `surfaces[${index}].id`, 80, snapshotId);
    if (seen.has(id)) fail(`surfaces[${index}].id 重复`, 'surfaces', snapshotId);
    seen.add(id);
    const kind = String(item.kind ?? '');
    if (!SURFACE_KINDS.has(kind)) fail(`surfaces[${index}].kind 必须是 drawer/modal/popover/context_menu`, `surfaces[${index}].kind`, snapshotId);
    const key = shortText(item.key, `surfaces[${index}].key`, 80, snapshotId);
    const parentId = item.parentId == null ? null : shortText(item.parentId, `surfaces[${index}].parentId`, 80, snapshotId);
    if (parentId != null && !seen.has(parentId)) {
      fail(`surfaces[${index}].parentId 指向不存在或更晚打开的浮层`, `surfaces[${index}].parentId`, snapshotId);
    }
    const entity = item.entity == null ? null : parseEntityRef(item.entity, page, `surfaces[${index}].entity`, snapshotId);
    return { id, kind: kind as SurfaceKind, key, entity, parentId };
  });
}

/** 核验 fact 的 ownerKey → 允许的 factKey(§9.5)。 */
const VERIFICATION_FACT_KEYS: Record<string, string[]> = {
  'analysis:root': ['actual_none', 'reconciliation', 'unbudgeted', 'overspend', 'lagging'],
  'structure:root': ['actual_none', 'reconciliation', 'subtotal', 'unbudgeted'],
};

/** ownerKey 前缀 → 允许出现的页面。 */
const VERIFICATION_OWNER_PAGES: Record<string, string[]> = {
  analysis: ['analysis', 'dashboard'],
  structure: ['structure'],
  evidence: ['analysis', 'structure', 'dashboard', 'version_compare', 'budget_edit', 'actual', 'metric_trend'],
};

function parseFocus(raw: unknown, page: PageCapability, pageKey: string, snapshotId: string): FocusDescriptor | null {
  if (raw == null) return null;
  if (!isPlainObject(raw)) fail('focus 必须是对象', 'focus', snapshotId);
  const kind = String(raw.kind ?? '');
  switch (kind) {
    case 'entity': {
      const ref = parseEntityRef(raw, page, 'focus', snapshotId);
      return { kind: 'entity', entityType: ref.entityType, id: ref.id };
    }
    case 'cell': {
      const source = raw.source === 'budget' || raw.source === 'actual' ? raw.source : null;
      if (!source) fail('focus.cell.source 必须是 budget 或 actual', 'focus.source', snapshotId);
      const valueKind = raw.valueKind == null ? undefined : String(raw.valueKind);
      if (valueKind != null && !['amount', 'quantity', 'formula', 'note'].includes(valueKind)) fail('focus.cell.valueKind 不合法', 'focus.valueKind', snapshotId);
      return {
        kind: 'cell', source, sourceId: safeId(raw.sourceId, 'focus.sourceId', snapshotId),
        orgId: safeId(raw.orgId, 'focus.orgId', snapshotId), accountId: safeId(raw.accountId, 'focus.accountId', snapshotId),
        ...(valueKind ? { valueKind: valueKind as 'amount' | 'quantity' | 'formula' | 'note' } : {}),
      };
    }
    case 'chart_point': {
      const seriesKey = shortText(raw.seriesKey, 'focus.seriesKey', 120, snapshotId);
      const dimensionType = String(raw.dimensionType ?? '');
      if (!['org', 'account', 'metric', 'period', 'version'].includes(dimensionType)) fail('focus.chart_point.dimensionType 不合法', 'focus.dimensionType', snapshotId);
      const period = raw.period == null ? undefined : shortText(raw.period, 'focus.period', 20, snapshotId);
      return {
        kind: 'chart_point', seriesKey, dimensionType: dimensionType as 'org' | 'account' | 'metric' | 'period' | 'version',
        ...(raw.dimensionId == null ? {} : { dimensionId: safeId(raw.dimensionId, 'focus.dimensionId', snapshotId) }),
        ...(period ? { period } : {}),
      };
    }
    case 'fact': {
      const factType = String(raw.factType ?? '');
      if (!page.factTypes.includes(factType)) {
        throw contextError('CONTEXT_INVALID', `页面 ${page.label} 不接受 fact 类型「${factType}」`, { field: 'focus.factType', snapshotId, reason: 'fact 类型不在页面白名单内' });
      }
      const ownerKey = shortText(raw.ownerKey, 'focus.ownerKey', 160, snapshotId);
      const factKey = shortText(raw.factKey, 'focus.factKey', 60, snapshotId);
      const ownerRoot = ownerKey.split(':')[0];
      const allowedPages = VERIFICATION_OWNER_PAGES[ownerRoot];
      if (!allowedPages) fail(`未知核验归属「${ownerKey}」`, 'focus.ownerKey', snapshotId);
      if (!allowedPages.includes(pageKey)) {
        throw contextError('CONTEXT_STALE', `核验项「${ownerKey}」不属于当前页面`, { field: 'focus.ownerKey', snapshotId, reason: '焦点所属页面与当前 pageKey 不一致' });
      }
      if (ownerRoot === 'evidence') {
        const parts = ownerKey.split(':');
        if (parts.length !== 4 || parts[1] !== 'metric' || !/^\d+$/.test(parts[2]) || !/^\d+$/.test(parts[3])) {
          fail('evidence ownerKey 必须是 evidence:metric:版本ID:指标ID', 'focus.ownerKey', snapshotId);
        }
        if (!['coverage', 'coverage_unbudgeted'].includes(factKey)) fail(`未知核验项「${factKey}」`, 'focus.factKey', snapshotId);
      } else {
        const allowedKeys = VERIFICATION_FACT_KEYS[ownerKey];
        if (!allowedKeys || !allowedKeys.includes(factKey)) fail(`未知核验项「${ownerKey} / ${factKey}」`, 'focus.factKey', snapshotId);
      }
      return { kind: 'fact', factType: 'verification', ownerKey, factKey };
    }
    case 'form_field': {
      return {
        kind: 'form_field',
        formKind: shortText(raw.formKind, 'focus.formKind', 60, snapshotId),
        field: shortText(raw.field, 'focus.field', 80, snapshotId),
      };
    }
    default:
      return fail(`focus.kind「${kind}」不合法`, 'focus.kind', snapshotId);
  }
}

function parseSelection(raw: unknown, page: PageCapability, snapshotId: string): SelectionDescriptor | null {
  if (raw == null) return null;
  if (!isPlainObject(raw)) fail('selection 必须是对象', 'selection', snapshotId);
  const mode = String(raw.mode ?? '');
  if (mode === 'refs') {
    if (!Array.isArray(raw.refs)) fail('selection.refs 必须是数组', 'selection.refs', snapshotId);
    // 超过 500 项必须使用 bounds 或 query：截断后声称覆盖全部是不诚实回答(§5.6)。
    if (raw.refs.length > SELECTION_MAX_REFS) {
      throw contextError('CONTEXT_TOO_LARGE', `选区引用超过 ${SELECTION_MAX_REFS} 项，请改用 bounds 或 query 表达`, { field: 'selection.refs', snapshotId, reason: 'refs 选区超上限' });
    }
    return { mode: 'refs', refs: raw.refs.map((item, index) => parseEntityRef(item, page, `selection.refs[${index}]`, snapshotId)) };
  }
  if (mode === 'bounds') {
    if (!isPlainObject(raw.bounds)) fail('selection.bounds 必须是对象', 'selection.bounds', snapshotId);
    const idList = (value: unknown, field: string): number[] | undefined => {
      if (value == null) return undefined;
      if (!Array.isArray(value)) fail(`${field} 必须是数组`, field, snapshotId);
      if (value.length > 2000) throw contextError('CONTEXT_TOO_LARGE', `${field} 超过 2000 项`, { field, snapshotId });
      return value.map((item, index) => safeId(item, `${field}[${index}]`, snapshotId));
    };
    const sheetKey = raw.bounds.sheetKey == null ? undefined : shortText(raw.bounds.sheetKey, 'selection.bounds.sheetKey', 60, snapshotId);
    return { mode: 'bounds', bounds: { ...(sheetKey ? { sheetKey } : {}), ...(idList(raw.bounds.orgIds, 'selection.bounds.orgIds') ? { orgIds: idList(raw.bounds.orgIds, 'selection.bounds.orgIds')! } : {}), ...(idList(raw.bounds.accountIds, 'selection.bounds.accountIds') ? { accountIds: idList(raw.bounds.accountIds, 'selection.bounds.accountIds')! } : {}) } };
  }
  if (mode === 'query') {
    if (!isPlainObject(raw.query)) fail('selection.query 必须是对象', 'selection.query', snapshotId);
    const out: Record<string, string | number | boolean | null> = {};
    for (const [key, value] of Object.entries(raw.query)) {
      if (key.length > 60) fail('selection.query 键过长', 'selection.query', snapshotId);
      if (value != null && !['string', 'number', 'boolean'].includes(typeof value)) fail(`selection.query.${key} 类型不支持`, `selection.query.${key}`, snapshotId);
      if (typeof value === 'string' && value.length > 200) fail(`selection.query.${key} 过长`, `selection.query.${key}`, snapshotId);
      out[key] = value as string | number | boolean | null;
    }
    return { mode: 'query', query: out };
  }
  return fail(`selection.mode「${mode}」不合法`, 'selection.mode', snapshotId);
}

function parseScope(raw: unknown, snapshotId: string): PageScope {
  if (raw == null) return {};
  if (!isPlainObject(raw)) fail('scope 必须是对象', 'scope', snapshotId);
  let out: PageScope;
  try { out = normalizeDomainContext(raw); } catch (error) { throw new AppError('CONTEXT_INVALID', error instanceof Error ? error.message : '业务范围无效', 400); }
  for (const key of Object.keys(raw)) {
    if (![...SCOPE_INT_FIELDS, ...SCOPE_DATE_FIELDS, ...SCOPE_TEXT_FIELDS, 'year'].includes(key as keyof PageScope)) {
      fail(`scope 不支持字段「${key}」`, `scope.${key}`, snapshotId);
    }
  }
  if (raw.year != null) {
    const year = Number(raw.year);
    if (!Number.isSafeInteger(year) || year < 1900 || year > 9999) fail('scope.year 必须是 1900-9999 的整数', 'scope.year', snapshotId);
    out.year = year;
  }
  for (const field of SCOPE_INT_FIELDS) {
    if (raw[field] != null) (out as Record<string, unknown>)[field] = safeId(raw[field], `scope.${field}`, snapshotId);
  }
  for (const field of SCOPE_DATE_FIELDS) {
    if (raw[field] != null) {
      const text = String(raw[field]);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(text)) fail(`scope.${field} 必须是 YYYY-MM-DD`, `scope.${field}`, snapshotId);
      (out as Record<string, unknown>)[field] = text;
    }
  }
  return out;
}

/**
 * 解析并校验 V2 schema(§9.1 第 1 步)。只做强格式校验与白名单校验，不查库。
 */
export function parsePageContextV2(raw: unknown): AssistantPageContextV2 | null {
  if (raw == null) return null;
  if (!isPlainObject(raw)) throw contextError('CONTEXT_INVALID', 'pageContext 必须是对象');
  if (raw.schemaVersion !== 2) throw contextError('CONTEXT_INVALID', 'pageContext.schemaVersion 必须为 2', { field: 'schemaVersion' });
  const snapshotId = typeof raw.snapshotId === 'string' ? raw.snapshotId.trim() : '';
  if (!snapshotId || snapshotId.length > 80) throw contextError('CONTEXT_INVALID', 'pageContext.snapshotId 必须是 1-80 字符', { field: 'snapshotId' });
  const pageKey = typeof raw.pageKey === 'string' ? raw.pageKey.trim() : '';
  const page = pageDefinition(pageKey);
  // 未知 pageKey 不回退 dashboard(§9.4)。
  if (!page) throw contextError('CONTEXT_INVALID', `未知页面「${pageKey}」`, { field: 'pageKey', snapshotId, reason: 'pageKey 不在 PageCapabilityMap 内' });
  const routeInstanceId = typeof raw.routeInstanceId === 'string' ? raw.routeInstanceId.trim() : '';
  if (!routeInstanceId || routeInstanceId.length > 80) throw contextError('CONTEXT_INVALID', 'pageContext.routeInstanceId 必须是 1-80 字符', { field: 'routeInstanceId', snapshotId });
  const contextVersion = Number(raw.contextVersion);
  if (!Number.isSafeInteger(contextVersion) || contextVersion < 0) throw contextError('CONTEXT_INVALID', 'pageContext.contextVersion 必须是非负整数', { field: 'contextVersion', snapshotId });

  const { draft: rawDraft, ...rest } = raw;
  // §5.8：常规上下文与草稿分开限量，超限提示用户先保存或缩小范围，不静默丢弃。
  if (byteLength(rest) > CONTEXT_MAX_BYTES) {
    throw contextError('CONTEXT_TOO_LARGE', `页面上下文超过 ${Math.round(CONTEXT_MAX_BYTES / 1024)} KiB，请缩小范围`, { snapshotId, reason: '上下文超过大小限制' });
  }
  if (rawDraft != null && byteLength(rawDraft) > DRAFT_MAX_BYTES) {
    throw contextError('CONTEXT_TOO_LARGE', `草稿超过 ${Math.round(DRAFT_MAX_BYTES / 1024 / 1024)} MiB，请先保存或缩小范围`, { field: 'draft', snapshotId, reason: '草稿超过大小限制' });
  }

  const scope = parseScope(raw.scope, snapshotId);
  const view = parseView(raw.view, page, snapshotId);
  const surfaces = parseSurfaces(raw.surfaces, page, snapshotId);
  const focus = parseFocus(raw.focus, page, pageKey, snapshotId);
  const selection = parseSelection(raw.selection, page, snapshotId);

  let draft: DraftDescriptor | null = null;
  if (rawDraft != null) {
    if (!isPlainObject(rawDraft)) fail('draft 必须是对象', 'draft', snapshotId);
    const kind = String(rawDraft.kind ?? '');
    if (!DRAFT_KINDS.has(kind)) fail(`draft.kind「${kind}」不合法`, 'draft.kind', snapshotId);
    if (!page.draftKinds.includes(kind as DraftKind)) {
      throw contextError('CONTEXT_INVALID', `页面 ${page.label} 不接受「${kind}」类型的草稿`, { field: 'draft.kind', snapshotId, reason: '草稿类型不在页面白名单内' });
    }
    if (!isPlainObject(rawDraft.base)) fail('draft.base 必须是对象', 'draft.base', snapshotId);
    if (rawDraft.changes == null) fail('draft.changes 不能为空', 'draft.changes', snapshotId);
    const changeCount = Array.isArray(rawDraft.changes) ? rawDraft.changes.length : Object.keys(rawDraft.changes as object).length;
    if (changeCount > DRAFT_MAX_CHANGES) {
      throw contextError('CONTEXT_TOO_LARGE', `草稿变更超过 ${DRAFT_MAX_CHANGES} 项，请先保存`, { field: 'draft.changes', snapshotId });
    }
    draft = { kind: kind as DraftKind, base: rawDraft.base, changes: rawDraft.changes };
  }

  return {
    schemaVersion: 2, snapshotId, pageKey, routeInstanceId, contextVersion,
    scope, view, surfaces, focus, selection, draft,
  };
}

/* ============ 资源与关系校验(§9.1 第 2、3 步) ============ */

function exists(db: DB, sql: string, id: number, extra: unknown[] = []): boolean {
  try {
    return Boolean(db.prepare(sql).get(id, ...extra));
  } catch {
    // 表不存在(如未启用财务转换的旧库)时按不存在处理。
    return false;
  }
}

function rowOf<T>(db: DB, sql: string, value: string | number): T | null {
  try {
    return (db.prepare(sql).get(value) as T | undefined) ?? null;
  } catch {
    return null;
  }
}

/** 资源 ID → 存在性校验；不存在时报 CONTEXT_INVALID 并指出字段名。 */
function requireResource(db: DB, field: string, snapshotId: string, sql: string, id: number, label: string, extra: unknown[] = []): void {
  if (!exists(db, sql, id, extra)) {
    throw contextError('CONTEXT_INVALID', `${label} #${id} 不存在`, { field, snapshotId, reason: '客户端传入的业务 ID 未通过数据库核验' });
  }
}

/** 洞察按归属可见:他人的洞察与不存在同样处理(AC-X04)。 */
function requireInsight(db: DB, field: string, snapshotId: string, id: number): void {
  const owner = insightRowsFilter();
  requireResource(db, field, snapshotId, `SELECT id FROM ai_insight WHERE id=? AND ${owner.sql}`, id, '洞察报告', owner.params);
}

/** 树关系校验：组织/科目必须在版本绑定的树快照里(§9.1「验证版本、快照、组织、科目、指标及页面资源关系」)。 */
function requireInTreeSnapshot(db: DB, snapshotIdColumn: 'org_tree_snapshot_id' | 'account_tree_snapshot_id', versionId: number, nodeId: number, field: string, snapshotUuid: string): void {
  const version = rowOf<{ org_tree_snapshot_id: number; account_tree_snapshot_id: number }>(db, 'SELECT org_tree_snapshot_id, account_tree_snapshot_id FROM budget_version WHERE id=?', versionId);
  if (!version) return;
  const treeId = version[snapshotIdColumn];
  const tree = rowOf<{ content_json: string }>(db, 'SELECT content_json FROM tree_snapshot WHERE id=?', treeId);
  if (!tree) return;
  try {
    // content_json 是整棵树的序列化；节点 ID 以 "id":N 形式出现。
    if (!new RegExp(`"id"\\s*:\\s*${nodeId}(?![\\d])`).test(tree.content_json)) {
      throw contextError('CONTEXT_CONFLICT', `${field === 'orgScopeId' ? '组织' : '科目'} #${nodeId} 不在版本 #${versionId} 绑定的树快照中`, { field, snapshotId: snapshotUuid, reason: '树关系与版本绑定快照不一致' });
    }
  } catch (err) {
    if (err instanceof AppError) throw err;
  }
}

/** entity 类型 → scope 字段(§6：surface > focus > 页面 scope)。 */
const ENTITY_SCOPE_FIELD: Record<string, keyof PageScope> = {
  ...DOMAIN_ENTITY_FIELDS,
  org: 'orgScopeId',
  account: 'accountScopeId',
  metric: 'metricId',
  budget_version: 'budgetVersionId',
  actual_snapshot: 'actualSnapshotId',
  import_batch: 'importBatchId',
  insight: 'insightId',
  conversion: 'conversionId',
  mapping_version: 'mappingVersionId',
  cleaning_template: 'templateId',
};

function validateEntityExists(db: DB, entityType: string, id: number, field: string, snapshotId: string): void {
  const domainField = DOMAIN_ENTITY_FIELDS[entityType];
  if (domainField) { validateDomainContext(db, { [domainField]: id }); return; }
  switch (entityType) {
    case 'org': return requireResource(db, field, snapshotId, 'SELECT id FROM org WHERE id=?', id, '组织');
    case 'account': return requireResource(db, field, snapshotId, 'SELECT id FROM account WHERE id=?', id, '科目');
    case 'metric': return requireResource(db, field, snapshotId, 'SELECT id FROM report_metric WHERE id=?', id, '指标');
    case 'budget_version': return requireResource(db, field, snapshotId, 'SELECT id FROM budget_version WHERE id=?', id, '预算版本');
    case 'actual_snapshot': return requireResource(db, field, snapshotId, 'SELECT id FROM actual_snapshot_batch WHERE id=?', id, '实际快照');
    case 'import_batch': return requireResource(db, field, snapshotId, 'SELECT id FROM import_batch WHERE id=?', id, '导入批次');
    case 'insight': return requireInsight(db, field, snapshotId, id);
    case 'conversion': return requireResource(db, field, snapshotId, 'SELECT id FROM finance_conversion_batch WHERE id=?', id, '财务转换批次');
    case 'mapping_version': return requireResource(db, field, snapshotId, 'SELECT id FROM finance_mapping_version WHERE id=?', id, '财务映射版本');
    case 'cleaning_template': return requireResource(db, field, snapshotId, 'SELECT id FROM import_mapping_template WHERE id=?', id, '清洗模板');
    case 'calculation_rule': return requireResource(db, field, snapshotId, 'SELECT id FROM budget_calculation_rule WHERE id=?', id, '测算规则');
    case 'log_entry': return requireResource(db, field, snapshotId, 'SELECT id FROM operation_log WHERE id=?', id, '操作日志');
    default:
      // row/tree_node/card/anomaly 等通用定位类型没有专属表，跟随页面 scope 校验即可。
      return;
  }
}

export interface ResolvedBackendContext {
  pageKey: string;
  pageLabel: string;
  capabilities: DomainCapability[];
  defaultCapability: DomainCapability;
  /** 合并后的页面取数范围(已映射到既有 AssistantContext 字段)，surface > focus > scope。 */
  pageContext: AssistantContext;
  /** 旧 context 表达不了的扩展范围字段。 */
  extras: Pick<PageScope, 'metricId' | 'insightId' | 'conversionId' | 'mappingVersionId' | 'templateId' | 'baseVersionId' | 'compareVersionId' | 'periodStart' | 'periodEnd' | 'asOfDate'>;
  view: Record<string, unknown>;
  focus: FocusDescriptor | null;
  selection: SelectionDescriptor | null;
  surfaces: SurfaceDescriptor[];
  warnings: string[];
  draft: NormalizedDraft | null;
  snapshotId: string;
}

/**
 * 统一解析入口(§9.1)：chat、chat/stream、attribution、report、import-help 共用。
 *
 * 返回的 pageContext 已按 §6 优先级合并 surface > focus > 页面 scope，
 * 之后由 resolveMessageContext 叠加「问题明确指定的范围」与「会话继承补齐」。
 */
export function resolveBackendContext(db: DB, raw: unknown): ResolvedBackendContext | null {
  const parsed = parsePageContextV2(raw);
  if (!parsed) return null;
  const page = pageDefinition(parsed.pageKey)!;
  const { snapshotId } = parsed;
  const scope = parsed.scope ?? {};
  const warnings: string[] = [];

  /* ---- 资源存在性与年度/版本/快照一致性 ---- */
  const versionRow = (id: number, field: string) => {
    const row = rowOf<{ id: number; year: number; name: string }>(db, 'SELECT id,year,name FROM budget_version WHERE id=?', id);
    if (!row) throw contextError('CONTEXT_INVALID', `预算版本 #${id} 不存在`, { field, snapshotId, reason: '客户端传入的版本 ID 未通过数据库核验' });
    return row;
  };
  if (scope.budgetVersionId != null) {
    const row = versionRow(scope.budgetVersionId, 'budgetVersionId');
    if (scope.year != null && row.year !== scope.year) {
      throw contextError('CONTEXT_CONFLICT', `页面年度 ${scope.year} 与预算版本「${row.name}」(${row.year} 年)不一致`, { field: 'budgetVersionId', snapshotId, reason: '年度与版本年度冲突' });
    }
  }
  for (const field of ['targetVersionId', 'baseVersionId', 'compareVersionId'] as const) {
    if (scope[field] != null) versionRow(scope[field]!, field);
  }
  if ((scope.baseVersionId == null) !== (scope.compareVersionId == null)) {
    throw contextError('CONTEXT_CONFLICT', '版本对比页必须同时提供基准版本与目标版本', { field: 'baseVersionId', snapshotId, reason: '版本对比范围不完整' });
  }
  if (scope.baseVersionId != null && scope.compareVersionId != null) {
    const base = versionRow(scope.baseVersionId, 'baseVersionId');
    const compare = versionRow(scope.compareVersionId, 'compareVersionId');
    if (base.year !== compare.year) {
      throw contextError('CONTEXT_CONFLICT', `基准版本「${base.name}」与目标版本「${compare.name}」不属于同一年度`, { field: 'compareVersionId', snapshotId, reason: '版本对比仅支持同年度版本' });
    }
    if (scope.year != null && scope.year !== base.year) {
      throw contextError('CONTEXT_CONFLICT', `页面年度 ${scope.year} 与对比版本年度 ${base.year} 不一致`, { field: 'year', snapshotId, reason: '年度与版本对比范围冲突' });
    }
  }
  if (scope.actualSnapshotId != null) {
    const batch = rowOf<{ id: number; year: number }>(db, 'SELECT id,year FROM actual_snapshot_batch WHERE id=?', scope.actualSnapshotId);
    if (!batch) throw contextError('CONTEXT_INVALID', `实际快照 #${scope.actualSnapshotId} 不存在`, { field: 'actualSnapshotId', snapshotId });
    if (scope.year != null && batch.year !== scope.year) {
      throw contextError('CONTEXT_CONFLICT', `页面年度 ${scope.year} 与实际快照 #${scope.actualSnapshotId}(${batch.year} 年)不一致`, { field: 'actualSnapshotId', snapshotId, reason: '年度与快照年度冲突' });
    }
  }
  if (scope.importBatchId != null) requireResource(db, 'importBatchId', snapshotId, 'SELECT id FROM import_batch WHERE id=?', scope.importBatchId, '导入批次');
  if (scope.metricId != null) requireResource(db, 'metricId', snapshotId, 'SELECT id FROM report_metric WHERE id=?', scope.metricId, '指标');
  if (scope.insightId != null) requireInsight(db, 'insightId', snapshotId, scope.insightId);
  if (scope.conversionId != null) requireResource(db, 'conversionId', snapshotId, 'SELECT id FROM finance_conversion_batch WHERE id=?', scope.conversionId, '财务转换批次');
  if (scope.mappingVersionId != null) requireResource(db, 'mappingVersionId', snapshotId, 'SELECT id FROM finance_mapping_version WHERE id=?', scope.mappingVersionId, '财务映射版本');
  if (scope.templateId != null) requireResource(db, 'templateId', snapshotId, 'SELECT id FROM import_mapping_template WHERE id=?', scope.templateId, '清洗模板');
  if (scope.orgScopeId != null) {
    requireResource(db, 'orgScopeId', snapshotId, 'SELECT id FROM org WHERE id=?', scope.orgScopeId, '组织');
    if (scope.budgetVersionId != null) requireInTreeSnapshot(db, 'org_tree_snapshot_id', scope.budgetVersionId, scope.orgScopeId, 'orgScopeId', snapshotId);
  }
  if (scope.accountScopeId != null) {
    requireResource(db, 'accountScopeId', snapshotId, 'SELECT id FROM account WHERE id=?', scope.accountScopeId, '科目');
    if (scope.budgetVersionId != null) requireInTreeSnapshot(db, 'account_tree_snapshot_id', scope.budgetVersionId, scope.accountScopeId, 'accountScopeId', snapshotId);
  }
  if (scope.periodStart != null && scope.periodEnd != null && scope.periodStart > scope.periodEnd) {
    throw contextError('CONTEXT_CONFLICT', 'periodStart 晚于 periodEnd', { field: 'periodStart', snapshotId });
  }

  /* ---- surface / focus / selection 归属校验 ---- */
  const surfaces = parsed.surfaces ?? [];
  for (const surface of surfaces) {
    if (surface.entity) validateEntityExists(db, surface.entity.entityType, surface.entity.id, `surfaces.${surface.key}`, snapshotId);
  }
  const focus = parsed.focus ?? null;
  if (focus) {
    if (focus.kind === 'entity') {
      validateEntityExists(db, focus.entityType, focus.id, 'focus', snapshotId);
    } else if (focus.kind === 'cell') {
      requireResource(db, 'focus.orgId', snapshotId, 'SELECT id FROM org WHERE id=?', focus.orgId, '组织');
      requireResource(db, 'focus.accountId', snapshotId, 'SELECT id FROM account WHERE id=?', focus.accountId, '科目');
      if (focus.source === 'budget') {
        const row = versionRow(focus.sourceId, 'focus.sourceId');
        // 焦点指向的版本与页面正在编辑的版本不同：页面已经切换，焦点是迟到的旧值(§11 CONTEXT_STALE)。
        if (scope.budgetVersionId != null && scope.budgetVersionId !== focus.sourceId) {
          throw contextError('CONTEXT_STALE', `单元格焦点属于版本 #${focus.sourceId}，当前页面是版本 #${scope.budgetVersionId}`, { field: 'focus', snapshotId, reason: '焦点与当前页面范围不一致' });
        }
        requireInTreeSnapshot(db, 'org_tree_snapshot_id', row.id, focus.orgId, 'focus.orgId', snapshotId);
        requireInTreeSnapshot(db, 'account_tree_snapshot_id', row.id, focus.accountId, 'focus.accountId', snapshotId);
      } else {
        requireResource(db, 'focus.sourceId', snapshotId, 'SELECT id FROM actual_snapshot_batch WHERE id=?', focus.sourceId, '实际快照');
        if (scope.actualSnapshotId != null && scope.actualSnapshotId !== focus.sourceId) {
          throw contextError('CONTEXT_STALE', `单元格焦点属于快照 #${focus.sourceId}，当前页面是快照 #${scope.actualSnapshotId}`, { field: 'focus', snapshotId, reason: '焦点与当前页面范围不一致' });
        }
      }
    } else if (focus.kind === 'chart_point') {
      if (focus.dimensionType === 'org' && focus.dimensionId != null) requireResource(db, 'focus.dimensionId', snapshotId, 'SELECT id FROM org WHERE id=?', focus.dimensionId, '组织');
      if (focus.dimensionType === 'account' && focus.dimensionId != null) requireResource(db, 'focus.dimensionId', snapshotId, 'SELECT id FROM account WHERE id=?', focus.dimensionId, '科目');
      if (focus.dimensionType === 'metric' && focus.dimensionId != null) requireResource(db, 'focus.dimensionId', snapshotId, 'SELECT id FROM report_metric WHERE id=?', focus.dimensionId, '指标');
      if (focus.dimensionType === 'version' && focus.dimensionId != null) versionRow(focus.dimensionId, 'focus.dimensionId');
    } else if (focus.kind === 'fact') {
      // 核验事实由后端按 ownerKey/factKey/scope 重新取得；客户端的 label、details、level 全部忽略(§5.5)。
      if (focus.ownerKey.startsWith('evidence:metric:')) {
        const [, , versionIdText, metricIdText] = focus.ownerKey.split(':');
        versionRow(Number(versionIdText), 'focus.ownerKey');
        requireResource(db, 'focus.ownerKey', snapshotId, 'SELECT id FROM report_metric WHERE id=?', Number(metricIdText), '指标');
      }
    }
  }
  const selection = parsed.selection ?? null;
  if (selection?.mode === 'refs') {
    for (const ref of selection.refs) validateEntityExists(db, ref.entityType, ref.id, 'selection.refs', snapshotId);
  }

  /* ---- §6 优先级合并：surface(最上层优先) > focus > 页面 scope ---- */
  validateDomainContext(db, { ...scope, page: parsed.pageKey, orgId: scope.orgScopeId });
  const mergedScope: PageScope = { ...scope };
  const applyEntity = (entityType: string, id: number) => {
    const field = ENTITY_SCOPE_FIELD[entityType];
    if (field != null) (mergedScope as Record<string, unknown>)[field] = id;
  };
  if (focus?.kind === 'entity') applyEntity(focus.entityType, focus.id);
  if (focus?.kind === 'cell') {
    if (focus.source === 'budget') mergedScope.budgetVersionId = focus.sourceId;
    else mergedScope.actualSnapshotId = focus.sourceId;
    mergedScope.orgScopeId = focus.orgId;
    mergedScope.accountScopeId = focus.accountId;
  }
  if (focus?.kind === 'chart_point') {
    if (focus.dimensionType === 'org' && focus.dimensionId != null) mergedScope.orgScopeId = focus.dimensionId;
    if (focus.dimensionType === 'account' && focus.dimensionId != null) mergedScope.accountScopeId = focus.dimensionId;
    if (focus.dimensionType === 'metric' && focus.dimensionId != null) mergedScope.metricId = focus.dimensionId;
    if (focus.dimensionType === 'version' && focus.dimensionId != null) mergedScope.budgetVersionId = focus.dimensionId;
    if (focus.dimensionType === 'period' && focus.period != null) {
      if (/^\d{4}$/.test(focus.period)) mergedScope.year = Number(focus.period);
      else if (/^\d{4}-\d{2}-\d{2}$/.test(focus.period)) {
        mergedScope.year = Number(focus.period.slice(0, 4));
        mergedScope.asOfDate = focus.period;
        const batch = rowOf<{ id: number }>(
          db,
          "SELECT id FROM actual_snapshot_batch WHERE snapshot_date=? AND status='active' ORDER BY updates_current DESC, revision DESC, id DESC LIMIT 1",
          focus.period,
        );
        if (batch) mergedScope.actualSnapshotId = batch.id;
      }
    }
  }
  // surfaces 按打开顺序排列，最上层(最后)优先(§5.4)。
  for (const surface of surfaces) {
    if (surface.entity) applyEntity(surface.entity.entityType, surface.entity.id);
  }

  /* ---- 草稿：白名单解析 + 基线校验(§9.6)，原始 changes 的裁剪在 draft-context 内完成 ---- */
  const draft = parsed.draft ? normalizeDraftInput(db, parsed.draft, { snapshotId }) : null;

  Object.assign(mergedScope, domainBatchContext(db, { ...mergedScope, page: parsed.pageKey, orgId: mergedScope.orgScopeId }));
  const effectiveBudgetVersionId = mergedScope.baseVersionId ?? mergedScope.budgetVersionId;
  const effectiveTargetVersionId = mergedScope.compareVersionId ?? mergedScope.targetVersionId;
  const pageContext: AssistantContext = {
    ...normalizeDomainContext(mergedScope as Record<string, unknown>),
    page: parsed.pageKey,
    ...(mergedScope.year != null ? { year: mergedScope.year } : {}),
    ...(effectiveBudgetVersionId != null ? { budgetVersionId: effectiveBudgetVersionId } : {}),
    ...(effectiveTargetVersionId != null ? { targetVersionId: effectiveTargetVersionId } : {}),
    ...(mergedScope.actualSnapshotId != null ? { actualSnapshotId: mergedScope.actualSnapshotId } : {}),
    ...(mergedScope.importBatchId != null ? { importBatchId: mergedScope.importBatchId } : {}),
    ...(mergedScope.orgScopeId != null ? { orgId: mergedScope.orgScopeId } : {}),
    ...(mergedScope.accountScopeId != null ? { accountId: mergedScope.accountScopeId } : {}),
  };

  return {
    pageKey: parsed.pageKey,
    pageLabel: page.label,
    capabilities: page.capabilities,
    defaultCapability: page.defaultCapability,
    pageContext,
    extras: {
      ...(mergedScope.metricId != null ? { metricId: mergedScope.metricId } : {}),
      ...(mergedScope.insightId != null ? { insightId: mergedScope.insightId } : {}),
      ...(mergedScope.conversionId != null ? { conversionId: mergedScope.conversionId } : {}),
      ...(mergedScope.mappingVersionId != null ? { mappingVersionId: mergedScope.mappingVersionId } : {}),
      ...(mergedScope.templateId != null ? { templateId: mergedScope.templateId } : {}),
      ...(mergedScope.baseVersionId != null ? { baseVersionId: mergedScope.baseVersionId } : {}),
      ...(mergedScope.compareVersionId != null ? { compareVersionId: mergedScope.compareVersionId } : {}),
      ...(mergedScope.periodStart != null ? { periodStart: mergedScope.periodStart } : {}),
      ...(mergedScope.periodEnd != null ? { periodEnd: mergedScope.periodEnd } : {}),
      ...(mergedScope.asOfDate != null ? { asOfDate: mergedScope.asOfDate } : {}),
    },
    view: parsed.view ?? {},
    focus,
    selection,
    surfaces,
    warnings,
    draft,
    snapshotId,
  };
}

/* ============ contextSummary / contextTrace(§9.7) ============ */

export interface ContextTraceEntry {
  field: string;
  value: number | string;
  origin: string;
  reason: string;
}

export interface ContextTrace {
  used: ContextTraceEntry[];
  overrides: { field: string; from: number | string; to: number | string; reason: string }[];
  warnings: string[];
}

const SUMMARY_FIELD_LABEL: Record<string, string> = {
  ...Object.fromEntries(DOMAIN_ID_FIELDS.map((k) => [k, ({projectId: '主数据项目', contractId: '合同', claimId: '报销单', feasProjectId: '可研项目', scenarioId: '可研方案', icProjectId: '投资项目', comparisonId: '投资快照', modelId: '预测模型', forecastVersionId: '预测版本', forecastRunId: '预测运行', riskId: '风险', reportId: '分析报告', standardReportId: '标准报表', governanceIssueId: '治理问题', mgmtMetricId: '管理会计指标', statementBatchId: '财报批次', projectBudgetBatchId: '项目预算批次', planBatchId: '计划批次', easBatchId: 'EAS 批次', feasReportId: '可行性报告', jobId: '后台任务'} as Record<string,string>)[k]])),
  period: '期间', periodFrom: '起始期间', periodTo: '截至期间', statementScope: '财报口径',
  year: '年度',
  budgetVersionId: '预算版本',
  targetVersionId: '对比版本',
  actualSnapshotId: '实际快照',
  importBatchId: '导入批次',
  orgId: '组织',
  accountId: '科目',
  metricId: '指标',
};

export function contextFieldLabel(field: string): string {
  return SUMMARY_FIELD_LABEL[field] ?? field;
}

/**
 * 生成「年度执行分析 · 2026 年 · 预算 V3 · 江垭电站 · 截至 6 月」式的一行范围摘要。
 * 只使用后端已核验的名称与日期，不回显客户端文案。
 */
export function buildContextSummary(
  db: DB,
  pageLabel: string,
  context: AssistantContext,
  extras: ResolvedBackendContext['extras'],
  view: Record<string, unknown>,
): string {
  const parts: string[] = [pageLabel];
  if (context.period) parts.push(context.period);
  if (context.periodFrom || context.periodTo) parts.push(`${context.periodFrom ?? '默认'} 至 ${context.periodTo ?? '最新'}`);
  for (const key of DOMAIN_ID_FIELDS) if (context[key] != null) parts.push(`${contextFieldLabel(key)} #${context[key]}`);
  if (context.year != null) parts.push(`${context.year} 年`);
  if (context.budgetVersionId != null) {
    const row = rowOf<{ name: string }>(db, 'SELECT name FROM budget_version WHERE id=?', context.budgetVersionId);
    if (row) parts.push(row.name);
  }
  if (context.actualSnapshotId != null) {
    const row = rowOf<{ snapshot_date: string }>(db, 'SELECT snapshot_date FROM actual_snapshot_batch WHERE id=?', context.actualSnapshotId);
    if (row) parts.push(`截至 ${row.snapshot_date}`);
  }
  if (context.orgId != null) {
    const row = rowOf<{ name: string }>(db, 'SELECT name FROM org WHERE id=?', context.orgId);
    if (row) parts.push(row.name);
  }
  if (context.accountId != null) {
    const row = rowOf<{ name: string }>(db, 'SELECT name FROM account WHERE id=?', context.accountId);
    if (row) parts.push(row.name);
  }
  if (extras.metricId != null) {
    const row = rowOf<{ name: string }>(db, 'SELECT name FROM report_metric WHERE id=?', extras.metricId);
    if (row) parts.push(`指标 ${row.name}`);
  }
  const sheetKey = typeof view.sheetKey === 'string' ? view.sheetKey : null;
  if (sheetKey && sheetKey !== 'all') parts.push(`工作表 ${sheetKey}`);
  return parts.join(' · ');
}

/**
 * 从 resolution 中提取「问题明确覆盖页面范围」的覆盖说明(§6)。
 * pageContext 是页面给出的值；resolution 里 origin=message 且值不同即为覆盖。
 */
export function detectOverrides(
  pageContext: AssistantContext,
  resolution: { field: string; value: number; origin: string; reason: string }[],
): ContextTrace['overrides'] {
  const overrides: ContextTrace['overrides'] = [];
  for (const item of resolution) {
    if (item.origin !== 'message') continue;
    const pageValue = (pageContext as Record<string, unknown>)[item.field];
    if (pageValue == null || Number(pageValue) === Number(item.value)) continue;
    overrides.push({ field: item.field, from: Number(pageValue), to: item.value, reason: item.reason });
  }
  return overrides;
}
