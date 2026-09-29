/**
 * 报告生成(方案《AI助手完整方案》4.3「报告生成:执行月报、年度复盘、预算讨论材料」)。
 *
 * 严格遵循「后端先算事实,AI 后写说明」:本模块只做确定性组稿——所有数字来自
 * completionReport / attributionReport / anomalyReport / accuracyReport /
 * historicalComparison / versionCompare,并逐节附结构化引用。模板叙述本身即可
 * 独立使用;模型可用时由 service 在此基础上改写文字,数字与引用不变。
 *
 * 金额:整数分,按利润方向带符号;叙述中的金额按万元两位小数确定性格式化。
 * 数量:10^4 缩放整数,不与金额混算,单独成节。
 */
import type { DB } from '../db/connection';
import * as report from '../modules/report/report.service';
import { budgetQualityReport } from '../modules/check/budget-quality';
import { Errors } from '../core/errors';
import { safeIntegerAdd, centsToWanText } from '../core/money';

export { centsToWanText };
import * as budget from '../modules/budget/budget.service';
import { attributionReport, type AttributionLeaf } from './attribution';
import { anomalyReport } from './anomaly';
import { multiYearTrend, type MultiYearTrendResult } from '../modules/report/multi-year';
import { citationsForFacts, type FactRecord, type FactSource } from './citations';
import type { AssistantCitation } from './schemas';

export type ReportKind = 'monthly_execution' | 'annual_review' | 'budget_discussion';

export interface ReportDraftInput {
  kind: ReportKind | string;
  /** 执行月报 / 预算讨论材料必填 */
  versionId?: number | null;
  /** 年度复盘必填;其余情况缺省取版本年度 */
  year?: number | null;
  /** 实际快照;缺省按现有取数口径(未关闭年度取当前累计) */
  batchId?: number | null;
  orgScopeId?: number | null;
  accountScopeId?: number | null;
  sheetKey?: string | null;
  /** 预算讨论材料的对比版本(同年度) */
  targetVersionId?: number | null;
  /** 归因每层条目数,默认 5 */
  topN?: number | null;
}

export interface ReportSection {
  key: string;
  title: string;
  /** 确定性要点,每条都可在 data 与 citations 中溯源 */
  bullets: string[];
  /** 结构化数据,供前端表格化展示 */
  data?: unknown;
  citations: AssistantCitation[];
}

export interface ReportDraft {
  kind: ReportKind;
  kindLabel: string;
  title: string;
  generatedAt: string;
  period: { year: number | null; asOfDate: string | null; timeProgressValue: number | null };
  scope: {
    versionId: number | null;
    versionName: string | null;
    versionStatus: string | null;
    targetVersionId: number | null;
    actualSource: string | null;
    actualBatchId: number | null;
    orgScopeId: number | null;
    accountScopeId: number | null;
    sheetKey: string | null;
    treeSnapshotIds: { org: number | null; account: number | null };
  };
  sections: ReportSection[];
  /** 供模型与前端使用的结构化事实(与 sections 同源) */
  facts: FactRecord[];
  citations: AssistantCitation[];
  /** 确定性模板叙述;模型可用时由 service 改写,数字不变 */
  narrative: string;
  narrativeSource: 'template' | 'model';
  /**
   * 需要逐字保留的事实词条(组织/科目/版本/快照名称等中文专名),供叙述守卫使用。
   * 事实 token 正则只认数字与字母编码,中文专名必须显式声明,否则模型可以把
   * 「上海公司」改写成「杭州公司」而守卫仍然通过。只保留确实出现在 narrative 中的词条。
   */
  factTerms: string[];
  /** AI 建议,展示时必须标记为建议 */
  suggestions: string[];
  notes: string[];
}

const KIND_LABEL: Record<ReportKind, string> = {
  monthly_execution: '预算执行月报',
  annual_review: '年度复盘',
  budget_discussion: '预算讨论材料',
};

export function normalizeReportKind(value: unknown): ReportKind {
  const raw = String(value ?? '').trim().toLowerCase().replace(/-/g, '_');
  const alias: Record<string, ReportKind> = {
    monthly: 'monthly_execution',
    monthly_execution: 'monthly_execution',
    execution_monthly: 'monthly_execution',
    月报: 'monthly_execution',
    annual: 'annual_review',
    annual_review: 'annual_review',
    review: 'annual_review',
    年度复盘: 'annual_review',
    discussion: 'budget_discussion',
    budget_discussion: 'budget_discussion',
    讨论材料: 'budget_discussion',
  };
  const kind = alias[raw];
  if (!kind) throw Errors.validation('报告类型必须是 monthly_execution、annual_review 或 budget_discussion');
  return kind;
}

/** 分 → 万元文本:实现已上移到 core/money.ts,此处再导出保持既有引用不变。 */

/** 10^4 缩放整数 → 四位小数文本 */
function quantityText(scaled: number): string {
  const negative = scaled < 0;
  const abs = Math.abs(Math.trunc(scaled));
  return `${negative && abs !== 0 ? '-' : ''}${Math.floor(abs / 10_000)}.${String(abs % 10_000).padStart(4, '0')}`;
}

function percentText(value: number | null | undefined, digits = 1): string {
  if (value == null || !Number.isFinite(value)) return 'N/A';
  return `${(value * 100).toFixed(digits)}%`;
}

