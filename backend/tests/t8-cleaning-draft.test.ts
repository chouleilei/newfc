import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import fs from 'fs';
import os from 'os';
import path from 'path';
import crypto from 'crypto';
import { testDb, buildFixture, budget } from './helpers';
import { CleaningUploadStore } from '../src/modules/io/cleaning/upload-store';
import { chat } from '../src/assistant/service';
import { pageSnapshot } from './assistant-context';
import { applyCleaningPlan } from '../src/modules/io/cleaning/apply';
import { loadCleaningWorkbook } from '../src/modules/io/cleaning/workbook';
import { createPendingCleaningPreview } from '../src/modules/io/cleaning/preview';
import type { CleaningPlan } from '../src/modules/io/cleaning/plan';

async function fixture() {
  const db = testDb(); const fx = buildFixture(db);
  const version = budget.createVersion(db, { year: 2026, name: '清洗只读' });
  budget.saveEntries(db, version.id, [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '5' }]);
  const workbook = new ExcelJS.Workbook(); const sheet = workbook.addWorksheet('数据');
  sheet.addRow(['组织', '科目', '金额', '备注']); sheet.addRow(['SH', 'I01', '12.34', 'private-file-marker']);
  const file = Buffer.from(await workbook.xlsx.writeBuffer());
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'newfc-t8-cleaning-'));
  let now = Date.now(); const store = new CleaningUploadStore(directory, { now: () => now, ttlMs: 1000 });
  const upload = store.put('draft.xlsx', file, { ownerUserId: 0, targetKind: 'budget' });
  const plan: CleaningPlan = { version: 1, targetKind: 'budget', sheets: [{ sheetName: '数据', headerRow: 1, dataStartRow: 2, dataEndRow: 2 }], columns: [{ sourceColumn: 1, field: 'orgCode' }, { sourceColumn: 2, field: 'accountCode' }, { sourceColumn: 3, field: 'amount' }, { sourceColumn: 4, field: 'note' }], valueKind: 'amount', amountUnit: 'yuan', signConvention: 'display_positive', excludedRows: [], mappings: [] };
  const target = { targetKind: 'budget' as const, versionId: version.id };
  const request = (source: unknown = { token: upload.token, sha256: upload.sha256 }) => ({ message: '解释当前清洗修改', pageContext: { ...pageSnapshot({ pageKey: 'budget_edit', budgetVersionId: version.id, year: 2026 }), draft: { kind: 'cleaning_template', base: { clientKey: 'clean', operation: 'analyze', source }, changes: { plan, target: { ...target } } } } });
  const cleanup = () => { db.close(); fs.rmSync(directory, { recursive: true, force: true }); };
  return { db, version, file, directory, store, upload, plan, target, request, cleanup, expire: () => { now += 1001; } };
}

