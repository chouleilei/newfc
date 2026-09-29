import type { AddressInfo } from 'net';
import { createApp, type ServerOptions } from '../src/server';
import type { DB } from '../src/db/connection';
import { bootstrapAdmin, createUser, issueSession, listRoles, userCount } from '../src/modules/security/security.service';
import { SESSION_COOKIE } from '../src/modules/security/http';
import { runWithContext, systemContext } from '../src/core/request-context';

/**
 * HTTP 测试夹具:走真实的会话 Cookie + CSRF 认证链路(没有测试专用旁路)。
 * createTestApp 在测试库里显式初始化管理员并签发会话;app.listen 后,
 * authFetch 按目标端口自动附带该会话的 Cookie 与 X-CSRF-Token。
 */

interface TestSession { cookie: string; csrf: string }
const sessionsByPort = new Map<string, TestSession>();

export const TEST_ADMIN = { username: 'test-admin', password: 'Vt9-correct-horse-battery' };

export function sessionFor(db: DB, userId: number): TestSession {
  const issued = issueSession(db, userId, { ip: '127.0.0.1', userAgent: 'vitest' });
  return { cookie: `${SESSION_COOKIE}=${issued.token}`, csrf: issued.csrfToken };
}

export function ensureAdmin(db: DB): number {
  return runWithContext(systemContext('cli'), () => {
    if (userCount(db) === 0) return bootstrapAdmin(db, TEST_ADMIN.username, TEST_ADMIN.password).id;
    return (db.prepare("SELECT id FROM app_user WHERE username = ?").get(TEST_ADMIN.username) as { id: number }).id;
  });
}

/** 创建受限测试用户(指定角色编码与组织授权),返回其会话。 */
export function createScopedUser(db: DB, opts: { username: string; roleCodes: string[]; orgIds?: number[]; allOrgs?: boolean }): { userId: number; session: TestSession } {
  const roles = listRoles(db);
  const roleIds = opts.roleCodes.map((code) => {
    const role = roles.find((r) => r.code === code);
    if (!role) throw new Error(`unknown role ${code}`);
    return role.id;
  });
  const user = runWithContext(systemContext('cli'), () => createUser(db, {
    username: opts.username, password: 'Vt9-scoped-user-staple', roleIds, orgIds: opts.orgIds ?? [],
    allOrgs: opts.allOrgs ?? false, mustChangePassword: false,
  }));
  return { userId: user.id, session: sessionFor(db, user.id) };
}

export async function createTestApp(opts: ServerOptions) {
  const result = await createApp(opts);
  const db = result.holder.getDb();
  const adminId = ensureAdmin(db);
  const session = sessionFor(db, adminId);
  const originalListen = result.app.listen.bind(result.app) as (...args: unknown[]) => import('http').Server;
  (result.app as unknown as { listen: (...args: unknown[]) => import('http').Server }).listen = (...args: unknown[]) => {
    const server = originalListen(...args);
    const register = () => {
      const address = server.address() as AddressInfo | null;
      if (address && typeof address === 'object') sessionsByPort.set(String(address.port), session);
    };
    register();
    server.once('listening', register);
    server.once('close', () => {
      const address = server.address() as AddressInfo | null;
      if (address) sessionsByPort.delete(String(address.port));
    });
    return server;
  };
  return { ...result, adminId, session };
}

/** 与 fetch 相同,但对 createTestApp 启动的服务自动附带管理员会话 Cookie 与 CSRF 令牌。 */
export async function authFetch(input: string | URL, init: RequestInit = {}): Promise<Response> {
  const url = new URL(String(input));
  const session = sessionsByPort.get(url.port);
  if (!session) return fetch(input, init);
  return fetchAs(session, input, init);
}

export async function fetchAs(session: TestSession, input: string | URL, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  if (!headers.has('cookie')) headers.set('cookie', session.cookie);
  const method = (init.method ?? 'GET').toUpperCase();
  if (!['GET', 'HEAD', 'OPTIONS'].includes(method) && !headers.has('x-csrf-token')) headers.set('x-csrf-token', session.csrf);
  return fetch(input, { ...init, headers });
}
