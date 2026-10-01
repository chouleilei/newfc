import { useQuery } from '@tanstack/react-query';
import { Divider, Form, Input, Select } from 'antd';
import { customFieldApi, type CustomFieldDomain, type CustomFieldDto } from '../../api/systemSettings';

/** T-7 自定义字段(AC-F23):按系统设置里的有效定义渲染 extra 表单项;校验以后端为准,前端只做格式提示。 */
export function useCustomFields(domain: CustomFieldDomain) {
  return useQuery({ queryKey: ['custom-fields-active', domain], queryFn: () => customFieldApi.active(domain), staleTime: 60_000 });
}

/** 编辑时合并:保留未定义的历史键,空串交后端移除。 */
export function mergeExtra(previous: Record<string, unknown> | undefined, values: Record<string, unknown> | undefined): Record<string, unknown> {
  return { ...(previous ?? {}), ...(values ?? {}) };
}

function FieldInput({ f, current }: { f: CustomFieldDto; current?: unknown }) {
  if (f.fieldType === 'select') {
    const options = (f.options ?? []).map((o) => ({ value: o.value, label: o.label }));
    if (typeof current === 'string' && current && !options.some((o) => o.value === current)) options.push({ value: current, label: `${current}(已停用)` });
    return <Select allowClear options={options} placeholder="请选择" />;
  }
  if (f.fieldType === 'date') return <Input type="date" />;
  if (f.fieldType === 'number') return <Input inputMode="decimal" placeholder="数字,最多 6 位小数" maxLength={24} />;
  return <Input maxLength={500} />;
}

export function CustomFieldItems({ fields, extra }: { fields: CustomFieldDto[]; extra?: Record<string, unknown> }) {
  if (!fields.length) return null;
  return (
    <>
      <Divider orientation="left" plain style={{ margin: '8px 0' }}>扩展字段</Divider>
      {fields.map((f) => (
        <Form.Item key={f.fieldCode} name={['extra', f.fieldCode]} label={f.fieldName} tooltip={f.description || undefined}
          rules={[
            ...(f.required ? [{ required: true, whitespace: true, message: `请填写${f.fieldName}` }] : []),
            ...(f.fieldType === 'number' ? [{ pattern: /^-?\d{1,15}(\.\d{1,6})?$/, message: '应为数字(最多 15 位整数、6 位小数)' }] : []),
          ]}>
          <FieldInput f={f} current={extra?.[f.fieldCode]} />
        </Form.Item>
      ))}
    </>
  );
}

/** 表单初值:只取已定义字段,数值统一为字符串。 */
export function extraInitial(fields: CustomFieldDto[], extra: Record<string, unknown> | undefined): Record<string, string | undefined> {
  return Object.fromEntries(fields.map((f) => [f.fieldCode, extra?.[f.fieldCode] == null ? undefined : String(extra[f.fieldCode])]));
}
