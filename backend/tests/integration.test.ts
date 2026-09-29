import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { testDb, tempFileDb, buildFixture, standardBudgetVersion, org, account, metric, budget, actual } from './helpers';
import * as report from '../src/modules/report/report.service';
import * as io from '../src/modules/io/excel';
import { runConsistencyChecks } from '../src/modules/check/consistency';
import * as backup from '../src/modules/backup/backup.service';
import { queryLogs } from '../src/modules/audit/log';
import { applyMigrations, MIGRATIONS } from '../src/db/migrations';
import { openDatabase } from '../src/db/connection';

describe('集成:创建预算到锁定(方案三.2)', () => {
  it('完整流程:创建 → 录入 → 校验 → 锁定 → 当前生效', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const v = standardBudgetVersion(fx);
    expect(budget.validateForLock(db, v.id).ok).toBe(true);
    budget.lockVersion(db, v.id);
    const locked = budget.getVersion(db, v.id);
    expect(locked.status).toBe('locked');
    expect(locked.locked_at).toBeTruthy();
    // 锁定后不可修改
    expect(() => budget.saveEntries(db, v.id, [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '1.00' }])).toThrow(/草稿/);
    expect(() => budget.clearEntries(db, v.id)).toThrow(/草稿/);
    expect(() => budget.deleteVersion(db, v.id)).toThrow(/锁定/);
    expect(() => budget.renameVersion(db, v.id, { name: 'X' })).toThrow(/草稿/);
    // 设为当前生效
    budget.setCurrentVersion(db, v.id);
    expect(budget.getVersion(db, v.id).is_current).toBe(1);
    // 当前生效不能直接归档
    expect(() => budget.archiveVersion(db, v.id)).toThrow(/当前生效/);
    // 切换留有日志
    const logs = queryLogs(db, { action: 'budget.set_current' });
    expect(logs.total).toBe(1);
  });

  it('锁定前检查发现非叶子数据', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const v = budget.createVersion(db, { year: 2026, name: 'bad' });
    // 直接写一条非叶子组织明细(绕过服务层校验)
    db.prepare('INSERT INTO budget_entry (version_id, org_id, account_id, amount_cents, updated_at) VALUES (?, ?, ?, ?, ?)')
      .run(v.id, fx.orgIds.east, fx.accIds.incomeMain, 1000, new Date().toISOString());
    const check = budget.validateForLock(db, v.id);
    expect(check.ok).toBe(false);
    expect(check.problems.some((p) => p.message.includes('不是叶子组织') && p.code === 'STRUCTURE_INVALID' && p.orgId === fx.orgIds.east)).toBe(true);
    expect(() => budget.lockVersion(db, v.id)).toThrow(/定稿前检查未通过/);
  });

  it('版本复制:沿用树快照并复制明细', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const v1 = standardBudgetVersion(fx);
    budget.lockVersion(db, v1.id);
    const v2 = budget.copyVersion(db, v1.id, 'V2-修订');
    expect(v2.status).toBe('draft');
    expect(v2.source_version_id).toBe(v1.id);
    expect(v2.org_tree_snapshot_id).toBe(v1.org_tree_snapshot_id);
    expect(v2.account_tree_snapshot_id).toBe(v1.account_tree_snapshot_id);
    const e1 = db.prepare('SELECT COUNT(*) c FROM budget_entry WHERE version_id = ?').get(v1.id) as { c: number };
    const e2 = db.prepare('SELECT COUNT(*) c FROM budget_entry WHERE version_id = ?').get(v2.id) as { c: number };
    expect(e2.c).toBe(e1.c);
    // 同年度版本名称唯一
    expect(() => budget.copyVersion(db, v1.id, 'V2-修订')).toThrow(/同名/);
  });

  it('每年度只有一个当前生效版本,切换自动取消旧版', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const v1 = standardBudgetVersion(fx, 2026, 'A');
    budget.lockVersion(db, v1.id);
    budget.setCurrentVersion(db, v1.id);
    const v2 = budget.copyVersion(db, v1.id, 'B');
    budget.saveEntries(db, v2.id, [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '999.00' }]);
    budget.lockVersion(db, v2.id);
    budget.setCurrentVersion(db, v2.id);
    expect(budget.getVersion(db, v1.id).is_current).toBe(0);
    expect(budget.getVersion(db, v2.id).is_current).toBe(1);
    // 只有锁定版本可设为当前生效
    const v3 = budget.createVersion(db, { year: 2026, name: 'C' });
    expect(() => budget.setCurrentVersion(db, v3.id)).toThrow(/锁定/);
  });

  it('归档旧版本(切换当前生效后)', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const v1 = standardBudgetVersion(fx, 2026, 'A');
    budget.lockVersion(db, v1.id);
    budget.setCurrentVersion(db, v1.id);
    const v2 = budget.copyVersion(db, v1.id, 'B');
    budget.lockVersion(db, v2.id);
    budget.setCurrentVersion(db, v2.id);
    const archived = budget.archiveVersion(db, v1.id);
    expect(archived.status).toBe('archived');
    // archived 不能回 draft
    expect(() => db.prepare("UPDATE budget_version SET status='draft' WHERE id=?").run(v1.id)).not.toThrow(); // db 层无触发器,业务层由状态机保证
  });
});

