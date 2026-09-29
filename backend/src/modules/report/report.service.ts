import type { DB } from '../../db/connection';
import { Errors } from '../../core/errors';
import { writeLog } from '../audit/log';
import { centsToYuanString, completionRate, signOfType, safeIntegerAdd, type AccountType } from '../../core/money';
import { timeProgress } from '../../core/dates';
import { rollup, cellOf, quantityCellOf, emptyRollup, type RollupResult } from '../../core/rollup';
import type { TreeNodeRow } from '../../core/tree';
import { buildAncestorMap, buildTree, computeLeafIds } from '../../core/tree';
import { getVersion, type BudgetVersionRow } from '../budget/budget.service';
import { listMetricsForVersion, type MetricRow, type MetricRatioValue } from '../metric/metric.service';
import {
  getYearState,
  getBatch,
  getBatchEntries,
  listBatches,
  batchTrees,
  type SnapshotBatchRow,
} from '../actual/actual.service';
import { loadSnapshotNodes } from '../tree/snapshot';
import { listSheets } from '../sheet/sheet.service';
import { completionVerificationFacts, classifyPace, type VerificationFactItem } from './verification';

/** 分析报表(方案九)+ 年度关闭(方案三.5)。 */

function subtreeIds(rows: TreeNodeRow[], rootId: number | null): Set<number> {
  if (rootId == null) return new Set(rows.map((r) => r.id));
  if (!rows.some((r) => r.id === rootId)) throw Errors.validation(`所选范围节点 #${rootId} 不在预算版本绑定树中`);
  const ids = new Set<number>();
  const childrenOf = new Map<number, number[]>();
  for (const r of rows) {
    const p = r.parent_id ?? 0;
    if (!childrenOf.has(p)) childrenOf.set(p, []);
    childrenOf.get(p)!.push(r.id);
  }
  const stack = [rootId];
  while (stack.length) {
    const id = stack.pop()!;
    if (ids.has(id)) continue;
    ids.add(id);
    for (const c of childrenOf.get(id) ?? []) stack.push(c);
  }
  return ids;
}

function intersectIds(a: Set<number>, b: Set<number>): Set<number> {
  return new Set([...a].filter((id) => b.has(id)));
}

export interface AnalysisAccountScope {
  calculationIds: Set<number>;
  displayIds: Set<number>;
  sheetName: string;
}

/** 预设预算表格在后端解析，确保完成表、预警、组织汇总、指标、趋势和导出口径一致。 */
function resolveAnalysisAccountScope(
  db: DB,
  accountRows: TreeNodeRow[],
  sheetKey: string | null | undefined,
  accountScopeId: number | null | undefined,
): AnalysisAccountScope {
  const selectedSubtree = subtreeIds(accountRows, accountScopeId ?? null);
  const key = sheetKey || 'all';
  if (key === 'all' || key === 'overview') {
    const maxRootLevel = key === 'overview' ? 0 : Number.POSITIVE_INFINITY;
    return {
      calculationIds: selectedSubtree,
      displayIds: new Set([...selectedSubtree].filter((id) => {
        if (maxRootLevel === Number.POSITIVE_INFINITY) return true;
        const node = accountRows.find((row) => row.id === id);
        return node?.parent_id == null;
      })),
      sheetName: key === 'overview' ? '一级汇总' : '全部科目',
    };
  }
  if (key === 'profit') {
    const profitAccountCodes = new Set(['C1', 'C3', 'E1', 'E2', 'E3', 'C4', 'I2', 'I3', 'C5', 'C6']);
    return {
      // 利润表指标仍需基于完整金额科目范围计算；数量科目金额恒为零，不会混入。
      calculationIds: selectedSubtree,
      displayIds: new Set([...selectedSubtree].filter((id) => profitAccountCodes.has(accountRows.find((row) => row.id === id)?.code ?? ''))),
      sheetName: '利润表',
    };
  }
  const sheet = listSheets(db).find((item) => item.code === key && item.status === 'active');
  if (!sheet) throw Errors.validation(`未知或已停用的预算表格: ${key}`);
  const byCode = new Map(accountRows.map((row) => [row.code, row]));
  const sheetIds = new Set<number>();
  for (const code of sheet.rootCodes) {
    const root = byCode.get(code);
    if (!root) continue; // 历史版本可能早于该表格科目配置，按空范围处理
    for (const id of subtreeIds(accountRows, root.id)) sheetIds.add(id);
  }
  const calculationIds = intersectIds(selectedSubtree, sheetIds);
  const collapsed = new Set(sheet.collapsedCodes);
  const displayIds = new Set<number>();
  const children = new Map<number, number[]>();
  for (const row of accountRows) {
    if (row.parent_id != null) children.set(row.parent_id, [...(children.get(row.parent_id) ?? []), row.id]);
  }
  const walk = (id: number) => {
    if (!calculationIds.has(id)) return;
    displayIds.add(id);
    const row = accountRows.find((item) => item.id === id);
    if (row && collapsed.has(row.code)) return;
    for (const child of children.get(id) ?? []) walk(child);
  };
  for (const id of calculationIds) {
    const row = accountRows.find((item) => item.id === id);
    if (row?.parent_id == null || !calculationIds.has(row.parent_id)) walk(id);
  }
  return { calculationIds, displayIds, sheetName: sheet.name };
}

export interface CompletionInput {
  versionId: number;
  batchId?: number | null; // 缺省:未关闭年度取当前实际
  orgScopeId?: number | null; // 组织范围(子树),null = 全部
  accountScopeId?: number | null; // 科目范围(子树),null = 全部
  sheetKey?: string | null; // 预算表格范围,null/all = 全部
  summaryLevel?: number | null; // 最深展示层级(1=一级);不影响底层计算
  /** 节奏偏离预警阈值(0-1 比率,如 0.2 = 20pp);驱动 verificationFacts 的 overspend/lagging 判定 */
  warningThreshold?: number | null;
}

export interface CompletionCell {
  budgetCents: number;
  actualCents: number;
  /** 数量科目预算值，按 10^4 缩放；与金额字段完全隔离。 */
  budgetQuantity: number;
  /** 数量科目实际值，按 10^4 缩放；与金额字段完全隔离。 */
  actualQuantity: number;
  varianceQuantity: number;
  varianceCents: number; // V = A - B(带符号利润方向)
  rate: number | null; // R = 实际展示/预算展示
  rateSpecial: 'na_zero_budget' | 'na_negative_budget' | 'opposite_direction' | null;
  favorable: 'favorable' | 'unfavorable' | 'none';
  progressDeviation: number | null; // P = R - T
  pace: 'ahead' | 'lagging' | 'on_track' | 'na';
}

function makeCell(
  budgetCents: number,
  actualCents: number,
  type?: AccountType,
  budgetQuantity = 0,
  actualQuantity = 0,
  timeProgressValue: number | null = null,
  displaySignOverride?: 1 | -1,
): CompletionCell {
  const varianceCents = safeIntegerAdd(actualCents, -budgetCents, '预实差异');
  const varianceQuantity = safeIntegerAdd(actualQuantity, -budgetQuantity, '预实数量差异');
  const sign = displaySignOverride ?? (type ? signOfType(type) : 1);
  const budgetDisplay = type === 'quantity' ? budgetQuantity : budgetCents * sign;
  const actualDisplay = type === 'quantity' ? actualQuantity : actualCents * sign;
  let rate: number | null = null;
  let rateSpecial: CompletionCell['rateSpecial'] = null;
  if (budgetDisplay === 0) {
    rate = null;
    rateSpecial = 'na_zero_budget';
  } else if (budgetDisplay < 0) {
    rate = null;
    rateSpecial = 'na_negative_budget';
  } else {
    rate = completionRate(actualDisplay, budgetDisplay);
    if (actualDisplay < 0) rateSpecial = 'opposite_direction';
  }
  const progressDeviation = rate == null || timeProgressValue == null ? null : rate - timeProgressValue;
  const pace = progressDeviation == null ? 'na' : Math.abs(progressDeviation) < 0.0000001 ? 'on_track' : progressDeviation > 0 ? 'ahead' : 'lagging';
  return {
    budgetCents,
    actualCents,
    budgetQuantity,
    actualQuantity,
    varianceQuantity,
    varianceCents,
    rate,
    rateSpecial,
    favorable: type === 'quantity' ? 'none' : varianceCents > 0 ? 'favorable' : varianceCents < 0 ? 'unfavorable' : 'none',
    progressDeviation,
    pace,
  };
}

