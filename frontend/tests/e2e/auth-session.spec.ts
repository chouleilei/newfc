import { ACCESS_PASSWORD, ACCESS_USER, expect, test } from './access';

/** AC-F01 界面链路:登录页 → 首页 → 登出回到登录页;错误口令给出提示;无会话访问深链接先登录。 */
test.describe('登录与会话', () => {
  // 本用例在界面上新建会话:不带 worker 会话的 Cookie 与 CSRF 头,CSRF 完全由 SPA 自己附带
  test.use({ storageState: { cookies: [], origins: [] }, extraHTTPHeaders: {} });

  test('错误口令提示,正确口令进入首页,退出后回到登录页', async ({ page }) => {
    await page.goto('/analysis');
    await expect(page.getByRole('button', { name: '登 录' })).toBeVisible();
    await page.getByPlaceholder('用户名').fill(ACCESS_USER);
    await page.getByPlaceholder('密码').fill('definitely-wrong-pw');
    await page.getByRole('button', { name: '登 录' }).click();
    await expect(page.getByText('用户名或口令错误')).toBeVisible();

    await page.getByPlaceholder('密码').fill(ACCESS_PASSWORD);
    await page.getByRole('button', { name: '登 录' }).click();
    await expect(page.getByText('首页').first()).toBeVisible();
    // 会话令牌只在 HttpOnly Cookie 中,脚本读不到,本地存储也不保存
    expect(await page.evaluate(() => document.cookie)).not.toContain('newfc_session');
    expect(await page.evaluate(() => JSON.stringify(localStorage))).not.toMatch(/[a-f0-9]{64}/);

    await page.getByRole('button', { name: /当前登录/ }).click();
    await page.getByText('退出登录').click();
    await expect(page.getByRole('button', { name: '登 录' })).toBeVisible();
    const after = await page.request.get('/api/auth/session');
    expect(after.status()).toBe(401);
  });
});
