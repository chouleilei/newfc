import { useAssistantDomainPage } from '../../assistant/contextHooks';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntdApp, Button, Card, Drawer, Form, Input, Modal, Select, Space, Table, Tag, Timeline, TreeSelect, Typography } from 'antd';
import { can, errorText } from '../../api/client';
import { mgmtApi } from '../../api/mgmt';
import type { MaAllocAdjustmentDto, MaAllocPreviewDto, MaAllocRunDto, MaCostPoolDto } from '../../api/financeData';
import { QueryErrorResult } from '../../components/QueryErrorResult';
import { shortTime } from '../../utils/relativeTime';
import { compact, defaultOrgId, EXCEPTION_REASON_FIELD, lastPeriod, Money, OrgSelect, PeriodPicker, useOrgTree, usePrompt } from '../financeData/shared';
import { SnapshotTable } from './MetricTabs';

/** 分摊:成本池 → 规则/权重 → 预览 → 确认(写 allocated_cost 快照)→ 作废;调整(守恒转移)→ 复核;血缘。 */

const ADJ_STATUS: Record<string, { text: string; color: string }> = {
  pending: { text: '待复核', color: 'warning' }, approved: { text: '已生效', color: 'success' }, rejected: { text: '已驳回', color: 'default' }, cancelled: { text: '已取消', color: 'default' },
};
const MONEY_RE = /^-?\d{1,16}(\.\d{1,2})?$/;

function PoolModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { message } = AntdApp.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm<{ name: string; orgId: number; period: string; total: string; note?: string }>();
  const create = useMutation({
    mutationFn: (v: { name: string; orgId: number; period: string; total: string; note?: string }) => mgmtApi.createPool(compact(v) as never),
    onSuccess: () => { message.success('成本池已创建,请设置分摊规则'); onClose(); void qc.invalidateQueries({ queryKey: ['ma-pools'] }); }, onError: (e) => message.error(errorText(e)),
  });
  return (
    <Modal open={open} title="新建成本池" onCancel={onClose} confirmLoading={create.isPending} destroyOnClose onOk={() => form.validateFields().then((v) => create.mutate(v))}>
      <Form form={form} layout="vertical" preserve={false} initialValues={{ orgId: defaultOrgId(), period: lastPeriod() }}>
        <Form.Item name="name" label="名称" rules={[{ required: true, whitespace: true }]}><Input maxLength={100} /></Form.Item>
        <Form.Item name="orgId" label="归属组织" rules={[{ required: true, message: '请选择组织' }]}><OrgSelect onChange={(v) => form.setFieldValue('orgId', v)} allowClear={false} width={300} /></Form.Item>
        <Form.Item name="period" label="期间" rules={[{ required: true }]}><PeriodPicker onChange={(v) => form.setFieldValue('period', v)} allowClear={false} /></Form.Item>
        <Form.Item name="total" label="总额(元)" rules={[{ required: true, pattern: /^\d{1,16}(\.\d{1,2})?$/, message: '正数,最多两位小数' }]}><Input /></Form.Item>
        <Form.Item name="note" label="说明"><Input.TextArea rows={2} maxLength={500} /></Form.Item>
      </Form>
    </Modal>
  );
}

