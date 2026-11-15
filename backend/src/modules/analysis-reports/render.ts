/**
 * 分析报告渲染(AC-F18):同一份文档模型渲染 DOCX 与 PDF,段落文本序列一致。
 *
 * - DOCX:jszip 手写 OOXML(document/styles/header),固定 zip 时间戳,同输入字节一致;草稿水印放在页眉(不进正文段落)。
 * - PDF:手写 PDF 1.4,字体为 Adobe-GB1 预置 STSong-Light(Type0 + UniGB-UCS2-H),不嵌入字体、不依赖系统字体;
 *   内容流不压缩,每个段落块前写注释 `%P <序号>`,水印块写 `%W`,便于核对段落序列。
 *   宽度按 CID 宽度估算:ASCII 半角 500,其余 1000(/W [1 95 500],/DW 1000)。
 */
import JSZip from 'jszip';

export interface RenderTableMerge {
  row: number;
  col: number;
  rowSpan?: number;
  colSpan?: number;
}
export interface RenderTableSection {
  headers: string[];
  colWidths?: number[];
  rows: (string | number | null)[][];
  merges?: RenderTableMerge[];
}
export interface RenderRedHead {
  issuer: string;
  docNo: string;
  signOff: string;
  issueDate: string;
}
export interface RenderSection {
  title: string;
  body: string;
  table?: RenderTableSection;
}
export interface RenderDoc {
  title: string;
  meta: string[];
  sections: RenderSection[];
  watermark?: string | null;
  redHead?: RenderRedHead | null;
}
type Para = { text: string; style: 'title' | 'meta' | 'heading' | 'body' };

/** 文档模型 → 段落序列(DOCX 与 PDF 共用)。正文按换行拆段,空行忽略。 */
export function paragraphsOf(doc: RenderDoc): Para[] {
  const out: Para[] = [{ text: doc.title, style: 'title' }];
  for (const m of doc.meta) out.push({ text: m, style: 'meta' });
  for (const s of doc.sections) {
    out.push({ text: s.title, style: 'heading' });
    for (const line of s.body.split(/\r?\n/)) if (line.trim()) out.push({ text: line.trimEnd(), style: 'body' });
  }
  return out.map((p) => ({ ...p, text: normalizeText(p.text) }));
}

/** 去掉 XML 不允许的控制字符;BMP 以外字符(UCS-2 无法表示)替换为 ?。 */
function normalizeText(s: string): string {
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f￾￿]/g, '').replace(/\t/g, '  ').replace(/[\ud800-\udbff][\udc00-\udfff]|[\ud800-\udfff]/g, '?');
}

/* ================= DOCX ================= */

const xmlEscape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
const FIXED_DATE = new Date('2000-01-01T00:00:00Z');

const STYLE_RUN: Record<Para['style'], string> = {
  title: '<w:b/><w:sz w:val="36"/>',
  meta: '<w:color w:val="666666"/><w:sz w:val="20"/>',
  heading: '<w:b/><w:sz w:val="28"/>',
  body: '<w:sz w:val="22"/>',
};
const STYLE_PARA: Record<Para['style'], string> = {
  title: '<w:jc w:val="center"/><w:spacing w:after="240"/>',
  meta: '<w:jc w:val="center"/>',
  heading: '<w:spacing w:before="240" w:after="120"/>',
  body: '<w:spacing w:after="80"/>',
};

const PRINTABLE_WIDTH_DXA = 9638;

function colIndexToWidths(colCount: number, customWidths?: number[]): number[] {
  if (colCount <= 0) return [];
  if (customWidths && customWidths.length === colCount) {
    const sum = customWidths.reduce((a, b) => a + Math.max(200, Math.trunc(b)), 0);
    if (sum > 0) {
      const scaled = customWidths.map((w) => Math.max(400, Math.round((Math.max(200, w) / sum) * PRINTABLE_WIDTH_DXA)));
      const diff = PRINTABLE_WIDTH_DXA - scaled.reduce((a, b) => a + b, 0);
      scaled[scaled.length - 1] += diff;
      return scaled;
    }
  }
  const base = Math.floor(PRINTABLE_WIDTH_DXA / colCount);
  const arr = new Array<number>(colCount).fill(base);
  arr[colCount - 1] += PRINTABLE_WIDTH_DXA - base * colCount;
  return arr;
}

