import { isPageId } from '@contracts/page-catalog';
import type { PageId } from '@contracts/page-catalog';
import { PAGE_SCOPE_FIELDS, type PageScope } from '@contracts/assistant';
/**
 * AssistantPageContext 前端共享类型与 pageKey 目录
 * (现行 specs/ai.md 页面上下文契约§5、§7.1)。
 *
 * 唯一页面目录和 wire 类型由 backend/src/contracts 提供。
 * - 不发送：客户端 SHA 指纹、自称的 ready 状态、拼接好的范围文案、DOM/截图/整页数据、
 *   密钥/令牌/密码/文件正文(§5.1)。
 */

/** 页面真正用于取数的业务范围(§5.2)。页面没有某字段时不发送，不用 null 占位。 */
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
    if (!PAGE_SCOPE_FIELDS.includes(key as keyof PageScope) || value === undefined || value === null || value === '') continue;
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
