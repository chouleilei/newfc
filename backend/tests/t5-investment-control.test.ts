import { describe, expect, it } from 'vitest';
import ExcelJS from 'exceljs';
import { boot, get, post, upload, type Session } from './t3-helpers';
import { createScopedUser } from './http-helpers';
import { createProject } from './t4-helpers';

/**
 * AC-F13 投资控制(四算对比):科目导入全量校验、预览→确认、红线与自动映射(编码/唯一名称建议)、
 * 未映射拦截、确认冻结、对比快照(偏差率/等级/new_item/removed_or_zero/控制链/阈值覆盖)、快照不可变、导出一致、范围隔离。
 */

const IC = '/api/investment/control';
const csv = (rows: string[][]) => Buffer.from(['科目编码,科目名称,分类,静态投资(万元),动态投资(万元)', ...rows.map((r) => r.join(','))].join('\n'), 'utf8');

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

async function setup() {
  const t = await boot('newfc-t5-ic-');
  const analyst = createScopedUser(t.db, { username: 'ic-analyst', roleCodes: ['finance_analyst'], orgIds: [t.fx.orgIds.east] }).session;
  const mdId = await createProject(t.base, t.admin, 'P-SH-IC', '上海水库工程', t.fx.orgIds.shanghai);
  const project = await ok(post(t.base, analyst, `${IC}/projects`, { mdProjectId: mdId, approvedAmount: '12000000.00', approvalDocNo: '沪水计〔2026〕1号' }), 201);
  const importVersion = async (versionType: string, rows: string[][], name?: string) => {
    const pv = await ok(upload(t.base, analyst, `${IC}/projects/${project.id}/imports`, csv(rows), `${versionType}.csv`, { versionType, ...(name ? { name } : {}) }), 201);
    expect(pv.errors).toEqual([]);
    const cf = await ok(post(t.base, analyst, `${IC}/imports/${pv.id}/confirm`, { sha256: pv.sha256 }));
    return ok(get(t.base, analyst, `${IC}/versions/${cf.versionId}`));
  };
  return { ...t, analyst, project, mdId, importVersion };
}

const DESIGN = [['1', '工程部分', '工程', '1000', '1100'], ['1.1', '建筑工程', '工程', '600', '660'], ['1.2', '安装工程', '工程', '400', '440'], ['2', '独立费用', '其他', '200', '210']];
const BUDGET = [['1', '工程部分', '工程', '1100', '1200'], ['1.1', '建筑工程', '工程', '650', '700'], ['1.2', '设备及安装工程', '工程', '450', '500'],
  ['3', '(二)独立费用', '其他', '150', '160'], ['4', '新增科目', '其他', '0', '0']];

