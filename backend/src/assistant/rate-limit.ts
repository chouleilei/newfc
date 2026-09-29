/**
 * 助手接口的速率限制。
 *
 * 为什么需要：`/chat` 一次请求最多会向模型发起 4 轮工具调用 + 作答与兜底轮，
 * 按次计费且单次可达十几秒。原来除登录之外没有任何限流，一个循环脚本或误触的
 * 前端重试就能把额度打光，也会把 SQLite 连接占满。
 *
 * 口径：进程内滑动窗口，按「来源 IP + 登录用户」计数(个人使用场景足够，不引入 Redis)。
 * 只作用于消耗模型或做重计算的写入型入口，纯列表查询不限流。
 * 超限返回 429 与结构化错误，并给出 `retryAfterSeconds`。
 *
 * 两个相互隔离的桶(AI 功能增强计划 §二.5):
 * - 聊天桶 `assistantRateLimit`:对话、预览、确认、下载等交互入口,默认 30/min;
 * - 叙述桶 `assistantNarrativeRateLimit`:门禁解释、映射残差建议、趋势叙述、
 *   记录点小结等后台叙述生成入口,默认收紧到 10/min——叙述是锦上添花,
 *   不能与聊天共用配额,避免叙述重试把对话额度打光。
 */
import type { Request, Response, NextFunction } from 'express';

interface Window { hits: number[]; }

const WINDOW_MS = 60_000;
/** 每处理这么多次请求做一次过期 key 清理。 */
const SWEEP_EVERY = 200;
const chatBuckets = new Map<string, Window>();
const narrativeBuckets = new Map<string, Window>();
/** 服务级(非 HTTP)叙述生成桶,见 tryConsumeNarrativeBudget。 */
const serviceBuckets = new Map<string, Window>();

function boundedLimit(raw: string | undefined, fallback: number): number {
  const value = Number(raw ?? fallback);
  if (!Number.isFinite(value)) return fallback;
  return Math.min(1000, Math.max(1, Math.trunc(value)));
}

/** 每分钟允许的请求数，可用 AI_RATE_LIMIT_PER_MIN 覆盖(1–1000，默认 30)。 */
export function rateLimitPerMinute(): number {
  return boundedLimit(process.env.AI_RATE_LIMIT_PER_MIN, 30);
}

/** 叙述生成桶每分钟上限,可用 AI_NARRATIVE_RATE_LIMIT_PER_MIN 覆盖(1–1000,默认 10)。 */
export function narrativeRateLimitPerMinute(): number {
  return boundedLimit(process.env.AI_NARRATIVE_RATE_LIMIT_PER_MIN, 10);
}

function keyFor(req: Request): string {
  const actor = (req as Request & { authUser?: string }).authUser || 'anonymous';
  const ip = req.ip || req.socket?.remoteAddress || 'unknown';
  return `${actor}@${ip}`;
}

/** 仅供测试使用：清空计数，避免用例之间互相影响。 */
export function resetAssistantRateLimit(): void {
  chatBuckets.clear();
  narrativeBuckets.clear();
  serviceBuckets.clear();
}

/**
 * 清掉窗口内已无请求的 key。
 *
 * key 是「登录用户@来源 IP」，只清理时间戳、不删 key 的话，常驻进程下 Map 会随
 * 不同来源单调增长且永不释放。这里按调用次数触发一次全量扫描(个人使用量级下
 * key 数极少，扫描成本可忽略)，避免额外起定时器。
 */
let sweepCountdown = SWEEP_EVERY;
function sweepExpired(now: number): void {
  sweepCountdown -= 1;
  if (sweepCountdown > 0) return;
  sweepCountdown = SWEEP_EVERY;
  for (const store of [chatBuckets, narrativeBuckets, serviceBuckets]) {
    for (const [key, bucket] of store) {
      if (!bucket.hits.some((at) => now - at < WINDOW_MS)) store.delete(key);
    }
  }
}

function makeLimiter(store: Map<string, Window>, limitFor: () => number, label: string) {
  return (req: Request, res: Response, next: NextFunction): void => {
    const limit = limitFor();
    const now = Date.now();
    sweepExpired(now);
    const key = keyFor(req);
    const bucket = store.get(key) ?? { hits: [] };
    bucket.hits = bucket.hits.filter((at) => now - at < WINDOW_MS);
    if (bucket.hits.length >= limit) {
      const oldest = bucket.hits[0];
      const retryAfterSeconds = Math.max(1, Math.ceil((WINDOW_MS - (now - oldest)) / 1000));
      store.set(key, bucket);
      res.setHeader('Retry-After', String(retryAfterSeconds));
      res.status(429).json({
        code: 'AI_RATE_LIMITED',
        message: `${label}请求过于频繁（每分钟上限 ${limit} 次），请 ${retryAfterSeconds} 秒后重试`,
        retryAfterSeconds,
      });
      return;
    }
    bucket.hits.push(now);
    store.set(key, bucket);
    next();
  };
}

export const assistantRateLimit: (req: Request, res: Response, next: NextFunction) => void =
  makeLimiter(chatBuckets, rateLimitPerMinute, '助手');

export const assistantNarrativeRateLimit: (req: Request, res: Response, next: NextFunction) => void =
  makeLimiter(narrativeBuckets, narrativeRateLimitPerMinute, '助手叙述生成');

/**
 * 服务级(非 HTTP)叙述生成配额。
 *
 * 记录点小结这类后台生成没有请求上下文,挂不上中间件,但它同样会消耗模型额度:
 * 一次批量编辑可以连续产生几十个记录点,每个都触发一次改写。这里给后台任务
 * 一个与 HTTP 叙述桶同口径、独立计数的滑动窗口,超限时调用方退回确定性模板稿
 * (小结仍然产出,只是不经模型),不排队也不重试。
 */
export function tryConsumeNarrativeBudget(key: string): boolean {
  const limit = narrativeRateLimitPerMinute();
  const now = Date.now();
  sweepExpired(now);
  const bucket = serviceBuckets.get(key) ?? { hits: [] };
  bucket.hits = bucket.hits.filter((at) => now - at < WINDOW_MS);
  if (bucket.hits.length >= limit) {
    serviceBuckets.set(key, bucket);
    return false;
  }
  bucket.hits.push(now);
  serviceBuckets.set(key, bucket);
  return true;
}
