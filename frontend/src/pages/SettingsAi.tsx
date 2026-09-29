import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App as AntdApp, Badge, Button, Card, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Switch, Table, Tag, Typography } from 'antd';
import { api, ApiError } from '../api/client';
import { QueryErrorResult } from '../components/QueryErrorResult';
import { shortTime } from '../utils/relativeTime';
import { useAssistantPageContext } from '../assistant/contextHooks';

interface ChannelItem {
  id: number;
  name: string;
  baseUrl: string;
  keyPreview: string;
  hasKey: boolean;
  model: string;
  timeoutMs: number;
  stream: boolean;
  enabled: boolean;
  lastTestStatus: 'ok' | 'degraded' | 'fail' | null;
  lastTestLatencyMs: number | null;
  lastTestMessage: string | null;
  lastTestedAt: string | null;
}

interface BindingItem {
  feature: string;
  primaryChannelId: number | null;
  fallbackChannelId: number | null;
}

const FEATURE_LABELS: Record<string, { label: string; desc: string }> = {
  chat: { label: '助手对话', desc: 'AI 助手的意图路由与对话生成' },
  narrative: { label: '叙述改写', desc: '报告草稿、质量建议、趋势叙述共用的改写管道' },
  checkpoint_summary: { label: '记录点小结', desc: '编制记录点「本轮修改小结」异步生成' },
  cleaning_suggest: { label: '清洗建议', desc: '非标准 Excel 清洗的结构建议(可独立停用)' },
  mapping_candidates: { label: '映射候选', desc: '财务科目映射的候选推荐' },
  master_data_semantic: { label: '主数据语义', desc: '主数据健康体检的语义命名检查' },
};

const STATUS_META: Record<string, { status: 'success' | 'warning' | 'error' | 'default'; label: string }> = {
  ok: { status: 'success', label: '连通正常' },
  degraded: { status: 'warning', label: 'degraded(慢/结构异常)' },
  fail: { status: 'error', label: '失败' },
};

/**
 * AI 渠道设置:库内渠道优先,AI_* 环境变量降级为无渠道记录时的部署级默认。
 * apiKey 明文存储于本地数据库(budget.sqlite),请勿外发该文件;列表只显示脱敏预览。
 */