function renderDocxTableXml(table: RenderTableSection, fontXml: string): string {
  const colCount = Math.max(table.headers.length, ...table.rows.map((r) => r.length), 1);
  const widths = colIndexToWidths(colCount, table.colWidths);
  const gridCols = widths.map((w) => `<w:gridCol w:w="${w}"/>`).join('');
  const borders = [
    '<w:top w:val="single" w:sz="4" w:space="0" w:color="333333"/>',
    '<w:left w:val="single" w:sz="4" w:space="0" w:color="333333"/>',
    '<w:bottom w:val="single" w:sz="4" w:space="0" w:color="333333"/>',
    '<w:right w:val="single" w:sz="4" w:space="0" w:color="333333"/>',
    '<w:insideH w:val="single" w:sz="4" w:space="0" w:color="666666"/>',
    '<w:insideV w:val="single" w:sz="4" w:space="0" w:color="666666"/>',
  ].join('');
  const tblPr = `<w:tblPr><w:tblW w:w="${PRINTABLE_WIDTH_DXA}" w:type="dxa"/><w:tblLayout w:type="fixed"/><w:tblBorders>${borders}</w:tblBorders></w:tblPr>`;

  // Build merge lookup on data rows (0-indexed within table.rows)
  const skipHorizontal = new Set<string>();
  const hSpan = new Map<string, number>();
  const vMergeMode = new Map<string, 'restart' | 'continue'>();
  for (const m of table.merges ?? []) {
    const cs = Math.max(1, m.colSpan ?? 1);
    const rs = Math.max(1, m.rowSpan ?? 1);
    for (let dr = 0; dr < rs; dr++) {
      const rIdx = m.row + dr;
      if (cs > 1) {
        hSpan.set(`${rIdx}:${m.col}`, cs);
        for (let dc = 1; dc < cs; dc++) skipHorizontal.add(`${rIdx}:${m.col + dc}`);
      }
      if (rs > 1) {
        vMergeMode.set(`${rIdx}:${m.col}`, dr === 0 ? 'restart' : 'continue');
      }
    }
  }

  const headerCells = Array.from({ length: colCount }, (_, cIdx) => {
    const text = normalizeText(String(table.headers[cIdx] ?? ''));
    return `<w:tc><w:tcPr><w:tcW w:w="${widths[cIdx]}" w:type="dxa"/><w:shd w:val="clear" w:color="auto" w:fill="F2F2F2"/></w:tcPr><w:p><w:pPr><w:jc w:val="center"/><w:spacing w:after="40"/></w:pPr><w:r><w:rPr>${fontXml}<w:b/><w:sz w:val="18"/></w:rPr><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p></w:tc>`;
  }).join('');
  const headerTr = `<w:tr><w:trPr><w:tblHeader/><w:cantSplit/></w:trPr>${headerCells}</w:tr>`;

  const bodyTrs = table.rows.map((row, rIdx) => {
    const cells: string[] = [];
    for (let cIdx = 0; cIdx < colCount; cIdx++) {
      const key = `${rIdx}:${cIdx}`;
      if (skipHorizontal.has(key)) continue;
      const span = hSpan.get(key) ?? 1;
      const cellWidth = widths.slice(cIdx, cIdx + span).reduce((a, b) => a + b, 0);
      const vm = vMergeMode.get(key);
      const rawVal = row[cIdx];
      const text = vm === 'continue' ? '' : normalizeText(rawVal === null || rawVal === undefined ? '' : String(rawVal));
      const isNumericLike = /^[-+]?\d[\d,]*(\.\d+)?%?$/.test(text.trim());
      const align = isNumericLike ? 'right' : cIdx === 0 ? 'center' : 'left';
      const tcPr = `<w:tcPr><w:tcW w:w="${cellWidth}" w:type="dxa"/>${span > 1 ? `<w:gridSpan w:val="${span}"/>` : ''}${vm === 'restart' ? '<w:vMerge w:val="restart"/>' : vm === 'continue' ? '<w:vMerge/>' : ''}</w:tcPr>`;
      cells.push(`<w:tc>${tcPr}<w:p><w:pPr><w:jc w:val="${align}"/><w:spacing w:after="30"/></w:pPr><w:r><w:rPr>${fontXml}<w:sz w:val="18"/></w:rPr><w:t xml:space="preserve">${xmlEscape(text)}</w:t></w:r></w:p></w:tc>`);
    }
    return `<w:tr><w:trPr><w:cantSplit/></w:trPr>${cells.join('')}</w:tr>`;
  }).join('');

  return `<w:tbl>${tblPr}<w:tblGrid>${gridCols}</w:tblGrid>${headerTr}${bodyTrs}</w:tbl>`;
}

