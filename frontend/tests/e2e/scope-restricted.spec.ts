import { expect, test } from './access';

/**
 * T-2 页面层 AC-X04:只授权「上海公司」的财务分析账号在界面上登录。
 * 侧栏不出现集团口径入口,首页不给全局日志;同一会话下接口与助手对杭州公司/集团口径一律拒绝。
 */
interface OrgRow { id: number; name: string }

test('受限账号:侧栏与首页按范围裁剪,越权接口与问答拒绝', async ({ request, browser }, testInfo) => {
  const orgs = (await (await request.get('/api/org/tree')).json() as { rows: OrgRow[] }).rows;
  const sh = orgs.find((o) => o.name === '上海公司')!;
  const hz = orgs.find((o) => o.name === '杭州公司')!;
  const roles = (await (await request.get('/api/security/roles')).json() as { items: { id: number; code: string }[] }).items;
  const analyst = roles.find((r) => r.code === 'finance_analyst')!;
  const username = `e2e-sh-${Date.now().toString(36)}`;
  const password = 'Vt9-scope-local-pw';
  const created = await request.post('/api/security/users', {
    data: { username, password, roleIds: [analyst.id], orgIds: [sh.id], mustChangePassword: false },
  });
  expect(created.status()).toBe(201);

  const context = await browser.newContext({ baseURL: String(testInfo.project.use.baseURL), storageState: { cookies: [], origins: [] }, extraHTTPHeaders: {} });
  const page = await context.newPage();
  await page.goto('/');
  await page.getByPlaceholder('用户名').fill(username);
  await page.getByPlaceholder('密码').fill(password);
  await page.getByRole('button', { name: '登 录' }).click();
  await expect(page.getByText('首页').first()).toBeVisible();

  const nav = page.getByRole('navigation').or(page.locator('.ant-layout-sider')).first();
  await expect(nav).not.toContainText('预算与预测');
  await expect(nav).not.toContainText('实际录入与快照');
  // finance 夹具库是否已有当前采用版本取决于前序用例:无版本时首页是初始化指引,受限账号只看进度、不给维护入口;
  // 有版本时是驾驶舱。两种状态都不得出现维护入口和全局日志。
  const onboarding = page.getByText('部分步骤需要预算维护人员');
  const cockpit = page.getByText('本年主数字').first();
  await expect(onboarding.or(cockpit).first()).toBeVisible();
  await expect(page.getByRole('button', { name: /创建预算版本/ })).toHaveCount(0);
  await expect(page.getByRole('button', { name: '全部日志' })).toHaveCount(0);
  const dash = await (await page.request.get('/api/dashboard')).json() as { scopeLimited?: boolean; recentLogs: unknown[]; counts: { orgs: number } };
  expect(dash.scopeLimited).toBe(true);
  expect(dash.recentLogs).toEqual([]);
  expect(dash.counts.orgs).toBe(1);

  const session = await (await page.request.get('/api/auth/session')).json() as { csrfToken: string; user: { allOrgs: boolean } };
  expect(session.user.allOrgs).toBe(false);
  const headers = { 'x-csrf-token': session.csrfToken };

  const tree = (await (await page.request.get('/api/org/tree')).json() as { rows: OrgRow[] }).rows;
  expect(tree.map((o) => o.name)).toContain('上海公司');
  expect(tree.map((o) => o.name)).not.toContain('杭州公司');

  const group = await page.request.get('/api/report/historical');
  expect(group.status()).toBe(403);
  expect((await group.json()).code).toBe('SCOPE_RESTRICTED');
  const cell = await page.request.get(`/api/evidence/budget-cell?versionId=1&orgId=${hz.id}&accountId=1`);
  expect([403, 404]).toContain(cell.status());

  const chat = await page.request.post('/api/assistant/chat', { headers, data: { message: '杭州公司预算执行情况', context: { year: 2026 } } });
  expect(chat.status()).toBe(404);
  expect(await chat.text()).not.toMatch(/"budgetCents"/);

  await page.goto('/jobs');
  await expect(page.getByRole('tab', { name: '后台任务' })).toBeVisible();
  await expect(page.getByRole('tab', { name: '模型调用' })).toHaveCount(0);
  expect((await page.request.get('/api/model-calls')).status()).toBe(403);

  await context.close();
});
