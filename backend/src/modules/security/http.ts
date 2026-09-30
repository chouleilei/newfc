import crypto from 'crypto';
import type { Express, NextFunction, Request, Response } from 'express';
import type { DB } from '../../db/connection';
import { AppError, Errors } from '../../core/errors';
import { newRequestId, runWithContext, type AuthContext, type RequestContext } from '../../core/request-context';
import { writeLog } from '../audit/log';
import { matchRouteRule } from './route-rules';
import { assertOrgVisible, requireAllOrgs } from './scope';
import * as security from './security.service';

/**
 * HTTP 认证层(platform_auth / AC-F01):
 * - HttpOnly + SameSite=Strict Cookie 会话(令牌只以 SHA-256 入库);
 * - 写请求双重校验:X-CSRF-Token 与会话绑定令牌一致 + Origin/Sec-Fetch-Site 同源;
 * - 未登录 401、无权限 403、对象不可见 404;
 * - 路由权限表默认拒绝未登记路由。
 */

export const SESSION_COOKIE = 'newfc_session';
const COOKIE_MAX_AGE_S = 7 * 24 * 3600;

export type Handler = (req: Request, res: Response) => Promise<unknown> | unknown;
export type Wrap = (fn: Handler) => (req: Request, res: Response, next: NextFunction) => void;

/** 请求上下文保存在 res.locals 上;body 解析/multer 等流式回调可能丢失 AsyncLocalStorage,路由执行时重新进入。 */
export function requestContextOf(res: Response): RequestContext | undefined {
  return res.locals.newfcContext as RequestContext | undefined;
}

export function authOf(req: Request): AuthContext {
  const auth = (req as Request & { auth?: AuthContext }).auth;
  if (!auth) throw new AppError('UNAUTHORIZED', '未登录或会话已过期', 401);
  return auth;
}

export function makeWrap(): Wrap {
  return (fn) => (req, res, next) => {
    const ctx = requestContextOf(res);
    const run = () => { Promise.resolve().then(() => fn(req, res)).catch(next); };
    if (ctx) runWithContext(ctx, run); else run();
  };
}

export function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  if (!header) return out;
  for (const part of header.split(';')) {
    const eq = part.indexOf('=');
    if (eq <= 0) continue;
    const key = part.slice(0, eq).trim();
    const value = part.slice(eq + 1).trim();
    try { out[key] = decodeURIComponent(value); } catch { out[key] = value; }
  }
  return out;
}

function setSessionCookie(req: Request, res: Response, token: string, maxAge = COOKIE_MAX_AGE_S): void {
  const parts = [`${SESSION_COOKIE}=${token}`, 'Path=/', 'HttpOnly', 'SameSite=Strict', `Max-Age=${maxAge}`];
  if (req.secure) parts.push('Secure');
  res.append('Set-Cookie', parts.join('; '));
}

function clearSessionCookie(req: Request, res: Response): void {
  setSessionCookie(req, res, '', 0);
}

function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a).digest();
  const hb = crypto.createHash('sha256').update(b).digest();
  return crypto.timingSafeEqual(ha, hb);
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** 浏览器跨站请求拒绝:Origin/Referer 须与 Host 同源;Sec-Fetch-Site=cross-site 直接拒绝。 */
function assertSameOrigin(req: Request): void {
  const fetchSite = String(req.headers['sec-fetch-site'] ?? '').toLowerCase();
  if (fetchSite === 'cross-site') throw new AppError('CSRF_REJECTED', '跨站请求被拒绝', 403);
  const origin = req.headers.origin ?? req.headers.referer;
  if (!origin) return;
  let originHost: string;
  try { originHost = new URL(String(origin)).host; } catch { throw new AppError('CSRF_REJECTED', '请求来源无效', 403); }
  const forwardedHost = req.app.get('trust proxy') ? String(req.headers['x-forwarded-host'] ?? '').split(',')[0].trim() : '';
  const host = forwardedHost || String(req.headers.host ?? '');
  if (originHost !== host) throw new AppError('CSRF_REJECTED', '跨站请求被拒绝(来源与站点不一致)', 403);
}

/* ============ 登录限流(按 IP 与按账号,内存态) ============ */

interface FailureRecord { count: number; firstAt: number; lockedUntil: number }
const MAX_FAILED_ATTEMPTS = 8;
const LOCK_WINDOW_MS = 10 * 60 * 1000;
const LOCK_DURATION_MS = 5 * 60 * 1000;

