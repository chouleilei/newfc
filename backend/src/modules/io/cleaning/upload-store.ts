import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { Errors } from '../../../core/errors';
import { CLEANING_UPLOAD_CAPACITY_BYTES, CLEANING_UPLOAD_TTL_MS } from '../import-limits';

export interface CleaningUploadMetadata {
  token: string;
  originalName: string;
  sha256: string;
  uploadedAt: string;
  lastActiveAt: string;
  size: number;
}

interface StoreOptions {
  ttlMs?: number;
  capacityBytes?: number;
  now?: () => number;
}

const TOKEN_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

export class CleaningUploadStore {
  private readonly ttlMs: number;
  private readonly capacityBytes: number;
  private readonly now: () => number;

  constructor(public readonly directory: string, options: StoreOptions = {}) {
    this.ttlMs = options.ttlMs ?? CLEANING_UPLOAD_TTL_MS;
    this.capacityBytes = options.capacityBytes ?? CLEANING_UPLOAD_CAPACITY_BYTES;
    this.now = options.now ?? Date.now;
  }

  initialize(): void {
    fs.mkdirSync(this.directory, { recursive: true });
    this.cleanup();
  }

  private assertToken(token: string): void {
    if (!TOKEN_RE.test(token)) throw Errors.notFound('临时文件');
  }

  private xlsxPath(token: string): string { return path.join(this.directory, `${token}.xlsx`); }
  private sidecarPath(token: string): string { return path.join(this.directory, `${token}.json`); }

  private removePaths(token: string): void {
    for (const file of [this.xlsxPath(token), this.sidecarPath(token)]) {
      try { fs.unlinkSync(file); } catch (error) { if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error; }
    }
  }

  private parseMetadata(token: string): CleaningUploadMetadata | undefined {
    try {
      const parsed = JSON.parse(fs.readFileSync(this.sidecarPath(token), 'utf8')) as Partial<CleaningUploadMetadata>;
      if (parsed.token !== token || typeof parsed.originalName !== 'string' || !/^[0-9a-f]{64}$/i.test(String(parsed.sha256 ?? ''))
        || typeof parsed.uploadedAt !== 'string' || !Number.isFinite(Date.parse(parsed.uploadedAt))
        || typeof parsed.lastActiveAt !== 'string' || !Number.isFinite(Date.parse(parsed.lastActiveAt))
        || !Number.isSafeInteger(parsed.size) || (parsed.size ?? 0) < 0) return undefined;
      const stat = fs.statSync(this.xlsxPath(token));
      if (!stat.isFile() || stat.size !== parsed.size) return undefined;
      return parsed as CleaningUploadMetadata;
    } catch {
      return undefined;
    }
  }

