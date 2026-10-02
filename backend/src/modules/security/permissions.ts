import { ALL_PERMISSIONS, type Permission } from '../../contracts/permissions';

const READS: Permission[] = [
  'dashboard:read', 'search:use', 'master:read', 'budget:read', 'actual:read', 'analysis:read',
  'eas:read', 'governance:read', 'statements:read', 'mgmt:read', 'project:read', 'project_budget:read',
  'plan:read', 'contract:read', 'expense:read', 'investment:read', 'forecast:read', 'risk:read', 'report:read',
];

/**
 * 内置角色。admin 固定为全部权限且不可修改(防止锁死);其余为可修改的起始模板。
 * 这些是能力划分,不代表必须有不同人员(specs/requirements.md「用户操作与职责」)。
 */
export const BUILTIN_ROLES: { code: string; name: string; description: string; locked: boolean; permissions: readonly Permission[] }[] = [
  { code: 'admin', name: '系统管理员', description: '全部权限(内置,不可修改)', locked: true, permissions: ALL_PERMISSIONS },
  {
    code: 'data_maintainer', name: '数据维护', description: '上传、预览、确认导入与主数据映射', locked: false,
    permissions: [...READS, 'master:write', 'budget:write', 'actual:write', 'import:run', 'finance_import:manage',
      'eas:import', 'eas:correction_submit', 'statements:import', 'governance:resolve', 'contract:import', 'contract:write', 'expense:submit',
      'project:write', 'project_budget:write', 'plan:write', 'assistant:use', 'tasks:read'],
  },
  {
    code: 'finance_analyst', name: '财务分析', description: '预实对比、财报、指标、投资分析与报告起草', locked: false,
    permissions: [...READS, 'analysis:export', 'mgmt:write', 'investment:write', 'forecast:write', 'risk:handle',
      'report:write', 'assistant:use', 'tasks:read'],
  },
  {
    code: 'business_reviewer', name: '业务复核', description: '费用/合同复核、报告审批、更正与治理复核', locked: false,
    permissions: [...READS, 'contract:review', 'expense:review', 'report:approve', 'report:publish',
      'eas:correction_review', 'governance:review', 'risk:review', 'budget:finalize', 'actual:finalize',
      'eas:period_lock', 'mgmt:review', 'forecast:review', 'investment:review', 'assistant:use'],
  },
  { code: 'viewer', name: '只读查看', description: '只读访问已授权组织的数据', locked: false, permissions: [...READS, 'assistant:use'] },
];
