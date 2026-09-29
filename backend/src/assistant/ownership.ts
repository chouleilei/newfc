/**
 * 助手记录归属(AC-F20 / AC-X04):会话、写操作预览与保存的洞察按创建人隔离。
 *
 * - 有身份上下文时,会话/操作只对创建人可见;迁移前遗留行(owner 为空)只对全组织用户可见;
 * - 洞察是只读分析快照,全组织用户可见全部(受限用户保存的洞察只含其授权范围的事实),
 *   受限用户只看自己的;
 * - 无身份上下文(CLI/系统任务/单元测试直接调用 service)不裁剪,与 service 层约定一致。
 *
 * 不可见记录一律按“不存在”处理(404),不暴露他人记录是否存在。
 */
import { currentAuth } from '../core/request-context';

export interface OwnerFilter { sql: string; params: unknown[] }

/** 当前请求的用户 id;无身份上下文时为 null。 */
export function currentOwnerId(): number | null {
  return currentAuth()?.userId ?? null;
}

/** 会话与写操作:创建人本人;遗留无主记录仅全组织用户。 */
export function ownedRowsFilter(column = 'owner_user_id'): OwnerFilter {
  const auth = currentAuth();
  if (!auth) return { sql: '1=1', params: [] };
  if (auth.allOrgs) return { sql: `(${column}=? OR ${column} IS NULL)`, params: [auth.userId] };
  return { sql: `${column}=?`, params: [auth.userId] };
}

/** 洞察:全组织用户可见全部,受限用户只看自己的。 */
export function insightRowsFilter(column = 'owner_user_id'): OwnerFilter {
  const auth = currentAuth();
  if (!auth || auth.allOrgs) return { sql: '1=1', params: [] };
  return { sql: `${column}=?`, params: [auth.userId] };
}
