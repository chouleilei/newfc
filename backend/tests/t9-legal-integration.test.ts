import { SIGNATORIES, PAYMENT_APPROVAL, CHANGE_GOVERNANCE, seedNetAssets } from './contract-review-fixtures';
import { afterEach, describe, expect, it } from 'vitest';
import { createServer, type Server } from 'node:http';
import { boot, get, post, upload, json } from './t3-helpers';
import { createScopedUser, fetchAs, ensureAdmin } from './http-helpers';
import { createProject, createSupplier } from './t4-helpers';
import seed from '../../deploy/contract-legal-seed-v1.json';
import { importLegalSeed } from '../src/modules/contracts/legal-catalog.service';
import { GOOD_TEXT, docx } from './t9-legal-fixture';
import { executeTool } from '../src/assistant/tools';
import { runWithContext } from '../src/core/request-context';
import { loadAuthContext } from '../src/modules/security/security.service';
import { listLegalReviews } from '../src/modules/contracts/legal-review-run';
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))),
  );
});
async function ok(res: Response | Promise<Response>, status = 200) {
  const r = await res,
    b = (await r.json()) as any;
  expect(r.status, JSON.stringify(b)).toBe(status);
  return b;
}
async function setup(legalCategory = 'goods_procurement') {
  const t = await boot('newfc-t9-http-');
    seedNetAssets(t.db);
  importLegalSeed(t.db, seed);
  const maker = createScopedUser(t.db, {
    username: 'clr-maker',
    roleCodes: ['data_maintainer'],
    orgIds: [t.fx.orgIds.east],
  });
  const reviewer = createScopedUser(t.db, {
    username: 'clr-reviewer',
    roleCodes: ['business_reviewer'],
    orgIds: [t.fx.orgIds.east],
  });
  const other = createScopedUser(t.db, {
    username: 'clr-west',
    roleCodes: ['business_reviewer'],
    orgIds: [t.fx.orgIds.west],
  });
  const projectId = await createProject(
    t.base,
    t.admin,
    'CLR-P',
    '测试法审项目',
    t.fx.orgIds.shanghai,
  );
  const supplierId = await createSupplier(
    t.base,
    t.admin,
    'CLR-S',
    '测试供货公司',
  );
  const template = await ok(
    post(t.base, t.admin, '/api/contracts/legal-catalog/templates', {
      code: 'TPL-GOODS-2026',
      version: 2,
      name: '已核定测试范本',
      legalCategory: 'goods_procurement',
      notes: '仅用于合成测试',
      approvalStatus: 'candidate',
      clauses: [
        {
          clauseKey: 'no_subcontract',
          clauseNo: '第五条',
          title: '禁止违法分包',
          tier: 'fixed',
          standardText: '不得将主体义务转包或违法分包。',
        },
      ],
    }),
    201,
  );
  let modelGate: Promise<void> | null = null;
  let releaseModel: () => void = () => {};
  const pauseModel = () => {
    modelGate = new Promise<void>((r) => {
      releaseModel = () => {
        modelGate = null;
        r();
      };
    });
  };
  const model = createServer((req, res) => {
    let b = '';
    req.on('data', (c) => (b += c));
    req.on('end', async () => {
      if (modelGate) await modelGate;
      res.setHeader('Content-Type', 'application/json');
      res.end(
        JSON.stringify({
          choices: [{ message: { content: '{"findings":[]}' } }],
        }),
      );
    });
  }).listen(0);
  servers.push(model);
  const modelUrl = `http://127.0.0.1:${(model.address() as any).port}/v1`;
  await ok(
    post(t.base, t.admin, '/api/settings/ai-channels', {
      name: '法审受控模型',
      provider: 'openai',
      baseUrl: modelUrl,
      apiKey: 'test-clr-model-key',
      model: 'mock-contract',
      isDefault: true,
      enabled: true,
    }),
    201,
  );
  let c = await ok(
    post(t.base, maker.session, '/api/contracts', { ...SIGNATORIES,
      contractNo: 'LS-SG-001/2026-001',
      name: '设备物资采购合同',
      contractType: '物资采购',
      orgId: t.fx.orgIds.shanghai,
      projectId,
      supplierId,
      ...SIGNATORIES, originalAmount: '100000.00',
      legalCategory,
      partyRole: 'buyer',
      isProcurement: true,
      procurementTarget: 'goods',
      procurementMethod: 'inquiry',
    }),
    201,
  );
  const doc = async (
    type: string,
    text: Buffer,
    name: string,
    evidenceKind?: string,
  ) =>
    ok(
      upload(
        t.base,
        maker.session,
        `/api/contracts/${c.id}/documents`,
        text,
        name,
        { docType: type, ...(evidenceKind ? { evidenceKind } : {}) },
      ),
      201,
    );
  await doc(
    'procurement',
    Buffer.from('approval'),
    '定标审批.pdf',
    'bid_award_approval',
  );
  for (const stage of ['procurement', 'drafting']) {
    c = await ok(get(t.base, maker.session, `/api/contracts/${c.id}`));
    c = await ok(
      post(t.base, maker.session, `/api/contracts/${c.id}/advance`, {
        expectedVersion: c.version,
        toStage: stage,
      }),
    );
  }
  const text = await doc('contract_text', await docx(), '正文.docx');
  const reviews = () =>
    ok(get(t.base, reviewer.session, `/api/contracts/${c.id}/legal-reviews`));
  const run = async () => {
    await ok(
      post(t.base, maker.session, `/api/contracts/${c.id}/legal-reviews/run`),
      202,
    );
    let result;
    for (let i = 0; i < 300; i++) {
      result = await reviews();
      if (!result.activeJob) break;
      await new Promise((r) => setTimeout(r, 20));
    }
    return result;
  };
  return {
    ...t,
    maker,
    reviewer,
    other,
    template,
    c,
    text,
    doc,
    reviews,
    run,
    pauseModel,
    releaseModel: () => releaseModel(),
  };
}
describe('T-9 合同智能法审闭环', () => {
  it('签约前批准后补录日期不重审，最终日期顺序仍阻断正式确认与履约推进', async () => {
    const t = await setup();
    await ok(post(t.base, t.admin, `/api/contracts/legal-catalog/templates/${t.template.id}/promote`, { reason: '测试核定' }));
    const first = (await t.run()).runs[0];
    expect(first.verdict).toBe('pass');
    let c = await ok(get(t.base, t.maker.session, `/api/contracts/${t.c.id}`));
    c = await ok(post(t.base, t.maker.session, `/api/contracts/${c.id}/advance`, { expectedVersion: c.version, toStage: 'approval' }));
    c = await ok(post(t.base, t.maker.session, `/api/contracts/${c.id}/reviews`, { documentId: t.text.id }), 201);
    const patch = async (fields: object) => c = await ok(fetchAs(t.maker.session, `${t.base}/api/contracts/${c.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ expectedVersion: c.version, ...fields }),
    }));
    await patch({ signDate: '2026-12-03' });
    expect((await t.reviews()).runs[0].isCurrent).toBe(true);
    expect((await json(post(t.base, t.reviewer.session, `/api/contracts/${c.id}/reviews/${c.reviews[0].id}/decide`, { decision: 'approve' }))).code).toBe('LEGAL_REVIEW_BLOCKED');
    await patch({ signDate: null });
    c = await ok(post(t.base, t.reviewer.session, `/api/contracts/${c.id}/reviews/${c.reviews[0].id}/decide`, { decision: 'approve' }));
    expect(c.blockers.map((b: any) => b.code)).toEqual(['SIGN_DATE', 'SIGNED_DOC']);
    await t.doc('signed', Buffer.from('signed'), '签署件.pdf');
    c = await ok(get(t.base, t.maker.session, `/api/contracts/${c.id}`));
    for (const fields of [
      { signDate: '2026-12-03', effectiveDate: null },
      { signDate: '2026-11-20', effectiveDate: '2026-11-19' },
    ]) {
      await patch(fields);
      expect(c.blockers.map((b: any) => b.code)).toContain('DATE_SEQUENCE_CONFLICT');
      expect(c.blockers.map((b: any) => b.code)).not.toContain('LEGAL_REVIEW_OUTDATED');
      expect((await post(t.base, t.maker.session, `/api/contracts/${c.id}/advance`, { expectedVersion: c.version, toStage: 'performance' })).status).toBe(409);
    }
    await patch({ signDate: '2026-11-20', effectiveDate: '2026-11-20' });
    expect(c.blockers).toEqual([]);
    expect(c.reviews[0].legalRunId).toBe(first.id);
    const reviews = await t.reviews();
    expect(reviews.runs).toHaveLength(1);
    expect(reviews.runs[0]).toMatchObject({ isCurrent: true, contextFingerprint: first.contextFingerprint });
    c = await ok(post(t.base, t.maker.session, `/api/contracts/${c.id}/advance`, { expectedVersion: c.version, toStage: 'performance' }));
    expect(c.stage).toBe('performance');
  });
  it.each(['same_code', 'other_code'])('发布候选不替换正式基准或使批准失效：%s', async (kind) => {
    const t = await setup();
    await ok(post(t.base, t.admin, `/api/contracts/legal-catalog/templates/${t.template.id}/promote`, { reason: '测试核定' }));
    await t.run();
    let c = await ok(get(t.base, t.maker.session, `/api/contracts/${t.c.id}`));
    c = await ok(post(t.base, t.maker.session, `/api/contracts/${c.id}/advance`, { expectedVersion: c.version, toStage: 'approval' }));
    c = await ok(post(t.base, t.maker.session, `/api/contracts/${c.id}/reviews`, { documentId: t.text.id }), 201);
    c = await ok(post(t.base, t.reviewer.session, `/api/contracts/${c.id}/reviews/${c.reviews[0].id}/decide`, { decision: 'approve' }));
    const candidate = await ok(post(t.base, t.admin, '/api/contracts/legal-catalog/templates', {
      code: kind === 'same_code' ? t.template.code : 'SECOND-GOODS',
      version: kind === 'same_code' ? t.template.version + 1 : 1,
      name: '待核定新稿', legalCategory: 'goods_procurement', approvalStatus: 'candidate', notes: '测试候选',
      clauses: [{ clauseKey: 'subcontract', clauseNo: '第五条', title: '禁止违法分包', tier: 'fixed', standardText: '不得将主体义务转包或违法分包。' }],
    }), 201);
    expect((await t.reviews()).runs[0].isCurrent).toBe(true);
    c = await ok(get(t.base, t.maker.session, `/api/contracts/${c.id}`));
    expect(c.blockers.map((b: any) => b.code)).not.toContain('LEGAL_REVIEW_OUTDATED');
    const next = (await t.run()).runs[0];
    expect(next).toMatchObject({ verdict: 'pass', isCurrent: true, templateId: t.template.id, templateApprovalStatus: 'official' });
    await ok(post(t.base, t.admin, `/api/contracts/legal-catalog/templates/${candidate.id}/promote`, { reason: '测试核定新版本' }));
    expect((await t.reviews()).runs[0].isCurrent).toBe(false);
    const promoted = (await t.run()).runs[0];
    expect(promoted).toMatchObject(kind === 'same_code'
      ? { verdict: 'pass', templateId: candidate.id }
      : { verdict: 'manual_review', templateId: null });
  });
  it.each(['tech_service', 'general_service', 'income_sales'])('非默认类别已有法审后返回启用状态，并允许无正式复核时纠错：%s', async (category) => {
    const t = await setup(category);
    let c = await ok(get(t.base, t.maker.session, `/api/contracts/${t.c.id}`));
    expect(c.legalReviewEnabled).toBe(false);
    c = await ok(post(t.base, t.maker.session, `/api/contracts/${c.id}/advance`, { expectedVersion: c.version, toStage: 'approval' }));
    t.pauseModel();
    try {
      await ok(post(t.base, t.maker.session, `/api/contracts/${c.id}/legal-reviews/run`), 202);
      c = await ok(get(t.base, t.maker.session, `/api/contracts/${c.id}`));
      expect(c.legalReviewEnabled).toBe(true);
      expect(c.reviews).toEqual([]);
    } finally { t.releaseModel(); }
    await t.run();
    c = await ok(get(t.base, t.maker.session, `/api/contracts/${c.id}`));
    c = await ok(fetchAs(t.maker.session, `${t.base}/api/contracts/${c.id}`, {
      method: 'PATCH', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ expectedVersion: c.version, originalAmount: '100000.01', partyRole: 'client' }),
    }));
    expect(c).toMatchObject({ legalReviewEnabled: true, originalAmount: '100000.01', partyRole: 'client', reviews: [] });
  });
  it('candidate 人工核验 → official pass → 一次正式确认，防止重复/篡改；跨组织 API/助手/下载隔离', async () => {
    const t = await setup();
    let result = await t.run();
    expect(result.runs[0], JSON.stringify(result)).toMatchObject({
      verdict: 'manual_review',
      isCurrent: true,
      modelStatus: 'ok',
    });
    await ok(
      post(
        t.base,
        t.admin,
        `/api/contracts/legal-catalog/templates/${t.template.id}/promote`,
        { reason: '主管部门核定测试范本' },
      ),
    );
    result = await t.run();
    expect(result.runs[0], JSON.stringify(result)).toMatchObject({
      verdict: 'pass',
      isCurrent: true,
    });
    let c = await ok(get(t.base, t.maker.session, `/api/contracts/${t.c.id}`));
    c = await ok(
      post(t.base, t.maker.session, `/api/contracts/${c.id}/advance`, {
        expectedVersion: c.version,
        toStage: 'approval',
      }),
    );
    c = await ok(
      post(t.base, t.maker.session, `/api/contracts/${c.id}/reviews`, {
        documentId: t.text.id,
      }),
      201,
    );
    const rid = c.reviews[0].id;
    c = await ok(
      post(
        t.base,
        t.reviewer.session,
        `/api/contracts/${c.id}/reviews/${rid}/decide`,
        { decision: 'approve' },
      ),
    );
    expect(c.reviews[0]).toMatchObject({
      status: 'approved',
      legalRunId: result.runs[0].id,
      overrideHighRisk: false,
    });
    expect(
      (
        await post(
          t.base,
          t.reviewer.session,
          `/api/contracts/${c.id}/reviews/${rid}/decide`,
          { decision: 'approve' },
        )
      ).status,
    ).toBe(409);
    for (const table of [
      'ct_legal_run',
      'ct_legal_finding',
      'ct_doc_parse_cache',
    ]) {
      expect(() => t.db.prepare(`DELETE FROM ${table}`).run()).toThrow(
        /immutable/,
      );
      expect(() =>
        t.db
          .prepare(
            `UPDATE ${table} SET ${table === 'ct_legal_run' ? "verdict='revise'" : table === 'ct_legal_finding' ? "title='tampered'" : "text_content='tampered'"}`,
          )
          .run(),
      ).toThrow(/immutable/);
    }
    expect(() =>
      t.db
        .prepare('UPDATE ct_review SET legal_run_id=NULL WHERE id=?')
        .run(rid),
    ).toThrow();
    expect(
      (
        await get(
          t.base,
          t.other.session,
          `/api/contracts/${c.id}/legal-reviews`,
        )
      ).status,
    ).toBe(404);
    expect(
      (
        await get(
          t.base,
          t.other.session,
          `/api/contracts/${c.id}/documents/${t.text.id}/content`,
        )
      ).status,
    ).toBe(404);
    const auth = loadAuthContext(t.db, t.other.userId)!;
    expect(() =>
      runWithContext({ requestId: 'test', source: 'assistant', auth }, () =>
        executeTool(t.db, 'contract_legal_review', { contractId: c.id }),
      ),
    ).toThrow();
    await t.doc('other', Buffer.from('note'), '无关过程.pdf');
    expect((await t.reviews()).runs[0].isCurrent).toBe(true);
    await t.doc(
      'contract_text',
      await docx(GOOD_TEXT + '\n新版正文'),
      '新版.docx',
    );
    c = await ok(get(t.base, t.maker.session, `/api/contracts/${c.id}`));
    expect(c.blockers.map((b: any) => b.code)).toContain(
      'LEGAL_REVIEW_OUTDATED',
    );
  });
  it('签署前纠错使运行失效；运行中换文拒绝落库；高风险缺件不可例外通过；旧 DOC 上传指引', async () => {
    const t = await setup();
    await t.run();
    let c = await ok(get(t.base, t.maker.session, `/api/contracts/${t.c.id}`));
    c = await ok(
      post(t.base, t.maker.session, `/api/contracts/${c.id}/advance`, {
        expectedVersion: c.version,
        toStage: 'approval',
      }),
    );
    c = await ok(
      post(t.base, t.maker.session, `/api/contracts/${c.id}/reviews`, {
        documentId: t.text.id,
      }),
      201,
    );
    const rid = c.reviews[0].id;
    const bad = await json(
      post(
        t.base,
        t.reviewer.session,
        `/api/contracts/${c.id}/reviews/${rid}/decide`,
        { decision: 'approve' },
      ),
    );
    expect(bad.code).toBe('LEGAL_REVIEW_COMMENT_REQUIRED');
    const patch = await fetchAs(
      t.maker.session,
      `${t.base}/api/contracts/${c.id}`,
      {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          expectedVersion: c.version,
          ...SIGNATORIES, originalAmount: '100000.01',
          isImportant: true,
        }),
      },
    );
    c = await ok(patch);
    expect((await t.reviews()).runs[0].isCurrent).toBe(false);
    expect(
      (
        await json(
          post(
            t.base,
            t.reviewer.session,
            `/api/contracts/${c.id}/reviews/${rid}/decide`,
            { decision: 'approve', comment: '核验通过' },
          ),
        )
      ).code,
    ).toBe('LEGAL_REVIEW_STALE');
    const result = await t.run();
    expect(
      result.runs[0].findings.some(
        (f: any) => f.code === 'IMPORTANT_CONTRACT_GATE',
      ),
    ).toBe(true);
    expect(
      (
        await json(
          post(
            t.base,
            t.reviewer.session,
            `/api/contracts/${c.id}/reviews/${rid}/decide`,
            { decision: 'approve', comment: '例外批准' },
          ),
        )
      ).code,
    ).toBe('LEGAL_REVIEW_BLOCKED');
    await ok(
      post(
        t.base,
        t.reviewer.session,
        `/api/contracts/${c.id}/reviews/${rid}/decide`,
        { decision: 'reject', comment: '补齐材料' },
      ),
    );
    expect(
      (
        await json(
          upload(
            t.base,
            t.maker.session,
            `/api/contracts/${c.id}/documents`,
            Buffer.from([0xd0, 0xcf, 0x11, 0xe0]),
            'old.doc',
            { docType: 'contract_text' },
          ),
        )
      ).message,
    ).toContain('另存为');
  });
  it('跨账号活跃任务去重；运行中换文拒绝落库，失败后同指纹可重跑', async () => {
    const t = await setup();
    t.pauseModel();
    try {
      const first = await ok(
        post(
          t.base,
          t.maker.session,
          `/api/contracts/${t.c.id}/legal-reviews/run`,
        ),
        202,
      );
      const second = await ok(
        post(
          t.base,
          t.reviewer.session,
          `/api/contracts/${t.c.id}/legal-reviews/run`,
        ),
        202,
      );
      expect(second).toMatchObject({ jobId: first.jobId, deduplicated: true });
      expect((await t.reviews()).activeJob.id).toBe(first.jobId);
      expect(
        (
          await post(
            t.base,
            t.other.session,
            `/api/contracts/${t.c.id}/legal-reviews/run`,
          )
        ).status,
      ).toBe(404);
      await t.doc(
        'contract_text',
        await docx(GOOD_TEXT + '\n新版文本不改变商务条件'),
        'new.docx',
      );
      t.releaseModel();
      let status = '';
      for (let i = 0; i < 300; i++) {
        status = (
          t.db
            .prepare('SELECT status FROM app_job WHERE id=?')
            .get(first.jobId) as any
        ).status;
        if (!['queued', 'running'].includes(status)) break;
        await new Promise((r) => setTimeout(r, 20));
      }
      expect(status).toBe('failed');
      expect((await t.reviews()).runs).toHaveLength(0);
      expect((await t.run()).runs).toHaveLength(1);
    } finally {
      t.releaseModel();
    }
  });
  it('候选人工确认留痕；依据补传与同内容重传失效；显式 AuthContext 范围不能借用管理员', async () => {
    const t = await setup();
    const first = (await t.run()).runs[0];
    let c = await ok(get(t.base, t.maker.session, `/api/contracts/${t.c.id}`));
    c = await ok(
      post(t.base, t.maker.session, `/api/contracts/${c.id}/advance`, {
        expectedVersion: c.version,
        toStage: 'approval',
      }),
    );
    c = await ok(
      post(t.base, t.maker.session, `/api/contracts/${c.id}/reviews`, {
        documentId: t.text.id,
      }),
      201,
    );
    c = await ok(
      post(
        t.base,
        t.reviewer.session,
        `/api/contracts/${c.id}/reviews/${c.reviews[0].id}/decide`,
        { decision: 'approve', comment: '已人工核实候选商业默认值' },
      ),
    );
    expect(c.reviews[0]).toMatchObject({
      legalRunId: first.id,
      overrideHighRisk: true,
    });
    await t.doc(
      'procurement',
      Buffer.from('new-current-approval'),
      '新版定标审批.pdf',
      'bid_award_approval',
    );
    expect((await t.reviews()).runs[0].isCurrent).toBe(false);
    const next = (await t.run()).runs[0];
    expect(next.isCurrent).toBe(true);
    await t.doc('contract_text', await docx(), '同内容新版本.docx');
    expect((await t.reviews()).runs[0].isCurrent).toBe(false);
    const admin = loadAuthContext(t.db, ensureAdmin(t.db))!;
    const west = loadAuthContext(t.db, t.other.userId)!;
    expect(() =>
      runWithContext(
        { requestId: 'direct-scope', source: 'http', auth: admin },
        () => listLegalReviews(t.db, c.id, west),
      ),
    ).toThrow(/不存在或无权访问/);
  });
  it('持久化超 2^53 金额精确，重新运行不能保留旧批准的推进效力', async () => {
    const t = await setup();
    await ok(
      post(
        t.base,
        t.admin,
        `/api/contracts/legal-catalog/templates/${t.template.id}/promote`,
        { reason: '合成测试核定' },
      ),
    );
    const result = await t.run();
    let c = await ok(get(t.base, t.maker.session, `/api/contracts/${t.c.id}`));
    const patch = async (data: unknown) =>
      ok(
        fetchAs(t.maker.session, `${t.base}/api/contracts/${c.id}`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            expectedVersion: c.version,
            ...(data as object),
          }),
        }),
      );
    c = await patch({ originalAmount: '90071992547409.93' });
    expect(c.originalAmount).toBe('90071992547409.93');
    expect(c.procurementTier).toBe('tier_1');
    expect((await t.reviews()).runs[0].isCurrent).toBe(false);
    c = await patch({ originalAmount: '100000.00' });
    await t.run();
    c = await ok(
      post(t.base, t.maker.session, `/api/contracts/${c.id}/advance`, {
        expectedVersion: c.version,
        toStage: 'approval',
      }),
    );
    c = await ok(
      post(t.base, t.maker.session, `/api/contracts/${c.id}/reviews`, {
        documentId: t.text.id,
      }),
      201,
    );
    c = await ok(
      post(
        t.base,
        t.reviewer.session,
        `/api/contracts/${c.id}/reviews/${c.reviews[0].id}/decide`,
        { decision: 'approve' },
      ),
    );
    const bound = c.reviews[0].legalRunId;
    expect(bound).not.toBe(result.runs[0].id);
    await t.run();
    c = await ok(get(t.base, t.maker.session, `/api/contracts/${c.id}`));
    expect(
      c.blockers.some((b: any) => b.code === 'LEGAL_REVIEW_OUTDATED'),
    ).toBe(true);
  });
});
