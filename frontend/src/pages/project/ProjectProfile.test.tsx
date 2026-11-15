// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntdApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { MemoryRouter, Route, Routes } from 'react-router-dom';
import { api, setSession } from '../../api/client';
import { contractApi, planApi } from '../../api/projectContract';
import { projectProfileApi, type ProjectProfileDto } from '../../api/projectProfile';
import { AssistantRegistryProvider, useAssistantRegistry } from '../../assistant/AssistantContextRegistry';
import { useAssistantDomainPage } from '../../assistant/contextHooks';
import { ContractBaseFormModal } from './ContractBaseFormModal';
import ProjectProfile from './ProjectProfile';

let client: QueryClient;
afterEach(() => {
  cleanup();
  client?.clear();
  setSession(null);
  vi.restoreAllMocks();
});

beforeEach(() => {
  const computedStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => computedStyle(element));
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn(() => ({
      matches: false,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
    })),
  });
});

describe('F-GAP-21 项目档案双向钻取与合同 UX-26 助手草稿预填 (AC-T15-03, AC-T15-04)', () => {
  it('AC-T15-03：点击综合计划卡片已挂接合同切换至合同页签按 planItemId 过滤，风险页签支持跳转关联合同', async () => {
    const profile: ProjectProfileDto = {
      project: {
        id: 15,
        code: 'PRJ-T15-01',
        name: '枢纽水闸自动化更新工程',
        orgId: 3,
        orgName: '东区水务分公司',
        projectType: '技改工程',
        status: 'active',
        extra: {},
        createdAt: '2026-01-01',
        updatedAt: '2026-06-30',
      },
      budget: null,
      plan: {
        batch: { id: 1, year: 2026, actualPeriod: '2026-06' },
        items: [
          {
            itemId: 301,
            sheetCode: 'investment',
            itemName: '主闸门启闭控制柜更新',
            orgName: '东区水务分公司',
            linkedContractCount: 1,
            linkedContractAmount: '320000.50',
            facts: [{ key: 'annual_plan', label: '本年计划投资', valueType: 'amount', value: '500000.00' }],
          },
        ],
      },
      contracts: {
        count: 2,
        currentTotal: '420000.50',
        settledTotal: '0.00',
        paidTotal: '100000.00',
        paidRate: '0.238095',
        rows: [
          {
            id: 77,
            contractNo: 'HT-T15-077',
            name: '主闸门控制柜采购合同',
            supplierName: '智控设备供应商',
            orgName: '东区水务分公司',
            stage: 'performance',
            status: 'active',
            direction: 'expense',
            planItemId: 301,
            planItemName: '主闸门启闭控制柜更新',
            current: '320000.50',
            paid: '100000.00',
            signDate: '2026-05-12',
            documents: {},
          },
          {
            id: 78,
            contractNo: 'HT-T15-078',
            name: '零星监测电缆采购合同',
            supplierName: '线缆配件供应商',
            orgName: '东区水务分公司',
            stage: 'performance',
            status: 'active',
            direction: 'expense',
            planItemId: 302,
            planItemName: '厂区零星辅助技改',
            current: '100000.00',
            paid: '0.00',
            signDate: '2026-05-20',
            documents: {},
          },
        ],
        payments: [],
      },
      vouchers: null,
      risks: {
        openCount: 1,
        total: 1,
        rows: [
          {
            id: 501,
            ruleCode: 'CW_01',
            ruleName: '合同履约节点跟踪',
            level: 'medium',
            status: 'open',
            title: '控制柜合同节点待验收',
            amount: '320000.50',
            lastDetectedAt: '2026-06-30T00:00:00Z',
            subjectType: 'contract',
            subjectId: 77,
            contractId: 77,
          },
        ],
      },
      investment: null,
      reports: null,
      logs: null,
      generatedAt: '2026-06-30T00:00:00Z',
    };

    vi.spyOn(projectProfileApi, 'get').mockResolvedValue(profile);
    client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });

    render(
      <ConfigProvider locale={zhCN} theme={{ token: { motion: false } }}>
        <AntdApp>
          <QueryClientProvider client={client}>
            <MemoryRouter initialEntries={['/projects/15']}>
              <Routes>
                <Route path="/projects/:id" element={<ProjectProfile />} />
              </Routes>
            </MemoryRouter>
          </QueryClientProvider>
        </AntdApp>
      </ConfigProvider>,
    );

    expect(await screen.findByText(/已挂接合同：1 份/)).toBeTruthy();
    expect(screen.getByText('320,000.50')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: '查看挂接合同' }));
    expect(await screen.findByText(/当前按综合计划项筛选：主闸门启闭控制柜更新/)).toBeTruthy();
    expect(screen.getByText('HT-T15-077')).toBeTruthy();
    expect(screen.queryByText('HT-T15-078')).toBeNull();

    fireEvent.click(screen.getByRole('button', { name: '清除筛选' }));
    expect(await screen.findByText('HT-T15-078')).toBeTruthy();

    fireEvent.click(screen.getByRole('tab', { name: /风险\(1\/1\)/ }));
    const ctLink = await screen.findByRole('link', { name: '查看合同 #77' });
    expect(ctLink.getAttribute('href')).toBe('/contracts?id=77');
  });

  it('AC-T15-04：ContractBaseFormModal 登记 contract_draft 且采纳助手草稿仅更新内存表单、零自动 POST', async () => {
    setSession({
      authenticated: true,
      csrfToken: 'csrf-ct',
      expiresAt: '',
      user: {
        id: 1,
        username: 'admin',
        displayName: '管理员',
        permissions: ['contract:read', 'contract:write'],
        allOrgs: true,
        orgIds: [],
        mustChangePassword: false,
      },
    });
    client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    client.setQueryData(['org-tree'], {
      rows: [],
      tree: [{ id: 3, code: 'SH', name: '东区水务分公司', children: [] }],
    });
    vi.spyOn(api, 'get').mockImplementation(async (url: string) => {
      if (url.startsWith('/master/')) return [];
      return [];
    });
    vi.spyOn(contractApi, 'list').mockResolvedValue([]);
    vi.spyOn(contractApi, 'prefixMap').mockResolvedValue([]);
    vi.spyOn(planApi, 'batches').mockResolvedValue([]);
    const createSpy = vi.spyOn(contractApi, 'create');

    let capturedRegistry: ReturnType<typeof useAssistantRegistry> | null = null;
    function Harness() {
      useAssistantDomainPage({ pageKey: 'contracts', ready: true });
      capturedRegistry = useAssistantRegistry();
      return <ContractBaseFormModal open onClose={() => undefined} onSaved={() => undefined} />;
    }

    render(
      <ConfigProvider locale={zhCN} theme={{ token: { motion: false } }}>
        <AntdApp>
          <QueryClientProvider client={client}>
            <MemoryRouter initialEntries={['/contracts']}>
              <AssistantRegistryProvider>
                <Harness />
              </AssistantRegistryProvider>
            </MemoryRouter>
          </QueryClientProvider>
        </AntdApp>
      </ConfigProvider>,
    );

    await screen.findByText('新建合同');
    const snap = capturedRegistry!.buildSnapshot();
    expect(snap.status).toBe('ok');
    if (snap.status === 'ok') {
      expect(snap.pageContext.draft?.kind).toBe('contract_draft');
      expect(snap.pageContext.draft?.base.operation).toBe('create');
    }

    act(() => {
      window.dispatchEvent(
        new CustomEvent('newfc:assistant-apply-draft', {
          detail: {
            kind: 'contract_draft',
            suggestedFields: {
              contractNo: 'GRP-GC-001/2026-009',
              budgetType: 'single_listed',
              countersignDepts: ['财务部', '法务合规', '安全生产部'],
            },
          },
        }),
      );
    });

    expect(await screen.findByText('助手建议草稿 · 待人工确认')).toBeTruthy();
    await waitFor(() => {
      expect((screen.getByLabelText('合同编号') as HTMLInputElement).value).toBe('GRP-GC-001/2026-009');
    });
    expect(createSpy).not.toHaveBeenCalled();
  });
});
