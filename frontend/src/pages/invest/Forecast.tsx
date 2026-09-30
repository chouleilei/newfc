import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert, App as AntdApp, Button, Col, Descriptions, Drawer, Empty, Form, Input, InputNumber, Modal, Row, Select, Space, Table, Tabs, Tag, Typography, Upload,
} from 'antd';
import { ApiError, can, errorText } from '../../api/client';
import {
  forecastApi, type FfCell, type FfModelDto, type FfRunDto, type FfVersionDto, type ForecastDiagnostic, type ForecastOutput, type ForecastParam,
} from '../../api/riskInvestment';
import { QueryErrorResult } from '../../components/QueryErrorResult';
import { useUrlId } from '../../hooks/useUrlId';
import { shortTime } from '../../utils/relativeTime';
import { compact, defaultOrgId, OrgSelect, statusTag, usePrompt } from '../financeData/shared';
import { Dec, FF_RUN_STATUS, FF_VERSION_STATUS } from './shared';

/**
 * AC-F11 财务预测:模型 → 导入 .xlsx 工作簿(受限公式诊断)→ 草稿编辑单元格/参数/输出 → 冻结 → 基准运行 → 情景运行(覆盖参数)→ 与基准对比。
 * 运行在 Worker 中执行,页面轮询运行状态;冻结版本不可改,修改请复制为新草稿。
 */

const DECIMAL = /^-?\d{1,15}(\.\d{1,12})?$/;
const KEY = /^[a-z][a-z0-9_]{0,63}$/;

function cellText(c: FfCell | undefined): string {
  if (!c) return '';
  if ('f' in c) return c.f;
  if ('n' in c) return String(c.n);
  if ('s' in c) return c.s;
  if ('b' in c) return c.b ? 'TRUE' : 'FALSE';
  return c.e;
}
function cellKind(c: FfCell): string {
  return 'f' in c ? '公式' : 'n' in c ? '数值' : 's' in c ? '文本' : 'b' in c ? '逻辑' : '错误';
}
/** 输入文本 → 单元格:= 开头为公式,十进制为数值,TRUE/FALSE 为逻辑,其余为文本;空为清空。 */
function parseCell(text: string): FfCell | null {
  const t = text.trim();
  if (!t) return null;
  if (t.startsWith('=')) return { f: t };
  if (DECIMAL.test(t)) return { n: t };
  if (t === 'TRUE' || t === 'FALSE') return { b: t === 'TRUE' };
  return { s: text };
}
const addrOrder = (a: string) => { const m = /^([A-Z]+)(\d+)$/.exec(a)!; return Number(m[2]) * 20000 + [...m[1]].reduce((s, ch) => s * 26 + ch.charCodeAt(0) - 64, 0); };

function Diagnostics({ items }: { items: ForecastDiagnostic[] }) {
  if (!items.length) return <Alert type="success" showIcon message="诊断通过:没有不支持的函数、循环引用或无效映射" />;
  return (
    <Table<ForecastDiagnostic> rowKey={(_, i) => String(i)} size="small" dataSource={items} pagination={{ pageSize: 20 }} columns={[
      { title: '级别', dataIndex: 'severity', width: 70, render: (x: string) => (x === 'error' ? <Tag color="error">错误</Tag> : <Tag color="warning">警告</Tag>) },
      { title: '代码', dataIndex: 'code', width: 200 },
      { title: '单元格', dataIndex: 'cell', width: 140, render: (x: string | null) => x ?? '—' },
      { title: '说明', dataIndex: 'message' },
    ]} />
  );
}

