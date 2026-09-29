import { afterEach, describe, expect, it, vi } from 'vitest';
import ExcelJS from 'exceljs';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import {
  testDb,
  tempFileDb,
  buildFixture,
  standardBudgetVersion,
  org,
  account,
  budget,
  actual,
  metric,
} from './helpers';
import { completionReport, freezeYear, historicalComparison, yearTrend } from '../src/modules/report/report.service';
import { structureReport } from '../src/modules/report/structure.service';
import { metricEvidence } from '../src/modules/evidence/evidence.service';
import { exportBudgetDetail, exportCompletion, exportHistorical } from '../src/modules/io/export.service';
import * as io from '../src/modules/io/excel';
import { csvCell } from '../src/core/csv';
import { isAccountVisibleForScope } from '../src/core/accountScope';
import * as assistant from '../src/assistant/service';
import { EnvChatModel } from '../src/assistant/model';
import * as imports from '../src/modules/import/import.service';
import { createApp } from '../src/server';
import { createSourceProfile, updateSourceProfile } from '../src/modules/finance-import/source-profile.service';
import { previewRule, saveRule } from '../src/modules/calculation/calculation.service';
import { backupDirOf, createBackup, pruneBackups, restoreBackup, verifyBackupFile } from '../src/modules/backup/backup.service';
import { MIGRATIONS } from '../src/db/migrations';
import { openDatabase, type DB } from '../src/db/connection';
import { resetAssistantRateLimit } from '../src/assistant/rate-limit';
import {
  createMappingVersion,
  exportMappings,
  exportMappingsCsv,
  importMappings,
  importMappingsCsv,
  listAccountMappings,
  listOrgMappings,
  lockMappingVersion,
  replaceAccountMappings,
  replaceOrgMappings,
  replaceReconciliationRules,
} from '../src/modules/finance-import/mapping/mapping.service';

/**
 * 《全仓缺陷排查报告-2026-08-29》逐项回归。
 *
 * 本文件只覆盖该报告新增的边界；原有业务主流程仍由 integration / quantity /
 * ratio / structure 等套件覆盖，避免把同一断言复制两遍。
 */

describe('D01 锁定预算后的新增结构实际', () => {
  it('新增组织、新增科目及两者同时新增均进入承接区，所有分析出口逐分勾稽', async () => {
    const db = testDb();
    const fx = buildFixture(db);
    const version = standardBudgetVersion(fx);
    budget.lockVersion(db, version.id);

    const newOrg = org.createOrg(db, { parentId: null, code: 'NEWORG', name: '预算后新增组织' });
    const newAccount = account.createAccount(db, { parentId: null, code: 'NEWI', name: '预算后新增收入', type: 'income' });
    const saved = actual.saveActual(db, {
      year: 2026,
      snapshotDate: '2026-06-30',
      source: 'manual',
      mode: 'replace',
      entries: [
        // 正常预算叶子路径
        { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '5.00' },
        // 三类新增结构
        { orgId: newOrg.id, accountId: fx.accIds.incomeMain, amount: '10.00' },
        { orgId: fx.orgIds.shanghai, accountId: newAccount.id, amount: '20.00' },
        { orgId: newOrg.id, accountId: newAccount.id, amount: '30.00' },
      ],
    });

    const report = completionReport(db, { versionId: version.id });
    expect(report.reconciliation).toEqual({
      sourceActualCents: 6_500,
      displayedActualCents: 6_500,
      differenceCents: 0,
    });
    expect(report.unbudgetedActual.count).toBe(3);
    expect(report.unbudgetedActual.amountCents).toBe(6_000);
    expect(new Set(report.unbudgetedActual.entries.map((entry) => entry.reason))).toEqual(new Set([
      '新增组织未纳入预算叶子',
      '新增科目未纳入预算叶子',
      '新增组织和新增科目均未纳入预算叶子',
    ]));

    const existingAccount = report.byAccount.find((row) => row.accountId === fx.accIds.incomeMain)!;
    const carriedAccount = report.byAccount.find((row) => row.accountId === newAccount.id)!;
    expect(existingAccount.cell.actualCents).toBe(1_500);
    expect(carriedAccount).toMatchObject({ parentId: null, unbudgeted: true });
    expect(carriedAccount.cell.actualCents).toBe(5_000);

    const existingOrgRoot = report.byOrg.find((row) => row.orgId === fx.orgIds.root)!;
    const carriedOrg = report.byOrg.find((row) => row.orgId === newOrg.id)!;
    expect(existingOrgRoot.cell.actualCents).toBe(2_500);
    expect(carriedOrg).toMatchObject({ parentId: null, unbudgeted: true });
    expect(carriedOrg.cell.actualCents).toBe(4_000);

    const accountRootTotal = report.byAccount
      .filter((row) => row.parentId == null && row.type !== 'quantity')
      .reduce((sum, row) => sum + row.cell.actualCents, 0);
    const orgRootTotal = report.byOrg
      .filter((row) => row.parentId == null)
      .reduce((sum, row) => sum + row.cell.actualCents, 0);
    expect(accountRootTotal).toBe(6_500);
    expect(orgRootTotal).toBe(6_500);

    const trend = yearTrend(db, {
      year: 2026,
      versionId: version.id,
      batchId: saved.batchId,
      trendKind: 'composite',
    });
    expect(trend.points).toHaveLength(1);
    expect(trend.points[0]).toMatchObject({
      batchId: saved.batchId,
      actualDisplayCents: 6_500,
      unbudgetedActualCount: 3,
      unbudgetedActualCents: 6_000,
      reconciliation: { sourceActualCents: 6_500, displayedActualCents: 6_500, differenceCents: 0 },
    });
    expect(trend.points[0].rate).toBeCloseTo(6_500 / 27_000, 12);

    const structure = structureReport(db, { versionId: version.id });
    expect(structure.unbudgetedActual.count).toBe(3);
    expect(structure.actualReconciliation.differenceCents).toBe(0);

    const evidence = metricEvidence(db, { versionId: version.id, metricId: fx.metricIds.gross });
    expect(evidence.actualCoverage.unbudgetedActual.count).toBe(3);
    expect(evidence.actualCoverage.reconciliation.differenceCents).toBe(0);

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await exportCompletion(db, version.id) as unknown as ExcelJS.Buffer);
    const unbudgetedSheet = workbook.getWorksheet('未预算实际')!;
    const exportedText: string[] = [];
    unbudgetedSheet.eachRow((row) => exportedText.push((row.values as unknown[]).slice(1).join('|')));
    expect(exportedText.some((line) => line.includes('NEWORG') && line.includes('I01'))).toBe(true);
    expect(exportedText.some((line) => line.includes('NEWI') && line.includes('SH'))).toBe(true);
  });
});

describe('D02 预算整包保存乐观并发', () => {
  it('两个客户端持同一 revision 时只接受首个整包，旧整包不能删除首客户端新增行', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const version = standardBudgetVersion(fx);
    const matrix = budget.getEditMatrix(db, version.id);
    const revision = matrix.version.revision;
    const baseEntries = matrix.entries.map((entry) => ({
      orgId: entry.orgId,
      accountId: entry.accountId,
      amount: entry.quantity == null ? entry.amountDisplay : undefined,
      quantity: entry.quantity ?? undefined,
      formula: entry.formula,
      note: entry.note,
    }));
    const firstClient = [
      ...baseEntries,
      { orgId: fx.orgIds.nanjing, accountId: fx.accIds.incomeMain, amount: '77.00' },
    ];
    const secondClient = baseEntries.map((entry, index) => index === 0 ? { ...entry, amount: '111.00' } : entry);

    const first = budget.saveEntries(db, version.id, firstClient, revision);
    expect(first.revision).toBe(revision + 1);
    let conflict: any;
    try {
      budget.saveEntries(db, version.id, secondClient, revision);
    } catch (error) {
      conflict = error;
    }
    expect(conflict).toMatchObject({ status: 409, code: 'CONFLICT' });
    expect(String(conflict?.message)).toContain('当前修订');
    const added = db.prepare(
      'SELECT amount_cents FROM budget_entry WHERE version_id=? AND org_id=? AND account_id=?',
    ).get(version.id, fx.orgIds.nanjing, fx.accIds.incomeMain) as { amount_cents: number } | undefined;
    expect(added?.amount_cents).toBe(7_700);
    expect((db.prepare('SELECT COUNT(*) AS count FROM budget_entry WHERE version_id=?').get(version.id) as { count: number }).count).toBe(7);
    db.close();
  });
});

