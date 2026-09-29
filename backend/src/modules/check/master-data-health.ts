/**
 * 主数据健康体检(AI 功能增强计划 §四.阶段三)。
 *
 * 约 95% 为确定性检测:全部为 SQL/树算法,同步路径零模型调用。
 * issue 结构对齐 budgetQualityReport(code/severity/message/orgId?/accountId?),
 * 每个 code 有静态帮助文案(为什么是问题/影响/怎么处理),命中行可定位到主数据节点。
 *
 * 分级 taxonomy:
 * - blocking:结构完整性问题(孤儿/自指/循环/类型不一致/编码顺序颠倒),直接影响树可用性;
 * - warning:命名一致性与存量数据卫生(异父同名、首尾空格、全半角、停用节点存量数据);
 * - info:长期零数据叶子等观察项。
 */

import type { DB } from '../../db/connection';
import { computeLeafIds, pathOf } from '../../core/tree';
import type { TreeNodeRow } from '../../core/tree';
import { listOrgRows, type OrgRow } from '../org/org.service';
import { listAccountRows, type AccountRow } from '../account/account.service';

/**
 * 「长期零数据」的观察窗口年数。窗口按数据自身最大年度回溯,不用挂钟年份:
 * 否则同一份库在不同时间体检会得出不同结论,测试也无法复现。
 */
const ZERO_DATA_YEARS = 3;

export type MasterDataSeverity = 'blocking' | 'warning' | 'info';

export interface MasterDataIssue {
  code: string;
  severity: MasterDataSeverity;
  message: string;
  orgId?: number;
  accountId?: number;
  /** 关联的第二个节点(异父同名/编码顺序颠倒的成对命中)。 */
  relatedOrgId?: number;
  relatedAccountId?: number;
}

export interface MasterDataHelp {
  why: string;
  impact: string;
  fix: string;
}

/** 按 code 查表的静态帮助文案,不经模型。 */
export const MASTER_DATA_HELP: Record<string, MasterDataHelp> = {
  ORPHAN_NODE: {
    why: '节点的父节点 id 在主数据中不存在',
    impact: '树无法正确构建,该节点及其子树在编制/汇总中不可见或位置异常',
    fix: '把节点移动到存在的父节点下,或删除该孤儿节点',
  },
  SELF_PARENT: {
    why: '节点的父节点是自身',
    impact: '树遍历形成环,构建与汇总结果不可预期',
    fix: '把节点移动到正确的父节点下',
  },
  CYCLE: {
    why: '沿父链回溯时再次遇到已访问节点,链路成环',
    impact: '树无法构建为合法层级,汇总与快照可能异常',
    fix: '断开环:把环中某个节点移动到环外的父节点下',
  },
  INVALID_STATUS: {
    why: '节点状态不是 active/inactive(通常是历史数据或手工改库所致)',
    impact: '状态过滤口径不一致,节点可能既不显示也不能引用',
    fix: '在数据库中把状态改回 active 或 inactive',
  },
  TYPE_MISMATCH: {
    why: '子科目类型与父科目类型不一致',
    impact: '利润方向符号与汇总口径被破坏,报表取数失真',
    fix: '把子科目移动到同类型父科目下,或调整父科目类型',
  },
  SIBLING_CODE_ORDER: {
    why: '同一父节点下,sort_order 在前的节点编码字典序反而更大(如 02 排在 01 前)',
    impact: '提醒级;不阻断业务,但同级展示顺序与编码直觉不一致,容易误读',
    fix: '调整节点的同级排序值,使展示顺序与编码顺序一致',
  },
  DUPLICATE_NAME: {
    why: '不同父节点下存在同名节点(跨分支重名)',
    impact: '导入与映射按名称匹配时容易选错目标;报表阅读易混淆',
    fix: '为同名节点改名以区分(如加上区域/业务前缀)',
  },
  NAME_FORMAT: {
    why: '名称首尾有空格、含连续空格,或混用全角/半角字符',
    impact: '按名称精确匹配(导入、别名、映射)会因不可见字符失配',
    fix: '改名去掉首尾空格、合并连续空格,统一全半角',
  },
  QUANTITY_UNIT_MISSING: {
    why: '数量型科目未设置计量单位(服务层会拦截,此处兜底存量脏数据)',
    impact: '数量录入与展示缺少单位,口径不可读',
    fix: '在科目管理中为该科目补充计量单位(如 万度 / % / 人)',
  },
  INACTIVE_WITH_DATA: {
    why: '节点已停用,但仍存在预算/实际存量数据引用',
    impact: '提醒级;存量数据保留参与汇总是设计行为,但长期存在说明迁移未完成',
    fix: '确认存量数据是否已迁移到替代节点;确认后可忽略,或完成迁移后保持停用',
  },
  ZERO_DATA_LEAF: {
    why: `active 叶子节点在最近 ${ZERO_DATA_YEARS} 个有数年度的预算明细、当前实际与历史快照中,金额与数量均为零(含从未被引用)`,
    impact: '观察项;可能是建而未用的冗余节点或只剩占位的历史节点,增加维护与匹配噪音',
    fix: '确认用途;确属冗余可停用,保留备用的可忽略',
  },
};

