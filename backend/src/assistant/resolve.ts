/**
 * 上下文自动解析(方案《AI助手完整方案》5.6「上下文」)。
 *
 * 原实现只接受前端下拉框选好的整数 ID，用户说「2025 年执行情况」但没手动选版本时
 * 只能返回 missing_context。这里把自然语言里的年度、组织、科目、版本、快照和导入批次
 * 解析成确定性 ID，并在缺少版本时回退到该年度的当前生效版本。
 *
 * 优先级：请求显式传入 > 本轮消息解析 > 上一轮会话继承 > 数据库默认值。
 * 全过程只读，且每一项都记录来源与原因，便于前端如实展示「助手替你选了什么」。
 */
import type { DB } from '../db/connection';
import type { AssistantContext } from './schemas';

export type ResolutionOrigin = 'request' | 'message' | 'conversation' | 'default';

export interface ContextResolution {
  field: 'year' | 'budgetVersionId' | 'targetVersionId' | 'actualSnapshotId' | 'orgId' | 'accountId' | 'importBatchId';
  value: number;
  origin: ResolutionOrigin;
  /** 人类可读的命中依据，例如「命中年度「2025 年」」或「2026 年当前生效预算版本」 */
  reason: string;
  /** 便于前端直接显示的名称(版本名、组织名、科目名、快照日期) */
  label?: string;
}

export interface ResolvedContextResult {
  context: AssistantContext;
  resolution: ContextResolution[];
  /**
   * 名称片段命中多个组织/科目、因此**故意没有解析**的项。
   *
   * 上层据此如实提示「「江垭」可能指江垭电站或江垭温泉」，而不是静默按全范围回答。
   */
  ambiguities: NodeAmbiguity[];
}

interface NodeRow {
  id: number;
  code: string;
  name: string;
  status: string;
}

interface VersionRow {
  id: number;
  year: number;
  name: string;
  status: string;
  is_current: 0 | 1;
  kind: string;
}

interface BatchRow {
  id: number;
  year: number;
  snapshot_date: string;
  revision: number;
}

/** 只把长度足够的编码纳入匹配，避免单字符编码(如「I」)命中任意文本。 */
const MIN_CODE_LENGTH = 2;
const MIN_NAME_LENGTH = 2;

/** 关键词 → 相对年份偏移。以服务器当前年份为基准。 */
const RELATIVE_YEAR: { pattern: RegExp; offset: number }[] = [
  { pattern: /前年/, offset: -2 },
  { pattern: /去年|上年|上一年/, offset: -1 },
  { pattern: /今年|本年|当年|本年度/, offset: 0 },
  { pattern: /明年|次年|下一年|下年/, offset: 1 },
];

function tableExists(db: DB, table: string): boolean {
  return Boolean(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(table));
}

/**
 * 消息中出现的年份，并区分信号强度：
 * - explicit：带「年」后缀，如「2025 年」；
 * - relative：去年/今年/明年 等相对词；
 * - bare：裸四位数，可能只是编码或金额的一部分，只在完全没有年度时才采用。
 */
function parseYearFromMessage(message: string): { year: number; reason: string; strength: 'explicit' | 'relative' | 'bare' } | null {
  const suffixed = message.match(/((?:19|20)\d{2})\s*年/);
  if (suffixed) return { year: Number(suffixed[1]), reason: `命中年度「${suffixed[0].trim()}」`, strength: 'explicit' };
  for (const rule of RELATIVE_YEAR) {
    const hit = message.match(rule.pattern);
    if (hit) return { year: new Date().getFullYear() + rule.offset, reason: `命中相对年度「${hit[0]}」`, strength: 'relative' };
  }
  const bare = message.match(/(?<![\d.])((?:19|20)\d{2})(?![\d.])/);
  if (bare) return { year: Number(bare[1]), reason: `命中年份「${bare[1]}」`, strength: 'bare' };
  return null;
}

/** 数据库里可用的默认年度：优先当前自然年，否则取最新有预算版本的年度。 */
function defaultYear(db: DB): { year: number; reason: string } | null {
  if (!tableExists(db, 'budget_version')) return null;
  const current = new Date().getFullYear();
  const hasCurrent = db.prepare('SELECT 1 FROM budget_version WHERE year=?').get(current);
  if (hasCurrent) return { year: current, reason: `未指定年度，默认当前年度 ${current}` };
  const latest = db.prepare('SELECT MAX(year) AS y FROM budget_version').get() as { y: number | null } | undefined;
  if (latest?.y == null) return null;
  return { year: Number(latest.y), reason: `未指定年度，默认取最新有版本的年度 ${latest.y}` };
}

