/**
 * AI 助手 API 客户端(对应 backend/AI_ASSISTANT.md 与 backend/assistant-openapi.json)。
 *
 * 前端只负责展示、交互和调用：不做预算计算、金额转换规则判断、版本状态判断或快照逻辑。
 * 金额字段一律是后端的整数分(利润方向带符号)，展示时用 utils/money 换算成万元。
 */
import { ApiError, api, getToken, handleUnauthorized, request, type RequestOptions } from './client';
import type { AssistantPageContextV2 } from '../assistant/context';

export interface AssistantContext {
  year?: number;
  budgetVersionId?: number;
  targetVersionId?: number;
  actualSnapshotId?: number;
  importBatchId?: number;
  orgId?: number;
  accountId?: number;
  page?: string;
}
export interface AssistantCitation {
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
  field: 'year' | 'budgetVersionId' | 'targetVersionId' | 'actualSnapshotId' | 'orgId' | 'accountId' | 'importBatchId';
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
export interface EffectiveContext {
  pageKey: string;
  pageLabel?: string;
  year?: number;
  budgetVersionId?: number;
  targetVersionId?: number;
  actualSnapshotId?: number;
  importBatchId?: number;
  orgScopeId?: number;
  accountScopeId?: number;
  metricId?: number;
  view?: Record<string, unknown>;
}

export interface ContextTraceEntry {
  field: string;
  value: number | string;
  origin: string;
  reason: string;
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
  resolvedContext: AssistantContext;
  /** 每一项上下文的来源与依据 */
  resolution: ContextResolution[];
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
  /* ===== V2 页面对齐(§9.7)；未携带 pageContext 的旧客户端请求没有这些字段 ===== */
  /** aligned = 已对齐当前页面；explicit_override = 问题覆盖了页面范围；unavailable = 页面范围不可用 */
  contextStatus?: ContextStatus;
  /** 后端实际采用的安全范围 */
  effectiveContext?: EffectiveContext;
  /** 一行范围摘要，例如「年度执行分析 · 2026 年 · 预算 V3 · 江垭电站 · 截至 6 月」 */
  contextSummary?: string;
  contextTrace?: ContextTrace;
  /** 本轮调用的领域能力 */
  capability?: string;
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

/** 去掉空值,避免把 undefined 传给后端 context 校验 */
export function cleanContext(context: AssistantContext): AssistantContext {
  const out: AssistantContext = {};
  for (const [key, value] of Object.entries(context)) {
    if (value === undefined || value === null || value === '') continue;
    (out as Record<string, unknown>)[key] = value;
  }
  return out;
}

export const assistantApi = {
  /**
   * 一次性对话。
   *
   * options.signal 必须支持：非流式路径也要能被「停止生成」中断，否则关掉流式开关后
   * 停止按钮只是把界面上的转圈去掉，请求仍在跑、回调仍会写回已经切走的会话。
   */
  chat: (body: { conversationId?: number; message: string; context?: AssistantContext; pageContext?: AssistantPageContextV2 }, options?: RequestOptions) =>
    request<AssistantChatResponse>('POST', '/assistant/chat', body, options),
  conversations: () => api.get<{ items: AssistantConversation[] }>('/assistant/conversations'),
  conversation: (id: number) =>
    api.get<{ conversation: AssistantConversation; messages: AssistantMessage[] }>(`/assistant/conversations/${id}`),
  /** 会话重命名：标题原本只能取首条消息前缀，长问句在侧栏认不出来 */
  renameConversation: (id: number, title: string) =>
    api.patch<AssistantConversation>(`/assistant/conversations/${id}`, { title }),
  /** 删除会话：消息一起删除，已确认的操作与已保存洞察保留(只解绑) */
  deleteConversation: (id: number) =>
    api.del<{ id: number; deleted: boolean; messageCount: number; pendingActions: number }>(`/assistant/conversations/${id}`),
  preview: (body: { type: string; params: Record<string, unknown>; conversationId?: number; idempotencyKey?: string }) =>
    api.post<AssistantAction>('/assistant/preview', body),
  confirm: (id: number, confirmationToken: string) =>
    api.post<AssistantAction>(`/assistant/actions/${id}/confirm`, { confirmationToken }),
  cancel: (id: number) => api.post<AssistantAction>(`/assistant/actions/${id}/cancel`, {}),
  insights: () => api.get<{ items: AssistantInsightRow[] }>('/assistant/insights'),
  insight: (id: number) => api.get<AssistantInsight>(`/assistant/insights/${id}`),
  deleteInsight: (id: number) => api.del<{ id: number; deleted: boolean }>(`/assistant/insights/${id}`),
  saveInsight: (body: { conversationId?: number; title?: string; kind: InsightKind; params: Record<string, unknown>; note?: string }) =>
    api.post<AssistantInsight>('/assistant/insights', body),
  glossary: (q?: string) =>
    api.get<{ query: string; matched: GlossaryEntry[]; catalog: { key: string; term: string; category: string }[] }>(
      `/assistant/glossary${q ? `?q=${encodeURIComponent(q)}` : ''}`,
    ),
  navigation: () => api.get<{ pages: { page: string; label: string; path: string }[] }>('/assistant/navigation'),
  /** 差异归因(只读):按组织、科目和方向排序,支持逐层展开 */
  attribution: (body: {
    versionId: number; batchId?: number; orgScopeId?: number; accountScopeId?: number;
    sheetKey?: string; maxDepth?: number; topN?: number; direction?: AttributionDirection;
  }) => api.post<AttributionReport>('/assistant/attribution', body),
  /** 报告生成(只读):执行月报 / 年度复盘 / 预算讨论材料 */
  report: (body: {
    kind: ReportKind; versionId?: number; year?: number; batchId?: number;
    targetVersionId?: number; orgScopeId?: number; accountScopeId?: number; sheetKey?: string; topN?: number;
  }) => api.post<ReportDraft>('/assistant/report', body),
  /** 导入辅助(只读):解释错误、建议匹配、列出未匹配与重复项 */
  importHelp: (body: { batchId?: number; errors?: { row: number; field: string; message: string }[]; suggestionLimit?: number }) =>
    api.post<ImportHelpReport>('/assistant/import-help', body),
};

/** 导出 action 确认后下载文件(只有 confirmed 状态可下载) */
export async function downloadActionArtifact(actionId: number, filename: string): Promise<void> {
  const blob = await request<Blob>('GET', `/assistant/actions/${actionId}/download`);
  const url = URL.createObjectURL(blob as Blob);
  const anchor = document.createElement('a');
  anchor.href = url;
  anchor.download = filename;
  anchor.rel = 'noopener';
  document.body.appendChild(anchor);
  anchor.click();
  // 立刻 revoke 会让部分浏览器取消尚未开始的下载，等一拍再释放。
  window.setTimeout(() => {
    anchor.remove();
    URL.revokeObjectURL(url);
  }, 0);
}

/** 稳定序列化：对象键排序后再 JSON，保证同一组参数得到同一个字符串。 */
function stableStringify(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value ?? null) ?? 'null';
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(',')}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`).join(',')}}`;
}

