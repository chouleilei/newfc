import { DOMAIN_READ_RULES, DOMAIN_PAGE_INTENTS, isDomainIntent, type DomainReadIntent } from './domain-intents';
/**
 * 意图识别(方案《AI助手完整方案》3「总体交互原则」的「识别意图」一步)。
 *
 * 定位：**模型不可用时的兜底路由**。模型可用时由模型自己调用只读工具，
 * 这里的结果只作为提示词里的 hint。这样做的原因是纯正则有三个固有缺陷：
 *
 * 1. 关键词重叠会重复取数(问「利润为什么低于预算」同时命中执行分析与差异归因，
 *    同一份 completionReport 被算两遍)；
 * 2. 换个说法就漏(「哪个厂亏得最多」不含任何原关键词)；
 * 3. 宽泛词误判(裸「对比」被当成版本对比，强行要求 targetVersionId)。
 *
 * 因此这里做三件事：扩充同义词、按语义蕴含去重、把宽泛词限定成词组。
 */

export type ReadIntent = DomainReadIntent
  | 'budget_versions'
  | 'actual_snapshots'
  | 'org_tree'
  | 'account_tree'
  | 'import'
  | 'finance_conversion'
  | 'operation_log'
  | 'execution'
  | 'attribution'
  | 'report'
  | 'trend'
  | 'version_variance'
  | 'anomalies'
  | 'budget_quality'
  | 'accuracy'
  | 'historical_comparison'
  | 'budget_progress'
  | 'structure'
  | 'metric_catalog'
  | 'insights'
  | 'master_health'
  | 'consistency_check'
  | 'calculation_rules'
  | 'cleaning_config'
  | 'cell_note';

export type WriteIntent = 'copy_budget' | 'budget_draft' | 'scenario' | 'bulk_adjustment' | 'basis_text' | 'export';

interface Rule<T> {
  intent: T;
  pattern: RegExp;
  /** 命中后写进 hint，便于排查为什么走了这条路由 */
  label: string;
}

/**
 * 只读意图规则。同义词覆盖过去问不到的口语化说法：
 * 超支/亏/省了/拖后腿/垫底/排名/慢了/快了 等。
 */
