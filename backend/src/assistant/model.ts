/**
 * OpenAI-compatible 模型适配层。模型永远是可选依赖，业务事实查询不依赖它。
 *
 * 提供两种调用方式：
 * - `complete()`：一次性返回，供报告改写、action 参数抽取等不需要流式的场景使用；
 * - `streamChat()`：真流式。逐块转发 `delta.content`，同时按 `index` 累积
 *   `delta.tool_calls` 的分片参数，因此工具调用和正文可以在同一次请求里边出边解析，
 *   不需要「先等完整响应再切片假装流式」。
 */
export interface ToolCall { id?: string; name: string; arguments: Record<string, unknown>; }
export interface ModelInput { messages: any[]; tools?: any[]; signal?: AbortSignal; }
export interface ChatCompletionResult {
  text: string;
  model?: string;
  toolCalls?: ToolCall[];
  /** 供应商返回的 usage(非流式通常有;流式默认没有,由观测层估算) */
  usage?: { promptTokens: number; completionTokens: number };
}
/** 流事件：text 为增量正文，result 为该轮的最终结构化结果(含工具调用)。 */
export type ModelStreamEvent =
  | { type: 'text'; text: string }
  | { type: 'result'; result: ChatCompletionResult };

export interface ChatModel {
  complete(input: ModelInput): Promise<ChatCompletionResult>;
  streamChat(input: ModelInput): AsyncIterable<ModelStreamEvent>;
}

export function aiConfigurationIssue(): string | undefined {
  const baseUrl = (process.env.AI_BASE_URL || process.env.OPENAI_BASE_URL || '').trim();
  if (!baseUrl) return undefined;
  let parsed: URL;
  try { parsed = new URL(baseUrl); } catch { return 'AI_BASE_URL 不是合法 URL'; }
  if (parsed.protocol === 'https:') return undefined;
  if (parsed.protocol !== 'http:') return 'AI_BASE_URL 只允许 https://，或本机 http:// 服务';
  const host = parsed.hostname.toLowerCase();
  const loopback = host === 'localhost' || host === '::1' || /^127(?:\.\d{1,3}){3}$/.test(host);
  const explicitTrustedHttp = process.env.AI_ALLOW_INSECURE_HTTP === '1';
  const testOnlyHost = Boolean(process.env.VITEST) && host.endsWith('.test');
  if (!loopback && !explicitTrustedHttp && !testOnlyHost) {
    return '公网/远程 AI_BASE_URL 必须使用 https://；可信内网 HTTP 需显式设置 AI_ALLOW_INSECURE_HTTP=1';
  }
  return undefined;
}

/** 功能枚举与 ai-channels.service 保持一致(这里不 import 以免模型层反向依赖设置模块)。 */
export type AiFeature = 'chat' | 'narrative' | 'checkpoint_summary' | 'cleaning_suggest' | 'mapping_candidates' | 'master_data_semantic' | 'expense_audit';

/**
 * 库内渠道解析提供者:server 启动后注入(见 server.ts),注入前/测试直连场景返回 null,
 * modelConfig 自动回退 env,行为与渠道功能引入前完全一致。
 */
export type ChannelResolution = {
  primary: { id: number; name: string; base_url: string; api_key: string; model: string; timeout_ms: number; stream: 0 | 1 } | null;
  fallback: { id: number; name: string; base_url: string; api_key: string; model: string; timeout_ms: number; stream: 0 | 1 } | null;
  anyEnabled: boolean;
} | null;
let channelResolver: ((feature: AiFeature | undefined) => ChannelResolution) | null = null;
export function setChannelResolver(resolver: ((feature: AiFeature | undefined) => ChannelResolution) | null): void {
  channelResolver = resolver;
}

/**
 * 解析失败(如测试在直连 EnvChatModel 前已关闭数据库)一律回退 env,
 * 不能让渠道功能成为模型调用的新故障点。
 */
function tryResolve(feature: AiFeature | undefined): ChannelResolution {
  try {
    return channelResolver?.(feature) ?? null;
  } catch {
    return null;
  }
}

