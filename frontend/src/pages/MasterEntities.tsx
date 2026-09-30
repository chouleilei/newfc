import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App as AntdApp, Button, Card, DatePicker, Form, Input, Modal, Popconfirm, Select, Space, Switch, Table, Tabs, Tag, TreeSelect, Typography } from 'antd';
import dayjs from 'dayjs';
import { api, can, errorText } from '../api/client';
import { QueryErrorResult } from '../components/QueryErrorResult';
import { shortTime } from '../utils/relativeTime';
import DictItemsTab from './master/DictItemsTab';

type Status = 'active' | 'inactive';
type EntityType = 'org' | 'account' | 'project' | 'supplier';

interface Project { id: number; code: string; name: string; projectType: string; orgId: number; orgName: string; status: Status; updatedAt: string }
interface Supplier { id: number; code: string | null; name: string; supplierType: string; creditCode: string; status: Status; updatedAt: string }
interface Mapping {
  id: number; sourceSystem: string; entityType: EntityType; matchKind: 'code' | 'name'; sourceKey: string; sourceLabel: string;
  targetId: number; targetCode: string; targetName: string; validFrom: string; validTo: string | null; note: string; active: boolean;
}
interface ResolveResult {
  input: { code?: string; name?: string }; matchedBy: string; targetId: number | null; targetCode: string | null; targetName: string | null;
  confidence: string; candidates: { id: number; code: string; name: string }[];
}
interface TreeNode { id: number; code: string; name: string; children?: TreeNode[] }
interface TreeRow { id: number; code: string; name: string; status: Status }

const ENTITY_LABEL: Record<EntityType, string> = { org: '组织', account: '科目', project: '项目', supplier: '供应商' };
const MATCHED_LABEL: Record<string, { text: string; color: string }> = {
  exact_code: { text: '编码精确', color: 'success' },
  mapping_code: { text: '编码映射', color: 'success' },
  exact_name: { text: '名称精确', color: 'success' },
  mapping_name: { text: '名称映射', color: 'processing' },
  normalized_name: { text: '规范化名称', color: 'warning' },
  ambiguous: { text: '多个候选', color: 'error' },
  unmatched: { text: '未匹配', color: 'default' },
};

function toTreeData(nodes: TreeNode[]): { value: number; title: string; children?: ReturnType<typeof toTreeData> }[] {
  return nodes.map((n) => ({ value: n.id, title: `${n.name}(${n.code})`, children: n.children?.length ? toTreeData(n.children) : undefined }));
}

const statusTag = (s: Status) => <Tag color={s === 'active' ? 'success' : 'default'}>{s === 'active' ? '启用' : '停用'}</Tag>;

function useOrgTree() {
  return useQuery({ queryKey: ['org-tree'], queryFn: () => api.get<{ tree: TreeNode[]; rows: TreeRow[] }>('/org/tree') });
}

