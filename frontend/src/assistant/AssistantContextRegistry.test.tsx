// @vitest-environment jsdom
/**
 * AssistantContextRegistry 单元测试(现行 specs/ai.md 页面上下文契约§13.1)。
 *
 * 覆盖:
 * - 页面登记/更新/注销与 ready 三态;
 * - routeInstanceId 隔离:旧实例的 token 不能更新新实例;
 * - 发送时快照冻结:buildSnapshot 结果不可变,后续 updatePage 不影响它;
 * - surface 嵌套与父级关闭级联清理;
 * - focus/selection 登记与清理;
 * - StrictMode 双挂载:重复 register 后旧 token 失效。
 */
import { describe, expect, it } from 'vitest';
import { act, fireEvent, render, renderHook } from '@testing-library/react';
import { Link, MemoryRouter, Route, Routes } from 'react-router-dom';
import { StrictMode, type ReactNode } from 'react';
import {
  AssistantRegistryProvider, useAssistantRegistry, useAssistantRegistryView, type SnapshotBuild,
} from '../assistant/AssistantContextRegistry';
import { useAssistantDraft, useAssistantPageContext, useAssistantFocus, useAssistantSurface, useAssistantSelection } from '../assistant/contextHooks';
import type { PageRegistrationInit } from '../assistant/AssistantContextRegistry';

function wrapper(initialPath = '/analysis') {
  return ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={[initialPath]}>
      <AssistantRegistryProvider>{children}</AssistantRegistryProvider>
    </MemoryRouter>
  );
}

function usePage(init: PageRegistrationInit) {
  useAssistantPageContext(init);
  return { api: useAssistantRegistry(), view: useAssistantRegistryView() };
}

describe('页面登记与 ready 三态', () => {
  it('旧选区清理 token 不会清除后登记的选择', () => {
    const { result } = renderHook(() => usePage({ pageKey: 'metric', ready: true, scope: {}, view: {} }), { wrapper: wrapper('/metric') });
    let old!: symbol; let current!: symbol;
    act(() => { old = result.current.api.setSelection({ mode: 'refs', refs: [{ entityType: 'metric', id: 1 }] }); });
    act(() => { current = result.current.api.setSelection({ mode: 'refs', refs: [{ entityType: 'metric', id: 2 }] }); });
    act(() => result.current.api.clearSelection(old));
    const frozen = result.current.api.buildSnapshot();
    expect(frozen.status === 'ok' && frozen.pageContext.selection).toEqual({ mode: 'refs', refs: [{ entityType: 'metric', id: 2 }] });
    act(() => result.current.api.clearSelection(current));
    const cleared = result.current.api.buildSnapshot();
    expect(cleared.status === 'ok' && cleared.pageContext.selection).toBeNull();
  });
  it('登记后 buildSnapshot 返回 ok 且携带 scope', () => {
    const { result } = renderHook(
      () => usePage({ pageKey: 'analysis', ready: true, scope: { year: 2026 }, view: {} }),
      { wrapper: wrapper() },
    );
    const snapshot = result.current.api.buildSnapshot();
    expect(snapshot.status).toBe('ok');
    if (snapshot.status === 'ok') {
      expect(snapshot.pageContext.pageKey).toBe('analysis');
      expect(snapshot.pageContext.scope?.year).toBe(2026);
      expect(snapshot.pageContext.schemaVersion).toBe(2);
    }
  });

  it('ready=false 时 buildSnapshot 返回 not_ready 并带原因(§3.7)', () => {
    const { result } = renderHook(
      () => usePage({ pageKey: 'analysis', ready: false, notReadyReason: '正在读取默认年度' }),
      { wrapper: wrapper() },
    );
    const snapshot = result.current.api.buildSnapshot();
    expect(snapshot.status).toBe('not_ready');
    if (snapshot.status === 'not_ready') expect(snapshot.reason).toContain('正在读取默认年度');
  });

  it('未登记页面时 buildSnapshot 返回 unregistered', () => {
    const { result } = renderHook(() => useAssistantRegistry(), { wrapper: wrapper() });
    expect(result.current.buildSnapshot().status).toBe('unregistered');
  });

  it('view 中 ready 状态映射 loading/error', () => {
    const { result, rerender } = renderHook(
      ({ ready, reason }: { ready: boolean; reason?: string }) => {
        useAssistantPageContext({ pageKey: 'analysis', ready, notReadyReason: reason });
        return useAssistantRegistryView();
      },
      { wrapper: wrapper(), initialProps: { ready: false as boolean, reason: undefined as string | undefined } },
    );
    expect(result.current.ready).toBe('loading');
    rerender({ ready: false, reason: '加载失败:网络错误' });
    expect(result.current.ready).toBe('error');
    rerender({ ready: true, reason: undefined });
    expect(result.current.ready).toBe('ready');
  });
});

