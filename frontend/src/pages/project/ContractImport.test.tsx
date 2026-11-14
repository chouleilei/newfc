// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntdApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import ContractImport, { IMPORT_KIND_LABELS } from './ContractImport';
import { ContractBaseFormModal } from './ContractBaseFormModal';
import * as clientMod from '../../api/client';
import { contractApi, planApi, type ContractDetailDto, type ContractImportDto } from '../../api/projectContract';

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

describe('F-GAP-12 & F-GAP-13 历史容缺批量导入（.xls/8模板/五维对账/收入标签/并发冲突/批次历史）', () => {
  it('普通导入权限隐藏容缺迁移开关；迁移管理员支持 .xls 上传、8模板下载、收入列头、业务标签、409冲突提示与批次历史', { timeout: 60_000 }, async () => {
    expect(Object.keys(IMPORT_KIND_LABELS)).toHaveLength(8);

    // 1. 仅有 contract:import 时不展示历史容缺迁移模式
    clientMod.setSession({
      authenticated: true,
      csrfToken: 'csrf-imp-std',
      expiresAt: '',
      user: {
        id: 5,
        username: 'importer',
        displayName: '经办导入员',
        permissions: ['contract:import', 'contract:read'],
        allOrgs: false,
        orgIds: [1],
        mustChangePassword: false,
      },
    });
    vi.spyOn(contractApi, 'listImports').mockResolvedValue([]);

    const qc1 = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const { unmount } = render(
      <ConfigProvider locale={zhCN} theme={{ token: { motion: false } }}>
        <AntdApp>
          <QueryClientProvider client={qc1}>
            <MemoryRouter initialEntries={['/contracts/import']}>
              <ContractImport />
            </MemoryRouter>
          </QueryClientProvider>
        </AntdApp>
      </ConfigProvider>,
    );
    expect(screen.getByText('标准台账导入 · 严格校验')).toBeTruthy();
    expect(screen.queryByText('历史容缺多簿归并入库')).toBeNull();
    unmount();

    // 2. 迁移管理员具备 contract:migrate 权限
    clientMod.setSession({
      authenticated: true,
      csrfToken: 'csrf-imp-mig',
      expiresAt: '',
      user: {
        id: 1,
        username: 'mig_admin',
        displayName: '迁移管理员',
        permissions: ['contract:import', 'contract:migrate', 'contract:read'],
        allOrgs: true,
        orgIds: [],
        mustChangePassword: false,
      },
    });

    const mockImportPreview: ContractImportDto = {
      id: 88,
      fileName: '历史收入合同台账.xls',
      fileSha256: 'sha256-88',
      importKind: 'legacy_batch_upsert',
      importMode: 'legacy_tolerant',
      paidOrReceivedLabel: '已收金额',
      status: 'previewed',
      rowCount: 2,
      errorCount: 0,
      planHash: 'f0e1d2c3b4a5968778695a4b3c2d1e0f',
      counts: { create: 2, update: 0, unchanged: 0 },
      errors: [],
      reconciliation: {
        totalSourceRows: 10,
        filteredNoiseRows: 2,
        foldedDuplicateRows: 3,
        mainContractRows: 2,
        subEventRows: 2,
        conflictAndClueRows: 1,
        closed: true,
      },
      rows: [
        {
          row: 2,
          contractId: null,
          contractNo: 'MIG-SUBA-2024-0001',
          legacyRawNo: '无编号(补签)',
          name: '测试历史发电技术服务收入合同',
          orgName: '甲二级法人',
          projectCode: null,
          supplierName: null,
          signDate: null,
          signingOrgName: '历史关停子公司',
          legalEntityOrgName: '甲二级法人',
          direction: 'income',
          currency: '美元',
          exchangeRate: '7.150000',
          foreignAmountText: 'USD 10,000.00 + CNY 50,000.00',
          currencyLines: [
            { lineNo: 1, currency: 'USD', amount: '10000.00', amountRole: 'contract_original', fxRate: '7.150000', fxRateDate: null, fxRateSource: 'ledger' },
            { lineNo: 2, currency: 'CNY', amount: '50000.00', amountRole: 'contract_original', fxRate: '1', fxRateDate: null, fxRateSource: 'ledger' },
          ],
          currencyStructStatus: 'partial_unstructured',
          amount: '121500.00',
          paid: '50000.00',
          legacySettledBaselineAmount: '60000.00',
          syntheticNoFlag: true,
          isReversal: true,
          duplicateConflictGroup: 'DUP-01',
          amountFactSource: 'voucher_debit_clue',
          isInternalGroupTx: true,
          missingFields: ['signDate', 'ourSignatoryName'],
          action: 'create',
          changes: {
            rawSignDateText: [null, '2024年春'],
            exchangeRate: [null, '7.150000'],
          },
        },
      ],
      result: null,
      createdAt: '2026-11-14T08:00:00Z',
      confirmedAt: null,
    };

    const downloadSpy = vi.spyOn(clientMod, 'download').mockResolvedValue(true);
    const previewSpy = vi.spyOn(contractApi, 'previewImport').mockResolvedValue(mockImportPreview);
    vi.spyOn(contractApi, 'getImport').mockResolvedValue(mockImportPreview);
    vi.spyOn(contractApi, 'listImports').mockResolvedValue([
      {
        id: 77,
        fileName: '首轮历史演练包.xls',
        fileSha256: 'abc123',
        importKind: 'legacy_batch_upsert',
        importMode: 'legacy_tolerant',
        status: 'confirmed',
        rowCount: 120,
        errorCount: 0,
        planHash: 'hash77',
        counts: { create: 115, update: 5, unchanged: 0 },
        errors: [],
        rows: [],
        result: { created: 115, updated: 5, unchanged: 0, contractIds: [] },
        createdAt: '2026-11-13T10:00:00Z',
        confirmedAt: '2026-11-13T10:05:00Z',
      },
    ]);
    const confirmSpy = vi.spyOn(contractApi, 'confirmImport').mockRejectedValue(
      new clientMod.ApiError({ code: 'PREVIEW_STALE', message: '预览已过期' }, 409),
    );

    const qc2 = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <ConfigProvider locale={zhCN} theme={{ token: { motion: false } }}>
        <AntdApp>
          <QueryClientProvider client={qc2}>
            <MemoryRouter initialEntries={['/contracts/import']}>
              <ContractImport />
            </MemoryRouter>
          </QueryClientProvider>
        </AntdApp>
      </ConfigProvider>,
    );

    // 批次历史列表加载
    expect(await screen.findByText('首轮历史演练包.xls')).toBeTruthy();

    // 展开 8 种导入模板下载栏并点击下载
    fireEvent.click(screen.getByText('下载 8 种官方标准合同导入模板 (.xlsx)'));
    const tplBtn = await screen.findByText('纪巡财审 · 收入合同基本信息');
    fireEvent.click(tplBtn);
    expect(downloadSpy).toHaveBeenCalledWith(
      '/contracts/imports/templates/supervision_income_base',
      '纪巡财审 · 收入合同基本信息.xlsx',
    );

    // 切换至历史容缺模式并上传 .xls 文件
    fireEvent.click(screen.getByText('历史容缺多簿归并入库'));
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    expect(fileInput.getAttribute('accept')).toBe('.csv,.xlsx,.xls');

    const xlsFile = new File(['xls-binary'], '历史收入合同台账.xls', { type: 'application/vnd.ms-excel' });
    fireEvent.change(fileInput, { target: { files: [xlsFile] } });

    await waitFor(() => {
      expect(previewSpy).toHaveBeenCalledWith(xlsFile, { importMode: 'legacy_tolerant' });
    });

    // 验证五维对账摘要卡、收入列标题「已收金额」、双主体与业务化待办标签
    expect(await screen.findByText('五维行去向对账摘要')).toBeTruthy();
    expect(screen.getByText('100% 闭合')).toBeTruthy();
    expect(screen.getAllByText('已收金额').length).toBeGreaterThan(0);
    expect(screen.getAllByText('历史已结算/开票基线').length).toBeGreaterThan(0);
    expect(screen.getByText('历史关停子公司 → 甲二级法人')).toBeTruthy();
    expect(screen.getByText('原号:无编号(补签)')).toBeTruthy();
    expect(screen.getByText('USD 10,000.00 + CNY 50,000.00')).toBeTruthy();
    expect(screen.getByText('同号冲突待核实')).toBeTruthy();
    expect(screen.getByText('凭证线索待补原合同')).toBeTruthy();
    expect(screen.getByText('集团内部关联合同')).toBeTruthy();
    expect(screen.getByText('待赋正式号 (MIG-)')).toBeTruthy();
    expect(screen.getByText('历史红冲')).toBeTruthy();
    expect(screen.getByText('待补录要素 (2)')).toBeTruthy();
    expect(screen.getByText('原始签订日期文本:空 → 2024年春')).toBeTruthy();

    // 点击确认导入触发 409 PREVIEW_STALE 并发冲突横幅
    fireEvent.click(screen.getByText('确认导入'));
    const okBtns = await screen.findAllByText(/^确\s*定$/);
    fireEvent.click(okBtns[okBtns.length - 1]);
    await waitFor(() => {
      expect(confirmSpy).toHaveBeenCalledWith(88, 'f0e1d2c3b4a5968778695a4b3c2d1e0f');
    });
    expect(await screen.findByText(/409 PREVIEW_STALE/)).toBeTruthy();
  });

  it('ContractBaseFormModal 编辑历史容缺合同时展示合成号/红冲与双主体待补录提示横幅', { timeout: 60_000 }, async () => {
    clientMod.setSession({
      authenticated: true,
      csrfToken: 'csrf-legacy-modal',
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
    vi.spyOn(clientMod.api, 'get').mockImplementation(async (path: string) =>
      path.startsWith('/org/tree') ? ({ tree: [], rows: [] } as never) : ([] as never),
    );
    vi.spyOn(contractApi, 'list').mockResolvedValue([]);
    vi.spyOn(planApi, 'batches').mockResolvedValue([]);

    const legacyContract = {
      id: 501,
      version: 1,
      contractNo: 'MIG-SUBA-2023-0009',
      legacyRawNo: '旧字09号',
      name: '历史机组改造结算红冲单',
      contractType: '工程',
      orgId: 1,
      orgName: '甲二级法人',
      signingOrgName: '历史关停子公司',
      legalEntityOrgName: '甲二级法人',
      migrationMode: 'legacy_tolerant',
      syntheticNoFlag: true,
      isReversal: true,
      missingFields: ['signDate', 'counterpartyNames'],
      rawSignDateText: '2023年底',
      foreignAmountText: 'EUR 5,000.00',
      noExemptReason: '历史台账无原编号自动赋码',
      stage: 'performance',
      status: 'active',
      originalAmount: '-12000.00',
      approvedChange: '0.00',
      currentAmount: '-12000.00',
      paidAmount: '0.00',
      documents: [],
      reviews: [],
      changes: [],
      payments: [],
      events: [],
      blockers: [],
    } as unknown as ContractDetailDto;

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <ConfigProvider locale={zhCN} theme={{ token: { motion: false } }}>
        <AntdApp>
          <QueryClientProvider client={qc}>
            <ContractBaseFormModal open contract={legacyContract} onClose={vi.fn()} onSaved={vi.fn()} />
          </QueryClientProvider>
        </AntdApp>
      </ConfigProvider>,
    );

    expect(await screen.findByText('历史容缺迁入合同（待逐步补录转正）')).toBeTruthy();
    expect(screen.getByText('合成号')).toBeTruthy();
    expect(screen.getByText('红冲')).toBeTruthy();
    expect(screen.getByText(/实际签约主体：历史关停子公司 ｜ 法定法人统计口径：甲二级法人/)).toBeTruthy();
    expect(screen.getByText(/待补录缺口：signDate、counterpartyNames/)).toBeTruthy();
  });
});
