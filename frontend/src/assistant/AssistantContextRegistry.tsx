/**
 * AssistantContextRegistry(现行 specs/ai.md 页面上下文契约§8.1)。
 *
 * 注册中心维护：
 * - 当前 pageKey、routeInstanceId 和 contextVersion；
 * - 页面 scope、view 和 ready 状态；
 * - 按打开顺序排列的 surfaces；
 * - 当前 focus 和 selection；
 * - 当前页面提供的 draft 序列化函数。
 *
 * 每个注册返回 token。更新或清理时同时校验 token 和 routeInstanceId，
 * 避免 React StrictMode 双挂载、页面切换或异步回调清理了新页面状态(§8.1)。
 *
 * 发送时冻结(§3.3)：buildSnapshot() 生成本轮不可变快照；页面在回答过程中发生变化，
 * 只影响下一轮，不修改已经发送的问题。
 */
import {
  createContext, useCallback, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode,
} from 'react';
import { useLocation } from 'react-router-dom';
import {
  newContextId, normalizeScope, normalizeView,
  CONTEXT_MAX_BYTES, DRAFT_MAX_BYTES,
  type AssistantPageContextV2, type DraftDescriptor, type FocusDescriptor,
  type PageScope, type SelectionDescriptor, type SurfaceDescriptor,
} from './context';

export type PageReadyState = 'loading' | 'ready' | 'error';

export interface PageRegistrationInit {
  pageKey: string;
  ready: boolean;
  /** ready=false 时的原因(错误态文案)；页面自行决定何时就绪。 */
  notReadyReason?: string | null;
  /**
   * ready=false 时页面处于加载中还是加载失败。
   * 缺省按 notReadyReason 是否为空推断(空=loading)；页面应显式传入，
   * 加载文案再长也不会被误判成错误态——ScopeBar 据此决定显示灰字还是红字。
   */
  readyState?: 'loading' | 'error';
  scope?: PageScope;
  view?: Record<string, unknown>;
  /** 有未保存草稿；发送时调用 serializeDraft 取受控 draft。 */
  dirty?: boolean;
  /** 未保存修改条数(展示用,如「包含 3 项未保存修改」)；不进入权威上下文。 */
  dirtyCount?: number;
  serializeDraft?: (() => DraftDescriptor | null) | null;
}

export type PageRegistrationPatch = Partial<Omit<PageRegistrationInit, 'pageKey' | 'readyState'>> & { pageKey?: string; readyState?: 'loading' | 'error' };

interface PageEntry extends Required<Omit<PageRegistrationInit, 'notReadyReason' | 'serializeDraft' | 'readyState'>> {
  token: symbol;
  routeInstanceId: string;
  notReadyReason: string | null;
  readyState: 'loading' | 'error';
  serializeDraft: (() => DraftDescriptor | null) | null;
  contextVersion: number;
}

interface SurfaceEntry {
  token: symbol;
  routeInstanceId: string;
  descriptor: SurfaceDescriptor;
}

interface FocusEntry {
  token: symbol;
  routeInstanceId: string;
  focus: FocusDescriptor;
  /** 展示用标签：只用于界面「当前对象」提示，绝不进入发送给后端的权威上下文。 */
  label: string | null;
}

/** 发送时冻结的结果。 */
export type SnapshotBuild =
  | { status: 'ok'; pageContext: AssistantPageContextV2 }
  | { status: 'not_ready'; reason: string }
  | { status: 'too_large'; reason: string }
  | { status: 'unregistered' };

/** 提供给 ScopeBar 等 UI 的只读视图。 */
export interface RegistryView {
  pageKey: string | null;
  ready: PageReadyState;
  notReadyReason: string | null;
  scope: PageScope;
  view: Record<string, unknown>;
  dirty: boolean;
  /** 未保存修改条数(仅展示)。 */
  dirtyCount: number;
  contextVersion: number;
  topSurface: SurfaceDescriptor | null;
  focus: FocusDescriptor | null;
  focusLabel: string | null;
  selection: SelectionDescriptor | null;
  routeInstanceId: string;
}

/**
 * 注册操作 API(稳定身份):只含函数,不随 renderTick 变化。
 * Hook 的 effect 以它为依赖才不会因 bump 无限重注册(注册 → bump → value 变 → 重注册)。
 */
export interface AssistantRegistryApi {
  registerPage: (init: PageRegistrationInit) => symbol;
  updatePage: (token: symbol, patch: PageRegistrationPatch) => void;
  unregisterPage: (token: symbol) => void;
  registerSurface: (descriptor: Omit<SurfaceDescriptor, 'id'> & { id?: string }) => { id: string; token: symbol };
  updateSurface: (token: symbol, patch: Partial<Omit<SurfaceDescriptor, 'id'>>) => void;
  unregisterSurface: (token: symbol) => void;
  setFocus: (focus: FocusDescriptor, label?: string | null) => symbol;
  clearFocus: (token?: symbol) => void;
  setSelection: (selection: SelectionDescriptor | null) => void;
  buildSnapshot: () => SnapshotBuild;
}

