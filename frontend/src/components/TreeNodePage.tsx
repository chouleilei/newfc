import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, Space, Button, Modal, Form, Input, InputNumber, Select, Popconfirm, App, Tag, Empty, Typography, List, TreeSelect, Result } from 'antd';
import { api, errorText } from '../api/client';

/** 统一错误文本实现在 api/client;这里保留再导出,避免所有管理页变更导入路径。 */
export { errorText };
import { MasterDataHealthTrigger } from './MasterDataHealth';
import { useAssistantPageContext } from '../assistant/contextHooks';

/** 组织/科目管理共用页面骨架(方案五) */

export interface TreeNodeDto {
  id: number;
  parentId: number | null;
  code: string;
  name: string;
  type?: string;
  unit?: string;
  quantityAgg?: string;
  sortOrder: number;
  status: string;
  children: TreeNodeDto[];
  path: string;
  isLeaf: boolean;
}

export interface TreeRow {
  id: number;
  parent_id: number | null;
  code: string;
  name: string;
  type?: string;
  sort_order: number;
  status: string;
}

interface NodeFormValues {
  code: string;
  name: string;
  type?: string;
  unit?: string;
  quantityAgg?: 'sum' | 'none';
  sortOrder?: number;
}

export function TreeManage({
  kind,
  checkPath,
  renamePath,
}: {
  kind: 'org' | 'account';
  checkPath: string;
  renamePath?: string;
}) {
  void renamePath;
  const qc = useQueryClient();
  const { message, modal } = App.useApp();
  const [nodes, setNodes] = useState<TreeNodeDto[] | null>(null);
  const [modalOpen, setModalOpen] = useState(false);
  const [parent, setParent] = useState<TreeNodeDto | null>(null);
  const [form] = Form.useForm<NodeFormValues>();
  const [checkResult, setCheckResult] = useState<{ ok: boolean; problems: string[] } | null>(null);
  const [keyword, setKeyword] = useState('');
  /* 小澧助手页面登记(§7.2 org)：当前树与搜索关键字。 */
  useAssistantPageContext({ pageKey: kind === 'org' ? 'org' : 'account', ready: nodes != null, notReadyReason: '正在读取树数据', readyState: 'loading', scope: {}, view: { search: keyword.trim() || undefined } });
  const [loadError, setLoadError] = useState<unknown>(null);
  const [renameTarget, setRenameTarget] = useState<TreeNodeDto | null>(null);
  const [moveTarget, setMoveTarget] = useState<TreeNodeDto | null>(null);
  const [moveParentId, setMoveParentId] = useState<number | null>(null);
  const [renameForm] = Form.useForm<{ name: string }>();

  const load = async () => {
    try { setLoadError(null); const data = await api.get<{ tree: TreeNodeDto[] }>(`/${kind}/tree`); setNodes(data.tree); }
    catch (e) { setLoadError(e); setNodes(null); }
  };
  useEffect(() => { void load(); }, [kind]);

  const invalidate = () => { void load(); qc.invalidateQueries({ queryKey: ['tree', kind] }); };

  const create = useMutation({
    mutationFn: (v: NodeFormValues) => api.post(`/${kind}`, { parentId: parent?.id ?? null, ...v }),
    onSuccess: () => { message.success('创建成功'); setModalOpen(false); invalidate(); },
    onError: (e) => message.error(errorText(e)),
  });

  const update = useMutation({
    mutationFn: ({ id, ...v }: { id: number; name?: string; sortOrder?: number }) => api.patch(`/${kind}/${id}`, v),
    onSuccess: () => { message.success('已保存'); invalidate(); },
    onError: (e) => message.error(errorText(e)),
  });

  const move = useMutation({
    mutationFn: ({ id, parentId }: { id: number; parentId: number | null }) => api.post(`/${kind}/${id}/move`, { parentId }),
    onSuccess: () => { message.success('已移动'); invalidate(); },
    onError: (e) => message.error(errorText(e)),
  });

  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: number; status: string }) => api.post(`/${kind}/${id}/status`, { status }),
    onSuccess: () => { message.success('已更新状态'); invalidate(); },
    onError: (e) => message.error(errorText(e)),
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.del(`/${kind}/${id}`),
    onSuccess: () => { message.success('已删除'); invalidate(); },
    onError: (e) => message.error(errorText(e)),
  });

  const flatNodes: TreeNodeDto[] = [];
  const flatten = (list: TreeNodeDto[]) => { for (const n of list) { flatNodes.push(n); flatten(n.children); } };
  if (nodes) flatten(nodes);
  /* 关键字过滤:编码/名称/路径命中即显示(路径命中可保留上下文) */
  const kw = keyword.trim().toLowerCase();
  const visibleNodes = kw
    ? flatNodes.filter((n) => n.code.toLowerCase().includes(kw) || n.name.toLowerCase().includes(kw) || n.path.toLowerCase().includes(kw))
    : flatNodes;

  return (
    /* 无壳 + 无标题:调用方传的 title(如「组织管理」)与侧栏菜单项同名,顶栏已显示一遍 */
    <Card
      className="bd-root-card"
      extra={
        <Space wrap>
          <Input
            prefix={<i className="ri-search-line" aria-hidden />}
            placeholder={kind === 'org' ? '组织编码/名称搜索' : '科目编码/名称搜索'}
            style={{ width: 190 }}
            allowClear
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
          <Button icon={<i className="ri-shield-check-line" aria-hidden />} onClick={async () => {
            try {
              const r = await api.get<{ ok: boolean; problems: string[]; issues?: { code: string; severity: string; message: string }[] }>(checkPath);
              setCheckResult(r);
              if (r.ok) message.success('结构检查通过');
              else modal.error({
                title: '结构检查发现问题',
                content: (
                  <div>
                    {(r.issues ?? r.problems.map((p) => ({ code: '', severity: 'blocking', message: p }))).map((issue, i) => (
                      <div key={i} style={{ marginBottom: 4 }}>
                        <Tag color={issue.severity === 'blocking' ? 'red' : 'orange'}>{issue.severity === 'blocking' ? '阻塞' : '提醒'}</Tag>
                        {issue.code && <Tag>{issue.code}</Tag>}
                        {issue.message}
                      </div>
                    ))}
                  </div>
                ),
              });
            } catch (e) {
              message.error(`结构检查失败:${errorText(e)}`);
            }
          }}>结构检查</Button>
          <MasterDataHealthTrigger
            onLocateOrg={kind === 'org' ? (id) => {
              const target = flatNodes.find((n) => n.id === id);
              if (target) setKeyword(target.code);
            } : undefined}
            onLocateAccount={kind === 'account' ? (id) => {
              const target = flatNodes.find((n) => n.id === id);
              if (target) setKeyword(target.code);
            } : undefined}
          />
          <Button type="primary" icon={<i className="ri-add-line" aria-hidden />} onClick={() => { setParent(null); form.resetFields(); setModalOpen(true); }}>
            新增根节点
          </Button>
        </Space>
      }
    >
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        编码全局唯一且不可变;停用只影响新增引用,存量数据保留并继续参与汇总;被业务数据引用的节点不可删除。
      </Typography.Paragraph>
      {loadError ? (
        <Result status="error" title="树结构加载失败" subTitle={errorText(loadError)} extra={<Button onClick={() => void load()}>重试</Button>} />
      ) : !nodes || flatNodes.length === 0 ? (
        <Empty description="暂无数据,请先建立树结构" />
      ) : visibleNodes.length === 0 ? (
        <Empty description="没有匹配的节点" />
      ) : (
        <List
          dataSource={visibleNodes}
          renderItem={(n) => {
            const depth = n.path.split(' / ').length - 1;
            return (
              <List.Item
                actions={[
                  <Button key="rename" size="small" onClick={() => {
                    renameForm.setFieldsValue({ name: n.name }); setRenameTarget(n);
                  }}>改名</Button>,
                  <Button key="move" size="small" onClick={() => {
                    setMoveTarget(n); setMoveParentId(null);
                  }}>移动</Button>,
                  <Button key="toggle" size="small" onClick={() => setStatus.mutate({ id: n.id, status: n.status === 'active' ? 'inactive' : 'active' })}>
                    {n.status === 'active' ? '停用' : '启用'}
                  </Button>,
                  <Button key="add" size="small" onClick={() => {
                    setParent(n);
                    form.resetFields();
                    if (kind === 'account') form.setFieldValue('type', n.type);
                    if (kind === 'account' && n.type === 'quantity') form.setFieldValue('unit', n.unit);
                    setModalOpen(true);
                  }}>新增下级</Button>,
                  <Popconfirm key="del" title="确定删除?被业务数据引用的节点不可删除" onConfirm={() => remove.mutate(n.id)}>
                    <Button size="small" danger>删除</Button>
                  </Popconfirm>,
                ]}
              >
                <Space size={8} style={{ marginLeft: depth * 28 }}>
                  <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{n.code}</span>
                  <span>{n.name}</span>
                  {n.type && <Tag color={n.type === 'income' ? 'green' : n.type === 'cost' ? 'orange' : n.type === 'expense' ? 'red' : 'purple'}>{n.type === 'income' ? '收入' : n.type === 'cost' ? '成本' : n.type === 'expense' ? '费用' : '数量'}</Tag>}
                  {n.type === 'quantity' && n.unit && <Tag color="purple">{n.unit}</Tag>}
                  {n.status === 'inactive' ? <Tag>已停用</Tag> : null}
                  {!n.isLeaf && <Tag color="blue">汇总</Tag>}
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>{n.path}</Typography.Text>
                </Space>
              </List.Item>
            );
          }}
        />
      )}

      <Modal
        title={`新增${kind === 'org' ? '组织' : '科目'}${parent ? ` — 上级:${parent.code} ${parent.name}` : '(根节点)'}`}
        open={modalOpen}
        onCancel={() => setModalOpen(false)}
        onOk={() => form.validateFields().then((v) => create.mutate(v))}
        confirmLoading={create.isPending}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="code" label="编码(全局唯一,创建后不可变)" rules={[{ required: true }]}>
            <Input placeholder="如 ORG001 / I01" />
          </Form.Item>
          <Form.Item name="name" label="名称" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
          {kind === 'account' && (
            <Form.Item noStyle shouldUpdate={(prev, cur) => prev.type !== cur.type}>
              {({ getFieldValue }) => (
                <>
                  <Form.Item name="type" label="科目类型" rules={[{ required: true }]}>
                    <Select
                      placeholder="选择类型"
                      disabled={!!parent}
                      options={[
                        { value: 'income', label: '收入' },
                        { value: 'cost', label: '成本' },
                        { value: 'expense', label: '费用' },
                        { value: 'quantity', label: '数量(非金额指标)' },
                      ]}
                    />
                  </Form.Item>
                  {getFieldValue('type') === 'quantity' && (
                    <>
                      <Form.Item name="unit" label="计量单位(数量型科目必填,如 万度 / 元/度 / % / 人)" rules={[{ required: true }]}>
                        <Input placeholder="万度" />
                      </Form.Item>
                      <Form.Item name="quantityAgg" label="数量汇总方式" initialValue="sum" extra="可加总(如电量、人数):上级组织/科目显示合计;不汇总(如电价、税率、平均人数):仅叶子录值">
                        <Select
                          options={[
                            { value: 'sum', label: '可加总(沿组织/科目上级求和)' },
                            { value: 'none', label: '不汇总(仅叶子值)' },
                          ]}
                        />
                      </Form.Item>
                    </>
                  )}
                </>
              )}
            </Form.Item>
          )}
          {kind === 'account' && parent && (
            <Typography.Text type="secondary">子科目类型自动继承父科目类型</Typography.Text>
          )}
          <Form.Item name="sortOrder" label="同级排序" initialValue={0}>
            <InputNumber style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>
      <Modal title={`修改名称: ${renameTarget?.code ?? ''}`} open={!!renameTarget} onCancel={() => setRenameTarget(null)} confirmLoading={update.isPending} onOk={() => renameForm.validateFields().then(v => { if (renameTarget && v.name !== renameTarget.name) update.mutate({ id: renameTarget.id, name: v.name }, { onSuccess: () => setRenameTarget(null) }); })}>
        <Form form={renameForm} layout="vertical"><Form.Item name="name" label="名称" rules={[{ required: true }]}><Input /></Form.Item></Form>
      </Modal>
      <Modal title={`移动节点: ${moveTarget?.code ?? ''}`} open={!!moveTarget} onCancel={() => setMoveTarget(null)} confirmLoading={move.isPending} onOk={() => { if (moveTarget) move.mutate({ id: moveTarget.id, parentId: moveParentId }, { onSuccess: () => setMoveTarget(null) }); }}>
        <TreeSelect style={{ width: '100%' }} treeData={nodes ?? []} fieldNames={{ label: 'name', value: 'id', children: 'children' }} treeNodeFilterProp="name" showSearch allowClear value={moveParentId ?? undefined} onChange={(v) => setMoveParentId((v as number | undefined) ?? null)} placeholder="选择目标父节点(不选则移动到根)" />
      </Modal>
    </Card>
  );
}
