import type { APIRequestContext, APIResponse } from '@playwright/test';
import { expect, login, test } from './access';

/**
 * T-6 跨域链路(AC-F26):顶栏检索 → /search 按类型分组 → 点击结果进入真实页面并打开对应详情(?id= 定位),
 * 关闭详情后参数移除;主数据结果进入对应页签并预填关键词。
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
  test('顶栏检索 → 分组结果 → 进入投资控制详情与主数据页签', async ({ page, request }) => {
    const code = `E2E-SR-${Date.now()}`;
    const md = await json<{ id: number }>(await request.post('/api/master/projects', { data: { code, name: '检索泵站', orgId: await orgId(request, '上海公司') } }), 201);
    const ic = await json<{ id: number }>(await request.post('/api/investment/control/projects', { data: { mdProjectId: md.id } }), 201);

    await login(page);
    await page.goto('/');
    const box = page.getByRole('searchbox', { name: '跨域检索' });
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
    await expect(page).toHaveURL(/\/master-entities\?tab=projects&keyword=/);
    await expect(page.getByRole('tab', { name: '项目', selected: true })).toBeVisible();
    await expect(page.locator('.ant-table-row', { hasText: code })).toHaveCount(1);
  });
});
