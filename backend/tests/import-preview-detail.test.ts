import { afterEach, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { testDb, buildFixture, budget, account, actual } from './helpers';
import * as io from '../src/modules/io/excel';
import * as imports from '../src/modules/import/import.service';
import { buildStandardActualPreview, buildStandardBudgetPreview } from '../src/modules/import/preview-detail';
import { loadCleaningWorkbook } from '../src/modules/io/cleaning/workbook';
import { applyCleaningPlan } from '../src/modules/io/cleaning/apply';
import { createPendingCleaningPreview } from '../src/modules/io/cleaning/preview';
import type { CleaningPlan } from '../src/modules/io/cleaning/plan';
import { createSourceProfile } from '../src/modules/finance-import/source-profile.service';
import { createMappingVersion, lockMappingVersion, replaceAccountMappings, replaceOrgMappings, replaceReconciliationRules } from '../src/modules/finance-import/mapping/mapping.service';
import { validateMappingVersion } from '../src/modules/finance-import/mapping/mapping-validator';
import { createConversion, createImportPreview } from '../src/modules/finance-import/conversion/conversion-batch.service';
import { createApp } from '../src/server';

/** UX-14:统一预览明细冻结、批次只读详情、清洗/财务适配。 */

async function xlsx(sheets: { name: string; rows: unknown[][] }[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  for (const definition of sheets) {
    const sheet = workbook.addWorksheet(definition.name);
    for (const row of definition.rows) sheet.addRow(row);
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

const ACTUAL_HEADER = ['年度', '截止日期', '组织编码', '科目编码', '累计金额(元)', '累计数量', '备注'];
const BUDGET_HEADER = ['组织编码', '科目编码', '金额(元)', '数量', '备注'];

function cleaningPlan(input: Partial<CleaningPlan> & Pick<CleaningPlan, 'targetKind' | 'sheets' | 'columns' | 'valueKind'>): CleaningPlan {
  return {
    version: 1,
    excludedRows: [],
    mappings: [],
    ...(input.valueKind === 'amount' ? { amountUnit: 'yuan' as const, signConvention: 'display_positive' as const } : {}),
    ...input,
  };
}

function detailCount(db: ReturnType<typeof testDb>, batchId: number): number {
  return (db.prepare('SELECT COUNT(*) AS count FROM import_preview_detail WHERE import_batch_id = ?').get(batchId) as { count: number }).count;
}

describe('标准实际导入:精确差异分类与提交一致', () => {
  it('覆盖/清零/不变/新增/备注变更分类正确,提交后落库一致,详情不随当前数据漂移', async () => {
    const db = testDb();
    const fx = buildFixture(db);
    actual.saveActual(db, {
      year: 2026, snapshotDate: '2026-01-31', source: 'manual', mode: 'upsert',
      entries: [
        { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '10' },
        { orgId: fx.orgIds.shanghai, accountId: fx.accIds.expenseAdmin, amount: '8', memo: '原备注' },
        { orgId: fx.orgIds.shanghai, accountId: fx.accIds.costSub, amount: '5' },
        { orgId: fx.orgIds.nanjing, accountId: fx.accIds.expenseSales, amount: '10' },
      ],
    });
    const file = await xlsx([{ name: '实际数导入', rows: [
      ACTUAL_HEADER,
      [2026, '2026-06-30', 'SH', 'I01', '20.00', '', ''],
      [2026, '2026-06-30', 'SH', 'C0101', '0.00', '', ''],
      [2026, '2026-06-30', 'SH', 'E01', '8.00', '', '改备注'],
      [2026, '2026-06-30', 'HZ', 'I01', '50.00', '', ''],
      [2026, '2026-06-30', 'NJ', 'E02', '10.00', '', ''],
    ] }]);
    const parsed = await io.parseActualImport(file, db);
    expect(parsed.ok).toBe(true);
    const resolved = io.resolveActualImport(db, parsed, false);
    const preview = buildStandardActualPreview(db, { history: false, batches: resolved.batches, source: 'standard' });

    const actionOf = (orgCode: string, accountCode: string) =>
      preview.details.find((row) => row.orgCode === orgCode && row.accountCode === accountCode);
    expect(actionOf('SH', 'I01')).toMatchObject({ action: 'overwrite', oldCents: 1000, newCents: 2000 });
    expect(actionOf('SH', 'C0101')).toMatchObject({ action: 'clear', oldCents: -500, newCents: 0 });
    expect(actionOf('SH', 'E01')).toMatchObject({ action: 'note_change', oldCents: -800, newCents: -800, oldText: '原备注', newText: '改备注' });
    expect(actionOf('HZ', 'I01')).toMatchObject({ action: 'insert', oldCents: null, newCents: 5000 });
    expect(actionOf('NJ', 'E02')).toMatchObject({ action: 'unchanged', oldCents: -1000, newCents: -1000 });
    // 源行可追溯:扁平模板第 2 行起
    expect(actionOf('SH', 'I01')).toMatchObject({ sourceSheet: '实际数导入', sourceRow: 2 });
    expect(preview.summary).toMatchObject({
      schemaVersion: 1, kind: 'actual', source: 'standard', history: false,
      amountUnit: 'yuan', signConvention: 'profit_direction',
      updatesCurrent: true, createsSnapshot: true,
      comparisonBasis: 'actual_current', resultLocation: 'actual_current_and_snapshot',
      actions: { insert: 1, overwrite: 1, clear: 1, unchanged: 1, noteChange: 1, excluded: 0, skipped: 0 },
      periods: [{ year: 2026, snapshotDate: '2026-06-30', entryCount: 5 }],
    });

    const batch = imports.createBatch(db, {
      kind: 'actual',
      originalName: 'actual.xlsx',
      file,
      payload: { history: false, note: 'Excel 导入', batches: resolved.batches.map((b) => ({ year: b.year, snapshotDate: b.snapshotDate, entries: b.entries })) },
      summary: { years: [2026], count: 5, history: false },
      preview,
    });
    expect(detailCount(db, batch.id)).toBe(5);

    imports.commitBatch(db, batch.id);
    const cell = (orgId: number, accountId: number) =>
      db.prepare('SELECT cumulative_amount_cents, memo FROM actual_current WHERE year=2026 AND org_id=? AND account_id=?').get(orgId, accountId) as { cumulative_amount_cents: number; memo: string } | undefined;
    expect(cell(fx.orgIds.shanghai, fx.accIds.incomeMain)?.cumulative_amount_cents).toBe(2000);
    expect(cell(fx.orgIds.shanghai, fx.accIds.costSub)).toBeUndefined(); // 清零即删除
    expect(cell(fx.orgIds.shanghai, fx.accIds.expenseAdmin)).toMatchObject({ cumulative_amount_cents: -800, memo: '改备注' });
    expect(cell(fx.orgIds.hangzhou, fx.accIds.incomeMain)?.cumulative_amount_cents).toBe(5000);
    expect(cell(fx.orgIds.nanjing, fx.accIds.expenseSales)?.cumulative_amount_cents).toBe(-1000);

    // 已提交明细保留供审计;提交后再改数据,读取仍返回冻结值
    expect(detailCount(db, batch.id)).toBe(5);
    actual.saveActual(db, {
      year: 2026, snapshotDate: '2026-06-30', source: 'manual', mode: 'upsert',
      entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '99' }],
    });
    const rows = imports.listBatchPreviewRows(db, batch.id, { orgId: fx.orgIds.shanghai });
    expect(rows.total).toBe(3);
    const income = rows.items.find((row) => row.accountCode === 'I01')!;
    expect(income).toMatchObject({ action: 'overwrite', oldCents: 1000, newCents: 2000, oldValue: '10.00', newValue: '20.00' });

    const detail = imports.getBatchDetail(db, batch.id);
    expect(detail.status).toBe('committed');
    expect(detail.detailCapability).toBe('frozen-detail');
    expect(detail.result).toMatchObject({ count: 5 });
    expect(detail.actions.rollback.allowed).toBe(true);
    // 提交后数据已被改动,撤销按既有口径拒绝;冻结明细作为审计仍保留
    expect(() => imports.rollbackBatch(db, batch.id)).toThrow(/已被修改/);
    expect(detailCount(db, batch.id)).toBe(5);
    db.close();
  });

  it('数量科目按缩放整数分类,负数量进警告;多年度多截止日按组冻结', async () => {
    const db = testDb();
    const fx = buildFixture(db);
    const quantityRoot = account.createAccount(db, { parentId: null, code: 'Q', name: '数量', type: 'quantity', unit: '吨' });
    const quantityLeaf = account.createAccount(db, { parentId: quantityRoot.id, code: 'Q01', name: '产量', type: 'quantity', unit: '吨' });
    actual.saveActual(db, {
      year: 2025, snapshotDate: '2025-06-30', source: 'manual', mode: 'upsert',
      entries: [{ orgId: fx.orgIds.shanghai, accountId: quantityLeaf.id, quantity: '12.5' }],
    });
    const file = await xlsx([{ name: '实际数导入', rows: [
      ACTUAL_HEADER,
      [2025, '2025-06-30', 'SH', 'Q01', '', '0', ''],      // 清零
      [2025, '2025-06-30', 'HZ', 'Q01', '', '-3.25', ''],  // 新增负数量
      [2026, '2026-03-31', 'SH', 'I01', '7.00', '', ''],   // 另一年度
    ] }]);
    const parsed = await io.parseActualImport(file, db);
    const resolved = io.resolveActualImport(db, parsed, false);
    const preview = buildStandardActualPreview(db, { history: false, batches: resolved.batches, source: 'standard' });

    expect(preview.summary.periods).toEqual([
      { year: 2025, snapshotDate: '2025-06-30', entryCount: 2 },
      { year: 2026, snapshotDate: '2026-03-31', entryCount: 1 },
    ]);
    expect(preview.summary.target.years).toEqual([2025, 2026]);
    const clearRow = preview.details.find((row) => row.orgCode === 'SH' && row.groupYear === 2025)!;
    expect(clearRow).toMatchObject({ action: 'clear', valueKind: 'quantity', oldQuantity: 125000, newQuantity: 0 });
    expect(clearRow.warning).toContain('清零');
    const negativeRow = preview.details.find((row) => row.orgCode === 'HZ')!;
    expect(negativeRow).toMatchObject({ action: 'insert', oldQuantity: null, newQuantity: -32500 });
    expect(negativeRow.warning).toContain('数量为负值');
    const nextYear = preview.details.find((row) => row.groupYear === 2026)!;
    expect(nextYear).toMatchObject({ action: 'insert', groupDate: '2026-03-31', newCents: 700 });
    expect(preview.summary.actions).toMatchObject({ insert: 2, clear: 1 });
    db.close();
  });

  it('历史补录用同日历史快照作比较基线,不用当前累计推导覆盖或清零', async () => {
    const db = testDb();
    const fx = buildFixture(db);
    // 当前累计:SH/I01 = 100;同日(2025-03-31)历史快照:SH/I01 = 40、SH/E01 = 5
    actual.saveActual(db, {
      year: 2025, snapshotDate: '2025-06-30', source: 'manual', mode: 'upsert',
      entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '100' }],
    });
    actual.saveActual(db, {
      year: 2025, snapshotDate: '2025-03-31', source: 'manual', mode: 'upsert', history: true,
      entries: [
        { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '40' },
        { orgId: fx.orgIds.shanghai, accountId: fx.accIds.expenseAdmin, amount: '5' },
      ],
    });
    const file = await xlsx([{ name: '实际数导入', rows: [
      ACTUAL_HEADER,
      [2025, '2025-03-31', 'SH', 'I01', '40.00', '', ''],  // 与历史快照一致(若误用当前累计会判为覆盖)
      [2025, '2025-03-31', 'SH', 'E01', '0.00', '', ''],   // 从历史快照移除
      [2025, '2025-03-31', 'HZ', 'I01', '7.00', '', ''],   // 历史快照中没有,追加
    ] }]);
    const parsed = await io.parseActualImport(file, db);
    const resolved = io.resolveActualImport(db, parsed, true);
    const preview = buildStandardActualPreview(db, { history: true, batches: resolved.batches, source: 'standard' });

    expect(preview.summary).toMatchObject({
      history: true, updatesCurrent: false, createsSnapshot: true,
      comparisonBasis: 'history_snapshot', resultLocation: 'actual_history_snapshot',
      actions: { insert: 1, overwrite: 0, clear: 1, unchanged: 1, noteChange: 0, excluded: 0, skipped: 0 },
    });
    const actionOf = (orgCode: string, accountCode: string) =>
      preview.details.find((row) => row.orgCode === orgCode && row.accountCode === accountCode);
    expect(actionOf('SH', 'I01')).toMatchObject({ action: 'unchanged', oldCents: 4000, newCents: 4000 });
    expect(actionOf('SH', 'E01')).toMatchObject({ action: 'clear', oldCents: -500, newCents: 0 });
    expect(actionOf('HZ', 'I01')).toMatchObject({ action: 'insert', oldCents: null, newCents: 700 });

    const batch = imports.createBatch(db, {
      kind: 'actual', history: true,
      originalName: 'history.xlsx', file,
      payload: { history: true, note: '历史补录', batches: resolved.batches.map((b) => ({ year: b.year, snapshotDate: b.snapshotDate, entries: b.entries })) },
      summary: { years: [2025], count: 3, history: true },
      preview,
    });
    imports.commitBatch(db, batch.id);
    // 历史补录不更新当前累计,只追加历史快照
    expect((db.prepare('SELECT cumulative_amount_cents FROM actual_current WHERE year=2025 AND org_id=? AND account_id=?')
      .get(fx.orgIds.shanghai, fx.accIds.incomeMain) as { cumulative_amount_cents: number }).cumulative_amount_cents).toBe(10000);
    const historyBatch = db.prepare(
      "SELECT id FROM actual_snapshot_batch WHERE year=2025 AND snapshot_date='2025-03-31' AND updates_current=0 AND status='active'",
    ).get() as { id: number };
    const entries = db.prepare('SELECT org_id, account_id, cumulative_amount_cents FROM actual_snapshot_entry WHERE batch_id=? ORDER BY org_id, account_id')
      .all(historyBatch.id) as { org_id: number; account_id: number; cumulative_amount_cents: number }[];
    expect(entries).toEqual([
      { org_id: fx.orgIds.shanghai, account_id: fx.accIds.incomeMain, cumulative_amount_cents: 4000 },
      { org_id: fx.orgIds.hangzhou, account_id: fx.accIds.incomeMain, cumulative_amount_cents: 700 },
    ]);
    // 历史批次不允许撤销,详情接口如实标注
    const detail = imports.getBatchDetail(db, batch.id);
    expect(detail.history).toBe(true);
    expect(detail.actions.rollback).toMatchObject({ allowed: false });
    expect(detail.actions.rollback.reason).toContain('历史补录');
    db.close();
  });
});

