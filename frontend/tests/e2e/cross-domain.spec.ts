import type { APIRequestContext, APIResponse } from '@playwright/test';
import { expect, login, test } from './access';

/**
 * T-6 跨域链路(AC-F26):顶栏检索 → /search 按类型分组 → 点击结果进入真实页面并打开对应详情(?id= 定位),
 * 关闭详情后参数移除;项目结果进入项目档案,显示同一项目的编码与名称。
 */

async function json<T>(res: APIResponse, status = 200): Promise<T> {
  expect(res.status(), await res.text()).toBe(status);
  return await res.json() as T;
}

interface OrgNode { id: number; name: string; children?: OrgNode[] }
async function orgId(request: APIRequestContext, name: string): Promise<number> {
  const walk = (nodes: OrgNode[]): number | undefined => {
    for (const n of nodes) { if (n.name === name) return n.id; const hit = walk(n.children ?? []); if (hit) return hit; }
    return undefined;
  };
  const { tree } = await json<{ tree: OrgNode[] }>(await request.get('/api/org/tree'));
  const id = walk(tree);
  if (!id) throw new Error(`夹具缺少组织 ${name}`);
  return id;
}

test.describe('跨域检索', () => {
  test('顶栏检索 → 分组结果 → 进入投资控制详情与项目档案', async ({ page, request }) => {
    const code = `E2E-SR-${Date.now()}`;
    const md = await json<{ id: number }>(await request.post('/api/master/projects', { data: { code, name: '检索泵站', orgId: await orgId(request, '上海公司') } }), 201);
    const ic = await json<{ id: number }>(await request.post('/api/investment/control/projects', { data: { mdProjectId: md.id } }), 201);

    await login(page);
    await page.goto('/');
    const box = page.getByRole('combobox', { name: '跨域检索' });
    await box.fill(code);
    await box.press('Enter');
    await expect(page).toHaveURL(new RegExp(`/search\\?q=${code}`));
    await expect(page.getByText('不是语义检索')).toBeVisible();
    const icCard = page.locator('.ant-card', { has: page.locator('.ant-card-head', { hasText: '投资控制项目' }) });
    await expect(icCard.getByRole('link', { name: new RegExp(code) })).toBeVisible();
    const mdCard = page.locator('.ant-card', { has: page.locator('.ant-card-head-title', { hasText: /^项目/ }) });
    await expect(mdCard.getByRole('link', { name: new RegExp(code) })).toBeVisible();

    await icCard.getByRole('link', { name: new RegExp(code) }).click();
    await expect(page).toHaveURL(new RegExp(`/investment-control\\?id=${ic.id}$`));
    const drawer = page.locator('.ant-drawer-content-wrapper:visible').last();
    await expect(drawer.getByText(`${code} · 检索泵站`)).toBeVisible();
    await drawer.locator('.ant-drawer-close').click();
    await expect(page).toHaveURL(/\/investment-control$/);

    await page.goBack();
    await expect(page).toHaveURL(/\/search\?q=/);
    await mdCard.getByRole('link', { name: new RegExp(code) }).click();
    await expect(page).toHaveURL(new RegExp(`/projects/${md.id}$`));
    await expect(page.locator('.ant-descriptions-title')).toContainText(code);
    await expect(page.locator('.ant-descriptions-title')).toContainText('检索泵站');
    await expect(page.getByRole('tab', { name: '项目预算' })).toBeVisible();
  });
});

test.describe('工作台业务概况', () => {
  test('各域概况块可见并可进入对应页面', async ({ page }) => {
    await login(page);
    await page.goto('/');
    const card = page.getByTestId('domain-overview-card');
    await expect(card).toBeVisible();
    for (const label of ['合同', '费用报销', '项目预算', '风险', '投资控制', '分析报告']) {
      await expect(card.getByLabel(`业务概况 ${label}`)).toBeVisible();
    }
    await expect(card.getByLabel('业务概况 投资控制')).toContainText('最新快照超限项目');
    await card.getByLabel('业务概况 风险').click();
    await expect(page).toHaveURL(/\/risk$/);
  });
});
