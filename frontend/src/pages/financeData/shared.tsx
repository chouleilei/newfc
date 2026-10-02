import { useCallback, useRef, useState, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { DatePicker, Form, Input, Modal, Select, Tag, TreeSelect, Typography } from 'antd';
import dayjs from 'dayjs';
import { api, getSession } from '../../api/client';
import { decimalSign, formatMoney, formatRatioPercent } from '../../utils/decimal';

/** T-3 财务数据页面公用:组织/期间选择、金额单元格、原因输入框、状态标签。 */

interface TreeNode { id: number; code: string; name: string; children?: TreeNode[] }
interface TreeRow { id: number; code: string; name: string; parent_id?: number | null; parentId?: number | null }
type TreeData = { value: number; title: string; children?: TreeData }[];

function toTreeData(nodes: TreeNode[]): TreeData {
  return nodes.map((n) => ({ value: n.id, title: `${n.name}(${n.code})`, children: n.children?.length ? toTreeData(n.children) : undefined }));
}

/** 组织树(后端已按授权范围裁剪)。 */
export function useOrgTree() {
  const q = useQuery({ queryKey: ['org-tree'], queryFn: () => api.get<{ tree: TreeNode[]; rows: TreeRow[] }>('/org/tree') });
  const names = new Map<number, string>();
  const walk = (ns: TreeNode[]) => ns.forEach((n) => { names.set(n.id, n.name); if (n.children) walk(n.children); });
  walk(q.data?.tree ?? []);
  return { ...q, treeData: toTreeData(q.data?.tree ?? []), orgName: (id?: number | null) => (id == null ? '' : names.get(id) ?? `#${id}`) };
}

/** 受限账号只有一个授权根时默认选中它;全组织账号默认不选(集团口径)。 */
export function defaultOrgId(): number | undefined {
  const user = getSession()?.user;
  if (!user || user.allOrgs) return undefined;
  return user.orgIds.length === 1 ? user.orgIds[0] : undefined;
}

export function OrgSelect({ value, onChange, allowClear = true, placeholder = '选择组织', width = 220 }: {
  value?: number; onChange: (v: number | undefined) => void; allowClear?: boolean; placeholder?: string; width?: number;
}) {
  const { treeData, isLoading } = useOrgTree();
  return (
    <TreeSelect
      value={value} onChange={(v) => onChange(v ?? undefined)} treeData={treeData} loading={isLoading} allowClear={allowClear}
      placeholder={placeholder} treeDefaultExpandAll showSearch treeNodeFilterProp="title" style={{ width }} aria-label="组织"
    />
  );
}

export function PeriodPicker({ value, onChange, allowClear = true, placeholder = '期间' }: {
  value?: string; onChange: (v: string | undefined) => void; allowClear?: boolean; placeholder?: string;
}) {
  return (
    <DatePicker
      picker="month" value={value ? dayjs(`${value}-01`) : null} allowClear={allowClear} placeholder={placeholder} aria-label="期间"
      onChange={(d) => onChange(d ? d.format('YYYY-MM') : undefined)} style={{ width: 130 }}
    />
  );
}

/** 当前月份的上一个月(财务期间通常在月后导入)。 */
export function lastPeriod(): string {
  return dayjs().subtract(1, 'month').format('YYYY-MM');
}

/** 金额单元格:十进制字符串原样分组,不转 number。 */
export function Money({ value, tone = false }: { value: string | null | undefined; tone?: boolean }) {
  const sign = decimalSign(value);
  const color = tone && sign !== 0 ? (sign < 0 ? 'var(--newfc-accent)' : undefined) : undefined;
  return <span className="tabular-nums" style={{ fontVariantNumeric: 'tabular-nums', color, whiteSpace: 'nowrap' }}>{formatMoney(value)}</span>;
}

export function Ratio({ value }: { value: string | null | undefined }) {
  return <span style={{ fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>{formatRatioPercent(value)}</span>;
}

export const moneyColumn = <T,>(title: string, dataIndex: keyof T & string, width = 140) => ({
  title, dataIndex, width, align: 'right' as const, render: (v: string | null) => <Money value={v} />,
});

type TagMeta = Record<string, { text: string; color: string }>;
export function statusTag(meta: TagMeta, value: string | null | undefined): ReactNode {
  if (!value) return null;
  const m = meta[value];
  return <Tag color={m?.color ?? 'default'}>{m?.text ?? value}</Tag>;
}

export const RULE_STATUS: TagMeta = {
  passed: { text: '通过', color: 'success' }, warning: { text: '警告', color: 'warning' },
  incomplete: { text: '不完整', color: 'default' }, failed: { text: '未通过', color: 'error' },
};

export interface PromptField { name: string; label: string; required?: boolean; multiline?: boolean; options?: { value: string; label: string }[]; initial?: string; placeholder?: string }
interface PromptState { title: string; description?: ReactNode; fields: PromptField[]; okText?: string; danger?: boolean }

/**
 * 需要填写原因/说明的确认框(作废、解锁、复核意见等)。
 * 返回 [prompt, holder]:await prompt(...) 得到字段值,取消时为 null。
 */
export function usePrompt(): [(s: PromptState) => Promise<Record<string, string> | null>, ReactNode] {
  const [state, setState] = useState<PromptState | null>(null);
  const resolver = useRef<((v: Record<string, string> | null) => void) | null>(null);
  const [form] = Form.useForm<Record<string, string>>();
  const prompt = useCallback((s: PromptState) => new Promise<Record<string, string> | null>((resolve) => {
    resolver.current = resolve;
    form.resetFields();
    form.setFieldsValue(Object.fromEntries(s.fields.map((f) => [f.name, f.initial ?? (f.options ? undefined : '')])));
    setState(s);
  }), [form]);
  const finish = (v: Record<string, string> | null) => { resolver.current?.(v); resolver.current = null; setState(null); };
  const holder = (
    <Modal
      open={state !== null} title={state?.title} okText={state?.okText ?? '确认'} okButtonProps={{ danger: state?.danger }} destroyOnClose
      onCancel={() => finish(null)}
      onOk={() => form.validateFields().then((v) => finish(Object.fromEntries(Object.entries(v).map(([k, x]) => [k, typeof x === 'string' ? x.trim() : x]))))}
    >
      {state?.description && <Typography.Paragraph type="secondary">{state.description}</Typography.Paragraph>}
      <Form form={form} layout="vertical" preserve={false}>
        {state?.fields.map((f) => (
          <Form.Item key={f.name} name={f.name} label={f.label} rules={f.required ? [{ required: true, whitespace: true, message: `请填写${f.label}` }] : []}>
            {f.options ? <Select options={f.options} placeholder={f.placeholder} />
              : f.multiline ? <Input.TextArea rows={3} maxLength={500} showCount placeholder={f.placeholder} />
                : <Input maxLength={500} placeholder={f.placeholder} />}
          </Form.Item>
        ))}
      </Form>
    </Modal>
  );
  return [prompt, holder];
}

/** 管理员同人复核的例外原因提示:后端只允许管理员且必须填写例外原因。 */
export const EXCEPTION_REASON_FIELD: PromptField = {
  name: 'exceptionReason', label: '例外原因(仅管理员自审时填写)', multiline: true,
  placeholder: '提交人与复核人为同一人时必须填写,并写入审计',
};

/** 去掉空字符串字段,避免把空值提交给后端 zod 校验。 */
export function compact<T extends Record<string, unknown>>(obj: T): Partial<T> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== '' && v !== undefined && v !== null)) as Partial<T>;
}