describe('标准预算导入:精确差异分类与提交一致', () => {
  it('新增/覆盖/清零(删除)/不变/备注变更/数量分类正确,提交后落库一致', async () => {
    const db = testDb();
    const fx = buildFixture(db);
    const quantityRoot = account.createAccount(db, { parentId: null, code: 'Q', name: '数量', type: 'quantity', unit: '吨' });
    const quantityLeaf = account.createAccount(db, { parentId: quantityRoot.id, code: 'Q01', name: '产量', type: 'quantity', unit: '吨' });
    const version = budget.createVersion(db, { year: 2026, name: '导入预算' });
    budget.saveEntries(db, version.id, [
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '10' },
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.costSub, amount: '60', formula: '=5*12', note: '原依据' },
      { orgId: fx.orgIds.hangzhou, accountId: fx.accIds.expenseAdmin, amount: '20' },
    ]);
    const file = await xlsx([{ name: '预算导入', rows: [
      BUDGET_HEADER,
      ['SH', 'I01', '10.00', '', '新附注'],   // 值不变、附注变化 → note_change
      ['SH', 'C0101', '0.00', '', ''],        // 零值且无公式/附注 → 删除行
      ['HZ', 'E01', '25.00', '', ''],         // 覆盖
      ['NJ', 'I01', '5.00', '', ''],          // 新增
      ['SH', 'E02', '0.00', '', ''],          // 无旧值且零 → 不变(无操作)
      ['SH', 'Q01', '', '3.5', ''],           // 数量新增
    ] }]);
    const parsed = await io.parseBudgetImport(file);
    expect(parsed.ok).toBe(true);
    const entries = io.resolveBudgetImport(db, version.id, parsed);
    const preview = buildStandardBudgetPreview(db, version.id, entries, parsed.rows);

    const actionOf = (orgCode: string, accountCode: string) =>
      preview.details.find((row) => row.orgCode === orgCode && row.accountCode === accountCode);
    expect(actionOf('SH', 'I01')).toMatchObject({ action: 'note_change', oldCents: 1000, newCents: 1000, oldText: '', newText: '新附注', sourceRow: 2 });
    expect(actionOf('SH', 'C0101')).toMatchObject({ action: 'clear', oldCents: -6000, newCents: 0, oldFormula: '=5*12', oldText: '原依据' });
    expect(actionOf('SH', 'C0101')!.warning).toContain('删除');
    expect(actionOf('HZ', 'E01')).toMatchObject({ action: 'overwrite', oldCents: -2000, newCents: -2500 });
    expect(actionOf('NJ', 'I01')).toMatchObject({ action: 'insert', oldCents: null, newCents: 500 });
    expect(actionOf('SH', 'E02')).toMatchObject({ action: 'unchanged', oldCents: null, newCents: 0 });
    expect(actionOf('SH', 'Q01')).toMatchObject({ action: 'insert', valueKind: 'quantity', oldQuantity: null, newQuantity: 35000 });
    expect(preview.summary).toMatchObject({
      schemaVersion: 1, kind: 'budget', source: 'standard',
      target: { versionId: version.id, versionName: '导入预算', year: 2026 },
      updatesCurrent: false, createsSnapshot: false,
      comparisonBasis: 'budget_entry', resultLocation: 'budget_entry',
      actions: { insert: 2, overwrite: 1, clear: 1, unchanged: 1, noteChange: 1, excluded: 0, skipped: 0 },
      periods: [],
    });

    const batch = imports.createBatch(db, {
      kind: 'budget', targetVersionId: version.id,
      originalName: 'budget.xlsx', file,
      payload: { versionId: version.id, entries },
      summary: { versionId: version.id, count: entries.length },
      preview,
    });
    expect(detailCount(db, batch.id)).toBe(6);

    imports.commitBatch(db, batch.id);
    const cell = (orgId: number, accountId: number) =>
      db.prepare('SELECT amount_cents, quantity, formula, note FROM budget_entry WHERE version_id=? AND org_id=? AND account_id=?')
        .get(version.id, orgId, accountId) as { amount_cents: number; quantity: number | null; formula: string; note: string } | undefined;
    expect(cell(fx.orgIds.shanghai, fx.accIds.incomeMain)).toMatchObject({ amount_cents: 1000, note: '新附注' });
    expect(cell(fx.orgIds.shanghai, fx.accIds.costSub)).toBeUndefined(); // 删除
    expect(cell(fx.orgIds.hangzhou, fx.accIds.expenseAdmin)?.amount_cents).toBe(-2500);
    expect(cell(fx.orgIds.nanjing, fx.accIds.incomeMain)?.amount_cents).toBe(500);
    expect(cell(fx.orgIds.shanghai, fx.accIds.expenseSales)).toBeUndefined(); // 无操作
    expect(cell(fx.orgIds.shanghai, quantityLeaf.id)?.quantity).toBe(35000);

    // 冻结:提交后再改预算,明细仍返回创建时的值
    budget.saveEntries(db, version.id, [
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '11', note: '新附注' },
      { orgId: fx.orgIds.hangzhou, accountId: fx.accIds.expenseAdmin, amount: '25' },
      { orgId: fx.orgIds.nanjing, accountId: fx.accIds.incomeMain, amount: '5' },
      { orgId: fx.orgIds.shanghai, accountId: quantityLeaf.id, quantity: '3.5' },
    ]);
    const rows = imports.listBatchPreviewRows(db, batch.id, { action: 'note_change' });
    expect(rows.total).toBe(1);
    expect(rows.items[0]).toMatchObject({ orgCode: 'SH', accountCode: 'I01', oldCents: 1000, newCents: 1000, newText: '新附注' });
    const detail = imports.getBatchDetail(db, batch.id);
    expect(detail.target).toMatchObject({ versionId: version.id, versionName: '导入预算', year: 2026 });
    db.close();
  });
});

