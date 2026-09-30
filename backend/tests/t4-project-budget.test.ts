import { describe, expect, it } from 'vitest';
import { boot, get, json, post, upload } from './t3-helpers';
import { createScopedUser } from './http-helpers';
import { count, createProject, factTablesDigest, xlsx, type Cell } from './t4-helpers';
import { standardBudgetVersion } from './helpers';

/** AC-F09 项目预算:导入 → 激活 → 汇总;校验失败不写库;不触碰经营预算事实;跨组织批次的范围规则。 */

const HEADER: Cell[] = ['项目编码', '项目名称', '资金来源', '费用类别', '年度预算', '已执行金额', '执行月份'];
const TITLE: Cell[][] = [['2026 年项目预算执行表'], ['单位:元'], []];

async function setup() {
  const t = await boot('newfc-t4-pb-');
  await createProject(t.base, t.admin, 'P-SH-01', '上海泵站改造', t.fx.orgIds.shanghai);
  await createProject(t.base, t.admin, 'P-SH-02', '上海管网巡检', t.fx.orgIds.shanghai);
  await createProject(t.base, t.admin, 'P-NJ-01', '南京水厂扩建', t.fx.orgIds.nanjing);
  return t;
}

const sample = () => xlsx([
  ...TITLE, HEADER,
  ['P-SH-01', '上海泵站改造', '自有资金', '工程', '1,000,000.00', 250000, '2026-05'],
  ['P-SH-02', '上海管网巡检', '财政资金', '', 500000, 0, '2026年5月'],
]);

