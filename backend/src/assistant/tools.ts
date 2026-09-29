import type { DB } from '../db/connection';
import * as budget from '../modules/budget/budget.service';
import * as actual from '../modules/actual/actual.service';
import * as report from '../modules/report/report.service';
import * as org from '../modules/org/org.service';
import * as account from '../modules/account/account.service';
import * as metric from '../modules/metric/metric.service';
import * as sheet from '../modules/sheet/sheet.service';
import * as calculation from '../modules/calculation/calculation.service';
import * as backup from '../modules/backup/backup.service';
import { queryLogs } from '../modules/audit/log';
import * as imports from '../modules/import/import.service';
import { budgetQualityReport } from '../modules/check/budget-quality';
import { budgetProgressReport } from '../modules/budget/progress.service';
import { structureReport } from '../modules/report/structure.service';
import { multiYearTrend, MAX_TREND_YEARS } from '../modules/report/multi-year';
import { dashboardOverview } from '../modules/report/dashboard.service';
import { masterDataHealthReport } from '../modules/check/master-data-health';
import { runConsistencyChecks } from '../modules/check/consistency';
import { listTemplates } from '../modules/io/cleaning/template.service';
import { listAliases } from '../modules/io/cleaning/alias.service';
import type { CleaningTargetKind } from '../modules/io/cleaning/plan';
import type { AliasTargetKind } from '../modules/io/cleaning/alias.service';
import { anomalyReport, type AnomalyInput } from './anomaly';
import { attributionReport, type AttributionInput } from './attribution';
import { cellNotes, type CellNoteQueryInput } from './cell-notes';
import { reportDraft, type ReportDraftInput } from './report-draft';
import { importHelpReport, type ImportHelpInput } from './import-help';
import { GLOSSARY, explainTerms } from './glossary';
import { navigationCatalog } from './navigation';
import {
  financeConversionDetail, financeConversionList, financeMappingVersionDetail,
  financeMappingVersionList, financeParallelTrialList, financeSourceProfileList,
} from './finance';
import { budgetCellEvidence, actualCellEvidence, metricEvidence } from '../modules/evidence/evidence.service';
import { insightRowsFilter } from './ownership';
import { authorizeToolCall, orgTreeFilter } from './tool-policy';

