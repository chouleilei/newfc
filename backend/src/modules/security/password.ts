import crypto from 'crypto';
import { AppError } from '../../core/errors';

/** 口令哈希:scrypt(N=2^15,r=8,p=1),格式 scrypt$N$r$p$salt(b64)$hash(b64)。 */

const N = 32768;
const R = 8;
const P = 1;
const KEYLEN = 32;
const MAXMEM = 64 * 1024 * 1024;

export const PASSWORD_MIN_LENGTH = 10;
export const PASSWORD_MAX_LENGTH = 128;

export function validatePasswordPolicy(password: unknown, username?: string): string {
  if (typeof password !== 'string') throw new AppError('PASSWORD_POLICY', '口令必须是字符串', 400);
  if (password.length < PASSWORD_MIN_LENGTH) throw new AppError('PASSWORD_POLICY', `口令至少 ${PASSWORD_MIN_LENGTH} 个字符`, 400);
  if (password.length > PASSWORD_MAX_LENGTH) throw new AppError('PASSWORD_POLICY', `口令不超过 ${PASSWORD_MAX_LENGTH} 个字符`, 400);
  if (username && password.toLowerCase().includes(username.toLowerCase())) {
    throw new AppError('PASSWORD_POLICY', '口令不能包含用户名', 400);
  }
  if (new Set(password).size < 4) throw new AppError('PASSWORD_POLICY', '口令字符种类过少', 400);
  return password;
}

export function hashPassword(password: string): string {
  const salt = crypto.randomBytes(16);
  const hash = crypto.scryptSync(password, salt, KEYLEN, { N, r: R, p: P, maxmem: MAXMEM });
  return `scrypt$${N}$${R}$${P}$${salt.toString('base64')}$${hash.toString('base64')}`;
}

/** 用于未知用户名的等时比较,避免按响应时间枚举用户。 */
const DUMMY_HASH = hashPassword(crypto.randomBytes(16).toString('hex'));

export function verifyPassword(password: string, stored: string | null | undefined): boolean {
  const target = stored ?? DUMMY_HASH;
  const parts = target.split('$');
  if (parts.length !== 6 || parts[0] !== 'scrypt') return false;
  const [, n, r, p, saltB64, hashB64] = parts;
  const expected = Buffer.from(hashB64, 'base64');
  let actual: Buffer;
  try {
    actual = crypto.scryptSync(password, Buffer.from(saltB64, 'base64'), expected.length, {
      N: Number(n), r: Number(r), p: Number(p), maxmem: MAXMEM,
    });
  } catch {
    return false;
  }
  return stored != null && actual.length === expected.length && crypto.timingSafeEqual(actual, expected);
}
