import fs from 'fs';
import path from 'path';
import type { DB } from '../../db/connection';
import { openDatabase, openReadonlyDatabase, integrityCheck } from '../../db/connection';
import { Errors } from '../../core/errors';
import { writeLog } from '../audit/log';
import { applyMigrations, appliedMigrations } from '../../db/migrations';

/** 备份与恢复(方案十三):better-sqlite3 backup API,在线安全执行。 */

const DAILY_KEEP = 30;
const MONTHLY_KEEP = 24;

// better-sqlite3 的 backup() 是异步的，而文件名判重与月度副本创建都是文件系统操作。
// 进程内统一串行，避免同秒请求在 existsSync 与真正落盘之间争用同一路径。
let backupQueue: Promise<void> = Promise.resolve();

export function backupDirOf(dbPath: string): string {
  return path.join(path.dirname(dbPath), 'backups');
}

function pad(n: number): string {
  return String(n).padStart(2, '0');
}

export function backupFileName(now = new Date()): string {
  return `budget-backup-${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}-${pad(now.getHours())}${pad(now.getMinutes())}${pad(now.getSeconds())}.sqlite`;
}

/** 在线备份(better-sqlite3 backup API,不直接复制使用中的数据库文件) */
export function createBackup(db: DB, dir: string, tag = ''): Promise<{ file: string; monthly: boolean }> {
  if (tag && !/^[A-Za-z0-9_-]{1,40}$/.test(tag)) {
    return Promise.reject(Errors.validation('备份标签仅允许 1-40 位字母、数字、下划线或连字符'));
  }
  const task = backupQueue.then(() => createBackupSerial(db, dir, tag));
  // 某次失败不能让后续备份永远挂在 rejected 队列上。
  backupQueue = task.then(() => undefined, () => undefined);
  return task;
}

async function createBackupSerial(db: DB, dir: string, tag: string): Promise<{ file: string; monthly: boolean }> {
  fs.mkdirSync(dir, { recursive: true });
  const prefix = tag ? `${tag}-` : '';
  // 一次生成固定一个时间基名；否则跨秒时序号循环会改换基名并造成不可预测结果。
  const baseName = prefix + backupFileName(new Date());
  let name = baseName;
  // 同秒内多次备份时避免文件名冲突
  let seq = 1;
  while (fs.existsSync(path.join(dir, name))) {
    name = `${baseName.replace(/\.sqlite$/, '')}-${seq++}.sqlite`;
  }
  const dest = path.join(dir, name);
  if (path.dirname(path.resolve(dest)) !== path.resolve(dir)) throw Errors.validation('非法备份目标路径');
  try {
    await db.backup(dest);
    // 只有无标签的系统自动备份参与月度归档；人工及迁移/恢复前里程碑永久保留在日备目录。
    const monthly = tag === '' && isMonthlyKeep(dest, dir);
    if (monthly) {
      const monthlyDir = path.join(dir, 'monthly');
      fs.mkdirSync(monthlyDir, { recursive: true });
      fs.copyFileSync(dest, path.join(monthlyDir, name));
      pruneBackups(monthlyDir, MONTHLY_KEEP, new Set(), new Set([name]));
    }
    pruneBackups(dir, DAILY_KEEP, new Set(['monthly']), new Set([name]));
    writeLog(db, 'backup.create', 'backup', path.basename(dest), { file: path.basename(dest), tag });
    return { file: path.basename(dest), monthly };
  } catch (error) {
    // 只清理由本次调用独占的未完成目标；串行队列保证不会误删另一请求的成品。
    if (fs.existsSync(dest)) fs.unlinkSync(dest);
    throw error;
  }
}

/** 每月第一个备份保留为长期归档(按月判定,保留约 24 个月) */
function isMonthlyKeep(dest: string, dir: string): boolean {
  const monthOf = (f: string) => /budget-backup-(\d{4}-\d{2})-\d{2}/.exec(f)?.[1];
  const thisMonth = monthOf(path.basename(dest));
  if (!thisMonth) return false;
  // 根目录与 monthly/ 任一处本月已有归档即不再重复归档
  const monthlyDir = path.join(dir, 'monthly');
  const candidates = [dir, monthlyDir]
    .filter((d) => fs.existsSync(d))
    .flatMap((d) => fs.readdirSync(d))
    .filter((f) => isAutomaticBackupName(f) && f !== path.basename(dest) && monthOf(f) != null);
  return !candidates.some((f) => monthOf(f) === thisMonth);
}

function isAutomaticBackupName(name: string): boolean {
  return /^budget-backup-\d{4}-\d{2}-\d{2}-\d{6}(?:-\d+)?\.sqlite$/.test(name);
}

