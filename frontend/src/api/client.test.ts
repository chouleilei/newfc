import { afterEach, describe, expect, it, vi } from 'vitest';
import { api, ApiError, can, csrfHeaders, errorText, getSession, setSession, type SessionInfo } from './client';

const apiError = (message: string, errors?: { row: number; field: string; message: string }[]) =>
  new ApiError({ code: 'VALIDATION_FAILED', message, errors }, 400);

describe('errorText', () => {
  it('默认展开 ApiError 的逐行字段错误(Tree 页面语义)', () => {
    const error = apiError('校验失败', [
      { row: 2, field: 'amount', message: '金额格式不正确' },
      { row: 3, field: 'org', message: '组织不存在' },
    ]);
    expect(errorText(error)).toBe('校验失败:第2行[amount]: 金额格式不正确;第3行[org]: 组织不存在');
  });

  it('includeFieldErrors:false 只显示主消息(清洗向导语义)', () => {
    const error = apiError('校验失败', [{ row: 2, field: 'amount', message: '金额格式不正确' }]);
    expect(errorText(error, { includeFieldErrors: false })).toBe('校验失败');
  });

  it('ApiError 无字段错误时显示主消息', () => {
    expect(errorText(apiError('版本已锁定'))).toBe('版本已锁定');
  });

  it('ApiError 主消息为空时回退 fallback', () => {
    expect(errorText(apiError(''), { fallback: '操作失败' })).toBe('操作失败');
    expect(errorText(apiError(''))).toBe('未知错误');
  });

  it('普通 Error 显示 message,未知值按字符串处理', () => {
    expect(errorText(new Error('网络中断'))).toBe('网络中断');
    expect(errorText('字符串错误')).toBe('字符串错误');
  });

  it('null/undefined 回退 fallback', () => {
    expect(errorText(null)).toBe('未知错误');
    expect(errorText(undefined, { fallback: '操作失败' })).toBe('操作失败');
  });
});

describe('会话与 CSRF', () => {
  const session: SessionInfo = {
    authenticated: true,
    user: { id: 1, username: 'u1', displayName: 'U1', permissions: ['budget:read'], allOrgs: false, orgIds: [3], mustChangePassword: false },
    csrfToken: 'csrf-abc',
    expiresAt: '2026-10-01T00:00:00Z',
  };

  it('只有写请求附带内存中的 CSRF 令牌;未登录时不附带', () => {
    setSession(null);
    expect(csrfHeaders('POST')).toEqual({});
    setSession(session);
    expect(csrfHeaders('GET')).toEqual({});
    expect(csrfHeaders('post')).toEqual({ 'x-csrf-token': 'csrf-abc' });
    expect(csrfHeaders('DELETE')).toEqual({ 'x-csrf-token': 'csrf-abc' });
    setSession(null);
  });

  it('can() 反映会话权限,登出后全部为 false', () => {
    setSession(session);
    expect(can('budget:read')).toBe(true);
    expect(can('security:manage')).toBe(false);
    setSession(null);
    expect(getSession()).toBeNull();
    expect(can('budget:read')).toBe(false);
  });
});

describe('CSRF 令牌过时自动刷新', () => {
  afterEach(() => { vi.unstubAllGlobals(); setSession(null); });
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  const fresh: SessionInfo = {
    authenticated: true,
    user: { id: 1, username: 'u1', displayName: 'U1', permissions: [], allOrgs: true, orgIds: [], mustChangePassword: false },
    csrfToken: 'new-token',
    expiresAt: '2026-10-01T00:00:00Z',
  };

  it('写请求遇 CSRF_REJECTED 时刷新会话并以新令牌重试一次', async () => {
    setSession({ ...fresh, csrfToken: 'stale-token' });
    const calls: { url: string; csrf: string | null }[] = [];
    vi.stubGlobal('fetch', vi.fn(async (url: string, init: RequestInit) => {
      const csrf = new Headers(init.headers).get('x-csrf-token');
      calls.push({ url, csrf });
      if (url === '/api/auth/session') return json(200, fresh);
      return csrf === 'new-token' ? json(200, { ok: true }) : json(403, { code: 'CSRF_REJECTED', message: 'CSRF 校验失败' });
    }));
    await expect(api.post('/org', { code: 'X' })).resolves.toEqual({ ok: true });
    expect(calls.map((c) => [c.url, c.csrf])).toEqual([['/api/org', 'stale-token'], ['/api/auth/session', null], ['/api/org', 'new-token']]);
  });

  it('重试后仍被拒绝时不再循环,抛出原错误', async () => {
    setSession(fresh);
    const fetchMock = vi.fn(async (url: string) => url === '/api/auth/session' ? json(200, fresh) : json(403, { code: 'CSRF_REJECTED', message: '跨站请求被拒绝' }));
    vi.stubGlobal('fetch', fetchMock);
    await expect(api.post('/org', {})).rejects.toMatchObject({ status: 403 });
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });
});


