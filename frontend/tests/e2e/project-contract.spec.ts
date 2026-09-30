import type { Locator, Page } from '@playwright/test';
import { expect, login, test } from './access';

/**
 * T-4 界面链路:AC-F04 合同导入预览→确认→台账与详情;AC-F22 报销单提交→后台审核运行(制度条款超限、材料缺失)
 * →人工复核退回补件(管理员同人例外原因)→工作台待办;AC-F09/F15 项目预算与计划执行页面空态。
 */
const OK = /确\s*定|OK/;

async function pickOrg(page: Page, scope: Locator | Page, name: string) {
  await scope.locator('.ant-select').filter({ has: page.getByRole('combobox', { name: '组织' }) }).first().click();
  const dropdown = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').last();
  await dropdown.locator('.ant-select-tree-title', { hasText: name }).first().click();
  await expect(dropdown).toBeHidden();
}

test.describe('项目、合同与费用审核页面', () => {
  test('合同导入:预览计划 → 确认写入 → 台账与详情金额', async ({ page }) => {
    const no = `E2E-HT-${Date.now()}`;
    await login(page);
    await page.goto('/contracts/import');
    const csv = `﻿合同编号,合同名称,项目编码,供应商,合同金额,已付款金额,签订日期,合同类型,责任组织,付款上限比例\n${no},E2E 泵站改造合同,,,100000,20000,2026-03-01,施工,上海公司,\n`;
    await page.locator('input[type=file]').setInputFiles({ name: 'contracts-e2e.csv', mimeType: 'text/csv', buffer: Buffer.from(csv) });
    await expect(page.getByText('新增 1 · 更新 0 · 无变化 0')).toBeVisible();
    await expect(page.locator('tr', { hasText: no })).toContainText('100,000.00');
    await page.getByRole('button', { name: '确认导入' }).click();
    await page.locator('.ant-modal-confirm').getByRole('button', { name: OK }).click();
    await expect(page.getByText('已写入:新增 1、更新 0、无变化 0')).toBeVisible();

    await page.getByRole('button', { name: '查看合同台账' }).click();
    await expect(page).toHaveURL(/\/contracts$/);
    await page.getByPlaceholder('编号或名称').fill(no);
    await page.getByPlaceholder('编号或名称').press('Enter');
    const row = page.locator('tr', { hasText: no });
    await expect(row).toContainText('履约执行');
    await expect(row).toContainText('20.00%');
    await row.click();
    const drawer = page.locator('.ant-drawer-content');
    await expect(drawer.getByText(`${no} · E2E 泵站改造合同`)).toBeVisible();
    await expect(drawer.getByText('100,000.00').first()).toBeVisible();
    await drawer.getByRole('tab', { name: /付款/ }).click();
    await expect(drawer.getByText('导入基线')).toBeVisible();
  });

  test('费用审核:提交 → 审核运行引用条款 → 退回补件 → 工作台待办', async ({ page, request }) => {
    const code = `E2E-TRAVEL-${Date.now()}`;
    const policy = await request.post('/api/expense/policies', {
      data: {
        code, title: 'E2E 差旅费管理办法', effectiveFrom: '2026-01-01',
        clauses: [{ clauseNo: '3.1', clauseText: '差旅费单次报销不超过 5,000 元,须附住宿发票', expenseTypes: ['差旅费'], limit: '5000.00', requiredKeywords: ['住宿'] }],
      },
    });
    expect(policy.status(), await policy.text()).toBe(201);

    await login(page);
    await page.goto('/expense');
    await page.getByRole('button', { name: '新建报销单' }).click();
    const dialog = page.getByRole('dialog', { name: '新建报销单' });
    await pickOrg(page, dialog, '上海公司');
    await dialog.getByLabel('申请人').fill('张三');
    await dialog.getByLabel('费用类型').fill('差旅费');
    await dialog.getByLabel('报销金额(元)').fill('6000.00');
    await dialog.getByLabel('事由').fill('E2E 赴杭州现场检查');
    await dialog.getByRole('button', { name: OK }).click();
    await expect(page.getByText(/已创建报销单 BX/)).toBeVisible();

    const drawer = page.locator('.ant-drawer-content');
    await drawer.getByRole('button', { name: '提交审核' }).click();
    await page.locator('.ant-modal-confirm').getByRole('button', { name: OK }).click();
    await expect(drawer.getByText('待复核').first()).toBeVisible({ timeout: 30_000 });
    await expect(drawer.getByText('LIMIT_EXCEEDED').first()).toBeVisible();
    await expect(drawer.getByText(`${code} v1`).first()).toBeVisible();
    await expect(drawer.getByText('MATERIAL_MISSING').first()).toBeVisible();

    await drawer.getByRole('combobox', { name: /^处置 #\d+ MATERIAL_MISSING$/ }).first().click();
    await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option', { hasText: '缺失材料' }).click();
    await drawer.locator('label.ant-radio-button-wrapper', { hasText: '退回补件' }).click();
    await drawer.getByPlaceholder('复核意见').fill('请补住宿发票');
    await drawer.getByPlaceholder(/例外原因/).fill('E2E 单人环境,管理员自审');
    await drawer.getByRole('button', { name: /提交复核/ }).click();
    await expect(page.getByText('复核已记录')).toBeVisible();
    await expect(drawer.getByText('退回补件').first()).toBeVisible();
    await expect(drawer.getByText('同人例外')).toBeVisible();

    await page.goto('/');
    const card = page.getByTestId('workbench-todo-card');
    await expect(card).toContainText('退回补件报销');
    await card.getByText('退回补件报销').click();
    await expect(page).toHaveURL(/\/expense\?status=supplement/);
    await expect(page.locator('tr', { hasText: 'E2E 赴杭州现场检查' }).first()).toBeVisible();
  });

  test('项目预算与计划执行:无当前批次时给出说明而不是空白或 0', async ({ page }) => {
    await login(page);
    await page.goto('/project-budget');
    await expect(page.getByRole('heading', { name: '导入批次' })).toBeVisible();
    await expect(page.getByRole('button', { name: '导入项目预算' })).toBeVisible();
    await page.goto('/plan');
    await expect(page.getByRole('heading', { name: '项目进度' })).toBeVisible();
    await expect(page.getByRole('button', { name: '导入计划执行' })).toBeVisible();
    await page.goto('/expense/policies');
    await expect(page.getByRole('button', { name: '新建制度依据' })).toBeVisible();
  });
});
