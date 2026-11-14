// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntdApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import PlanExecution, { SHEET_DOMAINS, SHEET_LABEL } from './PlanExecution';
import * as clientMod from '../../api/client';
import { planApi } from '../../api/projectContract';

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

describe('F-GAP-09 PlanExecution 16表切换、.xls上传容缺提示与缺失列补齐', () => {
  it('覆盖全部16张工作表映射、执行表批复概算/累计已付款/跨单位承办/项目跳转及 .xls 非阻断告警导入', { timeout: 60_000 }, async () => {
    // 1. 静态核对 3 域共覆盖 16 张工作表
    const allDomainSheets = [
      ...SHEET_DOMAINS.investment_purchase,
      ...SHEET_DOMAINS.operation_expense,
      ...SHEET_DOMAINS.kpi_budget,
    ];
    expect(allDomainSheets).toHaveLength(16);
    expect(Object.keys(SHEET_LABEL)).toHaveLength(16);

    clientMod.setSession({
      authenticated: true,
      csrfToken: 'csrf-gap09',
      expiresAt: '',
      user: {
        id: 1,
        username: 'admin',
        displayName: '管理员',
        permissions: ['plan:read', 'plan:write'],
        allOrgs: true,
        orgIds: [],
        mustChangePassword: false,
      },
    });

    const mockBatch = {
      id: 7,
      year: 2026,
      actualPeriod: '2026-10',
      fileName: '2026年度综合计划.xls',
      fileSha256: 'abc',
      amountUnit: 'wan' as const,
      status: 'imported' as const,
      isCurrent: true,
      itemCount: 32,
      factCount: 96,
      sheets: [
        { code: 'investment' as const, name: '固定资产投资计划', sourceName: '基建投资', itemCount: 12, detailCount: 10, unit: 'wan' as const },
        { code: 'five_expenses' as const, name: '五项费用', sourceName: '五项费用', itemCount: 8, detailCount: 6, unit: 'wan' as const },
        { code: 'annual_kpi' as const, name: '主要指标', sourceName: '主要指标', itemCount: 12, detailCount: 12, unit: 'wan' as const },
      ],
      ignoredSheets: [],
      partial: false,
      orgNames: ['甲单位'],
      version: 1,
      createdAt: '2026-10-31T00:00:00Z',
      activatedAt: '2026-10-31T00:00:00Z',
      voidedAt: null,
      voidReason: null,
    };

    vi.spyOn(planApi, 'overview').mockResolvedValue({
      year: 2026,
      asOfPeriod: '2026-10',
      batch: mockBatch,
      sheets: [],
      notes: [],
    });
    vi.spyOn(planApi, 'projects').mockResolvedValue({
      year: 2026,
      asOfPeriod: '2026-10',
      batch: mockBatch,
      notes: [],
      rows: [
        {
          itemId: 101,
          rowNo: 5,
          projectId: 42,
          projectCode: 'PRJ-042',
          projectName: '示范除险加固工程',
          orgName: '甲法人单位',
          undertakeOrgName: '乙建设管理局',
          approvedBudget: '8500000.00',
          totalInvestment: '9000000.00',
          completedCumulative: '4500000.00',
          cumulativeRate: '0.500000',
          annualPlan: '3000000.00',
          annualActualYtd: '2400000.00',
          annualRate: '0.800000',
          period: { value: '500000.00', reason: null, previousBatchId: 6, previousPeriod: '2026-09' },
          physicalProgress: '0.750000',
          progressNote: '主体完工75%',
          paidCumulative: '2100000.00',
          status: 'normal',
        },
      ],
    });
    vi.spyOn(planApi, 'batches').mockResolvedValue([mockBatch]);
    vi.spyOn(planApi, 'items').mockResolvedValue([
      {
        id: 501,
        sheetCode: 'five_expenses',
        rowNo: 3,
        seqNo: '1',
        itemName: '安全生产专项费',
        itemType: 'detail',
        path: '安全生产专项费',
        projectId: null,
        projectCode: null,
        orgId: 2,
        orgName: '甲法人单位',
        undertakeOrgName: '乙建设管理局',
        fundingChannel: '自有资金',
        costNature: '费用化',
        approvedBudget: '500000.00',
        paidCumulative: '120000.00',
        facts: [],
      },
    ]);
    vi.spyOn(planApi, 'preview').mockResolvedValue({
      valid: true,
      errors: [],
      warnings: [
        { code: 'MISSING_PROJECT_CODE', sheet: '运行维护费', row: 8, message: '项目编码为空，已生成确定性 item_key' },
        { code: 'STALE_YEAR_HEADER', sheet: '五项费用', row: 2, message: '表头年份滞后于计划年度', headerYearRaw: '2025年' },
      ],
      sheets: mockBatch.sheets,
      ignoredSheets: [],
      itemCount: 32,
      factCount: 96,
      previewItems: [],
    });
    const downloadSpy = vi.spyOn(clientMod, 'download').mockResolvedValue(true);

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    qc.setQueryData(['org-tree'], { rows: [], tree: [] });

    render(
      <ConfigProvider locale={zhCN} theme={{ token: { motion: false } }}>
        <AntdApp>
          <QueryClientProvider client={qc}>
            <MemoryRouter initialEntries={['/plan']}>
              <PlanExecution />
            </MemoryRouter>
          </QueryClientProvider>
        </AntdApp>
      </ConfigProvider>,
    );

    // 2. 验证项目进度表渲染批复概算、累计已付款、跨单位承办标签及 /projects/42 链接
    await waitFor(() => expect(screen.getByText('示范除险加固工程(PRJ-042)')).toBeTruthy());
    const projectLink = screen.getByText('示范除险加固工程(PRJ-042)').closest('a')!;
    expect(projectLink.getAttribute('href')).toBe('/projects/42');
    expect(screen.getByText('跨单位承办:乙建设管理局')).toBeTruthy();
    expect(screen.getByText('8,500,000.00')).toBeTruthy();
    expect(screen.getByText('2,100,000.00')).toBeTruthy();

    // 3. 验证下载空模板与导出当前执行表按钮
    fireEvent.click(screen.getByText('下载标准空模板 (.xlsx)'));
    expect(downloadSpy).toHaveBeenCalledWith(expect.stringContaining('/plan/template'), expect.stringContaining('.xlsx'));

    // 4. 打开行与取数抽屉，验证 3 域 × 16 表切换器
    fireEvent.click(screen.getByText('行与取数'));
    await waitFor(() => expect(screen.getByText(/运维与费用/)).toBeTruthy());
    fireEvent.click(screen.getByText(/运维与费用/));
    await waitFor(() => expect(screen.getByText('五项费用')).toBeTruthy());
    fireEvent.click(screen.getByText('五项费用'));
    await waitFor(() => expect(screen.getByText('安全生产专项费')).toBeTruthy());

    // 5. 打开导入弹窗，验证 accept 含 .xls，且非阻断 warnings 不阻塞「导入」按钮
    fireEvent.click(screen.getByText('导入计划执行'));
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(fileInput.getAttribute('accept')).toBe('.csv,.xlsx,.xls');

    const xlsFile = new File(['xls-content'], 'plan2026.xls', { type: 'application/vnd.ms-excel' });
    fireEvent.change(fileInput, { target: { files: [xlsFile] } });
    await waitFor(() => expect(screen.getByText('plan2026.xls')).toBeTruthy());
    fireEvent.click(screen.getByText(/^预\s*览$/));

    await waitFor(() => expect(screen.getByText(/非阻断校验提示（共 2 条/)).toBeTruthy());
    const modalFooterBtns = document.querySelectorAll('.ant-modal-footer button');
    const importConfirmBtn = Array.from(modalFooterBtns).find((b) => b.textContent?.includes('导')) as HTMLButtonElement;
    expect(importConfirmBtn.disabled).toBe(false);
  });
});
