import { useAssistantDomainPage } from '../assistant/contextHooks';
import { useMemo, useState, type ReactNode } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App as AntdApp, Button, Card, Checkbox, Form, Input, Modal, Popconfirm, Select, Space, Switch, Table, Tabs, Tag, TreeSelect, Typography, Upload } from 'antd';
import { api, can, errorText, getSession } from '../api/client';
import { QueryErrorResult } from '../components/QueryErrorResult';
import { shortTime } from '../utils/relativeTime';
import { downloadCsvTemplate, parseCsvOrJsonRecords } from '../utils/simpleCsvJson';
import { usePrompt } from './financeData/shared';

interface UserItem {
  id: number;
  username: string;
  displayName: string;
  status: 'active' | 'disabled';
  allOrgs: boolean;
  mustChangePassword: boolean;
  roles: { id: number; code: string; name: string }[];
  orgIds: number[];
  lastLoginAt: string | null;
}

interface RoleItem {
  id: number;
  code: string;
  name: string;
  description: string;
  locked: boolean;
  permissions: string[];
  userCount: number;
}

interface PermissionItem { code: string; label: string; group: string }
interface OrgTreeNode {
  id: number;
  code: string;
  name: string;
  status?: string;
  orgKind?: string;
  children?: OrgTreeNode[];
}

interface UserBatchPreviewRow {
  row: number;
  username: string;
  displayName: string;
  roleCodes: string[];
  roleIds: number[];
  allOrgs: boolean;
  orgCodes: string[];
  orgIds: number[];
  hasPassword: boolean;
  action: 'create' | 'update';
  errors: string[];
}

interface UserBatchImportResult {
  mode: 'preview' | 'confirm';
  rows: UserBatchPreviewRow[];
  errors: { row: number; field: string; message: string }[];
  created: number;
  updated: number;
}

const USER_CSV_HEADERS: Record<string, string> = {
  用户名: 'username',
  账号: 'username',
  显示名: 'displayName',
  姓名: 'displayName',
  角色编码: 'roleCodes',
  角色: 'roleCodes',
  全部组织: 'allOrgs',
  授权组织编码: 'orgCodes',
  授权组织: 'orgCodes',
  初始口令: 'initialPassword',
  初始密码: 'initialPassword',
};

const USER_CSV_TEMPLATE = [
  'username,displayName,roleCodes,allOrgs,orgCodes,initialPassword',
  'hq_reviewer,集团业务复核岗,business_reviewer,是,,InitPass#2026A',
  'sub01_editor,下属单位经办岗,unit_editor,否,ORG_SUB01,InitPass#2026B',
].join('\n');

interface UserForm {
  username?: string;
  displayName: string;
  password?: string;
  roleIds: number[];
  allOrgs: boolean;
  orgIds: number[];
}

interface RoleForm {
  code?: string;
  name: string;
  description?: string;
  permissions: string[];
}

interface SessionItem {
  sid: string; createdAt: string; lastSeenAt: string; expiresAt: string; ip: string; userAgent: string;
  status: 'active' | 'revoked' | 'expired'; revokedAt: string | null; current: boolean;
}
const SESSION_STATUS: Record<SessionItem['status'], [string, string]> = { active: ['有效', 'success'], revoked: ['已吊销', 'default'], expired: ['已过期', 'default'] };

