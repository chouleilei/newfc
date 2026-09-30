import { describe, expect, it } from 'vitest';
import type { DB } from '../src/db/connection';
import { boot, get, json, post } from './t3-helpers';
import { createScopedUser, fetchAs } from './http-helpers';
import { createProject } from './t4-helpers';

/**
 * T-7 风险规则补齐(AC-F17,对应 lishui risk/scan.py):付款超前形象进度、完成投资逼近概算、计划明细未关联项目、
 * 已支付缺凭证号、供应商大额集中付款、大额凭证缺项目、预付/暂估/挂账、预算执行与 EAS 入账差异;
 * 自定义规则复用计算器并限定组织;风险解释只追加;整改清单按来源与证据确定性生成。
 */

const now = '2026-06-30T00:00:00.000Z';
let seq = 0;

function fileObject(db: DB): number {
  seq += 1;
  const sha = `f7${String(seq).padStart(4, '0')}`.padEnd(64, '0');
  return Number(db.prepare('INSERT INTO file_object (sha256, size_bytes, original_name, created_at) VALUES (?, 1, ?, ?)').run(sha, `f${seq}.xlsx`, now).lastInsertRowid);
}

function seedPb(db: DB, entries: { projectId: number; code: string; orgId: number; budget: number; executed: number }[]) {
  const batch = Number(db.prepare(`INSERT INTO pb_batch (year, period, name, file_object_id, file_sha256, file_name, is_current, row_count, created_at)
    VALUES (2026, '2026-06', '2026-06 项目预算', ?, 'sha-pb7', 'pb.xlsx', 1, ?, ?)`).run(fileObject(db), entries.length, now).lastInsertRowid);
  entries.forEach((e, i) => db.prepare(`INSERT INTO pb_entry (batch_id, row_no, project_id, project_code, project_name, org_id, fund_source, budget_cents, executed_cents, exec_month)
    VALUES (?, ?, ?, ?, ?, ?, '自有资金', ?, ?, '2026-06')`).run(batch, i + 2, e.projectId, e.code, `${e.code} 项目`, e.orgId, e.budget, e.executed));
}

type Fact = { key: string; amount?: number; ratio?: number };
function seedPlan(db: DB, items: { name: string; projectId: number | null; orgId: number; facts: Fact[] }[]) {
  const batch = Number(db.prepare(`INSERT INTO plan_batch (year, actual_period, file_object_id, file_sha256, file_name, amount_unit, is_current, item_count, fact_count, created_at)
    VALUES (2026, '2026-06', ?, 'sha-plan7', 'plan.xlsx', 'yuan', 1, ?, 0, ?)`).run(fileObject(db), items.length, now).lastInsertRowid);
  const measure: Record<string, string> = { approved_budget: 'total', paid_cumulative: 'cumulative', completed_investment: 'cumulative', physical_progress: 'snapshot', annual_plan: 'annual_plan', annual_actual: 'annual_actual_ytd' };
  items.forEach((it, i) => {
    const item = Number(db.prepare(`INSERT INTO plan_item (batch_id, sheet_code, row_no, item_name, item_type, item_key, project_id, org_id)
      VALUES (?, 'investment', ?, ?, 'detail', ?, ?, ?)`).run(batch, i + 5, it.name, `k-${it.name}`, it.projectId, it.orgId).lastInsertRowid);
    for (const f of it.facts) {
      db.prepare(`INSERT INTO plan_fact (batch_id, item_id, field_key, measure, value_type, amount_cents, scaled_value, source_cell) VALUES (?, ?, ?, ?, ?, ?, ?, 'A1')`)
        .run(batch, item, f.key, measure[f.key], f.ratio !== undefined ? 'ratio' : 'amount', f.amount ?? null, f.ratio ?? null);
    }
  });
}

function seedEas(db: DB, orgId: number, period: string, lines: { voucher: string; account: string; name: string; debit: number; credit?: number; summary?: string; project?: string }[]) {
  const batch = Number(db.prepare(`INSERT INTO eas_batch (data_type, org_id, source_company, period, file_object_id, file_sha256, file_name, row_count, status, is_current, parser_version, created_at)
    VALUES ('voucher', ?, '样本公司', ?, ?, ?, 'v.csv', ?, 'active', 1, 't7', ?)`).run(orgId, period, fileObject(db), `sha-eas-${period}-${orgId}`, lines.length, now).lastInsertRowid);
  lines.forEach((l, i) => db.prepare(`INSERT INTO eas_voucher_line (batch_id, source_row, voucher_date, voucher_no, entry_no, account_code, account_name, summary, debit_cents, credit_cents, project_code)
    VALUES (?, ?, ?, ?, '1', ?, ?, ?, ?, ?, ?)`).run(batch, i + 2, `${period}-15`, l.voucher, l.account, l.name, l.summary ?? null, l.debit, l.credit ?? 0, l.project ?? null));
}

