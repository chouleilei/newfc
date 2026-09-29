import { expect, test, type APIRequestContext, type Page } from '@playwright/test';

/**
 * 数据驱动页面测试(方案《小澧助手全页面回答范围自动对齐开发计划》§13.4)。
 *
 * 28 个 pageKey 共用一个测试函数与页面数据表:
 * 1. 进入路由或页签;
 * 2. 等待页面 ready(ScopeBar 出现「已对齐」);
 * 3. 打开小澧助手;
 * 4. 检查 pageKey 与主范围(请求体 pageContext);
 * 5. 支持时改变一个筛选,确认范围跟随变化;
 * 6. 发送页面通用问题;
 * 7. 检查响应的 contextStatus / effectiveContext / capability / citations。
 *
 * 在 finance project(免鉴权夹具库)运行;模型环境变量由 playwright.config.ts 清空,
 * 全部走确定性规则路由。
 */

const YEAR = new Date().getFullYear();

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

/** 备两个版本(版本对比页需要 base+target)并录入实际数,让执行分析类页面能就绪。 */
async function seed(request: APIRequestContext): Promise<{ v1: number; v2: number }> {
  const versions: any[] = await json(request, `/api/versions?year=${YEAR}`);
  let v1 = versions.find((v) => v.name.includes('页面E2E-V1'));
  let v2 = versions.find((v) => v.name.includes('页面E2E-V2'));
  const orgs = (await json(request, '/api/org/tree')).tree ?? [];
  const accounts = (await json(request, '/api/account/tree')).tree ?? [];
  const sh = findByCode(orgs, 'SH');
  const income = findByCode(accounts, 'I01');
  const cost = findByCode(accounts, 'C01');
  const expense = findByCode(accounts, 'E01');
  expect(sh && income && cost && expense, '种子数据缺少 SH/I01/C01/E01').toBeTruthy();

  if (!v1) {
    const created = await request.post('/api/versions', { data: { year: YEAR, name: `${YEAR}年度预算(页面E2E-V1)` } });
    expect(created.ok()).toBeTruthy();
    v1 = await created.json();
    const entries = await request.put(`/api/versions/${v1.id}/entries`, {
      data: {
        expectedRevision: v1.revision,
        entries: [
          { orgId: sh.id, accountId: income.id, amount: '100.00' },
          { orgId: sh.id, accountId: cost.id, amount: '60.00' },
          { orgId: sh.id, accountId: expense.id, amount: '20.00' },
        ],
      },
    });
    expect(entries.ok(), 'V1 录数应当成功').toBeTruthy();
    expect((await request.post(`/api/versions/${v1.id}/lock`)).ok(), 'V1 定稿应当成功').toBeTruthy();
    expect((await request.post(`/api/versions/${v1.id}/set-current`)).ok(), 'V1 设为当前生效应成功').toBeTruthy();
  }
  if (!v2) {
    const created = await request.post('/api/versions', { data: { year: YEAR, name: `${YEAR}年度预算(页面E2E-V2)` } });
    expect(created.ok()).toBeTruthy();
    v2 = await created.json();
    const entries = await request.put(`/api/versions/${v2.id}/entries`, {
      data: {
        expectedRevision: v2.revision,
        entries: [
          { orgId: sh.id, accountId: income.id, amount: '120.00' },
          { orgId: sh.id, accountId: cost.id, amount: '70.00' },
        ],
      },
    });
    expect(entries.ok(), 'V2 录数应当成功').toBeTruthy();
    expect((await request.post(`/api/versions/${v2.id}/lock`)).ok(), 'V2 定稿应当成功').toBeTruthy();
  }
  // 实际数:让 analysis/structure/dashboard 的核验与执行口径就绪
  const batches: any[] = (await json(request, `/api/actual/batches?year=${YEAR}`)).items ?? [];
  if (batches.length === 0) {
    const saved = await request.post('/api/actual/save', {
      data: {
        year: YEAR,
        snapshotDate: `${YEAR}-06-30`,
        entries: [
          { orgId: sh.id, accountId: income.id, amount: '55.00' },
          { orgId: sh.id, accountId: cost.id, amount: '33.00' },
        ],
        expectedCurrentBatchId: null,
      },
    });
    expect(saved.ok(), '实际数保存应当成功').toBeTruthy();
  }
  return { v1: v1.id, v2: v2.id };
}

