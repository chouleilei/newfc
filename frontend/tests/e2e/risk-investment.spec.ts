import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import type { APIRequestContext, APIResponse, Page } from '@playwright/test';
import { expect, login, test } from './access';

/**
 * T-5 界面链路:AC-F13 投资控制(导入→确认→对比快照,偏差率 8% 为关注);AC-F12 可行性测算(宜冲桥样本测算与结果冻结);
 * AC-F11 财务预测(冻结→基准运行→情景运行→与基准对比);AC-F17 风险扫描→确认→整改→提交→复核关闭;
 * AC-F18 风险与投资专题报告生成→提交→审批(管理员自审例外)→发布任务→导出 DOCX。
 */
const OK = /确\s*[定认]|OK/;
const IC = '/api/investment/control';
const IC_HEADER = '科目编码,科目名称,分类,静态投资(万元),动态投资(万元)';
const icCsv = (amount: string) => Buffer.from(`${IC_HEADER}\n1,工程,,${amount},${amount}\n1.1,建筑工程,,${amount},${amount}\n`, 'utf8');
const sample = JSON.parse(fs.readFileSync(path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../backend/tests/fixtures/investment_feasibility_yichongqiao.json'), 'utf8')) as { assumptions: unknown };

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

async function masterProject(request: APIRequestContext, code: string, name: string): Promise<number> {
  const p = await json<{ id: number }>(await request.post('/api/master/projects', { data: { code, name, orgId: await orgId(request, '上海公司') } }), 201);
  return p.id;
}

/** 经 API 建立一个已确认两稿的投资控制项目并生成对比快照(供风险扫描)。 */
async function icProjectWithComparison(request: APIRequestContext, code: string, base: string, target: string) {
  const md = await masterProject(request, code, `${code} 泵站扩建`);
  const project = await json<{ id: number }>(await request.post(`${IC}/projects`, { data: { mdProjectId: md } }), 201);
  const version = async (versionType: string, amount: string) => {
    const pv = await json<{ id: number; sha256: string }>(await request.post(`${IC}/projects/${project.id}/imports`, {
      multipart: { versionType, file: { name: `${versionType}.csv`, mimeType: 'text/csv', buffer: icCsv(amount) } },
    }), 201);
    const imp = await json<{ versionId: number }>(await request.post(`${IC}/imports/${pv.id}/confirm`, { data: { sha256: pv.sha256 } }));
    const v = await json<{ version: number }>(await request.get(`${IC}/versions/${imp.versionId}`));
    await json(await request.post(`${IC}/versions/${imp.versionId}/confirm`, { data: { expectedVersion: v.version } }));
    return imp.versionId;
  };
  const baseVersionId = await version('design_estimate', base);
  const targetVersionId = await version('construction_budget', target);
  await json(await request.post(`${IC}/comparisons`, { data: { baseVersionId, targetVersionId } }), 201);
  return project.id;
}

const topDrawer = (page: Page) => page.locator('.ant-drawer-content-wrapper:visible').last();
const topDialog = (page: Page) => page.locator('.ant-modal-wrap:visible .ant-modal').last();

/** 打开表单项里的下拉框(按标签定位,点选择器而非内部 input,避免已选值遮挡)。 */
async function openSelect(scope: ReturnType<typeof topDialog>, label: string) {
  await scope.locator('.ant-form-item', { hasText: label }).locator('.ant-select-selector').click();
}

/** 等上一个下拉的收起动画结束(只剩一个展开的下拉),再在其中选项,避免点到正在收起的旧下拉。 */
async function chooseOption(page: Page, text: string | RegExp) {
  const open = page.locator('.ant-select-dropdown:not(.ant-select-dropdown-hidden)');
  await expect(open).toHaveCount(1);
  await open.locator('.ant-select-item-option', { hasText: text }).first().click();
}

test.describe('投资、预测、风险与报告页面', () => {
  test('投资控制:新建项目 → 导入两稿并确认 → 对比快照偏差率 8% 为关注', async ({ page, request }) => {
    const code = `E2E-IC-${Date.now()}`;
    await masterProject(request, code, 'E2E 水厂改造');
    await login(page);
    await page.goto('/investment-control');
    await page.getByRole('button', { name: '新建项目' }).click();
    const create = topDialog(page);
    await create.getByLabel('主数据项目').fill(code);
    await chooseOption(page, code);
    await create.getByRole('button', { name: OK }).click();
    await expect(page.getByText(`已建立投资控制项目 ${code}`)).toBeVisible();
    const project = topDrawer(page);
    await expect(project.getByText(`${code} · E2E 水厂改造`)).toBeVisible();

    const importVersion = async (typeLabel: string | null, amount: string) => {
      await project.getByRole('button', { name: '导入版本' }).click();
      const dlg = topDialog(page);
      if (typeLabel) { await openSelect(dlg, '版本类型'); await chooseOption(page, typeLabel); }
      await dlg.locator('input[type=file]').setInputFiles({ name: 'ic.csv', mimeType: 'text/csv', buffer: icCsv(amount) });
      await expect(dlg.getByText('ic.csv:2 行')).toBeVisible();
      await dlg.getByRole('button', { name: '确认导入' }).click();
      await expect(page.getByText('已导入为草稿版本').last()).toBeVisible();
      const vd = topDrawer(page);
      await expect(vd.getByText('草稿').first()).toBeVisible();
      await vd.getByRole('button', { name: '确认冻结' }).click();
      await expect(vd.getByText('已确认').first()).toBeVisible();
      await vd.locator('.ant-drawer-close').click();
    };
    await importVersion(null, '100');
    await importVersion('施工图预算', '108');
    await expect(project.locator('tr', { hasText: '施工图预算' })).toContainText('1,080,000.00');

    await project.getByRole('button', { name: '生成对比' }).click();
    const cmp = topDialog(page);
    await openSelect(cmp, '基准版本');
    await chooseOption(page, '设计概算 V1');
    await openSelect(cmp, '目标版本');
    await chooseOption(page, '施工图预算 V1');
    await cmp.getByRole('button', { name: OK }).click();
    await expect(page.getByText('对比快照已生成')).toBeVisible();
    const snap = topDialog(page);
    await expect(snap.getByText(/对比快照 #\d+:设计概算 V1 → 施工图预算 V1/)).toBeVisible();
    await expect(snap.getByText('80,000.00').first()).toBeVisible();
    await expect(snap.getByText('8.00%').first()).toBeVisible();
    await expect(snap.getByText('关注').first()).toBeVisible();
    await expect(snap.getByText(/施工图预算.*超过.*概算|预算.*超.*概算/).first()).toBeVisible();
  });

  test('可行性测算与财务预测:样本测算结果冻结;预测冻结 → 基准 → 情景对比', async ({ page, request }) => {
    const sh = await orgId(request, '上海公司');
    const code = `E2E-FS-${Date.now()}`;
    const fp = await json<{ id: number }>(await request.post('/api/investment/feasibility/projects', {
      data: { code, name: 'E2E 脱敏水库项目', orgId: sh, constructionStartYear: 2026, operationStartYear: 2028, horizonYears: 30 },
    }), 201);
    await json(await request.post(`/api/investment/feasibility/projects/${fp.id}/scenarios`, { data: { code: 'BASE', name: '基准方案', assumptions: sample.assumptions } }), 201);

    await login(page);
    await page.goto('/feasibility');
    await page.locator('tr', { hasText: code }).click();
    await topDrawer(page).locator('tr', { hasText: 'BASE' }).click();
    const sc = topDrawer(page);
    await expect(sc.getByText('尚无成功测算,请先测算')).toBeVisible();
    await sc.getByRole('button', { name: /^测\s*算$/ }).click();
    await expect(page.getByText('测算完成,结果已冻结')).toBeVisible();
    await expect(sc.getByText('结果最新')).toBeVisible();
    await expect(sc.getByText(/运行 #\d+/).first()).toBeVisible();
    await expect(sc.getByRole('tab', { name: '指标' })).toBeVisible();

    // 财务预测:样本工作簿 1000 → 增长率 10%/20%
    const model = await json<{ id: number }>(await request.post('/api/forecast/models', { data: { name: `E2E 预测 ${Date.now()}`, orgId: sh, baseYear: 2026, horizonYears: 3 } }), 201);
    await json(await request.post(`/api/forecast/models/${model.id}/versions`, {
      data: {
        workbook: {
          sheets: [
            { name: '参数', cells: { A1: { s: '增长率' }, B1: { n: '0.1' } } },
            { name: '预测', cells: { B1: { n: '1000' }, C1: { f: '=B1*(1+参数!B1)' }, D1: { f: '=C1*(1+参数!B1)' }, B3: { f: '=SUM(B1:D1)' } } },
          ],
        },
        params: [{ key: 'growth', name: '增长率', cell: '参数!B1', unit: '' }],
        outputs: [{ key: 'revenue', name: '收入', ref: '预测!B1:D1', unit: '万元' }, { key: 'total', name: '合计', ref: '预测!B3', unit: '万元' }],
        note: 'E2E 样本',
      },
    }), 201);
    await page.goto('/forecast');
    await page.locator('tr', { hasText: 'E2E 预测' }).first().click();
    await topDrawer(page).locator('tr', { hasText: 'E2E 样本' }).click();
    const vd = topDrawer(page);
    await expect(vd.getByText('诊断通过')).toBeVisible();
    await vd.getByRole('button', { name: /^冻\s*结$/ }).click();
    await expect(page.getByText('已冻结,可以运行基准')).toBeVisible();
    await vd.getByRole('tab', { name: '运行与对比' }).click();
    await vd.getByRole('button', { name: '运行基准' }).click();
    await expect(vd.locator('tr', { hasText: '基准' }).getByText('成功')).toBeVisible({ timeout: 30_000 });
    await vd.getByRole('button', { name: '情景运行' }).click();
    const dlg = topDialog(page);
    await dlg.getByLabel('方案名').fill('增长 20%');
    await dlg.getByLabel(/增长率\(growth/).fill('0.2');
    await dlg.getByRole('button', { name: OK }).click();
    const scen = vd.locator('tr', { hasText: '增长 20%' });
    await expect(scen.getByText('成功')).toBeVisible({ timeout: 30_000 });
    await scen.getByRole('button', { name: /^对\s*比$/ }).click();
    const cmp = topDialog(page);
    await expect(cmp.getByText('growth = 0.2')).toBeVisible();
    const totalRows = cmp.locator('tr', { hasText: /基准|情景|差额/ });
    await expect(totalRows.filter({ hasText: '3,310.000000' }).first()).toBeVisible();
    await expect(totalRows.filter({ hasText: '3,640.000000' }).first()).toBeVisible();
    await expect(cmp.getByText('330.000000').first()).toBeVisible();
  });

  test('风险闭环与分析报告:扫描 → 确认 → 整改 → 复核关闭;专题报告审批发布与导出', async ({ page, request }) => {
    const code = `E2E-RK-${Date.now()}`;
    await icProjectWithComparison(request, code, '100', '120');
    await login(page);
    await page.goto('/risk');
    await page.getByRole('button', { name: '执行扫描' }).click();
    await expect(page.getByText(/扫描完成|新增 \d+/).first()).toBeVisible();
    await page.getByPlaceholder('标题/项目').fill(code);
    await page.getByPlaceholder('标题/项目').press('Enter');
    const row = page.locator('tr', { hasText: '超限' }).or(page.locator('tr', { hasText: code })).first();
    await expect(row).toContainText('待确认');
    await row.click();
    const drawer = topDrawer(page);
    const act = async (label: string, fill?: { comment?: string; exception?: string }) => {
      await drawer.getByRole('button', { name: label }).click();
      const dlg = topDialog(page);
      if (fill?.comment) await dlg.locator('textarea').first().fill(fill.comment);
      if (fill?.exception) await dlg.getByLabel(/例外原因/).fill(fill.exception);
      await dlg.getByRole('button', { name: OK }).click();
      await expect(dlg).toBeHidden();
    };
    await act('确认风险');
    await expect(drawer.getByText('已确认').first()).toBeVisible();
    await act('开始整改');
    await expect(drawer.getByText('整改中').first()).toBeVisible();
    await act('提交复核', { comment: 'E2E 已压减施工图预算至红线内' });
    await expect(drawer.getByText('待复核').first()).toBeVisible();
    await act('复核通过', { exception: 'E2E 单人环境,管理员自审' });
    await expect(drawer.getByText('已关闭').first()).toBeVisible();
    await expect(drawer.getByText('复核通过').first()).toBeVisible();
    await drawer.locator('.ant-drawer-close').click();

    await page.goto('/analysis-reports');
    await page.getByRole('button', { name: '生成报告' }).click();
    const gen = topDialog(page);
    await gen.getByLabel('标题(缺省自动生成)').fill(`E2E 风险与投资专题 ${code}`);
    await gen.getByRole('checkbox').uncheck();
    await gen.getByRole('button', { name: '生成草稿' }).click();
    await expect(page.getByText(/已生成草稿 /)).toBeVisible();
    const rd = topDrawer(page);
    await expect(rd.getByText(`E2E 风险与投资专题 ${code}`)).toBeVisible();
    await rd.getByRole('button', { name: '提交审批' }).click();
    await expect(rd.getByText('待审批').first()).toBeVisible();
    await rd.getByRole('button', { name: '审批通过' }).click();
    const ap = topDialog(page);
    await ap.getByLabel(/例外原因/).fill('E2E 单人环境,管理员自审');
    await ap.getByRole('button', { name: OK }).click();
    await expect(rd.getByText('已审批').first()).toBeVisible();
    await rd.getByRole('button', { name: /^发\s*布$/ }).click();
    await expect(page.getByText('已发布,DOCX/PDF 已冻结保存')).toBeVisible({ timeout: 60_000 });
    await expect(rd.getByText('已发布').first()).toBeVisible();
    await expect(rd.getByText(/发布快照/)).toBeVisible();
    const download = page.waitForEvent('download');
    await rd.getByRole('button', { name: '导出 DOCX' }).click();
    expect((await download).suggestedFilename()).toMatch(/\.docx$/);
  });
});
