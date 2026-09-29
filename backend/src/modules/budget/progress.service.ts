import type { DB } from '../../db/connection';
import { budgetQualityReport, versionSnapshotLeaves } from '../check/budget-quality';

export interface BudgetProgressRow {
  orgId: number;
  orgCode: string;
  orgName: string;
  /** 快照中的父级路径(如 "集团/华东"),无父级为空串 */
  parentPath: string;
  filled: number;
  total: number;
  percent: number;
  blocking: number;
  warning: number;
  /** 该组织最后填报时间(budget_entry.updated_at 最大值);无填报行为 null */
  lastEditAt: string | null;
}

export interface BudgetProgressReport {
  versionId: number;
  rows: BudgetProgressRow[];
  summary: {
    orgCount: number;
    avgPercent: number;
    notStarted: number;
    inProgress: number;
    completed: number;
    /** total=0 的组织(无可见科目,无事可填),不参与 notStarted/completed 分布 */
    notApplicable: number;
  };
}

/**
 * 编制进度总览:按叶子组织聚合的覆盖度与质量计数。
 * 覆盖度与 issues 全部取自 budgetQualityReport 的一次调用(coverageByOrg/issues 与
 * computeRequiredCells 同源),不再对同一份 budget_entry/树快照做第二遍全量扫描;
 * 树节点全部来自版本绑定的不可变快照,历史版本进度不随主数据漂移。
 */
export function budgetProgressReport(db: DB, versionId: number): BudgetProgressReport {
  const { orgRows, leafOrgs } = versionSnapshotLeaves(db, versionId);
  const quality = budgetQualityReport(db, versionId);
  const countByOrg = new Map<number, { blocking: number; warning: number }>();
  for (const issue of quality.issues) {
    if (issue.orgId == null) continue;
    const bucket = countByOrg.get(issue.orgId) ?? { blocking: 0, warning: 0 };
    if (issue.severity === 'blocking') bucket.blocking++;
    else bucket.warning++;
    countByOrg.set(issue.orgId, bucket);
  }

  const lastEditRows = db.prepare(
    `SELECT org_id, MAX(updated_at) AS last_edit_at FROM budget_entry WHERE version_id = ? GROUP BY org_id`,
  ).all(versionId) as { org_id: number; last_edit_at: string }[];
  const lastEditByOrg = new Map(lastEditRows.map((row) => [row.org_id, row.last_edit_at]));

  const orgById = new Map(orgRows.map((row) => [row.id, row]));
  const parentPathOf = (orgId: number): string => {
    const names: string[] = [];
    let cur = orgById.get(orgId)?.parent_id ?? null;
    while (cur != null) {
      const node = orgById.get(cur);
      if (!node) break;
      names.unshift(node.name);
      cur = node.parent_id;
    }
    return names.join('/');
  };

  const rows: BudgetProgressRow[] = leafOrgs.map((org) => {
    const stat = quality.coverageByOrg.get(org.id) ?? { filled: 0, total: 0 };
    const counts = countByOrg.get(org.id) ?? { blocking: 0, warning: 0 };
    return {
      orgId: org.id,
      orgCode: org.code,
      orgName: org.name,
      parentPath: parentPathOf(org.id),
      filled: stat.filled,
      total: stat.total,
      percent: stat.total === 0 ? 0 : Math.round(stat.filled / stat.total * 100),
      blocking: counts.blocking,
      warning: counts.warning,
      lastEditAt: lastEditByOrg.get(org.id) ?? null,
    };
  });

  /* total=0 的组织(其所有适用科目均不可见)没有可填项,filled===0 会被误判为
     notStarted——它其实「无事可做」,既不属 notStarted 也不属 completed,
     单独归为 notApplicable,不再挤占 inProgress/notStarted 的分布。 */
  const notApplicable = rows.filter((row) => row.total === 0).length;
  const notStarted = rows.filter((row) => row.total > 0 && row.filled === 0).length;
  const completed = rows.filter((row) => row.total > 0 && row.filled === row.total && row.blocking === 0).length;
  const inProgress = rows.length - notStarted - completed - notApplicable;
  const avgPercent = rows.length === 0
    ? 0
    : Math.round(rows.reduce((sum, row) => sum + row.percent, 0) / rows.length);

  return {
    versionId,
    rows,
    summary: {
      orgCount: rows.length,
      avgPercent,
      notStarted,
      inProgress,
      completed,
      notApplicable,
    },
  };
}