function ProjectsTab({ initialKeyword = '' }: { initialKeyword?: string }) {
  const { message } = AntdApp.useApp();
  const qc = useQueryClient();
  const writable = can('master:write');
  const [keyword, setKeyword] = useState(initialKeyword);
  const [editing, setEditing] = useState<Project | 'new' | null>(null);
  const [form] = Form.useForm<{ code: string; name: string; projectType?: string; orgId: number }>();
  const orgTree = useOrgTree();
  const list = useQuery({
    queryKey: ['master-projects', keyword],
    queryFn: () => api.get<Project[]>(`/master/projects${keyword ? `?keyword=${encodeURIComponent(keyword)}` : ''}`),
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['master-projects'] });
  const save = useMutation({
    mutationFn: (v: { code: string; name: string; projectType?: string; orgId: number }) => editing === 'new'
      ? api.post<Project>('/master/projects', v)
      : api.patch<Project>(`/master/projects/${(editing as Project).id}`, { name: v.name, projectType: v.projectType ?? '', orgId: v.orgId }),
    onSuccess: () => { message.success('已保存'); setEditing(null); refresh(); },
    onError: (e) => message.error(errorText(e)),
  });
  const toggle = useMutation({
    mutationFn: (p: Project) => api.patch<Project>(`/master/projects/${p.id}`, { status: p.status === 'active' ? 'inactive' : 'active' }),
    onSuccess: (p) => { message.success(p.status === 'active' ? '已启用' : '已停用'); refresh(); },
    onError: (e) => message.error(errorText(e)),
  });
  if (list.error) return <QueryErrorResult title="项目加载失败" error={list.error} refetch={list.refetch} />;
  const open = (p: Project | 'new') => {
    setEditing(p);
    form.setFieldsValue(p === 'new' ? { code: '', name: '', projectType: '', orgId: undefined } : { code: p.code, name: p.name, projectType: p.projectType, orgId: p.orgId });
  };
  return (
    <>
      <Space style={{ marginBottom: 12 }}>
        <Input.Search allowClear placeholder="编码或名称" defaultValue={keyword} onSearch={setKeyword} style={{ width: 220 }} />
        {writable && <Button type="primary" onClick={() => open('new')}>新建项目</Button>}
        <Typography.Text type="secondary">只显示已授权组织下的项目;编码建立后不可修改,历史数据按项目 ID 关联。</Typography.Text>
      </Space>
      <Table<Project>
        rowKey="id" loading={list.isLoading} dataSource={list.data ?? []} pagination={{ pageSize: 20, showSizeChanger: false }}
        columns={[
          { title: '编码', dataIndex: 'code', width: 140, render: (v: string, r: Project) => <Link to={`/projects/${r.id}`} title="项目档案">{v}</Link> },
          { title: '名称', dataIndex: 'name' },
          { title: '类型', dataIndex: 'projectType', width: 120 },
          { title: '归属组织', dataIndex: 'orgName', width: 160 },
          { title: '状态', dataIndex: 'status', width: 80, render: statusTag },
          { title: '更新', dataIndex: 'updatedAt', width: 140, render: (v: string) => shortTime(v) },
          ...(writable ? [{
            title: '操作', width: 140,
            render: (_: unknown, p: Project) => (
              <Space>
                <a onClick={() => open(p)}>编辑</a>
                <Popconfirm title={p.status === 'active' ? '停用后不再参与新数据匹配,历史数据不受影响。确认停用?' : '确认启用?'} onConfirm={() => toggle.mutate(p)}>
                  <a>{p.status === 'active' ? '停用' : '启用'}</a>
                </Popconfirm>
              </Space>
            ),
          }] : []),
        ]}
      />
      <Modal open={editing !== null} title={editing === 'new' ? '新建项目' : '编辑项目'} onCancel={() => setEditing(null)}
        onOk={() => form.validateFields().then((v) => save.mutate(v))} confirmLoading={save.isPending} destroyOnClose>
        <Form form={form} layout="vertical">
          <Form.Item name="code" label="项目编码" rules={[{ required: true, pattern: /^[A-Za-z0-9][A-Za-z0-9_.\-/]*$/, message: '字母或数字开头,可含 _ . - /' }]}>
            <Input disabled={editing !== 'new'} maxLength={64} />
          </Form.Item>
          <Form.Item name="name" label="项目名称" rules={[{ required: true, whitespace: true }]}><Input maxLength={200} /></Form.Item>
          <Form.Item name="projectType" label="项目类型"><Input maxLength={64} /></Form.Item>
          <Form.Item name="orgId" label="归属组织" rules={[{ required: true, message: '请选择归属组织' }]}>
            <TreeSelect treeData={toTreeData(orgTree.data?.tree ?? [])} treeDefaultExpandAll showSearch treeNodeFilterProp="title" />
          </Form.Item>
        </Form>
      </Modal>
    </>
  );
}

