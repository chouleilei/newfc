import type { APIRequestContext, APIResponse } from '@playwright/test';
import { expect, login, test } from './access';

/**
 * T-6 跨域链路(AC-F26):顶栏检索 → /search 按类型分组 → 点击结果进入真实页面并打开对应详情(?id= 定位),
 * 关闭详情后参数移除;项目结果进入项目档案,显示同一项目的编码与名称。
 */

async function json<T>(res: APIResponse, status = 200): Promise<T> {
  expect(res.status(), await res.text()).toBe(status);
  return await res.json() as T;
}

interface OrgNode { id: number; name: string; children?: OrgNode[] }
async function orgId(request: APIRequestContext, name: string): Promise<number> {
  const walk = (nodes: OrgNode[]): number | undefined => {
    for (const n of nodes) { if (n.name === name) return n.id; const hit = walk(n.children ?? []); if (hit) return hit; }
    return undefined;
  };
  const { tree } = await json<{ tree: OrgNode[] }>(await request.get('/api/org/tree'));
  const id = walk(tree);
  if (!id) throw new Error(`夹具缺少组织 ${name}`);
  return id;
}

test.describe('跨域检索', () => {
  test('顶栏检索 → 分组结果 → 进入投资控制详情与项目档案', async ({ page, request }) => {
    const code = `E2E-SR-${Date.now()}`;
    const md = await json<{ id: number }>(await request.post('/api/master/projects', { data: { code, name: '检索泵站', orgId: await orgId(request, '上海公司') } }), 201);
    const ic = await json<{ id: number }>(await request.post('/api/investment/control/projects', { data: { mdProjectId: md.id } }), 201);

    await login(page);
    await page.goto('/');
    const box = page.getByRole('combobox', { name: '跨域检索' });
    await box.fill(code);
    await box.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/search\\?q=${code}`));
    await expect(page.getByText('不是语义检索')).toBeVisible();
    const icCard = page.locator('.ant-card', { has: page.locator('.ant-card-head', { hasText: '投资控制项目' }) });
    await expect(icCard.getByRole('link', { name: new RegExp(code) })).toBeVisible();
    const mdCard = page.locator('.ant-card', { has: page.locator('.ant-card-head-title', { hasText: /^项目/ }) });
    await expect(mdCard.getByRole('link', { name: new RegExp(code) })).toBeVisible();

    await icCard.getByRole('link', { name: new RegExp(code) }).click();
    await expect(page).toHaveURL(new RegExp(`/investment-control\\?id=${ic.id}$`));
    const drawer = page.locator('.ant-drawer-content-wrapper:visible').last();
    await expect(drawer.getByText(`${code} · 检索泵站`)).toBeVisible();
    await drawer.locator('.ant-drawer-close').click();
    await expect(page).toHaveURL(/\/investment-control$/);

    await page.goBack();
    await expect(page).toHaveURL(/\/search\?q=/);
    await mdCard.getByRole('link', { name: new RegExp(code) }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${md.id}$`));
    await expect(page.locator('.ant-descriptions-title')).toContainText(code);
    await expect(page.locator('.ant-descriptions-title')).toContainText('检索泵站');
    await expect(page.getByRole('tab', { name: '项目预算' })).toBeVisible();
  });
});

test.describe('工作台业务概况', () => {
  test('各域概况块可见并可进入对应页面', async ({ page }) => {
    await login(page);
    await page.goto('/');
    const card = page.getByTestId('domain-overview-card');
    await expect(card).toBeVisible();
    for (const label of ['合同', '费用报销', '项目预算', '风险', '投资控制', '分析报告']) {
      await expect(card.getByLabel(`业务概况 ${label}`)).toBeVisible();
    }
    await expect(card.getByLabel('业务概况 投资控制')).toContainText('最新快照超限项目');
    await card.getByLabel('业务概况 风险').click();
    await expect(page).toHaveURL(/\/risk$/);
  });
});

