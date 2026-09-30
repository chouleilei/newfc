import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert, App as AntdApp, Button, Card, Col, Descriptions, Drawer, Empty, Form, Input, InputNumber, Modal, Row, Select, Space, Table, Tabs, Tag, Typography, Upload,
} from 'antd';
import { api, can, download, errorText } from '../../api/client';
import {
  feasibilityApi, waitJob, type FeasCheckDto, type FeasImportDto, type FeasIndicatorDto, type FeasibilityAssumptionsInput, type FeasProjectDetailDto,
  type FeasProjectDto, type FeasResultDto, type FeasRunDetailDto, type FeasRunSummaryDto, type FeasScenarioDto, type FeasSensitivityItemDto,
} from '../../api/riskInvestment';
import { QueryErrorResult } from '../../components/QueryErrorResult';
import { shortTime } from '../../utils/relativeTime';
import { compact, defaultOrgId, OrgSelect, statusTag, usePrompt } from '../financeData/shared';
import { Dec, FEAS_INDICATOR_STATUS, RowErrors, SENSITIVITY_LABEL, StaleTag } from './shared';

/**
 * AC-F12 投资可行性测算:项目 → 方案(页面编辑或标准模板导入)→ 测算(冻结运行)→ 敏感性分析(后台任务)→ 结果导出。
 * 金额单位万元,比率为小数;所有数值为十进制字符串,页面只做排版。当前结果取最新成功运行,参数变更后提示需重算。
 */

const decRule = { pattern: /^-?\d{1,12}(\.\d{1,6})?$/, message: '最多 6 位小数' };
const DecInput = (props: { placeholder?: string; disabled?: boolean; value?: string; onChange?: (v: string) => void }) => (
  <Input value={props.value ?? ''} onChange={(e) => props.onChange?.(e.target.value)} placeholder={props.placeholder} disabled={props.disabled} style={{ fontVariantNumeric: 'tabular-nums' }} />
);

interface MasterOption { id: number; code: string | null; name: string }

/* ---------------- 方案输入编辑 ---------------- */

const INVEST_FIELDS: [string, string][] = [
  ['engineering_cost', '工程费'], ['equipment_cost', '设备费'], ['land_resettlement_cost', '征地移民'], ['preliminary_cost', '前期费'],
  ['design_supervision_cost', '设计监理'], ['other_cost', '其他'], ['contingency', '预备费'], ['working_capital', '流动资金'],
];
const SCALARS: { section: string; title: string; fields: [string, string, 'dec' | 'int' | 'select', { value: string; label: string }[]?][] }[] = [
  {
    section: 'evaluation', title: '评价参数', fields: [
      ['discount_rate', '折现率', 'dec'], ['benchmark_irr', '基准收益率', 'dec'], ['min_dscr', '最低偿债覆盖率', 'dec'], ['horizon_years', '评价年限', 'int'],
      ['terminal_recovery', '期末回收(万元)', 'dec'], ['affordability_warning_score', '可承受评分阈值', 'dec'],
    ],
  },
  {
    section: 'financing', title: '融资', fields: [
      ['debt_ratio', '债务比例', 'dec'], ['loan_interest_rate', '贷款利率', 'dec'], ['total_loan_years', '贷款总期限(年)', 'int'], ['operation_repayment_years', '运营偿还期(年)', 'int'],
      ['repayment_method', '还款方式', 'select', [{ value: 'equal_principal', label: '等额本金' }, { value: 'equal_payment', label: '等额本息' }, { value: 'bullet', label: '到期一次还本' }]],
    ],
  },
  {
    section: 'tax', title: '税费', fields: [
      ['vat_rate', '增值税率', 'dec'], ['surcharge_rate', '附加税率', 'dec'], ['income_tax_rate', '所得税率', 'dec'], ['opening_input_vat_credit', '期初进项留抵(万元)', 'dec'],
      ['water_resource_tax_yuan_per_kwh', '水资源税(元/kWh)', 'dec'], ['water_construction_fund_rate', '水利建设基金费率', 'dec'], ['loss_carryforward_years', '亏损结转年限', 'int'],
    ],
  },
  {
    section: 'depreciation', title: '折旧', fields: [
      ['depreciable_base', '折旧基数(万元,空为自动)', 'dec'], ['residual_rate', '残值率', 'dec'], ['useful_life_years', '折旧年限', 'int'],
    ],
  },
];

