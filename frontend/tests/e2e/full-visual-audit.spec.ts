
import fs from 'fs';
import path from 'path';
import { expect, test, login } from './access';
import { currentBudgetVersionId } from './versions';

const outputDir = path.join(process.cwd(), 'test-results', 'visual-audit');

test('全覆盖模拟数据的桌面端逐页可视化审计', async ({ page }) => {
  // 逐页走查 11 条路由:每页都要等渲染稳定再截全页图,预算矩阵与本年执行还各带一张
  // 2402 单元格的表和多张 ECharts。默认 120s 在负载稍高的机器上只够跑到一半,
  // 失败原因是机器忙而不是页面坏,因此按「本来就慢」声明,而不是把断言删掉。
  test.slow();
  fs.mkdirSync(outputDir, { recursive: true });
  const runtimeErrors: string[] = [];
  await login(page);
  page.on('pageerror', (error) => runtimeErrors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => {
    if (message.type() === 'error') runtimeErrors.push(`console: ${message.text()}`);
  });
  page.on('response', (response) => {
    if (response.status() >= 400) runtimeErrors.push(`http ${response.status()}: ${response.url()}`);
  });

  await expect(page.getByText('2026年度全覆盖模拟预算').first()).toBeVisible();
  await expect(page.getByText('收入', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('利润净额', { exact: true })).toBeVisible();
  await expect(page.getByText(/实际数据截至 2026-08-22/)).toBeVisible();
  await page.waitForTimeout(1_500);
  await page.screenshot({ path: path.join(outputDir, '01-dashboard-desktop.png'), fullPage: true });

  // 版本 id 由夹具生成顺序决定，必须现查而不能写死(写死成 /budget/7 时换一份夹具就 404)。
  const matrixPath = `/budget/${await currentBudgetVersionId(page.request, 2026)}`;
  // marker 取页面自身的稳定可见文案,而不是页面标题:「顶栏已显示菜单名、不再重复标题」的
  // 改动把各页 Card title 全部删了,断言标题会全线误报。/org 与 /account 复用 TreeManage,
  // 额外断言页面独有的搜索框占位符区分两页。
  const routes: { path: string; name: string; marker: string; placeholder?: string }[] = [
    { path: '/org', name: '02-organizations', marker: '结构检查', placeholder: '组织编码/名称搜索' },
    { path: '/account', name: '03-accounts', marker: '结构检查', placeholder: '科目编码/名称搜索' },
    { path: '/metric', name: '04-metrics', marker: '金额型指标' },
    { path: '/budget', name: '05-budget-versions', marker: '预算与预测复用同一套编制与定稿机制' },
    { path: matrixPath, name: '06-budget-matrix', marker: '2026年度全覆盖模拟预算' },
    { path: '/actual', name: '07-actual-maintain', marker: '历史快照补录' },
    { path: '/analysis', name: '08-analysis', marker: '差异为实际－预算(利润方向)' },
    { path: '/structure', name: '08b-structure', marker: '结构占比' },
    { path: '/history', name: '09-history', marker: '历史年度读取年度关闭时的最终快照' },
    { path: '/compare', name: '10-version-compare', marker: '组织范围(默认全部)' },
    { path: '/data', name: '11-data-manage', marker: '备份恢复' },
  ];

  for (const route of routes) {
    await page.goto(route.path);
    await expect(page.getByText(route.marker, { exact: false }).first()).toBeVisible();
    if (route.placeholder) await expect(page.getByPlaceholder(route.placeholder)).toBeVisible();
    await page.waitForTimeout(route.path === matrixPath || route.path === '/actual' ? 2_000 : 900);
    await page.screenshot({ path: path.join(outputDir, `${route.name}.png`), fullPage: false });
  }

  await page.goto('/analysis');
  // 统一对比口径:同一张表里同时给出预算、实际与全年预测列;执行预警区块单独成卡。
  await expect(page.getByText('全年预测').first()).toBeVisible();
  await expect(page.getByText(/成本费用超支预警|进度滞后/).first()).toBeVisible();
  expect(runtimeErrors, runtimeErrors.join('\n')).toEqual([]);
});

test('首页移动端布局无横向溢出', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await login(page);
  await expect(page.getByText('利润净额', { exact: true })).toBeVisible();
  const dimensions = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
  expect(dimensions.scrollWidth).toBeLessThanOrEqual(dimensions.clientWidth + 2);
  await page.screenshot({ path: path.join(outputDir, '12-dashboard-mobile.png'), fullPage: true });
  await context.close();
});

/**
 * 逐页移动端横向溢出回归。
 *
 * 页面级横向滚动条在手机上体验极差(整页跟着手指左右晃、右侧内容看不见),而制造它的
 * 从来不是表格本身,而是那些「不会换行也不会收缩」的东西:卡片右上角的操作按钮组、
 * 工具栏里固定像素宽的下拉框、文案很长的 Segmented、列表行内的一整条操作按钮。
 * 这类回归只要有人再加一个固定宽度控件就会复现,因此逐页守住。
 */
test('各页面移动端均无页面级横向溢出', async ({ browser }) => {
  // 14 条路由逐页量宽,理由同桌面走查:页数多、每页都重,默认超时不够。
  test.slow();
  const context = await browser.newContext({ viewport: { width: 390, height: 844 } });
  const page = await context.newPage();
  await login(page);
  const versionId = await currentBudgetVersionId(page.request, 2026);
  const routes: { path: string; marker: string | RegExp }[] = [
    // 各页 Card title 已随「顶栏显示菜单名、页内不再重复标题」的改动移除,marker 一律取页内独有文案
    { path: '/org', marker: '结构检查' },
    { path: '/account', marker: '结构检查' },
    { path: '/metric', marker: '金额型指标' },
    { path: '/budget', marker: '预算与预测复用同一套编制与定稿机制' },
    { path: `/budget/${versionId}`, marker: '2026年度全覆盖模拟预算' },
    { path: '/actual', marker: '历史快照补录' },
    { path: '/analysis', marker: /成本费用超支预警/ },
    { path: '/structure', marker: '结构占比' },
    { path: '/history', marker: '历史年度读取年度关闭时的最终快照' },
    { path: '/compare', marker: '组织范围(默认全部)' },
    { path: '/data', marker: '备份恢复' },
    { path: '/data?tab=logs', marker: '导出日志' },
    { path: '/finance', marker: '月度转换' },
    { path: '/assistant', marker: '财务助手' },
  ];
  const overflowing: string[] = [];
  for (const route of routes) {
    await page.goto(route.path);
    await expect(page.getByText(route.marker).first()).toBeVisible();
    const dimensions = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, clientWidth: document.documentElement.clientWidth }));
    if (dimensions.scrollWidth > dimensions.clientWidth + 2) overflowing.push(`${route.path}: ${dimensions.scrollWidth} > ${dimensions.clientWidth}`);
  }
  expect(overflowing, `以下页面在 390px 视口出现页面级横向滚动:\n${overflowing.join('\n')}`).toEqual([]);
  await context.close();
});
