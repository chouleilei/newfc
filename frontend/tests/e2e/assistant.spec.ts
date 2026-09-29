import { type APIRequestContext } from '@playwright/test';
import { expect, test } from './access';

/**
 * AI 助手页真机端到端。
 *
 * 覆盖《AI助手完整方案》里"要真正好用"的几条可用性约束，全部从界面观察：
 * 1. 上下文自动解析：不在下拉框里选任何东西，直接用自然语言提问也能算出数字，
 *    并在界面上如实标出「助手替你选了什么」（口径 chips 的来源标签）；
 * 2. 意图路由：口语化说法（「哪个厂亏得最多」）能路由到差异归因；
 * 3. 追问延续：不重述话题的追问沿用上一轮意图与范围，界面显示「追问·沿用…」；
 * 4. 写操作护栏：参数从原话解析，创建预览后处于待确认，未确认不落库，可取消；
 * 5. 路由来源透明：未配置模型时显示「关键词兜底」+「模板降级」，答案仍带真实数字。
 *
 * 数据自备：用 2027 年度自建版本与快照，避免与 finance-import.spec 的 2026 年数据互相干扰。
 */

const YEAR = 2027;
const VERSION_NAME = `${YEAR}年度预算V1(助手E2E)`;
const SNAPSHOT_DATE = `${YEAR}-06-30`;

interface Seeded { versionId: number; shanghaiId: number; hangzhouId: number }

/** 从组织/科目树里按编码找节点 ID。树接口返回嵌套结构，这里做一次深度遍历。 */
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

/**
 * 用公开 API 备好一份可分析的数据：预算版本(定稿并设为当前生效) + 一份实际快照。
 * 完成率因此是确定的：收入 90/200，费用 30/50。
 */
async function seed(request: APIRequestContext): Promise<Seeded> {
  const existing: any[] = await json(request, `/api/versions?year=${YEAR}`);
  const orgs = (await json(request, '/api/org/tree')).tree ?? [];
  const accounts = (await json(request, '/api/account/tree')).tree ?? [];
  const shanghai = findByCode(orgs, 'SH');
  const hangzhou = findByCode(orgs, 'HZ');
  const incomeMain = findByCode(accounts, 'I01');
  const expenseAdmin = findByCode(accounts, 'E01');
  expect(shanghai && hangzhou && incomeMain && expenseAdmin, '种子数据缺少 SH/HZ/I01/E01').toBeTruthy();

  const found = existing.find((v) => v.name === VERSION_NAME);
  if (found) return { versionId: found.id, shanghaiId: shanghai.id, hangzhouId: hangzhou.id };

  const created = await request.post('/api/versions', { data: { year: YEAR, name: VERSION_NAME } });
  expect(created.ok(), '创建预算版本应当成功').toBeTruthy();
  const version = await created.json();

  const entries = await request.put(`/api/versions/${version.id}/entries`, {
    data: {
      expectedRevision: version.revision,
      entries: [
        { orgId: shanghai.id, accountId: incomeMain.id, amount: '120.00' },
        { orgId: shanghai.id, accountId: expenseAdmin.id, amount: '30.00' },
        { orgId: hangzhou.id, accountId: incomeMain.id, amount: '80.00' },
        { orgId: hangzhou.id, accountId: expenseAdmin.id, amount: '20.00' },
      ],
    },
  });
  expect(entries.ok(), '写入预算分录应当成功').toBeTruthy();
  expect((await request.post(`/api/versions/${version.id}/lock`)).ok(), '定稿应当成功').toBeTruthy();
  expect((await request.post(`/api/versions/${version.id}/set-current`)).ok(), '设为当前生效应当成功').toBeTruthy();

  const batches = await json(request, `/api/actual/batches?year=${YEAR}`);
  const currentBatchId = (batches as any[])[0]?.id ?? null;
  const actual = await request.post('/api/actual/save', {
    data: {
      year: YEAR,
      snapshotDate: SNAPSHOT_DATE,
      expectedCurrentBatchId: currentBatchId,
      note: '助手 E2E 实际数',
      entries: [
        // 上海收入只完成 40/120，是"亏得最多"的那个组织
        { orgId: shanghai.id, accountId: incomeMain.id, amount: '40.00' },
        { orgId: shanghai.id, accountId: expenseAdmin.id, amount: '18.00' },
        { orgId: hangzhou.id, accountId: incomeMain.id, amount: '50.00' },
        { orgId: hangzhou.id, accountId: expenseAdmin.id, amount: '12.00' },
      ],
    },
  });
  expect(actual.ok(), '保存实际数应当成功').toBeTruthy();
  return { versionId: version.id, shanghaiId: shanghai.id, hangzhouId: hangzhou.id };
}

