import { useBatchDeepLink } from '../../hooks/useBatchDeepLink';
import { useAssistantDomainPage } from '../../assistant/contextHooks';
import { useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App as AntdApp, Button, Card, Col, Descriptions, Drawer, Empty, Form, Popconfirm, Row, Select, Space, Table, Tabs, Tag, Typography, Upload } from 'antd';
import { can, download, errorText } from '../../api/client';
import {
  statementApi, type StatementBatchDto, type StatementCheckDto, type StatementItemDto, type StatementMetricCode, type StatementPreviewDto,
  type StatementScope, type StatementSheetCode, type StatementTrendPointDto,
} from '../../api/financeData';
import EChart from '../../components/EChart';
import { QueryErrorResult } from '../../components/QueryErrorResult';
import { shortTime } from '../../utils/relativeTime';
import { defaultOrgId, lastPeriod, Money, OrgSelect, PeriodPicker, Ratio, statusTag, usePrompt } from './shared';

/** AC-F10 财务报表:预览(不写库)→ 导入(error 拒绝,幂等)→ 激活(期望当前批次)→ 总览只读当前批次。 */

export const SCOPE_LABEL: Record<StatementScope, string> = { consolidated: '合并', parent: '母公司', subsidiary: '子公司' };
const SHEET_LABEL: Record<StatementSheetCode, string> = {
  balance_sheet: '资产负债表', income_statement: '利润表', cash_flow_statement: '现金流量表', equity_change_statement: '所有者权益变动表',
};
const BATCH_STATUS = {
  imported: { text: '已导入', color: 'processing' }, active: { text: '当前', color: 'success' }, superseded: { text: '已替换', color: 'default' }, voided: { text: '已作废', color: 'error' },
};
/* 与后端 STATEMENT_METRIC_LABELS 一致;前端只以 import type 使用契约,标签在此显式列出。 */
const METRIC_LABEL: Record<StatementMetricCode, string> = {
  total_assets_period_end: '总资产(期末)', total_liabilities_period_end: '总负债(期末)', owner_equity_period_end: '所有者权益(期末)',
  liability_equity_total_period_end: '负债和所有者权益总计(期末)', revenue_ytd: '营业总收入(本年累计)', cost_ytd: '营业总成本(本年累计)',
  operating_profit_ytd: '营业利润(本年累计)', total_profit_ytd: '利润总额(本年累计)', net_profit_ytd: '净利润(本年累计)',
  operating_cash_flow_ytd: '经营活动现金流量净额(本年累计)', investing_cash_flow_ytd: '投资活动现金流量净额(本年累计)',
  financing_cash_flow_ytd: '筹资活动现金流量净额(本年累计)', cash_net_increase_ytd: '现金净增加额(本年累计)',
  cash_beginning_ytd: '期初现金余额', cash_ending_ytd: '期末现金余额',
};
const HEADLINE: StatementMetricCode[] = ['total_assets_period_end', 'total_liabilities_period_end', 'owner_equity_period_end', 'revenue_ytd', 'net_profit_ytd', 'operating_cash_flow_ytd'];
const scopeOptions = (Object.keys(SCOPE_LABEL) as StatementScope[]).map((value) => ({ value, label: SCOPE_LABEL[value] }));

function ChecksTable({ checks }: { checks: StatementCheckDto[] }) {
  if (!checks.length) return <Typography.Text type="success">勾稽校验全部通过</Typography.Text>;
  return (
    <Table
      size="small" rowKey={(c, i) => `${c.code}-${c.sourceCell ?? ''}-${i}`} pagination={false} dataSource={checks}
      columns={[
        { title: '级别', dataIndex: 'level', width: 70, render: (v: string) => (v === 'error' ? <Tag color="error">错误</Tag> : <Tag color="warning">警告</Tag>) },
        { title: '代码', dataIndex: 'code', width: 200 },
        { title: '说明', dataIndex: 'message' },
        { title: '单元格', width: 160, render: (_: unknown, c) => [c.sheetCode ? SHEET_LABEL[c.sheetCode] : '', c.sourceCell].filter(Boolean).join(' ') },
      ]}
    />
  );
}

