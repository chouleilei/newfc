import fs from 'fs';
import os from 'os';
import path from 'path';
import { afterAll, describe, expect, it } from 'vitest';
import { backupDirOf, backupObjectPath, gcBackupObjects, manifestPathOf, readManifest, runtimeObjectPath, sha256File, verifyBackupBundle } from '../src/modules/backup/backup.service';
import { ObjectStore, storeFile } from '../src/modules/files/object-store';
import { runRestoreDrill } from '../src/modules/backup/restore-drill';
import { boot, get, json, post, upload } from './t3-helpers';

/**
 * T-6 一致性备份包(AC-X07):备份 = 库 + 清单(库摘要/对象列表)+ 引用对象;
 * 校验能发现运行对象缺失并指出可从备份补齐;页面恢复先补齐对象再替换库;
 * 独立目录恢复演练在空目录还原,行数/金额/对象摘要一致,临时实例就绪。
 */

const tmpDirs: string[] = [];
const tmp = (prefix: string) => { const d = fs.mkdtempSync(path.join(os.tmpdir(), prefix)); tmpDirs.push(d); return d; };
afterAll(() => { for (const d of tmpDirs) fs.rmSync(d, { recursive: true, force: true }); });

async function ok(res: Response | Promise<Response>, status = 200) {
  const r = await res;
  const body = await r.json();
  expect(r.status, JSON.stringify(body)).toBe(status);
  return body;
}