/** 发送一条消息并等这一轮回答落地（正文非空，并展开「引用与依据」使口径 chips 可见）。 */
async function ask(page: any, text: string): Promise<void> {
  const answers = page.getByTestId('assistant-answer');
  const before = await answers.count();
  await page.locator('textarea').first().fill(text);
  await page.getByRole('button', { name: '发送' }).click();
  await expect(answers).toHaveCount(before + 1, { timeout: 30_000 });
  await expect(answers.last()).not.toBeEmpty({ timeout: 30_000 });
  // 口径/引用/事实现在收进默认收起的「引用与依据」折叠条(体验升级方案一.3):
  // 折叠条渲染代表 done 事件已到,点开后口径 chips 才可见。
  const toggle = page.getByTestId('assistant-evidence-toggle').last();
  await expect(toggle).toBeVisible({ timeout: 30_000 });
  await toggle.click();
  await expect(page.getByText('口径', { exact: true }).last()).toBeVisible({ timeout: 30_000 });
}

/** 最后一轮回答的正文。 */
function lastAnswer(page: any) {
  return page.getByTestId('assistant-answer').last();
}

test.describe('AI 助手页', () => {
  test.beforeAll(async ({ request }) => { await seed(request); });

  test('自然语言提问：自动解析上下文、路由到确定性查询、答案带真实数字并标明口径', async ({ page }) => {
    await page.goto('/assistant');
    await expect(page.getByRole('button', { name: '发送' })).toBeVisible();

    // 刻意不动任何下拉框，全靠消息里的年度解析
    await ask(page, `${YEAR}年执行情况怎么样`);

    // 路由来源与降级状态必须如实展示（E2E 环境未配置模型）
    await expect(page.getByText('关键词兜底', { exact: true }).last()).toBeVisible();
    await expect(page.getByText('模板降级(模型不可用)', { exact: true }).last()).toBeVisible();

    // 口径 chips：年度来自提问，版本是助手默认选的当前生效版本
    await expect(page.getByText(`年度：${YEAR}`, { exact: false }).last()).toBeVisible();
    await expect(page.getByText('从提问识别', { exact: true }).first()).toBeVisible();
    await expect(page.getByText(`预算版本：${VERSION_NAME}`, { exact: false }).last()).toBeVisible();
    await expect(page.getByText('助手默认选择', { exact: true }).first()).toBeVisible();

    // 模板模式的答案也必须带真实数字：收入 90/200=45.0%，费用 30/50=60.0%
    const answer = lastAnswer(page);
    await expect(answer).toContainText('完成率');
    await expect(answer).toContainText('45.0%');
    await expect(answer).toContainText('60.0%');
    await expect(answer).toContainText(SNAPSHOT_DATE);

    // 引用来源存在，说明数字挂在确定性事实上
    await expect(page.getByText('引用来源', { exact: true }).last()).toBeVisible();
  });

  test('口语化提问路由到差异归因，追问不重述话题也能延续', async ({ page }) => {
    await page.goto('/assistant');
    await expect(page.getByRole('button', { name: '发送' })).toBeVisible();

    await ask(page, `${YEAR}年哪个厂亏得最多`);
    const first = lastAnswer(page);
    await expect(first).toContainText('净差异');
    await expect(first).toContainText('上海公司');

    // 追问只给组织名：应沿用差异归因意图，并把范围收窄到上海公司
    await ask(page, '上海公司呢');
    await expect(page.getByText('追问·沿用差异归因', { exact: true }).last()).toBeVisible();
    await expect(page.getByText('组织范围：上海公司', { exact: false }).last()).toBeVisible();
    await expect(lastAnswer(page)).toContainText('净差异');

    // 纯追问词同样延续，不会退化成版本列表
    await ask(page, '那再往下拆一层');
    await expect(page.getByText('追问·沿用差异归因', { exact: true }).last()).toBeVisible();
    await expect(lastAnswer(page)).toContainText('净差异');
  });

  test('写操作：参数从原话解析，创建预览后待确认，未确认不落库且可取消', async ({ page, request }) => {
    const targetYear = YEAR + 2;
    await page.goto('/assistant');
    await expect(page.getByRole('button', { name: '发送' })).toBeVisible();

    await ask(page, `把${VERSION_NAME}复制到${targetYear}年，整体增长5%`);

    // 建议卡片：类型与参数来源
    await expect(page.getByText(`识别到 copy_budget 意图`, { exact: true }).last()).toBeVisible();
    await expect(page.getByText('规则推断', { exact: true }).last()).toBeVisible();

    await page.getByRole('button', { name: '创建预览' }).last().click();

    // 预览进入待确认，并明确写着未确认不改数据
    await expect(page.getByText('待处理与已完成操作', { exact: true })).toBeVisible();
    await expect(page.getByText('待确认', { exact: true }).last()).toBeVisible();
    await expect(page.getByText(/未确认前不会修改任何数据/).last()).toBeVisible();
    await expect(page.getByRole('button', { name: '确认执行' })).toBeVisible();

    // 关键护栏：此刻目标年度还不能有任何版本(2029 是本用例独占年度，其他 spec 不得占用)
    const before = await json(request, `/api/versions?year=${targetYear}`);
    expect(before, '预览阶段不得写入业务数据').toEqual([]);

    await page.getByRole('button', { name: /取\s*消/ }).last().click();
    await expect(page.getByText('已取消', { exact: true }).last()).toBeVisible();

    // 取消后仍然没有写入
    const after = await json(request, `/api/versions?year=${targetYear}`);
    expect(after, '取消后不得留下任何版本').toEqual([]);
  });

  test('流式关闭后走一次性返回，答案与口径展示一致', async ({ page }) => {
    await page.goto('/assistant');
    await expect(page.getByRole('button', { name: '发送' })).toBeVisible();

    await page.getByRole('switch').first().click();
    await expect(page.getByRole('switch').first()).not.toBeChecked();

    await ask(page, `${YEAR}年执行情况怎么样`);
    const answer = lastAnswer(page);
    await expect(answer).toContainText('完成率');
    await expect(answer).toContainText('45.0%');
    await expect(page.getByText('关键词兜底', { exact: true }).last()).toBeVisible();
  });

  test('写操作确认路径：聊天里回复「确认」不写入，且操作建议被沿用', async ({ page }) => {
    await page.goto('/assistant');
    await expect(page.getByRole('button', { name: '发送' })).toBeVisible();

    await ask(page, `把 ${YEAR} 年的预算复制成 ${YEAR + 1} 年草案，整体增长 5%`);
    await expect(page.getByText(`识别到 copy_budget 意图`, { exact: true }).last()).toBeVisible();

    // 用户以为可以在聊天里确认：后端必须明确纠正，并把「创建预览」按钮保留下来
    await ask(page, '确认执行');
    await expect(page.getByText('在聊天里回复「确认」不会写入任何数据', { exact: false }).last()).toBeVisible();
    await expect(page.getByText('沿用上一轮', { exact: true }).last()).toBeVisible();
    await expect(page.getByRole('button', { name: '创建预览' }).last()).toBeVisible();

    // 依旧没有落库
    const versions = await page.request.get('/api/versions');
    const list = (await versions.json()) as { year: number }[];
    expect(list.some((row) => row.year === YEAR + 1)).toBe(false);
  });

  test('名称片段有歧义时如实提示候选，不静默按全范围回答', async ({ page }) => {
    // 建两个同前缀组织：片段「双子」对应两个组织
    const tree = (await (await page.request.get('/api/org/tree')).json()).tree ?? [];
    const parent = findByCode(tree, 'EAST') ?? tree[0];
    for (const [code, name] of [['SZA', '双子电站'], ['SZB', '双子温泉']] as const) {
      if (!findByCode(tree, code)) {
        const created = await page.request.post('/api/org', { data: { parentId: parent.id, code, name } });
        expect(created.ok(), `建组织 ${code} 失败: ${created.status()}`).toBeTruthy();
      }
    }
    await page.goto('/assistant');
    await ask(page, `双子 ${YEAR} 年收入完成得怎么样`);
    await expect(page.getByText('可能指', { exact: false }).last()).toBeVisible();
    await expect(page.getByText('双子电站', { exact: false }).last()).toBeVisible();
  });

  test('追问名次时按名次作答，报告成稿按 Markdown 渲染', async ({ page }) => {
    await page.goto('/assistant');
    await ask(page, `${YEAR} 年哪个厂亏得最多`);
    await expect(lastAnswer(page)).toContainText('第 1 名');
    await ask(page, '那第二名呢');
    await expect(lastAnswer(page)).toContainText('第 2 名');

    // 报告成稿本身是 Markdown（模板叙述用 # / ## / - ）：渲染后应出现真实标题与列表元素，
    // 而不是把「## 总体执行」当成纯文本显示。
    await ask(page, `生成 ${YEAR} 年预算执行月报`);
    const report = lastAnswer(page);
    await expect(report.locator('.assistant-markdown h4, .assistant-markdown h5').first()).toBeVisible({ timeout: 30_000 });
    await expect(report.locator('.assistant-markdown li').first()).toBeVisible();
    await expect(report).not.toContainText('## ');
  });
});
