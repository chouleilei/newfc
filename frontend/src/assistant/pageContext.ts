/**
 * 页面上下文推导：把当前路由(路径 + 查询参数)翻译成 AI 助手的上下文。
 *
 * 两条硬约束：
 * 1. page 键直接复用后端 `backend/src/assistant/navigation.ts` 的 page 标识，
 *    前后端对「哪一页」有唯一一套说法，不另造词表；
 * 2. 这里推导出的值属于 **routeContext**：永不持久化、永不写回用户手动筛选。
 *    持久化只发生在 manualContext(见 AssistantProvider)。
 */
import type { AssistantContext } from '../api/assistant';

/** 可推导的上下文字段(page 单独传，不参与字段合并) */
export type ContextField = Exclude<keyof AssistantContext, 'page'>;

export interface RoutePageInfo {
  /** canonical page 键，与后端 navigation.ts 一致 */
  page: string;
  /** 页面中文名，用于抽屉里的「页面推导」徽标 */
  label: string;
  /** 由路由推导出的上下文字段(不含 page) */
  context: AssistantContext;
}

/** 页面标签：与后端 navigation.ts / PageCapabilityMap 的 label 保持一致。 */
export const PAGE_LABEL: Record<string, string> = {
  dashboard: '首页工作台',
  budget_edit: '预算编制表格',
  budget_versions: '预算与预测版本',
  actual: '实际录入与快照',
  finance_import: '财务系统转换',
  analysis: '年度执行分析',
  structure: '结构分析',
  history: '历年对比与趋势',
  version_compare: '版本对比',
  org: '组织管理',
  account: '科目管理',
  metric: '报表指标',
  calculations: '测算模板',
  imports: '导入批次',
  data_check: '一致性检查',
  yearclose: '年度关闭',
  backup: '备份与迁移',
  migration: '迁移管理',
  data_export: '数据导出',
  logs: '操作日志',
  assistant: '小澧助手',
  insights: '洞察报告',
  master_health: '主数据健康',
  cleaning_config: '清洗配置',
  budget_progress: '编制进度',
  anomaly_center: '异常预警中心',
  metric_trend: '指标趋势',
  ai_settings: 'AI 渠道设置',
  /** 未知路径在 React Router 完成重定向前的占位，绝不标为 dashboard(§7.1)。 */
  unknown: '当前页面',
};

/** 各页面的快捷提问(2–4 条)：贴着该页能回答的问题，避免抽屉空状态无从下手。 */
export const PAGE_PROMPTS: Record<string, string[]> = {
  dashboard: ['本年度预算执行情况怎么样', '哪个组织亏得最多', '有哪些异常和质量问题'],
  budget_edit: ['这个版本的预算结构合理吗', '检查这个版本的预算质量问题', '这个版本和上一年比变化在哪'],
  budget_versions: ['列出本年度预算版本和当前生效版本', '当前生效版本是哪个，状态如何', '各版本之间差异在哪'],
  actual: ['最新一次实际快照是什么时候', '本年度实际累计完成率如何', '实际数与预算差异最大的科目'],
  finance_import: ['最近一次导入有哪些错误', '未匹配的组织和科目有哪些', '导入批次可以撤销吗'],
  analysis: ['本页口径下完成率为什么偏低', '按组织和科目给出差异归因', '费用超支了没，进度是不是太快'],
  structure: ['当前结构的占比基准是什么', '哪些科目占收入比重最大', '结构与预算口径差异在哪'],
  history: ['历年完成率趋势怎么样', '本年度预算准确率如何', '和去年同期相比变化在哪'],
  version_compare: ['这两个版本差异最大的科目是哪些', '差异主要来自哪些组织', '解释一下版本对比口径'],
  org: ['组织树有哪些层级和节点', '哪些组织没有预算数据'],
  account: ['科目树结构是怎样的', '解释成本费用的符号方向口径'],
  metric: ['报表指标是怎么计算的', '解释毛利与营业利润口径'],
  calculations: ['测算模板是怎么参与预算的', '量价模板有哪些'],
  imports: ['最近一次导入的结果如何', '有哪些导入批次可以撤销'],
  data_check: ['一致性检查有哪些问题', '最近一次检查发现什么'],
  yearclose: ['年度关闭会影响哪些数据', '本年度可以关闭了吗'],
  backup: ['备份与一致性检查怎么做', '数据一致性有问题吗'],
  migration: ['最近有哪些迁移任务', '迁移失败的任务怎么排查'],
  data_export: ['可以导出哪些数据', '导出范围怎么限定'],
  logs: ['最近有哪些关键操作', '谁改过本年度预算'],
  assistant: ['本年度预算执行情况怎么样', '哪个组织亏得最多', '解释完成率与万元换算口径'],
  insights: ['最近生成了哪些洞察报告', '上一份报告的结论是什么'],
  master_health: ['主数据有哪些结构问题', '哪些组织或科目缺失'],
  cleaning_config: ['当前有哪些清洗模板', '别名规则覆盖了哪些来源名称'],
  budget_progress: ['当前版本填报进度如何', '哪些组织还没填报'],
  anomaly_center: ['当前有哪些异常预警', '哪些科目同比异常'],
  metric_trend: ['当前指标的趋势怎么样', '哪个版本指标变化最大'],
  ai_settings: ['当前配置了哪些 AI 渠道', '哪些功能绑定了模型'],
};

