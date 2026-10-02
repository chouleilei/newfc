import { useAssistantDomainPage } from '../../assistant/contextHooks';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App as AntdApp, Button, Card, Col, Descriptions, Empty, Form, Input, Modal, Row, Select, Space, Table, Tag, TreeSelect, Typography } from 'antd';
import { api, can, errorText } from '../../api/client';
import { mgmtApi } from '../../api/mgmt';
import type { MaAlertDto, MaBudgetAdjustmentDto, MaPerfSchemeDto, MaPerfScoreDto } from '../../api/financeData';
import { QueryErrorResult } from '../../components/QueryErrorResult';
import { formatByUnit } from '../../utils/decimal';
import { shortTime } from '../../utils/relativeTime';
import { compact, defaultOrgId, EXCEPTION_REASON_FIELD, lastPeriod, Money, OrgSelect, PeriodPicker, usePrompt } from '../financeData/shared';
import { allOrgsUser, SnapshotValue, useMetrics } from './MetricTabs';

/** 管理会计:预算调整、预警、责任中心、绩效。 */

const REVIEW_STATUS: Record<string, { text: string; color: string }> = {
  pending: { text: '待复核', color: 'warning' }, effective: { text: '已生效', color: 'success' }, rejected: { text: '已驳回', color: 'default' },
};
const ALERT_STATUS: Record<string, { text: string; color: string }> = { open: { text: '待确认', color: 'error' }, acknowledged: { text: '已确认', color: 'warning' }, closed: { text: '已关闭', color: 'default' } };
const ALERT_TYPE: Record<string, string> = { upper: '超上限', lower: '低于下限', deviation: '偏离预算' };
const CAUSES = [
  { value: 'timing', label: '时间性差异' }, { value: 'business_change', label: '业务变化' }, { value: 'data_quality', label: '数据质量' },
  { value: 'one_off', label: '一次性事项' }, { value: 'other', label: '其他' },
];
const CAUSE_LABEL = Object.fromEntries(CAUSES.map((c) => [c.value, c.label]));
const TODO_LABEL: Record<string, string> = { alert_ack: '待确认预警', alloc_adjustment_review: '待复核分摊调整', budget_adjustment_review: '待复核预算调整', perf_review: '待复核绩效' };

interface VersionRow { id: number; year: number; name: string; status: string; is_current: 0 | 1; kind: string }
interface AccountNode { id: number; code: string; name: string; children?: AccountNode[] }
type AccountTreeData = { value: number; title: string; children?: AccountTreeData }[];
const accountTreeData = (ns: AccountNode[]): AccountTreeData =>
  ns.map((n) => ({ value: n.id, title: `${n.code} ${n.name}`, children: n.children?.length ? accountTreeData(n.children) : undefined }));

/* ---------------- 预算调整 ---------------- */

function BudgetAdjustmentModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { message } = AntdApp.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm<{ versionId: number; orgId: number; accountId: number; amount: string; reason: string }>();
  const versions = useQuery({ queryKey: ['versions'], queryFn: () => api.get<VersionRow[]>('/versions'), enabled: open });
  const accounts = useQuery({ queryKey: ['account-tree'], queryFn: () => api.get<{ tree: AccountNode[] }>('/account/tree'), enabled: open });
  const submit = useMutation({
    mutationFn: (v: { versionId: number; orgId: number; accountId: number; amount: string; reason: string }) => mgmtApi.submitBudgetAdjustment(v),
    onSuccess: () => { message.success('已提交,待复核后生成新版本并设为当前'); onClose(); void qc.invalidateQueries({ queryKey: ['ma-budget-adjustments'] }); },
    onError: (e) => message.error(errorText(e)),
  });
  const current = (versions.data ?? []).filter((v) => v.is_current === 1 && v.status === 'locked' && v.kind === 'budget');
  return (
    <Modal open={open} title="提交预算调整" onCancel={onClose} confirmLoading={submit.isPending} destroyOnClose onOk={() => form.validateFields().then((v) => submit.mutate(v))}>
      <Typography.Paragraph type="secondary">只能调整当前采用、已锁定的经营预算中的一个叶子单元格。生效时复制出新版本、写入调整后金额、锁定并设为当前;原版本不变。</Typography.Paragraph>
      <Form form={form} layout="vertical" preserve={false} initialValues={{ orgId: defaultOrgId() }}>
        <Form.Item name="versionId" label="预算版本" rules={[{ required: true, message: '请选择版本' }]}>
          <Select loading={versions.isLoading} options={current.map((v) => ({ value: v.id, label: `${v.year} · ${v.name}` }))} notFoundContent="没有当前采用且已锁定的经营预算" />
        </Form.Item>
        <Form.Item name="orgId" label="组织(叶子)" rules={[{ required: true, message: '请选择组织' }]}><OrgSelect onChange={(v) => form.setFieldValue('orgId', v)} width={360} /></Form.Item>
        <Form.Item name="accountId" label="科目(叶子)" rules={[{ required: true, message: '请选择科目' }]}>
          <TreeSelect loading={accounts.isLoading} treeData={accountTreeData(accounts.data?.tree ?? [])} showSearch treeNodeFilterProp="title" />
        </Form.Item>
        <Form.Item name="amount" label="调整后金额(元,界面口径:成本费用填正数)" rules={[{ required: true, pattern: /^-?\d{1,16}(\.\d{1,2})?$/, message: '最多两位小数' }]}><Input /></Form.Item>
        <Form.Item name="reason" label="调整原因" rules={[{ required: true, whitespace: true }]}><Input.TextArea rows={2} maxLength={500} /></Form.Item>
      </Form>
    </Modal>
  );
}

