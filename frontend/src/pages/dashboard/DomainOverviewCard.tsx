import { useQuery } from '@tanstack/react-query';
import { Card, Col, Row, Tooltip, Typography } from 'antd';
import { useNavigate } from 'react-router-dom';
import type { DashboardDomainsDto, DomainMetricDto } from '@contracts/dashboard';
import { api, can } from '../../api/client';
import { Money, Ratio } from '../financeData/shared';

/**
 * 工作台业务概况(T-6,AC-F03):合同、报销、项目预算、风险、投资控制与报告的范围内统计。
 * 服务端按权限返回块;不可用的指标显示“—”并提示原因,不显示为 0。点击块进入对应页面。
 */
function MetricValue({ m }: { m: DomainMetricDto }) {
  if (m.value == null) return <Tooltip title={m.note}><span>—</span></Tooltip>;
  if (m.unit === 'money') return <span><Money value={String(m.value)} /> 元</span>;
  if (m.unit === 'ratio') return <Ratio value={String(m.value)} />;
  return <span style={{ fontVariantNumeric: 'tabular-nums' }}>{m.value}</span>;
}

export function DomainOverviewCard() {
  const navigate = useNavigate();
  const allowed = can('dashboard:read');
  const q = useQuery({ queryKey: ['dashboard-domains'], queryFn: () => api.get<DashboardDomainsDto>('/dashboard/domains'), enabled: allowed, retry: false, staleTime: 30_000 });
  const blocks = q.data?.blocks ?? [];
  if (!allowed || blocks.length === 0) return null;
  return (
    <div data-testid="domain-overview-card">
      <div className="newfc-eyebrow">业务概况</div>
      <Row gutter={[12, 12]}>
        {blocks.map((b) => (
          <Col key={b.key} xs={24} sm={12} lg={8}>
            <Card size="small" hoverable title={b.label} onClick={() => navigate(b.path)} aria-label={`业务概况 ${b.label}`}>
              {b.metrics.map((m) => (
                <div key={m.label} style={{ display: 'flex', justifyContent: 'space-between', gap: 12 }}>
                  <Typography.Text type="secondary">{m.label}</Typography.Text>
                  <MetricValue m={m} />
                </div>
              ))}
            </Card>
          </Col>
        ))}
      </Row>
    </div>
  );
}