/** 用户会话:只显示句柄与登录来源;吊销后该会话下一次请求即失效。当前会话不能在此吊销。 */
function SessionsModal({ user, onClose }: { user: UserItem | null; onClose: () => void }) {
  const { message } = AntdApp.useApp();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['security-sessions', user?.id], queryFn: () => api.get<{ items: SessionItem[] }>(`/security/users/${user!.id}/sessions`), enabled: !!user });
  const revoke = useMutation({
    mutationFn: (sid: string) => api.post(`/security/users/${user!.id}/sessions/${sid}/revoke`),
    onSuccess: () => { message.success('会话已吊销'); void qc.invalidateQueries({ queryKey: ['security-sessions', user?.id] }); },
    onError: (e) => message.error(errorText(e)),
  });
  return (
    <Modal open={!!user} onCancel={onClose} footer={null} width={900} destroyOnClose title={user ? `${user.displayName || user.username} 的会话` : '会话'}>
      {q.error ? <QueryErrorResult title="会话加载失败" error={q.error} refetch={q.refetch} /> : (
        <Table<SessionItem> rowKey="sid" size="small" loading={q.isLoading} dataSource={q.data?.items ?? []} pagination={false} columns={[
          { title: '会话', dataIndex: 'sid', width: 170, render: (v: string, s) => <Space size={4}><Typography.Text code>{v}</Typography.Text>{s.current && <Tag color="blue">当前</Tag>}</Space> },
          { title: '状态', dataIndex: 'status', width: 80, render: (v: SessionItem['status']) => <Tag color={SESSION_STATUS[v][1]}>{SESSION_STATUS[v][0]}</Tag> },
          { title: '登录', dataIndex: 'createdAt', width: 130, render: (v: string) => shortTime(v) },
          { title: '最近活动', dataIndex: 'lastSeenAt', width: 130, render: (v: string) => shortTime(v) },
          { title: '来源', dataIndex: 'ip', width: 120 },
          { title: '客户端', dataIndex: 'userAgent', ellipsis: true },
          {
            title: '操作', key: 'op', width: 90,
            render: (_: unknown, s) => (s.status === 'active' && !s.current ? (
              <Popconfirm title="吊销该会话?对方需要重新登录" onConfirm={() => revoke.mutate(s.sid)}>
                <Button size="small" danger>吊销</Button>
              </Popconfirm>
            ) : null),
          },
        ]} />
      )}
    </Modal>
  );
}

interface OrgTreeOption {
  value: number;
  title: ReactNode;
  searchLabel: string;
  disabled?: boolean;
  children?: OrgTreeOption[];
}

function toTreeData(nodes: OrgTreeNode[]): OrgTreeOption[] {
  return nodes.map((n) => {
    const isClosed = n.status === 'inactive' || n.orgKind === 'closed_history';
    const labelText = `${n.name}(${n.code})`;
    return {
      value: n.id,
      searchLabel: labelText,
      disabled: isClosed,
      title: isClosed ? (
        <Space size={4}>
          <span>{labelText}</span>
          <Tag>历史停用</Tag>
        </Space>
      ) : (
        labelText
      ),
      children: n.children?.length ? toTreeData(n.children) : undefined,
    };
  });
}

/**
 * 用户与权限:账号、角色(操作权限)与组织数据范围分开维护。
 * 授权一个组织即包含其全部下级;“全部组织”才可访问集团口径汇总。
 * 前端只做录入与展示,所有约束(最后管理员、内置角色锁定、口令策略)以服务端为准。
 */
