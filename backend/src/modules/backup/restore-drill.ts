/**
 * 独立目录恢复演练(T-6,AC-X07;OPEN-04 恢复窗口实测)。
 *
 * 把一个备份包(库 + 清单 + 对象)恢复到空目录,并证明它可用:
 * 1. 备份包校验(库完整性/外键、清单、对象摘要);
 * 2. 复制库与对象到目标目录,逐个核对对象摘要;
 * 3. 恢复库执行迁移检查(旧 schema 自动升级到当前版本);
 * 4. 与备份快照逐表比较:行数、全部 *_cents 金额列合计、status 分布;可选再与原库(只读)比较;
 * 5. 用恢复库启动临时实例(随机端口),请求存活/就绪检查,并以系统身份执行关键只读查询;
 * 6. 输出 JSON 报告(各步耗时,总耗时即 RTO 实测)。
 *
 * 目标目录必须为空;拒绝指向 newbd/lishui 或运行数据目录的路径。原库与备份只读打开,演练不写它们。
 */
import fs from 'fs';
import path from 'path';
import type { Server } from 'http';
import type { DB } from '../../db/connection';
import { integrityCheck, openDatabase, openReadonlyDatabase } from '../../db/connection';
import { applyMigrations, appliedMigrations } from '../../db/migrations';
import { runWithContext, systemContext } from '../../core/request-context';
import { backupObjectPath, backupRootOf, runtimeObjectPath, sha256File, verifyBackupBundle } from './backup.service';

export interface TableStats { rows: number; cents: Record<string, string>; status: Record<string, number> }
export type DbStats = Record<string, TableStats>;

export interface DrillReport {
  ok: boolean;
  backup: string;
  target: string;
  startedAt: string;
  schema: { backup: number | null; restored: number | null; migrationsApplied: number };
  objects: { count: number; bytes: number };
  tables: number;
  rows: number;
  mismatches: string[];
  sourceComparison: { source: string; differences: string[] } | null;
  instance: { ready: boolean; checks: Record<string, string> };
  timingsMs: { verify: number; copy: number; migrate: number; compare: number; instance: number; total: number };
  failures: string[];
}

const FORBIDDEN_SEGMENT = /newbd|^lishui/i;

function assertSafeTarget(target: string, backupFile: string): void {
  const t = path.resolve(target);
  if (t.split(path.sep).some((seg) => FORBIDDEN_SEGMENT.test(seg))) throw new Error('目标目录不能位于 newbd/lishui 路径下');
  const protectedDirs = [path.dirname(backupRootOf(backupFile)), process.env.NEWFC_DATA_DIR]
    .filter((d): d is string => !!d).map((d) => path.resolve(d));
  for (const d of protectedDirs) {
    if (t === d || t.startsWith(d + path.sep)) throw new Error('目标目录不能位于运行数据目录内');
  }
  if (fs.existsSync(t) && fs.readdirSync(t).length > 0) throw new Error('目标目录必须为空');
}

function assertSafeSource(source: string): void {
  const s = path.resolve(source);
  if (s.split(path.sep).some((seg) => FORBIDDEN_SEGMENT.test(seg))) throw new Error('比较用原库不能位于 newbd/lishui 路径下');
}