  private writeMetadata(metadata: CleaningUploadMetadata): void {
    const target = this.sidecarPath(metadata.token);
    const temporary = path.join(this.directory, `.${metadata.token}.${crypto.randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temporary, JSON.stringify(metadata), { encoding: 'utf8', flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, target);
    } finally {
      try { fs.unlinkSync(temporary); } catch { /* rename 后临时文件已不存在 */ }
    }
  }

  put(originalName: string, buffer: Buffer): CleaningUploadMetadata {
    this.initialize();
    const token = crypto.randomUUID();
    const now = new Date(this.now()).toISOString();
    const metadata: CleaningUploadMetadata = {
      token,
      originalName: originalName.trim().slice(0, 255) || 'workbook.xlsx',
      sha256: crypto.createHash('sha256').update(buffer).digest('hex'),
      uploadedAt: now,
      lastActiveAt: now,
      size: buffer.length,
    };
    const xlsx = this.xlsxPath(token);
    const temporary = path.join(this.directory, `.${token}.${crypto.randomUUID()}.tmp`);
    try {
      fs.writeFileSync(temporary, buffer, { flag: 'wx', mode: 0o600 });
      fs.renameSync(temporary, xlsx);
      this.writeMetadata(metadata);
      this.cleanup(token);
      return metadata;
    } catch (error) {
      try { fs.unlinkSync(temporary); } catch { /* ignore */ }
      this.removePaths(token);
      throw error;
    }
  }

  get(token: string, touch = true): { metadata: CleaningUploadMetadata; buffer: Buffer } {
    this.assertToken(token);
    const metadata = this.parseMetadata(token);
    if (!metadata) {
      this.removePaths(token);
      throw Errors.notFound('临时文件');
    }
    if (this.now() - Date.parse(metadata.lastActiveAt) >= this.ttlMs) {
      this.removePaths(token);
      throw Errors.notFound('临时文件（已过期，请重新上传）');
    }
    if (touch) {
      metadata.lastActiveAt = new Date(this.now()).toISOString();
      this.writeMetadata(metadata);
    }
    this.cleanup(token);
    try {
      return { metadata, buffer: fs.readFileSync(this.xlsxPath(token)) };
    } catch {
      this.removePaths(token);
      throw Errors.notFound('临时文件');
    }
  }

  remove(token: string): void {
    this.assertToken(token);
    this.removePaths(token);
  }

  /** 只读校验临时文件仍存在且未过期(不读取正文,不做清理);touch=true 时刷新滑动 TTL。无效返回 undefined。 */
  peek(token: string, touch = false): CleaningUploadMetadata | undefined {
    if (!TOKEN_RE.test(token)) return undefined;
    const metadata = this.parseMetadata(token);
    if (!metadata) return undefined;
    if (this.now() - Date.parse(metadata.lastActiveAt) >= this.ttlMs) return undefined;
    if (touch) {
      metadata.lastActiveAt = new Date(this.now()).toISOString();
      this.writeMetadata(metadata);
    }
    return metadata;
  }

  /** 清损坏/孤立/过期文件，并在软上限外按最久未活跃优先淘汰。 */
  cleanup(protectedToken?: string): { removed: number; remainingBytes: number } {
    fs.mkdirSync(this.directory, { recursive: true });
    const names = fs.readdirSync(this.directory);
    const tokens = new Set<string>();
    let removed = 0;
    for (const name of names) {
      const match = /^([0-9a-f-]{36})\.(xlsx|json)$/i.exec(name);
      if (match && TOKEN_RE.test(match[1])) tokens.add(match[1]);
      else if (name.endsWith('.tmp')) {
        try { fs.unlinkSync(path.join(this.directory, name)); removed++; } catch { /* ignore */ }
      }
    }
    const valid: CleaningUploadMetadata[] = [];
    for (const token of tokens) {
      const metadata = this.parseMetadata(token);
      if (!metadata || (token !== protectedToken && this.now() - Date.parse(metadata.lastActiveAt) >= this.ttlMs)) {
        this.removePaths(token);
        removed++;
      } else valid.push(metadata);
    }
    // 没有成对 sidecar 的 xlsx/json 也清理；只触碰专用目录中的这两类文件。
    for (const name of fs.readdirSync(this.directory)) {
      const match = /^([0-9a-f-]{36})\.(xlsx|json)$/i.exec(name);
      if (!match || !TOKEN_RE.test(match[1])) continue;
      if (!valid.some((item) => item.token === match[1])) {
        try { fs.unlinkSync(path.join(this.directory, name)); removed++; } catch { /* ignore */ }
      }
    }
    let total = valid.reduce((sum, item) => sum + item.size, 0);
    const oldest = valid.filter((item) => item.token !== protectedToken)
      .sort((a, b) => Date.parse(a.lastActiveAt) - Date.parse(b.lastActiveAt));
    for (const item of oldest) {
      if (total <= this.capacityBytes) break;
      this.removePaths(item.token);
      total -= item.size;
      removed++;
    }
    return { removed, remainingBytes: total };
  }
}