function SheetView({ version, editable, onSaved }: { version: FfVersionDto; editable: boolean; onSaved: (v: FfVersionDto) => void }) {
  const { message } = AntdApp.useApp();
  const [sheet, setSheet] = useState(version.sheets[0]?.name);
  const [keyword, setKeyword] = useState('');
  const [edits, setEdits] = useState<Record<string, string>>({});
  const [newCell, setNewCell] = useState('');
  useEffect(() => { setEdits({}); }, [sheet, version.id]);
  const q = useQuery({ queryKey: ['ff-sheet', version.id, version.version, sheet], queryFn: () => forecastApi.sheet(version.id, sheet!), enabled: !!sheet });
  const rows = useMemo(() => {
    const cells = q.data?.cells ?? {};
    const addrs = [...new Set([...Object.keys(cells), ...Object.keys(edits)])].sort((a, b) => addrOrder(a) - addrOrder(b));
    const k = keyword.trim().toUpperCase();
    return addrs.filter((a) => !k || a.includes(k) || cellText(cells[a]).toUpperCase().includes(k)).map((a) => ({ addr: a, cell: cells[a] }));
  }, [q.data, edits, keyword]);
  const save = useMutation({
    mutationFn: () => forecastApi.updateVersion(version.id, {
      expectedVersion: version.version,
      cells: Object.entries(edits).map(([cell, text]) => ({ sheet: sheet!, cell, value: parseCell(text) })),
    }),
    onSuccess: (v) => { message.success('单元格已保存,诊断已刷新'); setEdits({}); onSaved(v); },
    onError: (e) => message.error(errorText(e)),
  });
  if (!version.sheets.length) return <Empty description="没有工作表" />;
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Space wrap>
        <Select style={{ width: 200 }} value={sheet} onChange={setSheet} options={version.sheets.map((s) => ({ value: s.name, label: `${s.name}(${s.cellCount})` }))} />
        <Input.Search allowClear placeholder="地址/内容" style={{ width: 200 }} onSearch={setKeyword} />
        {editable && (
          <Space.Compact>
            <Input placeholder="新增单元格,如 B12" style={{ width: 160 }} value={newCell} onChange={(e) => setNewCell(e.target.value.toUpperCase())} />
            <Button onClick={() => { if (/^[A-Z]{1,3}[1-9]\d{0,6}$/.test(newCell)) { setEdits((x) => ({ ...x, [newCell]: x[newCell] ?? '' })); setNewCell(''); } else message.warning('地址应为 A1 形式'); }}>添加</Button>
          </Space.Compact>
        )}
        {editable && Object.keys(edits).length > 0 && <Button type="primary" loading={save.isPending} onClick={() => save.mutate()}>保存修改({Object.keys(edits).length})</Button>}
        {editable && <Typography.Text type="secondary">以 = 开头为公式;数值按十进制保存;留空表示清空</Typography.Text>}
      </Space>
      {q.error ? <QueryErrorResult title="工作表加载失败" error={q.error} refetch={q.refetch} /> : (
        <Table rowKey="addr" size="small" loading={q.isLoading} dataSource={rows} pagination={{ pageSize: 50 }} columns={[
          { title: '地址', dataIndex: 'addr', width: 90 },
          { title: '类型', key: 'kind', width: 70, render: (_: unknown, r) => (r.cell ? cellKind(r.cell) : '—') },
          {
            title: '内容', key: 'value',
            render: (_: unknown, r) => (editable
              ? <Input size="small" value={edits[r.addr] ?? cellText(r.cell)} status={edits[r.addr] !== undefined ? 'warning' : undefined}
                  onChange={(e) => setEdits((x) => ({ ...x, [r.addr]: e.target.value }))} />
              : <code>{cellText(r.cell)}</code>),
          },
        ]} />
      )}
    </Space>
  );
}