function applyMigrationsThrough(db: DB, targetVersion: number): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migration (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  for (const migration of MIGRATIONS.filter((item) => item.version <= targetVersion)) {
    const record = () => db.prepare(
      'INSERT INTO schema_migration(version,name,applied_at) VALUES(?,?,?)',
    ).run(migration.version, migration.name, new Date().toISOString());
    if (migration.raw) {
      try {
        db.exec(migration.sql);
      } finally {
        db.pragma('foreign_keys = ON');
      }
      const violations = db.pragma('foreign_key_check') as unknown[];
      if (violations.length) throw new Error(`V${migration.version} foreign_key_check 失败`);
      record();
    } else {
      db.transaction(() => {
        db.exec(migration.sql);
        record();
      })();
    }
  }
}

describe('D03 恢复旧 schema 后自动迁移', () => {
  it('恢复 V22 备份会在替换 holder 前应用后续迁移，随后新指标、预算与 Structure 均可用', async () => {
    const { db: currentDb, dir, dbPath } = tempFileDb();
    const legacyPath = path.join(dir, 'legacy-v22.sqlite');
    const legacy = openDatabase(legacyPath);
    applyMigrationsThrough(legacy, 22);
    legacy.pragma('wal_checkpoint(TRUNCATE)');
    legacy.close();

    const holder: { current: DB; getDb(): DB; reopenWith(db: DB): void } = {
      current: currentDb,
      getDb() { return this.current; },
      reopenWith(db) { this.current = db; },
    };
    const restored = await restoreBackup(holder, dbPath, legacyPath, true);
    expect(restored.originalVersion).toBe(22);
    expect(restored.appliedMigrations.map((item) => item.version)).toEqual([23, 24, 25, 26, 27, 28, 29, 30, 31, 32, 33, 34, 35, 36, 37, 38]);
    expect(restored.finalVersion).toBe(38);

    const db = holder.getDb();
    const fx = buildFixture(db);
    const postRestoreMetric = metric.createMetric(db, {
      code: 'POST_RESTORE',
      name: '恢复后指标',
      terms: [{ sourceType: 'account', sourceAccountId: fx.accIds.incomeMain, coefficient: 1 }],
    });
    expect(postRestoreMetric.kind).toBe('linear');
    const version = budget.createVersion(db, { year: 2026, name: '恢复后预算' });
    budget.saveEntries(db, version.id, [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '1.00' }], 0);
    expect(budget.getVersion(db, version.id).revision).toBe(1);
    expect(structureReport(db, { versionId: version.id }).rows.some((row) => row.code === 'I01')).toBe(true);

    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('D04 移动节点不得把被引用叶子变成父节点', () => {
  it.each(['budget', 'current', 'snapshot', 'metric'] as const)(
    '科目目标被 %s 引用时移动均被阻断',
    (referenceKind) => {
      const db = testDb();
      const fx = buildFixture(db);
      const root = account.createAccount(db, { parentId: null, code: 'D04I', name: '移动测试收入', type: 'income' });
      const target = account.createAccount(db, { parentId: root.id, code: 'D04I01', name: '被引用目标', type: 'income' });
      const moving = account.createAccount(db, { parentId: root.id, code: 'D04I02', name: '待移动节点', type: 'income' });
      if (referenceKind === 'budget') {
        const version = budget.createVersion(db, { year: 2026, name: '移动预算引用' });
        budget.saveEntries(db, version.id, [{ orgId: fx.orgIds.shanghai, accountId: target.id, amount: '1.00' }]);
      } else if (referenceKind === 'current') {
        db.prepare(`INSERT INTO actual_current
          (year,org_id,account_id,cumulative_amount_cents,quantity,source,memo,updated_at)
          VALUES(?,?,?,?,NULL,'manual','',?)`)
          .run(2026, fx.orgIds.shanghai, target.id, 100, new Date().toISOString());
      } else if (referenceKind === 'snapshot') {
        actual.saveActual(db, {
          year: 2025,
          snapshotDate: '2025-12-31',
          source: 'manual',
          mode: 'replace',
          history: true,
          entries: [{ orgId: fx.orgIds.shanghai, accountId: target.id, amount: '1.00' }],
        });
      } else {
        metric.createMetric(db, {
          code: 'D04_METRIC',
          name: '移动指标引用',
          terms: [{ sourceType: 'account', sourceAccountId: target.id, coefficient: 1 }],
        });
      }
      expect(() => account.moveAccount(db, moving.id, target.id)).toThrow(/不能通过移动节点/);
      expect(account.getAccount(db, moving.id).parent_id).toBe(root.id);
      db.close();
    },
  );

  it('组织目标已有预算明细时移动同样被阻断', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const root = org.createOrg(db, { parentId: null, code: 'D04O', name: '移动测试组织' });
    const target = org.createOrg(db, { parentId: root.id, code: 'D04O01', name: '被引用组织' });
    const moving = org.createOrg(db, { parentId: root.id, code: 'D04O02', name: '待移动组织' });
    const version = budget.createVersion(db, { year: 2026, name: '组织移动预算引用' });
    budget.saveEntries(db, version.id, [{ orgId: target.id, accountId: fx.accIds.incomeMain, amount: '1.00' }]);
    expect(() => org.moveOrg(db, moving.id, target.id)).toThrow(/不能通过移动节点/);
    expect(org.getOrg(db, moving.id).parent_id).toBe(root.id);
    db.close();
  });
});

describe('D05 科目适用范围最长前缀', () => {
  it('最具体前缀、精确规则、未知组织和无限制科目保持各自语义', () => {
    expect(isAccountVisibleForScope('I11031', new Set(['010402']))).toBe(false);
    expect(isAccountVisibleForScope('I11031', new Set(['010102']))).toBe(true);
    expect(isAccountVisibleForScope('I1101', new Set(['010402']))).toBe(true);
    expect(isAccountVisibleForScope('I11031', new Set(['CUSTOM_ORG']))).toBe(true);
    expect(isAccountVisibleForScope('GENERIC_ACCOUNT', new Set(['010402']))).toBe(true);
    expect(isAccountVisibleForScope('constructor', new Set(['010402']))).toBe(true);
    expect(isAccountVisibleForScope('__proto__', new Set(['010402']))).toBe(true);
  });
});

describe('D06 成本型指标展示方向', () => {
  it('P02/P06 的完成情况、趋势、Excel 与 AI 报告统一按业务正数展示并使用同一完成率', async () => {
    const db = testDb();
    const fx = buildFixture(db);
    const p02 = metric.createMetric(db, {
      code: 'P02',
      name: '营业总成本',
      displaySign: -1,
      terms: [
        { sourceType: 'account', sourceAccountId: fx.accIds.costRoot, coefficient: 1 },
        { sourceType: 'account', sourceAccountId: fx.accIds.expenseRoot, coefficient: 1 },
      ],
    });
    const p06 = metric.createMetric(db, {
      code: 'P06',
      name: '总成本',
      displaySign: -1,
      terms: [{ sourceType: 'metric', sourceMetricId: p02.id, coefficient: 1 }],
    });
    const version = standardBudgetVersion(fx);
    budget.lockVersion(db, version.id);
    const saved = actual.saveActual(db, {
      year: 2026,
      snapshotDate: '2026-06-30',
      source: 'manual',
      mode: 'replace',
      entries: [
        { orgId: fx.orgIds.shanghai, accountId: fx.accIds.costSub, amount: '50.00' },
        { orgId: fx.orgIds.shanghai, accountId: fx.accIds.expenseAdmin, amount: '20.00' },
        { orgId: fx.orgIds.hangzhou, accountId: fx.accIds.costSub, amount: '10.00' },
        { orgId: fx.orgIds.hangzhou, accountId: fx.accIds.expenseSales, amount: '20.00' },
      ],
    });

    const completion = completionReport(db, { versionId: version.id, batchId: saved.batchId });
    for (const code of ['P02', 'P06']) {
      const row = completion.metrics.find((item) => item.code === code)!;
      expect(row.displaySign).toBe(-1);
      expect(row.cell).toMatchObject({ budgetCents: -12_000, actualCents: -10_000, rateSpecial: null });
      expect(row.cell.budgetCents * row.displaySign).toBe(12_000);
      expect(row.cell.actualCents * row.displaySign).toBe(10_000);
      expect(row.cell.rate).toBeCloseTo(5 / 6, 12);
    }

    for (const selected of [p02, p06]) {
      const trend = yearTrend(db, {
        year: 2026,
        versionId: version.id,
        batchId: saved.batchId,
        trendKind: 'metric',
        trendId: selected.id,
      });
      expect(trend.budgetDisplayCents).toBe(12_000);
      expect(trend.points[0]).toMatchObject({ actualDisplayCents: 10_000 });
      expect(trend.points[0].rate).toBeCloseTo(5 / 6, 12);
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await exportCompletion(db, version.id, saved.batchId) as unknown as ExcelJS.Buffer);
    const sheet = workbook.getWorksheet('预算完成情况')!;
    const metricRows = new Map<string, ExcelJS.Row>();
    sheet.eachRow((row) => {
      if (String(row.getCell(1).value) === '指标') metricRows.set(String(row.getCell(2).value), row);
    });
    for (const code of ['P02', 'P06']) {
      const row = metricRows.get(code)!;
      expect(row.getCell(8).value).toBe(120);
      expect(row.getCell(9).value).toBe(100);
      expect(row.getCell(13).value).toBeCloseTo(5 / 6, 12);
      expect(row.getCell(13).numFmt).toBe('0.00%');
    }

    const aiReport = await assistant.reportDraft(db, {
      kind: 'monthly_execution',
      versionId: version.id,
      batchId: saved.batchId,
      narrative: false,
    });
    const metricBullets = aiReport.sections.find((section) => section.key === 'metrics')!.bullets;
    for (const code of ['P02', 'P06']) {
      const bullet = metricBullets.find((item) => item.includes(`(${code})`))!;
      expect(bullet).toContain('预算 0.01 万元,实际 0.01 万元');
      expect(bullet).not.toContain('预算 -');
      expect(bullet).toContain('完成率 83.3%');
    }

    // 确定性聊天摘要是独立于报告草稿的另一个展示出口，也必须读取 displaySign。
    const previousBaseUrl = process.env.AI_BASE_URL;
    delete process.env.AI_BASE_URL;
    try {
      const answer = await assistant.chat(db, {
        message: '2026 年执行情况如何',
        context: { year: 2026, budgetVersionId: version.id, actualSnapshotId: saved.batchId },
      });
      expect(answer.text).toContain('营业总成本 预算 0.01 / 实际 0.01 万元');
      expect(answer.text).toContain('总成本 预算 0.01 / 实际 0.01 万元');
      expect(answer.text).not.toMatch(/(?:营业总成本|总成本) 预算 -/);
    } finally {
      if (previousBaseUrl === undefined) delete process.env.AI_BASE_URL;
      else process.env.AI_BASE_URL = previousBaseUrl;
    }
    db.close();
  });
});

describe('D07 同日趋势点与精确批次截止', () => {
  it('同日 current/history 只保留 current；截止到较早 history 时不包含同日后续 current', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const version = standardBudgetVersion(fx);
    const history = actual.saveActual(db, {
      year: 2026,
      snapshotDate: '2026-06-30',
      source: 'manual',
      mode: 'replace',
      history: true,
      entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '8.00' }],
    });
    const current = actual.saveActual(db, {
      year: 2026,
      snapshotDate: '2026-06-30',
      source: 'manual',
      mode: 'replace',
      entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '10.00' }],
    });

    const full = yearTrend(db, { year: 2026, versionId: version.id, trendKind: 'composite' });
    expect(full.points).toHaveLength(1);
    expect(full.points[0]).toMatchObject({ date: '2026-06-30', batchId: current.batchId, actualDisplayCents: 1_000 });

    const cutoff = yearTrend(db, {
      year: 2026,
      versionId: version.id,
      batchId: history.batchId,
      trendKind: 'composite',
    });
    expect(cutoff.points).toHaveLength(1);
    expect(cutoff.points[0]).toMatchObject({ date: '2026-06-30', batchId: history.batchId, actualDisplayCents: 800 });
    expect(cutoff.points.some((point) => point.batchId === current.batchId)).toBe(false);
    db.close();
  });
});

