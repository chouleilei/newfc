import crypto from 'crypto';
import fs from 'fs';
import Database from 'better-sqlite3';
import path from 'path';
import type { DB } from '../../db/connection';
import { openDatabase, openReadonlyDatabase, integrityCheck } from '../../db/connection';
import { Errors } from '../../core/errors';
import { writeLog } from '../audit/log';
import { applyMigrations, appliedMigrations } from '../../db/migrations';

/**
 * 备份与恢复(方案十三;T-6 AC-X07 一致性备份包):
 * - 每次备份 = SQLite 在线备份 + 同名 .manifest.json(schema 版本、库 sha256、库中全部 file_object 的 sha256/大小);
 * - 备份目录下 objects/ 按内容寻址保存对象副本,已有对象不重复复制,同一文件系统用硬链接;
 * - 清理旧备份时一并删除清单,并回收不再被任何清单引用的备份对象;
 * - 校验 = 库 integrity/foreign_key + 清单与库一致 + 每个对象存在且摘要正确;
 * - 页面恢复先补齐运行对象目录中缺失的对象,再替换数据库。
 */

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
    // 备份继承源库的 WAL 模式,之后每次只读校验都会在旁边生成 -wal/-shm;改为回滚日志模式,
    // 使备份成为自包含的单个文件(清单摘要在此之后计算)
    const standalone = new Database(dest);
    try { standalone.pragma('journal_mode = DELETE'); } finally { standalone.close(); }
    const manifest = writeBundle(dest, dir, runtimeObjectsRootOf(db));
    // 只有无标签的系统自动备份参与月度归档；人工及迁移/恢复前里程碑永久保留在日备目录。
    const monthly = tag === '' && isMonthlyKeep(dest, dir);
    if (monthly) {
      const monthlyDir = path.join(dir, 'monthly');
      fs.mkdirSync(monthlyDir, { recursive: true });
      fs.copyFileSync(dest, path.join(monthlyDir, name));
      fs.copyFileSync(manifestPathOf(dest), manifestPathOf(path.join(monthlyDir, name)));
      pruneBackups(monthlyDir, MONTHLY_KEEP, new Set(), new Set([name]));
    }
    pruneBackups(dir, DAILY_KEEP, new Set(['monthly']), new Set([name]));
    gcBackupObjects(dir);
    writeLog(db, 'backup.create', 'backup', path.basename(dest), {
      file: path.basename(dest), tag, objects: manifest.objects.length, missingObjects: manifest.missingObjects.length,
    });
    return { file: path.basename(dest), monthly };
  } catch (error) {
    // 只清理由本次调用独占的未完成目标；串行队列保证不会误删另一请求的成品。
    if (fs.existsSync(dest)) fs.unlinkSync(dest);
    if (fs.existsSync(manifestPathOf(dest))) fs.unlinkSync(manifestPathOf(dest));
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
      const manifest = manifestPathOf(path.join(dir, file.name));
      if (fs.existsSync(manifest)) fs.unlinkSync(manifest);
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

/** 数据库层校验:可只读打开、integrity_check、foreign_key_check,且是本系统库。 */
export function verifyDbFile(file: string): { ok: boolean; message: string } {
  if (!fs.existsSync(file)) return { ok: false, message: '备份文件不存在' };
  let test: DB | null = null;
  try {
    // 备份文件以真正的 SQLite readonly 连接打开，不执行任何写 pragma/迁移。
    test = openReadonlyDatabase(file);
    if (!integrityCheck(test)) return { ok: false, message: 'integrity_check 未通过' };
    const hasTable = test.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='schema_migration'").get();
    if (!hasTable) return { ok: false, message: '不是本系统的备份文件(缺少 schema_migration 表)' };
    const fk = test.pragma('foreign_key_check') as unknown[];
    if (fk.length) return { ok: false, message: `foreign_key_check 发现 ${fk.length} 处外键不一致` };
    return { ok: true, message: 'ok' };
  } catch (err) {
    // 内部异常细节(绝对路径、SQLite 错误原文)只进日志,不回传客户端
    console.error('[backup] 备份校验失败:', err);
    return { ok: false, message: '备份文件无法打开或校验失败' };
  } finally {
    test?.close();
  }
}

/** 验证备份文件(完整备份包):数据库层 + 清单 + 对象。返回首个失败原因。 */
export function verifyBackupFile(file: string): { ok: boolean; message: string } {
  const r = verifyBackupBundle(file);
  return { ok: r.ok, message: r.message };
}

export interface BundleCheck { name: string; ok: boolean; detail: string }

export function verifyBackupBundle(file: string): { ok: boolean; message: string; checks: BundleCheck[]; manifest: BackupManifest | null } {
  const checks: BundleCheck[] = [];
  const done = (manifest: BackupManifest | null) => {
    const bad = checks.find((c) => !c.ok);
    return { ok: !bad, message: bad ? bad.detail : 'ok', checks, manifest };
  };
  const dbCheck = verifyDbFile(file);
  checks.push({ name: 'database', ok: dbCheck.ok, detail: dbCheck.ok ? '完整性与外键检查通过' : dbCheck.message });
  if (!dbCheck.ok) return done(null);
  const manifest = readManifest(file);
  if (!manifest) {
    checks.push({ name: 'manifest', ok: false, detail: '缺少或无法解析备份清单(.manifest.json)' });
    return done(null);
  }
  checks.push({ name: 'manifest', ok: manifest.dbFile === path.basename(file), detail: manifest.dbFile === path.basename(file) ? `清单 V${manifest.schemaVersion ?? '-'}` : '清单与备份文件名不对应' });
  const sha = sha256File(file);
  checks.push({ name: 'db_sha256', ok: sha === manifest.dbSha256, detail: sha === manifest.dbSha256 ? '库文件摘要一致' : '库文件摘要与清单不一致' });
  const rows = objectRowsOf(file);
  const key = (o: { sha256: string; size: number }) => `${o.sha256}:${o.size}`;
  const inDb = new Set(rows.map(key));
  const inManifest = new Set(manifest.objects.map(key));
  const listed = rows.length === manifest.objects.length && [...inDb].every((k) => inManifest.has(k));
  checks.push({ name: 'object_list', ok: listed, detail: listed ? `清单登记 ${rows.length} 个对象,与库一致` : `清单对象(${manifest.objects.length})与库中 file_object(${rows.length})不一致` });
  const root = backupRootOf(file);
  const missing: string[] = [];
  const corrupt: string[] = [];
  for (const o of manifest.objects) {
    const p = backupObjectPath(root, o.sha256);
    if (!fs.existsSync(p)) missing.push(o.sha256);
    else if (sha256File(p) !== o.sha256) corrupt.push(o.sha256);
  }
  const objOk = missing.length === 0 && corrupt.length === 0;
  checks.push({
    name: 'objects', ok: objOk,
    detail: objOk ? `${manifest.objects.length} 个对象存在且摘要正确` : `备份对象缺失 ${missing.length} 个、摘要不符 ${corrupt.length} 个${manifest.missingObjects.length ? `(备份时运行目录已缺 ${manifest.missingObjects.length} 个)` : ''}`,
  });
  return done(manifest);
}

/* ---------------- 备份包:清单与对象 ---------------- */

export interface BackupManifest {
  format: 'newfc-backup/1';
  dbFile: string;
  createdAt: string;
  schemaVersion: number | null;
  dbSha256: string;
  dbSize: number;
  objects: { sha256: string; size: number }[];
  /** 备份时运行对象目录中已缺失的对象(备份包因此不完整,校验会失败) */
  missingObjects: string[];
}

export function manifestPathOf(file: string): string {
  return file.replace(/\.sqlite$/, '') + '.manifest.json';
}

/** 备份根目录:月度副本位于 <根>/monthly,共享 <根>/objects。 */
export function backupRootOf(file: string): string {
  const d = path.dirname(path.resolve(file));
  return path.basename(d) === 'monthly' ? path.dirname(d) : d;
}

export function backupObjectPath(root: string, sha256: string): string {
  if (!/^[0-9a-f]{64}$/.test(sha256)) throw new Error('非法对象摘要');
  return path.join(root, 'objects', 'sha256', sha256.slice(0, 2), sha256);
}

/** 运行对象目录:与数据库同目录的 objects/(见 ObjectStore.forDbPath);内存库没有运行对象目录。 */
function runtimeObjectsRootOf(db: DB): string | null {
  return db.name && db.name !== ':memory:' ? path.join(path.dirname(db.name), 'objects') : null;
}

export function runtimeObjectPath(objectsRoot: string, sha256: string): string {
  return path.join(objectsRoot, 'sha256', sha256.slice(0, 2), sha256);
}

export function sha256File(file: string): string {
  const hash = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    let n: number;
    while ((n = fs.readSync(fd, buf, 0, buf.length, null)) > 0) hash.update(buf.subarray(0, n));
  } finally {
    fs.closeSync(fd);
  }
  return hash.digest('hex');
}

