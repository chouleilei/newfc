/**
 * 主数据健康体检(AI 功能增强计划 §四.阶段三)确定性层测试。
 *
 * 覆盖 taxonomy 各 code 的触发样例与误报样例(健康夹具零命中);
 * 结构检查端点升级为统一 issue 结构且保留 {ok, problems} 兼容;
 * 报告全程确定性,不依赖任何模型配置。
 */
import { describe, expect, it } from 'vitest';
import { createTestApp, authFetch } from './http-helpers';
import fs from 'fs';
import os from 'os';
import path from 'path';
import { testDb, buildFixture, standardBudgetVersion, saveActualSnapshot, budget, type Fixture } from './helpers';
import type { DB } from '../src/db/connection';

function budgetEntries(db: DB, fx: Fixture, entries: { orgId: number; accountId: number; amount: string }[]): void {
  const version = budget.createVersion(db, { year: 2026, name: 'V1' });
  budget.saveEntries(db, version.id, entries);
}
import { masterDataHealthReport, orgStructureIssues, accountStructureIssues, structureCheckPayload } from '../src/modules/check/master-data-health';

function healthCodes(db: ReturnType<typeof testDb>): string[] {
  return masterDataHealthReport(db).issues.map((issue) => issue.code);
}

describe('主数据健康体检:误报样例', () => {
  it('标准夹具在预算与实际全叶子覆盖后零命中(含结构检查)', () => {
    const db = testDb();
    const fx = buildFixture(db);
    // 预算覆盖全部叶子组织×全部叶子科目,实际快照再覆盖一遍(含 E03 其他费用、NJ 南京公司),
    // 使任何 active 叶子都有引用 -> ZERO_DATA_LEAF 零命中;同名/格式/排序均为默认值 -> 零命中。
    const leafOrgs = [fx.orgIds.shanghai, fx.orgIds.hangzhou, fx.orgIds.nanjing];
    const leafAccounts = [fx.accIds.incomeMain, fx.accIds.costSub, fx.accIds.expenseAdmin, fx.accIds.expenseSales, fx.accIds.expenseOther];
    const entries = leafOrgs.flatMap((orgId) => leafAccounts.map((accountId) => ({ orgId, accountId, amount: '10.00' })));
    budgetEntries(db, fx, entries);
    saveActualSnapshot(fx, 2026, '2026-06-30', entries);
    const report = masterDataHealthReport(db);
    expect(report.issueCount).toBe(0);
    expect(report.blockingCount).toBe(0);
    expect(report.groups).toEqual([]);
    expect(orgStructureIssues(db)).toEqual([]);
    expect(accountStructureIssues(db)).toEqual([]);
    db.close();
  });
});

