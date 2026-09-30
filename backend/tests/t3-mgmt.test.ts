/**
 * T-3 管理会计(AC-F14):八个子功能逐项覆盖,分摊守恒与快照一致。
 *
 * 预算:standardBudgetVersion(上海 收入100/成本60/管理费用20;杭州 收入50/成本30/销售费用10),锁定并采用。
 * 实际:2026-06-30 快照 上海收入 80、杭州收入 60。
 */
import { describe, it, expect } from 'vitest';
import type { DB } from '../src/db/connection';
import { budget, org, saveActualSnapshot, standardBudgetVersion, type Fixture } from './helpers';
import { createScopedUser, fetchAs } from './http-helpers';
import { boot, easSample, EAS_V600, get, json, post, upload, type Session } from './t3-helpers';

const put = (base: string, s: Session, url: string, body: unknown) =>
  fetchAs(s, `${base}${url}`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

function adoptBudget(fx: Fixture) {
  const v = standardBudgetVersion(fx);
  budget.lockVersion(fx.db, v.id);
  budget.setCurrentVersion(fx.db, v.id);
  return v;
}

function actuals(fx: Fixture) {
  saveActualSnapshot(fx, 2026, '2026-06-30', [
    { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '80.00' },
    { orgId: fx.orgIds.hangzhou, accountId: fx.accIds.incomeMain, amount: '60.00' },
  ]);
}

async function metric(base: string, s: Session, code: string, params: Record<string, unknown>, thresholds: Record<string, string> = {}) {
  const res = await post(base, s, '/api/mgmt/metrics', { code, name: code, params, thresholds });
  expect(res.status, await res.clone().text()).toBe(201);
  return res.json() as Promise<any>;
}

async function pool(base: string, s: Session, orgId: number, total: string, rules: [number, string][], period = '2026-06') {
  const p = await json(post(base, s, '/api/mgmt/cost-pools', { name: `池-${total}`, orgId, period, total }));
  const res = await put(base, s, `/api/mgmt/cost-pools/${p.id}/rules`, { expectedVersion: p.version, rules: rules.map(([targetOrgId, weight]) => ({ targetOrgId, weight })) });
  expect(res.status, await res.clone().text()).toBe(200);
  return res.json() as Promise<any>;
}

describe('T-3 管理会计 · 指标与计算', () => {
  it('预算/实际/执行率/EAS 余额计算器取数正确;缺来源返回不可用及原因而不是 0;全部不可用整体 409', async () => {
    const { base, db, admin, fx } = await boot();
    adoptBudget(fx);
    actuals(fx);
    const income = await metric(base, admin, 'BUDGET_INCOME', { calculator: 'budget_amount', accountCode: 'I01' });
    const cost = await metric(base, admin, 'BUDGET_COST', { calculator: 'budget_amount', accountCode: 'C' });
    const actual = await metric(base, admin, 'ACTUAL_INCOME', { calculator: 'actual_amount', accountCode: 'I01' });
    const rate = await metric(base, admin, 'EXEC_INCOME', { calculator: 'execution_rate', accountCode: 'I01' });
    const stmt = await metric(base, admin, 'STMT_ASSETS', { calculator: 'statement_item', metricKey: 'total_assets_period_end' });
    expect(rate.unit).toBe('ratio');

    const run = await post(base, admin, '/api/mgmt/calc-runs', {
      period: '2026-06', metricIds: [income.id, cost.id, actual.id, rate.id, stmt.id], orgIds: [fx.orgIds.shanghai, fx.orgIds.hangzhou, fx.orgIds.east],
    });
    expect(run.status, await run.clone().text()).toBe(201);
    const r = await run.json() as any;
    const val = (m: any, orgId: number) => r.snapshots.find((s: any) => s.metricId === m.id && s.orgId === orgId);
    expect(val(income, fx.orgIds.shanghai).value).toBe('100.00');
    expect(val(income, fx.orgIds.east).value).toBe('150.00');
    expect(val(cost, fx.orgIds.shanghai).value).toBe('60.00');
    expect(val(actual, fx.orgIds.shanghai)).toMatchObject({ value: '80.00', compareValue: '100.00', status: 'valid' });
    expect(val(rate, fx.orgIds.shanghai).value).toBe('0.800000');
    expect(val(rate, fx.orgIds.hangzhou).value).toBe('1.200000');
    expect(val(rate, fx.orgIds.east).value).toBe('0.933333');
    expect(val(income, fx.orgIds.shanghai).evidence).toMatchObject({ source: 'budget_version' });
    const missing = val(stmt, fx.orgIds.shanghai);
    expect(missing).toMatchObject({ status: 'unavailable', value: null });
    expect(missing.reasons[0].code).toBe('STATEMENT_MISSING');
    expect(r.unavailableCount).toBe(3);

    // 2025 年没有采用预算和实际:整体不可用,不落库
    const before = (db.prepare('SELECT COUNT(*) AS n FROM ma_calc_run').get() as { n: number }).n;
    const none = await post(base, admin, '/api/mgmt/calc-runs', { period: '2025-06', metricIds: [income.id, rate.id], orgIds: [fx.orgIds.shanghai] });
    expect(none.status).toBe(409);
    const body = await none.json() as any;
    expect(body.code).toBe('CALCULATOR_UNAVAILABLE');
    expect(body.details.items.map((i: any) => i.reasons[0].code)).toEqual(['BUDGET_VERSION_MISSING', 'BUDGET_VERSION_MISSING']);
    expect((db.prepare('SELECT COUNT(*) AS n FROM ma_calc_run').get() as { n: number }).n).toBe(before);

    // 快照数值不可改
    expect(() => db.prepare('UPDATE ma_metric_snapshot SET value_cents = 1').run()).toThrow(/不可修改/);
  });

  it('EAS 余额计算器读当前集合期末余额', async () => {
    const { base, db, admin } = await boot();
    const ls = org.createOrg(db, { parentId: null, code: 'LS', name: '澧水公司' }).id;
    for (const [type, file] of EAS_V600) {
      const res = await upload(base, admin, '/api/eas/import', easSample(file), file, { dataType: type });
      expect(res.status, await res.clone().text()).toBeLessThan(300);
    }
    const set = await json(post(base, admin, '/api/eas/precheck', { orgId: ls, period: '2026-05' }));
    expect((await post(base, admin, `/api/eas/sets/${set.id}/activate`, { expectedVersion: set.version, expectedCurrentSetId: null })).status).toBe(200);
    const m = await metric(base, admin, 'EAS_CIP', { calculator: 'eas_balance', accountCode: '160401', field: 'end_net' });
    const run = await json(post(base, admin, '/api/mgmt/calc-runs', { period: '2026-05', metricIds: [m.id], orgIds: [ls] }));
    expect(run.snapshots[0]).toMatchObject({ status: 'valid', value: '3000000.00' });
    expect(run.snapshots[0].evidence).toMatchObject({ source: 'eas_recon_set', setId: set.id });
  });
});

describe('T-3 管理会计 · 分摊、调整与血缘', () => {
  it('1000.00 按 3:1 → 750/250;100.00 按 1:1:1 → 33.33/33.33/33.34;确认写快照,作废后快照失效', async () => {
    const { base, db, admin, fx } = await boot();
    const p1 = await pool(base, admin, fx.orgIds.east, '1000.00', [[fx.orgIds.shanghai, '3'], [fx.orgIds.hangzhou, '1']]);
    const preview = await json(get(base, admin, `/api/mgmt/cost-pools/${p1.id}/preview`));
    expect(preview.results.map((r: any) => r.amount)).toEqual(['750.00', '250.00']);
    expect((db.prepare('SELECT COUNT(*) AS n FROM ma_alloc_run').get() as { n: number }).n).toBe(0);

    const p2 = await pool(base, admin, fx.orgIds.root, '100.00', [[fx.orgIds.shanghai, '1'], [fx.orgIds.hangzhou, '1'], [fx.orgIds.nanjing, '1']]);
    const run2 = await json(post(base, admin, `/api/mgmt/cost-pools/${p2.id}/confirm`, { expectedVersion: p2.version }));
    expect(run2.results.map((r: any) => r.amount)).toEqual(['33.33', '33.33', '33.34']);

    const stale = await post(base, admin, `/api/mgmt/cost-pools/${p1.id}/confirm`, { expectedVersion: p1.version - 1 });
    expect((await stale.json() as any).code).toBe('VERSION_CONFLICT');
    const confirmed = await post(base, admin, `/api/mgmt/cost-pools/${p1.id}/confirm`, { expectedVersion: p1.version });
    expect(confirmed.status, await confirmed.clone().text()).toBe(201);
    const run1 = await confirmed.json() as any;
    expect(run1.results.map((r: any) => r.amount)).toEqual(['750.00', '250.00']);
    const again = await post(base, admin, `/api/mgmt/cost-pools/${p1.id}/confirm`, { expectedVersion: p1.version });
    expect((await again.json() as any).code).toBe('ALLOCATION_STATE');

    const snaps = await json(get(base, admin, `/api/mgmt/snapshots?runId=${run1.calcRunId}`));
    expect(snaps.map((s: any) => [s.orgId, s.value, s.status])).toEqual([[fx.orgIds.shanghai, '750.00', 'valid'], [fx.orgIds.hangzhou, '250.00', 'valid']]);

    // 分摊成本计算器:上海 = 750 + 33.33
    const allocated = (await json(get(base, admin, '/api/mgmt/metrics'))).find((m: any) => m.code === 'ALLOCATED_COST');
    const calc = await json(post(base, admin, '/api/mgmt/calc-runs', { period: '2026-06', metricIds: [allocated.id], orgIds: [fx.orgIds.shanghai] }));
    expect(calc.snapshots[0].value).toBe('783.33');

    // 已确认时不能改规则
    const rules = await put(base, admin, `/api/mgmt/cost-pools/${p1.id}/rules`, { expectedVersion: p1.version, rules: [{ targetOrgId: fx.orgIds.shanghai, weight: '1' }] });
    expect((await rules.json() as any).code).toBe('ALLOCATION_STATE');

    const voided = await json(post(base, admin, `/api/mgmt/alloc-runs/${run1.id}/void`, { reason: '权重口径错误' }));
    expect(voided.status).toBe('voided');
    const after = await json(get(base, admin, `/api/mgmt/snapshots?runId=${run1.calcRunId}`));
    expect(after.every((s: any) => s.status === 'invalidated')).toBe(true);
    const calcAfter = await json(get(base, admin, `/api/mgmt/calc-runs/${calc.id}`));
    expect(calcAfter.snapshots[0].status).toBe('invalidated');
    expect((await post(base, admin, `/api/mgmt/alloc-runs/${run1.id}/void`, { reason: '再次' })).status).toBe(409);
    // 作废后可以改规则并重新确认
    const p1Now = await json(get(base, admin, `/api/mgmt/cost-pools/${p1.id}`));
    expect(p1Now.confirmedRunId).toBeNull();
  });

  it('调整在同一运行内转移金额:同人复核被拒,不同人批准后守恒并重写快照,血缘可追溯,不能重复复核', async () => {
    const { base, db, admin, fx } = await boot();
    const analyst = createScopedUser(db, { username: 'ma-analyst', roleCodes: ['finance_analyst'], allOrgs: true });
    const both = createScopedUser(db, { username: 'ma-both', roleCodes: ['finance_analyst', 'business_reviewer'], allOrgs: true });
    const reviewer = createScopedUser(db, { username: 'ma-rev', roleCodes: ['business_reviewer'], allOrgs: true });
    const p = await pool(base, analyst.session, fx.orgIds.east, '1000.00', [[fx.orgIds.shanghai, '3'], [fx.orgIds.hangzhou, '1']]);
    const run = await json(post(base, analyst.session, `/api/mgmt/cost-pools/${p.id}/confirm`, { expectedVersion: p.version }));
    const [sh, hz] = run.results;

    const tooMuch = await post(base, both.session, `/api/mgmt/alloc-runs/${run.id}/adjustments`, { fromResultId: hz.id, toResultId: sh.id, amount: '250.01', reason: '超额' });
    expect(tooMuch.status).toBe(400);
    const sub = await post(base, both.session, `/api/mgmt/alloc-runs/${run.id}/adjustments`, { fromResultId: sh.id, toResultId: hz.id, amount: '50.00', reason: '杭州实际占用更多' });
    expect(sub.status, await sub.clone().text()).toBe(201);
    const adj = await sub.json() as any;
    expect((await post(base, analyst.session, `/api/mgmt/alloc-adjustments/${adj.id}/review`, { action: 'approve' })).status).toBe(403);
    const self = await post(base, both.session, `/api/mgmt/alloc-adjustments/${adj.id}/review`, { action: 'approve' });
    expect((await self.json() as any).code).toBe('SELF_REVIEW_FORBIDDEN');

    const ok = await post(base, reviewer.session, `/api/mgmt/alloc-adjustments/${adj.id}/review`, { action: 'approve', comment: '同意' });
    expect(ok.status, await ok.clone().text()).toBe(200);
    const runAfter = await json(get(base, admin, `/api/mgmt/alloc-runs/${run.id}`));
    expect(runAfter.results.map((r: any) => [r.baseAmount, r.amount])).toEqual([['750.00', '700.00'], ['250.00', '300.00']]);
    const snaps = await json(get(base, admin, `/api/mgmt/snapshots?runId=${run.calcRunId}`));
    expect(snaps.filter((s: any) => s.status === 'valid').map((s: any) => s.value).sort()).toEqual(['300.00', '700.00']);
    expect(snaps.filter((s: any) => s.status === 'invalidated')).toHaveLength(2);

    const lin = await json(get(base, admin, `/api/mgmt/alloc-runs/${run.id}/lineage`));
    expect(lin.chain.map((c: any) => c.kind)).toEqual(['pool', 'rule', 'rule', 'run', 'result', 'result', 'adjustment', 'snapshot', 'snapshot', 'snapshot', 'snapshot']);
    expect(lin.chain.filter((c: any) => c.kind === 'snapshot' && c.parent === `adjustment:${adj.id}`)).toHaveLength(2);

    const twice = await post(base, reviewer.session, `/api/mgmt/alloc-adjustments/${adj.id}/review`, { action: 'reject' });
    expect((await twice.json() as any).code).toBe('MGMT_ALREADY_REVIEWED');
    // 管理员同人复核必须写例外原因
    const adj2 = await json(post(base, admin, `/api/mgmt/alloc-runs/${run.id}/adjustments`, { fromResultId: hz.id, toResultId: sh.id, amount: '0.01', reason: '尾差' }));
    expect((await post(base, admin, `/api/mgmt/alloc-adjustments/${adj2.id}/review`, { action: 'approve' })).status).toBe(400);
    const adminOk = await json(post(base, admin, `/api/mgmt/alloc-adjustments/${adj2.id}/review`, { action: 'approve', exceptionReason: '单人值守' }));
    expect(adminOk).toMatchObject({ status: 'approved', selfReview: true });

    const audit = db.prepare("SELECT action, detail_json FROM operation_log WHERE action LIKE 'mgmt.adjustment.%' AND result = 'success' ORDER BY id").all() as { action: string; detail_json: string }[];
    expect(audit.map((r) => r.action)).toEqual(['mgmt.adjustment.submit', 'mgmt.adjustment.review', 'mgmt.adjustment.submit', 'mgmt.adjustment.review']);
    expect(audit[3].detail_json).toContain('单人值守');
  });
});

describe('T-3 管理会计 · 预算调整', () => {
  it('提交 → 复核 → 生效:复制新版本、改一格、锁定并采用;原版本不变;同人复核被拒', async () => {
    const { base, db, fx } = await boot();
    const v = adoptBudget(fx);
    const analyst = createScopedUser(db, { username: 'ba-analyst', roleCodes: ['finance_analyst'], orgIds: [fx.orgIds.shanghai] });
    const reviewer = createScopedUser(db, { username: 'ba-rev', roleCodes: ['business_reviewer'], allOrgs: true });
    const scopedReviewer = createScopedUser(db, { username: 'ba-rev2', roleCodes: ['business_reviewer'], orgIds: [fx.orgIds.shanghai] });
    const out = await post(base, analyst.session, '/api/mgmt/budget-adjustments', { versionId: v.id, orgId: fx.orgIds.hangzhou, accountId: fx.accIds.costSub, amount: '35.00', reason: '越权' });
    expect(out.status).toBe(404);
    const sub = await post(base, analyst.session, '/api/mgmt/budget-adjustments', { versionId: v.id, orgId: fx.orgIds.shanghai, accountId: fx.accIds.costSub, amount: '65.00', reason: '材料涨价' });
    expect(sub.status, await sub.clone().text()).toBe(201);
    const adj = await sub.json() as any;
    expect(adj).toMatchObject({ beforeAmount: '60.00', afterAmount: '65.00', status: 'pending' });
    const dup = await post(base, analyst.session, '/api/mgmt/budget-adjustments', { versionId: v.id, orgId: fx.orgIds.shanghai, accountId: fx.accIds.costSub, amount: '66.00', reason: '重复' });
    expect((await dup.json() as any).code).toBe('MGMT_ADJUSTMENT_PENDING');

    expect((await post(base, analyst.session, `/api/mgmt/budget-adjustments/${adj.id}/review`, { action: 'approve' })).status).toBe(403);
    const scoped = await post(base, scopedReviewer.session, `/api/mgmt/budget-adjustments/${adj.id}/review`, { action: 'approve' });
    expect((await scoped.json() as any).code).toBe('SCOPE_RESTRICTED');
    const ok = await post(base, reviewer.session, `/api/mgmt/budget-adjustments/${adj.id}/review`, { action: 'approve' });
    expect(ok.status, await ok.clone().text()).toBe(200);
    const done = await ok.json() as any;
    expect(done.status).toBe('effective');
    const nv = budget.getVersion(db, done.newVersionId);
    expect(nv).toMatchObject({ status: 'locked', is_current: 1, source_version_id: v.id });
    expect(budget.getVersion(db, v.id)).toMatchObject({ status: 'locked', is_current: 0 });
    const cell = (vid: number) => (db.prepare('SELECT amount_cents FROM budget_entry WHERE version_id = ? AND org_id = ? AND account_id = ?').get(vid, fx.orgIds.shanghai, fx.accIds.costSub) as { amount_cents: number }).amount_cents;
    expect(cell(v.id)).toBe(-6000);
    expect(cell(nv.id)).toBe(-6500);
    const others = (vid: number) => db.prepare('SELECT org_id, account_id, amount_cents FROM budget_entry WHERE version_id = ? AND NOT (org_id = ? AND account_id = ?) ORDER BY org_id, account_id').all(vid, fx.orgIds.shanghai, fx.accIds.costSub);
    expect(others(nv.id)).toEqual(others(v.id));

    // 源版本已不是当前版本:旧版本上的调整不能再提交
    const old = await post(base, analyst.session, '/api/mgmt/budget-adjustments', { versionId: v.id, orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '120.00', reason: '旧版本' });
    expect((await old.json() as any).code).toBe('BUDGET_VERSION_NOT_CURRENT');
  });
});

describe('T-3 管理会计 · 预警、维度、多维分析、责任中心、绩效', () => {
  it('预警按阈值生成,重复扫描只更新不重复;确认 → 关闭;关闭后再触发新建', async () => {
    const { base, db, admin, fx } = await boot();
    adoptBudget(fx);
    actuals(fx);
    const m = await metric(base, admin, 'ACT_INC', { calculator: 'actual_amount', accountCode: 'I01' }, { upperWarning: '70.00', upperCritical: '100.00', deviationWarning: '0.1' });
    const run1 = await json(post(base, admin, '/api/mgmt/calc-runs', { period: '2026-06', metricIds: [m.id], orgIds: [fx.orgIds.shanghai, fx.orgIds.hangzhou] }));
    const scan1 = await json(post(base, admin, '/api/mgmt/alerts/scan', { runId: run1.id }));
    // 上海 80:超上限警告 + 偏差 -20%;杭州 60:偏差 +20%
    expect(scan1).toMatchObject({ created: 3, updated: 0, evaluated: 2 });
    expect(await json(post(base, admin, '/api/mgmt/alerts/scan', { runId: run1.id }))).toMatchObject({ created: 0, unchanged: 3 });
    const run2 = await json(post(base, admin, '/api/mgmt/calc-runs', { period: '2026-06', metricIds: [m.id], orgIds: [fx.orgIds.shanghai] }));
    expect(await json(post(base, admin, '/api/mgmt/alerts/scan', { runId: run2.id }))).toMatchObject({ created: 0, updated: 2 });
    const alerts = await json(get(base, admin, `/api/mgmt/alerts?orgId=${fx.orgIds.shanghai}`));
    expect(alerts).toHaveLength(2);
    const upper = alerts.find((a: any) => a.alertType === 'upper');
    expect(upper).toMatchObject({ level: 'warning', value: '80.00', hitCount: 2 });
    expect(alerts.find((a: any) => a.alertType === 'deviation').value).toBe('-0.200000');

    expect((await json(post(base, admin, `/api/mgmt/alerts/${upper.id}/close`, { expectedVersion: upper.version }))).code).toBe('ALERT_STATE');
    const acked = await json(post(base, admin, `/api/mgmt/alerts/${upper.id}/acknowledge`, { expectedVersion: upper.version, causeCategory: 'business_change', note: '新增客户' }));
    expect(acked.status).toBe('acknowledged');
    const closed = await json(post(base, admin, `/api/mgmt/alerts/${upper.id}/close`, { expectedVersion: acked.version }));
    expect(closed.status).toBe('closed');
    const run3 = await json(post(base, admin, '/api/mgmt/calc-runs', { period: '2026-06', metricIds: [m.id], orgIds: [fx.orgIds.shanghai] }));
    expect(await json(post(base, admin, '/api/mgmt/alerts/scan', { runId: run3.id }))).toMatchObject({ created: 1, updated: 1 });
    expect((db.prepare("SELECT COUNT(*) AS n FROM ma_alert WHERE org_id = ? AND alert_type = 'upper'").get(fx.orgIds.shanghai) as { n: number }).n).toBe(2);
  });

  it('维度成员先预览后确认;引用必须存在且在范围内;按维度成员做多维分析;责任中心汇总', async () => {
    const { base, db, admin, fx } = await boot();
    adoptBudget(fx);
    actuals(fx);
    const d = await json(post(base, admin, '/api/mgmt/dimensions', { code: 'region', name: '区域', memberType: 'org' }));
    const members = { members: [{ code: 'SH', refCode: 'SH' }, { code: 'HZ', name: '杭州', refCode: 'HZ' }, { code: 'XX', refCode: 'NOPE' }] };
    const pv = await json(post(base, admin, `/api/mgmt/dimensions/${d.id}/members/preview`, members));
    expect(pv).toMatchObject({ valid: false, createCount: 2, errorCount: 1 });
    const bad = await post(base, admin, `/api/mgmt/dimensions/${d.id}/members/confirm`, { ...members, previewHash: pv.previewHash });
    expect(bad.status).toBe(400);
    const good = { members: members.members.slice(0, 2) };
    const pv2 = await json(post(base, admin, `/api/mgmt/dimensions/${d.id}/members/preview`, good));
    expect((await json(post(base, admin, `/api/mgmt/dimensions/${d.id}/members/confirm`, { ...good, previewHash: 'f'.repeat(64) }))).code).toBe('PREVIEW_STALE');
    const conf = await json(post(base, admin, `/api/mgmt/dimensions/${d.id}/members/confirm`, { ...good, previewHash: pv2.previewHash }));
    expect(conf.created).toBe(2);
    expect(conf.members.map((m: any) => [m.code, m.name, m.orgId])).toEqual([['HZ', '杭州', fx.orgIds.hangzhou], ['SH', '上海公司', fx.orgIds.shanghai]]);

    // 受限用户引用范围外组织 → 预览报错
    const shUser = createScopedUser(db, { username: 'ma-sh', roleCodes: ['finance_analyst'], orgIds: [fx.orgIds.shanghai] });
    const out = await json(post(base, shUser.session, `/api/mgmt/dimensions/${d.id}/members/preview`, { members: [{ code: 'NJ', refCode: 'NJ' }] }));
    expect(out.rows[0]).toMatchObject({ action: 'error' });

    const m = await metric(base, admin, 'ACT_INC', { calculator: 'actual_amount', accountCode: 'I01' });
    const run = await json(post(base, admin, '/api/mgmt/calc-runs', { period: '2026-06', metricIds: [m.id], orgIds: [fx.orgIds.shanghai, fx.orgIds.hangzhou] }));
    const an = await json(get(base, admin, `/api/mgmt/analysis?metricIds=${m.id}&periods=2026-06&groupBy=dimension&dimensionId=${d.id}`));
    expect(an.rows.map((r: any) => [r.groupKey, r.value, r.runId])).toEqual([['HZ', '60.00', run.id], ['SH', '80.00', run.id]]);
    const shOnly = await json(get(base, shUser.session, `/api/mgmt/analysis?metricIds=${m.id}&periods=2026-06`));
    expect(shOnly.rows.map((r: any) => r.orgId)).toEqual([fx.orgIds.shanghai]);

    const centers = await json(get(base, shUser.session, '/api/mgmt/centers?period=2026-06'));
    expect(centers).toHaveLength(1);
    expect(centers[0]).toMatchObject({ orgId: fx.orgIds.shanghai, allocatedCost: '0.00' });
    expect(centers[0].snapshots[0].value).toBe('80.00');
  });

  it('绩效:权重合计为 1;评分保存明细;复核调整保留原分和原因;评分人不能自审', async () => {
    const { base, db, admin, fx } = await boot();
    adoptBudget(fx);
    actuals(fx);
    const analyst = createScopedUser(db, { username: 'pf-analyst', roleCodes: ['finance_analyst', 'business_reviewer'], allOrgs: true });
    const reviewer = createScopedUser(db, { username: 'pf-rev', roleCodes: ['business_reviewer'], allOrgs: true });
    const inc = await metric(base, admin, 'ACT_INC', { calculator: 'actual_amount', accountCode: 'I01' });
    const rate = await metric(base, admin, 'EXEC_INC', { calculator: 'execution_rate', accountCode: 'I01' });
    const badWeights = await post(base, admin, '/api/mgmt/perf-schemes', { code: 'P1', name: '经营', items: [
      { metricId: inc.id, weight: '0.5', target: '100.00', direction: 'higher_better' }, { metricId: rate.id, weight: '0.4', target: '1', direction: 'higher_better' }] });
    expect(badWeights.status).toBe(400);
    const scheme = await json(post(base, admin, '/api/mgmt/perf-schemes', { code: 'P1', name: '经营', items: [
      { metricId: inc.id, weight: '0.6', target: '100.00', direction: 'higher_better' }, { metricId: rate.id, weight: '0.4', target: '1', direction: 'higher_better' }] }));
    const run = await json(post(base, admin, '/api/mgmt/calc-runs', { period: '2026-06', metricIds: [inc.id, rate.id], orgIds: [fx.orgIds.shanghai, fx.orgIds.hangzhou] }));
    const res = await post(base, analyst.session, `/api/mgmt/perf-schemes/${scheme.id}/score`, { runId: run.id });
    expect(res.status, await res.clone().text()).toBe(201);
    const { scores } = await res.json() as any;
    const sh = scores.find((s: any) => s.orgId === fx.orgIds.shanghai);
    const hz = scores.find((s: any) => s.orgId === fx.orgIds.hangzhou);
    // 上海:80/100=0.8 → 48.00;执行率 0.8 → 32.00;合计 80.00。杭州:60/100 → 36.00;1.2 → 48.00;合计 84.00
    expect(sh.details.map((d: any) => d.itemScore)).toEqual(['48.00', '32.00']);
    expect(sh.score).toBe('80.00');
    expect(hz.score).toBe('84.00');

    const self = await post(base, analyst.session, `/api/mgmt/perf-scores/${sh.id}/review`, { action: 'confirm' });
    expect((await self.json() as any).code).toBe('SELF_REVIEW_FORBIDDEN');
    expect((await post(base, reviewer.session, `/api/mgmt/perf-scores/${sh.id}/review`, { action: 'adjust', adjustedScore: '85' })).status).toBe(400);
    const adj = await json(post(base, reviewer.session, `/api/mgmt/perf-scores/${sh.id}/review`, { action: 'adjust', adjustedScore: '85', reason: '一次性大客户流失不计入' }));
    expect(adj).toMatchObject({ score: '80.00', adjustedScore: '85.00', finalScore: '85.00', adjustReason: '一次性大客户流失不计入', status: 'reviewed' });
    expect((await json(post(base, reviewer.session, `/api/mgmt/perf-scores/${sh.id}/review`, { action: 'confirm' }))).code).toBe('MGMT_ALREADY_REVIEWED');
    expect(() => db.prepare('UPDATE ma_perf_score SET score_scaled = 1').run()).toThrow(/不可修改/);
  });
});

describe('T-3 管理会计 · 越权', () => {
  it('受限用户读写范围外组织的成本池、运行、快照、预警返回 404;全局口径写入返回 SCOPE_RESTRICTED;只读角色不能写', async () => {
    const { base, db, admin, fx } = await boot();
    adoptBudget(fx);
    actuals(fx);
    const shUser = createScopedUser(db, { username: 'ma-sh', roleCodes: ['finance_analyst'], orgIds: [fx.orgIds.shanghai] });
    const viewer = createScopedUser(db, { username: 'ma-view', roleCodes: ['viewer'], allOrgs: true });
    const hzPool = await pool(base, admin, fx.orgIds.hangzhou, '100.00', [[fx.orgIds.hangzhou, '1']]);
    const run = await json(post(base, admin, `/api/mgmt/cost-pools/${hzPool.id}/confirm`, { expectedVersion: hzPool.version }));
    expect((await get(base, shUser.session, `/api/mgmt/cost-pools/${hzPool.id}`)).status).toBe(404);
    expect((await get(base, shUser.session, `/api/mgmt/alloc-runs/${run.id}`)).status).toBe(404);
    expect((await get(base, shUser.session, `/api/mgmt/alloc-runs/${run.id}/lineage`)).status).toBe(404);
    expect((await post(base, shUser.session, `/api/mgmt/alloc-runs/${run.id}/void`, { reason: 'x' })).status).toBe(404);
    expect(await json(get(base, shUser.session, '/api/mgmt/cost-pools'))).toEqual([]);
    expect((await post(base, shUser.session, '/api/mgmt/cost-pools', { name: 'x', orgId: fx.orgIds.hangzhou, period: '2026-06', total: '1.00' })).status).toBe(404);
    const own = await json(post(base, shUser.session, '/api/mgmt/cost-pools', { name: 'x', orgId: fx.orgIds.shanghai, period: '2026-06', total: '1.00' }));
    const res = await put(base, shUser.session, `/api/mgmt/cost-pools/${own.id}/rules`, { expectedVersion: own.version, rules: [{ targetOrgId: fx.orgIds.hangzhou, weight: '1' }] });
    expect(res.status).toBe(404);

    const m = await metric(base, admin, 'ACT_INC', { calculator: 'actual_amount', accountCode: 'I01' }, { upperWarning: '10.00' });
    const hzRun = await json(post(base, admin, '/api/mgmt/calc-runs', { period: '2026-06', metricIds: [m.id], orgIds: [fx.orgIds.hangzhou] }));
    await json(post(base, admin, '/api/mgmt/alerts/scan', { runId: hzRun.id }));
    expect((await get(base, shUser.session, `/api/mgmt/calc-runs/${hzRun.id}`)).status).toBe(404);
    expect((await post(base, shUser.session, '/api/mgmt/calc-runs', { period: '2026-06', metricIds: [m.id], orgIds: [fx.orgIds.hangzhou] })).status).toBe(404);
    expect(await json(get(base, shUser.session, '/api/mgmt/alerts'))).toEqual([]);
    const hzAlert = (await json(get(base, admin, '/api/mgmt/alerts')))[0];
    expect((await get(base, shUser.session, `/api/mgmt/alerts/${hzAlert.id}`)).status).toBe(404);
    expect(await json(get(base, shUser.session, `/api/mgmt/snapshots?runId=${hzRun.id}`))).toEqual([]);

    const global = await post(base, shUser.session, '/api/mgmt/metrics', { code: 'X', name: 'x', params: { calculator: 'allocated_cost' } });
    expect((await global.json() as any).code).toBe('SCOPE_RESTRICTED');
    expect((await post(base, viewer.session, '/api/mgmt/cost-pools', { name: 'x', orgId: fx.orgIds.shanghai, period: '2026-06', total: '1.00' })).status).toBe(403);
    expect((await get(base, viewer.session, '/api/mgmt/cost-pools')).status).toBe(200);
  });
});
