import type { QueryClient, QueryKey } from '@tanstack/react-query';

/** 所有由预算、实际快照或财务导入派生的分析缓存前缀。 */
export const ANALYSIS_QUERY_KEYS: QueryKey[] = [
  ['completion-analysis'],
  ['forecast-analysis'],
  ['trend-analysis'],
  ['structure-analysis'],
  ['completion'],
  ['trend'],
  ['historical'],
  ['accuracy'],
  ['batches-for-analysis'],
  ['dashboard'],
  ['version-compare'],
  ['version-summary'],
  ['version-metrics'],
  ['budget-progress'],
  ['anomalies'],
  ['multi-year-trend'],
  ['metric-values'],
  ['evidence'],
  ['quality-advice'],
  ['checkpoint-summary'],
];

export async function invalidateAnalysisQueries(queryClient: QueryClient): Promise<void> {
  await Promise.all(ANALYSIS_QUERY_KEYS.map((queryKey) => queryClient.invalidateQueries({ queryKey })));
}