describe('T-5 投资控制四算对比(AC-F13)', () => {
  it('导入全量校验:编码格式、重复、父级缺失、父子不平、负数、超过分精度', async () => {
    const { base, analyst, project } = await setup();
    const pv = await ok(upload(base, analyst, `${IC}/projects/${project.id}/imports`, csv([
      ['1', '工程部分', '', '100', '100'], ['1.1', '建筑', '', '60', '60'], ['1.2', '安装', '', '30', '40'], ['1.1', '重复', '', '1', '1'],
      ['2.1', '孤儿', '', '5', '5'], ['A', '坏编码', '', '1', '1'], ['3', '负数', '', '-1', '0'], ['4', '精度', '', '0.0000001', '0'], ['5', '', '', '1', '1'],
    ]), 'bad.csv', { versionType: 'estimate' }), 201);
    const messages = pv.errors.map((e: { row: number; message: string }) => `${e.row}:${e.message}`);
    expect(messages).toEqual(expect.arrayContaining([
      expect.stringMatching(/^5:科目编码 1.1 重复/), expect.stringMatching(/^7:科目编码“A”格式不正确/), expect.stringMatching(/^8:静态投资不能为负/),
      expect.stringMatching(/^9:.*不是合法万元金额/), expect.stringMatching(/^10:科目名称不能为空/), expect.stringMatching(/^6:父级科目 2 不存在/),
      expect.stringMatching(/^2:科目 1 静态投资 1000000.00 元与子级合计 900000.00 元不一致/),
    ]));
    expect(pv.errorCount).toBe(pv.errors.length);
    await fail(post(base, analyst, `${IC}/imports/${pv.id}/confirm`, { sha256: pv.sha256 }), 422, 'IMPORT_INVALID');
    // 差额 1 分以内允许
    const okPv = await ok(upload(base, analyst, `${IC}/projects/${project.id}/imports`, csv([['1', '工程', '', '100', '100'], ['1.1', '建筑', '', '99.999999', '100']]), 'ok.csv', { versionType: 'estimate' }), 201);
    expect(okPv.errors).toEqual([]);
    await fail(post(base, analyst, `${IC}/imports/${okPv.id}/confirm`, { sha256: 'f'.repeat(64) }), 409, 'PREVIEW_STALE');
  });

  it('红线、自动映射、未映射拦截、确认冻结、对比快照与控制链、阈值覆盖、导出一致、作废不影响快照', async () => {
    const { base, db, analyst, project, importVersion } = await setup();
    let design = await importVersion('design_estimate', DESIGN, '初设概算');
    expect(design).toMatchObject({ status: 'draft', versionNo: 1, staticTotal: '12000000.00', dynamicTotal: '13100000.00', mappingCounts: { matched: 4, need_mapping: 0 } });
    design = await ok(post(base, analyst, `${IC}/versions/${design.id}/confirm`, { expectedVersion: design.version }));
    expect(design).toMatchObject({ status: 'confirmed', isCurrent: true, isRedline: true });
    expect(() => db.prepare("UPDATE ic_item SET name = 'x' WHERE version_id = ?").run(design.id)).toThrow(/不可修改/);

    let budget = await importVersion('construction_budget', BUDGET);
    const byCode = Object.fromEntries(budget.items.map((i: { code: string }) => [i.code, i]));
    expect(byCode['1']).toMatchObject({ mappingStatus: 'matched', canonicalCode: '1', mappingMethod: 'code' });
    expect(byCode['1.2']).toMatchObject({ mappingStatus: 'matched', canonicalCode: '1.2' });
    expect(byCode['3']).toMatchObject({ mappingStatus: 'need_mapping', canonicalCode: '2', mappingMethod: 'name_suggested', canonicalName: '独立费用' });
    expect(byCode['4']).toMatchObject({ mappingStatus: 'need_mapping', canonicalCode: null });
    const blocked = await fail(post(base, analyst, `${IC}/versions/${budget.id}/confirm`, { expectedVersion: budget.version }), 409, 'IC_UNMAPPED_ITEMS');
    expect(blocked.details.items.map((i: { code: string }) => i.code)).toEqual(['3']);
    await fail(post(base, analyst, `${IC}/versions/${budget.id}/mapping`, { expectedVersion: budget.version, items: [{ itemId: byCode['3'].id, action: 'map', canonicalCode: '9' }] }), 400, 'VALIDATION_FAILED');
    budget = await ok(post(base, analyst, `${IC}/versions/${budget.id}/mapping`, { expectedVersion: budget.version, items: [{ itemId: byCode['3'].id, action: 'map', canonicalCode: '2' }] }));
    budget = await ok(post(base, analyst, `${IC}/versions/${budget.id}/confirm`, { expectedVersion: budget.version }));
    expect(budget).toMatchObject({ status: 'confirmed', isCurrent: true, isRedline: false, staticTotal: '12500000.00' });

    const cmp = await ok(post(base, analyst, `${IC}/comparisons`, { baseVersionId: design.id, targetVersionId: budget.id }), 201);
    const rows = Object.fromEntries(cmp.rows.map((r: { canonicalCode: string }) => [r.canonicalCode, r]));
    expect(rows['1']).toMatchObject({ baseStatic: '10000000.00', targetStatic: '11000000.00', deviation: '1000000.00', deviationRate: '0.100000', alertLevel: 'warning', status: 'compared' });
    expect(rows['1.1']).toMatchObject({ deviationRate: '0.083333', alertLevel: 'warning' });
    expect(rows['1.2']).toMatchObject({ deviationRate: '0.125000', alertLevel: 'exceed' });
    expect(rows['2']).toMatchObject({ deviationRate: '-0.250000', alertLevel: 'exceed' });
    expect(cmp.rows.map((r: { canonicalCode: string }) => r.canonicalCode)).toEqual(['1', '1.1', '1.2', '2']);
    expect(cmp.summary).toMatchObject({
      totalDeviation: '500000.00', totalDeviationRate: '0.041667', totalLevel: 'attention', exceedCount: 2, redlineVersionId: design.id, redlineAmount: '12000000.00',
      levelCounts: { normal: 0, attention: 0, warning: 2, exceed: 2 },
    });
    expect(cmp.summary.controlChain).toEqual([expect.objectContaining({ status: 'budget_over_estimate', subjectAmount: '12500000.00', referenceAmount: '12000000.00' })]);
    expect(cmp.thresholds).toEqual({ normal: '0.03', attention: '0.08', warning: '0.10' });

    const custom = await ok(post(base, analyst, `${IC}/comparisons`, {
      baseVersionId: design.id, targetVersionId: budget.id, thresholds: { normal: '0.05', attention: '0.1', warning: '0.2' },
    }), 201);
    const crow = Object.fromEntries(custom.rows.map((r: { canonicalCode: string }) => [r.canonicalCode, r.alertLevel]));
    expect(crow).toEqual({ '1': 'attention', '1.1': 'attention', '1.2': 'warning', '2': 'exceed' });
    await fail(post(base, analyst, `${IC}/comparisons`, { baseVersionId: design.id, targetVersionId: budget.id, thresholds: { normal: '0.2', attention: '0.1', warning: '0.3' } }), 400, 'VALIDATION_FAILED');

    // 结算:取消科目 1.2(为零) → removed_or_zero;结算 > 预算且 > 红线
    let settlement = await importVersion('settlement', [['1', '工程部分', '', '1300', '1300'], ['1.1', '建筑工程', '', '1300', '1300'], ['1.2', '安装工程', '', '0', '0'], ['2', '独立费用', '', '0', '0']]);
    settlement = await ok(post(base, analyst, `${IC}/versions/${settlement.id}/confirm`, { expectedVersion: settlement.version }));
    const cmp2 = await ok(post(base, analyst, `${IC}/comparisons`, { baseVersionId: budget.id, targetVersionId: settlement.id }), 201);
    const rows2 = Object.fromEntries(cmp2.rows.map((r: { canonicalCode: string }) => [r.canonicalCode, r]));
    expect(rows2['1.2']).toMatchObject({ status: 'removed_or_zero', deviationRate: '-1.000000', alertLevel: 'exceed' });
    expect(cmp2.summary.controlChain.map((c: { status: string }) => c.status)).toEqual(['budget_over_estimate', 'settlement_over_budget', 'over_redline']);
    // new_item:以结算为基准、预算为目标时,基准为 0 的科目偏差率为 null
    const cmp3 = await ok(post(base, analyst, `${IC}/comparisons`, { baseVersionId: settlement.id, targetVersionId: budget.id }), 201);
    expect(cmp3.rows.find((r: { canonicalCode: string }) => r.canonicalCode === '2')).toMatchObject({ status: 'new_item', deviationRate: null, alertLevel: null });

    // 快照不可变;导出与快照逐行一致
    expect(() => db.prepare("UPDATE ic_comparison SET summary_json = '{}' WHERE id = ?").run(cmp.id)).toThrow(/不可修改/);
    const r = await get(base, analyst, `${IC}/comparisons/${cmp.id}/export`);
    expect(r.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await r.arrayBuffer()) as unknown as ArrayBuffer);
    const detail = wb.getWorksheet('对比明细')!;
    expect(detail.rowCount).toBe(1 + cmp.rows.length);
    cmp.rows.forEach((row: { canonicalCode: string; deviation: string; deviationRate: string | null }, i: number) => {
      const x = detail.getRow(i + 2);
      expect(x.getCell(1).value).toBe(row.canonicalCode);
      expect(Number(x.getCell(6).value).toFixed(2)).toBe(row.deviation);
      expect(row.deviationRate == null ? x.getCell(7).value : Number(x.getCell(7).value).toFixed(6)).toBe(row.deviationRate ?? null);
    });

    // 新设计概算稿成为当前稿(红线切换);作废后前一稿恢复当前;旧快照不变
    let design2 = await importVersion('design_estimate', DESIGN.map((row) => (row[0] === '2' ? [...row.slice(0, 3), '200', '220'] : row)), '修编概算');
    design2 = await ok(post(base, analyst, `${IC}/versions/${design2.id}/confirm`, { expectedVersion: design2.version }));
    expect((await ok(get(base, analyst, `${IC}/projects/${project.id}`))).redlineVersionId).toBe(design2.id);
    await ok(post(base, analyst, `${IC}/versions/${design2.id}/void`, { expectedVersion: design2.version, reason: '误导入' }));
    const proj = await ok(get(base, analyst, `${IC}/projects/${project.id}`));
    expect(proj.redlineVersionId).toBe(design.id);
    await fail(post(base, analyst, `${IC}/comparisons`, { baseVersionId: design2.id, targetVersionId: budget.id }), 409, 'IC_VERSION_STATE');
    const again = await ok(get(base, analyst, `${IC}/comparisons/${cmp.id}`));
    expect(again.contentSha256).toBe(cmp.contentSha256);
    expect((await ok(get(base, analyst, `${IC}/projects/${project.id}/comparisons`))).items).toHaveLength(4);
  });

  it('组织范围与权限:范围外 404;只读不能写;同一主数据项目只能建一次', async () => {
    const { base, db, fx, analyst, project, mdId } = await setup();
    const west: Session = createScopedUser(db, { username: 'ic-west', roleCodes: ['finance_analyst'], orgIds: [fx.orgIds.west] }).session;
    const viewer: Session = createScopedUser(db, { username: 'ic-viewer', roleCodes: ['viewer'], orgIds: [fx.orgIds.east] }).session;
    expect((await ok(get(base, west, `${IC}/projects`))).items).toEqual([]);
    await fail(get(base, west, `${IC}/projects/${project.id}`), 404, 'NOT_FOUND');
    await fail(post(base, west, `${IC}/projects`, { mdProjectId: mdId }), 404, 'NOT_FOUND');
    await fail(upload(base, west, `${IC}/projects/${project.id}/imports`, csv(DESIGN), 'd.csv', { versionType: 'estimate' }), 404, 'NOT_FOUND');
    await fail(upload(base, viewer, `${IC}/projects/${project.id}/imports`, csv(DESIGN), 'd.csv', { versionType: 'estimate' }), 403, 'FORBIDDEN');
    expect((await ok(get(base, viewer, `${IC}/projects/${project.id}`))).approvedAmount).toBe('12000000.00');
    await fail(post(base, analyst, `${IC}/projects`, { mdProjectId: mdId }), 409, 'DUPLICATE');
  });
});