/** 结构检查升级后的 issue 形状(org/account 结构检查与体检报告共用)。 */
export interface StructureIssue {
  code: string;
  severity: MasterDataSeverity;
  message: string;
  orgId?: number;
  accountId?: number;
}

interface GenericNode {
  id: number;
  parent_id: number | null;
  code: string;
  name: string;
  sort_order: number;
  status: string;
}

/* ---------------- 结构完整性(组织/科目共用算法) ---------------- */

function structuralIssues(
  rows: GenericNode[],
  kind: 'org' | 'account',
  label: string,
  options: { typeOf?: (row: GenericNode) => string | undefined } = {},
): StructureIssue[] {
  const issues: StructureIssue[] = [];
  const push = (code: string, severity: MasterDataSeverity, message: string, id?: number) => {
    issues.push({
      code,
      severity,
      message,
      ...(kind === 'org' ? (id != null ? { orgId: id } : {}) : (id != null ? { accountId: id } : {})),
    });
  };
  const ids = new Set(rows.map((row) => row.id));
  const byId = new Map(rows.map((row) => [row.id, row]));
  for (const row of rows) {
    if (row.parent_id != null) {
      if (row.parent_id === row.id) push('SELF_PARENT', 'blocking', `${label} ${row.code} 的父节点是自身`, row.id);
      else if (!ids.has(row.parent_id)) push('ORPHAN_NODE', 'blocking', `${label} ${row.code} 的父节点 ${row.parent_id} 不存在(孤儿节点)`, row.id);
      else if (options.typeOf) {
        const parent = byId.get(row.parent_id)!;
        const childType = options.typeOf(row);
        if (childType != null && options.typeOf(parent) !== childType) {
          push('TYPE_MISMATCH', 'blocking', `${label} ${row.code}(${childType}) 与父${label} ${parent.code}(${options.typeOf(parent)}) 类型不一致`, row.id);
        }
      }
    }
    if (row.status !== 'active' && row.status !== 'inactive') push('INVALID_STATUS', 'blocking', `${label} ${row.code} 状态非法: ${row.status}`, row.id);
  }
  // 链式循环检测
  for (const row of rows) {
    const seen = new Set<number>();
    let cur: GenericNode | undefined = row;
    while (cur && cur.parent_id != null) {
      if (seen.has(cur.id)) { push('CYCLE', 'blocking', `${label} ${row.code} 所在链路存在循环`, row.id); break; }
      seen.add(cur.id);
      cur = byId.get(cur.parent_id);
    }
  }
  return issues;
}

/** 组织结构检查(升级形状;checkOrgStructure 保留 {ok,problems} 兼容)。 */
export function orgStructureIssues(db: DB): StructureIssue[] {
  return structuralIssues(listOrgRows(db), 'org', '组织');
}

/** 科目结构检查(升级形状;checkAccountStructure 保留 {ok,problems} 兼容)。 */
export function accountStructureIssues(db: DB): StructureIssue[] {
  return structuralIssues(listAccountRows(db), 'account', '科目', { typeOf: (row) => (row as AccountRow).type });
}

/* ---------------- 命名一致性 ---------------- */

/** 是否混用全角/半角:同一名称里同时出现全角与半角的同类字符(数字、字母或括号)。 */
function mixedWidth(name: string): boolean {
  const hasFullDigit = /[０-９]/.test(name);
  const hasHalfDigit = /[0-9]/.test(name);
  const hasFullAlpha = /[Ａ-Ｚａ-ｚ]/.test(name);
  const hasHalfAlpha = /[A-Za-z]/.test(name);
  const hasFullParen = /[（）]/.test(name);
  const hasHalfParen = /[()]/.test(name);
  return (hasFullDigit && hasHalfDigit) || (hasFullAlpha && hasHalfAlpha) || (hasFullParen && hasHalfParen);
}

