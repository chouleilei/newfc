import { expect, test, type APIRequestContext } from '@playwright/test';
import { login } from './access';

/**
 * 预算编制网格交互的浏览器级兜底:单测已覆盖 useGridInteraction 的全部逻辑,
 * 这里只验证「真实 DOM 坐标(data-gr/data-gc)↔ hook 几何索引」的接线——
 * 这类错位会把金额静默写进错误的科目,是最危险且单测够不着的一层。
 *
 * 每条用例自带一份临时草稿版本(2029 年),跑完即删,不污染夹具数据。
 */

async function api(
  request: APIRequestContext,
  token: string,
  method: string,
  route: string,
  data?: unknown,
) {
  const response = await request.fetch(`/api${route}`, {
    method,
    headers: { 'x-access-token': token },
    data,
  });
  expect(response.ok(), `${method} ${route}: ${response.status()} ${await response.text()}`).toBeTruthy();
  return response;
}

let token = '';
const createdVersions: number[] = [];

test.use({ permissions: ['clipboard-read', 'clipboard-write'] });

test.beforeEach(async ({ page }) => {
  token = await login(page);
});

test.afterAll(async ({ request }) => {
  for (const id of createdVersions.reverse()) {
    await request.fetch(`/api/versions/${id}`, { method: 'DELETE', headers: { 'x-access-token': token } }).catch(() => undefined);
  }
});

/** 建一份 2029 年空草稿并打开编制页,切到「管理类费用表」预设表
 *  (UX-06 起新草稿默认落在「全部科目」视图,不再是只读的「利润表」) */
async function openFreshDraft(page: Parameters<typeof login>[0], suffix: string): Promise<number> {
  const draft = await (await api(page.request, token, 'POST', '/versions', {
    year: 2029, kind: 'budget', name: `E2E网格交互${suffix}`, note: '网格交互测试,跑完即删',
  })).json() as { id: number };
  createdVersions.push(draft.id);
  await page.goto(`/budget/${draft.id}`);
  // 已选值标签会盖住下拉输入框,点击 Select 容器而不是输入框
  await page.locator('.ant-select').filter({ has: page.locator('#budget-sheet-select') }).click();
  const sheetDropdown = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').last();
  await sheetDropdown.locator('.ant-select-item-option', { hasText: '管理类费用表' }).first().click();
  await expect(sheetDropdown).toBeHidden();
  const firstCell = page.locator('td[data-gr] input').first();
  await expect(firstCell, '编制页网格未渲染出可编辑单元格').toBeVisible();
  return draft.id;
}

const cellInput = (page: Parameters<typeof login>[0], r: number, c: number) =>
  page.locator(`td[data-gr="${r}"][data-gc="${c}"] input`);

/** 读取某 input 所在 td 的网格坐标 */
const coordsOf = (input: ReturnType<typeof cellInput>) =>
  input.evaluate((el) => {
    const td = el.closest('td')!;
    return { r: Number(td.getAttribute('data-gr')), c: Number(td.getAttribute('data-gc')) };
  });

test('单格录入、Enter 下移与 Ctrl+Z/Ctrl+Y 撤销重做', async ({ page }) => {
  await openFreshDraft(page, '编辑撤销');

  const first = page.locator('td[data-gr] input').first();
  const { r, c } = await coordsOf(first);
  const startId = await first.getAttribute('id');

  // 录入并回车提交:值落在原格,焦点沿 Tab 序下移一格(跳过只读行)
  await first.click();
  await page.keyboard.type('123');
  await page.keyboard.press('Enter');
  await expect(cellInput(page, r, c)).toHaveValue('123');
  const movedId = await page.evaluate(() => document.activeElement?.id ?? '');
  expect(movedId.startsWith('cell-'), 'Enter 后焦点应落在网格输入框内').toBeTruthy();
  expect(movedId, 'Enter 后焦点应移动到下一可编辑格').not.toBe(startId);

  // Ctrl+Z 撤销清空,Ctrl+Y 重做恢复
  await cellInput(page, r, c).click();
  await page.keyboard.press('Control+z');
  await expect(cellInput(page, r, c)).toHaveValue('');
  await page.keyboard.press('Control+y');
  await expect(cellInput(page, r, c)).toHaveValue('123');
});

test('矩阵粘贴按坐标精确落位,Shift 选区 + Delete 批量清空', async ({ page }) => {
  await openFreshDraft(page, '粘贴清空');

  // 找一个四个角都可编辑的 2×2 块(只读格不渲染 data-gr,几何索引可能跳号)
  const block = await page.evaluate(() => {
    const byRow = new Map<number, Set<number>>();
    for (const td of document.querySelectorAll('td[data-gr][data-gc]')) {
      const r = Number(td.getAttribute('data-gr'));
      const c = Number(td.getAttribute('data-gc'));
      if (!byRow.has(r)) byRow.set(r, new Set());
      byRow.get(r)!.add(c);
    }
    const rows = [...byRow.keys()].sort((a, b) => a - b);
    for (const r of rows) {
      if (!byRow.has(r + 1)) continue;
      const cols = [...byRow.get(r)!].filter((c) => byRow.get(r + 1)!.has(c)).sort((a, b) => a - b);
      for (const c of cols) {
        if (byRow.get(r)!.has(c + 1) && byRow.get(r + 1)!.has(c + 1)) return { r, c };
      }
    }
    return null;
  });
  expect(block, '网格中找不到四角均可编辑的 2×2 区域').toBeTruthy();
  const { r, c } = block!;

  // 系统剪贴板写入 TSV,真实 Ctrl+V 触发粘贴引擎
  await page.evaluate((text) => navigator.clipboard.writeText(text), '10\t20\n30\t40');
  await cellInput(page, r, c).click();
  await page.keyboard.press('Control+v');
  await expect(page.getByText(/批量粘贴/).first(), '粘贴后应出现结果反馈').toBeVisible();
  await expect(cellInput(page, r, c)).toHaveValue('10');
  await expect(cellInput(page, r, c + 1)).toHaveValue('20');
  await expect(cellInput(page, r + 1, c)).toHaveValue('30');
  await expect(cellInput(page, r + 1, c + 1)).toHaveValue('40');

  // Shift+方向键扩出 2×2 选区,Delete 一步清空
  await cellInput(page, r, c).click();
  await page.keyboard.press('Shift+ArrowDown');
  await page.keyboard.press('Shift+ArrowRight');
  await page.keyboard.press('Delete');
  await expect(page.getByText(/已清空 4 格/).first()).toBeVisible();
  await expect(cellInput(page, r, c)).toHaveValue('');
  await expect(cellInput(page, r, c + 1)).toHaveValue('');
  await expect(cellInput(page, r + 1, c)).toHaveValue('');
  await expect(cellInput(page, r + 1, c + 1)).toHaveValue('');
});
