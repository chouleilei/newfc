import { useEffect, useState } from 'react';
import { useMutation, useQuery } from '@tanstack/react-query';
import { Alert, App as AntdApp, Button, Card, Checkbox, Col, DatePicker, Form, Input, Modal, Row, Select, Space, Statistic, Table, Tag, Typography } from 'antd';
import dayjs from 'dayjs';
import { can, errorText } from '../../api/client';
import { contractApi, type ContractDetailDto, type ContractDocType, type ContractPaymentType, type SettlementKind } from '../../api/projectContract';
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
const signedMoneyRule = { pattern: /^(-?\d{1,13}(\.\d{1,2})?)?$/, message: '须为合法金额(最多 2 位小数，应扣款项支持负数冲回)' };
const moneyRule = { pattern: /^\d{1,13}(\.\d{1,2})?$/, message: '须为大于 0 的金额(最多 2 位小数)' };
const datePickerProps = {
  getValueProps: (v?: string) => ({ value: v ? dayjs(v) : null }),
  normalize: (d: dayjs.Dayjs | null) => (d ? d.format('YYYY-MM-DD') : null),
};

export function ContractSettlementTab({ contract, onChanged }: { contract: ContractDetailDto; onChanged: (d: ContractDetailDto) => void }) {
  const { message } = AntdApp.useApp();
  const [prompt, holder] = usePrompt();
  const [settleOpen, setSettleOpen] = useState(false);
  const [payOpen, setPayOpen] = useState(false);
  const [receiptOpen, setReceiptOpen] = useState(false);
  const [payingPaymentId, setPayingPaymentId] = useState<number | null>(null);
  const [receivingReceiptId, setReceivingReceiptId] = useState<number | null>(null);
  const [settleForm] = Form.useForm();
  const [payForm] = Form.useForm();
  const [receiptForm] = Form.useForm();
  const [payRegForm] = Form.useForm();
  const [recRegForm] = Form.useForm();

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

  const payAction = (pid: number) => {
    payRegForm.resetFields();
    payRegForm.setFieldsValue({ paidDate: dayjs().format('YYYY-MM-DD'), voucherNo: '', invoiceDocumentId: undefined });
    setPayingPaymentId(pid);
  };

  const receiveAction = (rid: number) => {
    recRegForm.resetFields();
    recRegForm.setFieldsValue({ receivedDate: dayjs().format('YYYY-MM-DD'), voucherNo: '', invoiceDocumentId: undefined });
    setReceivingReceiptId(rid);
  };

  // 实时结算单三栏试算（bigint 零浮点）
  const sKind = (Form.useWatch('settlementKind', settleForm) ?? 'progress') as SettlementKind;
  const sDateWatch = (Form.useWatch('settlementDate', settleForm) as string | undefined) ?? dayjs().format('YYYY-MM-DD');
  const inCents = parseMoneyToCentsPreview(Form.useWatch('inContractAmount', settleForm)) ?? 0n;
  const chgCents = parseMoneyToCentsPreview(Form.useWatch('changeClaimAmount', settleForm)) ?? 0n;
  const othCents = parseMoneyToCentsPreview(Form.useWatch('otherAddAmount', settleForm)) ?? 0n;
  const dPreCents = parseMoneyToCentsPreview(Form.useWatch('deductPrepaymentAmount', settleForm)) ?? 0n;
  const dRetCents = parseMoneyToCentsPreview(Form.useWatch('deductRetentionAmount', settleForm)) ?? 0n;
  const dPenCents = parseMoneyToCentsPreview(Form.useWatch('deductPenaltyAmount', settleForm)) ?? 0n;
  const grossPreview = inCents + chgCents + othCents;
  const deductPreview = dPreCents + dRetCents + dPenCents;
  const netPreview = grossPreview - deductPreview;

  // 附件 8 四列累计试算（上期合计 | 本期结算 | 本年合计 | 合同累计）
  const nonRejectedSettlements = (contract.settlements ?? []).filter((s) => s.status !== 'rejected');
  const priorNetCents = nonRejectedSettlements.reduce((acc, s) => acc + (parseMoneyToCentsPreview(s.netPayableAmount) ?? 0n), 0n);
  const settleYearPrefix = sDateWatch.slice(0, 4);
  const priorYtdNetCents = nonRejectedSettlements
    .filter((s) => s.settlementDate.startsWith(settleYearPrefix))
    .reduce((acc, s) => acc + (parseMoneyToCentsPreview(s.netPayableAmount) ?? 0n), 0n);
  const ytdNetPreview = priorYtdNetCents + netPreview;
  const cumNetPreview = priorNetCents + netPreview;

  // 实时付款审批层级预览（服务端净资产 1% 与 500 万元孰低，防抖 250ms）
  const payAmountRaw = Form.useWatch('amount', payForm) as string | undefined;
  const payPlannedDateRaw = Form.useWatch('plannedDate', payForm) as string | undefined;
  const isFarmerWageWatch = Boolean(Form.useWatch('isFarmerWageTransfer', payForm));
  const payAmtCents = parseMoneyToCentsPreview(payAmountRaw);
  const [debouncedPayParams, setDebouncedPayParams] = useState<{ amount?: string; plannedDate?: string }>({});

  useEffect(() => {
    if (!payOpen) return;
    const timer = window.setTimeout(() => {
      setDebouncedPayParams({
        amount: payAmountRaw?.trim() || undefined,
        plannedDate: payPlannedDateRaw || undefined,
      });
    }, 250);
    return () => window.clearTimeout(timer);
  }, [payOpen, payAmountRaw, payPlannedDateRaw]);

  const payTierPreviewQ = useQuery({
    queryKey: ['contract-payment-tier-preview', contract.id, debouncedPayParams.amount, debouncedPayParams.plannedDate],
    queryFn: () => contractApi.paymentTierPreview(contract.id, debouncedPayParams),
    enabled:
      payOpen &&
      Boolean(debouncedPayParams.amount) &&
      (parseMoneyToCentsPreview(debouncedPayParams.amount) ?? 0n) > 0n,
    staleTime: 10_000,
  });

  const fallbackRequiredTier = payAmtCents !== null && payAmtCents > 0n
    ? paymentApprovalTierPreview(contract.signingEntityLevel ?? 'company', payAmtCents)
    : null;
  const requiredTier = payTierPreviewQ.data?.requiredTier ?? fallbackRequiredTier;

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

      <Card size="small" title={'结算单（附件 8 四列累计勾稽）· ' + (contract.settlements?.length ?? 0)} extra={writable && <Button size="small" type="primary" onClick={() => setSettleOpen(true)}>提交结算单</Button>}>
        <Table rowKey="id" size="small" pagination={false} dataSource={contract.settlements ?? []} scroll={{ x: 1320 }} columns={[
          { title: '期次', dataIndex: 'periodNo', width: 64, render: (v: number) => '第' + v + '期' },
          { title: '类型', dataIndex: 'settlementKind', width: 96, render: (v: SettlementKind) => SETTLEMENT_KIND_LABELS[v] },
          { title: '日期', dataIndex: 'settlementDate', width: 105 },
          { title: '上期合计', dataIndex: 'priorNetPayableAmount', width: 120, align: 'right', render: (v?: string) => <Money value={v ?? '0.00'} /> },
          { title: '一、应结小计', dataIndex: 'grossPayableAmount', width: 120, align: 'right', render: (v: string) => <Money value={v} /> },
          { title: '二、应扣小计', dataIndex: 'totalDeductAmount', width: 120, align: 'right', render: (v: string) => <Money value={v} tone /> },
          { title: '本期结算(净额)', dataIndex: 'netPayableAmount', width: 130, align: 'right', render: (v: string) => <Money value={v} /> },
          { title: '本年合计', dataIndex: 'ytdNetPayableAmount', width: 120, align: 'right', render: (v?: string, r?) => <Money value={v ?? r?.netPayableAmount ?? '0.00'} /> },
          { title: '合同累计', dataIndex: 'cumulativeNetPayableAmount', width: 120, align: 'right', render: (v?: string, r?) => <Money value={v ?? r?.netPayableAmount ?? '0.00'} /> },
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
                  : writable && r.status === 'approved' ? <Button size="small" onClick={() => payAction(r.id)}>登记支付</Button> : null
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
                  : writable && r.status === 'approved' ? <Button size="small" onClick={() => receiveAction(r.id)}>登记到账</Button> : null
              ),
            },
          ]} />
        </Card>
      )}

      <Modal open={settleOpen} title="提交结算单（附件 8）" width={720} onCancel={() => setSettleOpen(false)} destroyOnClose confirmLoading={run.isPending}
        okButtonProps={{ disabled: netPreview < 0n }}
        onOk={() => settleForm.validateFields().then(async (v) => {
          if (netPreview < 0n) {
            message.error('净应付/收金额不可为负');
            return;
          }
          await run.mutateAsync(() => contractApi.submitSettlement(contract.id, compact({
            ...v, inContractAmount: v.inContractAmount || '0', changeClaimAmount: v.changeClaimAmount || '0', otherAddAmount: v.otherAddAmount || '0',
            deductPrepaymentAmount: v.deductPrepaymentAmount || '0', deductRetentionAmount: v.deductRetentionAmount || '0', deductPenaltyAmount: v.deductPenaltyAmount || '0',
          }) as never));
          setSettleOpen(false);
        })}>
        <Form form={settleForm} layout="vertical" preserve={false} initialValues={{ settlementKind: 'progress', settlementDate: dayjs().format('YYYY-MM-DD'), inContractAmount: '0.00', changeClaimAmount: '0.00', otherAddAmount: '0.00', deductPrepaymentAmount: '0.00', deductRetentionAmount: '0.00', deductPenaltyAmount: '0.00' }}>
          {contract.pricingMode === 'unit_price' && (
            <Alert
              style={{ marginBottom: 12 }}
              type="info"
              showIcon
              message="单价合同结算提醒：请确认已在文档区上传《工程量结算书》与《工程价款结算书》作为结算依据。"
            />
          )}
          {sKind === 'final' && contract.archiveStatus === 'collecting' && (
            <Alert style={{ marginBottom: 12 }} type="warning" showIcon message="当前合同档案尚未验收完整（需达到“完整性已核验”或“已移交”），且须已上传验收文件，方可提交最终/竣工结算。" />
          )}
          <Row gutter={12}>
            <Col span={12}><Form.Item name="settlementKind" label="结算类型"><Select options={Object.entries(SETTLEMENT_KIND_LABELS).map(([value, label]) => ({ value, label }))} /></Form.Item></Col>
            <Col span={12}><Form.Item name="settlementDate" label="结算日期" rules={[{ required: true }]} {...datePickerProps}><DatePicker style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={8}><Form.Item name="inContractAmount" label="合同内应结(元)" rules={[nonNegMoneyRule]}><Input /></Form.Item></Col>
            <Col span={8}><Form.Item name="changeClaimAmount" label="已批变更索赔(元)" rules={[nonNegMoneyRule]}><Input /></Form.Item></Col>
            <Col span={8}><Form.Item name="otherAddAmount" label="其他应结(元)" rules={[nonNegMoneyRule]}><Input /></Form.Item></Col>
            <Col span={8}><Form.Item name="deductPrepaymentAmount" label="扣回预付款(元，可为负)" rules={[signedMoneyRule]}><Input /></Form.Item></Col>
            <Col span={8}><Form.Item name="deductRetentionAmount" label="预留质保金(元，可为负)" rules={[signedMoneyRule]}><Input /></Form.Item></Col>
            <Col span={8}><Form.Item name="deductPenaltyAmount" label="违约/其他扣款(元，可为负)" rules={[signedMoneyRule]}><Input /></Form.Item></Col>
            <Col span={24}>
              <Alert style={{ marginBottom: 12 }} type={netPreview < 0n ? 'error' : 'info'}
                message={
                  netPreview < 0n
                    ? `净应付/收金额不可为负（当前净额 ${formatCentsPreview(netPreview)} 元），请核对应结与应扣项`
                    : `试算：一、应结小计 ${formatCentsPreview(grossPreview)} 元 − 二、应扣小计 ${formatCentsPreview(deductPreview)} 元 = 三、净应付/收 ${formatCentsPreview(netPreview)} 元`
                }
                description={`附件8四列汇总预览 —— 上期合计：${formatCentsPreview(priorNetCents)} 元 ｜ 本期结算：${formatCentsPreview(netPreview)} 元 ｜ 本年合计：${formatCentsPreview(ytdNetPreview)} 元 ｜ 合同累计：${formatCentsPreview(cumNetPreview)} 元`}
              />
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
                <Alert
                  style={{ marginBottom: 12 }}
                  type={payTierPreviewQ.data && !payTierPreviewQ.data.netAssetFound ? 'warning' : 'info'}
                  showIcon
                  message={'制度分级要求：不低于「' + (payTierPreviewQ.data?.requiredTierLabel ?? PAYMENT_APPROVAL_TIER_LABELS[requiredTier]) + '」'}
                  description={
                    payTierPreviewQ.data
                      ? payTierPreviewQ.data.netAssetFound
                        ? `法人 ${payTierPreviewQ.data.priorYear} 年度净资产 1% 门槛：${payTierPreviewQ.data.onePercentAmount ?? '—'} 元 ｜ 集团大额封顶：${payTierPreviewQ.data.ceilingAmount} 元`
                        : `尚未配置该法人 ${payTierPreviewQ.data.priorYear} 年度净资产，系统从严按最高级集体决策核验（需附大额资金可行性论证与会议纪要）。`
                      : undefined
                  }
                />
              </Col>
            )}
            <Col span={8}><Form.Item name="approvalTier" rules={[{ required: true }]} label="最高审批层级"><Select allowClear options={Object.entries(PAYMENT_APPROVAL_TIER_LABELS).map(([value, label]) => ({ value, label }))} /></Form.Item></Col>
            <Col span={8}><Form.Item name="approverName" rules={[{ required: true }]} label="最高审批人姓名"><Input maxLength={100} /></Form.Item></Col>
            <Col span={8}><Form.Item name="approverTitle" rules={[{ required: true }]} label="最高审批人职务"><Input maxLength={100} /></Form.Item></Col>
            <Col span={12}><Form.Item name="feasibilityDocId" label="大额资金可行性论证"><Select allowClear options={docOptions(docs.filter(d => d.evidenceKind === 'funding_feasibility'))} /></Form.Item></Col>
            <Col span={12}><Form.Item name="approvalDocId" label="审批签批单 / 会议纪要附件"><Select allowClear options={docOptions(docs.filter(d => d.evidenceKind === 'payment_approval_form'))} /></Form.Item></Col>
            <Col span={12}><Form.Item name="plannedDate" label="计划日期" {...datePickerProps}><DatePicker style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={12}><Form.Item name="evidenceDocumentId" label="其他依据文档(可空)"><Select allowClear options={docOptions(docs)} /></Form.Item></Col>
            <Col span={12}><Form.Item name="isFarmerWageTransfer" label="农民工工资专户" valuePropName="checked"><Checkbox>转入农民工工资专户</Checkbox></Form.Item></Col>
            {isFarmerWageWatch && (
              <Col span={24}>
                <Alert
                  type={contract.farmerWageAccount ? 'info' : 'warning'}
                  showIcon
                  message={
                    contract.farmerWageAccount
                      ? `农民工工资专用账户：${contract.farmerWageAccount}（请核对收款户名与账号一致）`
                      : '尚未维护农民工工资专用账户，请先在合同信息补充'
                  }
                />
              </Col>
            )}
          </Row>
        </Form>
      </Modal>

      <Modal
        open={payingPaymentId !== null}
        title="登记支付"
        onCancel={() => setPayingPaymentId(null)}
        destroyOnClose
        confirmLoading={run.isPending}
        onOk={() =>
          payRegForm.validateFields().then(async (v) => {
            if (payingPaymentId === null) return;
            await run.mutateAsync(() =>
              contractApi.pay(contract.id, payingPaymentId, compact({
                paidDate: v.paidDate,
                voucherNo: v.voucherNo,
                invoiceDocumentId: Number(v.invoiceDocumentId),
              }) as never),
            );
            setPayingPaymentId(null);
          })
        }
      >
        <Typography.Paragraph type="secondary">支付须关联发票类文档。</Typography.Paragraph>
        <Form form={payRegForm} layout="vertical" preserve={false}>
          <Form.Item name="paidDate" label="支付日期" rules={[{ required: true, message: '请选择支付日期' }]} {...datePickerProps}>
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="voucherNo" label="凭证号">
            <Input maxLength={64} />
          </Form.Item>
          <Form.Item name="invoiceDocumentId" label="发票" rules={[{ required: true, message: '请选择发票文档' }]}>
            <Select options={docOptions(docs, ['invoice'])} placeholder="选择发票附件" />
          </Form.Item>
        </Form>
      </Modal>

      <Modal
        open={receivingReceiptId !== null}
        title="登记收款到账"
        onCancel={() => setReceivingReceiptId(null)}
        destroyOnClose
        confirmLoading={run.isPending}
        onOk={() =>
          recRegForm.validateFields().then(async (v) => {
            if (receivingReceiptId === null) return;
            await run.mutateAsync(() =>
              contractApi.receiveReceipt(contract.id, receivingReceiptId, compact({
                receivedDate: v.receivedDate,
                voucherNo: v.voucherNo,
                invoiceDocumentId: v.invoiceDocumentId ? Number(v.invoiceDocumentId) : undefined,
              }) as never),
            );
            setReceivingReceiptId(null);
          })
        }
      >
        <Form form={recRegForm} layout="vertical" preserve={false}>
          <Form.Item name="receivedDate" label="实际到账日期" rules={[{ required: true, message: '请选择实际到账日期' }]} {...datePickerProps}>
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="voucherNo" label="银行回单 / 凭证号">
            <Input maxLength={64} />
          </Form.Item>
          <Form.Item name="invoiceDocumentId" label="发票附件（可选）">
            <Select allowClear options={docOptions(docs, ['invoice'])} />
          </Form.Item>
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
            <Col span={12}><Form.Item name="plannedDate" label="应收计划日期" {...datePickerProps}><DatePicker style={{ width: '100%' }} /></Form.Item></Col>
            <Col span={24}><Form.Item name="invoiceDocumentId" label="开票附件(可选)"><Select allowClear options={docOptions(docs, ['invoice', 'other'])} /></Form.Item></Col>
          </Row>
        </Form>
      </Modal>
      <Typography.Text type="secondary" style={{ fontSize: 12 }}>提示：复核动作须由非提交人执行；管理员同人复核须填写例外原因。</Typography.Text>
    </Space>
  );
}
