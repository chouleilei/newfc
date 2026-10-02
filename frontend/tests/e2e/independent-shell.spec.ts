import { expect, test } from './access';

test('独立品牌、领域导航、默认折叠与深链', async ({ page }) => {
  await page.goto('/');
  const nav = page.getByRole('navigation', { name: '主导航' });
  const expanded = nav.locator('.ant-menu-submenu-title[aria-expanded="true"]');
  await expect(nav).toBeVisible();
  await expect(page).toHaveTitle('newfc 水利财务分析');
  await expect(page.locator('.newfc-sider')).toContainText('水利财务分析');
  await expect(page.locator('.newfc-sider')).not.toContainText('年度预算管理');
  await expect(nav.locator('.ant-menu-submenu-title').filter({ hasText: '财务助手' })).toHaveCount(1);
  expect(await page.locator('html').evaluate((el) => getComputedStyle(el).getPropertyValue('--newfc-bg-layout').trim())).toBe('#f6f3ee');
  await expect(expanded).toHaveCount(0);
  await expect(page.locator('.newfc-header')).not.toContainText('单位: 万元');
  await expect(page.getByTestId('domain-overview-card')).toBeVisible();
  await page.screenshot({ path: '/tmp/newfc-independent-shell-desktop.png' });

  const budget = nav.locator('.ant-menu-submenu-title').filter({ hasText: '经营预算' });
  const finance = nav.locator('.ant-menu-submenu-title').filter({ hasText: '财务数据' });
  await budget.click();
  await expect(expanded).toHaveCount(1);
  await expect(nav.getByText('预算与预测', { exact: true })).toBeVisible();
  await expect(nav.getByText('实际录入与快照', { exact: true })).toBeVisible();
  await expect(nav.getByText('年度执行分析', { exact: true })).toBeVisible();
  await finance.click();
  await expect(expanded).toHaveCount(1);
  await expect(budget).toHaveAttribute('aria-expanded', 'false');
  await finance.click();
  await expect(expanded).toHaveCount(0);

  await page.goto('/analysis');
  await expect(expanded).toHaveCount(1);
  await expect(budget).toHaveAttribute('aria-expanded', 'true');
  await expect(nav.locator('.ant-menu-item-selected')).toContainText('年度执行分析');
  await expect(page.locator('.newfc-header')).toContainText('单位: 万元');

  await page.goto('/contracts');
  await expect(expanded).toHaveCount(1);
  await expect(nav.locator('.ant-menu-item-selected')).toContainText('合同台账');
  await expect(page.locator('.newfc-header')).not.toContainText('单位: 万元');
  await expect(budget).toHaveAttribute('aria-expanded', 'false');

  await page.goto('/search?q=项目');
  await expect(page.locator('.newfc-header')).toContainText('跨域检索');
  await expect(expanded).toHaveCount(0);
  await expect(nav.locator('.ant-menu-item-selected')).toHaveCount(0);

  await page.goto('/data?tab=calculations');
  await expect(budget).toHaveAttribute('aria-expanded', 'true');
  await expect(nav.locator('.ant-menu-item-selected')).toContainText('预算与预测');
  await expect(page.locator('.newfc-header')).toContainText('测算模板');
});

test('桌面暗色与手机导航可用', async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('navigation', { name: '主导航' })).toBeVisible();
  await expect(page.getByTestId('domain-overview-card')).toBeVisible();
  await page.getByRole('button', { name: '切换主题' }).click();
  await expect(page.locator('html')).toHaveAttribute('data-theme', 'dark');
  expect(await page.locator('html').evaluate((el) => getComputedStyle(el).getPropertyValue('--newfc-bg-layout').trim())).toBe('#1c1914');
  await page.screenshot({ path: '/tmp/newfc-independent-shell-dark.png' });
  await page.getByRole('button', { name: '切换主题' }).click();
  await page.setViewportSize({ width: 390, height: 844 });
  await expect(page.locator('.newfc-sider')).toHaveClass(/ant-layout-sider-collapsed/);
  const account = page.getByRole('button', { name: /当前登录/ });
  await expect(account).toBeVisible();
  await page.screenshot({ path: '/tmp/newfc-independent-shell-mobile.png' });
  const bounds = await account.boundingBox();
  expect(bounds).not.toBeNull();
  expect(bounds!.x + bounds!.width).toBeLessThanOrEqual(390);
  const widths = await page.evaluate(() => ({ content: document.documentElement.scrollWidth, viewport: window.innerWidth }));
  expect(widths.content).toBeLessThanOrEqual(widths.viewport);
  await account.click();
  await expect(page.getByText('退出登录', { exact: true })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.locator('.newfc-header').getByRole('button', { name: '跨域检索', exact: true }).click();
  await expect(page).toHaveURL(/\/search$/);
  await expect(page.locator('.newfc-header')).toContainText('跨域检索');
  const input = page.getByRole('searchbox', { name: '检索关键词' });
  await expect(input).toBeVisible();
  const searchBounds = await page.locator('.newfc-search-controls').boundingBox();
  expect(searchBounds!.x + searchBounds!.width).toBeLessThanOrEqual(390);
});