export async function renderDocx(doc: RenderDoc): Promise<Buffer> {
  const font = '<w:rFonts w:ascii="SimSun" w:hAnsi="SimSun" w:eastAsia="宋体"/>';
  const hasStructuredAdditions = Boolean(doc.redHead) || doc.sections.some((s) => Boolean(s.table));
  const paras = paragraphsOf(doc);
  let body: string;
  if (!hasStructuredAdditions) {
    body = paras.map((p) => `<w:p><w:pPr>${STYLE_PARA[p.style]}</w:pPr><w:r><w:rPr>${font}${STYLE_RUN[p.style]}</w:rPr><w:t xml:space="preserve">${xmlEscape(p.text)}</w:t></w:r></w:p>`).join('');
  } else {
    const parts: string[] = [];
    if (doc.redHead) {
      parts.push(`<w:p><w:pPr><w:jc w:val="center"/><w:spacing w:after="120"/></w:pPr><w:r><w:rPr>${font}<w:b/><w:color w:val="CC0000"/><w:sz w:val="44"/></w:rPr><w:t xml:space="preserve">${xmlEscape(normalizeText(doc.redHead.issuer))}</w:t></w:r></w:p>`);
      parts.push(`<w:p><w:pPr><w:jc w:val="center"/><w:pBdr><w:bottom w:val="single" w:sz="12" w:space="6" w:color="CC0000"/></w:pBdr><w:spacing w:after="200"/></w:pPr><w:r><w:rPr>${font}<w:sz w:val="24"/></w:rPr><w:t xml:space="preserve">${xmlEscape(normalizeText(doc.redHead.docNo))}</w:t></w:r></w:p>`);
    }
    parts.push(`<w:p><w:pPr>${STYLE_PARA.title}</w:pPr><w:r><w:rPr>${font}${STYLE_RUN.title}</w:rPr><w:t xml:space="preserve">${xmlEscape(normalizeText(doc.title))}</w:t></w:r></w:p>`);
    for (const m of doc.meta) {
      parts.push(`<w:p><w:pPr>${STYLE_PARA.meta}</w:pPr><w:r><w:rPr>${font}${STYLE_RUN.meta}</w:rPr><w:t xml:space="preserve">${xmlEscape(normalizeText(m))}</w:t></w:r></w:p>`);
    }
    for (const s of doc.sections) {
      if (s.title.trim()) {
        parts.push(`<w:p><w:pPr>${STYLE_PARA.heading}</w:pPr><w:r><w:rPr>${font}${STYLE_RUN.heading}</w:rPr><w:t xml:space="preserve">${xmlEscape(normalizeText(s.title))}</w:t></w:r></w:p>`);
      }
      for (const line of s.body.split(/\r?\n/)) {
        if (line.trim()) {
          parts.push(`<w:p><w:pPr>${STYLE_PARA.body}</w:pPr><w:r><w:rPr>${font}${STYLE_RUN.body}</w:rPr><w:t xml:space="preserve">${xmlEscape(normalizeText(line.trimEnd()))}</w:t></w:r></w:p>`);
        }
      }
      if (s.table && s.table.headers.length > 0) {
        parts.push(renderDocxTableXml(s.table, font));
      }
    }
    if (doc.redHead && (doc.redHead.signOff || doc.redHead.issueDate)) {
      if (doc.redHead.signOff) {
        parts.push(`<w:p><w:pPr><w:jc w:val="right"/><w:spacing w:before="240" w:after="60"/></w:pPr><w:r><w:rPr>${font}<w:sz w:val="24"/></w:rPr><w:t xml:space="preserve">${xmlEscape(normalizeText(doc.redHead.signOff))}</w:t></w:r></w:p>`);
      }
      if (doc.redHead.issueDate) {
        parts.push(`<w:p><w:pPr><w:jc w:val="right"/><w:spacing w:after="120"/></w:pPr><w:r><w:rPr>${font}<w:sz w:val="24"/></w:rPr><w:t xml:space="preserve">${xmlEscape(normalizeText(doc.redHead.issueDate))}</w:t></w:r></w:p>`);
      }
    }
    body = parts.join('');
  }
  const hasWatermark = !!doc.watermark;
  const sect = `<w:sectPr>${hasWatermark ? '<w:headerReference w:type="default" r:id="rIdHeader1"/>' : ''}<w:pgSz w:w="11906" w:h="16838"/><w:pgMar w:top="1134" w:right="1134" w:bottom="1134" w:left="1134" w:header="567" w:footer="567" w:gutter="0"/></w:sectPr>`;
  const NS = 'xmlns:w="http://schemas.openxmlformats.org/wordprocessingml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"';
  const zip = new JSZip();
  const add = (name: string, content: string) => zip.file(name, content, { date: FIXED_DATE, createFolders: false });
  add('[Content_Types].xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"><Default Extension="rels" ContentType="application/vnd.openxmlformats-package.relationships+xml"/><Default Extension="xml" ContentType="application/xml"/><Override PartName="/word/document.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.document.main+xml"/>${hasWatermark ? '<Override PartName="/word/header1.xml" ContentType="application/vnd.openxmlformats-officedocument.wordprocessingml.header+xml"/>' : ''}</Types>`);
  add('_rels/.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="word/document.xml"/></Relationships>`);
  add('word/_rels/document.xml.rels', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">${hasWatermark ? '<Relationship Id="rIdHeader1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/header" Target="header1.xml"/>' : ''}</Relationships>`);
  add('word/document.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:document ${NS}><w:body>${body}${sect}</w:body></w:document>`);
  if (hasWatermark) {
    add('word/header1.xml', `<?xml version="1.0" encoding="UTF-8" standalone="yes"?>
<w:hdr ${NS}><w:p><w:pPr><w:jc w:val="center"/></w:pPr><w:r><w:rPr>${font}<w:b/><w:color w:val="C0C0C0"/><w:sz w:val="48"/></w:rPr><w:t xml:space="preserve">${xmlEscape(doc.watermark!)}</w:t></w:r></w:p></w:hdr>`);
  }
  return zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE', compressionOptions: { level: 6 } });
}

/** 从 DOCX 正文(document.xml)提取段落文本序列。 */
export async function docxParagraphs(buf: Buffer): Promise<string[]> {
  const zip = await JSZip.loadAsync(buf);
  const xml = await zip.file('word/document.xml')!.async('string');
  const unescape = (s: string) => s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&amp;/g, '&');
  return [...xml.matchAll(/<w:p>([\s\S]*?)<\/w:p>/g)].map((m) => [...m[1].matchAll(/<w:t[^>]*>([\s\S]*?)<\/w:t>/g)].map((t) => unescape(t[1])).join(''));
}

/* ================= PDF ================= */

const PAGE_W = 595.28; const PAGE_H = 841.89; const MARGIN = 56;
const SIZE: Record<Para['style'], number> = { title: 18, meta: 9.5, heading: 13, body: 10.5 };
const GAP_AFTER: Record<Para['style'], number> = { title: 10, meta: 2, heading: 6, body: 3 };

const charUnits = (c: string) => (c.charCodeAt(0) >= 0x20 && c.charCodeAt(0) < 0x7f ? 500 : 1000);
const hex = (s: string) => [...s].map((c) => c.charCodeAt(0).toString(16).padStart(4, '0')).join('').toUpperCase();

function wrap(text: string, size: number, maxWidth: number): string[] {
  const lines: string[] = [];
  let cur = ''; let w = 0;
  for (const c of text) {
    const cw = (charUnits(c) * size) / 1000;
    if (cur && w + cw > maxWidth) { lines.push(cur); cur = ''; w = 0; }
    cur += c; w += cw;
  }
  lines.push(cur);
  return lines;
}

export function renderPdf(doc: RenderDoc): Buffer {
  const paras = paragraphsOf(doc);
  const maxWidth = PAGE_W - MARGIN * 2;
  const pages: string[][] = [[]];
  let y = PAGE_H - MARGIN;
  const newPage = () => { pages.push([]); y = PAGE_H - MARGIN; };
  paras.forEach((p, index) => {
    const size = SIZE[p.style]; const lead = size * 1.6;
    const lines = wrap(p.text, size, maxWidth);
    let i = 0;
    while (i < lines.length) {
      if (y - lead < MARGIN) newPage();
      const room = Math.max(1, Math.floor((y - MARGIN) / lead));
      const chunk = lines.slice(i, i + room);
      const x = p.style === 'title' || p.style === 'meta'
        ? Math.max(MARGIN, (PAGE_W - (chunk[0].length ? [...chunk[0]].reduce((s, c) => s + (charUnits(c) * size) / 1000, 0) : 0)) / 2) : MARGIN;
      const ops = [`%P ${index}`, `BT /F1 ${size} Tf ${fmt(lead)} TL ${fmt(x)} ${fmt(y - size)} Td`];
      chunk.forEach((line, k) => ops.push(`${k ? 'T* ' : ''}<${hex(line)}> Tj`));
      ops.push('ET');
      pages[pages.length - 1].push(ops.join('\n'));
      y -= lead * chunk.length;
      i += chunk.length;
    }
    y -= GAP_AFTER[p.style];
  });
  const watermark = doc.watermark
    ? `%W\nq 0.82 g BT /F1 110 Tf 0.7071 0.7071 -0.7071 0.7071 ${fmt(PAGE_W / 2 - 40)} ${fmt(PAGE_H / 2 - 160)} Tm <${hex(doc.watermark)}> Tj ET Q` : null;

  const objects: string[] = [];
  const add = (body: string) => { objects.push(body); return objects.length; };
  const catalog = add(''); const pagesObj = add('');
  const font = add(''); const cidFont = add(''); const descriptor = add('');
  objects[font - 1] = `<< /Type /Font /Subtype /Type0 /BaseFont /STSong-Light /Encoding /UniGB-UCS2-H /DescendantFonts [${cidFont} 0 R] >>`;
  objects[cidFont - 1] = `<< /Type /Font /Subtype /CIDFontType0 /BaseFont /STSong-Light /CIDSystemInfo << /Registry (Adobe) /Ordering (GB1) /Supplement 2 >> /FontDescriptor ${descriptor} 0 R /DW 1000 /W [1 95 500] >>`;
  objects[descriptor - 1] = '<< /Type /FontDescriptor /FontName /STSong-Light /Flags 6 /FontBBox [-25 -254 1000 880] /ItalicAngle 0 /Ascent 880 /Descent -120 /CapHeight 880 /StemV 93 >>';
  const pageIds: number[] = [];
  for (const blocks of pages) {
    const content = [watermark, ...blocks].filter(Boolean).join('\n');
    const len = Buffer.byteLength(content, 'latin1');
    const contentId = add(`<< /Length ${len} >>\nstream\n${content}\nendstream`);
    pageIds.push(add(`<< /Type /Page /Parent ${pagesObj} 0 R /MediaBox [0 0 ${PAGE_W} ${PAGE_H}] /Resources << /Font << /F1 ${font} 0 R >> >> /Contents ${contentId} 0 R >>`));
  }
  objects[catalog - 1] = `<< /Type /Catalog /Pages ${pagesObj} 0 R >>`;
  objects[pagesObj - 1] = `<< /Type /Pages /Kids [${pageIds.map((i) => `${i} 0 R`).join(' ')}] /Count ${pageIds.length} >>`;
  const info = add(`<< /Producer (newfc) /Title <FEFF${hex(normalizeText(doc.title))}> >>`);

  let out = '%PDF-1.4\n%\xE2\xE3\xCF\xD3\n';
  const offsets: number[] = [];
  objects.forEach((body, i) => { offsets.push(Buffer.byteLength(out, 'latin1')); out += `${i + 1} 0 obj\n${body}\nendobj\n`; });
  const xref = Buffer.byteLength(out, 'latin1');
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n${offsets.map((o) => `${String(o).padStart(10, '0')} 00000 n \n`).join('')}`;
  out += `trailer\n<< /Size ${objects.length + 1} /Root ${catalog} 0 R /Info ${info} 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, 'latin1');
}

const fmt = (n: number) => (Math.round(n * 100) / 100).toString();

/** 从 PDF 内容流提取段落文本序列(按 %P 序号合并跨页段落;忽略 %W 水印块)。 */
export function pdfParagraphs(buf: Buffer): string[] {
  const text = buf.toString('latin1');
  const byIndex = new Map<number, string>();
  for (const m of text.matchAll(/%P (\d+)\nBT[^\n]*\n([\s\S]*?)\nET/g)) {
    const idx = Number(m[1]);
    const s = [...m[2].matchAll(/<([0-9A-F]*)> Tj/g)].map((h) => {
      let r = '';
      for (let i = 0; i < h[1].length; i += 4) r += String.fromCharCode(parseInt(h[1].slice(i, i + 4), 16));
      return r;
    }).join('');
    byIndex.set(idx, (byIndex.get(idx) ?? '') + s);
  }
  return [...byIndex.entries()].sort((a, b) => a[0] - b[0]).map(([, s]) => s);
}