function AssumptionsEditor({ scenario, editable, onSaved }: { scenario: FeasScenarioDto; editable: boolean; onSaved: (s: FeasScenarioDto) => void }) {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm();
  const [json, setJson] = useState('');
  useEffect(() => { form.resetFields(); setJson(JSON.stringify(scenario.assumptions, null, 2)); }, [scenario, form]);
  const save = useMutation({
    mutationFn: (assumptions: FeasibilityAssumptionsInput) => feasibilityApi.updateScenario(scenario.id, { expectedVersion: scenario.version, assumptions }),
    onSuccess: (s) => { message.success('已保存,结果需重新测算'); onSaved(s); },
    onError: (e) => message.error(errorText(e)),
  });
  const saveForm = () => form.validateFields().then(() => {
    // getFieldsValue(true) 含未在表单展示的字段(依据说明、融资计划、分年成本等),保存时原样带回
    const v = form.getFieldsValue(true) as Record<string, unknown>;
    const clean = (o: unknown): unknown => Array.isArray(o) ? o.map(clean)
      : o && typeof o === 'object' ? Object.fromEntries(Object.entries(o).filter(([, x]) => x !== '' && x !== undefined).map(([k, x]) => [k, clean(x)])) : o;
    save.mutate(clean(v) as FeasibilityAssumptionsInput);
  });
  const saveJson = () => {
    try { save.mutate(JSON.parse(json) as FeasibilityAssumptionsInput); } catch (e) { message.error(`JSON 格式错误:${(e as Error).message}`); }
  };
  const disabled = !editable;
  return (
    <Form form={form} layout="vertical" initialValues={scenario.assumptions as Record<string, unknown>} disabled={disabled}>
      <Tabs size="small" items={[
        {
          key: 'scalars', label: '标量参数',
          children: SCALARS.map((g) => (
            <Card key={g.section} size="small" title={g.title} style={{ marginBottom: 8 }}>
              <Row gutter={12}>
                {g.fields.map(([name, label, kind, options]) => (
                  <Col key={name} xs={12} md={6}>
                    <Form.Item name={[g.section, name]} label={label} rules={kind === 'dec' ? [decRule] : []}>
                      {kind === 'int' ? <InputNumber min={0} max={100} style={{ width: '100%' }} /> : kind === 'select' ? <Select options={options} /> : <DecInput />}
                    </Form.Item>
                  </Col>
                ))}
              </Row>
            </Card>
          )),
        },
        {
          key: 'investment', label: '分年投资',
          children: (
            <Form.List name="investment_plan">
              {(fields, { add, remove }) => (
                <>
                  <Table size="small" pagination={false} rowKey="key" dataSource={fields} scroll={{ x: 1300 }} columns={[
                    { title: '年份', width: 100, render: (_: unknown, f) => <Form.Item noStyle name={[f.name, 'fiscal_year']} rules={[{ required: true }]}><InputNumber min={2000} max={2100} /></Form.Item> },
                    ...INVEST_FIELDS.map(([k, label]) => ({
                      title: `${label}(万元)`, width: 130,
                      render: (_: unknown, f: { name: number }) => <Form.Item noStyle name={[f.name, k]} rules={[decRule]}><DecInput placeholder="0" /></Form.Item>,
                    })),
                    { title: '', width: 50, render: (_: unknown, f) => <Button type="text" danger disabled={disabled} onClick={() => remove(f.name)} aria-label="删除"><i className="ri-delete-bin-line" aria-hidden /></Button> },
                  ]} />
                  <Button type="dashed" style={{ marginTop: 8 }} disabled={disabled} onClick={() => { const rows = (form.getFieldValue('investment_plan') as { fiscal_year: number }[] | undefined) ?? []; add({ fiscal_year: rows.length ? Number(rows[rows.length - 1].fiscal_year) + 1 : new Date().getFullYear() }); }}>添加年度</Button>
                </>
              )}
            </Form.List>
          ),
        },
        {
          key: 'revenue', label: '收入',
          children: (
            <Form.List name="revenue_items">
              {(fields, { add, remove }) => (
                <>
                  <Table size="small" pagination={false} rowKey="key" dataSource={fields} scroll={{ x: 1300 }} columns={[
                    { title: '名称', width: 140, render: (_: unknown, f) => <Form.Item noStyle name={[f.name, 'name']} rules={[{ required: true }]}><Input /></Form.Item> },
                    { title: '方式', width: 120, render: (_: unknown, f) => <Form.Item noStyle name={[f.name, 'mode']}><Select style={{ width: 110 }} options={[{ value: 'power', label: '发电' }, { value: 'fixed_amount', label: '固定金额' }]} /></Form.Item> },
                    { title: '起年', width: 100, render: (_: unknown, f) => <Form.Item noStyle name={[f.name, 'start_year']} rules={[{ required: true }]}><InputNumber min={2000} max={2100} /></Form.Item> },
                    { title: '止年', width: 100, render: (_: unknown, f) => <Form.Item noStyle name={[f.name, 'end_year']}><InputNumber min={2000} max={2100} /></Form.Item> },
                    { title: '发电量(万kWh)', width: 130, render: (_: unknown, f) => <Form.Item noStyle name={[f.name, 'power_generation_10k_kwh']} rules={[decRule]}><DecInput /></Form.Item> },
                    { title: '电价(元/kWh)', width: 120, render: (_: unknown, f) => <Form.Item noStyle name={[f.name, 'electricity_price_yuan_per_kwh']} rules={[decRule]}><DecInput /></Form.Item> },
                    { title: '年度金额(万元)', width: 130, render: (_: unknown, f) => <Form.Item noStyle name={[f.name, 'annual_amount']} rules={[decRule]}><DecInput /></Form.Item> },
                    { title: '增长率', width: 100, render: (_: unknown, f) => <Form.Item noStyle name={[f.name, 'growth_rate']} rules={[decRule]}><DecInput placeholder="0" /></Form.Item> },
                    { title: '价格口径', width: 110, render: (_: unknown, f) => <Form.Item noStyle name={[f.name, 'price_tax_mode']}><Select style={{ width: 100 }} options={[{ value: 'tax_inclusive', label: '含税' }, { value: 'tax_exclusive', label: '不含税' }]} /></Form.Item> },
                    { title: '', width: 50, render: (_: unknown, f) => <Button type="text" danger disabled={disabled} onClick={() => remove(f.name)} aria-label="删除"><i className="ri-delete-bin-line" aria-hidden /></Button> },
                  ]} />
                  <Button type="dashed" style={{ marginTop: 8 }} disabled={disabled} onClick={() => add({ name: '', mode: 'fixed_amount', start_year: new Date().getFullYear(), growth_rate: '0', price_tax_mode: 'tax_inclusive', taxable_for_vat: true })}>添加收入</Button>
                </>
              )}
            </Form.List>
          ),
        },
        {
          key: 'cost', label: '成本',
          children: (
            <Form.List name="cost_items">
              {(fields, { add, remove }) => (
                <>
                  <Table size="small" pagination={false} rowKey="key" dataSource={fields} scroll={{ x: 1300 }} columns={[
                    { title: '名称', width: 140, render: (_: unknown, f) => <Form.Item noStyle name={[f.name, 'name']} rules={[{ required: true }]}><Input /></Form.Item> },
                    { title: '方式', width: 130, render: (_: unknown, f) => <Form.Item noStyle name={[f.name, 'mode']}><Select style={{ width: 120 }} options={[{ value: 'fixed_amount', label: '固定金额' }, { value: 'revenue_rate', label: '收入比例' }, { value: 'yearly_amount', label: '分年金额(JSON)' }]} /></Form.Item> },
                    { title: '起年', width: 100, render: (_: unknown, f) => <Form.Item noStyle name={[f.name, 'start_year']} rules={[{ required: true }]}><InputNumber min={2000} max={2100} /></Form.Item> },
                    { title: '止年', width: 100, render: (_: unknown, f) => <Form.Item noStyle name={[f.name, 'end_year']}><InputNumber min={2000} max={2100} /></Form.Item> },
                    { title: '年度金额(万元)', width: 130, render: (_: unknown, f) => <Form.Item noStyle name={[f.name, 'annual_amount']} rules={[decRule]}><DecInput /></Form.Item> },
                    { title: '收入比例', width: 100, render: (_: unknown, f) => <Form.Item noStyle name={[f.name, 'revenue_rate']} rules={[decRule]}><DecInput /></Form.Item> },
                    { title: '增长率', width: 100, render: (_: unknown, f) => <Form.Item noStyle name={[f.name, 'growth_rate']} rules={[decRule]}><DecInput placeholder="0" /></Form.Item> },
                    { title: '进项税率', width: 100, render: (_: unknown, f) => <Form.Item noStyle name={[f.name, 'input_vat_rate']} rules={[decRule]}><DecInput placeholder="0" /></Form.Item> },
                    { title: '', width: 50, render: (_: unknown, f) => <Button type="text" danger disabled={disabled} onClick={() => remove(f.name)} aria-label="删除"><i className="ri-delete-bin-line" aria-hidden /></Button> },
                  ]} />
                  <Button type="dashed" style={{ marginTop: 8 }} disabled={disabled} onClick={() => add({ name: '', mode: 'fixed_amount', start_year: new Date().getFullYear(), growth_rate: '0', amount_tax_mode: 'tax_exclusive', input_vat_rate: '0', yearly_amounts: [] })}>添加成本</Button>
                </>
              )}
            </Form.List>
          ),
        },
        {
          key: 'json', label: '全部参数(JSON)',
          children: (
            <Space direction="vertical" style={{ width: '100%' }}>
              <Typography.Text type="secondary">包含依据说明、融资计划、年度进项税、分年成本与敏感性变量等全部输入;按 JSON 保存时整体替换。</Typography.Text>
              <Input.TextArea value={json} onChange={(e) => setJson(e.target.value)} rows={18} style={{ fontFamily: 'monospace', fontSize: 12 }} disabled={disabled} />
              {editable && <Button onClick={saveJson} loading={save.isPending}>按 JSON 保存</Button>}
            </Space>
          ),
        },
      ]} />
      {editable && <Button type="primary" onClick={() => void saveForm()} loading={save.isPending}>保存参数</Button>}
    </Form>
  );
}