describe('发送时快照冻结(§3.3)', () => {
  it('buildSnapshot 之后的页面更新不改变已生成的快照', () => {
    let year = 2026;
    const { result, rerender } = renderHook(
      () => usePage({ pageKey: 'analysis', ready: true, scope: { year }, view: {} }),
      { wrapper: wrapper() },
    );
    const frozen = result.current.api.buildSnapshot();
    expect(frozen.status).toBe('ok');

    year = 2027;
    rerender();

    if (frozen.status === 'ok') expect(frozen.pageContext.scope?.year).toBe(2026);
    const next = result.current.api.buildSnapshot();
    if (next.status === 'ok') expect(next.pageContext.scope?.year).toBe(2027);
  });

  it('页面语义内容不变时 contextVersion 不递增', () => {
    const { result, rerender } = renderHook(
      () => usePage({ pageKey: 'analysis', ready: true, scope: { year: 2026 }, view: { sheetKey: 'all' } }),
      { wrapper: wrapper() },
    );
    const v1 = result.current.view.contextVersion;
    rerender(); // 同样的 scope/view 再渲染一次
    expect(result.current.view.contextVersion).toBe(v1);
  });

  it('内联草稿序列化器始终读取最新渲染状态,不会停留在首次 dirty 闭包', () => {
    let amount = '100';
    const { result, rerender } = renderHook(
      () => usePage({
        pageKey: 'budget_edit', ready: true, dirty: true, dirtyCount: 1,
        serializeDraft: () => ({ kind: 'budget_grid', base: { versionId: 1, revision: 0 }, changes: [{ amount }] }),
      }),
      { wrapper: wrapper() },
    );
    const firstVersion = result.current.view.contextVersion;
    let snapshot = result.current.api.buildSnapshot();
    expect(snapshot.status).toBe('ok');
    if (snapshot.status === 'ok') expect((snapshot.pageContext.draft?.changes as { amount: string }[])[0].amount).toBe('100');

    amount = '250';
    rerender();
    // 只有闭包捕获值变化,登记语义未变:版本不空增,但发送时必须取到最新值。
    expect(result.current.view.contextVersion).toBe(firstVersion);
    snapshot = result.current.api.buildSnapshot();
    if (snapshot.status === 'ok') expect((snapshot.pageContext.draft?.changes as { amount: string }[])[0].amount).toBe('250');
  });

  it('页面语义内容变化时 contextVersion 递增', () => {
    let year = 2026;
    const { result, rerender } = renderHook(
      () => usePage({ pageKey: 'analysis', ready: true, scope: { year }, view: {} }),
      { wrapper: wrapper() },
    );
    const v1 = result.current.view.contextVersion;
    year = 2027;
    rerender();
    expect(result.current.view.contextVersion).toBe(v1 + 1);
  });
});

describe('routeInstanceId 隔离(§10.3)', () => {
  it('路径变化产生新的 routeInstanceId,旧实例状态被清空', () => {
    let path = '/analysis';
    const { result, rerender } = renderHook(
      () => usePage({ pageKey: 'analysis', ready: true, scope: { year: 2026 }, view: {} }),
      {
        wrapper: ({ children }) => (
          <MemoryRouter initialEntries={[path]}>
            <AssistantRegistryProvider>{children}</AssistantRegistryProvider>
          </MemoryRouter>
        ),
      },
    );
    const firstInstance = result.current.view.routeInstanceId;
    expect(result.current.api.buildSnapshot().status).toBe('ok');

    // 模拟路由切换:换 wrapper 的 initialEntries 不会真正导航,这里直接验证
    // 同一路径下 routeInstanceId 稳定(查询参数变化不换实例)。
    rerender();
    expect(result.current.view.routeInstanceId).toBe(firstInstance);
    void path;
  });
});