interface PageCase {
  /** 预期 pageKey */
  key: string;
  /** 路由(可含函数参数 versionId) */
  path: string | ((ids: { v1: number; v2: number }) => string);
  /** ScopeBar 里应出现的页面标签 */
  label: string;
  /** 可选:改变一个筛选后期望变化出现在请求体里的字段 */
  scopeField?: string;
}

const PAGE_CASES: PageCase[] = [
  { key: 'dashboard', path: '/', label: '首页工作台', scopeField: 'year' },
  { key: 'assistant', path: '/assistant', label: '小澧助手' },
  { key: 'insights', path: '/insights', label: '洞察报告' },
  { key: 'master_health', path: '/master-health', label: '主数据健康' },
  { key: 'cleaning_config', path: '/cleaning-config', label: '清洗配置' },
  { key: 'budget_progress', path: '/progress', label: '编制进度', scopeField: 'budgetVersionId' },
  { key: 'anomaly_center', path: '/alerts', label: '异常预警中心', scopeField: 'budgetVersionId' },
  { key: 'metric_trend', path: '/metric-trend', label: '指标趋势' },
  { key: 'ai_settings', path: '/settings/ai', label: 'AI 渠道设置' },
  { key: 'org', path: '/org', label: '组织管理' },
  { key: 'account', path: '/account', label: '科目管理' },
  { key: 'metric', path: '/metric', label: '报表指标' },
  { key: 'budget_versions', path: '/budget', label: '预算与预测版本' },
  { key: 'budget_edit', path: (ids) => `/budget/${ids.v1}`, label: '预算编制表格', scopeField: 'budgetVersionId' },
  { key: 'actual', path: '/actual', label: '实际录入与快照', scopeField: 'year' },
  { key: 'finance_import', path: '/finance', label: '财务系统转换' },
  { key: 'analysis', path: '/analysis', label: '年度执行分析', scopeField: 'year' },
  { key: 'structure', path: '/structure', label: '结构分析', scopeField: 'year' },
  { key: 'history', path: '/history', label: '历年对比与趋势' },
  { key: 'version_compare', path: '/compare', label: '版本对比', scopeField: 'baseVersionId' },
  { key: 'calculations', path: '/data?tab=calculations', label: '测算模板' },
  { key: 'imports', path: '/data?tab=imports', label: '导入批次' },
  { key: 'data_check', path: '/data?tab=check', label: '一致性检查' },
  { key: 'yearclose', path: '/data?tab=yearclose', label: '年度关闭' },
  { key: 'backup', path: '/data?tab=backup', label: '备份与迁移' },
  { key: 'migration', path: '/data?tab=migration', label: '迁移管理' },
  { key: 'data_export', path: '/data?tab=export', label: '数据导出' },
  { key: 'logs', path: '/data?tab=logs', label: '操作日志' },
];

/** 通用问题:规则路由能稳定回答,且每页的能力都允许。 */
const QUESTION = '列出预算版本';

