import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { login } from './access';

/**
 * UX-31 代理试用(simulation 项目):方案《易用性与直觉化交互实施方案》第七节的
 * 场景 1/2/3/4/7/8/9,以新使用者视角逐步走真实界面(备数据可用 API,核心动作必须走 UI)。
 * 每场景记录操作步数并截图到 gui-test-screenshots/ux31-trial/,stdout 输出
 * `UX31-RESULT {json}` 行供汇总报告提取。
 *
 * 覆盖的关键业务检查(方案第七节):
 * - 定稿版本不可原地修改(S2,界面只读 + API 拒绝双重断言)
 * - 历史补录不覆盖当前累计(S4,界面结果 + API 快照核对)
 * - 金额/数量不误混算(S9,选区合计与 API 精确值)
 * - 丢弃本地输入有明确表达(S3,年度切换三选一守卫)
 * - 中断恢复不丢输入、不显示假成功、不重复生成快照(S8)
 *
 * 数据说明:本文件会修改 2026 年实际数(S3/S4/S8)并创建/删除临时预算版本;
 * 仿真项目中 full-visual-audit 断言首页「实际数据截至 2026-08-22」,
 * 依赖 Playwright 按文件名排序(usability-trial 排在最后)执行,不要再把
 * 其他断言首页截至日期的 spec 排在 usability-trial 之后。
 */

const SHOT_DIR = path.join(process.cwd(), '..', 'gui-test-screenshots', 'ux31-trial');
fs.mkdirSync(SHOT_DIR, { recursive: true });

let token = '';
/** 本文件创建的临时版本,跑完统一删除,不污染夹具 */
const createdVersions: number[] = [];

test.beforeEach(async ({ page }) => {
  token = await login(page);
});

test.afterAll(async ({ request }) => {
  for (const id of createdVersions.reverse()) {
    await request.delete(`/api/versions/${id}`, { headers: { 'x-access-token': token } }).catch(() => undefined);
  }
});

async function apiGet<T>(request: APIRequestContext, route: string): Promise<T> {
  const response = await request.get(`/api${route}`, { headers: { 'x-access-token': token } });
  expect(response.ok(), `GET ${route}: ${response.status()}`).toBeTruthy();
  return response.json() as Promise<T>;
}

async function apiSend<T>(request: APIRequestContext, method: string, route: string, data?: unknown): Promise<T> {
  const response = await request.fetch(`/api${route}`, { method, headers: { 'x-access-token': token }, data });
  expect(response.ok(), `${method} ${route}: ${response.status()} ${await response.text()}`).toBeTruthy();
  return response.json() as Promise<T>;
}

/**
 * 全量回归尾部系统变慢(实测同等待单项 14s→57s),首次渲染整棵矩阵(26 组织×239 科目)
 * 与整包保存可能超过默认 15s expect 超时;只放宽等待上限,断言内容不变。
 */
const SLOW = { timeout: 90_000 };

/** 操作步数记录:每一步用户动作/判断计入,结束时输出到 stdout 与 annotations */
function makeTrialRecorder(testInfo: import('@playwright/test').TestInfo, scenario: string) {
  const steps: string[] = [];
  const notes: string[] = [];
  return {
    step(label: string) { steps.push(label); },
    note(text: string) { notes.push(text); },
    async shot(page: Page, file: string) {
      await page.screenshot({ path: path.join(SHOT_DIR, file) });
    },
    report(result: '独立完成' | '阻断') {
      const summary = { scenario, result, steps: steps.length, notes };
      testInfo.annotations.push({ type: 'ux31', description: JSON.stringify(summary) });
      console.log(`UX31-RESULT ${JSON.stringify(summary)}`);
    },
  };
}

interface VersionRowLite { id: number; year: number; name: string; status: string; is_current: 0 | 1; kind: 'budget' | 'forecast' }
interface MatrixLite {
  version: { id: number; revision: number; status: string; is_current: 0 | 1 };
  orgNodes: { id: number; code: string; name: string }[];
  accountNodes: { id: number; code: string; name: string; type: string }[];
  entries: { orgId: number; accountId: number; amountCents: number; quantity: string | null }[];
}
interface ActualMatrixLite {
  currentBatch: { id: number; snapshot_date: string } | null;
  entries: { orgId: number; accountId: number; amountCents: number; quantity: string | null }[];
}
interface BatchLite { id: number; year: number; snapshot_date: string; updates_current: number; status: string }

