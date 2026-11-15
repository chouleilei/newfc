import { useMemo, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import {
  Alert, App as AntdApp, Button, Collapse, Form, Input, Modal, Select, Space, Table, Tag, Typography,
} from 'antd';
import { can, errorText } from '../../api/client';
import {
  contractApi,
  type ContractCountersignDecideRequest,
  type ContractCountersignDto,
  type ContractDetailDto,
  type CountersignStatus,
} from '../../api/projectContract';
import { shortTime } from '../../utils/relativeTime';

const STATUS_META: Record<CountersignStatus, { text: string; color: string }> = {
  pending: { text: '待会签', color: 'processing' },
  approved: { text: '同意通过', color: 'success' },
  returned: { text: '退回修改', color: 'error' },
  waived: { text: '制度豁免', color: 'gold' },
  superseded: { text: '已因合同变更失效重签', color: 'default' },
};

export function ContractCountersignTab({
  contract,
  onChanged,
}: {
  contract: ContractDetailDto;
  onChanged: (d?: ContractDetailDto) => void;
}) {
  const { message } = AntdApp.useApp();
  const writable = can('contract:write') && contract.status === 'active';
  const reviewer = can('contract:review') && contract.status === 'active';

  const [decidingRow, setDecidingRow] = useState<ContractCountersignDto | null>(null);
  const [form] = Form.useForm<ContractCountersignDecideRequest>();

  const listQ = useQuery({
    queryKey: ['contract-countersigns', contract.id, contract.version],
    queryFn: () => contractApi.countersigns(contract.id),
    initialData: contract.countersigns,
  });
  const allRows = listQ.data ?? contract.countersigns ?? [];

  const latestRound = useMemo(
    () => (allRows.length > 0 ? Math.max(...allRows.map((r) => r.roundNo)) : 1),
    [allRows],
  );
  const currentRoundRows = useMemo(
    () => allRows.filter((r) => r.roundNo === latestRound && r.status !== 'superseded'),
    [allRows, latestRound],
  );
  const supersededRows = useMemo(
    () => allRows.filter((r) => r.status === 'superseded' || r.roundNo < latestRound),
    [allRows, latestRound],
  );

  const triggerMut = useMutation({
    mutationFn: () => contractApi.triggerCountersigns(contract.id),
    onSuccess: () => {
      message.success('已按合同类别与金额生成/同步多部门会签清单');
      void listQ.refetch();
      onChanged();
    },
    onError: (e) => message.error(errorText(e)),
  });

  const decideMut = useMutation({
    mutationFn: (v: ContractCountersignDecideRequest) =>
      contractApi.decideCountersign(contract.id, decidingRow!.id, v),
    onSuccess: () => {
      message.success('会签结论已提交');
      setDecidingRow(null);
      void listQ.refetch();
      onChanged();
    },
    onError: (e) => message.error(errorText(e)),
  });

  const pendingCount = currentRoundRows.filter((r) => r.status === 'pending').length;
  const overdueCount = currentRoundRows.filter((r) => r.status === 'pending' && r.overdue).length;

  const buildColumns = (interactive: boolean) => [
    { title: '轮次', dataIndex: 'roundNo', width: 72, render: (n: number) => `第${n}轮` },
    { title: '部门名称', dataIndex: 'deptName', width: 135 },
    { title: '触发规则依据', dataIndex: 'triggerReason', ellipsis: true },
    {
      title: '指定审查人/部门状态',
      key: 'reviewer',
      width: 155,
      render: (_: unknown, r: ContractCountersignDto) =>
        r.reviewerName || r.assignedReviewerName || '部门会签组',
    },
    {
      title: '应反馈时限',
      key: 'due',
      width: 155,
      render: (_: unknown, r: ContractCountersignDto) =>
        r.dueDate ? (
          <Space size={4} wrap>
            <Typography.Text type={r.overdue ? 'danger' : undefined}>{r.dueDate}</Typography.Text>
            {r.overdue && <Tag color="error">已超期</Tag>}
          </Space>
        ) : (
          <Typography.Text type="secondary">未配置时限（仅计历时）</Typography.Text>
        ),
    },
    {
      title: '会签状态',
      dataIndex: 'status',
      width: 165,
      render: (s: CountersignStatus) => <Tag color={STATUS_META[s]?.color ?? 'default'}>{STATUS_META[s]?.text ?? s}</Tag>,
    },
    { title: '会签意见', dataIndex: 'opinion', width: 180, ellipsis: true, render: (v: string) => v || '—' },
    { title: '决定时间', dataIndex: 'decidedAt', width: 130, render: (v: string | null) => (v ? shortTime(v) : '—') },
    ...(interactive
      ? [
          {
            title: '操作',
            key: 'op',
            width: 135,
            render: (_: unknown, r: ContractCountersignDto) =>
              reviewer && r.canDecide && r.status === 'pending' ? (
                <Button
                  size="small"
                  type="primary"
                  onClick={() => {
                    form.resetFields();
                    form.setFieldsValue({ decision: 'approved', opinion: '' });
                    setDecidingRow(r);
                  }}
                >
                  录入会签结论
                </Button>
              ) : (
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {r.status === 'pending' ? '仅本部门可签' : '—'}
                </Typography.Text>
              ),
          },
        ]
      : []),
  ];

  return (
    <Space direction="vertical" style={{ width: '100%' }} size={12}>
      <Space wrap style={{ justifyContent: 'space-between', width: '100%' }}>
        <Space wrap>
          <Tag color={pendingCount > 0 ? 'processing' : 'success'}>
            当前轮次第 {latestRound} 轮 · 待会签 {pendingCount} 个部门
          </Tag>
          {overdueCount > 0 && <Tag color="error">超期未反馈 {overdueCount} 个部门</Tag>}
        </Space>
        {writable && (
          <Button loading={triggerMut.isPending} onClick={() => triggerMut.mutate()}>
            {allRows.length > 0 ? '重算并同步会签部门' : '发起制度多部门会签'}
          </Button>
        )}
      </Space>

      {pendingCount > 0 && (
        <Alert
          type="warning"
          showIcon
          message={`当前尚有 ${pendingCount} 个归口管理部门未完成会签签署，全部同意（approved）或豁免（waived）前将阻断合同进入履约阶段。`}
        />
      )}

      <Table<ContractCountersignDto>
        rowKey="id"
        size="small"
        loading={listQ.isFetching}
        pagination={false}
        dataSource={currentRoundRows}
        scroll={{ x: 1120 }}
        locale={{ emptyText: '暂未发起结构化多部门会签，点击右上角「发起制度多部门会签」自动匹配应签部门' }}
        columns={buildColumns(true)}
      />

      {supersededRows.length > 0 && (
        <Collapse
          size="small"
          items={[
            {
              key: 'superseded',
              label: `已因合同变更失效重签的历史会签记录 (superseded · ${supersededRows.length} 条)`,
              children: (
                <Table<ContractCountersignDto>
                  rowKey="id"
                  size="small"
                  pagination={false}
                  dataSource={supersededRows}
                  scroll={{ x: 1000 }}
                  columns={buildColumns(false)}
                />
              ),
            },
          ]}
        />
      )}

      <Modal
        open={decidingRow != null}
        title={decidingRow ? `录入会签结论 · ${decidingRow.deptName}（第 ${decidingRow.roundNo} 轮）` : '录入会签结论'}
        onCancel={() => setDecidingRow(null)}
        confirmLoading={decideMut.isPending}
        destroyOnClose
        okText="提交会签结论"
        onOk={() => form.validateFields().then((v) => decideMut.mutate(v), () => undefined)}
      >
        <Form form={form} layout="vertical" preserve={false} initialValues={{ decision: 'approved' }}>
          <Form.Item name="decision" label="会签结论" rules={[{ required: true, message: '请选择会签结论' }]}>
            <Select
              options={[
                { value: 'approved', label: '同意通过 (approved)' },
                { value: 'returned', label: '退回修改 (returned)' },
                { value: 'waived', label: '按制度豁免本部门会签 (waived)' },
              ]}
            />
          </Form.Item>
          <Form.Item
            name="opinion"
            label="会签审查意见"
            rules={[{ required: true, whitespace: true, message: '请填写明确会签意见' }]}
          >
            <Input.TextArea rows={3} maxLength={1000} placeholder="请填写本部门专业审查或豁免依据说明" />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