function seedPaidContract(db: DB, v: { orgId: number; supplierId: number; projectId: number; payments: { amount: number; voucher: string | null }[] }) {
  const paid = v.payments.reduce((s, p) => s + p.amount, 0);
  const ct = Number(db.prepare(`INSERT INTO ct_contract (contract_no, normalized_no, name, org_id, project_id, supplier_id, original_cents, paid_cents, stage, status, created_at, updated_at)
    VALUES ('HT-7', 'HT-7', '泵站施工合同', ?, ?, ?, ?, ?, 'performance', 'active', ?, ?)`).run(v.orgId, v.projectId, v.supplierId, paid * 2, paid, now, now).lastInsertRowid);
  const invoice = Number(db.prepare(`INSERT INTO ct_document (contract_id, doc_type, file_object_id, name, uploaded_at) VALUES (?, 'invoice', ?, '发票.pdf', ?)`).run(ct, fileObject(db), now).lastInsertRowid);
  const ids = v.payments.map((p, i) => Number(db.prepare(`INSERT INTO ct_payment (contract_id, node_name, amount_cents, status, submitted_at, paid_date, voucher_no, invoice_document_id, paid_at)
    VALUES (?, ?, ?, 'paid', ?, '2026-06-10', ?, ?, ?)`).run(ct, `进度款${i + 1}`, p.amount, now, p.voucher, invoice, now).lastInsertRowid));
  return { contractId: ct, paymentIds: ids };
}

