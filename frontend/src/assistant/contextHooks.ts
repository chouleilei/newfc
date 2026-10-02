/**
 * 页面与通用组件的登记 Hook(现行 specs/ai.md 页面上下文契约§8.2)。
 *
 * 三条铁律：
 * 1. Hook 只登记页面已有状态，不主动请求业务接口；助手关闭时不增加网络请求(§8.2)；
 * 2. 页面状态只登记一次：用于 React Query 和业务接口的实际变量同时交给本 Hook，
 *    不另外维护一套「AI 筛选状态」(§3.2)；
 * 3. 每个注册返回 token，卸载或路由切换后自动失效(见 AssistantContextRegistry)。
 */
import { useCallback, useContext, useEffect, useRef } from 'react';
import {
  AssistantSurfaceParentContext, useAssistantRegistry, useOptionalAssistantRegistry, type PageRegistrationInit,
} from './AssistantContextRegistry';
import { FocusDescriptor, SelectionDescriptor, SurfaceDescriptor } from './context';

/**
 * 登记页面范围、view 与 ready 状态。
 *
 * 页面异步默认值(如 Dashboard 的 year、Analysis 的版本)就绪前必须传 ready:false，
 * 此时助手不会宣称「已对齐当前页面」(§7.3)。
 *
 * @param init.pageKey 页面唯一标识；DataManage 这类多页签页面必须传最终生效的页签。
 */
