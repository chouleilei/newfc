// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { App as AntdApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { MemoryRouter } from 'react-router-dom';
import { api, setSession } from '../../api/client';
import { forecastApi, feasibilityApi, type FeasReportDto, type FfVersionDto } from '../../api/riskInvestment';
import Forecast from './Forecast';
import Feasibility from './Feasibility';
import MasterEntities from '../MasterEntities';
import Statements from '../financeData/Statements';
import { statementApi, type StatementBatchDto } from '../../api/financeData';

afterEach(() => { cleanup(); setSession(null); vi.restoreAllMocks(); });
beforeEach(() => {
  const computedStyle = window.getComputedStyle.bind(window);
  vi.spyOn(window, 'getComputedStyle').mockImplementation((element) => computedStyle(element));
  Object.defineProperty(window, 'matchMedia', { configurable: true, value: vi.fn(() => ({
    matches: false, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(),
  })) });
});

function mount(page: React.ReactNode, url: string, permissions: string[], client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })) {
  setSession({ authenticated: true, csrfToken: 't', expiresAt: '', user: {
    id: 1, username: 'reviewer', displayName: '复核人', permissions, allOrgs: true, orgIds: [], mustChangePassword: false,
  } });
  client.setQueryData(['org-tree'], { rows: [], tree: [] });
  render(<ConfigProvider locale={zhCN} theme={{ token: { motion: false } }}><AntdApp><QueryClientProvider client={client}>
    <MemoryRouter initialEntries={[url]}>{page}</MemoryRouter>
  </QueryClientProvider></AntdApp></ConfigProvider>);
  return client;
}

const report = (status: FeasReportDto['status']): FeasReportDto => ({
  id: 9, scenarioId: 2, scenarioCode: 'A', scenarioName: '基准', projectId: 3, projectCode: 'P1', projectName: '水库', orgName: '上海',
  runId: 4, parameterHash: 'hash', title: '过期报告样本', content: '冻结正文', source: 'template', model: 'template', promptVersion: 'v1',
  status, submittedBy: '编制人', submittedByCurrentUser: false, submittedAt: '2026-09-30', reviewer: null, reviewedAt: null, reviewComment: null,
  exceptionReason: null, selfReview: false, stale: true, version: 1, createdBy: '编制人', createdAt: '2026-09-30', updatedAt: '2026-09-30',
});

describe('复核操作闭环 AC-F03/F11/F12', () => {
  it('首页深链直接打开预测待复核队列,不请求模型列表', async () => {
    const queue = vi.spyOn(forecastApi, 'reviewQueue').mockResolvedValue({ items: [{
      versionId: 1, modelId: 2, modelName: '年度预测待审样本', orgId: 3, orgName: '上海', versionNo: 2, note: '', frozenAt: null, frozenBy: '编制人',
    }] });
    const models = vi.spyOn(forecastApi, 'models');
    mount(<Forecast />, '/forecast?tab=reviews', ['forecast:read', 'forecast:review']);
    expect(await screen.findByText('年度预测待审样本')).toBeTruthy();
    expect(queue).toHaveBeenCalledWith({ orgId: undefined });
    expect(models).not.toHaveBeenCalled();
    expect(screen.getByText('待复核').closest('[role="tab"]')?.getAttribute('aria-selected')).toBe('true');
  });

  it('可研待办深链按待审状态取数;过期稿禁止批准,保留退回', async () => {
    const r = report('pending_review');
    const list = vi.spyOn(feasibilityApi, 'reports').mockResolvedValue({ items: [r] });
    vi.spyOn(feasibilityApi, 'report').mockResolvedValue(r);
    mount(<Feasibility />, '/feasibility?tab=reports&status=pending_review&reportId=9', ['investment:read', 'investment:review']);
    await waitFor(() => expect(list).toHaveBeenCalledWith({ status: 'pending_review' }));
    const approve = (await screen.findByText('复核通过')).closest('button')!;
    expect(approve.disabled).toBe(true);
    expect(screen.getByText(/^退\s*回$/).closest('button')!.disabled).toBe(false);
    expect(screen.getByText(/过期报告不能提交或批准/)).toBeTruthy();
  });

  it.each([false, true])('可研按账号身份显示例外原因 self=%s', async (self) => {
    const r = { ...report('pending_review'), stale: false, submittedBy: self ? '旧显示名' : '复核人', submittedByCurrentUser: self };
    vi.spyOn(feasibilityApi, 'reports').mockResolvedValue({ items: [r] });
    vi.spyOn(feasibilityApi, 'report').mockResolvedValue(r);
    const review = vi.spyOn(feasibilityApi, 'reviewReport').mockResolvedValue(r);
    mount(<Feasibility />, '/feasibility?tab=reports&reportId=9', ['investment:read', 'investment:review']);
    fireEvent.click((await screen.findByText('复核通过')).closest('button')!);
    await screen.findByText('通过后报告冻结,作为可行性结论依据。');
    if (self) fireEvent.change(screen.getByLabelText('例外原因(管理员复核本人提交的报告)'), { target: { value: '单人值守' } });
    else expect(screen.queryByText(/例外原因/)).toBeNull();
    fireEvent.click(screen.getByText(/^确\s*认$/).closest('button')!);
    await waitFor(() => expect(review).toHaveBeenCalledWith(9, { expectedVersion: 1, decision: 'approve', ...(self ? { exceptionReason: '单人值守' } : {}) }));
  }, 20_000);

  it.each([false, true])('预测按账号身份显示例外原因 self=%s', async (self) => {
    const v: FfVersionDto = { id: 1, modelId: 2, versionNo: 1, status: 'frozen', note: '', contentHash: '', sourceFileName: null,
      sheets: [], cellCount: 0, params: [], outputs: [], errorCount: 0, warningCount: 0, baselineRunId: null, version: 1,
      createdAt: '', createdBy: '', frozenAt: '2026-09-30', frozenBy: self ? '旧显示名' : '复核人', frozenByCurrentUser: self, reviewStatus: 'pending', review: null };
    vi.spyOn(forecastApi, 'reviewQueue').mockResolvedValue({ items: [] });
    vi.spyOn(forecastApi, 'version').mockResolvedValue(v);
    vi.spyOn(forecastApi, 'runs').mockResolvedValue({ items: [] });
    const review = vi.spyOn(forecastApi, 'review').mockResolvedValue(v);
    mount(<Forecast />, '/forecast?tab=reviews&versionId=1', ['forecast:read', 'forecast:review']);
    fireEvent.click((await screen.findByText('复核通过')).closest('button')!);
    await screen.findByText('复核通过后,该版本的成功运行可以发布。');
    if (self) fireEvent.change(screen.getByLabelText('例外原因(管理员复核本人冻结的版本)'), { target: { value: '单人值守' } });
    else expect(screen.queryByText(/例外原因/)).toBeNull();
    fireEvent.click(screen.getByText(/^确\s*认$/).closest('button')!);
    await waitFor(() => expect(review).toHaveBeenCalledWith(1, { expectedVersion: 1, decision: 'approve', ...(self ? { exceptionReason: '单人值守' } : {}) }));
  }, 20_000);

  it('过期草稿禁止提交复核', async () => {
    const r = report('draft');
    vi.spyOn(feasibilityApi, 'reports').mockResolvedValue({ items: [r] });
    vi.spyOn(feasibilityApi, 'report').mockResolvedValue(r);
    mount(<Feasibility />, '/feasibility?tab=reports&status=draft&reportId=9', ['investment:read', 'investment:write']);
    expect((await screen.findByText('提交复核')).closest('button')!.disabled).toBe(true);
  });
});

