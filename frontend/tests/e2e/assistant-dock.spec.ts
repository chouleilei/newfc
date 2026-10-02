import { type APIRequestContext, type Page } from '@playwright/test';
import { expect, test } from './access';

/**
 * 全局侧边抽屉「财务助手」的端到端。
 *
 * 覆盖需求里可自动化的验收点：
 * 1. 页面感知：在 /budget/:id 提问，请求体必须带 page='budget_edit' 与该版本 ID，
 *    且**非当前年度版本 + 消息不带年份**也要正常回答，不再误报「年度不一致」；
 * 2. 写操作护栏：抽屉里出现 action 时不得发 /assistant/preview，只给「去完整页处理」；
 * 3. 双向接续：抽屉里问完，进完整页能看到同一会话的同一轮回答；
 * 4. 抽屉语义：Esc 可关、关闭后内容 DOM 卸载、范围条随路由/查询参数更新。
 *
 * 选择器一律用 assistant-dock- 前缀，避免与独立页的 assistant-answer 等互相命中。
 * 数据自备：2024 年度(独占)——刻意不是当前自然年，用来固化年度推导那条修复。
 */

const YEAR = 2024;
const VERSION_NAME = `${YEAR}年度预算V1(抽屉E2E)`;

function findByCode(nodes: any[], code: string): any | null {
  for (const node of nodes ?? []) {
    if (node.code === code) return node;
    const hit = findByCode(node.children ?? [], code);
    if (hit) return hit;
  }
  return null;
}

async function json(request: APIRequestContext, url: string): Promise<any> {
  const response = await request.get(url);
  expect(response.ok(), `${url} 应当成功`).toBeTruthy();
  return response.json();
}

/** 备一份 2024 年的预算版本(定稿；不是当前自然年，用来固化年度推导那条修复)。 */
async function seed(request: APIRequestContext): Promise<number> {
  const existing: any[] = await json(request, `/api/versions?year=${YEAR}`);
  const found = existing.find((v) => v.name === VERSION_NAME);
  if (found) {
    // 夹具可能是上一次运行留下的草稿：copy_budget 不接受草稿源版本，这里补一次定稿。
    if (found.status === 'draft') expect((await request.post(`/api/versions/${found.id}/lock`)).ok(), '定稿应当成功').toBeTruthy();
    return found.id;
  }
  const orgs = (await json(request, '/api/org/tree')).tree ?? [];
  const accounts = (await json(request, '/api/account/tree')).tree ?? [];
  const shanghai = findByCode(orgs, 'SH');
  const incomeMain = findByCode(accounts, 'I01');
  const expenseAdmin = findByCode(accounts, 'E01');
  expect(shanghai && incomeMain && expenseAdmin, '种子数据缺少 SH/I01/E01').toBeTruthy();
  const created = await request.post('/api/versions', { data: { year: YEAR, name: VERSION_NAME } });
  expect(created.ok(), '创建预算版本应当成功').toBeTruthy();
  const version = await created.json();
  const entries = await request.put(`/api/versions/${version.id}/entries`, {
    data: {
      expectedRevision: version.revision,
      entries: [
        { orgId: shanghai.id, accountId: incomeMain.id, amount: '100.00' },
        { orgId: shanghai.id, accountId: expenseAdmin.id, amount: '25.00' },
      ],
    },
  });
  expect(entries.ok(), '写入预算分录应当成功').toBeTruthy();
  // 定稿：copy_budget 不接受草稿源版本，不定稿的话完整页上拿不到「创建预览」
  expect((await request.post(`/api/versions/${version.id}/lock`)).ok(), '定稿应当成功').toBeTruthy();
  return version.id;
}

async function openDock(page: Page): Promise<void> {
  await page.getByTestId('assistant-dock-trigger').click();
  await expect(page.getByTestId('assistant-dock-input')).toBeVisible();
}

/**
 * 在抽屉里发一条消息并等这一轮结束。
 *
 * 收尾信号取「停止生成按钮消失、发送按钮回来」而不是某个标签：
 * 页面范围已确定时未必显示额外范围提示，用提示标签当收尾信号会等成超时。
 */
