/** OCR 网络适配。调用在事务外；凭据与供应商响应不进入业务错误/日志。 */
import path from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';

export interface OcrText { text: string; pages: { page: number; text: string }[] }
export interface OcrConfig {
  provider: 'json_http' | 'tangdalei_http';
  baseUrl: string;
  apiKey: string | null;
  username: string | null;
  password: string | null;
  apiType: string;
  timeoutSeconds: number;
}

const MAX_OCR_CHARS = 200_000;
const MAX_RESPONSE_BYTES = 1024 * 1024;
const SUCCESS = new Set(['success', 'succeeded', 'done', 'completed', 'finish', 'finished']);
const FAILED = new Set(['failed', 'error', 'cancelled', 'canceled']);

function contentType(name: string): string {
  const ext = path.extname(name).toLowerCase();
  return ext === '.pdf' ? 'application/pdf' : ext === '.ofd' ? 'application/ofd' : `image/${ext === '.jpg' ? 'jpeg' : ext === '.tif' ? 'tiff' : ext.slice(1)}`;
}

async function responseText(res: Response, limit = MAX_RESPONSE_BYTES): Promise<string> {
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`OCR 服务返回 HTTP ${res.status}`);
  }
  if (!res.body) throw new Error('OCR 响应为空');
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.byteLength;
      if (size > limit) throw new Error('OCR 响应超过大小上限');
      chunks.push(value);
    }
  } catch (error) {
    await reader.cancel();
    throw error;
  } finally { reader.releaseLock(); }
  return Buffer.concat(chunks).toString('utf8');
}

async function responseJson(res: Response): Promise<Record<string, unknown>> {
  let value: unknown;
  try { value = JSON.parse(await responseText(res)); }
  catch (error) {
    if (error instanceof SyntaxError) throw new Error('OCR 响应不是有效 JSON');
    throw error;
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('OCR 响应格式不正确');
  return value as Record<string, unknown>;
}

/** 保留原 JSON 同步接口；tangdalei 模式直连账号登录、上传、轮询、Markdown 下载。 */
export async function recognizeAttachment(config: OcrConfig, file: { name: string; content: Buffer }): Promise<OcrText> {
  const signal = AbortSignal.timeout(config.provider === 'tangdalei_http' ? config.timeoutSeconds * 1000 : 30_000);
  const request = (url: string, init: RequestInit = {}) => fetch(url, { ...init, signal, redirect: 'error' });
  if (config.provider === 'json_http') {
    const body = await responseJson(await request(config.baseUrl, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...(config.apiKey ? { Authorization: `Bearer ${config.apiKey}` } : {}) },
      body: JSON.stringify({ fileName: file.name, contentType: contentType(file.name), contentBase64: file.content.toString('base64') }),
    }));
    const pages = Array.isArray(body.pages)
      ? body.pages.filter((p): p is { page: number; text: string } => !!p && typeof p === 'object' && Number.isSafeInteger(p.page) && p.page > 0 && typeof p.text === 'string')
      : [];
    const text = typeof body.text === 'string' ? body.text : pages.map((p) => p.text).join('\n');
    if (!text.trim()) throw new Error('OCR 响应缺少有效识别文字');
    return { text: text.slice(0, MAX_OCR_CHARS), pages: pages.map((p) => ({ page: p.page, text: p.text.slice(0, MAX_OCR_CHARS) })) };
  }
  if (config.provider !== 'tangdalei_http') throw new Error('OCR 接口类型不支持');
  if (!config.username || !config.password) throw new Error('OCR 账号或密码未配置');
  const base = new URL(config.baseUrl);
  if (base.search || base.hash) throw new Error('OCR 根地址不能带查询参数或片段');
  const endpoint = (suffix: string) => `${base.href.replace(/\/+$/, '')}/${suffix}`;
  const login = await responseJson(await request(endpoint('auth/token'), {
    method: 'POST', body: new URLSearchParams({ username: config.username, password: config.password }),
  }));
  const loginData = login.data && typeof login.data === 'object' ? login.data as Record<string, unknown> : {};
  const token = login.access_token ?? login.token ?? loginData.token;
  if (typeof token !== 'string' || !token.trim() || /[\r\n]/.test(token)) throw new Error('OCR 登录响应缺少有效 token');
  const headers = { Authorization: `Bearer ${token}` };
  const form = new FormData();
  form.append('api_type', config.apiType);
  form.append('file', new Blob([new Uint8Array(file.content)], { type: contentType(file.name) }), file.name);
  const upload = await responseJson(await request(endpoint('ocr/pdf'), { method: 'POST', headers, body: form }));
  const uploadData = upload.data && typeof upload.data === 'object' ? upload.data as Record<string, unknown> : {};
  const id = upload.task_id ?? upload.id ?? uploadData.task_id;
  if ((typeof id !== 'string' && !(typeof id === 'number' && Number.isSafeInteger(id))) || !String(id).trim()) throw new Error('OCR 上传响应缺少有效 task_id');
  const taskId = encodeURIComponent(String(id));
  for (;;) {
    signal.throwIfAborted();
    const body = await responseJson(await request(endpoint(`status/${taskId}`), { headers }));
    const status = typeof (body.status ?? body.state) === 'string' ? String(body.status ?? body.state).toLowerCase() : '';
    if (SUCCESS.has(status)) break;
    if (FAILED.has(status)) throw new Error('OCR 任务识别失败');
    if (!status) throw new Error('OCR 状态响应缺少 status/state');
    try { await delay(1000, undefined, { signal }); }
    catch (error) { signal.throwIfAborted(); throw error; }
  }
  const markdown = await responseText(await request(endpoint(`download/${taskId}?format=md`), { headers }));
  if (!markdown.trim()) throw new Error('OCR 未返回有效识别文字');
  return { text: markdown.slice(0, MAX_OCR_CHARS), pages: [] };
}
