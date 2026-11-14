// @vitest-environment jsdom
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
  cleanup,
} from '@testing-library/react';
import { App } from 'antd';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { ContractLegalPanel, LegalRunView } from './ContractLegalPanel';
import { setSession } from '../../api/client';
import { contractApi } from '../../api/projectContract';
import type { LegalRunDto } from '@contracts/contract-legal-review';
vi.mock('../../api/projectContract', () => ({
  contractApi: {
    legalReviews: vi.fn(),
    runLegalReview: vi.fn(),
    submitReview: vi.fn(),
    decideReview: vi.fn(),
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
});
