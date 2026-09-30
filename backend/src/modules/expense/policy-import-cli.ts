/**
 * 从 JSON 文件发布制度依据(显式运维操作;页面“制度依据”同样可维护)。
 *
 *   npm run expense:policy:import -- --file ../deploy/expense-policy-lishui.json [--new-version]
 *
 * 文件格式同 POST /api/expense/policies。同编码已有生效版本时默认跳过(可重复执行);
 * 加 --new-version 发布为新版本。数据目录取 NEWFC_DATA_DIR(默认 <cwd>/data),与服务一致;
 * 存在待执行迁移时拒绝。审计记为 cli 来源。
 */
import fs from 'fs';
import path from 'path';
import { openDatabase } from '../../db/connection';
import { dbInitialized, pendingMigrations } from '../../db/migrations';
import { runWithContext, systemContext } from '../../core/request-context';
import { parseInput } from '../../core/validate';
import { policyCreateRequest } from '../../contracts/expense';
import { createPolicy } from './expense.service';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function main(): void {
  const file = arg('file');
  if (!file) throw new Error('用法: policy-import-cli --file <制度 JSON> [--new-version]');
  const input = parseInput(policyCreateRequest, JSON.parse(fs.readFileSync(path.resolve(file), 'utf8')));
  const dataDir = process.env.NEWFC_DATA_DIR || path.join(process.cwd(), 'data');
  const db = openDatabase(path.join(dataDir, 'newfc.sqlite'));
  try {
    if (!dbInitialized(db) || pendingMigrations(db).length > 0) throw new Error('数据库未初始化或存在待执行迁移,请先执行 npm run migrate:dist');
    const existing = db.prepare("SELECT MAX(version) AS v FROM ex_policy WHERE code = ? AND status = 'active'").get(input.code) as { v: number | null };
    if (existing.v !== null && !process.argv.includes('--new-version')) {
      process.stdout.write(`制度 ${input.code} 已有生效版本 v${existing.v},跳过(发布新版本加 --new-version)\n`);
      return;
    }
    const p = runWithContext(systemContext('cli'), () => createPolicy(db, input));
    process.stdout.write(`已发布制度 ${p.code} v${p.version}:${p.clauses.length} 条条款,生效日期 ${p.effectiveFrom}\n`);
  } finally {
    db.close();
  }
}

try {
  main();
} catch (error) {
  process.stderr.write(`失败: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
}
