import { type APIRequestContext, type Page } from '@playwright/test';
import { expect, test } from './access';

/**
 * 表格全屏的「有进有出」回归用例。
 *
 * 修复前的缺陷：全屏覆盖层(position:fixed; inset:0; z-index:1100)只包住表格本身，
 * 而「退出全屏」按钮在覆盖层外的工具栏里，被覆盖层完全盖住；页面又没有 Esc 兜底，
 * 用户进入全屏后只能刷新页面（丢掉未保存草稿）。
 *
 * 本用例从界面验证三件事，任何一条回归都会失败：
 * 1. 全屏态下「退出全屏」按钮能真正被点到（Playwright 的 click 会做命中检测，
 *    若按钮被覆盖层遮住会因 pointer events 被拦截而失败）；
 * 2. Esc 能退出全屏；
 * 3. 覆盖层层级低于 antd 浮层基线(1000)，保证全屏态下弹窗/提示/右键菜单仍在最上层。
 */

/* 年度分配(同一后端实例上三个 spec 并行跑，年度必须互不重叠)：
   2026 属 finance-import，2027 属 assistant 的自建数据，2029 是 assistant 写操作护栏断言
   「该年度必须没有任何版本」的专用年度——这里曾经也用 2029，并行时会让那条护栏偶发变红。 */
const YEAR = 2031;
const VERSION_NAME = `${YEAR}年度预算V1(全屏E2E)`;

async function ensureDraftVersion(request: APIRequestContext): Promise<number> {
  const listed = await request.get(`/api/versions?year=${YEAR}`);
  expect(listed.ok(), '版本列表应当可读').toBeTruthy();
  const existing: { id: number; name: string }[] = await listed.json();
  const found = existing.find((v) => v.name === VERSION_NAME);
  if (found) return found.id;
  const created = await request.post('/api/versions', { data: { year: YEAR, name: VERSION_NAME } });
  expect(created.ok(), '创建草稿版本应当成功').toBeTruthy();
  return (await created.json()).id;
}

/** 工具栏上的「全屏 / 退出全屏」按钮:可访问名即按钮文案(Remix 图标不进可访问名),
 *  且页面上还有别的表格自带全屏按钮,统一取第一个(工具栏在 DOM 中最靠前) */
const enterButton = (page: Page) => page.getByRole('button', { name: '全屏', exact: true }).first();
const exitButton = (page: Page) => page.getByRole('button', { name: /退出全屏\(Esc\)/ }).first();

/** 进入全屏 → 覆盖层出现，且退出按钮可见 */
async function enterFullscreen(page: Page) {
  await enterButton(page).click();
  await expect(page.locator('.bd-grid-fullscreen')).toHaveCount(1);
  await expect(exitButton(page)).toBeVisible();
}

test.describe('表格全屏必须能退出', () => {
  test('预算编制页：按钮退出 + Esc 退出 + 覆盖层不压住浮层', async ({ page, request }) => {
    const versionId = await ensureDraftVersion(request);
    await page.goto(`/budget/${versionId}`);
    await expect(enterButton(page)).toBeVisible();

    // 1) 点按钮退出：修复前该按钮被覆盖层遮住，这一步会因命中检测失败而超时
    await enterFullscreen(page);
    await exitButton(page).click();
    await expect(page.locator('.bd-grid-fullscreen')).toHaveCount(0);

    // 2) Esc 退出（焦点不在输入框时）
    await enterFullscreen(page);
    await page.locator('body').press('Escape');
    await expect(page.locator('.bd-grid-fullscreen')).toHaveCount(0);

    // 3) 覆盖层层级必须低于 antd 浮层基线，否则全屏态下弹窗与提示都看不见
    await enterFullscreen(page);
    const zIndex = await page.locator('.bd-grid-fullscreen').evaluate((el) => getComputedStyle(el).zIndex);
    expect(Number(zIndex)).toBeLessThan(1000);
    // 全屏态下工具栏仍在覆盖层内：筛选与撤销重做不会失联
    await expect(page.getByRole('button', { name: '仅看有数据' })).toBeVisible();
    await exitButton(page).click();
    await expect(page.locator('.bd-grid-fullscreen')).toHaveCount(0);
  });

  test('历史数据维护页：按钮退出 + Esc 退出', async ({ page }) => {
    await page.goto('/actual');
    await expect(enterButton(page)).toBeVisible();

    await enterFullscreen(page);
    await exitButton(page).click();
    await expect(page.locator('.bd-grid-fullscreen')).toHaveCount(0);

    await enterFullscreen(page);
    await page.locator('body').press('Escape');
    await expect(page.locator('.bd-grid-fullscreen')).toHaveCount(0);
  });
});
