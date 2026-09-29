import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App as AntdApp, Button, Col, Drawer, Empty, Form, Input, Modal, Row, Select, Space, Table, Tag, TreeSelect, Typography } from 'antd';
import { can, errorText } from '../../api/client';
import { mgmtApi } from '../../api/mgmt';
import type {
  MaCalcRunDto, MaCalculator, MaDimensionDto, MaMemberPreviewDto, MaMemberType, MaMetricDto, MaMetricParams, MaSnapshotDto, MaThresholds, StatementMetricCode,
} from '../../api/financeData';
import { QueryErrorResult } from '../../components/QueryErrorResult';
import { formatByUnit } from '../../utils/decimal';
import { shortTime } from '../../utils/relativeTime';
import { getSession } from '../../api/client';
import { lastPeriod, OrgSelect, PeriodPicker, useOrgTree } from '../financeData/shared';

/** 管理会计:维度、指标与计算、多维分析。 */

export const CALCULATOR_LABEL: Record<MaCalculator, string> = {
  budget_amount: '预算金额(当前采用预算)', actual_amount: '实际金额(年度最新实际)', execution_rate: '预算执行率',
  eas_balance: 'EAS 科目余额(当前集合)', statement_item: '财报语义指标(当前批次)', allocated_cost: '已确认分摊成本',
};
const MEMBER_TYPE_LABEL: Record<MaMemberType, string> = { org: '组织', project: '项目', account: '科目', custom: '自定义' };
const EAS_FIELDS = ['end_net', 'end_debit', 'end_credit', 'period_debit', 'period_credit'] as const;
const EAS_FIELD_LABEL: Record<(typeof EAS_FIELDS)[number], string> = { end_net: '期末净额', end_debit: '期末借方', end_credit: '期末贷方', period_debit: '本期借方', period_credit: '本期贷方' };
const STATEMENT_KEYS: StatementMetricCode[] = [
  'total_assets_period_end', 'total_liabilities_period_end', 'owner_equity_period_end', 'revenue_ytd', 'cost_ytd', 'operating_profit_ytd',
  'total_profit_ytd', 'net_profit_ytd', 'operating_cash_flow_ytd', 'cash_ending_ytd',
];
const THRESHOLD_FIELDS: { key: keyof MaThresholds; label: string }[] = [
  { key: 'upperWarning', label: '上限·警告' }, { key: 'upperCritical', label: '上限·严重' },
  { key: 'lowerWarning', label: '下限·警告' }, { key: 'lowerCritical', label: '下限·严重' },
  { key: 'deviationWarning', label: '偏差比例·警告' }, { key: 'deviationCritical', label: '偏差比例·严重' },
];
const SNAPSHOT_STATUS: Record<string, { text: string; color: string }> = { valid: { text: '有效', color: 'success' }, unavailable: { text: '不可用', color: 'default' }, invalidated: { text: '已作废', color: 'error' } };

export const allOrgsUser = () => getSession()?.user.allOrgs ?? false;

export function useMetrics(status?: string) {
  return useQuery({ queryKey: ['ma-metrics', status], queryFn: () => mgmtApi.metrics(status) });
}

export function paramsText(p: MaMetricParams): string {
  switch (p.calculator) {
    case 'budget_amount': case 'actual_amount': case 'execution_rate': return `科目 ${p.accountCode}`;
    case 'eas_balance': return `科目 ${p.accountCode} · ${EAS_FIELD_LABEL[p.field]}`;
    case 'statement_item': return `${p.metricKey}${p.scope ? ` · ${p.scope}` : ''}`;
    default: return '—';
  }
}

export function SnapshotValue({ s }: { s: Pick<MaSnapshotDto, 'value' | 'unit' | 'status' | 'reasons'> }) {
  if (s.value == null) return <Typography.Text type="secondary" title={s.reasons.map((r) => r.message).join(';')}>不可用</Typography.Text>;
  return <span style={{ fontVariantNumeric: 'tabular-nums', textDecoration: s.status === 'invalidated' ? 'line-through' : undefined }}>{formatByUnit(s.value, s.unit)}</span>;
}

