import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntdApp, Button, Form, Input, Modal, Popconfirm, Select, Space, Table, Tag, Typography } from 'antd';
import { can, errorText } from '../../api/client';
import { importAliasApi, type ImportAliasDataType, type ImportAliasDto } from '../../api/systemSettings';
import { QueryErrorResult } from '../../components/QueryErrorResult';
import { shortTime } from '../../utils/relativeTime';

/** T-7 导入字段模板(AC-F23):为 EAS/计划执行解析器的目标字段追加表头别名;只影响列识别,不改口径。 */
export default function ImportAliasesPanel() {
  const { message } = AntdApp.useApp();
  const qc = useQueryClient();
  const writable = can('settings:manage');
  const [dataType, setDataType] = useState<ImportAliasDataType>('eas_voucher');
  const [adding, setAdding] = useState(false);
  const [form] = Form.useForm<{ targetField: string; sourceAlias: string; note?: string }>();
  const targets = useQuery({ queryKey: ['import-field-targets'], queryFn: () => importAliasApi.targets(), staleTime: Infinity });
  const list = useQuery({ queryKey: ['import-field-aliases', dataType], queryFn: () => importAliasApi.list(dataType) });
  const entry = targets.data?.items.find((t) => t.dataType === dataType);
  const refresh = () => void qc.invalidateQueries({ queryKey: ['import-field-aliases'] });
  const create = useMutation({
    mutationFn: (v: { targetField: string; sourceAlias: string; note?: string }) => importAliasApi.create({ dataType, ...v }),
    onSuccess: () => { message.success('已添加'); setAdding(false); refresh(); },
    onError: (e) => message.error(errorText(e)),
  });
  const toggle = useMutation({
    mutationFn: (a: ImportAliasDto) => importAliasApi.update(a.id, { expectedVersion: a.version, status: a.status === 'active' ? 'inactive' : 'active' }),
    onSuccess: () => refresh(),
    onError: (e) => message.error(errorText(e)),
  });
  if (list.error) return <QueryErrorResult title="导入字段模板加载失败" error={list.error} refetch={list.refetch} />;
  const aliases = list.data?.items ?? [];
  return (
    <>
      <Space style={{ marginBottom: 12 }} wrap>
        <Select value={dataType} onChange={setDataType} style={{ width: 260 }} loading={targets.isLoading}
          options={(targets.data?.items ?? []).map((t) => ({ value: t.dataType, label: t.label }))} />
        {writable && <Button type="primary" onClick={() => { form.resetFields(); setAdding(true); }}>添加表头别名</Button>}
        <Typography.Text type="secondary">别名按解析器口径规整(去空白;计划执行还忽略括注与 * :),不能与内置表头重复。</Typography.Text>
      </Space>
      <Table
        rowKey="key" size="small" loading={targets.isLoading} pagination={false} dataSource={(entry?.fields ?? []).map((f) => ({ ...f, custom: aliases.filter((a) => a.targetField === f.key) }))}
        columns={[
          { title: '目标字段', dataIndex: 'label', width: 180, render: (v: string, f) => <Space>{v}{f.required && <Tag color="red">必需</Tag>}</Space> },
          { title: '内置表头', dataIndex: 'builtinAliases', render: (v: string[]) => <Space size={4} wrap>{v.map((a) => <Tag key={a}>{a}</Tag>)}</Space> },
          {
            title: '追加别名', dataIndex: 'custom',
            render: (v: ImportAliasDto[]) => (v.length === 0 ? <Typography.Text type="secondary">—</Typography.Text> : (
              <Space size={4} wrap>
                {v.map((a) => (
                  <Tag key={a.id} color={a.status === 'active' ? 'blue' : 'default'} title={`${a.note || '无备注'} · ${shortTime(a.updatedAt)}`}>
                    {a.status === 'active' ? a.sourceAlias : <s>{a.sourceAlias}</s>}
                    {writable && (
                      <Popconfirm title={a.status === 'active' ? '停用后该表头不再被识别。确认停用?' : '确认启用?'} onConfirm={() => toggle.mutate(a)}>
                        <a style={{ marginLeft: 6 }}>{a.status === 'active' ? '停用' : '启用'}</a>
                      </Popconfirm>
                    )}
                  </Tag>
                ))}
              </Space>
            )),
          },
        ]}
      />
      <Modal open={adding} title={`添加表头别名 · ${entry?.label ?? ''}`} onCancel={() => setAdding(false)} destroyOnClose
        onOk={() => form.validateFields().then((v) => create.mutate(v))} confirmLoading={create.isPending}>
        <Form form={form} layout="vertical">
          <Form.Item name="targetField" label="目标字段" rules={[{ required: true, message: '请选择目标字段' }]}>
            <Select showSearch optionFilterProp="label" options={(entry?.fields ?? []).map((f) => ({ value: f.key, label: f.label }))} />
          </Form.Item>
          <Form.Item name="sourceAlias" label="来源表头" rules={[{ required: true, whitespace: true }]}><Input maxLength={64} placeholder="如:工程编码" /></Form.Item>
          <Form.Item name="note" label="备注"><Input maxLength={200} placeholder="如:某二级单位导出格式" /></Form.Item>
        </Form>
      </Modal>
    </>
  );
}