export class LoginThrottle {
  private byIp = new Map<string, FailureRecord>();
  private byAccount = new Map<string, FailureRecord>();

  private remaining(rec: FailureRecord | undefined, now: number): number {
    return rec && rec.lockedUntil > now ? Math.ceil((rec.lockedUntil - now) / 1000) : 0;
  }

  lockedSeconds(ip: string, username: string, now = Date.now()): number {
    return Math.max(this.remaining(this.byIp.get(ip), now), this.remaining(this.byAccount.get(username.toLowerCase()), now));
  }

  private bump(map: Map<string, FailureRecord>, key: string, now: number): number {
    const prev = map.get(key);
    const cur = prev && now - prev.firstAt < LOCK_WINDOW_MS ? prev : { count: 0, firstAt: now, lockedUntil: 0 };
    cur.count += 1;
    if (cur.count >= MAX_FAILED_ATTEMPTS) {
      cur.lockedUntil = now + LOCK_DURATION_MS;
      cur.count = 0;
      cur.firstAt = now;
    }
    map.set(key, cur);
    if (map.size > 10000) {
      for (const [k, v] of map) if (now - v.firstAt > LOCK_WINDOW_MS && v.lockedUntil < now) map.delete(k);
    }
    return this.remaining(cur, now);
  }

  failure(ip: string, username: string, accountExists: boolean): number {
    const now = Date.now();
    let locked = this.bump(this.byIp, ip, now);
    if (accountExists) locked = Math.max(locked, this.bump(this.byAccount, username.toLowerCase(), now));
    return locked;
  }

  success(ip: string, username: string): void {
    this.byIp.delete(ip);
    this.byAccount.delete(username.toLowerCase());
  }
}

/* ============ 注册 ============ */

export interface AuthLayerOptions {
  /** 路径不在路由表时的处理:默认拒绝 */
  db: () => DB;
  wrap: Wrap;
}

function publicSessionPayload(db: DB, auth: AuthContext, session: { csrf_token: string; expires_at: string }) {
  return {
    authenticated: true,
    user: {
      id: auth.userId,
      username: auth.username,
      displayName: auth.displayName,
      permissions: [...auth.permissions].sort(),
      allOrgs: auth.allOrgs,
      orgIds: [...auth.orgRootIds],
      mustChangePassword: security.userMustChangePassword(db, auth.userId),
    },
    csrfToken: session.csrf_token,
    expiresAt: session.expires_at,
  };
}

/** 请求上下文(请求 ID、来源 IP):必须是第一个中间件。 */
export function registerRequestContext(app: Express): void {
  app.use((req, res, next) => {
    const incoming = String(req.headers['x-request-id'] ?? '');
    const ctx: RequestContext = {
      requestId: /^[A-Za-z0-9_-]{8,64}$/.test(incoming) ? incoming : newRequestId(),
      source: 'http',
      ip: req.ip,
    };
    res.locals.newfcContext = ctx;
    res.setHeader('X-Request-Id', ctx.requestId);
    runWithContext(ctx, () => next());
  });
}