function MappingEditor({ version, editable, onSaved }: { version: FfVersionDto; editable: boolean; onSaved: (v: FfVersionDto) => void }) {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<{ params: ForecastParam[]; outputs: ForecastOutput[] }>();
  useEffect(() => { form.setFieldsValue({ params: version.params, outputs: version.outputs }); }, [form, version]);
  const save = useMutation({
    mutationFn: async () => {
      const v = await form.validateFields();
      const params = (v.params ?? []).map((p) => ({ ...p, unit: p.unit ?? '', min: p.min || null, max: p.max || null }));
      const outputs = (v.outputs ?? []).map((o) => ({ ...o, unit: o.unit ?? '' }));
      return forecastApi.updateVersion(version.id, { expectedVersion: version.version, params, outputs });
    },
    onSuccess: (v) => { message.success('映射已保存,诊断已刷新'); onSaved(v); },
    onError: (e) => { if (!(e && typeof e === 'object' && 'errorFields' in e)) message.error(errorText(e)); },
  });
  const keyRule = { pattern: KEY, message: '小写字母开头,字母数字下划线' };
  const decRule = { pattern: DECIMAL, message: '十进制数' };
  return (
    <Form form={form} disabled={!editable} size="small">
      <Typography.Title level={5}>参数(情景运行可覆盖的输入单元格)</Typography.Title>
      <Form.List name="params">
        {(fields, { add, remove }) => (
          <>
            {fields.map((f) => (
              <Row key={f.key} gutter={6}>
                <Col span={4}><Form.Item name={[f.name, 'key']} rules={[{ required: true, message: '编码' }, keyRule]}><Input placeholder="编码 price" /></Form.Item></Col>
                <Col span={4}><Form.Item name={[f.name, 'name']} rules={[{ required: true, message: '名称' }]}><Input placeholder="名称" /></Form.Item></Col>
                <Col span={5}><Form.Item name={[f.name, 'cell']} rules={[{ required: true, message: '单元格' }]}><Input placeholder="参数!B2" /></Form.Item></Col>
                <Col span={2}><Form.Item name={[f.name, 'unit']}><Input placeholder="单位" /></Form.Item></Col>
                <Col span={3}><Form.Item name={[f.name, 'min']} rules={[decRule]}><Input placeholder="下限" /></Form.Item></Col>
                <Col span={3}><Form.Item name={[f.name, 'max']} rules={[decRule]}><Input placeholder="上限" /></Form.Item></Col>
                <Col span={3}>{editable && <Button danger type="link" onClick={() => remove(f.name)}>删除</Button>}</Col>
              </Row>
            ))}
            {editable && <Button type="dashed" onClick={() => add({ unit: '' })} style={{ marginBottom: 16 }}>添加参数</Button>}
          </>
        )}
      </Form.List>
      <Typography.Title level={5}>输出(单元格或一行区域)</Typography.Title>
      <Form.List name="outputs">
        {(fields, { add, remove }) => (
          <>
            {fields.map((f) => (
              <Row key={f.key} gutter={6}>
                <Col span={4}><Form.Item name={[f.name, 'key']} rules={[{ required: true, message: '编码' }, keyRule]}><Input placeholder="编码 net_profit" /></Form.Item></Col>
                <Col span={5}><Form.Item name={[f.name, 'name']} rules={[{ required: true, message: '名称' }]}><Input placeholder="名称" /></Form.Item></Col>
                <Col span={7}><Form.Item name={[f.name, 'ref']} rules={[{ required: true, message: '区域' }]}><Input placeholder="利润表!B20:K20" /></Form.Item></Col>
                <Col span={3}><Form.Item name={[f.name, 'unit']}><Input placeholder="单位" /></Form.Item></Col>
                <Col span={3}>{editable && <Button danger type="link" onClick={() => remove(f.name)}>删除</Button>}</Col>
              </Row>
            ))}
            {editable && <Button type="dashed" onClick={() => add({ unit: '' })} style={{ marginBottom: 16 }}>添加输出</Button>}
          </>
        )}
      </Form.List>
      {editable && <div><Button type="primary" loading={save.isPending} onClick={() => save.mutate()}>保存映射</Button></div>}
    </Form>
  );
}

function OutputsTable({ version, run }: { version: FfVersionDto; run: FfRunDto }) {
  if (!run.outputs) return null;
  const len = Math.max(0, ...Object.values(run.outputs).map((v) => v.length));
  const rows = version.outputs.map((o) => ({ key: o.key, name: o.name, unit: o.unit, values: run.outputs![o.key] ?? [] }));
  return (
    <Table rowKey="key" size="small" pagination={false} scroll={{ x: 200 + len * 130 }} dataSource={rows} columns={[
      { title: '输出', key: 'name', width: 200, fixed: 'left', render: (_: unknown, r) => `${r.name}${r.unit ? `(${r.unit})` : ''}` },
      ...Array.from({ length: len }, (_, i) => ({ title: `#${i + 1}`, key: String(i), width: 130, align: 'right' as const, render: (_: unknown, r: { values: string[] }) => <Dec value={r.values[i] ?? null} /> })),
    ]} />
  );
}