function MetricGrid({ metrics, codes }: { metrics: Partial<Record<StatementMetricCode, string | null>>; codes: StatementMetricCode[] }) {
  return (
    <Row gutter={[12, 12]}>
      {codes.map((k) => (
        <Col key={k} xs={24} sm={12} lg={8}>
          <div style={{ padding: '10px 12px', background: 'var(--newfc-fill)', borderRadius: 8 }}>
            <Typography.Text type="secondary" style={{ fontSize: 12 }}>{METRIC_LABEL[k]}</Typography.Text>
            <div className="kpi-value" style={{ fontSize: 20 }}>{metrics[k] == null ? <Typography.Text type="secondary">缺失</Typography.Text> : <Money value={metrics[k]} />}</div>
          </div>
        </Col>
      ))}
    </Row>
  );
}

function OverviewTab() {
  const [params] = useSearchParams();
  const [orgId, setOrgId] = useState<number | undefined>(Number(params.get('orgId')) || defaultOrgId());
  const [period, setPeriod] = useState<string | undefined>(params.get('period') ?? undefined);
  const [scope, setScope] = useState<StatementScope | undefined>();
  const q = useQuery({ queryKey: ['stmt-overview', orgId, period, scope], queryFn: () => statementApi.overview({ orgId, period, scope }) });
  useAssistantDomainPage({ pageKey: 'statements', ready: !q.isLoading && !q.error, scope: { orgScopeId: orgId, period: period ?? q.data?.batch?.period, statementScope: scope ?? q.data?.batch?.scope } });
  const d = q.data;
  return (
    <>
      <Space wrap style={{ marginBottom: 12 }}>
        <OrgSelect value={orgId} onChange={setOrgId} />
        <PeriodPicker value={period} onChange={setPeriod} placeholder="最新期间" />
        <Select allowClear placeholder="口径(合并优先)" value={scope} onChange={setScope} style={{ width: 150 }} options={scopeOptions} />
      </Space>
      {q.error ? <QueryErrorResult title="财报总览加载失败" error={q.error} refetch={q.refetch} /> : !d?.batch ? (
        <Empty description={q.isLoading ? '加载中…' : '没有当前财报批次:请先导入并激活'} />
      ) : (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Typography.Text type="secondary">
            {d.batch.orgName} · {d.batch.period} · {SCOPE_LABEL[d.batch.scope]} · 批次 #{d.batch.id}(激活于 {shortTime(d.batch.activatedAt ?? d.batch.createdAt)})
          </Typography.Text>
          <MetricGrid metrics={d.metrics ?? {}} codes={HEADLINE} />
          <Descriptions size="small" bordered column={3}>
            <Descriptions.Item label="资产负债率"><Ratio value={d.ratios?.debt_asset_ratio} /></Descriptions.Item>
            <Descriptions.Item label="权益比率"><Ratio value={d.ratios?.equity_ratio} /></Descriptions.Item>
            <Descriptions.Item label="净利率"><Ratio value={d.ratios?.net_profit_margin} /></Descriptions.Item>
          </Descriptions>
          <Card size="small" title="全部语义指标">
            <MetricGrid metrics={d.metrics ?? {}} codes={(Object.keys(METRIC_LABEL) as StatementMetricCode[]).filter((k) => !HEADLINE.includes(k))} />
          </Card>
          <Card size="small" title={`同期各单位(${d.batch.period})`}>
            <Table
              size="small" rowKey="batchId" pagination={false} dataSource={d.unitComparison}
              columns={[
                { title: '单位', dataIndex: 'orgName' },
                { title: '口径', dataIndex: 'scope', width: 90, render: (v: StatementScope) => SCOPE_LABEL[v] },
                { title: '总资产', dataIndex: 'totalAssets', width: 170, align: 'right', render: (v: string | null) => <Money value={v} /> },
                { title: '净利润(本年累计)', dataIndex: 'netProfitYtd', width: 170, align: 'right', render: (v: string | null) => <Money value={v} tone /> },
                { title: '资产负债率', dataIndex: 'debtAssetRatio', width: 120, align: 'right', render: (v: string | null) => <Ratio value={v} /> },
              ]}
            />
          </Card>
        </Space>
      )}
    </>
  );
}

