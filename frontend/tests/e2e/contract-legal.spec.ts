import { execFile } from 'node:child_process';
import { createServer } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { test, expect, login } from './access';
import { GOOD_TEXT, docx } from '../../../backend/tests/t9-legal-fixture';
import fs from 'node:fs';

const execFileAsync = promisify(execFile);

async function buildOle2DocBuffer(text: string): Promise<Buffer> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'newfc-e2e-doc-'));
  try {
    const inPath = path.join(tmpDir, 'source.html');
    const outDir = path.join(tmpDir, 'out');
    const profileDir = path.join(tmpDir, 'profile');
    fs.mkdirSync(outDir, { mode: 0o700 });
    fs.mkdirSync(profileDir, { mode: 0o700 });
    const htmlBody = text
      .split('\n')
      .map((line) => `<p>${line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`)
      .join('\n');
    fs.writeFileSync(inPath, `<!doctype html><html><head><meta charset="utf-8"></head><body>${htmlBody}</body></html>`, 'utf8');
    await execFileAsync(
      'soffice',
      [
        '--headless',
        '--norestore',
        '--nologo',
        '--nodefault',
        '--nofirststartwizard',
        `-env:UserInstallation=file://${profileDir}`,
        '--convert-to',
        'doc:MS Word 97',
        '--outdir',
        outDir,
        inPath,
      ],
      { timeout: 20_000 },
    );
    return fs.readFileSync(path.join(outDir, 'source.doc'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
}
const seed = JSON.parse(
  fs.readFileSync(
    new URL('../../../deploy/contract-legal-seed-v1.json', import.meta.url),
    'utf8',
  ),
);
test('AC-CLR-01/04/05：候选核验、正式范本 pass、页面一次确认、换文失效与窄屏', async ({
  page,
  request,
}) => {
  const mock = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          choices: [{ message: { content: '{"findings":[]}' } }],
        }),
      );
    });
  }).listen(0);
  const modelUrl = `http://127.0.0.1:${(mock.address() as any).port}/v1`;
  let channelId: number | undefined;
  const create = async (url: string, data: unknown, status = 201) => {
    const r = await request.post(url, { data });
    expect(r.status(), await r.text()).toBe(status);
    return r.json();
  };
  try {
    const policies = await (
      await request.get('/api/contracts/legal-catalog/policies')
    ).json();
    for (const p of seed.policies)
      if (
        !policies.some((x: any) => x.code === p.code && x.version === p.version)
      )
        await create('/api/contracts/legal-catalog/policies', p);
    channelId = (
      await create('/api/settings/ai-channels', {
        name: `合同法审 E2E ${Date.now()}`,
        baseUrl: modelUrl,
        apiKey: 'e2e-local-key',
        model: 'mock-legal',
        enabled: true,
        stream: false,
      })
    ).id;
    expect(
      (
        await request.put('/api/settings/ai-feature-bindings', {
          data: {
            bindings: [
              {
                feature: 'contract_legal_review',
                primaryChannelId: channelId,
                fallbackChannelId: null,
              },
            ],
          },
        })
      ).ok(),
    ).toBe(true);
    const templates = await (
      await request.get('/api/contracts/legal-catalog/templates')
    ).json();
    const version =
      Math.max(
        0,
        ...templates
          .filter((t: any) => t.code === 'TPL-GOODS-2026')
          .map((t: any) => t.version),
      ) + 1;
    const template = await create('/api/contracts/legal-catalog/templates', {
      code: 'TPL-GOODS-2026',
      version,
      name: 'E2E 核定范本',
      legalCategory: 'goods_procurement',
      approvalStatus: 'candidate',
      notes: '合成测试核定材料，仅用于可丢弃库',
      clauses: [
        {
          clauseKey: 'subcontract',
          clauseNo: '第五条',
          title: '禁止违法分包',
          tier: 'fixed',
          standardText: '不得将主体义务转包或违法分包。',
        },
      ],
    });
    const orgs = await (await request.get('/api/org/tree')).json();
    const orgId = orgs.rows.find((o: any) => o.name === '上海公司').id;
    const project = await create('/api/master/projects', {
      code: `CLR-${Date.now()}`,
      name: '浏览器法审测试项目',
      orgId,
    });
    const supplier = await create('/api/master/suppliers', {
      code: `CLR-S-${Date.now()}`,
      name: '测试供货公司',
    });
    const no = `LS-SG-${Date.now()}/2026-001`;
    let c = await create('/api/contracts', {
      contractNo: no,
      name: '设备物资采购合同',
      contractType: '采购',
      orgId,
      projectId: project.id,
      supplierId: supplier.id,
      originalAmount: '100000.00',
      legalCategory: 'goods_procurement',
      partyRole: 'buyer',
      isProcurement: true,
      procurementTarget: 'goods',
      procurementMethod: 'inquiry',
      // V72 requires signatory identity before entering performance.
      ourSignatoryName: '测试法人',
      ourSignatoryTitle: '法定代表人',
      ourSignatoryIsLegalRep: true,
      counterpartySignatoryIsLegalRep: true,
    });
    const upload = async (
      type: string,
      buffer: Buffer,
      fileName: string,
      evidenceKind?: string,
    ) => {
      const r = await request.post(`/api/contracts/${c.id}/documents`, {
        multipart: {
          docType: type,
          ...(evidenceKind ? { evidenceKind } : {}),
          file: {
            name: fileName,
            mimeType: 'application/octet-stream',
            buffer,
          },
        },
      });
      expect(r.status(), await r.text()).toBe(201);
      return r.json();
    };
    await upload(
      'procurement',
      Buffer.from('测试审批文件'),
      '审批.pdf',
      'bid_award_approval',
    );
    for (const stage of ['procurement', 'drafting']) {
      c = await (await request.get(`/api/contracts/${c.id}`)).json();
      c = await create(
        `/api/contracts/${c.id}/advance`,
        { expectedVersion: c.version, toStage: stage },
        200,
      );
    }
    const text = await upload(
      'contract_text',
      await docx(GOOD_TEXT.replace('LS-SG-001/2026-001', no)),
      '合规正文.docx',
    );
    await login(page);
    await page.goto(`/contracts?id=${c.id}`);
    // The ledger has no attachment-only column; the document table keeps its evidence column.
    await expect(page.getByRole('columnheader', { name: '签订依据', exact: true })).toHaveCount(1);
    const pick = async (label: string, option: string) => {
      await page.locator('.ant-select').filter({ has: page.getByRole('combobox', { name: label, exact: true }) }).click();
      await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').getByText(option, { exact: true }).click();
    };
    const uploadFromPage = async (name: string) => {
      const response = page.waitForResponse(r => r.request().method() === 'POST' && r.url().endsWith(`/contracts/${c.id}/documents`));
      await page.locator('.contract-detail-drawer input[type=file]').setInputFiles({ name, mimeType: 'text/plain', buffer: Buffer.from(name) });
      const r = await response;
      expect(r.status(), await r.text()).toBe(201);
      return r.json();
    };
    await pick('文档类型', '招采文件');
    await pick('签订依据分类', '定标审批');
    expect((await uploadFromPage('新的定标审批.txt')).evidenceKind).toBe('bid_award_approval');
    await expect(page.getByText('签订依据分类（可选）', { exact: true })).toBeVisible();
    expect((await uploadFromPage('无分类过程材料.txt')).evidenceKind).toBeNull();
    await pick('签订依据分类', '定标审批');
    await pick('文档类型', '发票');
    await expect(page.getByText('签订依据分类（可选）', { exact: true })).toBeVisible();
    expect((await uploadFromPage('无分类发票.txt')).evidenceKind).toBeNull();
    await page.getByRole('button', { name: '启动智能法审' }).click();
    await expect(
      page.getByText('需补充人工审查', { exact: true }),
    ).toBeVisible();
    c = await (await request.get(`/api/contracts/${c.id}`)).json();
    await create(
      `/api/contracts/${c.id}/advance`,
      { expectedVersion: c.version, toStage: 'approval' },
      200,
    );
    await create(`/api/contracts/${c.id}/reviews`, { documentId: text.id });
    await page.reload();
    for (const amount of ['100000.01', '100000.00']) {
      await page.getByRole('button', { name: /编\s*辑/, exact: true }).click();
      const dialog = page.getByRole('dialog', { name: /编辑合同/ });
      await expect(
        dialog.getByLabel('原始金额(元)', { exact: true }),
      ).toBeEnabled();
      await dialog.getByLabel('原始金额(元)', { exact: true }).fill(amount);
      await dialog.getByRole('button', { name: /确\s*定/ }).click();
      await expect(dialog).toBeHidden();
      if (amount === '100000.01')
        await expect(
          page.getByText('已失效，需重新法审', { exact: true }),
        ).toBeVisible();
    }
    await expect(
      page
        .getByText('当前比对基准为候选清理稿（待主管部门核定转正）', {
          exact: true,
        })
        .first(),
    ).toBeVisible();
    await create(
      `/api/contracts/legal-catalog/templates/${template.id}/promote`,
      { reason: 'E2E 测试主管部门核定' },
      200,
    );
    await page.getByRole('button', { name: '重新运行法审' }).click();
    await expect(page.getByText('建议通过', { exact: true })).toBeVisible();
    await page
      .getByLabel('同人复核例外原因')
      .fill('单人测试管理员，已核对原文');
    await page.getByRole('button', { name: '确认通过', exact: true }).click();
    await expect
      .poll(async () => {
        const d = await (await request.get(`/api/contracts/${c.id}`)).json();
        return d.reviews[0].status;
      })
      .toBe('approved');
    await expect(
      page.getByText('正式复核已通过', { exact: true }),
    ).toBeVisible();
    await page.getByRole('button', { name: /编\s*辑/, exact: true }).click();
    const signing = page.getByRole('dialog', { name: /编辑合同/ });
    for (const label of ['签订日期', '生效日期']) {
      await signing.getByLabel(label, { exact: true }).fill('2026-11-20');
      await signing.getByLabel(label, { exact: true }).press('Enter');
    }
    await signing.getByRole('button', { name: /确\s*定/ }).click();
    await expect(signing).toBeHidden();
    await upload('signed', Buffer.from('合成签署件'), '签署件.pdf');
    await page.reload();
    await expect(page.getByText('正式复核已通过', { exact: true })).toBeVisible();
    await expect(page.getByRole('button', { name: '推进到履约执行', exact: true })).toBeEnabled();
    const afterSigning = await (await request.get(`/api/contracts/${c.id}/legal-reviews`)).json();
    expect(afterSigning.runs[0].isCurrent).toBe(true);
    await page.screenshot({
      path: '/tmp/newfc-t9-contract-desktop.png',
      fullPage: true,
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await expect
      .poll(() =>
        page
          .locator('.contract-detail-drawer .ant-descriptions')
          .first()
          .locator('tr')
          .first()
          .locator('td,th')
          .count(),
      )
      .toBe(2);
    await page.screenshot({
      path: '/tmp/newfc-t9-contract-mobile.png',
      fullPage: true,
    });
    expect(
      await page.evaluate(
        () => document.documentElement.scrollWidth <= window.innerWidth,
      ),
    ).toBe(true);
    await upload(
      'contract_text',
      await docx(
        GOOD_TEXT.replace('LS-SG-001/2026-001', no) + '\n新版变更标记',
      ),
      '新版正文.docx',
    );
    await page.reload();
    await expect(
      page.getByText('已失效，需重新法审', { exact: true }),
    ).toBeVisible();
    await expect(
      page.getByRole('button', { name: '确认通过', exact: true }),
    ).toHaveCount(0);
  } finally {
    if (channelId)
      await request
        .patch(`/api/settings/ai-channels/${channelId}`, {
          data: { enabled: false },
        })
        .catch(() => {});
    mock.closeAllConnections();
    await new Promise<void>((r) => mock.close(() => r()));
  }
});

