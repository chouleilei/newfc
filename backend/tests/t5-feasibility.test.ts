import { describe, expect, it } from 'vitest';
import fs from 'fs';
import path from 'path';
import ExcelJS from 'exceljs';
import { boot, get, json, post, upload, type Session } from './t3-helpers';
import { createScopedUser, fetchAs } from './http-helpers';
import { createProject } from './t4-helpers';
import { fx, toFixed } from '../src/core/fixed';

/**
 * AC-F12 投资可行性测算:项目/方案/测算/历史运行、参数修改后“需重算”、失败留痕、
 * 标准模板往返导入(预览→确认核对 sha256)、公式/未知工作表/表头拒绝、敏感性后台任务、结果导出与范围隔离。
 */

const sample = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'investment_feasibility_yichongqiao.json'), 'utf8'));
const reference = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'feasibility-reference.json'), 'utf8'));
const BASE = '/api/investment/feasibility';

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
async function download(base: string, s: Session, url: string): Promise<Buffer> {
  const r = await get(base, s, url);
  expect(r.status).toBe(200);
  expect(r.headers.get('content-type')).toContain('spreadsheetml');
  return Buffer.from(await r.arrayBuffer());
}
async function waitJob(base: string, s: Session, jobId: number) {
  for (let i = 0; i < 200; i += 1) {
    const job = await json(get(base, s, `/api/jobs/${jobId}`));
    if (['succeeded', 'failed', 'cancelled'].includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('job timeout');
}
const num = (v: string | null) => (v == null ? null : toFixed(fx(v), 6));
const indicatorMap = (items: { code: string; value: string | null }[]) => Object.fromEntries(items.map((i) => [i.code, num(i.value)]));
const refIndicators = (name: string) => Object.fromEntries(Object.entries(reference.cases[name].indicators as Record<string, { value: string | null }>).map(([k, v]) => [k, num(v.value)]));

async function setup() {
  const t = await boot('newfc-t5-feas-');
  const analyst = createScopedUser(t.db, { username: 'feas-analyst', roleCodes: ['finance_analyst'], orgIds: [t.fx.orgIds.east] });
  const project = await ok(post(t.base, analyst.session, `${BASE}/projects`, {
    code: 'REG-WATER-001', name: '脱敏水库项目', orgId: t.fx.orgIds.shanghai, constructionStartYear: 2026, operationStartYear: 2028, horizonYears: 30,
  }), 201);
  return { ...t, analyst: analyst.session, project };
}

describe('T-5 投资可行性测算(AC-F12)', () => {
  it('方案测算与 Python 参照一致;运行冻结;参数修改后需重算;失败留痕', async () => {
    const { base, db, analyst, project } = await setup();
    let sc = await ok(post(base, analyst, `${BASE}/projects/${project.id}/scenarios`, { code: 'BASE', name: '基准方案', assumptions: sample.assumptions }), 201);
    expect(sc).toMatchObject({ code: 'BASE', version: 1, stale: true, latestRun: null });
    await fail(post(base, analyst, `${BASE}/projects/${project.id}/scenarios`, { code: 'BASE', name: '重复', assumptions: sample.assumptions }), 409, 'DUPLICATE');
    await fail(post(base, analyst, `${BASE}/projects/${project.id}/scenarios`, {
      code: 'BAD', name: '错误', assumptions: { ...sample.assumptions, schema_version: 'standard-0.9' },
    }), 400, 'VALIDATION_FAILED');

    await fail(post(base, analyst, `${BASE}/scenarios/${sc.id}/run`, { expectedVersion: 99 }), 409, 'VERSION_CONFLICT');
    const run = await ok(post(base, analyst, `${BASE}/scenarios/${sc.id}/run`, { expectedVersion: sc.version }), 201);
    expect(run.status).toBe('succeeded');
    expect(indicatorMap(run.result.indicators)).toEqual(refIndicators('base'));
    expect(run.result.cashflows).toHaveLength(reference.cases.base.cashflows.length);
    expect(run.parameterHash).toBe(run.result.parameterHash);

    sc = await ok(get(base, analyst, `${BASE}/scenarios/${sc.id}`));
    expect(sc.stale).toBe(false);
    expect(sc.latestRun.id).toBe(run.id);
    expect(() => db.prepare("UPDATE if_run SET status = 'failed' WHERE id = ?").run(run.id)).toThrow(/冻结/);
    expect(() => db.prepare('DELETE FROM if_run WHERE id = ?').run(run.id)).toThrow(/不可删除/);

    // 修改电价:当前 hash 与最新运行不同 → 需重算;历史运行保留
    const changed = structuredClone(sample.assumptions);
    changed.revenue_items[0].electricity_price_yuan_per_kwh = '0.36';
    sc = await ok(patch(base, analyst, `${BASE}/scenarios/${sc.id}`, { expectedVersion: sc.version, assumptions: changed }));
    expect(sc).toMatchObject({ version: 2, stale: true });
    await fail(patch(base, analyst, `${BASE}/scenarios/${sc.id}`, { expectedVersion: 1, name: 'x' }), 409, 'VERSION_CONFLICT');
    const run2 = await ok(post(base, analyst, `${BASE}/scenarios/${sc.id}/run`, { expectedVersion: sc.version }), 201);
    expect(Number(indicatorMap(run2.result.indicators).project_npv)).toBeLessThan(Number(indicatorMap(run.result.indicators).project_npv));
    const runs = await ok(get(base, analyst, `${BASE}/scenarios/${sc.id}/runs`));
    expect(runs.items.map((r: { id: number }) => r.id)).toEqual([run2.id, run.id]);
    expect((await ok(get(base, analyst, `${BASE}/runs/${run.id}`))).assumptions.revenue_items[0].electricity_price_yuan_per_kwh).toBe('0.4');

    // 复制方案
    const copy = await ok(post(base, analyst, `${BASE}/scenarios/${sc.id}/copy`, { code: 'COPY', name: '复制方案' }), 201);
    expect(copy).toMatchObject({ code: 'COPY', version: 1, stale: true, parameterHash: sc.parameterHash });

    // 计算失败:运营起年不在计算期内 → failed 运行留痕 + FEAS_CALC_FAILED
    const short = structuredClone(sample.assumptions);
    short.evaluation = { ...(short.evaluation ?? {}), horizon_years: 2 };
    const bad = await ok(patch(base, analyst, `${BASE}/scenarios/${copy.id}`, { expectedVersion: copy.version, assumptions: short }));
    const failed = await fail(post(base, analyst, `${BASE}/scenarios/${copy.id}/run`, { expectedVersion: bad.version }), 422, 'FEAS_CALC_FAILED');
    const failedRun = await ok(get(base, analyst, `${BASE}/runs/${failed.details.runId}`));
    expect(failedRun).toMatchObject({ status: 'failed', result: null, errorMessage: '运营起年必须位于测算周期内' });
    await fail(get(base, analyst, `${BASE}/runs/${failed.details.runId}/export`), 409, 'FEAS_STATE');

    const logs = db.prepare("SELECT action, result FROM operation_log WHERE action LIKE 'investment.feasibility.%' ORDER BY id").all() as { action: string; result: string }[];
    expect(logs.filter((l) => l.action === 'investment.feasibility.run').map((l) => l.result)).toEqual(['success', 'success', 'failure']);

    // 归档后拒绝修改与测算
    const p = await ok(get(base, analyst, `${BASE}/projects/${sc.projectId}`));
    await ok(patch(base, analyst, `${BASE}/projects/${p.id}`, { expectedVersion: p.version, status: 'archived' }));
    await fail(post(base, analyst, `${BASE}/scenarios/${sc.id}/run`, { expectedVersion: sc.version }), 409, 'FEAS_STATE');
  });

  it('标准模板往返导入;公式、未知工作表、表头不符被拒;确认核对 sha256 且只能预览人确认', async () => {
    const { base, db, analyst, admin, project } = await setup();
    const sc = await ok(post(base, analyst, `${BASE}/projects/${project.id}/scenarios`, { code: 'BASE', name: '基准方案', assumptions: sample.assumptions }), 201);

    const blank = await download(base, analyst, `${BASE}/template`);
    const wbBlank = new ExcelJS.Workbook();
    await wbBlank.xlsx.load(blank as unknown as ArrayBuffer);
    expect(wbBlank.worksheets.map((w) => w.name)).toEqual(['说明', '方案参数', '建设投资', '融资计划', '经营收入', '经营成本', '年度进项税', '敏感性变量']);

    const filled = await download(base, analyst, `${BASE}/template?scenarioId=${sc.id}`);
    const preview = await ok(upload(base, analyst, `${BASE}/projects/${project.id}/imports`, filled, '导入.xlsx'), 201);
    expect(preview.errors).toEqual([]);
    expect(preview.assumptions).toEqual(sc.assumptions);

    await fail(post(base, analyst, `${BASE}/imports/${preview.id}/confirm`, { sha256: '0'.repeat(64), code: 'IMP', name: '导入方案' }), 409, 'PREVIEW_STALE');
    await fail(post(base, admin, `${BASE}/imports/${preview.id}/confirm`, { sha256: preview.sha256, code: 'IMP', name: '导入方案' }), 403, 'PREVIEW_OWNER_MISMATCH');
    const confirmed = await ok(post(base, analyst, `${BASE}/imports/${preview.id}/confirm`, { sha256: preview.sha256, code: 'IMP', name: '导入方案' }));
    expect(confirmed).toMatchObject({ status: 'confirmed', replayed: false });
    const replay = await ok(post(base, analyst, `${BASE}/imports/${preview.id}/confirm`, { sha256: preview.sha256, code: 'IMP', name: '导入方案' }));
    expect(replay).toMatchObject({ scenarioId: confirmed.scenarioId, replayed: true });
    const imported = await ok(get(base, analyst, `${BASE}/scenarios/${confirmed.scenarioId}`));
    expect(imported).toMatchObject({ parameterHash: sc.parameterHash, sourceFileName: '导入.xlsx' });
    const r1 = await ok(post(base, analyst, `${BASE}/scenarios/${imported.id}/run`, { expectedVersion: 1 }), 201);
    expect(indicatorMap(r1.result.indicators)).toEqual(refIndicators('base'));

    const mutate = async (fn: (wb: ExcelJS.Workbook) => void) => {
      const wb = new ExcelJS.Workbook();
      await wb.xlsx.load(filled as unknown as ArrayBuffer);
      fn(wb);
      return Buffer.from(await wb.xlsx.writeBuffer());
    };
    const errorsOf = async (buf: Buffer) => (await ok(upload(base, analyst, `${BASE}/projects/${project.id}/imports`, buf, 'x.xlsx'), 201)).errors as { row: number; field: string; message: string }[];

    const formula = await errorsOf(await mutate((wb) => { wb.getWorksheet('建设投资')!.getCell('B2').value = { formula: '1000+2800', result: 3800 }; }));
    expect(formula).toEqual([expect.objectContaining({ row: 2, field: '建设投资/工程费(万元)', message: expect.stringContaining('公式') })]);
    const unknownSheet = await errorsOf(await mutate((wb) => { wb.addWorksheet('附表'); }));
    expect(unknownSheet[0].message).toContain('未知工作表');
    const header = await errorsOf(await mutate((wb) => { wb.getWorksheet('融资计划')!.getCell('B1').value = '贷款'; }));
    expect(header[0]).toMatchObject({ row: 1, field: '融资计划' });
    const badParam = await errorsOf(await mutate((wb) => { wb.getWorksheet('方案参数')!.addRow(['tax.unknown', '未知', '1']); }));
    expect(badParam[0].message).toContain('未知参数编码');
    const badRatio = await errorsOf(await mutate((wb) => {
      const ws = wb.getWorksheet('方案参数')!;
      ws.eachRow((row) => { if (row.getCell(1).value === 'tax.vat_rate') row.getCell(3).value = '1.5'; });
    }));
    expect(badRatio).toEqual([expect.objectContaining({ field: '方案参数/tax.vat_rate', message: '比率应在 0 到 1 之间' })]);
    const badCost = await errorsOf(await mutate((wb) => { wb.getWorksheet('经营成本')!.getCell('G2').value = '2028=1800'; }));
    expect(badCost[0]).toMatchObject({ row: 2, field: '经营成本/分年金额' });

    // 有错误的预览不能确认
    const previews = db.prepare("SELECT id, file_sha256 FROM if_import WHERE errors_json != '[]' ORDER BY id LIMIT 1").get() as { id: number; file_sha256: string };
    await fail(post(base, analyst, `${BASE}/imports/${previews.id}/confirm`, { sha256: previews.file_sha256, code: 'E', name: 'E' }), 422, 'IMPORT_INVALID');
  });

  it('敏感性分析为后台任务并冻结为 sensitivity 运行;结果导出数值与冻结结果一致', async () => {
    const { base, analyst, project } = await setup();
    const sc = await ok(post(base, analyst, `${BASE}/projects/${project.id}/scenarios`, { code: 'BASE', name: '基准方案', assumptions: sample.assumptions }), 201);
    const run = await ok(post(base, analyst, `${BASE}/scenarios/${sc.id}/run`, { expectedVersion: 1 }), 201);

    await fail(post(base, analyst, `${BASE}/scenarios/${sc.id}/sensitivity`, {
      expectedVersion: 1, variables: [{ code: 'electricity_price', mode: 'year_delta', changes: ['1'] }],
    }), 400, 'VALIDATION_FAILED');
    const { jobId } = await ok(post(base, analyst, `${BASE}/scenarios/${sc.id}/sensitivity`, {
      expectedVersion: 1,
      variables: [
        { code: 'electricity_price', changes: ['-0.1', '0.1'] },
        { code: 'construction_delay', mode: 'year_delta', changes: ['1', '2', '3'] },
        { code: 'loan_interest_rate', mode: 'percentage_point', changes: ['0.01'] },
      ],
    }), 202);
    const job = await waitJob(base, analyst, jobId);
    expect(job.status, JSON.stringify(job)).toBe('succeeded');
    const runs = await ok(get(base, analyst, `${BASE}/scenarios/${sc.id}/runs`));
    const sens = runs.items.find((r: { kind: string }) => r.kind === 'sensitivity');
    const detail = await ok(get(base, analyst, `${BASE}/runs/${sens.id}`));
    expect(detail.result.items).toHaveLength(6);
    const npvOf = (code: string, change: string) => detail.result.items.find((i: { code: string; change: string }) => i.code === code && i.change === change)
      .indicators.find((x: { code: string }) => x.code === 'project_npv');
    // 延期 1~3 年与 Python 参照一致(折现基准锁定在原建设起年)
    for (const n of [1, 2, 3]) expect(num(npvOf('construction_delay', String(n)).value)).toBe(refIndicators(`delay_${n}`).project_npv);
    expect(npvOf('electricity_price', '-0.1').delta.startsWith('-')).toBe(true);
    expect(num(npvOf('electricity_price', '0.1').baseValue)).toBe(indicatorMap(run.result.indicators).project_npv);
    // 最新 base 运行仍是“当前结果”
    expect((await ok(get(base, analyst, `${BASE}/scenarios/${sc.id}`))).latestRun.id).toBe(run.id);

    const buf = await download(base, analyst, `${BASE}/runs/${run.id}/export`);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(buf as unknown as ArrayBuffer);
    expect(wb.worksheets.map((w) => w.name)).toEqual(['摘要', '参数', '现金流', '债务', '检查']);
    const summary = wb.getWorksheet('摘要')!;
    const exported: Record<string, string> = {};
    summary.eachRow((row) => {
      const code = String(row.getCell(1).value ?? '');
      if (run.result.indicators.some((i: { code: string }) => i.code === code)) exported[code] = String(row.getCell(3).value ?? '');
    });
    const norm = (v: string | null) => (v == null ? '' : String(Number(v)) === v.replace(/\.?0+$/, '') ? String(Number(v)) : v);
    expect(exported).toEqual(Object.fromEntries(run.result.indicators.map((i: { code: string; value: string | null }) => [i.code, norm(i.value)])));
    const cf = wb.getWorksheet('现金流')!;
    expect(cf.rowCount).toBe(1 + run.result.cashflows.length);
    run.result.cashflows.forEach((row: Record<string, string>, i: number) => {
      expect(String(cf.getRow(i + 2).getCell(18).value)).toBe(norm(row.project_net_cashflow));
    });
    const sensBuf = await download(base, analyst, `${BASE}/runs/${sens.id}/export`);
    const wb2 = new ExcelJS.Workbook();
    await wb2.xlsx.load(sensBuf as unknown as ArrayBuffer);
    expect(wb2.getWorksheet('敏感性')!.rowCount).toBe(1 + 6 * 6);
  });

  it('组织范围:范围外项目 404、列表不含;只读用户不能写', async () => {
    const { base, db, fx: f, admin, analyst, project } = await setup();
    const sc = await ok(post(base, analyst, `${BASE}/projects/${project.id}/scenarios`, { code: 'BASE', name: '基准方案', assumptions: sample.assumptions }), 201);
    const west = createScopedUser(db, { username: 'feas-west', roleCodes: ['finance_analyst'], orgIds: [f.orgIds.west] }).session;
    const viewer = createScopedUser(db, { username: 'feas-viewer', roleCodes: ['viewer'], orgIds: [f.orgIds.east] }).session;
    expect((await ok(get(base, west, `${BASE}/projects`))).items).toEqual([]);
    await fail(get(base, west, `${BASE}/projects/${project.id}`), 404, 'NOT_FOUND');
    await fail(get(base, west, `${BASE}/scenarios/${sc.id}`), 404, 'NOT_FOUND');
    await fail(post(base, west, `${BASE}/scenarios/${sc.id}/run`, { expectedVersion: 1 }), 404, 'NOT_FOUND');
    await fail(get(base, west, `${BASE}/template?scenarioId=${sc.id}`), 404, 'NOT_FOUND');
    await fail(post(base, west, `${BASE}/projects`, { code: 'X', name: 'X', orgId: f.orgIds.shanghai, constructionStartYear: 2026, operationStartYear: 2028, horizonYears: 30 }), 404, 'NOT_FOUND');
    expect((await ok(get(base, viewer, `${BASE}/projects`))).items).toHaveLength(1);
    await fail(post(base, viewer, `${BASE}/scenarios/${sc.id}/run`, { expectedVersion: 1 }), 403, 'FORBIDDEN');

    // 关联主数据项目:组织须一致
    const mdId = await createProject(base, admin, 'P-SH-01', '上海泵站', f.orgIds.shanghai);
    await fail(post(base, analyst, `${BASE}/projects`, {
      code: 'MD-1', name: '关联', orgId: f.orgIds.hangzhou, mdProjectId: mdId, constructionStartYear: 2026, operationStartYear: 2028, horizonYears: 30,
    }), 400, 'VALIDATION_FAILED');
    const linked = await ok(post(base, analyst, `${BASE}/projects`, {
      code: 'MD-1', name: '关联', orgId: f.orgIds.shanghai, mdProjectId: mdId, constructionStartYear: 2026, operationStartYear: 2028, horizonYears: 30,
    }), 201);
    expect(linked).toMatchObject({ mdProjectCode: 'P-SH-01' });
  });
});