export function SnapshotTable({ rows, loading }: { rows: MaSnapshotDto[]; loading?: boolean }) {
  return (
    <Table<MaSnapshotDto>
      size="small" rowKey="id" loading={loading} dataSource={rows} pagination={rows.length > 20 ? { pageSize: 20, showSizeChanger: false } : false}
      columns={[
        { title: '指标', dataIndex: 'metricName' },
        { title: '组织', dataIndex: 'orgName', width: 150 },
        { title: '期间', dataIndex: 'period', width: 90 },
        { title: '值', width: 150, align: 'right', render: (_: unknown, s) => <SnapshotValue s={s} /> },
        { title: '对比预算', dataIndex: 'compareValue', width: 130, align: 'right', render: (v: string | null) => (v == null ? '' : formatByUnit(v, 'money')) },
        { title: '状态', dataIndex: 'status', width: 80, render: (v: string) => <Tag color={SNAPSHOT_STATUS[v].color}>{SNAPSHOT_STATUS[v].text}</Tag> },
        {
          title: '原因/来源', ellipsis: true, render: (_: unknown, s) => (s.status === 'unavailable'
            ? s.reasons.map((r) => `${r.code}: ${r.message}`).join(';')
            : s.invalidatedReason ?? Object.entries(s.evidence).filter(([, v]) => typeof v !== 'object').map(([k, v]) => `${k}=${String(v)}`).join(' ')),
        },
      ]}
    />
  );
}

/* ---------------- 维度 ---------------- */

function parseMemberLines(text: string): { code: string; name?: string; refCode?: string }[] {
  return text.split(/\r?\n/).map((l) => l.trim()).filter(Boolean).map((l) => {
    const [code, name, refCode] = l.split(/[,\t,]/).map((x) => x.trim());
    return { code, ...(name ? { name } : {}), ...(refCode ? { refCode } : {}) };
  });
}

function DimensionDrawer({ dim, onClose }: { dim: MaDimensionDto | null; onClose: () => void }) {
  const { message } = AntdApp.useApp();
  const qc = useQueryClient();
  const [text, setText] = useState('');
  const [preview, setPreview] = useState<MaMemberPreviewDto | null>(null);
  const q = useQuery({ queryKey: ['ma-dimension', dim?.id], queryFn: () => mgmtApi.dimension(dim!.id), enabled: !!dim });
  const members = () => parseMemberLines(text);
  const doPreview = useMutation({ mutationFn: () => mgmtApi.previewMembers(dim!.id, { members: members() }), onSuccess: setPreview, onError: (e) => message.error(errorText(e)) });
  const confirm = useMutation({
    mutationFn: () => mgmtApi.confirmMembers(dim!.id, { members: members(), previewHash: preview!.previewHash }),
    onSuccess: (r) => { message.success(`已新增 ${r.created} 个成员`); setPreview(null); setText(''); void qc.invalidateQueries({ queryKey: ['ma-dimension'] }); void qc.invalidateQueries({ queryKey: ['ma-dimensions'] }); },
    onError: (e) => message.error(errorText(e)),
  });
  const writable = can('mgmt:write') && allOrgsUser();
  return (
    <Drawer open={!!dim} onClose={() => { setPreview(null); setText(''); onClose(); }} width={820} title={dim ? `${dim.name}(${dim.code})· ${MEMBER_TYPE_LABEL[dim.memberType]}维度` : ''} destroyOnClose>
      {writable && (
        <div style={{ marginBottom: 16 }}>
          <Typography.Text type="secondary">
            每行一个成员:编码,名称,引用编码{dim?.memberType === 'custom' ? '(自定义维度无需引用)' : `(引用${MEMBER_TYPE_LABEL[dim?.memberType ?? 'custom']}主数据编码,须存在、启用且在授权范围内)`}
          </Typography.Text>
          <Input.TextArea rows={5} value={text} onChange={(e) => { setText(e.target.value); setPreview(null); }} placeholder={'EAST,华东,EAST\nSH,上海,SH'} style={{ marginTop: 6 }} />
          <Space style={{ marginTop: 8 }}>
            <Button onClick={() => doPreview.mutate()} disabled={!text.trim()} loading={doPreview.isPending}>预览映射</Button>
            <Button type="primary" disabled={!preview?.valid} loading={confirm.isPending} onClick={() => confirm.mutate()}>确认写入</Button>
            {preview && <Typography.Text type="secondary">新增 {preview.createCount} · 不变 {preview.unchangedCount} · 错误 {preview.errorCount}</Typography.Text>}
          </Space>
          {preview && (
            <Table
              size="small" rowKey="row" pagination={false} dataSource={preview.rows} style={{ marginTop: 8 }}
              columns={[
                { title: '行', dataIndex: 'row', width: 50 }, { title: '编码', dataIndex: 'code', width: 120 }, { title: '名称', dataIndex: 'name' },
                { title: '引用', width: 180, render: (_: unknown, r) => (r.refName ? `${r.refName}(${r.refCode})` : r.refCode ?? '') },
                { title: '动作', dataIndex: 'action', width: 80, render: (v: string) => <Tag color={v === 'error' ? 'error' : v === 'create' ? 'processing' : 'default'}>{v === 'create' ? '新增' : v === 'error' ? '错误' : '不变'}</Tag> },
                { title: '说明', dataIndex: 'message' },
              ]}
            />
          )}
        </div>
      )}
      {q.error ? <QueryErrorResult title="维度加载失败" error={q.error} refetch={q.refetch} /> : (
        <Table
          size="small" rowKey="id" loading={q.isLoading} dataSource={q.data?.members ?? []} pagination={{ pageSize: 20, showSizeChanger: false }}
          columns={[
            { title: '编码', dataIndex: 'code', width: 140 }, { title: '名称', dataIndex: 'name' },
            { title: '引用', dataIndex: 'refCode', width: 140 }, { title: '创建', dataIndex: 'createdAt', width: 130, render: (v: string) => shortTime(v) },
          ]}
        />
      )}
    </Drawer>
  );
}

