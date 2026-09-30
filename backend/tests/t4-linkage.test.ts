import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { openDatabase } from '../src/db/connection';
import { applyMigrations, MIGRATIONS } from '../src/db/migrations';
import { boot, get, json, post, upload } from './t3-helpers';
import { createScopedUser } from './http-helpers';
import { createProject, xlsxSheets } from './t4-helpers';

/**
 * T-4 联动:V53 整表重建保留数据/外键/触发器;管理会计 contract_paid / contract_payment_rate / plan_execution_rate;
 * 标准报表“合同付款台账”冻结合同版本;组织范围。
 */

const now = '2026-06-30T00:00:00.000Z';
function insertContract(db: ReturnType<typeof openDatabase>, v: { no: string; orgId: number; original: number; paid?: number; status?: string; payments?: [number, string][] }) {
  const id = Number(db.prepare(`INSERT INTO ct_contract (contract_no, normalized_no, name, org_id, original_cents, paid_cents, stage, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, 'performance', ?, ?, ?)`).run(v.no, v.no, `${v.no} 合同`, v.orgId, v.original, v.paid ?? 0, v.status ?? 'active', now, now).lastInsertRowid);
  for (const [amount, date] of v.payments ?? []) {
    db.prepare(`INSERT INTO ct_payment (contract_id, kind, node_name, amount_cents, status, submitted_at, paid_date, paid_at)
      VALUES (?, 'import_baseline', '付款', ?, 'paid', ?, ?, ?)`).run(id, amount, now, date, now);
  }
  return id;
}