export interface CompletionReport {
  version: BudgetVersionRow;
  asOfDate: string | null; // 实际数据截至日期
  timeProgressValue: number | null; // 均匀自然日进度
  actualSource: 'current' | 'snapshot' | 'final' | 'none';
  actualBatchId: number | null;
  treeBasis: { org: string; account: string }; // 树口径来源说明
  scopeBasis: { sheetKey: string; sheetName: string; orgScopeId: number | null; accountScopeId: number | null; summaryLevel: number | null };
  byAccount: {
    accountId: number; parentId: number | null; code: string; name: string; type: string; unit: string; level: number; isLeaf: boolean;
    /** 当前实际树中的新增分支无法投影到任何预算叶子时为 true。 */
    unbudgeted: boolean;
    cell: CompletionCell;
  }[];
  /** 完整计算范围科目（不受预设表折叠和汇总层级展示限制），供预警与归因使用。 */
  analysisAccounts: {
    accountId: number; parentId: number | null; code: string; name: string; type: string; unit: string; level: number; isLeaf: boolean;
    unbudgeted: boolean;
    cell: CompletionCell;
    /**
     * 预警分类(§9.5 统一核验):overspend=累计实际超全年预算, lagging=节奏偏离超阈值,
     * healthy=正常, null=不参与预警(非叶子/数量科目/无完成率/无实际数据)。页面与助手共用。
     */
    paceClass: 'overspend' | 'lagging' | 'healthy' | null;
  }[];
  byOrg: {
    orgId: number; parentId: number | null; code: string; name: string; level: number; isLeaf: boolean;
    unbudgeted: boolean;
    /**
     * 预算体量(毛量):范围内一级金额科目各自带符号合计的绝对值之和。
     * 组内红字冲减先抵销再取绝对值;数量型顶行与金额隔离不计入。
     * 与 cell.budgetCents(利润方向净额)互补:体量衡量业务规模,净额衡量盈亏。
     */
    budgetVolumeCents: number;
    cell: CompletionCell; // 净额(利润方向合计)
  }[];
  /** 线性指标(金额口径,利润方向)。比率指标在 ratioMetrics,两者单位不同不可混列。 */
  metrics: { metricId: number; code: string; name: string; displaySign: 1 | -1; cell: CompletionCell }[];
  /** 比率指标:预算比率、实际比率与百分点差。比率不可加总,汇总行由后端「先汇总分子分母再相除」。 */
  ratioMetrics: RatioMetricRow[];
  /** 预算快照中没有可承接叶子节点的新结构实际，保留原始组织×科目组合供对账。 */
  unbudgetedActual: UnbudgetedActual;
  /** 所选实际来源与报表承接区的逐分勾稽。 */
  reconciliation: ActualReconciliation;
  /**
   * 核验事实(§9.5):页面 VerifyBar、助手与导出共用同一份结论。
   * factKey ∈ actual_none / reconciliation / unbudgeted / overspend / lagging(ownerKey analysis:root)。
   */
  verificationFacts: VerificationFactItem[];
  notes: string[];
}

export interface UnbudgetedActualEntry {
  orgId: number;
  orgCode: string;
  orgName: string;
  accountId: number;
  accountCode: string;
  accountName: string;
  accountType: string;
  amountCents: number;
  quantity: number | null;
  reason: '新增组织未纳入预算叶子' | '新增科目未纳入预算叶子' | '新增组织和新增科目均未纳入预算叶子';
}

export interface UnbudgetedActual {
  count: number;
  amountCents: number;
  entries: UnbudgetedActualEntry[];
}

export interface ActualReconciliation {
  /** 所选组织、科目与预算表格范围内的原始实际净额。 */
  sourceActualCents: number;
  /** 已投影到预算叶子的实际加未预算承接区，二者互斥且覆盖全部来源。 */
  displayedActualCents: number;
  differenceCents: number;
}

export interface RatioMetricRow {
  metricId: number;
  code: string;
  name: string;
  direction: 'higher_better' | 'lower_better';
  displayFormat: 'percent' | 'number';
  /** 自然单位说明(百分比为空串);比率单位 = 元 ÷ 分母科目计量单位 */
  unit: string;
  budget: MetricRatioValue;
  actual: MetricRatioValue;
  /**
   * 实际 − 预算,RATIO_SCALE 缩放。百分比口径下除以 10^4 得百分点。
   * 任一侧为 N/A 时为 null —— 比率差异是百分点差,不是完成率,不做除法。
   */
  deltaScaled: number | null;
  favorable: 'favorable' | 'unfavorable' | 'none';
}

export interface ActualSource {
  entries: { orgId: number; accountId: number; amountCents: number; quantity?: number | null }[];
  orgRows: TreeNodeRow[];
  accRows: TreeNodeRow[];
  asOfDate: string | null;
  source: 'current' | 'snapshot' | 'final' | 'none';
  batchId: number | null;
}

export interface ScopedActualProjection {
  entry: ActualSource['entries'][number];
  /** 实际树中从明细节点到根的 ID 链，顺序为自身、父、祖先。 */
  orgChain: number[];
  accountChain: number[];
  /** 最近的预算快照节点；用于在预算层级行和指标公式中承接实际。 */
  nearestBudgetOrgId: number | null;
  nearestBudgetAccountId: number | null;
  /** 最近的预算叶子；两者都存在时，该明细可落到原预算交叉单元格。 */
  budgetLeafOrgId: number | null;
  budgetLeafAccountId: number | null;
}

/** 实际数取数口径的唯一入口:已关闭年度读最终快照,未关闭年度读当前实际(方案八.1)。 */
export function resolveActualSource(db: DB, year: number, batchId?: number | null): ActualSource {
  const state = getYearState(db, year);
  if (batchId != null) {
    const batch = getBatch(db, batchId);
    if (batch.year !== year) throw Errors.validation('快照批次不属于所选年度');
    const trees = batchTrees(db, batch);
    return { entries: getBatchEntries(db, batchId), ...trees, asOfDate: batch.snapshot_date, source: 'snapshot', batchId };
  }
  if (state?.status === 'frozen') {
    // 已关闭年度:读最终快照及其绑定树(方案八.1)
    if (state.final_batch_id != null) {
      const batch = getBatch(db, state.final_batch_id);
      const trees = batchTrees(db, batch);
      return { entries: getBatchEntries(db, batch.id), ...trees, asOfDate: batch.snapshot_date, source: 'final', batchId: batch.id };
    }
    return { entries: [], orgRows: [], accRows: [], asOfDate: null, source: 'none', batchId: null };
  }
  if (state?.current_batch_id != null) {
    const batch = db
      .prepare('SELECT * FROM actual_snapshot_batch WHERE id = ?')
      .get(state.current_batch_id) as SnapshotBatchRow | undefined;
    if (batch) {
      // 未关闭年度实时汇总:当前实际 + 当前树;截至日期取当前批次日期
      const cur = db
        .prepare('SELECT org_id, account_id, cumulative_amount_cents, quantity FROM actual_current WHERE year = ?')
        .all(year) as { org_id: number; account_id: number; cumulative_amount_cents: number; quantity: number | null }[];
      const orgRows = db
        .prepare('SELECT id, parent_id, code, name, sort_order, status FROM org')
        .all() as unknown as TreeNodeRow[];
      const accRows = db
        .prepare('SELECT id, parent_id, code, name, type, unit, quantity_agg, budget_required, basis_required, sort_order, status FROM account')
        .all() as unknown as TreeNodeRow[];
      return {
        entries: cur.map((r) => ({ orgId: r.org_id, accountId: r.account_id, amountCents: r.cumulative_amount_cents, quantity: r.quantity })),
        orgRows,
        accRows,
        asOfDate: batch.snapshot_date,
        source: 'current',
        batchId: batch.id,
      };
    }
  }
  return { entries: [], orgRows: [], accRows: [], asOfDate: null, source: 'none', batchId: null };
}

/** 完成情况表与指标穿透共用的取数范围。抽出来是为了让穿透的每一项与报表逐格同源。 */
export interface CompletionScope {
  version: BudgetVersionRow;
  budgetOrgRows: TreeNodeRow[];
  budgetAccRows: TreeNodeRow[];
  budgetEntries: { orgId: number; accountId: number; amountCents: number; quantity: number | null }[];
  actual: ActualSource;
  timeProgressValue: number | null;
  /** 版本固化的启用指标定义:定稿版本读固化快照,草稿读当前公式 */
  metrics: MetricRow[];
  /** 含停用项的完整定义图；计算依赖使用它，输出仍只展示 metrics 中的启用项。 */
  metricDefinitions: MetricRow[];
  budgetRoll: RollupResult;
  actualRoll: RollupResult;
  orgScope: Set<number>;
  analysisScope: AnalysisAccountScope;
  /** 范围内的叶子组织/叶子科目(均按预算版本绑定树判定) */
  leafOrgs: Set<number>;
  leafAccs: Set<number>;
  /** 叶子科目 -> 范围内预算合计(带符号) */
  scopeBudget: Map<number, number>;
  /** 叶子科目 -> 范围内实际合计(带符号) */
  scopeActual: Map<number, number>;
  /** 预算快照中每个科目节点的实际子树合计(已按实际树祖先链投影)。 */
  scopeActualByAccount: Map<number, number>;
  /** 预算快照中每个组织节点的实际子树合计。 */
  scopeActualByOrg: Map<number, number>;
  /** 叶子数量科目 -> 范围内预算数量合计(10^4 缩放;仅 quantity_agg=sum,供比率指标取分母) */
  scopeBudgetQuantity: Map<number, number>;
  /** 叶子数量科目 -> 范围内实际数量合计(10^4 缩放;仅 quantity_agg=sum,供比率指标取分母) */
  scopeActualQuantity: Map<number, number>;
  scopeActualQuantityByAccount: Map<number, number>;
  /** 已同时套用组织与科目范围的原始实际明细。 */
  selectedActualEntries: ActualSource['entries'];
  /** 每条范围内实际到预算快照节点/叶子的确定投影。 */
  actualProjections: ScopedActualProjection[];
  budgetOrgAncestors: Map<number, Set<number>>;
  budgetAccountAncestors: Map<number, Set<number>>;
  actualOrgAncestors: Map<number, Set<number>>;
  actualAccountAncestors: Map<number, Set<number>>;
}

