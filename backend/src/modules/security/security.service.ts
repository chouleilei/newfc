import crypto from 'crypto';
import type { DB } from '../../db/connection';
import { AppError, Errors } from '../../core/errors';
import type { AuthContext } from '../../core/request-context';
import { writeLog } from '../audit/log';
import { BUILTIN_ROLES } from './permissions';
import { ALL_PERMISSIONS, isPermission, PERMISSION_CATALOG, type Permission } from '../../contracts/permissions';
import { hashPassword, validatePasswordPolicy, verifyPassword } from './password';

/** 用户、角色、组织授权与会话(platform_auth / security_administration)。 */

export interface UserRow {
  id: number;
  username: string;
  display_name: string;
  password_hash: string;
  status: 'active' | 'disabled';
  all_orgs: 0 | 1;
  must_change_password: 0 | 1;
  created_at: string;
  updated_at: string;
  last_login_at: string | null;
}

export interface RoleRow {
  id: number;
  code: string;
  name: string;
  description: string;
  locked: 0 | 1;
  created_at: string;
  updated_at: string;
}

export interface PublicUser {
  id: number;
  username: string;
  displayName: string;
  status: 'active' | 'disabled';
  allOrgs: boolean;
  mustChangePassword: boolean;
  roles: { id: number; code: string; name: string }[];
  orgIds: number[];
  createdAt: string;
  updatedAt: string;
  lastLoginAt: string | null;
}

export interface PublicRole {
  id: number;
  code: string;
  name: string;
  description: string;
  locked: boolean;
  permissions: Permission[];
  userCount: number;
}

const nowIso = () => new Date().toISOString();

/* ============ 内置角色 ============ */

/** 启动时幂等补齐内置角色;锁定的 admin 角色始终同步为全部权限(新增权限码后自动覆盖)。 */
export function ensureBuiltinRoles(db: DB): void {
  const tx = db.transaction(() => {
    for (const role of BUILTIN_ROLES) {
      let row = db.prepare('SELECT id, locked FROM app_role WHERE code = ?').get(role.code) as { id: number; locked: number } | undefined;
      if (!row) {
        const now = nowIso();
        const id = Number(db.prepare('INSERT INTO app_role (code, name, description, locked, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
          .run(role.code, role.name, role.description, role.locked ? 1 : 0, now, now).lastInsertRowid);
        const ins = db.prepare('INSERT INTO app_role_permission (role_id, permission) VALUES (?, ?)');
        for (const p of new Set(role.permissions)) ins.run(id, p);
        row = { id, locked: role.locked ? 1 : 0 };
      } else if (row.locked) {
        const ins = db.prepare('INSERT OR IGNORE INTO app_role_permission (role_id, permission) VALUES (?, ?)');
        for (const p of role.permissions) ins.run(row.id, p);
      }
    }
  });
  tx();
}

/* ============ 读取 ============ */

function rolesOfUser(db: DB, userId: number): { id: number; code: string; name: string }[] {
  return db.prepare(`SELECT r.id, r.code, r.name FROM app_user_role ur JOIN app_role r ON r.id = ur.role_id
    WHERE ur.user_id = ? ORDER BY r.id`).all(userId) as { id: number; code: string; name: string }[];
}

function orgIdsOfUser(db: DB, userId: number): number[] {
  return (db.prepare('SELECT org_id FROM app_user_org_scope WHERE user_id = ? ORDER BY org_id').all(userId) as { org_id: number }[])
    .map((r) => r.org_id);
}

function permissionsOfUser(db: DB, userId: number): Set<Permission> {
  const rows = db.prepare(`SELECT DISTINCT rp.permission FROM app_user_role ur
    JOIN app_role_permission rp ON rp.role_id = ur.role_id WHERE ur.user_id = ?`).all(userId) as { permission: string }[];
  const set = new Set<Permission>();
  for (const r of rows) if (isPermission(r.permission)) set.add(r.permission);
  return set;
}

function toPublicUser(db: DB, row: UserRow): PublicUser {
  return {
    id: row.id,
    username: row.username,
    displayName: row.display_name,
    status: row.status,
    allOrgs: row.all_orgs === 1,
    mustChangePassword: row.must_change_password === 1,
    roles: rolesOfUser(db, row.id),
    orgIds: orgIdsOfUser(db, row.id),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at,
  };
}

function getUserRow(db: DB, id: number): UserRow {
  const row = db.prepare('SELECT * FROM app_user WHERE id = ?').get(id) as UserRow | undefined;
  if (!row) throw Errors.notFound('用户');
  return row;
}

export function userCount(db: DB): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM app_user').get() as { c: number }).c;
}

