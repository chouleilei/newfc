/**
 * newbd 快照迁入(T-6,独立数据迁入;设计见 specs/implementation.md「独立数据迁入」)。
 *
 * - 来源:运维复制出的 newbd 库离线快照,只读打开;拒绝 /root/newbd、/data/newbd 下的运行文件。
 * - 兼容:来源 schema 必须是 newfc 继承的 newbd 迁移序列(V1..V38)的前缀,版本号与名称逐一一致。
 * - 导入:一致性复制到暂存目录 → 按 newfc 迁移升级 → 核对 → 原子换入目标目录。ID 不变,写出
 *   身份映射(源表/源 ID → 目标 ID);不迁入口令/会话、不创建账号;newbd 无文件对象。
 * - 可重跑:目标已存在须 replace;目标库在上次迁入之后有新增写入(非迁入/备份/迁移审计)时拒绝。
 * - 核对报告:逐表行数、金额列合计、按组织/年度/版本状态的预算合计、实际快照合计、外键检查、不可迁移项。
 */
import fs from 'fs';
import path from 'path';
import type { DB } from '../../db/connection';
import { integrityCheck, openDatabase, openReadonlyDatabase } from '../../db/connection';
import { MIGRATIONS, applyMigrations, appliedMigrations } from '../../db/migrations';
import { runWithContext, systemContext } from '../../core/request-context';
import { writeLog } from '../audit/log';
import { sha256File } from './backup.service';
import { compareStats, dbStats } from './restore-drill';

/** newfc 继承自 newbd(c67f6c4)的最后一个迁移版本;V39 起为 newfc 自有迁移。 */
export const INHERITED_MAX_VERSION = 38;
const IMPORT_ACTION = 'governance.newbd_import';
const FORBIDDEN_ROOTS = ['/root/newbd', '/data/newbd'];
const REPORT_FILE = 'newbd-import-report.json';
const ID_MAP_FILE = 'id-map.csv';

export class NewbdImportError extends Error {
  constructor(message: string, readonly details: string[] = []) {
    super(details.length ? `${message}:\n  ${details.join('\n  ')}` : message);
  }
}

interface GroupTotal { key: string; source: string; target: string; ok: boolean }
export interface NewbdImportReport {
  ok: boolean;
  source: { file: string; sha256: string; version: number; migrations: number };
  target: { dir: string; version: number | null; appliedMigrations: number[]; replaced: string | null };
  tables: { table: string; source: number; target: number; idsIdentical: boolean | null; ok: boolean }[];
  amountDifferences: string[];
  budgetTotals: GroupTotal[];
  actualSnapshotTotals: GroupTotal[];
  actualCurrentTotals: GroupTotal[];
  foreignKeyViolations: number;
  accounts: number;
  attachments: { count: number; note: string };
  notMigrated: { item: string; detail: string }[];
  idMapFile: string;
  timingsMs: { total: number };
}

const under = (p: string, root: string) => p === root || p.startsWith(root + path.sep);

function assertSource(file: string): string {
  const abs = path.resolve(file);
  const forbidden = (p: string) => FORBIDDEN_ROOTS.some((r) => under(p, r));
  if (forbidden(abs)) throw new NewbdImportError('来源必须是复制出的离线快照,不能直接指向 newbd 运行目录');
  if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) throw new NewbdImportError(`来源快照不存在: ${abs}`);
  const real = fs.realpathSync(abs);
  if (forbidden(real)) {
    throw new NewbdImportError('来源必须是复制出的离线快照,不能直接指向 newbd 运行目录');
  }
  return real;
}

function assertTarget(dir: string): string {
  const abs = path.resolve(dir);
  if (abs.split(path.sep).some((seg) => /newbd|lishui/i.test(seg))) throw new NewbdImportError('目标目录不能位于 newbd/lishui 路径下');
  return abs;
}

/** 来源迁移记录必须是继承序列的前缀(V1..Vk 连续,名称一致)。 */
export function checkCompatibility(src: DB): { version: number; migrations: number } {
  const hasTable = src.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'schema_migration'").get();
  if (!hasTable) throw new NewbdImportError('来源不是 newbd 库:缺少 schema_migration');
  const rows = src.prepare('SELECT version, name FROM schema_migration ORDER BY version').all() as { version: number; name: string }[];
  if (rows.length === 0) throw new NewbdImportError('来源库没有任何迁移记录');
  const inherited = MIGRATIONS.filter((m) => m.version <= INHERITED_MAX_VERSION).sort((a, b) => a.version - b.version);
  const diffs: string[] = [];
  rows.forEach((r, i) => {
    const exp = inherited[i];
    if (!exp) diffs.push(`V${r.version}(${r.name}):超出继承序列(newfc 只继承到 V${INHERITED_MAX_VERSION})`);
    else if (exp.version !== r.version) diffs.push(`第 ${i + 1} 条迁移为 V${r.version},继承序列应为 V${exp.version}(${exp.name})`);
    else if (exp.name !== r.name) diffs.push(`V${r.version} 名称为 ${r.name},继承序列为 ${exp.name}`);
  });
  if (diffs.length) throw new NewbdImportError('来源 schema 不是 newfc 继承迁移序列的前缀,拒绝迁入', diffs);
  return { version: rows[rows.length - 1].version, migrations: rows.length };
}

