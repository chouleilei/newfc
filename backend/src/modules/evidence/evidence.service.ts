import type { DB } from '../../db/connection';
import { Errors } from '../../core/errors';
import { rollup, cellOf, quantityCellOf } from '../../core/rollup';
import { getVersion } from '../budget/budget.service';
import { loadSnapshotNodes } from '../tree/snapshot';
import { getBatch, getBatchEntries, batchTrees } from '../actual/actual.service';
import { listRules } from '../calculation/calculation.service';
import { completionScope, scopedMetricRollup, scopeActualCoverage, type CompletionInput } from '../report/report.service';
import { evidenceVerificationFacts, type VerificationFactItem } from '../report/verification';
import { metricBreakdown, listMetricsForVersion } from '../metric/metric.service';

function roots<T extends { id: number; parent_id: number | null }>(rows: T[]): T[] {
  const ids = new Set(rows.map((row) => row.id));
  return rows.filter((row) => row.parent_id == null || !ids.has(row.parent_id));
}

function importSourcesForBudgetCell(db: DB, versionId: number, orgId: number, accountId: number) {
  const rows = db.prepare(
    "SELECT id, original_name, sha256, committed_at, payload_json FROM import_batch WHERE kind = 'budget' AND status = 'committed' AND target_version_id = ? ORDER BY id DESC",
  ).all(versionId) as { id: number; original_name: string; sha256: string; committed_at: string; payload_json: string }[];
  return rows.filter((row) => {
    try {
      const payload = JSON.parse(row.payload_json) as { entries?: { orgId: number; accountId: number }[] };
      return payload.entries?.some((entry) => entry.orgId === orgId && entry.accountId === accountId);
    } catch { return false; }
  }).map(({ payload_json: _payload, ...row }) => row);
}

export interface CalculationSourceInput {
  code: string;
  name: string;
  /** quantity=10^4 缩放数量;amount=金额分。value 的含义由该字段判别,不能混用。 */
  valueKind: 'quantity' | 'amount';
  accountType: string | null;
  unit: string | null;
  value: number | null;
}

export function budgetCellEvidence(db: DB, versionId: number, accountId: number, orgId?: number) {
  const version = getVersion(db, versionId);
  const orgRows = loadSnapshotNodes(db, version.org_tree_snapshot_id);
  const accRows = loadSnapshotNodes(db, version.account_tree_snapshot_id);
  const org = orgRows.find((row) => row.id === (orgId ?? roots(orgRows)[0]?.id));
  const account = accRows.find((row) => row.id === accountId);
  if (!org || !account) throw Errors.notFound('组织或科目');
  const entries = db.prepare(
    'SELECT org_id, account_id, amount_cents, quantity, formula, note, updated_at FROM budget_entry WHERE version_id = ?',
  ).all(versionId) as { org_id: number; account_id: number; amount_cents: number; quantity: number | null; formula: string; note: string; updated_at: string }[];
  const aggregated = rollup(orgRows, accRows, entries.map((entry) => ({ orgId: entry.org_id, accountId: entry.account_id, amountCents: entry.amount_cents, quantity: entry.quantity })));
  const children = accRows.filter((row) => row.parent_id === account.id).map((child) => ({
    accountId: child.id,
    code: child.code,
    name: child.name,
    type: child.type,
    unit: child.unit,
    amountCents: cellOf(aggregated, org.id, child.id),
    quantity: quantityCellOf(aggregated, org.id, child.id),
  })).filter((child) => child.amountCents !== 0 || child.quantity !== 0);
  const leafEntry = entries.find((entry) => entry.org_id === org.id && entry.account_id === account.id);
  const calcSources: { ruleId: number; ruleName: string; inputs: CalculationSourceInput[] }[] = [];
  for (const rule of listRules(db)) {
    try {
      const config = JSON.parse(rule.config_json) as Record<string, string>;
      if (config.outputAccountCode !== account.code) continue;
      const codes = rule.rule_type === 'quantity_price_net_tax'
        ? [config.quantityAccountCode, config.priceAccountCode, config.taxAccountCode].filter(Boolean)
        : [config.leftAccountCode, config.rightAccountCode].filter(Boolean);
      calcSources.push({
        ruleId: rule.id,
        ruleName: rule.name,
        inputs: codes.map((code): CalculationSourceInput => {
          const inputAcc = accRows.find((row) => row.code === code);
          const inputEntry = inputAcc ? entries.find((entry) => entry.org_id === org.id && entry.account_id === inputAcc.id) : undefined;
          const valueKind = inputAcc?.type === 'quantity' ? 'quantity' as const : 'amount' as const;
          return {
            code,
            name: inputAcc?.name ?? '科目不存在',
            valueKind,
            accountType: inputAcc?.type ?? null,
            unit: inputAcc?.unit ?? null,
            value: !inputAcc ? null : valueKind === 'quantity' ? (inputEntry?.quantity ?? null) : (inputEntry?.amount_cents ?? null),
          };
        }),
      });
    } catch { /* 质量报告负责提示损坏规则 */ }
  }
  return {
    sourceType: 'budget',
    version: { id: version.id, year: version.year, name: version.name, kind: version.kind, status: version.status },
    organization: { id: org.id, code: org.code, name: org.name },
    account: { id: account.id, code: account.code, name: account.name, type: account.type, unit: account.unit },
    value: { amountCents: cellOf(aggregated, org.id, account.id), quantity: quantityCellOf(aggregated, org.id, account.id) },
    directComponents: children,
    entry: leafEntry ? { formula: leafEntry.formula, note: leafEntry.note, updatedAt: leafEntry.updated_at } : null,
    calculationSources: calcSources,
    importSources: importSourcesForBudgetCell(db, versionId, org.id, account.id),
  };
}

