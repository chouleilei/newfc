import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import { SaxesParser } from 'saxes';
import { AppError } from '../../core/errors';

const execFileAsync = promisify(execFile);

export const PDF_MAGIC = Buffer.from('%PDF-');
export const MAX_PDF_PARSE_BYTES = 20 * 1024 * 1024;
export const PDF_PARSE_TIMEOUT_MS = 20_000;
/** 进程内随机生成的内部 PDF 解析服务令牌：未显式配置外部密钥时强制用于同进程受控调用鉴权。 */
export const INTERNAL_PDF_PARSER_TOKEN = crypto.randomBytes(32).toString('hex');

export interface PdfBlockDto {
  xMin: number;
  yMin: number;
  xMax: number;
  yMax: number;
  text: string;
}

export interface PdfPageDto {
  pageNo: number;
  text: string;
  blocks: PdfBlockDto[];
}

export interface LocalPdfParseResult {
  ok: true;
  pages: PdfPageDto[];
  isScanned: boolean;
}

export function isLoopbackAddress(remoteAddress: string | undefined): boolean {
  if (!remoteAddress) return false;
  const addr = remoteAddress.trim().toLowerCase();
  if (addr === '::1' || addr === '127.0.0.1') return true;
  if (addr.startsWith('::ffff:')) {
    const v4 = addr.slice('::ffff:'.length);
    return net.isIP(v4) === 4 && v4.startsWith('127.');
  }
  return net.isIP(addr) === 4 && addr.startsWith('127.');
}

const PROXY_OR_BROWSER_HEADERS = [
  'x-forwarded-for',
  'x-real-ip',
  'forwarded',
  'x-forwarded-proto',
  'x-forwarded-host',
  'x-forwarded-port',
  'cf-connecting-ip',
  'true-client-ip',
  'origin',
  'referer',
  'sec-fetch-site',
] as const;

export function isLoopbackHostHeader(hostHeader: string | undefined): boolean {
  if (!hostHeader || !hostHeader.trim()) return false;
  try {
    const u = new URL(`http://${hostHeader.trim()}`);
    if (u.username || u.password || u.pathname !== '/') return false;
    const hostname = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return hostname === 'localhost' || isLoopbackAddress(hostname);
  } catch {
    return false;
  }
}

/**
 * 校验请求必须是未经反向代理转发、非浏览器发起的本机直连回环请求：
 * 拒绝携带任何 X-Forwarded-* / X-Real-IP / Forwarded / Origin 头或非回环 Host 的请求。
 */
export function isDirectLoopbackRequest(input: {
  remoteAddress: string | undefined;
  ip?: string | undefined;
  headers: http.IncomingHttpHeaders;
}): boolean {
  if (!isLoopbackAddress(input.remoteAddress)) return false;
  if (input.ip !== undefined && !isLoopbackAddress(input.ip)) return false;
  for (const h of PROXY_OR_BROWSER_HEADERS) {
    const v = input.headers[h];
    if (v !== undefined && (Array.isArray(v) ? v.length > 0 : v.trim() !== '')) {
      return false;
    }
  }
  const host = typeof input.headers.host === 'string' ? input.headers.host : undefined;
  return isLoopbackHostHeader(host);
}

export function timingSafeBearerMatch(authorization: string | undefined, expectedToken: string): boolean {
  if (!authorization || !expectedToken) return false;
  const expected = Buffer.from(`Bearer ${expectedToken}`, 'utf8');
  const actual = Buffer.from(authorization, 'utf8');
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(expected, actual);
}

/**
 * 解析调用 PDF 解析服务时应携带的 Bearer 密钥：
 * 若管理员已配置 `integration.pdf_parser_api_key` 则优先使用；
 * 若未配置且目标地址为本进程内嵌 `/api/internal/pdf-parser`，自动注入进程级随机令牌。
 */