/* 趋势图仅用于展示:十进制字符串转为万元数值绘图,不参与任何金额计算;表格仍显示原始精确金额。 */
const TREND_METRICS: { code: StatementMetricCode; monthly?: boolean }[] = [
  { code: 'total_assets_period_end' }, { code: 'total_liabilities_period_end' }, { code: 'owner_equity_period_end' },
  { code: 'revenue_ytd', monthly: true }, { code: 'net_profit_ytd', monthly: true }, { code: 'operating_cash_flow_ytd', monthly: true },
];
const toWan = (v: string | null | undefined) => (v == null ? null : Math.round(Number(v) / 100) / 100);

function TrendsTab() {
  const [orgId, setOrgId] = useState<number | undefined>(defaultOrgId());
  const [scope, setScope] = useState<StatementScope | undefined>();
  const [from, setFrom] = useState<string | undefined>();
  const [to, setTo] = useState<string | undefined>();
  const [metrics, setMetrics] = useState<StatementMetricCode[]>(['revenue_ytd', 'net_profit_ytd']);
  const [basis, setBasis] = useState<'ytd' | 'monthly'>('ytd');
  useAssistantDomainPage({ pageKey: 'statements', ready: true, scope: { orgScopeId: orgId, period: to, statementScope: scope, periodFrom: from, periodTo: to }, view: { tab: 'trends', metrics, basis } });
  const q = useQuery({ queryKey: ['stmt-trends', orgId, scope, from, to], queryFn: () => statementApi.trends({ orgId, scope, from, to }) });
  const d = q.data;
  const valueOf = (p: StatementTrendPointDto, code: StatementMetricCode) =>
    (basis === 'monthly' && code in p.monthly ? p.monthly[code as keyof StatementTrendPointDto['monthly']] : p.metrics[code]);
  const option = useMemo(() => {
    const points = d?.points ?? [];
    return {
      tooltip: { trigger: 'axis', valueFormatter: (v: number | null) => (v == null ? '—' : `${v.toLocaleString('zh-CN')} 万元`) },
      legend: { top: 0 },
      grid: { left: 60, right: 24, top: 36, bottom: 30 },
      xAxis: { type: 'category', data: points.map((p) => p.period) },
      yAxis: { type: 'value', name: '万元' },
      series: metrics.map((code) => ({ name: METRIC_LABEL[code], type: 'line', smooth: false, connectNulls: false, data: points.map((p) => toWan(valueOf(p, code))) })),
    };
  }, [d, metrics, basis]);
  return (
    <>
      <Space wrap style={{ marginBottom: 12 }}>
        <OrgSelect value={orgId} onChange={setOrgId} />
        <Select allowClear placeholder="口径(合并优先)" value={scope} onChange={setScope} style={{ width: 150 }} options={scopeOptions} />
        <PeriodPicker value={from} onChange={setFrom} placeholder="起始期间" />
        <PeriodPicker value={to} onChange={setTo} placeholder="截止(最新)" />
        <Select mode="multiple" style={{ minWidth: 320 }} value={metrics} onChange={setMetrics} maxTagCount={3}
          options={(Object.keys(METRIC_LABEL) as StatementMetricCode[]).map((k) => ({ value: k, label: METRIC_LABEL[k] }))} />
        <Select value={basis} onChange={setBasis} style={{ width: 130 }} options={[{ value: 'ytd', label: '累计/期末数' }, { value: 'monthly', label: '当月发生额' }]} />
      </Space>
      {q.error ? <QueryErrorResult title="财报趋势加载失败" error={q.error} refetch={q.refetch} /> : !d?.points.length ? (
        <Empty description={q.isLoading ? '加载中…' : '所选范围内没有当前财报批次'} />
      ) : (
        <Space direction="vertical" size={16} style={{ width: '100%' }}>
          <Typography.Text type="secondary">
            {d.orgName} · {d.scope ? SCOPE_LABEL[d.scope] : ''} · {d.from} ～ {d.to}
            {basis === 'monthly' && ' · 当月发生额 = 本期累计 − 上期累计(1 月取累计数),期末类指标不变'}
          </Typography.Text>
          {d.missingPeriods.length > 0 && <Alert type="warning" showIcon message={`以下期间没有当前批次,不做插补:${d.missingPeriods.join('、')}`} />}
          <Card size="small"><EChart option={option} height={340} /></Card>
          <Table
            size="small" rowKey="period" pagination={false} dataSource={d.points} scroll={{ x: 1100 }}
            columns={[
              { title: '期间', dataIndex: 'period', width: 90, fixed: 'left' },
              ...TREND_METRICS.map((m) => ({
                title: basis === 'monthly' && m.monthly ? METRIC_LABEL[m.code].replace('本年累计', '当月') : METRIC_LABEL[m.code], key: m.code, width: 150, align: 'right' as const,
                render: (_: unknown, p: StatementTrendPointDto) => <Money value={valueOf(p, m.code)} tone={m.code === 'net_profit_ytd'} />,
              })),
              { title: '资产负债率', key: 'dar', width: 110, align: 'right' as const, render: (_: unknown, p: StatementTrendPointDto) => <Ratio value={p.ratios.debt_asset_ratio} /> },
              { title: '净利率', key: 'npm', width: 100, align: 'right' as const, render: (_: unknown, p: StatementTrendPointDto) => <Ratio value={p.ratios.net_profit_margin} /> },
            ]}
          />
        </Space>
      )}
    </>
  );
}