/** @deprecated 兼容旧调用;新代码请分开使用 useAssistantRegistry(API) 与 useAssistantRegistryView(view)。 */
export interface AssistantRegistry extends AssistantRegistryApi {
  view: RegistryView;
}

const AssistantRegistryApiContext = createContext<AssistantRegistryApi | null>(null);
const AssistantRegistryViewContext = createContext<RegistryView | null>(null);

/**
 * 当前包裹层浮层的 id(§5.4 嵌套浮层)：AssistantSurfaceBoundary 向子树提供，
 * 子级浮层(如 Drawer 内的核验 Popover)自动把 parentId 指到父浮层。
 */
export const AssistantSurfaceParentContext = createContext<string | null>(null);

function jsonEqual(a: unknown, b: unknown): boolean {
  return JSON.stringify(a) === JSON.stringify(b);
}

export function AssistantRegistryProvider({ children }: { children: ReactNode }) {
  const location = useLocation();
  /**
   * 路由实例：路径变化即新实例。查询参数变化(如同页筛选)不换实例，
   * 由页面适配器通过 updatePage 报告新口径；不同业务对象(如 /budget/3 → /budget/5)
   * 路径本身不同，天然产生新实例。
   */
  const routeInstanceId = useMemo(() => newContextId(), [location.pathname]);

  const pageRef = useRef<PageEntry | null>(null);
  const surfacesRef = useRef<SurfaceEntry[]>([]);
  const focusRef = useRef<FocusEntry | null>(null);
  const selectionRef = useRef<SelectionDescriptor | null>(null);
  /** 渲染版本号：任何注册变化都递增一次，驱动 ScopeBar 等 UI 更新。 */
  const [renderTick, setRenderTick] = useState(0);
  const bump = useCallback(() => setRenderTick((tick) => tick + 1), []);

  // 路由实例切换：清空全部旧实例状态。旧页面迟到的 effect 不能覆盖新实例(§10.3)。
  // 必须用 useLayoutEffect：SPA 导航时新页面的注册 effect 与本重置 effect 在同一次
  // commit 里执行，而 passive effect 自底向上——子页面先注册、父级后清空，会把刚
  // 注册的新页面清掉且此后无人再触发重注册(注册依赖的 api 不再变化)。
  // layout effect 整体先于 passive effect 运行：重置(旧状态)先落，注册(新状态)后落。
  // 跳过首次挂载：首次挂载同样没有需要清理的旧实例。
  const prevRouteRef = useRef(routeInstanceId);
  useLayoutEffect(() => {
    if (prevRouteRef.current === routeInstanceId) return;
    prevRouteRef.current = routeInstanceId;
    pageRef.current = null;
    surfacesRef.current = [];
    focusRef.current = null;
    selectionRef.current = null;
    bump();
  }, [routeInstanceId, bump]);

  const registerPage = useCallback((init: PageRegistrationInit): symbol => {
    const token = Symbol(`page:${init.pageKey}`);
    pageRef.current = {
      token,
      routeInstanceId,
      pageKey: init.pageKey,
      ready: init.ready,
      notReadyReason: init.notReadyReason ?? null,
      readyState: init.readyState ?? (init.notReadyReason ? 'error' : 'loading'),
      scope: normalizeScope(init.scope ?? {}),
      view: normalizeView(init.view ?? {}),
      dirty: init.dirty ?? false,
      dirtyCount: init.dirtyCount ?? 0,
      serializeDraft: init.serializeDraft ?? null,
      contextVersion: 1,
    };
    bump();
    return token;
  }, [routeInstanceId, bump]);

  const updatePage = useCallback((token: symbol, patch: PageRegistrationPatch) => {
    const entry = pageRef.current;
    // token 与 routeInstanceId 双重校验：StrictMode 重复挂载与跨页异步更新都不串状态(§8.1)。
    if (!entry || entry.token !== token || entry.routeInstanceId !== routeInstanceId) return;
    const next: PageEntry = { ...entry };
    if (patch.pageKey != null) next.pageKey = patch.pageKey;
    if (patch.ready != null) next.ready = patch.ready;
    if (patch.notReadyReason !== undefined) next.notReadyReason = patch.notReadyReason;
    if (patch.readyState != null) next.readyState = patch.readyState;
    else if (patch.notReadyReason !== undefined) next.readyState = patch.notReadyReason ? 'error' : 'loading';
    if (patch.scope !== undefined) next.scope = normalizeScope(patch.scope);
    if (patch.view !== undefined) next.view = normalizeView(patch.view);
    if (patch.dirty != null) next.dirty = patch.dirty;
    if (patch.dirtyCount != null) next.dirtyCount = patch.dirtyCount;
    if (patch.serializeDraft !== undefined) next.serializeDraft = patch.serializeDraft;
    // 内容没有实际变化时不递增 contextVersion、不触发渲染：页面筛选每次渲染都可能
    // 产生新对象引用，但只有语义内容变化才算一轮新的页面状态。
    if (
      next.pageKey === entry.pageKey
      && next.ready === entry.ready
      && next.notReadyReason === entry.notReadyReason
      && next.readyState === entry.readyState
      && next.dirty === entry.dirty
      && next.dirtyCount === entry.dirtyCount
      && next.serializeDraft === entry.serializeDraft
      && jsonEqual(next.scope, entry.scope)
      && jsonEqual(next.view, entry.view)
    ) return;
    next.contextVersion = entry.contextVersion + 1;
    pageRef.current = next;
    bump();
  }, [routeInstanceId, bump]);

  const unregisterPage = useCallback((token: symbol) => {
    const entry = pageRef.current;
    if (!entry || entry.token !== token) return;
    pageRef.current = null;
    bump();
  }, [bump]);

  const registerSurface = useCallback((descriptor: Omit<SurfaceDescriptor, 'id'> & { id?: string }) => {
    const token = Symbol(`surface:${descriptor.key}`);
    const id = descriptor.id ?? newContextId();
    // 父浮层不存在时拒绝嵌套登记，避免悬浮孤儿。
    if (descriptor.parentId != null && !surfacesRef.current.some((item) => item.descriptor.id === descriptor.parentId && item.routeInstanceId === routeInstanceId)) {
      descriptor = { ...descriptor, parentId: null };
    }
    surfacesRef.current = [...surfacesRef.current.filter((item) => item.descriptor.id !== id), { token, routeInstanceId, descriptor: { ...descriptor, id } }];
    bump();
    return { id, token };
  }, [routeInstanceId, bump]);

  const updateSurface = useCallback((token: symbol, patch: Partial<Omit<SurfaceDescriptor, 'id'>>) => {
    const index = surfacesRef.current.findIndex((item) => item.token === token && item.routeInstanceId === routeInstanceId);
    if (index < 0) return;
    const current = surfacesRef.current[index].descriptor;
    const nextDescriptor = { ...current, ...patch };
    // 内容相同不 bump:updateSurface 在每轮渲染后都可能被调用,无变更检测会造成 渲染→bump→渲染 循环。
    if (jsonEqual(nextDescriptor, current)) return;
    const next = [...surfacesRef.current];
    next[index] = { ...next[index], descriptor: nextDescriptor };
    surfacesRef.current = next;
    bump();
  }, [routeInstanceId, bump]);

  const unregisterSurface = useCallback((token: symbol) => {
    const entry = surfacesRef.current.find((item) => item.token === token);
    if (!entry) return;
    // 父浮层关闭时级联清理子浮层(§5.4)。
    const removed = new Set<string>([entry.descriptor.id]);
    let changed = true;
    while (changed) {
      changed = false;
      for (const item of surfacesRef.current) {
        if (removed.has(item.descriptor.id)) continue;
        if (item.descriptor.parentId != null && removed.has(item.descriptor.parentId)) {
          removed.add(item.descriptor.id);
          changed = true;
        }
      }
    }
    surfacesRef.current = surfacesRef.current.filter((item) => !removed.has(item.descriptor.id));
    bump();
  }, [bump]);

  const setFocus = useCallback((focus: FocusDescriptor, label: string | null = null): symbol => {
    const token = Symbol('focus');
    focusRef.current = { token, routeInstanceId, focus, label };
    bump();
    return token;
  }, [routeInstanceId, bump]);

  const clearFocus = useCallback((token?: symbol) => {
    if (!focusRef.current) return;
    if (token && focusRef.current.token !== token) return;
    focusRef.current = null;
    bump();
  }, [bump]);

  const setSelection = useCallback((selection: SelectionDescriptor | null) => {
    selectionRef.current = selection;
    bump();
  }, [bump]);

  const buildSnapshot = useCallback((): SnapshotBuild => {
    const page = pageRef.current;
    if (!page || page.routeInstanceId !== routeInstanceId) return { status: 'unregistered' };
    // 页面尚未就绪：明确提示，不静默退回任何默认范围(§3.7)。
    if (!page.ready) return { status: 'not_ready', reason: page.notReadyReason ?? '当前页面范围尚未就绪，请等待页面加载完成' };
    const surfaces = surfacesRef.current
      .filter((item) => item.routeInstanceId === routeInstanceId)
      .map((item) => item.descriptor);
    const focus = focusRef.current?.routeInstanceId === routeInstanceId ? focusRef.current.focus : null;
    const selection = selectionRef.current;
    let draft: DraftDescriptor | null = null;
    if (page.dirty && page.serializeDraft) {
      try {
        draft = page.serializeDraft();
      } catch (err) {
        return { status: 'not_ready', reason: `草稿序列化失败：${err instanceof Error ? err.message : String(err)}` };
      }
    }
    const pageContext: AssistantPageContextV2 = {
      schemaVersion: 2,
      snapshotId: newContextId(),
      pageKey: page.pageKey,
      routeInstanceId,
      contextVersion: page.contextVersion,
      scope: page.scope,
      view: page.view,
      surfaces,
      focus,
      selection,
      draft,
    };
    // §5.8：超限时不静默丢弃，直接提示用户先保存或缩小范围。
    const { draft: draftPart, ...rest } = pageContext;
    if (JSON.stringify(rest).length > CONTEXT_MAX_BYTES) {
      return { status: 'too_large', reason: '当前页面上下文超过 64 KiB，请缩小选区或筛选范围' };
    }
    if (draftPart && JSON.stringify(draftPart).length > DRAFT_MAX_BYTES) {
      return { status: 'too_large', reason: '未保存修改超过 5 MiB，请先保存再提问' };
    }
    return { status: 'ok', pageContext };
  }, [routeInstanceId]);

  const view = useMemo<RegistryView>(() => {
    void renderTick;
    const page = pageRef.current;
    const surfaces = surfacesRef.current.filter((item) => item.routeInstanceId === routeInstanceId);
    const focusEntry = focusRef.current?.routeInstanceId === routeInstanceId ? focusRef.current : null;
    return {
      pageKey: page && page.routeInstanceId === routeInstanceId ? page.pageKey : null,
      // ready 三态：显式 readyState 优先；缺省时「有 notReadyReason 的未就绪页」按错误处理
      // (只有确实区分不了的新调用方才会走到这条推断，页面都应显式传 readyState)。
      ready: page ? (page.ready ? 'ready' : page.readyState) : 'loading',
      notReadyReason: page?.notReadyReason ?? null,
      scope: page?.scope ?? {},
      view: page?.view ?? {},
      dirty: page?.dirty ?? false,
      dirtyCount: page?.dirtyCount ?? 0,
      contextVersion: page?.contextVersion ?? 0,
      topSurface: surfaces.length ? surfaces[surfaces.length - 1].descriptor : null,
      focus: focusEntry?.focus ?? null,
      focusLabel: focusEntry?.label ?? null,
      selection: selectionRef.current,
      routeInstanceId,
    };
  }, [renderTick, routeInstanceId]);

  const api = useMemo<AssistantRegistryApi>(() => ({
    registerPage,
    updatePage,
    unregisterPage,
    registerSurface,
    updateSurface,
    unregisterSurface,
    setFocus,
    clearFocus,
    setSelection,
    buildSnapshot,
  }), [registerPage, updatePage, unregisterPage, registerSurface, updateSurface, unregisterSurface, setFocus, clearFocus, setSelection, buildSnapshot]);

  return (
    <AssistantRegistryApiContext.Provider value={api}>
      <AssistantRegistryViewContext.Provider value={view}>
        {children}
      </AssistantRegistryViewContext.Provider>
    </AssistantRegistryApiContext.Provider>
  );
}