/** 网格单元格录入:点击 -> 全选(实际页格内可能已有累计值,避免追加成串) -> 输入 -> Enter 提交 */
async function typeIntoCell(page: Page, selector: string, value: string) {
  const cell = page.locator(selector);
  await cell.click();
  await page.keyboard.press('ControlOrMeta+a');
  await page.keyboard.type(value);
  await page.keyboard.press('Enter');
}

/**
 * 实际页首个可编辑金额格:跳过数量科目(数量格 title 以「数量单位」开头),
 * 数据库预设表「收入成本表」会把数量科目排在收入科目之前。
 */
async function firstEditableActualCell(page: Page) {
  const cells = await page.locator('input[id^="actual-cell-"]').evaluateAll((els) =>
    els.map((el) => ({ id: el.id, title: el.getAttribute('title') ?? '' })));
  const pick = cells.find((c) => !c.title.startsWith('数量'));
  expect(pick, '实际页应渲染金额类可编辑格').toBeTruthy();
  const [orgId, accountId] = pick!.id.replace('actual-cell-', '').split('-').map(Number);
  return { id: pick!.id, orgId, accountId };
}

/* ================= S1 第一次编制 ================= */
test('UX31-S1 第一次编制:新建下一年度草稿并直接填写两家单位', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const trial = makeTrialRecorder(testInfo, 'S1 第一次编制');
  const name = `UX31 首次编制 ${Date.now()}`;
  let versionId = 0;

  trial.step('打开预算版本列表');
  await page.goto('/budget');
  await expect(page.getByText('预算与预测复用同一套编制与定稿机制')).toBeVisible();

  trial.step('点击「创建版本」并填写 2027 年草稿信息');
  await page.getByRole('button', { name: '创建版本' }).click();
  const createModal = page.locator('.ant-modal').filter({ hasText: '创建预算或全年预测草稿' });
  await createModal.locator('.ant-input-number-input').first().fill('2027');
  await createModal.getByPlaceholder('如 年初版 / 年中调整版').fill(name);

  trial.step('确认创建');
  await createModal.getByRole('button', { name: /确\s*定/ }).click();

  trial.step('核对:创建后直接进入新草稿的全部科目编辑视图');
  await expect(page).toHaveURL(/\/budget\/\d+\?sheet=all/);
  versionId = Number(/\/budget\/(\d+)/.exec(page.url())![1]);
  createdVersions.push(versionId);
  await expect(page.getByText(name).first()).toBeVisible();
  const firstCell = page.locator('td[data-gr] input').first();
  await expect(firstCell, '新草稿应直接渲染可编辑明细单元格(无需再找列表行)').toBeVisible(SLOW);
  await trial.shot(page, '01_第一次编制_创建后直接进入编辑.png');

  trial.step('在两家不同单位的列各填一格金额');
  const cellIds: string[] = await page.locator('td[data-gr] input').evaluateAll((els) => els.map((el) => el.id));
  const colOf = (id: string) => id.split('-')[1];
  const firstId = cellIds[0];
  const secondId = cellIds.find((id) => colOf(id) !== colOf(firstId));
  expect(secondId, '网格应包含至少两个组织列的可编辑格').toBeTruthy();
  await typeIntoCell(page, `#${firstId}`, '12.34');
  await typeIntoCell(page, `#${secondId!}`, '56.78');
  await expect(page.locator(`#${firstId}`)).toHaveValue('12.34');
  await expect(page.locator(`#${secondId!}`)).toHaveValue('56.78');

  trial.step('Ctrl+S 立即保存');
  await page.keyboard.press('Control+s');

  trial.step('核对:出现「已保存」状态,且不弹「记录本轮修改」命名框');
  await expect(page.getByText(/已保存 \d{2}:\d{2}/)).toBeVisible(SLOW);
  await expect(page.locator('.ant-modal').filter({ hasText: '记录本轮修改' }), 'Ctrl+S 不应创建编制记录弹窗').toHaveCount(0);
  const checkpoints = await apiGet<{ items: unknown[]; unrecordedChangeCount: number }>(page.request, `/versions/${versionId}/checkpoints`);
  expect(checkpoints.items.length, 'Ctrl+S 只保存数据,不应生成编制记录').toBe(0);
  expect(checkpoints.unrecordedChangeCount).toBeGreaterThan(0);
  await trial.shot(page, '01_第一次编制_CtrlS后已保存.png');
  trial.report('独立完成');
});

