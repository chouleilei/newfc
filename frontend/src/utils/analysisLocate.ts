/**
 * 跨页定位解析(方案《易用性与直觉化交互实施方案》§4.1,任务 UX-03)。
 *
 * 预警/进度/证据跳转携带的对象 ID 落到目标页后的归属判定与链接生成。
 * 只做只读判定,不改写范围;不能定位时必须给出具体原因,而不是错误高亮或静默。
 */
import type { WorkspaceScope } from './workspaceScope';

/** 预警记录的最小形状(与 AnomalyCenter 的 AnomalyItem 对齐,避免页面类型反向依赖工具)。 */
export interface AnomalyLocateSource {
  dimension: 'account' | 'org' | 'total' | 'quality';
  accountId?: number;
  orgId?: number;
}

/**
 * 预警 → 分析的范围映射:科目维度定位 account,组织维度定位 org;
 * total/quality 没有单一业务对象,只带版本/快照范围,由调用方合并。
 */
export function anomalyLocateScope(source: AnomalyLocateSource): Partial<WorkspaceScope> {
  if (source.dimension === 'account' && source.accountId != null) return { accountScopeId: source.accountId };
  if (source.dimension === 'org' && source.orgId != null) return { orgScopeId: source.orgId };
  return {};
}

export type LocateStatus =
  /** 目标在当前展示行中,直接展开定位/高亮。 */
  | 'visible'
  /** 目标在计算口径内,但被展示规则(预算表格折叠、汇总层级)收起。 */
  | 'hidden_by_display'
  /** 目标存在于当前主数据树,但不在版本绑定的树快照中(树调整后历史口径不变)。 */
  | 'not_in_snapshot'
  /** 当前主数据树也查不到(已删除或链接失效)。 */
  | 'not_found';

export interface LocateContext {
  /** 当前展示的行的 ID 集合(分析页 byAccount / byOrg)。 */
  displayIds: ReadonlySet<number>;
  /** 计算口径内的 ID 集合(科目取 analysisAccounts;组织传与 displayIds 相同集合)。 */
  scopeIds: ReadonlySet<number>;
  /** 当前主数据树的 ID 集合(树快照之外的存活证明)。 */
  masterIds: ReadonlySet<number>;
}

/** 只读归属判定:先看展示,再看计算口径,再看主数据存活,逐级给出可解释的原因。 */
export function resolveLocateStatus(id: number, ctx: LocateContext): LocateStatus {
  if (ctx.displayIds.has(id)) return 'visible';
  if (ctx.scopeIds.has(id)) return 'hidden_by_display';
  if (ctx.masterIds.has(id)) return 'not_in_snapshot';
  return 'not_found';
}
