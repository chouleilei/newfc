import { expect, test, type APIRequestContext } from '@playwright/test';
import fs from 'fs';
import path from 'path';
import { login } from './access';
import { currentBudgetVersionId } from './versions';

const artifactDir = path.join(process.cwd(), 'test-results', 'deep-functional-audit');

async function api(
  request: APIRequestContext,
  token: string,
  method: string,
  route: string,
  data?: unknown,
) {
  // 相对路径走 project 的 baseURL：写死 127.0.0.1:3748 时这套「会创建/删除数据」的用例
  // 会打到本机常驻实例的真实库上，而不是 harness 起的一次性夹具。
  const response = await request.fetch(`/api${route}`, {
    method,
    headers: { 'x-access-token': token },
    data,
  });
  expect(response.ok(), `${method} ${route}: ${response.status()} ${await response.text()}`).toBeTruthy();
  return response;
}

async function expectXlsx(request: APIRequestContext, token: string, route: string): Promise<void> {
  const response = await api(request, token, 'GET', route);
  const body = await response.body();
  expect(body.length, `${route} 导出内容为空`).toBeGreaterThan(1_000);
  expect(body.subarray(0, 2).toString()).toBe('PK');
}

test('跨年度页面功能、筛选、追溯、下载与管理工具深度交互', async ({ page }) => {
  // 一条用例串起首页年度切换、四个分析页筛选、追溯抽屉、多份导出下载与年度关闭/日志核对,
  // 页面数量与交互步数都在 harness 里最多。默认 120s 在负载稍高的机器上不够,
  // 超时点会随机落在最后几步(常见是 /data?tab=logs 的表格还没返回)。
  test.slow();
  fs.mkdirSync(artifactDir, { recursive: true });
  const runtimeErrors: string[] = [];
  const token = await login(page);
  page.on('pageerror', (error) => runtimeErrors.push(`pageerror: ${error.message}`));
  page.on('console', (message) => { if (message.type() === 'error') runtimeErrors.push(`console: ${message.text()}`); });
  page.on('response', (response) => { if (response.status() >= 400) runtimeErrors.push(`http ${response.status()}: ${response.url()}`); });

  // 首页年度切换：冻结状态、最终快照和 KPI 必须一起切换。
  await page.locator('.ant-select').first().click();
  await page.getByText(/2025 年 · 2025年度全覆盖模拟预算/).click();
  await expect(page.getByText('年度已冻结', { exact: true })).toBeVisible();
  await expect(page.getByText('实际数据截至 2025-12-31')).toBeVisible();
  await expect(page.getByText('收入', { exact: true }).first()).toBeVisible();

  // 历史页必须真正渲染四个冻结年度、图表和准确率，而非空状态。
  // 三张图:历年预算与实际利润对比、收入/成本/费用构成与利润同比、历年利润完成率与预算准确率;
  // 「年度节奏对比」是表格不是图,所以 canvas 恰为 3。按标题逐一断言,数量只兜「某张图整体消失」。
  await page.goto('/history');
  for (const year of [2022, 2023, 2024, 2025]) await expect(page.getByText(String(year), { exact: true }).first()).toBeVisible();
  for (const title of ['历年预算与实际利润对比', '收入 / 成本 / 费用构成与利润同比', '历年利润完成率与预算准确率']) {
    await expect(page.getByText(title, { exact: false }).first()).toBeVisible();
  }
  await expect(page.locator('canvas')).toHaveCount(3);
  await expect(page.getByText(/年度节奏对比\(同口径,基准年 \d{4}\)/)).toBeVisible();
  await expect(page.getByText('预算准确率', { exact: true }).first()).toBeVisible();
  const historyDownload = page.waitForEvent('download');
  await page.getByRole('button', { name: /导出/ }).click();
  expect((await historyDownload).suggestedFilename()).toContain('历年');

  // 预算矩阵：汇总、附注台账、编制记录、表格及组织口径均需加载。
  await page.goto(`/budget/${await currentBudgetVersionId(page.request, token, 2026)}`);
  await expect(page.getByText('利润总额', { exact: true }).first()).toBeVisible();
  await page.getByRole('button', { name: '更多' }).click();
  await page.getByRole('menuitem', { name: /测算依据台账/ }).click();
  await expect(page.getByText(/测算依据与底稿附注台账 \(2402 条记录\)/)).toBeVisible();
  await page.locator('.ant-drawer-close:visible').click();
  await page.getByRole('button', { name: '更多' }).click();
  await page.getByRole('menuitem', { name: /编制记录/ }).click();
  await expect(page.getByText(/定稿前记录/)).toBeVisible();
  await page.locator('.ant-drawer-close:visible').click();

  // 实际维护：切换多年趋势，必须同时出现五年预算/实际列。
  await page.goto('/actual');
  await page.getByText('多年趋势对比', { exact: false }).click();
  for (const year of [2022, 2023, 2024, 2025, 2026]) await expect(page.getByText(String(year), { exact: false }).first()).toBeVisible();
  await expect(page.getByText('预算数', { exact: true }).first()).toBeVisible();
  await expect(page.getByText('实际数', { exact: true }).first()).toBeVisible();

  // 分析：预算/实际/预测、预警、量价利归因和数字来源抽屉。
  await page.goto('/analysis');
  await expect(page.getByText(/预算 \/ 实际 \/ 全年预测统一对比/)).toBeVisible();
  await expect(page.getByText(/成本费用超支预警/)).toBeVisible();
  await expect(page.getByText(/发电量价利归因分析/)).toBeVisible();
  await page.getByRole('button', { name: '预算', exact: true }).first().click();
  await expect(page.getByText('数字来源', { exact: true })).toBeVisible();
  await page.locator('.ant-drawer-close:visible').click();

  // 版本对比：预算与同年预测自动形成变化、指标和明细对比。
  await page.goto('/compare');
  await expect(page.getByText('变化额', { exact: true }).first()).toBeVisible();
  await expect(page.getByText(/利润表指标对比/)).toBeVisible();
  await expect(page.getByText(/叶子明细变化/)).toBeVisible();

  // 数据管理：一致性检查已提升为独立侧栏入口(/data?tab=check 单页签),
  // 迁移、日志和年度状态仍在备份宿主页内,均通过真实交互验证。
  await page.goto('/data?tab=check');
  await page.getByRole('button', { name: /运行一致性检查/ }).click();
  await expect(page.getByText('全部检查通过')).toBeVisible();
  await page.goto('/data?tab=backup');
  await page.getByRole('tab', { name: '迁移管理' }).click();
  await expect(page.getByText('已是最新版本', { exact: true })).toBeVisible();
  await page.goto('/data?tab=yearclose');
  await page.getByRole('combobox').click();
  await page.getByText('2025 年', { exact: true }).click();
  await expect(page.getByText('已冻结', { exact: true })).toBeVisible();
  await expect(page.getByText(/该年度已冻结/)).toBeVisible();
  await page.goto('/data?tab=logs');
  await expect(page.locator('.ant-table-row').first()).toBeVisible();

  await page.screenshot({ path: path.join(artifactDir, 'deep-functional-final.png'), fullPage: false });
  expect(runtimeErrors, runtimeErrors.join('\n')).toEqual([]);
});