/**
 * 助手面板「我能帮您做」的能力卡。
 *
 * 排版约定:**每页第一条是主推卡**(紫调渐变),其余是普通卡(灰底)。
 * 主推位表达的是「这一页最值得先点的那件事」,不是「这条更 AI」——
 * 用位置而不是逐条标注来定强调,才能保证每页都恰好有一张高亮卡。
 *
 * icon 存的是图标令牌而非 React 元素,保持本模块零 JSX 依赖(它也被纯逻辑处引用)。
 */
export type SkillIcon = 'insight' | 'alert' | 'diff' | 'quality' | 'trend' | 'import' | 'glossary' | 'search';

export interface PageSkill {
  key: string;
  icon: SkillIcon;
  title: string;
  desc: string;
  /** 点击后直接发出的提问 */
  prompt: string;
}

/** 能力卡词表:同一条能力在多个页面复用时只维护一份文案。 */
const SKILL = {
  attribution: { key: 'attribution', icon: 'insight', title: '差异归因', desc: '按组织与科目逐层拆解预算差异' },
  overspend: { key: 'overspend', icon: 'alert', title: '超支巡检', desc: '找出累计实际已突破全年预算的科目' },
  execution: { key: 'execution', icon: 'insight', title: '执行速览', desc: '完成率、时间进度与节奏差一次说清' },
  anomaly: { key: 'anomaly', icon: 'alert', title: '异常与质量检查', desc: '空值、反向、离群与口径问题' },
  quality: { key: 'quality', icon: 'quality', title: '预算质量体检', desc: '结构、颗粒度与同比合理性诊断' },
  compare: { key: 'compare', icon: 'diff', title: '版本差异', desc: '两个版本之间变动最大的科目与组织' },
  trend: { key: 'trend', icon: 'trend', title: '历年趋势解读', desc: '多年完成率与准确率的走势归因' },
  importCheck: { key: 'importCheck', icon: 'import', title: '导入体检', desc: '未匹配项、失败原因与可撤销批次' },
  glossary: { key: 'glossary', icon: 'glossary', title: '业务口径', desc: '完成率、符号方向与万元换算的定义' },
  locate: { key: 'locate', icon: 'search', title: '定位数据', desc: '按组织/科目查具体数字与来源' },
} as const satisfies Record<string, Omit<PageSkill, 'prompt'>>;

/** 把词表条目补上该页要发的提问。 */
function skill(base: Omit<PageSkill, 'prompt'>, prompt: string): PageSkill {
  return { ...base, prompt };
}

