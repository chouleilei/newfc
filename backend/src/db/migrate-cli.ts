import path from 'path';
import { openDatabase } from './connection';
import { applyMigrations, dbInitialized, pendingMigrations } from './migrations';
import { backupDirOf, createBackup } from '../modules/backup/backup.service';

async function main(): Promise<void> {
  const dataDir = process.env.NEWFC_DATA_DIR || path.join(process.cwd(), 'data');
  const dbPath = path.join(dataDir, 'newfc.sqlite');
  const db = openDatabase(dbPath);
  try {
    const pending = pendingMigrations(db);
    if (pending.length === 0) {
      process.stdout.write('数据库已是最新版本，无待执行迁移。\n');
      return;
    }
    if (dbInitialized(db)) {
      const backup = await createBackup(db, backupDirOf(dbPath), 'pre-migrate-cli');
      process.stdout.write(`迁移前备份已创建：${backup.file}\n`);
    }
    const applied = applyMigrations(db);
    for (const migration of applied) {
      process.stdout.write(`已应用 V${migration.version}：${migration.name}\n`);
    }
  } finally {
    db.close();
  }
}

main().catch((error) => {
  process.stderr.write(`迁移失败：${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
