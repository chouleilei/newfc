import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  Alert, App as AntdApp, Button, Card, Col, DatePicker, Descriptions, Form, Input, InputNumber, Modal, Row, Select, Space, Table, Tag, Typography,
} from 'antd';
import dayjs from 'dayjs';
import { can, errorText } from '../../api/client';
import {
  contractApi, type ContractDetailDto, type ContractDisputeCreateRequest, type ContractDisputeDto,
  type ContractDisputeUpdateRequest, type ContractDocType, type ContractGuaranteeCreateRequest,
  type ContractGuaranteeDto, type ContractGuaranteeUpdateRequest, type ContractWarrantyUpsertRequest,
  type ContractEvaluationRequest, type GuaranteeStatus,
} from '../../api/projectContract';
import { compact, Money, statusTag } from '../financeData/shared';
import { CONTRACT_DOC_TYPE_LABELS } from './shared';
import {
  DISPUTE_STAGE_LABELS, EVALUATION_RECOMMENDATION_LABELS, GUARANTEE_DIRECTION_LABELS, GUARANTEE_STATUS_LABELS, GUARANTEE_TYPE_LABELS,
  parseMoneyToCentsPreview, WARRANTY_CONCLUSION_LABELS,
} from './contractOptions';

type DocPick = { id: number; name: string; docType: ContractDocType };
const docOptions = (docs: DocPick[], types?: ContractDocType[]) =>
  docs.filter((d) => !types || types.includes(d.docType)).map((d) => ({ value: d.id, label: CONTRACT_DOC_TYPE_LABELS[d.docType] + ' · ' + d.name }));

const nonNegMoneyRule = {
  validator: (_: unknown, v?: string) => {
    if (!v || !String(v).trim()) return Promise.resolve();
    const c = parseMoneyToCentsPreview(v);
    return c === null || c < 0n ? Promise.reject(new Error('请输入非负金额(最多 2 位小数)')) : Promise.resolve();
  },
};
const ratioRule = {
  validator: (_: unknown, v?: string) => {
    if (!v || !String(v).trim()) return Promise.resolve();
    return /^(0(.d{1,6})?|1(.0{1,6})?)$/.test(String(v).trim()) ? Promise.resolve() : Promise.reject(new Error('请输入 0～1 小数(最多 6 位)'));
  },
};
const datePickerProps = {
  getValueProps: (v?: string) => ({ value: v ? dayjs(v) : null }),
  normalize: (d: dayjs.Dayjs | null) => (d ? d.format('YYYY-MM-DD') : null),
};

