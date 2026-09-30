/** 跨域检索(T-6,AC-F26)。类型取自 @contracts/search(仅 import type)。 */
import { api } from './client';
import { qs } from './financeData';
import type { SearchItemDto, SearchResultDto, SearchType } from '@contracts/search';

export type { SearchItemDto, SearchResultDto, SearchType };

export const searchApi = {
  search: (q: string, types?: SearchType[]) => api.get<SearchResultDto>(`/search${qs({ q, types: types?.length ? types.join(',') : undefined })}`),
};

/** 与后端 SEARCH_TYPE_LABELS 一致的展示顺序;契约常量不能在前端运行时引用,这里列出。 */
export const SEARCH_TYPE_OPTIONS: { value: SearchType; label: string }[] = [
  { value: 'project', label: '项目' }, { value: 'supplier', label: '供应商' }, { value: 'contract', label: '合同' },
  { value: 'expense_claim', label: '报销单' }, { value: 'project_budget_batch', label: '项目预算批次' },
  { value: 'feasibility_project', label: '可行性项目' }, { value: 'investment_project', label: '投资控制项目' },
  { value: 'forecast_model', label: '预测模型' }, { value: 'risk_event', label: '风险事件' },
  { value: 'analysis_report', label: '分析报告' }, { value: 'budget_version', label: '经营预算版本' },
];
