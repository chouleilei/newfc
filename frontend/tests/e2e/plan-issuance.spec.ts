import { createRequire } from 'node:module';
import type { Locator, Page } from '@playwright/test';
import { expect, login, test } from './access';

const require = createRequire(import.meta.url);
const XLSX = require('../../../backend/node_modules/xlsx') as typeof import('xlsx');

const OK = /确\s*[定认]|OK/;

async function pickAntSelect(page: Page, scope: Locator | Page, label: string, optionText: string | RegExp) {
  const nameRe = new RegExp('^(\\*\\s*)?' + label.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '$');
  await scope.locator('.ant-select').filter({ has: page.getByRole('combobox', { name: nameRe }) }).first().click();
  const dropdown = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').last();
  await dropdown.locator('.ant-select-item-option', { hasText: optionText }).first().click();
  await expect(dropdown).toBeHidden();
}

function buildSyntheticPlanWorkbook(unitAName: string, unitBName: string): Buffer {
  const wb = XLSX.utils.book_new();
  const investRows = [
    ['2026年度固定资产投资计划表 单位：元'],
    ['序号', '项目名称', '项目总投资', '已完成投资', '2026年计划投资', '承办单位'],
    ['1', '示范梯级泄洪闸自动化升级', 8000000, 2000000, 3000000, unitAName],
    ['2', '示范园区分布式光伏接入', 4000000, 500000, 1500000, unitBName],
  ];
  const purchaseRows = [
    ['2026年固定资产购置计划表 单位：元'],
    ['序号', '设备名称', '年度计划', '年度实际', '承办单位'],
    ['1', '水轮机在线振动监测终端', 500000, 100000, unitAName],
    ['2', '升压站巡检红外热像仪', 300000, 50000, unitBName],
  ];
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(investRows), '固定资产投资计划');
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(purchaseRows), '固定资产购置计划');
  return XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;
}

