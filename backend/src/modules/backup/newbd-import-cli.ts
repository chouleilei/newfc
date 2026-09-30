/**
 * newbd 快照迁入:
 *
 *   npm run import:newbd -- --source <newbd 快照.sqlite> --target <newfc 数据目录> [--replace]
 *
 * 核对报告(JSON)输出到标准输出并写入 <target>/newbd-import-report.json,身份映射写入 <target>/id-map.csv。
 * 不创建账号;迁入后用 npm run admin:create 创建首个管理员。失败时退出码 1。
 */
import { importNewbdSnapshot } from './newbd-import';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const source = arg('source');
  const target = arg('target');
  if (!source || !target) {
    console.error('用法: npm run import:newbd -- --source <快照文件> --target <数据目录> [--replace]');
    process.exit(2);
  }
  const report = await importNewbdSnapshot({ source, target, replace: process.argv.includes('--replace') });
  console.log(JSON.stringify(report, null, 2));
}

main().catch((e) => {
  console.error(`迁入失败: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
