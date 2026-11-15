import crypto from 'node:crypto';
import http from 'node:http';
import { describe, expect, it } from 'vitest';
import { AI_FEATURES, listBindings, listChannels } from '../src/modules/settings/ai-channels.service';
import { parseContractDocument } from '../src/modules/contracts/document-parser';
import { INTERNAL_PDF_PARSER_TOKEN, isLoopbackAddress, parsePdftotextBboxXml } from '../src/modules/contracts/local-pdf-parser';
import { renderDocx } from '../src/modules/analysis-reports/render';
import { boot, get, json, post, upload, type Session } from './t3-helpers';
import { fetchAs } from './http-helpers';

const put = (base: string, s: Session, url: string, body: unknown) =>
  fetchAs(s, `${base}${url}`, {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });

/** 构造最小合法可被 pdftotext 提取英文文本的单页 PDF（零外部字库依赖）。 */
function buildMinimalPdfBuffer(asciiLine: string): Buffer {
  const escaped = asciiLine.replace(/([()\\])/g, '\\$1');
  const streamBody = `BT /F1 12 Tf 72 720 Td (${escaped}) Tj ET\n`;
  const objs = [
    '1 0 obj\n<< /Type /Catalog /Pages 2 0 R >>\nendobj\n',
    '2 0 obj\n<< /Type /Pages /Kids [3 0 R] /Count 1 >>\nendobj\n',
    '3 0 obj\n<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>\nendobj\n',
    '4 0 obj\n<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>\nendobj\n',
    `5 0 obj\n<< /Length ${Buffer.byteLength(streamBody, 'ascii')} >>\nstream\n${streamBody}endstream\nendobj\n`,
  ];
  let pdf = '%PDF-1.4\n';
  const offsets: number[] = [0];
  for (const obj of objs) {
    offsets.push(Buffer.byteLength(pdf, 'ascii'));
    pdf += obj;
  }
  const xrefOffset = Buffer.byteLength(pdf, 'ascii');
  pdf += `xref\n0 ${objs.length + 1}\n`;
  pdf += '0000000000 65535 f \n';
  for (let i = 1; i <= objs.length; i++) {
    pdf += `${String(offsets[i]).padStart(10, '0')} 00000 n \n`;
  }
  pdf += `trailer\n<< /Size ${objs.length + 1} /Root 1 0 R >>\nstartxref\n${xrefOffset}\n%%EOF\n`;
  return Buffer.from(pdf, 'ascii');
}

