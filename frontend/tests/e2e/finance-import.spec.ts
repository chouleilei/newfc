import { expect, test } from './access';
import path from 'path';


test('财务余额表到实际快照的人工确认全链路',async({page,request})=>{
  await page.goto('/finance');
  await expect(page.getByText('月度转换',{exact:true})).toBeVisible();
  // UX-18:仅一个可用数据源/锁定映射时表单自动带出,此时 getByLabel 点中的输入框会被
  // 已选值标签挡住;一律改点 Form.Item 内的选择器容器,再从可见下拉中选项(幂等)。
  const pickFormSelect = async (label: string, option: string) => {
    const item = page.locator('.ant-form-item').filter({ has: page.locator('label', { hasText: label }) });
    await item.locator('.ant-select-selector').click();
    const dropdown = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)').last();
    await dropdown.locator('.ant-select-item-option').filter({ hasText: option }).first().click();
    await expect(dropdown).toBeHidden();
  };
  await pickFormSelect('数据源', 'E2E 固定财务系统');
  await pickFormSelect('已审核锁定映射版本', 'V1 E2E 已审核映射');
  await page.getByLabel('截止日期').fill('2026-06-30');await page.keyboard.press('Escape');
  const fixture=path.resolve('../backend/tests/fixtures/finance');
  await page.locator('input[type=file]').nth(0).setInputFiles(path.join(fixture,'balance-2026-06-30.xlsx'));
  await page.locator('input[type=file]').nth(1).setInputFiles(path.join(fixture,'profit-2026-06-30.xlsx'));
  await page.getByRole('button',{name:'解析、转换并执行全部校验'}).click();
  await expect(page.getByText('全部强制闸门通过，可生成导入预览')).toBeVisible();
  await expect(page.getByText('0',{exact:true}).last()).toBeVisible();
  await page.getByRole('button',{name:'创建导入预览'}).click();
  await expect(page.getByRole('button',{name:'确认导入并生成快照'})).toBeVisible();
  await page.getByRole('button',{name:'确认导入并生成快照'}).click();
  await expect(page.getByText('实际数已提交并生成不可变快照')).toBeVisible();
  // UX-15:确认成功后统一预览面板停留在结果页,需显式关闭,否则遮罩挡住后续页签点击
  const previewPanel = page.locator('.ant-modal').filter({ hasText: '财务转换导入预览' });
  await expect(previewPanel.getByText(/批次 #\d+ 已提交成功/)).toBeVisible();
  await previewPanel.getByRole('button', { name: /关\s*闭/ }).click();
  await expect(previewPanel).toBeHidden();
  const response=await request.get('/api/finance/conversions');expect(response.ok()).toBeTruthy();const body=await response.json();expect(body.items[0].status).toBe('imported');expect(body.items[0].import_batch_id).toBeTruthy();expect(body.items[0].validation.passed).toBe(true);
  const output=await request.get(`/api/finance/conversions/${body.items[0].id}/output`);expect(output.ok()).toBeTruthy();
  await page.getByText('真实数据并行试运行',{exact:true}).click();
  await page.locator('.ant-select-selector').last().click();await page.getByText(`#${body.items[0].id} · 2026-06-30 · 映射V1`,{exact:true}).click();
  await page.locator('input[type=file]').last().setInputFiles({name:'原手工实际数.xlsx',mimeType:'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',buffer:await output.body()});
  await expect(page.getByText('与原手工结果分毫一致')).toBeVisible();
  const trialResponse=await request.get('/api/finance/parallel-trials');expect(trialResponse.ok()).toBeTruthy();const trialBody=await trialResponse.json();expect(trialBody.items[0].comparison.mismatchCount).toBe(0);const reviewed=await request.post(`/api/finance/parallel-trials/${trialBody.items[0].id}/review`);expect(reviewed.ok()).toBeTruthy();
  await page.getByText('批次历史与追溯',{exact:true}).click();await expect(page.getByText('已导入',{exact:true})).toBeVisible();
});
