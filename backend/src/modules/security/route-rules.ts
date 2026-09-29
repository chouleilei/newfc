import type { Permission } from './permissions';

/**
 * 路由权限表:每个 /api 路由必须命中一条规则,未登记的路由默认拒绝(403)。
 *
 * - method:'GET' 只匹配 GET/HEAD;'WRITE' 匹配 POST/PUT/PATCH/DELETE;'*' 全部。
 * - permission:null 表示“已登录即可”(会话、个人设置等)。
 * - allOrgs:继承的集团口径接口(整版矩阵、全组织导出等)只对全组织用户开放,
 *   受限用户得到 SCOPE_RESTRICTED(403)。已改造为按组织范围过滤的接口去掉该标记,
 *   由 service 按 AuthContext 裁剪。
 *
 * 规则按登记顺序匹配,越具体的写在越前面。
 */
export interface RouteRule {
  method: 'GET' | 'WRITE' | '*';
  pattern: RegExp;
  permission: Permission | null;
  allOrgs?: boolean;
}

const rules: RouteRule[] = [];

export function addRouteRules(list: RouteRule[]): void {
  rules.push(...list);
}

export function matchRouteRule(method: string, path: string): RouteRule | undefined {
  const isRead = method === 'GET' || method === 'HEAD';
  return rules.find((r) => (r.method === '*' || (r.method === 'GET' ? isRead : !isRead)) && r.pattern.test(path));
}

const R = (method: RouteRule['method'], pattern: RegExp, permission: Permission | null, allOrgs = false): RouteRule =>
  ({ method, pattern, permission, allOrgs });

/** 继承自 newbd 的接口。路径不含 /api 前缀。 */
addRouteRules([
  R('*', /^\/health$/, null),
  R('*', /^\/me(\/|$)/, null),

  // 主数据
  R('GET', /^\/org\/tree$/, 'master:read'),
  R('GET', /^\/(org|account)\/check$/, 'master:read', true),
  R('GET', /^\/(account\/tree|metrics|sheets|snapshots(\/\d+)?)$/, 'master:read'),
  R('GET', /^\/master-data\/health$/, 'master:read', true),
  R('WRITE', /^\/(org|account|metrics|sheets)(\/|$)/, 'master:write', true),
  // 主数据扩展(AC-F07):项目按组织范围裁剪;映射影响全局解析,写入限全组织用户;解析预览只读
  R('GET', /^\/master\/(projects|suppliers|mappings)(\/\d+)?$/, 'master:read'),
  R('WRITE', /^\/master\/resolve$/, 'master:read'),
  R('WRITE', /^\/master\/mappings(\/\d+\/retire)?$/, 'master:write', true),
  R('WRITE', /^\/master\/(projects|suppliers)(\/\d+)?$/, 'master:write'),

  // 经营预算
  R('GET', /^\/versions$/, 'budget:read'),
  R('GET', /^\/versions\/\d+$/, 'budget:read'),
  R('GET', /^\/versions\/\d+\//, 'budget:read', true),
  R('WRITE', /^\/versions\/\d+\/(lock|set-current|archive)$/, 'budget:finalize', true),
  R('WRITE', /^\/versions(\/|$)/, 'budget:write', true),
  R('GET', /^\/calculation-rules$/, 'budget:read'),
  R('WRITE', /^\/calculation-rules(\/|$)/, 'budget:write', true),

  // 实际数
  R('GET', /^\/actual\/(years|batches)$/, 'actual:read'),
  R('GET', /^\/actual\/save-requests\/[^/]+$/, 'actual:read'),
  R('GET', /^\/actual\//, 'actual:read', true),
  R('WRITE', /^\/actual\//, 'actual:write', true),
  R('WRITE', /^\/years\/\d+\/(freeze|reopen)$/, 'actual:finalize', true),

  // 分析
  R('GET', /^\/dashboard$/, 'dashboard:read', true),
  R('GET', /^\/report\//, 'analysis:read', true),
  R('GET', /^\/analysis\//, 'analysis:read', true),
  R('GET', /^\/evidence\//, 'analysis:read', true),
  R('GET', /^\/check\/consistency$/, 'master:read', true),

  // 导入导出
  R('GET', /^\/io\/template\/budget$/, 'budget:read'),
  R('GET', /^\/io\/template\/actual$/, 'actual:read'),
  R('GET', /^\/io\/export\/logs$/, 'audit:read'),
  R('GET', /^\/io\/export\/metrics$/, 'master:read'),
  R('GET', /^\/io\/export\//, 'analysis:export', true),
  R('GET', /^\/io\/(import-batches|cleaning\/(templates|aliases))$/, 'import:run'),
  R('*', /^\/io\//, 'import:run', true),

  // 财务转换
  R('*', /^\/finance\//, 'finance_import:manage', true),

  // 系统
  R('GET', /^\/logs$/, 'audit:read'),
  // 任务中心:登录即可访问,服务层按创建者过滤,他人任务 404
  R('GET', /^\/jobs(\/\d+)?$/, null),
  R('WRITE', /^\/jobs\/\d+\/cancel$/, null),
  R('GET', /^\/model-calls(\/stats)?$/, 'tasks:read', true),
  R('*', /^\/(backup|migrations)(\/|$)/, 'system:backup', true),
  R('GET', /^\/settings\//, 'settings:read'),
  R('WRITE', /^\/settings\//, 'settings:manage'),
  R('*', /^\/security\//, 'security:manage'),

  // AI 助手:继承的事实查询按集团口径,受限用户暂不开放(T-2 改造为按范围裁剪)
  R('*', /^\/assistant\//, 'assistant:use', true),
]);