function RulesModal({ pool, onClose }: { pool: MaCostPoolDto | null; onClose: () => void }) {
  const { message } = AntdApp.useApp();
  const qc = useQueryClient();
  const { treeData } = useOrgTree();
  const [form] = Form.useForm<{ rules: { targetOrgId: number; weight: string }[] }>();
  const save = useMutation({
    mutationFn: (v: { rules: { targetOrgId: number; weight: string }[] }) => mgmtApi.setRules(pool!.id, { expectedVersion: pool!.version, rules: v.rules.map((r) => ({ targetOrgId: r.targetOrgId, weight: String(r.weight) })) }),
    onSuccess: () => { message.success('规则已保存'); onClose(); void qc.invalidateQueries({ queryKey: ['ma-pools'] }); }, onError: (e) => message.error(errorText(e)),
  });
  return (
    <Modal open={!!pool} title={`分摊规则 · ${pool?.name ?? ''}`} width={620} onCancel={onClose} confirmLoading={save.isPending} destroyOnClose onOk={() => form.validateFields().then((v) => save.mutate(v))}>
      <Typography.Paragraph type="secondary">按权重比例分摊;前面的目标截断到分,最后一个目标吸收尾差,合计恒等于总额。保存会退役旧规则。</Typography.Paragraph>
      <Form form={form} preserve={false} initialValues={{ rules: pool?.rules.length ? pool.rules.map((r) => ({ targetOrgId: r.targetOrgId, weight: r.weight })) : [{}] }}>
        <Form.List name="rules">
          {(fields, { add, remove }) => (
            <>
              {fields.map((f) => (
                <Space key={f.key} align="baseline">
                  <Form.Item name={[f.name, 'targetOrgId']} rules={[{ required: true, message: '目标组织' }]}>
                    <TreeSelect treeData={treeData} treeDefaultExpandAll showSearch treeNodeFilterProp="title" style={{ width: 300 }} placeholder="目标组织" />
                  </Form.Item>
                  <Form.Item name={[f.name, 'weight']} rules={[{ required: true, pattern: /^\d{1,12}(\.\d{1,6})?$/, message: '权重' }]}>
                    <Input placeholder="权重" style={{ width: 120 }} />
                  </Form.Item>
                  <a onClick={() => remove(f.name)}>删除</a>
                </Space>
              ))}
              <Button type="dashed" onClick={() => add()} block>添加目标</Button>
            </>
          )}
        </Form.List>
      </Form>
    </Modal>
  );
}

function PreviewModal({ pool, onClose }: { pool: MaCostPoolDto | null; onClose: () => void }) {
  const { message } = AntdApp.useApp();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['ma-alloc-preview', pool?.id, pool?.version], queryFn: () => mgmtApi.previewAllocation(pool!.id), enabled: !!pool });
  const confirm = useMutation({
    mutationFn: (p: MaAllocPreviewDto) => mgmtApi.confirmAllocation(p.poolId, p.poolVersion),
    onSuccess: (r) => { message.success(`已确认分摊运行 #${r.id}`); onClose(); for (const k of ['ma-pools', 'ma-alloc-runs', 'ma-calc-runs']) void qc.invalidateQueries({ queryKey: [k] }); },
    onError: (e) => message.error(errorText(e)),
  });
  return (
    <Modal open={!!pool} title={`分摊预览 · ${pool?.name ?? ''}`} width={640} onCancel={onClose} okText="确认分摊" okButtonProps={{ disabled: !q.data || !can('mgmt:write') }}
      confirmLoading={confirm.isPending} onOk={() => q.data && confirm.mutate(q.data)} destroyOnClose>
      {q.error ? <QueryErrorResult title="预览失败" error={q.error} refetch={q.refetch} /> : (
        <Table
          size="small" rowKey="targetOrgId" loading={q.isLoading} dataSource={q.data?.results ?? []} pagination={false}
          summary={() => q.data && (
            <Table.Summary.Row><Table.Summary.Cell index={0} colSpan={2}>合计</Table.Summary.Cell><Table.Summary.Cell index={2} align="right"><Money value={q.data.total} /></Table.Summary.Cell></Table.Summary.Row>
          )}
          columns={[
            { title: '目标组织', dataIndex: 'targetOrgName' }, { title: '权重', dataIndex: 'weight', width: 120, align: 'right' },
            { title: '分摊金额', dataIndex: 'amount', width: 160, align: 'right', render: (v: string) => <Money value={v} /> },
          ]}
        />
      )}
    </Modal>
  );
}

