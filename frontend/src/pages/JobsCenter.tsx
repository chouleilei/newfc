import { useAssistantDomainPage } from '../assistant/contextHooks';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntdApp, Button, Card, Descriptions, Drawer, Popconfirm, Progress, Select, Space, Table, Tabs, Tag, Tooltip, Typography } from 'antd';
import { api, can, errorText, getSession } from '../api/client';
import { QueryErrorResult } from '../components/QueryErrorResult';
import { shortTime } from '../utils/relativeTime';

type JobStatus = 'queued' | 'running' | 'succeeded' | 'failed' | 'cancelled' | 'interrupted';

interface JobItem {
  id: number;
  kind: string;
  /** 服务端给出的中文类型名;未登记类型等于 kind */
  kindLabel?: string;
  title: string;
  status: JobStatus;
  progress: { permille: number; message: string };
  requestId: string;
  result: unknown;
  error: { code: string; message: string } | null;
  cancelRequested: boolean;
  createdAt: string;
  startedAt: string | null;
  finishedAt: string | null;
}

interface JobStep {
  seq: number; name: string; type: string; status: 'success' | 'error' | 'skipped';
  detail: string; errorMessage: string; elapsedMs: number | null; createdAt: string;
}

interface ModelCall {
  id: number; feature: string; provider: string; model: string; channelName: string; stream: boolean;
  status: 'success' | 'error' | 'timeout' | 'cancelled'; errorType: string; errorMessage: string; fallbackUsed: boolean;
  latencyMs: number; promptTokens: number | null; completionTokens: number | null; tokensEstimated: boolean;
  jobId: number | null; source: string; requestId: string; createdAt: string;
}

interface CallStat {
  feature: string; status: string; calls: number; avgLatencyMs: number; maxLatencyMs: number;
  fallbackCalls: number; reportedTokens: number; estimatedTokens: number;
}

export const JOB_STATUS_META: Record<JobStatus, { label: string; color: string }> = {
  queued: { label: '排队中', color: 'default' },
  running: { label: '运行中', color: 'processing' },
  succeeded: { label: '已完成', color: 'success' },
  failed: { label: '失败', color: 'error' },
  cancelled: { label: '已取消', color: 'warning' },
  interrupted: { label: '已中断', color: 'warning' },
};

const CALL_STATUS: Record<ModelCall['status'], { label: string; color: string }> = {
  success: { label: '成功', color: 'success' },
  error: { label: '错误', color: 'error' },
  timeout: { label: '超时', color: 'warning' },
  cancelled: { label: '已取消', color: 'default' },
};

const PAGE_SIZE = 20;