describe('T-4 项目预算(AC-F09)', () => {
  it('两行样本:预览与导入一致,执行率 0.166667;幂等重放;激活须带期望当前批次;经营预算事实不变', async () => {
    const { base, db, admin, fx } = await setup();
    standardBudgetVersion(fx);
    const before = factTablesDigest(db);
    const file = await sample();
    const form = { year: '2026', period: '2026-05', name: '2026-05 项目预算' };

    const preview = await json(upload(base, admin, '/api/project-budget/preview', file, 'pb.xlsx', form));
    expect(preview.valid).toBe(true);
    expect(preview.errors).toEqual([]);
    expect(preview.totals).toEqual({ budget: '1500000.00', executed: '250000.00', remaining: '1250000.00', executionRate: '0.166667' });
    expect(preview.rows[0]).toMatchObject({ projectCode: 'P-SH-01', orgName: '上海公司', executionRate: '0.250000', execMonth: '2026-05' });
    expect(preview.rows[1]).toMatchObject({ projectCode: 'P-SH-02', executionRate: '0.000000' });
    expect(count(db, 'pb_batch')).toBe(0);

    const res = await upload(base, admin, '/api/project-budget/import', file, 'pb.xlsx', form);
    expect(res.status).toBe(201);
    const batch = await json(res);
    expect(batch).toMatchObject({ year: 2026, period: '2026-05', name: '2026-05 项目预算', rowCount: 2, isCurrent: false, partial: false });
    expect(batch.totals.executionRate).toBe('0.166667');
    const replay = await upload(base, admin, '/api/project-budget/import', file, 'pb.xlsx', form);
    expect(replay.status).toBe(200);
    expect((await json(replay))).toMatchObject({ id: batch.id, replayed: true });
    expect(count(db, 'pb_batch')).toBe(1);

    // 没有当前批次时汇总给出说明
    expect((await json(get(base, admin, '/api/project-budget/summary?year=2026'))).notes[0]).toMatch(/没有已激活/);
    const act = await post(base, admin, `/api/project-budget/batches/${batch.id}/activate`, { expectedCurrentBatchId: null });
    expect(act.status).toBe(200);
    expect((await json(act)).isCurrent).toBe(true);

    const summary = await json(get(base, admin, '/api/project-budget/summary?year=2026'));
    expect(summary.batch.id).toBe(batch.id);
    expect(summary.totals).toEqual({ budget: '1500000.00', executed: '250000.00', remaining: '1250000.00', executionRate: '0.166667' });
    expect(summary.byProject.map((p: { projectCode: string; executionRate: string }) => [p.projectCode, p.executionRate])).toEqual([['P-SH-01', '0.250000'], ['P-SH-02', '0.000000']]);
    expect(summary.byFundSource.map((g: { label: string }) => g.label).sort()).toEqual(['自有资金', '财政资金'].sort());

    // 同期间第二个批次:不带期望当前批次被拒,带上后替换
    const file2 = await xlsx([HEADER, ['P-SH-01', '上海泵站改造', '自有资金', '工程', 1000000, 400000, '2026-05']]);
    const b2 = await json(upload(base, admin, '/api/project-budget/import', file2, 'pb2.xlsx', form));
    const stale = await post(base, admin, `/api/project-budget/batches/${b2.id}/activate`, { expectedCurrentBatchId: null });
    expect(stale.status).toBe(409);
    expect((await json(stale))).toMatchObject({ code: 'CURRENT_BATCH_CHANGED' });
    expect((await post(base, admin, `/api/project-budget/batches/${b2.id}/activate`, { expectedCurrentBatchId: batch.id })).status).toBe(200);
    expect((await json(get(base, admin, '/api/project-budget/summary?year=2026&period=2026-05'))).totals.executionRate).toBe('0.400000');
    expect((await json(get(base, admin, `/api/project-budget/batches/${batch.id}`))).isCurrent).toBe(false);

    // 作废须填原因;作废后不能激活
    expect((await post(base, admin, `/api/project-budget/batches/${batch.id}/void`, {})).status).toBe(400);
    const voided = await json(post(base, admin, `/api/project-budget/batches/${batch.id}/void`, { reason: '重复上报' }));
    expect(voided).toMatchObject({ status: 'voided', voidReason: '重复上报' });
    const again = await post(base, admin, `/api/project-budget/batches/${batch.id}/activate`, { expectedCurrentBatchId: b2.id });
    expect(again.status).toBe(409);

    const original = await get(base, admin, `/api/project-budget/batches/${batch.id}/original`);
    expect(Buffer.from(await original.arrayBuffer())).toEqual(file);

    expect(factTablesDigest(db)).toEqual(before);
    const actions = (db.prepare("SELECT action FROM operation_log WHERE action LIKE 'project_budget.%' ORDER BY id").all() as { action: string }[]).map((r) => r.action);
    expect(actions).toEqual(['project_budget.import', 'project_budget.activate', 'project_budget.import', 'project_budget.activate', 'project_budget.void']);
  });

  it('行期间不符、项目名称不符、负金额、未知项目、重复键逐行报错,导入 422 且不写库', async () => {
    const { base, db, admin } = await setup();
    const file = await xlsx([
      HEADER,
      ['P-SH-01', '上海泵站改造', '自有资金', '工程', 100, 10, '2026-04'],
      ['P-SH-02', '错误名称', '自有资金', '', 100, 10, '2026-05'],
      ['P-SH-02', '上海管网巡检', '自有资金', '', -1, 0, '2026-05'],
      ['P-XX-99', '不存在', '自有资金', '', 1, 0, '2026-05'],
      ['P-NJ-01', '南京水厂扩建', '自有资金', '', 1, 0, '2026-05'],
      ['P-NJ-01', '南京水厂扩建', '自有资金', '', 2, 0, '2026-05'],
      ['P-NJ-01', '南京水厂扩建', '', '其他', '1.001', 0, '2026-05'],
    ]);
    const form = { year: '2026', period: '2026-05' };
    const preview = await json(upload(base, admin, '/api/project-budget/preview', file, 'bad.xlsx', form));
    expect(preview.valid).toBe(false);
    const msgs = preview.errors.map((e: { row: number; message: string }) => `${e.row}:${e.message}`);
    expect(msgs).toEqual(expect.arrayContaining([
      expect.stringMatching(/^2:执行月份 2026-04 与本次导入期间 2026-05 不一致/),
      expect.stringMatching(/^3:项目名称“错误名称”与主数据“上海管网巡检”不一致/),
      expect.stringMatching(/^4:年度预算不能为负/),
      expect.stringMatching(/^5:项目编码 P-XX-99 不存在或无权访问/),
      expect.stringMatching(/^7:与第 6 行/),
      expect.stringMatching(/^8:资金来源不能为空/),
      expect.stringMatching(/^8:年度预算「1.001」不是合法金额/),
    ]));
    const res = await upload(base, admin, '/api/project-budget/import', file, 'bad.xlsx', form);
    expect(res.status).toBe(422);
    const body = await json(res);
    expect(body.code).toBe('IMPORT_INVALID');
    expect(body.errors.length).toBe(preview.errors.length);
    expect(count(db, 'pb_batch')).toBe(0);
    expect(count(db, 'pb_entry')).toBe(0);
    expect(count(db, 'file_object')).toBe(0);

    // 期间不在年度内、缺必需表头
    expect((await upload(base, admin, '/api/project-budget/preview', file, 'bad.xlsx', { year: '2025', period: '2026-05' })).status).toBe(400);
    const noHeader = await upload(base, admin, '/api/project-budget/preview', await xlsx([['项目编码', '项目名称']]), 'x.xlsx', form);
    expect(noHeader.status).toBe(400);
    expect((await json(noHeader)).message).toMatch(/未找到项目预算表头/);
  });

  it('万元表头按 ×10000 精确换算,折合不足一分时报错', async () => {
    const { base, admin } = await setup();
    const header = ['项目编码', '项目名称', '资金来源', '年度预算(万元)', '已执行金额(万元)', '执行月份'];
    const ok = await json(upload(base, admin, '/api/project-budget/preview', await xlsx([header, ['P-SH-01', '上海泵站改造', '自有资金', '100', '12.345678', '2026-05']]), 'w.xlsx', { year: '2026', period: '2026-05' }));
    expect(ok.valid).toBe(true);
    expect(ok.totals).toMatchObject({ budget: '1000000.00', executed: '123456.78' });
    const bad = await json(upload(base, admin, '/api/project-budget/preview', await xlsx([header, ['P-SH-01', '上海泵站改造', '自有资金', '100', '0.0000001', '2026-05']]), 'w.xlsx', { year: '2026', period: '2026-05' }));
    expect(bad.errors[0].message).toMatch(/不是合法万元金额/);
  });

  it('受限用户:只看范围内明细;跨组织批次激活/作废 SCOPE_RESTRICTED;范围外批次 404;范围外项目按不存在报错', async () => {
    const { base, db, admin, fx } = await setup();
    const mixed = await xlsx([
      HEADER,
      ['P-SH-01', '上海泵站改造', '自有资金', '', 1000000, 250000, '2026-05'],
      ['P-NJ-01', '南京水厂扩建', '自有资金', '', 3000000, 3000000, '2026-05'],
    ]);
    const form = { year: '2026', period: '2026-05' };
    const mixedBatch = await json(upload(base, admin, '/api/project-budget/import', mixed, 'mixed.xlsx', form));
    const nj = await json(upload(base, admin, '/api/project-budget/import', await xlsx([HEADER, ['P-NJ-01', '南京水厂扩建', '自有资金', '', 1, 0, '2026-06']]), 'nj.xlsx', { year: '2026', period: '2026-06' }));
    const sh = createScopedUser(db, { username: 'pb-sh', roleCodes: ['data_maintainer'], orgIds: [fx.orgIds.shanghai] }).session;

    const list = await json(get(base, sh, '/api/project-budget/batches'));
    expect(list.map((b: { id: number }) => b.id)).toEqual([mixedBatch.id]);
    expect(list[0]).toMatchObject({ partial: true, orgNames: ['上海公司'] });
    expect(list[0].totals).toMatchObject({ budget: '1000000.00', executed: '250000.00', executionRate: '0.250000' });
    const entries = await json(get(base, sh, `/api/project-budget/batches/${mixedBatch.id}/entries`));
    expect(entries.map((e: { projectCode: string }) => e.projectCode)).toEqual(['P-SH-01']);
    expect((await get(base, sh, `/api/project-budget/batches/${nj.id}`)).status).toBe(404);
    expect((await get(base, sh, `/api/project-budget/batches/${nj.id}/entries`)).status).toBe(404);
    expect((await get(base, sh, `/api/project-budget/batches/${mixedBatch.id}/original`)).status).toBe(403);

    const act = await post(base, sh, `/api/project-budget/batches/${mixedBatch.id}/activate`, { expectedCurrentBatchId: null });
    expect(act.status).toBe(403);
    expect((await json(act)).code).toBe('SCOPE_RESTRICTED');
    expect((await post(base, sh, `/api/project-budget/batches/${mixedBatch.id}/void`, { reason: 'x' })).status).toBe(403);
    expect((await post(base, sh, `/api/project-budget/batches/${nj.id}/void`, { reason: 'x' })).status).toBe(404);

    // 管理员激活后,受限用户汇总只含范围内
    await post(base, admin, `/api/project-budget/batches/${mixedBatch.id}/activate`, { expectedCurrentBatchId: null });
    const summary = await json(get(base, sh, '/api/project-budget/summary?year=2026&period=2026-05'));
    expect(summary.totals).toMatchObject({ budget: '1000000.00', executionRate: '0.250000' });
    expect(summary.byOrg.map((o: { label: string }) => o.label)).toEqual(['上海公司']);
    expect((await get(base, sh, `/api/project-budget/summary?orgId=${fx.orgIds.nanjing}`)).status).toBe(404);

    // 受限用户导入范围外项目:按不存在报错
    const outside = await json(upload(base, sh, '/api/project-budget/preview', await xlsx([HEADER, ['P-NJ-01', '南京水厂扩建', '自有资金', '', 1, 0, '2026-05']]), 'o.xlsx', form));
    expect(outside.errors[0].message).toMatch(/不存在或无权访问/);
    // 只读角色不能导入
    const viewer = createScopedUser(db, { username: 'pb-viewer', roleCodes: ['viewer'], orgIds: [fx.orgIds.shanghai] }).session;
    expect((await upload(base, viewer, '/api/project-budget/import', await sample(), 'pb.xlsx', form)).status).toBe(403);
  });
});
