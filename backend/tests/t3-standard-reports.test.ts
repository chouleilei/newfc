/**
 * T-3 标准报表(AC-F19):生成冻结 → 页面/导出只读冻结内容 → 复核一次;三类报表取数;组织范围。
 */
import { describe, it, expect } from 'vitest';
import ExcelJS from 'exceljs';
import { budget, org, saveActualSnapshot, standardBudgetVersion } from './helpers';
import { createScopedUser } from './http-helpers';
import { boot, easSample, EAS_V600, get, json, post, upload, type Session } from './t3-helpers';
import { statementWorkbook } from './t3-statement-sample';

async function exportRows(base: string, s: Session, id: number) {
  const res = await get(base, s, `/api/standard-reports/${id}/export`);
  expect(res.status).toBe(200);
  expect(res.headers.get('content-type')).toContain('spreadsheetml');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.from(await res.arrayBuffer()) as never);
  const ws = wb.worksheets[0];
  const out: unknown[][] = [];
  ws.eachRow({ includeEmpty: true }, (row) => { out.push((row.values as unknown[]).slice(1)); });
  return out;
}

/** 页面行 → 导出单元格的期望值(金额/比率按列格式的数字,文本原样)。 */
function asCells(report: any): unknown[][] {
  return report.rows.map((r: any) => report.columns.map((c: any) => {
    const v = r[c.key];
    if (v === null || v === undefined) return undefined;
    return c.kind === 'money' || c.kind === 'ratio' ? Number(v) : v;
  }));
}