function CompareModal({ runId, onClose }: { runId: number | null; onClose: () => void }) {
  const q = useQuery({ queryKey: ['ff-compare', runId], queryFn: () => forecastApi.compare(runId!), enabled: runId != null });
  const c = q.data;
  const len = c ? Math.max(0, ...c.items.map((i) => i.values.length)) : 0;
  const rows = (c?.items ?? []).flatMap((it) => (['baseline', 'scenario', 'diff', 'rate'] as const).map((k) => ({
    id: `${it.key}-${k}`, name: k === 'baseline' ? `${it.name}${it.unit ? `(${it.unit})` : ''}` : '', kind: { baseline: '基准', scenario: '情景', diff: '差额', rate: '变动率' }[k],
    values: it.values.map((v) => v[k]),
  })));
  return (
    <Modal open={runId != null} onCancel={onClose} footer={null} width={1100} destroyOnClose title={c ? `情景对比:${c.scenarioName ?? ''}(基准运行 #${c.baselineRunId})` : '情景对比'}>
      {q.error ? <QueryErrorResult title="对比加载失败" error={q.error} refetch={q.refetch} /> : !c ? null : (
        <Space direction="vertical" style={{ width: '100%' }}>
          <div>覆盖参数:{Object.entries(c.params).map(([k, v]) => <Tag key={k}>{k} = {v}</Tag>)}</div>
          <Table rowKey="id" size="small" pagination={false} dataSource={rows} scroll={{ x: 280 + len * 130, y: 520 }} columns={[
            { title: '输出', dataIndex: 'name', width: 200, fixed: 'left' },
            { title: '', dataIndex: 'kind', width: 80, fixed: 'left' },
            ...Array.from({ length: len }, (_, i) => ({ title: `#${i + 1}`, key: String(i), width: 130, align: 'right' as const, render: (_: unknown, r: { values: (string | null)[] }) => <Dec value={r.values[i] ?? null} /> })),
          ]} />
        </Space>
      )}
    </Modal>
  );
}

