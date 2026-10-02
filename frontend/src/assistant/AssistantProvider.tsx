import { DOMAIN_ID_FIELDS } from './domainContext';
/**
 * AI 助手的全局会话状态(唯一实例)。
 *
 * 为什么要有它：助手现在有两个界面——独立页 /assistant 和全局悬浮小窗「财务助手」。
 * 两边必须共享同一份会话(含进行中的 SSE 流)，否则在小窗里问一半、切到完整页就断了。
 * 因此把原来内嵌在 pages/Assistant.tsx 里的聊天核心整体上移到这里，语义**原样保留**：
 *   1. 切会话 / 新会话前先 abort 在途的流，否则旧流的 onDone 会把 conversationId 拽回去；
 *   2. 每次提问与切会话都让请求世代号 +1，所有 onToken/onProgress/onDone 先比对世代号，
 *      不然旧流会把 token 写进已经换掉的 turn；
 *   3. 卸载时 abort，避免离开界面后流还在读、回调还在 setState。
 *
 * 页面范围(现行 specs/ai.md 页面上下文契约)：
 *   - 业务页面的真实筛选由各页面适配器登记进 AssistantContextRegistry，
 *     发送时 buildSnapshot() 冻结成 AssistantPageContextV2 随请求发出；
 *   - manualContext 只保留在内存里，作为 /assistant 页自身筛选器的状态，
 *     不再持久化到 localStorage、也不再覆盖业务页面(§6)。
 *   - routeContext 由当前路由推导，只作页面适配器登记前的兜底与标签来源。
 */
import {
  createContext, useCallback, useContext, useEffect, useMemo, useRef, useState, type ReactNode,
} from 'react';
import { useLocation } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { message } from 'antd';
import { ApiError, api } from '../api/client';
import {
  assistantApi, cleanContext, streamChat,
  type AssistantChatResponse, type AssistantContext, type AssistantConversation,
  type AssistantInsightRow, type AssistantProgress,
} from '../api/assistant';
import { derivePageContext, type ContextField, type RoutePageInfo } from './pageContext';
import { AssistantRegistryProvider, useAssistantRegistry } from './AssistantContextRegistry';
import { AssistantPageContextV2 } from './context';

export interface VersionRow {
  id: number; year: number; name: string; status: string; is_current: 0 | 1; kind: 'budget' | 'forecast';
}
export interface BatchRow { id: number; snapshot_date: string; revision: number; status: string; year: number }
/** 名称目录行：范围条名称优先显示(UX-26)使用。 */
export interface NameRow { id: number; code: string; name: string }

export interface ChatTurn {
  key: string;
  role: 'user' | 'assistant';
  text: string;
  pending?: boolean;
  response?: AssistantChatResponse;
  model?: string | null;
  createdAt?: string;
  /** 流式等待期间的处理进度(模型路由要先跑工具调用轮，首字可能十几秒才到) */
  progress?: AssistantProgress | null;
  /** 用户主动停止生成 */
  stopped?: boolean;
  /**
   * 发起时的页面身份(UX-26)：回答回来后若用户已切页，界面据它标注
   * 「基于原页面当时的范围」，不让迟到的回答冒充当前对象。
   */
  origin?: { pageKey: string };
}

/** 合并结果：除了最终上下文，还如实标出每个字段的来源，供抽屉渲染徽标。 */
export interface ContextMerge {
  /** 最终发送的上下文(不含 page) */
  context: AssistantContext;
  /** 真正生效的路由推导字段 */
  fromRoute: ContextField[];
  /** 用户手动选择的字段 */
  fromManual: ContextField[];
  /** 与手动年度冲突、因此放弃的路由推导字段 */
  droppedRoute: ContextField[];
}

