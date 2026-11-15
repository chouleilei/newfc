import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { promisify } from 'node:util';
import JSZip from 'jszip';
import { SaxesParser } from 'saxes';
import * as XLSX from 'xlsx';
import { z } from 'zod';
import type { DB } from '../../db/connection';
import type { LegalFinding } from '../../contracts/contract-legal-review';
import { getSetting } from '../settings/business-settings';
import { recognizeAttachment } from '../expense/ocr-client';
import { resolvePdfParserAuthKey } from './local-pdf-parser';
import { pdfServiceJson } from './pdf-service-url';

const execFileAsync = promisify(execFile);
export const OLE2_MAGIC = Buffer.from([0xd0, 0xcf, 0x11, 0xe0, 0xa1, 0xb1, 0x1a, 0xe1]);
export const MAX_DOC_CONVERT_BYTES = 20 * 1024 * 1024;
export const DOC_CONVERT_TIMEOUT_MS = 20_000;

export interface Paragraph {
  index: number;
  heading: string;
  text: string;
  page: number;
  table?: number;
  row?: number;
  cell?: number;
  blocks?: unknown[];
}
export interface ParsedDocument {
  text: string;
  paragraphs: Paragraph[];
  channel: 'docx_native' | 'doc_converted' | 'pdf_external_api' | 'ocr_fallback' | 'failed';
  status: 'ok' | 'degraded' | 'unavailable' | 'failed';
  findings: LegalFinding[];
  stats: Record<string, number | boolean | string>;
}
export const parserFinding = (code: string, message: string): LegalFinding => ({
  source: 'parse_ocr',
  code,
  severity: 'medium',
  blocking: false,
  title: message,
  message,
  locationRef: '全文',
  excerpt: '',
  expectedText: '完整、可定位的合同正文',
  suggestedText: '补充完整正文或人工核验原件',
  policyClauseId: null,
  templateClauseId: null,
});
export const legacyDoc = (name: string, b: Buffer) =>
  /\.doc$/i.test(name) ||
  b.subarray(0, 4).equals(Buffer.from([0xd0, 0xcf, 0x11, 0xe0]));

