import { useAssistantDomainPage } from '../../assistant/contextHooks';
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { positiveQueryNumber, useListSearchParams } from '../../hooks/useListSearchParams';
import {
  Alert, App as AntdApp, Button, Col, DatePicker, Descriptions, Drawer, Empty, Form, Input, Modal, Radio, Row, Segmented, Select, Space, Table, Tag, Typography, Upload,
} from 'antd';
import dayjs from 'dayjs';
import { can, download, errorText } from '../../api/client';
import {
  expenseApi, type AuditRunDto, type ClaimDetailDto, type ClaimDto, type ClaimStatus, type Disposition, type FindingDto, type ReviewConclusion,
} from '../../api/projectContract';
import { QueryErrorResult } from '../../components/QueryErrorResult';
import { shortTime } from '../../utils/relativeTime';
import { compact, defaultOrgId, Money, OrgSelect, statusTag } from '../financeData/shared';
import { CLAIM_STATUS, CONCLUSION_LABEL, DISPOSITION_LABEL, EvidenceTags, MODEL_STATUS, OCR_STATUS, RISK, SEVERITY, SOURCE_LABEL } from './shared';

/**
 * AC-F22 费用审核:报销单(草稿 → 提交后后台审核运行:规则/OCR/模型)→ 人工复核(处置每条发现)→ 结论不可变;
 * 退回补件后补充附件重新提交,生成新的审核运行与新的复核。模型与 OCR 结果只作待复核参考。
 */

const moneyRule = { pattern: /^\d{1,13}(\.\d{1,2})?$/, message: '金额最多 2 位小数且大于 0' };
const dateItem = { getValueProps: (v?: string) => ({ value: v ? dayjs(v) : null }), normalize: (d: dayjs.Dayjs | null) => (d ? d.format('YYYY-MM-DD') : null) };

function ClaimFormModal({ open, claim, onClose, onSaved }: { open: boolean; claim?: ClaimDetailDto; onClose: () => void; onSaved: (c: ClaimDetailDto) => void }) {
  const { message } = AntdApp.useApp();
  const qc = useQueryClient();
  const [form] = Form.useForm();
  const save = useMutation({
    mutationFn: (v: Record<string, unknown>) => {
      const lines = ((v.lines as Record<string, unknown>[] | undefined) ?? []).map((l) => compact(l));
      const body = { ...compact(v), lines } as never;
      return claim ? expenseApi.updateClaim(claim.id, { ...(body as object), expectedReviewVersion: claim.reviewVersion } as never) : expenseApi.createClaim(body);
    },
    onSuccess: (c) => {
      void qc.invalidateQueries({ queryKey: ['claims'] });
      void qc.invalidateQueries({ queryKey: ['expense-queue'] });
      void qc.invalidateQueries({ queryKey: ['workbench-todos'] });
      void qc.invalidateQueries({ queryKey: ['dashboard-domains'] });
      message.success(claim ? '已保存' : `已创建报销单 ${c.claimNo}`); onSaved(c); onClose();
    },
    onError: (e) => message.error(errorText(e)),
  });
  return (
    <Modal open={open} title={claim ? `编辑报销单 ${claim.claimNo}` : '新建报销单'} width={900} onCancel={onClose} destroyOnClose confirmLoading={save.isPending}
      onOk={() => form.validateFields().then((v) => save.mutate(v))}>
      <Form form={form} layout="vertical" preserve={false}
        initialValues={claim ? {
          orgId: claim.orgId, applicant: claim.applicant, department: claim.department, expenseType: claim.expenseType, amount: claim.amount,
          occurredDate: claim.occurredDate, description: claim.description,
          lines: claim.lines.map((l) => ({ expenseType: l.expenseType, amount: l.amount, invoiceNo: l.invoiceNo, invoiceDate: l.invoiceDate, description: l.description })),
        } : { orgId: defaultOrgId(), occurredDate: dayjs().format('YYYY-MM-DD'), lines: [] }}>
        <Row gutter={12}>
          {!claim && <Col span={8}><Form.Item name="claimNo" label="单号(缺省自动生成)"><Input maxLength={64} /></Form.Item></Col>}
          <Col span={8}><Form.Item name="orgId" label="组织" rules={[{ required: true, message: '请选择组织' }]}><OrgSelect onChange={(v) => form.setFieldValue('orgId', v)} width={260} allowClear={false} /></Form.Item></Col>
          <Col span={8}><Form.Item name="applicant" label="申请人" rules={[{ required: true, whitespace: true }]}><Input maxLength={50} /></Form.Item></Col>
          <Col span={8}><Form.Item name="department" label="部门"><Input maxLength={100} /></Form.Item></Col>
          <Col span={8}><Form.Item name="expenseType" label="费用类型" rules={[{ required: true, whitespace: true }]}><Input maxLength={50} placeholder="如 差旅费" /></Form.Item></Col>
          <Col span={8}><Form.Item name="amount" label="报销金额(元)" rules={[{ required: true }, moneyRule]}><Input /></Form.Item></Col>
          <Col span={8}><Form.Item name="occurredDate" label="发生日期" rules={[{ required: true }]} {...dateItem}><DatePicker style={{ width: '100%' }} /></Form.Item></Col>
          <Col span={24}><Form.Item name="description" label="事由"><Input.TextArea rows={2} maxLength={1000} /></Form.Item></Col>
        </Row>
        <Typography.Text strong>明细</Typography.Text>
        <Form.List name="lines">
          {(fields, { add, remove }) => (
            <>
              {fields.map((f) => (
                <Space key={f.key} align="start" wrap style={{ display: 'flex', marginTop: 8 }}>
                  <Form.Item name={[f.name, 'expenseType']} rules={[{ required: true, whitespace: true, message: '费用类型' }]} noStyle><Input placeholder="费用类型" style={{ width: 110 }} /></Form.Item>
                  <Form.Item name={[f.name, 'amount']} rules={[{ required: true, message: '金额' }, moneyRule]}><Input placeholder="金额" style={{ width: 110 }} /></Form.Item>
                  <Form.Item name={[f.name, 'invoiceNo']} noStyle><Input placeholder="发票号" style={{ width: 130 }} /></Form.Item>
                  <Form.Item name={[f.name, 'invoiceDate']} noStyle {...dateItem}><DatePicker placeholder="开票日期" style={{ width: 130 }} /></Form.Item>
                  <Form.Item name={[f.name, 'description']} noStyle><Input placeholder="说明" style={{ width: 180 }} /></Form.Item>
                  <Button type="text" danger onClick={() => remove(f.name)} aria-label="删除明细"><i className="ri-delete-bin-line" aria-hidden /></Button>
                </Space>
              ))}
              <Button type="dashed" onClick={() => add({})} style={{ marginTop: 8 }}>添加明细</Button>
            </>
          )}
        </Form.List>
      </Form>
    </Modal>
  );
}