interface AssistantValue {
  /* 会话 */
  turns: ChatTurn[];
  conversationId?: number;
  sending: boolean;
  send: (text: string) => Promise<void>;
  stopGenerating: () => void;
  openConversation: (id: number) => Promise<void>;
  startNewConversation: () => void;
  useStream: boolean;
  setUseStream: (value: boolean) => void;
  /* 上下文 */
  manualContext: AssistantContext;
  patchManualContext: (patch: Partial<AssistantContext>) => void;
  adoptResolvedContext: (resolved: AssistantContext) => void;
  routeInfo: RoutePageInfo;
  merged: ContextMerge;
  /* 助手活跃时才请求的数据 */
  versions: VersionRow[];
  batches: BatchRow[];
  /** 组织/科目名称目录(UX-26 范围名称优先显示)；助手未激活时不请求。 */
  orgs: NameRow[];
  accounts: NameRow[];
  conversations: AssistantConversation[];
  insights: AssistantInsightRow[];
  refetchConversations: () => void;
  refetchInsights: () => void;
  /* 抽屉 */
  dockOpen: boolean;
  openDock: () => void;
  closeDock: () => void;
  /** 抽屉打开或当前在 /assistant：只有此时才拉助手相关列表，业务页面零额外请求 */
  active: boolean;
}

const AssistantStateContext = createContext<AssistantValue | null>(null);

/**
 * 手动筛选的初始值。
 *
 * V2 口径(§6)：manualContext 不再持久化、不再覆盖业务页面，只作为 /assistant 页
 * 自身筛选器的内存状态；刷新页面即清空，业务页面范围以页面适配器登记为准。
 *
 * 这里刻意**不预填年度**：预填会让「2027 年执行情况如何」这类问题里的年度被
 * 筛选器里的旧值盖掉，也会让多轮追问无法沿用上一轮解析出的年度。
 * 缺省年度由后端解析(默认当前自然年)并在「口径」里如实标出。
 */
function loadStoredContext(): AssistantContext {
  return {};
}

/**
 * 按字段合并路由推导与手动筛选。
 *
 * 额外一条一致性修补：手动年度与路由推导出的版本/快照年度冲突时，放弃**路由推导**的那一项。
 * 不修补的话前端会送出「2025 年 + 2026 年的版本」，后端 validateContextConsistency
 * 直接判成「年度不一致」，整轮报错——而用户只是带着上次选的年度走到了另一年的版本页。
 * 冲突判定有两条依据：路由自己带的 year 参数(如 /analysis?year=)，以及版本/快照列表里的年度。
 */
export function mergeAssistantContext(
  routeContext: AssistantContext,
  manualContext: AssistantContext,
  suppressed: ReadonlySet<ContextField>,
  yearOfVersion: (id: number) => number | undefined,
  yearOfBatch: (id: number) => number | undefined,
): ContextMerge {
  const manual = cleanContext(manualContext);
  const route = cleanContext(routeContext);
  const context: AssistantContext = {};
  const fromRoute: ContextField[] = [];
  const fromManual: ContextField[] = [];
  const droppedRoute: ContextField[] = [];
  /** 路由里的年度与手动年度不同：该路由推导出的版本/快照都属于另一个年度。 */
  const routeYearConflicts = manual.year != null && route.year != null && route.year !== manual.year;
  const yearBound: ContextField[] = ['budgetVersionId', 'targetVersionId', 'actualSnapshotId', 'importBatchId'];
  for (const [key, value] of Object.entries(route)) {
    const field = key as ContextField;
    if (suppressed.has(field)) continue;
    if (manual[field] != null) continue;
    if (manual.year != null && yearBound.includes(field)) {
      const own = field === 'actualSnapshotId' ? yearOfBatch(value as number) : yearOfVersion(value as number);
      if (routeYearConflicts || (own != null && own !== manual.year)) { droppedRoute.push(field); continue; }
    }
    (context as Record<string, unknown>)[field] = value;
    fromRoute.push(field);
  }
  for (const [key, value] of Object.entries(manual)) {
    const field = key as ContextField;
    (context as Record<string, unknown>)[field] = value;
    fromManual.push(field);
  }
  return { context, fromRoute, fromManual, droppedRoute };
}