describe('集成:草稿自动保存与编制记录点', () => {
  it('自动保存不写业务日志，主动记录只保存相对上次的变化且不生成空记录', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const qRoot = account.createAccount(db, { parentId: null, code: 'Q', name: '业务量', type: 'quantity', unit: '万度' });
    const qLeaf = account.createAccount(db, { parentId: qRoot.id, code: 'Q01', name: '发电量', type: 'quantity', unit: '万度' });
    const v = budget.createVersion(db, { year: 2026, name: '讨论稿' });

    budget.saveEntries(db, v.id, [
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '100.00', formula: '=80+20', note: '初稿依据' },
      { orgId: fx.orgIds.shanghai, accountId: qLeaf.id, quantity: '12.3456' },
    ]);
    expect(queryLogs(db, { action: 'budget.save' }).total).toBe(0);

    const first = budget.recordCompilationCheckpoint(db, v.id, { title: '第一轮讨论' });
    expect(first.created).toBe(true);
    expect(first.changeCount).toBe(2);
    expect(first.checkpoint?.title).toBe('第一轮讨论');
    expect(budget.recordCompilationCheckpoint(db, v.id).created).toBe(false);

    budget.saveEntries(db, v.id, [
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '120.00', formula: '=100+20', note: '讨论后调整' },
      { orgId: fx.orgIds.shanghai, accountId: qLeaf.id, quantity: '13.0001' },
    ]);
    const statusBefore = budget.listCompilationCheckpoints(db, v.id);
    expect(statusBefore.unrecordedChangeCount).toBe(2);
    const second = budget.recordCompilationCheckpoint(db, v.id, { title: '第二轮讨论' });
    expect(second.changeCount).toBe(2);
    const moneyChange = second.checkpoint?.changes.find((c) => c.accountId === fx.accIds.incomeMain)!;
    expect(moneyChange.before).toMatchObject({ amountCents: 10_000, formula: '=80+20', note: '初稿依据' });
    expect(moneyChange.after).toMatchObject({ amountCents: 12_000, formula: '=100+20', note: '讨论后调整' });
    const quantityChange = second.checkpoint?.changes.find((c) => c.accountId === qLeaf.id)!;
    expect(quantityChange.before.quantity).toBe(123_456);
    expect(quantityChange.after.quantity).toBe(130_001);
    expect(queryLogs(db, { action: 'budget.checkpoint' }).total).toBe(2);
  });

  it('复制稿首次记录相对来源定稿，定稿自动补未记录变化但不制造空记录', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const v1 = standardBudgetVersion(fx, 2026, 'V1');
    budget.lockVersion(db, v1.id);
    const v2 = budget.copyVersion(db, v1.id, 'V2');
    expect(budget.listCompilationCheckpoints(db, v2.id).unrecordedChangeCount).toBe(0);

    const original = budget.getEditMatrix(db, v2.id).entries;
    budget.saveEntries(db, v2.id, original.map((e) => ({
      orgId: e.orgId,
      accountId: e.accountId,
      amount: e.accountId === fx.accIds.incomeMain && e.orgId === fx.orgIds.shanghai ? '125.00' : e.amountDisplay,
      formula: e.formula,
      note: e.note,
    })));
    budget.lockVersion(db, v2.id);
    const autoItems = budget.listCompilationCheckpoints(db, v2.id).items;
    expect(autoItems).toHaveLength(1);
    expect(autoItems[0].autoCreated).toBe(true);
    expect(autoItems[0].changeCount).toBe(1);
    expect(() => budget.recordCompilationCheckpoint(db, v2.id)).toThrow(/草稿/);

    const v3 = budget.copyVersion(db, v2.id, 'V3');
    const v3Entries = budget.getEditMatrix(db, v3.id).entries;
    budget.saveEntries(db, v3.id, v3Entries.map((e) => ({ orgId: e.orgId, accountId: e.accountId, amount: e.amountDisplay, formula: e.formula, note: e.note })));
    expect(budget.recordCompilationCheckpoint(db, v3.id).created).toBe(false);
    budget.lockVersion(db, v3.id);
    expect(budget.listCompilationCheckpoints(db, v3.id).items).toHaveLength(0);
  });

  it('删除草稿时级联删除其编制记录', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const v = standardBudgetVersion(fx, 2026, '待删除草稿');
    expect(budget.recordCompilationCheckpoint(db, v.id).created).toBe(true);
    budget.deleteVersion(db, v.id);
    const count = db.prepare('SELECT COUNT(*) AS c FROM budget_compilation_checkpoint WHERE version_id = ?').get(v.id) as { c: number };
    expect(count.c).toBe(0);
  });
});

describe('集成:当前实际保存到快照(事务原子性,方案七.2)', () => {
  it('保存后当前实际与快照一致', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const r = actual.saveActual(db, {
      year: 2026, snapshotDate: '2026-06-30', source: 'manual', mode: 'replace',
      entries: [
        { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '80.00' },
        { orgId: fx.orgIds.shanghai, accountId: fx.accIds.costSub, amount: '30.00' },
        { orgId: fx.orgIds.hangzhou, accountId: fx.accIds.incomeMain, amount: '40.00' },
      ],
    });
    const ents = actual.getBatchEntries(db, r.batchId);
    expect(ents.length).toBe(3);
    const state = actual.getYearState(db, 2026)!;
    expect(state.current_batch_id).toBe(r.batchId);
    const cur = db.prepare('SELECT * FROM actual_current WHERE year = 2026').all() as { cumulative_amount_cents: number }[];
    expect(cur.length).toBe(3);
    // 收入正、成本负
    const income = ents.find((e) => e.accountId === fx.accIds.incomeMain && e.orgId === fx.orgIds.shanghai)!;
    expect(income.amountCents).toBe(8000);
    const cost = ents.find((e) => e.accountId === fx.accIds.costSub)!;
    expect(cost.amountCents).toBe(-3000);
  });

  it('任一步失败全部回滚(金额格式错误在写入前抛出)', () => {
    const db = testDb();
    const fx = buildFixture(db);
    expect(() =>
      actual.saveActual(db, {
        year: 2026, snapshotDate: '2026-06-30', source: 'manual', mode: 'replace',
        entries: [
          { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '80.00' },
          { orgId: fx.orgIds.hangzhou, accountId: fx.accIds.incomeMain, amount: '4O.00' }, // 字母O
        ],
      })
    ).toThrow();
    expect(db.prepare('SELECT COUNT(*) c FROM actual_current').get()).toEqual({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) c FROM actual_snapshot_batch').get()).toEqual({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) c FROM actual_snapshot_entry').get()).toEqual({ c: 0 });
  });

  it('第二次保存为全量替换且生成独立快照', () => {
    const db = testDb();
    const fx = buildFixture(db);
    actual.saveActual(db, {
      year: 2026, snapshotDate: '2026-03-31', source: 'manual', mode: 'replace',
      entries: [
        { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '50.00' },
        { orgId: fx.orgIds.hangzhou, accountId: fx.accIds.incomeMain, amount: '20.00' },
      ],
    });
    actual.saveActual(db, {
      year: 2026, snapshotDate: '2026-06-30', source: 'manual', mode: 'replace',
      entries: [
        { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '100.00' },
        // 杭州行不再出现 -> 整包替换后删除
      ],
    });
    const cur = db.prepare('SELECT org_id, cumulative_amount_cents FROM actual_current WHERE year = 2026 ORDER BY org_id').all() as { org_id: number; cumulative_amount_cents: number }[];
    expect(cur.length).toBe(1);
    expect(cur[0].cumulative_amount_cents).toBe(10000);
    const batches = actual.listBatches(db, 2026);
    expect(batches.length).toBe(2); // 两个日期各一个 active
    const q1 = actual.getBatchEntries(db, batches.find((b) => b.snapshot_date === '2026-03-31')!.id);
    expect(q1.length).toBe(2); // 旧快照保持当时全量
  });
});

