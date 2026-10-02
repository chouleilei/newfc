/**
 * 助手工具授权(AC-F20 / AC-F24 / AC-X04):工具与页面、API 使用同一身份与组织范围。
 *
 * 每个工具登记所需操作权限与组织范围类别:
 * - global:不含组织事实(科目、版本元数据、口径词典等),只校验权限;
 * - org_tree:返回组织树,按范围裁剪;
 * - org_scope:入参带 orgScopeId 的分析工具。受限用户缺省取唯一授权根,多根时要求明确选择,
 *   传入范围外组织按“不存在或无权访问”拒绝——不信任模型/客户端给出的范围;
 * - org_cell:入参带单个 orgId 的穿透工具,受限用户必须给出范围内组织;
 * - all_orgs:整版矩阵、全组织对比、系统级检查等集团口径,受限用户得到 SCOPE_RESTRICTED。
 *
 * 无身份上下文(CLI/系统任务/单元测试直接调用)时不做裁剪,与 service 层约定一致。
 */
import type { DB } from '../db/connection';
import { AppError } from '../core/errors';
import { currentAuth, type AuthContext } from '../core/request-context';
import type { Permission } from '../contracts/permissions';
import { assertOrgVisible, currentOrgScopeId, effectiveOrgScopeId, orgInScope, requireAllOrgs, resolveOrgScope } from '../modules/security/scope';

import { toolDefinition, toolPolicy } from './tools';
import type { ToolPolicy } from './tool-definition';

/** 工具在当前身份下是否可用(用于向模型暴露的工具清单,避免诱导模型反复调用必然被拒的工具)。 */
export function toolAllowed(name: string, auth: AuthContext | undefined = currentAuth()): boolean {
  const policy = toolPolicy(name);
  if (!policy) {
    const definition = toolDefinition(name);
    if (!definition || typeof definition.policy !== 'function') return false;
    const field = definition.schema.shape.kind;
    const values: string[] = field && 'options' in field ? field.options : [];
    return values.some((kind) => { const p = toolPolicy(name, { kind }); return p && (!auth || auth.permissions.has(p.permission)); });
  }
  if (!auth) return true;
  if (!auth.permissions.has(policy.permission)) return false;
  return policy.scope !== 'all_orgs' || auth.allOrgs;
}

function toolDenied(name: string, permission: Permission): AppError {
  return new AppError('FORBIDDEN', `当前账号没有使用该查询的权限(${name} 需要 ${permission})`, 403);
}

/**
 * 在调用工具实现前执行授权并改写范围参数。返回改写后的参数数组(不修改入参)。
 * args 为工具实现的位置参数(不含 db)。
 */
export function authorizeToolCall(db: DB, name: string, args: Record<string, unknown>): Record<string, unknown> {
  const policy = toolPolicy(name, args);
  if (!policy) throw new AppError('FORBIDDEN', `工具 ${name} 未登记授权策略,拒绝执行`, 403);
  const auth = currentAuth();
  if (!auth) return args;
  if (!auth.permissions.has(policy.permission)) throw toolDenied(name, policy.permission);
  if (auth.allOrgs) return args;
  switch (policy.scope) {
    case 'global':
    case 'org_tree':
      return args;
    case 'all_orgs':
      requireAllOrgs(auth, `查询「${name}」`);
      return args;
    case 'org_scope': {
      const input = { ...args };
      /* 年度复盘(历年对比/准确率)与编制讨论(整版质量检查)含集团口径章节,
         只有月度执行报告完整按组织范围计算。 */
      if (name === 'generate_report' && input.kind !== 'monthly_execution') {
        requireAllOrgs(auth, `报告「${String(input.kind)}」`);
      }
      const requested = input.orgScopeId == null ? null : Number(input.orgScopeId);
      input.orgScopeId = effectiveOrgScopeId(db, auth, requested);
      if (Array.isArray(input.orgCodes)) {
        const scope = resolveOrgScope(db, auth);
        for (const code of input.orgCodes as string[]) {
          const row = db.prepare('SELECT id FROM org WHERE code = ?').get(code) as { id: number } | undefined;
          if (!row || !orgInScope(scope, row.id)) throw new AppError('NOT_FOUND', `组织 ${code} 不存在或无权访问`, 404);
        }
      }
      return input;
    }
    case 'org_cell': {
      const input = args;
      if (input.orgId == null) {
        throw new AppError('SCOPE_REQUIRED', '当前账号只授权了部分组织,请指定要穿透的组织', 400);
      }
      assertOrgVisible(db, auth, Number(input.orgId));
      return args;
    }
  }
}

/** 组织树工具的范围过滤器:受限用户只看授权子树。 */
export function orgTreeFilter(db: DB): ((orgId: number) => boolean) | undefined {
  const auth = currentAuth();
  if (!auth || auth.allOrgs) return undefined;
  const scope = resolveOrgScope(db, auth);
  return (id) => orgInScope(scope, id);
}

/**
 * service 内直接调用领域服务(不经工具表)时的组织范围:受限用户按 effectiveOrgScopeId
 * 取值——范围外拒绝,缺省取唯一授权根,多根要求明确选择;全组织用户与无身份上下文原样返回。
 */
export function scopedOrgId(db: DB, requested: number | null | undefined): number | null {
  return currentOrgScopeId(db, requested);
}

/** 需要集团口径的直接调用(整版导出、写操作等):受限用户得到 SCOPE_RESTRICTED。 */
export function requireAllOrgsForAction(what: string): void {
  const auth = currentAuth();
  if (auth && !auth.allOrgs) requireAllOrgs(auth, what);
}

/** 直接调用前的操作权限校验(与路由权限表同一套权限码)。 */
export function requireActionPermission(permission: Permission, what: string): void {
  const auth = currentAuth();
  if (auth && !auth.permissions.has(permission)) {
    throw new AppError('FORBIDDEN', `当前账号没有${what}的权限(需要 ${permission})`, 403);
  }
}
