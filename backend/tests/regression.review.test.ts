import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import fs from 'fs';
import path from 'path';
import { testDb, buildFixture, org, account, budget, actual } from './helpers';
import * as io from '../src/modules/io/excel';
import { writeLog } from '../src/modules/audit/log';
import { applyMigrations, MIGRATIONS, pendingMigrations, dbInitialized, type Migration } from '../src/db/migrations';
import { openDatabase, type DB } from '../src/db/connection';
import { wanStringToCents, AmountFormatError } from '../src/core/money';

/** 代码评审修复的回归测试(2026-08 审查批次) */

/* ============ 严重#1:全新库启动不得因迁移前备份写日志崩溃 ============ */

describe('回归:全新库启动路径', () => {
  it('未初始化的库:dbInitialized=false,pendingMigrations 返回全部迁移', () => {
    const db = openDatabase(':memory:');
    expect(dbInitialized(db)).toBe(false);
    expect(pendingMigrations(db).length).toBe(MIGRATIONS.length);
    db.close();
  });

  it('operation_log 表不存在时 writeLog 容忍(迁移前备份路径不崩溃)', () => {
    const db = openDatabase(':memory:');
    expect(() => writeLog(db, 'backup.create', 'backup', 'x.sql', {})).not.toThrow();
    db.close();
  });

  it('迁移后 pendingMigrations 为空且 writeLog 正常落库', () => {
    const db = testDb();
    expect(dbInitialized(db)).toBe(true);
    expect(pendingMigrations(db).length).toBe(0);
    writeLog(db, 'backup.create', 'backup', 'y.sql', {});
    expect(db.prepare("SELECT COUNT(*) c FROM operation_log WHERE action = 'backup.create'").get()).toEqual({ c: 1 });
  });
});

/* ============ 严重#2:利润表模板 Excel 往返导入 ============ */

describe('回归:利润表结构化模板往返导入', () => {
  async function profitFixtureDb() {
    const db = testDb();
    const root = org.createOrg(db, { parentId: null, code: 'GROUP', name: '集团' }).id;
    const jy = org.createOrg(db, { parentId: root, code: '010102', name: '江垭电站' }).id;
    // 科目编码对齐利润表模板行:I1 汇总 + 叶子 I1101/I2/C3/E1
    const i1 = account.createAccount(db, { parentId: null, code: 'I1', name: '营业收入', type: 'income' }).id;
    account.createAccount(db, { parentId: i1, code: 'I1101', name: '上网电量收入', type: 'income' });
    account.createAccount(db, { parentId: null, code: 'I2', name: '投资收益', type: 'income' });
    account.createAccount(db, { parentId: null, code: 'C3', name: '税金及附加', type: 'cost' });
    account.createAccount(db, { parentId: null, code: 'E1', name: '销售费用', type: 'expense' });
    return { db, jy };
  }

  it('利润表 tab 的跨表取数公式缓存值不与明细 tab 手填行冲突', async () => {
    const { db, jy } = await profitFixtureDb();
    const buf = await io.actualImportTemplateBuffer(db, {
      year: 2026,
      cutoff: '2026-06-30',
      orgId: jy,
      sheetKey: 'profit',
    });
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);

    const detail = wb.worksheets.find((w) => w.name === '全部科目明细');
    expect(detail).toBeTruthy();
    // 在明细 tab 填入叶子科目数值(I1101/I2/C3/E1)
    const filled: Record<string, string> = { I1101: '100.50', I2: '8.25', C3: '3.10', E1: '2.05' };
    for (let r = 8; r <= detail!.rowCount; r++) {
      const code = String(detail!.getRow(r).getCell(2).value ?? '');
      if (code in filled) detail!.getRow(r).getCell(5).value = Number(filled[code]);
    }
    // 模拟 Excel 保存后的公式缓存:利润表 tab 的取数链接行带上 result
    for (const ws of wb.worksheets) {
      if (ws.name === '全部科目明细') continue;
      for (let r = 8; r <= ws.rowCount; r++) {
        const cell = ws.getRow(r).getCell(5);
        const v = cell.value as { formula?: string } | null;
        if (v && typeof v === 'object' && typeof v.formula === 'string' && v.formula.includes('!')) {
          cell.value = { formula: v.formula, result: 42.42 };
        }
      }
    }
    const round = await wb.xlsx.writeBuffer();
    const parsed = await io.parseActualImport(Buffer.from(round), db);
    expect(parsed.errors).toEqual([]);
    expect(parsed.ok).toBe(true);
    const codes = parsed.rows.map((r) => r.accountCode).sort();
    // 只有明细 tab 的手填行进入导入,公式行不重复计入
    expect(codes).toEqual(['C3', 'E1', 'I1101', 'I2']);
  });
});