/* ---------------- 运行结果 ---------------- */

const CASHFLOW_COLUMNS: [string, string][] = [
  ['investment', '建设投资'], ['revenue', '含税收入'], ['revenue_excluding_vat', '不含税收入'], ['output_vat', '销项税'], ['vat_paid', '实缴增值税'],
  ['vat_credit_closing', '期末留抵'], ['operating_cost', '运营成本'], ['depreciation', '折旧'], ['tax', '税费合计'], ['debt_drawdown', '借款'],
  ['debt_principal', '还本'], ['debt_interest', '付息'], ['debt_balance', '债务余额'], ['cfads', 'CFADS'], ['dscr', 'DSCR'],
  ['project_net_cashflow', '项目净现金流'], ['project_discounted_cashflow', '项目折现'], ['equity_net_cashflow', '股权净现金流'], ['funding_gap', '资金缺口'],
];

function IndicatorTable({ items }: { items: FeasIndicatorDto[] }) {
  return (
    <Table<FeasIndicatorDto> rowKey="code" size="small" pagination={false} dataSource={items} columns={[
      { title: '指标', dataIndex: 'name', width: 180 },
      { title: '数值', dataIndex: 'value', align: 'right', render: (v: string | null) => <Dec value={v} /> },
      { title: '单位', dataIndex: 'unit', width: 80 },
      { title: '状态', dataIndex: 'status', width: 80, render: (v: string) => statusTag(FEAS_INDICATOR_STATUS, v) },
    ]} />
  );
}

