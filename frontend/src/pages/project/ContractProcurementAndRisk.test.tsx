// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { App as AntdApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ContractProcurementTab } from './ContractProcurementTab';
import { ContractChangeTab } from './ContractChangeTab';
import RiskLedger from '../risk/RiskLedger';
import * as clientMod from '../../api/client';
import { contractApi, type ContractDetailDto, type ProcurementRecordDto } from '../../api/projectContract';
import { riskApi, type RiskRuleDto } from '../../api/riskInvestment';

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

const SHARED_RECORD: ProcurementRecordDto = {
  id: 301,
  procurementCode: 'PROC-2026-009',
  procurementTitle: '2026年度水轮机组年度框架采购',
  projectId: 12,
  orgId: 101,
  orgName: '甲水电开发公司',
  procurementTarget: 'goods',
  procurementMethod: 'public_tender',
  procurementTier: 'tier_1',
  estimatedAmount: '2600000.00',
  isTender: true,
  isLegallyMandatoryTender: true,
  undertakerUnitType: 'secondary_unit',
  approvalTier: '集体决策',
  approverName: '王总',
  twiceTenderFailed: false,
  isInvoiceReimburse: false,
  mgmDecisionDoc: '',
  tenderAgency: '某招标代理机构',
  planSubmittedAt: '2026-05-01',
  announcementDate: '2026-05-20',
  prequalSaleStart: null,
  prequalSaleEnd: null,
  docSaleStartDate: '2026-05-20',
  clarificationSiteDate: null,
  bidOpenDate: '2026-05-10', // 故意早于公告发布日 05-20，触发时间倒置红字告警
  evalReportSubmitDate: '2026-05-25',
  evalReportReceiveDate: '2026-05-26',
  candidatePublicityStart: '2026-05-27',
  candidatePublicityEnd: '2026-05-30',
  awardNoticeDate: '2026-06-02',
  invitedVendorCount: 5,
  committeeSize: 4,
  committeeQualifiedCount: 2,
  supplierInPool: true,
  directProcurementGrounds: [],
  candidateRanking: [{ rank: 1, vendorName: '乙机电设备制造有限公司', bidAmount: '2450000.00' }],
  comparisonQuotes: [],
  protestFlag: true,
  protestDetail: '',
  protestResolvedAt: null,
  reviewers: [
    { id: 1, reviewerName: '陈高工', identity: 'external', titleLevel: '高级工程师', midTitleYears: 12, hasRegQualification: true, isQualified: true },
    { id: 2, reviewerName: '刘工', identity: 'staff', titleLevel: '中级', midTitleYears: 4, hasRegQualification: false, isQualified: false },
    { id: 3, reviewerName: '周高工', identity: 'external', titleLevel: '高级工程师', midTitleYears: 10, hasRegQualification: false, isQualified: true },
    { id: 4, reviewerName: '吴代表', identity: 'owner', titleLevel: '初级', midTitleYears: 2, hasRegQualification: false, isQualified: false },
  ],
  linkedContracts: [
    { id: 60, contractNo: 'HQ-CG-01/2026-001', name: '一标段主机供货合同', orgId: 101, orgName: '甲水电开发公司' },
    { id: 61, contractNo: '***', name: '***', orgId: 102, orgName: '跨单位', redacted: true },
  ],
  linkedContractCount: 2,
  warnings: [],
  createdAt: '2026-05-01T00:00:00Z',
  updatedAt: '2026-06-02T00:00:00Z',
};