function namingIssues(rows: GenericNode[], kind: 'org' | 'account', label: string): MasterDataIssue[] {
  const issues: MasterDataIssue[] = [];
  const ref = (id: number, relatedId?: number) =>
    kind === 'org'
      ? { orgId: id, ...(relatedId != null ? { relatedOrgId: relatedId } : {}) }
      : { accountId: id, ...(relatedId != null ? { relatedAccountId: relatedId } : {}) };

  // 同级编码排序:同父下按 sort_order 排列,编码字典序应单调不减(实现 checkOrgStructure 注释声称的检查)。
  // 仅在用户设置了显式排序值(同组 sort_order 不全相同)时检查:默认全 0 时展示顺序是录入顺序,不构成编码顺序声明,不作误报。
  const byParent = new Map<string, GenericNode[]>();
  for (const row of rows) {
    const key = String(row.parent_id ?? 'root');
    const list = byParent.get(key) ?? [];
    list.push(row);
    byParent.set(key, list);
  }
  for (const siblings of byParent.values()) {
    if (new Set(siblings.map((row) => row.sort_order)).size < 2) continue;
    const ordered = [...siblings].sort((a, b) => a.sort_order - b.sort_order || a.id - b.id);
    let maxCode = '';
    for (const row of ordered) {
      if (row.code.localeCompare(maxCode) < 0) {
        issues.push({
          code: 'SIBLING_CODE_ORDER',
          severity: 'warning',
          message: `${label} ${row.code} 按同级排序值(${row.sort_order})展示在编码更大的节点(${maxCode})之后:展示顺序与编码顺序不一致`,
          ...ref(row.id),
        });
      }
      if (row.code.localeCompare(maxCode) > 0) maxCode = row.code;
    }
  }

  // 异父同名:不同父节点下出现完全相同名称。
  const byName = new Map<string, GenericNode[]>();
  for (const row of rows) {
    const list = byName.get(row.name) ?? [];
    list.push(row);
    byName.set(row.name, list);
  }
  for (const [name, list] of byName) {
    const parents = new Set(list.map((row) => row.parent_id));
    if (list.length > 1 && parents.size > 1) {
      for (const row of list) {
        const other = list.find((candidate) => candidate.id !== row.id)!;
        issues.push({
          code: 'DUPLICATE_NAME',
          severity: 'warning',
          message: `${label}「${name}」在不同父节点下重复出现(另一处为 ${other.code}),按名称匹配时容易混淆`,
          ...ref(row.id, other.id),
        });
      }
    }
  }

  // 名称格式:首尾空格、连续空格、全半角混用。
  for (const row of rows) {
    const reasons: string[] = [];
    if (row.name !== row.name.trim()) reasons.push('首尾存在空格');
    if (/ {2,}|\t|　/.test(row.name)) reasons.push('含连续空格或制表/全角空格');
    if (mixedWidth(row.name)) reasons.push('全角与半角字符混用');
    if (reasons.length > 0) {
      issues.push({
        code: 'NAME_FORMAT',
        severity: 'warning',
        message: `${label} ${row.code} 名称格式不规范(${reasons.join('、')}):「${row.name}」`,
        ...ref(row.id),
      });
    }
  }
  return issues;
}

/* ---------------- 数据引用与设置 ---------------- */

/**
 * 数据引用统计。
 *
 * 区分三档,因为「长期零数据」和「从未被引用」不是一回事:
 * - referenced:任何年份出现过(含全零行),用于判断停用节点是否还有存量数据;
 * - nonZeroRecent:观察窗口内出现过非零金额/数量,这才是「在用」的证据。
 *   观察窗口按数据自身的最大年度回溯 ZERO_DATA_YEARS 年(不用挂钟年份,
 *   否则同一份库在不同时间跑出不同结论,测试也不可复现)。
 */
