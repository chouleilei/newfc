import type { DB } from '../../db/connection';
import { AppError } from '../../core/errors';
import type { AuthContext } from '../../core/request-context';
import type { Permission } from './permissions';

/**
 * 组织数据范围(specs/data-contracts.md「认证与授权」):组织树不是数据授权,
 * 用户上的 org 授权(含下级)才是。API、任务、AI 工具、下载、检索都用这里的同一判定。
 */

export type OrgScope = { all: true } | { all: false; orgIds: ReadonlySet<number> };

/** 展开授权根节点的全部下级(按当前组织树)。 */
export function resolveOrgScope(db: DB, auth: AuthContext): OrgScope {
  if (auth.allOrgs) return { all: true };
  if (auth.orgRootIds.length === 0) return { all: false, orgIds: new Set() };
  const placeholders = auth.orgRootIds.map(() => '?').join(',');
  const rows = db.prepare(`WITH RECURSIVE sub(id) AS (
      SELECT id FROM org WHERE id IN (${placeholders})
      UNION SELECT o.id FROM org o JOIN sub ON o.parent_id = sub.id
    ) SELECT id FROM sub`).all(...auth.orgRootIds) as { id: number }[];
  return { all: false, orgIds: new Set(rows.map((r) => r.id)) };
}

export function orgInScope(scope: OrgScope, orgId: number): boolean {
  return scope.all || scope.orgIds.has(orgId);
}

/** 对象不可见时统一按“不存在或无权访问”返回 404,不泄露其存在。 */
export function notVisible(what: string): AppError {
  return new AppError('NOT_FOUND', `${what}不存在或无权访问`, 404);
}

export function assertOrgVisible(db: DB, auth: AuthContext, orgId: number, what = '组织'): void {
  if (!orgInScope(resolveOrgScope(db, auth), orgId)) throw notVisible(what);
}

/**
 * 集团口径的继承接口(整版矩阵、全组织导出等)只对全组织用户开放;
 * 受限用户得到明确的受控拒绝,而不是被静默裁剪的“集团合计”。
 */
export function requireAllOrgs(auth: AuthContext, what: string): void {
  if (!auth.allOrgs) {
    throw new AppError('SCOPE_RESTRICTED', `${what}是全组织口径,当前账号只授权了部分组织;请在页面选择已授权组织查看`, 403);
  }
}

export function hasPermission(auth: AuthContext, permission: Permission): boolean {
  return auth.permissions.has(permission);
}

export function requirePermission(auth: AuthContext | undefined, permission: Permission): AuthContext {
  if (!auth) throw new AppError('UNAUTHORIZED', '未登录或会话已过期', 401);
  if (!auth.permissions.has(permission)) throw new AppError('FORBIDDEN', `缺少权限: ${permission}`, 403);
  return auth;
}

/**
 * 受限用户在未指定组织时的默认范围:只有一个授权根时使用它,否则要求显式选择。
 * 全组织用户返回传入值(null 表示集团整体)。
 */
export function effectiveOrgScopeId(db: DB, auth: AuthContext, requested: number | null): number | null {
  if (auth.allOrgs) return requested;
  if (requested != null) {
    assertOrgVisible(db, auth, requested);
    return requested;
  }
  if (auth.orgRootIds.length === 1) return auth.orgRootIds[0];
  throw new AppError('SCOPE_REQUIRED', '当前账号授权了多个组织,请先选择要查看的组织', 400);
}
