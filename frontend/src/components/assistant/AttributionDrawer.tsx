/**
 * 差异归因抽屉(方案《AI助手完整方案》4.3)。
 *
 * 只做展示:树形逐层展开、方向筛选与占比全部来自后端 /api/assistant/attribution,
 * 前端不重算金额、完成率或占比,仅把整数分换算成万元展示。
 */
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Alert, Button, Descriptions, Drawer, Empty, Segmented, Space, Spin, Table, Tag, Tooltip, Typography } from 'antd';
import type {
  AssistantContext, AttributionDirection, AttributionLeaf, AttributionNode, AttributionReport,
} from '../../api/assistant';
import { assistantApi } from '../../api/assistant';
import { ApiError } from '../../api/client';
import { centsToWan, formatQuantity, formatRateOrReason } from '../../utils/money';
import MoneyText from '../MoneyText';

const DIRECTION_OPTIONS: { value: AttributionDirection; label: string }[] = [
  { value: 'all', label: '全部' },
  { value: 'unfavorable', label: '不利' },
  { value: 'favorable', label: '有利' },
];

function shareText(share: number | null): string {
  if (share == null) return '—';
  return `${(Math.abs(share) * 100).toFixed(1)}%`;
}

function directionTag(favorable: AttributionNode['favorable']) {
  if (favorable === 'favorable') return <Tag color="green">有利</Tag>;
  if (favorable === 'unfavorable') return <Tag color="red">不利</Tag>;
  return <Tag>持平</Tag>;
}

