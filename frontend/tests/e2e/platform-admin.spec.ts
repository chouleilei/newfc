import { expect, login, test } from './access';

/** T-1 界面链路:AC-F07 项目主数据、AC-F23 业务设置(凭据不回显)、AC-F21 任务中心。 */
test.describe('平台基础页面', () => {
  test('新建项目并在列表中看到归属组织', async ({ page }) => {
    const code = `P-E2E-${Date.now().toString(36).toUpperCase()}`;
    await login(page);
    await page.goto('/master-entities');
    await page.getByRole('button', { name: '新建项目' }).click();
    const dialog = page.getByRole('dialog', { name: '新建项目' });
    await dialog.getByLabel('项目编码').fill(code);
    await dialog.getByLabel('项目名称').fill('端到端测试项目');
    await dialog.getByLabel('归属组织').click();
    await page.locator('.ant-select-tree-title', { hasText: '上海公司' }).click();
    await dialog.getByRole('button', { name: /确\s*定|OK/ }).click();
    await expect(page.getByText('已保存')).toBeVisible();
    const row = page.locator('tr', { hasText: code });
    await expect(row).toContainText('上海公司');
    await expect(row).toContainText('启用');
  });

  test('业务设置:保存后回显;凭据只显示末 4 位', async ({ page }) => {
    const secret = `e2e-ocr-${Date.now()}-k9z2`;
    await login(page);
    await page.goto('/settings/business');
    const nameRow = page.locator('tr', { hasText: '报表单位名称' });
    await nameRow.locator('input').fill('端到端测试单位');
    await page.locator('tr', { hasText: 'OCR 服务密钥' }).locator('input').fill(secret);
    await page.getByRole('button', { name: /保\s*存/ }).click();
    await expect(page.getByText('设置已保存')).toBeVisible();
    await page.reload();
    await expect(page.locator('tr', { hasText: '报表单位名称' }).locator('input')).toHaveValue('端到端测试单位');
    await expect(page.locator('tr', { hasText: 'OCR 服务密钥' })).toContainText('已配置 ****k9z2');
    expect(await page.content()).not.toContain(secret);
  });

  test('任务中心可见后台任务与模型调用两个视图', async ({ page }) => {
    await login(page);
    await page.goto('/jobs');
    await expect(page.getByRole('tab', { name: '后台任务' })).toBeVisible();
    await page.getByRole('tab', { name: '模型调用' }).click();
    await expect(page.getByText('不保存提示词与回答正文')).toBeVisible();
  });
});
