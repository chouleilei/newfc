import http from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterEach, describe, expect, it } from 'vitest';
import { boot, get, post, upload, type Session } from './t3-helpers';
import { createScopedUser, fetchAs } from './http-helpers';

/**
 * AC-F22 费用审核:制度条款驱动的规则(上限/材料/依据缺失)、OCR 与模型未配置时明确记录并待复核、
 * OCR 文本参与材料核对并按 sha256 缓存、模型输出白名单校验、人工复核处置规则、复核不可改、复核分离、越权 404。
 */

const envKeys = ['AI_BASE_URL', 'AI_API_KEY', 'AI_MODEL'] as const;
const savedEnv = Object.fromEntries(envKeys.map((k) => [k, process.env[k]]));
afterEach(() => { for (const k of envKeys) { if (savedEnv[k] === undefined) delete process.env[k]; else process.env[k] = savedEnv[k]; } });

async function ok(res: Response | Promise<Response>, status = 200) {
  const r = await res;
  const body = await r.json();
  expect(r.status, JSON.stringify(body)).toBe(status);
  return body;
}
async function fail(res: Response | Promise<Response>, status: number, code: string) {
  const r = await res;
  const body = await r.json();
  expect([r.status, body.code], JSON.stringify(body)).toEqual([status, code]);
  return body;
}
const put = (base: string, s: Session, url: string, body: unknown) =>
  fetchAs(s, `${base}${url}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

/** 等审核运行写入(后台任务)。 */
async function waitRuns(base: string, s: Session, claimId: number, n: number) {
  for (let i = 0; i < 100; i += 1) {
    const c = await ok(get(base, s, `/api/expense/claims/${claimId}`));
    if (c.runs.length >= n && c.status !== 'submitted') return c;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`报销单 ${claimId} 未在期限内产生第 ${n} 次审核运行`);
}

const TRAVEL_POLICY = {
  code: 'FIN-TRAVEL', title: '差旅费管理办法', effectiveFrom: '2026-01-01',
  clauses: [
    { clauseNo: '3.1', clauseText: '差旅费单次报销不超过 5,000 元,超出须说明原因并经分管领导批准。', expenseTypes: ['差旅费'], limit: '5000.00', requiredKeywords: ['住宿', '交通'] },
    { clauseNo: '3.2', clauseText: '差旅报销须附出差审批单。', expenseTypes: ['差旅费'], limit: null, requiredKeywords: [] },
  ],
};

async function setup() {
  const t = await boot('newfc-t4-ex-');
  const maker = createScopedUser(t.db, { username: 'ex-maker', roleCodes: ['data_maintainer'], orgIds: [t.fx.orgIds.east] });
  const reviewer = createScopedUser(t.db, { username: 'ex-reviewer', roleCodes: ['business_reviewer'], orgIds: [t.fx.orgIds.east] });
  const outsider = createScopedUser(t.db, { username: 'ex-outsider', roleCodes: ['data_maintainer', 'business_reviewer'], orgIds: [t.fx.orgIds.west] });
  const policy = await ok(post(t.base, t.admin, '/api/expense/policies', TRAVEL_POLICY), 201);
  return { ...t, maker: maker.session, reviewer: reviewer.session, outsider: outsider.session, policy };
}

const travelClaim = (orgId: number, extra: Record<string, unknown> = {}) => ({
  orgId, applicant: '张三', department: '工程部', expenseType: '差旅费', amount: '6000.00', occurredDate: '2026-05-10', description: '北京水利部汇报出差',
  lines: [
    { expenseType: '差旅费', amount: '2000.00', invoiceNo: 'INV-001', invoiceDate: '2026-05-10', description: '往返机票' },
    { expenseType: '差旅费', amount: '4000.00', invoiceNo: 'INV-002', invoiceDate: '2026-05-12', description: '酒店' },
  ],
  ...extra,
});
const codes = (run: { findings: { code: string }[] }) => run.findings.map((f) => f.code).sort();

describe('T-4 费用审核(AC-F22)', () => {
  it('差旅样本:6,000 超 5,000 上限带条款引用、缺住宿材料、OCR/模型未配置待复核;处置不全/高风险无例外被拒;补件重审;复核不可改', async () => {
    const { base, db, fx, maker, reviewer, policy } = await setup();
    expect(policy).toMatchObject({ code: 'FIN-TRAVEL', version: 1, status: 'active' });
    const clause31 = policy.clauses.find((c: { clauseNo: string }) => c.clauseNo === '3.1');
    expect(clause31).toMatchObject({ limit: '5000.00', expenseTypes: ['差旅费'], requiredKeywords: ['住宿', '交通'] });
    // 制度是集团口径:受限复核人维护返回 SCOPE_RESTRICTED;条款不可改
    await fail(post(base, reviewer, '/api/expense/policies', TRAVEL_POLICY), 403, 'SCOPE_RESTRICTED');
    expect(() => db.prepare('UPDATE ex_policy_clause SET limit_cents = 1 WHERE id = ?').run(clause31.id)).toThrow(/不可修改/);

    let claim = await ok(post(base, maker, '/api/expense/claims', travelClaim(fx.orgIds.shanghai)), 201);
    expect(claim).toMatchObject({ status: 'draft', amount: '6000.00', reviewVersion: 1, submitRound: 0 });
    expect(claim.claimNo).toMatch(/^BX\d{8}-0001$/);
    await ok(upload(base, maker, `/api/expense/claims/${claim.id}/attachments`, Buffer.from('交通票据-扫描件'), '交通票据.jpg', { kindHint: '交通' }), 201);
    await fail(post(base, maker, `/api/expense/claims/${claim.id}/submit`, { expectedReviewVersion: 1 }), 409, 'VERSION_CONFLICT');
    claim = await ok(get(base, maker, `/api/expense/claims/${claim.id}`));
    const submitted = await ok(post(base, maker, `/api/expense/claims/${claim.id}/submit`, { expectedReviewVersion: claim.reviewVersion }));
    expect(submitted.jobId).toBeGreaterThan(0);
    expect(submitted.claim.contentSha256).toMatch(/^[0-9a-f]{64}$/);

    claim = await waitRuns(base, maker, claim.id, 1);
    // AI/规则不自动通过:只进入待复核
    expect(claim).toMatchObject({ status: 'audited', conclusion: null, latestRiskLevel: 'high' });
    const run1 = claim.runs[0];
    expect(run1).toMatchObject({ riskLevel: 'high', ocrStatus: 'unavailable', modelStatus: 'unavailable', policyRefs: [{ code: 'FIN-TRAVEL', version: 1 }] });
    expect(claim.currentRunId).toBe(run1.id);
    expect(codes(run1)).toEqual(['LIMIT_EXCEEDED', 'MATERIAL_MISSING', 'MODEL_UNAVAILABLE', 'OCR_UNAVAILABLE']);
    const limit = run1.findings.find((f: { code: string }) => f.code === 'LIMIT_EXCEEDED');
    expect(limit).toMatchObject({ source: 'rule', severity: 'high', clauseId: clause31.id, clauseLabel: 'FIN-TRAVEL v1 第 3.1 条' });
    expect(limit.message).toContain('6,000.00');
    expect(limit.message).toContain('5,000.00');
    expect(limit.evidence.map((e: { kind: string; ref: string }) => `${e.kind}:${e.ref}`)).toEqual(['line:1', 'line:2', `clause:${clause31.id}`]);
    const material = run1.findings.find((f: { code: string }) => f.code === 'MATERIAL_MISSING');
    expect(material).toMatchObject({ severity: 'medium', clauseId: clause31.id });
    expect(material.message).toContain('住宿');
    expect(run1.findings.find((f: { code: string }) => f.code === 'OCR_UNAVAILABLE')).toMatchObject({ source: 'ocr', severity: 'low' });
    expect(run1.findings.find((f: { code: string }) => f.code === 'MODEL_UNAVAILABLE')).toMatchObject({ source: 'model', severity: 'info' });

    // 提交后内容冻结
    await fail(put(base, maker, `/api/expense/claims/${claim.id}`, { expectedReviewVersion: claim.reviewVersion, ...travelClaim(fx.orgIds.shanghai) }), 409, 'CLAIM_STATE');
    await fail(upload(base, maker, `/api/expense/claims/${claim.id}/attachments`, Buffer.from('x'), '补充.pdf'), 409, 'CLAIM_STATE');
    // 提交人没有复核权限
    await fail(post(base, maker, `/api/expense/claims/${claim.id}/review`, { expectedReviewVersion: claim.reviewVersion, runId: run1.id, conclusion: 'pass' }), 403, 'FORBIDDEN');

    const all = (d: string) => run1.findings.map((f: { id: number }) => ({ findingId: f.id, disposition: d }));
    const review = (body: Record<string, unknown>) => post(base, reviewer, `/api/expense/claims/${claim.id}/review`, { expectedReviewVersion: claim.reviewVersion, runId: run1.id, ...body });
    const incomplete = await fail(review({ conclusion: 'pass', dispositions: all('dismissed').slice(0, 2) }), 422, 'EXPENSE_REVIEW_INCOMPLETE');
    expect(incomplete.details.undisposedFindingIds).toHaveLength(2);
    await fail(review({ conclusion: 'pass', dispositions: all('dismissed') }), 422, 'EXPENSE_EXCEPTION_REQUIRED');
    await fail(review({ conclusion: 'supplement_required', dispositions: all('confirmed') }), 422, 'EXPENSE_REVIEW_INCOMPLETE');
    await fail(review({ conclusion: 'pass', dispositions: all('dismissed'), exceptionReason: 'x', runId: run1.id + 99 }), 409, 'EXPENSE_RUN_STALE');
    await fail(review({ conclusion: 'reject', dispositions: all('dismissed'), expectedReviewVersion: claim.reviewVersion - 1 }), 409, 'VERSION_CONFLICT');
    const supplementDispositions = run1.findings.map((f: { id: number; code: string }) => ({ findingId: f.id, disposition: f.code === 'MATERIAL_MISSING' ? 'missing_material' : 'confirmed' }));
    claim = await ok(review({ conclusion: 'supplement_required', dispositions: supplementDispositions, comment: '请补住宿发票' }));
    expect(claim).toMatchObject({ status: 'supplement', conclusion: null });
    expect(claim.reviews[0]).toMatchObject({ conclusion: 'supplement_required', runId: run1.id, selfReview: false, reviewerName: 'ex-reviewer' });

    // 补件:须追加附件后才能重新提交;原附件不可移除
    await fail(post(base, maker, `/api/expense/claims/${claim.id}/submit`, { expectedReviewVersion: claim.reviewVersion }), 400, 'VALIDATION_FAILED');
    await fail(fetchAs(maker, `${base}/api/expense/claims/${claim.id}/attachments/${claim.attachments[0].id}`, { method: 'DELETE' }), 409, 'CLAIM_STATE');
    const hotel = await ok(upload(base, maker, `/api/expense/claims/${claim.id}/attachments`, Buffer.from('住宿发票-扫描件'), '住宿发票.pdf'), 201);
    expect(hotel.submitRound).toBe(2);
    claim = await ok(get(base, maker, `/api/expense/claims/${claim.id}`));
    await ok(post(base, maker, `/api/expense/claims/${claim.id}/submit`, { expectedReviewVersion: claim.reviewVersion }));
    claim = await waitRuns(base, reviewer, claim.id, 2);
    const run2 = claim.runs[0];
    expect(claim.submitRound).toBe(2);
    expect(run2.contentSha256).not.toBe(run1.contentSha256);
    expect(codes(run2)).toEqual(['LIMIT_EXCEEDED', 'MODEL_UNAVAILABLE', 'OCR_UNAVAILABLE']);

    const finalDispositions = run2.findings.map((f: { id: number }) => ({ findingId: f.id, disposition: 'dismissed', note: '已核实' }));
    await fail(post(base, reviewer, `/api/expense/claims/${claim.id}/review`, { expectedReviewVersion: claim.reviewVersion, runId: run2.id, conclusion: 'pass', dispositions: finalDispositions.map((d: object, i: number) => (i === 0 ? { ...d, disposition: 'missing_material' } : d)), exceptionReason: '领导批准' }), 400, 'VALIDATION_FAILED');
    claim = await ok(post(base, reviewer, `/api/expense/claims/${claim.id}/review`, {
      expectedReviewVersion: claim.reviewVersion, runId: run2.id, conclusion: 'pass', dispositions: finalDispositions, exceptionReason: '分管领导已书面批准超标准住宿',
    }));
    expect(claim).toMatchObject({ status: 'reviewed', conclusion: 'pass' });
    expect(claim.reviews).toHaveLength(2);
    expect(claim.reviews[0]).toMatchObject({ conclusion: 'pass', exceptionReason: '分管领导已书面批准超标准住宿' });

    // 结论不可变:再次复核被拒;复核/运行/发现记录库层不可改删
    await fail(post(base, reviewer, `/api/expense/claims/${claim.id}/review`, { expectedReviewVersion: claim.reviewVersion, runId: run2.id, conclusion: 'reject', dispositions: finalDispositions }), 409, 'CLAIM_STATE');
    expect(() => db.prepare("UPDATE ex_review SET conclusion = 'reject' WHERE claim_id = ?").run(claim.id)).toThrow(/不可修改/);
    expect(() => db.prepare('DELETE FROM ex_finding WHERE run_id = ?').run(run2.id)).toThrow(/只追加/);
    expect(() => db.prepare("UPDATE ex_audit_run SET risk_level = 'low' WHERE id = ?").run(run2.id)).toThrow(/只追加/);
    const actions = (db.prepare("SELECT action FROM operation_log WHERE entity_type = 'ex_claim' AND entity_id = ? ORDER BY id").all(String(claim.id)) as { action: string }[]).map((r) => r.action);
    expect(actions).toEqual([
      'expense.claim.create', 'expense.claim.attachment', 'expense.claim.submit', 'expense.claim.audit', 'expense.claim.review',
      'expense.claim.attachment', 'expense.claim.submit', 'expense.claim.audit', 'expense.claim.review',
    ]);
  });

  it('OCR 与模型已配置:OCR 文本参与材料核对并按 sha256 缓存;模型建议白名单校验;OCR 失败与非法输出明确记录', async () => {
    const { base, db, admin, fx, maker, reviewer, policy } = await setup();
    let ocrCalls = 0;
    let ocrMode: 'ok' | 'fail' = 'ok';
    let modelReply: string = '';
    const stub = http.createServer((req, res) => {
      let raw = '';
      req.on('data', (c) => { raw += c; });
      req.on('end', () => {
        if (req.url === '/ocr') {
          ocrCalls += 1;
          const body = JSON.parse(raw) as { fileName: string; contentType: string; contentBase64: string };
          expect(req.headers.authorization).toBe('Bearer ocr-secret');
          if (ocrMode === 'fail') { res.writeHead(500).end('{}'); return; }
          res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({
            pages: [{ page: 1, text: `${body.fileName}:住宿费增值税发票` }, { page: 2, text: '交通费行程单' }],
          }));
          return;
        }
        res.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ message: { content: modelReply } }] }));
      });
    });
    await new Promise<void>((r) => stub.listen(0, '127.0.0.1', () => r()));
    const port = (stub.address() as AddressInfo).port;
    try {
      await ok(put(base, admin, '/api/settings/business', { 'integration.ocr_base_url': `http://127.0.0.1:${port}/ocr`, 'integration.ocr_api_key': 'ocr-secret' }));
      process.env.AI_BASE_URL = `http://127.0.0.1:${port}/v1`;
      process.env.AI_API_KEY = 'test';
      const clause31 = policy.clauses[0].id;
      const claim0 = await ok(post(base, maker, '/api/expense/claims', travelClaim(fx.orgIds.shanghai, { amount: '4500.00', lines: [{ expenseType: '差旅费', amount: '4500.00', invoiceNo: 'INV-9', invoiceDate: '2026-05-10' }] })), 201);
      const att = await ok(upload(base, maker, `/api/expense/claims/${claim0.id}/attachments`, Buffer.from('scan-1'), '票据扫描.jpg'), 201);
      modelReply = '```json\n' + JSON.stringify({ findings: [
        { severity: 'medium', message: '事由为汇报出差,但明细只有一张发票,建议核对往返行程', evidence: ['field:description', 'line:1', `attachment:${att.id}`], clauseId: clause31 },
        { severity: 'high', message: '编造明细', evidence: ['line:99'], clauseId: null },
        { severity: 'low', message: '编造条款', evidence: ['field:amount'], clauseId: 999999 },
        { severity: 'pass', message: '直接通过', evidence: ['field:amount'] },
      ] }) + '\n```';
      let claim = await ok(get(base, maker, `/api/expense/claims/${claim0.id}`));
      await ok(post(base, maker, `/api/expense/claims/${claim.id}/submit`, { expectedReviewVersion: claim.reviewVersion }));
      claim = await waitRuns(base, maker, claim.id, 1);
      let run = claim.runs[0];
      expect(run).toMatchObject({ ocrStatus: 'ok', modelStatus: 'ok', riskLevel: 'medium' });
      // 附件名不含“住宿/交通”,OCR 文本命中,因此没有材料缺失
      expect(codes(run)).toEqual(['MODEL_OUTPUT_INVALID', 'MODEL_SUGGESTION']);
      const suggestion = run.findings.find((f: { code: string }) => f.code === 'MODEL_SUGGESTION');
      expect(suggestion).toMatchObject({ source: 'model', severity: 'medium', clauseId: clause31 });
      expect(suggestion.evidence.map((e: { kind: string; ref: string }) => `${e.kind}:${e.ref}`)).toEqual(['field:description', 'line:1', `attachment:${att.id}`]);
      expect(run.findings.find((f: { code: string }) => f.code === 'MODEL_OUTPUT_INVALID').message).toContain('3 条');
      expect(ocrCalls).toBe(1);
      expect(db.prepare('SELECT COUNT(*) AS n FROM ex_ocr_cache WHERE sha256 = ?').get(att.sha256)).toEqual({ n: 1 });
      expect((db.prepare('SELECT COUNT(*) AS n FROM ai_model_call WHERE feature = ?').get('expense_audit') as { n: number }).n).toBeGreaterThanOrEqual(1);

      // 复核人重跑:OCR 走缓存;模型输出非法 JSON → MODEL_OUTPUT_INVALID,运行状态 invalid
      modelReply = '我认为可以直接通过';
      const rerun = await ok(post(base, reviewer, `/api/expense/claims/${claim.id}/audit`), 202);
      expect(rerun.jobId).toBeGreaterThan(0);
      claim = await waitRuns(base, maker, claim.id, 2);
      run = claim.runs[0];
      expect(run).toMatchObject({ ocrStatus: 'ok', modelStatus: 'invalid', riskLevel: 'low' });
      expect(codes(run)).toEqual(['MODEL_OUTPUT_INVALID']);
      expect(ocrCalls).toBe(1);
      expect(claim.currentRunId).toBe(run.id);
      // 复核须基于最新运行
      await fail(post(base, reviewer, `/api/expense/claims/${claim.id}/review`, { expectedReviewVersion: claim.reviewVersion, runId: claim.runs[1].id, conclusion: 'reject', dispositions: [] }), 409, 'EXPENSE_RUN_STALE');

      // OCR 服务失败:OCR_FAILED,不当作通过;材料核对只剩附件名 → 缺住宿/交通
      ocrMode = 'fail';
      modelReply = JSON.stringify({ findings: [] });
      const c2 = await ok(post(base, maker, '/api/expense/claims', travelClaim(fx.orgIds.shanghai, { amount: '100.00', lines: [{ expenseType: '差旅费', amount: '100.00', invoiceNo: 'INV-10', invoiceDate: '2026-05-10' }] })), 201);
      await ok(upload(base, maker, `/api/expense/claims/${c2.id}/attachments`, Buffer.from('scan-2'), '扫描件2.png'), 201);
      const c2d = await ok(get(base, maker, `/api/expense/claims/${c2.id}`));
      await ok(post(base, maker, `/api/expense/claims/${c2.id}/submit`, { expectedReviewVersion: c2d.reviewVersion }));
      const c2r = await waitRuns(base, maker, c2.id, 1);
      expect(c2r.runs[0]).toMatchObject({ ocrStatus: 'failed', modelStatus: 'ok', riskLevel: 'medium' });
      expect(codes(c2r.runs[0])).toEqual(['MATERIAL_MISSING', 'MATERIAL_MISSING', 'OCR_FAILED']);
      expect(c2r.status).toBe('audited');
    } finally {
      await new Promise<void>((r) => stub.close(() => r()));
    }
  });

  it('规则覆盖依据缺失/合计不符/重复发票/发票早于发生月/发生晚于提交;越权 404;复核分离', async () => {
    const { base, db, admin, fx, maker, reviewer, outsider } = await setup();
    const future = new Date(Date.now() + 40 * 86400_000).toISOString().slice(0, 10);
    const body = {
      orgId: fx.orgIds.shanghai, applicant: '李四', expenseType: '业务招待费', amount: '900.00', occurredDate: future, description: '',
      lines: [
        { expenseType: '业务招待费', amount: '300.00', invoiceNo: 'A-1', invoiceDate: '2020-01-01' },
        { expenseType: '业务招待费', amount: '300.00', invoiceNo: 'a-1 ', invoiceDate: future },
        { expenseType: '业务招待费', amount: '200.00', invoiceNo: '' },
      ],
    };
    let claim = await ok(post(base, maker, '/api/expense/claims', { claimNo: 'BX-TEST-1', ...body }), 201);
    await fail(post(base, maker, '/api/expense/claims', { claimNo: 'BX-TEST-1', ...body }), 409, 'CLAIM_NO_DUPLICATE');
    await ok(upload(base, maker, `/api/expense/claims/${claim.id}/attachments`, Buffer.from('same'), '招待清单.xlsx'), 201);
    const dup = await ok(upload(base, maker, `/api/expense/claims/${claim.id}/attachments`, Buffer.from('same'), '招待清单-副本.xlsx'), 201);
    // 草稿阶段可移除本轮附件,再加回
    await ok(fetchAs(maker, `${base}/api/expense/claims/${claim.id}/attachments/${dup.id}`, { method: 'DELETE' }));
    await ok(upload(base, maker, `/api/expense/claims/${claim.id}/attachments`, Buffer.from('same'), '招待清单-副本.xlsx'), 201);

    // 越权:范围外用户看不到、改不了、审不了;不能在范围外组织建单
    await fail(get(base, outsider, `/api/expense/claims/${claim.id}`), 404, 'NOT_FOUND');
    await fail(upload(base, outsider, `/api/expense/claims/${claim.id}/attachments`, Buffer.from('x'), 'x.pdf'), 404, 'NOT_FOUND');
    await fail(post(base, outsider, `/api/expense/claims/${claim.id}/submit`, { expectedReviewVersion: 1 }), 404, 'NOT_FOUND');
    await fail(post(base, outsider, '/api/expense/claims', { ...body }), 404, 'NOT_FOUND');
    expect(await ok(get(base, outsider, '/api/expense/claims'))).toEqual([]);

    claim = await ok(get(base, maker, `/api/expense/claims/${claim.id}`));
    await ok(post(base, maker, `/api/expense/claims/${claim.id}/submit`, { expectedReviewVersion: claim.reviewVersion }));
    claim = await waitRuns(base, maker, claim.id, 1);
    const run = claim.runs[0];
    expect(run).toMatchObject({ riskLevel: 'high', ocrStatus: 'not_needed', modelStatus: 'unavailable', policyRefs: [] });
    expect(codes(run)).toEqual([
      'DESCRIPTION_MISSING', 'DUPLICATE_ATTACHMENT', 'DUPLICATE_INVOICE', 'INVOICE_BEFORE_OCCURRED_MONTH', 'INVOICE_NO_MISSING', 'LINE_TOTAL_MISMATCH',
      'MODEL_UNAVAILABLE', 'OCCURRED_AFTER_SUBMIT', 'POLICY_BASIS_MISSING',
    ]);
    expect(run.findings.find((f: { code: string }) => f.code === 'LINE_TOTAL_MISMATCH').message).toBe('明细合计 800.00 与报销金额 900.00 不一致');

    await fail(get(base, outsider, `/api/expense/claims/${claim.id}`), 404, 'NOT_FOUND');
    await fail(post(base, outsider, `/api/expense/claims/${claim.id}/review`, { expectedReviewVersion: claim.reviewVersion, runId: run.id, conclusion: 'reject' }), 404, 'NOT_FOUND');
    await fail(post(base, outsider, `/api/expense/claims/${claim.id}/audit`), 404, 'NOT_FOUND');
    const outsiderQueue = await ok(get(base, outsider, '/api/expense/queue'));
    expect(outsiderQueue.counts.audited).toBe(0);
    const queue = await ok(get(base, reviewer, '/api/expense/queue'));
    expect(queue.counts.audited).toBe(1);
    expect(queue.awaitingReview[0]).toMatchObject({ claimNo: 'BX-TEST-1', amount: '900.00', riskLevel: 'high' });

    // 复核分离:同时持有提交与复核权限的非管理员不能复核自己提交的单;管理员同人复核须填例外原因
    const both = createScopedUser(db, { username: 'ex-both', roleCodes: ['data_maintainer', 'business_reviewer'], orgIds: [fx.orgIds.east] }).session;
    const own = await ok(post(base, both, '/api/expense/claims', travelClaim(fx.orgIds.shanghai, { amount: '100.00', lines: [{ expenseType: '差旅费', amount: '100.00', invoiceNo: 'Z-1', invoiceDate: '2026-05-10' }] })), 201);
    await ok(post(base, both, `/api/expense/claims/${own.id}/submit`, { expectedReviewVersion: own.reviewVersion }));
    const ownRun = await waitRuns(base, both, own.id, 1);
    const ownDispositions = ownRun.runs[0].findings.map((f: { id: number }) => ({ findingId: f.id, disposition: 'confirmed' }));
    await fail(post(base, both, `/api/expense/claims/${own.id}/review`, { expectedReviewVersion: ownRun.reviewVersion, runId: ownRun.runs[0].id, conclusion: 'reject', dispositions: ownDispositions }), 403, 'SELF_REVIEW_FORBIDDEN');

    const adminClaim = await ok(post(base, admin, '/api/expense/claims', travelClaim(fx.orgIds.west, { amount: '100.00', lines: [{ expenseType: '差旅费', amount: '100.00', invoiceNo: 'Z-2', invoiceDate: '2026-05-10' }] })), 201);
    await ok(post(base, admin, `/api/expense/claims/${adminClaim.id}/submit`, { expectedReviewVersion: adminClaim.reviewVersion }));
    const adminRun = await waitRuns(base, admin, adminClaim.id, 1);
    const adminDispositions = adminRun.runs[0].findings.map((f: { id: number }) => ({ findingId: f.id, disposition: 'confirmed' }));
    const adminReview = { expectedReviewVersion: adminRun.reviewVersion, runId: adminRun.runs[0].id, conclusion: 'reject', dispositions: adminDispositions };
    await fail(post(base, admin, `/api/expense/claims/${adminClaim.id}/review`, adminReview), 400, 'VALIDATION_FAILED');
    const done = await ok(post(base, admin, `/api/expense/claims/${adminClaim.id}/review`, { ...adminReview, exceptionReason: '单人部署,无其他复核人' }));
    expect(done).toMatchObject({ status: 'reviewed', conclusion: 'reject' });
    expect(done.reviews[0]).toMatchObject({ selfReview: true, exceptionReason: '单人部署,无其他复核人' });
  });
});
