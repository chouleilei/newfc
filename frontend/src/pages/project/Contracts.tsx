import { useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useSearchParams } from 'react-router-dom';
import {
  Alert, App as AntdApp, Button, Card, Col, DatePicker, Descriptions, Drawer, Empty, Form, Input, Modal, Row, Select, Space, Table, Tabs, Tag, Timeline, Typography, Upload,
} from 'antd';
import dayjs from 'dayjs';
import { api, can, download, errorText } from '../../api/client';
import {
  contractApi, type ContractDetailDto, type ContractDocType, type ContractDto, type ContractStage, type ContractTodo,
} from '../../api/projectContract';
import { QueryErrorResult } from '../../components/QueryErrorResult';
import { shortTime } from '../../utils/relativeTime';
import { compact, defaultOrgId, EXCEPTION_REASON_FIELD, Money, OrgSelect, Ratio, statusTag, usePrompt } from '../financeData/shared';
import { CONTRACT_DOC_TYPE_LABELS, CONTRACT_STAGE_LABELS, CONTRACT_STAGE_ORDER, CONTRACT_STATUS, FLOW_STATUS } from './shared';

/**
 * AC-F16 合同台账与生命周期:阶段推进(服务端重算 blocker)、审核、变更、付款(申请 → 复核 → 凭发票支付)、文档与事件。
 * 复核动作要求提交人 ≠ 复核人;管理员同人复核须填例外原因。
 */

export const TODO_LABEL: Record<ContractTodo, string> = { review: '待审核合同', change: '待复核变更', payment: '待复核付款', pay: '已批准待支付' };

interface MasterOption { id: number; code: string | null; name: string }
function useMasterOptions(kind: 'projects' | 'suppliers', enabled: boolean) {
  const q = useQuery({ queryKey: ['master-options', kind], queryFn: () => api.get<MasterOption[]>(`/master/${kind}`), enabled, staleTime: 60_000 });
  return { loading: q.isLoading, options: (q.data ?? []).map((m) => ({ value: m.id, label: `${m.name}${m.code ? `(${m.code})` : ''}` })) };
}

const dateField = (label: string, name: string) => (
  <Form.Item name={name} label={label} getValueProps={(v?: string) => ({ value: v ? dayjs(v) : null })} normalize={(d: dayjs.Dayjs | null) => (d ? d.format('YYYY-MM-DD') : null)}>
    <DatePicker style={{ width: '100%' }} />
  </Form.Item>
);
const moneyRule = { pattern: /^-?\d{1,13}(\.\d{1,2})?$/, message: '金额最多 2 位小数' };

