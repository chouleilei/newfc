import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, authFetch } from './http-helpers';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { testDb, buildFixture, budget, account, org, actual } from './helpers';
import { loadCleaningWorkbook } from '../src/modules/io/cleaning/workbook';
import { assertSafeXlsx } from '../src/modules/io/xlsx-guard';
import { MAX_CLEANING_SHEETS } from '../src/modules/io/import-limits';
import { applyCleaningPlan } from '../src/modules/io/cleaning/apply';
import { createPendingCleaningPreview, listPreviewRows } from '../src/modules/io/cleaning/preview';
import type { CleaningPlan, CleaningTarget } from '../src/modules/io/cleaning/plan';
import * as imports from '../src/modules/import/import.service';
import * as templateService from '../src/modules/io/cleaning/template.service';
import * as aliasService from '../src/modules/io/cleaning/alias.service';
import { CleaningUploadStore } from '../src/modules/io/cleaning/upload-store';
import { sanitizeAiSuggestion, suggestCleaningStructure } from '../src/modules/io/cleaning/suggest';
import { inspectWorkbook } from '../src/modules/io/cleaning/workbook';
import * as profiles from '../src/modules/finance-import/source-profile.service';

async function xlsx(sheets: { name: string; rows: unknown[][] }[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  for (const definition of sheets) {
    const sheet = workbook.addWorksheet(definition.name);
    for (const row of definition.rows) sheet.addRow(row);
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function plan(input: Partial<CleaningPlan> & Pick<CleaningPlan, 'targetKind' | 'sheets' | 'columns' | 'valueKind'>): CleaningPlan {
  return {
    version: 1,
    excludedRows: [],
    mappings: [],
    ...(input.valueKind === 'amount' ? { amountUnit: 'yuan' as const, signConvention: 'display_positive' as const } : {}),
    ...input,
  };
}

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
});

describe('阶段 A：手工映射与确定性解析', () => {
  it('S01/S02/S03/S08：第 5 行表头、名称精确匹配、万元和 profit_signed 成本方向', async () => {
    const db = testDb();
    const fx = buildFixture(db);
    const version = budget.createVersion(db, { year: 2026, name: '清洗预算' });
    const file = await xlsx([{ name: '任意预算表', rows: [
      ['预算说明'], [], [], [],
      ['金额列', '科目中文', '备注', '组织中文'],
      ['-1,234.56789', '材料成本', '来源说明', '上海公司'],
    ] }]);
    const workbook = await loadCleaningWorkbook(file);
    const result = applyCleaningPlan(db, workbook, { targetKind: 'budget', versionId: version.id }, plan({
      targetKind: 'budget',
      sheets: [{ sheetName: '任意预算表', headerRow: 5, dataStartRow: 6, dataEndRow: 6 }],
      columns: [
        { sourceColumn: 1, field: 'amount' },
        { sourceColumn: 2, field: 'accountName' },
        { sourceColumn: 3, field: 'note' },
        { sourceColumn: 4, field: 'orgName' },
      ],
      valueKind: 'amount',
      amountUnit: 'wan',
      signConvention: 'profit_signed',
    }));
    expect(result.errors).toEqual([]);
    expect(result.unresolved).toEqual([]);
    expect(result.rows[0]).toMatchObject({
      targetOrgId: fx.orgIds.shanghai,
      targetAccountId: fx.accIds.costSub,
      normalizedValue: '12345678.90',
      expectedSignedCents: -1_234_567_890,
    });
    expect(result.entries[0]).toMatchObject({ amount: '12345678.90', note: '来源说明' });
    db.close();
  });

  it('S06/S07/S09/S13/S22：类型混用、重复、未匹配、公式和空值均定位到原 sheet/row，显式零保留', async () => {
    const db = testDb();
    const fx = buildFixture(db);
    const quantityRoot = account.createAccount(db, { parentId: null, code: 'QX', name: '数量根', type: 'quantity', unit: '吨' });
    account.createAccount(db, { parentId: quantityRoot.id, code: 'QX01', name: '销量', type: 'quantity', unit: '吨' });
    const version = budget.createVersion(db, { year: 2026, name: '错误定位预算' });
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('错误数据');
    sheet.addRow(['组织', '科目', '金额']);
    sheet.addRow(['SH', 'QX01', '1']);
    sheet.addRow(['SH', 'I01', '10']);
    sheet.addRow(['SH', 'I01', '20']);
    sheet.addRow(['HZ', 'UNKNOWN', '5']);
    sheet.addRow(['NJ', 'I01', '']);
    sheet.addRow(['HZ', 'I01', '0']);
    const formulaRow = sheet.addRow(['NJ', 'E01', '']);
    formulaRow.getCell(3).value = { formula: '1+1', result: 2 };
    const file = Buffer.from(await workbook.xlsx.writeBuffer());
    const loaded = await loadCleaningWorkbook(file);
    const result = applyCleaningPlan(db, loaded, { targetKind: 'budget', versionId: version.id }, plan({
      targetKind: 'budget',
      sheets: [{ sheetName: '错误数据', headerRow: 1, dataStartRow: 2, dataEndRow: 8 }],
      columns: [{ sourceColumn: 1, field: 'orgCode' }, { sourceColumn: 2, field: 'accountCode' }, { sourceColumn: 3, field: 'amount' }],
      valueKind: 'amount',
    }));
    expect(result.errors.map((item) => [item.row, item.code])).toEqual(expect.arrayContaining([
      [2, 'AMOUNT_FOR_QUANTITY_ACCOUNT'],
      [4, 'DUPLICATE_TARGET'],
      [6, 'VALUE_EMPTY'],
      [8, 'VALUE_FORMULA_NOT_ALLOWED'],
    ]));
    expect(result.unresolved.some((group) => group.sourceText === 'UNKNOWN' && group.rows[0].row === 5)).toBe(true);
    expect(result.rows.find((row) => row.rowNumber === 7)?.normalizedValue).toBe('0.00');
    expect(result.errors.every((item) => item.sheetName === '错误数据')).toBe(true);
    const beforeBatches = (db.prepare('SELECT COUNT(*) AS count FROM import_batch').get() as { count: number }).count;
    expect(() => createPendingCleaningPreview(db, { analysis: result, originalName: 'invalid.xlsx', file })).toThrow(/错误.*未决映射/);
    expect((db.prepare('SELECT COUNT(*) AS count FROM import_batch').get() as { count: number }).count).toBe(beforeBatches);
    db.close();
  });

  it('未映射列有数据的行不是完全空行，不能被静默自动排除', async () => {
    const db = testDb();
    buildFixture(db);
    const version = budget.createVersion(db, { year: 2026, name: '整行空值识别预算' });
    const file = await xlsx([{ name: '错位数据', rows: [
      ['组织', '科目', '金额', '备用组织', '备用科目', '备用金额'],
      ['', '', '', 'HZ', 'I01', '999'],
    ] }]);
    const result = applyCleaningPlan(db, await loadCleaningWorkbook(file), { targetKind: 'budget', versionId: version.id }, plan({
      targetKind: 'budget', sheets: [{ sheetName: '错位数据', headerRow: 1, dataStartRow: 2, dataEndRow: 2 }],
      columns: [{ sourceColumn: 1, field: 'orgCode' }, { sourceColumn: 2, field: 'accountCode' }, { sourceColumn: 3, field: 'amount' }], valueKind: 'amount',
    }));
    expect(result.rows[0]).toMatchObject({ excluded: false, suspectedReason: '组织和科目均为空' });
    expect(result.counts.excluded).toBe(0);
    expect(result.errors.map((item) => item.code)).toEqual(expect.arrayContaining(['ORG_EMPTY', 'ACCOUNT_EMPTY']));
    expect(() => createPendingCleaningPreview(db, { analysis: result, originalName: 'shifted.xlsx', file })).toThrow(/不能创建待确认批次/);
    db.close();
  });

  it('编码先按大小写敏感精确命中，大小写折叠后有多个候选时保持未决', async () => {
    const db = testDb();
    const fx = buildFixture(db);
    const upper = org.createOrg(db, { parentId: fx.orgIds.west, code: 'CaseOrg', name: '大小写组织一' });
    const lower = org.createOrg(db, { parentId: fx.orgIds.west, code: 'caseorg', name: '大小写组织二' });
    const version = budget.createVersion(db, { year: 2026, name: '大小写编码预算' });
    const exactFile = await xlsx([{ name: '精确编码', rows: [['组织', '科目', '金额'], ['caseorg', 'I01', '1']] }]);
    const cleaningPlan = plan({
      targetKind: 'budget', sheets: [{ sheetName: '精确编码', headerRow: 1, dataStartRow: 2, dataEndRow: 2 }],
      columns: [{ sourceColumn: 1, field: 'orgCode' }, { sourceColumn: 2, field: 'accountCode' }, { sourceColumn: 3, field: 'amount' }], valueKind: 'amount',
    });
    const exact = applyCleaningPlan(db, await loadCleaningWorkbook(exactFile), { targetKind: 'budget', versionId: version.id }, cleaningPlan);
    expect(exact.errors).toEqual([]);
    expect(exact.unresolved).toEqual([]);
    expect(exact.entries[0]).toMatchObject({ orgId: lower.id });
    expect(exact.entries[0]).not.toMatchObject({ orgId: upper.id });

    const ambiguousFile = await xlsx([{ name: '精确编码', rows: [['组织', '科目', '金额'], ['CASEORG', 'I01', '1']] }]);
    const ambiguous = applyCleaningPlan(db, await loadCleaningWorkbook(ambiguousFile), { targetKind: 'budget', versionId: version.id }, cleaningPlan);
    expect(ambiguous.entries).toEqual([]);
    expect(ambiguous.unresolved).toContainEqual(expect.objectContaining({ kind: 'org', sourceText: 'CASEORG' }));
    db.close();
  });

  it('S16：科目—组织适用范围在 analyze 阶段按真实坐标阻断', async () => {
    const db = testDb();
    const fx = buildFixture(db);
    const scopedOrg = org.createOrg(db, { parentId: fx.orgIds.root, code: '010102', name: '受限组织' });
    const scopedAccount = account.createAccount(db, { parentId: fx.accIds.incomeRoot, code: 'I1201', name: '总部专属收入', type: 'income' });
    const version = budget.createVersion(db, { year: 2026, name: '适用范围预算' });
    const file = await xlsx([{ name: '范围', rows: [['组织', '科目', '金额'], [scopedOrg.code, scopedAccount.code, '1']] }]);
    const result = applyCleaningPlan(db, await loadCleaningWorkbook(file), { targetKind: 'budget', versionId: version.id }, plan({
      targetKind: 'budget', sheets: [{ sheetName: '范围', headerRow: 1, dataStartRow: 2, dataEndRow: 2 }],
      columns: [{ sourceColumn: 1, field: 'orgCode' }, { sourceColumn: 2, field: 'accountCode' }, { sourceColumn: 3, field: 'amount' }], valueKind: 'amount',
    }));
    expect(result.errors).toContainEqual(expect.objectContaining({ sheetName: '范围', row: 2, code: 'ACCOUNT_NOT_APPLICABLE' }));
    const beforeBatches = (db.prepare('SELECT COUNT(*) AS count FROM import_batch').get() as { count: number }).count;
    expect(() => createPendingCleaningPreview(db, { analysis: result, originalName: 'scope.xlsx', file })).toThrow(/不能创建待确认批次/);
    expect((db.prepare('SELECT COUNT(*) AS count FROM import_batch').get() as { count: number }).count).toBe(beforeBatches);
    db.close();
  });

  it('完成定义 8：预算候选严格绑定版本快照，不包含版本创建后新增节点', async () => {
    const db = testDb();
    const fx = buildFixture(db);
    const version = budget.createVersion(db, { year: 2026, name: '候选快照预算' });
    const lateOrg = org.createOrg(db, { parentId: fx.orgIds.west, code: 'LATE-ORG', name: '快照后组织' });
    const lateAccount = account.createAccount(db, { parentId: fx.accIds.expenseRoot, code: 'E99', name: '快照后科目', type: 'expense' });
    const file = await xlsx([{ name: '快照', rows: [['组织', '科目', '金额'], [lateOrg.code, lateAccount.code, '1']] }]);
    const result = applyCleaningPlan(db, await loadCleaningWorkbook(file), { targetKind: 'budget', versionId: version.id }, plan({
      targetKind: 'budget', sheets: [{ sheetName: '快照', headerRow: 1, dataStartRow: 2, dataEndRow: 2 }],
      columns: [{ sourceColumn: 1, field: 'orgCode' }, { sourceColumn: 2, field: 'accountCode' }, { sourceColumn: 3, field: 'amount' }], valueKind: 'amount',
    }));
    expect(result.targets.orgs.some((item) => item.code === lateOrg.code)).toBe(false);
    expect(result.targets.accounts.some((item) => item.code === lateAccount.code)).toBe(false);
    expect(result.unresolved.map((item) => item.sourceText)).toEqual(expect.arrayContaining([lateOrg.code, lateAccount.code]));
    expect(result.entries).toEqual([]);
    db.close();
  });

  it('S21：合法负数量按 10^4 缩放、保留符号且只警告', async () => {
    const db = testDb();
    const fx = buildFixture(db);
    const root = account.createAccount(db, { parentId: null, code: 'Q', name: '数量', type: 'quantity', unit: '吨' });
    const leaf = account.createAccount(db, { parentId: root.id, code: 'Q01', name: '产量', type: 'quantity', unit: '吨' });
    const version = budget.createVersion(db, { year: 2026, name: '数量预算' });
    const file = await xlsx([{ name: '数量', rows: [['组织', '科目', '值'], ['SH', 'Q01', '-12.3456']] }]);
    const result = applyCleaningPlan(db, await loadCleaningWorkbook(file), { targetKind: 'budget', versionId: version.id }, plan({
      targetKind: 'budget', sheets: [{ sheetName: '数量', headerRow: 1, dataStartRow: 2, dataEndRow: 2 }],
      columns: [{ sourceColumn: 1, field: 'orgCode' }, { sourceColumn: 2, field: 'accountCode' }, { sourceColumn: 3, field: 'quantity' }], valueKind: 'quantity',
    }));
    expect(result.errors).toEqual([]);
    expect(result.rows[0]).toMatchObject({ targetOrgId: fx.orgIds.shanghai, targetAccountId: leaf.id, normalizedValue: '-12.3456', quantityScaled: -123456 });
    expect(result.warnings).toContainEqual(expect.objectContaining({ code: 'NEGATIVE_QUANTITY' }));
    const pending = createPendingCleaningPreview(db, { analysis: result, originalName: 'negative-quantity.xlsx', file });
    imports.commitBatch(db, pending.importBatchId);
    expect((db.prepare('SELECT quantity FROM budget_entry WHERE version_id=? AND org_id=? AND account_id=?').get(version.id, fx.orgIds.shanghai, leaf.id) as any).quantity).toBe(-123456);

    const formulaWorkbook = new ExcelJS.Workbook();
    const formulaSheet = formulaWorkbook.addWorksheet('数量公式');
    formulaSheet.addRow(['组织', '科目', '数量']);
    const formulaRow = formulaSheet.addRow(['SH', 'Q01', '']);
    formulaRow.getCell(3).value = { formula: '6*7', result: 42 };
    const formulaAnalysis = applyCleaningPlan(db, await loadCleaningWorkbook(Buffer.from(await formulaWorkbook.xlsx.writeBuffer())), { targetKind: 'budget', versionId: version.id }, plan({
      targetKind: 'budget', sheets: [{ sheetName: '数量公式', headerRow: 1, dataStartRow: 2, dataEndRow: 2 }],
      columns: [{ sourceColumn: 1, field: 'orgCode' }, { sourceColumn: 2, field: 'accountCode' }, { sourceColumn: 3, field: 'quantity' }], valueKind: 'quantity',
    }));
    expect(formulaAnalysis.errors).toContainEqual(expect.objectContaining({ row: 2, code: 'VALUE_FORMULA_NOT_ALLOWED' }));
    db.close();
  });
});

describe('阶段 B：持久预览、确认、清零和基线', () => {
  it('S15/S18/S20：预算 payload 保留公式备注，pending 行分页，提交清理且撤销正常', async () => {
    const db = testDb();
    const fx = buildFixture(db);
    const version = budget.createVersion(db, { year: 2026, name: '预算闭环' });
    budget.saveEntries(db, version.id, [
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.costSub, amount: '60', formula: '=5*12', note: '原依据' },
      { orgId: fx.orgIds.hangzhou, accountId: fx.accIds.expenseAdmin, amount: '20' },
    ]);
    const file = await xlsx([{ name: '预算', rows: [
      ['组织', '科目', '金额', '备注'],
      ['SH', 'C0101', '0', ''],
      ['HZ', 'E01', '0', ''],
      ['NJ', 'I01', '100', '新增'],
    ] }]);
    const cleaningPlan = plan({
      targetKind: 'budget', sheets: [{ sheetName: '预算', headerRow: 1, dataStartRow: 2, dataEndRow: 4 }],
      columns: [{ sourceColumn: 1, field: 'orgCode' }, { sourceColumn: 2, field: 'accountCode' }, { sourceColumn: 3, field: 'amount' }, { sourceColumn: 4, field: 'note' }], valueKind: 'amount',
    });
    const analysis = applyCleaningPlan(db, await loadCleaningWorkbook(file), { targetKind: 'budget', versionId: version.id }, cleaningPlan);
    const pending = createPendingCleaningPreview(db, { analysis, originalName: 'budget.xlsx', file });
    expect((pending.summary as any).actions).toMatchObject({ insert: 1, clear: 2 });
    expect(listPreviewRows(db, pending.importBatchId, { pageSize: 2 }).items).toHaveLength(2);
    expect(JSON.parse(imports.getBatch(db, pending.importBatchId).cleaning_plan_json)).toMatchObject({ version: 1, targetKind: 'budget' });
    imports.commitBatch(db, pending.importBatchId);
    expect((db.prepare('SELECT COUNT(*) count FROM import_cleaning_preview_row WHERE import_batch_id=?').get(pending.importBatchId) as any).count).toBe(0);
    const kept = db.prepare('SELECT amount_cents, formula, note FROM budget_entry WHERE version_id=? AND org_id=? AND account_id=?')
      .get(version.id, fx.orgIds.shanghai, fx.accIds.costSub) as any;
    expect(kept).toMatchObject({ amount_cents: 0, formula: '=5*12', note: '原依据' });
    expect(db.prepare('SELECT 1 FROM budget_entry WHERE version_id=? AND org_id=? AND account_id=?').get(version.id, fx.orgIds.hangzhou, fx.accIds.expenseAdmin)).toBeUndefined();
    expect((db.prepare('SELECT amount_cents FROM budget_entry WHERE version_id=? AND org_id=? AND account_id=?').get(version.id, fx.orgIds.nanjing, fx.accIds.incomeMain) as any).amount_cents).toBe(10_000);
    imports.rollbackBatch(db, pending.importBatchId);
    expect((db.prepare('SELECT amount_cents FROM budget_entry WHERE version_id=? AND org_id=? AND account_id=?').get(version.id, fx.orgIds.shanghai, fx.accIds.costSub) as any).amount_cents).toBe(-6_000);
    db.close();
  });

  it('S10：命中单元格在 preview 后变化，confirm 拒绝静默覆盖', async () => {
    const db = testDb();
    const fx = buildFixture(db);
    const version = budget.createVersion(db, { year: 2026, name: '基线预算' });
    budget.saveEntries(db, version.id, [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '10' }]);
    const file = await xlsx([{ name: '数据', rows: [['组织', '科目', '金额'], ['SH', 'I01', '20']] }]);
    const analysis = applyCleaningPlan(db, await loadCleaningWorkbook(file), { targetKind: 'budget', versionId: version.id }, plan({
      targetKind: 'budget', sheets: [{ sheetName: '数据', headerRow: 1, dataStartRow: 2, dataEndRow: 2 }],
      columns: [{ sourceColumn: 1, field: 'orgCode' }, { sourceColumn: 2, field: 'accountCode' }, { sourceColumn: 3, field: 'amount' }], valueKind: 'amount',
    }));
    const pending = createPendingCleaningPreview(db, { analysis, originalName: 'base.xlsx', file });
    budget.saveEntries(db, version.id, [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '11' }]);
    expect(() => imports.commitBatch(db, pending.importBatchId)).toThrow(/已有其他改动|命中单元格已被修改/);
    expect(imports.getBatch(db, pending.importBatchId).status).toBe('pending');
    db.close();
  });

  it('S08/S14/S19/S22：当前实际 profit_signed 入库方向正确、显式零删除且未命中组合不变', async () => {
    const db = testDb();
    const fx = buildFixture(db);
    actual.saveActual(db, {
      year: 2026, snapshotDate: '2026-01-31', source: 'manual', mode: 'upsert',
      entries: [
        { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '10' },
        { orgId: fx.orgIds.hangzhou, accountId: fx.accIds.expenseAdmin, amount: '8' },
      ],
    });
    const file = await xlsx([{ name: '实际', rows: [
      ['组织', '科目', '金额'],
      ['SH', 'I01', '0'],
      ['SH', 'C0101', '-100'],
    ] }]);
    const target: CleaningTarget = { targetKind: 'actual-current', year: 2026, snapshotDate: '2026-06-30' };
    const analysis = applyCleaningPlan(db, await loadCleaningWorkbook(file), target, plan({
      targetKind: 'actual-current', sheets: [{ sheetName: '实际', headerRow: 1, dataStartRow: 2, dataEndRow: 3 }],
      columns: [{ sourceColumn: 1, field: 'orgCode' }, { sourceColumn: 2, field: 'accountCode' }, { sourceColumn: 3, field: 'amount' }],
      valueKind: 'amount', signConvention: 'profit_signed',
    }));
    const pending = createPendingCleaningPreview(db, { analysis, originalName: 'actual.xlsx', file });
    expect(listPreviewRows(db, pending.importBatchId).items).toEqual(expect.arrayContaining([
      expect.objectContaining({ row_number: 3, normalized_value: '100.00', expected_value_text: '-100.00' }),
    ]));
    const beforeBatch = actual.getYearState(db, 2026)!.current_batch_id;
    imports.commitBatch(db, pending.importBatchId);
    expect(db.prepare('SELECT 1 FROM actual_current WHERE year=2026 AND org_id=? AND account_id=?').get(fx.orgIds.shanghai, fx.accIds.incomeMain)).toBeUndefined();
    expect((db.prepare('SELECT cumulative_amount_cents FROM actual_current WHERE year=2026 AND org_id=? AND account_id=?').get(fx.orgIds.shanghai, fx.accIds.costSub) as any).cumulative_amount_cents).toBe(-10_000);
    expect((db.prepare('SELECT cumulative_amount_cents FROM actual_current WHERE year=2026 AND org_id=? AND account_id=?').get(fx.orgIds.hangzhou, fx.accIds.expenseAdmin) as any).cumulative_amount_cents).toBe(-800);
    expect(actual.getYearState(db, 2026)!.current_batch_id).not.toBe(beforeBatch);
    db.close();
  });

  it('当前实际的截止日期早于最新快照时在分析阶段立即拒绝，不创建 pending 批次', async () => {
    const db = testDb();
    const fx = buildFixture(db);
    actual.saveActual(db, {
      year: 2026, snapshotDate: '2026-12-31', source: 'manual', mode: 'upsert',
      entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '10' }],
    });
    const file = await xlsx([{ name: '倒序实际', rows: [['组织', '科目', '金额'], ['SH', 'I01', '20']] }]);
    const target: CleaningTarget = { targetKind: 'actual-current', year: 2026, snapshotDate: '2026-06-30' };
    const cleaningPlan = plan({
      targetKind: 'actual-current', sheets: [{ sheetName: '倒序实际', headerRow: 1, dataStartRow: 2, dataEndRow: 2 }],
      columns: [{ sourceColumn: 1, field: 'orgCode' }, { sourceColumn: 2, field: 'accountCode' }, { sourceColumn: 3, field: 'amount' }], valueKind: 'amount',
    });
    const workbook = await loadCleaningWorkbook(file);
    const beforeBatches = (db.prepare('SELECT COUNT(*) AS count FROM import_batch').get() as { count: number }).count;
    expect(() => applyCleaningPlan(db, workbook, target, cleaningPlan)).toThrow(/截止日期不能早于当前最新截止日期 2026-12-31/);
    expect((db.prepare('SELECT COUNT(*) AS count FROM import_batch').get() as { count: number }).count).toBe(beforeBatches);
    db.close();
  });

  it('当前实际勾选清空空白备注后会真实清空，撤销时恢复原备注', async () => {
    const db = testDb();
    const fx = buildFixture(db);
    actual.saveActual(db, {
      year: 2026, snapshotDate: '2026-01-31', source: 'manual', mode: 'upsert',
      entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '10', memo: '原备注' }],
    });
    const file = await xlsx([{ name: '备注清空', rows: [['组织', '科目', '金额', '备注'], ['SH', 'I01', '10', '']] }]);
    const target: CleaningTarget = { targetKind: 'actual-current', year: 2026, snapshotDate: '2026-06-30' };
    const analysis = applyCleaningPlan(db, await loadCleaningWorkbook(file), target, plan({
      targetKind: 'actual-current', sheets: [{ sheetName: '备注清空', headerRow: 1, dataStartRow: 2, dataEndRow: 2 }],
      columns: [
        { sourceColumn: 1, field: 'orgCode' }, { sourceColumn: 2, field: 'accountCode' },
        { sourceColumn: 3, field: 'amount' }, { sourceColumn: 4, field: 'note' },
      ],
      valueKind: 'amount', clearBlankNotes: true,
    }));
    const pending = createPendingCleaningPreview(db, { analysis, originalName: 'clear-memo.xlsx', file });
    expect((pending.summary as any).actions.overwrite).toBe(1);
    imports.commitBatch(db, pending.importBatchId);
    expect((db.prepare('SELECT memo FROM actual_current WHERE year=2026 AND org_id=? AND account_id=?')
      .get(fx.orgIds.shanghai, fx.accIds.incomeMain) as { memo: string }).memo).toBe('');
    imports.rollbackBatch(db, pending.importBatchId);
    expect((db.prepare('SELECT memo FROM actual_current WHERE year=2026 AND org_id=? AND account_id=?')
      .get(fx.orgIds.shanghai, fx.accIds.incomeMain) as { memo: string }).memo).toBe('原备注');
    db.close();
  });

  it('S19/S22：当前实际数量显式 0 删除，空值仍阻断且不会创建批次', async () => {
    const db = testDb();
    const fx = buildFixture(db);
    const quantityRoot = account.createAccount(db, { parentId: null, code: 'QA', name: '实际数量', type: 'quantity', unit: '吨' });
    const quantityLeaf = account.createAccount(db, { parentId: quantityRoot.id, code: 'QA01', name: '实际产量', type: 'quantity', unit: '吨' });
    actual.saveActual(db, {
      year: 2026, snapshotDate: '2026-01-31', source: 'manual', mode: 'upsert',
      entries: [{ orgId: fx.orgIds.shanghai, accountId: quantityLeaf.id, quantity: '12.5' }],
    });
    const target: CleaningTarget = { targetKind: 'actual-current', year: 2026, snapshotDate: '2026-06-30' };
    const zeroFile = await xlsx([{ name: '数量', rows: [['组织', '科目', '数量'], ['SH', 'QA01', '0']] }]);
    const zeroPlan = plan({
      targetKind: 'actual-current', sheets: [{ sheetName: '数量', headerRow: 1, dataStartRow: 2, dataEndRow: 2 }],
      columns: [{ sourceColumn: 1, field: 'orgCode' }, { sourceColumn: 2, field: 'accountCode' }, { sourceColumn: 3, field: 'quantity' }], valueKind: 'quantity',
    });
    const zeroAnalysis = applyCleaningPlan(db, await loadCleaningWorkbook(zeroFile), target, zeroPlan);
    expect(zeroAnalysis.errors).toEqual([]);
    expect(zeroAnalysis.rows[0]).toMatchObject({ sourceValueText: '0', normalizedValue: '0', quantityScaled: 0 });
    const pending = createPendingCleaningPreview(db, { analysis: zeroAnalysis, originalName: 'quantity-zero.xlsx', file: zeroFile });
    expect((pending.summary as any).actions.clear).toBe(1);
    imports.commitBatch(db, pending.importBatchId);
    expect(db.prepare('SELECT 1 FROM actual_current WHERE year=? AND org_id=? AND account_id=?').get(2026, fx.orgIds.shanghai, quantityLeaf.id)).toBeUndefined();

    const emptyFile = await xlsx([{ name: '数量', rows: [['组织', '科目', '数量'], ['HZ', 'QA01', '']] }]);
    const emptyAnalysis = applyCleaningPlan(db, await loadCleaningWorkbook(emptyFile), target, zeroPlan);
    expect(emptyAnalysis.errors).toContainEqual(expect.objectContaining({ row: 2, code: 'VALUE_EMPTY' }));
    const beforeBatches = (db.prepare('SELECT COUNT(*) AS count FROM import_batch').get() as { count: number }).count;
    expect(() => createPendingCleaningPreview(db, { analysis: emptyAnalysis, originalName: 'quantity-empty.xlsx', file: emptyFile })).toThrow(/不能创建待确认批次/);
    expect((db.prepare('SELECT COUNT(*) AS count FROM import_batch').get() as { count: number }).count).toBe(beforeBatches);
    db.close();
  });

  it('预算一级科目变化按版本快照归组，大额变化进入非阻断警告摘要', async () => {
    const db = testDb();
    const fx = buildFixture(db);
    const version = budget.createVersion(db, { year: 2026, name: '汇总快照预算' });
    budget.saveEntries(db, version.id, [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '1' }]);
    const laterRoot = account.createAccount(db, { parentId: null, code: 'IX', name: '当前树新收入根', type: 'income' });
    account.moveAccount(db, fx.accIds.incomeMain, laterRoot.id);
    const file = await xlsx([{ name: '变化', rows: [['组织', '科目', '金额'], ['SH', 'I01', '20']] }]);
    const analysis = applyCleaningPlan(db, await loadCleaningWorkbook(file), { targetKind: 'budget', versionId: version.id }, plan({
      targetKind: 'budget', sheets: [{ sheetName: '变化', headerRow: 1, dataStartRow: 2, dataEndRow: 2 }],
      columns: [{ sourceColumn: 1, field: 'orgCode' }, { sourceColumn: 2, field: 'accountCode' }, { sourceColumn: 3, field: 'amount' }], valueKind: 'amount',
    }));
    const pending = createPendingCleaningPreview(db, { analysis, originalName: 'snapshot-group.xlsx', file });
    expect((pending.summary as any).amount.changesByOrgAndRoot).toContainEqual({ orgCode: 'SH', rootAccountCode: 'I', changeCents: 1_900 });
    expect((pending.summary as any).counts.largeChange).toBe(1);
    expect((pending.summary as any).warnings).toContainEqual(expect.objectContaining({ sheetName: '变化', row: 2, code: 'LARGE_CHANGE' }));
    imports.cancelBatch(db, pending.importBatchId);
    db.close();
  });

  it('S18：取消清洗批次删除逐行预览和可执行载荷，但保留轻量计划与摘要', async () => {
    const db = testDb();
    const fx = buildFixture(db);
    const version = budget.createVersion(db, { year: 2026, name: '取消清洗预算' });
    const file = await xlsx([{ name: '取消', rows: [['组织', '科目', '金额'], ['SH', 'I01', '1']] }]);
    const analysis = applyCleaningPlan(db, await loadCleaningWorkbook(file), { targetKind: 'budget', versionId: version.id }, plan({
      targetKind: 'budget', sheets: [{ sheetName: '取消', headerRow: 1, dataStartRow: 2, dataEndRow: 2 }],
      columns: [{ sourceColumn: 1, field: 'orgCode' }, { sourceColumn: 2, field: 'accountCode' }, { sourceColumn: 3, field: 'amount' }], valueKind: 'amount',
    }));
    const pending = createPendingCleaningPreview(db, { analysis, originalName: 'cancel.xlsx', file });
    const before = imports.getBatch(db, pending.importBatchId);
    imports.cancelBatch(db, pending.importBatchId);
    const cancelled = imports.getBatch(db, pending.importBatchId);
    expect(cancelled).toMatchObject({ status: 'cancelled', payload_json: '{}', cleaning_plan_json: before.cleaning_plan_json, summary_json: before.summary_json });
    expect(cancelled.file_blob.length).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS count FROM import_cleaning_preview_row WHERE import_batch_id=?').get(pending.importBatchId) as { count: number }).count).toBe(0);
    expect(() => listPreviewRows(db, pending.importBatchId)).toThrow(/待确认批次生命周期/);
    expect(() => imports.commitBatch(db, pending.importBatchId)).toThrow(/状态为 cancelled/);
    db.close();
  });

  it('S14：实际数 preview 后年度当前批次或树口径变化都要求重新预览', async () => {
    const db = testDb();
    const fx = buildFixture(db);
    const file = await xlsx([{ name: '实际', rows: [['组织', '科目', '金额'], ['SH', 'I01', '10']] }]);
    const target: CleaningTarget = { targetKind: 'actual-current', year: 2026, snapshotDate: '2026-06-30' };
    const cleaningPlan = plan({
      targetKind: 'actual-current', sheets: [{ sheetName: '实际', headerRow: 1, dataStartRow: 2, dataEndRow: 2 }],
      columns: [{ sourceColumn: 1, field: 'orgCode' }, { sourceColumn: 2, field: 'accountCode' }, { sourceColumn: 3, field: 'amount' }], valueKind: 'amount',
    });
    const firstAnalysis = applyCleaningPlan(db, await loadCleaningWorkbook(file), target, cleaningPlan);
    const first = createPendingCleaningPreview(db, { analysis: firstAnalysis, originalName: 'actual-base.xlsx', file });
    actual.saveActual(db, { year: 2026, snapshotDate: '2026-05-31', source: 'manual', mode: 'upsert', entries: [{ orgId: fx.orgIds.hangzhou, accountId: fx.accIds.incomeMain, amount: '1' }] });
    expect(() => imports.commitBatch(db, first.importBatchId)).toThrow(/年度当前批次已变化/);

    const secondAnalysis = applyCleaningPlan(db, await loadCleaningWorkbook(file), target, cleaningPlan);
    const second = createPendingCleaningPreview(db, { analysis: secondAnalysis, originalName: 'actual-tree.xlsx', file });
    org.createOrg(db, { parentId: fx.orgIds.west, code: 'NEW-LEAF', name: '新增组织' });
    expect(() => imports.commitBatch(db, second.importBatchId)).toThrow(/组织树口径已变化/);

    const thirdAnalysis = applyCleaningPlan(db, await loadCleaningWorkbook(file), target, cleaningPlan);
    const third = createPendingCleaningPreview(db, { analysis: thirdAnalysis, originalName: 'actual-account-tree.xlsx', file });
    account.createAccount(db, { parentId: fx.accIds.expenseRoot, code: 'E-NEW-LEAF', name: '新增科目', type: 'expense' });
    expect(() => imports.commitBatch(db, third.importBatchId)).toThrow(/科目树口径已变化/);
    db.close();
  });

  it('S17：preview 和 confirm 都阻断 active 财务拥有范围，finance profile 后启用也不能绕过', async () => {
    const db = testDb();
    const fx = buildFixture(db);
    const file = await xlsx([{ name: '实际', rows: [['组织', '科目', '金额'], ['SH', 'I01', '1']] }]);
    const target: CleaningTarget = { targetKind: 'actual-current', year: 2026, snapshotDate: '2026-06-30' };
    const cleaningPlan = plan({
      targetKind: 'actual-current', sheets: [{ sheetName: '实际', headerRow: 1, dataStartRow: 2, dataEndRow: 2 }],
      columns: [{ sourceColumn: 1, field: 'orgCode' }, { sourceColumn: 2, field: 'accountCode' }, { sourceColumn: 3, field: 'amount' }], valueKind: 'amount',
    });
    const analysis = applyCleaningPlan(db, await loadCleaningWorkbook(file), target, cleaningPlan);
    const pending = createPendingCleaningPreview(db, { analysis, originalName: 'before-profile.xlsx', file });
    profiles.createSourceProfile(db, {
      code: 'ERP', name: '财务 ERP',
      config: { ownedOrgCodes: ['SH'], ownedAccountCodes: ['I01'], amountUnit: 'yuan' },
    });
    expect(() => imports.commitBatch(db, pending.importBatchId)).toThrow(/财务系统转换链路/);
    const beforeBatches = (db.prepare('SELECT COUNT(*) AS count FROM import_batch').get() as { count: number }).count;
    expect(() => createPendingCleaningPreview(db, { analysis, originalName: 'after-profile.xlsx', file })).toThrow(/财务系统转换链路/);
    expect((db.prepare('SELECT COUNT(*) AS count FROM import_batch').get() as { count: number }).count).toBe(beforeBatches);
    db.close();
  });
});

