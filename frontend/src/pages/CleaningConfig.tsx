import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntdApp, Button, Card, Form, Input, Modal, Popconfirm, Radio, Select, Space, Table, Tabs, Tag, Tooltip, Typography } from 'antd';
import { useNavigate } from 'react-router-dom';
import { FinanceEmpty } from '../components/FinanceEmpty';
import { QueryErrorResult } from '../components/QueryErrorResult';
import { cleaningApi, type CleaningAlias, type CleaningTargetKind, type CleaningTemplate } from '../api/cleaning';
import { ApiError } from '../api/client';
import { useAssistantPageContext } from '../assistant/contextHooks';

const TARGET_OPTIONS: { value: CleaningTargetKind; label: string }[] = [
  { value: 'actual-current', label: '当前累计实际' },
  { value: 'budget', label: '预算填报' },
];

function targetLabel(kind: CleaningTargetKind): string {
  return TARGET_OPTIONS.find((o) => o.value === kind)?.label ?? kind;
}

/** 模板结构只读摘要:新建/编辑模板仍在清洗向导内完成(模板与向导步骤强耦合)。 */
function TemplateTab({ targetKind }: { targetKind: CleaningTargetKind }) {
  const { message } = AntdApp.useApp();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['cleaning-templates', targetKind],
    queryFn: () => cleaningApi.templates(targetKind),
  });
  const deleteMutation = useMutation({
    mutationFn: (id: number) => cleaningApi.deleteTemplate(id),
    onSuccess: () => {
      message.success('模板已删除');
      void queryClient.invalidateQueries({ queryKey: ['cleaning-templates', targetKind] });
    },
    onError: (err) => message.error(err instanceof ApiError ? err.body.message : '删除失败'),
  });

  if (error) {
    return (
      <QueryErrorResult
        title="清洗模板加载失败"
        error={error}
        refetch={() => void refetch()}
      />
    );
  }

  return (
    <div>
      <Space style={{ marginBottom: 12 }} wrap>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          模板结构只读展示;新建/编辑模板请在清洗导入向导内保存。上传同目标类型文件时,向导会提示一键带出最近更新的模板(仍需核对文件结构、单位与差异)。当前目标:{targetLabel(targetKind)}
        </Typography.Text>
        <Button type="link" onClick={() => navigate('/actual')}>前往清洗向导(实际录入与快照页)</Button>
      </Space>
      <Table<CleaningTemplate>
        rowKey="id"
        size="small"
        loading={isLoading}
        dataSource={data?.items ?? []}
        pagination={false}
        locale={{
          emptyText: (
            <FinanceEmpty kind="data" description="暂无清洗模板">
              <Button type="primary" size="small" onClick={() => navigate('/actual')} style={{ marginTop: 8 }}>
                前往清洗向导创建模板
              </Button>
            </FinanceEmpty>
          ),
        }}
        columns={[
          { title: '名称', dataIndex: 'name' },
          {
            title: '结构摘要',
            key: 'summary',
            render: (_, row) => (
              <Typography.Text code style={{ fontSize: 12 }}>
                {`列映射 ${row.config.columns.length} 项 · 表头行 ${row.config.headerRow ?? '-'} · 数据起始行 ${row.config.dataStartRow ?? '-'} · 金额单位 ${row.config.amountUnit === 'wan' ? '万元' : '元'}`}
              </Typography.Text>
            ),
          },
          { title: '更新人', dataIndex: 'createdBy', width: 120 },
          { title: '更新时间', dataIndex: 'updatedAt', width: 170 },
          {
            title: '操作',
            key: 'op',
            width: 90,
            render: (_, row) => (
              <Popconfirm title="删除该模板?" okText="删除" cancelText="取消" okButtonProps={{ danger: true }} onConfirm={() => deleteMutation.mutate(row.id)}>
                <Button size="small" danger aria-label={`删除模板 ${row.name}`} title="删除模板" icon={<i className="ri-delete-bin-line" aria-hidden />} />
              </Popconfirm>
            ),
          },
        ]}
      />
    </div>
  );
}

