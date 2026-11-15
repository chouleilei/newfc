// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App as AntdApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { AssistantRegistryProvider } from '../../assistant/AssistantContextRegistry';
import PlanExecution from './PlanExecution';
import BudgetVersions from '../BudgetVersions';
import { WorkbenchTodoCard } from '../dashboard/WorkbenchTodoCard';
import { DomainOverviewCard } from '../dashboard/DomainOverviewCard';
import * as clientMod from '../../api/client';
import { planApi, todoApi, type PlanIssuanceCycleDto, type PlanReconcileReportDto, type PlanUnitPackDto } from '../../api/projectContract';

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

const MOCK_PACK: PlanUnitPackDto = {
  id: 21,
  cycleId: 10,
  unitOrgId: 102,
  unitOrgCode: 'U02',
  unitOrgName: '甲水电运营公司',
  docNo: '集团企〔2026〕02号',
  issuedDate: '2026-03-01',
  attachmentCount: 6,
  hasResponsibilityLetter: true,
  responsibilityLetterNo: '集团责〔2026〕02号',
  budgetVersionId: 5,
  signOffStatus: 'issued',
  ackUserId: null,
  ackUserName: null,
  ackAt: null,
  ackNote: '',
  version: 3,
  mergedChildOrgs: [{ id: 202, code: 'U02-A', name: '甲属新能源子公司' }],
  metrics: {
    operatingRevenue: '80000000.00',
    totalRevenue: '80000000.00',
    profitBeforeTax: '6000000.00',
    netProfit: '5100000.00',
    investmentTotal: '15000000.00',
    purchaseTotal: '2000000.00',
    maintenanceTotal: '10600000.00',
    safetyInputTotal: '1200000.00',
    fiveExpensesExact: '950042.00',
    fiveExpensesIssued: '950000.00',
    controllableMgmtFeeExact: '1850030.00',
    controllableMgmtFeeIssued: '1850000.00',
  },
  attachments: [],
  undertakeItems: [],
  createdAt: '2026-03-01T00:00:00Z',
  updatedAt: '2026-03-01T00:00:00Z',
};

function makeReconcileReport(hasCrossRefError: boolean): PlanReconcileReportDto {
  return {
    cycleId: 10,
    mode: 'legacy_reconcile',
    passed: !hasCrossRefError,
    blockingCount: hasCrossRefError ? 1 : 0,
    warningCount: 1,
    vatRateBp: 600,
    consolidation: {
      sum8UnitsOperatingRevenue: '500000000.00',
      excludedOrgsOperatingRevenue: '500000.00',
      groupConsolidatedOperatingRevenue: '500500000.01',
      operatingRevenueSubCentDiff: '0.01',
      sum8UnitsProfitBeforeTax: '12000000.00',
      excludedOrgsProfitBeforeTax: '80000.00',
      groupConsolidatedProfitBeforeTax: '12080000.00',
      profitDiff: '0.00',
      investmentTotal: '120000000.00',
      safetyInputTotal: '8000000.00',
      fiveExpensesExactTotal: '6200380.00',
      fiveExpensesIssuedTotal: '6200400.00',
      fiveExpensesStepDiff: '20.00',
      excludedOrgs: [{ orgId: 199, orgCode: 'EX01', orgName: '丁合并调节小水电', operatingRevenue: '500000.00', profitBeforeTax: '80000.00' }],
    },
    checks: [
      {
        unitOrgId: 102,
        unitName: '甲水电运营公司',
        kind: 'vat_maintenance',
        passed: true,
        blocking: false,
        planInclusiveAmount: '10600000.00',
        expectedBudgetExclAmount: '10000000.00',
        actualBudgetExclAmount: '10000000.00',
        diffAmount: '0.00',
        reasonCode: 'OK',
        message: '含税运维÷1.06与不含税经营预算一致',
      },
    ],
    crossUnitFormulaErrors: hasCrossRefError
      ? [{ code: 'CROSS_UNIT_CELL_REF', sheet: '五项费用', row: 35, message: '错列引用其他单位单元格 $FA$35' }]
      : [],
  };
}

function mountNode(node: React.ReactNode, url = '/plan?tab=cycles') {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: 0 } } });
  qc.setQueryData(['org-tree'], { rows: [], tree: [] });
  return render(
    <ConfigProvider locale={zhCN} theme={{ token: { motion: false } }}>
      <AntdApp>
        <QueryClientProvider client={qc}>
          <MemoryRouter initialEntries={[url]}>
            <AssistantRegistryProvider>{node}</AssistantRegistryProvider>
          </MemoryRouter>
        </QueryClientProvider>
      </AntdApp>
    </ConfigProvider>,
  );
}