describe('批次详情降级与清理政策', () => {
  it('旧批次没有冻结明细时返回已有摘要并标注 legacy-summary', () => {
    const db = testDb();
    buildFixture(db);
    const legacy = imports.createBatch(db, {
      kind: 'actual', history: true,
      originalName: 'old.xlsx', file: Buffer.from('legacy'),
      payload: { history: true, note: '', batches: [{ year: 2025, snapshotDate: '2025-01-31', entries: [] }] },
      summary: { years: [2025], count: 0, history: true },
    });
    const detail = imports.getBatchDetail(db, legacy.id);
    expect(detail.detailCapability).toBe('legacy-summary');
    expect(detail.detailNote).toContain('启用前');
    expect(detail.preview).toBeNull();
    expect(detail.summary).toMatchObject({ years: [2025] });
    expect(detail.target.years).toEqual([2025]);
    expect(() => imports.listBatchPreviewRows(db, legacy.id)).toThrow(/启用前/);
    db.close();
  });

  it('取消与过期清理删除明细但保留批次摘要与审计,已提交审计不受影响', async () => {
    const db = testDb();
    const fx = buildFixture(db);
    const file = await xlsx([{ name: '实际数导入', rows: [ACTUAL_HEADER, [2026, '2026-06-30', 'SH', 'I01', '1.00', '', '']] }]);
    const buildBatch = () => {
      const parsed = io.parseActualImport(file, db);
      return parsed.then((p) => {
        const resolved = io.resolveActualImport(db, p, false);
        const preview = buildStandardActualPreview(db, { history: false, batches: resolved.batches, source: 'standard' });
        return imports.createBatch(db, {
          kind: 'actual', originalName: 'a.xlsx', file,
          payload: { history: false, note: '', batches: resolved.batches.map((b) => ({ year: b.year, snapshotDate: b.snapshotDate, entries: b.entries })) },
          summary: { years: [2026], count: 1, history: false },
          preview,
        });
      });
    };

    const cancelled = await buildBatch();
    expect(detailCount(db, cancelled.id)).toBe(1);
    imports.cancelBatch(db, cancelled.id);
    expect(detailCount(db, cancelled.id)).toBe(0);
    const cancelledDetail = imports.getBatchDetail(db, cancelled.id);
    expect(cancelledDetail.status).toBe('cancelled');
    expect(cancelledDetail.detailCapability).toBe('legacy-summary');
    expect(cancelledDetail.detailNote).toContain('取消或过期');
    expect(cancelledDetail.summary).toMatchObject({ years: [2026] }); // 摘要保留
    expect(cancelledDetail.actions.confirm).toMatchObject({ allowed: false });
    expect(() => imports.listBatchPreviewRows(db, cancelled.id)).toThrow(/取消或过期/);
    expect(db.prepare("SELECT 1 FROM operation_log WHERE action='import.cancel' AND entity_id=?").get(String(cancelled.id))).toBeDefined();

    const expired = await buildBatch();
    db.prepare('UPDATE import_batch SET created_at = ? WHERE id = ?').run(new Date(Date.now() - 8 * 24 * 3600 * 1000).toISOString(), expired.id);
    expect(imports.sweepExpiredPendingBatches(db)).toBe(1);
    expect(imports.getBatch(db, expired.id).status).toBe('cancelled');
    expect(detailCount(db, expired.id)).toBe(0);

    const committed = await buildBatch();
    imports.commitBatch(db, committed.id);
    expect(detailCount(db, committed.id)).toBe(1);
    expect((db.prepare('SELECT cumulative_amount_cents FROM actual_current WHERE year=2026 AND org_id=? AND account_id=?')
      .get(fx.orgIds.shanghai, fx.accIds.incomeMain) as { cumulative_amount_cents: number }).cumulative_amount_cents).toBe(100);
    db.close();
  });
});

