import * as XLSX from 'xlsx';
import { describe, expect, it } from 'vitest';
import { DISPUTE_OFFICIAL_17_HEADERS } from '../src/modules/contracts/contract-safeguard.service';
import { SIGNATORIES } from './contract-review-fixtures';
import { boot, get, json, post, upload } from './t3-helpers';
import { fetchAs } from './http-helpers';
import { createSupplier } from './t4-helpers';

describe('T-GAP-19 / AC-T14-08 合同全筛选与 summary 联动、分币种汇总、排序白名单、纠纷 17 列导出及草稿附件撤回', () => {
  it('legalCategory/procurementMethod/signDateFrom..To 组合筛选与 summary 严格同步，排序白名单防注入，按币种独立汇总不跨币种误加', async () => {
    const { base, admin, fx } = await boot('newfc-t14-query-sum-');
    const orgId = fx.orgIds.shanghai;
    const supplierId = await createSupplier(base, admin, 'S-QRY-01', '合成跨境装备供应有限公司');

    await json(
      post(base, admin, '/api/contracts', {
        contractNo: 'GRP-QRY-2026-001',
        name: '电站机组检修技术服务合同A',
        direction: 'expense',
        category: '技术服务',
        legalCategory: 'tech_service',
        orgId,
        supplierId,
        currency: '人民币',
        originalAmount: '800000.00',
        signDate: '2026-07-05',
        isProcurement: true,
        procurementTarget: 'service',
        procurementMethod: 'public_tender',
        ...SIGNATORIES,
      }),
    );
    await json(
      post(base, admin, '/api/contracts', {
        contractNo: 'GRP-QRY-2026-002',
        name: '进口轴承采购外币合同B',
        direction: 'expense',
        category: '物资采购',
        legalCategory: 'goods_procurement',
        orgId,
        supplierId,
        currency: '美元',
        exchangeRate: '7.200000',
        originalAmount: '100000.00',
        signDate: '2026-07-12',
        isProcurement: true,
        procurementTarget: 'goods',
        procurementMethod: 'inquiry',
        ...SIGNATORIES,
      }),
    );
    await json(
      post(base, admin, '/api/contracts', {
        contractNo: 'GRP-QRY-2026-003',
        name: '年末大坝安全监测技术服务合同C',
        direction: 'expense',
        category: '技术服务',
        legalCategory: 'tech_service',
        orgId,
        supplierId,
        currency: '人民币',
        originalAmount: '500000.00',
        signDate: '2026-09-20',
        isProcurement: true,
        procurementTarget: 'service',
        procurementMethod: 'public_tender',
        ...SIGNATORIES,
      }),
    );

    // 1. 组合筛选 legalCategory + procurementMethod + signDateFrom..To：列表与 summary 完全一致（仅命中合同A）
    const filterQs = 'legalCategory=tech_service&procurementMethod=public_tender&signDateFrom=2026-07-01&signDateTo=2026-07-31';
    const pageFiltered = await json(get(base, admin, `/api/contracts/page?${filterQs}`));
    const sumFiltered = await json(get(base, admin, `/api/contracts/summary?${filterQs}`));
    expect(pageFiltered.total).toBe(1);
    expect(pageFiltered.items[0].contractNo).toBe('GRP-QRY-2026-001');
    expect(sumFiltered.count).toBe(1);
    expect(sumFiltered.currentAmount).toBe('800000.00');

    // 2. 全量分页按币种独立汇总（人民币 1,300,000.00 元，美元 100,000.00，绝不直接混加为 1,400,000.00）
    const allPage = await json(get(base, admin, `/api/contracts/page?orgId=${orgId}&sortBy=signDate&sortDir=desc`));
    expect(allPage.items[0].contractNo).toBe('GRP-QRY-2026-003');
    expect(allPage.totals).toHaveLength(2);
    const rmbTotal = allPage.totals.find((t: any) => t.currency === '人民币');
    const usdTotal = allPage.totals.find((t: any) => t.currency === '美元');
    expect(rmbTotal.count).toBe(2);
    expect(rmbTotal.originalTotal).toBe('1300000.00');
    expect(usdTotal.count).toBe(1);
    expect(usdTotal.originalTotal).toBe('100000.00');

    // 3. 排序白名单防 SQL 注入：非法 sortBy 参数直接 400 拒绝
    const sqlInjectRes = await get(base, admin, `/api/contracts/page?sortBy=${encodeURIComponent('id; DROP TABLE ct_contract;--')}`);
    expect(sqlInjectRes.status).toBe(400);
  });

  it('诉讼仲裁 17 列官方台账 Excel 导出表头顺序与内容精确一致，且支持未引用草稿附件受审计撤回与已引用证据不可变保护', async () => {
    const { base, admin, fx } = await boot('newfc-t14-dispute-doc-');
    const orgId = fx.orgIds.shanghai;
    const supplierId = await createSupplier(base, admin, 'S-DSP-01', '合成机电建设承包公司');

    const createRes = await post(base, admin, '/api/contracts', {
      contractNo: 'GRP-DSP-2026-001',
      name: '闸门启闭机零星维保服务合同',
      direction: 'expense',
      contractType: '技术服务',
      category: '技术服务',
      legalCategory: 'other',
      orgId,
      supplierId,
      budgetType: 'lump_sum_pool',
      originalAmount: '480000.00',
      signDate: '2026-07-02',
      termStartDate: '2026-07-02',
      termEndDate: '2026-12-31',
      ...SIGNATORIES,
    });
    expect(createRes.status).toBe(201);
    const c = await json(createRes);

    // 登记完整 17 列纠纷要素
    const dspRes = await post(base, admin, `/api/contracts/${c.id}/disputes`, {
      litigationType: '民事诉讼',
      causeOfAction: '建设工程施工合同纠纷',
      counterpartyAndRole: '合成机电建设承包公司（被告）',
      stage: 'litigation_1st',
      institutionName: '某市中级人民法院',
      caseNo: '（2026）民初1088号',
      involvedOrgName: '上海公司',
      ourLitigationRole: '原告',
      acceptedDate: '2026-08-10',
      occurredDate: '2026-08-08',
      reportedToDeptAt: '2026-08-09',
      caseSummary: '承包方逾期交付启闭机关键部件，我方诉请支付违约金并继续履行合同义务。',
      legalDocForm: '民事判决书',
      closedDate: '2026-10-25',
      disputeAmount: '85000.00',
      judgmentResult: '判令被告支付违约金6.5万元',
      actualSettledAmount: '65000.00',
      lawFirmAndLawyer: '正源律师事务所 王律师',
      filedToMgmtAt: '2026-10-26',
      filedToDisciplineAt: '2026-10-26',
    });
    expect(dspRes.status).toBe(201);

    // 导出 17 列官方台账 .xlsx 并逐列校验表头与首行内容
    const expRes = await fetchAs(admin, `${base}/api/contracts/disputes/export?contractId=${c.id}`);
    expect(expRes.status).toBe(200);
    const wb = XLSX.read(Buffer.from(await expRes.arrayBuffer()), { type: 'buffer' });
    const rows = XLSX.utils.sheet_to_json<string[]>(wb.Sheets[wb.SheetNames[0]], { header: 1 });
    const headerRow = rows.find((r) => r[0] === '序号' && r[1] === '诉讼类型')!;
    expect(headerRow).toEqual([...DISPUTE_OFFICIAL_17_HEADERS]);
    const dataRow = rows[rows.indexOf(headerRow) + 1];
    expect(dataRow[1]).toBe('民事诉讼');
    expect(dataRow[2]).toBe('建设工程施工合同纠纷');
    expect(dataRow[6]).toBe('（2026）民初1088号');
    expect(String(dataRow[13])).toContain('85000');
    expect(String(dataRow[15])).toContain('65000');
    expect(dataRow[16]).toContain('正源律师事务所');

    // 上传两份草稿附件：doc1 未被引用可撤回；doc2 被合同审核引用后禁止撤回
    const doc1 = await json(
      upload(base, admin, `/api/contracts/${c.id}/documents`, Buffer.from('误传草稿附件'), 'draft-wrong.pdf', {
        docType: 'other',
        name: '误传草稿文件',
      }),
    );
    const doc2 = await json(
      upload(base, admin, `/api/contracts/${c.id}/documents`, Buffer.from('正式送审合同正文'), 'review-body.pdf', {
        docType: 'contract_text',
        name: '送审合同正文',
      }),
    );

    const withdrawOk = await post(base, admin, `/api/contracts/${c.id}/documents/${doc1.id}/withdraw`, {
      reason: '上传错版本草稿，予以撤回重传',
    });
    expect(withdrawOk.status).toBe(200);
    const detailAfterWithdraw = await json(get(base, admin, `/api/contracts/${c.id}`));
    expect(detailAfterWithdraw.documents.find((d: any) => d.id === doc1.id)?.withdrawnAt).toBeTruthy();

    // 推进至 approval 并提交审核引用 doc2 -> 再尝试撤回 doc2 必须 409 拒绝
    await upload(base, admin, `/api/contracts/${c.id}/documents`, Buffer.from('比选记录'), 'proc.pdf', {
      docType: 'procurement',
    });
    let dBeforeRev = await json(get(base, admin, `/api/contracts/${c.id}`));
    await json(post(base, admin, `/api/contracts/${c.id}/advance`, { expectedVersion: dBeforeRev.version, toStage: 'procurement' }));
    dBeforeRev = await json(get(base, admin, `/api/contracts/${c.id}`));
    await json(post(base, admin, `/api/contracts/${c.id}/advance`, { expectedVersion: dBeforeRev.version, toStage: 'drafting' }));
    dBeforeRev = await json(get(base, admin, `/api/contracts/${c.id}`));
    await json(post(base, admin, `/api/contracts/${c.id}/advance`, { expectedVersion: dBeforeRev.version, toStage: 'approval' }));
    await json(post(base, admin, `/api/contracts/${c.id}/reviews`, { documentId: doc2.id, note: '送审引用doc2' }));

    const withdrawRefFail = await post(base, admin, `/api/contracts/${c.id}/documents/${doc2.id}/withdraw`, {
      reason: '尝试撤回已被审核引用的正文',
    });
    expect(withdrawRefFail.status).toBe(409);
  });

  it('待我会签·复核（todo=review_or_countersign / countersign）与重号凭证线索（legacyFilter=clue）筛选及汇总待办严格同源', async () => {
    const { base, db, admin, fx } = await boot('newfc-t14-cs-clue-');
    const orgId = fx.orgIds.shanghai;
    const supplierId = await createSupplier(base, admin, 'S-CS-01', '合成自动化系统集成公司');

    const c1 = await json(
      post(base, admin, '/api/contracts', {
        contractNo: 'GRP-SJ-001/2026-0001',
        externalNoExempt: true,
        name: '监控系统升级技术改造合同',
        direction: 'expense',
        contractType: '技术服务',
        legalCategory: 'tech_service',
        orgId,
        supplierId,
        budgetType: 'lump_sum_pool',
        originalAmount: '600000.00',
        isProcurement: true,
        procurementTarget: 'service',
        procurementMethod: 'public_tender',
        ...SIGNATORIES,
      }),
    );
    expect(c1.id).toBeGreaterThan(0);
    // 显式发起多部门会签（此时无 ct_review 提交，但有待会签部门）
    const csRes = await post(base, admin, `/api/contracts/${c1.id}/countersigns`, {});
    expect(csRes.status).toBe(201);
    const csRows = await json(csRes);
    expect(csRows.length).toBeGreaterThan(0);

    const summaryAll = await json(get(base, admin, '/api/contracts/summary'));
    expect(summaryAll.pending.countersigns).toBe(1);
    expect(summaryAll.pending.reviews).toBe(0);

    const pageCsOnly = await json(get(base, admin, '/api/contracts/page?todo=countersign'));
    expect(pageCsOnly.total).toBe(1);
    expect(pageCsOnly.items[0].id).toBe(c1.id);
    expect(pageCsOnly.items[0].pendingCountersigns).toBe(csRows.length);

    const pageMerged = await json(get(base, admin, '/api/contracts/page?todo=review_or_countersign'));
    expect(pageMerged.total).toBe(1);
    expect(pageMerged.items[0].id).toBe(c1.id);

    const todos = (await json(get(base, admin, '/api/dashboard/todos'))).items as { key: string; count: number; path: string }[];
    expect(todos.find((t) => t.key === 'contract_review')).toMatchObject({
      count: 1,
      path: '/contracts?queue=review&todo=review_or_countersign',
    });

    // 构造两条历史容缺合同：一条仅普通容缺，另一条含重号冲突组线索
    const cPlainLegacy = await json(
      post(base, admin, '/api/contracts', {
        contractNo: 'MIG-PLAIN-2024-01',
        externalNoExempt: true,
        name: '历史普通容缺待补盖章件合同',
        direction: 'expense',
        contractType: '服务',
        legalCategory: 'other',
        orgId,
        supplierId,
        budgetType: 'lump_sum_pool',
        originalAmount: '50000.00',
        ...SIGNATORIES,
      }),
    );
    const cClueLegacy = await json(
      post(base, admin, '/api/contracts', {
        contractNo: 'MIG-CLUE-2024-02',
        externalNoExempt: true,
        name: '历史重号与凭证线索待核合同',
        direction: 'expense',
        contractType: '服务',
        legalCategory: 'other',
        orgId,
        supplierId,
        budgetType: 'lump_sum_pool',
        originalAmount: '80000.00',
        ...SIGNATORIES,
      }),
    );
    db.prepare("UPDATE ct_contract SET origin = 'legacy_migration', migration_mode = 'legacy_tolerant' WHERE id IN (?, ?)").run(
      cPlainLegacy.id,
      cClueLegacy.id,
    );
    db.prepare("UPDATE ct_contract SET duplicate_conflict_group = 'DUP-GRP-01', synthetic_no_flag = 1 WHERE id = ?").run(
      cClueLegacy.id,
    );

    const cluePage = await json(get(base, admin, '/api/contracts/page?migrationMode=legacy_tolerant&legacyFilter=clue'));
    const clueSum = await json(get(base, admin, '/api/contracts/summary?migrationMode=legacy_tolerant&legacyFilter=clue'));
    expect(cluePage.total).toBe(1);
    expect(cluePage.items[0].id).toBe(cClueLegacy.id);
    expect(clueSum.count).toBe(1);
  });
});
