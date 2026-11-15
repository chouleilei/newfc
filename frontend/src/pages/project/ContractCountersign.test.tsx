// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App as AntdApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ContractCountersignTab } from './ContractCountersignTab';
import { ContractBaseFormModal } from './ContractBaseFormModal';
import * as clientMod from '../../api/client';
import { contractApi, planApi, type ContractCountersignDto, type ContractDetailDto } from '../../api/projectContract';

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

const SEVEN_DEPTS: ContractCountersignDto[] = [
  { id: 1, contractId: 50, roundNo: 2, docFingerprint: 'fp2', deptCode: 'ANJI', deptName: '安技部', triggerReason: '技术安全审查', assignedReviewerUserId: null, assignedReviewerName: null, reviewerUserId: null, reviewerName: '', dueDate: '2026-10-01', overdue: true, canDecide: true, status: 'pending', opinion: '', decidedAt: null, createdAt: '2026-09-25T00:00:00Z', updatedAt: '2026-09-25T00:00:00Z' },
  { id: 2, contractId: 50, roundNo: 2, docFingerprint: 'fp2', deptCode: 'JIANGUAN', deptName: '建管/重大项目部', triggerReason: '基建施工归口', assignedReviewerUserId: null, assignedReviewerName: null, reviewerUserId: null, reviewerName: '', dueDate: null, overdue: false, canDecide: false, status: 'pending', opinion: '', decidedAt: null, createdAt: '2026-09-25T00:00:00Z', updatedAt: '2026-09-25T00:00:00Z' },
  { id: 3, contractId: 50, roundNo: 2, docFingerprint: 'fp2', deptCode: 'DIAOXIN', deptName: '调信部', triggerReason: '信息化及调度审查', assignedReviewerUserId: null, assignedReviewerName: null, reviewerUserId: 8, reviewerName: '张工', dueDate: '2026-11-20', overdue: false, canDecide: false, status: 'approved', opinion: '符合调度安全规范', decidedAt: '2026-09-26T00:00:00Z', createdAt: '2026-09-25T00:00:00Z', updatedAt: '2026-09-26T00:00:00Z' },
  { id: 4, contractId: 50, roundNo: 2, docFingerprint: 'fp2', deptCode: 'QIGUAN', deptName: '企管部', triggerReason: '合同合规与招采核验', assignedReviewerUserId: null, assignedReviewerName: null, reviewerUserId: null, reviewerName: '', dueDate: '2026-11-20', overdue: false, canDecide: false, status: 'pending', opinion: '', decidedAt: null, createdAt: '2026-09-25T00:00:00Z', updatedAt: '2026-09-25T00:00:00Z' },
  { id: 5, contractId: 50, roundNo: 2, docFingerprint: 'fp2', deptCode: 'CAIWU', deptName: '财务部', triggerReason: '预算与税务条款审查', assignedReviewerUserId: null, assignedReviewerName: null, reviewerUserId: null, reviewerName: '', dueDate: '2026-11-20', overdue: false, canDecide: false, status: 'pending', opinion: '', decidedAt: null, createdAt: '2026-09-25T00:00:00Z', updatedAt: '2026-09-25T00:00:00Z' },
  { id: 6, contractId: 50, roundNo: 2, docFingerprint: 'fp2', deptCode: 'JIESUAN', deptName: '财务结算中心', triggerReason: '收付结算账户审查', assignedReviewerUserId: null, assignedReviewerName: null, reviewerUserId: null, reviewerName: '', dueDate: '2026-11-20', overdue: false, canDecide: false, status: 'waived', opinion: '按规定免签', decidedAt: '2026-09-26T00:00:00Z', createdAt: '2026-09-25T00:00:00Z', updatedAt: '2026-09-26T00:00:00Z' },
  { id: 7, contractId: 50, roundNo: 2, docFingerprint: 'fp2', deptCode: 'JISHEN', deptName: '纪审部', triggerReason: '重大项目监督', assignedReviewerUserId: null, assignedReviewerName: null, reviewerUserId: null, reviewerName: '', dueDate: '2026-11-20', overdue: false, canDecide: false, status: 'pending', opinion: '', decidedAt: null, createdAt: '2026-09-25T00:00:00Z', updatedAt: '2026-09-25T00:00:00Z' },
  { id: 8, contractId: 50, roundNo: 1, docFingerprint: 'fp1', deptCode: 'ANJI', deptName: '安技部', triggerReason: '首轮审查', assignedReviewerUserId: null, assignedReviewerName: null, reviewerUserId: 9, reviewerName: '李工', dueDate: '2026-09-10', overdue: false, canDecide: false, status: 'superseded', opinion: '原金额已变更重签', decidedAt: '2026-09-08T00:00:00Z', createdAt: '2026-09-05T00:00:00Z', updatedAt: '2026-09-20T00:00:00Z' },
];

