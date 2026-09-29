import { afterEach, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { testDb, buildFixture, standardBudgetVersion, account, budget, actual, type Fixture } from './helpers';
import { openDatabase, type DB } from '../src/db/connection';
import { AppError } from '../src/core/errors';
import { MIGRATIONS, applyMigrations } from '../src/db/migrations';
import * as io from '../src/modules/io/excel';
import * as imports from '../src/modules/import/import.service';
import { buildStandardActualPreview, buildStandardBudgetPreview } from '../src/modules/import/preview-detail';
import { createApp } from '../src/server';

/**
 * UX-29 跨模块契约与回归夹具:保存、预览、确认、恢复的组合场景。
 *
 * 单项机制由各专项文件覆盖(version-confirm-ux07 / actual-save-receipt /
 * import-preview-detail / cleaning-reopen / finance-import);本文件只补
 * 跨模块组合断言:确认前基线改变后旧预览的整体结局、回执与快照的联合一致性、
 * 同日历史快照的合并语义、混合数量与金额的存储隔离、汇总备注删除与编制记录的
 * 差异联动、旧批次降级链路,以及 V35 旧库迁移到 V38 的数据保留与三类新表结构。
 *
 * 所有用例使用内存库或临时目录,不触碰 backend/data/。
 */

const ACTUAL_HEADER = ['年度', '截止日期', '组织编码', '科目编码', '累计金额(元)', '累计数量', '备注'];
const BUDGET_HEADER = ['组织编码', '科目编码', '金额(元)', '数量', '备注'];

async function xlsx(sheets: { name: string; rows: unknown[][] }[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  for (const definition of sheets) {
    const sheet = workbook.addWorksheet(definition.name);
    for (const row of definition.rows) sheet.addRow(row);
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function detailCount(db: DB, batchId: number): number {
  return (db.prepare('SELECT COUNT(*) AS count FROM import_preview_detail WHERE import_batch_id = ?').get(batchId) as { count: number }).count;
}

function snapshotBatchCount(db: DB, year: number): number {
  return (db.prepare('SELECT COUNT(*) AS count FROM actual_snapshot_batch WHERE year = ?').get(year) as { count: number }).count;
}

function currentCents(db: DB, year: number, orgId: number, accountId: number): number | undefined {
  const row = db.prepare('SELECT cumulative_amount_cents FROM actual_current WHERE year=? AND org_id=? AND account_id=?')
    .get(year, orgId, accountId) as { cumulative_amount_cents: number } | undefined;
  return row?.cumulative_amount_cents;
}

/** 标准实际导入:文件 → 解析 → 预览冻结 → 待确认批次 */
async function createActualPreviewBatch(db: DB, file: Buffer, history: boolean, originalName = 'actual.xlsx') {
  const parsed = await io.parseActualImport(file, db);
  expect(parsed.ok).toBe(true);
  const resolved = io.resolveActualImport(db, parsed, history);
  const preview = buildStandardActualPreview(db, { history, batches: resolved.batches, source: 'standard' });
  const batch = imports.createBatch(db, {
    kind: 'actual',
    history,
    originalName,
    file,
    payload: { history, note: 'Excel 导入', batches: resolved.batches.map((b) => ({ year: b.year, snapshotDate: b.snapshotDate, entries: b.entries })) },
    summary: { years: resolved.batches.map((b) => b.year), count: resolved.batches.reduce((sum, b) => sum + b.entries.length, 0), history },
    preview,
  });
  return { batch, preview, resolved };
}

/** 标准预算导入:文件 → 解析 → 预览冻结 → 待确认批次 */
async function createBudgetPreviewBatch(db: DB, versionId: number, file: Buffer, originalName = 'budget.xlsx') {
  const parsed = await io.parseBudgetImport(file);
  expect(parsed.ok).toBe(true);
  const entries = io.resolveBudgetImport(db, versionId, parsed);
  const preview = buildStandardBudgetPreview(db, versionId, entries, parsed.rows);
  const batch = imports.createBatch(db, {
    kind: 'budget',
    targetVersionId: versionId,
    originalName,
    file,
    payload: { versionId, entries },
    summary: { versionId, count: entries.length },
    preview,
  });
  return { batch, preview, entries };
}

describe('确认导入前基线改变 → 旧预览被拒绝(组合)', () => {
  it('预算:预览后整包基线任何改动(包括未命中格)都使确认 409,批次与冻结明细保留,重新预览后可确认', async () => {
    const db = testDb();
    const fx = buildFixture(db);
    const version = standardBudgetVersion(fx); // SH: 100/60/20;HZ: 50/30/10
    const file = await xlsx([{ name: '预算导入', rows: [
      BUDGET_HEADER,
      ['SH', 'I01', '120.00', '', ''], // 覆盖
      ['NJ', 'I01', '5.00', '', ''],   // 新增
    ] }]);
    const { batch } = await createBudgetPreviewBatch(db, version.id, file);
    expect(detailCount(db, batch.id)).toBe(2);

    // 确认前另一会话修改了未被本批命中的格子(HZ/C0101 30→31):
    // 基线是整版快照,任何并发改动都必须使旧预览失效(否则整包替换会误删该改动)
    const matrix = budget.getEditMatrix(db, version.id);
    const full = matrix.entries.map((entry) => ({
      orgId: entry.orgId,
      accountId: entry.accountId,
      amount: entry.quantity == null ? entry.amountDisplay : undefined,
      quantity: entry.quantity ?? undefined,
      formula: entry.formula,
      note: entry.note,
    }));
    full.find((entry) => entry.orgId === fx.orgIds.hangzhou && entry.accountId === fx.accIds.costSub)!.amount = '31.00';
    budget.saveEntries(db, version.id, full);

    let caught: unknown;
    try {
      imports.commitBatch(db, batch.id);
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).status).toBe(409);
    expect((caught as AppError).message).toMatch(/预览后版本已有其他改动/);

    // 组合断言:确认被拒不留下部分状态——批次仍待确认、冻结明细未被销毁、
    // 手工改动保留、导入内容未写入
    expect(imports.getBatch(db, batch.id).status).toBe('pending');
    expect(detailCount(db, batch.id)).toBe(2);
    const cell = (orgId: number, accountId: number) =>
      db.prepare('SELECT amount_cents FROM budget_entry WHERE version_id=? AND org_id=? AND account_id=?')
        .get(version.id, orgId, accountId) as { amount_cents: number } | undefined;
    expect(cell(fx.orgIds.hangzhou, fx.accIds.costSub)?.amount_cents).toBe(-3100); // 手工改动在
    expect(cell(fx.orgIds.shanghai, fx.accIds.incomeMain)?.amount_cents).toBe(10000); // 导入未生效
    expect(cell(fx.orgIds.nanjing, fx.accIds.incomeMain)).toBeUndefined();

    // 旧预览不能跳过检查:只能取消后按最新数据重新预览,新预览确认成功
    imports.cancelBatch(db, batch.id);
    const fresh = await createBudgetPreviewBatch(db, version.id, file, 'budget-retry.xlsx');
    imports.commitBatch(db, fresh.batch.id);
    expect(cell(fx.orgIds.shanghai, fx.accIds.incomeMain)?.amount_cents).toBe(12000);
    expect(cell(fx.orgIds.nanjing, fx.accIds.incomeMain)?.amount_cents).toBe(500);
    expect(cell(fx.orgIds.hangzhou, fx.accIds.costSub)?.amount_cents).toBe(-3100); // 手工改动被合并保留
    db.close();
  });

  it('当前实际:预览后命中格被其他保存修改,确认 409 且不产生新快照;未命中格的演进不阻断', async () => {
    const db = testDb();
    const fx = buildFixture(db);
    actual.saveActual(db, {
      year: 2026, snapshotDate: '2026-03-31', source: 'manual', mode: 'replace',
      entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '10.00' }],
    });
    const file = await xlsx([{ name: '实际数导入', rows: [
      ACTUAL_HEADER,
      [2026, '2026-06-30', 'SH', 'I01', '20.00', '', ''],
    ] }]);
    const { batch } = await createActualPreviewBatch(db, file, false);

    // 确认前命中格被另一保存改掉
    actual.saveActual(db, {
      year: 2026, snapshotDate: '2026-04-30', source: 'manual', mode: 'replace',
      expectedCurrentBatchId: actual.getYearState(db, 2026)!.current_batch_id,
      entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '15.00' }],
    });
    const batchesBefore = snapshotBatchCount(db, 2026);
    expect(() => imports.commitBatch(db, batch.id)).toThrow(/预览后命中单元格已被修改/);
    expect(imports.getBatch(db, batch.id).status).toBe('pending');
    expect(detailCount(db, batch.id)).toBe(1);
    expect(snapshotBatchCount(db, 2026)).toBe(batchesBefore); // 拒绝确认不产生导入快照
    expect(currentCents(db, 2026, fx.orgIds.shanghai, fx.accIds.incomeMain)).toBe(1500);
    // 冻结明细仍是创建时差异(旧 10 元 → 新 20 元),不随当前数据漂移
    const rows = imports.listBatchPreviewRows(db, batch.id);
    expect(rows.items[0]).toMatchObject({ action: 'overwrite', oldCents: 1000, newCents: 2000 });

    // 旧预览取消后按最新数据重新预览;此后未命中格(HZ)演进不再阻断确认
    imports.cancelBatch(db, batch.id);
    const fresh = await createActualPreviewBatch(db, file, false, 'actual-retry.xlsx');
    actual.saveActual(db, {
      year: 2026, snapshotDate: '2026-05-31', source: 'manual', mode: 'upsert',
      entries: [{ orgId: fx.orgIds.hangzhou, accountId: fx.accIds.incomeMain, amount: '7.00' }],
    });
    imports.commitBatch(db, fresh.batch.id);
    expect(currentCents(db, 2026, fx.orgIds.shanghai, fx.accIds.incomeMain)).toBe(2000);
    expect(currentCents(db, 2026, fx.orgIds.hangzhou, fx.accIds.incomeMain)).toBe(700); // 未命中格保留
    db.close();
  });

  it('历史补录:预览基线显式为 null,当前累计变化不阻断确认,且不更新当前累计', async () => {
    const db = testDb();
    const fx = buildFixture(db);
    actual.saveActual(db, {
      year: 2026, snapshotDate: '2026-06-30', source: 'manual', mode: 'replace',
      entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '100.00' }],
    });
    const file = await xlsx([{ name: '实际数导入', rows: [
      ACTUAL_HEADER,
      [2026, '2026-03-31', 'SH', 'I01', '40.00', '', ''],
    ] }]);
    const { batch, preview } = await createActualPreviewBatch(db, file, true);
    expect(preview.summary).toMatchObject({ history: true, updatesCurrent: false, comparisonBasis: 'history_snapshot' });

    // 预览后当前累计继续演进:历史补录的比较基线是同日历史快照,不是当前累计
    actual.saveActual(db, {
      year: 2026, snapshotDate: '2026-07-31', source: 'manual', mode: 'replace',
      expectedCurrentBatchId: actual.getYearState(db, 2026)!.current_batch_id,
      entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '120.00' }],
    });
    imports.commitBatch(db, batch.id);
    expect(imports.getBatch(db, batch.id).status).toBe('committed');
    expect(currentCents(db, 2026, fx.orgIds.shanghai, fx.accIds.incomeMain)).toBe(12000); // 当前累计不动
    const historyBatch = db.prepare(
      "SELECT id FROM actual_snapshot_batch WHERE year=2026 AND snapshot_date='2026-03-31' AND updates_current=0 AND status='active'",
    ).get() as { id: number };
    expect(actual.getBatchEntries(db, historyBatch.id)).toEqual([
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amountCents: 4000, quantity: null },
    ]);
    db.close();
  });
});

