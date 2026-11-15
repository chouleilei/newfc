import * as XLSX from 'xlsx';
import { describe, expect, it } from 'vitest';
import { seedOrgsFromCsv } from '../src/modules/org/seed-org-cli';
import { scanWorkbookCrossUnitFormulas } from '../src/modules/plan-execution/plan.parse';
import { boot, get, json, post, upload } from './t3-helpers';

describe('T-GAP-07 / AC-T14-03 多级组织 plan_issuance_root_id 归并、免发主体合并闭合与跨单位公式拦截', () => {
  it('二/三级子企业按 plan_issuance_root_id 自动归并一级单元，保留 undertake_org_id 双视角，免发主体精确闭合合并总表', async () => {
    const { base, admin, db } = await boot('newfc-t14-consolidation-');
    db.prepare(`UPDATE org SET status = 'inactive'`).run();

    const csv = [
      'code,parent_code,name,short_name,report_full_name,credit_code,org_kind,contract_prefix_code,plan_issuance_root_code,is_plan_excluded,is_direct_station,status,sort_order,备注',
      'GRP_HQ,,流域水电集团总部,集团总部,流域水电集团总部,91000000000000001A,legal_entity,GRP,GRP_HQ,0,0,active,1,集团总部',
      'HQ_PLAN,GRP_HQ,集团计划发展部,计发部,流域水电集团总部/集团计划发展部,,hq_dept,GRP,GRP_HQ,0,0,active,2,本部部门',
      'ST_HUB_A,GRP_HQ,甲级直属水电枢纽,甲枢纽,流域水电集团总部/甲级直属水电枢纽,,direct_unit,STA,ST_HUB_A,0,1,active,3,直属电站A',
      'SUB_EN,GRP_HQ,清洁能源投资子公司,能源子公司,流域水电集团总部/清洁能源投资子公司,91000000000000002B,legal_entity,EN,SUB_EN,0,0,active,4,一级子公司',
      'SUB_EN_L2,SUB_EN,华北风电开发公司,华北风电,流域水电集团总部/清洁能源投资子公司/华北风电开发公司,91000000000000003C,legal_entity,EN2,SUB_EN,0,0,active,5,二级法人归并能源子公司',
      'SUB_EN_L3,SUB_EN_L2,高岭风力发电场公司,高岭风电,流域水电集团总部/清洁能源投资子公司/华北风电开发公司/高岭风力发电场公司,91000000000000004D,legal_entity,EN3,SUB_EN,0,0,active,6,三级法人归并能源子公司',
      'ST_SMALL_SUB,SUB_EN,代管小型电站运维部,代管小站,流域水电集团总部/清洁能源投资子公司/代管小型电站运维部,,direct_unit,SMS,SUB_EN,0,0,active,7,实际承办小站',
      'SUB_ISO_EX,GRP_HQ,合并隔离水电开发公司,隔离水电,流域水电集团总部/合并隔离水电开发公司,91000000000000009Z,legal_entity,ISO,GRP_HQ,1,0,active,8,不单发通知但入合并',
    ].join('\n');
    seedOrgsFromCsv(db, csv, 'confirm');

    const orgIdOf = (code: string) => (db.prepare('SELECT id FROM org WHERE code = ?').get(code) as { id: number }).id;
    const hubAId = orgIdOf('ST_HUB_A');
    const subEnId = orgIdOf('SUB_EN');
    const subL3Id = orgIdOf('SUB_EN_L3');
    const smallSubId = orgIdOf('ST_SMALL_SUB');
    const isoExId = orgIdOf('SUB_ISO_EX');

    // 构造含利润预算明细、安全生产投入（跨单位承办：归口甲枢纽打包下达，实际承办为 ST_SMALL_SUB）的工作簿
    const wb = XLSX.utils.book_new();
    const profitRows = [
      ['2026年利润预算明细 单位：元'],
      ['序号', '项目名称', '本年预算', '承办单位'],
      ['1', '营业总收入', 310250400.35, '甲级直属水电枢纽'],
      ['2', '利润总额', 6200500.28, '甲级直属水电枢纽'],
      ['3', '营业总收入', 150100200.12, '清洁能源投资子公司'],
      ['4', '利润总额', 2400300.10, '清洁能源投资子公司'],
      ['5', '营业总收入', 42209360.20, '高岭风力发电场公司'],
      ['6', '利润总额', 700336.20, '高岭风力发电场公司'],
      ['7', '营业总收入', 480000.00, '合并隔离水电开发公司'],
      ['8', '利润总额', -60760.00, '合并隔离水电开发公司'],
    ];
    const safetyRows = [
      ['2026年安全生产投入 单位：元'],
      ['序号', '项目名称', '年度计划', '承办单位'],
      ['1', '代管小站防汛监测设施完善', 30000.00, '甲级直属水电枢纽、代管小型电站运维部'],
    ];
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(profitRows), '利润预算明细');
    XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(safetyRows), '安全生产投入');
    const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer;

    const batchRes = await upload(base, admin, '/api/plan/import', buf, '合并测试计划.xlsx', { year: '2026', actualPeriod: '2026-06' });
    expect(batchRes.status).toBe(201);
    const batch = await json(batchRes);
    await json(post(base, admin, `/api/plan/batches/${batch.id}/activate`, { expectedCurrentBatchId: null }));

    const cycle = await json(
      post(base, admin, '/api/plan/issuance/cycles', {
        year: 2026,
        cycleCode: 'CONSOL-2026-01',
        issuanceStage: 'official',
        sourcePlanBatchId: batch.id,
      }),
    );

    // 验证 SUB_ISO_EX 不生成单元包；SUB_EN_L2/SUB_EN_L3/ST_SMALL_SUB 自动归并至 SUB_EN
    expect(cycle.packs.some((p: any) => p.unitOrgId === isoExId)).toBe(false);
    const subEnPack = cycle.packs.find((p: any) => p.unitOrgId === subEnId)!;
    expect(subEnPack.mergedChildOrgs.map((c: any) => c.id)).toContain(subL3Id);
    // 150,100,200.12 + 42,209,360.20 = 192,309,560.32
    expect(subEnPack.metrics.operatingRevenue).toBe('192309560.32');
    // 2,400,300.10 + 700,336.20 = 3,100,636.30
    expect(subEnPack.metrics.profitBeforeTax).toBe('3100636.30');

    // 验证双视角查询：归口视角 30,000.00 元在甲枢纽包内；undertake 视角准确返回跨单位承办明细
    const hubAPack = cycle.packs.find((p: any) => p.unitOrgId === hubAId)!;
    expect(hubAPack.metrics.safetyInputTotal).toBe('30000.00');

    const undertakeViewPacks = (await json(get(base, admin, `/api/plan/issuance/packs?cycleId=${cycle.id}&view=undertake`))).items as any[];
    const subEnUndertakePack = undertakeViewPacks.find((p) => p.unitOrgId === subEnId)!;
    expect(subEnUndertakePack.undertakeItems.some((u: any) => u.undertakeOrgId === smallSubId && u.ownerUnitOrgId === hubAId && u.approvedAmount === '30000.00')).toBe(true);

    // 验证集团合并闭合：下达单元合计 502,559,960.67 + 免发主体 480,000.00 === 503,039,960.67；利润 9,301,136.58 + (-60,760.00) === 9,240,376.58
    const rec = await json(
      post(base, admin, `/api/plan/issuance/cycles/${cycle.id}/reconcile`, {
        groupConsolidatedOperatingRevenue: '503039960.67',
        groupConsolidatedProfitBeforeTax: '9240376.58',
      }),
    );
    expect(rec.passed).toBe(true);
    expect(rec.consolidation.sum8UnitsOperatingRevenue).toBe('502559960.67');
    expect(rec.consolidation.excludedOrgsOperatingRevenue).toBe('480000.00');
    expect(rec.consolidation.groupConsolidatedOperatingRevenue).toBe('503039960.67');
    expect(rec.consolidation.sum8UnitsProfitBeforeTax).toBe('9301136.58');
    expect(rec.consolidation.excludedOrgsProfitBeforeTax).toBe('-60760.00');
    expect(rec.consolidation.profitDiff).toBe('0.00');

    // 若人为填错集团合并利润总额，必须触发阻断
    const recMismatch = await json(
      post(base, admin, `/api/plan/issuance/cycles/${cycle.id}/reconcile`, {
        groupConsolidatedOperatingRevenue: '503039960.67',
        groupConsolidatedProfitBeforeTax: '9301136.58',
      }),
    );
    expect(recMismatch.passed).toBe(false);
    expect(recMismatch.blockingCount).toBeGreaterThan(0);
  });

  it('scanWorkbookCrossUnitFormulas 精准拦截跨单位错列引用 CROSS_UNIT_CELL_REF 并阻断正式发布', async () => {
    // 1. 直接验证公式扫描器：同一分表主引用列为 EZ，但某行误引邻近其他单位列 FA（如 $FA$35）
    const warnings = scanWorkbookCrossUnitFormulas([
      {
        name: '01.主要指标总表',
        hidden: false,
        rows: [
          { rowNo: 2, cells: ['序号', '指标名称', '集团合并', '清洁能源子公司', '综合实业子公司'] },
        ],
        formulas: [],
      },
      {
        name: '清洁能源子公司预算表',
        hidden: false,
        rows: [{ rowNo: 1, cells: ['指标', '预算数'] }],
        formulas: [
          { rowNo: 5, colIndex: 2, address: 'C5', formula: "'01.主要指标总表'!$D$10" },
          { rowNo: 6, colIndex: 2, address: 'C6', formula: "'01.主要指标总表'!$D$11" },
          { rowNo: 7, colIndex: 2, address: 'C7', formula: "'01.主要指标总表'!$D$12" },
          { rowNo: 8, colIndex: 2, address: 'C8', formula: "'01.主要指标总表'!$E$35" },
        ],
      },
    ]);
    expect(warnings.some((w) => w.code === 'CROSS_UNIT_CELL_REF' && w.message.includes('E35'))).toBe(true);

    // 2. 验证带 CROSS_UNIT_CELL_REF 的周期在 strict_compile 模式下被 publishIssuanceCycle 409 拦截
    const { base, admin } = await boot('newfc-t14-cross-formula-');
    const cycle = await json(
      post(base, admin, '/api/plan/issuance/cycles', {
        year: 2026,
        cycleCode: 'FORMULA-BLOCK-2026',
        issuanceStage: 'formal_draft',
        decisionDocMeta: {
          crossUnitFormulaErrors: [
            {
              code: 'CROSS_UNIT_CELL_REF',
              sheet: '清洁能源子公司主要指标表',
              row: 8,
              message: '单元格 C8 公式引用了邻近其他单位列 $FA$35（本表主引用列为 $EZ）',
            },
          ],
        },
      }),
    );

    const pubRes = await post(base, admin, `/api/plan/issuance/cycles/${cycle.id}/publish`, {});
    expect(pubRes.status).toBe(409);
    const pubErr = await json(pubRes);
    expect(pubErr.code).toBe('PLAN_RECONCILE_BLOCKED');
  });
});
