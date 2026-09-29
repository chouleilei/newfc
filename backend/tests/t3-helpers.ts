/** T-3 HTTP 测试公共夹具:临时目录真实库 + 真实会话,文件上传与 JSON 请求。 */
import { afterEach } from 'vitest';
import fs from 'fs';
import os from 'os';
import path from 'path';
import type { Server } from 'http';
import { createApp } from '../src/server';
import { buildFixture } from './helpers';
import { ensureAdmin, fetchAs, sessionFor } from './http-helpers';

export type Session = ReturnType<typeof sessionFor>;

const cleanups: (() => Promise<void> | void)[] = [];
afterEach(async () => { while (cleanups.length) await cleanups.pop()!(); });

export async function boot(prefix = 'newfc-t3-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  const { app, holder } = await createApp({ dbPath: path.join(dir, 'newfc.sqlite') });
  const server: Server = app.listen(0);
  const base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  cleanups.push(async () => {
    await new Promise<void>((r) => server.close(() => r()));
    try { holder.getDb().close(); } catch { /* closed */ }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const db = holder.getDb();
  const admin = sessionFor(db, ensureAdmin(db));
  const fx = buildFixture(db);
  return { base, db, dir, admin, fx };
}

export async function upload(base: string, s: Session, url: string, content: Buffer, name: string, fields: Record<string, string> = {}) {
  const form = new FormData();
  for (const [k, v] of Object.entries(fields)) form.append(k, v);
  form.append('file', new Blob([new Uint8Array(content)]), name);
  return fetchAs(s, `${base}${url}`, { method: 'POST', body: form });
}

export const post = (base: string, s: Session, url: string, body: unknown = {}) =>
  fetchAs(s, `${base}${url}`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
export const get = (base: string, s: Session, url: string) => fetchAs(s, `${base}${url}`);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const json = async (res: Response | Promise<Response>): Promise<any> => (await res).json();

export const EAS_V600_DIR = path.join(__dirname, 'fixtures', 'eas-v600');
export const easSample = (name: string) => fs.readFileSync(path.join(EAS_V600_DIR, name));
export const EAS_V600 = [['voucher', 'eas_voucher.csv'], ['balance', 'eas_balance.csv'], ['auxiliary', 'eas_auxiliary.csv']] as const;
