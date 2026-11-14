import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { describe, expect, it } from 'vitest';
import { CONTRACT_IMPORT_KINDS } from '../src/contracts/project-contract';
import { officialSheet, writeOfficialWorkbook } from '../src/modules/contracts/supervision-official-workbook';
import { boot, get, json, post, upload } from './t3-helpers';
import { createScopedUser, fetchAs } from './http-helpers';

function buildStandardLedgerXls(rows: (string | number)[][]): Buffer {
  const wb = XLSX.utils.book_new();
  const ws = XLSX.utils.aoa_to_sheet(rows);
  XLSX.utils.book_append_sheet(wb, ws, '合同台账');
  return Buffer.from(XLSX.write(wb, { type: 'buffer', bookType: 'xls' }));
}

describe('T-13 GAP-13 合同 .xls 导入、权限隔离、8类模板下载与监督导出双用途模式', () => {
  it('支持 .xls 标准与容缺导入、contract:migrate 403 门控、已收金额标签、真实正负变更导入、批次历史及 8 模板下载', async () => {
    const { base, db, admin, fx } = await boot('newfc-t13-imp-exp-');

    // 1) 8 类模板下载路由（主路径与单数别名路径）全部返回有效 xlsx
    for (const kind of CONTRACT_IMPORT_KINDS) {
      const res = await get(base, admin, `/api/contracts/imports/templates/${kind}`);
      expect(res.status).toBe(200);
      const buf = Buffer.from(await res.arrayBuffer());
      const z = await JSZip.loadAsync(buf);
      expect(z.file('xl/workbook.xml')).toBeTruthy();
      expect(z.file('xl/worksheets/sheet1.xml')).toBeTruthy();
    }
    const aliasRes = await get(base, admin, '/api/contracts/imports/template/standard_ledger');
    expect(aliasRes.status).toBe(200);

    // 2) 仅有分部 contract:import 权限但无 contract:migrate / 全域权限的用户：标准导入 201，调用 legacy_tolerant 返回 403
    const normalImporter = createScopedUser(db, {
      username: 'normal-contract-importer',
      roleCodes: ['data_maintainer'],
      orgIds: [fx.orgIds.east],
    });
    const xlsLegacy = buildStandardLedgerXls([
      ['合同台账（单位：万元）'],
      ['序号', '合同编号', '合同名称', '类别', '合同金额（万元）', '支出/收入', '签订日期', '对方单位'],
      [1, 'EAST-ZX-01/2023-01', '历史无日期容缺其他协议', '其他', '15.00', '支出', '', '测试合作单位甲'],
    ]);
    const deniedLegacy = await upload(base, normalImporter.session, '/api/contracts/imports', xlsLegacy, 'legacy.xls', {
      orgId: String(fx.orgIds.east),
      importMode: 'legacy_tolerant',
    });
    expect(deniedLegacy.status).toBe(403);

    // 3) 具备权限的管理员通过 .xls 执行 legacy_tolerant 预览→确认
    const pvLegacy = await json(
      upload(base, admin, '/api/contracts/imports', xlsLegacy, 'legacy.xls', {
        orgId: String(fx.orgIds.east),
        importMode: 'legacy_tolerant',
      }),
    );
    expect(pvLegacy.importMode).toBe('legacy_tolerant');
    expect(pvLegacy.importKind).toBe('legacy_batch_upsert');
    expect(pvLegacy.reconciliation.closed).toBe(true);
    expect(pvLegacy.missingFieldCount).toBe(1);
    const cfLegacy = await json(post(base, admin, `/api/contracts/imports/${pvLegacy.id}/confirm`, { planHash: pvLegacy.planHash }));
    expect(cfLegacy.status).toBe('confirmed');
    expect(cfLegacy.result.created).toBe(1);

    // 4) 收入合同导入返回 paidOrReceivedLabel: '已收金额'
    const wbInc = new ExcelJS.Workbook();
    const wsInc = officialSheet(wbInc, '收入合同基本信息');
    wsInc.addRow([
      'EAST-INC/2026-01', '测试售水服务合同', '总价', '人民币', '50000.00', '',
      '外部购水客户乙', '华东大区', '提供原水供应服务', '',
      '是', '否', '审批', '', '', '', '王五', '部长',
      '项目洽谈', '', '单一投标', '', '2026-03-01', '固定期限', '2026-03-01', '2026-12-31',
      '赵六', '分管领导', '否',
    ]);
    const incBuf = await writeOfficialWorkbook(wbInc);
    const pvInc = await json(
      upload(base, admin, '/api/contracts/imports', incBuf, '收入合同基本信息.xlsx', {
        orgId: String(fx.orgIds.east),
      }),
    );
    expect(pvInc.paidOrReceivedLabel).toBe('已收金额');
    expect(pvInc.errorCount).toBe(0);
    await post(base, admin, `/api/contracts/imports/${pvInc.id}/confirm`, { planHash: pvInc.planHash });

    // 5) supervision_expense_change 导入真实正负变更金额与动态审批层级（不再写死 delta_cents=0）
    const wbExpBase = new ExcelJS.Workbook();
    const wsExpBase = officialSheet(wbExpBase, '支出合同基本信息');
    wsExpBase.addRow([
      'EAST-SG|01/2026-02', '护岸修复施工合同', '总价', '人民币', '1000000.00', '',
      '华东大区', '外部施工企业丙', '护岸修复工程', '其他', '生产经营预算', '', '',
      '', '', '否', '审批', '', '', '', '张总', '总经理',
      '否', '公开招标', '', '2026年度采购计划第3项', '2026-01-10', '2026-02-01',
      '是', '是', '李工', '陈主任', '财务部,企管部', '周会计,吴专员', '孙副总', '副总经理',
      '工程', '', '2026-02-15', '固定期限', '2026-02-15', '2026-10-31', '张总', '总经理', '是', '是',
    ]);
    const pvExp = await json(
      upload(base, admin, '/api/contracts/imports', await writeOfficialWorkbook(wbExpBase), '支出合同基本信息.xlsx', {
        orgId: String(fx.orgIds.east),
      }),
    );
    expect(pvExp.errorCount).toBe(0);
    await post(base, admin, `/api/contracts/imports/${pvExp.id}/confirm`, { planHash: pvExp.planHash });

    const wbChg = new ExcelJS.Workbook();
    const wsChg = officialSheet(wbChg, '支出合同变更');
    wsChg.addRow([
      'EAST-SG|01/2026-02', '护岸修复施工合同', '变更', '地质条件变化增加支护', '现场设计变更签证核增',
      '会议', '总经理（厂长）办公会', '张总', 'EAST-SG|01/2026-02-BC1', '否', '250000.00',
    ]);
    wsChg.addRow([
      'EAST-SG|01/2026-02', '护岸修复施工合同', '变更', '取消部分临时围堰', '工程量核减',
      '审批', '', '孙副总', 'EAST-SG|01/2026-02-BC2', '否', '-50000.00',
    ]);
    const chgSheet = wbChg.getWorksheet('支出合同变更')!;
    chgSheet.getRow(4).getCell(11).value = '变更金额（元）';
    const pvChg = await json(
      upload(base, admin, '/api/contracts/imports', await writeOfficialWorkbook(wbChg), '支出合同变更与纠纷基本信息.xlsx', {
        orgId: String(fx.orgIds.east),
      }),
    );
    expect(pvChg.errorCount).toBe(0);
    await post(base, admin, `/api/contracts/imports/${pvChg.id}/confirm`, { planHash: pvChg.planHash });

    const expCid = (db.prepare("SELECT id, approved_change_cents FROM ct_contract WHERE contract_no = 'EAST-SG|01/2026-02'").safeIntegers(true).get() as {
      id: number;
      approved_change_cents: bigint;
    });
    expect(expCid.approved_change_cents).toBe(20_000_000n); // +250,000 - 50,000 = +200,000.00 元 (20%), >= 20% 触发高阶审批层级
    const chgTiers = db
      .prepare('SELECT delta_cents, required_approval_tier FROM ct_change WHERE contract_id = ? ORDER BY id ASC')
      .safeIntegers(true)
      .all(expCid.id) as { delta_cents: bigint; required_approval_tier: string }[];
    expect(chgTiers[0].delta_cents).toBe(25_000_000n);
    expect(chgTiers[0].required_approval_tier).not.toBe('undertaker_unit');
    expect(chgTiers[1].delta_cents).toBe(-5_000_000n);

    // 6) 导入批次列表查询过滤
    const legacyBatches = await json(get(base, admin, '/api/contracts/imports?importMode=legacy_tolerant&status=confirmed'));
    expect(legacyBatches).toHaveLength(1);
    expect(legacyBatches[0].id).toBe(pvLegacy.id);

    // 7) 为容缺历史合同上传未盖章 contract_text 文档，验证 supervision_submit 阻断 vs internal_archive 放行并打包缺口清单与转义目录
    const legacyCid = (db.prepare("SELECT id FROM ct_contract WHERE contract_no = 'EAST-ZX-01/2023-01'").get() as { id: number }).id;
    const docForm = new FormData();
    docForm.append('docType', 'contract_text');
    docForm.append('file', new Blob([Buffer.from('draft contract body text')]), '历史合同草稿.pdf');
    const upDoc = await fetchAs(admin, `${base}/api/contracts/${legacyCid}/documents`, { method: 'POST', body: docForm });
    expect(upDoc.status).toBe(201);

    const pfSubmit = await json(
      get(base, admin, `/api/contracts/exports/supervision/preflight?scopeMode=all_active&exportPurpose=supervision_submit`),
    );
    expect(pfSubmit.incompleteCount).toBeGreaterThan(0);
    const blockedPkg = await post(base, admin, '/api/contracts/exports/supervision/package', {
      scopeMode: 'all_active',
      exportPurpose: 'supervision_submit',
    });
    expect(blockedPkg.status).toBe(409);

    const pfArchive = await json(
      get(base, admin, `/api/contracts/exports/supervision/preflight?scopeMode=all_active&exportPurpose=internal_archive`),
    );
    expect(pfArchive.incompleteCount).toBeGreaterThan(0);
    const archiveRes = await post(base, admin, '/api/contracts/exports/supervision/package', {
      scopeMode: 'all_active',
      exportPurpose: 'internal_archive',
    });
    expect(archiveRes.status).toBe(200);
    const zip = await JSZip.loadAsync(Buffer.from(await archiveRes.arrayBuffer()));
    const zipFiles = Object.keys(zip.files);
    expect(zipFiles).toContain('缺口待补录清单.xlsx');
    // EAST-ZX-01/2023-01 的 / 被转义为 %，且内部归档模式保留了仅有的 contract_text 正文！
    expect(zipFiles.some((p) => p.startsWith('支出合同附件/EAST-ZX-01%2023-01/03合同文本/') && p.endsWith('.pdf'))).toBe(true);
  });
});
