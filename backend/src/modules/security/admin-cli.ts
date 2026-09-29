/**
 * 首个管理员初始化与口令恢复(显式运维操作,不存在默认口令)。
 *
 *   npm run admin:create -- --username admin [--display-name 管理员]
 *   npm run admin:reset-password -- --username admin
 *
 * 口令从标准输入读取(交互终端不回显);非交互可用管道输入。
 * 数据目录取 NEWFC_DATA_DIR(默认 <cwd>/data),与服务一致。
 */
import path from 'path';
import readline from 'readline';
import { openDatabase } from '../../db/connection';
import { applyMigrations, dbInitialized, pendingMigrations } from '../../db/migrations';
import { runWithContext, systemContext } from '../../core/request-context';
import { bootstrapAdmin, resetPasswordByUsername } from './security.service';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

async function readPassword(prompt: string): Promise<string> {
  if (!process.stdin.isTTY) {
    const chunks: Buffer[] = [];
    for await (const chunk of process.stdin) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks).toString('utf8').split(/\r?\n/)[0];
  }
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout, terminal: true });
  const out = rl as unknown as { _writeToOutput: (s: string) => void; output: NodeJS.WriteStream };
  let muted = false;
  out._writeToOutput = (s: string) => { if (!muted) out.output.write(s); };
  const answer = await new Promise<string>((resolve) => {
    rl.question(prompt, (a) => resolve(a));
    muted = true;
  });
  rl.close();
  process.stdout.write('\n');
  return answer;
}

async function main(): Promise<void> {
  const mode = process.argv[2];
  const username = arg('username');
  if (!username || (mode !== 'create' && mode !== 'reset-password')) {
    throw new Error('用法: admin-cli create|reset-password --username <name> [--display-name <显示名>]');
  }
  const dataDir = process.env.NEWFC_DATA_DIR || path.join(process.cwd(), 'data');
  const dbPath = path.join(dataDir, 'newfc.sqlite');
  const db = openDatabase(dbPath);
  try {
    if (dbInitialized(db) && pendingMigrations(db).length > 0) {
      throw new Error('数据库存在待执行迁移,请先执行 npm run migrate:dist');
    }
    if (!dbInitialized(db)) applyMigrations(db);
    const password = await readPassword('口令(至少 10 位): ');
    if (process.stdin.isTTY) {
      const again = await readPassword('再次输入: ');
      if (again !== password) throw new Error('两次输入不一致');
    }
    runWithContext(systemContext('cli'), () => {
      if (mode === 'create') {
        const user = bootstrapAdmin(db, username, password, arg('display-name'));
        process.stdout.write(`已创建管理员 ${user.username}(id=${user.id}),数据库: ${dbPath}\n`);
      } else {
        resetPasswordByUsername(db, username, password);
        process.stdout.write(`已重置 ${username} 的口令并吊销其全部会话;下次登录需修改口令。\n`);
      }
    });
  } finally {
    db.close();
  }
}

main().catch((error) => {
  process.stderr.write(`失败: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