function ContractFormModal({ open, contract, onClose, onSaved }: { open: boolean; contract?: ContractDetailDto; onClose: () => void; onSaved: (c: ContractDetailDto) => void }) {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm();
  const projects = useMasterOptions('projects', open);
  const suppliers = useMasterOptions('suppliers', open);
  const amountLocked = !!contract && CONTRACT_STAGE_ORDER.indexOf(contract.stage) >= CONTRACT_STAGE_ORDER.indexOf('approval');
  const save = useMutation({
    mutationFn: (v: Record<string, unknown>) => {
      const body: Record<string, unknown> = { ...v, paymentCapRatio: v.paymentCapRatio || null };
      if (!contract) return contractApi.create(compact(body) as never);
      const { contractNo: _no, orgId: _org, ...rest } = body;
      if (amountLocked) delete rest.originalAmount;
      return contractApi.update(contract.id, { ...rest, projectId: rest.projectId ?? null, supplierId: rest.supplierId ?? null, expectedVersion: contract.version });
    },
    onSuccess: (c) => { message.success(contract ? '已保存' : `已创建合同 ${c.contractNo}`); onSaved(c); onClose(); },
    onError: (e) => message.error(errorText(e)),
  });
  return (
    <Modal open={open} title={contract ? `编辑合同 ${contract.contractNo}` : '新建合同'} width={720} onCancel={onClose} destroyOnClose confirmLoading={save.isPending}
      onOk={() => form.validateFields().then((v) => save.mutate(v))}>
      <Form form={form} layout="vertical" preserve={false}
        initialValues={contract ? {
          contractNo: contract.contractNo, name: contract.name, contractType: contract.contractType, orgId: contract.orgId, projectId: contract.projectId, supplierId: contract.supplierId,
          originalAmount: contract.originalAmount, paymentCapRatio: contract.paymentCapRatio ?? '', signDate: contract.signDate, effectiveDate: contract.effectiveDate,
        } : { orgId: defaultOrgId(), originalAmount: '0.00' }}>
        <Row gutter={12}>
          <Col span={12}><Form.Item name="contractNo" label="合同编号" rules={[{ required: true, whitespace: true }]}><Input maxLength={64} disabled={!!contract} /></Form.Item></Col>
          <Col span={12}><Form.Item name="name" label="合同名称" rules={[{ required: true, whitespace: true }]}><Input maxLength={200} /></Form.Item></Col>
          <Col span={12}><Form.Item name="orgId" label="组织" rules={[{ required: true, message: '请选择组织' }]}><OrgSelect onChange={(v) => form.setFieldValue('orgId', v)} width={320} allowClear={false} /></Form.Item></Col>
          <Col span={12}><Form.Item name="contractType" label="合同类型"><Input maxLength={50} /></Form.Item></Col>
          <Col span={12}><Form.Item name="projectId" label="项目"><Select allowClear showSearch optionFilterProp="label" loading={projects.loading} options={projects.options} /></Form.Item></Col>
          <Col span={12}><Form.Item name="supplierId" label="供应商"><Select allowClear showSearch optionFilterProp="label" loading={suppliers.loading} options={suppliers.options} /></Form.Item></Col>
          <Col span={12}>
            <Form.Item name="originalAmount" label="原始金额(元)" rules={[{ required: true }, moneyRule]} extra={amountLocked ? '进入审批签署后金额只能通过变更调整' : undefined}>
              <Input disabled={amountLocked} />
            </Form.Item>
          </Col>
          <Col span={12}><Form.Item name="paymentCapRatio" label="付款上限比例(0～1,可空)" rules={[{ pattern: /^(0(\.\d{1,6})?|1(\.0{1,6})?)?$/, message: '0～1 的小数' }]}><Input placeholder="如 0.95" /></Form.Item></Col>
          <Col span={12}>{dateField('签订日期', 'signDate')}</Col>
          <Col span={12}>{dateField('生效日期', 'effectiveDate')}</Col>
        </Row>
      </Form>
    </Modal>
  );
}

type DocPick = { id: number; name: string; docType: ContractDocType };
const docOptions = (docs: DocPick[], types?: ContractDocType[]) => docs.filter((d) => !types || types.includes(d.docType)).map((d) => ({ value: d.id, label: `${CONTRACT_DOC_TYPE_LABELS[d.docType]} · ${d.name}` }));

