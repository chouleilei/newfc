import { afterEach, describe, expect, it } from 'vitest';
import type { Server } from 'http';
import type { AddressInfo } from 'net';
import { AppError } from '../src/core/errors';
import { createApp } from '../src/server';
import { testDb, buildFixture, actual } from './helpers';
import type { DB } from '../src/db/connection';

/**
 * UX-11 实际保存持久回执(actual_save_receipt):
 * 客户端生成请求编号,服务端同事务去重。响应丢失后同编号同内容重试只读回执;
 * 同编号不同内容拒绝;事务失败不残留回执;缺省 requestId 的旧调用行为不变。
 */

const REQ_1 = '11111111-1111-4111-8111-111111111111';
const REQ_2 = '22222222-2222-4222-8222-222222222222';
const REQ_3 = '33333333-3333-4333-8333-333333333333';

function receiptCount(db: DB): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM actual_save_receipt').get() as { c: number }).c;
}

function batchCount(db: DB, year: number): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM actual_snapshot_batch WHERE year = ?').get(year) as { c: number }).c;
}

function currentCount(db: DB, year: number): number {
  return (db.prepare('SELECT COUNT(*) AS c FROM actual_current WHERE year = ?').get(year) as { c: number }).c;
}

describe('实际保存持久回执(UX-11,服务层)', () => {
  it('响应丢失后同 requestId 同内容重试:只产生一个快照批次,返回原回执结果', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const input = {
      year: 2026,
      snapshotDate: '2026-03-31',
      entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '100.00' }],
      source: 'manual' as const,
      mode: 'replace' as const,
      expectedCurrentBatchId: null,
      requestId: REQ_1,
    };
    const first = actual.saveActual(db, input);
    expect(first.replayed).toBe(false);
    expect(batchCount(db, 2026)).toBe(1);
    expect(receiptCount(db)).toBe(1);

    // 模拟提交成功但响应丢失:客户端用同一请求编号、同一内容重试
    const retry = actual.saveActual(db, input);
    expect(retry.replayed).toBe(true);
    expect(retry.batchId).toBe(first.batchId);
    expect(retry.saved).toBe(first.saved);
    expect(batchCount(db, 2026)).toBe(1);
    expect(receiptCount(db)).toBe(1);

    // 重试即使带着已过期的基线(内容不变)也命中回执,不再复核基线
    const replay = actual.getSaveReceipt(db, REQ_1);
    expect(replay).toMatchObject({ requestId: REQ_1, year: 2026, batchId: first.batchId });
    expect(replay!.result).toMatchObject({ batchId: first.batchId, saved: first.saved });
  });

  it('同 requestId 不同内容返回 409 冲突,且不产生新写入', () => {
    const db = testDb();
    const fx = buildFixture(db);
    actual.saveActual(db, {
      year: 2026, snapshotDate: '2026-03-31',
      entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '100.00' }],
      source: 'manual', mode: 'replace', expectedCurrentBatchId: null, requestId: REQ_1,
    });
    const batchesBefore = batchCount(db, 2026);
    let caught: unknown;
    try {
      actual.saveActual(db, {
        year: 2026, snapshotDate: '2026-03-31',
        entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '200.00' }],
        source: 'manual', mode: 'replace', expectedCurrentBatchId: null, requestId: REQ_1,
      });
    } catch (error) {
      caught = error;
    }
    expect(caught).toBeInstanceOf(AppError);
    expect((caught as AppError).status).toBe(409);
    expect((caught as AppError).message).toMatch(/内容不同/);
    expect(batchCount(db, 2026)).toBe(batchesBefore);
    expect(receiptCount(db)).toBe(1);
  });

  it('事务失败不残留回执:基线冲突/校验失败均不落 actual_save_receipt', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const first = actual.saveActual(db, {
      year: 2026, snapshotDate: '2026-03-31',
      entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '100.00' }],
      source: 'manual', mode: 'replace', expectedCurrentBatchId: null, requestId: REQ_1,
    });
    // 新请求编号 + 过期基线:复核基线被拒,事务回滚,不能留下 REQ_2 的成功回执
    expect(() => actual.saveActual(db, {
      year: 2026, snapshotDate: '2026-03-31',
      entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '100.00' }],
      source: 'manual', mode: 'replace', expectedCurrentBatchId: null, requestId: REQ_2,
    })).toThrow(/已被其他操作更新/);
    expect(actual.getSaveReceipt(db, REQ_2)).toBeUndefined();
    expect(receiptCount(db)).toBe(1);
    expect(batchCount(db, 2026)).toBe(1);

    // 校验失败(非叶子组织)同样不留回执
    expect(() => actual.saveActual(db, {
      year: 2026, snapshotDate: '2026-04-30',
      entries: [{ orgId: fx.orgIds.east, accountId: fx.accIds.incomeMain, amount: '1.00' }],
      source: 'manual', mode: 'replace', expectedCurrentBatchId: first.batchId, requestId: REQ_3,
    })).toThrow(/不是当前树的叶子组织/);
    expect(actual.getSaveReceipt(db, REQ_3)).toBeUndefined();
    expect(receiptCount(db)).toBe(1);
  });

  it('携带 requestId 时正常基线变化仍被拒绝(回执只保障同一次提交)', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const first = actual.saveActual(db, {
      year: 2026, snapshotDate: '2026-03-31',
      entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '100.00' }],
      source: 'manual', mode: 'replace', expectedCurrentBatchId: null, requestId: REQ_1,
    });
    // 另一客户端推进基线
    actual.saveActual(db, {
      year: 2026, snapshotDate: '2026-04-30',
      entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '150.00' }],
      source: 'manual', mode: 'replace', expectedCurrentBatchId: first.batchId,
    });
    // 新请求编号 + 旧基线:仍按现有并发保护拒绝
    expect(() => actual.saveActual(db, {
      year: 2026, snapshotDate: '2026-05-31',
      entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '300.00' }],
      source: 'manual', mode: 'replace', expectedCurrentBatchId: first.batchId, requestId: REQ_2,
    })).toThrow(/已被其他操作更新/);
    expect(actual.getSaveReceipt(db, REQ_2)).toBeUndefined();
  });

  it('历史补录同样去重:同编号重试不重复生成历史快照,且不更新当前累计', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const historyInput = {
      year: 2026, snapshotDate: '2026-01-31',
      entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '80.00' }],
      source: 'manual' as const, mode: 'replace' as const, history: true, requestId: REQ_1,
    };
    const first = actual.saveActual(db, historyInput);
    expect(first.replayed).toBe(false);
    expect(currentCount(db, 2026)).toBe(0);
    expect(actual.getYearState(db, 2026)!.current_batch_id).toBeNull();

    const retry = actual.saveActual(db, historyInput);
    expect(retry.replayed).toBe(true);
    expect(retry.batchId).toBe(first.batchId);
    expect(batchCount(db, 2026)).toBe(1);
    expect(currentCount(db, 2026)).toBe(0);
    expect(actual.getYearState(db, 2026)!.current_batch_id).toBeNull();
  });

  it('缺省 requestId 的旧调用兼容:不去重、不写回执', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const first = actual.saveActual(db, {
      year: 2026, snapshotDate: '2026-03-31',
      entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '100.00' }],
      source: 'manual', mode: 'replace', expectedCurrentBatchId: null,
    });
    expect(first.replayed).toBe(false);
    const second = actual.saveActual(db, {
      year: 2026, snapshotDate: '2026-03-31',
      entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '100.00' }],
      source: 'manual', mode: 'replace', expectedCurrentBatchId: first.batchId,
    });
    expect(second.batchId).not.toBe(first.batchId);
    expect(batchCount(db, 2026)).toBe(2);
    expect(receiptCount(db)).toBe(0);
  });

  it('requestId 格式校验:非法编号在写入前被 400 拒绝', () => {
    const db = testDb();
    const fx = buildFixture(db);
    const base = {
      year: 2026, snapshotDate: '2026-03-31',
      entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '1.00' }],
      source: 'manual' as const, mode: 'replace' as const, expectedCurrentBatchId: null,
    };
    for (const bad of ['short', 'has space in id', '中文编号不行啊', 'x'.repeat(65)]) {
      expect(() => actual.saveActual(db, { ...base, requestId: bad })).toThrow(/requestId/);
    }
    expect(receiptCount(db)).toBe(0);
    expect(batchCount(db, 2026)).toBe(0);
  });
});

