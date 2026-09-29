// 必须在读取任何 process.env 之前加载：`.env` 只补齐「还没设置」的变量，
// 显式 export 的值与 start.sh 注入的值优先级更高(见 src/env.ts)。
import { loadEnvFiles } from './env';

const loadedEnv = loadEnvFiles();

import { startServer } from './server';
import { aiConfigurationIssue } from './assistant/model';
import path from 'path';

if (loadedEnv.files.length) {
  console.log(`[startup] 已加载环境变量文件: ${loadedEnv.files.join(', ')}（新增 ${loadedEnv.applied.length} 个变量，已存在的不覆盖）`);
}

const dataDir = process.env.BUDGET_DATA_DIR || path.join(process.cwd(), 'data');
const dbPath = path.join(dataDir, 'budget.sqlite');

const username = process.env.BUDGET_ACCESS_USER ?? '';
const password =
  process.env.BUDGET_DISABLE_AUTH === '1'
    ? ''
    : process.env.BUDGET_ACCESS_PASSWORD ?? '';
if (!username || (!password && process.env.BUDGET_DISABLE_AUTH !== '1')) {
  throw new Error(
    '缺少登录凭据: 请设置 BUDGET_ACCESS_USER 和 BUDGET_ACCESS_PASSWORD;' +
      '仅当显式设置 BUDGET_DISABLE_AUTH=1 时才可关闭登录(仅限可信本机环境)',
  );
}

const aiIssue = aiConfigurationIssue();
if (aiIssue) {
  console.warn(`[startup] AI 模型配置已停用: ${aiIssue}。确定性事实查询与模板回答仍可用。`);
}

const trustProxyRaw = (process.env.BUDGET_TRUST_PROXY ?? '').trim().toLowerCase();
let trustProxy: false | number = false;
if (trustProxyRaw && trustProxyRaw !== '0' && trustProxyRaw !== 'false') {
  if (!/^[1-9]\d*$/.test(trustProxyRaw) || Number(trustProxyRaw) > 32) {
    throw new Error('BUDGET_TRUST_PROXY 必须为 0/false 或 1 到 32 的可信代理跳数');
  }
  trustProxy = Number(trustProxyRaw);
} else {
  // 未启用信任代理时 req.ip 是直接对端地址:反代部署下所有客户端共享同一限流/锁定桶;
  // 信任跳数必须等于真实代理层数,多配且上游追加写 XFF 时客户端可注入伪造条目轮换 IP。
  console.warn('[startup] BUDGET_TRUST_PROXY 未启用:助手限流与登录锁定按直接对端 IP 计数。若服务位于反向代理之后,请把 BUDGET_TRUST_PROXY 设为真实代理跳数(start.sh 反代形态默认为 1;直连部署必须显式设为 0)。');
}

startServer({
  dbPath,
  port: Number(process.env.BUDGET_PORT || 3748),
  host: process.env.BUDGET_HOST || '127.0.0.1',
  auth: { username, password },
  trustProxy,
}).catch((err) => {
  console.error('[startup] 启动失败(含迁移前自动备份/迁移应用):', err);
  process.exit(1);
});