describe('D08 预算版本生成来源枚举', () => {
  it('非法 baseFrom 的预览和创建均失败且不留版本；三个合法来源分别复制正确数据', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const sourceBudget = standardBudgetVersion(fx, 2026, '2026 定稿');
    budget.lockVersion(db, sourceBudget.id);
    budget.setCurrentVersion(db, sourceBudget.id);
    const saved = actual.saveActual(db, {
      year: 2026,
      snapshotDate: '2026-12-31',
      source: 'manual',
      mode: 'replace',
      entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '88.00' }],
    });

    const before = (db.prepare('SELECT COUNT(*) AS count FROM budget_version').get() as { count: number }).count;
    const invalid = {
      year: 2027,
      name: '非法来源',
      baseFrom: 'bogus',
      baseYear: 2026,
      baseSnapshotId: saved.batchId,
    } as any;
    expect(() => budget.previewVersionGenerationDetails(db, invalid)).toThrow(/baseFrom/);
    expect(() => budget.createVersion(db, invalid)).toThrow(/baseFrom/);
    expect((db.prepare('SELECT COUNT(*) AS count FROM budget_version').get() as { count: number }).count).toBe(before);

    const fromBudget = budget.createVersion(db, {
      year: 2027,
      name: '来自预算',
      baseFrom: 'budget',
      baseYear: 2026,
      growthRate: 0,
    });
    const fromCurrent = budget.createVersion(db, {
      year: 2028,
      name: '来自当前实际',
      baseFrom: 'actual',
      baseYear: 2026,
      growthRate: 0,
    });
    const fromSnapshot = budget.createVersion(db, {
      year: 2029,
      name: '来自实际快照',
      baseFrom: 'actual_snapshot',
      baseYear: 2026,
      baseSnapshotId: saved.batchId,
      growthRate: 0,
    });
    expect(budget.getEditMatrix(db, fromBudget.id).entries).toHaveLength(6);
    expect(budget.getEditMatrix(db, fromCurrent.id).entries).toHaveLength(1);
    expect(budget.getEditMatrix(db, fromSnapshot.id).entries).toHaveLength(1);
    expect(JSON.parse(fromBudget.generation_json).baseFrom).toBe('budget');
    expect(JSON.parse(fromCurrent.generation_json).baseFrom).toBe('actual');
    expect(JSON.parse(fromSnapshot.generation_json).baseFrom).toBe('actual_snapshot');
    db.close();
  });
});