const rawTools = {
  get_org_tree: (db: DB) => org.getOrgTree(db, orgTreeFilter(db)),
  get_account_tree: (db: DB) => account.getAccountTree(db),
  list_budget_versions: (db: DB, year?: number) => budget.listVersions(db, year),
  get_budget_matrix: (db: DB, versionId: number) => budget.getEditMatrix(db, versionId),
  get_budget_cell_history: (db: DB, versionId: number, orgId: number, accountId: number) => budget.getBudgetCellHistory(db, versionId, orgId, accountId),
  get_actual_snapshot: (db: DB, batchId: number) => ({ batch: actual.getBatch(db, batchId), entries: actual.getBatchEntries(db, batchId) }),
  list_actual_snapshots: (db: DB, year?: number) => actual.listBatches(db, year),
  calculate_execution: (db: DB, input: report.CompletionInput) => report.completionReport(db, input),
  calculate_trend: (db: DB, input: Parameters<typeof report.yearTrend>[1]) => report.yearTrend(db, input),
  calculate_variance: (db: DB, baseVersionId: number, targetVersionId: number) => report.versionCompare(db, baseVersionId, targetVersionId),
  calculate_accuracy: (db: DB, year: number) => report.accuracyReport(db, year),
  get_historical_comparison: (db: DB) => report.historicalComparison(db),
  get_budget_quality: (db: DB, versionId: number) => budgetQualityReport(db, versionId),
  /** 方案 4.2 七类异常与质量检查,全部由后端确定性计算 */
  calculate_anomalies: (db: DB, input: AnomalyInput) => anomalyReport(db, input),
  /** 方案 4.3 差异归因:按组织、科目和方向排序,支持逐层展开 */
  calculate_attribution: (db: DB, input: AttributionInput) => attributionReport(db, input),
  /** 方案 4.3 报告生成:执行月报 / 年度复盘 / 预算讨论材料(确定性组稿) */
  generate_report: (db: DB, input: ReportDraftInput) => reportDraft(db, input),
  /** 方案 4.1 导入辅助:解释错误、建议组织/科目匹配、列出未匹配和重复项 */
  explain_import: (db: DB, input: ImportHelpInput) => importHelpReport(db, input),
  /** 方案 4.1 业务解释:字段、状态、金额方向、万元/元/分换算、完成率 */
  explain_terms: (_db: DB, query?: string) => {
    const matched = query && String(query).trim() ? explainTerms(String(query), 6) : [];
    return { query: query ?? '', matched, catalog: GLOSSARY.map((entry) => ({ key: entry.key, term: entry.term, category: entry.category })) };
  },
  /** 方案 4.1 页面导航:可跳转页面清单 */
  get_navigation_catalog: (_db: DB) => ({ pages: navigationCatalog() }),
  get_operation_log: (db: DB, opts?: Parameters<typeof queryLogs>[1]) => {
    const result = queryLogs(db, opts);
    return {
      ...result,
      items: result.items.map((item) => ({ ...item, detail_json: redactAuditDetail(item.detail_json) })),
    };
  },
  /** 财务转换(方案《财务实际数自动转换实施方案》):批次列表与闸门结论,只读 */
  list_finance_conversions: (db: DB, limit = 20) => financeConversionList(db, limit),
  /** 财务转换单批次:逐闸门结论与截断后的失败明细,回答「为什么失败」 */
  get_finance_conversion: (db: DB, conversionId: number) => financeConversionDetail(db, conversionId),
  /** 财务转换映射版本列表:状态与锁定信息 */
  list_finance_mapping_versions: (db: DB, sourceProfileId?: number) => financeMappingVersionList(db, sourceProfileId),
  /** 财务转换映射版本详情:规则计数与校验器结论,回答「映射有没有漏的科目/冲突」 */
  get_finance_mapping_version: (db: DB, mappingVersionId: number) => financeMappingVersionDetail(db, mappingVersionId),
  /** 财务转换并行试运行:与原手工结果的逐组合比较结论 */
  list_finance_parallel_trials: (db: DB, conversionId?: number) => financeParallelTrialList(db, conversionId),
  /** 财务数据源:拥有范围与适配器关键配置 */
  list_finance_source_profiles: (db: DB) => financeSourceProfileList(db),
  validate_import: (db: DB, limit = 50) => imports.listBatches(db, limit),
  /** 数字来源穿透(evidence 领域能力):指标 → 公式项 → 预算/实际科目 */
  get_metric_evidence: (db: DB, input: { versionId: number; metricId: number; batchId?: number | null; orgScopeId?: number | null; accountScopeId?: number | null; sheetKey?: string | null }) =>
    metricEvidence(db, {
      versionId: input.versionId, metricId: input.metricId,
      batchId: input.batchId ?? null, orgScopeId: input.orgScopeId ?? null,
      accountScopeId: input.accountScopeId ?? null, sheetKey: input.sheetKey ?? null,
    }),
  /** 单元格来源穿透:预算或实际单元格 → 构成、公式、测算依据与导入原件 */
  get_cell_evidence: (db: DB, input: { source: 'budget' | 'actual'; sourceId: number; accountId: number; orgId?: number | null }) =>
    input.source === 'budget'
      ? budgetCellEvidence(db, input.sourceId, input.accountId, input.orgId ?? undefined)
      : actualCellEvidence(db, input.sourceId, input.accountId, input.orgId ?? undefined),
  /** 单元格备注查询:预算(叶子测算依据+汇总格批注)与实际(当前累计批注)的并集;
   * 按组织/科目子树过滤,回答「这个数的依据是什么」「这个版本有哪些备注」 */
  get_cell_notes: (db: DB, input: CellNoteQueryInput) => cellNotes(db, input),
  get_import_batch: (db: DB, batchId: number) => {
    const row: any = imports.getBatch(db, batchId);
    let summary: unknown = {}; let result: unknown = {};
    try { summary = JSON.parse(row.summary_json || '{}'); } catch { summary = { invalidJson: true }; }
    try { result = JSON.parse(row.result_json || '{}'); } catch { result = { invalidJson: true }; }
    return { id: row.id, kind: row.kind, status: row.status, targetVersionId: row.target_version_id, history: row.history === 1, originalName: row.original_name, summary, result, createdAt: row.created_at, committedAt: row.committed_at, rolledBackAt: row.rolled_back_at };
  },
  /** 编制进度总览:按叶子组织聚合的覆盖度、质量计数与最近编辑时间 */
  get_budget_progress: (db: DB, versionId: number) => budgetProgressReport(db, versionId),
  /** 结构分析:科目占比,基准口径 parent(父级)/account(指定科目)/metric(指定指标) */
  calculate_structure: (db: DB, input: Parameters<typeof structureReport>[1]) => structureReport(db, input),
  /** 报表指标目录:传 versionId 按该版本绑定的快照口径列出(历史版本不漂移),否则列当前主数据 */
  list_metrics: (db: DB, versionId?: number) => (versionId == null ? metric.listMetrics(db) : metric.listMetricsForVersion(db, versionId)),
  /** 已保存的洞察报告列表(只含标题与时间;明细页签在洞察报告页) */
  list_insights: (db: DB, limit = 20) => listInsightRows(db, limit),
  /** 主数据健康体检:结构完整性、命名一致性、必填缺漏等确定性检查 */
  get_master_data_health: (db: DB) => masterDataHealthReport(db),
  /** 多年趋势:以基准年向前回溯 depth 年,按各年自己的树快照求值,缺失年份如实声明 */
  calculate_multi_year_trend: (db: DB, input: Parameters<typeof multiYearTrend>[1]) => multiYearTrend(db, input),
  /** 一致性检查:实际与快照、树结构等系统级核对(与数据管理页同一信号源) */
  check_consistency: (db: DB) => runConsistencyChecks(db),
  /** 测算模板目录:回答「有哪些测算规则、各算什么」;单格的测算依据穿透走 get_cell_evidence */
  list_calculation_rules: (db: DB, includeInactive = false) => calculation.listRules(db, includeInactive),
  /** 清洗模板目录(清洗导入管道) */
  list_cleaning_templates: (db: DB, targetKind?: CleaningTargetKind) => listTemplates(db, targetKind),
  /** 名称别名目录(清洗导入与财务映射共用) */
  list_cleaning_aliases: (db: DB, filter: { targetKind?: AliasTargetKind; mappingKind?: 'org' | 'account' } = {}) => listAliases(db, filter),
  /** 工作台总览:计数、当前生效版本、年度状态、最近实际批次。不含 recentLogs——日志一律走带脱敏的 get_operation_log */
  get_dashboard_overview: (db: DB) => {
    const { recentLogs: _omit, ...overview } = dashboardOverview(db);
    return overview;
  },
  /** 年度状态:各年度实际数 open/frozen,回答「哪年冻结了、还能不能补录」 */
  get_year_states: (db: DB) => actual.listYearStates(db),
  /** 预设表(工作表)目录:各分析工具的 sheetKey 参数从这里取 */
  list_sheets: (db: DB) => sheet.listSheets(db),
  /** 备份文件列表(只读):名称/大小/时间;创建与恢复不是助手能力 */
  list_backups: (db: DB) => backup.listBackups(backup.backupDirOf(db.name)),
};

