import ExcelJS from 'exceljs';
import * as XLSX from 'xlsx';
import { describe, expect, it } from 'vitest';
import { seedOrgsFromCsv } from '../src/modules/org/seed-org-cli';
import { seedPrefixMapFromCsv } from '../src/modules/contracts/seed-prefix-map-cli';
import {
  commitLegacyMigrationPlan,
  computeLegacyMigrationPlan,
  type LegacyWorkbookInput,
} from '../src/modules/contracts/legacy-migration-pipeline';
import { confirmContractImport, previewContractImport } from '../src/modules/contracts/contract-import.service';
import { getContractDetail } from '../src/modules/contracts/contract.service';
import { runWithContext } from '../src/core/request-context';
import { loadAuthContext } from '../src/modules/security/security.service';
import { ObjectStore } from '../src/modules/files/object-store';
import { boot } from './t3-helpers';
import { ensureAdmin } from './http-helpers';

const SYNTHETIC_ORG_CSV = [
  'code,parent_code,name,short_name,report_full_name,credit_code,org_kind,contract_prefix_code,plan_issuance_root_code,is_plan_excluded,is_direct_station,status,sort_order',
  'GRP,,集团母公司,母公司,集团母公司,91000000000000001A,legal_entity,GRP,GRP,0,0,active,10',
  'SUB_PM,GRP,项目管理子公司,项目子公司,项目管理子公司,91000000000000002B,legal_entity,PM,SUB_PM,0,0,active,20',
  'SUB_SGC,SUB_PM,规划设计子公司,规划设计,规划设计子公司,91000000000000003C,legal_entity,PM,SUB_PM,0,0,active,30',
  'SUB_X,GRP,独立水电子公司,独立水电,独立水电子公司,91000000000000004D,legal_entity,SBX,GRP,1,0,active,40',
  'HIST_H,SUB_X,历史注销水电站,历史站,历史注销水电站,,closed_history,SBX,GRP,1,0,inactive,50',
].join('\n');

const SYNTHETIC_PREFIX_CSV = [
  'raw_prefix,canonical_prefix,legal_entity_code,signing_org_code,signing_org_name,parent_canonical_prefix,entity_status,allow_new_contract,prefix_kind,sample_contract_no,occurrence_count,备注',
  'GRP,GRP,GRP,GRP,集团母公司,,active,1,internal_prefix,GRP-SG-01/2025-01,50,母公司',
  'PM,PM,SUB_PM,SUB_PM,项目管理子公司,GRP,active,1,internal_prefix,PM-ZX-01/2024-01,40,项目子公司',
  'SGC,PM,SUB_SGC,SUB_SGC,规划设计子公司,PM,active,0,internal_prefix,SGC-SJ-01/2023-01,20,沿用母公司PM',
  'HST,SBX,SUB_X,HIST_H,历史注销水电站,SBX,inactive,0,internal_prefix,HST-SG-01/2018-01,10,历史关停主体',
  'EXTP,EXT,EXT,,外部隔离电站,,external,0,external_counterparty,EXTP-2022-01,5,外部排除',
].join('\n');

function makeXlsBuffer(sheets: { name: string; rows: (string | number)[][] }[]): Buffer {
  const wb = XLSX.utils.book_new();
  for (const s of sheets) {
    const ws = XLSX.utils.aoa_to_sheet(s.rows);
    XLSX.utils.book_append_sheet(wb, ws, s.name.slice(0, 31));
  }
  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xls' }));
}

