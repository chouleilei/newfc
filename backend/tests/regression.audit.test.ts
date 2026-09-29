import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import path from 'path';
import fs from 'fs';
import { testDb, tempFileDb, buildFixture, standardBudgetVersion, account, org, budget, actual } from './helpers';
import { runConsistencyChecks } from '../src/modules/check/consistency';
import { yearTrend, completionReport } from '../src/modules/report/report.service';
import { exportSnapshot } from '../src/modules/io/export.service';
import { createBackup, resolveBackupFile, verifyBackupFile, backupDirOf } from '../src/modules/backup/backup.service';
import { SessionStore } from '../src/modules/auth/session';

/** 针对代码审查发现缺陷的回归测试 */

describe('回归:历史补录与当前批次互不影响', () => {
  it('同日期历史补录不会把当前批次标记为 superseded', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const cur = actual.saveActual(db, {
      year: 2026, snapshotDate: '2026-06-30', source: 'manual', mode: 'replace',
      entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '10.00' }],
    });
    const his = actual.saveActual(db, {
      year: 2026, snapshotDate: '2026-06-30', source: 'manual', mode: 'replace', history: true,
      entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '8.00' }],
    });
    const curBatch = db.prepare('SELECT status, updates_current FROM actual_snapshot_batch WHERE id = ?').get(cur.batchId) as { status: string; updates_current: number };
    const hisBatch = db.prepare('SELECT status, updates_current FROM actual_snapshot_batch WHERE id = ?').get(his.batchId) as { status: string; updates_current: number };
    expect(curBatch).toEqual({ status: 'active', updates_current: 1 });
    expect(hisBatch).toEqual({ status: 'active', updates_current: 0 });
    const state = actual.getYearState(db, 2026)!;
    expect(state.current_batch_id).toBe(cur.batchId);
    expect(runConsistencyChecks(db).ok).toBe(true);
  });

  it('同日期再次历史补录只替代历史批次', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const cur = actual.saveActual(db, {
      year: 2026, snapshotDate: '2026-06-30', source: 'manual', mode: 'replace',
      entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '10.00' }],
    });
    const h1 = actual.saveActual(db, {
      year: 2026, snapshotDate: '2026-06-30', source: 'manual', mode: 'replace', history: true,
      entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '8.00' }],
    });
    const h2 = actual.saveActual(db, {
      year: 2026, snapshotDate: '2026-06-30', source: 'manual', mode: 'replace', history: true,
      entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '9.00' }],
    });
    const status = (id: number) => (db.prepare('SELECT status FROM actual_snapshot_batch WHERE id = ?').get(id) as { status: string }).status;
    expect(status(cur.batchId)).toBe('active');
    expect(status(h1.batchId)).toBe('superseded');
    expect(status(h2.batchId)).toBe('active');
    expect(runConsistencyChecks(db).ok).toBe(true);
  });
});

describe('回归:保存失败不留空年度状态', () => {
  it('金额解析失败时 actual_year_state 一并回滚', () => {
    const db = testDb();
    const fx = buildFixture(db);
    expect(() =>
      actual.saveActual(db, {
        year: 2026, snapshotDate: '2026-06-30', source: 'manual', mode: 'replace',
        entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: 'bad' }],
      })
    ).toThrow();
    expect((db.prepare('SELECT COUNT(*) AS c FROM actual_year_state').get() as { c: number }).c).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS c FROM actual_current').get() as { c: number }).c).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS c FROM actual_snapshot_batch').get() as { c: number }).c).toBe(0);
  });
});

describe('回归:实际数重复组合前置校验', () => {
  it('普通模式重复组合返回校验错误而非静默覆盖', () => {
    const db = testDb();
    const fx = buildFixture(db);
    expect(() =>
      actual.saveActual(db, {
        year: 2026, snapshotDate: '2026-06-30', source: 'manual', mode: 'replace',
        entries: [
          { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '1.00' },
          { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '2.00' },
        ],
      })
    ).toThrow(/重复/);
  });

  it('历史模式重复组合返回校验错误而非 SQLite 约束 500', () => {
    const db = testDb();
    const fx = buildFixture(db);
    expect(() =>
      actual.saveActual(db, {
        year: 2026, snapshotDate: '2026-06-30', source: 'manual', mode: 'replace', history: true,
        entries: [
          { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '1.00' },
          { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '2.00' },
        ],
      })
    ).toThrow(/重复/);
    expect((db.prepare('SELECT COUNT(*) AS c FROM actual_snapshot_batch').get() as { c: number }).c).toBe(0);
  });
});

describe('回归:预算零金额但含公式/附注的条目保留', () => {
  it('amount=0 且带公式/附注时保存并可回读', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const v = budget.createVersion(db, { year: 2026, name: 'V1' });
    const r = budget.saveEntries(db, v.id, [
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '0.00', formula: '=1-1', note: '零值测算依据' },
    ]);
    expect(r.saved).toBe(1);
    const row = db.prepare('SELECT formula, note FROM budget_entry WHERE version_id = ?').get(v.id) as { formula: string; note: string };
    expect(row.formula).toBe('=1-1');
    expect(row.note).toBe('零值测算依据');
  });

  it('零金额零数量且无公式/附注仍不保存', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const v = budget.createVersion(db, { year: 2026, name: 'V1' });
    const r = budget.saveEntries(db, v.id, [
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '0.00' },
    ]);
    expect(r.saved).toBe(0);
  });
});

