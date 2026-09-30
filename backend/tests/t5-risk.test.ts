import { describe, expect, it } from 'vitest';
import type { DB } from '../src/db/connection';
import { boot, get, json, post, type Session } from './t3-helpers';
import { createScopedUser, fetchAs } from './http-helpers';
import { createProject } from './t4-helpers';
import { computeRiskHits, eventKeyOf } from '../src/modules/risk/risk.service';

/**
 * T-5 风险闭环(AC-F17):扫描发现 → 再扫只更新次数 → 确认/整改/提交/他人复核关闭 → 再触发重开;
 * 误报不重开;非法跳转与同人复核被拒;受限用户扫描与列表只含范围内;未再命中只标记;整改台账冻结。
 */

const now = '2026-06-30T00:00:00.000Z';

function fileObject(db: DB, tag: string): number {
  const sha = tag.padEnd(64, '0').slice(0, 64);
  return Number(db.prepare("INSERT INTO file_object (sha256, size_bytes, original_name, created_at) VALUES (?, 1, ?, ?)").run(sha, `${tag}.xlsx`, now).lastInsertRowid);
}

function seedProjectBudget(db: DB, entries: { projectId: number; code: string; orgId: number; budget: number; executed: number }[]) {
  const fo = fileObject(db, 'aa01');
  const batch = Number(db.prepare(`INSERT INTO pb_batch (year, period, name, file_object_id, file_sha256, file_name, is_current, row_count, created_at)
    VALUES (2026, '2026-06', '2026-06 项目预算', ?, 'sha-pb', 'pb.xlsx', 1, ?, ?)`).run(fo, entries.length, now).lastInsertRowid);
  entries.forEach((e, i) => db.prepare(`INSERT INTO pb_entry (batch_id, row_no, project_id, project_code, project_name, org_id, fund_source, budget_cents, executed_cents, exec_month)
    VALUES (?, ?, ?, ?, ?, ?, '自有资金', ?, ?, '2026-06')`).run(batch, i + 2, e.projectId, e.code, `${e.code} 项目`, e.orgId, e.budget, e.executed));
}

function seedContract(db: DB, v: { no: string; orgId: number; original: number; paid: number; cap: number }): number {
  return Number(db.prepare(`INSERT INTO ct_contract (contract_no, normalized_no, name, org_id, original_cents, paid_cents, payment_cap_ratio_scaled, stage, status, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, 'performance', 'active', ?, ?)`).run(v.no, v.no, `${v.no} 施工合同`, v.orgId, v.original, v.paid, v.cap, now, now).lastInsertRowid);
}

function seedFeasibility(db: DB, orgId: number): number {
  const p = Number(db.prepare(`INSERT INTO if_project (code, name, org_id, construction_start_year, operation_start_year, horizon_years, created_at, updated_at)
    VALUES ('FS-HZ', '杭州供水测算', ?, 2026, 2028, 20, ?, ?)`).run(orgId, now, now).lastInsertRowid);
  const s = Number(db.prepare(`INSERT INTO if_scenario (project_id, code, name, assumptions_json, assumptions_hash, created_at, updated_at)
    VALUES (?, 'base', '基准方案', '{}', 'h', ?, ?)`).run(p, now, now).lastInsertRowid);
  const result = {
    modelVersion: 'standard-1.0', roundingRule: '', parameterHash: 'ph1', discountBaseYear: 2026, allChecksPassed: true, cashflows: [],
    checks: [{ code: 'balance', severity: 'error', passed: true, message: '平衡', evidence: {} }],
    indicators: [
      { code: 'project_npv', value: '-120.500000', status: 'warning', evidence: {} },
      { code: 'project_irr', value: '0.050000', status: 'ok', evidence: { calculation_status: 'success', benchmark: '0.04' } },
      { code: 'equity_npv', value: '10.000000', status: 'ok', evidence: {} },
      { code: 'equity_irr', value: '0.090000', status: 'ok', evidence: { calculation_status: 'success', benchmark: '0.08' } },
    ],
  };
  db.prepare(`INSERT INTO if_run (scenario_id, kind, scenario_version, project_years_json, assumptions_json, parameter_hash, model_version, status, all_checks_passed, result_json, created_at)
    VALUES (?, 'base', 1, '[]', '{}', 'ph1', 'standard-1.0', 'succeeded', 1, ?, ?)`).run(s, JSON.stringify(result), now);
  return s;
}