export function listUsers(db: DB): PublicUser[] {
  return (db.prepare('SELECT * FROM app_user ORDER BY id').all() as UserRow[]).map((r) => toPublicUser(db, r));
}

export function getUser(db: DB, id: number): PublicUser {
  return toPublicUser(db, getUserRow(db, id));
}

export function listRoles(db: DB): PublicRole[] {
  const roles = db.prepare('SELECT * FROM app_role ORDER BY id').all() as RoleRow[];
  return roles.map((r) => ({
    id: r.id,
    code: r.code,
    name: r.name,
    description: r.description,
    locked: r.locked === 1,
    permissions: (db.prepare('SELECT permission FROM app_role_permission WHERE role_id = ? ORDER BY permission').all(r.id) as { permission: string }[])
      .map((p) => p.permission).filter(isPermission),
    userCount: (db.prepare('SELECT COUNT(*) AS c FROM app_user_role WHERE role_id = ?').get(r.id) as { c: number }).c,
  }));
}

export function permissionCatalog() {
  return PERMISSION_CATALOG.map((p) => ({ ...p }));
}

/** 从数据库构建服务端身份上下文;用户不存在或已停用返回 null。 */
export function loadAuthContext(db: DB, userId: number, sessionId?: string): AuthContext | null {
  const row = db.prepare('SELECT * FROM app_user WHERE id = ?').get(userId) as UserRow | undefined;
  if (!row || row.status !== 'active') return null;
  return {
    userId: row.id,
    username: row.username,
    displayName: row.display_name,
    permissions: permissionsOfUser(db, row.id),
    allOrgs: row.all_orgs === 1,
    orgRootIds: orgIdsOfUser(db, row.id),
    sessionId,
  };
}

/* ============ 校验工具 ============ */

function text(value: unknown, name: string, max: number, min = 1): string {
  if (typeof value !== 'string') throw Errors.validation(`${name}必须是字符串`);
  const v = value.trim();
  if (v.length < min || v.length > max) throw Errors.validation(`${name}长度须在 ${min}-${max} 之间`);
  return v;
}

function validUsername(value: unknown): string {
  const v = text(value, '用户名', 64, 2);
  if (!/^[A-Za-z0-9_.@-]+$/.test(v)) throw Errors.validation('用户名只能包含字母、数字和 _ . @ -');
  return v;
}

function idList(value: unknown, name: string): number[] {
  if (value === undefined) return [];
  if (!Array.isArray(value)) throw Errors.validation(`${name}必须是数组`);
  const ids = value.map((v) => Number(v));
  if (ids.some((v) => !Number.isSafeInteger(v) || v <= 0)) throw Errors.validation(`${name}必须是正整数数组`);
  return [...new Set(ids)];
}

function assertRolesExist(db: DB, roleIds: number[]): void {
  for (const id of roleIds) {
    if (!db.prepare('SELECT 1 FROM app_role WHERE id = ?').get(id)) throw Errors.validation(`角色 ${id} 不存在`);
  }
}

function assertOrgsExist(db: DB, orgIds: number[]): void {
  for (const id of orgIds) {
    if (!db.prepare('SELECT 1 FROM org WHERE id = ?').get(id)) throw Errors.validation(`组织 ${id} 不存在`);
  }
}

