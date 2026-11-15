// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntdApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { MemoryRouter, useLocation } from 'react-router-dom';
import { setSession } from '../../api/client';
import { contractApi, expenseApi, type ClaimDetailDto, type ExpenseQueueDto } from '../../api/projectContract';
import ExpenseClaims from './ExpenseClaims';

let client: QueryClient;
afterEach(() => { cleanup(); client?.clear(); setSession(null); vi.restoreAllMocks(); });
beforeEach(() => {
  const computedStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => computedStyle(element));
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn(() => ({
    matches: false, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })) });
});

const claim: ClaimDetailDto = {
  id: 9, claimNo: 'BX-SH-9', orgId: 3, orgName: '上海公司', applicant: '张三', department: '', expenseType: '差旅费',
  amount: '100.00', occurredDate: '2026-09-30', description: '下级组织报销', status: 'draft', conclusion: null,
  reviewVersion: 1, submitRound: 0, contentSha256: null, submittedByName: null, submittedAt: null, latestRiskLevel: null,
  createdAt: '2026-09-30', updatedAt: '2026-09-30', lines: [], attachments: [], runs: [], reviews: [], currentRunId: null,
};
const claimPage = (items: ClaimDetailDto[], page = 1, pageSize = 20, total = items.length) => ({ items, page, pageSize, total });
const queue = (submitted = 0, audited = 0): ExpenseQueueDto => ({
  counts: { draft: 0, submitted, audited, reviewed: 0, supplement: 0 }, awaitingReview: [],
});

function LocationValue() { return <output data-testid="list-location">{useLocation().search}</output>; }

function mount(url = '/expense') {
  setSession({ authenticated: true, csrfToken: 't', expiresAt: '', user: {
    id: 1, username: 'east', displayName: '华东财务', permissions: ['expense:read', 'expense:submit'],
    allOrgs: false, orgIds: [2], mustChangePassword: false,
  } });
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['org-tree'], { rows: [], tree: [{ id: 2, code: 'EAST', name: '华东', children: [{ id: 3, code: 'SH', name: '上海公司' }] }] });
  client.setQueryData(['workbench-todos'], { items: [] });
  client.setQueryData(['dashboard-domains'], {});
  render(<ConfigProvider locale={zhCN} theme={{ token: { motion: false } }}><AntdApp><QueryClientProvider client={client}>
    <MemoryRouter initialEntries={[url]}><ExpenseClaims /><LocationValue /></MemoryRouter>
  </QueryClientProvider></AntdApp></ConfigProvider>);
}