function RunResult({ run }: { run: FeasRunDetailDto }) {
  if (run.status !== 'succeeded' || !run.result) return <Alert type="error" showIcon message="测算失败" description={run.errorMessage} />;
  if (run.kind === 'sensitivity') {
    const r = run.result as { baseIndicators: FeasIndicatorDto[]; items: FeasSensitivityItemDto[] };
    const codes = ['project_npv', 'project_irr', 'equity_irr', 'min_dscr'];
    const names = new Map(r.baseIndicators.map((i) => [i.code, i.name]));
    return (
      <Table rowKey={(x) => `${x.code}:${x.change}`} size="small" pagination={false} dataSource={r.items} scroll={{ x: 900 }} columns={[
        { title: '变量', dataIndex: 'code', width: 130, render: (v: string) => SENSITIVITY_LABEL[v] ?? v },
        { title: '变动', dataIndex: 'change', width: 90, render: (v: string, x) => (x.mode === 'relative' ? `${v}(相对)` : v) },
        ...codes.map((c) => ({
          title: `${names.get(c) ?? c} 变化`, key: c, align: 'right' as const,
          render: (_: unknown, x: FeasSensitivityItemDto) => (x.status === 'failed' ? <Tag color="error" title={x.error}>失败</Tag> : <Dec value={x.indicators.find((i) => i.code === c)?.delta ?? null} />),
        })),
      ]} />
    );
  }
  const res = run.result as FeasResultDto;
  return (
    <Tabs size="small" items={[
      { key: 'ind', label: '指标', children: <IndicatorTable items={res.indicators} /> },
      {
        key: 'checks', label: `检查${res.allChecksPassed ? '' : '(有未通过)'}`,
        children: (
          <Table<FeasCheckDto> rowKey="code" size="small" pagination={false} dataSource={res.checks} columns={[
            { title: '检查', dataIndex: 'code', width: 220 },
            { title: '结果', dataIndex: 'passed', width: 90, render: (v: boolean, c) => (v ? <Tag color="success">通过</Tag> : <Tag color={c.severity === 'error' ? 'error' : 'warning'}>未通过</Tag>) },
            { title: '说明', dataIndex: 'message' },
          ]} />
        ),
      },
      {
        key: 'cf', label: '逐年现金流(万元)',
        children: (
          <Table rowKey={(r) => String(r.fiscal_year)} size="small" pagination={false} dataSource={res.cashflows} scroll={{ x: 2400, y: 420 }} columns={[
            { title: '年份', dataIndex: 'fiscal_year', width: 70, fixed: 'left' },
            ...CASHFLOW_COLUMNS.map(([k, t]) => ({ title: t, dataIndex: k, width: 120, align: 'right' as const, render: (v: string | null) => <Dec value={v} /> })),
          ]} />
        ),
      },
      { key: 'meta', label: '口径', children: <Descriptions size="small" column={1}><Descriptions.Item label="模型">{res.modelVersion}</Descriptions.Item><Descriptions.Item label="舍入">{res.roundingRule}</Descriptions.Item><Descriptions.Item label="折现基准年">{res.discountBaseYear}</Descriptions.Item><Descriptions.Item label="参数 hash">{res.parameterHash}</Descriptions.Item></Descriptions> },
    ]} />
  );
}

function RunModal({ runId, onClose }: { runId: number | null; onClose: () => void }) {
  const q = useQuery({ queryKey: ['feas-run', runId], queryFn: () => feasibilityApi.runDetail(runId!), enabled: runId != null });
  return (
    <Modal open={runId != null} onCancel={onClose} footer={null} width={1100} title={q.data ? `运行 #${q.data.id} · ${q.data.kind === 'base' ? '基准测算' : '敏感性分析'} · ${shortTime(q.data.createdAt)}` : '运行'} destroyOnClose>
      {q.error ? <QueryErrorResult title="运行加载失败" error={q.error} refetch={q.refetch} /> : q.data && <RunResult run={q.data} />}
    </Modal>
  );
}