/**
 * 解析一次完成情况取数范围:树快照、实际数来源、启用指标定义、组织与科目范围,
 * 以及范围内叶子科目的预算/实际合计。completionReport 与 metricEvidence 共用,
 * 保证「穿透看到的数」与「报表上的数」由同一段代码算出。
 */
export function completionScope(db: DB, input: CompletionInput): CompletionScope {
  const version = getVersion(db, input.versionId);
  const budgetOrgRows = loadSnapshotNodes(db, version.org_tree_snapshot_id);
  const budgetAccRows = loadSnapshotNodes(db, version.account_tree_snapshot_id);
  const budgetEntries = (
    db.prepare('SELECT org_id, account_id, amount_cents, quantity FROM budget_entry WHERE version_id = ?').all(version.id) as {
      org_id: number; account_id: number; amount_cents: number; quantity: number | null;
    }[]
  ).map((r) => ({ orgId: r.org_id, accountId: r.account_id, amountCents: r.amount_cents, quantity: r.quantity }));

  const actual = resolveActualSource(db, version.year, input.batchId);
  const timeProgressValue = actual.asOfDate ? timeProgress(actual.asOfDate) : null;
  const metricDefinitions = listMetricsForVersion(db, version.id);
  const metrics = metricDefinitions.filter((m) => m.status === 'active');

  const budgetRoll = rollup(budgetOrgRows, budgetAccRows, budgetEntries, metricDefinitions);
  const actualRoll = actual.entries.length || actual.accRows.length
    ? rollup(actual.orgRows, actual.accRows, actual.entries, metricDefinitions)
    : emptyRollup();

  const orgScope = subtreeIds(budgetOrgRows, input.orgScopeId ?? null);
  const analysisScope = resolveAnalysisAccountScope(db, budgetAccRows, input.sheetKey, input.accountScopeId);
  const accScope = analysisScope.calculationIds;

  const budgetOrgById = new Map(budgetOrgRows.map((row) => [row.id, row]));
  const budgetAccById = new Map(budgetAccRows.map((row) => [row.id, row]));
  const actualAccById = new Map(actual.accRows.map((row) => [row.id, row]));
  // 祖先链直接复用 rollup 已构建的结果:预算侧两棵树不再被 buildAncestorMap 各算第二遍;
  // 实际树只在有明细时参与 rollup,祖先链跟随同一条件构建。
  const budgetOrgAncestors = budgetRoll.orgAncestors;
  const budgetAccountAncestors = budgetRoll.accountAncestors;
  const actualOrgAncestors = actual.entries.length || actual.accRows.length
    ? actualRoll.orgAncestors
    : buildAncestorMap(actual.orgRows);
  const actualAccountAncestors = buildAncestorMap(actual.accRows);
  const orgScopeIsWholeTree = input.orgScopeId == null && orgScope.size === budgetOrgRows.length;
  const accScopeIsWholeTree = input.accountScopeId == null && accScope.size === budgetAccRows.length;
  const selectedActualEntries = actual.entries.filter((entry) => {
    const orgChain = actualOrgAncestors.get(entry.orgId) ?? new Set<number>();
    const accountChain = actualAccountAncestors.get(entry.accountId) ?? new Set<number>();
    const orgIncluded = [...orgChain].some((id) => orgScope.has(id)) || orgScopeIsWholeTree;
    const accountIncluded = [...accountChain].some((id) => accScope.has(id)) || accScopeIsWholeTree;
    return orgIncluded && accountIncluded;
  });

  // 范围合计:org 范围内叶子 × account 范围内叶子的预算/实际总额(供按科目行展示)
  const leafOrgs = new Set(budgetRoll.leafOrgIds.filter((id) => orgScope.has(id)));
  const leafAccs = new Set(budgetRoll.leafAccountIds.filter((id) => accScope.has(id)));
  const scopeBudget = new Map<number, number>();
  const scopeActual = new Map<number, number>();
  // 数量只对数量型科目有意义;非数量科目的 quantityCellOf 恒为 0,不写入映射以免混淆下游
  const scopeBudgetQuantity = new Map<number, number>();
  const scopeActualQuantity = new Map<number, number>();
  for (const og of leafOrgs) {
    for (const ag of leafAccs) {
      const b = cellOf(budgetRoll, og, ag);
      scopeBudget.set(ag, safeIntegerAdd(scopeBudget.get(ag) ?? 0, b, '完成情况预算汇总'));
      if (budgetAccById.get(ag)?.type !== 'quantity') continue;
      scopeBudgetQuantity.set(ag, safeIntegerAdd(scopeBudgetQuantity.get(ag) ?? 0, quantityCellOf(budgetRoll, og, ag), '完成情况预算数量汇总'));
    }
  }

  // 实际树 -> 预算快照的稳定 ID 投影。共享 ID 直接承接；新子节点投到最近的
  // 预算祖先节点供指标计算；完全无祖先的新根节点保留在 unbudgetedActual。
  const scopeActualByAccount = new Map<number, number>();
  const scopeActualByOrg = new Map<number, number>();
  const scopeActualQuantityByAccount = new Map<number, number>();
  const actualProjections: ScopedActualProjection[] = [];
  for (const entry of selectedActualEntries) {
    const accountChain = [...(actualAccountAncestors.get(entry.accountId) ?? new Set<number>())];
    const orgChain = [...(actualOrgAncestors.get(entry.orgId) ?? new Set<number>())];
    const nearestBudgetAccountId = accountChain.find((id) => accScope.has(id) && budgetAccById.has(id)) ?? null;
    const nearestBudgetOrgId = orgChain.find((id) => orgScope.has(id) && budgetOrgById.has(id)) ?? null;
    const budgetLeafAccountId = accountChain.find((id) => leafAccs.has(id)) ?? null;
    const budgetLeafOrgId = orgChain.find((id) => leafOrgs.has(id)) ?? null;
    actualProjections.push({
      entry,
      orgChain,
      accountChain,
      nearestBudgetOrgId,
      nearestBudgetAccountId,
      budgetLeafOrgId,
      budgetLeafAccountId,
    });
    for (const accountId of accountChain) {
      if (!accScope.has(accountId) || !budgetAccById.has(accountId)) continue;
      scopeActualByAccount.set(accountId, safeIntegerAdd(scopeActualByAccount.get(accountId) ?? 0, entry.amountCents, '完成情况实际科目投影'));
    }
    for (const orgId of orgChain) {
      if (!orgScope.has(orgId) || !budgetOrgById.has(orgId)) continue;
      scopeActualByOrg.set(orgId, safeIntegerAdd(scopeActualByOrg.get(orgId) ?? 0, entry.amountCents, '完成情况实际组织投影'));
    }
    if (nearestBudgetAccountId != null) {
      scopeActual.set(nearestBudgetAccountId, safeIntegerAdd(scopeActual.get(nearestBudgetAccountId) ?? 0, entry.amountCents, '完成情况实际指标投影'));
    }
    if (entry.quantity != null) {
      let quantityReachedNearest = false;
      for (const accountId of accountChain) {
        const actualNode = actualAccById.get(accountId);
        if (actualNode?.quantity_agg === 'none') break;
        if (!accScope.has(accountId) || !budgetAccById.has(accountId)) continue;
        scopeActualQuantityByAccount.set(accountId, safeIntegerAdd(scopeActualQuantityByAccount.get(accountId) ?? 0, entry.quantity, '完成情况实际数量科目投影'));
        if (accountId === nearestBudgetAccountId) quantityReachedNearest = true;
      }
      if (quantityReachedNearest && nearestBudgetAccountId != null) {
        scopeActualQuantity.set(nearestBudgetAccountId, safeIntegerAdd(scopeActualQuantity.get(nearestBudgetAccountId) ?? 0, entry.quantity, '完成情况实际指标数量投影'));
      }
    }
  }

  return {
    version,
    budgetOrgRows,
    budgetAccRows,
    budgetEntries,
    actual,
    timeProgressValue,
    metrics,
    metricDefinitions,
    budgetRoll,
    actualRoll,
    orgScope,
    analysisScope,
    leafOrgs,
    leafAccs,
    scopeBudget,
    scopeActual,
    scopeActualByAccount,
    scopeActualByOrg,
    scopeBudgetQuantity,
    scopeActualQuantity,
    scopeActualQuantityByAccount,
    selectedActualEntries,
    actualProjections,
    budgetOrgAncestors,
    budgetAccountAncestors,
    actualOrgAncestors,
    actualAccountAncestors,
  };
}

