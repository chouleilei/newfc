/**
 * AI 功能增强计划 §四.阶段六验收:
 * 确定性部分:
 * - diffCheckpointCells 的 kind 判别:金额/数量/公式/附注/混合;
 * - 旧数据兼容:V31 之前写入的 changes_json 无 kind,读取时按 before/after 补判别;
 * - 迁移 V31:小结列与 provenance 列升级默认值、存量行保留、
 *   升级前备份可只读打开且保持旧 schema(回滚依据);
 * AI 部分(异步管道 + 薄改写):
 * - 迁移 V32:assistant_narrative_task 任务表(状态机 + provenance 列);
 * - 确定性模板聚合 changes_json(金额按利润方向还原符号,数量 ×10⁴ 还原);
 * - 模型关闭时任务完成、持久化模板稿;模型改写过守卫持久化模型稿;
 *   守卫失败回退模板并记录 guard_ok=0;生成失败只标记任务 failed,不影响记录点;
 * - 轮询端点返回任务状态与小结;同一记录点重复调度去重。
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { testDb, buildFixture, type Fixture } from './helpers';
import { MIGRATIONS, applyMigrations } from '../src/db/migrations';
import { openDatabase, openReadonlyDatabase, type DB } from '../src/db/connection';
import { createBackup, backupDirOf } from '../src/modules/backup/backup.service';
import * as budget from '../src/modules/budget/budget.service';
import * as account from '../src/modules/account/account.service';
import {
  checkpointSummaryTemplate, checkpointSummaryStatus, runCheckpointSummaryTask, scheduleCheckpointSummary,
  recoverNarrativeTasks, requeueCheckpointSummary, MAX_TASK_ATTEMPTS,
} from '../src/assistant/checkpoint-summary';
import { resetNarrativeCache } from '../src/assistant/narrative';
import { resetAssistantRateLimit, tryConsumeNarrativeBudget } from '../src/assistant/rate-limit';
import { PROMPT_VERSION } from '../src/assistant/prompts';

function applyThrough(db: DB, targetVersion: number): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migration (version INTEGER PRIMARY KEY, name TEXT NOT NULL, applied_at TEXT NOT NULL)`);
  for (const migration of MIGRATIONS.filter((item) => item.version <= targetVersion)) {
    const record = () => db.prepare('INSERT INTO schema_migration(version,name,applied_at) VALUES(?,?,?)').run(migration.version, migration.name, new Date().toISOString());
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

function setup(): { db: DB; fx: Fixture; versionId: number; quantityAccountId: number } {
  const db = testDb();
  const fx = buildFixture(db);
  const qRoot = account.createAccount(db, { parentId: null, code: 'Q', name: '业务量', type: 'quantity', unit: '万度' });
  const qLeaf = account.createAccount(db, { parentId: qRoot.id, code: 'Q01', name: '发电量', type: 'quantity', unit: '万度' });
  const v = budget.createVersion(db, { year: 2026, name: 'kind 测试' });
  return { db, fx, versionId: v.id, quantityAccountId: qLeaf.id };
}

describe('阶段六:变化类型 kind 后端判别', () => {
  it('金额/数量/公式/附注单维变化各归各类,多维同时变化为 mixed', () => {
    const { db, fx, versionId, quantityAccountId } = setup();
    budget.saveEntries(db, versionId, [
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '100.00', formula: '=80+20', note: '初稿' },
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.costSub, amount: '60.00', note: '原始' },
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.expenseAdmin, amount: '20.00' },
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.expenseSales, amount: '10.00', note: 'a' },
      { orgId: fx.orgIds.shanghai, accountId: quantityAccountId, quantity: '1.0000' },
    ]);
    expect(budget.recordCompilationCheckpoint(db, versionId, { title: '基线' }).created).toBe(true);

    budget.saveEntries(db, versionId, [
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '120.00', formula: '=80+20', note: '初稿' },
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.costSub, amount: '60.00', note: '改动后' },
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.expenseAdmin, amount: '20.00', formula: '=5*4' },
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.expenseSales, amount: '11.00', note: 'b' },
      { orgId: fx.orgIds.shanghai, accountId: quantityAccountId, quantity: '2.5000' },
    ]);
    const second = budget.recordCompilationCheckpoint(db, versionId, { title: '第二轮' });
    expect(second.created).toBe(true);
    const byAccount = new Map(second.checkpoint!.changes.map((change) => [change.accountId, change.kind]));
    expect(byAccount.get(fx.accIds.incomeMain)).toBe('amount');
    expect(byAccount.get(quantityAccountId)).toBe('quantity');
    expect(byAccount.get(fx.accIds.expenseAdmin)).toBe('formula');
    expect(byAccount.get(fx.accIds.costSub)).toBe('note');
    expect(byAccount.get(fx.accIds.expenseSales)).toBe('mixed');
  });

  it('旧格式 changes_json(无 kind 字段)读取时按 before/after 补判别', () => {
    const { db, fx, versionId } = setup();
    budget.saveEntries(db, versionId, [
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '100.00', note: '初稿' },
    ]);
    const first = budget.recordCompilationCheckpoint(db, versionId, { title: '基线' });
    expect(first.created).toBe(true);
    // 模拟 V31 之前写入的行:changes_json 中去掉 kind
    const row = db.prepare('SELECT id, changes_json FROM budget_compilation_checkpoint WHERE id = ?').get(first.checkpoint!.id) as { id: number; changes_json: string };
    const legacyChanges = (JSON.parse(row.changes_json) as Record<string, unknown>[]).map(({ kind: _kind, ...rest }) => rest);
    db.prepare('UPDATE budget_compilation_checkpoint SET changes_json = ? WHERE id = ?').run(JSON.stringify(legacyChanges), row.id);

    const items = budget.listCompilationCheckpoints(db, versionId).items;
    expect(items).toHaveLength(1);
    // 新增单元格:金额 + 附注同时从空值变化 → mixed;公式/附注未动的纯金额新增 → amount
    expect(items[0].changes[0].kind).toBe('mixed');
    expect(items[0].summary).toBe('');
    expect(items[0].summarySource).toBe('');
    expect(items[0].summaryGuardOk).toBeNull();
  });
});

describe('阶段六:迁移 V31 小结与 provenance 列', () => {
  it('V30 库升级后存量记录行保留,小结列默认未生成;升级前备份保持旧 schema(回滚依据)', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'checkpoint-v31-'));
    const dbPath = path.join(dir, 'newfc.sqlite');
    const db = openDatabase(dbPath);
    try {
      applyThrough(db, 30);
      // 旧库写入一条 V31 之前格式的记录点(8 列)
      db.prepare("INSERT INTO org (id, parent_id, code, name, sort_order, status, created_at, updated_at) VALUES (1, NULL, 'G', '集团', 0, 'active', '2026-01-01', '2026-01-01')").run();
      db.prepare("INSERT INTO tree_snapshot (id, tree_type, content_json, content_hash, created_at) VALUES (1, 'org', '{\"nodes\":[]}', 'h1', '2026-01-01'), (2, 'account', '{\"nodes\":[]}', 'h2', '2026-01-01')").run();
      db.prepare("INSERT INTO budget_version (id, year, name, status, is_current, org_tree_snapshot_id, account_tree_snapshot_id, note, created_at, updated_at) VALUES (1, 2026, 'v', 'draft', 0, 1, 2, '', '2026-01-01', '2026-01-01')").run();
      db.prepare(`INSERT INTO budget_compilation_checkpoint
        (version_id, sequence_no, title, snapshot_json, changes_json, change_count, auto_created, created_at)
        VALUES (1, 1, '旧记录', '[]', '[{"orgId":1,"accountId":1,"before":{"amountCents":0,"quantity":null,"formula":"","note":""},"after":{"amountCents":100,"quantity":null,"formula":"","note":""}}]', 1, 0, '2026-01-02')`).run();

      // 升级前备份(模拟迁移器行为),之后升级
      const backup = await createBackup(db, backupDirOf(dbPath), 'pre-v31-test');
      const applied = applyMigrations(db).map((migration) => migration.version);
      expect(applied).toEqual([31, 32, 33, 34, 35, 36, 37, 38]);

      const columns = (db.pragma('table_info(budget_compilation_checkpoint)') as { name: string }[]).map((column) => column.name);
      for (const name of ['summary', 'summary_source', 'summary_model', 'summary_prompt_version', 'summary_generated_at', 'summary_guard_ok']) {
        expect(columns).toContain(name);
      }
      const row = db.prepare('SELECT title, summary, summary_source, summary_guard_ok FROM budget_compilation_checkpoint').get() as { title: string; summary: string; summary_source: string; summary_guard_ok: number | null };
      expect(row).toEqual({ title: '旧记录', summary: '', summary_source: '', summary_guard_ok: null });
      // 非法 source 被 CHECK 拒绝
      expect(() => db.prepare("UPDATE budget_compilation_checkpoint SET summary_source = 'other'").run()).toThrow();

      // 备份验证:升级前的备份只读打开,保持 V30 schema 且数据完整(回滚依据)
      const backupDb = openReadonlyDatabase(path.join(backupDirOf(dbPath), backup.file));
      try {
        const backupColumns = (backupDb.pragma('table_info(budget_compilation_checkpoint)') as { name: string }[]).map((column) => column.name);
        expect(backupColumns).not.toContain('summary');
        expect((backupDb.prepare('SELECT title FROM budget_compilation_checkpoint').get() as { title: string }).title).toBe('旧记录');
        expect((backupDb.prepare('SELECT MAX(version) AS v FROM schema_migration').get() as { v: number }).v).toBe(30);
      } finally {
        backupDb.close();
      }
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('阶段六:迁移 V32 异步叙述任务表', () => {
  it('V31 库升级到 V32,任务表与状态机/CHECK 约束就位', () => {
    const db = testDb();
    buildFixture(db);
    // testDb 已应用到最新版本;直接验证结构
    const columns = (db.pragma('table_info(assistant_narrative_task)') as { name: string }[]).map((column) => column.name);
    for (const name of ['kind', 'ref_id', 'status', 'payload_json', 'source', 'model', 'prompt_version', 'guard_ok', 'error', 'created_at', 'updated_at']) {
      expect(columns).toContain(name);
    }
    const now = new Date().toISOString();
    db.prepare("INSERT INTO assistant_narrative_task (kind, ref_id, status, created_at, updated_at) VALUES ('checkpoint_summary', 1, 'pending', ?, ?)").run(now, now);
    expect(() => db.prepare("INSERT INTO assistant_narrative_task (kind, ref_id, status, created_at, updated_at) VALUES ('other', 1, 'pending', ?, ?)").run(now, now)).toThrow();
    expect(() => db.prepare("INSERT INTO assistant_narrative_task (kind, ref_id, status, created_at, updated_at) VALUES ('checkpoint_summary', 1, 'bogus', ?, ?)").run(now, now)).toThrow();
    db.close();
  });

  it('V31 存量库升级追加 V32 与 V33', () => {
    const mem = new Database(':memory:') as unknown as DB;
    applyThrough(mem, 31);
    const applied = applyMigrations(mem).map((migration) => migration.version);
    expect(applied).toEqual([32, 33, 34, 35, 36, 37, 38]);
    mem.close();
  });
});

describe('阶段六:迁移 V33 任务抢占与恢复列', () => {
  it('attempts/started_at 默认值就位,活动任务唯一索引拒绝同一记录点的第二个 pending', () => {
    const db = testDb();
    const columns = (db.pragma('table_info(assistant_narrative_task)') as { name: string }[]).map((column) => column.name);
    expect(columns).toContain('attempts');
    expect(columns).toContain('started_at');
    const now = new Date().toISOString();
    const insert = (status: string, refId: number) => db.prepare(
      'INSERT INTO assistant_narrative_task (kind, ref_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
    ).run('checkpoint_summary', refId, status, now, now);
    insert('pending', 7);
    expect((db.prepare('SELECT attempts, started_at FROM assistant_narrative_task').get() as { attempts: number; started_at: string })).toEqual({ attempts: 0, started_at: '' });
    // 同一记录点第二个活动任务被唯一索引拒绝
    expect(() => insert('pending', 7)).toThrow();
    expect(() => insert('running', 7)).toThrow();
    // done/failed 不占用活动槽位
    db.prepare("UPDATE assistant_narrative_task SET status = 'done' WHERE ref_id = 7").run();
    expect(() => insert('pending', 7)).not.toThrow();
    db.close();
  });

  it('V32 存量库中同一记录点的多条活动任务在升级时收敛为最新一条', () => {
    const mem = new Database(':memory:') as unknown as DB;
    applyThrough(mem, 32);
    const now = new Date().toISOString();
    for (const status of ['pending', 'running', 'pending']) {
      mem.prepare('INSERT INTO assistant_narrative_task (kind, ref_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
        .run('checkpoint_summary', 5, status, now, now);
    }
    mem.prepare('INSERT INTO assistant_narrative_task (kind, ref_id, status, created_at, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run('checkpoint_summary', 6, 'done', now, now);
    expect(applyMigrations(mem).map((migration) => migration.version)).toEqual([33, 34, 35, 36, 37, 38]);
    const rows = mem.prepare("SELECT ref_id, status FROM assistant_narrative_task ORDER BY id").all() as { ref_id: number; status: string }[];
    // ref 5 只留最新那条活动任务,done 行不受影响
    expect(rows.filter((row) => row.ref_id === 5)).toHaveLength(1);
    expect(rows.filter((row) => row.ref_id === 6)).toHaveLength(1);
    mem.close();
  });
});

describe('阶段六:小结模板与异步生成', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env.AI_BASE_URL = '';
    process.env.AI_API_KEY = '';
    process.env.NEWFC_CHECKPOINT_AI = '';
    resetNarrativeCache();
  });

  function checkpointWithChanges(): { db: DB; fx: Fixture; versionId: number; checkpointId: number } {
    const db = testDb();
    const fx = buildFixture(db);
    const qRoot = account.createAccount(db, { parentId: null, code: 'Q', name: '业务量', type: 'quantity', unit: '万度' });
    const qLeaf = account.createAccount(db, { parentId: qRoot.id, code: 'Q01', name: '发电量', type: 'quantity', unit: '万度' });
    const v = budget.createVersion(db, { year: 2026, name: '小结测试' });
    budget.saveEntries(db, v.id, [
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '100.00', note: '初稿' },
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.costSub, amount: '60.00' },
      { orgId: fx.orgIds.hangzhou, accountId: qLeaf.id, quantity: '1.0000' },
    ]);
    const first = budget.recordCompilationCheckpoint(db, v.id, { title: '基线' });
    budget.saveEntries(db, v.id, [
      // 收入 +20 元(利润方向调增),成本 +10 元(利润方向调减),附注修改,数量变化
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '120.00', note: '修订' },
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.costSub, amount: '70.00' },
      { orgId: fx.orgIds.hangzhou, accountId: qLeaf.id, quantity: '2.5000' },
    ]);
    const second = budget.recordCompilationCheckpoint(db, v.id, { title: '第二轮' });
    expect(second.created).toBe(true);
    void first;
    return { db, fx, versionId: v.id, checkpointId: second.checkpoint!.id };
  }

  it('确定性模板:kind 构成、金额方向按利润方向还原、数量 ×10⁴ 还原', () => {
    const { db, versionId, checkpointId } = checkpointWithChanges();
    const checkpoint = budget.getCompilationCheckpoint(db, checkpointId);
    const template = checkpointSummaryTemplate(db, checkpoint);
    expect(template).toContain('共 3 处变化');
    expect(template).toContain('附注 0 处');
    // income 100→120:amount+note 混合;cost 60→70:amount;quantity 1→2.5:quantity
    expect(template).toContain('金额 1 处');
    expect(template).toContain('数量 1 处');
    expect(template).toContain('多维混合 1 处');
    // 利润方向:收入 +20 元 = 调增,成本 +10 元 = 调减,净增加 10 元 = 0.00 万元(10 元/1e6)
    expect(template).toContain('调增 1 格');
    expect(template).toContain('调减 1 格');
    expect(template).toContain('净增加 0.00 万元');
    expect(template).toContain('附注:新增 0 处,修改 1 处,清空 0 处');
    expect(template).toContain('1 → 2.5');
    expect(template).toContain('第二轮');
    db.close();
  });

  it('模型关闭时任务完成并持久化模板稿,轮询状态为 done', async () => {
    const { db, checkpointId } = checkpointWithChanges();
    scheduleCheckpointSummary(db, checkpointId);
    scheduleCheckpointSummary(db, checkpointId); // 重复调度去重
    const tasks = db.prepare('SELECT id, status FROM assistant_narrative_task').all() as { id: number; status: string }[];
    expect(tasks).toHaveLength(1);
    await runCheckpointSummaryTask(db, tasks[0].id);

    const status = checkpointSummaryStatus(db, checkpointId);
    expect(status.status).toBe('done');
    expect(status.source).toBe('template');
    expect(status.guardOk).toBeNull();
    expect(status.summary).toContain('本轮修改小结');
    expect(status.promptVersion).toBe(PROMPT_VERSION.checkpointSummary);
    expect(status.generatedAt).not.toBe('');
    // 记录点行同样持久化 provenance
    const row = db.prepare('SELECT summary_source, summary_prompt_version FROM budget_compilation_checkpoint WHERE id = ?').get(checkpointId) as { summary_source: string; summary_prompt_version: string };
    expect(row.summary_source).toBe('template');
    expect(row.summary_prompt_version).toBe('checkpoint-summary.v1');
    db.close();
  });

  it('模型改写过守卫持久化模型稿;改动数字回退模板并记录 guard_ok=0', async () => {
    const { db, checkpointId } = checkpointWithChanges();
    const template = checkpointSummaryTemplate(db, budget.getCompilationCheckpoint(db, checkpointId));
    process.env.AI_BASE_URL = 'http://model.test/v1';
    process.env.AI_API_KEY = 'test';
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: template.replace('# 本轮修改小结', '# 本轮修改小结(模型整理)') } }] }),
    })));
    scheduleCheckpointSummary(db, checkpointId);
    const taskId = (db.prepare('SELECT id FROM assistant_narrative_task').get() as { id: number }).id;
    await runCheckpointSummaryTask(db, taskId);
    let status = checkpointSummaryStatus(db, checkpointId);
    expect(status.status).toBe('done');
    expect(status.source).toBe('model');
    expect(status.guardOk).toBe(true);
    expect(status.summary).toContain('模型整理');

    // 守卫失败:模型新增数字 → 回退模板,guard_ok=0
    resetNarrativeCache();
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      json: async () => ({ choices: [{ message: { content: `${template}\n另有 99 处未记录变化` } }] }),
    })));
    const { checkpointId: secondId, db: db2 } = checkpointWithChanges();
    scheduleCheckpointSummary(db2, secondId);
    const task2 = (db2.prepare('SELECT id FROM assistant_narrative_task').get() as { id: number }).id;
    await runCheckpointSummaryTask(db2, task2);
    status = checkpointSummaryStatus(db2, secondId);
    expect(status.status).toBe('done');
    expect(status.source).toBe('template');
    expect(status.guardOk).toBe(false);
    expect(status.summary).not.toContain('99 处未记录');
    db.close();
    db2.close();
  });

  it('NEWFC_CHECKPOINT_AI=0 时即使配置了模型也只产出模板稿', async () => {
    const { db, checkpointId } = checkpointWithChanges();
    process.env.AI_BASE_URL = 'http://model.test/v1';
    process.env.AI_API_KEY = 'test';
    process.env.NEWFC_CHECKPOINT_AI = '0';
    const fetchSpy = vi.fn(async () => { throw new Error('不应调用模型'); });
    vi.stubGlobal('fetch', fetchSpy);
    scheduleCheckpointSummary(db, checkpointId);
    const taskId = (db.prepare('SELECT id FROM assistant_narrative_task').get() as { id: number }).id;
    await runCheckpointSummaryTask(db, taskId);
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(checkpointSummaryStatus(db, checkpointId).source).toBe('template');
    db.close();
  });

  it('生成失败先自动重试,重试用尽后停在 failed;记录点本身不受影响', async () => {
    const db = testDb();
    buildFixture(db);
    process.env.AI_NARRATIVE_TASK_RETRY_MS = '1';
    const now = new Date().toISOString();
    // ref_id 指向不存在的记录点
    const info = db.prepare("INSERT INTO assistant_narrative_task (kind, ref_id, status, created_at, updated_at) VALUES ('checkpoint_summary', 99999, 'pending', ?, ?)").run(now, now);
    const taskId = Number(info.lastInsertRowid);
    await runCheckpointSummaryTask(db, taskId);
    // 第一次失败:回到 pending 等自动重试,错误原文保留
    let task = db.prepare('SELECT status, error, attempts FROM assistant_narrative_task WHERE id = ?').get(taskId) as { status: string; error: string; attempts: number };
    expect(task).toMatchObject({ status: 'pending', attempts: 1 });
    expect(task.error).toContain('记录点');
    expect(task.error).toContain('自动重试');
    // 重试到上限后停在 failed,并给出人工恢复提示
    await runCheckpointSummaryTask(db, taskId);
    await runCheckpointSummaryTask(db, taskId);
    task = db.prepare('SELECT status, error, attempts FROM assistant_narrative_task WHERE id = ?').get(taskId) as { status: string; error: string; attempts: number };
    expect(task).toMatchObject({ status: 'failed', attempts: MAX_TASK_ATTEMPTS });
    expect(task.error).toContain('重新生成小结');
    // 用尽后再调用不会继续自增 attempts
    await runCheckpointSummaryTask(db, taskId);
    expect((db.prepare('SELECT attempts FROM assistant_narrative_task WHERE id = ?').get(taskId) as { attempts: number }).attempts).toBe(MAX_TASK_ATTEMPTS);
    db.close();
  });
});

describe('阶段六:异步任务抢占、恢复与配额', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    process.env.AI_BASE_URL = '';
    process.env.AI_API_KEY = '';
    process.env.NEWFC_CHECKPOINT_AI = '';
    process.env.AI_NARRATIVE_TASK_STALE_MS = '';
    process.env.AI_NARRATIVE_TASK_RETRY_MS = '';
    process.env.AI_NARRATIVE_RATE_LIMIT_PER_MIN = '';
    resetNarrativeCache();
    resetAssistantRateLimit();
  });

  function twoChangeCheckpoint(): { db: DB; versionId: number; checkpointId: number } {
    const db = testDb();
    const fx = buildFixture(db);
    const v = budget.createVersion(db, { year: 2026, name: '抢占测试' });
    budget.saveEntries(db, v.id, [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '100.00' }]);
    budget.recordCompilationCheckpoint(db, v.id, { title: '基线' });
    budget.saveEntries(db, v.id, [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '120.00' }]);
    const second = budget.recordCompilationCheckpoint(db, v.id, { title: '第二轮' });
    return { db, versionId: v.id, checkpointId: second.checkpoint!.id };
  }

  it('并发运行同一任务只有一个抢到,模型只被调用一次', async () => {
    const { db, checkpointId } = twoChangeCheckpoint();
    process.env.AI_BASE_URL = 'http://model.test/v1';
    process.env.AI_API_KEY = 'test';
    const template = checkpointSummaryTemplate(db, budget.getCompilationCheckpoint(db, checkpointId));
    let calls = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      calls += 1;
      await new Promise((resolve) => setTimeout(resolve, 20));
      return { ok: true, json: async () => ({ choices: [{ message: { content: template } }] }) };
    }));
    const now = new Date().toISOString();
    const taskId = Number(db.prepare("INSERT INTO assistant_narrative_task (kind, ref_id, status, created_at, updated_at) VALUES ('checkpoint_summary', ?, 'pending', ?, ?)").run(checkpointId, now, now).lastInsertRowid);
    await Promise.all([
      runCheckpointSummaryTask(db, taskId),
      runCheckpointSummaryTask(db, taskId),
      runCheckpointSummaryTask(db, taskId),
    ]);
    expect(calls).toBe(1);
    const row = db.prepare('SELECT status, attempts FROM assistant_narrative_task WHERE id = ?').get(taskId) as { status: string; attempts: number };
    expect(row).toEqual({ status: 'done', attempts: 1 });
    db.close();
  });

  it('已完成任务不会被重新抢占', async () => {
    const { db, checkpointId } = twoChangeCheckpoint();
    const now = new Date().toISOString();
    const taskId = Number(db.prepare("INSERT INTO assistant_narrative_task (kind, ref_id, status, created_at, updated_at) VALUES ('checkpoint_summary', ?, 'pending', ?, ?)").run(checkpointId, now, now).lastInsertRowid);
    await runCheckpointSummaryTask(db, taskId);
    await runCheckpointSummaryTask(db, taskId);
    expect((db.prepare('SELECT attempts FROM assistant_narrative_task WHERE id = ?').get(taskId) as { attempts: number }).attempts).toBe(1);
    db.close();
  });

  it('崩溃遗留的 stale running 可被再次抢占;新鲜 running 不被打扰', async () => {
    const { db, checkpointId } = twoChangeCheckpoint();
    const now = new Date().toISOString();
    const taskId = Number(db.prepare("INSERT INTO assistant_narrative_task (kind, ref_id, status, started_at, created_at, updated_at) VALUES ('checkpoint_summary', ?, 'running', ?, ?, ?)").run(checkpointId, now, now, now).lastInsertRowid);
    // 新鲜 running:不抢占,状态与尝试次数都不动
    await runCheckpointSummaryTask(db, taskId);
    expect(db.prepare('SELECT status, attempts FROM assistant_narrative_task WHERE id = ?').get(taskId)).toMatchObject({ status: 'running', attempts: 0 });
    // stale 窗口压到 10ms 后同一行可回收
    process.env.AI_NARRATIVE_TASK_STALE_MS = '10';
    await new Promise((resolve) => setTimeout(resolve, 30));
    await runCheckpointSummaryTask(db, taskId);
    expect(db.prepare('SELECT status, attempts FROM assistant_narrative_task WHERE id = ?').get(taskId)).toMatchObject({ status: 'done', attempts: 1 });
    db.close();
  });

  it('启动恢复:pending 重排、stale running 归还、用尽次数的 running 判 failed', async () => {
    const { db, checkpointId } = twoChangeCheckpoint();
    const old = new Date(Date.now() - 3_600_000).toISOString();
    const pendingId = Number(db.prepare("INSERT INTO assistant_narrative_task (kind, ref_id, status, created_at, updated_at) VALUES ('checkpoint_summary', ?, 'pending', ?, ?)").run(checkpointId, old, old).lastInsertRowid);
    // 另一个记录点上遗留的 stale running(尝试次数已用尽)
    const exhaustedId = Number(db.prepare("INSERT INTO assistant_narrative_task (kind, ref_id, status, started_at, attempts, created_at, updated_at) VALUES ('checkpoint_summary', 99999, 'running', ?, ?, ?, ?)").run(old, MAX_TASK_ATTEMPTS, old, old).lastInsertRowid);
    const result = recoverNarrativeTasks(db);
    expect(result.abandoned).toBe(1);
    expect(result.requeued).toBeGreaterThanOrEqual(1);
    expect((db.prepare('SELECT status FROM assistant_narrative_task WHERE id = ?').get(exhaustedId) as { status: string }).status).toBe('failed');
    // 重排是 setImmediate 串行执行的,让事件循环跑完
    await new Promise((resolve) => setImmediate(resolve));
    await new Promise((resolve) => setImmediate(resolve));
    expect((db.prepare('SELECT status FROM assistant_narrative_task WHERE id = ?').get(pendingId) as { status: string }).status).toBe('done');
    db.close();
  });

  it('人工重新生成:failed 之后可新建任务并再次完成', async () => {
    const { db, checkpointId } = twoChangeCheckpoint();
    const now = new Date().toISOString();
    db.prepare("INSERT INTO assistant_narrative_task (kind, ref_id, status, attempts, error, created_at, updated_at) VALUES ('checkpoint_summary', ?, 'failed', ?, '旧失败', ?, ?)").run(checkpointId, MAX_TASK_ATTEMPTS, now, now);
    const taskId = requeueCheckpointSummary(db, checkpointId);
    await runCheckpointSummaryTask(db, taskId);
    expect(checkpointSummaryStatus(db, checkpointId).status).toBe('done');
    // 记录点不存在时直接拒绝,不留下永远失败的任务行
    expect(() => requeueCheckpointSummary(db, 99999)).toThrow(/记录点/);
    db.close();
  });

  it('服务级叙述配额用尽时只出模板稿,不调用模型', async () => {
    const { db, checkpointId } = twoChangeCheckpoint();
    process.env.AI_BASE_URL = 'http://model.test/v1';
    process.env.AI_API_KEY = 'test';
    process.env.AI_NARRATIVE_RATE_LIMIT_PER_MIN = '1';
    resetAssistantRateLimit();
    const template = checkpointSummaryTemplate(db, budget.getCompilationCheckpoint(db, checkpointId));
    const fetchSpy = vi.fn(async () => ({ ok: true, json: async () => ({ choices: [{ message: { content: template } }] }) }));
    vi.stubGlobal('fetch', fetchSpy);
    // 第一次消耗掉唯一额度
    expect(tryConsumeNarrativeBudget('narrative:checkpoint_summary')).toBe(true);
    const now = new Date().toISOString();
    const taskId = Number(db.prepare("INSERT INTO assistant_narrative_task (kind, ref_id, status, created_at, updated_at) VALUES ('checkpoint_summary', ?, 'pending', ?, ?)").run(checkpointId, now, now).lastInsertRowid);
    await runCheckpointSummaryTask(db, taskId);
    expect(fetchSpy).not.toHaveBeenCalled();
    const status = checkpointSummaryStatus(db, checkpointId);
    expect(status.status).toBe('done');
    expect(status.source).toBe('template');
    expect(status.error).toContain('配额');
    db.close();
  });

  it('轮询校验记录点归属:用别的版本路径读不到该记录点', () => {
    const { db, versionId, checkpointId } = twoChangeCheckpoint();
    const other = budget.createVersion(db, { year: 2027, name: '另一个版本' });
    expect(checkpointSummaryStatus(db, checkpointId, versionId).versionId).toBe(versionId);
    expect(() => checkpointSummaryStatus(db, checkpointId, other.id)).toThrow(/记录点/);
    db.close();
  });
});
