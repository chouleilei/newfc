import { afterEach, describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { boot, get, json, post, upload, type Session } from './t3-helpers';
import { createScopedUser, fetchAs } from './http-helpers';
import { activeForecastWorkers } from '../src/modules/forecast/forecast-runner';

/**
 * AC-F11 财务预测:xlsx 导入(值+公式、共享公式)、诊断阻止冻结、草稿编辑与冻结、冻结后不可改、
 * Worker 基准/情景运行与对比、参数越界/公式错误/超时失败留痕且不存部分输出、Worker 释放、范围隔离。
 */

const FF = '/api/forecast';
const patch = (base: string, s: Session, url: string, body: unknown) =>
  fetchAs(s, `${base}${url}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
async function ok(res: Response | Promise<Response>, status = 200) {
  const r = await res;
  const body = await r.json();
  expect(r.status, JSON.stringify(body).slice(0, 2000)).toBe(status);
  return body;
}
async function fail(res: Response | Promise<Response>, status: number, code: string) {
  const r = await res;
  const body = await r.json();
  expect([r.status, body.code], JSON.stringify(body).slice(0, 2000)).toEqual([status, code]);
  return body;
}
async function waitRun(base: string, s: Session, runId: number) {
  for (let i = 0; i < 600; i += 1) {
    const run = await json(get(base, s, `${FF}/runs/${runId}`));
    if (run.status === 'succeeded' || run.status === 'failed') return run;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error('run timeout');
}

async function sampleXlsx(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const p = wb.addWorksheet('参数');
  p.getCell('A1').value = '收入增长率';
  p.getCell('B1').value = 0.05;
  p.getCell('A2').value = '成本率';
  p.getCell('B2').value = 0.6;
  const f = wb.addWorksheet('预测');
  f.getCell('A1').value = '收入';
  f.getCell('B1').value = 1000;
  f.getCell('C1').value = { formula: 'B1*(1+参数!$B$1)', result: 1050 };
  f.getCell('D1').value = { formula: 'C1*(1+参数!$B$1)', result: 1102.5 };
  f.getCell('E1').value = { sharedFormula: 'D1', result: 1157.625 } as unknown as ExcelJS.CellValue;
  f.getCell('A2').value = '成本';
  f.getCell('B2').value = { formula: 'ROUND(B1*参数!$B$2,2)', result: 600 };
  f.getCell('C2').value = { formula: 'ROUND(C1*参数!$B$2,2)', result: 630 };
  f.getCell('A3').value = '合计利润';
  f.getCell('B3').value = { formula: 'SUM(B1:E1)-SUM(B2:C2)', result: 0 };
  f.getCell('A5').value = { formula: 'VLOOKUP(1,A1:B2,2,FALSE)', result: 0 };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

const PARAMS = [
  { key: 'growth', name: '收入增长率', cell: '参数!B1', unit: '', min: '-0.5', max: '0.5' },
  { key: 'cost_rate', name: '成本率', cell: '参数!B2', unit: '' },
];
const OUTPUTS = [
  { key: 'revenue', name: '收入', ref: '预测!B1:E1', unit: '万元' },
  { key: 'profit', name: '合计利润', ref: '预测!B3', unit: '万元' },
];

async function setup() {
  const t = await boot('newfc-t5-ff-');
  const analyst = createScopedUser(t.db, { username: 'ff-analyst', roleCodes: ['finance_analyst'], orgIds: [t.fx.orgIds.east] }).session;
  const model = await ok(post(t.base, analyst, `${FF}/models`, { name: '上海分公司三年预测', orgId: t.fx.orgIds.shanghai, baseYear: 2026, horizonYears: 3 }), 201);
  return { ...t, analyst, model };
}

async function frozenVersion(base: string, s: Session, modelId: number) {
  let v = await ok(upload(base, s, `${FF}/models/${modelId}/imports`, await sampleXlsx(), '预测.xlsx'), 201);
  v = await ok(patch(base, s, `${FF}/versions/${v.id}`, { expectedVersion: v.version, cells: [{ sheet: '预测', cell: 'A5', value: null }], params: PARAMS, outputs: OUTPUTS }));
  return ok(post(base, s, `${FF}/versions/${v.id}/freeze`, { expectedVersion: v.version }));
}

afterEach(() => { delete process.env.NEWFC_FORECAST_TIMEOUT_MS; });

describe('T-5 财务预测(AC-F11)', () => {
  it('导入诊断、草稿编辑、冻结与冻结后不可改、复制新草稿', async () => {
    const { base, db, analyst, model } = await setup();
    let v = await ok(upload(base, analyst, `${FF}/models/${model.id}/imports`, await sampleXlsx(), '预测.xlsx'), 201);
    expect(v).toMatchObject({ status: 'draft', versionNo: 1, sourceFileName: '预测.xlsx', sheets: [{ name: '参数' }, { name: '预测' }] });
    expect(v.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ severity: 'error', code: 'UNSUPPORTED_FUNCTION', cell: '预测!A5' })]));
    const sheet = await ok(get(base, analyst, `${FF}/versions/${v.id}/sheets/${encodeURIComponent('预测')}`));
    expect(sheet.cells.C1).toEqual({ f: '=B1*(1+参数!$B$1)' });
    expect(sheet.cells.E1.f).toBe('=D1*(1+参数!$B$1)');
    expect(sheet.cells.B1).toEqual({ n: '1000' });

    await fail(post(base, analyst, `${FF}/versions/${v.id}/freeze`, { expectedVersion: v.version }), 409, 'FORECAST_VERSION_STATE');
    // 参数单元格必须是数值常量
    const badParam = await ok(patch(base, analyst, `${FF}/versions/${v.id}`, { expectedVersion: v.version, params: [{ key: 'x', name: 'x', cell: '预测!C1' }] }));
    expect(badParam.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'PARAM', message: expect.stringContaining('数值常量') })]));
    await fail(patch(base, analyst, `${FF}/versions/${v.id}`, { expectedVersion: v.version, note: 'x' }), 409, 'VERSION_CONFLICT');
    v = await ok(patch(base, analyst, `${FF}/versions/${v.id}`, { expectedVersion: badParam.version, cells: [{ sheet: '预测', cell: 'A5', value: null }], params: PARAMS, outputs: OUTPUTS }));
    expect(v.errorCount).toBe(0);
    // 循环引用在诊断中报错
    const cyc = await ok(patch(base, analyst, `${FF}/versions/${v.id}`, { expectedVersion: v.version, cells: [{ sheet: '预测', cell: 'B1', value: { f: '=E1' } }] }));
    expect(cyc.diagnostics).toEqual(expect.arrayContaining([expect.objectContaining({ code: 'CYCLE' })]));
    v = await ok(patch(base, analyst, `${FF}/versions/${v.id}`, { expectedVersion: cyc.version, cells: [{ sheet: '预测', cell: 'B1', value: { n: '1000' } }] }));
    v = await ok(post(base, analyst, `${FF}/versions/${v.id}/freeze`, { expectedVersion: v.version }));
    expect(v).toMatchObject({ status: 'frozen', errorCount: 0 });
    await fail(patch(base, analyst, `${FF}/versions/${v.id}`, { expectedVersion: v.version, note: '改' }), 409, 'FORECAST_VERSION_FROZEN');
    expect(() => db.prepare("UPDATE ff_version SET note = 'x' WHERE id = ?").run(v.id)).toThrow(/冻结/);
    const copy = await ok(post(base, analyst, `${FF}/versions/${v.id}/copy`, {}), 201);
    expect(copy).toMatchObject({ status: 'draft', versionNo: 2, contentHash: v.contentHash });
    await fail(post(base, analyst, `${FF}/versions/${copy.id}/runs`, { kind: 'baseline' }), 409, 'FORECAST_VERSION_STATE');
  });

  it('Worker 基准与情景运行、逐项对比、基准唯一、参数越界与公式错误失败不存部分输出', async () => {
    const { base, analyst, model } = await setup();
    const v = await frozenVersion(base, analyst, model.id);
    await fail(post(base, analyst, `${FF}/versions/${v.id}/runs`, { kind: 'scenario', scenarioName: '高增长', params: { growth: '0.1' } }), 409, 'FORECAST_VERSION_STATE');
    const queued = await ok(post(base, analyst, `${FF}/versions/${v.id}/runs`, { kind: 'baseline' }), 202);
    const baseline = await waitRun(base, analyst, queued.id);
    expect(baseline).toMatchObject({ status: 'succeeded', kind: 'baseline', errorCode: null });
    expect(baseline.outputs).toEqual({ revenue: ['1000.000000', '1050.000000', '1102.500000', '1157.625000'], profit: ['3080.125000'] });
    expect(activeForecastWorkers()).toBe(0);
    await fail(post(base, analyst, `${FF}/versions/${v.id}/runs`, { kind: 'baseline' }), 409, 'FORECAST_VERSION_STATE');
    await fail(post(base, analyst, `${FF}/versions/${v.id}/runs`, { kind: 'baseline', params: { growth: '0.1' } }), 400, 'VALIDATION_FAILED');
    await fail(post(base, analyst, `${FF}/versions/${v.id}/runs`, { kind: 'scenario', params: { growth: '0.1' } }), 400, 'VALIDATION_FAILED');
    await fail(post(base, analyst, `${FF}/versions/${v.id}/runs`, { kind: 'scenario', scenarioName: 'x', params: { nope: '1' } }), 400, 'VALIDATION_FAILED');

    const sc = await waitRun(base, analyst, (await ok(post(base, analyst, `${FF}/versions/${v.id}/runs`, { kind: 'scenario', scenarioName: '高增长', params: { growth: '0.1' } }), 202)).id);
    expect(sc.outputs.revenue).toEqual(['1000.000000', '1100.000000', '1210.000000', '1331.000000']);
    const cmp = await ok(get(base, analyst, `${FF}/runs/${sc.id}/compare`));
    expect(cmp.baselineRunId).toBe(baseline.id);
    expect(cmp.items[0].values[3]).toEqual({ index: 3, baseline: '1157.625000', scenario: '1331.000000', diff: '173.375000', rate: '0.149768' });

    const bad = await waitRun(base, analyst, (await ok(post(base, analyst, `${FF}/versions/${v.id}/runs`, { kind: 'scenario', scenarioName: '越界', params: { growth: '0.9' } }), 202)).id);
    expect(bad).toMatchObject({ status: 'failed', errorCode: 'FORECAST_PARAM_INVALID', outputs: null });
    let job = await json(get(base, analyst, `/api/jobs/${bad.jobId}`));
    for (let i = 0; i < 100 && job.status !== 'failed'; i += 1) { await new Promise((r) => setTimeout(r, 20)); job = await json(get(base, analyst, `/api/jobs/${bad.jobId}`)); }
    expect(job).toMatchObject({ status: 'failed', error: { code: 'FORECAST_RECALC_FAILED' } });

    // 成本率=0 时 B3 正常;把收入改为除零的版本:输出单元格错误定位
    const copy = await ok(post(base, analyst, `${FF}/versions/${v.id}/copy`, {}), 201);
    let d = await ok(patch(base, analyst, `${FF}/versions/${copy.id}`, { expectedVersion: copy.version, cells: [{ sheet: '预测', cell: 'C1', value: { f: '=B1/(参数!B1-0.05)' } }] }));
    d = await ok(post(base, analyst, `${FF}/versions/${d.id}/freeze`, { expectedVersion: d.version }));
    const divRun = await waitRun(base, analyst, (await ok(post(base, analyst, `${FF}/versions/${d.id}/runs`, { kind: 'baseline' }), 202)).id);
    expect(divRun).toMatchObject({ status: 'failed', errorCode: 'FORECAST_FORMULA_ERROR', outputs: null });
    expect(divRun.diagnostics).toEqual(expect.arrayContaining([{ output: 'revenue', cell: '预测!C1', error: '#DIV/0!' }]));
  }, 90_000); // 多次 Worker 运行:发布前全量并行测试(紧接依赖重装)时曾超过默认 30 秒

  it('超时终止 Worker、释放任务槽,下一次运行立即可执行', async () => {
    const { base, analyst, model } = await setup();
    const cells: Record<string, unknown> = {};
    for (let i = 1; i <= 3000; i += 1) { cells[`A${i}`] = { n: String(i) }; cells[`B${i}`] = { f: '=SUMPRODUCT(A1:A3000,A1:A3000)' }; }
    cells.C1 = { f: '=SUM(B1:B3000)' };
    let heavy = await ok(post(base, analyst, `${FF}/models/${model.id}/versions`, {
      workbook: { sheets: [{ name: '重', cells }] }, outputs: [{ key: 'total', name: '合计', ref: '重!C1' }],
    }), 201);
    heavy = await ok(post(base, analyst, `${FF}/versions/${heavy.id}/freeze`, { expectedVersion: heavy.version }));
    process.env.NEWFC_FORECAST_TIMEOUT_MS = '300';
    const started = Date.now();
    const t = await waitRun(base, analyst, (await ok(post(base, analyst, `${FF}/versions/${heavy.id}/runs`, { kind: 'baseline' }), 202)).id);
    expect(t).toMatchObject({ status: 'failed', errorCode: 'FORECAST_TIMEOUT', outputs: null });
    expect(Date.now() - started).toBeLessThan(15_000);
    expect(activeForecastWorkers()).toBe(0);
    delete process.env.NEWFC_FORECAST_TIMEOUT_MS;
    const v = await frozenVersion(base, analyst, model.id);
    const next = await waitRun(base, analyst, (await ok(post(base, analyst, `${FF}/versions/${v.id}/runs`, { kind: 'baseline' }), 202)).id);
    expect(next.status).toBe('succeeded');
    // 失败的基准不占“唯一成功基准”,可重试(此处仍超时则仍为失败)
    const runs = await ok(get(base, analyst, `${FF}/versions/${heavy.id}/runs`));
    expect(runs.items).toHaveLength(1);
  }, 60_000);

  it('组织范围:范围外 404,只读不能写', async () => {
    const { base, db, fx, analyst, model } = await setup();
    const v = await frozenVersion(base, analyst, model.id);
    const west = createScopedUser(db, { username: 'ff-west', roleCodes: ['finance_analyst'], orgIds: [fx.orgIds.west] }).session;
    const viewer = createScopedUser(db, { username: 'ff-viewer', roleCodes: ['viewer'], orgIds: [fx.orgIds.east] }).session;
    expect((await ok(get(base, west, `${FF}/models`))).items).toEqual([]);
    await fail(get(base, west, `${FF}/versions/${v.id}`), 404, 'NOT_FOUND');
    await fail(post(base, west, `${FF}/versions/${v.id}/runs`, { kind: 'baseline' }), 404, 'NOT_FOUND');
    await fail(post(base, viewer, `${FF}/versions/${v.id}/runs`, { kind: 'baseline' }), 403, 'FORBIDDEN');
    expect((await ok(get(base, viewer, `${FF}/models/${model.id}`))).versions).toHaveLength(1);
  });
});