/** 至少保留一个“启用 + 全组织 + 拥有 security:manage”的用户,防止授权管理被锁死。 */
function assertAdminRemains(db: DB): void {
  const row = db.prepare(`SELECT COUNT(DISTINCT u.id) AS c FROM app_user u
    JOIN app_user_role ur ON ur.user_id = u.id
    JOIN app_role_permission rp ON rp.role_id = ur.role_id AND rp.permission = 'security:manage'
    WHERE u.status = 'active' AND u.all_orgs = 1`).get() as { c: number };
  if (row.c === 0) {
    throw new AppError('LAST_ADMIN', '该操作会使系统没有可用的授权管理员(启用、全组织、具备用户与角色管理权限),已拒绝', 409);
  }
}

function revokeUserSessions(db: DB, userId: number, exceptSessionId?: string): void {
  db.prepare('UPDATE app_session SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL AND id != ?')
    .run(nowIso(), userId, exceptSessionId ?? '');
}

/* ============ 用户维护 ============ */

export interface UserInput {
  username?: unknown;
  displayName?: unknown;
  password?: unknown;
  status?: unknown;
  allOrgs?: unknown;
  roleIds?: unknown;
  orgIds?: unknown;
  mustChangePassword?: unknown;
}

export function createUser(db: DB, input: UserInput): PublicUser {
  const username = validUsername(input.username);
  const displayName = input.displayName === undefined ? username : text(input.displayName, '显示名', 64);
  const password = validatePasswordPolicy(input.password, username);
  const roleIds = idList(input.roleIds, '角色');
  const orgIds = idList(input.orgIds, '组织范围');
  const allOrgs = input.allOrgs === true;
  if (!allOrgs && orgIds.length === 0 && roleIds.length > 0) {
    // 无组织授权的用户仍可存在(例如只做系统设置),但给出明确的空范围,不隐式放开全部组织
  }
  const hash = hashPassword(password);
  const tx = db.transaction(() => {
    if (db.prepare('SELECT 1 FROM app_user WHERE username = ?').get(username)) {
      throw new AppError('USERNAME_TAKEN', '用户名已存在', 409);
    }
    assertRolesExist(db, roleIds);
    assertOrgsExist(db, orgIds);
    const now = nowIso();
    const id = Number(db.prepare(`INSERT INTO app_user (username, display_name, password_hash, status, all_orgs, must_change_password, created_at, updated_at)
      VALUES (?, ?, ?, 'active', ?, ?, ?, ?)`).run(username, displayName, hash, allOrgs ? 1 : 0, input.mustChangePassword === false ? 0 : 1, now, now).lastInsertRowid);
    const insRole = db.prepare('INSERT INTO app_user_role (user_id, role_id) VALUES (?, ?)');
    for (const r of roleIds) insRole.run(id, r);
    const insOrg = db.prepare('INSERT INTO app_user_org_scope (user_id, org_id) VALUES (?, ?)');
    for (const o of orgIds) insOrg.run(id, o);
    writeLog(db, 'security.user.create', 'app_user', id, { username, roleIds, orgIds, allOrgs });
    return id;
  });
  return getUser(db, tx());
}