/* ================= S2 沿用已有预算 ================= */
test('UX31-S2 沿用已有预算:复制定稿版本,原定稿不变、当前采用不自动变化', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const trial = makeTrialRecorder(testInfo, 'S2 沿用已有预算');

  trial.step('找到 2026 年当前采用的定稿预算版本');
  const versions = await apiGet<VersionRowLite[]>(page.request, '/versions?year=2026');
  const locked = versions.find((v) => v.kind === 'budget' && v.status === 'locked' && v.is_current === 1);
  expect(locked, '夹具应包含 2026 年当前采用的定稿预算').toBeTruthy();

  trial.step('在版本列表对该定稿执行「更多 → 基于此版继续编制」');
  await page.goto('/budget');
  await expect(page.getByText('预算与预测复用同一套编制与定稿机制')).toBeVisible();
  const row = page.locator('tr.ant-table-row').filter({ hasText: locked!.name }).first();
  await row.getByRole('button', { name: '更多' }).click();
  await page.locator('.ant-dropdown-menu-item').filter({ hasText: '基于此版继续编制' }).click();
  const copyModal = page.locator('.ant-modal').filter({ hasText: '复制版本' });
  await expect(copyModal).toBeVisible();
  await trial.shot(page, '02_沿用已有预算_复制确认.png');

  trial.step('确认复制');
  await copyModal.getByRole('button', { name: /确\s*定/ }).click();

  trial.step('核对:进入新草稿且可编辑');
  await expect(page).toHaveURL(/\/budget\/\d+\?sheet=all/);
  const copyId = Number(/\/budget\/(\d+)/.exec(page.url())![1]);
  createdVersions.push(copyId);
  await expect(page.locator('td[data-gr] input').first(), '复制生成的新草稿应可编辑').toBeVisible(SLOW);
  await trial.shot(page, '02_沿用已有预算_新草稿可编辑.png');

  trial.step('核对(界面):原定稿版本页面只读,提供「基于此版继续编制」而不是可写网格');
  await page.goto(`/budget/${locked!.id}`);
  await expect(page.getByText('已定稿(只读)').first()).toBeVisible();
  await expect(page.getByText('基于此版继续编制').first()).toBeVisible();
  await expect(page.locator('td[data-gr] input'), '定稿版本不应渲染任何可编辑输入格').toHaveCount(0);
  await trial.shot(page, '02_沿用已有预算_原定稿只读.png');

  trial.step('核对(API):原定稿状态与当前采用均未变化;定稿版本服务端拒绝原地写入');
  const after = await apiGet<VersionRowLite[]>(page.request, '/versions?year=2026');
  const origAfter = after.find((v) => v.id === locked!.id)!;
  const copyAfter = after.find((v) => v.id === copyId)!;
  expect(origAfter.status).toBe('locked');
  expect(origAfter.is_current, '复制定稿不得自动改变当前采用版本').toBe(1);
  expect(copyAfter.status).toBe('draft');
  expect(copyAfter.is_current).toBe(0);
  const writeLocked = await page.request.fetch(`/api/versions/${locked!.id}/entries`, {
    method: 'PUT',
    headers: { 'x-access-token': token },
    data: { expectedRevision: 1, entries: [{ orgId: 4, accountId: 3, amount: '1.00' }] },
  });
  expect(writeLocked.status(), '定稿版本不可原地修改(服务端必须 409 拒绝)').toBe(409);
  const writeLockedBody = (await writeLocked.json()) as { code?: string; message?: string };
  expect(writeLockedBody.code, '拒绝原因应为业务冲突而非参数错误').toBe('CONFLICT');
  expect(writeLockedBody.message).toContain('只有草稿版本可以编辑明细');
  trial.report('独立完成');
});

