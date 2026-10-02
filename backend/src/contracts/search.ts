import { z } from 'zod';

/** 跨域检索契约(T-6,AC-F26)。 */

export const SEARCH_TYPES = [
  'project', 'supplier', 'contract', 'expense_claim', 'project_budget_batch',
  'feasibility_project', 'investment_project', 'forecast_model', 'risk_event', 'analysis_report', 'budget_version',
] as const;
export type SearchType = typeof SEARCH_TYPES[number];

export const SEARCH_TYPE_LABELS: Record<SearchType, string> = {
  project: '项目', supplier: '供应商', contract: '合同', expense_claim: '报销单', project_budget_batch: '项目预算批次',
  feasibility_project: '可行性项目', investment_project: '投资控制项目', forecast_model: '预测模型', risk_event: '风险事件',
  analysis_report: '分析报告', budget_version: '经营预算版本',
};

/** 检索建议里的类型说明:告诉用户每类按哪些字段匹配。 */
export const SEARCH_TYPE_HINTS: Record<SearchType, string> = {
  project: '按项目编码、名称、类型', supplier: '按供应商名称、编码、信用代码', contract: '按合同编号、名称、供应商',
  expense_claim: '按报销单号、申请人、事由', project_budget_batch: '按批次名称、期间', feasibility_project: '按项目编码、名称',
  investment_project: '按项目编码、名称', forecast_model: '按模型名称', risk_event: '按风险标题、项目、规则',
  analysis_report: '按报告标题、编号', budget_version: '按版本名称、年度',
};

export const searchSuggestQuery = z.object({
  /** 缺省只返回可检索类型;有值时额外返回编码/标题完全相同或前缀命中的条目 */
  q: z.string().trim().max(64, '关键词最多 64 个字符').optional(),
}).strict();

export interface SearchSuggestionDto {
  types: { type: SearchType; label: string; hint: string }[];
  items: Pick<SearchItemDto, 'type' | 'typeLabel' | 'id' | 'code' | 'title' | 'path'>[];
}

export const searchQuery = z.object({
  q: z.string().trim().min(1, '请输入关键词').max(64, '关键词最多 64 个字符'),
  /** 逗号分隔的类型;缺省为全部有权限的类型 */
  types: z.string().trim().max(400).optional().transform((v, ctx) => {
    if (!v) return undefined;
    const list = [...new Set(v.split(',').map((x) => x.trim()).filter(Boolean))];
    const bad = list.filter((x) => !(SEARCH_TYPES as readonly string[]).includes(x));
    if (bad.length) { ctx.addIssue({ code: z.ZodIssueCode.custom, message: `未知检索类型:${bad.join('、')}` }); return z.NEVER; }
    return list as SearchType[];
  }),
  limit: z.coerce.number().int().min(1).max(20).optional(),
}).strict();
export type SearchQuery = z.infer<typeof searchQuery>;

export interface SearchItemDto {
  type: SearchType;
  typeLabel: string;
  id: number;
  code: string | null;
  title: string;
  subtitle: string;
  orgName: string | null;
  status: string;
  /** 前端路由(含定位参数),点击可回到真实页面 */
  path: string;
  updatedAt: string | null;
}

export interface SearchResultDto {
  query: string;
  items: SearchItemDto[];
  /** 该类型命中超过单类上限,只返回了前 N 条 */
  truncated: Partial<Record<SearchType, true>>;
  /** 因缺少读权限而未检索的类型 */
  skipped: SearchType[];
}