describe('保存响应丢失 → 回执核对 → 同编号重试(联合断言)', () => {
  const REQ = 'aaaaaaaa-0000-4000-8000-000000000001';

  it('回执与实际快照/年度状态同源一致:重试只有一个快照、一条回执、一次写入', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const input = {
      year: 2026, snapshotDate: '2026-03-31',
      entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '100.00' }],
      source: 'manual' as const, mode: 'replace' as const, expectedCurrentBatchId: null, requestId: REQ,
    };
    const first = actual.saveActual(db, input);
    expect(first.replayed).toBe(false);

    // 模拟提交成功但响应丢失:先查回执确认是否已提交
    const receipt = actual.getSaveReceipt(db, REQ);
    expect(receipt).toBeDefined();
    // 联合断言:回执指向的快照批次就是年度当前批次,且内容与提交一致
    expect(actual.getYearState(db, 2026)!.current_batch_id).toBe(receipt!.batchId);
    expect(receipt!.batchId).toBe(first.batchId);
    const batchRow = actual.getBatch(db, receipt!.batchId);
    expect(batchRow).toMatchObject({ year: 2026, snapshot_date: '2026-03-31', status: 'active', updates_current: 1, source: 'manual' });
    expect(actual.getBatchEntries(db, receipt!.batchId)).toEqual([
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amountCents: 10000, quantity: null },
    ]);
    expect(receipt!.result).toMatchObject({ batchId: first.batchId, saved: 1, deleted: 0 });

    // 同编号同内容重试:只读回执返回,不重复生成快照/回执/写入
    const retry = actual.saveActual(db, input);
    expect(retry.replayed).toBe(true);
    expect(retry.batchId).toBe(first.batchId);
    expect(snapshotBatchCount(db, 2026)).toBe(1);
    expect((db.prepare('SELECT COUNT(*) AS count FROM actual_save_receipt').get() as { count: number }).count).toBe(1);
    expect(currentCents(db, 2026, fx.orgIds.shanghai, fx.accIds.incomeMain)).toBe(10000);
    db.close();
  });
});