/* ================= S3 月度实际更新 ================= */
test('UX31-S3 月度实际更新:录入截至 8 月末累计值,切组织不丢输入,守卫有明确表达', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const trial = makeTrialRecorder(testInfo, 'S3 月度实际更新');

  trial.step('打开 2026 年实际录入页');
  await page.goto('/actual?year=2026');
  /* UX-31 遗留已修复:默认落点改为可填写预设表,新用户首次进入即可直接录入,
     不再需要自己发现并切换到「收入成本表」。此断言锁住该默认落点。 */
  await expect(page.locator('input[id^="actual-cell-"]').first(), '实际页默认应落在含可编辑格的预设表,而非只读利润表').toBeVisible(SLOW);
  /* 网格表头带当前报表名,直接证明默认落点是可填写的预设表(而非只读利润表/一级汇总) */
  await expect(page.locator('th').filter({ hasText: /科目\s*\(收入成本表\)/ }).first(), '默认报表应为可继续录入的预设表').toBeVisible();
  const firstCell = await firstEditableActualCell(page);
  const cellId = firstCell.id;
  const { orgId, accountId } = firstCell;
  trial.note('实际页默认落在可填写预设表(收入成本表),首次进入即有输入格');

  trial.step('录入一格截至本月末的累计值');
  await typeIntoCell(page, `#${cellId}`, '1234.56');
  await expect(page.locator(`#${cellId}`)).toHaveValue('1234.56');
  await expect(page.getByText('● 未保存', { exact: true })).toBeVisible();
  await expect(page.getByText(/待保存修改共 1 项/)).toBeVisible();

  trial.step('切换到不含该组织的「彩石公司」范围(纯查看范围调整)');
  await page.locator('.ant-select').filter({ hasText: '澧水集团' }).first().click();
  const orgDropdown = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').last();
  await orgDropdown.locator('.ant-select-tree-node-content-wrapper').filter({ hasText: '0103 彩石公司' }).first().click();
  await expect(orgDropdown).toBeHidden();
  trial.step('核对:待保存修改计数仍在,且标明不在当前视图');
  await expect(page.getByText(/待保存修改共 1 项/)).toBeVisible();
  await expect(page.getByText(/其中 1 项不在当前视图/)).toBeVisible();
  await trial.shot(page, '03_月度实际更新_切组织后输入保留.png');

  trial.step('切回全部组织,输入原样保留');
  await page.locator('.ant-select').filter({ hasText: '彩石公司' }).first().click();
  const orgDropdown2 = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').last();
  /* 组织树是虚拟滚动,打开时定位在所选节点附近,根节点「01 澧水集团」在视口上方,先滚回顶部 */
  await orgDropdown2.getByText('0103 彩石公司', { exact: true }).first().hover();
  await page.mouse.wheel(0, -4000);
  const rootNode = orgDropdown2.locator('.ant-select-tree-node-content-wrapper').filter({ hasText: '01 澧水集团' }).first();
  await rootNode.scrollIntoViewIfNeeded();
  await rootNode.click();
  await expect(orgDropdown2).toBeHidden();
  await expect(page.locator(`#${cellId}`), '切组织再切回,输入不得丢失').toHaveValue('1234.56', SLOW);

  trial.step('尝试切换维护年度(编辑目标变化):必须出现三选一守卫,选择「留在本页」');
  await page.locator('.ant-select').filter({ hasText: '2026 年' }).first().click();
  const yearDropdown = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').last();
  await yearDropdown.locator('.ant-select-item-option').filter({ hasText: '2025 年' }).first().click();
  const guard = page.locator('.ant-modal').filter({ hasText: '切换编辑目标' });
  await expect(guard, '丢弃本地输入前必须有明确表达(守卫弹窗)').toBeVisible();
  await expect(guard.getByRole('button', { name: '保存并切换' })).toBeVisible();
  await expect(guard.getByRole('button', { name: '放弃修改并切换' })).toBeVisible();
  await guard.getByRole('button', { name: '留在本页' }).click();
  await expect(guard).toBeHidden();
  await expect(page.locator(`#${cellId}`)).toHaveValue('1234.56');
  await trial.shot(page, '03_月度实际更新_年度守卫取消后.png');

  trial.step('选择累计截止日:8 月末');
  await page.getByPlaceholder('选择累计截止日').click();
  await page.locator('.ant-picker-dropdown:visible li').filter({ hasText: '8 月末' }).first().click();
  await expect(page.getByPlaceholder('选择累计截止日')).toHaveValue('2026-08-31');

  trial.step('点击「保存 2026 年实际并生成快照」');
  await page.getByRole('button', { name: /保存 2026 年实际并生成快照/ }).click();

  trial.step('核对:成功结果显示快照批次与期间');
  const success = page.locator('.ant-alert-success').filter({ hasText: '当前实际已更新并生成全量快照' });
  await expect(success).toBeVisible(SLOW);
  await expect(success).toContainText('2026 年 · 截至 2026-08-31');
  await trial.shot(page, '03_月度实际更新_保存成功.png');

  trial.step('核对(API):当前累计与截止日已按输入更新');
  const matrix = await apiGet<ActualMatrixLite>(page.request, '/actual/matrix?year=2026');
  expect(matrix.currentBatch?.snapshot_date).toBe('2026-08-31');
  const entry = matrix.entries.find((e) => e.orgId === orgId && e.accountId === accountId);
  expect(entry, '录入的组织×科目应写入当前累计').toBeTruthy();
  /* 符号口径核对(利润方向:收入为正、成本费用为负),不取绝对值放过符号回归 */
  const accounts = await apiGet<{ rows: { id: number; type: string }[] }>(page.request, '/account/tree');
  const accType = accounts.rows.find((row) => row.id === accountId)?.type;
  expect(accType, '录入科目应能查到类型').toBeTruthy();
  const expectedCents = accType === 'income' ? 1_234_560_000 : -1_234_560_000;
  expect(entry!.amountCents, `1234.56 万元按利润方向落库(科目类型 ${accType})`).toBe(expectedCents);
  trial.report('独立完成');
});