export function actualCellEvidence(db: DB, batchId: number, accountId: number, orgId?: number) {
  const batch = getBatch(db, batchId);
  const { orgRows, accRows } = batchTrees(db, batch);
  const org = orgRows.find((row) => row.id === (orgId ?? roots(orgRows)[0]?.id));
  const account = accRows.find((row) => row.id === accountId);
  if (!org || !account) throw Errors.notFound('组织或科目');
  const entries = getBatchEntries(db, batchId);
  const aggregated = rollup(orgRows, accRows, entries);
  const children = accRows.filter((row) => row.parent_id === account.id).map((child) => ({
    accountId: child.id, code: child.code, name: child.name, type: child.type, unit: child.unit,
    amountCents: cellOf(aggregated, org.id, child.id), quantity: quantityCellOf(aggregated, org.id, child.id),
  })).filter((child) => child.amountCents !== 0 || child.quantity !== 0);
  const importRow = batch.import_batch_id == null ? undefined : db.prepare(
    'SELECT id, original_name, sha256, committed_at FROM import_batch WHERE id = ?',
  ).get(batch.import_batch_id);
  return {
    sourceType: 'actual',
    batch: { id: batch.id, year: batch.year, snapshotDate: batch.snapshot_date, revision: batch.revision, source: batch.source },
    organization: { id: org.id, code: org.code, name: org.name },
    account: { id: account.id, code: account.code, name: account.name, type: account.type, unit: account.unit },
    value: { amountCents: cellOf(aggregated, org.id, account.id), quantity: quantityCellOf(aggregated, org.id, account.id) },
    directComponents: children,
    importSource: importRow ?? null,
  };
}


export interface MetricEvidenceTerm {
  sourceType: 'account' | 'metric';
  sourceId: number;
  code: string;
  name: string;
  coefficient: 1 | -1;
  /** 科目项的 income/cost/expense;指标项为 null */
  accountType: string | null;
  /** 科目项在版本绑定科目树快照中的状态;指标项为 null */
  accountStatus: string | null;
  /** 引用目标不在本次计算范围内,按零计入 */
  missing: boolean;
  missingReason: string | null;
  /** 该科目子树在当前筛选范围内命中的叶子科目个数;0 表示当前范围内没有它的数据 */
  coveredLeafCount: number | null;
  /** 以下三项均为「已乘系数」的贡献额,可直接相加还原指标值 */
  budgetCents: number;
  actualCents: number;
  varianceCents: number;
  /** |本项差异贡献| 占各项 |差异贡献| 之和的比例;分母为零时为 null */
  varianceShare: number | null;
  /** 可继续下钻:科目项走科目穿透,指标项走指标穿透 */
  drillable: boolean;
}