export function modelConfig(): { provider: string; model: string; baseUrl: string | undefined; apiKey: string | undefined; timeoutMs: number; totalTimeoutMs: number; stream: boolean } {
  const provider = (process.env.AI_PROVIDER || 'openai-compatible').trim().toLowerCase();
  const model = (process.env.AI_MODEL || process.env.OPENAI_MODEL || 'gpt-4o-mini').trim();
  const issue = aiConfigurationIssue();
  const baseUrl = issue ? undefined : (process.env.AI_BASE_URL || process.env.OPENAI_BASE_URL || '').trim() || undefined;
  const apiKey = issue ? undefined : (process.env.AI_API_KEY || process.env.OPENAI_API_KEY || '').trim() || undefined;
  const rawTimeout = Number(process.env.AI_TIMEOUT_MS || 15_000);
  const timeoutMs = Number.isFinite(rawTimeout) ? Math.min(120_000, Math.max(10, Math.trunc(rawTimeout))) : 15_000;
  /**
   * 整轮上限，与 `AI_TIMEOUT_MS` 分工：
   * - `timeoutMs`：流式请求的「连接/首字」超时，以及流中相邻两块数据之间的空闲超时；
   * - `totalTimeoutMs`：一次请求从发出到读完的总上限，也是非流式请求的唯一期限。
   *
   * 原实现只有一个定时器且覆盖整个流读取周期，`AI_TIMEOUT_MS=15000` 会把任何超过
   * 15 秒的流式回答从中间掐断并报成「AI 模型请求超时」——慢模型或长回答必然中断。
   * 默认取 `max(timeoutMs * 8, 120s)`，可用 `AI_TOTAL_TIMEOUT_MS` 覆盖。
   */
  const rawTotal = Number(process.env.AI_TOTAL_TIMEOUT_MS || 0);
  const totalTimeoutMs = Number.isFinite(rawTotal) && rawTotal > 0
    ? Math.min(1_800_000, Math.max(timeoutMs, Math.trunc(rawTotal)))
    : Math.min(1_800_000, Math.max(timeoutMs * 8, 120_000));
  // 默认开启流式；AI_STREAM=0 可强制退回一次性响应(排查供应商兼容问题时使用)。
  const stream = (process.env.AI_STREAM ?? '1').trim() !== '0';
  return { provider, model, baseUrl, apiKey, timeoutMs, totalTimeoutMs, stream };
}

export interface ResolvedModelConfig extends ReturnType<typeof modelConfig> {
  channelId?: number;
  channelName?: string;
}

/**
 * 按功能解析模型配置(LLM 渠道管理 §7.3):
 * binding.primary(enabled) -> binding.fallback(enabled) -> 任一 enabled 渠道 -> env。
 * 库内渠道优先,AI_* env 降级为无渠道记录时的部署级默认。
 */
export function resolveModelConfig(feature?: AiFeature): ResolvedModelConfig {
  const resolution = tryResolve(feature);
  const channel = resolution?.primary ?? resolution?.fallback ?? null;
  if (channel) {
    const rawTimeout = channel.timeout_ms;
    const timeoutMs = Number.isFinite(rawTimeout) ? Math.min(120_000, Math.max(10, Math.trunc(rawTimeout))) : 15_000;
    const totalTimeoutMs = Math.min(1_800_000, Math.max(timeoutMs * 8, 120_000));
    return {
      provider: 'openai-compatible',
      model: channel.model,
      baseUrl: channel.base_url,
      apiKey: channel.api_key || undefined,
      timeoutMs,
      totalTimeoutMs,
      stream: channel.stream === 1,
      channelId: channel.id,
      channelName: channel.name,
    };
  }
  return modelConfig();
}

/** 主渠道失败(连接失败/超时/5xx)时可重试的备用渠道配置;4xx 不重试由调用方判定。 */
export function resolveFallbackConfig(feature: AiFeature | undefined, primaryChannelId: number | undefined): ResolvedModelConfig | null {
  if (primaryChannelId == null) return null;
  const resolution = tryResolve(feature);
  const fb = resolution?.fallback ?? null;
  if (!fb || fb.id === primaryChannelId) return null;
  const timeoutMs = Number.isFinite(fb.timeout_ms) ? Math.min(120_000, Math.max(10, Math.trunc(fb.timeout_ms))) : 15_000;
  return {
    provider: 'openai-compatible',
    model: fb.model,
    baseUrl: fb.base_url,
    apiKey: fb.api_key || undefined,
    timeoutMs,
    totalTimeoutMs: Math.min(1_800_000, Math.max(timeoutMs * 8, 120_000)),
    stream: fb.stream === 1,
    channelId: fb.id,
    channelName: fb.name,
  };
}

/** 任一启用渠道存在或 env 已配置(渠道管理 §7.3-4:既有降级路径与测试不清库不破)。 */
export function modelConfigured(): boolean {
  const resolution = tryResolve(undefined);
  if (resolution?.anyEnabled) return true;
  return Boolean(modelConfig().baseUrl);
}

function endpointFor(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, '');
  return /\/chat\/completions$/i.test(normalized) ? normalized : `${normalized}/chat/completions`;
}

function parseToolArguments(raw: unknown): Record<string, unknown> {
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) return raw as Record<string, unknown>;
  if (typeof raw !== 'string' || raw.trim() === '') return {};
  try {
    const value = JSON.parse(raw);
    return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : {};
  } catch { return {}; }
}

