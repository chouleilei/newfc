import { afterEach, describe, expect, it, vi } from 'vitest';
import http, { createServer, type Server, type RequestListener } from 'node:http';
import dns from 'node:dns/promises';
import JSZip from 'jszip';
import { testDb, closeAllTestDbs } from './helpers';
import {
  saveBusinessSettings,
  getSetting,
  listBusinessSettings,
} from '../src/modules/settings/business-settings';
import {
  parseContractDocument,
  parseDocx,
} from '../src/modules/contracts/document-parser';
import { checkedPdfServiceUrl, pdfServiceJson } from '../src/modules/contracts/pdf-service-url';
import { GOOD_TEXT, docx, parsed } from './t9-legal-fixture';
import {
  legalRules,
  uppercaseCents,
} from '../src/modules/contracts/legal-rules';
import {
  semanticReview,
  verdictFor,
} from '../src/modules/contracts/legal-review-run';
import type { ContractRow } from '../src/modules/contracts/contract.service';
const servers: Server[] = [];
afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    servers.splice(0).map((s) => new Promise<void>((r) => s.close(() => r()))),
  );
  closeAllTestDbs();
});
async function serve(handler: RequestListener) {
  const s = createServer(handler);
  servers.push(s);
  await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
  return `http://127.0.0.1:${(s.address() as { port: number }).port}`;
}
describe('T-9 PDF / OCR 与文档完整性', () => {
  it.each([
    [{ address: '203.0.113.7', family: 4 }],
    [{ address: '2001:db8::1', family: 6 }],
    [{ address: '127.0.0.1', family: 4 }, { address: '203.0.113.7', family: 4 }],
    [{ address: '10.example.test', family: 4 }],
    [],
  ].map(addresses => ({ addresses })))('HTTP DNS 必须全部解析到有效本机或私网 IP：$addresses', async ({ addresses }) => {
    vi.spyOn(dns, 'lookup').mockResolvedValue(addresses as never);
    const request = vi.spyOn(http, 'request').mockImplementation(() => { throw new Error('unexpected PDF network request'); });
    await expect(checkedPdfServiceUrl('http://localhost')).rejects.toThrow(/受限地址/);
    await expect(pdfServiceJson('http://localhost', new FormData(), 'must-not-send', 5000)).rejects.toThrow(/受限地址/);
    expect(request).not.toHaveBeenCalled();
  });
  it('合法 HTTPS 域名可解析到公网，私网 HTTP 地址继续可用', async () => {
    const lookup = vi.spyOn(dns, 'lookup');
    for (const host of ['feather', 'ffmpeg']) {
      lookup.mockResolvedValueOnce([{ address: '203.0.113.7', family: 4 }] as never);
      await expect(checkedPdfServiceUrl(`https://${host}.example.test`)).resolves.toBeInstanceOf(URL);
    }
    for (const address of ['10.1.2.3', '::1', 'fd12::1']) {
      lookup.mockResolvedValueOnce([{ address, family: address.includes(':') ? 6 : 4 }] as never);
      await expect(checkedPdfServiceUrl('http://localhost')).resolves.toBeInstanceOf(URL);
    }
  });
  it.each(['http://schemas.openxmlformats.org/wordprocessingml/2006/main', 'http://purl.oclc.org/ooxml/wordprocessingml/main'])('DOCX 空批注与分隔符附注不阻断，实际批注和附注仍需处理：%s', async (namespace) => {
    const zip = await JSZip.loadAsync(await docx());
    zip.file('word/comments.xml', `<x:comments xmlns:x="${namespace}"/>`);
    for (const part of ['footnotes', 'endnotes']) {
      const note = part === 'footnotes' ? 'footnote' : 'endnote';
      zip.file(`word/${part}.xml`, `<x:${part} xmlns:x="${namespace}"><x:${note} x:type="separator" x:id="-1"><x:p><x:r><x:separator/></x:r></x:p></x:${note}><x:${note} x:id="0"><x:p><x:r><x:continuationSeparator/></x:r></x:p></x:${note}></x:${part}>`);
    }
    const clean = await parseDocx(await zip.generateAsync({ type: 'nodebuffer' }));
    expect(clean.findings).toEqual([]);
    expect(verdictFor(clean.findings, clean.status, 'ok', true, true)).toBe('pass');
    zip.file('word/comments.xml', `<x:comments xmlns:x="${namespace}"><x:comment x:id="1"><x:p><x:r><x:t>待确认</x:t></x:r></x:p></x:comment></x:comments>`);
    const commented = await parseDocx(await zip.generateAsync({ type: 'nodebuffer' }));
    expect(commented.findings).toContainEqual(expect.objectContaining({ code: 'PLACEHOLDER_UNFILLED', blocking: true }));
    zip.file('word/comments.xml', `<x:comments xmlns:x="${namespace}"/>`);
    for (const part of ['footnotes', 'endnotes']) {
      const note = part === 'footnotes' ? 'footnote' : 'endnote';
      zip.file(`word/${part}.xml`, `<x:${part} xmlns:x="${namespace}"><x:${note} x:id="1"><x:p><x:r><x:t>实际附注条款</x:t></x:r></x:p></x:${note}></x:${part}>`);
      const annotated = await parseDocx(await zip.generateAsync({ type: 'nodebuffer' }));
      expect(annotated.findings.map(f => f.code)).toContain('DOCX_AUXILIARY_CONTENT');
      expect(verdictFor(annotated.findings, annotated.status, 'ok', true, true)).toBe('manual_review');
      zip.remove(`word/${part}.xml`);
    }
  });
  it('非法附属 XML 不得静默跳过；旧解析缓存不复用', async () => {
    for (const xml of ['<w:comments', '<!DOCTYPE comments [<!ENTITY x "text">]><comments/>']) {
      const zip = await JSZip.loadAsync(await docx());
      zip.file('word/comments.xml', xml);
      expect((await parseDocx(await zip.generateAsync({ type: 'nodebuffer' }))).status).toBe('failed');
    }
    const db = testDb();
    db.prepare('INSERT INTO ct_doc_parse_cache(file_sha256,parser_kind,parser_version,text_content,paragraphs_json,stats_json,created_at) VALUES(?,?,?,?,?,?,?)')
      .run('old-cache', 'docx_native', '2', 'old', '[]', JSON.stringify({ status: 'ok', findings: [{ code: 'PLACEHOLDER_UNFILLED' }] }), new Date().toISOString());
    const result = await parseContractDocument(db, await docx(), 'clean.docx', 'old-cache');
    expect(result.findings).toEqual([]);
    expect(result.text).toBe(GOOD_TEXT);
  });
  it('PDF 固定已校验地址、保留 Host/密钥、缓存成功结果，拒绝页码缺口/重定向/超大响应', async () => {
    const db = testDb();
    let calls = 0,
      mode = 'ok',
      host = '';
    const base = await serve((req, res) => {
      calls++;
      host = req.headers.host ?? '';
      expect(req.url).toBe('/v1/parse-pdf');
      expect(req.headers.authorization).toBe('Bearer local-pdf-secret');
      expect(req.headers['content-type']).toContain('multipart/form-data');
      req.resume();
      req.on('end', () => {
        if (mode === 'redirect') {
          res.writeHead(302, { Location: 'http://169.254.169.254/' });
          res.end();
        } else if (mode === 'huge') res.end(' '.repeat(2 * 1024 * 1024 + 1));
        else
          res.end(
            JSON.stringify({
              ok: true,
              pages:
                mode === 'gap'
                  ? [{ pageNo: 2, text: GOOD_TEXT }]
                  : [{ pageNo: 1, text: GOOD_TEXT }],
            }),
          );
      });
    });
    saveBusinessSettings(db, {
      'integration.pdf_parser_base_url': base + '/v1',
      'integration.pdf_parser_api_key': 'local-pdf-secret',
      'integration.pdf_fallback_ocr': false,
    });
    expect(
      (
        await parseContractDocument(
          db,
          Buffer.from('%PDF-1.7'),
          'test.pdf',
          'good-sha',
        )
      ).status,
    ).toBe('ok');
    expect(
      (
        await parseContractDocument(
          db,
          Buffer.from('%PDF-1.7'),
          'test.pdf',
          'good-sha',
        )
      ).text,
    ).toBe(GOOD_TEXT);
    expect(calls).toBe(1);
    for (const m of ['gap', 'redirect', 'huge']) {
      mode = m;
      expect(
        (
          await parseContractDocument(
            db,
            Buffer.from('%PDF-1.7'),
            'test.pdf',
            m,
          )
        ).findings[0].code,
      ).toBe('PDF_PARSER_FAILED');
    }
    mode = 'ok';
    const port = new URL(base).port;
    const lookup = vi
      .spyOn(dns, 'lookup')
      .mockResolvedValueOnce([{ address: '127.0.0.1', family: 4 }] as never);
    const form = new FormData();
    form.append('file', new Blob(['pdf']), 'test.pdf');
    await pdfServiceJson(
      `http://localhost:${port}/v1`,
      form,
      'local-pdf-secret',
      5000,
    );
    expect(host).toBe(`localhost:${port}`);
    expect(lookup).toHaveBeenCalledTimes(1);
    lookup.mockResolvedValueOnce([
      { address: '169.254.169.254', family: 4 },
    ] as never);
    await expect(
      pdfServiceJson('https://pdf.example.test', form, null, 5000),
    ).rejects.toThrow(/受限地址/);
  });
  it('PDF 未配置时回退 OCR，成功仍需逐页核验，失败保留明确原因', async () => {
    const db = testDb();
    let fail = false;
    const base = await serve((req, res) => {
      req.resume();
      req.on('end', () => {
        res.statusCode = fail ? 503 : 200;
        res.end(
          JSON.stringify({
            text: GOOD_TEXT,
            pages: [{ page: 1, text: GOOD_TEXT }],
          }),
        );
      });
    });
    saveBusinessSettings(db, { 'integration.ocr_base_url': base });
    const success = await parseContractDocument(
      db,
      Buffer.from('%PDF'),
      'text.pdf',
      'ocr-sha',
    );
    expect(success).toMatchObject({
      channel: 'ocr_fallback',
      status: 'degraded',
    });
    expect(success.findings[0].code).toBe('OCR_COVERAGE_UNVERIFIED');
    expect(verdictFor(success.findings, success.status, 'ok', true, true)).toBe(
      'manual_review',
    );
    fail = true;
    expect(
      (
        await parseContractDocument(
          db,
          Buffer.from('%PDF'),
          'text.pdf',
          'ocr-sha',
        )
      ).findings[0].code,
    ).toBe('OCR_FAILED');
    saveBusinessSettings(db, { 'integration.pdf_fallback_ocr': false });
    expect(
      (
        await parseContractDocument(
          db,
          Buffer.from('%PDF'),
          'text.pdf',
          'other',
        )
      ).findings[0].code,
    ).toBe('PDF_PARSER_UNCONFIGURED');
  });
  it('设置全量校验原子提交、超时边界及 secret 只写不读', () => {
    const db = testDb();
    expect(() =>
      saveBusinessSettings(db, {
        'integration.pdf_parser_api_key': 'never-write',
        'integration.pdf_parser_base_url': 'https://169.254.169.254',
      }),
    ).toThrow();
    expect(getSetting(db, 'integration.pdf_parser_api_key')).toBeNull();
    for (const timeout of [4, 301])
      expect(() =>
        saveBusinessSettings(db, {
          'integration.pdf_parser_timeout_seconds': timeout,
        }),
      ).toThrow();
    const result = saveBusinessSettings(db, {
      'integration.pdf_parser_api_key': 'only-server-secret',
      'integration.pdf_parser_timeout_seconds': 5,
    });
    expect(
      result.find((s) => s.key === 'integration.pdf_parser_api_key'),
    ).toMatchObject({ value: null, configured: true, preview: '****cret' });
    expect(JSON.stringify(listBusinessSettings(db))).not.toContain(
      'only-server-secret',
    );
  });
  it('DOCX XML 截断/非法实体/超限条目不接受，复杂内容可追溯', async () => {
    for (const xml of [
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:body><w:p></w:body></w:document>',
      '<w:document xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main"><w:p><w:r><w:t>&fake;</w:t></w:r></w:p></w:document>',
    ]) {
      const z = new JSZip();
      z.file('word/document.xml', xml);
      expect(
        (await parseDocx(await z.generateAsync({ type: 'nodebuffer' }))).status,
      ).toBe('failed');
    }
    const z = new JSZip();
    for (let i = 0; i < 2001; i++) z.file(`${i}.xml`, 'x');
    expect(
      (await parseDocx(await z.generateAsync({ type: 'nodebuffer' })))
        .findings[0].code,
    ).toBe('DOCX_LIMIT');
    expect(
      (await parseDocx(await docx(GOOD_TEXT, '<w:altChunk/>'))).findings[0]
        .code,
    ).toBe('DOCX_COMPLEX_CONTENT');
  });
});
describe('T-9 金额/分期边界与失败保留规则', () => {
  const c = {
    contract_no: 'LS-SG-001/2026-001',
    name: '采购合同',
    original_cents: 10000000n,
    approved_change_cents: 0n,
    legal_category: 'goods_procurement',
    party_role: 'buyer',
    is_procurement: 1,
    procurement_target: 'goods',
    procurement_method: 'inquiry',
    is_important: 0,
  } as ContractRow;
  const rules = (text: string, patch: Partial<ContractRow> = {}) =>
    legalRules({
      c: { ...c, ...patch },
      parsed: parsed(text),
      evidence: [
        'bid_award_approval',
        'legal_opinion',
        'triple_major_decision',
      ],
      policies: [],
      orgName: '上海公司',
      supplierName: '测试供货公司',
    });
  it('拒绝歧义大写/超范围，超过 2^53 的分无精度丢失', () => {
    for (const text of [
      '壹佰佰元整',
      '壹拾贰拾元整',
      '壹壹元整',
      '零佰元整',
      '壹元壹角壹角',
      '玖仟万亿元壹仟分',
      '玖拾万万亿元整',
    ])
      expect(() => uppercaseCents(text), text).toThrow();
    expect(uppercaseCents('玖仟万亿元整')).toBe(900000000000000000n);
    const result = rules(GOOD_TEXT, { original_cents: 9007199254740993n });
    expect(result.elements.totalAmount).toBe('90071992547409.93');
    expect(
      result.findings.some((f) => f.code === 'AMOUNT_UPPER_LOWER_MISMATCH'),
    ).toBe(true);
  });
  it('分期与累计支付按增量精确核对，倒置不可放行', () => {
    const base = GOOD_TEXT.replace(
      '到货款：货物验收合格并提供增值税专用发票后支付合同总价的95%。',
      '预付款：支付30%；验收后累计支付至95%，并提供增值税专用发票。',
    );
    expect(
      rules(base).findings.filter(
        (f) => f.code === 'PAYMENT_RATIO_SUM_INVALID',
      ),
    ).toEqual([]);
    expect(
      rules(base.replace('至95%', '至20%')).findings.some(
        (f) => f.code === 'PAYMENT_RATIO_SUM_INVALID',
      ),
    ).toBe(true);
    expect(
      rules(
        GOOD_TEXT + '\n本期支付人民币999999999999999999999.99元',
      ).findings.some((f) => f.code === 'AMOUNT_UNPARSEABLE'),
    ).toBe(true);
  });
  it('重要合同材料完整也不自动通过，模型失败保留确定性阻断', async () => {
    const f = rules(GOOD_TEXT, { is_important: 1 }).findings;
    expect(f.some((f) => f.code === 'IMPORTANT_CONTRACT_MANUAL')).toBe(true);
    expect(verdictFor(f, 'ok', 'ok', true, true)).toBe('manual_review');
    const hard = rules(GOOD_TEXT + '\n【未填写】').findings;
    const s = await semanticReview(parsed(), [], null, {
      complete: async () => {
        throw new Error('timeout');
      },
      streamChat: async function* () {},
    });
    expect(s.status).toBe('failed');
    expect(
      verdictFor([...hard, ...s.findings], 'ok', s.status, true, true),
    ).toBe('manual_review');
    expect(hard.some((f) => f.blocking)).toBe(true);
  });
});
