import Database from 'better-sqlite3';
import fs from 'fs';
import path from 'path';
import { isAccountVisibleForScope } from '../src/core/accountScope';
import { createVersion, lockVersion, saveEntries, setCurrentVersion, type BudgetEntryInput } from '../src/modules/budget/budget.service';
import { saveActual, type ActualEntryInput } from '../src/modules/actual/actual.service';
import { backupFileName } from '../src/modules/backup/backup.service';
import type { AccountType } from '../src/core/money';

export type OrgRow = { id: number; code: string; name: string };
export type AccountRow = { id: number; code: string; name: string; type: AccountType; unit: string };

type OrgProfile = {
  industry: 'headquarters' | 'hydro' | 'wind' | 'solar' | 'services';
  revenueYuan: number;
  costRatio: number;
  expenseRatio: number;
  generationWanKwh?: number;
  tariffYuanPerKwh?: number;
  staff: number;
};

const YEAR = 2026;
const BUDGET_NAME = '2026年度全覆盖模拟预算';
const FORECAST_NAME = '2026年度全覆盖模拟预测';

const ORG_PROFILES: Record<string, OrgProfile> = {
  '010101': { industry: 'headquarters', revenueYuan: 126_000_000, costRatio: 0.24, expenseRatio: 0.48, staff: 168 },
  '010102': { industry: 'hydro', revenueYuan: 0, costRatio: 0.34, expenseRatio: 0.16, generationWanKwh: 138_000, tariffYuanPerKwh: 0.382, staff: 126 },
  '010103': { industry: 'hydro', revenueYuan: 0, costRatio: 0.36, expenseRatio: 0.17, generationWanKwh: 112_000, tariffYuanPerKwh: 0.386, staff: 108 },
  '0102': { industry: 'services', revenueYuan: 28_500_000, costRatio: 0.57, expenseRatio: 0.24, staff: 42 },
  '0103': { industry: 'services', revenueYuan: 9_800_000, costRatio: 0.52, expenseRatio: 0.29, staff: 24 },
  '010401': { industry: 'headquarters', revenueYuan: 18_600_000, costRatio: 0.18, expenseRatio: 0.53, staff: 35 },
  '010402': { industry: 'wind', revenueYuan: 0, costRatio: 0.29, expenseRatio: 0.18, generationWanKwh: 31_000, tariffYuanPerKwh: 0.472, staff: 38 },
  '010403': { industry: 'wind', revenueYuan: 0, costRatio: 0.30, expenseRatio: 0.18, generationWanKwh: 27_500, tariffYuanPerKwh: 0.468, staff: 34 },
  '01040401': { industry: 'wind', revenueYuan: 0, costRatio: 0.31, expenseRatio: 0.18, generationWanKwh: 25_800, tariffYuanPerKwh: 0.471, staff: 31 },
  '01040402': { industry: 'wind', revenueYuan: 0, costRatio: 0.30, expenseRatio: 0.18, generationWanKwh: 23_600, tariffYuanPerKwh: 0.469, staff: 29 },
  '01040403': { industry: 'wind', revenueYuan: 0, costRatio: 0.32, expenseRatio: 0.19, generationWanKwh: 21_900, tariffYuanPerKwh: 0.473, staff: 27 },
  '01040404': { industry: 'headquarters', revenueYuan: 12_800_000, costRatio: 0.17, expenseRatio: 0.55, staff: 28 },
  '0105': { industry: 'services', revenueYuan: 76_000_000, costRatio: 0.61, expenseRatio: 0.23, staff: 72 },
  '010601': { industry: 'services', revenueYuan: 64_000_000, costRatio: 0.58, expenseRatio: 0.25, staff: 86 },
  '010602': { industry: 'services', revenueYuan: 31_500_000, costRatio: 0.63, expenseRatio: 0.22, staff: 96 },
  '010603': { industry: 'services', revenueYuan: 48_000_000, costRatio: 0.59, expenseRatio: 0.24, staff: 118 },
  '010701': { industry: 'solar', revenueYuan: 0, costRatio: 0.20, expenseRatio: 0.16, generationWanKwh: 13_500, tariffYuanPerKwh: 0.421, staff: 18 },
  '010702': { industry: 'solar', revenueYuan: 0, costRatio: 0.21, expenseRatio: 0.16, generationWanKwh: 11_800, tariffYuanPerKwh: 0.425, staff: 16 },
  '010703': { industry: 'solar', revenueYuan: 0, costRatio: 0.22, expenseRatio: 0.17, generationWanKwh: 9_600, tariffYuanPerKwh: 0.423, staff: 14 },
  '010704': { industry: 'services', revenueYuan: 82_000_000, costRatio: 0.64, expenseRatio: 0.21, staff: 102 },
};

