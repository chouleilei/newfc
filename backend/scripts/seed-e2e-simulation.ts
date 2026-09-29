/**
 * 浏览器 E2E「全覆盖模拟数据」夹具构建器。
 *
 * 背景：`full-visual-audit` / `analysis-functional` / `deep-functional-audit` 三个 spec 断言的是
 * 澧水主数据(26 组织 / 239 科目 / 7 个利润表指标)加 2022–2026 五年模拟预算与实际快照，
 * 而 harness 过去只 seed 了 `finance-e2e` 那套四组织七科目的最小夹具，用例自然全红。
 * 这里从**代码里已有的同一份主数据定义**重建整套夹具，不依赖任何本地数据库、备份文件或线上服务：
 *
 *   1. 组织树取 `seed-lishui-org.cjs` 的 ORG_TREE(与运维脚本同源，避免两处漂移)；
 *   2. 科目森林与利润表指标取 `seed-lishui-account.cjs` 的 TREE / QTREE / METRICS；
 *   3. 预设表格由迁移内置，无需额外 seed；
 *   4. 2026 当前年度与 2022–2025 历史年度分别复用 `seed-full-simulation` / `seed-historical-simulation`
 *      导出的生成函数，数字与人工模拟库完全一致。
 *
 * 用法：`npm run seed:e2e:simulation`(在 backend 目录下)
 * 固定重建 `backend/data/e2e-simulation/`，不接受外部路径参数，避免误删真实数据目录。
 */
import fs from 'fs';
import path from 'path';
import { openDatabase } from '../src/db/connection';
import { applyMigrations } from '../src/db/migrations';
import { createOrg } from '../src/modules/org/org.service';
import { createAccount } from '../src/modules/account/account.service';
import { createMetric, type MetricTermInput } from '../src/modules/metric/metric.service';
import type { AccountType } from '../src/core/money';
import {
  applicableCellCount,
  assertCleanBaseline,
  leafRows,
  seedSimulationYear,
  type AccountRow,
  type OrgRow,
} from './seed-full-simulation';
import { seedHistoricalYears } from './seed-historical-simulation';

/* 运维脚本是 CJS 且只在直接执行时才跑 main，这里只取其中的主数据定义。 */
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { ORG_TREE } = require('./seed-lishui-org.cjs') as {
  ORG_TREE: { code: string; name: string; parent: string | null }[];
};
// eslint-disable-next-line @typescript-eslint/no-var-requires
const { TREE, QTREE, METRICS, TYPE_BY_PREFIX } = require('./seed-lishui-account.cjs') as {
  TREE: unknown[][];
  QTREE: QuantityNode[];
  METRICS: MetricDef[];
  TYPE_BY_PREFIX: Record<string, AccountType>;
};

type QuantityNode = { code: string; name: string; unit: string; agg: 'sum' | 'none'; children?: QuantityNode[] };
type MetricDef = {
  code: string;
  name: string;
  displayOrder: number;
  kind?: 'linear' | 'ratio';
  direction?: 'higher_better' | 'lower_better';
  displayFormat?: 'percent' | 'number';
  unit?: string;
  displaySign?: 1 | -1;
  terms: { code?: string; metric?: string; coefficient?: 1 | -1; role?: 'term' | 'numerator' | 'denominator' }[];
};

const EXPECTED_ORGS = 26;
const EXPECTED_ACCOUNTS = 239;

function resetDataDir(dir: string): string {
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'budget.sqlite');
  for (const suffix of ['', '-shm', '-wal']) {
    const target = file + suffix;
    if (fs.existsSync(target)) fs.rmSync(target);
  }
  return file;
}

/** 组织编码是层级式数字码，sort_order 直接取码的数值即天然保序(与运维脚本一致)。 */
function seedOrgs(db: ReturnType<typeof openDatabase>): Map<string, number> {
  const idByCode = new Map<string, number>();
  for (const node of ORG_TREE) {
    const parentId = node.parent == null ? null : idByCode.get(node.parent) ?? null;
    if (node.parent != null && parentId == null) throw new Error(`组织 ${node.code} 的上级 ${node.parent} 尚未创建，请检查 ORG_TREE 顺序`);
    idByCode.set(node.code, createOrg(db, { parentId, code: node.code, name: node.name, sortOrder: Number(node.code) }).id);
  }
  return idByCode;
}

/**
 * 科目森林。金额科目节点形如 `[code, name, children?]`，根节点第 3 位是类型：`[code, name, type, children?]`；
 * 数量科目单独一棵森林，必须带计量单位与汇总方式。
 */
function seedAccounts(db: ReturnType<typeof openDatabase>): Map<string, number> {
  const idByCode = new Map<string, number>();
  let sortOrder = 0;
  const createMoneyNode = (node: unknown[], parentId: number | null, type: AccountType): void => {
    const [code, name, third, fourth] = node as [string, string, unknown, unknown];
    const children = (Array.isArray(third) ? third : Array.isArray(fourth) ? fourth : undefined) as unknown[][] | undefined;
    sortOrder += 1;
    idByCode.set(code, createAccount(db, { parentId, code, name, type, sortOrder }).id);
    for (const child of children ?? []) createMoneyNode(child, idByCode.get(code)!, type);
  };
  const createQuantityNode = (node: QuantityNode, parentId: number | null): void => {
    sortOrder += 1;
    idByCode.set(node.code, createAccount(db, {
      parentId, code: node.code, name: node.name, type: 'quantity', unit: node.unit, quantityAgg: node.agg, sortOrder,
    }).id);
    for (const child of node.children ?? []) createQuantityNode(child, idByCode.get(node.code)!);
  };
  for (const root of TREE) {
    const code = String((root as [string])[0]);
    createMoneyNode(root, null, TYPE_BY_PREFIX[code[0]]);
  }
  for (const root of QTREE) createQuantityNode(root, null);
  return idByCode;
}

