// @vitest-environment jsdom
import { beforeAll, beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  cleanup,
} from '@testing-library/react';
import { App, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { ContractLegalPanel, LegalRunView } from './ContractLegalPanel';
import { ContractLegalCatalog, resolveCatalogDownloadFileName } from './ContractLegalCatalog';
import Contracts from './Contracts';
import * as clientMod from '../../api/client';
import { setSession } from '../../api/client';
import { contractApi } from '../../api/projectContract';
import type { LegalRunDto } from '@contracts/contract-legal-review';
vi.mock('../../api/projectContract', () => ({
  contractApi: {
    listPage: vi.fn(),
    summary: vi.fn(),
    get: vi.fn(),
    legalReviews: vi.fn(),
    runLegalReview: vi.fn(),
    submitReview: vi.fn(),
    decideReview: vi.fn(),
    legalPolicies: vi.fn(),
    legalTemplates: vi.fn(),
  },
}));
beforeAll(() => {
  Object.defineProperty(window, 'matchMedia', {
    writable: true,
    value: vi.fn().mockImplementation((query) => ({
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
beforeEach(() => {
  const computedStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => computedStyle(element));
});
const run = {
  id: 1,
  contractId: 3,
  documentId: 2,
  verdict: 'pass',
  riskLevel: 'info',
  summary: ['条款已核对', '制度完整', '模型证据校验通过'],
  elements: { partyA: '测试甲方', partyB: '测试乙方' },
  policyRefs: [{ id: 1, code: 'POLICY', version: 1 }],
  templateId: 1,
  templateApprovalStatus: 'official',
  documentSha256: 'a'.repeat(64),
  isCurrent: true,
  findings: [],
} as unknown as LegalRunDto;
afterEach(() => {
  cleanup();
  setSession(null);
  vi.clearAllMocks();
  vi.restoreAllMocks();
});
function setup(r = run) {
  setSession({
    authenticated: true,
    csrfToken: 'test',
    expiresAt: '',
    user: {
      id: 2,
      username: 'reviewer',
      displayName: '复核人',
      permissions: ['contract:read', 'contract:review'],
      allOrgs: false,
      orgIds: [1],
      mustChangePassword: false,
    },
  });
  vi.mocked(contractApi.legalReviews).mockResolvedValue({
    runs: [r],
    activeJob: null,
  });
  vi.mocked(contractApi.decideReview).mockResolvedValue({} as any);
  const changed = vi.fn();
  render(
    <App>
      <QueryClientProvider
        client={
          new QueryClient({ defaultOptions: { queries: { retry: false } } })
        }
      >
        <ContractLegalPanel
          contract={
            {
              id: 3,
              version: 1,
              stage: 'approval',
              status: 'active',
              documents: [],
              reviews: [{ id: 5, documentId: 2, status: 'submitted' }],
            } as any
          }
          onChanged={changed}
        />
      </QueryClientProvider>
    </App>,
  );
  return { changed };
}
describe('合同法审首屏与正式操作', () => {
  it('建议通过、3 条摘要与商务要素首屏，一次确认调用现有复核 API', async () => {
    setup();
    expect(await screen.findByText('建议通过')).toBeTruthy();
    expect(screen.getByText('测试甲方')).toBeTruthy();
    fireEvent.click(screen.getByRole('button', { name: '确认通过' }));
    await waitFor(() =>
      expect(contractApi.decideReview).toHaveBeenCalledWith(3, 5, {
        decision: 'approve',
        comment: undefined,
        exceptionReason: undefined,
      }),
    );
  });
  it('候选显著提示，人工说明随确认提交', async () => {
    setup({
      ...run,
      verdict: 'manual_review',
      templateApprovalStatus: 'candidate',
    });
    await screen.findByText('当前比对基准为候选清理稿（待主管部门核定转正）');
    fireEvent.change(screen.getByLabelText('人工核验说明（确认通过时必填）'), {
      target: { value: '已核实默认商业条件' },
    });
    fireEvent.click(screen.getByRole('button', { name: '确认通过' }));
    await waitFor(() =>
      expect(contractApi.decideReview).toHaveBeenCalledWith(
        3,
        5,
        expect.objectContaining({ comment: '已核实默认商业条件' }),
      ),
    );
  });
  it('高风险默认展开原文，批准禁用，退回带主要摘要', async () => {
    setup({
      ...run,
      verdict: 'revise',
      riskLevel: 'high',
      findings: [
        {
          source: 'rule',
          code: 'AMOUNT',
          severity: 'high',
          blocking: true,
          title: '金额不一致',
          message: '金额冲突',
          locationRef: '第2条 / P4',
          excerpt: '金额人民币壹拾元',
          expectedText: '金额应一致',
          suggestedText: '核对金额',
          policyClauseId: 1,
          templateClauseId: null,
        },
      ],
    });
    await screen.findByText('金额人民币壹拾元');
    expect(screen.getByRole('button', { name: '确认通过' })).toHaveProperty(
      'disabled',
      true,
    );
    fireEvent.click(screen.getByRole('button', { name: '退回修改' }));
    await waitFor(() =>
      expect(contractApi.decideReview).toHaveBeenCalledWith(
        3,
        5,
        expect.objectContaining({
          decision: 'reject',
          comment: run.summary.join('；'),
        }),
      ),
    );
  });
  it('失效运行不能用于确认，仍可查看历史摘要', async () => {
    setup({ ...run, isCurrent: false });
    await screen.findByText('已失效，需重新法审');
    expect(screen.queryByRole('button', { name: '确认通过' })).toBeNull();
  });

  it('F-GAP-16: legalReviewEnabled=false 时不挂载法审面板且不请求 legalReviews，文档区放行 .doc 上传', { timeout: 60_000 }, async () => {
    setSession({
      authenticated: true,
      csrfToken: 'test-gap16',
      expiresAt: '',
      user: {
        id: 2,
        username: 'writer',
        displayName: '合同经办人',
        permissions: ['contract:read', 'contract:write', 'contract:review'],
        allOrgs: true,
        orgIds: [],
        mustChangePassword: false,
      },
    });
    vi.spyOn(clientMod.api, 'get').mockImplementation(async (path: string) =>
      path.startsWith('/org/tree') ? ({ tree: [], rows: [] } as never) : ([] as never),
    );
    vi.mocked(contractApi.listPage).mockResolvedValue({ items: [], total: 0, page: 1, pageSize: 20 } as never);
    vi.mocked(contractApi.summary).mockResolvedValue({
      count: 1,
      byStatus: { active: 1, suspended: 0, closed: 0, terminated: 0, voided: 0 },
      currentAmount: '1000.00',
      paidAmount: '0.00',
      paymentRate: '0',
      pending: { reviews: 0, changes: 0, payments: 0, unpaidApproved: 0 },
    } as never);
    vi.mocked(contractApi.get).mockResolvedValue({
      id: 42,
      version: 1,
      contractNo: 'HQ-QT-001/2026-0001',
      name: '非强制法审普通合同',
      contractType: '其他',
      orgId: 1,
      orgName: '集团母公司',
      stage: 'draft',
      status: 'active',
      legalReviewEnabled: false,
      originalAmount: '1000.00',
      approvedChange: '0.00',
      currentAmount: '1000.00',
      paidAmount: '0.00',
      documents: [],
      reviews: [],
      changes: [],
      payments: [],
      events: [],
      blockers: [],
    } as never);

    render(
      <ConfigProvider locale={zhCN} theme={{ token: { motion: false } }}>
        <App>
          <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
            <MemoryRouter initialEntries={['/contracts?id=42']}>
              <Contracts />
            </MemoryRouter>
          </QueryClientProvider>
        </App>
      </ConfigProvider>,
    );

    expect(
      await screen.findByText('当前合同类别未纳入强制智能法审范围（可按内部一般流程审核或由法务配置扩展纳管类别）。'),
    ).toBeTruthy();
    expect(contractApi.legalReviews).not.toHaveBeenCalled();

    // 验证正文上传控件支持 .doc 并附提示
    expect(screen.getByText(/支持 \.docx、\.pdf 及老版 \.doc 合同正文/)).toBeTruthy();
    const uploadInput = document.querySelector('.contract-detail-drawer input[type="file"]') as HTMLInputElement;
    expect(uploadInput?.getAttribute('accept')).toContain('.doc');
  });

  it('F-GAP-16: LegalRunView 渲染 doc_converted 已转码解析标签与加密/解析降级提示', () => {
    render(
      <LegalRunView
        run={
          {
            ...run,
            parseChannel: 'doc_converted',
            parseStatus: 'doc_converted',
            findings: [
              {
                source: 'rule',
                code: 'DOC_ENCRYPTED_OR_INVALID',
                severity: 'medium',
                blocking: false,
                title: '正文提取受限',
                message: '老式 .doc 文档受密码保护',
                locationRef: '全文',
                excerpt: '',
                expectedText: '可提取正文',
                suggestedText: '转人工复核',
                policyClauseId: null,
                templateClauseId: null,
              },
            ],
          } as unknown as LegalRunDto
        }
      />,
    );
    expect(screen.getByText('已转码解析')).toBeTruthy();
    expect(screen.getByText('文档未能完整提取正文，已自动转人工复核建议')).toBeTruthy();
  });

  it('F-GAP-16: ContractLegalCatalog 无后缀原件下载自动补全 .docx / .pdf / .doc 扩展名', { timeout: 60_000 }, async () => {
    expect(resolveCatalogDownloadFileName({ code: 'TPL-TECH-01', originalFileName: null, contentType: null })).toBe(
      'TPL-TECH-01.docx',
    );
    expect(
      resolveCatalogDownloadFileName({ code: 'POL-CONTRACT-17', originalFileName: null, contentType: 'application/pdf' }),
    ).toBe('POL-CONTRACT-17.pdf');
    expect(
      resolveCatalogDownloadFileName({ code: 'TPL-LEGACY-DOC', originalFileName: 'legacy.doc', contentType: 'application/msword' }),
    ).toBe('TPL-LEGACY-DOC.doc');

    setSession({
      authenticated: true,
      csrfToken: 'test-cat',
      expiresAt: '',
      user: {
        id: 1,
        username: 'admin',
        displayName: '管理员',
        permissions: ['contract:read', 'knowledge:manage'],
        allOrgs: true,
        orgIds: [],
        mustChangePassword: false,
      },
    });
    const dlSpy = vi.spyOn(clientMod, 'download').mockResolvedValue(true);
    vi.mocked(contractApi.legalPolicies).mockResolvedValue([
      {
        id: 9,
        code: 'POL-NO-EXT',
        title: '合同管理制度汇编',
        version: 1,
        status: 'active',
        sourceNote: '测试制度',
        sourceFileObjectId: 55,
        originalFileName: null,
        contentType: 'application/pdf',
        clauses: [],
      } as never,
    ]);
    vi.mocked(contractApi.legalTemplates).mockResolvedValue([]);

    render(
      <ConfigProvider locale={zhCN} theme={{ token: { motion: false } }}>
        <App>
          <QueryClientProvider client={new QueryClient({ defaultOptions: { queries: { retry: false } } })}>
            <ContractLegalCatalog open onClose={vi.fn()} />
          </QueryClientProvider>
        </App>
      </ConfigProvider>,
    );

    const panelHdr = await screen.findByText(/POL-NO-EXT v1/);
    fireEvent.click(panelHdr);
    const dlBtn = await screen.findByText('下载原件');
    fireEvent.click(dlBtn);
    expect(dlSpy).toHaveBeenCalledWith('/contracts/legal-catalog/policies/9/source', 'POL-NO-EXT.pdf');
  });
});
