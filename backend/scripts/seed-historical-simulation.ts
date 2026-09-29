import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { createVersion, lockVersion, saveEntries, setCurrentVersion } from '../src/modules/budget/budget.service';
import { saveActual } from '../src/modules/actual/actual.service';
import { freezeYear } from '../src/modules/report/report.service';
import { backupFileName } from '../src/modules/backup/backup.service';
import {
  buildActualEntries,
  buildBudgetEntries,
  leafRows,
  type AccountRow,
  type OrgRow,
} from './seed-full-simulation';

const YEARS = [2022, 2023, 2024, 2025] as const;

/**
 * 生成 2022–2025 四个历史年度：每年一个定稿并生效的预算版本 + 4 份季度累计实际快照，年度随后冻结。
 *
 * 抽成导出函数供 E2E 夹具构建脚本复用，保证夹具与人工模拟库的数字完全一致。
 */
export function seedHistoricalYears(db: Database.Database) {
  // 按年份检查:任一目标年度已有预算/实际/快照即拒绝。E2E 夹具会先种当年(2026)数据
  // 再调用本函数,因此这里不能做整库空库校验;对真实库的整库守卫在 main() 里做。
  for (const year of YEARS) {
    const versions = (db.prepare('SELECT COUNT(*) count FROM budget_version WHERE year = ?').get(year) as { count: number }).count;
    const actuals = (db.prepare('SELECT COUNT(*) count FROM actual_current WHERE year = ?').get(year) as { count: number }).count;
    const batches = (db.prepare('SELECT COUNT(*) count FROM actual_snapshot_batch WHERE year = ?').get(year) as { count: number }).count;
    if (versions !== 0 || actuals !== 0 || batches !== 0) {
      throw new Error(`${year} 年已有数据（版本 ${versions}、实际 ${actuals}、快照 ${batches}），为避免覆盖已中止`);
    }
  }

  const orgs = leafRows(db, 'org') as OrgRow[];
  const accounts = leafRows(db, 'account') as AccountRow[];
  return db.transaction(() => YEARS.map((year) => {
    const budget = createVersion(db, {
      year,
      kind: 'budget',
      name: `${year}年度全覆盖模拟预算`,
      note: `${year} 年全组织、全适用科目历史模拟预算`,
    });
    const budgetEntries = buildBudgetEntries(orgs, accounts, false, year);
    saveEntries(db, budget.id, budgetEntries);
    lockVersion(db, budget.id);
    const currentBudget = setCurrentVersion(db, budget.id);

    const snapshotInputs = [
      { date: `${year}-03-31`, progress: 0.25 },
      { date: `${year}-06-30`, progress: 0.50 },
      { date: `${year}-09-30`, progress: 0.75 },
      { date: `${year}-12-31`, progress: 1.00 },
    ];
    const snapshots = snapshotInputs.map(({ date, progress }) => saveActual(db, {
      year,
      snapshotDate: date,
      entries: buildActualEntries(db, orgs, accounts, budget.id, progress, year),
      source: 'manual',
      mode: 'replace',
      note: `${year} 年全覆盖历史模拟累计实际（截至 ${date}）`,
    }));
    const finalBatchId = snapshots[snapshots.length - 1].batchId;
    const yearState = freezeYear(db, year, finalBatchId);
    return {
      year,
      budget: currentBudget,
      budgetEntries: budgetEntries.length,
      actualEntries: buildActualEntries(db, orgs, accounts, budget.id, 1, year).length,
      snapshots,
      yearState,
    };
  }))();
}

function main(): void {
  const dbPath = process.env.BUDGET_DATA_DIR
    ? path.join(process.env.BUDGET_DATA_DIR, 'budget.sqlite')
    : path.join(process.cwd(), 'data', 'budget.sqlite');
  // 直接运行时默认目标是真实库(与 start.sh 同一默认 data 目录)。为防止一次手滑
  // 静默写坏生产数据:整库已有任何业务数据直接拒绝;空库也要求显式确认。
  // E2E 夹具路径不受影响(seed-e2e-simulation 直接调用导出函数)。
  const confirmEnv = process.env.BUDGET_SEED_CONFIRM;
  if (require.main === module && confirmEnv !== '我确认注入模拟数据') {
    throw new Error(`seed:history 将向 ${dbPath} 写入 2022–2025 四年模拟数据并锁定/冻结年度。\n这是面向演示/开发库的操作。确认请设置 BUDGET_SEED_CONFIRM=我确认注入模拟数据 后重试。`);
  }
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  try {
    const count = (table: string) => (db.prepare(`SELECT COUNT(*) count FROM ${table}`).get() as { count: number }).count;
    const [anyVersion, anyActual, anyBatch] = [count('budget_version'), count('actual_current'), count('actual_snapshot_batch')];
    if (anyVersion !== 0 || anyActual !== 0 || anyBatch !== 0) {
      throw new Error(`目标库已存在业务数据（版本 ${anyVersion}、实际 ${anyActual}、快照 ${anyBatch}），拒绝注入历史模拟数据。年份白名单校验挡不住「只有 2026 年真实数据」的新部署,因此这里做整库检查`);
    }
    // 写入前先做文件级备份(直接 new Database 绕过了服务启动的 pre-migrate 备份)
    const backupDir = path.join(path.dirname(dbPath), 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const backupPath = path.join(backupDir, `pre-seed-history-${backupFileName(new Date())}`);
    db.backup(backupPath);
    process.stdout.write(`已写入运行前备份: ${backupPath}\n`);
    process.stdout.write(`${JSON.stringify({ years: seedHistoricalYears(db) }, null, 2)}\n`);
  } finally {
    db.close();
  }
}

if (require.main === module) main();
