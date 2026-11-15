// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntdApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { AssistantRegistryProvider } from '../assistant/AssistantContextRegistry';
import SettingsAi, { AI_FEATURE_ORDER } from './SettingsAi';
import { api, setSession } from '../api/client';

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
  setSession(null);
  vi.restoreAllMocks();
});

describe('F-GAP-04 SettingsAi 全8项功能绑定初始化与慢响应诊断', () => {
  it('当后端仅返回7项绑定时自动补全 contract_legal_review 未绑定提示，支持一键绑定主备渠道与 degraded 延迟诊断展示', { timeout: 30_000 }, async () => {
    expect(AI_FEATURE_ORDER).toHaveLength(8);
    expect(AI_FEATURE_ORDER).toContain('contract_legal_review');

    setSession({
      authenticated: true,
      csrfToken: 'csrf-ai',
      expiresAt: '',
      user: {
        id: 1,
        username: 'admin',
        displayName: '系统管理员',
        permissions: ['settings:read', 'settings:manage'],
        allOrgs: true,
        orgIds: [],
        mustChangePassword: false,
      },
    });

    vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
      if (path === '/settings/ai-channels') {
        return {
          items: [
            {
              id: 11,
              name: '高速法审主网关',
              baseUrl: 'https://llm-primary.example.com/v1',
              keyPreview: 'sk-****1234',
              hasKey: true,
              model: 'legal-fast-v1',
              timeoutMs: 15000,
              stream: false,
              enabled: true,
              lastTestStatus: 'ok',
              lastTestLatencyMs: 620,
              lastTestMessage: 'OK',
              lastTestedAt: '2026-11-10T08:00:00Z',
              diagnostics: {
                recentCalls: 20,
                okCalls: 20,
                errorCalls: 0,
                timeoutCalls: 0,
                timeoutRate: 0,
                fallbackCalls: 0,
                p50LatencyMs: 580,
                p95LatencyMs: 910,
              },
            },
            {
              id: 12,
              name: '通用推理备用网关',
              baseUrl: 'https://llm-backup.example.com/v1',
              keyPreview: 'sk-****5678',
              hasKey: true,
              model: 'general-v2',
              timeoutMs: 30000,
              stream: true,
              enabled: true,
              lastTestStatus: 'degraded',
              lastTestLatencyMs: 7812,
              lastTestMessage: '响应成功但超过 5 秒(7812ms)',
              lastTestedAt: '2026-11-10T08:05:00Z',
              diagnostics: {
                recentCalls: 10,
                okCalls: 8,
                errorCalls: 2,
                timeoutCalls: 1,
                timeoutRate: 0.1,
                fallbackCalls: 2,
                p50LatencyMs: 4200,
                p95LatencyMs: 7900,
              },
            },
          ],
        } as never;
      }
      if (path === '/settings/ai-feature-bindings') {
        // 模拟旧库仅返回前 7 项，缺 contract_legal_review
        return {
          items: AI_FEATURE_ORDER.filter((f) => f !== 'contract_legal_review').map((feature) => ({
            feature,
            primaryChannelId: 11,
            fallbackChannelId: 12,
          })),
        } as never;
      }
      return { items: [] } as never;
    });

    const putSpy = vi.spyOn(api, 'put').mockResolvedValue({ items: [] } as never);
    const postSpy = vi.spyOn(api, 'post').mockResolvedValue({
      status: 'ok',
      latencyMs: 510,
      message: '3样本探活通过',
      sampleCount: 3,
      p50LatencyMs: 500,
      p95LatencyMs: 540,
    } as never);

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
    render(
      <ConfigProvider locale={zhCN} theme={{ token: { motion: false } }}>
        <AntdApp>
          <QueryClientProvider client={qc}>
            <MemoryRouter>
              <AssistantRegistryProvider>
                <SettingsAi />
              </AssistantRegistryProvider>
            </MemoryRouter>
          </QueryClientProvider>
        </AntdApp>
      </ConfigProvider>,
    );

    // 1. 验证 degraded (>5000ms) 慢响应诊断告警与 P50/P95 指标展示
    await waitFor(() => expect(screen.getByText(/检测到慢响应渠道（degraded > 5,000ms）/)).toBeTruthy());
    expect(screen.getByText(/通用推理备用网关 \(7812ms\)/)).toBeTruthy();
    expect(screen.getByText('P50 580ms / P95 910ms')).toBeTruthy();

    // 2. 验证 8 项功能全量渲染，且缺失的「合同智能法审」展示未绑定警告标签
    expect(screen.getByText('合同智能法审')).toBeTruthy();
    expect(screen.getByText('未绑定主渠道（当前回退默认渠道）')).toBeTruthy();

    // 3. 为「合同智能法审」独立选择主渠道与备用渠道并点击「保存绑定」
    const primarySelect = screen.getAllByLabelText('合同智能法审-主渠道')[0];
    fireEvent.mouseDown(primarySelect.closest('.ant-select')!.querySelector('.ant-select-selector')!);
    const optPrimary = await screen.findAllByText('高速法审主网关 (legal-fast-v1)');
    fireEvent.click(optPrimary[optPrimary.length - 1]);

    const fallbackSelect = screen.getAllByLabelText('合同智能法审-备用渠道')[0];
    fireEvent.mouseDown(fallbackSelect.closest('.ant-select')!.querySelector('.ant-select-selector')!);
    const optFallback = await screen.findAllByText('通用推理备用网关 (general-v2)');
    fireEvent.click(optFallback[optFallback.length - 1]);

    const saveSpan = await screen.findByText('保存绑定');
    fireEvent.click(saveSpan.closest('button')!);

    await waitFor(() => expect(putSpy).toHaveBeenCalledTimes(1));
    expect(putSpy).toHaveBeenCalledWith(
      '/settings/ai-feature-bindings',
      expect.objectContaining({
        bindings: expect.arrayContaining([
          { feature: 'contract_legal_review', primaryChannelId: 11, fallbackChannelId: 12 },
        ]),
      }),
    );

    // 4. 验证多样本探活调用 samples: 3
    const probeSpans = screen.getAllByText('3样本探活');
    fireEvent.click(probeSpans[0].closest('button')!);
    await waitFor(() =>
      expect(postSpy).toHaveBeenCalledWith('/settings/ai-channels/11/test', { samples: 3 }),
    );
  });
});
