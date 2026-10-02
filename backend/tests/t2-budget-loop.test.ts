import { pageSnapshot } from './assistant-context';
/**
 * T-2 首个纵向闭环:预算导入 → 页面汇总 → 同源 AI 查询(AC-F08 / AC-F03 / AC-F20 / AC-X03 / AC-X05 / AC-X06)。
 *
 * 固定样本(2026 年,上海/杭州两家组织,收入/成本/费用/数量四类,元为单位):
 *   上海 I01 收入 1,234,567.89   C0101 成本 600,000.01   E01 管理费用 0.00(显式零)   Q01 销量 12.5
 *   杭州 I01 收入   500,000.00   E02 销售费用 99,999.99                                   Q01 销量 3
 *   南京:文件中缺失(与“零”区分)
 * 期望(分,利润方向带符号:收入正、成本费用负):
 *   上海收入 123456789;集团收入 173456789;集团成本 -60000001;集团费用 -9999999;
 *   销量(万分之一)上海 125000,集团 155000,不进入任何金额合计。
 */
import { describe, it, expect, afterEach, vi } from 'vitest';
import crypto from 'crypto';
import fs from 'fs';
import os from 'os';
import path from 'path';
import ExcelJS from 'exceljs';
import type { Server } from 'http';
import { createApp } from '../src/server';
import type { DB } from '../src/db/connection';
import { buildFixture, account, budget, testDb, type Fixture } from './helpers';
import { createScopedUser, ensureAdmin, fetchAs, sessionFor } from './http-helpers';
import { runWithContext } from '../src/core/request-context';
import { loadAuthContext } from '../src/modules/security/security.service';
import { executeTool } from '../src/assistant/tools';
import * as assistant from '../src/assistant/service';
import * as io from '../src/modules/io/excel';
import * as importBatch from '../src/modules/import/import.service';
import { buildStandardBudgetPreview } from '../src/modules/import/preview-detail';
import { EnvChatModel, classifyModelError, setChannelResolver, setModelCallRecorder } from '../src/assistant/model';
import { assertSafeXlsx } from '../src/modules/io/xlsx-guard';

type TestSession = ReturnType<typeof sessionFor>;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => {
  while (cleanups.length) await cleanups.pop()!();
});