/* ============ 迁移加固:V9 指标引用链 / V10 唯一约束冲突 ============ */

function applyUpTo(db: DB, version: number): void {
  db.exec(`CREATE TABLE IF NOT EXISTS schema_migration (
    version INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    applied_at TEXT NOT NULL
  )`);
  const run = (m: Migration) => {
    if (m.raw) {
      try {
        db.exec(m.sql);
      } finally {
        db.pragma('foreign_keys = ON');
      }
      const violations = db.pragma('foreign_key_check') as unknown[];
      if (violations.length > 0) throw new Error(`V${m.version} foreign_key_check 违例`);
      db.prepare('INSERT INTO schema_migration (version, name, applied_at) VALUES (?, ?, ?)').run(
        m.version,
        m.name,
        new Date().toISOString()
      );
    } else {
      db.transaction(() => {
        db.exec(m.sql);
        db.prepare('INSERT INTO schema_migration (version, name, applied_at) VALUES (?, ?, ?)').run(
          m.version,
          m.name,
          new Date().toISOString()
        );
      })();
    }
  };
  MIGRATIONS.filter((m) => m.version <= version).forEach(run);
}

describe('回归:迁移 V9(科目清理与指标引用链)', () => {
  it('删除被引用指标不再被 source_metric_id 外键阻塞,且留有审计日志', () => {
    const db = openDatabase(':memory:');
    applyUpTo(db, 8);
    // I1102 直供电量收入(叶子) + Q102 直供电量(数量)
    const i11 = account.createAccount(db, { parentId: null, code: 'I11', name: '发电收入', type: 'income' }).id;
    const i1102 = account.createAccount(db, { parentId: i11, code: 'I1102', name: '直供电量收入', type: 'income' }).id;
    account.createAccount(db, { parentId: null, code: 'Q102', name: '直供电量', type: 'quantity', unit: '万度' });
    // M1 仅含 I1102 公式项;M2 引用 M1(引用链)
    // 注意:这里必须用当年(V8)列结构的裸 SQL 建指标,不能走 metric.createMetric ——
    // 服务层始终按最新 schema 写入(V23 起有 kind/direction/... 列),而本用例故意停在 V8。
    const legacyMetric = (code: string, name: string, order: number): number => {
      const info = db
        .prepare('INSERT INTO report_metric (code, name, display_order, status, created_at, updated_at) VALUES (?,?,?,?,?,?)')
        .run(code, name, order, 'active', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z');
      return Number(info.lastInsertRowid);
    };
    const legacyTerm = (metricId: number, sourceType: 'account' | 'metric', sourceId: number) => {
      db.prepare(
        `INSERT INTO report_metric_term (metric_id, source_type, source_account_id, source_metric_id, coefficient, sort_order)
         VALUES (?,?,?,?,1,0)`
      ).run(metricId, sourceType, sourceType === 'account' ? sourceId : null, sourceType === 'metric' ? sourceId : null);
    };
    const m1 = legacyMetric('M1', '直供指标', 1);
    legacyTerm(m1, 'account', i1102);
    const m2 = legacyMetric('M2', '引用直供的指标', 2);
    legacyTerm(m2, 'metric', m1);
    // 存量数据:预算分录 + 当前实际 + 快照
    const grp = org.createOrg(db, { parentId: null, code: 'G', name: '集团' }).id;
    const leaf = org.createOrg(db, { parentId: grp, code: 'L', name: '电站' }).id;
    const v = budget.createVersion(db, { year: 2026, name: 'V' });
    // 与上面的指标相同，这里也按 V8 schema 写存量预算；最新 saveEntries 已依赖
    // V25 的 revision，不能拿它操作一个刻意停留在 V8 的迁移前数据库。
    db.prepare('INSERT INTO budget_entry (version_id, org_id, account_id, amount_cents, updated_at) VALUES (?, ?, ?, 1000, ?)')
      .run(v.id, leaf, i1102, '2026-01-01T00:00:00.000Z');
    db.prepare("INSERT INTO actual_current (year, org_id, account_id, cumulative_amount_cents, source, memo, updated_at) VALUES (2026, ?, ?, 1000, 'manual', '', '2026-01-01T00:00:00.000Z')").run(leaf, i1102);

    expect(() => applyMigrations(db)).not.toThrow();
    // I1102/Q102 及其数据被删,引用链上的 M1/M2 一并删除
    expect(db.prepare("SELECT COUNT(*) c FROM account WHERE code IN ('I1102','Q102')").get()).toEqual({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) c FROM report_metric').get()).toEqual({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) c FROM budget_entry').get()).toEqual({ c: 0 });
    expect(db.prepare('SELECT COUNT(*) c FROM actual_current').get()).toEqual({ c: 0 });
    // 审计留痕
    const audit = db.prepare("SELECT detail_json FROM operation_log WHERE action = 'migration.data_cleanup' AND entity_id = 'V9'").get() as { detail_json: string } | undefined;
    expect(audit).toBeTruthy();
    const detail = JSON.parse(audit!.detail_json);
    expect(detail.deleted_budget_entries).toBe(1);
    expect(detail.deleted_actual_current).toBe(1);
    expect(String(detail.deleted_metrics)).toContain('M1');
    expect(String(detail.deleted_metrics)).toContain('M2');
    db.close();
  });
});

