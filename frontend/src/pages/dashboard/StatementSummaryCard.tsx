import { useQuery } from '@tanstack/react-query';
import { Card, Col, Row, Typography } from 'antd';
import { useNavigate } from 'react-router-dom';
import { can } from '../../api/client';
import { statementApi } from '../../api/financeData';
import { formatMoney, formatRatioPercent } from '../../utils/decimal';

/**
 * 工作台财报摘要(T-3 AC-F10):有 statements:read 且存在当前财报批次时显示
 * 总资产、资产负债率、净利润(本年累计);数据来自 /statements/overview(与财报页同源,按授权范围裁剪)。
 * 无权限或无当前批次时不渲染,也不发请求。
 */
export function StatementSummaryCard() {
  const navigate = useNavigate();
  const allowed = can('statements:read');
  const q = useQuery({ queryKey: ['stmt-overview', undefined, undefined, undefined], queryFn: () => statementApi.overview({}), enabled: allowed, retry: false });
  const d = q.data;
  if (!allowed || !d?.batch || !d.metrics) return null;
  const items = [
    { label: '总资产(期末)', value: formatMoney(d.metrics.total_assets_period_end) },
    { label: '资产负债率', value: formatRatioPercent(d.ratios?.debt_asset_ratio) },
    { label: '净利润(本年累计)', value: formatMoney(d.metrics.net_profit_ytd) },
  ];
  return (
    <div data-testid="statement-summary-card">
      <div className="bd-eyebrow">财报 / 当前批次摘要</div>
      <Card size="small" extra={<Typography.Link onClick={() => navigate('/statements')}>查看财务报表</Typography.Link>}
        title={<Typography.Text type="secondary" style={{ fontWeight: 400 }}>{d.batch.orgName} · {d.batch.period} · 单位 元</Typography.Text>}>
        <Row gutter={[16, 12]}>
          {items.map((it) => (
            <Col key={it.label} xs={24} sm={8}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>{it.label}</Typography.Text>
              <div className="kpi-value" style={{ fontSize: 22, fontVariantNumeric: 'tabular-nums' }}>{it.value}</div>
            </Col>
          ))}
        </Row>
      </Card>
    </div>
  );
}
