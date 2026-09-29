/**
 * 业务解释词典(方案《AI助手完整方案》4.1「业务解释」)。
 *
 * 解释字段、状态、金额方向、万元/元/分换算和完成率。全部内容是后端固化的
 * 业务口径，不依赖模型；模型不可用时助手仍能给出准确解释。
 */
import { QUANTITY_SCALE, SIGN_BY_TYPE, centsToYuanString, wanStringToYuanString, yuanStringToCents } from '../core/money';

export interface GlossaryEntry {
  key: string;
  term: string;
  category: 'field' | 'status' | 'sign' | 'unit' | 'rate' | 'snapshot' | 'quantity' | 'quality' | 'import';
  keywords: string[];
  text: string;
  /** 确定性示例：由 core/money 实际计算得出，不是硬编码文案 */
  examples?: string[];
  reference?: string;
}

const wanExample = (wan: string) => {
  const yuan = wanStringToYuanString(wan);
  return `${wan} 万元 = ${yuan} 元 = ${yuanStringToCents(yuan)} 分`;
};

export const GLOSSARY: GlossaryEntry[] = [
  {
    key: 'sign_direction',
    term: '金额方向(利润方向符号)',
    category: 'sign',
    keywords: ['金额方向', '符号', '正负', '负数', '为什么是负', '利润方向', '冲减', '冲回'],
    text: '存储与 API 统一使用利润方向带符号整数分：收入符号 +1，成本与费用符号 -1。界面录入与展示一律用正数业务金额，后端在写入时转符号、在展示时翻正。负数录入表示冲减或冲回。差异 = 实际 − 预算(带符号)，正数表示对利润有利。',
    examples: [
      `收入符号 ${SIGN_BY_TYPE.income}，成本符号 ${SIGN_BY_TYPE.cost}，费用符号 ${SIGN_BY_TYPE.expense}`,
      `界面 100.00 元费用 → 存储 ${-yuanStringToCents('100.00')} 分 → 展示 ${centsToYuanString(yuanStringToCents('100.00'))} 元`,
    ],
    reference: 'backend/src/core/money.ts',
  },
  {
    key: 'unit_conversion',
    term: '万元 / 元 / 分换算',
    category: 'unit',
    keywords: ['万元', '单位', '换算', '元', '分', '精度', '小数'],
    text: '存储与接口传输使用整数分或元字符串；前端界面统一按万元(两位小数)录入与展示，提交时 ×10000、加载时 ÷10000，使用十进制字符串换算，无浮点误差。注意万元两位小数只对应百元精度，重新保存存量非整百元数据时尾数会四舍五入。',
    examples: [wanExample('1.00'), wanExample('1.2345'), wanExample('0.01')],
    reference: 'frontend/src/utils/money.ts / backend/src/core/money.ts',
  },
  {
    key: 'completion_rate',
    term: '完成率与时间进度',
    category: 'rate',
    keywords: ['完成率', '进度', '时间进度', '节奏', '偏差', 'rate', 'pace'],
    text: '完成率 R = 实际展示值 / 预算展示值(均为翻正后的无符号业务金额)。预算展示值为 0 时不计算完成率，返回 rateSpecial=na_zero_budget；预算展示值为负返回 na_negative_budget；实际与预算方向相反返回 opposite_direction。时间进度 T 为均匀自然日进度(截至日期 / 全年天数)，进度偏差 P = R − T，仅用于节奏分析，不代表月度预算。',
    examples: ['预算 100、实际 80 → 完成率 80%；预算 0、实际 5 → 完成率不适用(na_zero_budget)'],
    reference: 'backend/src/modules/report/report.service.ts makeCell',
  },
  {
    key: 'variance',
    term: '差异(variance)与有利/不利',
    category: 'field',
    keywords: ['差异', 'variance', '有利', '不利', 'favorable'],
    text: '差异 varianceCents = 实际 − 预算，按带符号利润方向计算：正数为 favorable(对利润有利)，负数为 unfavorable。收入少完成得到负差异，费用少花得到正差异。数量科目单独给出 varianceQuantity，不与金额混算。',
    reference: 'backend/src/modules/report/report.service.ts',
  },
  {
    key: 'version_status',
    term: '预算版本状态',
    category: 'status',
    keywords: ['状态', '草稿', 'draft', '定稿', 'locked', '归档', 'archived', '当前生效', 'is_current', '版本'],
    text: 'draft(编制中,可编辑) → locked(定稿,不可修改) → archived(归档)。定稿需通过质量门禁；当前生效版本由 is_current 标记，预算与预测各自维护一个当前生效版本，修订走「复制新草稿」。助手的写操作永远不会修改 locked/archived 版本。',
    reference: 'backend/src/modules/budget/budget.service.ts',
  },
  {
    key: 'snapshot',
    term: '树快照与历史口径',
    category: 'snapshot',
    keywords: ['快照', '树快照', '口径', '历史', 'snapshot', '结构调整'],
    text: '预算版本与实际快照批次都绑定不可变的组织树/科目树快照。历史报表按绑定快照计算，不随当前树结构变化重算。实际数 = 当前值(actual_current) + 全量快照(同事务写入)；已关闭年度一律读年度关闭时指定的最终快照。同日重存生成新修订并替代，历史修订保留。',
    reference: 'docs/预算系统方案.md',
  },
  {
    key: 'quantity',
    term: '数量型科目',
    category: 'quantity',
    keywords: ['数量', '电量', '电价', '人数', '单位', 'quantity', '缩放'],
    text: `数量科目是第四类科目(电量、电价、税率、人数等)，按 10^4 = ${QUANTITY_SCALE} 缩放为整数存储(四位小数)，带计量单位与汇总方式(可加总 sum / 不汇总 none)。数量与金额完全隔离：不参与金额汇总，也不进入报表指标计算。汇总方式为 none 的科目跨组织展示算术平均值。`,
    examples: [`12.3456 → ${Math.round(12.3456 * QUANTITY_SCALE)}(缩放整数)`],
    reference: 'backend/src/core/money.ts',
  },
  {
    key: 'quality_gate',
    term: '预算质量门禁',
    category: 'quality',
    keywords: ['质量', '门禁', '必填', '依据', '测算', 'blocking', '定稿检查'],
    text: '质量报告分 blocking 与 warning：必填科目未填报(REQUIRED_VALUE_MISSING)、有数值但缺测算依据(BASIS_MISSING)、结构非法(STRUCTURE_INVALID)为 blocking，存在 blocking 时不能定稿；测算模板输入完整但未试算(CALCULATION_OUTPUT_MISSING)为 warning。覆盖率 = 已填报组合 / 适用组合。',
    reference: 'backend/src/modules/check/budget-quality.ts',
  },
  {
    key: 'import_batch',
    term: '导入批次与撤销',
    category: 'import',
    keywords: ['导入', '批次', '预览', '撤销', '回滚', '指纹', 'sha'],
    text: '导入文件先生成持久预览批次(pending)，确认后写入(committed)，可在相关单元格未被后续修改时安全撤销(rolled_back)。批次保留原文件与 SHA-256 指纹用于追溯。全部行校验失败时不写入任何数据。',
    reference: 'backend/src/modules/import/import.service.ts',
  },
  {
    key: 'assistant_action',
    term: '助手操作状态(预览/确认/取消)',
    category: 'status',
    keywords: ['预览', '确认', '取消', '过期', '令牌', 'action', 'pending', '幂等'],
    text: '助手的所有写操作都是 pending 预览 + 确认令牌：pending → confirmed / cancelled / expired，单向转换。确认时重新校验令牌、有效期、预览基线指纹、版本状态、绑定树快照与金额/数量规则；任何一项失败整体回滚。相同 idempotencyKey 返回原 action，重复确认不会重复写入。',
    reference: 'backend/AI_ASSISTANT.md',
  },
  {
    key: 'actual_source',
    term: '实际数取数来源',
    category: 'field',
    keywords: ['实际来源', 'actualSource', '当前实际', '最终快照', '截至'],
    text: 'actualSource 取值：current(未关闭年度的当前累计)、snapshot(指定快照批次)、final(已关闭年度最终快照)、none(无实际数据)。asOfDate 为实际数据截至日期，时间进度按该日期计算。',
    reference: 'backend/src/modules/report/report.service.ts resolveActualSource',
  },
];

/** 命中关键词的解释条目；不命中时返回空数组，由调用方决定是否给出总览。 */
export function explainTerms(message: string, limit = 4): GlossaryEntry[] {
  const text = String(message || '');
  if (!text.trim()) return [];
  const scored = GLOSSARY.map((entry) => {
    let score = 0;
    if (text.includes(entry.term)) score += 5;
    for (const keyword of entry.keywords) if (keyword && text.toLowerCase().includes(keyword.toLowerCase())) score += 2;
    return { entry, score };
  }).filter((row) => row.score > 0).sort((a, b) => b.score - a.score);
  return scored.slice(0, Math.max(1, Math.min(limit, GLOSSARY.length))).map((row) => row.entry);
}

/** 是否是一个"解释/名词"类问题(用于判断要不要附带词典事实)。 */
export function looksLikeExplainQuestion(message: string): boolean {
  return /解释|什么意思|是什么|怎么算|如何计算|口径|为什么是负|换算|含义|定义/.test(String(message || ''));
}
