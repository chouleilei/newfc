/**
 * 助手异常与质量检查(方案《AI助手完整方案》4.2「异常与质量检查」七类规则)。
 *
 * 全部规则都是后端确定性计算：读取 completionReport / 上一年度实际口径 /
 * 预算质量报告，输出结构化条目。模型只负责解释这些条目，不参与计算。
 *
 * 消费方:助手意图路由(calculate_anomalies 工具)与预警中心独立端点
 * GET /api/analysis/anomalies(普通路由,不在 assistant 限流桶内)。
 * 后续如 assistant 层有变动,可评估将本文件迁到 modules/report/。
 * 金额始终是整数分且按利润方向带符号；数量按 10^4 缩放且不与金额混算。
 */
import type { DB } from '../db/connection';
import * as report from '../modules/report/report.service';
import * as actual from '../modules/actual/actual.service';
import { loadSnapshotNodes } from '../modules/tree/snapshot';
import { budgetQualityReport } from '../modules/check/budget-quality';
import { listRules } from '../modules/calculation/calculation.service';
import { isQuantityType, safeIntegerAdd, signOfType } from '../core/money';

export type AnomalyDimension = 'account' | 'org' | 'total' | 'quality';
export type AnomalySeverity = 'blocking' | 'warning' | 'info';

export interface AnomalyItem {
  code: string;
  severity: AnomalySeverity;
  dimension: AnomalyDimension;
  reasons: string[];
  accountId?: number;
  orgId?: number;
  /** 科目/组织编码,便于前端与模型定位 */
  nodeCode?: string;
  name?: string;
  type?: string;
  cell?: report.CompletionCell;
  /** 规则用到的补充度量(同比增长率、同类中位数、配对科目等) */
  metrics?: Record<string, unknown>;
  basis?: string;
}

export interface AnomalyInput extends report.CompletionInput {
  /** 完成率偏离阈值,默认 0.2 */
  threshold?: number;
  /** 同比增长阈值,默认 0.3 */
  yoyThreshold?: number;
  /** 同类偏离阈值,默认 0.3 */
  peerThreshold?: number;
}

const RATE_EPS = 1e-9;

function num(value: unknown, fallback: number, label: string, min = 0, max = 10): number {
  if (value == null || value === '') return fallback;
  const n = Number(value);
  if (!Number.isFinite(n) || n < min || n > max) throw new Error(`${label}必须在 ${min} 到 ${max} 之间`);
  return n;
}

function median(values: number[]): number | null {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
}

/** 展示口径(无符号业务值):金额按利润方向翻正,数量直接取缩放整数。 */
function displayValue(cell: report.CompletionCell, type: string | undefined, which: 'budget' | 'actual'): number {
  if (isQuantityType(type)) return which === 'budget' ? cell.budgetQuantity : cell.actualQuantity;
  const sign = type ? signOfType(type) : 1;
  return (which === 'budget' ? cell.budgetCents : cell.actualCents) * sign;
}

/** 上一年度实际(按同一套取数规则:已关闭年度取最终快照)按科目编码汇总到范围内组织。 */
function previousYearActual(db: DB, year: number, orgCodesInScope: Set<string> | null, batchId: number | null = null) {
  const source = report.resolveActualSource(db, year - 1, batchId);
  const orgCodeById = new Map(source.orgRows.map((row) => [row.id, row.code]));
  const accById = new Map(source.accRows.map((row) => [row.id, row]));
  const amountByCode = new Map<string, number>();
  const quantityByCode = new Map<string, number>();
  for (const entry of source.entries) {
    const orgCode = orgCodeById.get(entry.orgId);
    if (orgCodesInScope && (!orgCode || !orgCodesInScope.has(orgCode))) continue;
    const acc = accById.get(entry.accountId);
    if (!acc) continue;
    const type = String(acc.type ?? '');
    if (isQuantityType(type)) {
      // 数量同样是缩放整数(1e4)，与紧邻的金额分支同口径用 safeIntegerAdd 兜溢出。
      if (entry.quantity != null) quantityByCode.set(acc.code, safeIntegerAdd(quantityByCode.get(acc.code) ?? 0, entry.quantity, '上年实际数量汇总'));
      continue;
    }
    amountByCode.set(acc.code, safeIntegerAdd(amountByCode.get(acc.code) ?? 0, entry.amountCents, '上年实际汇总'));
  }
  return { year: year - 1, source: source.source, asOfDate: source.asOfDate, batchId: source.batchId, amountByCode, quantityByCode };
}