/**
 * 请求里显式带了版本、却没带年度时的年度来源。
 *
 * 实测背景：在 /budget/:id 编制页或抽屉里提问，前端会把当前版本 ID 作为请求上下文送上来，
 * 但年度通常没选。原来的顺序会直接落到 defaultYear() 的当前自然年兜底，于是
 * 「2025 年的版本 + 2026 年的默认年度」被 validateContextConsistency 判成
 * 「context.year 与 budgetVersionId 年度不一致」而整轮报错——用户什么都没选错。
 * 版本是用户/页面显式给的更强信号，年度应当取自它。
 */
function yearFromRequestedVersion(db: DB, versionId: number): { year: number; reason: string } | null {
  const row = db.prepare('SELECT id,year,name FROM budget_version WHERE id=?').get(versionId) as
    | { id: number; year: number; name: string }
    | undefined;
  if (!row) return null;
  return { year: row.year, reason: `未指定年度，取自已选版本「${row.name}」的年度 ${row.year}` };
}

/**
 * 组织/科目名称里可以省略的后缀。
 *
 * 实测背景：用户说「江垭今年收入完成得怎么样」，库里的名字是「江垭电站」，
 * 原来的整名包含匹配一个也命中不了，于是**静默返回全集团合计**，看起来像回答了问题。
 * 这里把这些业务后缀剥掉再匹配，命中不唯一时不猜，改为显式报歧义。
 */
const NAME_SUFFIXES = [
  '分公司', '子公司', '有限公司', '责任公司', '公司', '集团', '总部', '本级',
  '电站', '风电场', '光伏电站', '温泉', '项目公司', '项目部', '事业部', '中心', '物业', '厂',
];

/** 去掉业务后缀后的核心名；无法缩短或过短时返回 null。 */
function coreName(name: string): string | null {
  let core = String(name || '').trim();
  for (const suffix of NAME_SUFFIXES) {
    if (core.length > suffix.length && core.endsWith(suffix)) {
      core = core.slice(0, core.length - suffix.length);
      break;
    }
  }
  core = core.trim();
  if (!core || core === name.trim() || core.length < MIN_NAME_LENGTH) return null;
  return core;
}

export interface NodeAmbiguity {
  field: 'orgId' | 'accountId';
  /** 消息里出现的名称片段 */
  token: string;
  candidates: { id: number; code: string; name: string }[];
}

interface NodeMatchResult {
  hit: { row: NodeRow; reason: string } | null;
  /** 名称片段命中多个节点：不猜，交给上层如实提示 */
  ambiguous: { token: string; candidates: NodeRow[] } | null;
}

/**
 * 在文本中按「最长优先」匹配树节点(组织/科目)。
 * 名称匹配要求长度 ≥ 2，编码匹配要求长度 ≥ 2 且两侧不是字母数字，避免误命中。
 * 整名与编码都没命中时，退一步用去掉业务后缀的核心名匹配；核心名对应多个节点时报歧义。
 */
function matchNode(message: string, rows: NodeRow[]): NodeMatchResult {
  interface Candidate { row: NodeRow; reason: string; weight: number }
  const candidates: Candidate[] = [];
  for (const row of rows) {
    // 同长度时启用状态优先：active 优于 inactive。
    const statusBonus = row.status === 'active' ? 0.5 : 0;
    const name = String(row.name || '');
    if (name.length >= MIN_NAME_LENGTH && message.includes(name)) {
      candidates.push({ row, reason: `命中名称「${name}」`, weight: name.length * 2 + statusBonus });
      continue;
    }
    const code = String(row.code || '');
    if (code.length < MIN_CODE_LENGTH) continue;
    const index = message.toUpperCase().indexOf(code.toUpperCase());
    if (index < 0) continue;
    const before = message[index - 1] ?? '';
    const after = message[index + code.length] ?? '';
    if (/[0-9A-Za-z]/.test(before) || /[0-9A-Za-z]/.test(after)) continue;
    candidates.push({ row, reason: `命中编码「${code}」`, weight: code.length + statusBonus });
  }
  if (candidates.length) {
    const best = candidates.reduce((a, b) => (b.weight > a.weight ? b : a));
    return { hit: { row: best.row, reason: best.reason }, ambiguous: null };
  }
  // 整名/编码都没命中：按核心名(去掉「电站」「公司」等后缀)再试一次。
  const partial = new Map<string, NodeRow[]>();
  for (const row of rows) {
    const core = coreName(String(row.name || ''));
    if (!core || !message.includes(core)) continue;
    partial.set(core, [...(partial.get(core) ?? []), row]);
  }
  if (!partial.size) return { hit: null, ambiguous: null };
  // 片段越长越具体，优先采用最长的那个片段。
  const [token, matched] = [...partial.entries()].sort((a, b) => b[0].length - a[0].length)[0];
  const active = matched.filter((row) => row.status === 'active');
  const effective = active.length ? active : matched;
  if (effective.length === 1) {
    return { hit: { row: effective[0], reason: `命中名称片段「${token}」→「${effective[0].name}」`, }, ambiguous: null };
  }
  return { hit: null, ambiguous: { token, candidates: effective.slice(0, 5) } };
}