/** 各页面的能力卡(2 条,第一条为主推卡)。 */
export const PAGE_SKILLS: Record<string, PageSkill[]> = {
  dashboard: [
    skill(SKILL.execution, '分析本年度预算执行情况与完成率，说明节奏是快还是慢'),
    skill(SKILL.overspend, '哪些成本费用科目的累计实际已经超过全年预算'),
  ],
  analysis: [
    skill(SKILL.attribution, '本页口径下利润为什么低于预算，按组织和科目给出归因'),
    skill(SKILL.overspend, '哪些科目超支了，进度是不是太快'),
  ],
  structure: [
    skill(SKILL.compare, '当前结构占比和预算口径差异在哪'),
    skill(SKILL.glossary, '解释结构分析的占比基准与口径'),
  ],
  insights: [
    skill(SKILL.locate, '最近生成了哪些洞察报告，结论是什么'),
    skill(SKILL.execution, '分析本年度预算执行情况与完成率'),
  ],
  master_health: [
    skill(SKILL.anomaly, '主数据有哪些结构与完整性问题'),
    skill(SKILL.glossary, '解释组织与科目的层级口径'),
  ],
  cleaning_config: [
    skill(SKILL.importCheck, '当前有哪些清洗模板和别名规则'),
    skill(SKILL.glossary, '解释清洗模板与别名的作用'),
  ],
  budget_progress: [
    skill(SKILL.execution, '当前版本各组织填报进度如何'),
    skill(SKILL.locate, '哪些组织还没有填报'),
  ],
  anomaly_center: [
    skill(SKILL.anomaly, '当前有哪些异常预警，按严重度说明'),
    skill(SKILL.attribution, '哪些科目同比偏差最大'),
  ],
  metric_trend: [
    skill(SKILL.trend, '当前指标在不同版本间的趋势说明了什么'),
    skill(SKILL.compare, '哪个版本的指标值变化最大'),
  ],
  ai_settings: [
    skill(SKILL.glossary, '解释 AI 渠道与功能绑定的作用'),
    skill(SKILL.locate, '当前配置了哪些 AI 渠道'),
  ],
  data_check: [
    skill(SKILL.anomaly, '一致性检查有哪些问题'),
    skill(SKILL.glossary, '解释一致性检查的口径'),
  ],
  migration: [
    skill(SKILL.locate, '最近有哪些迁移任务，状态如何'),
    skill(SKILL.glossary, '解释迁移与备份的区别'),
  ],
  data_export: [
    skill(SKILL.glossary, '解释数据导出的范围与格式'),
    skill(SKILL.locate, '可以导出哪些数据'),
  ],
  budget_edit: [
    skill(SKILL.quality, '检查这个版本的预算质量与结构问题'),
    skill(SKILL.compare, '这个版本和上一年比，变化最大的科目是哪些'),
  ],
  budget_versions: [
    skill(SKILL.execution, '列出本年度预算版本，说明当前生效版本的执行情况'),
    skill(SKILL.compare, '各版本之间差异最大的科目和组织是哪些'),
  ],
  actual: [
    skill(SKILL.execution, '本年度实际累计完成率如何，最新快照截至哪一天'),
    skill(SKILL.anomaly, '实际数里有哪些异常和质量问题'),
  ],
  finance_import: [
    skill(SKILL.importCheck, '最近一次导入有哪些错误和未匹配的组织科目'),
    skill(SKILL.glossary, '解释财务余额表转实际数的方向与口径'),
  ],
  history: [
    skill(SKILL.trend, '历年完成率与预算准确率的趋势说明了什么'),
    skill(SKILL.compare, '本年度和去年同期相比变化在哪'),
  ],
  version_compare: [
    skill(SKILL.attribution, '这两个版本的差异主要来自哪些组织和科目'),
    skill(SKILL.glossary, '解释版本对比的口径与符号方向'),
  ],
  org: [
    skill(SKILL.locate, '组织树有哪些层级，哪些组织没有预算数据'),
    skill(SKILL.glossary, '解释组织层级与汇总口径'),
  ],
  account: [
    skill(SKILL.locate, '科目树结构是怎样的，哪些是叶子科目'),
    skill(SKILL.glossary, '解释收入成本费用的符号方向口径'),
  ],
  metric: [
    skill(SKILL.glossary, '报表指标是怎么计算的，解释毛利与营业利润口径'),
    skill(SKILL.locate, '各指标当前的预算与实际值是多少'),
  ],
  calculations: [
    skill(SKILL.glossary, '测算模板是怎么参与预算编制的'),
    skill(SKILL.locate, '现在有哪些量价测算模板'),
  ],
  imports: [
    skill(SKILL.importCheck, '最近的导入批次结果如何，哪些可以撤销'),
    skill(SKILL.anomaly, '导入进来的数据有没有异常'),
  ],
  yearclose: [
    skill(SKILL.glossary, '年度关闭会影响哪些数据，本年度可以关闭了吗'),
    skill(SKILL.anomaly, '关闭前有哪些质量问题需要先处理'),
  ],
  backup: [
    skill(SKILL.anomaly, '数据一致性检查有没有问题'),
    skill(SKILL.glossary, '备份与恢复的范围和注意事项'),
  ],
  logs: [
    skill(SKILL.locate, '最近有哪些关键操作，谁改过本年度预算'),
    skill(SKILL.anomaly, '有没有失败或异常的操作记录'),
  ],
  assistant: [
    skill(SKILL.attribution, '本年度利润为什么低于预算，按组织和科目给出归因'),
    skill(SKILL.execution, '分析本年度预算执行情况与完成率'),
  ],
};

