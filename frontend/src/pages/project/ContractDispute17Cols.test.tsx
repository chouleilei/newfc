// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App as AntdApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ContractSafeguardTab } from './ContractSafeguardTab';
import * as clientMod from '../../api/client';
import type { ContractDetailDto } from '../../api/projectContract';

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
  clientMod.setSession(null);
  vi.restoreAllMocks();
});

const OFFICIAL_17_HEADERS = [
  '序号',
  '诉讼类型',
  '案由',
  '相对方及其诉讼地位',
  '程序阶段',
  '受理机构',
  '案号',
  '涉诉单位',
  '诉讼地位',
  '受理时间',
  '案情简介',
  '法律文书形式',
  '结案时间',
  '诉讼金额',
  '裁判结果',
  '单位实际获得或支付的金额',
  '备注（代理律所及承办律师）',
];

const CONTRACT_WITH_DISPUTE: ContractDetailDto = {
  id: 77,
  contractNo: 'HQ-SG-02/2026-008',
  name: '示范灌区渠道防渗施工合同',
  contractType: '施工',
  orgId: 101,
  orgName: '甲水电开发公司',
  projectId: 15,
  projectCode: 'PRJ-015',
  projectName: '灌区节水改造工程',
  supplierId: 35,
  supplierName: '丙基础工程建设公司',
  originalAmount: '3200000.00',
  approvedChange: '0.00',
  currentAmount: '3200000.00',
  paidAmount: '1500000.00',
  paymentRate: '0.468750',
  paymentCapRatio: null,
  stage: 'performance',
  status: 'active',
  statusReason: null,
  signDate: '2026-04-01',
  effectiveDate: '2026-04-01',
  source: 'manual',
  version: 1,
  pendingReviews: 0,
  pendingChanges: 0,
  openPayments: 0,
  legalReviewEnabled: true,
  nextStage: 'settlement',
  blockers: [],
  documents: [],
  reviews: [],
  changes: [
    {
      id: 201,
      delta: '120000.00',
      reason: '地质变更签证争议',
      supplementNo: 'HQ-SG-02/2026-008(补1)',
      evidenceDocumentId: 1,
      status: 'approved',
      submittedBy: '经办',
      submittedAt: '2026-07-01T00:00:00Z',
      reviewedBy: '复核',
      reviewedAt: '2026-07-02T00:00:00Z',
      comment: null,
      exceptionReason: null,
      selfReview: false,
    },
  ],
  payments: [],
  guarantees: [],
  warranty: null,
  disputes: [
    {
      id: 401,
      changeId: 201,
      occurredDate: '2026-08-01',
      reportedToDeptAt: '2026-08-02',
      litigationType: '民事诉讼',
      causeOfAction: '建设工程施工合同纠纷',
      counterpartyAndRole: '丙基础工程建设公司（被告）',
      stage: 'litigation_1st',
      institutionName: '某市中级人民法院',
      caseNo: '(2026)某01民初108号',
      involvedOrgName: '甲水电开发公司',
      ourLitigationRole: '原告',
      acceptedDate: '2026-08-15',
      caseSummary: '因工程量核定及工期延误违约金扣减产生争议诉至法院。',
      gmApprovedAt: '2026-08-10',
      legalDocForm: '民事判决书',
      closedDate: '2026-10-28',
      disputeAmount: '380000.00',
      judgmentResult: '部分胜诉',
      actualSettledAmount: '290000.00',
      lawFirmAndLawyer: '正衡律师事务所 · 林律师',
      filedToMgmtAt: '2026-08-16',
      filedToDisciplineAt: '2026-08-16',
      createdBy: '经办',
      createdAt: '2026-08-15T00:00:00Z',
      updatedAt: '2026-10-28T00:00:00Z',
    },
  ],
  events: [],
  createdAt: '2026-04-01T00:00:00Z',
  updatedAt: '2026-04-01T00:00:00Z',
};

describe('F-GAP-19 诉讼/仲裁 17列官方台账完整渲染、标准下拉字典与 Excel 导出', () => {
  it('精确渲染全部 17个官方表头及原缺失 10个字段，弹窗四项枚举使用 Select 且案情简介含 200字规程提醒', { timeout: 30_000 }, async () => {
    clientMod.setSession({
      authenticated: true,
      csrfToken: 'csrf-disp',
      expiresAt: '',
      user: {
        id: 1,
        username: 'admin',
        displayName: '法务管理员',
        permissions: ['contract:read', 'contract:write'],
        allOrgs: true,
        orgIds: [],
        mustChangePassword: false,
      },
    });

    const downloadSpy = vi.spyOn(clientMod, 'download').mockResolvedValue(true);
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });

    render(
      <ConfigProvider locale={zhCN} theme={{ token: { motion: false } }}>
        <AntdApp>
          <QueryClientProvider client={qc}>
            <MemoryRouter>
              <ContractSafeguardTab contract={CONTRACT_WITH_DISPUTE} onChanged={vi.fn()} />
            </MemoryRouter>
          </QueryClientProvider>
        </AntdApp>
      </ConfigProvider>,
    );

    // 1. 校验 17 个官方表头无一遗漏
    for (const h of OFFICIAL_17_HEADERS) {
      expect(screen.getAllByText(h).length).toBeGreaterThan(0);
    }

    // 2. 校验原缺失的 10 个字段值均已在界面渲染
    expect(screen.getByText('丙基础工程建设公司（被告）')).toBeTruthy();
    expect(screen.getByText('甲水电开发公司')).toBeTruthy();
    expect(screen.getByText('原告')).toBeTruthy();
    expect(screen.getByText('2026-08-15')).toBeTruthy();
    expect(screen.getByText('因工程量核定及工期延误违约金扣减产生争议诉至法院。')).toBeTruthy();
    expect(screen.getByText('民事判决书')).toBeTruthy();
    expect(screen.getByText('2026-10-28')).toBeTruthy();
    expect(screen.getByText('部分胜诉')).toBeTruthy();
    expect(screen.getByText('正衡律师事务所 · 林律师')).toBeTruthy();

    // 3. 校验 17 列 Excel 导出调用
    fireEvent.click(screen.getByRole('button', { name: '导出 17列纠纷台账 (.xlsx)' }));
    expect(downloadSpy).toHaveBeenCalledWith('/contracts/disputes/export?contractId=77', expect.stringContaining('.xlsx'));

    // 4. 打开新增弹窗，验证 诉讼类型/程序阶段/诉讼地位/裁判结果 均为 Select，案情简介带 200字提醒，且支持关联变更 changeId
    fireEvent.click(screen.getByRole('button', { name: '登记纠纷 / 诉讼' }));
    const dlg = await screen.findByRole('dialog', { name: /登记纠纷 \/ 诉讼仲裁（17 列台账）/ });
    expect(within(dlg).getByText('制度要求一般不超过200字，概括案件主体事实与争议要点')).toBeTruthy();

    for (const selectLabel of ['程序阶段', '诉讼类型', '诉讼地位', '裁判结果', '关联合同变更(可选)']) {
      const inputEl = within(dlg).getByLabelText(selectLabel);
      expect(inputEl.closest('.ant-select')).toBeTruthy();
    }
  });
});