describe('回归:迁移 V10(组织树扩展数据搬迁)', () => {
  it('目标叶子同年同科目已有数据时冲突行保留在原组织,迁移不失败', () => {
    const db = openDatabase(':memory:');
    applyUpTo(db, 9);
    // 建立 0104 > 010404 结构,并手工提前创建 01040404(早期 V10 已升级过的库可能出现的状态)
    const r4 = org.createOrg(db, { parentId: null, code: '0104', name: '澧能' }).id;
    const qz = org.createOrg(db, { parentId: r4, code: '010404', name: '全州优能' }).id;
    const qzBenbu = org.createOrg(db, { parentId: qz, code: '01040404', name: '全州优能本部' }).id;
    const acc = account.createAccount(db, { parentId: null, code: 'I2', name: '投资收益', type: 'income' }).id;
    const ins = db.prepare("INSERT INTO actual_current (year, org_id, account_id, cumulative_amount_cents, source, memo, updated_at) VALUES (?, ?, ?, 500, 'manual', '', '2026-01-01T00:00:00.000Z')");
    ins.run(2026, qz, acc);      // 待搬迁行
    ins.run(2026, qzBenbu, acc); // 目标侧冲突行

    expect(() => applyMigrations(db)).not.toThrow();
    // 冲突行保留在 010404(目标侧 01040404 的既有行不动),且写入告警日志
    const kept = db.prepare('SELECT org_id FROM actual_current ORDER BY org_id').all() as { org_id: number }[];
    expect(kept.length).toBe(2);
    expect(kept.map((k) => k.org_id)).toContain(qz);
    expect(kept.map((k) => k.org_id)).toContain(qzBenbu);
    const warn = db.prepare("SELECT COUNT(*) c FROM operation_log WHERE action = 'migration.data_cleanup_warning' AND entity_id = 'V10'").get() as { c: number };
    expect(warn.c).toBeGreaterThan(0);
    db.close();
  });
});

