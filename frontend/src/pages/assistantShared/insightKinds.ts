import type { InsightKind } from '../../api/assistant';

/**
 * 洞察类型目录:Assistant 页与「洞察报告」页(/insights)共同引用,
 * 避免两处定义漂移。needs 决定创建时需要哪些上下文参数。
 */
export const INSIGHT_KINDS: { value: InsightKind; label: string; needs: 'version' | 'year' | 'compare' | 'none' }[] = [
  { value: 'execution', label: '预算执行完成情况', needs: 'version' },
  { value: 'attribution', label: '差异归因(逐层展开)', needs: 'version' },
  { value: 'report', label: '报告草稿(执行月报)', needs: 'version' },
  { value: 'anomalies', label: '异常与质量检查', needs: 'version' },
  { value: 'trend', label: '年内完成率趋势', needs: 'version' },
  { value: 'budget_quality', label: '预算质量报告', needs: 'version' },
  { value: 'accuracy', label: '预算准确率', needs: 'year' },
  { value: 'version_variance', label: '版本对比', needs: 'compare' },
  { value: 'historical_comparison', label: '历年对比', needs: 'none' },
];