type DispositionState = Record<number, { disposition?: Disposition; note?: string }>;

function ReviewPanel({ claim, run, onDone }: { claim: ClaimDetailDto; run: AuditRunDto; onDone: (c: ClaimDetailDto) => void }) {
  const { message } = AntdApp.useApp();
  const [conclusion, setConclusion] = useState<ReviewConclusion>('pass');
  const [disp, setDisp] = useState<DispositionState>({});
  const [comment, setComment] = useState('');
  const [exceptionReason, setExceptionReason] = useState('');
  useEffect(() => { setDisp({}); }, [run.id]);
  const submit = useMutation({
    mutationFn: () => expenseApi.review(claim.id, {
      expectedReviewVersion: claim.reviewVersion, runId: run.id, conclusion,
      dispositions: Object.entries(disp).filter(([, d]) => d.disposition).map(([findingId, d]) => compact({ findingId: Number(findingId), disposition: d.disposition!, note: d.note })) as never,
      comment: comment.trim() || undefined, exceptionReason: exceptionReason.trim() || undefined,
    }),
    onSuccess: (c) => { message.success('复核已记录'); onDone(c); },
    onError: (e) => message.error(errorText(e)),
  });
  const undisposed = run.findings.filter((f) => !disp[f.id]?.disposition).length;
  return (
    <Space direction="vertical" style={{ width: '100%' }}>
      <Typography.Title level={5} style={{ margin: 0 }}>人工复核</Typography.Title>
      <Table<FindingDto> rowKey="id" size="small" pagination={false} dataSource={run.findings} locale={{ emptyText: '本次审核没有发现' }}
        columns={[
          { title: '级别', dataIndex: 'severity', width: 60, render: (v: string) => statusTag(SEVERITY, v) },
          { title: '发现', dataIndex: 'message' },
          {
            title: '处置', key: 'd', width: 330, render: (_, f) => (
              <Space.Compact style={{ width: '100%' }}>
                <Select placeholder="选择处置" style={{ width: 120 }} value={disp[f.id]?.disposition} aria-label={`处置 #${f.id} ${f.code}`}
                  onChange={(v: Disposition) => setDisp((s) => ({ ...s, [f.id]: { ...s[f.id], disposition: v } }))}
                  options={Object.entries(DISPOSITION_LABEL).map(([value, label]) => ({ value, label }))} />
                <Input placeholder="说明" value={disp[f.id]?.note} onChange={(e) => setDisp((s) => ({ ...s, [f.id]: { ...s[f.id], note: e.target.value } }))} />
              </Space.Compact>
            ),
          },
        ]} />
      <Radio.Group value={conclusion} onChange={(e) => setConclusion(e.target.value)} optionType="button"
        options={Object.entries(CONCLUSION_LABEL).map(([value, label]) => ({ value, label }))} />
      {conclusion !== 'supplement_required' && undisposed > 0 && <Alert type="warning" showIcon message={`通过/驳回须处置全部发现,还有 ${undisposed} 条未处置`} />}
      {conclusion === 'supplement_required' && <Alert type="info" showIcon message="退回补件须至少把一条发现标为「缺失材料」;申请人补充附件后重新提交。" />}
      {conclusion === 'pass' && run.riskLevel === 'high' && <Alert type="warning" showIcon message="高风险审核结果通过须填写例外原因" />}
      <Input.TextArea rows={2} maxLength={1000} placeholder="复核意见" value={comment} onChange={(e) => setComment(e.target.value)} />
      <Input.TextArea rows={2} maxLength={500} value={exceptionReason} onChange={(e) => setExceptionReason(e.target.value)}
        placeholder="例外原因:高风险通过、管理员复核本人提交的单据时必须填写,写入审计" />
      <Button type="primary" loading={submit.isPending} onClick={() => submit.mutate()}>提交复核(结论不可修改)</Button>
    </Space>
  );
}