export interface MetricEvidence {
  sourceType: 'metric';
  version: { id: number; year: number; name: string; kind: string; status: string };
  actualBasis: { asOfDate: string | null; source: string; batchId: number | null };
  scopeBasis: { sheetKey: string; sheetName: string; orgScopeId: number | null; accountScopeId: number | null };
  /** 科目或表格范围被收窄时,继续下钻的科目明细按完整科目树计算,可能与本页数字不同 */
  scopeNarrowed: boolean;
  metric: { id: number; code: string; name: string };
  value: { budgetCents: number; actualCents: number; varianceCents: number };
  terms: MetricEvidenceTerm[];
  reconciliation: {
    budget: { sumOfTermsCents: number; valueCents: number; reconciled: boolean };
    actual: { sumOfTermsCents: number; valueCents: number; reconciled: boolean };
  };
  actualCoverage: ReturnType<typeof scopeActualCoverage>;
  /** 核验事实(§9.5):ownerKey = evidence:metric:版本ID:指标ID,factKey ∈ coverage / coverage_unbudgeted。 */
  verificationFacts: VerificationFactItem[];
  notes: string[];
}

/**
 * 指标穿透(方案九 + 四.10/11):把一个报表指标拆到公式项,每项给出预算、实际与差异贡献。
 *
 * 取数范围完全复用 completionScope / scopedMetricRollup,因此这里的指标值与完成情况表
 * 上的同一指标逐分相等;公式定义走版本固化快照,穿透历史版本不受此后公式修改影响。
 * 科目项可继续走 budgetCellEvidence / actualCellEvidence 下钻到叶子单元格与导入原件。
 */
