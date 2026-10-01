import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App as AntdApp, Button, Card, Descriptions, Input, InputNumber, Select, Skeleton, Space, Switch, Tabs, Tag, Typography } from 'antd';
import { api, ApiError, can, errorText } from '../api/client';
import { QueryErrorResult } from '../components/QueryErrorResult';
import { shortTime } from '../utils/relativeTime';
import CustomFieldsPanel from './settings/CustomFieldsPanel';
import ImportAliasesPanel from './settings/ImportAliasesPanel';

type Value = string | number | boolean | null;

interface SettingItem {
  key: string; label: string; group: string; type: 'string' | 'int' | 'bool' | 'enum' | 'url' | 'secret' | 'ratio';
  description?: string; min?: number; max?: number; maxLength?: number; options?: { value: string; label: string }[];
  value: Value; defaultValue: Value; isDefault: boolean; configured?: boolean; preview?: string | null; updatedAt: string | null;
}

/**
 * 业务设置(AC-F23):登记过的键才能保存,整批校验后一次写入;
 * 凭据只写不读,页面只显示“已配置 ****末4位”,留空表示不修改。
 */
function BusinessParams() {
  const { message } = AntdApp.useApp();
  const qc = useQueryClient();
  const writable = can('settings:manage');
  const [draft, setDraft] = useState<Record<string, Value>>({});
  const [fieldErrors, setFieldErrors] = useState<Record<string, string>>({});
  const q = useQuery({ queryKey: ['settings-business'], queryFn: () => api.get<{ items: SettingItem[] }>('/settings/business') });
  const save = useMutation({
    mutationFn: (body: Record<string, Value>) => api.put<{ items: SettingItem[] }>('/settings/business', body),
    onSuccess: (data) => {
      qc.setQueryData(['settings-business'], data);
      setDraft({});
      setFieldErrors({});
      message.success('设置已保存');
    },
    onError: (e) => {
      if (e instanceof ApiError && e.body.errors) setFieldErrors(Object.fromEntries(e.body.errors.map((x) => [x.field, x.message])));
      message.error(errorText(e, { includeFieldErrors: false }));
    },
  });
  const groups = useMemo(() => {
    const map = new Map<string, SettingItem[]>();
    for (const item of q.data?.items ?? []) map.set(item.group, [...(map.get(item.group) ?? []), item]);
    return [...map.entries()];
  }, [q.data]);

  if (q.error) return <QueryErrorResult title="业务设置加载失败" error={q.error} refetch={q.refetch} />;
  const dirty = Object.keys(draft).length > 0;
  const current = (s: SettingItem): Value => (s.key in draft ? draft[s.key] : s.value);
  const set = (key: string, v: Value) => setDraft((d) => ({ ...d, [key]: v }));

  const editor = (s: SettingItem) => {
    const disabled = !writable;
    switch (s.type) {
      case 'int':
        return <InputNumber disabled={disabled} min={s.min} max={s.max} precision={0} value={current(s) as number | null} onChange={(v) => set(s.key, v)} />;
      case 'bool':
        return <Switch disabled={disabled} checked={current(s) as boolean} onChange={(v) => set(s.key, v)} />;
      case 'enum':
        return <Select disabled={disabled} style={{ width: 160 }} value={current(s) as string} options={s.options} onChange={(v) => set(s.key, v)} />;
      case 'secret':
        return (
          <Space>
            {s.configured ? <Tag color="success">已配置 {s.preview}</Tag> : <Tag>未配置</Tag>}
            {writable && (
              <Input.Password
                autoComplete="new-password" style={{ width: 260 }} placeholder={s.configured ? '留空表示不修改' : '输入后保存'}
                value={typeof draft[s.key] === 'string' ? draft[s.key] as string : ''}
                onChange={(e) => {
                  const v = e.target.value;
                  setDraft((d) => {
                    const next = { ...d };
                    if (v) next[s.key] = v; else delete next[s.key];
                    return next;
                  });
                }}
              />
            )}
            {writable && s.configured && <Button size="small" danger onClick={() => set(s.key, null)}>清除</Button>}
            {draft[s.key] === null && <Tag color="warning">保存后清除</Tag>}
          </Space>
        );
      default:
        return <Input disabled={disabled} style={{ width: 360 }} maxLength={s.maxLength} value={(current(s) as string | null) ?? ''} onChange={(e) => set(s.key, e.target.value)} />;
    }
  };

  if (q.isLoading) return <Skeleton active />;
  return (
    <div>
      {!writable && <Alert type="info" showIcon style={{ marginBottom: 12 }} message="当前账号只能查看设置" />}
      {groups.map(([group, items]) => (
        <Descriptions key={group} title={group} bordered column={1} size="small" style={{ marginBottom: 20 }} labelStyle={{ width: 200 }}>
          {items.map((s) => (
            <Descriptions.Item key={s.key} label={s.label}>
              <Space direction="vertical" size={2}>
                {editor(s)}
                {fieldErrors[s.key] && <Typography.Text type="danger">{fieldErrors[s.key]}</Typography.Text>}
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  {s.description ? `${s.description}。` : ''}
                  {s.type !== 'secret' && `默认:${s.defaultValue === '' || s.defaultValue === null ? '空' : String(s.options?.find((o) => o.value === s.defaultValue)?.label ?? s.defaultValue)}`}
                  {s.updatedAt && ` · 更新于 ${shortTime(s.updatedAt)}`}
                </Typography.Text>
              </Space>
            </Descriptions.Item>
          ))}
        </Descriptions>
      ))}
      {writable && (
        <Space>
          <Button type="primary" disabled={!dirty} loading={save.isPending} onClick={() => save.mutate(draft)}>保存</Button>
          <Button disabled={!dirty} onClick={() => { setDraft({}); setFieldErrors({}); }}>放弃修改</Button>
        </Space>
      )}
    </div>
  );
}

/** 业务设置页:业务参数 + T-7 自定义字段、导入字段模板。 */
export default function SettingsBusiness() {
  return (
    <Card>
      <Tabs items={[
        { key: 'params', label: '业务参数', children: <BusinessParams /> },
        { key: 'custom-fields', label: '自定义字段', children: <CustomFieldsPanel /> },
        { key: 'import-aliases', label: '导入字段模板', children: <ImportAliasesPanel /> },
      ]} />
    </Card>
  );
}