async function boot() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'newfc-t2-'));
  const { app, holder } = await createApp({ dbPath: path.join(dir, 'newfc.sqlite') });
  const server: Server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  cleanups.push(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    try { holder.getDb().close(); } catch { /* closed */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { base, db: holder.getDb() };
}

const HEADER = ['组织编码', '科目编码', '金额(元)', '数量', '备注'];
const SAMPLE: unknown[][] = [
  ['SH', 'I01', '1234567.89', '', '主营收入'],
  ['SH', 'C0101', '600000.01', '', ''],
  ['SH', 'E01', '0.00', '', '显式零'],
  ['SH', 'Q01', '', '12.5', ''],
  ['HZ', 'I01', '500000.00', '', ''],
  ['HZ', 'E02', '99999.99', '', ''],
  ['HZ', 'Q01', '', '3', ''],
];

async function workbook(rows: unknown[][]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('预算导入');
  ws.addRow(HEADER);
  for (const row of rows) ws.addRow(row);
  return Buffer.from(await wb.xlsx.writeBuffer());
}

function setup(db: DB) {
  ensureAdmin(db);
  const fx = buildFixture(db);
  const qty = account.createAccount(db, { parentId: null, code: 'Q01', name: '销量', type: 'quantity', unit: '台' }).id;
  const version = budget.createVersion(db, { year: 2026, name: 'T2 样本' });
  return { fx, qty, version };
}

function upload(session: TestSession, base: string, versionId: number, file: Buffer, confirm = false) {
  const form = new FormData();
  form.append('versionId', String(versionId));
  if (confirm) form.append('confirm', 'true');
  form.append('file', new Blob([new Uint8Array(file)]), 't2-budget.xlsx');
  return fetchAs(session, `${base}/api/io/budget/import`, { method: 'POST', body: form });
}

function postJson(session: TestSession, url: string, body: unknown = {}) {
  return fetchAs(session, url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
}

function cells(db: DB, versionId: number): Record<string, { amount: number; quantity: number | null }> {
  const rows = db.prepare(`SELECT o.code AS org, a.code AS acc, e.amount_cents AS amount, e.quantity AS quantity
    FROM budget_entry e JOIN org o ON o.id = e.org_id JOIN account a ON a.id = e.account_id WHERE e.version_id = ?`).all(versionId) as { org: string; acc: string; amount: number; quantity: number | null }[];
  return Object.fromEntries(rows.map((r) => [`${r.org}:${r.acc}`, { amount: r.amount, quantity: r.quantity }]));
}

function accountCell(report: any, code: string) {
  return report.analysisAccounts.find((row: any) => row.code === code)?.cell;
}

function as<T>(db: DB, userId: number, fn: () => T): T {
  const auth = loadAuthContext(db, userId);
  if (!auth) throw new Error('user disabled');
  return runWithContext({ requestId: 't2', source: 'http', auth }, fn);
}

describe('T-2 预算导入 → 汇总 → 同源问答', () => {
  it('合法模板:预览与提交逐格一致,可定位批次与原件;汇总无重复累计;数量不混入金额;缺失与零区分', async () => {
    const { base, db } = await boot();
    const { fx, version } = setup(db);
    const maintainer = createScopedUser(db, { username: 't2-maint', roleCodes: ['data_maintainer'], allOrgs: true });
    const admin = sessionFor(db, ensureAdmin(db));
    const file = await workbook(SAMPLE);

    const preview = await upload(maintainer.session, base, version.id, file);
    expect(preview.status).toBe(200);
    const pv = await preview.json() as any;
    expect(pv).toMatchObject({ preview: true, count: 7, sha256: crypto.createHash('sha256').update(file).digest('hex') });
    expect(Object.keys(cells(db, version.id))).toHaveLength(0); // 预览不落库

    const detail = await (await fetchAs(maintainer.session, `${base}/api/io/import-batches/${pv.importBatchId}/preview-rows?pageSize=100`)).json() as any;
    const previewCells = Object.fromEntries(detail.items.map((r: any) => [`${r.orgCode}:${r.accountCode}`, { cents: r.newCents, quantity: r.newQuantity ?? null }]));

    const confirm = await postJson(maintainer.session, `${base}/api/io/import-batches/${pv.importBatchId}/confirm`);
    expect(confirm.status).toBe(200);
    const stored = cells(db, version.id);
    // 预览 = 提交:每个预览格的新值与落库值逐分相等
    for (const [key, cell] of Object.entries(previewCells) as [string, { cents: number | null; quantity: number | null }][]) {
      if (cell.cents != null) expect(stored[key]?.amount, key).toBe(cell.cents);
    }
    expect(stored['SH:I01'].amount).toBe(123456789);
    expect(stored['SH:C0101'].amount).toBe(-60000001);
    expect(stored['HZ:E02'].amount).toBe(-9999999);
    expect(stored['SH:Q01']).toMatchObject({ amount: 0, quantity: 125000 });
    expect(stored['HZ:Q01']).toMatchObject({ amount: 0, quantity: 30000 });
    // 缺失与零:上海管理费用是显式零(有格),南京整行缺失(无格)
    expect(stored['SH:E01']?.amount).toBe(0);
    expect(Object.keys(stored).some((k) => k.startsWith('NJ:'))).toBe(false);

    // 批次与原件可定位:审计批次记录目标版本、哈希,原件可按批次取回且逐字节一致
    const batch = await (await fetchAs(maintainer.session, `${base}/api/io/import-batches/${pv.importBatchId}`)).json() as any;
    expect(JSON.stringify(batch)).toContain(pv.sha256);
    const source = await fetchAs(maintainer.session, `${base}/api/io/import-batches/${pv.importBatchId}/source`);
    expect(Buffer.from(await source.arrayBuffer()).equals(file)).toBe(true);

    // 汇总口径:集团 = 上海 + 杭州,无重复累计;数量不进入金额合计
    const group = await (await fetchAs(admin, `${base}/api/report/completion?versionId=${version.id}`)).json() as any;
    expect(accountCell(group, 'I').budgetCents).toBe(173456789);
    expect(accountCell(group, 'C').budgetCents).toBe(-60000001);
    expect(accountCell(group, 'E').budgetCents).toBe(-9999999);
    expect(accountCell(group, 'Q01')).toMatchObject({ budgetCents: 0, budgetQuantity: 155000 });
    const byOrg = Object.fromEntries(group.byOrg.map((row: any) => [row.code, row]));
    expect(byOrg.EAST.cell.budgetCents).toBe(byOrg.SH.cell.budgetCents + byOrg.HZ.cell.budgetCents);
    expect(byOrg.GROUP?.cell.budgetCents ?? byOrg.EAST.cell.budgetCents).toBe(byOrg.EAST.cell.budgetCents);
    expect(group.reconciliation.differenceCents).toBe(0);
    void fx;
  });

  it('写入冲突:重复确认 409 不重复计入;预览后版本变化 409 且批次作废;回滚恢复;中途失败整批回滚', async () => {
    const { base, db } = await boot();
    const { fx, version } = setup(db);
    const maintainer = createScopedUser(db, { username: 't2-conflict', roleCodes: ['data_maintainer'], allOrgs: true });
    const file = await workbook(SAMPLE);

    const first = await (await upload(maintainer.session, base, version.id, file)).json() as any;
    expect((await postJson(maintainer.session, `${base}/api/io/import-batches/${first.importBatchId}/confirm`)).status).toBe(200);
    const afterFirst = cells(db, version.id);
    const again = await postJson(maintainer.session, `${base}/api/io/import-batches/${first.importBatchId}/confirm`);
    expect(again.status).toBe(409);
    expect(cells(db, version.id)).toEqual(afterFirst);

    // 旧预览:预览后版本被其他人改动 → 确认 409,批次作废,事实不变
    const changed = await workbook([['SH', 'I01', '1.00', '', '']]);
    const stale = await (await upload(maintainer.session, base, version.id, changed)).json() as any;
    budget.saveEntries(db, version.id, [
      ...Object.entries(afterFirst).filter(([, c]) => c.quantity == null).map(([key, c]) => {
        const [org, acc] = key.split(':');
        const orgId = (db.prepare('SELECT id FROM org WHERE code=?').get(org) as { id: number }).id;
        const accountId = (db.prepare('SELECT id FROM account WHERE code=?').get(acc) as { id: number }).id;
        return { orgId, accountId, amount: key === 'HZ:I01' ? '500001.00' : (Math.abs(c.amount) / 100).toFixed(2) };
      }),
      { orgId: fx.orgIds.shanghai, accountId: (db.prepare("SELECT id FROM account WHERE code='Q01'").get() as { id: number }).id, quantity: '12.5' },
      { orgId: fx.orgIds.hangzhou, accountId: (db.prepare("SELECT id FROM account WHERE code='Q01'").get() as { id: number }).id, quantity: '3' },
    ] as any);
    const beforeStale = cells(db, version.id);
    const staleConfirm = await postJson(maintainer.session, `${base}/api/io/import-batches/${stale.importBatchId}/confirm`);
    expect(staleConfirm.status).toBe(409);
    expect(cells(db, version.id)).toEqual(beforeStale);
    expect(importBatch.getBatch(db, stale.importBatchId).status).toBe('cancelled');

    // 中途失败:在写入杭州行时注入数据库错误,整批回滚,不留上海的半批
    const partial = await workbook([['SH', 'I01', '7.77', '', ''], ['HZ', 'I01', '8.88', '', '']]);
    const pending = await (await upload(maintainer.session, base, version.id, partial)).json() as any;
    db.exec(`CREATE TEMP TRIGGER t2_fail_insert BEFORE INSERT ON budget_entry WHEN NEW.org_id = ${fx.orgIds.hangzhou} BEGIN SELECT RAISE(ABORT, 'injected failure'); END;
             CREATE TEMP TRIGGER t2_fail_update BEFORE UPDATE ON budget_entry WHEN NEW.org_id = ${fx.orgIds.hangzhou} BEGIN SELECT RAISE(ABORT, 'injected failure'); END;`);
    const failed = await postJson(maintainer.session, `${base}/api/io/import-batches/${pending.importBatchId}/confirm`);
    db.exec('DROP TRIGGER t2_fail_insert; DROP TRIGGER t2_fail_update;');
    expect(failed.status).toBeGreaterThanOrEqual(500);
    expect(cells(db, version.id)).toEqual(beforeStale);
    expect(importBatch.getBatch(db, pending.importBatchId).status).not.toBe('committed');

    // 预览绑定操作者:同样有导入权限的另一用户不能代为确认,创建人可以
    const other = createScopedUser(db, { username: 't2-other', roleCodes: ['data_maintainer'], allOrgs: true });
    const owned = await (await upload(maintainer.session, base, version.id, await workbook([['SH', 'I01', '6.66', '', '']]))).json() as any;
    const foreign = await postJson(other.session, `${base}/api/io/import-batches/${owned.importBatchId}/confirm`);
    expect(foreign.status).toBe(409);
    expect((await foreign.json() as any).code).toBe('PREVIEW_OWNER_MISMATCH');
    expect((await postJson(other.session, `${base}/api/io/import-batches/${owned.importBatchId}/cancel`)).status).toBe(409);
    expect(importBatch.getBatch(db, owned.importBatchId).status).toBe('pending');
    expect(cells(db, version.id)).toEqual(beforeStale);
    const ownConfirm = await postJson(maintainer.session, `${base}/api/io/import-batches/${owned.importBatchId}/confirm`);
    expect(ownConfirm.status).toBe(200);
    expect(cells(db, version.id)['SH:I01'].amount).toBe(666);

    // 回滚:另建版本导入后回滚,恢复到导入前(空)
    const v2 = budget.createVersion(db, { year: 2026, name: 'T2 回滚' });
    const imported = await (await upload(maintainer.session, base, v2.id, file, true)).json() as any;
    expect(Object.keys(cells(db, v2.id)).length).toBeGreaterThan(0);
    const rollback = await postJson(maintainer.session, `${base}/api/io/import-batches/${imported.importBatchId}/rollback`);
    expect(rollback.status).toBe(200);
    expect(Object.values(cells(db, v2.id)).every((c) => c.amount === 0 && (c.quantity ?? 0) === 0)).toBe(true);
  });

  it('页面与问答同源:受限用户的页面、工具、问答数字一致,答案说明范围并带引用', async () => {
    const { base, db } = await boot();
    const { fx, version } = setup(db);
    const maintainer = createScopedUser(db, { username: 't2-src', roleCodes: ['data_maintainer'], allOrgs: true });
    const sh = createScopedUser(db, { username: 't2-sh', roleCodes: ['finance_analyst'], orgIds: [fx.orgIds.shanghai] });
    await upload(maintainer.session, base, version.id, await workbook(SAMPLE), true);

    const page = await (await fetchAs(sh.session, `${base}/api/report/completion?versionId=${version.id}`)).json() as any;
    expect(accountCell(page, 'I').budgetCents).toBe(123456789);
    expect(accountCell(page, 'Q01').budgetQuantity).toBe(125000);

    const tool = as(db, sh.userId, () => executeTool(db, 'calculate_execution', { versionId: version.id, sheetKey: 'all' } as any)) as any;
    expect(accountCell(tool, 'I')).toEqual(accountCell(page, 'I'));

    const chat = await (await postJson(sh.session, `${base}/api/assistant/chat`, { message: '2026年预算执行情况', pageContext: pageSnapshot({ year: 2026, budgetVersionId: version.id }) })).json() as any;
    expect(chat.effectiveContext.orgScopeId).toBe(fx.orgIds.shanghai);
    const text = JSON.stringify(chat.facts);
    expect(text).toContain('"budgetCents":123456789');
    expect(text).not.toContain('173456789');
    expect(chat.citations.length).toBeGreaterThan(0);
    expect(chat.routing).toBe('rules');
  });

  it('文件规模上限按数据行计(不含表头):恰好上限放行,多一行明确拒绝', async () => {
    const rows = (n: number) => Array.from({ length: n }, (_, i) => ['SH', 'I01', `${i + 1}.00`, '', '']);
    await expect(assertSafeXlsx(await workbook(rows(5)), 5)).resolves.toBeUndefined();
    await expect(assertSafeXlsx(await workbook(rows(6)), 5)).rejects.toMatchObject({
      code: 'VALIDATION_FAILED',
      message: expect.stringContaining('数据行超过安全上限 5 行'),
    });
  });
});

describe('T-2 模型失败与越权工具参数(AC-X06)', () => {
  const envKeys = ['AI_BASE_URL', 'AI_API_KEY', 'AI_STREAM', 'AI_TIMEOUT_MS', 'AI_TOTAL_TIMEOUT_MS', 'NEWFC_MODEL_CONCURRENCY'] as const;
  const saved = new Map(envKeys.map((k) => [k, process.env[k]]));
  afterEach(() => {
    for (const k of envKeys) { const v = saved.get(k); if (v === undefined) delete process.env[k]; else process.env[k] = v; }
    vi.unstubAllGlobals();
    setChannelResolver(null);
    setModelCallRecorder(null);
  });

  async function seeded() {
    const db = testDb();
    setModelCallRecorder(null);
    const { fx, version } = setup(db);
    const file = await workbook(SAMPLE);
    const parsed = await io.parseBudgetImport(file);
    const entries = io.resolveBudgetImport(db, version.id, parsed);
    const created = importBatch.createBatch(db, {
      kind: 'budget', targetVersionId: version.id, originalName: 't2.xlsx', file,
      payload: { versionId: version.id, entries }, summary: { versionId: version.id, count: entries.length },
      preview: buildStandardBudgetPreview(db, version.id, entries, parsed.rows),
    });
    importBatch.commitBatch(db, created.id);
    const sh = createScopedUser(db, { username: 'model-sh', roleCodes: ['finance_analyst'], orgIds: [fx.orgIds.shanghai] });
    return { db, fx, version, sh };
  }

  const ask = (db: DB, userId: number, versionId: number) => as(db, userId, () => assistant.chat(db, { message: '2026年预算执行情况', pageContext: pageSnapshot({ year: 2026, budgetVersionId: versionId }) } as any, 'tester'));
  const completion = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });

  it('未配置/超时/5xx:规则兜底给出同样的事实,如实标注模型错误,不伪造完成率', async () => {
    const { db, version, sh } = await seeded();
    setChannelResolver(null);
    for (const k of envKeys) delete process.env[k];
    const rules = await ask(db, sh.userId, version.id) as any;
    expect(rules.routing).toBe('rules');
    expect(rules.model).toBe('template');
    // 比较执行事实本身(去掉生成时间等易变字段)
    const cellsOf = (res: any) => JSON.stringify(res.facts.filter((f: any) => f.type === 'execution').map((f: any) => f.data.analysisAccounts));
    const baseline = cellsOf(rules);
    expect(baseline).toContain('"budgetCents":123456789');

    process.env.AI_BASE_URL = 'https://model.example.com/v1';
    process.env.AI_STREAM = '0';
    process.env.AI_TIMEOUT_MS = '50';
    process.env.AI_TOTAL_TIMEOUT_MS = '100';
    vi.stubGlobal('fetch', vi.fn(async (_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    })));
    const timedOut = await ask(db, sh.userId, version.id) as any;
    expect(timedOut.routing).toBe('rules');
    expect(timedOut.modelError).toBeTruthy();
    expect(cellsOf(timedOut)).toBe(baseline);

    vi.stubGlobal('fetch', vi.fn(async () => completion({ error: 'down' }, 503)));
    const down = await ask(db, sh.userId, version.id) as any;
    expect(down.routing).toBe('rules');
    expect(down.modelError).toBeTruthy();
    expect(cellsOf(down)).toBe(baseline);
  });

  it('模型并发已满(OPEN-04):超出上限立即降级规则查询,不排队;释放后恢复外呼', async () => {
    const { db, version, sh } = await seeded();
    setChannelResolver(null);
    process.env.AI_BASE_URL = 'https://model.example.com/v1';
    process.env.AI_STREAM = '0';
    process.env.NEWFC_MODEL_CONCURRENCY = '1';
    const fetchMock = vi.fn(async (_url: unknown, init?: RequestInit) => new Promise<Response>((_resolve, reject) => {
      init?.signal?.addEventListener('abort', () => reject(Object.assign(new Error('aborted'), { name: 'AbortError' })));
    }));
    vi.stubGlobal('fetch', fetchMock);
    const holder = new AbortController();
    const held = new EnvChatModel('chat').complete({ messages: [{ role: 'user', content: 'hold' }], signal: holder.signal }).catch((e) => e);
    await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));

    const busy = await ask(db, sh.userId, version.id) as any;
    expect(busy.routing).toBe('rules');
    expect(String(busy.modelError)).toMatch(/模型并发已满/);
    expect(JSON.stringify(busy.facts)).toContain('"budgetCents":123456789');
    expect(fetchMock).toHaveBeenCalledTimes(1);
    expect(classifyModelError(new Error('模型并发已满(上限 1)'))).toEqual({ status: 'error', errorType: 'busy' });

    holder.abort();
    await held;
    vi.stubGlobal('fetch', vi.fn(async () => completion({ choices: [{ message: { content: 'ok' } }] })));
    await expect(new EnvChatModel('chat').complete({ messages: [{ role: 'user', content: 'again' }] })).resolves.toMatchObject({ text: 'ok' });
  });

  it('模型伪造范围外组织参数:工具按身份拒绝,事实与正文不含范围外数字;非法参数不执行', async () => {
    const { db, fx, version, sh } = await seeded();
    setChannelResolver(null);
    process.env.AI_BASE_URL = 'https://model.example.com/v1';
    process.env.AI_STREAM = '0';
    let round = 0;
    vi.stubGlobal('fetch', vi.fn(async () => {
      round += 1;
      if (round === 1) {
        return completion({ choices: [{ message: { content: null, tool_calls: [
          { id: 'c1', type: 'function', function: { name: 'calculate_execution', arguments: JSON.stringify({ versionId: version.id, orgScopeId: fx.orgIds.hangzhou }) } },
          { id: 'c2', type: 'function', function: { name: 'get_budget_matrix', arguments: JSON.stringify({ versionId: version.id }) } },
          { id: 'c3', type: 'function', function: { name: 'calculate_execution', arguments: '{not json' } },
        ] } }] });
      }
      return completion({ choices: [{ message: { content: '已按上海公司范围回答。' } }] });
    }));
    const res = await ask(db, sh.userId, version.id) as any;
    // 模型确实发起了工具调用并收到结果后再作答(不是没走到工具就结束)
    expect(round).toBeGreaterThanOrEqual(2);
    const toolResults = JSON.stringify(JSON.parse(String(((fetch as unknown as { mock: { calls: [unknown, RequestInit][] } }).mock.calls[1][1]).body)).messages.filter((m: any) => m.role === 'tool'));
    expect(toolResults).toMatch(/不存在或无权访问|NOT_FOUND/);
    const dump = JSON.stringify(res);
    expect(dump).not.toContain('50000000'); // 杭州收入
    expect(dump).not.toContain('173456789'); // 集团收入
    expect(dump).not.toContain('杭州公司');
    // 发往模型的工具清单已按身份过滤:集团口径工具不暴露
    const firstRequest = JSON.parse(String(((fetch as unknown as { mock: { calls: [unknown, RequestInit][] } }).mock.calls[0][1]).body));
    const exposed = (firstRequest.tools ?? []).map((t: any) => t.function.name);
    expect(exposed).toContain('calculate_execution');
    expect(exposed).not.toContain('get_budget_matrix');
    expect(exposed).not.toContain('get_operation_log');
  });
});
