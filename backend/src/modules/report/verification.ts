/**
 * 核验事实(方案《小澧助手全页面回答范围自动对齐开发计划》§9.5)。
 *
 * 执行分析、结构分析和指标穿透的领域响应统一携带 verificationFacts；
 * 页面 VerifyBar、小澧助手和导出共用同一份结论——overspend、lagging、subtotal、
 * reconciliation 等分类只在后端这里实现一份，页面不再各自判定，
 * 助手收到 verification fact 时也由本模块重新取得(客户端的 label/details/level 全部忽略)。
 */
import { centsToWanText } from '../../core/money';
import type { ActualReconciliation, CompletionCell, UnbudgetedActual } from './report.service';

/** 核验级别：ok 仅徽标 / warn 徽标带橙 / bad 升格为 Alert(与前端 VerifyBar 三档一致)。 */
export type VerificationLevel = 'ok' | 'warn' | 'bad';

/** 每项核验事实(§9.5)：factKey + serverLevel + scope + facts + citations + actionTarget。 */
export interface VerificationFactItem {
  /** 稳定键：reconciliation、overspend、lagging、subtotal、unbudgeted、actual_none、coverage、coverage_unbudgeted */
  factKey: string;
  serverLevel: VerificationLevel;
  /** 本项结论实际采用的取数范围。 */
  scope: {
    versionId: number | null;
    batchId: number | null;
    orgScopeId: number | null;
    accountScopeId: number | null;
    sheetKey: string | null;
  };
  /** 徽标文案(服务端口径，页面直接渲染)。 */
  label: string;
  /** 收进 Popover 的明细行。 */
  details: string[];
  /** 结构化数字(分/计数/阈值)，供助手与导出直接引用。 */
  facts: Record<string, number | string | null>;
  /** 跳转目标说明；目前只有页内锚点一种。 */
  actionTarget: { kind: 'anchor'; anchor: string; hint: string } | null;
}

export interface VerificationScopeRef {
  versionId: number | null;
  batchId: number | null;
  orgScopeId: number | null;
  accountScopeId: number | null;
  sheetKey: string | null;
}

/** 勾稽明细：差额为 0 时两侧金额必然相等，只显示一次(与前端 reconciliationDetails 同口径)。 */
export function reconciliationDetailLines(figures: ActualReconciliation): string[] {
  const { sourceActualCents, displayedActualCents, differenceCents } = figures;
  if (differenceCents === 0) {
    return [`来源实际净额 ${centsToWanText(sourceActualCents)} 万元`, `承接合计 ${centsToWanText(displayedActualCents)} 万元`];
  }
  return [
    `来源实际净额 ${centsToWanText(sourceActualCents)} 万元`,
    `预算叶子投影与未预算承接区合计 ${centsToWanText(displayedActualCents)} 万元`,
    `差额 ${centsToWanText(differenceCents)} 万元`,
  ];
}

/**
 * 执行节奏分类(收入与成本费用的「不利」方向相反)。
 * 原先在 frontend/src/pages/Analysis.tsx classifyPace 各算一份；现统一收进后端。
 */
export function classifyPace(type: string, cell: CompletionCell, threshold: number): 'overspend' | 'lagging' | 'healthy' {
  const businessBudget = type === 'income' ? cell.budgetCents : -cell.budgetCents;
  const businessActual = type === 'income' ? cell.actualCents : -cell.actualCents;
  const annualOverspend = (type === 'cost' || type === 'expense') && businessBudget > 0 && businessActual > businessBudget;
  if (annualOverspend) return 'overspend';
  const deviation = cell.progressDeviation ?? 0;
  const paceBad = type === 'income' ? deviation < -threshold : deviation > threshold;
  return paceBad ? 'lagging' : 'healthy';
}

export interface AnalysisAlertInput {
  accountId: number;
  type: string;
  isLeaf: boolean;
  cell: CompletionCell;
}

/** 超支/节奏偏离统计：analysisAccounts(完整计算范围)+ 预警阈值。 */
export function analyzeAlerts(
  rows: AnalysisAlertInput[],
  threshold: number,
  options: { actualSource: string; timeProgressValue: number | null },
): { overspendCount: number; laggingCount: number; overspendMaxVarianceCents: number; laggingMaxDeviation: number } {
  const empty = { overspendCount: 0, laggingCount: 0, overspendMaxVarianceCents: 0, laggingMaxDeviation: 0 };
  if (options.timeProgressValue == null || options.actualSource === 'none') return empty;
  let overspendCount = 0;
  let laggingCount = 0;
  let overspendMaxVarianceCents = 0;
  let laggingMaxDeviation = 0;
  for (const row of rows) {
    if (!row.isLeaf || row.type === 'quantity' || row.cell.rate == null) continue;
    const category = classifyPace(row.type, row.cell, threshold);
    if (category === 'overspend') {
      overspendCount += 1;
      overspendMaxVarianceCents = Math.max(overspendMaxVarianceCents, Math.abs(row.cell.varianceCents));
    } else if (category === 'lagging') {
      laggingCount += 1;
      laggingMaxDeviation = Math.max(laggingMaxDeviation, Math.abs(row.cell.progressDeviation ?? 0));
    }
  }
  return { overspendCount, laggingCount, overspendMaxVarianceCents, laggingMaxDeviation };
}