export function resolvePdfParserAuthKey(
  baseUrl: string,
  configuredKey: string | null | undefined,
): string | null {
  const trimmedKey = configuredKey?.trim();
  if (trimmedKey) return trimmedKey;
  try {
    const u = new URL(baseUrl);
    const hostname = u.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const cleanPath = u.pathname.replace(/\/+$/, '');
    if (
      (hostname === 'localhost' || isLoopbackAddress(hostname)) &&
      cleanPath.endsWith('/api/internal/pdf-parser')
    ) {
      return INTERNAL_PDF_PARSER_TOKEN;
    }
  } catch {
    // invalid URL handled downstream by validatePdfServiceUrl
  }
  return null;
}

function joinWords(words: { text: string; xMin: number; xMax: number }[]): string {
  if (words.length === 0) return '';
  let out = words[0].text;
  for (let i = 1; i < words.length; i++) {
    const prev = words[i - 1];
    const cur = words[i];
    const gap = cur.xMin - prev.xMax;
    const bothAscii = /[A-Za-z0-9]$/.test(prev.text) && /^[A-Za-z0-9]/.test(cur.text);
    if (bothAscii || gap > 3.5) out += ' ';
    out += cur.text;
  }
  return out.trim();
}

export function parsePdftotextBboxXml(rawXml: string): PdfPageDto[] {
  const cleaned = rawXml.replace(/<!DOCTYPE[^>]*>/gi, '');
  const pages: PdfPageDto[] = [];
  let curPage: PdfPageDto | null = null;
  let curBlock: { xMin: number; yMin: number; xMax: number; yMax: number; lines: string[] } | null = null;
  let curLineWords: { text: string; xMin: number; xMax: number }[] | null = null;
  let curWord: { xMin: number; xMax: number; text: string } | null = null;

  const parser = new SaxesParser({ xmlns: false });
  parser.on('error', (err) => { throw err; });
  parser.on('opentag', (tag) => {
    const name = tag.name.toLowerCase();
    if (name === 'page') {
      curPage = { pageNo: pages.length + 1, text: '', blocks: [] };
    } else if (name === 'block' && curPage) {
      curBlock = {
        xMin: Number(tag.attributes.xMin ?? 0) || 0,
        yMin: Number(tag.attributes.yMin ?? 0) || 0,
        xMax: Number(tag.attributes.xMax ?? 0) || 0,
        yMax: Number(tag.attributes.yMax ?? 0) || 0,
        lines: [],
      };
    } else if (name === 'line' && curBlock) {
      curLineWords = [];
    } else if (name === 'word' && curLineWords) {
      curWord = {
        xMin: Number(tag.attributes.xMin ?? 0) || 0,
        xMax: Number(tag.attributes.xMax ?? 0) || 0,
        text: '',
      };
    }
  });
  parser.on('text', (txt) => {
    if (curWord) curWord.text += txt;
  });
  parser.on('closetag', (tag) => {
    const name = tag.name.toLowerCase();
    if (name === 'word' && curWord && curLineWords) {
      const trimmed = curWord.text.trim();
      if (trimmed) curLineWords.push({ text: trimmed, xMin: curWord.xMin, xMax: curWord.xMax });
      curWord = null;
    } else if (name === 'line' && curLineWords && curBlock) {
      const lineText = joinWords(curLineWords);
      if (lineText) curBlock.lines.push(lineText);
      curLineWords = null;
    } else if (name === 'block' && curBlock && curPage) {
      const blockText = curBlock.lines.join('\n').trim();
      if (blockText) {
        curPage.blocks.push({
          xMin: curBlock.xMin,
          yMin: curBlock.yMin,
          xMax: curBlock.xMax,
          yMax: curBlock.yMax,
          text: blockText,
        });
      }
      curBlock = null;
    } else if (name === 'page' && curPage) {
      curPage.text = curPage.blocks.map((b) => b.text).join('\n');
      pages.push(curPage);
      curPage = null;
    }
  });
  parser.write(cleaned).close();
  return pages;
}

/**
 * 受资源边界限制的本机 PDF 结构化解析器（严禁在 SQLite 写事务内调用）：
 * 校验 %PDF- 魔数、限制最大字节与 20s 子进程超时，产出页码、块坐标与扫描件判定。
 */