/** 指标口径的虚拟根组织:指标公式作用于「范围内叶子科目合计」,不区分组织。 */
const METRIC_SCOPE_ROOT: TreeNodeRow = { id: 0, parent_id: null, code: 'ROOT', name: '范围', sort_order: 0, status: 'active' } as TreeNodeRow;

/**
 * 指标口径汇总:把范围内叶子科目合计挂到虚拟根组织上重算一遍科目树,
 * `.metrics` 是报表上的线性指标值,`.metricRatios` 是比率指标值,
 * `.cell.get(0)` 是各科目节点在该范围内的合计(即指标公式的取值来源)。
 * 完成情况表与指标穿透都走这里。
 *
 * 数量随合成明细一起传入,使比率指标能取到范围内的数量分母;
 * 传入的都是叶子科目,rollup 会按科目祖先链重新累计到中间节点。
 */
export function scopedMetricRollup(scope: CompletionScope, which: 'budget' | 'actual'): RollupResult {
  const totals = which === 'budget' ? scope.scopeBudget : scope.scopeActual;
  const quantities = which === 'budget' ? scope.scopeBudgetQuantity : scope.scopeActualQuantity;
  const accountIds = new Set<number>([...totals.keys(), ...quantities.keys()]);
  return rollup(
    [METRIC_SCOPE_ROOT],
    scope.budgetAccRows,
    [...accountIds].map((accountId) => ({
      orgId: 0,
      accountId,
      amountCents: totals.get(accountId) ?? 0,
      quantity: quantities.get(accountId) ?? null,
    })),
    scope.metricDefinitions
  );
}

/**
 * 将范围内实际拆成互斥的两部分：能同时落到预算组织叶子与科目叶子的投影部分，
 * 以及至少一个维度没有预算叶子祖先的未预算承接部分。两部分之和必须与来源逐分相等。
 */
export function scopeActualCoverage(scope: CompletionScope): {
  unbudgetedActual: UnbudgetedActual;
  reconciliation: ActualReconciliation;
  /** 未预算实际投影到的预算祖先科目(可能为 null=完全无祖先):结构分析用它与
   *  brokenReconciliation 逐科目对上,而不是凭「全局存在承接区」推断所有断链都由它兜底。 */
  unbudgetedAccountIds: Set<number>;
} {
  const actualOrgById = new Map(scope.actual.orgRows.map((row) => [row.id, row]));
  const actualAccById = new Map(scope.actual.accRows.map((row) => [row.id, row]));
  const entries: UnbudgetedActualEntry[] = [];
  const unbudgetedAccountIds = new Set<number>();
  let sourceActualCents = 0;
  let projectedActualCents = 0;
  let unbudgetedAmountCents = 0;

  for (const projection of scope.actualProjections) {
    const { entry } = projection;
    sourceActualCents = safeIntegerAdd(sourceActualCents, entry.amountCents, '实际来源对账汇总');
    const orgUnbudgeted = projection.budgetLeafOrgId == null;
    const accountUnbudgeted = projection.budgetLeafAccountId == null;
    if (!orgUnbudgeted && !accountUnbudgeted) {
      projectedActualCents = safeIntegerAdd(projectedActualCents, entry.amountCents, '已投影实际对账汇总');
      continue;
    }
    if (projection.nearestBudgetAccountId != null) unbudgetedAccountIds.add(projection.nearestBudgetAccountId);

    const org = actualOrgById.get(entry.orgId);
    const account = actualAccById.get(entry.accountId);
    const reason: UnbudgetedActualEntry['reason'] = orgUnbudgeted && accountUnbudgeted
      ? '新增组织和新增科目均未纳入预算叶子'
      : orgUnbudgeted
        ? '新增组织未纳入预算叶子'
        : '新增科目未纳入预算叶子';
    entries.push({
      orgId: entry.orgId,
      orgCode: org?.code ?? `#${entry.orgId}`,
      orgName: org?.name ?? '实际组织不在来源树中',
      accountId: entry.accountId,
      accountCode: account?.code ?? `#${entry.accountId}`,
      accountName: account?.name ?? '实际科目不在来源树中',
      accountType: String(account?.type ?? ''),
      amountCents: entry.amountCents,
      quantity: entry.quantity ?? null,
      reason,
    });
    unbudgetedAmountCents = safeIntegerAdd(unbudgetedAmountCents, entry.amountCents, '未预算实际对账汇总');
  }

  entries.sort((a, b) => a.orgCode.localeCompare(b.orgCode) || a.accountCode.localeCompare(b.accountCode));
  const displayedActualCents = safeIntegerAdd(projectedActualCents, unbudgetedAmountCents, '报表实际承接汇总');
  const differenceCents = safeIntegerAdd(sourceActualCents, -displayedActualCents, '实际来源对账差额');
  return {
    unbudgetedActual: { count: entries.length, amountCents: unbudgetedAmountCents, entries },
    reconciliation: { sourceActualCents, displayedActualCents, differenceCents },
    unbudgetedAccountIds,
  };
}