function rateText(cell: { rate: number | null; rateSpecial: string | null }): string {
  if (cell.rate != null) return percentText(cell.rate);
  const reason: Record<string, string> = {
    na_zero_budget: 'N/A(预算为零)',
    na_negative_budget: 'N/A(预算为负)',
    opposite_direction: 'N/A(方向相反)',
  };
  return cell.rateSpecial ? reason[cell.rateSpecial] ?? 'N/A' : 'N/A';
}

function directionText(favorable: 'favorable' | 'unfavorable' | 'none'): string {
  return favorable === 'favorable' ? '有利' : favorable === 'unfavorable' ? '不利' : '持平';
}

function fact(type: string, data: unknown, source: FactSource): FactRecord {
  return { type, data, source: { ...source, asOf: source.asOf || new Date().toISOString() } };
}

function leafBullet(row: AttributionLeaf, dimensionLabel: string): string {
  return `${dimensionLabel}「${row.name}」(${row.code}):差异 ${centsToWanText(row.varianceCents)} 万元(${directionText(row.favorable)}),`
    + `完成率 ${rateText(row)}${row.shareOfTotal == null ? '' : `,占总差异 ${percentText(Math.abs(row.shareOfTotal))}`}`;
}

/** 版本名里已含年份时不再重复前缀,避免「2026 年2026 年度预算 V1」这类标题 */
function titlePrefix(year: number, name: string): string {
  return name.includes(String(year)) ? name : `${year} 年${name}`;
}

function positiveInt(value: unknown, label: string): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw Errors.validation(`${label}必须是正整数`);
  return n;
}

function validYear(value: unknown, label = 'year'): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(n) || n < 1900 || n > 9999) throw Errors.validation(`${label}必须是 1900-9999 的整数`);
  return n;
}