describe('清洗与财务预览适配统一明细', () => {
  it('清洗预览差异写入 import_preview_detail,确认后保留、原确认语义不变', async () => {
    const db = testDb();
    const fx = buildFixture(db);
    const version = budget.createVersion(db, { year: 2026, name: '清洗适配预算' });
    budget.saveEntries(db, version.id, [
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.costSub, amount: '60', formula: '=5*12', note: '原依据' },
    ]);
    const file = await xlsx([{ name: '预算', rows: [
      ['组织', '科目', '金额', '备注'],
      ['SH', 'C0101', '0', ''],
      ['NJ', 'I01', '100', '新增'],
    ] }]);
    const plan = cleaningPlan({
      targetKind: 'budget', sheets: [{ sheetName: '预算', headerRow: 1, dataStartRow: 2, dataEndRow: 3 }],
      columns: [{ sourceColumn: 1, field: 'orgCode' }, { sourceColumn: 2, field: 'accountCode' }, { sourceColumn: 3, field: 'amount' }, { sourceColumn: 4, field: 'note' }],
      valueKind: 'amount',
    });
    const analysis = applyCleaningPlan(db, await loadCleaningWorkbook(file), { targetKind: 'budget', versionId: version.id }, plan);
    const pending = createPendingCleaningPreview(db, { analysis, originalName: 'clean.xlsx', file });
    expect((pending.summary as { actions: unknown }).actions).toMatchObject({ insert: 1, clear: 1 });

    const detailRows = db.prepare('SELECT * FROM import_preview_detail WHERE import_batch_id=? ORDER BY id').all(pending.importBatchId) as {
      org_code: string; account_code: string; action: string; old_cents: number | null; new_cents: number | null; source_sheet: string; source_row: number;
    }[];
    expect(detailRows).toHaveLength(2);
    expect(detailRows[0]).toMatchObject({ org_code: 'SH', account_code: 'C0101', action: 'clear', old_cents: -6000, new_cents: 0, source_sheet: '预算', source_row: 2 });
    expect(detailRows[1]).toMatchObject({ org_code: 'NJ', account_code: 'I01', action: 'insert', old_cents: null, new_cents: 10000, source_row: 3 });

    const frozen = JSON.parse(imports.getBatch(db, pending.importBatchId).summary_json) as { unifiedPreview?: { source: string; kind: string; actions: Record<string, number> } };
    expect(frozen.unifiedPreview).toMatchObject({ source: 'cleaning', kind: 'budget', actions: { insert: 1, clear: 1 } });

    imports.commitBatch(db, pending.importBatchId);
    expect(detailCount(db, pending.importBatchId)).toBe(2); // 已提交明细保留
    expect((db.prepare('SELECT COUNT(*) AS count FROM import_cleaning_preview_row WHERE import_batch_id=?').get(pending.importBatchId) as { count: number }).count).toBe(0);
    const rows = imports.listBatchPreviewRows(db, pending.importBatchId, { action: 'clear' });
    expect(rows.total).toBe(1);
    expect(rows.items[0]).toMatchObject({ orgCode: 'SH', accountCode: 'C0101', oldValue: '-60.00', newValue: '0.00' });
    db.close();
  });

  it('财务转换预览复用同一构建器,明细动作与 added/modified/cleared 一致', async () => {
    const db = testDb();
    const fx = buildFixture(db);
    const profile = createSourceProfile(db, {
      code: 'FIXED', name: '固定财务系统',
      config: { balanceSheetNames: ['科目余额表'], profitSheetNames: ['利润表'], ownedOrgCodes: ['EAST'], ownedAccountCodes: ['I', 'C', 'E'], amountUnit: 'yuan' },
    });
    const mapping = createMappingVersion(db, { sourceProfileId: profile.id, name: '映射' });
    replaceOrgMappings(db, mapping.id, [{ sourceBookCode: 'BOOK1', sourceOrgCode: 'S001', targetOrgId: fx.orgIds.shanghai, priority: 10, note: '' }]);
    replaceAccountMappings(db, mapping.id, [
      { sourceAccountCode: '4001', targetAccountId: fx.accIds.incomeMain, amountRule: 'credit_minus_debit', allocationMethod: 'direct', allocationWeight: 1000000, note: '' },
      { sourceAccountCode: '5001', targetAccountId: fx.accIds.costSub, amountRule: 'debit_minus_credit', allocationMethod: 'direct', allocationWeight: 1000000, note: '' },
      { sourceAccountCode: '6601', targetAccountId: fx.accIds.expenseAdmin, amountRule: 'debit_minus_credit', allocationMethod: 'direct', allocationWeight: 1000000, note: '' },
    ]);
    replaceReconciliationRules(db, mapping.id, [
      { sourceLineAlias: '营业收入', targetType: 'account', targetCode: 'I' },
      { sourceLineAlias: '营业成本', targetType: 'account', targetCode: 'C' },
      { sourceLineAlias: '期间费用', targetType: 'account', targetCode: 'E' },
      { sourceLineAlias: '净利润', targetType: 'metric', targetCode: 'OP' },
    ]);
    expect(validateMappingVersion(db, mapping.id)).toEqual({ passed: true, errors: [] });
    const locked = lockMappingVersion(db, mapping.id, 'reviewer');

    const balanceWb = new ExcelJS.Workbook();
    const balanceSheet = balanceWb.addWorksheet('科目余额表');
    balanceSheet.addRow(['账套编码', '组织编码', '组织名称', '科目编码', '科目名称', '本年累计借方', '本年累计贷方', '年度', '截止日期', '项目']);
    balanceSheet.addRow(['BOOK1', 'S001', '上海', '4001', '主营收入', 0, 100, 2026, '2026-06-30', '']);
    balanceSheet.addRow(['BOOK1', 'S001', '上海', '5001', '主营成本', 60, 0, 2026, '2026-06-30', '']);
    balanceSheet.addRow(['BOOK1', 'S001', '上海', '6601', '期间费用', 10, 0, 2026, '2026-06-30', '']);
    const profitWb = new ExcelJS.Workbook();
    const profitSheet = profitWb.addWorksheet('利润表');
    profitSheet.addRow(['项目', '本年累计金额', '年度', '截止日期']);
    profitSheet.addRow(['营业收入', 100, 2026, '2026-06-30']);
    profitSheet.addRow(['营业成本', 60, 2026, '2026-06-30']);
    profitSheet.addRow(['期间费用', 10, 2026, '2026-06-30']);
    profitSheet.addRow(['净利润', 30, 2026, '2026-06-30']);

    const conversion = await createConversion(db, {
      sourceProfileId: profile.id, mappingVersionId: locked.id, year: 2026, snapshotDate: '2026-06-30',
      balanceName: 'b.xlsx', balance: Buffer.from(await balanceWb.xlsx.writeBuffer()),
      profitName: 'p.xlsx', profit: Buffer.from(await profitWb.xlsx.writeBuffer()),
    });
    expect(conversion.status).toBe('validated');
    const preview = await createImportPreview(db, conversion.id);
    // 拥有范围(华东 × I/C/E)完整输出含显式零;无旧值时非零为新增、显式零为不变
    expect(preview.added).toBe(3);
    expect(preview.modified).toBe(0);
    expect(preview.cleared).toBe(0);

    const detailRows = db.prepare('SELECT action, old_cents, new_cents, group_year, group_date FROM import_preview_detail WHERE import_batch_id=?').all(preview.importBatchId) as {
      action: string; old_cents: number | null; new_cents: number | null; group_year: number; group_date: string;
    }[];
    expect(detailRows).toHaveLength(preview.count);
    expect(detailRows.filter((row) => row.action === 'insert')).toHaveLength(3);
    expect(detailRows.every((row) => row.group_year === 2026 && row.group_date === '2026-06-30')).toBe(true);
    const batchDetail = imports.getBatchDetail(db, preview.importBatchId);
    expect(batchDetail.preview).toMatchObject({
      source: 'finance', kind: 'actual', comparisonBasis: 'actual_current',
      actions: { insert: 3, overwrite: 0, clear: 0 },
      periods: [{ year: 2026, snapshotDate: '2026-06-30', entryCount: preview.count }],
    });
    db.close();
  });
});

