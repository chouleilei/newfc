import crypto from 'node:crypto';
import JSZip from 'jszip';
import * as XLSX from 'xlsx';
import { describe, expect, it } from 'vitest';
import { docxParagraphs, renderDocx } from '../src/modules/analysis-reports/render';
import { parseDocx } from '../src/modules/contracts/document-parser';
import { seedOrgsFromCsv } from '../src/modules/org/seed-org-cli';
import { boot, get, json, post, upload } from './t3-helpers';
import { createScopedUser, fetchAs } from './http-helpers';

describe('T-GAP-10 / AC-T14-05 公文 <w:tbl> .docx/.zip 确定性导出、plan_issuance_summary 冻结报表及检索/待办裁剪', () => {
  it('renderDocx 输出合法 <w:tbl> + <w:tblHeader/> 公文表格、同入参 SHA-256 完全一致，且兼容 docxParagraphs 与接收端 parseDocx', async () => {
    const docModel = {
      title: '关于下达2026年度综合计划与经营预算的通知',
      meta: ['主送：甲级直属水电枢纽'],
      redHead: {
        issuer: '流域水电集团有限责任公司文件',
        docNo: '综计发〔2026〕1号',
        signOff: '流域水电集团有限责任公司',
        issueDate: '2026年3月15日',
      },
      sections: [
        {
          title: '一、年度主要经营与投资指标',
          body: '经集团公司研究决定，现将你单位 2026 年度综合计划与经营预算正式合一下达，请严格组织实施。',
          table: {
            headers: ['序号', '指标名称', '计量单位', '下达目标值', '备注'],
            rows: [
              ['1', '营业总收入', '万元', '31,025.04', '不含税口径'],
              ['2', '可控管理费用', '万元', '210.45', '按0.01万元步长核定'],
            ],
          },
        },
      ],
    };

    const buf1 = await renderDocx(docModel);
    const buf2 = await renderDocx(docModel);
    const sha1 = crypto.createHash('sha256').update(buf1).digest('hex');
    const sha2 = crypto.createHash('sha256').update(buf2).digest('hex');
    expect(sha1).toBe(sha2);

    const zip = await JSZip.loadAsync(buf1);
    const docXml = await zip.file('word/document.xml')!.async('string');
    expect(docXml).toContain('<w:tbl>');
    expect(docXml).toContain('<w:tblHeader/>');
    expect(docXml).toContain('<w:cantSplit/>');
    expect(docXml).toContain('综计发〔2026〕1号');
    expect(docXml).toContain('31,025.04');

    // 既有 docxParagraphs 段落提取不受表格影响
    const paras = await docxParagraphs(buf1);
    expect(paras.some((p) => p.includes('关于下达2026年度综合计划与经营预算的通知'))).toBe(true);
    expect(paras.some((p) => p.includes('31,025.04'))).toBe(true);

    // 接收端文档解析器 parseDocx 无报错且提取出表格行/列坐标
    const parsed = await parseDocx(buf1);
    expect(parsed.status).toBe('ok');
    expect(parsed.paragraphs.some((p) => p.table !== undefined && p.text.includes('31,025.04'))).toBe(true);
  });

  it('全集团 .zip 批量导出含通知 .docx + 责任书 + .xlsx 底稿；标准报表、全局搜索 plan_item 与工作台待办按 OrgScope 精准隔离', async () => {
    const { base, admin, db } = await boot('newfc-t14-export-search-');
    db.prepare(`UPDATE org SET status = 'inactive'`).run();
    seedOrgsFromCsv(
      db,
      [
        'code,parent_code,name,short_name,report_full_name,credit_code,org_kind,contract_prefix_code,plan_issuance_root_code,is_plan_excluded,is_direct_station,status,sort_order,备注',
        'GRP_HQ,,流域水电集团总部,集团总部,流域水电集团总部,91000000000000001A,legal_entity,GRP,GRP_HQ,0,0,active,1,集团总部',
        'HQ_DEP,GRP_HQ,集团综合管理部,综合部,流域水电集团总部/集团综合管理部,,hq_dept,GRP,GRP_HQ,0,0,active,2,本部部门',
        'ST_HUB_A,GRP_HQ,甲级直属水电枢纽,甲枢纽,流域水电集团总部/甲级直属水电枢纽,,direct_unit,STA,ST_HUB_A,0,1,active,3,直属电站A',
        'SUB_EN_D,GRP_HQ,清洁能源开发子公司,能源子公司,流域水电集团总部/清洁能源开发子公司,91000000000000002B,legal_entity,END,SUB_EN_D,0,0,active,4,子公司D',
      ].join('\n'),
      'confirm',
    );
    const hubAId = (db.prepare(`SELECT id FROM org WHERE code = 'ST_HUB_A'`).get() as { id: number }).id;
    const subDId = (db.prepare(`SELECT id FROM org WHERE code = 'SUB_EN_D'`).get() as { id: number }).id;

    const wb = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(
      wb,
      XLSX.utils.aoa_to_sheet([
        ['2026年固定资产购置计划表 单位：元'],
        ['序号', '设备名称', '年度计划', '承办单位'],
        ['1', '甲枢纽水轮机调速器改造专项', 1500000, '甲级直属水电枢纽'],
        ['2', '能源子公司风电集控系统升级专项', 2200000, '清洁能源开发子公司'],
      ]),
      '固定资产购置计划',
    );
    const batchRes = await upload(
      base,
      admin,
      '/api/plan/import',
      XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' }) as Buffer,
      '2026计划.xlsx',
      {
        year: '2026',
        actualPeriod: '2026-06',
      },
    );
    expect(batchRes.status).toBe(201);
    const batch = await json(batchRes);
    await json(post(base, admin, `/api/plan/batches/${batch.id}/activate`, { expectedCurrentBatchId: null }));

    const cycle = await json(
      post(base, admin, '/api/plan/issuance/cycles', {
        year: 2026,
        cycleCode: 'ZIP-2026-01',
        issuanceStage: 'official',
        sourcePlanBatchId: batch.id,
      }),
    );
    const published = await json(post(base, admin, `/api/plan/issuance/cycles/${cycle.id}/publish`, {}));
    const hubAPack = published.packs.find((p: any) => p.unitOrgId === hubAId)!;

    // 1. 单包 .docx 与全周期 .zip 导出校验
    const packDocxRes = await fetchAs(admin, `${base}/api/plan/issuance/packs/${hubAPack.id}/export-docx`);
    expect(packDocxRes.status).toBe(200);
    const packDocxBuf = Buffer.from(await packDocxRes.arrayBuffer());
    const packZip = await JSZip.loadAsync(packDocxBuf);
    expect(await packZip.file('word/document.xml')!.async('string')).toContain('<w:tbl>');

    const cycleZipRes = await fetchAs(admin, `${base}/api/plan/issuance/cycles/${cycle.id}/export-zip`);
    expect(cycleZipRes.status).toBe(200);
    const cycleZip = await JSZip.loadAsync(Buffer.from(await cycleZipRes.arrayBuffer()));
    const fileNames = Object.keys(cycleZip.files);
    expect(fileNames.some((n) => n.endsWith('.docx') && n.includes('通知'))).toBe(true);
    expect(fileNames.some((n) => n.endsWith('.docx') && n.includes('目标责任书'))).toBe(true);
    expect(fileNames.some((n) => n.endsWith('.xlsx'))).toBe(true);

    // 2. 标准冻结报表 plan_issuance_summary 生成与查询
    const stdRes = await post(base, admin, '/api/standard-reports', {
      reportType: 'plan_issuance_summary',
      year: 2026,
      cycleId: cycle.id,
    });
    expect(stdRes.status).toBe(201);
    const stdDto = await json(stdRes);
    expect(stdDto.reportType).toBe('plan_issuance_summary');
    expect(stdDto.rows).toHaveLength(3);

    // 3. 全局检索 /api/search?types=plan_item 与待办 /api/dashboard/todos 按 OrgScope 严格过滤
    const hubAUser = createScopedUser(db, {
      username: 'hub-a-searcher',
      roleCodes: ['data_maintainer'],
      orgIds: [hubAId],
    });

    const adminSearch = await json(get(base, admin, `/api/search?q=${encodeURIComponent('专项')}&types=plan_item`));
    expect(adminSearch.items).toHaveLength(2);

    const scopedSearch = await json(get(base, hubAUser.session, `/api/search?q=${encodeURIComponent('专项')}&types=plan_item`));
    expect(scopedSearch.items).toHaveLength(1);
    expect(scopedSearch.items[0].title).toContain('调速器改造专项');
    expect(scopedSearch.items[0].path).toContain(`batchId=${batch.id}`);

    // 待办与域概览：受限用户仅统计本单位 1 份待签收下达包；全组织管理员统计全部 3 份
    const scopedTodos = (await json(get(base, hubAUser.session, '/api/dashboard/todos'))).items as any[];
    expect(scopedTodos.find((t) => t.key === 'plan_issuance_ack')?.count).toBe(1);

    const adminTodos = (await json(get(base, admin, '/api/dashboard/todos'))).items as any[];
    expect(adminTodos.find((t) => t.key === 'plan_issuance_ack')?.count).toBe(3);

    const scopedDomains = (await json(get(base, hubAUser.session, '/api/dashboard/domains'))).blocks as any[];
    const planBlock = scopedDomains.find((b) => b.key === 'plan');
    expect(planBlock).toBeDefined();
    expect(planBlock.metrics.find((m: any) => m.label === '待签收下达包')?.value).toBe(1);
    expect(subDId).toBeGreaterThan(0);
  });
});