test('非默认类别启动法审后、正式复核前可在页面更正金额和法审元数据', async ({ page, request }) => {
  const orgs = await (await request.get('/api/org/tree')).json();
  const orgId = orgs.rows.find((o: any) => o.name === '上海公司').id;
  const stamp = Date.now();
  const project = await (await request.post('/api/master/projects', { data: { code: `CLR-EDIT-${stamp}`, name: '法审纠错测试项目', orgId } })).json();
  const supplier = await (await request.post('/api/master/suppliers', { data: { code: `CLR-EDIT-${stamp}`, name: '非默认法审测试供应商' } })).json();
  let r = await request.post('/api/contracts', { data: {
    contractNo: `LS-SG-${stamp}/2026-002`, name: '一般服务签署前纠错', contractType: '服务', orgId,
    projectId: project.id, supplierId: supplier.id, originalAmount: '100000.00', legalCategory: 'general_service',
    isProcurement: false,
  } });
  expect(r.status()).toBe(201);
  let c = await r.json();
  r = await request.post(`/api/contracts/${c.id}/documents`, { multipart: {
    docType: 'contract_text', file: { name: '一般服务.docx', mimeType: 'application/octet-stream', buffer: await docx() },
  } });
  expect(r.status()).toBe(201);
  for (const toStage of ['procurement', 'drafting', 'approval']) {
    c = await (await request.get(`/api/contracts/${c.id}`)).json();
    r = await request.post(`/api/contracts/${c.id}/advance`, { data: { expectedVersion: c.version, toStage } });
    expect(r.status(), await r.text()).toBe(200);
  }
  await login(page);
  await page.goto(`/contracts?id=${c.id}`);
  await page.getByRole('button', { name: '启动智能法审', exact: true }).click();
  await expect(page.getByText('建议修改后重审', { exact: true }).or(page.getByText('需补充人工审查', { exact: true }))).toBeVisible();
  await expect.poll(async () => (await (await request.get(`/api/contracts/${c.id}`)).json()).legalReviewEnabled).toBe(true);
  await page.getByRole('button', { name: /编\s*辑/, exact: true }).click();
  const dialog = page.getByRole('dialog', { name: /编辑合同/ });
  await expect(dialog.getByLabel('原始金额(元)', { exact: true })).toBeEnabled();
  await expect(dialog.getByLabel('我方立场', { exact: true })).toBeEnabled();
  await dialog.getByLabel('原始金额(元)', { exact: true }).fill('100000.01');
  await dialog.locator('.ant-select').filter({ has: page.getByRole('combobox', { name: '我方立场', exact: true }) }).click();
  await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').getByText('委托方', { exact: true }).click();
  await dialog.getByRole('button', { name: /确\s*定/ }).click();
  await expect(dialog).toBeHidden();
  c = await (await request.get(`/api/contracts/${c.id}`)).json();
  expect(c).toMatchObject({ originalAmount: '100000.01', partyRole: 'client', legalReviewEnabled: true, reviews: [] });
});