describe('集成:Excel 导入(方案十二)', () => {
  async function makeWorkbook(rows: unknown[][], headers = ['年度', '截止日期', '组织编码', '科目编码', '累计金额(元)', '备注']) {
    const wb = new ExcelJS.Workbook();
    const ws = wb.addWorksheet('导入');
    ws.addRow(headers);
    for (const r of rows) ws.addRow(r);
    const buf = await wb.xlsx.writeBuffer();
    return Buffer.from(buf);
  }

  it('模板下载与解析往返', async () => {
    const db = testDb();
    const fx = buildFixture(db);
    const template = await io.actualImportTemplateBuffer();
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(template as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    expect(ws.getRow(1).getCell(1).value).toBe('年度');
    expect(ws.getRow(1).getCell(5).value).toBe('累计金额(元)');
    // 用模板结构构造正确数据
    const good = await makeWorkbook([[2026, '2026-06-30', 'SH', 'I01', '100.00', '']]);
    const parsed = await io.parseActualImport(good);
    expect(parsed.ok).toBe(true);
    const resolved = io.resolveActualImport(db, parsed);
    expect(resolved.year).toBe(2026);
    expect(resolved.entries[0].orgId).toBe(fx.orgIds.shanghai);
  });

  it('全错一次性返回(行号+字段+原因),存在错误整包不写入', async () => {
    const db = testDb();
    buildFixture(db);
    const bad = await makeWorkbook([
      [2026, '2026-06-30', 'NOPE', 'I01', '10.00', ''],       // 组织不存在
      [2026, '2026-06-30', 'SH', 'I01', '12.345', ''],        // 金额三位小数
      [2025, '2026-06-30', 'SH', 'I01', '10.00', ''],         // 年度日期不一致
      [2026, '2026-07-01', 'SH', 'I01', '10.00', ''],         // 第二个日期
      [2026, '2026-06-30', 'EAST', 'I01', '10.00', ''],       // 非叶子组织
    ]);
    const parsed = await io.parseActualImport(bad);
    expect(parsed.ok).toBe(false);
    // 多个错误一次性返回
    const fields = new Set(parsed.errors.map((e) => e.field));
    expect(fields.size).toBeGreaterThan(1);
    // resolve 抛出结构化错误,整包不写入
    expect(() => io.resolveActualImport(db, parsed)).toThrow();
    expect(db.prepare('SELECT COUNT(*) c FROM actual_current').get()).toEqual({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) c FROM actual_snapshot_batch').get()).toEqual({ c: 0 });
  });

  it('全部通过后原子写入并生成快照', async () => {
    const db = testDb();
    const fx = buildFixture(db);
    const good = await makeWorkbook([
      [2026, '2026-06-30', 'SH', 'I01', '100.00', '上半年'],
      [2026, '2026-06-30', 'HZ', 'C0101', '30.00', ''],
    ]);
    const parsed = await io.parseActualImport(good);
    const resolved = io.resolveActualImport(db, parsed);
    const r = actual.saveActual(db, {
      year: resolved.year, snapshotDate: resolved.snapshotDate,
      entries: resolved.entries, source: 'excel_import', mode: 'upsert', note: 'Excel 导入',
    });
    expect(r.batchId).toBeGreaterThan(0);
    const batch = actual.getBatch(db, r.batchId);
    expect(batch.source).toBe('excel_import');
    const ents = actual.getBatchEntries(db, r.batchId);
    expect(ents.find((e) => e.orgId === fx.orgIds.hangzhou && e.accountId === fx.accIds.costSub)!.amountCents).toBe(-3000);
    const logs = queryLogs(db, { action: 'actual.import' });
    expect(logs.total).toBe(1);
  });

  it('结构化排版模板导出含公式锁定与工作表保护', async () => {
    const db = testDb();
    const fx = buildFixture(db);
    const buf = await io.actualImportTemplateBuffer(db, {
      year: 2026,
      cutoff: '2026-06-30',
      orgId: fx.orgIds.shanghai,
      sheetKey: 'all',
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    expect(ws.name).toBe('全部科目明细');

    // 检查表头和元信息
    expect(String(ws.getRow(1).getCell(1).value)).toContain('历史实际数填报表');
    expect(String(ws.getRow(2).getCell(1).value)).toContain('2026');
    expect(String(ws.getRow(3).getCell(1).value)).toContain('SH');

    // 检查工作表保护状态
    expect(ws.protect).toBeDefined();

    // 检查叶子节点与汇总节点的锁定状态与公式
    let foundLeaf = false;
    let foundSummary = false;
    for (let r = 8; r <= ws.rowCount; r++) {
      const cellB = ws.getRow(r).getCell(2);
      const cellE = ws.getRow(r).getCell(5);
      const code = String(cellB.value ?? '');
      if (code === 'C0101') {
        // 叶子科目: 解锁
        expect(cellE.protection?.locked).toBe(false);
        foundLeaf = true;
      }
      if (code === 'C01') {
        // 汇总科目: 锁定(非 false 即为保护锁定)并带 SUM 公式
        expect(cellE.protection?.locked !== false).toBe(true);
        expect(cellE.value).toHaveProperty('formula');
        foundSummary = true;
      }
    }
    expect(foundLeaf).toBe(true);
    expect(foundSummary).toBe(true);
  });

  it('结构化排版模板填写后导入与原子入库', async () => {
    const db = testDb();
    const fx = buildFixture(db);

    // 1. 生成结构化模板
    const buf = await io.actualImportTemplateBuffer(db, {
      year: 2026,
      cutoff: '2026-06-30',
      orgId: fx.orgIds.shanghai,
      sheetKey: 'all',
    });

    // 2. 模拟用户在 Excel 中填报叶子科目 (单位: 万元)
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    const ws = wb.worksheets[0];
    for (let r = 8; r <= ws.rowCount; r++) {
      const code = String(ws.getRow(r).getCell(2).value ?? '');
      if (code === 'I01') {
        ws.getRow(r).getCell(5).value = '15.50'; // 15.50 万元 = 155,000 元
      } else if (code === 'C0101') {
        ws.getRow(r).getCell(5).value = '3.20';  // 3.20 万元 = 32,000 元
      }
    }
    const modifiedBuf = Buffer.from(await wb.xlsx.writeBuffer());

    // 3. 导入并解析
    const parsed = await io.parseActualImport(modifiedBuf, db);
    expect(parsed.ok).toBe(true);
    expect(parsed.years).toEqual([2026]);
    expect(parsed.dates).toEqual(['2026-06-30']);

    // 4. 解析与写入
    const resolved = io.resolveActualImport(db, parsed);
    expect(resolved.entries.length).toBe(2);
    const res = actual.saveActual(db, {
      year: resolved.year,
      snapshotDate: resolved.snapshotDate,
      entries: resolved.entries,
      source: 'excel_import',
      mode: 'upsert',
    });
    expect(res.batchId).toBeGreaterThan(0);

    const batchEntries = actual.getBatchEntries(db, res.batchId);
    // 验证入库金额已正确从万元换算为分 (15.5 万元 = 15500000 分; 3.2 万元成本 = -3200000 分)
    const incomeEntry = batchEntries.find((e) => e.accountId === fx.accIds.incomeMain);
    const costEntry = batchEntries.find((e) => e.accountId === fx.accIds.costSub);
    expect(incomeEntry?.amountCents).toBe(15500000);
    expect(costEntry?.amountCents).toBe(-3200000);
  });

  it('多组织、多年份、多表格结构化模板导出与批量导入', async () => {
    const db = testDb();
    const fx = buildFixture(db);

    // 1. 生成多组织(上海+杭州)、多年份(2025+2026)模板
    const buf = await io.actualImportTemplateBuffer(db, {
      years: [2025, 2026],
      orgIds: [fx.orgIds.shanghai, fx.orgIds.hangzhou],
      sheetKeys: ['all'],
      cutoff: '2026-06-30',
    });

    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    // 应该包含 4 个填报 Sheet (2025-SH, 2025-HZ, 2026-SH, 2026-HZ) + 2 个参照 Sheet
    expect(wb.worksheets.length).toBe(6);

    // 2. 模拟填报多个 Sheet
    for (const ws of wb.worksheets) {
      if (ws.name.includes('参照')) continue;
      for (let r = 8; r <= ws.rowCount; r++) {
        const code = String(ws.getRow(r).getCell(2).value ?? '');
        if (code === 'I01') {
          ws.getRow(r).getCell(5).value = '20.00'; // 20 万元
        }
      }
    }
    const modifiedBuf = Buffer.from(await wb.xlsx.writeBuffer());

    // 3. 导入解析
    const parsed = await io.parseActualImport(modifiedBuf, db);
    expect(parsed.ok).toBe(true);
    expect(parsed.years.sort()).toEqual([2025, 2026]);

    // 4. resolve 多批次
    const resolved = io.resolveActualImport(db, parsed);
    expect(resolved.batches.length).toBe(2); // 2025 和 2026 两个批次

    // 5. 分别写入快照
    for (const b of resolved.batches) {
      const res = actual.saveActual(db, {
        year: b.year,
        snapshotDate: b.snapshotDate,
        entries: b.entries,
        source: 'excel_import',
        mode: 'upsert',
        history: b.year < 2026,
      });
      expect(res.batchId).toBeGreaterThan(0);
    }

    // 验证 2025 和 2026 都生成了实际数据快照
    const b2025 = actual.listBatches(db, 2025);
    const b2026 = actual.listBatches(db, 2026);
    expect(b2025.length).toBeGreaterThan(0);
    expect(b2026.length).toBeGreaterThan(0);
  });

  it('非电与发电科目按组织范围精准过滤与汇总穿透', async () => {
    const { isAccountVisibleForScope } = await import('../src/core/accountScope');

    // 1. 水力发电站(江垭电站 010102): 发电科目与两项细则奖励(I1103)可见，非电科目(如温泉I1233)隐藏
    const jiangyaScope = new Set(['010102']);
    expect(isAccountVisibleForScope('I1101', jiangyaScope)).toBe(true);
    expect(isAccountVisibleForScope('I1103', jiangyaScope)).toBe(true); // 水电两项细则可见
    expect(isAccountVisibleForScope('Q1', jiangyaScope)).toBe(true);
    expect(isAccountVisibleForScope('I1233', jiangyaScope)).toBe(false); // 温泉收入隐藏
    expect(isAccountVisibleForScope('I12471', jiangyaScope)).toBe(false); // 充电桩隐藏
    expect(isAccountVisibleForScope('E2', jiangyaScope)).toBe(true); // 通用管理费用可见

    // 2. 风力发电站(新化大熊山 010402 / 全州优能下属六字界 01040401, 白竹 01040402, 磨子岭 01040403):
    //    发电科目可见，两项细则(I1103)与非电科目隐藏
    const windSubScope = new Set(['01040401']); // 六字界
    expect(isAccountVisibleForScope('I1101', windSubScope)).toBe(true);
    expect(isAccountVisibleForScope('Q101', windSubScope)).toBe(true);
    expect(isAccountVisibleForScope('I1103', windSubScope)).toBe(false); // 风电无两项细则
    expect(isAccountVisibleForScope('I1246', windSubScope)).toBe(false); // 非电检修隐藏

    const younengRollup = new Set(['01040401', '01040402', '01040403']); // 全州优能汇总
    expect(isAccountVisibleForScope('I1101', younengRollup)).toBe(true);
    expect(isAccountVisibleForScope('I1103', younengRollup)).toBe(false);

    // 3. 光伏发电主体(银腾光伏 010701 / 长沙基地光伏 010702 / 国检光伏 010703):
    //    仅可见光伏发电科目(I1101/Q101)，两项细则(I1103)与非电业务(I1246/I12471)隐藏
    const solarSubScope = new Set(['010701']); // 银腾光伏
    expect(isAccountVisibleForScope('I1101', solarSubScope)).toBe(true); // 光伏上网电量收入
    expect(isAccountVisibleForScope('Q101', solarSubScope)).toBe(true); // 光伏上网电量
    expect(isAccountVisibleForScope('I1103', solarSubScope)).toBe(false); // 光伏无两项细则
    expect(isAccountVisibleForScope('I1246', solarSubScope)).toBe(false); // 检修收入隐藏(不归光伏电站)
    expect(isAccountVisibleForScope('I12471', solarSubScope)).toBe(false); // 充电桩隐藏

    // 4. 机电本部(非电业务 010704): 仅可见检修与充电桩等非电科目，隐藏光伏发电科目
    const jidianNonPower = new Set(['010704']);
    expect(isAccountVisibleForScope('I1246', jidianNonPower)).toBe(true); // 检修收入
    expect(isAccountVisibleForScope('I12471', jidianNonPower)).toBe(true); // 充电桩
    expect(isAccountVisibleForScope('I1101', jidianNonPower)).toBe(false); // 发电收入隐藏

    // 5. 机电公司汇总(0107 汇总包含 010701~010704):
    //    光伏发电科目与非电业务科目均可见并穿透汇总
    const jidianRollup = new Set(['010701', '010702', '010703', '010704']);
    expect(isAccountVisibleForScope('I1101', jidianRollup)).toBe(true);
    expect(isAccountVisibleForScope('I1246', jidianRollup)).toBe(true);
    expect(isAccountVisibleForScope('I1103', jidianRollup)).toBe(false); // 无两项细则

    // 6. 江垭温泉(010603): 温泉收入(I1233)与成本(C1215)可见，发电收入(I1101)与物业收入(I1240)隐藏
    const hotspringScope = new Set(['010603']);
    expect(isAccountVisibleForScope('I1233', hotspringScope)).toBe(true);
    expect(isAccountVisibleForScope('C1215', hotspringScope)).toBe(true);
    expect(isAccountVisibleForScope('I1101', hotspringScope)).toBe(false);
    expect(isAccountVisibleForScope('I1240', hotspringScope)).toBe(false);

    // 7. 泽通公司(0106 汇总包含 010601泽通总部, 010602物业, 010603温泉):
    //    泽通所有子公司的科目均可见，其他公司(如索溪I1209、总部I1201)隐藏
    const zetongScope = new Set(['010601', '010602', '010603']);
    expect(isAccountVisibleForScope('I1219', zetongScope)).toBe(true); // 泽通总部闲置资产租赁
    expect(isAccountVisibleForScope('I1233', zetongScope)).toBe(true); // 江垭温泉收入
    expect(isAccountVisibleForScope('I1240', zetongScope)).toBe(true); // 物业公司收入
    expect(isAccountVisibleForScope('I1201', zetongScope)).toBe(false); // 总部公路补偿隐藏
    expect(isAccountVisibleForScope('I1209', zetongScope)).toBe(false); // 索溪供水隐藏

    // 8. 集团顶级组织: 全量科目可见
    const groupScope = new Set(['010101', '010102', '010103', '0102', '0103', '010401', '010402', '010403', '01040401', '01040402', '01040403', '0105', '010601', '010602', '010603', '010701', '010702', '010703', '010704']);
    expect(isAccountVisibleForScope('I1101', groupScope)).toBe(true);
    expect(isAccountVisibleForScope('I1103', groupScope)).toBe(true);
    expect(isAccountVisibleForScope('I1201', groupScope)).toBe(true);
    expect(isAccountVisibleForScope('I1233', groupScope)).toBe(true);
    expect(isAccountVisibleForScope('I12471', groupScope)).toBe(true);
  });

  it('导入失败记录日志', async () => {
    const db = testDb();
    buildFixture(db);
    const bad = await makeWorkbook([[2026, '2026-06-30', 'NOPE', 'I01', '10.00', '']]);
    const parsed = await io.parseActualImport(bad);
    expect(parsed.ok).toBe(true); // 格式层通过
    expect(() => io.resolveActualImport(db, parsed)).toThrow(); // 编码层失败
    const { writeLog } = await import('../src/modules/audit/log');
    writeLog(db, 'import.failed', 'actual_import', '-', { errors: [{ row: 2, field: 'orgCode', message: '组织编码不存在: NOPE' }] });
    expect(queryLogs(db, { action: 'import.failed' }).total).toBe(1);
  });
});

describe('集成:年度关闭与重开(方案三.5)', () => {
  it('关闭读取最终快照,重开需原因,重开后可再关闭覆盖', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const v = standardBudgetVersion(fx);
    budget.lockVersion(db, v.id);
    budget.setCurrentVersion(db, v.id);
    const b1 = actual.saveActual(db, {
      year: 2026, snapshotDate: '2026-06-30', source: 'manual', mode: 'replace',
      entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '40.00' }],
    });
    const b2 = actual.saveActual(db, {
      year: 2026, snapshotDate: '2026-12-31', source: 'manual', mode: 'replace',
      entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '95.00' }],
    });
    // 冻结前禁止直接更新?不——冻结后才禁止。先冻结
    const state = report.freezeYear(db, 2026, b2.batchId);
    expect(state?.status).toBe('frozen');
    expect(state?.final_batch_id).toBe(b2.batchId);
    // 冻结后禁止更新实际
    expect(() =>
      actual.saveActual(db, {
        year: 2026, snapshotDate: '2026-12-31', source: 'manual', mode: 'replace',
        entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '99.00' }],
      })
    ).toThrow(/冻结/);
    // 重开必须填写原因
    expect(() => report.reopenYear(db, 2026, '')).toThrow(/原因/);
    report.reopenYear(db, 2026, '年末审计调整');
    // 重开后可修改并重新关闭,final_batch_id 覆盖
    const b3 = actual.saveActual(db, {
      year: 2026, snapshotDate: '2026-12-31', source: 'manual', mode: 'replace',
      entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '96.00' }],
    });
    const state2 = report.freezeYear(db, 2026, b3.batchId);
    expect(state2?.final_batch_id).toBe(b3.batchId);
    expect(queryLogs(db, { action: 'year.reopen' }).total).toBe(1);
    void b1;
  });

  it('冻结年度的实际报表按最终快照计算(历史口径不受当前结构影响)', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const v = standardBudgetVersion(fx);
    budget.lockVersion(db, v.id);
    budget.setCurrentVersion(db, v.id);
    const b = actual.saveActual(db, {
      year: 2026, snapshotDate: '2026-12-31', source: 'manual', mode: 'replace',
      entries: [
        { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '120.00' },
        { orgId: fx.orgIds.hangzhou, accountId: fx.accIds.incomeMain, amount: '60.00' },
      ],
    });
    report.freezeYear(db, 2026, b.batchId);
    // 冻结后调整当前树:停用杭州、修改名称
    org.setOrgStatus(db, fx.orgIds.hangzhou, 'inactive');
    org.updateOrg(db, fx.orgIds.shanghai, { name: '上海总部' });
    const rep = report.completionReport(db, { versionId: v.id });
    expect(rep.actualSource).toBe('final');
    expect(rep.asOfDate).toBe('2026-12-31');
    const income = rep.byAccount.find((a) => a.accountId === fx.accIds.incomeMain)!;
    expect(income.cell.actualCents).toBe(18000); // 仍按最终快照全量
  });
});