/** 预算完成情况表(方案九.1) */
export function completionReport(db: DB, input: CompletionInput): CompletionReport {
  const scope = completionScope(db, input);
  const {
    version, budgetOrgRows, budgetAccRows, budgetEntries, actual, timeProgressValue, metrics,
    budgetRoll, actualRoll, orgScope, analysisScope, leafOrgs, leafAccs, scopeBudget,
    scopeActualByAccount, scopeActualByOrg, scopeActualQuantityByAccount,
    actualProjections, budgetOrgAncestors, budgetAccountAncestors,
  } = scope;
  const summaryMaxDepth = input.summaryLevel == null ? null : Math.max(0, input.summaryLevel - 1);
  const depthOf = (rows: TreeNodeRow[], id: number): number => {
    const byId = new Map(rows.map((r) => [r.id, r]));
    let d = 0;
    let cur = byId.get(id);
    while (cur && cur.parent_id != null) { d++; cur = byId.get(cur.parent_id); }
    return d;
  };

  const averageQuantity = (values: number[]): number => {
    if (values.length === 0) return 0;
    const total = values.reduce((sum, value) => safeIntegerAdd(sum, value, '非累计数量平均值汇总'), 0);
    return Math.round(total / values.length);
  };
  const budgetQuantity = (accountId: number, aggregate: string | null | undefined): number => {
    if (aggregate !== 'none') {
      return [...leafOrgs].reduce(
        (sum, orgId) => safeIntegerAdd(sum, quantityCellOf(budgetRoll, orgId, accountId), '完成情况预算数量汇总'),
        0,
      );
    }
    return averageQuantity(budgetEntries
      .filter((entry) => entry.quantity != null
        && [...(budgetOrgAncestors.get(entry.orgId) ?? [])].some((id) => leafOrgs.has(id))
        && budgetAccountAncestors.get(entry.accountId)?.has(accountId))
      .map((entry) => entry.quantity!));
  };
  const actualQuantity = (accountId: number, aggregate: string | null | undefined): number => {
    if (aggregate !== 'none') return scopeActualQuantityByAccount.get(accountId) ?? 0;
    return averageQuantity(actualProjections
      .filter((projection) => projection.entry.quantity != null && projection.accountChain.includes(accountId))
      .map((projection) => projection.entry.quantity!));
  };

  // 原始实际树节点合计仅用于展示「无预算叶子祖先」的新分支。预算节点继续用上面的
  // 投影映射，避免当前树结构改变历史预算行的身份与层级。
  const actualAccountTotals = new Map<number, number>();
  const actualOrgTotals = new Map<number, number>();
  const actualQuantityTotals = new Map<number, number>();
  const unbudgetedAccountIds = new Set<number>();
  const unbudgetedOrgIds = new Set<number>();
  const budgetAccountIds = new Set(budgetAccRows.map((row) => row.id));
  const budgetOrgIds = new Set(budgetOrgRows.map((row) => row.id));
  const actualAccById = new Map(actual.accRows.map((row) => [row.id, row]));
  const actualOrgById = new Map(actual.orgRows.map((row) => [row.id, row]));
  for (const projection of actualProjections) {
    for (const accountId of projection.accountChain) {
      actualAccountTotals.set(accountId, safeIntegerAdd(actualAccountTotals.get(accountId) ?? 0, projection.entry.amountCents, '当前实际科目层级汇总'));
      if (projection.budgetLeafAccountId == null && !budgetAccountIds.has(accountId) && actualAccById.has(accountId)) {
        unbudgetedAccountIds.add(accountId);
      }
    }
    for (const orgId of projection.orgChain) {
      actualOrgTotals.set(orgId, safeIntegerAdd(actualOrgTotals.get(orgId) ?? 0, projection.entry.amountCents, '当前实际组织层级汇总'));
      if (projection.budgetLeafOrgId == null && !budgetOrgIds.has(orgId) && actualOrgById.has(orgId)) {
        unbudgetedOrgIds.add(orgId);
      }
    }
    if (projection.entry.quantity != null) {
      for (const accountId of projection.accountChain) {
        if (actualAccById.get(accountId)?.quantity_agg === 'none') break;
        actualQuantityTotals.set(accountId, safeIntegerAdd(actualQuantityTotals.get(accountId) ?? 0, projection.entry.quantity, '当前实际数量层级汇总'));
      }
    }
  }

  const buildAccountRows = (ids: Set<number>) => [...ids]
    .map((id) => {
      const node = budgetAccRows.find((a) => a.id === id)!;
      const accSub = subtreeIds(budgetAccRows, id);
      let bSum = 0;
      for (const la of leafAccs) if (accSub.has(la)) bSum = safeIntegerAdd(bSum, scopeBudget.get(la) ?? 0, '科目预算汇总');
      const aSum = scopeActualByAccount.get(id) ?? 0;
      const rowBudgetQuantity = node.type === 'quantity'
        ? budgetQuantity(id, node.quantity_agg)
        : 0;
      const rowActualQuantity = node.type === 'quantity'
        ? actualQuantity(id, node.quantity_agg)
        : 0;
      return {
        accountId: id,
        parentId: node.parent_id,
        code: node.code,
        name: node.name,
        type: String(node.type ?? ''),
        unit: String(node.unit ?? ''),
        level: depthOf(budgetAccRows, id),
        isLeaf: budgetRoll.leafAccountIds.includes(id),
        unbudgeted: false,
        cell: makeCell(bSum, aSum, node.type as AccountType, rowBudgetQuantity, rowActualQuantity, timeProgressValue),
      };
    });
  const buildUnbudgetedAccountRows = (applySummaryLevel: boolean) => [...unbudgetedAccountIds]
    .map((id) => {
      const node = actualAccById.get(id)!;
      const rowActualQuantity = node.type === 'quantity'
        ? node.quantity_agg === 'none'
          ? averageQuantity(actualProjections
            .filter((projection) => projection.entry.quantity != null && projection.accountChain.includes(id))
            .map((projection) => projection.entry.quantity!))
          : actualQuantityTotals.get(id) ?? 0
        : 0;
      return {
        accountId: id,
        parentId: node.parent_id,
        code: node.code,
        name: node.name,
        type: String(node.type ?? ''),
        unit: String(node.unit ?? ''),
        level: depthOf(actual.accRows, id),
        isLeaf: actualRoll.leafAccountIds.includes(id),
        unbudgeted: true,
        cell: makeCell(0, actualAccountTotals.get(id) ?? 0, node.type as AccountType, 0, rowActualQuantity, timeProgressValue),
      };
    })
    .filter((row) => !applySummaryLevel || summaryMaxDepth == null || row.level <= summaryMaxDepth)
    .sort((x, y) => x.code.localeCompare(y.code));
  const finishAccountRows = (rows: ReturnType<typeof buildAccountRows>, applySummaryLevel: boolean) => rows
    .filter((row) => !applySummaryLevel || summaryMaxDepth == null || row.level <= summaryMaxDepth)
    .sort((x, y) => x.code.localeCompare(y.code));
  const byAccount = finishAccountRows(
    [...buildAccountRows(analysisScope.displayIds), ...buildUnbudgetedAccountRows(true)],
    true,
  );
  /**
   * 节奏偏离预警阈值(0-1 比率)：来自页面筛选(缺省 20pp)。
   * 预警分类只在后端实现一份(verification.ts classifyPace)，页面散点图、预警表、
   * VerifyBar 与助手都读取这里的 paceClass / verificationFacts，不再各自判定。
   */
  const warningThreshold = input.warningThreshold == null ? 0.2 : Math.min(1, Math.max(0, input.warningThreshold));
  const alertsEligible = actual.source !== 'none' && timeProgressValue != null;
  const analysisAccounts = finishAccountRows(
    [...buildAccountRows(analysisScope.calculationIds), ...buildUnbudgetedAccountRows(false)],
    false,
  ).map((row) => ({
    ...row,
    paceClass: (alertsEligible && row.isLeaf && row.type !== 'quantity' && row.cell.rate != null
      ? classifyPace(row.type, row.cell, warningThreshold)
      : null) as 'overspend' | 'lagging' | 'healthy' | null,
  }));

  /**
   * 预算体量:叶子科目按一级科目(顶行)分组,组内带符号求和(红字冲减在组内抵销),
   * 跨组取绝对值相加。直接对全部叶子取绝对值会把冲减也当体量;对全部叶子带符号
   * 求和则退化成净额,收入成本互抵后体量失真。数量型顶行与金额隔离,不参与。
   */
  const budgetAccNodeById = new Map(budgetAccRows.map((row) => [row.id, row]));
  const topMoneyAccIds = new Set(
    budgetAccRows.filter((row) => row.parent_id == null && String(row.type ?? '') !== 'quantity').map((row) => row.id),
  );
  const leafTopAcc = new Map<number, number>();
  for (const leafId of leafAccs) {
    let cur = budgetAccNodeById.get(leafId);
    while (cur && cur.parent_id != null) cur = budgetAccNodeById.get(cur.parent_id);
    if (cur && topMoneyAccIds.has(cur.id)) leafTopAcc.set(leafId, cur.id);
  }
  const budgetVolumeOf = (orgId: number): number => {
    const byTop = new Map<number, number>();
    for (const [leafId, topId] of leafTopAcc) {
      byTop.set(topId, safeIntegerAdd(byTop.get(topId) ?? 0, cellOf(budgetRoll, orgId, leafId), '组织预算体量汇总'));
    }
    let volume = 0;
    for (const sum of byTop.values()) volume = safeIntegerAdd(volume, Math.abs(sum), '组织预算体量汇总');
    return volume;
  };

  const budgetOrgRowsForReport = [...orgScope]
    .map((id) => {
      const node = budgetOrgRows.find((o) => o.id === id)!;
      let budgetCents = 0;
      for (const accountId of leafAccs) {
        budgetCents = safeIntegerAdd(budgetCents, cellOf(budgetRoll, id, accountId), '组织层级预算汇总');
      }
      return {
        orgId: id,
        parentId: node.parent_id,
        code: node.code,
        name: node.name,
        level: depthOf(budgetOrgRows, id),
        isLeaf: budgetRoll.leafOrgIds.includes(id),
        unbudgeted: false,
        budgetVolumeCents: budgetVolumeOf(id),
        cell: makeCell(budgetCents, scopeActualByOrg.get(id) ?? 0, undefined, 0, 0, timeProgressValue), // 净额,利润方向
      };
    });
  const unbudgetedOrgRows = [...unbudgetedOrgIds]
    .map((id) => {
      const node = actualOrgById.get(id)!;
      return {
        orgId: id,
        parentId: node.parent_id,
        code: node.code,
        name: node.name,
        level: depthOf(actual.orgRows, id),
        isLeaf: actualRoll.leafOrgIds.includes(id),
        unbudgeted: true,
        budgetVolumeCents: 0,
        cell: makeCell(0, actualOrgTotals.get(id) ?? 0, undefined, 0, 0, timeProgressValue),
      };
    });
  const byOrg = [...budgetOrgRowsForReport, ...unbudgetedOrgRows]
    .filter((row) => summaryMaxDepth == null || row.level <= summaryMaxDepth)
    .sort((x, y) => x.code.localeCompare(y.code));

  // 指标:以范围内科目叶子总额重算(公式作用于范围合计),与指标穿透同源
  const scopedBudgetRoll = scopedMetricRollup(scope, 'budget');
  const scopedActualRoll = scopedMetricRollup(scope, 'actual');
  const scopedMetrics = scopedBudgetRoll.metrics;
  const scopedActualMetrics = scopedActualRoll.metrics;

  const metricRows = metrics
    .filter((m) => m.kind !== 'ratio')
    .map((m) => ({
      metricId: m.id,
      code: m.code,
      name: m.name,
      displaySign: m.display_sign,
      cell: makeCell(scopedMetrics.get(m.id) ?? 0, scopedActualMetrics.get(m.id) ?? 0, undefined, 0, 0, timeProgressValue, m.display_sign),
    }));

  // 比率指标:预算与实际各自「先汇总分子分母再相除」,差异用百分点而非完成率。
  const emptyRatio = (): MetricRatioValue => ({
    scaled: null, special: 'na_zero_denominator', numeratorRaw: 0, denominatorRaw: 0,
    numeratorBasis: 'money', denominatorBasis: 'money',
  });
  const ratioMetrics: RatioMetricRow[] = metrics
    .filter((m) => m.kind === 'ratio')
    .map((m) => {
      const budgetRatio = scopedBudgetRoll.metricRatios.get(m.id) ?? emptyRatio();
      const actualRatio = scopedActualRoll.metricRatios.get(m.id) ?? emptyRatio();
      const deltaScaled = budgetRatio.scaled == null || actualRatio.scaled == null
        ? null
        : safeIntegerAdd(actualRatio.scaled, -budgetRatio.scaled, '比率指标差异');
      const favorable: RatioMetricRow['favorable'] = deltaScaled == null || deltaScaled === 0
        ? 'none'
        : (deltaScaled > 0) === (m.direction === 'higher_better') ? 'favorable' : 'unfavorable';
      return {
        metricId: m.id,
        code: m.code,
        name: m.name,
        direction: m.direction,
        displayFormat: m.display_format,
        unit: m.unit,
        budget: budgetRatio,
        actual: actualRatio,
        deltaScaled,
        favorable,
      };
    });

  const treeBasis = {
    org: `预算:版本绑定组织树快照 #${version.org_tree_snapshot_id};实际:${actual.source === 'current' ? '当前组织树' : actual.source === 'none' ? '无实际数据' : '快照绑定组织树'}`,
    account: `预算:版本绑定科目树快照 #${version.account_tree_snapshot_id};实际:${actual.source === 'current' ? '当前科目树' : actual.source === 'none' ? '无实际数据' : '快照绑定科目树'}`,
  };
  const { unbudgetedActual, reconciliation } = scopeActualCoverage(scope);
  /**
   * 核验事实(§9.5):页面 VerifyBar、小澧助手与导出共用。
   * 分类与上面的 paceClass 共用 verification.ts 的 classifyPace。
   */
  const verificationFacts = completionVerificationFacts({
    actualSource: actual.source,
    reconciliation,
    unbudgetedActual,
    analysisAccounts,
    timeProgressValue,
    warningThreshold,
    scope: {
      versionId: version.id,
      batchId: actual.batchId,
      orgScopeId: input.orgScopeId ?? null,
      accountScopeId: input.accountScopeId ?? null,
      sheetKey: input.sheetKey || 'all',
    },
  });
  const notes = [
    '差异列为带符号利润方向口径(实际-预算,正数有利);完成率为无符号展示口径(实际业务金额/预算业务金额)',
    '时间进度为均匀自然日进度,仅用于执行节奏分析,不代表月度预算',
    '实际按当前/快照树祖先链投影到最近的预算快照节点；新增子节点若仍有预算叶子祖先则由该预算叶子承接',
    unbudgetedActual.count > 0
      ? `有 ${unbudgetedActual.count} 条实际在组织或科目维度没有预算叶子祖先，已完整列入未预算实际承接区（净额 ${unbudgetedActual.amountCents} 分）`
      : '所选范围内全部实际均可投影到预算组织叶子与科目叶子，无未预算实际',
    `实际来源与“预算叶子投影 + 未预算承接区”逐分勾稽，差额 ${reconciliation.differenceCents} 分`,
    ...(ratioMetrics.length
      ? ['比率指标不可加总:各行按「先汇总分子分母再相除」重算;差异为百分点差(实际比率-预算比率),不是完成率;有利方向按指标自身声明判断']
      : []),
  ];
  return {
    version,
    asOfDate: actual.asOfDate,
    timeProgressValue,
    actualSource: actual.source,
    actualBatchId: actual.batchId,
    treeBasis,
    scopeBasis: {
      sheetKey: input.sheetKey || 'all',
      sheetName: analysisScope.sheetName,
      orgScopeId: input.orgScopeId ?? null,
      accountScopeId: input.accountScopeId ?? null,
      summaryLevel: input.summaryLevel ?? null,
    },
    byAccount,
    analysisAccounts,
    byOrg,
    metrics: metricRows,
    ratioMetrics,
    unbudgetedActual,
    reconciliation,
    verificationFacts,
    notes,
  };
}

