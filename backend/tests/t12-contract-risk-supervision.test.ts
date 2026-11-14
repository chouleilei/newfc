import { SIGNATORIES, PAYMENT_APPROVAL, CHANGE_GOVERNANCE, seedNetAssets } from './contract-review-fixtures';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { runWithContext } from '../src/core/request-context';
import { openDatabase } from '../src/db/connection';
import { applyMigrations } from '../src/db/migrations';
import { executeTool } from '../src/assistant/tools';
import { exportSupervisionPackageZip } from '../src/modules/contracts/contract-export.service';
import { EXPENSE_BASE_HEADERS, EXPENSE_CHANGE_HEADERS, EXPENSE_EXEC_HEADERS, EXPENSE_EXEC_PAY_HEADERS, INCOME_BASE_HEADERS, INCOME_EXEC_HEADERS, INCOME_EXEC_RECEIVE_HEADERS } from '../src/modules/contracts/supervision-template-spec';
import { ObjectStore } from '../src/modules/files/object-store';
import { calendarDaysBetween, workingDaysBetween } from '../src/modules/risk/risk.service';
import { addCalendarDays, todayUtcDate, workingDayCutoffBefore } from '../src/core/workdays';
import { loadAuthContext } from '../src/modules/security/security.service';
import { boot, get, json, post, upload } from './t3-helpers';
import { createScopedUser, fetchAs } from './http-helpers';
import { createProject, createSupplier } from './t4-helpers';

