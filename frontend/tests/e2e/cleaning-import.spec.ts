import { type Locator, type Page } from '@playwright/test';
import { expect, test } from './access';

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';

async function chooseSelect(page: Page, row: Locator, label: string) {
  await row.locator('.ant-select-selector').click();
  const dropdown = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').last();
  const option = dropdown.locator('.ant-select-item-option').filter({ hasText: label }).first();
  await expect(option).toBeVisible();
  await option.click();
  await expect(dropdown).toBeHidden();
}

test('非标准 Excel 六步向导覆盖区域、重分析、批量映射、排除、分页筛选、确认与模板复用', async ({ page, request }) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(15_000);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const versionResponse = await request.post('/api/versions', {
    data: { year: 2026, name: `清洗向导 E2E ${suffix}` },
  });
  expect(versionResponse.ok()).toBeTruthy();
  const version = await versionResponse.json() as { id: number; revision: number };
  let templateId: number | undefined;
  let aliasId: number | undefined;

  try {
    const saved = await request.put(`/api/versions/${version.id}/entries`, {
      data: {
        expectedRevision: version.revision,
        entries: [
          { orgId: 3, accountId: 2, amount: '10', note: '普通收入' },
          { orgId: 3, accountId: 4, amount: '20', note: '普通成本' },
          { orgId: 3, accountId: 6, amount: '30', note: '合计测试：由用户明确排除' },
        ],
      },
    });
    expect(saved.ok()).toBeTruthy();
    const exported = await request.get(`/api/io/export/budget-detail/${version.id}`);
    expect(exported.ok()).toBeTruthy();
    const workbookBuffer = await exported.body();

    await page.goto(`/budget/${version.id}`);
    // 页头标题(含年份前缀)与范围条(UX-04)都会显示版本名,用精确匹配只命中范围条
    await expect(page.getByText(`清洗向导 E2E ${suffix}`, { exact: true })).toBeVisible();
    // UX-13:导入入口已提升为页头可见按钮,先按文件来源选择导入方式
    await page.getByRole('button', { name: '导入 Excel', exact: true }).first().click();
    const entryModal = page.locator('.ant-modal').filter({ hasText: '请按文件来源选择导入方式' });
    await expect(entryModal.getByText('非标准 Excel 清洗')).toBeVisible();
    await entryModal.getByRole('button', { name: '打开清洗向导' }).click();
    const wizard = page.locator('.ant-modal').filter({ hasText: '导入非标准 Excel' });
    await expect(wizard).toBeVisible();

    const uploadDone = page.waitForResponse((response) => response.url().endsWith('/api/io/cleaning/workbook') && response.request().method() === 'POST');
    await wizard.locator('input[type=file]').setInputFiles({ name: '非标准预算明细.xlsx', mimeType: XLSX_MIME, buffer: workbookBuffer });
    const uploadResponse = await uploadDone;
    expect(uploadResponse.status()).toBe(201);
    const uploaded = await uploadResponse.json() as {
      sheets: { name: string; rowCount: number; sampleRows: { row: number; cells: { text: string }[] }[] }[];
    };
    const sourceSheet = uploaded.sheets[0];
    const headerRow = sourceSheet.sampleRows.find((row) => row.cells.some((cell) => cell.text === '组织编码'))?.row;
    expect(headerRow).toBeTruthy();
    const dataStartRow = headerRow! + 1;
    const dataEndRow = sourceSheet.rowCount;

    await wizard.getByRole('button', { name: /下一步/ }).click();
    await expect(wizard.getByText('工作表和区域', { exact: true })).toBeVisible();
    await wizard.locator(`tr[data-row-key="${headerRow}"] button`).nth(0).click();
    await wizard.locator(`tr[data-row-key="${dataStartRow}"] button`).nth(1).click();
    await wizard.locator(`tr[data-row-key="${dataEndRow}"] button`).nth(2).click();
    await wizard.getByRole('button', { name: /下一步/ }).click();

    await expect(wizard.getByText('列和口径', { exact: true })).toBeVisible();
    await chooseSelect(page, wizard.locator('tr[data-row-key="2"]'), '组织编码');
    await chooseSelect(page, wizard.locator('tr[data-row-key="3"]'), '科目编码');
    await chooseSelect(page, wizard.locator('tr[data-row-key="6"]'), '金额');
    await chooseSelect(page, wizard.locator('tr[data-row-key="10"]'), '备注');
    await wizard.getByText('万元', { exact: true }).click();
    await wizard.getByRole('button', { name: /下一步/ }).click();
    await expect(wizard.getByText('解析错误与未决映射均为 0，可以检查导入结果。')).toBeVisible();

    // 返回修改列语义，再次分析；组织路径只产生一个按源文本分组的未决项。
    await wizard.getByRole('button', { name: '上一步', exact: true }).click();
    const orgCodeRow = wizard.locator('tr[data-row-key="2"]');
    await chooseSelect(page, orgCodeRow, '组织名称');
    await wizard.getByRole('button', { name: /下一步/ }).click();
    await expect(wizard.getByText('按相同源文本批量匹配（一次选择应用到全部对应行）')).toBeVisible();
    const unresolvedCard = wizard.locator('.ant-card').filter({ hasText: '按相同源文本批量匹配' });
    const unresolvedRow = unresolvedCard.locator('tbody tr').filter({ hasText: 'SH' }).first();
    await unresolvedRow.locator('.ant-select-selector').click();
    const targetDropdown = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').last();
    await targetDropdown.locator('.ant-select-item-option').filter({ hasText: 'SH ·' }).first().click();
    await expect(targetDropdown).toBeHidden();
    await unresolvedRow.locator('button').filter({ hasText: '存别名' }).click();
    await expect(page.getByText(/已保存别名/)).toBeVisible();
    await wizard.getByRole('button', { name: '重新分析 / 批量接受唯一精确匹配' }).click();
    await expect(wizard.getByText('解析错误与未决映射均为 0，可以检查导入结果。')).toBeVisible();

    const suspectedCard = wizard.locator('.ant-card').filter({ hasText: '疑似小计、标题或备注行' });
    await expect(suspectedCard).toContainText('疑似小计或合计行');
    await expect(suspectedCard).toContainText(`${sourceSheet.name}!${dataEndRow}`);
    await suspectedCard.locator('input[type=checkbox]').first().check();
    await wizard.getByRole('button', { name: '重新分析 / 批量接受唯一精确匹配' }).click();
    await expect(wizard.getByText('已排除 1 行')).toBeVisible();

    // 换文件只复用结构配置，旧文件的排除坐标不能带入新文件。
    for (let index = 0; index < 3; index++) await wizard.getByRole('button', { name: '上一步', exact: true }).click();
    const replacementUpload = page.waitForResponse((response) => response.url().endsWith('/api/io/cleaning/workbook') && response.request().method() === 'POST');
    await wizard.locator('input[type=file]').setInputFiles({ name: '替换后的预算明细.xlsx', mimeType: XLSX_MIME, buffer: workbookBuffer });
    expect((await replacementUpload).status()).toBe(201);
    await wizard.getByRole('button', { name: /下一步/ }).click();
    await wizard.getByRole('button', { name: /下一步/ }).click();
    const replacementAnalyze = page.waitForRequest((request) => request.url().endsWith('/api/io/cleaning/analyze') && request.method() === 'POST');
    await wizard.getByRole('button', { name: /下一步/ }).click();
    const replacementBody = (await replacementAnalyze).postDataJSON() as { plan: { excludedRows: unknown[] } };
    expect(replacementBody.plan.excludedRows).toEqual([]);
    await expect(wizard.getByText('排除行 0', { exact: true })).toBeVisible();
    const replacementSuspectedCard = wizard.locator('.ant-card').filter({ hasText: '疑似小计、标题或备注行' });
    const replacementExclusion = replacementSuspectedCard.locator('input[type=checkbox]').first();
    await expect(replacementExclusion).not.toBeChecked();

    // 后续预览仍需要排除夹具中的合计测试行，重新勾选并分析。
    await replacementExclusion.check();
    await wizard.getByRole('button', { name: '重新分析 / 批量接受唯一精确匹配' }).click();
    await expect(wizard.getByText('已排除 1 行')).toBeVisible();

    // 真实 pending 批次仍由后端创建；逐行接口扩成 201 行，以浏览器验证分页和筛选请求。
    const rowQueries: string[] = [];
    await page.route(/\/api\/io\/cleaning\/previews\/\d+\/rows/, async (route) => {
      const url = new URL(route.request().url());
      rowQueries.push(url.search);
      const currentPage = Number(url.searchParams.get('page') ?? 1);
      const pageSize = Number(url.searchParams.get('pageSize') ?? 100);
      const total = 201;
      const start = (currentPage - 1) * pageSize;
      const count = Math.max(0, Math.min(pageSize, total - start));
      await route.fulfill({
        status: 200,
        contentType: 'application/json',
        body: JSON.stringify({
          total,
          page: currentPage,
          pageSize,
          items: Array.from({ length: count }, (_, index) => ({
            id: start + index + 1,
            sheet_name: sourceSheet.name,
            row_number: dataStartRow + start + index,
            source_org_text: 'SH',
            source_account_text: `科目 ${start + index + 1}`,
            source_value_text: '10',
            target_org_code: 'SH',
            target_account_code: 'I01',
            normalized_value: '100000.00',
            expected_value_text: '100000.00',
            action: 'overwrite',
            warning: '使用名称或别名完成匹配',
          })),
        }),
      });
    });

    await wizard.getByRole('button', { name: /检查导入结果/ }).click();
    await expect(wizard.getByText(/已创建待确认批次/)).toBeVisible();
    await expect(wizard.getByRole('columnheader', { name: '预计最终利润方向值（元）' })).toBeVisible();
    await expect(wizard.getByText('按组织与一级科目变化（元，利润方向）')).toBeVisible();
    const previewTable = wizard.locator('.ant-table-wrapper').filter({ hasText: '预计最终利润方向值（元）' });
    await expect(previewTable.locator('.ant-pagination-item')).toHaveCount(3);
    await previewTable.locator('.ant-pagination-next button').click();
    await expect.poll(() => rowQueries.some((query) => query.includes('page=2'))).toBe(true);
    await wizard.locator('.ant-select').filter({ hasText: '按动作筛选' }).locator('input[role=combobox]').click();
    const actionDropdown = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').last();
    await actionDropdown.locator('.ant-select-item-option').filter({ hasText: '覆盖' }).click();
    await expect(actionDropdown).toBeHidden();
    await expect.poll(() => rowQueries.some((query) => query.includes('action=overwrite'))).toBe(true);
    await wizard.locator('label.ant-checkbox-wrapper').filter({ hasText: '仅看警告行' }).locator('input').check();
    await expect.poll(() => rowQueries.some((query) => query.includes('warningOnly=true'))).toBe(true);

    // UX-17:临确认修改配置——恢复原文件与全部配置,无需重复上传有效原件;
    // 旧预览取消、重新分析生成全新预览,覆盖勾选不沿用到新差异。
    const reopenResponse = page.waitForResponse((response) => /\/api\/io\/cleaning\/previews\/\d+\/reopen$/.test(response.url()) && response.request().method() === 'POST');
    await wizard.getByRole('button', { name: '修改导入配置', exact: true }).click();
    const reopenConfirm = page.locator('.ant-modal-confirm').filter({ hasText: '修改导入配置' });
    await reopenConfirm.getByRole('button', { name: /恢复并修改配置/ }).click();
    expect((await reopenResponse).status()).toBe(201);
    // 回到配置步骤,区域行范围从原计划恢复
    await expect(wizard.locator('input.ant-input-number-input').nth(0)).toHaveValue(String(headerRow));
    await expect(wizard.locator('input.ant-input-number-input').nth(1)).toHaveValue(String(dataStartRow));
    await wizard.getByRole('button', { name: /下一步/ }).click();
    // 列映射已恢复(无需重新选择)
    await expect(wizard.locator('tr[data-row-key="2"]')).toContainText('组织编码');
    await wizard.getByRole('button', { name: /下一步/ }).click();
    // 排除行与名称映射同样从原计划恢复,重新分析后无未决项
    await expect(wizard.getByText('解析错误与未决映射均为 0，可以检查导入结果。')).toBeVisible();
    await expect(wizard.getByText('已排除 1 行')).toBeVisible();
    await wizard.getByRole('button', { name: /检查导入结果/ }).click();
    await expect(wizard.getByText(/已创建待确认批次/)).toBeVisible();

    await wizard.getByRole('button', { name: /进入确认/ }).click();
    await expect(wizard.getByText(/本批次有 \d+ 条非阻断警告/)).toBeVisible();
    const confirmButton = wizard.getByRole('button', { name: /确认写入 .*覆盖/ });
    await expect(confirmButton).toBeDisabled();
    // UX-17:旧的覆盖勾选不能沿用到新差异——恢复后确认勾选保持未勾选
    await expect(wizard.locator('label.ant-checkbox-wrapper').filter({ hasText: /我已查看本次将覆盖的/ }).locator('input')).not.toBeChecked();
    await wizard.locator('label.ant-checkbox-wrapper').filter({ hasText: /我已查看本次将覆盖的/ }).locator('input').check();
    await expect(confirmButton).toBeEnabled();
    await confirmButton.click();
    await expect(wizard.getByText(/已成功写入/)).toBeVisible();

    const templateName = `E2E 清洗模板 ${suffix}`;
    await wizard.getByPlaceholder('新模板名称').fill(templateName);
    const templateCreated = page.waitForResponse((response) => response.url().endsWith('/api/io/cleaning/templates') && response.request().method() === 'POST');
    await wizard.getByRole('button', { name: /另存模板/ }).click();
    const templateResponse = await templateCreated;
    expect(templateResponse.status()).toBe(201);
    templateId = ((await templateResponse.json()) as { id: number }).id;
    await wizard.getByRole('button', { name: /完\s*成/ }).click();
    await expect(wizard).toBeHidden();

    await page.getByRole('button', { name: '导入 Excel', exact: true }).first().click();
    await page.locator('.ant-modal').filter({ hasText: '请按文件来源选择导入方式' }).getByRole('button', { name: '打开清洗向导' }).click();
    const reopened = page.locator('.ant-modal').filter({ hasText: '导入非标准 Excel' });
    await reopened.locator('.ant-select').filter({ hasText: '可选：复用已有导入模板' }).locator('input[role=combobox]').click();
    const templateDropdown = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').last();
    await templateDropdown.locator('.ant-select-item-option').filter({ hasText: templateName }).click();
    await expect(templateDropdown).toBeHidden();
    const secondUpload = page.waitForResponse((response) => response.url().endsWith('/api/io/cleaning/workbook') && response.request().method() === 'POST');
    await reopened.locator('input[type=file]').setInputFiles({ name: '模板复用.xlsx', mimeType: XLSX_MIME, buffer: workbookBuffer });
    expect((await secondUpload).status()).toBe(201);
    await reopened.getByRole('button', { name: /下一步/ }).click();
    await expect(reopened.locator('input.ant-input-number-input').nth(0)).toHaveValue(String(headerRow));
    await expect(reopened.locator('input.ant-input-number-input').nth(1)).toHaveValue(String(dataStartRow));
    await reopened.getByRole('button', { name: /关\s*闭/ }).click();

    const aliasList = await request.get('/api/io/cleaning/aliases?targetKind=budget');
    const aliases = await aliasList.json() as { items: { id: number; sourceText: string }[] };
    aliasId = aliases.items.find((item) => item.sourceText === 'SH')?.id;
  } finally {
    if (templateId) await request.delete(`/api/io/cleaning/templates/${templateId}`);
    if (aliasId) await request.delete(`/api/io/cleaning/aliases/${aliasId}`);
    await request.delete(`/api/versions/${version.id}`);
  }
});