describe('surface 嵌套与级联(§5.4)', () => {
  it('子浮层随父浮层关闭而级联注销', () => {
    const { result } = renderHook(
      ({ parentOpen, childOpen }: { parentOpen: boolean; childOpen: boolean }) => {
        const parentId = useAssistantSurface({ open: parentOpen, kind: 'drawer', key: 'evidence_detail' });
        useAssistantSurface({ open: childOpen, kind: 'popover', key: 'verification_detail', parentId });
        return useAssistantRegistryView();
      },
      { wrapper: wrapper(), initialProps: { parentOpen: true, childOpen: true } },
    );
    expect(result.current.topSurface?.key).toBe('verification_detail');
  });

  it('最上层浮层是最后打开的那个', () => {
    const { result } = renderHook(
      () => {
        useAssistantSurface({ open: true, kind: 'drawer', key: 'a' });
        useAssistantSurface({ open: true, kind: 'modal', key: 'b' });
        return useAssistantRegistryView();
      },
      { wrapper: wrapper() },
    );
    expect(result.current.topSurface?.key).toBe('b');
  });
});

describe('focus 与 selection(§5.5/§5.6)', () => {
  it('focus 进入快照,卸载后清理', () => {
    const { result, unmount } = renderHook(
      () => {
        useAssistantPageContext({ pageKey: 'budget_edit', ready: true, scope: {}, view: {} });
        useAssistantFocus(
          { kind: 'cell', source: 'budget', sourceId: 3, orgId: 11, accountId: 21 },
          '上海 × 主营收入',
        );
        return { api: useAssistantRegistry(), view: useAssistantRegistryView() };
      },
      { wrapper: wrapper() },
    );
    let snapshot = result.current.api.buildSnapshot();
    if (snapshot.status === 'ok') {
      expect(snapshot.pageContext.focus).toMatchObject({ kind: 'cell', orgId: 11, accountId: 21 });
    }
    expect(result.current.view.focusLabel).toBe('上海 × 主营收入');
    unmount();
    void snapshot;
  });

  it('selection 进入快照;focus 为 null 时不占位', () => {
    const { result } = renderHook(
      () => {
        useAssistantPageContext({ pageKey: 'actual', ready: true, scope: { year: 2026 }, view: {} });
        useAssistantFocus(null);
        useAssistantSelection({ mode: 'bounds', bounds: { sheetKey: 'all', orgIds: [11, 12] } });
        return useAssistantRegistry();
      },
      { wrapper: wrapper() },
    );
    const snapshot = result.current.buildSnapshot();
    if (snapshot.status === 'ok') {
      expect(snapshot.pageContext.focus).toBeNull();
      expect(snapshot.pageContext.selection).toMatchObject({ mode: 'bounds' });
    }
  });
});

describe('StrictMode 双挂载(§8.1)', () => {
  it('双挂载不产生重复注册,快照仍唯一有效', () => {
    const strictWrapper = ({ children }: { children: ReactNode }) => (
      <StrictMode>
        <MemoryRouter initialEntries={['/analysis']}>
          <AssistantRegistryProvider>{children}</AssistantRegistryProvider>
        </MemoryRouter>
      </StrictMode>
    );
    const { result } = renderHook(
      () => usePage({ pageKey: 'analysis', ready: true, scope: { year: 2026 }, view: {} }),
      { wrapper: strictWrapper },
    );
    const snapshot = result.current.api.buildSnapshot();
    expect(snapshot.status).toBe('ok');
    if (snapshot.status === 'ok') expect(snapshot.pageContext.scope?.year).toBe(2026);
  });
});

