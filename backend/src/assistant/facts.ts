import { queryDomainFacts } from './domain-facts';
import { isDomainIntent } from './domain-intents';
import type { DB } from '../db/connection';
import * as budget from '../modules/budget/budget.service';
import * as actual from '../modules/actual/actual.service';
import { budgetQualityReport } from '../modules/check/budget-quality';
import { executeTool } from './tools';
import { explainTerms, looksLikeExplainQuestion } from './glossary';
import { looksLikeNavigation, navigationCatalog, resolveNavigation } from './navigation';
import { detectDirection, detectIntents, detectReportKind, type IntentDetection, type ReadIntent } from './intent';
import type { AssistantCitation, AssistantScope } from '../contracts/assistant';
import { citationsForFacts } from './citations';
import type { AssistantFact as FactRecord, FactSource } from '../contracts/assistant';


export function budgetFacts(db: DB, year?: number): { versions: unknown; snapshots: unknown; citations: AssistantCitation[] } {
  const facts = [
    fact('budget_versions', executeTool(db, 'list_budget_versions', { year: year }), { year }),
    fact('actual_snapshots', executeTool(db, 'list_actual_snapshots', { year: year }), { year }),
  ];
  return { versions: facts[0].data, snapshots: facts[1].data, citations: citationsForFacts(facts) };
}

function fact(type: string, data: unknown, source: FactSource = {}): FactRecord {
  return { type, data, source: { ...source, asOf: source.asOf || new Date().toISOString() } };
}

/** 多年趋势基准年:上下文年度 → 最近一个有年度状态的年份 → 当前日历年。 */
function multiYearBaseYear(db: DB, contextYear: number | undefined): number {
  if (contextYear != null) return contextYear;
  const states = actual.listYearStates(db);
  return states.length > 0 ? states[0].year : new Date().getFullYear();
}

function versionSource(db: DB, versionId: number | undefined, context: AssistantScope): FactSource {
  if (versionId == null) return { year: context.year, budgetVersionId: null };
  const v = budget.getVersion(db, versionId);
  return {
    year: v.year,
    budgetVersionId: v.id,
    treeSnapshotIds: { org: v.org_tree_snapshot_id, account: v.account_tree_snapshot_id },
  };
}

function batchSource(db: DB, batchId: number | undefined, context: AssistantScope): FactSource {
  if (batchId == null) return { year: context.year, actualSnapshotId: null };
  const b = actual.getBatch(db, batchId);
  return {
    year: b.year,
    actualSnapshotId: b.id,
    asOf: b.snapshot_date,
    treeSnapshotIds: { org: b.org_tree_snapshot_id, account: b.account_tree_snapshot_id },
  };
}

/**
 * 后端固化口径的轻量事实：业务解释词典与页面导航。
 *
 * 这两项纯计算、无数据库重查询，并且是「模型不可用也必须准确」的内容，
 * 因此无论走模型路由还是正则兜底都会附加。
 */
export function deterministicExtras(db: DB, message: string, context: AssistantScope = {}): FactRecord[] {
  const m = String(message || '').trim();
  const out: FactRecord[] = [];
  const glossary = explainTerms(m, 4);
  if (glossary.length && (looksLikeExplainQuestion(m) || glossary.length >= 2)) {
    out.push(fact('glossary', { query: m.slice(0, 200), entries: glossary }, { year: context.year }));
  }
  const navigation = resolveNavigation(m, context);
  if (navigation) out.push(fact('navigation', { target: navigation }, { year: context.year }));
  else if (looksLikeNavigation(m)) out.push(fact('navigation_catalog', { pages: navigationCatalog() }, { year: context.year }));
  return out;
}

export interface QueryFactsOptions {
  /** 已算好的意图；不传则内部按正则识别 */
  intents?: IntentDetection;
  /** 是否附加 glossary / navigation 事实(模型路由时由调用方单独附加，避免重复) */
  includeExtras?: boolean;
  view?: Record<string, unknown>;
}

/**
 * 按意图调用确定性只读工具（模型不可用时的兜底路由）。
 *
 * 每条记录都保留来源元数据，调用方可直接把 source 转成 citations；
 * 模型只看到截断后的 data，不会获得数据库句柄。
 *
 * 与旧实现的区别：工具选择来自 intent.ts 的去重后意图集合，
 * 不再由重叠的正则各自触发，因此同一份 completionReport 不会被算两遍。
 */