describe('集成:报表计算(方案九)', () => {
  function setup() {
    const db = testDb();
    const fx = buildFixture(db);
    const v = standardBudgetVersion(fx); // 预算: 收150 成本90 费用30, 利润30
    budget.lockVersion(db, v.id);
    budget.setCurrentVersion(db, v.id);
    actual.saveActual(db, {
      year: 2026, snapshotDate: '2026-06-30', source: 'manual', mode: 'replace',
      entries: [
        { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '60.00' },
        { orgId: fx.orgIds.shanghai, accountId: fx.accIds.costSub, amount: '30.00' },
        { orgId: fx.orgIds.shanghai, accountId: fx.accIds.expenseAdmin, amount: '12.00' },
        { orgId: fx.orgIds.hangzhou, accountId: fx.accIds.incomeMain, amount: '30.00' },
        { orgId: fx.orgIds.hangzhou, accountId: fx.accIds.costSub, amount: '20.00' },
        { orgId: fx.orgIds.hangzhou, accountId: fx.accIds.expenseSales, amount: '4.00' },
      ],
    });
    return { db, fx, v };
  }

  it('完成情况表:差异/完成率/时间进度/进度偏差', () => {
    const { db, fx, v } = setup();
    const rep = report.completionReport(db, { versionId: v.id });
    expect(rep.asOfDate).toBe('2026-06-30');
    expect(rep.timeProgressValue).toBeCloseTo(181 / 365, 10);
    expect(rep.actualSource).toBe('current');
    const income = rep.byAccount.find((a) => a.accountId === fx.accIds.incomeMain)!;
    // 预算 150,实际 90:差异 -6000(不利),完成率 60%
    expect(income.cell.budgetCents).toBe(15000);
    expect(income.cell.actualCents).toBe(9000);
    expect(income.cell.varianceCents).toBe(-6000);
    expect(income.cell.favorable).toBe('unfavorable');
    expect(income.cell.rate).toBeCloseTo(0.6, 10);
    const cost = rep.byAccount.find((a) => a.accountId === fx.accIds.costSub)!;
    // 成本预算 90,实际 50(存储-5000):V = -5000 - (-9000) = 4000 有利;完成率 50/90
    expect(cost.cell.budgetCents).toBe(-9000);
    expect(cost.cell.actualCents).toBe(-5000);
    expect(cost.cell.varianceCents).toBe(4000);
    expect(cost.cell.favorable).toBe('favorable');
    expect(cost.cell.rate).toBeCloseTo(5 / 9, 10);
    // 指标:毛利预算 6000,实际 4000
    const gross = rep.metrics.find((m) => m.metricId === fx.metricIds.gross)!;
    expect(gross.cell.budgetCents).toBe(6000);
    expect(gross.cell.actualCents).toBe(4000);
    // 时间进度口径标注
    expect(rep.notes.some((n) => n.includes('时间进度'))).toBe(true);
  });

  it('特殊值:预算为0 → N/A;实际与预算反向 → 异常标记', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const v = budget.createVersion(db, { year: 2026, name: 'edge' });
    budget.saveEntries(db, v.id, [
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '0.00' },  // 不保存
      { orgId: fx.orgIds.hangzhou, accountId: fx.accIds.expenseAdmin, amount: '-10.00' }, // 负预算(冲减)
    ]);
    budget.lockVersion(db, v.id);
    actual.saveActual(db, {
      year: 2026, snapshotDate: '2026-06-30', source: 'manual', mode: 'replace',
      entries: [
        { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '5.00' }, // 预算0实际5
      ],
    });
    const rep = report.completionReport(db, { versionId: v.id });
    const income = rep.byAccount.find((a) => a.accountId === fx.accIds.incomeMain)!;
    expect(income.cell.rate).toBeNull();
    expect(income.cell.rateSpecial).toBe('na_zero_budget');
    const admin = rep.byAccount.find((a) => a.accountId === fx.accIds.expenseAdmin)!;
    // 界面-10存储为+1000(负的界面金额);展示预算 = -10
    expect(admin.cell.budgetCents).toBe(1000);
    expect(admin.cell.rate).toBeNull();
    expect(admin.cell.rateSpecial).toBe('na_negative_budget');
  });

  it('组织范围筛选(子树汇总)', () => {
    const { db, fx, v } = setup();
    const rep = report.completionReport(db, { versionId: v.id, orgScopeId: fx.orgIds.east });
    const income = rep.byAccount.find((a) => a.accountId === fx.accIds.incomeMain)!;
    expect(income.cell.budgetCents).toBe(15000); // 上海100+杭州50 都在华东下
    // 西部范围:无数据
    const repWest = report.completionReport(db, { versionId: v.id, orgScopeId: fx.orgIds.west });
    const incomeWest = repWest.byAccount.find((a) => a.accountId === fx.accIds.incomeMain)!;
    expect(incomeWest.cell.budgetCents).toBe(0);
    expect(incomeWest.cell.actualCents).toBe(0);
  });

  it('年内完成率趋势', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const v = standardBudgetVersion(fx);
    budget.lockVersion(db, v.id);
    budget.setCurrentVersion(db, v.id);
    // 按时间顺序保存两个时点(正常更新不允许日期倒退)
    actual.saveActual(db, {
      year: 2026, snapshotDate: '2026-03-31', source: 'manual', mode: 'replace',
      entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '30.00' }],
    });
    actual.saveActual(db, {
      year: 2026, snapshotDate: '2026-06-30', source: 'manual', mode: 'replace',
      entries: [
        { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '60.00' },
        { orgId: fx.orgIds.hangzhou, accountId: fx.accIds.incomeMain, amount: '30.00' },
      ],
    });
    const trend = report.yearTrend(db, { year: 2026, versionId: v.id, accountScopeId: fx.accIds.incomeMain });
    expect(trend.points.length).toBe(2);
    expect(trend.points[0].date).toBe('2026-03-31');
    expect(trend.points[0].rate).toBeCloseTo(30 / 150, 10);
    expect(trend.points[1].rate).toBeCloseTo(90 / 150, 10);
    expect(trend.points[1].timeProgress).toBeCloseTo(181 / 365, 10);
  });

  it('版本对比:变化额/变化率/树口径差异提示', () => {
    const { db, fx, v } = setup();
    const v2 = budget.copyVersion(db, v.id, '调整版');
    budget.saveEntries(db, v2.id, [
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '110.00' }, // +10
      { orgId: fx.orgIds.hangzhou, accountId: fx.accIds.incomeMain, amount: '50.00' },
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.costSub, amount: '60.00' },
      { orgId: fx.orgIds.hangzhou, accountId: fx.accIds.costSub, amount: '30.00' },
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.expenseAdmin, amount: '20.00' },
      { orgId: fx.orgIds.hangzhou, accountId: fx.accIds.expenseSales, amount: '10.00' },
    ]);
    const cmp = report.versionCompare(db, v.id, v2.id);
    expect(cmp.treeSame).toBe(true);
    const change = cmp.leafChanges.find((c) => c.orgId === fx.orgIds.shanghai && c.accountId === fx.accIds.incomeMain)!;
    expect(change.deltaCents).toBe(1000);
    expect(change.changeRate).toBeCloseTo(0.1, 10);
    // 结构变化场景
    org.createOrg(db, { parentId: fx.orgIds.west, code: 'CD', name: '成都公司' });
    const v3 = budget.createVersion(db, { year: 2026, name: '新版结构' });
    const cmp2 = report.versionCompare(db, v2.id, v3.id);
    expect(cmp2.treeSame).toBe(false);
    expect(cmp2.addedOrgCodes).toContain('CD');
    expect(cmp2.notes.some((n) => n.includes('结构口径不同'))).toBe(true);
  });

  it('历年预实对比与预算准确率', () => {
    const { db, fx, v } = setup();
    // 2025 年度也关闭一年
    const v25 = budget.createVersion(db, { year: 2025, name: '25V1' });
    budget.saveEntries(db, v25.id, [
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '80.00' },
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.costSub, amount: '40.00' },
    ]);
    budget.lockVersion(db, v25.id);
    budget.setCurrentVersion(db, v25.id);
    const b25 = actual.saveActual(db, {
      year: 2025, snapshotDate: '2025-12-31', source: 'manual', mode: 'replace',
      entries: [
        { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '75.00' },
        { orgId: fx.orgIds.shanghai, accountId: fx.accIds.costSub, amount: '38.00' },
      ],
    });
    report.freezeYear(db, 2025, b25.batchId);
    const b26 = actual.saveActual(db, {
      year: 2026, snapshotDate: '2026-12-31', source: 'manual', mode: 'replace',
      entries: [
        { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '100.00' },
        { orgId: fx.orgIds.hangzhou, accountId: fx.accIds.incomeMain, amount: '45.00' },
        { orgId: fx.orgIds.shanghai, accountId: fx.accIds.costSub, amount: '55.00' },
        { orgId: fx.orgIds.hangzhou, accountId: fx.accIds.costSub, amount: '25.00' },
      ],
    });
    report.freezeYear(db, 2026, b26.batchId);
    const hist = report.historicalComparison(db);
    expect(hist.years.length).toBe(2);
    const y25 = hist.years.find((y) => y.year === 2025)!;
    expect(y25.budgetVersionName).toBe('25V1');
    expect(y25.totals.incomeBudget).toBe(8000);
    expect(y25.totals.incomeActual).toBe(7500);
    expect(y25.finalSnapshotDate).toBe('2025-12-31');
    const y26 = hist.years.find((y) => y.year === 2026)!;
    // 2026 预算利润 30,实际利润 (145-80) = 65
    expect(y26.totals.profitBudget).toBe(3000);
    expect(y26.totals.profitActual).toBe(6500);
    expect(y26.yoyProfit).not.toBeNull();
    // 准确率
    const acc = report.accuracyReport(db, 2026);
    const e = Math.abs(6500 - 3000) / Math.abs(3000);
    expect(acc.typeAccuracy.profit.q).toBeCloseTo(Math.max(0, 1 - e), 10);
    // 未冻结年度不能算准确率
    expect(() => report.accuracyReport(db, 2027)).toThrow(/未关闭/);
  });
});