export default function SettingsAi() {
  const { message } = AntdApp.useApp();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<ChannelItem | null>(null);
  const [creating, setCreating] = useState(false);
  const [testingId, setTestingId] = useState<number | null>(null);
  const [form] = Form.useForm();
  const [bindingDraft, setBindingDraft] = useState<Record<string, { primary: number | null; fallback: number | null }> | null>(null);

  const channelsQuery = useQuery({
    queryKey: ['ai-channels'],
    queryFn: () => api.get<{ items: ChannelItem[] }>('/settings/ai-channels'),
  });
  const bindingsQuery = useQuery({
    queryKey: ['ai-feature-bindings'],
    queryFn: () => api.get<{ items: BindingItem[] }>('/settings/ai-feature-bindings'),
  });
  const channels = channelsQuery.data;
  const bindings = bindingsQuery.data;
  const settingsLoading = channelsQuery.isLoading || bindingsQuery.isLoading;
  const settingsError = channelsQuery.isError || bindingsQuery.isError;

  /* 小澧助手页面登记(§7.2 ai_settings)：不登记任何密钥字段，只登记页面身份与加载状态。 */
  useAssistantPageContext({
    pageKey: 'ai_settings',
    ready: !settingsLoading && !settingsError,
    readyState: settingsError ? 'error' : 'loading',
    notReadyReason: settingsError ? 'AI 渠道或功能绑定读取失败' : '正在读取 AI 渠道与功能绑定配置',
    scope: {},
    view: {},
  });
  const invalidate = () => {
    void queryClient.invalidateQueries({ queryKey: ['ai-channels'] });
    void queryClient.invalidateQueries({ queryKey: ['ai-feature-bindings'] });
  };

  const saveMutation = useMutation({
    mutationFn: async (values: Record<string, unknown>) => {
      if (editing) return api.patch(`/settings/ai-channels/${editing.id}`, values);
      return api.post('/settings/ai-channels', values);
    },
    onSuccess: () => {
      message.success(editing ? '渠道已更新' : '渠道已新增');
      setEditing(null);
      setCreating(false);
      form.resetFields();
      invalidate();
    },
    onError: (err) => message.error(err instanceof ApiError ? err.body.message : '保存失败'),
  });
  const deleteMutation = useMutation({
    mutationFn: (id: number) => api.del<{ affectedFeatures: string[] }>(`/settings/ai-channels/${id}`),
    onSuccess: (result) => {
      message.success(result.affectedFeatures.length
        ? `渠道已删除,以下功能已解绑:${result.affectedFeatures.map((f) => FEATURE_LABELS[f]?.label ?? f).join('、')}`
        : '渠道已删除');
      invalidate();
    },
    onError: (err) => message.error(err instanceof ApiError ? err.body.message : '删除失败'),
  });
  const toggleMutation = useMutation({
    mutationFn: ({ id, enabled }: { id: number; enabled: boolean }) => api.patch(`/settings/ai-channels/${id}`, { enabled }),
    onSuccess: invalidate,
    onError: (err) => message.error(err instanceof ApiError ? err.body.message : '操作失败'),
  });
  const bindingMutation = useMutation({
    mutationFn: (items: BindingItem[]) => api.put('/settings/ai-feature-bindings', {
      bindings: items.map((b) => ({ feature: b.feature, primaryChannelId: b.primaryChannelId, fallbackChannelId: b.fallbackChannelId })),
    }),
    onSuccess: () => {
      message.success('功能绑定已保存');
      setBindingDraft(null);
      invalidate();
    },
    onError: (err) => message.error(err instanceof ApiError ? err.body.message : '保存失败'),
  });

  const testChannel = async (id: number) => {
    setTestingId(id);
    try {
      const result = await api.post<{ status: string; latencyMs: number; message: string }>(`/settings/ai-channels/${id}/test`, {});
      if (result.status === 'ok') message.success(result.message);
      else if (result.status === 'degraded') message.warning(result.message);
      else message.error(result.message);
      invalidate();
    } catch (err) {
      message.error(err instanceof ApiError ? err.body.message : '测试失败');
    } finally {
      setTestingId(null);
    }
  };

  const enabledOptions = (channels?.items ?? []).filter((c) => c.enabled).map((c) => ({ value: c.id, label: `${c.name} (${c.model})` }));
  const bindingRows = bindings?.items ?? [];
  const draftOf = (feature: string, current: BindingItem) => bindingDraft?.[feature] ?? { primary: current.primaryChannelId, fallback: current.fallbackChannelId };

  return (
    <Card className="bd-root-card">
      <Alert
        type="info"
        showIcon
        style={{ marginBottom: 12 }}
        message="渠道配置明文存储于本地数据库(budget.sqlite),请勿外发该文件;未绑定渠道的功能回退到 AI_* 环境变量(模板降级兜底不变)。"
      />
      <Space style={{ marginBottom: 12 }}>
        <Typography.Text strong>模型渠道</Typography.Text>
        <Button type="primary" size="small" icon={<i className="ri-add-line" aria-hidden />} onClick={() => { setCreating(true); setEditing(null); form.resetFields(); }} disabled={settingsError}>
          新增渠道
        </Button>
      </Space>
      {settingsError ? (
        /* 失败不能显示空渠道/空绑定表:那会被误读为「尚未配置」，还会诱发重复创建 */
        <QueryErrorResult
          title="AI 渠道或功能绑定加载失败"
          error={channelsQuery.error ?? bindingsQuery.error}
          refetch={() => { void channelsQuery.refetch(); void bindingsQuery.refetch(); }}
        />
      ) : (
      <>
      <Table<ChannelItem>
        rowKey="id"
        size="small"
        loading={channelsQuery.isLoading}
        dataSource={channels?.items ?? []}
        pagination={false}
        columns={[
          { title: '名称', dataIndex: 'name' },
          { title: '模型', dataIndex: 'model', width: 140 },
          { title: 'Base URL', dataIndex: 'baseUrl', ellipsis: true },
          { title: '密钥', dataIndex: 'keyPreview', width: 120, render: (v: string) => v || <Tag>无密钥</Tag> },
          {
            title: '启用',
            dataIndex: 'enabled',
            width: 70,
            render: (v: boolean, row) => (
              <Switch size="small" checked={v} onChange={(enabled) => toggleMutation.mutate({ id: row.id, enabled })} />
            ),
          },
          {
            title: '状态',
            key: 'status',
            width: 130,
            render: (_, row) => {
              const meta = row.lastTestStatus ? STATUS_META[row.lastTestStatus] : { status: 'default' as const, label: '未测试' };
              return <Badge status={meta.status} text={meta.label.trim()} />;
            },
          },
          { title: '最近测试', dataIndex: 'lastTestedAt', width: 155, render: (v: string | null) => (v ? shortTime(v) : '—') },
          {
            title: '操作',
            key: 'op',
            width: 210,
            render: (_, row) => (
              <Space size={4}>
                <Button size="small" icon={<i className="ri-flashlight-line" aria-hidden />} loading={testingId === row.id} onClick={() => void testChannel(row.id)}>
                  测试
                </Button>
                <Button
                  size="small"
                  onClick={() => {
                    setEditing(row);
                    setCreating(false);
                    form.setFieldsValue({ name: row.name, baseUrl: row.baseUrl, model: row.model, timeoutMs: row.timeoutMs, stream: row.stream, apiKey: '' });
                  }}
                >
                  编辑
                </Button>
                <Popconfirm title="删除该渠道?被引用功能将自动解绑" okText="删除" cancelText="取消" okButtonProps={{ danger: true }} onConfirm={() => deleteMutation.mutate(row.id)}>
                  <Button size="small" danger>删除</Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
      {channels?.items.some((c) => c.lastTestStatus === 'fail' && c.lastTestMessage) && (
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 8 }}>
          最近失败原因:{channels.items.filter((c) => c.lastTestStatus === 'fail').map((c) => `${c.name}:${c.lastTestMessage}`).join(';')}
        </Typography.Paragraph>
      )}

      <Space style={{ margin: '20px 0 12px' }}>
        <Typography.Text strong>功能绑定</Typography.Text>
        {bindingDraft && (
          <>
            <Button
              type="primary"
              size="small"
              loading={bindingMutation.isPending}
              onClick={() => {
                const items = bindingRows.map((row) => {
                  const draft = draftOf(row.feature, row);
                  return { feature: row.feature, primaryChannelId: draft.primary, fallbackChannelId: draft.fallback };
                });
                bindingMutation.mutate(items);
              }}
            >
              保存绑定
            </Button>
            <Button size="small" onClick={() => setBindingDraft(null)}>放弃修改</Button>
          </>
        )}
      </Space>
      <Table<BindingItem>
        rowKey="feature"
        size="small"
        dataSource={bindingRows}
        pagination={false}
        columns={[
          {
            title: '功能',
            dataIndex: 'feature',
            width: 220,
            render: (f: string) => (
              <div>
                <div>{FEATURE_LABELS[f]?.label ?? f}</div>
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>{FEATURE_LABELS[f]?.desc ?? ''}</Typography.Text>
              </div>
            ),
          },
          {
            title: '主渠道',
            key: 'primary',
            render: (_, row) => {
              const draft = draftOf(row.feature, row);
              return (
                <Select
                  allowClear
                  placeholder="回退 env/任一启用渠道"
                  style={{ width: '100%' }}
                  value={draft.primary}
                  options={enabledOptions}
                  onChange={(value) => setBindingDraft((prev) => ({ ...prev, [row.feature]: { primary: value ?? null, fallback: draft.fallback } }))}
                />
              );
            },
          },
          {
            title: '备用渠道',
            key: 'fallback',
            render: (_, row) => {
              const draft = draftOf(row.feature, row);
              return (
                <Select
                  allowClear
                  placeholder="无备用"
                  style={{ width: '100%' }}
                  value={draft.fallback}
                  options={enabledOptions.filter((o) => o.value !== draft.primary)}
                  onChange={(value) => setBindingDraft((prev) => ({ ...prev, [row.feature]: { primary: draft.primary, fallback: value ?? null } }))}
                />
              );
            },
          },
        ]}
      />
      </>
      )}

      <Modal
        open={creating || editing != null}
        title={editing ? '编辑渠道' : '新增渠道'}
        okText="保存"
        onCancel={() => { setCreating(false); setEditing(null); form.resetFields(); }}
        onOk={() => form.validateFields().then((values) => saveMutation.mutate(values)).catch(() => undefined)}
        confirmLoading={saveMutation.isPending}
        destroyOnClose
      >
        <Form form={form} layout="vertical" initialValues={{ model: 'gpt-4o-mini', timeoutMs: 15000, stream: true }}>
          <Form.Item name="name" label="渠道名称" rules={[{ required: true, message: '请输入渠道名称' }]}>
            <Input placeholder="如:公司网关 GPT-4o" maxLength={100} />
          </Form.Item>
          <Form.Item name="baseUrl" label="Base URL" rules={[{ required: true, message: '请输入 Base URL' }]}>
            <Input placeholder="https://api.example.com/v1(或本机 http://)" />
          </Form.Item>
          <Form.Item name="apiKey" label="API Key" extra={editing ? '留空则不修改现有密钥' : '本地无鉴权服务可留空'}>
            <Input.Password placeholder="sk-..." autoComplete="off" />
          </Form.Item>
          <Form.Item name="model" label="模型" rules={[{ required: true, message: '请输入模型名' }]}>
            <Input placeholder="gpt-4o-mini" />
          </Form.Item>
          <Form.Item name="timeoutMs" label="超时(毫秒)">
            <InputNumber min={10} max={120000} style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="stream" label="启用流式" valuePropName="checked">
            <Switch />
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
