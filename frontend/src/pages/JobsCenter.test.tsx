import { renderToStaticMarkup } from 'react-dom/server';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { afterEach, expect, it } from 'vitest';
import JobsCenter from './JobsCenter';
import { setSession } from '../api/client';

afterEach(() => setSession(null));
it('模型调用页签同时要求读取权限和全组织范围', () => {
  const render = (permissions: string[], allOrgs: boolean) => {
    setSession({ authenticated: true, csrfToken: 't', expiresAt: '', user: { id: 1, username: 'u', displayName: 'u', permissions, allOrgs, orgIds: [3], mustChangePassword: false } });
    return renderToStaticMarkup(<QueryClientProvider client={new QueryClient()}><JobsCenter /></QueryClientProvider>);
  };
  expect(render(['tasks:read'], false)).not.toContain('模型调用');
  expect(render([], true)).not.toContain('模型调用');
  expect(render(['tasks:read'], true)).toContain('模型调用');
});