export function DimensionsTab() {
  const { message } = AntdApp.useApp();
  const qc = useQueryClient();
  const [open, setOpen] = useState<MaDimensionDto | null>(null);
  const [creating, setCreating] = useState(false);
  const [form] = Form.useForm<{ code: string; name: string; memberType: MaMemberType }>();
  const list = useQuery({ queryKey: ['ma-dimensions'], queryFn: () => mgmtApi.dimensions() });
  const create = useMutation({
    mutationFn: (v: { code: string; name: string; memberType: MaMemberType }) => mgmtApi.createDimension(v),
    onSuccess: () => { message.success('已创建'); setCreating(false); void qc.invalidateQueries({ queryKey: ['ma-dimensions'] }); }, onError: (e) => message.error(errorText(e)),
  });
  const toggle = useMutation({
    mutationFn: (d: MaDimensionDto) => mgmtApi.updateDimension(d.id, { expectedVersion: d.version, status: d.status === 'active' ? 'inactive' : 'active' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['ma-dimensions'] }), onError: (e) => message.error(errorText(e)),
  });
  const writable = can('mgmt:write') && allOrgsUser();
  if (list.error) return <QueryErrorResult title="维度加载失败" error={list.error} refetch={list.refetch} />;
  return (
    <>
      {writable && <Button type="primary" style={{ marginBottom: 12 }} onClick={() => { form.resetFields(); setCreating(true); }}>新建维度</Button>}
      <Table<MaDimensionDto>
        size="small" rowKey="id" loading={list.isLoading} dataSource={list.data ?? []} pagination={false}
        columns={[
          { title: '编码', dataIndex: 'code', width: 140 }, { title: '名称', dataIndex: 'name' },
          { title: '成员类型', dataIndex: 'memberType', width: 100, render: (v: MaMemberType) => MEMBER_TYPE_LABEL[v] },
          { title: '成员数', dataIndex: 'memberCount', width: 80, align: 'right' },
          { title: '状态', dataIndex: 'status', width: 80, render: (v: string) => (v === 'active' ? <Tag color="success">启用</Tag> : <Tag>停用</Tag>) },
          {
            title: '操作', width: 140, render: (_: unknown, d) => (
              <Space><a onClick={() => setOpen(d)}>成员</a>{writable && <a onClick={() => toggle.mutate(d)}>{d.status === 'active' ? '停用' : '启用'}</a>}</Space>
            ),
          },
        ]}
      />
      <Modal open={creating} title="新建维度" onCancel={() => setCreating(false)} confirmLoading={create.isPending} destroyOnClose onOk={() => form.validateFields().then((v) => create.mutate(v))}>
        <Form form={form} layout="vertical" preserve={false} initialValues={{ memberType: 'org' }}>
          <Form.Item name="code" label="编码" rules={[{ required: true, pattern: /^[A-Za-z][A-Za-z0-9_-]{0,31}$/, message: '字母开头,1～32 位' }]}><Input /></Form.Item>
          <Form.Item name="name" label="名称" rules={[{ required: true, whitespace: true }]}><Input maxLength={100} /></Form.Item>
          <Form.Item name="memberType" label="成员类型"><Select options={Object.entries(MEMBER_TYPE_LABEL).map(([value, label]) => ({ value, label }))} /></Form.Item>
        </Form>
      </Modal>
      <DimensionDrawer dim={open} onClose={() => setOpen(null)} />
    </>
  );
}

