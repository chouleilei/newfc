/** Shared permission codes. No runtime or service dependencies. */
export interface PermissionDef {
  code: string;
  label: string;
  group: string;
}

export const PERMISSION_CATALOG = [
  { code: 'dashboard:read', label: '查看工作台', group: '工作台' },
  { code: 'search:use', label: '跨域检索', group: '工作台' },

  { code: 'master:read', label: '查看主数据', group: '主数据' },
  { code: 'master:write', label: '维护主数据与映射', group: '主数据' },

  { code: 'budget:read', label: '查看经营预算', group: '经营预算' },
  { code: 'budget:write', label: '编制经营预算', group: '经营预算' },
  { code: 'budget:finalize', label: '预算定稿/采用/归档', group: '经营预算' },
  { code: 'actual:read', label: '查看实际数', group: '经营预算' },
  { code: 'actual:write', label: '维护实际数', group: '经营预算' },
  { code: 'actual:finalize', label: '年度关闭与重开', group: '经营预算' },
  { code: 'import:run', label: '文件导入与清洗', group: '数据导入' },
  { code: 'finance_import:manage', label: '财务转换与映射版本', group: '数据导入' },
  { code: 'analysis:read', label: '查看分析报表', group: '分析' },
  { code: 'analysis:export', label: '导出分析结果', group: '分析' },

  { code: 'eas:read', label: '查看 EAS 数据工作区', group: 'EAS 与治理' },
  { code: 'eas:import', label: '导入 EAS 导出文件', group: 'EAS 与治理' },
  { code: 'eas:period_lock', label: '期间锁定与解锁', group: 'EAS 与治理' },
  { code: 'eas:correction_submit', label: '提交更正申请', group: 'EAS 与治理' },
  { code: 'eas:correction_review', label: '复核更正申请', group: 'EAS 与治理' },
  { code: 'governance:read', label: '查看数据质量问题', group: 'EAS 与治理' },
  { code: 'governance:resolve', label: '处置数据质量问题', group: 'EAS 与治理' },
  { code: 'governance:review', label: '复核处置结果', group: 'EAS 与治理' },
  { code: 'statements:read', label: '查看财务报表', group: '财务报表' },
  { code: 'statements:import', label: '导入与激活财务报表', group: '财务报表' },
  { code: 'mgmt:read', label: '查看管理会计', group: '管理会计' },
  { code: 'mgmt:write', label: '维护管理会计口径与分摊', group: '管理会计' },
  { code: 'mgmt:review', label: '复核分摊调整与绩效', group: '管理会计' },

  { code: 'project:read', label: '查看项目', group: '项目' },
  { code: 'project:write', label: '维护项目', group: '项目' },
  { code: 'project_budget:read', label: '查看项目预算', group: '项目' },
  { code: 'project_budget:write', label: '编制项目预算', group: '项目' },
  { code: 'plan:read', label: '查看计划与形象进度', group: '项目' },
  { code: 'plan:write', label: '维护计划与形象进度', group: '项目' },
  { code: 'contract:read', label: '查看合同', group: '合同' },
  { code: 'contract:write', label: '维护合同/变更/付款', group: '合同' },
  { code: 'contract:import', label: '导入合同台账', group: '合同' },
  { code: 'contract:review', label: '审核合同', group: '合同' },
  { code: 'expense:read', label: '查看费用报销', group: '费用审核' },
  { code: 'expense:submit', label: '登记报销单与附件', group: '费用审核' },
  { code: 'expense:review', label: '人工复核报销', group: '费用审核' },

  { code: 'investment:read', label: '查看投资分析', group: '投资与预测' },
  { code: 'investment:write', label: '维护投资测算与控制', group: '投资与预测' },
  { code: 'investment:review', label: '复核可行性报告', group: '投资与预测' },
  { code: 'forecast:read', label: '查看财务预测', group: '投资与预测' },
  { code: 'forecast:write', label: '维护与重算财务预测', group: '投资与预测' },
  { code: 'forecast:review', label: '复核预测版本与撤回发布', group: '投资与预测' },
  { code: 'risk:read', label: '查看风险', group: '风险与报告' },
  { code: 'risk:handle', label: '处理风险', group: '风险与报告' },
  { code: 'risk:review', label: '复核风险处理', group: '风险与报告' },
  { code: 'report:read', label: '查看报告', group: '风险与报告' },
  { code: 'report:write', label: '起草与修订报告', group: '风险与报告' },
  { code: 'report:approve', label: '审批报告', group: '风险与报告' },
  { code: 'report:publish', label: '发布报告', group: '风险与报告' },

  { code: 'assistant:use', label: '使用 AI 助手', group: 'AI' },
  { code: 'knowledge:manage', label: '维护知识库与制度文档', group: 'AI' },
  { code: 'tasks:read', label: '查看任务与模型调用记录', group: '系统' },
  { code: 'settings:read', label: '查看系统设置', group: '系统' },
  { code: 'settings:manage', label: '修改系统设置与模型渠道', group: '系统' },
  { code: 'audit:read', label: '查看操作审计', group: '系统' },
  { code: 'system:backup', label: '备份、恢复与迁移', group: '系统' },
  { code: 'security:manage', label: '用户、角色与数据授权', group: '系统' },
] as const satisfies readonly PermissionDef[];

export type Permission = (typeof PERMISSION_CATALOG)[number]['code'];

export const ALL_PERMISSIONS: readonly Permission[] = PERMISSION_CATALOG.map((p) => p.code);
const PERMISSION_SET = new Set<string>(ALL_PERMISSIONS);

export function isPermission(value: unknown): value is Permission {
  return typeof value === 'string' && PERMISSION_SET.has(value);
}
