/**
 * 本地文件对象层(architecture「文件」、data-contracts「文件证据」)。
 *
 * - 原件按 sha256 内容寻址、不可变:<root>/sha256/<前 2 位>/<sha256>。相同内容复用同一对象。
 * - 写入顺序:临时文件 → fsync → 原子改名 → 短事务登记 file_object。文件系统与 SQLite 不是一个事务,
 *   登记失败留下的无引用文件由 sweepOrphanObjects 按“库中无记录且超过宽限期”回收。
 * - 这里不提供按 ID 下载:业务 service 先按业务对象鉴权,再调用 readObject。
 */
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { DB } from '../../db/connection';
import { AppError } from '../../core/errors';
import { currentAuth } from '../../core/request-context';

export interface FileObjectRow {
  id: number;
  sha256: string;
  size_bytes: number;
  content_type: string;
  original_name: string;
  created_by_user_id: number | null;
  created_at: string;
}

export class ObjectStore {
  constructor(public readonly root: string) {}

  /** 内存库(测试)使用进程私有临时目录,绝不指向运行数据目录。 */
  static forDbPath(dbPath: string): ObjectStore {
    if (dbPath === ':memory:') return new ObjectStore(fs.mkdtempSync(path.join(os.tmpdir(), 'newfc-objects-')));
    return new ObjectStore(path.join(path.dirname(dbPath), 'objects'));
  }

  objectPath(sha256: string): string {
    if (!/^[0-9a-f]{64}$/.test(sha256)) throw new AppError('VALIDATION_FAILED', '文件摘要不合法', 400);
    return path.join(this.root, 'sha256', sha256.slice(0, 2), sha256);
  }

  /** 写入不可变对象(已存在且大小一致则复用)。返回摘要与大小。 */
  put(content: Buffer): { sha256: string; size: number } {
    const sha256 = crypto.createHash('sha256').update(content).digest('hex');
    const target = this.objectPath(sha256);
    if (fs.existsSync(target) && fs.statSync(target).size === content.length) return { sha256, size: content.length };
    fs.mkdirSync(path.dirname(target), { recursive: true });
    const tmp = `${target}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
    const fd = fs.openSync(tmp, 'wx', 0o440);
    try {
      fs.writeSync(fd, content);
      fs.fsyncSync(fd);
    } finally {
      fs.closeSync(fd);
    }
    fs.renameSync(tmp, target);
    return { sha256, size: content.length };
  }

  read(sha256: string): Buffer {
    const file = this.objectPath(sha256);
    if (!fs.existsSync(file)) throw new AppError('FILE_OBJECT_MISSING', '原件文件缺失,请从备份恢复文件对象目录', 500);
    const content = fs.readFileSync(file);
    const actual = crypto.createHash('sha256').update(content).digest('hex');
    if (actual !== sha256) throw new AppError('FILE_OBJECT_CORRUPT', '原件文件摘要与登记不一致', 500);
    return content;
  }
}

/** 登记对象(短事务,幂等):同一 sha256 只登记一次,首次名称与创建人保留。 */
export function registerFileObject(db: DB, input: { sha256: string; size: number; contentType: string; originalName: string }): FileObjectRow {
  const name = input.originalName.slice(0, 255) || 'file';
  db.prepare(`INSERT INTO file_object (sha256, size_bytes, content_type, original_name, created_by_user_id, created_at)
    VALUES (?, ?, ?, ?, ?, ?) ON CONFLICT(sha256) DO NOTHING`)
    .run(input.sha256, input.size, input.contentType.slice(0, 120), name, currentAuth()?.userId ?? null, new Date().toISOString());
  return db.prepare('SELECT * FROM file_object WHERE sha256 = ?').get(input.sha256) as FileObjectRow;
}

/** 写入并登记:文件落盘在事务外,登记是一条短语句。 */
export function storeFile(db: DB, store: ObjectStore, content: Buffer, meta: { originalName: string; contentType?: string }): FileObjectRow {
  const { sha256, size } = store.put(content);
  return registerFileObject(db, { sha256, size, contentType: meta.contentType ?? 'application/octet-stream', originalName: meta.originalName });
}

export function getFileObject(db: DB, id: number): FileObjectRow | undefined {
  return db.prepare('SELECT * FROM file_object WHERE id = ?').get(id) as FileObjectRow | undefined;
}

/**
 * 回收无登记的孤儿对象(登记失败或进程在改名后崩溃)。只删除超过宽限期的文件,
 * 避免与正在进行的“落盘 → 登记”竞争;临时文件同样按宽限期清理。
 */
export function sweepOrphanObjects(db: DB, store: ObjectStore, graceMs = 24 * 3600 * 1000, now = Date.now()): { removed: number } {
  const base = path.join(store.root, 'sha256');
  if (!fs.existsSync(base)) return { removed: 0 };
  const known = db.prepare('SELECT 1 FROM file_object WHERE sha256 = ?');
  let removed = 0;
  for (const prefix of fs.readdirSync(base)) {
    const dir = path.join(base, prefix);
    if (!fs.statSync(dir).isDirectory()) continue;
    for (const name of fs.readdirSync(dir)) {
      const file = path.join(dir, name);
      const stat = fs.statSync(file);
      if (now - stat.mtimeMs < graceMs) continue;
      const sha = name.slice(0, 64);
      if (name.endsWith('.tmp') || !known.get(sha)) {
        fs.rmSync(file, { force: true });
        removed += 1;
      }
    }
  }
  return { removed };
}