async function makeXlsxBuffer(sheets: { name: string; rows: (string | number)[][] }[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name.slice(0, 31));
    for (const r of s.rows) ws.addRow(r);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

describe('T-13 GAP-12 历史台账 5 步容缺清洗、四级消重与五维闭合对账流水线', () => {
  it('全覆盖：>20工作表/.xls、外部0行阻断、非货币单价、复币CNY+PGK、重号#DUP2保留、内部双视角、无号匹配与MIG合成号、负向红冲、防污染CHECK及正逆序幂等', async () => {
    const { db, dir } = await boot('newfc-t13-legacy-pipe-');
    const adminUserId = ensureAdmin(db);
    expect(seedOrgsFromCsv(db, SYNTHETIC_ORG_CSV, 'confirm').errors).toEqual([]);
    expect(seedPrefixMapFromCsv(db, SYNTHETIC_PREFIX_CSV, 'confirm').errors).toEqual([]);

    const now = '2026-11-14T08:00:00.000Z';
    db.prepare(
      `INSERT INTO md_dict_item (dict_type, item_value, item_label, sort_order, status, created_at, updated_at)
       VALUES ('org_external_blocklist', 'EXTBLK', '外部隔离水电开发公司', 1, 'active', ?, ?)`,
    ).run(now, now);

    const grpId = (db.prepare("SELECT id FROM org WHERE code = 'GRP'").get() as { id: number }).id;
    const pmId = (db.prepare("SELECT id FROM org WHERE code = 'SUB_PM'").get() as { id: number }).id;
    const subXId = (db.prepare("SELECT id FROM org WHERE code = 'SUB_X'").get() as { id: number }).id;
    const histId = (db.prepare("SELECT id FROM org WHERE code = 'HIST_H'").get() as { id: number }).id;

    // 1. 总部工作簿（25张工作表验证 MAX_LEGACY_SHEETS=100 放行，含集团内部协议支出视角 + 外部相对方共管互录 + 美元无汇率）
    const hqSheets: { name: string; rows: (string | number)[][] }[] = [
      {
        name: '02_合同台账总表',
        rows: [
          ['2026年8月合同台账（单位：万元）'],
          ['序号', '合同编号', '合同名称', '类别', '初始签订合同金额（万元）', '支出/收入', '签订日期', '对方单位', '承办单位', '累计已付款（万元）'],
          ['例子', 'LS-QT-01/2013-01', '示例合同', '其他', '10', '支出', '2025-01-01', '示例单位', '母公司', '0'],
          [1, 'GRP-QT-136/2024-28', '智慧建管技术支持协议', '技术服务', '0', '支出', '2024-06-15', '项目管理子公司', '集团母公司', '0'],
          [2, 'GRP-EQ-01/2023-09', '进口传感器采购合同', '物资采购', '美元12.5', '支出', '2023.08.20', '海外仪器供应商A', '集团母公司', '0'],
          [3, 'SGC-SJ-05/2023-01', '大坝安全监测设计合同', '勘察设计', '36.5', '支出', '2023-05-10', '外部工程勘察院', '集团母公司', '10'],
          ['合计', '', '', '', '49', '', '', '', '', '10'],
        ],
      },
    ];
    for (let i = 2; i <= 25; i++) {
      hqSheets.push({ name: `附表_${i}`, rows: [['说明页', `非合同附表 ${i}`]] });
    }
    const wbHqBuf = await makeXlsxBuffer(hqSheets);

    // 2. 项目子公司 .xls 工作簿（含：同法人同号异合同 PM-2024-02 收入+支出、集团内部协议收入视角单价合同、CNY+PGK 双币种、kWh 与 元/月 非货币单价、2012.719 畸形日期、20170302.0 日期、共管互录 SGC-SJ-05/2023-01）
    const wbPmXlsBuf = makeXlsBuffer([
      {
        name: '1项目管理子公司',
        rows: [
          ['合同台账（单位：万元）'],
          ['序号', '合同编号', '合同名称', '类别', '合同总价（万元）', '支出/收入', '签订日期', '对方单位', '承办部门'],
          [1, 'PM-2024-02', '库区测绘咨询服务合同（收入项）', '技术服务', '58.00', '收入', '2024-03-12', '外部业主单位甲', '项目管理子公司'],
          [2, 'PM-2024-02', '办公楼零星修缮工程合同（支出项）', '工程施工', '19.80', '支出', '2024-07-09', '外部建筑公司乙', '项目管理子公司'],
          [3, 'GRP-QT-136/2024-28', '智慧建管技术支持协议', '技术服务', '按实结算', '收入', '2024-06-15', '集团母公司', '项目管理子公司'],
          [4, 'PM-FW-2014-01-001', '海外水电运维技术咨询合同', '技术服务', '人民币3751+基纳316', '收入', '20170302.0', '海外水电业主丙', '项目管理子公司'],
          [5, 'PM-DL-2021-03', '场区绿电消纳框架协议', '其他', '1200万kWh', '收入', '2012.719', '区域售电公司丁', '项目管理子公司'],
          [6, 'PM-WY-2022-08', '驻地后勤保洁外包合同', '一般服务', '2500元/月', '支出', '', '物业服务商戊', '项目管理子公司'],
          [7, 'SGC-SJ-05/2023-01', '大坝安全监测设计合同', '勘察设计', '36.5', '支出', '2023-05-10', '外部工程勘察院', '规划设计子公司'],
        ],
      },
    ]);

    // 3. 历史关停主体 + 结算负向红冲工作簿（C05 风格）
    const wbHistBuf = await makeXlsxBuffer([
      {
        name: '台账主表',
        rows: [
          ['历史合同台账（单位：万元）'],
          ['序号', '合同编号', '合同名称', '合同金额（万元）', '支出/收入', '签订日期', '对方单位'],
          [1, 'HST-SG-01/2018-01', '尾水渠护坡加固工程', '120.00', '支出', '2018-09-01', '水利建设承包商己'],
        ],
      },
      {
        name: '本月结算分表',
        rows: [
          ['结算统计（单位：万元）'],
          ['序号', '合同编号', '合同名称', '结算次数', '本次结算金额（万元）', '备注'],
          [1, 'HST-SG-01/2018-01', '尾水渠护坡加固工程', 2, '-3.50', '竣工决算审减红冲'],
        ],
      },
    ]);

    // 4. 无合同编号执行统计表（C09 风格：1条匹配智慧建管单价合同、2条自表重复、1条零命中生成 MIG-PM-2022-001）
    const wbCodelessBuf = await makeXlsxBuffer([
      {
        name: '项目子公司',
        rows: [
          ['2024年度执行台账（单位：元）'],
          ['序号', '合同名称', '合同金额', '签订日期', '对方单位', '开票情况', '确认收入', '回款情况', '备注'],
          [1, '智慧建管技术支持协议', '444725.80', '2024-06-15', '集团母公司', '444725.80', '444725.80', '400000.00', '内部技术支撑'],
          [2, '偏远库区地质灾害应急排查技术服务', '93280.00', '2022-10-18', '地方水利管理站', '93280.00', '93280.00', '93280.00', '历史漏编合同号'],
          [3, '偏远库区地质灾害应急排查技术服务', '93280.00', '2022-10-18', '地方水利管理站', '93280.00', '93280.00', '93280.00', '表内重复登记'],
        ],
      },
    ]);

    // 5. 外部隔离主体工作簿（表名命中 EXTBLK 外部隔离水电开发公司，必须 0 行入库）
    const wbExternalBlockedBuf = await makeXlsxBuffer([
      {
        name: '合同台账',
        rows: [
          ['外部隔离水电开发公司合同台账'],
          ['序号', '合同编号', '合同名称', '合同金额（万元）', '签订日期', '对方单位'],
          [1, 'EXTP-2022-01', '外部电站机组检修合同', '88.00', '2022-05-01', '某检修公司'],
          [2, 'EXTP-2022-02', '外部电站大坝监测合同', '45.00', '2022-06-01', '某监测公司'],
        ],
      },
    ]);

    const workbooksForward: LegacyWorkbookInput[] = [
      { inventoryId: 'W1', batchGroup: '2026-09-zip', fileName: '2026年8月母公司台账.xlsx', content: wbHqBuf, defaultOrgId: grpId },
      { inventoryId: 'W2', batchGroup: '2026-09-zip', fileName: '2026年8月项目子公司台账.xls', content: wbPmXlsBuf, defaultOrgId: pmId },
      { inventoryId: 'W3', batchGroup: 'historical-core', fileName: '2024年历史水电台账.xlsx', content: wbHistBuf, defaultOrgId: subXId },
      { inventoryId: 'W4', batchGroup: 'historical-core', fileName: '2024年度无号执行台账.xlsx', content: wbCodelessBuf, defaultOrgId: pmId },
      { inventoryId: 'WX', batchGroup: 'historical-extra', fileName: '合同台账_外部隔离水电开发公司.xlsx', content: wbExternalBlockedBuf },
    ];

    const planFwd = await computeLegacyMigrationPlan(db, workbooksForward);
    const planRev = await computeLegacyMigrationPlan(db, [...workbooksForward].reverse());

    // 五维行去向 100% 闭合恒等式成立
    expect(planFwd.reconciliation.closed).toBe(true);
    expect(planFwd.reconciliation.totalSourceRows).toBe(
      planFwd.reconciliation.filteredNoiseRows +
        planFwd.reconciliation.foldedDuplicateRows +
        planFwd.reconciliation.mainContractRows +
        planFwd.reconciliation.subEventRows +
        planFwd.reconciliation.conflictAndClueRows,
    );
    expect(planFwd.externalBlockedFiles).toEqual(['合同台账_外部隔离水电开发公司.xlsx']);
    expect(planRev.reconciliation.closed).toBe(true);

    // 正逆序生成的合约集合（按 key 排序）完全一致
    const summarizePlan = (p: typeof planFwd) =>
      p.contracts
        .map((c) => ({
          no: c.normalizedNo,
          legalOrg: c.legalEntityOrgId,
          dir: c.direction,
          mode: c.pricingMode,
          orig: c.originalCents.toString(),
          settledBase: c.legacySettledBaselineCents?.toString() ?? null,
          curStatus: c.currencyStructStatus,
          internal: c.isInternalGroupTx,
          dupGroup: c.duplicateConflictGroup,
        }))
        .sort((a, b) => `${a.legalOrg}:${a.no}`.localeCompare(`${b.legalOrg}:${b.no}`));
    expect(summarizePlan(planRev)).toEqual(summarizePlan(planFwd));

    const authCtx = loadAuthContext(db, adminUserId)!;
    const commitRes = runWithContext({ requestId: 'legacy-commit-1', source: 'cli', auth: authCtx }, () =>
      commitLegacyMigrationPlan(db, planFwd, { userId: adminUserId }),
    );
    expect(commitRes.created).toBe(planFwd.contracts.length);
    expect(commitRes.updated).toBe(0);

    // 1) 外部隔离表 0 行入库
    const extRows = db.prepare("SELECT COUNT(*) AS n FROM ct_contract WHERE contract_no LIKE 'EXTP%'").get() as { n: number };
    expect(extRows.n).toBe(0);

    // 2) 同法人同号异合同 PM-2024-02 双行独立保留，不覆盖
    const dupContracts = db
      .prepare("SELECT contract_no, normalized_no, direction, original_cents, duplicate_conflict_group FROM ct_contract WHERE normalized_no LIKE 'PM-2024-02%' ORDER BY id ASC")
      .safeIntegers(true)
      .all() as { contract_no: string; normalized_no: string; direction: string; original_cents: bigint; duplicate_conflict_group: string }[];
    expect(dupContracts).toHaveLength(2);
    expect(dupContracts[0]).toMatchObject({
      normalized_no: 'PM-2024-02',
      direction: 'income',
      original_cents: 58_000_000n,
      duplicate_conflict_group: 'SUB_PM:PM-2024-02',
    });
    expect(dupContracts[1]).toMatchObject({
      normalized_no: 'PM-2024-02#DUP2',
      direction: 'expense',
      original_cents: 19_800_000n,
      duplicate_conflict_group: 'SUB_PM:PM-2024-02',
    });

    // 3) 集团内部关联协议 GRP-QT-136/2024-28 双视角独立法人建账 + counterparty_contract_id 互链 + C09 执行额写入 legacy_settled_baseline_cents 不改单价 original_cents
    const internalPair = db
      .prepare("SELECT id, legal_entity_org_id, direction, pricing_mode, original_cents, legacy_settled_baseline_cents, is_internal_group_tx, counterparty_contract_id FROM ct_contract WHERE normalized_no LIKE 'GRP-QT-136/2024-28%' ORDER BY direction ASC")
      .safeIntegers(true)
      .all() as {
      id: number;
      legal_entity_org_id: number;
      direction: string;
      pricing_mode: string;
      original_cents: bigint;
      legacy_settled_baseline_cents: bigint | null;
      is_internal_group_tx: number;
      counterparty_contract_id: number | null;
    }[];
    expect(internalPair).toHaveLength(2);
    const [expSide, incSide] = internalPair;
    expect(Number(expSide.legal_entity_org_id)).toBe(grpId);
    expect(Number(incSide.legal_entity_org_id)).toBe(pmId);
    expect(Number(expSide.is_internal_group_tx)).toBe(1);
    expect(Number(incSide.is_internal_group_tx)).toBe(1);
    expect(Number(expSide.counterparty_contract_id)).toBe(Number(incSide.id));
    expect(Number(incSide.counterparty_contract_id)).toBe(Number(expSide.id));
    expect(incSide.pricing_mode).toBe('unit_price');
    expect(incSide.original_cents).toBe(0n);
    expect(incSide.legacy_settled_baseline_cents).toBe(44_472_580n);

    // 4) C09 零命中仅生成 1 条合成号 MIG-PM-2022-001（自表重复已折叠）
    const migRows = db
      .prepare("SELECT contract_no, original_cents, synthetic_no_flag FROM ct_contract WHERE synthetic_no_flag = 1")
      .safeIntegers(true)
      .all() as { contract_no: string; original_cents: bigint; synthetic_no_flag: bigint }[];
    expect(migRows).toEqual([
      { contract_no: 'MIG-PM-2022-001', original_cents: 9_328_000n, synthetic_no_flag: 1n },
    ]);

    // 5) 复合多币种 CNY + PGK 入子表 ct_contract_currency_line，20170302.0 解析为 2017-03-02
    const multiCur = db
      .prepare("SELECT id, original_cents, currency_struct_status, sign_date FROM ct_contract WHERE normalized_no = 'PM-FW-2014-01-001'")
      .safeIntegers(true)
      .get() as { id: bigint; original_cents: bigint; currency_struct_status: string; sign_date: string };
    expect(multiCur).toMatchObject({
      original_cents: 0n,
      currency_struct_status: 'structured_multi',
      sign_date: '2017-03-02',
    });
    const curLines = db
      .prepare('SELECT currency, amount_cents, amount_role FROM ct_contract_currency_line WHERE contract_id = ? ORDER BY line_no ASC')
      .safeIntegers(true)
      .all(multiCur.id) as { currency: string; amount_cents: bigint; amount_role: string }[];
    expect(curLines).toEqual([
      { currency: 'CNY', amount_cents: 3_751_000_000n, amount_role: 'contract_original' },
      { currency: 'PGK', amount_cents: 316_000_000n, amount_role: 'contract_original' },
    ]);

    // 6) 非货币电量 1200万kWh 与单价 2500元/月 不误当万元总价；2012.719 留空 sign_date 并保留原文；无汇率美元查看详情不抛 409
    const kwhRow = db
      .prepare("SELECT pricing_mode, original_cents, unit_price_desc, sign_date, raw_sign_date_text, missing_fields_json FROM ct_contract WHERE normalized_no = 'PM-DL-2021-03'")
      .safeIntegers(true)
      .get() as { pricing_mode: string; original_cents: bigint; unit_price_desc: string; sign_date: string | null; raw_sign_date_text: string; missing_fields_json: string };
    expect(kwhRow.pricing_mode).toBe('unit_price');
    expect(kwhRow.original_cents).toBe(0n);
    expect(kwhRow.unit_price_desc).toContain('1200万kWh');
    expect(kwhRow.sign_date).toBeNull();
    expect(kwhRow.raw_sign_date_text).toBe('2012.719');
    expect(JSON.parse(kwhRow.missing_fields_json)).toContain('signDate');

    const usdId = (db.prepare("SELECT id FROM ct_contract WHERE normalized_no = 'GRP-EQ-01/2023-09'").get() as { id: number }).id;
    const usdDetail = runWithContext({ requestId: 'usd-read', source: 'http', auth: authCtx }, () => getContractDetail(db, usdId));
    expect(usdDetail.currency).toBe('美元');
    expect(usdDetail.exchangeRate ?? null).toBeNull();

    // 7) 历史关停主体 HST-SG-01/2018-01 冻结 signing_org_id=HIST_H 且承接法人=SUB_X，且负向结算红冲落库
    const hstRow = db
      .prepare("SELECT id, signing_org_id, legal_entity_org_id, historical_legal_entity_org_id FROM ct_contract WHERE normalized_no = 'HST-SG-01/2018-01'")
      .get() as { id: number; signing_org_id: number; legal_entity_org_id: number; historical_legal_entity_org_id: number };
    expect(hstRow).toEqual({
      id: expect.any(Number),
      signing_org_id: histId,
      legal_entity_org_id: subXId,
      historical_legal_entity_org_id: histId,
    });
    const revSet = db
      .prepare('SELECT net_payable_cents, origin, migration_mode, is_reversal FROM ct_settlement WHERE contract_id = ?')
      .safeIntegers(true)
      .get(hstRow.id) as { net_payable_cents: bigint; origin: string; migration_mode: string; is_reversal: bigint };
    expect(revSet).toEqual({
      net_payable_cents: -3_500_000n,
      origin: 'legacy_migration',
      migration_mode: 'legacy_tolerant',
      is_reversal: 1n,
    });

    // 8) 防污染 CHECK 约束：迁后新增 manual 结算负净额（即使填 note）必须报错；manual 变更缺依据附件必须报错
    expect(() =>
      db
        .prepare(
          `INSERT INTO ct_settlement (
            contract_id, period_no, settlement_kind, settlement_date, gross_payable_cents, total_deduct_cents, net_payable_cents,
            note, status, origin, migration_mode, is_reversal, submitted_at
          ) VALUES (?, 99, 'progress', '2026-09-01', 0, 100, -100, '企图绕过负净额', 'submitted', 'manual', 'normal', 0, ?)`,
        )
        .run(hstRow.id, now),
    ).toThrow(/CHECK constraint failed/);

    expect(() =>
      db
        .prepare(
          `INSERT INTO ct_change (
            contract_id, org_root_id, change_kind, delta_cents, reason, evidence_document_id,
            required_approval_tier, status, origin, submitted_at
          ) VALUES (?, ?, 'change', 1000, '缺附件手工变更', NULL, 'undertaker_unit', 'submitted', 'manual', ?)`,
        )
        .run(hstRow.id, subXId, now),
    ).toThrow(/CHECK constraint failed/);

    // 9) 二次重跑完全幂等（0 新增、0 更新、全量 unchanged）
    const replayPlan = await computeLegacyMigrationPlan(db, workbooksForward);
    const replayRes = runWithContext({ requestId: 'legacy-commit-2', source: 'cli', auth: authCtx }, () =>
      commitLegacyMigrationPlan(db, replayPlan, { userId: adminUserId }),
    );
    expect(replayRes).toMatchObject({
      created: 0,
      updated: 0,
      unchanged: planFwd.contracts.length,
    });

    // 10) 预览 → 目标合同被并发修改 → 确认触发 409 PREVIEW_STALE 乐观锁
    const store = new ObjectStore(`${dir}/objects-stale-test`);
    const previewDto = await runWithContext({ requestId: 'pv-stale', source: 'http', auth: authCtx }, () =>
      previewContractImport(db, store, wbHistBuf, '2024年历史水电台账.xlsx', subXId, { importMode: 'legacy_tolerant' }),
    );
    db.prepare('UPDATE ct_contract SET version = version + 1 WHERE id = ?').run(hstRow.id);
    await expect(
      runWithContext({ requestId: 'cf-stale', source: 'http', auth: authCtx }, () =>
        confirmContractImport(db, store, previewDto.id, previewDto.planHash),
      ),
    ).rejects.toMatchObject({ code: 'PREVIEW_STALE', status: 409 });
  });
});