export function useAssistantPageContext(init: PageRegistrationInit): void {
  const registry = useAssistantRegistry();
  const tokenRef = useRef<symbol | null>(null);
  const serializeDraftRef = useRef(init.serializeDraft ?? null);
  serializeDraftRef.current = init.serializeDraft ?? null;
  // 注册中心保存稳定代理，发送瞬间再调用本次渲染的最新序列化器；这样既不会因内联闭包
  // 每次换引用而空增 contextVersion，也不会把第一次 dirty 渲染捕获的旧网格状态带到后续提问。
  const serializeLatestDraft = useCallback(() => serializeDraftRef.current?.() ?? null, []);
  const {
    pageKey, ready, readyState, notReadyReason, scope, view, dirty, dirtyCount,
  } = init;
  const serializeDraft = init.serializeDraft == null ? null : serializeLatestDraft;

  useEffect(() => {
    const token = registry.registerPage({
      pageKey, ready, readyState, notReadyReason, scope, view, dirty, dirtyCount, serializeDraft,
    });
    tokenRef.current = token;
    return () => {
      registry.unregisterPage(token);
      if (tokenRef.current === token) tokenRef.current = null;
    };
    // 只在挂载时注册一次；后续变化走 updatePage，避免反复重建 token。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registry]);

  useEffect(() => {
    const token = tokenRef.current;
    if (!token) return;
    registry.updatePage(token, { pageKey, ready, readyState, notReadyReason, scope, view, dirty, dirtyCount, serializeDraft });
  });
}

/**
 * 可选浮层登记：共享组件(如 VerifyBar 的核验 Popover)在无 Provider 的环境下静默跳过。
 */
export function useOptionalAssistantSurface(input: {
  open: boolean;
  kind: SurfaceDescriptor['kind'];
  key: string;
  entity?: SurfaceDescriptor['entity'];
  parentId?: string | null;
}): string | null {
  const registry = useOptionalAssistantRegistry();
  const inheritedParentId = useContext(AssistantSurfaceParentContext);
  const tokenRef = useRef<symbol | null>(null);
  const idRef = useRef<string | null>(null);
  const { open, kind, key, entity } = input;
  const parentId = input.parentId !== undefined ? input.parentId : inheritedParentId;

  useEffect(() => {
    if (!registry || !open) return undefined;
    const { id, token } = registry.registerSurface({ kind, key, entity: entity ?? null, parentId: parentId ?? null });
    tokenRef.current = token;
    idRef.current = id;
    return () => {
      registry.unregisterSurface(token);
      if (tokenRef.current === token) tokenRef.current = null;
      if (idRef.current === id) idRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registry, open, kind, key, parentId]);

  useEffect(() => {
    const token = tokenRef.current;
    if (!registry || !token || !open) return;
    registry.updateSurface(token, { entity: entity ?? null });
  });

  return open ? idRef.current : null;
}

/**
 * 登记 Drawer、Modal、Popover 和右键菜单(§8.2)。
 * open=false 或组件卸载时立即注销；嵌套浮层传 parentId(来自父级的 useAssistantSurface 返回值)。
 *
 * @returns 本浮层的稳定 id(供子浮层 parentId 使用)。
 */
export function useAssistantSurface(input: {
  open: boolean;
  kind: SurfaceDescriptor['kind'];
  key: string;
  entity?: SurfaceDescriptor['entity'];
  /** 嵌套浮层的父级 id；缺省自动继承 AssistantSurfaceBoundary 提供的父浮层。 */
  parentId?: string | null;
}): string | null {
  const registry = useAssistantRegistry();
  const inheritedParentId = useContext(AssistantSurfaceParentContext);
  const tokenRef = useRef<symbol | null>(null);
  const idRef = useRef<string | null>(null);
  const { open, kind, key, entity } = input;
  const parentId = input.parentId !== undefined ? input.parentId : inheritedParentId;

  useEffect(() => {
    if (!open) return undefined;
    const { id, token } = registry.registerSurface({ kind, key, entity: entity ?? null, parentId: parentId ?? null });
    tokenRef.current = token;
    idRef.current = id;
    return () => {
      registry.unregisterSurface(token);
      if (tokenRef.current === token) tokenRef.current = null;
      if (idRef.current === id) idRef.current = null;
    };
    // 打开/关闭即注册/注销；entity 变化走 updateSurface。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registry, open, kind, key, parentId]);

  useEffect(() => {
    const token = tokenRef.current;
    if (!token || !open) return;
    registry.updateSurface(token, { entity: entity ?? null });
  });

  return open ? idRef.current : null;
}

/**
 * 登记/清理当前单一焦点的可选变体：共享组件(VerifyBar 等)在无 Provider 的环境下
 * 静默跳过焦点登记，其余生命周期与 useAssistantFocus 一致(变化重登记、卸载清理)。
 */
export function useOptionalAssistantFocus(focus: FocusDescriptor | null, label?: string | null): void {
  const registry = useOptionalAssistantRegistry();
  const tokenRef = useRef<symbol | null>(null);
  const focusJson = focus ? JSON.stringify(focus) : null;

  useEffect(() => {
    if (!registry) return undefined;
    if (!focusJson) {
      const token = tokenRef.current;
      if (token) {
        registry.clearFocus(token);
        tokenRef.current = null;
      }
      return undefined;
    }
    const token = registry.setFocus(JSON.parse(focusJson) as FocusDescriptor, label ?? null);
    tokenRef.current = token;
    return () => {
      registry.clearFocus(token);
      if (tokenRef.current === token) tokenRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registry, focusJson, label]);
}

/**
 * 登记 当前单一焦点(§5.5)：entity、cell、chart_point、fact 或 form_field。
 * focus 为 null 时不占位；组件卸载时自动清理(只清理自己登记的那份)。
 * hover 不调用本 Hook——hover 不改变助手焦点(§10.2)。
 *
 * @param label 展示用标签，只用于「当前对象」提示，不进入权威上下文。
 */
export function useAssistantFocus(focus: FocusDescriptor | null, label?: string | null): void {
  const registry = useAssistantRegistry();
  const tokenRef = useRef<symbol | null>(null);
  const focusJson = focus ? JSON.stringify(focus) : null;

  useEffect(() => {
    if (!focusJson) {
      const token = tokenRef.current;
      if (token) {
        registry.clearFocus(token);
        tokenRef.current = null;
      }
      return undefined;
    }
    const token = registry.setFocus(JSON.parse(focusJson) as FocusDescriptor, label ?? null);
    tokenRef.current = token;
    return () => {
      registry.clearFocus(token);
      if (tokenRef.current === token) tokenRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registry, focusJson, label]);
}

/** 登记当前多选范围(§5.6)；null 清空。refs 超过 500 项时调用方必须改用 bounds 或 query。 */
export function useAssistantSelection(selection: SelectionDescriptor | null): void {
  const registry = useAssistantRegistry();
  const selectionJson = selection ? JSON.stringify(selection) : null;
  useEffect(() => {
    registry.setSelection(selectionJson ? (JSON.parse(selectionJson) as SelectionDescriptor) : null);
    return () => registry.setSelection(null);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [registry, selectionJson]);
}

/** 新领域页面登记：允许独立组件测试不带助手 Provider，产品运行时仍登记同一份实际筛选。 */
export function useAssistantDomainPage(init: PageRegistrationInit, enabled = true): void {
  const registry = useOptionalAssistantRegistry();
  const tokenRef = useRef<symbol | null>(null);
  useEffect(() => {
    if (!registry || !enabled) return;
    const token = registry.registerPage(init);
    tokenRef.current = token;
    return () => { registry.unregisterPage(token); if (tokenRef.current === token) tokenRef.current = null; };
  }, [registry, enabled]);
  useEffect(() => { if (enabled && registry && tokenRef.current) registry.updatePage(tokenRef.current, init); });
}