/** FNV-1a + djb2 组合成 64 位十六进制，纯前端用不需要密码学强度。 */
function hash64(text: string): string {
  let fnv = 0x811c9dc5;
  let djb = 5381;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    fnv = (fnv ^ code) >>> 0;
    fnv = (fnv + ((fnv << 1) + (fnv << 4) + (fnv << 7) + (fnv << 8) + (fnv << 24))) >>> 0;
    djb = (((djb << 5) + djb) + code) >>> 0;
  }
  return `${fnv.toString(16).padStart(8, '0')}${djb.toString(16).padStart(8, '0')}`;
}

/**
 * 按「操作类型 + 参数 + 会话」派生幂等键。
 *
 * 原来用 `Date.now()` 拼键：连点两次「创建预览」得到两个不同的键，后端认不出是
 * 同一个请求，于是生成两条 pending 预览和两个确认令牌，幂等等于没有。
 * 改成参数派生后，重复提交同一份参数一定命中同一条 action。
 */
export function previewIdempotencyKey(prefix: string, type: string, params: unknown, conversationId?: number): string {
  return `${prefix}-${type}-${hash64(stableStringify({ type, params, conversationId: conversationId ?? null }))}`;
}

export interface StreamHandlers {
  onToken?: (text: string) => void;
  /** 处理进度(context/routing/tool/fallback/answer/template) */
  onProgress?: (progress: AssistantProgress) => void;
  onDone?: (response: AssistantChatResponse) => void;
  /** 响应头已发出后才发生的服务端错误(SSE 无法再改成 JSON 错误) */
  onError?: (error: { code: string; message: string }) => void;
}

