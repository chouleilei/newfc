import fs from 'fs';
import path from 'path';
import ExcelJS from 'exceljs';
import { describe, expect, it } from 'vitest';
import { runWithContext, systemContext } from '../src/core/request-context';
import { getJobRow, jobConcurrency, recoverInterruptedJobs, submitJob } from '../src/modules/jobs/job.service';
import { boot, get, json, post, upload, type Session } from './t3-helpers';
import { fetchAs } from './http-helpers';

/**
 * T-6 重启对账(AC-F21):任务排队/运行中服务重启时,app_job 标为 interrupted(SERVICE_RESTARTED),
 * 领域记录逐类型对齐——预测运行同步为失败且可重跑;报告保持已审批、可重新发布;
 * 敏感性分析与费用审核没有部分结果,可重新提交。失败/中断任务释放幂等键,重新提交会真正执行。
 */

const FF = '/api/forecast';
const FEAS = '/api/investment/feasibility';
const sample = JSON.parse(fs.readFileSync(path.join(__dirname, 'fixtures', 'investment_feasibility_yichongqiao.json'), 'utf8'));
const patch = (base: string, s: Session, url: string, body: unknown) =>
  fetchAs(s, `${base}${url}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });

async function ok(res: Response | Promise<Response>, status = 200) {
  const r = await res;
  const body = await r.json();
  expect(r.status, JSON.stringify(body)).toBe(status);
  return body;
}

async function forecastXlsx(): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  const p = wb.addWorksheet('参数');
  p.getCell('A1').value = '增长率';
  p.getCell('B1').value = 0.1;
  const f = wb.addWorksheet('预测');
  f.getCell('B1').value = 100;
  f.getCell('C1').value = { formula: 'B1*(1+参数!$B$1)', result: 110 };
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function waitJob(base: string, s: Session, jobId: number) {
  for (let i = 0; i < 400; i += 1) {
    const job = await json(get(base, s, `/api/jobs/${jobId}`));
    if (['succeeded', 'failed', 'cancelled', 'interrupted'].includes(job.status)) return job;
    await new Promise((r) => setTimeout(r, 25));
  }
  throw new Error('job timeout');
}

describe('T-6 重启对账', () => {
  it('预测/敏感性/报告发布/费用审核任务中断后逐类型对齐并可重新提交', async () => {
    const { base, db, admin, fx } = await boot('newfc-t6-restart-');

    // 预测:冻结版本
    const model = await ok(post(base, admin, `${FF}/models`, { name: '重启预测', orgId: fx.orgIds.shanghai, baseYear: 2026, horizonYears: 1 }), 201);
    let v = await ok(upload(base, admin, `${FF}/models/${model.id}/imports`, await forecastXlsx(), '预测.xlsx'), 201);
    v = await ok(patch(base, admin, `${FF}/versions/${v.id}`, {
      expectedVersion: v.version, params: [{ key: 'g', name: '增长率', cell: '参数!B1' }], outputs: [{ key: 'rev', name: '收入', ref: '预测!B1:C1' }],
    }));
    v = await ok(post(base, admin, `${FF}/versions/${v.id}/freeze`, { expectedVersion: v.version }));
    // 可研:方案
    const fp = await ok(post(base, admin, `${FEAS}/projects`, { code: 'RS-1', name: '重启测算', orgId: fx.orgIds.shanghai, constructionStartYear: 2026, operationStartYear: 2028, horizonYears: 30 }), 201);
    const sc = await ok(post(base, admin, `${FEAS}/projects/${fp.id}/scenarios`, { code: 'BASE', name: '基准', assumptions: sample.assumptions }), 201);
    // 报告:已审批(单人部署自审例外)
    let r = await ok(post(base, admin, '/api/analysis-reports', { kind: 'risk_investment', year: 2026 }), 201);
    r = await ok(post(base, admin, `/api/analysis-reports/${r.id}/submit`, { expectedVersion: r.version }));
    r = await ok(post(base, admin, `/api/analysis-reports/${r.id}/approve`, { expectedVersion: r.version, exceptionReason: '单人部署' }));
    expect(r.status).toBe('approved');
    // 报销:草稿
    let claim = await ok(post(base, admin, '/api/expense/claims', {
      orgId: fx.orgIds.shanghai, applicant: '李四', department: '财务部', expenseType: '办公费', amount: '100.00', occurredDate: '2026-05-10', description: '办公用品',
      lines: [{ expenseType: '办公费', amount: '100.00', invoiceNo: 'INV-R1', invoiceDate: '2026-05-10', description: '纸张' }],
    }), 201);

    // 占满并发:随后提交的领域任务都停在 queued,模拟“进程在执行前退出”
    let release!: () => void;
    const gate = new Promise<void>((res) => { release = res; });
    const blockers = Array.from({ length: jobConcurrency().limit }, (_, i) =>
      runWithContext(systemContext('cli'), () => submitJob(() => db, { kind: 'demo.block', title: `占位 ${i}` }, async () => { await gate; return {}; })));

    const run1 = await ok(post(base, admin, `${FF}/versions/${v.id}/runs`, { kind: 'baseline', params: {} }), 202);
    const sens1 = await ok(post(base, admin, `${FEAS}/scenarios/${sc.id}/sensitivity`, { expectedVersion: sc.version }), 202);
    const pub1 = await ok(post(base, admin, `/api/analysis-reports/${r.id}/publish`, { expectedVersion: r.version }), 202);
    const submitted = await ok(post(base, admin, `/api/expense/claims/${claim.id}/submit`, { expectedReviewVersion: claim.reviewVersion }));
    const auditJob = { id: submitted.jobId as number };
    for (const id of [run1.jobId, sens1.jobId, pub1.jobId, auditJob.id]) expect(getJobRow(db, id).status).toBe('queued');

    // 重启:遗留 queued/running 标为 interrupted;旧进程的队列不再执行这些任务
    expect(recoverInterruptedJobs(db)).toBe(4 + blockers.length);
    release();
    await Promise.all(blockers.map((b) => b.done));
    for (const id of [run1.jobId, sens1.jobId, pub1.jobId, auditJob.id]) {
      expect(getJobRow(db, id)).toMatchObject({ status: 'interrupted', error_code: 'SERVICE_RESTARTED', attempts: 0 });
    }
    const jobView = await json(get(base, admin, `/api/jobs/${pub1.jobId}`));
    expect(jobView).toMatchObject({ status: 'interrupted', kindLabel: '报告发布' });

    // 预测:查询时运行同步为失败,可重新运行基准
    const runs = await json(get(base, admin, `${FF}/versions/${v.id}/runs`));
    expect(runs.items[0]).toMatchObject({ id: run1.id, status: 'failed', errorCode: 'SERVICE_RESTARTED' });
    const run2 = await ok(post(base, admin, `${FF}/versions/${v.id}/runs`, { kind: 'baseline', params: {} }), 202);
    expect(run2.id).not.toBe(run1.id);
    expect((await waitJob(base, admin, run2.jobId)).status).toBe('succeeded');

    // 敏感性:没有部分结果;重新提交产生新任务并成功
    expect(db.prepare("SELECT COUNT(*) AS n FROM if_run WHERE kind = 'sensitivity'").get()).toEqual({ n: 0 });
    const sens2 = await ok(post(base, admin, `${FEAS}/scenarios/${sc.id}/sensitivity`, { expectedVersion: sc.version }), 202);
    expect(sens2.jobId).not.toBe(sens1.jobId);
    expect((await waitJob(base, admin, sens2.jobId)).status).toBe('succeeded');

    // 报告:保持已审批;同一版本重新发布不再返回中断任务(幂等键已释放)
    expect((await json(get(base, admin, `/api/analysis-reports/${r.id}`))).status).toBe('approved');
    const pub2 = await ok(post(base, admin, `/api/analysis-reports/${r.id}/publish`, { expectedVersion: r.version }), 202);
    expect(pub2.jobId).not.toBe(pub1.jobId);
    expect((await waitJob(base, admin, pub2.jobId)).status).toBe('succeeded');
    expect((await json(get(base, admin, `/api/analysis-reports/${r.id}`))).status).toBe('published');
    expect(getJobRow(db, pub1.jobId)).toMatchObject({ status: 'interrupted', idempotency_key: null });

    // 费用审核:报销单仍在审核中且没有审核运行;复核人重跑后进入待复核
    expect((await json(get(base, admin, `/api/expense/claims/${claim.id}`)))).toMatchObject({ status: 'submitted', runs: [] });
    const rerun = await ok(post(base, admin, `/api/expense/claims/${claim.id}/audit`, {}), 202);
    expect((await waitJob(base, admin, rerun.jobId)).status).toBe('succeeded');
    expect((await json(get(base, admin, `/api/expense/claims/${claim.id}`))).status).toBe('audited');
  });
});