function SuppliersTab({ initialKeyword = '' }: { initialKeyword?: string }) {
  const { message } = AntdApp.useApp();
  const qc = useQueryClient();
  const writable = can('master:write');
  const [keyword, setKeyword] = useState(initialKeyword);
  const [editing, setEditing] = useState<Supplier | 'new' | null>(null);
  const [form] = Form.useForm<{ code?: string; name: string; supplierType?: string; creditCode?: string }>();
  const list = useQuery({
    queryKey: ['master-suppliers', keyword],
    queryFn: () => api.get<Supplier[]>(`/master/suppliers${keyword ? `?keyword=${encodeURIComponent(keyword)}` : ''}`),
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['master-suppliers'] });
  const save = useMutation({
    mutationFn: (v: { code?: string; name: string; supplierType?: string; creditCode?: string }) => editing === 'new'
      ? api.post<Supplier>('/master/suppliers', v)
      : api.patch<Supplier>(`/master/suppliers/${(editing as Supplier).id}`, { ...v, code: (editing as Supplier).code ? undefined : v.code }),
    onSuccess: () => { message.success('已保存'); setEditing(null); refresh(); },
    onError: (e) => message.error(errorText(e)),
  });
  const toggle = useMutation({
    mutationFn: (s: Supplier) => api.patch<Supplier>(`/master/suppliers/${s.id}`, { status: s.status === 'active' ? 'inactive' : 'active' }),
    onSuccess: () => refresh(),
    onError: (e) => message.error(errorText(e)),
  });
  if (list.error) return <QueryErrorResult title="供应商加载失败" error={list.error} refetch={list.refetch} />;
  const open = (s: Supplier | 'new') => {
    setEditing(s);
    form.setFieldsValue(s === 'new' ? { code: '', name: '', supplierType: '', creditCode: '' } : { code: s.code ?? '', name: s.name, supplierType: s.supplierType, creditCode: s.creditCode });
  };
  return (
    <>
      <Space style={{ marginBottom: 12 }}>
        <Input.Search allowClear placeholder="编码或名称" defaultValue={keyword} onSearch={setKeyword} style={{ width: 220 }} />
        {writable && <Button type="primary" onClick={() => open('new')}>新建供应商</Button>}
        <Typography.Text type="secondary">名称按全半角、空白与括号归一后查重。</Typography.Text>
      </Space>
      <Table<Supplier>
        rowKey="id" loading={list.isLoading} dataSource={list.data ?? []} pagination={{ pageSize: 20, showSizeChanger: false }}
        columns={[
          { title: '编码', dataIndex: 'code', width: 120, render: (v: string | null) => v ?? '—' },
          { title: '名称', dataIndex: 'name' },
          { title: '类型', dataIndex: 'supplierType', width: 120 },
          { title: '统一社会信用代码', dataIndex: 'creditCode', width: 190 },
          { title: '状态', dataIndex: 'status', width: 80, render: statusTag },
          ...(writable ? [{
            title: '操作', width: 120,
            render: (_: unknown, s: Supplier) => (
              <Space>
                <a onClick={() => open(s)}>编辑</a>
                <Popconfirm title={s.status === 'active' ? '确认停用?' : '确认启用?'} onConfirm={() => toggle.mutate(s)}>
                  <a>{s.status === 'active' ? '停用' : '启用'}</a>
                </Popconfirm>
              </Space>
            ),
          }] : []),
        ]}
      />
      <Modal open={editing !== null} title={editing === 'new' ? '新建供应商' : '编辑供应商'} onCancel={() => setEditing(null)}
        onOk={() => form.validateFields().then((v) => save.mutate(v))} confirmLoading={save.isPending} destroyOnClose>
        <Form form={form} layout="vertical">
          <Form.Item name="code" label="供应商编码(可选,建立后不可修改)"><Input disabled={editing !== 'new' && !!(editing as Supplier | null)?.code} maxLength={64} /></Form.Item>
          <Form.Item name="name" label="供应商名称" rules={[{ required: true, whitespace: true }]}><Input maxLength={200} /></Form.Item>
          <Form.Item name="supplierType" label="类型"><Input maxLength={64} /></Form.Item>
          <Form.Item name="creditCode" label="统一社会信用代码" rules={[{ pattern: /^$|^[0-9A-HJ-NPQRTUWXYa-hj-npqrtuwxy]{18}$/, message: '18 位统一社会信用代码' }]}><Input maxLength={18} /></Form.Item>
        </Form>
      </Modal>
    </>
  );
}