const BASE_CONTRACT: ContractDetailDto = {
  id: 50,
  contractNo: 'HQ-SG-01/2026-001',
  name: '示范电站泄洪闸检修项目合同',
  contractType: '施工',
  orgId: 101,
  orgName: '甲水电开发公司',
  projectId: 12,
  projectCode: 'PRJ-012',
  projectName: '泄洪闸技改工程',
  supplierId: 30,
  supplierName: '丙水利水电建设有限公司',
  originalAmount: '680000.00',
  approvedChange: '0.00',
  currentAmount: '680000.00',
  paidAmount: '0.00',
  paymentRate: '0.000000',
  paymentCapRatio: '0.950000',
  stage: 'approval',
  status: 'active',
  statusReason: null,
  signDate: '2026-10-12',
  effectiveDate: '2026-10-15',
  source: 'manual',
  version: 2,
  pendingReviews: 0,
  pendingChanges: 0,
  openPayments: 0,
  budgetType: 'lump_sum_pool',
  annualPlanAllocAmount: '680000.00',
  budgetPoolCapAmount: '1000000.00',
  budgetPoolUsedAmount: '1180000.00',
  budgetPoolRemainingAmount: '-180000.00',
  parentContractId: 40,
  procurementPlanText: '2026年度检修采购计划第5项',
  responseDocsComplete: true,
  creditChecked: true,
  relatedMgmtReviewers: '王审、赵审',
  unitApproverName: '周总',
  unitApproverTitle: '分管副总经理',
  legalReviewEnabled: true,
  nextStage: 'performance',
  blockers: [{ code: 'COUNTERSIGN_PENDING', message: '尚有部门未完成会签' }],
  documents: [],
  reviews: [],
  changes: [],
  payments: [],
  countersigns: SEVEN_DEPTS,
  events: [],
  createdAt: '2026-10-01T00:00:00Z',
  updatedAt: '2026-10-01T00:00:00Z',
};

