import { useEffect, useState } from 'react';
import { useMutation } from '@tanstack/react-query';
import {
  Alert, App as AntdApp, Button, Card, Checkbox, Col, DatePicker, Form, Input, Modal, Row, Select, Space, Statistic, Table, Tag, Typography,
} from 'antd';
import dayjs from 'dayjs';
import { can, errorText } from '../../api/client';
import {
  contractApi, type ChangeApprovalTier, type ChangeKind, type ContractChangeFilingRequest,
  type ContractChangeRequest, type ContractDetailDto, type ContractDocType,
} from '../../api/projectContract';
import { shortTime } from '../../utils/relativeTime';
import { compact, EXCEPTION_REASON_FIELD, Money, statusTag, usePrompt } from '../financeData/shared';
import { CONTRACT_DOC_TYPE_LABELS, FLOW_STATUS } from './shared';
import {
  CHANGE_APPROVAL_TIER_LABELS, CHANGE_KIND_LABELS, CHANGE_TIER_RANK, changeApprovalTierPreview,
  DECISION_METHOD_LABELS, formatCentsPreview, MEETING_TYPE_LABELS, parseMoneyToCentsPreview,
} from './contractOptions';

type DocPick = { id: number; name: string; docType: ContractDocType; evidenceKind?: string | null };
const docOptions = (docs: DocPick[], types?: ContractDocType[]) =>
  docs.filter((d) => !types || types.includes(d.docType)).map((d) => ({ value: d.id, label: CONTRACT_DOC_TYPE_LABELS[d.docType] + ' · ' + d.name }));

const moneyRule = {
  validator: (_: unknown, v?: string) => {
    if (!v || !String(v).trim()) return Promise.resolve();
    const c = parseMoneyToCentsPreview(v);
    return c === null ? Promise.reject(new Error('请输入合法金额(最多 2 位小数)')) : Promise.resolve();
  },
};