/** 解析非流式 `choices[0].message`。 */
function parseCompletionPayload(data: any, modelName: string): ChatCompletionResult {
  const message = data?.choices?.[0]?.message;
  if (!message || typeof message !== 'object') throw new Error('AI provider 返回缺少 choices[0].message');
  const calls: ToolCall[] = Array.isArray(message.tool_calls)
    ? message.tool_calls
      .map((call: any) => ({
        id: typeof call?.id === 'string' ? call.id : undefined,
        name: typeof call?.function?.name === 'string' ? call.function.name : '',
        arguments: parseToolArguments(call?.function?.arguments),
      }))
      .filter((call: ToolCall) => call.name)
    : [];
  const usage = data?.usage;
  const promptTokens = Number(usage?.prompt_tokens);
  const completionTokens = Number(usage?.completion_tokens);
  return {
    text: typeof message.content === 'string' ? message.content : '',
    model: modelName,
    toolCalls: calls,
    ...(Number.isSafeInteger(promptTokens) && Number.isSafeInteger(completionTokens) && promptTokens >= 0 && completionTokens >= 0
      ? { usage: { promptTokens, completionTokens } } : {}),
  };
}

function timeoutError(err: unknown, reason?: string | null): Error {
  if ((err as { name?: string })?.name === 'AbortError') {
    if (reason === '客户端已取消请求') {
      const cancelled = new Error(reason);
      cancelled.name = 'AbortError';
      return cancelled;
    }
    return new Error(reason ? `AI 模型请求超时(${reason})` : 'AI 模型请求超时');
  }
  return new Error(`AI 模型请求失败: ${err instanceof Error ? err.message : String(err)}`);
}

async function assertOk(response: Response): Promise<void> {
  if (response.ok) return;
  const detail = typeof (response as any).text === 'function' ? (await (response as any).text().catch(() => '')).slice(0, 300) : '';
  throw new Error(`AI provider returned ${response.status}${detail ? `: ${detail}` : ''}`);
}

/** 流式分片里逐步拼起来的工具调用。arguments 会被切成多段，必须按 index 累积。 */
interface PartialToolCall { id?: string; name: string; args: string; }

function finishPartialCalls(partials: Map<number, PartialToolCall>): ToolCall[] {
  return [...partials.entries()]
    .sort((a, b) => a[0] - b[0])
    .map(([, call]) => ({ id: call.id, name: call.name, arguments: parseToolArguments(call.args) }))
    .filter((call) => call.name);
}

/* ============ 模型调用观测(AC-F21) ============ */

export type ModelCallStatus = 'success' | 'error' | 'timeout' | 'cancelled';

/** 不含提示词/回答正文,只有规模、耗时与错误分类。 */
export interface ModelCallRecord {
  feature: string;
  provider: string;
  model: string;
  channelName: string;
  stream: boolean;
  status: ModelCallStatus;
  errorType: string;
  errorMessage: string;
  fallbackUsed: boolean;
  latencyMs: number;
  promptChars: number;
  completionChars: number;
  promptTokens: number;
  completionTokens: number;
  tokensEstimated: boolean;
  toolCallCount: number;
}

let modelCallRecorder: ((record: ModelCallRecord) => void) | null = null;
/** server 启动后注入落库实现;测试/未注入时不记录。 */
export function setModelCallRecorder(recorder: ((record: ModelCallRecord) => void) | null): void {
  modelCallRecorder = recorder;
}

/** 粗略 token 估算:中日韩字符按 1 个,其余按 4 字符 1 个。仅在供应商未返回 usage 时使用。 */
export function estimateTokens(text: string): number {
  let cjk = 0;
  for (const ch of text) if (/[\u3000-\u9fff\uac00-\ud7af\uf900-\ufaff]/.test(ch)) cjk += 1;
  return cjk + Math.ceil((text.length - cjk) / 4);
}

export function classifyModelError(error: unknown): { status: ModelCallStatus; errorType: string } {
  const name = (error as { name?: string })?.name;
  const message = error instanceof Error ? error.message : String(error);
  if (name === 'AbortError' || /客户端已取消/.test(message)) return { status: 'cancelled', errorType: 'cancelled' };
  if (/超时|timed? ?out/i.test(message)) return { status: 'timeout', errorType: 'timeout' };
  const http = /AI provider returned (\d{3})/.exec(message);
  if (http) return { status: 'error', errorType: http[1].startsWith('4') ? `http_4xx` : 'http_5xx' };
  if (/非法 JSON|缺少 choices|既不是 SSE/.test(message)) return { status: 'error', errorType: 'invalid_response' };
  if (/请求失败|fetch failed|ECONN|ENOTFOUND|EAI_AGAIN/.test(message)) return { status: 'error', errorType: 'network' };
  if (/模型并发已满/.test(message)) return { status: 'error', errorType: 'busy' };
  return { status: 'error', errorType: 'unknown' };
}