describe('D09 备份只读校验', () => {
  it('verifyBackupFile 前后字节 SHA-256 完全不变', async () => {
    const { db, dir, dbPath } = tempFileDb();
    const fx = buildFixture(db);
    standardBudgetVersion(fx);
    const backupDir = backupDirOf(dbPath);
    const created = await createBackup(db, backupDir, 'verify');
    const file = path.join(backupDir, created.file);
    const sha = () => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
    const before = sha();
    expect(verifyBackupFile(file)).toEqual({ ok: true, message: 'ok' });
    expect(sha()).toBe(before);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('D10 备份保留顺序', () => {
  it('只清理无标签自动备份，标签里程碑不参与数量上限', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-prune-'));
    const names = [
      'pre-restore-budget-backup-2025-12-31-235959.sqlite',
      'budget-backup-2026-01-01-000000.sqlite',
      'budget-backup-2026-01-01-000000-1.sqlite',
      'budget-backup-2026-01-02-000000.sqlite',
      'pre-migrate-budget-backup-2026-01-01-000000.sqlite',
      'manual-budget-backup-2026-02-01-120000.sqlite',
    ];
    names.forEach((name, index) => {
      fs.writeFileSync(path.join(dir, name), String(index));
      fs.utimesSync(path.join(dir, name), new Date(2020, 0, index + 1), new Date(2020, 0, index + 1));
    });
    pruneBackups(dir, 2);
    expect(fs.readdirSync(dir).sort()).toEqual([
      'budget-backup-2026-01-01-000000-1.sqlite',
      'budget-backup-2026-01-02-000000.sqlite',
      'manual-budget-backup-2026-02-01-120000.sqlite',
      'pre-migrate-budget-backup-2026-01-01-000000.sqlite',
      'pre-restore-budget-backup-2025-12-31-235959.sqlite',
    ]);

    const protectedName = 'pre-restore-budget-backup-2024-01-01-000000.sqlite';
    fs.writeFileSync(path.join(dir, protectedName), 'protected');
    pruneBackups(dir, 1, new Set(), new Set([protectedName]));
    expect(fs.readdirSync(dir).sort()).toEqual([
      'budget-backup-2026-01-02-000000.sqlite',
      'manual-budget-backup-2026-02-01-120000.sqlite',
      'pre-migrate-budget-backup-2026-01-01-000000.sqlite',
      'pre-restore-budget-backup-2024-01-01-000000.sqlite',
      'pre-restore-budget-backup-2025-12-31-235959.sqlite',
    ]);
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('并发备份串行生成独立文件，标签备份不占月度归档', async () => {
    const { db, dir, dbPath } = tempFileDb();
    const backupDir = backupDirOf(dbPath);
    const [first, second] = await Promise.all([
      createBackup(db, backupDir),
      createBackup(db, backupDir),
    ]);
    expect(first.file).not.toBe(second.file);
    expect([first.monthly, second.monthly].sort()).toEqual([false, true]);
    expect(verifyBackupFile(path.join(backupDir, first.file)).ok).toBe(true);
    expect(verifyBackupFile(path.join(backupDir, second.file)).ok).toBe(true);

    const tagged = await createBackup(db, backupDir, 'manual');
    expect(tagged.monthly).toBe(false);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });
});

describe('D11 预算 Excel 按版本快照解析', () => {
  it('当前树删除快照节点后，历史草稿仍可按快照编码解析并保存', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const version = budget.createVersion(db, { year: 2026, name: '快照编码导入' });
    org.deleteOrg(db, fx.orgIds.hangzhou);
    expect(db.prepare("SELECT 1 FROM org WHERE code='HZ'").get()).toBeUndefined();

    const resolved = io.resolveBudgetImport(db, version.id, {
      ok: true,
      errors: [],
      rows: [{
        orgCode: 'HZ',
        accountCode: 'I01',
        amountText: '12.34',
        quantityText: '',
        formula: '',
        memo: '按版本快照解析',
      }],
    });
    expect(resolved).toEqual([{
      orgId: fx.orgIds.hangzhou,
      accountId: fx.accIds.incomeMain,
      amount: '12.34',
      quantity: undefined,
      formula: undefined,
      note: '按版本快照解析',
    }]);
    budget.saveEntries(db, version.id, resolved, 0);
    expect((db.prepare(
      'SELECT amount_cents FROM budget_entry WHERE version_id=? AND org_id=? AND account_id=?',
    ).get(version.id, fx.orgIds.hangzhou, fx.accIds.incomeMain) as { amount_cents: number }).amount_cents).toBe(1_234);
    db.close();
  });

  it('预览期即拒绝非叶子组织/科目,不再出现预览成功、确认必败', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const version = budget.createVersion(db, { year: 2026, name: '叶子校验' });
    const rowErrors = (fn: () => unknown) => {
      try { fn(); } catch (error) {
        const detail = (error as { errors?: { message: string }[] }).errors;
        if (detail?.length) return detail.map((e) => e.message).join(';');
        return String((error as Error).message);
      }
      return '';
    };

    // 一级科目(I)在快照内且编码存在,过去预览会通过、确认才在 saveEntries 抛错
    expect(rowErrors(() => io.resolveBudgetImport(db, version.id, {
      ok: true,
      errors: [],
      rows: [{ orgCode: 'SH', accountCode: 'I', amountText: '12.34', quantityText: '', formula: '', memo: '' }],
    }))).toMatch(/不是叶子科目/);

    // 非叶子组织(EAST 大区)同理
    expect(rowErrors(() => io.resolveBudgetImport(db, version.id, {
      ok: true,
      errors: [],
      rows: [{ orgCode: 'EAST', accountCode: 'I01', amountText: '12.34', quantityText: '', formula: '', memo: '' }],
    }))).toMatch(/不是叶子组织/);
    db.close();
  });
});

describe('D12 导入前排空预算自动保存', () => {
  it('前端契约要求强制持久化最新防抖草稿、传播保存错误并在 409 后停止自动保存', () => {
    // UX-05 起保存编排提取到独立 hook,导入互斥在 UX-13 改为「创建预览前排空并锁定」:
    // 断言落在现行实现文件上,契约含义不变(排空、错误传播、409 停止自动保存)。
    const orchestration = fs.readFileSync(
      path.resolve(__dirname, '../../frontend/src/pages/budgetEdit/useBudgetSaveOrchestration.ts'),
      'utf8',
    );
    const drainStart = orchestration.indexOf('const drainDraftSaves');
    const drainEnd = orchestration.indexOf('const waitForInFlightSaves', drainStart);
    expect(drainStart).toBeGreaterThan(-1);
    expect(drainEnd).toBeGreaterThan(drainStart);
    const drain = orchestration.slice(drainStart, drainEnd);
    expect(drain).toContain('if (latest.dirty || summaryNotesDirtyRef.current) await persistLatest();');
    expect(drain).toContain('await saveChainRef.current');
    expect(drain).not.toContain('.catch(() => undefined)');
    // 409 并发冲突:置冲突状态,自动保存守卫因此停摆
    expect(orchestration).toContain('e instanceof ApiError && e.status === 409');
    expect(orchestration).toContain('setSaveConflict(true)');
    expect(orchestration).toContain('if (!editable || draftActionPending || saveConflict || !anyDirty) return;');

    // 导入互斥(UX-13):prepareImport 先排空最新草稿,排空失败则取消导入并保持解锁
    const page = fs.readFileSync(
      path.resolve(__dirname, '../../frontend/src/pages/BudgetEdit.tsx'),
      'utf8',
    );
    const prepareStart = page.indexOf('const prepareImport');
    const prepareEnd = page.indexOf('const releaseImportLock', prepareStart);
    expect(prepareStart).toBeGreaterThan(-1);
    expect(prepareEnd).toBeGreaterThan(prepareStart);
    const prepare = page.slice(prepareStart, prepareEnd);
    expect(prepare).toContain('await drainDraftSaves()');
    expect(prepare).toContain('return false');

    // 标准与清洗两条导入路径都在创建预览/打开向导前经 onPrepareImport 排空
    const header = fs.readFileSync(
      path.resolve(__dirname, '../../frontend/src/pages/budgetEdit/BudgetHeaderActions.tsx'),
      'utf8',
    );
    const standardPrepare = header.indexOf('await props.onPrepareImport()');
    expect(standardPrepare).toBeGreaterThan(-1);
    const standardImport = header.indexOf("'/io/budget/import'", standardPrepare);
    expect(standardImport).toBeGreaterThan(standardPrepare);
    const cleaningPrepare = header.indexOf('onPrepareImport()', standardImport);
    expect(cleaningPrepare).toBeGreaterThan(-1);
  });
});

describe('D13 AI 报告事实 token 双向守卫', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.AI_BASE_URL;
    delete process.env.AI_API_KEY;
  });

  it('模型修改年份、整数版本号或删除事实数字时整篇回退确定性模板', async () => {
    const db = testDb();
    const fx = buildFixture(db);
    const version = standardBudgetVersion(fx);
    actual.saveActual(db, {
      year: 2026,
      snapshotDate: '2026-06-30',
      source: 'manual',
      mode: 'replace',
      entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '50.00' }],
    });
    process.env.AI_BASE_URL = 'http://model.test/v1';
    const template = await assistant.reportDraft(db, {
      kind: 'monthly_execution',
      versionId: version.id,
      narrative: false,
    });
    const decimal = template.narrative.match(/\d+\.\d+/)?.[0];
    expect(decimal).toBeTruthy();
    const rewrites = [
      template.narrative.replace('2026', '2027'),
      template.narrative.replace(`#${version.id}`, `#${version.id + 99}`),
      template.narrative.replace(decimal!, ''),
    ];
    const withoutGeneratedAt = (text: string) => text.replace(/^生成时间:[^\n]+$/m, '生成时间:<dynamic>');
    for (const rewritten of rewrites) {
      vi.stubGlobal('fetch', vi.fn(async () => ({
        ok: true,
        json: async () => ({ choices: [{ message: { content: rewritten } }], model: 'fake-model' }),
      })));
      const result = await assistant.reportDraft(db, {
        kind: 'monthly_execution',
        versionId: version.id,
      });
      expect(result.model).toBe('template');
      expect(result.narrativeSource).toBe('template');
      expect(withoutGeneratedAt(result.narrative)).toBe(withoutGeneratedAt(template.narrative));
      expect(result.narrative).not.toBe(rewritten);
      expect(result.notes.some((note) => note.includes('改变了事实 token'))).toBe(true);
    }
    db.close();
  });
});