describe('T-6 一致性备份包与恢复演练', () => {
  it('备份含对象;校验发现缺失对象;恢复补齐;演练在空目录还原并就绪', async () => {
    const { base, db, dir, admin, fx } = await boot('newfc-t6-backup-');
    const dbPath = path.join(dir, 'newfc.sqlite');
    const store = ObjectStore.forDbPath(dbPath);

    // 附件:报销附件两份 + 一份报告产物
    const claim = await ok(post(base, admin, '/api/expense/claims', {
      orgId: fx.orgIds.shanghai, applicant: '李四', department: '财务部', expenseType: '办公费', amount: '100.00', occurredDate: '2026-05-10', description: '办公用品',
      lines: [{ expenseType: '办公费', amount: '100.00', invoiceNo: 'INV-B1', invoiceDate: '2026-05-10', description: '纸张' }],
    }), 201);
    await ok(upload(base, admin, `/api/expense/claims/${claim.id}/attachments`, Buffer.from('票据扫描-1'), '票据1.jpg'), 201);
    await ok(upload(base, admin, `/api/expense/claims/${claim.id}/attachments`, Buffer.from('票据扫描-2'), '票据2.pdf'), 201);
    const artifact = storeFile(db, store, Buffer.from('报告产物 PDF'), { originalName: '分析报告.pdf', contentType: 'application/pdf' });
    const shas = (db.prepare('SELECT sha256 FROM file_object ORDER BY id').all() as { sha256: string }[]).map((r) => r.sha256);
    expect(shas.length).toBeGreaterThanOrEqual(3);

    // 备份:清单记录库摘要与全部引用对象,对象复制到备份根目录
    const created = await ok(post(base, admin, '/api/backup/create', {}));
    const backupDir = backupDirOf(dbPath);
    const name = path.basename(created.file);
    const backupFile = path.join(backupDir, name);
    const manifest = readManifest(backupFile)!;
    expect(manifest).toMatchObject({ format: 'newfc-backup/1', dbSha256: sha256File(backupFile), missingObjects: [] });
    expect(new Set(manifest.objects.map((o) => o.sha256))).toEqual(new Set(shas));
    for (const sha of shas) expect(sha256File(backupObjectPath(backupDir, sha))).toBe(sha);
    expect(verifyBackupBundle(backupFile)).toMatchObject({ ok: true });
    // 自包含单文件:只读校验不在旁边留下 -wal/-shm
    expect(fs.readdirSync(backupDir).filter((f) => /-(wal|shm)$/.test(f))).toEqual([]);

    // 删除一个运行对象:校验指出缺失且可从备份补齐
    const lost = runtimeObjectPath(store.root, artifact.sha256);
    fs.rmSync(lost);
    const v = await ok(get(base, admin, `/api/backup/verify?file=${encodeURIComponent(name)}`));
    expect(v).toMatchObject({ ok: true, runtime: { total: shas.length, missing: 1, corrupt: 0, recoverableFromBackup: 1 } });
    expect(v.checks.map((c: { name: string }) => c.name)).toEqual(['database', 'manifest', 'db_sha256', 'object_list', 'objects']);

    // 独立目录恢复演练:目标非空/位于运行目录/指向 newbd 均拒绝
    const busy = tmp('newfc-drill-busy-');
    fs.writeFileSync(path.join(busy, 'x'), '1');
    await expect(runRestoreDrill({ backup: backupFile, target: busy })).rejects.toThrow('目标目录必须为空');
    await expect(runRestoreDrill({ backup: backupFile, target: path.join(dir, 'drill') })).rejects.toThrow('运行数据目录');
    await expect(runRestoreDrill({ backup: backupFile, target: path.join(tmp('newfc-drill-'), 'newbd', 'x') })).rejects.toThrow('newbd');

    const target = path.join(tmp('newfc-drill-'), 'restore');
    const report = await runRestoreDrill({ backup: backupFile, target, source: dbPath });
    expect(report, JSON.stringify(report.failures)).toMatchObject({ ok: true, mismatches: [], failures: [], objects: { count: shas.length }, instance: { ready: true } });
    expect(report.schema.restored).toBe(report.schema.backup);
    expect(report.rows).toBeGreaterThan(0);
    expect(report.timingsMs.total).toBeGreaterThanOrEqual(report.timingsMs.instance);
    expect(Object.values(report.instance.checks).every((c) => c.startsWith('ok'))).toBe(true);
    for (const sha of shas) expect(sha256File(runtimeObjectPath(path.join(target, 'objects'), sha))).toBe(sha);
    expect(JSON.parse(fs.readFileSync(path.join(target, 'restore-drill-report.json'), 'utf8')).ok).toBe(true);
    // 与原库(只读)比较:备份后的写入(如备份审计日志)只作为差异报告,不影响演练结论
    expect(report.sourceComparison).toMatchObject({ source: dbPath });
    expect(report.sourceComparison!.differences.every((d) => !d.includes('_cents'))).toBe(true);

    // 页面恢复:先补齐运行对象再替换库
    const restored = await ok(post(base, admin, '/api/backup/restore', { file: name, confirmed: true }));
    expect(restored).toMatchObject({ ok: true, objectsRestored: 1 });
    expect(sha256File(lost)).toBe(artifact.sha256);
    const v2 = await ok(get(base, admin, `/api/backup/verify?file=${encodeURIComponent(name)}`));
    expect(v2.runtime).toMatchObject({ missing: 0, corrupt: 0 });

    // 备份对象损坏:校验失败,演练拒绝
    const bad = backupObjectPath(backupDir, shas[0]);
    fs.chmodSync(bad, 0o644);
    fs.writeFileSync(bad, 'tampered');
    const v3 = await ok(get(base, admin, `/api/backup/verify?file=${encodeURIComponent(name)}`));
    expect(v3.ok).toBe(false);
    expect(v3.checks.find((c: { name: string }) => c.name === 'objects')).toMatchObject({ ok: false });
    await expect(runRestoreDrill({ backup: backupFile, target: path.join(tmp('newfc-drill-'), 'r2') })).rejects.toThrow('备份包校验失败');

    // 清单缺失:不再视为一致备份
    fs.rmSync(manifestPathOf(backupFile));
    expect(verifyBackupBundle(backupFile).ok).toBe(false);

    // 对象回收:不被任何清单引用的备份对象被删除
    const orphan = backupObjectPath(backupDir, 'f'.repeat(64));
    fs.mkdirSync(path.dirname(orphan), { recursive: true });
    fs.writeFileSync(orphan, 'orphan');
    expect(gcBackupObjects(backupDir)).toBeGreaterThanOrEqual(1);
    expect(fs.existsSync(orphan)).toBe(false);
  });
});
