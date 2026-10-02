import { useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, Card, Space, Button, Modal, Form, Input, InputNumber, Select, Popconfirm, App, Tag, Empty, Typography, List, TreeSelect, Switch } from 'antd';
import { EnhancedTable as Table } from '../components/EnhancedTable';
import { api, ApiError } from '../api/client';
import { errorText } from '../components/TreeNodePage';
import { QueryErrorResult } from '../components/QueryErrorResult';
import { MasterDataHealthTrigger } from '../components/MasterDataHealth';
import { PROFIT_ROWS, SHEET_METRIC_ROWS, useSheets } from '../utils/sheets';
import { useAssistantPageContext } from '../assistant/contextHooks';

/**
 * 科目管理:先选表格(预设表,可自助增删改),再在表格范围内做科目增删改查。
 * 「全部科目」为完整树;每张预设表只显示其根科目子树(管理视图不折叠,便于维护)。
 * 新增根科目默认不属于任何表格,可在表格维护中把它加入某张表。
 */

interface TreeNodeDto {
  id: number;
  parentId: number | null;
  code: string;
  name: string;
  type?: string;
  unit?: string;
  quantityAgg?: string;
  budgetRequired?: boolean;
  basisRequired?: boolean;
  sortOrder: number;
  status: string;
  children: TreeNodeDto[];
  path: string;
  isLeaf: boolean;
}
interface TreeRow {
  id: number;
  parent_id: number | null;
  code: string;
  name: string;
  type?: string;
  unit?: string;
  quantity_agg?: string;
  budget_required?: 0 | 1;
  basis_required?: 0 | 1;
  status: string;
}
interface SheetDto {
  id: number;
  code: string;
  name: string;
  rootCodes: string[];
  collapsedCodes: string[];
  sortOrder: number;
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
interface SheetFormValues {
  code?: string;
  name: string;
  rootCodes: string[];
  collapsedCodes?: string[];
  sortOrder?: number;
}
interface MetricItem {
  id: number;
  code: string;
  name: string;
  terms: { source_type: string; source_account_id: number | null; source_metric_id: number | null; coefficient: number }[];
}

export default function AccountManage() {
  const qc = useQueryClient();
  const { message, modal } = App.useApp();
  const [scopeKey, setScopeKey] = useState<string>('profit');
  const [keyword, setKeyword] = useState('');

  /* 财务助手页面登记(§7.2 account)：报表归属筛选与搜索。 */
  useAssistantPageContext({ pageKey: 'account', ready: true, scope: {}, view: { scopeKey, search: keyword.trim() || undefined } });
  const [nodeModalOpen, setNodeModalOpen] = useState(false);
  const [parent, setParent] = useState<TreeNodeDto | null>(null);
  const [form] = Form.useForm<NodeFormValues>();
  const [sheetModalOpen, setSheetModalOpen] = useState(false);
  const [editingSheet, setEditingSheet] = useState<SheetDto | null>(null);
  const [sheetForm] = Form.useForm<SheetFormValues>();
  const [checkResult, setCheckResult] = useState<{ ok: boolean; problems: string[] } | null>(null);

  /* 改名与移动 Modal 状态(替代 window.prompt) */
  const [renameTarget, setRenameTarget] = useState<TreeNodeDto | null>(null);
  const [renameForm] = Form.useForm<{ name: string; sortOrder?: number; budgetRequired?: boolean; basisRequired?: boolean }>();
  const [moveTarget, setMoveTarget] = useState<TreeNodeDto | null>(null);
  const [moveParentId, setMoveParentId] = useState<number | null>(null);

  const { data, error: treeError, refetch: refetchTree } = useQuery({ queryKey: ['tree', 'account'], queryFn: () => api.get<{ tree: TreeNodeDto[]; rows: TreeRow[] }>('/account/tree') });
  const { sheets, loading: sheetsLoading, refresh: refreshSheets } = useSheets();
  const { data: metricsData, error: metricsError, refetch: refetchMetrics } = useQuery({ queryKey: ['metrics'], queryFn: () => api.get<{ items: MetricItem[] }>('/metrics') });

  const invalidate = () => { qc.invalidateQueries({ queryKey: ['tree', 'account'] }); };

  const flatNodes: TreeNodeDto[] = [];
  const flatten = (list: TreeNodeDto[]) => { for (const n of list) { flatNodes.push(n); flatten(n.children); } };
  if (data) flatten(data.tree);
  const byCode = useMemo(() => new Map(flatNodes.map((n) => [n.code, n])), [data]);

  /** 当前表格范围内的扁平节点(每张表从其根科目展开,管理视图不折叠) */
  const scopedNodes = useMemo(() => {
    const out: { node: TreeNodeDto; depth: number }[] = [];
    const walk = (n: TreeNodeDto, depth: number) => {
      out.push({ node: n, depth });
      n.children.forEach((c) => walk(c, depth + 1));
    };
    const sheet = sheets.find((s) => s.key === scopeKey);
    if (scopeKey === 'all' || !sheet) {
      (data?.tree ?? []).forEach((n) => walk(n, 0));
    } else {
      for (const code of sheet.roots) {
        const root = byCode.get(code);
        if (root) walk(root, 0);
      }
    }
    return out;
  }, [scopeKey, sheets, data, byCode]);

  const kw = keyword.trim().toLowerCase();
  const visibleNodes = kw
    ? scopedNodes.filter(({ node }) => node.code.toLowerCase().includes(kw) || node.name.toLowerCase().includes(kw) || node.path.toLowerCase().includes(kw))
    : scopedNodes;

  /* ---------- 科目 CRUD ---------- */
  const create = useMutation({
    mutationFn: (v: NodeFormValues) => api.post('/account', { parentId: parent?.id ?? null, ...v }),
    onSuccess: () => { message.success('创建成功'); setNodeModalOpen(false); invalidate(); },
    onError: (e) => message.error(errorText(e)),
  });
  const update = useMutation({
    mutationFn: ({ id, ...v }: { id: number; name?: string; sortOrder?: number; budgetRequired?: boolean; basisRequired?: boolean }) => api.patch(`/account/${id}`, v),
    onSuccess: () => { message.success('已保存'); invalidate(); },
    onError: (e) => message.error(errorText(e)),
  });
  const move = useMutation({
    mutationFn: ({ id, parentId }: { id: number; parentId: number | null }) => api.post(`/account/${id}/move`, { parentId }),
    onSuccess: () => { message.success('已移动'); invalidate(); },
    onError: (e) => message.error(errorText(e)),
  });
  const setStatus = useMutation({
    mutationFn: ({ id, status }: { id: number; status: string }) => api.post(`/account/${id}/status`, { status }),
    onSuccess: () => { message.success('已更新状态'); invalidate(); },
    onError: (e) => message.error(errorText(e)),
  });
  const remove = useMutation({
    mutationFn: (id: number) => api.del(`/account/${id}`),
    onSuccess: () => { message.success('已删除'); invalidate(); },
    onError: (e) => message.error(errorText(e)),
  });

  /* ---------- 表格 CRUD ---------- */
  const openSheetModal = (s: SheetDto | null) => {
    setEditingSheet(s);
    sheetForm.resetFields();
    sheetForm.setFieldsValue({
      code: s?.code,
      name: s?.name ?? '',
      rootCodes: s?.rootCodes ?? [],
      collapsedCodes: s?.collapsedCodes ?? [],
      sortOrder: s?.sortOrder ?? (sheets.length + 1),
    });
    setSheetModalOpen(true);
  };
  const saveSheet = useMutation({
    mutationFn: (v: SheetFormValues) =>
      editingSheet
        ? api.patch(`/sheets/${editingSheet.id}`, { name: v.name, rootCodes: v.rootCodes, collapsedCodes: v.collapsedCodes ?? [], sortOrder: v.sortOrder })
        : api.post('/sheets', { code: v.code, name: v.name, rootCodes: v.rootCodes, collapsedCodes: v.collapsedCodes ?? [], sortOrder: v.sortOrder }),
    onSuccess: () => { message.success('表格已保存'); setSheetModalOpen(false); refreshSheets(); },
    onError: (e) => message.error(errorText(e)),
  });
  const removeSheet = useMutation({
    mutationFn: (id: number) => api.del(`/sheets/${id}`),
    onSuccess: () => { message.success('表格已删除'); setScopeKey('all'); refreshSheets(); },
    onError: (e) => message.error(errorText(e)),
  });

  const currentSheetDto = sheets.find((s) => s.key === scopeKey);

  /** 从 /api/sheets 取当前表格的原始记录(含数据库 id),用于编辑/删除 */
  const fetchRawSheet = async (code: string): Promise<SheetDto | undefined> => {
    const r = await api.get<{ items: SheetDto[] }>('/sheets');
    return r.items.find((x) => x.code === code);
  };

  const accountOptions = flatNodes.map((n) => ({ value: n.code, label: `${n.code} ${n.name}` }));

  /** 移动目标树:排除当前节点及其全部子孙节点 */
  const moveTreeData = useMemo(() => {
    if (!moveTarget || !data) return [];
    const forbidden = new Set<number>();
    const mark = (n: TreeNodeDto) => { forbidden.add(n.id); n.children.forEach(mark); };
    mark(moveTarget);
    interface TreeItem { value: number; title: string; disabled?: boolean; children: TreeItem[] }
    const build = (nodes: TreeNodeDto[]): TreeItem[] =>
      nodes
        .filter((n) => !forbidden.has(n.id))
        .map((n) => ({
          value: n.id,
          title: `${n.code} ${n.name} (${n.type ?? 'expense'})`,
          disabled: n.type !== moveTarget.type, // 同父类型必须一致
          children: build(n.children),
        }));
    return build(data.tree);
  }, [moveTarget, data]);

  if (treeError) {
    /* 科目树是本页全部内容的前提,失败时显示错误而不是空管理表 */
    return (
      <Card className="newfc-root-card">
        <QueryErrorResult title="科目树加载失败" error={treeError} refetch={() => void refetchTree()} />
      </Card>
    );
  }

  return (
    /* 无壳 + 无标题:顶栏已显示「科目」,Card title 是重复的第二遍 */
    <Card
      className="newfc-root-card"
      extra={
        <Space wrap>
          <Input
            prefix={<i className="ri-search-line" aria-hidden />}
            placeholder="科目编码/名称搜索"
            style={{ width: 180 }}
            allowClear
            value={keyword}
            onChange={(e) => setKeyword(e.target.value)}
          />
          <Button icon={<i className="ri-shield-check-line" aria-hidden />} onClick={async () => {
            try {
              const r = await api.get<{ ok: boolean; problems: string[]; issues?: { code: string; severity: string; message: string }[] }>('/account/check');
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
            onLocateAccount={(id) => {
              const target = flatNodes.find((n) => n.id === id);
              if (target) { setScopeKey('all'); setKeyword(target.code); }
            }}
          />
        </Space>
      }
    >
      <Space wrap style={{ marginBottom: 8 }}>
        <Typography.Text type="secondary">表格:</Typography.Text>
        <Select
          style={{ width: 190 }}
          loading={sheetsLoading}
          value={scopeKey}
          onChange={setScopeKey}
          options={[
            { value: 'profit', label: '利润表' },
            { value: 'all', label: '全部科目(完整树)' },
            ...sheets.map((s) => ({ value: s.key, label: s.name })),
          ]}
        />
        <Button icon={<i className="ri-add-line" aria-hidden />} onClick={() => openSheetModal(null)}>新增表格</Button>
        {currentSheetDto && (
          <>
            <Button onClick={async () => {
              try {
                const raw = await fetchRawSheet(scopeKey);
                if (raw) openSheetModal(raw);
                else message.warning('未找到该表格定义,可能已被删除,请刷新后重试');
              } catch (e) { message.error(`读取表格定义失败:${errorText(e)}`); }
            }}>编辑当前表格</Button>
            <Popconfirm title="删除该表格定义?(不影响科目本身)" onConfirm={async () => {
              try {
                const raw = await fetchRawSheet(scopeKey);
                if (raw) removeSheet.mutate(raw.id);
                else message.warning('未找到该表格定义,可能已被删除,请刷新后重试');
              } catch (e) { message.error(`读取表格定义失败:${errorText(e)}`); }
            }}>
              <Button danger>删除当前表格</Button>
            </Popconfirm>
          </>
        )}
        {scopeKey === 'all' && (
          <Button type="primary" icon={<i className="ri-add-line" aria-hidden />} onClick={() => { setParent(null); form.resetFields(); setNodeModalOpen(true); }}>
            新增根科目
          </Button>
        )}
      </Space>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
        先选表格,再在范围内维护科目。套表原则:利润表最粗(模板 15 行,由科目自动勾稽)、收入成本表次之、各明细表最细;下级有专属明细表的科目,上级表只列汇总行(在「折叠科目」中配置)——例如收入成本表只显示管理费用一行,明细在管理费用表。
        {scopeKey === 'profit'
          ? ' 当前为利润表行结构(只读):一~五小计行按指标公式自动计算(公式在「报表指标管理」维护),其中/加/减行取对应科目子树汇总。'
          : scopeKey === 'all'
            ? ' 当前为完整树;新增根科目默认不属于任何表格,建后可在「编辑表格」中纳入。'
            : ` 当前表格:${currentSheetDto?.name};根科目 ${currentSheetDto?.roots.join('、') || '无'};折叠 ${currentSheetDto?.collapsed?.join('、') || '无'}。${
                SHEET_METRIC_ROWS[scopeKey]
                  ? `计算行(自动勾稽,编制/历史视图按模板位置插入):${SHEET_METRIC_ROWS[scopeKey].map((d) => `${d.label}(${d.metricCode})`).join('、')}。`
                  : ''
              }`}
        编码全局唯一且不可变;停用只影响新增引用;被业务数据引用的科目不可删除。
      </Typography.Paragraph>
      {metricsError && (
        <Alert type="error" showIcon style={{ marginBottom: 8 }} message="报表指标加载失败,利润表行的公式展示不可用" action={<Button size="small" onClick={() => void refetchMetrics()}>重试</Button>} />
      )}

      {scopeKey === 'profit' ? (() => {
        const kw = keyword.trim().toLowerCase();
        const metricByCode = new Map((metricsData?.items ?? []).map((m) => [m.code, m]));
        const formulaOf = (m: MetricItem) =>
          m.terms.map((t) => {
            const sign = t.coefficient === -1 ? '− ' : '+ ';
            if (t.source_type === 'account') {
              const a = flatNodes.find((x) => x.id === t.source_account_id);
              return `${sign}${a ? `${a.code} ${a.name}` : `#${t.source_account_id}`}`;
            }
            const target = (metricsData?.items ?? []).find((x) => x.id === t.source_metric_id);
            return `${sign}${target ? `${target.code} ${target.name}` : `#${t.source_metric_id}`}`;
          }).join(' ');
        interface ProfitViewRow {
          key: string; line: number; kind: 'metric' | 'account'; code: string; label: string;
          indent: number; bold: boolean; ref?: unknown;
        }
        const dataSource: ProfitViewRow[] = PROFIT_ROWS.map((pr, i): ProfitViewRow => {
          if (pr.kind === 'metric') {
            const m = metricByCode.get(pr.code);
            return { key: pr.code, line: i + 1, kind: pr.kind, code: pr.code, label: pr.label, indent: pr.indent, bold: pr.bold, ref: m };
          }
          const a = byCode.get(pr.code);
          return { key: pr.code, line: i + 1, kind: pr.kind, code: pr.code, label: pr.label, indent: pr.indent, bold: pr.bold, ref: a };
        }).filter((r) => {
          const acc = r.kind === 'account' ? byCode.get(r.code) : undefined;
          const text = `${r.code} ${r.label} ${acc?.name ?? ''}`;
          return !kw || text.toLowerCase().includes(kw);
        });
        return (
          <>
            <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginTop: 0 }}>
              与预算模板「利润表」sheet 逐行对应(共 15 行):小计行(一~五)为报表指标自动计算,取数行(其中/加/减)取对应科目子树的带符号汇总。
              模板"资产减值损失"行对应科目 C4「信用减值损失（处置损益）」;P06 总成本为管理口径（不含增值税）,不在法定利润表行内展示。
            </Typography.Paragraph>
            <Table
              size="small"
              pagination={false}
              dataSource={dataSource}
              columns={[
                { title: '行次', dataIndex: 'line', width: 60 },
                {
                  title: '项目(模板行)', dataIndex: 'label',
                  render: (label: string, r: ProfitViewRow) => (
                    <span style={{ marginLeft: r.indent * 22, fontWeight: r.bold ? 700 : 400 }}>{label}</span>
                  ),
                },
                {
                  title: '行类型', width: 90,
                  render: (_: unknown, r: ProfitViewRow) => (r.kind === 'metric' ? <Tag color="blue">计算行</Tag> : <Tag color="green">取数行</Tag>),
                },
                { title: '编码', dataIndex: 'code', width: 70, render: (c: string) => <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{c}</span> },
                {
                  title: '取数来源(自动勾稽)',
                  render: (_: unknown, r: ProfitViewRow) => {
                    if (r.kind === 'metric') {
                      const m = r.ref as MetricItem | undefined;
                      return m ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>指标公式:{formulaOf(m)}</Typography.Text> : <Typography.Text type="danger">指标 {r.code} 未定义,请到「报表指标管理」创建</Typography.Text>;
                    }
                    const a = r.ref as TreeNodeDto | undefined;
                    return a
                      ? <Typography.Text type="secondary" style={{ fontSize: 12 }}>科目子树汇总:{a.code} {a.name}(含全部下级明细)</Typography.Text>
                      : <Typography.Text type="danger">科目 {r.code} 不存在</Typography.Text>;
                  },
                },
              ]}
            />
          </>
        );
      })() : !data || flatNodes.length === 0 ? (
        <Empty description="暂无数据,请先建立科目" />
      ) : visibleNodes.length === 0 ? (
        <Empty description="当前表格/搜索条件下没有科目" />
      ) : (
        <List
          dataSource={visibleNodes}
          renderItem={({ node: n, depth }) => (
            <List.Item
              actions={[
                <Button key="rename" size="small" onClick={() => {
                  setRenameTarget(n);
                  renameForm.resetFields();
                  renameForm.setFieldsValue({
                    name: n.name,
                    sortOrder: n.sortOrder,
                    budgetRequired: n.isLeaf ? n.budgetRequired : false,
                    basisRequired: n.isLeaf ? n.basisRequired : false,
                  });
                }}>改名/排序</Button>,
                <Button key="move" size="small" onClick={() => {
                  setMoveTarget(n);
                  setMoveParentId(n.parentId);
                }}>移动</Button>,
                <Button key="toggle" size="small" onClick={() => setStatus.mutate({ id: n.id, status: n.status === 'active' ? 'inactive' : 'active' })}>
                  {n.status === 'active' ? '停用' : '启用'}
                </Button>,
                <Button key="add" size="small" onClick={() => {
                  setParent(n);
                  form.resetFields();
                  form.setFieldValue('type', n.type);
                  if (n.type === 'quantity') form.setFieldValue('unit', n.unit);
                  setNodeModalOpen(true);
                }}>新增下级</Button>,
                <Popconfirm key="del" title="确定删除?被业务数据引用的科目不可删除" onConfirm={() => remove.mutate(n.id)}>
                  <Button size="small" danger>删除</Button>
                </Popconfirm>,
              ]}
            >
              <Space size={8} style={{ marginLeft: depth * 24 }}>
                <span style={{ fontFamily: 'monospace', fontWeight: 600 }}>{n.code}</span>
                <span>{n.name}</span>
                {n.type && (
                  <Tag color={n.type === 'income' ? 'green' : n.type === 'cost' ? 'orange' : n.type === 'expense' ? 'red' : 'purple'}>
                    {n.type === 'income' ? '收入' : n.type === 'cost' ? '成本' : n.type === 'expense' ? '费用' : '数量'}
                  </Tag>
                )}
                {n.type === 'quantity' && n.unit && <Tag color="purple">{n.unit}</Tag>}
                {n.status === 'inactive' ? <Tag>已停用</Tag> : null}
                {n.budgetRequired && <Tag color="red">预算必填</Tag>}
                {n.basisRequired && <Tag color="orange">需测算依据</Tag>}
                {!n.isLeaf && <Tag color="blue">汇总</Tag>}
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>{n.path}</Typography.Text>
              </Space>
            </List.Item>
          )}
        />
      )}
      {checkResult && !checkResult.ok && (
        <Typography.Paragraph type="warning" style={{ fontSize: 12 }}>{checkResult.problems.join(';')}</Typography.Paragraph>
      )}

      {/* 新增科目 */}
      <Modal
        title={`新增科目${parent ? ` — 上级:${parent.code} ${parent.name}` : '(根科目)'}`}
        open={nodeModalOpen}
        onCancel={() => setNodeModalOpen(false)}
        onOk={() => form.validateFields().then((v) => create.mutate(v))}
        confirmLoading={create.isPending}
      >
        <Form form={form} layout="vertical">
          <Form.Item name="code" label="编码(全局唯一,创建后不可变)" rules={[{ required: true }]}>
            <Input placeholder="如 I1201 / E2025 / Q101" />
          </Form.Item>
          <Form.Item name="name" label="名称" rules={[{ required: true }]}>
            <Input />
          </Form.Item>
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
                    <Form.Item name="unit" label="计量单位(如 万度 / 元/度 / % / 人)" rules={[{ required: true }]}>
                      <Input placeholder="万度" />
                    </Form.Item>
                    <Form.Item name="quantityAgg" label="数量汇总方式" initialValue="sum" extra="可加总:上级组织/科目显示合计;不汇总(电价/税率/平均人数):仅叶子录值">
                      <Select
                        options={[
                          { value: 'sum', label: '可加总(沿上级求和)' },
                          { value: 'none', label: '不汇总(仅叶子值)' },
                        ]}
                      />
                    </Form.Item>
                  </>
                )}
              </>
            )}
          </Form.Item>
          <Form.Item name="sortOrder" label="同级排序" initialValue={0}>
            <InputNumber style={{ width: '100%' }} />
          </Form.Item>
        </Form>
      </Modal>

      {/* 新增/编辑表格 */}
      <Modal
        title={<Space><i className="ri-table-2" aria-hidden />{editingSheet ? `编辑表格 ${editingSheet.code}` : '新增表格'}</Space>}
        open={sheetModalOpen}
        onCancel={() => setSheetModalOpen(false)}
        onOk={() => sheetForm.validateFields().then((v) => saveSheet.mutate(v))}
        confirmLoading={saveSheet.isPending}
        width={620}
      >
        <Form form={sheetForm} layout="vertical">
          <Space size={16} style={{ display: 'flex' }}>
            <Form.Item name="code" label="表格编码(唯一,创建后不可改)" rules={[{ required: true }]} style={{ width: 200 }}>
              <Input disabled={!!editingSheet} placeholder="如 sales_view" />
            </Form.Item>
            <Form.Item name="name" label="表格名称" rules={[{ required: true }]} style={{ width: 220 }}>
              <Input placeholder="如 销售费用表" />
            </Form.Item>
            <Form.Item name="sortOrder" label="排序" initialValue={1}>
              <InputNumber />
            </Form.Item>
          </Space>
          <Form.Item name="rootCodes" label="根科目(可多选,表格范围=这些科目的子树)" rules={[{ required: true, message: '至少选择一个根科目' }]}>
            <Select mode="multiple" showSearch optionFilterProp="label" options={accountOptions} placeholder="选择一个或多个科目编码" />
          </Form.Item>
          <Form.Item
            name="collapsedCodes"
            label="折叠科目(可选:这些科目在本表只显示一行汇总,明细在专属表录入)"
            extra="例:收入成本表折叠 非电产业收入/非电产业成本/管理费用"
          >
            <Select mode="multiple" showSearch optionFilterProp="label" options={accountOptions} placeholder="留空则全部展开" />
          </Form.Item>
        </Form>
      </Modal>

      {/* 改名与排序 Modal */}
      <Modal
        title={renameTarget ? `修改科目: ${renameTarget.code} (${renameTarget.name})` : '修改科目'}
        open={!!renameTarget}
        onCancel={() => setRenameTarget(null)}
        onOk={() => renameForm.validateFields().then((v) => {
          if (renameTarget) update.mutate({
            id: renameTarget.id,
            name: v.name,
            sortOrder: v.sortOrder,
            budgetRequired: renameTarget.isLeaf ? v.budgetRequired : false,
            basisRequired: renameTarget.isLeaf ? v.basisRequired : false,
          }, { onSuccess: () => setRenameTarget(null) });
        })}
        confirmLoading={update.isPending}
      >
        <Form form={renameForm} layout="vertical">
          <Form.Item name="name" label="科目名称" rules={[{ required: true }]}>
            <Input placeholder="输入科目名称" />
          </Form.Item>
          <Form.Item name="sortOrder" label="同级排序">
            <InputNumber style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="budgetRequired" label="预算/预测必填" valuePropName="checked" extra={renameTarget?.isLeaf ? '启用后，新建版本会将此要求固化进科目树快照；适用叶子组织未填时不能定稿。' : '仅末级科目可以设置此要求。'}>
            <Switch disabled={!renameTarget?.isLeaf} />
          </Form.Item>
          <Form.Item name="basisRequired" label="有值时必须填写测算依据" valuePropName="checked" extra={!renameTarget?.isLeaf ? '仅末级科目可以设置此要求。' : undefined}>
            <Switch disabled={!renameTarget?.isLeaf} />
          </Form.Item>
        </Form>
      </Modal>

      {/* 移动科目 Modal(TreeSelect) */}
      <Modal
        title={moveTarget ? `移动科目: ${moveTarget.code} ${moveTarget.name}` : '移动科目'}
        open={!!moveTarget}
        onCancel={() => setMoveTarget(null)}
        onOk={() => {
          if (moveTarget) move.mutate({ id: moveTarget.id, parentId: moveParentId }, { onSuccess: () => setMoveTarget(null) });
        }}
        confirmLoading={move.isPending}
      >
        <Typography.Paragraph type="secondary" style={{ fontSize: 12 }}>
          选择目标父科目(留空表示移为根科目)。同父节点的科目类型必须一致;不可移至自身或其子孙节点下。
        </Typography.Paragraph>
        <TreeSelect
          style={{ width: '100%' }}
          treeData={moveTreeData}
          value={moveParentId ?? undefined}
          allowClear
          placeholder="留空移为根科目"
          treeDefaultExpandAll
          onChange={(val) => setMoveParentId((val as number | null) ?? null)}
        />
      </Modal>
    </Card>
  );
}