function redactModelError(message: string): string {
  return message.replace(/Bearer\s+[\w.~+/=-]+/gi, 'Bearer [redacted]').replace(/sk-[\w-]{6,}/g, 'sk-[redacted]').slice(0, 300);
}

function recordModelCall(
  feature: AiFeature | undefined,
  primary: ResolvedModelConfig,
  input: ModelInput,
  stream: boolean,
  started: number,
  outcome: { result?: ChatCompletionResult; error?: unknown; completionChars?: number },
): void {
  if (!modelCallRecorder) return;
  try {
    const promptText = input.messages.map((m) => (typeof m.content === 'string' ? m.content : JSON.stringify(m.content ?? ''))).join('\n');
    const { result, error } = outcome;
    let status: ModelCallStatus = 'success';
    let errorType = '';
    let errorMessage = '';
    if (error !== undefined) {
      ({ status, errorType } = classifyModelError(error));
      errorMessage = redactModelError(error instanceof Error ? error.message : String(error));
    } else if (!result) {
      status = 'cancelled';
      errorType = 'consumer_stopped';
    }
    const tagged = result?.model ?? '';
    const slash = tagged.indexOf('/');
    const channelName = primary.channelName && slash > 0 ? tagged.slice(0, slash) : (primary.channelName ?? '');
    const fallbackUsed = Boolean(primary.channelName && result && !tagged.startsWith(`${primary.channelName}/`))
      || /备用渠道/.test(errorMessage);
    const completionText = result?.text ?? '';
    const completionChars = outcome.completionChars ?? completionText.length;
    const usage = result?.usage;
    modelCallRecorder({
      feature: feature ?? '',
      provider: primary.provider,
      model: primary.channelName && slash > 0 ? tagged.slice(slash + 1) : (result?.model ?? primary.model),
      channelName,
      stream,
      status,
      errorType,
      errorMessage,
      fallbackUsed,
      latencyMs: Date.now() - started,
      promptChars: promptText.length,
      completionChars,
      promptTokens: usage ? usage.promptTokens : estimateTokens(promptText),
      completionTokens: usage ? usage.completionTokens : result ? estimateTokens(completionText) : Math.ceil(completionChars / 2),
      tokensEstimated: !usage,
      toolCallCount: result?.toolCalls?.length ?? 0,
    });
  } catch {
    /* 观测失败不影响业务调用 */
  }
}

/**
 * 进程内模型外呼并发上限(OPEN-04):超出时立即失败而不是排队,调用方按模型失败降级到规则查询,
 * 避免慢供应商把请求线程和内存堆积起来。默认 4,可用 NEWFC_MODEL_CONCURRENCY 调整。
 */
let activeModelCalls = 0;

export function modelConcurrencyLimit(): number {
  const raw = Number(process.env.NEWFC_MODEL_CONCURRENCY || 4);
  return Number.isInteger(raw) && raw > 0 ? raw : 4;
}

function acquireModelSlot(): () => void {
  const limit = modelConcurrencyLimit();
  if (activeModelCalls >= limit) throw new Error(`模型并发已满(上限 ${limit}),本次改用规则查询`);
  activeModelCalls += 1;
  let released = false;
  return () => {
    if (released) return;
    released = true;
    activeModelCalls -= 1;
  };
}

export class EnvChatModel implements ChatModel {
  /**
   * 构造参数即功能标识(§7.1 枚举),决定走哪个渠道绑定;不传时按 env/任一渠道解析,
   * 行为与渠道功能引入前一致(测试直连 EnvChatModel 的场景不受影响)。
   */
  constructor(private readonly feature?: AiFeature) {}

  /** 一次性调用:真实外呼(已配置模型)时记录观测;未配置时返回模板,不算模型调用。 */
  async complete(input: ModelInput): Promise<ChatCompletionResult> {
    const primary = resolveModelConfig(this.feature);
    if (!primary.baseUrl || input.signal?.aborted) return this.completeInner(input);
    const started = Date.now();
    let release: (() => void) | undefined;
    try {
      release = acquireModelSlot();
      const result = await this.completeInner(input);
      recordModelCall(this.feature, primary, input, false, started, { result, completionChars: result.text.length });
      return result;
    } catch (error) {
      recordModelCall(this.feature, primary, input, false, started, { error });
      throw error;
    } finally {
      release?.();
    }
  }