function referenceStats(db: DB): {
  orgIds: Set<number>;
  accountIds: Set<number>;
  nonZeroRecentOrgIds: Set<number>;
  nonZeroRecentAccountIds: Set<number>;
  windowFromYear: number | null;
  windowToYear: number | null;
} {
  const orgIds = new Set<number>();
  const accountIds = new Set<number>();
  const nonZeroRecentOrgIds = new Set<number>();
  const nonZeroRecentAccountIds = new Set<number>();
  const collect = (sql: string, params: unknown[], into: Set<number>, column: string) => {
    for (const row of db.prepare(sql).all(...(params as never[])) as Record<string, number>[]) into.add(row[column]);
  };
  collect('SELECT DISTINCT org_id FROM budget_entry', [], orgIds, 'org_id');
  collect('SELECT DISTINCT account_id FROM budget_entry', [], accountIds, 'account_id');
  collect('SELECT DISTINCT org_id FROM actual_current', [], orgIds, 'org_id');
  collect('SELECT DISTINCT account_id FROM actual_current', [], accountIds, 'account_id');
  collect('SELECT DISTINCT org_id FROM actual_snapshot_entry', [], orgIds, 'org_id');
  collect('SELECT DISTINCT account_id FROM actual_snapshot_entry', [], accountIds, 'account_id');

  // 观察窗口:数据自身最大年度往前 ZERO_DATA_YEARS 年
  const maxYear = (db.prepare(
    `SELECT MAX(y) AS y FROM (
       SELECT MAX(year) AS y FROM budget_version
       UNION ALL SELECT MAX(year) AS y FROM actual_snapshot_batch
       UNION ALL SELECT MAX(year) AS y FROM actual_current
     )`,
  ).get() as { y: number | null }).y;
  if (maxYear == null) {
    return { orgIds, accountIds, nonZeroRecentOrgIds, nonZeroRecentAccountIds, windowFromYear: null, windowToYear: null };
  }
  const fromYear = maxYear - (ZERO_DATA_YEARS - 1);
  const nonZero = '(COALESCE(%amount%, 0) <> 0 OR COALESCE(quantity, 0) <> 0)';
  const budgetSql = `SELECT DISTINCT e.org_id, e.account_id FROM budget_entry e
     JOIN budget_version v ON v.id = e.version_id
     WHERE v.year >= ? AND ${nonZero.replace('%amount%', 'e.amount_cents')}`;
  const currentSql = `SELECT DISTINCT org_id, account_id FROM actual_current
     WHERE year >= ? AND ${nonZero.replace('%amount%', 'cumulative_amount_cents')}`;
  const snapshotSql = `SELECT DISTINCT e.org_id, e.account_id FROM actual_snapshot_entry e
     JOIN actual_snapshot_batch b ON b.id = e.batch_id
     WHERE b.year >= ? AND ${nonZero.replace('%amount%', 'e.cumulative_amount_cents')}`;
  for (const sql of [budgetSql, currentSql, snapshotSql]) {
    for (const row of db.prepare(sql).all(fromYear) as { org_id: number; account_id: number }[]) {
      nonZeroRecentOrgIds.add(row.org_id);
      nonZeroRecentAccountIds.add(row.account_id);
    }
  }
  return { orgIds, accountIds, nonZeroRecentOrgIds, nonZeroRecentAccountIds, windowFromYear: fromYear, windowToYear: maxYear };
}

/* ---------------- 报告组装 ---------------- */

export interface MasterDataHealthGroup {
  code: string;
  severity: MasterDataSeverity;
  count: number;
  summary: string;
}

const CODE_LABEL: Record<string, string> = {
  ORPHAN_NODE: '孤儿节点',
  SELF_PARENT: '父节点自指',
  CYCLE: '链路循环',
  INVALID_STATUS: '状态非法',
  TYPE_MISMATCH: '父子类型不一致',
  SIBLING_CODE_ORDER: '同级编码顺序不一致',
  DUPLICATE_NAME: '异父同名',
  NAME_FORMAT: '名称格式不规范',
  QUANTITY_UNIT_MISSING: '数量科目缺计量单位',
  INACTIVE_WITH_DATA: '停用节点存在存量数据',
  ZERO_DATA_LEAF: '长期零数据叶子',
};

/** 路径文案:结构损坏(循环/孤儿)时 pathOf 会抛错,降级为 #id,保证体检报告自身永远可用。 */
function safePath(rows: TreeNodeRow[], id: number): string {
  try {
    return pathOf(rows, id);
  } catch {
    return `#${id}`;
  }
}

export function groupMasterDataIssues(issues: MasterDataIssue[]): MasterDataHealthGroup[] {
  const order = new Map<string, MasterDataIssue[]>();
  for (const issue of issues) {
    const list = order.get(issue.code) ?? [];
    list.push(issue);
    order.set(issue.code, list);
  }
  return [...order.entries()].map(([code, list]) => ({
    code,
    severity: list[0].severity,
    count: list.length,
    summary: `${CODE_LABEL[code] ?? code}共 ${list.length} 条`,
  }));
}

const SEVERITY_ORDER: Record<MasterDataSeverity, number> = { blocking: 0, warning: 1, info: 2 };