export function isValidLegacyDocUpload(content: Buffer): boolean {
  if (content.length > MAX_DOC_CONVERT_BYTES) return false;
  if (content.length >= 4 && content.readUInt32LE(0) === 0x04034b50) return true;
  return content.length >= 512 && content.subarray(0, 8).equals(OLE2_MAGIC);
}
const empty = (
  code: string,
  message: string,
  status: ParsedDocument['status'] = 'unavailable',
): ParsedDocument => ({
  text: '',
  paragraphs: [],
  channel: 'failed',
  status,
  findings: [parserFinding(code, message)],
  stats: {},
});
const isWord = (uri: string) => [
  'http://schemas.openxmlformats.org/wordprocessingml/2006/main',
  'http://purl.oclc.org/ooxml/wordprocessingml/main',
].includes(uri);
/** Empty comment parts and built-in note separators are normal Word/WPS output. */
function hasAuxiliaryContent(xml: string, part: 'comments' | 'footnotes' | 'endnotes'): boolean {
  let content = false, root = false;
  let note: { builtin: boolean; separator: boolean; content: boolean } | undefined;
  const noteName = part === 'footnotes' ? 'footnote' : 'endnote';
  const parser = new SaxesParser({ xmlns: true });
  parser.on('error', (error) => { throw error; });
  parser.on('doctype', () => { throw new Error('DOCX_DTD'); });
  parser.on('opentag', (tag) => {
    if (!root) {
      if (!isWord(tag.uri) || tag.local !== part) throw new Error('DOCX_AUXILIARY_ROOT');
      root = true;
    }
    if (!isWord(tag.uri)) {
      if (note) note.content = true;
      return;
    }
    if (part === 'comments' && tag.local === 'comment') content = true;
    if (part !== 'comments' && tag.local === noteName) {
      const type = Object.values(tag.attributes).find((a) => isWord(a.uri) && a.local === 'type')?.value;
      note = { builtin: ['separator', 'continuationSeparator', 'continuationNotice'].includes(type ?? ''), separator: false, content: false };
    }
    if (note && ['separator', 'continuationSeparator', 'continuationNotice'].includes(tag.local)) note.separator = true;
    if (note && ['drawing', 'object', 'altChunk', 'txbxContent'].includes(tag.local)) note.content = true;
  });
  parser.on('text', (text) => { if (note && text.trim()) note.content = true; });
  parser.on('closetag', (tag) => {
    if (isWord(tag.uri) && tag.local === noteName && note) {
      if (note.content || (!note.builtin && !note.separator)) content = true;
      note = undefined;
    }
  });
  parser.write(xml).close();
  if (!root) throw new Error('DOCX_AUXILIARY_ROOT');
  return content;
}
/** Stream every entry before materializing XML, bounding both actual bytes and entry count. */
export async function parseDocx(content: Buffer): Promise<ParsedDocument> {
  try {
    if (content.length < 4 || content.readUInt32LE(0) !== 0x04034b50)
      return empty('DOCX_INVALID', '正文不是有效 DOCX', 'failed');
    const zip = await JSZip.loadAsync(content);
    const entries = Object.values(zip.files);
    if (entries.length > 2000)
      return empty('DOCX_LIMIT', 'DOCX 条目超过安全上限', 'failed');
    let total = 0;
    const xmls = new Map<string, string>();
    for (const e of entries.filter((e) => !e.dir)) {
      const chunks: Buffer[] = [];
      const keep =
        /^word\/(document|comments|footnotes|endnotes|header\d+|footer\d+)\.xml$/.test(
          e.name,
        );
      await new Promise<void>((resolve, reject) => {
        const stream = e.nodeStream() as NodeJS.ReadableStream & {
          destroy(): void;
        };
        stream.on('data', (chunk: Buffer) => {
          total += chunk.length;
          if (total > 32 * 1024 * 1024) {
            stream.destroy();
            reject(new Error('ZIP_LIMIT'));
            return;
          }
          if (keep) chunks.push(chunk);
        });
        stream.on('end', resolve);
        stream.on('error', reject);
      });
      if (keep) xmls.set(e.name, Buffer.concat(chunks).toString('utf8'));
    }
    const xml = xmls.get('word/document.xml');
    if (!xml || /<!DOCTYPE|<!ENTITY/i.test(xml))
      return empty('DOCX_INVALID', 'DOCX 缺少有效正文', 'failed');
    const paragraphs: Paragraph[] = [];
    let page = 1,
      heading = '',
      inText = false,
      tableNo = 0,
      revision = false,
      complex = false,
      validRoot = false;
    const tables: { table: number; row: number; cell: number }[] = [];
    const ps: { text: string; page: number }[] = [];
    const parser = new SaxesParser({ xmlns: true });
    parser.on('error', (error) => {
      throw error;
    });
    parser.on('doctype', () => {
      throw new Error('DOCX_DTD');
    });
    parser.on('opentag', (tag) => {
      if (!isWord(tag.uri)) return;
      const name = tag.local,
        p = ps.at(-1);
      if (name === 'document') validRoot = true;
      if (['ins', 'del'].includes(name)) revision = true;
      if (['altChunk', 'object', 'txbxContent'].includes(name)) complex = true;
      if (name === 'tbl') tables.push({ table: ++tableNo, row: 0, cell: 0 });
      if (name === 'tr' && tables.length) {
        tables.at(-1)!.row++;
        tables.at(-1)!.cell = 0;
      }
      if (name === 'tc' && tables.length) tables.at(-1)!.cell++;
      if (name === 'p') ps.push({ text: '', page });
      if (name === 't' || name === 'delText') inText = true;
      if (name === 'tab' && p) p.text += '\t';
      if (name === 'br') {
        if (
          Object.values(tag.attributes).some(
            (a) => a.local === 'type' && a.value === 'page',
          )
        )
          page++;
        else if (p) p.text += '\n';
      }
      if (name === 'lastRenderedPageBreak') page++;
    });
    parser.on('text', (text) => {
      if (inText && ps.length) ps.at(-1)!.text += text;
    });
    parser.on('closetag', (tag) => {
      if (!isWord(tag.uri)) return;
      if (tag.local === 't' || tag.local === 'delText') inText = false;
      if (tag.local === 'p') {
        const p = ps.pop();
        const text = p?.text.trim();
        if (text) {
          const h = text.match(
            /^(第[一二三四五六七八九十百\d]+[条章节]|\d+(?:\.\d+)+|附件[一二三四五六七八九十\d]+)/,
          )?.[0];
          if (h) heading = h;
          paragraphs.push({
            index: paragraphs.length + 1,
            heading,
            text,
            page: p!.page,
            ...tables.at(-1),
          });
        }
      }
      if (tag.local === 'tbl') tables.pop();
    });
    parser.write(xml).close();
    if (!validRoot)
      return empty('DOCX_INVALID', 'DOCX 正文根节点不合法', 'failed');
    const findings: LegalFinding[] = [];
    const comments = xmls.get('word/comments.xml');
    const hasComments = comments !== undefined && hasAuxiliaryContent(comments, 'comments');
    if (revision || hasComments)
      findings.push({
        ...parserFinding(
          'PLACEHOLDER_UNFILLED',
          '正文含未接受的修订或批注，请清理后重审',
        ),
        severity: 'high',
        blocking: true,
      });
    if (complex)
      findings.push(
        parserFinding(
          'DOCX_COMPLEX_CONTENT',
          '正文含嵌入对象、外部内容或文本框，需人工核验完整性',
        ),
      );
    if ((['footnotes', 'endnotes'] as const).map((part) => {
      const notes = xmls.get(`word/${part}.xml`);
      return notes !== undefined && hasAuxiliaryContent(notes, part);
    }).some(Boolean))
      findings.push(
        parserFinding(
          'DOCX_AUXILIARY_CONTENT',
          '正文含脚注或尾注，需人工核验附注内容',
        ),
      );
    const full = paragraphs.map((p) => p.text).join('\n');
    if (full.length > 200000)
      return empty(
        'DOCX_LIMIT',
        '正文超过 200000 字符，请分拆附件并人工核验',
        'failed',
      );
    return {
      text: full,
      paragraphs,
      channel: 'docx_native',
      status: full.length >= 80 ? 'ok' : 'degraded',
      findings,
      stats: {
        characters: full.length,
        paragraphCount: paragraphs.length,
        pages: page,
      },
    };
  } catch {
    return empty(
      'DOCX_INVALID',
      'DOCX 解析失败或解压超过安全上限，请核对正文',
      'failed',
    );
  }
}
const pdfResponse = z.object({
  ok: z.literal(true),
  pages: z
    .array(
      z.object({
        pageNo: z.number().int().positive(),
        text: z.string().max(200000),
        blocks: z.array(z.unknown()).optional(),
      }),
    )
    .min(1)
    .max(1000),
  isScanned: z.boolean().optional(),
});
export async function parseLegacyDoc(content: Buffer): Promise<ParsedDocument> {
  if (content.length > MAX_DOC_CONVERT_BYTES) {
    return empty('DOC_SIZE_EXCEEDED', '老版 DOC 文档超过 20MB 安全转换上限，已自动转人工复核', 'failed');
  }
  // WPS/Word 常见将 OOXML 正文直接命名为 .doc
  if (content.length >= 4 && content.readUInt32LE(0) === 0x04034b50) {
    const parsed = await parseDocx(content);
    return parsed.channel === 'docx_native' ? { ...parsed, channel: 'doc_converted' } : parsed;
  }
  if (content.length < 512 || !content.subarray(0, 8).equals(OLE2_MAGIC)) {
    return empty('LEGACY_DOC_UNSUPPORTED', '旧版 DOC 文件头损坏或非标准 OLE2 格式，请另存为 DOCX 或 PDF');
  }

  // 先在内存检查 OLE2 WordDocument FIB 加密位，避免加密文档进入外部转换器挂起
  try {
    const cfb = XLSX.CFB.read(content, { type: 'buffer' });
    const wordEntry = XLSX.CFB.find(cfb, '/WordDocument') ?? XLSX.CFB.find(cfb, 'WordDocument');
    if (!wordEntry || !wordEntry.content || wordEntry.content.length < 0x20) {
      return empty('DOC_ENCRYPTED_OR_INVALID', '老版 DOC 缺少有效 WordDocument 流，已自动转人工复核', 'failed');
    }
    const wordBuf = Buffer.from(wordEntry.content as Uint8Array);
    const fibFlags = wordBuf.readUInt16LE(0x0a);
    if ((fibFlags & 0x0100) !== 0) {
      return empty('DOC_ENCRYPTED_OR_INVALID', '老版 DOC 文档已加密，无法提取正文，已自动转人工复核', 'failed');
    }
  } catch {
    return empty('DOC_ENCRYPTED_OR_INVALID', '老版 DOC 容器结构损坏，已自动转人工复核', 'failed');
  }

  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'newfc-doc-conv-'));
  try {
    const inPath = path.join(tmpDir, 'input.doc');
    const outDir = path.join(tmpDir, 'out');
    const profileDir = path.join(tmpDir, 'profile');
    fs.mkdirSync(outDir, { mode: 0o700 });
    fs.mkdirSync(profileDir, { mode: 0o700 });
    fs.writeFileSync(inPath, content, { mode: 0o400 });

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
        'docx',
        '--outdir',
        outDir,
        inPath,
      ],
      {
        timeout: DOC_CONVERT_TIMEOUT_MS,
        maxBuffer: 4 * 1024 * 1024,
        env: {
          PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin',
          HOME: tmpDir,
          LANG: 'C.UTF-8',
        },
      },
    );

    const outDocxPath = path.join(outDir, 'input.docx');
    if (!fs.existsSync(outDocxPath)) {
      return empty('DOC_ENCRYPTED_OR_INVALID', '老版 DOC 未能转码为有效正文，已自动转人工复核', 'failed');
    }
    const stat = fs.statSync(outDocxPath);
    if (stat.size <= 0 || stat.size > 32 * 1024 * 1024) {
      return empty('DOC_SIZE_EXCEEDED', '老版 DOC 转码产物超出安全上限，已自动转人工复核', 'failed');
    }
    const docxBuf = fs.readFileSync(outDocxPath);
    const parsed = await parseDocx(docxBuf);
    if (parsed.channel === 'docx_native') {
      return {
        ...parsed,
        channel: 'doc_converted',
        stats: { ...parsed.stats, convertedFrom: 'doc' },
      };
    }
    return {
      ...parsed,
      channel: 'failed',
    };
  } catch {
    return empty('DOC_ENCRYPTED_OR_INVALID', '老版 DOC 转码超时或解析异常，已自动转人工复核', 'failed');
  } finally {
    try {
      fs.rmSync(tmpDir, { recursive: true });
    } catch {
      // ignore cleanup error
    }
  }
}

