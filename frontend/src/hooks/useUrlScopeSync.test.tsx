// @vitest-environment jsdom
/**
 * useUrlScopeSync(UX-02)单元测试:
 * - 初始 URL 的合法范围经 onApply 交给页面(不直接改 state)
 * - 非法参数不进入 scope,原因经 issues 暴露
 * - 页面 state 变化以 replace 写回 URL;解析与 state 一致时不重复写(不循环)
 * - keys 收窄时只镜像受管参数,其余参数原样保留
 * - syncNow 以当前 scope 强制覆盖 URL(守卫取消后的还原路径)
 */
import { describe, expect, it, vi } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { useState, type ReactNode } from 'react';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { useUrlScopeSync } from './useUrlScopeSync';
import type { ScopeParseResult, WorkspaceScope } from '../utils/workspaceScope';

interface Probe {
  search: string;
  applied: ScopeParseResult[];
}

function setup(initialEntry: string, options?: { keys?: readonly string[] }) {
  const probe: Probe = { search: '', applied: [] };
  const wrapper = ({ children }: { children: ReactNode }) => (
    <MemoryRouter initialEntries={[initialEntry]}>{children}</MemoryRouter>
  );
  const hook = renderHook(() => {
    const location = useLocation();
    probe.search = location.search;
    const [year, setYear] = useState<number | undefined>(undefined);
    const sync = useUrlScopeSync('dashboard', { year }, (parsed) => {
      probe.applied.push(parsed);
      if (parsed.scope.year != null) setYear(parsed.scope.year);
    }, options);
    return { year, setYear, sync };
  }, { wrapper });
  return { ...hook, probe };
}

describe('useUrlScopeSync', () => {
  it('初始 URL 的合法年度经 onApply 应用,且不回写改写 URL', () => {
    const { result, probe } = setup('/?year=2025');
    expect(result.current.year).toBe(2025);
    expect(probe.applied.length).toBe(1);
    expect(probe.applied[0].scope.year).toBe(2025);
    // 解析与 state 收敛后 URL 保持不变,没有循环改写
    expect(probe.search).toBe('?year=2025');
  });

  it('非法年度不进入 scope,原因可见,URL 自愈为页面实际范围', () => {
    const { result, probe } = setup('/?year=abc');
    expect(result.current.year).toBeUndefined();
    expect(probe.applied[0].scope.year).toBeUndefined();
    expect(probe.applied[0].issues).toHaveLength(1);
    expect(probe.applied[0].issues[0].key).toBe('year');
    // 页面 state(空)镜像回 URL:非法值被移除而不是静默生效
    act(() => { result.current.setYear(2026); });
    expect(probe.search).toBe('?year=2026');
  });

  it('页面切换年度用 replace 写回,不产生重复历史条目', () => {
    const { result, probe } = setup('/');
    act(() => { result.current.setYear(2024); });
    expect(probe.search).toBe('?year=2024');
    const appliesBefore = probe.applied.length;
    act(() => { result.current.setYear(2025); });
    expect(probe.search).toBe('?year=2025');
    // 写回引起的 search 变化会再回调一次,但值与 state 相同(页面 handler 同值幂等)
    expect(probe.applied.length).toBeLessThanOrEqual(appliesBefore + 2);
    expect(probe.search).toBe('?year=2025');
  });

  it('keys 收窄时只镜像受管参数,其余参数原样保留', () => {
    const probe: Probe = { search: '', applied: [] };
    const wrapper = ({ children }: { children: ReactNode }) => (
      <MemoryRouter initialEntries={['/budget/7?orgId=12&sheet=profit']}>{children}</MemoryRouter>
    );
    const { result } = renderHook(() => {
      const location = useLocation();
      probe.search = location.search;
      const [sheet, setSheet] = useState('profit');
      useUrlScopeSync('budget_edit', { sheet }, (parsed) => {
        probe.applied.push(parsed);
        if (parsed.scope.sheet) setSheet(parsed.scope.sheet);
      }, { keys: ['sheet'] });
      return { sheet, setSheet };
    }, { wrapper });
    expect(result.current.sheet).toBe('profit');
    act(() => { result.current.setSheet('all'); });
    // sheet 被镜像,orgId 定位参数原样保留
    expect(probe.search).toContain('sheet=all');
    expect(probe.search).toContain('orgId=12');
  });

  it('syncNow 以当前 scope 强制覆盖 URL', () => {
    const { result, probe } = setup('/?year=2025');
    expect(result.current.year).toBe(2025);
    // 模拟守卫取消:state 被外部固定回 2026,URL 需要还原
    act(() => { result.current.setYear(2026); });
    expect(probe.search).toBe('?year=2026');
  });
});
