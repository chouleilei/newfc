import { createServer, type Server } from 'node:http';
import { afterEach, describe, expect, it } from 'vitest';
import seed from '../../deploy/contract-legal-seed-v1.json';
import type { LegalCategory, TemplateDto } from '../src/contracts/contract-legal-review';
import { importLegalSeed } from '../src/modules/contracts/legal-catalog.service';
import { templateDiff } from '../src/modules/contracts/template-diff';
import { saveBusinessSettings } from '../src/modules/settings/business-settings';
import { SIGNATORIES, seedNetAssets } from './contract-review-fixtures';
import { boot, get, json, post, upload } from './t3-helpers';
import { createProject, createSupplier } from './t4-helpers';
import { docx, parsed } from './t9-legal-fixture';

/**
 * T-15 / GAP-21 / AC-CLR-09（AC-T15-05）：
 * 覆盖 8 大业务合同类别的「缺陷初稿 vs 法审修订合规稿」全链路配对回归，
 * 以及候选范本（candidate -> manual_review）经显式审计转正（promote -> official -> pass）
 * 与行政移交特殊协议三版演进（3/3 -> 0/3 -> 1/3 差异追踪且绝不误判 pass）门禁核验。
 * 所有夹具严格执行零实名、零信用代码、零涉密财务原值脱敏。
 */

const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

interface PairedCase {
  key: string;
  label: string;
  legalCategory: LegalCategory;
  contractNo: string;
  direction: 'expense' | 'income';
  isProcurement: boolean;
  procurementTarget: 'goods' | 'construction' | 'service' | null;
  amount: string;
  upperAmount: string;
  fixedClauseTitle: string;
  fixedClauseText: string;
  defectiveText: string;
  revisedText: string;
  expectedDefectCodes: string[];
}

function buildCompliantText(opts: {
  title: string;
  contractNo: string;
  partyA: string;
  partyB: string;
  scopeLine: string;
  upperAmount: string;
  lowerAmount: string;
  taxRate: string;
  termLine: string;
  fixedClauseText: string;
}): string {
  return [
    opts.title,
    `合同编号：${opts.contractNo}`,
    `甲方：${opts.partyA}`,
    `乙方：${opts.partyB}`,
    '根据《中华人民共和国民法典》及相关法律法规，双方协商一致订立本合同。',
    '第一条 标的与工作范围',
    opts.scopeLine,
    '第二条 合同总价与税票',
    `本合同含税总价为人民币${opts.upperAmount}（¥${opts.lowerAmount}元），增值税税率为${opts.taxRate}，结算时提供合规增值税专用发票。`,
    '第三条 付款安排',
    '首期款：阶段成果或货物验收合格后支付合同总价的95%。',
    '尾款或质保金：质保或考核期满无异议后支付合同总价的5%。',
    '第四条 履行期限与验收标准',
    `${opts.termLine} 按国家标准及合同技术附件组织验收。`,
    '第五条 违约责任与核心约束',
    `任何一方违约应赔偿对方实际损失。${opts.fixedClauseText}`,
    '第六条 争议解决',
    '因本合同引起的争议，协商不成的，依法向甲方所在地有管辖权的人民法院起诉。',
    '第七条 合同解除、善后与生效限制',
    '一方严重违约导致合同目的不能实现时可解除合同，解除后双方应办理结算、资料返还及现场善后清算。',
    '在合同未签署或者未生效之前，任何一方不得实质履行或先行施工供货。',
    '第八条 签署生效',
    '本合同自双方法定代表人或授权代表签字并加盖公章之日起生效。签署日期：2026年11月20日。',
  ].join('\n');
}