export async function parseContractDocument(
  db: DB,
  content: Buffer,
  name: string,
  sha: string,
): Promise<ParsedDocument> {
  const isDoc = legacyDoc(name, content);
  const docx = /\.docx$/i.test(name),
    pdf = /\.pdf$/i.test(name),
    image = /\.(png|jpe?g|tiff?|bmp|webp)$/i.test(name);
  const base = getSetting<string>(db, 'integration.pdf_parser_base_url');
  const kind = isDoc
    ? 'doc_converted'
    : docx
      ? 'docx_native'
      : pdf && base
        ? 'pdf_external_api'
        : 'ocr_fallback';
  const cache = db
    .prepare(
      'SELECT * FROM ct_doc_parse_cache WHERE file_sha256=? AND parser_kind=? AND parser_version=?',
    )
    .get(sha, kind, '3') as any;
  if (cache) return JSON.parse(cache.stats_json) as ParsedDocument;
  let result: ParsedDocument;
  if (isDoc) result = await parseLegacyDoc(content);
  else if (docx) result = await parseDocx(content);
  else if (pdf && base) {
    try {
      const form = new FormData();
      form.append(
        'file',
        new Blob([new Uint8Array(content)], { type: 'application/pdf' }),
        name,
      );
      const key = resolvePdfParserAuthKey(
        base,
        getSetting<string | null>(
          db,
          'integration.pdf_parser_api_key',
        ),
      );
      const body = pdfResponse.parse(
        await pdfServiceJson(
          base,
          form,
          key,
          getSetting<number>(db, 'integration.pdf_parser_timeout_seconds') *
            1000,
        ),
      );
      if (body.pages.some((p, i) => p.pageNo !== i + 1))
        throw new Error('PDF_PAGE_GAP');
      const totalBlocks = body.pages.reduce((sum, p) => sum + (Array.isArray(p.blocks) ? p.blocks.length : 0), 0);
      const paragraphs = body.pages.map((p, i) => ({
        index: i + 1,
        heading: '',
        text: p.text,
        page: p.pageNo,
        ...(Array.isArray(p.blocks) && p.blocks.length > 0 ? { blocks: p.blocks } : {}),
      }));
      const text = paragraphs.map((p) => p.text).join('\n');
      if (text.length > 200000) throw new Error('PDF_LIMIT');
      result = {
        text,
        paragraphs,
        channel: 'pdf_external_api',
        status:
          body.isScanned || paragraphs.some((p) => !p.text.trim())
            ? 'degraded'
            : 'ok',
        findings: [],
        stats: {
          characters: text.length,
          pages: paragraphs.length,
          ...(totalBlocks > 0 ? { blockCount: totalBlocks } : {}),
        },
      };
    } catch {
      result = empty(
        'PDF_PARSER_FAILED',
        'PDF 服务解析失败，请重试或人工核验',
        'failed',
      );
    }
  } else
    result = empty(
      pdf ? 'PDF_PARSER_UNCONFIGURED' : 'FORMAT_UNSUPPORTED',
      pdf ? 'PDF 解析接口未配置' : '正文格式不支持，请上传 DOCX 或 PDF',
    );
  if (
    (pdf || image) &&
    result.status !== 'ok' &&
    (!pdf || getSetting<boolean>(db, 'integration.pdf_fallback_ocr')) &&
    getSetting<string>(db, 'integration.ocr_base_url')
  ) {
    try {
      const o = await recognizeAttachment(
        {
          provider: getSetting(db, 'integration.ocr_provider'),
          baseUrl: getSetting(db, 'integration.ocr_base_url'),
          apiKey: getSetting(db, 'integration.ocr_api_key'),
          username: getSetting(db, 'integration.ocr_username'),
          password: getSetting(db, 'integration.ocr_password'),
          apiType: getSetting(db, 'integration.ocr_api_type'),
          timeoutSeconds: getSetting(db, 'integration.ocr_timeout_seconds'),
        },
        { name, content },
      );
      // OCR has no completeness/confidence protocol; never claim full reliable coverage.
      result = {
        text: o.text,
        paragraphs: (o.pages.length
          ? o.pages
          : [{ page: 1, text: o.text }]
        ).map((p, i) => ({
          index: i + 1,
          heading: '',
          page: p.page,
          text: p.text,
        })),
        channel: 'ocr_fallback',
        status: 'degraded',
        findings: [
          parserFinding(
            'OCR_COVERAGE_UNVERIFIED',
            'OCR 文字需逐页人工核对完整性',
          ),
        ],
        stats: { characters: o.text.length },
      };
    } catch {
      result = empty(
        'OCR_FAILED',
        'OCR 识别失败，请补充 DOCX 正文或人工核验',
        'failed',
      );
    }
  }
  if (result.status === 'ok' && result.text.length < 80) {
    result.status = 'degraded';
    result.findings.push(
      parserFinding('TEXT_EMPTY_OR_UNREADABLE', '正文不足以定位关键条款'),
    );
  }
  if (result.status === 'ok')
    db.prepare(
      'INSERT OR IGNORE INTO ct_doc_parse_cache(file_sha256,parser_kind,parser_version,text_content,paragraphs_json,stats_json,created_at) VALUES(?,?,?,?,?,?,?)',
    ).run(
      sha,
      kind,
      '3',
      result.text,
      JSON.stringify(result.paragraphs),
      JSON.stringify(result),
      new Date().toISOString(),
    );
  return result;
}