function AdjustmentModal({ run, onClose }: { run: MaAllocRunDto | null; onClose: () => void }) {
  const { message } = AntdApp.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm<{ fromResultId: number; toResultId: number; amount: string; reason: string }>();
  const create = useMutation({
    mutationFn: (v: { fromResultId: number; toResultId: number; amount: string; reason: string }) => mgmtApi.createAdjustment(run!.id, v),
    onSuccess: () => { message.success('调整已提交,等待复核'); onClose(); void qc.invalidateQueries({ queryKey: ['ma-alloc-runs'] }); void qc.invalidateQueries({ queryKey: ['ma-alloc-adjustments'] }); },
    onError: (e) => message.error(errorText(e)),
  });
  const options = (run?.results ?? []).map((r) => ({ value: r.id, label: `${r.targetOrgName}(当前 ${r.amount})` }));
  return (
    <Modal open={!!run} title="提交分摊调整" onCancel={onClose} confirmLoading={create.isPending} destroyOnClose onOk={() => form.validateFields().then((v) => create.mutate(v))}>
      <Typography.Paragraph type="secondary">在同一运行内两个结果之间转移金额,合计保持不变;复核通过(提交人 ≠ 复核人)后生效并重写对应快照。</Typography.Paragraph>
      <Form form={form} layout="vertical" preserve={false}>
        <Form.Item name="fromResultId" label="转出" rules={[{ required: true }]}><Select options={options} /></Form.Item>
        <Form.Item name="toResultId" label="转入" rules={[{ required: true }]}><Select options={options} /></Form.Item>
        <Form.Item name="amount" label="金额(元)" rules={[{ required: true, pattern: MONEY_RE, message: '最多两位小数' }]}><Input /></Form.Item>
        <Form.Item name="reason" label="原因" rules={[{ required: true, whitespace: true }]}><Input.TextArea rows={2} maxLength={500} /></Form.Item>
      </Form>
    </Modal>
  );
}

function LineageDrawer({ runId, onClose }: { runId: number | null; onClose: () => void }) {
  const q = useQuery({ queryKey: ['ma-lineage', runId], queryFn: () => mgmtApi.lineage(runId!), enabled: runId != null });
  const KIND: Record<string, string> = { pool: '成本池', rule: '规则', run: '运行', result: '结果', adjustment: '调整', snapshot: '快照' };
  return (
    <Drawer open={runId != null} onClose={onClose} width={900} title={`分摊血缘 · 运行 #${runId ?? ''}`} destroyOnClose>
      {q.error ? <QueryErrorResult title="血缘加载失败" error={q.error} refetch={q.refetch} /> : q.data && (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Timeline items={q.data.chain.map((c) => ({ key: `${c.kind}-${c.id}`, children: <><Tag>{KIND[c.kind] ?? c.kind}</Tag>{c.label}{c.parent && <Typography.Text type="secondary"> ← {c.parent}</Typography.Text>}</> }))} />
          <Typography.Text strong>快照</Typography.Text>
          <SnapshotTable rows={q.data.snapshots} />
        </Space>
      )}
    </Drawer>
  );
}

