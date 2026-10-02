import type { Page } from '@playwright/test';
import { expect, test } from './access';

async function ask(page: Page, text = '检查当前修改') {
  const request = page.waitForRequest((r) => r.url().includes('/api/assistant/chat/stream') && r.method() === 'POST');
  await page.getByTestId('assistant-dock-input').fill(text);
  await page.getByTestId('assistant-dock-send').click();
  const body = (await request).postDataJSON();
  await expect(page.getByTestId('assistant-dock-stop')).toHaveCount(0, { timeout: 30000 });
  await expect(page.getByTestId('assistant-dock-answer').last()).not.toBeEmpty({ timeout: 30000 });
  return body;
}

for (const entry of [
  { path: '/metric', button: '新建金额指标', kind: 'metric_formula', field: '指标名称' },
  { path: '/data?tab=calculations', button: '新增测算模板', kind: 'calculation_rule', field: '模板名称' },
  { path: '/org', button: '新增根节点', kind: 'org_form', field: '名称' },
  { path: '/account', button: '新增根科目', kind: 'account_form', field: '名称' },
]) {
  test(entry.kind + ' 实际表单、字段帮助、未保存与关闭清理', async ({ page }) => {
    await page.goto(entry.path);
    if (entry.kind === 'account_form') {
      await page.locator('.newfc-root-card .ant-select-selector').first().click();
      await page.locator('.ant-select-dropdown:visible').getByText('全部科目(完整树)', { exact: true }).click();
    }
    await page.getByRole('button', { name: entry.button, exact: true }).first().click();
    const dialog = page.locator('.ant-modal:visible').last();
    await expect(dialog.getByText('当前修改未保存')).toBeVisible();
    let requests = 0;
    page.on('request', (r) => { if (r.url().includes('/api/assistant/chat')) requests++; });
    const name = dialog.locator('.ant-form-item').filter({ has: page.locator('label', { hasText: entry.field }) }).first().locator('input').first();
    await name.fill('T8未保存样本');
    await expect(name).toHaveValue('T8未保存样本');
    expect(requests).toBe(0);
    await dialog.getByRole('button', { name: '检查当前修改', exact: true }).click();
    const body = await ask(page);
    expect(body).not.toHaveProperty('context');
    expect(body.pageContext.draft.kind).toBe(entry.kind);
    expect(body.pageContext.draft.base.operation).toBe('create');
    expect(body.pageContext.draft.changes.name).toBe('T8未保存样本');
    await expect(page.getByTestId('assistant-dock-answer').last()).toContainText('未保存');
    await dialog.getByRole('combobox', { name: '字段帮助' }).click();
    await page.locator('.ant-select-dropdown:visible').getByText('名称', { exact: true }).first().click();
    const fieldBody = await ask(page, '这个字段有什么约束');
    expect(fieldBody.pageContext.focus).toEqual({ kind: 'form_field', formKind: entry.kind, field: 'name' });
    await expect(name).toHaveValue('T8未保存样本');
    await page.getByRole('button', { name: '关闭助手', exact: true }).click();
    await dialog.getByRole('button', { name: /取\s*消/ }).click();
    await page.getByTestId('assistant-dock-trigger').click();
    const cleared = await ask(page, '当前页面有哪些信息');
    expect(cleared.pageContext.draft).toBeNull(); expect(cleared.pageContext.focus).toBeNull();
  });
}

test('别名表单与 refs/query 使用实际筛选、换页签清理', async ({ page, request }) => {
  const sourceText = 'T8选区上海' + Date.now();
  const idResponse = await request.post('/api/io/cleaning/aliases', { data: { targetKind: 'budget', mappingKind: 'org', sourceText, targetCode: 'SH' } });
  expect(idResponse.ok()).toBeTruthy(); const alias = await idResponse.json() as { id: number };
  try {
    await page.goto('/cleaning-config');
    await page.locator('.newfc-root-card .ant-select-selector').first().click();
    await page.locator('.ant-select-dropdown:visible').getByText('预算填报', { exact: true }).click();
    await page.getByRole('tab', { name: '清洗别名' }).click();
    await page.getByRole('button', { name: '新增别名', exact: true }).first().click();
    const dialog = page.locator('.ant-modal:visible').last();
    await dialog.getByLabel('来源文本').fill('T8未保存别名');
    await dialog.getByRole('button', { name: '检查当前修改', exact: true }).click();
    const draft = await ask(page); expect(draft.pageContext.draft.kind).toBe('alias_rule');
    await dialog.getByRole('combobox', { name: '字段帮助' }).click();
    await page.locator('.ant-select-dropdown:visible').getByText('目标编码', { exact: true }).click();
    expect((await ask(page, '解释当前字段')).pageContext.focus).toEqual({ kind: 'form_field', formKind: 'alias_rule', field: 'targetCode' });
    await page.getByRole('button', { name: '关闭助手', exact: true }).click();
    await dialog.getByRole('button', { name: /取\s*消/ }).click();
    const row = page.getByRole('row').filter({ hasText: sourceText });
    await row.getByRole('checkbox').check();
    await page.getByRole('button', { name: '分析选中项', exact: true }).click();
    const selected = await ask(page, '检查当前选择'); expect(selected.pageContext.selection).toEqual({ mode: 'refs', refs: [{ entityType: 'alias_rule', id: alias.id }] });
    await page.getByRole('button', { name: '关闭助手', exact: true }).click();
    await page.getByLabel('筛选别名', { exact: true }).fill(sourceText);
    await page.getByLabel('筛选别名', { exact: true }).press('Enter');
    await page.getByRole('button', { name: '分析当前筛选结果', exact: true }).click();
    const query = await ask(page, '检查筛选结果'); expect(query.pageContext.selection.mode).toBe('query'); expect(query.pageContext.selection.query.search).toBe(sourceText);
    await expect(page.getByTestId('assistant-dock-answer').last()).toContainText('1 个对象');
    await page.getByRole('button', { name: '关闭助手', exact: true }).click();
    await page.getByRole('tab', { name: '清洗模板' }).click();
    await page.getByTestId('assistant-dock-trigger').click();
    expect((await ask(page, '解释清洗模板')).pageContext.selection).toBeNull();
  } finally { await request.delete('/api/io/cleaning/aliases/' + alias.id); }
});