describe('T-4 联动(V53、管理会计、合同付款台账)', () => {
  it('V53 在已有数据上重建:指标/快照/标准报表保留,外键完好,冻结与不可删触发器仍生效,新枚举可写', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'newfc-v53-'));
    const db = openDatabase(path.join(dir, 'v53.sqlite'));
    // 模拟停在 V52 的库:暂时移除 V53 及之后的迁移
    const v53 = MIGRATIONS.findIndex((m) => m.version === 53);
    const removed = MIGRATIONS.splice(v53, MIGRATIONS.length - v53);
    try {
      applyMigrations(db);
    } finally {
      MIGRATIONS.splice(v53, 0, ...removed);
    }
    expect((db.prepare('SELECT MAX(version) AS v FROM schema_migration').get() as { v: number }).v).toBe(52);
    const org = Number(db.prepare("INSERT INTO org (code, name, created_at, updated_at) VALUES ('X', 'X公司', ?, ?)").run(now, now).lastInsertRowid);
    const metric = db.prepare("SELECT id FROM ma_metric WHERE code = 'ALLOCATED_COST'").get() as { id: number };
    const run = Number(db.prepare("INSERT INTO ma_calc_run (kind, period, created_at) VALUES ('calc', '2026-06', ?)").run(now).lastInsertRowid);
    db.prepare("INSERT INTO ma_metric_snapshot (run_id, metric_id, org_id, period, status, value_cents, reasons_json, evidence_json, created_at) VALUES (?, ?, ?, '2026-06', 'valid', 123, '[]', '{}', ?)")
      .run(run, metric.id, org, now);
    const report = Number(db.prepare(`INSERT INTO std_report (report_type, title, org_id, period, params_json, columns_json, rows_json, summary_json, sources_json, content_sha256, generated_at)
      VALUES ('eas_recon', 't', ?, '2026-06', '{}', '[]', '[]', '[]', '{}', 'sha', ?)`).run(org, now).lastInsertRowid);
    expect(() => db.prepare("INSERT INTO ma_metric (code, name, unit, calculator, created_at, updated_at) VALUES ('CP', 'CP', 'money', 'contract_paid', ?, ?)").run(now, now)).toThrow(/CHECK/);

    applyMigrations(db);
    expect((db.prepare('SELECT MAX(version) AS v FROM schema_migration').get() as { v: number }).v).toBeGreaterThanOrEqual(53);
    expect(db.prepare('SELECT id, code, builtin FROM ma_metric WHERE id = ?').get(metric.id)).toEqual({ id: metric.id, code: 'ALLOCATED_COST', builtin: 1 });
    expect(db.prepare('SELECT metric_id FROM ma_metric_snapshot').get()).toEqual({ metric_id: metric.id });
    expect(db.pragma('foreign_key_check')).toEqual([]);
    expect(db.pragma('foreign_keys', { simple: true })).toBe(1);
    const fkTargets = (db.prepare("SELECT \"table\" AS t FROM pragma_foreign_key_list('ma_metric_snapshot')").all() as { t: string }[]).map((r) => r.t);
    expect(fkTargets).toContain('ma_metric');
    expect(() => db.prepare("UPDATE std_report SET title = 'x' WHERE id = ?").run(report)).toThrow(/冻结内容不可修改/);
    expect(() => db.prepare('DELETE FROM std_report WHERE id = ?').run(report)).toThrow(/不可删除/);
    expect(() => db.prepare('DELETE FROM ma_metric WHERE id = ?').run(metric.id)).toThrow(/FOREIGN KEY/);
    db.prepare("INSERT INTO ma_metric (code, name, unit, calculator, created_at, updated_at) VALUES ('CP', 'CP', 'money', 'contract_paid', ?, ?)").run(now, now);
    db.prepare(`INSERT INTO std_report (report_type, title, org_id, period, params_json, columns_json, rows_json, summary_json, sources_json, content_sha256, generated_at)
      VALUES ('contract_payment_ledger', 't', ?, '2026-06', '{}', '[]', '[]', '[]', '{}', 'sha', ?)`).run(org, now);
    const indexes = (db.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND tbl_name = 'std_report' AND name NOT LIKE 'sqlite_%'").all() as { name: string }[]).map((r) => r.name).sort();
    expect(indexes).toEqual(['idx_std_report_org', 'idx_std_report_type']);
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('管理会计三个计算器与合同付款台账:取数、不可用原因、冻结合同版本与组织范围', async () => {
    const { base, db, admin, fx } = await boot('newfc-t4-link-');
    const a = insertContract(db, { no: 'HT-A', orgId: fx.orgIds.shanghai, original: 10_000_000, paid: 5_000_000, payments: [[3_000_000, '2026-05-10'], [2_000_000, '2026-06-02']] });
    insertContract(db, { no: 'HT-B', orgId: fx.orgIds.hangzhou, original: 20_000_000 });
    insertContract(db, { no: 'HT-C', orgId: fx.orgIds.shanghai, original: 1_000_000, status: 'voided', payments: [] });

    await createProject(base, admin, 'P-SH-01', '上海泵站改造', fx.orgIds.shanghai);
    const plan = await xlsxSheets({
      '固定资产投资计划': [
        ['2026年固定资产投资计划'], ['单位:万元'],
        ['序号', '项目编码', '项目名称', '承办单位', '批复概算', '总投资', '开工累计已完成投资', '本年计划投资', '本年实际完成投资', '形象进度', '累计已付款'],
        ['1', 'P-SH-01', '上海泵站改造', '上海公司', 12000, 10000, 3000, 2000, 1100, '45%', 2500],
      ],
    });
    const batch = await json(upload(base, admin, '/api/plan/import', plan, 'plan.xlsx', { year: '2026', actualPeriod: '2026-06' }));
    expect(batch.id, JSON.stringify(batch)).toBeGreaterThan(0);
    expect((await post(base, admin, `/api/plan/batches/${batch.id}/activate`, { expectedCurrentBatchId: null })).status).toBe(200);

    const metric = async (code: string, calculator: string) => json(post(base, admin, '/api/mgmt/metrics', { code, name: code, params: { calculator }, thresholds: {} }));
    const paid = await metric('CT_PAID', 'contract_paid');
    const rate = await metric('CT_RATE', 'contract_payment_rate');
    const planRate = await metric('PLAN_RATE', 'plan_execution_rate');
    expect([paid.unit, rate.unit, planRate.unit]).toEqual(['money', 'ratio', 'ratio']);
    const calc = async (period: string) => {
      const r = await post(base, admin, '/api/mgmt/calc-runs', { period, metricIds: [paid.id, rate.id, planRate.id], orgIds: [fx.orgIds.shanghai, fx.orgIds.east, fx.orgIds.nanjing] });
      expect(r.status, await r.clone().text()).toBe(201);
      const body = await r.json() as { snapshots: { metricId: number; orgId: number; value: string | null; status: string; reasons: { code: string }[]; evidence: Record<string, unknown> }[] };
      return (m: { id: number }, orgId: number) => body.snapshots.find((s) => s.metricId === m.id && s.orgId === orgId)!;
    };
    const june = await calc('2026-06');
    expect(june(paid, fx.orgIds.shanghai)).toMatchObject({ status: 'valid', value: '20000.00' });
    expect(june(paid, fx.orgIds.east)).toMatchObject({ status: 'valid', value: '20000.00' });
    expect(june(paid, fx.orgIds.nanjing)).toMatchObject({ status: 'unavailable', value: null, reasons: [{ code: 'CONTRACT_MISSING' }] });
    expect(june(rate, fx.orgIds.shanghai)).toMatchObject({ status: 'valid', value: '0.500000' });
    expect(june(rate, fx.orgIds.east)).toMatchObject({ status: 'valid', value: '0.166667' });
    expect(june(planRate, fx.orgIds.shanghai)).toMatchObject({ status: 'valid', value: '0.550000', evidence: { batchId: batch.id, annualPlan: '20000000.00', annualActual: '11000000.00' } });
    expect(june(planRate, fx.orgIds.nanjing)).toMatchObject({ status: 'unavailable', reasons: [{ code: 'PLAN_MISSING' }] });
    const may = await calc('2026-05');
    expect(may(paid, fx.orgIds.shanghai)).toMatchObject({ status: 'valid', value: '30000.00' });
    // 2026-05 截至期间内没有已激活的计划批次(批次实际期间为 6 月)
    expect(may(planRate, fx.orgIds.shanghai)).toMatchObject({ status: 'unavailable', reasons: [{ code: 'PLAN_MISSING' }] });

    // 合同付款台账:作废合同不计;冻结合同版本;本期/累计已付
    const ledger = await json(post(base, admin, '/api/standard-reports', { reportType: 'contract_payment_ledger', period: '2026-05', orgId: fx.orgIds.east }));
    expect(ledger).toMatchObject({ reportType: 'contract_payment_ledger', title: '2026-05 合同付款台账 · 华东大区', status: 'generated', rowCount: 2 });
    expect(ledger.rows.map((r: Record<string, unknown>) => [r.contractNo, r.current, r.periodPaid, r.paid, r.unpaid, r.rate, r.stage, r.version])).toEqual([
      ['HT-A', '100000.00', '30000.00', '50000.00', '50000.00', '0.500000', '履约执行', 1],
      ['HT-B', '200000.00', '0.00', '0.00', '200000.00', '0.000000', '履约执行', 1],
    ]);
    expect(ledger.summary.find((s: { label: string }) => s.label === '整体付款比例').value).toBe('0.166667');
    expect(ledger.sources.contracts).toEqual([{ id: a, version: 1 }, { id: a + 1, version: 1 }]);
    // 合同后续变化不影响已冻结的台账
    db.prepare('UPDATE ct_contract SET version = version + 1 WHERE id = ?').run(a);
    expect((await json(get(base, admin, `/api/standard-reports/${ledger.id}`))).rows[0].version).toBe(1);

    // 组织范围:受限用户不能生成全组织台账;范围外组织 404
    const eastAnalyst = createScopedUser(db, { username: 'ct-analyst', roleCodes: ['finance_analyst'], orgIds: [fx.orgIds.east] }).session;
    const westAnalyst = createScopedUser(db, { username: 'ct-analyst-w', roleCodes: ['finance_analyst'], orgIds: [fx.orgIds.west] }).session;
    const whole = await post(base, eastAnalyst, '/api/standard-reports', { reportType: 'contract_payment_ledger', period: '2026-05' });
    expect([whole.status, (await whole.json()).code]).toEqual([403, 'SCOPE_RESTRICTED']);
    const outside = await post(base, westAnalyst, '/api/standard-reports', { reportType: 'contract_payment_ledger', period: '2026-05', orgId: fx.orgIds.east });
    expect(outside.status).toBe(404);
    expect((await get(base, westAnalyst, `/api/standard-reports/${ledger.id}`)).status).toBe(404);
  });
});
