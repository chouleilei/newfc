import { execFile } from 'node:child_process';
import fs from 'node:fs';
import { createServer, type Server } from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import * as XLSX from 'xlsx';
import { afterEach, describe, expect, it } from 'vitest';
import seed from '../../deploy/contract-legal-seed-v1.json';
import { parseContractDocument } from '../src/modules/contracts/document-parser';
import { importLegalSeed } from '../src/modules/contracts/legal-catalog.service';
import { saveBusinessSettings } from '../src/modules/settings/business-settings';
import { SIGNATORIES, seedNetAssets } from './contract-review-fixtures';
import { fetchAs } from './http-helpers';
import { boot, get, json, post, upload } from './t3-helpers';
import { createProject, createSupplier } from './t4-helpers';
import { GOOD_TEXT, docx } from './t9-legal-fixture';

const execFileAsync = promisify(execFile);
const servers: Server[] = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))));
});

async function buildRealOle2DocFromText(text: string): Promise<Buffer> {
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'newfc-mkdoc-'));
  try {
    const inPath = path.join(tmpDir, 'source.html');
    const outDir = path.join(tmpDir, 'out');
    const profileDir = path.join(tmpDir, 'profile');
    fs.mkdirSync(outDir, { mode: 0o700 });
    fs.mkdirSync(profileDir, { mode: 0o700 });
    const htmlBody = text
      .split('\n')
      .map((line) => `<p>${line.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')}</p>`)
      .join('\n');
    fs.writeFileSync(inPath, `<!doctype html><html><head><meta charset="utf-8"></head><body>${htmlBody}</body></html>`, 'utf8');
    await execFileAsync(
      'soffice',
      [
        '--headless',
        '--norestore',
        '--nologo',
        '--nodefault',
        '--nofirststartwizard',
        `-env:UserInstallation=file://${profileDir}`,
        '--convert-to',
        'doc:MS Word 97',
        '--outdir',
        outDir,
        inPath,
      ],
      { timeout: 20_000 },
    );
    return fs.readFileSync(path.join(outDir, 'source.doc'));
  } finally {
    fs.rmSync(tmpDir, { recursive: true });
  }
}

function buildSyntheticEncryptedOle2Doc(): Buffer {
  const cfb = XLSX.CFB.utils.cfb_new();
  const fib = Buffer.alloc(64, 0);
  fib.writeUInt16LE(0xa5ec, 0); // wIdent
  fib.writeUInt16LE(0x0100, 0x0a); // fEncrypted = 1
  XLSX.CFB.utils.cfb_add(cfb, '/WordDocument', fib);
  const out = Buffer.from(XLSX.CFB.write(cfb, { type: 'buffer' }));
  return out.length >= 512 ? out : Buffer.concat([out, Buffer.alloc(512 - out.length, 0)]);
}