describe('阶段 C/D：多表、排除、模板别名、AI 降级', () => {
  it('S03/S04/S05/S12：多 sheet 统一映射、交互排除、别名和模板复用不固化数据结束行', async () => {
    const db = testDb();
    const fx = buildFixture(db);
    const version = budget.createVersion(db, { year: 2026, name: '多表预算' });
    aliasService.createAlias(db, { targetKind: 'budget', mappingKind: 'account', sourceText: '差旅', targetCode: 'E01' });
    const file = await xlsx([
      { name: '一月', rows: [['组织名称', '科目名称', '金额'], ['上海公司', '差旅', '10'], ['合计', '', '10']] },
      { name: '二月', rows: [['组织名称', '科目名称', '金额'], ['杭州公司', '销售费用', '20']] },
    ]);
    const cleaningPlan = plan({
      targetKind: 'budget',
      sheets: [
        { sheetName: '一月', headerRow: 1, dataStartRow: 2, dataEndRow: 3 },
        { sheetName: '二月', headerRow: 1, dataStartRow: 2, dataEndRow: 2 },
      ],
      columns: [{ sourceColumn: 1, field: 'orgName' }, { sourceColumn: 2, field: 'accountName' }, { sourceColumn: 3, field: 'amount' }],
      valueKind: 'amount',
      excludedRows: [{ sheetName: '一月', row: 3, reason: '合计行' }],
    });
    const result = applyCleaningPlan(db, await loadCleaningWorkbook(file), { targetKind: 'budget', versionId: version.id }, cleaningPlan);
    expect(result.errors).toEqual([]);
    expect(result.unresolved).toEqual([]);
    expect(result.entries).toHaveLength(2);
    expect(result.rows.find((row) => row.rowNumber === 3 && row.sheetName === '一月')).toMatchObject({ excluded: true, sourceValueText: '10' });
    const pending = createPendingCleaningPreview(db, { analysis: result, originalName: 'months.xlsx', file });
    expect((pending.summary as any).amount.excludedSourceAmountCents).toBe(1_000);

    const template = templateService.createTemplate(db, {
      name: '月度中文表', targetKind: 'budget', config: {
        preferredSheetName: '一月', headerRow: 1, dataStartRow: 2,
        columns: cleaningPlan.columns, valueKind: 'amount', amountUnit: 'yuan', signConvention: 'display_positive',
        dataEndRow: 999, excludedRows: [{ row: 3 }],
      },
    });
    const savedConfig = JSON.parse(template.config_json);
    expect(savedConfig.dataEndRow).toBeUndefined();
    expect(savedConfig.excludedRows).toBeUndefined();
    expect(templateService.updateTemplate(db, template.id, { name: '月度中文表-改' }).name).toBe('月度中文表-改');
    expect(templateService.listTemplates(db, 'budget')).toHaveLength(1);
    templateService.deleteTemplate(db, template.id);
    expect(templateService.listTemplates(db, 'budget')).toEqual([]);
    db.close();
  });

  it('S11：AI 未配置时返回空推荐；非法字段或越界输出整份丢弃', async () => {
    const oldBase = process.env.AI_BASE_URL;
    const oldOpenAiBase = process.env.OPENAI_BASE_URL;
    process.env.AI_BASE_URL = '';
    process.env.OPENAI_BASE_URL = '';
    try {
      const file = await xlsx([{ name: '预算', rows: [['组织', '科目', '金额'], ['上海', '收入', 1]] }]);
      const inspection = inspectWorkbook(await loadCleaningWorkbook(file));
      await expect(suggestCleaningStructure(inspection, 'budget')).resolves.toEqual({ available: false, suggestion: null });
      expect(sanitizeAiSuggestion({
        sheet: '预算', headerRow: 1, dataStartRow: 2,
        columns: [{ col: 3, field: 'amount', confidence: 0.9, businessAmount: 999 }],
        suspectedExcludedRows: [], warnings: [],
      }, inspection)).toBeNull();
      expect(sanitizeAiSuggestion({
        sheet: '预算', headerRow: 1, dataStartRow: 2,
        columns: [{ col: 'C', field: 'amount', confidence: 0.9 }],
        suspectedExcludedRows: [], warnings: ['仅为建议'],
      }, inspection)).toMatchObject({ sheet: '预算', columns: [{ col: 3, field: 'amount' }] });
    } finally {
      if (oldBase === undefined) delete process.env.AI_BASE_URL; else process.env.AI_BASE_URL = oldBase;
      if (oldOpenAiBase === undefined) delete process.env.OPENAI_BASE_URL; else process.env.OPENAI_BASE_URL = oldOpenAiBase;
    }
  });

  it('S12：pending 批次的计划快照不受所选模板后续修改影响', async () => {
    const db = testDb();
    const fx = buildFixture(db);
    const version = budget.createVersion(db, { year: 2026, name: '模板冻结预算' });
    const originalColumns = [{ sourceColumn: 1, field: 'orgCode' as const }, { sourceColumn: 2, field: 'accountCode' as const }, { sourceColumn: 3, field: 'amount' as const }];
    const template = templateService.createTemplate(db, {
      name: '冻结模板', targetKind: 'budget', config: { headerRow: 1, dataStartRow: 2, columns: originalColumns, valueKind: 'amount', amountUnit: 'yuan', signConvention: 'display_positive' },
    });
    const file = await xlsx([{ name: '模板', rows: [['组织', '科目', '金额'], ['SH', 'I01', '3']] }]);
    const cleaningPlan = plan({
      targetKind: 'budget', sheets: [{ sheetName: '模板', headerRow: 1, dataStartRow: 2, dataEndRow: 2 }],
      columns: originalColumns, valueKind: 'amount', templateId: template.id,
    });
    const analysis = applyCleaningPlan(db, await loadCleaningWorkbook(file), { targetKind: 'budget', versionId: version.id }, cleaningPlan);
    const pending = createPendingCleaningPreview(db, { analysis, originalName: 'template.xlsx', file });
    const frozen = imports.getBatch(db, pending.importBatchId).cleaning_plan_json;
    templateService.updateTemplate(db, template.id, {
      config: { headerRow: 9, dataStartRow: 10, columns: originalColumns, valueKind: 'amount', amountUnit: 'wan', signConvention: 'profit_signed' },
    });
    expect(imports.getBatch(db, pending.importBatchId).cleaning_plan_json).toBe(frozen);
    expect(JSON.parse(frozen)).toMatchObject({ templateId: template.id, amountUnit: 'yuan', signConvention: 'display_positive', columns: originalColumns });
    imports.commitBatch(db, pending.importBatchId);
    expect((db.prepare('SELECT amount_cents FROM budget_entry WHERE version_id=? AND org_id=? AND account_id=?').get(version.id, fx.orgIds.shanghai, fx.accIds.incomeMain) as { amount_cents: number }).amount_cents).toBe(300);
    db.close();
  });
});