/* ============ 年度关闭与重开(方案三.5) ============ */

export function freezeYear(db: DB, year: number, finalBatchId: number, confirmations: { empty?: boolean; nonCurrent?: boolean } = {}) {
  const state = getYearState(db, year);
  if (!state) throw Errors.notFound(`${year} 年度尚未录入实际数据`);
  if (state.status !== 'open') throw Errors.conflict(`${year} 年度已是冻结状态`);
  const batch = getBatch(db, finalBatchId);
  if (batch.year !== year) throw Errors.validation('最终快照批次不属于该年度');
  if (batch.status !== 'active') throw Errors.validation('最终快照必须是 active 状态的批次');
  const entries = getBatchEntries(db, finalBatchId);
  if (entries.length === 0 && !confirmations.empty) {
    throw Errors.conflict('最终快照没有任何明细；如该年度确为零申报，必须显式确认零申报');
  }
  if ((batch.updates_current !== 1 || state.current_batch_id !== batch.id) && !confirmations.nonCurrent) {
    throw Errors.conflict('所选批次不是该年度当前实际快照，必须专项确认后才能关闭年度');
  }
  const orgRows = loadSnapshotNodes(db, batch.org_tree_snapshot_id);
  const accRows = loadSnapshotNodes(db, batch.account_tree_snapshot_id);
  if (orgRows.length === 0 || accRows.length === 0) throw Errors.validation('最终快照绑定树为空，不能关闭年度');
  const leafOrgs = computeLeafIds(orgRows);
  const leafAccs = computeLeafIds(accRows);
  for (const [index, entry] of entries.entries()) {
    if (!leafOrgs.has(entry.orgId) || !leafAccs.has(entry.accountId)) {
      throw Errors.validation(`最终快照第 ${index + 1} 条引用的组织或科目不是绑定树叶子节点`);
    }
    if (!Number.isSafeInteger(entry.amountCents) || (entry.quantity != null && !Number.isSafeInteger(entry.quantity))) {
      throw Errors.validation(`最终快照第 ${index + 1} 条数值超出安全范围`);
    }
  }
  const now = new Date().toISOString();
  db.transaction(() => {
    db.prepare('UPDATE actual_year_state SET status = ?, final_batch_id = ?, frozen_at = ?, updated_at = ? WHERE year = ?')
      .run('frozen', finalBatchId, now, now, year);
    writeLog(db, 'year.freeze', 'actual_year', year, { finalBatchId, snapshotDate: batch.snapshot_date, zeroDeclared: entries.length === 0, nonCurrentConfirmed: Boolean(confirmations.nonCurrent) });
  })();
  return getYearState(db, year);
}

export function reopenYear(db: DB, year: number, reason: string) {
  const state = getYearState(db, year);
  if (!state) throw Errors.notFound(`${year} 年度不存在`);
  if (state.status !== 'frozen') throw Errors.conflict(`${year} 年度未冻结`);
  if (!reason?.trim()) throw Errors.validation('重新打开年度必须填写原因');
  db.transaction(() => {
    db.prepare('UPDATE actual_year_state SET status = ?, updated_at = ? WHERE year = ?').run('open', new Date().toISOString(), year);
    writeLog(db, 'year.reopen', 'actual_year', year, { reason: reason.trim(), keptFinalBatchId: state.final_batch_id });
  })();
  return getYearState(db, year);
}

/* ============ 历年预实对比(方案九.6) ============ */

export interface YearCompareRow {
  year: number;
  budgetVersionName: string | null;
  budgetVersionId: number | null;
  finalSnapshotDate: string | null;
  totals: {
    incomeBudget: number; incomeActual: number;
    costBudget: number; costActual: number;
    expenseBudget: number; expenseActual: number;
    profitBudget: number; profitActual: number;
  };
  varianceProfit: number; // 实际利润 - 预算利润
  rateIncome: number | null;
  rateProfit: number | null;
  yoyProfit: number | null; // 利润同比增长
  accuracyProfit: number | null; // Q = max(0, 1-E)
}