/** 目标库在上次迁入之后的新增写入(迁入/备份/迁移自身的审计不算)。 */
function writesAfterImport(dbPath: string): string[] {
  const db = openReadonlyDatabase(dbPath);
  try {
    const marker = db.prepare('SELECT MAX(id) AS id FROM operation_log WHERE action = ?').get(IMPORT_ACTION) as { id: number | null };
    if (marker.id === null) throw new NewbdImportError('目标库不是由迁入工具生成的,拒绝覆盖');
    const rows = db.prepare(`SELECT action, COUNT(*) AS n, MAX(created_at) AS last FROM operation_log
      WHERE id > ? AND action <> ? AND action NOT LIKE 'backup.%' AND action NOT LIKE 'migration.%' GROUP BY action ORDER BY action`)
      .all(marker.id, IMPORT_ACTION) as { action: string; n: number; last: string }[];
    return rows.map((r) => `${r.action} × ${r.n}(最近 ${r.last})`);
  } finally {
    db.close();
  }
}

function sumGroups(db: DB, sql: string): Map<string, bigint> {
  const out = new Map<string, bigint>();
  try {
    for (const r of db.prepare(sql).safeIntegers(true).all() as { k: string; s: bigint | null }[]) out.set(String(r.k), r.s ?? 0n);
  } catch (e) {
    out.set('查询失败', 0n);
    out.set(`错误:${e instanceof Error ? e.message : String(e)}`, 0n);
  }
  return out;
}

function compareGroups(src: DB, tgt: DB, sql: string): GroupTotal[] {
  const a = sumGroups(src, sql);
  const b = sumGroups(tgt, sql);
  const keys = [...new Set([...a.keys(), ...b.keys()])].sort();
  return keys.map((key) => {
    const s = (a.get(key) ?? 0n).toString();
    const t = (b.get(key) ?? 0n).toString();
    return { key, source: s, target: t, ok: a.has(key) && b.has(key) && s === t };
  });
}

const BUDGET_SQL = `SELECT 'org=' || e.org_id || ' year=' || v.year || ' status=' || v.status AS k, SUM(e.amount_cents) AS s
  FROM budget_entry e JOIN budget_version v ON v.id = e.version_id GROUP BY e.org_id, v.year, v.status`;
const SNAPSHOT_SQL = `SELECT 'year=' || b.year || ' status=' || b.status AS k, SUM(e.cumulative_amount_cents) AS s
  FROM actual_snapshot_entry e JOIN actual_snapshot_batch b ON b.id = e.batch_id GROUP BY b.year, b.status`;
const CURRENT_SQL = `SELECT 'year=' || year AS k, SUM(cumulative_amount_cents) AS s FROM actual_current GROUP BY year`;