describe('历史补录与同日历史快照的合并语义(组合)', () => {
  it('同日历史增量与同日历史快照合并(不是与当前累计合并);当前批次不被历史修订替代', () => {
    const db = testDb();
    const fx = buildFixture(db);
    // 当前累计:2026-06-30 SH/I01=100(updates_current=1)
    const current = actual.saveActual(db, {
      year: 2026, snapshotDate: '2026-06-30', source: 'manual', mode: 'replace',
      entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '100.00' }],
    });
    // 历史补录一:2026-03-31 SH/I01=40
    const history1 = actual.saveActual(db, {
      year: 2026, snapshotDate: '2026-03-31', source: 'manual', mode: 'replace', history: true,
      entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '40.00' }],
    });
    // 历史补录二(同日增量):SH/E01=5 —— 应与同日历史快照(40)合并,而不是与当前累计(100)合并
    const history2 = actual.saveActual(db, {
      year: 2026, snapshotDate: '2026-03-31', source: 'manual', mode: 'upsert', history: true,
      entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.expenseAdmin, amount: '5.00' }],
    });

    // 合并结果:同日历史最新快照 = 40(来自历史一) + 5(新增);若误用当前累计会带出 100
    expect(actual.getBatchEntries(db, history2.batchId)).toEqual([
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amountCents: 4000, quantity: null },
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.expenseAdmin, amountCents: -500, quantity: null },
    ]);
    // 同日同类别替代:历史一被替代(superseded),当前批次不受影响
    expect(actual.getBatch(db, history1.batchId).status).toBe('superseded');
    expect(actual.getBatch(db, history2.batchId)).toMatchObject({ status: 'active', updates_current: 0, revision: 2 });
    expect(actual.getBatch(db, history1.batchId).revision).toBe(1);
    expect(actual.getBatch(db, current.batchId)).toMatchObject({ status: 'active', updates_current: 1 });
    // 历史补录不更新当前累计
    expect(actual.getYearState(db, 2026)!.current_batch_id).toBe(current.batchId);
    expect(currentCents(db, 2026, fx.orgIds.shanghai, fx.accIds.incomeMain)).toBe(10000);
    expect(currentCents(db, 2026, fx.orgIds.shanghai, fx.accIds.expenseAdmin)).toBeUndefined();
    db.close();
  });
});

