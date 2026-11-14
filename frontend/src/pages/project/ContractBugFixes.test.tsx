// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntdApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ContractSafeguardTab } from './ContractSafeguardTab';
import { ContractBaseFormModal } from './ContractBaseFormModal';
import { ContractChangeTab } from './ContractChangeTab';
import { ContractSettlementTab } from './ContractSettlementTab';
import Contracts from './Contracts';
import { EVIDENCE_LABELS } from './contractOptions';
import * as clientMod from '../../api/client';
import { contractApi, planApi, type ContractDetailDto } from '../../api/projectContract';

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

function mockWriterSession() {
  clientMod.setSession({
    authenticated: true,
    csrfToken: 'csrf-gap18',
    expiresAt: '',
    user: {
      id: 1,
      username: 'admin',
      displayName: '管理员',
      permissions: ['contract:read', 'contract:write', 'contract:review'],
      allOrgs: true,
      orgIds: [],
      mustChangePassword: false,
    },
  });
}

const BASE_CONTRACT: ContractDetailDto = {
  id: 201,
  version: 2,
  contractNo: 'HQ-SG-001/2026-0001',
  name: '测试枢纽大坝维护合同',
  contractType: '工程',
  orgId: 1,
  orgName: '集团母公司',
  projectId: null,
  projectCode: null,
  projectName: null,
  supplierId: null,
  supplierName: null,
  stage: 'performance',
  status: 'active',
  statusReason: null,
  source: 'manual',
  direction: 'expense',
  pricingMode: 'unit_price',
  currency: '人民币',
  originalAmount: '1000000.00',
  approvedChange: '0.00',
  currentAmount: '1000000.00',
  paidAmount: '0.00',
  paymentRate: '0',
  paymentCapRatio: null,
  signDate: '2026-05-01',
  effectiveDate: '2026-05-01',
  farmerWageAccount: '6222000012345678（测试银行专户）',
  changeOrMode: 'max',
  legalReviewEnabled: false,
  documents: [
    { id: 11, name: '技术专项论证意见.pdf', docType: 'other', evidenceKind: 'tech_special_audit', uploadedBy: 'admin', uploadedAt: '2026-05-02T00:00:00Z' },
    { id: 12, name: '计划外立项批件.pdf', docType: 'other', evidenceKind: 'out_of_plan_approval', uploadedBy: 'admin', uploadedAt: '2026-05-02T00:00:00Z' },
    { id: 13, name: '无关普通安全协议.pdf', docType: 'other', evidenceKind: 'safety_protocol', uploadedBy: 'admin', uploadedAt: '2026-05-02T00:00:00Z' },
    { id: 14, name: '发票扫描件.pdf', docType: 'invoice', evidenceKind: null, uploadedBy: 'admin', uploadedAt: '2026-05-03T00:00:00Z' },
  ],
  reviews: [],
  changes: [],
  settlements: [
    {
      id: 31,
      periodNo: 1,
      settlementKind: 'progress',
      settlementDate: '2026-06-15',
      priorNetPayableAmount: '0.00',
      inContractAmount: '200000.00',
      changeClaimAmount: '0.00',
      otherAddAmount: '0.00',
      grossPayableAmount: '200000.00',
      deductPrepaymentAmount: '0.00',
      deductRetentionAmount: '10000.00',
      deductPenaltyAmount: '0.00',
      totalDeductAmount: '10000.00',
      netPayableAmount: '190000.00',
      ytdNetPayableAmount: '190000.00',
      cumulativeNetPayableAmount: '190000.00',
      status: 'approved',
      submittedBy: 'admin',
      submittedAt: '2026-06-15T00:00:00Z',
      reviewedBy: 'admin',
      reviewedAt: '2026-06-16T00:00:00Z',
      comment: null,
      exceptionReason: '测试例外',
      selfReview: true,
    } as never,
  ],
  payments: [
    {
      id: 41,
      nodeName: '一期进度款',
      paymentType: 'progress',
      amount: '150000.00',
      currency: '人民币',
      status: 'approved',
      approvalTier: 'finance_vp',
      approverName: '张总',
      submittedBy: 'admin',
      submittedAt: '2026-06-20T00:00:00Z',
      reviewedBy: 'admin',
      comment: null,
      exceptionReason: '测试例外',
      selfReview: true,
      paidDate: null,
      voucherNo: null,
    } as never,
  ],
  guarantees: [],
  disputes: [],
  events: [
    {
      id: 91,
      eventType: 'ARCHIVE_CHECKED',
      fromStage: 'performance',
      toStage: 'performance',
      actor: 'admin',
      createdAt: '2026-06-25T00:00:00Z',
      detail: { transferNo: 'ARCH-2026-08', archiveStatus: 'checked' },
    },
  ],
  blockers: [],
  nextStage: 'settlement',
} as unknown as ContractDetailDto;

