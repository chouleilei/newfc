import { z } from 'zod';
import type { PageId, DraftKind } from './page-catalog';
export const DOMAIN_ID_FIELDS = ['projectId', 'contractId', 'claimId', 'feasProjectId', 'scenarioId', 'icProjectId', 'comparisonId', 'modelId', 'forecastVersionId', 'forecastRunId', 'riskId', 'reportId', 'standardReportId', 'governanceIssueId', 'mgmtMetricId', 'statementBatchId', 'projectBudgetBatchId', 'planBatchId', 'easBatchId', 'feasReportId', 'jobId'] as const;
export type DomainIdField = typeof DOMAIN_ID_FIELDS[number];
export type DomainContext = Partial<Record<DomainIdField, number>> & { period?: string; periodFrom?: string; periodTo?: string; statementScope?: 'parent' | 'subsidiary' | 'consolidated' };
export interface PageScope extends DomainContext {
  year?: number;
  periodStart?: string;
  periodEnd?: string;
  asOfDate?: string;
  budgetVersionId?: number;
  targetVersionId?: number;
  actualSnapshotId?: number;
  importBatchId?: number;
  orgScopeId?: number;
  accountScopeId?: number;
  metricId?: number;
  insightId?: number;
  conversionId?: number;
  mappingVersionId?: number;
  templateId?: number;
  baseVersionId?: number;
  compareVersionId?: number;
}

export const SCOPE_INT_FIELDS: (keyof PageScope)[] = [
  'budgetVersionId', 'targetVersionId', 'actualSnapshotId', 'importBatchId',
  'orgScopeId', 'accountScopeId', 'metricId', 'insightId', 'conversionId', 'mappingVersionId', 'templateId',
  'baseVersionId', 'compareVersionId', ...DOMAIN_ID_FIELDS,
];
export const SCOPE_TEXT_FIELDS: (keyof PageScope)[] = ['period', 'periodFrom', 'periodTo', 'statementScope'];
export const SCOPE_DATE_FIELDS: (keyof PageScope)[] = ['periodStart', 'periodEnd', 'asOfDate'];
export const PAGE_SCOPE_FIELDS: (keyof PageScope)[] = ['year', ...SCOPE_INT_FIELDS, ...SCOPE_TEXT_FIELDS, ...SCOPE_DATE_FIELDS];

export type SurfaceKind = 'drawer' | 'modal' | 'popover' | 'context_menu';

export interface SurfaceEntityRef {
  entityType: string;
  id: number;
}

export interface SurfaceDescriptor {
  id: string;
  kind: SurfaceKind;
  key: string;
  entity?: SurfaceEntityRef | null;
  parentId?: string | null;
}

export type FocusDescriptor =
  | { kind: 'entity'; entityType: string; id: number }
  | { kind: 'cell'; source: 'budget' | 'actual'; sourceId: number; orgId: number; accountId: number; valueKind?: 'amount' | 'quantity' | 'formula' | 'note' }
  | { kind: 'chart_point'; seriesKey: string; dimensionType: 'org' | 'account' | 'metric' | 'period' | 'version'; dimensionId?: number; period?: string }
  | { kind: 'fact'; factType: 'verification'; ownerKey: string; factKey: string; scopeRef?: Record<string, number | string> }
  | { kind: 'form_field'; formKind: string; field: string };

export type SelectionDescriptor =
  | { mode: 'refs'; refs: SurfaceEntityRef[] }
  | { mode: 'bounds'; bounds: { sheetKey?: string; orgIds?: number[]; accountIds?: number[] } }
  | { mode: 'query'; query: Record<string, string | number | boolean | null> };

export type ConfigDraftOperation = 'create' | 'update' | 'move' | 'status' | 'sheet_create' | 'sheet_update' | 'analyze';
export type CleaningDraftSource = { token: string; sha256: string } | { batchId: number; sha256: string };
export type ConfigDraftBase =
  | { operation: 'create' | 'sheet_create'; clientKey: string }
  | { operation: 'update' | 'move' | 'status' | 'sheet_update'; id: number; updatedAt: string }
  | { operation: 'analyze'; clientKey: string; source: CleaningDraftSource };

export type DraftDescriptor =
  | { kind: 'budget_grid'; base: { versionId: number; revision: number; orgTreeSnapshotId?: number; accountTreeSnapshotId?: number } & Record<string, unknown>; changes: unknown }
  | { kind: 'actual_grid'; base: { year: number; batchId: number | null } & Record<string, unknown>; changes: unknown }
  | { kind: Exclude<DraftKind, 'budget_grid' | 'actual_grid'>; base: ConfigDraftBase & Record<string, unknown>; changes: unknown };