function TreeTable({ nodes, dimensionLabel }: { nodes: AttributionNode[]; dimensionLabel: string }) {
  if (!nodes.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={`范围内没有${dimensionLabel}层数据`} />;
  return (
    <Table<AttributionNode>
      size="small"
      rowKey={(row) => `${row.dimension}-${row.id}`}
      dataSource={nodes}
      pagination={false}
      expandable={{ childrenColumnName: 'children', defaultExpandAllRows: true }}
      columns={[
        {
          title: dimensionLabel,
          render: (_: unknown, row) => (
            <Space size={4}>
              <Typography.Text>{row.code} {row.name}</Typography.Text>
              {row.isLeaf ? <Tag color="blue">末级</Tag> : null}
              {row.hiddenChildCount > 0 ? (
                <Tooltip title={`另有 ${row.hiddenChildCount} 个子节点未展开，其差异合计 ${centsToWan(row.hiddenVarianceCents)} 万元`}>
                  <Tag>+{row.hiddenChildCount}</Tag>
                </Tooltip>
              ) : null}
              {row.reconciled ? null : <Tag color="orange">子层未闭合</Tag>}
            </Space>
          ),
        },
        { title: '预算(万元)', align: 'right', width: 110, render: (_: unknown, row) => <MoneyText cents={row.budgetCents} hideUnit /> },
        { title: '实际(万元)', align: 'right', width: 110, render: (_: unknown, row) => <MoneyText cents={row.actualCents} hideUnit /> },
        { title: '差异(万元)', align: 'right', width: 110, render: (_: unknown, row) => <MoneyText cents={row.varianceCents} hideUnit tone={row.favorable === 'unfavorable' ? 'bad' : row.favorable === 'favorable' ? 'good' : 'neutral'} /> },
        { title: '方向', width: 70, render: (_: unknown, row) => directionTag(row.favorable) },
        { title: '完成率', align: 'right', width: 90, render: (_: unknown, row) => formatRateOrReason(row.rate, row.rateSpecial) },
        { title: '占父级', align: 'right', width: 80, render: (_: unknown, row) => shareText(row.shareOfParent) },
        { title: '占总差异', align: 'right', width: 90, render: (_: unknown, row) => shareText(row.shareOfTotal) },
      ]}
      scroll={{ x: 900 }}
    />
  );
}

function LeafTable({ rows, dimensionLabel }: { rows: AttributionLeaf[]; dimensionLabel: string }) {
  if (!rows.length) return <Empty image={Empty.PRESENTED_IMAGE_SIMPLE} description={`当前方向下没有${dimensionLabel}`} />;
  return (
    <Table<AttributionLeaf>
      size="small"
      rowKey={(row) => `${row.dimension}-${row.id}`}
      dataSource={rows}
      pagination={false}
      columns={[
        { title: dimensionLabel, render: (_: unknown, row) => <Tooltip title={row.path}>{`${row.code} ${row.name}`}</Tooltip> },
        { title: '差异(万元)', align: 'right', width: 110, render: (_: unknown, row) => <MoneyText cents={row.varianceCents} hideUnit tone={row.favorable === 'unfavorable' ? 'bad' : row.favorable === 'favorable' ? 'good' : 'neutral'} /> },
        { title: '方向', width: 70, render: (_: unknown, row) => directionTag(row.favorable) },
        { title: '完成率', align: 'right', width: 90, render: (_: unknown, row) => formatRateOrReason(row.rate, row.rateSpecial) },
        { title: '占总差异', align: 'right', width: 90, render: (_: unknown, row) => shareText(row.shareOfTotal) },
      ]}
      scroll={{ x: 620 }}
    />
  );
}

export function AttributionDrawer({
  open, onClose, context, onSaveInsight,
}: {
  open: boolean;
  onClose: () => void;
  context: AssistantContext;
  onSaveInsight?: (params: Record<string, unknown>) => void;
}) {
  const [direction, setDirection] = useState<AttributionDirection>('all');
  const [maxDepth, setMaxDepth] = useState(3);
  const versionId = context.budgetVersionId;

  const { data, isFetching, error } = useQuery<AttributionReport>({
    queryKey: ['assistant-attribution', versionId, context.actualSnapshotId, context.orgId, context.accountId, direction, maxDepth],
    queryFn: () => assistantApi.attribution({
      versionId: versionId as number,
      ...(context.actualSnapshotId == null ? {} : { batchId: context.actualSnapshotId }),
      ...(context.orgId == null ? {} : { orgScopeId: context.orgId }),
      ...(context.accountId == null ? {} : { accountScopeId: context.accountId }),
      maxDepth,
      topN: 10,
      direction,
    }),
    enabled: open && versionId != null,
  });

  return (
    <Drawer
      open={open} onClose={onClose} width="min(960px, 94vw)" title="差异归因(逐层展开)"
      extra={onSaveInsight && data ? (
        <Button
          size="small"
          onClick={() => onSaveInsight({ versionId, maxDepth, topN: 10, direction, ...(context.actualSnapshotId == null ? {} : { batchId: context.actualSnapshotId }) })}
        >
          保存为洞察
        </Button>
      ) : null}
    >
      {versionId == null ? (
        <Alert type="warning" showIcon message="请先在助手上下文中选择预算版本，归因必须绑定版本与其树快照。" />
      ) : (
        <Space direction="vertical" size={12} style={{ width: '100%' }}>
          <Alert
            type="info" showIcon
            message="差异 = 实际 − 预算，按带符号利润方向计算(正数有利)；占比按差异绝对值计算；数量型科目单独列出，不参与金额归因。"
          />
          <Space size={12} wrap>
            <Space size={4}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>方向</Typography.Text>
              <Segmented size="small" options={DIRECTION_OPTIONS} value={direction} onChange={(value) => setDirection(value as AttributionDirection)} />
            </Space>
            <Space size={4}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>展开层级</Typography.Text>
              <Segmented
                size="small"
                options={[{ value: 1, label: '1 层' }, { value: 2, label: '2 层' }, { value: 3, label: '3 层' }, { value: 5, label: '5 层' }]}
                value={maxDepth}
                onChange={(value) => setMaxDepth(Number(value))}
              />
            </Space>
          </Space>

          {error ? (
            <Alert type="error" showIcon message={error instanceof ApiError ? `${error.body.message}（${error.body.code}）` : '归因计算失败'} />
          ) : null}
          {isFetching && !data ? <Spin /> : null}

          {data ? (
            <>
              <Descriptions size="small" column={2} bordered>
                <Descriptions.Item label="版本">{data.version.name}（{data.version.year}，{data.version.status}）</Descriptions.Item>
                <Descriptions.Item label="实际截至">{data.asOfDate ?? '尚无实际批次'}{data.actualBatchId ? `（快照 #${data.actualBatchId}）` : ''}</Descriptions.Item>
                <Descriptions.Item label="预算合计(万元)"><MoneyText cents={data.totals.budgetCents} hideUnit /></Descriptions.Item>
                <Descriptions.Item label="实际合计(万元)"><MoneyText cents={data.totals.actualCents} hideUnit /></Descriptions.Item>
                <Descriptions.Item label="净差异(万元)">
                  <Space size={6}><MoneyText cents={data.totals.varianceCents} hideUnit tone={data.totals.favorable === 'unfavorable' ? 'bad' : data.totals.favorable === 'favorable' ? 'good' : 'neutral'} />{directionTag(data.totals.favorable)}</Space>
                </Descriptions.Item>
                <Descriptions.Item label="时间进度">{data.timeProgressValue == null ? '尚无实际批次，暂无时间进度基准' : formatRateOrReason(data.timeProgressValue)}</Descriptions.Item>
              </Descriptions>

              <Alert
                type={data.reconciliation.matched && data.reconciliation.unreconciledNodeCount === 0 ? 'success' : 'warning'}
                showIcon
                message={
                  data.reconciliation.matched && data.reconciliation.unreconciledNodeCount === 0
                    ? `守恒核对通过：组织维度与科目维度根层合计均为 ${centsToWan(data.reconciliation.orgRootVarianceCents)} 万元，各层子节点合计等于父节点。`
                    : `守恒核对未通过：组织维度 ${centsToWan(data.reconciliation.orgRootVarianceCents)} 万元、科目维度 ${centsToWan(data.reconciliation.accountRootVarianceCents)} 万元，`
                      + `${data.reconciliation.unreconciledNodeCount} 个节点子层不闭合，请检查筛选范围。`
                }
              />

              <Typography.Text strong>组织维度(逐层展开)</Typography.Text>
              <TreeTable nodes={data.byOrg} dimensionLabel="组织" />

              <Typography.Text strong>科目维度(逐层展开)</Typography.Text>
              <TreeTable nodes={data.byAccount} dimensionLabel="科目" />

              <Typography.Text strong>末级贡献排行(按方向与金额)</Typography.Text>
              <LeafTable rows={data.rankedAccountLeaves} dimensionLabel="科目" />
              <LeafTable rows={data.rankedOrgLeaves} dimensionLabel="组织" />

              {data.quantityVariances.length > 0 && (
                <>
                  <Typography.Text strong>数量型科目(不参与金额汇总)</Typography.Text>
                  <Table
                    size="small"
                    rowKey="accountId"
                    dataSource={data.quantityVariances}
                    pagination={false}
                    columns={[
                      { title: '科目', render: (_: unknown, row: any) => `${row.code} ${row.name}` },
                      { title: '单位', dataIndex: 'unit', width: 90 },
                      { title: '预算', align: 'right', width: 120, render: (_: unknown, row: any) => formatQuantity(row.budgetQuantity) },
                      { title: '实际', align: 'right', width: 120, render: (_: unknown, row: any) => formatQuantity(row.actualQuantity) },
                      { title: '差异', align: 'right', width: 120, render: (_: unknown, row: any) => formatQuantity(row.varianceQuantity) },
                      { title: '完成率', align: 'right', width: 90, render: (_: unknown, row: any) => formatRateOrReason(row.rate) },
                    ]}
                    scroll={{ x: 680 }}
                  />
                </>
              )}

              <Space direction="vertical" size={2}>
                {data.notes.map((note) => (
                  <Typography.Text key={note} type="secondary" style={{ fontSize: 12 }}>· {note}</Typography.Text>
                ))}
              </Space>
            </>
          ) : null}
        </Space>
      )}
    </Drawer>
  );
}