function stableHash(text: string): number {
  let value = 2166136261;
  for (const char of text) {
    value ^= char.charCodeAt(0);
    value = Math.imul(value, 16777619);
  }
  return value >>> 0;
}

function moneyText(yuan: number): string {
  return Math.max(0.01, Math.round(yuan * 100) / 100).toFixed(2);
}

function quantityText(value: number): string {
  return Math.max(0.0001, Math.round(value * 10_000) / 10_000).toFixed(4);
}

export function leafRows(db: Database.Database, table: 'org' | 'account'): unknown[] {
  return db.prepare(
    `SELECT t.* FROM ${table} t
     WHERE t.status = 'active'
       AND NOT EXISTS (SELECT 1 FROM ${table} child WHERE child.parent_id = t.id)
     ORDER BY t.code`,
  ).all();
}

function energyRevenue(profile: OrgProfile): number {
  if (profile.generationWanKwh == null || profile.tariffYuanPerKwh == null) return profile.revenueYuan;
  const gridRevenue = profile.generationWanKwh * 10_000 * profile.tariffYuanPerKwh / 1.13;
  return gridRevenue / 0.93;
}

function weightedAmounts(accounts: AccountRow[], totalYuan: number, orgCode: string, preferredCode?: string): Map<number, number> {
  const result = new Map<number, number>();
  if (accounts.length === 0) return result;
  const preferred = preferredCode ? accounts.find((account) => account.code === preferredCode) : undefined;
  const preferredAmount = preferred ? totalYuan * 0.93 : 0;
  const remaining = totalYuan - preferredAmount;
  const others = accounts.filter((account) => account !== preferred);
  const weights = others.map((account) => 1 + stableHash(`${orgCode}:${account.code}`) % 11);
  const weightTotal = weights.reduce((sum, value) => sum + value, 0);
  if (preferred) result.set(preferred.id, preferredAmount);
  others.forEach((account, index) => {
    result.set(account.id, weightTotal === 0 ? 0 : remaining * weights[index] / weightTotal);
  });
  return result;
}

function quantityBudget(account: AccountRow, profile: OrgProfile, orgCode: string): number {
  const jitter = 0.96 + (stableHash(`${orgCode}:${account.code}`) % 81) / 1000;
  if (account.code === 'Q101') return (profile.generationWanKwh ?? 1_200) * jitter;
  if (account.code === 'Q103') return (profile.generationWanKwh ?? 1_260) * 1.045 * jitter;
  if (account.code === 'Q2') return (profile.tariffYuanPerKwh ?? 0.42) * jitter;
  if (account.code === 'Q3') return 13;
  if (account.code === 'Q4011') return profile.staff;
  if (account.code === 'Q4012') return Math.max(1, Math.round(profile.staff * 0.045));
  if (account.code === 'Q402') return Math.max(1, Math.round(profile.staff * 0.22));
  if (account.code === 'Q4031') return Math.max(1, Math.round(profile.staff * 0.12));
  if (account.code === 'Q4032') return Math.max(1, Math.round(profile.staff * 0.08));
  return Math.max(1, profile.staff * 0.1 * jitter);
}

/** 历史年度按集团发展轨迹缩放，2026 为当前模拟经营规模。 */
function yearScale(year: number): number {
  const scales: Record<number, number> = { 2022: 0.80, 2023: 0.86, 2024: 0.92, 2025: 0.97, 2026: 1 };
  return scales[year] ?? Math.pow(1.055, year - 2026);
}

