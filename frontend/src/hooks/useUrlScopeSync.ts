/**
 * 页面工作范围 ↔ URL 查询串双向同步(方案《易用性与直觉化交互实施方案》§5.1,任务 UX-02)。
 *
 * 约定:
 * - 页面最终用于查询的范围(state)是唯一事实来源,URL 是它的可分享镜像;
 *   范围切换用 replace 写回,不产生历史记录堆积(跨页下钻的 push 由跳转方负责);
 * - URL → 页面:location.search 变化(初始加载 / 前进后退 / 直接改链接)时解析并回调 onApply,
 *   由页面把解析结果接到与手动切换一致的 handler 上(含未保存守卫),本 hook 不直接改页面状态;
 * - 页面 → URL:仅当受管参数与当前 search 不一致时写回;解析结果与 state 一致时不写,
 *   因此不会因自身写回而循环改写;
 * - 应用 URL 后的一瞬间 state 尚未收敛,写回被抑制一次,避免用旧的 state 覆盖刚读入的 URL;
 * - 解析失败的参数不进入 scope(见 parseWorkspaceScope),页面负责给出可见说明;
 * - keys 可收窄受管参数(如 BudgetEdit 只镜像 sheet,orgId/accountId 保留为一次性定位参数)。
 */
import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { PageKey } from '../assistant/context';
import {
  parseWorkspaceScope,
  scopeFieldOfParam,
  ROUTE_SCOPE_WHITELIST,
  type ScopeIssue,
  type ScopeParseResult,
  type WorkspaceScope,
} from '../utils/workspaceScope';

export interface UrlScopeSyncResult {
  /** 当前 URL 的解析结果(含合法 scope 与被拒绝的参数说明)。 */
  parsed: ScopeParseResult;
  /** 当前 URL 中被拒绝的参数(格式层面);归属层面的失效由页面另行校验。 */
  issues: ScopeIssue[];
  /** 立即以当前 scope 覆盖 URL(replace);用于守卫取消后把 URL 还原为页面实际范围。 */
  syncNow: () => void;
}

export function useUrlScopeSync(
  pageKey: PageKey,
  scope: WorkspaceScope,
  onApply: (parsed: ScopeParseResult) => void,
  options?: { keys?: readonly string[] },
): UrlScopeSyncResult {
  const [searchParams, setSearchParams] = useSearchParams();
  const search = searchParams.toString();
  const parsed = useMemo(() => parseWorkspaceScope(pageKey, search), [pageKey, search]);
  const keys = useMemo(
    () => [...(options?.keys ?? ROUTE_SCOPE_WHITELIST[pageKey] ?? [])],
    // keys 数组通常是字面量,按内容比较避免每次渲染重建
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [pageKey, (options?.keys ?? []).join(',')],
  );

  const onApplyRef = useRef(onApply);
  onApplyRef.current = onApply;
  const latestRef = useRef({ search, scope, keys });
  latestRef.current = { search, scope, keys };

  /** 受管字段签名:URL 解析结果与 state 各算一份,一致即不动作(不循环改写的核心)。 */
  const sigOf = useCallback((s: WorkspaceScope, issues: ScopeIssue[]) => {
    const parts = keys.map((key) => {
      const field = scopeFieldOfParam(key);
      const value = field ? (s as Record<string, unknown>)[field] : undefined;
      return `${key}=${value === undefined || value === null ? '' : String(value)}`;
    });
    const issueSig = issues.map((item) => `${item.key}:${item.raw}`).join('|');
    return `${parts.join('&')}#${issueSig}`;
  }, [keys]);

  const appliedSigRef = useRef<string | null>(null);
  const suppressWriteRef = useRef(false);
  const parsedSig = sigOf(parsed.scope, parsed.issues);
  const scopeSig = sigOf(scope, []);

  // URL → 页面:仅当解析结果与上次已应用的不同才回调(自身写回导致的 search 变化,
  // 解析后与 state 一致,虽然也会触发一次回调,但页面 handler 按同值幂等处理)。
  useEffect(() => {
    if (appliedSigRef.current === parsedSig) return;
    appliedSigRef.current = parsedSig;
    suppressWriteRef.current = true;
    onApplyRef.current(parsed);
  }, [parsedSig, parsed]);

  // 页面 → URL(replace):受管参数与 search 不一致时写回;应用 URL 后的首帧跳过,
  // 等 state 收敛后再恢复镜像。
  useEffect(() => {
    if (suppressWriteRef.current) {
      suppressWriteRef.current = false;
      return;
    }
    const next = new URLSearchParams(search);
    let changed = false;
    for (const key of keys) {
      const field = scopeFieldOfParam(key);
      if (!field) continue;
      const value = (scope as Record<string, unknown>)[field];
      const text = value === undefined || value === null || value === '' ? null : String(value);
      if (text == null) {
        if (next.has(key)) { next.delete(key); changed = true; }
      } else if (next.get(key) !== text) {
        next.set(key, text);
        changed = true;
      }
    }
    if (changed) setSearchParams(next, { replace: true });
    // search 由 setSearchParams 改变后本 effect 会再跑一次,此时 changed=false,不会循环
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [search, scopeSig, keys, setSearchParams]);

  const syncNow = useCallback(() => {
    const { search: currentSearch, scope: currentScope, keys: currentKeys } = latestRef.current;
    const next = new URLSearchParams(currentSearch);
    for (const key of currentKeys) {
      const field = scopeFieldOfParam(key);
      if (!field) continue;
      const value = (currentScope as Record<string, unknown>)[field];
      const text = value === undefined || value === null || value === '' ? null : String(value);
      if (text == null) next.delete(key);
      else next.set(key, text);
    }
    const nextSearch = next.toString();
    if (nextSearch !== currentSearch) {
      suppressWriteRef.current = false;
      setSearchParams(next, { replace: true });
    }
  }, [setSearchParams]);

  return { parsed, issues: parsed.issues, syncNow };
}