const READ_RULES: Rule<ReadIntent>[] = [
  ...DOMAIN_READ_RULES,
  { intent: 'budget_versions', pattern: /版本列表|预算版本|预测版本|有哪些版本|列出版本|定稿|草稿|归档|当前生效/, label: '版本' },
  { intent: 'actual_snapshots', pattern: /实际数|实际值|累计实际|快照|补录|实际录入|实际到哪/, label: '实际与快照' },
  { intent: 'org_tree', pattern: /组织树|组织结构|组织列表|有哪些组织|下属单位|子公司列表/, label: '组织树' },
  { intent: 'account_tree', pattern: /科目树|科目结构|科目列表|有哪些科目|预设表/, label: '科目树' },
  { intent: 'import', pattern: /导入|校验失败|报错行|未匹配|重复行|模板对不上|导不进/, label: '导入' },
  // 财务实际数转换是独立模块(余额表/官方利润表/序时簿 → 标准实际数文件)，
  // 与「Excel 导入」不是同一条链路，必须单独路由，否则只能拿到导入批次列表。
  {
    intent: 'finance_conversion',
    pattern: /财务转换|财务数据转换|财务系统转换|余额表|科目余额|官方利润表|利润表勾稽|勾稽|序时簿|凭证序时|映射版本|科目映射|组织映射|转换批次|并行试运行|拥有范围|财务系统/,
    label: '财务转换',
  },
  { intent: 'operation_log', pattern: /操作日志|审计日志|操作记录|谁改的|改动记录/, label: '操作日志' },

  // 执行分析：完成率、进度、超支、节奏。「执行」在本领域固定指预算执行，可单独作为信号。
  // 「完成了多少 / 收了多少 / 花了多少 / 实际是多少」是实测中最常见却原来漏掉的问法：
  // 「2026年发电量完成了多少」原本一个意图都不命中，只能退化成版本列表。
  {
    intent: 'execution',
    pattern: /执行|完成情况|完成率|完成得?怎么样|完成了?多少|进度|超支|超预算|超出预算|省了|结余|节奏|快了|慢了|达标|差多少|(?:收入|成本|费用|利润|电量|发电量|产量|人数|数量|金额|实际|预算).{0,6}(?:是)?多少|多少.{0,4}(?:完成|执行)/,
    label: '执行分析',
  },
  // 差异归因：为什么、谁贡献、排名、垫底。
  // 「为什么」必须跟一个业务判断词，否则「为什么是负数」这类名词解释会被误判成归因。
  {
    intent: 'attribution',
    pattern: /归因|为什么.{0,12}(?:低|高|差|少|多|超|亏|降|涨|升|长|没完成|不达标)|什么原因|原因是|拆解|逐层|贡献|谁导致|哪个.{0,6}(?:最多|最大|最差|最高|最低)|排名|排行|排个名|前几名|垫底|拖后腿|拉低|亏得?最|差距最大/,
    label: '差异归因',
  },
  // 报告组稿
  { intent: 'report', pattern: /报告|月报|简报|复盘|年度总结|讨论材料|汇报材料|写一份|出一份/, label: '报告生成' },
  { intent: 'trend', pattern: /趋势|走势|逐月|按月看|年内变化|曲线/, label: '年内趋势' },
  // 「对比」必须成词组，避免「和去年对比」被当成版本对比
  { intent: 'version_variance', pattern: /版本对比|版本差异|版本之间|两个版本|与.{1,20}版本比|改了什么|调整了什么/, label: '版本对比' },
  { intent: 'anomalies', pattern: /异常|突增|突降|离群|不合理|可疑|预警|偏离|波动大/, label: '异常检查' },
  { intent: 'budget_quality', pattern: /质量|门禁|必填|漏填|没填|缺.{0,3}依据|测算依据|能不能定稿|定稿检查|覆盖率/, label: '质量检查' },
  { intent: 'accuracy', pattern: /准确率|准确性|预算准不准|偏差率/, label: '预算准确率' },
  { intent: 'historical_comparison', pattern: /历年|往年|各年度|历史对比|同比|逐年/, label: '历年对比' },
  // 编制进度：谁还没填、编到哪了。「进度」单独出现时归执行分析(见上)，这里只认编制/填报语境。
  { intent: 'budget_progress', pattern: /编制进度|填报进度|进度总览|还没填|没填完|没编完|编完了吗|未开始编|哪些(?:单位|组织|公司).{0,4}(?:没|未).{0,4}(?:填|报|编)/, label: '编制进度' },
  // 结构分析：占比/构成。「结构」单独出现太宽泛(组织结构、科目结构各有专属意图)。
  { intent: 'structure', pattern: /结构分析|结构占比|占比|构成|比重/, label: '结构分析' },
  { intent: 'metric_catalog', pattern: /指标列表|有哪些指标|报表指标|指标定义|指标公式|指标怎么算|指标口径/, label: '指标目录' },
  // 已保存的洞察记录；与 report(现场组稿)互斥,见 detectIntents 里的双向消歧。
  { intent: 'insights', pattern: /洞察|已保存的(?:分析|报告)|保存过的(?:分析|报告)/, label: '洞察记录' },
  { intent: 'master_health', pattern: /主数据健康|健康检查|健康体检|体检|孤儿(?:科目|组织)|重复(?:编码|名称)/, label: '主数据体检' },
  { intent: 'consistency_check', pattern: /一致性检查|数据一致性|一致性核对|数据核对|数据体检/, label: '一致性检查' },
  // 不含裸「测算」:那属于写意图 scenario(情景测算)的信号词。
  { intent: 'calculation_rules', pattern: /测算模板|测算规则|计算规则|测算公式/, label: '测算模板' },
  { intent: 'cleaning_config', pattern: /清洗|别名/, label: '清洗配置' },
  // 单元格备注/依据查询：与「质量检查」(缺.{0,3}依据/测算依据 的门禁视角)和写意图「依据草稿」
  // (测算依据|依据文本|写一段说明)分开——这里只认「查看既有备注内容」的问法。
  { intent: 'cell_note', pattern: /备注|附注|的依据|依据是|有何依据|有什么依据|写了什么依据/, label: '单元格备注' },
];

/**
 * 语义蕴含：父意图的确定性结果里已经包含子意图的数据，命中父意图时不再重复计算子意图。
 * 例如 reportDraft 内部会调执行分析、差异归因、异常与质量、年内趋势。
 */
const IMPLIES: Partial<Record<ReadIntent, ReadIntent[]>> = {
  report: ['execution', 'attribution', 'anomalies', 'budget_quality', 'trend'],
  attribution: ['execution'],
};

