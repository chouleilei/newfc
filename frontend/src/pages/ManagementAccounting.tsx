import { Tabs } from 'antd';
import { useSearchParams } from 'react-router-dom';
import { AllocationTab } from './mgmt/AllocationTab';
import { AlertsTab, BudgetAdjustmentsTab, CentersTab, PerformanceTab } from './mgmt/ControlTabs';
import { AnalysisTab, DimensionsTab, MetricsTab } from './mgmt/MetricTabs';

/** AC-F14 管理会计:八个子功能分页签;页签记在 URL(?tab=)便于分享与刷新保持。 */
export const MGMT_TABS = [
  { key: 'centers', label: '责任中心', render: () => <CentersTab /> },
  { key: 'metrics', label: '指标与计算', render: () => <MetricsTab /> },
  { key: 'alerts', label: '预警', render: () => <AlertsTab /> },
  { key: 'allocation', label: '成本分摊', render: () => <AllocationTab /> },
  { key: 'budget-adjust', label: '预算调整', render: () => <BudgetAdjustmentsTab /> },
  { key: 'analysis', label: '多维分析', render: () => <AnalysisTab /> },
  { key: 'dimensions', label: '维度', render: () => <DimensionsTab /> },
  { key: 'performance', label: '绩效', render: () => <PerformanceTab /> },
] as const;

export default function ManagementAccounting() {
  const [params, setParams] = useSearchParams();
  const tab = MGMT_TABS.some((t) => t.key === params.get('tab')) ? params.get('tab')! : 'centers';
  return (
    <Tabs
      activeKey={tab} destroyInactiveTabPane
      onChange={(k) => setParams((p) => { p.set('tab', k); return p; }, { replace: true })}
      items={MGMT_TABS.map((t) => ({ key: t.key, label: t.label, children: t.render() }))}
    />
  );
}
