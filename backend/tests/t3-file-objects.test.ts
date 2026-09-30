import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { afterEach, describe, expect, it } from 'vitest';
import { ObjectStore, registerFileObject, storeFile, sweepOrphanObjects } from '../src/modules/files/object-store';
import { closeAllTestDbs, tempFileDb } from './helpers';

/** T-3 公共基础:文件对象按内容寻址、不可变、相同内容复用;登记失败的孤儿对象按宽限期回收。 */
afterEach(() => closeAllTestDbs());

const sha = (b: Buffer) => crypto.createHash('sha256').update(b).digest('hex');
const DAY = 24 * 3600 * 1000;

describe('T-3 文件对象层', () => {
  it('存放在 <数据目录>/objects/sha256/<前2位>/<sha256>;相同内容只登记一次并保留首次名称', () => {
    const { db, dbPath } = tempFileDb();
    const store = ObjectStore.forDbPath(dbPath);
    expect(store.root).toBe(path.join(path.dirname(dbPath), 'objects'));
    const content = Buffer.from('公司,期间\n澧水公司,2026-05\n');
    const a = storeFile(db, store, content, { originalName: 'a.csv', contentType: 'text/csv' });
    const b = storeFile(db, store, content, { originalName: 'b.csv' });
    expect(b.id).toBe(a.id);
    expect(b.original_name).toBe('a.csv');
    expect(a.sha256).toBe(sha(content));
    const file = path.join(store.root, 'sha256', a.sha256.slice(0, 2), a.sha256);
    expect(fs.readFileSync(file)).toEqual(content);
    expect(fs.statSync(file).mode & 0o222).toBe(0);
    expect(store.read(a.sha256)).toEqual(content);
    expect(fs.readdirSync(path.dirname(file)).filter((n) => n.endsWith('.tmp'))).toEqual([]);
    expect((db.prepare('SELECT COUNT(*) AS c FROM file_object').get() as { c: number }).c).toBe(1);
  });

  it('非法摘要拒绝;文件缺失或被篡改时读取报错而不是返回错误内容', () => {
    const { db, dbPath } = tempFileDb();
    const store = ObjectStore.forDbPath(dbPath);
    expect(() => store.objectPath('../etc/passwd')).toThrow(/摘要不合法/);
    const row = storeFile(db, store, Buffer.from('original'), { originalName: 'x.txt' });
    const file = store.objectPath(row.sha256);
    fs.chmodSync(file, 0o640);
    fs.writeFileSync(file, 'tampered');
    expect(() => store.read(row.sha256)).toThrow(/摘要与登记不一致/);
    fs.rmSync(file);
    expect(() => store.read(row.sha256)).toThrow(/原件文件缺失/);
  });

  it('孤儿对象与残留临时文件超过宽限期才回收;已登记对象和宽限期内的文件保留', () => {
    const { db, dbPath } = tempFileDb();
    const store = ObjectStore.forDbPath(dbPath);
    const kept = storeFile(db, store, Buffer.from('registered'), { originalName: 'r.txt' });
    const orphan = store.put(Buffer.from('orphan-after-failed-register'));
    const fresh = store.put(Buffer.from('in-flight'));
    const tmp = `${store.objectPath(kept.sha256)}.123.abc.tmp`;
    fs.writeFileSync(tmp, 'partial');
    const old = new Date(Date.now() - 2 * DAY);
    for (const f of [store.objectPath(kept.sha256), store.objectPath(orphan.sha256), tmp]) fs.utimesSync(f, old, old);

    expect(sweepOrphanObjects(db, store)).toEqual({ removed: 2 });
    expect(fs.existsSync(store.objectPath(kept.sha256))).toBe(true);
    expect(fs.existsSync(store.objectPath(orphan.sha256))).toBe(false);
    expect(fs.existsSync(tmp)).toBe(false);
    expect(fs.existsSync(store.objectPath(fresh.sha256))).toBe(true);

    // 宽限期内的孤儿对象随后被登记(“落盘 → 登记”正常完成),不会被误删
    registerFileObject(db, { sha256: fresh.sha256, size: fresh.size, contentType: 'text/plain', originalName: 'f.txt' });
    expect(sweepOrphanObjects(db, store, DAY, Date.now() + 2 * DAY)).toEqual({ removed: 0 });
  });
});