/** 公开认证路由:登录、会话查询、登出。 */
export function registerAuthRoutes(app: Express, opts: AuthLayerOptions): void {
  const { db, wrap } = opts;
  const throttle = new LoginThrottle();

  app.post('/api/auth/login', wrap((req, res) => {
    assertSameOrigin(req);
    const { username, password } = (req.body ?? {}) as { username?: unknown; password?: unknown };
    const usernameStr = typeof username === 'string' ? username.trim() : '';
    const passwordStr = typeof password === 'string' ? password : '';
    if (!usernameStr || !passwordStr || usernameStr.length > 64 || passwordStr.length > 128) {
      throw new AppError('VALIDATION_FAILED', '请输入用户名和口令', 400);
    }
    const ip = req.ip ?? 'unknown';
    const locked = throttle.lockedSeconds(ip, usernameStr);
    if (locked > 0) throw new AppError('AUTH_LOCKED', `失败次数过多,请 ${locked} 秒后重试`, 429);
    if (security.userCount(db()) === 0) {
      throw new AppError('NOT_INITIALIZED', '系统尚未初始化管理员:请在服务器执行 `npm run admin:create`', 401);
    }
    const user = security.verifyCredentials(db(), usernameStr, passwordStr);
    if (!user || user.status !== 'active') {
      const exists = Boolean(db().prepare('SELECT 1 FROM app_user WHERE username = ?').get(usernameStr));
      const lockedSeconds = throttle.failure(ip, usernameStr, exists);
      writeLog(db(), 'auth.login_failed', 'auth', '-', { username: usernameStr.slice(0, 64), reason: user ? 'disabled' : 'bad_credentials', ...(lockedSeconds ? { lockedSeconds } : {}) }, 'failure');
      throw new AppError('AUTH_FAILED', lockedSeconds ? `失败次数过多,请 ${lockedSeconds} 秒后重试` : '用户名或口令错误,或账号已停用', 401);
    }
    throttle.success(ip, usernameStr);
    const issued = security.issueSession(db(), user.id, { ip, userAgent: String(req.headers['user-agent'] ?? '') });
    setSessionCookie(req, res, issued.token);
    const auth = security.loadAuthContext(db(), user.id, issued.sessionId)!;
    const ctx = requestContextOf(res);
    if (ctx) ctx.auth = auth;
    writeLog(db(), 'auth.login', 'app_user', user.id, {});
    res.json(publicSessionPayload(db(), auth, { csrf_token: issued.csrfToken, expires_at: issued.expiresAt }));
  }));

  app.get('/api/auth/session', wrap((req, res) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const resolved = security.resolveSession(db(), token);
    if (!resolved) {
      throw new AppError('UNAUTHORIZED', '未登录或会话已过期', 401, undefined, { initialized: security.userCount(db()) > 0 });
    }
    res.json(publicSessionPayload(db(), resolved.auth, resolved.session));
  }));

  app.post('/api/auth/logout', wrap((req, res) => {
    assertSameOrigin(req);
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const resolved = security.resolveSession(db(), token);
    if (resolved) {
      const csrf = String(req.headers['x-csrf-token'] ?? '');
      if (!safeEqual(csrf, resolved.session.csrf_token)) throw new AppError('CSRF_REJECTED', 'CSRF 校验失败,请刷新页面后重试', 403);
      const ctx = requestContextOf(res);
      if (ctx) ctx.auth = resolved.auth;
      security.revokeSession(db(), resolved.session.id);
      writeLog(db(), 'auth.logout', 'app_user', resolved.auth.userId, {});
    }
    clearSessionCookie(req, res);
    res.json({ ok: true });
  }));
}

/** 会话认证 + CSRF:注册在存活/就绪检查之后、业务路由之前。 */
export function registerSessionAuth(app: Express, db: () => DB): void {
  // 会话认证:其余 /api 一律需要有效会话(存活/就绪检查在此之前注册)
  app.use('/api', (req, res, next) => {
    const token = parseCookies(req.headers.cookie)[SESSION_COOKIE];
    const resolved = security.resolveSession(db(), token);
    if (!resolved) {
      res.status(401).json({ code: 'UNAUTHORIZED', message: '未登录或会话已过期', requestId: requestContextOf(res)?.requestId });
      return;
    }
    (req as Request & { auth?: AuthContext }).auth = resolved.auth;
    (req as Request & { authUser?: string }).authUser = resolved.auth.username;
    const ctx = requestContextOf(res);
    if (ctx) ctx.auth = resolved.auth;
    if (!SAFE_METHODS.has(req.method)) {
      try {
        assertSameOrigin(req);
        const csrf = String(req.headers['x-csrf-token'] ?? '');
        if (!csrf || !safeEqual(csrf, resolved.session.csrf_token)) {
          throw new AppError('CSRF_REJECTED', 'CSRF 校验失败,请刷新页面后重试', 403);
        }
      } catch (error) {
        const e = error as AppError;
        res.status(e.status ?? 403).json({ code: e.code, message: e.message, requestId: ctx?.requestId });
        return;
      }
    }
    // 管理员重置口令后,首次登录必须先修改口令
    if (security.userMustChangePassword(db(), resolved.auth.userId) && !/^\/me\/password$/.test(req.path)) {
      res.status(403).json({ code: 'PASSWORD_CHANGE_REQUIRED', message: '请先修改初始口令', requestId: ctx?.requestId });
      return;
    }
    runWithContext(ctx ?? { requestId: newRequestId(), source: 'http', auth: resolved.auth }, () => next());
  });
}

/**
 * 第二阶段:路由权限守卫(在 JSON 解析之后,以便检查 body 中的组织参数)。
 * 请求携带 orgId/orgScopeId(query 或 JSON body)时统一核验组织可见性。
 */
