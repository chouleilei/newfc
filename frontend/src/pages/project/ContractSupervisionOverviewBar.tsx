import { useQuery } from '@tanstack/react-query';
import { Card, Col, Row, Space, Statistic, Tag, Typography } from 'antd';
import { contractApi } from '../../api/projectContract';
import { Money, Ratio } from '../financeData/shared';

export function ContractSupervisionOverviewBar({
  open,
  orgId,
}: {
  open: boolean;
  orgId?: number;
}) {
  const q = useQuery({
    queryKey: ['contract-supervision-portal-full', orgId ?? 'all'],
    queryFn: () => contractApi.supervisionPortalFull(orgId ? { orgId } : undefined),
    enabled: open,
    staleTime: 30_000,
  });

  if (!open) return null;
  const sum = q.data?.summary;

  return (
    <Card
      size="small"
      loading={q.isLoading}
      style={{ marginBottom: 12, background: 'var(--newfc-bg-subtle)' }}
      title={
        <Space size={8} wrap>
          <span>纪巡财审协同监督统计概览</span>
          <Typography.Text type="secondary" style={{ fontSize: 12, fontWeight: 400 }}>
            同源只读统计（含招采分级分布、施工结算支付与量化风险闭环）
          </Typography.Text>
        </Space>
      }
    >
      {sum ? (
        <Row gutter={[16, 12]}>
          <Col xs={24} md={6}>
            <Statistic
              title="已签合同总规模（人民币）"
              valueRender={() => <Money value={sum.totalSignedAmount} />}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              共 {sum.totalContracts} 份（支出 {sum.expenseCount} · 收入 {sum.incomeCount}）
            </Typography.Text>
          </Col>
          <Col xs={24} md={6}>
            <Statistic
              title={`施工合同（${sum.constructionSummary.count} 份）已结 / 已付`}
              valueRender={() => (
                <span style={{ fontSize: 16 }}>
                  <Money value={sum.constructionSummary.settledAmount} /> /{' '}
                  <Money value={sum.constructionSummary.paidAmount} />
                </span>
              )}
            />
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              施工合同总额：<Money value={sum.constructionSummary.contractAmount} />
            </Typography.Text>
          </Col>
          <Col xs={24} md={7}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>
              采购层级与方式分布
            </Typography.Text>
            <div style={{ marginTop: 6 }}>
              <Space size={[4, 4]} wrap>
                <Tag color="blue">一级采购 {sum.procurementDistribution.tier1Count}</Tag>
                <Tag color="cyan">二级采购 {sum.procurementDistribution.tier2Count}</Tag>
                <Tag>三级采购 {sum.procurementDistribution.tier3Count}</Tag>
              </Space>
            </div>
            <div style={{ marginTop: 4, fontSize: 12 }}>
              <Space size={12} wrap>
                <span>
                  直接采购 {sum.procurementDistribution.directCount} 份（
                  {sum.procurementDistribution.directRatio == null ? (
                    '—'
                  ) : (
                    <Ratio value={sum.procurementDistribution.directRatio} />
                  )}
                  ）
                </span>
                <span>
                  询比采购 {sum.procurementDistribution.inquiryCount} 份（
                  {sum.procurementDistribution.inquiryRatio == null ? (
                    '—'
                  ) : (
                    <Ratio value={sum.procurementDistribution.inquiryRatio} />
                  )}
                  ）
                </span>
              </Space>
            </div>
          </Col>
          <Col xs={24} md={5}>
            <Statistic
              title="量化预警已整改闭环 / 总计"
              value={sum.riskStats.rectifiedClosedAlerts}
              suffix={`/ ${sum.riskStats.totalAlerts}`}
            />
            {(sum.missingFxContractCount ?? 0) > 0 && (
              <Tag color="warning" style={{ marginTop: 4 }}>
                {sum.missingFxContractCount} 份外币缺参考汇率
              </Tag>
            )}
          </Col>
        </Row>
      ) : (
        <Typography.Text type="secondary">暂无监督统计数据</Typography.Text>
      )}
    </Card>
  );
}
