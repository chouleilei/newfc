import crypto from 'crypto';

/**
 * 登录会话(方案十四扩展:单用户账号线内存会话)。
 * POST /api/auth/login 校验用户名/密码后签发随机令牌,后续请求以 x-access-token 携带;
 * 令牌 7 天滑动过期,重启服务即全部失效(重新登录即可)。
 * 登录接口带按 IP 的失败限流:窗口期内连续失败达上限将临时锁定。
 */

export interface Session {
  token: string;
  username: string;
  createdAt: number;
  expiresAt: number;
}

export interface AuthConfig {
  username: string;
  password: string;
}

export interface LoginResult {
  ok: boolean;
  session?: Session;
  lockedSeconds?: number;
  /** 已处于锁定期内的重复请求(本次未计入失败次数,调用方不应写库) */
  lockedOnly?: boolean;
}

const SESSION_TTL_MS = 7 * 24 * 3600 * 1000;
const MAX_FAILED_ATTEMPTS = 8;
const LOCK_WINDOW_MS = 10 * 60 * 1000;
const LOCK_DURATION_MS = 5 * 60 * 1000;

/** 明文比较统一走哈希后 timingSafeEqual,恒定时间且不受长度差异影响 */
function safeEqual(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(a, 'utf8').digest();
  const hb = crypto.createHash('sha256').update(b, 'utf8').digest();
  return crypto.timingSafeEqual(ha, hb);
}

interface FailureRecord {
  count: number;
  firstAt: number;
  lockedUntil: number;
}

export class SessionStore {
  private sessions = new Map<string, Session>();
  private failures = new Map<string, FailureRecord>();
  /**
   * 按账号的失败计数。单用户系统下它是防爆破的最后一道闸:当部署把服务绑到
   * 0.0.0.0 又开启 trust proxy 时,直连伪造 X-Forwarded-For 即可让每个伪造 IP
   * 拿到独立的按 IP 配额;按账号锁定让轮换 IP 无法绕过上限。
   */
  private accountFailures = new Map<string, FailureRecord>();

  constructor(private config: AuthConfig) {}

  /** 用户名/密码任一为空即视为关闭登录(本机开放模式) */
  get enabled(): boolean {
    return Boolean(this.config.username) && Boolean(this.config.password);
  }

  private lockedRemaining(rec: FailureRecord | undefined, now: number): number {
    return rec && rec.lockedUntil > now ? Math.ceil((rec.lockedUntil - now) / 1000) : 0;
  }

  private registerFailure(rec: FailureRecord | undefined, now: number): { rec: FailureRecord; lockedSeconds: number } {
    const cur = rec && now - rec.firstAt < LOCK_WINDOW_MS ? rec : { count: 0, firstAt: now, lockedUntil: 0 };
    cur.count += 1;
    if (cur.count >= MAX_FAILED_ATTEMPTS) {
      cur.lockedUntil = now + LOCK_DURATION_MS;
      cur.count = 0;
      cur.firstAt = now;
    }
    return { rec: cur, lockedSeconds: this.lockedRemaining(cur, now) };
  }

  login(clientKey: string, username: string, password: string): LoginResult {
    const now = Date.now();
    // 账号锁优先于 IP 锁判定;IP 维度仍保留,未被伪造头绕过的部署继续双保险
    const accountLockedSeconds = this.lockedRemaining(this.accountFailures.get(username), now);
    const rec = this.failures.get(clientKey);
    const ipLockedSeconds = this.lockedRemaining(rec, now);
    if (accountLockedSeconds > 0 || ipLockedSeconds > 0) {
      return { ok: false, lockedSeconds: Math.max(accountLockedSeconds, ipLockedSeconds), lockedOnly: true };
    }

    const valid =
      safeEqual(username ?? '', this.config.username) && safeEqual(password ?? '', this.config.password);
    if (!valid) {
      const ip = this.registerFailure(rec, now);
      this.failures.set(clientKey, ip.rec);
      // 只对正确用户名计数:攻击者乱填用户名也无法锁死真实账号之外的东西,
      // 而对真实用户名的高频试错必然触发锁定
      if (safeEqual(username ?? '', this.config.username)) {
        const account = this.registerFailure(this.accountFailures.get(username), now);
        this.accountFailures.set(username, account.rec);
        ip.lockedSeconds = Math.max(ip.lockedSeconds, account.lockedSeconds);
      }
      return { ok: false, lockedSeconds: ip.lockedSeconds > 0 ? ip.lockedSeconds : undefined };
    }

    this.failures.delete(clientKey);
    this.accountFailures.delete(username);
    if (this.sessions.size > 100) this.purgeExpired(now);
    const session: Session = {
      token: crypto.randomBytes(32).toString('hex'),
      username: this.config.username,
      createdAt: now,
      expiresAt: now + SESSION_TTL_MS,
    };
    this.sessions.set(session.token, session);
    return { ok: true, session };
  }

  /** 校验并滑动续期;失败返回 undefined */
  resolve(token: string | undefined): Session | undefined {
    if (!token) return undefined;
    const s = this.sessions.get(token);
    if (!s) return undefined;
    if (s.expiresAt <= Date.now()) {
      this.sessions.delete(token);
      return undefined;
    }
    s.expiresAt = Date.now() + SESSION_TTL_MS;
    return s;
  }

  logout(token: string | undefined): void {
    if (token) this.sessions.delete(token);
  }

  private purgeExpired(now: number): void {
    for (const [token, s] of this.sessions) {
      if (s.expiresAt <= now) this.sessions.delete(token);
    }
  }
}
