import fs from 'node:fs';
import path from 'node:path';
import * as XLSX from 'xlsx';
import { describe, expect, it } from 'vitest';
import { MAX_LEGACY_SHEETS, MAX_WORKBOOK_SHEETS } from '../src/modules/io/import-limits';
import { readWorkbookSheets } from '../src/modules/io/table-reader';
import { PLAN_SHEETS, PLAN_SHEET_LABELS } from '../src/contracts/plan-execution';
import { boot, get, json, post, upload } from './t3-helpers';

/** 使用 SheetJS 生成真实 BIFF8 (.xls, OLE2 魔数 D0 CF 11 E0 A1 B1 1A E1) 多表测试工作簿（100% 脱敏夹具） */
function buildBiff8Workbook(sheets: Record<string, (string | number | null)[][]>): Buffer {
  const wb = XLSX.utils.book_new();
  for (const [name, aoa] of Object.entries(sheets)) {
    const ws = XLSX.utils.aoa_to_sheet(aoa);
    XLSX.utils.book_append_sheet(wb, ws, name.slice(0, 31));
  }
  return XLSX.write(wb, { type: 'buffer', bookType: 'biff8' }) as Buffer;
}

describe('T-GAP-09 离线 xlsx@0.20.3 安全解析、16 表 .xls 容缺导入与小计防重', () => {
  it('package-lock.json 离线锁定本地 vendor/xlsx-0.20.3.tgz 且默认 40 表 / 历史迁移 100 表上限生效', async () => {
    const lockPath = path.resolve(__dirname, '../package-lock.json');
    const lock = JSON.parse(fs.readFileSync(lockPath, 'utf8')) as {
      packages?: Record<string, { version?: string; resolved?: string; integrity?: string }>;
    };
    const xlsxEntry = lock.packages?.['node_modules/xlsx'];
    expect(xlsxEntry?.version).toBe('0.20.3');
    expect(xlsxEntry?.resolved).toBe('file:vendor/xlsx-0.20.3.tgz');
    expect(xlsxEntry?.integrity).toMatch(/^sha512-/);
    expect(fs.existsSync(path.resolve(__dirname, '../vendor/xlsx-0.20.3.tgz'))).toBe(true);

    expect(MAX_WORKBOOK_SHEETS).toBe(40);
    expect(MAX_LEGACY_SHEETS).toBe(100);

    // 56 张工作表的 BIFF8 .xls：默认 40 页上限拦截，显式传 MAX_LEGACY_SHEETS=100 完整读取不截断
    const sheets56: Record<string, (string | number)[][]> = {};
    for (let i = 1; i <= 56; i++) {
      sheets56[`台账分表_${i}`] = [['序号', '名称'], [String(i), `记录${i}`]];
    }
    const buf56 = buildBiff8Workbook(sheets56);
    expect(buf56.subarray(0, 8)).toEqual(Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]));

    await expect(readWorkbookSheets(buf56)).rejects.toThrow(/超过安全上限 40/);
    const read56 = await readWorkbookSheets(buf56, 2000, MAX_LEGACY_SHEETS);
    expect(read56).toHaveLength(56);

    // 非 OLE2 伪造文件以 .xls 解析必须被拦截
    await expect(readWorkbookSheets(Buffer.from('not-an-ole2-or-xlsx-file'))).rejects.toThrow();
  });

  it('16 类综合计划 .xls 一次预览确认入库：无项目编码确定性 item_key、滞后表头提醒、小计行零重复累加及模板导出闭环', async () => {
    const t = await boot('newfc-t13-plan16-');
    const { base, admin } = t;

    // 构造覆盖全部 16 类 PlanSheetCode + 2 张辅助忽略表（共 18 张表）的真实 BIFF8 .xls
    const sheets18: Record<string, (string | number | null)[][]> = {
      '目录表': [['1', '汇总表'], ['2', '投资计划']],
      [PLAN_SHEET_LABELS.investment]: [
        ['2026年度固定资产投资计划表'],
        ['序号', '项目名称', '项目总投资', '已完成投资', '公司2026年计划投资', '承办单位'],
        ['Ⅰ', '大中型基建', 5000, 1000, 1200, ''],
        ['1', '水库除险加固主体工程', 5000, 1000, 1200, '上海公司'],
        ['2', '智慧调度系统总项', 800, 200, 300, ''],
        ['2.1', '水情自动测报子系统', 500, 100, 180, '上海公司'],
        ['2.2', '闸门远程控制子系统', 300, 100, 120, '南京公司'],
      ],
      [PLAN_SHEET_LABELS.investment_tech_renovation]: [
        ['2026年资本化更新改造'],
        ['序号', '项目名称', '本年计划投资', '承办单位'],
        ['1', '机组调速器改造', 65, '上海公司'],
      ],
      [PLAN_SHEET_LABELS.investment_info]: [
        ['2026年信息化投资'],
        ['序号', '项目名称', '本年计划投资', '承办单位'],
        ['1', '财务内控平台升级', 40, '上海公司'],
      ],
      [PLAN_SHEET_LABELS.investment_other]: [
        ['2026年其他投资'],
        ['序号', '项目名称', '本年计划投资', '承办单位'],
        ['1', '库区巡护码头修缮', 25, '南京公司'],
      ],
      '固定购置审核': [
        ['2026年固定资产购置计划表'],
        ['序号', '设备名称', '单价(万元)', '单位', '数量', '合价(万元)', '审核金额', '承办单位'],
        ['Ⅳ', '上海公司', null, '', null, 7.64, 7.52, ''],
        ['一', '生产性固定资产', null, '', null, 0.15, 0.15, ''],
        ['1', '巡检仪', 0.15, '台', 1, 0.15, 0.15, '上海公司'],
        ['二', '非生产性固定资产', null, '', null, 7.49, 7.37, ''],
        ['1', '高速扫描仪', 3.5, '台', 1, 3.5, 3.37, '上海公司'],
        ['2', '工作站电脑', 2.0, '台', 2, 4.0, 4.0, '上海公司'],
        ['合计', '固定资产购置', null, '', null, 7.64, 7.52, ''],
      ],
      [PLAN_SHEET_LABELS.pre_work]: [
        ['2026年前期工作费'],
        ['序号', '项目名称', '年度计划', '承办单位'],
        ['1', '抽水蓄能预可研', 110, '上海公司'],
      ],
      [PLAN_SHEET_LABELS.capacity_add]: [
        ['2026年新增生产能力计划表 单位：万千瓦'],
        ['序号', '项目名称', '权益比例', '新增容量'],
        ['一', '光伏', null, null],
        ['1', '分布式屋顶光伏', 1, 0.5],
      ],
      '更新改造费用化': [
        ['更新改造计划表（费用化）'],
        ['序号', '项目名称', '总费用（万元）', '2025年计划金额（万元）', '承办单位'],
        ['一', '上海公司', 18, 18, '上海公司'],
        ['1', '泄洪闸防腐更新', 18, 18, '上海公司'],
      ],
      [PLAN_SHEET_LABELS.maintenance]: [
        ['2026年运行维护费'],
        ['序号', '项目名称', '2026年计划金额（万元）', '承办单位'],
        ['Ⅰ', '公司总部', 50, ''],
        ['1', '基地综合运维委托', 50, '上海公司、南京公司'],
      ],
      [PLAN_SHEET_LABELS.safety_input]: [
        ['2026年安全生产投入'],
        ['序号', '项目名称', '年度计划', '承办单位'],
        ['1', '防汛应急演练物资', 12, '上海公司'],
      ],
      [PLAN_SHEET_LABELS.five_expenses]: [
        ['2026年五项费用'],
        ['序号', '费用名称', '年度计划', '承办单位'],
        ['1', '业务招待与差旅费', 8.5, '上海公司'],
      ],
      [PLAN_SHEET_LABELS.mgmt_fee]: [
        ['2026年管理类费用'],
        ['序号', '费用名称', '年度计划', '承办单位'],
        ['1', '办公及物业运行费', 30, '上海公司'],
      ],
      [PLAN_SHEET_LABELS.mfg_fee]: [
        ['2026年制造费用'],
        ['序号', '费用名称', '年度计划', '承办单位'],
        ['1', '厂房生产性折旧及辅材', 95, '南京公司'],
      ],
      '汇总表': [
        ['2026年综合计划主要指标汇总表'],
        ['序号', '指标名称', '计量单位', '2026年计划'],
        ['1', '发电量', '万千瓦时', 93800],
        ['2', '营业总收入', '万元', 52300],
      ],
      [PLAN_SHEET_LABELS.profit_budget]: [
        ['2026年利润预算明细'],
        ['序号', '项目名称', '本年预算', '承办单位'],
        ['1', '主营业务利润', 924, '上海公司'],
      ],
      '各单位经营指标': [
        ['各单位经营指标（万元）'],
        ['公司', '2025年实际', '', '2026年计划', ''],
        ['', '总收入', '净利润', '总收入', '净利润'],
        ['上海公司', 3000, 200, 3500, 260],
      ],
      '2025投资完成情况': [
        ['2025年固定资产投资计划与预计完成情况对比表'],
        ['序号', '项目', '2025年计划', '2025年实际完成'],
        ['1', '历史项目', 100, 95],
      ],
    };

    const xlsBuf = buildBiff8Workbook(sheets18);
    const previewRes = await upload(base, admin, '/api/plan/preview', xlsBuf, '2026综合计划16表.xls', {
      year: '2026',
      actualPeriod: '2026-04',
    });
    expect(previewRes.status).toBe(200);
    const pv = await json(previewRes);
    expect(pv.valid).toBe(true);
    expect(pv.errors).toEqual([]);
    expect(pv.sheets.map((s: { code: string }) => s.code).sort()).toEqual([...PLAN_SHEETS].sort());
    expect(pv.ignoredSheets).toEqual(expect.arrayContaining(['目录表', '2025投资完成情况']));
    expect(pv.warnings.some((w: { code: string }) => w.code === 'MISSING_PROJECT_CODE')).toBe(true);
    expect(pv.warnings.some((w: { code: string; headerYearRaw?: string }) => w.code === 'STALE_YEAR_HEADER' && w.headerYearRaw === '2025年')).toBe(true);

    // 导入确认并激活
    const impRes = await upload(base, admin, '/api/plan/import', xlsBuf, '2026综合计划16表.xls', {
      year: '2026',
      actualPeriod: '2026-04',
    });
    expect(impRes.status).toBe(201);
    const batch = await json(impRes);
    await post(base, admin, `/api/plan/batches/${batch.id}/activate`, { expectedCurrentBatchId: null });

    // 校验小计/节头不重复累加：
    // investment 叶行仅计 1(1200万) + 2.1(180万) + 2.2(120万) = 1500万 = 15,000,000.00 元（不把父行 2 的 300万或 Ⅰ 的 1200万重复计入！）
    // purchase 叶行仅计 0.15 + 3.37 + 4.00 = 7.52万 = 75,200.00 元（不把 二 非生产性固定资产 7.37万 或 Ⅳ 7.52万重复计入！）
    const ov = await json(get(base, admin, '/api/plan/overview?year=2026'));
    const invSheet = ov.sheets.find((s: { code: string }) => s.code === 'investment');
    expect(invSheet.detailCount).toBe(3);
    expect(invSheet.annualPlan).toBe('15000000.00');

    const purSheet = ov.sheets.find((s: { code: string }) => s.code === 'purchase');
    expect(purSheet.detailCount).toBe(3);
    expect(purSheet.annualPlan).toBe('75200.00');

    // 跨修订周期（2026-05）再次导入结构一致的修订簿，验证 stableItemUid 恒定继承
    const itemsApr = await json(get(base, admin, `/api/plan/batches/${batch.id}/items?sheet=investment`));
    const uidApr = itemsApr.find((i: { itemName: string }) => i.itemName === '水库除险加固主体工程')?.stableItemUid;
    expect(uidApr).toMatch(/^PUID-[0-9a-f]{24}$/);

    sheets18[PLAN_SHEET_LABELS.investment][3] = ['1', '水库除险加固主体工程', 5000, 1200, 1250, '上海公司'];
    const xlsMay = buildBiff8Workbook(sheets18);
    const batchMay = await json(
      upload(base, admin, '/api/plan/import', xlsMay, '2026综合计划5月修订.xls', {
        year: '2026',
        actualPeriod: '2026-05',
      })
    );
    const itemsMay = await json(get(base, admin, `/api/plan/batches/${batchMay.id}/items?sheet=investment`));
    const uidMay = itemsMay.find((i: { itemName: string }) => i.itemName === '水库除险加固主体工程')?.stableItemUid;
    expect(uidMay).toBe(uidApr);

    // 验证跨单位承办双视角（上海公司归口 / 南京公司实际承办）
    const maintItems = await json(get(base, admin, `/api/plan/batches/${batch.id}/items?sheet=maintenance`));
    const crossItem = maintItems.find((i: { itemName: string }) => i.itemName === '基地综合运维委托');
    expect(crossItem.undertakeOrgName).toBe('南京公司');

    // 验证模板下载与批次导出接口返回合法 .xlsx
    const tplRes = await get(base, admin, '/api/plan/template?year=2026');
    expect(tplRes.status).toBe(200);
    const tplBuf = Buffer.from(await tplRes.arrayBuffer());
    const tplSheets = await readWorkbookSheets(tplBuf, 100, 40);
    expect(tplSheets).toHaveLength(16);

    const expRes = await get(base, admin, `/api/plan/batches/${batch.id}/export`);
    expect(expRes.status).toBe(200);
    const expBuf = Buffer.from(await expRes.arrayBuffer());
    const expSheets = await readWorkbookSheets(expBuf, 500, 40);
    expect(expSheets.length).toBe(16);
  });
});