describe('T-12.1 V70 监督底座迁移与 10 条合同量化风险规则', () => {
  it('V67 → V70 临时文件库无损升级：std_report 重建保留触发器、新增表列与 10 条内置合同风险规则', () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'newfc-t12-v70-'));
    const dbPath = path.join(dir, 'v67-to-v70.sqlite');
    const db = openDatabase(dbPath);
    const now = '2026-11-13T00:00:00.000Z';
    try {
      applyMigrations(db, 67);
      const orgId = Number(db.prepare("INSERT INTO org (code, name, sort_order, created_at, updated_at) VALUES ('1001', '湘水测试', 1, ?, ?)").run(now, now).lastInsertRowid);
      db.prepare(`INSERT INTO std_report (report_type, title, org_id, period, params_json, columns_json, rows_json, summary_json, sources_json, content_sha256, generated_at)
        VALUES ('contract_payment_ledger', '旧报表', ?, '2026-10', '{}', '[]', '[]', '[]', '{}', 'sha-old', ?)`).run(orgId, now);

      expect(applyMigrations(db, 70).map((m) => m.version)).toEqual([68, 69, 70]);
      expect(applyMigrations(db, 70)).toEqual([]);
      expect(db.pragma('foreign_key_check')).toEqual([]);
      expect(db.pragma('integrity_check', { simple: true })).toBe('ok');
      for (const tbl of ['std_report', 'ct_evaluation', 'ct_supervision_export_log', 'ct_import', 'org']) {
        const fks = db.prepare(`SELECT "table" AS t FROM pragma_foreign_key_list('${tbl}')`).all() as { t: string }[];
        expect(fks.every((fk) => !fk.t.endsWith('_v70')), `${tbl}: ${JSON.stringify(fks)}`).toBe(true);
      }

      // std_report 保留冻结与不可删除触发器，并支持 contract_monthly_pack
      expect(() => db.prepare("UPDATE std_report SET title = '改' WHERE id = 1").run()).toThrow(/不可修改/);
      expect(() => db.prepare('DELETE FROM std_report WHERE id = 1').run()).toThrow(/不可删除/);
      db.prepare(`INSERT INTO std_report (report_type, title, org_id, period, params_json, columns_json, rows_json, summary_json, sources_json, content_sha256, generated_at)
        VALUES ('contract_monthly_pack', '月度5表', ?, '2026-11', '{}', '[]', '[]', '[]', '{}', 'sha-pack', ?)`).run(orgId, now);

      const rules = db.prepare("SELECT code FROM risk_rule WHERE source = 'contract' AND builtin = 1 ORDER BY code").all() as { code: string }[];
      expect(rules.map((r) => r.code)).toEqual([
        'CONTRACT_CHANGE_TIER_MISMATCH',
        'CONTRACT_DISTRIBUTION_OVERDUE',
        'CONTRACT_EMERGENCY_OVERDUE',
        'CONTRACT_GUARANTEE_WARRANTY_DUE',
        'CONTRACT_LONG_UNSETTLED',
        'CONTRACT_OVER_SETTLE_OR_PAY',
        'CONTRACT_PAY_NO_VOUCHER',
        'CONTRACT_PAY_OVER_CAP',
        'CONTRACT_PERFORM_BEFORE_EFFECTIVE',
        'CONTRACT_SIGN_BEFORE_PROCUREMENT',
        'CONTRACT_SPLIT_EVADE_TENDER',
        'CONTRACT_UNDERTAKER_UNASSIGNED',
        'SUPPLIER_LARGE_PAYMENTS',
      ]);
    } finally {
      db.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }
  });

  it('工作日与自然日计算纯函数精确性', () => {
    expect(calendarDaysBetween('2026-11-01', '2026-11-11')).toBe(10);
    expect(workingDaysBetween('2026-11-02', '2026-11-06')).toBe(4); // Mon -> Fri
    expect(workingDaysBetween('2026-11-02', '2026-11-16')).toBe(10); // Mon -> Mon + 2 weeks
    expect(workingDaysBetween('2026-11-06', '2026-11-09')).toBe(1); // Fri -> Mon (skips Sat/Sun)
    expect(workingDaysBetween('2026-11-10', '2026-11-05')).toBe(0);
    for (const d of ['2026-11-13', '2026-11-14', '2026-11-15', '2026-11-16', '2026-11-17']) {
      const cutoff = workingDayCutoffBefore(d, 10);
      expect(workingDaysBetween(cutoff, d)).toBe(11);
      expect(workingDaysBetween(addCalendarDays(cutoff, 1)!, d)).toBe(10);
    }
  });

  it('10 条新增合同量化风险规则：拆分规避招标、时限工作日、未签先履约、变更越权、超结算专户及保函质保纠纷全命中', async () => {
    const { base, db, admin, fx } = await boot('newfc-t12-risk-');
    seedNetAssets(db);
    const sh = fx.orgIds.shanghai;
    const nj = fx.orgIds.nanjing;
    const p1 = await createProject(base, admin, 'P-T12-1', '灌区改造项目', sh);
    const p2 = await createProject(base, admin, 'P-T12-2', '南京分部项目', nj);
    const s1 = await createSupplier(base, admin, 'S-T12-1', '湘水施工集团');
    const now = new Date().toISOString();
    const todayStr = now.slice(0, 10);
    const daysAgo = (n: number) => new Date(Date.now() - n * 86_400_000).toISOString().slice(0, 10);
    const daysAhead = (n: number) => new Date(Date.now() + n * 86_400_000).toISOString().slice(0, 10);

    const foId = Number(db.prepare("INSERT INTO file_object (sha256, size_bytes, content_type, original_name, created_at) VALUES (?, 10, 'application/pdf', 'r.pdf', ?)").run('c'.repeat(64), now).lastInsertRowid);

    // 1) 拆分规避公开招标：同年同项目同供应商两份 180 万施工合同（各自二级采购，合并 360 万 >= 300 万一级公开招标门槛）
    for (const idx of [1, 2]) {
      const id = Number(db.prepare(`INSERT INTO ct_contract (
        contract_no, normalized_no, name, contract_type, org_id, project_id, supplier_id, original_cents,
        stage, status, sign_date, effective_date, procurement_start_date, supplier_confirm_date,
        legal_category, is_procurement, procurement_target, procurement_method, procurement_tier,
        undertaker_name, farmer_wage_account, distribution_status, distributed_at, created_at, updated_at
      ) VALUES (?, ?, ?, '工程', ?, ?, ?, 180000000, 'performance', 'active', '2026-05-10', '2026-05-10', '2026-04-01', '2026-04-20',
        'construction', 1, 'construction', 'negotiation', 'tier_2', '张工', '62220001', 'completed', '2026-05-12', ?, ?)`)
        .run(`SPLIT-0${idx}`, `SPLIT-0${idx}`, `拆分合同${idx}`, sh, p1, s1, now, now).lastInsertRowid);
      db.prepare("INSERT INTO ct_document (contract_id, doc_type, file_object_id, name, uploaded_at) VALUES (?, 'procurement', ?, 'proc.pdf', ?)").run(id, foId, now);
    }

    // 2) 采购日期倒置 + 未签先履约 + 超 10 工作日未分发 + 缺承办人 + 交接超 15 工作日 + 施工缺专户 + 到期超 180 天未结算
    const cBadId = Number(db.prepare(`INSERT INTO ct_contract (
      contract_no, normalized_no, name, contract_type, org_id, project_id, supplier_id, original_cents, settled_net_cents, paid_cents,
      stage, status, sign_date, effective_date, procurement_start_date, supplier_confirm_date,
      term_type, term_start_date, term_end_date, legal_category, report_category,
      is_procurement, procurement_target, procurement_method, procurement_tier,
      undertaker_name, farmer_wage_account, distribution_status, created_at, updated_at
    ) VALUES ('BAD-01', 'BAD-01', '违规施工合同', '工程', ?, ?, ?, 100000000, 120000000, 90000000,
      'performance', 'active', ?, ?, ?, ?,
      'fixed', ?, ?, 'construction', 'engineering',
      1, 'construction', 'public_tender', 'tier_2',
      '', '', 'pending', ?, ?)`)
      .run(sh, p1, s1, daysAgo(30), daysAgo(25), daysAgo(15), daysAgo(20), daysAgo(35), daysAgo(200), now, now).lastInsertRowid);
    const chgDoc = Number(db.prepare("INSERT INTO ct_document (contract_id, doc_type, file_object_id, name, uploaded_at) VALUES (?, 'change', ?, 'chg.pdf', ?)").run(cBadId, foId, now).lastInsertRowid);
    db.prepare("INSERT INTO ct_undertaker_handover (contract_id, from_undertaker, to_undertaker, left_post_date, handover_date, created_at) VALUES (?, '李一', '王二', ?, ?, ?)")
      .run(cBadId, daysAgo(40), daysAgo(5), now);

    // 变更越权 + 缺补充协议号 + 缺纪审备案 + 技术审查超 10 天
    db.prepare(`INSERT INTO ct_change (
      contract_id, org_root_id, change_kind, delta_cents, reason, evidence_document_id,
      required_approval_tier, actual_approval_tier, tech_review_applied_at, status, submitted_at, reviewed_at
    ) VALUES (?, ?, 'change', 5000000, '增项未备案', ?, 'dual_vp', 'undertaker_unit', ?, 'approved', ?, ?)`)
      .run(cBadId, sh, chgDoc, daysAgo(15), now, now);

    // 保函临期(10天后到期) + 保函索赔超 2 日未报告 + 质保期满超 30 天未签证 + 纠纷超 2 工作日未报告 & 结案未双备案
    db.prepare(`INSERT INTO ct_guarantee (contract_id, guarantee_type, direction, issuer_name, guarantee_no, amount_cents, status, expiry_date, created_at, updated_at)
      VALUES (?, 'performance_guarantee', 'inbound', '建行', 'LG-DUE', 10000000, 'active', ?, ?, ?)`).run(cBadId, daysAhead(10), now, now);
    db.prepare(`INSERT INTO ct_guarantee (contract_id, guarantee_type, direction, issuer_name, guarantee_no, amount_cents, status, claim_occurred_at, created_at, updated_at)
      VALUES (?, 'prepayment_guarantee', 'inbound', '工行', 'LG-CLAIM', 5000000, 'claimed', ?, ?, ?)`).run(cBadId, daysAgo(5), now, now);
    db.prepare(`INSERT INTO ct_warranty (contract_id, start_date, end_date, retention_cents, created_at, updated_at)
      VALUES (?, ?, ?, 5000000, ?, ?)`).run(cBadId, daysAgo(400), daysAgo(45), now, now);
    db.prepare(`INSERT INTO ct_dispute (contract_id, occurred_date, stage, case_no, dispute_cents, closed_date, created_at, updated_at)
      VALUES (?, ?, 'closed', '(2026)湘01民初9号', 8000000, ?, ?, ?)`).run(cBadId, daysAgo(12), todayStr, now, now);

    // 3) 应急项目开工超 15 工作日未完成审批签约 (放南京组织测范围隔离)
    db.prepare(`INSERT INTO ct_contract (
      contract_no, normalized_no, name, contract_type, org_id, project_id, supplier_id, original_cents,
      stage, status, is_emergency, emergency_start_date, budget_type, undertaker_name, created_at, updated_at
    ) VALUES ('EMG-NJ-01', 'EMG-NJ-01', '南京应急抢险合同', '工程', ?, ?, ?, 50000000,
      'drafting', 'active', 1, ?, 'emergency_unplanned', '赵工', ?, ?)`)
      .run(nj, p2, s1, daysAgo(25), now, now);

    const scan = await json(post(base, admin, '/api/risk/scans'));
    expect(scan.createdCount).toBeGreaterThanOrEqual(10);

    const events = await json(get(base, admin, '/api/risk/events')) as { ruleCode: string; orgId: number }[];
    const codes = new Set(events.map((e) => e.ruleCode));
    for (const expected of [
      'CONTRACT_SIGN_BEFORE_PROCUREMENT',
      'CONTRACT_PERFORM_BEFORE_EFFECTIVE',
      'CONTRACT_EMERGENCY_OVERDUE',
      'CONTRACT_DISTRIBUTION_OVERDUE',
      'CONTRACT_UNDERTAKER_UNASSIGNED',
      'CONTRACT_CHANGE_TIER_MISMATCH',
      'CONTRACT_SPLIT_EVADE_TENDER',
      'CONTRACT_OVER_SETTLE_OR_PAY',
      'CONTRACT_LONG_UNSETTLED',
      'CONTRACT_GUARANTEE_WARRANTY_DUE',
    ]) {
      expect(codes.has(expected), `缺少命中规则 ${expected}: ${JSON.stringify([...codes])}`).toBe(true);
    }

    // 组织隔离：上海范围用户只能看到上海的风险，看不到南京应急合同风险
    const shAnalyst = createScopedUser(db, { username: 't12-sh-ana', roleCodes: ['finance_analyst'], orgIds: [sh] }).session;
    const shEvents = await json(get(base, shAnalyst, '/api/risk/events')) as { ruleCode: string; orgId: number }[];
    expect(shEvents.every((e) => e.orgId === sh)).toBe(true);
    expect(shEvents.some((e) => e.ruleCode === 'CONTRACT_EMERGENCY_OVERDUE')).toBe(false);
  });
});

