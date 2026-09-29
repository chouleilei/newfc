/**
 * AI 功能增强计划 §七.3、§七.5 的两项通用验收:
 *
 * 1. 涉及迁移的阶段(二 = V29/V30,六 = V31/V32/V33)含「迁移升级 / 回滚与备份验证」。
 *    这里补的是真正的**回滚**验证:自动 pre-migrate 备份 → 升级 → 用该备份 restoreBackup
 *    回到旧 schema。注意 restoreBackup 的既有语义是「恢复旧备份后自动补迁移」,
 *    所以回滚的可验证事实是:备份文件本身停留在旧 schema 且数据完整(可回退依据),
 *    恢复动作不丢数据、不破坏完整性,并如实报告补了哪些迁移。
 * 2. 阶段六需提供记录点写入延迟的前后对比基准:
 *    小结生成必须在事务外异步进行,记录点写入本身(recordCompilationCheckpoint)
 *    在「挂了小结调度」与「没挂小结调度」两种情况下延迟不得出现量级回归。
 */
import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { testDb, buildFixture, budget } from './helpers';
import { MIGRATIONS, applyMigrations } from '../src/db/migrations';
import { openDatabase, openReadonlyDatabase, type DB } from '../src/db/connection';
import { backupDirOf, createBackup, restoreBackup, verifyBackupFile } from '../src/modules/backup/backup.service';
import { scheduleCheckpointSummary } from '../src/assistant/checkpoint-summary';

/** 从 fromVersion 起的全部迁移版本号(newfc 追加迁移后不必逐条改断言)。 */
const versionsFrom = (fromVersion: number) => MIGRATIONS.map((m) => m.version).filter((v) => v >= fromVersion).sort((a, b) => a - b);

const LATEST = Math.max(...MIGRATIONS.map((migration) => migration.version));

function applyThrough(db: DB, targetVersion: number): void {
  db.exec('CREATE TABLE IF NOT EXISTS schema_migration (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)');
  for (const migration of MIGRATIONS.filter((item) => item.version <= targetVersion)) {
    const record = () => db.prepare('INSERT INTO schema_migration(version,name,applied_at) VALUES(?,?,?)')
      .run(migration.version, migration.name, new Date().toISOString());
    if (migration.raw) {
      try { db.exec(migration.sql); } finally { db.pragma('foreign_keys = ON'); }
      const violations = db.pragma('foreign_key_check') as unknown[];
      if (violations.length) throw new Error(`V${migration.version} foreign_key_check 失败`);
      record();
    } else {
      db.transaction(() => { db.exec(migration.sql); record(); })();
    }
  }
}

/** 阶段二/六迁移之前的最后一个版本:V28 之前既没有 provenance 列也没有小结列。 */
const PRE_AI_PLAN_VERSION = 28;

function seedLegacyRows(db: DB): void {
  db.prepare("INSERT INTO org (id, parent_id, code, name, sort_order, status, created_at, updated_at) VALUES (1, NULL, 'G', '集团', 0, 'active', '2026-01-01', '2026-01-01')").run();
  db.prepare("INSERT INTO org (id, parent_id, code, name, sort_order, status, created_at, updated_at) VALUES (2, 1, 'P01', '一厂', 0, 'active', '2026-01-01', '2026-01-01')").run();
  db.prepare("INSERT INTO tree_snapshot (id, tree_type, content_json, content_hash, created_at) VALUES (1, 'org', '{\"nodes\":[]}', 'h1', '2026-01-01'), (2, 'account', '{\"nodes\":[]}', 'h2', '2026-01-01')").run();
  db.prepare("INSERT INTO finance_source_profile (id, code, name, adapter_type, config_json, status, created_at, updated_at) VALUES (1, 'P', 'p', 'fixed_finance_system_v1', '{}', 'active', '2026-01-01', '2026-01-01')").run();
  db.prepare("INSERT INTO finance_mapping_version (id, source_profile_id, version_no, name, status, org_tree_snapshot_id, account_tree_snapshot_id, created_by, created_at) VALUES (1, 1, 1, 'v', 'draft', 1, 2, '', '2026-01-01')").run();
  db.prepare("INSERT INTO finance_org_mapping (mapping_version_id, source_book_code, source_org_code, source_org_name, source_aux_json, target_org_id, priority, note) VALUES (1, '', 'S001', '', '{}', 2, 0, '')").run();
  db.prepare("INSERT INTO budget_version (id, year, name, status, is_current, org_tree_snapshot_id, account_tree_snapshot_id, note, created_at, updated_at) VALUES (1, 2026, 'v', 'draft', 0, 1, 2, '', '2026-01-01', '2026-01-01')").run();
  db.prepare(`INSERT INTO budget_compilation_checkpoint
    (version_id, sequence_no, title, snapshot_json, changes_json, change_count, auto_created, created_at)
    VALUES (1, 1, '旧记录', '[]', '[{"orgId":2,"accountId":1,"before":{"amountCents":0,"quantity":null,"formula":"","note":""},"after":{"amountCents":100,"quantity":null,"formula":"","note":""}}]', 1, 0, '2026-01-02')`).run();
}

