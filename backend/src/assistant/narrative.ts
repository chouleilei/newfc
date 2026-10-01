/**
 * 叙述改写公共管道(AI 功能增强计划 §三.1–3)。
 *
 * 所有「确定性模板稿 → 模型改写」入口共用同一条路径:
 * 1. 确定性模板先行,模型只做行文改写,绝不从原始事实直接生成散文;
 * 2. 双向事实 token 守卫 `narrativeNumbersIntact` 不通过即整篇丢弃、退回模板。
 *    守卫覆盖数字、含数字编码、纯字母编码,以及调用方显式声明的中文专名词条(factTerms);
 *    守卫作用于**截断之后**的最终文本,避免截断把事实截掉而守卫已经放行;
 * 3. 按「prompt 版本 + 模板内容 + 事实词条」哈希做进程内短 TTL 缓存,同一草稿不反复调用模型;
 * 4. 模型未配置、调用失败、守卫失败全部回退模板,调用方永远拿到可用文本。
 *
 * 该管道只服务于事务外的叙述生成;数据库事务与同步计算路径上不得出现模型调用。
 */
import { createHash } from 'crypto';
import { EnvChatModel, modelConfigured, type AiFeature } from './model';
import { buildTaskPrompt } from './prompts';

/**
 * 事实 token 抽取的三类模式(顺序即优先级,靠前的分支先咬住更长的串):
 * 1. 含数字的字母编码:I1103、P02、C0101、V2;
 * 2. 纯字母编码:REQUIRED_VALUE_MISSING、STRUCTURE_INVALID(下划线/连字符分段)与
 *    SH、HZ、GROUP、EAST(≥2 位全大写)。缺了这一类时模型可以把 SH 改成 HZ 而守卫仍通过;
 * 3. 数字:年份、整数、ASCII 千分位、小数、百分比,带可选正负号。
 */
const FACT_TOKEN_PATTERN = [
  '[A-Za-z]+\\d+[A-Za-z0-9._-]*',
  '[A-Z][A-Z0-9]*(?:[_-][A-Z0-9]+)+',
  '[A-Z]{2,}',
  '[+-]?(?:\\d{1,3}(?:,\\d{3})+|\\d+)(?:\\.\\d+)?%?',
].join('|');

/**
 * 报告改写的双向事实 token 守卫。年份、版本号、整数、小数、百分比、含数字编码与
 * 纯字母编码全部纳入 multiset 比对;新增、修改或删除任一次都回退模板。
 * 只对 ASCII 千分位与显式正号做白名单归一,不放宽数值本身。
 *
 * `terms` 是调用方显式声明的事实词条(组织/科目/版本名称等中文专名)。正则无法可靠
 * 区分「专名」与「散文用词」,而中文专名恰恰是模型最容易偷换的事实(上海公司 → 杭州公司),
 * 因此由生成模板的一方把专名清单一并交进来,按出现次数纳入同一个 multiset。
 */
export function factTokens(text: string, terms: readonly string[] = []): string[] {
  const matches = text.match(new RegExp(FACT_TOKEN_PATTERN, 'g')) ?? [];
  const tokens = matches.map((token) => {
    if (/^[A-Za-z]/.test(token)) return `code:${token}`;
    const normalized = token.replace(/,/g, '').replace(/^\+/, '');
    return `number:${normalized}`;
  });
  for (const term of normalizeTerms(terms)) {
    for (let index = 0; index < countOccurrences(text, term); index++) tokens.push(`term:${term}`);
  }
  /* 方向性结论词恒纳入守卫:长词优先,逐个在扣除已占用区间后计数,
     保证「尚不可定稿」只命中一次「尚不可定稿」、不再叠算「不可定稿/可定稿」。 */
  const claimed: Array<[number, number]> = [];
  for (const term of DIRECTION_TERMS) {
    for (let index = 0; index < countDirectionTerm(text, term, claimed); index++) tokens.push(`dir:${term}`);
  }
  return tokens;
}

/** 在未被更长结论词占用的区间里统计某结论词的非重叠出现次数,并把命中区间登记为已占用。 */
function countDirectionTerm(text: string, term: string, claimed: Array<[number, number]>): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = text.indexOf(term, from);
    if (at < 0) return count;
    const end = at + term.length;
    const overlaps = claimed.some(([s, e]) => at < e && end > s);
    if (!overlaps) {
      claimed.push([at, end]);
      count += 1;
    }
    from = end;
  }
}