export function queryFacts(db: DB, message: string, context: AssistantScope = {}, options: QueryFactsOptions = {}): FactRecord[] {
  const m = String(message || '').trim();
  const detection = options.intents ?? detectIntents(m, context.pageKey);
  const intents = new Set<ReadIntent>(detection.read);
  const facts: FactRecord[] = queryDomainFacts(db, m, context, detection.read, options.view);
  /**
   * 追加一条事实。
   *
   * `source` 允许传工厂函数：`versionSource()` 内部会调 `budget.getVersion`，
   * 版本被并发删除时会抛 notFound。原来第三个实参在 `add(...)` 的 try 之外求值，
   * 这层 try/catch(「宁可给一条 query_error，也不要让整个聊天变 500」)就被绕过了。
   */
  const add = (type: string, fn: () => unknown, source: FactSource | (() => FactSource) = {}) => {
    let resolved: FactSource = { year: context.year };
    try {
      resolved = typeof source === 'function' ? source() : source;
      const data: any = fn();
      const derived: FactSource = { ...resolved };
      if (data && typeof data === 'object') {
        if (typeof data.year === 'number' && derived.year == null) derived.year = data.year;
        if (data.version?.id != null && derived.budgetVersionId == null) derived.budgetVersionId = Number(data.version.id);
        if (data.actualBatchId != null && derived.actualSnapshotId == null) derived.actualSnapshotId = Number(data.actualBatchId);
        if (typeof data.asOfDate === 'string' && data.asOfDate) derived.asOf = data.asOfDate;
        // 注意：不要在这里把 treeSnapshotIds 补成空对象。`treeBasis` 只是给人看的
        // 文字说明，凑一个 `{}` 出来会让引用里出现「有字段但没有 ID」的空壳，
        // 反而比缺字段更难判断口径；真实 ID 一律由 source 工厂提供。
      }
      facts.push(fact(type, data, derived));
    }
    catch (err) {
      // 业务参数缺失/过期时返回可解释事实，而不是让整个聊天请求变成 500。
      facts.push(fact('query_error', { requested: type, message: err instanceof Error ? err.message : String(err) }, resolved));
    }
  };
  const year = context.year;
  const versionId = context.budgetVersionId;
  const versionSrc = () => versionSource(db, versionId, context);
  const batchSrc = () => batchSource(db, context.actualSnapshotId, context);
  const analysisSrc = () => ({ ...versionSrc(), ...(context.actualSnapshotId != null ? batchSrc() : {}) });
  /** 需要版本的意图统一在这里给出缺失说明，避免每处重复写。 */
  const requireVersion = (reason: string): boolean => {
    if (versionId != null) return true;
    facts.push(fact('missing_context', { field: 'budgetVersionId', reason }, { year }));
    return false;
  };

  if (intents.has('budget_versions')) {
    add('budget_versions', () => executeTool(db, 'list_budget_versions', { year: year }), { year, budgetVersionId: context.budgetVersionId ?? null });
  }
  if (intents.has('actual_snapshots')) {
    if (context.actualSnapshotId != null && /快照/.test(m)) add('actual_snapshot', () => executeTool(db, 'get_actual_snapshot', { batchId: context.actualSnapshotId! }), batchSrc);
    else add('actual_snapshots', () => executeTool(db, 'list_actual_snapshots', { year: year }), { year, actualSnapshotId: context.actualSnapshotId ?? null });
  }
  if (intents.has('org_tree')) add('org_tree', () => executeTool(db, 'get_org_tree', {  }), { year });
  if (intents.has('account_tree')) add('account_tree', () => executeTool(db, 'get_account_tree', {  }), { year });
  if (intents.has('import')) {
    if (context.importBatchId != null) {
      add('import_batch', () => executeTool(db, 'get_import_batch', { batchId: context.importBatchId! }), { year });
      // 导入辅助(方案 4.1):错误解释 + 组织/科目匹配建议 + 未匹配与重复清单。
      add('import_help', () => executeTool(db, 'explain_import', { batchId: context.importBatchId! }), { year });
    } else add('import_batches', () => executeTool(db, 'validate_import', {  }), { year });
  }
  if (intents.has('operation_log')) add('operation_log', () => executeTool(db, 'get_operation_log', { page: 1, pageSize: 50 }), { year });
  // 财务实际数转换(独立模块)：先给批次列表，再自动下钻到「问的那一批」。
  // 没有显式批次号时取最近一批——用户说「上次转换」指的就是它。
  if (intents.has('finance_conversion')) {
    add('finance_conversions', () => executeTool(db, 'list_finance_conversions', { limit: 20 }), { year });
    const listed = facts[facts.length - 1]?.data as { batches?: { id: number }[] } | undefined;
    const explicit = /(?:转换批次|批次)\s*#?(\d+)/.exec(m);
    const targetId = explicit ? Number(explicit[1]) : listed?.batches?.[0]?.id ?? null;
    if (targetId != null && Number.isSafeInteger(targetId) && targetId > 0) {
      add('finance_conversion_detail', () => executeTool(db, 'get_finance_conversion', { conversionId: targetId }), { year });
      const detail = facts[facts.length - 1]?.data as { mappingVersionId?: number } | undefined;
      if (/映射|漏|未映射|冲突|权重|拆分/.test(m) && detail?.mappingVersionId != null) {
        add('finance_mapping_version', () => executeTool(db, 'get_finance_mapping_version', { mappingVersionId: detail.mappingVersionId! }), { year });
      }
      if (/并行|试运行|手工|比对|对得上|复核/.test(m)) {
        add('finance_parallel_trials', () => executeTool(db, 'list_finance_parallel_trials', { conversionId: targetId }), { year });
      }
    }
    if (/映射版本|有哪些映射|映射列表|映射清单/.test(m)) add('finance_mapping_versions', () => executeTool(db, 'list_finance_mapping_versions', {  }), { year });
    if (/拥有范围|数据源|适配器/.test(m)) add('finance_source_profiles', () => executeTool(db, 'list_finance_source_profiles', {  }), { year });
  }

  if (intents.has('trend') && requireVersion('趋势分析需要预算版本')) {
    add('trend', () => executeTool(db, 'calculate_trend', {
      year: Number(year || budget.getVersion(db, versionId!).year), versionId: versionId!,
      orgScopeId: context.orgScopeId ?? null, accountScopeId: context.accountScopeId ?? null,
      batchId: context.actualSnapshotId ?? null,
    }), analysisSrc);
  }
  if (intents.has('version_variance')) {
    if (versionId == null || context.targetVersionId == null) {
      facts.push(fact('missing_context', { fields: ['budgetVersionId', 'targetVersionId'], reason: '版本对比需要两个版本' }, { year }));
    } else add('version_variance', () => executeTool(db, 'calculate_variance', { baseVersionId: versionId, targetVersionId: context.targetVersionId! }), () => ({ ...versionSrc(), targetVersionId: context.targetVersionId }));
  }
  if (intents.has('execution') && requireVersion('执行分析需要预算版本')) {
    add('execution', () => executeTool(db, 'calculate_execution', {
      versionId: versionId!, batchId: context.actualSnapshotId ?? null,
      orgScopeId: context.orgScopeId ?? null, accountScopeId: context.accountScopeId ?? null,
    }), analysisSrc);
  }
  // 差异归因(方案 4.3):按组织、科目和方向排序,逐层展开且可逐层核对。
  if (intents.has('attribution') && requireVersion('差异归因需要预算版本')) {
    add('attribution', () => executeTool(db, 'calculate_attribution', {
      versionId: versionId!, batchId: context.actualSnapshotId ?? null,
      orgScopeId: context.orgScopeId ?? null, accountScopeId: context.accountScopeId ?? null,
      maxDepth: 3, topN: 10, direction: detectDirection(m),
    }), analysisSrc);
  }
  // 报告生成(方案 4.3):执行月报 / 年度复盘 / 预算讨论材料。
  if (intents.has('report')) {
    const kind = detectReportKind(m);
    if (kind === 'annual_review' && year == null && versionId == null) {
      facts.push(fact('missing_context', { fields: ['year'], reason: '年度复盘需要年度' }));
    } else if (kind !== 'annual_review' && versionId == null) {
      facts.push(fact('missing_context', { field: 'budgetVersionId', reason: '报告生成需要预算版本' }, { year }));
    } else {
      add('report_draft', () => executeTool(db, 'generate_report', {
        kind,
        versionId: versionId ?? null,
        year: year ?? null,
        batchId: context.actualSnapshotId ?? null,
        targetVersionId: context.targetVersionId ?? null,
        orgScopeId: context.orgScopeId ?? null,
        accountScopeId: context.accountScopeId ?? null,
      }), () => ({ ...(versionId == null ? { year } : versionSrc()), ...(context.actualSnapshotId != null ? batchSrc() : {}) }));
    }
  }
  if (intents.has('budget_quality') && requireVersion('质量检查需要预算版本')) {
    add('budget_quality', () => executeTool(db, 'get_budget_quality', { versionId: versionId! }), versionSrc);
  }
  if (intents.has('anomalies') && requireVersion('异常检查需要预算版本')) {
    add('anomalies', () => executeTool(db, 'calculate_anomalies', { versionId: versionId!, batchId: context.actualSnapshotId ?? null }), analysisSrc);
  }
  if (intents.has('accuracy')) {
    if (year == null) facts.push(fact('missing_context', { field: 'year', reason: '准确率需要年度' }));
    else add('accuracy', () => executeTool(db, 'calculate_accuracy', { year: year }), { year });
  }
  if (intents.has('historical_comparison')) {
    add('historical_comparison', () => executeTool(db, 'get_historical_comparison', {  }), { year });
    // 历年对比页同时展示多年趋势(/report/multi-year-trend):基准年取上下文年度,
    // 缺省取最近一个有年度状态的年份,都没有时退回当前日历年。
    add('multi_year_trend', () => executeTool(db, 'calculate_multi_year_trend', { baseYear: multiYearBaseYear(db, year), depth: 3 }), { year });
  }
  if (intents.has('budget_progress') && requireVersion('编制进度需要预算版本')) {
    add('budget_progress', () => executeTool(db, 'get_budget_progress', { versionId: versionId! }), versionSrc);
  }
  if (intents.has('structure') && requireVersion('结构分析需要预算版本')) {
    // 确定性路径没有 metricId 上下文,只有科目焦点能作为基准;其余情况回落到 parent 口径。
    const basisMode = context.accountScopeId != null && /科目/.test(m) ? 'account' : 'parent';
    add('structure', () => executeTool(db, 'calculate_structure', {
      versionId: versionId!, batchId: context.actualSnapshotId ?? null,
      orgScopeId: context.orgScopeId ?? null, accountScopeId: context.accountScopeId ?? null,
      basisMode, ...(basisMode === 'account' ? { basisId: context.accountScopeId! } : {}),
    }), analysisSrc);
  }
  if (intents.has('metric_catalog')) add('metric_catalog', () => executeTool(db, 'list_metrics', { versionId: versionId ?? undefined }), versionId != null ? versionSrc : { year });
  if (intents.has('insights')) add('insights', () => executeTool(db, 'list_insights', { limit: 20 }), { year });
  if (intents.has('master_health')) add('master_data_health', () => executeTool(db, 'get_master_data_health', {  }), { year });
  if (intents.has('consistency_check')) add('consistency_check', () => executeTool(db, 'check_consistency', {  }), { year });
  if (intents.has('calculation_rules')) add('calculation_rules', () => executeTool(db, 'list_calculation_rules', { includeInactive: true }), { year });
  if (intents.has('cleaning_config')) {
    add('cleaning_templates', () => executeTool(db, 'list_cleaning_templates', {  }), { year });
    add('cleaning_aliases', () => executeTool(db, 'list_cleaning_aliases', {}), { year });
  }
  // 单元格备注：预算侧按版本快照口径、实际侧按当前年度口径，能查哪侧查哪侧。
  // 不属于 VERSION_REQUIRED——只有年度时查实际侧也成立；两侧都缺才报 missing_context。
  if (intents.has('cell_note')) {
    let noteYear: number | null | undefined = year;
    if (versionId != null) {
      add('cell_notes_budget', () => executeTool(db, 'get_cell_notes', {
        source: 'budget', versionId: versionId!,
        orgId: context.orgScopeId ?? null, accountId: context.accountScopeId ?? null,
      }), versionSrc);
      if (noteYear == null) {
        try { noteYear = budget.getVersion(db, versionId).year; } catch { noteYear = null; }
      }
    }
    if (noteYear != null) {
      const queryYear = noteYear;
      add('cell_notes_actual', () => executeTool(db, 'get_cell_notes', {
        source: 'actual', year: queryYear,
        orgId: context.orgScopeId ?? null, accountId: context.accountScopeId ?? null,
      }), { year: queryYear });
    }
    if (versionId == null && noteYear == null) {
      facts.push(fact('missing_context', { fields: ['budgetVersionId', 'year'], reason: '查询单元格备注需要预算版本或年度' }, { year }));
    }
  }

  if (options.includeExtras !== false) facts.push(...deterministicExtras(db, m, context));

  // 没有命中任何意图时，至少返回当前上下文的轻量版本列表，便于助手继续追问。
  if (facts.length === 0 && year != null && !detection.read.some(isDomainIntent)) add('budget_versions', () => executeTool(db, 'list_budget_versions', { year: year }), { year });
  return facts;
}