const CONTRACT_DETAIL: ContractDetailDto = {
  id: 60,
  contractNo: 'HQ-CG-01/2026-001',
  name: '一标段主机供货合同',
  contractType: '采购',
  orgId: 101,
  orgName: '甲水电开发公司',
  projectId: 12,
  projectCode: 'PRJ-012',
  projectName: '示范机组改造工程',
  supplierId: 31,
  supplierName: '乙机电设备制造有限公司',
  originalAmount: '1200000.00',
  approvedChange: '0.00',
  currentAmount: '1200000.00',
  paidAmount: '0.00',
  paymentRate: '0.000000',
  paymentCapRatio: null,
  stage: 'performance',
  status: 'active',
  statusReason: null,
  signDate: '2026-06-10',
  effectiveDate: '2026-06-10',
  source: 'manual',
  version: 1,
  pendingReviews: 0,
  pendingChanges: 0,
  openPayments: 0,
  isProcurement: true,
  procurementRecordId: 301,
  linkedProcurementContractCount: 2,
  procurementRecord: SHARED_RECORD,
  legalReviewEnabled: true,
  nextStage: 'settlement',
  blockers: [],
  documents: [{ id: 9, docType: 'change', name: '变更签证依据.pdf', fileSha256: 'abc', sizeBytes: 1024, uploadedBy: '经办', uploadedAt: '2026-08-01T00:00:00Z' }],
  reviews: [],
  changes: [
    {
      id: 15,
      delta: '50000.00',
      reason: '现场地质条件变化',
      evidenceDocumentId: 9,
      status: 'approved',
      adverseOccurredAt: '2026-09-01',
      adverseReportedAt: '2026-09-10',
      adverseOverdue2Workdays: true,
      submittedBy: '经办',
      submittedAt: '2026-09-10T00:00:00Z',
      reviewedBy: '复核人',
      reviewedAt: '2026-09-11T00:00:00Z',
      comment: '同意',
      exceptionReason: null,
      selfReview: false,
    },
  ],
  payments: [],
  events: [],
  createdAt: '2026-06-10T00:00:00Z',
  updatedAt: '2026-06-10T00:00:00Z',
};

function renderWithProviders(ui: React.ReactNode) {
  const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  qc.setQueryData(['org-tree'], { rows: [], tree: [] });
  return render(
    <ConfigProvider locale={zhCN} theme={{ token: { motion: false } }}>
      <AntdApp>
        <QueryClientProvider client={qc}>
          <MemoryRouter>{ui}</MemoryRouter>
        </QueryClientProvider>
      </AntdApp>
    </ConfigProvider>,
  );
}

