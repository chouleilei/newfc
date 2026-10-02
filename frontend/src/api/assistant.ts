import type { ChatRequest, AttributionRequest, ReportRequest, ImportHelpRequest } from '@contracts/assistant';
import type { AssistantAction, AssistantChatResponse, AssistantConversation, AssistantInsight, AssistantInsightRow, AssistantMessage, AssistantPageContext, AssistantProgress, AssistantScope, AttributionDirection, AttributionReport, DomainContext, GlossaryEntry, ImportHelpReport, InsightKind, ReportDraft, ReportKind } from '@contracts/assistant';
/**
 * AI 助手 API 客户端(对应 backend/AI_ASSISTANT.md 与 backend/assistant-openapi.json)。
 *
 * 前端只负责展示、交互和调用：不做预算计算、金额转换规则判断、版本状态判断或快照逻辑。
 * 经营预算金额是整数分,新领域遵循各自工具/契约的元字符串与显式单位。
 */
import { ApiError, api, assertSessionGeneration, csrfHeaders, getSessionGeneration, handleUnauthorized, request, type RequestOptions } from './client';

/** 去掉空值,避免把 undefined 传给后端 context 校验 */
export function cleanContext(context: AssistantScope): AssistantScope {
  const out: AssistantScope = {};
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
  chat: (body: ChatRequest, options?: RequestOptions) =>
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
  attribution: (body: AttributionRequest) => api.post<AttributionReport>('/assistant/attribution', body),
  /** 报告生成(只读):执行月报 / 年度复盘 / 预算讨论材料 */
  report: (body: ReportRequest) => api.post<ReportDraft>('/assistant/report', body),
  /** 导入辅助(只读):解释错误、建议匹配、列出未匹配与重复项 */
  importHelp: (body: ImportHelpRequest) =>
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
 * 因为需要携带 CSRF 请求头；结构化结果只取 done 事件。
 * 浏览器不支持流读取时自动退回一次性 POST /chat。
 *
 * 事件：open(连接就绪) → token*(正文增量) → error?(失败原因) → done(完整结构化响应)。
 */
export async function streamChat(
  body: ChatRequest,
  handlers: StreamHandlers = {},
  signal?: AbortSignal,
): Promise<AssistantChatResponse> {
  const generation = getSessionGeneration();
  const headers: Record<string, string> = { 'content-type': 'application/json', ...csrfHeaders('POST') };
  const res = await fetch('/api/assistant/chat/stream', { method: 'POST', headers, credentials: 'same-origin', body: JSON.stringify(body), signal });
  try { assertSessionGeneration(generation); } catch (error) {
    await res.body?.cancel().catch(() => undefined);
    throw error;
  }
  if (!res.ok) {
    const contentType = res.headers.get('content-type') ?? '';
    if (contentType.includes('application/json')) {
      const data = await res.json();
      assertSessionGeneration(generation);
      // 流式路径与非流式 request() 对齐:401 清会话并广播全局登出
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
  try {
    for (;;) {
      const chunk = await reader.read();
      assertSessionGeneration(generation);
      if (chunk.done) break;
      buffer += decoder.decode(chunk.value, { stream: true });
      let boundary = buffer.indexOf('\n\n');
      while (boundary >= 0) {
        assertSessionGeneration(generation);
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
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  } finally {
    reader.releaseLock();
  }
  if (failure) throw new ApiError({ code: failure.code, message: failure.message }, 500);
  if (!done) throw new Error('AI 助手流式响应缺少 done 事件');
  return done;
}
