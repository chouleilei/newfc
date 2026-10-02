import { afterEach, expect, it, vi } from 'vitest';
import { streamChat } from './assistant';
import { getSession, setSession, type SessionInfo } from './client';
const session: SessionInfo = { authenticated: true, csrfToken: 't', expiresAt: '', user: {
  id: 1, username: 'a', displayName: 'a', permissions: [], allOrgs: true, orgIds: [], mustChangePassword: false,
} };
const other = { ...session, user: { ...session.user, id: 2 } };
afterEach(() => { setSession(null); vi.unstubAllGlobals(); });

it('旧助手流的迟到401不会退出新账号', async () => {
  setSession(session);
  const dispatchEvent = vi.fn(); vi.stubGlobal('window', { dispatchEvent });
  let resolve!: (response: Response) => void;
  vi.stubGlobal('fetch', vi.fn(() => new Promise<Response>((r) => { resolve = r; })));
  const result = streamChat({ message: '查询' });
  setSession(other);
  resolve(new Response(JSON.stringify({ code: 'UNAUTHORIZED' }), { status: 401, headers: { 'content-type': 'application/json' } }));
  await expect(result).rejects.toMatchObject({ body: { code: 'SESSION_CHANGED' } });
  expect(getSession()).toBe(other); expect(dispatchEvent).not.toHaveBeenCalled();
});

it('账号变化后停止输出旧助手流并取消读取', async () => {
  setSession(session);
  let controller!: ReadableStreamDefaultController<Uint8Array>;
  const cancel = vi.fn(); let reading!: () => void;
  const started = new Promise<void>((r) => { reading = r; });
  const body = new ReadableStream<Uint8Array>({ start(c) { controller = c; }, pull() { reading(); }, cancel });
  vi.stubGlobal('fetch', vi.fn(async () => new Response(body)));
  const onToken = vi.fn(); const onDone = vi.fn();
  const result = streamChat({ message: '查询' }, { onToken, onDone });
  await started; await Promise.resolve(); setSession(other);
  controller.enqueue(new TextEncoder().encode('event: token\ndata: {"text":"旧账号数据"}\n\nevent: done\ndata: {}\n\n'));
  await expect(result).rejects.toMatchObject({ body: { code: 'SESSION_CHANGED' } });
  expect(onToken).not.toHaveBeenCalled(); expect(onDone).not.toHaveBeenCalled(); expect(cancel).toHaveBeenCalledOnce();
});