/**
 * 取注册操作 API(稳定身份,不随渲染 tick 变化)。
 * Hook 注册/更新/注销必须以它为依赖;需要订阅状态请用 useAssistantRegistryView。
 */
export function useAssistantRegistry(): AssistantRegistryApi {
  const value = useContext(AssistantRegistryApiContext);
  if (!value) throw new Error('useAssistantRegistry 必须在 AssistantRegistryProvider 内使用');
  return value;
}

/**
 * 可选注册中心：共享组件(VerifyBar 等)在测试或无 Provider 环境下渲染时不抛错，
 * 只是不做焦点/浮层登记。页面级 Hook(useAssistantPageContext)仍强制要求 Provider。
 */
export function useOptionalAssistantRegistry(): AssistantRegistryApi | null {
  return useContext(AssistantRegistryApiContext);
}

/** 订阅注册中心只读视图(随 renderTick 更新),仅供 ScopeBar 等 UI 使用。 */
export function useAssistantRegistryView(): RegistryView {
  const value = useContext(AssistantRegistryViewContext);
  if (!value) throw new Error('useAssistantRegistryView 必须在 AssistantRegistryProvider 内使用');
  return value;
}

export function useOptionalAssistantRegistryView(): RegistryView | null {
  return useContext(AssistantRegistryViewContext);
}