test('制度与范本管理：表单发布、受控原件、核定转正及停用', async ({ page }) => {
  await login(page);
  await page.goto('/contracts');
  await page.getByRole('button', { name: '法审制度与范本' }).click();
  const catalog = page.getByRole('dialog', {
    name: '法审制度与范本',
    exact: true,
  });
  await catalog.getByRole('tab', { name: '合同范本', exact: true }).click();
  await catalog.getByRole('button', { name: '发布新版本' }).click();
  const form = page.getByRole('dialog', {
    name: '发布范本新版本',
    exact: true,
  });
  const code = `E2E-CATALOG-${Date.now()}`;
  await form.getByLabel('制度 / 范本编码', { exact: true }).fill(code);
  await form.getByLabel('范本名称', { exact: true }).fill('浏览器核定测试范本');
  await form
    .getByLabel('核定依据与适用范围', { exact: true })
    .fill('仅用于可丢弃测试库，非正式业务范本');
  await form.getByLabel('条款编号', { exact: true }).fill('第一条');
  await form.getByLabel('条款名称', { exact: true }).fill('试验条款');
  await form.getByLabel('条款识别码', { exact: true }).fill('e2e-clause');
  await form
    .getByLabel('条款原文', { exact: true })
    .fill('双方应按约定进行验收。');
  await form.getByRole('button', { name: /确\s*定/ }).click();
  await expect(form).toBeHidden();
  await catalog
    .getByText(`${code} v1 · 浏览器核定测试范本`, { exact: true })
    .click();
  await catalog
    .locator('input[type=file]')
    .setInputFiles({
      name: '核定原件.txt',
      mimeType: 'text/plain',
      buffer: Buffer.from('仅用于合成浏览器测试的核定材料'),
    });
  await expect(
    catalog.getByRole('button', { name: '下载原件', exact: true }),
  ).toBeVisible();
  await catalog.getByRole('button', { name: '核定转正', exact: true }).click();
  let reason = page.getByRole('dialog', { name: '核定范本为正式版本' });
  await reason.getByLabel('核定或停用说明').fill('测试主管部门核定材料');
  await reason.getByRole('button', { name: /确\s*定/ }).click();
  await expect(reason).toBeHidden();
  await catalog.getByRole('button', { name: '停用版本', exact: true }).click();
  reason = page.getByRole('dialog', { name: '停用此版本' });
  await reason.getByLabel('核定或停用说明').fill('测试完成，停用测试版本');
  await reason.getByRole('button', { name: /确\s*定/ }).click();
  await expect(reason).toBeHidden();
  await expect(
    catalog.getByRole('button', { name: '停用版本', exact: true }),
  ).toHaveCount(0);
});

