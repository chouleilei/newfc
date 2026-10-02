// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntdApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { setSession } from '../../api/client';
import { projectBudgetApi, type PbBatchDto, type PbSummaryDto } from '../../api/projectContract';
import ProjectBudget from './ProjectBudget';

let client: QueryClient;
afterEach(() => { cleanup(); client?.clear(); setSession(null); vi.restoreAllMocks(); });
beforeEach(() => {
  const computedStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => computedStyle(element));
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn(() => ({
    matches: false, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })) });
});

const totals = { budget: '100.00', executed: '0.00', remaining: '100.00', executionRate: '0.000000' };
const batch = (id: number, name: string, year = 2026): PbBatchDto => ({
  id, name, year, period: `${year}-09`, fileName: 'budget.xlsx', fileSha256: 'hash', status: 'imported', isCurrent: false,
  rowCount: 1, totals, partial: false, orgNames: ['上海'], version: 1, createdAt: '2026-09-30', activatedAt: null, voidedAt: null, voidReason: null,
});
const summary = (b: PbBatchDto | null = null): PbSummaryDto => ({
  batch: b, year: b?.year ?? 2026, period: b?.period ?? null, totals,
  byProject: [], byOrg: [], byFundSource: [], notes: [],
});

function NextLink() {
  const navigate = useNavigate();
  return <button onClick={() => navigate('/project-budget?batchId=2')}>打开另一批次</button>;
}
function mount(url: string) {
  setSession({ authenticated: true, csrfToken: 't', expiresAt: '', user: {
    id: 1, username: 'u', displayName: '预算维护', permissions: ['project_budget:read', 'project_budget:write'],
    allOrgs: true, orgIds: [], mustChangePassword: false,
  } });
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['org-tree'], { rows: [], tree: [] });
  render(<ConfigProvider locale={zhCN} theme={{ token: { motion: false } }}><AntdApp><QueryClientProvider client={client}>
    <MemoryRouter initialEntries={[url]}><ProjectBudget /><NextLink /></MemoryRouter>
  </QueryClientProvider></AntdApp></ConfigProvider>);
}

describe('预算批次分页与操作 AC-F09/F26', () => {
  it('深链按 ID 直接加载旧批次,切换深链不会复用另一批次缓存', async () => {
    const old = batch(1, '2025 历史批次', 2025);
    const other = batch(2, '2024 另一批次', 2024);
    const get = vi.spyOn(projectBudgetApi, 'batch').mockImplementation(async (id) => id === 1 ? old : other);
    const legacy = vi.spyOn(projectBudgetApi, 'batches');
    const list = vi.spyOn(projectBudgetApi, 'batchesPage').mockImplementation(async (q) => ({ items: [], total: 0, page: 1, pageSize: q.pageSize }));
    vi.spyOn(projectBudgetApi, 'summary').mockResolvedValue(summary());
    vi.spyOn(projectBudgetApi, 'entries').mockResolvedValue([]);
    mount('/project-budget?batchId=1');
    expect(await screen.findByText('2025 历史批次 · 明细')).toBeTruthy();
    expect(get).toHaveBeenCalledWith(1);
    await waitFor(() => expect(list).toHaveBeenCalledWith(expect.objectContaining({ year: 2025 })));
    expect(legacy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('打开另一批次'));
    expect(await screen.findByText('2024 另一批次 · 明细')).toBeTruthy();
    expect(get).toHaveBeenCalledWith(2);
    await waitFor(() => expect(list).toHaveBeenCalledWith(expect.objectContaining({ year: 2024 })));
  }, 20_000);

  it('批次加载失败保留深链并提供重试,成功后展示明细', async () => {
    const get = vi.spyOn(projectBudgetApi, 'batch').mockRejectedValueOnce(new Error('临时失败')).mockResolvedValue(batch(1, '重试批次'));
    vi.spyOn(projectBudgetApi, 'batchesPage').mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 10 });
    vi.spyOn(projectBudgetApi, 'summary').mockResolvedValue(summary());
    vi.spyOn(projectBudgetApi, 'entries').mockResolvedValue([]);
    mount('/project-budget?batchId=1');
    expect(await screen.findByText('指定批次加载失败')).toBeTruthy();
    fireEvent.click(screen.getByText(/^重\s*试$/).closest('button')!);
    expect(await screen.findByText('重试批次 · 明细')).toBeTruthy();
    expect(get).toHaveBeenCalledTimes(2);
  }, 20_000);

  it('激活前读取当前期间的生效批次并明确确认;取消不写入,确认带期望 ID', async () => {
    const target = batch(9, '准备激活的新批次');
    const current = { ...batch(77, '分页外的当前批次'), isCurrent: true };
    vi.spyOn(projectBudgetApi, 'batchesPage').mockResolvedValue({ items: [target], total: 401, page: 1, pageSize: 10 });
    const overview = vi.spyOn(projectBudgetApi, 'summary').mockImplementation(async (q) => summary(q.period ? current : null));
    const activate = vi.spyOn(projectBudgetApi, 'activate').mockResolvedValue({ ...target, isCurrent: true });
    mount('/project-budget?year=2026');
    await screen.findByText('共 401 条');
    const activationButton = () => screen.getByText(/^激\s*活$/).closest('button')!;
    const open = () => fireEvent.click(activationButton());
    open();
    const dialog = (await screen.findByText('激活批次 #9')).closest('.ant-modal-content') as HTMLElement;
    expect(overview).toHaveBeenCalledWith({ year: 2026, period: '2026-09' });
    expect(within(dialog).getByText(/当前批次 #77/)).toBeTruthy();
    fireEvent.click(within(dialog).getByText(/^取\s*消$/).closest('button')!);
    await waitFor(() => expect(screen.queryByText('激活批次 #9')).toBeNull());
    expect(activate).not.toHaveBeenCalled();
    await waitFor(() => expect(activationButton().disabled).toBe(false));
    open();
    const confirm = (await screen.findByText('激活批次 #9')).closest('.ant-modal-content') as HTMLElement;
    fireEvent.click(within(confirm).getByText(/^激\s*活$/).closest('button')!);
    await waitFor(() => expect(activate).toHaveBeenCalledWith(9, 77));
  }, 30_000);
});