function JobsTab() {
  const { message } = AntdApp.useApp();
  const qc = useQueryClient();
  const [status, setStatus] = useState<JobStatus | undefined>();
  const [page, setPage] = useState(1);
  const [openId, setOpenId] = useState<number | null>(null);
  useAssistantDomainPage({ pageKey: 'jobs', ready: true, scope: { jobId: openId ?? undefined }, view: { status } });
  const jobs = useQuery({
    queryKey: ['jobs', status, page],
    queryFn: () => api.get<{ total: number; items: JobItem[] }>(`/jobs?page=${page}&pageSize=${PAGE_SIZE}${status ? `&status=${status}` : ''}`),
    // 有未结束任务时轮询进度
    refetchInterval: (q) => (q.state.data?.items.some((j) => j.status === 'queued' || j.status === 'running') ? 2000 : false),
  });
  const detail = useQuery({
    queryKey: ['job', openId],
    queryFn: () => api.get<JobItem & { steps: JobStep[] }>(`/jobs/${openId}`),
    enabled: openId !== null,
    refetchInterval: (q) => (q.state.data && (q.state.data.status === 'queued' || q.state.data.status === 'running') ? 2000 : false),
  });
  const cancel = useMutation({
    mutationFn: (id: number) => api.post<JobItem>(`/jobs/${id}/cancel`),
    onSuccess: (job) => {
      message.success(job.status === 'cancelled' ? '任务已取消' : '已请求取消,任务将在下一个检查点停止');
      void qc.invalidateQueries({ queryKey: ['jobs'] });
      void qc.invalidateQueries({ queryKey: ['job'] });
    },
    onError: (e) => message.error(errorText(e)),
  });

  if (jobs.error) return <QueryErrorResult title="任务列表加载失败" error={jobs.error} refetch={jobs.refetch} />;
  const d = detail.data;
  return (
    <>
      <Space style={{ marginBottom: 12 }}>
        <Select<JobStatus>
          allowClear placeholder="全部状态" style={{ width: 140 }} value={status}
          onChange={(v) => { setStatus(v); setPage(1); }}
          options={Object.entries(JOB_STATUS_META).map(([value, m]) => ({ value: value as JobStatus, label: m.label }))}
        />
        <Typography.Text type="secondary">任务在服务进程内执行;服务重启时未完成的任务标为“已中断”,需重新提交。</Typography.Text>
      </Space>
      <Table<JobItem>
        rowKey="id"
        loading={jobs.isLoading}
        dataSource={jobs.data?.items ?? []}
        pagination={{ current: page, pageSize: PAGE_SIZE, total: jobs.data?.total ?? 0, onChange: setPage, showSizeChanger: false }}
        columns={[
          { title: 'ID', dataIndex: 'id', width: 70 },
          { title: '任务', dataIndex: 'title', render: (v: string, j) => <a onClick={() => setOpenId(j.id)}>{v}</a> },
          { title: '类型', dataIndex: 'kind', render: (v: string, r: JobItem) => (r.kindLabel && r.kindLabel !== v ? <Tooltip title={v}>{r.kindLabel}</Tooltip> : <Typography.Text code>{v}</Typography.Text>) },
          { title: '状态', dataIndex: 'status', width: 100, render: (v: JobStatus) => <Tag color={JOB_STATUS_META[v].color}>{JOB_STATUS_META[v].label}</Tag> },
          {
            title: '进度', width: 200,
            render: (_, j) => j.status === 'running' || j.status === 'queued'
              ? <Progress percent={Math.round(j.progress.permille / 10)} size="small" status="active" />
              : j.error ? <Typography.Text type="danger" ellipsis style={{ maxWidth: 180 }}>{j.error.message}</Typography.Text> : null,
          },
          { title: '提交时间', dataIndex: 'createdAt', width: 150, render: (v: string) => shortTime(v) },
          {
            title: '操作', width: 90,
            render: (_, j) => (j.status === 'queued' || j.status === 'running') && !j.cancelRequested ? (
              <Popconfirm title="取消该任务?" onConfirm={() => cancel.mutate(j.id)}>
                <Button size="small" danger>取消</Button>
              </Popconfirm>
            ) : j.cancelRequested && j.status === 'running' ? <Tag>取消中</Tag> : null,
          },
        ]}
      />
      <Drawer open={openId !== null} onClose={() => setOpenId(null)} width={640} title={d ? `任务 #${d.id} ${d.title}` : '任务详情'}>
        {detail.error && <QueryErrorResult title="任务详情加载失败" error={detail.error} refetch={detail.refetch} />}
        {d && (
          <>
            <Descriptions size="small" column={2} bordered>
              <Descriptions.Item label="状态"><Tag color={JOB_STATUS_META[d.status].color}>{JOB_STATUS_META[d.status].label}</Tag></Descriptions.Item>
              <Descriptions.Item label="进度">{(d.progress.permille / 10).toFixed(1)}% {d.progress.message}</Descriptions.Item>
              <Descriptions.Item label="提交">{shortTime(d.createdAt)}</Descriptions.Item>
              <Descriptions.Item label="结束">{d.finishedAt ? shortTime(d.finishedAt) : '—'}</Descriptions.Item>
              <Descriptions.Item label="请求 ID" span={2}><Typography.Text copyable code>{d.requestId || '—'}</Typography.Text></Descriptions.Item>
              {d.error && <Descriptions.Item label="错误" span={2}><Typography.Text type="danger">{d.error.code}:{d.error.message}</Typography.Text></Descriptions.Item>}
            </Descriptions>
            <Typography.Title level={5} style={{ marginTop: 16 }}>执行步骤</Typography.Title>
            <Table<JobStep>
              rowKey="seq" size="small" pagination={false} dataSource={d.steps}
              locale={{ emptyText: '该任务没有记录步骤' }}
              columns={[
                { title: '#', dataIndex: 'seq', width: 40 },
                { title: '步骤', dataIndex: 'name' },
                { title: '类型', dataIndex: 'type', width: 70 },
                { title: '结果', dataIndex: 'status', width: 70, render: (v: JobStep['status']) => <Tag color={v === 'success' ? 'success' : v === 'error' ? 'error' : 'default'}>{v === 'success' ? '成功' : v === 'error' ? '失败' : '跳过'}</Tag> },
                { title: '说明', render: (_, s) => s.errorMessage || s.detail },
                { title: '耗时', dataIndex: 'elapsedMs', width: 80, render: (v: number | null) => (v == null ? '—' : `${v} ms`) },
              ]}
            />
          </>
        )}
      </Drawer>
    </>
  );
}