export function updateUser(db: DB, id: number, input: UserInput, actor?: AuthContext): PublicUser {
  // 口令哈希(scrypt)耗时较长,在写事务之外完成
  const newHash = input.password !== undefined
    ? hashPassword(validatePasswordPolicy(input.password, getUserRow(db, id).username))
    : null;
  const tx = db.transaction(() => {
    const row = getUserRow(db, id);
    const changes: Record<string, unknown> = {};
    const now = nowIso();
    if (input.displayName !== undefined) {
      const v = text(input.displayName, '显示名', 64);
      db.prepare('UPDATE app_user SET display_name = ?, updated_at = ? WHERE id = ?').run(v, now, id);
      changes.displayName = v;
    }
    let authChanged = false;
    if (input.status !== undefined) {
      if (input.status !== 'active' && input.status !== 'disabled') throw Errors.validation('状态只能是 active 或 disabled');
      if (input.status !== row.status) {
        if (actor && actor.userId === id && input.status === 'disabled') throw Errors.validation('不能停用当前登录的自己');
        db.prepare('UPDATE app_user SET status = ?, updated_at = ? WHERE id = ?').run(input.status, now, id);
        changes.status = input.status;
        authChanged = true;
      }
    }
    if (input.allOrgs !== undefined) {
      if (typeof input.allOrgs !== 'boolean') throw Errors.validation('allOrgs 必须是布尔值');
      db.prepare('UPDATE app_user SET all_orgs = ?, updated_at = ? WHERE id = ?').run(input.allOrgs ? 1 : 0, now, id);
      changes.allOrgs = input.allOrgs;
      authChanged = true;
    }
    if (input.roleIds !== undefined) {
      const roleIds = idList(input.roleIds, '角色');
      assertRolesExist(db, roleIds);
      db.prepare('DELETE FROM app_user_role WHERE user_id = ?').run(id);
      const ins = db.prepare('INSERT INTO app_user_role (user_id, role_id) VALUES (?, ?)');
      for (const r of roleIds) ins.run(id, r);
      changes.roleIds = roleIds;
      authChanged = true;
    }
    if (input.orgIds !== undefined) {
      const orgIds = idList(input.orgIds, '组织范围');
      assertOrgsExist(db, orgIds);
      db.prepare('DELETE FROM app_user_org_scope WHERE user_id = ?').run(id);
      const ins = db.prepare('INSERT INTO app_user_org_scope (user_id, org_id) VALUES (?, ?)');
      for (const o of orgIds) ins.run(id, o);
      changes.orgIds = orgIds;
      authChanged = true;
    }
    if (newHash !== null) {
      db.prepare('UPDATE app_user SET password_hash = ?, must_change_password = 1, updated_at = ? WHERE id = ?').run(newHash, now, id);
      changes.passwordReset = true;
      revokeUserSessions(db, id);
    }
    if (authChanged) {
      db.prepare('UPDATE app_user SET updated_at = ? WHERE id = ?').run(now, id);
      assertAdminRemains(db);
      // 停用立即使会话失效;角色/范围变化在下一请求重新加载,无需吊销会话
      if (changes.status === 'disabled') revokeUserSessions(db, id);
    }
    writeLog(db, 'security.user.update', 'app_user', id, changes);
  });
  tx();
  return getUser(db, id);
}

export function changeOwnPassword(db: DB, auth: AuthContext, currentPassword: unknown, newPassword: unknown): void {
  const row = getUserRow(db, auth.userId);
  if (typeof currentPassword !== 'string' || !verifyPassword(currentPassword, row.password_hash)) {
    throw new AppError('AUTH_FAILED', '当前口令不正确', 400);
  }
  const pw = validatePasswordPolicy(newPassword, row.username);
  if (verifyPassword(pw, row.password_hash)) throw new AppError('PASSWORD_POLICY', '新口令不能与当前口令相同', 400);
  const hash = hashPassword(pw);
  const tx = db.transaction(() => {
    db.prepare('UPDATE app_user SET password_hash = ?, must_change_password = 0, updated_at = ? WHERE id = ?').run(hash, nowIso(), row.id);
    revokeUserSessions(db, row.id, auth.sessionId);
    writeLog(db, 'security.password.change', 'app_user', row.id, {});
  });
  tx();
}

/* ============ 角色维护 ============ */

export interface RoleInput {
  code?: unknown;
  name?: unknown;
  description?: unknown;
  permissions?: unknown;
}

function permissionList(value: unknown): Permission[] {
  if (!Array.isArray(value)) throw Errors.validation('permissions 必须是数组');
  const bad = value.filter((p) => !isPermission(p));
  if (bad.length) throw Errors.validation(`未知权限码: ${bad.map(String).join(', ')}`);
  return [...new Set(value as Permission[])];
}

