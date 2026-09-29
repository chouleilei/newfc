import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { createApp } from '../src/server';
import { createSourceProfile } from '../src/modules/finance-import/source-profile.service';
import { createMappingVersion } from '../src/modules/finance-import/mapping/mapping.service';
import { buildFixture } from './helpers';
import type { DB } from '../src/db/connection';

/**
 * HTTP JSON 边界:TypeScript 类型在请求边界被擦除,错误类型曾穿过 service 的
 * `.trim()` / `for...of` 变成 500。这些用例把「客户端错误 = 400 且无写入」钉死。
 */

let server: Server | undefined;
let db: DB | undefined;

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  db?.close();
  db = undefined;
});

async function boot(): Promise<{ base: string; db: DB }> {
  const { app, holder } = await createApp({ dbPath: ':memory:', auth: { username: '', password: '' } });
  db = holder.getDb();
  server = app.listen(0);
  await new Promise<void>((resolve) => server!.once('listening', () => resolve()));
  const port = (server!.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}/api`, db };
}

function write(base: string, method: 'POST' | 'PUT', path: string, body: unknown) {
  return fetch(`${base}${path}`, {
    method,
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

describe('HTTP 请求体边界校验', () => {
  it('创建预算版本收到非字符串名称/备注时返回 400 而不是 500,且不产生写入', async () => {
    const { base, db } = await boot();
    buildFixture(db);
    const before = (db.prepare('SELECT COUNT(*) c FROM budget_version').get() as { c: number }).c;
    const badName = await write(base, 'POST', '/versions', { year: 2026, name: 123 });
    expect(badName.status).toBe(400);
    expect(((await badName.json()) as { code: string }).code).toBe('VALIDATION_FAILED');
    const badNote = await write(base, 'POST', '/versions', { year: 2026, name: '合法名称', note: 42 });
    expect(badNote.status).toBe(400);
    const after = (db.prepare('SELECT COUNT(*) c FROM budget_version').get() as { c: number }).c;
    expect(after).toBe(before);
  });

  it('映射整表替换拒绝非数组请求体,合法空数组仍可用', async () => {
    const { base, db } = await boot();
    buildFixture(db);
    const profile = createSourceProfile(db, {
      code: 'FIXED', name: '固定财务系统',
      config: {
        balanceSheetNames: ['科目余额表'], profitSheetNames: ['利润表'],
        auxiliaryColumns: { project: ['项目'] },
        ownedOrgCodes: ['EAST'], ownedAccountCodes: ['I', 'C', 'E'], amountUnit: 'yuan',
      },
    });
    const mapping = createMappingVersion(db, { sourceProfileId: profile.id, name: 'V1' });

    for (const body of [{}, { items: {} }, { items: null }, { items: 'x' }]) {
      const res = await write(base, 'PUT', `/finance/mapping-versions/${mapping.id}/org-mappings`, body);
      expect(res.status).toBe(400);
      expect(((await res.json()) as { code: string }).code).toBe('VALIDATION_FAILED');
    }
    const acc = await write(base, 'PUT', `/finance/mapping-versions/${mapping.id}/account-mappings`, { items: {} });
    expect(acc.status).toBe(400);
    const rec = await write(base, 'PUT', `/finance/mapping-versions/${mapping.id}/reconciliation-rules`, { items: null });
    expect(rec.status).toBe(400);

    const ok = await write(base, 'PUT', `/finance/mapping-versions/${mapping.id}/org-mappings`, { items: [] });
    expect(ok.status).toBe(200);
    expect(((await ok.json()) as { items: unknown[] }).items).toEqual([]);
    // 直接数组形态保持向后兼容
    const legacyArray = await write(base, 'PUT', `/finance/mapping-versions/${mapping.id}/reconciliation-rules`, []);
    expect(legacyArray.status).toBe(200);
  });
});
