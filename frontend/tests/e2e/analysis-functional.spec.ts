
import { expect, test, login } from './access';

test('执行分析筛选口径、URL 持久化和统一报表可用', async ({ page }) => {
  const errors: string[] = [];
  page.on('pageerror', (error) => errors.push(error.message));
  page.on('response', (response) => { if (response.status() >= 500) errors.push(`${response.status()} ${response.url()}`); });
  await login(page);
  await page.goto('/analysis');

  await expect(page.getByRole('combobox', { name: '年份' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: '预算版本' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: '预算组织' })).toBeVisible();
  await expect(page.getByRole('combobox', { name: '预算表格' })).toBeVisible();
  await expect(page.getByText(/预算 \/ 实际 \/ 全年预测统一对比/)).toBeVisible();
  await expect(page.getByText('进度偏差', { exact: true }).first()).toBeVisible();
  await expect(page.getByRole('combobox', { name: '趋势指标' })).toBeVisible();

  const trendInput = page.getByRole('combobox', { name: '趋势指标' });
  await trendInput.locator('..').locator('..').click();
  const trendDropdown = page.locator('.ant-select-dropdown:visible');
  await expect(trendDropdown.getByText(/P07 总收入/)).toBeVisible();
  await expect(trendDropdown.getByText(/P06 总成本/)).toBeVisible();
  await expect(trendDropdown.getByText(/P04 利润总额/)).toBeVisible();
  await expect(trendDropdown.getByText(/C1101 制造费用/)).toBeVisible();
  await trendInput.fill('E201');
  await expect(trendDropdown.getByText(/E201 人工成本（含资本化人工）/)).toBeVisible();
  await trendInput.fill('销售费用');
  await expect(trendDropdown.getByText(/E1 销售费用/)).toHaveCount(0);
  await trendInput.fill('P06');
  await trendDropdown.getByText(/P06 总成本/).click();
  await expect(page).toHaveURL(/trend=metric%3A\d+/);
  await expect(page.locator('.ant-select-selection-item[title^="P06 总成本"]')).toBeVisible();

  await page.getByRole('combobox', { name: '预算表格' }).locator('..').locator('..').click();
  await page.getByText('一级汇总', { exact: true }).last().click();
  await expect(page).toHaveURL(/sheet=overview/);
  await expect(page.locator('.ant-select-selection-item[title="一级汇总"]')).toBeVisible();

  await page.reload();
  await expect(page.locator('.ant-select-selection-item[title="一级汇总"]')).toBeVisible();
  await expect(page.getByText(/统一对比 · 一级汇总/)).toBeVisible();
  expect(errors).toEqual([]);
});

test('执行分析移动端不产生页面级横向溢出', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await login(page);
  await page.goto('/analysis');
  // 页面标题就是这张卡片的标题(旧断言写的「预算执行情况分析」早已不在页面上)。
  await expect(page.getByText('年度执行分析', { exact: true }).first()).toBeVisible();
  // 预警卡片是报表查完才渲染的，必须等它出现再量：否则量到的是还没铺开的半成品页面，
  // 这类窄屏溢出恰恰多半出在这些后到的表格上。
  await expect(page.getByText(/成本费用超支预警/)).toBeVisible();
  await expect(page.getByText(/预算 \/ 实际 \/ 全年预测统一对比/)).toBeVisible();
  const dimensions = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 2);
  await context.close();
});