test('API功能矩阵、临时CRUD生命周期、报表追溯及全部Excel导出', async ({ page, request }) => {
  const token = await login(page);
  const created: { orgs: number[]; accounts: number[]; metrics: number[]; sheets: number[]; versions: number[] } = {
    orgs: [], accounts: [], metrics: [], sheets: [], versions: [],
  };
  try {
    const dashboard = await (await api(request, token, 'GET', '/dashboard')).json();
    expect(dashboard.currentVersions).toHaveLength(5);
    const versions = await (await api(request, token, 'GET', '/versions')).json() as { id: number; year: number; kind: string; is_current: number }[];
    const budgets = versions.filter((version) => version.kind === 'budget' && version.is_current === 1);
    expect(budgets.map((version) => version.year).sort()).toEqual([2022, 2023, 2024, 2025, 2026]);

    const orgTree = await (await api(request, token, 'GET', '/org/tree')).json();
    const accountTree = await (await api(request, token, 'GET', '/account/tree')).json();
    expect(orgTree.rows).toHaveLength(26);
    expect(accountTree.rows).toHaveLength(239);
    expect((await (await api(request, token, 'GET', '/org/check')).json()).ok).toBe(true);
    expect((await (await api(request, token, 'GET', '/account/check')).json()).ok).toBe(true);
    const managementMetrics = (await (await api(request, token, 'GET', '/metrics')).json()).items as { code: string; name: string }[];
    expect(managementMetrics).toHaveLength(12);
    expect(managementMetrics).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'P07', name: '总收入' }),
      expect.objectContaining({ code: 'P06', name: '总成本' }),
      expect.objectContaining({ code: 'P04', name: '利润总额' }),
      expect.objectContaining({ code: 'P05', name: '净利润' }),
      expect.objectContaining({ code: 'R01', name: '营业利润率' }),
      expect.objectContaining({ code: 'R05', name: '度电营业成本' }),
    ]));
    expect((await (await api(request, token, 'GET', '/sheets')).json()).items.length).toBeGreaterThan(0);
    const snapshots = await (await api(request, token, 'GET', '/snapshots')).json();
    expect((snapshots.items ?? snapshots).length).toBeGreaterThan(0);

    const years = await (await api(request, token, 'GET', '/actual/years')).json() as { year: number; status: string; final_batch_id: number | null }[];
    expect(years.filter((year) => year.status === 'frozen').map((year) => year.year).sort()).toEqual([2022, 2023, 2024, 2025]);
    for (const budget of budgets) {
      const matrix = await (await api(request, token, 'GET', `/versions/${budget.id}/matrix`)).json();
      expect(matrix.entries).toHaveLength(2402);
      expect((await (await api(request, token, 'GET', `/versions/${budget.id}/quality`)).json()).coverage.percent).toBe(100);
      expect((await (await api(request, token, 'GET', `/versions/${budget.id}/validate`)).json()).ok).toBe(true);
      expect((await (await api(request, token, 'GET', `/versions/${budget.id}/summary`)).json()).metrics).toHaveLength(7);
      const completion = await (await api(request, token, 'GET', `/report/completion?versionId=${budget.id}`)).json();
      expect(completion.asOfDate).toBe(budget.year === 2026 ? '2026-08-22' : `${budget.year}-12-31`);
      const trend = await (await api(request, token, 'GET', `/report/trend?year=${budget.year}&versionId=${budget.id}`)).json();
      expect(trend.points.length).toBeGreaterThanOrEqual(4);
    }

    const historical = await (await api(request, token, 'GET', '/report/historical')).json();
    expect(historical.years).toHaveLength(4);
    for (const year of [2022, 2023, 2024, 2025]) {
      const accuracy = await (await api(request, token, 'GET', `/report/accuracy?year=${year}`)).json();
      expect(accuracy.accuracyProfit).not.toBeNull();
      const matrix = await (await api(request, token, 'GET', `/actual/matrix?year=${year}`)).json();
      expect(matrix.entries).toHaveLength(2402);
      const batches = await (await api(request, token, 'GET', `/actual/batches?year=${year}`)).json();
      expect(batches).toHaveLength(4);
    }

    const budget2026 = budgets.find((version) => version.year === 2026)!;
    const forecast2026 = versions.find((version) => version.year === 2026 && version.kind === 'forecast')!;
    const comparison = await (await api(request, token, 'GET', `/report/version-compare?base=${budget2026.id}&target=${forecast2026.id}`)).json();
    expect(comparison.leafChanges.length).toBeGreaterThan(0);
    const budgetMatrix = await (await api(request, token, 'GET', `/versions/${budget2026.id}/matrix`)).json();
    const sample = budgetMatrix.entries[0];
    const budgetEvidence = await (await api(request, token, 'GET', `/evidence/budget-cell?versionId=${budget2026.id}&accountId=${sample.accountId}&orgId=${sample.orgId}`)).json();
    expect(budgetEvidence.sourceType).toBe('budget');
    expect(budgetEvidence.value.amountCents !== 0 || budgetEvidence.value.quantity !== 0).toBe(true);
    expect(budgetEvidence.entry).not.toBeNull();
    const batches2026 = await (await api(request, token, 'GET', '/actual/batches?year=2026')).json();
    const actualEvidence = await (await api(request, token, 'GET', `/evidence/actual-cell?batchId=${batches2026[0].id}&accountId=${sample.accountId}&orgId=${sample.orgId}`)).json();
    expect(actualEvidence.sourceType).toBe('actual');
    expect(actualEvidence.value.amountCents !== 0 || actualEvidence.value.quantity !== 0).toBe(true);

    expect((await (await api(request, token, 'GET', '/check/consistency')).json()).ok).toBe(true);
    expect((await (await api(request, token, 'GET', '/migrations')).json()).pending).toHaveLength(0);
    expect((await (await api(request, token, 'GET', '/logs?page=1&pageSize=20')).json()).items.length).toBeGreaterThan(0);
    expect((await (await api(request, token, 'GET', '/io/import-batches?page=1&pageSize=20')).json()).items).toBeDefined();
    expect((await (await api(request, token, 'GET', '/calculation-rules')).json()).items.length).toBeGreaterThan(0);

    // 临时组织完整生命周期：创建、改名、层级移动、停启用、删除。
    const suffix = Date.now().toString().slice(-8);
    const orgA = await (await api(request, token, 'POST', '/org', { code: `ZT${suffix}A`, name: 'E2E临时组织A', sortOrder: 9998 })).json(); created.orgs.push(orgA.id);
    const orgB = await (await api(request, token, 'POST', '/org', { code: `ZT${suffix}B`, name: 'E2E临时组织B', sortOrder: 9999 })).json(); created.orgs.push(orgB.id);
    const orgChild = await (await api(request, token, 'POST', '/org', { parentId: orgA.id, code: `ZT${suffix}C`, name: 'E2E临时子组织', sortOrder: 1 })).json(); created.orgs.push(orgChild.id);
    await api(request, token, 'PATCH', `/org/${orgChild.id}`, { name: 'E2E临时子组织已改名' });
    await api(request, token, 'POST', `/org/${orgChild.id}/move`, { parentId: orgB.id });
    await api(request, token, 'POST', `/org/${orgChild.id}/status`, { status: 'inactive' });
    await api(request, token, 'POST', `/org/${orgChild.id}/status`, { status: 'active' });

    // 临时科目、指标、预设表完整生命周期，删除后不污染真实主数据。
    const accA = await (await api(request, token, 'POST', '/account', { code: `ZE${suffix}A`, name: 'E2E临时费用A', type: 'expense', sortOrder: 9998 })).json(); created.accounts.push(accA.id);
    const accB = await (await api(request, token, 'POST', '/account', { code: `ZE${suffix}B`, name: 'E2E临时费用B', type: 'expense', sortOrder: 9999 })).json(); created.accounts.push(accB.id);
    const accChild = await (await api(request, token, 'POST', '/account', { parentId: accA.id, code: `ZE${suffix}C`, name: 'E2E临时费用明细', type: 'expense', sortOrder: 1 })).json(); created.accounts.push(accChild.id);
    await api(request, token, 'PATCH', `/account/${accChild.id}`, { name: 'E2E临时费用明细已改名' });
    await api(request, token, 'POST', `/account/${accChild.id}/move`, { parentId: accB.id });
    await api(request, token, 'POST', `/account/${accChild.id}/status`, { status: 'inactive' });
    await api(request, token, 'POST', `/account/${accChild.id}/status`, { status: 'active' });
    const metric = await (await api(request, token, 'POST', '/metrics', { code: `ZM${suffix}`, name: 'E2E临时指标', displayOrder: 9999, terms: [{ sourceType: 'account', sourceAccountId: accChild.id, coefficient: 1 }] })).json(); created.metrics.push(metric.id);
    await api(request, token, 'PATCH', `/metrics/${metric.id}`, { name: 'E2E临时指标已修改', displayOrder: 9998, terms: [{ sourceType: 'account', sourceAccountId: accChild.id, coefficient: -1 }] });
    const sheet = await (await api(request, token, 'POST', '/sheets', { code: `zs_${suffix}`, name: 'E2E临时表格', rootCodes: [accB.code], collapsedCodes: [], sortOrder: 9999 })).json(); created.sheets.push(sheet.id);
    await api(request, token, 'PATCH', `/sheets/${sheet.id}`, { name: 'E2E临时表格已修改', rootCodes: [accB.code], collapsedCodes: [accB.code], sortOrder: 9998 });

    // 临时草稿覆盖创建、增长预览、改名、保存、记录点、体检、清空和删除。
    const preview = await (await api(request, token, 'POST', '/versions/generation-preview', { year: 2027, kind: 'budget', baseFrom: 'budget', baseYear: 2026, growthRate: '0.05' })).json();
    expect(preview.generatedCount).toBe(2402);
    const draft = await (await api(request, token, 'POST', '/versions', { year: 2027, kind: 'budget', name: `E2E临时草稿${suffix}`, note: '深度功能测试' })).json(); created.versions.push(draft.id);
    await api(request, token, 'PATCH', `/versions/${draft.id}`, { name: `E2E临时草稿已改名${suffix}` });
    const sampleAccount = budgetMatrix.accountNodes.find((node: { id: number }) => node.id === sample.accountId);
    const entry = sampleAccount.type === 'quantity'
      ? { orgId: sample.orgId, accountId: sample.accountId, quantity: '12.3456', note: 'E2E数量测试' }
      : { orgId: sample.orgId, accountId: sample.accountId, amount: '12345.67', formula: '=1028.805833*12', note: 'E2E金额测试' };
    const saved = await (await api(request, token, 'PUT', `/versions/${draft.id}/entries`, {
      expectedRevision: draft.revision,
      entries: [entry],
    })).json();
    expect((await (await api(request, token, 'POST', `/versions/${draft.id}/checkpoints`, { title: 'E2E功能记录点' })).json()).created).toBe(true);
    expect((await (await api(request, token, 'GET', `/versions/${draft.id}/quality`)).json()).coverage.filled).toBe(1);
    expect((await (await api(request, token, 'DELETE', `/versions/${draft.id}/entries`, {
      expectedRevision: saved.revision,
    })).json()).deleted).toBe(1);
    const copied = await (await api(request, token, 'POST', `/versions/${budget2026.id}/copy`, { name: `E2E临时复制稿${suffix}` })).json(); created.versions.push(copied.id);
    expect((await (await api(request, token, 'GET', `/versions/${copied.id}/matrix`)).json()).entries).toHaveLength(2402);

    const rules = await (await api(request, token, 'GET', '/calculation-rules')).json();
    const calculation = await (await api(request, token, 'POST', `/versions/${copied.id}/calculation-preview`, { ruleId: rules.items[0].id })).json();
    expect(calculation.items).toBeDefined();

    // 所有导出和模板都必须生成有效 XLSX，而不是只返回 200。
    await expectXlsx(request, token, `/io/export/budget-detail/${budget2026.id}`);
    await expectXlsx(request, token, '/io/export/actual-current/2026');
    await expectXlsx(request, token, `/io/export/completion/${budget2026.id}`);
    await expectXlsx(request, token, '/io/export/historical');
    await expectXlsx(request, token, `/io/export/version-compare?base=${budget2026.id}&target=${forecast2026.id}`);
    await expectXlsx(request, token, `/io/export/snapshot/${batches2026[0].id}`);
    await expectXlsx(request, token, '/io/export/logs');
    await expectXlsx(request, token, '/io/export/metrics');
    await expectXlsx(request, token, '/io/template/budget');
    await expectXlsx(request, token, '/io/template/actual?year=2026&snapshotDate=2026-08-22');

    const backup = await (await api(request, token, 'POST', '/backup/create', { tag: 'deep-e2e' })).json();
    expect((await (await api(request, token, 'GET', `/backup/verify?file=${encodeURIComponent(backup.file)}&scope=daily`)).json()).ok).toBe(true);
  } finally {
    for (const id of created.versions.reverse()) await api(request, token, 'DELETE', `/versions/${id}`).catch(() => undefined);
    for (const id of created.sheets.reverse()) await api(request, token, 'DELETE', `/sheets/${id}`).catch(() => undefined);
    for (const id of created.metrics.reverse()) await api(request, token, 'DELETE', `/metrics/${id}`).catch(() => undefined);
    for (const id of created.accounts.reverse()) await api(request, token, 'DELETE', `/account/${id}`).catch(() => undefined);
    for (const id of created.orgs.reverse()) await api(request, token, 'DELETE', `/org/${id}`).catch(() => undefined);
  }
});