describe('回归:有业务明细的叶子组织不得直接变为父节点', () => {
  it('预算已引用旧叶子时新增子组织被阻断', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const v = standardBudgetVersion(fx);
    budget.lockVersion(db, v.id);
    budget.setCurrentVersion(db, v.id);
    expect(() => org.createOrg(db, { parentId: fx.orgIds.shanghai, code: 'SHX', name: '上海子公司' }))
      .toThrow(/已有预算或当前实际明细/);
  });
});

describe('回归:数量型快照导出保留数量与单位', () => {
  it('导出包含累计数量与单位列,金额列留空', async () => {
    const db = testDb();
    const fx = buildFixture(db);
    account.createAccount(db, { parentId: null, code: 'QROOT', name: '电量', type: 'quantity', unit: '万度' });
    const b = actual.saveActual(db, {
      year: 2026, snapshotDate: '2026-06-30', source: 'manual', mode: 'replace',
      entries: [{ orgId: fx.orgIds.shanghai, accountId: (db.prepare("SELECT id FROM account WHERE code='QROOT'").get() as { id: number }).id, quantity: '88.8' }],
    });
    const buf = await exportSnapshot(db, b.batchId);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ExcelJS.Buffer);
    const ws = wb.getWorksheet('实际快照')!;
    const rows: unknown[][] = [];
    ws.eachRow((r) => rows.push((r.values as unknown[]).slice(1)));
    const data = rows.find((r) => r.includes('QROOT'))!;
    expect(data[3]).toBe('quantity');
    expect(data[4]).toBe(''); // 金额留空
    expect(String(data[5])).toBe('88.8');
    expect(data[6]).toBe('万度');
  });
});

describe('回归:备份月度归档与恢复路径', () => {
  it('同月第二个备份不再归档为月度', async () => {
    const { db, dir, dbPath } = tempFileDb();
    const backupDir = backupDirOf(dbPath);
    const first = await createBackup(db, backupDir);
    const second = await createBackup(db, backupDir);
    expect(first.monthly).toBe(true);
    expect(second.monthly).toBe(false);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('日备清理后,仅存于 monthly/ 的备份可校验', async () => {
    const { db, dir, dbPath } = tempFileDb();
    const backupDir = backupDirOf(dbPath);
    const first = await createBackup(db, backupDir);
    expect(first.monthly).toBe(true);
    // 模拟日备目录已清理该文件,仅 monthly/ 保留
    fs.unlinkSync(path.join(backupDir, first.file));
    expect(() => resolveBackupFile(backupDir, first.file, 'daily')).not.toThrow();
    const monthlyPath = resolveBackupFile(backupDir, first.file, 'monthly');
    expect(fs.existsSync(monthlyPath)).toBe(true);
    expect(verifyBackupFile(monthlyPath).ok).toBe(true);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('resolveBackupFile 拒绝路径穿越', () => {
    expect(() => resolveBackupFile('/tmp/x', '../etc/passwd')).toThrow();
    expect(() => resolveBackupFile('/tmp/x', 'a/b.sqlite')).toThrow();
  });
});

describe('回归:登录锁定后的重复请求不再计入失败次数', () => {
  it('锁定期间返回 lockedOnly,调用方可跳过写库', () => {
    const store = new SessionStore({ username: 'u', password: 'p' });
    let lockedSeconds: number | undefined;
    for (let i = 0; i < 8; i++) {
      const r = store.login('1.2.3.4', 'bad', 'bad');
      expect(r.lockedOnly).toBeUndefined();
      lockedSeconds = r.lockedSeconds ?? lockedSeconds;
    }
    expect(lockedSeconds).toBeGreaterThan(0);
    const again = store.login('1.2.3.4', 'bad', 'bad');
    expect(again.ok).toBe(false);
    expect(again.lockedOnly).toBe(true);
    expect(again.lockedSeconds).toBeGreaterThan(0);
  });

  it('按账号锁定:伪造 IP 轮换无法绕过失败上限', () => {
    const store = new SessionStore({ username: 'u', password: 'p' });
    // 8 次失败全部来自正确用户名、不同 IP(模拟直连伪造 X-Forwarded-For)
    for (let i = 0; i < 8; i++) {
      const r = store.login(`10.0.0.${i}`, 'u', 'wrong');
      expect(r.ok).toBe(false);
    }
    // 换一个全新 IP 也应命中账号锁,而不是重新拿到 8 次配额
    const rotated = store.login('99.9.9.9', 'u', 'wrong');
    expect(rotated.ok).toBe(false);
    expect(rotated.lockedOnly).toBe(true);
    expect(rotated.lockedSeconds).toBeGreaterThan(0);
    // 锁定期内不验证凭据:正确密码同样被账号锁拦住
    expect(store.login('99.9.9.9', 'u', 'p').ok).toBe(false);
    // 乱填用户名不触发账号锁(不存在的账号无从锁定,IP 维度仍照常计数)
    expect(store.login('10.1.1.1', 'nobody', 'x').lockedOnly).toBeUndefined();
  });
});