export function createRole(db: DB, input: RoleInput): PublicRole {
  const code = text(input.code, '角色编码', 64, 2);
  if (!/^[a-z][a-z0-9_]*$/.test(code)) throw Errors.validation('角色编码只能是小写字母开头的字母、数字、下划线');
  const name = text(input.name, '角色名称', 64);
  const description = input.description === undefined ? '' : text(input.description, '角色说明', 256, 0);
  const permissions = permissionList(input.permissions ?? []);
  const tx = db.transaction(() => {
    if (db.prepare('SELECT 1 FROM app_role WHERE code = ?').get(code)) throw new AppError('ROLE_CODE_TAKEN', '角色编码已存在', 409);
    const now = nowIso();
    const id = Number(db.prepare('INSERT INTO app_role (code, name, description, locked, created_at, updated_at) VALUES (?, ?, ?, 0, ?, ?)')
      .run(code, name, description, now, now).lastInsertRowid);
    const ins = db.prepare('INSERT INTO app_role_permission (role_id, permission) VALUES (?, ?)');
    for (const p of permissions) ins.run(id, p);
    writeLog(db, 'security.role.create', 'app_role', id, { code, permissions });
    return id;
  });
  const id = tx();
  return listRoles(db).find((r) => r.id === id)!;
}

export function updateRole(db: DB, id: number, input: RoleInput): PublicRole {
  const tx = db.transaction(() => {
    const role = db.prepare('SELECT * FROM app_role WHERE id = ?').get(id) as RoleRow | undefined;
    if (!role) throw Errors.notFound('角色');
    if (role.locked) throw new AppError('ROLE_LOCKED', '内置管理员角色不可修改', 409);
    const now = nowIso();
    const changes: Record<string, unknown> = {};
    if (input.name !== undefined) { const v = text(input.name, '角色名称', 64); db.prepare('UPDATE app_role SET name = ?, updated_at = ? WHERE id = ?').run(v, now, id); changes.name = v; }
    if (input.description !== undefined) { const v = text(input.description, '角色说明', 256, 0); db.prepare('UPDATE app_role SET description = ?, updated_at = ? WHERE id = ?').run(v, now, id); changes.description = v; }
    if (input.permissions !== undefined) {
      const permissions = permissionList(input.permissions);
      db.prepare('DELETE FROM app_role_permission WHERE role_id = ?').run(id);
      const ins = db.prepare('INSERT INTO app_role_permission (role_id, permission) VALUES (?, ?)');
      for (const p of permissions) ins.run(id, p);
      changes.permissions = permissions;
      assertAdminRemains(db);
    }
    writeLog(db, 'security.role.update', 'app_role', id, changes);
  });
  tx();
  return listRoles(db).find((r) => r.id === id)!;
}

/** 复制角色:权限原样带出(内置管理员角色也可作为模板),新角色不锁定、不带用户。 */
export function copyRole(db: DB, id: number, input: RoleInput): PublicRole {
  const src = db.prepare('SELECT * FROM app_role WHERE id = ?').get(id) as RoleRow | undefined;
  if (!src) throw Errors.notFound('角色');
  const permissions = (db.prepare('SELECT permission FROM app_role_permission WHERE role_id = ? ORDER BY permission').all(id) as { permission: string }[])
    .map((p) => p.permission).filter(isPermission);
  return db.transaction(() => {
    const role = createRole(db, {
      code: input.code, name: input.name ?? `${src.name}(副本)`,
      description: input.description ?? (src.description ? `${src.description}(复制自 ${src.code})` : `复制自 ${src.code}`), permissions,
    });
    writeLog(db, 'security.role.copy', 'app_role', role.id, { fromRoleId: id, fromCode: src.code });
    return role;
  })();
}

export function deleteRole(db: DB, id: number): void {
  const tx = db.transaction(() => {
    const role = db.prepare('SELECT * FROM app_role WHERE id = ?').get(id) as RoleRow | undefined;
    if (!role) throw Errors.notFound('角色');
    if (role.locked) throw new AppError('ROLE_LOCKED', '内置管理员角色不可删除', 409);
    const used = (db.prepare('SELECT COUNT(*) AS c FROM app_user_role WHERE role_id = ?').get(id) as { c: number }).c;
    if (used > 0) throw new AppError('ROLE_IN_USE', `角色仍分配给 ${used} 个用户,请先解除`, 409);
    db.prepare('DELETE FROM app_role WHERE id = ?').run(id);
    writeLog(db, 'security.role.delete', 'app_role', id, { code: role.code });
  });
  tx();
}