/* ================= S4 历史补录 ================= */
test('UX31-S4 历史补录:补录 6 月末前某历史截止日,当前累计不变', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const trial = makeTrialRecorder(testInfo, 'S4 历史补录');

  trial.step('打开实际录入页(收入成本表)并记录当前累计基线(API)');
  await page.goto('/actual?year=2026&sheet=master');
  await expect(page.locator('input[id^="actual-cell-"]').first()).toBeVisible(SLOW);
  const firstCell = await firstEditableActualCell(page);
  const cellId = firstCell.id;
  const { orgId, accountId } = firstCell;
  const before = await apiGet<ActualMatrixLite>(page.request, '/actual/matrix?year=2026');
  const beforeEntry = before.entries.find((e) => e.orgId === orgId && e.accountId === accountId);
  const beforeBatchId = before.currentBatch?.id ?? null;

  trial.step('切换任务到「补录历史快照」');
  await page.locator('.ant-segmented').filter({ hasText: '补录历史快照' }).getByText('补录历史快照').click();
  await expect(page.getByText('仅补充这个日期的历史记录，不更新当前累计'), '历史任务必须持续标明不更新当前累计').toBeVisible();

  trial.step('选择历史截止日:5 月末');
  await page.getByPlaceholder('选择历史截止日').click();
  await page.locator('.ant-picker-dropdown:visible li').filter({ hasText: '5 月末' }).first().click();
  await expect(page.getByPlaceholder('选择历史截止日')).toHaveValue('2026-05-31');

  trial.step('录入一格历史累计值并保存');
  await typeIntoCell(page, `#${cellId}`, '88.88');
  await expect(page.getByText('● 未保存', { exact: true })).toBeVisible();
  await page.getByRole('button', { name: /补录 2026 年历史快照/ }).click();

  trial.step('核对:成功结果明示「当前累计不变」');
  const success = page.locator('.ant-alert-success').filter({ hasText: '历史快照已补录' });
  await expect(success).toBeVisible(SLOW);
  await expect(success).toContainText('当前累计不变');
  await trial.shot(page, '04_历史补录_保存成功.png');

  trial.step('核对(API):当前累计批次与单元格数值均未变化;新增的是历史快照批次');
  const after = await apiGet<ActualMatrixLite>(page.request, '/actual/matrix?year=2026');
  expect(after.currentBatch?.id, '历史补录不得替换当前累计批次').toBe(beforeBatchId);
  const afterEntry = after.entries.find((e) => e.orgId === orgId && e.accountId === accountId);
  expect(afterEntry?.amountCents ?? null, '历史补录不得覆盖当前累计值').toBe(beforeEntry?.amountCents ?? null);
  const batches = await apiGet<BatchLite[]>(page.request, '/actual/batches?year=2026');
  const historyBatch = batches.find((b) => b.snapshot_date === '2026-05-31' && b.status === 'active');
  expect(historyBatch, '应生成 2026-05-31 的历史快照批次').toBeTruthy();
  expect(historyBatch!.updates_current).toBe(0);
  trial.report('独立完成');
});