function ScenarioDrawer({ id, onClose }: { id: number | null; onClose: () => void }) {
  const { message } = AntdApp.useApp();
  const qc = useQueryClient();
  const [prompt, holder] = usePrompt();
  const [runId, setRunId] = useState<number | null>(null);
  const [sensBusy, setSensBusy] = useState(false);
  const q = useQuery({ queryKey: ['feas-scenario', id], queryFn: () => feasibilityApi.scenario(id!), enabled: id != null });
  const runs = useQuery({ queryKey: ['feas-runs', id], queryFn: () => feasibilityApi.runs(id!), enabled: id != null });
  const s = q.data;
  const latestOk = (runs.data?.items ?? []).find((r) => r.kind === 'base' && r.status === 'succeeded');
  const current = useQuery({ queryKey: ['feas-run', latestOk?.id], queryFn: () => feasibilityApi.runDetail(latestOk!.id), enabled: !!latestOk });
  const writable = can('investment:write') && s?.project.status === 'active';
  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['feas-scenario', id] }); void qc.invalidateQueries({ queryKey: ['feas-runs', id] });
    void qc.invalidateQueries({ queryKey: ['feas-project'] });
  };
  const run = useMutation({
    mutationFn: () => feasibilityApi.run(s!.id, s!.version),
    onSuccess: (r) => { if (r.status === 'succeeded') message.success('测算完成,结果已冻结'); else message.error(`测算失败:${r.errorMessage ?? ''}`); refresh(); },
    onError: (e) => { message.error(errorText(e)); refresh(); },
  });
  const sensitivity = async () => {
    if (!s) return;
    setSensBusy(true);
    try {
      const { jobId } = await feasibilityApi.sensitivity(s.id, { expectedVersion: s.version });
      message.info('敏感性分析已提交后台任务');
      const job = await waitJob(jobId);
      if (job.status === 'succeeded') message.success('敏感性分析完成'); else message.error(`敏感性分析失败:${job.error?.message ?? job.status}`);
      refresh();
    } catch (e) { message.error(errorText(e)); } finally { setSensBusy(false); }
  };
  const copy = async () => {
    if (!s) return;
    const v = await prompt({ title: '复制方案', fields: [{ name: 'code', label: '新方案编码', required: true }, { name: 'name', label: '新方案名称', required: true, initial: `${s.name}(副本)` }] });
    if (!v) return;
    try { const c = await feasibilityApi.copyScenario(s.id, { code: v.code, name: v.name }); message.success(`已复制为 ${c.code}`); void qc.invalidateQueries({ queryKey: ['feas-project'] }); } catch (e) { message.error(errorText(e)); }
  };
  return (
    <Drawer open={id != null} onClose={onClose} width={1180} destroyOnClose title={s ? `${s.project.code} · ${s.code} ${s.name}` : '方案'}
      extra={s && (
        <Space wrap>
          <StaleTag stale={s.stale} />
          {writable && <Button type="primary" loading={run.isPending} onClick={() => run.mutate()}>测算</Button>}
          {writable && <Button loading={sensBusy} onClick={() => void sensitivity()}>敏感性分析</Button>}
          {writable && <Button onClick={() => void copy()}>复制方案</Button>}
          <Button onClick={() => void download(feasibilityApi.templatePath(s.id), `${s.project.code}-${s.code}-测算输入.xlsx`)}>导出输入模板</Button>
        </Space>
      )}>
      {holder}
      {q.error ? <QueryErrorResult title="方案加载失败" error={q.error} refetch={q.refetch} /> : !s ? null : (
        <Tabs items={[
          {
            key: 'result', label: '当前结果',
            children: !latestOk ? <Empty description="尚无成功测算,请先测算" /> : (
              <Space direction="vertical" style={{ width: '100%' }}>
                {s.stale && <Alert type="warning" showIcon message="参数已修改,结果需重算" description={`下方为运行 #${latestOk.id}(${shortTime(latestOk.createdAt)})的冻结结果。`} />}
                <Space>
                  <Typography.Text type="secondary">运行 #{latestOk.id} · {latestOk.createdBy ?? ''} · {shortTime(latestOk.createdAt)}</Typography.Text>
                  <Button size="small" onClick={() => void download(feasibilityApi.exportPath(latestOk.id), `${s.project.code}-${s.code}-测算结果.xlsx`)}>导出结果</Button>
                </Space>
                {current.data && <RunResult run={current.data} />}
              </Space>
            ),
          },
          { key: 'input', label: '输入参数', children: <AssumptionsEditor scenario={s} editable={!!writable} onSaved={refresh} /> },
          {
            key: 'runs', label: `运行历史(${runs.data?.items.length ?? 0})`,
            children: (
              <Table<FeasRunSummaryDto> rowKey="id" size="small" loading={runs.isLoading} dataSource={runs.data?.items ?? []} columns={[
                { title: '#', dataIndex: 'id', width: 70 },
                { title: '类型', dataIndex: 'kind', width: 100, render: (v: string) => (v === 'base' ? '基准测算' : '敏感性') },
                { title: '状态', dataIndex: 'status', width: 80, render: (v: string) => (v === 'succeeded' ? <Tag color="success">成功</Tag> : <Tag color="error">失败</Tag>) },
                { title: '检查', dataIndex: 'allChecksPassed', width: 90, render: (v: boolean | null) => (v == null ? '—' : v ? '全部通过' : <Tag color="warning">有未通过</Tag>) },
                { title: '方案版本', dataIndex: 'scenarioVersion', width: 90 },
                { title: '参数 hash', dataIndex: 'parameterHash', ellipsis: true, render: (v: string) => <Typography.Text code>{v.slice(0, 12)}</Typography.Text> },
                { title: '运行人', dataIndex: 'createdBy', width: 100 },
                { title: '时间', dataIndex: 'createdAt', width: 140, render: (v: string) => shortTime(v) },
                {
                  title: '', key: 'op', width: 140, render: (_: unknown, r) => (
                    <Space>
                      <Button size="small" onClick={() => setRunId(r.id)}>查看</Button>
                      {r.status === 'succeeded' && <Button size="small" onClick={() => void download(feasibilityApi.exportPath(r.id), `${s.project.code}-${s.code}-运行${r.id}.xlsx`)}>导出</Button>}
                    </Space>
                  ),
                },
              ]} />
            ),
          },
        ]} />
      )}
      <RunModal runId={runId} onClose={() => setRunId(null)} />
    </Drawer>
  );
}