export function metricEvidence(db: DB, input: CompletionInput & { metricId: number }): MetricEvidence {
  const scope = completionScope(db, input);
  const metric = scope.metrics.find((m) => m.id === input.metricId);
  if (!metric) {
    // 可能是指标不存在,也可能在该版本的固化定义里已停用 —— 分开交代,不要让界面猜
    const known = listMetricsForVersion(db, scope.version.id).find((m) => m.id === input.metricId);
    throw known
      ? Errors.validation(`指标「${known.name}」在该预算版本的固化定义中已停用,不参与计算,无法穿透`)
      : Errors.notFound('报表指标');
  }
  if (metric.kind === 'ratio') {
    // 比率没有「逐项贡献之和 = 指标值」的守恒结构,构成就是分子与分母两个数,
    // 完成情况表的比率区块已直接给出,不走线性公式穿透。
    throw Errors.validation(`${metric.name}(${metric.code})是比率型指标,构成为分子 ÷ 分母,已在比率指标表直接展示,不适用线性公式穿透`);
  }

  const budgetRoll = scopedMetricRollup(scope, 'budget');
  const actualRoll = scopedMetricRollup(scope, 'actual');
  const budget = metricBreakdown(budgetRoll.cell.get(0) ?? new Map(), scope.metrics, metric.id);
  const actual = metricBreakdown(actualRoll.cell.get(0) ?? new Map(), scope.metrics, metric.id);

  const accById = new Map(scope.budgetAccRows.map((row) => [row.id, row]));
  const metricById = new Map(scope.metrics.map((m) => [m.id, m]));
  const frozenMetrics = new Map(listMetricsForVersion(db, scope.version.id).map((m) => [m.id, m]));

  // 该科目子树在当前筛选范围内命中多少叶子科目:0 说明这一项必然按零计入
  const coveredLeaves = (accountId: number): number => {
    let count = 0;
    for (const leafId of scope.leafAccs) {
      if (scope.budgetAccountAncestors.get(leafId)?.has(accountId)) count++;
    }
    return count;
  };

  const rawTerms = budget.terms.map((term, index) => {
    const actualTerm = actual.terms[index];
    const budgetCents = term.contributionCents;
    const actualCents = actualTerm?.contributionCents ?? 0;
    if (term.sourceType === 'account') {
      const node = accById.get(term.sourceId);
      const accountType = node ? String(node.type ?? '') : null;
      let missing = false;
      let missingReason: string | null = null;
      if (!node) {
        missing = true;
        missingReason = '该科目不在本预算版本绑定的科目树快照中,按零计入';
      } else if (accountType === 'quantity') {
        // validateTerms 已禁止新公式引用数量科目;历史固化定义仍可能带着,如实标注
        missing = true;
        missingReason = '数量科目与金额计算隔离,不参与指标公式,按零计入';
      }
      return {
        sourceType: 'account' as const,
        sourceId: term.sourceId,
        code: node?.code ?? `#${term.sourceId}`,
        name: node?.name ?? '科目已不在该版本树快照中',
        coefficient: term.coefficient,
        accountType,
        accountStatus: node ? String(node.status ?? '') : null,
        missing,
        missingReason,
        coveredLeafCount: node ? coveredLeaves(term.sourceId) : null,
        budgetCents,
        actualCents,
        varianceCents: actualCents - budgetCents,
        drillable: Boolean(node) && accountType !== 'quantity',
      };
    }
    const nested = metricById.get(term.sourceId);
    const frozen = frozenMetrics.get(term.sourceId);
    return {
      sourceType: 'metric' as const,
      sourceId: term.sourceId,
      code: nested?.code ?? frozen?.code ?? `#${term.sourceId}`,
      name: nested?.name ?? frozen?.name ?? '指标已不在该版本定义中',
      coefficient: term.coefficient,
      accountType: null,
      accountStatus: null,
      missing: !nested,
      missingReason: nested
        ? null
        : frozen
          ? '该指标在本预算版本的固化定义中已停用,按零计入'
          : '该指标不在本预算版本的固化定义中,按零计入',
      coveredLeafCount: null,
      budgetCents,
      actualCents,
      varianceCents: actualCents - budgetCents,
      drillable: Boolean(nested),
    };
  });

  const varianceMass = rawTerms.reduce((sum, term) => sum + Math.abs(term.varianceCents), 0);
  const terms: MetricEvidenceTerm[] = rawTerms.map((term) => ({
    ...term,
    varianceShare: varianceMass === 0 ? null : Math.abs(term.varianceCents) / varianceMass,
  }));

  const sheetKey = input.sheetKey || 'all';
  const scopeNarrowed = (input.accountScopeId ?? null) != null || !['all', 'overview', 'profit'].includes(sheetKey);
  const actualCoverage = scopeActualCoverage(scope);
  const notes = [
    '指标值口径与年度执行分析页一致:公式作用于当前筛选范围内的叶子科目合计',
    `公式定义来自${scope.version.status === 'draft' ? '当前指标配置(草稿版本)' : `版本 #${scope.version.id} 定稿时固化的指标快照`}`,
    '各项金额为已乘 ± 系数的贡献额,相加即为指标值;差异为实际−预算(利润方向,正数有利)',
    actualCoverage.unbudgetedActual.count > 0
      ? `本范围另有 ${actualCoverage.unbudgetedActual.count} 条实际在组织或科目维度没有预算叶子祖先；能映射到公式科目祖先的部分已计入指标，其原始组合随穿透结果返回`
      : '本范围全部实际均有预算叶子承接路径',
    `来源实际承接对账差额 ${actualCoverage.reconciliation.differenceCents} 分`,
  ];
  if (scopeNarrowed) {
    notes.push('当前收窄了科目或表格范围,继续下钻科目时其明细按完整科目树计算,合计可能大于本页该项金额');
  }
  if (!budget.reconciled || !actual.reconciled) {
    notes.push('注意:逐项贡献之和与指标值不相等,请检查指标公式定义');
  }

  return {
    sourceType: 'metric',
    version: {
      id: scope.version.id,
      year: scope.version.year,
      name: scope.version.name,
      kind: scope.version.kind,
      status: scope.version.status,
    },
    actualBasis: { asOfDate: scope.actual.asOfDate, source: scope.actual.source, batchId: scope.actual.batchId },
    scopeBasis: {
      sheetKey,
      sheetName: scope.analysisScope.sheetName,
      orgScopeId: input.orgScopeId ?? null,
      accountScopeId: input.accountScopeId ?? null,
    },
    scopeNarrowed,
    metric: { id: metric.id, code: metric.code, name: metric.name },
    value: {
      budgetCents: budget.valueCents,
      actualCents: actual.valueCents,
      varianceCents: actual.valueCents - budget.valueCents,
    },
    terms,
    reconciliation: {
      budget: { sumOfTermsCents: budget.sumOfTermsCents, valueCents: budget.valueCents, reconciled: budget.reconciled },
      actual: { sumOfTermsCents: actual.sumOfTermsCents, valueCents: actual.valueCents, reconciled: actual.reconciled },
    },
    actualCoverage,
    verificationFacts: evidenceVerificationFacts({
      versionId: scope.version.id,
      metricId: metric.id,
      batchId: scope.actual.batchId,
      orgScopeId: input.orgScopeId ?? null,
      accountScopeId: input.accountScopeId ?? null,
      sheetKey,
      unbudgetedActual: actualCoverage.unbudgetedActual,
      reconciliation: actualCoverage.reconciliation,
    }),
    notes,
  };
}