describe('主数据健康体检:taxonomy 触发样例', () => {
  it('ZERO_DATA_LEAF:active 叶子从未出现在预算/实际/快照中', () => {
    const db = testDb();
    const fx = buildFixture(db);
    // 华东大区无子组织不是叶子;南京公司无任何明细 -> 命中;上海/杭州有明细 -> 不命中
    standardBudgetVersion(fx);
    const report = masterDataHealthReport(db);
    const hits = report.issues.filter((issue) => issue.code === 'ZERO_DATA_LEAF');
    const hitIds = new Set(hits.map((issue) => issue.orgId));
    expect(hitIds.has(fx.orgIds.nanjing)).toBe(true);
    expect(hitIds.has(fx.orgIds.shanghai)).toBe(false);
    expect(hitIds.has(fx.orgIds.hangzhou)).toBe(false);
    // 非叶子(集团/大区)即使无直接明细也不命中
    expect(hitIds.has(fx.orgIds.east)).toBe(false);
    expect(hits.every((issue) => issue.severity === 'info')).toBe(true);
    // 费用科目 E03 其他费用 无明细 -> 科目维度命中
    expect(report.issues.some((issue) => issue.code === 'ZERO_DATA_LEAF' && issue.accountId === fx.accIds.expenseOther)).toBe(true);
    expect(report.help.ZERO_DATA_LEAF).toBeDefined();
    // 从未被引用的成因单独叙述,便于用户区分「建而未用」与「只剩占位」
    expect(hits.find((issue) => issue.orgId === fx.orgIds.nanjing)!.message).toContain('建而未用');
    db.close();
  });

  it('ZERO_DATA_LEAF:被引用但金额与数量长期为零同样命中;窗口外的非零数据不算「在用」', () => {
    const db = testDb();
    const fx = buildFixture(db);
    // 2026 版本:上海有非零金额,杭州只有一行显式 0(带附注的占位行,零值单元格才会落库)
    const version = budget.createVersion(db, { year: 2026, name: '零值占位' });
    budget.saveEntries(db, version.id, [
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '100.00' },
      { orgId: fx.orgIds.hangzhou, accountId: fx.accIds.incomeMain, amount: '0.00', note: '暂无业务' },
    ]);
    const report = masterDataHealthReport(db);
    const zero = report.issues.filter((issue) => issue.code === 'ZERO_DATA_LEAF');
    // 杭州被引用过,但窗口内金额全零 -> 长期零数据
    const hangzhou = zero.find((issue) => issue.orgId === fx.orgIds.hangzhou);
    expect(hangzhou).toBeDefined();
    expect(hangzhou!.message).toContain('长期零数据');
    expect(hangzhou!.message).toContain('2024–2026 年');
    // 上海有非零金额 -> 不命中
    expect(zero.some((issue) => issue.orgId === fx.orgIds.shanghai)).toBe(false);

    // 把杭州的非零数据放到窗口之外(2020 年版本):仍算长期零数据
    const old = budget.createVersion(db, { year: 2020, name: '远期版本' });
    budget.saveEntries(db, old.id, [{ orgId: fx.orgIds.hangzhou, accountId: fx.accIds.incomeMain, amount: '500.00' }]);
    const after = masterDataHealthReport(db);
    expect(after.issues.some((issue) => issue.code === 'ZERO_DATA_LEAF' && issue.orgId === fx.orgIds.hangzhou)).toBe(true);
    // 把非零数据放到窗口内(2025 年版本):不再命中
    const recent = budget.createVersion(db, { year: 2025, name: '窗口内版本' });
    budget.saveEntries(db, recent.id, [{ orgId: fx.orgIds.hangzhou, accountId: fx.accIds.incomeMain, amount: '500.00' }]);
    const final = masterDataHealthReport(db);
    expect(final.issues.some((issue) => issue.code === 'ZERO_DATA_LEAF' && issue.orgId === fx.orgIds.hangzhou)).toBe(false);
    db.close();
  });

  it('INACTIVE_WITH_DATA:停用节点存在存量数据', () => {
    const db = testDb();
    const fx = buildFixture(db);
    standardBudgetVersion(fx);
    db.prepare("UPDATE org SET status = 'inactive' WHERE id = ?").run(fx.orgIds.shanghai);
    db.prepare("UPDATE account SET status = 'inactive' WHERE id = ?").run(fx.accIds.costSub);
    const report = masterDataHealthReport(db);
    expect(report.issues.some((issue) => issue.code === 'INACTIVE_WITH_DATA' && issue.orgId === fx.orgIds.shanghai && issue.severity === 'warning')).toBe(true);
    expect(report.issues.some((issue) => issue.code === 'INACTIVE_WITH_DATA' && issue.accountId === fx.accIds.costSub)).toBe(true);
    // 停用但无引用的节点不命中
    db.prepare("UPDATE account SET status = 'inactive' WHERE id = ?").run(fx.accIds.expenseOther);
    expect(report.issues.some((issue) => issue.code === 'INACTIVE_WITH_DATA' && issue.accountId === fx.accIds.expenseOther)).toBe(false);
    db.close();
  });

  it('DUPLICATE_NAME:异父同名成对命中,同父同名不误报为跨分支', () => {
    const db = testDb();
    const fx = buildFixture(db);
    db.prepare('INSERT INTO org (parent_id, code, name, sort_order, status, created_at, updated_at) VALUES (?, ?, ?, 0, \'active\', ?, ?)')
      .run(fx.orgIds.west, 'SH2', '上海公司', new Date().toISOString(), new Date().toISOString());
    const report = masterDataHealthReport(db);
    const dups = report.issues.filter((issue) => issue.code === 'DUPLICATE_NAME');
    expect(dups.some((issue) => issue.orgId === fx.orgIds.shanghai && issue.relatedOrgId != null)).toBe(true);
    expect(dups.length).toBe(2);
    expect(report.help.DUPLICATE_NAME?.fix).toContain('改名');
    db.close();
  });

  it('NAME_FORMAT:首尾空格与全半角混用命中,纯全角名称不误报', () => {
    const db = testDb();
    const fx = buildFixture(db);
    db.prepare('UPDATE org SET name = ? WHERE id = ?').run(' 杭州公司 ', fx.orgIds.hangzhou);
    // 全角左括号 + 半角右括号混用(用转义避免全/半角字符在源码中混淆)
    db.prepare('UPDATE account SET name = ? WHERE id = ?').run('管理费用（A)', fx.accIds.expenseAdmin);
    db.prepare('UPDATE account SET name = ? WHERE id = ?').run('其他费用（专项）', fx.accIds.expenseOther);
    const report = masterDataHealthReport(db);
    const formats = report.issues.filter((issue) => issue.code === 'NAME_FORMAT');
    expect(formats.some((issue) => issue.orgId === fx.orgIds.hangzhou)).toBe(true);
    expect(formats.some((issue) => issue.accountId === fx.accIds.expenseAdmin)).toBe(true);
    // 纯全角括号不混用,不命中
    expect(formats.some((issue) => issue.accountId === fx.accIds.expenseOther)).toBe(false);
    db.close();
  });

  it('SIBLING_CODE_ORDER:同级排序值与编码顺序颠倒时命中', () => {
    const db = testDb();
    const fx = buildFixture(db);
    // 显式排序:杭州(HZ,编码更小)sort_order=2 排在上海(SH,sort_order=1)之后 -> 触发颠倒;
    // 华东大区自身 sort_order=1,避免根级(集团=0,华东/西部)被判定为显式排序组
    db.prepare('UPDATE org SET sort_order = 1 WHERE id = ?').run(fx.orgIds.east);
    db.prepare('UPDATE org SET sort_order = 2 WHERE id = ?').run(fx.orgIds.hangzhou);
    db.prepare('UPDATE org SET sort_order = 1 WHERE id = ?').run(fx.orgIds.shanghai);
    const report = masterDataHealthReport(db);
    // 杭州(HZ)排在编码更大的上海(SH)之后 -> 杭州被标记
    expect(report.issues.some((issue) => issue.code === 'SIBLING_CODE_ORDER' && issue.orgId === fx.orgIds.hangzhou && issue.severity === 'warning')).toBe(true);
    db.close();
  });

  it('QUANTITY_UNIT_MISSING:数量型科目缺计量单位(存量脏数据兜底)', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const now = new Date().toISOString();
    db.prepare("INSERT INTO account (parent_id, code, name, type, unit, quantity_agg, sort_order, status, created_at, updated_at) VALUES (NULL, 'Q1', '电量', 'quantity', '', 'sum', 0, 'active', ?, ?)")
      .run(now, now);
    const report = masterDataHealthReport(db);
    expect(report.issues.some((issue) => issue.code === 'QUANTITY_UNIT_MISSING' && issue.message.includes('Q1') && issue.severity === 'warning')).toBe(true);
    db.close();
  });

  it('结构问题(孤儿/自指/循环/类型不一致/非法状态)为 blocking 且与结构检查同源', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const now = new Date().toISOString();
    // 孤儿/自指/非法状态均为脏数据,需绕过外键与 CHECK 约束构造(约束仅约束正常写入路径)
    db.pragma('foreign_keys = OFF');
    db.pragma('ignore_check_constraints = ON');
    const orphan = Number(db.prepare("INSERT INTO org (parent_id, code, name, sort_order, status, created_at, updated_at) VALUES (99999, 'ORPH', '孤儿', 0, 'active', ?, ?)").run(now, now).lastInsertRowid);
    const bad = Number(db.prepare("INSERT INTO org (parent_id, code, name, sort_order, status, created_at, updated_at) VALUES (?, 'BAD', '坏状态', 0, 'weird', ?, ?)").run(fx.orgIds.root, now, now).lastInsertRowid);
    db.prepare('UPDATE org SET parent_id = id WHERE id = ?').run(fx.orgIds.west);
    db.prepare('UPDATE account SET parent_id = id WHERE id = ?').run(fx.accIds.expenseRoot);
    db.pragma('ignore_check_constraints = OFF');
    db.pragma('foreign_keys = ON');
    db.prepare("UPDATE account SET type = 'income' WHERE id = ?").run(fx.accIds.expenseSales);

    const orgIssues = orgStructureIssues(db);
    expect(orgIssues.some((issue) => issue.code === 'ORPHAN_NODE' && issue.orgId === orphan && issue.severity === 'blocking')).toBe(true);
    expect(orgIssues.some((issue) => issue.code === 'SELF_PARENT' && issue.orgId === fx.orgIds.west)).toBe(true);
    expect(orgIssues.some((issue) => issue.code === 'INVALID_STATUS' && issue.orgId === bad)).toBe(true);
    const accIssues = accountStructureIssues(db);
    expect(accIssues.some((issue) => issue.code === 'CYCLE' && issue.accountId === fx.accIds.expenseRoot)).toBe(true);
    expect(accIssues.some((issue) => issue.code === 'TYPE_MISMATCH' && issue.accountId === fx.accIds.expenseSales)).toBe(true);

    // 与体检报告同源:报告内包含同一批结构命中
    const report = masterDataHealthReport(db);
    expect(report.blockingCount).toBeGreaterThanOrEqual(5);
    expect(report.groups.every((group) => group.count > 0 && group.summary.length > 0)).toBe(true);
    db.close();
  });

  it('help 仅包含本次命中的 code,分组汇总可读', () => {
    const db = testDb();
    const fx = buildFixture(db);
    standardBudgetVersion(fx);
    const report = masterDataHealthReport(db);
    expect(Object.keys(report.help).sort()).toEqual(['ZERO_DATA_LEAF']);
    expect(report.groups[0].summary).toMatch(/长期零数据叶子共 \d+ 条/);
    db.close();
  });
});

