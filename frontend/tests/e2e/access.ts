import { expect, request as playwrightRequest, test as base, type Page } from '@playwright/test';

/**
 * E2E 登录:夹具库由 backend/scripts/e2e-user.ts 写入同名账号(默认值两边一致,
 * 需要连自己的实例时用 NEWFC_E2E_USER / NEWFC_E2E_PASSWORD 覆盖)。
 *
 * 每个 worker 经 /api/auth/login 真实登录一次,拿到 HttpOnly 会话 Cookie 与 CSRF 令牌:
 * - 浏览器上下文通过 storageState 带上 Cookie,SPA 启动时自行从 /api/auth/session 取 CSRF;
 * - `request` / `page.request` 通过 extraHTTPHeaders 附带 X-CSRF-Token,写接口走与界面相同的校验。
 * 没有任何关鉴权或测试旁路。
 */
export const ACCESS_USER = process.env.NEWFC_E2E_USER || 'e2e';
export const ACCESS_PASSWORD = process.env.NEWFC_E2E_PASSWORD || 'Vt9-playwright-local-pw';

interface WorkerSession { cookie: string; csrf: string; host: string }

export const test = base.extend<object, { workerSession: WorkerSession }>({
  workerSession: [async ({}, use, workerInfo) => {
    const baseURL = String(workerInfo.project.use.baseURL);
    const ctx = await playwrightRequest.newContext({ baseURL });
    const res = await ctx.post('/api/auth/login', { data: { username: ACCESS_USER, password: ACCESS_PASSWORD } });
    if (!res.ok()) throw new Error(`E2E 登录失败 ${res.status()}: ${await res.text()}`);
    const body = await res.json() as { csrfToken: string };
    const cookie = (await ctx.storageState()).cookies.find((c) => c.name === 'newfc_session');
    if (!cookie) throw new Error('E2E 登录未返回会话 Cookie');
    await ctx.dispose();
    await use({ cookie: cookie.value, csrf: body.csrfToken, host: new URL(baseURL).hostname });
  }, { scope: 'worker' }],
  storageState: async ({ workerSession }, use) => {
    await use({
      cookies: [{ name: 'newfc_session', value: workerSession.cookie, domain: workerSession.host, path: '/', expires: -1, httpOnly: true, secure: false, sameSite: 'Strict' }],
      origins: [],
    });
  },
  extraHTTPHeaders: async ({ workerSession }, use) => {
    await use({ 'x-csrf-token': workerSession.csrf });
  },
});

export { expect };

/** 进入首页;若会话不存在(例如用例清空了 storageState)则经登录页真实登录。 */
export async function login(page: Page): Promise<void> {
  await page.goto('/');
  const loginButton = page.getByRole('button', { name: '登 录' });
  const home = page.getByText('首页').first();
  await expect(loginButton.or(home)).toBeVisible();
  if (await loginButton.isVisible()) {
    await page.getByPlaceholder('用户名').fill(ACCESS_USER);
    await page.getByPlaceholder('密码').fill(ACCESS_PASSWORD);
    await loginButton.click();
  }
  await expect(home).toBeVisible();
}
