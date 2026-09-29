/**
 * `.env` 加载(零依赖)。
 *
 * 为什么需要：README 与 `.env.example` 都说「在 `.env` 里设置 `AI_BASE_URL` …」，
 * 但后端进程从来没有读过 `.env`——只有 `start.sh` 会 `export $(grep …)`。
 * 于是 README 自己给出的另外两种启动方式(`npm start` / `npm run dev`)按文档配置
 * 完全不生效，模型明明配好了却一直走确定性兜底。
 *
 * 约定：
 * - 查找顺序为 `backend/.env` → 仓库根 `.env`(BUDGET_DATA_DIR 之类的运维变量通常放根)；
 *   同名变量以先出现者为准。
 * - **绝不覆盖已存在的环境变量**(包括空字符串)：显式 export 的值、`start.sh` 注入的值、
 *   以及测试里刻意置空的 `AI_*` 都必须优先，否则测试隔离会被 `.env` 破坏。
 * - 测试环境(`VITEST`/`NODE_ENV=test`)直接跳过，避免本机 `.env` 影响用例。
 * - 解析规则：忽略空行与 `#` 注释行；`export KEY=VALUE` 前缀可选；
 *   值两侧的成对引号会被去掉，双引号内支持 `\n`；不做变量插值。
 * - 行内注释:与 dotenv 语义一致——未加引号的值里,`#` 前有空白时视为注释起点;
 *   引号内的 `#` 是值的一部分。此前「密码后写注释会把整段注释当成密码」导致登录
 *   全部 401 且极难排查。
 */
import fs from 'fs';
import path from 'path';

export interface LoadEnvResult {
  /** 实际读取到的文件(按加载顺序) */
  files: string[];
  /** 本次真正写入 process.env 的键(已存在的键不会被覆盖) */
  applied: string[];
}

function parseEnv(content: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const withoutExport = line.startsWith('export ') ? line.slice(7).trim() : line;
    const eq = withoutExport.indexOf('=');
    if (eq <= 0) continue;
    const key = withoutExport.slice(0, eq).trim();
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue;
    let value = withoutExport.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"') && value.length >= 2)
      || (value.startsWith("'") && value.endsWith("'") && value.length >= 2)) {
      const quote = value[0];
      value = value.slice(1, -1);
      if (quote === '"') value = value.replace(/\\n/g, '\n').replace(/\\"/g, '"');
    } else {
      // 未加引号:空白后的 # 起为行内注释(dotenv 语义);紧贴值的 # 保留(如密码含 #)
      const comment = /\s#/.exec(value);
      if (comment) value = value.slice(0, comment.index).trim();
    }
    if (!out.has(key)) out.set(key, value);
  }
  return out;
}

/** 候选 .env 路径：后端目录优先，其次仓库根目录。 */
export function envFileCandidates(baseDir: string = path.join(__dirname, '..')): string[] {
  return [path.join(baseDir, '.env'), path.join(baseDir, '..', '.env')];
}

export function loadEnvFiles(candidates: string[] = envFileCandidates(), opts: { allowInTest?: boolean } = {}): LoadEnvResult {
  const result: LoadEnvResult = { files: [], applied: [] };
  if (!opts.allowInTest && (process.env.VITEST || process.env.NODE_ENV === 'test')) return result;
  for (const file of candidates) {
    let content: string;
    try {
      if (!fs.existsSync(file) || !fs.statSync(file).isFile()) continue;
      content = fs.readFileSync(file, 'utf8');
    } catch { continue; }
    result.files.push(file);
    for (const [key, value] of parseEnv(content)) {
      // hasOwnProperty 而不是真值判断：空字符串也算「已显式设置」，不能被文件盖掉。
      if (Object.prototype.hasOwnProperty.call(process.env, key)) continue;
      process.env[key] = value;
      result.applied.push(key);
    }
  }
  return result;
}
