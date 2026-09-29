/**
 * T-3 财务报表(AC-F10):预览 → 导入 → 激活 → 总览;勾稽拒绝、幂等、并发激活、作废、公式/文本单元格、组织范围、治理来源。
 *
 * 样本(与 lishui 验收口径一致,元):总资产 1,000,000.00、负债 420,000.00、权益 580,000.00、
 * 营业总收入(本年累计)300,000.00、净利润(本年累计)60,000.00 → 资产负债率 0.420000。
 */
import { describe, it, expect } from 'vitest';
import type ExcelJS from 'exceljs';
import { createScopedUser } from './http-helpers';
import { boot, get, json, post, upload } from './t3-helpers';
import { statementWorkbook as workbook } from './t3-statement-sample';

const form = (orgId: number, extra: Record<string, string> = {}) => ({ orgId: String(orgId), period: '2026-05', scope: 'consolidated', ...extra });

describe('T-3 财务报表', () => {
  it('预览只解析不写库;不平衡模板 BALANCE_NOT_EQUAL,导入被拒绝且不留批次与原件', async () => {
    const { base, db, admin, fx } = await boot();
    const ok = await json(upload(base, admin, '/api/statements/preview', await workbook(), 'fs.xlsx', form(fx.orgIds.shanghai)));
    expect(ok.valid).toBe(true);
    expect(ok.sheets.map((s: any) => s.code)).toEqual(['balance_sheet', 'income_statement', 'cash_flow_statement', 'equity_change_statement']);
    expect(ok.ignoredSheets).toEqual(['说明']);
    expect(ok.metrics).toMatchObject({ total_assets_period_end: '1000000.00', revenue_ytd: '300000.00', cash_beginning_ytd: null });
    expect((db.prepare('SELECT COUNT(*) AS c FROM stmt_batch').get() as { c: number }).c).toBe(0);

    const bad = await workbook({ unbalanced: true });
    const pv = await json(upload(base, admin, '/api/statements/preview', bad, 'fs.xlsx', form(fx.orgIds.shanghai)));
    expect(pv.valid).toBe(false);
    expect(pv.checks.find((c: any) => c.code === 'BALANCE_NOT_EQUAL')).toMatchObject({ level: 'error', extra: { totalAssets: '1000000.00', liabilityEquityTotal: '990000.00' } });
    const rejected = await upload(base, admin, '/api/statements/import', bad, 'fs.xlsx', form(fx.orgIds.shanghai));
    expect(rejected.status).toBe(422);
    const body = await rejected.json() as any;
    expect(body.code).toBe('STATEMENT_INVALID');
    expect(body.details.checks.some((c: any) => c.code === 'BALANCE_NOT_EQUAL')).toBe(true);
    expect((db.prepare('SELECT COUNT(*) AS c FROM stmt_batch').get() as { c: number }).c).toBe(0);
    expect((db.prepare('SELECT COUNT(*) AS c FROM file_object').get() as { c: number }).c).toBe(0);
  });

  it('导入 → 幂等重放 → 激活 → 总览语义指标与比率;事实保留来源单元格与公式', async () => {
    const { base, db, admin, fx } = await boot();
    const content = await workbook();
    const res = await upload(base, admin, '/api/statements/import', content, '2026-05 合并报表.xlsx', form(fx.orgIds.shanghai));
    expect(res.status, await res.clone().text()).toBe(201);
    const batch = await res.json() as any;
    expect(batch).toMatchObject({ status: 'imported', isCurrent: false, scope: 'consolidated', fileName: '2026-05 合并报表.xlsx' });
    expect(batch.checks.map((c: any) => c.code)).toEqual(['CASH_FLOW_RECONCILE_MISSING']);
    const replay = await upload(base, admin, '/api/statements/import', content, 'again.xlsx', form(fx.orgIds.shanghai));
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ id: batch.id, replayed: true });

    expect((await json(get(base, admin, '/api/statements/overview'))).batch).toBeNull();
    const act = await post(base, admin, `/api/statements/batches/${batch.id}/activate`, { expectedCurrentBatchId: null });
    expect(act.status, await act.clone().text()).toBe(200);

    const ov = await json(get(base, admin, '/api/statements/overview'));
    expect(ov.batch.id).toBe(batch.id);
    expect(ov.metrics).toMatchObject({
      total_assets_period_end: '1000000.00', total_liabilities_period_end: '420000.00', owner_equity_period_end: '580000.00',
      revenue_ytd: '300000.00', net_profit_ytd: '60000.00', operating_cash_flow_ytd: '72000.00', investing_cash_flow_ytd: '-30000.00',
    });
    expect(ov.ratios).toEqual({ debt_asset_ratio: '0.420000', equity_ratio: '0.580000', net_profit_margin: '0.200000' });
    expect(ov.unitComparison).toEqual([{ batchId: batch.id, orgId: fx.orgIds.shanghai, orgName: '上海公司', scope: 'consolidated', period: '2026-05', totalAssets: '1000000.00', netProfitYtd: '60000.00', debtAssetRatio: '0.420000' }]);

    const items = await json(get(base, admin, `/api/statements/batches/${batch.id}/items?sheet=balance_sheet`));
    const total = items.find((i: any) => i.semanticKey === 'total_assets');
    expect(total.facts[0]).toEqual({ fieldKey: 'period_end', fieldName: '期末余额', amount: '1000000.00', textValue: null, formulaText: '=C20+C43', sourceCell: '资产负债表!C44' });
    expect(() => db.prepare('UPDATE stmt_fact SET amount_cents = 0').run()).toThrow(/不可修改/);
    const original = await get(base, admin, `/api/statements/batches/${batch.id}/original`);
    expect(Buffer.from(await original.arrayBuffer()).equals(content)).toBe(true);
  });

  it('并发激活按期望当前批次拒绝后到者;作废须填原因,作废当前批次后总览无数据', async () => {
    const { base, admin, fx } = await boot();
    const a = await json(upload(base, admin, '/api/statements/import', await workbook(), 'a.xlsx', form(fx.orgIds.shanghai)));
    const b = await json(upload(base, admin, '/api/statements/import', await workbook({ netProfit: 61000 }), 'b.xlsx', form(fx.orgIds.shanghai)));
    const [ra, rb] = await Promise.all([
      post(base, admin, `/api/statements/batches/${a.id}/activate`, { expectedCurrentBatchId: null }),
      post(base, admin, `/api/statements/batches/${b.id}/activate`, { expectedCurrentBatchId: null }),
    ]);
    expect([ra.status, rb.status].sort()).toEqual([200, 409]);
    const loser = ra.status === 409 ? rb : ra;
    const winnerId = ra.status === 200 ? a.id : b.id;
    const loserId = winnerId === a.id ? b.id : a.id;
    expect(loser.status).toBe(200);
    const conflictBody = await (ra.status === 409 ? ra : rb).json() as any;
    expect(conflictBody).toMatchObject({ code: 'CURRENT_BATCH_CHANGED', details: { currentBatchId: winnerId } });

    const switched = await json(post(base, admin, `/api/statements/batches/${loserId}/activate`, { expectedCurrentBatchId: winnerId }));
    expect(switched).toMatchObject({ status: 'active', isCurrent: true });
    expect((await json(get(base, admin, `/api/statements/batches/${winnerId}`))).status).toBe('superseded');

    expect((await post(base, admin, `/api/statements/batches/${loserId}/void`, { reason: '' })).status).toBe(400);
    const voided = await json(post(base, admin, `/api/statements/batches/${loserId}/void`, { reason: '报表口径错误' }));
    expect(voided).toMatchObject({ status: 'voided', isCurrent: false, voidReason: '报表口径错误' });
    expect((await json(get(base, admin, '/api/statements/overview'))).batch).toBeNull();
    expect((await post(base, admin, `/api/statements/batches/${loserId}/activate`, { expectedCurrentBatchId: null })).status).toBe(409);
  });

  it('公式缺缓存值与不可解析文本告警且不当作 0;括号负数与千分位解析', async () => {
    const { base, admin, fx } = await boot();
    const content = await workbook({
      extra: ({ bs, is }) => {
        bs.getCell('A3').value = '应收账款'; bs.getCell('B3').value = '2';
        bs.getCell('C3').value = { formula: 'SUM(X1:X2)' } as ExcelJS.CellValue;
        bs.getCell('D3').value = '暂无';
        is.getCell('A40').value = '其他收益'; is.getCell('B40').value = '39'; is.getCell('D40').value = '(1,234.50)';
      },
    });
    const pv = await json(upload(base, admin, '/api/statements/preview', content, 'fs.xlsx', form(fx.orgIds.shanghai)));
    expect(pv.valid).toBe(true);
    expect(pv.checks.filter((c: any) => c.level === 'warning').map((c: any) => [c.code, c.sourceCell ?? null])).toEqual([
      ['FORMULA_CACHE_MISSING', '资产负债表!C3'], ['AMOUNT_UNPARSEABLE', '资产负债表!D3'], ['CASH_FLOW_RECONCILE_MISSING', null],
    ]);
    const batch = await json(upload(base, admin, '/api/statements/import', content, 'fs.xlsx', form(fx.orgIds.shanghai)));
    const items = await json(get(base, admin, `/api/statements/batches/${batch.id}/items`));
    const ar = items.find((i: any) => i.itemName === '应收账款');
    expect(ar.facts).toEqual([
      { fieldKey: 'period_end', fieldName: '期末余额', amount: null, textValue: null, formulaText: '=SUM(X1:X2)', sourceCell: '资产负债表!C3' },
      { fieldKey: 'year_begin', fieldName: '年初余额', amount: null, textValue: '暂无', formulaText: null, sourceCell: '资产负债表!D3' },
    ]);
    expect(items.find((i: any) => i.itemName === '其他收益').facts[0].amount).toBe('-1234.50');
  });

  it('组织范围:受限用户不能导入/查看范围外报表单位;治理扫描把财报警告生成问题', async () => {
    const { base, db, admin, fx } = await boot();
    const batch = await json(upload(base, admin, '/api/statements/import', await workbook(), 'fs.xlsx', form(fx.orgIds.shanghai)));
    await post(base, admin, `/api/statements/batches/${batch.id}/activate`, { expectedCurrentBatchId: null });
    const hz = createScopedUser(db, { username: 'fs-hz', roleCodes: ['data_maintainer'], orgIds: [fx.orgIds.hangzhou] });
    expect((await upload(base, hz.session, '/api/statements/import', await workbook(), 'fs.xlsx', form(fx.orgIds.shanghai))).status).toBe(404);
    expect((await get(base, hz.session, `/api/statements/batches/${batch.id}`)).status).toBe(404);
    expect(await json(get(base, hz.session, '/api/statements/batches'))).toEqual([]);
    expect((await json(get(base, hz.session, '/api/statements/overview'))).batch).toBeNull();
    expect((await get(base, hz.session, `/api/statements/overview?orgId=${fx.orgIds.shanghai}`)).status).toBe(404);
    const viewer = createScopedUser(db, { username: 'fs-viewer', roleCodes: ['viewer'], allOrgs: true });
    expect((await upload(base, viewer.session, '/api/statements/import', await workbook(), 'fs.xlsx', form(fx.orgIds.shanghai))).status).toBe(403);

    await post(base, admin, '/api/governance/scan', {});
    const issues = await json(get(base, admin, '/api/governance/issues?sourceType=statement'));
    expect(issues.map((i: any) => [i.problemType, i.orgId, i.period])).toEqual([['CASH_FLOW_RECONCILE_MISSING', fx.orgIds.shanghai, '2026-05']]);
    expect((await get(base, admin, `/api/governance/issues/${issues[0].id}/verify`)).status).toBe(200);
  });
});