describe('F-GAP-15 1:N 招采全过程台账、不利变更2工作日预警与 52条监管规则面板', () => {
  it('校验 1:N 招采挂接、时间倒置告警、评委奇偶与2/3资质统计、protestDetail 必填校验及多合同共享保存 updateShared:true', { timeout: 60_000 }, async () => {
    clientMod.setSession({
      authenticated: true,
      csrfToken: 'csrf-proc',
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

    vi.spyOn(contractApi, 'getProcurement').mockResolvedValue(SHARED_RECORD);
    vi.spyOn(contractApi, 'listProcurementRecords').mockResolvedValue([SHARED_RECORD]);
    const saveSpy = vi.spyOn(contractApi, 'saveProcurement').mockResolvedValue(SHARED_RECORD);

    renderWithProviders(<ContractProcurementTab contract={CONTRACT_DETAIL} onChanged={vi.fn()} />);

    // 1. 招标方式按一级管理提示、节点时间倒置红字提示、评委偶数/不足5人/资质不足2/3提示、跨单位脱敏标签
    await waitFor(() => expect(screen.getByText(/依 20号文附件1 招标采购项目一律按一级管理/)).toBeTruthy());
    expect(screen.getByText(/开标\/投标截止日期早于招标公告发布日期/)).toBeTruthy();
    expect(screen.getByText('须为奇数')).toBeTruthy();
    expect(screen.getByText('招标须≥5人')).toBeTruthy();
    expect(screen.getByText('资质评委未达 2/3')).toBeTruthy();
    expect(screen.getByText('跨单位关联合同(范围外已脱敏)')).toBeTruthy();

    // 2. protestFlag=true 但未填 protestDetail 时点击保存拦截
    fireEvent.click(screen.getByText('保存招采过程记录').closest('button')!);
    expect(await screen.findByText('存在质疑或投诉时必须填写详述与处置情况', {}, { timeout: 5000 })).toBeTruthy();
    expect(saveSpy).not.toHaveBeenCalled();

    // 3. 补填 protestDetail 后提交，弹出共享确认弹窗，确认后携带 updateShared: true
    fireEvent.change(screen.getByLabelText(/质疑\/投诉事项及核查处置结论详述/), {
      target: { value: '投标人就技术参数提出澄清，已按期书面答复无异议' },
    });
    fireEvent.click(screen.getByText('保存招采过程记录').closest('button')!);

    const confirmSpan = await screen.findByText('确认共享更新', {}, { timeout: 5000 });
    expect(screen.getByText(/当前招采记录被 2 份合同共享/)).toBeTruthy();
    fireEvent.click(confirmSpan.closest('button')!);

    await waitFor(() =>
      expect(saveSpy).toHaveBeenCalledWith(
        60,
        expect.objectContaining({
          updateShared: true,
          protestFlag: true,
          protestDetail: '投标人就技术参数提出澄清，已按期书面答复无异议',
        }),
      ),
    );

    // 4. 切换 1:N 关联已有招采项目模式，验证 { linkProcurementRecordId } 提交
    fireEvent.click(screen.getByText('关联已有招采项目 (1:N 共享)'));
    const linkSpan = await screen.findByText('确认挂接所选招采项目');
    fireEvent.click(linkSpan.closest('button')!);
    await waitFor(() =>
      expect(saveSpy).toHaveBeenCalledWith(60, { linkProcurementRecordId: 301 }),
    );
  });

  it('区分 direct 八种法定情形必填校验与 ContractChangeTab 不利变更超2工作日告警标签', { timeout: 30_000 }, async () => {
    clientMod.setSession({
      authenticated: true,
      csrfToken: 'csrf-direct',
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

    const directRecord: ProcurementRecordDto = {
      ...SHARED_RECORD,
      linkedContractCount: 1,
      procurementMethod: 'direct',
      protestFlag: false,
      directProcurementGrounds: [],
    };
    vi.spyOn(contractApi, 'getProcurement').mockResolvedValue(directRecord);
    vi.spyOn(contractApi, 'changeTierPreview').mockResolvedValue({
      requiredTier: 'undertaker_unit',
      requiredTierLabel: '承办单位自行审批',
      orMode: 'min',
      deltaRatio: '0.010000',
      reason: 'ok',
    });

    renderWithProviders(
      <div>
        <ContractProcurementTab contract={{ ...CONTRACT_DETAIL, linkedProcurementContractCount: 1, procurementRecord: directRecord }} onChanged={vi.fn()} />
        <ContractChangeTab contract={CONTRACT_DETAIL} onChanged={vi.fn()} />
      </div>,
    );

    // direct 模式强制要求至少选 1 项 §8.1.6 直接采购情形
    await waitFor(() => expect(screen.getByText(/直接采购法定适用情形（§8.1.6 八种情形/)).toBeTruthy());
    fireEvent.click(screen.getByText('保存招采过程记录').closest('button')!);
    expect(await screen.findByText('直接采购必须至少勾选 1 项 §8.1.6 法定情形', {}, { timeout: 5000 })).toBeTruthy();

    // ContractChangeTab 展示异常超 2 工作日上报标签
    expect(screen.getByText('异常超2工作日上报')).toBeTruthy();
  });

  it('RiskLedger 事件展示历史容缺证据待补核标签，规则页支持 PW/CW 与协同监督净版筛选', { timeout: 30_000 }, async () => {
    clientMod.setSession({
      authenticated: true,
      csrfToken: 'csrf-risk',
      expiresAt: '',
      user: {
        id: 1,
        username: 'admin',
        displayName: '管理员',
        permissions: ['contract:read', 'contract:write', 'risk:read', 'risk:review'],
        allOrgs: true,
        orgIds: [],
        mustChangePassword: false,
      },
    });

    const rulesMock: RiskRuleDto[] = [
      { code: 'PW_01', name: '应招未招规避公开招标', source: 'contract', level: 'high', threshold: null, thresholdApplies: false, enabled: true, suggestion: '核查立项审批', version: 1, updatedAt: null, detector: 'PW_01', detectorName: '应招未招', builtin: true, orgId: null, orgName: null, thresholdKind: null, thresholdLabel: null, ruleScope: 'supervision_net_33', policyRefCode: 'PW-01' },
      { code: 'CW_14', name: '不利变更超2工作日迟报', source: 'contract', level: 'medium', threshold: null, thresholdApplies: false, enabled: true, suggestion: '补报异常说明', version: 1, updatedAt: null, detector: 'CW_14', detectorName: '迟报监控', builtin: true, orgId: null, orgName: null, thresholdKind: null, thresholdLabel: null, ruleScope: 'internal_control_18', policyRefCode: 'CW-14' },
    ];
    const rulesSpy = vi.spyOn(riskApi, 'rules').mockResolvedValue(rulesMock);
    vi.spyOn(riskApi, 'events').mockResolvedValue([
      {
        id: 901,
        eventKey: 'CW_05:contract:60',
        ruleCode: 'CW_05',
        ruleName: '先干后签倒签合同',
        source: 'contract',
        level: 'medium',
        orgId: 101,
        orgName: '甲水电开发公司',
        projectId: 12,
        projectCode: 'PRJ-012',
        projectName: '示范机组改造工程',
        subjectType: 'contract',
        subjectId: 60,
        title: '历史迁入合同待核开工日期',
        description: '历史台账缺开工记录',
        amount: '1200000.00',
        metric: null,
        evidence: {},
        evidenceStatus: 'insufficient_evidence',
        ruleScope: 'supervision_net_33',
        status: 'open',
        occurrenceCount: 1,
        firstDetectedAt: '2026-10-01T00:00:00Z',
        lastDetectedAt: '2026-10-01T00:00:00Z',
        lastScanId: 1,
        lastScanHit: true,
        handlerUserId: null,
        handlerName: null,
        deadline: null,
        overdue: false,
        rectifyNote: null,
        submittedByUserId: null,
        reviewedByUserId: null,
        closedAt: null,
        reopenedCount: 0,
        version: 1,
        suggestion: '核查档案',
        createdAt: '2026-10-01T00:00:00Z',
        updatedAt: '2026-10-01T00:00:00Z',
      },
    ]);
    vi.spyOn(riskApi, 'summary').mockResolvedValue({
      total: 1, openCount: 1, openAmount: '1200000.00',
      byStatus: { open: 1, confirmed: 0, rectifying: 0, rectified: 0, closed: 0, false_positive: 0 },
      byLevel: { high: 0, medium: 1, low: 0 },
      byRule: [], pendingConfirm: 1, pendingReview: 0, overdue: 0,
    });

    renderWithProviders(<RiskLedger />);

    // RiskLedger 事件展示历史容缺证据待补核标签，规则页支持 PW/CW 与协同监督净版筛选
    expect(await screen.findByText('证据待补核(历史容缺)')).toBeTruthy();
    fireEvent.click(document.querySelector('[data-node-key="rules"] .ant-tabs-tab-btn')!);
    await waitFor(() => expect(screen.getByText('PW_01')).toBeTruthy());
    expect(screen.getByText('协同监督净版 33条')).toBeTruthy();
    expect(screen.getByText('内部扩展内控 18条')).toBeTruthy();

    const domainSelect = screen.getAllByLabelText('规则领域组')[0];
    fireEvent.mouseDown(domainSelect.closest('.ant-select')!.querySelector('.ant-select-selector')!);
    const pwOpt = await screen.findAllByText('PW 采购监管 (20条)');
    fireEvent.click(pwOpt[pwOpt.length - 1]);
    await waitFor(() => expect(screen.queryByText('CW_14')).toBeNull());
    expect(screen.getByText('PW_01')).toBeTruthy();

    const scopeSelect = screen.getAllByLabelText('规则口径筛选')[0];
    fireEvent.mouseDown(scopeSelect.closest('.ant-select')!.querySelector('.ant-select-selector')!);
    const netOpt = await screen.findAllByText('2026协同监督净版保留 (33条)');
    fireEvent.click(netOpt[netOpt.length - 1]);
    await waitFor(() => expect(rulesSpy).toHaveBeenCalledWith({ ruleScope: 'supervision_net_33' }));
  });
});