function ItemsDrawer({ batch, onClose }: { batch: StatementBatchDto | null; onClose: () => void }) {
  const [sheet, setSheet] = useState<StatementSheetCode>('balance_sheet');
  const q = useQuery({ queryKey: ['stmt-items', batch?.id, sheet], queryFn: () => statementApi.items(batch!.id, sheet), enabled: !!batch });
  const items = q.data ?? [];
  const factKeys = [...new Set(items.flatMap((i) => i.facts.map((f) => f.fieldKey)))];
  const factName = new Map(items.flatMap((i) => i.facts.map((f) => [f.fieldKey, f.fieldName] as const)));
  return (
    <Drawer open={!!batch} onClose={onClose} width={1100} title={batch ? `${batch.orgName} ${batch.period} ${SCOPE_LABEL[batch.scope]} · ${batch.fileName}` : ''} destroyOnClose>
      <Tabs activeKey={sheet} onChange={(k) => setSheet(k as StatementSheetCode)} items={(Object.keys(SHEET_LABEL) as StatementSheetCode[]).map((k) => ({ key: k, label: SHEET_LABEL[k] }))} />
      {q.error ? <QueryErrorResult title="报表明细加载失败" error={q.error} refetch={q.refetch} /> : (
        <Table<StatementItemDto>
          size="small" rowKey={(r) => `${r.rowNo}-${r.side ?? ''}`} loading={q.isLoading} dataSource={items} pagination={false} scroll={{ x: 'max-content', y: 560 }}
          columns={[
            { title: '行', dataIndex: 'rowNo', width: 56 },
            { title: '项目', dataIndex: 'itemName', width: 260, render: (v: string, r) => <span style={{ fontWeight: r.itemType === 'detail' ? 400 : 600 }}>{v}</span> },
            { title: '语义', dataIndex: 'semanticKey', width: 180, render: (v: string | null) => (v ? <Typography.Text code>{v}</Typography.Text> : null) },
            ...factKeys.map((k) => ({
              title: factName.get(k) ?? k, key: k, width: 160, align: 'right' as const,
              render: (_: unknown, r: StatementItemDto) => {
                const f = r.facts.find((x) => x.fieldKey === k);
                if (!f) return null;
                const title = [f.sourceCell, f.formulaText ? `公式 ${f.formulaText}` : ''].filter(Boolean).join(' · ');
                return <span title={title}>{f.amount != null ? <Money value={f.amount} /> : f.textValue ? <Typography.Text type="warning">{f.textValue}</Typography.Text> : null}</span>;
              },
            })),
          ]}
        />
      )}
    </Drawer>
  );
}

