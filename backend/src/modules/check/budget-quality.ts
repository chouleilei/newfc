import type { DB } from '../../db/connection';
import { computeLeafIds, type TreeNodeRow } from '../../core/tree';
import { isAccountVisibleForScope } from '../../core/accountScope';
import { getVersion, validateForLock } from '../budget/budget.service';
import { loadSnapshotNodes } from '../tree/snapshot';
import { listRules } from '../calculation/calculation.service';

/** 预算填报行的最小字段集(质量门禁与进度统计共用的判定输入)。 */
export interface BudgetEntryLike {
  org_id: number;
  account_id: number;
  amount_cents: number;
  quantity: number | null;
  formula: string;
  note: string;
}

/**
 * 版本快照口径的"必填单元格"判定:叶子组织 × 可见叶子科目逐格检查。
 * budgetQualityReport 与 progress 服务共用,禁止另写一份规则。
 * 返回每个组织的 filled/total,以及按格产生的 REQUIRED/BASIS 问题。
 */
export function computeRequiredCells(
  leafOrgs: TreeNodeRow[],
  leafAccs: TreeNodeRow[],
  entries: BudgetEntryLike[],
): {
  total: number;
  filled: number;
  perOrg: Map<number, { filled: number; total: number }>;
  issues: BudgetQualityIssue[];
} {
  const entryByKey = new Map(entries.map((row) => [`${row.org_id}:${row.account_id}`, row]));
  const issues: BudgetQualityIssue[] = [];
  const perOrg = new Map<number, { filled: number; total: number }>();
  let total = 0;
  let filled = 0;

  for (const org of leafOrgs) {
    let orgFilled = 0;
    let orgTotal = 0;
    for (const acc of leafAccs) {
      if (!isAccountVisibleForScope(acc.code, new Set([org.code]))) continue;
      total++;
      orgTotal++;
      const entry = entryByKey.get(`${org.id}:${acc.id}`);
      if (entry) { filled++; orgFilled++; }
      if (acc.budget_required === 1 && !entry) {
        issues.push({
          code: 'REQUIRED_VALUE_MISSING',
          severity: 'blocking',
          message: `${org.code} ${org.name}：必填科目 ${acc.code} ${acc.name} 尚未填报`,
          orgId: org.id,
          accountId: acc.id,
        });
      }
      if (entry && acc.basis_required === 1 && (entry.amount_cents !== 0 || (entry.quantity ?? 0) !== 0) && !entry.note.trim()) {
        issues.push({
          code: 'BASIS_MISSING',
          severity: 'blocking',
          message: `${org.code} ${org.name}：${acc.code} ${acc.name} 已有数值但缺少测算依据`,
          orgId: org.id,
          accountId: acc.id,
        });
      }
    }
    perOrg.set(org.id, { filled: orgFilled, total: orgTotal });
  }
  return { total, filled, perOrg, issues };
}

/** 版本绑定的树快照取叶子组织/科目(质量门禁与进度统计同一口径)。 */
export function versionSnapshotLeaves(db: DB, versionId: number): {
  version: ReturnType<typeof getVersion>;
  orgRows: TreeNodeRow[];
  accRows: TreeNodeRow[];
  leafOrgs: TreeNodeRow[];
  leafAccs: TreeNodeRow[];
} {
  const version = getVersion(db, versionId);
  const orgRows = loadSnapshotNodes(db, version.org_tree_snapshot_id);
  const accRows = loadSnapshotNodes(db, version.account_tree_snapshot_id);
  return {
    version,
    orgRows,
    accRows,
    leafOrgs: orgRows.filter((row) => computeLeafIds(orgRows).has(row.id) && row.status === 'active'),
    leafAccs: accRows.filter((row) => computeLeafIds(accRows).has(row.id) && row.status === 'active'),
  };
}

export type BudgetQualitySeverity = 'blocking' | 'warning';

export interface BudgetQualityIssue {
  code: string;
  severity: BudgetQualitySeverity;
  message: string;
  /** 明细行序号(仅 STRUCTURE_INVALID 的行级问题携带) */
  row?: number;
  orgId?: number;
  accountId?: number;
  ruleId?: number;
}