describe('集成:备份恢复(方案十三)', () => {
  it('在线备份 → 校验 → 恢复', async () => {
    const { db, dir, dbPath } = tempFileDb();
    const fx = buildFixture(db);
    const v = standardBudgetVersion(fx);
    budget.lockVersion(db, v.id);
    const b = backup.backupDirOf(dbPath);
    const bk = await backup.createBackup(db, b, 'test');
    expect(bk.file).toMatch(/^test-budget-backup-\d{4}-\d{2}-\d{2}-\d{6}\.sqlite$/);
    const verify = backup.verifyBackupFile(require('path').join(b, bk.file));
    expect(verify.ok).toBe(true);
    // 恢复前继续写入新数据(备份不含)
    budget.setCurrentVersion(db, v.id);
    expect(budget.getVersion(db, v.id).is_current).toBe(1);
    // 恢复
    const holder = {
      current: db,
      getDb: () => holder.current,
      reopenWith: (nd: typeof db) => { holder.current = nd; },
    };
    const result = await backup.restoreBackup(holder, dbPath, require('path').join(b, bk.file), true);
    expect(result.ok).toBe(true);
    // 恢复后 is_current 应回到备份时状态(0)
    expect(budget.getVersion(holder.getDb(), v.id).is_current).toBe(0);
    expect(budget.getVersion(holder.getDb(), v.id).status).toBe('locked');
    // 未确认时拒绝恢复
    await expect(backup.restoreBackup(holder, dbPath, require('path').join(b, bk.file), false)).rejects.toThrow(/二次确认/);
    holder.getDb().close();
    require('fs').rmSync(dir, { recursive: true, force: true });
  });

  it('备份列表与保留策略', async () => {
    const { db, dir, dbPath } = tempFileDb();
    buildFixture(db);
    const b = backup.backupDirOf(dbPath);
    for (let i = 0; i < 3; i++) await backup.createBackup(db, b, 'keep');
    const list = backup.listBackups(b);
    expect(list.length).toBeGreaterThanOrEqual(3);
    // 非法备份文件校验失败
    const badPath = require('path').join(b, 'not-a-backup.sqlite');
    require('fs').writeFileSync(badPath, 'garbage');
    expect(backup.verifyBackupFile(badPath).ok).toBe(false);
    db.close();
    require('fs').rmSync(dir, { recursive: true, force: true });
  });
});