/**
 * 对外只暴露经授权包装的工具:executeTool 与 facts.ts 等直接调用点走同一道授权
 * (tool-policy.ts),不存在绕过范围校验的内部入口。
 */
export const tools: typeof rawTools = Object.fromEntries(
  Object.entries(rawTools).map(([name, fn]) => [name, (db: DB, ...args: unknown[]) => (fn as (db: DB, ...rest: unknown[]) => unknown)(db, ...authorizeToolCall(db, name, args))]),
) as typeof rawTools;

/** 与 service.ts insights() 同口径的只读列表;service.ts 依赖本文件,为避免循环依赖在这里直接查表。 */
function listInsightRows(db: DB, limit: number) {
  const owner = insightRowsFilter();
  return db.prepare(`SELECT id,conversation_id,title,created_at FROM ai_insight WHERE ${owner.sql} ORDER BY id DESC LIMIT ?`).all(...owner.params, limit)
    .map((row: any) => ({ id: row.id, conversationId: row.conversation_id, title: row.title, createdAt: row.created_at }));
}

/* 审计 detail_json 的敏感键识别按「子串含敏感语义」脱敏,而非精确键名白名单:
   业务模块可能写 api_key、accessToken、sessionId、userName(驼峰)、clientIp 等变体,
   精确清单(/^(ip|username|…)$/i)会漏掉这些,其值就原样进入模型上下文。
   宁可误伤普通字段(如 token 计数),也不让身份信息出网。 */
const AUDIT_SENSITIVE_KEY = /token|secret|password|authorization|api[-_]?key|credential|session|cookie|user|actor|ip|createdBy|reviewedBy/i;

/** 模型只需要操作类型与业务摘要；登录 IP、用户名、令牌等身份信息永不进入模型上下文。 */
function redactAuditDetail(raw: string): string {
  try {
    const walk = (value: unknown, depth: number): unknown => {
      if (depth > 8 || value == null || typeof value !== 'object') return value;
      if (Array.isArray(value)) return value.slice(0, 100).map((item) => walk(item, depth + 1));
      const out: Record<string, unknown> = {};
      for (const [key, child] of Object.entries(value as Record<string, unknown>)) {
        out[key] = AUDIT_SENSITIVE_KEY.test(key) ? '[已脱敏]' : walk(child, depth + 1);
      }
      return out;
    };
    return JSON.stringify(walk(JSON.parse(raw || '{}'), 0));
  } catch {
    return JSON.stringify({ redacted: true, invalidDetailJson: true });
  }
}

/** OpenAI-compatible function declarations. Keep this list read-only: writes always
 * go through preview/confirm endpoints. */