export function buildBudgetEntries(orgs: OrgRow[], accounts: AccountRow[], forecast: boolean, year = YEAR): BudgetEntryInput[] {
  const entries: BudgetEntryInput[] = [];
  for (const org of orgs) {
    const profile = ORG_PROFILES[org.code];
    if (!profile) throw new Error(`缺少组织 ${org.code} ${org.name} 的模拟经营画像`);
    const applicable = accounts.filter((account) => isAccountVisibleForScope(account.code, new Set([org.code])));
    const moneyAccounts = {
      income: applicable.filter((account) => account.type === 'income'),
      cost: applicable.filter((account) => account.type === 'cost'),
      expense: applicable.filter((account) => account.type === 'expense'),
    };
    const scale = yearScale(year);
    const revenue = energyRevenue(profile) * scale;
    const targets = {
      income: revenue,
      cost: revenue * profile.costRatio,
      expense: revenue * profile.expenseRatio,
    };
    const values = new Map<number, number>();
    for (const type of ['income', 'cost', 'expense'] as const) {
      const preferredCode = type === 'income' && ['hydro', 'wind', 'solar'].includes(profile.industry) ? 'I1101' : undefined;
      for (const [accountId, amount] of weightedAmounts(moneyAccounts[type], targets[type], org.code, preferredCode)) {
        const direction = type === 'income' ? 1.02 : 1.04;
        const variability = 0.985 + (stableHash(`forecast:${year}:${org.code}:${accountId}`) % 51) / 1000;
        values.set(accountId, forecast ? amount * direction * variability : amount);
      }
    }
    for (const account of applicable) {
      const basis = `模拟测试：${org.name} ${year} 年度${forecast ? '滚动预测' : '经营计划'}，用于全覆盖界面与计算校验`;
      if (account.type === 'quantity') {
        const base = quantityBudget(account, profile, org.code) * scale;
        const value = forecast ? base * (0.99 + (stableHash(`fq:${year}:${org.code}:${account.code}`) % 61) / 1000) : base;
        entries.push({ orgId: org.id, accountId: account.id, quantity: quantityText(value), note: basis });
      } else {
        const amount = values.get(account.id);
        if (amount == null) throw new Error(`未生成 ${org.code}/${account.code} 的金额`);
        const formula = account.type === 'expense' ? `=${moneyText(amount / 12)}*12` : `=${moneyText(amount)}`;
        entries.push({ orgId: org.id, accountId: account.id, amount: moneyText(amount), formula, note: basis });
      }
    }
  }
  return entries;
}

function actualFactor(org: OrgRow, account: AccountRow, progress: number, year: number): number {
  const jitter = 0.91 + (stableHash(`actual:${year}:${org.code}:${account.code}`) % 201) / 1000;
  // 发电量是年内累计量；电价、税率、人数等数量科目是时点值，不随年度时间进度折算。
  const cumulativeQuantity = account.type === 'quantity' && (account.code === 'Q101' || account.code === 'Q103');
  let factor = account.type === 'quantity' && !cumulativeQuantity ? jitter : progress * jitter;
  if (account.type === 'income' && stableHash(account.code) % 17 === 0) factor *= 0.68;
  if ((account.type === 'cost' || account.type === 'expense') && stableHash(`${org.code}:${account.code}`) % 29 === 0) factor *= 1.48;
  // “其他营业成本”在各适用组织统一形成一项汇总超支，确保首页聚合预警链路可重复验证。
  if (progress > 0.6 && account.code === 'C1110') factor = 1.18;
  // 少量明确的全年超支样本，用于验证首页与分析页红色预警。
  if (progress > 0.6 && (account.type === 'cost' || account.type === 'expense') && stableHash(`${org.code}:${account.code}:overspend`) % 173 === 0) {
    factor = 1.08 + (stableHash(account.code) % 16) / 100;
  }
  return factor;
}

export function buildActualEntries(
  db: Database.Database,
  orgs: OrgRow[],
  accounts: AccountRow[],
  budgetVersionId: number,
  progress: number,
  year = YEAR,
): ActualEntryInput[] {
  const budgetRows = db.prepare(
    'SELECT org_id, account_id, amount_cents, quantity FROM budget_entry WHERE version_id = ?',
  ).all(budgetVersionId) as { org_id: number; account_id: number; amount_cents: number; quantity: number | null }[];
  const orgById = new Map(orgs.map((org) => [org.id, org]));
  const accountById = new Map(accounts.map((account) => [account.id, account]));
  return budgetRows.map((row) => {
    const org = orgById.get(row.org_id)!;
    const account = accountById.get(row.account_id)!;
    const factor = actualFactor(org, account, progress, year);
    const memo = `${year} 年模拟累计实际：${org.name} / ${account.name}，进度 ${(progress * 100).toFixed(1)}%`;
    if (account.type === 'quantity') {
      return { orgId: org.id, accountId: account.id, quantity: quantityText((row.quantity ?? 1) / 10_000 * factor), memo };
    }
    const displayCents = account.type === 'income' ? row.amount_cents : -row.amount_cents;
    return { orgId: org.id, accountId: account.id, amount: moneyText(displayCents / 100 * factor), memo };
  });
}

/**
 * 生成 2026 当前年度的模拟数据：预算版本 + 全年预测 + 4 份累计实际快照，两个版本均定稿并设为当前生效。
 *
 * 从 `main()` 里抽出来是为了让 E2E 夹具构建脚本(`seed-e2e-simulation.ts`)复用同一套生成逻辑，
 * 而不是另抄一份——夹具和人工模拟库必须产出完全一致的数据，否则用例断言的数字会两边漂移。
 * 调用方负责保证基线干净(无预算版本、当年无实际数)。
 */