/** 按出现顺序匹配版本名，用于「A 和 B 对比」这类需要两个版本的问题。 */
function matchVersionsByName(message: string, versions: VersionRow[]): { row: VersionRow; index: number; reason: string }[] {
  const hits: { row: VersionRow; index: number; reason: string }[] = [];
  for (const row of versions) {
    const name = String(row.name || '');
    if (name.length < MIN_NAME_LENGTH) continue;
    const index = message.indexOf(name);
    if (index >= 0) hits.push({ row, index, reason: `命中版本名「${name}」` });
  }
  // 同一位置可能匹配到多个版本名(如「V1」与「V10」)，保留最长的那个。
  hits.sort((a, b) => (a.index - b.index) || (b.row.name.length - a.row.name.length));
  const out: { row: VersionRow; index: number; reason: string }[] = [];
  for (const hit of hits) {
    if (out.some((kept) => hit.index >= kept.index && hit.index < kept.index + kept.row.name.length)) continue;
    out.push(hit);
  }
  return out;
}

/** 该年度的默认版本：当前生效 → 最新定稿 → 最新任意。 */
function defaultVersion(versions: VersionRow[], kind: 'budget' | 'forecast'): { row: VersionRow; reason: string } | null {
  const sameKind = versions.filter((v) => (v.kind || 'budget') === kind);
  const pool = sameKind.length ? sameKind : versions;
  if (!pool.length) return null;
  const kindLabel = kind === 'forecast' ? '预测' : '预算';
  const current = pool.find((v) => v.is_current === 1);
  if (current) return { row: current, reason: `${current.year} 年当前生效${kindLabel}版本` };
  const locked = pool.find((v) => v.status === 'locked') ?? pool.find((v) => v.status === 'archived');
  if (locked) return { row: locked, reason: `${locked.year} 年最新定稿${kindLabel}版本(无当前生效版本)` };
  return { row: pool[0], reason: `${pool[0].year} 年最新${kindLabel}版本(无当前生效版本)` };
}

/** 「截至 6 月」「6 月底」→ 该年度中月份不超过 6 的最新快照。 */
function parseMonth(message: string): number | null {
  const hit = message.match(/(?:截至|截止|到)?\s*(\d{1,2})\s*月(?:底|末|份)?/);
  if (!hit) return null;
  const month = Number(hit[1]);
  return month >= 1 && month <= 12 ? month : null;
}