export default function SecurityAdmin() {
  useAssistantDomainPage({ pageKey: 'security', ready: true, view: {} });
  const { message } = AntdApp.useApp();
  const qc = useQueryClient();
  const me = getSession()?.user;
  const canManageSecurity = can('security:manage');
  const [editingUser, setEditingUser] = useState<UserItem | 'new' | null>(null);
  const [editingRole, setEditingRole] = useState<RoleItem | 'new' | null>(null);
  const [sessionsOf, setSessionsOf] = useState<UserItem | null>(null);
  const [batchOpen, setBatchOpen] = useState(false);
  const [batchRawText, setBatchRawText] = useState('');
  const [batchItems, setBatchItems] = useState<Record<string, unknown>[]>([]);
  const [batchPreview, setBatchPreview] = useState<UserBatchImportResult | null>(null);
  const [prompt, promptHolder] = usePrompt();
  const [userForm] = Form.useForm<UserForm>();
  const [roleForm] = Form.useForm<RoleForm>();

  const users = useQuery({ queryKey: ['security-users'], queryFn: () => api.get<{ items: UserItem[] }>('/security/users') });
  const roles = useQuery({ queryKey: ['security-roles'], queryFn: () => api.get<{ items: RoleItem[] }>('/security/roles') });
  const perms = useQuery({ queryKey: ['security-permissions'], queryFn: () => api.get<{ items: PermissionItem[] }>('/security/permissions') });
  const orgTree = useQuery({ queryKey: ['org-tree'], queryFn: () => api.get<{ tree: OrgTreeNode[]; rows: { id: number; name: string }[] }>('/org/tree') });

  const orgName = useMemo(() => new Map((orgTree.data?.rows ?? []).map((r) => [r.id, r.name])), [orgTree.data]);
  const permGroups = useMemo(() => {
    const groups = new Map<string, PermissionItem[]>();
    for (const p of perms.data?.items ?? []) groups.set(p.group, [...(groups.get(p.group) ?? []), p]);
    return [...groups.entries()];
  }, [perms.data]);

  const invalidate = () => {
    void qc.invalidateQueries({ queryKey: ['security-users'] });
    void qc.invalidateQueries({ queryKey: ['security-roles'] });
  };

  const saveUser = useMutation({
    mutationFn: async (values: UserForm) => {
      const body: Record<string, unknown> = {
        displayName: values.displayName,
        roleIds: values.roleIds ?? [],
        allOrgs: values.allOrgs,
        orgIds: values.allOrgs ? [] : values.orgIds ?? [],
      };
      if (values.password) body.password = values.password;
      if (editingUser === 'new') return api.post('/security/users', { ...body, username: values.username });
      return api.patch(`/security/users/${(editingUser as UserItem).id}`, body);
    },
    onSuccess: () => { message.success('已保存'); setEditingUser(null); invalidate(); },
    onError: (e) => message.error(errorText(e)),
  });

  const toggleStatus = useMutation({
    mutationFn: (u: UserItem) => api.patch(`/security/users/${u.id}`, { status: u.status === 'active' ? 'disabled' : 'active' }),
    onSuccess: () => { message.success('已更新'); invalidate(); },
    onError: (e) => message.error(errorText(e)),
  });

  const saveRole = useMutation({
    mutationFn: (values: RoleForm) => editingRole === 'new'
      ? api.post('/security/roles', values)
      : api.patch(`/security/roles/${(editingRole as RoleItem).id}`, { name: values.name, description: values.description, permissions: values.permissions }),
    onSuccess: () => { message.success('已保存'); setEditingRole(null); invalidate(); },
    onError: (e) => message.error(errorText(e)),
  });

  const deleteRole = useMutation({
    mutationFn: (r: RoleItem) => api.del(`/security/roles/${r.id}`),
    onSuccess: () => { message.success('已删除'); invalidate(); },
    onError: (e) => message.error(errorText(e)),
  });

  const previewBatchUsers = useMutation({
    mutationFn: (items: Record<string, unknown>[]) =>
      api.post<UserBatchImportResult>('/security/users/batch-import', { mode: 'preview', items }),
    onSuccess: (res) => {
      setBatchPreview(res);
      if (res.errors.length === 0) message.success(`预览通过：待新增 ${res.created} 个、更新 ${res.updated} 个账号`);
      else message.warning(`预览发现 ${res.errors.length} 处校验错误`);
    },
    onError: (e) => message.error(errorText(e)),
  });

  const confirmBatchUsers = useMutation({
    mutationFn: () => api.post<UserBatchImportResult>('/security/users/batch-import', { mode: 'confirm', items: batchItems }),
    onSuccess: (res) => {
      message.success(`批量导入成功：新增 ${res.created} 个、更新 ${res.updated} 个账号`);
      setBatchOpen(false);
      setBatchRawText('');
      setBatchItems([]);
      setBatchPreview(null);
      invalidate();
    },
    onError: (e) => message.error(errorText(e)),
  });

  const handleParseBatchUsers = (raw: string) => {
    try {
      const parsed = parseCsvOrJsonRecords(raw, USER_CSV_HEADERS);
      setBatchItems(parsed);
      previewBatchUsers.mutate(parsed);
    } catch (e) {
      message.error(errorText(e));
    }
  };

  const copyRole = async (r: RoleItem) => {
    const v = await prompt({
      title: `复制角色 ${r.name}`, description: '新角色带出原角色的全部权限,不带用户;复制后可再调整权限。',
      fields: [{ name: 'code', label: '新角色编码(小写字母开头)', required: true, initial: `${r.code}_copy` }, { name: 'name', label: '新角色名称', required: true, initial: `${r.name}(副本)` }],
    });
    if (!v) return;
    try { await api.post(`/security/roles/${r.id}/copy`, { code: v.code, name: v.name }); message.success('已复制'); invalidate(); } catch (e) { message.error(errorText(e)); }
  };

  const openUser = (u: UserItem | 'new') => {
    setEditingUser(u);
    userForm.setFieldsValue(u === 'new'
      ? { username: '', displayName: '', password: '', roleIds: [], allOrgs: false, orgIds: [] }
      : { displayName: u.displayName, password: '', roleIds: u.roles.map((r) => r.id), allOrgs: u.allOrgs, orgIds: u.orgIds });
  };
  const openRole = (r: RoleItem | 'new') => {
    setEditingRole(r);
    roleForm.setFieldsValue(r === 'new' ? { code: '', name: '', description: '', permissions: [] } : { name: r.name, description: r.description, permissions: r.permissions });
  };

  const allOrgsWatch = Form.useWatch('allOrgs', userForm);

  const loadError = users.error ?? roles.error ?? perms.error;
  if (loadError) {
    return <QueryErrorResult title="用户与权限加载失败" error={loadError} refetch={() => { void users.refetch(); void roles.refetch(); void perms.refetch(); }} />;
  }

  return (
    <Card>
      {promptHolder}
      <SessionsModal user={sessionsOf} onClose={() => setSessionsOf(null)} />
      <Tabs
        items={[
          {
            key: 'users',
            label: '用户',
            children: (
              <>
                <Space wrap style={{ marginBottom: 12 }}>
                  <Button type="primary" icon={<i className="ri-user-add-line" aria-hidden />} onClick={() => openUser('new')}>新建用户</Button>
                  {canManageSecurity && (
                    <Button onClick={() => { setBatchOpen(true); setBatchPreview(null); }}>
                      批量初始化用户与数据范围
                    </Button>
                  )}
                  <Typography.Text type="secondary">新建或重置口令后,用户首次登录须自行修改口令。</Typography.Text>
                </Space>
                <Table<UserItem>
                  rowKey="id"
                  loading={users.isLoading}
                  dataSource={users.data?.items ?? []}
                  pagination={false}
                  columns={[
                    { title: '用户名', dataIndex: 'username', render: (v: string, u) => <Space>{v}{u.id === me?.id && <Tag>当前</Tag>}</Space> },
                    { title: '显示名', dataIndex: 'displayName' },
                    { title: '角色', render: (_: unknown, u) => u.roles.map((r) => <Tag key={r.id}>{r.name}</Tag>) },
                    {
                      title: '数据范围',
                      render: (_: unknown, u) => u.allOrgs
                        ? <Tag color="blue">全部组织</Tag>
                        : u.orgIds.length === 0 ? <Typography.Text type="secondary">无</Typography.Text>
                        : u.orgIds.map((id) => <Tag key={id}>{orgName.get(id) ?? `#${id}`}及下级</Tag>),
                    },
                    {
                      title: '状态',
                      render: (_: unknown, u) => (
                        <Space size={4}>
                          {u.status === 'active' ? <Tag color="green">启用</Tag> : <Tag>停用</Tag>}
                          {u.mustChangePassword && <Tag color="orange">待改口令</Tag>}
                        </Space>
                      ),
                    },
                    { title: '最近登录', dataIndex: 'lastLoginAt', render: (v: string | null) => (v ? shortTime(v) : '—') },
                    {
                      title: '操作',
                      render: (_: unknown, u) => (
                        <Space>
                          <Button size="small" onClick={() => openUser(u)}>编辑</Button>
                          <Button size="small" onClick={() => setSessionsOf(u)}>会话</Button>
                          <Popconfirm
                            title={u.status === 'active' ? '停用后该用户的会话立即失效,确定?' : '重新启用该用户?'}
                            onConfirm={() => toggleStatus.mutate(u)}
                            disabled={u.id === me?.id}
                          >
                            <Button size="small" danger={u.status === 'active'} disabled={u.id === me?.id}>{u.status === 'active' ? '停用' : '启用'}</Button>
                          </Popconfirm>
                        </Space>
                      ),
                    },
                  ]}
                />
              </>
            ),
          },
          {
            key: 'roles',
            label: '角色',
            children: (
              <>
                <Space style={{ marginBottom: 12 }}>
                  <Button type="primary" icon={<i className="ri-shield-user-line" aria-hidden />} onClick={() => openRole('new')}>新建角色</Button>
                  <Typography.Text type="secondary">角色只决定可做的操作;可见的组织由用户的数据范围决定。</Typography.Text>
                </Space>
                <Table<RoleItem>
                  rowKey="id"
                  loading={roles.isLoading}
                  dataSource={roles.data?.items ?? []}
                  pagination={false}
                  columns={[
                    { title: '编码', dataIndex: 'code', render: (v: string, r) => <Space>{v}{r.locked && <Tag color="gold">内置锁定</Tag>}</Space> },
                    { title: '名称', dataIndex: 'name' },
                    { title: '说明', dataIndex: 'description', ellipsis: true },
                    { title: '权限数', render: (_: unknown, r) => r.permissions.length },
                    { title: '用户数', dataIndex: 'userCount' },
                    {
                      title: '操作',
                      render: (_: unknown, r) => (
                        <Space>
                          <Button size="small" disabled={r.locked} onClick={() => openRole(r)}>编辑</Button>
                          <Button size="small" onClick={() => void copyRole(r)}>复制</Button>
                          <Popconfirm title="删除该角色?" onConfirm={() => deleteRole.mutate(r)} disabled={r.locked || r.userCount > 0}>
                            <Button size="small" danger disabled={r.locked || r.userCount > 0} title={r.userCount > 0 ? '仍有用户使用该角色' : undefined}>删除</Button>
                          </Popconfirm>
                        </Space>
                      ),
                    },
                  ]}
                />
              </>
            ),
          },
        ]}
      />

      <Modal
        title={editingUser === 'new' ? '新建用户' : '编辑用户'}
        open={editingUser !== null}
        onCancel={() => setEditingUser(null)}
        onOk={() => userForm.submit()}
        confirmLoading={saveUser.isPending}
        destroyOnClose
        width={560}
      >
        <Form<UserForm> form={userForm} layout="vertical" onFinish={(v) => saveUser.mutate(v)}>
          {editingUser === 'new' && (
            <Form.Item name="username" label="用户名" rules={[{ required: true, message: '请输入用户名' }, { pattern: /^[A-Za-z0-9_.@-]{2,64}$/, message: '2~64 位字母、数字或 _ . @ -' }]}>
              <Input autoComplete="off" />
            </Form.Item>
          )}
          <Form.Item name="displayName" label="显示名" rules={[{ required: true, message: '请输入显示名' }]}>
            <Input />
          </Form.Item>
          <Form.Item
            name="password"
            label={editingUser === 'new' ? '初始口令' : '重置口令(留空不修改)'}
            extra="至少 10 位且不含用户名;保存后用户首次登录须修改。重置会立即使其现有会话失效。"
            rules={editingUser === 'new' ? [{ required: true, message: '请输入初始口令' }, { min: 10, message: '至少 10 位' }] : [{ min: 10, message: '至少 10 位' }]}
          >
            <Input.Password autoComplete="new-password" />
          </Form.Item>
          <Form.Item name="roleIds" label="角色">
            <Select mode="multiple" options={(roles.data?.items ?? []).map((r) => ({ value: r.id, label: r.name }))} placeholder="选择角色" />
          </Form.Item>
          <Form.Item name="allOrgs" label="全部组织(含集团口径汇总)" valuePropName="checked">
            <Switch />
          </Form.Item>
          {!allOrgsWatch && (
            <Form.Item name="orgIds" label="授权组织" extra="授权某个组织即包含其全部下级组织">
              <TreeSelect
                multiple
                treeDefaultExpandAll
                treeData={toTreeData(orgTree.data?.tree ?? [])}
                placeholder="选择组织"
                showSearch
                treeNodeFilterProp="searchLabel"
              />
            </Form.Item>
          )}
        </Form>
      </Modal>

      <Modal
        title="批量初始化用户与数据范围（预览 → 确认）"
        open={batchOpen}
        onCancel={() => { setBatchOpen(false); setBatchRawText(''); setBatchItems([]); setBatchPreview(null); }}
        width={940}
        okText="确认批量导入"
        confirmLoading={confirmBatchUsers.isPending}
        okButtonProps={{
          disabled:
            !batchPreview ||
            batchPreview.errors.length > 0 ||
            batchPreview.rows.length === 0 ||
            previewBatchUsers.isPending,
        }}
        onOk={() => confirmBatchUsers.mutate()}
      >
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <Alert
            type="info"
            showIcon
            message="密码将按服务端哈希策略存储，不在前端或日志保留明文，账号首次登录须修改密码。"
          />
          <Space wrap>
            <Upload
              accept=".csv,.json"
              showUploadList={false}
              beforeUpload={(file) => {
                void file.text().then((txt) => {
                  setBatchRawText(txt);
                  handleParseBatchUsers(txt);
                });
                return false;
              }}
            >
              <Button>选择 CSV / JSON 文件</Button>
            </Upload>
            <Button onClick={() => downloadCsvTemplate('users-scope-template.csv', USER_CSV_TEMPLATE)}>
              下载 CSV 模板
            </Button>
            <Button
              type="primary"
              ghost
              loading={previewBatchUsers.isPending}
              disabled={!batchRawText.trim()}
              onClick={() => handleParseBatchUsers(batchRawText)}
            >
              解析并预览
            </Button>
          </Space>
          <Input.TextArea
            rows={4}
            value={batchRawText}
            onChange={(e) => { setBatchRawText(e.target.value); setBatchPreview(null); }}
            placeholder="粘贴 CSV（username,displayName,roleCodes,allOrgs,orgCodes,initialPassword）或 JSON 数组"
          />
          {batchPreview && (
            <>
              <Alert
                type={batchPreview.errors.length > 0 ? 'error' : 'success'}
                showIcon
                message={
                  batchPreview.errors.length > 0
                    ? `发现 ${batchPreview.errors.length} 处校验错误（如停用历史组织不可授予写权限范围），请修正后重试`
                    : `预览通过：共 ${batchPreview.rows.length} 行（新增 ${batchPreview.created}，更新 ${batchPreview.updated}）`
                }
              />
              <Table<UserBatchPreviewRow>
                rowKey={(r) => `${r.row}-${r.username}`}
                size="small"
                pagination={{ pageSize: 8 }}
                dataSource={batchPreview.rows}
                columns={[
                  { title: '行号', dataIndex: 'row', width: 56 },
                  { title: '用户名', dataIndex: 'username', width: 130 },
                  { title: '显示名', dataIndex: 'displayName', width: 130 },
                  {
                    title: '角色编码',
                    dataIndex: 'roleCodes',
                    width: 150,
                    render: (codes: string[]) => codes.map((c) => <Tag key={c}>{c}</Tag>),
                  },
                  {
                    title: '数据范围',
                    width: 180,
                    render: (_: unknown, r) =>
                      r.allOrgs ? <Tag color="blue">全部组织</Tag> : r.orgCodes.map((oc) => <Tag key={oc}>{oc}</Tag>),
                  },
                  {
                    title: '动作',
                    dataIndex: 'action',
                    width: 75,
                    render: (v: 'create' | 'update') => <Tag color={v === 'create' ? 'green' : 'blue'}>{v === 'create' ? '新增' : '更新'}</Tag>,
                  },
                  {
                    title: '校验结果',
                    dataIndex: 'errors',
                    render: (errs: string[]) =>
                      errs.length > 0 ? <Typography.Text type="danger">{errs.join('；')}</Typography.Text> : <Tag color="success">通过</Tag>,
                  },
                ]}
              />
            </>
          )}
        </Space>
      </Modal>

      <Modal
        title={editingRole === 'new' ? '新建角色' : '编辑角色'}
        open={editingRole !== null}
        onCancel={() => setEditingRole(null)}
        onOk={() => roleForm.submit()}
        confirmLoading={saveRole.isPending}
        destroyOnClose
        width={720}
      >
        <Form<RoleForm> form={roleForm} layout="vertical" onFinish={(v) => saveRole.mutate(v)}>
          {editingRole === 'new' && (
            <Form.Item name="code" label="编码" rules={[{ required: true, message: '请输入编码' }, { pattern: /^[a-z][a-z0-9_]{1,63}$/, message: '小写字母开头,2~64 位小写字母、数字或下划线' }]}>
              <Input />
            </Form.Item>
          )}
          <Form.Item name="name" label="名称" rules={[{ required: true, message: '请输入名称' }]}>
            <Input />
          </Form.Item>
          <Form.Item name="description" label="说明">
            <Input.TextArea autoSize={{ minRows: 1, maxRows: 3 }} />
          </Form.Item>
          <Alert type="info" showIcon style={{ marginBottom: 12 }} message="“用户与权限管理”权限可授予他人管理账号,请谨慎分配。" />
          <Form.Item name="permissions" label="权限">
            <Checkbox.Group style={{ width: '100%' }}>
              <Space direction="vertical" style={{ width: '100%' }}>
                {permGroups.map(([group, items]) => (
                  <div key={group}>
                    <Typography.Text strong style={{ display: 'block', marginBottom: 4 }}>{group}</Typography.Text>
                    <Space wrap>
                      {items.map((p) => <Checkbox key={p.code} value={p.code}>{p.label}</Checkbox>)}
                    </Space>
                  </div>
                ))}
              </Space>
            </Checkbox.Group>
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