/* ============ 首个管理员(显式操作) ============ */

/**
 * 创建首个管理员:仅当库内没有任何用户时允许。不存在默认口令或隐式登录。
 * 恢复场景(忘记口令)使用 resetPasswordByUsername,同样只能经 CLI 显式执行。
 */
export function bootstrapAdmin(db: DB, username: string, password: string, displayName?: string): PublicUser {
  ensureBuiltinRoles(db);
  if (userCount(db) > 0) throw new AppError('ALREADY_INITIALIZED', '已存在用户,不能再次初始化首个管理员', 409);
  const adminRole = db.prepare("SELECT id FROM app_role WHERE code = 'admin'").get() as { id: number };
  return createUser(db, { username, password, displayName: displayName ?? username, allOrgs: true, roleIds: [adminRole.id], mustChangePassword: false });
}

export function resetPasswordByUsername(db: DB, username: string, password: string): void {
  const row = db.prepare('SELECT * FROM app_user WHERE username = ?').get(username) as UserRow | undefined;
  if (!row) throw Errors.notFound('用户');
  const hash = hashPassword(validatePasswordPolicy(password, row.username));
  const tx = db.transaction(() => {
    db.prepare("UPDATE app_user SET password_hash = ?, status = 'active', must_change_password = 1, updated_at = ? WHERE id = ?").run(hash, nowIso(), row.id);
    revokeUserSessions(db, row.id);
    writeLog(db, 'security.password.reset', 'app_user', row.id, { via: 'cli' });
  });
  tx();
}

/* ============ 会话 ============ */

const IDLE_TTL_MS = 12 * 3600 * 1000;
const ABSOLUTE_TTL_MS = 7 * 24 * 3600 * 1000;
const TOUCH_INTERVAL_MS = 60 * 1000;

export interface SessionRow {
  id: string;
  user_id: number;
  csrf_token: string;
  created_at: string;
  expires_at: string;
  absolute_expires_at: string;
  last_seen_at: string;
  ip: string;
  user_agent: string;
  revoked_at: string | null;
}

export function tokenId(token: string): string {
  return crypto.createHash('sha256').update(token, 'utf8').digest('hex');
}

export interface IssuedSession {
  token: string;
  sessionId: string;
  csrfToken: string;
  expiresAt: string;
}

export function verifyCredentials(db: DB, username: string, password: string): UserRow | null {
  const row = db.prepare('SELECT * FROM app_user WHERE username = ?').get(username) as UserRow | undefined;
  const ok = verifyPassword(password, row?.password_hash);
  if (!row || !ok) return null;
  return row;
}

export function issueSession(db: DB, userId: number, meta: { ip?: string; userAgent?: string }): IssuedSession {
  const token = crypto.randomBytes(32).toString('hex');
  const csrfToken = crypto.randomBytes(24).toString('hex');
  const now = Date.now();
  const expiresAt = new Date(now + IDLE_TTL_MS).toISOString();
  const absolute = new Date(now + ABSOLUTE_TTL_MS).toISOString();
  const id = tokenId(token);
  const tx = db.transaction(() => {
    db.prepare(`INSERT INTO app_session (id, user_id, csrf_token, created_at, expires_at, absolute_expires_at, last_seen_at, ip, user_agent)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`).run(id, userId, csrfToken, new Date(now).toISOString(), expiresAt, absolute,
      new Date(now).toISOString(), (meta.ip ?? '').slice(0, 64), (meta.userAgent ?? '').slice(0, 256));
    db.prepare('UPDATE app_user SET last_login_at = ? WHERE id = ?').run(new Date(now).toISOString(), userId);
    // 清理过期会话,避免表无限增长
    db.prepare('DELETE FROM app_session WHERE absolute_expires_at < ? OR (revoked_at IS NOT NULL AND revoked_at < ?)')
      .run(new Date(now).toISOString(), new Date(now - ABSOLUTE_TTL_MS).toISOString());
  });
  tx();
  return { token, sessionId: id, csrfToken, expiresAt };
}