function useTargetOptions(type: EntityType | undefined) {
  const orgTree = useOrgTree();
  const accounts = useQuery({ queryKey: ['account-tree'], queryFn: () => api.get<{ rows: TreeRow[] }>('/account/tree'), enabled: type === 'account' });
  const projects = useQuery({ queryKey: ['master-projects', ''], queryFn: () => api.get<Project[]>('/master/projects'), enabled: type === 'project' });
  const suppliers = useQuery({ queryKey: ['master-suppliers', ''], queryFn: () => api.get<Supplier[]>('/master/suppliers'), enabled: type === 'supplier' });
  const rows: { id: number; code: string | null; name: string; status: Status }[] =
    type === 'org' ? orgTree.data?.rows ?? [] : type === 'account' ? accounts.data?.rows ?? [] : type === 'project' ? projects.data ?? [] : type === 'supplier' ? suppliers.data ?? [] : [];
  return rows.filter((r) => r.status === 'active').map((r) => ({ value: r.id, label: r.code ? `${r.name}(${r.code})` : r.name }));
}

function MappingsTab() {
  const { message } = AntdApp.useApp();
  const qc = useQueryClient();
  const writable = can('master:write');
  const [includeRetired, setIncludeRetired] = useState(false);
  const [entity, setEntity] = useState<EntityType | undefined>();
  const [adding, setAdding] = useState(false);
  const [form] = Form.useForm<{ sourceSystem: string; entityType: EntityType; matchKind: 'code' | 'name'; sourceKey: string; targetId: number; validFrom?: dayjs.Dayjs; note?: string }>();
  const formEntity = Form.useWatch('entityType', form);
  const targetOptions = useTargetOptions(formEntity);
  const list = useQuery({
    queryKey: ['master-mappings', includeRetired, entity],
    queryFn: () => api.get<Mapping[]>(`/master/mappings?${includeRetired ? 'includeRetired=1&' : ''}${entity ? `entityType=${entity}` : ''}`),
  });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['master-mappings'] });
  const save = useMutation({
    mutationFn: (v: { sourceSystem: string; entityType: EntityType; matchKind: 'code' | 'name'; sourceKey: string; targetId: number; validFrom?: dayjs.Dayjs; note?: string }) =>
      api.post<Mapping>('/master/mappings', { ...v, validFrom: v.validFrom ? v.validFrom.toISOString() : undefined }),
    onSuccess: () => { message.success('映射已保存;原有映射(如有)已退役并保留历史'); setAdding(false); refresh(); },
    onError: (e) => message.error(errorText(e)),
  });
  const retire = useMutation({
    mutationFn: (id: number) => api.post<Mapping>(`/master/mappings/${id}/retire`),
    onSuccess: () => { message.success('已退役'); refresh(); },
    onError: (e) => message.error(errorText(e)),
  });
  if (list.error) return <QueryErrorResult title="映射加载失败" error={list.error} refetch={list.refetch} />;
  return (
    <>
      <Space style={{ marginBottom: 12 }} wrap>
        <Select<EntityType> allowClear placeholder="全部实体" style={{ width: 120 }} value={entity} onChange={setEntity}
          options={Object.entries(ENTITY_LABEL).map(([value, label]) => ({ value: value as EntityType, label }))} />
        <Space><Switch checked={includeRetired} onChange={setIncludeRetired} size="small" />含已退役</Space>
        {writable && <Button type="primary" onClick={() => { form.resetFields(); form.setFieldsValue({ matchKind: 'code' }); setAdding(true); }}>新建映射</Button>}
      </Space>
      <Alert type="info" showIcon style={{ marginBottom: 12 }}
        message="映射把外部系统(如 EAS、合同台账)的编码或名称对应到本系统的规范实体。变更映射会退役旧行并新增一行,历史口径按生效区间复现,不会改写已入库数据。映射影响全局解析,仅全部组织授权的用户可维护。" />
      <Table<Mapping>
        rowKey="id" loading={list.isLoading} dataSource={list.data ?? []} pagination={{ pageSize: 20, showSizeChanger: false }}
        columns={[
          { title: '来源系统', dataIndex: 'sourceSystem', width: 100 },
          { title: '实体', dataIndex: 'entityType', width: 80, render: (v: EntityType) => ENTITY_LABEL[v] },
          { title: '匹配', dataIndex: 'matchKind', width: 70, render: (v: string) => (v === 'code' ? '编码' : '名称') },
          { title: '外部键', dataIndex: 'sourceLabel' },
          { title: '目标', render: (_, m) => `${m.targetName}${m.targetCode ? `(${m.targetCode})` : ''}` },
          { title: '生效', dataIndex: 'validFrom', width: 140, render: (v: string) => shortTime(v) },
          { title: '失效', dataIndex: 'validTo', width: 140, render: (v: string | null) => (v ? shortTime(v) : <Tag color="success">现行</Tag>) },
          { title: '备注', dataIndex: 'note' },
          ...(writable ? [{
            title: '操作', width: 80,
            render: (_: unknown, m: Mapping) => m.active ? (
              <Popconfirm title="退役后新数据不再按此映射解析,历史口径保留。确认?" onConfirm={() => retire.mutate(m.id)}><a>退役</a></Popconfirm>
            ) : null,
          }] : []),
        ]}
      />
      <Modal open={adding} title="新建映射" onCancel={() => setAdding(false)} onOk={() => form.validateFields().then((v) => save.mutate(v))} confirmLoading={save.isPending} destroyOnClose>
        <Form form={form} layout="vertical">
          <Form.Item name="sourceSystem" label="来源系统标识" rules={[{ required: true, pattern: /^[a-z][a-z0-9_]*$/, message: '小写字母开头,如 eas、contract' }]}><Input placeholder="eas" maxLength={32} /></Form.Item>
          <Form.Item name="entityType" label="实体类型" rules={[{ required: true }]}>
            <Select options={Object.entries(ENTITY_LABEL).map(([value, label]) => ({ value, label }))} onChange={() => form.setFieldValue('targetId', undefined)} />
          </Form.Item>
          <Form.Item name="matchKind" label="匹配方式" rules={[{ required: true }]}>
            <Select options={[{ value: 'code', label: '按外部编码' }, { value: 'name', label: '按外部名称(归一化后匹配)' }]} />
          </Form.Item>
          <Form.Item name="sourceKey" label="外部编码/名称" rules={[{ required: true, whitespace: true }]}><Input maxLength={200} /></Form.Item>
          <Form.Item name="targetId" label="映射到" rules={[{ required: true, message: '请选择目标' }]}>
            <Select showSearch optionFilterProp="label" options={targetOptions} disabled={!formEntity} />
          </Form.Item>
          <Form.Item name="validFrom" label="生效时间(默认现在)"><DatePicker showTime style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="note" label="备注"><Input maxLength={500} /></Form.Item>
        </Form>
      </Modal>
    </>
  );
}