/** 每次 chat / chat/stream 请求携带的页面上下文(§5.1)。 */
export interface AssistantPageContext {
  schemaVersion: 2;
  /** 本轮随机 UUID：关联请求、错误回执与排错定位；不提供幂等去重。 */
  snapshotId: string;
  pageKey: PageId;
  /** 当前路由实例 UUID：前端隔离迟到更新。 */
  routeInstanceId: string;
  /** 当前页面语义状态递增版本。 */
  contextVersion: number;
  scope?: PageScope;
  view?: Record<string, unknown>;
  /** 当前打开的业务浮层，按打开顺序排列(注册顺序即优先顺序)。 */
  surfaces?: SurfaceDescriptor[];
  focus?: FocusDescriptor | null;
  selection?: SelectionDescriptor | null;
  draft?: DraftDescriptor | null;
}

/** 常规上下文最大 64 KiB；带草稿请求草稿部分最大 5 MiB(§5.8)。 */
export const CONTEXT_MAX_BYTES = 64 * 1024;
export const DRAFT_MAX_BYTES = 5 * 1024 * 1024;
export const DRAFT_MAX_CHANGES = 10_000;
export const SELECTION_MAX_REFS = 500;

export interface AssistantCitation {
  period?: string;
  orgScopeId?: number;
  references?: { kind: string; id: number; label: string; path: string; hash?: string }[];
  source: string;
  asOf: string;
  year?: number | null;
  budgetVersionId?: number | null;
  targetVersionId?: number | null;
  actualSnapshotId?: number | null;
  treeSnapshotIds?: { org?: number | null; account?: number | null };
}

export interface AssistantFact {
  type: string;
  data: unknown;
  source: {
    period?: string;
    orgScopeId?: number;
    references?: { kind: string; id: number; label: string; path: string; hash?: string }[];
    year?: number;
    budgetVersionId?: number | null;
    targetVersionId?: number | null;
    actualSnapshotId?: number | null;
    treeSnapshotIds?: { org?: number | null; account?: number | null };
    asOf?: string;
  };
}

export interface AssistantNavigation {
  page: string;
  path: string;
  label: string;
  reason: string;
  params?: Record<string, string | number>;
}

/** 上下文解析来源：请求(下拉框) / 本轮消息 / 上一轮会话 / 数据库默认值 */
export type ResolutionOrigin = 'request' | 'message' | 'conversation' | 'default';

export interface ContextResolution {
  field: 'year' | 'budgetVersionId' | 'targetVersionId' | 'actualSnapshotId' | 'orgScopeId' | 'accountScopeId' | 'importBatchId';
  value: number;
  origin: ResolutionOrigin;
  reason: string;
  label?: string;
}

/**
 * 助手建议的写操作。
 * source=model 表示参数由模型从自然语言抽取，rules 表示关键词兜底；
 * previewable=true 表示参数已通过后端干跑校验，可直接创建预览。
 * 无论哪种来源都不会自动执行，必须由用户确认。
 */
export interface AssistantProposedAction {
  /** true 表示沿用上一轮的操作建议(本轮没有重述写请求)，参数已重新校验 */
  inherited?: boolean;
  type: string;
  params: Record<string, unknown>;
  source: 'model' | 'rules';
  previewable: boolean;
  reason?: string;
  validationMessage?: string;
}

/** 后端实际采用的范围状态(§9.7)。 */
export type ContextStatus = 'aligned' | 'explicit_override' | 'unavailable';

/** 后端实际采用的安全范围(§9.7)：只含后端核验过的字段。 */
export interface AssistantScope extends PageScope { pageKey?: PageId }
export interface EffectiveContext extends AssistantScope {
  pageLabel?: string;
  view?: Record<string, unknown>;
  historical?: boolean;
  reusable?: boolean;
  historicalRange?: unknown;
}

export interface ContextTraceEntry {
  field: string;
  value: number | string;
  origin: string;
  reason: string;
  label?: string;
}

/** 精简 contextTrace(§9.7)：只保留用户能理解和排错需要的信息。 */
export interface ContextTrace {
  used: ContextTraceEntry[];
  /** 被问题明确覆盖的字段和原因，例如「问题指定 2025 年，已覆盖页面的 2026 年」 */
  overrides: { field: string; from: number | string; to: number | string; reason: string }[];
  /** 草稿、无实际数据或范围变化提示 */
  warnings: string[];
}

