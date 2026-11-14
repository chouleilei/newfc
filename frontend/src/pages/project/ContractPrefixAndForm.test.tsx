// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntdApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import MasterEntities from '../MasterEntities';
import { ContractBaseFormModal } from './ContractBaseFormModal';
import * as clientMod from '../../api/client';
import { contractApi, planApi } from '../../api/projectContract';

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

const MOCK_ORG_TREE = {
  tree: [
    {
      id: 1,
      code: 'HQ',
      name: '集团母公司',
      status: 'active',
      orgKind: 'legal_entity',
      children: [
        { id: 2, code: 'STN1', name: '直属甲水电站', status: 'active', orgKind: 'direct_unit', isDirectStation: true },
        { id: 3, code: 'OLD1', name: '历史关停子公司', status: 'inactive', orgKind: 'closed_history' },
      ],
    },
  ],
  rows: [],
};

describe('F-GAP-11 合同编码前缀映射与沿用母公司代码智能取号 UI', () => {
  it('渲染合同编码前缀映射表（含 external/ignore 2态与可空法人主体）并支持新建外部相对方映射保存', { timeout: 60_000 }, async () => {
    clientMod.setSession({
      authenticated: true,
      csrfToken: 'csrf-gap11',
      expiresAt: '',
      user: {
        id: 1,
        username: 'admin',
        displayName: '管理员',
        permissions: ['master:read', 'master:write', 'contract:read'],
        allOrgs: true,
        orgIds: [],
        mustChangePassword: false,
      },
    });

    vi.spyOn(clientMod.api, 'get').mockImplementation(async (path: string) => {
      if (path.startsWith('/org/tree')) return MOCK_ORG_TREE as never;
      return [] as never;
    });

    const prefixMapSpy = vi.spyOn(contractApi, 'prefixMap').mockResolvedValue([
      {
        id: 10,
        rawPrefix: 'STN1',
        canonicalPrefix: 'HQ',
        legalEntityOrgId: 1,
        legalEntityOrgName: '集团母公司',
        signingOrgId: 2,
        signingOrgName: '直属甲水电站',
        successorOrgId: null,
        successorOrgName: null,
        effectiveFrom: null,
        effectiveTo: null,
        parentCanonicalPrefix: 'HQ',
        entityStatus: 'direct_unit',
        prefixKind: 'internal_prefix',
        allowNewContract: true,
        sampleContractNo: 'STN1-SG-001/2025-001',
        occurrenceCount: 18,
        note: '直属电站沿用母公司代码',
        createdAt: '2026-11-14T00:00:00Z',
        updatedAt: '2026-11-14T00:00:00Z',
      },
      {
        id: 11,
        rawPrefix: 'EXT-SUP',
        canonicalPrefix: 'EXT',
        legalEntityOrgId: null,
        legalEntityOrgName: null,
        signingOrgId: null,
        signingOrgName: null,
        successorOrgId: null,
        successorOrgName: null,
        effectiveFrom: null,
        effectiveTo: null,
        parentCanonicalPrefix: '',
        entityStatus: 'external',
        prefixKind: 'external_counterparty',
        allowNewContract: false,
        sampleContractNo: 'EXT-SUP-2024-09',
        occurrenceCount: 5,
        note: '外部相对方自编前缀',
        createdAt: '2026-11-14T00:00:00Z',
        updatedAt: '2026-11-14T00:00:00Z',
      },
      {
        id: 12,
        rawPrefix: 'NOISE-HDR',
        canonicalPrefix: 'NOISE',
        legalEntityOrgId: null,
        legalEntityOrgName: null,
        signingOrgId: null,
        signingOrgName: null,
        successorOrgId: null,
        successorOrgName: null,
        effectiveFrom: null,
        effectiveTo: null,
        parentCanonicalPrefix: '',
        entityStatus: 'ignore',
        prefixKind: 'noise_header_filter',
        allowNewContract: false,
        sampleContractNo: '',
        occurrenceCount: 2,
        note: '表头噪声行',
        createdAt: '2026-11-14T00:00:00Z',
        updatedAt: '2026-11-14T00:00:00Z',
      },
    ]);

    const createSpy = vi.spyOn(contractApi, 'createPrefixMap').mockResolvedValue({
      id: 13,
      rawPrefix: 'EXT-NEW',
      canonicalPrefix: 'EXT',
      legalEntityOrgId: null,
      legalEntityOrgName: null,
      signingOrgId: null,
      signingOrgName: null,
      successorOrgId: null,
      successorOrgName: null,
      effectiveFrom: null,
      effectiveTo: null,
      parentCanonicalPrefix: '',
      entityStatus: 'external',
      prefixKind: 'external_counterparty',
      allowNewContract: false,
      sampleContractNo: '',
      occurrenceCount: 0,
      note: '测试外部前缀',
      createdAt: '2026-11-14T00:00:00Z',
      updatedAt: '2026-11-14T00:00:00Z',
    });

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <ConfigProvider locale={zhCN} theme={{ token: { motion: false } }}>
        <AntdApp>
          <QueryClientProvider client={qc}>
            <MemoryRouter initialEntries={['/master?tab=prefix-map']}>
              <MasterEntities />
            </MemoryRouter>
          </QueryClientProvider>
        </AntdApp>
      </ConfigProvider>,
    );

    expect(await screen.findByText('EXT-SUP')).toBeTruthy();
    expect(screen.getByText('外部相对方')).toBeTruthy();
    expect(screen.getByText('噪声过滤')).toBeTruthy();
    expect(screen.getAllByText('—（外部/忽略）').length).toBeGreaterThanOrEqual(2);

    // 切换「仅看允许新签」触发筛选参数
    const switches = document.querySelectorAll('.ant-switch');
    expect(switches.length).toBeGreaterThan(0);
    fireEvent.click(switches[0]);
    await waitFor(() => {
      expect(prefixMapSpy).toHaveBeenCalledWith(expect.objectContaining({ allowNewOnly: true }));
    });

    // 打开新建弹窗，选择 external 主体类型时允许 legalEntityOrgId 为空保存
    fireEvent.click(screen.getByText('新建前缀映射'));
    expect(await screen.findByText('新建合同编码前缀映射')).toBeTruthy();

    fireEvent.change(screen.getByPlaceholderText('如 HQ / SUB-A'), { target: { value: 'ext-new' } });
    fireEvent.change(screen.getByPlaceholderText('如 HQ / EXT / NOISE'), { target: { value: 'ext' } });

    const statusField = screen.getByText('主体类型 (entityStatus)').closest('.ant-form-item')!;
    fireEvent.mouseDown(statusField.querySelector('.ant-select-selector')!);
    const externalOpt = await screen.findAllByText('外部相对方');
    fireEvent.click(externalOpt[externalOpt.length - 1]);

    fireEvent.click(screen.getByText(/^确\s*定$/));
    await waitFor(() => {
      expect(createSpy).toHaveBeenCalledWith(
        expect.objectContaining({
          rawPrefix: 'EXT-NEW',
          canonicalPrefix: 'EXT',
          entityStatus: 'external',
          legalEntityOrgId: null,
          allowNewContract: false,
        }),
      );
    });
  });

  it('新建合同弹窗：回填建议编号、展示直属电站法定母公司归属横幅并禁用历史关停组织', { timeout: 60_000 }, async () => {
    clientMod.setSession({
      authenticated: true,
      csrfToken: 'csrf-gap11-form',
      expiresAt: '',
      user: {
        id: 2,
        username: 'stn_user',
        displayName: '电站经办人',
        permissions: ['contract:read', 'contract:write'],
        allOrgs: false,
        orgIds: [2],
        mustChangePassword: false,
      },
    });

    vi.spyOn(clientMod.api, 'get').mockImplementation(async (path: string) => {
      if (path.startsWith('/org/tree')) return MOCK_ORG_TREE as never;
      return [] as never;
    });
    vi.spyOn(contractApi, 'list').mockResolvedValue([]);
    vi.spyOn(planApi, 'batches').mockResolvedValue([]);
    const suggestSpy = vi.spyOn(contractApi, 'suggestNextNo').mockResolvedValue({
      suggestedNo: 'HQ－SG－001/2026－0008',
      canonicalPrefix: 'HQ',
      yyCode: 'SG',
      legalEntityOrgId: 1,
      legalEntityOrgName: '集团母公司',
      signingOrgId: 2,
      signingOrgName: '直属甲水电站',
      orgKind: 'direct_unit',
      isDirectStation: true,
    });

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <ConfigProvider locale={zhCN} theme={{ token: { motion: false } }}>
        <AntdApp>
          <QueryClientProvider client={qc}>
            <ContractBaseFormModal open onClose={vi.fn()} onSaved={vi.fn()} />
          </QueryClientProvider>
        </AntdApp>
      </ConfigProvider>,
    );

    // 校验附件3标准格式 placeholder
    const noInput = (await screen.findByPlaceholderText('XX－YY－序号（补X）/年份－流水号')) as HTMLInputElement;
    expect(noInput).toBeTruthy();

    // 直属电站归属母公司横幅自动渲染
    expect(
      await screen.findByText('规范取号码：HQ ｜ 实际签约主体：直属甲水电站 vs 法定统计法人：集团母公司'),
    ).toBeTruthy();

    // 点击「生成建议编号」自动回填
    fireEvent.click(screen.getByText('生成建议编号'));
    await waitFor(() => {
      expect(suggestSpy).toHaveBeenCalledWith(expect.objectContaining({ orgId: 2 }));
      expect(noInput.value).toBe('HQ－SG－001/2026－0008');
    });

    // 打开承办组织下拉，验证历史关停子公司带 [历史停用] 且处于禁用状态
    const orgItem = screen.getByText('承办组织').closest('.ant-form-item')!;
    fireEvent.mouseDown(orgItem.querySelector('.ant-select-selector')!);
    const closedNode = await screen.findByText(/历史关停子公司\(OLD1\) \[历史停用\]/);
    expect(closedNode.closest('.ant-select-tree-treenode-disabled')).toBeTruthy();
  });
});