/* ================= S7 追查异常 ================= */
test('UX31-S7 追查异常:预警定位到年度执行分析同口径对象,浏览器返回恢复筛选与位置', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const trial = makeTrialRecorder(testInfo, 'S7 追查异常');

  trial.step('打开预警中心,等待异常检测结果');
  await page.goto('/alerts');
  await expect(page.getByTestId('anomaly-summary')).toBeVisible(SLOW);
  const locateLink = page.getByRole('link', { name: '定位到年度执行分析' }).first();
  await expect(locateLink, '夹具应检出可定位的科目/组织预警').toBeVisible();
  const href = await locateLink.getAttribute('href');
  expect(href).toBeTruthy();
  const alertUrl = page.url();
  await trial.shot(page, '07_追查异常_预警中心.png');

  trial.step('点击「定位到年度执行分析」');
  await locateLink.click();

  trial.step('核对:分析页按同口径(年度/版本/快照/对象)展开并高亮目标');
  await expect(page).toHaveURL(/\/analysis\?/);
  const hrefParams = new URLSearchParams(href!.split('?')[1]);
  const pageParams = new URL(page.url()).searchParams;
  for (const key of ['version', 'account', 'org']) {
    const expected = hrefParams.get(key);
    if (expected != null) expect(pageParams.get(key), `分析页 URL 应携带同口径参数 ${key}`).toBe(expected);
  }
  const anchor = page.locator('#analysis-locate-account, #analysis-locate-org').first();
  await expect(anchor, '目标对象应在分析表中定位渲染').toBeAttached();
  await expect(page.locator('.bd-row-locate').first(), '目标行应有高亮样式').toBeAttached();
  await expect(page.getByText('预算版本').first()).toBeVisible();
  await trial.shot(page, '07_追查异常_分析页定位高亮.png');

  trial.step('浏览器返回预警中心');
  await page.goBack();

  trial.step('核对:预警筛选与页面位置恢复,无需重新选择条件');
  await expect(page).toHaveURL(alertUrl);
  await expect(page.getByTestId('anomaly-summary')).toBeVisible();
  await expect(page.getByRole('link', { name: '定位到年度执行分析' }).first()).toBeVisible();
  await trial.shot(page, '07_追查异常_返回预警中心.png');
  trial.report('独立完成');
});