/**
 * 上一年度**同期**快照:MM-DD 与本年截至日相差不超过 `SAME_PERIOD_TOLERANCE_DAYS` 天的那个。
 *
 * 年中拿本年 8 个月的累计实际去和上年整年实际比，必然得出「同比下降 36%」，
 * 于是几乎每个科目都会命中同比异常——这不是异常，是口径错。
 *
 * 但「最近一个不晚于本年截至日的快照」也不够:本年截至 08-22(234 天)、上年最近快照
 * 06-30(181 天)，两个累计窗口差 53 天，234/181 = 1.29 会给每个科目凭空加上 29% 的
 * 增长。快照是季度粒度时这种错配很常见。而水电这类强季节性业务无法靠日均折算修正
 * (1-8 月和 1-6 月不是同一个汛期)，所以只接受窗口足够接近的时点，否则如实跳过实际侧同比。
 */
const SAME_PERIOD_TOLERANCE_DAYS = 7;

/** MM-DD 折算成非闰年的年内第几天，只用于比较两个日期的窗口长度是否接近。 */
function dayOfYearFromMonthDay(monthDay: string): number | null {
  const match = /^(\d{2})-(\d{2})$/.exec(monthDay);
  if (!match) return null;
  const month = Number(match[1]);
  const day = Number(match[2]);
  if (month < 1 || month > 12 || day < 1 || day > 31) return null;
  const cumulative = [0, 31, 59, 90, 120, 151, 181, 212, 243, 273, 304, 334];
  /* 与 multi-year.ts 同一口径:>2/28 加 1 天闰年补偿,跨年 MM-DD 比较不错位。 */
  const leapCompensation = month > 2 ? 1 : 0;
  return cumulative[month - 1] + day + leapCompensation;
}

function previousYearSamePeriodBatch(db: DB, prevYear: number, asOfDate: string | null): { batchId: number; gapDays: number } | { batchId: null; reason: string } {
  if (!asOfDate || asOfDate.length < 10) return { batchId: null, reason: '本年没有实际截至日期' };
  const currentDay = dayOfYearFromMonthDay(asOfDate.slice(5));
  if (currentDay == null) return { batchId: null, reason: `无法解析截至日期 ${asOfDate}` };
  const batches = (actual.listBatches(db, prevYear) as { id: number; snapshot_date: string; status: string }[])
    .filter((batch) => batch.status === 'active');
  let best: { batchId: number; gapDays: number; date: string } | null = null;
  for (const batch of batches) {
    const day = dayOfYearFromMonthDay(String(batch.snapshot_date).slice(5));
    if (day == null) continue;
    const gapDays = Math.abs(day - currentDay);
    if (!best || gapDays < best.gapDays) best = { batchId: batch.id, gapDays, date: batch.snapshot_date };
  }
  if (!best) return { batchId: null, reason: `${prevYear} 年没有可用快照` };
  if (best.gapDays > SAME_PERIOD_TOLERANCE_DAYS) {
    return {
      batchId: null,
      reason: `${prevYear} 年最接近的快照是 ${best.date}，与本年截至日 ${asOfDate} 相差 ${best.gapDays} 天，`
        + `累计窗口长度不可比(超过 ${SAME_PERIOD_TOLERANCE_DAYS} 天容差)，已跳过实际侧同比`,
    };
  }
  return { batchId: best.batchId, gapDays: best.gapDays };
}

