/** 新领域上传/下载的公共 HTTP 辅助:内存上传(大小上限与继承导入一致)、UTF-8 文件名纠正、附件响应头。 */
import path from 'path';
import type { Response } from 'express';
import multer from 'multer';
import { AppError } from '../../core/errors';
import { MAX_UPLOAD_BYTES } from '../io/import-limits';

/** Node multipart 生态常把 filename 的 UTF-8 字节按 latin1 解码;只在全部字符可逆时纠正。 */
export function uploadName(value: string): string {
  if (!value || [...value].some((char) => char.charCodeAt(0) > 255)) return value;
  const decoded = Buffer.from(value, 'latin1').toString('utf8');
  return decoded.includes('\uFFFD') ? value : decoded;
}

export function memoryUpload(extensions: string[]): multer.Multer {
  return multer({
    storage: multer.memoryStorage(),
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 1 },
    fileFilter: (_req, file, cb) => {
      if (extensions.includes(path.extname(uploadName(file.originalname)).toLowerCase())) cb(null, true);
      else cb(new AppError('VALIDATION_FAILED', `仅支持 ${extensions.join(' / ')} 文件`, 400));
    },
  });
}

export function sendAttachment(res: Response, fileName: string, contentType: string, content: Buffer): void {
  const ascii = fileName.replace(/[^\x20-\x7e]/g, '_').replace(/["\\]/g, '_');
  res.setHeader('Content-Type', contentType);
  res.setHeader('Content-Disposition', `attachment; filename="${ascii}"; filename*=UTF-8''${encodeURIComponent(fileName)}`);
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.send(content);
}