async function buildXlsx(sheets: { name: string; rows: (string | number)[][] }[]): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  for (const s of sheets) {
    const ws = wb.addWorksheet(s.name);
    for (const r of s.rows) ws.addRow(r);
  }
  return Buffer.from(await wb.xlsx.writeBuffer());
}

async function uploadDoc(base: string, session: Parameters<typeof post>[1], contractId: number, docType: string, evidenceKind: string | undefined, fileName: string, changeId?: number) {
  const fd = new FormData();
  fd.append('file', new Blob([Buffer.from(`%PDF-1.4 ${fileName}`)], { type: 'application/pdf' }), fileName);
  fd.append('docType', docType);
  fd.append('name', fileName);
  if (evidenceKind) fd.append('evidenceKind', evidenceKind);
  if (changeId) fd.append('changeId', String(changeId));
  const res = await fetchAs(session, `${base}/api/contracts/${contractId}/documents`, { method: 'POST', body: fd });
  expect(res.status).toBe(201);
  return res;
}

describe('T-12.2 / T-12.3 / T-12.4 多模板导入、双口径导出、OA 门户与履约评价', () => {
  it('AC-CLM-11~14 全链路：万元月报与纪巡财审多表导入、5 表月报与 6 表 ZIP 导出、预检/权限/内存守卫、OA 门户、评价及小澧工具', async () => {
    const { base, db, admin, fx, dir } = await boot('newfc-t12-all-');
    seedNetAssets(db);
    const sh = fx.orgIds.shanghai;
    const nj = fx.orgIds.nanjing;
    const pSh = await createProject(base, admin, 'P-SH-12', '上海引水工程', sh);
    await createSupplier(base, admin, 'S-SH-12', '湘水设备供应商');
    db.prepare("UPDATE org SET report_full_name = '澧水公司/上海公司' WHERE id = ?").run(sh);
    db.prepare("UPDATE org SET report_full_name = '澧水公司/南京公司' WHERE id = ?").run(nj);

    // 1) T-12.2 公司万元月报导入（含 万元->分 精确换算 & '/' 单价识别 & 合计行过滤）
    const monthlyImportBuf = await buildXlsx([{
      name: '02_合同台账总表',
      rows: [
        [],
        ['合同台账（总表）'],
        ['序号', '类别', '合同编号', '合同名称', '年度计划项目名称', '初始签订合同金额 (万元)', '支出/收入', '签订日期', '工期', '对方单位名称（全称）', '采购方式', '承办部门(简称)', '承办人', '合同变更（详见变更表）', '累计变更金额', '合同结算（详见结算表）', '累计结算金额', '执行情况', '合同存在的风险', '备注'],
        [1, '工程', 'MW-001', '万元精度工程合同', '年度工程', '123.456789', '支出', '2026-03-15', '180天', '湘水设备供应商', '公开招标', '上海公司', '周工', 0, 0, 0, 0, '执行中', '', '万元测试'],
        [2, '服务', 'MW-UP-02', '单价框架维保合同', '', '/', '支出', '2026-04-01', '1年', '湘水设备供应商', '询价', '上海公司', '吴工', 0, 0, 0, 0, '执行中', '', '单价识别'],
        ['合计', '', '', '', '', '123.456789', '', '', '', '', '', '', '', '', '', '', '', '', '', ''],
      ],
    }]);
    const mp = await json(upload(base, admin, '/api/contracts/imports', monthlyImportBuf, 'monthly_2026.xlsx'));
    expect(mp).toMatchObject({ importKind: 'monthly_ledger_wan', errorCount: 0, counts: { create: 2, update: 0, unchanged: 0 } });
    const mc = await json(post(base, admin, `/api/contracts/imports/${mp.id}/confirm`, { planHash: mp.planHash }));
    expect(mc.result.created).toBe(2);
    const mw1 = await json(get(base, admin, `/api/contracts/${mc.result.contractIds[0]}`));
    const mw2 = await json(get(base, admin, `/api/contracts/${mc.result.contractIds[1]}`));
    expect(mw1).toMatchObject({ originalAmount: '1234567.89', reportCategory: 'engineering', procurementMethod: 'public_tender' });
    expect(mw2).toMatchObject({ pricingMode: 'unit_price', originalAmount: '0.00' });
    expect(mw2.unitPriceDesc).toBeTruthy();

    // 2) T-12.2 纪巡财审官方多表链路：收入基本信息 -> 支出基本信息(资金来源=收入合同) -> 支出执行及逐笔实付 -> 收入执行及逐笔实收 -> 支出变更(0金额+特殊字符编号+笔误防护)
    const incBaseRow = Array(INCOME_BASE_HEADERS.length).fill('');
    incBaseRow[0] = 'INC-SUP-01'; incBaseRow[1] = '上海智慧水务收入合同'; incBaseRow[2] = '单价'; incBaseRow[3] = '人民币';
    incBaseRow[5] = '150元/点位'; incBaseRow[6] = '湖南客户单位'; incBaseRow[7] = '澧水公司/上海公司';
    incBaseRow[8] = '提供智慧监测数据服务'; incBaseRow[10] = '是'; incBaseRow[11] = '是';
    incBaseRow[12] = '会议'; incBaseRow[13] = '总经理（厂长）办公会'; incBaseRow[16] = '李明'; incBaseRow[17] = '总经理';
    incBaseRow[18] = '投标'; incBaseRow[20] = '单一投标'; incBaseRow[22] = '2026-02-10';
    incBaseRow[23] = '固定期限'; incBaseRow[24] = '2026-02-15'; incBaseRow[25] = '2026-12-31';
    incBaseRow[26] = '张强'; incBaseRow[27] = '授权代表'; incBaseRow[28] = '否';

    const incBaseBuf = await buildXlsx([{
      name: '收入合同基本信息',
      rows: [['收入合同管理'], INCOME_BASE_HEADERS.map((_, i) => i + 1), [], [...INCOME_BASE_HEADERS], ['（1）必填说明行'], incBaseRow],
    }]);
    const ibp = await json(upload(base, admin, '/api/contracts/imports', incBaseBuf, 'inc_base.xlsx'));
    expect(ibp).toMatchObject({ importKind: 'supervision_income_base', errorCount: 0 });
    const ibc = await json(post(base, admin, `/api/contracts/imports/${ibp.id}/confirm`, { planHash: ibp.planHash }));
    const incId = ibc.result.contractIds[0];

    const expBaseRow = Array(EXPENSE_BASE_HEADERS.length).fill('');
    expBaseRow[0] = 'EXP-SUP-01'; expBaseRow[1] = '以收定支工程设备合同'; expBaseRow[2] = '总价'; expBaseRow[3] = '人民币';
    expBaseRow[4] = '880023.54'; expBaseRow[6] = '澧水公司/上海公司'; expBaseRow[7] = '湘水设备供应商';
    expBaseRow[8] = '采购并安装水质在线监测设备'; expBaseRow[9] = '收入合同';
    expBaseRow[11] = 'INC-SUP-01'; expBaseRow[12] = '上海智慧水务收入合同';
    expBaseRow[14] = '专业设备具备承接资质'; expBaseRow[15] = '是'; expBaseRow[16] = '会议';
    expBaseRow[17] = '总经理（厂长）办公会'; expBaseRow[20] = '李明'; expBaseRow[21] = '总经理';
    expBaseRow[22] = '否'; expBaseRow[23] = '公开招标'; expBaseRow[25] = '2026年度物资采购计划';
    expBaseRow[26] = '2026-03-01'; expBaseRow[27] = '2026-03-10'; expBaseRow[28] = '是'; expBaseRow[29] = '是';
    expBaseRow[30] = '陈工'; expBaseRow[31] = '科长A'; expBaseRow[32] = '企管部'; expBaseRow[33] = '审核B';
    expBaseRow[34] = '王总'; expBaseRow[35] = '副总'; expBaseRow[36] = '工程';
    expBaseRow[38] = '2026-03-20'; expBaseRow[39] = '固定期限'; expBaseRow[40] = '2026-03-25'; expBaseRow[41] = '2026-10-30';
    expBaseRow[42] = '赵代表'; expBaseRow[43] = '部门主任'; expBaseRow[44] = '否'; expBaseRow[45] = '是';

    const expBaseBuf = await buildXlsx([{
      name: '支出合同基本信息',
      rows: [['支出合同管理'], EXPENSE_BASE_HEADERS.map((_, i) => i + 1), [], [...EXPENSE_BASE_HEADERS], ['（1）同法人合同号不重复必填'], expBaseRow],
    }]);
    const ebp = await json(upload(base, admin, '/api/contracts/imports', expBaseBuf, 'exp_base.xlsx'));
    expect(ebp).toMatchObject({ importKind: 'supervision_expense_base', errorCount: 0 });
    const ebc = await json(post(base, admin, `/api/contracts/imports/${ebp.id}/confirm`, { planHash: ebp.planHash }));
    const expId = ebc.result.contractIds[0];

    const expDetailAfterBase = await json(get(base, admin, `/api/contracts/${expId}`));
    expect(expDetailAfterBase).toMatchObject({
      direction: 'expense', fundingSource: 'income_contract', sourceIncomeContractNo: 'INC-SUP-01',
      originalAmount: '880023.54', ourSignatoryName: '赵代表', ourSignatoryIsLegalRep: false,
    });

    // 逐笔实付导入（保留真实 paid_date 与审批人）
    const expExecBuf = await buildXlsx([
      {
        name: '支出合同执行信息',
        rows: [['支出合同执行信息'], [1, 2, 3, 4, 5], [], [...EXPENSE_EXEC_HEADERS], ['（1）必填'], ['EXP-SUP-01', '以收定支工程设备合同', '执行中', '是', '否']],
      },
      {
        name: '实际支付时间与金额',
        rows: [
          ['实际付款时间与金额'], [1, 2, 3, 4, 5, 6, 7], [...EXPENSE_EXEC_PAY_HEADERS], ['（1）须在Sheet1'],
          ['EXP-SUP-01', '以收定支工程设备合同', '2026-04-10', '人民币', '10000.00', '李才', '财务主任'],
          ['EXP-SUP-01', '以收定支工程设备合同', '2026-05-20', '人民币', '25000.50', '王总', '总经理'],
        ],
      },
    ]);
    const eep = await json(upload(base, admin, '/api/contracts/imports', expExecBuf, 'exp_exec.xlsx'));
    expect(eep).toMatchObject({ importKind: 'supervision_expense_exec', errorCount: 0 });
    await json(post(base, admin, `/api/contracts/imports/${eep.id}/confirm`, { planHash: eep.planHash }));
    const expAfterPay = await json(get(base, admin, `/api/contracts/${expId}`));
    expect(expAfterPay.paidAmount).toBe('35000.50');
    expect(expAfterPay.payments.map((p: { paidDate: string; amount: string; approverName: string }) => [p.paidDate, p.amount, p.approverName])).toEqual([
      ['2026-04-10', '10000.00', '李才'],
      ['2026-05-20', '25000.50', '王总'],
    ]);

    // 逐笔实收导入
    const incExecBuf = await buildXlsx([
      {
        name: '收入合同执行信息',
        rows: [['收入合同执行信息'], [1, 2, 3, 4], [], [...INCOME_EXEC_HEADERS], ['（1）必填'], ['INC-SUP-01', '上海智慧水务收入合同', '执行中', '否']],
      },
      {
        name: '实际收款时间与金额',
        rows: [
          ['实际收款时间与金额'], [1, 2, 3, 4, 5], [...INCOME_EXEC_RECEIVE_HEADERS], ['（1）须在Sheet1'],
          ['INC-SUP-01', '上海智慧水务收入合同', '2026-06-05', '人民币', '120000.00'],
          ['INC-SUP-01', '上海智慧水务收入合同', '2026-07-12', '人民币', '80000.50'],
        ],
      },
    ]);
    const iep = await json(upload(base, admin, '/api/contracts/imports', incExecBuf, 'inc_exec.xlsx'));
    expect(iep).toMatchObject({ importKind: 'supervision_income_exec', errorCount: 0 });
    await json(post(base, admin, `/api/contracts/imports/${iep.id}/confirm`, { planHash: iep.planHash }));
    const incAfterRec = await json(get(base, admin, `/api/contracts/${incId}`));
    expect(incAfterRec.receivedAmount).toBe('200000.50');
    expect(incAfterRec.receipts.map((r: { receivedDate: string; amount: string }) => [r.receivedDate, r.amount])).toEqual([
      ['2026-06-05', '120000.00'],
      ['2026-07-12', '80000.50'],
    ]);

    // 支出变更导入（0金额、补充协议含 | / 特殊字符、D4=主要事项 E4=原因 笔误防护）
    const expChgBuf = await buildXlsx([{
      name: '支出合同变更',
      rows: [
        ['支出合同变更管理'], EXPENSE_CHANGE_HEADERS.map((_, i) => i + 1), [], [...EXPENSE_CHANGE_HEADERS],
        ['（1）原合同编号', '', '', '（1）填写主要原因(官方笔误)', '（1）填写主要事项(官方笔误)'],
        ['EXP-SUP-01', '以收定支工程设备合同', '变更', '调整结算开票账户信息', '机构账户合并要求', '审批', '', '李明', '测试|BG/01', '是'],
      ],
    }]);
    const ecp = await json(upload(base, admin, '/api/contracts/imports', expChgBuf, 'exp_chg.xlsx'));
    expect(ecp).toMatchObject({ importKind: 'supervision_expense_change', errorCount: 0 });
    await json(post(base, admin, `/api/contracts/imports/${ecp.id}/confirm`, { planHash: ecp.planHash }));
    const expAfterChg = await json(get(base, admin, `/api/contracts/${expId}`));
    const chgObj = expAfterChg.changes[0];
    expect(chgObj).toMatchObject({
      delta: '0.00', changeMatter: '调整结算开票账户信息', reason: '机构账户合并要求',
      supplementNo: '测试|BG/01', hasDispute: true,
    });

    // 南京组织单独建一份合同，测试后续导出与门户隔离
    const njRes = await json(post(base, admin, '/api/contracts', { ...SIGNATORIES,
      contractNo: 'NJ-ISOL-01', name: '南京隔离合同', contractType: '服务', orgId: nj,
      direction: 'expense', partyRole: 'buyer', originalAmount: '50000.00', signDate: '2026-05-01',
    }));
    await uploadDoc(base, admin, njRes.id, 'signed', 'other', 'nj_secret.pdf');

    // 3) T-12.3 公司 5 表月报 Excel & 标准报表 contract_monthly_pack
    const monthlyResp = await fetchAs(admin, `${base}/api/contracts/exports/monthly-ledger?period=2026-05&orgId=${sh}`);
    expect(monthlyResp.status).toBe(200);
    const monthlyOutWb = new ExcelJS.Workbook();
    await monthlyOutWb.xlsx.load(Buffer.from(await monthlyResp.arrayBuffer()) as unknown as ExcelJS.Buffer, { ignoreNodes: ['dataValidations'] });
    expect(monthlyOutWb.worksheets.map((w) => w.name)).toEqual(['01_月度统计表', '02_合同台账总表', '03_结算动态分表', '04_变更动态分表', '05_招标项目清查表']);
    const ledgerSheet = monthlyOutWb.getWorksheet('02_合同台账总表')!;
    const ledgerText = JSON.stringify(ledgerSheet.getSheetValues());
    expect(ledgerText).toContain('88.002354'); // 880023.54 元 -> 88.002354 万元
    expect(ledgerText).toContain('123.456789');
    expect(ledgerText).not.toContain('NJ-ISOL-01');

    const stdRep = await json(post(base, admin, '/api/standard-reports', { reportType: 'contract_monthly_pack', period: '2026-05', orgId: sh }));
    expect(stdRep).toMatchObject({ reportType: 'contract_monthly_pack', status: 'generated' });
    const stdExp = await fetchAs(admin, `${base}/api/standard-reports/${stdRep.id}/export`);
    expect(stdExp.status).toBe(200);

    // 4) T-12.3 纪巡财审预检 + 6 表 ZIP + 附件目录树 + 权限/内存守卫
    await uploadDoc(base, admin, expId, 'other', 'triple_major_decision', 'decision.pdf');
    await uploadDoc(base, admin, expId, 'qualification', 'supplier_qualification', 'qual.pdf');
    await uploadDoc(base, admin, expId, 'signed', undefined, 'signed.pdf');
    await uploadDoc(base, admin, expId, 'authorization', 'our_signatory_auth', 'auth.pdf');
    await uploadDoc(base, admin, expId, 'change', 'change_decision', 'chg_decision.pdf', chgObj.id);

    await uploadDoc(base, admin, expId, 'change', 'change_agreement', 'chg_agreement.pdf', chgObj.id);
    const pfBefore = await json(get(base, admin, `/api/contracts/exports/supervision/preflight?orgId=${sh}&scopeMode=all_active`));
    const expPf = pfBefore.items.find((i: { contractNo: string }) => i.contractNo === 'EXP-SUP-01');
    expect(expPf).toMatchObject({ ready: true, missingFields: [], missingAttachments: [] });
    const incPf = pfBefore.items.find((i: { contractNo: string }) => i.contractNo === 'INC-SUP-01');
    expect(incPf.missingAttachments).toContain('03收款方合同签署人授权附件');

    await uploadDoc(base, admin, incId, 'other', 'company_approval', 'inc_decision.pdf');
    await uploadDoc(base, admin, incId, 'signed', undefined, 'inc_signed.pdf');
    await uploadDoc(base, admin, incId, 'authorization', 'our_signatory_auth', 'inc_auth.pdf');
    const incDetail = await json(get(base, admin, `/api/contracts/${incId}`));
    await json(fetchAs(admin, `${base}/api/contracts/${incId}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedVersion: incDetail.version, undertakerName: '张工' }) }));
    const zipResp = await fetchAs(admin, `${base}/api/contracts/exports/supervision/package`, {
      method: 'POST', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ period: '2026-05', orgId: sh, scopeMode: 'changed' }),
    });
    expect(zipResp.status).toBe(200);
    const zipBuf = Buffer.from(await zipResp.arrayBuffer());
    const zip = await JSZip.loadAsync(zipBuf);
    const entryNames = Object.keys(zip.files);
    expect(entryNames).toEqual(expect.arrayContaining([
      '支出合同基本信息.xlsx', '支出合同执行信息.xlsx', '支出合同变更与纠纷基本信息.xlsx',
      '收入合同基本信息.xlsx', '收入合同执行信息.xlsx', '收入合同变更与纠纷基本信息.xlsx',
      '补充协议目录转义清单.json',
    ]));
    expect(entryNames.some((n) => n.startsWith('支出合同附件/EXP-SUP-01/01决策附件/'))).toBe(true);
    expect(entryNames.some((n) => n.startsWith('支出合同附件/EXP-SUP-01/03合同文本/'))).toBe(true);
    expect(entryNames.some((n) => n.startsWith('支出合同附件/EXP-SUP-01/04付款方合同签署人授权附件/'))).toBe(true);
    expect(entryNames.some((n) => n.startsWith('支出合同变更与纠纷附件/测试$BG%01/01变更决策附件/'))).toBe(true);
    expect(entryNames.some((n) => n.includes('NJ-ISOL-01') || n.includes('nj_secret'))).toBe(false);

    const expPayWb = new ExcelJS.Workbook();
    await expPayWb.xlsx.load((await zip.file('支出合同执行信息.xlsx')!.async('nodebuffer')) as unknown as ExcelJS.Buffer, { ignoreNodes: ['dataValidations'] });
    const paySheetVals = JSON.stringify(expPayWb.getWorksheet('实际支付时间与金额')!.getSheetValues());
    expect(paySheetVals).toContain('2026-04-10');
    expect(paySheetVals).toContain('2026-05-20');
    expect(paySheetVals).not.toContain('10,000'); // 无千位逗号

    // 导出日志 & 内存上限守卫 & 权限守卫
    const logs = await json(get(base, admin, '/api/contracts/exports/logs'));
    expect(logs.length).toBeGreaterThanOrEqual(2);
    const store = new ObjectStore(path.join(dir, 'objects'));
    await expect(exportSupervisionPackageZip(db, store, { orgId: sh, period: '2026-05', scopeMode: 'changed', maxZipBytes: 1024 })).rejects.toThrow(/上限/);

    const viewerOnly = createScopedUser(db, { username: 't12-viewer', roleCodes: ['viewer'], orgIds: [sh] }).session;
    expect((await fetchAs(viewerOnly, `${base}/api/contracts/exports/monthly-ledger?period=2026-05`)).status).toBe(403);
    expect((await get(base, viewerOnly, `/api/contracts/supervision-portal/full?orgId=${nj}`)).status).toBe(404);

    // 5) T-12.4 OA 监督门户全量/增量只读接口 & 履约后评价 & 小澧助手只读工具
    const portalFull = await json(get(base, viewerOnly, '/api/contracts/supervision-portal/full'));
    expect(portalFull.items.every((i: { orgId: number }) => i.orgId === sh)).toBe(true);
    expect(portalFull.summary).toMatchObject({ totalContracts: portalFull.items.length });
    expect(portalFull.summary.constructionSummary.count).toBeGreaterThanOrEqual(2);

    const firstCursor = portalFull.items[0].updatedAt;
    const portalInc = await json(get(base, viewerOnly, `/api/contracts/supervision-portal/incremental?since=${encodeURIComponent(firstCursor)}&cursorId=${portalFull.items[0].id}`));
    expect(portalInc.mode).toBe('incremental');
    expect(portalInc.items.length).toBeLessThan(portalFull.items.length);

    // 履约后评价（仅 closed 可评、需 contract:review）
    const notClosedEval = await fetchAs(admin, `${base}/api/contracts/${expId}/evaluation`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ qualityScore: 5, scheduleScore: 4, serviceScore: 5, recommendation: 'preferred', comment: '未完结拦截' }),
    });
    expect(notClosedEval.status).toBe(409);

    // 创建一份简易无质保完结合同并推进至 closed，登记评价
    const cClose = await json(post(base, admin, '/api/contracts', { ...SIGNATORIES,
      contractNo: 'EVAL-01', name: '待评价完结合同', contractType: '服务', orgId: sh, projectId: pSh,
      supplierId: 1, originalAmount: '10000.00', signDate: '2026-04-01', hasWarranty: false,
    }));
    await uploadDoc(base, admin, cClose.id, 'procurement', undefined, 'p.pdf');
    const docTxt = await json(uploadDoc(base, admin, cClose.id, 'contract_text', undefined, 't.pdf'));
    const docSgn = await json(uploadDoc(base, admin, cClose.id, 'signed', undefined, 's.pdf'));
    await uploadDoc(base, admin, cClose.id, 'performance', undefined, 'perf.pdf');
    await uploadDoc(base, admin, cClose.id, 'acceptance', undefined, 'acc.pdf');
    const docInv = await json(uploadDoc(base, admin, cClose.id, 'invoice', undefined, 'inv.pdf'));
    let d = await json(get(base, admin, `/api/contracts/${cClose.id}`));
    d = await json(post(base, admin, `/api/contracts/${cClose.id}/advance`, { expectedVersion: d.version, toStage: 'procurement' }));
    d = await json(post(base, admin, `/api/contracts/${cClose.id}/advance`, { expectedVersion: d.version, toStage: 'drafting' }));
    d = await json(post(base, admin, `/api/contracts/${cClose.id}/advance`, { expectedVersion: d.version, toStage: 'approval' }));
    d = await json(post(base, admin, `/api/contracts/${cClose.id}/reviews`, { documentId: docTxt.id }));
    d = await json(post(base, admin, `/api/contracts/${cClose.id}/reviews/${d.reviews[0].id}/decide`, { decision: 'approve', exceptionReason: '测试' }));
    expect(docSgn.id).toBeGreaterThan(0);
    d = await json(post(base, admin, `/api/contracts/${cClose.id}/advance`, { expectedVersion: d.version, toStage: 'performance' }));
    d = await json(post(base, admin, `/api/contracts/${cClose.id}/advance`, { expectedVersion: d.version, toStage: 'settlement' }));
    d = await json(fetchAs(admin, `${base}/api/contracts/${cClose.id}`, { method: 'PATCH', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ expectedVersion: d.version, finalAccepted: true }) }));
    d = await json(post(base, admin, `/api/contracts/${cClose.id}/archive-status`, { expectedVersion: d.version, archiveStatus: 'transferred' }));
    d = await json(post(base, admin, `/api/contracts/${cClose.id}/settlements`, { settlementKind: 'final', settlementDate: '2026-05-01', inContractAmount: '10000.00' }));
    d = await json(post(base, admin, `/api/contracts/${cClose.id}/settlements/${d.settlements[0].id}/decide`, { decision: 'approve', exceptionReason: '测试' }));
    d = await json(post(base, admin, `/api/contracts/${cClose.id}/payments`, { ...PAYMENT_APPROVAL, nodeName: '全款', amount: '10000.00' }));
    d = await json(post(base, admin, `/api/contracts/${cClose.id}/payments/${d.payments[0].id}/decide`, { decision: 'approve', exceptionReason: '测试' }));
    d = await json(post(base, admin, `/api/contracts/${cClose.id}/payments/${d.payments[0].id}/pay`, { paidDate: '2026-05-01', invoiceDocumentId: docInv.id }));
    d = await json(post(base, admin, `/api/contracts/${cClose.id}/advance`, { expectedVersion: d.version, toStage: 'closed' }));
    expect(d.status).toBe('closed');

    const evalRes = await fetchAs(admin, `${base}/api/contracts/${cClose.id}/evaluation`, {
      method: 'PUT', headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ qualityScore: 5, scheduleScore: 4, serviceScore: 5, recommendation: 'preferred', comment: '按期保质交付' }),
    });
    expect(evalRes.status).toBe(200);
    const evalDetail = await json(evalRes);
    expect(evalDetail.evaluation).toMatchObject({ totalScore: 14, recommendation: 'preferred', comment: '按期保质交付' });

    // 小澧助手只读工具（contract_lifecycle_detail & domain_ledger direction/pricingMode 过滤 & 组织隔离）
    const shUser = db.prepare('SELECT id FROM app_user WHERE username = ?').get('t12-viewer') as { id: number };
    const baseShAuth = loadAuthContext(db, shUser.id)!;
    const shAuth = { ...baseShAuth, permissions: new Set([...baseShAuth.permissions, 'assistant:use' as const, 'report:read' as const]) };
    runWithContext({ requestId: 't12-tool', source: 'http', auth: shAuth }, () => {
      const ledger = executeTool(db, 'domain_ledger', { kind: 'contracts', direction: 'income', pricingMode: 'unit_price' }) as { items: { contractNo: string }[] };
      expect(ledger.items.map((x) => x.contractNo)).toContain('INC-SUP-01');
      const lc = executeTool(db, 'contract_lifecycle_detail', { contractId: cClose.id }) as { evaluation: { totalScore: number } };
      expect(lc.evaluation.totalScore).toBe(14);
      const sr = executeTool(db, 'standard_report_read', { reportType: 'contract_monthly_pack', period: '2026-05' }) as { items: unknown[] };
      expect(sr.items.length).toBeGreaterThanOrEqual(1);
      expect(() => executeTool(db, 'contract_lifecycle_detail', { contractId: njRes.id })).toThrow(/不存在或无权/);
    });
  });

  it('V71 迁移、管理会计收入合同指标、工作台临期保函/超10工作日待分发与项目档案闭环计数', async () => {
    // 1) V70 -> V71 迁移保留 ma_metric / ma_metric_snapshot 及外键，且允许收入收款计算器
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'newfc-t12-v71-'));
    const dbMig = openDatabase(path.join(dir, 'v70-to-v71.sqlite'));
    const ts = '2026-11-13T00:00:00.000Z';
    try {
      applyMigrations(dbMig, 70);
      const orgId = Number(dbMig.prepare("INSERT INTO org (code, name, sort_order, created_at, updated_at) VALUES ('1002', '测试单位', 1, ?, ?)").run(ts, ts).lastInsertRowid);
      const mPaid = dbMig.prepare("SELECT id FROM ma_metric WHERE code = 'ALLOCATED_COST'").get() as { id: number };
      const runId = Number(dbMig.prepare("INSERT INTO ma_calc_run (kind, period, created_at) VALUES ('calc', '2026-11', ?)").run(ts).lastInsertRowid);
      dbMig.prepare("INSERT INTO ma_metric_snapshot (run_id, metric_id, org_id, period, status, value_cents, reasons_json, evidence_json, created_at) VALUES (?, ?, ?, '2026-11', 'valid', 100, '[]', '{}', ?)").run(runId, mPaid.id, orgId, ts);
      expect(() => dbMig.prepare("INSERT INTO ma_metric (code, name, unit, calculator, created_at, updated_at) VALUES ('CR', '收入实收', 'money', 'contract_received', ?, ?)").run(ts, ts)).toThrow(/CHECK/);
      expect(applyMigrations(dbMig, 71).map((m) => m.version)).toEqual([71]);
      expect(dbMig.pragma('foreign_key_check')).toEqual([]);
      expect(dbMig.prepare('SELECT metric_id FROM ma_metric_snapshot').get()).toEqual({ metric_id: mPaid.id });
      dbMig.prepare("INSERT INTO ma_metric (code, name, unit, calculator, created_at, updated_at) VALUES ('CR', '收入实收', 'money', 'contract_received', ?, ?)").run(ts, ts);
      dbMig.prepare("INSERT INTO ma_metric (code, name, unit, calculator, created_at, updated_at) VALUES ('CRR', '收入收款率', 'ratio', 'contract_receipt_rate', ?, ?)").run(ts, ts);
    } finally {
      dbMig.close();
      fs.rmSync(dir, { recursive: true, force: true });
    }

    // 2) HTTP 全链路：管理会计 contract_received / contract_receipt_rate、工作台待办过滤、项目 360 档案计数
    const { base, db, admin, fx } = await boot('newfc-t12-cross-');
    seedNetAssets(db);
    const sh = fx.orgIds.shanghai;
    const nj = fx.orgIds.nanjing;
    const pSh = await createProject(base, admin, 'P-CR-01', '跨模块合同项目', sh);
    const sSh = await createSupplier(base, admin, 'S-CR-01', '湘水合作方');
    const today = todayUtcDate();
    const oldSignDate = addCalendarDays(workingDayCutoffBefore(today, 10), -1)!;
    const recentSignDate = today;

    // 收入合同（2026-06 实收 60万 / 总额 100万，签署超 10 工作日待分发，且含 15 天后到期保函 + 1 笔在途变更 + 1 宗未结纠纷）
    const inc = await json(post(base, admin, '/api/contracts', { ...SIGNATORIES,
      contractNo: 'CR-INC-01', name: '跨模块收入合同', contractType: '销售', orgId: sh, projectId: pSh, supplierId: sSh,
      direction: 'income', partyRole: 'seller', originalAmount: '1000000.00', signDate: oldSignDate, isProcurement: false,
    }));
    await uploadDoc(base, admin, inc.id, 'contract_text', undefined, 'inc_txt.pdf');
    await uploadDoc(base, admin, inc.id, 'signed', undefined, 'inc_signed.pdf');
    let dInc = await json(get(base, admin, `/api/contracts/${inc.id}`));
    for (const st of ['procurement', 'drafting', 'approval'] as const) {
      dInc = await json(post(base, admin, `/api/contracts/${inc.id}/advance`, { expectedVersion: dInc.version, toStage: st }));
    }
    dInc = await json(post(base, admin, `/api/contracts/${inc.id}/reviews`, { documentId: dInc.documents.find((x: { docType: string }) => x.docType === 'contract_text').id }));
    await json(post(base, admin, `/api/contracts/${inc.id}/reviews/${dInc.reviews[0].id}/decide`, { decision: 'approve', exceptionReason: '测试' }));
    dInc = await json(get(base, admin, `/api/contracts/${inc.id}`));
    dInc = await json(post(base, admin, `/api/contracts/${inc.id}/advance`, { expectedVersion: dInc.version, toStage: 'performance' }));
    const invInc = await json(uploadDoc(base, admin, inc.id, 'invoice', undefined, 'inc_inv.pdf'));
    dInc = await json(post(base, admin, `/api/contracts/${inc.id}/receipts`, { nodeName: '一期收款', amount: '600000.00', invoiceDocumentId: invInc.id }));
    await json(post(base, admin, `/api/contracts/${inc.id}/receipts/${dInc.receipts[0].id}/decide`, { decision: 'approve', exceptionReason: '测试' }));
    await json(post(base, admin, `/api/contracts/${inc.id}/receipts/${dInc.receipts[0].id}/receive`, { receivedDate: '2026-06-18', voucherNo: '收-0618', invoiceDocumentId: invInc.id }));

    const chgDoc = await json(uploadDoc(base, admin, inc.id, 'change', undefined, 'chg.pdf'));
    await json(post(base, admin, `/api/contracts/${inc.id}/changes`, { ...CHANGE_GOVERNANCE,
      changeKind: 'change', delta: '0.00', changeMatter: '调整账户', reason: '账户更新', evidenceDocumentId: chgDoc.id, supplementNo: 'CR-SUP-01',
    }));
    await json(post(base, admin, `/api/contracts/${inc.id}/guarantees`, {
      guaranteeType: 'performance_guarantee', direction: 'inbound', issuerName: '建行', guaranteeNo: 'BH-CR-01',
      amount: '50000.00', effectiveDate: '2026-06-01', expiryDate: addCalendarDays(today, 15),
    }));
    await json(post(base, admin, `/api/contracts/${inc.id}/disputes`, {
      occurredDate: '2026-06-20', causeOfAction: '款项争议', stage: 'negotiation', disputeAmount: '20000.00',
    }));

    // 近期签署的支出合同（未超 10 工作日，保函到期 > 30 天）：不应出现在 distribution 或 guarantee_warranty 待办中
    const expRecent = await json(post(base, admin, '/api/contracts', { ...SIGNATORIES,
      contractNo: 'CR-EXP-RECENT', name: '近期签署合同', contractType: '服务', orgId: sh, projectId: pSh, supplierId: sSh,
      direction: 'expense', originalAmount: '200000.00', signDate: recentSignDate,
    }));
    await json(post(base, admin, `/api/contracts/${expRecent.id}/guarantees`, {
      guaranteeType: 'performance_guarantee', direction: 'inbound', issuerName: '工行', guaranteeNo: 'BH-FAR-01',
      amount: '10000.00', effectiveDate: '2026-06-01', expiryDate: addCalendarDays(today, 90),
    }));

    // 南京仅有 1 份支出合同（无收入合同），测试管理会计指标组织隔离与缺失原因
    await json(post(base, admin, '/api/contracts', { ...SIGNATORIES,
      contractNo: 'CR-NJ-EXP', name: '南京纯支出合同', contractType: '服务', orgId: nj, supplierId: sSh, direction: 'expense', originalAmount: '100000.00',
    }));

    // 管理会计新建并使用 contract_received / contract_receipt_rate
    const mRec = await json(post(base, admin, '/api/mgmt/metrics', { code: 'CT_REC', name: '合同实收', params: { calculator: 'contract_received' } }));
    const mRecRate = await json(post(base, admin, '/api/mgmt/metrics', { code: 'CT_REC_RATE', name: '合同收款率', params: { calculator: 'contract_receipt_rate' } }));
    const calcRun = await json(post(base, admin, '/api/mgmt/calc-runs', { period: '2026-06', metricIds: [mRec.id, mRecRate.id], orgIds: [sh, nj] }));
    const snap = (mid: number, oid: number) => calcRun.snapshots.find((s: { metricId: number; orgId: number }) => s.metricId === mid && s.orgId === oid);
    expect(snap(mRec.id, sh)).toMatchObject({ status: 'valid', value: '600000.00' });
    expect(snap(mRecRate.id, sh)).toMatchObject({ status: 'valid', value: '0.600000' });
    expect(snap(mRec.id, nj)).toMatchObject({ status: 'unavailable' });
    expect(snap(mRec.id, nj).reasons[0].code).toBe('CONTRACT_MISSING');

    // 工作台待办与合同列表 todo 筛选同口径
    const todos = Object.fromEntries((await json(get(base, admin, '/api/dashboard/todos'))).items.map((i: { key: string; count: number }) => [i.key, i.count]));
    expect(todos.contract_distribution).toBe(1);
    expect(todos.contract_guarantee_warranty).toBe(1);
    const distContracts = await json(get(base, admin, '/api/contracts?todo=distribution'));
    expect(distContracts.map((x: { id: number }) => x.id)).toEqual([inc.id]);
    const gwContracts = await json(get(base, admin, '/api/contracts?todo=guarantee_warranty'));
    expect(gwContracts.map((x: { id: number }) => x.id)).toEqual([inc.id]);

    // 项目 360° 档案包含已结、活跃保函、未闭环变更与未闭环纠纷计数
    const profile = await json(get(base, admin, `/api/master/projects/${pSh}/profile`));
    expect(profile.contracts).toMatchObject({
      count: 2,
      expenseCount: 1,
      incomeCount: 1,
      settledTotal: '0.00',
      incomeSettledTotal: '0.00',
      receivedTotal: '600000.00',
      activeGuaranteeCount: 2,
      openChangeCount: 1,
      openDisputeCount: 1,
    });
  });
});
