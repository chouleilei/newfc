/**
 * 独立目录恢复演练(AC-X07):
 *
 *   npm run restore:drill -- --backup <备份文件.sqlite> --target <空目录> [--source <原库,只读比较>]
 *
 * 结果(JSON)输出到标准输出,并写入 <target>/restore-drill-report.json;失败时退出码 1。
 */
import { runRestoreDrill } from './restore-drill';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function main() {
  const backup = arg('backup');
  const target = arg('target');
  if (!backup || !target) {
    console.error('用法: npm run restore:drill -- --backup <备份文件> --target <空目录> [--source <原库>]');
    process.exit(2);
  }
  const report = await runRestoreDrill({ backup, target, source: arg('source') });
  console.log(JSON.stringify(report, null, 2));
  process.exit(report.ok ? 0 : 1);
}

main().catch((e) => {
  console.error(`恢复演练失败: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