/**
 * 组稿语气：「写一份/出一份/生成一份/起草一篇」。只认「动词 + 量词」的祈使句式,
 * 不认 bare 「生成」——「最近生成了哪些洞察报告」是查询已保存记录,不是创建诉求。
 */
const REPORT_CREATION = /(?:写|出|生成|做|起草|整理).{0,3}(?:份|个|篇)/;

const WRITE_RULES: Rule<WriteIntent>[] = [
  { intent: 'copy_budget', pattern: /复制|拷贝|另存为|基于.{0,10}版本.{0,6}新建/, label: '复制版本' },
  { intent: 'budget_draft', pattern: /生成.{0,6}草案|创建.{0,6}草案|新建.{0,6}(?:预算|预测)|编制.{0,6}(?:草案|预算)|按.{0,10}(?:增长|下降).{0,10}生成/, label: '生成草案' },
  { intent: 'scenario', pattern: /情景|测算|假设|如果.{0,10}(?:增长|下降|上升|减少)|敏感性|反推/, label: '情景测算' },
  { intent: 'bulk_adjustment', pattern: /批量(?:调整|修改|录入|填)|统一(?:调整|改)/, label: '批量调整' },
  { intent: 'basis_text', pattern: /测算依据|编制说明|填写说明|依据文本|写一段说明/, label: '依据草稿' },
  { intent: 'export', pattern: /导出|下载.{0,6}(?:表|文件|excel|csv)|生成.{0,6}(?:excel|csv|表格文件)/i, label: '导出' },
];

/** 全部合法只读意图，用于校验从会话历史读回的意图。 */
export const READ_INTENTS: ReadonlySet<ReadIntent> = new Set(READ_RULES.map((rule) => rule.intent));

/** 意图 → 中文标签，用于提示词与前端展示。 */
const READ_LABEL = new Map<ReadIntent, string>(READ_RULES.map((rule) => [rule.intent, rule.label]));

export function readIntentLabel(intent: ReadIntent): string {
  return READ_LABEL.get(intent) ?? intent;
}

export interface IntentDetection {
  read: ReadIntent[];
  write: WriteIntent[];
  /** 命中说明，形如「执行分析(超支)」，写入提示词与响应，便于用户看懂路由依据 */
  hints: string[];
  /** 因语义蕴含被抑制的意图，用于解释「为什么没单独跑执行分析」 */
  suppressed: ReadIntent[];
  /** 本轮一个意图都没命中、判定为纯追问时沿用的上一轮意图(见 withInheritedIntents) */
  inheritedRead: ReadIntent[];
}

export function detectIntents(message: string, page?: string): IntentDetection {
  const text = String(message || '');
  const matched: { intent: ReadIntent; label: string; keyword: string }[] = [];
  for (const rule of READ_RULES) {
    const hit = text.match(rule.pattern);
    if (hit) matched.push({ intent: rule.intent, label: rule.label, keyword: hit[0] });
  }
  const present = new Set(matched.map((m) => m.intent));
  const suppressed = new Set<ReadIntent>();
  for (const [parent, children] of Object.entries(IMPLIES) as [ReadIntent, ReadIntent[]][]) {
    if (!present.has(parent)) continue;
    for (const child of children) {
      if (present.has(child)) {
        present.delete(child);
        suppressed.add(child);
      }
    }
  }
  // 「洞察报告」双向消歧:insights 与 report 同时命中时,默认把「报告」当作已保存记录的
  // 同义词,抑制现场组稿,避免一次聊天无谓地重算整份报告草稿;但带组稿语气(「写一份
  // 洞察报告」)时创建诉求优先,反过来抑制 insights——否则创建请求会被路由成列已保存清单。
  if (present.has('insights') && present.has('report')) {
    const loser: ReadIntent = REPORT_CREATION.test(text) ? 'insights' : 'report';
    present.delete(loser);
    suppressed.add(loser);
  }
  // 「导入模板的备注列怎么填」这类问题里「备注」指导入文件的列，不是单元格备注。
  for (const owner of ['import', 'finance_conversion'] as const) {
    if (present.has(owner) && present.has('cell_note')) {
      present.delete('cell_note');
      suppressed.add('cell_note');
    }
  }
  const domainReads = [...present].filter(isDomainIntent);
  const pageIntent = page && DOMAIN_PAGE_INTENTS[page];
  const explicitBudget = /经营预算|预算版本|预算编制|预算执行月报/.test(text) || (!domainReads.length && !pageIntent && /科目|利润/.test(text));
  if (domainReads.length && !explicitBudget) {
    for (const intent of [...present]) {
      if (!isDomainIntent(intent) && !['org_tree', 'account_tree', 'operation_log'].includes(intent)) { present.delete(intent); suppressed.add(intent); }
    }
  }
  if (pageIntent && !domainReads.length && !explicitBudget && !/你好|谢谢|再见/.test(text)) {
    for (const intent of [...present]) { present.delete(intent); suppressed.add(intent); }
    present.add(pageIntent);
  }
  const write: WriteIntent[] = [];
  for (const rule of WRITE_RULES) if (rule.pattern.test(text) && (explicitBudget || ![...present].some(isDomainIntent))) write.push(rule.intent);
  const hints = matched
    .filter((m) => present.has(m.intent))
    .map((m) => `${m.label}(${m.keyword})`);
  return {
    read: [...present],
    write,
    hints: [...new Set(hints)],
    suppressed: [...suppressed],
    inheritedRead: [],
  };
}

