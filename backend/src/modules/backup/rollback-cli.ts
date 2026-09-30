/**
 * 代码回退的数据侧检查与恢复(AC-X08),由 scripts/rollback.sh 调用;服务须已停止。
 *
 *   node dist/modules/backup/rollback-cli.js inspect --data-dir <目录> --old-dist <backend/dist.old>
 *   node dist/modules/backup/rollback-cli.js restore --data-dir <目录> --old-dist <backend/dist.old> --backup <备份名或路径> [--accept-data-loss]
 *
 * inspect:比较当前库 schema 与旧代码支持的最高版本,列出可用的迁移前备份。
 * restore:把库恢复到迁移前备份(不做迁移,保持旧 schema)。备份之后的新增写入(审计日志中
 * 非备份/迁移动作)先列出,未加 --accept-data-loss 时拒绝(退出码 3)。恢复前自动留 pre-rollback 备份。
 * 退出码:0 成功/兼容;1 错误;3 需要确认数据丢失;4 schema 不兼容(inspect)。
 */
import fs from 'fs';
import path from 'path';
import { integrityCheck, openDatabase, openReadonlyDatabase } from '../../db/connection';
import { appliedMigrations } from '../../db/migrations';
import { writeLog } from '../audit/log';
import {
  backupDirOf, backupRootOf, createBackup, fillRuntimeObjects, listBackups, resolveBackupFile, verifyBackupBundle,
} from './backup.service';

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function required(name: string): string {
  const v = arg(name);
  if (!v) throw new Error(`缺少参数 --${name}`);
  return v;
}

/** 旧代码支持的最高 schema 版本:读取旧产物的迁移列表。 */
function oldMaxVersion(oldDist: string): number {
  const file = path.resolve(oldDist, 'db', 'migrations.js');
  if (!fs.existsSync(file)) throw new Error(`旧产物缺少迁移定义: ${file}`);
  // eslint-disable-next-line @typescript-eslint/no-require-imports
  const mod = require(file) as { MIGRATIONS: { version: number }[] };
  return Math.max(...mod.MIGRATIONS.map((m) => m.version));
}

function versionOf(file: string): number | null {
  const db = openReadonlyDatabase(file);
  try {
    const a = appliedMigrations(db);
    return a.length ? a[a.length - 1].version : null;
  } finally {
    db.close();
  }
}

function resolveBackup(dataDir: string, dbPath: string, name: string): string {
  if (fs.existsSync(name) && name.includes(path.sep)) return path.resolve(name);
  const dir = backupDirOf(dbPath);
  const daily = resolveBackupFile(dir, name, 'daily');
  if (fs.existsSync(daily)) return daily;
  const monthly = resolveBackupFile(dir, name, 'monthly');
  if (fs.existsSync(monthly)) return monthly;
  throw new Error(`备份不存在: ${name}(目录 ${dir})`);
}

interface NewWrite { action: string; count: number; first: string; last: string }

/** 备份之后写入当前库的审计记录(按动作汇总);备份与迁移自身的记录不算业务写入。 */
function writesAfter(backupFile: string, dbPath: string): NewWrite[] {
  const b = openReadonlyDatabase(backupFile);
  let maxId: number;
  try {
    maxId = (b.prepare('SELECT COALESCE(MAX(id), 0) AS m FROM operation_log').get() as { m: number }).m;
  } finally {
    b.close();
  }
  const cur = openReadonlyDatabase(dbPath);
  try {
    return cur.prepare(`SELECT action, COUNT(*) AS count, MIN(created_at) AS first, MAX(created_at) AS last FROM operation_log
      WHERE id > ? AND action NOT LIKE 'backup.%' AND action NOT LIKE 'migration.%' GROUP BY action ORDER BY first`).all(maxId) as NewWrite[];
  } finally {
    cur.close();
  }
}

async function main(): Promise<number> {
  const cmd = process.argv[2];
  const dataDir = path.resolve(required('data-dir'));
  const dbPath = path.join(dataDir, 'newfc.sqlite');
  if (!fs.existsSync(dbPath)) throw new Error(`数据库不存在: ${dbPath}`);
  const oldMax = oldMaxVersion(required('old-dist'));
  const dbVersion = versionOf(dbPath);

  if (cmd === 'inspect') {
    const compatible = dbVersion === null || dbVersion <= oldMax;
    const preMigrate = listBackups(backupDirOf(dbPath)).filter((b) => b.name.startsWith('pre-migrate')).map((b) => b.name);
    console.log(JSON.stringify({ dbVersion, oldCodeMaxVersion: oldMax, compatible, preMigrateBackups: preMigrate }, null, 2));
    return compatible ? 0 : 4;
  }
  if (cmd !== 'restore') throw new Error('用法: rollback-cli inspect|restore --data-dir <目录> --old-dist <目录> [--backup <备份>] [--accept-data-loss]');

  const backupFile = resolveBackup(dataDir, dbPath, required('backup'));
  const bundle = verifyBackupBundle(backupFile);
  if (!bundle.ok) throw new Error(`备份包校验失败: ${bundle.message}`);
  const backupVersion = versionOf(backupFile);
  if (backupVersion !== null && backupVersion > oldMax) {
    throw new Error(`备份 schema V${backupVersion} 仍高于旧代码支持的 V${oldMax},请选择更早的迁移前备份`);
  }
  const writes = writesAfter(backupFile, dbPath);
  if (writes.length > 0) {
    console.log('备份之后存在以下写入,恢复后将丢失:');
    for (const w of writes) console.log(`  ${w.action} × ${w.count}(${w.first} ~ ${w.last})`);
    if (!process.argv.includes('--accept-data-loss')) {
      console.log('确认丢弃这些写入请加 --accept-data-loss;当前库会先备份为 pre-rollback。');
      return 3;
    }
  }

  const db = openDatabase(dbPath);
  let objectsRestored = 0;
  try {
    const pre = await createBackup(db, backupDirOf(dbPath), 'pre-rollback');
    console.log(`当前库已备份: ${pre.file}`);
    if (bundle.manifest) objectsRestored = fillRuntimeObjects(bundle.manifest, backupRootOf(backupFile), path.join(dataDir, 'objects'));
    db.pragma('wal_checkpoint(TRUNCATE)');
  } finally {
    db.close();
  }
  fs.copyFileSync(backupFile, dbPath);
  for (const ext of ['-wal', '-shm']) if (fs.existsSync(dbPath + ext)) fs.unlinkSync(dbPath + ext);
  const restored = openDatabase(dbPath);
  try {
    if (!integrityCheck(restored)) throw new Error('恢复后完整性检查未通过;可用 pre-rollback 备份还原');
    writeLog(restored, 'backup.restore', 'backup', path.basename(backupFile), {
      file: path.basename(backupFile), rollback: true, fromVersion: dbVersion, toVersion: backupVersion, objectsRestored, discardedWrites: writes,
    });
  } finally {
    restored.close();
  }
  console.log(JSON.stringify({ ok: true, fromVersion: dbVersion, toVersion: backupVersion, objectsRestored, discardedWrites: writes.length }));
  return 0;
}

main().then((code) => process.exit(code), (e) => {
  console.error(`回退失败: ${e instanceof Error ? e.message : String(e)}`);
  process.exit(1);
});