/* ---------------- 指标与计算 ---------------- */

interface MetricForm {
  code: string; name: string; calculator: MaCalculator; accountCode?: string; field?: (typeof EAS_FIELDS)[number]; metricKey?: StatementMetricCode; scope?: string;
  thresholds?: Partial<Record<keyof MaThresholds, string>>;
}

function toParams(v: MetricForm): MaMetricParams {
  switch (v.calculator) {
    case 'eas_balance': return { calculator: 'eas_balance', accountCode: v.accountCode!, field: v.field ?? 'end_net' };
    case 'statement_item': return { calculator: 'statement_item', metricKey: v.metricKey!, ...(v.scope ? { scope: v.scope as 'consolidated' } : {}) };
    case 'allocated_cost': return { calculator: 'allocated_cost' };
    default: return { calculator: v.calculator, accountCode: v.accountCode! } as MaMetricParams;
  }
}

function MetricModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { message } = AntdApp.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm<MetricForm>();
  const calculator = Form.useWatch('calculator', form);
  const create = useMutation({
    mutationFn: (v: MetricForm) => mgmtApi.createMetric({
      code: v.code, name: v.name, params: toParams(v),
      thresholds: Object.fromEntries(Object.entries(v.thresholds ?? {}).filter(([, x]) => x != null && String(x).trim() !== '').map(([k, x]) => [k, String(x).trim()])),
    }),
    onSuccess: () => { message.success('指标已创建'); onClose(); void qc.invalidateQueries({ queryKey: ['ma-metrics'] }); }, onError: (e) => message.error(errorText(e)),
  });
  return (
    <Modal open={open} title="新建指标" width={640} onCancel={onClose} confirmLoading={create.isPending} destroyOnClose onOk={() => form.validateFields().then((v) => create.mutate(v))}>
      <Form form={form} layout="vertical" preserve={false} initialValues={{ calculator: 'actual_amount', field: 'end_net' }}>
        <Row gutter={12}>
          <Col span={10}><Form.Item name="code" label="编码" rules={[{ required: true, pattern: /^[A-Za-z][A-Za-z0-9_-]{0,31}$/, message: '字母开头,1～32 位' }]}><Input /></Form.Item></Col>
          <Col span={14}><Form.Item name="name" label="名称" rules={[{ required: true, whitespace: true }]}><Input maxLength={100} /></Form.Item></Col>
        </Row>
        <Form.Item name="calculator" label="计算器"><Select options={Object.entries(CALCULATOR_LABEL).map(([value, label]) => ({ value, label }))} /></Form.Item>
        {calculator && ['budget_amount', 'actual_amount', 'execution_rate', 'eas_balance'].includes(calculator) && (
          <Form.Item name="accountCode" label={calculator === 'eas_balance' ? 'EAS 科目编码' : '预算科目编码(含下级汇总)'} rules={[{ required: true, whitespace: true }]}><Input /></Form.Item>
        )}
        {calculator === 'eas_balance' && <Form.Item name="field" label="余额字段"><Select options={EAS_FIELDS.map((f) => ({ value: f, label: EAS_FIELD_LABEL[f] }))} /></Form.Item>}
        {calculator === 'statement_item' && (
          <Row gutter={12}>
            <Col span={14}><Form.Item name="metricKey" label="财报语义指标" rules={[{ required: true }]}><Select options={STATEMENT_KEYS.map((k) => ({ value: k, label: k }))} /></Form.Item></Col>
            <Col span={10}><Form.Item name="scope" label="口径(缺省合并优先)"><Select allowClear options={[{ value: 'consolidated', label: '合并' }, { value: 'parent', label: '母公司' }, { value: 'subsidiary', label: '子公司' }]} /></Form.Item></Col>
          </Row>
        )}
        <Typography.Text type="secondary">阈值(可选):金额指标填元,比率指标填 0～1;偏差比例 = (实际 − 预算)/|预算|,仅实际金额指标适用。</Typography.Text>
        <Row gutter={12} style={{ marginTop: 8 }}>
          {THRESHOLD_FIELDS.map((t) => (
            <Col span={8} key={t.key}>
              <Form.Item name={['thresholds', t.key]} label={t.label} rules={[{ pattern: /^-?\d{1,12}(\.\d{1,6})?$/, message: '最多 6 位小数' }]}><Input /></Form.Item>
            </Col>
          ))}
        </Row>
      </Form>
    </Modal>
  );
}

function CalcRunModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: (r: MaCalcRunDto) => void }) {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<{ period: string; metricIds?: number[]; orgIds?: number[] }>();
  const metrics = useMetrics('active');
  const { treeData } = useOrgTree();
  const run = useMutation({
    mutationFn: (v: { period: string; metricIds?: number[]; orgIds?: number[] }) => mgmtApi.createCalcRun({
      period: v.period, ...(v.metricIds?.length ? { metricIds: v.metricIds } : {}), ...(v.orgIds?.length ? { orgIds: v.orgIds } : {}),
    }),
    onSuccess: (r) => { message.success(`计算完成:${r.snapshotCount} 个快照,其中不可用 ${r.unavailableCount}`); onDone(r); onClose(); },
    onError: (e) => message.error(errorText(e)),
  });
  return (
    <Modal open={open} title="运行指标计算" onCancel={onClose} confirmLoading={run.isPending} destroyOnClose onOk={() => form.validateFields().then((v) => run.mutate(v))}>
      <Form form={form} layout="vertical" preserve={false} initialValues={{ period: lastPeriod() }}>
        <Form.Item name="period" label="期间" rules={[{ required: true }]}><PeriodPicker onChange={(v) => form.setFieldValue('period', v)} allowClear={false} /></Form.Item>
        <Form.Item name="metricIds" label="指标(缺省全部启用指标)">
          <Select mode="multiple" allowClear options={(metrics.data ?? []).map((m) => ({ value: m.id, label: `${m.name}(${m.code})` }))} optionFilterProp="label" />
        </Form.Item>
        <Form.Item name="orgIds" label="组织(缺省全部授权组织)">
          <TreeSelect multiple treeData={treeData} treeDefaultExpandAll allowClear showSearch treeNodeFilterProp="title" />
        </Form.Item>
      </Form>
      <Typography.Text type="secondary">缺少来源的组织/指标写入“不可用”快照并列出原因,不当作 0;全部不可用时不写入。</Typography.Text>
    </Modal>
  );
}