export async function parsePdfBufferLocally(content: Buffer): Promise<LocalPdfParseResult> {
  if (content.length < 5 || !content.subarray(0, 5).equals(PDF_MAGIC)) {
    throw new AppError('PDF_INVALID_MAGIC', '上传文件不是有效的 PDF（%PDF- 魔数不匹配）', 400);
  }
  if (content.length > MAX_PDF_PARSE_BYTES) {
    throw new AppError('PDF_SIZE_EXCEEDED', 'PDF 文件大小超出本机解析上限（20MB）', 413);
  }
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'newfc-pdf-parse-'));
  try {
    const inPath = path.join(tmpDir, 'input.pdf');
    fs.writeFileSync(inPath, content, { mode: 0o400 });
    const { stdout } = await execFileAsync('pdftotext', ['-bbox-layout', inPath, '-'], {
      timeout: PDF_PARSE_TIMEOUT_MS,
      maxBuffer: 8 * 1024 * 1024,
      env: {
        PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
        HOME: tmpDir,
        LANG: 'C.UTF-8',
      },
    });
    const pages = parsePdftotextBboxXml(stdout);
    if (pages.length === 0) {
      throw new AppError('PDF_EMPTY_PAGES', 'PDF 未解析出有效页面结构', 422);
    }
    const totalChars = pages.reduce((acc, p) => acc + p.text.replace(/\s+/g, '').length, 0);
    const isScanned = totalChars < Math.max(5, pages.length * 3);
    return { ok: true, pages, isScanned };
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    } catch {
      // ignore cleanup error
    }
  }
}

/**
 * 创建仅监听 127.0.0.1 的轻量无状态 PDF 解析 HTTP 服务（供本机按需部署或集成测试调用）。
 */
export function createLocalPdfParserServer(opts?: { apiKey?: () => string | null }): http.Server {
  return http.createServer(async (req, res) => {
    if (!isDirectLoopbackRequest({ remoteAddress: req.socket.remoteAddress, headers: req.headers })) {
      res.writeHead(403, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 'LOOPBACK_ONLY', message: '仅允许本机回环地址访问' }));
      return;
    }
    const expectedKey = opts?.apiKey?.() ?? null;
    if (expectedKey && !timingSafeBearerMatch(req.headers.authorization, expectedKey)) {
      res.writeHead(401, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ code: 'UNAUTHORIZED', message: 'PDF 解析密钥校验失败' }));
      return;
    }
    const urlPath = (req.url ?? '/').split('?')[0];
    if (req.method === 'GET' && urlPath.endsWith('/health')) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ ok: true, service: 'newfc-local-pdf-parser' }));
      return;
    }
    if (req.method === 'POST' && urlPath.endsWith('/parse-pdf')) {
      try {
        const chunks: Buffer[] = [];
        let total = 0;
        for await (const chunk of req) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
          total += buf.length;
          if (total > MAX_PDF_PARSE_BYTES + 1024 * 1024) {
            res.writeHead(413, { 'content-type': 'application/json' });
            res.end(JSON.stringify({ code: 'PDF_SIZE_EXCEEDED', message: 'PDF 请求体超出安全上限' }));
            return;
          }
          chunks.push(buf);
        }
        const rawBody = Buffer.concat(chunks);
        const ct = req.headers['content-type'] ?? '';
        let fileBuf: Buffer;
        if (ct.includes('multipart/form-data')) {
          const webReq = new Request('http://127.0.0.1/parse-pdf', {
            method: 'POST',
            headers: { 'content-type': ct },
            body: new Uint8Array(rawBody),
          });
          const form = await webReq.formData();
          const file = form.get('file');
          if (!(file instanceof Blob)) throw new Error('MISSING_FILE');
          fileBuf = Buffer.from(await file.arrayBuffer());
        } else {
          fileBuf = rawBody;
        }
        const parsed = await parsePdfBufferLocally(fileBuf);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify(parsed));
      } catch (err) {
        res.writeHead(422, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ code: 'PDF_PARSE_FAILED', message: err instanceof Error ? err.message : String(err) }));
      }
      return;
    }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ code: 'NOT_FOUND', message: '未找到路由' }));
  });
}