describe('T-7 风险规则补齐', () => {
  it('新增内置规则按当前事实命中;自定义规则复用计算器并限定组织;阈值按类型校验', async () => {
    const { base, db, admin, fx } = await boot('newfc-t7-risk-');
    const sh = fx.orgIds.shanghai; const hz = fx.orgIds.hangzhou;
    const p1 = await createProject(base, admin, 'P-SH-01', '上海泵站改造', sh);
    const p3 = await createProject(base, admin, 'P-HZ-03', '杭州水厂', hz);
    seedPb(db, [
      { projectId: p1, code: 'P-SH-01', orgId: sh, budget: 100_000_000, executed: 10_000_000 }, // 执行率 0.1
      { projectId: p3, code: 'P-HZ-03', orgId: hz, budget: 10_000_000, executed: 4_000_000 }, // 0.4:内置 0.3 不命中,自定义 0.5 命中但不在上海
    ]);
    seedPlan(db, [
      { name: '上海泵站改造', projectId: p1, orgId: sh, facts: [
        { key: 'approved_budget', amount: 100_000_000 }, { key: 'paid_cumulative', amount: 60_000_000 }, { key: 'completed_investment', amount: 95_000_000 },
        { key: 'physical_progress', ratio: 300_000 },
      ] },
      { name: '杭州零星管网', projectId: null, orgId: hz, facts: [{ key: 'annual_plan', amount: 10_000_000 }, { key: 'annual_actual', amount: 9_000_000 }] },
    ]);
    const supplier = Number(db.prepare(`INSERT INTO md_supplier (name, normalized_name, created_at, updated_at) VALUES ('华东建设', '华东建设', ?, ?)`).run(now, now).lastInsertRowid);
    const ct = seedPaidContract(db, { orgId: sh, supplierId: supplier, projectId: p1, payments: [{ amount: 60_000_000, voucher: null }, { amount: 60_000_000, voucher: '记-0012' }] });
    seedEas(db, sh, '2026-05', [{ voucher: '记-0001', account: '5001', name: '在建工程', debit: 99_000_000 }]); // 非最新期间,不参与凭证类规则
    seedEas(db, sh, '2026-06', [
      { voucher: '记-0101', account: '5001', name: '在建工程', debit: 20_000_000 },
      { voucher: '记-0102', account: '1002', name: '银行存款', debit: 50_000_000 },
      { voucher: '记-0103', account: '1123', name: '预付账款', debit: 5_000_000, summary: '预付泵站工程款', project: 'P-SH-01' },
      { voucher: '记-0104', account: '5001', name: '在建工程', debit: 8_000_000, project: 'P-SH-01' },
    ]);

    const reviewer = createScopedUser(db, { username: 'r7-reviewer', roleCodes: ['business_reviewer'], orgIds: [sh] }).session;
    // 自定义规则:只有全组织 risk:review 可建;计算器与阈值按类型校验
    const bad = [
      [reviewer, { code: 'CUSTOM_SH_LOW', name: '上海执行率', detector: 'PB_LOW_EXEC', level: 'high', threshold: '0.5' }, 403],
      [admin, { code: 'CUSTOM_X', name: '未知', detector: 'NOPE_RULE', level: 'high' }, 400],
      [admin, { code: 'CUSTOM_X', name: '比率越界', detector: 'PB_LOW_EXEC', level: 'high', threshold: '1.5' }, 400],
      [admin, { code: 'CUSTOM_X', name: '无阈值规则', detector: 'PB_OVER_BUDGET', level: 'high', threshold: '0.5' }, 400],
      [admin, { code: 'PB_LOW_EXEC', name: '重复', detector: 'PB_LOW_EXEC', level: 'high', threshold: '0.5' }, 409],
    ] as const;
    for (const [s, body, status] of bad) expect((await post(base, s, '/api/risk/rules', body)).status).toBe(status);
    const custom = await json(post(base, admin, '/api/risk/rules', { code: 'CUSTOM_SH_LOW', name: '上海项目执行率低于一半', detector: 'PB_LOW_EXEC', level: 'high', threshold: '0.5', orgId: sh }));
    expect(custom).toMatchObject({ code: 'CUSTOM_SH_LOW', builtin: false, source: 'project_budget', detector: 'PB_LOW_EXEC', orgId: sh, thresholdKind: 'ratio', enabled: true });

    const scan = await json(post(base, admin, '/api/risk/scans'));
    expect(scan.createdCount).toBe(10);
    const events = await json(get(base, admin, '/api/risk/events')) as { id: number; eventKey: string; ruleCode: string; amount: string | null; metric: string | null; orgId: number; source: string }[];
    expect(events.map((e) => e.ruleCode).sort()).toEqual([
      'CONTRACT_PAY_NO_VOUCHER', 'CUSTOM_SH_LOW', 'EAS_BUDGET_DIFF', 'EAS_LONG_UNCLEARED', 'EAS_PROJECT_CODE_MISSING', 'PB_LOW_EXEC',
      'PLAN_ESTIMATE_NEAR_LIMIT', 'PLAN_PAY_AHEAD_PROGRESS', 'PLAN_PROJECT_UNMAPPED', 'SUPPLIER_LARGE_PAYMENTS',
    ]);
    const by = (code: string) => events.find((e) => e.ruleCode === code)!;
    expect(by('CUSTOM_SH_LOW').eventKey).toBe(`CUSTOM_SH_LOW:project:${p1}:org${sh}`);
    expect(by('PLAN_PAY_AHEAD_PROGRESS')).toMatchObject({ eventKey: `PLAN_PAY_AHEAD_PROGRESS:project:${p1}:plan_pay_ahead`, amount: '300000.00', metric: '0.300000' });
    expect(by('PLAN_ESTIMATE_NEAR_LIMIT')).toMatchObject({ amount: '50000.00', metric: '0.950000' });
    expect(by('PLAN_PROJECT_UNMAPPED')).toMatchObject({ orgId: hz, amount: '100000.00' });
    expect(by('CONTRACT_PAY_NO_VOUCHER').eventKey).toBe(`CONTRACT_PAY_NO_VOUCHER:ct_payment:${ct.paymentIds[0]}`);
    expect(by('SUPPLIER_LARGE_PAYMENTS')).toMatchObject({ eventKey: `SUPPLIER_LARGE_PAYMENTS:supplier:${supplier}:org${sh}`, amount: '1200000.00' });
    expect(by('EAS_PROJECT_CODE_MISSING')).toMatchObject({ orgId: sh, amount: '200000.00', source: 'eas' });
    expect(by('EAS_LONG_UNCLEARED')).toMatchObject({ orgId: sh, amount: '50000.00' });
    // 5 月 + 6 月当前凭证按项目入账 130000 与项目预算执行 100000 相差 30000
    expect(by('EAS_BUDGET_DIFF')).toMatchObject({ eventKey: `EAS_BUDGET_DIFF:project:${p1}:eas_diff`, amount: '30000.00', metric: '0.300000' });

    // 金额阈值规范化;调高后再扫只标记未再命中
    const rules = await json(get(base, admin, '/api/risk/rules')) as { code: string; version: number; thresholdKind: string | null; builtin: boolean }[];
    expect(rules.filter((r) => r.builtin)).toHaveLength(20);
    const sup = rules.find((r) => r.code === 'SUPPLIER_LARGE_PAYMENTS')!;
    expect(sup.thresholdKind).toBe('amount');
    const patch = (code: string, body: Record<string, unknown>) => fetchAs(admin, `${base}/api/risk/rules/${code}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await patch('SUPPLIER_LARGE_PAYMENTS', { expectedVersion: sup.version, name: '改名' })).status).toBe(400);
    const updated = await json(patch('SUPPLIER_LARGE_PAYMENTS', { expectedVersion: sup.version, threshold: '2000000' }));
    expect(updated.threshold).toBe('2000000.00');
    expect((await patch('CUSTOM_SH_LOW', { expectedVersion: custom.version, name: '上海执行率低于一半(调整)' })).status).toBe(200);
    const rescan = await json(post(base, admin, '/api/risk/scans'));
    expect(rescan).toMatchObject({ createdCount: 0, clearedCount: 1 });
    expect((await json(get(base, admin, `/api/risk/events/${by('SUPPLIER_LARGE_PAYMENTS').id}`))).lastScanHit).toBe(false);
  });

  it('风险解释只追加且需处理权限;整改清单按来源列出缺失材料与建议状态', async () => {
    const { base, db, admin, fx } = await boot('newfc-t7-explain-');
    const sh = fx.orgIds.shanghai;
    const p1 = await createProject(base, admin, 'P-SH-02', '上海管网', sh);
    const supplier = Number(db.prepare(`INSERT INTO md_supplier (name, normalized_name, created_at, updated_at) VALUES ('江南水务', '江南水务', ?, ?)`).run(now, now).lastInsertRowid);
    const ct = seedPaidContract(db, { orgId: sh, supplierId: supplier, projectId: p1, payments: [{ amount: 1_000_000, voucher: null }] });
    await json(post(base, admin, '/api/risk/scans'));
    const [ev] = await json(get(base, admin, '/api/risk/events?ruleCode=CONTRACT_PAY_NO_VOUCHER'));
    expect(ev).toBeTruthy();

    const reviewer = createScopedUser(db, { username: 'r7-rev', roleCodes: ['business_reviewer'], allOrgs: true }).session;
    expect((await post(base, reviewer, `/api/risk/events/${ev.id}/explain`)).status).toBe(403);
    const note = await json(post(base, admin, `/api/risk/events/${ev.id}/explain`));
    expect(note).toMatchObject({ eventId: ev.id, source: 'template', model: 'template', promptVersion: 'risk-explain.v1' });
    expect(note.content).toContain('CONTRACT_PAY_NO_VOUCHER');
    expect(note.content).toContain('仅作辅助参考');
    await json(post(base, admin, `/api/risk/events/${ev.id}/explain`));
    const detail = await json(get(base, admin, `/api/risk/events/${ev.id}`));
    expect(detail.explanations).toHaveLength(2);
    expect(detail.status).toBe('open'); // 解释不改风险状态
    expect(() => db.prepare('DELETE FROM risk_ai_note').run()).toThrow(/只追加/);

    const cl = await json(get(base, reviewer, `/api/risk/events/${ev.id}/checklist`));
    expect(cl).toMatchObject({ eventId: ev.id, status: 'open', suggestedNextStatus: 'confirmed' });
    expect(cl.items.map((i: { key: string }) => i.key)).toEqual(['fact', 'owner', 'contract', 'rectify', 'review']);
    expect(cl.missingMaterials.map((m: { key: string }) => m.key).sort()).toEqual(['contract_performance', 'contract_signed']);
    expect(cl.items[0].refs).toEqual(expect.arrayContaining([
      { label: '合同详情', path: `/contracts?id=${ct.contractId}` }, { label: '项目档案 P-SH-02', path: `/projects/${p1}` },
    ]));
    // 范围外用户看不到清单
    const hz = createScopedUser(db, { username: 'r7-hz', roleCodes: ['business_reviewer'], orgIds: [fx.orgIds.hangzhou] }).session;
    expect((await get(base, hz, `/api/risk/events/${ev.id}/checklist`)).status).toBe(404);
  });
});