describe('临时 token sidecar 生命周期', () => {
  it('服务重启可恢复、访问刷新滑动 TTL、过期和损坏 sidecar 会清理', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleaning-token-test-'));
    tempDirs.push(dir);
    let now = Date.parse('2026-01-01T00:00:00.000Z');
    const first = new CleaningUploadStore(dir, { ttlMs: 1_000, capacityBytes: 1_000, now: () => now });
    first.initialize();
    const uploaded = first.put('demo.xlsx', Buffer.from('xlsx-bytes'));
    const restarted = new CleaningUploadStore(dir, { ttlMs: 1_000, capacityBytes: 1_000, now: () => now });
    restarted.initialize();
    expect(restarted.get(uploaded.token).buffer.toString()).toBe('xlsx-bytes');
    now += 900;
    restarted.get(uploaded.token); // 滑动刷新
    now += 900;
    expect(restarted.get(uploaded.token).metadata.token).toBe(uploaded.token);
    fs.writeFileSync(path.join(dir, `${uploaded.token}.json`), '{broken');
    expect(() => restarted.get(uploaded.token)).toThrow(/不存在/);
    expect(fs.existsSync(path.join(dir, `${uploaded.token}.xlsx`))).toBe(false);

    const expiring = restarted.put('old.xlsx', Buffer.from('old'));
    now += 1_001;
    expect(() => restarted.get(expiring.token)).toThrow(/不存在|过期/);
  });

  it('目录超过软上限时优先清理最久未活跃文件并保护本次上传', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleaning-cap-test-'));
    tempDirs.push(dir);
    let now = Date.parse('2026-01-01T00:00:00.000Z');
    const store = new CleaningUploadStore(dir, { ttlMs: 100_000, capacityBytes: 6, now: () => now });
    const old = store.put('old.xlsx', Buffer.from('1234'));
    now += 10;
    const fresh = store.put('fresh.xlsx', Buffer.from('5678'));
    expect(() => store.get(old.token, false)).toThrow(/不存在/);
    expect(store.get(fresh.token, false).buffer.toString()).toBe('5678');
  });
});