describe('D14 SSE 客户端断开取消模型与落库', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.AI_BASE_URL;
    delete process.env.AI_API_KEY;
    resetAssistantRateLimit();
  });

  it('客户端收到 open 后断开会 abort provider，且不写会话、消息和 ai.chat 日志', async () => {
    process.env.AI_BASE_URL = 'http://model.test/v1';
    resetAssistantRateLimit();
    const { app, holder } = await createApp({ dbPath: ':memory:', auth: { username: '', password: '' } });
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const port = (server.address() as { port: number }).port;
    const realFetch = globalThis.fetch.bind(globalThis);
    let providerStartedResolve!: () => void;
    let providerAbortedResolve!: () => void;
    const providerStarted = new Promise<void>((resolve) => { providerStartedResolve = resolve; });
    const providerAborted = new Promise<void>((resolve) => { providerAbortedResolve = resolve; });
    vi.stubGlobal('fetch', vi.fn((input: any, init?: any) => {
      const url = typeof input === 'string' ? input : String(input?.url ?? input);
      if (!url.startsWith('http://model.test/')) return realFetch(input, init);
      providerStartedResolve();
      return new Promise((_resolve, reject) => {
        const abort = () => {
          providerAbortedResolve();
          const error: any = new Error('aborted');
          error.name = 'AbortError';
          reject(error);
        };
        if (init?.signal?.aborted) abort();
        else init?.signal?.addEventListener('abort', abort, { once: true });
      });
    }));

    const clientController = new AbortController();
    try {
      const response = await fetch(`http://127.0.0.1:${port}/api/assistant/chat/stream`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ message: '你好' }),
        signal: clientController.signal,
      });
      expect(response.status).toBe(200);
      const reader = response.body!.getReader();
      const decoder = new TextDecoder();
      let received = '';
      while (!received.includes('event: open')) {
        const chunk = await reader.read();
        if (chunk.done) break;
        received += decoder.decode(chunk.value, { stream: true });
      }
      expect(received).toContain('event: open');
      await Promise.race([
        providerStarted,
        new Promise((_, reject) => setTimeout(() => reject(new Error('provider 未启动')), 2_000)),
      ]);
      clientController.abort();
      await reader.cancel().catch(() => undefined);
      await Promise.race([
        providerAborted,
        new Promise((_, reject) => setTimeout(() => reject(new Error('provider 未收到 abort')), 2_000)),
      ]);
      await new Promise((resolve) => setTimeout(resolve, 30));

      const db = holder.getDb();
      expect((db.prepare('SELECT COUNT(*) AS count FROM ai_conversation').get() as { count: number }).count).toBe(0);
      expect((db.prepare('SELECT COUNT(*) AS count FROM ai_message').get() as { count: number }).count).toBe(0);
      expect((db.prepare("SELECT COUNT(*) AS count FROM operation_log WHERE action='ai.chat'").get() as { count: number }).count).toBe(0);
    } finally {
      clientController.abort();
      await new Promise<void>((resolve) => server.close(() => resolve()));
      holder.getDb().close();
    }
  });
});

describe('D15 财务数据源配置运行时校验', () => {
  it('非法单位、范围数组、输出上限和未知编码均在创建/更新边界返回 400', () => {
    const db = testDb();
    buildFixture(db);
    const valid = { amountUnit: 'yuan', ownedOrgCodes: ['GROUP'], ownedAccountCodes: ['I'] };
    const invalidConfigs: unknown[] = [
      { ...valid, amountUnit: 'wna' },
      { ...valid, ownedOrgCodes: 'GROUP' },
      { ...valid, ownedAccountCodes: 42 },
      { ...valid, maxOutputBytes: -1 },
      { ...valid, ownedOrgCodes: ['MISSING_ORG'] },
    ];
    invalidConfigs.forEach((config, index) => {
      let failure: any;
      try {
        createSourceProfile(db, { code: `BAD_PROFILE_${index}`, name: '非法配置', config });
      } catch (error) {
        failure = error;
      }
      expect(failure).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    });
    expect((db.prepare('SELECT COUNT(*) AS count FROM finance_source_profile').get() as { count: number }).count).toBe(0);

    const profile = createSourceProfile(db, { code: 'VALID_PROFILE', name: '合法配置', config: valid });
    expect(() => updateSourceProfile(db, profile.id, { config: { ...valid, amountUnit: 'invalid' } }))
      .toThrow(/amountUnit/);
    expect(JSON.parse(updateSourceProfile(db, profile.id, {}).config_json).amountUnit).toBe('yuan');
    db.close();
  });
});

describe('D16 测算税率定义域', () => {
  it('defaultTaxRate=-100 在保存边界返回 400，而大于 -100 的临界值可保存', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const before = (db.prepare('SELECT COUNT(*) AS count FROM budget_calculation_rule').get() as { count: number }).count;
    const base = {
      quantityAccountCode: 'QTY',
      priceAccountCode: 'PRICE',
      outputAccountCode: 'I01',
    };
    let failure: any;
    try {
      saveRule(db, {
        code: 'BAD_TAX',
        name: '非法税率',
        ruleType: 'quantity_price_net_tax',
        config: { ...base, defaultTaxRate: '-100' },
      });
    } catch (error) {
      failure = error;
    }
    expect(failure).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    expect(String(failure?.message)).toContain('大于 -100%');
    expect((db.prepare('SELECT COUNT(*) AS count FROM budget_calculation_rule').get() as { count: number }).count).toBe(before);
    expect(saveRule(db, {
      code: 'EDGE_TAX',
      name: '临界合法税率',
      ruleType: 'quantity_price_net_tax',
      config: { ...base, defaultTaxRate: '-99.9999' },
    }).code).toBe('EDGE_TAX');
    expect((db.prepare('SELECT COUNT(*) AS count FROM budget_calculation_rule').get() as { count: number }).count).toBe(before + 1);

    const quantity = account.createAccount(db, {
      parentId: null, code: 'D16_QTY', name: '测算数量', type: 'quantity', unit: '项', quantityAgg: 'none',
    });
    const price = account.createAccount(db, {
      parentId: null, code: 'D16_PRICE', name: '测算单价', type: 'quantity', unit: '元/项', quantityAgg: 'none',
    });
    const tax = account.createAccount(db, {
      parentId: null, code: 'D16_TAX', name: '动态税率', type: 'quantity', unit: '%', quantityAgg: 'none',
    });
    const dynamicRule = saveRule(db, {
      code: 'DYNAMIC_TAX',
      name: '动态税率定义域',
      ruleType: 'quantity_price_net_tax',
      config: {
        quantityAccountCode: quantity.code,
        priceAccountCode: price.code,
        taxAccountCode: tax.code,
        defaultTaxRate: '0',
        outputAccountCode: 'I01',
      },
    });
    const version = budget.createVersion(db, { year: 2026, name: '动态税率测算' });
    budget.saveEntries(db, version.id, [
      { orgId: fx.orgIds.shanghai, accountId: quantity.id, quantity: '10' },
      { orgId: fx.orgIds.shanghai, accountId: price.id, quantity: '2' },
      { orgId: fx.orgIds.shanghai, accountId: tax.id, quantity: '-100.0001' },
    ]);
    let dynamicFailure: any;
    try {
      previewRule(db, version.id, dynamicRule.id);
    } catch (error) {
      dynamicFailure = error;
    }
    expect(dynamicFailure).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });
    expect(String(dynamicFailure?.message)).toContain('税率必须大于 -100%');
    db.close();
  });
});