/** 把 V2 页面范围映射回兼容口径(后端优先采用 V2，旧字段保持同口径以便回退)。
 *  旧 context 协议没有 metricId 等扩展字段，这些只在 V2 pageContext 里传；
 *  baseVersionId/compareVersionId 属于版本对比页口径，回填 targetVersionId 以外
 *  还需要保留原始语义(后端 V2 校验不依赖旧字段，这里是给旧客户端回退看的)。 */
function scopeToLegacyContext(pageContext: AssistantPageContextV2): AssistantContext {
  const scope = pageContext.scope ?? {};
  return cleanContext({
    ...Object.fromEntries([...DOMAIN_ID_FIELDS, 'period', 'periodFrom', 'periodTo', 'statementScope'].filter((k) => (scope as any)[k] != null).map((k) => [k, (scope as any)[k]])),
    page: pageContext.pageKey,
    year: scope.year,
    budgetVersionId: scope.budgetVersionId,
    targetVersionId: scope.targetVersionId,
    actualSnapshotId: scope.actualSnapshotId,
    importBatchId: scope.importBatchId,
    orgId: scope.orgScopeId,
    accountId: scope.accountScopeId,
  });
}

function AssistantProviderInner({ children }: { children: ReactNode }) {
  const location = useLocation();
  const registry = useAssistantRegistry();
  const [manualContext, setManualContext] = useState<AssistantContext>(loadStoredContext);
  const [conversationId, setConversationId] = useState<number | undefined>(undefined);
  const [turns, setTurns] = useState<ChatTurn[]>([]);
  const [sending, setSending] = useState(false);
  const [useStream, setUseStream] = useState(true);
  const [dockOpen, setDockOpen] = useState(false);
  /**
   * 被手动清空、因此不再接受路由推导的字段。
   *
   * 只放在内存里：清空是「这一页这一次别再自动填了」的意思，不是永久墓碑，
   * 所以路由一变就整体重置(见下面的 effect)。
   */
  const [suppressed, setSuppressed] = useState<ReadonlySet<ContextField>>(() => new Set());

  /** 流式请求的中断句柄：支持「停止生成」，避免长时间等待时只能刷新页面 */
  const abortRef = useRef<AbortController | null>(null);
  /**
   * 请求世代号。
   *
   * 提问和切换会话都会 +1，异步回调回来时先比对世代号：
   * 等待模型时切到另一个会话，旧流的 onToken / onDone 会把 token 写到已经
   * 不存在的 turn 上，还会用 `setConversationId(response.conversationId)` 把界面
   * 强行拽回旧会话；两个会话详情请求先后返回也会出现内容与高亮不一致。
   */
  const requestSeqRef = useRef(0);
  const mountedRef = useRef(true);
  /** 抽屉关闭后要还回去的焦点(通常是顶栏入口按钮) */
  const returnFocusRef = useRef<HTMLElement | null>(null);

  const routeInfo = useMemo(
    () => derivePageContext(location.pathname, location.search),
    [location.pathname, location.search],
  );
  const onAssistantPage = location.pathname === '/assistant';
  const active = dockOpen || onAssistantPage;

  // 路由变化后抑制集重置：新页面的推导值应当重新生效。
  useEffect(() => {
    setSuppressed((prev) => (prev.size ? new Set() : prev));
  }, [location.pathname, location.search]);

  // 卸载时必须中断在途的 SSE：否则退出后流还在读、回调还在 setState，
  // 直到后端把整轮跑完为止。
  // 进入时显式把 mountedRef 置回 true：StrictMode 开发模式会「挂载→清理→再挂载」，
  // 只在清理里置 false 的话第二次挂载后 isCurrentRequest 永远为假，答案一个字都写不进来。
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      requestSeqRef.current += 1;
      abortRef.current?.abort();
      abortRef.current = null;
    };
  }, []);

  const { data: versions } = useQuery({
    queryKey: ['versions'],
    queryFn: () => api.get<VersionRow[]>('/versions'),
    enabled: active,
  });
  const { data: batches } = useQuery({
    queryKey: ['assistant-batches', manualContext.year],
    queryFn: () => api.get<BatchRow[]>(`/actual/batches?year=${manualContext.year}`),
    enabled: active && manualContext.year != null,
  });
  /* UX-26：范围条按名称显示组织/科目。仅在助手激活时拉一次树目录(staleTime 5 分钟)，
     未命中时界面回退 #id，绝不编造名称。 */
  const { data: orgTreeRows } = useQuery({
    queryKey: ['assistant-org-tree'],
    queryFn: () => api.get<{ rows: NameRow[] }>('/org/tree'),
    enabled: active,
    staleTime: 300_000,
  });
  const { data: accountTreeRows } = useQuery({
    queryKey: ['assistant-account-tree'],
    queryFn: () => api.get<{ rows: NameRow[] }>('/account/tree'),
    enabled: active,
    staleTime: 300_000,
  });
  const { data: conversations, refetch: refetchConversations } = useQuery({
    queryKey: ['assistant-conversations'],
    queryFn: () => assistantApi.conversations(),
    enabled: active,
  });
  const { data: insights, refetch: refetchInsights } = useQuery({
    queryKey: ['assistant-insights'],
    queryFn: () => assistantApi.insights(),
    enabled: active,
  });

  const versionYear = useCallback(
    (id: number) => (versions ?? []).find((row) => row.id === id)?.year,
    [versions],
  );
  const batchYear = useCallback(
    (id: number) => (batches ?? []).find((row) => row.id === id)?.year,
    [batches],
  );

  /**
   * 合并路由推导与手动筛选。
   *
   * §6：manualContext 只在 /assistant 页生效——它是该页自身的筛选器；
   * 业务页面的范围完全以页面适配器登记为准，不再被手动筛选覆盖。
   */
  const merged = useMemo(
    () => mergeAssistantContext(routeInfo.context, onAssistantPage ? manualContext : {}, suppressed, versionYear, batchYear),
    [routeInfo, manualContext, onAssistantPage, suppressed, versionYear, batchYear],
  );

  const beginRequest = (): number => {
    requestSeqRef.current += 1;
    return requestSeqRef.current;
  };
  const isCurrentRequest = (seq: number): boolean => mountedRef.current && seq === requestSeqRef.current;

  const patchManualContext = useCallback((patch: Partial<AssistantContext>) => {
    setManualContext((prev) => ({ ...prev, ...patch }));
    // 手动清空的字段同时抑制该字段的路由推导，否则「清空」在有推导值的页面上看不出效果。
    setSuppressed((prev) => {
      const next = new Set(prev);
      let changed = false;
      for (const [key, value] of Object.entries(patch)) {
        if (key === 'page') continue;
        const field = key as ContextField;
        if (value == null) { if (!next.has(field)) { next.add(field); changed = true; } }
        else if (next.delete(field)) changed = true;
      }
      return changed ? next : prev;
    });
  }, []);

  /** 采用助手解析出的上下文，回填到筛选器；用户随时可以自己改回来。 */
  const adoptResolvedContext = useCallback((resolved: AssistantContext) => {
    const { page: _page, ...rest } = resolved;
    setManualContext((prev) => ({ ...prev, ...cleanContext(rest) }));
    setSuppressed((prev) => {
      if (!prev.size) return prev;
      const next = new Set(prev);
      for (const key of Object.keys(cleanContext(rest))) next.delete(key as ContextField);
      return next;
    });
    message.success('已把助手解析出的筛选条件回填到上下文');
  }, []);

  const startNewConversation = useCallback(() => {
    // 新会话前先掐断在途的流，否则旧流的 onDone 会把 conversationId 写回来。
    abortRef.current?.abort();
    abortRef.current = null;
    beginRequest();
    setConversationId(undefined);
    setTurns([]);
  }, []);

  const openConversation = useCallback(async (id: number) => {
    abortRef.current?.abort();
    abortRef.current = null;
    const seq = beginRequest();
    try {
      const detail = await assistantApi.conversation(id);
      // 期间又切了别的会话(或组件已卸载)：这份结果已经过期，丢掉，
      // 否则会出现「高亮的是 B、正文是 A」。
      if (!isCurrentRequest(seq)) return;
      setConversationId(id);
      setTurns(detail.messages.map((msg) => ({
        key: `history-${msg.id}`,
        role: msg.role === 'user' ? 'user' : 'assistant',
        text: msg.content,
        model: msg.model,
        createdAt: msg.created_at,
        response: msg.role === 'assistant' ? (msg.response as AssistantChatResponse) : undefined,
      })));
    } catch (err) {
      if (!isCurrentRequest(seq)) return;
      message.error(err instanceof Error ? err.message : '会话加载失败');
    }
  }, []);

  /** 停止生成：中断在途请求。后端本轮仍会完成并落库，但界面不再等待。 */
  const stopGenerating = useCallback(() => {
    abortRef.current?.abort();
    abortRef.current = null;
  }, []);

  const sendRef = useRef<(text: string) => Promise<void>>(async () => {});
  sendRef.current = async (text: string) => {
    const messageText = text.trim();
    if (!messageText || sending) return;
    /**
     * 发送瞬间冻结页面上下文(§3.3)。
     * 页面未就绪或超限时明确提示、不发送(§3.7：失败时不扩大范围)；
     * 页面未登记(未知路由重定向前)退回路由推导的兜底口径。
     */
    const snapshot = registry.buildSnapshot();
    if (snapshot.status === 'not_ready' || snapshot.status === 'too_large') {
      message.warning(snapshot.reason);
      return;
    }
    const legacyContext = snapshot.status === 'ok'
      ? scopeToLegacyContext(snapshot.pageContext)
      : cleanContext({ ...merged.context, ...(routeInfo.page === 'unknown' ? {} : { page: routeInfo.page }) });
    /* UX-26：回答与发起时的页面身份绑定。已登记页面以注册快照的 pageKey 为准；
       未登记(未知路由重定向前)退回路由推导。 */
    const origin = { pageKey: snapshot.status === 'ok' ? snapshot.pageContext.pageKey : routeInfo.page };
    const stamp = Date.now();
    const assistantKey = `assistant-${stamp}`;
    const seq = beginRequest();
    setTurns((prev) => [
      ...prev,
      { key: `user-${stamp}`, role: 'user', text: messageText },
      { key: assistantKey, role: 'assistant', text: '', pending: true, origin },
    ]);
    setSending(true);
    // 页面感知：V2 页面快照与兼容口径一起送给后端；后端优先采用 V2。
    const body = {
      conversationId,
      message: messageText,
      context: legacyContext,
      ...(snapshot.status === 'ok' ? { pageContext: snapshot.pageContext } : {}),
    };
    const applyDone = (response: AssistantChatResponse) => {
      // 世代号不一致说明用户已经切走：不要把 conversationId 拽回这一轮的会话，
      // 也不要往已经换掉的 turns 里写。
      if (!isCurrentRequest(seq)) return;
      setConversationId(response.conversationId);
      setTurns((prev) => prev.map((turn) => (turn.key === assistantKey
        ? { ...turn, text: response.text, pending: false, progress: null, response, model: response.model }
        : turn)));
      void refetchConversations();
    };
    const controller = new AbortController();
    abortRef.current = controller;
    try {
      if (useStream) {
        await streamChat(body, {
          onToken: (chunk) => { if (isCurrentRequest(seq)) setTurns((prev) => prev.map((turn) => (turn.key === assistantKey ? { ...turn, text: turn.text + chunk } : turn))); },
          // 进度事件：等待期间如实显示「正在计算差异归因」这类阶段
          onProgress: (progress) => { if (isCurrentRequest(seq)) setTurns((prev) => prev.map((turn) => (turn.key === assistantKey ? { ...turn, progress } : turn))); },
          onDone: applyDone,
          // 响应头已发出后的服务端错误：正文可能已经流了一部分。
          // 这里只清掉「正在处理」的转圈，提示交给下面的 catch 统一弹一次，
          // 否则同一个错误会连弹两个 toast。
          onError: () => { if (isCurrentRequest(seq)) setTurns((prev) => prev.map((turn) => (turn.key === assistantKey ? { ...turn, pending: false, progress: null } : turn))); },
        }, controller.signal);
      } else {
        // 非流式路径同样透传 signal，「停止生成」在关掉流式开关后也如实生效。
        applyDone(await assistantApi.chat(body, { signal: controller.signal }));
      }
    } catch (err) {
      // 用户主动停止：不算错误，保留已经流出来的正文
      if (controller.signal.aborted) {
        if (isCurrentRequest(seq)) {
          setTurns((prev) => prev.map((turn) => (turn.key === assistantKey
            ? { ...turn, pending: false, progress: null, stopped: true, text: turn.text || '（已停止生成）' }
            : turn)));
        }
      } else if (isCurrentRequest(seq)) {
        const detail = err instanceof ApiError ? `${err.body.message}（${err.body.code}）` : err instanceof Error ? err.message : '请求失败';
        setTurns((prev) => prev.map((turn) => (turn.key === assistantKey ? { ...turn, pending: false, progress: null, text: turn.text || `请求失败：${detail}` } : turn)));
        message.error(detail);
      }
    } finally {
      if (abortRef.current === controller) abortRef.current = null;
      if (mountedRef.current) setSending(false);
    }
  };
  /** send 的身份保持稳定(内部读最新闭包)，避免它进依赖数组时到处触发重渲染。 */
  const send = useCallback((text: string) => sendRef.current(text), []);

  const openDock = useCallback(() => {
    // 记住唤起抽屉时的焦点(通常是顶栏入口按钮)，关闭后还回去：
    // rc-drawer 只在打开时把焦点移进面板，关闭时不负责还原，键盘用户会掉到页面开头。
    returnFocusRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    setDockOpen(true);
  }, []);
  const closeDock = useCallback(() => {
    setDockOpen(false);
    const target = returnFocusRef.current;
    returnFocusRef.current = null;
    // 等抽屉自己的焦点处理跑完再还焦点，否则会被面板抢回去。
    if (target && target.isConnected) window.setTimeout(() => target.focus({ preventScroll: true }), 0);
  }, []);
  const value: AssistantValue = {
    turns,
    conversationId,
    sending,
    send,
    stopGenerating,
    openConversation,
    startNewConversation,
    useStream,
    setUseStream,
    manualContext,
    patchManualContext,
    adoptResolvedContext,
    routeInfo,
    merged,
    versions: versions ?? [],
    batches: batches ?? [],
    orgs: orgTreeRows?.rows ?? [],
    accounts: accountTreeRows?.rows ?? [],
    conversations: conversations?.items ?? [],
    insights: insights?.items ?? [],
    refetchConversations: () => { void refetchConversations(); },
    refetchInsights: () => { void refetchInsights(); },
    dockOpen,
    openDock,
    closeDock,
    active,
  };

  return <AssistantStateContext.Provider value={value}>{children}</AssistantStateContext.Provider>;
}

export function useAssistant(): AssistantValue {
  const value = useContext(AssistantStateContext);
  if (!value) throw new Error('useAssistant 必须在 AssistantProvider 内使用');
  return value;
}

/**
 * 挂载顺序：注册中心在外(页面适配器向它登记)，会话状态在内(发送时向它取快照)。
 */
export function AssistantProvider({ children }: { children: ReactNode }) {
  return (
    <AssistantRegistryProvider>
      <AssistantProviderInner>{children}</AssistantProviderInner>
    </AssistantRegistryProvider>
  );
}