  /** 流式调用:同样记录观测;调用方提前停止读取(未拿到 result)记为 cancelled。 */
  async *streamChat(input: ModelInput): AsyncIterable<ModelStreamEvent> {
    const primary = resolveModelConfig(this.feature);
    if (!primary.baseUrl || input.signal?.aborted) {
      yield* this.streamChatInner(input);
      return;
    }
    const started = Date.now();
    let result: ChatCompletionResult | undefined;
    let completionChars = 0;
    let error: unknown;
    let release: (() => void) | undefined;
    try {
      release = acquireModelSlot();
      for await (const event of this.streamChatInner(input)) {
        if (event.type === 'text') completionChars += event.text.length;
        else result = event.result;
        yield event;
      }
    } catch (err) {
      error = err;
      throw err;
    } finally {
      release?.();
      recordModelCall(this.feature, primary, input, primary.stream, started, { result, error, completionChars });
    }
  }

  /**
   * 发一次请求，并按三档超时布好定时器。
   *
   * - 连接/首字定时器：流式请求用 `timeoutMs`(响应头很快就该回来)，非流式请求用
   *   `totalTimeoutMs`(供应商要算完整个回答才回头，用首字预算会误杀)；fetch 一
   *   resolve 就解除。
   * - 整轮定时器：一直挂到 `cleanup()`，防止响应体读到一半永久挂住。
   * - `bumpIdle()`：流式读取时每收到一块数据调用一次，重置空闲判定。
   */
  private async post(input: ModelInput, stream: boolean, config: ResolvedModelConfig): Promise<{
    response: Response;
    config: ResolvedModelConfig;
    cleanup: () => void;
    bumpIdle: () => void;
    abortReason: () => string | null;
    /** 硬释放挂起的 body 读取:abort 信号触发时主动 cancel reader(见 streamChat)。 */
    abortSignal: AbortSignal;
  }> {
    if (!config.baseUrl) throw new Error('AI 模型未配置');
    const controller = new AbortController();
    let reason: string | null = null;
    const abortWith = (why: string) => { if (!reason) reason = why; controller.abort(); };
    const externalSignal = input.signal;
    const abortFromCaller = () => abortWith('客户端已取消请求');
    if (externalSignal?.aborted) abortFromCaller();
    else externalSignal?.addEventListener('abort', abortFromCaller, { once: true });
    const connectBudget = stream ? config.timeoutMs : config.totalTimeoutMs;
    let connectTimer: ReturnType<typeof setTimeout> | null = setTimeout(
      () => abortWith(stream ? `等待响应超过 ${connectBudget}ms` : `请求超过 ${connectBudget}ms`),
      connectBudget,
    );
    const totalTimer = setTimeout(() => abortWith(`整轮超过 ${config.totalTimeoutMs}ms`), config.totalTimeoutMs);
    let idleTimer: ReturnType<typeof setTimeout> | null = null;
    const cleanup = () => {
      if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
      if (idleTimer) { clearTimeout(idleTimer); idleTimer = null; }
      clearTimeout(totalTimer);
      externalSignal?.removeEventListener('abort', abortFromCaller);
    };
    const bumpIdle = () => {
      if (idleTimer) clearTimeout(idleTimer);
      idleTimer = setTimeout(() => abortWith(`流式响应空闲超过 ${config.timeoutMs}ms`), config.timeoutMs);
    };
    const headers: Record<string, string> = { 'content-type': 'application/json' };
    if (config.apiKey) headers.authorization = `Bearer ${config.apiKey}`;
    try {
      const response = await fetch(endpointFor(config.baseUrl), {
        method: 'POST',
        headers,
        body: JSON.stringify({
          model: config.model,
          messages: input.messages,
          ...(stream ? { stream: true } : {}),
          ...(input.tools ? { tools: input.tools, tool_choice: 'auto' } : {}),
        }),
        signal: controller.signal,
      });
      // 响应头已到：首字预算作废，后续由空闲/整轮定时器接管。
      if (connectTimer) { clearTimeout(connectTimer); connectTimer = null; }
      return { response, config, cleanup, bumpIdle, abortReason: () => reason, abortSignal: controller.signal };
    } catch (err) {
      cleanup();
      throw timeoutError(err, reason);
    }
  }

  /** 结果 model 字段前加注渠道名(§7.3-3):前端可区分「走了备用渠道」与「模型不可用」。 */
  private static tagModel(config: ResolvedModelConfig, model: string | undefined): string {
    const base = model ?? config.model;
    return config.channelName ? `${config.channelName}/${base}` : base;
  }

  /** 连接失败/超时/5xx 判定(4xx 鉴权/参数错误换渠道大概率同样失败,不重试)。 */
  private static retriable(err: unknown): boolean {
    if ((err as { name?: string })?.name === 'AbortError') return true;
    const message = err instanceof Error ? err.message : String(err);
    if (/AI provider returned (4\d\d)/.test(message)) return false;
    return true;
  }

