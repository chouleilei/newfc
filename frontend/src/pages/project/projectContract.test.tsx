// @vitest-environment jsdom
/**
 * T-4 前端(AC-F09/F15/F16/F04/F22):「项目与合同」「费用审核」导航按权限显示与高亮、
 * 工作台待办卡片按服务端返回渲染且无权限不请求、当期不可计算与形象进度缺失不以 0 冒充。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { filterMenuByPermission, menuItems, pageTitle, selectedKey } from '../../App';
import { setSession } from '../../api/client';
import { WorkbenchTodoCard } from '../dashboard/WorkbenchTodoCard';
import { PeriodValue } from './PlanExecution';

const keys = (list: ReturnType<typeof filterMenuByPermission>): string[] =>
  (list ?? []).flatMap((i) => (i && 'children' in i && i.children ? [String(i.key), ...keys(i.children)] : [String(i?.key)]));
const session = (permissions: string[]) => setSession({
  authenticated: true, csrfToken: 't', expiresAt: '',
  user: { id: 1, username: 'u', displayName: 'u', permissions, allOrgs: false, orgIds: [3], mustChangePassword: false },
});

describe('T-4 导航', () => {
  it('项目与合同、费用审核分组按权限裁剪;受限范围账号照常可见(服务端按范围裁剪)', () => {
    const viewer = new Set(['project_budget:read', 'plan:read', 'contract:read', 'expense:read']);
    const v = keys(filterMenuByPermission(menuItems, (p) => viewer.has(p), false));
    expect(v).toEqual(expect.arrayContaining(['grp-project', '/project-budget', '/plan', '/contracts', 'grp-expense', '/expense', '/expense/policies']));
    expect(v).not.toContain('/contracts/import');
    const importer = keys(filterMenuByPermission(menuItems, (p) => p === 'contract:import', true));
    expect(importer.filter((k) => /project|contract|plan|expense/.test(k))).toEqual(['grp-project', '/contracts/import']);
    expect(keys(filterMenuByPermission(menuItems, () => false))).not.toContain('grp-expense');
  });
  it('子路由高亮到对应入口,页面标题取菜单名', () => {
    expect(selectedKey('/contracts', '?todo=review')).toBe('/contracts');
    expect(selectedKey('/contracts/import', '?id=3')).toBe('/contracts/import');
    expect(selectedKey('/expense', '?status=audited')).toBe('/expense');
    expect(selectedKey('/expense/policies', '')).toBe('/expense/policies');
    expect(selectedKey('/project-budget', '')).toBe('/project-budget');
    expect(selectedKey('/plan', '')).toBe('/plan');
    expect(pageTitle('/contracts/import', '', '/contracts/import')).toBe('合同导入');
    expect(pageTitle('/expense', '', '/expense')).toBe('报销单');
  });
});

describe('工作台待办卡片', () => {
  afterEach(() => { setSession(null); vi.restoreAllMocks(); });
  const render = (client = new QueryClient()) => renderToStaticMarkup(
    <QueryClientProvider client={client}><MemoryRouter><WorkbenchTodoCard /></MemoryRouter></QueryClientProvider>,
  );
  it('无 dashboard:read 时不渲染也不请求', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    session([]);
    expect(render()).toBe('');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('没有任何待办项(无相关权限)时不渲染', () => {
    session(['dashboard:read']);
    const client = new QueryClient();
    client.setQueryData(['workbench-todos'], { items: [] });
    expect(render(client)).toBe('');
  });
  it('按服务端返回的项与计数渲染', () => {
    session(['dashboard:read']);
    const client = new QueryClient();
    client.setQueryData(['workbench-todos'], {
      items: [
        { key: 'contract_review', label: '待审核合同', count: 2, path: '/contracts?todo=review' },
        { key: 'expense_review', label: '待复核报销', count: 0, path: '/expense?status=audited' },
      ],
    });
    const html = render(client);
    expect(html).toContain('待审核合同');
    expect(html).toContain('aria-label="待审核合同 2"');
    expect(html).toContain('aria-label="待复核报销 0"');
  });
});

describe('计划执行当期值', () => {
  it('有值时显示金额;不可计算时显示「不可计算」而不是 0', () => {
    expect(renderToStaticMarkup(<PeriodValue v={{ value: '3000000.00', reason: null, previousBatchId: 1, previousPeriod: '2026-05' }} />)).toContain('3,000,000.00');
    const html = renderToStaticMarkup(<PeriodValue v={{ value: null, reason: '缺少本年累计实际', previousBatchId: null, previousPeriod: null }} />);
    expect(html).toContain('不可计算');
    expect(html).not.toContain('0.00');
  });
});