describe('AC-CLR-09 八大业务类别合同法审配对回归与范本转正门禁（AC-T15-05）', () => {
  it('验证 8 类脱敏合同「缺陷稿召回 vs 修订稿放行」、candidate 保持 manual_review 及行政移交三版追踪', { timeout: 90_000 }, async () => {
    const t = await boot('newfc-t15-ac-clr09-');
    seedNetAssets(t.db);
    importLegalSeed(t.db, seed);

    // 开启包含 income_sales 与 other 在内的全类别法审以便回归全部 8 类样本
    saveBusinessSettings(t.db, {
      'contract.legal_review_categories':
        'goods_procurement,small_construction,construction,tech_service,general_service,income_sales,important_special,other',
    });

    // 初始种子中的 3 份范本必须保持 candidate（迁移脚本绝不自动转正）
    const initialTpls = (await json(get(t.base, t.admin, '/api/contracts/legal-catalog/templates'))) as TemplateDto[];
    expect(initialTpls.length).toBeGreaterThanOrEqual(3);
    expect(initialTpls.every((tp) => tp.approvalStatus === 'candidate')).toBe(true);

    // 受控本地语义审查通道（返回确定性空模型意见，隔离外部网络）
    const model = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { content: '{"findings":[]}' } }] }));
      });
    }).listen(0);
    servers.push(model);
    const modelUrl = `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`;
    const chRes = await post(t.base, t.admin, '/api/settings/ai-channels', {
      name: 'AC-CLR-09回归模型',
      provider: 'openai',
      baseUrl: modelUrl,
      apiKey: 'clr09-local-key',
      model: 'clr09-verifier',
      isDefault: true,
      enabled: true,
    });
    expect(chRes.status).toBe(201);

    const sh = t.fx.orgIds.shanghai;
    const orgRow = t.db.prepare('SELECT name FROM org WHERE id = ?').get(sh) as { name: string };
    const partyA = orgRow.name;
    const partyB = '合成工程技术服务有限公司';
    const projectId = await createProject(t.base, t.admin, 'PRJ-CLR09', '多类别法审验证项目', sh);
    const supplierId = await createSupplier(t.base, t.admin, 'SUP-CLR09', partyB);

    // 7 类常规业务合同配对真值矩阵 + 第 8 类行政移交重大特殊协议三版演进链
    const pairedCases: PairedCase[] = [
      {
        key: 'cat1_goods',
        label: '货物采购合同',
        legalCategory: 'goods_procurement',
        contractNo: 'LS-SG-001/2026-001',
        direction: 'expense',
        isProcurement: true,
        procurementTarget: 'goods',
        amount: '100000.00',
        upperAmount: '壹拾万元整',
        fixedClauseTitle: '禁止违法转包与知识产权保证',
        fixedClauseText: '乙方不得将供货义务转包，并保证所供设备不侵犯第三方知识产权。',
        defectiveText: [
          '低压配电柜采购合同',
          '合同编号：LS-SG-001/2026-001',
          `甲方：${partyA}`,
          `乙方：${partyB}`,
          '依据《中华人民共和国合同法》订立本合同。',
          '第一条 供货范围：低压配电柜一套，规格【待定】。',
          '第二条 合同总价为人民币壹拾万元整（¥100000.00元）。',
          '第三条 付款安排：到货支付60%，验收合格支付50%。',
          '第四条 交付期限：2026年12月10日前交货并验收。',
          '第五条 争议由甲方所在地人民法院起诉解决。',
          '第六条 合同签署前乙方可先行供货。双方盖章日期：2026年11月20日。',
        ].join('\n'),
        revisedText: '',
        expectedDefectCodes: ['OBSOLETE_LAW_BASIS', 'PLACEHOLDER_UNFILLED', 'PAYMENT_RATIO_SUM_INVALID', 'TAX_INVOICE_UNCLEAR', 'SUBSTANTIVE_PERF_BEFORE_EFFECTIVE'],
      },
      {
        key: 'cat2_construction',
        label: '大中型工程施工合同',
        legalCategory: 'construction',
        contractNo: 'LS-JG-001/2026-002',
        direction: 'expense',
        isProcurement: true,
        procurementTarget: 'construction',
        amount: '200000.00',
        upperAmount: '贰拾万元整',
        fixedClauseTitle: '安全生产与禁止违法分包',
        fixedClauseText: '承包人须严格履行安全生产主体责任，严禁转包及违法分包主体工程。',
        defectiveText: [
          '溢洪道消力池修复施工合同',
          '合同编号：LS-JG-001/2026-002',
          `甲方：${partyA}`,
          `乙方：${partyB}`,
          '第一条 施工内容：消力池混凝土修复工程。',
          '第二条 合同总价为人民币贰拾万元整（¥200000.00元），增值税税率9%，提供增值税专用发票。',
          '第三条 付款：完工验收支付95%，质保满支付5%。',
          '第四条 工期60日历天。在合同签订前乙方应当先行施工进场。',
          '第五条 争议既可向仲裁委员会申请仲裁，也可向人民法院起诉。',
        ].join('\n'),
        revisedText: '',
        expectedDefectCodes: ['SUBSTANTIVE_PERF_BEFORE_EFFECTIVE', 'DISPUTE_DUAL_CONFLICT', 'ESSENTIAL_CLAUSE_MISSING'],
      },
      {
        key: 'cat3_small_const',
        label: '小型基建施工合同',
        legalCategory: 'small_construction',
        contractNo: 'LS-JG-002/2026-003',
        direction: 'expense',
        isProcurement: true,
        procurementTarget: 'construction',
        amount: '150000.00',
        upperAmount: '壹拾伍万元整',
        fixedClauseTitle: '小型工程现场质量保修',
        fixedClauseText: '承包人对零星修缮工程承担不少于一年的质量保修与返修义务。',
        defectiveText: [
          '防汛仓库屋面防水修缮合同',
          '合同编号：LS-JG-002/2026-003',
          `甲方：${partyA}`,
          `乙方：${partyB}`,
          '第一条 工程内容：仓库屋面防水卷材铺设。',
          '第二条 合同总价为人民币贰拾万元整（¥150000.00元），税率9%，开具增值税专用发票。',
          '第三条 付款：验收合格支付95%，质保期满支付5%。',
          '第四条 工期30天，按规范验收。违约按日千分之一计收违约金。',
          '第五条 争议向甲方所在地人民法院起诉。解除后办理结算返还善后。未签署未生效前不得施工。盖章日期：2026年11月20日。',
        ].join('\n'),
        revisedText: '',
        expectedDefectCodes: ['AMOUNT_UPPER_LOWER_MISMATCH', 'TEMPLATE_FIXED_DEVIATION'],
      },
      {
        key: 'cat4_tech_service',
        label: '技术服务合同',
        legalCategory: 'tech_service',
        contractNo: 'LS-SJ-001/2026-004',
        direction: 'expense',
        isProcurement: true,
        procurementTarget: 'service',
        amount: '120000.00',
        upperAmount: '壹拾贰万元整',
        fixedClauseTitle: '技术成果知识产权归属',
        fixedClauseText: '乙方利用甲方委托经费完成的专项检测报告及数据成果知识产权归甲方所有。',
        defectiveText: [
          '水工建筑物安全监测分析技术服务合同',
          '合同编号：LS-SJ-001/2026-004',
          `甲方：${partyA}`,
          `乙方：${partyB}`,
          '第一条 服务内容：年度变形与渗流监测资料整编分析。',
          '第二条 合同总价为人民币壹拾贰万元整（¥120000.00元）。',
          '第三条 付款：提交报告支付100%。服务期限90天。',
          '第四条 违约赔偿损失。争议由某仲裁委员会____裁决。未签署未生效前不得实质履行。盖章日期：2026年11月20日。',
        ].join('\n'),
        revisedText: '',
        expectedDefectCodes: ['PLACEHOLDER_UNFILLED', 'TAX_INVOICE_UNCLEAR', 'ESSENTIAL_CLAUSE_MISSING'],
      },
      {
        key: 'cat5_general_service',
        label: '一般综合服务合同',
        legalCategory: 'general_service',
        contractNo: 'LS-TH-001/2026-005',
        direction: 'expense',
        isProcurement: true,
        procurementTarget: 'service',
        amount: '80000.00',
        upperAmount: '捌万元整',
        fixedClauseTitle: '服务人员安全与保密义务',
        fixedClauseText: '乙方派驻人员须遵守营区安全管理规定并对业务资料承担保密义务。',
        defectiveText: [
          '营区物业保洁综合服务合同',
          '合同编号：LS-TH-001/2026-005',
          `甲方：${partyA}`,
          `乙方：${partyB}`,
          '第一条 服务内容：办公营区日常保洁服务，服务期限一年。',
          '第二条 合同总价为人民币捌万元整（¥80000.00元），税率6%增值税专用发票。',
          '第三条 按季支付25%×4=100%，按月考核验收。',
          '第四条 盖章日期：2026年11月20日。',
        ].join('\n'),
        revisedText: '',
        expectedDefectCodes: ['ESSENTIAL_CLAUSE_MISSING', 'SUBSTANTIVE_PERF_BEFORE_EFFECTIVE'],
      },
      {
        key: 'cat6_om_service',
        label: '运行维护服务合同（原版 vs 内部法审修改版）',
        legalCategory: 'general_service',
        contractNo: 'LS-TH-002/2026-006',
        direction: 'expense',
        isProcurement: true,
        procurementTarget: 'service',
        amount: '160000.00',
        upperAmount: '壹拾陆万元整',
        fixedClauseTitle: '服务人员安全与保密义务',
        fixedClauseText: '乙方派驻人员须遵守营区安全管理规定并对业务资料承担保密义务。',
        defectiveText: [
          '水情自动测报系统运行维护合同',
          '合同编号：LS-TH-002/2026-006',
          `甲方：${partyA}`,
          `乙方：${partyB}`,
          '第一条 服务内容：遥测站巡检与通信保障，服务期限一年，按巡检记录验收。',
          '第二条 合同总价为人民币壹拾陆万元整（¥160000.00元），增值税税率6%，提供专用发票。',
          '第三条 首期支付50%，中期支付40%，期末支付20%。',
          '第四条 违约承担赔偿责任；争议向甲方所在地法院起诉；解除后结算返还善后；合同签署前可先行履行巡检。盖章日期：2026年11月20日。',
        ].join('\n'),
        revisedText: '',
        expectedDefectCodes: ['PAYMENT_RATIO_SUM_INVALID', 'SUBSTANTIVE_PERF_BEFORE_EFFECTIVE'],
      },
      {
        key: 'cat7_income_sales',
        label: '收入销售合同',
        legalCategory: 'income_sales',
        contractNo: 'LS-XF-001/2026-007',
        direction: 'income',
        isProcurement: false,
        procurementTarget: null,
        amount: '300000.00',
        upperAmount: '叁拾万元整',
        fixedClauseTitle: '收款结算保障与逾期违约',
        fixedClauseText: '买受人逾期支付结算款项的，每逾期一日按未付金额万分之五支付违约金。',
        defectiveText: [
          '报废金属结构处置销售合同',
          '合同编号：LS-XF-001/2026-007',
          `甲方：${partyA}`,
          `乙方：${partyB}`,
          '第一条 标的：报废闸门钢结构一批，交付期限15日，现场过磅验收。',
          '第二条 合同总价为人民币叁拾万元整（¥300000.00元）。',
          '第三条 付款安排：提货前支付【比例】货款。',
          '第四条 争议向甲方所在地法院起诉。盖章日期：2026年11月20日。',
        ].join('\n'),
        revisedText: '',
        expectedDefectCodes: ['PLACEHOLDER_UNFILLED', 'TAX_INVOICE_UNCLEAR', 'ESSENTIAL_CLAUSE_MISSING'],
      },
    ];

    for (const item of pairedCases) {
      const sellerIsUs = item.direction === 'income';
      item.revisedText = buildCompliantText({
        title: item.label,
        contractNo: item.contractNo,
        partyA: sellerIsUs ? partyB : partyA,
        partyB: sellerIsUs ? partyA : partyB,
        scopeLine: `乙方按技术规范完成${item.label}约定的全部标的工作内容。`,
        upperAmount: item.upperAmount,
        lowerAmount: item.amount,
        taxRate: item.legalCategory === 'goods_procurement' || item.legalCategory === 'income_sales' ? '13%' : item.legalCategory.includes('construction') ? '9%' : '6%',
        termLine: '履行期限自2026年12月01日至2026年12月31日。',
        fixedClauseText: item.fixedClauseText,
      });
    }

    // 为覆盖的业务类别发布受控 candidate 范本，验证 candidate 门禁 -> 显式 promote -> official 放行
    const existingByCat = new Map(initialTpls.map((tp) => [tp.legalCategory, tp.code]));
    const tplIdByCat = new Map<LegalCategory, number>();
    const uniqueCats: { cat: LegalCategory; title: string; text: string }[] = [
      { cat: 'goods_procurement', title: pairedCases[0].fixedClauseTitle, text: pairedCases[0].fixedClauseText },
      { cat: 'construction', title: pairedCases[1].fixedClauseTitle, text: pairedCases[1].fixedClauseText },
      { cat: 'small_construction', title: pairedCases[2].fixedClauseTitle, text: pairedCases[2].fixedClauseText },
      { cat: 'tech_service', title: pairedCases[3].fixedClauseTitle, text: pairedCases[3].fixedClauseText },
      { cat: 'general_service', title: pairedCases[4].fixedClauseTitle, text: pairedCases[4].fixedClauseText },
      { cat: 'income_sales', title: pairedCases[6].fixedClauseTitle, text: pairedCases[6].fixedClauseText },
    ];
    for (const [idx, u] of uniqueCats.entries()) {
      const createdTpl = await json(post(t.base, t.admin, '/api/contracts/legal-catalog/templates', {
        code: existingByCat.get(u.cat) ?? `TPL-CLR09-${idx + 1}`,
        version: 2,
        name: `${u.cat} 回归核定范本`,
        legalCategory: u.cat,
        notes: '初始候选状态，待人工核定转正',
        approvalStatus: 'candidate',
        clauses: [
          {
            clauseKey: `fixed_${u.cat}`,
            clauseNo: '第五条',
            title: u.title,
            tier: 'fixed',
            standardText: u.text,
          },
        ],
      }));
      tplIdByCat.set(u.cat, createdTpl.id);
    }

    const runReviewForDoc = async (contractId: number) => {
      const r = await post(t.base, t.admin, `/api/contracts/${contractId}/legal-reviews/run`);
      expect(r.status).toBe(202);
      for (let i = 0; i < 150; i += 1) {
        const list = await json(get(t.base, t.admin, `/api/contracts/${contractId}/legal-reviews`));
        if (!list.activeJob && list.runs.length > 0) return list.runs[0];
        await new Promise((res) => setTimeout(res, 40));
      }
      throw new Error(`法审任务超时: contract #${contractId}`);
    };

    // 先验证 candidate 范本门禁：即使上传完全合规的修订稿，范本未 promote 前一律输出 manual_review（含 TEMPLATE_CANDIDATE_UNCONFIRMED）
    const gateCase = pairedCases[0];
    let gateCt = await json(post(t.base, t.admin, '/api/contracts', {
      ...SIGNATORIES,
      contractNo: 'LS-SG-001/2026-099',
      name: '候选范本门禁验证合同',
      contractType: gateCase.label,
      orgId: sh,
      projectId,
      supplierId,
      direction: gateCase.direction,
      originalAmount: gateCase.amount,
      legalCategory: gateCase.legalCategory,
      partyRole: 'buyer',
      isProcurement: true,
      procurementTarget: 'goods',
      procurementMethod: 'inquiry',
    }));
    await upload(t.base, t.admin, `/api/contracts/${gateCt.id}/documents`, Buffer.from('award'), 'award.pdf', { docType: 'procurement', evidenceKind: 'bid_award_approval' });
    await upload(t.base, t.admin, `/api/contracts/${gateCt.id}/documents`, Buffer.from('spec'), 'spec.pdf', { docType: 'procurement', evidenceKind: 'tech_spec' });
    for (const st of ['procurement', 'drafting'] as const) {
      gateCt = await json(get(t.base, t.admin, `/api/contracts/${gateCt.id}`));
      gateCt = await json(post(t.base, t.admin, `/api/contracts/${gateCt.id}/advance`, { expectedVersion: gateCt.version, toStage: st }));
    }
    await upload(t.base, t.admin, `/api/contracts/${gateCt.id}/documents`, await docx(gateCase.revisedText.replace(gateCase.contractNo, 'LS-SG-001/2026-099')), 'candidate-check.docx', { docType: 'contract_text' });
    const candRun = await runReviewForDoc(gateCt.id);
    expect(candRun.verdict, JSON.stringify(candRun.findings)).toBe('manual_review');
    expect(candRun.templateApprovalStatus).toBe('candidate');
    expect(candRun.findings.map((f: any) => f.code)).toContain('TEMPLATE_CANDIDATE_UNCONFIRMED');

    // 显式审计转正 6 份业务范本为 official
    for (const [cat, tplId] of tplIdByCat.entries()) {
      const prom = await post(t.base, t.admin, `/api/contracts/legal-catalog/templates/${tplId}/promote`, {
        reason: `AC-CLR-09 法务与归口部门核定 ${cat} 范本转正`,
      });
      expect(prom.status).toBe(200);
    }

    // 逐类执行「缺陷初稿 -> fail/拦截」与「法审修订稿 -> pass」配对验证
    for (const c of pairedCases) {
      let ct = await json(post(t.base, t.admin, '/api/contracts', {
        ...SIGNATORIES,
        contractNo: c.contractNo,
        name: c.label,
        contractType: c.label,
        orgId: sh,
        projectId,
        supplierId,
        direction: c.direction,
        originalAmount: c.amount,
        legalCategory: c.legalCategory,
        partyRole: c.direction === 'income' ? 'seller' : 'buyer',
        isProcurement: c.isProcurement,
        procurementTarget: c.procurementTarget,
        procurementMethod: c.isProcurement ? 'inquiry' : null,
      }));
      if (c.isProcurement) {
        await upload(t.base, t.admin, `/api/contracts/${ct.id}/documents`, Buffer.from('award'), 'award.pdf', { docType: 'procurement', evidenceKind: 'bid_award_approval' });
        await upload(t.base, t.admin, `/api/contracts/${ct.id}/documents`, Buffer.from('spec'), 'spec.pdf', { docType: 'procurement', evidenceKind: 'tech_spec' });
      } else if (c.direction === 'income') {
        await upload(t.base, t.admin, `/api/contracts/${ct.id}/documents`, Buffer.from('offer'), 'client-offer.pdf', { docType: 'other', evidenceKind: 'client_written_offer' });
      }
      for (const st of ['procurement', 'drafting'] as const) {
        ct = await json(get(t.base, t.admin, `/api/contracts/${ct.id}`));
        const advRes = await post(t.base, t.admin, `/api/contracts/${ct.id}/advance`, { expectedVersion: ct.version, toStage: st });
        const advBody = await json(advRes);
        expect(advRes.status, JSON.stringify(advBody)).toBe(200);
        ct = advBody;
      }

      // 1) 上传缺陷初稿：100% 召回预设红线缺陷且绝不能 pass
      await upload(t.base, t.admin, `/api/contracts/${ct.id}/documents`, await docx(c.defectiveText), `${c.key}-defective.docx`, { docType: 'contract_text' });
      const badRun = await runReviewForDoc(ct.id);
      const badCodes = badRun.findings.map((f: any) => f.code);
      expect(badRun.verdict, `${c.key} defective verdict`).not.toBe('pass');
      for (const expectedCode of c.expectedDefectCodes) {
        expect(badCodes, `${c.key} missing ${expectedCode}`).toContain(expectedCode);
      }

      // 2) 上传法审修订合规稿：全部红线消解且在 official 范本下输出 pass
      await upload(t.base, t.admin, `/api/contracts/${ct.id}/documents`, await docx(c.revisedText), `${c.key}-revised.docx`, { docType: 'contract_text' });
      const goodRun = await runReviewForDoc(ct.id);
      expect(goodRun.templateApprovalStatus, `${c.key} official status`).toBe('official');
      expect(goodRun.verdict, `${c.key} revised verdict: ${JSON.stringify(goodRun.findings)}`).toBe('pass');
    }

    // 第 8 类：行政移交/重大特殊协议（原始版 3/3 -> 律师修改版 0/3 -> 终版 1/3 差异追踪，且无正式范本时始终保持 manual_review/fail 绝不误放 pass）
    const lawyerClauses = [
      '因移交路段养护、管理工作不到位，给移交方造成损失的，移交方有权要求接管单位进行赔偿。',
      '后续移交路段的养护管理工作及修缮费用均由接管单位承担，与移交方无关。',
      '各份正本均具有同等法律效力。',
    ];
    const offlineRefTpl: TemplateDto = {
      id: 9001,
      code: 'OFFLINE-TRANSFER-REF',
      version: 1,
      name: '行政移交协议律师意见离线对照',
      legalCategory: 'important_special',
      approvalStatus: 'candidate',
      notes: '仅用于离线条款变化追踪',
      sourceFileObjectId: null,
      clauses: lawyerClauses.map((txt, idx) => ({
        id: 9100 + idx,
        clauseKey: `transfer_pt_${idx + 1}`,
        clauseNo: `第六条`,
        title: `律师增补点${idx + 1}`,
        tier: 'fixed',
        standardText: txt,
        defaultValueNote: '',
        placeholderKeys: [],
      })),
    };
    const baseTransferLines = [
      '配套道路资产行政移交管理协议',
      '合同编号：LS-QT-001/2026-008',
      `甲方：${partyA}`,
      `乙方：${partyB}`,
      '根据《中华人民共和国民法典》及相关规定订立本协议。',
      '第一条 工作范围：库区连接线道路及附属排水设施移交接管，履行期限30日内完成现场交接验收。',
      '第二条 含税补偿总价为人民币伍拾万元整（¥500000.00元），增值税税率0%，开具增值税普通发票，验收后一次性支付100%。',
      '第五条 违约责任：任何一方违约承担相应责任。争议向甲方所在地人民法院起诉。解除后办理资料返还与结算善后。未签署未生效前不得实质履行。',
    ];
    const v06Raw = [...baseTransferLines, '第六条 本协议一式陆份，双方盖章签字生效，签署日期：2026年11月20日。'].join('\n');
    const v07Lawyer = [...baseTransferLines, `第六条 ${lawyerClauses.join('')}`, '第七条 双方盖章签字生效，签署日期：2026年11月20日。'].join('\n');
    const v08Final = [...baseTransferLines, `第六条 ${lawyerClauses[1]}${lawyerClauses[2]}`, '第七条 双方盖章签字生效，签署日期：2026年11月20日。'].join('\n');

    const diffCounts = [v06Raw, v07Lawyer, v08Final].map((txt) =>
      templateDiff(parsed(txt), offlineRefTpl).filter((f) => f.code === 'TEMPLATE_FIXED_DEVIATION').length
    );
    expect(diffCounts).toEqual([3, 0, 1]);

    let specialCt = await json(post(t.base, t.admin, '/api/contracts', {
      ...SIGNATORIES,
      contractNo: 'LS-QT-001/2026-008',
      name: '配套道路资产行政移交管理协议',
      contractType: '行政移交协议',
      orgId: sh,
      projectId,
      supplierId,
      originalAmount: '500000.00',
      legalCategory: 'important_special',
      isProcurement: false,
      isImportant: true,
    }));
    for (const st of ['procurement', 'drafting'] as const) {
      specialCt = await json(get(t.base, t.admin, `/api/contracts/${specialCt.id}`));
      const advRes = await post(t.base, t.admin, `/api/contracts/${specialCt.id}/advance`, { expectedVersion: specialCt.version, toStage: st });
      specialCt = await json(advRes);
      expect(advRes.status, JSON.stringify(specialCt)).toBe(200);
    }
    await upload(t.base, t.admin, `/api/contracts/${specialCt.id}/documents`, await docx(v08Final), 'transfer-final.docx', { docType: 'contract_text' });

    // 未上传法律意见书与集体决策纪要前触发 IMPORTANT_CONTRACT_GATE -> revise
    const specialMissingGate = await runReviewForDoc(specialCt.id);
    expect(specialMissingGate.verdict).toBe('revise');
    expect(specialMissingGate.findings.map((f: any) => f.code)).toContain('IMPORTANT_CONTRACT_GATE');

    // 补齐重大合同前置依据后，因无正式范本且属重大特殊合同，输出 manual_review（含 IMPORTANT_CONTRACT_MANUAL），绝不误放 pass！
    await upload(t.base, t.admin, `/api/contracts/${specialCt.id}/documents`, Buffer.from('legal-opinion'), '法律顾问意见书.pdf', { docType: 'other', evidenceKind: 'legal_opinion' });
    await upload(t.base, t.admin, `/api/contracts/${specialCt.id}/documents`, Buffer.from('triple-major'), '党委会三重一大纪要.pdf', { docType: 'other', evidenceKind: 'triple_major_decision' });
    await upload(t.base, t.admin, `/api/contracts/${specialCt.id}/documents`, Buffer.from('company-approval'), '上级批复文件.pdf', { docType: 'other', evidenceKind: 'company_approval' });
    const specialWithGate = await runReviewForDoc(specialCt.id);
    expect(specialWithGate.verdict, JSON.stringify(specialWithGate.findings)).toBe('manual_review');
    expect(specialWithGate.findings.map((f: any) => f.code)).toContain('IMPORTANT_CONTRACT_MANUAL');
    expect(specialWithGate.findings.map((f: any) => f.code)).toContain('TEMPLATE_CANDIDATE_UNCONFIRMED');
  });
});