describe('主数据扩展字段 AC-F07/F23', () => {
  it.each([['projects', '项目'], ['suppliers', '供应商']])('字段定义失败可重试,成功后才允许新建 %s', async (tab, label) => {
    const get = vi.spyOn(api, 'get').mockImplementation(async (url) => {
      if (url.startsWith('/master/custom-fields')) throw new Error('字段定义不可用');
      return [] as never;
    });
    mount(<MasterEntities />, `/master-entities?tab=${tab}`, ['master:read', 'master:write']);
    expect(await screen.findByText(`扩展字段加载失败,请重试后编辑${label}`)).toBeTruthy();
    expect(screen.getByText(`新建${label}`).closest('button')!.disabled).toBe(true);
    get.mockImplementation(async (url) => (url.startsWith('/master/custom-fields') ? { items: [] } : []) as never);
    fireEvent.click(screen.getByText(/^重\s*试$/).closest('button')!);
    await waitFor(() => expect(screen.getByText(`新建${label}`).closest('button')!.disabled).toBe(false));
  }, 20_000);
});

describe('财报批次切换 AC-F10', () => {
  it('激活批次后旧趋势缓存失效,切回趋势会重新取数', async () => {
    const batch: StatementBatchDto = {
      id: 1, orgId: 3, orgName: '上海', period: '2026-09', scope: 'consolidated', fileName: '财报.xlsx',
      status: 'imported', isCurrent: false, itemCount: 10, factCount: 20, checks: [], createdAt: '2026-09-30', warningCount: 0,
      fileSha256: 'hash', templateVersion: 'v1', sheets: [], version: 1, activatedAt: null, voidedAt: null, voidReason: null,
    };
    vi.spyOn(statementApi, 'batches').mockResolvedValue([batch]);
    vi.spyOn(statementApi, 'overview').mockResolvedValue({ batch: null, metrics: null, ratios: null, unitComparison: [] });
    const activate = vi.spyOn(statementApi, 'activate').mockResolvedValue({ ...batch, status: 'active', isCurrent: true });
    const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    const trendKey = ['stmt-trends', 3, 'consolidated', '2026-01', '2026-09'];
    client.setQueryData(trendKey, { points: [] });
    mount(<Statements />, '/statements', ['statements:read', 'statements:import'], client);
    fireEvent.click(screen.getByText('批次').closest('[role="tab"]')!);
    fireEvent.click(await screen.findByText('激活'));
    fireEvent.click((await screen.findByText(/^确\s*定$/)).closest('button')!);
    await waitFor(() => expect(activate).toHaveBeenCalledWith(1, null));
    await waitFor(() => expect(client.getQueryState(trendKey)?.isInvalidated).toBe(true));
  }, 20_000);
});