test('预算附注历史九项交互验收：新增、修改、清空、公式、筛选、键盘、台账与接口', async ({ page, request }) => {
  const token = await login(page);
  const suffix = Date.now().toString().slice(-8);
  const sourceId = await currentBudgetVersionId(request, token, 2026);
  const sourceMatrix = await (await api(request, token, 'GET', `/versions/${sourceId}/matrix`)).json();
  const sample = sourceMatrix.entries.find((e: any) => e.amountCents !== 0) ?? sourceMatrix.entries[0];
  const draft = await (await api(request, token, 'POST', '/versions', { year: 2028, kind: 'budget', name: `E2E附注历史${suffix}`, note: '附注历史验收' })).json();
  try {
    const put = async (note: string | undefined, formula?: string) => {
      const current = await (await api(request, token, 'GET', `/versions/${draft.id}`)).json();
      return api(request, token, 'PUT', `/versions/${draft.id}/entries`, { expectedRevision: current.revision, entries: [{ orgId: sample.orgId, accountId: sample.accountId, amount: '100.00', note, formula }] });
    };
    await put('第一行\n中文依据 123 / %', '=50*2');
    await api(request, token, 'POST', `/versions/${draft.id}/checkpoints`, { title: '附注新增与公式' });
    await put('第二行：已签合同金额', '=40+60');
    await api(request, token, 'POST', `/versions/${draft.id}/checkpoints`, { title: '附注修改' });
    await put(undefined, '');
    await api(request, token, 'POST', `/versions/${draft.id}/checkpoints`, { title: '附注清空' });
    // 恢复一个当前附注以便台账入口有可见行；不再记录 checkpoint，历史仍保持前三个记录点。
    await put('当前附注');

    const history = await (await api(request, token, 'GET', `/versions/${draft.id}/cell-history?orgId=${sample.orgId}&accountId=${sample.accountId}`)).json();
    expect(history.changes).toHaveLength(3);
    expect(history.changes.map((c: any) => c.before.note + '→' + c.after.note)).toEqual(expect.arrayContaining(['→第一行\n中文依据 123 / %', '第一行\n中文依据 123 / %→第二行：已签合同金额', '第二行：已签合同金额→']));

    await page.goto(`/budget/${draft.id}`);
    await expect(page.getByText('E2E附注历史').first()).toBeVisible();
    await page.getByRole('button', { name: '更多' }).click();
    await page.getByRole('menuitem', { name: /编制记录/ }).click();
    for (const title of ['附注新增与公式', '附注修改', '附注清空']) {
      await page.locator('.ant-collapse-header').filter({ hasText: title }).click();
    }
    await expect(page.getByText('新增附注', { exact: true })).toBeVisible();
    await expect(page.getByText('修改附注', { exact: true })).toBeVisible();
    await expect(page.getByText('清空附注', { exact: true })).toBeVisible();
    await expect(page.getByText(/第一行/).first()).toBeVisible();
    await expect(page.getByText('第二行：已签合同金额', { exact: true }).first()).toBeVisible();
    await expect(page.getByText('公式已修改', { exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: /含附注变动/ }).first().click();
    await expect(page.getByText('新增附注', { exact: true }).first()).toBeVisible();
    await page.getByRole('button', { name: /全部/ }).first().click();
    await page.locator('.ant-drawer-close:visible').click();

    // 台账入口调用同一 cell-history API，且键盘可触达的悬浮历史入口不依赖逐格请求。
    await page.getByRole('button', { name: '更多' }).click();
    await page.getByRole('menuitem', { name: /测算依据台账/ }).click();
    await expect(page.getByText(/测算依据与底稿附注台账/)).toBeVisible();
    await page.getByRole('button', { name: '查看历史' }).first().click();
    await expect(page.getByText(/附注变更历史/)).toBeVisible();
    await page.locator('.ant-modal-close').click();
    await page.locator('.ant-drawer-close:visible').click();
    const keyboardHistoryAnchor = page.locator('[aria-label^="查看此格变动历史"]').first();
    if (await keyboardHistoryAnchor.count()) {
      await keyboardHistoryAnchor.focus();
      await keyboardHistoryAnchor.press('Enter');
      await expect(page.getByText(/编制记录/).first()).toBeVisible();
    }
  } finally {
    await api(request, token, 'DELETE', `/versions/${draft.id}`).catch(() => undefined);
  }
});