export interface AssistantChatResponse {
  conversationId: number;
  text: string;
  facts: AssistantFact[];
  citations: AssistantCitation[];
  suggestions: string[];
  action: AssistantProposedAction | null;
  navigation: AssistantNavigation | null;
  /** 后端最终使用的上下文，可用于回填筛选器 */
  /** 每一项上下文的来源与依据 */
  /** model = 模型自主调用只读工具；rules = 关键词兜底 */
  routing: 'model' | 'rules';
  /** 本轮实际生效的模型名；template 表示模型不可用、答案来自后端确定性模板 */
  model: string;
  intents: {
    read: string[];
    write: string[];
    suppressed: string[];
    /** 本轮是纯追问、沿用上一轮的意图；为空表示意图来自本轮消息 */
    inheritedRead?: string[];
  };
  /** 模型不可用时的原因；null 表示无异常 */
  modelError: string | null;
  /**
   * 正文数值与本轮后端事实的核对结果。
   * unverified 表示正文里有数值无法由事实推导(模型转述可能算错)，必须提示用户复核。
   */
  numberCheck?: NumberCheck;
  /** 后端确定性提示(如「聊天里回复确认不会写入」「名称有歧义」)，原样展示 */
  notices?: string[];
  /** 本轮度量：总耗时、模型请求次数与耗时、只读工具调用次数 */
  metrics?: { durationMs: number; modelCalls: number; modelMs: number; toolCalls: number };
  /* ===== 页面范围与来源 ===== */
  /** aligned = 已对齐当前页面；explicit_override = 问题覆盖了页面范围；unavailable = 页面范围不可用 */
  contextStatus: ContextStatus;
  /** 后端实际采用的安全范围 */
  effectiveContext: EffectiveContext;
  /** 一行范围摘要，例如「年度执行分析 · 2026 年 · 预算 V3 · 江垭电站 · 截至 6 月」 */
  contextSummary?: string;
  contextTrace: ContextTrace;
  /** 本轮调用的领域能力 */
  capability?: string | null;
  /** 是否采用草稿、类型、基线与变更数量；不含原值 */
  draftApplied?: { kind: string; baseline: string; changeCount: number; issueCount: number } | null;
}

export interface NumberCheck {
  status: 'ok' | 'unverified' | 'skipped';
  checked: number;
  unverified: string[];
  note: string;
}

/** 流式处理进度：让等待期间有可解释的状态，而不是只有一个转圈 */
export interface AssistantProgress {
  stage: 'context' | 'routing' | 'tool' | 'fallback' | 'answer' | 'template';
  label: string;
  detail?: string;
}

export type AssistantActionStatus = 'pending' | 'confirmed' | 'cancelled' | 'expired';
export type AssistantActionType = 'budget_draft' | 'copy_budget' | 'bulk_adjustment' | 'scenario' | 'basis_text' | 'export';

export interface AssistantAction {
  id: number;
  conversationId: number | null;
  type: AssistantActionType | string;
  status: AssistantActionStatus;
  preview: Record<string, any>;
  expiresAt: string;
  confirmationToken?: string;
  result: any;
}

export interface AssistantConversation {
  id: number;
  title: string;
  created_at: string;
  updated_at: string;
}

export interface AssistantMessage {
  id: number;
  role: 'user' | 'assistant' | 'system';
  content: string;
  model: string | null;
  created_at: string;
  response: Partial<AssistantChatResponse>;
}

export interface AssistantInsightRow {
  id: number;
  conversationId: number | null;
  title: string;
  createdAt: string;
}

export interface AssistantInsight {
  id: number;
  title: string;
  created_at: string;
  result: { kind: string; params: Record<string, unknown>; generatedAt: string; note?: string; summary: any };
  citations: AssistantCitation[];
}

export interface GlossaryEntry {
  key: string;
  term: string;
  category: string;
  text: string;
  examples?: string[];
  reference?: string;
}

export type InsightKind = 'execution' | 'anomalies' | 'attribution' | 'report' | 'trend' | 'accuracy' | 'version_variance' | 'historical_comparison' | 'budget_quality';

/* ============ 差异归因(方案 4.3):按组织、科目和方向排序,支持逐层展开 ============ */

export type AttributionDirection = 'favorable' | 'unfavorable' | 'all';

export interface AttributionNode {
  dimension: 'org' | 'account';
  id: number;
  parentId: number | null;
  code: string;
  name: string;
  level: number;
  isLeaf: boolean;
  type?: string;
  budgetCents: number;
  actualCents: number;
  varianceCents: number;
  favorable: 'favorable' | 'unfavorable' | 'none';
  rate: number | null;
  rateSpecial: string | null;
  progressDeviation: number | null;
  pace: string;
  shareOfParent: number | null;
  shareOfTotal: number | null;
  childrenVarianceCents: number;
  reconciled: boolean;
  hiddenChildCount: number;
  hiddenVarianceCents: number;
  children: AttributionNode[];
}