function ModelCallsTab() {
  const [feature, setFeature] = useState<string | undefined>();
  const [status, setStatus] = useState<ModelCall['status'] | undefined>();
  const [page, setPage] = useState(1);
  const qs = `${feature ? `&feature=${encodeURIComponent(feature)}` : ''}${status ? `&status=${status}` : ''}`;
  const calls = useQuery({
    queryKey: ['model-calls', feature, status, page],
    queryFn: () => api.get<{ total: number; items: ModelCall[] }>(`/model-calls?page=${page}&pageSize=${PAGE_SIZE}${qs}`),
  });
  const stats = useQuery({
    queryKey: ['model-calls-stats'],
    queryFn: () => api.get<{ items: CallStat[] }>('/model-calls/stats'),
  });
  if (calls.error) return <QueryErrorResult title="模型调用记录加载失败" error={calls.error} refetch={calls.refetch} />;
  const features = [...new Set((stats.data?.items ?? []).map((s) => s.feature))];
  return (
    <>
      <Typography.Paragraph type="secondary">只记录调用规模、耗时、结果与错误分类,不保存提示词与回答正文。token 优先取供应商返回的用量,缺失时按字符估算并标注“估算”。</Typography.Paragraph>
      <Table<CallStat>
        rowKey={(s) => `${s.feature}:${s.status}`}
        size="small"
        pagination={false}
        loading={stats.isLoading}
        dataSource={stats.data?.items ?? []}
        style={{ marginBottom: 16 }}
        locale={{ emptyText: '暂无模型调用' }}
        columns={[
          { title: '功能', dataIndex: 'feature' },
          { title: '结果', dataIndex: 'status', render: (v: ModelCall['status']) => <Tag color={CALL_STATUS[v]?.color}>{CALL_STATUS[v]?.label ?? v}</Tag> },
          { title: '次数', dataIndex: 'calls', align: 'right' },
          { title: '平均耗时', dataIndex: 'avgLatencyMs', align: 'right', render: (v: number) => `${v} ms` },
          { title: '最大耗时', dataIndex: 'maxLatencyMs', align: 'right', render: (v: number) => `${v} ms` },
          { title: '备用渠道', dataIndex: 'fallbackCalls', align: 'right' },
          { title: 'token(上报/估算)', align: 'right', render: (_, s) => `${s.reportedTokens} / ${s.estimatedTokens}` },
        ]}
      />
      <Space style={{ marginBottom: 12 }}>
        <Select allowClear placeholder="全部功能" style={{ width: 180 }} value={feature} onChange={(v) => { setFeature(v); setPage(1); }}
          options={features.map((f) => ({ value: f, label: f }))} />
        <Select<ModelCall['status']> allowClear placeholder="全部结果" style={{ width: 120 }} value={status} onChange={(v) => { setStatus(v); setPage(1); }}
          options={Object.entries(CALL_STATUS).map(([value, m]) => ({ value: value as ModelCall['status'], label: m.label }))} />
      </Space>
      <Table<ModelCall>
        rowKey="id"
        size="small"
        loading={calls.isLoading}
        dataSource={calls.data?.items ?? []}
        pagination={{ current: page, pageSize: PAGE_SIZE, total: calls.data?.total ?? 0, onChange: setPage, showSizeChanger: false }}
        columns={[
          { title: '时间', dataIndex: 'createdAt', width: 150, render: (v: string) => shortTime(v) },
          { title: '功能', dataIndex: 'feature' },
          { title: '渠道/模型', render: (_, c) => <span>{c.channelName || c.provider}{c.model ? ` · ${c.model}` : ''}{c.fallbackUsed && <Tag style={{ marginLeft: 4 }}>备用</Tag>}</span> },
          { title: '结果', dataIndex: 'status', width: 80, render: (v: ModelCall['status']) => <Tag color={CALL_STATUS[v].color}>{CALL_STATUS[v].label}</Tag> },
          { title: '错误', render: (_, c) => (c.errorType ? <Typography.Text type="danger">{c.errorType}{c.errorMessage ? `:${c.errorMessage}` : ''}</Typography.Text> : null) },
          { title: '耗时', dataIndex: 'latencyMs', width: 90, align: 'right', render: (v: number) => `${v} ms` },
          {
            title: 'token', width: 130, align: 'right',
            render: (_, c) => c.promptTokens == null && c.completionTokens == null ? '—'
              : <span>{(c.promptTokens ?? 0) + (c.completionTokens ?? 0)}{c.tokensEstimated && <Typography.Text type="secondary"> 估算</Typography.Text>}</span>,
          },
          { title: '来源', dataIndex: 'source', width: 80, render: (v: string, c) => (c.jobId ? `任务 #${c.jobId}` : v) },
        ]}
      />
    </>
  );
}

/** 任务中心(AC-F21):我的后台任务进度/取消/步骤;有 tasks:read 权限的全组织用户另可查看模型调用记录。 */
export default function JobsCenter() {
  const items = [{ key: 'jobs', label: '后台任务', children: <JobsTab /> }];
  if (can('tasks:read') && getSession()?.user.allOrgs) items.push({ key: 'model-calls', label: '模型调用', children: <ModelCallsTab /> });
  return (
    <Card>
      <Tabs items={items} />
    </Card>
  );
}
