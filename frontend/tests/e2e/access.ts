import { expect, type Page } from '@playwright/test';

/**
 * 开鉴权 E2E 实例的固定凭据与登录动作。
 *
 * 为什么要有这个文件：三个走界面登录的 spec 过去各自读 `process.env.BUDGET_ACCESS_USER/PASSWORD`，
 * 缺一个就直接 `throw new Error('缺少浏览器测试登录凭据')`；而默认 harness 的 webServer 反而显式
 * 设了 `BUDGET_DISABLE_AUTH=1`，登录框根本不会出现。结果这些用例在默认 harness 下必然失败，
 * 失败原因还是环境配置而不是代码回归。
 *
 * 现在 harness 与用例共用这里的默认值(见 `playwright.config.ts` 的鉴权实例 env)，
 * 无需任何环境变量即可跑通；需要连自己的实例时再用同名环境变量覆盖。
 */
export const ACCESS_USER = process.env.BUDGET_ACCESS_USER || 'e2e';
export const ACCESS_PASSWORD = process.env.BUDGET_ACCESS_PASSWORD || 'e2e-local-password';

/** 从登录页真实登录，返回前端存下的访问令牌(供直接调 API 的用例复用同一会话)。 */
export async function login(page: Page): Promise<string> {
  await page.goto('/');
  await page.getByPlaceholder('用户名').fill(ACCESS_USER);
  await page.getByPlaceholder('密码').fill(ACCESS_PASSWORD);
  await page.getByRole('button', { name: '登 录' }).click();
  await expect(page.getByText('首页').first()).toBeVisible();
  return page.evaluate(() => localStorage.getItem('budget-access-token') ?? '');
}