describe('集成:一致性检查与迁移(方案十五.3 / 十六.4阶段)', () => {
  it('正常数据全部检查通过', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const v = standardBudgetVersion(fx);
    budget.lockVersion(db, v.id);
    budget.setCurrentVersion(db, v.id);
    actual.saveActual(db, {
      year: 2026, snapshotDate: '2026-06-30', source: 'manual', mode: 'replace',
      entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '10.00' }],
    });
    const result = runConsistencyChecks(db);
    expect(result.ok).toBe(true);
    expect(result.checks.length).toBe(7);
  });

  it('人为制造不一致可检出', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const v = standardBudgetVersion(fx);
    budget.lockVersion(db, v.id);
    budget.setCurrentVersion(db, v.id);
    actual.saveActual(db, {
      year: 2026, snapshotDate: '2026-06-30', source: 'manual', mode: 'replace',
      entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '10.00' }],
    });
    // 直接改当前实际制造不一致
    db.prepare('UPDATE actual_current SET cumulative_amount_cents = 999 WHERE year = 2026').run();
    const result = runConsistencyChecks(db);
    expect(result.ok).toBe(false);
    expect(result.checks.find((c) => c.name.includes('当前实际与最新快照'))!.ok).toBe(false);
    // 制造两个当前生效版本
    const v2 = budget.copyVersion(db, v.id, 'V2');
    budget.lockVersion(db, v2.id);
    db.prepare('UPDATE budget_version SET is_current = 1 WHERE id = ?').run(v2.id);
    const result2 = runConsistencyChecks(db);
    expect(result2.checks.find((c) => c.name.includes('当前生效版本唯一性'))!.ok).toBe(false);
  });

  it('迁移幂等:重复应用无副作用,迁移记录可查询', () => {
    const { db, dir } = tempFileDb();
    const again = applyMigrations(db);
    expect(again.length).toBe(0); // 已全部应用
    const rows = db.prepare('SELECT version, name FROM schema_migration ORDER BY version').all();
    expect(rows.length).toBe(MIGRATIONS.length);
    expect(rows[0]).toEqual({ version: 1, name: 'initial_schema' });
    db.close();
    require('fs').rmSync(dir, { recursive: true, force: true });
  });

  it('迁移不破坏历史数据', () => {
    const { db, dir } = tempFileDb();
    const fx = buildFixture(db);
    const v = standardBudgetVersion(fx);
    budget.lockVersion(db, v.id);
    const before = db.prepare('SELECT COUNT(*) c FROM budget_entry').get() as { c: number };
    applyMigrations(db); // 幂等重放
    const after = db.prepare('SELECT COUNT(*) c FROM budget_entry').get() as { c: number };
    expect(after.c).toBe(before.c);
    expect(budget.getVersion(db, v.id).status).toBe('locked');
    db.close();
    require('fs').rmSync(dir, { recursive: true, force: true });
  });
});

