/**
 * 测试环境隔离。
 *
 * 背景(实测)：Vitest 会把仓库根目录的 `.env` 读进 `process.env`，本机配了真实
 * `AI_BASE_URL` 时，「模型不可用应保留模板叙述」这类断言会真的去调远端模型——
 * 结果 `narrativeSource` 变成 `model`、部分用例 30 秒超时，全量测试在配了模型的
 * 机器上必然失败，而代码本身没有问题。
 *
 * 处置：
 * 1. 把所有模型相关变量置为空字符串（不是 delete —— 空值仍然「存在」，
 *    可以挡住后续任何 dotenv 式的回填），使 `modelConfigured()` 返回 false；
 * 2. 需要真机联调时显式设置 `AI_TEST_ALLOW_REAL_MODEL=1` 才保留原值；
 * 3. 把助手速率限制放到很高，避免集成测试里连续几十次 `/chat` 撞上 429。
 */
const MODEL_ENV_KEYS = [
  'AI_BASE_URL', 'AI_API_KEY', 'AI_MODEL', 'AI_PROVIDER', 'AI_STREAM', 'AI_TIMEOUT_MS', 'AI_TOTAL_TIMEOUT_MS',
  'OPENAI_BASE_URL', 'OPENAI_API_KEY', 'OPENAI_MODEL',
];

if (process.env.AI_TEST_ALLOW_REAL_MODEL !== '1') {
  for (const key of MODEL_ENV_KEYS) process.env[key] = '';
}

// 测试里不做限流：限流本身由 tests/assistant.extensions.test.ts 单独用例覆盖。
process.env.AI_RATE_LIMIT_PER_MIN = process.env.AI_RATE_LIMIT_PER_MIN_TEST || '100000';

// 进程退出时 better-sqlite3 的 Statement 析构晚于 env 拆解会触发原生断言
// (Assertion failed: (env) != nullptr)，整文件测试中途崩溃。统一在每个测试文件
// 结束时关闭经 helpers 打开的连接，避免泄漏到进程退出阶段。
import { afterAll } from 'vitest';
import { closeAllTestDbs } from './helpers';

afterAll(() => {
  closeAllTestDbs();
});