describe('D17 Structure 历史版本候选源', () => {
  it('版本 matrix/metrics 始终返回绑定快照节点和指标，不随当前主数据增删漂移', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const historicalMetric = metric.createMetric(db, {
      code: 'HIST_ONLY',
      name: '历史专属指标',
      terms: [{ sourceType: 'account', sourceAccountId: fx.accIds.incomeMain, coefficient: 1 }],
    });
    const version = budget.createVersion(db, { year: 2026, name: '历史 Structure 候选' });
    budget.lockVersion(db, version.id);

    org.deleteOrg(db, fx.orgIds.hangzhou);
    const currentOnlyOrg = org.createOrg(db, { parentId: fx.orgIds.west, code: 'CURRENT_ONLY', name: '当前新增组织' });
    metric.deleteMetric(db, historicalMetric.id);
    const currentMetric = metric.createMetric(db, {
      code: 'CURRENT_ONLY',
      name: '当前新增指标',
      terms: [{ sourceType: 'account', sourceAccountId: fx.accIds.incomeMain, coefficient: 1 }],
    });

    const matrix = budget.getEditMatrix(db, version.id);
    expect(matrix.orgNodes.some((node) => node.id === fx.orgIds.hangzhou && node.name === '杭州公司')).toBe(true);
    expect(matrix.orgNodes.some((node) => node.id === currentOnlyOrg.id)).toBe(false);
    const candidates = metric.listMetricsForVersion(db, version.id);
    expect(candidates.some((item) => item.id === historicalMetric.id && item.code === 'HIST_ONLY')).toBe(true);
    expect(candidates.some((item) => item.id === currentMetric.id)).toBe(false);
    db.close();
  });
});

describe('D18 扁平实际 Excel 日期单元格', () => {
  it('ExcelJS Date 类型截止日期规范化为 YYYY-MM-DD 并通过解析', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('实际数导入');
    sheet.addRow(['年度', '截止日期', '组织编码', '科目编码', '累计金额(元)', '备注']);
    sheet.addRow([2026, new Date(Date.UTC(2026, 5, 30)), 'SH', 'I01', '123.45', '真实 Date 单元格']);
    const parsed = await io.parseActualImport(Buffer.from(await workbook.xlsx.writeBuffer()));
    expect(parsed.ok).toBe(true);
    expect(parsed.errors).toEqual([]);
    expect(parsed.dates).toEqual(['2026-06-30']);
    expect(parsed.rows[0]).toMatchObject({ year: 2026, snapshotDate: '2026-06-30', amountText: '123.45' });
  });
});

describe('D19 预算明细 Excel 批注定位', () => {
  it('金额批注落第 6 列、数量批注落第 7 列的真实数据行，且 ExcelJS 往返保留', async () => {
    const db = testDb();
    const fx = buildFixture(db);
    const quantity = account.createAccount(db, {
      parentId: null,
      code: 'Q_D19',
      name: '批注数量',
      type: 'quantity',
      unit: '项',
      quantityAgg: 'sum',
    });
    const version = budget.createVersion(db, { year: 2026, name: '批注定位' });
    budget.saveEntries(db, version.id, [
      {
        orgId: fx.orgIds.shanghai,
        accountId: fx.accIds.incomeMain,
        amount: '123.45',
        formula: '=100+23.45',
        note: '金额测算依据',
      },
      {
        orgId: fx.orgIds.shanghai,
        accountId: quantity.id,
        quantity: '6.5',
        formula: '=2+4.5',
        note: '数量测算依据',
      },
    ]);
    const first = new ExcelJS.Workbook();
    await first.xlsx.load(await exportBudgetDetail(db, version.id) as unknown as ExcelJS.Buffer);
    const sheet = first.getWorksheet('预算编制明细')!;
    const rows = new Map<string, ExcelJS.Row>();
    sheet.eachRow((row) => {
      const code = String(row.getCell(3).value ?? '');
      if (code) rows.set(code, row);
    });
    const noteText = (cell: ExcelJS.Cell) => typeof cell.note === 'string' ? cell.note : JSON.stringify(cell.note);
    const amountRow = rows.get('I01')!;
    const quantityRow = rows.get('Q_D19')!;
    expect(amountRow.number).toBeGreaterThan(6);
    expect(quantityRow.number).toBeGreaterThan(6);
    expect(noteText(amountRow.getCell(6))).toContain('金额测算依据');
    expect(amountRow.getCell(7).note).toBeUndefined();
    expect(noteText(quantityRow.getCell(7))).toContain('数量测算依据');
    expect(quantityRow.getCell(6).note).toBeUndefined();

    const second = new ExcelJS.Workbook();
    await second.xlsx.load(await first.xlsx.writeBuffer() as unknown as ExcelJS.Buffer);
    const roundTrip = second.getWorksheet('预算编制明细')!;
    expect(noteText(roundTrip.getRow(amountRow.number).getCell(6))).toContain('金额测算依据');
    expect(noteText(roundTrip.getRow(quantityRow.number).getCell(7))).toContain('数量测算依据');
    db.close();
  });
});

describe('D20 锁定财务映射名称快照', () => {
  it('主数据改名后列表和导出保留快照名称，并另行返回当前名称', async () => {
    const db = testDb();
    const fx = buildFixture(db);
    const profile = createSourceProfile(db, {
      code: 'D20_PROFILE',
      name: '名称快照数据源',
      config: { amountUnit: 'yuan', ownedOrgCodes: ['GROUP'], ownedAccountCodes: ['I'] },
    });
    const mapping = createMappingVersion(db, { sourceProfileId: profile.id, name: '名称快照映射' });
    replaceOrgMappings(db, mapping.id, [{ sourceOrgCode: 'S001', targetOrgId: fx.orgIds.shanghai }]);
    replaceAccountMappings(db, mapping.id, [{ sourceAccountCode: '4001', targetAccountId: fx.accIds.incomeMain, amountRule: 'credit_minus_debit' }]);
    replaceReconciliationRules(db, mapping.id, [{ sourceLineAlias: '营业收入', targetType: 'account', targetCode: 'I' }]);
    lockMappingVersion(db, mapping.id, 'reviewer');

    org.updateOrg(db, fx.orgIds.shanghai, { name: '上海当前新名称' });
    account.updateAccount(db, fx.accIds.incomeMain, { name: '收入当前新名称' });
    expect(listOrgMappings(db, mapping.id)[0]).toMatchObject({
      target_org_name: '上海公司',
      current_target_org_name: '上海当前新名称',
    });
    expect(listAccountMappings(db, mapping.id)[0]).toMatchObject({
      target_account_name: '主营业务收入',
      current_target_account_name: '收入当前新名称',
    });

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await exportMappings(db, mapping.id) as unknown as ExcelJS.Buffer);
    // 列序:… 依据 / 来源 / 已复核 / 目标快照名称(provenance 列在 V33 后随导出一起往返)
    const orgRow = workbook.getWorksheet('组织映射')!.getRow(2);
    expect([String(orgRow.getCell(8).value), String(orgRow.getCell(9).value)]).toEqual(['手工', '是']);
    expect(String(orgRow.getCell(10).value)).toBe('上海公司');
    const accRow = workbook.getWorksheet('科目映射')!.getRow(2);
    expect([String(accRow.getCell(11).value), String(accRow.getCell(12).value)]).toEqual(['手工', '是']);
    expect(String(accRow.getCell(13).value)).toBe('主营业务收入');
    db.close();
  });
});