describe('结构检查端点:形状统一 + {ok,problems} 兼容', () => {
  it('/api/org/check 与 /api/account/check 返回 issues 结构并保留 problems', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'health-http-'));
    const dbPath = path.join(dir, 'test.sqlite');
    const { app } = await createTestApp({ dbPath });
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    try {
      // 造一个孤儿组织:先建再直接改库悬空
      const created = await authFetch(`${base}/api/org`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ parentId: null, code: 'T1', name: '临时' }),
      });
      expect(created.status).toBe(201);
      const node = (await created.json()) as { id: number };
      // 通过 better-sqlite3 直接改库造孤儿(测试夹具库为临时库)
      const Database = (await import('better-sqlite3')).default;
      const raw = new Database(dbPath);
      raw.pragma('foreign_keys = OFF');
      raw.prepare('UPDATE org SET parent_id = 99999 WHERE id = ?').run(node.id);
      raw.close();

      const orgCheck = (await (await authFetch(`${base}/api/org/check`)).json()) as {
        ok: boolean; problems: string[]; issues: { code: string; severity: string; orgId?: number }[];
      };
      expect(orgCheck.ok).toBe(false);
      expect(orgCheck.problems.some((p) => p.includes('孤儿节点'))).toBe(true);
      expect(orgCheck.issues.some((issue) => issue.code === 'ORPHAN_NODE' && issue.severity === 'blocking' && issue.orgId === node.id)).toBe(true);

      const accCheck = (await (await authFetch(`${base}/api/account/check`)).json()) as { ok: boolean; problems: string[]; issues: unknown[] };
      expect(accCheck.ok).toBe(true);
      expect(accCheck.problems).toEqual([]);
      expect(accCheck.issues).toEqual([]);
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('structureCheckPayload 纯函数形状', () => {
    expect(structureCheckPayload([])).toEqual({ ok: true, problems: [], issues: [] });
    const payload = structureCheckPayload([{ code: 'CYCLE', severity: 'blocking', message: 'm', orgId: 1 }]);
    expect(payload.ok).toBe(false);
    expect(payload.problems).toEqual(['m']);
  });

  it('/api/dashboard 的 structure 与 /api/org/check 同源:带 issues 结构而不是裸 problems', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'dashboard-structure-'));
    const dbPath = path.join(dir, 'test.sqlite');
    const { app } = await createTestApp({ dbPath });
    const server = app.listen(0);
    await new Promise<void>((resolve) => server.once('listening', () => resolve()));
    const port = (server.address() as { port: number }).port;
    const base = `http://127.0.0.1:${port}`;
    try {
      const created = await authFetch(`${base}/api/org`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ parentId: null, code: 'T1', name: '临时' }),
      });
      const node = (await created.json()) as { id: number };
      const Database = (await import('better-sqlite3')).default;
      const raw = new Database(dbPath);
      raw.pragma('foreign_keys = OFF');
      raw.prepare('UPDATE org SET parent_id = 99999 WHERE id = ?').run(node.id);
      raw.close();

      const dashboard = (await (await authFetch(`${base}/api/dashboard`)).json()) as {
        structure: {
          org: { ok: boolean; problems: string[]; issues: { code: string; severity: string; orgId?: number }[] };
          account: { ok: boolean; problems: string[]; issues: unknown[] };
        };
      };
      expect(dashboard.structure.org.ok).toBe(false);
      expect(dashboard.structure.org.issues.some((issue) => issue.code === 'ORPHAN_NODE' && issue.orgId === node.id)).toBe(true);
      // 与 /api/org/check 的 payload 完全一致(同一信号源)
      const orgCheck = await (await authFetch(`${base}/api/org/check`)).json();
      expect(dashboard.structure.org).toEqual(orgCheck);
      expect(dashboard.structure.account).toEqual(await (await authFetch(`${base}/api/account/check`)).json());
    } finally {
      await new Promise<void>((resolve) => server.close(() => resolve()));
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });
});
