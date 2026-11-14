import type { AuthContext } from '../../core/request-context';
import type { Permission } from '../../contracts/permissions';
import { AppError } from '../../core/errors';
/** Explicit service authorization; callers pass the server-created identity. */
export function legalAccess(
  auth: AuthContext | undefined,
  permissions: Permission[],
  allOrgs = false,
): void {
  if (!auth || !permissions.some((p) => auth.permissions.has(p)))
    throw new AppError('FORBIDDEN', '没有合同法审操作权限', 403);
  if (allOrgs && !auth.allOrgs)
    throw new AppError(
      'SCOPE_RESTRICTED',
      '制度和范本管理需要全部组织范围',
      403,
    );
}
