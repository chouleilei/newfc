import { openDatabase, type DB } from '../src/db/connection';
import { applyMigrations } from '../src/db/migrations';
import * as org from '../src/modules/org/org.service';
import * as account from '../src/modules/account/account.service';
import * as metric from '../src/modules/metric/metric.service';
import * as budget from '../src/modules/budget/budget.service';
import * as actual from '../src/modules/actual/actual.service';
import { writeLog } from '../src/modules/audit/log';
import os from 'os';
import path from 'path';
import fs from 'fs';

/** 测试公共夹具:内存库 + 标准主数据 */

const openDbs: DB[] = [];

function track<T extends DB>(db: T): T {
  openDbs.push(db);
  return db;
}

/** 关闭并清空本测试文件进程内经 testDb/tempFileDb 打开的全部连接 */
export function closeAllTestDbs(): void {
  while (openDbs.length > 0) {
    const db = openDbs.pop();
    try {
      if (db && db.open) db.close();
    } catch {
      // 已关闭的连接忽略
    }
  }
}

export function testDb(): DB {
  const db = track(openDatabase(':memory:'));
  applyMigrations(db);
  return db;
}

export function tempFileDb(): { db: DB; dir: string; dbPath: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'budget-test-'));
  const dbPath = path.join(dir, 'test.sqlite');
  const db = track(openDatabase(dbPath));
  applyMigrations(db);
  return { db, dir, dbPath };
}

export interface Fixture {
  db: DB;
  orgIds: { root: number; east: number; west: number; shanghai: number; hangzhou: number; nanjing: number };
  accIds: {
    incomeRoot: number; incomeMain: number;
    costRoot: number; costMain: number; costSub: number;
    expenseRoot: number; expenseAdmin: number; expenseSales: number; expenseOther: number;
  };
  metricIds: { gross: number; operating: number };
}

/** 标准夹具:
 * 组织: 集团 > (华东 > 上海/杭州, 西部 > 南京)
 * 科目: 收入>主营收入; 成本>主营业务成本>(材料/人工); 费用>(管理费用/销售费用)
 * 指标: 毛利 = 主营收入 + 主营成本; 营业利润 = 毛利 + 管理费用 + 销售费用
 */
export function buildFixture(db: DB): Fixture {
  const root = org.createOrg(db, { parentId: null, code: 'GROUP', name: '集团' }).id;
  const east = org.createOrg(db, { parentId: root, code: 'EAST', name: '华东大区' }).id;
  const west = org.createOrg(db, { parentId: root, code: 'WEST', name: '西部大区' }).id;
  const shanghai = org.createOrg(db, { parentId: east, code: 'SH', name: '上海公司' }).id;
  const hangzhou = org.createOrg(db, { parentId: east, code: 'HZ', name: '杭州公司' }).id;
  const nanjing = org.createOrg(db, { parentId: west, code: 'NJ', name: '南京公司' }).id;

  const incomeRoot = account.createAccount(db, { parentId: null, code: 'I', name: '收入', type: 'income' }).id;
  const incomeMain = account.createAccount(db, { parentId: incomeRoot, code: 'I01', name: '主营业务收入', type: 'income' }).id;
  const costRoot = account.createAccount(db, { parentId: null, code: 'C', name: '成本', type: 'cost' }).id;
  const costMain = account.createAccount(db, { parentId: costRoot, code: 'C01', name: '主营业务成本', type: 'cost' }).id;
  const costSub = account.createAccount(db, { parentId: costMain, code: 'C0101', name: '材料成本', type: 'cost' }).id;
  const expenseRoot = account.createAccount(db, { parentId: null, code: 'E', name: '费用', type: 'expense' }).id;
  const expenseAdmin = account.createAccount(db, { parentId: expenseRoot, code: 'E01', name: '管理费用', type: 'expense' }).id;
  const expenseSales = account.createAccount(db, { parentId: expenseRoot, code: 'E02', name: '销售费用', type: 'expense' }).id;
  const expenseOther = account.createAccount(db, { parentId: expenseRoot, code: 'E03', name: '其他费用', type: 'expense' }).id;

  const gross = metric.createMetric(db, {
    code: 'GROSS', name: '毛利', displayOrder: 1,
    terms: [
      { sourceType: 'account', sourceAccountId: incomeMain, coefficient: 1 },
      { sourceType: 'account', sourceAccountId: costMain, coefficient: 1 },
    ],
  }).id;
  const operating = metric.createMetric(db, {
    code: 'OP', name: '营业利润', displayOrder: 2,
    terms: [
      { sourceType: 'metric', sourceMetricId: gross, coefficient: 1 },
      { sourceType: 'account', sourceAccountId: expenseAdmin, coefficient: 1 },
      { sourceType: 'account', sourceAccountId: expenseSales, coefficient: 1 },
    ],
  }).id;

  return {
    db,
    orgIds: { root, east, west, shanghai, hangzhou, nanjing },
    accIds: { incomeRoot, incomeMain, costRoot, costMain, costSub, expenseRoot, expenseAdmin, expenseSales, expenseOther },
    metricIds: { gross, operating },
  };
}

/** 建一个 2026 预算版本并录入标准数据(收入100/成本60/费用20 × 上海;收入50/成本30/费用10 × 杭州) */
export function standardBudgetVersion(fx: Fixture, year = 2026, name = 'V1') {
  const v = budget.createVersion(fx.db, { year, name });
  budget.saveEntries(fx.db, v.id, [
    { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '100.00' },
    { orgId: fx.orgIds.shanghai, accountId: fx.accIds.costSub, amount: '60.00' },
    { orgId: fx.orgIds.shanghai, accountId: fx.accIds.expenseAdmin, amount: '20.00' },
    { orgId: fx.orgIds.hangzhou, accountId: fx.accIds.incomeMain, amount: '50.00' },
    { orgId: fx.orgIds.hangzhou, accountId: fx.accIds.costSub, amount: '30.00' },
    { orgId: fx.orgIds.hangzhou, accountId: fx.accIds.expenseSales, amount: '10.00' },
  ]);
  return v;
}

export function saveActualSnapshot(
  fx: Fixture,
  year: number,
  snapshotDate: string,
  rows: { orgId: number; accountId: number; amount: string }[]
) {
  return actual.saveActual(fx.db, {
    year,
    snapshotDate,
    entries: rows,
    source: 'manual',
    mode: 'replace',
  });
}

export { org, account, metric, budget, actual, writeLog };