/**
 * SSE 流式对话。使用 fetch + ReadableStream(而不是 EventSource)，
 * 因为需要携带 x-access-token 请求头；结构化结果只取 done 事件。
 * 浏览器不支持流读取时自动退回一次性 POST /chat。
 *
 * 事件：open(连接就绪) → token*(正文增量) → error?(失败原因) → done(完整结构化响应)。
 */
export async function streamChat(
  body: { conversationId?: number; message: string; context?: AssistantContext; pageContext?: AssistantPageContextV2 },
  handlers: StreamHandlers = {},
  signal?: AbortSignal,
): Promise<AssistantChatResponse> {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  const token = getToken();
  if (token) headers['x-access-token'] = token;
  const res = await fetch('/api/assistant/chat/stream', { method: 'POST', headers, body: JSON.stringify(body), signal });
  if (!res.ok) {
    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      const data = await res.json();
      // 流式路径与非流式 request() 对齐:401 清令牌并广播全局登出
      handleUnauthorized(data);
      throw new ApiError(data, res.status);
    }
    throw new Error(`请求失败: HTTP ${res.status}`);
  }
  /**
   * 浏览器不支持流读取时退回一次性 POST /chat。
   *
   * 这里必须**照常回调 onDone**：只 return 结果的话，调用方那一轮 turn 的 pending
   * 永远不会被清掉（正文、口径、引用全部拿不到，界面一直转圈到刷新为止）。
   * 回退请求同样透传 signal，让「停止生成」在这条路径上也真的能中断。
   */
  if (!res.body) {
    const fallback = await assistantApi.chat(body, { signal });
    handlers.onDone?.(fallback);
    return fallback;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';
  let done: AssistantChatResponse | null = null;
  let failure: { code: string; message: string } | null = null;
  for (;;) {
    const chunk = await reader.read();
    if (chunk.done) break;
    buffer += decoder.decode(chunk.value, { stream: true });
    let boundary = buffer.indexOf('\n\n');
    while (boundary >= 0) {
      const block = buffer.slice(0, boundary);
      buffer = buffer.slice(boundary + 2);
      boundary = buffer.indexOf('\n\n');
      let event = 'message';
      const dataLines: string[] = [];
      for (const line of block.split('\n')) {
        if (line.startsWith('event:')) event = line.slice(6).trim();
        else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim());
      }
      if (!dataLines.length) continue;
      let payload: any;
      try { payload = JSON.parse(dataLines.join('\n')); } catch { continue; }
      if (event === 'token' && typeof payload?.text === 'string') handlers.onToken?.(payload.text);
      if (event === 'progress' && typeof payload?.label === 'string') handlers.onProgress?.(payload as AssistantProgress);
      if (event === 'error') {
        failure = { code: String(payload?.code || 'INTERNAL_ERROR'), message: String(payload?.message || '助手请求失败') };
        handlers.onError?.(failure);
      }
      if (event === 'done') {
        if (payload?.failed) continue;
        done = payload as AssistantChatResponse;
        handlers.onDone?.(done);
      }
    }
  }
  if (failure) throw new ApiError({ code: failure.code, message: failure.message }, 500);
  if (!done) throw new Error('AI 助手流式响应缺少 done 事件');
  return done;
}