test('P0: construction/tech_service 合同展示法审面板、老式 .doc 上传转码流转与无后缀范本原件带扩展名下载', async ({
  page,
  request,
}) => {
  const mock = createServer((req, res) => {
    req.resume();
    req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ choices: [{ message: { content: '{"findings":[]}' } }] }));
    });
  }).listen(0);
  const modelUrl = `http://127.0.0.1:${(mock.address() as { port: number }).port}/v1`;

  try {
    const chRes = await request.post('/api/settings/ai-channels', {
      data: {
        name: `P0 .doc 法审通道 ${Date.now()}`,
        baseUrl: modelUrl,
        apiKey: 'e2e-doc-key',
        model: 'mock-legal',
        enabled: true,
        stream: false,
      },
    });
    expect(chRes.status()).toBe(201);
    const channelId = (await chRes.json()).id;
    await request.put('/api/settings/ai-feature-bindings', {
      data: {
        bindings: [{ feature: 'contract_legal_review', primaryChannelId: channelId, fallbackChannelId: null }],
      },
    });

    const orgs = await (await request.get('/api/org/tree')).json();
    const orgId = orgs.rows.find((o: { name: string }) => o.name === '上海公司').id;
    const stamp = Date.now();
    const project = await (
      await request.post('/api/master/projects', { data: { code: `P0CLR-${stamp}`, name: 'P0法审工程项目', orgId } })
    ).json();
    const supplier = await (
      await request.post('/api/master/suppliers', { data: { code: `P0CLRS-${stamp}`, name: '测试勘测设计单位' } })
    ).json();

    // 1) 创建 construction 合同并验证展示法审面板（而非未纳管提示）
    const consRes = await request.post('/api/contracts', {
      data: {
        contractNo: `GRP-SG-${stamp}/2026-001`,
        name: '测试枢纽消力池建设工程合同',
        contractType: '建设工程',
        orgId,
        projectId: project.id,
        supplierId: supplier.id,
        originalAmount: '500000.00',
        legalCategory: 'construction',
        partyRole: 'employer',
        isProcurement: true,
        procurementTarget: 'construction',
        procurementMethod: 'public_tender',
        ourSignatoryName: '测试法人',
        ourSignatoryTitle: '法定代表人',
        ourSignatoryIsLegalRep: true,
        counterpartySignatoryIsLegalRep: true,
      },
    });
    expect(consRes.status(), await consRes.text()).toBe(201);
    const consContract = await consRes.json();
    expect(consContract.legalReviewEnabled).toBe(true);

    // 2) 创建 tech_service 合同，推进至 approval，通过浏览器上传老版 .doc 正文并运行法审，展示「已转码解析」
    const techRes = await request.post('/api/contracts', {
      data: {
        contractNo: `GRP-SJ-${stamp}/2026-002`,
        name: '大坝安全监测技术服务合同',
        contractType: '技术服务',
        orgId,
        projectId: project.id,
        supplierId: supplier.id,
        originalAmount: '180000.00',
        legalCategory: 'tech_service',
        partyRole: 'client',
        isProcurement: true,
        procurementTarget: 'service',
        procurementMethod: 'inquiry',
        ourSignatoryName: '测试法人',
        ourSignatoryTitle: '法定代表人',
        ourSignatoryIsLegalRep: true,
        counterpartySignatoryIsLegalRep: true,
      },
    });
    expect(techRes.status(), await techRes.text()).toBe(201);
    let techContract = await techRes.json();
    expect(techContract.legalReviewEnabled).toBe(true);

    await request.post(`/api/contracts/${techContract.id}/documents`, {
      multipart: {
        docType: 'procurement',
        evidenceKind: 'bid_award_approval',
        file: { name: 'award.pdf', mimeType: 'application/pdf', buffer: Buffer.from('award') },
      },
    });
    await request.post(`/api/contracts/${techContract.id}/documents`, {
      multipart: {
        docType: 'qualification',
        evidenceKind: 'supplier_qualification',
        file: { name: 'qual.pdf', mimeType: 'application/pdf', buffer: Buffer.from('qual') },
      },
    });
    for (const toStage of ['procurement', 'drafting']) {
      techContract = await (await request.get(`/api/contracts/${techContract.id}`)).json();
      await request.post(`/api/contracts/${techContract.id}/advance`, {
        data: { expectedVersion: techContract.version, toStage },
      });
    }

    const ole2DocBuf = await buildOle2DocBuffer(GOOD_TEXT);
    await login(page);
    await page.goto(`/contracts?id=${techContract.id}`);
    const drawer = page.locator('.contract-detail-drawer');
    await expect(drawer.getByText('大坝安全监测技术服务合同')).toBeVisible();
    await expect(drawer.getByText('当前合同类别未纳入强制智能法审范围')).toHaveCount(0);

    await drawer.locator('input[type=file]').setInputFiles({
      name: 'tech-service-body.doc',
      mimeType: 'application/msword',
      buffer: ole2DocBuf,
    });
    await expect(drawer.getByText('tech-service-body.doc')).toBeVisible();

    techContract = await (await request.get(`/api/contracts/${techContract.id}`)).json();
    const uploadedDoc = techContract.documents.find((d: { name: string }) => d.name === 'tech-service-body.doc');
    expect(uploadedDoc).toBeTruthy();
    await request.post(`/api/contracts/${techContract.id}/advance`, {
      data: { expectedVersion: techContract.version, toStage: 'approval' },
    });

    await page.reload();
    await drawer.getByRole('button', { name: '启动智能法审' }).click();
    await expect(drawer.getByText('已转码解析')).toBeVisible({ timeout: 30_000 });

    // 3) 法审制度与范本抽屉：无后缀 code 关联 .docx 原件后点击「下载原件」，文件名自动携带 .docx 后缀
    await drawer.getByRole('button', { name: /关\s*闭|Close/ }).first().click();
    await page.getByRole('button', { name: '法审制度与范本' }).click();
    const catalog = page.getByRole('dialog', { name: '法审制度与范本', exact: true });
    await catalog.getByRole('tab', { name: '合同范本', exact: true }).click();
    await catalog.getByRole('button', { name: '发布新版本' }).click();
    const form = page.getByRole('dialog', { name: '发布范本新版本', exact: true });
    const tplCode = `E2E-TPL-EXT-${stamp}`;
    await form.getByLabel('制度 / 范本编码', { exact: true }).fill(tplCode);
    await form.getByLabel('范本名称', { exact: true }).fill('无后缀编码下载扩展名测试范本');
    await form.getByLabel('核定依据与适用范围', { exact: true }).fill('仅用于可丢弃 E2E 测试库');
    await form.getByLabel('条款编号', { exact: true }).fill('第一条');
    await form.getByLabel('条款名称', { exact: true }).fill('履约条款');
    await form.getByLabel('条款识别码', { exact: true }).fill('e2e-ext-clause');
    await form.getByLabel('条款原文', { exact: true }).fill('按约定提供技术成果。');
    await form.getByRole('button', { name: /确\s*定/ }).click();
    await expect(form).toBeHidden();

    await catalog.getByText(`${tplCode} v1 · 无后缀编码下载扩展名测试范本`, { exact: true }).click();
    await catalog.locator('input[type=file]').setInputFiles({
      name: 'template-source.docx',
      mimeType: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
      buffer: await docx(GOOD_TEXT),
    });
    const dlBtn = catalog.getByRole('button', { name: '下载原件', exact: true });
    await expect(dlBtn).toBeVisible();
    const dlPromise = page.waitForEvent('download');
    await dlBtn.click();
    const dl = await dlPromise;
    expect(dl.suggestedFilename()).toBe(`${tplCode}.docx`);
  } finally {
    await new Promise<void>((resolve) => mock.close(() => resolve()));
  }
});
