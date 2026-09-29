import { AsyncLocalStorage } from 'async_hooks';
import crypto from 'crypto';
import type { Permission } from '../modules/security/permissions';

/**
 * 服务端构建的身份与组织范围(specs/data-contracts.md「认证与授权」)。
 * 由认证中间件/任务执行器从数据库加载,绝不从客户端请求体读取。
 */
export interface AuthContext {
  userId: number;
  username: string;
  displayName: string;
  permissions: ReadonlySet<Permission>;
  /** true:可访问全部组织;false:只能访问 orgRootIds 及其下级 */
  allOrgs: boolean;
  orgRootIds: readonly number[];
  sessionId?: string;
}

export type RequestSource = 'http' | 'assistant' | 'task' | 'cli' | 'system';

export interface RequestContext {
  requestId: string;
  source: RequestSource;
  ip?: string;
  auth?: AuthContext;
  /** 在持久任务内执行时的任务 ID(模型调用、审计据此关联任务) */
  jobId?: number;
}

const storage = new AsyncLocalStorage<RequestContext>();

export function newRequestId(): string {
  return crypto.randomBytes(8).toString('hex');
}

export function runWithContext<T>(ctx: RequestContext, fn: () => T): T {
  return storage.run(ctx, fn);
}

export function currentContext(): RequestContext | undefined {
  return storage.getStore();
}

export function currentAuth(): AuthContext | undefined {
  return storage.getStore()?.auth;
}

/** 在当前上下文里附加身份(认证中间件在 run 之后才知道用户)。 */
export function attachAuth(auth: AuthContext): void {
  const store = storage.getStore();
  if (store) store.auth = auth;
}

/** 系统内部(启动恢复、定时备份等)执行的上下文:无用户身份,审计记为 system。 */
export function systemContext(source: RequestSource = 'system'): RequestContext {
  return { requestId: newRequestId(), source };
}
