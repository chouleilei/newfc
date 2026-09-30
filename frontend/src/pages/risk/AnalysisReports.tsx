import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import {
  Alert, App as AntdApp, Button, Card, Checkbox, Descriptions, Drawer, Empty, Form, Input, InputNumber, Modal, Popconfirm, Select, Space, Table, Tabs, Tag, Typography,
} from 'antd';
import { api, can, download, errorText, getSession } from '../../api/client';
import {
  reportApi, waitJob, type RptKind, type RptReportDto, type RptReportListItemDto, type RptSectionDto, type RptStatus,
} from '../../api/riskInvestment';
import { QueryErrorResult } from '../../components/QueryErrorResult';
import { useUrlId } from '../../hooks/useUrlId';
import { shortTime } from '../../utils/relativeTime';
import { compact, EXCEPTION_REASON_FIELD, OrgSelect, statusTag, usePrompt } from '../financeData/shared';
import { MODEL_STATUS_LABEL, RPT_KIND_LABEL, RPT_STATUS } from './shared';

/**
 * AC-F18 分析报告:生成草稿(模板叙述 + 可选模型改写,事实不变)→ 编辑(留历史)→ 提交 → 他人审批/退回 → 发布(后台渲染 DOCX/PDF 并冻结)。
 * 已发布只能修订(生成新修订号草稿),新修订发布后旧版本标记为已被替代。
 */

const KINDS = Object.keys(RPT_KIND_LABEL) as RptKind[];
type VersionOption = { id: number; year: number; name: string; status: string; is_current: 0 | 1 };

function GenerateModal({ open, onClose, onDone }: { open: boolean; onClose: () => void; onDone: (r: RptReportDto) => void }) {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<{ kind: RptKind; title?: string; orgId?: number; year?: number; versionId?: number; targetVersionId?: number; useModel: boolean }>();
  const kind = Form.useWatch('kind', form);
  const allOrgs = !!getSession()?.user.allOrgs;
  const versions = useQuery({ queryKey: ['budget-versions-lite'], queryFn: () => api.get<VersionOption[]>('/versions'), enabled: open && can('budget:read'), staleTime: 60_000 });
  const versionOptions = (versions.data ?? []).map((v) => ({ value: v.id, label: `${v.year} · ${v.name}${v.is_current ? '(当前)' : ''}` }));
  const gen = useMutation({
    mutationFn: (v: { kind: RptKind; title?: string; orgId?: number; year?: number; versionId?: number; targetVersionId?: number; useModel: boolean }) =>
      reportApi.generate({ ...compact({ ...v, title: v.title?.trim() }), kind: v.kind, useModel: v.useModel }),
    onSuccess: (r) => { message.success(`已生成草稿 ${r.seriesNo}`); onDone(r); onClose(); },
    onError: (e) => message.error(errorText(e)),
  });
  const needsVersion = kind === 'monthly_execution' || kind === 'budget_discussion';
  return (
    <Modal open={open} title="生成分析报告" onCancel={onClose} destroyOnClose confirmLoading={gen.isPending} okText="生成草稿"
      onOk={() => form.validateFields().then((v) => gen.mutate(v))}>
      <Form form={form} layout="vertical" preserve={false} initialValues={{ kind: 'risk_investment', useModel: true, year: new Date().getFullYear() }}>
        <Form.Item name="kind" label="报告类型" rules={[{ required: true }]}><Select options={KINDS.map((k) => ({ value: k, label: RPT_KIND_LABEL[k] }))} /></Form.Item>
        <Form.Item name="title" label="标题(缺省自动生成)"><Input maxLength={200} /></Form.Item>
        <Form.Item name="orgId" label={`组织${allOrgs ? '(不选为集团口径)' : ''}`} rules={allOrgs ? [] : [{ required: true, message: '请选择组织' }]}
          extra={kind && kind !== 'monthly_execution' && kind !== 'risk_investment' ? '该类型为集团口径,需要全组织权限' : undefined}>
          <OrgSelect value={form.getFieldValue('orgId')} onChange={(v) => form.setFieldValue('orgId', v)} width={320} />
        </Form.Item>
        {(kind === 'annual_review' || kind === 'risk_investment') && (
          <Form.Item name="year" label="年度" rules={kind === 'annual_review' ? [{ required: true }] : []}><InputNumber min={2000} max={2100} style={{ width: 160 }} /></Form.Item>
        )}
        {needsVersion && (
          <Form.Item name="versionId" label="预算版本" rules={[{ required: true, message: '请选择预算版本' }]}>
            <Select showSearch optionFilterProp="label" loading={versions.isLoading} options={versionOptions} />
          </Form.Item>
        )}
        {kind === 'budget_discussion' && (
          <Form.Item name="targetVersionId" label="对比版本(可选)"><Select allowClear showSearch optionFilterProp="label" options={versionOptions} /></Form.Item>
        )}
        <Form.Item name="useModel" valuePropName="checked" extra="模型只改写叙述;若改动了金额等事实则自动保留模板叙述。"><Checkbox>尝试用模型润色叙述</Checkbox></Form.Item>
      </Form>
    </Modal>
  );
}