test('同一标签页切换同名账号,重新查询业务数据且不共用收藏', async ({ request, browser }, testInfo) => {
  const roles = (await (await request.get('/api/security/roles')).json()).items as { id: number; code: string }[];
  const analyst = roles.find((role) => role.code === 'finance_analyst')!;
  const password = 'Vt9-shell-account-pw';
  const suffix = Date.now().toString(36);
  const usernames = [`shell-first-${suffix}`, `shell-second-${suffix}`];
  for (const username of usernames) {
    const res = await request.post('/api/security/users', { data: { username, displayName: '财务人员', password, roleIds: [analyst.id], allOrgs: true, mustChangePassword: false } });
    expect(res.status()).toBe(201);
  }
  const context = await browser.newContext({ baseURL: String(testInfo.project.use.baseURL), storageState: { cookies: [], origins: [] }, extraHTTPHeaders: {} });
  try {
    const page = await context.newPage();
    await page.goto('/');
    const signIn = async (username: string) => {
      await page.getByPlaceholder('用户名').fill(username);
      await page.getByPlaceholder('密码').fill(password);
      await page.getByRole('button', { name: '登 录' }).click();
      await expect(page.getByRole('button', { name: /当前登录 财务人员/ })).toBeVisible();
    };
    await signIn(usernames[0]);
    await expect(page.getByTestId('domain-overview-card')).toBeVisible();
    await page.getByRole('button', { name: '收藏本页', exact: true }).click();
    await expect(page.getByRole('button', { name: '取消收藏本页', exact: true })).toBeVisible();
    await page.getByRole('button', { name: /当前登录/ }).click();
    await page.getByText('退出登录', { exact: true }).click();
    await expect(page.getByRole('button', { name: '登 录' })).toBeVisible();
    const freshDashboard = page.waitForResponse((response) => response.url().endsWith('/api/dashboard') && response.status() === 200);
    await signIn(usernames[1]);
    await freshDashboard;
    await expect(page.getByRole('button', { name: '收藏本页', exact: true })).toBeVisible();
    await expect(page.getByRole('navigation', { name: '主导航' }).locator('.ant-menu-submenu-title').filter({ hasText: '收藏' })).toHaveCount(0);
  } finally {
    await context.close();
  }
});


test('另一标签页切换账号后,旧表单不会用新账号自动提交', async ({ request, browser }, testInfo) => {
  const roles = (await (await request.get('/api/security/roles')).json()).items as { id: number; code: string }[];
  const writer = roles.find((role) => role.code === 'data_maintainer')!;
  expect(writer).toBeTruthy();
  const password = 'Vt9-cross-tab-pw'; const suffix = Date.now().toString(36);
  const users = [`tab-a-${suffix}`, `tab-b-${suffix}`]; const supplier = `旧账号表单-${suffix}`;
  for (const username of users) {
    const response = await request.post('/api/security/users', { data: { username, displayName: username, password, roleIds: [writer.id], allOrgs: true, mustChangePassword: false } });
    expect(response.status()).toBe(201);
  }
  const context = await browser.newContext({ baseURL: String(testInfo.project.use.baseURL), storageState: { cookies: [], origins: [] }, extraHTTPHeaders: {} });
  try {
    const first = await context.newPage();
    await first.goto('/');
    await first.getByPlaceholder('用户名').fill(users[0]); await first.getByPlaceholder('密码').fill(password);
    await first.getByRole('button', { name: '登 录' }).click();
    await expect(first.getByRole('button', { name: /当前登录/ })).toBeVisible();
    await first.goto('/master-entities?tab=suppliers');
    await first.getByRole('button', { name: '新建供应商', exact: true }).click();
    await first.getByLabel('供应商名称', { exact: true }).fill(supplier);
    const second = await context.newPage(); await second.goto('/');
    await second.getByRole('button', { name: /当前登录/ }).click(); await second.getByText('退出登录', { exact: true }).click();
    await second.getByPlaceholder('用户名').fill(users[1]); await second.getByPlaceholder('密码').fill(password);
    await second.getByRole('button', { name: '登 录' }).click();
    await expect(second.getByRole('button', { name: new RegExp(`当前登录 ${users[1]}`) })).toBeVisible();
    const writes: number[] = [];
    first.on('response', (response) => { if (response.url().endsWith('/api/master/suppliers') && response.request().method() === 'POST') writes.push(response.status()); });
    await first.getByRole('dialog').getByRole('button', { name: '确 定' }).click();
    await expect(first.getByRole('button', { name: '登 录' })).toBeVisible();
    expect(writes).toEqual([403]);
    const suppliers = await (await request.get(`/api/master/suppliers?keyword=${encodeURIComponent(supplier)}`)).json();
    expect(suppliers).toEqual([]);
    await expect(first.getByRole('dialog')).toHaveCount(0);
    await expect(second.getByRole('button', { name: new RegExp(`当前登录 ${users[1]}`) })).toBeVisible();
  } finally { await context.close(); }
});
