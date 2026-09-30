import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { App as AntdApp, AutoComplete, Button, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Table, Tag, Typography } from 'antd';
import { can, errorText, getSession } from '../../api/client';
import { dictApi, type DictItemDto } from '../../api/masterDict';
import { QueryErrorResult } from '../../components/QueryErrorResult';
import { shortTime } from '../../utils/relativeTime';

/** T-7 字典项(AC-F07):类型/取值建立后不可改(被自定义字段下拉引用),停用代替删除;维护需全组织 master:write。 */
export default function DictItemsTab() {
  const { message } = AntdApp.useApp();
  const qc = useQueryClient();
  const writable = can('master:write') && !!getSession()?.user.allOrgs;
  const [dictType, setDictType] = useState<string | undefined>();
  const [editing, setEditing] = useState<DictItemDto | 'new' | null>(null);
  const [form] = Form.useForm<{ dictType: string; itemValue: string; itemLabel: string; sortOrder?: number }>();
  const types = useQuery({ queryKey: ['dict-types'], queryFn: () => dictApi.types() });
  const list = useQuery({ queryKey: ['dict-items', dictType], queryFn: () => dictApi.items({ dictType }) });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['dict-items'] }); void qc.invalidateQueries({ queryKey: ['dict-types'] }); };
  const save = useMutation({
    mutationFn: (v: { dictType: string; itemValue: string; itemLabel: string; sortOrder?: number }) => editing === 'new'
      ? dictApi.create({ ...v, sortOrder: v.sortOrder ?? undefined })
      : dictApi.update((editing as DictItemDto).id, { expectedVersion: (editing as DictItemDto).version, itemLabel: v.itemLabel, sortOrder: v.sortOrder ?? undefined }),
    onSuccess: () => { message.success('已保存'); setEditing(null); refresh(); },
    onError: (e) => message.error(errorText(e)),
  });
  const toggle = useMutation({
    mutationFn: (d: DictItemDto) => dictApi.update(d.id, { expectedVersion: d.version, status: d.status === 'active' ? 'inactive' : 'active' }),
    onSuccess: () => refresh(),
    onError: (e) => message.error(errorText(e)),
  });
  if (list.error) return <QueryErrorResult title="字典项加载失败" error={list.error} refetch={list.refetch} />;
  const typeOptions = (types.data?.items ?? []).map((t) => ({ value: t.dictType, label: `${t.dictType}(${t.activeCount}/${t.itemCount})` }));
  const open = (d: DictItemDto | 'new') => {
    setEditing(d);
    form.setFieldsValue(d === 'new' ? { dictType: dictType ?? '', itemValue: '', itemLabel: '', sortOrder: undefined } : { dictType: d.dictType, itemValue: d.itemValue, itemLabel: d.itemLabel, sortOrder: d.sortOrder });
  };
  return (
    <>
      <Space style={{ marginBottom: 12 }} wrap>
        <Select allowClear showSearch placeholder="全部字典类型" value={dictType} onChange={setDictType} style={{ width: 240 }} options={typeOptions} loading={types.isLoading} />
        {writable && <Button type="primary" onClick={() => open('new')}>新建字典项</Button>}
        <Typography.Text type="secondary">类型与取值建立后不可修改;不再使用的取值请停用。</Typography.Text>
      </Space>
      <Table<DictItemDto>
        rowKey="id" size="small" loading={list.isLoading} dataSource={list.data?.items ?? []} pagination={{ pageSize: 20, showSizeChanger: false }}
        columns={[
          { title: '字典类型', dataIndex: 'dictType', width: 180, render: (v: string) => <Typography.Text code>{v}</Typography.Text> },
          { title: '取值', dataIndex: 'itemValue', width: 180 },
          { title: '显示名', dataIndex: 'itemLabel' },
          { title: '排序', dataIndex: 'sortOrder', width: 80 },
          { title: '状态', dataIndex: 'status', width: 80, render: (s: string) => <Tag color={s === 'active' ? 'success' : 'default'}>{s === 'active' ? '启用' : '停用'}</Tag> },
          { title: '更新时间', dataIndex: 'updatedAt', width: 130, render: (v: string) => shortTime(v) },
          ...(writable ? [{
            title: '操作', width: 120,
            render: (_: unknown, d: DictItemDto) => (
              <Space>
                <a onClick={() => open(d)}>编辑</a>
                <Popconfirm title={d.status === 'active' ? '确认停用?已引用该取值的数据保持不变,新录入不可再选。' : '确认启用?'} onConfirm={() => toggle.mutate(d)}>
                  <a>{d.status === 'active' ? '停用' : '启用'}</a>
                </Popconfirm>
              </Space>
            ),
          }] : []),
        ]}
      />
      <Modal open={editing !== null} title={editing === 'new' ? '新建字典项' : '编辑字典项'} onCancel={() => setEditing(null)} destroyOnClose
        onOk={() => form.validateFields().then((v) => save.mutate(v))} confirmLoading={save.isPending}>
        <Form form={form} layout="vertical">
          <Form.Item name="dictType" label="字典类型" extra="小写字母开头,字母、数字、下划线,例如 project_stage"
            rules={[{ required: true, pattern: /^[a-z][a-z0-9_]{1,63}$/, message: '小写字母开头的字母、数字、下划线(2~64 位)' }]}>
            <AutoComplete disabled={editing !== 'new'} options={(types.data?.items ?? []).map((t) => ({ value: t.dictType }))} filterOption />
          </Form.Item>
          <Form.Item name="itemValue" label="取值" rules={[{ required: true, whitespace: true }]}><Input disabled={editing !== 'new'} maxLength={128} /></Form.Item>
          <Form.Item name="itemLabel" label="显示名" rules={[{ required: true, whitespace: true }]}><Input maxLength={128} /></Form.Item>
          <Form.Item name="sortOrder" label="排序" extra={editing === 'new' ? '留空则排在该类型末尾' : undefined}><InputNumber min={-9999} max={9999} style={{ width: '100%' }} /></Form.Item>
        </Form>
      </Modal>
    </>
  );
}
