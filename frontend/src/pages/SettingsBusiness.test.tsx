// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntdApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import SettingsBusiness from './SettingsBusiness';
import { api, setSession } from '../api/client';
import { businessSettingsApi } from '../api/systemSettings';

beforeEach(() => {
  const computedStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => computedStyle(element));
  Object.defineProperty(window, 'matchMedia', {
    configurable: true,
    value: vi.fn().mockImplementation((query: string) => ({
      matches: false,
      media: query,
      onchange: null,
      addListener: vi.fn(),
      removeListener: vi.fn(),
      addEventListener: vi.fn(),
      removeEventListener: vi.fn(),
      dispatchEvent: vi.fn(),
    })),
  });
});

afterEach(() => {
  cleanup();
  setSession(null);
  vi.restoreAllMocks();
});

const MOCK_SETTINGS = [
  {
    key: 'contract.legal_entity_org_ids',
    label: '二级法人组织节点ID',
    group: '合同',
    type: 'string',
    value: '',
    defaultValue: '',
    isDefault: true,
    updatedAt: null,
  },
  {
    key: 'contract.prior_year_net_assets',
    label: '法人年度净资产',
    group: '合同',
    type: 'string',
    value: '',
    defaultValue: '',
    isDefault: true,
    updatedAt: null,
  },
  {
    key: 'contract.change_or_mode',
    label: '合同变更分级比例与限额口径',
    group: '合同',
    type: 'enum',
    value: 'min',
    defaultValue: 'min',
    isDefault: true,
    options: [{ value: 'min', label: '孰低从严' }, { value: 'max', label: '孰高' }],
    updatedAt: null,
  },
  {
    key: 'contract.legal_review_categories',
    label: '智能法审启用合同类别',
    group: '合同',
    type: 'string',
    value: 'goods_procurement,small_construction,construction,tech_service,general_service,important_special',
    defaultValue: 'goods_procurement,small_construction,construction,tech_service,general_service,important_special',
    isDefault: true,
    updatedAt: null,
  },
  {
    key: 'calendar.holidays',
    label: '法定休息日',
    group: '日历',
    type: 'string',
    value: '2026-10-01',
    defaultValue: '',
    isDefault: false,
    updatedAt: null,
  },
  {
    key: 'calendar.workdays',
    label: '调休工作日',
    group: '日历',
    type: 'string',
    value: '2026-10-10',
    defaultValue: '',
    isDefault: false,
    updatedAt: null,
  },
  {
    key: 'integration.pdf_parser_base_url',
    label: 'PDF 解析服务地址',
    group: '集成',
    type: 'string',
    value: 'http://127.0.0.1:8090',
    defaultValue: '',
    isDefault: false,
    updatedAt: null,
  },
];

const MOCK_ORG_ROWS = [
  { id: 1, parent_id: null, code: 'ORG_HQ', name: '集团本部', status: 'active', org_kind: 'legal_entity' },
  { id: 2, parent_id: 1, code: 'ORG_SUB_A', name: '甲二级法人', status: 'active', org_kind: 'legal_entity' },
  { id: 3, parent_id: 1, code: 'ORG_SUB_B', name: '乙二级法人', status: 'active', org_kind: 'legal_entity' },
  { id: 4, parent_id: 1, code: 'ORG_DEPT', name: '财务部', status: 'active', org_kind: 'hq_dept' },
];

describe('F-GAP-03 SettingsBusiness 专控编辑器、净资产可视化与 PDF 连通性探活', () => {
  it('渲染净资产缺失警告横幅、一键填入在运二级法人、结构化净资产 JSON 序列化与 PDF 连通性自检', { timeout: 30_000 }, async () => {
    setSession({
      authenticated: true,
      csrfToken: 'csrf-gap03',
      expiresAt: '',
      user: {
        id: 1,
        username: 'admin',
        displayName: '管理员',
        permissions: ['settings:manage'],
        allOrgs: true,
        orgIds: [],
        mustChangePassword: false,
      },
    });

    vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
      if (path === '/settings/business') return { items: MOCK_SETTINGS } as never;
      if (path === '/org/tree') return { rows: MOCK_ORG_ROWS } as never;
      return { items: [] } as never;
    });
    const putSpy = vi.spyOn(api, 'put').mockResolvedValue({ items: MOCK_SETTINGS } as never);
    const probeSpy = vi.spyOn(businessSettingsApi, 'testPdfParser').mockResolvedValue({
      ok: true,
      status: 200,
      latencyMs: 18,
      message: 'healthy',
    });

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <ConfigProvider locale={zhCN} theme={{ token: { motion: false } }}>
        <AntdApp>
          <QueryClientProvider client={qc}>
            <MemoryRouter initialEntries={['/settings/business']}>
              <SettingsBusiness />
            </MemoryRouter>
          </QueryClientProvider>
        </AntdApp>
      </ConfigProvider>,
    );

    // 1. 净资产未配置告警横幅
    await waitFor(() => {
      expect(screen.getByText(/法人上年净资产尚未完整配置/)).toBeTruthy();
    });

    // 2. 一键填入全部在运二级法人（自动排除集团根与本部部门，填入 2,3）
    fireEvent.click(screen.getByText('一键填入全部在运二级法人'));

    // 3. 新增法人净资产行并录入两位小数金额
    fireEvent.click(screen.getByText('+ 新增法人净资产行'));
    const amountInput = screen.getByPlaceholderText('如 50000000.00');
    fireEvent.change(amountInput, { target: { value: '60000000.00' } });

    // 4. PDF 连通性探活反馈
    fireEvent.click(screen.getByText('测试连通性'));
    await waitFor(() => {
      expect(probeSpy).toHaveBeenCalledWith('http://127.0.0.1:8090');
      expect(screen.getByText('在线 18ms')).toBeTruthy();
    });

    // 5. 点击保存，校验 JSON 序列化与二级法人逗号列表
    fireEvent.click(screen.getByText(/^保\s*存$/).closest('button')!);
    await waitFor(() => expect(putSpy).toHaveBeenCalledTimes(1));
    const savedBody = putSpy.mock.calls[0][1] as Record<string, unknown>;
    expect(savedBody['contract.legal_entity_org_ids']).toBe('2,3');
    const parsedNetAssets = JSON.parse(String(savedBody['contract.prior_year_net_assets']));
    expect(parsedNetAssets).toEqual([
      { orgId: 2, year: new Date().getFullYear() - 1, amount: '60000000.00' },
    ]);
  });
});