const schemas: Record<string, any> = {
  list_budget_versions: { type: 'object', properties: { year: { type: 'integer' } }, additionalProperties: false },
  list_actual_snapshots: { type: 'object', properties: { year: { type: 'integer' } }, additionalProperties: false },
  get_budget_matrix: { type: 'object', required: ['versionId'], properties: { versionId: { type: 'integer', minimum: 1 } }, additionalProperties: false },
  get_budget_cell_history: { type: 'object', required: ['versionId', 'orgId', 'accountId'], properties: { versionId: { type: 'integer', minimum: 1 }, orgId: { type: 'integer', minimum: 1 }, accountId: { type: 'integer', minimum: 1 } }, additionalProperties: false },
  get_actual_snapshot: { type: 'object', required: ['batchId'], properties: { batchId: { type: 'integer', minimum: 1 } }, additionalProperties: false },
  calculate_execution: { type: 'object', required: ['versionId'], properties: { versionId: { type: 'integer', minimum: 1 }, batchId: { type: ['integer', 'null'] }, orgScopeId: { type: ['integer', 'null'] }, accountScopeId: { type: ['integer', 'null'] } }, additionalProperties: false },
  calculate_trend: { type: 'object', required: ['year', 'versionId'], properties: { year: { type: 'integer' }, versionId: { type: 'integer', minimum: 1 }, batchId: { type: ['integer', 'null'] }, orgScopeId: { type: ['integer', 'null'] }, accountScopeId: { type: ['integer', 'null'] }, trendKind: { type: 'string', enum: ['metric', 'account', 'composite'], description: '默认 composite 只汇总金额；查单个科目(含数量科目)的趋势必须传 account 并给出 trendId=科目ID' }, trendId: { type: ['integer', 'null'], description: 'trendKind=account 时为科目 ID，=metric 时为报表指标 ID' } }, additionalProperties: false },
  calculate_variance: { type: 'object', required: ['baseVersionId', 'targetVersionId'], properties: { baseVersionId: { type: 'integer', minimum: 1 }, targetVersionId: { type: 'integer', minimum: 1 } }, additionalProperties: false },
  calculate_accuracy: { type: 'object', required: ['year'], properties: { year: { type: 'integer' } }, additionalProperties: false },
  get_budget_quality: { type: 'object', required: ['versionId'], properties: { versionId: { type: 'integer', minimum: 1 } }, additionalProperties: false },
  calculate_anomalies: { type: 'object', required: ['versionId'], properties: { versionId: { type: 'integer', minimum: 1 }, batchId: { type: ['integer', 'null'] }, threshold: { type: 'number', minimum: 0, maximum: 10 }, yoyThreshold: { type: 'number', minimum: 0, maximum: 10 }, peerThreshold: { type: 'number', minimum: 0, maximum: 10 }, orgScopeId: { type: ['integer', 'null'] }, accountScopeId: { type: ['integer', 'null'] } }, additionalProperties: false },
  calculate_attribution: { type: 'object', required: ['versionId'], properties: { versionId: { type: 'integer', minimum: 1 }, batchId: { type: ['integer', 'null'] }, orgScopeId: { type: ['integer', 'null'] }, accountScopeId: { type: ['integer', 'null'] }, sheetKey: { type: ['string', 'null'] }, maxDepth: { type: 'integer', minimum: 1, maximum: 10 }, topN: { type: 'integer', minimum: 1, maximum: 100 }, direction: { type: 'string', enum: ['favorable', 'unfavorable', 'all'] } }, additionalProperties: false },
  generate_report: { type: 'object', required: ['kind'], properties: { kind: { type: 'string', enum: ['monthly_execution', 'annual_review', 'budget_discussion'] }, versionId: { type: ['integer', 'null'] }, year: { type: ['integer', 'null'] }, batchId: { type: ['integer', 'null'] }, targetVersionId: { type: ['integer', 'null'] }, orgScopeId: { type: ['integer', 'null'] }, accountScopeId: { type: ['integer', 'null'] }, sheetKey: { type: ['string', 'null'] }, topN: { type: ['integer', 'null'], minimum: 1, maximum: 50 } }, additionalProperties: false },
  explain_import: { type: 'object', properties: { batchId: { type: ['integer', 'null'] }, suggestionLimit: { type: ['integer', 'null'], minimum: 1, maximum: 20 }, errors: { type: 'array', items: { type: 'object', properties: { row: { type: 'integer' }, field: { type: 'string' }, message: { type: 'string' } } } } }, additionalProperties: false },
  explain_terms: { type: 'object', properties: { query: { type: 'string', maxLength: 500 } }, additionalProperties: false },
  get_navigation_catalog: { type: 'object', additionalProperties: false },
  validate_import: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 500 } }, additionalProperties: false },
  get_import_batch: { type: 'object', required: ['batchId'], properties: { batchId: { type: 'integer', minimum: 1 } }, additionalProperties: false },
  list_finance_conversions: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 100, description: '默认 20，按批次 ID 倒序' } }, additionalProperties: false },
  get_finance_conversion: { type: 'object', required: ['conversionId'], properties: { conversionId: { type: 'integer', minimum: 1 } }, additionalProperties: false },
  list_finance_mapping_versions: { type: 'object', properties: { sourceProfileId: { type: ['integer', 'null'] } }, additionalProperties: false },
  get_finance_mapping_version: { type: 'object', required: ['mappingVersionId'], properties: { mappingVersionId: { type: 'integer', minimum: 1 } }, additionalProperties: false },
  list_finance_parallel_trials: { type: 'object', properties: { conversionId: { type: ['integer', 'null'] } }, additionalProperties: false },
  list_finance_source_profiles: { type: 'object', additionalProperties: false },
  get_operation_log: {
    type: 'object',
    properties: {
      page: { type: 'integer', minimum: 1 },
      pageSize: { type: 'integer', minimum: 1, maximum: 200 },
      action: { type: 'string', maxLength: 80 },
      entityType: { type: 'string', maxLength: 80 },
    },
    additionalProperties: false,
  },
  get_metric_evidence: { type: 'object', required: ['versionId', 'metricId'], properties: { versionId: { type: 'integer', minimum: 1 }, metricId: { type: 'integer', minimum: 1 }, batchId: { type: ['integer', 'null'] }, orgScopeId: { type: ['integer', 'null'] }, accountScopeId: { type: ['integer', 'null'] }, sheetKey: { type: ['string', 'null'] } }, additionalProperties: false },
  get_cell_evidence: { type: 'object', required: ['source', 'sourceId', 'accountId'], properties: { source: { type: 'string', enum: ['budget', 'actual'] }, sourceId: { type: 'integer', minimum: 1 }, accountId: { type: 'integer', minimum: 1 }, orgId: { type: ['integer', 'null'] } }, additionalProperties: false },
  get_cell_notes: {
    type: 'object',
    required: ['source'],
    properties: {
      source: { type: 'string', enum: ['budget', 'actual'], description: 'budget=预算版本(需传 versionId)，actual=实际数(需传 year)' },
      versionId: { type: ['integer', 'null'], minimum: 1, description: 'source=budget 时必填：预算版本 ID' },
      year: { type: ['integer', 'null'], description: 'source=actual 时必填：年度，如 2026' },
      orgId: { type: ['integer', 'null'], minimum: 1, description: '组织 ID 过滤，含其子树内的单元格' },
      accountId: { type: ['integer', 'null'], minimum: 1, description: '科目 ID 过滤，含其子树内的单元格' },
    },
    additionalProperties: false,
  },
  get_budget_progress: { type: 'object', required: ['versionId'], properties: { versionId: { type: 'integer', minimum: 1 } }, additionalProperties: false },
  calculate_structure: { type: 'object', required: ['versionId'], properties: { versionId: { type: 'integer', minimum: 1 }, batchId: { type: ['integer', 'null'] }, orgScopeId: { type: ['integer', 'null'] }, accountScopeId: { type: ['integer', 'null'] }, sheetKey: { type: ['string', 'null'] }, summaryLevel: { type: ['integer', 'null'], minimum: 1, maximum: 20 }, basisMode: { type: ['string', 'null'], enum: ['parent', 'account', 'metric'], description: '占比基准:父级(默认)/指定科目/指定指标' }, basisId: { type: ['integer', 'null'], minimum: 1, description: 'basisMode=account 时为科目 ID,=metric 时为指标 ID' } }, additionalProperties: false },
  list_metrics: { type: 'object', properties: { versionId: { type: ['integer', 'null'], minimum: 1, description: '传版本 ID 时按该版本绑定的快照口径列指标' } }, additionalProperties: false },
  list_insights: { type: 'object', properties: { limit: { type: 'integer', minimum: 1, maximum: 200, description: '默认 20,按 ID 倒序' } }, additionalProperties: false },
  get_master_data_health: { type: 'object', additionalProperties: false },
  calculate_multi_year_trend: { type: 'object', required: ['baseYear'], properties: { baseYear: { type: 'integer', description: '基准年,2000-2100' }, depth: { type: 'integer', minimum: 1, maximum: MAX_TREND_YEARS, description: '含基准年在内的年数,默认 3' }, orgCodes: { type: 'array', items: { type: 'string' }, description: '组织编码过滤,可选' }, accountCodes: { type: 'array', items: { type: 'string' }, description: '科目编码过滤,可选' }, baseBatchId: { type: ['integer', 'null'] }, orgScopeId: { type: ['integer', 'null'] }, accountScopeId: { type: ['integer', 'null'] } }, additionalProperties: false },
  check_consistency: { type: 'object', additionalProperties: false },
  list_calculation_rules: { type: 'object', properties: { includeInactive: { type: 'boolean', description: '默认 false 只列启用中的模板' } }, additionalProperties: false },
  list_cleaning_templates: { type: 'object', properties: { targetKind: { type: ['string', 'null'], enum: ['budget', 'actual-current'] } }, additionalProperties: false },
  list_cleaning_aliases: { type: 'object', properties: { targetKind: { type: ['string', 'null'], enum: ['budget', 'actual-current', 'finance'] }, mappingKind: { type: ['string', 'null'], enum: ['org', 'account'] } }, additionalProperties: false },
  get_dashboard_overview: { type: 'object', additionalProperties: false },
  get_year_states: { type: 'object', additionalProperties: false },
  list_sheets: { type: 'object', additionalProperties: false },
  list_backups: { type: 'object', additionalProperties: false },
};