export function seedSimulationYear(db: Database.Database) {
  const orgs = leafRows(db, 'org') as OrgRow[];
  const accounts = leafRows(db, 'account') as AccountRow[];
  return db.transaction(() => {
    const budget = createVersion(db, { year: YEAR, kind: 'budget', name: BUDGET_NAME, note: '全组织、全适用科目模拟测试版本' });
    const budgetEntries = buildBudgetEntries(orgs, accounts, false);
    saveEntries(db, budget.id, budgetEntries);
    lockVersion(db, budget.id);
    const currentBudget = setCurrentVersion(db, budget.id);

    const forecast = createVersion(db, { year: YEAR, kind: 'forecast', name: FORECAST_NAME, note: '基于经营节奏与风险扰动的模拟全年预测' });
    const forecastEntries = buildBudgetEntries(orgs, accounts, true);
    saveEntries(db, forecast.id, forecastEntries);
    lockVersion(db, forecast.id);
    const currentForecast = setCurrentVersion(db, forecast.id);

    const snapshots = [
      { date: '2026-01-31', progress: 31 / 365 },
      { date: '2026-03-31', progress: 90 / 365 },
      { date: '2026-06-30', progress: 181 / 365 },
      { date: '2026-08-22', progress: 234 / 365 },
    ].map(({ date, progress }) => saveActual(db, {
      year: YEAR,
      snapshotDate: date,
      entries: buildActualEntries(db, orgs, accounts, budget.id, progress),
      source: 'manual',
      mode: 'replace',
      note: `全覆盖模拟累计实际（截至 ${date}）`,
    }));

    return { budget: currentBudget, forecast: currentForecast, budgetEntries: budgetEntries.length, forecastEntries: forecastEntries.length, snapshots };
  })();
}

/** 干净基线守卫：生成器只在无预算版本且当年无实际数的库上运行，避免污染真实业务数据。 */
export function assertCleanBaseline(db: Database.Database): void {
  const versionCount = (db.prepare('SELECT COUNT(*) AS count FROM budget_version').get() as { count: number }).count;
  const actualCount = (db.prepare('SELECT COUNT(*) AS count FROM actual_current WHERE year = ?').get(YEAR) as { count: number }).count;
  if (versionCount !== 0 || actualCount !== 0) {
    throw new Error(`为防止污染业务数据，生成器只允许在无预算版本且 ${YEAR} 年无实际数据的干净基线上运行；当前版本=${versionCount}，实际=${actualCount}`);
  }
}

/** 直接运行时的门槛:默认目标是真实库,必须显式确认(E2E 夹具脚本走导出函数,不受影响)。 */
function requireExplicitConfirm(dbPath: string): void {
  if (process.env.NEWFC_SEED_CONFIRM !== '我确认注入模拟数据') {
    throw new Error(`seed:simulation 将向 ${dbPath} 写入 ${YEAR} 年全组织模拟预算与实际快照。\n这是面向演示/开发库的操作。确认请设置 NEWFC_SEED_CONFIRM=我确认注入模拟数据 后重试。`);
  }
}

/** 全组织 × 全适用科目的应填单元格数，用于校验覆盖率。 */
export function applicableCellCount(orgs: OrgRow[], accounts: AccountRow[]): number {
  return orgs.reduce(
    (sum, org) => sum + accounts.filter((account) => isAccountVisibleForScope(account.code, new Set([org.code]))).length,
    0,
  );
}

function main(): void {
  const dbPath = process.env.NEWFC_DATA_DIR
    ? path.join(process.env.NEWFC_DATA_DIR, 'newfc.sqlite')
    : path.join(process.cwd(), 'data', 'newfc.sqlite');
  requireExplicitConfirm(dbPath);
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  try {
    // 写入前先做文件级备份(直接 new Database 绕过了服务启动的 pre-migrate 备份)
    const backupDir = path.join(path.dirname(dbPath), 'backups');
    fs.mkdirSync(backupDir, { recursive: true });
    const backupPath = path.join(backupDir, `pre-seed-simulation-${backupFileName(new Date())}`);
    db.backup(backupPath);
    process.stdout.write(`已写入运行前备份: ${backupPath}\n`);
    assertCleanBaseline(db);
    const orgs = leafRows(db, 'org') as OrgRow[];
    const accounts = leafRows(db, 'account') as AccountRow[];
    const result = seedSimulationYear(db);
    process.stdout.write(`${JSON.stringify({
      year: YEAR,
      leafOrganizations: orgs.length,
      leafAccounts: accounts.length,
      applicableCells: applicableCellCount(orgs, accounts),
      ...result,
    }, null, 2)}\n`);
  } finally {
    db.close();
  }
}

if (require.main === module) main();