describe('T-8.4 清洗草稿文件边界', () => {
  it('当前上传只读解释差异、不续期、不创建批次、不暴露文件令牌或备注', async () => {
    const fx = await fixture();
    try {
      const metadataFile = path.join(fx.directory, `${fx.upload.token}.json`);
      const before = fs.readFileSync(metadataFile, 'utf8');
      const batchCount = fx.db.prepare('SELECT COUNT(*) count FROM import_batch').get();
      const entries = fx.db.prepare('SELECT * FROM budget_entry').all();
      const answer = await chat(fx.db, fx.request(), '', { cleaningUploads: fx.store });
      expect(answer.text).toContain('覆盖影响'); expect(answer.text).toContain('未保存');
      expect(answer.facts.find((f) => f.type === 'draft_validation')).toMatchObject({ data: { issues: [], unsaved: true } });
      expect(fs.readFileSync(metadataFile, 'utf8')).toBe(before);
      expect(fx.db.prepare('SELECT COUNT(*) count FROM import_batch').get()).toEqual(batchCount);
      expect(fx.db.prepare('SELECT * FROM budget_entry').all()).toEqual(entries);
      const persisted = JSON.stringify(fx.db.prepare('SELECT response_json FROM ai_message').all());
      for (const marker of [fx.upload.token, fx.upload.sha256, 'private-file-marker']) expect(persisted).not.toContain(marker);
    } finally { fx.cleanup(); }
  });

  it('他人文件、错目标、错指纹、过期和缺所有者的旧元数据都拒绝且无会话写入', async () => {
    const fx = await fixture();
    try {
      const another = fx.store.put('other.xlsx', fx.file, { ownerUserId: 8, targetKind: 'budget' });
      await expect(chat(fx.db, fx.request({ token: another.token, sha256: another.sha256 }), '', { cleaningUploads: fx.store })).rejects.toMatchObject({ code: 'FORBIDDEN' });
      const actual = fx.store.put('actual.xlsx', fx.file, { ownerUserId: 0, targetKind: 'actual-current' });
      await expect(chat(fx.db, fx.request({ token: actual.token, sha256: actual.sha256 }), '', { cleaningUploads: fx.store })).rejects.toMatchObject({ code: 'CONFLICT' });
      await expect(chat(fx.db, fx.request({ token: fx.upload.token, sha256: '0'.repeat(64) }), '', { cleaningUploads: fx.store })).rejects.toMatchObject({ code: 'CONFLICT' });
      const legacy = fx.store.put('legacy.xlsx', fx.file);
      const file = path.join(fx.directory, `${legacy.token}.json`); const metadata = JSON.parse(fs.readFileSync(file, 'utf8')); delete metadata.ownerUserId; fs.writeFileSync(file, JSON.stringify(metadata));
      await expect(chat(fx.db, fx.request({ token: legacy.token, sha256: legacy.sha256 }), '', { cleaningUploads: fx.store })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      fx.expire();
      await expect(chat(fx.db, fx.request(), '', { cleaningUploads: fx.store })).rejects.toMatchObject({ code: 'NOT_FOUND' });
      expect(fx.db.prepare('SELECT COUNT(*) count FROM ai_message').get()).toEqual({ count: 0 });
    } finally { fx.cleanup(); }
  });

  it('相同长度的文件篡改仍被真实指纹拒绝，读失败不触碰 sidecar', async () => {
    const fx = await fixture();
    try {
      const metadataFile = path.join(fx.directory, `${fx.upload.token}.json`); const before = fs.readFileSync(metadataFile, 'utf8');
      const changed = Buffer.from(fx.file); changed[changed.length - 1] ^= 1; fs.writeFileSync(path.join(fx.directory, `${fx.upload.token}.xlsx`), changed);
      expect(crypto.createHash('sha256').update(changed).digest('hex')).not.toBe(fx.upload.sha256);
      await expect(chat(fx.db, fx.request(), '', { cleaningUploads: fx.store })).rejects.toMatchObject({ code: 'CONFLICT' });
      expect(fs.readFileSync(metadataFile, 'utf8')).toBe(before);
    } finally { fx.cleanup(); }
  });

  it('有效 pending 预览可按原文件只读分析，失效预览和目标冲突拒绝', async () => {
    const fx = await fixture();
    try {
      const analysis = applyCleaningPlan(fx.db, await loadCleaningWorkbook(fx.file), fx.target, fx.plan);
      const preview = createPendingCleaningPreview(fx.db, { analysis, originalName: 'preview.xlsx', file: fx.file });
      fx.store.remove(fx.upload.token);
      const result = await chat(fx.db, fx.request({ batchId: preview.importBatchId, sha256: preview.sha256 }), '', { cleaningUploads: fx.store });
      expect(result.text).toContain('覆盖影响');
      const request = fx.request({ batchId: preview.importBatchId, sha256: preview.sha256 }); request.pageContext.draft.changes.target.versionId = 9999;
      await expect(chat(fx.db, request, '', { cleaningUploads: fx.store })).rejects.toMatchObject({ code: 'CONTEXT_CONFLICT' });
      fx.db.prepare("UPDATE import_batch SET status='cancelled' WHERE id=?").run(preview.importBatchId);
      await expect(chat(fx.db, fx.request({ batchId: preview.importBatchId, sha256: preview.sha256 }), '', { cleaningUploads: fx.store })).rejects.toMatchObject({ code: 'DRAFT_STALE' });
    } finally { fx.cleanup(); }
  });
});

it('清洗基线纯读取当前树指纹，变化时拒绝而不创建快照', async () => {
  const { createCleaningBaseline, assertCleaningBaseline } = await import('../src/modules/io/cleaning/baseline');
  const db = testDb(); buildFixture(db);
  try {
    const target = { targetKind: 'actual-current' as const, year: 2026, snapshotDate: '2026-06-30' };
    const before = db.prepare('SELECT total_changes() count').get();
    const baseline = createCleaningBaseline(db, target);
    assertCleaningBaseline(db, target, baseline);
    expect(db.prepare('SELECT total_changes() count').get()).toEqual(before);
    db.prepare("UPDATE org SET name='新名称' WHERE id=1").run();
    const changed = db.prepare('SELECT total_changes() count').get();
    expect(() => assertCleaningBaseline(db, target, baseline)).toThrow(/组织树/);
    expect(db.prepare('SELECT total_changes() count').get()).toEqual(changed);
  } finally { db.close(); }
});

it('已核验 pending 预览的业务基线变化后，助手拒绝复用旧差异', async () => {
  const fx = await fixture();
  try {
    const analysis = applyCleaningPlan(fx.db, await loadCleaningWorkbook(fx.file), fx.target, fx.plan);
    const preview = createPendingCleaningPreview(fx.db, { analysis, originalName: 'pending.xlsx', file: fx.file });
    fx.db.prepare('UPDATE budget_entry SET amount_cents=amount_cents+1 WHERE version_id=?').run(fx.version.id);
    await expect(chat(fx.db, fx.request({ batchId: preview.importBatchId, sha256: preview.sha256 }), '', { cleaningUploads: fx.store })).rejects.toMatchObject({ code: 'DRAFT_STALE' });
    expect(fx.db.prepare('SELECT COUNT(*) count FROM ai_message').get()).toEqual({ count: 0 });
  } finally { fx.cleanup(); }
});

it('文件解析期间取消时不落会话、批次、快照或文件续期', async () => {
  const fx = await fixture();
  try {
    const metadataFile = path.join(fx.directory, `${fx.upload.token}.json`);
    const before = fs.readFileSync(metadataFile, 'utf8');
    const changes = fx.db.prepare('SELECT total_changes() count').get();
    const controller = new AbortController();
    const pending = chat(fx.db, fx.request(), '', { cleaningUploads: fx.store, signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(fx.db.prepare('SELECT total_changes() count').get()).toEqual(changes);
    expect(fs.readFileSync(metadataFile, 'utf8')).toBe(before);
  } finally { fx.cleanup(); }
});
