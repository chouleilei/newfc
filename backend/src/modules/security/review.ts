import type { DB } from '../../db/connection';
import { AppError } from '../../core/errors';
import type { AuthContext } from '../../core/request-context';

/**
 * 复核分离(specs/implementation.md T-3「权限」):提交人与复核人必须不同。
 * 单人部署时,只有管理员可以同人复核,且必须写例外原因(写入审计),避免“自审”悄无声息地发生。
 */
export function isAdminUser(db: DB, userId: number): boolean {
  return !!db.prepare(`SELECT 1 FROM app_user_role ur JOIN app_role r ON r.id = ur.role_id
    WHERE ur.user_id = ? AND r.code = 'admin'`).get(userId);
}

export function assertDistinctReviewer(
  db: DB,
  auth: AuthContext | undefined,
  submitterUserId: number | null,
  exceptionReason: string | undefined | null,
  what: string,
): { selfReview: boolean } {
  if (!auth || submitterUserId == null || submitterUserId !== auth.userId) return { selfReview: false };
  if (!isAdminUser(db, auth.userId)) {
    throw new AppError('SELF_REVIEW_FORBIDDEN', `${what}的提交人与复核人必须不同`, 403);
  }
  if (!exceptionReason || !exceptionReason.trim()) {
    throw new AppError('VALIDATION_FAILED', `管理员同人复核${what}必须填写例外原因`, 400);
  }
  return { selfReview: true };
}

export function requireAdmin(db: DB, auth: AuthContext | undefined, what: string): void {
  if (auth && !isAdminUser(db, auth.userId)) throw new AppError('FORBIDDEN', `只有管理员可以${what}`, 403);
}