/**
 * 七类检查:
 * 1 ZERO_BUDGET_WITH_ACTUAL 历史有实际但预算为零
 * 2 OPPOSITE_DIRECTION      实际方向与预算相反
 * 3 RATE_DEVIATION          完成率偏离基准(年度未关闭时基准=时间进度,已关闭=1)
 * 4 BUDGET_WITHOUT_ACTUAL   预算有值但长期没有实际
 * 5 YOY_GROWTH_EXCEEDED     同比增长超过阈值(预算比上年整年,实际比上年同期)
 * 6 PEER_DEVIATION          同类组织/科目明显偏离
 * 7 QUANTITY_AMOUNT_MISMATCH 数量变化与金额变化不一致
 * 8 PROFIT_TARGET_MISMATCH   收入/成本/费用与利润目标不匹配
 * 9 预算质量问题(必填科目、测算依据、测算模板)由 budgetQualityReport 提供
 */
export function anomalyReport(db: DB, input: AnomalyInput) {
  const threshold = num(input.threshold, 0.2, 'threshold');
  const yoyThreshold = num(input.yoyThreshold, 0.3, 'yoyThreshold');
  const peerThreshold = num(input.peerThreshold, 0.3, 'peerThreshold');
  const base = report.completionReport(db, {
    versionId: input.versionId,
    batchId: input.batchId ?? null,
    orgScopeId: input.orgScopeId ?? null,
    accountScopeId: input.accountScopeId ?? null,
    sheetKey: input.sheetKey ?? null,
    summaryLevel: null,
  });
  const items: AnomalyItem[] = [];
  const leafAccounts = base.analysisAccounts.filter((row) => row.isLeaf);
  const leafOrgs = base.byOrg.filter((row) => row.isLeaf);
  const orgCodesInScope = new Set(leafOrgs.map((row) => row.code));

  /**
   * 完成率的比较基准。
   *
   * 年度已关闭时全年应当完成 100%，基准就是 1。年度未关闭时拿完成率和 1 比毫无意义:
   * 时间进度 64% 时一个完全按节奏走的科目完成率就是 64%，|0.64-1|=0.36 必然超过 0.2 阈值，
   * 于是「按计划执行」被判成异常，整张异常表被这类假阳性淹没。未关闭年度的基准是时间进度。
   */
  const yearClosed = base.actualSource === 'final';
  const timeProgressValue = typeof base.timeProgressValue === 'number' ? base.timeProgressValue : null;
  const rateBaseline = yearClosed || timeProgressValue == null ? 1 : timeProgressValue;
  const baselineBasis = yearClosed
    ? '年度已关闭，基准为全年完成 100%'
    : timeProgressValue == null
      ? '无法计算时间进度，基准回退为全年完成 100%'
      : `年度未关闭，基准为均匀时间进度 ${(rateBaseline * 100).toFixed(2)}%`;
  const baselineText = `${(rateBaseline * 100).toFixed(2)}%`;

  /**
   * 非累计型数量科目(`quantity_agg != 'sum'`，如电价、税率)是时点值不是累计值，
   * 任何时点的「完成率」都应当接近 100%，拿它跟时间进度比必然误报。
   * report.yearTrend 里已经有同一条规则(非累计型数量指标不能与自然日进度比较)，这里对齐。
   */
  const nonCumulativeQuantityIds = new Set(
    loadSnapshotNodes(db, base.version.account_tree_snapshot_id)
      .filter((node) => String(node.type ?? '') === 'quantity' && String((node as { quantity_agg?: string }).quantity_agg ?? '') !== 'sum')
      .map((node) => node.id),
  );
  /** 单个节点的比较基准:非累计型数量科目恒为 1，其余用上面的年度基准。 */
  const baselineFor = (dimension: 'account' | 'org', nodeId: number): { value: number; text: string; basis: string } =>
    dimension === 'account' && nonCumulativeQuantityIds.has(nodeId)
      ? { value: 1, text: '100.00%', basis: '非累计型数量科目(时点值)，基准为 100%，不与时间进度比较' }
      : { value: rateBaseline, text: baselineText, basis: baselineBasis };

  const pushRateChecks = (
    dimension: 'account' | 'org',
    node: { id: number; code: string; name: string; type: string; cell: report.CompletionCell },
  ) => {
    const cell = node.cell;
    const hasActual = cell.actualCents !== 0 || cell.actualQuantity !== 0;
    const budgetDisplay = displayValue(cell, node.type, 'budget');
    const base_: Omit<AnomalyItem, 'code' | 'severity' | 'reasons'> = {
      dimension,
      ...(dimension === 'account' ? { accountId: node.id } : { orgId: node.id }),
      nodeCode: node.code,
      name: node.name,
      type: node.type,
      cell,
    };
    if (cell.rateSpecial === 'na_zero_budget' && hasActual) {
      items.push({ code: 'ZERO_BUDGET_WITH_ACTUAL', severity: 'warning', reasons: ['预算为零但存在实际'], ...base_ });
    }
    if (cell.rateSpecial === 'opposite_direction') {
      items.push({ code: 'OPPOSITE_DIRECTION', severity: 'warning', reasons: ['实际方向与预算相反'], ...base_ });
    }
    if (cell.rate != null) {
      const baseline = baselineFor(dimension, node.id);
      if (Math.abs(cell.rate - baseline.value) > threshold) {
        items.push({
          code: 'RATE_DEVIATION', severity: 'warning',
          reasons: [`完成率 ${(cell.rate * 100).toFixed(2)}% 偏离基准 ${baseline.text} 超过 ${(threshold * 100).toFixed(2)}% 阈值`],
          metrics: { rate: cell.rate, baseline: baseline.value, deviation: cell.rate - baseline.value, threshold, yearClosed },
          basis: baseline.basis,
          ...base_,
        });
      }
    }
    if (budgetDisplay > 0 && !hasActual) {
      items.push({
        code: 'BUDGET_WITHOUT_ACTUAL', severity: 'warning',
        reasons: [`预算有值但截至 ${base.asOfDate || '当前可用口径'} 没有任何实际发生`],
        metrics: { budgetDisplay, asOfDate: base.asOfDate },
        ...base_,
      });
    }
  };

  for (const row of leafAccounts) pushRateChecks('account', { id: row.accountId, code: row.code, name: row.name, type: row.type, cell: row.cell });
  for (const row of leafOrgs) pushRateChecks('org', { id: row.orgId, code: row.code, name: row.name, type: 'net', cell: row.cell });

  // 5 同比增长超过阈值:预算 vs 上一年度整年实际、实际 vs 上一年度**同期**实际
  const previous = previousYearActual(db, base.version.year, orgCodesInScope);
  const samePeriod = yearClosed
    ? { batchId: null as number | null, reason: '年度已关闭，实际即全年口径，直接与上年整年比较' }
    : previousYearSamePeriodBatch(db, base.version.year - 1, base.asOfDate);
  const previousSamePeriod = yearClosed
    ? previous
    : samePeriod.batchId == null
      ? null
      : previousYearActual(db, base.version.year, orgCodesInScope, samePeriod.batchId);
  const samePeriodSkipReason = previousSamePeriod ? null : (samePeriod as { reason: string }).reason;
  const yoyBasisNote = `${previous.year} 年整年实际(${previous.source === 'final' ? '年度关闭最终快照' : previous.source === 'none' ? '无数据' : '当前累计'})`;
  const yoySamePeriodNote = previousSamePeriod
    ? `${previousSamePeriod.year} 年${yearClosed ? '整年' : '同期'}实际(截至 ${previousSamePeriod.asOfDate || '未知'})`
    : null;
  for (const row of leafAccounts) {
    const quantity = isQuantityType(row.type);
    const compare = (which: 'budget' | 'actual') => {
      // 预算是全年口径，跟上年整年比；实际是累计口径，只能跟上年同期比。
      const reference = which === 'budget' ? previous : previousSamePeriod;
      if (!reference) return; // 找不到上年同期时点：如实跳过，不拿不可比的数硬算
      const prev = quantity ? reference.quantityByCode.get(row.code) : reference.amountByCode.get(row.code);
      if (prev == null || prev === 0) return;
      const prevDisplay = quantity ? prev : prev * signOfType(row.type);
      if (prevDisplay === 0) return;
      const current = displayValue(row.cell, row.type, which);
      if (which === 'actual' && current === 0) return; // 无实际由 BUDGET_WITHOUT_ACTUAL 覆盖
      const growth = (current - prevDisplay) / Math.abs(prevDisplay);
      if (Math.abs(growth) <= yoyThreshold) return;
      const referenceNote = which === 'budget' ? yoyBasisNote : yoySamePeriodNote!;
      items.push({
        code: 'YOY_GROWTH_EXCEEDED', severity: 'warning', dimension: 'account',
        accountId: row.accountId, nodeCode: row.code, name: row.name, type: row.type, cell: row.cell,
        reasons: [`${which === 'budget' ? '预算' : '实际'}较${which === 'budget' ? '上年整年' : '上年同期'}${growth > 0 ? '增长' : '下降'} ${(Math.abs(growth) * 100).toFixed(2)}%，超过 ${(yoyThreshold * 100).toFixed(2)}% 阈值`],
        metrics: { growth, threshold: yoyThreshold, previousDisplay: prevDisplay, currentDisplay: current, previousYear: reference.year, previousAsOfDate: reference.asOfDate, comparison: which === 'budget' ? 'full_year' : 'same_period' },
        basis: `${which === 'budget' ? '预算' : '实际'} vs ${referenceNote}`,
      });
    };
    compare('budget');
    compare('actual');
  }

  // 6 同类偏离:同一父节点下的兄弟科目/兄弟组织完成率与中位数比较
  const peerCheck = (
    groups: Map<number | null, { id: number; code: string; name: string; type: string; rate: number; cell: report.CompletionCell }[]>,
    dimension: 'account' | 'org',
  ) => {
    for (const [parentId, siblings] of groups) {
      if (siblings.length < 3) continue; // 少于 3 个兄弟节点没有统计意义
      const mid = median(siblings.map((s) => s.rate));
      if (mid == null || Math.abs(mid) < RATE_EPS) continue;
      for (const sibling of siblings) {
        const deviation = (sibling.rate - mid) / Math.abs(mid);
        if (Math.abs(deviation) <= peerThreshold) continue;
        items.push({
          code: 'PEER_DEVIATION', severity: 'info', dimension,
          ...(dimension === 'account' ? { accountId: sibling.id } : { orgId: sibling.id }),
          nodeCode: sibling.code, name: sibling.name, type: sibling.type, cell: sibling.cell,
          reasons: [`完成率 ${(sibling.rate * 100).toFixed(2)}% 与同类中位数 ${(mid * 100).toFixed(2)}% 偏离 ${(Math.abs(deviation) * 100).toFixed(2)}%`],
          metrics: { rate: sibling.rate, peerMedian: mid, deviation, peerCount: siblings.length, parentId },
          basis: dimension === 'account' ? '同一父科目下的兄弟叶子科目' : '同一父组织下的兄弟组织净额',
        });
      }
    }
  };
  const accountGroups = new Map<number | null, { id: number; code: string; name: string; type: string; rate: number; cell: report.CompletionCell }[]>();
  for (const row of leafAccounts) {
    if (row.cell.rate == null) continue;
    const list = accountGroups.get(row.parentId) ?? [];
    list.push({ id: row.accountId, code: row.code, name: row.name, type: row.type, rate: row.cell.rate, cell: row.cell });
    accountGroups.set(row.parentId, list);
  }
  const orgGroups = new Map<number | null, { id: number; code: string; name: string; type: string; rate: number; cell: report.CompletionCell }[]>();
  for (const row of base.byOrg) {
    if (row.cell.rate == null) continue;
    const list = orgGroups.get(row.parentId) ?? [];
    list.push({ id: row.orgId, code: row.code, name: row.name, type: 'net', rate: row.cell.rate, cell: row.cell });
    orgGroups.set(row.parentId, list);
  }
  peerCheck(accountGroups, 'account');
  peerCheck(orgGroups, 'org');

  // 7 数量变化与金额变化不一致
  const accountByCode = new Map(leafAccounts.map((row) => [row.code, row]));
  const quantityAccounts = leafAccounts.filter((row) => isQuantityType(row.type) && row.cell.rate != null);
  const pairedQuantityCodes = new Set<string>();
  for (const rule of listRules(db)) {
    let config: Record<string, string>;
    try { config = JSON.parse(rule.config_json) as Record<string, string>; } catch { continue; }
    const quantityRow = config.quantityAccountCode ? accountByCode.get(config.quantityAccountCode) : undefined;
    const outputRow = config.outputAccountCode ? accountByCode.get(config.outputAccountCode) : undefined;
    if (!quantityRow || !outputRow) continue;
    if (quantityRow.cell.rate == null || outputRow.cell.rate == null) continue;
    pairedQuantityCodes.add(quantityRow.code);
    // 配对的数量科目也可能是非累计型(电价×电量→收入),各自按自己的基准算偏离
    const quantityDelta = quantityRow.cell.rate - baselineFor('account', quantityRow.accountId).value;
    const amountDelta = outputRow.cell.rate - baselineFor('account', outputRow.accountId).value;
    if (Math.abs(quantityDelta) <= threshold && Math.abs(amountDelta) <= threshold) continue;
    if (quantityDelta * amountDelta >= 0) continue;
    items.push({
      code: 'QUANTITY_AMOUNT_MISMATCH', severity: 'warning', dimension: 'account',
      accountId: outputRow.accountId, nodeCode: outputRow.code, name: outputRow.name, type: outputRow.type, cell: outputRow.cell,
      reasons: [`数量科目 ${quantityRow.code} ${quantityRow.name} 完成率 ${(quantityRow.cell.rate * 100).toFixed(2)}%，金额科目 ${outputRow.code} 完成率 ${(outputRow.cell.rate * 100).toFixed(2)}%，变化方向不一致`],
      metrics: { rule: rule.name, quantityAccountId: quantityRow.accountId, quantityRate: quantityRow.cell.rate, amountRate: outputRow.cell.rate, threshold },
      basis: `测算模板「${rule.name}」配置的数量-金额配对`,
    });
  }
  const incomeTotalCells = leafAccounts.filter((row) => row.type === 'income');
  const incomeBudget = incomeTotalCells.reduce((sum, row) => safeIntegerAdd(sum, row.cell.budgetCents, '收入预算汇总'), 0);
  const incomeActual = incomeTotalCells.reduce((sum, row) => safeIntegerAdd(sum, row.cell.actualCents, '收入实际汇总'), 0);
  const incomeRate = incomeBudget !== 0 ? incomeActual / incomeBudget : null;
  if (incomeRate != null) {
    for (const row of quantityAccounts) {
      if (pairedQuantityCodes.has(row.code)) continue; // 已由测算模板配对覆盖
      if (nonCumulativeQuantityIds.has(row.accountId)) continue; // 时点值(电价/税率)与累计收入不可比
      const quantityDelta = row.cell.rate! - rateBaseline;
      const amountDelta = incomeRate - rateBaseline;
      if (Math.abs(quantityDelta) <= threshold || Math.abs(amountDelta) <= threshold) continue;
      if (quantityDelta * amountDelta >= 0) continue;
      items.push({
        code: 'QUANTITY_AMOUNT_MISMATCH', severity: 'info', dimension: 'account',
        accountId: row.accountId, nodeCode: row.code, name: row.name, type: row.type, cell: row.cell,
        reasons: [`数量完成率 ${(row.cell.rate! * 100).toFixed(2)}% 与范围内收入完成率 ${(incomeRate * 100).toFixed(2)}% 变化方向不一致`],
        metrics: { quantityRate: row.cell.rate, incomeRate, threshold },
        basis: '数量科目完成率 vs 范围内收入总额完成率(未配置测算模板配对时的兜底比较)',
      });
    }
  }

  // 8 收入、成本、费用与利润目标不匹配
  const totalsOf = (which: 'budget' | 'actual') => {
    const totals = { income: 0, cost: 0, expense: 0 };
    for (const row of leafAccounts) {
      if (row.type !== 'income' && row.type !== 'cost' && row.type !== 'expense') continue;
      const value = which === 'budget' ? row.cell.budgetCents : row.cell.actualCents;
      totals[row.type] = safeIntegerAdd(totals[row.type], value, '利润口径汇总');
    }
    return totals;
  };
  const budgetTotals = totalsOf('budget');
  const actualTotals = totalsOf('actual');
  const profitOf = (t: { income: number; cost: number; expense: number }) => safeIntegerAdd(safeIntegerAdd(t.income, t.cost, '利润汇总'), t.expense, '利润汇总');
  const profitBudget = profitOf(budgetTotals);
  const profitActual = profitOf(actualTotals);
  const profitMetric = base.metrics.find((m) => /利润|profit/i.test(`${m.code} ${m.name}`)) || null;
  const profitReasons: string[] = [];
  if (profitBudget <= 0) profitReasons.push(`预算利润为 ${profitBudget} 分(非正数)，收入与成本费用目标不匹配`);
  const prevIncome = [...previous.amountByCode.entries()].reduce((sum, [code, cents]) => {
    const row = accountByCode.get(code);
    return row?.type === 'income' ? safeIntegerAdd(sum, cents, '上年收入汇总') : sum;
  }, 0);
  const prevCostExpense = [...previous.amountByCode.entries()].reduce((sum, [code, cents]) => {
    const row = accountByCode.get(code);
    return row?.type === 'cost' || row?.type === 'expense' ? safeIntegerAdd(sum, cents, '上年成本费用汇总') : sum;
  }, 0);
  let incomeGrowth: number | null = null;
  let costExpenseGrowth: number | null = null;
  if (prevIncome !== 0 && prevCostExpense !== 0) {
    incomeGrowth = (budgetTotals.income - prevIncome) / Math.abs(prevIncome);
    const budgetCostExpense = safeIntegerAdd(budgetTotals.cost, budgetTotals.expense, '预算成本费用汇总');
    costExpenseGrowth = (Math.abs(budgetCostExpense) - Math.abs(prevCostExpense)) / Math.abs(prevCostExpense);
    if (costExpenseGrowth - incomeGrowth > threshold) {
      profitReasons.push(`预算成本费用增长 ${(costExpenseGrowth * 100).toFixed(2)}% 快于收入增长 ${(incomeGrowth * 100).toFixed(2)}%，超过 ${(threshold * 100).toFixed(2)}% 阈值`);
    }
  }
  if (profitBudget !== 0 && profitActual !== 0) {
    const profitRate = profitActual / profitBudget;
    if (profitBudget > 0 && Math.abs(profitRate - rateBaseline) > threshold) {
      profitReasons.push(`实际利润完成率 ${(profitRate * 100).toFixed(2)}% 偏离基准 ${baselineText} 超过 ${(threshold * 100).toFixed(2)}% 阈值`);
    }
  }
  if (profitReasons.length) {
    items.push({
      code: 'PROFIT_TARGET_MISMATCH', severity: 'warning', dimension: 'total',
      name: '收入/成本/费用与利润目标', type: 'net', reasons: profitReasons,
      metrics: {
        budgetTotals, actualTotals, profitBudget, profitActual,
        incomeBudgetGrowthVsPrevActual: incomeGrowth, costExpenseBudgetGrowthVsPrevActual: costExpenseGrowth,
        profitMetric: profitMetric ? { code: profitMetric.code, name: profitMetric.name, cell: profitMetric.cell } : null,
        threshold,
      },
      basis: `范围内叶子科目按类型汇总(利润=收入+成本+费用,带符号);同比基准为${yoyBasisNote}`,
    });
  }

  // 9 必填科目 / 测算依据 / 测算模板缺失
  const quality = budgetQualityReport(db, input.versionId);
  for (const issue of quality.issues) {
    items.push({
      code: issue.code, severity: issue.severity, dimension: 'quality',
      reasons: [issue.message], accountId: issue.accountId, orgId: issue.orgId,
      metrics: issue.ruleId == null ? undefined : { ruleId: issue.ruleId },
      basis: '预算质量报告(必填科目、测算依据、测算模板)',
    });
  }

  const countsByCode: Record<string, number> = {};
  for (const item of items) countsByCode[item.code] = (countsByCode[item.code] ?? 0) + 1;
  return {
    ...base,
    threshold,
    yoyThreshold,
    peerThreshold,
    /** 完成率比较基准:年度未关闭时是时间进度,已关闭时是 1(全年完成) */
    rateBaseline,
    rateBaselineBasis: baselineBasis,
    yearClosed,
    previousYear: { year: previous.year, source: previous.source, asOfDate: previous.asOfDate, batchId: previous.batchId },
    /** 实际侧同比用的上年同期口径;为 null 表示找不到窗口可比的时点,已如实跳过实际侧同比 */
    previousSamePeriod: previousSamePeriod
      ? { year: previousSamePeriod.year, source: previousSamePeriod.source, asOfDate: previousSamePeriod.asOfDate, batchId: previousSamePeriod.batchId }
      : null,
    /** previousSamePeriod 为 null 时说明为什么不可比 */
    previousSamePeriodSkipReason: samePeriodSkipReason,
    quality: { canFinalize: quality.canFinalize, blockingCount: quality.blockingCount, warningCount: quality.warningCount, coverage: quality.coverage },
    anomalies: items,
    anomalyCount: items.length,
    countsByCode,
    checks: [
      { code: 'ZERO_BUDGET_WITH_ACTUAL', label: '历史有实际但预算为零' },
      { code: 'OPPOSITE_DIRECTION', label: '实际方向与预算相反' },
      { code: 'RATE_DEVIATION', label: `完成率偏离基准阈值(基准 ${baselineText})` },
      { code: 'BUDGET_WITHOUT_ACTUAL', label: '预算有值但长期没有实际' },
      { code: 'YOY_GROWTH_EXCEEDED', label: '同比增长超过阈值(预算比整年、实际比同期)' },
      { code: 'PEER_DEVIATION', label: '同类组织或科目明显偏离' },
      { code: 'QUANTITY_AMOUNT_MISMATCH', label: '数量变化与金额变化不一致' },
      { code: 'PROFIT_TARGET_MISMATCH', label: '收入、成本、费用与利润目标不匹配' },
      { code: 'REQUIRED_VALUE_MISSING', label: '必填科目缺失' },
      { code: 'BASIS_MISSING', label: '测算依据缺失' },
      { code: 'CALCULATION_OUTPUT_MISSING', label: '测算模板未试算' },
    ],
  };
}