/**
 * 五条规则的静态帮助文案(AI 功能增强计划 §四.阶段一.1):
 * 「为什么是问题、影响谁、怎么处理」按 code 查表展示,不经模型。
 */
export interface BudgetQualityHelp {
  why: string;
  impact: string;
  fix: string;
}

export const BUDGET_QUALITY_HELP: Record<string, BudgetQualityHelp> = {
  STRUCTURE_INVALID: {
    why: '明细引用的组织或科目不在版本绑定的树快照中、不是叶子节点、金额超出安全整数范围,或指标公式存在循环',
    impact: '该明细无法按版本口径汇总与追溯;结构问题存在时版本不能定稿',
    fix: '删除或改正异常明细;若主数据已调整,基于最新树重新创建版本',
  },
  REQUIRED_VALUE_MISSING: {
    why: '科目在主数据中被标记为必填,但对应叶子组织尚未填报',
    impact: '未补齐前不能定稿;缺失会让汇总与完成率口径失真',
    fix: '定位到对应单元格补填数值(可以为 0,但必须显式填报)',
  },
  BASIS_MISSING: {
    why: '科目要求填写测算依据,当前已有数值但依据为空',
    impact: '未补齐前不能定稿;事后审计无法追溯数值来源',
    fix: '在该单元格补充测算依据/附注说明',
  },
  CALCULATION_RULE_INVALID: {
    why: '测算模板引用的科目在版本树快照中不存在,模板无法执行',
    impact: '提醒级,不阻断定稿;但该模板对相关组织不再生效',
    fix: '修改模板配置的科目编码,或停用该模板',
  },
  CALCULATION_OUTPUT_MISSING: {
    why: '测算模板的输入参数已填齐,但输出科目尚未试算',
    impact: '提醒级,不阻断定稿;输出科目可能被遗漏,影响数据完整性',
    fix: '执行一次模板试算,或手工填报输出科目',
  },
};

/** 同类问题归并(AI 功能增强计划 §四.阶段一.4):确定性 groupBy,如「3 家单位共 12 个必填科目未填报」。 */
export interface BudgetQualityGroup {
  code: string;
  severity: BudgetQualitySeverity;
  /** 命中问题条数 */
  count: number;
  /** 涉及的不同组织数(无组织维度的问题为 0) */
  orgCount: number;
  /** 涉及的不同科目数(无科目维度的问题为 0) */
  accountCount: number;
  summary: string;
}

function groupSummary(code: string, count: number, orgCount: number, accountCount: number): string {
  switch (code) {
    case 'REQUIRED_VALUE_MISSING':
      return `${orgCount} 家单位共 ${count} 个必填科目未填报`;
    case 'BASIS_MISSING':
      return `${orgCount} 家单位共 ${count} 个科目已有数值但缺少测算依据`;
    case 'STRUCTURE_INVALID':
      return `共 ${count} 条结构问题(组织/科目不在树快照内、非叶子或指标公式循环)`;
    case 'CALCULATION_OUTPUT_MISSING':
      return `${orgCount} 家单位共 ${count} 个测算模板输出未试算`;
    case 'CALCULATION_RULE_INVALID':
      return `共 ${count} 个测算模板引用了不存在的科目`;
    default:
      return `共 ${count} 条问题`;
  }
}

export function groupQualityIssues(issues: BudgetQualityIssue[]): BudgetQualityGroup[] {
  const order = new Map<string, BudgetQualityIssue[]>();
  for (const issue of issues) {
    const list = order.get(issue.code) ?? [];
    list.push(issue);
    order.set(issue.code, list);
  }
  return [...order.entries()].map(([code, list]) => {
    const orgCount = new Set(list.map((issue) => issue.orgId).filter((id): id is number => id != null)).size;
    const accountCount = new Set(list.map((issue) => issue.accountId).filter((id): id is number => id != null)).size;
    return {
      code,
      severity: list[0].severity,
      count: list.length,
      orgCount,
      accountCount,
      summary: groupSummary(code, list.length, orgCount, accountCount),
    };
  });
}