/**
 * 执行分析的核验事实(ownerKey = analysis:root)。
 * actual_none 独占：年度无实际数据时其余预警没有意义。
 */
export function completionVerificationFacts(input: {
  actualSource: 'current' | 'snapshot' | 'final' | 'none';
  reconciliation: ActualReconciliation;
  unbudgetedActual: UnbudgetedActual;
  analysisAccounts: AnalysisAlertInput[];
  timeProgressValue: number | null;
  warningThreshold: number;
  scope: VerificationScopeRef;
}): VerificationFactItem[] {
  const { scope } = input;
  const items: VerificationFactItem[] = [];
  if (input.actualSource === 'none') {
    items.push({
      factKey: 'actual_none',
      serverLevel: 'warn',
      scope,
      label: '年度无实际数据，不生成执行预警',
      details: [],
      facts: { actualSource: 'none' },
      actionTarget: null,
    });
    return items;
  }
  const balanced = input.reconciliation.differenceCents === 0;
  items.push({
    factKey: 'reconciliation',
    serverLevel: balanced ? 'ok' : 'bad',
    scope,
    label: balanced ? '实际数已逐分勾稽' : '实际数承接对账不平',
    details: reconciliationDetailLines(input.reconciliation),
    facts: {
      sourceActualCents: input.reconciliation.sourceActualCents,
      displayedActualCents: input.reconciliation.displayedActualCents,
      differenceCents: input.reconciliation.differenceCents,
    },
    actionTarget: null,
  });
  if (input.unbudgetedActual.count > 0) {
    items.push({
      factKey: 'unbudgeted',
      serverLevel: 'warn',
      scope,
      label: `${input.unbudgetedActual.count} 条新增实际由承接区兜底`,
      details: [`承接净额 ${centsToWanText(input.unbudgetedActual.amountCents)} 万元`, '原始组织×科目组合已保留，未丢弃'],
      facts: { count: input.unbudgetedActual.count, amountCents: input.unbudgetedActual.amountCents },
      actionTarget: null,
    });
  }
  const alerts = analyzeAlerts(input.analysisAccounts, input.warningThreshold, {
    actualSource: input.actualSource,
    timeProgressValue: input.timeProgressValue,
  });
  if (alerts.overspendCount > 0) {
    items.push({
      factKey: 'overspend',
      serverLevel: 'warn',
      scope,
      label: `${alerts.overspendCount} 个成本费用科目累计实际超全年预算`,
      details: ['点击查看下方「成本费用超支预警」明细'],
      facts: { count: alerts.overspendCount, maxVarianceCents: alerts.overspendMaxVarianceCents, threshold: input.warningThreshold },
      actionTarget: { kind: 'anchor', anchor: 'overspend-alerts', hint: '跳转到成本费用超支预警' },
    });
  }
  if (alerts.laggingCount > 0) {
    items.push({
      factKey: 'lagging',
      serverLevel: 'warn',
      scope,
      label: `${alerts.laggingCount} 个科目节奏偏离 ≥ ${(input.warningThreshold * 100).toFixed(0)}pp`,
      details: ['点击查看下方「执行节奏显著偏离」明细'],
      facts: { count: alerts.laggingCount, maxProgressDeviation: alerts.laggingMaxDeviation, threshold: input.warningThreshold },
      actionTarget: { kind: 'anchor', anchor: 'overspend-alerts', hint: '跳转到执行节奏显著偏离' },
    });
  }
  return items;
}

/**
 * 结构分析的核验事实(ownerKey = structure:root)。
 * 守恒不平且存在承接区时是「可解释的正常态」(warn)，没有承接区却不平才是真正的结构异常(bad)。
 */