/* ============ 万元换算边界 ============ */

describe('回归:wanStringToCents 边界', () => {
  it('千分位逗号与六位小数正确解析', () => {
    expect(wanStringToCents('15.50')).toBe(15_500_000);
    expect(wanStringToCents('1,234.5')).toBe(1_234_500_000);
    expect(wanStringToCents('0.123456')).toBe(1234.56 * 100);
    expect(wanStringToCents('-2.00')).toBe(-2_000_000);
  });
  it('七位小数/12 位整数/超安全整数报错,错误文案为万元口径', () => {
    for (const bad of ['0.1234567', '123456789012.00', '99999999999.999999']) {
      try {
        wanStringToCents(bad);
        expect.unreachable(`应拒绝: ${bad}`);
      } catch (e) {
        expect(e).toBeInstanceOf(AmountFormatError);
        expect((e as Error).message).toContain('万元');
      }
    }
  });
});

/* ============ 组织-科目适用范围:预算与实际同口径 ============ */

describe('回归:科目-组织适用范围校验', () => {
  function scopedFixture() {
    const db = testDb();
    const fx = buildFixture(db);
    // 在规则全集内建组织:010102(江垭电站,叶子) + 科目 I1233(仅温泉 010603 适用)
    const jy = org.createOrg(db, { parentId: fx.orgIds.root, code: '010102', name: '江垭电站' }).id;
    const i1233 = account.createAccount(db, { parentId: fx.accIds.incomeRoot, code: 'I1233', name: '客房收入', type: 'income' }).id;
    return { db, fx, jy, i1233 };
  }

  it('实际数保存拒绝不适用组合', () => {
    const { db, jy, i1233 } = scopedFixture();
    expect(() =>
      actual.saveActual(db, {
        year: 2026, snapshotDate: '2026-06-30', source: 'manual', mode: 'replace',
        entries: [{ orgId: jy, accountId: i1233, amount: '10.00' }],
      })
    ).toThrow(/不适用于组织/);
  });

  it('预算整包保存拒绝不适用组合', () => {
    const { db, fx, jy, i1233 } = scopedFixture();
    const v = budget.createVersion(db, { year: 2026, name: 'V' });
    expect(() =>
      budget.saveEntries(db, v.id, [
        { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '10.00' },
        { orgId: jy, accountId: i1233, amount: '5.00' },
      ])
    ).toThrow(/不适用于组织/);
  });

  it('预算 Excel 导入解析拒绝不适用组合(带行号)', () => {
    const { db } = scopedFixture();
    const version = budget.createVersion(db, { year: 2026, name: 'Excel 范围校验' });
    try {
      io.resolveBudgetImport(db, version.id, {
        ok: true,
        errors: [],
        rows: [{ orgCode: '010102', accountCode: 'I1233', amountText: '1.00', quantityText: '', formula: '', memo: '' }],
      });
      expect.unreachable('应拒绝不适用组合');
    } catch (e) {
      expect(JSON.stringify(e)).toContain('不适用于组织');
    }
  });

  it('前后端 accountScope 规则文件保持一致', () => {
    const read = (p: string) =>
      fs.readFileSync(p, 'utf8')
        .replace(/\/\*[\s\S]*?\*\//g, '')   // 块注释
        .replace(/\/\/.*$/gm, '')            // 行注释
        .replace(/\s+/g, '');                 // 全部空白
    const backend = read(path.resolve(__dirname, '../src/core/accountScope.ts'));
    const frontend = read(path.resolve(__dirname, '../../frontend/src/utils/accountScope.ts'));
    expect(backend).toBe(frontend);
  });
});