export function pageSkills(page: string): PageSkill[] {
  return PAGE_SKILLS[page] ?? PAGE_SKILLS.assistant;
}

function positiveInt(value: string | null | undefined): number | undefined {
  if (value == null || value === '') return undefined;
  const n = Number(value);
  return Number.isSafeInteger(n) && n > 0 ? n : undefined;
}

/** /data 的子页由 ?tab= 决定，缺省与无效 tab 都跟 DataManage 的最终 active 页签一致(backup)。 */
function dataPage(tab: string | null): string {
  switch (tab) {
    case 'calculations': return 'calculations';
    case 'imports': return 'imports';
    case 'check': return 'data_check';
    case 'yearclose': return 'yearclose';
    case 'migration': return 'migration';
    case 'export': return 'data_export';
    case 'logs': return 'logs';
    default: return 'backup';
  }
}

function info(page: string, context: AssistantContext): RoutePageInfo {
  const clean: AssistantContext = {};
  for (const [key, value] of Object.entries(context)) {
    if (value == null) continue;
    (clean as Record<string, unknown>)[key] = value;
  }
  return { page, label: PAGE_LABEL[page] ?? page, context: clean };
}

/**
 * 由 location 推导页面与上下文。覆盖 App.tsx 里的全部路由。
 *
 * 查询参数的键名必须与各页面自己读的键名一致(Analysis: year/version/forecast/batch/org/account；
 * VersionCompare: base/target/org)，否则抽屉里的「页面推导」会和用户眼前的筛选对不上。
 *
 * 路由身份只负责「这是哪一页」；真实业务状态由各页面的适配器经 AssistantContextRegistry 登记。
 * 未知路径不能标为 dashboard(§7.1)：React Router 的 * 规则会重定向到首页，
 * 重定向完成前返回 unknown，助手侧按「页面范围不可用」处理，绝不冒充首页口径。
 */
export function derivePageContext(pathname: string, search: string): RoutePageInfo {
  const params = new URLSearchParams(search);
  const segments = pathname.split('/').filter(Boolean);
  const head = segments[0] ?? '';
  switch (head) {
    case '':
      return info('dashboard', {});
    case 'assistant':
      return info('assistant', {});
    case 'insights':
      return info('insights', {});
    case 'master-health':
      return info('master_health', {});
    case 'cleaning-config':
      return info('cleaning_config', {});
    case 'progress':
      return info('budget_progress', {});
    case 'alerts':
      return info('anomaly_center', {
        budgetVersionId: positiveInt(params.get('version')),
        actualSnapshotId: positiveInt(params.get('batch')),
      });
    case 'metric-trend':
      return info('metric_trend', {});
    case 'settings':
      return segments[1] === 'ai' ? info('ai_settings', {}) : info('unknown', {});
    case 'budget': {
      const versionId = positiveInt(segments[1]);
      // /budget/:id 是编制页：把这一版当成上下文；年度交由后端按该版本推导，
      // 前端不自己猜(猜错就会和版本年度冲突)。
      return versionId != null ? info('budget_edit', { budgetVersionId: versionId }) : info('budget_versions', {});
    }
    case 'actual':
      return info('actual', { year: positiveInt(params.get('year')) });
    case 'finance':
      return info('finance_import', {});
    case 'analysis':
      return info('analysis', {
        year: positiveInt(params.get('year')),
        budgetVersionId: positiveInt(params.get('version')),
        targetVersionId: positiveInt(params.get('forecast')),
        actualSnapshotId: positiveInt(params.get('batch')),
        orgId: positiveInt(params.get('org')),
        accountId: positiveInt(params.get('account')),
      });
    case 'structure':
      return info('structure', {
        year: positiveInt(params.get('year')),
        budgetVersionId: positiveInt(params.get('version')),
        actualSnapshotId: positiveInt(params.get('batch')),
        orgId: positiveInt(params.get('org')),
        accountId: positiveInt(params.get('account')),
      });
    case 'history':
      return info('history', {});
    case 'compare':
      return info('version_compare', {
        budgetVersionId: positiveInt(params.get('base')),
        targetVersionId: positiveInt(params.get('target')),
        orgId: positiveInt(params.get('org')),
      });
    case 'org':
      return info('org', {});
    case 'account':
      return info('account', {});
    case 'metric':
      return info('metric', {});
    case 'data':
      return info(dataPage(params.get('tab')), {});
    default:
      // 未知路径会被路由表的 * 规则重定向到首页；重定向完成前不冒充任何已知业务页。
      return info('unknown', {});
  }
}