/* ---- HTTP 契约:路由注册顺序、状态码与回执查询 ---- */

let server: Server | undefined;
let httpDb: DB | undefined;

afterEach(async () => {
  if (server) await new Promise<void>((resolve) => server!.close(() => resolve()));
  server = undefined;
  httpDb?.close();
  httpDb = undefined;
});

async function boot(): Promise<{ base: string; db: DB }> {
  const { app, holder } = await createApp({ dbPath: ':memory:', auth: { username: '', password: '' } });
  httpDb = holder.getDb();
  server = app.listen(0);
  await new Promise<void>((resolve) => server!.once('listening', () => resolve()));
  const port = (server!.address() as AddressInfo).port;
  return { base: `http://127.0.0.1:${port}/api`, db: httpDb };
}

describe('实际保存回执 HTTP 契约(UX-11)', () => {
  it('POST 携带 requestId 成功后 GET 回执可查;同编号同内容重试返回原结果且不新增快照', async () => {
    const { base, db } = await boot();
    const fx = buildFixture(db);
    const payload = {
      year: 2026, snapshotDate: '2026-03-31',
      entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '100.00' }],
      expectedCurrentBatchId: null, requestId: REQ_1,
    };
    const post = (body: unknown) => fetch(`${base}/actual/save`, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const first = await post(payload);
    expect(first.status).toBe(200);
    const firstBody = (await first.json()) as { batchId: number; replayed: boolean };
    expect(firstBody.replayed).toBe(false);

    const retry = await post(payload);
    expect(retry.status).toBe(200);
    const retryBody = (await retry.json()) as { batchId: number; replayed: boolean };
    expect(retryBody.replayed).toBe(true);
    expect(retryBody.batchId).toBe(firstBody.batchId);
    expect(batchCount(db, 2026)).toBe(1);

    const receipt = await fetch(`${base}/actual/save-requests/${REQ_1}`);
    expect(receipt.status).toBe(200);
    const receiptBody = (await receipt.json()) as { committed: boolean; requestId: string; batchId: number; result: { batchId: number } };
    expect(receiptBody).toMatchObject({ committed: true, requestId: REQ_1, batchId: firstBody.batchId });
    expect(receiptBody.result.batchId).toBe(firstBody.batchId);

    // 同编号不同内容 → 409
    const conflict = await post({ ...payload, entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '999.00' }] });
    expect(conflict.status).toBe(409);
  });

  it('未知请求编号返回清晰 404;非法编号 400;既有 :id 路由不受影响', async () => {
    const { base, db } = await boot();
    buildFixture(db);
    const missing = await fetch(`${base}/actual/save-requests/${REQ_2}`);
    expect(missing.status).toBe(404);
    expect(((await missing.json()) as { message: string }).message).toMatch(/相同请求编号/);

    const invalid = await fetch(`${base}/actual/save-requests/not%20valid`);
    expect(invalid.status).toBe(400);

    // 注册顺序不影响既有批次路由
    const notFoundBatch = await fetch(`${base}/actual/batches/99999`);
    expect(notFoundBatch.status).toBe(404);
  });

  it('requestId 非字符串被 400 拒绝', async () => {
    const { base, db } = await boot();
    const fx = buildFixture(db);
    const res = await fetch(`${base}/actual/save`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        year: 2026, snapshotDate: '2026-03-31',
        entries: [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '1.00' }],
        expectedCurrentBatchId: null, requestId: 123,
      }),
    });
    expect(res.status).toBe(400);
    expect(receiptCount(db)).toBe(0);
  });
});
