import fs from 'node:fs';
import path from 'node:path';
import { openDatabase } from '../../db/connection';
import { dbInitialized, pendingMigrations } from '../../db/migrations';
import { runWithContext, systemContext } from '../../core/request-context';
import { importLegalSeed } from './legal-catalog.service';
try {
  const fileIndex = process.argv.indexOf('--file');
  const file =
    fileIndex >= 0
      ? process.argv[fileIndex + 1]
      : path.join(process.cwd(), '../deploy/contract-legal-seed-v1.json');
  const input = JSON.parse(fs.readFileSync(file, 'utf8'));
  const db = openDatabase(
    path.join(
      process.env.NEWFC_DATA_DIR || path.join(process.cwd(), 'data'),
      'newfc.sqlite',
    ),
  );
  try {
    if (!dbInitialized(db) || pendingMigrations(db).length)
      throw new Error('请先显式执行迁移');
    const result = runWithContext(systemContext('cli'), () =>
      importLegalSeed(db, input),
    );
    process.stdout.write(`${JSON.stringify(result)}\n`);
  } finally {
    db.close();
  }
} catch (e) {
  process.stderr.write(
    `法审种子导入失败：${e instanceof Error ? e.message : String(e)}\n`,
  );
  process.exitCode = 1;
}