/** 执行月报:总体执行 → 指标 → 归因 → 异常 → 年内趋势 → 建议 */
function monthlyExecution(db: DB, input: ReportDraftInput): ReportDraft {
  const versionId = positiveInt(input.versionId, 'versionId');
  const topN = input.topN == null ? 5 : Math.min(50, Math.max(1, positiveInt(input.topN, 'topN')));
  const scopeArgs = {
    versionId,
    batchId: input.batchId ?? null,
    orgScopeId: input.orgScopeId ?? null,
    accountScopeId: input.accountScopeId ?? null,
    sheetKey: input.sheetKey ?? null,
  };
  const completion = report.completionReport(db, { ...scopeArgs, summaryLevel: null });
  const attribution = attributionReport(db, { ...scopeArgs, maxDepth: 2, topN });
  const anomalies = anomalyReport(db, scopeArgs);
  const version = completion.version;
  const source: FactSource = {
    year: version.year,
    budgetVersionId: version.id,
    actualSnapshotId: completion.actualBatchId,
    asOf: completion.asOfDate || new Date().toISOString(),
    treeSnapshotIds: { org: version.org_tree_snapshot_id, account: version.account_tree_snapshot_id },
  };
  const facts: FactRecord[] = [
    fact('report_execution', completion, source),
    fact('report_attribution', attribution, source),
    fact('report_anomalies', anomalies, source),
  ];

  let trend: unknown = null;
  try {
    trend = report.yearTrend(db, {
      year: version.year,
      versionId,
      batchId: input.batchId ?? null,
      orgScopeId: input.orgScopeId ?? null,
      accountScopeId: input.accountScopeId ?? null,
      sheetKey: input.sheetKey ?? null,
    });
    facts.push(fact('report_trend', trend, source));
  } catch (err) {
    trend = { unavailable: err instanceof Error ? err.message : String(err) };
  }

  const totals = attribution.totals;
  const overview: ReportSection = {
    key: 'overview',
    title: '一、总体执行情况',
    bullets: [
      `预算版本:「${version.name}」(#${version.id},${version.year} 年,状态 ${version.status})`,
      `实际数据口径:${completion.actualSource === 'current' ? '当前累计' : completion.actualSource === 'snapshot' ? '指定快照' : completion.actualSource === 'final' ? '年度最终快照' : '暂无实际数据'}`
        + `${completion.actualBatchId == null ? '' : `(快照 #${completion.actualBatchId})`},截至 ${completion.asOfDate ?? '无'}`,
      `范围内预算合计 ${centsToWanText(totals.budgetCents)} 万元,实际合计 ${centsToWanText(totals.actualCents)} 万元,`
        + `净差异 ${centsToWanText(totals.varianceCents)} 万元(${directionText(totals.favorable)})`,
      completion.unbudgetedActual.count > 0
        ? `未预算/新增结构实际 ${completion.unbudgetedActual.count} 条,净额 ${centsToWanText(completion.unbudgetedActual.amountCents)} 万元;来源承接对账差额 ${centsToWanText(completion.reconciliation.differenceCents)} 万元`
        : `全部实际均有预算叶子承接路径,来源承接对账差额 ${centsToWanText(completion.reconciliation.differenceCents)} 万元`,
      `均匀时间进度 ${percentText(completion.timeProgressValue)};时间进度仅用于节奏对比,不代表月度预算`,
    ],
    data: {
      version: { id: version.id, year: version.year, name: version.name, status: version.status },
      totals,
      asOfDate: completion.asOfDate,
      timeProgressValue: completion.timeProgressValue,
      actualSource: completion.actualSource,
      actualBatchId: completion.actualBatchId,
      treeBasis: completion.treeBasis,
      scopeBasis: completion.scopeBasis,
      unbudgetedActual: completion.unbudgetedActual,
      reconciliation: completion.reconciliation,
    },
    citations: citationsForFacts([facts[0]]),
  };

  const metrics: ReportSection = {
    key: 'metrics',
    title: '二、金额指标完成',
    bullets: completion.metrics.length
      ? completion.metrics.map((m) => `${m.name}(${m.code}):预算 ${centsToWanText(m.cell.budgetCents * m.displaySign)} 万元,`
        + `实际 ${centsToWanText(m.cell.actualCents * m.displaySign)} 万元,差异 ${centsToWanText(m.cell.varianceCents)} 万元(利润方向),完成率 ${rateText(m.cell)}`)
      : ['当前范围内没有启用的报表指标'],
    data: completion.metrics,
    citations: citationsForFacts([facts[0]]),
  };

  const attributionSection: ReportSection = {
    key: 'attribution',
    title: '三、差异归因(按方向与金额排序)',
    bullets: [
      ...(attribution.rankedAccountLeaves.length
        ? attribution.rankedAccountLeaves.slice(0, topN).map((row) => leafBullet(row, '科目'))
        : ['范围内没有科目层差异']),
      ...(attribution.rankedOrgLeaves.length
        ? attribution.rankedOrgLeaves.slice(0, topN).map((row) => leafBullet(row, '组织'))
        : ['范围内没有组织层差异']),
      `逐层核对:组织维度根层合计 ${centsToWanText(attribution.reconciliation.orgRootVarianceCents)} 万元,`
        + `科目维度根层合计 ${centsToWanText(attribution.reconciliation.accountRootVarianceCents)} 万元,`
        + `${attribution.reconciliation.matched ? '两维度一致' : '两维度不一致,请检查范围筛选'}`,
    ],
    data: {
      totals: attribution.totals,
      byOrg: attribution.byOrg,
      byAccount: attribution.byAccount,
      rankedOrgLeaves: attribution.rankedOrgLeaves,
      rankedAccountLeaves: attribution.rankedAccountLeaves,
      reconciliation: attribution.reconciliation,
    },
    citations: citationsForFacts([facts[1]]),
  };

  const quantitySection: ReportSection = {
    key: 'quantity',
    title: '四、数量型科目(不参与金额汇总)',
    bullets: attribution.quantityVariances.length
      ? attribution.quantityVariances.map((row) => `${row.name}(${row.code}):预算 ${quantityText(row.budgetQuantity)}${row.unit || ''},`
        + `实际 ${quantityText(row.actualQuantity)}${row.unit || ''},差异 ${quantityText(row.varianceQuantity)}${row.unit || ''}`)
      : ['范围内数量型科目没有差异'],
    data: attribution.quantityVariances,
    citations: citationsForFacts([facts[1]]),
  };

  const anomalySection: ReportSection = {
    key: 'anomalies',
    title: '五、异常与质量提示',
    bullets: [
      `共命中 ${anomalies.anomalyCount} 条(阈值:完成率偏离 ${anomalies.threshold}、同比 ${anomalies.yoyThreshold}、同类 ${anomalies.peerThreshold})`,
      ...Object.entries(anomalies.countsByCode)
        .sort((a, b) => b[1] - a[1])
        .slice(0, 8)
        .map(([code, count]) => `${anomalies.checks.find((c) => c.code === code)?.label ?? code}:${count} 条`),
      `预算质量:阻塞 ${anomalies.quality.blockingCount} 条,警告 ${anomalies.quality.warningCount} 条,`
        + `${anomalies.quality.canFinalize ? '可定稿' : '尚不可定稿'}`,
    ],
    data: {
      anomalyCount: anomalies.anomalyCount,
      countsByCode: anomalies.countsByCode,
      checks: anomalies.checks,
      quality: anomalies.quality,
      top: anomalies.anomalies.slice(0, 50),
    },
    citations: citationsForFacts([facts[2]]),
  };

  const trendSection: ReportSection = {
    key: 'trend',
    title: '六、年内完成率趋势',
    bullets: (() => {
      const t = trend as any;
      if (!t || t.unavailable) return [`趋势数据不可用:${t?.unavailable ?? '缺少快照'}`];
      const points: any[] = Array.isArray(t.points) ? t.points : [];
      if (!points.length) return ['本年度暂无可用的实际快照,无法形成趋势'];
      const last = points[points.length - 1];
      return [
        `已有 ${points.length} 个实际快照时点,最新 ${last.snapshotDate ?? last.date ?? '未知'}`,
        `最新时点完成率 ${percentText(last.rate ?? null)},时间进度 ${percentText(last.timeProgress ?? null)}`,
      ];
    })(),
    data: trend,
    citations: citationsForFacts([facts[0]]),
  };

  const suggestions = [
    attribution.rankedAccountLeaves.some((row) => row.favorable === 'unfavorable')
      ? '优先复核不利方向金额最大的科目,确认是时间性差异还是口径差异'
      : '继续保持当前执行节奏,关注下一期实际数录入的及时性',
    anomalies.anomalyCount > 0 ? '按异常清单逐条核实,必要时在测算依据中补充说明' : '异常检查通过,可将本期结论保存为洞察',
    completion.actualSource === 'none' ? '先补录本期实际数,再重新生成月报' : '如需对外使用,请连同引用来源一并导出',
  ];

  const sections = [overview, metrics, attributionSection, quantitySection, anomalySection, trendSection];
  return assemble('monthly_execution', `${titlePrefix(version.year, version.name)} 预算执行月报`, {
    period: { year: version.year, asOfDate: completion.asOfDate, timeProgressValue: completion.timeProgressValue },
    scope: {
      versionId: version.id,
      versionName: version.name,
      versionStatus: version.status,
      targetVersionId: null,
      actualSource: completion.actualSource,
      actualBatchId: completion.actualBatchId,
      orgScopeId: input.orgScopeId ?? null,
      accountScopeId: input.accountScopeId ?? null,
      sheetKey: input.sheetKey ?? null,
      treeSnapshotIds: { org: version.org_tree_snapshot_id, account: version.account_tree_snapshot_id },
    },
    sections,
    facts,
    // 守卫词条:版本名 + 归因/数量清单里出现的组织与科目名称
    factTerms: [
      version.name,
      ...attribution.rankedAccountLeaves.map((leaf) => leaf.name),
      ...attribution.rankedOrgLeaves.map((leaf) => leaf.name),
      ...attribution.quantityVariances.map((row) => row.name),
      ...completion.metrics.map((item) => item.name),
    ],
    suggestions,
    notes: [
      '差异为带符号利润方向口径(实际-预算,正数有利);完成率为无符号展示口径',
      '金额按万元两位小数展示(百元精度),原始值为整数分',
      '数量型科目单独成节,不参与金额汇总与指标',
      '要点均由后端确定性计算,叙述文字可由模型改写但数字不变',
    ],
  });
}

/** 年度复盘:年度结果 → 准确率 → 历年对比 → 归因(可选) → 改进建议 */
function annualReview(db: DB, input: ReportDraftInput): ReportDraft {
  const year = validYear(input.year ?? (input.versionId != null ? budget.getVersion(db, positiveInt(input.versionId, 'versionId')).year : null), 'year');
  const facts: FactRecord[] = [];
  const historical = report.historicalComparison(db);
  facts.push(fact('report_historical_comparison', historical, { year }));
  const row = historical.years.find((item) => item.year === year) ?? null;

  let accuracy: any = null;
  let accuracyUnavailable: string | null = null;
  let accuracyFact: FactRecord | null = null;
  try {
    accuracy = report.accuracyReport(db, year);
    accuracyFact = fact('report_accuracy', accuracy, { year });
    facts.push(accuracyFact);
  } catch (err) {
    accuracyUnavailable = err instanceof Error ? err.message : String(err);
  }

  let attribution: ReturnType<typeof attributionReport> | null = null;
  let attributionFact: FactRecord | null = null;
  if (input.versionId != null) {
    const versionId = positiveInt(input.versionId, 'versionId');
    const version = budget.getVersion(db, versionId);
    if (version.year !== year) throw Errors.validation('年度复盘的预算版本年度与 year 不一致');
    attribution = attributionReport(db, {
      versionId,
      batchId: input.batchId ?? null,
      orgScopeId: input.orgScopeId ?? null,
      accountScopeId: input.accountScopeId ?? null,
      sheetKey: input.sheetKey ?? null,
      maxDepth: 2,
      topN: input.topN == null ? 5 : Math.min(50, Math.max(1, positiveInt(input.topN, 'topN'))),
    });
    attributionFact = fact('report_attribution', attribution, {
      year,
      budgetVersionId: versionId,
      actualSnapshotId: attribution.actualBatchId,
      asOf: attribution.asOfDate || new Date().toISOString(),
      treeSnapshotIds: { org: version.org_tree_snapshot_id, account: version.account_tree_snapshot_id },
    });
    facts.push(attributionFact);
  }

  const resultSection: ReportSection = {
    key: 'result',
    title: '一、年度结果',
    bullets: row
      ? [
        `${year} 年最终快照 ${row.finalSnapshotDate ?? '未知'},预算版本「${row.budgetVersionName ?? '未设置当前生效版本'}」`,
        `收入:预算 ${centsToWanText(row.totals.incomeBudget)} 万元,实际 ${centsToWanText(row.totals.incomeActual)} 万元,完成率 ${percentText(row.rateIncome)}`,
        `成本:预算 ${centsToWanText(row.totals.costBudget)} 万元,实际 ${centsToWanText(row.totals.costActual)} 万元`,
        `费用:预算 ${centsToWanText(row.totals.expenseBudget)} 万元,实际 ${centsToWanText(row.totals.expenseActual)} 万元`,
        `利润:预算 ${centsToWanText(row.totals.profitBudget)} 万元,实际 ${centsToWanText(row.totals.profitActual)} 万元,`
          + `差异 ${centsToWanText(row.varianceProfit)} 万元(${directionText(row.varianceProfit > 0 ? 'favorable' : row.varianceProfit < 0 ? 'unfavorable' : 'none')})`,
        `利润同比 ${percentText(row.yoyProfit)}`,
      ]
      : [`${year} 年尚未关闭或没有最终快照,历年对比中暂无该年度数据;关闭年度后可获得完整复盘口径`],
    data: { year, row, availableYears: historical.years.map((item) => item.year) },
    citations: citationsForFacts([facts[0]]),
  };

  const accuracySection: ReportSection = {
    key: 'accuracy',
    title: '二、预算准确率',
    bullets: accuracy
      ? (['income', 'cost', 'expense', 'profit'] as const).map((key) => {
        const label = { income: '收入', cost: '成本', expense: '费用', profit: '利润' }[key];
        const item = accuracy.typeAccuracy[key];
        return `${label}:偏差率 ${percentText(item.e)},准确率 ${percentText(item.q)},完成率 ${percentText(item.rate)}`;
      })
      : [`预算准确率暂不可用:${accuracyUnavailable ?? '年度未关闭'}`],
    data: accuracy ?? { unavailable: accuracyUnavailable },
    citations: accuracyFact ? citationsForFacts([accuracyFact]) : [],
  };

  const historySection: ReportSection = {
    key: 'history',
    title: '三、历年对比',
    bullets: historical.years.length
      ? historical.years.slice(-5).map((item) => `${item.year} 年:利润预算 ${centsToWanText(item.totals.profitBudget)} 万元,`
        + `实际 ${centsToWanText(item.totals.profitActual)} 万元,准确率 ${percentText(item.accuracyProfit)},同比 ${percentText(item.yoyProfit)}`)
      : ['尚无已关闭年度,历年对比为空'],
    data: historical,
    citations: citationsForFacts([facts[0]]),
  };

  // AI 功能增强计划阶段五:年度节奏对比(确定性要点;模型仅改写,数字守卫全量校验)。
  // 事实来自 multiYearTrend 的编码对齐 N 年同口径对比 + 可比性声明;联动归因事实提示异常年份。
  // 范围继承:组织/科目范围与基准年批次与本报告主体一致,避免同一份报告内两套口径。
  let trend: MultiYearTrendResult | null = null;
  let trendFact: FactRecord | null = null;
  try {
    trend = multiYearTrend(db, {
      baseYear: year,
      depth: 3,
      baseBatchId: input.batchId ?? null,
      orgScopeId: input.orgScopeId ?? null,
      accountScopeId: input.accountScopeId ?? null,
    });
    trendFact = fact('report_multi_year_trend', {
      baseYear: trend.baseYear,
      years: trend.years,
      comparability: trend.comparability,
      accounts: trend.accounts,
      orgs: trend.orgs,
      scope: trend.scope,
    }, { year, actualSnapshotId: trend.scope.baseBatchId });
    facts.push(trendFact);
  } catch {
    trend = null;
  }
  const trendBullets: string[] = [];
  if (trend) {
    const comparable = trend.years.filter((point) => point.comparable);
    const skipped = trend.years.filter((point) => !point.comparable);
    trendBullets.push(`同口径窗口:${comparable.map((point) => `${point.year}(${point.asOfDate ?? '无快照'})`).join('、') || '无'};历史年取与基准年同期(±7 天)快照`);
    // 范围声明与报告主体同源:范围为空时明确说明是全量,避免读者误以为章节漏了筛选
    trendBullets.push(`取数范围:${trend.scope.orgCodes ? `组织限定 ${trend.scope.orgCodes.length} 个编码` : '组织全量'},`
      + `${trend.scope.accountCodes ? `科目限定 ${trend.scope.accountCodes.length} 个编码` : '科目全量'},`
      + `${trend.scope.baseBatchId == null ? '基准年批次按年度状态自动选择' : `基准年批次 #${trend.scope.baseBatchId}`}`);
    if (skipped.length > 0) trendBullets.push(`不可比年份如实跳过:${skipped.map((point) => `${point.year}(${point.reason})`).join('、')}`);
    const cmp = trend.comparability;
    trendBullets.push(`可比性:科目匹配 ${cmp.matchedAccountCodes.length} 个、新增 ${cmp.addedAccountCodes.length} 个、消失 ${cmp.removedAccountCodes.length} 个;组织匹配 ${cmp.matchedOrgCodes.length} 个、新增 ${cmp.addedOrgCodes.length} 个、消失 ${cmp.removedOrgCodes.length} 个`);
    if (cmp.addedOrgCodes.length > 0) trendBullets.push(`新增组织编码:${cmp.addedOrgCodes.join('、')}`);
    if (cmp.removedOrgCodes.length > 0) trendBullets.push(`消失组织编码:${cmp.removedOrgCodes.join('、')}(历史有数而基准年没有,已如实列出不做静默丢弃)`);
    if (cmp.addedAccountCodes.length > 0) trendBullets.push(`新增科目编码:${cmp.addedAccountCodes.join('、')}`);
    if (cmp.removedAccountCodes.length > 0) trendBullets.push(`消失科目编码:${cmp.removedAccountCodes.join('、')}`);
    // 科目维度要点:变化最大的前 3 个匹配编码
    const movers = trend.accounts
      .map((row) => {
        const years = comparable.map((point) => point.year);
        const first = years.map((y) => row.values[y]).find((value) => value !== undefined);
        const lastValue = [...years].reverse().map((y) => row.values[y]).find((value) => value !== undefined);
        if (first === undefined || lastValue === undefined || first === 0 || first === lastValue) return null;
        return { row, change: (lastValue - first) / Math.abs(first), lastValue };
      })
      .filter((item): item is NonNullable<typeof item> => item != null)
      .sort((a, b) => Math.abs(b.change) - Math.abs(a.change))
      .slice(0, 3);
    for (const mover of movers) {
      trendBullets.push(`科目 ${mover.row.code} ${mover.row.name}:累计变动 ${percentText(mover.change)},最新 ${centsToWanText(mover.lastValue)} 万元`);
    }
    // 联动归因:异常年份提示(差异绝对值最大的组织/科目已在归因事实中,这里只引用提示)
    if (attribution) trendBullets.push(`异常年份下探请见「五、主要差异归因」:净差异 ${centsToWanText(attribution.totals.varianceCents)} 万元(${directionText(attribution.totals.favorable)})`);
  }
  const trendSection: ReportSection = {
    key: 'trend',
    title: '四、年度节奏对比',
    bullets: trend ? trendBullets : ['跨年同口径对比暂不可用(基准年缺少实际数据或快照)'],
    data: trend ? { years: trend.years, comparability: trend.comparability, accounts: trend.accounts, orgs: trend.orgs, scope: trend.scope } : null,
    citations: trendFact ? citationsForFacts([trendFact]) : [],
  };

  const attributionSection: ReportSection = {
    key: 'attribution',
    title: '五、主要差异归因',
    bullets: attribution
      ? [
        `净差异 ${centsToWanText(attribution.totals.varianceCents)} 万元(${directionText(attribution.totals.favorable)})`,
        ...attribution.rankedAccountLeaves.slice(0, 5).map((leaf) => leafBullet(leaf, '科目')),
        ...attribution.rankedOrgLeaves.slice(0, 5).map((leaf) => leafBullet(leaf, '组织')),
      ]
      : ['未指定预算版本,跳过归因;补充 versionId 后可得到逐层展开的归因结果'],
    data: attribution
      ? { totals: attribution.totals, rankedAccountLeaves: attribution.rankedAccountLeaves, rankedOrgLeaves: attribution.rankedOrgLeaves, byOrg: attribution.byOrg, byAccount: attribution.byAccount }
      : null,
    citations: attributionFact ? citationsForFacts([attributionFact]) : [],
  };

  const suggestions = [
    row == null ? '先完成年度关闭并指定最终快照,再生成正式复盘' : '把复盘结论保存为洞察,便于下一年度编制时引用',
    accuracy ? '对准确率最低的类型追溯编制假设,沉淀为测算依据' : '年度关闭后重新生成以获得准确率分析',
    attribution ? '针对不利方向的组织与科目,在下一年度预算中设定改进目标' : '补充预算版本以获得逐层归因',
  ];

  return assemble('annual_review', `${year} 年度预算复盘`, {
    period: { year, asOfDate: row?.finalSnapshotDate ?? attribution?.asOfDate ?? null, timeProgressValue: null },
    scope: {
      versionId: input.versionId == null ? null : positiveInt(input.versionId, 'versionId'),
      versionName: row?.budgetVersionName ?? attribution?.version.name ?? null,
      versionStatus: attribution?.version.status ?? null,
      targetVersionId: null,
      actualSource: attribution?.actualSource ?? null,
      actualBatchId: attribution?.actualBatchId ?? null,
      orgScopeId: input.orgScopeId ?? null,
      accountScopeId: input.accountScopeId ?? null,
      sheetKey: input.sheetKey ?? null,
      treeSnapshotIds: {
        org: attribution?.version.org_tree_snapshot_id ?? null,
        account: attribution?.version.account_tree_snapshot_id ?? null,
      },
    },
    sections: [resultSection, accuracySection, historySection, trendSection, attributionSection],
    facts,
    // 守卫词条:版本名 + 趋势/归因里出现的组织与科目名称,防止模型偷换专名
    factTerms: [
      row?.budgetVersionName ?? '',
      attribution?.version.name ?? '',
      ...(trend?.accounts ?? []).map((item) => item.name),
      ...(trend?.orgs ?? []).map((item) => item.name),
      ...(attribution?.rankedAccountLeaves ?? []).map((leaf) => leaf.name),
      ...(attribution?.rankedOrgLeaves ?? []).map((leaf) => leaf.name),
    ],
    suggestions,
    notes: [
      '历年对比与准确率只使用已关闭年度的最终快照,不按当前树结构重算历史',
      '偏差率 E = |实际-预算| / |预算|;准确率 Q = max(0, 1-E)',
      '金额按万元两位小数展示,原始值为整数分',
    ],
  });
}

/** 预算讨论材料:版本概况 → 结构分布 → 质量与异常 → 版本/基准对比 → 待议议题 */
function budgetDiscussion(db: DB, input: ReportDraftInput): ReportDraft {
  const versionId = positiveInt(input.versionId, 'versionId');
  const topN = input.topN == null ? 8 : Math.min(50, Math.max(1, positiveInt(input.topN, 'topN')));
  const version = budget.getVersion(db, versionId);
  const completion = report.completionReport(db, {
    versionId,
    batchId: input.batchId ?? null,
    orgScopeId: input.orgScopeId ?? null,
    accountScopeId: input.accountScopeId ?? null,
    sheetKey: input.sheetKey ?? null,
    summaryLevel: null,
  });
  const quality = budgetQualityReport(db, versionId);
  const source: FactSource = {
    year: version.year,
    budgetVersionId: versionId,
    actualSnapshotId: completion.actualBatchId,
    asOf: completion.asOfDate || new Date().toISOString(),
    treeSnapshotIds: { org: version.org_tree_snapshot_id, account: version.account_tree_snapshot_id },
  };
  const facts: FactRecord[] = [
    fact('report_budget_structure', completion, source),
    fact('report_budget_quality', quality, source),
  ];

  let compare: report.VersionCompareResult | null = null;
  let compareUnavailable: string | null = null;
  if (input.targetVersionId != null) {
    const targetVersionId = positiveInt(input.targetVersionId, 'targetVersionId');
    try {
      compare = report.versionCompare(db, versionId, targetVersionId);
      facts.push(fact('report_version_compare', {
        baseVersion: compare.baseVersion,
        targetVersion: compare.targetVersion,
        treeSame: compare.treeSame,
        addedOrgCodes: compare.addedOrgCodes,
        removedOrgCodes: compare.removedOrgCodes,
        addedAccountCodes: compare.addedAccountCodes,
        removedAccountCodes: compare.removedAccountCodes,
        totalBase: compare.totalBase,
        totalTarget: compare.totalTarget,
        leafChanges: compare.leafChanges.slice(0, 200),
        notes: compare.notes,
      }, { ...source, targetVersionId }));
    } catch (err) {
      compareUnavailable = err instanceof Error ? err.message : String(err);
    }
  }

  const typeTotals = { income: 0, cost: 0, expense: 0 };
  for (const row of completion.analysisAccounts) {
    if (!row.isLeaf) continue;
    if (row.type === 'income' || row.type === 'cost' || row.type === 'expense') {
      // 金额汇总一律走 safeIntegerAdd：全仓其余汇总点都有这层溢出护栏，
      // 这里原来是裸 `+=`，是唯一的例外。
      typeTotals[row.type] = safeIntegerAdd(typeTotals[row.type], row.cell.budgetCents, '报告类型预算汇总');
    }
  }
  const profitBudget = safeIntegerAdd(safeIntegerAdd(typeTotals.income, typeTotals.cost, '报告利润预算'), typeTotals.expense, '报告利润预算');
  // 代表性组织按预算体量(一级科目绝对值合计)排名:净额口径下收入成本互抵的
  // 大组织会被误判为小组织,净额为零则直接落选。
  const orgLeaves = completion.byOrg
    .filter((row) => row.isLeaf)
    .sort((a, b) => b.budgetVolumeCents - a.budgetVolumeCents
      || Math.abs(b.cell.budgetCents) - Math.abs(a.cell.budgetCents)
      || a.code.localeCompare(b.code))
    .slice(0, topN);

  const overview: ReportSection = {
    key: 'overview',
    title: '一、版本概况',
    bullets: [
      `版本「${version.name}」(#${version.id}),${version.year} 年,类型 ${version.kind === 'forecast' ? '预测' : '预算'},状态 ${version.status}${version.is_current ? ',当前生效' : ''}`,
      `绑定树快照:组织 #${version.org_tree_snapshot_id}、科目 #${version.account_tree_snapshot_id};${version.status === 'locked' ? '已定稿版本不可修改' : '草稿可继续编辑'}`,
      `范围口径:${completion.scopeBasis.sheetName}(sheetKey=${completion.scopeBasis.sheetKey}),组织范围 ${completion.scopeBasis.orgScopeId ?? '全部'},科目范围 ${completion.scopeBasis.accountScopeId ?? '全部'}`,
    ],
    data: { version, scopeBasis: completion.scopeBasis, treeBasis: completion.treeBasis },
    citations: citationsForFacts([facts[0]]),
  };

  const structure: ReportSection = {
    key: 'structure',
    title: '二、预算结构',
    bullets: [
      `收入 ${centsToWanText(typeTotals.income)} 万元,成本 ${centsToWanText(typeTotals.cost)} 万元,费用 ${centsToWanText(typeTotals.expense)} 万元`,
      `利润(收入+成本+费用,带符号)${centsToWanText(profitBudget)} 万元`,
      ...(completion.metrics.length
        ? completion.metrics.map((m) => `指标 ${m.name}(${m.code}):预算 ${centsToWanText(m.cell.budgetCents * m.displaySign)} 万元${m.displaySign === -1 ? '(业务正数)' : ''}`)
        : ['没有启用的报表指标']),
      ...(orgLeaves.length
        ? orgLeaves.map((row) => `叶子组织「${row.name}」(${row.code}):预算体量 ${centsToWanText(row.budgetVolumeCents)} 万元,预算净额 ${centsToWanText(row.cell.budgetCents)} 万元`)
        : ['范围内没有叶子组织预算']),
    ],
    data: { typeTotals, profitBudget, metrics: completion.metrics, orgLeaves },
    citations: citationsForFacts([facts[0]]),
  };

  const qualitySection: ReportSection = {
    key: 'quality',
    title: '三、质量与合规检查',
    bullets: [
      `${quality.canFinalize ? '可定稿' : '尚不可定稿'}:阻塞 ${quality.blockingCount} 条,警告 ${quality.warningCount} 条`,
      `填报覆盖:${JSON.stringify(quality.coverage)}`,
      ...quality.issues.slice(0, 10).map((issue) => `[${issue.severity}] ${issue.code}:${issue.message}`),
    ],
    data: quality,
    citations: citationsForFacts([facts[1]]),
  };

  const compareSection: ReportSection = {
    key: 'compare',
    title: '四、与对比版本的差异',
    bullets: compare
      ? [
        `对比「${compare.baseVersion.name}」→「${compare.targetVersion.name}」,树快照${compare.treeSame ? '相同' : '不同'}`,
        `合计 ${centsToWanText(compare.totalBase)} 万元 → ${centsToWanText(compare.totalTarget)} 万元,`
          + `变化 ${centsToWanText(compare.totalTarget - compare.totalBase)} 万元`,
        `叶子变化 ${compare.leafChanges.length} 项;新增组织 ${compare.addedOrgCodes.length} 个,移除 ${compare.removedOrgCodes.length} 个;`
          + `新增科目 ${compare.addedAccountCodes.length} 个,移除 ${compare.removedAccountCodes.length} 个`,
        ...[...compare.leafChanges]
          .sort((a, b) => Math.abs(b.deltaCents) - Math.abs(a.deltaCents))
          .slice(0, topN)
          .map((change) => `${change.orgCode} × ${change.accountCode}:${centsToWanText(change.baseCents)} → ${centsToWanText(change.targetCents)} 万元`
            + `(变化 ${centsToWanText(change.deltaCents)} 万元)`),
      ]
      : [compareUnavailable ? `版本对比不可用:${compareUnavailable}` : '未指定 targetVersionId,跳过版本对比'],
    data: compare
      ? { treeSame: compare.treeSame, totalBase: compare.totalBase, totalTarget: compare.totalTarget, leafChanges: compare.leafChanges.slice(0, 200), addedOrgCodes: compare.addedOrgCodes, removedOrgCodes: compare.removedOrgCodes, addedAccountCodes: compare.addedAccountCodes, removedAccountCodes: compare.removedAccountCodes }
      : { unavailable: compareUnavailable },
    citations: compare ? citationsForFacts([facts[facts.length - 1]]) : [],
  };

  const agenda: ReportSection = {
    key: 'agenda',
    title: '五、待讨论议题(AI 建议)',
    bullets: [
      quality.canFinalize ? '质量门禁已通过,可讨论定稿时间与生效版本切换' : '先解决阻塞项,再安排定稿',
      profitBudget < 0 ? '预算利润为负,需讨论收入目标或成本费用压降空间' : '确认利润目标与各组织责任指标是否匹配',
      compare ? '重点讨论变化最大的叶子明细及其测算依据' : '建议指定对比版本,便于讨论修订幅度',
      '数量型科目(电量、人数等)单独确认,不进入金额汇总',
    ],
    citations: [],
  };

  return assemble('budget_discussion', `${titlePrefix(version.year, `「${version.name}」`)} 预算讨论材料`, {
    period: { year: version.year, asOfDate: completion.asOfDate, timeProgressValue: completion.timeProgressValue },
    scope: {
      versionId,
      versionName: version.name,
      versionStatus: version.status,
      targetVersionId: input.targetVersionId == null ? null : positiveInt(input.targetVersionId, 'targetVersionId'),
      actualSource: completion.actualSource,
      actualBatchId: completion.actualBatchId,
      orgScopeId: input.orgScopeId ?? null,
      accountScopeId: input.accountScopeId ?? null,
      sheetKey: input.sheetKey ?? null,
      treeSnapshotIds: { org: version.org_tree_snapshot_id, account: version.account_tree_snapshot_id },
    },
    sections: [overview, structure, qualitySection, compareSection, agenda],
    facts,
    // 守卫词条:本版本与对比版本名 + 结构/对比清单里出现的组织与指标名称
    factTerms: [
      version.name,
      compare?.baseVersion.name ?? '',
      compare?.targetVersion.name ?? '',
      completion.scopeBasis.sheetName,
      ...orgLeaves.map((row) => row.name),
      ...completion.metrics.map((item) => item.name),
    ],
    suggestions: [
      '把讨论材料保存为洞察,后续追溯讨论口径',
      quality.canFinalize ? '讨论通过后即可定稿并设为当前生效' : '按质量报告逐条补齐后重新生成材料',
      '涉及修改预算时使用助手的批量调整预览,确认后才会写入',
    ],
    notes: [
      '定稿版本不可修改;历史报表不按当前结构重算',
      '成本与费用在存储中为负数,材料中的金额已按利润方向直接呈现',
      '金额按万元两位小数展示,原始值为整数分',
    ],
  });
}

/** 章节 → Markdown 块。与 assemble 的组装口径完全一致,供「只改写单个章节」的路径复用。 */
export function sectionMarkdown(section: ReportSection): string {
  return [`## ${section.title}`, ...section.bullets.map((line) => `- ${line}`)].join('\n');
}

function assemble(
  kind: ReportKind,
  title: string,
  parts: Omit<ReportDraft, 'kind' | 'kindLabel' | 'title' | 'generatedAt' | 'citations' | 'narrative' | 'narrativeSource' | 'factTerms'>
    & { factTerms?: string[] },
): ReportDraft {
  const generatedAt = new Date().toISOString();
  const narrative = [
    `# ${title}`,
    `生成时间:${generatedAt}(报告类型:${KIND_LABEL[kind]})`,
    ...parts.sections.map((section) => sectionMarkdown(section)),
    ['## 建议(AI 生成,仅供参考)', ...parts.suggestions.map((line) => `- ${line}`)].join('\n'),
    ['## 口径说明', ...parts.notes.map((line) => `- ${line}`)].join('\n'),
  ].join('\n\n');
  // 只保留真正出现在叙述里的专名:未出现的词条在两侧都是 0 次,进 multiset 只是噪音。
  const factTerms = [...new Set((parts.factTerms ?? []).map((term) => String(term ?? '').trim()).filter((term) => term.length >= 2))]
    .filter((term) => narrative.includes(term))
    .sort((a, b) => b.length - a.length);
  const { factTerms: _ignored, ...rest } = parts;
  return {
    kind,
    kindLabel: KIND_LABEL[kind],
    title,
    generatedAt,
    ...rest,
    citations: citationsForFacts(parts.facts),
    narrative,
    narrativeSource: 'template',
    factTerms,
  };
}

/**
 * 生成报告草稿。纯读操作,不写库;数字全部来自现有分析 service。
 */
export function reportDraft(db: DB, input: ReportDraftInput): ReportDraft {
  const kind = normalizeReportKind(input.kind);
  if (kind === 'monthly_execution') return monthlyExecution(db, input);
  if (kind === 'annual_review') return annualReview(db, input);
  return budgetDiscussion(db, input);
}
