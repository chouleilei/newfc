import { useBatchDeepLink } from '../../hooks/useBatchDeepLink';
import { useAssistantDomainPage } from '../../assistant/contextHooks';
import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App as AntdApp, Button, Card, Col, Drawer, Form, InputNumber, Modal, Row, Segmented, Space, Table, Tag, Tooltip, Typography, Upload } from 'antd';
import { can, download, errorText } from '../../api/client';
import {
  planApi, type PeriodValueDto, type PlanBatchDto, type PlanItemDto, type PlanPreviewDto, type PlanProjectProgressDto, type PlanSheetCode, type PlanSheetOverviewDto,
} from '../../api/projectContract';
import { QueryErrorResult } from '../../components/QueryErrorResult';
import { shortTime } from '../../utils/relativeTime';
import { defaultOrgId, lastPeriod, Money, OrgSelect, PeriodPicker, Ratio, usePrompt } from '../financeData/shared';
import { BATCH_STATUS, RowErrors } from './shared';

/**
 * AC-F15 计划执行与形象进度。
 * 同年取数:年度必选,截至期间缺省取该年最新当前批次;当期 = 本期年度累计实际 − 同年上一期间;
 * 缺年度实际列时不可计算(不用开工累计兜底),形象进度缺失为空(不用投资完成比例冒充)。
 */

const SHEET_LABEL: Record<PlanSheetCode, string> = { investment: '固定资产投资计划', purchase: '固定资产购置计划', maintenance: '运行维护费' };
const ROW_STATUS = {
  not_computable: { text: '不可计算', color: 'default' }, over_plan: { text: '超计划', color: 'error' }, slow: { text: '偏慢', color: 'warning' }, normal: { text: '正常', color: 'success' },
};
const MEASURE_LABEL: Record<string, string> = { annual_plan: '本年计划', annual_actual_ytd: '本年累计实际', cumulative: '开工累计', total: '总额', snapshot: '状态/形象进度' };

const dash = <Typography.Text type="secondary">—</Typography.Text>;
const money = (v: string | null) => (v == null ? dash : <Money value={v} />);
const ratio = (v: string | null) => (v == null ? dash : <Ratio value={v} />);
export function PeriodValue({ v }: { v: PeriodValueDto }) {
  if (v.value != null) return <Tooltip title={v.previousPeriod ? `减去 ${v.previousPeriod} 年度累计` : '年内首个期间'}><span><Money value={v.value} /></span></Tooltip>;
  return <Tooltip title={v.reason}><Typography.Text type="secondary">不可计算</Typography.Text></Tooltip>;
}

function SheetCard({ s }: { s: PlanSheetOverviewDto }) {
  const kv = (label: string, node: React.ReactNode) => (
    <Col xs={12} md={8}><Typography.Text type="secondary" style={{ fontSize: 12 }}>{label}</Typography.Text><div style={{ fontSize: 16 }}>{node}</div></Col>
  );
  return (
    <Card size="small" title={`${s.name}(${s.detailCount} 行)`} style={{ height: '100%' }}>
      <Row gutter={[12, 8]}>
        {kv('年度计划', money(s.annualPlan))}
        {kv('年度累计实际', money(s.annualActualYtd))}
        {kv('年度执行率', ratio(s.annualRate))}
        {kv('当期发生', <PeriodValue v={s.period} />)}
        {s.code === 'investment' && kv('累计完成率', ratio(s.cumulativeRate))}
        {s.code === 'investment' && kv('开工累计 / 总投资', <span>{money(s.completedCumulative)} / {money(s.totalInvestment)}</span>)}
      </Row>
      <Space size={4} wrap style={{ marginTop: 8 }}>
        {Object.entries(s.statusCounts).filter(([, n]) => n > 0).map(([k, n]) => <Tag key={k} color={ROW_STATUS[k as keyof typeof ROW_STATUS].color}>{ROW_STATUS[k as keyof typeof ROW_STATUS].text} {n}</Tag>)}
      </Space>
      {s.notes.map((n) => <div key={n}><Typography.Text type="secondary" style={{ fontSize: 12 }}>{n}</Typography.Text></div>)}
    </Card>
  );
}

function ImportModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { message } = AntdApp.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm<{ year: number; actualPeriod: string }>();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PlanPreviewDto | null>(null);
  const close = () => { setFile(null); setPreview(null); onClose(); };
  const run = useMutation({
    mutationFn: async (mode: 'preview' | 'import') => {
      const v = await form.validateFields();
      if (!file) throw new Error('请选择 .xlsx 文件');
      return mode === 'preview' ? { mode, r: await planApi.preview(file, v) } : { mode, r: await planApi.importFile(file, v) };
    },
    onSuccess: ({ mode, r }) => {
      if (mode === 'preview') { setPreview(r as PlanPreviewDto); return; }
      const b = r as PlanBatchDto;
      message.success(b.replayed ? `相同文件已导入过,返回批次 #${b.id}` : `已导入批次 #${b.id},激活后生效`);
      void qc.invalidateQueries({ queryKey: ['plan-batches'] });
      close();
    },
    onError: (e) => message.error(errorText(e)),
  });
  return (
    <Modal open={open} title="导入计划执行" width={860} onCancel={close} destroyOnClose
      footer={<Space>
        <Button onClick={close}>取消</Button>
        <Button onClick={() => run.mutate('preview')} loading={run.isPending}>预览</Button>
        <Button type="primary" disabled={!preview?.valid} onClick={() => run.mutate('import')} loading={run.isPending}>导入</Button>
      </Space>}>
      <Form form={form} layout="inline" preserve={false} initialValues={{ year: Number(lastPeriod().slice(0, 4)), actualPeriod: lastPeriod() }} onValuesChange={() => setPreview(null)}>
        <Form.Item name="year" label="计划年度" rules={[{ required: true }]}><InputNumber min={2000} max={2100} style={{ width: 100 }} /></Form.Item>
        <Form.Item name="actualPeriod" label="实际期间" rules={[{ required: true }]}><PeriodPicker onChange={(v) => form.setFieldValue('actualPeriod', v)} allowClear={false} /></Form.Item>
      </Form>
      <Upload.Dragger accept=".xlsx" maxCount={1} style={{ marginTop: 12 }} beforeUpload={(f) => { setFile(f); setPreview(null); return false; }} onRemove={() => { setFile(null); setPreview(null); }}>
        <p>点击或拖入计划执行 .xlsx(固定资产投资计划、固定资产购置计划、运行维护费三张表)</p>
      </Upload.Dragger>
      {preview && (
        <Space direction="vertical" style={{ width: '100%', marginTop: 12 }}>
          {preview.valid ? <Alert type="success" showIcon message={`校验通过:${preview.itemCount} 行、${preview.factCount} 个取数`} />
            : <RowErrors errors={preview.errors} title="校验未通过,修正后重新预览(不写库)" />}
          {preview.ignoredSheets.length > 0 && <Alert type="info" showIcon message={`已忽略的工作表:${preview.ignoredSheets.join('、')}`} />}
          <Table rowKey="code" size="small" pagination={false} dataSource={preview.sheets}
            columns={[
              { title: '模板', dataIndex: 'name' }, { title: '源表', dataIndex: 'sourceName' },
              { title: '行数', dataIndex: 'itemCount', width: 80 }, { title: '明细行', dataIndex: 'detailCount', width: 80 },
              { title: '单位', dataIndex: 'unit', width: 80, render: (u: string) => (u === 'wan' ? '万元' : '元') },
            ]} />
        </Space>
      )}
    </Modal>
  );
}

function ItemsDrawer({ batch, onClose }: { batch: PlanBatchDto | null; onClose: () => void }) {
  const [sheet, setSheet] = useState<PlanSheetCode>('investment');
  const q = useQuery({ queryKey: ['plan-items', batch?.id, sheet], queryFn: () => planApi.items(batch!.id, sheet), enabled: !!batch });
  return (
    <Drawer open={!!batch} onClose={onClose} width={1100} destroyOnClose title={batch ? `计划批次 #${batch.id} · ${batch.year} 年 · 实际 ${batch.actualPeriod}` : ''}>
      <Segmented value={sheet} onChange={(v) => setSheet(v as PlanSheetCode)} options={Object.entries(SHEET_LABEL).map(([value, label]) => ({ value, label }))} style={{ marginBottom: 12 }} />
      {q.error ? <QueryErrorResult title="行加载失败" error={q.error} refetch={q.refetch} /> : (
        <Table<PlanItemDto> rowKey="id" size="small" loading={q.isLoading} dataSource={q.data ?? []} pagination={{ pageSize: 50 }}
          columns={[
            { title: '行', dataIndex: 'rowNo', width: 60 },
            { title: '序号', dataIndex: 'seqNo', width: 70 },
            { title: '名称', dataIndex: 'itemName', render: (v: string, r) => (r.itemType === 'detail' ? v : <Typography.Text strong>{v}</Typography.Text>) },
            { title: '项目', dataIndex: 'projectCode', width: 110, render: (v: string | null) => v ?? '' },
            { title: '组织', dataIndex: 'orgName', width: 120, render: (v: string | null) => v ?? '' },
            {
              title: '取数', key: 'facts', render: (_, r) => (
                <Space size={[4, 2]} wrap>
                  {r.facts.map((f) => (
                    <Tooltip key={f.fieldKey} title={`${MEASURE_LABEL[f.measure] ?? f.measure} · 单元格 ${f.sourceCell}`}>
                      <Tag>{f.fieldName}:{f.valueType === 'amount' ? <Money value={f.value} /> : f.valueType === 'ratio' ? <Ratio value={f.value} /> : f.value}</Tag>
                    </Tooltip>
                  ))}
                </Space>
              ),
            },
          ]} />
      )}
    </Drawer>
  );
}

