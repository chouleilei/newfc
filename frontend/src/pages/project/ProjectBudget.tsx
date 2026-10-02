import { useAssistantDomainPage } from '../../assistant/contextHooks';
import { useEffect, useState } from 'react';
import { positiveQueryNumber, useListSearchParams } from '../../hooks/useListSearchParams';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { Alert, App as AntdApp, Button, Card, Col, Drawer, Form, Input, InputNumber, Modal, Row, Space, Table, Tabs, Tag, Typography, Upload } from 'antd';
import { can, download, errorText } from '../../api/client';
import { projectBudgetApi, type PbBatchDto, type PbEntryDto, type PbGroupDto, type PbPreviewDto, type PbTotalsDto } from '../../api/projectContract';
import { QueryErrorResult } from '../../components/QueryErrorResult';
import { shortTime } from '../../utils/relativeTime';
import { lastPeriod, Money, moneyColumn, OrgSelect, PeriodPicker, Ratio, usePrompt } from '../financeData/shared';
import { BATCH_STATUS, RowErrors } from './shared';

/** AC-F09 项目预算:预览 → 导入 → 激活;汇总只读当前(或指定)批次,不读写经营预算与实际快照。 */

export function TotalsRow({ totals, labels = ['年度预算', '已执行', '剩余', '执行率'] }: { totals: PbTotalsDto; labels?: string[] }) {
  const items = [totals.budget, totals.executed, totals.remaining];
  return (
    <Row gutter={[16, 12]}>
      {items.map((v, i) => (
        <Col key={labels[i]} xs={12} md={6}>
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>{labels[i]}</Typography.Text>
          <div className="kpi-value" style={{ fontSize: 20 }}><Money value={v} /></div>
        </Col>
      ))}
      <Col xs={12} md={6}>
        <Typography.Text type="secondary" style={{ fontSize: 12 }}>{labels[3]}</Typography.Text>
        <div className="kpi-value" style={{ fontSize: 20 }}>{totals.executionRate == null ? '—' : <Ratio value={totals.executionRate} />}</div>
      </Col>
    </Row>
  );
}

const groupColumns = (first: { title: string; render?: (r: PbGroupDto) => React.ReactNode }) => [
  { title: first.title, key: 'label', render: (_: unknown, r: PbGroupDto) => first.render?.(r) ?? r.label },
  moneyColumn<PbGroupDto>('年度预算', 'budget'),
  moneyColumn<PbGroupDto>('已执行', 'executed'),
  moneyColumn<PbGroupDto>('剩余', 'remaining'),
  { title: '执行率', dataIndex: 'executionRate', width: 100, align: 'right' as const, render: (v: string | null) => (v == null ? '—' : <Ratio value={v} />) },
];

const entryColumns = [
  { title: '行', dataIndex: 'rowNo', width: 60 },
  { title: '项目', key: 'p', render: (_: unknown, r: PbEntryDto) => `${r.projectName}(${r.projectCode})` },
  { title: '组织', dataIndex: 'orgName', width: 140 },
  { title: '资金来源', dataIndex: 'fundSource', width: 120 },
  { title: '费用类别', dataIndex: 'expenseCategory', width: 110 },
  moneyColumn<PbEntryDto>('年度预算', 'budget'),
  moneyColumn<PbEntryDto>('已执行', 'executed'),
  { title: '执行率', dataIndex: 'executionRate', width: 90, align: 'right' as const, render: (v: string | null) => (v == null ? '—' : <Ratio value={v} />) },
];