function ResolveTab() {
  const { message } = AntdApp.useApp();
  const [entityType, setEntityType] = useState<EntityType>('org');
  const [sourceSystem, setSourceSystem] = useState('');
  const [asOf, setAsOf] = useState<dayjs.Dayjs | null>(null);
  const [text, setText] = useState('');
  const run = useMutation({
    mutationFn: () => {
      const items = text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((line) => {
        const [a, b] = line.split(/\t|,|,/).map((x) => x.trim());
        return b !== undefined ? { code: a || undefined, name: b || undefined } : { code: a, name: a };
      });
      return api.post<ResolveResult[]>('/master/resolve', { entityType, sourceSystem: sourceSystem || undefined, asOf: asOf?.toISOString(), items });
    },
    onError: (e) => message.error(errorText(e)),
  });
  return (
    <>
      <Typography.Paragraph type="secondary">
        每行一条:“编码,名称”或单独的编码/名称。解析顺序:精确编码 → 编码映射 → 精确名称 → 名称映射 → 组织去后缀的规范化名称;多个候选时不自动选择。只读,不写入任何数据。
      </Typography.Paragraph>
      <Space style={{ marginBottom: 12 }} wrap>
        <Select<EntityType> value={entityType} onChange={setEntityType} style={{ width: 120 }}
          options={Object.entries(ENTITY_LABEL).map(([value, label]) => ({ value: value as EntityType, label }))} />
        <Input placeholder="来源系统(可选)" value={sourceSystem} onChange={(e) => setSourceSystem(e.target.value.trim())} style={{ width: 160 }} />
        <DatePicker showTime placeholder="按历史时点(可选)" value={asOf} onChange={setAsOf} />
        <Button type="primary" loading={run.isPending} disabled={!text.trim()} onClick={() => run.mutate()}>解析</Button>
      </Space>
      <Input.TextArea rows={6} value={text} onChange={(e) => setText(e.target.value)} placeholder={'SH\n上海分公司\nEAS-0001,项目甲'} />
      {run.data && (
        <Table<ResolveResult>
          style={{ marginTop: 12 }} size="small" rowKey={(_, i) => String(i)} pagination={false} dataSource={run.data}
          columns={[
            { title: '输入', render: (_, r) => [r.input.code, r.input.name].filter(Boolean).filter((v, i, a) => a.indexOf(v) === i).join(' / ') },
            { title: '结果', dataIndex: 'matchedBy', width: 110, render: (v: string) => <Tag color={MATCHED_LABEL[v]?.color}>{MATCHED_LABEL[v]?.text ?? v}</Tag> },
            { title: '目标', render: (_, r) => (r.targetId ? `${r.targetName}${r.targetCode ? `(${r.targetCode})` : ''}` : r.candidates.map((c) => `${c.name}(${c.code})`).join('、') || '—') },
            { title: '置信度', dataIndex: 'confidence', width: 80 },
          ]}
        />
      )}
    </>
  );
}

