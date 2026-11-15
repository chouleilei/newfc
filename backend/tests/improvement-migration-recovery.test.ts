import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase, openReadonlyDatabase } from '../src/db/connection';
import { applyMigrations } from '../src/db/migrations';
import { backupDirOf, createBackup, restoreBackup, verifyBackupFile } from '../src/modules/backup/backup.service';

/** AC-T13-02 / AC-T14-02 / AC-X07：把原手工演练固化为可重复的空库/非空库升级与恢复门禁。 */
describe('T-13～T-15 V72→V75 独立迁移恢复验收', () => {
  it('逐版升级保留非空合同及超2^53金额、全部旧触发器；备份回退与自动补迁移恢复无损', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'newfc-acceptance-v75-'));
    const dbPath = path.join(dir, 'newfc.sqlite');
    let db = openDatabase(dbPath);
    const exact = 9_007_199_254_740_993n;
    try {
      applyMigrations(db, 72);
      db.prepare("INSERT INTO org (id,code,name,status,created_at,updated_at) VALUES (1,'AC-HQ','合成总部','active','2026-01-01','2026-01-01')").run();
      db.prepare(`INSERT INTO ct_contract (contract_no,normalized_no,name,org_id,original_cents,created_at,updated_at)
        VALUES ('AC-BIGINT','AC-BIGINT','超安全整数精确金额合同',1,?,'2026-01-01','2026-01-01')`).run(exact);
      const triggers = (db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all() as { name: string }[]).map((r) => r.name);
      const backup = await createBackup(db, backupDirOf(dbPath), 'acceptance-v72');
      const backupPath = path.join(backupDirOf(dbPath), backup.file);
      expect(verifyBackupFile(backupPath).ok).toBe(true);
      for (const version of [73, 74, 75]) {
        expect(applyMigrations(db, version).map((m) => m.version)).toEqual([version]);
        expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
        expect(db.pragma('foreign_key_check')).toEqual([]);
        expect(db.prepare('SELECT original_cents FROM ct_contract').safeIntegers(true).get()).toEqual({ original_cents: exact });
        const nextTriggers = new Set((db.prepare("SELECT name FROM sqlite_master WHERE type='trigger'").all() as { name: string }[]).map((r) => r.name));
        for (const trigger of triggers) expect(nextTriggers.has(trigger), `V${version}: ${trigger}`).toBe(true);
      }
      expect(applyMigrations(db)).toEqual([]);
      const old = openReadonlyDatabase(backupPath);
      try {
        expect(old.prepare('SELECT MAX(version) AS v FROM schema_migration').get()).toEqual({ v: 72 });
        expect(old.prepare('SELECT original_cents FROM ct_contract').safeIntegers(true).get()).toEqual({ original_cents: exact });
      } finally { old.close(); }
      // 文件级回退副本：独立验证可用，运行库仍保持隔离在本临时目录。
      const rollbackPath = path.join(dir, 'rollback.sqlite');
      fs.copyFileSync(backupPath, rollbackPath);
      const rollback = openDatabase(rollbackPath);
      try { expect(rollback.pragma('integrity_check', { simple: true })).toBe('ok'); expect(rollback.prepare('SELECT MAX(version) AS v FROM schema_migration').get()).toEqual({ v: 72 }); } finally { rollback.close(); }
      const holder = { current: db, getDb() { return this.current; }, reopenWith(next: typeof db) { this.current = next; } };
      const restored = await restoreBackup(holder, dbPath, backupPath, true);
      db = holder.current;
      expect(restored).toMatchObject({ ok: true, originalVersion: 72, finalVersion: 75 });
      expect(restored.appliedMigrations.map((m) => m.version)).toEqual([73, 74, 75]);
      expect(db.prepare('SELECT original_cents FROM ct_contract').safeIntegers(true).get()).toEqual({ original_cents: exact });
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(db.prepare("SELECT COUNT(*) AS n FROM ct_legal_template WHERE approval_status = 'official'").get()).toEqual({ n: 0 });
      const empty = openDatabase(':memory:');
      try { expect(applyMigrations(empty)).toHaveLength(75); expect(empty.pragma('integrity_check', { simple: true })).toBe('ok'); expect(empty.pragma('foreign_key_check')).toEqual([]); } finally { empty.close(); }
    } finally {
      if (db.open) db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
