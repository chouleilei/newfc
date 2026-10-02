import { useEffect, useMemo, useState } from 'react';
import { useQuery, useMutation, useQueryClient } from '@tanstack/react-query';
import { Card, Button, Modal, Form, Input, InputNumber, Select, Space, App, Tag, Popconfirm, Tooltip, Typography, TreeSelect, Result, Alert, Grid } from 'antd';
import { EnhancedTable as Table } from '../components/EnhancedTable';
import { api } from '../api/client';
import { errorText } from '../components/TreeNodePage';
import { useAssistantPageContext } from '../assistant/contextHooks';

type MetricKind = 'linear' | 'ratio';
type MetricDirection = 'higher_better' | 'lower_better';
type MetricDisplayFormat = 'percent' | 'number';
type TermRole = 'term' | 'numerator' | 'denominator';

interface Term {
  id?: number;
  sourceType: 'account' | 'metric';
  sourceAccountId?: number | null;
  sourceMetricId?: number | null;
  coefficient: 1 | -1;
  sortOrder?: number;
  role?: TermRole;
}

/** 后端返回的公式项(snake_case) */
interface TermRow {
  id: number;
  metric_id: number;
  source_type: 'account' | 'metric';
  source_account_id: number | null;
  source_metric_id: number | null;
  coefficient: 1 | -1;
  sort_order: number;
  role: TermRole;
}

interface Metric {
  id: number;
  code: string;
  name: string;
  display_order: number;
  status: string;
  kind: MetricKind;
  direction: MetricDirection;
  display_format: MetricDisplayFormat;
  unit: string;
  display_sign: 1 | -1;
  terms: TermRow[];
  referencesDisabledAccount?: boolean;
}

interface AccountRow { id: number; code: string; name: string; type?: string; status: string; parent_id: number | null; quantity_agg?: string }

/** 表单值:比率与线性共用一个 Modal,比率用 numerator/denominator 两个独立字段 */
interface MetricFormValues {
  code?: string;
  name: string;
  displayOrder: number;
  kind: MetricKind;
  direction?: MetricDirection;
  displayFormat?: MetricDisplayFormat;
  unit?: string;
  displaySign?: 1 | -1;
  terms?: Term[];
  numerator?: Term;
  denominator?: Term;
}

