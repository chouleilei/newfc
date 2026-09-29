import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App as AntdApp, Button, Card, Checkbox, Form, Input, Modal, Popconfirm, Select, Space, Switch, Table, Tabs, Tag, TreeSelect, Typography } from 'antd';
import { api, errorText, getSession } from '../api/client';
import { QueryErrorResult } from '../components/QueryErrorResult';
import { shortTime } from '../utils/relativeTime';

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
interface OrgTreeNode { id: number; code: string; name: string; children?: OrgTreeNode[] }

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

function toTreeData(nodes: OrgTreeNode[]): { value: number; title: string; children?: ReturnType<typeof toTreeData> }[] {
  return nodes.map((n) => ({ value: n.id, title: `${n.name}(${n.code})`, children: n.children?.length ? toTreeData(n.children) : undefined }));
}

/**
 * 用户与权限:账号、角色(操作权限)与组织数据范围分开维护。
 * 授权一个组织即包含其全部下级;“全部组织”才可访问集团口径汇总。
 * 前端只做录入与展示,所有约束(最后管理员、内置角色锁定、口令策略)以服务端为准。
 */
export default function SecurityAdmin() {
  const { message } = AntdApp.useApp();
  const qc = useQueryClient();
  const me = getSession()?.user;
  const [editingUser, setEditingUser] = useState<UserItem | 'new' | null>(null);
  const [editingRole, setEditingRole] = useState<RoleItem | 'new' | null>(null);
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
      <Tabs
        items={[
          {
            key: 'users',
            label: '用户',
            children: (
              <>
                <Space style={{ marginBottom: 12 }}>
                  <Button type="primary" icon={<i className="ri-user-add-line" aria-hidden />} onClick={() => openUser('new')}>新建用户</Button>
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
                treeNodeFilterProp="title"
              />
            </Form.Item>
          )}
        </Form>
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
