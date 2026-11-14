import http from 'node:http';
import { describe, expect, it } from 'vitest';
import { BUSINESS_SETTINGS, importBusinessSettingsSnapshot } from '../src/modules/settings/business-settings';
import { SIGNATORIES, PAYMENT_APPROVAL } from './contract-review-fixtures';
import { boot, get, json, post, upload, type Session } from './t3-helpers';
import { createScopedUser, fetchAs } from './http-helpers';
import { createProject, createSupplier } from './t4-helpers';

const put = (base: string, s: Session, body: unknown) =>
  fetchAs(s, `${base}/api/settings/business`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const patch = (base: string, s: Session, url: string, body: unknown) =>
  fetchAs(s, `${base}${url}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
async function ok(res: Response | Promise<Response>, status = 200) {
  const r = await res;
  const b = (await r.json()) as any;
  expect(r.status, JSON.stringify(b)).toBe(status);
  return b;
}

describe('T-GAP-03 29项业务参数登记、净资产阈值解锁与 PDF 解析连通性探活', () => {
  it('登记全部 29 项业务参数，校验节假日/调休冲突，并支持期初快照初始化与 PDF 服务探活', async () => {
    const { base, admin, db } = await boot('newfc-t13-settings-');
    expect(BUSINESS_SETTINGS.length).toBe(29);

    const items = (await json(get(base, admin, '/api/settings/business'))).items as { key: string; defaultValue: unknown }[];
    expect(items.find((i) => i.key === 'contract.countersign_due_days')?.defaultValue).toBe(0);
    expect(items.find((i) => i.key === 'contract.archive_transfer_sla_days')?.defaultValue).toBe(0);
    expect(String(items.find((i) => i.key === 'contract.legal_review_categories')?.defaultValue)).toContain('tech_service');

    const overlapRes = await put(base, admin, {
      'calendar.holidays': '2026-10-01,2026-10-02',
      'calendar.workdays': '2026-10-02,2026-10-10',
    });
    expect(overlapRes.status).toBe(400);
    expect((await json(overlapRes)).errors[0].message).toContain('同一日期不能同时配置');

    const subRes = await json(
      post(base, admin, '/api/org', {
        parentId: 1,
        code: 'SUB_LEGAL_01',
        name: '测试二级独立法人',
        orgKind: 'legal_entity',
      })
    );
    const snap = importBusinessSettingsSnapshot(db, {}, 'confirm');
    expect(String(snap.effectiveEntries['contract.legal_entity_org_ids']).split(',')).toContain(String(subRes.id));
    const netAssetSetting = snap.settings.find((s) => s.key === 'contract.prior_year_net_assets')!;
    expect(netAssetSetting.value).toBe('');

    const mockServer = http.createServer((req, res) => {
      if (req.url === '/health') {
        res.writeHead(200, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ status: 'ok' }));
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => mockServer.listen(0, '127.0.0.1', resolve));
    try {
      const addr = mockServer.address() as { port: number };
      const probeOk = await json(
        post(base, admin, '/api/settings/business/test-pdf-parser', {
          baseUrl: `http://127.0.0.1:${addr.port}`,
        })
      );
      expect(probeOk.ok).toBe(true);
      expect(probeOk.status).toBe(200);

      const probeSsrf = await json(
        post(base, admin, '/api/settings/business/test-pdf-parser', {
          baseUrl: 'http://169.254.169.254',
        })
      );
      expect(probeSsrf.ok).toBe(false);
    } finally {
      await new Promise<void>((resolve) => mockServer.close(() => resolve()));
    }
  });

  it('配置 contract.prior_year_net_assets 前兜底要求集体决策；配置后按 1% 与 5,000,000.00 元孰低精确分级', async () => {
    const t = await boot('newfc-t13-netasset-');
    const projectId = await createProject(t.base, t.admin, 'P-NA-01', '付款分级核验项目', t.fx.orgIds.shanghai);
    const supplierId = await createSupplier(t.base, t.admin, 'S-NA-01', '合成设备供应有限公司');
    const maker = createScopedUser(t.db, { username: 'na-maker', roleCodes: ['data_maintainer'], orgIds: [t.fx.orgIds.east] }).session;
    const reviewer = createScopedUser(t.db, { username: 'na-rev', roleCodes: ['business_reviewer'], orgIds: [t.fx.orgIds.east] }).session;

    const addDoc = async (cid: number, docType: string, name: string, evidenceKind?: string) =>
      (await ok(upload(t.base, maker, `/api/contracts/${cid}/documents`, Buffer.from(`${docType}-${name}`), name, { docType, ...(evidenceKind ? { evidenceKind } : {}) }), 201)).id as number;

    let c = await ok(
      post(t.base, maker, '/api/contracts', {
        ...SIGNATORIES,
        contractNo: 'HT-NA-2026-001',
        externalNoExempt: true,
        name: '分级阈值核验采购合同',
        contractType: '货物',
        orgId: t.fx.orgIds.shanghai,
        projectId,
        supplierId,
        originalAmount: '3000000.00',
        direction: 'expense',
        signingEntityLevel: 'company',
        reportCategory: 'goods',
        undertakerName: '陈工',
      }),
      201
    );
    await addDoc(c.id, 'procurement', '定标批件.pdf', 'bid_award_approval');
    c = await ok(get(t.base, maker, `/api/contracts/${c.id}`));
    c = await ok(post(t.base, maker, `/api/contracts/${c.id}/advance`, { expectedVersion: c.version, toStage: 'procurement' }));
    c = await ok(post(t.base, maker, `/api/contracts/${c.id}/advance`, { expectedVersion: c.version, toStage: 'drafting' }));
    const txtId = await addDoc(c.id, 'contract_text', '合同正文.docx');
    c = await ok(get(t.base, maker, `/api/contracts/${c.id}`));
    c = await ok(post(t.base, maker, `/api/contracts/${c.id}/advance`, { expectedVersion: c.version, toStage: 'approval' }));
    c = await ok(post(t.base, maker, `/api/contracts/${c.id}/reviews`, { documentId: txtId }), 201);
    c = await ok(post(t.base, reviewer, `/api/contracts/${c.id}/reviews/${c.reviews[0].id}/decide`, { decision: 'approve' }));
    await addDoc(c.id, 'signed', '盖章合同.pdf');
    c = await ok(get(t.base, maker, `/api/contracts/${c.id}`));
    c = await ok(patch(t.base, maker, `/api/contracts/${c.id}`, { expectedVersion: c.version, ...SIGNATORIES, signDate: '2026-03-10', effectiveDate: '2026-03-10' }));
    c = await ok(post(t.base, maker, `/api/contracts/${c.id}/advance`, { expectedVersion: c.version, toStage: 'performance' }));

    const apprDoc = await addDoc(c.id, 'other', '审批单.pdf', 'payment_approval_form');
    const feasDoc = await addDoc(c.id, 'other', '资金可行性报告.pdf', 'funding_feasibility');

    const blockedBefore = await post(t.base, maker, `/api/contracts/${c.id}/payments`, {
      ...PAYMENT_APPROVAL,
      nodeName: '未配净资产预付款',
      paymentType: 'prepayment',
      amount: '400000.00',
      plannedDate: '2026-04-01',
      approvalTier: 'finance_vp',
      approverName: '张副总',
      approverTitle: '财务副总',
    });
    expect(blockedBefore.status).toBe(409);
    expect((await json(blockedBefore)).code).toBe('CONTRACT_APPROVAL_TIER_REQUIRED');

    const rootOrg = t.db.prepare('SELECT id FROM org WHERE parent_id IS NULL ORDER BY id LIMIT 1').get() as { id: number };
    const saveRes = await put(t.base, t.admin, {
      'contract.prior_year_net_assets': JSON.stringify([{ orgId: rootOrg.id, year: 2025, amount: '100000000.00' }]),
    });
    expect(saveRes.status).toBe(200);

    const pass40w = await post(t.base, maker, `/api/contracts/${c.id}/payments`, {
      ...PAYMENT_APPROVAL,
      nodeName: '配置净资产后预付款',
      paymentType: 'prepayment',
      amount: '400000.00',
      plannedDate: '2026-04-01',
      approvalTier: 'finance_vp',
      approverName: '张副总',
      approverTitle: '财务副总',
    });
    expect(pass40w.status).toBe(201);

    const blockedOver1Pct = await post(t.base, maker, `/api/contracts/${c.id}/payments`, {
      ...PAYMENT_APPROVAL,
      nodeName: '超1%预付款',
      paymentType: 'prepayment',
      amount: '1200000.00',
      plannedDate: '2026-04-02',
      approvalTier: 'general_manager',
      approverName: '李总',
      approverTitle: '总经理',
      approvalDocId: apprDoc,
    });
    expect(blockedOver1Pct.status).toBe(409);

    const passCollective = await post(t.base, maker, `/api/contracts/${c.id}/payments`, {
      ...PAYMENT_APPROVAL,
      nodeName: '超1%集体决策预付款',
      paymentType: 'prepayment',
      amount: '1200000.00',
      plannedDate: '2026-04-02',
      approvalTier: 'collective_decision',
      approverName: '办公会',
      approverTitle: '集体决策',
      approvalDocId: apprDoc,
      feasibilityDocId: feasDoc,
    });
    expect(passCollective.status).toBe(201);
  });
});
