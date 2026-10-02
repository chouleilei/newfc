// @vitest-environment jsdom
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { AuthGate } from './App';
import { api, AUTH_EXPIRED_EVENT, getSession, setSession, type SessionInfo } from './api/client';

// 停在强制改口令页面,聚焦会话边界,不加载业务页或真实数据库。
vi.mock('./pages/ChangePassword', () => ({ default: ({ onCancel }: { onCancel: () => void }) => <button onClick={onCancel}>退出测试会话</button> }));
vi.mock('./pages/Login', () => ({ default: () => <div>测试登录页</div> }));

const session: SessionInfo = {
  authenticated: true, csrfToken: 'test-csrf', expiresAt: '',
  user: { id: 11, username: 'first', displayName: '财务人员', permissions: [], allOrgs: true, orgIds: [], mustChangePassword: true },
};
let client: QueryClient;
afterEach(() => { cleanup(); client?.clear(); setSession(null); vi.restoreAllMocks(); });

function mount() {
  client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } });
  client.setQueryData(['org-tree'], { rows: ['旧账号组织'] });
  render(<QueryClientProvider client={client}><AuthGate /></QueryClientProvider>);
}

describe('会话的查询缓存隔离 AC-F01/AC-X04', () => {
  it('进入会话清空旧缓存,登出同时取消在途查询,迟到响应不重新写回', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(session);
    vi.spyOn(api, 'post').mockResolvedValue(undefined);
    mount();
    await screen.findByText('退出测试会话');
    expect(client.getQueryData(['org-tree'])).toBeUndefined();

    let resolve!: (value: string[]) => void;
    const pending = client.fetchQuery({ queryKey: ['old-contracts'], queryFn: () => new Promise<string[]>((done) => { resolve = done; }) }).catch(() => undefined);
    fireEvent.click(screen.getByText('退出测试会话'));
    await screen.findByText('测试登录页');
    expect(getSession()).toBeNull();
    resolve(['旧账号合同']);
    await pending;
    expect(client.getQueryCache().getAll()).toHaveLength(0);
  });

  it('会话失效立即清空缓存和用户,回到登录页', async () => {
    vi.spyOn(api, 'get').mockResolvedValue(session);
    mount();
    await screen.findByText('退出测试会话');
    client.setQueryData(['project-budget'], '旧账号金额');
    act(() => { window.dispatchEvent(new CustomEvent(AUTH_EXPIRED_EVENT)); });
    await screen.findByText('测试登录页');
    expect(client.getQueryCache().getAll()).toHaveLength(0);
    expect(getSession()).toBeNull();
  });

  it('启动校验失败不保留此前的用户和查询缓存', async () => {
    setSession(session);
    vi.spyOn(api, 'get').mockRejectedValue(new Error('会话已失效'));
    mount();
    await waitFor(() => expect(screen.getByText('测试登录页')).toBeTruthy());
    expect(client.getQueryCache().getAll()).toHaveLength(0);
    expect(getSession()).toBeNull();
  });
});