function RunsPanel({ version }: { version: FfVersionDto }) {
  const { message } = AntdApp.useApp();
  const qc = useQueryClient();
  const [scenarioOpen, setScenarioOpen] = useState(false);
  const [detail, setDetail] = useState<FfRunDto | null>(null);
  const [compareId, setCompareId] = useState<number | null>(null);
  const [form] = Form.useForm<{ scenarioName: string; params: Record<string, string | undefined> }>();
  const runs = useQuery({
    queryKey: ['ff-runs', version.id], queryFn: () => forecastApi.runs(version.id),
    refetchInterval: (q) => (q.state.data?.items.some((r) => r.status === 'queued' || r.status === 'running') ? 1500 : false),
  });
  const items = runs.data?.items ?? [];
  const hasBaseline = items.some((r) => r.kind === 'baseline' && r.status === 'succeeded');
  const writable = can('forecast:write') && version.status === 'frozen';
  const start = useMutation({
    mutationFn: (body: Parameters<typeof forecastApi.startRun>[1]) => forecastApi.startRun(version.id, body),
    onSuccess: () => { message.success('已提交运行'); setScenarioOpen(false); void qc.invalidateQueries({ queryKey: ['ff-runs', version.id] }); },
    onError: (e) => message.error(errorText(e)),
  });
  const submitScenario = async () => {
    const v = await form.validateFields();
    const params = Object.fromEntries(Object.entries(v.params ?? {}).filter(([, x]) => x != null && x.trim() !== '').map(([k, x]) => [k, x!.trim()]));
    if (!Object.keys(params).length) { message.warning('至少覆盖一个参数'); return; }
    start.mutate({ kind: 'scenario', scenarioName: v.scenarioName, params });
  };
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      {version.status !== 'frozen' && <Alert type="info" showIcon message="冻结后才能正式运行;草稿可继续修改单元格和映射" />}
      {writable && (
        <Space>
          <Button type="primary" disabled={hasBaseline} loading={start.isPending} onClick={() => start.mutate({ kind: 'baseline' })}>{hasBaseline ? '已有基准结果' : '运行基准'}</Button>
          <Button disabled={!hasBaseline || !version.params.length} onClick={() => { form.resetFields(); setScenarioOpen(true); }}>情景运行</Button>
        </Space>
      )}
      {runs.error ? <QueryErrorResult title="运行记录加载失败" error={runs.error} refetch={runs.refetch} /> : (
        <Table<FfRunDto> rowKey="id" size="small" loading={runs.isLoading} dataSource={items} pagination={false} locale={{ emptyText: <Empty description="还没有运行" /> }} columns={[
          { title: '#', dataIndex: 'id', width: 60 },
          { title: '类型', dataIndex: 'kind', width: 70, render: (x: string) => (x === 'baseline' ? '基准' : '情景') },
          { title: '方案', dataIndex: 'scenarioName', width: 140, render: (x: string | null) => x || '—' },
          { title: '参数', dataIndex: 'params', render: (p: Record<string, string>) => Object.entries(p).map(([k, v]) => <Tag key={k}>{k}={v}</Tag>) },
          { title: '状态', dataIndex: 'status', width: 90, render: (x: string) => statusTag(FF_RUN_STATUS, x) },
          { title: '耗时', dataIndex: 'durationMs', width: 80, render: (x: number | null) => (x == null ? '—' : `${x} ms`) },
          { title: '提交', dataIndex: 'createdAt', width: 150, render: (x: string, r) => `${r.createdBy ?? ''} ${shortTime(x)}` },
          {
            title: '操作', key: 'op', width: 140,
            render: (_: unknown, r) => (
              <Space size={0}>
                {(r.status === 'succeeded' || r.status === 'failed') && <Button type="link" size="small" onClick={() => setDetail(r)}>{r.status === 'failed' ? '原因' : '结果'}</Button>}
                {r.kind === 'scenario' && r.status === 'succeeded' && <Button type="link" size="small" onClick={() => setCompareId(r.id)}>对比</Button>}
              </Space>
            ),
          },
        ]} />
      )}
      <Modal open={scenarioOpen} title="情景运行" onCancel={() => setScenarioOpen(false)} onOk={() => void submitScenario()} confirmLoading={start.isPending} destroyOnClose width={620}>
        <Form form={form} layout="vertical" preserve={false}>
          <Form.Item name="scenarioName" label="方案名" rules={[{ required: true }, { max: 64 }]}><Input placeholder="如:电价下调 5%" /></Form.Item>
          <Typography.Text type="secondary">只填写需要覆盖的参数,其余沿用冻结版本的值。</Typography.Text>
          {version.params.map((p) => (
            <Form.Item key={p.key} name={['params', p.key]} label={`${p.name}(${p.key}${p.unit ? `,${p.unit}` : ''})`}
              extra={p.min || p.max ? `范围 ${p.min ?? '-∞'} ~ ${p.max ?? '+∞'}` : `单元格 ${p.cell}`} rules={[{ pattern: DECIMAL, message: '十进制数' }]}>
              <Input />
            </Form.Item>
          ))}
        </Form>
      </Modal>
      <Modal open={detail != null} onCancel={() => setDetail(null)} footer={null} width={1000} title={detail ? `运行 #${detail.id} ${detail.scenarioName ?? '基准'}` : ''} destroyOnClose>
        {detail?.status === 'failed' && <Alert type="error" showIcon message={detail.errorCode} description={detail.errorMessage} />}
        {detail?.status === 'succeeded' && <OutputsTable version={version} run={detail} />}
      </Modal>
      <CompareModal runId={compareId} onClose={() => setCompareId(null)} />
    </Space>
  );
}