function RunView({ run, current }: { run: AuditRunDto; current: boolean }) {
  return (
    <Space direction="vertical" style={{ width: '100%' }} size={8}>
      <Space wrap>
        <Typography.Text strong>审核运行 #{run.id}</Typography.Text>
        {statusTag(RISK, run.riskLevel)}
        <Tag>{OCR_STATUS[run.ocrStatus]}</Tag>
        <Tag>{MODEL_STATUS[run.modelStatus]}</Tag>
        {current ? <Tag color="blue">复核依据</Tag> : <Tag>历史</Tag>}
        <Typography.Text type="secondary">{shortTime(run.createdAt)}</Typography.Text>
      </Space>
      {run.policyRefs.length > 0 && <Typography.Text type="secondary">制度依据:{run.policyRefs.map((p) => `${p.code} v${p.version}`).join('、')}</Typography.Text>}
      <Table<FindingDto> rowKey="id" size="small" pagination={false} dataSource={run.findings} locale={{ emptyText: '没有发现' }}
        columns={[
          { title: '来源', dataIndex: 'source', width: 60, render: (v: string) => SOURCE_LABEL[v] },
          { title: '级别', dataIndex: 'severity', width: 60, render: (v: string) => statusTag(SEVERITY, v) },
          { title: '编码', dataIndex: 'code', width: 180, render: (v: string) => <Typography.Text code>{v}</Typography.Text> },
          { title: '发现', dataIndex: 'message' },
          { title: '条款', dataIndex: 'clauseLabel', width: 140, render: (v: string | null) => v ?? '—' },
          { title: '证据', dataIndex: 'evidence', width: 240, render: (v: FindingDto['evidence']) => <EvidenceTags evidence={v} /> },
        ]} />
    </Space>
  );
}

