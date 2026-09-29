import type { DB } from '../../db/connection';
import { Errors } from '../../core/errors';
import { signOfType, safeIntegerAdd, scaledRatio, RATIO_SCALE, MONEY_NATURAL_DIVISOR } from '../../core/money';
import { ancestorChain } from '../../core/tree';
import {
  completionScope,
  scopedMetricRollup,
  scopeActualCoverage,
  type CompletionInput,
  type UnbudgetedActual,
  type ActualReconciliation,
} from './report.service';
import { structureVerificationFacts, type VerificationFactItem } from './verification';
import type { BudgetVersionRow } from '../budget/budget.service';

/**
 * 结构占比分析(共同比报表)。
 *
 * 每个科目节点的子树合计 ÷ 基准 = 该节点在基准里的占比,预算与实际各算一遍,
 * 差异用**百分点**表示结构变化(与比率指标同口径,不是完成率)。
 *
 * 取数完全复用完成情况表的链路:`scopedMetricRollup(scope, which).cell.get(0)`
 * 已经是「范围内每个科目节点(含中间节点)的子树合计」,因为 rollup 会把叶子明细
 * 沿科目祖先链累计。所以这里不重算任何汇总,只做除法与符号归一。
 *
 * 口径要点:
 * - **符号归一**:科目合计带利润方向符号(收入 +,成本费用 −),分子分母各自乘
 *   signOfType 后再相除,于是「营业成本占营业收入」读作正的 13.4% 而不是 −13.4%。
 * - **基准非正即 N/A**:基准为 0 或归一后为负(例如亏损年度拿净利润当基准)时,
 *   占比没有业务含义,返回 null 并标记原因,不伪造 0。
 * - **占比不可跨行相加**(唯一例外是同一父节点下的子项,见 reconciliation)。
 * - **数量科目不参与**:金额恒为 0,占比无意义,直接排除。
 */

/** 基准口径:占上级 / 占某科目子树 / 占某金额指标 */
export type StructureBasisMode = 'parent' | 'account' | 'metric';

export interface StructureInput extends CompletionInput {
  basisMode?: StructureBasisMode | null;
  /** basisMode=account 时为科目节点 id;=metric 时为指标 id;=parent 时忽略 */
  basisId?: number | null;
}

export interface StructureShare {
  /** RATIO_SCALE(10^6)缩放的占比;基准非正时为 null */
  scaled: number | null;
  special: null | 'na_zero_basis' | 'na_negative_basis';
  /** 已按 signOfType 归一到业务读法的分子(分) */
  numeratorCents: number;
  /** 已归一的基准(分) */
  basisCents: number;
}

export interface StructureRow {
  accountId: number;
  parentId: number | null;
  code: string;
  name: string;
  type: string;
  level: number;
  isLeaf: boolean;
  /** 带符号原值(利润方向),供核对 */
  budgetCents: number;
  actualCents: number;
  budget: StructureShare;
  actual: StructureShare;
  /** 实际占比 − 预算占比,RATIO_SCALE 缩放;除以 10^4 得百分点。任一侧 N/A 则为 null */
  deltaScaled: number | null;
  /** 该行实际使用的基准说明(parent 模式下逐行不同) */
  basisLabel: string;
}

export interface StructureReconciliation {
  parentId: number;
  parentCode: string;
  parentName: string;
  childCount: number;
  /** 子项金额之和与父节点金额:rollup 沿祖先链累计,二者必须逐分相等 */
  budgetChildSumCents: number;
  budgetParentCents: number;
  actualChildSumCents: number;
  actualParentCents: number;
  amountReconciled: boolean;
  /** 子项「占父」比重之和(RATIO_SCALE);理论值 10^6,偏差来自各行独立四舍五入 */
  budgetShareSumScaled: number | null;
  actualShareSumScaled: number | null;
}