/* ---------------- 项目 ---------------- */

function ImportModal({ project, open, onClose }: { project: FeasProjectDto; open: boolean; onClose: () => void }) {
  const { message } = AntdApp.useApp();
  const qc = useQueryClient();
  const [preview, setPreview] = useState<FeasImportDto | null>(null);
  const [form] = Form.useForm<{ code: string; name: string }>();
  const upload = useMutation({ mutationFn: (f: File) => feasibilityApi.previewImport(project.id, f), onSuccess: setPreview, onError: (e) => message.error(errorText(e)) });
  const confirm = useMutation({
    mutationFn: (v: { code: string; name: string }) => feasibilityApi.confirmImport(preview!.id, { sha256: preview!.sha256, ...v }),
    onSuccess: () => { message.success('已按模板创建方案'); void qc.invalidateQueries({ queryKey: ['feas-project', project.id] }); setPreview(null); onClose(); },
    onError: (e) => message.error(errorText(e)),
  });
  const ok = preview && !preview.errors.length && preview.assumptions;
  return (
    <Modal open={open} title={`导入标准模板 · ${project.name}`} width={760} onCancel={() => { setPreview(null); onClose(); }} destroyOnClose
      okButtonProps={{ disabled: !ok }} okText="确认创建方案" confirmLoading={confirm.isPending} onOk={() => form.validateFields().then((v) => confirm.mutate(v))}>
      <Space direction="vertical" style={{ width: '100%' }}>
        <Space>
          <Upload accept=".xlsx" showUploadList={false} beforeUpload={(f) => { upload.mutate(f); return false; }}><Button loading={upload.isPending}>选择 .xlsx 预览</Button></Upload>
          <Button type="link" onClick={() => void download(feasibilityApi.templatePath(), '可行性测算标准模板.xlsx')}>下载空白模板</Button>
        </Space>
        <Typography.Text type="secondary">输入区禁止公式;未知工作表或列会报错。确认时核对文件 sha256 并按原件重新解析。</Typography.Text>
        {preview && <RowErrors errors={preview.errors} title="模板校验未通过" />}
        {ok && (
          <>
            <Alert type="success" showIcon message={`校验通过:${preview.fileName}`} description={`建设投资 ${preview.assumptions!.investment_plan.length} 年、收入 ${preview.assumptions!.revenue_items?.length ?? 0} 项、成本 ${preview.assumptions!.cost_items?.length ?? 0} 项`} />
            <Form form={form} layout="inline">
              <Form.Item name="code" label="方案编码" rules={[{ required: true, whitespace: true }]}><Input maxLength={64} /></Form.Item>
              <Form.Item name="name" label="方案名称" rules={[{ required: true, whitespace: true }]}><Input maxLength={128} /></Form.Item>
            </Form>
          </>
        )}
      </Space>
    </Modal>
  );
}