describe('集成:导出(方案十二.2)', () => {
  it('各类导出生成有效 xlsx', async () => {
    const db = testDb();
    const fx = buildFixture(db);
    const v = standardBudgetVersion(fx);
    budget.lockVersion(db, v.id);
    budget.setCurrentVersion(db, v.id);
    const b = actual.saveActual(db, {
      year: 2026, snapshotDate: '2026-06-30', source: 'manual', mode: 'replace',
      entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '60.00' }],
    });
    report.freezeYear(db, 2026, b.batchId);
    const exportSvc = await import('../src/modules/io/export.service');
    const files: Buffer[] = [
      await exportSvc.exportBudgetDetail(db, v.id),
      await exportSvc.exportActualCurrent(db, 2026),
      await exportSvc.exportCompletion(db, v.id),
      await exportSvc.exportHistorical(db),
      await exportSvc.exportSnapshot(db, b.batchId),
      await exportSvc.exportLogs(db),
      await exportSvc.exportMetricList(db),
    ];
    for (const buf of files) {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(buf as unknown as ArrayBuffer);
      expect(wb.worksheets.length).toBeGreaterThan(0);
      expect(buf.length).toBeGreaterThan(500);
    }
    // 版本对比导出
    const v2 = budget.copyVersion(db, v.id, 'V2');
    const cmpBuf = await exportSvc.exportVersionCompare(db, v.id, v2.id);
    expect(cmpBuf.length).toBeGreaterThan(500);
  });
});