describe('费用页面日常操作 AC-F22/X04', () => {
  it('从网址恢复组织/关键词/页码,翻页保留筛选,重新检索回到第一页', async () => {
    const claims = vi.spyOn(expenseApi, 'claimsPage').mockImplementation(async (q) => claimPage([claim], q.page, q.pageSize, 501));
    vi.spyOn(expenseApi, 'queue').mockResolvedValue(queue());
    mount('/expense?orgId=3&keyword=旧事由&page=26&pageSize=20');
    expect(await screen.findByText('共 501 条')).toBeTruthy();
    expect(claims).toHaveBeenCalledWith({ orgId: 3, keyword: '旧事由', page: 26, pageSize: 20 });
    expect((screen.getByPlaceholderText('单号/申请人/事由') as HTMLInputElement).value).toBe('旧事由');
    fireEvent.click(screen.getByTitle('25'));
    await waitFor(() => expect(claims).toHaveBeenCalledWith({ orgId: 3, keyword: '旧事由', page: 25, pageSize: 20 }));
    const input = screen.getByPlaceholderText('单号/申请人/事由');
    fireEvent.change(input, { target: { value: '新事由' } });
    fireEvent.keyDown(input, { key: 'Enter', code: 'Enter', keyCode: 13 });
    await waitFor(() => expect(claims).toHaveBeenCalledWith({ orgId: 3, keyword: '新事由', page: 1, pageSize: 20 }));
    const search = screen.getByTestId('list-location').textContent!;
    expect(new URLSearchParams(search).get('orgId')).toBe('3');
    expect(new URLSearchParams(search).get('keyword')).toBe('新事由');
    expect(new URLSearchParams(search).has('page')).toBe(false);
  }, 45_000);

  it('单个授权根账号默认查询全部授权组织,首页待办深链不漏下级报销', async () => {
    const claims = vi.spyOn(expenseApi, 'claimsPage').mockResolvedValue(claimPage([{ ...claim, status: 'audited' }]));
    const counts = vi.spyOn(expenseApi, 'queue').mockResolvedValue(queue(0, 1));
    mount('/expense?status=audited');
    expect(await screen.findByText('下级组织报销')).toBeTruthy();
    expect(claims).toHaveBeenCalledWith({ status: 'audited', page: 1, pageSize: 20 });
    expect(counts).toHaveBeenCalledWith(undefined);
    expect(screen.getByText('全部授权组织')).toBeTruthy();
  });

  it('统计失败保留列表并允许重试,不显示失效计数', async () => {
    vi.spyOn(expenseApi, 'claimsPage').mockResolvedValue(claimPage([claim]));
    const counts = vi.spyOn(expenseApi, 'queue').mockRejectedValueOnce(new Error('统计服务暂不可用')).mockResolvedValue(queue());
    mount();
    expect(await screen.findByText('状态统计加载失败')).toBeTruthy();
    expect(screen.getByText('下级组织报销')).toBeTruthy();
    fireEvent.click(screen.getByText(/^重\s*试$/).closest('button')!);
    await waitFor(() => expect(screen.queryByText('状态统计加载失败')).toBeNull());
    expect(counts).toHaveBeenCalledTimes(2);
  });

  it('新建后刷新列表及状态统计,关闭详情即可找到新增单据', async () => {
    let created = false;
    const list = vi.spyOn(expenseApi, 'claimsPage').mockImplementation(async () => claimPage(created ? [claim] : []));
    const counts = vi.spyOn(expenseApi, 'queue').mockImplementation(async () => ({ ...queue(), counts: { ...queue().counts, draft: created ? 1 : 0 } }));
    const create = vi.spyOn(expenseApi, 'createClaim').mockImplementation(async () => { created = true; return claim; });
    vi.spyOn(expenseApi, 'claim').mockResolvedValue(claim);
    mount();
    await screen.findByText('没有报销单');
    fireEvent.click(screen.getByText('新建报销单').closest('button')!);
    fireEvent.change(await screen.findByLabelText('申请人'), { target: { value: '张三' } });
    fireEvent.change(screen.getByLabelText('费用类型'), { target: { value: '差旅费' } });
    fireEvent.change(screen.getByLabelText('报销金额(元)'), { target: { value: '100.00' } });
    fireEvent.click(screen.getByText(/^确\s*定$/).closest('button')!);
    await waitFor(() => expect(create).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.getByRole('row', { name: /BX-SH-9/ })).toBeTruthy());
    expect(list.mock.calls.length).toBeGreaterThan(1);
    expect(counts.mock.calls.length).toBeGreaterThan(1);
    expect(client.getQueryState(['workbench-todos'])?.isInvalidated).toBe(true);
    expect(client.getQueryState(['dashboard-domains'])?.isInvalidated).toBe(true);
  }, 45_000);

  it('详情未打开时审核完成也刷新待复核筛选,没有运行中的审核后停止轮询', async () => {
    let finished = false;
    const list = vi.spyOn(expenseApi, 'claimsPage').mockImplementation(async () => claimPage(finished ? [{ ...claim, status: 'audited' }] : []));
    const counts = vi.spyOn(expenseApi, 'queue').mockImplementation(async (): Promise<ExpenseQueueDto> => {
      if (counts.mock.calls.length > 1) finished = true;
      return finished ? queue(0, 1) : queue(1, 0);
    });
    mount('/expense?status=audited');
    expect(await screen.findByText('没有报销单')).toBeTruthy();
    await waitFor(() => expect(screen.getByText('下级组织报销')).toBeTruthy(), { timeout: 6000 });
    expect(list.mock.calls.length).toBeGreaterThan(1);
    // 等待超过下一轮周期,审核已结束不应继续发起统计请求。
    await new Promise((resolve) => setTimeout(resolve, 2200));
    expect(counts).toHaveBeenCalledTimes(2);
  }, 15_000);

  it('AC-T15-01：采购类小额报销实时展示 §8.1.7 比价提示、提交关联合同并渲染拆单与缺比价标识', async () => {
    setSession({
      authenticated: true,
      csrfToken: 't',
      expiresAt: '',
      user: {
        id: 1,
        username: 'east',
        displayName: '华东财务',
        permissions: ['expense:read', 'expense:submit', 'contract:read', 'risk:read'],
        allOrgs: false,
        orgIds: [3],
        mustChangePassword: false,
      },
    });
    client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    client.setQueryData(['org-tree'], { rows: [], tree: [{ id: 3, code: 'SH', name: '上海公司', children: [] }] });
    client.setQueryData(['workbench-todos'], { items: [] });
    client.setQueryData(['dashboard-domains'], {});

    const flaggedClaim: ClaimDetailDto = {
      ...claim,
      id: 21,
      claimNo: 'BX-SH-21',
      amount: '18000.00',
      contractId: 55,
      contractNo: 'HT-SH-2026-055',
      contractName: '水情测报备件采购合同',
      isProcurementExpense: true,
      priceCompareDocCount: 0,
      missingComparisonAlert: true,
      splitAlertHit: true,
      splitRiskEventId: 88,
    };
    vi.spyOn(expenseApi, 'claimsPage').mockResolvedValue(claimPage([flaggedClaim]));
    vi.spyOn(expenseApi, 'queue').mockResolvedValue(queue());
    vi.spyOn(expenseApi, 'claim').mockResolvedValue(flaggedClaim);
    vi.spyOn(contractApi, 'list').mockResolvedValue([
      {
        id: 55,
        contractNo: 'HT-SH-2026-055',
        name: '水情测报备件采购合同',
        orgId: 3,
        orgName: '上海公司',
        contractType: '货物采购',
        projectId: null,
        projectCode: null,
        projectName: null,
        supplierId: null,
        supplierName: null,
        originalAmount: '28000.00',
        approvedChange: '0.00',
        currentAmount: '28000.00',
        paidAmount: '0.00',
        paymentRate: '0.000000',
        stage: 'performance',
        status: 'active',
        signDate: '2026-06-01',
        startDate: null,
        endDate: null,
        version: 1,
        createdAt: '2026-06-01',
        updatedAt: '2026-06-01',
      } as any,
    ]);
    const createSpy = vi.spyOn(expenseApi, 'createClaim').mockResolvedValue(flaggedClaim);

    render(
      <ConfigProvider locale={zhCN} theme={{ token: { motion: false } }}>
        <AntdApp>
          <QueryClientProvider client={client}>
            <MemoryRouter initialEntries={['/expense']}>
              <ExpenseClaims />
            </MemoryRouter>
          </QueryClientProvider>
        </AntdApp>
      </ConfigProvider>,
    );

    expect(await screen.findByText('比价附件 0')).toBeTruthy();
    expect(screen.getByText('缺比价')).toBeTruthy();
    expect(screen.getByText('疑似连续30日拆单规避3万元限额')).toBeTruthy();

    fireEvent.click(screen.getByText('新建报销单').closest('button')!);
    fireEvent.change(await screen.findByLabelText('申请人'), { target: { value: '李四' } });
    fireEvent.change(screen.getByLabelText('费用类型'), { target: { value: '备品备件采购' } });
    fireEvent.change(screen.getByLabelText('报销金额(元)'), { target: { value: '18000.00' } });
    expect(screen.queryByText(/§8\.1\.7/)).toBeNull();

    fireEvent.click(screen.getByText('属于采购类直接报销'));
    expect(await screen.findByText(/§8\.1\.7.*3万元（含）以内直接报销项目/)).toBeTruthy();

    const ctCombo = screen.getByLabelText('关联合同(可选)');
    fireEvent.mouseDown(ctCombo);
    fireEvent.click(await screen.findByText('HT-SH-2026-055 · 水情测报备件采购合同'));

    fireEvent.click(screen.getByText(/^确\s*定$/).closest('button')!);
    await waitFor(() => expect(createSpy).toHaveBeenCalledTimes(1));
    expect(createSpy.mock.calls[0][0]).toMatchObject({
      applicant: '李四',
      expenseType: '备品备件采购',
      amount: '18000.00',
      contractId: 55,
      isProcurementExpense: true,
    });
  }, 45_000);
});
