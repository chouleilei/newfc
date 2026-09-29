/**
 * AssistantPageContextV2 前端共享类型与 pageKey 目录
 * (方案《小澧助手全页面回答范围自动对齐开发计划》§5、§7.1)。
 *
 * 约定：
 * - 本文件只放类型、pageKey 目录、规范化和快照逻辑，不拆分出 fingerprint/selection/overlay 等小模块；
 * - PAGE_KEYS 与后端 backend/src/assistant/page-capabilities.ts 的 PAGE_CAPABILITY_MAP
 *   由后端契约测试 tests/page-capabilities.contract.test.ts 双向比较，遗漏即失败；
 * - 不发送：客户端 SHA 指纹、自称的 ready 状态、拼接好的范围文案、DOM/截图/整页数据、
 *   密钥/令牌/密码/文件正文(§5.1)。
 */

/** 页面真正用于取数的业务范围(§5.2)。页面没有某字段时不发送，不用 null 占位。 */
export interface PageScope {
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

export type DraftKind =
  | 'budget_grid'
  | 'actual_grid'
  | 'org_form'
  | 'account_form'
  | 'metric_formula'
  | 'calculation_rule'
  | 'cleaning_template'
  | 'alias_rule';

export interface DraftDescriptor {
  kind: DraftKind;
  base: Record<string, unknown>;
  changes: unknown;
}

/** 每次 chat / chat/stream 请求携带的页面上下文(§5.1)。 */
export interface AssistantPageContextV2 {
  schemaVersion: 2;
  /** 本轮随机 UUID：关联请求、错误回执与排错定位；不提供幂等去重。 */
  snapshotId: string;
  pageKey: string;
  /** 当前路由实例 UUID：前端隔离迟到更新。 */
  routeInstanceId: string;
  /** 当前页面语义状态递增版本。 */
  contextVersion: number;
  scope?: PageScope;
  view?: Record<string, unknown>;
  /** 当前打开的业务浮层，按打开顺序排列(注册顺序即优先顺序)。 */
  surfaces?: SurfaceDescriptor[];
  focus?: FocusDescriptor | null;
  selection?: SelectionDescriptor | null;
  draft?: DraftDescriptor | null;
}

/** 常规上下文最大 64 KiB；带草稿请求草稿部分最大 5 MiB(§5.8)。 */
export const CONTEXT_MAX_BYTES = 64 * 1024;
export const DRAFT_MAX_BYTES = 5 * 1024 * 1024;
export const DRAFT_MAX_CHANGES = 10_000;
export const SELECTION_MAX_REFS = 500;

/**
 * 28 个 pageKey(§7.2)：覆盖 App.tsx 全部业务路由与 DataManage 全部实际页签。
 * 顺序即展示顺序；与后端 PageCapabilityMap 一键不差。
 */
export const PAGE_KEYS = [
  'dashboard',
  'assistant',
  'insights',
  'master_health',
  'cleaning_config',
  'budget_progress',
  'anomaly_center',
  'metric_trend',
  'ai_settings',
  'org',
  'account',
  'metric',
  'budget_versions',
  'budget_edit',
  'actual',
  'finance_import',
  'analysis',
  'structure',
  'history',
  'version_compare',
  'calculations',
  'imports',
  'data_check',
  'yearclose',
  'backup',
  'migration',
  'data_export',
  'logs',
] as const;

export type PageKey = (typeof PAGE_KEYS)[number];

export function isPageKey(value: string): value is PageKey {
  return (PAGE_KEYS as readonly string[]).includes(value);
}

/**
 * 带业务范围的跨页导航(§7.4)：目标页校验参数、更新自身筛选，再登记实际生效上下文。
 * 只接受白名单内的标量参数，避免把临时 navigation state 透传给目标页。
 */
export function buildScopedPath(
  path: string,
  scope: { year?: number; budgetVersionId?: number; actualSnapshotId?: number; orgScopeId?: number; accountScopeId?: number },
  extra?: Record<string, string | number | null | undefined>,
): string {
  const params = new URLSearchParams();
  if (scope.year != null) params.set('year', String(scope.year));
  if (scope.budgetVersionId != null) params.set('version', String(scope.budgetVersionId));
  if (scope.actualSnapshotId != null) params.set('batch', String(scope.actualSnapshotId));
  if (scope.orgScopeId != null) params.set('org', String(scope.orgScopeId));
  if (scope.accountScopeId != null) params.set('account', String(scope.accountScopeId));
  for (const [key, value] of Object.entries(extra ?? {})) {
    if (value == null || value === '') continue;
    params.set(key, String(value));
  }
  const query = params.toString();
  return query ? `${path}?${query}` : path;
}

/** 生成 snapshotId / routeInstanceId 用的 UUID。 */
export function newContextId(): string {
  if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') return crypto.randomUUID();
  return `ctx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 12)}`;
}

/** 去掉空值并截断超长字符串，保证发送的 scope 不含 null 占位。 */
export function normalizeScope(scope: PageScope): PageScope {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(scope)) {
    if (value === undefined || value === null || value === '') continue;
    out[key] = value;
  }
  return out as PageScope;
}

/** view 只保留标量与标量数组，超长文本截断。 */
export function normalizeView(view: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(view)) {
    if (value === undefined || value === null || value === '') continue;
    if (typeof value === 'string') out[key] = value.slice(0, 200);
    else if (typeof value === 'number' || typeof value === 'boolean') out[key] = value;
    else if (Array.isArray(value)) out[key] = value.filter((item) => ['string', 'number', 'boolean'].includes(typeof item)).slice(0, 100);
  }
  return out;
}