test.describe('T-14 年度综合计划与预算合一下达、分单位签收、联动调整与公文导出闭环 (AC-T14-02~05)', () => {
  test('创建周期→勾稽核对→正式发布→全包.zip下载→受限单位只读预算/签收/.docx下载/越权404→发起调整与异人复核生成修订周期', async ({
    page,
    request,
    browser,
  }, testInfo) => {
    const stamp = Date.now().toString(36).toUpperCase();
    const orgTree = (await (await request.get('/api/org/tree')).json()) as {
      rows: { id: number; code: string; name: string }[];
    };
    const rootOrg = orgTree.rows.find((o) => o.code === 'GROUP')!;

    // 在集团根下创建两个独立脱敏一级下达单元
    const unitAName = `甲级水电运营单元${stamp}`;
    const unitBName = `乙级新能源开发单元${stamp}`;
    const unitA = await (
      await request.post('/api/org', {
        data: { parentId: rootOrg.id, code: `U1A_${stamp}`, name: unitAName },
      })
    ).json();
    const unitB = await (
      await request.post('/api/org', {
        data: { parentId: rootOrg.id, code: `U1B_${stamp}`, name: unitBName },
      })
    ).json();

    // 创建只授权 unitA 的受限下属单位账号（data_maintainer 含 budget:read / budget:write / plan:read / plan:write）
    const roles = (
      (await (await request.get('/api/security/roles')).json()) as {
        items: { id: number; code: string }[];
      }
    ).items;
    const maintainerRole = roles.find((r) => r.code === 'data_maintainer')!;
    const unitUsername = `e2e-unit-a-${stamp.toLowerCase()}`;
    const unitPassword = 'Vt9-plan-unit-pw';
    const createdUser = await request.post('/api/security/users', {
      data: {
        username: unitUsername,
        password: unitPassword,
        roleIds: [maintainerRole.id],
        orgIds: [unitA.id],
        mustChangePassword: false,
      },
    });
    expect(createdUser.status(), await createdUser.text()).toBe(201);

    // 准备 2026 经营预算版本与 2026 综合计划生效批次
    const bvName = `2026合一下达预算_${stamp}`;
    const bvRes = await request.post('/api/versions', {
      data: { year: 2026, name: bvName, kind: 'budget' },
    });
    expect(bvRes.status(), await bvRes.text()).toBe(201);
    const bv = await bvRes.json();

    const currentPlanBatches = (await (await request.get('/api/plan/batches?year=2026')).json()) as {
      id: number;
      isCurrent: boolean;
    }[];
    const prevCurrentId = currentPlanBatches.find((b) => b.isCurrent)?.id ?? null;
    const impRes = await request.post('/api/plan/import', {
      multipart: {
        year: '2026',
        actualPeriod: '2026-06',
        file: {
          name: `plan-issuance-${stamp}.xlsx`,
          mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
          buffer: buildSyntheticPlanWorkbook(unitAName, unitBName),
        },
      },
    });
    expect(impRes.status(), await impRes.text()).toBe(201);
    const planBatch = await impRes.json();
    const actRes = await request.post(`/api/plan/batches/${planBatch.id}/activate`, {
      data: { expectedCurrentBatchId: prevCurrentId },
    });
    expect(actRes.status(), await actRes.text()).toBe(200);

    // 1) 全域管理员在 /plan?tab=cycles 创建合一下达周期 → 运行稽核 → 正式发布 → 下载全集团 .zip
    await login(page);
    await page.goto('/plan?tab=cycles');
    await page.getByRole('button', { name: '创建下达周期' }).click();
    const cycleCode = `CYC-2026-${stamp}`;
    const createDlg = page.getByRole('dialog');
    await createDlg.getByLabel('周期编码').fill(cycleCode);
    await pickAntSelect(page, createDlg, '关联经营预算版本', bvName);
    await createDlg.getByLabel('发文字号前缀').fill(`集团企〔2026〕${stamp}`);
    await createDlg.getByRole('button', { name: OK }).click();
    await expect(createDlg).toBeHidden();
    await expect(page.getByText(new RegExp(cycleCode)).first()).toBeVisible();

    await page.getByRole('button', { name: '运行合并与税率/五项费用稽核' }).click();
    const publishBtn = page.getByRole('button', { name: '正式发布下达' });
    await expect(publishBtn).toBeEnabled();
    await publishBtn.click();
    await page.locator('.ant-modal-confirm').getByRole('button', { name: '确认发布下达' }).click();
    await expect(page.getByText('已正式下达').first()).toBeVisible();

    const zipDownloadPromise = page.waitForEvent('download');
    await page.getByRole('button', { name: /打包下载全集团下达公文包/ }).click();
    const zipDownload = await zipDownloadPromise;
    expect(zipDownload.suggestedFilename()).toMatch(/\.zip$/);

    // 查询周期下各单元包 ID，供越权 404 校验
    const allPacks = (
      (await (await request.get('/api/plan/issuance/packs?year=2026')).json()) as {
        items: { id: number; unitOrgId: number; unitOrgName: string }[];
      }
    ).items;
    const unitAPack = allPacks.find((p) => p.unitOrgId === unitA.id)!;
    const unitBPack = allPacks.find((p) => p.unitOrgId === unitB.id)!;
    expect(unitAPack).toBeTruthy();
    expect(unitBPack).toBeTruthy();

    // 2) 下属单位受限用户登录：只读查看本单位预算、仅见本单位包、跨单位包 404、导出 .docx、确认签收并发起调整申请
    const unitCtx = await browser.newContext({
      baseURL: String(testInfo.project.use.baseURL),
      storageState: { cookies: [], origins: [] },
      extraHTTPHeaders: {},
    });
    const unitPage = await unitCtx.newPage();
    await unitPage.goto('/');
    await unitPage.getByPlaceholder('用户名').fill(unitUsername);
    await unitPage.getByPlaceholder('密码').fill(unitPassword);
    await unitPage.getByRole('button', { name: '登 录' }).click();
    await expect(unitPage.getByText('首页').first()).toBeVisible();

    // 验证 /budget 本单位只读预算视图：无全域创建/模板维护入口
    await unitPage.goto('/budget');
    await expect(unitPage.getByText('本单位已下达经营预算只读视图')).toBeVisible();
    await expect(unitPage.getByRole('button', { name: '创建版本' })).toHaveCount(0);
    await expect(unitPage.getByRole('button', { name: '测算模板' })).toHaveCount(0);

    // 验证跨单位下达包接口严格 404
    const unitSession = (await (await unitPage.request.get('/api/auth/session')).json()) as { csrfToken: string };
    const unitHeaders = { 'x-csrf-token': unitSession.csrfToken };
    const crossGet = await unitPage.request.get(`/api/plan/issuance/packs/${unitBPack.id}`);
    expect(crossGet.status()).toBe(404);
    const crossAck = await unitPage.request.post(`/api/plan/issuance/packs/${unitBPack.id}/acknowledge`, {
      headers: unitHeaders,
      data: { expectedVersion: 1 },
    });
    expect(crossAck.status()).toBe(404);

    // 进入本单位下达包页签：仅见 unitA，不见 unitB；下载 .docx 公文；完成签收
    await unitPage.goto('/plan?tab=packs');
    await expect(unitPage.getByText(unitAName).first()).toBeVisible();
    await expect(unitPage.getByText(unitBName)).toHaveCount(0);

    const docxDownloadPromise = unitPage.waitForEvent('download');
    await unitPage.getByRole('button', { name: /导出下达公文及责任书/ }).first().click();
    const docxDownload = await docxDownloadPromise;
    expect(docxDownload.suggestedFilename()).toMatch(/\.docx$/);

    const unitARow = unitPage.locator('tr', { hasText: unitAName }).first();
    await unitARow.getByRole('button', { name: '确认签收' }).click();
    const ackDlg = unitPage.getByRole('dialog', { name: new RegExp(`确认签收.*${unitAName}`) });
    await ackDlg.getByLabel('签收备注（可选）').fill('本单位经营班子核对无误，正式签收执行');
    await ackDlg.getByRole('button', { name: '确认签收' }).click();
    await expect(ackDlg).toBeHidden();
    await expect(unitARow.getByText('已签收')).toBeVisible();

    // 下属单位发起总额内方案调剂申请，验证服务端锁定「总经理办公会审定」预览
    await unitPage.goto('/plan?tab=adjustments');
    await unitPage.getByRole('button', { name: '发起调整申请' }).click();
    const adjDlg = unitPage.getByRole('dialog', { name: '发起计划与预算联动调整申请' });
    await expect(adjDlg.getByText('总经理办公会审定')).toBeVisible();
    await pickAntSelect(unitPage, adjDlg, '原下达周期', cycleCode);
    await pickAntSelect(unitPage, adjDlg, '申请调整单元包', unitAName);
    await adjDlg.getByLabel('决策纪要/批复文号').fill(`集团总办纪〔2026〕${stamp}号`);
    await adjDlg.getByLabel('调整事由与预算联动说明').fill('示范梯级泄洪闸子项总额内执行调剂');
    await adjDlg.getByLabel('指标/项目名称').fill('示范梯级泄洪闸自动化升级');
    await adjDlg.getByLabel('调整前').fill('3000000.00');
    await adjDlg.getByLabel('调整后').fill('3200000.00');
    await adjDlg.getByRole('button', { name: OK }).click();
    await expect(adjDlg).toBeHidden();
    await expect(unitPage.getByText('待复核').first()).toBeVisible();
    await unitCtx.close();

    // 3) 全域管理员（异人）进入调整页签完成复核批准，验证生成新修订周期
    await page.goto('/plan?tab=adjustments');
    const adjRow = page.locator('tr', { hasText: unitAName }).first();
    await expect(adjRow.getByText('总经理办公会审定')).toBeVisible();
    await adjRow.getByRole('button', { name: /^复\s*核$/ }).click();
    const revDlg = page.getByRole('dialog', { name: /复核计划与预算调整申请/ });
    await revDlg.getByLabel('法定审定决策文号（批准必填）').fill(`集团总办批〔2026〕${stamp}号`);
    await revDlg.getByLabel('复核意见').fill('经核查符合总额内调剂规定，同意下达修订周期');
    await revDlg.getByRole('button', { name: OK }).click();
    await expect(revDlg).toBeHidden();
    await expect(adjRow.getByText('已批准')).toBeVisible();
    await expect(adjRow.getByText(/周期 #\d+/)).toBeVisible();
  });
});