/**
 * 纯追问信号。
 *
 * 用于判断「本轮一个意图都没命中」时，应该沿用上一轮的意图，还是当成新话题。
 * 只认显式的追问标记(话题延续词、句尾语气词、序数/层级追问)，不靠长度猜，
 * 这样「你好」「导出一下」这类消息不会被误当成追问。
 */
const FOLLOW_UP_RULES: RegExp[] = [
  /^\s*(?:那|那么|然后|接着|再|还有|另外|以及|顺便|同样|同理)/,
  /(?:呢|呐)\s*[?？]?\s*$/,
  /第\s*[二三四五六七八九十百]+\s*(?:名|位|个|大|高|低)/,
  /第\s*\d+\s*(?:名|位|个)/,
  /下一\s*(?:个|位|名|层|级)/,
  /(?:往下|向下|再往|继续|细分|展开|拆|细看|深入|下钻)/,
  /(?:上面|上述|刚才|之前那|前面那|这个|那个|它)/,
];

export function looksLikeFollowUp(message: string): boolean {
  const text = String(message || '').trim();
  if (!text) return false;
  return FOLLOW_UP_RULES.some((pattern) => pattern.test(text));
}

/**
 * 用户在聊天里试图直接确认写操作。
 *
 * 实测背景：模型会说「请回复确认执行」，用户照做以后什么都不会发生(确认必须走
 * 预览卡片 + 确认令牌)。识别出这种意图后，后端补一条确定性提示说明真实路径，
 * 并把上一轮的操作建议重新挂回来，避免用户一回话就把可预览的 action 丢了。
 *
 * 只认「短句 + 明确确认词」，避免把「确认一下预算版本状态」这类查询当成确认。
 */
const WRITE_CONFIRM_RULES: RegExp[] = [
  /* 单独的「好的」「可以」「OK」「没问题」是日常应答,不是确认写操作——
     用户随口一句「好」就挂出上一轮操作卡片与确认引导,属于误导。
     确认词必须带动作语义(确认/确定/执行/提交/落库/写入/保存)。 */
  /^\s*(?:确认|确定|确认执行|确定执行|执行吧?|就这样(?:吧|办)?|同意执行)\s*[。.!！~]*\s*$/,
  /^\s*(?:请|帮我|麻烦)?\s*(?:确认|确定|执行|提交|落库|写入|保存)\s*(?:一下|吧|执行|操作)?\s*[。.!！~]*\s*$/,
  /确认令牌|确认执行(?:吧|操作)?[。.!！]?$/,
];

export function looksLikeWriteConfirmation(message: string): boolean {
  const text = String(message || '').trim();
  if (!text || text.length > 40) return false;
  return WRITE_CONFIRM_RULES.some((pattern) => pattern.test(text));
}

/**
 * 纯追问时沿用上一轮的只读意图。
 *
 * 背景：意图识别只看当轮消息，所以「哪个厂亏得最多」之后追问「那第二名呢」
 * 会一个意图都不命中，`queryFacts` 落到兜底分支只返回版本列表——上下文虽然
 * 继承到了(年度/版本/组织)，话题却断了。模型路由时模型能自己从历史里看懂，
 * 但模板降级模式下没人补这一步，所以在这里补。
 *
 * 触发条件(三者同时满足)，尽量保守以免把新话题误接到旧意图上：
 * 1. 本轮既没有只读意图也没有写意图；
 * 2. 上一轮有可继承的只读意图；
 * 3. 消息带追问标记，或本轮从消息里解析出了新的组织/科目范围(纯缩范围追问，如「上海公司呢」)。
 *
 * `report` 不参与继承：重新组一份完整报告代价高，且追问通常是想看某一块细节，
 * 改为继承它蕴含的差异归因。
 */