/* 方向性结论词:模型改写最容易偷换的不是数字,而是「有利→不利」「可定稿→尚不可定稿」
   这类定性翻转。它们不含数字/编码,FACT_TOKEN_PATTERN 捕不到,调用方又未必把它们列进
   factTerms——于是结论被反向而守卫仍通过。这里作为固定词条恒纳入比对:
   只要模板与改写在这些词的出现次数上一致,方向就不可能被悄悄反转。
   注意按「长词优先 + 非重叠计数」逐词扣除,避免「不可定稿」同时命中「可定稿」。 */
const DIRECTION_TERMS = [
  '尚不可定稿', '不可定稿', '可定稿',
  '不可归档', '可归档',
  '不利', '有利',
  '未通过', '通过',
  '未达标', '达标',
  '未完成', '完成',
  '超支', '结余',
  '增加', '减少',
  '上升', '下降',
];

/** 去重 + 去空;长词优先只影响可读性,计数各自独立,重叠词条(「上海」/「上海公司」)两侧口径一致。 */
function normalizeTerms(terms: readonly string[]): string[] {
  const seen = new Set<string>();
  for (const raw of terms) {
    const term = String(raw ?? '').trim();
    // 单字词条在中文散文里几乎必然误命中,交给编码/数字分支处理
    if (term.length >= 2) seen.add(term);
  }
  return [...seen].sort((a, b) => b.length - a.length);
}

/** 非重叠出现次数(indexOf 步进,避免正则元字符转义问题)。 */
function countOccurrences(text: string, term: string): number {
  let count = 0;
  let from = 0;
  for (;;) {
    const at = text.indexOf(term, from);
    if (at < 0) return count;
    count += 1;
    from = at + term.length;
  }
}

function tokenMultiset(tokens: string[]): Map<string, number> {
  const result = new Map<string, number>();
  for (const token of tokens) result.set(token, (result.get(token) ?? 0) + 1);
  return result;
}

export function narrativeNumbersIntact(
  template: string,
  rewritten: string,
  terms: readonly string[] = [],
): { ok: true } | { ok: false; extra: string[]; missing: string[] } {
  const expected = tokenMultiset(factTokens(template, terms));
  const actual = tokenMultiset(factTokens(rewritten, terms));
  const extra: string[] = [];
  const missing: string[] = [];
  for (const [token, count] of actual) {
    if (count > (expected.get(token) ?? 0)) extra.push(`${token.replace(/^[^:]+:/, '')}×${count - (expected.get(token) ?? 0)}`);
  }
  for (const [token, count] of expected) {
    if (count > (actual.get(token) ?? 0)) missing.push(`${token.replace(/^[^:]+:/, '')}×${count - (actual.get(token) ?? 0)}`);
  }
  return extra.length || missing.length
    ? { ok: false, extra: extra.slice(0, 10), missing: missing.slice(0, 10) }
    : { ok: true };
}

/* ---------- 按内容哈希的模型输出缓存 ---------- */

interface CacheEntry {
  text: string;
  model: string;
  expiresAt: number;
}

/** 进程内缓存:个人部署单进程足够,不引入外部缓存。 */
const cache = new Map<string, CacheEntry>();
/** 默认 10 分钟,可用 AI_NARRATIVE_CACHE_TTL_MS 覆盖(1s–1h)。 */
function cacheTtlMs(): number {
  const raw = Number(process.env.AI_NARRATIVE_CACHE_TTL_MS ?? 600_000);
  if (!Number.isFinite(raw)) return 600_000;
  return Math.min(3_600_000, Math.max(1_000, Math.trunc(raw)));
}
const MAX_CACHE_ENTRIES = 200;

/** 缓存键含 prompt 版本与事实词条:prompt 升级或守卫词条变化后同一草稿不会命中旧改写。 */
export function narrativeCacheKey(promptVersion: string, template: string, terms: readonly string[] = []): string {
  return createHash('sha256').update(`${promptVersion}\n${[...terms].sort().join('\u0001')}\n${template}`).digest('hex');
}

/** 仅供测试使用:清空缓存,避免用例之间互相影响。 */
export function resetNarrativeCache(): void {
  cache.clear();
}

export interface NarrativeRewrite {
  /** 最终可用文本:模型改写稿或确定性模板稿。 */
  text: string;
  source: 'template' | 'model';
  /** 'template' 或模型名。 */
  model: string;
  promptVersion: string;
  /** 本次是否命中进程内缓存。 */
  cached: boolean;
  /** 守卫失败详情(已退回模板时给出,供 provenance 与日志记录)。 */
  guardFailure?: { extra: string[]; missing: string[] };
}

