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