function ImportModal({ open, onClose }: { open: boolean; onClose: () => void }) {
  const { message } = AntdApp.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm<{ year: number; period: string; name?: string }>();
  const [file, setFile] = useState<File | null>(null);
  const [preview, setPreview] = useState<PbPreviewDto | null>(null);
  const close = () => { setFile(null); setPreview(null); onClose(); };
  const run = useMutation({
    mutationFn: async (mode: 'preview' | 'import') => {
      const v = await form.validateFields();
      if (!file) throw new Error('请选择 .xlsx 文件');
      return mode === 'preview' ? { mode, r: await projectBudgetApi.preview(file, v) } : { mode, r: await projectBudgetApi.importFile(file, v) };
    },
    onSuccess: ({ mode, r }) => {
      if (mode === 'preview') { setPreview(r as PbPreviewDto); return; }
      const b = r as PbBatchDto;
      message.success(b.replayed ? `相同文件已导入过,返回批次 #${b.id}` : `已导入批次 #${b.id},激活后生效`);
      void qc.invalidateQueries({ queryKey: ['pb-batches'] });
      close();
    },
    onError: (e) => message.error(errorText(e)),
  });
  return (
    <Modal open={open} title="导入项目预算" width={900} onCancel={close} destroyOnClose
      footer={<Space>
        <Button onClick={close}>取消</Button>
        <Button onClick={() => run.mutate('preview')} loading={run.isPending}>预览</Button>
        <Button type="primary" disabled={!preview?.valid} onClick={() => run.mutate('import')} loading={run.isPending}>导入</Button>
      </Space>}>
      <Form form={form} layout="inline" preserve={false} initialValues={{ year: Number(lastPeriod().slice(0, 4)), period: lastPeriod() }} onValuesChange={() => setPreview(null)}>
        <Form.Item name="year" label="年度" rules={[{ required: true }]}><InputNumber min={2000} max={2100} style={{ width: 100 }} /></Form.Item>
        <Form.Item name="period" label="执行期间" rules={[{ required: true }]}><PeriodPicker onChange={(v) => form.setFieldValue('period', v)} allowClear={false} /></Form.Item>
        <Form.Item name="name" label="名称"><Input maxLength={100} style={{ width: 200 }} /></Form.Item>
      </Form>
      <Upload.Dragger accept=".xlsx" maxCount={1} style={{ marginTop: 12 }} beforeUpload={(f) => { setFile(f); setPreview(null); return false; }} onRemove={() => { setFile(null); setPreview(null); }}>
        <p>点击或拖入项目预算 .xlsx(必填列:项目编码、项目名称、资金来源、年度预算、已执行金额、执行月份)</p>
      </Upload.Dragger>
      {preview && (
        <div style={{ marginTop: 12 }}>
          {preview.valid ? <Alert type="success" showIcon message={`校验通过:${preview.rowCount} 行,涉及 ${preview.orgNames.join('、')}`} />
            : <RowErrors errors={preview.errors} title="校验未通过,修正后重新预览(不写库)" />}
          <div style={{ margin: '12px 0' }}><TotalsRow totals={preview.totals} /></div>
          <Table<PbEntryDto> rowKey="rowNo" size="small" dataSource={preview.rows} columns={entryColumns} pagination={{ pageSize: 10 }} scroll={{ x: 900 }} />
        </div>
      )}
    </Modal>
  );
}

function EntriesDrawer({ batch, onClose }: { batch: PbBatchDto | null; onClose: () => void }) {
  const q = useQuery({ queryKey: ['pb-entries', batch?.id], queryFn: () => projectBudgetApi.entries(batch!.id), enabled: !!batch });
  return (
    <Drawer open={!!batch} onClose={onClose} width={1000} title={batch ? `${batch.name} · 明细` : ''} destroyOnClose>
      {q.error ? <QueryErrorResult title="明细加载失败" error={q.error} refetch={q.refetch} />
        : <Table<PbEntryDto> rowKey="rowNo" size="small" loading={q.isLoading} dataSource={q.data ?? []} columns={entryColumns} pagination={{ pageSize: 50 }} scroll={{ x: 900 }} />}
    </Drawer>
  );
}

