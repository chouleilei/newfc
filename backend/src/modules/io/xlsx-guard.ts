import JSZip, { type JSZipObject } from 'jszip';
import { Errors } from '../../core/errors';

const MIN_XML_BYTES = 64 * 1024 * 1024;
const MAX_XML_BYTES = 512 * 1024 * 1024;

/**
 * 在 ExcelJS 建立完整对象图前流式扫描工作表 XML。这样超大/高压缩比 xlsx 会在
 * 达到行数或解压字节上限时立即中止，而不是先消耗数秒和数 GB 内存再报错。
 */
export async function assertSafeXlsx(buffer: Buffer, maxDataRows: number, maxWorksheets = 1): Promise<void> {
  if (!buffer.length) throw Errors.validation('上传文件为空');
  // 魔数校验:xlsx 即 ZIP,本地文件头签名必须是 PK\x03\x04(空包 PK\x05\x06 同样放行由 JSZip 拒绝)
  if (buffer.length < 4 || (buffer.readUInt32LE(0) !== 0x04034b50 && buffer.readUInt32LE(0) !== 0x06054b50)) {
    throw Errors.validation('不是有效的 xlsx 文件');
  }
  let archive: JSZip;
  try {
    archive = await JSZip.loadAsync(buffer, { checkCRC32: false });
  } catch {
    throw Errors.validation('不是有效的 xlsx 文件');
  }

  const worksheets = Object.values(archive.files)
    .filter((entry) => !entry.dir && /^xl\/worksheets\/sheet\d+\.xml$/i.test(entry.name));
  const rowLimit = maxDataRows * maxWorksheets + 1_000;
  const xmlByteLimit = Math.min(MAX_XML_BYTES, Math.max(MIN_XML_BYTES, maxDataRows * 4_096));
  let rows = 0;
  let xmlBytes = 0;

  /* sharedStrings.xml 不属 worksheet,原扫描漏掉了它——10MB 高压缩文件可构造少量行
     但巨大共享字符串表,绕过字节上限把 ExcelJS 字符串表撑爆。与工作表共用同一
     解压字节上限(计入同一 xmlBytes 总量),先扫它再扫工作表。 */
  const sharedStrings = Object.values(archive.files)
    .filter((entry) => !entry.dir && /^xl\/sharedStrings\.xml$/i.test(entry.name));
  for (const entry of sharedStrings) {
    await scanWorksheet(entry, (chunk) => {
      xmlBytes += chunk.length;
      if (xmlBytes > xmlByteLimit) {
        throw Errors.validation(`Excel 解压后内容超过安全上限 ${Math.round(xmlByteLimit / 1024 / 1024)}MB`);
      }
      return chunk;
    }, () => { /* sharedStrings 不计入行数上限 */ });
  }

  for (const worksheet of worksheets) {
    let worksheetRows = 0;
    await scanWorksheet(worksheet, (chunk) => {
      xmlBytes += chunk.length;
      if (xmlBytes > xmlByteLimit) {
        throw Errors.validation(`Excel 解压后内容超过安全上限 ${Math.round(xmlByteLimit / 1024 / 1024)}MB`);
      }
      return chunk;
    }, (count) => {
      worksheetRows += count;
      rows += count;
      // 上限按数据行计,另留 1 行表头:否则恰好 maxDataRows 行数据的标准模板会被误拒(与解析层口径不一致)
      if (worksheetRows > maxDataRows + 1) throw Errors.validation(`Excel 单个工作表数据行超过安全上限 ${maxDataRows} 行(不含表头)`);
      if (rows > rowLimit) throw Errors.validation(`Excel 工作簿总行数超过安全上限 ${maxDataRows * maxWorksheets}`);
    });
  }
}

async function scanWorksheet(
  worksheet: JSZipObject,
  inspectChunk: (chunk: Buffer) => Buffer,
  addRows: (count: number) => void,
): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const stream = worksheet.nodeStream('nodebuffer') as NodeJS.ReadableStream & { destroy(error?: Error): void };
    let tail = '';
    let settled = false;
    const fail = (error: unknown) => {
      if (settled) return;
      settled = true;
      stream.destroy();
      reject(error);
    };
    stream.on('data', (raw: Buffer) => {
      try {
        const chunk = inspectChunk(raw);
        const content = tail + chunk.toString('utf8');
        const count = content.match(/<row(?=[\s>])/g)?.length ?? 0;
        if (count) addRows(count);
        // 4 字符足以保留跨 chunk 的“<row”，又不会重复计数已带分隔符的完整标签。
        tail = content.slice(-4);
      } catch (error) {
        fail(error);
      }
    });
    stream.on('error', fail);
    stream.on('end', () => {
      if (settled) return;
      settled = true;
      resolve();
    });
  });
}