/**
 * 递归清洗工具 schema，避免出现 Google Gemini API 或代理网关拒绝的非法结构：
 * 1. enum 中不能包含 null（Gemini 等直接返回 400 INVALID_ARGUMENT）；
 * 2. 移除空 enum 等异常字段。
 */
function sanitizeSchema(schema: any): any {
  if (!schema || typeof schema !== 'object') return schema;
  if (Array.isArray(schema)) return schema.map(sanitizeSchema);
  const out: Record<string, any> = {};
  for (const [key, val] of Object.entries(schema)) {
    if (key === 'enum' && Array.isArray(val)) {
      out[key] = val.filter((v) => v !== null && v !== undefined);
    } else if (typeof val === 'object' && val !== null) {
      out[key] = sanitizeSchema(val);
    } else {
      out[key] = val;
    }
  }
  return out;
}

export const toolDefinitions = Object.keys(tools).map((name) => ({
  type: 'function',
  function: {
    name,
    description: `只读查询${name}相关预算事实`,
    parameters: sanitizeSchema(schemas[name] || { type: 'object', additionalProperties: false }),
  },
}));

/** 工具是否声明了某个入参(用于事实来源标注:没有该入参的工具不得贴上下文的版本/批次/年度) */
export function toolAcceptsParam(name: string, param: string): boolean {
  const schema = schemas[name];
  return Boolean(schema?.properties && Object.prototype.hasOwnProperty.call(schema.properties, param));
}

/**
 * 工具的中文名，用于流式进度提示。
 *
 * 实测背景：模型路由要先跑一轮工具调用，首字延迟约 17 秒，界面上只有一个转圈。
 * 把「正在计算差异归因…」这类进度如实播报出来，等待就有了解释。
 */