export interface StructureReport {
  version: BudgetVersionRow;
  asOfDate: string | null;
  actualSource: 'current' | 'snapshot' | 'final' | 'none';
  actualBatchId: number | null;
  treeBasis: { org: string; account: string };
  scopeBasis: {
    sheetKey: string; sheetName: string;
    orgScopeId: number | null; accountScopeId: number | null; summaryLevel: number | null;
  };
  basis: { mode: StructureBasisMode; id: number | null; label: string };
  rows: StructureRow[];
  /** 同父子项守恒核对(仅统计范围内有 2 个及以上子项的父节点) */
  reconciliation: StructureReconciliation[];
  /** 至少一个维度无法落到预算叶子的实际原始明细。 */
  unbudgetedActual: UnbudgetedActual;
  /** 来源实际与预算叶子投影加未预算承接区的逐分勾稽。 */
  actualReconciliation: ActualReconciliation;
  /**
   * 核验事实(§9.5):页面 VerifyBar、助手与导出共用。
   * factKey ∈ actual_none / reconciliation / subtotal / unbudgeted(ownerKey structure:root)。
   */
  verificationFacts: VerificationFactItem[];
  notes: string[];
}

/** 结构占比表(共同比报表) */
export function structureReport(db: DB, input: StructureInput): StructureReport {
  const scope = completionScope(db, input);
  const { version, budgetAccRows, actual, analysisScope, metrics } = scope;
  const mode: StructureBasisMode = input.basisMode ?? 'parent';
  if (mode !== 'parent' && mode !== 'account' && mode !== 'metric') {
    throw Errors.validation('结构占比基准必须是 parent、account 或 metric');
  }

  const budgetTotals = scopedMetricRollup(scope, 'budget');
  const actualTotals = scopedMetricRollup(scope, 'actual');
  const budgetByAccount = budgetTotals.cell.get(0) ?? new Map<number, number>();
  const actualByAccount = actualTotals.cell.get(0) ?? new Map<number, number>();

  const accById = new Map(budgetAccRows.map((row) => [row.id, row]));
  const signOf = (accountId: number): 1 | -1 => signOfType(accById.get(accountId)?.type);
  const summaryMaxDepth = input.summaryLevel == null ? null : Math.max(0, input.summaryLevel - 1);
  const depthOf = (accountId: number) => ancestorChain(budgetAccRows, accountId).length - 1;

  /* ---- 解析基准 ---- */
  let basisId: number | null = null;
  let basisLabelGlobal = '';
  let globalBasis: { budget: number; actual: number } | null = null;
  if (mode === 'account') {
    if (input.basisId == null) throw Errors.validation('按科目取基准时必须指定基准科目');
    const node = accById.get(input.basisId);
    if (!node) throw Errors.validation('基准科目不在预算版本绑定的科目树快照中');
    if (node.type === 'quantity') throw Errors.validation('数量科目不能作为结构占比的基准(金额恒为零)');
    if (!analysisScope.calculationIds.has(node.id)) {
      // 基准落在范围外时它的合计只含范围内的叶子,占比会大于 100% 且无法解释
      throw Errors.validation(`基准科目 ${node.code} 不在当前预算表格/科目范围内,请先放宽范围或改选基准`);
    }
    basisId = node.id;
    basisLabelGlobal = `科目 ${node.code} ${node.name}`;
    globalBasis = {
      budget: (budgetByAccount.get(node.id) ?? 0) * signOf(node.id),
      actual: (actualByAccount.get(node.id) ?? 0) * signOf(node.id),
    };
  } else if (mode === 'metric') {
    if (input.basisId == null) throw Errors.validation('按指标取基准时必须指定基准指标');
    const metric = metrics.find((m) => m.id === input.basisId);
    if (!metric) throw Errors.validation('基准指标不存在或在该版本的固化定义中已停用');
    if (metric.kind === 'ratio') throw Errors.validation('比率型指标不能作为结构占比的基准(比率不是金额)');
    basisId = metric.id;
    basisLabelGlobal = `指标 ${metric.code} ${metric.name}`;
    // 指标已是利润方向,不再乘 signOfType
    globalBasis = {
      budget: budgetTotals.metrics.get(metric.id) ?? 0,
      actual: actualTotals.metrics.get(metric.id) ?? 0,
    };
  }

  const shareOf = (numeratorCents: number, basisCents: number): StructureShare => {
    if (basisCents === 0) {
      return { scaled: null, special: 'na_zero_basis', numeratorCents, basisCents };
    }
    if (basisCents < 0) {
      // 归一后仍为负:基准本身方向异常(如亏损),占比无业务含义
      return { scaled: null, special: 'na_negative_basis', numeratorCents, basisCents };
    }
    return {
      scaled: scaledRatio(numeratorCents, basisCents, MONEY_NATURAL_DIVISOR, MONEY_NATURAL_DIVISOR),
      special: null,
      numeratorCents,
      basisCents,
    };
  };

  /* ---- 逐行计算 ---- */
  const rows: StructureRow[] = [...analysisScope.displayIds]
    .map((accountId) => accById.get(accountId))
    .filter((node): node is NonNullable<typeof node> => node != null && node.type !== 'quantity')
    .map((node) => {
      const sign = signOf(node.id);
      const budgetCents = budgetByAccount.get(node.id) ?? 0;
      const actualCents = actualByAccount.get(node.id) ?? 0;
      const numBudget = budgetCents * sign;
      const numActual = actualCents * sign;

      let basis: { budget: number; actual: number } | null = globalBasis;
      let basisLabel = basisLabelGlobal;
      if (mode === 'parent') {
        const parentId = node.parent_id;
        const parentNode = parentId != null ? accById.get(parentId) : undefined;
        if (!parentNode || !analysisScope.calculationIds.has(parentNode.id)) {
          basis = null;
          basisLabel = parentNode ? `上级 ${parentNode.code} 不在当前范围` : '无上级(顶层科目)';
        } else {
          const parentSign = signOf(parentNode.id);
          basis = {
            budget: (budgetByAccount.get(parentNode.id) ?? 0) * parentSign,
            actual: (actualByAccount.get(parentNode.id) ?? 0) * parentSign,
          };
          basisLabel = `上级 ${parentNode.code} ${parentNode.name}`;
        }
      }

      const budgetShare = basis
        ? shareOf(numBudget, basis.budget)
        : { scaled: null, special: 'na_zero_basis' as const, numeratorCents: numBudget, basisCents: 0 };
      const actualShare = basis
        ? shareOf(numActual, basis.actual)
        : { scaled: null, special: 'na_zero_basis' as const, numeratorCents: numActual, basisCents: 0 };
      const deltaScaled = budgetShare.scaled == null || actualShare.scaled == null
        ? null
        : safeIntegerAdd(actualShare.scaled, -budgetShare.scaled, '结构占比差异');

      return {
        accountId: node.id,
        parentId: node.parent_id,
        code: node.code,
        name: node.name,
        type: String(node.type ?? ''),
        level: depthOf(node.id),
        isLeaf: budgetTotals.leafAccountIds.includes(node.id),
        budgetCents,
        actualCents,
        budget: budgetShare,
        actual: actualShare,
        deltaScaled,
        basisLabel,
      };
    })
    .filter((row) => summaryMaxDepth == null || row.level <= summaryMaxDepth)
    .sort((a, b) => a.code.localeCompare(b.code));

  /* ---- 同父子项守恒核对 ----
   * rollup 沿科目祖先链累计,所以「范围内各子节点子树合计之和」必然等于
   * 「父节点子树合计」——即使筛选范围排除了部分子科目,父节点也只累计范围内的叶子。
   * 这里把它算出来当断言:amountReconciled 为 false 说明汇总链路有 bug。
   * 占比之和则允许有几个 10^-6 的偏差,那是各行独立四舍五入的正常结果。
   */
  const childrenByParent = new Map<number, number[]>();
  for (const accountId of analysisScope.calculationIds) {
    const node = accById.get(accountId);
    if (!node || node.type === 'quantity') continue;
    const parentId = node.parent_id;
    if (parentId == null || !analysisScope.calculationIds.has(parentId)) continue;
    if (accById.get(parentId)?.type === 'quantity') continue;
    childrenByParent.set(parentId, [...(childrenByParent.get(parentId) ?? []), accountId]);
  }
  const reconciliation: StructureReconciliation[] = [...childrenByParent.entries()]
    .filter(([, children]) => children.length >= 2)
    .map(([parentId, children]) => {
      const parentNode = accById.get(parentId)!;
      const parentSign = signOf(parentId);
      const budgetParentCents = (budgetByAccount.get(parentId) ?? 0) * parentSign;
      const actualParentCents = (actualByAccount.get(parentId) ?? 0) * parentSign;
      let budgetChildSumCents = 0;
      let actualChildSumCents = 0;
      let budgetShareSumScaled: number | null = 0;
      let actualShareSumScaled: number | null = 0;
      for (const childId of children) {
        const childSign = signOf(childId);
        const b = (budgetByAccount.get(childId) ?? 0) * childSign;
        const a = (actualByAccount.get(childId) ?? 0) * childSign;
        budgetChildSumCents = safeIntegerAdd(budgetChildSumCents, b, '结构子项预算合计');
        actualChildSumCents = safeIntegerAdd(actualChildSumCents, a, '结构子项实际合计');
        const bShare = budgetParentCents > 0 ? scaledRatio(b, budgetParentCents, MONEY_NATURAL_DIVISOR, MONEY_NATURAL_DIVISOR) : null;
        const aShare = actualParentCents > 0 ? scaledRatio(a, actualParentCents, MONEY_NATURAL_DIVISOR, MONEY_NATURAL_DIVISOR) : null;
        budgetShareSumScaled = budgetShareSumScaled == null || bShare == null
          ? null
          : safeIntegerAdd(budgetShareSumScaled, bShare, '结构预算占比汇总');
        actualShareSumScaled = actualShareSumScaled == null || aShare == null
          ? null
          : safeIntegerAdd(actualShareSumScaled, aShare, '结构实际占比汇总');
      }
      return {
        parentId,
        parentCode: parentNode.code,
        parentName: parentNode.name,
        childCount: children.length,
        budgetChildSumCents,
        budgetParentCents,
        actualChildSumCents,
        actualParentCents,
        amountReconciled: budgetChildSumCents === budgetParentCents && actualChildSumCents === actualParentCents,
        budgetShareSumScaled,
        actualShareSumScaled,
      };
    })
    .sort((a, b) => a.parentCode.localeCompare(b.parentCode));

  const treeBasis = {
    org: `预算:版本绑定组织树快照 #${version.org_tree_snapshot_id};实际:${actual.source === 'current' ? '当前组织树' : actual.source === 'none' ? '无实际数据' : '快照绑定组织树'}`,
    account: `预算:版本绑定科目树快照 #${version.account_tree_snapshot_id};实际:${actual.source === 'current' ? '当前科目树' : actual.source === 'none' ? '无实际数据' : '快照绑定科目树'}`,
  };
  const coverage = scopeActualCoverage(scope);
  const notes = [
    mode === 'parent'
      ? '占比基准为每行的直接上级科目;顶层科目与上级不在范围内的科目显示 N/A'
      : `占比基准为${basisLabelGlobal},全表同一基准(共同比报表口径)`,
    '分子与基准各自按科目类型归一为业务读法(成本费用取正),因此占比为正数;基准为零或归一后为负时显示 N/A,不显示 0',
    '差异为结构百分点差(实际占比−预算占比),不是完成率;占比不可跨行相加,唯一例外是同一上级下的各子项',
    '金额为版本绑定树快照口径,与预算完成情况表同源(同一次范围汇总);当前树新增子节点投影到最近预算祖先',
    coverage.unbudgetedActual.count > 0
      ? `另有 ${coverage.unbudgetedActual.count} 条实际没有完整的预算叶子承接路径，已在未预算实际区原样列出`
      : '所选范围没有未预算实际',
    `来源实际与“预算叶子投影 + 未预算承接区”逐分勾稽，差额 ${coverage.reconciliation.differenceCents} 分`,
  ];

  return {
    version,
    asOfDate: actual.asOfDate,
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
    basis: { mode, id: basisId, label: mode === 'parent' ? '各行的直接上级科目' : basisLabelGlobal },
    rows,
    reconciliation,
    unbudgetedActual: coverage.unbudgetedActual,
    actualReconciliation: coverage.reconciliation,
    verificationFacts: structureVerificationFacts({
      actualSource: actual.source,
      reconciliation: coverage.reconciliation,
      unbudgetedActual: coverage.unbudgetedActual,
      unbudgetedAccountIds: coverage.unbudgetedAccountIds,
      brokenReconciliation: reconciliation
        .filter((item) => !item.amountReconciled)
        .map((item) => ({ parentId: item.parentId, parentCode: item.parentCode, parentName: item.parentName })),
      scope: {
        versionId: version.id,
        batchId: actual.batchId,
        orgScopeId: input.orgScopeId ?? null,
        accountScopeId: input.accountScopeId ?? null,
        sheetKey: input.sheetKey || 'all',
      },
    }),
    notes,
  };
}

export { RATIO_SCALE };