/* ================= S8 中断恢复 ================= */
test('UX31-S8 中断恢复:保存响应丢失后输入保留、不假成功、同编号重试不重复生成快照', async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  const trial = makeTrialRecorder(testInfo, 'S8 中断恢复');

  trial.step('打开实际录入页(收入成本表)并录入一格');
  await page.goto('/actual?year=2026&sheet=master');
  await expect(page.locator('input[id^="actual-cell-"]').first()).toBeVisible(SLOW);
  const cellId = (await firstEditableActualCell(page)).id;
  await typeIntoCell(page, `#${cellId}`, '777.77');
  await expect(page.getByText('● 未保存', { exact: true })).toBeVisible();
  const batchesBefore = await apiGet<BatchLite[]>(page.request, '/actual/batches?year=2026');

  trial.step('拦截保存请求(模拟响应丢失)并点击保存');
  await page.route('**/api/actual/save', (route) => void route.abort());
  await page.getByRole('button', { name: /保存 2026 年实际并生成快照/ }).click();

  trial.step('核对:不显示假成功;输入保留;出现待核对/重试提示');
  const pendingAlert = page.locator('.ant-alert').filter({ hasText: '本次保存未提交成功' });
  await expect(pendingAlert, '响应丢失且回执核对无写入时,必须出现持续的失败/重试提示').toBeVisible(SLOW);
  await expect(page.locator('.ant-alert-success').filter({ hasText: '已更新并生成全量快照' }), '失败时绝不显示保存成功').toHaveCount(0);
  /* 待核对期间编辑目标锁定,格子回到只读展示;草稿保留由待保存计数证明,值在重试成功后回落到格子 */
  await expect(page.getByText(/待保存修改共 1 项/), '输入不得静默丢弃(待保存计数仍在)').toBeVisible();
  await expect(page.getByText('● 未保存', { exact: true })).toBeVisible();
  const alertText = await pendingAlert.textContent();
  const requestId = /请求编号 ([\w-]+)/.exec(alertText ?? '')?.[1];
  expect(requestId, '提示中应给出可核对的请求编号').toBeTruthy();
  await trial.shot(page, '08_中断恢复_响应丢失待核对.png');

  trial.step('核对(API):失败期间没有生成快照、没有已提交回执');
  const batchesDuring = await apiGet<BatchLite[]>(page.request, '/actual/batches?year=2026');
  expect(batchesDuring.length, '保存未提交不得生成快照批次').toBe(batchesBefore.length);
  const receiptBefore = await page.request.get(`/api/actual/save-requests/${requestId}`, { headers: { 'x-access-token': token } });
  expect(receiptBefore.status()).toBe(404);

  trial.step('放行网络,用相同请求编号重试');
  await page.unroute('**/api/actual/save');
  await page.getByRole('button', { name: '相同请求编号重试' }).click();

  trial.step('核对:重试成功且只生成一个快照批次');
  const success = page.locator('.ant-alert-success').filter({ hasText: '当前实际已更新并生成全量快照' });
  await expect(success).toBeVisible(SLOW);
  const batchesAfter = await apiGet<BatchLite[]>(page.request, '/actual/batches?year=2026');
  expect(batchesAfter.length, '同编号重试不得重复生成快照').toBe(batchesBefore.length + 1);
  const receipt = await apiGet<{ committed: true; batchId: number }>(page.request, `/actual/save-requests/${requestId}`);
  expect(receipt.committed).toBe(true);
  await expect(success).toContainText(`批次 #${receipt.batchId}`);
  await expect(page.getByText('无未保存修改')).toBeVisible(SLOW);
  await expect(page.locator(`#${cellId}`), '重试成功后,中断前的输入值应落在格子中').toHaveValue('777.77', SLOW);
  await trial.shot(page, '08_中断恢复_重试成功.png');
  trial.report('独立完成');
});