function matchSnapshot(message: string, batches: BatchRow[]): { row: BatchRow; reason: string } | null {
  if (!batches.length) return null;
  const explicit = message.match(/快照\s*#?(\d{1,9})/);
  if (explicit) {
    const row = batches.find((b) => b.id === Number(explicit[1]));
    if (row) return { row, reason: `命中快照编号 ${row.id}` };
  }
  const date = message.match(/((?:19|20)\d{2})-(\d{2})-(\d{2})/);
  if (date) {
    const row = batches.find((b) => b.snapshot_date === date[0]);
    if (row) return { row, reason: `命中快照日期 ${row.snapshot_date}` };
  }
  if (/最新快照|最近快照|最新实际/.test(message)) {
    return { row: batches[0], reason: `取最新快照 ${batches[0].snapshot_date}` };
  }
  const month = parseMonth(message);
  if (month != null) {
    const candidates = batches.filter((b) => Number(b.snapshot_date.slice(5, 7)) <= month);
    if (candidates.length) return { row: candidates[0], reason: `命中「${month}月」，取该月及之前最新快照 ${candidates[0].snapshot_date}` };
  }
  return null;
}

export interface ResolveOptions {
  /**
   * 是否允许在消息与会话都没有指定版本时，回退到该年度的当前生效版本。
   * 只有确实需要版本才能计算的意图才应打开(见 intent.ts:needsBudgetVersion)，
   * 否则「列出预算版本」这类问题会被悄悄缩小到单个版本。
   */
  defaultVersion?: boolean;
  /**
   * 是否允许「句子里明确写出的年度」覆盖请求里已选的年度。
   *
   * 默认关闭，保持「请求显式传入优先」。只对纯只读提问打开：筛选器里的年度常常
   * 只是上次用过的默认值，而「2025 年执行情况如何」里的年度是明确的新意图。
   * 写操作请求必须保持关闭——那里的年份多是操作的**目标年度**
   * (如「把这个版本复制成 2027 年草案」)，覆盖分析年度会把用户选的源版本弄丢。
   */
  yearOverride?: boolean;
  /**
   * 是否允许句子里明确命中的版本/快照/组织/科目覆盖请求(页面)里的对应值
   * (《小澧助手全页面回答范围自动对齐开发计划》§6 优先级 1 > 4)。
   *
   * 只读提问才开启；覆盖会写进 resolution(「已覆盖页面的 X」)，由上层转成
   * contextTrace.overrides 如实展示。名称有歧义时不覆盖，照旧返回候选。
   */
  messageOverride?: boolean;
}

/**
 * 解析并补全上下文。
 *
 * @param requested 前端显式传入(下拉框选择)的上下文，永远优先。
 * @param inherited 上一轮助手回答里已解析出的上下文，用于「那第二名呢」这类追问。
 */
export function resolveMessageContext(
  db: DB,
  message: string,
  requested: AssistantContext = {},
  inherited: AssistantContext = {},
  options: ResolveOptions = {},
): ResolvedContextResult {
  const text = String(message || '');
  const context: AssistantContext = { ...requested };
  const resolution: ContextResolution[] = [];
  const ambiguities: NodeAmbiguity[] = [];
  const record = (field: ContextResolution['field'], value: number, origin: ResolutionOrigin, reason: string, label?: string) => {
    resolution.push({ field, value, origin, reason, ...(label ? { label } : {}) });
  };
  if (!tableExists(db, 'budget_version')) return { context, resolution, ambiguities };

  const wantsForecast = /预测/.test(text) && !/预测.{0,4}对比预算/.test(text);
  const kind: 'budget' | 'forecast' = wantsForecast ? 'forecast' : 'budget';

  /* ---------- 年度 ---------- */
  if (context.year == null) {
    const parsed = parseYearFromMessage(text);
    // 请求显式带了版本(下拉框选择或页面路由推导)时，年度取自该版本：
    // 版本是用户/页面给出的强信号，落到默认兜底或上一轮年度都会与它冲突，
    // 被 validateContextConsistency 判成「年度不一致」而整轮报错。
    // 句子里明确写出的年度仍然优先(此时会连带放弃已选版本，见下方 yearFromMessage 分支)。
    const fromVersion = requested.budgetVersionId == null ? null : yearFromRequestedVersion(db, requested.budgetVersionId);
    if (parsed) {
      context.year = parsed.year;
      record('year', parsed.year, 'message', parsed.reason);
    } else if (fromVersion) {
      context.year = fromVersion.year;
      record('year', fromVersion.year, 'request', fromVersion.reason);
    } else if (inherited.year != null) {
      context.year = inherited.year;
      record('year', inherited.year, 'conversation', '沿用上一轮的年度');
    } else {
      const fallback = defaultYear(db);
      if (fallback) {
        context.year = fallback.year;
        record('year', fallback.year, 'default', fallback.reason);
      }
    }
  } else if (options.yearOverride) {
    // 请求里已经带了年度，但句子里明确写出了另一个年度。
    // 筛选器里的年度往往只是「上次用过的值」，句子里写出来的是更明确、更新的意图，
    // 所以让消息覆盖它并在 resolution 里说明替换了什么。裸四位数信号太弱，不参与覆盖。
    const parsed = parseYearFromMessage(text);
    if (parsed && parsed.strength !== 'bare' && parsed.year !== context.year) {
      const replaced = context.year;
      context.year = parsed.year;
      record('year', parsed.year, 'message', `${parsed.reason}，已覆盖筛选器里的 ${replaced} 年`);
    }
  }

  /* ---------- 预算/预测版本 ---------- */
  // 消息里的年度与「下拉框已选版本」冲突时，年度是更明确的信号：
  // 用户选着 2026 版本却问「2025 年怎么样」，应该换成 2025 年的版本，
  // 而不是抛出 context.year 与 budgetVersionId 年度不一致的校验错误。
  // 只在年度来自本轮消息时这样做；请求同时传入互相矛盾的 year 与 versionId 属于前端错误，
  // 交由 validateContextConsistency 拒绝。
  const yearFromMessage = resolution.some((item) => item.field === 'year' && item.origin === 'message');
  if (yearFromMessage && context.year != null && context.budgetVersionId != null) {
    const selected = db.prepare('SELECT id,year,name FROM budget_version WHERE id=?').get(context.budgetVersionId) as { id: number; year: number; name: string } | undefined;
    if (selected && selected.year !== context.year) {
      delete context.budgetVersionId;
      if (context.targetVersionId != null) {
        const target = db.prepare('SELECT year FROM budget_version WHERE id=?').get(context.targetVersionId) as { year: number } | undefined;
        if (target && target.year !== context.year) delete context.targetVersionId;
      }
      record('year', context.year, 'message', `问题指向 ${context.year} 年，已放弃 ${selected.year} 年的已选版本「${selected.name}」`);
    }
  }
  if (yearFromMessage && context.year != null && context.actualSnapshotId != null && tableExists(db, 'actual_snapshot_batch')) {
    const batch = db.prepare('SELECT year FROM actual_snapshot_batch WHERE id=?').get(context.actualSnapshotId) as { year: number } | undefined;
    if (batch && batch.year !== context.year) delete context.actualSnapshotId;
  }
  const versions = (context.year == null
    ? db.prepare('SELECT id,year,name,status,is_current,kind FROM budget_version ORDER BY year DESC, created_at DESC, id DESC').all()
    : db.prepare('SELECT id,year,name,status,is_current,kind FROM budget_version WHERE year=? ORDER BY created_at DESC, id DESC').all(context.year)
  ) as VersionRow[];
  const namedVersions = matchVersionsByName(text, versions);
  /* ---- 问题明确指定的版本覆盖页面版本(§6 优先级 1 > 4) ----
     跨年度匹配：页面年度过滤不应挡住「问 2025 的 V1」这类显式覆盖。
     覆盖后同步清理与新年度冲突的其余字段(与 yearFromMessage 分支同模式)：
     残留的 targetVersionId / actualSnapshotId 会在 validateContextConsistency
     处变成「context.year 与 XXX 年度不一致」，或更糟——静默做跨年对比。 */
  if (context.budgetVersionId != null && options.messageOverride) {
    const allVersions = (context.year == null ? versions
      : db.prepare('SELECT id,year,name,status,is_current,kind FROM budget_version ORDER BY year DESC, created_at DESC, id DESC').all()) as VersionRow[];
    const namedAll = matchVersionsByName(text, allVersions);
    const explicitId = text.match(/版本\s*#?(\d{1,9})/);
    const byId = explicitId ? allVersions.find((v) => v.id === Number(explicitId[1])) : undefined;
    const hit = namedAll[0]?.row ?? byId ?? null;
    if (hit && hit.id !== context.budgetVersionId) {
      const previous = allVersions.find((v) => v.id === context.budgetVersionId);
      context.budgetVersionId = hit.id;
      record('budgetVersionId', hit.id, 'message', `${hit.name ? `命中版本「${hit.name}」` : `命中版本编号 ${hit.id}`}，已覆盖页面的版本「${previous?.name ?? `#${previous?.id ?? ''}`}」`, hit.name);
      if (context.year !== hit.year) {
        const replacedYear = context.year;
        context.year = hit.year;
        record('year', hit.year, 'message', replacedYear == null ? `取自版本「${hit.name}」的年度` : `取自版本「${hit.name}」的年度，已覆盖页面的 ${replacedYear} 年`);
      }
      if (context.targetVersionId != null) {
        const target = db.prepare('SELECT year FROM budget_version WHERE id=?').get(context.targetVersionId) as { year: number } | undefined;
        if (target && target.year !== context.year) {
          delete context.targetVersionId;
          record('targetVersionId', hit.id, 'message', `问题指向 ${context.year} 年，已放弃 ${target.year} 年的对比版本`);
        }
      }
      if (context.actualSnapshotId != null && tableExists(db, 'actual_snapshot_batch')) {
        const batch = db.prepare('SELECT year FROM actual_snapshot_batch WHERE id=?').get(context.actualSnapshotId) as { year: number } | undefined;
        if (batch && batch.year !== context.year) {
          delete context.actualSnapshotId;
          record('actualSnapshotId', hit.id, 'message', `问题指向 ${context.year} 年，已放弃 ${batch.year} 年的已选快照`);
        }
      }
    }
  }
  if (context.budgetVersionId == null) {
    const explicitId = text.match(/版本\s*#?(\d{1,9})/);
    const byId = explicitId ? versions.find((v) => v.id === Number(explicitId[1])) : undefined;
    if (namedVersions.length) {
      const hit = namedVersions[0];
      context.budgetVersionId = hit.row.id;
      record('budgetVersionId', hit.row.id, 'message', hit.reason, hit.row.name);
      if (context.year == null) {
        context.year = hit.row.year;
        record('year', hit.row.year, 'message', `取自版本「${hit.row.name}」的年度`);
      }
    } else if (byId) {
      context.budgetVersionId = byId.id;
      record('budgetVersionId', byId.id, 'message', `命中版本编号 ${byId.id}`, byId.name);
    } else if (inherited.budgetVersionId != null && versions.some((v) => v.id === inherited.budgetVersionId)) {
      context.budgetVersionId = inherited.budgetVersionId;
      const row = versions.find((v) => v.id === inherited.budgetVersionId)!;
      record('budgetVersionId', row.id, 'conversation', '沿用上一轮的版本', row.name);
    } else if (options.defaultVersion) {
      const fallback = defaultVersion(versions, kind);
      if (fallback) {
        context.budgetVersionId = fallback.row.id;
        record('budgetVersionId', fallback.row.id, 'default', fallback.reason, fallback.row.name);
      }
    }
  }

  /* ---------- 对比版本 ---------- */
  if (context.targetVersionId == null) {
    const second = namedVersions.find((hit) => hit.row.id !== context.budgetVersionId);
    if (second) {
      context.targetVersionId = second.row.id;
      record('targetVersionId', second.row.id, 'message', second.reason, second.row.name);
    } else if (/版本对比|版本差异|两个版本|对比版本/.test(text) && inherited.targetVersionId != null) {
      context.targetVersionId = inherited.targetVersionId;
      record('targetVersionId', inherited.targetVersionId, 'conversation', '沿用上一轮的对比版本');
    }
  }

  /* ---------- 实际快照 ---------- */
  // 问题明确指定的快照覆盖页面快照(§6)；即使页面没选快照，显式日期/编号也应生效。
  // 裸月份信号(「3 月的完成情况」)不跨年：年份跟随页面已选年度，只在同年度快照中
  // 匹配——否则 2026 年页面会命中 2025-03-31 这类前年快照，产生混合年度口径。
  // 日期/编号/「最新快照」是强信号，允许跨年；跨年后必须原子地同步年度和预算基线，
  // 不能留下「2025 快照 + 2026 预算版本」再交给一致性校验报错。
  if (options.messageOverride && tableExists(db, 'actual_snapshot_batch')) {
    const allBatches = db.prepare('SELECT id,year,snapshot_date,revision FROM actual_snapshot_batch ORDER BY snapshot_date DESC, revision DESC').all() as BatchRow[];
    const hasExplicitSnapshotSignal = /((?:19|20)\d{2})-(\d{2})-(\d{2})/.test(text)
      || /快照\s*#?\d{1,9}/.test(text)
      || /最新快照|最近快照|最新实际/.test(text);
    const pool = context.year == null || hasExplicitSnapshotSignal
      ? allBatches
      : allBatches.filter((b) => b.year === context.year);
    const hit = pool.length ? matchSnapshot(text, pool) : null;
    if (hit && hit.row.id !== context.actualSnapshotId) {
      const previous = context.actualSnapshotId == null
        ? undefined
        : allBatches.find((b) => b.id === context.actualSnapshotId);
      context.actualSnapshotId = hit.row.id;
      record(
        'actualSnapshotId',
        hit.row.id,
        'message',
        previous
          ? `${hit.reason}，已覆盖页面的快照 ${previous.snapshot_date}`
          : hit.reason,
        hit.row.snapshot_date,
      );

      if (context.year !== hit.row.year) {
        const replacedYear = context.year;
        const dropped: string[] = [];
        context.year = hit.row.year;

        if (context.budgetVersionId != null) {
          const selected = db.prepare('SELECT id,year,name FROM budget_version WHERE id=?').get(context.budgetVersionId) as
            | { id: number; year: number; name: string }
            | undefined;
          if (selected && selected.year !== hit.row.year) {
            const candidates = db.prepare('SELECT id,year,name,status,is_current,kind FROM budget_version WHERE year=? ORDER BY created_at DESC, id DESC').all(hit.row.year) as VersionRow[];
            const fallback = options.defaultVersion ? defaultVersion(candidates, kind) : null;
            if (fallback) {
              context.budgetVersionId = fallback.row.id;
              record(
                'budgetVersionId',
                fallback.row.id,
                'message',
                `快照切换到 ${hit.row.year} 年，已将页面版本「${selected.name}」替换为同年度版本「${fallback.row.name}」`,
                fallback.row.name,
              );
            } else {
              delete context.budgetVersionId;
              dropped.push(`${selected.year} 年预算版本「${selected.name}」`);
            }
          }
        }
        if (context.targetVersionId != null) {
          const target = db.prepare('SELECT year,name FROM budget_version WHERE id=?').get(context.targetVersionId) as { year: number; name: string } | undefined;
          if (target && target.year !== hit.row.year) {
            delete context.targetVersionId;
            dropped.push(`${target.year} 年对比版本「${target.name}」`);
          }
        }

        const droppedReason = dropped.length ? `，并放弃跨年的${dropped.join('、')}` : '';
        record(
          'year',
          hit.row.year,
          'message',
          replacedYear == null
            ? `取自快照 ${hit.row.snapshot_date} 的年度${droppedReason}`
            : `取自快照 ${hit.row.snapshot_date} 的年度，已覆盖页面的 ${replacedYear} 年${droppedReason}`,
        );
      }
    }
  }
  if (context.actualSnapshotId == null && tableExists(db, 'actual_snapshot_batch')) {
    const batches = (context.year == null
      ? db.prepare('SELECT id,year,snapshot_date,revision FROM actual_snapshot_batch ORDER BY snapshot_date DESC, revision DESC').all()
      : db.prepare('SELECT id,year,snapshot_date,revision FROM actual_snapshot_batch WHERE year=? ORDER BY snapshot_date DESC, revision DESC').all(context.year)
    ) as BatchRow[];
    const hit = matchSnapshot(text, batches);
    if (hit) {
      context.actualSnapshotId = hit.row.id;
      record('actualSnapshotId', hit.row.id, 'message', hit.reason, hit.row.snapshot_date);
    } else if (inherited.actualSnapshotId != null && batches.some((b) => b.id === inherited.actualSnapshotId)) {
      context.actualSnapshotId = inherited.actualSnapshotId;
      const row = batches.find((b) => b.id === inherited.actualSnapshotId)!;
      record('actualSnapshotId', row.id, 'conversation', '沿用上一轮的快照', row.snapshot_date);
    }
    // 不指定快照时保持 undefined：报表层会按「未关闭年度取当前累计、已关闭年度取最终快照」解析。
  }

  /* ---------- 组织 ---------- */
  if (tableExists(db, 'org')) {
    const rows = db.prepare('SELECT id,code,name,status FROM org ORDER BY sort_order, id').all() as NodeRow[];
    if (context.orgId == null) {
      const matched = matchNode(text, rows);
      if (matched.hit) {
        context.orgId = matched.hit.row.id;
        record('orgId', matched.hit.row.id, 'message', matched.hit.reason, matched.hit.row.name);
      } else if (matched.ambiguous) {
        // 片段命中多个组织：不猜。上层会据此提示用户，而不是静默按全范围回答。
        ambiguities.push({
          field: 'orgId',
          token: matched.ambiguous.token,
          candidates: matched.ambiguous.candidates.map((row) => ({ id: row.id, code: row.code, name: row.name })),
        });
      } else if (inherited.orgId != null && rows.some((r) => r.id === inherited.orgId)) {
        context.orgId = inherited.orgId;
        const row = rows.find((r) => r.id === inherited.orgId)!;
        record('orgId', row.id, 'conversation', '沿用上一轮的组织范围', row.name);
      }
    } else if (options.messageOverride) {
      // 问题明确写出的组织覆盖页面范围；名称有歧义时不覆盖，照常返回候选(§6)。
      const matched = matchNode(text, rows);
      if (matched.hit && matched.hit.row.id !== context.orgId) {
        const previous = rows.find((row) => row.id === context.orgId);
        context.orgId = matched.hit.row.id;
        record('orgId', matched.hit.row.id, 'message', `${matched.hit.reason}，已覆盖页面的组织「${previous?.name ?? ''}」`, matched.hit.row.name);
      } else if (matched.ambiguous) {
        ambiguities.push({
          field: 'orgId',
          token: matched.ambiguous.token,
          candidates: matched.ambiguous.candidates.map((row) => ({ id: row.id, code: row.code, name: row.name })),
        });
      }
    }
  }

  /* ---------- 科目 ---------- */
  if (tableExists(db, 'account')) {
    const rows = db.prepare('SELECT id,code,name,status FROM account ORDER BY sort_order, id').all() as NodeRow[];
    if (context.accountId == null) {
      const matched = matchNode(text, rows);
      if (matched.hit) {
        context.accountId = matched.hit.row.id;
        record('accountId', matched.hit.row.id, 'message', matched.hit.reason, matched.hit.row.name);
      } else if (matched.ambiguous) {
        ambiguities.push({
          field: 'accountId',
          token: matched.ambiguous.token,
          candidates: matched.ambiguous.candidates.map((row) => ({ id: row.id, code: row.code, name: row.name })),
        });
      } else if (inherited.accountId != null && rows.some((r) => r.id === inherited.accountId)) {
        context.accountId = inherited.accountId;
        const row = rows.find((r) => r.id === inherited.accountId)!;
        record('accountId', row.id, 'conversation', '沿用上一轮的科目范围', row.name);
      }
    } else if (options.messageOverride) {
      const matched = matchNode(text, rows);
      if (matched.hit && matched.hit.row.id !== context.accountId) {
        const previous = rows.find((row) => row.id === context.accountId);
        context.accountId = matched.hit.row.id;
        record('accountId', matched.hit.row.id, 'message', `${matched.hit.reason}，已覆盖页面的科目「${previous?.name ?? ''}」`, matched.hit.row.name);
      } else if (matched.ambiguous) {
        ambiguities.push({
          field: 'accountId',
          token: matched.ambiguous.token,
          candidates: matched.ambiguous.candidates.map((row) => ({ id: row.id, code: row.code, name: row.name })),
        });
      }
    }
  }

  /* ---------- 导入批次 ---------- */
  if (context.importBatchId == null && tableExists(db, 'import_batch')) {
    const explicit = text.match(/(?:导入)?批次\s*#?(\d{1,9})/);
    if (explicit) {
      const row = db.prepare('SELECT id FROM import_batch WHERE id=?').get(Number(explicit[1])) as { id: number } | undefined;
      if (row) {
        context.importBatchId = row.id;
        record('importBatchId', row.id, 'message', `命中导入批次 ${row.id}`);
      }
    } else if (/最近一次导入|最新导入|刚导入|上次导入/.test(text)) {
      const row = db.prepare('SELECT id FROM import_batch ORDER BY id DESC LIMIT 1').get() as { id: number } | undefined;
      if (row) {
        context.importBatchId = row.id;
        record('importBatchId', row.id, 'default', `取最近一次导入批次 ${row.id}`);
      }
    } else if (inherited.importBatchId != null) {
      const row = db.prepare('SELECT id FROM import_batch WHERE id=?').get(inherited.importBatchId) as { id: number } | undefined;
      if (row) {
        context.importBatchId = row.id;
        record('importBatchId', row.id, 'conversation', '沿用上一轮的导入批次');
      }
    }
  }

  return { context, resolution, ambiguities };
}

export interface ContextDigest {
  resolved: AssistantContext;
  resolution: ContextResolution[];
  years: number[];
  versions: { id: number; year: number; name: string; status: string; kind: string; isCurrent: boolean }[];
  snapshots: { id: number; year: number; snapshotDate: string; revision: number }[];
  org: { id: number; code: string; name: string } | null;
  account: { id: number; code: string; name: string; type: string } | null;
  closedYears: number[];
}

/**
 * 给模型的轻量上下文摘要。只含 ID、名称和状态，不含任何金额或明细，
 * 让模型知道「有哪些年度/版本/快照可用、当前解析到了什么」，再自行决定调用哪些只读工具。
 */
export function contextDigest(db: DB, context: AssistantContext, resolution: ContextResolution[]): ContextDigest {
  const digest: ContextDigest = {
    resolved: context,
    resolution,
    years: [],
    versions: [],
    snapshots: [],
    org: null,
    account: null,
    closedYears: [],
  };
  if (tableExists(db, 'budget_version')) {
    digest.years = (db.prepare('SELECT DISTINCT year FROM budget_version ORDER BY year DESC LIMIT 20').all() as { year: number }[]).map((r) => r.year);
    const rows = (context.year == null
      ? db.prepare('SELECT id,year,name,status,is_current,kind FROM budget_version ORDER BY year DESC, created_at DESC, id DESC LIMIT 30').all()
      : db.prepare('SELECT id,year,name,status,is_current,kind FROM budget_version WHERE year=? ORDER BY created_at DESC, id DESC LIMIT 30').all(context.year)
    ) as VersionRow[];
    digest.versions = rows.map((row) => ({ id: row.id, year: row.year, name: row.name, status: row.status, kind: row.kind || 'budget', isCurrent: row.is_current === 1 }));
  }
  if (tableExists(db, 'actual_snapshot_batch')) {
    const rows = (context.year == null
      ? db.prepare('SELECT id,year,snapshot_date,revision FROM actual_snapshot_batch ORDER BY snapshot_date DESC, revision DESC LIMIT 20').all()
      : db.prepare('SELECT id,year,snapshot_date,revision FROM actual_snapshot_batch WHERE year=? ORDER BY snapshot_date DESC, revision DESC LIMIT 20').all(context.year)
    ) as BatchRow[];
    digest.snapshots = rows.map((row) => ({ id: row.id, year: row.year, snapshotDate: row.snapshot_date, revision: row.revision }));
  }
  if (context.orgId != null && tableExists(db, 'org')) {
    const row = db.prepare('SELECT id,code,name FROM org WHERE id=?').get(context.orgId) as { id: number; code: string; name: string } | undefined;
    digest.org = row ?? null;
  }
  if (context.accountId != null && tableExists(db, 'account')) {
    const row = db.prepare('SELECT id,code,name,type FROM account WHERE id=?').get(context.accountId) as { id: number; code: string; name: string; type: string } | undefined;
    digest.account = row ?? null;
  }
  if (tableExists(db, 'actual_year_state')) {
    // 年度关闭在库里记为 frozen(见 migrations 的 actual_year_state.status)。
    digest.closedYears = (db.prepare("SELECT year FROM actual_year_state WHERE status='frozen' ORDER BY year DESC LIMIT 20").all() as { year: number }[]).map((r) => r.year);
  }
  return digest;
}