function SectionEditor({ report, section, onClose, onSaved }: { report: RptReportDto; section: RptSectionDto | null; onClose: () => void; onSaved: (r: RptReportDto) => void }) {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm<{ title: string; body: string }>();
  const save = useMutation({
    mutationFn: (v: { title: string; body: string }) => reportApi.updateSection(report.id, section!.id, { expectedVersion: report.version, body: v.body, title: v.title.trim() }),
    onSuccess: (r) => { message.success('已保存,编辑历史已记录'); onSaved(r); onClose(); },
    onError: (e) => message.error(errorText(e)),
  });
  if (!section) return null;
  return (
    <Modal open width={820} title={`编辑章节:${section.title}`} onCancel={onClose} destroyOnClose confirmLoading={save.isPending} onOk={() => form.validateFields().then((v) => save.mutate(v))}>
      <Form form={form} layout="vertical" preserve={false} initialValues={{ title: section.title, body: section.body }}>
        <Form.Item name="title" label="章节标题" rules={[{ required: true, whitespace: true }]}><Input maxLength={200} /></Form.Item>
        <Form.Item name="body" label="正文"><Input.TextArea rows={16} maxLength={50_000} showCount /></Form.Item>
      </Form>
    </Modal>
  );
}

function ReportDrawer({ id, onClose, onOpen }: { id: number | null; onClose: () => void; onOpen: (id: number) => void }) {
  const { message } = AntdApp.useApp();
  const qc = useQueryClient();
  const [prompt, holder] = usePrompt();
  const [editing, setEditing] = useState<RptSectionDto | null>(null);
  const [publishing, setPublishing] = useState(false);
  const q = useQuery({ queryKey: ['analysis-report', id], queryFn: () => reportApi.get(id!), enabled: id != null });
  const r = q.data;
  const revisions = useQuery({ queryKey: ['analysis-report-revisions', id], queryFn: () => reportApi.revisions(id!), enabled: id != null });
  const edits = useQuery({ queryKey: ['analysis-report-edits', id], queryFn: () => reportApi.edits(id!), enabled: id != null && !!r?.editCount });
  const refresh = (d?: RptReportDto) => {
    if (d) qc.setQueryData(['analysis-report', id], d); else void qc.invalidateQueries({ queryKey: ['analysis-report', id] });
    void qc.invalidateQueries({ queryKey: ['analysis-reports'] }); void qc.invalidateQueries({ queryKey: ['analysis-report-revisions', id] });
    void qc.invalidateQueries({ queryKey: ['analysis-report-edits', id] });
  };
  const run = useMutation({
    mutationFn: (fn: () => Promise<RptReportDto | void>) => fn(),
    onSuccess: (d) => { message.success('已完成'); refresh(d || undefined); },
    onError: (e) => message.error(errorText(e)),
  });
  const allowed = new Set(r?.allowed ?? []);

  const approve = async () => {
    const v = await prompt({ title: '审批通过', fields: [{ name: 'comment', label: '审批意见', multiline: true }, EXCEPTION_REASON_FIELD] });
    if (v && r) run.mutate(() => reportApi.approve(r.id, compact({ expectedVersion: r.version, comment: v.comment, exceptionReason: v.exceptionReason }) as { expectedVersion: number }));
  };
  const returnBack = async () => {
    const v = await prompt({ title: '退回修改', fields: [{ name: 'comment', label: '退回意见', required: true, multiline: true }], danger: true, okText: '退回' });
    if (v && r) run.mutate(() => reportApi.returnBack(r.id, r.version, v.comment));
  };
  const publish = async () => {
    if (!r) return;
    setPublishing(true);
    try {
      const { jobId } = await reportApi.publish(r.id, r.version);
      const job = await waitJob(jobId);
      if (job.status === 'succeeded') message.success('已发布,DOCX/PDF 已冻结保存');
      else message.error(`发布失败:${job.error?.message ?? job.status}`);
      refresh();
    } catch (e) {
      message.error(errorText(e));
    } finally {
      setPublishing(false);
    }
  };
  const revise = () => r && run.mutate(async () => { const d = await reportApi.revise(r.id, r.version); onOpen(d.id); return undefined; });
  const remove = () => r && run.mutate(async () => { await reportApi.remove(r.id, r.version); onClose(); });
  const exportAs = (format: 'docx' | 'pdf') => r && void download(reportApi.exportPath(r.id, format), `${r.seriesNo}-R${r.revisionNo}.${format}`);

  return (
    <Drawer open={id != null} onClose={onClose} width={980} destroyOnClose title={r ? `${r.seriesNo} · 修订 ${r.revisionNo} · ${r.title}` : '分析报告'}
      extra={r && (
        <Space wrap>
          {allowed.has('submit') && <Button type="primary" loading={run.isPending} onClick={() => run.mutate(() => reportApi.submit(r.id, r.version))}>提交审批</Button>}
          {allowed.has('approve') && <Button type="primary" onClick={() => void approve()}>审批通过</Button>}
          {allowed.has('return') && <Button danger onClick={() => void returnBack()}>退回</Button>}
          {allowed.has('publish') && <Button type="primary" loading={publishing} onClick={() => void publish()}>发布</Button>}
          {allowed.has('revise') && <Button onClick={revise}>修订</Button>}
          {allowed.has('delete') && <Popconfirm title="删除该草稿?" onConfirm={remove}><Button danger>删除草稿</Button></Popconfirm>}
          <Button onClick={() => exportAs('docx')}>导出 DOCX</Button>
          <Button onClick={() => exportAs('pdf')}>导出 PDF</Button>
        </Space>
      )}>
      {holder}
      {q.error ? <QueryErrorResult title="报告加载失败" error={q.error} refetch={q.refetch} /> : !r ? null : (
        <Space direction="vertical" size="middle" style={{ width: '100%' }}>
          {r.status !== 'published' && r.status !== 'superseded' && <Alert type="info" showIcon message="未发布的报告导出时带“草稿”水印;发布后下载冻结保存的文件。" />}
          {r.returnComment && r.status === 'draft' && <Alert type="warning" showIcon message="审批退回" description={r.returnComment} />}
          {r.status === 'superseded' && <Alert type="warning" showIcon message="该版本已被新修订替代" />}
          <Descriptions size="small" column={3} bordered>
            <Descriptions.Item label="类型">{RPT_KIND_LABEL[r.kind]}</Descriptions.Item>
            <Descriptions.Item label="状态">{statusTag(RPT_STATUS, r.status)}</Descriptions.Item>
            <Descriptions.Item label="组织">{r.orgName ?? '集团'}</Descriptions.Item>
            <Descriptions.Item label="叙述来源" span={3}>{MODEL_STATUS_LABEL(r.modelStatus)}</Descriptions.Item>
            <Descriptions.Item label="创建">{r.createdByName ?? '—'} · {shortTime(r.createdAt)}</Descriptions.Item>
            <Descriptions.Item label="提交">{r.submittedAt ? shortTime(r.submittedAt) : '—'}</Descriptions.Item>
            <Descriptions.Item label="审批">{r.approvedAt ? `${shortTime(r.approvedAt)}${r.selfApproval ? '(例外自审)' : ''}` : '—'}</Descriptions.Item>
            {r.approvalComment && <Descriptions.Item label="审批意见" span={3}>{r.approvalComment}</Descriptions.Item>}
            {r.exceptionReason && <Descriptions.Item label="例外原因" span={3}>{r.exceptionReason}</Descriptions.Item>}
            {r.publication && <Descriptions.Item label="发布快照" span={3}>{shortTime(r.publication.createdAt)} · sha256 {r.publication.snapshotSha256.slice(0, 16)}…</Descriptions.Item>}
          </Descriptions>
          <Tabs items={[
            {
              key: 'sections', label: `正文(${r.sections.length} 节)`,
              children: (
                <Space direction="vertical" style={{ width: '100%' }}>
                  {r.sections.map((s) => (
                    <Card key={s.id} size="small" title={<Space>{s.title}{s.edited && <Tag>已编辑</Tag>}</Space>}
                      extra={allowed.has('edit') && <Button size="small" onClick={() => setEditing(s)}>编辑</Button>}>
                      {s.body.trim() ? <Typography.Paragraph style={{ whiteSpace: 'pre-wrap', marginBottom: 0 }}>{s.body}</Typography.Paragraph>
                        : <Typography.Text type="danger">(空章节,提交前需补充)</Typography.Text>}
                    </Card>
                  ))}
                </Space>
              ),
            },
            {
              key: 'edits', label: `编辑历史(${r.editCount})`,
              children: (
                <Table rowKey="id" size="small" loading={edits.isLoading} dataSource={edits.data ?? []} expandable={{
                  expandedRowRender: (e) => (
                    <Space align="start" style={{ width: '100%' }}>
                      <pre style={{ whiteSpace: 'pre-wrap', flex: 1, margin: 0 }}><Typography.Text type="secondary">修改前:</Typography.Text>{'\n'}{e.beforeBody}</pre>
                      <pre style={{ whiteSpace: 'pre-wrap', flex: 1, margin: 0 }}><Typography.Text type="secondary">修改后:</Typography.Text>{'\n'}{e.afterBody}</pre>
                    </Space>
                  ),
                }} columns={[
                  { title: '时间', dataIndex: 'createdAt', width: 150, render: (v: string) => shortTime(v) },
                  { title: '章节', dataIndex: 'sectionTitle' },
                  { title: '编辑人', dataIndex: 'actorName', width: 120 },
                ]} />
              ),
            },
            {
              key: 'revisions', label: '修订记录',
              children: (
                <Table<RptReportListItemDto> rowKey="id" size="small" dataSource={revisions.data ?? []} pagination={false}
                  onRow={(x) => ({ onClick: () => x.id !== r.id && onOpen(x.id), style: { cursor: x.id !== r.id ? 'pointer' : undefined } })}
                  columns={[
                    { title: '修订号', dataIndex: 'revisionNo', width: 80 },
                    { title: '状态', dataIndex: 'status', width: 100, render: (v: RptStatus) => statusTag(RPT_STATUS, v) },
                    { title: '发布时间', dataIndex: 'publishedAt', render: (v: string | null) => (v ? shortTime(v) : '—') },
                    { title: '', key: 'cur', width: 80, render: (_: unknown, x) => (x.id === r.id ? <Tag color="blue">当前</Tag> : null) },
                  ]} />
              ),
            },
          ]} />
          <SectionEditor report={r} section={editing} onClose={() => setEditing(null)} onSaved={(d) => refresh(d)} />
        </Space>
      )}
    </Drawer>
  );
}