describe('D21 删除 superseded 实际快照审计', () => {
  it('物理删除批次及明细时写 actual.snapshot.delete 和完整原批次详情', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const first = actual.saveActual(db, {
      year: 2026,
      snapshotDate: '2026-06-30',
      source: 'manual',
      mode: 'replace',
      note: '第一版',
      entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '10.00' }],
    });
    actual.saveActual(db, {
      year: 2026,
      snapshotDate: '2026-06-30',
      source: 'manual',
      mode: 'replace',
      note: '第二版',
      entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '20.00' }],
    });
    expect(actual.getBatch(db, first.batchId).status).toBe('superseded');
    actual.deleteSupersededBatch(db, first.batchId);
    expect(db.prepare('SELECT 1 FROM actual_snapshot_batch WHERE id=?').get(first.batchId)).toBeUndefined();
    expect(db.prepare('SELECT 1 FROM actual_snapshot_entry WHERE batch_id=?').get(first.batchId)).toBeUndefined();
    const log = db.prepare(
      "SELECT entity_type,entity_id,detail_json FROM operation_log WHERE action='actual.snapshot.delete' ORDER BY id DESC LIMIT 1",
    ).get() as { entity_type: string; entity_id: string; detail_json: string };
    expect(log).toMatchObject({ entity_type: 'actual_snapshot_batch', entity_id: String(first.batchId) });
    expect(JSON.parse(log.detail_json)).toEqual({
      year: 2026,
      snapshotDate: '2026-06-30',
      revision: 1,
      source: 'manual',
      updatesCurrent: 1,
      previousStatus: 'superseded',
      entryCount: 1,
    });
    db.close();
  });
});

describe('D22 历年页面与 Excel 符号口径', () => {
  it('成本、费用在导出中为业务正数，且页面说明明确同一展示口径', async () => {
    const db = testDb();
    const fx = buildFixture(db);
    const version = standardBudgetVersion(fx);
    budget.lockVersion(db, version.id);
    budget.setCurrentVersion(db, version.id);
    const final = actual.saveActual(db, {
      year: 2026,
      snapshotDate: '2026-12-31',
      source: 'manual',
      mode: 'replace',
      entries: [
        { orgId: fx.orgIds.shanghai, accountId: fx.accIds.costSub, amount: '40.00' },
        { orgId: fx.orgIds.shanghai, accountId: fx.accIds.expenseAdmin, amount: '12.00' },
      ],
    });
    freezeYear(db, 2026, final.batchId);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(await exportHistorical(db) as unknown as ExcelJS.Buffer);
    const sheet = workbook.getWorksheet('历年预实对比')!;
    let dataRow: ExcelJS.Row | undefined;
    sheet.eachRow((row) => {
      if (Number(row.getCell(1).value) === 2026) dataRow = row;
    });
    expect(dataRow).toBeTruthy();
    expect(dataRow!.getCell(6).value).toBe(90);
    expect(dataRow!.getCell(7).value).toBe(40);
    expect(dataRow!.getCell(8).value).toBe(30);
    expect(dataRow!.getCell(9).value).toBe(12);
    for (const column of [6, 7, 8, 9]) expect(Number(dataRow!.getCell(column).value)).toBeGreaterThanOrEqual(0);

    const notes = historicalComparison(db).notes.join(';');
    expect(notes).toContain('页面与 Excel 的收入、成本、费用均为业务正数');
    expect(notes).not.toContain('金额为带符号利润方向口径:收入为正,成本费用为负');
    const exportedMetadata = sheet.getRows(1, dataRow!.number - 1)
      ?.flatMap((row) => (row.values as unknown[]).slice(1).map(String)).join('\n') ?? '';
    expect(exportedMetadata).toContain('收入、成本、费用为业务正数');
    expect(exportedMetadata).not.toContain('金额为带符号利润方向口径:收入为正,成本费用为负');

    const historyPage = fs.readFileSync(
      path.resolve(__dirname, '../../frontend/src/pages/History.tsx'),
      'utf8',
    );
    expect(historyPage).toContain('收入、成本、费用均按业务正数展示');
    db.close();
  });
});

describe('R01 CSV 公式注入边界', () => {
  it('只中和字符串型危险前缀，数值型负数保持数值语义，两个 CSV 出口均复用该规则', async () => {
    expect(csvCell('=1+1')).toBe("'=1+1");
    expect(csvCell(' \t@SUM(A1:A2)')).toBe("' \t@SUM(A1:A2)");
    expect(csvCell(-12_345)).toBe('-12345');

    const db = testDb();
    const fx = buildFixture(db);
    const version = standardBudgetVersion(fx);
    db.prepare('UPDATE budget_entry SET formula=?, note=? WHERE version_id=? AND org_id=? AND account_id=?')
      .run('+FORMULA', '=HYPERLINK("https://invalid.test")', version.id, fx.orgIds.shanghai, fx.accIds.costSub);
    assistant.resetArtifactCache();
    const action = assistant.preview(db, {
      type: 'export',
      params: { kind: 'budget_detail', versionId: version.id, format: 'csv' },
    });
    await assistant.confirmAsync(db, action.id, '', action.confirmationToken);
    const assistantCsv = (await assistant.exportArtifact(db, action.id)).buffer.toString('utf8');
    expect(assistantCsv).toContain("'+FORMULA");
    expect(assistantCsv).toContain("'=HYPERLINK");
    expect(assistantCsv).toContain(',-6000,');

    const profile = createSourceProfile(db, {
      code: 'CSV_SAFE',
      name: 'CSV 安全测试',
      config: { amountUnit: 'yuan', ownedOrgCodes: ['GROUP'], ownedAccountCodes: ['I'] },
    });
    const mapping = createMappingVersion(db, { sourceProfileId: profile.id, name: 'CSV 安全映射' });
    replaceOrgMappings(db, mapping.id, [{
      sourceBookCode: '-TEXT-CODE',
      sourceOrgCode: '=2+2',
      sourceOrgName: '@危险名称',
      sourceAux: {},
      targetOrgId: fx.orgIds.shanghai,
      priority: -7,
      note: '+危险依据',
    }]);
    const mappingCsv = exportMappingsCsv(db, mapping.id, 'org').toString('utf8');
    expect(mappingCsv).toContain("'-TEXT-CODE");
    expect(mappingCsv).toContain("'=2+2");
    expect(mappingCsv).toContain("'@危险名称");
    expect(mappingCsv).toContain("'+危险依据");
    expect(mappingCsv).toContain(',-7,');
    db.close();
  });
});

describe('R02 极端安全整数差值', () => {
  it('数量预实差异超出安全整数时显式失败，不返回舍入后的错误结果', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const quantity = account.createAccount(db, {
      parentId: null,
      code: 'Q_SAFE',
      name: '安全整数数量',
      type: 'quantity',
      unit: '项',
      quantityAgg: 'sum',
    });
    const version = budget.createVersion(db, { year: 2026, name: '极端数量' });
    budget.saveEntries(db, version.id, [{ orgId: fx.orgIds.shanghai, accountId: quantity.id, quantity: '1' }]);
    actual.saveActual(db, {
      year: 2026,
      snapshotDate: '2026-06-30',
      source: 'manual',
      mode: 'replace',
      entries: [{ orgId: fx.orgIds.shanghai, accountId: quantity.id, quantity: '-1' }],
    });
    db.prepare('UPDATE budget_entry SET quantity=? WHERE version_id=? AND org_id=? AND account_id=?')
      .run(Number.MAX_SAFE_INTEGER, version.id, fx.orgIds.shanghai, quantity.id);
    db.prepare('UPDATE actual_current SET quantity=? WHERE year=? AND org_id=? AND account_id=?')
      .run(Number.MIN_SAFE_INTEGER, 2026, fx.orgIds.shanghai, quantity.id);
    expect(() => completionReport(db, { versionId: version.id }))
      .toThrow(/预实数量差异超出 JavaScript 安全整数范围/);
    db.close();
  });

  it('结构占比和比率指标的两侧各自安全、差值溢出时均被阻断', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const numerator = account.createAccount(db, { parentId: null, code: 'I_NUM_SAFE', name: '极端分子', type: 'income' });
    const denominator = account.createAccount(db, { parentId: null, code: 'I_DEN_SAFE', name: '一分基准', type: 'income' });
    metric.createMetric(db, {
      code: 'R_SAFE',
      name: '极端比率',
      kind: 'ratio',
      terms: [
        { sourceType: 'account', sourceAccountId: numerator.id, coefficient: 1, role: 'numerator' },
        { sourceType: 'account', sourceAccountId: denominator.id, coefficient: 1, role: 'denominator' },
      ],
    });
    const version = budget.createVersion(db, { year: 2026, name: '极端比率' });
    budget.saveEntries(db, version.id, [
      { orgId: fx.orgIds.shanghai, accountId: numerator.id, amount: '-90071992.54' },
      { orgId: fx.orgIds.shanghai, accountId: denominator.id, amount: '0.01' },
    ]);
    actual.saveActual(db, {
      year: 2026,
      snapshotDate: '2026-06-30',
      source: 'manual',
      mode: 'replace',
      entries: [
        { orgId: fx.orgIds.shanghai, accountId: numerator.id, amount: '90071992.54' },
        { orgId: fx.orgIds.shanghai, accountId: denominator.id, amount: '0.01' },
      ],
    });
    expect(() => structureReport(db, { versionId: version.id, basisMode: 'account', basisId: denominator.id }))
      .toThrow(/结构占比差异超出 JavaScript 安全整数范围/);
    expect(() => completionReport(db, { versionId: version.id }))
      .toThrow(/比率指标差异超出 JavaScript 安全整数范围/);
    db.close();
  });
});

