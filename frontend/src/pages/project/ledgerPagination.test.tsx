// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntdApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { MemoryRouter, useNavigate } from 'react-router-dom';
import { setSession } from '../../api/client';
import { contractApi, projectBudgetApi, type ContractDetailDto, type ContractDto, type PbBatchDto, type PbSummaryDto } from '../../api/projectContract';
import ProjectBudget from './ProjectBudget';
import Contracts from './Contracts';

let client: QueryClient;
afterEach(() => { cleanup(); client?.clear(); setSession(null); vi.restoreAllMocks(); });
beforeEach(() => {
  const computedStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => computedStyle(element));
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn(() => ({
    matches: false, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })) });
});

const totals = { budget: '100.00', executed: '0.00', remaining: '100.00', executionRate: '0.000000' };
const batch = (id: number, name: string, year = 2026): PbBatchDto => ({
  id, name, year, period: `${year}-09`, fileName: 'budget.xlsx', fileSha256: 'hash', status: 'imported', isCurrent: false,
  rowCount: 1, totals, partial: false, orgNames: ['上海'], version: 1, createdAt: '2026-09-30', activatedAt: null, voidedAt: null, voidReason: null,
});
const summary = (b: PbBatchDto | null = null): PbSummaryDto => ({
  batch: b, year: b?.year ?? 2026, period: b?.period ?? null, totals,
  byProject: [], byOrg: [], byFundSource: [], notes: [],
});

function NextLink() {
  const navigate = useNavigate();
  return <button onClick={() => navigate('/project-budget?batchId=2')}>打开另一批次</button>;
}
function mount(url: string) {
  setSession({ authenticated: true, csrfToken: 't', expiresAt: '', user: {
    id: 1, username: 'u', displayName: '预算维护', permissions: ['project_budget:read', 'project_budget:write'],
    allOrgs: true, orgIds: [], mustChangePassword: false,
  } });
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['org-tree'], { rows: [], tree: [] });
  render(<ConfigProvider locale={zhCN} theme={{ token: { motion: false } }}><AntdApp><QueryClientProvider client={client}>
    <MemoryRouter initialEntries={[url]}><ProjectBudget /><NextLink /></MemoryRouter>
  </QueryClientProvider></AntdApp></ConfigProvider>);
}

describe('预算批次分页与操作 AC-F09/F26', () => {
  it('深链按 ID 直接加载旧批次,切换深链不会复用另一批次缓存', async () => {
    const old = batch(1, '2025 历史批次', 2025);
    const other = batch(2, '2024 另一批次', 2024);
    const get = vi.spyOn(projectBudgetApi, 'batch').mockImplementation(async (id) => id === 1 ? old : other);
    const legacy = vi.spyOn(projectBudgetApi, 'batches');
    const list = vi.spyOn(projectBudgetApi, 'batchesPage').mockImplementation(async (q) => ({ items: [], total: 0, page: 1, pageSize: q.pageSize }));
    vi.spyOn(projectBudgetApi, 'summary').mockResolvedValue(summary());
    vi.spyOn(projectBudgetApi, 'entries').mockResolvedValue([]);
    mount('/project-budget?batchId=1');
    expect(await screen.findByText('2025 历史批次 · 明细')).toBeTruthy();
    expect(get).toHaveBeenCalledWith(1);
    await waitFor(() => expect(list).toHaveBeenCalledWith(expect.objectContaining({ year: 2025 })));
    expect(legacy).not.toHaveBeenCalled();
    fireEvent.click(screen.getByText('打开另一批次'));
    expect(await screen.findByText('2024 另一批次 · 明细')).toBeTruthy();
    expect(get).toHaveBeenCalledWith(2);
    await waitFor(() => expect(list).toHaveBeenCalledWith(expect.objectContaining({ year: 2024 })));
  }, 20_000);

  it('批次加载失败保留深链并提供重试,成功后展示明细', async () => {
    const get = vi.spyOn(projectBudgetApi, 'batch').mockRejectedValueOnce(new Error('临时失败')).mockResolvedValue(batch(1, '重试批次'));
    vi.spyOn(projectBudgetApi, 'batchesPage').mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 10 });
    vi.spyOn(projectBudgetApi, 'summary').mockResolvedValue(summary());
    vi.spyOn(projectBudgetApi, 'entries').mockResolvedValue([]);
    mount('/project-budget?batchId=1');
    expect(await screen.findByText('指定批次加载失败')).toBeTruthy();
    fireEvent.click(screen.getByText(/^重\s*试$/).closest('button')!);
    expect(await screen.findByText('重试批次 · 明细')).toBeTruthy();
    expect(get).toHaveBeenCalledTimes(2);
  }, 20_000);

  it('激活前读取当前期间的生效批次并明确确认;取消不写入,确认带期望 ID', async () => {
    const target = batch(9, '准备激活的新批次');
    const current = { ...batch(77, '分页外的当前批次'), isCurrent: true };
    vi.spyOn(projectBudgetApi, 'batchesPage').mockResolvedValue({ items: [target], total: 401, page: 1, pageSize: 10 });
    const overview = vi.spyOn(projectBudgetApi, 'summary').mockImplementation(async (q) => summary(q.period ? current : null));
    const activate = vi.spyOn(projectBudgetApi, 'activate').mockResolvedValue({ ...target, isCurrent: true });
    mount('/project-budget?year=2026');
    await screen.findByText('共 401 条');
    const activationButton = () => screen.getByText(/^激\s*活$/).closest('button')!;
    const open = () => fireEvent.click(activationButton());
    open();
    const dialog = (await screen.findByText('激活批次 #9')).closest('.ant-modal-content') as HTMLElement;
    expect(overview).toHaveBeenCalledWith({ year: 2026, period: '2026-09' });
    expect(within(dialog).getByText(/当前批次 #77/)).toBeTruthy();
    fireEvent.click(within(dialog).getByText(/^取\s*消$/).closest('button')!);
    await waitFor(() => expect(screen.queryByText('激活批次 #9')).toBeNull());
    expect(activate).not.toHaveBeenCalled();
    await waitFor(() => expect(activationButton().disabled).toBe(false));
    open();
    const confirm = (await screen.findByText('激活批次 #9')).closest('.ant-modal-content') as HTMLElement;
    fireEvent.click(within(confirm).getByText(/^激\s*活$/).closest('button')!);
    await waitFor(() => expect(activate).toHaveBeenCalledWith(9, 77));
  }, 30_000);
});

