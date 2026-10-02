import { describe, expect, it, vi } from 'vitest';
import fs from 'fs';
import path from 'path';
import { boot, get, json, post, type Session } from './t3-helpers';
import { createScopedUser, fetchAs } from './http-helpers';
import * as narrative from '../src/assistant/narrative';

/**
 * T-7 投资可行性补齐 lishui(AC-F12):基准方案(每项目一个)、方案软删除(有报告不可删)、
 * 可行性报告:基于成功且参数一致的基准运行生成(模板,敏感性摘要),草稿 → 提交复核 → 退回/通过,提交人 ≠ 复核人,通过后冻结;范围外 404。
 */

const sample = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'investment_feasibility_yichongqiao.json'), 'utf8'));
const BASE = '/api/investment/feasibility';

const patch = (base: string, s: Session, url: string, body: unknown) =>
  fetchAs(s, `${base}${url}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const del = (base: string, s: Session, url: string) => fetchAs(s, `${base}${url}`, { method: 'DELETE' });
async function ok(res: Response | Promise<Response>, status = 200) {
  const r = await res;
  const body = await json(r);
  expect(r.status, JSON.stringify(body).slice(0, 2000)).toBe(status);
  return body;
}
async function fail(res: Response | Promise<Response>, status: number, code?: string) {
  const r = await res;
  const body = await json(r);
  if (code) expect([r.status, body.code], JSON.stringify(body).slice(0, 2000)).toEqual([status, code]);
  else expect(r.status, JSON.stringify(body).slice(0, 2000)).toBe(status);
}
async function waitJob(base: string, s: Session, jobId: number) {
  for (let i = 0; i < 400; i += 1) {
    const job = await json(get(base, s, `/api/jobs/${jobId}`));
    if (['succeeded', 'failed', 'cancelled'].includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('job timeout');
}

describe('T-7 投资可行性:基准方案、删除方案、报告复核', () => {
  it('报告生成期间参数变化时拒绝落库,不留下过期草稿', async () => {
    const { base, db, admin, fx } = await boot('newfc-feas-report-race-');
    const project = await ok(post(base, admin, `${BASE}/projects`, {
      code: 'RACE', name: '报告并发样本', orgId: fx.orgIds.shanghai, constructionStartYear: 2026, operationStartYear: 2028, horizonYears: 30,
    }), 201);
    const scenario = await ok(post(base, admin, `${BASE}/projects/${project.id}/scenarios`, { code: 'A', name: '基准', assumptions: sample.assumptions }), 201);
    await ok(post(base, admin, `${BASE}/scenarios/${scenario.id}/run`, { expectedVersion: scenario.version }), 201);
    const rewrite = vi.spyOn(narrative, 'rewriteTemplateNarrative').mockImplementationOnce(async (input) => {
      const changed = structuredClone(sample.assumptions); changed.evaluation.min_dscr = '1.5';
      await ok(patch(base, admin, `${BASE}/scenarios/${scenario.id}`, { expectedVersion: scenario.version, assumptions: changed }));
      return { text: input.template, source: 'template', model: 'template', promptVersion: input.promptVersion, cached: false };
    });
    try {
      await fail(post(base, admin, `${BASE}/scenarios/${scenario.id}/reports`, {}), 409, 'FEAS_REPORT_STALE');
      expect(rewrite).toHaveBeenCalledOnce();
      expect((db.prepare('SELECT COUNT(*) AS n FROM if_report').get() as { n: number }).n).toBe(0);
    } finally { rewrite.mockRestore(); }
  });

  it('完整流程与权限、范围', async () => {
    const { base, db, admin, fx } = await boot('newfc-t7-feas-');
    const analyst = createScopedUser(db, { username: 'feas7-analyst', roleCodes: ['finance_analyst'], orgIds: [fx.orgIds.east] }).session;
    const reviewer = createScopedUser(db, { username: 'feas7-reviewer', roleCodes: ['business_reviewer'], orgIds: [fx.orgIds.east] }).session;
    const project = await ok(post(base, analyst, `${BASE}/projects`, {
      code: 'REG-T7-001', name: '脱敏水库项目', orgId: fx.orgIds.shanghai, constructionStartYear: 2026, operationStartYear: 2028, horizonYears: 30,
    }), 201);
    const a = await ok(post(base, analyst, `${BASE}/projects/${project.id}/scenarios`, { code: 'A', name: '方案甲', assumptions: sample.assumptions }), 201);
    let b = await ok(post(base, analyst, `${BASE}/projects/${project.id}/scenarios`, { code: 'B', name: '方案乙', assumptions: sample.assumptions }), 201);
    expect([a.isBaseline, b.isBaseline, b.reportCount]).toEqual([false, false, 0]);

    // 基准方案:每项目一个,切换时原基准取消;需维护权限、期望版本
    const a1 = await ok(post(base, analyst, `${BASE}/scenarios/${a.id}/baseline`, { expectedVersion: a.version }));
    expect(a1.isBaseline).toBe(true);
    await fail(post(base, reviewer, `${BASE}/scenarios/${b.id}/baseline`, { expectedVersion: b.version }), 403);
    await fail(post(base, analyst, `${BASE}/scenarios/${a.id}/baseline`, { expectedVersion: a.version }), 409, 'VERSION_CONFLICT');
    b = await ok(post(base, analyst, `${BASE}/scenarios/${b.id}/baseline`, { expectedVersion: b.version }));
    const proj = await ok(get(base, analyst, `${BASE}/projects/${project.id}`));
    expect(proj.scenarios.map((s: { code: string; isBaseline: boolean }) => [s.code, s.isBaseline])).toEqual([['B', true], ['A', false]]);
    expect(() => db.prepare('UPDATE if_scenario SET is_baseline = 1 WHERE id = ?').run(a.id)).toThrow(/UNIQUE/);

    // 报告:须先有成功且参数一致的基准运行
    await fail(post(base, analyst, `${BASE}/scenarios/${b.id}/reports`, {}), 409, 'FEAS_STATE');
    await ok(post(base, analyst, `${BASE}/scenarios/${b.id}/run`, { expectedVersion: b.version }), 201);
    const job = await ok(post(base, analyst, `${BASE}/scenarios/${b.id}/sensitivity`, {
      expectedVersion: b.version, variables: [{ code: 'electricity_price', mode: 'relative', changes: ['-0.1', '0.1'] }],
    }), 202);
    expect((await waitJob(base, analyst, job.jobId)).status).toBe('succeeded');
    const r1 = await ok(post(base, analyst, `${BASE}/scenarios/${b.id}/reports`, {}), 201);
    expect(r1).toMatchObject({
      scenarioId: b.id, projectCode: 'REG-T7-001', title: '脱敏水库项目-方案乙投资可行性分析报告', status: 'draft', source: 'template',
      promptVersion: 'feasibility-report.v1', stale: false, submittedBy: null,
    });
    expect(r1.content).toContain('- 方案:B 方案乙(基准方案)');
    expect(r1.content).toContain('## 三、主要指标');
    expect(r1.content).toMatch(/- 项目净现值:-?[\d.]+ 万元/);
    expect(r1.content).toMatch(/- 电价 -10%:项目净现值(减少|增加) [\d.]+ 万元/);
    expect(r1.content).toContain('本报告由冻结测算结果确定性生成');

    // 提交 → 退回(须写意见)→ 重新提交 → 通过;提交人 ≠ 复核人
    await fail(post(base, reviewer, `${BASE}/reports/${r1.id}/submit`, { expectedVersion: r1.version }), 403);
    const s1 = await ok(post(base, analyst, `${BASE}/reports/${r1.id}/submit`, { expectedVersion: r1.version }));
    expect(s1).toMatchObject({ status: 'pending_review', submittedBy: 'feas7-analyst' });
    // 同名与改名均不能影响服务端按账号ID判定本人提交。
    db.prepare('UPDATE app_user SET display_name = ? WHERE username IN (?, ?)').run('同名人员', 'feas7-analyst', 'feas7-reviewer');
    expect((await ok(get(base, analyst, `${BASE}/reports/${r1.id}`))).submittedByCurrentUser).toBe(true);
    expect((await ok(get(base, reviewer, `${BASE}/reports/${r1.id}`))).submittedByCurrentUser).toBe(false);
    db.prepare('UPDATE app_user SET display_name = ? WHERE username = ?').run('改名编制人', 'feas7-analyst');
    expect((await ok(get(base, analyst, `${BASE}/reports/${r1.id}`))).submittedByCurrentUser).toBe(true);
    db.prepare('UPDATE app_user SET display_name = username WHERE username IN (?, ?)').run('feas7-analyst', 'feas7-reviewer');

    const todo = async (s: Session) => (await ok(get(base, s, '/api/dashboard/todos'))).items.find((i: { key: string }) => i.key === 'feasibility_review');
    expect(await todo(reviewer)).toMatchObject({ count: 1, path: '/feasibility?tab=reports&status=pending_review' });
    const otherOrg = createScopedUser(db, { username: 'feas-queue-hz', roleCodes: ['business_reviewer'], orgIds: [fx.orgIds.hangzhou] }).session;
    expect((await todo(otherOrg)).count).toBe(0);
    expect(await todo(analyst)).toBeUndefined();
    await fail(post(base, analyst, `${BASE}/reports/${r1.id}/submit`, { expectedVersion: s1.version }), 409, 'FEAS_REPORT_STATE');
    await fail(post(base, analyst, `${BASE}/reports/${r1.id}/review`, { expectedVersion: s1.version, decision: 'approve' }), 403);
    await fail(post(base, reviewer, `${BASE}/reports/${r1.id}/review`, { expectedVersion: s1.version, decision: 'return' }), 400);
    const ret = await ok(post(base, reviewer, `${BASE}/reports/${r1.id}/review`, { expectedVersion: s1.version, decision: 'return', comment: '补充敏感性说明' }));
    expect(ret).toMatchObject({ status: 'returned', reviewer: 'feas7-reviewer', reviewComment: '补充敏感性说明' });
    const s2 = await ok(post(base, analyst, `${BASE}/reports/${r1.id}/submit`, { expectedVersion: ret.version }));
    expect(s2).toMatchObject({ status: 'pending_review', reviewer: null, reviewComment: null });
    const ap = await ok(post(base, reviewer, `${BASE}/reports/${r1.id}/review`, { expectedVersion: s2.version, decision: 'approve', comment: '同意' }));
    expect(ap).toMatchObject({ status: 'approved', selfReview: false });
    expect((await todo(reviewer)).count).toBe(0);
    await fail(post(base, analyst, `${BASE}/reports/${r1.id}/submit`, { expectedVersion: ap.version }), 409, 'FEAS_REPORT_STATE');
    expect(() => db.prepare("UPDATE if_report SET title = 'x' WHERE id = ?").run(r1.id)).toThrow(/复核通过/);
    expect(() => db.prepare('DELETE FROM if_report').run()).toThrow(/不可删除/);

    // 管理员同人复核须写例外原因
    const r2 = await ok(post(base, admin, `${BASE}/scenarios/${b.id}/reports`, { title: '管理员稿' }), 201);
    expect(() => db.prepare("UPDATE if_report SET content = 'x' WHERE id = ?").run(r2.id)).toThrow(/不可修改/);
    const s3 = await ok(post(base, admin, `${BASE}/reports/${r2.id}/submit`, { expectedVersion: r2.version }));
    await fail(post(base, admin, `${BASE}/reports/${r2.id}/review`, { expectedVersion: s3.version, decision: 'approve' }), 400);
    const self = await ok(post(base, admin, `${BASE}/reports/${r2.id}/review`, { expectedVersion: s3.version, decision: 'approve', exceptionReason: '单人值守' }));
    expect(self).toMatchObject({ selfReview: true, exceptionReason: '单人值守' });

    // 列表筛选;方案参数修改后报告标记依据过期
    expect((await ok(get(base, analyst, `${BASE}/reports?scenarioId=${b.id}`))).items.map((r: { id: number }) => r.id)).toEqual([r2.id, r1.id]);
    expect((await ok(get(base, analyst, `${BASE}/reports?status=pending_review`))).items).toEqual([]);
    const draft = await ok(post(base, analyst, `${BASE}/scenarios/${b.id}/reports`, {}), 201);
    const pending = await ok(post(base, analyst, `${BASE}/scenarios/${b.id}/reports`, {}), 201);
    const submitted = await ok(post(base, analyst, `${BASE}/reports/${pending.id}/submit`, { expectedVersion: pending.version }));
    const changed = structuredClone(sample.assumptions);
    changed.evaluation.min_dscr = '1.5';
    const cur = await ok(get(base, analyst, `${BASE}/scenarios/${b.id}`));
    await ok(patch(base, analyst, `${BASE}/scenarios/${b.id}`, { expectedVersion: cur.version, assumptions: changed }));
    expect((await ok(get(base, analyst, `${BASE}/reports/${r1.id}`))).stale).toBe(true);
    await fail(post(base, analyst, `${BASE}/scenarios/${b.id}/reports`, {}), 409, 'FEAS_STATE');
    await fail(post(base, analyst, `${BASE}/reports/${draft.id}/submit`, { expectedVersion: draft.version }), 409, 'FEAS_REPORT_STALE');
    await fail(post(base, reviewer, `${BASE}/reports/${pending.id}/review`, { expectedVersion: submitted.version, decision: 'approve' }), 409, 'FEAS_REPORT_STALE');
    expect((await ok(get(base, analyst, `${BASE}/reports/${pending.id}`))).version).toBe(submitted.version);
    const returned = await ok(post(base, reviewer, `${BASE}/reports/${pending.id}/review`, { expectedVersion: submitted.version, decision: 'return', comment: '依据过期,重新生成' }));
    await fail(post(base, analyst, `${BASE}/reports/${pending.id}/submit`, { expectedVersion: returned.version }), 409, 'FEAS_REPORT_STALE');
    expect((await ok(get(base, analyst, `${BASE}/reports/${draft.id}`))).status).toBe('draft');

    // 删除:有报告的方案不能删;删除后 404、编码仍占用、不可物理删除
    const bNow = await ok(get(base, analyst, `${BASE}/scenarios/${b.id}`));
    expect(bNow.reportCount).toBe(4);
    await fail(del(base, analyst, `${BASE}/scenarios/${b.id}?expectedVersion=${bNow.version}`), 409, 'FEAS_SCENARIO_HAS_REPORTS');
    const aNow = await ok(get(base, analyst, `${BASE}/scenarios/${a.id}`));
    await fail(del(base, analyst, `${BASE}/scenarios/${a.id}?expectedVersion=${aNow.version + 1}`), 409, 'VERSION_CONFLICT');
    expect((await del(base, analyst, `${BASE}/scenarios/${a.id}?expectedVersion=${aNow.version}`)).status).toBe(204);
    await fail(get(base, analyst, `${BASE}/scenarios/${a.id}`), 404);
    const after = await ok(get(base, analyst, `${BASE}/projects/${project.id}`));
    expect([after.scenarioCount, after.scenarios.map((s: { code: string }) => s.code)]).toEqual([1, ['B']]);
    await fail(post(base, analyst, `${BASE}/projects/${project.id}/scenarios`, { code: 'A', name: '重建', assumptions: sample.assumptions }), 409, 'DUPLICATE');
    expect(() => db.prepare('DELETE FROM if_scenario WHERE id = ?').run(a.id)).toThrow(/软删除/);

    // 范围外:列表为空,单个 404
    const hz = createScopedUser(db, { username: 'feas7-hz', roleCodes: ['business_reviewer'], orgIds: [fx.orgIds.hangzhou] }).session;
    expect((await ok(get(base, hz, `${BASE}/reports`))).items).toEqual([]);
    await fail(get(base, hz, `${BASE}/reports/${r1.id}`), 404);
    await fail(post(base, hz, `${BASE}/reports/${r2.id}/review`, { expectedVersion: 1, decision: 'approve' }), 404);
  });
});
