/**
 * AI 功能位独立开关(AI 功能增强计划 §二.5、§六)。
 *
 * 每个新 AI 入口一个开关,仿 BUDGET_CLEANING_AI 的语义:不设或为其他值时启用,
 * 置 '0' 时关闭。开关只控制「是否调用模型」,关闭后对应入口回退确定性内容,
 * 不残留半可用状态;所有入口同时受全局模型可用性 modelConfigured() 约束。
 *
 * 调用时读取(process.env 动态判定),以便运行期测试逐用例切换;
 * 同步路径零模型调用,调用点均为异步处理器。
 */
const enabled = (value: string | undefined): boolean => value !== '0';

/** 定稿质量门禁「解释 + 修复建议」 */
export function qualityAdviceAiEnabled(): boolean { return enabled(process.env.BUDGET_QUALITY_AI); }
/** 财务映射候选建议的模型残差兜底 */
export function financeMappingAiEnabled(): boolean { return enabled(process.env.BUDGET_FINANCE_MAPPING_AI); }
/** 主数据体检的模糊语义命名相似候选 */
export function masterDataAiEnabled(): boolean { return enabled(process.env.BUDGET_MASTER_DATA_AI); }
/** 多年趋势「年度节奏对比」叙述改写 */
export function trendNarrativeAiEnabled(): boolean { return enabled(process.env.BUDGET_TREND_AI); }
/** 编制记录点「本轮修改小结」改写 */
export function checkpointSummaryAiEnabled(): boolean { return enabled(process.env.BUDGET_CHECKPOINT_AI); }
