// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntdApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ContractExportModal } from './ContractExportModal';
import StandardReports from '../StandardReports';
import * as clientMod from '../../api/client';
import { contractApi } from '../../api/projectContract';
import { stdReportApi } from '../../api/financeData';

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

describe('F-GAP-13 & F-GAP-17 监督包/内部归档双用途导出与月报5表前端协同检查', () => {
  it('supervision_submit 在 incompleteCount > 0 时禁用导出；切换 internal_archive 显示告警并开放 ZIP 下载，准确渲染正文就绪摘要与中文槽位名', { timeout: 60_000 }, async () => {
    clientMod.setSession({
      authenticated: true,
      csrfToken: 'csrf-exp',
      expiresAt: '',
      user: {
        id: 1,
        username: 'exporter',
        displayName: '导出管理员',
        permissions: ['contract:read', 'analysis:export'],
        allOrgs: true,
        orgIds: [],
        mustChangePassword: false,
      },
    });

    vi.spyOn(clientMod.api, 'get').mockResolvedValue({ tree: [], rows: [] } as never);
    vi.spyOn(contractApi, 'supervisionExportLogs').mockResolvedValue([]);
    const preflightSpy = vi.spyOn(contractApi, 'preflightSupervision').mockImplementation(async (params) => ({
      period: params.period ?? '2026-11',
      scopeMode: params.scopeMode ?? 'all_active',
      exportPurpose: params.exportPurpose ?? 'supervision_submit',
      totalCount: 2,
      readyCount: 1,
      incompleteCount: 1,
      items: [
        {
          contractId: 101,
          contractNo: 'HQ-SG-001/2026-0001',
          name: '测试水工设备维保合同',
          direction: 'expense',
          ready: false,
          bodyDocStatus: 'contract_text',
          procurementReady: true,
          missingFields: ['ourSignatoryName'],
          missingAttachments: ['signed'],
          warnings: [],
        },
        {
          contractId: 102,
          contractNo: 'HQ-FW-002/2026-0002',
          name: '测试咨询服务合同',
          direction: 'expense',
          ready: true,
          bodyDocStatus: 'signed',
          procurementReady: true,
          missingFields: [],
          missingAttachments: [],
          warnings: [],
        },
      ],
    }));

    const origCreateObjectURL = URL.createObjectURL;
    const origRevokeObjectURL = URL.revokeObjectURL;
    URL.createObjectURL = vi.fn(() => 'blob:mock-archive-zip');
    URL.revokeObjectURL = vi.fn();
    const anchorClickSpy = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => {});

    const exportZipSpy = vi
      .spyOn(contractApi, 'exportSupervisionPackage')
      .mockResolvedValue(new Blob(['zip-bytes'], { type: 'application/zip' }));

    try {
      const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
      render(
        <ConfigProvider locale={zhCN} theme={{ token: { motion: false } }}>
          <AntdApp>
            <QueryClientProvider client={qc}>
              <ContractExportModal open onClose={vi.fn()} />
            </QueryClientProvider>
          </AntdApp>
        </ConfigProvider>,
      );

      // 标题准确包含 5表月报 / 纪巡财审 6套官方台账（8张工作表）+ 附件 ZIP
      expect(await screen.findByText(/5表月报 \/ 纪巡财审 6套官方台账（8张工作表）\+ 附件 ZIP/)).toBeTruthy();

      // 正文/招标就绪摘要列区分 contract_text 与 signed，且字段/附件标签为标准中文
      expect(await screen.findByText('合同文本 contract_text')).toBeTruthy();
      expect(screen.getByText('签署扫描件 signed')).toBeTruthy();
      expect(screen.getByText('字段:我方签署人姓名')).toBeTruthy();
      expect(screen.getByText('附件:已盖章合同扫描件(signed)')).toBeTruthy();

      // 默认在 supervision_submit 下，因 incompleteCount === 1，按钮禁用
      const submitBtn = screen.getByText('生成并下载 ZIP 报送包').closest('button')!;
      expect(submitBtn.disabled).toBe(true);

      // 切换至「内部历史全量归档备份」
      fireEvent.click(screen.getByText('内部历史全量归档备份'));

      await waitFor(() => {
        expect(preflightSpy).toHaveBeenCalledWith(expect.objectContaining({ exportPurpose: 'internal_archive' }));
      });

      expect(
        await screen.findByText('包含 1 份待补录缺口合同，ZIP 根目录将附带《缺口待补录清单.xlsx》'),
      ).toBeTruthy();

      const archiveBtn = screen.getByText('打包下载内部归档 ZIP').closest('button')!;
      expect(archiveBtn.disabled).toBe(false);

      fireEvent.click(archiveBtn);
      await waitFor(() => {
        expect(exportZipSpy).toHaveBeenCalledWith(expect.objectContaining({ exportPurpose: 'internal_archive' }));
        expect(anchorClickSpy).toHaveBeenCalled();
      });
    } finally {
      URL.createObjectURL = origCreateObjectURL;
      URL.revokeObjectURL = origRevokeObjectURL;
    }
  });

  it('StandardReports 移除过时阶段文案并展示 contract_monthly_pack 的 01_月度统计表分币种摘要矩阵', { timeout: 60_000 }, async () => {
    clientMod.setSession({
      authenticated: true,
      csrfToken: 'csrf-std-rep',
      expiresAt: '',
      user: {
        id: 1,
        username: 'viewer',
        displayName: '报表查看员',
        permissions: ['report:read'],
        allOrgs: true,
        orgIds: [],
        mustChangePassword: false,
      },
    });

    vi.spyOn(stdReportApi, 'list').mockResolvedValue([
      {
        id: 301,
        reportType: 'contract_monthly_pack',
        title: '2026-10 合同月度5表台账',
        orgId: null,
        orgName: null,
        period: '2026-10',
        rowCount: 12,
        status: 'generated',
        generatedAt: '2026-11-01T00:00:00Z',
        reviewedAt: null,
      } as never,
    ]);
    vi.spyOn(stdReportApi, 'get').mockResolvedValue({
      id: 301,
      reportType: 'contract_monthly_pack',
      title: '2026-10 合同月度5表台账',
      orgId: null,
      orgName: null,
      period: '2026-10',
      rowCount: 1,
      status: 'generated',
      contentSha256: '1234567890abcdef1234567890abcdef1234567890abcdef1234567890abcdef',
      generatedAt: '2026-11-01T00:00:00Z',
      reviewedAt: null,
      reviewComment: null,
      selfReview: false,
      exceptionReason: null,
      summary: [{ label: '在途合同数', value: '12' }],
      sources: {
        monthlyStats: [
          {
            currency: '人民币',
            newSignedCount: 3,
            newSignedWan: '120.50',
            closedCount: 1,
            closedWan: '45.00',
            changeCount: 2,
            changeDeltaWan: '8.20',
            settlementCount: 4,
            settlementNetWan: '86.00',
          },
          {
            currency: '美元',
            newSignedCount: 1,
            newSignedWan: '15.00',
            closedCount: 0,
            closedWan: '0.00',
            changeCount: 0,
            changeDeltaWan: '0.00',
            settlementCount: 1,
            settlementNetWan: '5.00',
          },
        ],
      },
      columns: [{ key: 'contractNo', label: '合同编号', kind: 'text' }],
      rows: [{ contractNo: 'HQ-SG-001/2026-0001' }],
    } as never);

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <ConfigProvider locale={zhCN} theme={{ token: { motion: false } }}>
        <AntdApp>
          <QueryClientProvider client={qc}>
            <MemoryRouter initialEntries={['/reports']}>
              <StandardReports />
            </MemoryRouter>
          </QueryClientProvider>
        </AntdApp>
      </ConfigProvider>,
    );

    // 确认不再包含旧文案「在后续阶段加入」
    expect(screen.queryByText(/在后续阶段加入/)).toBeNull();
    const rowTitle = await screen.findByText('2026-10 合同月度5表台账');
    fireEvent.click(rowTitle);

    expect(await screen.findByText('01_月度统计表 · 分币种新签/完结/变更/结算矩阵预览')).toBeTruthy();
    expect(screen.getByText('120.50')).toBeTruthy();
    expect(screen.getByText('美元')).toBeTruthy();
  });
});
