/** T-5 风险与报告页面公用标签(契约的中文标签是值,前端只能以类型导入契约,故在此维护一份)。 */

export const RISK_STATUS = {
  open: { text: '待确认', color: 'warning' }, confirmed: { text: '已确认', color: 'processing' }, rectifying: { text: '整改中', color: 'blue' },
  rectified: { text: '待复核', color: 'purple' }, closed: { text: '已关闭', color: 'success' }, false_positive: { text: '误报', color: 'default' },
};
export const RISK_LEVEL = { high: { text: '高', color: 'red' }, medium: { text: '中', color: 'orange' }, low: { text: '低', color: 'blue' } };
export const RISK_SOURCE_LABEL: Record<string, string> = {
  project_budget: '项目预算', plan: '计划执行', contract: '合同付款', investment_control: '投资控制', feasibility: '可行性测算',
};
export const RISK_ACTION_LABEL: Record<string, string> = {
  detect: '发现', redetect: '再次命中', reopen: '重开', suppressed: '误报再次命中', confirm: '确认', start: '开始整改', submit: '提交复核',
  approve: '复核通过', return: '复核退回', false_positive: '认定误报', comment: '备注',
};

export const RPT_STATUS = {
  draft: { text: '草稿', color: 'default' }, pending_approval: { text: '待审批', color: 'warning' }, approved: { text: '已审批', color: 'processing' },
  published: { text: '已发布', color: 'success' }, superseded: { text: '已被替代', color: 'default' },
};
export const RPT_KIND_LABEL: Record<string, string> = {
  monthly_execution: '预算执行月报', annual_review: '年度复盘', budget_discussion: '预算讨论材料', risk_investment: '风险与投资专题',
};
export const MODEL_STATUS_LABEL = (s: string): string => {
  if (s === 'template') return '模板叙述';
  if (s === 'template:guard_failed') return '模型改写改动了事实,已保留模板叙述';
  if (s.startsWith('model_partial:')) return `模型部分改写(${s.slice('model_partial:'.length)})`;
  if (s.startsWith('model:')) return `模型改写(${s.slice('model:'.length)})`;
  return s;
};
