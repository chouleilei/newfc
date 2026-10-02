/**
 * 助手界面共用的中文标签(独立页与全局抽屉都要用同一套说法)。
 * 键与后端保持一一对应：resolution.field / resolution.origin / intent.ts 的只读意图。
 */
import type { ContextResolution } from '@contracts/assistant';

/** 上下文解析来源的展示文案。default/message 是助手替用户做的选择，必须让用户看到。 */
export const RESOLUTION_ORIGIN_LABEL: Record<ContextResolution['origin'], { text: string; color?: string }> = {
  request: { text: '你选择的' },
  message: { text: '从提问识别', color: 'blue' },
  conversation: { text: '沿用上一轮', color: 'cyan' },
  default: { text: '助手默认选择', color: 'gold' },
};

export const RESOLUTION_FIELD_LABEL: Record<ContextResolution['field'], string> = {
  year: '年度',
  budgetVersionId: '预算版本',
  targetVersionId: '对比版本',
  actualSnapshotId: '实际快照',
  orgScopeId: '组织范围',
  accountScopeId: '科目范围',
  importBatchId: '导入批次',
};

/** 只读意图 → 中文标签，用于「沿用上一轮话题」提示。与后端 intent.ts 的标签保持一致。 */
export const READ_INTENT_LABEL: Record<string, string> = {
  eas_status: 'EAS 对账', statements: '财务报表', mgmt_metrics: '管理会计', mgmt_alerts: '管理会计预警', project_budget: '项目预算', plan_execution: '计划执行', contracts: '合同与付款', expenses: '费用审核', policies: '制度条款', feasibility: '可行性测算', investment_control: '投资控制', forecast: '财务预测', risks: '风险与整改', analysis_reports: '分析报告', standard_reports: '标准报表', governance: '数据治理', project_profile: '项目全景', master_entities: '项目与供应商', cross_search: '跨域检索', tasks: '任务状态', configuration: '配置与能力', authorization: '权限与范围',
  budget_versions: '版本',
  actual_snapshots: '实际与快照',
  org_tree: '组织树',
  account_tree: '科目树',
  import: '导入',
  operation_log: '操作日志',
  execution: '执行分析',
  attribution: '差异归因',
  report: '报告生成',
  trend: '年内趋势',
  version_variance: '版本对比',
  anomalies: '异常检查',
  budget_quality: '质量检查',
  accuracy: '预算准确率',
  historical_comparison: '历年对比',
  cell_note: '单元格备注',
};