const INHERIT_REWRITE: Partial<Record<ReadIntent, ReadIntent>> = { report: 'attribution' };

export function withInheritedIntents(
  detection: IntentDetection,
  previousRead: readonly string[],
  message: string,
  options: { scopeFromMessage?: boolean } = {},
): IntentDetection {
  if (detection.read.length || detection.write.length) return detection;
  const previous = previousRead.filter((value): value is ReadIntent => READ_INTENTS.has(value as ReadIntent));
  if (!previous.length) return detection;
  if (!looksLikeFollowUp(message) && !options.scopeFromMessage) return detection;
  const rewritten = [...new Set(previous.map((intent) => INHERIT_REWRITE[intent] ?? intent))];
  return {
    ...detection,
    read: rewritten,
    inheritedRead: rewritten,
    hints: rewritten.map((intent) => `${readIntentLabel(intent)}(沿用上一轮)`),
  };
}

/**
 * 需要预算版本才能计算的意图。只有命中这些意图时才把上下文回退到
 * 「该年度当前生效版本」；纯列表类问题(如「列出预算版本」)不应被悄悄缩小范围。
 */
const VERSION_REQUIRED = new Set<ReadIntent>([
  'execution', 'attribution', 'report', 'trend', 'anomalies', 'budget_quality', 'version_variance',
  'budget_progress', 'structure',
]);

/** 本轮是否需要一个默认预算版本(读意图或写意图任一需要)。 */
export function needsBudgetVersion(detection: IntentDetection): boolean {
  if (detection.read.some((intent) => VERSION_REQUIRED.has(intent))) return true;
  return detection.write.some((intent) => intent === 'copy_budget' || intent === 'scenario' || intent === 'bulk_adjustment' || intent === 'export');
}

/** 报告类型由消息决定：讨论材料 / 年度复盘 / 执行月报。 */
export function detectReportKind(message: string): 'monthly_execution' | 'annual_review' | 'budget_discussion' {
  const text = String(message || '');
  if (/讨论材料|汇报材料|讨论/.test(text)) return 'budget_discussion';
  if (/复盘|年度总结|全年总结/.test(text)) return 'annual_review';
  return 'monthly_execution';
}

/** 归因方向：只看不利项 / 只看有利项 / 全部。 */
export function detectDirection(message: string): 'favorable' | 'unfavorable' | 'all' {
  const text = String(message || '');
  if (/不利|超支|亏|拖后腿|拉低|没完成|差得最|垫底/.test(text)) return 'unfavorable';
  if (/有利|节约|省了|超额完成|做得好|贡献最大/.test(text)) return 'favorable';
  return 'all';
}

const CN_DIGITS: Record<string, number> = { 一: 1, 二: 2, 两: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9, 十: 10 };

/**
 * 名次聚焦：「第二名」「第 3 位」「下一个」这类追问要看排行榜的第 N 项。
 *
 * 背景(实测)：模板模式下「那第二名呢」虽然正确沿用了差异归因意图，但摘要固定打印前三名，
 * 返回的文字和上一轮一字不差——话题接上了，问题没回答。解析出 N 之后由摘要按名次输出。
 * 「下一个/下一名」按第 2 名处理(上一轮默认讲的是第 1 名)。
 */
export function detectRankFocus(message: string): number | null {
  const text = String(message || '').trim();
  if (!text) return null;
  const digit = /第\s*(\d{1,2})\s*(?:名|位|个|大|高|低)/.exec(text);
  if (digit) {
    const value = Number(digit[1]);
    return value >= 1 && value <= 50 ? value : null;
  }
  const chinese = /第\s*([一二两三四五六七八九十]{1,2})\s*(?:名|位|个|大|高|低)/.exec(text);
  if (chinese) {
    const raw = chinese[1];
    if (CN_DIGITS[raw] != null) return CN_DIGITS[raw];
    // 十一~十九
    if (raw.length === 2 && raw[0] === '十' && CN_DIGITS[raw[1]] != null) return 10 + CN_DIGITS[raw[1]];
    if (raw.length === 2 && raw[1] === '十' && CN_DIGITS[raw[0]] != null) return CN_DIGITS[raw[0]] * 10;
    return null;
  }
  if (/下一\s*(?:个|位|名)/.test(text)) return 2;
  return null;
}
