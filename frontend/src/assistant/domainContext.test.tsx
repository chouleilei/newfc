// @vitest-environment jsdom
import { describe, expect, it } from 'vitest';
import { act, renderHook } from '@testing-library/react';
import { MemoryRouter } from 'react-router-dom';
import type { ReactNode } from 'react';
import { AssistantRegistryProvider, useAssistantRegistry } from './AssistantContextRegistry';
import { useAssistantDomainPage } from './contextHooks';
import { permittedPagePrompts } from './pageContext';
import { buildScopeSearch, parseWorkspaceScope } from '../utils/workspaceScope';

describe('跨域页面范围与推荐问题', () => {
  it('同一个 id/batchId 按页面进入不同命名空间，URL 往返不串为经营预算版本', () => {
    for (const [page, key, field] of [['contracts','id','contractId'], ['expense','id','claimId'], ['forecast','versionId','forecastVersionId'], ['statements','batchId','statementBatchId'], ['project_budget','batchId','projectBudgetBatchId'], ['plan','batchId','planBatchId'], ['feasibility','reportId','feasReportId']] as const) {
      const parsed = parseWorkspaceScope(page, `?${key}=17`);
      expect(parsed.scope).toEqual({ [field]: 17 }); expect(parsed.issues).toEqual([]);
      expect(buildScopeSearch(page, parsed.scope)).toBe(`${key}=17`);
      expect(parsed.scope.budgetVersionId).toBeUndefined();
    }
    expect(parseWorkspaceScope('contracts', '?id=oops').issues[0].reason).toBe('invalid_format');
  });
  it('只有费用权限时综合推荐可用费用查询，预算/合同问题不出现', () => {
    const allowed = (p: string) => p === 'expense:read';
    expect(permittedPagePrompts('assistant', allowed).join(' ')).toContain('报销');
    expect(permittedPagePrompts('assistant', allowed).join(' ')).not.toMatch(/预算执行|合同金额/);
    expect(permittedPagePrompts('contracts', allowed)).toEqual([]);
  });
  it('切换可见页签清理旧页签对象，发送快照冻结当时期间和版本', () => {
    const wrapper = ({ children }: { children: ReactNode }) => <MemoryRouter initialEntries={['/forecast']}><AssistantRegistryProvider>{children}</AssistantRegistryProvider></MemoryRouter>;
    const h = renderHook(({ reviews }: { reviews: boolean }) => {
      useAssistantDomainPage({ pageKey: 'forecast', ready: true, scope: { modelId: 8 }, view: { tab: 'models' } }, !reviews);
      useAssistantDomainPage({ pageKey: 'forecast', ready: true, scope: { forecastVersionId: 19 }, view: { tab: 'reviews' } }, reviews);
      return useAssistantRegistry();
    }, { wrapper, initialProps: { reviews: false } });
    const first = h.result.current.buildSnapshot(); if (first.status !== 'ok') throw new Error('页面未就绪'); expect(first.pageContext.scope?.modelId).toBe(8);
    act(() => h.rerender({ reviews: true }));
    const next = h.result.current.buildSnapshot(); if (next.status !== 'ok') throw new Error('页签未就绪');
    expect(next.pageContext?.scope).toEqual({ forecastVersionId: 19 });
    expect(next.pageContext.view?.tab).toBe('reviews'); expect(first.pageContext.scope?.modelId).toBe(8);
    act(() => h.rerender({ reviews: false }));
    const restored = h.result.current.buildSnapshot(); if (restored.status !== 'ok') throw new Error('页签未恢复'); expect(restored.pageContext.scope).toEqual({ modelId: 8 });
  });
});
