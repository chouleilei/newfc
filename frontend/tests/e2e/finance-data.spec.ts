import path from 'path';
import type { Locator, Page } from '@playwright/test';
import { expect, login, test } from './access';

/**
 * T-3 界面链路:AC-F10 财报导入→预览→激活→总览(金额以十进制字符串排版)、AC-F19 标准报表冻结生成与导出、
 * AC-F05 EAS 期间预检、AC-F06 治理扫描、AC-F14 管理会计维度与八个页签。
 */
const OK = /确\s*定|OK/;

async function pickOrg(page: Page, scope: Locator | Page, name: string) {
  await scope.locator('.ant-select').filter({ has: page.getByRole('combobox', { name: '组织' }) }).first().click();
  const dropdown = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').last();
  await dropdown.locator('.ant-select-tree-title', { hasText: name }).first().click();
  await expect(dropdown).toBeHidden();
}

test.describe('财务数据与管理会计页面', () => {
  test('财报:导入四表模板,激活后总览与标准报表摘要一致', async ({ page }) => {
    await login(page);
    await page.goto('/statements');
    await page.getByRole('tab', { name: '导入' }).click();
    const panel = page.locator('.ant-tabs-tabpane-active');
    await pickOrg(page, panel, '上海公司');
    await panel.locator('input[type=file]').setInputFiles(path.resolve('../backend/tests/fixtures/statements/statement-sample.xlsx'));
    await panel.getByRole('button', { name: /预\s*览/ }).click();
    await expect(panel.getByText('可导入')).toBeVisible();
    await expect(panel.getByText('1,000,000.00').first()).toBeVisible();
    await panel.getByRole('button', { name: '确认导入' }).click();
    await expect(page.getByText(/已导入批次 #\d+|同一文件已导入过/)).toBeVisible();

    await page.getByRole('tab', { name: '批次' }).click();
    const row = page.locator('.ant-tabs-tabpane-active tr', { hasText: 'statement-sample.xlsx' }).first();
    await expect(row).toContainText('上海公司');
    if (await row.getByText('激活').count()) {
      await row.getByText('激活').click();
      await page.locator('.ant-popover:not(.ant-popover-hidden)').getByRole('button', { name: OK }).click();
      await expect(page.getByText('已激活为当前批次')).toBeVisible();
    }

    await page.getByRole('tab', { name: '总览' }).click();
    const overview = page.locator('.ant-tabs-tabpane-active');
    await expect(overview.getByText('1,000,000.00').first()).toBeVisible();
    await expect(overview.getByText('42.00%').first()).toBeVisible();

    await page.goto('/standard-reports');
    await page.getByRole('button', { name: '生成报表' }).click();
    const dialog = page.getByRole('dialog', { name: '生成标准报表' });
    await dialog.locator('.ant-form-item').filter({ has: page.locator('label', { hasText: '报表类型' }) }).locator('.ant-select-selector').click();
    const typeDropdown = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').last();
    await typeDropdown.locator('.ant-select-item-option', { hasText: '财务报表摘要' }).click();
    await expect(typeDropdown).toBeHidden();
    await pickOrg(page, dialog, '上海公司');
    await dialog.getByRole('button', { name: OK }).click();
    await expect(page.getByText('报表已生成并冻结')).toBeVisible();
    const drawer = page.locator('.ant-drawer-content');
    await expect(drawer.getByText('待复核')).toBeVisible();
    await expect(drawer.getByText('1,000,000.00').first()).toBeVisible();
    const download = page.waitForEvent('download');
    await drawer.getByRole('button', { name: '导出 Excel' }).click();
    expect((await download).suggestedFilename()).toMatch(/\.xlsx$/);
  });

  test('EAS:导入 V600 三件套→预检警告→配置辅助要求→预检通过→激活;治理扫描;管理会计页签', async ({ page, request }) => {
    // EAS 文件按「公司」列匹配组织:夹具补建澧水公司(重复运行时复用)。
    const tree = (await (await request.get('/api/org/tree')).json() as { rows: { id: number; name: string }[] }).rows;
    if (!tree.some((o) => o.name === '澧水公司')) expect((await request.post('/api/org', { data: { code: 'LS', name: '澧水公司' } })).status()).toBe(201);

    await login(page);
    await page.goto('/eas');
    for (const name of ['期间工作台', '锁后更正', '期间锁', '辅助核算要求']) await expect(page.getByRole('tab', { name })).toBeVisible();
    const panel = page.locator('.ant-tabs-tabpane-active');
    await pickOrg(page, panel, '澧水公司');
    await panel.getByPlaceholder('期间').click();
    await panel.getByPlaceholder('期间').fill('2026-05');
    await page.keyboard.press('Enter');
    await expect(panel.getByPlaceholder('期间')).toHaveValue('2026-05');

    const dir = path.resolve('../backend/tests/fixtures/eas-v600');
    for (const [label, file, rows] of [['凭证序时簿', 'eas_voucher.csv', 6], ['科目余额表', 'eas_balance.csv', 4], ['辅助核算余额', 'eas_auxiliary.csv', 4]] as const) {
      await panel.locator('.ant-select').filter({ hasText: /凭证序时簿|科目余额表|辅助核算余额/ }).click();
      await page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden) .ant-select-item-option', { hasText: label }).click();
      const done = page.waitForResponse((r) => r.url().includes('/api/eas/import') && r.request().method() === 'POST');
      await panel.locator('input[type=file]').setInputFiles(path.join(dir, file));
      const resp = await done;
      expect(resp.status(), await resp.text()).toBeLessThan(300);
      await expect(panel.locator('tr', { hasText: file }).first()).toContainText(String(rows));
    }

    const runPrecheck = async () => {
      const done = page.waitForResponse((r) => r.url().endsWith('/api/eas/precheck'));
      await panel.getByRole('button', { name: '运行预检' }).click();
      const resp = await done;
      expect(resp.status(), await resp.text()).toBe(201);
      return (await resp.json()) as { id: number; status: string };
    };
    // 首期没有上期余额(连续性 warning);未配置 220201×项目 要求时辅助核算为 warning。
    const first = await runPrecheck();
    await expect(page.getByText(/预检完成:/)).toBeVisible();

    if (first.status !== 'passed') {
      await page.getByRole('tab', { name: '辅助核算要求' }).click();
      await pickOrg(page, page.locator('.ant-tabs-tabpane-active'), '澧水公司');
      const aux = page.locator('.ant-tabs-tabpane-active');
      if (!(await aux.locator('tr', { hasText: '220201' }).count())) {
        await aux.getByPlaceholder('科目编码,如 220201').fill('220201');
        await aux.getByPlaceholder('辅助类型,如 项目').fill('项目');
        await aux.getByRole('button', { name: '添加要求' }).click();
        await expect(aux.locator('tr', { hasText: '220201' })).toBeVisible();
      }
      await page.getByRole('tab', { name: '期间工作台' }).click();
      const second = await runPrecheck();
      expect(second.status).toBe('passed');
    }
    const setRow = panel.locator('tr', { hasText: '通过' }).filter({ hasText: '辅助核算余额' }).first();
    if (await setRow.getByText('激活').count()) {
      await setRow.getByText('激活').click();
      await page.locator('.ant-popover:not(.ant-popover-hidden)').getByRole('button', { name: OK }).click();
      await expect(page.getByText('已激活为当前集合')).toBeVisible();
    }
    await expect(panel.locator('tr').filter({ hasText: '当前' }).first()).toContainText('通过');

    await page.goto('/governance');
    await page.getByRole('button', { name: '扫描问题' }).click();
    await expect(page.getByText(/扫描完成:新增 \d+/)).toBeVisible();

    const code = `E2E${Date.now().toString(36).toUpperCase()}`;
    await page.goto('/mgmt?tab=dimensions');
    await page.getByRole('button', { name: '新建维度' }).click();
    const dialog = page.getByRole('dialog', { name: '新建维度' });
    await dialog.getByLabel('编码').fill(code);
    await dialog.getByLabel('名称').fill('端到端维度');
    await dialog.getByRole('button', { name: OK }).click();
    await expect(page.locator('tr', { hasText: code })).toContainText('启用');

    for (const name of ['责任中心', '指标与计算', '预警', '成本分摊', '预算调整', '多维分析', '维度', '绩效']) {
      await page.getByRole('tab', { name }).click();
      await expect(page.locator('.ant-tabs-tabpane-active')).toBeVisible();
      await expect(page.locator('.ant-result-error')).toHaveCount(0);
    }
    await expect(page).toHaveURL(/tab=performance/);
  });
});