describe('清洗导入 HTTP 契约', () => {
  it('上传—区域—分析—持久预览—确认、source、模板和别名 API 形成闭环，confirm 拒绝 entries', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleaning-http-test-'));
    tempDirs.push(dir);
    const dbPath = path.join(dir, 'newfc.sqlite');
    const { app, holder, cleaningUploads } = await createTestApp({ dbPath });
    const fx = buildFixture(holder.getDb());
    const version = budget.createVersion(holder.getDb(), { year: 2026, name: 'HTTP 预算' });
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
    try {
      const file = await xlsx([{ name: '非标表', rows: [['说明'], ['组织', '科目', '金额'], ['SH', 'I01', '123.45']] }]);
      const form = new FormData();
      form.append('targetKind', 'budget');
      form.append('file', new Blob([file]), '非标预算.xlsx');
      const uploadedResponse = await authFetch(`${base}/io/cleaning/workbook`, { method: 'POST', body: form });
      expect(uploadedResponse.status).toBe(201);
      const uploaded = await uploadedResponse.json() as any;
      expect(uploaded).toMatchObject({ originalName: '非标预算.xlsx', aiAvailable: false });
      expect(uploaded.sheets[0]).toMatchObject({ name: '非标表', rowCount: 3, columnCount: 3 });
      expect(fs.existsSync(path.join(cleaningUploads.directory, `${uploaded.token}.json`))).toBe(true);

      const region = await (await authFetch(`${base}/io/cleaning/workbook/${uploaded.token}/region?sheet=${encodeURIComponent('非标表')}&startRow=1&endRow=3&startCol=1&endCol=3&page=1&pageSize=2`)).json() as any;
      expect(region).toMatchObject({ total: 3, page: 1, rows: [{ row: 1 }, { row: 2 }] });
      const cleaningPlan = plan({
        targetKind: 'budget', sheets: [{ sheetName: '非标表', headerRow: 2, dataStartRow: 3, dataEndRow: 3 }],
        columns: [{ sourceColumn: 1, field: 'orgCode' }, { sourceColumn: 2, field: 'accountCode' }, { sourceColumn: 3, field: 'amount' }], valueKind: 'amount',
      });
      const requestBody = { token: uploaded.token, target: { targetKind: 'budget', versionId: version.id }, plan: cleaningPlan };
      const analyzedResponse = await authFetch(`${base}/io/cleaning/analyze`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(requestBody) });
      expect(analyzedResponse.status).toBe(200);
      expect(await analyzedResponse.json()).toMatchObject({ counts: { effective: 1, errors: 0, unresolved: 0 } });

      const previewResponse = await authFetch(`${base}/io/cleaning/preview`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(requestBody) });
      expect(previewResponse.status).toBe(201);
      const preview = await previewResponse.json() as any;
      expect(preview.summary.actions).toMatchObject({ insert: 1 });
      expect(fs.existsSync(path.join(cleaningUploads.directory, `${uploaded.token}.xlsx`))).toBe(false);
      const page = await (await authFetch(`${base}/io/cleaning/previews/${preview.importBatchId}/rows?page=1&pageSize=100&action=insert`)).json() as any;
      expect(page).toMatchObject({ total: 1, items: [{ sheet_name: '非标表', row_number: 3, action: 'insert' }] });

      const forged = await authFetch(`${base}/io/import-batches/${preview.importBatchId}/confirm`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ entries: [{ amount: '999999' }] }),
      });
      expect(forged.status).toBe(400);
      expect(await forged.json()).toMatchObject({ code: 'VALIDATION_FAILED' });
      const confirmed = await authFetch(`${base}/io/import-batches/${preview.importBatchId}/confirm`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      expect(confirmed.status).toBe(200);
      expect((holder.getDb().prepare('SELECT amount_cents FROM budget_entry WHERE version_id=? AND org_id=? AND account_id=?').get(version.id, fx.orgIds.shanghai, fx.accIds.incomeMain) as any).amount_cents).toBe(12_345);
      expect((await authFetch(`${base}/io/cleaning/previews/${preview.importBatchId}/rows`)).status).toBe(409);
      const source = await authFetch(`${base}/io/import-batches/${preview.importBatchId}/source`);
      expect(source.status).toBe(200);
      expect(Buffer.from(await source.arrayBuffer()).equals(file)).toBe(true);

      const templateResponse = await authFetch(`${base}/io/cleaning/templates`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({
          name: 'HTTP 模板', targetKind: 'budget', config: { headerRow: 2, dataStartRow: 3, columns: cleaningPlan.columns, valueKind: 'amount', amountUnit: 'yuan', signConvention: 'display_positive' },
        }),
      });
      expect(templateResponse.status).toBe(201);
      expect(await templateResponse.json()).toMatchObject({ name: 'HTTP 模板', targetKind: 'budget' });
      expect(await (await authFetch(`${base}/io/cleaning/templates?targetKind=budget`)).json()).toMatchObject({ items: [{ name: 'HTTP 模板' }] });

      const aliasResponse = await authFetch(`${base}/io/cleaning/aliases`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ targetKind: 'budget', mappingKind: 'account', sourceText: '主营收入', targetCode: 'I01' }),
      });
      expect(aliasResponse.status).toBe(201);
      const alias = await aliasResponse.json() as any;
      expect(alias).toMatchObject({ sourceText: '主营收入', targetCode: 'I01' });
      const patched = await authFetch(`${base}/io/cleaning/aliases/${alias.id}`, {
        method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ sourceText: '主业收入' }),
      });
      expect(await patched.json()).toMatchObject({ sourceText: '主业收入' });
      expect((await authFetch(`${base}/io/cleaning/aliases/${alias.id}`, { method: 'DELETE' })).status).toBe(204);

      profiles.createSourceProfile(holder.getDb(), {
        code: 'HTTP-ERP', name: 'HTTP 财务源', config: { ownedOrgCodes: ['SH'], ownedAccountCodes: ['I01'], amountUnit: 'yuan' },
      });
      const standardFile = await xlsx([{ name: '实际数导入', rows: [
        ['年度', '截止日期', '组织编码', '科目编码', '累计金额(元)', '累计数量', '备注'],
        [2026, '2026-06-30', 'SH', 'I01', '1.00', '', ''],
      ] }]);
      const standardForm = new FormData(); standardForm.append('file', new Blob([standardFile]), 'standard.xlsx');
      const standardConflict = await authFetch(`${base}/io/actual/import`, { method: 'POST', body: standardForm });
      expect(standardConflict.status).toBe(409);
      expect(await standardConflict.json()).toMatchObject({ code: 'FINANCE_OWNED_CONFLICT' });

      const historyForm = new FormData(); historyForm.append('file', new Blob([standardFile]), 'history.xlsx'); historyForm.append('history', 'true');
      const historyPreviewResponse = await authFetch(`${base}/io/actual/import`, { method: 'POST', body: historyForm });
      expect(historyPreviewResponse.status).toBe(200);
      const historyPreview = await historyPreviewResponse.json() as any;
      expect(historyPreview.importBatchId).toBeGreaterThan(0);
      await authFetch(`${base}/io/import-batches/${historyPreview.importBatchId}/cancel`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' });
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      holder.getDb().close();
    }
  });
});

