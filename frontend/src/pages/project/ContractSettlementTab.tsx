import { useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import { Alert, App as AntdApp, Button, Card, Checkbox, Col, DatePicker, Form, Input, Modal, Row, Select, Space, Statistic, Table, Tag, Typography } from 'antd';
import dayjs from 'dayjs';
import { can, errorText } from '../../api/client';
import { contractApi, type ContractDetailDto, type ContractDocType, type ContractPaymentApprovalTier, type ContractPaymentType, type SettlementKind } from '../../api/projectContract';
import { shortTime } from '../../utils/relativeTime';
import { compact, EXCEPTION_REASON_FIELD, Money, Ratio, statusTag, usePrompt } from '../financeData/shared';
import {
  PAYMENT_APPROVAL_TIER_LABELS, PAYMENT_TYPE_LABELS, SETTLEMENT_KIND_LABELS,
  formatCentsPreview, parseMoneyToCentsPreview, paymentApprovalTierPreview,
} from './contractOptions';
import { CONTRACT_DOC_TYPE_LABELS, FLOW_STATUS } from './shared';

type DocPick = { id: number; name: string; docType: ContractDocType; evidenceKind?: string | null };
const docOptions = (docs: DocPick[], types?: ContractDocType[]) =>
  docs.filter((d) => !types || types.includes(d.docType)).map((d) => ({ value: d.id, label: CONTRACT_DOC_TYPE_LABELS[d.docType] + ' · ' + d.name }));

const nonNegMoneyRule = { pattern: /^(\d{1,13}(\.\d{1,2})?)?$/, message: '须为非负金额(最多 2 位小数)' };
const moneyRule = { pattern: /^\d{1,13}(\.\d{1,2})?$/, message: '须为大于 0 的金额(最多 2 位小数)' };

export function ContractSettlementTab({ contract, onChanged }: { contract: ContractDetailDto; onChanged: (d: ContractDetailDto) => void }) {
  const { message } = AntdApp.useApp();
  const [prompt, holder] = usePrompt();
  const [settleOpen, setSettleOpen] = useState(false);
  const [payOpen, setPayOpen] = useState(false);
  const [receiptOpen, setReceiptOpen] = useState(false);
  const [settleForm] = Form.useForm();
  const [payForm] = Form.useForm();
  const [receiptForm] = Form.useForm();

  const writable = can('contract:write') && contract.status === 'active';
  const reviewer = can('contract:review') && contract.status === 'active';
  const docs: DocPick[] = contract.documents ?? [];
  const approvedSettlements = (contract.settlements ?? []).filter((s) => s.status === 'approved');
  const settlementOptions = approvedSettlements.map((s) => ({
    value: s.id,
    label: '第 ' + s.periodNo + ' 期（' + SETTLEMENT_KIND_LABELS[s.settlementKind] + ' · 净额 ' + s.netPayableAmount + '）',
  }));

  const run = useMutation({
    mutationFn: (fn: () => Promise<ContractDetailDto>) => fn(),
    onSuccess: (d) => { message.success('已完成'); onChanged(d); },
    onError: (e) => message.error(errorText(e)),
  });

  const decide = async (kind: 'settlement' | 'payment' | 'receipt', itemId: number) => {
    const v = await prompt({
      title: kind === 'settlement' ? '复核结算单' : kind === 'payment' ? '复核付款申请' : '复核收款申请',
      fields: [
        { name: 'decision', label: '结论', required: true, options: [{ value: 'approve', label: '批准' }, { value: 'reject', label: '驳回' }], initial: 'approve' },
        { name: 'comment', label: '意见', multiline: true },
        EXCEPTION_REASON_FIELD,
      ],
    });
    if (!v) return;
    const body = compact({ decision: v.decision as 'approve' | 'reject', comment: v.comment, exceptionReason: v.exceptionReason }) as { decision: 'approve' | 'reject' };
    run.mutate(() => kind === 'settlement' ? contractApi.decideSettlement(contract.id, itemId, body) : kind === 'payment' ? contractApi.decidePayment(contract.id, itemId, body) : contractApi.decideReceipt(contract.id, itemId, body));
  };

  const payAction = async (pid: number) => {
    const v = await prompt({
      title: '登记支付',
      description: '支付须关联发票类文档。',
      fields: [
        { name: 'paidDate', label: '支付日期(YYYY-MM-DD)', required: true, initial: dayjs().format('YYYY-MM-DD') },
        { name: 'voucherNo', label: '凭证号' },
        { name: 'invoiceDocumentId', label: '发票', required: true, options: docOptions(docs, ['invoice']).map((o) => ({ ...o, value: String(o.value) })) },
      ],
    });
    if (!v) return;
    run.mutate(() => contractApi.pay(contract.id, pid, compact({ paidDate: v.paidDate, voucherNo: v.voucherNo, invoiceDocumentId: Number(v.invoiceDocumentId) }) as never));
  };

  const receiveAction = async (rid: number) => {
    const v = await prompt({
      title: '登记收款到账',
      fields: [
        { name: 'receivedDate', label: '实际到账日期(YYYY-MM-DD)', required: true, initial: dayjs().format('YYYY-MM-DD') },
        { name: 'voucherNo', label: '银行回单 / 凭证号' },
        { name: 'invoiceDocumentId', label: '发票附件(可选)', options: docOptions(docs, ['invoice']).map((o) => ({ ...o, value: String(o.value) })) },
      ],
    });
    if (!v) return;
    run.mutate(() => contractApi.receiveReceipt(contract.id, rid, compact({ receivedDate: v.receivedDate, voucherNo: v.voucherNo, invoiceDocumentId: v.invoiceDocumentId ? Number(v.invoiceDocumentId) : undefined }) as never));
  };

  // 实时结算单三栏试算（bigint 零浮点）
  const sKind = (Form.useWatch('settlementKind', settleForm) ?? 'progress') as SettlementKind;
  const inCents = parseMoneyToCentsPreview(Form.useWatch('inContractAmount', settleForm)) ?? 0n;
  const chgCents = parseMoneyToCentsPreview(Form.useWatch('changeClaimAmount', settleForm)) ?? 0n;
  const othCents = parseMoneyToCentsPreview(Form.useWatch('otherAddAmount', settleForm)) ?? 0n;
  const dPreCents = parseMoneyToCentsPreview(Form.useWatch('deductPrepaymentAmount', settleForm)) ?? 0n;
  const dRetCents = parseMoneyToCentsPreview(Form.useWatch('deductRetentionAmount', settleForm)) ?? 0n;
  const dPenCents = parseMoneyToCentsPreview(Form.useWatch('deductPenaltyAmount', settleForm)) ?? 0n;
  const grossPreview = inCents + chgCents + othCents;
  const deductPreview = dPreCents + dRetCents + dPenCents;
  const netPreview = grossPreview - deductPreview;

  // 实时付款审批层级预览
  const payAmtCents = parseMoneyToCentsPreview(Form.useWatch('amount', payForm));
  const requiredTier = payAmtCents !== null && payAmtCents > 0n
    ? paymentApprovalTierPreview(contract.signingEntityLevel ?? 'company', payAmtCents)
    : null;

  const flowCols = <T extends { status: string; submittedBy: string | null; submittedAt: string; reviewedBy: string | null; comment: string | null; exceptionReason: string | null; selfReview: boolean }>() => [
    { title: '状态', dataIndex: 'status', width: 90, render: (v: string) => statusTag(FLOW_STATUS, v) },
    { title: '提交', key: 'sub', width: 140, render: (_: unknown, r: T) => <span>{r.submittedBy ?? '—'} · {shortTime(r.submittedAt)}</span> },
    {
      title: '复核', key: 'rev', render: (_: unknown, r: T) => (r.reviewedBy ? (
        <span>{r.reviewedBy}{r.comment ? ':' + r.comment : ''}{r.selfReview && <Tag color="orange" style={{ marginLeft: 4 }}>同人例外:{r.exceptionReason}</Tag>}</span>
      ) : '—'),
    },
  ];

  const isIncome = contract.direction === 'income';

  return (
    <Space direction="vertical" style={{ width: '100%' }} size={12}>
      {holder}
      <Row gutter={12}>
        <Col span={6}><Card size="small"><Statistic title="累计应结小计" valueRender={() => <Money value={contract.settledGrossAmount ?? '0.00'} />} /></Card></Col>
        <Col span={6}><Card size="small"><Statistic title="累计净结算额" valueRender={() => <Money value={contract.settledNetAmount ?? '0.00'} />} /></Card></Col>
        {!isIncome ? (
          <>
            <Col span={6}><Card size="small"><Statistic title="累计已付" valueRender={() => <Money value={contract.paidAmount} />} /></Card></Col>
            <Col span={6}><Card size="small"><Statistic title="付款比例" valueRender={() => (contract.paymentRate == null ? '—' : <Ratio value={contract.paymentRate} />)} /></Card></Col>
          </>
        ) : (
          <>
            <Col span={6}><Card size="small"><Statistic title="累计实收" valueRender={() => <Money value={contract.receivedAmount ?? '0.00'} />} /></Card></Col>
            <Col span={6}><Card size="small"><Statistic title="收款比例" valueRender={() => (contract.receiptRate == null ? '—' : <Ratio value={contract.receiptRate} />)} /></Card></Col>
          </>
        )}
      </Row>

      <Card size="small" title={'结算单（附件 8 三栏勾稽）· ' + (contract.settlements?.length ?? 0)} extra={writable && <Button size="small" type="primary" onClick={() => setSettleOpen(true)}>提交结算单</Button>}>
        <Table rowKey="id" size="small" pagination={false} dataSource={contract.settlements ?? []} scroll={{ x: 960 }} columns={[
          { title: '期次', dataIndex: 'periodNo', width: 64, render: (v: number) => '第' + v + '期' },
          { title: '类型', dataIndex: 'settlementKind', width: 96, render: (v: SettlementKind) => SETTLEMENT_KIND_LABELS[v] },
          { title: '日期', dataIndex: 'settlementDate', width: 105 },
          { title: '一、应结小计', dataIndex: 'grossPayableAmount', width: 120, align: 'right', render: (v: string) => <Money value={v} /> },
          { title: '二、应扣小计', dataIndex: 'totalDeductAmount', width: 120, align: 'right', render: (v: string) => <Money value={v} /> },
          { title: '三、净应付/收', dataIndex: 'netPayableAmount', width: 120, align: 'right', render: (v: string) => <Money value={v} /> },
          ...flowCols<NonNullable<ContractDetailDto['settlements']>[number]>(),
          { title: '', key: 'op', width: 80, render: (_, r) => (reviewer && r.status === 'submitted' ? <Button size="small" type="primary" onClick={() => void decide('settlement', r.id)}>复核</Button> : null) },
        ]} />
      </Card>

      {!isIncome ? (
        <Card size="small" title={'支出付款 · ' + contract.payments.length} extra={writable && <Button size="small" type="primary" onClick={() => setPayOpen(true)}>付款申请</Button>}>
          <Table rowKey="id" size="small" pagination={false} dataSource={contract.payments} scroll={{ x: 1000 }} columns={[
            { title: '节点', dataIndex: 'nodeName', render: (v: string, r) => (<span>{v} {r.kind === 'import_baseline' && <Tag>导入基线</Tag>}{r.isFarmerWageTransfer && <Tag color="cyan">农民工专户</Tag>}</span>) },
            { title: '类型', dataIndex: 'paymentType', width: 96, render: (v?: ContractPaymentType) => (v ? PAYMENT_TYPE_LABELS[v] : '进度款') },
            { title: '金额', dataIndex: 'amount', width: 120, align: 'right', render: (v: string, r) => <span><Money value={v} />{r.currency && r.currency !== '人民币' ? ' ' + r.currency : ''}</span> },
            { title: '审批层级 / 审批人', key: 'tier', width: 180, render: (_, r) => (r.approvalTier ? (PAYMENT_APPROVAL_TIER_LABELS[r.approvalTier] + (r.approverName ? ' · ' + r.approverName : '')) : '—') },
            ...flowCols<ContractDetailDto['payments'][number]>(),
            { title: '支付', key: 'paid', width: 150, render: (_, r) => (r.paidDate ? r.paidDate + (r.voucherNo ? ' · ' + r.voucherNo : '') : '—') },
            {
              title: '', key: 'op', width: 96, render: (_, r) => (
                reviewer && r.status === 'submitted' ? <Button size="small" type="primary" onClick={() => void decide('payment', r.id)}>复核</Button>
                  : writable && r.status === 'approved' ? <Button size="small" onClick={() => void payAction(r.id)}>登记支付</Button> : null
              ),
            },
          ]} />
        </Card>
      ) : (
        <Card size="small" title={'收入收款 · ' + (contract.receipts?.length ?? 0)} extra={writable && <Button size="small" type="primary" onClick={() => setReceiptOpen(true)}>收款登记</Button>}>
          <Table rowKey="id" size="small" pagination={false} dataSource={contract.receipts ?? []} scroll={{ x: 960 }} columns={[
            { title: '收款节点', dataIndex: 'nodeName' },
            { title: '金额', dataIndex: 'amount', width: 120, align: 'right', render: (v: string, r) => <span><Money value={v} />{r.currency !== '人民币' ? ' ' + r.currency : ''}</span> },
            { title: '计划日期', dataIndex: 'plannedDate', width: 105, render: (v: string | null) => v ?? '—' },
            ...flowCols<NonNullable<ContractDetailDto['receipts']>[number]>(),
            { title: '到账', key: 'rec', width: 150, render: (_, r) => (r.receivedDate ? r.receivedDate + (r.voucherNo ? ' · ' + r.voucherNo : '') : '—') },
            {
              title: '', key: 'op', width: 96, render: (_, r) => (
                reviewer && r.status === 'submitted' ? <Button size="small" type="primary" onClick={() => void decide('receipt', r.id)}>复核</Button>
                  : writable && r.status === 'approved' ? <Button size="small" onClick={() => void receiveAction(r.id)}>登记到账</Button> : null
              ),
            },
          ]} />
        </Card>
      )}

      <Modal open={settleOpen} title="提交结算单" width={680} onCancel={() => setSettleOpen(false)} destroyOnClose confirmLoading={run.isPending}
        onOk={() => settleForm.validateFields().then(async (v) => {
          await run.mutateAsync(() => contractApi.submitSettlement(contract.id, compact({
            ...v, inContractAmount: v.inContractAmount || '0', changeClaimAmount: v.changeClaimAmount || '0', otherAddAmount: v.otherAddAmount || '0',
            deductPrepaymentAmount: v.deductPrepaymentAmount || '0', deductRetentionAmount: v.deductRetentionAmount || '0', deductPenaltyAmount: v.deductPenaltyAmount || '0',
          }) as never));
          setSettleOpen(false);
        })}>
        <Form form={settleForm} layout="vertical" preserve={false} initialValues={{ settlementKind: 'progress', settlementDate: dayjs().format('YYYY-MM-DD'), inContractAmount: '0.00', changeClaimAmount: '0.00', otherAddAmount: '0.00', deductPrepaymentAmount: '0.00', deductRetentionAmount: '0.00', deductPenaltyAmount: '0.00' }}>
          {sKind === 'final' && contract.archiveStatus === 'collecting' && (
            <Alert style={{ marginBottom: 12 }} type="warning" showIcon message="当前合同档案尚未验收完整（需达到“完整性已核验”或“已移交”），且须已上传验收文件，方可提交最终/竣工结算。" />
          )}
          <Row gutter={12}>
            <Col span={12}><Form.Item name="settlementKind" label="结算类型"><Select options={Object.entries(SETTLEMENT_KIND_LABELS).map(([value, label]) => ({ value, label }))} /></Form.Item></Col>
            <Col span={12}><Form.Item name="settlementDate" label="结算日期" rules={[{ required: true }]} getValueProps={(v?: string) => ({ value: v ? dayjs(v) : null })} normalize={(d: dayjs.Dayjs | null) => (d ? d.format('YYYY-MM-DD') : null)}><DatePicker style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={8}><Form.Item name="inContractAmount" label="合同内应结(元)" rules={[nonNegMoneyRule]}><Input /></Form.Item></Col>
            <Col span={8}><Form.Item name="changeClaimAmount" label="已批变更索赔(元)" rules={[nonNegMoneyRule]}><Input /></Form.Item></Col>
            <Col span={8}><Form.Item name="otherAddAmount" label="其他应结(元)" rules={[nonNegMoneyRule]}><Input /></Form.Item></Col>
            <Col span={8}><Form.Item name="deductPrepaymentAmount" label="扣回预付款(元)" rules={[nonNegMoneyRule]}><Input /></Form.Item></Col>
            <Col span={8}><Form.Item name="deductRetentionAmount" label="预留质保金(元)" rules={[nonNegMoneyRule]}><Input /></Form.Item></Col>
            <Col span={8}><Form.Item name="deductPenaltyAmount" label="违约/其他扣款(元)" rules={[nonNegMoneyRule]}><Input /></Form.Item></Col>
            <Col span={24}>
              <Alert style={{ marginBottom: 12 }} type={netPreview < 0n ? 'error' : 'info'}
                message={'试算：一、应结小计 ' + formatCentsPreview(grossPreview) + ' 元 − 二、应扣小计 ' + formatCentsPreview(deductPreview) + ' 元 = 三、净应付/收 ' + formatCentsPreview(netPreview) + ' 元'} />
            </Col>
            <Col span={12}><Form.Item name="evidenceDocumentId" label="结算依据附件(可空)"><Select allowClear options={docOptions(docs, ['settlement', 'acceptance', 'other'])} /></Form.Item></Col>
            <Col span={12}><Form.Item name="note" label="备注"><Input maxLength={500} /></Form.Item></Col>
          </Row>
        </Form>
      </Modal>

      <Modal open={payOpen} title="付款申请" width={680} onCancel={() => setPayOpen(false)} destroyOnClose confirmLoading={run.isPending}
        onOk={() => payForm.validateFields().then(async (v) => {
          await run.mutateAsync(() => contractApi.submitPayment(contract.id, compact(v) as never));
          setPayOpen(false);
        })}>
        <Alert style={{ marginBottom: 12 }} type="info" showIcon message="大额资金按人民币500万元与上年净资产1%孰低核验；外币按参考汇率折算，缺净资产数据时按集体决策核验。" />
        <Form form={payForm} layout="vertical" preserve={false} initialValues={{ paymentType: 'progress', currency: contract.currency ?? '人民币', isFarmerWageTransfer: false }}>
          <Row gutter={12}>
            <Col span={12}><Form.Item name="paymentType" label="付款类型"><Select options={Object.entries(PAYMENT_TYPE_LABELS).map(([value, label]) => ({ value, label }))} /></Form.Item></Col>
            <Col span={12}><Form.Item name="settlementId" label="关联已批结算单(预付款可空)"><Select allowClear options={settlementOptions} /></Form.Item></Col>
            <Col span={12}><Form.Item name="nodeName" label="付款节点" rules={[{ required: true, whitespace: true }]}><Input placeholder="如 预付款 / 一期进度款 / 质保尾款" /></Form.Item></Col>
            <Col span={12}><Form.Item name="amount" label={'金额(' + (contract.currency ?? '人民币') + '元)'} rules={[{ required: true }, moneyRule]}><Input /></Form.Item></Col>
            {requiredTier && (
              <Col span={24}>
                <Alert style={{ marginBottom: 12 }} type="info"
                  message={'制度分级要求：不低于「' + PAYMENT_APPROVAL_TIER_LABELS[requiredTier] + '」'}
                  description={payAmtCents && payAmtCents >= 500_000_000n ? '单笔 >= 500 万元须经集体决策并附会议纪要/审批文件。' : payAmtCents && payAmtCents > 50_000_000n ? '单笔 > 50 万元须公司主要负责人签批并附签批单。' : undefined} />
              </Col>
            )}
            <Col span={8}><Form.Item name="approvalTier" rules={[{ required: true }]} label="最高审批层级"><Select allowClear options={Object.entries(PAYMENT_APPROVAL_TIER_LABELS).map(([value, label]) => ({ value, label }))} /></Form.Item></Col>
            <Col span={8}><Form.Item name="approverName" rules={[{ required: true }]} label="最高审批人姓名"><Input maxLength={100} /></Form.Item></Col>
            <Col span={8}><Form.Item name="approverTitle" rules={[{ required: true }]} label="最高审批人职务"><Input maxLength={100} /></Form.Item></Col>
            <Col span={12}><Form.Item name="feasibilityDocId" label="大额资金可行性论证"><Select allowClear options={docOptions(docs.filter(d => d.evidenceKind === 'funding_feasibility'))} /></Form.Item></Col>
            <Col span={12}><Form.Item name="approvalDocId" label="审批签批单 / 会议纪要附件"><Select allowClear options={docOptions(docs.filter(d => d.evidenceKind === 'payment_approval_form'))} /></Form.Item></Col>
            <Col span={12}><Form.Item name="plannedDate" label="计划日期" getValueProps={(v?: string) => ({ value: v ? dayjs(v) : null })} normalize={(d: dayjs.Dayjs | null) => (d ? d.format('YYYY-MM-DD') : null)}><DatePicker style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={12}><Form.Item name="evidenceDocumentId" label="其他依据文档(可空)"><Select allowClear options={docOptions(docs)} /></Form.Item></Col>
            <Col span={12}><Form.Item name="isFarmerWageTransfer" label="农民工工资专户" valuePropName="checked"><Checkbox>转入农民工工资专户</Checkbox></Form.Item></Col>
          </Row>
        </Form>
      </Modal>

      <Modal open={receiptOpen} title="收入合同收款登记" width={600} onCancel={() => setReceiptOpen(false)} destroyOnClose confirmLoading={run.isPending}
        onOk={() => receiptForm.validateFields().then(async (v) => {
          await run.mutateAsync(() => contractApi.submitReceipt(contract.id, compact(v) as never));
          setReceiptOpen(false);
        })}>
        <Form form={receiptForm} layout="vertical" preserve={false} initialValues={{ currency: contract.currency ?? '人民币' }}>
          <Row gutter={12}>
            <Col span={12}><Form.Item name="nodeName" label="收款节点" rules={[{ required: true, whitespace: true }]}><Input placeholder="如 5月电费收款" /></Form.Item></Col>
            <Col span={12}><Form.Item name="amount" label={'金额(' + (contract.currency ?? '人民币') + '元)'} rules={[{ required: true }, moneyRule]}><Input /></Form.Item></Col>
            <Col span={12}><Form.Item name="settlementId" label="关联已批结算单(可选)"><Select allowClear options={settlementOptions} /></Form.Item></Col>
            <Col span={12}><Form.Item name="plannedDate" label="应收计划日期" getValueProps={(v?: string) => ({ value: v ? dayjs(v) : null })} normalize={(d: dayjs.Dayjs | null) => (d ? d.format('YYYY-MM-DD') : null)}><DatePicker style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={24}><Form.Item name="invoiceDocumentId" label="开票附件(可选)"><Select allowClear options={docOptions(docs, ['invoice', 'other'])} /></Form.Item></Col>
          </Row>
        </Form>
      </Modal>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>提示：复核动作须由非提交人执行；管理员同人复核须填写例外原因。</Typography.Text>
    </Space>
  );
}