export function budgetQualityReport(db: DB, versionId: number): {
  versionId: number;
  canFinalize: boolean;
  blockingCount: number;
  warningCount: number;
  coverage: { filled: number; total: number; percent: number };
  /** 按叶子组织拆分的覆盖度(computeRequiredCells 同源),供编制进度总览等消费方复用,避免双算。 */
  coverageByOrg: Map<number, { filled: number; total: number }>;
  issues: BudgetQualityIssue[];
  groups: BudgetQualityGroup[];
  /** 按 code 查表的静态帮助文案(仅包含本次命中的 code) */
  help: Record<string, BudgetQualityHelp>;
} {
  const { orgRows, accRows, leafOrgs, leafAccs } = versionSnapshotLeaves(db, versionId);
  const entries = db.prepare(
    `SELECT org_id, account_id, amount_cents, quantity, formula, note
     FROM budget_entry WHERE version_id = ?`,
  ).all(versionId) as BudgetEntryLike[];
  const entryByKey = new Map(entries.map((row) => [`${row.org_id}:${row.account_id}`, row]));
  // STRUCTURE_INVALID 已结构化(行号 + orgId/accountId + 编码名称),直接透传。
  const issues: BudgetQualityIssue[] = validateForLock(db, versionId).problems.map((problem) => ({
    code: problem.code,
    severity: problem.severity,
    message: problem.message,
    ...(problem.row != null ? { row: problem.row } : {}),
    ...(problem.orgId != null ? { orgId: problem.orgId } : {}),
    ...(problem.accountId != null ? { accountId: problem.accountId } : {}),
  }));

  const cells = computeRequiredCells(leafOrgs, leafAccs, entries);
  issues.push(...cells.issues);
  const total = cells.total;
  const filled = cells.filled;

  const accByCode = new Map(accRows.map((row) => [row.code, row]));
  for (const rule of listRules(db)) {
    let config: Record<string, string>;
    try { config = JSON.parse(rule.config_json) as Record<string, string>; } catch { continue; }
    const output = accByCode.get(config.outputAccountCode ?? '');
    const inputCodes = rule.rule_type === 'quantity_price_net_tax'
      ? [config.quantityAccountCode, config.priceAccountCode]
      : [config.leftAccountCode, config.rightAccountCode];
    const inputs = inputCodes.map((code) => accByCode.get(code ?? '')).filter((row): row is NonNullable<typeof row> => Boolean(row));
    if (!output || inputs.length !== 2) {
      issues.push({ code: 'CALCULATION_RULE_INVALID', severity: 'warning', message: `测算模板「${rule.name}」引用的科目不存在`, ruleId: rule.id });
      continue;
    }
    for (const org of leafOrgs) {
      const hasInputs = inputs.every((acc) => {
        const row = entryByKey.get(`${org.id}:${acc.id}`);
        return row != null && ((row.quantity ?? 0) !== 0 || row.amount_cents !== 0);
      });
      const hasOutput = entryByKey.has(`${org.id}:${output.id}`);
      if (hasInputs && !hasOutput) {
        issues.push({
          code: 'CALCULATION_OUTPUT_MISSING',
          severity: 'warning',
          message: `${org.code} ${org.name}：测算模板「${rule.name}」输入完整，但 ${output.code} ${output.name} 尚未试算`,
          orgId: org.id,
          accountId: output.id,
          ruleId: rule.id,
        });
      }
    }
  }

  const blockingCount = issues.filter((issue) => issue.severity === 'blocking').length;
  const help: Record<string, BudgetQualityHelp> = {};
  for (const issue of issues) {
    if (BUDGET_QUALITY_HELP[issue.code]) help[issue.code] = BUDGET_QUALITY_HELP[issue.code];
  }
  return {
    versionId,
    canFinalize: blockingCount === 0,
    blockingCount,
    warningCount: issues.length - blockingCount,
    coverage: { filled, total, percent: total === 0 ? 0 : Math.round(filled / total * 100) },
    coverageByOrg: cells.perOrg,
    issues,
    groups: groupQualityIssues(issues),
    help,
  };
}
