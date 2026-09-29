import Database from 'better-sqlite3';
import path from 'path';
import fs from 'fs';

export type DB = Database.Database;

/** 方案十一.3:SQLite 配置 */
export function openDatabase(dbPath: string): DB {
  fs.mkdirSync(path.dirname(dbPath), { recursive: true });
  const db = new Database(dbPath);
  db.pragma('foreign_keys = ON');
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  return db;
}

/**
 * 仅用于备份/取证校验的专用连接。不创建目录、不切换 journal_mode，
 * 从连接层保证校验前后文件字节不变。
 */
export function openReadonlyDatabase(dbPath: string): DB {
  const db = new Database(dbPath, { readonly: true, fileMustExist: true });
  db.pragma('query_only = ON');
  db.pragma('busy_timeout = 5000');
  return db;
}

/** 完整性检查,损坏时抛错 */
export function integrityCheck(db: DB): boolean {
  const row = db.prepare('PRAGMA integrity_check').get() as { integrity_check: string };
  return row.integrity_check === 'ok';
}