describe('混合数量与金额的分类与精度(组合)', () => {
  it('同一导入批次内金额按整数分、数量按 10^4 缩放整数分别冻结与落库,互不混淆', async () => {
    const db = testDb();
    const fx = buildFixture(db);
    const quantityRoot = account.createAccount(db, { parentId: null, code: 'Q', name: '数量', type: 'quantity', unit: '吨' });
    const quantityLeaf = account.createAccount(db, { parentId: quantityRoot.id, code: 'Q01', name: '产量', type: 'quantity', unit: '吨' });
    const file = await xlsx([{ name: '实际数导入', rows: [
      ACTUAL_HEADER,
      [2026, '2026-06-30', 'SH', 'I01', '0.01', '', ''],   // 金额精度:1 分
      [2026, '2026-06-30', 'SH', 'Q01', '', '3.4567', ''], // 数量精度:4 位小数
    ] }]);
    const { batch, preview } = await createActualPreviewBatch(db, file, false);

    // 冻结明细:金额行只有分,数量行只有缩放整数,两个维度互不出现对方字段
    const amountRow = preview.details.find((row) => row.accountCode === 'I01')!;
    expect(amountRow).toMatchObject({ valueKind: 'amount', action: 'insert', newCents: 1, oldCents: null });
    expect(amountRow.newQuantity).toBeNull();
    const quantityRow = preview.details.find((row) => row.accountCode === 'Q01')!;
    expect(quantityRow).toMatchObject({ valueKind: 'quantity', action: 'insert', newQuantity: 34567, oldQuantity: null });
    expect(quantityRow.newCents).toBeNull();

    imports.commitBatch(db, batch.id);
    // 落库隔离:数量科目累计金额恒为 0,金额科目数量恒为 NULL
    const amountCell = db.prepare('SELECT cumulative_amount_cents, quantity FROM actual_current WHERE year=2026 AND org_id=? AND account_id=?')
      .get(fx.orgIds.shanghai, fx.accIds.incomeMain) as { cumulative_amount_cents: number; quantity: number | null };
    expect(amountCell).toEqual({ cumulative_amount_cents: 1, quantity: null });
    const quantityCell = db.prepare('SELECT cumulative_amount_cents, quantity FROM actual_current WHERE year=2026 AND org_id=? AND account_id=?')
      .get(fx.orgIds.shanghai, quantityLeaf.id) as { cumulative_amount_cents: number; quantity: number | null };
    expect(quantityCell).toEqual({ cumulative_amount_cents: 0, quantity: 34567 });
    // 快照与当前一致;界面矩阵按各自精度往返(数量不显示为 0.00 万元)
    const batchId = actual.getYearState(db, 2026)!.current_batch_id!;
    expect(actual.getBatchEntries(db, batchId)).toEqual([
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amountCents: 1, quantity: null },
      { orgId: fx.orgIds.shanghai, accountId: quantityLeaf.id, amountCents: 0, quantity: 34567 },
    ]);
    const matrix = actual.getActualMatrix(db, 2026);
    expect(matrix.entries.find((e) => e.accountId === fx.accIds.incomeMain)).toMatchObject({ amountDisplay: '0.01', quantity: null });
    expect(matrix.entries.find((e) => e.accountId === quantityLeaf.id)).toMatchObject({ amountDisplay: '', quantity: '3.4567' });
    db.close();
  });
});