/**
 * E20199「在建工程/资本化人工成本(不进损益)」由迁移 7 引入，但它是
 * `INSERT ... SELECT id FROM account WHERE code = 'E201'`——空库建表时 E201 还不存在，
 * 迁移是空操作，因此建完科目森林后必须按同样的定义补上，否则夹具比线上少一个科目、
 * 应填单元格数也会少一整列。
 */
function seedCapitalizedLaborAccount(db: ReturnType<typeof openDatabase>, accountIdByCode: Map<string, number>): void {
  const parentId = accountIdByCode.get('E201');
  if (parentId == null) throw new Error('科目 E201 不存在，无法挂载资本化人工成本科目');
  accountIdByCode.set('E20199', createAccount(db, {
    parentId,
    code: 'E20199',
    name: '其中：在建工程/资本化人工成本(不进损益)',
    type: 'expense',
    sortOrder: 99,
  }).id);
}

/** 利润表指标：METRICS 已按依赖顺序排列，被引用的指标一定先建。 */
function seedMetrics(db: ReturnType<typeof openDatabase>, accountIdByCode: Map<string, number>): void {
  const metricIdByCode = new Map<string, number>();
  for (const def of METRICS) {
    const terms: MetricTermInput[] = def.terms.map((term, index) => {
      const coefficient = term.coefficient ?? 1;
      if (term.metric) {
        const sourceMetricId = metricIdByCode.get(term.metric);
        if (sourceMetricId == null) throw new Error(`指标 ${def.code} 引用了尚未创建的指标 ${term.metric}`);
        return { sourceType: 'metric', sourceMetricId, coefficient, sortOrder: index + 1, role: term.role ?? 'term' };
      }
      const sourceAccountId = accountIdByCode.get(term.code!);
      if (sourceAccountId == null) throw new Error(`指标 ${def.code} 引用了不存在的科目 ${term.code}`);
      return { sourceType: 'account', sourceAccountId, coefficient, sortOrder: index + 1, role: term.role ?? 'term' };
    });
    metricIdByCode.set(def.code, createMetric(db, {
      code: def.code,
      name: def.name,
      displayOrder: def.displayOrder,
      kind: def.kind,
      direction: def.direction,
      displayFormat: def.displayFormat,
      unit: def.unit,
      displaySign: def.displaySign,
      terms,
    }).id);
  }
}

function main(): void {
  // 固定夹具目录(与 seed-finance-e2e 同样的做法)：这个脚本会删库重建，
  // 绝不能被 BUDGET_DATA_DIR 之类的环境变量牵着走——一旦宿主环境指向真实数据目录就是灾难。
  const dir = path.join(process.cwd(), 'data', 'e2e-simulation');
  const file = resetDataDir(dir);
  const db = openDatabase(file);
  try {
    applyMigrations(db);
    assertCleanBaseline(db);

    seedOrgs(db);
    const accountIdByCode = seedAccounts(db);
    seedCapitalizedLaborAccount(db, accountIdByCode);
    seedMetrics(db, accountIdByCode);

    const orgCount = (db.prepare('SELECT COUNT(*) AS count FROM org').get() as { count: number }).count;
    const accountCount = (db.prepare('SELECT COUNT(*) AS count FROM account').get() as { count: number }).count;
    if (orgCount !== EXPECTED_ORGS || accountCount !== EXPECTED_ACCOUNTS) {
      throw new Error(`主数据规模与用例断言不符：组织 ${orgCount}(应 ${EXPECTED_ORGS})、科目 ${accountCount}(应 ${EXPECTED_ACCOUNTS})`);
    }

    // 2026 必须先建：`seed-full-simulation` 的干净基线守卫要求库内尚无任何预算版本。
    const current = seedSimulationYear(db);
    const history = seedHistoricalYears(db);

    const orgs = leafRows(db, 'org') as OrgRow[];
    const accounts = leafRows(db, 'account') as AccountRow[];
    process.stdout.write(`${JSON.stringify({
      database: file,
      organizations: orgCount,
      accounts: accountCount,
      metrics: METRICS.length,
      applicableCells: applicableCellCount(orgs, accounts),
      currentYear: { budget: current.budget.id, forecast: current.forecast.id, entries: current.budgetEntries, snapshots: current.snapshots.length },
      historicalYears: history.map((year) => ({ year: year.year, budget: year.budget.id, entries: year.budgetEntries, snapshots: year.snapshots.length })),
    }, null, 2)}\n`);
  } finally {
    db.close();
  }
}

if (require.main === module) {
  // 同上：脚本完成后立即退出，避免退出阶段的原生析构断言
  main();
  (global as unknown as { gc?: () => void }).gc?.();
  process.exit(0);
}