describe('AI 计划迁移(V29–V33)的备份与回滚验证', () => {
  it('升级前自动备份可校验、停留在旧 schema、数据完整;用它恢复不丢数据并如实报告补迁移', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-plan-rollback-'));
    const dbPath = path.join(dir, 'newfc.sqlite');
    let db = openDatabase(dbPath);
    try {
      applyThrough(db, PRE_AI_PLAN_VERSION);
      seedLegacyRows(db);

      // 1) 升级前备份(与迁移器的 pre-migrate-auto 同一 API)
      const backup = await createBackup(db, backupDirOf(dbPath), 'pre-ai-plan');
      const backupFile = path.join(backupDirOf(dbPath), backup.file);
      expect(verifyBackupFile(backupFile)).toMatchObject({ ok: true });

      // 2) 升级:本计划涉及的迁移一次性补齐
      const applied = applyMigrations(db).map((migration) => migration.version);
      expect(applied).toEqual(versionsFrom(29));
      const upgradedColumns = (db.pragma('table_info(budget_compilation_checkpoint)') as { name: string }[]).map((column) => column.name);
      expect(upgradedColumns).toContain('summary');
      expect((db.pragma('table_info(assistant_narrative_task)') as { name: string }[]).map((column) => column.name)).toContain('attempts');

      // 3) 备份文件保持旧 schema(回滚依据):没有本计划新增的任何列与表
      const backupDb = openReadonlyDatabase(backupFile);
      try {
        expect((backupDb.prepare('SELECT MAX(version) AS v FROM schema_migration').get() as { v: number }).v).toBe(PRE_AI_PLAN_VERSION);
        const legacyCheckpointColumns = (backupDb.pragma('table_info(budget_compilation_checkpoint)') as { name: string }[]).map((column) => column.name);
        expect(legacyCheckpointColumns).not.toContain('summary');
        expect(legacyCheckpointColumns).not.toContain('summary_guard_ok');
        const legacyMappingColumns = (backupDb.pragma('table_info(finance_org_mapping)') as { name: string }[]).map((column) => column.name);
        expect(legacyMappingColumns).not.toContain('origin');
        expect(legacyMappingColumns).not.toContain('reviewed');
        expect(backupDb.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='assistant_narrative_task'").get()).toBeUndefined();
        // 旧枚举:target_kind 还不接受 finance
        expect(() => backupDb.prepare("SELECT 1 FROM import_name_alias LIMIT 1").get()).not.toThrow();
        // 业务数据完整
        expect((backupDb.prepare('SELECT title FROM budget_compilation_checkpoint').get() as { title: string }).title).toBe('旧记录');
        expect((backupDb.prepare('SELECT source_org_code FROM finance_org_mapping').get() as { source_org_code: string }).source_org_code).toBe('S001');
      } finally {
        backupDb.close();
      }

      // 4) 回滚:用升级前备份恢复。既有语义是「恢复后自动补迁移」,
      //    因此可验证的事实是 originalVersion 回到旧版、appliedMigrations 如实列出补的迁移、数据不丢。
      const holder = {
        current: db,
        getDb() { return this.current; },
        reopenWith(next: DB) { this.current = next; },
      };
      const restored = await restoreBackup(holder, dbPath, backupFile, true);
      expect(restored.ok).toBe(true);
      expect(restored.originalVersion).toBe(PRE_AI_PLAN_VERSION);
      expect(restored.appliedMigrations.map((item) => item.version)).toEqual(versionsFrom(29));
      expect(restored.finalVersion).toBe(LATEST);
      db = holder.getDb();
      // 恢复后数据仍在,且 provenance 默认值符合迁移语义
      expect((db.prepare('SELECT title FROM budget_compilation_checkpoint').get() as { title: string }).title).toBe('旧记录');
      expect(db.prepare('SELECT origin, reviewed FROM finance_org_mapping').get()).toEqual({ origin: 'manual', reviewed: 1 });
      // 恢复流程自身留下了 pre-restore 备份(再次回滚的依据)
      const files = fs.readdirSync(backupDirOf(dbPath));
      expect(files.some((file) => file.includes('pre-restore'))).toBe(true);
      expect(files.filter((file) => file.endsWith('.tmp'))).toEqual([]);
    } finally {
      try { db.close(); } catch { /* 已在恢复流程中替换/关闭 */ }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('损坏的备份文件被拒绝,不会替换现有库', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ai-plan-bad-backup-'));
    const dbPath = path.join(dir, 'newfc.sqlite');
    const db = openDatabase(dbPath);
    try {
      applyMigrations(db);
      const bad = path.join(dir, 'broken.sqlite');
      fs.writeFileSync(bad, Buffer.from('not a sqlite file'));
      expect(verifyBackupFile(bad).ok).toBe(false);
      const holder = { current: db, getDb() { return this.current; }, reopenWith(next: DB) { this.current = next; } };
      await expect(restoreBackup(holder, dbPath, bad, true)).rejects.toThrow(/备份文件校验失败/);
      // 原库仍可用且仍在最新版本
      expect((holder.getDb().prepare('SELECT MAX(version) AS v FROM schema_migration').get() as { v: number }).v).toBe(LATEST);
    } finally {
      try { db.close(); } catch { /* ignore */ }
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('V30 在 CREATE 暂存表后、写版本记录前被中断,重放可续做且数据不丢', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v30-resume-'));
    const dbPath = path.join(dir, 'newfc.sqlite');
    const db = openDatabase(dbPath);
    try {
      // 模拟中断现场:V28 完整库 + V30 只执行到 CREATE 暂存表(重放必然撞 already exists)
      applyThrough(db, PRE_AI_PLAN_VERSION);
      seedLegacyRows(db);
      db.exec("INSERT INTO import_name_alias(target_kind, mapping_kind, source_text, target_code, created_at, updated_at) VALUES ('budget','org','上海旧称','SH',datetime('now'),datetime('now'))");
      const v30 = MIGRATIONS.find((migration) => migration.version === 30)!;
      db.exec(v30.sql.split('INSERT INTO import_name_alias_v30')[0].trim());

      // 重放:修复前在 CREATE TABLE import_name_alias_v30 处抛 "already exists",服务永久无法启动
      const applied = applyMigrations(db).map((migration) => migration.version);
      expect(applied).toEqual(versionsFrom(29));
      // 旧表数据经重建后完整保留,且新枚举生效
      const alias = db.prepare("SELECT target_kind, target_code FROM import_name_alias WHERE source_text='上海旧称'").get() as { target_kind: string; target_code: string };
      expect(alias).toEqual({ target_kind: 'budget', target_code: 'SH' });
      expect(() => db.prepare("INSERT INTO import_name_alias(target_kind,mapping_kind,source_text,target_code,created_at,updated_at) VALUES ('finance','org','x','SH',datetime('now'),datetime('now'))").run()).not.toThrow();
      expect((db.prepare('SELECT MAX(version) AS v FROM schema_migration').get() as { v: number }).v).toBe(LATEST);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('V30 在 DROP 旧表后中断(仅剩暂存表),续做直接完成改名并保留数据', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v30-resume-drop-'));
    const dbPath = path.join(dir, 'newfc.sqlite');
    const db = openDatabase(dbPath);
    try {
      applyThrough(db, PRE_AI_PLAN_VERSION);
      seedLegacyRows(db);
      db.exec("INSERT INTO import_name_alias(target_kind, mapping_kind, source_text, target_code, created_at, updated_at) VALUES ('budget','org','上海旧称','SH',datetime('now'),datetime('now'))");
      const v30 = MIGRATIONS.find((migration) => migration.version === 30)!;
      // 执行到 DROP TABLE import_name_alias 后中断:暂存表已持有全部数据,旧表已消失
      db.exec(v30.sql.split('ALTER TABLE import_name_alias_v30 RENAME')[0].trim());

      const applied = applyMigrations(db).map((migration) => migration.version);
      expect(applied).toEqual(versionsFrom(29));
      const alias = db.prepare("SELECT target_kind, target_code FROM import_name_alias WHERE source_text='上海旧称'").get() as { target_kind: string; target_code: string };
      expect(alias).toEqual({ target_kind: 'budget', target_code: 'SH' });
      expect((db.prepare('SELECT MAX(version) AS v FROM schema_migration').get() as { v: number }).v).toBe(LATEST);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('阶段六:记录点写入延迟基准', () => {
  /** 高频小编辑场景:每轮改一格 → 记录一次记录点。 */
  function runRounds(db: DB, versionId: number, orgId: number, accountId: number, rounds: number, withSummary: boolean): number {
    const started = process.hrtime.bigint();
    for (let index = 0; index < rounds; index++) {
      budget.saveEntries(db, versionId, [{ orgId, accountId, amount: `${100 + index}.00` }]);
      const result = budget.recordCompilationCheckpoint(db, versionId, { title: `第 ${index + 1} 轮` });
      // 阶段六的写入路径:小结只在事务外异步调度,记录点写入本身不等待模型
      if (withSummary && result.created && result.checkpoint) scheduleCheckpointSummary(db, result.checkpoint.id);
    }
    return Number(process.hrtime.bigint() - started) / 1e6;
  }

  it('挂上小结调度后,记录点写入延迟没有量级回归(模型全关时同样完整)', () => {
    // 模型环境变量在测试里本就为空(AGENTS.md §6),小结只会产出确定性模板稿
    const rounds = 25;
    const baseline = (() => {
      const db = testDb();
      const fx = buildFixture(db);
      const version = budget.createVersion(db, { year: 2026, name: '基准(无小结)' });
      const elapsed = runRounds(db, version.id, fx.orgIds.shanghai, fx.accIds.incomeMain, rounds, false);
      expect(budget.listCompilationCheckpoints(db, version.id).items).toHaveLength(rounds);
      db.close();
      return elapsed;
    })();
    const withSummary = (() => {
      const db = testDb();
      const fx = buildFixture(db);
      const version = budget.createVersion(db, { year: 2026, name: '阶段六(含小结调度)' });
      const elapsed = runRounds(db, version.id, fx.orgIds.shanghai, fx.accIds.incomeMain, rounds, true);
      const items = budget.listCompilationCheckpoints(db, version.id).items;
      expect(items).toHaveLength(rounds);
      // 每个记录点都登记了任务,且记录点写入路径没有同步等待生成结果
      const tasks = db.prepare('SELECT COUNT(*) AS c FROM assistant_narrative_task').get() as { c: number };
      expect(tasks.c).toBe(rounds);
      db.close();
      return elapsed;
    })();

    const perRoundBaseline = baseline / rounds;
    const perRoundWithSummary = withSummary / rounds;
    console.log(`[baseline] 记录点写入延迟:无小结 ${perRoundBaseline.toFixed(2)} ms/次,含小结调度 ${perRoundWithSummary.toFixed(2)} ms/次`
      + `(${rounds} 轮,倍数 ${(perRoundWithSummary / Math.max(perRoundBaseline, 0.001)).toFixed(2)}x)`);
    // 调度只是一次 SELECT + 一次 INSERT + setImmediate;放宽到 3 倍 + 20ms 常数以容忍 CI 抖动,
    // 但足以在「小结生成被误挪进同步路径」时报警(那会是几百毫秒到秒级的量级差)。
    expect(perRoundWithSummary).toBeLessThan(perRoundBaseline * 3 + 20);
  });
});