export function BudgetAdjustmentsTab() {
  const { message } = AntdApp.useApp();
  const qc = useQueryClient();
  const [status, setStatus] = useState<string | undefined>('pending');
  useAssistantDomainPage({ pageKey: 'mgmt', ready: true, view: { tab: 'budget-adjust', status } });
  const [creating, setCreating] = useState(false);
  const [prompt, holder] = usePrompt();
  const list = useQuery({ queryKey: ['ma-budget-adjustments', status], queryFn: () => mgmtApi.budgetAdjustments(status) });
  const review = useMutation({
    mutationFn: (v: { a: MaBudgetAdjustmentDto; action: 'approve' | 'reject'; comment?: string; exceptionReason?: string }) =>
      mgmtApi.reviewBudgetAdjustment(v.a.id, compact({ action: v.action, comment: v.comment, exceptionReason: v.exceptionReason }) as never),
    onSuccess: (a) => { message.success(a.status === 'effective' ? `已生效:新版本 #${a.newVersionId} 已设为当前` : '已驳回'); void qc.invalidateQueries({ queryKey: ['ma-budget-adjustments'] }); },
    onError: (e) => message.error(errorText(e)),
  });
  const canReview = can('budget:finalize') && allOrgsUser();
  const act = async (a: MaBudgetAdjustmentDto, action: 'approve' | 'reject') => {
    const v = await prompt({
      title: action === 'approve' ? '批准预算调整' : '驳回预算调整', danger: action === 'reject',
      description: action === 'approve' ? `将复制「${a.sourceVersionName}」为新版本,${a.orgName} / ${a.accountName} 由 ${a.beforeAmount} 调整为 ${a.afterAmount},锁定并设为当前。` : undefined,
      fields: [{ name: 'comment', label: '复核意见', multiline: true }, EXCEPTION_REASON_FIELD],
    });
    if (v) review.mutate({ a, action, comment: v.comment, exceptionReason: v.exceptionReason });
  };
  if (list.error) return <QueryErrorResult title="预算调整加载失败" error={list.error} refetch={list.refetch} />;
  return (
    <>
      {holder}
      <Space style={{ marginBottom: 12 }}>
        <Select allowClear placeholder="状态" value={status} onChange={setStatus} style={{ width: 120 }} options={Object.entries(REVIEW_STATUS).map(([value, m]) => ({ value, label: m.text }))} />
        {can('mgmt:write') && <Button type="primary" onClick={() => setCreating(true)}>提交预算调整</Button>}
      </Space>
      <Table<MaBudgetAdjustmentDto>
        size="small" rowKey="id" loading={list.isLoading} dataSource={list.data ?? []}
        columns={[
          { title: '单号', dataIndex: 'id', width: 70, render: (v: number) => `#${v}` },
          { title: '源版本', dataIndex: 'sourceVersionName', width: 160 },
          { title: '组织', dataIndex: 'orgName', width: 140 },
          { title: '科目', width: 180, render: (_: unknown, a) => `${a.accountCode} ${a.accountName}` },
          { title: '调整前', dataIndex: 'beforeAmount', width: 130, align: 'right', render: (v: string) => <Money value={v} /> },
          { title: '调整后', dataIndex: 'afterAmount', width: 130, align: 'right', render: (v: string) => <Money value={v} /> },
          { title: '原因', dataIndex: 'reason', ellipsis: true },
          { title: '状态', dataIndex: 'status', width: 90, render: (v: string, a) => <><Tag color={REVIEW_STATUS[v].color}>{REVIEW_STATUS[v].text}</Tag>{a.newVersionId && <Typography.Text type="secondary">→#{a.newVersionId}</Typography.Text>}</> },
          { title: '操作', width: 110, render: (_: unknown, a) => (a.status === 'pending' && canReview ? <Space><a onClick={() => void act(a, 'approve')}>批准</a><a onClick={() => void act(a, 'reject')}>驳回</a></Space> : null) },
        ]}
      />
      <BudgetAdjustmentModal open={creating} onClose={() => setCreating(false)} />
    </>
  );
}

/* ---------------- 预警 ---------------- */

export function AlertsTab() {
  const { message } = AntdApp.useApp();
  const qc = useQueryClient();
  const [status, setStatus] = useState<string | undefined>('unclosed');
  const [orgId, setOrgId] = useState<number | undefined>(defaultOrgId());
  const [period, setPeriod] = useState<string | undefined>();
  useAssistantDomainPage({ pageKey: 'mgmt', ready: true, scope: { orgScopeId: orgId, period }, view: { tab: 'alerts', status } });
  const [prompt, holder] = usePrompt();
  const list = useQuery({ queryKey: ['ma-alerts', status, orgId, period], queryFn: () => mgmtApi.alerts({ status, orgId, period }) });
  const refresh = () => void qc.invalidateQueries({ queryKey: ['ma-alerts'] });
  const ack = useMutation({
    mutationFn: (v: { a: MaAlertDto; causeCategory: string; note: string }) => mgmtApi.acknowledgeAlert(v.a.id, { expectedVersion: v.a.version, causeCategory: v.causeCategory, note: v.note }),
    onSuccess: () => { message.success('已确认'); refresh(); }, onError: (e) => message.error(errorText(e)),
  });
  const close = useMutation({
    mutationFn: (v: { a: MaAlertDto; note?: string }) => mgmtApi.closeAlert(v.a.id, compact({ expectedVersion: v.a.version, note: v.note }) as never),
    onSuccess: () => { message.success('已关闭'); refresh(); }, onError: (e) => message.error(errorText(e)),
  });
  const writable = can('mgmt:write');
  if (list.error) return <QueryErrorResult title="预警加载失败" error={list.error} refetch={list.refetch} />;
  return (
    <>
      {holder}
      <Space wrap style={{ marginBottom: 12 }}>
        <Select allowClear placeholder="状态" value={status} onChange={setStatus} style={{ width: 120 }}
          options={[{ value: 'unclosed', label: '未关闭' }, ...Object.entries(ALERT_STATUS).map(([value, m]) => ({ value, label: m.text }))]} />
        <OrgSelect value={orgId} onChange={setOrgId} />
        <PeriodPicker value={period} onChange={setPeriod} />
        <Typography.Text type="secondary">预警由“指标 → 计算运行 → 扫描预警”生成;同一指标+组织+期间+类型的未关闭预警重复扫描只更新。</Typography.Text>
      </Space>
      <Table<MaAlertDto>
        size="small" rowKey="id" loading={list.isLoading} dataSource={list.data ?? []}
        columns={[
          { title: '级别', dataIndex: 'level', width: 70, render: (v: string) => (v === 'critical' ? <Tag color="error">严重</Tag> : <Tag color="warning">警告</Tag>) },
          { title: '指标', dataIndex: 'metricName', width: 160 },
          { title: '组织', dataIndex: 'orgName', width: 140 },
          { title: '期间', dataIndex: 'period', width: 90 },
          { title: '类型', dataIndex: 'alertType', width: 90, render: (v: string) => ALERT_TYPE[v] ?? v },
          { title: '说明', dataIndex: 'message', ellipsis: true },
          { title: '命中', dataIndex: 'hitCount', width: 60, align: 'right' },
          { title: '状态', dataIndex: 'status', width: 90, render: (v: string, a) => <span title={[a.causeCategory ? CAUSE_LABEL[a.causeCategory] : '', a.ackNote, a.closeNote].filter(Boolean).join(' / ')}><Tag color={ALERT_STATUS[v].color}>{ALERT_STATUS[v].text}</Tag></span> },
          { title: '更新', dataIndex: 'updatedAt', width: 130, render: (v: string) => shortTime(v) },
          {
            title: '操作', width: 80, render: (_: unknown, a) => {
              if (!writable) return null;
              if (a.status === 'open') {
                return <a onClick={async () => { const v = await prompt({ title: '确认预警', fields: [{ name: 'causeCategory', label: '原因分类', required: true, options: CAUSES }, { name: 'note', label: '说明', required: true, multiline: true }] }); if (v) ack.mutate({ a, causeCategory: v.causeCategory, note: v.note }); }}>确认</a>;
              }
              if (a.status === 'acknowledged') {
                return <a onClick={async () => { const v = await prompt({ title: '关闭预警', fields: [{ name: 'note', label: '关闭说明', multiline: true }] }); if (v) close.mutate({ a, note: v.note }); }}>关闭</a>;
              }
              return null;
            },
          },
        ]}
      />
    </>
  );
}

/* ---------------- 责任中心 ---------------- */

export function CentersTab() {
  const [period, setPeriod] = useState<string | undefined>(lastPeriod());
  const [orgId, setOrgId] = useState<number | undefined>(defaultOrgId());
  useAssistantDomainPage({ pageKey: 'mgmt', ready: true, scope: { orgScopeId: orgId, period }, view: { tab: 'centers' } });
  const q = useQuery({ queryKey: ['ma-centers', period, orgId], queryFn: () => mgmtApi.centers(period!, orgId), enabled: !!period });
  return (
    <>
      <Space style={{ marginBottom: 12 }}>
        <PeriodPicker value={period} onChange={setPeriod} allowClear={false} />
        <OrgSelect value={orgId} onChange={setOrgId} placeholder="全部授权组织" />
      </Space>
      {q.error ? <QueryErrorResult title="责任中心加载失败" error={q.error} refetch={q.refetch} /> : !(q.data ?? []).length ? <Empty description={q.isLoading ? '加载中…' : '没有数据'} /> : (
        <Row gutter={[12, 12]}>
          {(q.data ?? []).map((c) => (
            <Col key={c.orgId} xs={24} lg={12}>
              <Card size="small" title={`${c.orgName}(${c.orgCode})`} extra={
                <Space size={4}>
                  {c.openAlerts.critical > 0 && <Tag color="error">严重 {c.openAlerts.critical}</Tag>}
                  {c.openAlerts.warning > 0 && <Tag color="warning">警告 {c.openAlerts.warning}</Tag>}
                  {c.openAlerts.acknowledged > 0 && <Tag>已确认 {c.openAlerts.acknowledged}</Tag>}
                </Space>
              }>
                <Descriptions size="small" column={1}>
                  <Descriptions.Item label="分摊成本"><Money value={c.allocatedCost} /></Descriptions.Item>
                  {c.snapshots.map((s) => <Descriptions.Item key={s.id} label={s.metricName}><SnapshotValue s={s} /></Descriptions.Item>)}
                </Descriptions>
                {c.todos.length > 0 && (
                  <div style={{ marginTop: 8 }}>
                    <Typography.Text strong>待办</Typography.Text>
                    {c.todos.map((t) => <div key={`${t.kind}-${t.id}`}><Tag>{TODO_LABEL[t.kind] ?? t.kind}</Tag>{t.title}</div>)}
                  </div>
                )}
              </Card>
            </Col>
          ))}
        </Row>
      )}
    </>
  );
}

/* ---------------- 绩效 ---------------- */

function SchemeModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { message } = AntdApp.useApp();
  const qc = useQueryClient();
  const metrics = useMetrics('active');
  const [form] = Form.useForm<{ code: string; name: string; items: { metricId: number; weight: string; target: string; direction: 'higher_better' | 'lower_better' }[] }>();
  const create = useMutation({
    mutationFn: (v: { code: string; name: string; items: { metricId: number; weight: string; target: string; direction: 'higher_better' | 'lower_better' }[] }) => mgmtApi.createScheme(v),
    onSuccess: () => { message.success('方案已创建'); onClose(); void qc.invalidateQueries({ queryKey: ['ma-schemes'] }); }, onError: (e) => message.error(errorText(e)),
  });
  return (
    <Modal open={open} title="新建绩效方案" width={760} onCancel={onClose} confirmLoading={create.isPending} destroyOnClose onOk={() => form.validateFields().then((v) => create.mutate(v))}>
      <Typography.Paragraph type="secondary">权重合计必须为 1;达成率封顶 120%,单项得分 = 达成率 × 权重 × 100。金额目标填元,比率目标填 0～1。</Typography.Paragraph>
      <Form form={form} layout="vertical" preserve={false} initialValues={{ items: [{ direction: 'higher_better' }] }}>
        <Row gutter={12}>
          <Col span={10}><Form.Item name="code" label="编码" rules={[{ required: true, pattern: /^[A-Za-z][A-Za-z0-9_-]{0,31}$/, message: '字母开头' }]}><Input /></Form.Item></Col>
          <Col span={14}><Form.Item name="name" label="名称" rules={[{ required: true, whitespace: true }]}><Input maxLength={100} /></Form.Item></Col>
        </Row>
        <Form.List name="items">
          {(fields, { add, remove }) => (
            <>
              {fields.map((f) => (
                <Space key={f.key} align="baseline" wrap>
                  <Form.Item name={[f.name, 'metricId']} rules={[{ required: true, message: '指标' }]}>
                    <Select style={{ width: 220 }} placeholder="指标" options={(metrics.data ?? []).map((m) => ({ value: m.id, label: m.name }))} />
                  </Form.Item>
                  <Form.Item name={[f.name, 'weight']} rules={[{ required: true, pattern: /^\d{1,12}(\.\d{1,6})?$/, message: '权重' }]}><Input placeholder="权重" style={{ width: 90 }} /></Form.Item>
                  <Form.Item name={[f.name, 'target']} rules={[{ required: true, pattern: /^-?\d{1,12}(\.\d{1,6})?$/, message: '目标' }]}><Input placeholder="目标值" style={{ width: 120 }} /></Form.Item>
                  <Form.Item name={[f.name, 'direction']}><Select style={{ width: 120 }} options={[{ value: 'higher_better', label: '越高越好' }, { value: 'lower_better', label: '越低越好' }]} /></Form.Item>
                  <a onClick={() => remove(f.name)}>删除</a>
                </Space>
              ))}
              <Button type="dashed" onClick={() => add({ direction: 'higher_better' })} block>添加考核项</Button>
            </>
          )}
        </Form.List>
      </Form>
    </Modal>
  );
}

export function PerformanceTab() {
  const { message } = AntdApp.useApp();
  const qc = useQueryClient();
  const [creating, setCreating] = useState(false);
  const [schemeId, setSchemeId] = useState<number | undefined>();
  useAssistantDomainPage({ pageKey: 'mgmt', ready: true, view: { tab: 'performance', schemeId } });
  const [prompt, holder] = usePrompt();
  const schemes = useQuery({ queryKey: ['ma-schemes'], queryFn: () => mgmtApi.schemes() });
  const runs = useQuery({ queryKey: ['ma-calc-runs', undefined], queryFn: () => mgmtApi.calcRuns({}) });
  const scores = useQuery({ queryKey: ['ma-scores', schemeId], queryFn: () => mgmtApi.scores({ schemeId }) });
  const score = useMutation({
    mutationFn: (v: { scheme: MaPerfSchemeDto; runId: number }) => mgmtApi.score(v.scheme.id, { runId: v.runId }),
    onSuccess: (r) => {
      message.success(`已评分 ${r.scores.length} 个组织${r.skipped.length ? `,跳过 ${r.skipped.length} 个(缺少快照)` : ''}`);
      void qc.invalidateQueries({ queryKey: ['ma-scores'] });
    },
    onError: (e) => message.error(errorText(e)),
  });
  const review = useMutation({
    mutationFn: (v: { s: MaPerfScoreDto; body: Record<string, string | undefined> }) => mgmtApi.reviewScore(v.s.id, compact(v.body) as never),
    onSuccess: () => { message.success('复核已记录,原始得分保留'); void qc.invalidateQueries({ queryKey: ['ma-scores'] }); }, onError: (e) => message.error(errorText(e)),
  });
  const runOptions = (runs.data ?? []).filter((r) => r.kind === 'calc').map((r) => ({ value: String(r.id), label: `#${r.id} · ${r.period}(${r.snapshotCount} 快照)` }));
  if (schemes.error) return <QueryErrorResult title="绩效方案加载失败" error={schemes.error} refetch={schemes.refetch} />;
  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      {holder}
      {can('mgmt:write') && allOrgsUser() && <Button onClick={() => setCreating(true)} style={{ width: 'fit-content' }}>新建绩效方案</Button>}
      <Table<MaPerfSchemeDto>
        size="small" rowKey="id" loading={schemes.isLoading} dataSource={schemes.data ?? []} pagination={false}
        columns={[
          { title: '编码', dataIndex: 'code', width: 130 }, { title: '名称', dataIndex: 'name', width: 180 },
          { title: '考核项', dataIndex: 'items', render: (items: MaPerfSchemeDto['items']) => items.map((i) => <Tag key={i.id}>{i.metricName} × {i.weight} 目标 {formatByUnit(i.target, i.unit)}{i.direction === 'lower_better' ? '↓' : '↑'}</Tag>) },
          {
            title: '操作', width: 150, render: (_: unknown, sc) => (
              <Space>
                <a onClick={() => setSchemeId(sc.id)}>评分记录</a>
                {can('mgmt:write') && (
                  <a onClick={async () => { const v = await prompt({ title: `按计算运行评分 · ${sc.name}`, fields: [{ name: 'runId', label: '计算运行', required: true, options: runOptions }] }); if (v) score.mutate({ scheme: sc, runId: Number(v.runId) }); }}>评分</a>
                )}
              </Space>
            ),
          },
        ]}
      />
      <Card size="small" title={<Space>评分记录<Select allowClear placeholder="全部方案" value={schemeId} onChange={setSchemeId} style={{ width: 200 }} options={(schemes.data ?? []).map((s) => ({ value: s.id, label: s.name }))} /></Space>}>
        {scores.error ? <QueryErrorResult title="评分加载失败" error={scores.error} refetch={scores.refetch} /> : (
          <Table<MaPerfScoreDto>
            size="small" rowKey="id" loading={scores.isLoading} dataSource={scores.data ?? []}
            expandable={{
              expandedRowRender: (s) => (
                <Table size="small" rowKey="metricId" pagination={false} dataSource={s.details}
                  columns={[
                    { title: '指标', dataIndex: 'metricName' }, { title: '实际', dataIndex: 'value', width: 130, align: 'right' }, { title: '目标', dataIndex: 'target', width: 130, align: 'right' },
                    { title: '权重', dataIndex: 'weight', width: 90, align: 'right' }, { title: '达成率', dataIndex: 'achievement', width: 100, align: 'right' },
                    { title: '得分', dataIndex: 'itemScore', width: 90, align: 'right' },
                  ]} />
              ),
            }}
            columns={[
              { title: '方案', dataIndex: 'schemeName', width: 160 }, { title: '组织', dataIndex: 'orgName', width: 140 }, { title: '期间', dataIndex: 'period', width: 90 },
              { title: '原始得分', dataIndex: 'score', width: 90, align: 'right' },
              { title: '最终得分', dataIndex: 'finalScore', width: 90, align: 'right', render: (v: string, s) => <span title={s.adjustReason ?? ''}>{v}{s.reviewAction === 'adjust' && <Tag style={{ marginLeft: 4 }}>已调整</Tag>}</span> },
              { title: '状态', dataIndex: 'status', width: 80, render: (v: string) => (v === 'reviewed' ? <Tag color="success">已复核</Tag> : <Tag color="warning">待复核</Tag>) },
              { title: '评分时间', dataIndex: 'scoredAt', width: 130, render: (v: string) => shortTime(v) },
              {
                title: '操作', width: 110, render: (_: unknown, s) => (s.status === 'scored' && can('mgmt:review') ? (
                  <Space>
                    <a onClick={async () => { const v = await prompt({ title: '确认得分', fields: [{ name: 'comment', label: '复核意见', multiline: true }, EXCEPTION_REASON_FIELD] }); if (v) review.mutate({ s, body: { action: 'confirm', ...v } }); }}>确认</a>
                    <a onClick={async () => {
                      const v = await prompt({ title: '调整得分', description: `原始得分 ${s.score} 保留不变;调整分须在 0～120 之间并填写原因。`, fields: [{ name: 'adjustedScore', label: '调整后得分', required: true }, { name: 'reason', label: '调整原因', required: true, multiline: true }, EXCEPTION_REASON_FIELD] });
                      if (v) review.mutate({ s, body: { action: 'adjust', ...v } });
                    }}>调整</a>
                  </Space>
                ) : null),
              },
            ]}
          />
        )}
      </Card>
      <SchemeModal open={creating} onClose={() => setCreating(false)} />
      <Alert type="info" showIcon message="评分基于指定计算运行的有效快照;缺少快照的组织被跳过并列出原因,全部缺失时不写入。" />
    </Space>
  );
}