describe('T-13 GAP-16 智能法审 6 类生效对齐、范本受控转正、.doc 正文转码与下载扩展名补全', () => {
  it('6 大业务类别触发法审、tech_service 范本转正后输出 pass、真实 OLE2 .doc 上传与缓存转码、加密 .doc 降级人工复核及无后缀下载补全', async () => {
    const t = await boot('newfc-t13-gap16-');
    seedNetAssets(t.db);
    importLegalSeed(t.db, seed);

    const projectId = await createProject(t.base, t.admin, 'P-G16', '法审六类验证工程', t.fx.orgIds.shanghai);
    const supplierId = await createSupplier(t.base, t.admin, 'S-G16', '测试供货公司');

    const model = createServer((req, res) => {
      req.resume();
      req.on('end', () => {
        res.setHeader('Content-Type', 'application/json');
        res.end(JSON.stringify({ choices: [{ message: { content: '{"findings":[]}' } }] }));
      });
    }).listen(0);
    servers.push(model);
    const modelUrl = `http://127.0.0.1:${(model.address() as { port: number }).port}/v1`;
    const aiRes = await post(t.base, t.admin, '/api/settings/ai-channels', {
      name: 'GAP16受控模型',
      provider: 'openai',
      baseUrl: modelUrl,
      apiKey: 'test-gap16-key',
      model: 'mock-legal',
      isDefault: true,
      enabled: true,
    });
    expect(aiRes.status).toBe(201);

    // 1) 验证默认 6 类合同 legalReviewEnabled === true，income_sales / other 默认 false
    for (const [idx, cat] of [
      'goods_procurement',
      'small_construction',
      'construction',
      'tech_service',
      'general_service',
      'important_special',
    ].entries()) {
      const isProc = ['goods_procurement', 'small_construction', 'tech_service'].includes(cat);
      const res = await json(
        post(t.base, t.admin, '/api/contracts', {
          ...SIGNATORIES,
          contractNo: `LS-SG-001/2026-10${idx}`,
          name: `六类测试_${cat}`,
          contractType: '测试',
          orgId: t.fx.orgIds.shanghai,
          projectId,
          supplierId,
          originalAmount: '100000.00',
          legalCategory: cat,
          partyRole: 'buyer',
          isProcurement: isProc,
          procurementTarget: isProc ? (cat === 'tech_service' ? 'service' : 'goods') : null,
          procurementMethod: isProc ? 'inquiry' : null,
        }),
      );
      expect(res.legalReviewEnabled, cat).toBe(true);
    }

    const nonDefault = await json(
      post(t.base, t.admin, '/api/contracts', {
        ...SIGNATORIES,
        contractNo: 'LS-QT-001/2026-199',
        name: '非默认类别合同',
        contractType: '其他',
        orgId: t.fx.orgIds.shanghai,
        projectId,
        supplierId,
        originalAmount: '50000.00',
        legalCategory: 'other',
        isProcurement: false,
      }),
    );
    expect(nonDefault.legalReviewEnabled).toBe(false);

    // 配置项微调验证
    saveBusinessSettings(t.db, { 'contract.legal_review_categories': 'goods_procurement,other' });
    const reloadedOther = await json(get(t.base, t.admin, `/api/contracts/${nonDefault.id}`));
    expect(reloadedOther.legalReviewEnabled).toBe(true);
    saveBusinessSettings(t.db, {
      'contract.legal_review_categories':
        'goods_procurement,small_construction,construction,tech_service,general_service,important_special',
    });

    // 2) tech_service 合同 + 真实 OLE2 .doc 正文上传 + candidate(manual_review) -> promote -> official(pass)
    let techContract = await json(
      post(t.base, t.admin, '/api/contracts', {
        ...SIGNATORIES,
        contractNo: 'LS-SG-001/2026-001',
        name: '设备物资采购合同',
        contractType: '技术服务',
        orgId: t.fx.orgIds.shanghai,
        projectId,
        supplierId,
        originalAmount: '100000.00',
        legalCategory: 'tech_service',
        partyRole: 'buyer',
        isProcurement: true,
        procurementTarget: 'service',
        procurementMethod: 'inquiry',
      }),
    );
    expect(techContract.legalReviewEnabled).toBe(true);

    await upload(t.base, t.admin, `/api/contracts/${techContract.id}/documents`, Buffer.from('award'), 'award.pdf', {
      docType: 'procurement',
      evidenceKind: 'bid_award_approval',
    });
    await upload(t.base, t.admin, `/api/contracts/${techContract.id}/documents`, Buffer.from('spec'), 'spec.pdf', {
      docType: 'procurement',
      evidenceKind: 'tech_spec',
    });
    for (const st of ['procurement', 'drafting'] as const) {
      techContract = await json(get(t.base, t.admin, `/api/contracts/${techContract.id}`));
      techContract = await json(post(t.base, t.admin, `/api/contracts/${techContract.id}/advance`, { expectedVersion: techContract.version, toStage: st }));
    }

    const validDocxBuf = await docx(GOOD_TEXT);
    const realOle2DocBuf = await buildRealOle2DocFromText(GOOD_TEXT);
    expect(realOle2DocBuf.subarray(0, 8).toString('hex')).toBe('d0cf11e0a1b11ae1');

    const upDocRes = await upload(
      t.base,
      t.admin,
      `/api/contracts/${techContract.id}/documents`,
      realOle2DocBuf,
      '技术服务合同正文.doc',
      { docType: 'contract_text' },
    );
    expect(upDocRes.status).toBe(201);

    const tplTech = await json(
      post(t.base, t.admin, '/api/contracts/legal-catalog/templates', {
        code: 'TPL-DAM-TECH-2026',
        version: 2,
        name: '技术服务标准范本',
        legalCategory: 'tech_service',
        notes: '初始为 candidate，须人工 promote',
        approvalStatus: 'candidate',
        clauses: [
          {
            clauseKey: 'no_subcontract',
            clauseNo: '第五条',
            title: '禁止违法分包',
            tier: 'fixed',
            standardText: '不得将主体义务转包或违法分包。',
          },
        ],
      }),
    );

    const waitLegalRun = async () => {
      const runRes = await post(t.base, t.admin, `/api/contracts/${techContract.id}/legal-reviews/run`);
      expect(runRes.status).toBe(202);
      let result: any;
      for (let i = 0; i < 200; i++) {
        result = await json(get(t.base, t.admin, `/api/contracts/${techContract.id}/legal-reviews`));
        if (!result.activeJob) break;
        await new Promise((res) => setTimeout(res, 50));
      }
      return result;
    };

    const candidateReviews = await waitLegalRun();
    expect(candidateReviews.runs[0]).toMatchObject({
      parseChannel: 'doc_converted',
      parseStatus: 'ok',
      verdict: 'manual_review',
      templateApprovalStatus: 'candidate',
    });
    const cachedRow = t.db
      .prepare("SELECT parser_kind FROM ct_doc_parse_cache WHERE parser_kind = 'doc_converted'")
      .get() as { parser_kind: string } | undefined;
    expect(cachedRow?.parser_kind).toBe('doc_converted');

    // 人工审定转正范本后再次运行法审：不再被 tech_service 硬编码拦截，输出 pass！
    const promRes = await post(t.base, t.admin, `/api/contracts/legal-catalog/templates/${tplTech.id}/promote`, {
      reason: '法务部与企管部联合核定技术服务范本转正',
    });
    expect(promRes.status).toBe(200);

    const officialReviews = await waitLegalRun();
    expect(officialReviews.runs[0]).toMatchObject({
      parseChannel: 'doc_converted',
      parseStatus: 'ok',
      verdict: 'pass',
      templateApprovalStatus: 'official',
    });

    // 3) 加密 OLE2 .doc 在内存 FIB 检查阶段即刻返回 DOC_ENCRYPTED_OR_INVALID
    const encDoc = buildSyntheticEncryptedOle2Doc();
    const encParsed = await parseContractDocument(t.db, encDoc, 'encrypted.doc', 'f'.repeat(64));
    expect(encParsed.status).toBe('failed');
    expect(encParsed.findings[0].code).toBe('DOC_ENCRYPTED_OR_INVALID');

    // 4) 法审原件上传无扩展名时，下载自动补全扩展名（.docx / .pdf / .doc）
    const attachNoExtDocx = await upload(
      t.base,
      t.admin,
      `/api/contracts/legal-catalog/templates/${tplTech.id}/source`,
      validDocxBuf,
      '技术服务范本原件无后缀',
    );
    expect(attachNoExtDocx.status).toBe(200);
    const dlDocx = await fetchAs(t.admin, `${t.base}/api/contracts/legal-catalog/templates/${tplTech.id}/source`);
    expect(dlDocx.status).toBe(200);
    expect(decodeURIComponent(dlDocx.headers.get('content-disposition') ?? '')).toContain('技术服务范本原件无后缀.docx');

    const attachNoExtPdf = await upload(
      t.base,
      t.admin,
      `/api/contracts/legal-catalog/templates/${tplTech.id}/source`,
      Buffer.from('%PDF-1.4 synthetic pdf'),
      '制度红头扫描无后缀',
    );
    expect(attachNoExtPdf.status).toBe(200);
    const dlPdf = await fetchAs(t.admin, `${t.base}/api/contracts/legal-catalog/templates/${tplTech.id}/source`);
    expect(decodeURIComponent(dlPdf.headers.get('content-disposition') ?? '')).toContain('制度红头扫描无后缀.pdf');
  });
});