/** 主数据扩展(AC-F07):项目、供应商、跨域编码映射与解析预览。组织/科目沿用原页面。 */
const TAB_KEYS = ['projects', 'suppliers', 'mappings', 'resolve', 'dicts'];

/** `?tab=&keyword=` 由跨域检索(AC-F26)带入:定位到对应页签并预填关键词;切换页签时清除关键词。 */
export default function MasterEntities() {
  const [params, setParams] = useSearchParams();
  const tab = TAB_KEYS.includes(params.get('tab') ?? '') ? params.get('tab')! : 'projects';
  const keyword = params.get('keyword') ?? '';
  const onTab = (k: string) => setParams((p) => { const n = new URLSearchParams(p); n.set('tab', k); n.delete('keyword'); return n; }, { replace: true });
  return (
    <Card>
      <Tabs
        activeKey={tab}
        onChange={onTab}
        items={[
          { key: 'projects', label: '项目', children: <ProjectsTab key={`p:${tab === 'projects' ? keyword : ''}`} initialKeyword={tab === 'projects' ? keyword : ''} /> },
          { key: 'suppliers', label: '供应商', children: <SuppliersTab key={`s:${tab === 'suppliers' ? keyword : ''}`} initialKeyword={tab === 'suppliers' ? keyword : ''} /> },
          { key: 'mappings', label: '编码映射', children: <MappingsTab /> },
          { key: 'resolve', label: '解析预览', children: <ResolveTab /> },
          { key: 'dicts', label: '字典项', children: <DictItemsTab /> },
        ]}
      />
    </Card>
  );
}