function AliasTab({ targetKind }: { targetKind: CleaningTargetKind }) {
  const { message } = AntdApp.useApp();
  const queryClient = useQueryClient();
  const [editing, setEditing] = useState<CleaningAlias | null>(null);
  const [creating, setCreating] = useState(false);
  const [form] = Form.useForm<{ mappingKind: 'org' | 'account'; sourceText: string; targetCode: string }>();
  const { data, isLoading, error, refetch } = useQuery({
    queryKey: ['cleaning-aliases', targetKind],
    queryFn: () => cleaningApi.aliases(targetKind),
  });
  const invalidate = () => void queryClient.invalidateQueries({ queryKey: ['cleaning-aliases', targetKind] });

  const saveMutation = useMutation({
    mutationFn: async (values: { mappingKind: 'org' | 'account'; sourceText: string; targetCode: string }) => {
      if (editing) return cleaningApi.updateAlias(editing.id, { sourceText: values.sourceText, targetCode: values.targetCode });
      return cleaningApi.saveAlias({ targetKind, ...values });
    },
    onSuccess: () => {
      message.success(editing ? '别名已更新' : '别名已新增');
      setEditing(null);
      setCreating(false);
      form.resetFields();
      invalidate();
    },
    onError: (err) => message.error(err instanceof ApiError ? err.body.message : '保存失败'),
  });
  const deleteMutation = useMutation({
    mutationFn: (id: number) => cleaningApi.deleteAlias(id),
    onSuccess: () => { message.success('别名已删除'); invalidate(); },
    onError: (err) => message.error(err instanceof ApiError ? err.body.message : '删除失败'),
  });

  if (error) {
    return (
      <QueryErrorResult
        title="清洗别名加载失败"
        error={error}
        refetch={() => void refetch()}
      />
    );
  }

  return (
    <div>
      <Space style={{ marginBottom: 12 }}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>
          来源文本 → 目标编码的清洗别名,当前目标:{targetLabel(targetKind)}
        </Typography.Text>
        <Button size="small" type="primary" icon={<i className="ri-add-line" aria-hidden />} onClick={() => { setCreating(true); setEditing(null); form.resetFields(); }}>
          新增别名
        </Button>
      </Space>
      <Table<CleaningAlias>
        rowKey="id"
        size="small"
        loading={isLoading}
        dataSource={data?.items ?? []}
        pagination={false}
        locale={{
          emptyText: (
            <FinanceEmpty kind="data" description="暂无别名映射">
              <Button size="small" type="primary" icon={<i className="ri-add-line" aria-hidden />} onClick={() => { setCreating(true); setEditing(null); form.resetFields(); }} style={{ marginTop: 8 }}>
                新增别名
              </Button>
            </FinanceEmpty>
          ),
        }}
        columns={[
          {
            title: '映射对象',
            dataIndex: 'mappingKind',
            width: 100,
            render: (v: string) => <Tag>{v === 'org' ? '组织' : '科目'}</Tag>,
          },
          { title: '来源文本', dataIndex: 'sourceText', ellipsis: { showTitle: true } },
          /* 表单允许 100 字符:单行省略 + Tooltip,不折行撑高(方案二.C) */
          { title: '目标编码', dataIndex: 'targetCode', ellipsis: { showTitle: false }, render: (v: string) => <Tooltip title={v}><Typography.Text code>{v}</Typography.Text></Tooltip> },
          { title: '更新时间', dataIndex: 'updatedAt', width: 170 },
          {
            title: '操作',
            key: 'op',
            width: 140,
            render: (_, row) => (
              <Space size={4}>
                <Button size="small" onClick={() => { setEditing(row); setCreating(false); form.setFieldsValue({ mappingKind: row.mappingKind, sourceText: row.sourceText, targetCode: row.targetCode }); }}>
                  编辑
                </Button>
                <Popconfirm title="删除该别名?" okText="删除" cancelText="取消" okButtonProps={{ danger: true }} onConfirm={() => deleteMutation.mutate(row.id)}>
                  <Button size="small" danger aria-label={`删除别名 ${row.sourceText}`} title="删除别名" icon={<i className="ri-delete-bin-line" aria-hidden />} />
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />
      <Modal
        open={creating || editing != null}
        title={editing ? '编辑别名' : '新增别名'}
        okText="保存"
        onCancel={() => { setCreating(false); setEditing(null); form.resetFields(); }}
        onOk={() => form.validateFields().then((values) => saveMutation.mutate(values)).catch(() => undefined)}
        confirmLoading={saveMutation.isPending}
        destroyOnClose
      >
        <Form form={form} layout="vertical">
          <Form.Item name="mappingKind" label="映射对象" rules={[{ required: true, message: '请选择映射对象' }]}>
            <Radio.Group disabled={editing != null}>
              <Radio.Button value="org">组织</Radio.Button>
              <Radio.Button value="account">科目</Radio.Button>
            </Radio.Group>
          </Form.Item>
          <Form.Item name="sourceText" label="来源文本" rules={[{ required: true, message: '请输入来源文本' }]}>
            <Input placeholder="导入文件中出现的原始名称" maxLength={200} />
          </Form.Item>
          <Form.Item name="targetCode" label="目标编码" rules={[{ required: true, message: '请输入目标编码' }]}>
            <Input placeholder="系统内组织/科目编码" maxLength={100} />
          </Form.Item>
        </Form>
      </Modal>
    </div>
  );
}

export default function CleaningConfig() {
  const [targetKind, setTargetKind] = useState<CleaningTargetKind>('actual-current');
  const [activeTab, setActiveTab] = useState('templates');
  /* 财务助手页面登记(§7.2 cleaning_config)：页签与目标数据集都是页面真实状态,
     页签必须受控登记,否则切到「清洗别名」后助手仍看到 tab='templates'。 */
  useAssistantPageContext({ pageKey: 'cleaning_config', ready: true, scope: {}, view: { tab: activeTab, targetKind } });
  return (
    <Card className="newfc-root-card">
      {/* UX-24 / 方案 4.7:「清洗模板与别名」即配置 Excel 导入识别规则,说明常驻页首 */}
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 12 }}>
        配置 Excel 导入识别规则:模板定义非标准 Excel 的工作表、行列对应与金额单位,别名把文件中的原始名称映射到系统内组织/科目编码。
      </Typography.Paragraph>
      <Space style={{ marginBottom: 12 }} wrap>
        <Typography.Text strong>目标数据集</Typography.Text>
        <Select<CleaningTargetKind>
          value={targetKind}
          onChange={setTargetKind}
          options={TARGET_OPTIONS}
          style={{ width: 160 }}
        />
      </Space>
      <Tabs
        activeKey={activeTab}
        onChange={setActiveTab}
        items={[
          { key: 'templates', label: '清洗模板', children: <TemplateTab targetKind={targetKind} /> },
          { key: 'aliases', label: '清洗别名', children: <AliasTab targetKind={targetKind} /> },
        ]}
      />
    </Card>
  );
}