export function ContractSafeguardTab({ contract, onChanged }: { contract: ContractDetailDto; onChanged: (d?: ContractDetailDto) => void }) {
  const { message } = AntdApp.useApp();
  const [gCreateOpen, setGCreateOpen] = useState(false);
  const [gEditing, setGEditing] = useState<ContractGuaranteeDto | null>(null);
  const [wEditOpen, setWEditOpen] = useState(false);
  const [wVisaOpen, setWVisaOpen] = useState(false);
  const [dCreateOpen, setDCreateOpen] = useState(false);
  const [dEditing, setDEditing] = useState<ContractDisputeDto | null>(null);
  const [evalOpen, setEvalOpen] = useState(false);

  const [gCreateForm] = Form.useForm();
  const [gUpdateForm] = Form.useForm();
  const [wEditForm] = Form.useForm();
  const [wVisaForm] = Form.useForm();
  const [dForm] = Form.useForm();
  const [evalForm] = Form.useForm();

  const writableActive = can('contract:write') && contract.status === 'active';
  const writableNotVoided = can('contract:write') && contract.status !== 'voided';
  const reviewerActive = can('contract:review') && contract.status === 'active';
  const reviewerClosed = can('contract:review') && contract.status === 'closed';
  const docs: DocPick[] = contract.documents ?? [];
  const guarantees = contract.guarantees ?? [];
  const warranty = contract.warranty ?? null;
  const disputes = contract.disputes ?? [];
  const evaluation = contract.evaluation ?? null;

  const run = useMutation({
    mutationFn: (fn: () => Promise<ContractDetailDto>) => fn(),
    onSuccess: (d) => { message.success('已完成'); onChanged(d); },
    onError: (e) => message.error(errorText(e)),
  });

  const today = dayjs().format('YYYY-MM-DD');
  const soonDate = dayjs().add(30, 'day').format('YYYY-MM-DD');
  const expiringSoon = guarantees.filter((g) => g.status === 'active' && g.expiryDate && g.expiryDate <= soonDate);
  const claimUnreported = guarantees.filter((g) => g.status === 'claimed' && !g.claimReportedAt);

  const openEditGuarantee = (g: ContractGuaranteeDto) => {
    setGEditing(g);
    gUpdateForm.setFieldsValue({
      status: g.status,
      effectiveDate: g.effectiveDate,
      expiryDate: g.expiryDate,
      returnedDate: g.returnedDate,
      claimOccurredAt: g.claimOccurredAt,
      claimReportedAt: g.claimReportedAt,
      documentId: g.documentId,
      note: g.note,
    });
  };

  const openWarrantyMaint = () => {
    wEditForm.setFieldsValue({
      startDate: warranty?.startDate ?? null,
      endDate: warranty?.endDate ?? null,
      retentionAmount: warranty?.retentionAmount ?? '0.00',
      defectRecords: warranty?.defectRecords ?? [],
    });
    setWEditOpen(true);
  };

  const openWarrantyVisa = () => {
    wVisaForm.setFieldsValue({
      inspectionDate: warranty?.inspectionDate ?? today,
      inspectionConclusion: warranty?.inspectionConclusion ?? 'passed',
      visaDocumentId: warranty?.visaDocumentId ?? undefined,
      releasedPaymentId: warranty?.releasedPaymentId ?? undefined,
    });
    setWVisaOpen(true);
  };

  const openDisputeCreate = () => {
    dForm.resetFields();
    dForm.setFieldsValue({ occurredDate: today, stage: 'negotiation', disputeAmount: '0.00' });
    setDEditing(null);
    setDCreateOpen(true);
  };

  const openDisputeEdit = (d: ContractDisputeDto) => {
    setDEditing(d);
    dForm.setFieldsValue({ ...d });
    setDCreateOpen(true);
  };

  const openEvaluation = () => {
    evalForm.setFieldsValue({
      qualityScore: evaluation?.qualityScore ?? 5,
      scheduleScore: evaluation?.scheduleScore ?? 5,
      serviceScore: evaluation?.serviceScore ?? 5,
      recommendation: evaluation?.recommendation ?? 'preferred',
      comment: evaluation?.comment ?? '',
    });
    setEvalOpen(true);
  };

  const gEditStatus = Form.useWatch('status', gUpdateForm) as GuaranteeStatus | undefined;

  return (
    <Space direction="vertical" style={{ width: '100%' }} size={12}>
      {/* 1. 保函 / 保证金 / 工程保险 */}
      <Card
        size="small"
        title={'保函 / 保证金 / 工程保险台账 · ' + guarantees.length}
        extra={writableActive && <Button size="small" type="primary" onClick={() => setGCreateOpen(true)}>登记保函 / 保险</Button>}
      >
        {expiringSoon.length > 0 && contract.status !== 'closed' && (
          <Alert style={{ marginBottom: 8 }} type="warning" showIcon message={'有 ' + expiringSoon.length + ' 笔保函/保险将于 30 天内到期或已到期，请及时续期或办理退还清理。'} />
        )}
        {claimUnreported.length > 0 && (
          <Alert style={{ marginBottom: 8 }} type="error" showIcon message={'有 ' + claimUnreported.length + ' 笔已发生索赔/冻结的保函尚未登记书面报告日期（资金办法 9.3 要求 2 日内报告）。'} />
        )}
        <Table
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={guarantees}
          scroll={{ x: 980 }}
          columns={[
            { title: '类型', dataIndex: 'guaranteeType', width: 130, render: (v) => GUARANTEE_TYPE_LABELS[v as keyof typeof GUARANTEE_TYPE_LABELS] },
            { title: '方向', dataIndex: 'direction', width: 130, render: (v) => GUARANTEE_DIRECTION_LABELS[v as keyof typeof GUARANTEE_DIRECTION_LABELS] },
            { title: '开立机构 / 编号', key: 'no', width: 180, render: (_, r) => <span>{r.issuerName || '—'}{r.guaranteeNo ? ' · ' + r.guaranteeNo : ''}</span> },
            { title: '金额', dataIndex: 'amount', width: 110, align: 'right', render: (v: string) => <Money value={v} /> },
            { title: '押金', dataIndex: 'depositAmount', width: 100, align: 'right', render: (v: string) => <Money value={v} /> },
            { title: '有效期', key: 'dates', width: 180, render: (_, r) => (r.effectiveDate || r.expiryDate ? (r.effectiveDate ?? '—') + ' ~ ' + (r.expiryDate ?? '—') : '—') },
            { title: '状态', dataIndex: 'status', width: 110, render: (v: string) => statusTag(GUARANTEE_STATUS_LABELS, v) },
            {
              title: '索赔 / 退还', key: 'clear', width: 160,
              render: (_, r) => (
                <div style={{ fontSize: 12 }}>
                  {r.returnedDate && <div>退还：{r.returnedDate}</div>}
                  {r.claimOccurredAt && <div>索赔：{r.claimOccurredAt}{r.claimReportedAt ? '（报:' + r.claimReportedAt + '）' : '（未报）'}</div>}
                  {!r.returnedDate && !r.claimOccurredAt && '—'}
                </div>
              ),
            },
            {
              title: '操作', key: 'op', width: 90,
              render: (_, r) => (writableNotVoided ? <Button size="small" onClick={() => openEditGuarantee(r)}>更新</Button> : null),
            },
          ]}
        />
      </Card>

      {/* 2. 质保期与期满签证 */}
      <Card
        size="small"
        title="质保期与期满签证"
        extra={
          <Space size={8}>
            {writableActive && <Button size="small" onClick={openWarrantyMaint}>维护质保期与缺陷</Button>}
            {reviewerActive && <Button size="small" type="primary" onClick={openWarrantyVisa}>期满验收签证确认</Button>}
          </Space>
        }
      >
        {!contract.hasWarranty ? (
          <Typography.Text type="secondary">本合同未约定质保期（hasWarranty = 否）；如需启用，请在基本信息编辑中开启“约定质保期”。</Typography.Text>
        ) : (
          <>
            {(!warranty || warranty.inspectionConclusion !== 'passed') && (
              <Alert
                style={{ marginBottom: 8 }}
                type="info"
                showIcon
                message="质保期闭环门禁：须由具备 contract:review 权限人员完成“质保期满验收通过”并附《质保金支付签证表》，方可申请支付质保金尾款并推进至「履约完结」。"
              />
            )}
            <Descriptions size="small" column={{ xs: 1, sm: 2, lg: 3 }} bordered>
              <Descriptions.Item label="约定质保期">{contract.warrantyMonths != null ? contract.warrantyMonths + ' 个月' : '—'}</Descriptions.Item>
              <Descriptions.Item label="质保起止日期">{warranty?.startDate || warranty?.endDate ? (warranty.startDate ?? '—') + ' ~ ' + (warranty.endDate ?? '—') : '未登记'}</Descriptions.Item>
              <Descriptions.Item label="质保金金额"><Money value={warranty?.retentionAmount ?? '0.00'} /></Descriptions.Item>
              <Descriptions.Item label="期满验收结论">{warranty?.inspectionConclusion ? statusTag(WARRANTY_CONCLUSION_LABELS, warranty.inspectionConclusion) : '待验收'}</Descriptions.Item>
              <Descriptions.Item label="验收日期 / 确认人">{warranty?.inspectionDate ? warranty.inspectionDate + (warranty.reviewedBy ? ' · ' + warranty.reviewedBy : '') : '—'}</Descriptions.Item>
              <Descriptions.Item label="签证附件 / 尾款付款ID">{(warranty?.visaDocumentId ? '#' + warranty.visaDocumentId : '未关联') + ' / ' + (warranty?.releasedPaymentId ? '#' + warranty.releasedPaymentId : '未关联')}</Descriptions.Item>
            </Descriptions>
            {warranty && warranty.defectRecords.length > 0 && (
              <Table
                style={{ marginTop: 8 }}
                rowKey={(_, i) => String(i)}
                size="small"
                pagination={false}
                dataSource={warranty.defectRecords}
                columns={[
                  { title: '发现日期', dataIndex: 'date', width: 110 },
                  { title: '缺陷描述', dataIndex: 'description' },
                  { title: '整改状态', dataIndex: 'resolved', width: 110, render: (v: boolean) => <Tag color={v ? 'success' : 'warning'}>{v ? '已整改' : '整改中'}</Tag> },
                  { title: '整改日期', dataIndex: 'resolvedDate', width: 110, render: (v: string | null) => v ?? '—' },
                ]}
              />
            )}
          </>
        )}
      </Card>

      {/* 3. 合同纠纷与诉讼仲裁 17 列台账 */}
      <Card
        size="small"
        title={'合同纠纷与诉讼仲裁台账（17 列）· ' + disputes.length}
        extra={writableNotVoided && <Button size="small" type="primary" onClick={openDisputeCreate}>登记纠纷 / 诉讼</Button>}
      >
        <Table
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={disputes}
          scroll={{ x: 1100 }}
          columns={[
            { title: '发生日', dataIndex: 'occurredDate', width: 105 },
            { title: '阶段', dataIndex: 'stage', width: 100, render: (v: string) => statusTag(DISPUTE_STAGE_LABELS, v) },
            { title: '案号 / 受理机构', key: 'case', width: 200, render: (_, r) => <span>{r.caseNo || '—'}{r.institutionName ? ' · ' + r.institutionName : ''}</span> },
            { title: '诉讼类型 / 案由', key: 'type', width: 190, render: (_, r) => <span>{r.litigationType || '—'}{r.causeOfAction ? ' · ' + r.causeOfAction : ''}</span> },
            { title: '涉案金额', dataIndex: 'disputeAmount', width: 110, align: 'right', render: (v: string) => <Money value={v} /> },
            { title: '实际获赔/付', dataIndex: 'actualSettledAmount', width: 110, align: 'right', render: (v: string | null) => (v ? <Money value={v} /> : '—') },
            {
              title: '报告与双备案', key: 'filing', width: 210,
              render: (_, r) => (
                <div style={{ fontSize: 12 }}>
                  <div>归口报告：{r.reportedToDeptAt ?? '未报'} · 总经理批：{r.gmApprovedAt ?? '—'}</div>
                  <div>企管备案：{r.filedToMgmtAt ?? '未备'} · 纪审备案：{r.filedToDisciplineAt ?? '未备'}</div>
                </div>
              ),
            },
            {
              title: '操作', key: 'op', width: 85,
              render: (_, r) => (writableNotVoided ? <Button size="small" onClick={() => openDisputeEdit(r)}>更新</Button> : null),
            },
          ]}
        />
      </Card>

      {/* 登记保函/保证金/保险 Modal */}
      <Modal
        open={gCreateOpen}
        title="登记保函 / 保证金 / 工程保险"
        width={640}
        onCancel={() => setGCreateOpen(false)}
        destroyOnClose
        confirmLoading={run.isPending}
        onOk={() => gCreateForm.validateFields().then(async (v) => {
          await run.mutateAsync(() => contractApi.createGuarantee(contract.id, compact({
            ...v, amount: v.amount || '0.00', depositAmount: v.depositAmount || '0.00',
          }) as ContractGuaranteeCreateRequest));
          setGCreateOpen(false);
        })}
      >
        <Form form={gCreateForm} layout="vertical" preserve={false} initialValues={{ guaranteeType: 'performance_guarantee', direction: 'inbound', amount: '0.00', depositAmount: '0.00' }}>
          <Row gutter={12}>
            <Col span={12}><Form.Item name="guaranteeType" label="担保 / 保险类型"><Select options={Object.entries(GUARANTEE_TYPE_LABELS).map(([value, label]) => ({ value, label }))} /></Form.Item></Col>
            <Col span={12}><Form.Item name="direction" label="收受 / 开立方向"><Select options={Object.entries(GUARANTEE_DIRECTION_LABELS).map(([value, label]) => ({ value, label }))} /></Form.Item></Col>
            <Col span={12}><Form.Item name="issuerName" label="开立机构 / 保险公司"><Input maxLength={200} /></Form.Item></Col>
            <Col span={12}><Form.Item name="guaranteeNo" label="保函 / 保单编号"><Input maxLength={100} /></Form.Item></Col>
            <Col span={8}><Form.Item name="amount" label="保函 / 保险金额(元)" rules={[nonNegMoneyRule]}><Input /></Form.Item></Col>
            <Col span={8}><Form.Item name="depositAmount" label="押金金额(元)" rules={[nonNegMoneyRule]}><Input /></Form.Item></Col>
            <Col span={8}><Form.Item name="ratio" label="担保比例(0～1)" rules={[ratioRule]}><Input placeholder="如 0.10" /></Form.Item></Col>
            <Col span={12}><Form.Item name="effectiveDate" label="生效日期" {...datePickerProps}><DatePicker style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={12}><Form.Item name="expiryDate" label="到期日期" {...datePickerProps}><DatePicker style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={12}><Form.Item name="documentId" label="保函 / 保单附件"><Select allowClear options={docOptions(docs, ['guarantee', 'other'])} /></Form.Item></Col>
            <Col span={12}><Form.Item name="note" label="备注"><Input maxLength={500} /></Form.Item></Col>
          </Row>
        </Form>
      </Modal>

      {/* 更新保函状态 Modal */}
      <Modal
        open={gEditing != null}
        title="更新保函 / 押金退还 / 索赔报告"
        width={600}
        onCancel={() => setGEditing(null)}
        destroyOnClose
        confirmLoading={run.isPending}
        onOk={() => gUpdateForm.validateFields().then(async (v) => {
          if (!gEditing) return;
          await run.mutateAsync(() => contractApi.updateGuarantee(contract.id, gEditing.id, compact(v) as ContractGuaranteeUpdateRequest));
          setGEditing(null);
        })}
      >
        <Form form={gUpdateForm} layout="vertical" preserve={false}>
          <Row gutter={12}>
            <Col span={12}><Form.Item name="status" label="状态"><Select options={Object.entries(GUARANTEE_STATUS_LABELS).map(([value, m]) => ({ value, label: m.text }))} /></Form.Item></Col>
            <Col span={12}><Form.Item name="returnedDate" label="退还 / 清理日期" rules={gEditStatus === 'returned' ? [{ required: true, message: '退还时必填日期' }] : []} {...datePickerProps}><DatePicker style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={12}><Form.Item name="effectiveDate" label="生效日期" {...datePickerProps}><DatePicker style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={12}><Form.Item name="expiryDate" label="到期日期" {...datePickerProps}><DatePicker style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={12}><Form.Item name="claimOccurredAt" label="索赔 / 冻结发生日期" rules={gEditStatus === 'claimed' ? [{ required: true, message: '索赔时必填发生日期' }] : []} {...datePickerProps}><DatePicker style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={12}><Form.Item name="claimReportedAt" label="书面报告日期(2日内)" {...datePickerProps}><DatePicker style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={12}><Form.Item name="documentId" label="关联附件"><Select allowClear options={docOptions(docs, ['guarantee', 'other'])} /></Form.Item></Col>
            <Col span={12}><Form.Item name="note" label="备注"><Input maxLength={500} /></Form.Item></Col>
          </Row>
        </Form>
      </Modal>

      {/* 维护质保期与缺陷 Modal */}
      <Modal
        open={wEditOpen}
        title="维护质保期与缺陷记录"
        width={640}
        onCancel={() => setWEditOpen(false)}
        destroyOnClose
        confirmLoading={run.isPending}
        onOk={() => wEditForm.validateFields().then(async (v) => {
          await run.mutateAsync(() => contractApi.upsertWarranty(contract.id, compact(v) as ContractWarrantyUpsertRequest));
          setWEditOpen(false);
        })}
      >
        <Form form={wEditForm} layout="vertical" preserve={false}>
          <Row gutter={12}>
            <Col span={8}><Form.Item name="startDate" label="质保开始日期" {...datePickerProps}><DatePicker style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={8}><Form.Item name="endDate" label="质保结束日期" {...datePickerProps}><DatePicker style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={8}><Form.Item name="retentionAmount" label="质保金金额(元)" rules={[nonNegMoneyRule]}><Input /></Form.Item></Col>
          </Row>
          <Form.List name="defectRecords">
            {(fields, { add, remove }) => (
              <div>
                <Space style={{ marginBottom: 8 }}>
                  <Typography.Text strong>质量缺陷记录</Typography.Text>
                  <Button size="small" onClick={() => add({ date: today, description: '', resolved: false, resolvedDate: null })}>新增缺陷</Button>
                </Space>
                {fields.map((field) => (
                  <Row key={field.key} gutter={8} align="middle">
                    <Col span={6}><Form.Item name={[field.name, 'date']} label="发现日" rules={[{ required: true }]} {...datePickerProps}><DatePicker style={{ width: '100%' }} /></Form.Item></Col>
                    <Col span={10}><Form.Item name={[field.name, 'description']} label="缺陷描述" rules={[{ required: true }]}><Input maxLength={500} /></Form.Item></Col>
                    <Col span={5}><Form.Item name={[field.name, 'resolved']} label="已整改"><Select options={[{ value: false, label: '整改中' }, { value: true, label: '已整改' }]} /></Form.Item></Col>
                    <Col span={3}><Button size="small" danger onClick={() => remove(field.name)}>删</Button></Col>
                  </Row>
                ))}
              </div>
            )}
          </Form.List>
        </Form>
      </Modal>

      {/* 期满验收签证确认 Modal (contract:review) */}
      <Modal
        open={wVisaOpen}
        title="质保期满验收签证确认"
        width={520}
        onCancel={() => setWVisaOpen(false)}
        destroyOnClose
        confirmLoading={run.isPending}
        onOk={() => wVisaForm.validateFields().then(async (v) => {
          await run.mutateAsync(() => contractApi.upsertWarranty(contract.id, compact(v) as ContractWarrantyUpsertRequest));
          setWVisaOpen(false);
        })}
      >
        <Form form={wVisaForm} layout="vertical" preserve={false}>
          <Form.Item name="inspectionDate" label="期满验收日期" rules={[{ required: true }]} {...datePickerProps}><DatePicker style={{ width: '100%' }} /></Form.Item>
          <Form.Item name="inspectionConclusion" label="验收结论" rules={[{ required: true }]}>
            <Select options={Object.entries(WARRANTY_CONCLUSION_LABELS).map(([value, m]) => ({ value, label: m.text }))} />
          </Form.Item>
          <Form.Item name="visaDocumentId" label="《质保金支付签证表》附件">
            <Select allowClear options={docOptions(docs, ['settlement', 'acceptance', 'other'])} />
          </Form.Item>
          <Form.Item name="releasedPaymentId" label="关联质保尾款付款(可选)">
            <Select allowClear options={contract.payments.filter((p) => p.paymentType === 'warranty_release').map((p) => ({ value: p.id, label: p.nodeName + ' · ' + p.amount }))} />
          </Form.Item>
        </Form>
      </Modal>

      {/* 纠纷与诉讼仲裁 17 列台账 Modal */}
      <Modal
        open={dCreateOpen}
        title={dEditing ? '更新纠纷与双备案信息' : '登记纠纷 / 诉讼仲裁（17 列台账）'}
        width={800}
        onCancel={() => { setDCreateOpen(false); setDEditing(null); }}
        destroyOnClose
        confirmLoading={run.isPending}
        onOk={() => dForm.validateFields().then(async (v) => {
          if (dEditing) {
            await run.mutateAsync(() => contractApi.updateDispute(contract.id, dEditing.id, compact(v) as ContractDisputeUpdateRequest));
          } else {
            await run.mutateAsync(() => contractApi.createDispute(contract.id, compact({ ...v, disputeAmount: v.disputeAmount || '0.00' }) as ContractDisputeCreateRequest));
          }
          setDCreateOpen(false);
          setDEditing(null);
        })}
      >
        <Form form={dForm} layout="vertical" preserve={false}>
          <Row gutter={12}>
            <Col span={8}><Form.Item name="occurredDate" label="纠纷发生日" rules={[{ required: true }]} {...datePickerProps}><DatePicker style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={8}><Form.Item name="reportedToDeptAt" label="向归口部门书面报告日" {...datePickerProps}><DatePicker style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={8}><Form.Item name="stage" label="处理阶段" rules={[{ required: true }]}><Select options={Object.entries(DISPUTE_STAGE_LABELS).map(([value, m]) => ({ value, label: m.text }))} /></Form.Item></Col>
            <Col span={8}><Form.Item name="litigationType" label="诉讼 / 仲裁类型"><Input maxLength={100} placeholder="如 民事诉讼 / 商事仲裁" /></Form.Item></Col>
            <Col span={8}><Form.Item name="causeOfAction" label="案由"><Input maxLength={200} /></Form.Item></Col>
            <Col span={8}><Form.Item name="ourLitigationRole" label="我方诉讼地位"><Input maxLength={100} placeholder="如 原告 / 被告 / 申请人" /></Form.Item></Col>
            <Col span={12}><Form.Item name="counterpartyAndRole" label="相对方及诉讼地位"><Input maxLength={300} /></Form.Item></Col>
            <Col span={12}><Form.Item name="involvedOrgName" label="涉案单位"><Input maxLength={200} /></Form.Item></Col>
            <Col span={8}><Form.Item name="institutionName" label="受理法院 / 仲裁机构"><Input maxLength={200} /></Form.Item></Col>
            <Col span={8}><Form.Item name="caseNo" label="案号"><Input maxLength={100} /></Form.Item></Col>
            <Col span={8}><Form.Item name="acceptedDate" label="受理日期" {...datePickerProps}><DatePicker style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={8}><Form.Item name="gmApprovedAt" label="总经理起诉/应诉审批日" {...datePickerProps}><DatePicker style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={8}><Form.Item name="legalDocForm" label="法律文书形式"><Input maxLength={100} /></Form.Item></Col>
            <Col span={8}><Form.Item name="lawFirmAndLawyer" label="代理律所及律师"><Input maxLength={300} /></Form.Item></Col>
            <Col span={8}><Form.Item name="disputeAmount" label="涉案金额(元)" rules={[nonNegMoneyRule]}><Input /></Form.Item></Col>
            <Col span={8}><Form.Item name="actualSettledAmount" label="实际获赔 / 支付金额(元)" rules={[nonNegMoneyRule]}><Input /></Form.Item></Col>
            <Col span={8}><Form.Item name="closedDate" label="结案日期" {...datePickerProps}><DatePicker style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={8}><Form.Item name="changeId" label="关联合同变更(可选)"><Select allowClear options={contract.changes.map((ch) => ({ value: ch.id, label: (ch.supplementNo ?? '#' + ch.id) + ' · ' + ch.reason }))} /></Form.Item></Col>
            <Col span={8}><Form.Item name="filedToMgmtAt" label="企管部备案日期" {...datePickerProps}><DatePicker style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={8}><Form.Item name="filedToDisciplineAt" label="纪审部备案日期" {...datePickerProps}><DatePicker style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={12}><Form.Item name="caseSummary" label="案情摘要"><Input.TextArea rows={2} maxLength={2000} /></Form.Item></Col>
            <Col span={12}><Form.Item name="judgmentResult" label="裁判 / 调解结果"><Input.TextArea rows={2} maxLength={1000} /></Form.Item></Col>
          </Row>
        </Form>
      </Modal>

      {/* 4. 履约后评价（联动供应商库，采购办法 13.2） */}
      <Card
        size="small"
        title="履约后评价（供应商库联动）"
        extra={reviewerClosed && <Button size="small" type="primary" onClick={openEvaluation}>{evaluation ? '更新履约评价' : '登记履约评价'}</Button>}
      >
        {evaluation ? (
          <Descriptions size="small" bordered column={3}>
            <Descriptions.Item label="质量评分">{evaluation.qualityScore} / 5</Descriptions.Item>
            <Descriptions.Item label="进度/交期评分">{evaluation.scheduleScore} / 5</Descriptions.Item>
            <Descriptions.Item label="配合/服务评分">{evaluation.serviceScore} / 5</Descriptions.Item>
            <Descriptions.Item label="综合总分">{evaluation.totalScore} / 15</Descriptions.Item>
            <Descriptions.Item label="选用建议"><Tag color={EVALUATION_RECOMMENDATION_LABELS[evaluation.recommendation].color}>{EVALUATION_RECOMMENDATION_LABELS[evaluation.recommendation].text}</Tag></Descriptions.Item>
            <Descriptions.Item label="评价人">{evaluation.evaluatedBy ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="评价意见" span={3}>{evaluation.comment || '—'}</Descriptions.Item>
          </Descriptions>
        ) : (
          <Typography.Text type="secondary">
            {contract.status === 'closed' ? '合同已完结，可由复核人登记供应商履约后评价。' : '合同推进至「履约完结」后开放履约后评价登记。'}
          </Typography.Text>
        )}
      </Card>

      <Modal
        open={evalOpen}
        title="登记履约后评价（采购办法 13.2）"
        onCancel={() => setEvalOpen(false)}
        destroyOnClose
        confirmLoading={run.isPending}
        onOk={() => evalForm.validateFields().then(async (v) => {
          await run.mutateAsync(() => contractApi.upsertEvaluation(contract.id, v as ContractEvaluationRequest));
          setEvalOpen(false);
        })}
      >
        <Form form={evalForm} layout="vertical" preserve={false}>
          <Row gutter={12}>
            <Col span={8}><Form.Item name="qualityScore" label="质量评分(1-5)" rules={[{ required: true }]}><InputNumber min={1} max={5} style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={8}><Form.Item name="scheduleScore" label="交期/进度(1-5)" rules={[{ required: true }]}><InputNumber min={1} max={5} style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={8}><Form.Item name="serviceScore" label="服务配合(1-5)" rules={[{ required: true }]}><InputNumber min={1} max={5} style={{ width: '100%' }} /></Form.Item></Col>
          </Row>
          <Form.Item name="recommendation" label="供应商选用建议" rules={[{ required: true }]}>
            <Select options={Object.entries(EVALUATION_RECOMMENDATION_LABELS).map(([value, m]) => ({ value, label: m.text }))} />
          </Form.Item>
          <Form.Item name="comment" label="综合评价意见"><Input.TextArea rows={3} maxLength={1000} /></Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
