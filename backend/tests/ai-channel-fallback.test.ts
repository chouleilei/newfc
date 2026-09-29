/**
 * LLM 渠道管理 §7.3-3 验收:主渠道失效时备用渠道自动生效。
 * 覆盖 complete()/streamChat() 两条路径 × 各类失效模式:
 * - 5xx/连接失败/超时/载荷异常 → 切备用(结果 model 字段带备用渠道名前缀);
 * - 4xx 鉴权错误 → 不切备用(换渠道大概率同样失败);
 * - 流读取中途卡死且零产出 → 切备用;已产出正文后卡死 → 不切(避免正文重复)。
 */
import { describe, it, expect, afterEach } from 'vitest';
import { EnvChatModel, setChannelResolver, type AiFeature } from '../src/assistant/model';

interface FakeChannel { id: number; name: string; base_url: string; api_key: string; model: string; timeout_ms: number; stream: 0 | 1 }
const primary: FakeChannel = { id: 1, name: '主渠道', base_url: 'http://primary.test/v1', api_key: 'sk-p', model: 'model-p', timeout_ms: 2_000, stream: 1 };
const fallback: FakeChannel = { id: 2, name: '备用渠道', base_url: 'http://fallback.test/v1', api_key: 'sk-f', model: 'model-f', timeout_ms: 2_000, stream: 1 };
const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
  setChannelResolver(null);
});

function install(failMode: string) {
  setChannelResolver((feature?: AiFeature) => ({
    primary,
    fallback: feature === 'chat' ? fallback : null,
    anyEnabled: true,
  }));
  globalThis.fetch = (async (url: unknown, init?: { body?: string }) => {
    const isPrimary = String(url).includes('primary.test');
    const isStream = init?.body ? init.body.includes('"stream":true') : false;
    if (!isPrimary) {
      return new Response(JSON.stringify({ choices: [{ message: { content: 'FALLBACK-OK' } }] }), { status: 200 });
    }
    switch (failMode) {
      case 'http500': return new Response('server exploded', { status: 500 });
      case 'http401': return new Response('bad key', { status: 401 });
      case 'connect-refused': throw new TypeError('fetch failed');
      case 'connect-timeout':
        await new Promise((r) => setTimeout(r, 5_000));
        return new Response('{}', { status: 200 });
      case 'json-garbage': return new Response('not json at all', { status: 200 });
      case 'mid-stream-stall':
        if (isStream) {
          return new Response(new ReadableStream({ start() { /* 永不 enqueue */ } }), {
            status: 200,
            headers: { 'content-type': 'text/event-stream' },
          });
        }
        return new Response(JSON.stringify({ choices: [{ message: { content: 'P-OK' } }] }), { status: 200 });
      default:
        return new Response(JSON.stringify({ choices: [{ message: { content: 'PRIMARY-OK' } }] }), { status: 200 });
    }
  }) as typeof fetch;
}

const input = { messages: [{ role: 'user', content: 'hi' }] };

/** consume:跑完 streamChat 收集最终 result(不做正文级断言,断言渠道前缀)。 */
async function streamResult(failMode: string): Promise<{ model?: string; text: string; events: number }> {
  install(failMode);
  let events = 0;
  let text = '';
  let model: string | undefined;
  for await (const ev of new EnvChatModel('chat').streamChat(input)) {
    events++;
    if (ev.type === 'text') text += ev.text;
    if (ev.type === 'result') { model = ev.result.model; text = ev.result.text; }
  }
  return { model, text, events };
}

describe('LLM 渠道管理:主渠道失效时备用渠道生效', () => {
  it('基线:主渠道正常时结果带主渠道名前缀,不触发备用', async () => {
    install('ok');
    const completed = await new EnvChatModel('chat').complete(input);
    expect(completed.model).toBe('主渠道/model-p');
    expect(completed.text).toBe('PRIMARY-OK');
    const streamed = await streamResult('ok');
    expect(streamed.model).toBe('主渠道/model-p');
  });

  it('HTTP 5xx:complete 与 streamChat 都切备用', async () => {
    install('http500');
    const completed = await new EnvChatModel('chat').complete(input);
    expect(completed.model).toBe('备用渠道/model-f');
    expect(completed.text).toBe('FALLBACK-OK');
    const streamed = await streamResult('http500');
    expect(streamed.model).toBe('备用渠道/model-f');
    expect(streamed.text).toBe('FALLBACK-OK');
  });

  it('连接拒绝(fetch failed):complete 与 streamChat 都切备用', async () => {
    install('connect-refused');
    expect((await new EnvChatModel('chat').complete(input)).model).toBe('备用渠道/model-f');
    expect((await streamResult('connect-refused')).model).toBe('备用渠道/model-f');
  });

  it('连接超时:complete 与 streamChat 都切备用(连接预算 2s,主渠道 5s 才响应)', async () => {
    install('connect-timeout');
    expect((await new EnvChatModel('chat').complete(input)).model).toBe('备用渠道/model-f');
    expect((await streamResult('connect-timeout')).model).toBe('备用渠道/model-f');
  }, 30_000);

  it('非法 JSON 载荷:complete 与 streamChat 都切备用', async () => {
    install('json-garbage');
    expect((await new EnvChatModel('chat').complete(input)).model).toBe('备用渠道/model-f');
    expect((await streamResult('json-garbage')).model).toBe('备用渠道/model-f');
  }, 30_000);

  it('流读取中途卡死且零产出:streamChat 切备用(读取与 abort signal race 硬释放挂起)', async () => {
    const streamed = await streamResult('mid-stream-stall');
    expect(streamed.model).toBe('备用渠道/model-f');
    expect(streamed.text).toBe('FALLBACK-OK');
  }, 30_000);

  it('HTTP 401 鉴权错误:不切备用,直接报错(换渠道大概率同样失败)', async () => {
    install('http401');
    await expect(new EnvChatModel('chat').complete(input)).rejects.toThrow(/401/);
  });

  it('未绑定备用渠道的功能:主渠道失败直接报错,不重试', async () => {
    setChannelResolver(() => ({ primary, fallback: null, anyEnabled: true }));
    globalThis.fetch = (async () => new Response('boom', { status: 500 })) as typeof fetch;
    await expect(new EnvChatModel('narrative').complete(input)).rejects.toThrow(/500/);
  });
});
