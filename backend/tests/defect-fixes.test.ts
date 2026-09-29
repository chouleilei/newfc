import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import { testDb, tempFileDb, buildFixture, standardBudgetVersion, actual, budget, account } from './helpers';
import { createBackup, restoreBackup } from '../src/modules/backup/backup.service';
import { createBatch, commitBatch } from '../src/modules/import/import.service';
import { createOrReuseSnapshot, loadSnapshotNodes } from '../src/modules/tree/snapshot';
import { rollup } from '../src/core/rollup';
import { runConsistencyChecks } from '../src/modules/check/consistency';
import { freezeYear, yearTrend } from '../src/modules/report/report.service';
import { createSourceProfile, updateSourceProfile } from '../src/modules/finance-import/source-profile.service';
import { createMappingVersion, replaceOrgMappings } from '../src/modules/finance-import/mapping/mapping.service';

describe('D01 实际整包保存保护', () => {
  it('批次基线过期和未确认的全清空都会被拒绝', () => {
    const db = testDb(); const fx = buildFixture(db);
    const first = actual.saveActual(db, { year: 2026, snapshotDate: '2026-03-31', source: 'manual', mode: 'replace', entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '10' }] });
    const second = actual.saveActual(db, { year: 2026, snapshotDate: '2026-06-30', source: 'manual', mode: 'upsert', entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '20' }] });
    expect(() => actual.saveActual(db, { year: 2026, snapshotDate: '2026-12-31', source: 'manual', mode: 'replace', expectedCurrentBatchId: first.batchId, entries: [] })).toThrow(/已被其他操作更新/);
    expect(() => actual.saveActual(db, { year: 2026, snapshotDate: '2026-12-31', source: 'manual', mode: 'replace', expectedCurrentBatchId: second.batchId, entries: [] })).toThrow(/显式二次确认/);
    expect(actual.getActualMatrix(db, 2026).entries).toHaveLength(1);
  });
});

describe('D04/D05 备份恢复安全', () => {
  it('标签路径穿越被拒绝', async () => {
    const { db, dir } = tempFileDb();
    await expect(createBackup(db, path.join(dir, 'backups'), '../escaped')).rejects.toThrow(/备份标签/);
    db.close(); fs.rmSync(dir, { recursive: true, force: true });
  });

  it('30 份日备下恢复最旧目标成功', async () => {
    const { db, dir, dbPath } = tempFileDb(); const fx = buildFixture(db);
    const backupDir = path.join(dir, 'backups'); fs.mkdirSync(backupDir);
    const oldest = path.join(backupDir, 'budget-backup-2000-01-01-000000.sqlite');
    await db.backup(oldest);
    for (let i = 1; i < 30; i++) fs.copyFileSync(oldest, path.join(backupDir, `budget-backup-2000-01-${String(i + 1).padStart(2, '0')}-000000.sqlite`));
    const added = account.createAccount(db, { parentId: null, code: 'AFTER', name: '恢复后应消失', type: 'expense' });
    let held = db;
    await restoreBackup({ getDb: () => held, reopenWith: (next) => { held = next; } }, dbPath, oldest, true);
    expect(held.prepare('SELECT 1 FROM account WHERE id=?').get(added.id)).toBeUndefined();
    expect(held.prepare('SELECT name FROM org WHERE id=?').get(fx.orgIds.root)).toBeTruthy();
    held.close(); fs.rmSync(dir, { recursive: true, force: true });
  });

  it('句柄替换异常后自动回滚并重开旧库', async () => {
    const { db, dir, dbPath } = tempFileDb(); buildFixture(db);
    const backupDir = path.join(dir, 'backups'); const target = path.join(backupDir, 'target.sqlite');
    fs.mkdirSync(backupDir); await db.backup(target);
    let held = db; let calls = 0;
    await expect(restoreBackup({ getDb: () => held, reopenWith: (next) => { calls++; if (calls === 1) throw new Error('注入句柄替换失败'); held = next; } }, dbPath, target, true)).rejects.toThrow(/注入句柄替换失败/);
    expect(held.prepare('SELECT COUNT(*) AS c FROM org').get()).toBeTruthy();
    held.close(); fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('D06 普通导入预览基线', () => {
  it('实际命中单元格在预览后修改时确认冲突', () => {
    const db = testDb(); const fx = buildFixture(db);
    actual.saveActual(db, { year: 2026, snapshotDate: '2026-03-31', source: 'manual', mode: 'upsert', entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '10' }] });
    const batch = createBatch(db, { kind: 'actual', originalName: 'x.xlsx', file: Buffer.from('x'), payload: { history: false, note: '', batches: [{ year: 2026, snapshotDate: '2026-12-31', entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '20' }] }] }, summary: {} });
    actual.saveActual(db, { year: 2026, snapshotDate: '2026-06-30', source: 'manual', mode: 'upsert', entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '30' }] });
    expect(() => commitBatch(db, batch.id)).toThrow(/预览后命中单元格已被修改/);
  });

  it('预算命中单元格在预览后修改时确认冲突', () => {
    const db = testDb(); const fx = buildFixture(db); const v = standardBudgetVersion(fx);
    const batch = createBatch(db, { kind: 'budget', targetVersionId: v.id, originalName: 'x.xlsx', file: Buffer.from('x'), payload: { versionId: v.id, entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '200' }] }, summary: {} });
    budget.saveEntries(db, v.id, [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '300' }]);
    // 预算基线已升级为全量版本快照:任何并发改动都使基线失配(而非仅命中格),文案随之放宽为「版本已有其他改动」。
    expect(() => commitBatch(db, batch.id)).toThrow(/预览后版本已有其他改动/);
  });
});

