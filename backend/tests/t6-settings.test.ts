import { afterEach, describe, expect, it } from 'vitest';
import { forecastLimits } from '../src/modules/forecast/forecast-runner';
import { boot, get, json, post, upload, type Session } from './t3-helpers';
import { fetchAs } from './http-helpers';
import { createProject } from './t4-helpers';

/**
 * T-6 业务设置(AC-F23 收口):投资控制默认偏差阈值(0～1、最多 6 位小数、正常 ≤ 关注 ≤ 预警),
 * 对比请求未指定时取设置值并记入快照;预测运行超时 5～120 秒,环境变量优先。
 */

const IC = '/api/investment/control';
const put = (base: string, s: Session, body: unknown) =>
  fetchAs(s, `${base}/api/settings/business`, { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
const csv = (amount: string) => Buffer.from(`科目编码,科目名称,分类,静态投资(万元),动态投资(万元)\n1,工程,,${amount},${amount}\n1.1,建筑工程,,${amount},${amount}\n`, 'utf8');

afterEach(() => { delete process.env.NEWFC_FORECAST_TIMEOUT_MS; });

describe('T-6 业务设置', () => {
  it('投资偏差默认阈值:校验、单调约束与对比取值', async () => {
    const { base, admin, fx } = await boot('newfc-t6-settings-');
    const items = (await json(get(base, admin, '/api/settings/business'))).items as any[];
    expect(items.find((s) => s.key === 'investment.ic_threshold_attention')).toMatchObject({ type: 'ratio', value: '0.08', isDefault: true, group: '投资控制' });
    expect(items.find((s) => s.key === 'forecast.timeout_seconds')).toMatchObject({ type: 'int', value: 30, min: 5, max: 120 });

    for (const bad of [{ 'investment.ic_threshold_normal': '1.5' }, { 'investment.ic_threshold_normal': '-0.1' }, { 'investment.ic_threshold_normal': '0.1234567' },
      { 'investment.ic_threshold_normal': 0.05 }, { 'forecast.timeout_seconds': 3 }, { 'forecast.timeout_seconds': 121 }]) {
      const r = await put(base, admin, bad);
      expect(r.status, JSON.stringify(bad)).toBe(400);
    }
    // 单调:只改“正常”到 0.09 会超过默认“关注” 0.08,整批拒绝
    const order = await put(base, admin, { 'investment.ic_threshold_normal': '0.09' });
    expect(order.status).toBe(400);
    expect((await order.json()).errors[0].message).toContain('正常 ≤ 关注 ≤ 预警');

    // 偏差率 5%:默认阈值下为关注
    const md = await createProject(base, admin, 'SET-IC', '阈值项目', fx.orgIds.shanghai);
    const project = await json(post(base, admin, `${IC}/projects`, { mdProjectId: md }));
    const version = async (versionType: string, amount: string) => {
      const pv = await json(upload(base, admin, `${IC}/projects/${project.id}/imports`, csv(amount), `${versionType}.csv`, { versionType }));
      const cf = await json(post(base, admin, `${IC}/imports/${pv.id}/confirm`, { sha256: pv.sha256 }));
      const v = await json(get(base, admin, `${IC}/versions/${cf.versionId}`));
      return (await json(post(base, admin, `${IC}/versions/${v.id}/confirm`, { expectedVersion: v.version }))).id as number;
    };
    const a = await version('design_estimate', '100');
    const b = await version('construction_budget', '105');
    const cmp1 = await json(post(base, admin, `${IC}/comparisons`, { baseVersionId: a, targetVersionId: b }));
    expect(cmp1.summary.totalLevel).toBe('attention');
    expect(cmp1.thresholds).toEqual({ normal: '0.03', attention: '0.08', warning: '0.10' });

    const saved = await put(base, admin, { 'investment.ic_threshold_normal': '0.06', 'investment.ic_threshold_attention': '0.09', 'investment.ic_threshold_warning': '0.12' });
    expect(saved.status).toBe(200);
    const cmp2 = await json(post(base, admin, `${IC}/comparisons`, { baseVersionId: a, targetVersionId: b }));
    expect(cmp2.summary.totalLevel).toBe('normal');
    expect(cmp2.thresholds).toEqual({ normal: '0.06', attention: '0.09', warning: '0.12' });
    // 请求显式指定时优先于设置;历史快照保留当时阈值
    const cmp3 = await json(post(base, admin, `${IC}/comparisons`, { baseVersionId: a, targetVersionId: b, thresholds: { normal: '0.01', attention: '0.02', warning: '0.04' } }));
    expect(cmp3.summary.totalLevel).toBe('exceed');
    expect((await json(get(base, admin, `${IC}/comparisons/${cmp1.id}`))).thresholds.normal).toBe('0.03');
  });

  it('预测超时:取业务设置,环境变量优先', async () => {
    expect(forecastLimits(45).timeoutMs).toBe(45_000);
    expect(forecastLimits().timeoutMs).toBe(30_000);
    process.env.NEWFC_FORECAST_TIMEOUT_MS = '200';
    expect(forecastLimits(45).timeoutMs).toBe(200);
  });
});