function ProjectFormModal({ open, project, onClose, onSaved }: { open: boolean; project?: FeasProjectDto; onClose: () => void; onSaved: (p: FeasProjectDto) => void }) {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm();
  const masters = useQuery({ queryKey: ['master-options', 'projects'], queryFn: () => api.get<MasterOption[]>('/master/projects'), enabled: open && !project, staleTime: 60_000 });
  const save = useMutation({
    mutationFn: (v: Record<string, unknown>) => (project
      ? feasibilityApi.updateProject(project.id, { ...compact({ name: v.name, description: v.description, constructionStartYear: v.constructionStartYear, operationStartYear: v.operationStartYear, horizonYears: v.horizonYears }), expectedVersion: project.version })
      : feasibilityApi.createProject(compact(v))),
    onSuccess: (p) => { message.success(project ? '已保存' : `已创建项目 ${p.code}`); onSaved(p); onClose(); },
    onError: (e) => message.error(errorText(e)),
  });
  const y = new Date().getFullYear();
  return (
    <Modal open={open} title={project ? `编辑项目 ${project.code}` : '新建测算项目'} width={680} onCancel={onClose} destroyOnClose confirmLoading={save.isPending}
      onOk={() => form.validateFields().then((v) => save.mutate(v))}>
      <Form form={form} layout="vertical" preserve={false} initialValues={project ?? { orgId: defaultOrgId(), constructionStartYear: y, operationStartYear: y + 2, horizonYears: 30 }}>
        <Row gutter={12}>
          <Col span={12}><Form.Item name="code" label="项目编码" rules={[{ required: true, whitespace: true }]}><Input maxLength={64} disabled={!!project} /></Form.Item></Col>
          <Col span={12}><Form.Item name="name" label="项目名称" rules={[{ required: true, whitespace: true }]}><Input maxLength={128} /></Form.Item></Col>
          {!project && <Col span={12}><Form.Item name="orgId" label="组织" rules={[{ required: true, message: '请选择组织' }]}><OrgSelect onChange={(v) => form.setFieldValue('orgId', v)} width={290} allowClear={false} /></Form.Item></Col>}
          {!project && (
            <Col span={12}>
              <Form.Item name="mdProjectId" label="关联主数据项目(可选)" extra="关联后组织取主数据项目的组织">
                <Select allowClear showSearch optionFilterProp="label" loading={masters.isLoading} options={(masters.data ?? []).map((m) => ({ value: m.id, label: `${m.name}${m.code ? `(${m.code})` : ''}` }))} />
              </Form.Item>
            </Col>
          )}
          <Col span={8}><Form.Item name="constructionStartYear" label="建设起年" rules={[{ required: true }]}><InputNumber min={2000} max={2100} style={{ width: '100%' }} /></Form.Item></Col>
          <Col span={8}><Form.Item name="operationStartYear" label="运营起年" rules={[{ required: true }]}><InputNumber min={2000} max={2100} style={{ width: '100%' }} /></Form.Item></Col>
          <Col span={8}><Form.Item name="horizonYears" label="测算年限" rules={[{ required: true }]}><InputNumber min={1} max={60} style={{ width: '100%' }} /></Form.Item></Col>
          <Col span={24}><Form.Item name="description" label="说明"><Input.TextArea rows={2} maxLength={1000} /></Form.Item></Col>
        </Row>
      </Form>
    </Modal>
  );
}

function ProjectDrawer({ id, onClose, onScenario }: { id: number | null; onClose: () => void; onScenario: (id: number) => void }) {
  const { message } = AntdApp.useApp();
  const qc = useQueryClient();
  const [prompt, holder] = usePrompt();
  const [editing, setEditing] = useState(false);
  const [importing, setImporting] = useState(false);
  const q = useQuery({ queryKey: ['feas-project', id], queryFn: () => feasibilityApi.project(id!), enabled: id != null });
  const p = q.data;
  const writable = can('investment:write') && p?.status === 'active';
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['feas-project', id] }); void qc.invalidateQueries({ queryKey: ['feas-projects'] }); };
  const newScenario = async () => {
    if (!p) return;
    const v = await prompt({ title: '新建方案', description: '以默认参数创建,随后在“输入参数”中编辑;也可用标准模板导入。', fields: [{ name: 'code', label: '方案编码', required: true, initial: 'base' }, { name: 'name', label: '方案名称', required: true, initial: '基准方案' }] });
    if (!v) return;
    try {
      const s = await feasibilityApi.createScenario(p.id, { code: v.code, name: v.name, assumptions: { schema_version: 'standard-1.0', investment_plan: [{ fiscal_year: p.constructionStartYear }] } as FeasibilityAssumptionsInput });
      refresh(); onScenario(s.id);
    } catch (e) { message.error(errorText(e)); }
  };
  const toggleArchive = async () => {
    if (!p) return;
    try { await feasibilityApi.updateProject(p.id, { expectedVersion: p.version, status: p.status === 'active' ? 'archived' : 'active' }); refresh(); } catch (e) { message.error(errorText(e)); }
  };
  return (
    <Drawer open={id != null} onClose={onClose} width={1000} destroyOnClose title={p ? `${p.code} · ${p.name}` : '测算项目'}
      extra={p && can('investment:write') && (
        <Space>
          {writable && <Button type="primary" onClick={() => void newScenario()}>新建方案</Button>}
          {writable && <Button onClick={() => setImporting(true)}>导入模板</Button>}
          {writable && <Button onClick={() => setEditing(true)}>编辑</Button>}
          <Button onClick={() => void toggleArchive()}>{p.status === 'active' ? '归档' : '恢复'}</Button>
        </Space>
      )}>
      {holder}
      {q.error ? <QueryErrorResult title="项目加载失败" error={q.error} refetch={q.refetch} /> : !p ? null : (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          {p.status === 'archived' && <Alert type="info" showIcon message="项目已归档,只读" />}
          <Descriptions size="small" column={3} bordered>
            <Descriptions.Item label="组织">{p.orgName}</Descriptions.Item>
            <Descriptions.Item label="主数据项目">{p.mdProjectCode ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="期间">建设 {p.constructionStartYear} · 运营 {p.operationStartYear} · {p.horizonYears} 年</Descriptions.Item>
            {p.description && <Descriptions.Item label="说明" span={3}>{p.description}</Descriptions.Item>}
          </Descriptions>
          <ScenarioTable project={p} onOpen={onScenario} />
          <ProjectFormModal open={editing} project={p} onClose={() => setEditing(false)} onSaved={refresh} />
          <ImportModal project={p} open={importing} onClose={() => setImporting(false)} />
        </Space>
      )}
    </Drawer>
  );
}