describe('D07-D10 数据完整性', () => {
  it('quantity_agg=sum 快照往返后仍为 sum，趋势可计算', () => {
    const db = testDb(); const fx = buildFixture(db);
    const q = account.createAccount(db, { parentId: null, code: 'QSUM', name: '累计量', type: 'quantity', unit: '个' });
    const snap = createOrReuseSnapshot(db, 'account');
    expect(loadSnapshotNodes(db, snap).find((row) => row.id === q.id)?.quantity_agg).toBe('sum');
    const v = budget.createVersion(db, { year: 2026, name: '数量趋势' });
    budget.saveEntries(db, v.id, [{ orgId: fx.orgIds.shanghai, accountId: q.id, quantity: '10' }]); budget.lockVersion(db, v.id);
    expect(() => yearTrend(db, { year: 2026, versionId: v.id, trendKind: 'account', trendId: q.id })).not.toThrow();
  });

  it('金额或数量汇总越过安全整数时显式失败', () => {
    const orgRows = [{ id: 1, parent_id: null, code: 'O', name: 'O', sort_order: 0, status: 'active' as const }];
    const accRows = [{ id: 1, parent_id: null, code: 'A', name: 'A', sort_order: 0, status: 'active' as const, quantity_agg: 'sum' as const }];
    expect(() => rollup(orgRows, accRows, [{ orgId: 1, accountId: 1, amountCents: 4_503_599_627_370_495 }, { orgId: 1, accountId: 1, amountCents: 4_503_599_627_370_495 }, { orgId: 1, accountId: 1, amountCents: 4_503_599_627_370_495 }])).toThrow(/安全整数范围/);
  });

  it('一致性检查发现数量差异和快照侧多余行', () => {
    const db = testDb(); const fx = buildFixture(db); const q = account.createAccount(db, { parentId: null, code: 'Q', name: '量', type: 'quantity', unit: '个' });
    const saved = actual.saveActual(db, { year: 2026, snapshotDate: '2026-06-30', source: 'manual', mode: 'upsert', entries: [{ orgId: fx.orgIds.shanghai, accountId: q.id, quantity: '1' }] });
    db.prepare('UPDATE actual_current SET quantity=20000 WHERE year=2026').run();
    expect(runConsistencyChecks(db).checks[0].problems.join(';')).toMatch(/数量与快照不一致/);
    db.prepare('DELETE FROM actual_current WHERE year=2026').run();
    expect(runConsistencyChecks(db).checks[0].problems.join(';')).toMatch(/在当前实际中不存在/);
    expect(saved.batchId).toBeGreaterThan(0);
  });

  it('空批次不能无确认关闭，非当前批次也需专项确认', () => {
    const db = testDb(); buildFixture(db);
    const empty = actual.saveActual(db, { year: 2026, snapshotDate: '2026-06-30', source: 'manual', mode: 'replace', entries: [] });
    const history = actual.saveActual(db, { year: 2026, snapshotDate: '2026-03-31', source: 'manual', mode: 'replace', history: true, entries: [] });
    expect(() => freezeYear(db, 2026, empty.batchId)).toThrow(/零申报/);
    expect(() => freezeYear(db, 2026, history.batchId, { empty: true })).toThrow(/不是该年度当前实际快照/);
    expect(() => freezeYear(db, 2026, empty.batchId, { empty: true })).not.toThrow();
  });
});

describe('D13 财务转换关键生命周期审计', () => {
  it('数据源配置与映射变更记录操作者和动作', () => {
    const db = testDb(); buildFixture(db);
    const profile = createSourceProfile(db, {
      code: 'AUDIT',
      name: '审计源',
      config: {
        amountUnit: 'yuan',
        ownedOrgCodes: ['SH'],
        ownedAccountCodes: ['I01'],
      },
    }, 'alice');
    updateSourceProfile(db, profile.id, { name: '审计源2' }, 'bob');
    const mapping = createMappingVersion(db, { sourceProfileId: profile.id, name: 'V1', createdBy: 'carol' });
    replaceOrgMappings(db, mapping.id, [], 'dave');
    const rows = db.prepare("SELECT action,detail_json FROM operation_log WHERE action LIKE 'finance.%' ORDER BY id").all() as { action: string; detail_json: string }[];
    expect(rows.map((row) => row.action)).toEqual(expect.arrayContaining(['finance.profile.create', 'finance.profile.update', 'finance.mapping.create', 'finance.mapping.replace_org']));
    expect(rows.some((row) => JSON.parse(row.detail_json).actor === 'dave')).toBe(true);
  });
});