const TOOL_LABELS: Record<string, string> = {
  get_org_tree: '读取组织树',
  get_account_tree: '读取科目树',
  list_budget_versions: '查询预算版本',
  get_budget_matrix: '读取预算编制矩阵',
  get_actual_snapshot: '读取实际数快照',
  list_actual_snapshots: '查询实际快照批次',
  calculate_execution: '计算预算执行完成情况',
  calculate_trend: '计算年内趋势',
  calculate_variance: '计算版本对比',
  calculate_accuracy: '计算预算准确率',
  get_historical_comparison: '计算历年对比',
  get_budget_quality: '运行预算质量检查',
  calculate_anomalies: '运行异常检查',
  calculate_attribution: '计算差异归因',
  generate_report: '组稿报告',
  explain_import: '诊断导入错误',
  explain_terms: '查询业务口径',
  get_navigation_catalog: '读取页面目录',
  get_operation_log: '查询操作日志',
  validate_import: '查询导入批次',
  get_import_batch: '读取导入批次详情',
  list_finance_conversions: '查询财务转换批次',
  get_finance_conversion: '读取财务转换校验结论',
  list_finance_mapping_versions: '查询财务映射版本',
  get_finance_mapping_version: '读取财务映射校验结论',
  list_finance_parallel_trials: '查询并行试运行结果',
  list_finance_source_profiles: '读取财务数据源配置',
  get_metric_evidence: '穿透指标数字来源',
  get_cell_evidence: '穿透单元格数字来源',
  get_cell_notes: '读取单元格备注',
  get_budget_cell_history: '读取单元格修改记录',
  get_budget_progress: '查询编制进度',
  calculate_structure: '计算结构占比',
  list_metrics: '读取报表指标目录',
  list_insights: '查询已保存的洞察',
  get_master_data_health: '运行主数据体检',
  calculate_multi_year_trend: '计算多年趋势',
  check_consistency: '运行一致性检查',
  list_calculation_rules: '读取测算模板',
  list_cleaning_templates: '读取清洗模板',
  list_cleaning_aliases: '读取名称别名',
  get_dashboard_overview: '读取工作台总览',
  get_year_states: '查询年度状态',
  list_sheets: '读取工作表目录',
  list_backups: '查询备份列表',
};

export function toolLabel(name: string): string {
  return TOOL_LABELS[name] ?? name;
}

