import { describe, expect, it } from 'vitest';
import { boot, get, json, post, upload } from './t3-helpers';
import { createScopedUser } from './http-helpers';
import { count, createProject, xlsxSheets, type Cell } from './t4-helpers';

/**
 * AC-F15 计划执行:万元模板精确换算;同年取数规则(当期 = 本期年度累计 − 同年上期);
 * 不用开工累计兜底年度实际;形象进度只来自形象进度列;逐行校验不写库;组织范围。
 */

const INV_HEADER: Cell[] = ['序号', '项目编码', '项目名称', '承办单位', '批复概算', '总投资', '开工累计已完成投资', '本年计划投资', '本年实际完成投资', '形象进度', '累计已付款'];

function workbook(opts: { shActual: Cell; njActual: Cell; title?: string }) {
  return xlsxSheets({
    '固定资产投资计划': [
      [opts.title ?? '2026年固定资产投资计划'], ['单位:万元'], INV_HEADER,
      ['一', '', '水利工程', '', null, null, null, null, null, null, null],
      ['1', 'P-SH-01', '上海泵站改造', '上海公司', 12000, 10000, 3000, 2000, opts.shActual, '45%', 2500],
      ['2', 'P-SH-02', '上海管网巡检', '', null, 5000, 1000, 1000, null, null, null],
      ['3', 'P-NJ-01', '南京水厂扩建', '', null, 1000, 0, 500, opts.njActual, '0.1', null],
      ['', '', '合计', '', null, 16000, 4000, 3500, null, null, null],
    ],
    '固定资产购置计划': [
      ['2026年固定资产购置计划'], ['序号', '资产名称', '承办单位', '单位', '数量', '单价', '合价', '年度计划'],
      ['1', '水泵', '上海公司', '台', 2, '1.5', 3, 3],
    ],
    '运行维护费': [
      ['序号', '费用项目', '承办单位', '年度计划(元)', '年度实际(元)'],
      ['1', '设备维护', '上海公司', 1000000, 200000],
    ],
    '填表说明': [['本表仅供参考']],
  });
}

async function setup() {
  const t = await boot('newfc-t4-plan-');
  await createProject(t.base, t.admin, 'P-SH-01', '上海泵站改造', t.fx.orgIds.shanghai);
  await createProject(t.base, t.admin, 'P-SH-02', '上海管网巡检', t.fx.orgIds.shanghai);
  await createProject(t.base, t.admin, 'P-NJ-01', '南京水厂扩建', t.fx.orgIds.nanjing);
  return t;
}

async function importAndActivate(t: Awaited<ReturnType<typeof setup>>, file: Buffer, actualPeriod: string, expected: number | null = null) {
  const res = await upload(t.base, t.admin, '/api/plan/import', file, `plan-${actualPeriod}.xlsx`, { year: '2026', actualPeriod });
  expect(res.status, await res.clone().text()).toBe(201);
  const batch = await json(res);
  const act = await post(t.base, t.admin, `/api/plan/batches/${batch.id}/activate`, { expectedCurrentBatchId: expected });
  expect(act.status, await act.clone().text()).toBe(200);
  return batch;
}