export function MetricsTab() {
  const { message } = AntdApp.useApp();
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [running, setRunning] = useState(false);
  const [period, setPeriod] = useState<string | undefined>();
  const [runDetail, setRunDetail] = useState<number | null>(null);
  const metrics = useMetrics();
  const runs = useQuery({ queryKey: ['ma-calc-runs', period], queryFn: () => mgmtApi.calcRuns({ period }) });
  const detail = useQuery({ queryKey: ['ma-calc-run', runDetail], queryFn: () => mgmtApi.calcRun(runDetail!), enabled: runDetail != null });
  const toggle = useMutation({
    mutationFn: (m: MaMetricDto) => mgmtApi.updateMetric(m.id, { expectedVersion: m.version, status: m.status === 'active' ? 'inactive' : 'active' }),
    onSuccess: () => void qc.invalidateQueries({ queryKey: ['ma-metrics'] }), onError: (e) => message.error(errorText(e)),
  });
  const scan = useMutation({
    mutationFn: (runId: number) => mgmtApi.scanAlerts(runId),
    onSuccess: (r) => { message.success(`预警扫描:新增 ${r.created},更新 ${r.updated},未变 ${r.unchanged}`); void qc.invalidateQueries({ queryKey: ['ma-alerts'] }); },
    onError: (e) => message.error(errorText(e)),
  });
  const defWritable = can('mgmt:write') && allOrgsUser();
  const runWritable = can('mgmt:write');
  if (metrics.error) return <QueryErrorResult title="指标加载失败" error={metrics.error} refetch={metrics.refetch} />;
  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Space>
        {defWritable && <Button onClick={() => setCreating(true)}>新建指标</Button>}
        {runWritable && <Button type="primary" onClick={() => setRunning(true)}>运行计算</Button>}
      </Space>
      <Table<MaMetricDto>
        size="small" rowKey="id" loading={metrics.isLoading} dataSource={metrics.data ?? []} pagination={false}
        columns={[
          { title: '编码', dataIndex: 'code', width: 150, render: (v: string, m) => <>{v}{m.builtin && <Tag style={{ marginLeft: 6 }}>内置</Tag>}</> },
          { title: '名称', dataIndex: 'name' },
          { title: '计算器', dataIndex: 'calculator', width: 200, render: (v: MaCalculator) => CALCULATOR_LABEL[v] },
          { title: '参数', dataIndex: 'params', width: 200, render: (p: MaMetricParams) => paramsText(p) },
          { title: '阈值', dataIndex: 'thresholds', render: (t: MaThresholds) => Object.entries(t).map(([k, v]) => <Tag key={k}>{THRESHOLD_FIELDS.find((f) => f.key === k)?.label ?? k} {v}</Tag>) },
          { title: '状态', dataIndex: 'status', width: 70, render: (v: string) => (v === 'active' ? <Tag color="success">启用</Tag> : <Tag>停用</Tag>) },
          ...(defWritable ? [{ title: '操作', width: 70, render: (_: unknown, m: MaMetricDto) => (m.builtin ? null : <a onClick={() => toggle.mutate(m)}>{m.status === 'active' ? '停用' : '启用'}</a>) }] : []),
        ]}
      />
      <div>
        <Space style={{ marginBottom: 8 }}><Typography.Text strong>计算运行</Typography.Text><PeriodPicker value={period} onChange={setPeriod} /></Space>
        <Table<MaCalcRunDto>
          size="small" rowKey="id" loading={runs.isLoading} dataSource={runs.data ?? []} pagination={{ pageSize: 10, showSizeChanger: false }}
          columns={[
            { title: '运行', dataIndex: 'id', width: 70, render: (v: number) => `#${v}` },
            { title: '类型', dataIndex: 'kind', width: 80, render: (v: string) => (v === 'calc' ? '计算' : '分摊') },
            { title: '期间', dataIndex: 'period', width: 90 },
            { title: '快照/不可用', width: 110, render: (_: unknown, r) => `${r.snapshotCount} / ${r.unavailableCount}` },
            { title: '时间', dataIndex: 'createdAt', width: 130, render: (v: string) => shortTime(v) },
            {
              title: '操作', width: 150, render: (_: unknown, r) => (
                <Space><a onClick={() => setRunDetail(r.id)}>快照</a>{runWritable && r.kind === 'calc' && <a onClick={() => scan.mutate(r.id)}>扫描预警</a>}</Space>
              ),
            },
          ]}
        />
      </div>
      <MetricModal open={creating} onClose={() => setCreating(false)} />
      <CalcRunModal open={running} onClose={() => setRunning(false)} onDone={(r) => { void qc.invalidateQueries({ queryKey: ['ma-calc-runs'] }); setRunDetail(r.id); }} />
      <Drawer open={runDetail != null} onClose={() => setRunDetail(null)} width={1000} title={`计算运行 #${runDetail ?? ''} 快照`} destroyOnClose>
        {detail.error ? <QueryErrorResult title="快照加载失败" error={detail.error} refetch={detail.refetch} /> : <SnapshotTable rows={detail.data?.snapshots ?? []} loading={detail.isLoading} />}
      </Drawer>
    </Space>
  );
}