export function AllocationTab() {
  const { message } = AntdApp.useApp();
  const qc = useQueryClient();
  const [period, setPeriod] = useState<string | undefined>();
  useAssistantDomainPage({ pageKey: 'mgmt', ready: true, scope: { period }, view: { tab: 'allocation' } });
  const [creating, setCreating] = useState(false);
  const [rulesOf, setRulesOf] = useState<MaCostPoolDto | null>(null);
  const [previewOf, setPreviewOf] = useState<MaCostPoolDto | null>(null);
  const [adjustOf, setAdjustOf] = useState<MaAllocRunDto | null>(null);
  const [lineageOf, setLineageOf] = useState<number | null>(null);
  const [prompt, holder] = usePrompt();
  const pools = useQuery({ queryKey: ['ma-pools', period], queryFn: () => mgmtApi.pools({ period }) });
  const runs = useQuery({ queryKey: ['ma-alloc-runs'], queryFn: () => mgmtApi.allocRuns({}) });
  const pending = useQuery({ queryKey: ['ma-alloc-adjustments'], queryFn: () => mgmtApi.pendingAdjustments() });
  const refresh = () => { for (const k of ['ma-pools', 'ma-alloc-runs', 'ma-alloc-adjustments', 'ma-calc-runs']) void qc.invalidateQueries({ queryKey: [k] }); };
  const voidRun = useMutation({ mutationFn: (v: { id: number; reason: string }) => mgmtApi.voidRun(v.id, v.reason), onSuccess: () => { message.success('已作废,相关快照随之作废'); refresh(); }, onError: (e) => message.error(errorText(e)) });
  const review = useMutation({
    mutationFn: (v: { a: MaAllocAdjustmentDto; action: 'approve' | 'reject'; comment?: string; exceptionReason?: string }) =>
      mgmtApi.reviewAdjustment(v.a.id, compact({ action: v.action, comment: v.comment, exceptionReason: v.exceptionReason }) as never),
    onSuccess: (a) => { message.success(a.status === 'approved' ? '调整已生效' : '已驳回'); refresh(); }, onError: (e) => message.error(errorText(e)),
  });
  const writable = can('mgmt:write');
  const act = async (a: MaAllocAdjustmentDto, action: 'approve' | 'reject') => {
    const v = await prompt({ title: action === 'approve' ? '批准分摊调整' : '驳回分摊调整', danger: action === 'reject', fields: [{ name: 'comment', label: '复核意见', multiline: true }, EXCEPTION_REASON_FIELD] });
    if (v) review.mutate({ a, action, comment: v.comment, exceptionReason: v.exceptionReason });
  };
  if (pools.error) return <QueryErrorResult title="成本池加载失败" error={pools.error} refetch={pools.refetch} />;
  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {holder}
      <Space>
        <PeriodPicker value={period} onChange={setPeriod} />
        {writable && <Button type="primary" onClick={() => setCreating(true)}>新建成本池</Button>}
      </Space>
      <Table<MaCostPoolDto>
        size="small" rowKey="id" loading={pools.isLoading} dataSource={pools.data ?? []} pagination={false}
        columns={[
          { title: '成本池', dataIndex: 'name' }, { title: '归属组织', dataIndex: 'orgName', width: 150 }, { title: '期间', dataIndex: 'period', width: 90 },
          { title: '总额', dataIndex: 'total', width: 150, align: 'right', render: (v: string) => <Money value={v} /> },
          { title: '规则', dataIndex: 'rules', render: (rs: MaCostPoolDto['rules']) => rs.map((r) => <Tag key={r.id}>{r.targetOrgName} × {r.weight}</Tag>) },
          { title: '状态', dataIndex: 'confirmedRunId', width: 110, render: (v: number | null) => (v ? <Tag color="success">已确认 #{v}</Tag> : <Tag>未确认</Tag>) },
          {
            title: '操作', width: 150, render: (_: unknown, p) => (p.confirmedRunId ? null : (
              <Space>
                {writable && <a onClick={() => setRulesOf(p)}>规则</a>}
                {p.rules.length > 0 && <a onClick={() => setPreviewOf(p)}>预览/确认</a>}
              </Space>
            )),
          },
        ]}
      />
      <Card size="small" title="待复核调整">
        {pending.error ? <QueryErrorResult title="待复核调整加载失败" error={pending.error} refetch={pending.refetch} /> : (
          <Table<MaAllocAdjustmentDto>
            size="small" rowKey="id" loading={pending.isLoading} dataSource={pending.data ?? []} pagination={false}
            columns={[
              { title: '运行', dataIndex: 'runId', width: 70, render: (v: number) => `#${v}` },
              { title: '转出 → 转入', render: (_: unknown, a) => `${a.fromOrgName} → ${a.toOrgName}` },
              { title: '金额', dataIndex: 'amount', width: 140, align: 'right', render: (v: string) => <Money value={v} /> },
              { title: '原因', dataIndex: 'reason', ellipsis: true },
              { title: '提交', dataIndex: 'submittedAt', width: 130, render: (v: string) => shortTime(v) },
              { title: '操作', width: 110, render: (_: unknown, a) => (can('mgmt:review') ? <Space><a onClick={() => void act(a, 'approve')}>批准</a><a onClick={() => void act(a, 'reject')}>驳回</a></Space> : null) },
            ]}
          />
        )}
      </Card>
      <Card size="small" title="分摊运行">
        {runs.error ? <QueryErrorResult title="分摊运行加载失败" error={runs.error} refetch={runs.refetch} /> : (
          <Table<MaAllocRunDto>
            size="small" rowKey="id" loading={runs.isLoading} dataSource={runs.data ?? []} pagination={{ pageSize: 10, showSizeChanger: false }}
            expandable={{
              expandedRowRender: (r) => (
                <Table
                  size="small" rowKey="id" pagination={false} dataSource={r.results}
                  columns={[
                    { title: '目标组织', dataIndex: 'targetOrgName' }, { title: '权重', dataIndex: 'weight', width: 110, align: 'right' },
                    { title: '原始分摊', dataIndex: 'baseAmount', width: 140, align: 'right', render: (v: string) => <Money value={v} /> },
                    { title: '当前金额', dataIndex: 'amount', width: 140, align: 'right', render: (v: string) => <Money value={v} /> },
                  ]}
                  footer={() => (r.adjustments.length ? r.adjustments.map((a) => (
                    <div key={a.id}><Tag color={ADJ_STATUS[a.status].color}>{ADJ_STATUS[a.status].text}</Tag>{a.fromOrgName} → {a.toOrgName} <Money value={a.amount} />:{a.reason}</div>
                  )) : null)}
                />
              ),
            }}
            columns={[
              { title: '运行', dataIndex: 'id', width: 70, render: (v: number) => `#${v}` },
              { title: '成本池', dataIndex: 'poolName' }, { title: '期间', dataIndex: 'period', width: 90 },
              { title: '总额', dataIndex: 'total', width: 140, align: 'right', render: (v: string) => <Money value={v} /> },
              { title: '状态', dataIndex: 'status', width: 90, render: (v: string, r) => (v === 'confirmed' ? <Tag color="success">已确认</Tag> : <Tag title={r.voidReason ?? ''}>已作废</Tag>) },
              { title: '确认', dataIndex: 'confirmedAt', width: 130, render: (v: string) => shortTime(v) },
              {
                title: '操作', width: 170, render: (_: unknown, r) => (
                  <Space>
                    <a onClick={() => setLineageOf(r.id)}>血缘</a>
                    {writable && r.status === 'confirmed' && <a onClick={() => setAdjustOf(r)}>调整</a>}
                    {writable && r.status === 'confirmed' && (
                      <a onClick={async () => { const v = await prompt({ title: '作废分摊运行', danger: true, description: '作废后该运行的快照不再有效,待复核调整一并取消。', fields: [{ name: 'reason', label: '作废原因', required: true, multiline: true }] }); if (v) voidRun.mutate({ id: r.id, reason: v.reason }); }}>作废</a>
                    )}
                  </Space>
                ),
              },
            ]}
          />
        )}
      </Card>
      <PoolModal open={creating} onClose={() => setCreating(false)} />
      <RulesModal pool={rulesOf} onClose={() => setRulesOf(null)} />
      <PreviewModal pool={previewOf} onClose={() => setPreviewOf(null)} />
      <AdjustmentModal run={adjustOf} onClose={() => setAdjustOf(null)} />
      <LineageDrawer runId={lineageOf} onClose={() => setLineageOf(null)} />
    </Space>
  );
}
