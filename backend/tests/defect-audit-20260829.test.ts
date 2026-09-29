import { describe, expect, it } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import ExcelJS from 'exceljs';
import { createApp } from '../src/server';
import { openDatabase, type DB } from '../src/db/connection';
import { applyMigrations, MIGRATIONS } from '../src/db/migrations';
import { buildFixture, standardBudgetVersion, testDb, budget, actual, metric, account, org } from './helpers';
import { runConsistencyChecks } from '../src/modules/check/consistency';
import { buildSheet, parseActualImport, resolveActualImport } from '../src/modules/io/excel';
import { assertSafeXlsx } from '../src/modules/io/xlsx-guard';
import { aiConfigurationIssue, modelConfig } from '../src/assistant/model';
import { executeTool } from '../src/assistant/tools';
import { writeLog } from '../src/modules/audit/log';
import * as importBatch from '../src/modules/import/import.service';
import { completionRate, scaledRatio } from '../src/core/money';
import { accuracyReport, freezeYear, historicalComparison } from '../src/modules/report/report.service';

async function closeServer(server: ReturnType<import('express').Express['listen']>): Promise<void> {
  await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
}

describe('2026-08-29 缺陷复核：HTTP 鉴权与输入边界', () => {
  it('鉴权先于大 JSON 解析，令牌登录/会话/登出形成完整闭环', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-auth-audit-'));
    const dbPath = path.join(dir, 'newfc.sqlite');
    const { app, holder } = await createApp({
      dbPath,
      auth: { username: 'audit-user', password: 'correct horse battery' },
    });
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;

    try {
      const anonymous = await fetch(`${base}/api/health`);
      expect(anonymous.status).toBe(401);
      expect(await anonymous.json()).toMatchObject({ code: 'UNAUTHORIZED' });

      // 非法 JSON 若先进入 body parser 会得到 400；这里必须在读取/解析正文前直接得到 401。
      const malformedAnonymous = await fetch(`${base}/api/backup/create`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{',
      });
      expect(malformedAnonymous.status).toBe(401);

      const failed = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.77' },
        body: JSON.stringify({ username: 'audit-user', password: 'wrong' }),
      });
      expect(failed.status).toBe(401);
      const failureDetail = holder.getDb()
        .prepare("SELECT detail_json FROM operation_log WHERE action='auth.login_failed' ORDER BY id DESC LIMIT 1")
        .get() as { detail_json: string };
      expect(JSON.parse(failureDetail.detail_json).ip).not.toBe('203.0.113.77');

      const login = await fetch(`${base}/api/auth/login`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ username: 'audit-user', password: 'correct horse battery' }),
      });
      expect(login.status).toBe(200);
      const session = await login.json() as { token: string; username: string };
      expect(session).toMatchObject({ username: 'audit-user' });
      expect(session.token).toMatch(/^[a-f0-9]{64}$/);

      const headers = { 'x-access-token': session.token };
      expect((await fetch(`${base}/api/health`, { headers })).status).toBe(200);
      const sessionResponse = await fetch(`${base}/api/auth/session`, { headers });
      expect(await sessionResponse.json()).toMatchObject({ authEnabled: true, username: 'audit-user' });

      const logout = await fetch(`${base}/api/auth/logout`, { method: 'POST', headers });
      expect(logout.status).toBe(200);
      expect((await fetch(`${base}/api/health`, { headers })).status).toBe(401);
    } finally {
      await closeServer(server);
      holder.getDb().close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('数组、对象和非数值查询参数稳定返回 400，备份创建带进程内冷却', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-query-audit-'));
    const dbPath = path.join(dir, 'newfc.sqlite');
    const { app, holder } = await createApp({ dbPath, auth: { username: '', password: '' } });
    const server = app.listen(0);
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;

    try {
      const paths = [
        '/api/logs?action=a&action=b',
        '/api/logs?entityType[kind]=budget',
        '/api/snapshots?treeType=org&treeType=account',
        '/api/backup/verify?file=a&file=b',
        '/api/finance/conversions?limit=abc',
        '/api/finance/mapping-versions?sourceProfileId=abc',
        '/api/finance/parallel-trials?conversionId=abc',
        '/api/versions?year=abc',
        '/api/actual/batches?year=1e400',
        '/api/io/import-batches?limit=NaN',
        '/api/io/export/actual-current/not-a-year',
      ];
      for (const requestPath of paths) {
        const response = await fetch(base + requestPath);
        expect(response.status, requestPath).toBe(400);
        expect(await response.json(), requestPath).toMatchObject({ code: 'VALIDATION_FAILED' });
      }

      for (const requestPath of ['/api/org/1/move', '/api/account/1/move']) {
        const response = await fetch(base + requestPath, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: '{}',
        });
        expect(response.status, requestPath).toBe(400);
        expect(await response.json(), requestPath).toMatchObject({ code: 'VALIDATION_FAILED' });
      }

      const health = await fetch(`${base}/api/health`);
      // 与迁移清单联动,避免每加一条迁移都要改断言
      const latestSchema = Math.max(...MIGRATIONS.map((migration) => migration.version));
      expect(await health.json()).toMatchObject({ ok: true, database: 'ready', schemaVersion: latestSchema });

      const uploadWorkbook = new ExcelJS.Workbook();
      uploadWorkbook.addWorksheet('实际数导入').addRow(['年度', '截止日期', '组织编码', '科目编码', '累计金额(元)']);
      const form = new FormData();
      form.append('file', new Blob([await uploadWorkbook.xlsx.writeBuffer()]), 'actual.xlsx');
      const uploadResponse = await fetch(`${base}/api/io/actual/import`, { method: 'POST', body: form });
      expect(uploadResponse.status).toBe(400);
      expect(await uploadResponse.json()).toMatchObject({ code: 'IMPORT_VALIDATION_FAILED' });

      buildFixture(holder.getDb());
      const historyWorkbook = new ExcelJS.Workbook();
      const historySheet = historyWorkbook.addWorksheet('实际数导入');
      historySheet.addRow(['年度', '截止日期', '组织编码', '科目编码', '累计金额(元)', '累计数量', '备注']);
      historySheet.addRow([2026, '2026-01-31', 'SH', 'I01', '100.00', '', '']);
      const historyForm = new FormData();
      historyForm.append('file', new Blob([await historyWorkbook.xlsx.writeBuffer()]), 'history.xlsx');
      historyForm.append('history', 'true');
      historyForm.append('snapshotDate', '2026-03-31');
      const historyResponse = await fetch(`${base}/api/io/actual/import`, { method: 'POST', body: historyForm });
      expect(historyResponse.status).toBe(200);
      const historyPreview = await historyResponse.json() as { importBatchId: number; snapshotDate: string; batches: { snapshotDate: string }[] };
      expect(historyPreview.snapshotDate).toBe('2026-03-31');
      expect(historyPreview.batches).toEqual([expect.objectContaining({ snapshotDate: '2026-03-31' })]);
      await fetch(`${base}/api/io/import-batches/${historyPreview.importBatchId}/cancel`, { method: 'POST' });

      const first = await fetch(`${base}/api/backup/create`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(first.status).toBe(200);
      const second = await fetch(`${base}/api/backup/create`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: '{}',
      });
      expect(second.status).toBe(429);
      expect(await second.json()).toMatchObject({ code: 'TOO_MANY_REQUESTS' });
    } finally {
      await closeServer(server);
      holder.getDb().close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('2026-08-29 缺陷复核：业务冲突边界', () => {
  it('存在关联导入批次的草稿删除返回可识别冲突，而不是 SQLite 500', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const version = budget.createVersion(db, { year: 2026, name: '待导入草稿' });
    importBatch.createBatch(db, {
      kind: 'budget',
      targetVersionId: version.id,
      originalName: 'budget.xlsx',
      file: Buffer.from('fictional'),
      payload: { versionId: version.id, entries: [] },
      summary: {},
    });
    expect(() => budget.deleteVersion(db, version.id)).toThrowError(expect.objectContaining({ status: 409, code: 'CONFLICT' }));
    expect(budget.getVersion(db, version.id).id).toBe(version.id);
    expect(fx.orgIds.root).toBeGreaterThan(0);
    db.close();
  });
});

function databaseAtV1(): DB {
  const db = openDatabase(':memory:');
  db.exec(`CREATE TABLE schema_migration (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const v1 = MIGRATIONS.find((migration) => migration.version === 1)!;
  db.exec(v1.sql);
  db.prepare('INSERT INTO schema_migration(version,name,applied_at) VALUES(1,?,?)')
    .run(v1.name, new Date().toISOString());
  db.prepare("INSERT INTO account(parent_id,code,name,type,sort_order,status,created_at,updated_at) VALUES(NULL,'A','测试收入','income',0,'active','2026-01-01','2026-01-01')").run();
  return db;
}

describe('2026-08-29 缺陷复核：迁移与快照完整性', () => {
  it('V2 在删旧表后或部分加列后中断均可幂等续做', () => {
    const v2 = MIGRATIONS.find((migration) => migration.version === 2)!;

    const afterDrop = databaseAtV1();
    const throughDrop = v2.sql.slice(0, v2.sql.indexOf('ALTER TABLE account_v2 RENAME TO account;'));
    afterDrop.exec(throughDrop);
    expect(afterDrop.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='account'").get()).toBeUndefined();
    expect(() => applyMigrations(afterDrop)).not.toThrow();
    expect(afterDrop.prepare("SELECT code,type FROM account WHERE code='A'").get()).toEqual({ code: 'A', type: 'income' });
    expect((afterDrop.prepare('PRAGMA table_info(actual_snapshot_entry)').all() as { name: string }[]).some((column) => column.name === 'quantity')).toBe(true);
    expect(afterDrop.pragma('foreign_key_check')).toEqual([]);
    afterDrop.close();

    const afterOneColumn = databaseAtV1();
    const beforeActualColumn = v2.sql.slice(0, v2.sql.indexOf('ALTER TABLE actual_current ADD COLUMN quantity INTEGER;'));
    afterOneColumn.exec(beforeActualColumn);
    expect((afterOneColumn.prepare('PRAGMA table_info(budget_entry)').all() as { name: string }[]).some((column) => column.name === 'quantity')).toBe(true);
    expect(() => applyMigrations(afterOneColumn)).not.toThrow();
    for (const table of ['budget_entry', 'actual_current', 'actual_snapshot_entry']) {
      const quantityColumns = (afterOneColumn.prepare(`PRAGMA table_info(${table})`).all() as { name: string }[])
        .filter((column) => column.name === 'quantity');
      expect(quantityColumns, table).toHaveLength(1);
    }
    expect(afterOneColumn.pragma('foreign_key_check')).toEqual([]);
    afterOneColumn.close();
  });

  it('V26 清理存量重复公式项，并由唯一索引阻止再次写入', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const version = standardBudgetVersion(fx);
    budget.lockVersion(db, version.id);

    db.exec(`
      DROP INDEX uq_report_metric_term_account_role;
      DROP INDEX uq_report_metric_term_metric_role;
      DROP INDEX uq_budget_metric_term_snapshot_account_role;
      DROP INDEX uq_budget_metric_term_snapshot_metric_role;
      DELETE FROM schema_migration WHERE version=26;
    `);
    const term = db.prepare('SELECT * FROM report_metric_term WHERE metric_id=? ORDER BY id LIMIT 1')
      .get(fx.metricIds.gross) as Record<string, unknown>;
    db.prepare(`INSERT INTO report_metric_term(metric_id,source_type,source_account_id,source_metric_id,coefficient,sort_order,role)
                VALUES(?,?,?,?,?,?,?)`).run(term.metric_id, term.source_type, term.source_account_id, term.source_metric_id, term.coefficient, term.sort_order, term.role);
    const snap = db.prepare('SELECT * FROM budget_metric_term_snapshot WHERE version_id=? ORDER BY id LIMIT 1')
      .get(version.id) as Record<string, unknown>;
    db.prepare(`INSERT INTO budget_metric_term_snapshot(version_id,metric_id,source_type,source_account_id,source_metric_id,coefficient,sort_order,role)
                VALUES(?,?,?,?,?,?,?,?)`).run(snap.version_id, snap.metric_id, snap.source_type, snap.source_account_id, snap.source_metric_id, snap.coefficient, snap.sort_order, snap.role);

    expect(applyMigrations(db).map((migration) => migration.version)).toEqual([26]);
    expect((db.prepare(`SELECT COUNT(*) AS count FROM report_metric_term
      WHERE metric_id=? AND source_type=? AND COALESCE(source_account_id,-1)=COALESCE(?,-1)
        AND COALESCE(source_metric_id,-1)=COALESCE(?,-1) AND role=?`).get(
      term.metric_id, term.source_type, term.source_account_id, term.source_metric_id, term.role,
    ) as { count: number }).count).toBe(1);
    expect(() => db.prepare(`INSERT INTO report_metric_term(metric_id,source_type,source_account_id,source_metric_id,coefficient,sort_order,role)
      VALUES(?,?,?,?,?,?,?)`).run(term.metric_id, term.source_type, term.source_account_id, term.source_metric_id, term.coefficient, term.sort_order, term.role)).toThrow(/UNIQUE/);
    db.close();
  });

  it('最终快照即使已被替代也不可删除，悬挂引用会被一致性检查检出', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const first = actual.saveActual(db, {
      year: 2026,
      snapshotDate: '2026-06-30',
      source: 'manual',
      mode: 'replace',
      entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '1' }],
    });
    db.prepare('UPDATE actual_year_state SET final_batch_id=? WHERE year=2026').run(first.batchId);
    actual.saveActual(db, {
      year: 2026,
      snapshotDate: '2026-06-30',
      source: 'manual',
      mode: 'replace',
      entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '2' }],
    });
    expect(() => actual.deleteSupersededBatch(db, first.batchId)).toThrow(/最终快照/);

    db.prepare("UPDATE actual_year_state SET status='frozen',final_batch_id=999999 WHERE year=2026").run();
    const result = runConsistencyChecks(db);
    const finalCheck = result.checks.find((check) => check.name === '年度最终快照引用有效性')!;
    expect(finalCheck.ok).toBe(false);
    expect(finalCheck.problems.join('\n')).toContain('指向不存在的批次');
    db.close();
  });

  it('同日历史分文件 upsert 会合并既有组织，不会只剩最后一份', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const first = actual.saveActual(db, {
      year: 2026,
      snapshotDate: '2026-06-30',
      source: 'excel_import',
      mode: 'upsert',
      history: true,
      entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '10.00' }],
    });
    const second = actual.saveActual(db, {
      year: 2026,
      snapshotDate: '2026-06-30',
      source: 'excel_import',
      mode: 'upsert',
      history: true,
      entries: [{ orgId: fx.orgIds.hangzhou, accountId: fx.accIds.incomeMain, amount: '20.00' }],
    });
    expect(actual.getBatchEntries(db, second.batchId)).toEqual(expect.arrayContaining([
      expect.objectContaining({ orgId: fx.orgIds.shanghai, amountCents: 1_000 }),
      expect.objectContaining({ orgId: fx.orgIds.hangzhou, amountCents: 2_000 }),
    ]));
    expect(actual.getBatchEntries(db, second.batchId)).toHaveLength(2);
    expect((db.prepare('SELECT status FROM actual_snapshot_batch WHERE id=?').get(first.batchId) as { status: string }).status).toBe('superseded');
    db.close();
  });
});

describe('2026-08-29 缺陷复核：Excel 输出', () => {
  it('buildSheet 保留首行标题且数据数值可直接计算', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = buildSheet(
      workbook,
      '测试报表',
      [{ header: '项目', width: 18 }, { header: '金额', width: 16, numFmt: '#,##0.00' }],
      [['收入', 123.45]],
      '年度预算测试标题',
      ['年度: 2026'],
    );
    const buffer = await workbook.xlsx.writeBuffer();
    const roundTrip = new ExcelJS.Workbook();
    await roundTrip.xlsx.load(buffer);
    const restored = roundTrip.getWorksheet('测试报表')!;
    expect(restored.getRow(1).getCell(1).value).toBe('年度预算测试标题');
    expect(restored.getRow(sheet.reportLayout.headerRowIndex).values).toEqual([undefined, '项目', '金额']);
    expect(restored.getRow(sheet.reportLayout.dataStartRow).getCell(2).value).toBe(123.45);
    expect(restored.getRow(sheet.reportLayout.dataStartRow).getCell(2).numFmt).toBe('#,##0.00');
  });

  it('ExcelJS 建立完整工作簿前由 XML 流式行数门禁提前拒绝', async () => {
    const workbook = new ExcelJS.Workbook();
    const sheet = workbook.addWorksheet('超限');
    for (let index = 0; index < 1_012; index++) sheet.addRow([index]);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    await expect(assertSafeXlsx(buffer, 10)).rejects.toThrow(/行数超过安全上限 10/);
  });

  it('结构化与扁平实际导入按明确单位解析，额外“本期金额”不会抢列', async () => {
    const structured = new ExcelJS.Workbook();
    const structuredSheet = structured.addWorksheet('收入表');
    structuredSheet.addRow(['填报年度: 2026']);
    structuredSheet.addRow(['截止日期: 2026-06-30']);
    structuredSheet.addRow(['预算组织编码: SH']);
    structuredSheet.addRow([]);
    structuredSheet.addRow(['科目/指标编码', '类别/单位', '累计实际数（元）', '备注']);
    structuredSheet.addRow(['I01', '收入 / 万元', 1_234_567, '']);
    const structuredResult = await parseActualImport(Buffer.from(await structured.xlsx.writeBuffer()));
    expect(structuredResult).toMatchObject({ ok: true, rows: [expect.objectContaining({ amountText: '1234567' })] });

    const flat = new ExcelJS.Workbook();
    const flatSheet = flat.addWorksheet('实际数导入');
    flatSheet.addRow(['年度', '截止日期', '组织编码', '科目编码', '累计金额(万元)', '本期金额(元)', '累计数量', '备注']);
    flatSheet.addRow([2026, '2026-06-30', 'SH', 'I01', 123.46, 55, '', '']);
    const flatResult = await parseActualImport(Buffer.from(await flat.xlsx.writeBuffer()));
    expect(flatResult).toMatchObject({ ok: true, rows: [expect.objectContaining({ amountText: '1234600.00' })] });
  });

  it('重复金额列与未标单位的金额列会直接拒绝，不再猜测', async () => {
    const duplicate = new ExcelJS.Workbook();
    const duplicateSheet = duplicate.addWorksheet('实际数导入');
    duplicateSheet.addRow(['年度', '截止日期', '组织编码', '科目编码', '累计金额(元)', '累计金额（元）']);
    duplicateSheet.addRow([2026, '2026-06-30', 'SH', 'I01', 1, 2]);
    await expect(parseActualImport(Buffer.from(await duplicate.xlsx.writeBuffer()))).rejects.toThrow(/匹配到多个列/);

    const ambiguous = new ExcelJS.Workbook();
    const ambiguousSheet = ambiguous.addWorksheet('实际数导入');
    ambiguousSheet.addRow(['年度', '截止日期', '组织编码', '科目编码', '累计金额']);
    ambiguousSheet.addRow([2026, '2026-06-30', 'SH', 'I01', 1]);
    await expect(parseActualImport(Buffer.from(await ambiguous.xlsx.writeBuffer()))).rejects.toThrow(/必须明确标注/);
  });

  it('实际导入预览会按 Excel 行阻断不适用于组织的科目', () => {
    const db = testDb();
    const fx = buildFixture(db);
    org.createOrg(db, { parentId: fx.orgIds.root, code: '010102', name: '江垭电站' });
    account.createAccount(db, { parentId: fx.accIds.incomeRoot, code: 'I1209', name: '索溪专属收入', type: 'income' });
    let thrown: unknown;
    try {
      resolveActualImport(db, {
        ok: true,
        errors: [],
        years: [2026],
        dates: ['2026-06-30'],
        rows: [{
          rowNumber: 2,
          year: 2026,
          snapshotDate: '2026-06-30',
          orgCode: '010102',
          accountCode: 'I1209',
          amountText: '100.00',
          quantityText: '',
          memo: '',
        }],
      }, false);
    } catch (error) {
      thrown = error;
    }
    expect(thrown).toMatchObject({
      code: 'IMPORT_VALIDATION_FAILED',
      errors: [expect.objectContaining({
        row: 2,
        field: 'orgCode',
        message: expect.stringContaining('科目 I1209 不适用于组织 010102'),
      })],
    });
    db.close();
  });
});

describe('2026-08-29 缺陷复核：完成率与指标边界', () => {
  it('极端比率降级为 N/A，且被引用指标不能停用', () => {
    expect(scaledRatio(Number.MAX_SAFE_INTEGER, 1, 1, 1)).toBeNull();
    const db = testDb();
    const fx = buildFixture(db);
    expect(() => metric.updateMetric(db, fx.metricIds.gross, { status: 'inactive' })).toThrow(/被其他指标公式引用,不能停用/);
    db.close();
  });

  it('负预算完成率为 N/A，冻结年度有缺口时不伪称同比', () => {
    expect(completionRate(10, -20)).toBeNull();
    const db = testDb();
    const fx = buildFixture(db);
    const closeYear = (year: number, budgetIncome: string, budgetCost: string, actualIncome: string, actualCost: string) => {
      const version = budget.createVersion(db, { year, name: `${year}预算` });
      budget.saveEntries(db, version.id, [
        { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: budgetIncome },
        { orgId: fx.orgIds.shanghai, accountId: fx.accIds.costSub, amount: budgetCost },
      ]);
      budget.lockVersion(db, version.id);
      budget.setCurrentVersion(db, version.id);
      const final = actual.saveActual(db, {
        year,
        snapshotDate: `${year}-12-31`,
        source: 'manual',
        mode: 'replace',
        entries: [
          { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: actualIncome },
          { orgId: fx.orgIds.shanghai, accountId: fx.accIds.costSub, amount: actualCost },
        ],
      });
      freezeYear(db, year, final.batchId);
    };
    closeYear(2024, '100.00', '50.00', '110.00', '50.00');
    closeYear(2026, '100.00', '120.00', '100.00', '110.00');

    const comparison = historicalComparison(db);
    const lossYear = comparison.years.find((row) => row.year === 2026)!;
    expect(lossYear.rateProfit).toBeNull();
    expect(lossYear.yoyProfit).toBeNull();
    const accuracy = accuracyReport(db, 2026);
    expect(accuracy.typeAccuracy.profit.rate).toBeNull();
    expect(accuracy.typeAccuracy.cost.rate).toBeCloseTo(110 / 120);
    expect(comparison.notes.join('\n')).toContain('只有相邻自然年度才计算同比');
    db.close();
  });
});

describe('2026-08-29 缺陷复核：AI 出境边界', () => {
  it('远程明文 HTTP 或复用登录口令时停用模型，但确定性助手仍可工作', () => {
    const keys = ['AI_BASE_URL', 'AI_API_KEY', 'NEWFC_ACCESS_PASSWORD', 'AI_ALLOW_INSECURE_HTTP'] as const;
    const previous = new Map(keys.map((key) => [key, process.env[key]]));
    try {
      process.env.AI_BASE_URL = 'https://model.example.com/v1';
      process.env.AI_API_KEY = 'same-secret';
      process.env.NEWFC_ACCESS_PASSWORD = 'same-secret';
      expect(aiConfigurationIssue()).toMatch(/不得与/);
      expect(modelConfig().baseUrl).toBeUndefined();

      process.env.AI_API_KEY = 'independent-key';
      process.env.AI_BASE_URL = 'http://198.51.100.20/v1';
      expect(aiConfigurationIssue()).toMatch(/必须使用 https/);
      expect(modelConfig().baseUrl).toBeUndefined();

      process.env.AI_BASE_URL = 'https://model.example.com/v1';
      expect(aiConfigurationIssue()).toBeUndefined();
      expect(modelConfig().baseUrl).toBe('https://model.example.com/v1');
    } finally {
      for (const key of keys) {
        const value = previous.get(key);
        if (value === undefined) delete process.env[key]; else process.env[key] = value;
      }
    }
  });

  it('操作日志工具对模型隐藏 IP、用户名与操作者字段', () => {
    const db = testDb();
    writeLog(db, 'auth.login_failed', 'auth', '-', {
      ip: '203.0.113.77',
      username: 'budgetadmin',
      nested: { actor: 'reviewer', harmless: '保留' },
    });
    const result = executeTool(db, 'get_operation_log', { pageSize: 10 }) as {
      items: { detail_json: string }[];
    };
    const detail = JSON.parse(result.items[0].detail_json);
    expect(detail).toMatchObject({
      ip: '[已脱敏]',
      username: '[已脱敏]',
      nested: { actor: '[已脱敏]', harmless: '保留' },
    });
    db.close();
  });
});
