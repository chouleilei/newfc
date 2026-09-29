import { afterEach, describe, expect, it, vi } from 'vitest';
import { createTestApp, authFetch } from './http-helpers';
import ExcelJS from 'exceljs';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { testDb, buildFixture, budget, type Fixture } from './helpers';
import type { DB } from '../src/db/connection';
import { AppError } from '../src/core/errors';
import { loadCleaningWorkbook } from '../src/modules/io/cleaning/workbook';
import { applyCleaningPlan } from '../src/modules/io/cleaning/apply';
import { createPendingCleaningPreview, reopenCleaningPreview } from '../src/modules/io/cleaning/preview';
import type { CleaningPlan, CleaningTarget } from '../src/modules/io/cleaning/plan';
import { CleaningUploadStore } from '../src/modules/io/cleaning/upload-store';
import * as imports from '../src/modules/import/import.service';

async function xlsx(sheets: { name: string; rows: unknown[][] }[]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  for (const definition of sheets) {
    const sheet = workbook.addWorksheet(definition.name);
    for (const row of definition.rows) sheet.addRow(row);
  }
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function budgetPlan(sheetName: string): CleaningPlan {
  return {
    version: 1,
    targetKind: 'budget',
    sheets: [{ sheetName, headerRow: 1, dataStartRow: 2, dataEndRow: 2 }],
    columns: [
      { sourceColumn: 1, field: 'orgCode' },
      { sourceColumn: 2, field: 'accountCode' },
      { sourceColumn: 3, field: 'amount' },
    ],
    valueKind: 'amount',
    amountUnit: 'yuan',
    signConvention: 'display_positive',
    excludedRows: [],
    mappings: [],
  };
}

function actualPlan(sheetName: string): CleaningPlan {
  return { ...budgetPlan(sheetName), targetKind: 'actual-current' };
}

async function makePendingBudgetPreview(db: DB, versionId: number, file: Buffer, originalName = 'reopen.xlsx') {
  const workbook = await loadCleaningWorkbook(file);
  const analysis = applyCleaningPlan(db, workbook, { targetKind: 'budget', versionId }, budgetPlan('非标表'));
  expect(analysis.errors).toEqual([]);
  expect(analysis.unresolved).toEqual([]);
  return createPendingCleaningPreview(db, { analysis, originalName, file });
}

const tempDirs: string[] = [];
afterEach(() => {
  while (tempDirs.length) fs.rmSync(tempDirs.pop()!, { recursive: true, force: true });
  vi.restoreAllMocks();
});

function makeStore(): CleaningUploadStore {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleaning-reopen-test-'));
  tempDirs.push(dir);
  const store = new CleaningUploadStore(dir);
  store.initialize();
  return store;
}

function storeFiles(store: CleaningUploadStore): string[] {
  return fs.readdirSync(store.directory).filter((name) => name.endsWith('.xlsx') || name.endsWith('.json'));
}

function sessionRow(db: DB, batchId: number) {
  return db.prepare('SELECT * FROM cleaning_reopen_session WHERE import_batch_id = ?').get(batchId) as
    | { upload_token: string; original_name: string; file_sha256: string; plan_json: string; target_json: string }
    | undefined;
}

describe('UX-16 清洗预览恢复服务', () => {
  it('恢复成功:取消旧批次、写入恢复会话与审计(不含 token),旧批次不能再确认', async () => {
    const db = testDb();
    const fx: Fixture = buildFixture(db);
    const version = budget.createVersion(db, { year: 2026, name: '恢复预算' });
    const file = await xlsx([{ name: '非标表', rows: [['组织', '科目', '金额'], ['SH', 'I01', '123.45']] }]);
    const preview = await makePendingBudgetPreview(db, version.id, file);
    const store = makeStore();

    const result = reopenCleaningPreview(db, preview.importBatchId, { store, actor: 'tester' });
    expect(result.reused).toBe(false);
    expect(result.sourceBatchId).toBe(preview.importBatchId);
    expect(result.sha256).toBe(preview.sha256);
    expect(result.originalName).toBe('reopen.xlsx');
    expect(result.plan.targetKind).toBe('budget');
    expect(result.plan.amountUnit).toBe('yuan');
    expect(result.target).toEqual({ targetKind: 'budget', versionId: version.id });

    // 旧批次已被取消且原件清空,不能再确认
    const oldBatch = imports.getBatch(db, preview.importBatchId);
    expect(oldBatch.status).toBe('cancelled');
    expect(oldBatch.file_blob.length).toBe(0);
    expect(() => imports.commitBatch(db, preview.importBatchId)).toThrow(/不能重复确认/);

    // 恢复会话按原批次唯一键写入,内容与返回一致
    const session = sessionRow(db, preview.importBatchId);
    expect(session).toBeDefined();
    expect(session!.upload_token).toBe(result.token);
    expect(session!.file_sha256).toBe(preview.sha256);
    expect(JSON.parse(session!.plan_json)).toMatchObject({ targetKind: 'budget' });
    expect(JSON.parse(session!.target_json)).toEqual({ targetKind: 'budget', versionId: version.id });

    // 临时副本真实可取回,内容与原文件一致
    const restored = store.get(result.token, false);
    expect(restored.buffer.equals(file)).toBe(true);

    // 审计留痕但不包含临时凭证
    const logs = db.prepare("SELECT detail_json FROM operation_log WHERE action = 'cleaning.reopen' AND entity_id = ?")
      .all(String(preview.importBatchId)) as { detail_json: string }[];
    expect(logs).toHaveLength(1);
    expect(logs[0].detail_json).not.toContain(result.token);
    expect(JSON.parse(logs[0].detail_json)).toMatchObject({ actor: 'tester', sha256: preview.sha256 });
    db.close();
  });

  it('重复请求(响应丢失重试)返回同一会话,不重复复制临时副本', async () => {
    const db = testDb();
    buildFixture(db);
    const version = budget.createVersion(db, { year: 2026, name: '幂等预算' });
    const file = await xlsx([{ name: '非标表', rows: [['组织', '科目', '金额'], ['SH', 'I01', '1.00']] }]);
    const preview = await makePendingBudgetPreview(db, version.id, file);
    const store = makeStore();
    const putSpy = vi.spyOn(store, 'put');

    const first = reopenCleaningPreview(db, preview.importBatchId, { store });
    const second = reopenCleaningPreview(db, preview.importBatchId, { store });
    expect(putSpy).toHaveBeenCalledTimes(1);
    expect(second.reused).toBe(true);
    expect(second.token).toBe(first.token);
    expect(second.plan).toEqual(first.plan);
    expect(second.target).toEqual(first.target);
    expect(storeFiles(store).filter((name) => name.endsWith('.xlsx'))).toHaveLength(1);
    db.close();
  });

  it('临时文件创建失败:旧批次保持待确认,不产生会话', async () => {
    const db = testDb();
    buildFixture(db);
    const version = budget.createVersion(db, { year: 2026, name: '失败预算' });
    const file = await xlsx([{ name: '非标表', rows: [['组织', '科目', '金额'], ['SH', 'I01', '1.00']] }]);
    const preview = await makePendingBudgetPreview(db, version.id, file);
    const store = makeStore();
    vi.spyOn(store, 'put').mockImplementation(() => { throw new Error('ENOSPC: 磁盘已满'); });

    expect(() => reopenCleaningPreview(db, preview.importBatchId, { store })).toThrow(/ENOSPC/);
    // 旧批次未被取消,仍可正常使用(确认路径照旧)
    expect(imports.getBatch(db, preview.importBatchId).status).toBe('pending');
    expect(sessionRow(db, preview.importBatchId)).toBeUndefined();
    expect(storeFiles(store)).toHaveLength(0);
    db.close();
  });

  it('取消事务失败:定点清理新临时副本,旧批次不被取消', async () => {
    const db = testDb();
    buildFixture(db);
    const version = budget.createVersion(db, { year: 2026, name: '回滚预算' });
    const file = await xlsx([{ name: '非标表', rows: [['组织', '科目', '金额'], ['SH', 'I01', '1.00']] }]);
    const preview = await makePendingBudgetPreview(db, version.id, file);
    const store = makeStore();

    expect(() => reopenCleaningPreview(db, preview.importBatchId, {
      store,
      cancel: () => { throw new Error('模拟取消事务失败'); },
    })).toThrow(/模拟取消事务失败/);
    expect(imports.getBatch(db, preview.importBatchId).status).toBe('pending');
    expect(imports.getBatch(db, preview.importBatchId).file_blob.length).toBeGreaterThan(0);
    expect(sessionRow(db, preview.importBatchId)).toBeUndefined();
    expect(storeFiles(store)).toHaveLength(0);
    db.close();
  });

  it('原件已随取消清除(预算目标):410 要求重传,并返回可恢复的计划与目标', async () => {
    const db = testDb();
    buildFixture(db);
    const version = budget.createVersion(db, { year: 2026, name: '已取消预算' });
    const file = await xlsx([{ name: '非标表', rows: [['组织', '科目', '金额'], ['SH', 'I01', '1.00']] }]);
    const preview = await makePendingBudgetPreview(db, version.id, file);
    imports.cancelBatch(db, preview.importBatchId);

    const store = makeStore();
    let caught: unknown;
    try {
      reopenCleaningPreview(db, preview.importBatchId, { store });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AppError);
    const error = caught as AppError;
    expect(error.status).toBe(410);
    expect(error.code).toBe('CLEANING_SOURCE_EXPIRED');
    expect(error.message).toContain('重新上传');
    expect(error.message).toContain('无法找回');
    const details = error.details as { plan: CleaningPlan; target: CleaningTarget; originalName: string; sha256: string; sourceBatchId: number };
    expect(details.plan.targetKind).toBe('budget');
    expect(details.plan.sheets).toHaveLength(1);
    // 预算目标在取消后仍可从批次 target_version_id 恢复
    expect(details.target).toEqual({ targetKind: 'budget', versionId: version.id });
    expect(details.originalName).toBe('reopen.xlsx');
    expect(details.sha256).toBe(preview.sha256);
    expect(storeFiles(store)).toHaveLength(0);
    db.close();
  });

  it('原件已随取消清除(实际数目标):从冻结摘要恢复 年度×截止日', async () => {
    const db = testDb();
    buildFixture(db);
    const target: CleaningTarget = { targetKind: 'actual-current', year: 2026, snapshotDate: '2026-06-30' };
    const file = await xlsx([{ name: '实际', rows: [['组织', '科目', '金额'], ['SH', 'I01', '10.00']] }]);
    const workbook = await loadCleaningWorkbook(file);
    const analysis = applyCleaningPlan(db, workbook, target, actualPlan('实际'));
    const preview = createPendingCleaningPreview(db, { analysis, originalName: 'actual.xlsx', file });
    imports.cancelBatch(db, preview.importBatchId);

    let caught: unknown;
    try {
      reopenCleaningPreview(db, preview.importBatchId, { store: makeStore() });
    } catch (error) {
      caught = error;
    }
    const error = caught as AppError;
    expect(error.status).toBe(410);
    // payload 已随取消清空:目标从创建时冻结的统一预览摘要恢复
    const details = error.details as { target: CleaningTarget };
    expect(details.target).toEqual({ targetKind: 'actual-current', year: 2026, snapshotDate: '2026-06-30' });
    db.close();
  });

  it('恢复会话的临时文件已过期/被清理:410 并返回会话中的计划与目标', async () => {
    const db = testDb();
    buildFixture(db);
    const version = budget.createVersion(db, { year: 2026, name: '过期预算' });
    const file = await xlsx([{ name: '非标表', rows: [['组织', '科目', '金额'], ['SH', 'I01', '1.00']] }]);
    const preview = await makePendingBudgetPreview(db, version.id, file);
    const store = makeStore();
    const first = reopenCleaningPreview(db, preview.importBatchId, { store });
    store.remove(first.token); // 模拟 TTL 过期后的物理清理

    let caught: unknown;
    try {
      reopenCleaningPreview(db, preview.importBatchId, { store });
    } catch (error) {
      caught = error;
    }
    const error = caught as AppError;
    expect(error.status).toBe(410);
    expect(error.message).toContain('重新上传');
    const details = error.details as { plan: CleaningPlan; target: CleaningTarget; sha256: string };
    expect(details.plan.targetKind).toBe('budget');
    expect(details.target).toEqual({ targetKind: 'budget', versionId: version.id });
    expect(details.sha256).toBe(preview.sha256);
    db.close();
  });

  it('非清洗批次与已确认批次不能恢复', async () => {
    const db = testDb();
    const fx = buildFixture(db);
    const version = budget.createVersion(db, { year: 2026, name: '普通导入' });
    const file = Buffer.from('not-a-cleaning-file');
    const plain = imports.createBatch(db, {
      kind: 'budget',
      targetVersionId: version.id,
      originalName: 'plain.xlsx',
      file,
      payload: { versionId: version.id, entries: [] },
      summary: {},
    });
    const store = makeStore();
    expect(() => reopenCleaningPreview(db, plain.id, { store })).toThrow(/不是非标准 Excel 清洗预览/);

    const committed = await makePendingBudgetPreview(db, version.id,
      await xlsx([{ name: '非标表', rows: [['组织', '科目', '金额'], ['SH', 'I01', '1.00']] }]));
    imports.commitBatch(db, committed.importBatchId);
    expect(() => reopenCleaningPreview(db, committed.importBatchId, { store })).toThrow(/已确认提交/);
    expect(fx.db.prepare('SELECT COUNT(*) AS count FROM cleaning_reopen_session').get()).toMatchObject({ count: 0 });
    db.close();
  });

  it('恢复后的新 token 可直接重新分析并创建全新预览', async () => {
    const db = testDb();
    buildFixture(db);
    const version = budget.createVersion(db, { year: 2026, name: '续接预算' });
    const file = await xlsx([{ name: '非标表', rows: [['组织', '科目', '金额'], ['SH', 'I01', '5.00']] }]);
    const preview = await makePendingBudgetPreview(db, version.id, file);
    const store = makeStore();
    const reopened = reopenCleaningPreview(db, preview.importBatchId, { store });

    // 走与前端一致的续接路径:token 取回文件 → 重新 analyze(可修改计划) → 全新预览
    const restored = store.get(reopened.token, true);
    const workbook = await loadCleaningWorkbook(restored.buffer);
    const changedPlan = budgetPlan('非标表');
    const analysis = applyCleaningPlan(db, workbook, reopened.target as CleaningTarget & { targetKind: 'budget' }, changedPlan);
    const fresh = createPendingCleaningPreview(db, { analysis, originalName: reopened.originalName, file: restored.buffer });
    expect(fresh.importBatchId).not.toBe(preview.importBatchId);
    expect(fresh.sha256).toBe(preview.sha256);
    expect(imports.getBatch(db, fresh.importBatchId).status).toBe('pending');
    expect(imports.getBatch(db, preview.importBatchId).status).toBe('cancelled');
    db.close();
  });
});

describe('UX-16 清洗预览恢复 HTTP 契约', () => {
  it('上传→预览→恢复→重复恢复→重新分析→全新预览闭环,旧批次不能确认', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'cleaning-reopen-http-'));
    tempDirs.push(dir);
    const { app, holder, cleaningUploads } = await createTestApp({ dbPath: path.join(dir, 'newfc.sqlite') });
    buildFixture(holder.getDb());
    const version = budget.createVersion(holder.getDb(), { year: 2026, name: 'HTTP 恢复预算' });
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', resolve));
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}/api`;
    try {
      const file = await xlsx([{ name: '非标表', rows: [['组织', '科目', '金额'], ['SH', 'I01', '42.00']] }]);
      const form = new FormData();
      form.append('targetKind', 'budget');
      form.append('file', new Blob([file]), '恢复测试.xlsx');
      const uploaded = await (await authFetch(`${base}/io/cleaning/workbook`, { method: 'POST', body: form })).json() as { token: string };
      const planBody = budgetPlan('非标表');
      const previewResponse = await authFetch(`${base}/io/cleaning/preview`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: uploaded.token, target: { targetKind: 'budget', versionId: version.id }, plan: planBody }),
      });
      expect(previewResponse.status).toBe(201);
      const preview = await previewResponse.json() as { importBatchId: number };

      // 生成预览后原上传 token 已删除,恢复服务重建临时文件
      expect(fs.existsSync(path.join(cleaningUploads.directory, `${uploaded.token}.xlsx`))).toBe(false);
      const reopenedResponse = await authFetch(`${base}/io/cleaning/previews/${preview.importBatchId}/reopen`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      expect(reopenedResponse.status).toBe(201);
      const reopened = await reopenedResponse.json() as { token: string; plan: CleaningPlan; target: CleaningTarget; sha256: string; reused: boolean };
      expect(reopened.reused).toBe(false);
      expect(reopened.target).toEqual({ targetKind: 'budget', versionId: version.id });
      expect(reopened.plan.targetKind).toBe('budget');

      // 重复请求幂等:同一 token,不再复制临时副本
      const retryResponse = await authFetch(`${base}/io/cleaning/previews/${preview.importBatchId}/reopen`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      expect(retryResponse.status).toBe(200);
      const retry = await retryResponse.json() as { token: string; reused: boolean };
      expect(retry.reused).toBe(true);
      expect(retry.token).toBe(reopened.token);
      expect(fs.readdirSync(cleaningUploads.directory).filter((name) => name.endsWith('.xlsx'))).toHaveLength(1);

      // 旧批次已取消,不能确认;逐行预览同样失效
      const confirmOld = await authFetch(`${base}/io/import-batches/${preview.importBatchId}/confirm`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      expect(confirmOld.status).toBe(409);

      // 新 token 走现有 analyze → preview 流程,创建全新待确认批次
      const analyzeResponse = await authFetch(`${base}/io/cleaning/analyze`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: reopened.token, target: reopened.target, plan: reopened.plan }),
      });
      expect(analyzeResponse.status).toBe(200);
      expect(await analyzeResponse.json()).toMatchObject({ counts: { effective: 1, errors: 0 } });
      const freshPreviewResponse = await authFetch(`${base}/io/cleaning/preview`, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ token: reopened.token, target: reopened.target, plan: reopened.plan }),
      });
      expect(freshPreviewResponse.status).toBe(201);
      const fresh = await freshPreviewResponse.json() as { importBatchId: number };
      expect(fresh.importBatchId).not.toBe(preview.importBatchId);

      // 非法批次 ID 与非清洗批次
      const badId = await authFetch(`${base}/io/cleaning/previews/abc/reopen`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      expect(badId.status).toBe(400);
      const missing = await authFetch(`${base}/io/cleaning/previews/99999/reopen`, {
        method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}',
      });
      expect(missing.status).toBe(404);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      holder.getDb().close();
    }
  });
});
