import { describe, expect, it } from 'vitest';
import { boot, get, json, post, type Session } from './t3-helpers';
import { createScopedUser, fetchAs } from './http-helpers';

/**
 * T-7 财务预测补齐 lishui(AC-F11):模型目录、冻结即提交复核(提交人 ≠ 复核人)、复核通过后发布运行、撤回、
 * 已发布列表、基准时间线(逐版对比)、运行洞察(模板,只追加)、组织范围。
 */

const FF = '/api/forecast';
const patch = (base: string, s: Session, url: string, body: unknown) =>
  fetchAs(s, `${base}${url}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
async function ok(res: Response | Promise<Response>, status = 200) {
  const r = await res;
  const body = await r.json();
  expect(r.status, JSON.stringify(body).slice(0, 1000)).toBe(status);
  return body;
}
async function status(res: Response | Promise<Response>) { const r = await res; return [r.status, ((await r.json()) as { code?: string }).code]; }
async function waitRun(base: string, s: Session, runId: number) {
  for (let i = 0; i < 1200; i += 1) {
    const run = await json(get(base, s, `${FF}/runs/${runId}`));
    if (run.status === 'succeeded' || run.status === 'failed') return run;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('run timeout');
}

const workbook = (start: string) => ({
  sheets: [
    { name: '参数', cells: { A1: { s: '增长率' }, B1: { n: '0.05' } } },
    { name: '预测', cells: { A1: { s: '收入' }, B1: { n: start }, C1: { f: '=B1*(1+参数!$B$1)' }, D1: { f: '=C1*(1+参数!$B$1)' } } },
  ],
});
const PARAMS = [{ key: 'growth', name: '增长率', cell: '参数!B1', unit: '', min: '-0.5', max: '0.5' }];
const OUTPUTS = [{ key: 'revenue', name: '收入', ref: '预测!B1:D1', unit: '万元' }];

async function frozen(base: string, s: Session, modelId: number, start: string) {
  const v = await ok(post(base, s, `${FF}/models/${modelId}/versions`, { workbook: workbook(start), params: PARAMS, outputs: OUTPUTS }), 201);
  return ok(post(base, s, `${FF}/versions/${v.id}/freeze`, { expectedVersion: v.version }));
}
async function run(base: string, s: Session, versionId: number, body: Record<string, unknown>) {
  const r = await ok(post(base, s, `${FF}/versions/${versionId}/runs`, body), 202);
  const done = await waitRun(base, s, r.id);
  expect(done.status).toBe('succeeded');
  return done;
}

describe('T-7 财务预测:目录、复核、发布、时间线、洞察', () => {
  it('完整流程与权限、范围', async () => {
    const { base, db, admin, fx } = await boot('newfc-t7-ff-');
    const sh = fx.orgIds.shanghai;
    const analyst = createScopedUser(db, { username: 'ff7-analyst', roleCodes: ['finance_analyst'], orgIds: [fx.orgIds.east] }).session;
    const reviewer = createScopedUser(db, { username: 'ff7-reviewer', roleCodes: ['business_reviewer'], orgIds: [fx.orgIds.east] }).session;

    // 目录
    const m = await ok(post(base, analyst, `${FF}/models`, { name: '上海三年预测', orgId: sh, baseYear: 2026, horizonYears: 3, folder: '水务/2026' }), 201);
    const m2 = await ok(post(base, analyst, `${FF}/models`, { name: '上海长期预测', orgId: sh, baseYear: 2026, horizonYears: 10, folder: '水务' }), 201);
    expect(m.folder).toBe('水务/2026');
    expect((await ok(get(base, analyst, `${FF}/folders`))).items).toEqual([
      { path: '水务', name: '水务', depth: 0, modelCount: 1, totalCount: 2 },
      { path: '水务/2026', name: '2026', depth: 1, modelCount: 1, totalCount: 1 },
    ]);
    expect((await ok(get(base, analyst, `${FF}/models?folder=${encodeURIComponent('水务')}`))).items).toHaveLength(2);
    expect((await ok(get(base, analyst, `${FF}/models?folder=${encodeURIComponent('水务/2026')}`))).items.map((x: { id: number }) => x.id)).toEqual([m.id]);
    expect((await post(base, analyst, `${FF}/models`, { name: 'x', orgId: sh, baseYear: 2026, horizonYears: 3, folder: '/坏目录' })).status).toBe(400);
    const moved = await ok(patch(base, analyst, `${FF}/models/${m2.id}`, { expectedVersion: m2.version, folder: '水务/长期' }));
    expect(moved.folder).toBe('水务/长期');

    // 冻结即待复核;未复核不能发布
    const v1 = await frozen(base, analyst, m.id, '1000');
    expect(v1).toMatchObject({ status: 'frozen', reviewStatus: 'pending', review: null });
    const b1 = await run(base, analyst, v1.id, { kind: 'baseline' });
    expect(await status(post(base, analyst, `${FF}/runs/${b1.id}/publish`, {}))).toEqual([409, 'FORECAST_VERSION_STATE']);

    // 复核:需 forecast:review;提交人 ≠ 复核人;只复核一次;退回须写意见
    expect((await post(base, analyst, `${FF}/versions/${v1.id}/review`, { expectedVersion: v1.version, decision: 'approve' })).status).toBe(403);
    expect((await post(base, reviewer, `${FF}/versions/${v1.id}/review`, { expectedVersion: v1.version, decision: 'return' })).status).toBe(400);
    const approved = await ok(post(base, reviewer, `${FF}/versions/${v1.id}/review`, { expectedVersion: v1.version, decision: 'approve', comment: '口径一致' }));
    expect(approved).toMatchObject({ reviewStatus: 'approved', review: { decision: 'approve', comment: '口径一致', reviewer: 'ff7-reviewer', selfReview: false } });
    expect(await status(post(base, reviewer, `${FF}/versions/${v1.id}/review`, { expectedVersion: v1.version, decision: 'return', comment: '再看' }))).toEqual([409, 'FORECAST_VERSION_STATE']);

    // 发布与撤回
    const pub = await ok(post(base, analyst, `${FF}/runs/${b1.id}/publish`, { note: '年度预算参考' }), 201);
    expect(pub).toMatchObject({ runId: b1.id, modelName: '上海三年预测', folder: '水务/2026', versionNo: 1, kind: 'baseline', title: '上海三年预测 第 1 版 基准', note: '年度预算参考' });
    expect(pub.outputs[0]).toMatchObject({ key: 'revenue', values: ['1000.000000', '1050.000000', '1102.500000'] });
    expect(await status(post(base, analyst, `${FF}/runs/${b1.id}/publish`, {}))).toEqual([409, 'FORECAST_RUN_PUBLISHED']);
    expect((await ok(get(base, analyst, `${FF}/runs/${b1.id}`))).publicationId).toBe(pub.id);
    const s1 = await run(base, analyst, v1.id, { kind: 'scenario', scenarioName: '高增长', params: { growth: '0.1' } });
    const pub2 = await ok(post(base, analyst, `${FF}/runs/${s1.id}/publish`, { title: '高增长情景' }), 201);
    expect((await ok(get(base, analyst, `${FF}/publications`))).items.map((p: { id: number }) => p.id)).toEqual([pub2.id, pub.id]);
    expect((await post(base, analyst, `${FF}/publications/${pub2.id}/withdraw`, { reason: '参数有误' })).status).toBe(403);
    const wd = await ok(post(base, reviewer, `${FF}/publications/${pub2.id}/withdraw`, { reason: '参数有误' }));
    expect(wd).toMatchObject({ withdrawReason: '参数有误', withdrawnBy: 'ff7-reviewer' });
    expect(await status(post(base, reviewer, `${FF}/publications/${pub2.id}/withdraw`, { reason: '再次' }))).toEqual([409, 'FORECAST_RUN_PUBLISHED']);
    expect((await ok(get(base, analyst, `${FF}/publications?modelId=${m.id}`))).items).toHaveLength(1);
    expect((await ok(get(base, analyst, `${FF}/publications?includeWithdrawn=1`))).items).toHaveLength(2);
    expect(() => db.prepare('UPDATE ff_run_publication SET withdrawn_at = NULL, withdraw_reason = NULL WHERE id = ?').run(pub2.id)).toThrow(/撤回/);

    // 洞察:模板,只追加
    const ins = await ok(post(base, analyst, `${FF}/runs/${b1.id}/insights`, {}), 201);
    expect(ins).toMatchObject({ runId: b1.id, source: 'template', model: 'template', promptVersion: 'forecast-insight.v1' });
    expect(ins.content).toContain('收入:首期 1000万元,末期 1102.5万元,整体上升,合计 3152.5万元');
    const sIns = await ok(post(base, analyst, `${FF}/runs/${s1.id}/insights`, {}), 201);
    expect(sIns.content).toContain('增长率:0.1');
    expect(sIns.content).toMatch(/收入:合计上升 [\d.]+万元/);
    expect((await ok(get(base, analyst, `${FF}/runs/${b1.id}/insights`))).items).toHaveLength(1);
    expect(() => db.prepare('DELETE FROM ff_run_insight').run()).toThrow(/只追加/);

    // 第二版:管理员同人复核须写例外原因;基准时间线逐版对比
    const v2 = await frozen(base, admin, m.id, '1100');
    expect((await post(base, admin, `${FF}/versions/${v2.id}/review`, { expectedVersion: v2.version, decision: 'approve' })).status).toBe(400);
    const v2ok = await ok(post(base, admin, `${FF}/versions/${v2.id}/review`, { expectedVersion: v2.version, decision: 'approve', exceptionReason: '单人值守' }));
    expect(v2ok.review).toMatchObject({ selfReview: true, exceptionReason: '单人值守' });
    await run(base, admin, v2.id, { kind: 'baseline' });
    const tl = await ok(get(base, analyst, `${FF}/models/${m.id}/baselines`));
    expect(tl.items.map((i: { versionNo: number; reviewStatus: string }) => [i.versionNo, i.reviewStatus])).toEqual([[1, 'approved'], [2, 'approved']]);
    expect(tl.items[0].outputs[0]).toMatchObject({ total: '3152.500000', previousTotal: null, change: null });
    expect(tl.items[1].outputs[0]).toMatchObject({ total: '3467.750000', previousTotal: '3152.500000', change: '315.250000', changeRate: '0.100000' });

    // 范围外:列表为空,单个 404
    const hz = createScopedUser(db, { username: 'ff7-hz', roleCodes: ['business_reviewer'], orgIds: [fx.orgIds.hangzhou] }).session;
    expect((await ok(get(base, hz, `${FF}/publications`))).items).toEqual([]);
    expect((await ok(get(base, hz, `${FF}/folders`))).items).toEqual([]);
    expect((await get(base, hz, `${FF}/models/${m.id}/baselines`)).status).toBe(404);
    expect((await post(base, hz, `${FF}/publications/${pub.id}/withdraw`, { reason: 'x' })).status).toBe(404);
  });
});