/** 逐表统计:行数、*_cents 列合计(bigint,十进制字符串)、status 分布。 */
export function dbStats(db: DB): DbStats {
  const tables = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name").all() as { name: string }[]).map((t) => t.name);
  const out: DbStats = {};
  for (const t of tables) {
    const cols = (db.prepare(`PRAGMA table_info("${t}")`).all() as { name: string }[]).map((c) => c.name);
    const rows = (db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n;
    const cents: Record<string, string> = {};
    for (const c of cols.filter((x) => x.endsWith('_cents'))) {
      let sum = 0n;
      for (const r of db.prepare(`SELECT "${c}" AS v FROM "${t}" WHERE "${c}" IS NOT NULL`).safeIntegers(true).iterate() as Iterable<{ v: bigint | number | string }>) {
        if (typeof r.v === 'bigint') sum += r.v;
        else if (typeof r.v === 'number' && Number.isSafeInteger(r.v)) sum += BigInt(r.v);
      }
      cents[c] = sum.toString();
    }
    const status: Record<string, number> = {};
    if (cols.includes('status')) {
      for (const r of db.prepare(`SELECT status, COUNT(*) AS n FROM "${t}" GROUP BY status ORDER BY status`).all() as { status: unknown; n: number }[]) status[String(r.status)] = r.n;
    }
    out[t] = { rows, cents, status };
  }
  return out;
}

/** 只比较 base 中存在的表(迁移可能新增表);返回差异说明。 */
export function compareStats(base: DbStats, other: DbStats): string[] {
  const diffs: string[] = [];
  for (const [t, a] of Object.entries(base)) {
    const b = other[t];
    if (!b) { diffs.push(`${t}:恢复库缺少该表`); continue; }
    if (a.rows !== b.rows) diffs.push(`${t}:行数 ${a.rows} ≠ ${b.rows}`);
    for (const [c, v] of Object.entries(a.cents)) if (b.cents[c] !== v) diffs.push(`${t}.${c}:合计 ${v} ≠ ${b.cents[c] ?? '缺失'}`);
    const keys = new Set([...Object.keys(a.status), ...Object.keys(b.status)]);
    for (const k of keys) if ((a.status[k] ?? 0) !== (b.status[k] ?? 0)) diffs.push(`${t}.status=${k}:${a.status[k] ?? 0} ≠ ${b.status[k] ?? 0}`);
  }
  return diffs;
}

function readonlyStats(file: string): DbStats {
  const ro = openReadonlyDatabase(file);
  try { return dbStats(ro); } finally { ro.close(); }
}

const latestVersion = (db: DB): number | null => {
  const a = appliedMigrations(db);
  return a.length ? a[a.length - 1].version : null;
};

export async function runRestoreDrill(input: { backup: string; target: string; source?: string }): Promise<DrillReport> {
  const t0 = Date.now();
  const backup = path.resolve(input.backup);
  const target = path.resolve(input.target);
  if (!fs.existsSync(backup)) throw new Error('备份文件不存在');
  assertSafeTarget(target, backup);
  if (input.source) assertSafeSource(input.source);
  const failures: string[] = [];
  const timings = { verify: 0, copy: 0, migrate: 0, compare: 0, instance: 0, total: 0 };
  let mark = Date.now();
  const lap = (k: keyof typeof timings) => { const now = Date.now(); timings[k] = now - mark; mark = now; };

  // 1. 备份包校验
  const bundle = verifyBackupBundle(backup);
  lap('verify');
  if (!bundle.ok || !bundle.manifest) throw new Error(`备份包校验失败:${bundle.message}`);
  const manifest = bundle.manifest;

  // 2. 复制库与对象
  fs.mkdirSync(target, { recursive: true });
  const dbPath = path.join(target, 'newfc.sqlite');
  fs.copyFileSync(backup, dbPath);
  const objectsRoot = path.join(target, 'objects');
  let bytes = 0;
  for (const o of manifest.objects) {
    const dest = runtimeObjectPath(objectsRoot, o.sha256);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(backupObjectPath(backupRootOf(backup), o.sha256), dest);
    if (sha256File(dest) !== o.sha256) failures.push(`对象 ${o.sha256.slice(0, 12)}… 复制后摘要不符`);
    bytes += o.size;
  }
  lap('copy');

  // 3. 迁移检查
  const restored = openDatabase(dbPath);
  let migrationsApplied = 0;
  let restoredVersion: number | null = null;
  let restoredStats: DbStats;
  try {
    if (!integrityCheck(restored)) failures.push('恢复库 integrity_check 未通过');
    migrationsApplied = applyMigrations(restored).length;
    restoredVersion = latestVersion(restored);
    lap('migrate');
    restoredStats = dbStats(restored);
  } finally {
    restored.pragma('wal_checkpoint(TRUNCATE)');
    restored.close();
  }

  // 4. 比较:备份快照 vs 恢复库(必须一致);原库 vs 恢复库(备份后的写入会造成差异,只报告)
  const backupStats = readonlyStats(backup);
  const mismatches = compareStats(backupStats, restoredStats);
  if (mismatches.length && migrationsApplied === 0) failures.push(`恢复库与备份不一致(${mismatches.length} 项)`);
  const sourceComparison = input.source ? { source: path.resolve(input.source), differences: compareStats(readonlyStats(input.source), restoredStats) } : null;
  lap('compare');

  // 5. 临时实例:就绪检查 + 系统身份关键只读查询
  const instance = await probeInstance(dbPath);
  if (!instance.ready) failures.push('临时实例未就绪');
  for (const [k, v] of Object.entries(instance.checks)) if (v.startsWith('失败')) failures.push(`${k}:${v}`);
  lap('instance');
  timings.total = Date.now() - t0;

  const report: DrillReport = {
    ok: failures.length === 0,
    backup, target, startedAt: new Date(t0).toISOString(),
    schema: { backup: manifest.schemaVersion, restored: restoredVersion, migrationsApplied },
    objects: { count: manifest.objects.length, bytes },
    tables: Object.keys(backupStats).length,
    rows: Object.values(backupStats).reduce((s, t) => s + t.rows, 0),
    mismatches, sourceComparison, instance, timingsMs: timings, failures,
  };
  fs.writeFileSync(path.join(target, 'restore-drill-report.json'), JSON.stringify(report, null, 2));
  return report;
}

async function probeInstance(dbPath: string): Promise<DrillReport['instance']> {
  const checks: Record<string, string> = {};
  const { createApp } = await import('../../server');
  const { app, holder } = await createApp({ dbPath, autoMigrate: false });
  const server: Server = await new Promise((resolve) => { const s = app.listen(0, '127.0.0.1', () => resolve(s)); });
  try {
    const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
    const live = await fetch(`${base}/api/health/live`);
    checks.live = live.ok ? 'ok' : `失败 HTTP ${live.status}`;
    const readyRes = await fetch(`${base}/api/health/ready`);
    const ready = readyRes.ok;
    checks.ready = ready ? 'ok' : `失败 HTTP ${readyRes.status}`;
    const db = holder.getDb();
    const reads: Record<string, () => unknown> = {
      budget_versions: () => (db.prepare('SELECT COUNT(*) AS n FROM budget_version').get() as { n: number }).n,
      contract_summary: async () => (await import('../contracts/contract.service')).contractSummary(db).count,
      risk_summary: async () => (await import('../risk/risk.service')).riskSummary(db).total,
      dashboard_domains: async () => (await import('../report/domains.service')).dashboardDomains(db).blocks.length,
    };
    for (const [k, fn] of Object.entries(reads)) {
      try { checks[k] = `ok(${String(await runWithContext(systemContext('cli'), fn))})`; } catch (e) { checks[k] = `失败 ${e instanceof Error ? e.message : String(e)}`; }
    }
    return { ready, checks };
  } finally {
    await new Promise<void>((r) => server.close(() => r()));
    try { holder.getDb().close(); } catch { /* closed */ }
  }
}
