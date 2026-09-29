/**
 * T-3 EAS 原始事实与期间控制(AC-F05):导入 → 预检 → 激活 → 锁定 → 锁后更正 → 复核切换。
 *
 * 固定样本(上海公司 2026-01,元):
 *   凭证 记-001:1002 银行存款 借 1,000.00 / 6001 主营业务收入 贷 1,000.00
 *        记-002:6602 管理费用 借 250.50 / 1002 银行存款 贷 250.50
 *   余额 1002 期初借 5,000.00 → 期末借 5,749.50;6001 期末贷 1,000.00;6602 期末借 250.50;2001 应付账款 期初/期末贷 3,000.00
 *   辅助 2001 供应商 S001 甲公司 期初/期末 -3,000.00
 * 更正:6602 管理费用改为 260.50(凭证、余额同步),批准后当前集合与锁基线切到候选集合,旧批次 superseded。
 */
import { describe, it, expect, afterEach } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Server } from 'http';
import { createApp } from '../src/server';
import type { DB } from '../src/db/connection';
import { buildFixture, org, type Fixture } from './helpers';
import { createScopedUser, ensureAdmin, fetchAs, sessionFor } from './http-helpers';

type Session = ReturnType<typeof sessionFor>;
const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

async function boot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'newfc-t3-eas-'));
  const dbPath = path.join(dir, 'newfc.sqlite');
  const { app, holder } = await createApp({ dbPath });
  const server: Server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  cleanups.push(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    try { holder.getDb().close(); } catch { /* closed */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const db = holder.getDb();
  const admin = sessionFor(db, ensureAdmin(db));
  const fx = buildFixture(db);
  return { base, db, dir, admin, fx };
}

const csv = (rows: (string | number)[][]) => Buffer.from(`﻿${rows.map((r) => r.join(',')).join('\n')}\n`, 'utf8');

const VOUCHER_HEAD = ['公司', '期间', '凭证日期', '凭证号', '分录号', '科目编码', '科目名称', '借方金额', '贷方金额', '摘要'];
const BALANCE_HEAD = ['公司', '期间', '科目编码', '科目名称', '期初借方', '期初贷方', '本期借方', '本期贷方', '期末借方', '期末贷方'];
const AUX_HEAD = ['公司', '期间', '辅助类型', '辅助编码', '辅助名称', '科目编码', '科目名称', '期初余额', '借方金额', '贷方金额', '期末余额'];

function voucher(opts: { company?: string; period?: string; fee?: string } = {}) {
  const c = opts.company ?? '上海公司'; const p = opts.period ?? '2026-01'; const fee = opts.fee ?? '250.50';
  return csv([VOUCHER_HEAD,
    [c, p, `${p}-05`, '记-001', '1', '1002', '银行存款', '1000.00', '0', '收款'],
    [c, p, `${p}-05`, '记-001', '2', '6001', '主营业务收入', '0', '1000.00', '收款'],
    [c, p, `${p}-20`, '记-002', '1', '6602', '管理费用', fee, '0', '办公费'],
    [c, p, `${p}-20`, '记-002', '2', '1002', '银行存款', '0', fee, '办公费'],
  ]);
}

function balance(opts: { period?: string; fee?: string; bankBegin?: string } = {}) {
  const p = opts.period ?? '2026-01';
  const feeC = BigInt(Math.round(Number(opts.fee ?? '250.50') * 100));
  const beginC = BigInt(Math.round(Number(opts.bankBegin ?? '5000.00') * 100));
  const y = (c: bigint) => `${c / 100n}.${String(c % 100n).padStart(2, '0')}`;
  // 损益类未月结:2 月期初承接 1 月期末(收入贷 1,000.00、管理费用借 250.50)
  const carry = p === '2026-02' ? { income: 100000n, fee: 25050n } : { income: 0n, fee: 0n };
  return csv([BALANCE_HEAD,
    ['上海公司', p, '1002', '银行存款', y(beginC), '0', '1000.00', y(feeC), y(beginC + 100000n - feeC), '0'],
    ['上海公司', p, '6001', '主营业务收入', '0', y(carry.income), '0', '1000.00', '0', y(carry.income + 100000n)],
    ['上海公司', p, '6602', '管理费用', y(carry.fee), '0', y(feeC), '0', y(carry.fee + feeC), '0'],
    ['上海公司', p, '2001', '应付账款', '0', '3000.00', '0', '0', '0', '3000.00'],
  ]);
}

function aux(opts: { period?: string; end?: string } = {}) {
  const p = opts.period ?? '2026-01';
  const end = opts.end ?? '-3000.00';
  const debit = end === '-3000.00' ? '0' : (Number(end) + 3000).toFixed(2);
  return csv([AUX_HEAD, ['上海公司', p, '供应商', 'S001', '甲公司', '2001', '应付账款', '-3000.00', debit, '0', end]]);
}

async function importFile(base: string, s: Session, dataType: string, content: Buffer, name: string, extra: Record<string, string> = {}) {
  const form = new FormData();
  form.append('dataType', dataType);
  for (const [k, v] of Object.entries(extra)) form.append(k, v);
  form.append('file', new Blob([new Uint8Array(content)]), name);
  return fetchAs(s, `${base}/api/eas/import`, { method: 'POST', body: form });
}

const post = (base: string, s: Session, url: string, body: unknown = {}) =>
  fetchAs(s, `${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const get = (base: string, s: Session, url: string) => fetchAs(s, `${base}${url}`);

async function importAll(base: string, s: Session, opts: { period?: string; fee?: string; bankBegin?: string } = {}) {
  const ids: Record<string, number> = {};
  for (const [type, content] of [['voucher', voucher(opts)], ['balance', balance(opts)], ['auxiliary', aux(opts)]] as const) {
    const res = await importFile(base, s, type, content, `${type}-${opts.period ?? '2026-01'}.csv`);
    expect(res.status, await res.clone().text()).toBe(201);
    ids[type] = (await res.json() as any).id;
  }
  return ids;
}

async function activateAndLock(base: string, s: Session, fx: Fixture, period = '2026-01') {
  const set = await (await post(base, s, '/api/eas/precheck', { orgId: fx.orgIds.shanghai, period })).json() as any;
  expect(set.status).toBe('passed');
  const act = await post(base, s, `/api/eas/sets/${set.id}/activate`, { expectedVersion: set.version, expectedCurrentSetId: null });
  expect(act.status, await act.clone().text()).toBe(200);
  const lock = await post(base, s, '/api/eas/locks', { orgId: fx.orgIds.shanghai, period, setId: set.id, reason: '1 月结账' });
  expect(lock.status, await lock.clone().text()).toBe(201);
  return { set, lock: await lock.json() as any };
}

describe('T-3 EAS 导入与原件', () => {
  it('三类文件导入为候选批次,金额十进制字符串;同文件重放返回同一批次;原件下载字节一致', async () => {
    const { base, db, dir, admin, fx } = await boot();
    const content = voucher();
    const res = await importFile(base, admin, 'voucher', content, '凭证-2026-01.csv');
    expect(res.status).toBe(201);
    const batch = await res.json() as any;
    expect(batch).toMatchObject({ dataType: 'voucher', orgId: fx.orgIds.shanghai, period: '2026-01', rowCount: 4, debitTotal: '1250.50', creditTotal: '1250.50', status: 'candidate', fileName: '凭证-2026-01.csv' });
    expect(batch.fileSha256).toBe(crypto.createHash('sha256').update(content).digest('hex'));

    const replay = await importFile(base, admin, 'voucher', content, '凭证-2026-01.csv');
    expect(replay.status).toBe(200);
    expect(await replay.json() as any).toMatchObject({ id: batch.id, replayed: true });
    expect((db.prepare('SELECT COUNT(*) AS c FROM eas_voucher_line').get() as { c: number }).c).toBe(4);

    const lines = await (await get(base, admin, `/api/eas/batches/${batch.id}/lines?pageSize=2`)).json() as any;
    expect(lines.total).toBe(4);
    expect(lines.lines[0]).toMatchObject({ voucherNo: '记-001', accountCode: '1002', debit: '1000.00', credit: '0.00' });

    const original = await get(base, admin, `/api/eas/batches/${batch.id}/original`);
    expect(original.status).toBe(200);
    expect(Buffer.from(await original.arrayBuffer()).equals(content)).toBe(true);
    expect(original.headers.get('content-disposition')).toContain("filename*=UTF-8''");
    // 原件落在数据库同目录的内容寻址对象区,只读
    const objectFile = path.join(dir, 'objects', 'sha256', batch.fileSha256.slice(0, 2), batch.fileSha256);
    expect(fs.existsSync(objectFile)).toBe(true);
    const logs = db.prepare("SELECT action FROM operation_log WHERE action IN ('eas.import','eas.download')").all() as { action: string }[];
    expect(logs.map((l) => l.action).sort()).toEqual(['eas.download', 'eas.import']);
  });

  it('原始行不可修改或删除(触发器)', async () => {
    const { base, db, admin } = await boot();
    await importFile(base, admin, 'voucher', voucher(), 'v.csv');
    expect(() => db.prepare('UPDATE eas_voucher_line SET debit_cents = 1').run()).toThrow(/不可修改/);
    expect(() => db.prepare('DELETE FROM eas_voucher_line').run()).toThrow(/不可删除/);
  });

  it('校验失败全量报错且不落库:借贷不平衡、多期间、空金额', async () => {
    const { base, db, admin } = await boot();
    const bad = csv([VOUCHER_HEAD,
      ['上海公司', '2026-01', '2026-01-05', '记-001', '1', '1002', '银行存款', '1000.00', '0', ''],
      ['上海公司', '2026-01', '2026-01-05', '记-001', '2', '6001', '主营业务收入', '0', '999.00', ''],
      ['上海公司', '2026-01', '2026-01-06', '记-003', '1', '6602', '管理费用', '', '0', ''],
    ]);
    const res = await importFile(base, admin, 'voucher', bad, 'bad.csv');
    expect(res.status).toBe(400);
    const body = await res.json() as any;
    expect(body.code).toBe('IMPORT_VALIDATION_FAILED');
    expect(body.errors.some((e: { message: string }) => e.message.includes('零请填写 0'))).toBe(true);

    const multi = csv([VOUCHER_HEAD,
      ['上海公司', '2026-01', '2026-01-05', '记-001', '1', '1002', '银行存款', '1', '0', ''],
      ['上海公司', '2026-01', '2026-01-05', '记-001', '2', '6001', '收入', '0', '1', ''],
      ['上海公司', '2026-02', '2026-02-05', '记-002', '1', '1002', '银行存款', '1', '0', ''],
      ['上海公司', '2026-02', '2026-02-05', '记-002', '2', '6001', '收入', '0', '1', ''],
    ]);
    const res2 = await importFile(base, admin, 'voucher', multi, 'multi.csv');
    expect((await res2.json() as any).code).toBe('EAS_FILE_SCOPE_INVALID');
    expect((db.prepare('SELECT COUNT(*) AS c FROM eas_batch').get() as { c: number }).c).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS c FROM file_object').get() as { c: number }).c).toBe(0);
  });

  it('公司只按精确编码/名称或 EAS 映射解析;去后缀的模糊匹配拒绝并给出候选', async () => {
    const { base, admin, fx } = await boot();
    const res = await importFile(base, admin, 'voucher', voucher({ company: '上海' }), 'v.csv');
    expect(res.status).toBe(422);
    const body = await res.json() as any;
    expect(body.code).toBe('EAS_COMPANY_UNRESOLVED');
    expect(body.details.candidates).toEqual([{ code: 'SH', name: '上海公司' }]);

    // 按组织编码导入、以及页面所选组织不一致
    expect((await importFile(base, admin, 'voucher', voucher({ company: 'SH' }), 'v.csv')).status).toBe(201);
    const mismatch = await importFile(base, admin, 'voucher', voucher({ company: 'SH', fee: '1.00' }), 'v2.csv', { orgId: String(fx.orgIds.hangzhou) });
    expect((await mismatch.json() as any).code).toBe('EAS_ORG_MISMATCH');
  });

  it('超过 2^53 分的金额按 64 位定点保存和返回', async () => {
    const { base, admin } = await boot();
    const big = '99999999999999.99';
    const content = csv([VOUCHER_HEAD,
      ['上海公司', '2026-03', '2026-03-01', '记-009', '1', '1002', '银行存款', big, '0', ''],
      ['上海公司', '2026-03', '2026-03-01', '记-009', '2', '6001', '收入', '0', big, ''],
    ]);
    const batch = await (await importFile(base, admin, 'voucher', content, 'big.csv')).json() as any;
    expect(batch.debitTotal).toBe(big);
    const lines = await (await get(base, admin, `/api/eas/batches/${batch.id}/lines`)).json() as any;
    expect(lines.lines[0].debit).toBe(big);
  });
});

describe('T-3 EAS 预检、激活与锁定', () => {
  it('三类齐全且对账一致 → passed(上期缺失、未配置辅助要求为 warning);激活后批次生效;锁定后禁止直接导入', async () => {
    const { base, db, admin, fx } = await boot();
    const ids = await importAll(base, admin);

    const { set } = await activateAndLock(base, admin, fx);
    const rules = Object.fromEntries(set.results.map((r: { ruleCode: string; status: string }) => [r.ruleCode, r.status]));
    expect(rules).toEqual({ required_files: 'passed', voucher_balance_movement: 'passed', period_continuity: 'warning', auxiliary_requirements: 'warning' });
    expect(set.warningCount).toBe(2);
    const statuses = db.prepare('SELECT id, status, is_current FROM eas_batch ORDER BY id').all() as { id: number; status: string; is_current: number }[];
    expect(statuses.map((b) => [b.id, b.status, b.is_current])).toEqual(Object.values(ids).map((id) => [id, 'active', 1]));

    const blocked = await importFile(base, admin, 'voucher', voucher({ fee: '260.50' }), 'v2.csv');
    expect(blocked.status).toBe(409);
    expect((await blocked.json() as any).code).toBe('EAS_PERIOD_LOCKED');

    const status = await (await get(base, admin, `/api/eas/period-status?orgId=${fx.orgIds.shanghai}&period=2026-01`)).json() as any;
    expect(status.currentSet.id).toBe(set.id);
    expect(status.lock).toMatchObject({ status: 'locked', setId: set.id });
  });

  it('缺文件为 incomplete;凭证与余额发生额不一致为 failed 且不能激活', async () => {
    const { base, admin, fx } = await boot();
    await importFile(base, admin, 'voucher', voucher(), 'v.csv');
    const incomplete = await (await post(base, admin, '/api/eas/precheck', { orgId: fx.orgIds.shanghai, period: '2026-01' })).json() as any;
    expect(incomplete.status).toBe('incomplete');
    expect(incomplete.results[0].details.missingDataTypes).toEqual(['balance', 'auxiliary']);

    await importFile(base, admin, 'balance', balance({ fee: '260.50' }), 'b.csv');
    await importFile(base, admin, 'auxiliary', aux(), 'a.csv');
    const failed = await (await post(base, admin, '/api/eas/precheck', { orgId: fx.orgIds.shanghai, period: '2026-01' })).json() as any;
    expect(failed.status).toBe('failed');
    const movement = failed.results.find((r: { ruleCode: string }) => r.ruleCode === 'voucher_balance_movement');
    expect(movement).toMatchObject({ status: 'failed', diffCount: 2, diffAmount: '20.00' });
    expect(movement.details.accounts.map((a: { accountCode: string }) => a.accountCode)).toEqual(['1002', '6602']);

    const act = await post(base, admin, `/api/eas/sets/${failed.id}/activate`, { expectedVersion: failed.version, expectedCurrentSetId: null });
    expect(act.status).toBe(409);
    expect((await act.json() as any).code).toBe('EAS_RECON_NOT_PASSED');
  });

  it('跨期连续性:下期期初与上期生效期末不一致为 failed;辅助核算要求不符为 failed', async () => {
    const { base, admin, fx } = await boot();
    await importAll(base, admin);
    await activateAndLock(base, admin, fx);

    await post(base, admin, '/api/eas/aux-requirements', { orgId: fx.orgIds.shanghai, accountCode: '2001', auxType: '供应商' });
    await importAll(base, admin, { period: '2026-02', bankBegin: '5700.00' });
    const feb = await (await post(base, admin, '/api/eas/precheck', { orgId: fx.orgIds.shanghai, period: '2026-02' })).json() as any;
    const byRule = Object.fromEntries(feb.results.map((r: { ruleCode: string }) => [r.ruleCode, r]));
    expect(byRule.period_continuity).toMatchObject({ status: 'failed', diffCount: 1, diffAmount: '49.50' });
    expect(byRule.period_continuity.details.accounts[0]).toMatchObject({ accountCode: '1002', previousEnding: '5749.50', currentOpening: '5700.00' });
    expect(byRule.auxiliary_requirements.status).toBe('passed');

    // 只重导余额(期初修正)与不符的辅助核算:其余类型沿用最新候选
    await importFile(base, admin, 'balance', balance({ period: '2026-02', bankBegin: '5749.50' }), 'b2.csv');
    await importFile(base, admin, 'auxiliary', aux({ period: '2026-02', end: '-2900.00' }), 'a2.csv');
    const feb2 = await (await post(base, admin, '/api/eas/precheck', { orgId: fx.orgIds.shanghai, period: '2026-02' })).json() as any;
    const byRule2 = Object.fromEntries(feb2.results.map((r: { ruleCode: string }) => [r.ruleCode, r]));
    expect(byRule2.period_continuity.status).toBe('passed');
    expect(byRule2.auxiliary_requirements.status).toBe('failed');
    expect(feb2.status).toBe('failed');
  });

  it('解锁只限管理员且须原因;有待处理更正时不能解锁', async () => {
    const { base, db, admin, fx } = await boot();
    await importAll(base, admin);
    const { lock } = await activateAndLock(base, admin, fx);
    const reviewer = createScopedUser(db, { username: 'eas-rev', roleCodes: ['business_reviewer'], allOrgs: true });
    const denied = await post(base, reviewer.session, `/api/eas/locks/${lock.id}/unlock`, { expectedVersion: lock.version, reason: '重开' });
    expect(denied.status).toBe(403);
    const noReason = await post(base, admin, `/api/eas/locks/${lock.id}/unlock`, { expectedVersion: lock.version, reason: '' });
    expect((await noReason.json() as any).code).toBe('VALIDATION_FAILED');

    const ok = await post(base, admin, `/api/eas/locks/${lock.id}/unlock`, { expectedVersion: lock.version, reason: '补录调整' });
    expect(ok.status).toBe(200);
    expect((await ok.json() as any).status).toBe('unlocked');
    const events = await (await get(base, admin, `/api/eas/locks/${lock.id}/events`)).json() as any;
    expect(events.map((e: { action: string }) => e.action)).toEqual(['lock', 'unlock']);
  });
});

describe('T-3 EAS 锁后更正与复核', () => {
  it('维护人员申请 → 导入候选 → 预检 → 复核人员批准:当前集合与锁基线切换,旧批次 superseded,事件与审计可追溯', async () => {
    const { base, db, admin, fx } = await boot();
    const oldIds = await importAll(base, admin);
    const { set: oldSet, lock } = await activateAndLock(base, admin, fx);
    const maint = createScopedUser(db, { username: 'eas-maint', roleCodes: ['data_maintainer'], orgIds: [fx.orgIds.shanghai] });
    const reviewer = createScopedUser(db, { username: 'eas-rev', roleCodes: ['business_reviewer'], allOrgs: true });

    const stale = await post(base, maint.session, '/api/eas/corrections', { orgId: fx.orgIds.shanghai, period: '2026-01', expectedCurrentSetId: oldSet.id + 99, reason: '费用错记' });
    expect((await stale.json() as any).code).toBe('EAS_CURRENT_SET_CHANGED');
    const cRes = await post(base, maint.session, '/api/eas/corrections', { orgId: fx.orgIds.shanghai, period: '2026-01', expectedCurrentSetId: oldSet.id, reason: '管理费用少记 10 元' });
    expect(cRes.status).toBe(201);
    const correction = await cRes.json() as any;
    const dup = await post(base, admin, '/api/eas/corrections', { orgId: fx.orgIds.shanghai, period: '2026-01', expectedCurrentSetId: oldSet.id, reason: '重复' });
    expect((await dup.json() as any).code).toBe('EAS_CORRECTION_PENDING');

    // 他人不能向该申请导入;申请人导入凭证+余额(辅助核算沿用当前生效批次)
    const other = await importFile(base, admin, 'voucher', voucher({ fee: '260.50' }), 'v-fix.csv', { correctionId: String(correction.id) });
    expect(other.status).toBe(403);
    for (const [type, content] of [['voucher', voucher({ fee: '260.50' })], ['balance', balance({ fee: '260.50' })]] as const) {
      const r = await importFile(base, maint.session, type, content, `${type}-fix.csv`, { correctionId: String(correction.id) });
      expect(r.status, await r.clone().text()).toBe(201);
    }
    const pre = await post(base, maint.session, `/api/eas/corrections/${correction.id}/precheck`);
    expect(pre.status, await pre.clone().text()).toBe(201);
    const candidate = await pre.json() as any;
    expect(candidate).toMatchObject({ status: 'passed', correctionId: correction.id, isCurrent: false });
    expect(candidate.batches.find((b: { dataType: string }) => b.dataType === 'auxiliary').batchId).toBe(oldIds.auxiliary);

    // 更正候选集合不能走普通激活;申请人不能复核(无权限),复核人批准
    const direct = await post(base, admin, `/api/eas/sets/${candidate.id}/activate`, { expectedVersion: candidate.version, expectedCurrentSetId: oldSet.id });
    expect((await direct.json() as any).code).toBe('EAS_CORRECTION_REVIEW_REQUIRED');
    const pending = await (await get(base, reviewer.session, `/api/eas/corrections/${correction.id}`)).json() as any;
    expect(pending.status).toBe('pending_review');
    expect((await post(base, maint.session, `/api/eas/corrections/${correction.id}/review`, { action: 'approve', expectedVersion: pending.version })).status).toBe(403);
    const approved = await post(base, reviewer.session, `/api/eas/corrections/${correction.id}/review`, { action: 'approve', expectedVersion: pending.version, comment: '核对凭证无误' });
    expect(approved.status, await approved.clone().text()).toBe(200);
    expect((await approved.json() as any).status).toBe('approved');

    const status = await (await get(base, admin, `/api/eas/period-status?orgId=${fx.orgIds.shanghai}&period=2026-01`)).json() as any;
    expect(status.currentSet.id).toBe(candidate.id);
    expect(status.lock).toMatchObject({ status: 'locked', setId: candidate.id, version: lock.version + 1 });
    expect(status.pendingCorrection).toBeNull();
    const old = db.prepare('SELECT id, status FROM eas_batch WHERE id IN (?, ?, ?) ORDER BY id').all(oldIds.voucher, oldIds.balance, oldIds.auxiliary) as { id: number; status: string }[];
    expect(old.map((b) => b.status)).toEqual(['superseded', 'superseded', 'active']);
    const events = await (await get(base, admin, `/api/eas/locks/${lock.id}/events`)).json() as any;
    expect(events.map((e: { action: string; setId: number }) => [e.action, e.setId])).toEqual([['lock', oldSet.id], ['correction_switch', candidate.id]]);
    const audit = db.prepare("SELECT action FROM operation_log WHERE action LIKE 'eas.correction%' ORDER BY id").all() as { action: string }[];
    expect(audit.map((a) => a.action)).toEqual(['eas.correction_submit', 'eas.correction_review']);
  });

  it('管理员同人复核必须写例外原因;退回后可重新申请', async () => {
    const { base, admin, fx } = await boot();
    await importAll(base, admin);
    const { set } = await activateAndLock(base, admin, fx);
    const c = await (await post(base, admin, '/api/eas/corrections', { orgId: fx.orgIds.shanghai, period: '2026-01', expectedCurrentSetId: set.id, reason: '单人部署更正' })).json() as any;
    await importFile(base, admin, 'voucher', voucher({ fee: '260.50' }), 'v.csv', { correctionId: String(c.id) });
    await importFile(base, admin, 'balance', balance({ fee: '260.50' }), 'b.csv', { correctionId: String(c.id) });
    await post(base, admin, `/api/eas/corrections/${c.id}/precheck`);
    const pending = await (await get(base, admin, `/api/eas/corrections/${c.id}`)).json() as any;

    const noReason = await post(base, admin, `/api/eas/corrections/${c.id}/review`, { action: 'return', expectedVersion: pending.version });
    expect(noReason.status).toBe(400);
    const returned = await post(base, admin, `/api/eas/corrections/${c.id}/review`, { action: 'return', expectedVersion: pending.version, comment: '缺附件', exceptionReason: '单人部署' });
    expect((await returned.json() as any).status).toBe('returned');
    const again = await post(base, admin, '/api/eas/corrections', { orgId: fx.orgIds.shanghai, period: '2026-01', expectedCurrentSetId: set.id, reason: '补附件后重提' });
    expect(again.status).toBe(201);
  });
});

describe('T-3 EAS 组织范围', () => {
  it('受限账号:范围外公司文件 403,范围外批次/集合/期间状态 404,列表不含范围外数据', async () => {
    const { base, db, admin, fx } = await boot();
    const ids = await importAll(base, admin);
    const hz = createScopedUser(db, { username: 'eas-hz', roleCodes: ['data_maintainer'], orgIds: [fx.orgIds.hangzhou] });

    const res = await importFile(base, hz.session, 'voucher', voucher({ fee: '1.00' }), 'v.csv');
    expect(res.status).toBe(403);
    expect((await res.json() as any).code).toBe('SCOPE_RESTRICTED');
    expect((await get(base, hz.session, `/api/eas/batches/${ids.voucher}`)).status).toBe(404);
    expect((await get(base, hz.session, `/api/eas/batches/${ids.voucher}/original`)).status).toBe(404);
    expect(await (await get(base, hz.session, '/api/eas/batches')).json() as any).toEqual([]);
    expect((await post(base, hz.session, '/api/eas/precheck', { orgId: fx.orgIds.shanghai, period: '2026-01' })).status).toBeGreaterThanOrEqual(403);
    expect((await get(base, hz.session, `/api/eas/period-status?orgId=${fx.orgIds.shanghai}&period=2026-01`)).status).toBeGreaterThanOrEqual(403);

    const viewer = createScopedUser(db, { username: 'eas-viewer', roleCodes: ['viewer'], allOrgs: true });
    expect((await get(base, viewer.session, '/api/eas/batches')).status).toBe(200);
    expect((await importFile(base, viewer.session, 'voucher', voucher(), 'v.csv')).status).toBe(403);
  });
});

describe('T-3 EAS lishui v600 样本三件套', () => {
  const dir = path.join(__dirname, 'fixtures', 'eas-v600');
  const sample = (name: string) => fs.readFileSync(path.join(dir, name));

  it('逐行金额、空项目编码保持为空;首期连续性 warning;配置 220201×项目 辅助要求后按带符号 −900,000.00 通过', async () => {
    const { base, db, admin } = await boot();
    const ls = org.createOrg(db, { parentId: null, code: 'LS', name: '澧水公司' }).id;
    const ids: Record<string, number> = {};
    for (const [type, file, rows] of [['voucher', 'eas_voucher.csv', 6], ['balance', 'eas_balance.csv', 4], ['auxiliary', 'eas_auxiliary.csv', 4]] as const) {
      const res = await importFile(base, admin, type, sample(file), file);
      expect(res.status, await res.clone().text()).toBe(201);
      const batch = await res.json() as any;
      expect(batch).toMatchObject({ orgId: ls, period: '2026-05', rowCount: rows });
      ids[type] = batch.id;
    }
    const lines = (await (await get(base, admin, `/api/eas/batches/${ids.voucher}/lines`)).json() as any).lines;
    expect(lines.find((l: any) => l.voucherNo === '记-0001' && l.entryNo === '1')).toMatchObject({ debit: '2100000.00', credit: '0.00', projectCode: 'LS-2026-001' });
    expect(lines.find((l: any) => l.voucherNo === '记-0001' && l.entryNo === '2')).toMatchObject({ projectCode: null, supplierName: null });
    expect(lines.find((l: any) => l.voucherNo === '记-0003' && l.entryNo === '2')).toMatchObject({ debit: '0.00', credit: '900000.00' });

    const first = await (await post(base, admin, '/api/eas/precheck', { orgId: ls, period: '2026-05' })).json() as any;
    const rules = Object.fromEntries(first.results.map((r: any) => [r.ruleCode, r.status]));
    expect(rules).toEqual({ required_files: 'passed', voucher_balance_movement: 'passed', period_continuity: 'warning', auxiliary_requirements: 'warning' });

    await post(base, admin, '/api/eas/aux-requirements', { orgId: ls, accountCode: '220201', auxType: '项目' });
    const second = await (await post(base, admin, '/api/eas/precheck', { orgId: ls, period: '2026-05' })).json() as any;
    const aux = second.results.find((r: any) => r.ruleCode === 'auxiliary_requirements');
    expect(aux).toMatchObject({ status: 'passed', diffCount: 0, diffAmount: '0.00' });
    expect(second.status).toBe('passed');

    // 同一请求重复提交只有一个批次
    const replay = await importFile(base, admin, 'voucher', sample('eas_voucher.csv'), 'eas_voucher.csv');
    expect((await replay.json() as any)).toMatchObject({ id: ids.voucher, replayed: true });
    expect((db.prepare('SELECT COUNT(*) AS c FROM eas_batch').get() as { c: number }).c).toBe(3);
    expect((db.prepare('SELECT COUNT(*) AS c FROM eas_voucher_line').get() as { c: number }).c).toBe(6);
  });

  it('两个集合并发激活:后到者因当前集合已变化被拒绝', async () => {
    const { base, db, admin } = await boot();
    const ls = org.createOrg(db, { parentId: null, code: 'LS', name: '澧水公司' }).id;
    for (const [type, file] of [['voucher', 'eas_voucher.csv'], ['balance', 'eas_balance.csv'], ['auxiliary', 'eas_auxiliary.csv']] as const) {
      await importFile(base, admin, type, sample(file), file);
    }
    const a = await (await post(base, admin, '/api/eas/precheck', { orgId: ls, period: '2026-05' })).json() as any;
    const b = await (await post(base, admin, '/api/eas/precheck', { orgId: ls, period: '2026-05' })).json() as any;
    const [ra, rb] = await Promise.all([
      post(base, admin, `/api/eas/sets/${a.id}/activate`, { expectedVersion: a.version, expectedCurrentSetId: null }),
      post(base, admin, `/api/eas/sets/${b.id}/activate`, { expectedVersion: b.version, expectedCurrentSetId: null }),
    ]);
    expect([ra.status, rb.status].sort()).toEqual([200, 409]);
    const loser = ra.status === 409 ? ra : rb;
    expect((await loser.json() as any).code).toBe('EAS_CURRENT_SET_CHANGED');
    expect((db.prepare('SELECT COUNT(*) AS c FROM eas_recon_set WHERE is_current = 1').get() as { c: number }).c).toBe(1);
  });
});