function VersionDrawer({ id, modelActive, onClose, onOpen }: { id: number | null; modelActive: boolean; onClose: () => void; onOpen: (id: number) => void }) {
  const { message, modal } = AntdApp.useApp();
  const qc = useQueryClient();
  const q = useQuery({ queryKey: ['ff-version', id], queryFn: () => forecastApi.version(id!), enabled: id != null });
  const v = q.data;
  const editable = !!v && v.status === 'draft' && modelActive && can('forecast:write');
  const onSaved = (nv: FfVersionDto) => { qc.setQueryData(['ff-version', id], nv); void qc.invalidateQueries({ queryKey: ['ff-model'] }); };
  const freeze = useMutation({
    mutationFn: () => forecastApi.freeze(v!.id, v!.version),
    onSuccess: (nv) => { message.success('已冻结,可以运行基准'); onSaved(nv); },
    onError: (e) => {
      const d = e instanceof ApiError ? (e.body.details as { diagnostics?: ForecastDiagnostic[] } | undefined) : undefined;
      if (d?.diagnostics?.length) modal.error({ title: errorText(e), width: 720, content: <Diagnostics items={d.diagnostics} /> });
      else message.error(errorText(e));
    },
  });
  const copy = useMutation({
    mutationFn: () => forecastApi.copy(v!.id),
    onSuccess: (nv) => { message.success(`已复制为第 ${nv.versionNo} 版草稿`); void qc.invalidateQueries({ queryKey: ['ff-model'] }); onOpen(nv.id); },
    onError: (e) => message.error(errorText(e)),
  });
  return (
    <Drawer open={id != null} onClose={onClose} width={1100} destroyOnClose title={v ? `第 ${v.versionNo} 版` : '预测版本'}
      extra={v && can('forecast:write') && modelActive && (
        <Space>
          {editable && <Button type="primary" loading={freeze.isPending} onClick={() => freeze.mutate()}>冻结</Button>}
          <Button loading={copy.isPending} onClick={() => copy.mutate()}>复制为新草稿</Button>
        </Space>
      )}>
      {q.error ? <QueryErrorResult title="版本加载失败" error={q.error} refetch={q.refetch} /> : !v ? null : (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Descriptions size="small" column={4} bordered>
            <Descriptions.Item label="状态">{statusTag(FF_VERSION_STATUS, v.status)}</Descriptions.Item>
            <Descriptions.Item label="来源">{v.sourceFileName ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="单元格">{v.cellCount}({v.sheets.length} 个工作表)</Descriptions.Item>
            <Descriptions.Item label="诊断">{v.errorCount ? <Tag color="error">{v.errorCount} 错误</Tag> : <Tag color="success">无错误</Tag>}{v.warningCount > 0 && <Tag color="warning">{v.warningCount} 警告</Tag>}</Descriptions.Item>
            <Descriptions.Item label="说明" span={2}>{v.note || '—'}</Descriptions.Item>
            <Descriptions.Item label="冻结" span={2}>{v.frozenAt ? `${v.frozenBy ?? ''} ${shortTime(v.frozenAt)}` : '—'}</Descriptions.Item>
          </Descriptions>
          <Tabs defaultActiveKey={v.status === 'frozen' ? 'runs' : 'diag'} items={[
            { key: 'diag', label: `诊断(${v.diagnostics?.length ?? 0})`, children: <Diagnostics items={v.diagnostics ?? []} /> },
            { key: 'mapping', label: `参数与输出(${v.params.length}/${v.outputs.length})`, children: <MappingEditor version={v} editable={editable} onSaved={onSaved} /> },
            { key: 'sheets', label: '工作表', children: <SheetView version={v} editable={editable} onSaved={onSaved} /> },
            { key: 'runs', label: '运行与对比', children: <RunsPanel version={v} /> },
          ]} />
        </Space>
      )}
    </Drawer>
  );
}

function ModelDrawer({ id, onClose }: { id: number | null; onClose: () => void }) {
  const { message } = AntdApp.useApp();
  const qc = useQueryClient();
  const [prompt, holder] = usePrompt();
  const [versionId, setVersionId] = useState<number | null>(null);
  const [note, setNote] = useState('');
  const q = useQuery({ queryKey: ['ff-model', id], queryFn: () => forecastApi.model(id!), enabled: id != null });
  const m = q.data;
  const active = m?.status === 'active';
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['ff-model', id] }); void qc.invalidateQueries({ queryKey: ['ff-models'] }); };
  const upload = useMutation({
    mutationFn: (f: File) => forecastApi.importVersion(m!.id, f, note || undefined),
    onSuccess: (v) => { message.success(`已导入第 ${v.versionNo} 版${v.errorCount ? `,诊断 ${v.errorCount} 项错误需处理` : ''}`); setNote(''); refresh(); setVersionId(v.id); },
    onError: (e) => message.error(errorText(e)),
  });
  const edit = async () => {
    if (!m) return;
    const v = await prompt({ title: '编辑模型', fields: [{ name: 'name', label: '名称', required: true, initial: m.name }, { name: 'description', label: '说明', multiline: true, initial: m.description }] });
    if (!v) return;
    try { await forecastApi.updateModel(m.id, { expectedVersion: m.version, name: v.name, description: v.description }); refresh(); } catch (e) { message.error(errorText(e)); }
  };
  const toggle = async () => {
    if (!m) return;
    try { await forecastApi.updateModel(m.id, { expectedVersion: m.version, status: active ? 'archived' : 'active' }); refresh(); } catch (e) { message.error(errorText(e)); }
  };
  return (
    <Drawer open={id != null} onClose={onClose} width={960} destroyOnClose title={m ? m.name : '预测模型'}
      extra={m && can('forecast:write') && (
        <Space>
          {active && <Button onClick={() => void edit()}>编辑</Button>}
          <Button onClick={() => void toggle()}>{active ? '归档' : '恢复'}</Button>
        </Space>
      )}>
      {holder}
      {q.error ? <QueryErrorResult title="模型加载失败" error={q.error} refetch={q.refetch} /> : !m ? null : (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          <Descriptions size="small" column={3} bordered>
            <Descriptions.Item label="组织">{m.orgName}</Descriptions.Item>
            <Descriptions.Item label="基准年">{m.baseYear}</Descriptions.Item>
            <Descriptions.Item label="预测期">{m.horizonYears} 年</Descriptions.Item>
            <Descriptions.Item label="说明" span={3}>{m.description || '—'}</Descriptions.Item>
          </Descriptions>
          {active && can('forecast:write') && (
            <Space>
              <Input placeholder="版本说明(可选)" style={{ width: 260 }} maxLength={500} value={note} onChange={(e) => setNote(e.target.value)} />
              <Upload accept=".xlsx" showUploadList={false} beforeUpload={(f) => { upload.mutate(f); return false; }}>
                <Button type="primary" loading={upload.isPending}>导入 .xlsx 工作簿</Button>
              </Upload>
              <Typography.Text type="secondary">公式在受限引擎中校验;不支持的函数、外部链接、宏会列入诊断</Typography.Text>
            </Space>
          )}
          <Table<FfVersionDto> rowKey="id" size="small" dataSource={m.versions} pagination={false} locale={{ emptyText: <Empty description="还没有版本,请导入工作簿" /> }}
            onRow={(v) => ({ onClick: () => setVersionId(v.id), style: { cursor: 'pointer' } })} columns={[
              { title: '版本', dataIndex: 'versionNo', width: 70, render: (x: number) => `第 ${x} 版` },
              { title: '状态', dataIndex: 'status', width: 80, render: (x: string) => statusTag(FF_VERSION_STATUS, x) },
              { title: '说明', dataIndex: 'note' },
              { title: '来源', dataIndex: 'sourceFileName', width: 180, render: (x: string | null) => x ?? '—' },
              { title: '诊断', key: 'diag', width: 110, render: (_: unknown, v) => (v.errorCount ? <Tag color="error">{v.errorCount} 错误</Tag> : v.warningCount ? <Tag color="warning">{v.warningCount} 警告</Tag> : <Tag color="success">通过</Tag>) },
              { title: '基准', dataIndex: 'baselineRunId', width: 70, render: (x: number | null) => (x ? <Tag color="success">有</Tag> : '—') },
              { title: '创建', dataIndex: 'createdAt', width: 150, render: (x: string, v) => `${v.createdBy ?? ''} ${shortTime(x)}` },
            ]} />
        </Space>
      )}
      <VersionDrawer id={versionId} modelActive={!!active} onClose={() => setVersionId(null)} onOpen={setVersionId} />
    </Drawer>
  );
}

function CreateModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: (m: FfModelDto) => void }) {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<{ name: string; orgId: number; baseYear: number; horizonYears: number; description?: string }>();
  const save = useMutation({
    mutationFn: (v: { name: string; orgId: number; baseYear: number; horizonYears: number; description?: string }) => forecastApi.createModel(compact(v) as typeof v),
    onSuccess: (m) => { message.success('模型已创建,请导入工作簿'); onDone(m); onClose(); },
    onError: (e) => message.error(errorText(e)),
  });
  return (
    <Modal open={open} title="新建预测模型" onCancel={onClose} destroyOnClose confirmLoading={save.isPending} onOk={() => form.validateFields().then((v) => save.mutate(v))}>
      <Form form={form} layout="vertical" preserve={false} initialValues={{ orgId: defaultOrgId(), baseYear: new Date().getFullYear(), horizonYears: 5 }}>
        <Form.Item name="name" label="名称" rules={[{ required: true }, { max: 128 }]}><Input /></Form.Item>
        <Form.Item name="orgId" label="组织" rules={[{ required: true, message: '请选择组织' }]}><OrgSelect onChange={(v) => form.setFieldValue('orgId', v)} width={470} allowClear={false} /></Form.Item>
        <Row gutter={12}>
          <Col span={12}><Form.Item name="baseYear" label="基准年" rules={[{ required: true }]}><InputNumber min={2000} max={2100} precision={0} style={{ width: '100%' }} /></Form.Item></Col>
          <Col span={12}><Form.Item name="horizonYears" label="预测期(年)" rules={[{ required: true }]}><InputNumber min={1} max={30} precision={0} style={{ width: '100%' }} /></Form.Item></Col>
        </Row>
        <Form.Item name="description" label="说明"><Input.TextArea rows={2} maxLength={1000} /></Form.Item>
      </Form>
    </Modal>
  );
}