/* ================= S9 数字核对 ================= */
test('UX31-S9 数字核对:混合金额/负数冲回/数量/零值/细小差额,精度与后端一致且不混算', async ({ page }, testInfo) => {
  test.setTimeout(300_000);
  const trial = makeTrialRecorder(testInfo, 'S9 数字核对');

  trial.step('建立 2026 年临时草稿(API),并用 API 预置一格 0.49 元(显示为 0.00 万元的细小差额)');
  const created = await apiSend<{ id: number; revision: number }>(page.request, 'POST', '/versions', {
    year: 2026, kind: 'budget', name: `UX31 数字核对 ${Date.now()}`, note: 'UX-31 数字核对场景,跑完即删',
  });
  createdVersions.push(created.id);
  const matrix0 = await apiGet<MatrixLite>(page.request, `/versions/${created.id}/matrix`);
  const orgIdByCode = new Map(matrix0.orgNodes.map((o) => [o.code, o.id]));
  const accIdByCode = new Map(matrix0.accountNodes.map((a) => [a.code, a.id]));
  const jy = orgIdByCode.get('010102')!; // 江垭电站
  const zs = orgIdByCode.get('010103')!; // 皂市电站
  const i1101 = accIdByCode.get('I1101')!; // 上网电量收入(收入)
  const c1101 = accIdByCode.get('C1101')!; // 制造费用(成本)
  const q101 = accIdByCode.get('Q101')!; // 上网电量(数量,万度)
  await apiSend(page.request, 'PUT', `/versions/${created.id}/entries`, {
    expectedRevision: created.revision,
    entries: [{ orgId: jy, accountId: i1101, amount: '0.49' }],
  });

  trial.step('打开草稿的全部科目视图');
  await page.goto(`/budget/${created.id}?sheet=all`);
  await expect(page.locator('td[data-gr] input').first()).toBeVisible(SLOW);

  trial.step('核对:0.49 元在单元格按万元两位显示为 0.00(精度不由显示值判断)');
  await expect(page.locator(`#cell-${jy}-${i1101}`)).toHaveValue('0.00');

  trial.step('录入:皂市收入 100.00 万元;江垭成本 -2.50 万元(冲回);江垭数量 2500.5000 万度;皂市成本 0(零值)');
  await typeIntoCell(page, `#cell-${zs}-${i1101}`, '100.00');
  await typeIntoCell(page, `#cell-${jy}-${c1101}`, '-2.50');
  await typeIntoCell(page, `#cell-${jy}-${q101}`, '2500.5000');
  await typeIntoCell(page, `#cell-${zs}-${c1101}`, '0');

  trial.step('核对:数量格给出计量单位说明(悬停 title)');
  await expect(page.locator(`#cell-${jy}-${q101}`)).toHaveAttribute('title', /数量单位：万度/);
  await expect(page.locator(`#cell-${jy}-${c1101}`)).toHaveAttribute('title', /负数表示冲回/);

  trial.step('Ctrl+S 保存');
  await page.keyboard.press('Control+s');
  await expect(page.getByText(/已保存 \d{2}:\d{2}/)).toBeVisible(SLOW);

  trial.step('核对(API 整数分/缩放数量):金额、冲回符号、数量各自精确落库');
  const matrix = await apiGet<MatrixLite>(page.request, `/versions/${created.id}/matrix`);
  const entryOf = (orgId: number, accountId: number) => matrix.entries.find((e) => e.orgId === orgId && e.accountId === accountId);
  expect(entryOf(jy, i1101)?.amountCents, '0.49 元必须保分为 49 分,不被显示舍入吞掉').toBe(49);
  expect(entryOf(zs, i1101)?.amountCents).toBe(100_000_000); // 100.00 万元
  expect(entryOf(jy, c1101)?.amountCents, '成本冲回 -2.50 万元按利润方向存为 +2,500,000 分').toBe(2_500_000);
  const zeroEntry = entryOf(zs, c1101);
  expect(!zeroEntry || zeroEntry.amountCents === 0, '零值要么显式为 0 要么无条目,不得被改成其他值').toBeTruthy();
  expect(entryOf(jy, q101)?.quantity, '数量按 10^4 缩放独立存储').toBe('2500.5');
  expect(entryOf(jy, q101)?.amountCents ?? 0, '数量科目不得产生金额').toBe(0);

  trial.step('核对:选区混合金额与数量时,数量不参与金额求和');
  await page.locator(`#cell-${jy}-${i1101}`).click();
  await page.keyboard.press('Shift+ArrowDown');
  await page.locator(`#cell-${jy}-${q101}`).click({ modifiers: ['Shift'] });
  await expect(page.getByText(/数量 \d+ 格（不参与金额求和）/)).toBeVisible();
  await expect(page.getByText(/求和 [\d.,-]+ 万元/).first()).toBeVisible();
  await trial.shot(page, '09_数字核对_数量不混算.png');

  trial.step('核对:悬停精确到元(含 0.49 元细小差额进入合计)');
  await expect(
    page.locator('.bd-money-text[title="精确值 1,000,000.49 元"]').first(),
    '营业收入合计应为 100.00 万元 + 0.49 元 = 1,000,000.49 元,悬停可核对精确元(指标汇总表多指标可能同值,取首处)',
  ).toBeAttached();
  await trial.shot(page, '09_数字核对_汇总与精确值.png');
  trial.report('独立完成');
});