export function ContractChangeTab({ contract, onChanged }: { contract: ContractDetailDto; onChanged: (d?: ContractDetailDto) => void }) {
  const { message } = AntdApp.useApp();
  const [prompt, holder] = usePrompt();
  const [createOpen, setCreateOpen] = useState(false);
  const [filingChangeId, setFilingChangeId] = useState<number | null>(null);
  const [form] = Form.useForm();
  const [filingForm] = Form.useForm();

  const writable = can('contract:write') && ['active','suspended'].includes(contract.status);
  const canEditFiling = can('contract:write') && contract.status !== 'voided';
  const reviewer = can('contract:review') && ['active','suspended'].includes(contract.status);
  const canSubmitStage = ['performance', 'settlement', 'warranty'].includes(contract.stage);
  const docs: DocPick[] = contract.documents ?? [];
  const activeGuarantees = (contract.guarantees ?? []).filter((g) => g.status === 'active').length;

  const priorApprovedPositiveCents = contract.changes.reduce((sum, ch) => {
    if (ch.status !== 'approved') return sum;
    if (ch.changeKind && !['change', 'claim_by_contractor'].includes(ch.changeKind)) return sum;
    const d = parseMoneyToCentsPreview(ch.delta) ?? 0n;
    return d > 0n ? sum + d : sum;
  }, 0n);

  const originalCents = parseMoneyToCentsPreview(contract.originalAmount) ?? 0n;
  const estimatedCeilingCents = contract.estimatedCeilingAmount ? parseMoneyToCentsPreview(contract.estimatedCeilingAmount) : null;

  const run = useMutation({
    mutationFn: (fn: () => Promise<ContractDetailDto>) => fn(),
    onSuccess: (d) => { message.success('已完成'); onChanged(d); },
    onError: (e) => message.error(errorText(e)),
  });

  const changeKind = (Form.useWatch('changeKind', form) ?? 'change') as ChangeKind;
  const deltaText = Form.useWatch('delta', form) as string | undefined;
  const involvesBiz = !!Form.useWatch('involvesBizOrEntityChange', form);
  const involvesTech = !!Form.useWatch('involvesTechChange', form);
  const isIndependent = !!Form.useWatch('isIndependentDelegable', form);
  const actualTier = Form.useWatch('actualApprovalTier', form) as ChangeApprovalTier | undefined;
  const techAuditDocId = Form.useWatch('techSpecialAuditDocId', form) as number | undefined;
  const guarantorDocId = Form.useWatch('guarantorConsentDocumentId', form) as number | undefined;

  useEffect(() => {
    if (createOpen && (changeKind === 'suspend' || changeKind === 'terminate')) {
      form.setFieldValue('delta', '0.00');
    }
  }, [changeKind, createOpen, form]);

  const deltaCents = changeKind === 'suspend' || changeKind === 'terminate'
    ? 0n
    : (parseMoneyToCentsPreview(deltaText ?? '0') ?? 0n);

  const tierPreview = changeApprovalTierPreview({
    originalCents,
    estimatedCeilingCents,
    priorApprovedPositiveCents,
    deltaCents,
    changeKind,
    procurementTier: contract.procurementTier ?? null,
    involvesBizOrEntityChange: involvesBiz,
    involvesTechChange: involvesTech,
    orMode: 'min',
  });

  const tierMismatch = !!actualTier && CHANGE_TIER_RANK[actualTier] < CHANGE_TIER_RANK[tierPreview.tier];
  const baseCents = originalCents > 0n ? originalCents : (estimatedCeilingCents ?? 0n);
  const hitThreshold = priorApprovedPositiveCents >= 500_000_000n || (baseCents > 0n && priorApprovedPositiveCents * 10n >= baseCents);

  const decide = async (cid: number) => {
    const v = await prompt({
      title: '复核变更 / 索赔 / 中止 / 解除',
      fields: [
        { name: 'decision', label: '结论', required: true, options: [{ value: 'approve', label: '批准' }, { value: 'reject', label: '驳回' }], initial: 'approve' },
        { name: 'comment', label: '意见', multiline: true },
        EXCEPTION_REASON_FIELD,
      ],
    });
    if (!v) return;
    const body = compact({ decision: v.decision as 'approve' | 'reject', comment: v.comment, exceptionReason: v.exceptionReason }) as { decision: 'approve' | 'reject' };
    run.mutate(() => contractApi.decideChange(contract.id, cid, body));
  };

  const openFiling = (ch: ContractDetailDto['changes'][number]) => {
    setFilingChangeId(ch.id);
    filingForm.setFieldsValue({
      supplementNo: ch.supplementNo ?? '',
      disciplineFiledAt: ch.disciplineFiledAt ?? null,
      techReviewRepliedAt: ch.techReviewRepliedAt ?? null,
      hasDispute: !!ch.hasDispute,
    });
  };

  const flowCols = <T extends { status: string; submittedBy: string | null; submittedAt: string; reviewedBy: string | null; comment: string | null; exceptionReason: string | null; selfReview: boolean }>() => [
    { title: '状态', dataIndex: 'status', width: 90, render: (v: string) => statusTag(FLOW_STATUS, v) },
    { title: '提交', key: 'sub', width: 140, render: (_: unknown, r: T) => <span>{r.submittedBy ?? '—'} · {shortTime(r.submittedAt)}</span> },
    {
      title: '复核', key: 'rev', render: (_: unknown, r: T) => (r.reviewedBy ? (
        <span>{r.reviewedBy}{r.comment ? ':' + r.comment : ''}{r.selfReview && <Tag color="orange" style={{ marginLeft: 4 }}>同人例外:{r.exceptionReason}</Tag>}</span>
      ) : '—'),
    },
  ];

  return (
    <Space direction="vertical" style={{ width: '100%' }} size={12}>
      {holder}
      <Row gutter={12}>
        <Col span={6}><Card size="small"><Statistic title="累计已批正变更" valueRender={() => <Money value={formatCentsPreview(priorApprovedPositiveCents)} />} /></Card></Col>
        <Col span={6}><Card size="small"><Statistic title="累计变更净额" valueRender={() => <Money value={contract.approvedChange} tone />} /></Card></Col>
        <Col span={6}><Card size="small"><Statistic title="500万/10% 门槛状态" value={hitThreshold ? '已达门槛（直达经营层）' : '未达门槛（四档定级）'} /></Card></Col>
        <Col span={6}><Card size="small"><Statistic title="有效担保/保函" value={activeGuarantees + ' 笔'} /></Card></Col>
      </Row>

      {activeGuarantees > 0 && (
        <Alert type="info" showIcon message={'本合同存在 ' + activeGuarantees + ' 笔有效担保/保函，提交变更、中止或解除时须附担保单位书面同意函（制度 10.8/10.9）。'} />
      )}

      <Card
        size="small"
        title={'变更 · 索赔 · 中止 · 解除四位一体台账 · ' + contract.changes.length}
        extra={writable && canSubmitStage && (
          <Button size="small" type="primary" onClick={() => setCreateOpen(true)}>提交变更 / 索赔</Button>
        )}
      >
        <Table
          rowKey="id"
          size="small"
          pagination={false}
          dataSource={contract.changes}
          scroll={{ x: 1080 }}
          columns={[
            {
              title: '类型', dataIndex: 'changeKind', width: 110,
              render: (v?: ChangeKind) => <Tag color={v === 'terminate' ? 'red' : v === 'suspend' ? 'orange' : 'blue'}>{CHANGE_KIND_LABELS[v ?? 'change']}</Tag>,
            },
            { title: '变更金额', dataIndex: 'delta', width: 120, align: 'right', render: (v: string) => <Money value={v} tone /> },
            {
              title: '事项与原因', key: 'reason', width: 220,
              render: (_, r) => (
                <div>
                  {r.changeMatter && <div style={{ fontWeight: 500 }}>{r.changeMatter}</div>}
                  <Typography.Text type="secondary" style={{ fontSize: 12 }}>{r.reason}</Typography.Text>
                  {r.hasDispute && <div><Tag color="red">涉纠纷</Tag></div>}
                </div>
              ),
            },
            {
              title: '附件 5 要求 / 实际审批', key: 'tier', width: 210,
              render: (_, r) => (
                <div style={{ fontSize: 12 }}>
                  <div>要求：{CHANGE_APPROVAL_TIER_LABELS[r.requiredApprovalTier ?? 'undertaker_unit']}</div>
                  <div style={{ color: '#666' }}>实际：{r.actualApprovalTier ? CHANGE_APPROVAL_TIER_LABELS[r.actualApprovalTier] : '未填'}</div>
                </div>
              ),
            },
            {
              title: '补充协议与备案', key: 'filing', width: 170,
              render: (_, r) => (
                <div style={{ fontSize: 12 }}>
                  <div>协议号：{r.supplementNo ?? '—'}</div>
                  <div>纪审备案：{r.disciplineFiledAt ?? '—'}</div>
                  {r.techReviewAppliedAt && <div>技审回复：{r.techReviewRepliedAt ?? '待反馈'}</div>}
                </div>
              ),
            },
            ...flowCols<ContractDetailDto['changes'][number]>(),
            {
              title: '操作', key: 'op', width: 130,
              render: (_, r) => (
                <Space size={4}>
                  {reviewer && r.status === 'submitted' && <Button size="small" type="primary" onClick={() => void decide(r.id)}>复核</Button>}
                  {canEditFiling && <Button size="small" onClick={() => openFiling(r)}>备案</Button>}
                </Space>
              ),
            },
          ]}
        />
      </Card>

      <Modal
        open={createOpen}
        title="提交变更 / 索赔 / 中止 / 解除"
        width={760}
        onCancel={() => setCreateOpen(false)}
        destroyOnClose
        confirmLoading={run.isPending}
        onOk={() => form.validateFields().then(async (v) => {
          const payload = compact({
            ...v,
            delta: v.changeKind === 'suspend' || v.changeKind === 'terminate' ? '0.00' : (v.delta || '0.00'),
          }) as ContractChangeRequest;
          await run.mutateAsync(() => contractApi.submitChange(contract.id, payload));
          setCreateOpen(false);
        })}
      >
        <Form
          form={form}
          layout="vertical"
          preserve={false}
          initialValues={{
            changeKind: contract.status === 'suspended' ? 'terminate' : 'change',
            delta: '0.00',
            involvesBizOrEntityChange: false,
            involvesTechChange: false,
            isIndependentDelegable: false,
            hasDispute: false,
          }}
        >
          <Row gutter={12}>
            <Col span={12}>
              <Form.Item name="changeKind" label="变更类型">
                <Select options={Object.entries(CHANGE_KIND_LABELS).filter(([value]) => contract.status !== 'suspended' || value === 'terminate').map(([value, label]) => ({ value, label }))} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="delta" label="变更金额(元，支持 0 金额或负数)" rules={[moneyRule]}>
                <Input disabled={changeKind === 'suspend' || changeKind === 'terminate'} placeholder="0.00 / 20000.00 / -5000.00" />
              </Form.Item>
            </Col>
            <Col span={24}>
              <Form.Item name="changeMatter" rules={[{ required: true }]} label="主要事项（≤500字）">
                <Input maxLength={500} placeholder="如：工期顺延30天 / 渠道衬砌护坡工程量增项" />
              </Form.Item>
            </Col>
            <Col span={24}>
              <Form.Item name="reason" label="变更 / 索赔 / 中止 / 解除原因" rules={[{ required: true, whitespace: true }]}>
                <Input.TextArea rows={2} maxLength={500} />
              </Form.Item>
            </Col>
            <Col span={8}><Form.Item name="involvesBizOrEntityChange" valuePropName="checked"><Checkbox>涉及实质商务/主体/付款变化</Checkbox></Form.Item></Col>
            <Col span={8}><Form.Item name="involvesTechChange" valuePropName="checked"><Checkbox>涉及技术方案/质量标准变化</Checkbox></Form.Item></Col>
            <Col span={8}><Form.Item name="isIndependentDelegable" valuePropName="checked"><Checkbox>具备独立委托条件(制度 9.1.4)</Checkbox></Form.Item></Col>

            <Col span={24}>
              <Space direction="vertical" style={{ width: '100%', marginBottom: 12 }} size={6}>
                <Alert
                  type={tierMismatch ? 'warning' : 'info'}
                  showIcon
                  message={'附件 5 要求审批层级：' + CHANGE_APPROVAL_TIER_LABELS[tierPreview.tier]}
                  description={
                    <div>
                      {tierPreview.requireDisciplineFiling && <div>· 涉及增额须报纪审部备案；</div>}
                      {tierPreview.requireTechSpecialAudit && <div style={{ color: '#d46b08' }}>· 单次或累计增额超原合同 10%，须上传技术归口部门专项全面复核意见（制度 9.1.2）；</div>}
                      {tierMismatch && <div style={{ color: '#cf1322' }}>· 当前所选实际审批层级低于制度要求，提交将被阻断。</div>}
                      {changeKind === 'terminate' && <div>· 合同解除须总经理及以上批准，且须上传《解除协议及清算方案》（evidenceKind = 解除协议及清算方案）。</div>}
                    </div>
                  }
                />
                {isIndependent && (
                  <Alert type="error" showIcon message="阻断提示：与原合同无关或具备独立委托条件且超范围事项，不得通过变更办理，请按《采购管理办法》重新选定相对方（制度 9.1.4）。" />
                )}
                {activeGuarantees > 0 && !guarantorDocId && (
                  <Alert type="warning" showIcon message="阻断提示：本合同存在有效担保/保函，须选择《担保单位书面同意函》附件。" />
                )}
                {tierPreview.requireTechSpecialAudit && !techAuditDocId && (
                  <Alert type="warning" showIcon message="阻断提示：增额超 10%，请选择技术归口部门专项全面复核意见附件。" />
                )}
              </Space>
            </Col>

            <Col span={12}>
              <Form.Item name="actualApprovalTier" rules={[{ required: true }]} label="实际审批层级">
                <Select allowClear options={Object.entries(CHANGE_APPROVAL_TIER_LABELS).map(([value, label]) => ({ value, label }))} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="supplementNo" label="补充协议编号（法人单位内唯一）">
                <Input maxLength={100} placeholder="如 LS-SG-001/2026-001(补1)" />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="evidenceDocumentId" label="变更 / 索赔 / 解除依据文档" rules={[{ required: true, message: '请选择依据文档' }]}>
                <Select options={docOptions(docs, ['change', 'settlement', 'other', 'contract_text'])} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="guarantorConsentDocumentId" rules={[{ required: activeGuarantees > 0 }]} label="担保单位书面同意函(有保函时必填)">
                <Select allowClear options={docOptions(docs.filter(d => d.evidenceKind === 'guarantor_consent'))} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="techSpecialAuditDocId" rules={[{ required: tierPreview.requireTechSpecialAudit || involvesTech }]} label="技术归口专项复核意见(>10%时必填)">
                <Select allowClear options={docOptions(docs)} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="outOfPlanDocId" label="计划外审批凭据(超综合计划时必填)">
                <Select allowClear options={docOptions(docs)} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="decisionMethod" rules={[{ required: true }]} label="决策方式">
                <Select allowClear options={Object.entries(DECISION_METHOD_LABELS).map(([value, label]) => ({ value, label }))} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="meetingType" label="会议形式">
                <Select allowClear options={Object.entries(MEETING_TYPE_LABELS).map(([value, label]) => ({ value, label }))} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="finalApproverName" rules={[{ required: true }]} label="最终审批人姓名">
                <Input maxLength={100} />
              </Form.Item>
            </Col>
            <Col span={8}><Form.Item name="finalApproverTitle" label="最终审批人身份" rules={[{ required: true }]}><Input maxLength={100} /></Form.Item></Col>
            <Col span={8}>
              <Form.Item name="techReviewAppliedAt" label="提请技术审查日" getValueProps={(v?: string) => ({ value: v ? dayjs(v) : null })} normalize={(d: dayjs.Dayjs | null) => (d ? d.format('YYYY-MM-DD') : null)}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="techReviewRepliedAt" label="技术审查反馈日" getValueProps={(v?: string) => ({ value: v ? dayjs(v) : null })} normalize={(d: dayjs.Dayjs | null) => (d ? d.format('YYYY-MM-DD') : null)}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="disciplineFiledAt" label="纪审部备案日" getValueProps={(v?: string) => ({ value: v ? dayjs(v) : null })} normalize={(d: dayjs.Dayjs | null) => (d ? d.format('YYYY-MM-DD') : null)}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={24}>
              <Form.Item name="hasDispute" valuePropName="checked"><Checkbox>本次变更已产生纠纷</Checkbox></Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>

      <Modal
        open={filingChangeId != null}
        title="补录变更协议编号与备案信息"
        width={520}
        onCancel={() => setFilingChangeId(null)}
        destroyOnClose
        confirmLoading={run.isPending}
        onOk={() => filingForm.validateFields().then(async (v) => {
          if (filingChangeId == null) return;
          const body: ContractChangeFilingRequest = {
            supplementNo: v.supplementNo?.trim() || null,
            disciplineFiledAt: v.disciplineFiledAt || null,
            techReviewRepliedAt: v.techReviewRepliedAt || null,
            hasDispute: !!v.hasDispute,
          };
          await run.mutateAsync(() => contractApi.updateChangeFiling(contract.id, filingChangeId, body));
          setFilingChangeId(null);
        })}
      >
        <Form form={filingForm} layout="vertical" preserve={false}>
          <Form.Item name="supplementNo" label="补充协议编号（同一法人单位内唯一）"><Input maxLength={100} /></Form.Item>
          <Form.Item name="disciplineFiledAt" label="纪审部备案日期" getValueProps={(v?: string) => ({ value: v ? dayjs(v) : null })} normalize={(d: dayjs.Dayjs | null) => (d ? d.format('YYYY-MM-DD') : null)}>
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="techReviewRepliedAt" label="技术归口审查反馈日期" getValueProps={(v?: string) => ({ value: v ? dayjs(v) : null })} normalize={(d: dayjs.Dayjs | null) => (d ? d.format('YYYY-MM-DD') : null)}>
            <DatePicker style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item name="hasDispute" valuePropName="checked"><Checkbox>是否产生纠纷</Checkbox></Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