export default function AnalysisReports() {
  const [params, setParams] = useSearchParams();
  const status = (params.get('status') as RptStatus | null) ?? undefined;
  const [kind, setKind] = useState<RptKind>();
  const [orgId, setOrgId] = useState<number>();
  const [keyword, setKeyword] = useState('');
  const [openId, setOpenId] = useUrlId();
  const [generating, setGenerating] = useState(false);
  const qc = useQueryClient();
  const query = compact({ status, kind, orgId, keyword: keyword.trim() });
  const list = useQuery({ queryKey: ['analysis-reports', query], queryFn: () => reportApi.list(query) });
  const setStatus = (v?: RptStatus) => { const p = new URLSearchParams(params); if (v) p.set('status', v); else p.delete('status'); setParams(p, { replace: true }); };
  return (
    <div>
      <Space wrap style={{ marginBottom: 12 }}>
        <Select allowClear placeholder="状态" style={{ width: 130 }} value={status} onChange={setStatus}
          options={(Object.keys(RPT_STATUS) as RptStatus[]).map((k) => ({ value: k, label: RPT_STATUS[k].text }))} />
        <Select allowClear placeholder="类型" style={{ width: 150 }} value={kind} onChange={setKind} options={KINDS.map((k) => ({ value: k, label: RPT_KIND_LABEL[k] }))} />
        <OrgSelect value={orgId} onChange={setOrgId} />
        <Input.Search allowClear placeholder="编号/标题" style={{ width: 200 }} onSearch={setKeyword} />
        {can('report:write') && <Button type="primary" onClick={() => setGenerating(true)}>生成报告</Button>}
      </Space>
      {list.error ? <QueryErrorResult title="报告列表加载失败" error={list.error} refetch={list.refetch} /> : (
        <Table<RptReportListItemDto>
          rowKey="id" size="small" loading={list.isLoading} dataSource={list.data ?? []}
          locale={{ emptyText: <Empty description="没有报告" /> }}
          onRow={(r) => ({ onClick: () => setOpenId(r.id), style: { cursor: 'pointer' } })}
          columns={[
            { title: '编号', dataIndex: 'seriesNo', width: 170, render: (v: string, r) => `${v} · R${r.revisionNo}` },
            { title: '标题', dataIndex: 'title', ellipsis: true },
            { title: '类型', dataIndex: 'kind', width: 130, render: (v: RptKind) => RPT_KIND_LABEL[v] },
            { title: '组织', dataIndex: 'orgName', width: 120, render: (v: string | null) => v ?? '集团' },
            { title: '状态', dataIndex: 'status', width: 100, render: (v: RptStatus) => statusTag(RPT_STATUS, v) },
            { title: '创建人', dataIndex: 'createdByName', width: 100 },
            { title: '更新', dataIndex: 'updatedAt', width: 140, render: (v: string) => shortTime(v) },
          ]}
        />
      )}
      <GenerateModal open={generating} onClose={() => setGenerating(false)} onDone={(r) => { void qc.invalidateQueries({ queryKey: ['analysis-reports'] }); setOpenId(r.id); }} />
      <ReportDrawer id={openId} onClose={() => setOpenId(null)} onOpen={setOpenId} />
    </div>
  );
}