describe('NEWFC_CLEANING_AI 开关', () => {
  // CLEANING_AI_ENABLED 在 backend/src/modules/io/import-limits.ts 模块加载时读取
  // process.env.NEWFC_CLEANING_AI 并缓存为顶层常量，用例内改 env 对已加载模块无效。
  // 因此每个用例先 vi.resetModules() 再动态 import，让开关在新模块图里按当前 env 重新求值；
  // 本文件其余用例的静态 import 绑定不受 resetModules 影响。
  function restoreEnv(key: string, oldValue: string | undefined): void {
    if (oldValue === undefined) delete process.env[key];
    else process.env[key] = oldValue;
  }

  it('开关关闭时 AI 结构建议返回不可用且零模型调用（即使模型端点已配置）', async () => {
    const oldFlag = process.env.NEWFC_CLEANING_AI;
    const oldBaseUrl = process.env.AI_BASE_URL;
    process.env.NEWFC_CLEANING_AI = '0';
    // 配置一个本机 stub 端点使 modelConfigured() 为 true，确保拦截只能来自开关而非「未配置模型」。
    process.env.AI_BASE_URL = 'http://127.0.0.1:9';
    // 模型调用最终走全局 fetch（EnvChatModel.post）；spy 即可跨模块图断言零调用。
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockRejectedValue(new Error('开关关闭时不应发生模型调用'));
    try {
      vi.resetModules();
      const { CLEANING_AI_ENABLED } = await import('../src/modules/io/import-limits');
      expect(CLEANING_AI_ENABLED).toBe(false);
      const { modelConfigured } = await import('../src/assistant/model');
      expect(modelConfigured()).toBe(true);
      const { suggestCleaningStructure: suggestWithFlagOff } = await import('../src/modules/io/cleaning/suggest');
      const file = await xlsx([{ name: '预算', rows: [['组织', '科目', '金额'], ['上海', '收入', 1]] }]);
      const inspection = inspectWorkbook(await loadCleaningWorkbook(file));
      await expect(suggestWithFlagOff(inspection, 'budget')).resolves.toEqual({ available: false, suggestion: null });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      restoreEnv('NEWFC_CLEANING_AI', oldFlag);
      restoreEnv('AI_BASE_URL', oldBaseUrl);
    }
  });

  it('对照组：开关开启且模型端点已配置时真实发起一次模型调用并采纳合法建议', async () => {
    const oldFlag = process.env.NEWFC_CLEANING_AI;
    const oldBaseUrl = process.env.AI_BASE_URL;
    process.env.NEWFC_CLEANING_AI = '1';
    process.env.AI_BASE_URL = 'http://127.0.0.1:9';
    const modelPayload = {
      sheet: '预算', headerRow: 1, dataStartRow: 2,
      columns: [{ col: 3, field: 'amount', confidence: 0.9, reason: '金额列' }],
      suspectedExcludedRows: [], warnings: [],
    };
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockResolvedValue(new Response(
      JSON.stringify({ choices: [{ message: { content: JSON.stringify(modelPayload) } }] }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    ));
    try {
      vi.resetModules();
      const { CLEANING_AI_ENABLED } = await import('../src/modules/io/import-limits');
      expect(CLEANING_AI_ENABLED).toBe(true);
      const { suggestCleaningStructure: suggestWithFlagOn } = await import('../src/modules/io/cleaning/suggest');
      const file = await xlsx([{ name: '预算', rows: [['组织', '科目', '金额'], ['上海', '收入', 1]] }]);
      const inspection = inspectWorkbook(await loadCleaningWorkbook(file));
      const result = await suggestWithFlagOn(inspection, 'budget');
      expect(result.available).toBe(true);
      expect(result.suggestion).toMatchObject({ sheet: '预算', headerRow: 1, dataStartRow: 2 });
      expect(fetchSpy).toHaveBeenCalledTimes(1);
      expect(String(fetchSpy.mock.calls[0][0])).toBe('http://127.0.0.1:9/chat/completions');
    } finally {
      fetchSpy.mockRestore();
      restoreEnv('NEWFC_CLEANING_AI', oldFlag);
      restoreEnv('AI_BASE_URL', oldBaseUrl);
    }
  });

  it('开关关闭时确定性手工流程 analyze→手工映射→preview→confirm 完整可用', async () => {
    const oldFlag = process.env.NEWFC_CLEANING_AI;
    process.env.NEWFC_CLEANING_AI = '0';
    try {
      vi.resetModules();
      const { CLEANING_AI_ENABLED } = await import('../src/modules/io/import-limits');
      expect(CLEANING_AI_ENABLED).toBe(false);
      // 确定性链路在新模块图（开关已求值为 false）里动态加载，确保与开关关闭同图运行。
      const { applyCleaningPlan: applyWithFlagOff } = await import('../src/modules/io/cleaning/apply');
      const previewModule = await import('../src/modules/io/cleaning/preview');
      const importService = await import('../src/modules/import/import.service');
      const db = testDb();
      const fx = buildFixture(db);
      const version = budget.createVersion(db, { year: 2026, name: '开关关闭预算' });
      const file = await xlsx([{ name: '手工映射', rows: [['组织', '科目', '金额'], ['SH', 'I01', '100']] }]);
      const workbook = await loadCleaningWorkbook(file);
      const analysis = applyWithFlagOff(db, workbook, { targetKind: 'budget', versionId: version.id }, plan({
        targetKind: 'budget',
        sheets: [{ sheetName: '手工映射', headerRow: 1, dataStartRow: 2, dataEndRow: 2 }],
        columns: [
          { sourceColumn: 1, field: 'orgCode' },
          { sourceColumn: 2, field: 'accountCode' },
          { sourceColumn: 3, field: 'amount' },
        ],
        valueKind: 'amount',
      }));
      expect(analysis.errors).toEqual([]);
      expect(analysis.unresolved).toEqual([]);
      const pending = previewModule.createPendingCleaningPreview(db, { analysis, originalName: 'manual.xlsx', file });
      expect(previewModule.listPreviewRows(db, pending.importBatchId).items).toHaveLength(1);
      importService.commitBatch(db, pending.importBatchId);
      expect((db.prepare('SELECT amount_cents FROM budget_entry WHERE version_id=? AND org_id=? AND account_id=?')
        .get(version.id, fx.orgIds.shanghai, fx.accIds.incomeMain) as { amount_cents: number }).amount_cents).toBe(10_000);
      db.close();
    } finally {
      restoreEnv('NEWFC_CLEANING_AI', oldFlag);
    }
  });
});

describe('导入资源上限：sheet 数与解压字节', () => {
  // MAX_CLEANING_SHEETS 是 import-limits.ts 中的顶层硬编码常量（不可经 env 覆盖）；
  // sheet 数门禁在 loadCleaningWorkbook 内、ExcelJS 完整加载之后检查（workbook.ts:45）。
  it(`工作表数量超过 ${MAX_CLEANING_SHEETS} 个被拒绝`, async () => {
    const sheets = Array.from({ length: MAX_CLEANING_SHEETS + 1 }, (_, index) => ({
      name: `表${index + 1}`,
      rows: [['组织', '科目', '金额'], ['SH', 'I01', 1]],
    }));
    const file = await xlsx(sheets);
    await expect(loadCleaningWorkbook(file)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      message: expect.stringContaining(`工作表数量不能超过 ${MAX_CLEANING_SHEETS} 个`),
    });
  });

  it(`恰好 ${MAX_CLEANING_SHEETS} 个工作表通过上限检查`, async () => {
    const sheets = Array.from({ length: MAX_CLEANING_SHEETS }, (_, index) => ({
      name: `表${index + 1}`,
      rows: [['组织', '科目', '金额'], ['SH', 'I01', 1]],
    }));
    const workbook = await loadCleaningWorkbook(await xlsx(sheets));
    expect(workbook.worksheets).toHaveLength(MAX_CLEANING_SHEETS);
  });

  // 解压字节上限（xlsx-guard.ts 的 xmlByteLimit）由 maxDataRows 派生并夹在 [64MB, 512MB]，
  // 不可经 env 调整。因此不真的生成几百 MB，而是在 zip 层构造高膨胀率工作表：
  // 18_000 行 × 5KB 内联字符串 ≈ 90MB 解压字节（> 20_000 行档位的 80MB 阈值），
  // 内容高度重复，DEFLATE 后整个文件仅数百 KB，行数远低于行数门禁确保命中的是字节门禁。
  async function inflatedXlsx(rowCount: number, fillerBytes: number): Promise<Buffer> {
    const filler = 'x'.repeat(fillerBytes);
    const parts = ['<?xml version="1.0" encoding="UTF-8" standalone="yes"?><worksheet><sheetData>'];
    for (let index = 1; index <= rowCount; index++) {
      parts.push(`<row r="${index}"><c r="A${index}" t="inlineStr"><is><t>${filler}${index}</t></is></c></row>`);
    }
    parts.push('</sheetData></worksheet>');
    const zip = new JSZip();
    zip.file('xl/worksheets/sheet1.xml', parts.join(''));
    return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  }

  it('工作表 XML 解压字节超过安全上限被拒绝', async () => {
    const buffer = await inflatedXlsx(18_000, 5_000);
    await expect(assertSafeXlsx(buffer, 20_000, MAX_CLEANING_SHEETS)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      message: expect.stringContaining('解压后内容超过安全上限'),
    });
    // 构造 18k 行×5k 字节的样本本身耗时约 20s,全量并行时会超过默认 30s
  }, 120_000);
});
