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
import type { StatementScope } from '../contracts/statements';
import { easPeriodStatusView, mgmtAlertsView, mgmtSnapshotsView, statementOverviewView } from './finance-data';
import { contractDetailView, contractSummaryView, expenseAuditQueueView, planExecutionOverviewView, projectBudgetSummaryView } from './project-data';
import { feasibilityResultView, forecastRunsView, investmentComparisonView, reportListView, riskSummaryView } from './risk-investment-data';
import { RPT_KINDS, type RptKind } from '../contracts/analysis-reports';
import { crossDomainSearch } from '../modules/search/search.service';
import { SEARCH_TYPES, type SearchType } from '../contracts/search';
import { z } from 'zod';
import { orgTreeFilter } from './tool-policy';
import { defineTools } from './tool-definition';

export const BUDGET_TOOL_DEFINITIONS = defineTools({
  get_org_tree: {
    label: "读取组织树",
    capabilities: ["master_data"], universal: false,
    policy: {"permission":"master:read","scope":"org_tree"},
    schema: z.object({  }).strict(),
    execute: (db: DB, args: any) => {   return org.getOrgTree(db, orgTreeFilter(db)); },
  },
  get_account_tree: {
    label: "读取科目树",
    capabilities: ["master_data"], universal: false,
    policy: {"permission":"master:read","scope":"global"},
    schema: z.object({  }).strict(),
    execute: (db: DB, args: any) => {   return account.getAccountTree(db); },
  },
  list_budget_versions: {
    label: "查询预算版本",
    capabilities: [], universal: true,
    policy: {"permission":"budget:read","scope":"global"},
    schema: z.object({ year: z.number().int().safe().min(1900).max(9999).optional() }).strict(),
    execute: (db: DB, args: any) => { const year = args.year;  return budget.listVersions(db, year); },
  },
  get_budget_matrix: {
    label: "读取预算编制矩阵",
    capabilities: ["budget"], universal: false,
    policy: {"permission":"budget:read","scope":"all_orgs"},
    schema: z.object({ versionId: z.number().int().safe().min(1) }).strict(),
    execute: (db: DB, args: any) => { const versionId = args.versionId;  return budget.getEditMatrix(db, versionId); },
  },
  get_budget_cell_history: {
    label: "读取单元格修改记录",
    capabilities: ["budget"], universal: false,
    policy: {"permission":"budget:read","scope":"org_cell"},
    schema: z.object({ versionId: z.number().int().safe().min(1), orgId: z.number().int().safe().min(1), accountId: z.number().int().safe().min(1) }).strict(),
    execute: (db: DB, args: any) => { const versionId = args.versionId; const orgId = args.orgId; const accountId = args.accountId;  return budget.getBudgetCellHistory(db, versionId, orgId, accountId); },
  },
  get_actual_snapshot: {
    label: "读取实际数快照",
    capabilities: ["actual"], universal: false,
    policy: {"permission":"actual:read","scope":"all_orgs"},
    schema: z.object({ batchId: z.number().int().safe().min(1) }).strict(),
    execute: (db: DB, args: any) => { const batchId = args.batchId;  return ({ batch: actual.getBatch(db, batchId), entries: actual.getBatchEntries(db, batchId) }); },
  },
  list_actual_snapshots: {
    label: "查询实际快照批次",
    capabilities: [], universal: true,
    policy: {"permission":"actual:read","scope":"global"},
    schema: z.object({ year: z.number().int().safe().min(1900).max(9999).optional() }).strict(),
    execute: (db: DB, args: any) => { const year = args.year;  return actual.listBatches(db, year); },
  },
  calculate_execution: {
    label: "计算预算执行完成情况",
    capabilities: ["execution","evidence"], universal: false,
    policy: {"permission":"analysis:read","scope":"org_scope"},
    schema: z.object({ versionId: z.number().int().safe().min(1), batchId: z.number().int().safe().min(1).nullable().optional(), orgScopeId: z.number().int().safe().min(1).nullable().optional(), accountScopeId: z.number().int().safe().min(1).nullable().optional(), sheetKey: z.string().max(80).nullable().optional(), summaryLevel: z.number().int().safe().min(1).max(20).nullable().optional() }).strict(),
    execute: (db: DB, args: any) => { const input = args;  return report.completionReport(db, input); },
  },
  calculate_trend: {
    label: "计算年内趋势",
    capabilities: ["execution","comparison"], universal: false,
    policy: {"permission":"analysis:read","scope":"org_scope"},
    schema: z.object({ year: z.number().int().safe().min(1900).max(9999), versionId: z.number().int().safe().min(1), batchId: z.number().int().safe().min(1).nullable().optional(), orgScopeId: z.number().int().safe().min(1).nullable().optional(), accountScopeId: z.number().int().safe().min(1).nullable().optional(), trendKind: z.enum(["metric","account","composite"]).describe("默认 composite 只汇总金额；查单个科目(含数量科目)的趋势必须传 account 并给出 trendId=科目ID").optional(), trendId: z.number().int().safe().min(1).describe("trendKind=account 时为科目 ID，=metric 时为报表指标 ID").nullable().optional() }).strict(),
    execute: (db: DB, args: any) => { const input = args; if (args.trendKind && args.trendKind !== 'composite' && args.trendId == null) throw new Error('trendId 必须指定'); return report.yearTrend(db, input); },
  },
  calculate_variance: {
    label: "计算版本对比",
    capabilities: ["comparison"], universal: false,
    policy: {"permission":"analysis:read","scope":"all_orgs"},
    schema: z.object({ baseVersionId: z.number().int().safe().min(1), targetVersionId: z.number().int().safe().min(1) }).strict(),
    execute: (db: DB, args: any) => { const baseVersionId = args.baseVersionId; const targetVersionId = args.targetVersionId;  return report.versionCompare(db, baseVersionId, targetVersionId); },
  },
  calculate_accuracy: {
    label: "计算预算准确率",
    capabilities: ["overview","execution"], universal: false,
    policy: {"permission":"analysis:read","scope":"all_orgs"},
    schema: z.object({ year: z.number().int().safe().min(1900).max(9999) }).strict(),
    execute: (db: DB, args: any) => { const year = args.year;  return report.accuracyReport(db, year); },
  },
  get_historical_comparison: {
    label: "计算历年对比",
    capabilities: ["overview","comparison"], universal: false,
    policy: {"permission":"analysis:read","scope":"all_orgs"},
    schema: z.object({  }).strict(),
    execute: (db: DB, args: any) => {   return report.historicalComparison(db); },
  },
  get_budget_quality: {
    label: "运行预算质量检查",
    capabilities: ["budget"], universal: false,
    policy: {"permission":"budget:read","scope":"all_orgs"},
    schema: z.object({ versionId: z.number().int().safe().min(1) }).strict(),
    execute: (db: DB, args: any) => { const versionId = args.versionId;  return budgetQualityReport(db, versionId); },
  },
  calculate_anomalies: {
    label: "运行异常检查",
    capabilities: ["execution"], universal: false,
    policy: {"permission":"analysis:read","scope":"org_scope"},
    schema: z.object({ versionId: z.number().int().safe().min(1), batchId: z.number().int().safe().min(1).nullable().optional(), threshold: z.number().finite().min(0).max(10).optional(), yoyThreshold: z.number().finite().min(0).max(10).optional(), peerThreshold: z.number().finite().min(0).max(10).optional(), orgScopeId: z.number().int().safe().min(1).nullable().optional(), accountScopeId: z.number().int().safe().min(1).nullable().optional(), sheetKey: z.string().max(80).nullable().optional(), summaryLevel: z.number().int().safe().min(1).max(20).nullable().optional() }).strict(),
    execute: (db: DB, args: any) => { const input = args;  return anomalyReport(db, input); },
  },
  calculate_attribution: {
    label: "计算差异归因",
    capabilities: ["execution"], universal: false,
    policy: {"permission":"analysis:read","scope":"org_scope"},
    schema: z.object({ versionId: z.number().int().safe().min(1), batchId: z.number().int().safe().min(1).nullable().optional(), orgScopeId: z.number().int().safe().min(1).nullable().optional(), accountScopeId: z.number().int().safe().min(1).nullable().optional(), sheetKey: z.string().max(80).nullable().optional(), maxDepth: z.number().int().safe().min(1).max(10).optional(), topN: z.number().int().safe().min(1).max(100).optional(), direction: z.enum(["favorable","unfavorable","all"]).optional(), summaryLevel: z.number().int().safe().min(1).max(20).nullable().optional() }).strict(),
    execute: (db: DB, args: any) => { const input = args;  return attributionReport(db, input); },
  },
  generate_report: {
    label: "组稿报告",
    capabilities: ["assistant_content"], universal: false,
    policy: {"permission":"analysis:read","scope":"org_scope"},
    schema: z.object({ kind: z.enum(["monthly_execution","annual_review","budget_discussion"]), versionId: z.number().int().safe().min(1).nullable().optional(), year: z.number().int().safe().min(1900).max(9999).nullable().optional(), batchId: z.number().int().safe().min(1).nullable().optional(), targetVersionId: z.number().int().safe().min(1).nullable().optional(), orgScopeId: z.number().int().safe().min(1).nullable().optional(), accountScopeId: z.number().int().safe().min(1).nullable().optional(), sheetKey: z.string().max(200).nullable().optional(), topN: z.number().int().safe().min(1).max(50).nullable().optional() }).strict(),
    execute: (db: DB, args: any) => { const input = args;  return reportDraft(db, input); },
  },
  explain_import: {
    label: "诊断导入错误",
    capabilities: ["import_conversion"], universal: false,
    policy: {"permission":"import:run","scope":"all_orgs"},
    schema: z.object({ batchId: z.number().int().safe().min(1).nullable().optional(), suggestionLimit: z.number().int().safe().min(1).max(20).nullable().optional(), errors: z.array(z.object({ row: z.number().int().safe().optional(), field: z.string().max(200).optional(), message: z.string().max(200).optional() }).strict()).max(500).optional() }).strict(),
    execute: (db: DB, args: any) => { const input = args;  return importHelpReport(db, input); },
  },
  explain_terms: {
    label: "查询业务口径",
    capabilities: [], universal: true,
    policy: {"permission":"assistant:use","scope":"global"},
    schema: z.object({ query: z.string().max(500).optional() }).strict(),
    execute: (db: DB, args: any) => { const query = args.query;
    const matched = query && String(query).trim() ? explainTerms(String(query), 6) : [];
    return { query: query ?? '', matched, catalog: GLOSSARY.map((entry) => ({ key: entry.key, term: entry.term, category: entry.category })) };
   },
  },
  get_navigation_catalog: {
    label: "读取页面目录",
    capabilities: [], universal: true,
    policy: {"permission":"assistant:use","scope":"global"},
    schema: z.object({  }).strict(),
    execute: (db: DB, args: any) => {   return ({ pages: navigationCatalog() }); },
  },
  get_operation_log: {
    label: "查询操作日志",
    capabilities: ["operations"], universal: false,
    policy: {"permission":"audit:read","scope":"all_orgs"},
    schema: z.object({ page: z.number().int().safe().min(1).optional(), pageSize: z.number().int().safe().min(1).max(200).optional(), action: z.string().max(80).optional(), entityType: z.string().max(80).optional() }).strict(),
    execute: (db: DB, args: any) => { const opts = args;
    const result = queryLogs(db, opts);
    return {
      ...result,
      items: result.items.map((item) => ({ ...item, detail_json: redactAuditDetail(item.detail_json) })),
    };
   },
  },
  list_finance_conversions: {
    label: "查询财务转换批次",
    capabilities: ["import_conversion"], universal: false,
    policy: {"permission":"finance_import:manage","scope":"all_orgs"},
    schema: z.object({ limit: z.number().int().safe().min(1).max(100).describe("默认 20，按批次 ID 倒序").optional() }).strict(),
    execute: (db: DB, args: any) => { const limit = args.limit ?? 20;  return financeConversionList(db, limit); },
  },
  get_finance_conversion: {
    label: "读取财务转换校验结论",
    capabilities: ["import_conversion"], universal: false,
    policy: {"permission":"finance_import:manage","scope":"all_orgs"},
    schema: z.object({ conversionId: z.number().int().safe().min(1) }).strict(),
    execute: (db: DB, args: any) => { const conversionId = args.conversionId;  return financeConversionDetail(db, conversionId); },
  },
  list_finance_mapping_versions: {
    label: "查询财务映射版本",
    capabilities: ["import_conversion"], universal: false,
    policy: {"permission":"finance_import:manage","scope":"all_orgs"},
    schema: z.object({ sourceProfileId: z.number().int().safe().min(1).nullable().optional() }).strict(),
    execute: (db: DB, args: any) => { const sourceProfileId = args.sourceProfileId;  return financeMappingVersionList(db, sourceProfileId); },
  },
  get_finance_mapping_version: {
    label: "读取财务映射校验结论",
    capabilities: ["import_conversion"], universal: false,
    policy: {"permission":"finance_import:manage","scope":"all_orgs"},
    schema: z.object({ mappingVersionId: z.number().int().safe().min(1) }).strict(),
    execute: (db: DB, args: any) => { const mappingVersionId = args.mappingVersionId;  return financeMappingVersionDetail(db, mappingVersionId); },
  },
  list_finance_parallel_trials: {
    label: "查询并行试运行结果",
    capabilities: ["import_conversion"], universal: false,
    policy: {"permission":"finance_import:manage","scope":"all_orgs"},
    schema: z.object({ conversionId: z.number().int().safe().min(1).nullable().optional() }).strict(),
    execute: (db: DB, args: any) => { const conversionId = args.conversionId;  return financeParallelTrialList(db, conversionId); },
  },
  list_finance_source_profiles: {
    label: "读取财务数据源配置",
    capabilities: ["import_conversion"], universal: false,
    policy: {"permission":"finance_import:manage","scope":"all_orgs"},
    schema: z.object({  }).strict(),
    execute: (db: DB, args: any) => {   return financeSourceProfileList(db); },
  },
  validate_import: {
    label: "查询导入批次",
    capabilities: ["import_conversion","operations"], universal: false,
    policy: {"permission":"import:run","scope":"all_orgs"},
    schema: z.object({ limit: z.number().int().safe().min(1).max(500).optional() }).strict(),
    execute: (db: DB, args: any) => { const limit = args.limit ?? 50;  return imports.listBatches(db, limit); },
  },
  get_metric_evidence: {
    label: "穿透指标数字来源",
    capabilities: ["evidence"], universal: false,
    policy: {"permission":"analysis:read","scope":"org_scope"},
    schema: z.object({ versionId: z.number().int().safe().min(1), metricId: z.number().int().safe().min(1), batchId: z.number().int().safe().min(1).nullable().optional(), orgScopeId: z.number().int().safe().min(1).nullable().optional(), accountScopeId: z.number().int().safe().min(1).nullable().optional(), sheetKey: z.string().max(200).nullable().optional() }).strict(),
    execute: (db: DB, args: any) => { const input = args;  return metricEvidence(db, {
      versionId: input.versionId, metricId: input.metricId,
      batchId: input.batchId ?? null, orgScopeId: input.orgScopeId ?? null,
      accountScopeId: input.accountScopeId ?? null, sheetKey: input.sheetKey ?? null,
    }); },
  },
  get_cell_evidence: {
    label: "穿透单元格数字来源",
    capabilities: ["evidence"], universal: false,
    policy: {"permission":"analysis:read","scope":"org_cell"},
    schema: z.object({ source: z.enum(["budget","actual"]), sourceId: z.number().int().safe().min(1), accountId: z.number().int().safe().min(1), orgId: z.number().int().safe().min(1).nullable().optional() }).strict(),
    execute: (db: DB, args: any) => { const input = args;  return input.source === 'budget'
      ? budgetCellEvidence(db, input.sourceId, input.accountId, input.orgId ?? undefined)
      : actualCellEvidence(db, input.sourceId, input.accountId, input.orgId ?? undefined); },
  },
  get_cell_notes: {
    label: "读取单元格备注",
    capabilities: ["budget","actual","evidence"], universal: false,
    policy: {"permission":"analysis:read","scope":"org_cell"},
    schema: z.object({ source: z.enum(["budget","actual"]).describe("budget=预算版本(需传 versionId)，actual=实际数(需传 year)"), versionId: z.number().int().safe().min(1).describe("source=budget 时必填：预算版本 ID").nullable().optional(), year: z.number().int().safe().min(1900).max(9999).describe("source=actual 时必填：年度，如 2026").nullable().optional(), orgId: z.number().int().safe().min(1).describe("组织 ID 过滤，含其子树内的单元格").nullable().optional(), accountId: z.number().int().safe().min(1).describe("科目 ID 过滤，含其子树内的单元格").nullable().optional() }).strict(),
    execute: (db: DB, args: any) => { const input = args;  return cellNotes(db, input); },
  },
  get_import_batch: {
    label: "读取导入批次详情",
    capabilities: ["import_conversion"], universal: false,
    policy: {"permission":"import:run","scope":"all_orgs"},
    schema: z.object({ batchId: z.number().int().safe().min(1) }).strict(),
    execute: (db: DB, args: any) => { const batchId = args.batchId;
    const row: any = imports.getBatch(db, batchId);
    let summary: unknown = {}; let result: unknown = {};
    try { summary = JSON.parse(row.summary_json || '{}'); } catch { summary = { invalidJson: true }; }
    try { result = JSON.parse(row.result_json || '{}'); } catch { result = { invalidJson: true }; }
    return { id: row.id, kind: row.kind, status: row.status, targetVersionId: row.target_version_id, history: row.history === 1, originalName: row.original_name, summary, result, createdAt: row.created_at, committedAt: row.committed_at, rolledBackAt: row.rolled_back_at };
   },
  },
  get_budget_progress: {
    label: "查询编制进度",
    capabilities: ["budget"], universal: false,
    policy: {"permission":"budget:read","scope":"all_orgs"},
    schema: z.object({ versionId: z.number().int().safe().min(1) }).strict(),
    execute: (db: DB, args: any) => { const versionId = args.versionId;  return budgetProgressReport(db, versionId); },
  },
  calculate_structure: {
    label: "计算结构占比",
    capabilities: ["comparison"], universal: false,
    policy: {"permission":"analysis:read","scope":"org_scope"},
    schema: z.object({ versionId: z.number().int().safe().min(1), batchId: z.number().int().safe().min(1).nullable().optional(), orgScopeId: z.number().int().safe().min(1).nullable().optional(), accountScopeId: z.number().int().safe().min(1).nullable().optional(), sheetKey: z.string().max(200).nullable().optional(), summaryLevel: z.number().int().safe().min(1).max(20).nullable().optional(), basisMode: z.enum(["parent","account","metric"]).describe("占比基准:父级(默认)/指定科目/指定指标").nullable().optional(), basisId: z.number().int().safe().min(1).describe("basisMode=account 时为科目 ID,=metric 时为指标 ID").nullable().optional() }).strict(),
    execute: (db: DB, args: any) => { const input = args;  return structureReport(db, input); },
  },
  list_metrics: {
    label: "读取报表指标目录",
    capabilities: ["master_data"], universal: true,
    policy: {"permission":"master:read","scope":"global"},
    schema: z.object({ versionId: z.number().int().safe().min(1).describe("传版本 ID 时按该版本绑定的快照口径列指标").nullable().optional() }).strict(),
    execute: (db: DB, args: any) => { const versionId = args.versionId;  return (versionId == null ? metric.listMetrics(db) : metric.listMetricsForVersion(db, versionId)); },
  },
  list_insights: {
    label: "查询已保存的洞察",
    capabilities: ["assistant_content"], universal: false,
    policy: {"permission":"analysis:read","scope":"all_orgs"},
    schema: z.object({ limit: z.number().int().safe().min(1).max(200).describe("默认 20,按 ID 倒序").optional() }).strict(),
    execute: (db: DB, args: any) => { const limit = args.limit ?? 20;  return listInsightRows(db, limit); },
  },
  get_master_data_health: {
    label: "运行主数据体检",
    capabilities: ["master_data"], universal: false,
    policy: {"permission":"master:read","scope":"all_orgs"},
    schema: z.object({  }).strict(),
    execute: (db: DB, args: any) => {   return masterDataHealthReport(db); },
  },
  calculate_multi_year_trend: {
    label: "计算多年趋势",
    capabilities: ["comparison"], universal: false,
    policy: {"permission":"analysis:read","scope":"org_scope"},
    schema: z.object({ baseYear: z.number().int().safe().min(1900).max(9999).describe("基准年,2000-2100"), depth: z.number().int().safe().min(1).max(10).describe("含基准年在内的年数,默认 3").optional(), orgCodes: z.array(z.string().min(1).max(40)).max(100).optional(), accountCodes: z.array(z.string().min(1).max(40)).max(100).optional(), baseBatchId: z.number().int().safe().min(1).nullable().optional(), orgScopeId: z.number().int().safe().min(1).nullable().optional(), accountScopeId: z.number().int().safe().min(1).nullable().optional() }).strict(),
    execute: (db: DB, args: any) => { const input = args;  return multiYearTrend(db, input); },
  },
  check_consistency: {
    label: "运行一致性检查",
    capabilities: ["operations"], universal: false,
    policy: {"permission":"master:read","scope":"all_orgs"},
    schema: z.object({  }).strict(),
    execute: (db: DB, args: any) => {   return runConsistencyChecks(db); },
  },
  list_calculation_rules: {
    label: "读取测算模板",
    capabilities: ["budget"], universal: false,
    policy: {"permission":"budget:read","scope":"global"},
    schema: z.object({ includeInactive: z.boolean().describe("默认 false 只列启用中的模板").optional() }).strict(),
    execute: (db: DB, args: any) => { const includeInactive = args.includeInactive ?? false;  return calculation.listRules(db, includeInactive); },
  },
  list_cleaning_templates: {
    label: "读取清洗模板",
    capabilities: ["import_conversion"], universal: false,
    policy: {"permission":"import:run","scope":"global"},
    schema: z.object({ targetKind: z.enum(["budget","actual-current"]).nullable().optional() }).strict(),
    execute: (db: DB, args: any) => { const targetKind = args.targetKind;  return listTemplates(db, targetKind); },
  },
  list_cleaning_aliases: {
    label: "读取名称别名",
    capabilities: ["import_conversion"], universal: false,
    policy: {"permission":"import:run","scope":"all_orgs"},
    schema: z.object({ targetKind: z.enum(["budget","actual-current","finance"]).nullable().optional(), mappingKind: z.enum(["org","account"]).nullable().optional() }).strict(),
    execute: (db: DB, args: any) => { const filter = args ?? {};  return listAliases(db, filter); },
  },
  get_dashboard_overview: {
    label: "读取工作台总览",
    capabilities: ["overview"], universal: false,
    policy: {"permission":"dashboard:read","scope":"global"},
    schema: z.object({  }).strict(),
    execute: (db: DB, args: any) => {
    const { recentLogs: _omit, ...overview } = dashboardOverview(db);
    return overview;
   },
  },
  get_year_states: {
    label: "查询年度状态",
    capabilities: ["actual","operations"], universal: false,
    policy: {"permission":"actual:read","scope":"global"},
    schema: z.object({  }).strict(),
    execute: (db: DB, args: any) => {   return actual.listYearStates(db); },
  },
  list_sheets: {
    label: "读取工作表目录",
    capabilities: [], universal: true,
    policy: {"permission":"master:read","scope":"global"},
    schema: z.object({  }).strict(),
    execute: (db: DB, args: any) => {   return sheet.listSheets(db); },
  },
  list_backups: {
    label: "查询备份列表",
    capabilities: ["operations"], universal: false,
    policy: {"permission":"system:backup","scope":"all_orgs"},
    schema: z.object({  }).strict(),
    execute: (db: DB, args: any) => {   return backup.listBackups(backup.backupDirOf(db.name)); },
  },
  eas_period_status: {
    label: "查询 EAS 期间对账状态",
    capabilities: ["finance_data"], universal: false,
    policy: {"permission":"eas:read","scope":"org_scope"},
    schema: z.object({ orgScopeId: z.number().int().safe().min(1).describe("组织 ID;受限账号只有一个授权组织时可省略").nullable().optional(), period: z.string().max(200).regex(/^\d{4}-(?:0[1-9]|1[0-2])$/).describe("期间 YYYY-MM") }).strict(),
    execute: (db: DB, args: any) => { const input = args;  return easPeriodStatusView(db, input); },
  },
  statement_overview: {
    label: "读取财务报表总览",
    capabilities: ["finance_data"], universal: false,
    policy: {"permission":"statements:read","scope":"org_scope"},
    schema: z.object({ orgScopeId: z.number().int().safe().min(1).nullable().optional(), period: z.string().max(200).regex(/^\d{4}-(?:0[1-9]|1[0-2])$/).describe("期间 YYYY-MM,缺省取最新当前批次").nullable().optional(), scope: z.enum(["parent","subsidiary","consolidated"]).nullable().optional() }).strict(),
    execute: (db: DB, args: any) => { const input = args;  return statementOverviewView(db, input); },
  },
  mgmt_metric_snapshots: {
    label: "读取管理会计指标快照",
    capabilities: ["finance_data"], universal: false,
    policy: {"permission":"mgmt:read","scope":"org_scope"},
    schema: z.object({ orgScopeId: z.number().int().safe().min(1).describe("组织 ID(含下级)").nullable().optional(), period: z.string().max(200).regex(/^\d{4}(?:-(?:0[1-9]|1[0-2]))?$/).describe("期间 YYYY 或 YYYY-MM").nullable().optional(), metricId: z.number().int().safe().min(1).nullable().optional() }).strict(),
    execute: (db: DB, args: any) => { const input = args;  return mgmtSnapshotsView(db, input); },
  },
  mgmt_alerts: {
    label: "查询管理会计预警",
    capabilities: ["finance_data"], universal: false,
    policy: {"permission":"mgmt:read","scope":"org_scope"},
    schema: z.object({ orgScopeId: z.number().int().safe().min(1).describe("组织 ID(含下级)").nullable().optional(), status: z.enum(["unclosed","open","acknowledged","closed"]).nullable().optional(), period: z.string().max(200).regex(/^\d{4}(?:-(?:0[1-9]|1[0-2]))?$/).nullable().optional() }).strict(),
    execute: (db: DB, args: any) => { const input = args;  return mgmtAlertsView(db, input); },
  },
  project_budget_summary: {
    label: "读取项目预算汇总",
    capabilities: ["project_data"], universal: false,
    policy: {"permission":"project_budget:read","scope":"org_scope"},
    schema: z.object({ orgScopeId: z.number().int().safe().min(1).describe("组织 ID(含下级)").nullable().optional(), year: z.number().int().safe().min(1900).max(9999).nullable().optional(), period: z.string().max(200).regex(/^\d{4}-(?:0[1-9]|1[0-2])$/).describe("期间 YYYY-MM,缺省取最新当前批次").nullable().optional(), projectId: z.number().int().safe().min(1).nullable().optional() }).strict(),
    execute: (db: DB, args: any) => { const input = args;  return projectBudgetSummaryView(db, input); },
  },
  plan_execution_overview: {
    label: "读取计划执行总览",
    capabilities: ["project_data"], universal: false,
    policy: {"permission":"plan:read","scope":"org_scope"},
    schema: z.object({ orgScopeId: z.number().int().safe().min(1).describe("组织 ID(含下级)").nullable().optional(), year: z.number().int().safe().min(1900).max(9999).describe("计划年度"), asOfPeriod: z.string().max(200).regex(/^\d{4}-(?:0[1-9]|1[0-2])$/).describe("截至期间 YYYY-MM(须在计划年度内),缺省取该年最新激活批次").nullable().optional(), projectId: z.number().int().safe().min(1).nullable().optional() }).strict(),
    execute: (db: DB, args: any) => { const input = args; if (args.asOfPeriod && !args.asOfPeriod.startsWith(`${args.year}-`)) throw new Error('asOfPeriod必须在计划年度内'); return planExecutionOverviewView(db, input); },
  },
  contract_summary: {
    label: "读取合同汇总",
    capabilities: ["project_data"], universal: false,
    policy: {"permission":"contract:read","scope":"org_scope"},
    schema: z.object({ orgScopeId: z.number().int().safe().min(1).describe("组织 ID(含下级)").nullable().optional(), projectId: z.number().int().safe().min(1).nullable().optional() }).strict(),
    execute: (db: DB, args: any) => { const input = args;  return contractSummaryView(db, input); },
  },
  contract_detail: {
    label: "读取合同详情",
    capabilities: ["project_data"], universal: false,
    policy: {"permission":"contract:read","scope":"global"},
    schema: z.object({ contractId: z.number().int().safe().min(1).describe("合同 ID(来自页面或 contract_summary 无法给出时请用户在合同台账中打开)") }).strict(),
    execute: (db: DB, args: any) => { const input = args;  return contractDetailView(db, input); },
  },
  expense_audit_queue: {
    label: "读取费用审核队列",
    capabilities: ["project_data"], universal: false,
    policy: {"permission":"expense:read","scope":"org_scope"},
    schema: z.object({ orgScopeId: z.number().int().safe().min(1).describe("组织 ID(含下级)").nullable().optional() }).strict(),
    execute: (db: DB, args: any) => { const input = args;  return expenseAuditQueueView(db, input); },
  },
  feasibility_result: {
    label: "读取可行性测算结果",
    capabilities: ["risk_investment"], universal: false,
    policy: {"permission":"investment:read","scope":"org_scope"},
    schema: z.object({ orgScopeId: z.number().int().safe().min(1).describe("组织 ID(含下级)").nullable().optional(), projectId: z.number().int().safe().min(1).describe("可研项目 ID").nullable().optional(), scenarioId: z.number().int().safe().min(1).describe("方案 ID,给出时返回该方案全部指标与未通过检查").nullable().optional() }).strict(),
    execute: (db: DB, args: any) => { const input = args;  return feasibilityResultView(db, input); },
  },
  investment_comparison: {
    label: "读取投资控制对比",
    capabilities: ["risk_investment"], universal: false,
    policy: {"permission":"investment:read","scope":"org_scope"},
    schema: z.object({ orgScopeId: z.number().int().safe().min(1).describe("组织 ID(含下级)").nullable().optional(), projectId: z.number().int().safe().min(1).describe("投资控制项目 ID").nullable().optional(), comparisonId: z.number().int().safe().min(1).describe("对比快照 ID,给出时返回快照摘要与超限科目").nullable().optional() }).strict(),
    execute: (db: DB, args: any) => { const input = args;  return investmentComparisonView(db, input); },
  },
  forecast_runs: {
    label: "读取财务预测运行",
    capabilities: ["risk_investment"], universal: false,
    policy: {"permission":"forecast:read","scope":"org_scope"},
    schema: z.object({ orgScopeId: z.number().int().safe().min(1).describe("组织 ID(含下级)").nullable().optional(), modelId: z.number().int().safe().min(1).describe("预测模型 ID,给出时返回版本与运行").nullable().optional() }).strict(),
    execute: (db: DB, args: any) => { const input = args;  return forecastRunsView(db, input); },
  },
  risk_summary: {
    label: "读取风险概况",
    capabilities: ["risk_investment"], universal: false,
    policy: {"permission":"risk:read","scope":"org_scope"},
    schema: z.object({ orgScopeId: z.number().int().safe().min(1).describe("组织 ID(含下级)").nullable().optional(), level: z.enum(["high","medium","low"]).describe("缺省全部等级").optional() }).strict(),
    execute: (db: DB, args: any) => { const input = args;  return riskSummaryView(db, input); },
  },
  report_list: {
    label: "读取分析报告列表",
    capabilities: ["risk_investment"], universal: false,
    policy: {"permission":"report:read","scope":"org_scope"},
    schema: z.object({ orgScopeId: z.number().int().safe().min(1).describe("组织 ID(含下级)").nullable().optional(), kind: z.enum(["monthly_execution","annual_review","budget_discussion","risk_investment"]).describe("缺省全部类型").optional() }).strict(),
    execute: (db: DB, args: any) => { const input = args;  return reportListView(db, input); },
  },
  cross_search: {
    label: "跨域检索",
    capabilities: [], universal: true,
    policy: {"permission":"search:use","scope":"global"},
    schema: z.object({ q: z.string().min(1).max(64).describe("关键词(编码或名称片段,1-64 字)"), types: z.array(z.enum(["project","supplier","contract","expense_claim","project_budget_batch","feasibility_project","investment_project","forecast_model","risk_event","analysis_report","budget_version"])).max(100).describe("限定对象类型,缺省全部有权限的类型").optional() }).strict(),
    execute: (db: DB, args: any) => { const input = args;
    const r = crossDomainSearch(db, { q: input.q, types: input.types, limit: 10 });
    return { ...r, items: r.items.slice(0, 30), note: '编码/名称关键词匹配,不是语义检索;path 为页面路由,可提示用户打开核对' };
   },
  },
});

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
