import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { recognizeAttachment, type OcrConfig } from '../src/modules/expense/ocr-client';
import { boot, get, json, post, upload } from './t3-helpers';
import { fetchAs } from './http-helpers';

/** AC-F22/F23、AC-X06：真实 HTTP 协议桩，临时数据库，无真实供应商凭据。 */
const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

type Mode = 'ok' | 'auth_failed' | 'missing_token' | 'missing_id' | 'failed' | 'empty' | 'timeout' | 'invalid_json' | 'oversized' | 'redirect';
async function provider() {
  const calls: string[] = [];
  let mode: Mode = 'ok';
  let polls = 0;
  const server = http.createServer(async (req, res) => {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(Buffer.from(chunk));
    const raw = Buffer.concat(chunks);
    calls.push(req.url!);
    const reply = (body: unknown, status = 200) => res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
    if (req.url === '/api/auth/token') {
      expect(req.method).toBe('POST');
      expect(req.headers['content-type']).toContain('application/x-www-form-urlencoded');
      expect(new URLSearchParams(raw.toString()).get('username')).toBe('ocr-user');
      expect(new URLSearchParams(raw.toString()).get('password')).toBe('private-password');
      if (mode === 'redirect') return res.writeHead(302, { location: '/api/credential-leak' }).end();
      if (mode === 'auth_failed') return reply({ detail: 'private-password' }, 401);
      if (mode === 'missing_token') return reply({});
      return reply({ data: { token: 'private-token' } });
    }
    expect(req.headers.authorization).toBe('Bearer private-token');
    if (req.url === '/api/ocr/pdf') {
      expect(req.method).toBe('POST');
      const form = await new Response(raw, { headers: { 'content-type': req.headers['content-type']! } }).formData();
      expect(form.get('api_type')).toBe('1');
      const file = form.get('file') as File;
      expect(['票据.pdf', '票据.png']).toContain(file.name);
      expect(file.type).toBe(file.name.endsWith('.png') ? 'image/png' : 'application/pdf');
      expect(await file.text()).toBe('scan-content');
      return reply(mode === 'missing_id' ? {} : { data: { task_id: 'task/a' } });
    }
    if (req.url === '/api/status/task%2Fa') {
      polls += 1;
      if (mode === 'invalid_json') return res.end('not-json-private-token');
      if (mode === 'timeout') return reply({ status: 'processing' });
      if (mode === 'failed') return reply({ state: 'failed', error: 'private-token' });
      return reply({ state: polls === 1 && mode === 'ok' ? 'processing' : 'completed' });
    }
    if (req.url === '/api/download/task%2Fa?format=md') {
      return res.writeHead(200, { 'content-type': 'text/markdown' }).end(mode === 'empty' ? '  ' : mode === 'oversized' ? 'x'.repeat(1024 * 1024 + 1) : '# 住宿费发票\n交通行程单');
    }
    return reply({}, 404);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(async () => { server.closeAllConnections(); await new Promise<void>((resolve) => server.close(() => resolve())); });
  const config: OcrConfig = {
    provider: 'tangdalei_http', baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/`,
    apiKey: null, username: 'ocr-user', password: 'private-password', apiType: '1', timeoutSeconds: 5,
  };
  return { config, calls, setMode: (value: Mode) => { mode = value; polls = 0; } };
}
const file = { name: '票据.pdf', content: Buffer.from('scan-content') };

describe('原有 OCR 服务适配（AC-F22/F23）', () => {
  it('表单登录、multipart 上传、异步轮询和 Markdown 下载，保留 /api 前缀并编码任务 ID', async () => {
    const stub = await provider();
    expect(await recognizeAttachment(stub.config, file)).toEqual({ text: '# 住宿费发票\n交通行程单', pages: [] });
    expect(stub.calls).toEqual(['/api/auth/token', '/api/ocr/pdf', '/api/status/task%2Fa', '/api/status/task%2Fa', '/api/download/task%2Fa?format=md']);
  });

  it.each<Mode>(['auth_failed', 'missing_token', 'missing_id', 'failed', 'empty', 'invalid_json', 'oversized', 'redirect'])('%s 拒绝作为识别成功，错误不包含凭据或供应商原文', async (mode) => {
    const stub = await provider();
    stub.setMode(mode);
    const error = await recognizeAttachment(stub.config, file).then(() => null, (e: unknown) => e);
    expect(error).toBeInstanceOf(Error);
    expect(String(error)).not.toMatch(/private-password|private-token|not-json/);
    if (mode !== 'empty' && mode !== 'oversized') expect(stub.calls).not.toContain('/api/download/task%2Fa?format=md');
    if (mode === 'redirect') expect(stub.calls).toEqual(['/api/auth/token']);
  });

  it('整个流程共用总时限，轮询等待超时后不下载', async () => {
    const stub = await provider();
    stub.setMode('timeout');
    await expect(recognizeAttachment({ ...stub.config, timeoutSeconds: 0.1 }, file)).rejects.toMatchObject({ name: 'TimeoutError' });
    expect(stub.calls).not.toContain('/api/download/task%2Fa?format=md');
  });

  it('缺凭据在外呼前拒绝；图片保留原文件名和 MIME 类型上传', async () => {
    const stub = await provider();
    await expect(recognizeAttachment({ ...stub.config, password: null }, file)).rejects.toThrow('未配置');
    expect(stub.calls).toEqual([]);
    expect((await recognizeAttachment(stub.config, { ...file, name: '票据.png' })).text).toContain('住宿');
  });

  it('费用审核使用新设置、识别文字参与材料核对、复用缓存，供应商失败仍待人工复核', async () => {
    const stub = await provider();
    const { base, admin, db, fx } = await boot('newfc-ocr-adapter-');
    const settings = {
      'integration.ocr_provider': 'tangdalei_http', 'integration.ocr_base_url': stub.config.baseUrl,
      'integration.ocr_username': stub.config.username, 'integration.ocr_password': stub.config.password,
      'integration.ocr_api_type': '1', 'integration.ocr_timeout_seconds': 5,
    };
    const saved = await fetchAs(admin, `${base}/api/settings/business`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(settings) });
    expect(saved.status).toBe(200);
    const publicSettings = await json(saved);
    expect(JSON.stringify(publicSettings)).not.toContain('private-password');
    expect(publicSettings.items.find((s: { key: string }) => s.key === 'integration.ocr_password')).toMatchObject({ value: null, configured: true });
    expect(JSON.stringify(await json(get(base, admin, '/api/settings/business')))).not.toContain('private-password');
    expect(db.prepare("SELECT detail_json FROM operation_log WHERE action = 'settings.business.save'").get()).not.toMatchObject({ detail_json: expect.stringContaining('private-password') });
    for (const bad of [{ 'integration.ocr_timeout_seconds': 301 }, { 'integration.ocr_provider': 'unknown' },
      { 'integration.ocr_base_url': `${stub.config.baseUrl}?token=private-token`, 'report.company_name': '不应保存' },
      { 'integration.ocr_base_url': `${stub.config.baseUrl}#fragment` }]) {
      const res = await fetchAs(admin, `${base}/api/settings/business`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(bad) });
      expect(res.status).toBe(400);
    }
    const unchanged = await json(get(base, admin, '/api/settings/business'));
    expect(unchanged.items.find((s: { key: string }) => s.key === 'report.company_name').value).toBe('');
    expect(unchanged.items.find((s: { key: string }) => s.key === 'integration.ocr_base_url').value).toBe(stub.config.baseUrl);
    await post(base, admin, '/api/expense/policies', {
      code: 'OCR-POLICY', title: 'OCR 材料核对', effectiveFrom: '2026-01-01',
      clauses: [{ clauseNo: '1', clauseText: '差旅应附住宿和交通材料', expenseTypes: ['差旅费'], requiredKeywords: ['住宿', '交通'] }],
    });
    const makeClaim = async () => {
      const c = await json(post(base, admin, '/api/expense/claims', {
        orgId: fx.orgIds.shanghai, applicant: '测试人员', expenseType: '差旅费', amount: '100.00', occurredDate: '2026-05-10',
        lines: [{ expenseType: '差旅费', amount: '100.00' }],
      }));
      const res = await upload(base, admin, `/api/expense/claims/${c.id}/attachments`, file.content, file.name);
      expect(res.status).toBe(201);
      const latest = await json(get(base, admin, `/api/expense/claims/${c.id}`));
      expect((await post(base, admin, `/api/expense/claims/${c.id}/submit`, { expectedReviewVersion: latest.reviewVersion })).status).toBe(200);
      return c.id as number;
    };
    const waitRun = async (id: number, count: number) => {
      for (let i = 0; i < 100; i++) {
        const c = await json(get(base, admin, `/api/expense/claims/${id}`));
        if (c.runs.length >= count) return c;
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      throw new Error('审核未完成');
    };
    const id = await makeClaim();
    let claim = await waitRun(id, 1);
    expect(claim).toMatchObject({ status: 'audited', conclusion: null });
    expect(claim.runs[0].ocrStatus).toBe('ok');
    expect(claim.runs[0].findings.map((f: { code: string }) => f.code)).not.toContain('MATERIAL_MISSING');
    expect((await post(base, admin, `/api/expense/claims/${id}/audit`)).status).toBe(202);
    claim = await waitRun(id, 2);
    expect(claim.runs[0].ocrStatus).toBe('ok');
    expect(stub.calls.filter((p) => p === '/api/auth/token')).toHaveLength(1);
    // 仅清空本测试临时库的缓存，模拟未经识别的原件。
    db.prepare('DELETE FROM ex_ocr_cache').run();
    stub.setMode('failed');
    expect((await post(base, admin, `/api/expense/claims/${id}/audit`)).status).toBe(202);
    claim = await waitRun(id, 3);
    expect(claim).toMatchObject({ status: 'audited', conclusion: null });
    expect(claim.runs[0].ocrStatus).toBe('failed');
    expect(claim.runs[0].findings.map((f: { code: string }) => f.code)).toContain('OCR_FAILED');
    expect(db.prepare('SELECT COUNT(*) AS n FROM ex_ocr_cache').get()).toEqual({ n: 0 });
    expect(JSON.stringify(claim)).not.toMatch(/private-password|private-token/);
  });
});