describe('合同台账全筛联动汇总、排序、分币种合计与草稿文档关联撤回 F-GAP-19', () => {
  const sampleRow: ContractDto = {
    id: 501,
    contractNo: 'HQ-SG-01/2026-011',
    name: '示范电站引水隧洞衬砌合同',
    contractType: '施工',
    orgId: 101,
    orgName: '甲水电开发公司',
    projectId: 12,
    projectCode: 'PRJ-012',
    projectName: '引水隧洞除险工程',
    supplierId: 30,
    supplierName: '丙水工建设集团',
    originalAmount: '500000.00',
    approvedChange: '50000.00',
    currentAmount: '550000.00',
    paidAmount: '200000.00',
    paymentRate: '0.363636',
    paymentCapRatio: null,
    stage: 'approval',
    status: 'active',
    statusReason: null,
    signDate: '2026-09-15',
    effectiveDate: '2026-09-15',
    source: 'manual',
    version: 1,
    pendingReviews: 1,
    pendingChanges: 0,
    openPayments: 0,
    createdAt: '2026-09-15T00:00:00Z',
    updatedAt: '2026-09-20T00:00:00Z',
  };

  it('切换快捷队列与高级筛选项时同步请求 listPage 与 summary，分币种渲染汇总行不跨币种相加，并支持文档 changeId 上传与撤回', async () => {
    setSession({
      authenticated: true,
      csrfToken: 't-ct',
      expiresAt: '',
      user: {
        id: 1,
        username: 'admin',
        displayName: '合同管理员',
        permissions: ['contract:read', 'contract:write', 'contract:import'],
        allOrgs: true,
        orgIds: [],
        mustChangePassword: false,
      },
    });

    const listSpy = vi.spyOn(contractApi, 'listPage').mockResolvedValue({
      items: [sampleRow],
      total: 2,
      page: 1,
      pageSize: 20,
      totals: [
        { currency: '人民币', count: 1, originalTotal: '500000.00', currentTotal: '550000.00', settledTotal: '300000.00', paidTotal: '200000.00', receivedTotal: '0.00' },
        { currency: '美元', count: 1, originalTotal: '80000.00', currentTotal: '80000.00', settledTotal: '40000.00', paidTotal: '40000.00', receivedTotal: '0.00' },
      ],
    });
    const summarySpy = vi.spyOn(contractApi, 'summary').mockResolvedValue({
      count: 2,
      byStatus: { active: 2, suspended: 0, closed: 0, terminated: 0, voided: 0 },
      byStage: { initiation: 0, procurement: 0, drafting: 0, approval: 2, performance: 0, settlement: 0, warranty: 0, closed: 0 },
      currentAmount: '550000.00',
      paidAmount: '200000.00',
      paymentRate: '0.363636',
      foreignCurrencyCount: 1,
      pending: { reviews: 1, changes: 0, payments: 0, unpaidApproved: 0 },
    });

    const detailMock: ContractDetailDto = {
      ...sampleRow,
      planItemName: '引水隧洞年度基建计划项',
      annualPlanAllocAmount: '300000.00',
      parentContractNo: 'HQ-KJ-01/2026-001',
      creditChecked: true,
      responseDocsComplete: true,
      unitApproverName: '赵总',
      unitApproverTitle: '总经理',
      handovers: [
        { id: 1, fromUndertaker: '孙工', toUndertaker: '钱工', toDept: '工程部', reason: '岗位轮换', leftPostDate: null, handoverDate: '2026-09-18', actor: '管理员', createdAt: '2026-09-18T00:00:00Z' },
      ],
      legalReviewEnabled: false,
      nextStage: 'performance',
      blockers: [],
      documents: [
        { id: 701, docType: 'change', name: '补充协议草稿.docx', fileSha256: 'sha', sizeBytes: 2048, uploadedBy: '钱工', uploadedAt: '2026-09-19T00:00:00Z', changeId: 301, changeSupplementNo: 'HQ-SG-01/2026-011(补1)', canWithdraw: true },
      ],
      reviews: [],
      changes: [
        { id: 301, delta: '50000.00', reason: '支护加固', supplementNo: 'HQ-SG-01/2026-011(补1)', evidenceDocumentId: 701, status: 'approved', submittedBy: '钱工', submittedAt: '2026-09-19T00:00:00Z', reviewedBy: '赵总', reviewedAt: '2026-09-19T01:00:00Z', comment: null, exceptionReason: null, selfReview: false },
      ],
      payments: [],
      countersigns: [],
      events: [],
    };
    vi.spyOn(contractApi, 'get').mockResolvedValue(detailMock);
    const uploadSpy = vi.spyOn(contractApi, 'uploadDocument').mockResolvedValue(detailMock.documents[0]);
    const withdrawSpy = vi.spyOn(contractApi, 'withdrawDocument').mockResolvedValue(detailMock);

    client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    client.setQueryData(['org-tree'], { rows: [], tree: [] });
    render(
      <ConfigProvider locale={zhCN} theme={{ token: { motion: false } }}>
        <AntdApp>
          <QueryClientProvider client={client}>
            <MemoryRouter initialEntries={['/contracts']}>
              <Contracts />
            </MemoryRouter>
          </QueryClientProvider>
        </AntdApp>
      </ConfigProvider>,
    );

    // 1. 验证分币种汇总行分别展示人民币与美元，不跨币种错加
    expect(await screen.findByText('当前筛选合计（人民币 · 1 份）')).toBeTruthy();
    expect(screen.getByText('当前筛选合计（美元 · 1 份）')).toBeTruthy();
    expect(screen.getByText('台账导入').closest('button')).toBeTruthy();

    // 2. 切换「待补录要素与盖章件」快捷队列，验证 listPage 与 summary 同步携带相同参数
    fireEvent.click(screen.getByText('待补录要素与盖章件'));
    await waitFor(() =>
      expect(listSpy).toHaveBeenCalledWith(
        expect.objectContaining({ migrationMode: 'legacy_tolerant', archiveStatus: 'collecting' }),
      ),
    );
    await waitFor(() =>
      expect(summarySpy).toHaveBeenCalledWith(
        expect.objectContaining({ migrationMode: 'legacy_tolerant', archiveStatus: 'collecting' }),
      ),
    );

    // 3. 点击列表表头「签订日期」排序，验证 sortBy / sortDir 传参
    const signDateHeader = screen.getAllByText('签订日期').map((el) => el.closest('th')).find(Boolean)!;
    fireEvent.click(signDateHeader);
    await waitFor(() =>
      expect(listSpy).toHaveBeenCalledWith(
        expect.objectContaining({ sortBy: 'signDate' }),
      ),
    );

    // 4. 点击合同行打开详情抽屉，验证新增基础字段描述项、文档上传传 changeId 及撤回作废交互
    fireEvent.click(await screen.findByText('示范电站引水隧洞衬砌合同'));
    expect(await screen.findByText(/引水隧洞年度基建计划项（本年分配 300000.00 元）/)).toBeTruthy();
    expect(screen.getByText('孙工 → 钱工 (2026-09-18)')).toBeTruthy();

    const changeSelect = screen.getAllByLabelText('关联补充协议')[0];
    fireEvent.mouseDown(changeSelect.closest('.ant-select')!.querySelector('.ant-select-selector')!);
    const chOpt = await screen.findAllByText(/HQ-SG-01\/2026-011\(补1\) · 支护加固/);
    fireEvent.click(chOpt[chOpt.length - 1]);

    const fileInput = document.querySelector('.contract-detail-drawer input[type="file"]') as HTMLInputElement;
    const docFile = new File(['demo'], '补充扫描件.pdf', { type: 'application/pdf' });
    fireEvent.change(fileInput, { target: { files: [docFile] } });
    await waitFor(() =>
      expect(uploadSpy).toHaveBeenCalledWith(501, docFile, 'contract_text', undefined, undefined, 301),
    );

    fireEvent.click(screen.getByText('撤回作废').closest('button')!);
    const confirmWithdrawSpan = await screen.findByText('确认撤回');
    fireEvent.click(confirmWithdrawSpan.closest('button')!);
    await waitFor(() =>
      expect(withdrawSpy).toHaveBeenCalledWith(501, 701, '草稿未引用文档撤回作废'),
    );
  }, 30_000);
});