function ClaimDrawer({ id, onClose }: { id: number | null; onClose: () => void }) {
  const { message, modal } = AntdApp.useApp();
  const qc = useQueryClient();
  const [editing, setEditing] = useState(false);
  const [kindHint, setKindHint] = useState('');
  const q = useQuery({
    queryKey: ['claim', id], queryFn: () => expenseApi.claim(id!), enabled: id != null,
    refetchInterval: (query) => (query.state.data?.status === 'submitted' ? 2000 : false),
  });
  const c = q.data;
  const refresh = (d?: ClaimDetailDto) => {
    if (d) qc.setQueryData(['claim', id], d); else void qc.invalidateQueries({ queryKey: ['claim', id] });
    void qc.invalidateQueries({ queryKey: ['claims'] }); void qc.invalidateQueries({ queryKey: ['expense-queue'] });
    void qc.invalidateQueries({ queryKey: ['workbench-todos'] });
    void qc.invalidateQueries({ queryKey: ['dashboard-domains'] });
  };
  const run = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: (r) => {
      const d = r && typeof r === 'object' ? ('claim' in r ? (r as { claim: ClaimDetailDto }).claim : 'lines' in r ? r as ClaimDetailDto : undefined) : undefined;
      refresh(d);
    },
    onError: (e) => message.error(errorText(e)),
  });
  const editable = !!c && can('expense:submit') && (c.status === 'draft' || c.status === 'supplement');
  const reviewer = can('expense:review');
  const currentRun = c?.runs.find((r) => r.id === c.currentRunId) ?? null;
  return (
    <Drawer open={id != null} onClose={onClose} width={1100} destroyOnClose title={c ? `报销单 ${c.claimNo}` : '报销单'}
      extra={c && (
        <Space wrap>
          {c.status === 'draft' && can('expense:submit') && <Button onClick={() => setEditing(true)}>编辑</Button>}
          {editable && (
            <Button type="primary" onClick={() => modal.confirm({
              title: c.status === 'supplement' ? '补件后重新提交?' : '提交审核?',
              content: '提交后内容锁定并启动审核运行(规则、OCR、模型);复核结论生成后不可修改。',
              onOk: () => run.mutateAsync(() => expenseApi.submit(c.id, c.reviewVersion)).then(() => message.success('已提交,审核运行中')),
            })}>{c.status === 'supplement' ? '重新提交' : '提交审核'}</Button>
          )}
          {reviewer && (c.status === 'audited' || c.status === 'submitted') && (
            <Button onClick={() => run.mutate(() => expenseApi.rerun(c.id))}>重新审核</Button>
          )}
        </Space>
      )}>
      {q.error ? <QueryErrorResult title="报销单加载失败" error={q.error} refetch={q.refetch} /> : c && (
        <Space direction="vertical" style={{ width: '100%' }} size={16}>
          <Descriptions size="small" column={3} bordered>
            <Descriptions.Item label="组织">{c.orgName}</Descriptions.Item>
            <Descriptions.Item label="申请人">{c.applicant}{c.department ? ` · ${c.department}` : ''}</Descriptions.Item>
            <Descriptions.Item label="状态">{statusTag(CLAIM_STATUS, c.status)}{c.conclusion && <Tag>{CONCLUSION_LABEL[c.conclusion]}</Tag>}</Descriptions.Item>
            <Descriptions.Item label="费用类型">{c.expenseType}</Descriptions.Item>
            <Descriptions.Item label="金额"><Money value={c.amount} /></Descriptions.Item>
            <Descriptions.Item label="发生日期">{c.occurredDate}</Descriptions.Item>
            <Descriptions.Item label="提交">{c.submittedByName ? `${c.submittedByName} · ${shortTime(c.submittedAt!)}` : '—'}</Descriptions.Item>
            <Descriptions.Item label="提交轮次 / 版本">{c.submitRound} / v{c.reviewVersion}</Descriptions.Item>
            <Descriptions.Item label="内容哈希">{c.contentSha256 ? <Typography.Text code>{c.contentSha256.slice(0, 12)}…</Typography.Text> : '—'}</Descriptions.Item>
            <Descriptions.Item label="事由" span={3}>{c.description || '—'}</Descriptions.Item>
          </Descriptions>
          {c.status === 'submitted' && <Alert type="info" showIcon message="审核运行中(规则、OCR、模型),完成后进入待复核;页面会自动刷新。" />}
          <div>
            <Typography.Title level={5}>明细</Typography.Title>
            <Table rowKey="id" size="small" pagination={false} dataSource={c.lines} locale={{ emptyText: '无明细' }}
              columns={[
                { title: '#', dataIndex: 'lineNo', width: 50 }, { title: '费用类型', dataIndex: 'expenseType', width: 110 },
                { title: '金额', dataIndex: 'amount', width: 120, align: 'right', render: (v: string) => <Money value={v} /> },
                { title: '发票号', dataIndex: 'invoiceNo', width: 150 }, { title: '开票日期', dataIndex: 'invoiceDate', width: 110 }, { title: '说明', dataIndex: 'description' },
              ]} />
          </div>
          <div>
            <Space style={{ marginBottom: 8 }}>
              <Typography.Title level={5} style={{ margin: 0 }}>附件</Typography.Title>
              {editable && (
                <>
                  <Input placeholder="材料类别(如 住宿发票)" value={kindHint} onChange={(e) => setKindHint(e.target.value)} style={{ width: 180 }} />
                  <Upload showUploadList={false} beforeUpload={(f) => { run.mutate(() => expenseApi.addAttachment(c.id, f, kindHint.trim() || undefined)); return false; }}>
                    <Button icon={<i className="ri-upload-2-line" aria-hidden />}>上传附件</Button>
                  </Upload>
                </>
              )}
            </Space>
            <Table rowKey="id" size="small" pagination={false} dataSource={c.attachments} locale={{ emptyText: '无附件' }}
              columns={[
                { title: '名称', dataIndex: 'name', ellipsis: true }, { title: '类别', dataIndex: 'kindHint', width: 140 },
                { title: '轮次', dataIndex: 'submitRound', width: 60 }, { title: '上传', dataIndex: 'uploadedAt', width: 120, render: (v: string) => shortTime(v) },
                {
                  title: '', key: 'op', width: 130, render: (_, a) => (
                    <Space size={0}>
                      <Button type="link" size="small" onClick={() => void download(`/expense/claims/${c.id}/attachments/${a.id}/content`, a.name)}>下载</Button>
                      {editable && a.submitRound === c.submitRound + 1 && <Button type="link" size="small" danger onClick={() => run.mutate(() => expenseApi.removeAttachment(c.id, a.id))}>移除</Button>}
                    </Space>
                  ),
                },
              ]} />
          </div>
          {currentRun && <RunView run={currentRun} current />}
          {reviewer && c.status === 'audited' && currentRun && <ReviewPanel claim={c} run={currentRun} onDone={(d) => refresh(d)} />}
          {c.reviews.length > 0 && (
            <div>
              <Typography.Title level={5}>复核记录</Typography.Title>
              <Table rowKey="id" size="small" pagination={false} dataSource={c.reviews}
                columns={[
                  { title: '结论', dataIndex: 'conclusion', width: 90, render: (v: string) => CONCLUSION_LABEL[v] },
                  { title: '运行', dataIndex: 'runId', width: 70, render: (v: number) => `#${v}` },
                  { title: '处置', dataIndex: 'dispositions', render: (v: ClaimDetailDto['reviews'][number]['dispositions']) => <Space size={2} wrap>{v.map((d) => <Tag key={d.findingId}>#{d.findingId} {DISPOSITION_LABEL[d.disposition]}</Tag>)}</Space> },
                  { title: '意见', dataIndex: 'comment', ellipsis: true },
                  { title: '复核人', key: 'r', width: 200, render: (_, r) => <span>{r.reviewerName ?? '—'} · {shortTime(r.createdAt)}{r.selfReview && <Tag color="orange">同人例外</Tag>}{r.exceptionReason && <div><Typography.Text type="secondary">例外:{r.exceptionReason}</Typography.Text></div>}</span> },
                ]} />
            </div>
          )}
          {c.runs.filter((r) => r.id !== c.currentRunId).map((r) => <RunView key={r.id} run={r} current={false} />)}
        </Space>
      )}
      {c && <ClaimFormModal open={editing} claim={c} onClose={() => setEditing(false)} onSaved={(d) => refresh(d)} />}
    </Drawer>
  );
}

export default function ExpenseClaims() {
  const qc = useQueryClient();
  const { params, setParams, page, pageSize, update } = useListSearchParams();
  const status = (params.get('status') ?? undefined) as ClaimStatus | undefined;
  const openId = params.get('id') ? Number(params.get('id')) : null;
  const patch = (k: string, v: string | null) => setParams((p) => { const n = new URLSearchParams(p); if (v == null) n.delete(k); else n.set(k, v); return n; }, { replace: true });
  // 未选组织时由服务端返回全部授权范围;授权根不等于单据所属组织。
  const orgId = positiveQueryNumber(params.get('orgId'));
  const keyword = params.get('keyword')?.trim() || undefined;
  const [creating, setCreating] = useState(false);
  const queue = useQuery({
    queryKey: ['expense-queue', orgId], queryFn: () => expenseApi.queue(orgId),
    refetchInterval: (query) => query.state.data?.counts.submitted ? 2000 : false,
  });
  const list = useQuery({
    queryKey: ['claims', status, orgId, keyword, page, pageSize], queryFn: () => expenseApi.claimsPage({ ...compact({ status, orgId, keyword }), page, pageSize }),
    refetchInterval: (query) => query.state.data?.items.some((c) => c.status === 'submitted') ? 2000 : false,
  });
  useEffect(() => { if (list.data && list.data.page !== page) update({ page: list.data.page }, false); }, [list.data?.page, page, update]);
  useAssistantDomainPage({ pageKey: 'expense', ready: !list.isLoading && !list.error, scope: { orgScopeId: orgId, claimId: openId ?? undefined }, view: { status, keyword } });
  const counts = queue.error ? undefined : queue.data?.counts;
  const submittedCount = queue.data?.counts.submitted;
  const auditedCount = queue.data?.counts.audited;
  useEffect(() => {
    if (submittedCount == null || auditedCount == null) return;
    // 审核运行可能在详情关闭后结束;刷新当前状态筛选及首页待办。
    void qc.invalidateQueries({ queryKey: ['claims'] });
    void qc.invalidateQueries({ queryKey: ['workbench-todos'] });
    void qc.invalidateQueries({ queryKey: ['dashboard-domains'] });
  }, [qc, submittedCount, auditedCount]);
  return (
    <div>
      <Space wrap style={{ marginBottom: 12 }}>
        <Segmented value={status ?? 'all'} onChange={(v) => update({ status: v === 'all' ? undefined : String(v) })}
          options={[{ value: 'all', label: '全部' }, ...Object.entries(CLAIM_STATUS).map(([value, m]) => ({ value, label: `${m.text}${counts ? ` ${counts[value as ClaimStatus]}` : ''}` }))]} />
        <OrgSelect value={orgId} onChange={(v) => update({ orgId: v })} placeholder="全部授权组织" />
        <Input.Search key={keyword ?? ''} defaultValue={keyword} maxLength={100} allowClear placeholder="单号/申请人/事由" onSearch={(v) => update({ keyword: v.trim() || undefined })} style={{ width: 200 }} />
        {can('expense:submit') && <Button type="primary" onClick={() => setCreating(true)}>新建报销单</Button>}
      </Space>
      {queue.error && <Alert type="warning" showIcon message="状态统计加载失败" description={errorText(queue.error)}
        action={<Button size="small" loading={queue.isFetching} onClick={() => void queue.refetch()}>重试</Button>} style={{ marginBottom: 12 }} />}
      {list.error ? <QueryErrorResult title="报销单加载失败" error={list.error} refetch={list.refetch} /> : (
        <Table<ClaimDto> rowKey="id" size="small" loading={list.isFetching} dataSource={list.data?.items ?? []} pagination={{
          current: list.data?.page ?? page, pageSize, total: list.data?.total ?? 0, showSizeChanger: true, pageSizeOptions: [10, 20, 50, 100],
          showTotal: (total) => `共 ${total} 条`, onChange: (p, size) => update({ page: size === pageSize ? p : 1, pageSize: size }, false),
        }}
          locale={{ emptyText: <Empty description="没有报销单" /> }}
          onRow={(r) => ({ onClick: () => patch('id', String(r.id)), style: { cursor: 'pointer' } })}
          columns={[
            { title: '单号', dataIndex: 'claimNo', width: 150 },
            { title: '组织', dataIndex: 'orgName', width: 120 },
            { title: '申请人', dataIndex: 'applicant', width: 100 },
            { title: '费用类型', dataIndex: 'expenseType', width: 100 },
            { title: '金额', dataIndex: 'amount', width: 130, align: 'right', render: (v: string) => <Money value={v} /> },
            { title: '发生日期', dataIndex: 'occurredDate', width: 110 },
            { title: '状态', dataIndex: 'status', width: 100, render: (v: string, r) => <Space size={2}>{statusTag(CLAIM_STATUS, v)}{r.conclusion && <Tag>{CONCLUSION_LABEL[r.conclusion]}</Tag>}</Space> },
            { title: '风险', dataIndex: 'latestRiskLevel', width: 90, render: (v: string | null) => statusTag(RISK, v) ?? '—' },
            { title: '事由', dataIndex: 'description', ellipsis: true },
          ]} />
      )}
      <ClaimFormModal open={creating} onClose={() => setCreating(false)} onSaved={(c) => patch('id', String(c.id))} />
      <ClaimDrawer id={openId} onClose={() => patch('id', null)} />
    </div>
  );
}