  private async completeOnce(input: ModelInput, config: ResolvedModelConfig): Promise<ChatCompletionResult> {
    const { response, cleanup, abortReason } = await this.post(input, false, config);
    try {
      await assertOk(response);
      let data: any;
      try { data = await response.json(); } catch (err) {
        if ((err as { name?: string })?.name === 'AbortError') throw timeoutError(err, abortReason());
        throw new Error('AI provider 返回了非法 JSON');
      }
      const parsed = parseCompletionPayload(data, config.model);
      return { ...parsed, model: EnvChatModel.tagModel(config, parsed.model) };
    } catch (err) {
      if ((err as { name?: string })?.name === 'AbortError') throw timeoutError(err, abortReason());
      throw err;
    } finally { cleanup(); }
  }

  private async completeInner(input: ModelInput): Promise<ChatCompletionResult> {
    if (input.signal?.aborted) {
      const error = new Error('客户端已取消请求');
      error.name = 'AbortError';
      throw error;
    }
    const config = resolveModelConfig(this.feature);
    if (!config.baseUrl) {
      const last = input.messages[input.messages.length - 1]?.content ?? '';
      return { text: `已收到请求：${String(last).slice(0, 2_000)}`, model: 'template', toolCalls: [] };
    }
    try {
      return await this.completeOnce(input, config);
    } catch (err) {
      // 主失败自动落备用(§7.3-3):5xx/连接失败/超时重试一次,4xx 不重试。
      if (!EnvChatModel.retriable(err)) throw err;
      const fallback = resolveFallbackConfig(this.feature, config.channelId);
      if (!fallback) throw err;
      try {
        return await this.completeOnce(input, fallback);
      } catch (fallbackErr) {
        // 两渠道都失败时聚合两条原因:只抛主渠道错误会吞掉备用渠道的真实失效信息,排障只能看到一半。
        const primaryMessage = err instanceof Error ? err.message : String(err);
        const fallbackMessage = fallbackErr instanceof Error ? fallbackErr.message : String(fallbackErr);
        throw new Error(`主渠道失败: ${primaryMessage};备用渠道也失败: ${fallbackMessage}`);
      }
    }
  }