export function structureVerificationFacts(input: {
  actualSource: 'current' | 'snapshot' | 'final' | 'none';
  reconciliation: ActualReconciliation;
  unbudgetedActual: UnbudgetedActual;
  /** 未预算实际投影到的预算祖先科目:断链上级只有在它(或其祖先)承接了未预算实际时,
   *  「子项之和≠上级」才是可解释的正常态;其余断链仍然说明汇总链路有 bug。 */
  unbudgetedAccountIds?: Set<number>;
  brokenReconciliation: { parentId: number; parentCode: string; parentName: string }[];
  scope: VerificationScopeRef;
}): VerificationFactItem[] {
  const { scope } = input;
  const items: VerificationFactItem[] = [];
  const balanced = input.reconciliation.differenceCents === 0;
  items.push({
    factKey: 'reconciliation',
    serverLevel: balanced ? 'ok' : 'bad',
    scope,
    label: balanced ? '实际数已逐分勾稽' : '实际数承接对账不平',
    details: reconciliationDetailLines(input.reconciliation),
    facts: {
      sourceActualCents: input.reconciliation.sourceActualCents,
      displayedActualCents: input.reconciliation.displayedActualCents,
      differenceCents: input.reconciliation.differenceCents,
    },
    actionTarget: null,
  });
  if (input.brokenReconciliation.length > 0) {
    const parents = input.brokenReconciliation.map((item) => `${item.parentCode} ${item.parentName}`).join('、');
    // 逐上级判定,而不是全局启发式:任何一处存在未预算实际就把全部断链降级为 warn,
    // 会让「真 bug 断链」混在「承接区兜底」里漏报。
    const carried = input.brokenReconciliation.filter((item) => input.unbudgetedAccountIds?.has(item.parentId));
    const unexplained = input.brokenReconciliation.filter((item) => !input.unbudgetedAccountIds?.has(item.parentId));
    const allExplainedByCarry = unexplained.length === 0;
    const carriedParents = carried.map((item) => `${item.parentCode} ${item.parentName}`).join('、');
    const unexplainedParents = unexplained.map((item) => `${item.parentCode} ${item.parentName}`).join('、');
    items.push({
      factKey: 'subtotal',
      // 聚合核验只要还有一处未被承接区解释的断链就必须保持 bad；不能因另一处可解释
      // 的新增分支而把真实结构缺陷整体降级为 warn。
      serverLevel: allExplainedByCarry ? 'warn' : 'bad',
      scope,
      label: allExplainedByCarry
        ? `${carried.length} 个上级含新增分支，子项之和不等于上级`
        : `${unexplained.length} 个上级存在未解释断链${carried.length ? `，另有 ${carried.length} 个由新增分支解释` : ''}`,
      details: allExplainedByCarry
        ? [`涉及上级科目：${carriedParents || parents}。上级实际包含没有预算叶子对应项的新增分支，原始组合已在下方“未预算实际承接区”列明。`]
        : [
          `未解释的上级科目：${unexplainedParents}。这不应发生，请在「数据管理 → 一致性检查」中核查后再使用本表。`,
          ...(carried.length ? [`可由新增分支解释的上级科目：${carriedParents}。原始组合已在下方“未预算实际承接区”列明。`] : []),
        ],
      facts: {
        brokenCount: input.brokenReconciliation.length,
        carriedCount: carried.length,
        unexplainedCount: unexplained.length,
        parentIds: input.brokenReconciliation.map((item) => item.parentId).join(','),
      },
      actionTarget: null,
    });
  }
  if (input.unbudgetedActual.count > 0) {
    items.push({
      factKey: 'unbudgeted',
      serverLevel: 'warn',
      scope,
      label: `${input.unbudgetedActual.count} 条新增实际由承接区兜底`,
      details: ['原始组织×科目组合已保留，未丢弃'],
      facts: { count: input.unbudgetedActual.count, amountCents: input.unbudgetedActual.amountCents },
      actionTarget: null,
    });
  }
  if (input.actualSource === 'none') {
    items.push({
      factKey: 'actual_none',
      serverLevel: 'warn',
      scope,
      label: '年度无实际数据，占比与结构差异为 N/A',
      details: [],
      facts: { actualSource: 'none' },
      actionTarget: null,
    });
  }
  return items;
}

/** 指标穿透的核验事实(ownerKey = evidence:metric:版本ID:指标ID)。 */
export function evidenceVerificationFacts(input: {
  versionId: number;
  metricId: number;
  batchId: number | null;
  orgScopeId: number | null;
  accountScopeId: number | null;
  sheetKey: string | null;
  unbudgetedActual: UnbudgetedActual;
  reconciliation: ActualReconciliation;
}): VerificationFactItem[] {
  const scope: VerificationScopeRef = {
    versionId: input.versionId,
    batchId: input.batchId,
    orgScopeId: input.orgScopeId,
    accountScopeId: input.accountScopeId,
    sheetKey: input.sheetKey,
  };
  const balanced = input.reconciliation.differenceCents === 0;
  const items: VerificationFactItem[] = [{
    factKey: 'coverage',
    serverLevel: balanced ? 'ok' : 'bad',
    scope,
    label: balanced ? '指标范围内实际来源逐分勾稽' : '指标范围内实际来源承接对账不平',
    details: reconciliationDetailLines(input.reconciliation),
    facts: {
      sourceActualCents: input.reconciliation.sourceActualCents,
      displayedActualCents: input.reconciliation.displayedActualCents,
      differenceCents: input.reconciliation.differenceCents,
    },
    actionTarget: null,
  }];
  if (input.unbudgetedActual.count > 0) {
    items.push({
      factKey: 'coverage_unbudgeted',
      serverLevel: 'warn',
      scope,
      label: `${input.unbudgetedActual.count} 条新增结构实际由承接区兜底`,
      details: ['来源总额仍逐分勾稽，未丢弃'],
      facts: { count: input.unbudgetedActual.count, amountCents: input.unbudgetedActual.amountCents },
      actionTarget: null,
    });
  }
  return items;
}