/** 备份库中登记的文件对象(只读打开;旧 schema 无 file_object 表时为空)。 */
export function objectRowsOf(file: string): { sha256: string; size: number }[] {
  const ro = openReadonlyDatabase(file);
  try {
    if (!ro.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'file_object'").get()) return [];
    return ro.prepare('SELECT sha256, size_bytes AS size FROM file_object ORDER BY sha256').all() as { sha256: string; size: number }[];
  } finally {
    ro.close();
  }
}

function schemaVersionOf(file: string): number | null {
  const ro = openReadonlyDatabase(file);
  try {
    return (ro.prepare('SELECT MAX(version) AS v FROM schema_migration').get() as { v: number | null }).v;
  } catch {
    return null;
  } finally {
    ro.close();
  }
}

export function readManifest(file: string): BackupManifest | null {
  const p = manifestPathOf(file);
  if (!fs.existsSync(p)) return null;
  try {
    const m = JSON.parse(fs.readFileSync(p, 'utf8')) as BackupManifest;
    return m.format === 'newfc-backup/1' && Array.isArray(m.objects) ? m : null;
  } catch {
    return null;
  }
}

/** 复制(或硬链接)一个不可变对象:先写临时文件再改名,目标已存在且大小一致时跳过。 */
function placeObject(src: string, dest: string, size: number, preferLink: boolean): void {
  if (fs.existsSync(dest) && fs.statSync(dest).size === size) return;
  fs.mkdirSync(path.dirname(dest), { recursive: true });
  const tmp = `${dest}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    if (preferLink) {
      try { fs.linkSync(src, tmp); } catch { fs.copyFileSync(src, tmp); }
    } else {
      fs.copyFileSync(src, tmp);
    }
    fs.renameSync(tmp, dest);
  } finally {
    if (fs.existsSync(tmp)) fs.unlinkSync(tmp);
  }
}

/** 为刚生成的备份写对象副本与清单;对象列表取自备份库本身,保证与库快照一致。 */
function writeBundle(dest: string, dir: string, objectsRoot: string | null): BackupManifest {
  const objects = objectRowsOf(dest);
  const missingObjects: string[] = [];
  for (const o of objects) {
    const src = objectsRoot ? runtimeObjectPath(objectsRoot, o.sha256) : null;
    if (!src || !fs.existsSync(src)) { missingObjects.push(o.sha256); continue; }
    placeObject(src, backupObjectPath(dir, o.sha256), o.size, true);
  }
  const stat = fs.statSync(dest);
  const manifest: BackupManifest = {
    format: 'newfc-backup/1', dbFile: path.basename(dest), createdAt: new Date().toISOString(), schemaVersion: schemaVersionOf(dest),
    dbSha256: sha256File(dest), dbSize: stat.size, objects, missingObjects,
  };
  const p = manifestPathOf(dest);
  fs.writeFileSync(`${p}.tmp`, JSON.stringify(manifest, null, 2));
  fs.renameSync(`${p}.tmp`, p);
  return manifest;
}

/** 回收不再被任何清单(根目录与 monthly/)引用的备份对象。 */
export function gcBackupObjects(root: string): number {
  const objectsDir = path.join(root, 'objects', 'sha256');
  if (!fs.existsSync(objectsDir)) return 0;
  const referenced = new Set<string>();
  for (const d of [root, path.join(root, 'monthly')]) {
    if (!fs.existsSync(d)) continue;
    for (const f of fs.readdirSync(d)) {
      if (!f.endsWith('.manifest.json')) continue;
      const m = readManifest(path.join(d, f.replace(/\.manifest\.json$/, '.sqlite')));
      // 无法解析的清单:保守起见不回收任何对象
      if (!m) return 0;
      for (const o of m.objects) referenced.add(o.sha256);
    }
  }
  let removed = 0;
  for (const prefix of fs.readdirSync(objectsDir)) {
    const sub = path.join(objectsDir, prefix);
    if (!fs.statSync(sub).isDirectory()) continue;
    for (const f of fs.readdirSync(sub)) {
      if (/^[0-9a-f]{64}$/.test(f) && !referenced.has(f)) { fs.unlinkSync(path.join(sub, f)); removed += 1; }
    }
  }
  return removed;
}

/** 运行对象目录核对:库中登记的对象是否都在且摘要正确(用于校验页面与恢复前检查)。 */
export function checkRuntimeObjects(db: DB, objectsRoot: string): { total: number; missing: string[]; corrupt: string[] } {
  const rows = db.prepare('SELECT sha256 FROM file_object ORDER BY id').all() as { sha256: string }[];
  const missing: string[] = [];
  const corrupt: string[] = [];
  for (const r of rows) {
    const p = runtimeObjectPath(objectsRoot, r.sha256);
    if (!fs.existsSync(p)) missing.push(r.sha256);
    else if (sha256File(p) !== r.sha256) corrupt.push(r.sha256);
  }
  return { total: rows.length, missing, corrupt };
}

/** 从备份对象补齐运行对象目录(缺失或摘要不符的对象),返回补齐数量。 */
export function fillRuntimeObjects(manifest: BackupManifest, backupRoot: string, objectsRoot: string): number {
  let filled = 0;
  for (const o of manifest.objects) {
    const dest = runtimeObjectPath(objectsRoot, o.sha256);
    if (fs.existsSync(dest) && sha256File(dest) === o.sha256) continue;
    if (fs.existsSync(dest)) fs.unlinkSync(dest);
    placeObject(backupObjectPath(backupRoot, o.sha256), dest, o.size, false);
    fs.chmodSync(dest, 0o440);
    filled += 1;
  }
  return filled;
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
  objectsRestored: number;
}> {
  if (!confirmed) throw Errors.validation('恢复操作需要二次确认(confirmed=true)');
  const bundle = verifyBackupBundle(backupFile);
  // 无清单的旧格式备份(如早期或迁入前的库):只有在库层校验通过且不登记任何文件对象时才可恢复,
  // 否则无法保证附件可用,拒绝
  const legacyOk = !bundle.ok && !readManifest(backupFile) && verifyDbFile(backupFile).ok && objectRowsOf(backupFile).length === 0;
  if (!bundle.ok && !legacyOk) throw Errors.validation(`备份文件校验失败: ${bundle.message}`);
  const dir = backupDirOf(dbPath);
  fs.mkdirSync(dir, { recursive: true });
  // 先复制恢复目标到不参与 .sqlite 保留清理的临时文件，避免目标恰为最旧日备时被删除。
  const stagedSource = path.join(dir, `.restore-source-${process.pid}-${Date.now()}.tmp`);
  fs.copyFileSync(backupFile, stagedSource);
  const stagedCheck = verifyDbFile(stagedSource);
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
  let objectsRestored = 0;
  try {
    const preRestore = await createBackup(db, dir, 'pre-restore');
    // 先补齐运行对象目录(对象不可变、按内容寻址,补齐不影响当前库),再替换数据库
    if (bundle.manifest) objectsRestored = fillRuntimeObjects(bundle.manifest, backupRootOf(backupFile), path.join(path.dirname(dbPath), 'objects'));
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
      objectsRestored,
    });
    return {
      ok: true,
      message: migrated.length > 0 ? `恢复完成，已自动应用 ${migrated.length} 项迁移` : '恢复完成',
      originalVersion,
      appliedMigrations: migrationSummary,
      finalVersion,
      objectsRestored,
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