test('实际数有未保存编辑时进入导入需先保存或明确放弃(UX-13 守卫)', async ({ page, request }) => {
  test.setTimeout(60_000);
  page.setDefaultTimeout(15_000);
  const suffix = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const sheetName = `实际编辑 E2E ${suffix}`;
  const created = await request.post('/api/sheets', { data: { code: `actual-edit-${suffix}`, name: sheetName, rootCodes: ['I'] } });
  expect(created.ok()).toBeTruthy();
  const sheet = await created.json() as { id: number };
  try {
    await page.goto('/actual');
    await expect(page.getByRole('button', { name: '导入 Excel', exact: true }).first()).toBeVisible();
    // 页面前三个 combobox 依次是组织、报表、年度；直接定位报表输入，避免文本标签与
    // Ant Space 的额外包裹层级变化导致选择器失效。
    await page.getByRole('combobox').nth(1).locator('xpath=ancestor::div[contains(@class,"ant-select-selector")]').click();
    const reportDropdown = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').last();
    const reportOption = reportDropdown.locator('.ant-select-item-option').filter({ hasText: sheetName }).first();
    await expect(reportOption).toBeVisible();
    await reportOption.click();
    await expect(reportDropdown).toBeHidden();
    const editableCell = page.locator('input[id^="actual-cell-"]').first();
    await expect(editableCell).toBeVisible();
    const original = await editableCell.inputValue();
    await editableCell.fill(original === '98765.43' ? '98765.42' : '98765.43');
    await expect(page.getByText('● 未保存', { exact: true })).toBeVisible();

    // UX-13:导入入口提升为页头可见按钮;按文件来源选择,当前任务含财务转换
    await page.getByRole('button', { name: '导入 Excel', exact: true }).first().click();
    const entryModal = page.locator('.ant-modal').filter({ hasText: '请按文件来源选择导入方式' });
    await expect(entryModal.getByText('标准模板导入')).toBeVisible();
    await expect(entryModal.getByText('非标准 Excel 清洗')).toBeVisible();
    await expect(entryModal.getByText('财务系统转换')).toBeVisible();

    // 有未保存输入:不直接进入导入,要求先保存或明确放弃(导入与手工输入不能并发覆盖)
    await entryModal.getByRole('button', { name: '打开清洗向导' }).click();
    const guard = page.locator('.ant-modal').filter({ hasText: '导入前有未保存的实际数录入' });
    await expect(guard).toBeVisible();
    await expect(guard.getByRole('button', { name: /保存并导入/ })).toBeVisible();
    await expect(guard.getByRole('button', { name: /放弃修改并导入/ })).toBeVisible();
    await expect(page.locator('.ant-modal').filter({ hasText: '导入非标准 Excel' })).toHaveCount(0);
    await guard.getByRole('button', { name: '取消导入' }).click();
    await expect(guard).toBeHidden();
    await expect(page.getByText('● 未保存', { exact: true })).toBeVisible();
  } finally {
    await request.delete(`/api/sheets/${sheet.id}`).catch(() => undefined);
  }
});
