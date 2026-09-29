import { expect, test, type APIRequestContext, type Page } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { createRequire } from 'node:module';

/**
 * UX-31 代理试用(finance 项目):方案第七节的场景 5/6(导入相关)。
 * finance 夹具(集团/华东/上海公司 SH/杭州公司 HZ;I01 主营收入/C01 主营成本 等),
 * 免鉴权;临时版本跑完删除,别名跑完删除。
 *
 * 覆盖的关键业务检查:
 * - 未确认导入不写入库(S5 确认前 / S6 被拒后,API 双重核对)
 * - 预览创建后基线变化 → 旧预览确认被拒,必须重新生成(S6)
 */

const SHOT_DIR = path.join(process.cwd(), '..', 'gui-test-screenshots', 'ux31-trial');
fs.mkdirSync(SHOT_DIR, { recursive: true });

const XLSX_MIME = 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
/* exceljs 只在后端依赖里;经 backend 的 package.json 解析,避免给 frontend 加依赖 */
const backendRequire = createRequire(path.join(process.cwd(), '..', 'backend', 'package.json'));
const ExcelJS = backendRequire('exceljs') as typeof import('exceljs');

async function buildXlsx(rows: (string | number)[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('预算导入');
  for (const row of rows) ws.addRow(row);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const createdVersions: number[] = [];
const createdAliases: number[] = [];

test.afterAll(async ({ request }) => {
  for (const id of createdAliases) await request.delete(`/api/io/cleaning/aliases/${id}`).catch(() => undefined);
  for (const id of createdVersions.reverse()) await request.delete(`/api/versions/${id}`).catch(() => undefined);
});

async function apiGet<T>(request: APIRequestContext, route: string): Promise<T> {
  const response = await request.get(`/api${route}`);
  expect(response.ok(), `GET ${route}: ${response.status()}`).toBeTruthy();
  return response.json() as Promise<T>;
}

async function apiSend<T>(request: APIRequestContext, method: string, route: string, data?: unknown): Promise<T> {
  const response = await request.fetch(`/api${route}`, { method, data });
  expect(response.ok(), `${method} ${route}: ${response.status()} ${await response.text()}`).toBeTruthy();
  return response.json() as Promise<T>;
}

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

interface MatrixLite {
  version: { id: number; revision: number };
  entries: { orgId: number; accountId: number; amountCents: number; quantity: string | null }[];
}
interface TreeLite { rows: { id: number; code: string; name: string }[] }

async function chooseSelect(page: Page, row: ReturnType<Page['locator']>, label: string) {
  await row.locator('.ant-select-selector').click();
  const dropdown = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').last();
  const option = dropdown.locator('.ant-select-item-option').filter({ hasText: label }).first();
  await expect(option).toBeVisible();
  await option.click();
  await expect(dropdown).toBeHidden();
}

/* ================= S5 文件导入(清洗向导,含错别名 + 元单位) ================= */
test('UX31-S5 文件导入:非标准 Excel 含错别名与元单位,就地修正后在预览中说明新增/覆盖/清零', async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  page.setDefaultTimeout(15_000);
  const trial = makeTrialRecorder(testInfo, 'S5 文件导入');

  trial.step('准备:创建一个空草稿版本与一份「元单位 + 错别名」的非标准 Excel(API/文件为备数据)');
  const version = await apiSend<{ id: number }>(page.request, 'POST', '/versions', {
    year: 2026, kind: 'budget', name: `UX31 清洗导入 ${Date.now()}`, note: 'UX-31 文件导入场景,跑完即删',
  });
  createdVersions.push(version.id);
  const file = await buildXlsx([
    ['单位名称', '科目编码', '金额', '说明'],
    ['上海制造基地', 'I01', 500000, '五十万元收入(元单位)'],
    ['上海制造基地', 'C01', 300000, '三十万元成本(元单位)'],
    ['杭州公司', 'I01', 200000, '二十万元收入(元单位)'],
  ]);

  trial.step('打开预算草稿,从页头「导入 Excel」进入,按文件来源选择「非标准 Excel 清洗」');
  await page.goto(`/budget/${version.id}`);
  await expect(page.getByText(/草稿实时自动保存|草稿编制中/).first()).toBeVisible();
  await page.getByRole('button', { name: '导入 Excel', exact: true }).first().click();
  const entryModal = page.locator('.ant-modal').filter({ hasText: '请按文件来源选择导入方式' });
  await expect(entryModal.getByText('非标准 Excel 清洗')).toBeVisible();
  await entryModal.getByRole('button', { name: '打开清洗向导' }).click();
  const wizard = page.locator('.ant-modal').filter({ hasText: '导入非标准 Excel' });
  await expect(wizard).toBeVisible();

  trial.step('上传文件');
  const uploadDone = page.waitForResponse((r) => r.url().endsWith('/api/io/cleaning/workbook') && r.request().method() === 'POST');
  await wizard.locator('input[type=file]').setInputFiles({ name: '非标准预算-元单位.xlsx', mimeType: XLSX_MIME, buffer: file });
  expect((await uploadDone).status()).toBe(201);

  trial.step('选定工作表区域(表头第 1 行,数据第 2~4 行)');
  await wizard.getByRole('button', { name: /下一步/ }).click();
  await expect(wizard.getByText('工作表和区域', { exact: true })).toBeVisible();
  await wizard.locator('tr[data-row-key="1"] button').nth(0).click();
  await wizard.locator('tr[data-row-key="2"] button').nth(1).click();
  await wizard.locator('tr[data-row-key="4"] button').nth(2).click();
  await wizard.getByRole('button', { name: /下一步/ }).click();

  trial.step('列对应:单位名称→组织名称、科目编码、金额、备注;文件单位明确选「元」');
  await expect(wizard.getByText('列和口径', { exact: true })).toBeVisible();
  await chooseSelect(page, wizard.locator('tr[data-row-key="1"]'), '组织名称');
  await chooseSelect(page, wizard.locator('tr[data-row-key="2"]'), '科目编码');
  await chooseSelect(page, wizard.locator('tr[data-row-key="3"]'), '金额');
  await chooseSelect(page, wizard.locator('tr[data-row-key="4"]'), '备注');
  await expect(wizard.getByText('系统不会自动确认元/万元或负数口径'), '单位与口径必须要求人工明确,不按数值大小猜测').toBeVisible();
  await wizard.getByText('元', { exact: true }).click();
  await wizard.getByRole('button', { name: /下一步/ }).click();

  trial.step('分析发现错别名「上海制造基地」,就地选择目标组织并存为别名');
  const unresolvedCard = wizard.locator('.ant-card').filter({ hasText: '按相同源文本批量匹配' });
  await expect(unresolvedCard, '错别名应进入待匹配清单而不是静默跳过').toBeVisible();
  const unresolvedRow = unresolvedCard.locator('tbody tr').filter({ hasText: '上海制造基地' }).first();
  await unresolvedRow.locator('.ant-select-selector').click();
  const targetDropdown = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').last();
  await targetDropdown.locator('.ant-select-item-option').filter({ hasText: 'SH ·' }).first().click();
  await expect(targetDropdown).toBeHidden();
  await unresolvedRow.locator('button').filter({ hasText: '存别名' }).click();
  await expect(page.getByText(/已保存别名/)).toBeVisible();
  await trial.shot(page, '05_文件导入_错别名就地修正.png');

  trial.step('重新分析');
  await wizard.getByRole('button', { name: '重新分析 / 批量接受唯一精确匹配' }).click();
  await expect(wizard.getByText('解析错误与未决映射均为 0，可以检查导入结果。')).toBeVisible();

  trial.step('生成并核对导入预览:新增/覆盖/清零数量与元单位可读');
  await wizard.getByRole('button', { name: /检查导入结果/ }).click();
  await expect(wizard.getByText(/已创建待确认批次/)).toBeVisible();
  await expect(wizard.locator('.ant-statistic').filter({ hasText: '新增' }).first()).toContainText('3');
  await expect(wizard.locator('.ant-statistic').filter({ hasText: '覆盖' }).first()).toContainText('0');
  await expect(wizard.locator('.ant-statistic').filter({ hasText: '清零' }).first()).toContainText('0');
  await expect(wizard.getByRole('cell', { name: '单位', exact: true }), '预览摘要应展示文件单位').toBeVisible();
  await expect(wizard.getByRole('cell', { name: '元', exact: true }), '文件单位应被明确记录为元(而非系统猜测)').toBeVisible();
  await trial.shot(page, '05_文件导入_预览摘要.png');

  trial.step('核对(API):确认前不得写入任何数据');
  const beforeConfirm = await apiGet<MatrixLite>(page.request, `/versions/${version.id}/matrix`);
  expect(beforeConfirm.entries.length, '未确认导入不写入库').toBe(0);

  trial.step('进入确认并确认写入');
  await wizard.getByRole('button', { name: /进入确认/ }).click();
  await wizard.getByRole('button', { name: /确认写入/ }).click();
  await expect(wizard.getByText(/已成功写入/)).toBeVisible();
  await trial.shot(page, '05_文件导入_确认成功.png');

  trial.step('核对(API):元单位文件按整数分精确落库(500000 元 = 50,000,000 分)');
  const orgs = await apiGet<TreeLite>(page.request, '/org/tree');
  const accs = await apiGet<TreeLite>(page.request, '/account/tree');
  const orgIdByCode = new Map(orgs.rows.map((o) => [o.code, o.id]));
  const accIdByCode = new Map(accs.rows.map((a) => [a.code, a.id]));
  const after = await apiGet<MatrixLite>(page.request, `/versions/${version.id}/matrix`);
  const entryOf = (oc: string, ac: string) => after.entries.find((e) => e.orgId === orgIdByCode.get(oc) && e.accountId === accIdByCode.get(ac));
  expect(entryOf('SH', 'I01')?.amountCents).toBe(50_000_000);
  expect(entryOf('SH', 'C01')?.amountCents, '成本按利润方向存负').toBe(-30_000_000);
  expect(entryOf('HZ', 'I01')?.amountCents).toBe(20_000_000);

  const aliases = await apiGet<{ items: { id: number; sourceText: string }[] }>(page.request, '/io/cleaning/aliases?targetKind=budget');
  const aliasId = aliases.items.find((a) => a.sourceText === '上海制造基地')?.id;
  if (aliasId) createdAliases.push(aliasId);
  trial.report('独立完成');
});

/* ================= S6 预览失效 ================= */
test('UX31-S6 预览失效:预览创建后基线被改动,旧预览确认被拒,重新生成后核对再确认', async ({ page }, testInfo) => {
  test.setTimeout(240_000);
  page.setDefaultTimeout(15_000);
  const trial = makeTrialRecorder(testInfo, 'S6 预览失效');

  trial.step('准备:草稿版本 + 一条既有预算(SH×I01 = 100 元),及一份标准模板文件(API/文件为备数据)');
  const orgs = await apiGet<TreeLite>(page.request, '/org/tree');
  const accs = await apiGet<TreeLite>(page.request, '/account/tree');
  const orgIdByCode = new Map(orgs.rows.map((o) => [o.code, o.id]));
  const accIdByCode = new Map(accs.rows.map((a) => [a.code, a.id]));
  const sh = orgIdByCode.get('SH')!;
  const hz = orgIdByCode.get('HZ')!;
  const i01 = accIdByCode.get('I01')!;
  const c01 = accIdByCode.get('C01')!;
  const version = await apiSend<{ id: number; revision: number }>(page.request, 'POST', '/versions', {
    year: 2026, kind: 'budget', name: `UX31 预览失效 ${Date.now()}`, note: 'UX-31 预览失效场景,跑完即删',
  });
  createdVersions.push(version.id);
  await apiSend(page.request, 'PUT', `/versions/${version.id}/entries`, {
    expectedRevision: version.revision,
    entries: [{ orgId: sh, accountId: i01, amount: '100.00' }],
  });
  const file = await buildXlsx([
    ['组织编码', '科目编码', '金额(元)', '数量', '备注'],
    ['SH', 'I01', '200.00', '', '覆盖既有收入'],
    ['HZ', 'C01', '300.00', '', '新增成本'],
  ]);

  trial.step('打开草稿,经「导入 Excel → 标准模板导入」上传文件生成预览');
  await page.goto(`/budget/${version.id}`);
  await expect(page.locator('td[data-gr] input').first()).toBeVisible();
  await page.getByRole('button', { name: '导入 Excel', exact: true }).first().click();
  const entryModal = page.locator('.ant-modal').filter({ hasText: '请按文件来源选择导入方式' });
  await entryModal.getByRole('button', { name: '选择模板文件' }).click();
  await page.locator('input[type=file]').first().setInputFiles({ name: '标准预算导入.xlsx', mimeType: XLSX_MIME, buffer: file });
  const previewModal = page.locator('.ant-modal').filter({ hasText: '标准模板导入预览' });
  await expect(previewModal).toBeVisible();
  await expect(previewModal.locator('.ant-statistic').filter({ hasText: '覆盖' }).first()).toContainText('1');
  await expect(previewModal.locator('.ant-statistic').filter({ hasText: '新增' }).first()).toContainText('1');
  const batchText = await previewModal.getByRole('row', { name: /批次 #\d+/ }).textContent();
  const batchId = Number(/#(\d+)/.exec(batchText ?? '')?.[1]);
  expect(batchId, '预览面板应显示批次号').toBeGreaterThan(0);
  await trial.shot(page, '06_预览失效_首个预览.png');

  trial.step('在预览未确认期间,从其他途径改动基线(手工改一格并保存,模拟另一窗口操作)');
  const detail = await apiGet<{ revision: number }>(page.request, `/versions/${version.id}`);
  await apiSend(page.request, 'PUT', `/versions/${version.id}/entries`, {
    expectedRevision: detail.revision,
    entries: [{ orgId: sh, accountId: i01, amount: '150.00' }],
  });

  trial.step('确认旧预览:必须被拒绝并说明需重新预览');
  await previewModal.getByRole('button', { name: '确认写入' }).click();
  await expect(previewModal.getByText('确认失败')).toBeVisible();
  await expect(previewModal.getByText(/请重新预览/), '拒绝原因必须说明「预览已失效,需重新预览」').toBeVisible();
  await trial.shot(page, '06_预览失效_确认被拒.png');

  trial.step('核对(API):旧预览未写入;批次已取消不可再确认');
  const matrixRejected = await apiGet<MatrixLite>(page.request, `/versions/${version.id}/matrix`);
  const rejectedEntry = matrixRejected.entries.find((e) => e.orgId === sh && e.accountId === i01);
  expect(rejectedEntry?.amountCents, '被拒的旧预览不得写入;手工改动保留').toBe(15_000);
  expect(matrixRejected.entries.find((e) => e.orgId === hz)).toBeUndefined();
  const batchDetail = await apiGet<{ status: string; actions: { confirm: { allowed: boolean } } }>(page.request, `/io/import-batches/${batchId}`);
  expect(batchDetail.status).toBe('cancelled');
  expect(batchDetail.actions.confirm.allowed, '已取消批次不得再确认').toBe(false);

  trial.step('关闭预览弹窗:编辑目标应恢复可编辑(不能一直被「导入进行中」锁住)');
  await previewModal.locator('.ant-modal-close').click();
  await expect(previewModal).toBeHidden();
  await expect(page.locator('td[data-gr] input').first(), '旧预览取消后编辑必须恢复,否则只能刷新页面').toBeVisible();
  await expect(page.getByRole('button', { name: '导入 Excel', exact: true }).first()).toBeEnabled();

  trial.step('重新上传同一文件生成全新预览并核对差异');
  await page.getByRole('button', { name: '导入 Excel', exact: true }).first().click();
  await page.locator('.ant-modal').filter({ hasText: '请按文件来源选择导入方式' }).getByRole('button', { name: '选择模板文件' }).click();
  await page.locator('input[type=file]').first().setInputFiles({ name: '标准预算导入.xlsx', mimeType: XLSX_MIME, buffer: file });
  const preview2 = page.locator('.ant-modal').filter({ hasText: '标准模板导入预览' });
  await expect(preview2).toBeVisible();
  await expect(preview2.locator('.ant-statistic').filter({ hasText: '覆盖' }).first()).toContainText('1');
  await expect(preview2.locator('.ant-statistic').filter({ hasText: '新增' }).first()).toContainText('1');

  trial.step('确认新预览');
  await preview2.getByRole('button', { name: '确认写入' }).click();
  await expect(preview2.getByText(/已提交成功/)).toBeVisible();
  await trial.shot(page, '06_预览失效_重新生成确认成功.png');

  trial.step('核对(API):新预览按冻结内容写入,覆盖与新增均生效');
  const matrixCommitted = await apiGet<MatrixLite>(page.request, `/versions/${version.id}/matrix`);
  expect(matrixCommitted.entries.find((e) => e.orgId === sh && e.accountId === i01)?.amountCents).toBe(20_000);
  expect(matrixCommitted.entries.find((e) => e.orgId === hz && e.accountId === c01)?.amountCents, '成本按利润方向存负').toBe(-30_000);
  trial.report('独立完成');
});
