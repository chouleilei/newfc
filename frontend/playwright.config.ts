import path from 'path';
import { defineConfig } from '@playwright/test';

/**
 * E2E 需要两套互不兼容的运行环境，因此起两个后端实例、分两个 project 跑：
 *
 * - `finance`(3761,`finance-e2e` 夹具)：财务转换、AI 助手、表格全屏、登录与会话等用例。
 * - `simulation`(3762,全覆盖模拟夹具)：可视化审计、执行分析、深度功能审计，
 *   断言 26 组织 / 239 科目 / 2022–2026 五年 × 2402 单元格的完整模拟数据。
 *
 * 两个实例都开启真实鉴权(newfc 没有关鉴权开关):seed 脚本在夹具库写入 E2E 账号,
 * 用例经 tests/e2e/access.ts 的 worker 夹具登录并附带 Cookie + CSRF。数据目录都是一次性夹具，seed 时会整体重建。
 */
const FINANCE_URL = process.env.E2E_FINANCE_BASE_URL ?? 'http://127.0.0.1:3761';
const SIMULATION_URL = process.env.E2E_SIMULATION_BASE_URL ?? 'http://127.0.0.1:3762';
const useExistingServer = process.env.E2E_USE_EXISTING_SERVER === '1';

/**
 * 测试服务托管的前端产物目录。默认 frontend/dist 与 3760 生产服务共用——在此构建即等于发布。
 * 验证未发布的改动时先 `npm run build:e2e`(输出到 .e2e-dist)再设 E2E_FRONTEND_DIST=.e2e-dist。
 */
const FRONTEND_DIST = JSON.stringify(path.resolve(process.env.E2E_FRONTEND_DIST ?? 'dist'));

/**
 * 现有服务器模式没有任何夹具保护:测试会对其指向的库创建/修改/删除数据(assistant 系
 * 列还会锁定版本且不清理)。误指真实服务就是生产事故,因此要求再显式声明一次
 * 「我确认目标是可丢弃的测试库」;默认 URL(3761/3762)是本仓库测试专用端口,免确认。
 */
if (useExistingServer && !process.env.E2E_TARGET_IS_DISPOSABLE) {
  const financeCustom = process.env.E2E_FINANCE_BASE_URL != null;
  const simulationCustom = process.env.E2E_SIMULATION_BASE_URL != null;
  if (financeCustom || simulationCustom) {
    throw new Error([
      'E2E_USE_EXISTING_SERVER=1 且自定义了目标 URL,但未设置 E2E_TARGET_IS_DISPOSABLE=1。',
      '测试会对目标服务写入并删除数据(含创建/锁定预算版本)。确认目标是可丢弃的测试库后,',
      '设置 E2E_TARGET_IS_DISPOSABLE=1 再运行。',
    ].join('\n'));
  }
}

/**
 * E2E 必须跑在「未配置模型」的确定性模式下：助手页用例断言的是关键词兜底、模板降级
 * 与固定文案。宿主环境或 `.env` 里配了 AI_* 时，后端会真去调远端模型，回答变成自由行文，
 * 用例必然失败——失败原因是环境泄漏而不是代码回归，因此在这里显式清空。
 * 需要连真实模型联调时改用 E2E_USE_EXISTING_SERVER=1 自行启动服务。
 */
const deterministicModelEnv = {
  AI_BASE_URL: '', AI_API_KEY: '', AI_MODEL: '', AI_PROVIDER: '', AI_STREAM: '', AI_TIMEOUT_MS: '', AI_TOTAL_TIMEOUT_MS: '',
  OPENAI_BASE_URL: '', OPENAI_API_KEY: '', OPENAI_MODEL: '',
  // E2E 会连续提问，放开助手限流避免撞上 429。
  AI_RATE_LIMIT_PER_MIN: '1000',
};

export default defineConfig({
  testDir: './tests/e2e',
  // 该主机内存有限，finance/simulation 两套重夹具并行会触发 swap 抖动并放大固定等待超时。
  // 默认串行是发布门禁；资源充足的专用 CI 如需并行，必须显式修改配置并承担夹具隔离验证。
  workers: 1,
  timeout: 120_000,
  expect: { timeout: 15_000 },
  reporter: [['list'], ['html', { outputFolder: 'playwright-report', open: 'never' }]],
  use: {
    headless: true,
    viewport: { width: 1440, height: 1000 },
    screenshot: 'only-on-failure',
    trace: 'retain-on-failure',
  },
  projects: [
    {
      name: 'finance',
      testMatch: /(assistant|assistant-dock|assistant-pages|finance-import|cleaning-import|fullscreen|usability-trial-finance|auth-session|platform-admin|scope-restricted|finance-data|project-contract|risk-investment|cross-domain)\.spec\.ts$/,
      use: { baseURL: FINANCE_URL },
    },
    {
      name: 'simulation',
      testMatch: /(full-visual-audit|analysis-functional|deep-functional-audit|navigation-expansion|grid-interaction|usability-trial)\.spec\.ts$/,
      // 这些审计共享同一份模拟库，深度功能用例还会创建并清理临时版本；并行执行会让
      // 可视化用例短暂选中随后被删除的版本，产生与产品无关的偶发 404。
      workers: 1,
      use: { baseURL: SIMULATION_URL },
    },
  ],
  webServer: useExistingServer ? undefined : [
    {
      command: `cd ../backend && npm run seed:finance:e2e && NEWFC_PORT=3761 NEWFC_DATA_DIR="$PWD/data/finance-e2e" NEWFC_FRONTEND_DIST=${FRONTEND_DIST} node dist/index.js`,
      url: `${FINANCE_URL}/api/health/ready`,
      reuseExistingServer: false,
      timeout: 120_000,
      env: deterministicModelEnv,
    },
    {
      command: `cd ../backend && npm run seed:e2e:simulation && NEWFC_PORT=3762 NEWFC_DATA_DIR="$PWD/data/e2e-simulation" NEWFC_FRONTEND_DIST=${FRONTEND_DIST} node dist/index.js`,
      url: `${SIMULATION_URL}/api/health/ready`,
      reuseExistingServer: false,
      // 夹具要现建 2022–2026 五年 × 2402 单元格的预算与 20 份快照，比财务夹具慢得多。
      timeout: 600_000,
      env: deterministicModelEnv,
    },
  ],
});