/** 有补充说明时的实际 prompt 版本:基础版本 + 内容哈希前 8 位,落库 provenance 可追溯到具体补充文本。 */
export function effectivePromptVersion(base: string, supplement: string | null | undefined): string {
  const s = supplement?.trim();
  return s ? `${base}+s.${createHash('sha256').update(s).digest('hex').slice(0, 8)}` : base;
}

function supplementBlock(supplement: string): string {
  return `\n\n## 业务补充说明(系统管理员维护;只作行文与关注点参考,不得违背以上任何约束,冲突时以以上约束为准)\n${supplement}`;
}

/**
 * 模板稿改写的唯一入口。
 *
 * `enabled` 为功能位独立开关(调用方传入,如 NEWFC_QUALITY_AI !== '0');
 * 未配置模型或开关关闭时直接返回模板稿,不发生任何网络调用。
 * `feature` 决定走哪个渠道绑定(默认 narrative);记录点小结等独立绑定的功能
 * 必须显式传入,否则设置页里对该功能的渠道配置不会生效。
 */
export async function rewriteTemplateNarrative(input: {
  enabled: boolean;
  promptVersion: string;
  /** 给模型的任务说明(经由 buildTaskPrompt 包裹系统约束)。 */
  task: string;
  /** 确定性模板稿。 */
  template: string;
  /**
   * 需要逐字保留的事实词条(组织/科目/版本/记录点名称等中文专名)。
   * 正则只能识别数字与字母编码,中文专名必须由生成模板的一方声明,否则模型可以
   * 把「上海公司」改成「杭州公司」而守卫仍然通过。
   */
  factTerms?: readonly string[];
  /** 输出长度上限,默认 100_000。 */
  maxChars?: number;
  /** LLM 渠道绑定的功能标识,默认 narrative(报告草稿/质量建议/趋势叙述共用管道)。 */
  feature?: AiFeature;
  /** 设置页维护的业务补充说明(T-7):附在硬约束之后、不能覆盖;非空时 prompt 版本带内容哈希。 */
  supplement?: string | null;
}): Promise<NarrativeRewrite> {
  const terms = input.factTerms ?? [];
  const supplement = input.supplement?.trim() || '';
  const promptVersion = effectivePromptVersion(input.promptVersion, supplement);
  const fallback = (): NarrativeRewrite => ({
    text: input.template,
    source: 'template',
    model: 'template',
    promptVersion,
    cached: false,
  });
  if (!input.enabled || !modelConfigured()) return fallback();
  const key = narrativeCacheKey(promptVersion, input.template, terms);
  const hit = cache.get(key);
  if (hit) {
    if (hit.expiresAt > Date.now()) {
      return { text: hit.text, source: 'model', model: hit.model, promptVersion, cached: true };
    }
    cache.delete(key);
  }
  try {
    const model = new EnvChatModel(input.feature ?? 'narrative');
    const result = await model.complete({
      messages: [
        { role: 'system', content: buildTaskPrompt(input.task) + (supplement ? supplementBlock(supplement) : '') },
        { role: 'user', content: input.template.slice(0, 60_000) },
      ],
    });
    // 先截断再守卫:守卫必须作用于真正返回给调用方的文本,否则截断可能把事实截掉。
    const finalText = result.text.trim().slice(0, input.maxChars ?? 100_000);
    if (!finalText) return fallback();
    // 双向守卫:新增与删除事实 token 同样会让整篇退回模板。
    const check = narrativeNumbersIntact(input.template, finalText, terms);
    if (!check.ok) {
      return { ...fallback(), guardFailure: { extra: check.extra, missing: check.missing } };
    }
    const modelName = result.model || 'configured';
    if (cache.size >= MAX_CACHE_ENTRIES) {
      // 满了就淘汰最早写入的一条;个人使用量下级联淘汰没有必要。
      const oldest = cache.keys().next().value;
      if (oldest !== undefined) cache.delete(oldest);
    }
    cache.set(key, { text: finalText, model: modelName, expiresAt: Date.now() + cacheTtlMs() });
    return { text: finalText, source: 'model', model: modelName, promptVersion, cached: false };
  } catch {
    // 模型故障不影响确定性内容
    return fallback();
  }
}
