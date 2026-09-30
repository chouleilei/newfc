/** T-7 财务报表多期趋势(AC-F10,对应 lishui `/financial-statements/trends`):当前批次按期间排列、当月发生额、缺期不插补、组织范围。 */
import { describe, expect, it } from 'vitest';
import { createScopedUser } from './http-helpers';
import { boot, get, json, post, upload } from './t3-helpers';
import { statementWorkbook as workbook } from './t3-statement-sample';

describe('T-7 财务报表趋势', () => {
  it('按期间返回指标与比率;累计类指标相邻期间相减得当月数,缺期为 null', async () => {
    const { base, db, admin, fx } = await boot();
    const sh = fx.orgIds.shanghai;
    for (const [period, np] of [['2026-01', 20000], ['2026-02', 45000], ['2026-04', 60000]] as const) {
      const b = await json(upload(base, admin, '/api/statements/import', await workbook({ netProfit: np }), `${period}.xlsx`, { orgId: String(sh), period, scope: 'consolidated' }));
      expect((await post(base, admin, `/api/statements/batches/${b.id}/activate`, { expectedCurrentBatchId: null })).status).toBe(200);
    }
    const t = await json(get(base, admin, `/api/statements/trends?orgId=${sh}&scope=consolidated&from=2026-01&to=2026-04`));
    expect(t).toMatchObject({ orgId: sh, scope: 'consolidated', from: '2026-01', to: '2026-04', missingPeriods: ['2026-03'] });
    expect(t.points.map((p: { period: string }) => p.period)).toEqual(['2026-01', '2026-02', '2026-04']);
    expect(t.points.map((p: { metrics: { net_profit_ytd: string } }) => p.metrics.net_profit_ytd)).toEqual(['20000.00', '45000.00', '60000.00']);
    expect(t.points.map((p: { monthly: { net_profit_ytd: string | null } }) => p.monthly.net_profit_ytd)).toEqual(['20000.00', '25000.00', null]);
    expect(t.points[1].monthly.revenue_ytd).toBe('0.00');
    expect(t.points[1].ratios.debt_asset_ratio).toBe('0.420000');

    // 缺省:与总览同口径的最新当前批次,截至该期间的 12 个月
    const d = await json(get(base, admin, '/api/statements/trends'));
    expect(d).toMatchObject({ orgId: sh, from: '2025-05', to: '2026-04' });
    expect(d.points).toHaveLength(3);
    expect(d.missingPeriods).toHaveLength(9);

    expect((await get(base, admin, '/api/statements/trends?from=2026-05&to=2026-04')).status).toBe(400);
    expect((await get(base, admin, '/api/statements/trends?from=2020-01&to=2026-04')).status).toBe(400);
    const hz = createScopedUser(db, { username: 't7-hz', roleCodes: ['viewer'], orgIds: [fx.orgIds.hangzhou] }).session;
    expect((await get(base, hz, `/api/statements/trends?orgId=${sh}`)).status).toBe(404);
    expect((await json(get(base, hz, '/api/statements/trends'))).points).toEqual([]);
  });
});