describe('T-3 标准报表', () => {
  it('经营预算执行表冻结生成;实际数变化后页面与导出不变且逐行一致;复核一次,生成人不能自审', async () => {
    const { base, db, admin, fx } = await boot();
    const v = standardBudgetVersion(fx);
    budget.lockVersion(db, v.id);
    budget.setCurrentVersion(db, v.id);
    saveActualSnapshot(fx, 2026, '2026-06-30', [
      { orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '80.00' },
      { orgId: fx.orgIds.hangzhou, accountId: fx.accIds.incomeMain, amount: '60.00' },
    ]);
    const analyst = createScopedUser(db, { username: 'sr-analyst', roleCodes: ['finance_analyst', 'business_reviewer'], allOrgs: true });
    const reviewer = createScopedUser(db, { username: 'sr-rev', roleCodes: ['business_reviewer'], allOrgs: true });
    const viewer = createScopedUser(db, { username: 'sr-view', roleCodes: ['viewer'], allOrgs: true });
    expect((await post(base, viewer.session, '/api/standard-reports', { reportType: 'budget_execution', year: 2026 })).status).toBe(403);

    const res = await post(base, analyst.session, '/api/standard-reports', { reportType: 'budget_execution', year: 2026 });
    expect(res.status, await res.clone().text()).toBe(201);
    const rep = await res.json() as any;
    const i01 = rep.rows.find((r: any) => r.code === 'I01');
    expect(i01).toMatchObject({ budget: '150.00', actual: '140.00', variance: '-10.00', rate: '0.933333' });
    expect(rep.rows.find((r: any) => r.code === 'C01')).toMatchObject({ budget: '90.00', actual: '0.00', rate: '0.000000' });
    expect(rep.sources).toMatchObject({ budgetVersionId: v.id, actualSource: 'current' });
    expect(rep.status).toBe('generated');

    // 来源变化后,已生成报表不变
    saveActualSnapshot(fx, 2026, '2026-07-31', [{ orgId: fx.orgIds.shanghai, accountId: fx.accIds.incomeMain, amount: '99.00' }]);
    const again = await json(get(base, viewer.session, `/api/standard-reports/${rep.id}`));
    expect(again.rows).toEqual(rep.rows);
    expect(again.contentSha256).toBe(rep.contentSha256);
    expect(() => db.prepare('UPDATE std_report SET rows_json = ? WHERE id = ?').run('[]', rep.id)).toThrow(/不可修改/);

    const cells = await exportRows(base, viewer.session, rep.id);
    const headerIdx = cells.findIndex((r) => r[0] === '科目编码');
    expect(cells[headerIdx]).toEqual(rep.columns.map((c: any) => c.label));
    const expected = asCells(rep);
    const body = cells.slice(headerIdx + 1, headerIdx + 1 + rep.rows.length);
    expect(body).toHaveLength(expected.length);
    expected.forEach((row, i) => row.forEach((v, j) => expect(body[i][j] ?? undefined).toEqual(v)));

    expect((await post(base, viewer.session, `/api/standard-reports/${rep.id}/review`, {})).status).toBe(403);
    expect((await json(post(base, analyst.session, `/api/standard-reports/${rep.id}/review`, {}))).code).toBe('SELF_REVIEW_FORBIDDEN');
    const reviewed = await json(post(base, reviewer.session, `/api/standard-reports/${rep.id}/review`, { comment: '核对无误' }));
    expect(reviewed).toMatchObject({ status: 'reviewed', reviewComment: '核对无误', selfReview: false });
    const twice = await post(base, reviewer.session, `/api/standard-reports/${rep.id}/review`, {});
    expect(twice.status).toBe(409);
    expect((await twice.json() as any).code).toBe('REPORT_ALREADY_REVIEWED');
    const actions = (db.prepare("SELECT action FROM operation_log WHERE entity_type = 'std_report' AND entity_id = ? ORDER BY id").all(String(rep.id)) as { action: string }[]).map((r) => r.action);
    expect(actions).toEqual(['report.standard.generate', 'report.standard.export', 'report.standard.review']);
  });

  it('财务报表摘要读当前财报批次;EAS 对账结果表读当前集合规则结果;缺来源 409', async () => {
    const { base, db, admin, fx } = await boot();
    const missing = await post(base, admin, '/api/standard-reports', { reportType: 'statement_summary', orgId: fx.orgIds.shanghai, period: '2026-05' });
    expect((await missing.json() as any).code).toBe('REPORT_SOURCE_MISSING');

    const imp = await upload(base, admin, '/api/statements/import', await statementWorkbook(), 'fs.xlsx', { orgId: String(fx.orgIds.shanghai), period: '2026-05', scope: 'consolidated' });
    expect(imp.status, await imp.clone().text()).toBe(201);
    const batch = await imp.json() as any;
    expect((await post(base, admin, `/api/statements/batches/${batch.id}/activate`, { expectedCurrentBatchId: null })).status).toBe(200);
    const fs = await json(post(base, admin, '/api/standard-reports', { reportType: 'statement_summary', orgId: fx.orgIds.shanghai, period: '2026-05' }));
    const amount = (k: string) => fs.rows.find((r: any) => r.key === k).amount;
    expect(amount('total_assets_period_end')).toBe('1000000.00');
    expect(amount('net_profit_ytd')).toBe('60000.00');
    expect(fs.summary.find((s: any) => s.label === '资产负债率').value).toBe('0.420000');
    expect(fs.sources.statementBatchId).toBe(batch.id);

    const ls = org.createOrg(db, { parentId: null, code: 'LS', name: '澧水公司' }).id;
    for (const [type, file] of EAS_V600) {
      expect((await upload(base, admin, '/api/eas/import', easSample(file), file, { dataType: type })).status).toBeLessThan(300);
    }
    const set = await json(post(base, admin, '/api/eas/precheck', { orgId: ls, period: '2026-05' }));
    expect((await post(base, admin, `/api/eas/sets/${set.id}/activate`, { expectedVersion: set.version, expectedCurrentSetId: null })).status).toBe(200);
    const eas = await json(post(base, admin, '/api/standard-reports', { reportType: 'eas_recon', orgId: ls, period: '2026-05' }));
    expect(eas.rows.map((r: any) => [r.ruleCode, r.status])).toEqual(set.results.map((r: any) => [r.ruleCode, r.status]));
    expect(eas.rows.find((r: any) => r.ruleCode === 'period_continuity').status).toBe('warning');
    expect(eas.sources).toMatchObject({ easSetId: set.id, easSetVersion: expect.any(Number) });
    const cells = await exportRows(base, admin, eas.id);
    const headerIdx = cells.findIndex((r) => r[0] === '规则编码');
    expect(cells.slice(headerIdx + 1, headerIdx + 1 + eas.rows.length).map((r) => [r[0], r[2], r[3], r[4]]))
      .toEqual(eas.rows.map((r: any) => [r.ruleCode, r.status, r.diffCount, Number(r.diffAmount)]));
  });

  it('受限用户只能生成/查看授权组织的报表;全组织口径需要全组织权限', async () => {
    const { base, db, admin, fx } = await boot();
    const v = standardBudgetVersion(fx);
    budget.lockVersion(db, v.id);
    budget.setCurrentVersion(db, v.id);
    const sh = createScopedUser(db, { username: 'sr-sh', roleCodes: ['finance_analyst'], orgIds: [fx.orgIds.shanghai] });
    const all = await post(base, sh.session, '/api/standard-reports', { reportType: 'budget_execution', year: 2026 });
    expect((await all.json() as any).code).toBe('SCOPE_RESTRICTED');
    expect((await post(base, sh.session, '/api/standard-reports', { reportType: 'budget_execution', year: 2026, orgId: fx.orgIds.hangzhou })).status).toBe(404);
    expect((await post(base, sh.session, '/api/standard-reports', { reportType: 'eas_recon', orgId: fx.orgIds.hangzhou, period: '2026-05' })).status).toBe(404);
    const own = await json(post(base, sh.session, '/api/standard-reports', { reportType: 'budget_execution', year: 2026, orgId: fx.orgIds.shanghai }));
    expect(own.rows.find((r: any) => r.code === 'I01').budget).toBe('100.00');
    const group = await json(post(base, admin, '/api/standard-reports', { reportType: 'budget_execution', year: 2026 }));
    const hz = await json(post(base, admin, '/api/standard-reports', { reportType: 'budget_execution', year: 2026, orgId: fx.orgIds.hangzhou }));
    expect((await json(get(base, sh.session, '/api/standard-reports'))).map((r: any) => r.id)).toEqual([own.id]);
    expect((await get(base, sh.session, `/api/standard-reports/${group.id}`)).status).toBe(404);
    expect((await get(base, sh.session, `/api/standard-reports/${hz.id}/export`)).status).toBe(404);
    expect((await json(get(base, admin, '/api/standard-reports?reportType=budget_execution'))).length).toBe(3);
  });
});
