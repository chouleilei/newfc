import fs from 'fs';
import path from 'path';
import { openDatabase } from '../../db/connection';
import { applyMigrations } from '../../db/migrations';
import { parseCliArgs, requireSafeCliDataDir } from '../../db/cli-guard';
import { importBusinessSettingsSnapshot } from './business-settings';

function main(): void {
  const dataDir = requireSafeCliDataDir();
  const args = parseCliArgs(process.argv.slice(2));
  const mode = args.mode === 'preview' ? 'preview' : 'confirm';
  let overrides: Record<string, unknown> = {};
  if (args.json) {
    overrides = JSON.parse(fs.readFileSync(path.resolve(args.json), 'utf8')) as Record<string, unknown>;
  }
  const db = openDatabase(path.join(dataDir, 'newfc.sqlite'));
  try {
    applyMigrations(db);
    const res = importBusinessSettingsSnapshot(db, overrides, mode);
    process.stdout.write(
      `${JSON.stringify({ mode: res.mode, keysUpdated: Object.keys(res.effectiveEntries), totalSettings: res.settings.length })}\n`
    );
  } finally {
    db.close();
  }
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    process.stderr.write(`seed-business-settings-cli 失败：${err instanceof Error ? err.message : String(err)}\n`);
    process.exitCode = 1;
  }
}