describe('F-GAP-14 多部门结构化会签、包干总额池预警与合同基础表单全字段', () => {
  it('渲染 7 个归口部门最新轮次、超期与未配置时限标签、折叠 superseded 历史轮次，且仅允许所属部门录入必填意见结论', { timeout: 30_000 }, async () => {
    clientMod.setSession({
      authenticated: true,
      csrfToken: 'csrf-cs',
      expiresAt: '',
      user: {
        id: 5,
        username: 'anji_rev',
        displayName: '安技部审查人',
        permissions: ['contract:read', 'contract:review'],
        allOrgs: false,
        orgIds: [101],
        mustChangePassword: false,
      },
    });

    vi.spyOn(contractApi, 'countersigns').mockResolvedValue(SEVEN_DEPTS);
    const decideSpy = vi.spyOn(contractApi, 'decideCountersign').mockResolvedValue(SEVEN_DEPTS);

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    render(
      <ConfigProvider locale={zhCN} theme={{ token: { motion: false } }}>
        <AntdApp>
          <QueryClientProvider client={qc}>
            <MemoryRouter>
              <ContractCountersignTab contract={BASE_CONTRACT} onChanged={vi.fn()} />
            </MemoryRouter>
          </QueryClientProvider>
        </AntdApp>
      </ConfigProvider>,
    );

    // 7 个部门全部可见 + 超期标签 + 未配置时限提示 + superseded 历史折叠面板
    await waitFor(() => expect(screen.getByText('安技部')).toBeTruthy());
    for (const name of ['建管/重大项目部', '调信部', '企管部', '财务部', '财务结算中心', '纪审部']) {
      expect(screen.getByText(name)).toBeTruthy();
    }
    expect(screen.getByText('已超期')).toBeTruthy();
    expect(screen.getByText('未配置时限（仅计历时）')).toBeTruthy();
    expect(screen.getByText(/已因合同变更失效重签的历史会签记录 \(superseded · 1 条\)/)).toBeTruthy();

    // 仅 canDecide=true 的安技部行出现 1 个「录入会签结论」按钮
    const decideBtns = screen.getAllByRole('button', { name: '录入会签结论' });
    expect(decideBtns).toHaveLength(1);

    fireEvent.click(decideBtns[0]);
    const dlg = await screen.findByRole('dialog', { name: /录入会签结论 · 安技部/ });

    // 意见为空时校验拦截不提交
    fireEvent.click(within(dlg).getByRole('button', { name: '提交会签结论' }));
    expect(await within(dlg).findByText('请填写明确会签意见', {}, { timeout: 5000 })).toBeTruthy();
    expect(decideSpy).not.toHaveBeenCalled();

    fireEvent.change(within(dlg).getByPlaceholderText(/请填写本部门专业审查/), {
      target: { value: '安全技术措施完备，同意会签通过' },
    });
    fireEvent.click(within(dlg).getByRole('button', { name: '提交会签结论' }));
    await waitFor(() =>
      expect(decideSpy).toHaveBeenCalledWith(50, 1, {
        decision: 'approved',
        opinion: '安全技术措施完备，同意会签通过',
      }),
    );
  });

  it('ContractBaseFormModal 在 lump_sum_pool 超额时展示红字预警，并完整回显提交新增采集字段', { timeout: 30_000 }, async () => {
    clientMod.setSession({
      authenticated: true,
      csrfToken: 'csrf-form',
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

    vi.spyOn(clientMod.api, 'get').mockResolvedValue([] as never);
    vi.spyOn(contractApi, 'list').mockResolvedValue([
      { ...BASE_CONTRACT, id: 40, contractNo: 'HQ-KJ-01/2026-001', name: '年度检修主框架协议' },
    ]);
    vi.spyOn(planApi, 'batches').mockResolvedValue([]);
    const updateSpy = vi.spyOn(contractApi, 'update').mockResolvedValue(BASE_CONTRACT);

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    qc.setQueryData(['org-tree'], { rows: [{ id: 101, code: 'U01', name: '甲水电开发公司', status: 'active' }], tree: [] });

    render(
      <ConfigProvider locale={zhCN} theme={{ token: { motion: false } }}>
        <AntdApp>
          <QueryClientProvider client={qc}>
            <MemoryRouter>
              <ContractBaseFormModal open contract={BASE_CONTRACT} onClose={vi.fn()} onSaved={vi.fn()} />
            </MemoryRouter>
          </QueryClientProvider>
        </AntdApp>
      </ConfigProvider>,
    );

    await waitFor(() =>
      expect(screen.getByText(/生产经营总额包干池超限预警：超出可用额度 180000.00 元/)).toBeTruthy(),
    );
    expect((screen.getByLabelText('本年度计划执行分配额(元)') as HTMLInputElement).value).toBe('680000.00');
    expect((screen.getByLabelText('采购计划文号/说明') as HTMLInputElement).value).toBe('2026年度检修采购计划第5项');
    expect((screen.getByLabelText('归口会签审查人') as HTMLInputElement).value).toBe('王审、赵审');
    expect((screen.getByLabelText('单位审签领导职务') as HTMLInputElement).value).toBe('分管副总经理');

    const okBtn = screen.getByRole('button', { name: /^确\s*定$/ });
    fireEvent.click(okBtn);

    await waitFor(() => expect(updateSpy).toHaveBeenCalledTimes(1));
    expect(updateSpy).toHaveBeenCalledWith(
      50,
      expect.objectContaining({
        annualPlanAllocAmount: '680000.00',
        budgetPoolCapAmount: '1000000.00',
        parentContractId: 40,
        procurementPlanText: '2026年度检修采购计划第5项',
        responseDocsComplete: true,
        creditChecked: true,
        relatedMgmtReviewers: '王审、赵审',
        unitApproverTitle: '分管副总经理',
        expectedVersion: 2,
      }),
    );
  });
});