describe('跨账号请求隔离', () => {
  afterEach(() => { vi.unstubAllGlobals(); setSession(null); });
  const original: SessionInfo = { authenticated: true, csrfToken: 'old', expiresAt: '', user: {
    id: 1, username: 'a', displayName: '同名', permissions: ['master:write'], allOrgs: false, orgIds: [3], mustChangePassword: false,
  } };
  const other: SessionInfo = { ...original, csrfToken: 'other', user: { ...original.user, id: 2 } };
  const json = (status: number, body: unknown) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  function deferred<T>() { let resolve!: (value: T) => void; const promise = new Promise<T>((r) => { resolve = r; }); return { promise, resolve }; }

  it.each([
    ['账号', other],
    ['权限', { ...original, user: { ...original.user, permissions: [] } }],
    ['组织', { ...original, user: { ...original.user, orgIds: [4] } }],
    ['改密状态', { ...original, user: { ...original.user, mustChangePassword: true } }],
  ])('%s变化后拒绝自动重放旧写操作', async (_label, fresh) => {
    setSession(original);
    const dispatchEvent = vi.fn(); vi.stubGlobal('window', { dispatchEvent });
    const fetch = vi.fn(async (url: string) => url === '/api/auth/session' ? json(200, fresh) : json(403, { code: 'CSRF_REJECTED' }));
    vi.stubGlobal('fetch', fetch);
    await expect(api.post('/master/projects', { name: '旧表单' })).rejects.toMatchObject({ body: { code: 'SESSION_CHANGED' } });
    expect(fetch).toHaveBeenCalledTimes(2);
    expect(getSession()).toBeNull();
    expect(dispatchEvent).toHaveBeenCalledOnce();
  });

  it.each([200, 401])('旧请求的迟到 HTTP %s 不覆盖新账号或使其退出', async (status) => {
    setSession(original);
    const dispatchEvent = vi.fn(); vi.stubGlobal('window', { dispatchEvent });
    const pending = deferred<Response>(); vi.stubGlobal('fetch', vi.fn(() => pending.promise));
    const result = api.get('/dashboard');
    setSession(null); setSession(other);
    pending.resolve(json(status, status === 200 ? { privateData: 'a' } : { code: 'UNAUTHORIZED' }));
    await expect(result).rejects.toMatchObject({ body: { code: 'SESSION_CHANGED' } });
    expect(getSession()).toBe(other);
    expect(dispatchEvent).not.toHaveBeenCalled();
  });

  it('解码期间切换账号也不会返回旧账号数据', async () => {
    setSession(original);
    const pending = deferred<unknown>(); const started = deferred<void>();
    vi.stubGlobal('fetch', vi.fn(async () => ({ ok: true, status: 200, headers: new Headers({ 'content-type': 'application/json' }), json: () => { started.resolve(); return pending.promise; } })));
    const result = api.get('/dashboard'); await started.promise;
    setSession(other); pending.resolve({ privateData: 'a' });
    await expect(result).rejects.toMatchObject({ body: { code: 'SESSION_CHANGED' } });
  });

  it('刷新令牌期间建立的新会话不会被旧刷新结果清除', async () => {
    setSession(original);
    const pending = deferred<Response>(); const started = deferred<void>();
    const dispatchEvent = vi.fn(); vi.stubGlobal('window', { dispatchEvent });
    const fetch = vi.fn(async (url: string) => {
      if (url === '/api/auth/session') { started.resolve(); return pending.promise; }
      return json(403, { code: 'CSRF_REJECTED' });
    }); vi.stubGlobal('fetch', fetch);
    const result = api.post('/master/projects', {}); await started.promise;
    setSession(other); pending.resolve(json(200, original));
    await expect(result).rejects.toMatchObject({ body: { code: 'SESSION_CHANGED' } });
    expect(getSession()).toBe(other); expect(fetch).toHaveBeenCalledTimes(2); expect(dispatchEvent).not.toHaveBeenCalled();
  });
});