export default function ProjectBudget() {
  const { message } = AntdApp.useApp();
  const qc = useQueryClient();
  const [prompt, holder] = usePrompt();
  const { params, page, pageSize, update } = useListSearchParams(10);
  const year = positiveQueryNumber(params.get('year')) ?? Number(lastPeriod().slice(0, 4));
  const period = params.get('period') || undefined;
  const orgId = positiveQueryNumber(params.get('orgId'));
  const keyword = params.get('keyword')?.trim() || undefined;
  const [importing, setImporting] = useState(false);
  const [viewing, setViewing] = useState<PbBatchDto | null>(null);
  const writable = can('project_budget:write');
  // 跨域检索(AC-F26)以 ?batchId= 进入:切到该批次年度并打开明细,之后移除参数
  const linkBatchId = positiveQueryNumber(params.get('batchId'));
  const linked = useQuery({ queryKey: ['pb-batch', linkBatchId], queryFn: () => projectBudgetApi.batch(linkBatchId!), enabled: linkBatchId != null });
  useEffect(() => {
    if (linkBatchId == null || !linked.data) return;
    setViewing(linked.data);
    update({ year: linked.data.year, period: undefined, batchId: undefined });
  }, [linkBatchId, linked.data, update]);
  const summary = useQuery({ queryKey: ['pb-summary', year, period, orgId], queryFn: () => projectBudgetApi.summary({ year, period, orgId }) });
  const batches = useQuery({ queryKey: ['pb-batches', year, period, keyword, page, pageSize], queryFn: () => projectBudgetApi.batchesPage({ year, period, keyword, page, pageSize }) });
  useEffect(() => { if (batches.data && batches.data.page !== page) update({ page: batches.data.page }, false); }, [batches.data?.page, page, update]);
  useAssistantDomainPage({ pageKey: 'project_budget', ready: !summary.isLoading && !summary.error, scope: { year: viewing?.year ?? year, period: viewing?.period ?? period, orgScopeId: orgId, projectBudgetBatchId: viewing?.id }, view: { keyword } });
  const refresh = () => { void qc.invalidateQueries({ queryKey: ['pb-batches'] }); void qc.invalidateQueries({ queryKey: ['pb-summary'] }); };
  const act = useMutation({
    mutationFn: async (v: { kind: 'activate' | 'void'; b: PbBatchDto; reason?: string }) => {
      if (v.kind === 'void') return projectBudgetApi.void(v.b.id, v.reason!);
      const current = (await projectBudgetApi.summary({ year: v.b.year, period: v.b.period })).batch;
      const confirmed = await prompt({ title: `激活批次 #${v.b.id}`, okText: '激活', fields: [],
        description: current ? `将用「${v.b.name}」替换 ${v.b.period} 当前批次 #${current.id}「${current.name}」。` : `将「${v.b.name}」设为 ${v.b.period} 当前生效批次。`,
      });
      if (!confirmed) return null;
      return projectBudgetApi.activate(v.b.id, current?.id ?? null);
    },
    onSuccess: (r, v) => { if (!r) return; message.success(v.kind === 'void' ? '批次已作废' : '批次已激活'); refresh(); },
    onError: (e) => message.error(errorText(e)),
  });
  const s = summary.data;
  return (
    <div>
      {holder}
      <Space wrap style={{ marginBottom: 12 }}>
        <InputNumber aria-label="年度" min={2000} max={2100} value={year} onChange={(v) => v && update({ year: v, period: undefined })} style={{ width: 100 }} />
        <PeriodPicker value={period} onChange={(v) => update({ period: v })} placeholder="执行期间(缺省最新)" />
        <OrgSelect value={orgId} onChange={(v) => update({ orgId: v })} placeholder="全部授权组织" />
        {writable && <Button type="primary" onClick={() => setImporting(true)}>导入项目预算</Button>}
      </Space>
      {linked.error && <QueryErrorResult title="指定批次加载失败" error={linked.error} refetch={linked.refetch} />}
      {summary.error ? <QueryErrorResult title="汇总加载失败" error={summary.error} refetch={summary.refetch} /> : s && (
        <Card size="small" style={{ marginBottom: 12 }} loading={summary.isLoading}
          title={s.batch ? <Typography.Text type="secondary" style={{ fontWeight: 400 }}>当前批次 #{s.batch.id} {s.batch.name} · {s.period} · 单位 元</Typography.Text> : '项目预算汇总'}>
          {s.notes.map((n) => <Alert key={n} type="info" showIcon message={n} style={{ marginBottom: 8 }} />)}
          {s.batch && (
            <>
              <TotalsRow totals={s.totals} />
              <Tabs style={{ marginTop: 8 }} items={[
                { key: 'project', label: '按项目', children: <Table rowKey="key" size="small" dataSource={s.byProject} pagination={{ pageSize: 20 }} columns={groupColumns({ title: '项目', render: (r) => `${r.label}` })} /> },
                { key: 'org', label: '按组织', children: <Table rowKey="key" size="small" dataSource={s.byOrg} pagination={false} columns={groupColumns({ title: '组织' })} /> },
                { key: 'fund', label: '按资金来源', children: <Table rowKey="key" size="small" dataSource={s.byFundSource} pagination={false} columns={groupColumns({ title: '资金来源' })} /> },
              ]} />
            </>
          )}
        </Card>
      )}
      <Typography.Title level={5}>导入批次</Typography.Title>
      <Input.Search key={keyword ?? ''} defaultValue={keyword} maxLength={100} allowClear placeholder="批次名称/期间" style={{ width: 240, marginBottom: 12 }} onSearch={(v) => update({ keyword: v.trim() || undefined })} />
      {batches.error ? <QueryErrorResult title="批次加载失败" error={batches.error} refetch={batches.refetch} /> : (
        <Table<PbBatchDto> rowKey="id" size="small" loading={batches.isFetching} dataSource={batches.data?.items ?? []} pagination={{
          current: batches.data?.page ?? page, pageSize, total: batches.data?.total ?? 0, showSizeChanger: true, pageSizeOptions: [10, 20, 50, 100],
          showTotal: (total) => `共 ${total} 条`, onChange: (p, size) => update({ page: size === pageSize ? p : 1, pageSize: size }, false),
        }} scroll={{ x: 1100 }}
          columns={[
            { title: '#', dataIndex: 'id', width: 60 },
            { title: '名称', dataIndex: 'name', ellipsis: true },
            { title: '期间', dataIndex: 'period', width: 90 },
            { title: '状态', key: 's', width: 130, render: (_, b) => <Space size={4}>{BATCH_STATUS[b.status]}{b.isCurrent && <Tag color="blue">当前</Tag>}{b.partial && <Tag>部分可见</Tag>}</Space> },
            { title: '行数', dataIndex: 'rowCount', width: 70 },
            { title: '年度预算', key: 'b', width: 140, align: 'right', render: (_, b) => <Money value={b.totals.budget} /> },
            { title: '已执行', key: 'e', width: 140, align: 'right', render: (_, b) => <Money value={b.totals.executed} /> },
            { title: '导入时间', dataIndex: 'createdAt', width: 120, render: (v: string) => shortTime(v) },
            {
              title: '操作', key: 'op', width: 220, render: (_, b) => (
                <Space size={0} wrap>
                  <Button type="link" size="small" onClick={() => setViewing(b)}>明细</Button>
                  <Button type="link" size="small" onClick={() => void download(`/project-budget/batches/${b.id}/original`, b.fileName)}>原件</Button>
                  {writable && b.status === 'imported' && !b.isCurrent && <Button type="link" size="small" disabled={act.isPending} onClick={() => act.mutate({ kind: 'activate', b })}>激活</Button>}
                  {writable && b.status === 'imported' && (
                    <Button type="link" size="small" danger disabled={act.isPending} onClick={async () => {
                      const v = await prompt({ title: `作废批次 #${b.id}`, danger: true, okText: '作废', fields: [{ name: 'reason', label: '作废原因', required: true, multiline: true }] });
                      if (v) act.mutate({ kind: 'void', b, reason: v.reason });
                    }}>作废</Button>
                  )}
                </Space>
              ),
            },
          ]}
        />
      )}
      <ImportModal open={importing} onClose={() => setImporting(false)} />
      <EntriesDrawer batch={viewing} onClose={() => setViewing(null)} />
    </div>
  );
}