export function executeTool(db: DB, name: string, args: any = {}) {
  if (!Object.prototype.hasOwnProperty.call(tools, name)) throw new Error(`未知工具: ${name}`);
  if (!args || typeof args !== 'object' || Array.isArray(args)) args = {};
  const fn = (tools as any)[name];
  if (typeof fn !== 'function') throw new Error(`未知工具: ${name}`);
  // Explicit argument mapping avoids allowing a model to pass the DB handle.
  const integer = (value: unknown, label: string): number => {
    if (typeof value !== 'number' && typeof value !== 'string') throw new Error(`${label}必须是正整数`);
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n <= 0) throw new Error(`${label}必须是正整数`);
    return n;
  };
  const year = (value: unknown): number => {
    if (typeof value !== 'number' && typeof value !== 'string') throw new Error('year必须是 1900-9999 的整数');
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < 1900 || n > 9999) throw new Error('year必须是 1900-9999 的整数');
    return n;
  };
  /** 0~10 的比率(阈值类参数)。 */
  const ratio = (value: unknown, label: string): number => {
    if (typeof value !== 'number' && typeof value !== 'string') throw new Error(`${label}必须是 0-10 的数值`);
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || n > 10) throw new Error(`${label}必须是 0-10 的数值`);
    return n;
  };
  const bounded = (value: unknown, label: string, min: number, max: number): number => {
    if (typeof value !== 'number' && typeof value !== 'string') throw new Error(`${label}必须是 ${min}-${max} 的整数`);
    const n = Number(value);
    if (!Number.isSafeInteger(n) || n < min || n > max) throw new Error(`${label}必须是 ${min}-${max} 的整数`);
    return n;
  };
  const oneOf = (value: unknown, label: string, allowed: string[]): string => {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!allowed.includes(text)) throw new Error(`${label}必须是 ${allowed.join('、')} 之一`);
    return text;
  };
  /**
   * 四个重型分析工具的公共范围参数白名单。
   *
   * 原来这几个 case 用 `{ ...args, versionId, batchId }` 把模型给的任意属性透传给
   * 业务 service：`sheetKey` 可能是对象、`threshold` 可能是字符串，全靠下游巧合不炸。
   * 与同文件 get_operation_log / 财务转换工具的口径统一成显式白名单。
   */
  const analysisScopeArgs = (raw: any): { batchId: number | null; orgScopeId: number | null; accountScopeId: number | null; sheetKey?: string; summaryLevel?: number } => ({
    batchId: raw.batchId == null ? null : integer(raw.batchId, 'batchId'),
    orgScopeId: raw.orgScopeId == null ? null : integer(raw.orgScopeId, 'orgScopeId'),
    accountScopeId: raw.accountScopeId == null ? null : integer(raw.accountScopeId, 'accountScopeId'),
    ...(raw.sheetKey == null ? {} : { sheetKey: (() => { if (typeof raw.sheetKey !== 'string') throw new Error('sheetKey必须是字符串'); return raw.sheetKey.slice(0, 80); })() }),
    ...(raw.summaryLevel == null ? {} : { summaryLevel: bounded(raw.summaryLevel, 'summaryLevel', 1, 20) }),
  });
  switch (name) {
    case 'get_org_tree': case 'get_account_tree': case 'validate_import': case 'get_navigation_catalog': {
      if (name !== 'validate_import') return fn(db);
      const limit = args.limit == null ? 50 : Number(args.limit);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 500) throw new Error('limit必须是 1-500 的整数');
      return fn(db, limit);
    }
    // 无参只读工具:模型给的任何参数都直接忽略,不透传。
    case 'get_master_data_health': case 'check_consistency': case 'get_dashboard_overview':
    case 'get_year_states': case 'list_sheets': case 'list_backups':
    case 'get_historical_comparison': return fn(db);
    case 'explain_terms': {
      if (args.query != null && typeof args.query !== 'string') throw new Error('query必须是字符串');
      const query = args.query == null ? '' : String(args.query).slice(0, 500);
      return fn(db, query);
    }
    case 'list_budget_versions': case 'list_actual_snapshots': return fn(db, args.year == null ? undefined : year(args.year));
    case 'get_budget_matrix': return fn(db, integer(args.versionId, 'versionId'));
    // 此前落入 default 分支:整个 args 对象被当作 versionId 传给 SQL 绑定,必然抛错,
    // 模型只能拿到 error 而拿不到真实修改记录。
    case 'get_budget_cell_history': return fn(db, integer(args.versionId, 'versionId'), integer(args.orgId, 'orgId'), integer(args.accountId, 'accountId'));
    case 'get_actual_snapshot': return fn(db, integer(args.batchId, 'batchId'));
    case 'calculate_execution': return fn(db, { ...analysisScopeArgs(args), versionId: integer(args.versionId, 'versionId') });
    case 'calculate_trend': {
      // trendKind/trendId 显式白名单：composite 只汇总金额，数量科目趋势必须走 account。
      const trendKind = args.trendKind == null ? null : String(args.trendKind);
      if (trendKind != null && !['metric', 'account', 'composite'].includes(trendKind)) throw new Error('trendKind必须是 metric、account 或 composite');
      if (trendKind === 'account' || trendKind === 'metric') {
        if (args.trendId == null) throw new Error(`trendKind=${trendKind} 时必须提供 trendId`);
      }
      return fn(db, {
        year: year(args.year),
        versionId: integer(args.versionId, 'versionId'),
        batchId: args.batchId == null ? null : integer(args.batchId, 'batchId'),
        orgScopeId: args.orgScopeId == null ? null : integer(args.orgScopeId, 'orgScopeId'),
        accountScopeId: args.accountScopeId == null ? null : integer(args.accountScopeId, 'accountScopeId'),
        ...(trendKind == null ? {} : { trendKind: trendKind as 'metric' | 'account' | 'composite' }),
        ...(args.trendId == null ? {} : { trendId: integer(args.trendId, 'trendId') }),
      });
    }
    case 'calculate_variance': return fn(db, integer(args.baseVersionId, 'baseVersionId'), integer(args.targetVersionId, 'targetVersionId'));
    case 'calculate_accuracy': return fn(db, year(args.year));
    case 'get_budget_quality': return fn(db, integer(args.versionId, 'versionId'));
    case 'calculate_anomalies': return fn(db, {
      ...analysisScopeArgs(args),
      versionId: integer(args.versionId, 'versionId'),
      ...(args.threshold == null ? {} : { threshold: ratio(args.threshold, 'threshold') }),
      ...(args.yoyThreshold == null ? {} : { yoyThreshold: ratio(args.yoyThreshold, 'yoyThreshold') }),
      ...(args.peerThreshold == null ? {} : { peerThreshold: ratio(args.peerThreshold, 'peerThreshold') }),
    });
    case 'calculate_attribution': return fn(db, {
      ...analysisScopeArgs(args),
      versionId: integer(args.versionId, 'versionId'),
      ...(args.maxDepth == null ? {} : { maxDepth: bounded(args.maxDepth, 'maxDepth', 1, 10) }),
      ...(args.topN == null ? {} : { topN: bounded(args.topN, 'topN', 1, 100) }),
      ...(args.direction == null ? {} : { direction: oneOf(args.direction, 'direction', ['favorable', 'unfavorable', 'all']) as 'favorable' | 'unfavorable' | 'all' }),
    });
    case 'generate_report': return fn(db, {
      ...analysisScopeArgs(args),
      kind: oneOf(args.kind, 'kind', ['monthly_execution', 'annual_review', 'budget_discussion']) as 'monthly_execution' | 'annual_review' | 'budget_discussion',
      versionId: args.versionId == null ? null : integer(args.versionId, 'versionId'),
      targetVersionId: args.targetVersionId == null ? null : integer(args.targetVersionId, 'targetVersionId'),
      year: args.year == null ? null : year(args.year),
      ...(args.topN == null ? {} : { topN: bounded(args.topN, 'topN', 1, 50) }),
    });
    case 'explain_import': return fn(db, {
      batchId: args.batchId == null ? null : integer(args.batchId, 'batchId'),
      errors: Array.isArray(args.errors) ? args.errors : undefined,
      suggestionLimit: args.suggestionLimit == null ? null : integer(args.suggestionLimit, 'suggestionLimit'),
    });
    case 'get_operation_log': {
      // 显式白名单：不把模型给的任意对象透传进 queryLogs。
      const opts: { page?: number; pageSize?: number; action?: string; entityType?: string } = {};
      if (args.page != null) {
        const page = Number(args.page);
        if (!Number.isSafeInteger(page) || page < 1) throw new Error('page必须是正整数');
        opts.page = page;
      }
      if (args.pageSize != null) {
        const pageSize = Number(args.pageSize);
        if (!Number.isSafeInteger(pageSize) || pageSize < 1 || pageSize > 200) throw new Error('pageSize必须是 1-200 的整数');
        opts.pageSize = pageSize;
      }
      if (args.action != null) {
        if (typeof args.action !== 'string') throw new Error('action必须是字符串');
        opts.action = args.action.slice(0, 80);
      }
      if (args.entityType != null) {
        if (typeof args.entityType !== 'string') throw new Error('entityType必须是字符串');
        opts.entityType = args.entityType.slice(0, 80);
      }
      return fn(db, opts);
    }
    case 'get_import_batch': return fn(db, integer(args.batchId, 'batchId'));
    case 'get_metric_evidence': return fn(db, {
      versionId: integer(args.versionId, 'versionId'),
      metricId: integer(args.metricId, 'metricId'),
      batchId: args.batchId == null ? null : integer(args.batchId, 'batchId'),
      orgScopeId: args.orgScopeId == null ? null : integer(args.orgScopeId, 'orgScopeId'),
      accountScopeId: args.accountScopeId == null ? null : integer(args.accountScopeId, 'accountScopeId'),
      sheetKey: args.sheetKey == null ? null : String(args.sheetKey).slice(0, 80),
    });
    case 'get_cell_evidence': return fn(db, {
      source: oneOf(args.source, 'source', ['budget', 'actual']) as 'budget' | 'actual',
      sourceId: integer(args.sourceId, 'sourceId'),
      accountId: integer(args.accountId, 'accountId'),
      orgId: args.orgId == null ? null : integer(args.orgId, 'orgId'),
    });
    case 'get_cell_notes': return fn(db, {
      source: oneOf(args.source, 'source', ['budget', 'actual']) as 'budget' | 'actual',
      versionId: args.versionId == null ? null : integer(args.versionId, 'versionId'),
      year: args.year == null ? null : year(args.year),
      orgId: args.orgId == null ? null : integer(args.orgId, 'orgId'),
      accountId: args.accountId == null ? null : integer(args.accountId, 'accountId'),
    });
    // 财务转换只读工具：与其余工具一致，参数显式白名单，不透传模型给的任意对象。
    case 'list_finance_conversions': {
      if (args.limit == null) return fn(db, 20);
      const limit = Number(args.limit);
      if (!Number.isSafeInteger(limit) || limit < 1 || limit > 100) throw new Error('limit必须是 1-100 的整数');
      return fn(db, limit);
    }
    case 'get_finance_conversion': return fn(db, integer(args.conversionId, 'conversionId'));
    case 'list_finance_mapping_versions': return fn(db, args.sourceProfileId == null ? undefined : integer(args.sourceProfileId, 'sourceProfileId'));
    case 'get_finance_mapping_version': return fn(db, integer(args.mappingVersionId, 'mappingVersionId'));
    case 'list_finance_parallel_trials': return fn(db, args.conversionId == null ? undefined : integer(args.conversionId, 'conversionId'));
    case 'list_finance_source_profiles': return fn(db);
    case 'get_budget_progress': return fn(db, integer(args.versionId, 'versionId'));
    case 'calculate_structure': return fn(db, {
      ...analysisScopeArgs(args),
      versionId: integer(args.versionId, 'versionId'),
      ...(args.basisMode == null ? {} : { basisMode: oneOf(args.basisMode, 'basisMode', ['parent', 'account', 'metric']) as 'parent' | 'account' | 'metric' }),
      ...(args.basisId == null ? {} : { basisId: integer(args.basisId, 'basisId') }),
    });
    case 'list_metrics': return fn(db, args.versionId == null ? undefined : integer(args.versionId, 'versionId'));
    case 'list_insights': return fn(db, args.limit == null ? 20 : bounded(args.limit, 'limit', 1, 200));
    case 'calculate_multi_year_trend': {
      const codeList = (value: unknown, label: string): string[] | undefined => {
        if (value == null) return undefined;
        if (!Array.isArray(value) || value.length > 100) throw new Error(`${label}必须是不超过 100 项的编码数组`);
        return value.map((item) => {
          if (typeof item !== 'string' || !item.trim()) throw new Error(`${label}必须是不超过 100 项的编码数组`);
          return item.trim().slice(0, 40);
        });
      };
      const orgCodes = codeList(args.orgCodes, 'orgCodes');
      const accountCodes = codeList(args.accountCodes, 'accountCodes');
      return fn(db, {
        baseYear: year(args.baseYear),
        ...(args.depth == null ? {} : { depth: bounded(args.depth, 'depth', 1, MAX_TREND_YEARS) }),
        ...(orgCodes ? { orgCodes } : {}),
        ...(accountCodes ? { accountCodes } : {}),
        ...(args.baseBatchId == null ? {} : { baseBatchId: integer(args.baseBatchId, 'baseBatchId') }),
        ...(args.orgScopeId == null ? {} : { orgScopeId: integer(args.orgScopeId, 'orgScopeId') }),
        ...(args.accountScopeId == null ? {} : { accountScopeId: integer(args.accountScopeId, 'accountScopeId') }),
      });
    }
    case 'list_calculation_rules': return fn(db, args.includeInactive === true);
    case 'list_cleaning_templates': return fn(db, args.targetKind == null ? undefined : oneOf(args.targetKind, 'targetKind', ['budget', 'actual-current']) as CleaningTargetKind);
    case 'list_cleaning_aliases': {
      const filter: { targetKind?: AliasTargetKind; mappingKind?: 'org' | 'account' } = {};
      if (args.targetKind != null) filter.targetKind = oneOf(args.targetKind, 'targetKind', ['budget', 'actual-current', 'finance']) as AliasTargetKind;
      if (args.mappingKind != null) filter.mappingKind = oneOf(args.mappingKind, 'mappingKind', ['org', 'account']) as 'org' | 'account';
      return fn(db, filter);
    }
    default:
      /* 不默认透传模型给的任意 JSON 给业务 service:schemas 只用于模型侧声明,
         后端不据此校验,`default: return fn(db, args)` 意味着「新增工具忘了写 case
         就把攻击者可控的对象透传下去」。switch 已覆盖全部已声明工具,落到这里即未映射,
         必须显式拒绝而不是放行。 */
      throw new Error(`工具 ${name} 未配置参数映射,拒绝执行`);
  }
}