describe('汇总备注删除意图经保存与编制记录的差异(组合)', () => {
  it('整包保存删除汇总备注后,下一记录点的差异如实呈现 删除前→删除后', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const version = budget.createVersion(db, { year: 2026, name: '备注删除' });
    const entries = [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '100.00' }];
    // 汇总格 = 非叶子组织 × 叶子科目
    budget.saveEntries(db, version.id, entries, undefined, [
      { orgId: fx.orgIds.east, accountId: fx.accIds.incomeMain, note: '季度汇总说明' },
    ]);
    const first = budget.recordCompilationCheckpoint(db, version.id, { title: '第一轮' });
    expect(first.created).toBe(true);
    const added = first.checkpoint!.changes.find((c) => c.orgId === fx.orgIds.east && c.accountId === fx.accIds.incomeMain)!;
    expect(added).toMatchObject({ kind: 'note', before: { note: '' }, after: { note: '季度汇总说明' } });

    // 删除意图:整包保存的 cellNotes 不再包含该格
    const saved = budget.saveEntries(db, version.id, entries, undefined, []);
    expect(saved.cellNotesDeleted).toBe(1);
    expect(budget.getEditMatrix(db, version.id).cellNotes).toEqual([]);

    // 第二记录点:删除本身是一处 note 差异(before 有值、after 为空),不会因为是删除而漏记
    const second = budget.recordCompilationCheckpoint(db, version.id, { title: '第二轮' });
    expect(second.created).toBe(true);
    const removed = second.checkpoint!.changes.find((c) => c.orgId === fx.orgIds.east && c.accountId === fx.accIds.incomeMain)!;
    expect(removed).toMatchObject({ kind: 'note', before: { note: '季度汇总说明', amountCents: 0 }, after: { note: '', amountCents: 0 } });
    // 第一记录点快照不可变:仍保留当时的备注内容
    const firstSnapshot = JSON.parse(
      (db.prepare('SELECT snapshot_json FROM budget_compilation_checkpoint WHERE id=?').get(first.checkpoint!.id) as { snapshot_json: string }).snapshot_json,
    ) as { orgId: number; accountId: number; note: string }[];
    expect(firstSnapshot.find((c) => c.orgId === fx.orgIds.east && c.accountId === fx.accIds.incomeMain)).toMatchObject({ note: '季度汇总说明' });
    db.close();
  });
});

describe('旧批次(无冻结明细)的降级说明链路(组合)', () => {
  it('能力启用前已提交的批次:详情降级为 legacy-summary,结果与撤销门禁仍可读,重新预览是获取逐行差异的唯一途径', async () => {
    const db = testDb();
    const fx = buildFixture(db);
    const file = await xlsx([{ name: '实际数导入', rows: [ACTUAL_HEADER, [2026, '2026-06-30', 'SH', 'I01', '1.00', '', '']] }]);
    const { batch } = await createActualPreviewBatch(db, file, false, 'old.xlsx');
    imports.commitBatch(db, batch.id);
    // 退化为 legacy:能力启用前的旧批次没有冻结明细与统一摘要
    db.prepare('DELETE FROM import_preview_detail WHERE import_batch_id = ?').run(batch.id);
    const summary = JSON.parse(imports.getBatch(db, batch.id).summary_json) as Record<string, unknown>;
    delete summary.unifiedPreview;
    db.prepare('UPDATE import_batch SET summary_json = ? WHERE id = ?').run(JSON.stringify(summary), batch.id);

    const detail = imports.getBatchDetail(db, batch.id);
    expect(detail.detailCapability).toBe('legacy-summary');
    expect(detail.detailNote).toContain('启用前');
    expect(detail.detailNote).toContain('重新预览');
    expect(detail.preview).toBeNull();
    // 降级只影响逐行明细:既有摘要、业务目标、提交结果与允许动作仍如实返回
    expect(detail.summary).toMatchObject({ years: [2026] });
    expect(detail.target.years).toEqual([2026]);
    expect(detail.status).toBe('committed');
    expect(detail.result).toMatchObject({ count: 1 });
    expect(detail.actions.confirm).toMatchObject({ allowed: false });
    expect(detail.actions.rollback.allowed).toBe(true);
    expect(() => imports.listBatchPreviewRows(db, batch.id)).toThrow(/启用前/);
    db.close();
  });
});