/** 根据 scope 解析备份文件路径;名称只允许纯文件名,防止路径穿越 */
export function resolveBackupFile(dir: string, name: string, scope?: string): string {
  if (!name || name.includes('..') || name.includes('/') || name.includes('\\')) {
    throw Errors.validation('非法文件名');
  }
  const base = scope === 'monthly' ? path.join(dir, 'monthly') : dir;
  const resolved = path.join(base, name);
  if (path.dirname(resolved) !== path.resolve(base)) throw Errors.validation('非法文件名');
  return resolved;
}

function backupTimeKey(name: string, mtimeMs: number): { timeMs: number; sequence: number } {
  // 标签位于 budget-backup 之前，因此从任意合法标签文件名中提取同一段时间。
  const match = /budget-backup-(\d{4})-(\d{2})-(\d{2})-(\d{2})(\d{2})(\d{2})(?:-(\d+))?\.sqlite$/.exec(name);
  if (match) {
    const [, year, month, day, hour, minute, second, sequence = '0'] = match;
    // 文件名由本机本地时间生成；转成 epoch 后才能与旧格式文件的 mtime 放在同一时间轴比较。
    const parts = [year, month, day, hour, minute, second].map(Number);
    const embedded = new Date(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]);
    const valid = embedded.getFullYear() === parts[0]
      && embedded.getMonth() === parts[1] - 1
      && embedded.getDate() === parts[2]
      && embedded.getHours() === parts[3]
      && embedded.getMinutes() === parts[4]
      && embedded.getSeconds() === parts[5];
    if (valid) return { timeMs: embedded.getTime(), sequence: Number(sequence) };
  }
  // 兼容早期或手工放入的备份：无可解析时间时回退 mtime，并与标准文件按真实时间混排。
  return { timeMs: mtimeMs, sequence: 0 };
}

export function pruneBackups(
  dir: string,
  keep: number,
  excludeSubdirs: Set<string> = new Set(),
  protectedNames: Set<string> = new Set(),
): void {
  if (!fs.existsSync(dir)) return;
  const entries = fs.readdirSync(dir, { withFileTypes: true });
  const files = entries
    // 仅无标签的系统自动备份受数量上限约束。标签备份是人工或系统迁移/恢复里程碑，
    // 不参与自动备份计数，也绝不能被静默清理。
    .filter((e) => e.isFile() && isAutomaticBackupName(e.name))
    .map((e) => {
      const stat = fs.statSync(path.join(dir, e.name));
      return { name: e.name, key: backupTimeKey(e.name, stat.mtimeMs), mtimeMs: stat.mtimeMs };
    })
    .sort((a, b) => a.key.timeMs - b.key.timeMs
      || a.key.sequence - b.key.sequence
      || a.mtimeMs - b.mtimeMs
      || a.name.localeCompare(b.name));
  const excess = files.length - keep;
  if (excess > 0) {
    let removed = 0;
    for (const file of files) {
      if (removed >= excess) break;
      if (protectedNames.has(file.name)) continue;
      fs.unlinkSync(path.join(dir, file.name));
      removed += 1;
    }
  }
  void excludeSubdirs;
}

export function listBackups(dir: string): { name: string; size: number; mtime: string; monthly: boolean }[] {
  const result: { name: string; size: number; mtime: string; monthly: boolean }[] = [];
  if (fs.existsSync(dir)) {
    for (const f of fs.readdirSync(dir)) {
      const p = path.join(dir, f);
      if (!f.endsWith('.sqlite') || !fs.statSync(p).isFile()) continue;
      const st = fs.statSync(p);
      result.push({ name: f, size: st.size, mtime: st.mtime.toISOString(), monthly: false });
    }
  }
  const monthlyDir = path.join(dir, 'monthly');
  if (fs.existsSync(monthlyDir)) {
    for (const f of fs.readdirSync(monthlyDir)) {
      const p = path.join(monthlyDir, f);
      if (!f.endsWith('.sqlite') || !fs.statSync(p).isFile()) continue;
      const st = fs.statSync(p);
      result.push({ name: f, size: st.size, mtime: st.mtime.toISOString(), monthly: true });
    }
  }
  return result.sort((a, b) => b.mtime.localeCompare(a.mtime) || b.name.localeCompare(a.name));
}

/** 验证备份文件:可打开且 integrity_check 通过 */
export function verifyBackupFile(file: string): { ok: boolean; message: string } {
  if (!fs.existsSync(file)) return { ok: false, message: '备份文件不存在' };
  let test: DB | null = null;
  try {
    // 备份文件以真正的 SQLite readonly 连接打开，不执行任何写 pragma/迁移。
    test = openReadonlyDatabase(file);
    if (!integrityCheck(test)) return { ok: false, message: 'integrity_check 未通过' };
    const hasTable = test.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migration'").get();
    if (!hasTable) return { ok: false, message: '不是本系统的备份文件(缺少 schema_migration 表)' };
    return { ok: true, message: 'ok' };
  } catch (err) {
    // 内部异常细节(绝对路径、SQLite 错误原文)只进日志,不回传客户端
    console.error('[backup] 备份校验失败:', err);
    return { ok: false, message: '备份文件无法打开或校验失败' };
  } finally {
    test?.close();
  }
}

