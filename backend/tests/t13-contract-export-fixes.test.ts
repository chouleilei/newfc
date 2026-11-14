import ExcelJS from 'exceljs';
import JSZip from 'jszip';
import { describe, expect, it } from 'vitest';
import { SIGNATORIES, seedNetAssets } from './contract-review-fixtures';
import { fetchAs } from './http-helpers';
import { boot, get, json, post, upload } from './t3-helpers';
import { createProject, createSupplier } from './t4-helpers';

describe('T-13 GAP-17 监督导出 ZIP 正文防丢、目录转义/碰撞检测、零合并单元格与月报 5 表逐格修复', () => {
  it('完整验证：contract_text 归档防丢、/\\| 目录转义与碰撞检测、01表A1:R1与分币种小计、02表plan_item名称、04表6次变更动态扩列、05表招采关联与质疑/待补录', async () => {
    const { base, db, admin, fx } = await boot('newfc-t13-exp-fix-');
    seedNetAssets(db);
    const now = '2026-05-20T08:00:00.000Z';
    const sh = fx.orgIds.shanghai;
    db.prepare("UPDATE org SET report_full_name = '集团母公司/上海子公司' WHERE id = ?").run(sh);

    const projId = await createProject(base, admin, 'P-G17', '工程主数据项目名', sh);
    const supId = await createSupplier(base, admin, 'S-G17', '测试建设供应商甲');

    // 1) 插入综合计划明细 plan_item，验证 02_合同台账总表 优先输出 plan_item.item_name
    const fileId = Number(
      db.prepare("INSERT INTO file_object (sha256, size_bytes, content_type, original_name, created_at) VALUES (?, 32, 'application/octet-stream', 'plan.xlsx', ?)")
        .run('b'.repeat(64), now).lastInsertRowid,
    );
    const batchId = Number(
      db.prepare("INSERT INTO plan_batch (year, actual_period, file_object_id, file_sha256, file_name, amount_unit, status, is_current, item_count, fact_count, created_at) VALUES (2026, '2026-05', ?, ?, 'plan.xlsx', 'yuan', 'imported', 1, 1, 0, ?)")
        .run(fileId, 'b'.repeat(64), now).lastInsertRowid,
    );
    const planItemId = Number(
      db.prepare(`INSERT INTO plan_item (
        batch_id, sheet_code, row_no, item_type, item_key, item_name, org_id, project_id, approved_cents
      ) VALUES (?, 'investment', 2, 'leaf', 'PI-G17-01', '2026年度重点除险加固计划项', ?, ?, 500000000)`)
        .run(batchId, sh, projId).lastInsertRowid,
    );

    // 2) 插入 V73 ct_procurement_record（含代理机构、候选人排名、10节点日期及 protest_flag=1 质疑详情）
    const procId = Number(
      db.prepare(`INSERT INTO ct_procurement_record (
        procurement_code, procurement_title, project_id, org_id, procurement_target, procurement_method, procurement_tier,
        estimated_cents, is_tender, tender_agency, announcement_date, prequal_sale_start, prequal_sale_end,
        doc_sale_start_date, clarification_site_date, bid_open_date, eval_report_submit_date, eval_report_receive_date,
        candidate_publicity_start, candidate_publicity_end, award_notice_date, candidate_ranking_json,
        protest_flag, protest_detail, created_at, updated_at
      ) VALUES (
        'PROC-2026-001', '护坡工程公开招标', ?, ?, 'construction', 'public_tender', 'tier_1',
        400000000, 1, '中水招标代理有限责任公司', '2026-04-01', '2026-04-02', '2026-04-07',
        '2026-04-08', '2026-04-12', '2026-04-28', '2026-04-29', '2026-04-30',
        '2026-05-01', '2026-05-04', '2026-05-06', ?,
        1, '第二候选人就业绩评分提出书面异议，已核查答复', ?, ?
      )`)
        .run(
          projId,
          sh,
          JSON.stringify([
            { rank: 1, name: '测试建设供应商甲' },
            { rank: 2, name: '备选工程公司乙' },
          ]),
          now,
          now,
        ).lastInsertRowid,
    );

    // 3) 创建主测公开招标合同（编号含 / \ | 特殊字符：SH-SG\01|A/2026-01），仅传 contract_text，挂接 planItemId + procurement_record_id + 6 次已批准变更
    const c1 = await json(
      post(base, admin, '/api/contracts', {
        ...SIGNATORIES,
        contractNo: 'SH-SG\\01|A/2026-01',
        name: '重点除险加固施工合同',
        contractType: '工程施工',
        reportCategory: 'engineering',
        orgId: sh,
        projectId: projId,
        supplierId: supId,
        planItemId,
        originalAmount: '3000000.00',
        direction: 'expense',
        procurementTarget: 'construction',
        procurementMethod: 'public_tender',
        procurementStartDate: '2026-04-01',
        supplierConfirmDate: '2026-05-06',
        signDate: '2026-05-10',
        termType: 'fixed',
        termStartDate: '2026-05-15',
        termEndDate: '2026-12-31',
        undertakerName: '赵工',
      }),
    );
    db.prepare("UPDATE ct_contract SET stage = 'performance', procurement_record_id = ? WHERE id = ?").run(procId, c1.id);

    const txtUpload = await json(
      upload(base, admin, `/api/contracts/${c1.id}/documents`, Buffer.from('contract draft text content'), '施工合同正文.docx', {
        docType: 'contract_text',
      }),
    );
    expect(txtUpload.id).toBeGreaterThan(0);

    // 插入 6 次已批准变更（验证 04_变更动态分表 全部 6 次动态扩列零截断，且第 1 次含补充协议特殊字符目录转义）
    let firstChangeId = 0;
    for (let i = 1; i <= 6; i++) {
      const chgDoc = await json(
        upload(base, admin, `/api/contracts/${c1.id}/documents`, Buffer.from(`chg-${i}`), `补协${i}.pdf`, {
          docType: 'change',
          evidenceKind: 'change_agreement',
        }),
      );
      const deltaCents = BigInt(i * 1_000_000); // 1万, 2万, ..., 6万 = 合计 21万元
      const cid = Number(
        db.prepare(`INSERT INTO ct_change (
          contract_id, org_root_id, change_kind, delta_cents, change_matter, reason, evidence_document_id,
          supplement_no, required_approval_tier, actual_approval_tier, status, submitted_at, reviewed_at
        ) VALUES (?, ?, 'change', ?, ?, ?, ?, ?, 'undertaker_unit', 'undertaker_unit', 'approved', '2026-05-18T10:00:00Z', '2026-05-18T12:00:00Z')`)
          .run(c1.id, sh, deltaCents, `第${i}次设计变更事项`, `第${i}次变更原因`, chgDoc.id, `补\\协议|0${i}/2026`).lastInsertRowid,
      );
      if (i === 1) {
        firstChangeId = cid;
        await upload(base, admin, `/api/contracts/${c1.id}/documents`, Buffer.from('supp-1-body'), '补充协议1签署件.pdf', {
          docType: 'change',
          evidenceKind: 'change_agreement',
          changeId: String(firstChangeId),
        });
      }
    }
    db.prepare('UPDATE ct_contract SET approved_change_cents = 21000000 WHERE id = ?').run(c1.id);

    // 另建一份未关联招采记录的邀请招标美元合同，验证 05表“待补录”与 01表分币种小计
    const c2 = await json(
      post(base, admin, '/api/contracts', {
        ...SIGNATORIES,
        contractNo: 'SH-USD-2026-02',
        name: '进口监测终端采购合同',
        contractType: '货物',
        reportCategory: 'goods',
        orgId: sh,
        projectId: projId,
        supplierId: supId,
        currency: '美元',
        exchangeRate: '7.100000',
        originalAmount: '20000.00',
        direction: 'expense',
        procurementTarget: 'goods',
        procurementMethod: 'invited_tender',
        procurementStartDate: '2026-04-10',
        supplierConfirmDate: '2026-05-02',
        signDate: '2026-05-12',
      }),
    );
    expect(c2.id).toBeGreaterThan(0);

    // 4) 验证月报 5 表导出 (.xlsx) 与 contract_monthly_pack 标准报表
    const monthlyRes = await fetchAs(admin, `${base}/api/contracts/exports/monthly-ledger?period=2026-05&orgId=${sh}`);
    expect(monthlyRes.status).toBe(200);
    const wb = new ExcelJS.Workbook();
    await wb.xlsx.load(Buffer.from(await monthlyRes.arrayBuffer()) as unknown as ExcelJS.Buffer);

    // 01_月度统计表: A1:R1 与 O2:R2 合并，且包含 小计(人民币) 与 小计(美元)
    const s1 = wb.getWorksheet('01_月度统计表')!;
    expect(s1.model.merges).toContain('A1:R1');
    expect(s1.model.merges).toContain('O2:R2');
    const s1Blob = JSON.stringify(s1.getSheetValues());
    expect(s1Blob).toContain('小计(人民币)');
    expect(s1Blob).toContain('小计(美元)');

    // 02_合同台账总表: 第 5 列输出 plan_item.item_name 而非仅 md_project.name
    const s2 = wb.getWorksheet('02_合同台账总表')!;
    const s2Rows = s2.getSheetValues().slice(4) as unknown[][];
    const c1RowS2 = s2Rows.find((r) => Array.isArray(r) && r[3] === 'SH-SG\\01|A/2026-01')!;
    expect(c1RowS2[5]).toBe('2026年度重点除险加固计划项');

    // 04_变更动态分表: 完整输出 第1次..第6次，绝不截断第 4、5 次
    const s4 = wb.getWorksheet('04_变更动态分表')!;
    const s4Header2 = JSON.stringify(s4.getRow(2).values);
    for (let i = 1; i <= 6; i++) expect(s4Header2).toContain(`第${i}次`);
    const s4DataBlob = JSON.stringify(s4.getRow(4).values);
    for (let i = 1; i <= 6; i++) expect(s4DataBlob).toContain(`第${i}次设计变更事项`);

    // 05_招标项目清查表: c1 输出真实代理机构、候选人排名及“有：第二候选人...”，c2 未关联招采记录输出“待补录”而非硬编码“无”
    const s5 = wb.getWorksheet('05_招标项目清查表')!;
    const s5Rows = s5.getSheetValues().slice(3) as unknown[][];
    const c1RowS5 = s5Rows.find((r) => Array.isArray(r) && r[3] === 'SH-SG\\01|A/2026-01')!;
    expect(c1RowS5[5]).toContain('第1名:测试建设供应商甲');
    expect(c1RowS5[6]).toBe('中水招标代理有限责任公司');
    expect(c1RowS5[11]).toBe('2026-04-28');
    expect(c1RowS5[17]).toBe('有：第二候选人就业绩评分提出书面异议，已核查答复');
    const c2RowS5 = s5Rows.find((r) => Array.isArray(r) && r[3] === 'SH-USD-2026-02')!;
    expect(c2RowS5[17]).toBe('待补录');

    // 标准报表 contract_monthly_pack 暴露 sources.monthlyStats 统计矩阵与多币种汇总
    const stdMonthly = await json(post(base, admin, '/api/standard-reports', { reportType: 'contract_monthly_pack', period: '2026-05', orgId: sh }));
    expect(Array.isArray(stdMonthly.sources.monthlyStats)).toBe(true);
    expect(stdMonthly.sources.monthlyStats.some((x: { currency: string }) => x.currency === '美元')).toBe(true);

    // 5) 监督 ZIP 导出：internal_archive 保留仅有 contract_text 的正文，且一级目录与补协目录均按 /->% \->@ |->$ 转义！
    const pkgRes = await post(base, admin, '/api/contracts/exports/supervision/package', {
      orgId: sh,
      scopeMode: 'all_active',
      exportPurpose: 'internal_archive',
    });
    expect(pkgRes.status).toBe(200);
    const zip = await JSZip.loadAsync(Buffer.from(await pkgRes.arrayBuffer()));
    const zipPaths = Object.keys(zip.files);
    expect(zipPaths.some((p) => p.startsWith('支出合同附件/SH-SG@01$A%2026-01/03合同文本/') && p.endsWith('施工合同正文.docx'))).toBe(true);
    expect(zipPaths.some((p) => p.startsWith('支出合同变更与纠纷附件/补@协议$01%2026/02变更协议文本/') && p.endsWith('补充协议1签署件.pdf'))).toBe(true);

    // 6) 同批次转义后目录碰撞检测：新建合同 SH-SG@01$A%2026-01 与 SH-SG\01|A/2026-01 转义后同名，supervision_submit 预检明确标出碰撞阻断，internal_archive 自动加 __ID 消歧不覆写
    const collide = await json(
      post(base, admin, '/api/contracts', {
        ...SIGNATORIES,
        contractNo: 'SH-SG@01$A%2026-01',
        name: '目录碰撞测试合同',
        contractType: '其他',
        orgId: sh,
        projectId: projId,
        supplierId: supId,
        originalAmount: '10000.00',
        direction: 'expense',
        signDate: '2026-05-15',
      }),
    );
    db.prepare("UPDATE ct_contract SET stage = 'performance' WHERE id = ?").run(collide.id);
    await upload(base, admin, `/api/contracts/${collide.id}/documents`, Buffer.from('collide-body'), '碰撞正文.pdf', { docType: 'signed' });

    const pfCollide = await json(
      get(base, admin, `/api/contracts/exports/supervision/preflight?orgId=${sh}&scopeMode=all_active&exportPurpose=supervision_submit`),
    );
    const colItem = pfCollide.items.find((i: { contractId: number }) => i.contractId === collide.id);
    expect(colItem.ready).toBe(false);
    expect(JSON.stringify(colItem)).toContain('碰撞');

    const archiveCollideRes = await post(base, admin, '/api/contracts/exports/supervision/package', {
      orgId: sh,
      scopeMode: 'all_active',
      exportPurpose: 'internal_archive',
    });
    expect(archiveCollideRes.status).toBe(200);
    const zip2 = await JSZip.loadAsync(Buffer.from(await archiveCollideRes.arrayBuffer()));
    const zipPaths2 = Object.keys(zip2.files);
    expect(zipPaths2.some((p) => p.includes(`SH-SG@01$A%2026-01__ID${c1.id}/`))).toBe(true);
    expect(zipPaths2.some((p) => p.includes(`SH-SG@01$A%2026-01__ID${collide.id}/`))).toBe(true);
  });
});