describe('V35 旧库迁移到最新(V38):数据保留与三类新表结构', () => {
  /** 与 defect-report-2026 / migration-rollback-and-latency 相同的迁移重放套路 */
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

  it('升级只补 V36/V37/V38;旧业务数据完整;三类新表列/约束/索引正确;迁移后新链路立即可用', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ux29-migration-'));
    const db = openDatabase(path.join(dir, 'budget.sqlite'));
    try {
      applyThrough(db, 35);
      // 旧库业务数据(raw SQL,V35 列集):主数据、树快照、预算明细、实际当前与快照、已提交导入批次
      db.prepare("INSERT INTO org (id, parent_id, code, name, sort_order, status, created_at, updated_at) VALUES (1, NULL, 'LEG', '旧集团', 0, 'active', '2026-01-01', '2026-01-01'), (2, 1, 'LP01', '旧一厂', 0, 'active', '2026-01-01', '2026-01-01')").run();
      db.prepare("INSERT INTO account (id, parent_id, code, name, type, sort_order, status, created_at, updated_at) VALUES (1, NULL, 'LI01', '旧收入', 'income', 0, 'active', '2026-01-01', '2026-01-01')").run();
      db.prepare("INSERT INTO tree_snapshot (id, tree_type, content_json, content_hash, created_at) VALUES (1, 'org', '{\"nodes\":[]}', 'h1', '2026-01-01'), (2, 'account', '{\"nodes\":[]}', 'h2', '2026-01-01')").run();
      db.prepare("INSERT INTO budget_version (id, year, name, status, is_current, org_tree_snapshot_id, account_tree_snapshot_id, note, created_at, updated_at) VALUES (1, 2026, '旧预算', 'draft', 0, 1, 2, '', '2026-01-01', '2026-01-01')").run();
      db.prepare("INSERT INTO budget_entry (version_id, org_id, account_id, amount_cents, quantity, formula, note, updated_at) VALUES (1, 2, 1, 12300, NULL, '', '旧附注', '2026-01-01')").run();
      db.prepare("INSERT INTO actual_snapshot_batch (id, year, snapshot_date, revision, status, source, org_tree_snapshot_id, account_tree_snapshot_id, updates_current, note, created_at) VALUES (1, 2026, '2026-06-30', 1, 'active', 'manual', 1, 2, 1, '旧快照', '2026-06-30')").run();
      db.prepare('INSERT INTO actual_snapshot_entry (batch_id, org_id, account_id, cumulative_amount_cents, quantity) VALUES (1, 2, 1, 45600, NULL)').run();
      db.prepare("INSERT INTO actual_current (year, org_id, account_id, cumulative_amount_cents, source, memo, updated_at) VALUES (2026, 2, 1, 45600, 'manual', '旧备注', '2026-06-30')").run();
      db.prepare("INSERT INTO actual_year_state (year, status, current_batch_id, updated_at) VALUES (2026, 'open', 1, '2026-06-30')").run();
      db.prepare(`INSERT INTO import_batch (id, kind, status, target_version_id, history, original_name, sha256, file_blob, payload_json, summary_json, result_json, created_at, committed_at)
        VALUES (1, 'actual', 'committed', NULL, 0, '旧导入.xlsx', '${'a'.repeat(64)}', X'00', '{}', '{"years":[2026],"count":1}', '{"count":1}', '2026-06-30', '2026-06-30')`).run();

      const applied = applyMigrations(db).map((migration) => migration.version);
      expect(applied).toEqual([36, 37, 38]);
      expect((db.prepare('SELECT MAX(version) AS v FROM schema_migration').get() as { v: number }).v)
        .toBe(Math.max(...MIGRATIONS.map((migration) => migration.version)));

      // 数据无丢失
      expect(db.prepare('SELECT amount_cents, note FROM budget_entry WHERE version_id=1').get()).toEqual({ amount_cents: 12300, note: '旧附注' });
      expect(db.prepare('SELECT cumulative_amount_cents, memo FROM actual_current WHERE year=2026').get()).toEqual({ cumulative_amount_cents: 45600, memo: '旧备注' });
      expect(db.prepare('SELECT cumulative_amount_cents FROM actual_snapshot_entry WHERE batch_id=1').get()).toEqual({ cumulative_amount_cents: 45600 });
      expect(db.prepare('SELECT status, original_name FROM import_batch WHERE id=1').get()).toEqual({ status: 'committed', original_name: '旧导入.xlsx' });

      // 三类新表结构
      const columnsOf = (table: string) => (db.pragma(`table_info(${table})`) as { name: string; pk: number }[]);
      const receiptCols = columnsOf('actual_save_receipt');
      expect(receiptCols.map((c) => c.name)).toEqual(['request_id', 'request_hash', 'year', 'batch_id', 'result_json', 'created_at']);
      expect(receiptCols.find((c) => c.name === 'request_id')!.pk).toBe(1);
      const detailCols = columnsOf('import_preview_detail').map((c) => c.name);
      for (const col of ['id', 'import_batch_id', 'group_year', 'group_date', 'source_sheet', 'source_row', 'org_id', 'org_code', 'account_id', 'account_code', 'value_kind', 'old_cents', 'new_cents', 'old_quantity', 'new_quantity', 'old_text', 'new_text', 'old_formula', 'new_formula', 'action', 'warning', 'created_at']) {
        expect(detailCols).toContain(col);
      }
      expect(columnsOf('cleaning_reopen_session').map((c) => c.name))
        .toEqual(['id', 'import_batch_id', 'upload_token', 'original_name', 'file_sha256', 'plan_json', 'target_json', 'created_at']);
      const indexNames = (table: string) => (db.pragma(`index_list(${table})`) as { name: string }[]).map((idx) => idx.name);
      expect(indexNames('actual_save_receipt')).toContain('idx_actual_save_receipt_year');
      expect(indexNames('import_preview_detail')).toEqual(expect.arrayContaining([
        'idx_import_preview_detail_batch', 'idx_import_preview_detail_action', 'idx_import_preview_detail_org',
      ]));

      // 约束真实生效:回执外键/年度 CHECK、明细动作枚举/外键、恢复会话唯一键/指纹长度
      expect(() => db.prepare("INSERT INTO actual_save_receipt (request_id, request_hash, year, batch_id, result_json, created_at) VALUES ('bad-year-01', 'h', 100, 1, '{}', '2026-01-01')").run()).toThrow();
      expect(() => db.prepare("INSERT INTO actual_save_receipt (request_id, request_hash, year, batch_id, result_json, created_at) VALUES ('bad-fk-0001', 'h', 2026, 999999, '{}', '2026-01-01')").run()).toThrow();
      expect(() => db.prepare("INSERT INTO import_preview_detail (import_batch_id, value_kind, action, created_at) VALUES (1, 'amount', 'bogus', '2026-01-01')").run()).toThrow();
      expect(() => db.prepare("INSERT INTO import_preview_detail (import_batch_id, value_kind, action, created_at) VALUES (999999, 'amount', 'insert', '2026-01-01')").run()).toThrow();
      expect(() => db.prepare("INSERT INTO cleaning_reopen_session (import_batch_id, upload_token, original_name, file_sha256, plan_json, target_json, created_at) VALUES (1, 't1', 'a.xlsx', 'short', '{}', '{}', '2026-01-01')").run()).toThrow();
      db.prepare(`INSERT INTO cleaning_reopen_session (import_batch_id, upload_token, original_name, file_sha256, plan_json, target_json, created_at) VALUES (1, 't1', 'a.xlsx', '${'b'.repeat(64)}', '{}', '{}', '2026-01-01')`).run();
      expect(() => db.prepare(`INSERT INTO cleaning_reopen_session (import_batch_id, upload_token, original_name, file_sha256, plan_json, target_json, created_at) VALUES (1, 't2', 'a.xlsx', '${'b'.repeat(64)}', '{}', '{}', '2026-01-01')`).run()).toThrow();

      // 迁移后新链路立即可用:回执保存与冻结明细在旧库升级来的库上正常工作
      const fx: Fixture = buildFixture(db);
      const REQ = 'cccccccc-0000-4000-8000-000000000002';
      const save = actual.saveActual(db, {
        year: 2026, snapshotDate: '2026-08-31',
        entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '7.00' }],
        source: 'manual', mode: 'upsert', requestId: REQ,
      });
      expect(actual.getSaveReceipt(db, REQ)).toMatchObject({ requestId: REQ, batchId: save.batchId });
      const file = await xlsx([{ name: '实际数导入', rows: [ACTUAL_HEADER, [2026, '2026-08-31', 'HZ', 'I01', '3.00', '', '']] }]);
      const { batch } = await createActualPreviewBatch(db, file, false);
      expect(detailCount(db, batch.id)).toBe(1);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

/* ---- HTTP 契约:条件定稿/采用的状态码与旧协议兼容 ---- */

let server: Server | undefined;
let httpDb: DB | undefined;

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  httpDb?.close();
  httpDb = undefined;
});

