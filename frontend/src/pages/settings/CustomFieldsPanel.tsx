import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntdApp, Button, Form, Input, InputNumber, Modal, Popconfirm, Segmented, Select, Space, Switch, Table, Tag, Typography } from 'antd';
import { can, errorText } from '../../api/client';
import { dictApi } from '../../api/masterDict';
import { customFieldApi, type CustomFieldDomain, type CustomFieldDto, type CustomFieldType } from '../../api/systemSettings';
import { QueryErrorResult } from '../../components/QueryErrorResult';

const TYPE_LABEL: Record<CustomFieldType, string> = { text: '文本', number: '数值', date: '日期', select: '下拉(字典)' };
const DOMAIN_LABEL: Record<CustomFieldDomain, string> = { project: '项目', supplier: '供应商' };

interface FormValues { fieldCode: string; fieldName: string; fieldType: CustomFieldType; required?: boolean; dictType?: string; description?: string; sortOrder?: number }

/** T-7 自定义字段(AC-F23):项目/供应商扩展字段定义;编码与类型建立后不可改,停用代替删除。 */
export default function CustomFieldsPanel() {
  const { message } = AntdApp.useApp();
  const qc = useQueryClient();
  const writable = can('settings:manage');
  const [domain, setDomain] = useState<CustomFieldDomain>('project');
  const [editing, setEditing] = useState<CustomFieldDto | 'new' | null>(null);
  const [form] = Form.useForm<FormValues>();
  const fieldType = Form.useWatch('fieldType', form);
  const list = useQuery({ queryKey: ['settings-custom-fields', domain], queryFn: () => customFieldApi.list(domain) });
  const dictTypes = useQuery({ queryKey: ['dict-types'], queryFn: () => dictApi.types(), enabled: editing === 'new' });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['settings-custom-fields'] }); void qc.invalidateQueries({ queryKey: ['custom-fields-active'] }); };
  const save = useMutation({
    mutationFn: (v: FormValues) => editing === 'new'
      ? customFieldApi.create({ domain, ...v, required: !!v.required, dictType: v.fieldType === 'select' ? v.dictType : undefined, sortOrder: v.sortOrder ?? undefined })
      : customFieldApi.update((editing as CustomFieldDto).id, {
        expectedVersion: (editing as CustomFieldDto).version, fieldName: v.fieldName, required: !!v.required, description: v.description ?? '', sortOrder: v.sortOrder ?? undefined,
      }),
    onSuccess: () => { message.success('已保存'); setEditing(null); refresh(); },
    onError: (e) => message.error(errorText(e)),
  });
  const toggle = useMutation({
    mutationFn: (f: CustomFieldDto) => customFieldApi.update(f.id, { expectedVersion: f.version, status: f.status === 'active' ? 'inactive' : 'active' }),
    onSuccess: () => refresh(),
    onError: (e) => message.error(errorText(e)),
  });
  if (list.error) return <QueryErrorResult title="自定义字段加载失败" error={list.error} refetch={list.refetch} />;
  const open = (f: CustomFieldDto | 'new') => {
    setEditing(f);
    form.setFieldsValue(f === 'new'
      ? { fieldCode: '', fieldName: '', fieldType: 'text', required: false, dictType: undefined, description: '', sortOrder: undefined }
      : { fieldCode: f.fieldCode, fieldName: f.fieldName, fieldType: f.fieldType, required: f.required, dictType: f.dictType ?? undefined, description: f.description, sortOrder: f.sortOrder });
  };
  return (
    <>
      <Space style={{ marginBottom: 12 }} wrap>
        <Segmented value={domain} onChange={(v) => setDomain(v as CustomFieldDomain)} options={Object.entries(DOMAIN_LABEL).map(([value, label]) => ({ value, label }))} />
        {writable && <Button type="primary" onClick={() => open('new')}>新增字段</Button>}
        <Typography.Text type="secondary">值保存在主数据扩展字段中,保存时按定义校验;数值按十进制字符串保存,不做浮点换算。</Typography.Text>
      </Space>
      <Table<CustomFieldDto>
        rowKey="id" size="small" loading={list.isLoading} dataSource={list.data?.items ?? []} pagination={false}
        columns={[
          { title: '编码', dataIndex: 'fieldCode', width: 150, render: (v: string) => <Typography.Text code>{v}</Typography.Text> },
          { title: '名称', dataIndex: 'fieldName' },
          { title: '类型', dataIndex: 'fieldType', width: 150, render: (v: CustomFieldType, f) => <Space>{TYPE_LABEL[v]}{f.dictType && <Typography.Text type="secondary">{f.dictType}</Typography.Text>}</Space> },
          { title: '必填', dataIndex: 'required', width: 70, render: (v: boolean) => (v ? <Tag color="red">必填</Tag> : '—') },
          { title: '排序', dataIndex: 'sortOrder', width: 70 },
          { title: '状态', dataIndex: 'status', width: 80, render: (s: string) => <Tag color={s === 'active' ? 'success' : 'default'}>{s === 'active' ? '启用' : '停用'}</Tag> },
          ...(writable ? [{
            title: '操作', width: 120,
            render: (_: unknown, f: CustomFieldDto) => (
              <Space>
                <a onClick={() => open(f)}>编辑</a>
                <Popconfirm title={f.status === 'active' ? '停用后表单不再显示、保存时不再校验,已保存的值保留。确认停用?' : '确认启用?'} onConfirm={() => toggle.mutate(f)}>
                  <a>{f.status === 'active' ? '停用' : '启用'}</a>
                </Popconfirm>
              </Space>
            ),
          }] : []),
        ]}
      />
      <Modal open={editing !== null} title={editing === 'new' ? `新增${DOMAIN_LABEL[domain]}字段` : '编辑字段'} onCancel={() => setEditing(null)} destroyOnClose
        onOk={() => form.validateFields().then((v) => save.mutate(v))} confirmLoading={save.isPending}>
        <Form form={form} layout="vertical">
          <Form.Item name="fieldCode" label="字段编码" extra="建立后不可修改" rules={[{ required: true, pattern: /^[a-z][a-z0-9_]{1,39}$/, message: '小写字母开头的字母、数字、下划线(2~40 位)' }]}>
            <Input disabled={editing !== 'new'} maxLength={40} />
          </Form.Item>
          <Form.Item name="fieldName" label="字段名称" rules={[{ required: true, whitespace: true }]}><Input maxLength={64} /></Form.Item>
          <Form.Item name="fieldType" label="类型" rules={[{ required: true }]}>
            <Select disabled={editing !== 'new'} options={Object.entries(TYPE_LABEL).map(([value, label]) => ({ value, label }))} />
          </Form.Item>
          {fieldType === 'select' && (
            <Form.Item name="dictType" label="字典类型" extra="在主数据“字典项”页签维护选项" rules={[{ required: true, message: '请选择字典类型' }]}>
              <Select disabled={editing !== 'new'} loading={dictTypes.isLoading} options={(dictTypes.data?.items ?? []).filter((t) => t.activeCount > 0).map((t) => ({ value: t.dictType, label: `${t.dictType}(${t.activeCount} 项)` }))} />
            </Form.Item>
          )}
          <Form.Item name="required" label="必填" valuePropName="checked" extra="改为必填后,既有数据在下次编辑扩展字段时需补齐"><Switch /></Form.Item>
          <Form.Item name="description" label="说明"><Input maxLength={200} /></Form.Item>
          <Form.Item name="sortOrder" label="排序"><InputNumber min={-9999} max={9999} style={{ width: '100%' }} /></Form.Item>
        </Form>
      </Modal>
    </>
  );
}