describe('F-GAP-06/07/08/10 综合计划与预算合一下达、签收、联动调整与受限预算视图', () => {
  it('集团管理员稽核检出 CROSS_UNIT_CELL_REF 时禁用发布，修复通过后可正式发布并打包导出 .zip', { timeout: 60_000 }, async () => {
    clientMod.setSession({
      authenticated: true,
      csrfToken: 'csrf-p1',
      expiresAt: '',
      user: {
        id: 1,
        username: 'admin',
        displayName: '集团计划管理员',
        permissions: ['plan:read', 'plan:write', 'budget:read'],
        allOrgs: true,
        orgIds: [],
        mustChangePassword: false,
      },
    });

    let currentReport = makeReconcileReport(true);
    const makeCycle = (): PlanIssuanceCycleDto => ({
      id: 10,
      year: 2026,
      cycleCode: '2026-FORMAL',
      issuanceStage: 'official',
      sourcePlanBatchId: 7,
      sourceBudgetVersionId: 5,
      decisionDocMeta: {},
      frozenSnapshot: {},
      snapshotSha256: 'sha256-demo',
      status: 'draft',
      version: 1,
      unitPackCount: 1,
      acknowledgedCount: 0,
      excludedOrgs: [{ id: 199, code: 'EX01', name: '丁合并调节小水电' }],
      packs: [{ ...MOCK_PACK, signOffStatus: 'draft' }],
      reconcileReport: currentReport,
      createdByUserId: 1,
      createdAt: '2026-03-01T00:00:00Z',
      updatedAt: '2026-03-01T00:00:00Z',
    });

    vi.spyOn(planApi, 'overview').mockResolvedValue({ year: 2026, asOfPeriod: null, batch: null, sheets: [], notes: [] });
    vi.spyOn(planApi, 'projects').mockResolvedValue({ year: 2026, asOfPeriod: null, batch: null, rows: [], notes: [] });
    vi.spyOn(planApi, 'batches').mockResolvedValue([]);
    vi.spyOn(planApi, 'cycles').mockImplementation(async () => ({ items: [makeCycle()] }));
    vi.spyOn(planApi, 'cycle').mockImplementation(async () => makeCycle());
    const reconcileSpy = vi.spyOn(planApi, 'reconcileCycle').mockImplementation(async () => {
      currentReport = makeReconcileReport(false);
      return currentReport;
    });
    const publishSpy = vi.spyOn(planApi, 'publishCycle').mockImplementation(async () => ({ ...makeCycle(), status: 'published' }));
    const downloadSpy = vi.spyOn(clientMod, 'download').mockResolvedValue(true);

    mountNode(<PlanExecution />, '/plan?tab=cycles');

    await waitFor(() => expect(screen.getByText(/检出跨单位单元格公式错引 \(CROSS_UNIT_CELL_REF\)/)).toBeTruthy());
    expect(screen.getByText(/丁合并调节小水电\(EX01\) 标记为不单发下达通知/)).toBeTruthy();

    const publishBtn = screen.getByRole('button', { name: '正式发布下达' }) as HTMLButtonElement;
    expect(publishBtn.disabled).toBe(true);

    // 重跑稽核消缺后允许发布
    fireEvent.click(screen.getByRole('button', { name: '运行合并与税率/五项费用稽核' }));
    await waitFor(() => expect(reconcileSpy).toHaveBeenCalledWith(10, { mode: 'legacy_reconcile' }));
    await waitFor(() => expect((screen.getByRole('button', { name: '正式发布下达' }) as HTMLButtonElement).disabled).toBe(false));

    fireEvent.click(screen.getByRole('button', { name: '正式发布下达' }));
    const confirmBtn = await screen.findByRole('button', { name: /确认发布下达/ }, { timeout: 5000 });
    fireEvent.click(confirmBtn);
    await waitFor(() => expect(publishSpy).toHaveBeenCalledWith(10));

    fireEvent.click(screen.getByRole('button', { name: '打包下载全集团下达公文包 (.zip)' }));
    expect(downloadSpy).toHaveBeenCalledWith('/plan/issuance/cycles/10/export-zip', expect.stringContaining('.zip'));
  });

  it('受限二级单位用户切换双视角查看本单位包、导出 .docx、提交 expectedVersion 签收，并在自审调整时受控校验例外原因', { timeout: 60_000 }, async () => {
    clientMod.setSession({
      authenticated: true,
      csrfToken: 'csrf-unit',
      expiresAt: '',
      user: {
        id: 22,
        username: 'unit_mgr',
        displayName: '二级单位经办',
        permissions: ['plan:read', 'plan:write'],
        allOrgs: false,
        orgIds: [102],
        mustChangePassword: false,
      },
    });

    vi.spyOn(planApi, 'overview').mockResolvedValue({ year: 2026, asOfPeriod: null, batch: null, sheets: [], notes: [] });
    vi.spyOn(planApi, 'projects').mockResolvedValue({ year: 2026, asOfPeriod: null, batch: null, rows: [], notes: [] });
    vi.spyOn(planApi, 'batches').mockResolvedValue([]);
    const packsSpy = vi.spyOn(planApi, 'packs').mockResolvedValue({ items: [MOCK_PACK] });
    const ackSpy = vi.spyOn(planApi, 'acknowledgePack').mockResolvedValue({ ...MOCK_PACK, signOffStatus: 'acknowledged', version: 4 });
    const downloadSpy = vi.spyOn(clientMod, 'download').mockResolvedValue(true);

    mountNode(<PlanExecution />, '/plan?tab=packs&status=issued');

    await waitFor(() => expect(screen.getByText('甲水电运营公司')).toBeTruthy());
    expect(packsSpy).toHaveBeenCalledWith(expect.objectContaining({ status: 'issued', view: 'unit' }));

    // 切换至实际承办法人视角
    fireEvent.click(screen.getByText('按实际承办法人视角'));
    await waitFor(() => expect(packsSpy).toHaveBeenCalledWith(expect.objectContaining({ view: 'undertake' })));

    // 导出 .docx 公文
    const docxBtn = await screen.findByRole('button', { name: '导出下达公文及责任书 (.docx)' }, { timeout: 5000 });
    fireEvent.click(docxBtn);
    expect(downloadSpy).toHaveBeenCalledWith('/plan/issuance/packs/21/export-docx', expect.stringContaining('.docx'));

    // 点击确认签收并校验 expectedVersion 传参
    fireEvent.click(screen.getByRole('button', { name: '确认签收' }));
    const dlg = await screen.findByRole('dialog', { name: /确认签收「甲水电运营公司」/ });
    fireEvent.change(within(dlg).getByPlaceholderText(/经本单位经营班子核对/), { target: { value: '核对无误予以签收' } });
    fireEvent.click(within(dlg).getByRole('button', { name: '确认签收' }));
    await waitFor(() =>
      expect(ackSpy).toHaveBeenCalledWith(21, { expectedVersion: 3, ackNote: '核对无误予以签收' }),
    );
  });

  it('计划联动调整：超5工作日应急开工标红警示，同人自审无例外原因时禁用批准按钮', { timeout: 30_000 }, async () => {
    clientMod.setSession({
      authenticated: true,
      csrfToken: 'csrf-adj',
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

    vi.spyOn(planApi, 'overview').mockResolvedValue({ year: 2026, asOfPeriod: null, batch: null, sheets: [], notes: [] });
    vi.spyOn(planApi, 'projects').mockResolvedValue({ year: 2026, asOfPeriod: null, batch: null, rows: [], notes: [] });
    vi.spyOn(planApi, 'batches').mockResolvedValue([]);
    vi.spyOn(planApi, 'cycles').mockResolvedValue({ items: [] });
    vi.spyOn(planApi, 'adjustments').mockResolvedValue({
      items: [
        {
          id: 88,
          cycleId: 10,
          cycleCode: '2026-FORMAL',
          unitPackId: 21,
          unitOrgId: 102,
          unitOrgName: '甲水电运营公司',
          adjustType: 'emergency_retroactive',
          adjustTypeLabel: '防汛/突发应急先开工后补立项',
          approvalBody: 'company_approval',
          approvalBodyLabel: '报集团公司审批',
          decisionDocNo: '集团批〔2026〕12号',
          decisionAttachmentId: null,
          emergencyStartDate: '2026-09-01',
          emergencyOverdue5Workdays: true,
          reason: '突发排险工程补报',
          status: 'submitted',
          newCycleId: null,
          submittedByUserId: 1, // 与当前登录人 id=1 相同，触发同人自审门控
          submittedByName: '管理员',
          submittedAt: '2026-10-01T00:00:00Z',
          reviewedByUserId: null,
          reviewedByName: null,
          reviewedAt: null,
          reviewComment: null,
          exceptionReason: null,
          selfReview: false,
          lines: [],
        },
      ],
    });
    const reviewSpy = vi.spyOn(planApi, 'reviewAdjustment').mockResolvedValue({} as never);

    mountNode(<PlanExecution />, '/plan?tab=adjustments');

    await waitFor(() => expect(screen.getByText('超5工作日补报预警')).toBeTruthy());
    expect(screen.getByText('报集团公司审批')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: /^复\s*核$/ }));
    const dlg = await screen.findByRole('dialog', { name: /复核计划与预算调整申请 #88/ });
    expect(within(dlg).getByText(/同人自审管控提示/)).toBeTruthy();
    const okBtn = within(dlg).getByRole('button', { name: /^确\s*定$/ }) as HTMLButtonElement;
    expect(okBtn.disabled).toBe(true);

    fireEvent.change(within(dlg).getByPlaceholderText('说明单管理员应急复核原因'), {
      target: { value: '单人维护演练环境同人复核' },
    });
    await waitFor(() => expect((within(dlg).getByRole('button', { name: /^确\s*定$/ }) as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(within(dlg).getByRole('button', { name: /^确\s*定$/ }));
    await waitFor(() =>
      expect(reviewSpy).toHaveBeenCalledWith(
        88,
        expect.objectContaining({ action: 'approve', exceptionReason: '单人维护演练环境同人复核' }),
      ),
    );
  });

  it('BudgetVersions 对受限单位用户隐藏建版/编制/定稿控件并自动加载只读单元预算，同时工作台展示计划待办与域概览', { timeout: 30_000 }, async () => {
    clientMod.setSession({
      authenticated: true,
      csrfToken: 'csrf-bgt',
      expiresAt: '',
      user: {
        id: 22,
        username: 'unit_reader',
        displayName: '二级单位预算查看员',
        permissions: ['budget:read', 'dashboard:read', 'plan:read', 'plan:write'],
        allOrgs: false,
        orgIds: [102],
        mustChangePassword: false,
      },
    });

    vi.spyOn(clientMod.api, 'get').mockImplementation(async (path: string) => {
      if (path.startsWith('/versions/5/unit-view')) {
        return {
          version: { id: 5, year: 2026, name: '2026年度正式预算', status: 'locked', is_current: 1, kind: 'budget', source_version_id: null, note: '', created_at: '2026-02-01T00:00:00Z', locked_at: '2026-02-10T00:00:00Z' },
          scopedAllOrgs: false,
          orgs: [{ id: 102, code: 'U02', name: '甲水电运营公司' }],
          totalsByAccountType: { income: 800000000, cost: 500000000, expense: 95000000 },
          rows: [],
        } as never;
      }
      if (path.startsWith('/versions')) {
        return [
          { id: 5, year: 2026, name: '2026年度正式预算', status: 'locked', is_current: 1, kind: 'budget', source_version_id: null, note: '', created_at: '2026-02-01T00:00:00Z', locked_at: '2026-02-10T00:00:00Z' },
        ] as never;
      }
      if (path === '/dashboard/domains') {
        return {
          blocks: [
            {
              key: 'plan',
              label: '综合计划下达',
              path: '/plan',
              metrics: [{ label: '待签收下达包', value: 1, unit: 'count' }],
            },
          ],
        } as never;
      }
      return [] as never;
    });
    vi.spyOn(todoApi, 'list').mockResolvedValue({
      items: [
        { key: 'plan_issuance_ack', label: '待签收综合计划下达包', count: 1, path: '/plan?tab=packs&status=issued' },
      ],
    });

    mountNode(
      <div>
        <WorkbenchTodoCard />
        <DomainOverviewCard />
        <BudgetVersions />
      </div>,
      '/budget',
    );

    await waitFor(() => expect(screen.getByText('本单位已下达经营预算只读视图')).toBeTruthy());
    await waitFor(() => expect(screen.getByText(/本单位预算摘要 · 2026年度正式预算/)).toBeTruthy());
    expect(screen.getByRole('button', { name: '查看本单位预算' })).toBeTruthy();
    expect(screen.queryByRole('button', { name: '创建版本' })).toBeNull();
    expect(screen.queryByRole('button', { name: '测算模板' })).toBeNull();
    expect(screen.queryByRole('button', { name: '更多' })).toBeNull();

    // 工作台待办与域概览
    expect(screen.getByText('待签收综合计划下达包')).toBeTruthy();
    expect(screen.getByText('综合计划下达')).toBeTruthy();
  });
});