describe('批次详情与冻结明细 HTTP 契约', () => {
  const tempDirs: string[] = [];
  afterEach(() => {
    while (tempDirs.length) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  });

  it('创建预览→只读详情→分页明细→确认→结果与冻结读取全链路', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'import-detail-http-'));
    tempDirs.push(dir);
    const { app, holder } = await createApp({ dbPath: path.join(dir, 'newfc.sqlite'), auth: { username: '', password: '' } });
    const fx = buildFixture(holder.getDb());
    const version = budget.createVersion(holder.getDb(), { year: 2026, name: 'HTTP 导入预算' });
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
    try {
      // 标准预算导入创建预览,响应携带冻结的统一摘要
      const budgetFile = await xlsx([{ name: '预算导入', rows: [BUDGET_HEADER, ['SH', 'I01', '10.00', '', ''], ['HZ', 'I01', '5.00', '', '']] }]);
      const budgetForm = new FormData();
      budgetForm.append('versionId', String(version.id));
      budgetForm.append('file', new Blob([budgetFile]), '预算.xlsx');
      const budgetPreviewResponse = await fetch(`${base}/io/budget/import`, { method: 'POST', body: budgetForm });
      expect(budgetPreviewResponse.status).toBe(200);
      const budgetPreview = await budgetPreviewResponse.json() as {
        importBatchId: number; unifiedPreview: { source: string; actions: Record<string, number> };
      };
      expect(budgetPreview.unifiedPreview).toMatchObject({ source: 'standard', actions: { insert: 2 } });

      // 只读详情:状态、目标、允许动作;不含文件正文或可重放 payload
      const detailResponse = await fetch(`${base}/io/import-batches/${budgetPreview.importBatchId}`);
      expect(detailResponse.status).toBe(200);
      const detail = await detailResponse.json() as Record<string, unknown> & {
        status: string; detailCapability: string; target: { versionId: number; versionName: string };
        actions: { confirm: { allowed: boolean }; cancel: { allowed: boolean }; rollback: { allowed: boolean; reason?: string } };
      };
      expect(detail.status).toBe('pending');
      expect(detail.detailCapability).toBe('frozen-detail');
      expect(detail.target).toMatchObject({ versionId: version.id, versionName: 'HTTP 导入预算' });
      expect(detail.actions).toMatchObject({ confirm: { allowed: true }, cancel: { allowed: true }, rollback: { allowed: false } });
      expect(detail).not.toHaveProperty('fileBlob');
      expect(detail).not.toHaveProperty('payload');

      // 分页明细:动作与组织筛选、分页键
      const rowsPage = await (await fetch(`${base}/io/import-batches/${budgetPreview.importBatchId}/preview-rows?page=1&pageSize=1`)).json() as { total: number; items: unknown[] };
      expect(rowsPage.total).toBe(2);
      expect(rowsPage.items).toHaveLength(1);
      const shRows = await (await fetch(`${base}/io/import-batches/${budgetPreview.importBatchId}/preview-rows?orgId=${fx.orgIds.shanghai}`)).json() as { total: number; items: { orgCode: string }[] };
      expect(shRows.total).toBe(1);
      expect(shRows.items[0].orgCode).toBe('SH');
      const warnRows = await (await fetch(`${base}/io/import-batches/${budgetPreview.importBatchId}/preview-rows?warningOnly=1`)).json() as { total: number };
      expect(warnRows.total).toBe(0);
      const badAction = await fetch(`${base}/io/import-batches/${budgetPreview.importBatchId}/preview-rows?action=bogus`);
      expect(badAction.status).toBe(400);
      const badId = await fetch(`${base}/io/import-batches/abc`);
      expect(badId.status).toBe(400);
      const missing = await fetch(`${base}/io/import-batches/999999`);
      expect(missing.status).toBe(404);

      // 确认只发送批次 ID;结果与冻结明细仍可读
      const confirmResponse = await fetch(`${base}/io/import-batches/${budgetPreview.importBatchId}/confirm`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      expect(confirmResponse.status).toBe(200);
      const committedDetail = await (await fetch(`${base}/io/import-batches/${budgetPreview.importBatchId}`)).json() as {
        status: string; result: { saved: number }; actions: { rollback: { allowed: boolean } };
      };
      expect(committedDetail.status).toBe('committed');
      expect(committedDetail.result.saved).toBe(2);
      expect(committedDetail.actions.rollback.allowed).toBe(true);
      const afterRows = await fetch(`${base}/io/import-batches/${budgetPreview.importBatchId}/preview-rows`);
      expect(afterRows.status).toBe(200);
      const source = await fetch(`${base}/io/import-batches/${budgetPreview.importBatchId}/source`);
      expect(source.status).toBe(200); // 既有 source 路由不受新路由影响

      // 标准实际导入(多年度):摘要按组冻结,确认后结果可读
      const actualFile = await xlsx([{ name: '实际数导入', rows: [
        ACTUAL_HEADER,
        [2025, '2025-12-31', 'SH', 'I01', '3.00', '', ''],
        [2026, '2026-06-30', 'SH', 'I01', '6.00', '', ''],
      ] }]);
      const actualForm = new FormData();
      actualForm.append('file', new Blob([actualFile]), '实际.xlsx');
      const actualPreviewResponse = await fetch(`${base}/io/actual/import`, { method: 'POST', body: actualForm });
      expect(actualPreviewResponse.status).toBe(200);
      const actualPreview = await actualPreviewResponse.json() as {
        importBatchId: number; unifiedPreview: { periods: { year: number; snapshotDate: string }[]; actions: Record<string, number> };
      };
      expect(actualPreview.unifiedPreview.periods).toEqual([
        { year: 2025, snapshotDate: '2025-12-31', entryCount: 1 },
        { year: 2026, snapshotDate: '2026-06-30', entryCount: 1 },
      ]);
      expect(actualPreview.unifiedPreview.actions.insert).toBe(2);
      const actualDetail = await (await fetch(`${base}/io/import-batches/${actualPreview.importBatchId}`)).json() as {
        target: { years: number[]; periods: unknown[] };
      };
      expect(actualDetail.target.years).toEqual([2025, 2026]);
      expect(actualDetail.target.periods).toHaveLength(2);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      holder.getDb().close();
    }
  });
});