/* ---------------- 多维分析 ---------------- */

export function AnalysisTab() {
  const metrics = useMetrics();
  const dims = useQuery({ queryKey: ['ma-dimensions'], queryFn: () => mgmtApi.dimensions() });
  const [metricIds, setMetricIds] = useState<number[]>([]);
  const [periods, setPeriods] = useState<string[]>([lastPeriod()]);
  const [groupBy, setGroupBy] = useState<'org' | 'dimension'>('org');
  const [dimensionId, setDimensionId] = useState<number | undefined>();
  const [orgId, setOrgId] = useState<number | undefined>();
  const ready = metricIds.length > 0 && periods.length > 0 && (groupBy === 'org' || !!dimensionId);
  const q = useQuery({
    queryKey: ['ma-analysis', metricIds, periods, groupBy, dimensionId, orgId], enabled: ready,
    queryFn: () => mgmtApi.analysis({ metricIds, periods, groupBy, dimensionId, orgIds: orgId ? [orgId] : undefined }),
  });
  const rows = q.data?.rows ?? [];
  const periodCols = [...new Set(rows.map((r) => r.period))].sort();
  const grouped = new Map<string, { key: string; metricName: string; unit: 'money' | 'ratio'; groupName: string; values: Record<string, string | null> }>();
  for (const r of rows) {
    const key = `${r.metricId}|${r.groupKey}`;
    if (!grouped.has(key)) grouped.set(key, { key, metricName: r.metricName, unit: r.unit, groupName: r.groupName, values: {} });
    grouped.get(key)!.values[r.period] = r.value;
  }
  return (
    <>
      <Space wrap style={{ marginBottom: 12 }}>
        <Select mode="multiple" placeholder="指标" value={metricIds} onChange={setMetricIds} style={{ minWidth: 260 }} optionFilterProp="label"
          options={(metrics.data ?? []).map((m) => ({ value: m.id, label: m.name }))} />
        <Select mode="tags" placeholder="期间 YYYY-MM" value={periods} onChange={(v) => setPeriods(v.filter((p) => /^\d{4}-(0[1-9]|1[0-2])$/.test(p)))} style={{ minWidth: 220 }} />
        <Select value={groupBy} onChange={setGroupBy} style={{ width: 120 }} options={[{ value: 'org', label: '按组织' }, { value: 'dimension', label: '按维度成员' }]} />
        {groupBy === 'dimension' && (
          <Select placeholder="组织维度" value={dimensionId} onChange={setDimensionId} style={{ width: 180 }}
            options={(dims.data ?? []).filter((d) => d.memberType === 'org').map((d) => ({ value: d.id, label: d.name }))} />
        )}
        <OrgSelect value={orgId} onChange={setOrgId} placeholder="组织(可选)" />
      </Space>
      {!ready ? <Empty description="选择指标与期间;按维度分组时还需选择组织维度" /> : q.error ? <QueryErrorResult title="分析失败" error={q.error} refetch={q.refetch} /> : (
        <Table
          size="small" rowKey="key" loading={q.isLoading} dataSource={[...grouped.values()]} pagination={false}
          columns={[
            { title: '指标', dataIndex: 'metricName', width: 200 },
            { title: groupBy === 'org' ? '组织' : '维度成员', dataIndex: 'groupName', width: 180 },
            ...periodCols.map((p) => ({
              title: p, key: p, align: 'right' as const, width: 140,
              render: (_: unknown, r: { unit: 'money' | 'ratio'; values: Record<string, string | null> }) => (r.values[p] == null ? <Typography.Text type="secondary">无快照</Typography.Text> : formatByUnit(r.values[p], r.unit)),
            })),
          ]}
        />
      )}
      <Alert style={{ marginTop: 12 }} type="info" showIcon message="多维分析只读已保存的有效快照(每组织/期间取最新一次),不在查询时重新计算。" />
    </>
  );
}