export interface AttributionLeaf {
  dimension: 'org' | 'account';
  id: number;
  code: string;
  name: string;
  type?: string;
  path: string;
  budgetCents: number;
  actualCents: number;
  varianceCents: number;
  favorable: 'favorable' | 'unfavorable' | 'none';
  rate: number | null;
  rateSpecial: string | null;
  shareOfTotal: number | null;
}

export interface AttributionReport {
  version: { id: number; year: number; name: string; status: string };
  asOfDate: string | null;
  timeProgressValue: number | null;
  actualSource: string;
  actualBatchId: number | null;
  treeBasis: { org: string; account: string };
  scopeBasis: Record<string, unknown>;
  params: { maxDepth: number; topN: number; direction: AttributionDirection };
  totals: { budgetCents: number; actualCents: number; varianceCents: number; favorable: 'favorable' | 'unfavorable' | 'none' };
  byOrg: AttributionNode[];
  byAccount: AttributionNode[];
  rankedOrgLeaves: AttributionLeaf[];
  rankedAccountLeaves: AttributionLeaf[];
  quantityVariances: { accountId: number; code: string; name: string; unit: string; budgetQuantity: number; actualQuantity: number; varianceQuantity: number; rate: number | null }[];
  reconciliation: {
    orgRootVarianceCents: number; accountRootVarianceCents: number;
    orgLeafVarianceCents: number; accountLeafVarianceCents: number;
    matched: boolean; unreconciledNodeCount: number;
  };
  notes: string[];
}

/* ============ 报告生成(方案 4.3):执行月报 / 年度复盘 / 预算讨论材料 ============ */

export type ReportKind = 'monthly_execution' | 'annual_review' | 'budget_discussion';

export interface ReportSection {
  key: string;
  title: string;
  bullets: string[];
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
    versionId: number | null; versionName: string | null; versionStatus: string | null;
    targetVersionId: number | null; actualSource: string | null; actualBatchId: number | null;
    orgScopeId: number | null; accountScopeId: number | null; sheetKey: string | null;
    treeSnapshotIds: { org: number | null; account: number | null };
  };
  sections: ReportSection[];
  facts: AssistantFact[];
  citations: AssistantCitation[];
  narrative: string;
  narrativeSource: 'template' | 'model';
  /** 生成叙述的模型名;template 表示未启用或降级 */
  model: string;
  suggestions: string[];
  notes: string[];
}

/* ============ 导入辅助(方案 4.1):错误解释 + 匹配建议 + 未匹配与重复清单 ============ */

export interface ImportErrorGroup {
  category: string;
  label: string;
  explanation: string;
  fix: string;
  count: number;
  rows: number[];
  samples: { row: number; field: string; message: string }[];
}

export interface ImportMatchCandidate {
  id: number;
  code: string;
  name: string;
  isLeaf: boolean;
  status: string;
  type?: string;
  score: number;
  reason: string;
}

export interface ImportHelpReport {
  batch: {
    id: number; kind: string; status: string; originalName: string; history: boolean;
    targetVersionId: number | null; createdAt: string; committedAt: string | null; rolledBackAt: string | null;
    summary: unknown; result: unknown;
  } | null;
  errorCount: number;
  groups: ImportErrorGroup[];
  unmatched: {
    org: { kind: 'org'; code: string; rows: number[]; candidates: ImportMatchCandidate[] }[];
    account: { kind: 'account'; code: string; rows: number[]; candidates: ImportMatchCandidate[] }[];
  };
  duplicates: { row: number; field: string; message: string; firstRow: number | null }[];
  nextSteps: string[];
  notes: string[];
}


export interface ChatRequest {
  conversationId?: number;
  message: string;
  pageContext: AssistantPageContext;
}
export const chatRequestSchema = z.object({
  conversationId: z.number().int().positive().safe().optional(),
  message: z.string().trim().min(1).max(20_000),
  pageContext: z.unknown().refine((value) => value != null, 'pageContext 必须提供'),
}).strict();
export interface PreviewRequest {
  type: AssistantActionType | string;
  params: Record<string, unknown>;
  conversationId?: number;
  idempotencyKey?: string;
}

export interface AttributionRequest {
  pageContext: AssistantPageContext;
  versionId?: number; batchId?: number; orgScopeId?: number; accountScopeId?: number;
  sheetKey?: string; maxDepth?: number; topN?: number; direction?: AttributionDirection;
}
export interface ReportRequest {
  pageContext: AssistantPageContext;
  kind: ReportKind; versionId?: number; year?: number; batchId?: number;
  targetVersionId?: number; orgScopeId?: number; accountScopeId?: number; sheetKey?: string; topN?: number;
}
export interface ImportHelpRequest {
  pageContext: AssistantPageContext;
  batchId?: number; errors?: { row: number; field: string; message: string }[]; suggestionLimit?: number;
}

export type FactSource = AssistantFact['source'];