export function historicalComparison(db: DB): { years: YearCompareRow[]; notes: string[] } {
  const states = db
    .prepare("SELECT * FROM actual_year_state WHERE status = 'frozen' ORDER BY year")
    .all() as { year: number; final_batch_id: number | null }[];
  const rows: YearCompareRow[] = [];
  for (const s of states) {
    let budgetVersion: BudgetVersionRow | undefined;
    const cur = db
      .prepare("SELECT id FROM budget_version WHERE year = ? AND kind = 'budget' AND is_current = 1")
      .get(s.year) as { id: number } | undefined;
    if (cur) budgetVersion = getVersion(db, cur.id);
    let bIncome = 0, bCost = 0, bExpense = 0, aIncome = 0, aCost = 0, aExpense = 0;
    let profitBudget = 0, profitActual = 0;
    let finalSnapshotDate: string | null = null;
    if (budgetVersion) {
      const ents = db.prepare('SELECT org_id, account_id, amount_cents FROM budget_entry WHERE version_id = ?').all(budgetVersion.id) as { org_id: number; account_id: number; amount_cents: number }[];
      const accRows = loadSnapshotNodes(db, budgetVersion.account_tree_snapshot_id);
      const typeOf = new Map(accRows.map((a) => [a.id, a.type]));
      // 预算明细为叶子级,直接按科目类型归类求和
      for (const e of ents) {
        const t = typeOf.get(e.account_id) ?? 'expense';
        if (t === 'income') bIncome = safeIntegerAdd(bIncome, e.amount_cents, '历史收入汇总');
        else if (t === 'cost') bCost = safeIntegerAdd(bCost, e.amount_cents, '历史成本汇总');
        else bExpense = safeIntegerAdd(bExpense, e.amount_cents, '历史费用汇总');
      }
      profitBudget = safeIntegerAdd(safeIntegerAdd(bIncome, bCost, '预算利润汇总'), bExpense, '预算利润汇总');
    }
    if (s.final_batch_id != null) {
      const batch = getBatch(db, s.final_batch_id);
      finalSnapshotDate = batch.snapshot_date;
      const ents = getBatchEntries(db, batch.id);
      const trees = batchTrees(db, batch);
      const typeOf = new Map(trees.accRows.map((a) => [a.id, (a.type ?? 'expense') as string]));
      for (const e of ents) {
        const t = typeOf.get(e.accountId) ?? 'expense';
        if (t === 'income') aIncome = safeIntegerAdd(aIncome, e.amountCents, '历史实际收入汇总');
        else if (t === 'cost') aCost = safeIntegerAdd(aCost, e.amountCents, '历史实际成本汇总');
        else aExpense = safeIntegerAdd(aExpense, e.amountCents, '历史实际费用汇总');
      }
      profitActual = safeIntegerAdd(safeIntegerAdd(aIncome, aCost, '实际利润汇总'), aExpense, '实际利润汇总');
    }
    const varianceProfit = safeIntegerAdd(profitActual, -profitBudget, '利润差异');
    const rateIncome = completionRate(aIncome, bIncome);
    const rateProfit = completionRate(profitActual, profitBudget);
    const E = profitBudget !== 0 ? Math.abs(varianceProfit) / Math.abs(profitBudget) : null;
    rows.push({
      year: s.year,
      budgetVersionName: budgetVersion?.name ?? null,
      budgetVersionId: budgetVersion?.id ?? null,
      finalSnapshotDate,
      totals: { incomeBudget: bIncome, incomeActual: aIncome, costBudget: bCost, costActual: aCost, expenseBudget: bExpense, expenseActual: aExpense, profitBudget, profitActual },
      varianceProfit,
      rateIncome,
      rateProfit,
      yoyProfit: null,
      accuracyProfit: E == null ? null : Math.max(0, 1 - E),
    });
  }
  for (let i = 1; i < rows.length; i++) {
    const previous = rows[i - 1];
    const prev = previous.totals.profitActual;
    rows[i].yoyProfit = rows[i].year === previous.year + 1 && prev !== 0
      ? safeIntegerAdd(rows[i].totals.profitActual, -prev, '同比利润差异') / Math.abs(prev)
      : null;
  }
  return {
    years: rows,
    notes: [
      '历史年度一律读取年度关闭时指定的最终快照,不按当前树结构重算',
      '展示约定:页面与 Excel 的收入、成本、费用均为业务正数;接口 totals 中成本费用保留利润方向,利润与差异保持利润方向',
      '完成率使用业务展示口径,预算为零或负数时为 N/A;只有相邻自然年度才计算同比',
    ],
  };
}

/* ============ 年内完成率趋势(方案九.7) ============ */

export function yearTrend(db: DB, input: {
  year: number;
  versionId: number;
  accountScopeId?: number | null;
  orgScopeId?: number | null;
  sheetKey?: string | null;
  batchId?: number | null;
  trendKind?: 'metric' | 'account' | 'composite' | null;
  trendId?: number | null;
}) {
  const version = getVersion(db, input.versionId);
  if (version.year !== input.year) throw Errors.validation('预算版本年度不一致');
  // 趋势横轴每个日期只保留一个确定逻辑状态：同日 current 序列优先于 history，
  // 同序列内取最新 revision/id。指定 batchId 时按 (date,revision,id) 精确截止，不包含同日后续批次。
  const cutoffBatch = input.batchId != null ? getBatch(db, input.batchId) : null;
  if (cutoffBatch && cutoffBatch.year !== input.year) throw Errors.validation('趋势截止快照不属于所选年度');
  const compareBatch = (a: SnapshotBatchRow, b: SnapshotBatchRow) =>
    a.snapshot_date.localeCompare(b.snapshot_date) || a.revision - b.revision || a.id - b.id;
  const eligible = listBatches(db, input.year)
    .filter((batch) => batch.status === 'active' && (!cutoffBatch || compareBatch(batch, cutoffBatch) <= 0))
    .sort(compareBatch);
  const byDate = new Map<string, SnapshotBatchRow>();
  for (const batch of eligible) {
    const previous = byDate.get(batch.snapshot_date);
    if (!previous
      || batch.updates_current > previous.updates_current
      || (batch.updates_current === previous.updates_current && compareBatch(previous, batch) < 0)) {
      byDate.set(batch.snapshot_date, batch);
    }
  }
  const batches = [...byDate.values()].sort(compareBatch);
  const scopeInput: CompletionInput = {
    versionId: version.id,
    orgScopeId: input.orgScopeId ?? null,
    accountScopeId: input.accountScopeId ?? null,
    sheetKey: input.sheetKey ?? null,
  };
  // 预算口径与实际来源无关；这里复用 completionScope 是为了让范围、叶子判断、
  // 指标快照和后续每个批次的投影规则完全一致。
  const baseScope = completionScope(db, { ...scopeInput, batchId: input.batchId ?? null });
  const accRows = baseScope.budgetAccRows;
  const accScope = baseScope.analysisScope.calculationIds;
  const metrics = baseScope.metrics;
  const trendKind = input.trendKind ?? 'composite';
  const selectedMetric = trendKind === 'metric' ? metrics.find((metric) => metric.id === input.trendId) : undefined;
  const selectedAccount = trendKind === 'account' ? accRows.find((account) => account.id === input.trendId) : undefined;
  if (trendKind === 'metric' && !selectedMetric) throw Errors.validation('所选趋势报表指标不存在或已停用');
  if (selectedMetric?.kind === 'ratio') {
    // 比率与均匀自然日进度不可比:比率没有「年初至今累计」语义,完成率口径对它无意义。
    throw Errors.validation(`${selectedMetric.name}(${selectedMetric.code})是比率型指标,不能与自然日进度比较;年内趋势请选择金额指标或科目`);
  }
  if (trendKind === 'account' && !selectedAccount) throw Errors.validation('所选趋势科目不在预算版本绑定树中');
  if (selectedAccount && !accScope.has(selectedAccount.id)) throw Errors.validation('所选趋势科目不在当前预算表格/科目范围内');
  if (selectedAccount?.type === 'quantity' && selectedAccount.quantity_agg !== 'sum') {
    throw Errors.validation('非累计型数量指标不能与自然日进度比较');
  }

  const targetValue = (scope: CompletionScope, which: 'budget' | 'actual'): number => {
    if (trendKind === 'metric') {
      return (scopedMetricRollup(scope, which).metrics.get(selectedMetric!.id) ?? 0) * selectedMetric!.display_sign;
    }
    if (trendKind === 'account') {
      const totals = scopedMetricRollup(scope, which);
      if (selectedAccount!.type === 'quantity') return quantityCellOf(totals, 0, selectedAccount!.id);
      return cellOf(totals, 0, selectedAccount!.id) * signOfType(selectedAccount!.type);
    }
    if (which === 'budget') {
      const budgetAccById = new Map(scope.budgetAccRows.map((row) => [row.id, row]));
      let total = 0;
      for (const [accountId, amountCents] of scope.scopeBudget) {
        total = safeIntegerAdd(total, amountCents * signOfType(budgetAccById.get(accountId)?.type), '趋势综合预算汇总');
      }
      return total;
    }
    // 综合口径以来源实际明细为互斥集合，包含完全没有预算祖先的新根组织/科目；
    // 科目类型取实际来源树，因而仍能按收入/成本费用业务正数计算完成率。
    const actualAccById = new Map(scope.actual.accRows.map((row) => [row.id, row]));
    let total = 0;
    for (const projection of scope.actualProjections) {
      total = safeIntegerAdd(
        total,
        projection.entry.amountCents * signOfType(actualAccById.get(projection.entry.accountId)?.type),
        '趋势综合实际汇总',
      );
    }
    return total;
  };
  const budgetDisplay = targetValue(baseScope, 'budget');
  const target = selectedMetric
    ? { kind: 'metric' as const, id: selectedMetric.id, code: selectedMetric.code, name: selectedMetric.name, type: selectedMetric.display_sign === -1 ? 'cost' : 'profit', unit: '万元' }
    : selectedAccount
      ? { kind: 'account' as const, id: selectedAccount.id, code: selectedAccount.code, name: selectedAccount.name, type: selectedAccount.type ?? '', unit: selectedAccount.type === 'quantity' ? (selectedAccount.unit ?? '') : '万元' }
      : { kind: 'composite' as const, id: null, code: 'COMPOSITE', name: '所选范围综合完成率', type: 'composite', unit: '%' };
  const points = batches.map((b) => {
    // 每个批次点只重建实际来源侧:预算侧与批次无关,baseScope 已算过;逐点全量
    // 重建 completionScope 会把树快照解析、指标加载与预算 rollup 重做 N 遍。
    const pointScope = completionScope(db, { ...scopeInput, batchId: b.id });
    const actualDisplay = targetValue(pointScope, 'actual');
    const rate = completionRate(actualDisplay, budgetDisplay);
    const coverage = scopeActualCoverage(pointScope);
    return {
      date: b.snapshot_date,
      batchId: b.id,
      actualDisplayCents: actualDisplay,
      budgetDisplayCents: budgetDisplay,
      rate,
      timeProgress: timeProgress(b.snapshot_date),
      progressDeviation: rate == null ? null : rate - timeProgress(b.snapshot_date),
      unbudgetedActualCount: coverage.unbudgetedActual.count,
      unbudgetedActualCents: coverage.unbudgetedActual.amountCents,
      reconciliation: coverage.reconciliation,
    };
  });
  return {
    year: input.year,
    version,
    target,
    budgetDisplayCents: budgetDisplay,
    points,
    scopeBasis: { sheetKey: input.sheetKey || 'all', orgScopeId: input.orgScopeId ?? null, accountScopeId: input.accountScopeId ?? null },
    notes: [
      'R_t = 截止日累计实际 / 年度预算(无符号展示口径);叠加均匀自然日进度曲线',
      '每个点复用完成情况的树投影：新增子节点由最近预算叶子承接；没有预算叶子祖先的实际计入综合趋势，并在点位返回未预算金额与逐分对账',
      '同日只展示一个点:current 快照优先于历史补录，同序列取最新修订',
      cutoffBatch ? `统计精确截至批次 #${cutoffBatch.id} (${cutoffBatch.snapshot_date}, 修订 ${cutoffBatch.revision})` : '统计年度内 active 快照',
    ],
  };
}

