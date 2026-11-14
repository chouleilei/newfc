// @vitest-environment jsdom
import { beforeEach, afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { App as AntdApp, ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { MemoryRouter } from 'react-router-dom';
import { AssistantProvider } from '../assistant/AssistantProvider';
import { TreeManage } from '../components/TreeNodePage';
import SecurityAdmin from './SecurityAdmin';
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

function setAdminSession() {
  setSession({
    authenticated: true,
    csrfToken: 'csrf-gap02',
    expiresAt: '',
    user: {
      id: 1,
      username: 'admin',
      displayName: '管理员',
      permissions: ['master:read', 'master:write', 'security:manage'],
      allOrgs: true,
      orgIds: [],
      mustChangePassword: false,
    },
  });
}

describe('F-GAP-02 组织树与多级用户数据范围批量导入界面', () => {
  it('组织树批量导入：预览存在阻断错误时禁用确认按钮，预览无错时允许确认提交', { timeout: 30_000 }, async () => {
    setAdminSession();
    vi.spyOn(api, 'get').mockResolvedValue({ tree: [], rows: [], externalBlockedPatterns: { prefixes: [], names: [] } } as never);
    const postSpy = vi.spyOn(api, 'post');
    postSpy.mockResolvedValueOnce({
      mode: 'preview',
      previewRows: [
        {
          row: 1,
          code: 'ORG_LOOP',
          parentCode: 'ORG_LOOP',
          name: '自环异常节点',
          orgKind: 'legal_entity',
          creditCode: '',
          planIssuanceRootCode: null,
          contractPrefixCode: 'LP',
          isPlanExcluded: false,
          isDirectStation: false,
          reportFullName: '',
          status: 'active',
          sortOrder: 1,
          action: 'create',
          errors: ['组织 ORG_LOOP 的父节点不能是自身'],
        },
      ],
      errors: [{ row: 1, field: 'parentCode', message: '组织 ORG_LOOP 的父节点不能是自身' }],
      created: 0,
      updated: 0,
    } as never);

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    render(
      <ConfigProvider locale={zhCN} theme={{ token: { motion: false } }}>
        <AntdApp>
          <QueryClientProvider client={qc}>
            <MemoryRouter initialEntries={['/org']}>
              <AssistantProvider>
                <TreeManage kind="org" checkPath="/org/check" />
              </AssistantProvider>
            </MemoryRouter>
          </QueryClientProvider>
        </AntdApp>
      </ConfigProvider>,
    );

    await waitFor(() => expect(screen.getByText('批量导入组织')).toBeTruthy());
    fireEvent.click(screen.getByText('批量导入组织'));

    const textarea = screen.getByPlaceholderText(/支持直接粘贴 CSV/);
    fireEvent.change(textarea, {
      target: { value: 'code,parentCode,name,orgKind\nORG_LOOP,ORG_LOOP,自环异常节点,legal_entity' },
    });
    fireEvent.click(screen.getByText('解析并预览'));

    await waitFor(() => expect(screen.getByText(/组织 ORG_LOOP 的父节点不能是自身/)).toBeTruthy());
    const confirmBtn = screen.getByText('确认提交').closest('button')!;
    expect((confirmBtn as HTMLButtonElement).disabled).toBe(true);
  });

  it('用户与数据范围批量导入：拦截停用历史组织写授权，无错预览后确认提交并刷新缓存', { timeout: 30_000 }, async () => {
    setAdminSession();
    vi.spyOn(api, 'get').mockImplementation(async (path: string) => {
      if (path === '/security/users') return { items: [] } as never;
      if (path === '/security/roles') return { items: [{ id: 2, code: 'unit_editor', name: '单位经办', description: '', locked: true, permissions: [], userCount: 0 }] } as never;
      if (path === '/security/permissions') return { items: [] } as never;
      if (path === '/org/tree') {
        return {
          tree: [
            { id: 10, code: 'ORG_ACTIVE', name: '存续子公司', status: 'active', orgKind: 'legal_entity' },
            { id: 11, code: 'ORG_CLOSED', name: '历史停用主体', status: 'inactive', orgKind: 'closed_history' },
          ],
          rows: [
            { id: 10, name: '存续子公司' },
            { id: 11, name: '历史停用主体' },
          ],
        } as never;
      }
      return {} as never;
    });

    const postSpy = vi.spyOn(api, 'post');
    // 第一次预览返回停用历史组织拦截
    postSpy.mockResolvedValueOnce({
      mode: 'preview',
      rows: [
        {
          row: 1,
          username: 'bad_scope_user',
          displayName: '越权测试账号',
          roleCodes: ['unit_editor'],
          roleIds: [2],
          allOrgs: false,
          orgCodes: ['ORG_CLOSED'],
          orgIds: [],
          hasPassword: true,
          action: 'create',
          errors: ['停用历史组织不可授予写权限范围（ORG_CLOSED）'],
        },
      ],
      errors: [{ row: 1, field: 'orgCodes', message: '停用历史组织不可授予写权限范围（ORG_CLOSED）' }],
      created: 0,
      updated: 0,
    } as never);
    // 第二次预览通过
    postSpy.mockResolvedValueOnce({
      mode: 'preview',
      rows: [
        {
          row: 1,
          username: 'sub_editor',
          displayName: '下属经办',
          roleCodes: ['unit_editor'],
          roleIds: [2],
          allOrgs: false,
          orgCodes: ['ORG_ACTIVE'],
          orgIds: [10],
          hasPassword: true,
          action: 'create',
          errors: [],
        },
      ],
      errors: [],
      created: 1,
      updated: 0,
    } as never);
    // 第三次确认成功
    postSpy.mockResolvedValueOnce({
      mode: 'confirm',
      rows: [],
      errors: [],
      created: 1,
      updated: 0,
    } as never);

    const qc = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');

    render(
      <ConfigProvider locale={zhCN} theme={{ token: { motion: false } }}>
        <AntdApp>
          <QueryClientProvider client={qc}>
            <MemoryRouter initialEntries={['/security']}>
              <SecurityAdmin />
            </MemoryRouter>
          </QueryClientProvider>
        </AntdApp>
      </ConfigProvider>,
    );

    await waitFor(() => expect(screen.getByText('批量初始化用户与数据范围')).toBeTruthy());
    fireEvent.click(screen.getByText('批量初始化用户与数据范围'));

    expect(screen.getByText(/密码将按服务端哈希策略存储/)).toBeTruthy();

    const textarea = screen.getByPlaceholderText(/粘贴 CSV/);
    fireEvent.change(textarea, {
      target: {
        value: 'username,displayName,roleCodes,allOrgs,orgCodes,initialPassword\nbad_scope_user,越权测试账号,unit_editor,否,ORG_CLOSED,SafePass#2026',
      },
    });
    fireEvent.click(screen.getByText('解析并预览'));

    await waitFor(() => expect(screen.getAllByText(/停用历史组织不可授予写权限范围/).length).toBeGreaterThan(0));
    const confirmBtn = screen.getByText('确认批量导入').closest('button')!;
    expect((confirmBtn as HTMLButtonElement).disabled).toBe(true);

    // 修正为有效存续组织后重新预览并确认
    fireEvent.change(textarea, {
      target: {
        value: 'username,displayName,roleCodes,allOrgs,orgCodes,initialPassword\nsub_editor,下属经办,unit_editor,否,ORG_ACTIVE,SafePass#2026',
      },
    });
    fireEvent.click(screen.getByText('解析并预览'));

    await waitFor(() => expect((confirmBtn as HTMLButtonElement).disabled).toBe(false));
    fireEvent.click(confirmBtn);

    await waitFor(() => {
      expect(postSpy).toHaveBeenCalledWith('/security/users/batch-import', expect.objectContaining({ mode: 'confirm' }));
      expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['security-users'] });
    });
  });
});