async function boot(): Promise<{ base: string; db: DB }> {
  const { app, holder } = await createApp({ dbPath: ':memory:', auth: { username: '', password: '' } });
  httpDb = holder.getDb();
  server = app.listen(0);
  await new Promise<void>((resolve) => server!.once('listening', () => resolve()));
  const port = (server!.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}/api`, db: httpDb };
}

const post = (base: string, pathName: string, body: unknown) =>
  fetch(`${base}${pathName}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

describe('条件定稿/采用 HTTP 契约(UX-07 组合)', () => {
  it('确认期间 revision 改变 → 409;旧调用(无 expectedRevision)保持直接定稿', async () => {
    const { base, db } = await boot();
    const fx = buildFixture(db);
    const version = standardBudgetVersion(fx);
    const revision = budget.getVersion(db, version.id).revision;

    // 确认期间草稿被再次保存,revision 前进 → 旧确认基线被拒
    budget.saveEntries(db, version.id, [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '200.00' }]);
    const stale = await post(base, `/versions/${version.id}/lock`, { expectedRevision: revision });
    expect(stale.status).toBe(409);
    const staleBody = (await stale.json()) as { code: string; message: string };
    expect(staleBody.code).toBe('CONFLICT');
    expect(staleBody.message).toMatch(/已被修改/);
    expect(budget.getVersion(db, version.id).status).toBe('draft');

    // 携带刷新后的修订可定稿;成功后版本只读
    const fresh = await post(base, `/versions/${version.id}/lock`, { expectedRevision: revision + 1 });
    expect(fresh.status).toBe(200);
    expect(budget.getVersion(db, version.id).status).toBe('locked');

    // 旧协议兼容:不带新字段的调用行为与旧版一致(直接定稿)
    const legacy = standardBudgetVersion(fx, 2026, '旧调用');
    const legacyLock = await post(base, `/versions/${legacy.id}/lock`, {});
    expect(legacyLock.status).toBe(200);
    expect(budget.getVersion(db, legacy.id).status).toBe('locked');
  });

  it('采用确认期间原当前版本变化 → 409;旧调用(无 expectedCurrentVersionId)保持直接设置', async () => {
    const { base, db } = await boot();
    const fx = buildFixture(db);
    const v1 = standardBudgetVersion(fx, 2026, 'V1');
    budget.lockVersion(db, v1.id);
    const v2 = standardBudgetVersion(fx, 2026, 'V2');
    budget.lockVersion(db, v2.id);

    // 确认方以为当前无采用版本(null),确认期间 v1 已被设为当前 → 409
    budget.setCurrentVersion(db, v1.id);
    const stale = await post(base, `/versions/${v2.id}/set-current`, { expectedCurrentVersionId: null });
    expect(stale.status).toBe(409);
    const staleBody = (await stale.json()) as { code: string; message: string };
    expect(staleBody.code).toBe('CONFLICT');
    expect(staleBody.message).toMatch(/原采用版本已变化/);
    expect(budget.getVersion(db, v1.id).is_current).toBe(1);
    expect(budget.getVersion(db, v2.id).is_current).toBe(0);

    // 携带刷新后的原采用版本可替换
    const fresh = await post(base, `/versions/${v2.id}/set-current`, { expectedCurrentVersionId: v1.id });
    expect(fresh.status).toBe(200);
    expect(budget.getVersion(db, v2.id).is_current).toBe(1);

    // 旧协议兼容:不带新字段直接设置
    const v3 = standardBudgetVersion(fx, 2026, 'V3');
    budget.lockVersion(db, v3.id);
    const legacy = await post(base, `/versions/${v3.id}/set-current`, {});
    expect(legacy.status).toBe(200);
    expect(budget.getVersion(db, v3.id).is_current).toBe(1);
    expect(budget.getVersion(db, v2.id).is_current).toBe(0);
  });

  it('实际保存旧协议兼容:不带 requestId 不去重、不写回执;带 requestId 才启用幂等', async () => {
    const { base, db } = await boot();
    const fx = buildFixture(db);
    const payload = {
      year: 2026, snapshotDate: '2026-03-31',
      entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '100.00' }],
    };
    const first = await post(base, '/actual/save', { ...payload, expectedCurrentBatchId: null });
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { batchId: number; replayed: boolean };
    expect(firstBody.replayed).toBe(false);

    // 旧行为:相同内容再次提交生成第二个快照(由客户端基线控制,不做回执去重)
    const second = await post(base, '/actual/save', { ...payload, expectedCurrentBatchId: firstBody.batchId });
    expect(second.status).toBe(200);
    const secondBody = (await second.json()) as { batchId: number };
    expect(secondBody.batchId).not.toBe(firstBody.batchId);
    expect(snapshotBatchCount(db, 2026)).toBe(2);
    expect((db.prepare('SELECT COUNT(*) AS count FROM actual_save_receipt').get() as { count: number }).count).toBe(0);
  });

  it('旧批次详情经 HTTP 降级可读:legacy-summary 标注能力范围,不暴露文件正文与 payload', async () => {
    const { base, db } = await boot();
    buildFixture(db);
    const file = await xlsx([{ name: '实际数导入', rows: [ACTUAL_HEADER, [2026, '2026-06-30', 'SH', 'I01', '1.00', '', '']] }]);
    const { batch } = await createActualPreviewBatch(db, file, false, 'legacy.xlsx');
    imports.commitBatch(db, batch.id);
    db.prepare('DELETE FROM import_preview_detail WHERE import_batch_id = ?').run(batch.id);
    const summary = JSON.parse(imports.getBatch(db, batch.id).summary_json) as Record<string, unknown>;
    delete summary.unifiedPreview;
    db.prepare('UPDATE import_batch SET summary_json = ? WHERE id = ?').run(JSON.stringify(summary), batch.id);

    const response = await fetch(`${base}/io/import-batches/${batch.id}`);
    expect(response.status).toBe(200);
    const detail = (await response.json()) as Record<string, unknown> & {
      detailCapability: string; detailNote: string; status: string;
    };
    expect(detail.detailCapability).toBe('legacy-summary');
    expect(detail.detailNote).toContain('启用前');
    expect(detail.status).toBe('committed');
    expect(detail).not.toHaveProperty('fileBlob');
    expect(detail).not.toHaveProperty('payload');
    const rows = await fetch(`${base}/io/import-batches/${batch.id}/preview-rows`);
    expect(rows.status).toBe(404);
    expect(((await rows.json()) as { message: string }).message).toContain('启用前');
  });
});
