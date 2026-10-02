/**
 * 助手范围展示与对象动作（UX-26）纯函数。
 *
 * 规则：
 * - 范围优先显示业务名称（版本名/组织名/科目名/快照截止日），内部 ID 以 #n 作补充；
 * - 名称目录未加载（或对象不存在）时回退 #id，绝不编造名称；
 * - 焦点动作只生成提问文案，发送仍走 buildSnapshot 冻结的页面上下文。
 */
import { PageScope } from '@contracts/assistant';

export interface ScopeNameLookup {
  code: string;
  name: string;
}

/** 名称目录：由 AssistantProvider 的版本/批次/组织树/科目树查询提供。 */
export interface ScopeLookups {
  versionName?: (id: number) => string | undefined;
  /** 实际快照 → 「截至 YYYY-MM-DD revN」 */
  batchLabel?: (id: number) => string | undefined;
  org?: (id: number) => ScopeNameLookup | undefined;
  account?: (id: number) => ScopeNameLookup | undefined;
}

export const SCOPE_FIELD_LABEL: Record<keyof PageScope, string> = {
  projectId: '主数据项目', contractId: '合同', claimId: '报销单', feasProjectId: '可研项目', scenarioId: '可研方案', icProjectId: '投资项目', comparisonId: '投资快照', modelId: '预测模型', forecastVersionId: '预测版本', forecastRunId: '预测运行', riskId: '风险', reportId: '分析报告', standardReportId: '标准报表', governanceIssueId: '治理问题', mgmtMetricId: '管理会计指标',
  statementBatchId: '财报批次', projectBudgetBatchId: '项目预算批次', planBatchId: '计划批次', easBatchId: 'EAS 批次', feasReportId: '可行性报告', jobId: '后台任务',
  periodFrom: '起始期间', periodTo: '截至期间',
  period: '期间', statementScope: '财报口径',
  year: '年度',
  budgetVersionId: '预算版本',
  targetVersionId: '对比版本',
  actualSnapshotId: '实际快照',
  importBatchId: '导入批次',
  orgScopeId: '组织范围',
  accountScopeId: '科目范围',
  metricId: '指标',
  insightId: '洞察',
  conversionId: '转换批次',
  mappingVersionId: '映射版本',
  templateId: '模板',
  baseVersionId: '基准版本',
  compareVersionId: '目标版本',
  periodStart: '起始期间',
  periodEnd: '截至期间',
  asOfDate: '截至日期',
};

const VERSION_FIELDS: ReadonlySet<keyof PageScope> = new Set(['budgetVersionId', 'targetVersionId', 'baseVersionId', 'compareVersionId']);

/** 单个范围字段的展示文案：名称优先，ID 作补充。 */
export function describeScopeEntry(field: keyof PageScope, value: string | number, lookups: ScopeLookups = {}): string {
  const label = SCOPE_FIELD_LABEL[field];
  if (field === 'year') return `${label} ${value}`;
  if (typeof value === 'number') {
    if (VERSION_FIELDS.has(field)) {
      const name = lookups.versionName?.(value);
      return name ? `${label} ${name}（#${value}）` : `${label} #${value}`;
    }
    if (field === 'actualSnapshotId') {
      const batch = lookups.batchLabel?.(value);
      return batch ? `${label} ${batch}（#${value}）` : `${label} #${value}`;
    }
    if (field === 'orgScopeId') {
      const org = lookups.org?.(value);
      return org ? `${label} ${org.name}（${org.code}）` : `${label} #${value}`;
    }
    if (field === 'accountScopeId') {
      const account = lookups.account?.(value);
      return account ? `${label} ${account.name}（${account.code}）` : `${label} #${value}`;
    }
    return `${label} #${value}`;
  }
  return `${label} ${value}`;
}

/** 当前对象（焦点）的具体动作入口：只生成提问文案，发送时焦点随页面快照一起进入上下文。 */
export interface FocusAction {
  key: string;
  label: string;
  prompt: string;
}

export function focusActions(focusLabel: string): FocusAction[] {
  return [
    { key: 'explain', label: '解释这个差异', prompt: `解释当前对象「${focusLabel}」的差异和原因` },
    { key: 'basis', label: '查看计算依据', prompt: `说明当前对象「${focusLabel}」的计算依据与口径来源` },
  ];
}

/**
 * 迟到响应判定：回答发起时的页面与当前页面不同即视为来源不同。
 * 回答自身的 contextSummary 以发起时范围为准；此标记防止它被误读成当前页面对象。
 * currentPageKey 为空或 unknown（路由重定向中）时不标注。
 */
export function isTurnOriginStale(originPageKey: string | undefined, currentPageKey: string | undefined): boolean {
  if (!originPageKey || !currentPageKey || currentPageKey === 'unknown') return false;
  return originPageKey !== currentPageKey;
}