test('指标实际多选与筛选结果入口；编辑清空选择', async ({ page }) => {
  await page.goto('/metric');
  await page.getByRole('row').nth(1).getByRole('checkbox').check();
  await page.getByRole('button', { name: '分析选中项', exact: true }).click();
  const refs = await ask(page, '解释选择的公式'); expect(refs.pageContext.selection.mode).toBe('refs');
  await expect(page.getByTestId('assistant-dock-answer').last()).toContainText('1 个对象');
  await page.getByRole('button', { name: '关闭助手', exact: true }).click();
  await page.getByRole('button', { name: '分析当前筛选结果', exact: true }).click();
  expect((await ask(page, '检查筛选结果')).pageContext.selection.mode).toBe('query');
  await page.getByRole('button', { name: '关闭助手', exact: true }).click();
  await page.getByRole('button', { name: /编\s*辑/ }).first().click();
  const dialog = page.locator('.ant-modal:visible').last();
  await dialog.getByRole('button', { name: '检查当前修改', exact: true }).click();
  const edit = await ask(page); expect(edit.pageContext.selection).toBeNull(); expect(edit.pageContext.draft.base.operation).toBe('update');
});

test('清洗向导使用当前用户文件只读分析，窄屏可以操作助手', async ({ page, request }) => {
  const response = await request.post('/api/versions', { data: { year: 2026, name: 'T8清洗只读' + Date.now() } });
  expect(response.ok()).toBeTruthy(); const version = await response.json() as { id: number; revision: number };
  expect((await request.put('/api/versions/' + version.id + '/entries', { data: { expectedRevision: version.revision, entries: [{ orgId: 3, accountId: 2, amount: '10.00' }] } })).ok()).toBeTruthy();
  const buffer = await (await request.get('/api/io/export/budget-detail/' + version.id)).body();
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/budget/' + version.id);
  await page.getByRole('button', { name: '导入 Excel', exact: true }).first().click();
  await page.getByRole('button', { name: '打开清洗向导', exact: true }).click();
  const dialog = page.locator('.ant-modal:visible').filter({ hasText: '导入非标准 Excel' });
  await dialog.locator('input[type=file]').setInputFiles({ name: 'T8合成.xlsx', mimeType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet', buffer });
  await expect(dialog.getByRole('button', { name: '检查当前修改', exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: '检查当前修改', exact: true }).click();
  const body = await ask(page, '解释当前清洗配置');
  expect(body.pageContext.draft.kind).toBe('cleaning_template'); expect(body.pageContext.draft.base.source.token).toBeTruthy();
  await expect(page.getByTestId('assistant-dock-answer').last()).toContainText('未保存');
  await page.getByRole('button', { name: '关闭助手', exact: true }).click();
  await dialog.getByRole('combobox', { name: '字段帮助' }).fill('表头行');
  await page.locator('.ant-select-dropdown:visible').getByText('表头行', { exact: true }).click();
  await expect(dialog.locator('input[data-assistant-field="headerRow"], [data-assistant-field="headerRow"] input').first()).toBeFocused();
  await dialog.getByRole('button', { name: '询问当前字段', exact: true }).click();
  const field = await ask(page, '解释表头行');
  expect(field.pageContext.focus).toEqual({ kind: 'form_field', formKind: 'cleaning_template', field: 'headerRow' });
});

test('比率公式的实际分子分母可检查，保持未保存且不重算历史', async ({ page }) => {
  await page.goto('/metric');
  await page.getByRole('button', { name: '新建比率指标', exact: true }).click();
  const dialog = page.locator('.ant-modal:visible').last();
  await dialog.getByLabel('指标编码').fill('T8_RATIO_DRAFT');
  await dialog.getByLabel('指标名称').fill('T8比率草稿');
  for (const label of ['分子', '分母']) {
    const side = dialog.locator('.ant-form-item').filter({ has: page.locator('label', { hasText: label }) }).first();
    await side.locator('.ant-tree-select .ant-select-selector').click();
    await page.locator('.ant-select-dropdown:visible .ant-select-tree-title:visible').filter({ hasText: /I01 / }).first().click();
    await expect(page.locator('.ant-select-dropdown:visible')).toHaveCount(0);
  }
  await dialog.getByRole('button', { name: '检查当前修改', exact: true }).click();
  const body = await ask(page, '解释当前比率公式与依赖');
  expect(body.pageContext.draft.changes.kind).toBe('ratio');
  expect(body.pageContext.draft.changes.terms.map((t: any) => t.role)).toEqual(['numerator', 'denominator']);
  await expect(page.getByTestId('assistant-dock-answer').last()).toContainText('已有定稿快照不会重算');
});