function BatchesTab() {
  const { message } = AntdApp.useApp();
  const qc = useQueryClient();
  const [orgId, setOrgId] = useState<number | undefined>(defaultOrgId());
  const [period, setPeriod] = useState<string | undefined>();
  const [view, setView] = useState<StatementBatchDto | null>(null);
  const linkedBatch = useBatchDeepLink('statements', statementApi.batch, setView);
  useAssistantDomainPage({ pageKey: 'statements', ready: true, scope: { orgScopeId: orgId, period: view?.period ?? period, statementScope: view?.scope, statementBatchId: view?.id }, view: { tab: 'batches', historicalBatchId: view?.id } });
  const [prompt, holder] = usePrompt();
  const list = useQuery({ queryKey: ['stmt-batches', orgId, period], queryFn: () => statementApi.batches({ orgId, period }) });
  const refresh = () => {
    for (const key of ['stmt-batches', 'stmt-overview', 'stmt-trends']) void qc.invalidateQueries({ queryKey: [key] });
  };
  const activate = useMutation({
    mutationFn: (b: StatementBatchDto) => {
      const current = (list.data ?? []).find((x) => x.isCurrent && x.orgId === b.orgId && x.period === b.period && x.scope === b.scope);
      return statementApi.activate(b.id, current?.id ?? null);
    },
    onSuccess: () => { message.success('已激活为当前批次'); refresh(); }, onError: (e) => message.error(errorText(e)),
  });
  const voidBatch = useMutation({ mutationFn: (v: { id: number; reason: string }) => statementApi.void(v.id, v.reason), onSuccess: () => { message.success('已作废'); refresh(); }, onError: (e) => message.error(errorText(e)) });
  const writable = can('statements:import');
  return (
    <>
      {linkedBatch.error && <QueryErrorResult title="来源批次加载失败" error={linkedBatch.error} refetch={linkedBatch.refetch} />}
      {holder}
      <Space wrap style={{ marginBottom: 12 }}>
        <OrgSelect value={orgId} onChange={setOrgId} />
        <PeriodPicker value={period} onChange={setPeriod} />
      </Space>
      {list.error ? <QueryErrorResult title="财报批次加载失败" error={list.error} refetch={list.refetch} /> : (
        <Table<StatementBatchDto>
          rowKey="id" size="small" loading={list.isLoading} dataSource={list.data ?? []} pagination={{ pageSize: 20, showSizeChanger: false }}
          expandable={{ rowExpandable: (b) => b.checks.length > 0, expandedRowRender: (b) => <ChecksTable checks={b.checks} /> }}
          columns={[
            { title: '批次', dataIndex: 'id', width: 70, render: (v: number) => `#${v}` },
            { title: '单位', dataIndex: 'orgName', width: 160 },
            { title: '期间', dataIndex: 'period', width: 90 },
            { title: '口径', dataIndex: 'scope', width: 80, render: (v: StatementScope) => SCOPE_LABEL[v] },
            { title: '文件', dataIndex: 'fileName', ellipsis: true },
            { title: '表项/事实', width: 100, render: (_: unknown, b) => `${b.itemCount} / ${b.factCount}` },
            { title: '警告', dataIndex: 'warningCount', width: 60, align: 'right' },
            { title: '状态', dataIndex: 'status', width: 90, render: (v: string) => statusTag(BATCH_STATUS, v) },
            { title: '导入', dataIndex: 'createdAt', width: 130, render: (v: string) => shortTime(v) },
            {
              title: '操作', width: 200, render: (_: unknown, b) => (
                <Space>
                  <a onClick={() => setView(b)}>明细</a>
                  <a onClick={() => void download(`/statements/batches/${b.id}/original`, b.fileName)}>原件</a>
                  {writable && b.status === 'imported' && <Popconfirm title="激活后该单位该期间该口径的总览切换到此批次。确认激活?" onConfirm={() => activate.mutate(b)}><a>激活</a></Popconfirm>}
                  {writable && b.status !== 'voided' && (
                    <a onClick={async () => { const v = await prompt({ title: '作废财报批次', danger: true, fields: [{ name: 'reason', label: '作废原因', required: true, multiline: true }] }); if (v) voidBatch.mutate({ id: b.id, reason: v.reason }); }}>作废</a>
                  )}
                </Space>
              ),
            },
          ]}
        />
      )}
      <ItemsDrawer batch={view} onClose={() => setView(null)} />
    </>
  );
}