  /**
   * 真流式一轮对话。
   *
   * 供应商不支持流式(或返回的是普通 JSON、测试里被 stub 掉 body)时自动按一次性响应解析，
   * 仍然只发一次请求，不会重复计费。
   */
  private async *streamChatInner(input: ModelInput): AsyncIterable<ModelStreamEvent> {
    if (input.signal?.aborted) {
      const error = new Error('客户端已取消请求');
      error.name = 'AbortError';
      throw error;
    }
    let config = resolveModelConfig(this.feature);
    if (!config.baseUrl) {
      const result = await this.completeInner(input);
      if (result.text) yield { type: 'text', text: result.text };
      yield { type: 'result', result };
      return;
    }
    if (!config.stream) {
      const result = await this.completeInner(input);
      if (result.text) yield { type: 'text', text: result.text };
      yield { type: 'result', result };
      return;
    }
    // 建连 + 响应头校验都纳入备用重试作用域:HTTP 5xx 要到 assertOk 才暴露,
    // 只包 post() 会漏掉这类失效。重试发生在首个事件 yield 之前,用户无感知。
    let posted: Awaited<ReturnType<EnvChatModel['post']>>;
    try {
      posted = await this.post(input, true, config);
      await assertOk(posted.response);
    } catch (err) {
      // 主渠道建连失败/超时/5xx:换备用渠道重试一次(4xx 鉴权/参数错换渠道大概率同样失败,不重试)。
      const fallback = EnvChatModel.retriable(err) ? resolveFallbackConfig(this.feature, config.channelId) : null;
      if (!fallback) throw err;
      config = fallback;
      posted = await this.post(input, true, config);
      await assertOk(posted.response);
    }
    const { response, cleanup, bumpIdle, abortReason, abortSignal } = posted;
    /** 产出状态外提:流读取阶段 catch 里判断「零产出才可安全切备用」需要读取这些值。 */
    let sawData = false;
    let text = '';
    const partials = new Map<number, PartialToolCall>();
    /** 挂在 abortSignal 上的硬释放监听器,流式分支创建;非流式分支为 null。finally 统一摘除。 */
    let abortListener: (() => void) | null = null;
    /** 主渠道计时器与 abort 监听器在切备用前必须释放:totalTimer/idleTimer 挂在
     * 事件循环上、监听器挂在 signal 上,带着它们跑备用请求会提前误 abort。 */
    const releasePrimary = () => {
      if (abortListener) abortSignal.removeEventListener('abort', abortListener);
      cleanup();
    };
    try {
      const body: any = (response as any).body;
      if (!body || typeof body.getReader !== 'function') {
        // 兼容不支持流式的供应商与测试替身：按普通 completion 解析同一份响应。
        // 非流式响应体读取整个算一次请求,同纳入备用重试:非法 JSON/结构异常
        // 属于可重试失效,与 complete() 的重试口径一致(5xx/连接类/载荷异常重试,4xx 不重试)。
        const jsonError = await (async () => {
          try {
            const data: any = await response.json();
            return { data, error: null as Error | null };
          } catch { return { data: null, error: new Error('AI provider 返回了非法 JSON') } };
        })();
        if (jsonError.error || !jsonError.data?.choices?.[0]?.message) {
          const err = jsonError.error ?? new Error('AI provider 返回缺少 choices[0].message');
          if (!EnvChatModel.retriable(err)) throw err;
          const fallback = resolveFallbackConfig(this.feature, config.channelId);
          if (!fallback) throw err;
          const retried = await this.completeOnce(input, fallback);
          if (retried.text) yield { type: 'text', text: retried.text };
          yield { type: 'result', result: retried };
          return;
        }
        const result = parseCompletionPayload(jsonError.data, config.model);
        result.model = EnvChatModel.tagModel(config, result.model);
        if (result.text) yield { type: 'text', text: result.text };
        yield { type: 'result', result };
        return;
      }
      const reader = body.getReader();
      /** 挂起读取硬释放:真实 fetch 的 body 会随 signal abort 抛错,但手工构造/某些
       * 运行时的 body 与 signal 无关联,read() 会永久挂起——这里与 abort signal race,
       * 中断时 cancel reader,让上层按超时错误处理(并可切备用渠道)。
       * 监听器整条流只挂一次:abortRead 每读一块都会调用,按块注册会在同一 signal 上
       * 线性累积且从不摘除(abort 不发生时永不释放)。
       * reader 可能没有 cancel 方法(测试替身/部分运行时):同步 TypeError 会发生在
       * 事件监听回调里,任何 .catch 都接不住,必须先判型再调用。 */
      // read() 的 rejection 必须原样上抛:AbortError 走 timeoutError 转成「超时」错误,
      // 而不是被吞成「流正常结束」(会让挂起的流静默返回空结果)。
      const readGuard = (): Promise<IteratorResult<Uint8Array | undefined>> => reader.read();
      let readInterrupt: ((reason: Error) => void) | null = null;
      abortListener = () => {
        try {
          if (typeof reader.cancel === 'function') void reader.cancel().catch(() => undefined);
        } catch { /* cancel 自身同步抛错也不能中断 abort 语义 */ }
        readInterrupt?.(new DOMException('aborted', 'AbortError'));
      };
      abortSignal.addEventListener('abort', abortListener, { once: true });
      const abortRead = (pending: Promise<IteratorResult<Uint8Array | undefined>>) => Promise.race([
        pending,
        new Promise<never>((_, reject) => { readInterrupt = reject; }),
      ]);
      const decoder = new TextDecoder();
      let buffer = '';
      let finished = false;
      /** 是否见过任何 `data:` 行(声明外提,见函数头注释);仅 SSE 数据也按产出计。 */
      /** 仅在还没见到 SSE 数据时累积原文，用于上述回退解析；见到后立即停止累积。 */
      let raw = '';
      const RAW_LIMIT = 1_000_000;
      // SSE 允许 LF、CRLF 和 CR。CRLF 还可能刚好被网络分块切在 `\r|\n`，
      // 因此不能对每个 chunk 单独 replace，否则一行会被误判成一个空行。
      let pendingCarriageReturn = false;
      const normalizeNewlines = (chunk: string, final = false): string => {
        let value = chunk;
        let normalized = '';
        if (pendingCarriageReturn) {
          normalized += '\n';
          if (value.startsWith('\n')) value = value.slice(1);
          pendingCarriageReturn = false;
        }
        if (!final && value.endsWith('\r')) {
          value = value.slice(0, -1);
          pendingCarriageReturn = true;
        }
        normalized += value.replace(/\r\n/g, '\n').replace(/\r/g, '\n');
        if (final && pendingCarriageReturn) {
          normalized += '\n';
          pendingCarriageReturn = false;
        }
        return normalized;
      };
      const processBlock = (block: string): ModelStreamEvent[] => {
        const events: ModelStreamEvent[] = [];
        for (const line of block.split('\n')) {
          if (!line.startsWith('data:')) continue;
          const payload = line.slice(5).trim();
          if (!payload) continue;
          sawData = true;
          if (payload === '[DONE]') { finished = true; continue; }
          let event: any;
          try { event = JSON.parse(payload); } catch { continue; }
          const delta = event?.choices?.[0]?.delta;
          if (!delta) continue;
          if (typeof delta.content === 'string' && delta.content) {
            text += delta.content;
            events.push({ type: 'text', text: delta.content });
          }
          if (Array.isArray(delta.tool_calls)) {
            for (const call of delta.tool_calls) {
              const index = Number.isSafeInteger(call?.index) ? Number(call.index) : 0;
              const existing = partials.get(index) ?? { name: '', args: '' };
              if (typeof call?.id === 'string' && call.id) existing.id = call.id;
              if (typeof call?.function?.name === 'string' && call.function.name) existing.name = call.function.name;
              if (typeof call?.function?.arguments === 'string') existing.args += call.function.arguments;
              partials.set(index, existing);
            }
          }
        }
        return events;
      };
      const drainBlocks = (final = false): ModelStreamEvent[] => {
        const events: ModelStreamEvent[] = [];
        let boundary = buffer.indexOf('\n\n');
        while (boundary >= 0) {
          const block = buffer.slice(0, boundary);
          buffer = buffer.slice(boundary + 2);
          events.push(...processBlock(block));
          boundary = buffer.indexOf('\n\n');
        }
        // SSE 规范要求 EOF 时派发最后一个未以空行结尾的事件。
        if (final && buffer) {
          events.push(...processBlock(buffer));
          buffer = '';
        }
        return events;
      };
      for (;;) {
        // 每次等待下一块数据都重置空闲判定：只要模型还在吐字就不会被超时打断，
        // 真正卡死(相邻两块间隔超过 timeoutMs)才 abort。
        bumpIdle();
        const chunk = await abortRead(readGuard());
        if (chunk.done) break;
        const decoded = decoder.decode(chunk.value, { stream: true });
        buffer += normalizeNewlines(decoded);
        if (!sawData && raw.length < RAW_LIMIT) raw += decoded.slice(0, RAW_LIMIT - raw.length);
        for (const event of drainBlocks()) yield event;
        if (finished) break;
      }
      if (!finished) {
        const decoded = decoder.decode();
        if (!sawData && raw.length < RAW_LIMIT) raw += decoded.slice(0, RAW_LIMIT - raw.length);
        buffer += normalizeNewlines(decoded, true);
        for (const event of drainBlocks(true)) yield event;
      }
      if (!sawData) {
        // 整个响应里没有任何 SSE 数据行：先当成「供应商忽略了 stream:true」按普通
        // completion 解析；既不是 SSE 也不是合法 JSON 时必须显式报错，
        // 否则会静默返回空结果，前端只能看到「模型路由」却拿到确定性文案。
        let data: any;
        let parseFailed = false;
        try { data = JSON.parse(raw.trim()); }
        catch { parseFailed = true; }
        // 载荷级失效(非法 JSON/缺结构)与 complete() 同口径纳入备用重试;
        // 此时一个事件都还没 yield,切换对用户无感知。
        if (parseFailed || !data?.choices?.[0]?.message) {
          const err = parseFailed
            ? new Error('AI provider 返回的既不是 SSE 流也不是合法 JSON')
            : new Error('AI provider 返回缺少 choices[0].message');
          if (!EnvChatModel.retriable(err)) throw err;
          const fallback = resolveFallbackConfig(this.feature, config.channelId);
          if (!fallback) throw err;
          releasePrimary();
          const retried = await this.completeOnce(input, fallback);
          if (retried.text) yield { type: 'text', text: retried.text };
          yield { type: 'result', result: retried };
          return;
        }
        const result = parseCompletionPayload(data, config.model);
        result.model = EnvChatModel.tagModel(config, result.model);
        if (result.text) yield { type: 'text', text: result.text };
        yield { type: 'result', result };
        return;
      }
      yield { type: 'result', result: { text, model: EnvChatModel.tagModel(config, config.model), toolCalls: finishPartialCalls(partials) } };
    } catch (err) {
      // 流读取阶段失效(空闲超时/整轮超时/连接中断):若尚无任何事件产出(零正文零工具调用),
      // 切换备用渠道重试一次是安全的——用户还没看到任何主渠道内容,不存在正文重复;
      // 已产出正文后卡死则维持报错,切备用会把同一段话发两遍。
      const zeroOutput = !sawData && text === '' && partials.size === 0;
      const recovered = zeroOutput && EnvChatModel.retriable(err)
        ? resolveFallbackConfig(this.feature, config.channelId)
        : null;
      if (!recovered) {
        if ((err as { name?: string })?.name === 'AbortError') throw timeoutError(err, abortReason());
        throw err;
      }
      // 注意:此时 yield 仍处于 try 块的事件迭代器协议外——generator catch 分支里允许 yield。
      releasePrimary();
      const retried = await this.completeOnce(input, recovered);
      if (retried.text) yield { type: 'text', text: retried.text };
      yield { type: 'result', result: retried };
      return;
    } finally {
      if (abortListener) abortSignal.removeEventListener('abort', abortListener);
      cleanup();
    }
  }
}