/* ============ 版本对比(方案九.8) ============ */

export interface VersionCompareResult {
  baseVersion: BudgetVersionRow;
  targetVersion: BudgetVersionRow;
  treeSame: boolean;
  addedOrgCodes: string[];
  removedOrgCodes: string[];
  addedAccountCodes: string[];
  removedAccountCodes: string[];
  leafChanges: { orgId: number; orgCode: string; accountId: number; accountCode: string; baseCents: number; targetCents: number; deltaCents: number; changeRate: number | null }[];
  totalBase: number;
  totalTarget: number;
  notes: string[];
  targetOrgRows: TreeNodeRow[];
  targetAccountRows: TreeNodeRow[];
}

export function versionCompare(db: DB, baseVersionId: number, targetVersionId: number): VersionCompareResult {
  const base = getVersion(db, baseVersionId);
  const target = getVersion(db, targetVersionId);
  if (base.year !== target.year) throw Errors.validation('版本对比仅支持同年度版本');
  const baseOrg = loadSnapshotNodes(db, base.org_tree_snapshot_id);
  const targetOrg = loadSnapshotNodes(db, target.org_tree_snapshot_id);
  const baseAcc = loadSnapshotNodes(db, base.account_tree_snapshot_id);
  const targetAcc = loadSnapshotNodes(db, target.account_tree_snapshot_id);
  const treeSame = base.org_tree_snapshot_id === target.org_tree_snapshot_id && base.account_tree_snapshot_id === target.account_tree_snapshot_id;
  const codesOf = (nodes: { code: string }[]) => new Set(nodes.map((n) => n.code));
  const baseOrgCodes = codesOf(baseOrg);
  const targetOrgCodes = codesOf(targetOrg);
  const baseAccCodes = codesOf(baseAcc);
  const targetAccCodes = codesOf(targetAcc);
  const baseEntries = new Map(
    (db.prepare('SELECT org_id, account_id, amount_cents FROM budget_entry WHERE version_id = ?').all(base.id) as { org_id: number; account_id: number; amount_cents: number }[])
      .map((r) => [`${r.org_id}:${r.account_id}`, r.amount_cents])
  );
  const targetEntries = new Map(
    (db.prepare('SELECT org_id, account_id, amount_cents FROM budget_entry WHERE version_id = ?').all(target.id) as { org_id: number; account_id: number; amount_cents: number }[])
      .map((r) => [`${r.org_id}:${r.account_id}`, r.amount_cents])
  );
  const targetOrgById = new Map(targetOrg.map((n: { id: number; code: string }) => [n.id, n.code]));
  const targetAccById = new Map(targetAcc.map((n: { id: number; code: string }) => [n.id, n.code]));
  const baseOrgById = new Map(baseOrg.map((n: { id: number; code: string }) => [n.id, n.code]));
  const baseAccById = new Map(baseAcc.map((n: { id: number; code: string }) => [n.id, n.code]));
  const allKeys = new Set([...baseEntries.keys(), ...targetEntries.keys()]);
  const leafChanges = [];
  let totalBase = 0;
  let totalTarget = 0;
  for (const key of allKeys) {
    const [orgIdStr, accIdStr] = key.split(':');
    const orgId = Number(orgIdStr);
    const accountId = Number(accIdStr);
    const b = baseEntries.get(key) ?? 0;
    const t = targetEntries.get(key) ?? 0;
    totalBase = safeIntegerAdd(totalBase, b, '版本对比基准汇总');
    totalTarget = safeIntegerAdd(totalTarget, t, '版本对比目标汇总');
    if (b === t) continue;
    leafChanges.push({
      orgId,
      orgCode: targetOrgById.get(orgId) ?? baseOrgById.get(orgId) ?? `id:${orgId}`,
      accountId,
      accountCode: targetAccById.get(accountId) ?? baseAccById.get(accountId) ?? `id:${accountId}`,
      baseCents: b,
      targetCents: t,
      deltaCents: safeIntegerAdd(t, -b, '版本对比差异'),
      changeRate: b !== 0 ? safeIntegerAdd(t, -b, '版本对比差异') / Math.abs(b) : null,
    });
  }
  leafChanges.sort((x, y) => Math.abs(y.deltaCents) - Math.abs(x.deltaCents));
  return {
    baseVersion: base,
    targetVersion: target,
    treeSame,
    addedOrgCodes: [...targetOrgCodes].filter((c) => !baseOrgCodes.has(c)),
    removedOrgCodes: [...baseOrgCodes].filter((c) => !targetOrgCodes.has(c)),
    addedAccountCodes: [...targetAccCodes].filter((c) => !baseAccCodes.has(c)),
    removedAccountCodes: [...baseAccCodes].filter((c) => !targetAccCodes.has(c)),
    leafChanges,
    totalBase,
    totalTarget,
    targetOrgRows: targetOrg,
    targetAccountRows: targetAcc,
    notes: [
      '叶子数据按稳定组织/科目 ID 对齐,新增组合原版本按零处理',
      '汇总使用目标版本(第二个)树结构口径',
      '页面组织与科目筛选同样使用目标版本绑定树快照口径',
      ...(treeSame ? [] : ['注意:两版本树快照不一致,结构口径不同']),
    ],
  };
}

/* ============ 预算准确率(方案九.9) ============ */

export function accuracyReport(db: DB, year: number) {
  const state = getYearState(db, year);
  if (!state || state.status !== 'frozen' || state.final_batch_id == null) {
    throw Errors.validation(`${year} 年度未关闭,预算准确率在年度冻结后计算`);
  }
  const comp = historicalComparison(db);
  const row = comp.years.find((y) => y.year === year);
  if (!row) throw Errors.validation('未找到该年度数据');
  const E = (a: number, b: number) => (b !== 0 ? Math.abs(safeIntegerAdd(a, -b, '准确率差异')) / Math.abs(b) : null);
  const typeAccuracy = {
    income: { e: E(row.totals.incomeActual, row.totals.incomeBudget), q: null as number | null, rate: row.rateIncome },
    cost: { e: E(row.totals.costActual, row.totals.costBudget), q: null as number | null, rate: completionRate(-row.totals.costActual, -row.totals.costBudget) },
    expense: { e: E(row.totals.expenseActual, row.totals.expenseBudget), q: null as number | null, rate: completionRate(-row.totals.expenseActual, -row.totals.expenseBudget) },
    profit: { e: E(row.totals.profitActual, row.totals.profitBudget), q: row.accuracyProfit, rate: row.rateProfit },
  };
  for (const t of Object.values(typeAccuracy)) if (t.e != null) t.q = Math.max(0, 1 - t.e);
  return {
    year,
    row,
    typeAccuracy,
    notes: ['偏差率 E = |实际-预算| / |预算|;准确率 Q = max(0, 1-E);预算为 0 显示 N/A', '同时保留完成率,避免单一准确率掩盖超支/未完成方向'],
  };
}