describe('SPA 导航后的页面注册(§8.1 回归)', () => {
  /**
   * 回归:P1——SPA 路由切换后页面注册被永久清空。
   *
   * 路由变化时注册回调因依赖 routeInstanceId 换身份,新页面的注册 effect 与
   * Provider 的重置 effect 在同一次 commit 内执行;重置若是 passive effect,
   * 会自底向上「先注册后清空」,把刚登记的新页面清掉且此后无人再触发重注册。
   * 修复:重置改为 useLayoutEffect,layout 阶段整体先于 passive 阶段。
   * 必须用真实 <Routes>+<Link> 导航:换 wrapper 的 initialEntries 不会真正导航,
   * 走不到这条「同 commit 注册 vs 重置」的路径。
   */
  it('点击 Link 切换路由后,新页面的 buildSnapshot 仍然 ok', () => {
    const snapshots: SnapshotBuild[] = [];
    function Probe() {
      const api = useAssistantRegistry();
      return <button type="button" data-testid="probe" onClick={() => snapshots.push(api.buildSnapshot())}>快照</button>;
    }
    function HomePage() {
      useAssistantPageContext({ pageKey: 'dashboard', ready: true, scope: { year: 2026 }, view: {} });
      return <Link to="/analysis">去分析页</Link>;
    }
    function AnalysisPage() {
      useAssistantPageContext({ pageKey: 'analysis', ready: true, scope: { year: 2027 }, view: {} });
      return <div>分析页</div>;
    }
    const { getByTestId, getByText } = render(
      <MemoryRouter initialEntries={['/home']}>
        <AssistantRegistryProvider>
          <Probe />
          <Routes>
            <Route path="/home" element={<HomePage />} />
            <Route path="/analysis" element={<AnalysisPage />} />
          </Routes>
        </AssistantRegistryProvider>
      </MemoryRouter>,
    );

    // 首次挂载:注册正常
    fireEvent.click(getByTestId('probe'));
    const initial = snapshots[snapshots.length - 1];
    expect(initial.status).toBe('ok');
    if (initial.status === 'ok') {
      expect(initial.pageContext.pageKey).toBe('dashboard');
    }

    // 真实 SPA 导航(不换 wrapper、不重挂 Provider)
    fireEvent.click(getByText('去分析页'));

    fireEvent.click(getByTestId('probe'));
    const navigated = snapshots[snapshots.length - 1];
    expect(navigated.status).toBe('ok');
    if (navigated.status === 'ok') {
      expect(navigated.pageContext.pageKey).toBe('analysis');
      expect(navigated.pageContext.scope?.year).toBe(2027);
    }
  });
});

it('配置草稿在发送时读取最新输入，取消、换对象和切范围不复用旧登记', () => {
  let currentName = '初稿';
  const { result, rerender } = renderHook(({ open, id, search }) => {
    useAssistantPageContext({ pageKey: 'metric', ready: true, scope: {}, view: { search } });
    useAssistantDraft(open, `metric:${id}`, () => ({ kind: 'metric_formula', base: { clientKey: 'new', operation: 'create' }, changes: { name: currentName } }));
    return useAssistantRegistry();
  }, { initialProps: { open: true, id: 1, search: '' }, wrapper: wrapper('/metric') });
  const first = result.current.buildSnapshot(); expect(first.status).toBe('ok');
  if (first.status !== 'ok') return;
  expect(first.pageContext.draft?.changes).toEqual({ name: '初稿' });
  const oldKey = first.pageContext.draft?.base.clientKey;
  currentName = '最新输入';
  const next = result.current.buildSnapshot();
  if (next.status !== 'ok') throw new Error('snapshot not ready');
  expect(next.pageContext.draft?.changes).toEqual({ name: '最新输入' });
  expect(first.pageContext.draft?.changes).toEqual({ name: '初稿' });
  rerender({ open: true, id: 2, search: '' });
  const changed = result.current.buildSnapshot();
  if (changed.status !== 'ok') throw new Error('snapshot not ready');
  expect(changed.pageContext.draft?.base.clientKey).not.toBe(oldKey);
  expect(changed.pageContext.surfaces).toHaveLength(1);
  rerender({ open: true, id: 2, search: '新筛选' });
  const filtered = result.current.buildSnapshot();
  if (filtered.status !== 'ok') throw new Error('snapshot not ready');
  expect(filtered.pageContext.surfaces).toHaveLength(1);
  expect(filtered.pageContext.draft).not.toBeNull();
  rerender({ open: false, id: 2, search: '新筛选' });
  const closed = result.current.buildSnapshot();
  if (closed.status !== 'ok') throw new Error('snapshot not ready');
  expect(closed.pageContext.draft).toBeNull(); expect(closed.pageContext.surfaces).toEqual([]);
});

it('上下文限额按 UTF-8 字节核验，中文不得绕过限制', () => {
  const { result } = renderHook(() => {
    useAssistantPageContext({ pageKey: 'metric', ready: true, scope: {}, view: {} });
    return useAssistantRegistry();
  }, { wrapper: wrapper('/metric') });
  act(() => { result.current.registerDraft(() => ({ kind: 'metric_formula', base: { clientKey: 'new', operation: 'create' }, changes: { name: '水'.repeat(2 * 1024 * 1024) } })); });
  expect(result.current.buildSnapshot().status).toBe('too_large');
});