describe('F-GAP-18 7项前端代码与校验 Bug 清零回归测试', () => {
  it('1) ContractSafeguardTab 录入 "0.10" 保函比例通过正则校验并成功提交', { timeout: 60_000 }, async () => {
    expect(EVIDENCE_LABELS.boq_quantity_settlement).toBe('工程量结算书');
    expect(EVIDENCE_LABELS.boq_price_settlement).toBe('工程价款结算书');

    mockWriterSession();
    const createGuaranteeSpy = vi.spyOn(contractApi, 'createGuarantee').mockResolvedValue(BASE_CONTRACT);

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <ConfigProvider locale={zhCN} theme={{ token: { motion: false } }}>
        <AntdApp>
          <QueryClientProvider client={qc}>
            <ContractSafeguardTab contract={BASE_CONTRACT} onChanged={vi.fn()} />
          </QueryClientProvider>
        </AntdApp>
      </ConfigProvider>,
    );

    fireEvent.click(screen.getByText('登记保函 / 保险'));
    const ratioInput = await screen.findByPlaceholderText('如 0.10');
    fireEvent.change(ratioInput, { target: { value: '0.10' } });
    fireEvent.click(screen.getByText(/^确\s*定$/));

    await waitFor(() => {
      expect(createGuaranteeSpy).toHaveBeenCalledWith(
        201,
        expect.objectContaining({ ratio: '0.10' }),
      );
    });
  });

  it('2) ContractBaseFormModal 正常合同拒绝 -100.00 负金额，且编辑态承办组织 OrgSelect 处于 disabled', { timeout: 60_000 }, async () => {
    mockWriterSession();
    vi.spyOn(clientMod.api, 'get').mockImplementation(async (path: string) =>
      path.startsWith('/org/tree')
        ? ({
            tree: [{ id: 1, code: 'HQ', name: '集团母公司', status: 'active', orgKind: 'legal_entity' }],
            rows: [],
          } as never)
        : ([] as never),
    );
    vi.spyOn(contractApi, 'list').mockResolvedValue([]);
    vi.spyOn(planApi, 'batches').mockResolvedValue([]);
    const updateSpy = vi.spyOn(contractApi, 'update').mockResolvedValue(BASE_CONTRACT);

    const draftContract: ContractDetailDto = { ...BASE_CONTRACT, stage: 'drafting', pricingMode: 'lump_sum' };
    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <ConfigProvider locale={zhCN} theme={{ token: { motion: false } }}>
        <AntdApp>
          <QueryClientProvider client={qc}>
            <ContractBaseFormModal open contract={draftContract} onClose={vi.fn()} onSaved={vi.fn()} />
          </QueryClientProvider>
        </AntdApp>
      </ConfigProvider>,
    );

    expect(await screen.findByText('组织归属创建后不可直接更改')).toBeTruthy();
    const orgFormItem = screen.getByText('承办组织').closest('.ant-form-item')!;
    expect(orgFormItem.querySelector('.ant-select-disabled')).toBeTruthy();

    const amtItem = screen.getByText('原始金额(元)').closest('.ant-form-item')!;
    const amtInput = amtItem.querySelector('input')!;
    fireEvent.change(amtInput, { target: { value: '-100.00' } });
    fireEvent.click(document.querySelector('.ant-modal-footer .ant-btn-primary')!);

    await waitFor(
      () => {
        expect(screen.getAllByText(/正常合同金额须为非负数/).length).toBeGreaterThan(0);
      },
      { timeout: 10_000 },
    );
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('3) ContractChangeTab 读取 changeOrMode="max" 并按 evidenceKind 严格过滤技术复核与计划外凭据附件', { timeout: 60_000 }, async () => {
    mockWriterSession();
    vi.spyOn(contractApi, 'changeTierPreview').mockResolvedValue({
      requiredTier: 'general_manager',
      requiredTierLabel: '总经理',
      orMode: 'max',
      reason: '单次增额达 12% 触发从宽口径总经理审批',
    } as never);

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <ConfigProvider locale={zhCN} theme={{ token: { motion: false } }}>
        <AntdApp>
          <QueryClientProvider client={qc}>
            <ContractChangeTab contract={BASE_CONTRACT} onChanged={vi.fn()} />
          </QueryClientProvider>
        </AntdApp>
      </ConfigProvider>,
    );

    fireEvent.click(screen.getByText('提交变更 / 索赔'));
    expect(await screen.findByText(/比例或定额任一达标·从宽/)).toBeTruthy();

    // 打开技术归口专项复核意见下拉：只包含 tech_special_audit，不包含安全协议
    const techItem = screen.getByText('技术归口专项复核意见(>10%时必填)').closest('.ant-form-item')!;
    fireEvent.mouseDown(techItem.querySelector('.ant-select-selector')!);
    expect(await screen.findByText(/技术专项论证意见\.pdf/)).toBeTruthy();
    expect(screen.queryByText(/无关普通安全协议\.pdf/)).toBeNull();

    // 打开计划外审批凭据下拉：只包含 out_of_plan_approval
    const outPlanItem = screen.getByText('计划外审批凭据(超综合计划时必填)').closest('.ant-form-item')!;
    fireEvent.mouseDown(outPlanItem.querySelector('.ant-select-selector')!);
    expect(await screen.findByText(/计划外立项批件\.pdf/)).toBeTruthy();
  });

  it('4 & 5) ContractSettlementTab 支持应扣负数、阻断负净额、展示附件8四列累计、调用 /payment-tier-preview、联动农民工专户及 DatePicker 登记支付', { timeout: 60_000 }, async () => {
    mockWriterSession();
    const payTierSpy = vi.spyOn(contractApi, 'paymentTierPreview').mockResolvedValue({
      requiredTier: 'finance_vp',
      requiredTierLabel: '公司分管财务领导',
      netAssetFound: true,
      priorYear: 2025,
      onePercentAmount: '800000.00',
      ceilingAmount: '5000000.00',
    } as never);

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <ConfigProvider locale={zhCN} theme={{ token: { motion: false } }}>
        <AntdApp>
          <QueryClientProvider client={qc}>
            <ContractSettlementTab contract={BASE_CONTRACT} onChanged={vi.fn()} />
          </QueryClientProvider>
        </AntdApp>
      </ConfigProvider>,
    );

    // 列表包含附件 8 四列累计表头
    expect(screen.getAllByText('上期合计').length).toBeGreaterThan(0);
    expect(screen.getAllByText('本期结算(净额)').length).toBeGreaterThan(0);
    expect(screen.getAllByText('本年合计').length).toBeGreaterThan(0);
    expect(screen.getAllByText('合同累计').length).toBeGreaterThan(0);

    // 打开结算单弹窗：单价合同提示工程量/价款结算书，应扣支持负数，净额为负时禁用确定按钮
    fireEvent.click(screen.getByText('提交结算单'));
    expect(await screen.findByText(/请确认已在文档区上传《工程量结算书》与《工程价款结算书》/)).toBeTruthy();

    const deductPreInput = screen
      .getByText('扣回预付款(元，可为负)')
      .closest('.ant-form-item')!
      .querySelector('input')!;
    fireEvent.change(deductPreInput, { target: { value: '-50.00' } });
    expect(screen.queryByText(/须为非负金额/)).toBeNull();

    // 当应结为 0、应扣为 +200 时净额 -200 < 0，确定按钮禁用并标红
    fireEvent.change(deductPreInput, { target: { value: '200.00' } });
    expect(await screen.findByText(/净应付\/收金额不可为负/)).toBeTruthy();
    const okBtns = screen.getAllByText(/^确\s*定$/);
    const settleOkBtn = okBtns[okBtns.length - 1].closest('button')!;
    expect(settleOkBtn.disabled).toBe(true);
    fireEvent.click(screen.getByText(/^取\s*消$/));

    // 打开付款申请弹窗：输入 400000.00 调用 /payment-tier-preview，勾选农民工专户展开专户核对栏
    fireEvent.click(screen.getByText('付款申请'));
    const payAmtInput = (await screen.findByText('金额(人民币元)'))
      .closest('.ant-form-item')!
      .querySelector('input')!;
    fireEvent.change(payAmtInput, { target: { value: '400000.00' } });

    await waitFor(() => {
      expect(payTierSpy).toHaveBeenCalledWith(201, expect.objectContaining({ amount: '400000.00' }));
    });
    expect(await screen.findByText(/制度分级要求：不低于「公司分管财务领导」/)).toBeTruthy();
    expect(screen.getByText(/1% 门槛：800000\.00 元/)).toBeTruthy();

    fireEvent.click(screen.getByText('转入农民工工资专户'));
    expect(await screen.findByText(/6222000012345678（测试银行专户）/)).toBeTruthy();
    const cancelBtns = screen.getAllByText(/^取\s*消$/);
    fireEvent.click(cancelBtns[cancelBtns.length - 1]);

    // 点击「登记支付」：出现受控 .ant-picker 控件而非手输文本框
    fireEvent.click(screen.getByText('登记支付'));
    await screen.findByText('支付日期');
    expect(document.querySelectorAll('.ant-modal .ant-picker').length).toBeGreaterThan(0);
  });

  it('5 & 6) Contracts 详情抽屉分发备案弹窗渲染 .ant-picker，且事件时间轴完整渲染 e.detail', { timeout: 60_000 }, async () => {
    mockWriterSession();
    vi.spyOn(clientMod.api, 'get').mockImplementation(async (path: string) =>
      path.startsWith('/org/tree') ? ({ tree: [], rows: [] } as never) : ([] as never),
    );
    vi.spyOn(contractApi, 'listPage').mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 } as never);
    vi.spyOn(contractApi, 'summary').mockResolvedValue({
      count: 1,
      byStatus: { active: 1, suspended: 0, closed: 0, terminated: 0, voided: 0 },
      currentAmount: '1000000.00',
      paidAmount: '0.00',
      paymentRate: '0',
      pending: { reviews: 0, changes: 0, payments: 0, unpaidApproved: 0 },
    } as never);
    vi.spyOn(contractApi, 'get').mockResolvedValue(BASE_CONTRACT);

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <ConfigProvider locale={zhCN} theme={{ token: { motion: false } }}>
        <AntdApp>
          <QueryClientProvider client={qc}>
            <MemoryRouter initialEntries={['/contracts?id=201']}>
              <Contracts />
            </MemoryRouter>
          </QueryClientProvider>
        </AntdApp>
      </ConfigProvider>,
    );

    // 点击「分发备案」弹出带 DatePicker 的受控弹窗
    const distBtn = await screen.findByText('分发备案');
    fireEvent.click(distBtn);
    expect(await screen.findByText('登记盖章件分发备案')).toBeTruthy();
    expect(document.querySelectorAll('.ant-modal .ant-picker').length).toBeGreaterThan(0);
    fireEvent.click(screen.getByText(/^取\s*消$/));

    // 切换到「事件」页签，验证 e.detail 键值对渲染
    fireEvent.click(screen.getByText('事件'));
    expect(await screen.findByText('transferNo: ARCH-2026-08')).toBeTruthy();
    expect(screen.getByText('archiveStatus: checked')).toBeTruthy();
  });
});