describe('R03 遗留 pending 导入基线', () => {
  const removePreviewBaseline = (db: ReturnType<typeof testDb>, id: number) => {
    const row = db.prepare('SELECT summary_json FROM import_batch WHERE id=?').get(id) as { summary_json: string };
    const summary = JSON.parse(row.summary_json);
    delete summary.previewBaseline;
    db.prepare('UPDATE import_batch SET summary_json=? WHERE id=?').run(JSON.stringify(summary), id);
  };

  it('预算、当前实际和历史补录的旧批次缺少字段时都拒绝确认；新历史批次的显式 null 仍合法', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const version = budget.createVersion(db, { year: 2026, name: '导入基线' });
    const budgetBatch = imports.createBatch(db, {
      kind: 'budget',
      targetVersionId: version.id,
      originalName: 'legacy-budget.xlsx',
      file: Buffer.from('legacy-budget'),
      payload: { versionId: version.id, entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '1.00' }] },
      summary: {},
    });
    removePreviewBaseline(db, budgetBatch.id);
    expect(() => imports.commitBatch(db, budgetBatch.id)).toThrow(/并发基线启用前/);

    const currentBatch = imports.createBatch(db, {
      kind: 'actual',
      originalName: 'legacy-current.xlsx',
      file: Buffer.from('legacy-current'),
      payload: { history: false, note: '', batches: [{ year: 2026, snapshotDate: '2026-06-30', entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '2.00' }] }] },
      summary: {},
    });
    removePreviewBaseline(db, currentBatch.id);
    expect(() => imports.commitBatch(db, currentBatch.id)).toThrow(/并发基线启用前/);

    const legacyHistory = imports.createBatch(db, {
      kind: 'actual',
      history: true,
      originalName: 'legacy-history.xlsx',
      file: Buffer.from('legacy-history'),
      payload: { history: true, note: '', batches: [{ year: 2025, snapshotDate: '2025-12-31', entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '3.00' }] }] },
      summary: {},
    });
    removePreviewBaseline(db, legacyHistory.id);
    expect(() => imports.commitBatch(db, legacyHistory.id)).toThrow(/并发基线启用前/);

    const newHistory = imports.createBatch(db, {
      kind: 'actual',
      history: true,
      originalName: 'new-history.xlsx',
      file: Buffer.from('new-history'),
      payload: { history: true, note: '', batches: [{ year: 2024, snapshotDate: '2024-12-31', entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '4.00' }] }] },
      summary: {},
    });
    expect(JSON.parse(newHistory.summary_json).previewBaseline).toBeNull();
    expect(imports.commitBatch(db, newHistory.id).status).toBe('committed');
    db.close();
  });
});

describe('R04 CRLF SSE 兼容', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
    delete process.env.AI_BASE_URL;
    delete process.env.AI_API_KEY;
  });

  it('CRLF 分隔符即使在 CR 与 LF 之间跨 chunk 也能逐事件解析', async () => {
    process.env.AI_BASE_URL = 'http://model.test/v1';
    const encoder = new TextEncoder();
    const chunks = [
      'data: {"choices":[{"delta":{"content":"甲"}}]}\r',
      '\n\r',
      '\ndata: {"choices":[{"delta":{"content":"乙"}}]}\r\n\r',
      '\ndata: [DONE]\r',
      '\n\r\n',
    ];
    let index = 0;
    vi.stubGlobal('fetch', vi.fn(async () => ({
      ok: true,
      body: {
        getReader: () => ({
          read: async () => index < chunks.length
            ? { done: false, value: encoder.encode(chunks[index++]) }
            : { done: true, value: undefined },
        }),
      },
    })));
    const tokens: string[] = [];
    let resultText = '';
    for await (const event of new EnvChatModel().streamChat({ messages: [{ role: 'user', content: '测试' }] })) {
      if (event.type === 'text') tokens.push(event.text);
      else resultText = event.result.text;
    }
    expect(tokens).toEqual(['甲', '乙']);
    expect(resultText).toBe('甲乙');
  });
});

describe('R05 trust proxy 部署边界', () => {
  it('直连默认关闭，只有调用方显式配置时才信任对应代理跳数', async () => {
    const direct = await createApp({ dbPath: ':memory:', auth: { username: '', password: '' } });
    expect(direct.app.get('trust proxy')).toBe(false);
    direct.holder.getDb().close();

    const proxied = await createApp({ dbPath: ':memory:', auth: { username: '', password: '' }, trustProxy: 1 });
    expect(proxied.app.get('trust proxy')).toBe(1);
    proxied.holder.getDb().close();
  });
});

describe('R06 外部 JSON 输入错误分类', () => {
  it('数据源字符串配置、CSV 与 XLSX 映射 JSON 均返回带字段和行号的 400 业务错误', async () => {
    const db = testDb();
    const fx = buildFixture(db);
    let profileError: any;
    try {
      createSourceProfile(db, { code: 'BAD_JSON', name: '错误 JSON', config: '{bad' });
    } catch (error) {
      profileError = error;
    }
    expect(profileError).toMatchObject({ status: 400, code: 'VALIDATION_FAILED' });

    const profile = createSourceProfile(db, {
      code: 'JSON_IMPORT',
      name: 'JSON 导入',
      config: { amountUnit: 'yuan', ownedOrgCodes: ['GROUP'], ownedAccountCodes: ['I'] },
    });
    const mapping = createMappingVersion(db, { sourceProfileId: profile.id, name: 'JSON 映射' });
    const badCsv = Buffer.from([
      '源账套,源组织编码,源组织名称,辅助条件JSON,目标组织编码,优先级,依据',
      'BOOK,ORG,组织,{bad,SH,1,依据',
    ].join('\r\n'));
    let csvError: any;
    try {
      importMappingsCsv(db, mapping.id, 'org', badCsv);
    } catch (error) {
      csvError = error;
    }
    expect(csvError).toMatchObject({
      status: 400,
      code: 'IMPORT_VALIDATION_FAILED',
      errors: [{ row: 2, field: '辅助条件JSON' }],
    });

    const wb = new ExcelJS.Workbook();
    const orgSheet = wb.addWorksheet('组织映射');
    orgSheet.addRow(['源账套', '源组织编码', '源组织名称', '辅助条件JSON', '目标组织编码', '优先级', '依据']);
    orgSheet.addRow(['BOOK', 'ORG', '组织', '{bad', 'SH', 1, '依据']);
    wb.addWorksheet('科目映射').addRow(['源科目编码', '源科目名称', '辅助条件JSON', '目标科目编码']);
    wb.addWorksheet('利润表勾稽').addRow(['官方项目', '目标类型', '目标编码', '组织范围JSON']);
    const xlsx = Buffer.from(await wb.xlsx.writeBuffer());
    await expect(importMappings(db, mapping.id, xlsx)).rejects.toMatchObject({
      status: 400,
      code: 'IMPORT_VALIDATION_FAILED',
      errors: [{ row: 2, field: '辅助条件JSON' }],
    });
    expect(fx.orgIds.shanghai).toBeGreaterThan(0);
    db.close();
  });
});