export default function MetricManage() {
  const qc = useQueryClient();
  const { message } = App.useApp();
  const screens = Grid.useBreakpoint();
  /** 窄屏收窄按钮文案:卡片头部 title + extra 是不换行的 flex,两个长按钮会把整页撑出横向滚动 */
  const compactActions = screens.sm === false;
  const [editOpen, setEditOpen] = useState(false);
  const [editing, setEditing] = useState<Metric | null>(null);
  const [form] = Form.useForm<MetricFormValues>();

  const { data: metrics, error: metricsError, refetch: refetchMetrics } = useQuery({ queryKey: ['metrics'], queryFn: () => api.get<{ items: Metric[] }>('/metrics') });

  /* 财务助手页面登记(§7.2 metric)：指标列表。 */
  useAssistantPageContext({ pageKey: 'metric', ready: metrics != null && !metricsError, readyState: metrics == null && !metricsError ? 'loading' : 'error', notReadyReason: metricsError ? '指标列表读取失败' : '正在读取指标列表', scope: {}, view: {} });
  const { data: accountTree } = useQuery({ queryKey: ['tree', 'account'], queryFn: () => api.get<{ rows: AccountRow[] }>('/account/tree') });
  const { data: metricList } = useQuery({ queryKey: ['metrics-plain'], queryFn: () => api.get<{ items: Metric[] }>('/metrics') });

  const flatAccounts: AccountRow[] = accountTree?.rows ?? [];

  interface TreeItem { value: number; title: string; children: TreeItem[]; selectable?: boolean }
  /** 把扁平科目行拼成选择树;不可选的祖先仍需保留以维持层级 */
  const buildAccountTree = (rows: AccountRow[], selectable: (row: AccountRow) => boolean): TreeItem[] => {
    const byId = new Map<number, TreeItem>();
    rows.forEach((r) => byId.set(r.id, {
      value: r.id,
      title: `${r.code} ${r.name}${r.status === 'inactive' ? '(停用)' : ''}`,
      children: [],
      selectable: selectable(r),
    }));
    const roots: TreeItem[] = [];
    rows.forEach((r) => {
      const node = byId.get(r.id)!;
      const parent = r.parent_id != null ? byId.get(r.parent_id) : undefined;
      if (parent) parent.children.push(node);
      else roots.push(node);
    });
    return roots;
  };

  /** 金额科目树:线性公式项与比率的金额侧用(排除数量型) */
  const moneyAccountTreeData = useMemo(
    () => buildAccountTree((accountTree?.rows ?? []).filter((a) => a.type !== 'quantity'), () => true),
    [accountTree],
  );

  /**
   * 比率可选科目树:金额科目 + 可累计的数量科目。
   * quantity_agg='none' 的单价/税率类科目不可选 —— 它们没有跨组织的合计值。
   */
  const ratioAccountTreeData = useMemo(
    () => buildAccountTree(
      accountTree?.rows ?? [],
      (row) => row.type !== 'quantity' || row.quantity_agg === 'sum',
    ),
    [accountTree],
  );

  /** 比率侧可引用的指标:只有金额型(线性),比率不能被引用 */
  const linearMetricOptions = useMemo(
    () => (metricList?.items ?? [])
      .filter((x) => x.kind !== 'ratio' && x.id !== editing?.id)
      .map((x) => ({ value: x.id, label: `${x.code} ${x.name}` })),
    [metricList, editing],
  );

  const save = useMutation({
    mutationFn: (payload: MetricFormValues) => {
      const kind = payload.kind ?? 'linear';
      const terms: Term[] = kind === 'ratio'
        ? [
            { ...payload.numerator!, role: 'numerator', sortOrder: 0 },
            { ...payload.denominator!, role: 'denominator', sortOrder: 1 },
          ]
        : (payload.terms ?? []).map((t, i) => ({ ...t, role: 'term', sortOrder: i }));
      const body = {
        name: payload.name,
        displayOrder: payload.displayOrder,
        kind,
        direction: kind === 'ratio' ? payload.direction ?? 'higher_better' : 'higher_better',
        displayFormat: kind === 'ratio' ? payload.displayFormat ?? 'percent' : 'percent',
        unit: kind === 'ratio' && payload.displayFormat === 'number' ? payload.unit ?? '' : '',
        displaySign: kind === 'linear' ? payload.displaySign ?? 1 : 1,
        terms,
      };
      return editing ? api.patch(`/metrics/${editing.id}`, body) : api.post('/metrics', { code: payload.code, ...body });
    },
    onSuccess: () => { message.success('已保存'); setEditOpen(false); qc.invalidateQueries({ queryKey: ['metrics'] }); qc.invalidateQueries({ queryKey: ['metrics-plain'] }); },
    onError: (e) => message.error(errorText(e)),
  });

  const remove = useMutation({
    mutationFn: (id: number) => api.del(`/metrics/${id}`),
    onSuccess: () => { message.success('已删除'); qc.invalidateQueries({ queryKey: ['metrics'] }); qc.invalidateQueries({ queryKey: ['metrics-plain'] }); },
    onError: (e) => message.error(errorText(e)),
  });

  const termOf = (m: Metric, role: TermRole): Term | undefined => {
    const t = m.terms.find((x) => x.role === role);
    if (!t) return undefined;
    return {
      sourceType: t.source_type,
      sourceAccountId: t.source_account_id ?? undefined,
      sourceMetricId: t.source_metric_id ?? undefined,
      coefficient: t.coefficient,
    };
  };

  const openEdit = (m: Metric | null, kind: MetricKind = 'linear') => {
    setEditing(m);
    form.resetFields();
    const effectiveKind = m?.kind ?? kind;
    form.setFieldsValue({
      code: m?.code,
      name: m?.name,
      displayOrder: m?.display_order ?? 0,
      kind: effectiveKind,
      direction: m?.direction ?? 'higher_better',
      displayFormat: m?.display_format ?? 'percent',
      unit: m?.unit ?? '',
      displaySign: m?.display_sign ?? 1,
      terms: effectiveKind === 'ratio'
        ? undefined
        : m
          ? m.terms.filter((t) => t.role === 'term').map((t) => ({
              sourceType: t.source_type,
              sourceAccountId: t.source_account_id ?? undefined,
              sourceMetricId: t.source_metric_id ?? undefined,
              coefficient: t.coefficient,
            }))
          : [{ sourceType: 'account', coefficient: 1 }],
      numerator: effectiveKind === 'ratio'
        ? (m ? termOf(m, 'numerator') : { sourceType: 'account', coefficient: 1 }) ?? { sourceType: 'account', coefficient: 1 }
        : undefined,
      denominator: effectiveKind === 'ratio'
        ? (m ? termOf(m, 'denominator') : { sourceType: 'account', coefficient: 1 }) ?? { sourceType: 'account', coefficient: 1 }
        : undefined,
    });
    setEditOpen(true);
  };

  useEffect(() => { void metricList; }, [metricList]);

  const sourceText = (t: TermRow | Term): string => {
    const sourceType = 'source_type' in t ? t.source_type : t.sourceType;
    if (sourceType === 'account') {
      const id = 'source_account_id' in t ? t.source_account_id : t.sourceAccountId;
      const a = flatAccounts.find((x) => x.id === id);
      return `科目[${a ? `${a.code} ${a.name}` : id}]`;
    }
    const id = 'source_metric_id' in t ? t.source_metric_id : t.sourceMetricId;
    const target = (metricList?.items ?? []).find((x) => x.id === id);
    return `指标[${target ? `${target.code} ${target.name}` : id}]`;
  };

  const formulaText = (m: Metric) => {
    if (m.kind === 'ratio') {
      const side = (role: TermRole) => {
        const t = m.terms.find((x) => x.role === role);
        if (!t) return '(未配置)';
        return `${t.coefficient === -1 ? '−' : ''}${sourceText(t)}`;
      };
      return `${side('numerator')} ÷ ${side('denominator')}`;
    }
    return m.terms
      .filter((t) => t.role === 'term')
      .map((t) => `${t.coefficient === -1 ? '− ' : '+ '}${sourceText(t)}`)
      .join(' ');
  };

  /** 某一侧的来源选择器(比率用),按类型在科目树/指标下拉之间切换 */
  const sideFields = (name: 'numerator' | 'denominator', label: string) => (
    <Form.Item label={label} required style={{ marginBottom: 8 }}>
      <Space align="start" wrap>
        <Form.Item name={[name, 'sourceType']} noStyle rules={[{ required: true }]}>
          <Select style={{ width: 100 }} options={[{ value: 'account', label: '科目' }, { value: 'metric', label: '指标' }]} />
        </Form.Item>
        <Form.Item noStyle shouldUpdate>
          {({ getFieldValue }) => (getFieldValue([name, 'sourceType']) === 'metric' ? (
            <Form.Item name={[name, 'sourceMetricId']} noStyle rules={[{ required: true, message: `选择${label}指标` }]}>
              <Select style={{ width: 300 }} showSearch optionFilterProp="label" options={linearMetricOptions} placeholder="选择金额型指标" />
            </Form.Item>
          ) : (
            <Form.Item name={[name, 'sourceAccountId']} noStyle rules={[{ required: true, message: `选择${label}科目` }]}>
              <TreeSelect
                style={{ width: 300 }}
                treeData={ratioAccountTreeData}
                showSearch
                treeNodeFilterProp="title"
                treeDefaultExpandAll
                allowClear
                placeholder="金额科目或可累计数量科目"
              />
            </Form.Item>
          ))}
        </Form.Item>
        <Form.Item name={[name, 'coefficient']} noStyle rules={[{ required: true }]}>
          <Select
            style={{ width: 150 }}
            options={[{ value: 1, label: '按原符号' }, { value: -1, label: '取反(成本/费用)' }]}
          />
        </Form.Item>
      </Space>
    </Form.Item>
  );

  return (
    /* 无壳 + 无标题:顶栏已显示「指标」,Card title 是重复的第二遍 */
    <Card
      className="newfc-root-card"
      extra={(
        <Space size={4}>
          <Button icon={<i className="ri-add-line" aria-hidden />} onClick={() => openEdit(null, 'ratio')}>
            {compactActions ? '比率' : '新建比率指标'}
          </Button>
          <Button type="primary" icon={<i className="ri-add-line" aria-hidden />} onClick={() => openEdit(null, 'linear')}>
            {compactActions ? '金额' : '新建金额指标'}
          </Button>
        </Space>
      )}
    >
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
        <b>金额型指标</b>为利润方向(越大越有利),公式是科目节点与其他金额指标的线性组合(系数 ±1);成本费用已是负数,公式项直接相加。
        <br />
        <b>比率型指标</b>是分子 ÷ 分母(如毛利率、费用率、度电成本),自带有利方向。两侧各自可选「取反」把成本费用读成正数。
        比率<b>不可加总</b>:任何汇总行都由后端「先汇总分子分母再相除」重算;分母为 0 时显示「不适用」,不显示 0。
        比率不能被其他指标引用,也不参与利润表小计与财务勾稽。保存时自动做循环引用检测。
      </Typography.Paragraph>
      {metricsError ? <Result status="error" title="指标加载失败" subTitle={metricsError instanceof Error ? metricsError.message : String(metricsError)} extra={<Button onClick={() => void refetchMetrics()}>重试</Button>} /> : <Table
        rowKey="id"
        tableKey="metric-list"
        loading={!metrics}
        dataSource={metrics?.items ?? []}
        scroll={{ x: 1320 }}
        columns={[
          { title: '编码', dataIndex: 'code', width: 100 },
          { title: '名称', dataIndex: 'name', width: 140 },
          {
            title: '类型', dataIndex: 'kind', width: 90,
            render: (k: MetricKind) => (k === 'ratio' ? <Tag color="geekblue">比率</Tag> : <Tag color="blue">金额</Tag>),
          },
          {
            title: '有利方向', key: 'direction', width: 100,
            render: (_, m: Metric) => (m.kind !== 'ratio'
              ? <Typography.Text type="secondary">利润方向</Typography.Text>
              : m.direction === 'lower_better' ? <Tag color="orange">越低越好</Tag> : <Tag color="green">越高越好</Tag>),
          },
          {
            title: '单位', key: 'unit', width: 85,
            render: (_, m: Metric) => (m.kind !== 'ratio' ? '万元' : m.display_format === 'percent' ? '百分比' : m.unit || '自然单位'),
          },
          {
            title: '金额展示', key: 'displaySign', width: 100,
            render: (_, m: Metric) => (m.kind === 'ratio' ? '-' : m.display_sign === -1 ? '业务正数' : '利润方向'),
          },
          { title: '显示顺序', dataIndex: 'display_order', width: 85 },
          {
            title: '状态', dataIndex: 'status', width: 80,
            render: (s: string) => (s === 'active' ? <Tag color="green">启用</Tag> : <Tag>停用</Tag>),
          },
          {
            title: '公式',
            key: 'formula',
            width: 380,
            render: (_, m: Metric) => {
              const text = formulaText(m);
              return (
                <Space size={6} style={{ maxWidth: '100%' }}>
                  <Tooltip title={text}>
                    <Typography.Text
                      style={{
                        display: 'inline-block',
                        maxWidth: m.referencesDisabledAccount ? 240 : 360,
                        overflow: 'hidden',
                        textOverflow: 'ellipsis',
                        whiteSpace: 'nowrap',
                        verticalAlign: 'bottom',
                      }}
                    >
                      {text}
                    </Typography.Text>
                  </Tooltip>
                  {m.referencesDisabledAccount && <Tag color="orange">引用了停用科目</Tag>}
                </Space>
              );
            },
          },
          {
            title: '操作', key: 'actions', width: 160,
            render: (_, m: Metric) => (
              <Space>
                <Button size="small" onClick={() => openEdit(m)}>编辑</Button>
                <Popconfirm
                  title="确定删除该指标?"
                  description="删除后利润表小计行与引用该指标的其他指标将失去取数来源;被引用的指标不可删除。"
                  okText="删除"
                  okButtonProps={{ danger: true }}
                  onConfirm={() => remove.mutate(m.id)}
                >
                  <Button size="small" danger disabled={(metrics?.items ?? []).some((x) => x.terms.some((t) => t.source_type === 'metric' && t.source_metric_id === m.id))}>
                    删除
                  </Button>
                </Popconfirm>
              </Space>
            ),
          },
        ]}
      />}

      <Modal
        title={editing ? `编辑指标 ${editing.code}` : '新建指标'}
        open={editOpen}
        onCancel={() => setEditOpen(false)}
        onOk={() => form.validateFields().then((v) => save.mutate(v))}
        confirmLoading={save.isPending}
        width={720}
      >
        <Form form={form} layout="vertical">
          <Space size={16} style={{ display: 'flex' }} wrap>
            <Form.Item name="code" label="指标编码" rules={[{ required: true }]} style={{ width: 160 }}>
              <Input disabled={!!editing} />
            </Form.Item>
            <Form.Item name="name" label="指标名称" rules={[{ required: true }]} style={{ width: 200 }}>
              <Input />
            </Form.Item>
            <Form.Item name="kind" label="指标类型" rules={[{ required: true }]} style={{ width: 130 }}>
              <Select options={[{ value: 'linear', label: '金额(线性)' }, { value: 'ratio', label: '比率' }]} />
            </Form.Item>
            <Form.Item name="displayOrder" label="显示顺序" initialValue={0}>
              <InputNumber />
            </Form.Item>
          </Space>

          <Form.Item noStyle shouldUpdate={(prev, next) => prev.kind !== next.kind}>
            {({ getFieldValue }) => (getFieldValue('kind') === 'ratio' ? (
              <>
                {editing && editing.kind !== 'ratio' && (
                  <Alert
                    type="warning"
                    showIcon
                    style={{ marginBottom: 12 }}
                    message="正在把金额指标改为比率指标"
                    description="比率不能被其他指标引用;若该指标已被引用,保存会被拒绝。定稿版本读取的是固化快照,不受本次修改影响。"
                  />
                )}
                <Space size={16} style={{ display: 'flex' }} wrap>
                  <Form.Item name="direction" label="有利方向" rules={[{ required: true }]} style={{ width: 160 }}>
                    <Select options={[{ value: 'higher_better', label: '越高越好' }, { value: 'lower_better', label: '越低越好' }]} />
                  </Form.Item>
                  <Form.Item name="displayFormat" label="展示格式" rules={[{ required: true }]} style={{ width: 160 }}>
                    <Select options={[{ value: 'percent', label: '百分比' }, { value: 'number', label: '自然单位数值' }]} />
                  </Form.Item>
                  <Form.Item noStyle shouldUpdate={(prev, next) => prev.displayFormat !== next.displayFormat}>
                    {({ getFieldValue: get }) => (get('displayFormat') === 'number' ? (
                      <Form.Item
                        name="unit"
                        label="计量单位"
                        style={{ width: 200 }}
                        rules={[{ required: true, message: '请登记单位' }]}
                        tooltip="比率的自然单位 = 元 ÷ 分母科目的计量单位。例如分母是「上网电量(万度)」时,单位为「元/万度」。系统不做单位换算。"
                      >
                        <Input placeholder="如 元/万度" />
                      </Form.Item>
                    ) : null)}
                  </Form.Item>
                </Space>
                {sideFields('numerator', '分子')}
                {sideFields('denominator', '分母')}
                <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                  分母只能选金额科目、金额型指标,或<b>汇总方式为「可加总」的数量科目</b>;单价、税率等不可汇总的数量科目没有范围合计值,不能作为比率的任一侧。
                </Typography.Text>
              </>
            ) : (
              <>
              <Form.Item
                name="displaySign"
                label="完成率展示口径"
                style={{ width: 260 }}
                tooltip="成本/费用合计类指标可选「业务正数」。存储值和差异仍保持利润方向。"
              >
                <Select options={[{ value: 1, label: '利润方向' }, { value: -1, label: '业务正数（成本/费用）' }]} />
              </Form.Item>
              <Form.List name="terms">
                {(fields, { add, remove }) => (
                  <>
                    {fields.map((field) => (
                      <Space key={field.key} align="baseline" style={{ display: 'flex', marginBottom: 4 }}>
                        <Form.Item name={[field.name, 'sourceType']} noStyle rules={[{ required: true }]}>
                          <Select style={{ width: 100 }} options={[{ value: 'account', label: '科目' }, { value: 'metric', label: '指标' }]} />
                        </Form.Item>
                        <Form.Item noStyle shouldUpdate>
                          {({ getFieldValue: get }) => {
                            const st = get(['terms', field.name, 'sourceType']);
                            return st === 'metric' ? (
                              <Form.Item name={[field.name, 'sourceMetricId']} noStyle rules={[{ required: true, message: '选择指标' }]}>
                                <Select style={{ width: 220 }} showSearch optionFilterProp="label" options={linearMetricOptions} />
                              </Form.Item>
                            ) : (
                              <Form.Item name={[field.name, 'sourceAccountId']} noStyle rules={[{ required: true, message: '选择科目' }]}>
                                <TreeSelect
                                  style={{ width: 340 }}
                                  treeData={moneyAccountTreeData}
                                  showSearch
                                  treeNodeFilterProp="title"
                                  treeDefaultExpandAll
                                  allowClear
                                  placeholder="选择科目(金额科目,任意层级)"
                                />
                              </Form.Item>
                            );
                          }}
                        </Form.Item>
                        <Form.Item name={[field.name, 'coefficient']} noStyle rules={[{ required: true }]}>
                          <Select style={{ width: 80 }} options={[{ value: 1, label: '+1' }, { value: -1, label: '-1' }]} />
                        </Form.Item>
                        <Button size="small" onClick={() => remove(field.name)}>删除项</Button>
                      </Space>
                    ))}
                    <Button type="dashed" onClick={() => add({ sourceType: 'account', coefficient: 1 })} style={{ width: '100%' }}>
                      添加公式项
                    </Button>
                  </>
                )}
              </Form.List>
              </>
            ))}
          </Form.Item>
        </Form>
      </Modal>
    </Card>
  );
}