describe('T-4 计划执行(AC-F15)', () => {
  it('万元样本:5 月累计完成率 0.300000;6 月当期 300 万、年度执行率 0.550000;缺年度实际不可计算且不兜底;形象进度只取本列', async () => {
    const t = await setup();
    const { base, admin } = t;
    const may = await workbook({ shActual: 800, njActual: 100 });
    const preview = await json(upload(base, admin, '/api/plan/preview', may, 'plan.xlsx', { year: '2026', actualPeriod: '2026-05' }));
    expect(preview.errors).toEqual([]);
    expect(preview.ignoredSheets).toEqual(['填表说明']);
    expect(preview.sheets.map((s: { code: string; detailCount: number; unit: string }) => [s.code, s.detailCount, s.unit]))
      .toEqual([['investment', 3, 'wan'], ['purchase', 1, 'wan'], ['maintenance', 1, 'wan']]);
    const sh01 = preview.previewItems.find((i: { projectCode: string }) => i.projectCode === 'P-SH-01');
    expect(sh01).toMatchObject({ itemType: 'detail', path: '水利工程', orgName: '上海公司' });
    expect(sh01.facts.find((f: { fieldKey: string }) => f.fieldKey === 'total_investment')).toMatchObject({ measure: 'total', value: '100000000.00', sourceCell: '固定资产投资计划!F5' });
    expect(sh01.facts.find((f: { fieldKey: string }) => f.fieldKey === 'physical_progress')).toMatchObject({ measure: 'snapshot', value: '0.450000' });
    expect(preview.previewItems.find((i: { itemName: string }) => i.itemName === '水泵').facts.find((f: { fieldKey: string }) => f.fieldKey === 'quantity').value).toBe('2');

    const mayBatch = await importAndActivate(t, may, '2026-05');
    const mayProjects = await json(get(base, admin, '/api/plan/projects?year=2026'));
    const p1 = mayProjects.rows.find((r: { projectCode: string }) => r.projectCode === 'P-SH-01');
    expect(p1).toMatchObject({
      totalInvestment: '100000000.00', completedCumulative: '30000000.00', cumulativeRate: '0.300000', annualPlan: '20000000.00',
      annualActualYtd: '8000000.00', annualRate: '0.400000', physicalProgress: '0.450000', paidCumulative: '25000000.00', status: 'normal',
      approvedBudget: '120000000.00',
    });
    expect(p1.period).toMatchObject({ value: null, reason: '无同年上期批次' });
    // 缺年度实际:不可计算,不用开工累计已完成投资兜底;形象进度缺失为 null(不用投资完成比例冒充)
    const p2 = mayProjects.rows.find((r: { projectCode: string }) => r.projectCode === 'P-SH-02');
    expect(p2).toMatchObject({ annualActualYtd: null, annualRate: null, status: 'not_computable', completedCumulative: '10000000.00', cumulativeRate: '0.200000', physicalProgress: null });

    const june = await workbook({ shActual: 1100, njActual: 100 });
    await importAndActivate(t, june, '2026-06');
    const juneProjects = await json(get(base, admin, '/api/plan/projects?year=2026'));
    const j1 = juneProjects.rows.find((r: { projectCode: string }) => r.projectCode === 'P-SH-01');
    expect(j1).toMatchObject({ annualActualYtd: '11000000.00', annualRate: '0.550000', status: 'normal' });
    expect(j1.period).toMatchObject({ value: '3000000.00', reason: null, previousBatchId: mayBatch.id, previousPeriod: '2026-05' });
    expect(juneProjects.rows.find((r: { projectCode: string }) => r.projectCode === 'P-SH-02').period.reason).toBe('本期无年度累计实际');

    const overview = await json(get(base, admin, '/api/plan/overview?year=2026'));
    expect(overview.batch.actualPeriod).toBe('2026-06');
    const inv = overview.sheets.find((s: { code: string }) => s.code === 'investment');
    expect(inv).toMatchObject({ annualPlan: '35000000.00', annualActualYtd: '12000000.00', annualRate: '0.480000', cumulativeRate: '0.250000' });
    expect(inv.period).toMatchObject({ value: '3000000.00' });
    expect(inv.statusCounts).toEqual({ not_computable: 1, over_plan: 0, slow: 1, normal: 1 });
    expect(inv.notes[0]).toMatch(/1 行缺年度计划或年度累计实际/);
    const purchase = overview.sheets.find((s: { code: string }) => s.code === 'purchase');
    expect(purchase).toMatchObject({ annualPlan: '30000.00', annualActualYtd: null, annualRate: null });
    expect(purchase.notes.join()).toMatch(/执行率不可计算/);
    const maintenance = overview.sheets.find((s: { code: string }) => s.code === 'maintenance');
    expect(maintenance).toMatchObject({ annualPlan: '1000000.00', annualActualYtd: '200000.00', annualRate: '0.200000' });
    expect(maintenance.statusCounts.slow).toBe(1);

    // 截至 5 月:回到 5 月批次,上期不存在
    const asOfMay = await json(get(base, admin, '/api/plan/overview?year=2026&asOfPeriod=2026-05'));
    expect(asOfMay.batch.id).toBe(mayBatch.id);
    expect(asOfMay.notes).toEqual(['无同年上期批次:当期发生额不可计算']);
    // 其他年度没有批次:跨年不取
    expect((await json(get(base, admin, '/api/plan/overview?year=2027'))).batch).toBeNull();
    expect((await get(base, admin, '/api/plan/overview?year=2026&asOfPeriod=2025-12')).status).toBe(400);
  });

  it('表头年度不符、投资明细缺项目编码、数值不可解析、形象进度 >1 无 %、承办单位无法解析:422 不写库', async () => {
    const { base, db, admin } = await setup();
    const wrongYear = await workbook({ shActual: 800, njActual: 100, title: '2025年固定资产投资计划' });
    const e1 = await json(upload(base, admin, '/api/plan/preview', wrongYear, 'p.xlsx', { year: '2026', actualPeriod: '2026-05' }));
    expect(e1.errors.map((e: { message: string }) => e.message)).toContain('表头年度 2025 与上传年度 2026 不一致');

    const bad = await xlsxSheets({
      '固定资产投资计划': [INV_HEADER,
        ['1', '', '无编码项目', '', null, 100, 10, 50, 5, null, null],
        ['2', 'P-SH-01', '上海泵站改造', '', null, 'abc', 10, 50, 5, '45', null],
      ],
      '运行维护费': [['序号', '费用项目', '承办单位', '年度计划', '年度实际'], ['1', '保洁', '不存在的单位', 1, 1]],
    });
    const res = await upload(base, admin, '/api/plan/import', bad, 'bad.xlsx', { year: '2026', actualPeriod: '2026-05' });
    expect(res.status).toBe(422);
    const body = await json(res);
    const msgs = body.errors.map((e: { row: number; message: string }) => `${e.row}:${e.message}`);
    expect(msgs).toEqual(expect.arrayContaining([
      '2:投资明细行缺项目编码',
      expect.stringMatching(/^3:总投资「abc」不是合法万元金额/),
      expect.stringMatching(/^3:形象进度「45」大于 1 且没有 %/),
      expect.stringMatching(/^2:承办单位“不存在的单位”未匹配到组织/),
    ]));
    expect(count(db, 'plan_batch')).toBe(0);
    expect(count(db, 'plan_item')).toBe(0);
    expect(count(db, 'file_object')).toBe(0);
  });

  it('受限用户:概览只含范围内明细;含合计行的批次不能导入/激活;范围外项目 404', async () => {
    const t = await setup();
    const { base, db, admin, fx } = t;
    const batch = await importAndActivate(t, await workbook({ shActual: 800, njActual: 100 }), '2026-05');
    const sh = createScopedUser(db, { username: 'plan-sh', roleCodes: ['data_maintainer'], orgIds: [fx.orgIds.shanghai] }).session;
    const overview = await json(get(base, sh, '/api/plan/overview?year=2026'));
    expect(overview.batch).toMatchObject({ id: batch.id, partial: true, orgNames: ['上海公司'] });
    const inv = overview.sheets.find((s: { code: string }) => s.code === 'investment');
    expect(inv).toMatchObject({ detailCount: 2, annualPlan: '30000000.00', annualActualYtd: '8000000.00', annualRate: '0.400000' });
    const items = await json(get(base, sh, `/api/plan/batches/${batch.id}/items`));
    expect(items.every((i: { orgName: string | null }) => i.orgName === '上海公司')).toBe(true);
    expect(items.some((i: { itemType: string }) => i.itemType !== 'detail')).toBe(false);
    expect((await json(get(base, sh, '/api/plan/projects?year=2026'))).rows.map((r: { projectCode: string }) => r.projectCode)).toEqual(['P-SH-01', 'P-SH-02']);
    expect((await get(base, sh, `/api/plan/projects?year=2026&orgId=${fx.orgIds.nanjing}`)).status).toBe(404);

    const act = await post(base, sh, `/api/plan/batches/${batch.id}/void`, { reason: 'x' });
    expect(act.status).toBe(403);
    expect((await json(act)).code).toBe('SCOPE_RESTRICTED');
    const imp = await upload(base, sh, '/api/plan/import', await xlsxSheets({
      '运行维护费': [['序号', '费用项目', '承办单位', '年度计划', '年度实际'], ['一', '日常', '', null, null], ['1', '保洁', '上海公司', 1, 1]],
    }), 'sh.xlsx', { year: '2026', actualPeriod: '2026-06' });
    expect(imp.status).toBe(403);
    // 只有范围内明细的文件可以导入
    const ok = await upload(base, sh, '/api/plan/import', await xlsxSheets({
      '运行维护费': [['序号', '费用项目', '承办单位', '年度计划', '年度实际'], ['1', '保洁', '上海公司', 1, 1]],
    }), 'sh.xlsx', { year: '2026', actualPeriod: '2026-06' });
    expect(ok.status).toBe(201);
  });
});