describe('T-GAP-04 / AC-T14-01 AI 功能绑定补齐、多样本慢响应诊断与受限 PDF/.doc 解析', () => {
  it('listBindings 恒返全部 8 项 AI_FEATURES（含 contract_legal_review），支持多样本 P50/P95 探活与近期调用诊断统计', async () => {
    const { base, admin, db } = await boot('newfc-t14-ai-bind-');
    expect(AI_FEATURES).toHaveLength(8);
    expect(AI_FEATURES).toContain('contract_legal_review');

    const initialBindings = listBindings(db);
    expect(initialBindings).toHaveLength(8);
    expect(initialBindings.map((b) => b.feature)).toEqual([...AI_FEATURES]);

    let hitCount = 0;
    const mockLlm = http.createServer((req, res) => {
      if (req.url === '/v1/chat/completions' && req.method === 'POST') {
        hitCount++;
        setTimeout(() => {
          res.writeHead(200, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ choices: [{ message: { content: 'pong' } }] }));
        }, hitCount === 3 ? 25 : 5);
        return;
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((resolve) => mockLlm.listen(0, '127.0.0.1', resolve));

    try {
      const port = (mockLlm.address() as { port: number }).port;
      const primaryRes = await json(
        post(base, admin, '/api/settings/ai-channels', {
          name: '主用本地网关',
          baseUrl: `http://127.0.0.1:${port}/v1`,
          apiKey: 'sk-test-primary-1234',
          model: 'qwen-legal-v1',
          timeoutMs: 12000,
          enabled: true,
        }),
      );
      const fallbackRes = await json(
        post(base, admin, '/api/settings/ai-channels', {
          name: '备用容灾网关',
          baseUrl: `http://127.0.0.1:${port}/v1`,
          apiKey: 'sk-test-fallback-5678',
          model: 'qwen-legal-backup',
          timeoutMs: 15000,
          enabled: true,
        }),
      );

      const saveRes = await put(base, admin, '/api/settings/ai-feature-bindings', {
        bindings: [
          {
            feature: 'contract_legal_review',
            primaryChannelId: primaryRes.id,
            fallbackChannelId: fallbackRes.id,
          },
        ],
      });
      expect(saveRes.status).toBe(200);
      const savedItems = (await json(saveRes)).items as any[];
      const legalBinding = savedItems.find((x) => x.feature === 'contract_legal_review');
      expect(legalBinding.primaryChannelId).toBe(primaryRes.id);
      expect(legalBinding.fallbackChannelId).toBe(fallbackRes.id);

      // 多样本探活：3 次请求输出 sampleCount=3 及 p50/p95
      const probeRes = await json(
        post(base, admin, `/api/settings/ai-channels/${primaryRes.id}/test`, { samples: 3 }),
      );
      expect(probeRes.status).toBe('ok');
      expect(probeRes.sampleCount).toBe(3);
      expect(probeRes.sampleLatencies).toHaveLength(3);
      expect(probeRes.p95LatencyMs).toBeGreaterThanOrEqual(probeRes.p50LatencyMs);

      // 写入 ai_model_call 观测记录，验证 P50/P95、超时率与主备切换次数统计
      const now = new Date().toISOString();
      const insCall = db.prepare(`
        INSERT INTO ai_model_call (
          feature, channel_name, model, status, error_type, error_message, fallback_used, latency_ms, created_at
        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
      insCall.run('contract_legal_review', '主用本地网关', 'qwen-legal-v1', 'success', '', '', 0, 420, now);
      insCall.run('contract_legal_review', '主用本地网关', 'qwen-legal-v1', 'success', '', '', 0, 860, now);
      insCall.run('contract_legal_review', '主用本地网关', 'qwen-legal-v1', 'timeout', 'timeout', '请求超时(>12000ms)', 0, 12050, now);
      insCall.run('contract_legal_review', '备用容灾网关', 'qwen-legal-backup', 'success', '', '', 1, 610, now);

      const bindingsDto = (await json(get(base, admin, '/api/settings/ai-feature-bindings'))).items as any[];
      const legalDiag = bindingsDto.find((x) => x.feature === 'contract_legal_review')!.diagnostics;
      expect(legalDiag.recentCalls).toBe(4);
      expect(legalDiag.okCalls).toBe(3);
      expect(legalDiag.timeoutCalls).toBe(1);
      expect(legalDiag.timeoutRate).toBe(0.25);
      expect(legalDiag.fallbackCalls).toBe(1);
      expect(legalDiag.p50LatencyMs).toBe(610);
      expect(legalDiag.p95LatencyMs).toBe(12050);

      const chList = listChannels(db);
      const primaryDiag = chList.find((c) => c.id === primaryRes.id)!.diagnostics;
      expect(primaryDiag.recentCalls).toBe(3);
      expect(primaryDiag.timeoutCalls).toBe(1);
    } finally {
      await new Promise<void>((resolve) => mockLlm.close(() => resolve()));
    }
  });

  it('受限回环 /api/internal/pdf-parser/* 与 parseContractDocument 在写事务外输出结构化页/块并命中 ct_doc_parse_cache', async () => {
    const { base, admin, db } = await boot('newfc-t14-pdf-parser-');

    expect(isLoopbackAddress('127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::ffff:127.0.0.1')).toBe(true);
    expect(isLoopbackAddress('::1')).toBe(true);
    expect(isLoopbackAddress('10.0.0.8')).toBe(false);
    expect(isLoopbackAddress('192.168.1.10')).toBe(false);

    const xmlPages = parsePdftotextBboxXml(`
      <doc><page width="595" height="842">
        <block xMin="72" yMin="80" xMax="480" yMax="110">
          <line><word xMin="72" xMax="120">第一条</word><word xMin="126" xMax="240">合同标的与范围</word></line>
        </block>
      </page></doc>
    `);
    expect(xmlPages).toHaveLength(1);
    expect(xmlPages[0].blocks[0].text).toContain('第一条 合同标的与范围');

    // 未携带服务令牌或经反向代理转发的请求均须拒绝
    expect((await fetch(`${base}/api/internal/pdf-parser/health`)).status).toBe(401);
    expect(
      (await fetch(`${base}/api/internal/pdf-parser/health`, {
        headers: {
          authorization: `Bearer ${INTERNAL_PDF_PARSER_TOKEN}`,
          'x-forwarded-for': '198.51.100.20',
          'x-forwarded-proto': 'https',
        },
      })).status,
    ).toBe(403);

    const authHeaders = { authorization: `Bearer ${INTERNAL_PDF_PARSER_TOKEN}` };
    // 探活本机回环 PDF 解析器健康端点
    const healthRes = await fetch(`${base}/api/internal/pdf-parser/health`, { headers: authHeaders });
    expect(healthRes.status).toBe(200);
    expect((await healthRes.json() as any).status).toBe('ok');

    // 非 PDF 魔数拒绝
    const badForm = new FormData();
    badForm.append('file', new Blob([Buffer.from('NOT_A_PDF_FILE')]), 'bad.pdf');
    const badRes = await fetch(`${base}/api/internal/pdf-parser/parse-pdf`, {
      method: 'POST',
      headers: authHeaders,
      body: badForm,
    });
    expect(badRes.status).toBe(400);

    // 配置 integration.pdf_parser_base_url 指向本服务内嵌端点，验证完整 PDF 解析与缓存命中
    await put(base, admin, '/api/settings/business', {
      'integration.pdf_parser_base_url': `${base}/api/internal/pdf-parser`,
    });

    const longClause =
      'Article 1 Scope of Hydraulic Equipment Maintenance Contract: Party B shall inspect, test, calibrate and maintain the turbine governor system within 30 calendar days.';
    const pdfBuf = buildMinimalPdfBuffer(longClause);
    const pdfSha = crypto.createHash('sha256').update(pdfBuf).digest('hex');

    expect(db.inTransaction).toBe(false);
    const parsed1 = await parseContractDocument(db, pdfBuf, 'maintenance-contract.pdf', pdfSha);
    expect(parsed1.status).toBe('ok');
    expect(parsed1.channel).toBe('pdf_external_api');
    expect(parsed1.text).toContain('Hydraulic Equipment Maintenance Contract');
    expect(parsed1.paragraphs[0].blocks?.length).toBeGreaterThan(0);

    const cacheRow = db
      .prepare('SELECT parser_kind, parser_version FROM ct_doc_parse_cache WHERE file_sha256 = ?')
      .get(pdfSha) as { parser_kind: string; parser_version: string } | undefined;
    expect(cacheRow?.parser_kind).toBe('pdf_external_api');

    // 将 base_url 改为不可达回环端口，同 sha 命中 ct_doc_parse_cache 直接返回 ok，无需再次发起网络请求
    await put(base, admin, '/api/settings/business', {
      'integration.pdf_parser_base_url': 'http://127.0.0.1:9/dead',
    });
    const parsedCached = await parseContractDocument(db, pdfBuf, 'maintenance-contract.pdf', pdfSha);
    expect(parsedCached.status).toBe('ok');
    expect(parsedCached.text).toBe(parsed1.text);

    // 验证 .doc 扩展名兼容上传 DOCX 容器（PK 魔数）转码通道不再返回 LEGACY_DOC_UNSUPPORTED
    const docxAsLegacyBuf = await renderDocx({
      title: '设备检修技术服务合同',
      meta: ['合同编号：TEST-DOC-2026-01'],
      sections: [
        { title: '第一条 服务内容', body: '乙方负责水电站自动化监控系统年度巡检、定值核对、备品测试及缺陷消缺工作，确保系统安全稳定运行并出具完整书面检测报告。' },
      ],
    });
    const docSha = crypto.createHash('sha256').update(docxAsLegacyBuf).digest('hex');
    const parsedDoc = await parseContractDocument(db, docxAsLegacyBuf, 'legacy-contract.doc', docSha);
    expect(parsedDoc.status).toBe('ok');
    expect(parsedDoc.channel).toBe('doc_converted');
    expect(parsedDoc.findings.some((f) => f.code === 'LEGACY_DOC_UNSUPPORTED')).toBe(false);
    expect(parsedDoc.paragraphs.length).toBeGreaterThan(0);
  });
});