function userTables(db: DB): string[] {
  return (db.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name <> 'schema_migration' ORDER BY name").all() as { name: string }[]).map((r) => r.name);
}

function idsOf(db: DB, table: string): number[] | null {
  const cols = db.prepare(`PRAGMA table_info("${table}")`).all() as { name: string; pk: number }[];
  if (!cols.some((c) => c.name === 'id' && c.pk === 1)) return null;
  return (db.prepare(`SELECT id FROM "${table}" ORDER BY id`).pluck().all() as number[]);
}

export async function importNewbdSnapshot(input: { source: string; target: string; replace?: boolean }): Promise<NewbdImportReport> {
  const t0 = Date.now();
  const sourceFile = assertSource(input.source);
  const target = assertTarget(input.target);
  const src = openReadonlyDatabase(sourceFile);
  let staging = '';
  try {
    if (!integrityCheck(src)) throw new NewbdImportError('来源快照 integrity_check 未通过');
    const compat = checkCompatibility(src);

    const targetDb = path.join(target, 'newfc.sqlite');
    const exists = fs.existsSync(target) && fs.readdirSync(target).length > 0;
    if (exists) {
      if (!input.replace) throw new NewbdImportError('目标目录已存在,重新迁入须显式 --replace');
      if (fs.existsSync(targetDb)) {
        const writes = writesAfterImport(targetDb);
        if (writes.length) throw new NewbdImportError('目标库在上次迁入之后已有新增写入,拒绝覆盖', writes);
      } else {
        throw new NewbdImportError('目标目录非空且不是迁入目标,拒绝覆盖');
      }
    }

    // 暂存目录内完成全部步骤,核对通过后再换入目标
    staging = `${target}.importing-${process.pid}-${Date.now()}`;
    fs.mkdirSync(staging, { recursive: true });
    const dbPath = path.join(staging, 'newfc.sqlite');
    await src.backup(dbPath);
    const db = openDatabase(dbPath);
    let report: NewbdImportReport;
    try {
      const applied = applyMigrations(db).map((m) => m.version);
      if (!integrityCheck(db)) throw new NewbdImportError('升级后 integrity_check 未通过');
      const accounts = (db.prepare('SELECT COUNT(*) AS n FROM app_user').get() as { n: number }).n;
      if (accounts !== 0) throw new NewbdImportError('迁入结果不应包含任何账号');

      // 逐表行数与身份映射
      const tgtTables = new Set(userTables(db));
      const tables: NewbdImportReport['tables'] = [];
      const idLines = ['table,source_id,target_id'];
      const notMigrated: NewbdImportReport['notMigrated'] = [
        { item: '访问口令与登录会话', detail: 'newbd 使用环境变量口令与进程内会话,不在库中,不迁入;newfc 首个管理员用 npm run admin:create 创建' },
        { item: '账号', detail: '迁入不创建任何账号,也不迁入任何凭据' },
        { item: 'lishui 历史(审批流水、会话、模型日志)', detail: '无导入入口,待 OPEN-03 确认保留范围;业务数据经各域标准文件导入' },
      ];
      for (const t of userTables(src)) {
        const srcRows = (src.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n;
        if (!tgtTables.has(t)) {
          notMigrated.push({ item: `表 ${t}`, detail: `newfc 迁移已移除该表(来源 ${srcRows} 行)` });
          continue;
        }
        const tgtRows = (db.prepare(`SELECT COUNT(*) AS n FROM "${t}"`).get() as { n: number }).n;
        const a = idsOf(src, t);
        const b = idsOf(db, t);
        const idsIdentical = a && b ? a.length === b.length && a.every((id, i) => id === b[i]) : null;
        if (a && idsIdentical) for (const id of a) idLines.push(`${t},${id},${id}`);
        tables.push({ table: t, source: srcRows, target: tgtRows, idsIdentical, ok: srcRows === tgtRows && idsIdentical !== false });
      }
      const amountDifferences = compareStats(dbStats(src), dbStats(db)).filter((d) => d.includes('_cents'));
      const budgetTotals = compareGroups(src, db, BUDGET_SQL);
      const actualSnapshotTotals = compareGroups(src, db, SNAPSHOT_SQL);
      const actualCurrentTotals = compareGroups(src, db, CURRENT_SQL);
      const foreignKeyViolations = (db.pragma('foreign_key_check') as unknown[]).length;
      const objects = (db.prepare('SELECT COUNT(*) AS n FROM file_object').get() as { n: number }).n;
      const sourceSha = sha256File(sourceFile);
      const ok = tables.every((t) => t.ok) && amountDifferences.length === 0 && foreignKeyViolations === 0
        && [...budgetTotals, ...actualSnapshotTotals, ...actualCurrentTotals].every((g) => g.ok);

      fs.writeFileSync(path.join(staging, ID_MAP_FILE), idLines.join('\n') + '\n');
      runWithContext(systemContext('cli'), () => writeLog(db, IMPORT_ACTION, 'newbd_snapshot', sourceSha.slice(0, 16), {
        sourceFile: path.basename(sourceFile), sourceSha256: sourceSha, sourceVersion: compat.version, appliedMigrations: applied, ok,
      }));
      const after = appliedMigrations(db);
      report = {
        ok,
        source: { file: sourceFile, sha256: sourceSha, ...compat },
        target: { dir: target, version: after.length ? after[after.length - 1].version : null, appliedMigrations: applied, replaced: null },
        tables, amountDifferences, budgetTotals, actualSnapshotTotals, actualCurrentTotals, foreignKeyViolations, accounts,
        attachments: { count: objects, note: 'newbd 没有文件对象,附件清单为空' },
        notMigrated,
        idMapFile: path.join(target, ID_MAP_FILE),
        timingsMs: { total: 0 },
      };
      db.pragma('wal_checkpoint(TRUNCATE)');
    } finally {
      db.close();
    }
    if (!report.ok) throw new NewbdImportError('核对未通过,未换入目标目录', [JSON.stringify(report, null, 2)]);

    // 换入:旧目标整体改名保留,暂存目录改名为目标
    if (exists) {
      const replaced = `${target}.replaced-${new Date().toISOString().replace(/[:.]/g, '-')}`;
      fs.renameSync(target, replaced);
      report.target.replaced = replaced;
    } else if (fs.existsSync(target)) {
      fs.rmdirSync(target);
    }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.renameSync(staging, target);
    staging = '';
    report.timingsMs.total = Date.now() - t0;
    fs.writeFileSync(path.join(target, REPORT_FILE), JSON.stringify(report, null, 2));
    return report;
  } finally {
    src.close();
    if (staging) fs.rmSync(staging, { recursive: true, force: true });
  }
}