test.describe('T-15 报销拆单预警、EAS 合同工程遗留对账与全景互跳 (AC-T15-01 ~ AC-T15-03)', () => {
  test('小额采购报销连续拆单联动 PW_14 线索、风险台账与项目档案双向穿透及 EAS 遗留对账备注', async ({ page, request }) => {
    const shId = await orgId(request, '上海公司');
    const tag = Date.now();
    const prj = await json<{ id: number; code: string }>(
      await request.post('/api/master/projects', {
        data: { code: `E2E-T15-${tag}`, name: '东区泵站水闸更新工程', orgId: shId },
      }),
      201,
    );
    const ct = await json<{ id: number; contractNo: string }>(
      await request.post('/api/contracts', {
        data: {
          contractNo: `HT-T15-${tag}`,
          externalNoExempt: true,
          name: '东区泵站控制阀采购合同',
          orgId: shId,
          projectId: prj.id,
          originalAmount: '60000.00',
        },
      }),
      201,
    );

    // AC-T15-01: 两笔 30 天内采购类小额报销 (18000 + 16000 = 34000 >= 30000) 触发拆单预警与 PW_14 线索
    const c1 = await json<{ id: number; reviewVersion: number }>(
      await request.post('/api/expense/claims', {
        data: {
          claimNo: `BX-T15-A-${tag}`,
          orgId: shId,
          applicant: '陈工',
          expenseType: `泵阀备件-${tag}`,
          amount: '18000.00',
          occurredDate: '2026-08-05',
          contractId: ct.id,
          isProcurementExpense: true,
          description: '泵阀备件首批小额采购',
          lines: [{ expenseType: `泵阀备件-${tag}`, amount: '18000.00', invoiceNo: `INV-A-${tag}`, invoiceDate: '2026-08-05' }],
        },
      }),
      201,
    );
    await json(await request.post(`/api/expense/claims/${c1.id}/submit`, { data: { expectedReviewVersion: c1.reviewVersion } }));

    const c2 = await json<{ id: number; claimNo: string; reviewVersion: number }>(
      await request.post('/api/expense/claims', {
        data: {
          claimNo: `BX-T15-B-${tag}`,
          orgId: shId,
          applicant: '陈工',
          expenseType: `泵阀备件-${tag}`,
          amount: '16000.00',
          occurredDate: '2026-08-15',
          contractId: ct.id,
          isProcurementExpense: true,
          description: '泵阀备件次批小额采购',
          lines: [{ expenseType: `泵阀备件-${tag}`, amount: '16000.00', invoiceNo: `INV-B-${tag}`, invoiceDate: '2026-08-15' }],
        },
      }),
      201,
    );
    await json(await request.post(`/api/expense/claims/${c2.id}/submit`, { data: { expectedReviewVersion: c2.reviewVersion } }));

    await expect
      .poll(async () => {
        const detail = await json<{ status: string; splitAlertHit?: boolean }>(await request.get(`/api/expense/claims/${c2.id}`));
        return detail.status === 'audited' && Boolean(detail.splitAlertHit);
      }, { timeout: 15_000 })
      .toBe(true);

    await login(page);
    await page.goto(`/expense?keyword=${encodeURIComponent(c2.claimNo)}`);
    await expect(page.getByText('缺比价').first()).toBeVisible();
    await expect(page.getByText('疑似连续30日拆单规避3万元限额').first()).toBeVisible();

    // AC-T15-03: 项目全景合同页签可见挂接合同，且风险扫描后可从项目全景直跳合同
    await page.goto(`/projects/${prj.id}?tab=contracts`);
    await expect(page.getByRole('link', { name: ct.contractNo })).toBeVisible();

    // AC-T15-02: 导入并激活 2026-08 期间 EAS 三表（含 2202 负余额与 1604 零发生遗留），核验第 5 页签对账与备注保存
    const voucherCsv = [
      '公司,期间,凭证日期,凭证号,分录号,科目编码,科目名称,摘要,借方金额,贷方金额,项目编码,项目名称,部门,供应商',
      '上海公司,2026-08,2026-08-10,记-01,1,220201,应付账款,预付供应商款项,12000,0,,,,东区机电设备商',
      '上海公司,2026-08,2026-08-10,记-01,2,100201,银行存款,银行划款,0,12000,,,,',
    ].join('\n');
    const balanceCsv = [
      '公司,期间,科目编码,科目名称,期初借方,期初贷方,本期借方,本期贷方,期末借方,期末贷方,项目编码,项目名称,部门,供应商',
      `上海公司,2026-08,160401,在建工程,500000,0,0,0,500000,0,${prj.code},东区泵站水闸更新工程,,`,
      '上海公司,2026-08,220201,应付账款,0,0,12000,0,12000,0,,,,东区机电设备商',
      '上海公司,2026-08,100201,银行存款,0,500000,0,12000,0,512000,,,,',
    ].join('\n');
    const auxCsv = [
      '公司,期间,辅助类型,辅助编码,辅助名称,科目编码,科目名称,期初余额,借方金额,贷方金额,期末余额,供应商',
      `上海公司,2026-08,项目,${prj.code},东区泵站水闸更新工程,160401,在建工程,500000,0,0,500000,`,
      '上海公司,2026-08,供应商,SUP-T15-01,东区机电设备商,220201,应付账款,0,12000,0,12000,东区机电设备商',
    ].join('\n');

    const vBatch = await json<{ id: number }>(
      await request.post('/api/eas/import', {
        multipart: {
          orgId: String(shId),
          period: '2026-08',
          dataType: 'voucher',
          file: { name: 'vou-202608.csv', mimeType: 'text/csv', buffer: Buffer.from(voucherCsv, 'utf8') },
        },
      }),
      201,
    );
    const bBatch = await json<{ id: number }>(
      await request.post('/api/eas/import', {
        multipart: {
          orgId: String(shId),
          period: '2026-08',
          dataType: 'balance',
          file: { name: 'bal-202608.csv', mimeType: 'text/csv', buffer: Buffer.from(balanceCsv, 'utf8') },
        },
      }),
      201,
    );
    const aBatch = await json<{ id: number }>(
      await request.post('/api/eas/import', {
        multipart: {
          orgId: String(shId),
          dataType: 'auxiliary',
          file: { name: 'aux-202608.csv', mimeType: 'text/csv', buffer: Buffer.from(auxCsv, 'utf8') },
        },
      }),
      201,
    );
    const set = await json<{ id: number; version: number }>(
      await request.post('/api/eas/precheck', {
        data: { orgId: shId, period: '2026-08', batchIds: [vBatch.id, bBatch.id, aBatch.id] },
      }),
      201,
    );
    await json(await request.post(`/api/eas/sets/${set.id}/activate`, { data: { expectedVersion: set.version, expectedCurrentSetId: null } }));

    await page.goto(`/eas?orgId=${shId}&period=2026-08&tab=contract_recon`);
    await expect(page.getByText(/东区机电设备商/).first()).toBeVisible();
    await expect(page.getByRole('link', { name: '东区泵站水闸更新工程' }).first()).toBeVisible();

    await page.getByRole('button', { name: '登记核对说明' }).first().click();
    const modal = page.getByRole('dialog', { name: /登记核对说明/ });
    await modal.getByLabel('关联核销/挂账凭证号(可选)').fill('记-202608-009');
    await modal.getByLabel('核对处理说明').fill('已核对账龄与竣工状态，安排下月清理');
    await modal.getByRole('button', { name: /确\s*定/ }).click();
    await expect(page.getByText('已核对账龄与竣工状态，安排下月清理').first()).toBeVisible();
  });
});