function ImportTab() {
  useAssistantDomainPage({ pageKey: 'statements', ready: true, view: { tab: 'import' } });
  const { message } = AntdApp.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm<{ orgId: number; period: string; scope: StatementScope }>();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<StatementPreviewDto | null>(null);
  const fields = () => form.validateFields();
  const doPreview = useMutation({
    mutationFn: async () => statementApi.preview(file!, await fields()),
    onSuccess: setPreview, onError: (e) => message.error(errorText(e)),
  });
  const doImport = useMutation({
    mutationFn: async () => statementApi.importFile(file!, await fields()),
    onSuccess: (b) => {
      message.success(b.replayed ? `同一文件已导入过,返回原批次 #${b.id}` : `已导入批次 #${b.id},请在“批次”页激活`);
      setPreview(null); setFile(null); void qc.invalidateQueries({ queryKey: ['stmt-batches'] });
    },
    onError: (e) => message.error(errorText(e)),
  });
  return (
    <Space direction="vertical" size={16} style={{ width: '100%' }}>
      <Form form={form} layout="inline" initialValues={{ orgId: defaultOrgId(), period: lastPeriod(), scope: 'consolidated' }} onValuesChange={() => setPreview(null)}>
        <Form.Item name="orgId" label="报表单位" rules={[{ required: true, message: '请选择单位' }]}><OrgSelect onChange={(v) => form.setFieldValue('orgId', v)} allowClear={false} /></Form.Item>
        <Form.Item name="period" label="期间" rules={[{ required: true, message: '请选择期间' }]}><PeriodPicker onChange={(v) => form.setFieldValue('period', v)} allowClear={false} /></Form.Item>
        <Form.Item name="scope" label="口径" rules={[{ required: true }]}><Select options={scopeOptions} style={{ width: 110 }} /></Form.Item>
        <Form.Item>
          <Upload accept=".xlsx" maxCount={1} beforeUpload={(f) => { setFile(f); setPreview(null); return false; }} onRemove={() => { setFile(null); setPreview(null); }} fileList={file ? [{ uid: '1', name: file.name, status: 'done' }] : []}>
            <Button icon={<i className="ri-file-excel-2-line" aria-hidden />}>选择四表模板 .xlsx</Button>
          </Upload>
        </Form.Item>
        <Button onClick={() => doPreview.mutate()} disabled={!file} loading={doPreview.isPending}>预览</Button>
      </Form>
      {preview && (
        <Card size="small" title={<Space>预览结果{preview.valid ? <Tag color="success">可导入</Tag> : <Tag color="error">有错误,不能导入</Tag>}</Space>}
          extra={<Button type="primary" disabled={!preview.valid} loading={doImport.isPending} onClick={() => doImport.mutate()}>确认导入</Button>}>
          <Space direction="vertical" size={12} style={{ width: '100%' }}>
            <Typography.Text type="secondary">
              {preview.sheets.map((s) => `${s.name} ${s.itemCount} 项`).join(' · ')};共 {preview.itemCount} 项 {preview.factCount} 个事实
              {preview.ignoredSheets.length ? `;忽略工作表:${preview.ignoredSheets.join('、')}` : ''}
            </Typography.Text>
            <ChecksTable checks={preview.checks} />
            <MetricGrid metrics={preview.metrics} codes={HEADLINE} />
          </Space>
        </Card>
      )}
      {!preview && <Alert type="info" showIcon message="预览只解析不写库;导入时有错误会被拒绝(STATEMENT_INVALID),同一单位+期间+口径+文件重复导入返回原批次。" />}
    </Space>
  );
}

export default function Statements() {
  const [params, setParams] = useSearchParams();
  const tab = ['overview','trends','batches','import'].includes(params.get('tab') ?? '') ? params.get('tab')! : 'overview';
  return (
    <Tabs destroyInactiveTabPane activeKey={tab} onChange={(key) => setParams((previous) => { const next = new URLSearchParams(previous); next.set('tab', key); return next; }, { replace: true })}
      items={[
        { key: 'overview', label: '总览', children: <OverviewTab /> },
        { key: 'trends', label: '趋势', children: <TrendsTab /> },
        { key: 'batches', label: '批次', children: <BatchesTab /> },
        ...(can('statements:import') ? [{ key: 'import', label: '导入', children: <ImportTab /> }] : []),
      ]}
    />
  );
}