/** 解析会话令牌:过期/吊销/用户停用均返回 null;有效时按间隔滑动续期。 */
export function resolveSession(db: DB, token: string | undefined): { session: SessionRow; auth: AuthContext } | null {
  if (!token || !/^[a-f0-9]{64}$/.test(token)) return null;
  const id = tokenId(token);
  const session = db.prepare('SELECT * FROM app_session WHERE id = ?').get(id) as SessionRow | undefined;
  if (!session || session.revoked_at) return null;
  const now = Date.now();
  if (Date.parse(session.expires_at) <= now || Date.parse(session.absolute_expires_at) <= now) return null;
  const auth = loadAuthContext(db, session.user_id, session.id);
  if (!auth) return null;
  if (now - Date.parse(session.last_seen_at) > TOUCH_INTERVAL_MS) {
    const next = new Date(Math.min(now + IDLE_TTL_MS, Date.parse(session.absolute_expires_at))).toISOString();
    db.prepare('UPDATE app_session SET last_seen_at = ?, expires_at = ? WHERE id = ?').run(new Date(now).toISOString(), next, id);
    session.expires_at = next;
  }
  return { session, auth };
}

/* ============ 会话管理(管理员) ============ */

/** 会话对外只暴露句柄(会话 ID 前 16 位,会话 ID 本身是令牌的哈希),不暴露 CSRF 令牌。 */
const sessionHandle = (id: string) => id.slice(0, 16);

export interface PublicSession {
  sid: string; createdAt: string; lastSeenAt: string; expiresAt: string; ip: string; userAgent: string;
  status: 'active' | 'revoked' | 'expired'; revokedAt: string | null; current: boolean;
}

export function listUserSessions(db: DB, userId: number, currentSessionId?: string): { items: PublicSession[] } {
  getUserRow(db, userId);
  const now = Date.now();
  const rows = db.prepare('SELECT * FROM app_session WHERE user_id = ? ORDER BY last_seen_at DESC LIMIT 100').all(userId) as SessionRow[];
  return {
    items: rows.map((s) => ({
      sid: sessionHandle(s.id), createdAt: s.created_at, lastSeenAt: s.last_seen_at, expiresAt: s.expires_at, ip: s.ip, userAgent: s.user_agent,
      status: s.revoked_at ? 'revoked' : Date.parse(s.expires_at) <= now || Date.parse(s.absolute_expires_at) <= now ? 'expired' : 'active',
      revokedAt: s.revoked_at, current: s.id === currentSessionId,
    })),
  };
}

/** 吊销指定会话;不能吊销自己当前使用的会话(请用退出登录)。已吊销/过期的会话幂等返回。 */
export function revokeUserSession(db: DB, userId: number, sid: string, actor?: AuthContext): void {
  if (!/^[a-f0-9]{16}$/.test(sid)) throw Errors.validation('会话标识不合法');
  db.transaction(() => {
    getUserRow(db, userId);
    const s = db.prepare('SELECT id, revoked_at FROM app_session WHERE user_id = ? AND substr(id, 1, 16) = ?').get(userId, sid) as { id: string; revoked_at: string | null } | undefined;
    if (!s) throw Errors.notFound('会话');
    if (actor?.sessionId && s.id === actor.sessionId) throw new AppError('SESSION_CURRENT', '不能吊销当前正在使用的会话,请使用退出登录', 409);
    if (s.revoked_at) return;
    db.prepare('UPDATE app_session SET revoked_at = ? WHERE id = ?').run(nowIso(), s.id);
    writeLog(db, 'security.session.revoke', 'app_user', userId, { sid });
  })();
}

export function revokeSession(db: DB, sessionId: string): void {
  db.prepare('UPDATE app_session SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL').run(nowIso(), sessionId);
}

export function userMustChangePassword(db: DB, userId: number): boolean {
  const row = db.prepare('SELECT must_change_password FROM app_user WHERE id = ?').get(userId) as { must_change_password: number } | undefined;
  return row?.must_change_password === 1;
}

export { ALL_PERMISSIONS };