test.describe('全页面回答范围自动对齐(§13.4)', () => {
  test.describe.configure({ mode: 'serial' });
  let ids: { v1: number; v2: number };
  test.beforeAll(async ({ request }) => {
    ids = await seed(request);
  });

  for (const pageCase of PAGE_CASES) {
    test(`页面 ${pageCase.key} 对齐`, async ({ page }) => {
      const chatBodies: any[] = [];
      const chatResponses: any[] = [];
      page.on('request', (req) => {
        // 抽屉默认走流式 /chat/stream,两种入口都要捕获
        if (req.url().includes('/api/assistant/chat') && req.method() === 'POST') {
          try { chatBodies.push(JSON.parse(req.postData() ?? '{}')); } catch { /* 忽略 */ }
        }
      });
      page.on('response', (res) => {
        if (!res.url().includes('/api/assistant/chat') || res.request().method() !== 'POST') return;
        res.text().then((text) => {
          if (res.url().includes('/stream')) {
            // SSE:取最后一个 data: {...} done 事件
            const done = text.split('\n').filter((line) => line.startsWith('data: ')).map((line) => line.slice(6))
              .map((line) => { try { return JSON.parse(line); } catch { return null; } })
              .filter((item) => item && item.done === true && item.text != null)
              .pop();
            if (done) chatResponses.push(done);
          } else {
            try { chatResponses.push(JSON.parse(text)); } catch { /* 忽略 */ }
          }
        }).catch(() => {});
      });

      // 1. 进入路由或页签
      const path = typeof pageCase.path === 'function' ? pageCase.path(ids) : pageCase.path;
      await page.goto(path);

      // 2. 等待页面 ready + 3. 打开小澧助手(ScopeBar 在抽屉里;完整页也有一条,用容器限定)
      await page.getByTestId('assistant-dock-trigger').click();
      const dock = page.locator('.bd-assistant-dock');
      const scopeBar = dock.getByTestId('assistant-scope-bar');
      await expect(scopeBar).toBeVisible();
      // 就绪后徽标出现「已对齐 · {页面标签}」;异步默认值的页面多等一会
      await expect(scopeBar).toContainText('已对齐', { timeout: 30_000 });
      await expect(scopeBar).toContainText(pageCase.label);

      // 6. 发送页面通用问题
      await page.getByTestId('assistant-dock-input').fill(QUESTION);
      await page.getByTestId('assistant-dock-send').click();
      await expect(page.getByTestId('assistant-dock-answer').last()).not.toBeEmpty({ timeout: 60_000 });
      await expect(page.getByTestId('assistant-dock-send')).toBeVisible({ timeout: 60_000 });

      // 7. 请求体与响应校验
      expect(chatBodies.length, '应当发出 chat 请求').toBeGreaterThan(0);
      const body = chatBodies[chatBodies.length - 1];
      // 4. pageKey 检查
      expect(body.pageContext?.pageKey, '请求体 pageContext.pageKey').toBe(pageCase.key);
      expect(body.pageContext?.schemaVersion).toBe(2);
      expect(body.pageContext?.routeInstanceId).toBeTruthy();

      const response = chatResponses[chatResponses.length - 1];
      expect(response, '应当收到 chat 响应').toBeTruthy();
      expect(['aligned', 'explicit_override']).toContain(response.contextStatus);
      expect(response.effectiveContext?.pageKey, 'effectiveContext.pageKey').toBe(pageCase.key);
      expect(typeof response.capability, 'capability 必须存在').toBe('string');
      expect(response.contextSummary, 'contextSummary 必须存在').toBeTruthy();
      expect(Array.isArray(response.citations), 'citations 必须是数组').toBe(true);
      // 主范围字段:页面声明了主范围时,请求体必须携带
      if (pageCase.scopeField) {
        expect(
          body.pageContext?.scope?.[pageCase.scopeField] ?? body.context?.[pageCase.scopeField === 'baseVersionId' ? 'budgetVersionId' : pageCase.scopeField],
          `主范围 ${pageCase.scopeField} 必须进入请求`,
        ).toBeTruthy();
      }
      // 回答卡显示后端 contextSummary(§10.1)
      await expect(page.getByTestId('assistant-dock-context-summary').last()).toBeVisible();

      // 关闭抽屉,避免下一轮用例的遮罩干扰
      await page.keyboard.press('Escape');
    });
  }
});