function ScenarioTable({ project, onOpen }: { project: FeasProjectDetailDto; onOpen: (id: number) => void }) {
  const ind = (s: FeasScenarioDto, code: string) => s.latestRun?.indicators?.find((i) => i.code === code)?.value ?? null;
  return (
    <Table<FeasScenarioDto> rowKey="id" size="small" pagination={false} dataSource={project.scenarios} locale={{ emptyText: <Empty description="还没有方案" /> }}
      onRow={(s) => ({ onClick: () => onOpen(s.id), style: { cursor: 'pointer' } })} columns={[
        { title: '编码', dataIndex: 'code', width: 100 },
        { title: '名称', dataIndex: 'name' },
        { title: '来源', dataIndex: 'sourceFileName', width: 150, ellipsis: true, render: (v: string | null) => v ?? '页面编辑' },
        { title: '结果', dataIndex: 'stale', width: 140, render: (v: boolean, s) => (s.latestRun ? <StaleTag stale={v} /> : <Tag>未测算</Tag>) },
        { title: '项目 NPV(万元)', key: 'npv', width: 140, align: 'right', render: (_: unknown, s) => <Dec value={ind(s, 'project_npv')} /> },
        { title: '项目 IRR', key: 'irr', width: 110, align: 'right', render: (_: unknown, s) => <Dec value={ind(s, 'project_irr')} /> },
        { title: '最低 DSCR', key: 'dscr', width: 110, align: 'right', render: (_: unknown, s) => <Dec value={ind(s, 'min_dscr')} /> },
        { title: '更新', dataIndex: 'updatedAt', width: 130, render: (v: string) => shortTime(v) },
      ]} />
  );
}

export default function Feasibility() {
  const [orgId, setOrgId] = useState<number>();
  const [status, setStatus] = useState<'active' | 'archived' | undefined>('active');
  const [keyword, setKeyword] = useState('');
  const [projectId, setProjectId] = useState<number | null>(null);
  const [scenarioId, setScenarioId] = useState<number | null>(null);
  const [creating, setCreating] = useState(false);
  const qc = useQueryClient();
  const query = compact({ orgId, status, keyword: keyword.trim() });
  const list = useQuery({ queryKey: ['feas-projects', query], queryFn: () => feasibilityApi.projects(query) });
  return (
    <div>
      <Space wrap style={{ marginBottom: 12 }}>
        <OrgSelect value={orgId} onChange={setOrgId} />
        <Select allowClear placeholder="状态" style={{ width: 110 }} value={status} onChange={setStatus} options={[{ value: 'active', label: '进行中' }, { value: 'archived', label: '已归档' }]} />
        <Input.Search allowClear placeholder="编码/名称" style={{ width: 200 }} onSearch={setKeyword} />
        {can('investment:write') && <Button type="primary" onClick={() => setCreating(true)}>新建项目</Button>}
        <Button onClick={() => void download(feasibilityApi.templatePath(), '可行性测算标准模板.xlsx')}>下载标准模板</Button>
      </Space>
      {list.error ? <QueryErrorResult title="项目列表加载失败" error={list.error} refetch={list.refetch} /> : (
        <Table<FeasProjectDto> rowKey="id" size="small" loading={list.isLoading} dataSource={list.data?.items ?? []}
          locale={{ emptyText: <Empty description="还没有测算项目" /> }}
          onRow={(p) => ({ onClick: () => setProjectId(p.id), style: { cursor: 'pointer' } })} columns={[
            { title: '编码', dataIndex: 'code', width: 120 },
            { title: '名称', dataIndex: 'name' },
            { title: '组织', dataIndex: 'orgName', width: 130 },
            { title: '建设/运营起年', key: 'years', width: 130, render: (_: unknown, p) => `${p.constructionStartYear} / ${p.operationStartYear}` },
            { title: '年限', dataIndex: 'horizonYears', width: 70 },
            { title: '方案数', dataIndex: 'scenarioCount', width: 80 },
            { title: '状态', dataIndex: 'status', width: 80, render: (v: string) => (v === 'active' ? <Tag color="processing">进行中</Tag> : <Tag>已归档</Tag>) },
            { title: '更新', dataIndex: 'updatedAt', width: 130, render: (v: string) => shortTime(v) },
          ]} />
      )}
      <ProjectFormModal open={creating} onClose={() => setCreating(false)} onSaved={(p) => { void qc.invalidateQueries({ queryKey: ['feas-projects'] }); setProjectId(p.id); }} />
      <ProjectDrawer id={projectId} onClose={() => setProjectId(null)} onScenario={setScenarioId} />
      <ScenarioDrawer id={scenarioId} onClose={() => setScenarioId(null)} />
    </div>
  );
}