export function masterDataHealthReport(db: DB): {
  issueCount: number;
  blockingCount: number;
  warningCount: number;
  infoCount: number;
  issues: MasterDataIssue[];
  groups: MasterDataHealthGroup[];
  help: Record<string, MasterDataHelp>;
} {
  const orgRows = listOrgRows(db);
  const accountRows = listAccountRows(db);
  const issues: MasterDataIssue[] = [];

  // 1. 结构完整性(与升级后的结构检查同一信号源,避免两套判定)
  issues.push(...orgStructureIssues(db), ...accountStructureIssues(db));

  // 2. 命名一致性
  issues.push(...namingIssues(orgRows, 'org', '组织'), ...namingIssues(accountRows, 'account', '科目'));

  // 3. 必填设置缺漏:数量型科目必须有计量单位(存量脏数据兜底)
  for (const row of accountRows) {
    if (row.type === 'quantity' && !row.unit.trim()) {
      issues.push({
        code: 'QUANTITY_UNIT_MISSING',
        severity: 'warning',
        message: `科目 ${row.code} ${row.name} 是数量型科目但未设置计量单位`,
        accountId: row.id,
      });
    }
  }

  // 4. 停用节点存量数据 + 5. 长期零数据叶子
  const stats = referenceStats(db);
  const orgLeaves = computeLeafIds(orgRows);
  const accountLeaves = computeLeafIds(accountRows);
  // 「长期零数据」= 观察窗口内没有任何非零金额/数量。分两种成因分别叙述:
  // 从未被引用(建而未用)与被引用但一直是零(占位行),处理动作不同。
  const windowText = stats.windowFromYear == null
    ? '系统中还没有任何年度数据'
    : `${stats.windowFromYear}–${stats.windowToYear} 年`;
  const zeroDataMessage = (label: string, row: { code: string; name: string }, path: string, everReferenced: boolean): string => (
    everReferenced
      ? `${label} ${row.code} ${row.name}(${path})是 active 叶子,但${windowText}的预算与实际中金额、数量均为零(长期零数据)`
      : `${label} ${row.code} ${row.name}(${path})是 active 叶子,但从未出现在任何预算或实际数据中(建而未用)`
  );
  for (const row of orgRows) {
    if (row.status === 'inactive' && stats.orgIds.has(row.id)) {
      issues.push({
        code: 'INACTIVE_WITH_DATA',
        severity: 'warning',
        message: `组织 ${row.code} ${row.name} 已停用,但仍存在预算/实际存量数据`,
        orgId: row.id,
      });
    } else if (row.status === 'active' && orgLeaves.has(row.id) && !stats.nonZeroRecentOrgIds.has(row.id)) {
      issues.push({
        code: 'ZERO_DATA_LEAF',
        severity: 'info',
        message: zeroDataMessage('组织', row, safePath(orgRows, row.id), stats.orgIds.has(row.id)),
        orgId: row.id,
      });
    }
  }
  for (const row of accountRows) {
    if (row.status === 'inactive' && stats.accountIds.has(row.id)) {
      issues.push({
        code: 'INACTIVE_WITH_DATA',
        severity: 'warning',
        message: `科目 ${row.code} ${row.name} 已停用,但仍存在预算/实际存量数据`,
        accountId: row.id,
      });
    } else if (row.status === 'active' && accountLeaves.has(row.id) && !stats.nonZeroRecentAccountIds.has(row.id)) {
      issues.push({
        code: 'ZERO_DATA_LEAF',
        severity: 'info',
        message: zeroDataMessage('科目', row, safePath(accountRows, row.id), stats.accountIds.has(row.id)),
        accountId: row.id,
      });
    }
  }

  issues.sort((a, b) => SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity] || a.code.localeCompare(b.code));
  const help: Record<string, MasterDataHelp> = {};
  for (const issue of issues) {
    if (MASTER_DATA_HELP[issue.code]) help[issue.code] = MASTER_DATA_HELP[issue.code];
  }
  return {
    issueCount: issues.length,
    blockingCount: issues.filter((issue) => issue.severity === 'blocking').length,
    warningCount: issues.filter((issue) => issue.severity === 'warning').length,
    infoCount: issues.filter((issue) => issue.severity === 'info').length,
    issues,
    groups: groupMasterDataIssues(issues),
    help,
  };
}

/** 供 /org/check 与 /account/check 使用:{ok, problems} 兼容 + issues 结构。 */
export function structureCheckPayload(issues: StructureIssue[]): { ok: boolean; problems: string[]; issues: StructureIssue[] } {
  return { ok: issues.length === 0, problems: issues.map((issue) => issue.message), issues };
}