async function askInDock(page: Page, text: string): Promise<void> {
  const answers = page.getByTestId('assistant-dock-answer');
  const before = await answers.count();
  await page.getByTestId('assistant-dock-input').fill(text);
  await page.getByTestId('assistant-dock-send').click();
  await expect(answers).toHaveCount(before + 1, { timeout: 30_000 });
  await expect(answers.last()).not.toBeEmpty({ timeout: 30_000 });
  await expect(page.getByTestId('assistant-dock-stop')).toHaveCount(0, { timeout: 30_000 });
  await expect(page.getByTestId('assistant-dock-send')).toBeVisible();
}

test.describe('全局助手抽屉', () => {
  let versionId = 0;
  test.beforeAll(async ({ request }) => { versionId = await seed(request); });

  test('编制页提问带上 page 与版本上下文，非当前年度版本也正常回答', async ({ page }) => {
    const bodies: any[] = [];
    page.on('request', (req) => {
      if (req.url().includes('/api/assistant/chat')) {
        try { bodies.push(JSON.parse(req.postData() ?? '{}')); } catch { /* 忽略非 JSON */ }
      }
    });

    await page.goto(`/budget/${versionId}`);
    await expect(page.getByText(VERSION_NAME).first()).toBeVisible();
    await openDock(page);

    // 范围条如实标出当前页面与版本
    const badge = page.locator('.newfc-assistant-dock').getByTestId('assistant-scope-bar');
    await expect(badge).toContainText('回答范围');
    await expect(badge).toContainText('预算编制表格');
    await expect(badge).toContainText(VERSION_NAME);

    await askInDock(page, '这个版本执行得怎么样');

    // 网络层断言：只发送页面快照。
    expect(bodies.length).toBeGreaterThan(0);
    expect(bodies[0]).not.toHaveProperty('context');
    expect(bodies[0].pageContext?.pageKey).toBe('budget_edit');
    expect(bodies[0].pageContext?.scope?.budgetVersionId).toBe(versionId);

    // 关键护栏：消息里没有年份、版本又不是当前自然年，仍要正常回答，
    // 且范围摘要里如实写明页面登记的年度
    const answer = page.getByTestId('assistant-dock-answer').last();
    await expect(answer).not.toContainText('年度不一致');
    const summaryTag = page.getByTestId('assistant-dock-context-summary').last();
    await expect(summaryTag).toBeVisible();
    await expect(summaryTag).toContainText(`${YEAR} 年`);
    await expect(summaryTag).toContainText('预算编制表格');
  });

  test('抽屉里出现写操作意图时不创建预览，只引导到完整页', async ({ page }) => {
    let previewCalls = 0;
    page.on('request', (req) => { if (req.url().includes('/api/assistant/preview')) previewCalls += 1; });

    await page.goto(`/budget/${versionId}`);
    await openDock(page);
    await askInDock(page, `把${VERSION_NAME}复制到 2033 年，整体增长 5%`);

    await expect(page.getByTestId('assistant-dock-action')).toBeVisible();
    await expect(page.getByTestId('assistant-dock-action-fullpage')).toBeVisible();
    // 抽屉里没有「创建预览」这个动作
    await expect(page.locator('.newfc-assistant-dock').getByRole('button', { name: '创建预览' })).toHaveCount(0);
    expect(previewCalls, '抽屉不得创建预览').toBe(0);

    // 进完整页后才可以创建预览
    await page.getByTestId('assistant-dock-action-fullpage').click();
    await expect(page).toHaveURL(/\/assistant$/);
    await expect(page.getByRole('button', { name: '创建预览' }).last()).toBeVisible();
  });

  test('抽屉与完整页共享同一会话，Esc 可关且关闭后内容卸载', async ({ page }) => {
    await page.goto('/analysis');
    await openDock(page);
    // 范围条跟着分析页走(该页会把 year/version 写进查询参数，一并纳入登记)
    await expect(page.locator('.newfc-assistant-dock').getByTestId('assistant-scope-bar')).toContainText('年度执行分析');

    await askInDock(page, `${YEAR} 年有哪些预算版本`);
    const dockText = (await page.getByTestId('assistant-dock-answer').last().innerText()).slice(0, 20);

    // Esc 关闭 + 内容 DOM 卸载
    await page.keyboard.press('Escape');
    await expect(page.getByTestId('assistant-dock-input')).toHaveCount(0);
    await expect(page.getByTestId('assistant-dock-answer')).toHaveCount(0);

    // 抽屉 → 完整页：同一会话的同一轮回答接续显示(前端路由导航，不刷新页面)
    await openDock(page);
    await page.getByTestId('assistant-dock-fullpage').click();
    await expect(page).toHaveURL(/\/assistant$/);
    await expect(page.getByTestId('assistant-answer').last()).toContainText(dockText);

    // 完整页 → 抽屉：同一份 turns 也能在抽屉里继续看
    await openDock(page);
    await expect(page.getByTestId('assistant-dock-answer').last()).toContainText(dockText);
  });

  test('助手页筛选器是本页自身的范围,不泄漏到业务页面(§6)', async ({ page }) => {
    const bodies: any[] = [];
    page.on('request', (req) => {
      if (req.url().includes('/api/assistant/chat')) {
        try { bodies.push(JSON.parse(req.postData() ?? '{}')); } catch { /* 忽略非 JSON */ }
      }
    });

    // 在独立页手动选一个年度:它只属于 /assistant 页自身的范围登记
    // (口径筛选器默认折叠,先展开再选)
    await page.goto('/assistant');
    await page.getByTestId('assistant-filters-toggle').click();
    await page.getByRole('combobox', { name: '默认年度', exact: true }).click();
    await page.locator('.ant-select-dropdown:visible .ant-select-item-option').filter({ hasText: `${YEAR + 2} 年` }).first().click();
    await expect(page.locator(`.ant-select-selection-item[title="${YEAR + 2} 年"]`)).toBeVisible();

    // 业务页面(编制页):助手页选过的年度绝不泄漏过来,页面自己的版本/年度生效
    await page.goto(`/budget/${versionId}`);
    await openDock(page);
    const badge = page.locator('.newfc-assistant-dock').getByTestId('assistant-scope-bar');
    await expect(badge).toContainText('预算编制表格');
    await expect(badge).toContainText(VERSION_NAME);
    await askInDock(page, '执行情况怎么样');
    const dockBody = bodies[bodies.length - 1];
    expect(dockBody.pageContext?.pageKey).toBe('budget_edit');
    expect(dockBody.pageContext?.scope?.budgetVersionId).toBe(versionId);
    expect(dockBody.pageContext?.scope?.year, '助手页的手动年度不得泄漏到编制页').toBe(YEAR);
    expect(dockBody).not.toHaveProperty('context');

    // 手动筛选是 /assistant 页自身的内存状态、不持久化——page.goto 整页
    // 刷新后即清空,回到助手页时年度已回到未选状态,本轮请求体自然不带该字段。
    // (SPA 路由导航回 /assistant 时筛选会保留:那是助手页自己的筛选器,§6 只约束它不泄漏到业务页面。)
    await page.goto('/assistant');
    await expect(page.locator(`.ant-select-selection-item[title="${YEAR + 2} 年"]`)).toHaveCount(0);
    await page.locator('textarea').first().fill('列出预算版本');
    await page.getByRole('button', { name: '发送' }).click();
    await expect(page.getByTestId('assistant-answer').last()).not.toBeEmpty({ timeout: 30_000 });
    const pageBody = bodies[bodies.length - 1];
    expect(pageBody.pageContext?.scope?.year, '手动清空后本轮不得再带年度').toBeUndefined();
    expect(pageBody.pageContext?.pageKey).toBe('assistant');
    expect(pageBody).not.toHaveProperty('context');
  });
});
