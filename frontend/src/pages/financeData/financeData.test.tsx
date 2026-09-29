// @vitest-environment jsdom
/// <reference types="vite/client" />
/**
 * T-3 前端(AC-F05/F06/F10/F14/F19):导航入口按权限显示、@contracts 只以类型导入、
 * 标准报表冻结单元格按列类型排版、工作台财报摘要无权限时不渲染不请求。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { filterMenuByPermission, menuItems, selectedKey, pageTitle } from '../../App';
import { setSession } from '../../api/client';
import { renderCell } from '../StandardReports';
import { StatementSummaryCard } from '../dashboard/StatementSummaryCard';
import { MGMT_TABS } from '../ManagementAccounting';

const keys = (list: ReturnType<typeof filterMenuByPermission>): string[] =>
  (list ?? []).flatMap((i) => (i && 'children' in i && i.children ? [String(i.key), ...keys(i.children)] : [String(i?.key)]));

describe('T-3 导航', () => {
  it('财务数据分组 + 管理会计 + 标准报表按权限显示', () => {
    const perms = new Set(['eas:read', 'statements:read']);
    const visible = keys(filterMenuByPermission(menuItems, (p) => perms.has(p)));
    expect(visible).toEqual(expect.arrayContaining(['grp-finance', '/eas', '/statements']));
    expect(visible).not.toContain('/governance');
    expect(visible).not.toContain('/mgmt');
    expect(visible).not.toContain('/standard-reports');
    const all = new Set(['eas:read', 'governance:read', 'statements:read', 'mgmt:read', 'report:read']);
    const full = keys(filterMenuByPermission(menuItems, (p) => all.has(p), false));
    expect(full).toEqual(expect.arrayContaining(['/eas', '/governance', '/statements', '/mgmt', '/standard-reports']));
  });
  it('新路由高亮与标题', () => {
    for (const p of ['/eas', '/governance', '/statements', '/mgmt', '/standard-reports']) expect(selectedKey(p, '')).toBe(p);
    expect(pageTitle('/mgmt', '?tab=alerts', '/mgmt')).toBe('管理会计');
    expect(pageTitle('/eas', '', '/eas')).toBe('EAS 工作区');
  });
  it('管理会计八个子功能页签', () => {
    expect(MGMT_TABS.map((t) => t.label)).toEqual(['责任中心', '指标与计算', '预警', '成本分摊', '预算调整', '多维分析', '维度', '绩效']);
  });
});

describe('@contracts 共享契约只以类型导入', () => {
  it('src 下所有 @contracts 引用都是 import type / export type', () => {
    const sources = import.meta.glob<string>(['../../**/*.{ts,tsx}'], { query: '?raw', import: 'default', eager: true });
    expect(Object.keys(sources).length).toBeGreaterThan(50);
    const offenders: string[] = [];
    for (const [p, text] of Object.entries(sources)) {
      const stmts = text.match(/(?:import|export)[^;]*?from\s+'@contracts\/[^']+'/gs) ?? [];
      for (const st of stmts) if (!/^(import|export)\s+type\b/.test(st)) offenders.push(`${p}: ${st.slice(0, 80)}`);
    }
    expect(offenders).toEqual([]);
  });
});

describe('标准报表冻结单元格', () => {
  it('金额/比率按列类型字符串排版,空值为空', () => {
    expect(renderCell({ key: 'b', label: '预算', kind: 'money' }, '150.00')).toBe('150.00');
    expect(renderCell({ key: 'b', label: '预算', kind: 'money' }, '1000000.00')).toBe('1,000,000.00');
    expect(renderCell({ key: 'r', label: '执行率', kind: 'ratio' }, '0.933333')).toBe('93.33%');
    expect(renderCell({ key: 'c', label: '编码', kind: 'text' }, 'I01')).toBe('I01');
    expect(renderCell({ key: 'n', label: '条数', kind: 'integer' }, 3)).toBe('3');
    expect(renderCell({ key: 'r', label: '执行率', kind: 'ratio' }, null)).toBe('');
  });
});

describe('工作台财报摘要', () => {
  afterEach(() => { setSession(null); vi.restoreAllMocks(); });
  const render = () => renderToStaticMarkup(
    <QueryClientProvider client={new QueryClient()}><MemoryRouter><StatementSummaryCard /></MemoryRouter></QueryClientProvider>,
  );
  it('无 statements:read 时不渲染也不请求', () => {
    const fetchSpy = vi.spyOn(globalThis, 'fetch');
    setSession({ authenticated: true, csrfToken: 't', expiresAt: '', user: { id: 1, username: 'v', displayName: 'v', permissions: ['dashboard:read'], allOrgs: true, orgIds: [], mustChangePassword: false } });
    expect(render()).toBe('');
    expect(fetchSpy).not.toHaveBeenCalled();
  });
  it('有当前批次时显示总资产、资产负债率、净利润本年累计', async () => {
    setSession({ authenticated: true, csrfToken: 't', expiresAt: '', user: { id: 1, username: 'v', displayName: 'v', permissions: ['statements:read'], allOrgs: true, orgIds: [], mustChangePassword: false } });
    const client = new QueryClient();
    client.setQueryData(['stmt-overview', undefined, undefined, undefined], {
      batch: { id: 1, orgName: '上海公司', period: '2026-05' },
      metrics: { total_assets_period_end: '1000000.00', net_profit_ytd: '60000.00' },
      ratios: { debt_asset_ratio: '0.420000' },
      unitComparison: [],
    });
    const html = renderToStaticMarkup(<QueryClientProvider client={client}><MemoryRouter><StatementSummaryCard /></MemoryRouter></QueryClientProvider>);
    expect(html).toContain('1,000,000.00');
    expect(html).toContain('42.00%');
    expect(html).toContain('60,000.00');
    expect(html).toContain('上海公司 · 2026-05');
  });
});