export interface RestoreHandle {
  getDb(): DB;
  reopenWith(db: DB): void;
}

/**
 * 恢复流程(方案十三.2):检查备份格式 → integrity_check → 自动备份当前库 →
 * 停止写入 → 替换数据库 → 完整性检查 → 重新打开。调用方需二次确认。
 */
export async function restoreBackup(
  handle: RestoreHandle,
  dbPath: string,
  backupFile: string,
  confirmed: boolean
): Promise<{
  ok: boolean;
  message: string;
  originalVersion: number | null;
  appliedMigrations: { version: number; name: string }[];
  finalVersion: number | null;
}> {
  if (!confirmed) throw Errors.validation('恢复操作需要二次确认(confirmed=true)');
  const check = verifyBackupFile(backupFile);
  if (!check.ok) throw Errors.validation(`备份文件校验失败: ${check.message}`);
  const dir = backupDirOf(dbPath);
  fs.mkdirSync(dir, { recursive: true });
  // 先复制恢复目标到不参与 .sqlite 保留清理的临时文件，避免目标恰为最旧日备时被删除。
  const stagedSource = path.join(dir, `.restore-source-${process.pid}-${Date.now()}.tmp`);
  fs.copyFileSync(backupFile, stagedSource);
  const stagedCheck = verifyBackupFile(stagedSource);
  if (!stagedCheck.ok) {
    fs.unlinkSync(stagedSource);
    throw Errors.validation(`恢复目标临时副本校验失败: ${stagedCheck.message}`);
  }
  // 恢复前自动备份当前库；失败后的回滚也以该备份为准。
  const db = handle.getDb();
  let rollbackFile = '';
  let candidate: DB | null = null;
  let closed = false;
  let installed = false;
  try {
    const preRestore = await createBackup(db, dir, 'pre-restore');
    rollbackFile = path.join(dir, preRestore.file);
    db.pragma('wal_checkpoint(TRUNCATE)');
    db.close();
    closed = true;
    fs.copyFileSync(stagedSource, dbPath);
    for (const ext of ['-wal', '-shm']) {
      const p = dbPath + ext;
      if (fs.existsSync(p)) fs.unlinkSync(p);
    }
    candidate = openDatabase(dbPath);
    if (!integrityCheck(candidate)) throw new Error('恢复后完整性检查未通过');
    const before = appliedMigrations(candidate);
    const originalVersion = before.length > 0 ? before[before.length - 1].version : null;
    // 旧版备份是合法恢复输入，但不能在返回成功后继续以旧 schema 对外服务。
    // 在候选连接尚未安装到 holder 前完成迁移；任一迁移失败都会走下方旧库回滚路径。
    const migrated = applyMigrations(candidate);
    if (!integrityCheck(candidate)) throw new Error('恢复迁移后完整性检查未通过');
    const after = appliedMigrations(candidate);
    const finalVersion = after.length > 0 ? after[after.length - 1].version : null;
    handle.reopenWith(candidate);
    installed = true;
    candidate = null;
    const restored = handle.getDb();
    const migrationSummary = migrated.map((item) => ({ version: item.version, name: item.name }));
    writeLog(restored, 'backup.restore', 'backup', path.basename(backupFile), {
      file: path.basename(backupFile),
      originalVersion,
      appliedMigrations: migrationSummary,
      finalVersion,
    });
    return {
      ok: true,
      message: migrated.length > 0 ? `恢复完成，已自动应用 ${migrated.length} 项迁移` : '恢复完成',
      originalVersion,
      appliedMigrations: migrationSummary,
      finalVersion,
    };
  } catch (error) {
    candidate?.close();
    if (closed) {
      try {
        if (installed) handle.getDb().close();
        if (!rollbackFile || !fs.existsSync(rollbackFile)) throw new Error('恢复前备份不存在');
        fs.copyFileSync(rollbackFile, dbPath);
        for (const ext of ['-wal', '-shm']) {
          const p = dbPath + ext;
          if (fs.existsSync(p)) fs.unlinkSync(p);
        }
        const reopened = openDatabase(dbPath);
        if (!integrityCheck(reopened)) { reopened.close(); throw new Error('回滚库完整性检查未通过'); }
        handle.reopenWith(reopened);
      } catch (rollbackError) {
        throw new Error(`恢复失败且旧库重开失败: ${error instanceof Error ? error.message : String(error)}; ${rollbackError instanceof Error ? rollbackError.message : String(rollbackError)}`);
      }
    }
    throw error;
  } finally {
    if (fs.existsSync(stagedSource)) fs.unlinkSync(stagedSource);
  }
}