export default function Forecast() {
  const [orgId, setOrgId] = useState<number>();
  const [status, setStatus] = useState<'active' | 'archived' | undefined>('active');
  const [keyword, setKeyword] = useState('');
  const [openId, setOpenId] = useUrlId();
  const [creating, setCreating] = useState(false);
  const qc = useQueryClient();
  const query = compact({ orgId, status, keyword: keyword.trim() });
  const list = useQuery({ queryKey: ['ff-models', query], queryFn: () => forecastApi.models(query) });
  return (
    <div>
      <Space wrap style={{ marginBottom: 12 }}>
        <OrgSelect value={orgId} onChange={setOrgId} />
        <Select allowClear placeholder="状态" style={{ width: 110 }} value={status} onChange={setStatus} options={[{ value: 'active', label: '使用中' }, { value: 'archived', label: '已归档' }]} />
        <Input.Search allowClear placeholder="名称" style={{ width: 200 }} onSearch={setKeyword} />
        {can('forecast:write') && <Button type="primary" onClick={() => setCreating(true)}>新建模型</Button>}
      </Space>
      {list.error ? <QueryErrorResult title="模型列表加载失败" error={list.error} refetch={list.refetch} /> : (
        <Table<FfModelDto> rowKey="id" size="small" loading={list.isLoading} dataSource={list.data?.items ?? []}
          locale={{ emptyText: <Empty description="还没有预测模型" /> }}
          onRow={(m) => ({ onClick: () => setOpenId(m.id), style: { cursor: 'pointer' } })} columns={[
            { title: '名称', dataIndex: 'name' },
            { title: '组织', dataIndex: 'orgName', width: 140 },
            { title: '基准年', dataIndex: 'baseYear', width: 80 },
            { title: '预测期', dataIndex: 'horizonYears', width: 80, render: (x: number) => `${x} 年` },
            { title: '版本', key: 'v', width: 120, render: (_: unknown, m) => `${m.versionCount} 版 / 冻结 ${m.frozenCount}` },
            { title: '状态', dataIndex: 'status', width: 80, render: (x: string) => (x === 'active' ? <Tag color="processing">使用中</Tag> : <Tag>已归档</Tag>) },
            { title: '更新', dataIndex: 'updatedAt', width: 130, render: (x: string) => shortTime(x) },
          ]} />
      )}
      <CreateModal open={creating} onClose={() => setCreating(false)} onDone={(m) => { void qc.invalidateQueries({ queryKey: ['ff-models'] }); setOpenId(m.id); }} />
      <ModelDrawer id={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}