export default function PlanExecution() {
  const { message } = AntdApp.useApp();
  const qc = useQueryClient();
  const [prompt, holder] = usePrompt();
  const [year, setYear] = useState<number>(Number(lastPeriod().slice(0, 4)));
  const [asOfPeriod, setAsOf] = useState<string | undefined>();
  const [orgId, setOrgId] = useState<number | undefined>(defaultOrgId());
  const [importing, setImporting] = useState(false);
  const [viewing, setViewing] = useState<PlanBatchDto | null>(null);
  const linkedBatch = useBatchDeepLink('plan', planApi.batch, (batch) => { setViewing(batch); setYear(batch.year); });
  const writable = can('plan:write');
  const period = asOfPeriod?.startsWith(`${year}-`) ? asOfPeriod : undefined;
  const overview = useQuery({ queryKey: ['plan-overview', year, period, orgId], queryFn: () => planApi.overview({ year, asOfPeriod: period, orgId }) });
  const projects = useQuery({ queryKey: ['plan-projects', year, period, orgId], queryFn: () => planApi.projects({ year, asOfPeriod: period, orgId }) });
  useAssistantDomainPage({ pageKey: 'plan', ready: !overview.isLoading && !overview.error, scope: { year: viewing?.year ?? year, period: viewing?.actualPeriod ?? period, orgScopeId: orgId, planBatchId: viewing?.id } });
  const batches = useQuery({ queryKey: ['plan-batches', year], queryFn: () => planApi.batches({ year }) });
  const refresh = () => ['plan-batches', 'plan-overview', 'plan-projects'].forEach((k) => void qc.invalidateQueries({ queryKey: [k] }));
  const act = useMutation({
    mutationFn: async (v: { kind: 'activate' | 'void'; b: PlanBatchDto; reason?: string }) => {
      if (v.kind === 'void') return planApi.void(v.b.id, v.reason!);
      const current = (batches.data ?? []).find((x) => x.isCurrent && x.year === v.b.year && x.actualPeriod === v.b.actualPeriod);
      return planApi.activate(v.b.id, current?.id ?? null);
    },
    onSuccess: (_r, v) => { message.success(v.kind === 'void' ? '批次已作废' : '批次已激活'); refresh(); },
    onError: (e) => message.error(errorText(e)),
  });
  const o = overview.data;
  return (
    <div>
      {linkedBatch.error && <QueryErrorResult title="来源批次加载失败" error={linkedBatch.error} refetch={linkedBatch.refetch} />}
      {holder}
      <Space wrap style={{ marginBottom: 12 }}>
        <InputNumber aria-label="计划年度" min={2000} max={2100} value={year} onChange={(v) => v && setYear(v)} style={{ width: 100 }} />
        <PeriodPicker value={period} onChange={setAsOf} placeholder="截至期间(缺省最新)" />
        <OrgSelect value={orgId} onChange={setOrgId} />
        {writable && <Button type="primary" onClick={() => setImporting(true)}>导入计划执行</Button>}
      </Space>
      {overview.error ? <QueryErrorResult title="计划执行加载失败" error={overview.error} refetch={overview.refetch} /> : o && (
        <>
          {o.notes.map((n) => <Alert key={n} type="info" showIcon message={n} style={{ marginBottom: 8 }} />)}
          {o.batch && (
            <>
              <Typography.Text type="secondary">当前批次 #{o.batch.id} · 实际期间 {o.asOfPeriod} · 单位 元</Typography.Text>
              <Row gutter={[12, 12]} style={{ margin: '8px 0 12px' }}>
                {o.sheets.map((s) => <Col key={s.code} xs={24} lg={8}><SheetCard s={s} /></Col>)}
              </Row>
            </>
          )}
        </>
      )}
      <Typography.Title level={5}>项目进度</Typography.Title>
      {projects.error ? <QueryErrorResult title="项目进度加载失败" error={projects.error} refetch={projects.refetch} /> : (
        <Table<PlanProjectProgressDto> rowKey="itemId" size="small" loading={projects.isLoading} dataSource={projects.data?.rows ?? []} pagination={{ pageSize: 20 }} scroll={{ x: 1300 }}
          columns={[
            { title: '项目', key: 'p', fixed: 'left', width: 200, render: (_, r) => `${r.projectName}(${r.projectCode})` },
            { title: '组织', dataIndex: 'orgName', width: 110 },
            { title: '总投资', dataIndex: 'totalInvestment', width: 130, align: 'right', render: money },
            { title: '开工累计', dataIndex: 'completedCumulative', width: 130, align: 'right', render: money },
            { title: '累计完成率', dataIndex: 'cumulativeRate', width: 100, align: 'right', render: ratio },
            { title: '年度计划', dataIndex: 'annualPlan', width: 130, align: 'right', render: money },
            { title: '年度累计实际', dataIndex: 'annualActualYtd', width: 130, align: 'right', render: money },
            { title: '年度执行率', dataIndex: 'annualRate', width: 100, align: 'right', render: ratio },
            { title: '当期', key: 'period', width: 120, align: 'right', render: (_, r) => <PeriodValue v={r.period} /> },
            { title: '形象进度', dataIndex: 'physicalProgress', width: 100, align: 'right', render: (v: string | null, r) => (v == null ? <Tooltip title="模板未填形象进度">{dash}</Tooltip> : <Tooltip title={r.progressNote}><span><Ratio value={v} /></span></Tooltip>) },
            { title: '状态', dataIndex: 'status', width: 90, render: (v: keyof typeof ROW_STATUS) => <Tag color={ROW_STATUS[v].color}>{ROW_STATUS[v].text}</Tag> },
          ]} />
      )}
      <Typography.Title level={5} style={{ marginTop: 16 }}>导入批次</Typography.Title>
      {batches.error ? <QueryErrorResult title="批次加载失败" error={batches.error} refetch={batches.refetch} /> : (
        <Table<PlanBatchDto> rowKey="id" size="small" loading={batches.isLoading} dataSource={batches.data ?? []} pagination={{ pageSize: 10 }}
          columns={[
            { title: '#', dataIndex: 'id', width: 60 },
            { title: '文件', dataIndex: 'fileName', ellipsis: true },
            { title: '实际期间', dataIndex: 'actualPeriod', width: 90 },
            { title: '状态', key: 's', width: 140, render: (_, b) => <Space size={4}>{BATCH_STATUS[b.status]}{b.isCurrent && <Tag color="blue">当前</Tag>}{b.partial && <Tag>部分可见</Tag>}</Space> },
            { title: '行 / 取数', key: 'n', width: 100, render: (_, b) => `${b.itemCount} / ${b.factCount}` },
            { title: '导入时间', dataIndex: 'createdAt', width: 120, render: (v: string) => shortTime(v) },
            {
              title: '操作', key: 'op', width: 220, render: (_, b) => (
                <Space size={0} wrap>
                  <Button type="link" size="small" onClick={() => setViewing(b)}>行与取数</Button>
                  <Button type="link" size="small" onClick={() => void download(`/plan/batches/${b.id}/original`, b.fileName)}>原件</Button>
                  {writable && b.status === 'imported' && !b.isCurrent && <Button type="link" size="small" onClick={() => act.mutate({ kind: 'activate', b })}>激活</Button>}
                  {writable && b.status === 'imported' && (
                    <Button type="link" size="small" danger onClick={async () => {
                      const v = await prompt({ title: `作废批次 #${b.id}`, danger: true, okText: '作废', fields: [{ name: 'reason', label: '作废原因', required: true, multiline: true }] });
                      if (v) act.mutate({ kind: 'void', b, reason: v.reason });
                    }}>作废</Button>
                  )}
                </Space>
              ),
            },
          ]} />
      )}
      <ImportModal open={importing} onClose={() => setImporting(false)} />
      <ItemsDrawer batch={viewing} onClose={() => setViewing(null)} />
    </div>
  );
}
