// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntdApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { MemoryRouter } from 'react-router-dom';
import { setSession } from '../../api/client';
import { easApi, type EasContractReconDto } from '../../api/financeData';
import EasWorkspace from './EasWorkspace';

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

describe('F-GAP-20 EAS 合同质保金与在建工程遗留对账页签 (AC-T15-02)', () => {
  it('第 5 页签展示 2241 逾期质保金、往来负余额、1604 在建工程遗留并支持登记核对说明', async () => {
    setSession({
      authenticated: true,
      csrfToken: 'csrf-eas',
      expiresAt: '',
      user: {
        id: 1,
        username: 'admin',
        displayName: '财务主管',
        permissions: ['eas:read', 'eas:import', 'contract:read', 'master:read'],
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

    const reconPayload: EasContractReconDto = {
      orgId: 3,
      orgName: '东区水务分公司',
      period: '2026-06',
      hasActiveBalanceBatch: true,
      summary: {
        totalCount: 3,
        unresolvedCount: 3,
        byCategory: {
          warranty_2241_overdue: { count: 1, totalAbsAmount: '45000.00' },
          supplier_negative_balance: { count: 1, totalAbsAmount: '12000.50' },
          cip_1604_legacy: { count: 1, totalAbsAmount: '680000.00' },
        },
      },
      items: [
        {
          targetKey: '2241:CT-101',
          category: 'warranty_2241_overdue',
          accountCode: '224101',
          accountName: '其他应付款-质量保证金',
          supplierName: '华中机电设备公司',
          supplierId: 21,
          projectCode: 'PRJ-EAS-01',
          projectName: '闸门自动化升级工程',
          contractId: 101,
          contractNo: 'HT-EAS-2025-101',
          contractName: '闸门设备采购合同',
          projectId: 12,
          bookBalance: '45000.00',
          statusSummary: '质保期满验收合格 (2026-04-10)',
          overdueDays: 81,
          anomalyReason: '质保期满验收合格已逾 81 天，账面 2241 质保金余额仍未清零',
          voucherRefs: ['记-202512-0019'],
          reconStatus: 'pending',
          voucherRef: '',
          note: '',
          noteUpdatedAt: null,
          noteUpdatedByName: null,
        },
        {
          targetKey: 'neg:220201:SUP-02',
          category: 'supplier_negative_balance',
          accountCode: '220201',
          accountName: '应付账款-工程款',
          supplierName: '东海建筑安装单位',
          supplierId: 22,
          projectCode: null,
          projectName: null,
          contractId: null,
          contractNo: null,
          contractName: null,
          projectId: null,
          bookBalance: '-12000.50',
          statusSummary: '贷方科目出现借方净额',
          overdueDays: null,
          anomalyReason: '应付账款期末出现负余额 -12000.50 元，疑似预付未重分类或串户冲销',
          voucherRefs: [],
          reconStatus: 'pending',
          voucherRef: '',
          note: '',
          noteUpdatedAt: null,
          noteUpdatedByName: null,
        },
        {
          targetKey: '1604:PRJ-EAS-01:160401',
          category: 'cip_1604_legacy',
          accountCode: '160401',
          accountName: '在建工程-建筑安装工程',
          supplierName: null,
          supplierId: null,
          projectCode: 'PRJ-EAS-01',
          projectName: '闸门自动化升级工程',
          contractId: null,
          contractNo: null,
          contractName: null,
          projectId: 12,
          bookBalance: '680000.00',
          statusSummary: '已确认竣工决算版本',
          overdueDays: null,
          anomalyReason: '关联投资控制项目已完成竣工决算确认，但 EAS 1604 在建工程仍有余额未转固',
          voucherRefs: [],
          reconStatus: 'pending',
          voucherRef: '',
          note: '',
          noteUpdatedAt: null,
          noteUpdatedByName: null,
        },
      ],
    };

    vi.spyOn(easApi, 'contractRecon').mockResolvedValue(reconPayload);
    const saveNoteSpy = vi.spyOn(easApi, 'saveContractReconNote').mockResolvedValue({
      id: 1,
      orgId: 3,
      period: '2026-06',
      category: 'warranty_2241_overdue',
      targetKey: '2241:CT-101',
      reconStatus: 'to_writeoff',
      voucherRef: '记-202606-0088',
      note: '已核对质保复验单，安排下月付款清账',
      updatedByName: '财务主管',
      updatedAt: '2026-06-30T10:00:00Z',
    });

    render(
      <ConfigProvider locale={zhCN} theme={{ token: { motion: false } }}>
        <AntdApp>
          <QueryClientProvider client={client}>
            <MemoryRouter initialEntries={['/eas?orgId=3&period=2026-06&tab=contract_recon']}>
              <EasWorkspace />
            </MemoryRouter>
          </QueryClientProvider>
        </AntdApp>
      </ConfigProvider>,
    );

    expect(await screen.findByText('HT-EAS-2025-101')).toBeTruthy();
    expect(screen.getByText('超期 81 天')).toBeTruthy();
    expect(screen.getByText(/东海建筑安装单位/)).toBeTruthy();
    expect(screen.getByText('已确认竣工决算版本')).toBeTruthy();
    expect(screen.getByRole('link', { name: 'HT-EAS-2025-101' }).getAttribute('href')).toBe('/contracts?id=101');

    const noteButtons = screen.getAllByRole('button', { name: '登记核对说明' });
    fireEvent.click(noteButtons[0]);

    const noteInput = await screen.findByLabelText('核对处理说明');
    fireEvent.change(screen.getByLabelText('关联核销/挂账凭证号(可选)'), { target: { value: '记-202606-0088' } });
    fireEvent.change(noteInput, { target: { value: '已核对质保复验单，安排下月付款清账' } });
    fireEvent.click(screen.getByText(/^确\s*定$/).closest('button')!);

    await waitFor(() => expect(saveNoteSpy).toHaveBeenCalledTimes(1));
    expect(saveNoteSpy).toHaveBeenCalledWith({
      orgId: 3,
      period: '2026-06',
      category: 'warranty_2241_overdue',
      targetKey: '2241:CT-101',
      reconStatus: 'to_writeoff',
      voucherRef: '记-202606-0088',
      note: '已核对质保复验单，安排下月付款清账',
    });
  }, 30_000);
});