function ContractDrawer({ id, onClose }: { id: number | null; onClose: () => void }) {
  const { message, modal } = AntdApp.useApp();
  const qc = useQueryClient();
  const [prompt, holder] = usePrompt();
  const [editing, setEditing] = useState(false);
  const [docType, setDocType] = useState<ContractDocType>('contract_text');
  const q = useQuery({ queryKey: ['contract', id], queryFn: () => contractApi.get(id!), enabled: id != null });
  const c = q.data;
  const refresh = (d?: ContractDetailDto) => {
    if (d) qc.setQueryData(['contract', id], d); else void qc.invalidateQueries({ queryKey: ['contract', id] });
    void qc.invalidateQueries({ queryKey: ['contracts'] }); void qc.invalidateQueries({ queryKey: ['contract-summary'] });
  };
  const run = useMutation({
    mutationFn: (fn: () => Promise<unknown>) => fn(),
    onSuccess: (r) => { message.success('已完成'); refresh(r && typeof r === 'object' && 'blockers' in r ? r as ContractDetailDto : undefined); },
    onError: (e) => message.error(errorText(e)),
  });
  const writable = can('contract:write') && c?.status === 'active';
  const reviewer = can('contract:review');
  const docs: DocPick[] = c?.documents ?? [];

  const decide = async (kind: 'review' | 'change' | 'payment', rid: number) => {
    const v = await prompt({
      title: '复核', fields: [
        { name: 'decision', label: '结论', required: true, options: [{ value: 'approve', label: '批准' }, { value: 'reject', label: '驳回' }], initial: 'approve' },
        { name: 'comment', label: '意见', multiline: true }, EXCEPTION_REASON_FIELD,
      ],
    });
    if (!v || !c) return;
    const body = compact({ decision: v.decision as 'approve' | 'reject', comment: v.comment, exceptionReason: v.exceptionReason }) as { decision: 'approve' | 'reject' };
    run.mutate(() => (kind === 'review' ? contractApi.decideReview(c.id, rid, body) : kind === 'change' ? contractApi.decideChange(c.id, rid, body) : contractApi.decidePayment(c.id, rid, body)));
  };
  const command = async (kind: 'terminate' | 'void' | 'reopen') => {
    if (!c) return;
    const fields = [{ name: 'reason', label: '原因', required: true, multiline: true }];
    const v = await prompt({
      title: kind === 'terminate' ? '终止合同' : kind === 'void' ? '作废合同' : '重开合同', danger: kind !== 'reopen',
      description: kind === 'void' ? '作废后不可重开;已有付款的合同只能终止。' : kind === 'terminate' ? '终止后可由复核人重开。' : undefined,
      fields: kind === 'reopen' ? [...fields, { name: 'targetStage', label: '回到阶段', required: true, options: CONTRACT_STAGE_ORDER.filter((s) => s !== 'archived').map((s) => ({ value: s, label: CONTRACT_STAGE_LABELS[s] })), initial: 'performance' }] : fields,
    });
    if (!v) return;
    run.mutate(() => (kind === 'terminate' ? contractApi.terminate(c.id, c.version, v.reason) : kind === 'void' ? contractApi.void(c.id, c.version, v.reason)
      : contractApi.reopen(c.id, c.version, v.reason, v.targetStage as ContractStage)));
  };
  const submitChange = async () => {
    const v = await prompt({
      title: '提交金额变更', description: '正数为增加、负数为减少;复核批准后计入当前金额。', fields: [
        { name: 'delta', label: '变更金额(元)', required: true, placeholder: '如 20000.00 或 -5000.00' },
        { name: 'reason', label: '变更原因', required: true, multiline: true },
        { name: 'evidenceDocumentId', label: '变更依据文档', required: true, options: docOptions(docs, ['change', 'settlement', 'other']).map((o) => ({ ...o, value: String(o.value) })) },
      ],
    });
    if (v && c) run.mutate(() => contractApi.submitChange(c.id, { delta: v.delta, reason: v.reason, evidenceDocumentId: Number(v.evidenceDocumentId) }));
  };
  const submitPayment = async () => {
    const v = await prompt({
      title: '付款申请', fields: [
        { name: 'nodeName', label: '付款节点', required: true, placeholder: '如 预付款 / 进度款 / 尾款' },
        { name: 'amount', label: '金额(元)', required: true },
        { name: 'plannedDate', label: '计划日期(YYYY-MM-DD,可空)' },
        { name: 'evidenceDocumentId', label: '依据文档(可空)', options: docOptions(docs).map((o) => ({ ...o, value: String(o.value) })) },
      ],
    });
    if (v && c) run.mutate(() => contractApi.submitPayment(c.id, compact({ nodeName: v.nodeName, amount: v.amount, plannedDate: v.plannedDate, evidenceDocumentId: v.evidenceDocumentId ? Number(v.evidenceDocumentId) : undefined }) as never));
  };
  const pay = async (pid: number) => {
    const v = await prompt({
      title: '登记支付', description: '支付须关联发票类文档。', fields: [
        { name: 'paidDate', label: '支付日期(YYYY-MM-DD)', required: true, initial: dayjs().format('YYYY-MM-DD') },
        { name: 'voucherNo', label: '凭证号' },
        { name: 'invoiceDocumentId', label: '发票', required: true, options: docOptions(docs, ['invoice']).map((o) => ({ ...o, value: String(o.value) })) },
      ],
    });
    if (v && c) run.mutate(() => contractApi.pay(c.id, pid, compact({ paidDate: v.paidDate, voucherNo: v.voucherNo, invoiceDocumentId: Number(v.invoiceDocumentId) }) as never));
  };

  const flowCols = <T extends { status: string; submittedBy: string | null; submittedAt: string; reviewedBy: string | null; comment: string | null; exceptionReason: string | null; selfReview: boolean }>() => [
    { title: '状态', dataIndex: 'status', width: 90, render: (v: string) => statusTag(FLOW_STATUS, v) },
    { title: '提交', key: 'sub', width: 150, render: (_: unknown, r: T) => <span>{r.submittedBy ?? '—'} · {shortTime(r.submittedAt)}</span> },
    {
      title: '复核', key: 'rev', render: (_: unknown, r: T) => (r.reviewedBy ? (
        <span>{r.reviewedBy}{r.comment ? `:${r.comment}` : ''}{r.selfReview && <Tag color="orange" style={{ marginLeft: 4 }}>同人例外:{r.exceptionReason}</Tag>}</span>
      ) : '—'),
    },
  ];

  return (
    <Drawer open={id != null} onClose={onClose} width={1080} destroyOnClose title={c ? `${c.contractNo} · ${c.name}` : '合同'}
      extra={c && (
        <Space wrap>
          {writable && <Button onClick={() => setEditing(true)}>编辑</Button>}
          {writable && c.nextStage && (
            <Button type="primary" disabled={c.blockers.length > 0} onClick={() => modal.confirm({
              title: `推进到「${CONTRACT_STAGE_LABELS[c.nextStage!]}」?`, content: c.nextStage === 'archived' ? '归档后合同关闭,不能再写入。' : undefined,
              onOk: () => run.mutateAsync(() => contractApi.advance(c.id, c.version, c.nextStage!)),
            })}>推进到{CONTRACT_STAGE_LABELS[c.nextStage]}</Button>
          )}
          {writable && <Button danger onClick={() => void command('terminate')}>终止</Button>}
          {writable && c.paidAmount === '0.00' && <Button danger onClick={() => void command('void')}>作废</Button>}
          {reviewer && (c.status === 'closed' || c.status === 'terminated') && <Button onClick={() => void command('reopen')}>重开</Button>}
        </Space>
      )}>
      {holder}
      {q.error ? <QueryErrorResult title="合同加载失败" error={q.error} refetch={q.refetch} /> : c && (
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          <Descriptions size="small" column={3} bordered>
            <Descriptions.Item label="组织">{c.orgName}</Descriptions.Item>
            <Descriptions.Item label="项目">{c.projectName ? `${c.projectName}(${c.projectCode})` : '—'}</Descriptions.Item>
            <Descriptions.Item label="供应商">{c.supplierName ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="阶段">{CONTRACT_STAGE_LABELS[c.stage]}</Descriptions.Item>
            <Descriptions.Item label="状态">{statusTag(CONTRACT_STATUS, c.status)}{c.statusReason && <Typography.Text type="secondary">{c.statusReason}</Typography.Text>}</Descriptions.Item>
            <Descriptions.Item label="来源 / 版本">{c.source === 'import' ? '导入' : '手工'} · v{c.version}</Descriptions.Item>
            <Descriptions.Item label="原始金额"><Money value={c.originalAmount} /></Descriptions.Item>
            <Descriptions.Item label="已批准变更"><Money value={c.approvedChange} /></Descriptions.Item>
            <Descriptions.Item label="当前金额"><Money value={c.currentAmount} /></Descriptions.Item>
            <Descriptions.Item label="已付"><Money value={c.paidAmount} /></Descriptions.Item>
            <Descriptions.Item label="付款比例">{c.paymentRate == null ? '—' : <Ratio value={c.paymentRate} />}</Descriptions.Item>
            <Descriptions.Item label="付款上限">{c.paymentCapRatio == null ? '100%' : <Ratio value={c.paymentCapRatio} />}</Descriptions.Item>
            <Descriptions.Item label="签订日期">{c.signDate ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="生效日期">{c.effectiveDate ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="合同类型">{c.contractType || '—'}</Descriptions.Item>
          </Descriptions>
          {c.status === 'active' && c.nextStage && (c.blockers.length ? (
            <Alert type="warning" showIcon message={`推进到「${CONTRACT_STAGE_LABELS[c.nextStage]}」前还需:`}
              description={<ul style={{ margin: 0, paddingLeft: 18 }}>{c.blockers.map((b) => <li key={b.code}>{b.message}</li>)}</ul>} />
          ) : <Alert type="success" showIcon message={`已满足推进到「${CONTRACT_STAGE_LABELS[c.nextStage]}」的条件`} />)}
          <Tabs items={[
            {
              key: 'docs', label: `文档 ${c.documents.length}`, children: (
                <>
                  {writable && (
                    <Space style={{ marginBottom: 8 }}>
                      <Select value={docType} onChange={setDocType} style={{ width: 140 }} options={Object.entries(CONTRACT_DOC_TYPE_LABELS).map(([value, label]) => ({ value, label }))} />
                      <Upload showUploadList={false} beforeUpload={(f) => { run.mutate(() => contractApi.uploadDocument(c.id, f, docType)); return false; }}>
                        <Button icon={<i className="ri-upload-2-line" aria-hidden />}>上传文档</Button>
                      </Upload>
                    </Space>
                  )}
                  <Table rowKey="id" size="small" pagination={false} dataSource={c.documents}
                    columns={[
                      { title: '类型', dataIndex: 'docType', width: 100, render: (v: string) => CONTRACT_DOC_TYPE_LABELS[v] },
                      { title: '名称', dataIndex: 'name', ellipsis: true },
                      { title: '上传', key: 'u', width: 170, render: (_, d) => `${d.uploadedBy ?? '—'} · ${shortTime(d.uploadedAt)}` },
                      {
                        title: '操作', key: 'op', width: 160, render: (_, d) => (
                          <Space size={0}>
                            <Button type="link" size="small" onClick={() => void download(`/contracts/${c.id}/documents/${d.id}/content`, d.name)}>下载</Button>
                            {writable && d.docType === 'contract_text' && !c.reviews.some((r) => r.status === 'submitted') && (
                              <Button type="link" size="small" onClick={async () => {
                                const v = await prompt({ title: '提交合同审核', fields: [{ name: 'note', label: '说明', multiline: true }] });
                                if (v) run.mutate(() => contractApi.submitReview(c.id, d.id, v.note || undefined));
                              }}>提交审核</Button>
                            )}
                          </Space>
                        ),
                      },
                    ]} />
                </>
              ),
            },
            {
              key: 'reviews', label: `审核 ${c.reviews.length}`, children: (
                <Table rowKey="id" size="small" pagination={false} dataSource={c.reviews}
                  columns={[
                    { title: '文档', dataIndex: 'documentName', ellipsis: true },
                    { title: '说明', dataIndex: 'note', ellipsis: true },
                    ...flowCols<ContractDetailDto['reviews'][number]>(),
                    { title: '', key: 'op', width: 80, render: (_, r) => (reviewer && r.status === 'submitted' ? <Button size="small" type="primary" onClick={() => void decide('review', r.id)}>复核</Button> : null) },
                  ]} />
              ),
            },
            {
              key: 'changes', label: `变更 ${c.changes.length}`, children: (
                <>
                  {writable && <Button style={{ marginBottom: 8 }} onClick={() => void submitChange()}>提交变更</Button>}
                  <Table rowKey="id" size="small" pagination={false} dataSource={c.changes}
                    columns={[
                      { title: '金额', dataIndex: 'delta', width: 130, align: 'right', render: (v: string) => <Money value={v} tone /> },
                      { title: '原因', dataIndex: 'reason', ellipsis: true },
                      ...flowCols<ContractDetailDto['changes'][number]>(),
                      { title: '', key: 'op', width: 80, render: (_, r) => (reviewer && r.status === 'submitted' ? <Button size="small" type="primary" onClick={() => void decide('change', r.id)}>复核</Button> : null) },
                    ]} />
                </>
              ),
            },
            {
              key: 'payments', label: `付款 ${c.payments.length}`, children: (
                <>
                  {writable && <Button style={{ marginBottom: 8 }} onClick={() => void submitPayment()}>付款申请</Button>}
                  <Table rowKey="id" size="small" pagination={false} dataSource={c.payments}
                    columns={[
                      { title: '节点', dataIndex: 'nodeName', render: (v: string, r) => (r.kind === 'import_baseline' ? <span>{v} <Tag>导入基线</Tag></span> : v) },
                      { title: '金额', dataIndex: 'amount', width: 130, align: 'right', render: (v: string) => <Money value={v} /> },
                      ...flowCols<ContractDetailDto['payments'][number]>(),
                      { title: '支付', key: 'paid', width: 170, render: (_, r) => (r.paidDate ? `${r.paidDate}${r.voucherNo ? ` · ${r.voucherNo}` : ''}` : '—') },
                      {
                        title: '', key: 'op', width: 90, render: (_, r) => (
                          reviewer && r.status === 'submitted' ? <Button size="small" type="primary" onClick={() => void decide('payment', r.id)}>复核</Button>
                            : writable && r.status === 'approved' ? <Button size="small" onClick={() => void pay(r.id)}>登记支付</Button> : null
                        ),
                      },
                    ]} />
                </>
              ),
            },
            {
              key: 'events', label: '事件', children: c.events.length === 0 ? <Empty /> : (
                <Timeline items={[...c.events].reverse().map((e) => ({
                  key: e.id,
                  children: (
                    <div>
                      <Typography.Text strong>{e.eventType}</Typography.Text>
                      {e.fromStage && e.toStage && e.fromStage !== e.toStage && <Typography.Text> {CONTRACT_STAGE_LABELS[e.fromStage]} → {CONTRACT_STAGE_LABELS[e.toStage]}</Typography.Text>}
                      <Typography.Text type="secondary"> · {e.actor ?? '系统'} · {shortTime(e.createdAt)}</Typography.Text>
                    </div>
                  ),
                }))} />
              ),
            },
          ]} />
        </Space>
      )}
      {c && <ContractFormModal open={editing} contract={c} onClose={() => setEditing(false)} onSaved={(d) => refresh(d)} />}
    </Drawer>
  );
}

export default function Contracts() {
  const [params, setParams] = useSearchParams();
  const todo = (params.get('todo') ?? undefined) as ContractTodo | undefined;
  const [status, setStatus] = useState<string | undefined>();
  const [stage, setStage] = useState<string | undefined>();
  const [orgId, setOrgId] = useState<number | undefined>(defaultOrgId());
  const [keyword, setKeyword] = useState<string | undefined>();
  const [creating, setCreating] = useState(false);
  const openId = params.get('id') ? Number(params.get('id')) : null;
  const setOpenId = (id: number | null) => setParams((p) => { const n = new URLSearchParams(p); if (id == null) n.delete('id'); else n.set('id', String(id)); return n; }, { replace: true });
  const todoValid = todo && todo in TODO_LABEL ? todo : undefined;
  const list = useQuery({
    queryKey: ['contracts', status, stage, orgId, keyword, todoValid],
    queryFn: () => contractApi.list(compact({ status, stage, orgId, keyword, todo: todoValid }) as never),
  });
  const summary = useQuery({ queryKey: ['contract-summary', orgId], queryFn: () => contractApi.summary({ orgId }) });
  const s = summary.data;
  return (
    <div>
      {s && (
        <Card size="small" style={{ marginBottom: 12 }}>
          <Row gutter={[16, 8]}>
            <Col xs={12} md={4}><Typography.Text type="secondary" style={{ fontSize: 12 }}>合同数(不含作废)</Typography.Text><div className="kpi-value" style={{ fontSize: 20 }}>{s.count - s.byStatus.voided}</div></Col>
            <Col xs={12} md={5}><Typography.Text type="secondary" style={{ fontSize: 12 }}>当前金额</Typography.Text><div className="kpi-value" style={{ fontSize: 20 }}><Money value={s.currentAmount} /></div></Col>
            <Col xs={12} md={5}><Typography.Text type="secondary" style={{ fontSize: 12 }}>已付</Typography.Text><div className="kpi-value" style={{ fontSize: 20 }}><Money value={s.paidAmount} /></div></Col>
            <Col xs={12} md={4}><Typography.Text type="secondary" style={{ fontSize: 12 }}>付款比例</Typography.Text><div className="kpi-value" style={{ fontSize: 20 }}>{s.paymentRate == null ? '—' : <Ratio value={s.paymentRate} />}</div></Col>
            <Col xs={24} md={6}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>待办</Typography.Text>
              <div><Space size={4} wrap>
                <Tag>审核 {s.pending.reviews}</Tag><Tag>变更 {s.pending.changes}</Tag><Tag>付款 {s.pending.payments}</Tag><Tag>待支付 {s.pending.unpaidApproved}</Tag>
              </Space></div>
            </Col>
          </Row>
        </Card>
      )}
      <Space wrap style={{ marginBottom: 12 }}>
        <Select allowClear placeholder="状态" value={status} onChange={setStatus} style={{ width: 110 }} options={Object.entries(CONTRACT_STATUS).map(([value, m]) => ({ value, label: m.text }))} />
        <Select allowClear placeholder="阶段" value={stage} onChange={setStage} style={{ width: 120 }} options={CONTRACT_STAGE_ORDER.map((value) => ({ value, label: CONTRACT_STAGE_LABELS[value] }))} />
        <OrgSelect value={orgId} onChange={setOrgId} />
        <Input.Search allowClear placeholder="编号或名称" onSearch={(v) => setKeyword(v.trim() || undefined)} style={{ width: 200 }} />
        {can('contract:write') && <Button type="primary" onClick={() => setCreating(true)}>新建合同</Button>}
      </Space>
      {todoValid && (
        <Alert type="info" showIcon style={{ marginBottom: 12 }} message={`只显示:${TODO_LABEL[todoValid]}`}
          action={<Button size="small" onClick={() => setParams((p) => { const n = new URLSearchParams(p); n.delete('todo'); return n; }, { replace: true })}>显示全部</Button>} />
      )}
      {list.error ? <QueryErrorResult title="合同加载失败" error={list.error} refetch={list.refetch} /> : (
        <Table<ContractDto> rowKey="id" size="small" loading={list.isLoading} dataSource={list.data ?? []} pagination={{ pageSize: 20, showSizeChanger: false }} scroll={{ x: 1300 }}
          onRow={(r) => ({ onClick: () => setOpenId(r.id), style: { cursor: 'pointer' } })}
          columns={[
            { title: '合同编号', dataIndex: 'contractNo', width: 140, fixed: 'left' },
            { title: '名称', dataIndex: 'name', ellipsis: true },
            { title: '组织', dataIndex: 'orgName', width: 120 },
            { title: '项目', dataIndex: 'projectName', width: 140, ellipsis: true, render: (v: string | null) => v ?? '—' },
            { title: '供应商', dataIndex: 'supplierName', width: 140, ellipsis: true, render: (v: string | null) => v ?? '—' },
            { title: '阶段', dataIndex: 'stage', width: 90, render: (v: string) => CONTRACT_STAGE_LABELS[v] },
            { title: '状态', dataIndex: 'status', width: 80, render: (v: string) => statusTag(CONTRACT_STATUS, v) },
            { title: '当前金额', dataIndex: 'currentAmount', width: 130, align: 'right', render: (v: string) => <Money value={v} /> },
            { title: '已付', dataIndex: 'paidAmount', width: 130, align: 'right', render: (v: string) => <Money value={v} /> },
            { title: '付款比例', dataIndex: 'paymentRate', width: 90, align: 'right', render: (v: string | null) => (v == null ? '—' : <Ratio value={v} />) },
            {
              title: '待办', key: 'todo', width: 150, render: (_, r) => (
                <Space size={2} wrap>
                  {r.pendingReviews > 0 && <Tag color="warning">审核 {r.pendingReviews}</Tag>}
                  {r.pendingChanges > 0 && <Tag color="warning">变更 {r.pendingChanges}</Tag>}
                  {r.openPayments > 0 && <Tag color="warning">付款 {r.openPayments}</Tag>}
                </Space>
              ),
            },
          ]} />
      )}
      <ContractFormModal open={creating} onClose={() => setCreating(false)} onSaved={(c) => setOpenId(c.id)} />
      <ContractDrawer id={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}