async function act(base: string, s: Session, eventId: number, fields: Record<string, string | number>, file?: { name: string; content: string }) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, String(v));
  if (file) form.append('file', new Blob([file.content]), file.name);
  return fetchAs(s, `${base}/api/risk/events/${eventId}/actions`, { method: 'POST', body: form });
}

const eventsByKey = async (base: string, s: Session, q = '') => {
  const list = await json(get(base, s, `/api/risk/events${q}`)) as { eventKey: string; id: number; status: string; occurrenceCount: number; version: number; lastScanHit: boolean; orgId: number }[];
  return new Map(list.map((e) => [e.eventKey, e]));
};

describe('T-5 风险闭环', () => {
  it('扫描、再扫、流转、复核分离、重开、误报、未再命中与规则调整', async () => {
    const { base, db, admin, fx } = await boot('newfc-t5-risk-');
    const p1 = await createProject(base, admin, 'P-SH-01', '上海泵站改造', fx.orgIds.shanghai);
    const p2 = await createProject(base, admin, 'P-HZ-01', '杭州管网', fx.orgIds.hangzhou);
    seedProjectBudget(db, [
      { projectId: p1, code: 'P-SH-01', orgId: fx.orgIds.shanghai, budget: 1_000_000, executed: 100_000 },
      { projectId: p2, code: 'P-HZ-01', orgId: fx.orgIds.hangzhou, budget: 100_000, executed: 250_000 },
    ]);
    const ct = seedContract(db, { no: 'HT-SH-9', orgId: fx.orgIds.shanghai, original: 10_000_000, paid: 9_000_000, cap: 800_000 });
    seedContract(db, { no: 'HT-SH-OK', orgId: fx.orgIds.shanghai, original: 10_000_000, paid: 8_000_000, cap: 800_000 }); // 恰好等于上限不触发
    const scen = seedFeasibility(db, fx.orgIds.hangzhou);

    const analyst = createScopedUser(db, { username: 'risk-analyst', roleCodes: ['finance_analyst'], allOrgs: true }).session;
    const reviewer = createScopedUser(db, { username: 'risk-reviewer', roleCodes: ['business_reviewer'], allOrgs: true }).session;
    const both = createScopedUser(db, { username: 'risk-both', roleCodes: ['finance_analyst', 'business_reviewer'], allOrgs: true }).session;

    // 只读角色不能扫描
    expect((await post(base, reviewer, '/api/risk/scans')).status).toBe(403);
    const scan1 = await json(post(base, analyst, '/api/risk/scans'));
    expect(scan1).toMatchObject({ createdCount: 4, updatedCount: 0, hits: 4 });
    const keys = await eventsByKey(base, analyst);
    const kLow = `PB_LOW_EXEC:project:${p1}:org${fx.orgIds.shanghai}`;
    const kOver = `PB_OVER_BUDGET:project:${p2}:org${fx.orgIds.hangzhou}`;
    const kCap = `CONTRACT_PAY_OVER_CAP:contract:${ct}`;
    const kNpv = `FEAS_NPV_NEGATIVE:if_scenario:${scen}:project`;
    expect([...keys.keys()].sort()).toEqual([kCap, kNpv, kLow, kOver].sort());
    const capEvent = await json(get(base, analyst, `/api/risk/events/${keys.get(kCap)!.id}`));
    expect(capEvent).toMatchObject({ status: 'open', level: 'high', amount: '10000.00', metric: '0.900000', occurrenceCount: 1, allowed: ['confirm', 'comment'] });
    expect(capEvent.actions.map((a: { action: string }) => a.action)).toEqual(['detect']);
    expect((await json(get(base, analyst, `/api/risk/events/${keys.get(kOver)!.id}`))).amount).toBe('1500.00');

    // 再扫:不重复建单,只更新次数并记 redetect
    const scan2 = await json(post(base, analyst, '/api/risk/scans'));
    expect(scan2).toMatchObject({ createdCount: 0, updatedCount: 4 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM risk_event').get()).toEqual({ n: 4 });
    let cap = await json(get(base, analyst, `/api/risk/events/${keys.get(kCap)!.id}`));
    expect(cap.occurrenceCount).toBe(2);
    expect(cap.actions.map((a: { action: string }) => a.action)).toEqual(['detect', 'redetect']);

    // 流转:确认 → 整改 → 提交(附件) → 他人复核通过
    const id = cap.id as number;
    expect((await json(act(base, analyst, id, { action: 'confirm', expectedVersion: cap.version - 1 }))).code).toBe('VERSION_CONFLICT');
    expect((await json(act(base, analyst, id, { action: 'start', expectedVersion: cap.version }))).code).toBe('RISK_STATE');
    cap = await json(act(base, analyst, id, { action: 'confirm', expectedVersion: cap.version, deadline: '2026-07-31', comment: '确认超付' }));
    expect(cap.status).toBe('confirmed');
    cap = await json(act(base, analyst, id, { action: 'start', expectedVersion: cap.version }));
    expect(cap).toMatchObject({ status: 'rectifying', handlerName: expect.any(String) });
    const noNote = await act(base, analyst, id, { action: 'submit', expectedVersion: cap.version });
    expect(noNote.status).toBe(400);
    cap = await json(act(base, analyst, id, { action: 'submit', expectedVersion: cap.version, comment: '已追回超付款' }, { name: '追回凭证.pdf', content: 'receipt' }));
    expect(cap).toMatchObject({ status: 'rectified', rectifyNote: '已追回超付款' });
    // 整改人没有复核权限;审批动作需要 risk:review
    expect((await act(base, analyst, id, { action: 'approve', expectedVersion: cap.version })).status).toBe(403);
    const withFile = cap.actions.find((a: { action: string }) => a.action === 'submit');
    const dl = await get(base, reviewer, `/api/risk/events/${id}/actions/${withFile.id}/attachment`);
    expect(dl.status).toBe(200);
    expect(await dl.text()).toBe('receipt');
    cap = await json(act(base, reviewer, id, { action: 'approve', expectedVersion: cap.version, comment: '核实' }));
    expect(cap).toMatchObject({ status: 'closed', allowed: [] }); // 复核人没有 risk:handle,不能备注
    expect(cap.closedAt).toBeTruthy();
    // 终态:非法跳转
    expect((await json(act(base, analyst, id, { action: 'confirm', expectedVersion: cap.version }))).code).toBe('RISK_STATE');
    expect(() => db.prepare('UPDATE risk_action SET comment = ? WHERE event_id = ?').run('x', id)).toThrow(/只追加/);

    // 同人复核:既能整改又能复核的非管理员被拒;管理员须写例外原因
    const low = keys.get(kLow)!;
    let ev = await json(act(base, both, low.id, { action: 'confirm', expectedVersion: (await json(get(base, both, `/api/risk/events/${low.id}`))).version }));
    ev = await json(act(base, both, low.id, { action: 'start', expectedVersion: ev.version }));
    ev = await json(act(base, both, low.id, { action: 'submit', expectedVersion: ev.version, comment: '调整拨付计划' }));
    expect((await json(act(base, both, low.id, { action: 'approve', expectedVersion: ev.version }))).code).toBe('SELF_REVIEW_FORBIDDEN');
    ev = await json(act(base, reviewer, low.id, { action: 'return', expectedVersion: ev.version, comment: '缺少依据' }));
    expect(ev.status).toBe('rectifying');
    ev = await json(act(base, admin, low.id, { action: 'submit', expectedVersion: ev.version, comment: '补充依据' }));
    expect((await act(base, admin, low.id, { action: 'approve', expectedVersion: ev.version })).status).toBe(400);
    ev = await json(act(base, admin, low.id, { action: 'approve', expectedVersion: ev.version, exceptionReason: '单人部署' }));
    expect(ev.status).toBe('closed');
    expect(ev.actions.at(-1)).toMatchObject({ action: 'approve', exceptionReason: '单人部署' });

    // 误报:需要复核权限且说明理由;之后再命中只记次数
    const npv = (await eventsByKey(base, analyst)).get(kNpv)!;
    expect((await act(base, analyst, npv.id, { action: 'false_positive', expectedVersion: npv.version, comment: '测试样本' })).status).toBe(403);
    expect((await act(base, reviewer, npv.id, { action: 'false_positive', expectedVersion: npv.version })).status).toBe(400);
    expect((await json(act(base, reviewer, npv.id, { action: 'false_positive', expectedVersion: npv.version, comment: '测试样本' }))).status).toBe('false_positive');

    // 合同付款回落到上限内:不再命中
    db.prepare('UPDATE ct_contract SET paid_cents = 7000000 WHERE id = ?').run(ct);
    const scan3 = await json(post(base, analyst, '/api/risk/scans'));
    // PB_LOW_EXEC(已关闭)再命中 → 重开;误报 → suppressed;超支 → 更新;合同不命中且已关闭 → 不计
    expect(scan3).toMatchObject({ createdCount: 0, reopenedCount: 1, suppressedCount: 1, updatedCount: 1, clearedCount: 0 });
    const after = await eventsByKey(base, analyst);
    expect(after.get(kLow)).toMatchObject({ status: 'open' });
    expect(after.get(kNpv)).toMatchObject({ status: 'false_positive', occurrenceCount: 3 });
    expect(after.get(kCap)).toMatchObject({ status: 'closed' });
    const lowDetail = await json(get(base, analyst, `/api/risk/events/${low.id}`));
    expect(lowDetail).toMatchObject({ reopenedCount: 1, submittedByUserId: null });
    expect(lowDetail.actions.at(-1)).toMatchObject({ action: 'reopen', fromStatus: 'closed', toStatus: 'open' });

    // 规则调整:需要复核权限;阈值降到 0.05 后 PB_LOW_EXEC 不再命中 → 只标记未命中,不关闭
    const rules = await json(get(base, analyst, '/api/risk/rules'));
    const lowRule = rules.find((r: { code: string }) => r.code === 'PB_LOW_EXEC');
    expect(lowRule).toMatchObject({ threshold: '0.3', thresholdApplies: true, enabled: true });
    const patch = (s: Session, body: unknown) => fetchAs(s, `${base}/api/risk/rules/PB_LOW_EXEC`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    expect((await patch(analyst, { expectedVersion: 1, threshold: '0.05' })).status).toBe(403);
    expect((await json(patch(reviewer, { expectedVersion: 1, threshold: '0.05' }))).threshold).toBe('0.05');
    expect((await json(post(base, analyst, '/api/risk/scans'))).clearedCount).toBe(1);
    expect((await eventsByKey(base, analyst)).get(kLow)).toMatchObject({ status: 'open', lastScanHit: false });
    // 停用规则后,该规则事件不再被扫描计入
    expect((await json(patch(reviewer, { expectedVersion: 2, enabled: false }))).enabled).toBe(false);
    expect((await json(post(base, analyst, '/api/risk/scans'))).clearedCount).toBe(0);

    const summary = await json(get(base, analyst, '/api/risk/summary'));
    expect(summary).toMatchObject({ total: 4, openCount: 2, pendingConfirm: 2, byStatus: { closed: 1, false_positive: 1, open: 2 } });
  });

  it('受限用户只扫描、列出和访问范围内风险;整改台账冻结后不随风险变化', async () => {
    const { base, db, admin, fx } = await boot('newfc-t5-risk-scope-');
    const p1 = await createProject(base, admin, 'P-SH-01', '上海泵站改造', fx.orgIds.shanghai);
    const p2 = await createProject(base, admin, 'P-HZ-01', '杭州管网', fx.orgIds.hangzhou);
    seedProjectBudget(db, [
      { projectId: p1, code: 'P-SH-01', orgId: fx.orgIds.shanghai, budget: 1_000_000, executed: 100_000 },
      { projectId: p2, code: 'P-HZ-01', orgId: fx.orgIds.hangzhou, budget: 1_000_000, executed: 100_000 },
    ]);
    const sh = createScopedUser(db, { username: 'risk-sh', roleCodes: ['finance_analyst'], orgIds: [fx.orgIds.shanghai] }).session;

    const scan = await json(post(base, sh, '/api/risk/scans'));
    expect(scan).toMatchObject({ createdCount: 1, scope: { all: false } });
    let list = await json(get(base, sh, '/api/risk/events'));
    expect(list.map((e: { orgId: number }) => e.orgId)).toEqual([fx.orgIds.shanghai]);
    // 管理员全量扫描后,受限用户仍只看到本组织
    await json(post(base, admin, '/api/risk/scans'));
    const all = await json(get(base, admin, '/api/risk/events'));
    expect(all).toHaveLength(2);
    list = await json(get(base, sh, '/api/risk/events'));
    expect(list).toHaveLength(1);
    const hz = all.find((e: { orgId: number }) => e.orgId === fx.orgIds.hangzhou);
    expect((await get(base, sh, `/api/risk/events/${hz.id}`)).status).toBe(404);
    expect((await act(base, sh, hz.id, { action: 'confirm', expectedVersion: hz.version })).status).toBe(404);
    expect((await get(base, sh, `/api/risk/events?orgId=${fx.orgIds.hangzhou}`)).status).toBe(404);
    expect((await post(base, sh, '/api/risk/scans', { orgId: fx.orgIds.hangzhou })).status).toBe(404);
    // 受限扫描不会把范围外事件标记为未命中
    expect((await json(post(base, sh, '/api/risk/scans'))).updatedCount).toBe(1);
    expect((await json(get(base, admin, `/api/risk/events/${hz.id}`))).lastScanHit).toBe(true);
    // 扫描记录:受限用户看不到全组织扫描
    const scans = await json(get(base, sh, '/api/risk/scans'));
    expect(scans.every((s: { scope: { all: boolean } }) => s.scope.all === false)).toBe(true);
    expect(await json(get(base, sh, '/api/risk/summary'))).toMatchObject({ total: 1, openCount: 1, openAmount: '9000.00' });

    // 整改台账:受限用户不能生成全组织台账;按组织生成后冻结
    expect((await post(base, sh, '/api/standard-reports', { reportType: 'risk_rectification_ledger', period: '2026-06' })).status).toBe(403);
    const ledgerRes = await post(base, admin, '/api/standard-reports', { reportType: 'risk_rectification_ledger', period: '2026-06' });
    expect(ledgerRes.status).toBe(201);
    const ledger = await json(ledgerRes);
    expect(ledger.rows).toHaveLength(2);
    expect(ledger.rows[0]).toMatchObject({ status: '待确认', level: '中', overdue: '否', lastAction: '再次命中' });
    expect(ledger.sources.events).toHaveLength(2);
    const shEvent = list[0];
    await json(act(base, sh, shEvent.id, { action: 'confirm', expectedVersion: shEvent.version + 1, deadline: '2020-01-01' }));
    const ev = await json(get(base, sh, `/api/risk/events/${shEvent.id}`));
    expect(ev).toMatchObject({ status: 'confirmed', overdue: true });
    const again = await json(get(base, admin, `/api/standard-reports/${ledger.id}`));
    expect(again.rows).toEqual(ledger.rows);
    expect(again.contentSha256).toBe(ledger.contentSha256);
    const ledger2 = await json(post(base, admin, '/api/standard-reports', { reportType: 'risk_rectification_ledger', period: '2026-06', orgId: fx.orgIds.shanghai }));
    expect(ledger2.rows).toHaveLength(1);
    expect(ledger2.rows[0]).toMatchObject({ status: '已确认', overdue: '是', lastAction: '确认' });
    expect((await get(base, sh, `/api/standard-reports/${ledger.id}`)).status).toBe(404);
  });

  it('投资控制:按每个项目最新对比快照的控制链与超限科目命中', async () => {
    const { base, db, admin, fx } = await boot('newfc-t5-risk-ic-');
    const md = await createProject(base, admin, 'P-IC-01', '水库扩容', fx.orgIds.nanjing);
    const icp = Number(db.prepare("INSERT INTO ic_project (md_project_id, org_id, created_at, updated_at) VALUES (?, ?, ?, ?)").run(md, fx.orgIds.nanjing, now, now).lastInsertRowid);
    const ver = (type: string, cents: number) => Number(db.prepare(`INSERT INTO ic_version (project_id, version_type, version_no, name, status, is_current, static_cents, created_at, updated_at)
      VALUES (?, ?, 1, ?, 'confirmed', 1, ?, ?, ?)`).run(icp, type, type, cents, now, now).lastInsertRowid);
    const design = ver('design_estimate', 10_000_000); const budget = ver('construction_budget', 9_000_000); const settle = ver('settlement', 10_500_000);
    const chain = [
      { status: 'settlement_over_budget', message: '竣工结算超过施工图预算', subjectVersionId: settle, referenceVersionId: budget, subjectAmount: '105000.00', referenceAmount: '90000.00' },
      { status: 'over_redline', message: '竣工结算超过概算红线', subjectVersionId: settle, referenceVersionId: design, subjectAmount: '105000.00', referenceAmount: '100000.00' },
    ];
    const insertCmp = (summary: object, rows: object[]) => db.prepare(`INSERT INTO ic_comparison (project_id, base_version_id, target_version_id, base_content_hash, target_content_hash,
      redline_version_id, thresholds_json, rows_json, summary_json, content_sha256, created_at) VALUES (?, ?, ?, 'a', 'b', ?, '{}', ?, ?, 'sha', ?)`)
      .run(icp, design, settle, design, JSON.stringify(rows), JSON.stringify(summary), now);
    insertCmp({ controlChain: [], exceedCount: 0, totalDeviationRate: '0.000000' }, []);
    expect(computeRiskHits(db).filter((h) => h.ruleCode.startsWith('IC_'))).toEqual([]);
    insertCmp({ controlChain: chain, exceedCount: 1, totalDeviationRate: '0.050000' },
      [{ canonicalCode: '1.1', name: '建筑工程', deviation: '3000.00', deviationRate: '0.150000', alertLevel: 'exceed' }]);
    const hits = computeRiskHits(db).filter((h) => h.ruleCode.startsWith('IC_'));
    expect(hits.map(eventKeyOf).sort()).toEqual([
      `IC_CONTROL_BREAK:ic_project:${icp}:settlement_over_budget_settlement`,
      `IC_DEVIATION_EXCEED:ic_project:${icp}`,
      `IC_OVER_REDLINE:ic_project:${icp}:over_redline_settlement`,
    ]);
    const over = hits.find((h) => h.ruleCode === 'IC_OVER_REDLINE')!;
    expect(over).toMatchObject({ orgId: fx.orgIds.nanjing, projectId: md, amountCents: 500_000n, metric: '0.050000', level: 'high' });
    expect(hits.find((h) => h.ruleCode === 'IC_DEVIATION_EXCEED')).toMatchObject({ amountCents: 300_000n, level: 'medium' });
  });
});