export function registerRouteGuard(app: Express, db: () => DB): void {
  app.use('/api', (req, res, next) => {
    const ctx = requestContextOf(res);
    const deny = (status: number, code: string, message: string) => {
      res.status(status).json({ code, message, requestId: ctx?.requestId });
    };
    const auth = (req as Request & { auth?: AuthContext }).auth;
    if (!auth) return deny(401, 'UNAUTHORIZED', '未登录或会话已过期');
    const rule = matchRouteRule(req.method, req.path);
    if (!rule) return deny(403, 'ROUTE_NOT_AUTHORIZED', '该接口未登记访问权限,已拒绝');
    if (rule.permission && !auth.permissions.has(rule.permission)) {
      return deny(403, 'FORBIDDEN', `当前账号没有此操作权限(${rule.permission})`);
    }
    try {
      if (rule.allOrgs) requireAllOrgs(auth, '该功能');
      if (!auth.allOrgs) {
        const body = (req.body && typeof req.body === 'object' && !Array.isArray(req.body)) ? req.body as Record<string, unknown> : {};
        for (const key of ['orgId', 'orgScopeId']) {
          for (const raw of [req.query[key], body[key]]) {
            if (raw === undefined || raw === null || raw === '') continue;
            const id = Number(raw);
            if (!Number.isSafeInteger(id) || id <= 0) continue; // 格式错误交给接口自身的校验
            assertOrgVisible(db(), auth, id);
          }
        }
      }
    } catch (error) {
      const e = error as AppError;
      return deny(e.status ?? 403, e.code ?? 'FORBIDDEN', e.message);
    }
    if (ctx) runWithContext(ctx, () => next()); else next();
  });
}

/* ============ 个人与安全管理接口 ============ */

export function registerSecurityRoutes(app: Express, db: () => DB, wrap: Wrap): void {
  const idParam = (value: unknown, name: string) => {
    const id = Number(value);
    if (!Number.isSafeInteger(id) || id <= 0) throw Errors.validation(`${name} 必须为正整数`);
    return id;
  };

  app.get('/api/me', wrap((req, res) => {
    const auth = authOf(req);
    const { csrfToken: _csrf, expiresAt: _exp, ...rest } = publicSessionPayload(db(), auth, { csrf_token: '', expires_at: '' });
    res.json(rest);
  }));

  app.post('/api/me/password', wrap((req, res) => {
    const auth = authOf(req);
    const { currentPassword, newPassword } = (req.body ?? {}) as Record<string, unknown>;
    security.changeOwnPassword(db(), auth, currentPassword, newPassword);
    res.json({ ok: true });
  }));

  app.get('/api/security/permissions', wrap((_req, res) => res.json({ items: security.permissionCatalog() })));
  app.get('/api/security/users', wrap((_req, res) => res.json({ items: security.listUsers(db()) })));
  app.post('/api/security/users', wrap((req, res) => res.status(201).json(security.createUser(db(), req.body ?? {}))));
  app.get('/api/security/users/:id', wrap((req, res) => res.json(security.getUser(db(), idParam(req.params.id, '用户 ID')))));
  app.patch('/api/security/users/:id', wrap((req, res) =>
    res.json(security.updateUser(db(), idParam(req.params.id, '用户 ID'), req.body ?? {}, authOf(req)))));
  app.get('/api/security/users/:id/sessions', wrap((req, res) =>
    res.json(security.listUserSessions(db(), idParam(req.params.id, '用户 ID'), authOf(req).sessionId))));
  app.post('/api/security/users/:id/sessions/:sid/revoke', wrap((req, res) => {
    security.revokeUserSession(db(), idParam(req.params.id, '用户 ID'), String(req.params.sid), authOf(req));
    res.json({ ok: true });
  }));
  app.get('/api/security/roles', wrap((_req, res) => res.json({ items: security.listRoles(db()) })));
  app.post('/api/security/roles/:id/copy', wrap((req, res) =>
    res.status(201).json(security.copyRole(db(), idParam(req.params.id, '角色 ID'), req.body ?? {}))));
  app.post('/api/security/roles', wrap((req, res) => res.status(201).json(security.createRole(db(), req.body ?? {}))));
  app.patch('/api/security/roles/:id', wrap((req, res) => res.json(security.updateRole(db(), idParam(req.params.id, '角色 ID'), req.body ?? {}))));
  app.delete('/api/security/roles/:id', wrap((req, res) => {
    security.deleteRole(db(), idParam(req.params.id, '角色 ID'));
    res.status(204).end();
  }));
}
