import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import type { DB } from '../src/db/connection';
import { openDatabase, openReadonlyDatabase } from '../src/db/connection';
import { applyMigrations } from '../src/db/migrations';
import { writeLog } from '../src/modules/audit/log';
import { runWithContext, systemContext } from '../src/core/request-context';
import { INHERITED_MAX_VERSION, importNewbdSnapshot } from '../src/modules/backup/newbd-import';

/**
 * T-6 newbd 快照迁入:用 newfc 继承迁移前缀(V1..V38)生成“newbd 形”夹具库(预算版本、实际快照、审计),
 * 迁入后核对报告全部一致;重跑结果相同;目标已有新增写入时拒绝;schema 不兼容与运行目录来源被拒。
 */

const dirs: string[] = [];
const tmp = (p: string) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), p)); dirs.push(d); return d; };
afterAll(() => { for (const d of dirs) fs.rmSync(d, { recursive: true, force: true }); });

const NOW = '2026-06-01T00:00:00.000Z';

function seedNewbd(db: DB): void {
  const org = db.prepare('INSERT INTO org (parent_id, code, name, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
  const root = Number(org.run(null, 'ROOT', '集团', NOW, NOW).lastInsertRowid);
  const a = Number(org.run(root, 'A', '水务 A', NOW, NOW).lastInsertRowid);
  const b = Number(org.run(root, 'B', '水务 B', NOW, NOW).lastInsertRowid);
  const acc = db.prepare('INSERT INTO account (code, name, type, created_at, updated_at) VALUES (?, ?, ?, ?, ?)');
  const inc = Number(acc.run('6001', '主营业务收入', 'income', NOW, NOW).lastInsertRowid);
  const cost = Number(acc.run('6401', '主营业务成本', 'cost', NOW, NOW).lastInsertRowid);
  const snap = db.prepare('INSERT INTO tree_snapshot (tree_type, content_json, content_hash, created_at) VALUES (?, ?, ?, ?)');
  const orgSnap = Number(snap.run('org', '[]', 'h-org', NOW).lastInsertRowid);
  const accSnap = Number(snap.run('account', '[]', 'h-acc', NOW).lastInsertRowid);
  const ver = db.prepare('INSERT INTO budget_version (year, name, status, is_current, org_tree_snapshot_id, account_tree_snapshot_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)');
  const entry = db.prepare('INSERT INTO budget_entry (version_id, org_id, account_id, amount_cents, updated_at) VALUES (?, ?, ?, ?, ?)');
  const v1 = Number(ver.run(2025, '2025 定稿', 'locked', 0, orgSnap, accSnap, NOW, NOW).lastInsertRowid);
  const v2 = Number(ver.run(2026, '2026 草稿', 'draft', 1, orgSnap, accSnap, NOW, NOW).lastInsertRowid);
  // 含超过 2^53 的金额,验证 bigint 合计
  entry.run(v1, a, inc, 9_007_199_254_740_993n, NOW);
  entry.run(v1, b, cost, 12_345_67, NOW);
  entry.run(v2, a, inc, 50_000_00, NOW);
  entry.run(v2, b, inc, -1_23, NOW);
  const batch = db.prepare('INSERT INTO actual_snapshot_batch (year, snapshot_date, status, source, org_tree_snapshot_id, account_tree_snapshot_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)');
  const b1 = Number(batch.run(2025, '2025-06-30', 'superseded', 'excel_import', orgSnap, accSnap, NOW).lastInsertRowid);
  const b2 = Number(batch.run(2025, '2025-12-31', 'active', 'excel_import', orgSnap, accSnap, NOW).lastInsertRowid);
  const se = db.prepare('INSERT INTO actual_snapshot_entry (batch_id, org_id, account_id, cumulative_amount_cents) VALUES (?, ?, ?, ?)');
  se.run(b1, a, inc, 100_00); se.run(b2, a, inc, 250_00); se.run(b2, b, cost, 75_50);
  db.prepare('INSERT INTO actual_current (year, org_id, account_id, cumulative_amount_cents, source, updated_at) VALUES (?, ?, ?, ?, ?, ?)').run(2025, a, inc, 250_00, 'excel_import', NOW);
  db.prepare("INSERT INTO operation_log (action, entity_type, entity_id, detail_json, created_at) VALUES ('budget.lock', 'budget_version', ?, '{}', ?)").run(String(v1), NOW);
}

function snapshot(version = INHERITED_MAX_VERSION): string {
  const file = path.join(tmp('newbd-snap-'), 'budget.sqlite');
  const db = openDatabase(file);
  applyMigrations(db, version);
  seedNewbd(db);
  db.pragma('wal_checkpoint(TRUNCATE)');
  db.close();
  return file;
}

describe('T-6 newbd 快照迁入', () => {
  it('迁入核对一致、ID 不变、不建账号;重跑相同;目标有新增写入时拒绝', async () => {
    const source = snapshot();
    const target = path.join(tmp('newfc-import-'), 'data');
    const r1 = await importNewbdSnapshot({ source, target });
    expect(r1.ok, JSON.stringify(r1, null, 2)).toBe(true);
    expect(r1.source).toMatchObject({ version: INHERITED_MAX_VERSION, migrations: INHERITED_MAX_VERSION });
    expect(r1.target.appliedMigrations[0]).toBe(INHERITED_MAX_VERSION + 1);
    expect(r1).toMatchObject({ foreignKeyViolations: 0, accounts: 0, amountDifferences: [], attachments: { count: 0 } });
    expect(r1.budgetTotals.find((g) => g.key.includes('status=locked') && g.target === '9007199254740993')).toBeTruthy();
    expect(r1.budgetTotals).toHaveLength(4);
    expect(r1.actualSnapshotTotals).toEqual([
      { key: 'year=2025 status=active', source: '32550', target: '32550', ok: true },
      { key: 'year=2025 status=superseded', source: '10000', target: '10000', ok: true },
    ]);
    expect(r1.tables.find((t) => t.table === 'budget_entry')).toEqual({ table: 'budget_entry', source: 4, target: 4, idsIdentical: true, ok: true });
    expect(r1.notMigrated.map((n) => n.item)).toContain('访问口令与登录会话');
    const idMap = fs.readFileSync(path.join(target, 'id-map.csv'), 'utf8');
    expect(idMap).toContain('budget_version,2,2');
    expect(JSON.parse(fs.readFileSync(path.join(target, 'newbd-import-report.json'), 'utf8')).ok).toBe(true);
    // 迁入库可按 newfc 打开:最新 schema、无账号、源审计保留并追加迁入记录
    const ro = openReadonlyDatabase(path.join(target, 'newfc.sqlite'));
    expect((ro.prepare('SELECT action FROM operation_log ORDER BY id').pluck().all() as string[]).slice(-2)).toEqual(['budget.lock', 'governance.newbd_import']);
    ro.close();
    // 来源未被修改
    const src = openReadonlyDatabase(source);
    expect((src.prepare('SELECT MAX(version) FROM schema_migration').pluck().get())).toBe(INHERITED_MAX_VERSION);
    src.close();

    // 重跑:须 --replace;结果相同,旧目标保留
    await expect(importNewbdSnapshot({ source, target })).rejects.toThrow('--replace');
    const r2 = await importNewbdSnapshot({ source, target, replace: true });
    expect(r2.ok).toBe(true);
    expect({ t: r2.tables, b: r2.budgetTotals, s: r2.actualSnapshotTotals, c: r2.actualCurrentTotals })
      .toEqual({ t: r1.tables, b: r1.budgetTotals, s: r1.actualSnapshotTotals, c: r1.actualCurrentTotals });
    expect(fs.existsSync(path.join(r2.target.replaced!, 'newfc.sqlite'))).toBe(true);

    // 目标有迁入之后的业务写入:拒绝覆盖
    const live = openDatabase(path.join(target, 'newfc.sqlite'));
    runWithContext(systemContext('cli'), () => writeLog(live, 'master.project.create', 'project', 1, {}));
    live.close();
    await expect(importNewbdSnapshot({ source, target, replace: true })).rejects.toThrow(/新增写入[\s\S]*master\.project\.create × 1/);
  });

  it('较早的继承前缀可迁入;不兼容 schema、运行目录来源与非迁入目标被拒', async () => {
    const older = await importNewbdSnapshot({ source: snapshot(30), target: path.join(tmp('newfc-import-'), 'd') });
    expect(older.ok).toBe(true);
    expect(older.source.version).toBe(30);

    // newfc 自有迁移(V39+)不是 newbd 前缀
    const newer = path.join(tmp('newbd-snap-'), 'x.sqlite');
    const n = openDatabase(newer); applyMigrations(n, INHERITED_MAX_VERSION + 1); n.close();
    await expect(importNewbdSnapshot({ source: newer, target: path.join(tmp('newfc-import-'), 'd') })).rejects.toThrow(/不是 newfc 继承迁移序列的前缀[\s\S]*V39/);
    // 名称不一致
    const renamed = snapshot(10);
    const w = openDatabase(renamed); w.prepare("UPDATE schema_migration SET name = 'forked' WHERE version = 5").run(); w.close();
    await expect(importNewbdSnapshot({ source: renamed, target: path.join(tmp('newfc-import-'), 'd') })).rejects.toThrow('V5 名称为 forked');
    // 运行目录来源:按路径拒绝,不访问该路径
    await expect(importNewbdSnapshot({ source: '/data/newbd/budget.sqlite', target: path.join(tmp('newfc-import-'), 'd') })).rejects.toThrow('离线快照');
    // 非空且非迁入目标
    const other = tmp('newfc-import-');
    fs.writeFileSync(path.join(other, 'keep.txt'), 'x');
    await expect(importNewbdSnapshot({ source: snapshot(), target: other, replace: true })).rejects.toThrow('不是迁入目标');
  });
});
