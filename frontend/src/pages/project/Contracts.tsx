import { ContractLegalPanel } from './ContractLegalPanel';
import { ContractLegalCatalog } from './ContractLegalCatalog';
import { ContractBaseFormModal } from './ContractBaseFormModal';
import { ContractSettlementTab } from './ContractSettlementTab';
import { ContractChangeTab } from './ContractChangeTab';
import { ContractSafeguardTab } from './ContractSafeguardTab';
import { ContractCountersignTab } from './ContractCountersignTab';
import { ContractProcurementTab } from './ContractProcurementTab';
import { ContractExportModal } from './ContractExportModal';
import type { EvidenceKind, LegalCategory, ProcurementMethod } from '@contracts/contract-legal-review';
import {
  ARCHIVE_STATUS_LABELS, DIRECTION_LABELS, DISTRIBUTION_STATUS_LABELS, EVIDENCE_KINDS, EVIDENCE_LABELS,
  LEGAL_CATEGORIES, LEGAL_LABELS, METHOD_LABELS, PRICING_MODE_LABELS, PROCUREMENT_METHODS,
} from './contractOptions';
import { useAssistantDomainPage } from '../../assistant/contextHooks';
import { useEffect, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { useNavigate } from 'react-router-dom';
import { positiveQueryNumber, useListSearchParams } from '../../hooks/useListSearchParams';
import {
  Alert, App as AntdApp, Badge, Button, Card, Col, DatePicker, Descriptions, Drawer, Empty, Form, Input, Modal, Popconfirm, Row, Segmented, Select, Space, Table, Tabs, Tag, Timeline, Tooltip, Typography, Upload,
} from 'antd';
import type { SorterResult } from 'antd/es/table/interface';
import dayjs from 'dayjs';
import { can, download, errorText } from '../../api/client';
import {
  contractApi, type ContractArchiveStatus, type ContractDetailDto, type ContractDirection, type ContractDocType,
  type ContractDto, type ContractListQuery, type ContractPricingMode, type ContractSortDir, type ContractSortField,
  type ContractStage, type ContractStatus, type ContractTodo,
} from '../../api/projectContract';
import { QueryErrorResult } from '../../components/QueryErrorResult';
import { shortTime } from '../../utils/relativeTime';
import { compact, EXCEPTION_REASON_FIELD, Money, OrgSelect, Ratio, statusTag, usePrompt, type PromptField } from '../financeData/shared';
import { CONTRACT_DOC_TYPE_LABELS, CONTRACT_STAGE_LABELS, CONTRACT_STAGE_ORDER, CONTRACT_STATUS, FLOW_STATUS } from './shared';

/**
 * AC-F16 合同台账与生命周期:阶段推进(服务端重算 blocker)、审核、变更、付款(申请 → 复核 → 凭发票支付)、文档与事件。
 * 复核动作要求提交人 ≠ 复核人;管理员同人复核须填例外原因。
 */

export const TODO_LABEL: Record<ContractTodo, string> = {
  review: '待审核合同', change: '待复核变更', payment: '待复核付款', pay: '已批准待支付',
  settlement: '待复核结算单', receipt: '待处理收款', distribution: '签署超 10 工作日待分发', guarantee_warranty: '30 天内到期保函/待签证质保',
};

const datePickerItemProps = {
  getValueProps: (v?: string) => ({ value: v ? dayjs(v) : null }),
  normalize: (d: dayjs.Dayjs | null) => (d ? d.format('YYYY-MM-DD') : null),
};

function ContractDrawer({ id, onClose }: { id: number | null; onClose: () => void }) {
  const { message, modal } = AntdApp.useApp();
  const qc = useQueryClient();
  const [prompt, holder] = usePrompt();
  const [editing, setEditing] = useState(false);
  const [opModalKind, setOpModalKind] = useState<'distribution' | 'archive' | 'handover' | null>(null);
  const [opForm] = Form.useForm();
  const [evidenceKind,setEvidenceKind]=useState<EvidenceKind>();
  const [docChangeId, setDocChangeId] = useState<number | undefined>();
  const [docType, setDocType] = useState<ContractDocType>('contract_text');
  useEffect(() => {
    setDocType('contract_text');
    setEvidenceKind(undefined);
    setDocChangeId(undefined);
  }, [id]);
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

  const decide = async (kind: 'review' | 'change', rid: number) => {
    const v = await prompt({
      title: '复核', fields: [
        { name: 'decision', label: '结论', required: true, options: [{ value: 'approve', label: '批准' }, { value: 'reject', label: '驳回' }], initial: 'approve' },
        { name: 'comment', label: '意见', multiline: true }, EXCEPTION_REASON_FIELD,
      ],
    });
    if (!v || !c) return;
    const body = compact({ decision: v.decision as 'approve' | 'reject', comment: v.comment, exceptionReason: v.exceptionReason }) as { decision: 'approve' | 'reject' };
    run.mutate(() => (kind === 'review' ? contractApi.decideReview(c.id, rid, body) : contractApi.decideChange(c.id, rid, body)));
  };
  const command = async (kind: 'terminate' | 'void' | 'reopen' | 'suspend' | 'resume') => {
    if (!c) return;
    const fields: PromptField[] = [{ name: 'reason', label: '原因', required: true, multiline: true }];
    if (kind === 'terminate') fields.push(
      { name: 'approvalTier', label: '解除批准层级', required: true, options: [{ value: 'general_manager', label: '总经理' }, { value: 'management_board', label: '公司经营层' }] },
      { name: 'terminationAgreementDocumentId', label: '解除协议及清算方案', required: true, options: c.documents.filter(d => d.evidenceKind === 'termination_agreement').map(d => ({ value: String(d.id), label: d.name })) },
    );
    if ((kind === 'terminate' || kind === 'suspend') && (c.guarantees ?? []).some(g => g.status === 'active')) fields.push({ name: 'guarantorConsentDocumentId', label: '担保方书面同意函', required: true, options: c.documents.filter(d => d.evidenceKind === 'guarantor_consent').map(d => ({ value: String(d.id), label: d.name })) });
    const v = await prompt({
      title: kind === 'terminate' ? '终止合同' : kind === 'void' ? '作废合同' : kind === 'suspend' ? '中止合同履行' : kind === 'resume' ? '恢复合同履行' : '重开合同',
      danger: kind === 'terminate' || kind === 'void',
      description: kind === 'void' ? '作废后不可重开;已有付款的合同只能终止。' : kind === 'terminate' ? '终止后可由复核人重开。' : undefined,
      fields: kind === 'reopen' ? [...fields, { name: 'targetStage', label: '回到阶段', required: true, options: CONTRACT_STAGE_ORDER.filter((s) => s !== 'closed').map((s) => ({ value: s, label: CONTRACT_STAGE_LABELS[s] })), initial: 'performance' }] : fields,
    });
    if (!v) return;
    run.mutate(() => (kind === 'terminate' ? contractApi.terminate(c.id, c.version, v.reason, { approvalTier: v.approvalTier, terminationAgreementDocumentId: Number(v.terminationAgreementDocumentId), guarantorConsentDocumentId: v.guarantorConsentDocumentId ? Number(v.guarantorConsentDocumentId) : undefined })
      : kind === 'void' ? contractApi.void(c.id, c.version, v.reason)
      : kind === 'suspend' ? contractApi.suspend(c.id, c.version, v.reason, v.guarantorConsentDocumentId ? Number(v.guarantorConsentDocumentId) : undefined)
      : kind === 'resume' ? contractApi.resume(c.id, c.version, v.reason)
      : contractApi.reopen(c.id, c.version, v.reason, v.targetStage as ContractStage)));
  };
  const registerDistribution = () => {
    if (!c) return;
    opForm.resetFields();
    opForm.setFieldsValue({ distributedAt: dayjs().format('YYYY-MM-DD'), companyFiledAt: null, note: '' });
    setOpModalKind('distribution');
  };
  const updateArchive = () => {
    if (!c) return;
    opForm.resetFields();
    opForm.setFieldsValue({ archiveStatus: 'checked', actionDate: dayjs().format('YYYY-MM-DD'), transferNo: '' });
    setOpModalKind('archive');
  };
  const handover = () => {
    if (!c) return;
    opForm.resetFields();
    opForm.setFieldsValue({ toUndertaker: '', toDept: '', handoverDate: dayjs().format('YYYY-MM-DD'), leftPostDate: null, reason: '' });
    setOpModalKind('handover');
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
    <Drawer rootClassName="contract-detail-drawer" open={id != null} onClose={onClose} width={1080} destroyOnClose title={c ? `${c.contractNo} · ${c.name}` : '合同'}
      extra={c && (
        <Space wrap>
          {writable && <Button onClick={() => setEditing(true)}>编辑</Button>}
          {writable && c.nextStage && (
            <Button type="primary" disabled={c.blockers.length > 0} onClick={() => modal.confirm({
              title: `推进到「${CONTRACT_STAGE_LABELS[c.nextStage!]}」?`, content: c.nextStage === 'closed' ? '履约完结后合同关闭,不能再写入。' : undefined,
              onOk: () => run.mutateAsync(() => contractApi.advance(c.id, c.version, c.nextStage!)),
            })}>推进到{CONTRACT_STAGE_LABELS[c.nextStage]}</Button>
          )}
          {can('contract:write') && ['active','suspended'].includes(c.status) && <Button danger onClick={() => void command('terminate')}>终止</Button>}
          {writable && ['performance', 'settlement', 'warranty'].includes(c.stage) && <Button onClick={() => void command('suspend')}>中止</Button>}
          {can('contract:write') && c.status === 'suspended' && <Button type="primary" onClick={() => void command('resume')}>恢复履行</Button>}
          {can('contract:write') && c.status !== 'voided' && (c.signDate || c.documents.some((d) => d.docType === 'signed')) && c.distributionStatus !== 'completed' && <Button onClick={registerDistribution}>分发备案</Button>}
          {reviewer && c.status !== 'voided' && c.archiveStatus !== 'transferred' && <Button onClick={updateArchive}>档案核验/移交</Button>}
          {can('contract:write') && c.status !== 'voided' && <Button onClick={handover}>承办人交接</Button>}
          {writable && c.paidAmount === '0.00' && (c.receivedAmount ?? '0.00') === '0.00' && <Button danger onClick={() => void command('void')}>作废</Button>}
          {reviewer && (c.status === 'closed' || c.status === 'terminated') && <Button onClick={() => void command('reopen')}>重开</Button>}
        </Space>
      )}>
      {holder}
      {q.error ? <QueryErrorResult title="合同加载失败" error={q.error} refetch={q.refetch} /> : c && (
        <Space direction="vertical" style={{ width: '100%' }} size={12}>
          {c.migrationMode === 'legacy_tolerant' && (
            <Alert
              type="warning"
              showIcon
              message={
                <Space wrap size={6}>
                  <span>历史容缺迁入合同</span>
                  {c.syntheticNoFlag && <Tag color="purple">合成号</Tag>}
                  {c.isReversal && <Tag color="magenta">红冲</Tag>}
                </Space>
              }
              description={`实际签约主体：${c.signingOrgName || c.orgName} ｜ 法定法人统计口径：${c.legalEntityOrgName || c.orgName}${(c.missingFields?.length ?? 0) > 0 ? ` ｜ 待补录缺口：${c.missingFields!.join('、')}` : ''}`}
            />
          )}
          {Boolean(c.legalReviewEnabled || ((c as unknown as { legalReviews?: unknown[] }).legalReviews?.length ?? 0) > 0) ? (
            <ContractLegalPanel key={c.id} contract={c} onChanged={()=>refresh()}/>
          ) : (
            <Alert
              type="info"
              showIcon
              message="当前合同类别未纳入强制智能法审范围（可按内部一般流程审核或由法务配置扩展纳管类别）。"
            />
          )}
          <Descriptions size="small" column={{xs:1,sm:2,lg:3}} bordered>
            <Descriptions.Item label="组织">{c.orgName}</Descriptions.Item>
            <Descriptions.Item label="项目">{c.projectName ? `${c.projectName}(${c.projectCode})` : '—'}</Descriptions.Item>
            <Descriptions.Item label="供应商">{c.supplierName ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="阶段">{CONTRACT_STAGE_LABELS[c.stage]}</Descriptions.Item>
            <Descriptions.Item label="状态">{statusTag(CONTRACT_STATUS, c.status)}{c.statusReason && <Typography.Text type="secondary">{c.statusReason}</Typography.Text>}</Descriptions.Item>
            <Descriptions.Item label="来源 / 版本">{c.source === 'import' ? '导入' : '手工'} · v{c.version}</Descriptions.Item>
            <Descriptions.Item label="方向 / 计价">{DIRECTION_LABELS[c.direction ?? 'expense']} · {PRICING_MODE_LABELS[c.pricingMode ?? 'lump_sum']}{c.currency && c.currency !== '人民币' ? ' · ' + c.currency : ''}</Descriptions.Item>
            <Descriptions.Item label="承办人">{c.undertakerName || '—'}{c.undertakerDept ? '（' + c.undertakerDept + '）' : ''}</Descriptions.Item>
            <Descriptions.Item label="分发 / 档案">{DISTRIBUTION_STATUS_LABELS[c.distributionStatus ?? 'pending']} · {ARCHIVE_STATUS_LABELS[c.archiveStatus ?? 'collecting']}</Descriptions.Item>
            <Descriptions.Item label="原始金额"><Money value={c.originalAmount} /></Descriptions.Item>
            <Descriptions.Item label="已批准变更"><Money value={c.approvedChange} /></Descriptions.Item>
            <Descriptions.Item label="当前金额"><Money value={c.currentAmount} /></Descriptions.Item>
            <Descriptions.Item label={c.direction === 'income' ? '已收' : '已付'}><Money value={c.direction === 'income' ? (c.receivedAmount ?? '0.00') : c.paidAmount} /></Descriptions.Item>
            <Descriptions.Item label={c.direction === 'income' ? '收款比例' : '付款比例'}>{c.direction === 'income' ? (c.receiptRate == null ? '—' : <Ratio value={c.receiptRate} />) : (c.paymentRate == null ? '—' : <Ratio value={c.paymentRate} />)}</Descriptions.Item>
            <Descriptions.Item label="付款上限">{c.paymentCapRatio == null ? '100%' : <Ratio value={c.paymentCapRatio} />}</Descriptions.Item>
            <Descriptions.Item label="签订日期">{c.signDate ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="生效日期">{c.effectiveDate ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="合同类型">{c.contractType || '—'}</Descriptions.Item>
            <Descriptions.Item label="关联综合计划项">
              {c.planItemName
                ? `${c.planItemName}${c.annualPlanAllocAmount ? `（本年分配 ${c.annualPlanAllocAmount} 元）` : ''}`
                : '—'}
            </Descriptions.Item>
            <Descriptions.Item label="主/关联合同">{c.parentContractNo ?? '—'}</Descriptions.Item>
            <Descriptions.Item label="单位审签领导">
              {c.unitApproverName || '—'}{c.unitApproverTitle ? `（${c.unitApproverTitle}）` : ''}
            </Descriptions.Item>
            <Descriptions.Item label="资信与响应核验">
              <Space size={4} wrap>
                <Tag color={c.creditChecked ? 'success' : 'default'}>
                  失信核查:{c.creditChecked ? '已通过' : '待核'}
                </Tag>
                <Tag color={c.responseDocsComplete ? 'success' : 'default'}>
                  响应文件:{c.responseDocsComplete ? '齐备' : '待补'}
                </Tag>
              </Space>
            </Descriptions.Item>
            <Descriptions.Item label="承办人交接记录" span={2}>
              {(c.handovers?.length ?? 0) > 0
                ? c.handovers!.map((h) => `${h.fromUndertaker || '原经办'} → ${h.toUndertaker} (${h.handoverDate})`).join('；')
                : '无交接记录'}
            </Descriptions.Item>
          </Descriptions>
          {c.status === 'active' && c.nextStage && (c.blockers.length ? (
            <Alert type="warning" showIcon message={`推进到「${CONTRACT_STAGE_LABELS[c.nextStage]}」前还需:`}
              description={<ul style={{ margin: 0, paddingLeft: 18 }}>{c.blockers.map((b) => <li key={b.code}>{b.message}</li>)}</ul>} />
          ) : <Alert type="success" showIcon message={`已满足推进到「${CONTRACT_STAGE_LABELS[c.nextStage]}」的条件`} />)}
          <Tabs items={[
            {
              key: 'docs', label: `文档 ${c.documents.length}`, children: (
                <>
                  {can('contract:write') && ['active','suspended'].includes(c.status) && (
                    <Space wrap style={{ marginBottom: 8 }}>
                      <Select aria-label="文档类型" value={docType} onChange={(value) => { setDocType(value); setEvidenceKind(undefined); }} style={{ width: 140 }} options={Object.entries(CONTRACT_DOC_TYPE_LABELS).map(([value, label]) => ({ value, label }))} />
                      <Select aria-label="签订依据分类" value={evidenceKind} allowClear placeholder="签订依据分类（可选）" style={{width:230}} onChange={setEvidenceKind} options={EVIDENCE_KINDS.map(value=>({value,label:EVIDENCE_LABELS[value]}))}/>
                      <Select
                        aria-label="关联补充协议"
                        value={docChangeId}
                        allowClear
                        placeholder="关联补充协议（可选）"
                        style={{ width: 200 }}
                        onChange={setDocChangeId}
                        options={c.changes.map((ch) => ({
                          value: ch.id,
                          label: `${ch.supplementNo ?? `变更#${ch.id}`} · ${ch.reason}`,
                        }))}
                      />
                      <Upload accept=".docx,.pdf,.doc,.png,.jpg,.jpeg,.wps" showUploadList={false} beforeUpload={(f) => {
                        run.mutate(async () => {
                          const document = await contractApi.uploadDocument(c.id, f, docType, undefined, evidenceKind, docChangeId);
                          setEvidenceKind(undefined);
                          setDocChangeId(undefined);
                          return document;
                        });
                        return false;
                      }}>
                        <Button icon={<i className="ri-upload-2-line" aria-hidden />}>上传文档</Button>
                      </Upload>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        支持 .docx、.pdf 及老版 .doc 合同正文（.doc 将在后台转码后纳入法审）
                      </Typography.Text>
                    </Space>
                  )}
                  <Table rowKey="id" size="small" pagination={false} dataSource={c.documents}
                    columns={[
                      { title: '类型', dataIndex: 'docType', width: 100, render: (v: string) => CONTRACT_DOC_TYPE_LABELS[v] },
                      { title: '签订依据', dataIndex: 'evidenceKind', render: (v: EvidenceKind | null) => v ? EVIDENCE_LABELS[v] : '—' },
                      {
                        title: '关联补充协议',
                        key: 'chg',
                        width: 140,
                        render: (_, d) => d.changeSupplementNo || (d.changeId ? `变更#${d.changeId}` : '—'),
                      },
                      { title: '名称', dataIndex: 'name', ellipsis: true },
                      { title: '上传', key: 'u', width: 170, render: (_, d) => `${d.uploadedBy ?? '—'} · ${shortTime(d.uploadedAt)}` },
                      {
                        title: '操作', key: 'op', width: 220, render: (_, d) => (
                          <Space size={0}>
                            {d.withdrawnAt && <Tag>已撤回</Tag>}
                            <Button type="link" size="small" onClick={() => void download(`/contracts/${c.id}/documents/${d.id}/content`, d.name)}>下载</Button>
                            {writable && !d.withdrawnAt && d.docType === 'contract_text' && !c.reviews.some((r) => r.status === 'submitted') && (
                              <Button type="link" size="small" onClick={async () => {
                                const v = await prompt({ title: '提交合同审核', fields: [{ name: 'note', label: '说明', multiline: true }] });
                                if (v) run.mutate(() => contractApi.submitReview(c.id, d.id, v.note || undefined));
                              }}>提交审核</Button>
                            )}
                            {can('contract:write') && !d.withdrawnAt && (
                              d.canWithdraw === false ? (
                                <Tooltip title="该文档已被审核、变更、结算或付款记录引用，禁止撤回">
                                  <Button type="link" size="small" danger disabled>
                                    撤回作废
                                  </Button>
                                </Tooltip>
                              ) : (
                                <Popconfirm
                                  title="确认撤回作废该未引用草稿附件？"
                                  okText="确认撤回"
                                  cancelText="取消"
                                  okButtonProps={{ danger: true }}
                                  onConfirm={() => run.mutate(() => contractApi.withdrawDocument(c.id, d.id, '草稿未引用文档撤回作废'))}
                                >
                                  <Button type="link" size="small" danger>
                                    撤回作废
                                  </Button>
                                </Popconfirm>
                              )
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
              key: 'countersigns',
              label: `多部门会签 ${c.countersigns?.filter((cs) => cs.status !== 'superseded').length ?? 0}`,
              children: <ContractCountersignTab contract={c} onChanged={(d) => refresh(d)} />,
            },
            ...(c.isProcurement !== false || c.procurementRecordId != null || c.procurementRecord != null
              ? [
                  {
                    key: 'procurement',
                    label: (
                      <Space size={4}>
                        <span>招采过程</span>
                        {(c.linkedProcurementContractCount ?? 0) > 1 && (
                          <Badge count={`共享${c.linkedProcurementContractCount}`} color="purple" />
                        )}
                      </Space>
                    ),
                    children: <ContractProcurementTab contract={c} onChanged={(d) => refresh(d)} />,
                  },
                ]
              : []),
            {
              key: 'changes',
              label: `变更与索赔 ${c.changes.length}`,
              children: <ContractChangeTab contract={c} onChanged={(d) => refresh(d)} />,
            },
            {
              key: 'settlement',
              label: (c.direction === 'income' ? '结算与收款 ' : '结算与付款 ') + ((c.settlements?.length ?? 0) + (c.direction === 'income' ? (c.receipts?.length ?? 0) : c.payments.length)),
              children: <ContractSettlementTab contract={c} onChanged={(d) => refresh(d)} />,
            },
            {
              key: 'safeguard',
              label: '担保 · 质保 · 纠纷 ' + ((c.guarantees?.length ?? 0) + (c.disputes?.length ?? 0) + (c.warranty ? 1 : 0)),
              children: <ContractSafeguardTab contract={c} onChanged={(d) => refresh(d)} />,
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
                      {e.detail && Object.keys(e.detail).length > 0 && (
                        <div style={{ marginTop: 4 }}>
                          <Space size={[4, 4]} wrap>
                            {Object.entries(e.detail)
                              .filter(([, val]) => val !== null && val !== undefined && val !== '')
                              .map(([k, val]) => (
                                <Tag key={k}>
                                  {k}: {typeof val === 'object' ? JSON.stringify(val) : String(val)}
                                </Tag>
                              ))}
                          </Space>
                        </div>
                      )}
                    </div>
                  ),
                }))} />
              ),
            },
          ]} />
        </Space>
      )}
      <Modal
        open={opModalKind !== null}
        title={
          opModalKind === 'distribution'
            ? '登记盖章件分发备案'
            : opModalKind === 'archive'
              ? '档案资料验收与移交'
              : '承办人动态交接'
        }
        onCancel={() => setOpModalKind(null)}
        destroyOnClose
        confirmLoading={run.isPending}
        onOk={() =>
          opForm.validateFields().then(async (v) => {
            if (!c || !opModalKind) return;
            if (opModalKind === 'distribution') {
              await run.mutateAsync(() => contractApi.updateDistribution(c.id, compact({ expectedVersion: c.version, ...v }) as never));
            } else if (opModalKind === 'archive') {
              await run.mutateAsync(() => contractApi.updateArchiveStatus(c.id, compact({ expectedVersion: c.version, ...v }) as never));
            } else {
              await run.mutateAsync(() => contractApi.handoverUndertaker(c.id, compact({ expectedVersion: c.version, ...v }) as never));
            }
            setOpModalKind(null);
          })
        }
      >
        <Form form={opForm} layout="vertical" preserve={false}>
          {opModalKind === 'distribution' && (
            <>
              <Form.Item name="distributedAt" label="分发日期" rules={[{ required: true, message: '请选择分发日期' }]} {...datePickerItemProps}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item name="companyFiledAt" label="报公司企管/结算备案日期（可空）" {...datePickerItemProps}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item name="note" label="备注">
                <Input maxLength={500} />
              </Form.Item>
            </>
          )}
          {opModalKind === 'archive' && (
            <>
              <Form.Item name="archiveStatus" label="归档状态" rules={[{ required: true }]}>
                <Select options={[{ value: 'checked', label: '完整性已核验' }, { value: 'transferred', label: '已移交档案室' }]} />
              </Form.Item>
              <Form.Item name="actionDate" label="核验 / 移交日期" {...datePickerItemProps}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item name="transferNo" label="档案移交单号（移交时填写）">
                <Input maxLength={100} />
              </Form.Item>
            </>
          )}
          {opModalKind === 'handover' && (
            <>
              <Form.Item name="toUndertaker" label="新承办人姓名" rules={[{ required: true, whitespace: true }]}>
                <Input maxLength={100} />
              </Form.Item>
              <Form.Item name="toDept" label="新承办部门">
                <Input maxLength={100} />
              </Form.Item>
              <Form.Item name="handoverDate" label="交接日期" rules={[{ required: true, message: '请选择交接日期' }]} {...datePickerItemProps}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item name="leftPostDate" label="原承办人调离日期（可空）" {...datePickerItemProps}>
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
              <Form.Item name="reason" label="交接说明">
                <Input.TextArea rows={2} maxLength={500} />
              </Form.Item>
            </>
          )}
        </Form>
      </Modal>
      {c && <ContractBaseFormModal open={editing} contract={c} onClose={() => setEditing(false)} onSaved={(d) => refresh(d)} />}
    </Drawer>
  );
}

export default function Contracts() {
  const navigate = useNavigate();
  const { params, setParams, page, pageSize, update } = useListSearchParams();
  const todo = (params.get('todo') ?? undefined) as ContractTodo | undefined;
  const status = (params.get('status') || undefined) as ContractStatus | undefined;
  const stage = (params.get('stage') || undefined) as ContractStage | undefined;
  const direction = (params.get('direction') || undefined) as ContractDirection | undefined;
  const pricingMode = (params.get('pricingMode') || undefined) as ContractPricingMode | undefined;
  const archiveStatus = (params.get('archiveStatus') || undefined) as ContractArchiveStatus | undefined;
  const legalCategory = (params.get('legalCategory') || undefined) as LegalCategory | undefined;
  const procurementMethod = (params.get('procurementMethod') || undefined) as ProcurementMethod | undefined;
  const signDateFrom = params.get('signDateFrom') || undefined;
  const signDateTo = params.get('signDateTo') || undefined;
  const migrationMode = (params.get('migrationMode') || undefined) as 'normal' | 'legacy_tolerant' | undefined;
  const projectId = positiveQueryNumber(params.get('projectId'));
  const planItemId = positiveQueryNumber(params.get('planItemId'));
  const sortBy = (params.get('sortBy') || undefined) as ContractSortField | undefined;
  const sortDir = (params.get('sortDir') || undefined) as ContractSortDir | undefined;
  const queueParam = params.get('queue') || 'all';
  const orgId = positiveQueryNumber(params.get('orgId'));
  const keyword = params.get('keyword')?.trim() || undefined;
  const [catalogOpen,setCatalogOpen]=useState(false);
  const [exportOpen, setExportOpen] = useState(false);
  const [creating, setCreating] = useState(false);
  const openId = params.get('id') ? Number(params.get('id')) : null;
  const setOpenId = (id: number | null) => setParams((p) => { const n = new URLSearchParams(p); if (id == null) n.delete('id'); else n.set('id', String(id)); return n; }, { replace: true });
  const todoValid = todo && todo in TODO_LABEL ? todo : undefined;
  const filterQuery: Partial<ContractListQuery> = compact({
    status,
    stage,
    direction,
    pricingMode,
    archiveStatus,
    legalCategory,
    procurementMethod,
    signDateFrom,
    signDateTo,
    migrationMode,
    orgId,
    projectId,
    planItemId,
    keyword,
    todo: todoValid,
  });
  const list = useQuery({
    queryKey: ['contracts', filterQuery, sortBy, sortDir, page, pageSize],
    queryFn: () => contractApi.listPage({ ...filterQuery, ...compact({ sortBy, sortDir }), page, pageSize }),
  });
  useEffect(() => { if (list.data && list.data.page !== page) update({ page: list.data.page }, false); }, [list.data?.page, page, update]);
  const summary = useQuery({
    queryKey: ['contract-summary', filterQuery],
    queryFn: () => contractApi.summary(filterQuery),
  });
  useAssistantDomainPage({ pageKey: 'contracts', ready: !list.isLoading && !list.error, scope: { orgScopeId: orgId, contractId: openId ?? undefined }, view: { status, keyword, todo, stage, direction, pricingMode, archiveStatus } });
  const s = summary.data;
  const sortOrderOf = (field: ContractSortField) =>
    sortBy === field ? (sortDir === 'asc' ? 'ascend' : sortDir === 'desc' ? 'descend' : null) : null;
  return (
    <div>
      {s && (
        <Card size="small" style={{ marginBottom: 12 }}>
          <Row gutter={[16, 8]}>
            <Col xs={12} md={4}><Typography.Text type="secondary" style={{ fontSize: 12 }}>合同数(不含作废)</Typography.Text><div className="kpi-value" style={{ fontSize: 20 }}>{s.count - s.byStatus.voided}</div></Col>
            <Col xs={12} md={5}><Typography.Text type="secondary" style={{ fontSize: 12 }}>支出合同额(人民币)</Typography.Text><div className="kpi-value" style={{ fontSize: 20 }}><Money value={s.currentAmount} /></div></Col>
            <Col xs={12} md={5}><Typography.Text type="secondary" style={{ fontSize: 12 }}>支出已付</Typography.Text><div className="kpi-value" style={{ fontSize: 20 }}><Money value={s.paidAmount} /></div></Col>
            <Col xs={12} md={4}><Typography.Text type="secondary" style={{ fontSize: 12 }}>付款比例</Typography.Text><div className="kpi-value" style={{ fontSize: 20 }}>{s.paymentRate == null ? '—' : <Ratio value={s.paymentRate} />}</div></Col>
            <Col xs={24} md={6}>
              <Typography.Text type="secondary" style={{ fontSize: 12 }}>待办</Typography.Text>
              <div><Space size={4} wrap>
                <Tag>审核 {s.pending.reviews}</Tag><Tag>变更 {s.pending.changes}</Tag><Tag>付款 {s.pending.payments}</Tag><Tag>待支付 {s.pending.unpaidApproved}</Tag>
              </Space></div>
            </Col>
            {(s.incomeCurrentAmount && s.incomeCurrentAmount !== '0.00') || (s.foreignCurrencyCount ?? 0) > 0 ? (
              <Col span={24}>
                <Space size={16} wrap>
                  {s.incomeCurrentAmount && s.incomeCurrentAmount !== '0.00' && <Typography.Text type="secondary">收入合同额(人民币)：<Money value={s.incomeCurrentAmount} /> · 已收：<Money value={s.receivedAmount ?? '0.00'} /> · 收款率：{s.receiptRate == null ? '—' : <Ratio value={s.receiptRate} />}</Typography.Text>}
                  {(s.foreignCurrencyCount ?? 0) > 0 && <Tag color="purple">外币合同 {s.foreignCurrencyCount} 份（已单列统计）</Tag>}
                </Space>
              </Col>
            ) : null}
          </Row>
        </Card>
      )}
      <ContractLegalCatalog open={catalogOpen} onClose={()=>setCatalogOpen(false)}/>
      <ContractExportModal open={exportOpen} onClose={() => setExportOpen(false)} />
      <div style={{ marginBottom: 8 }}>
        <Segmented<string>
          value={queueParam}
          onChange={(q) => {
            if (q === 'review') {
              update({ queue: 'review', todo: 'review', migrationMode: undefined, archiveStatus: undefined });
            } else if (q === 'legacy_fill') {
              update({ queue: 'legacy_fill', todo: undefined, migrationMode: 'legacy_tolerant', archiveStatus: 'collecting' });
            } else if (q === 'legacy_clue') {
              update({ queue: 'legacy_clue', todo: undefined, migrationMode: 'legacy_tolerant', archiveStatus: undefined });
            } else {
              update({ queue: undefined, todo: undefined, migrationMode: undefined, archiveStatus: undefined });
            }
          }}
          options={[
            { value: 'all', label: '全部合同' },
            { value: 'review', label: '待我会签·复核' },
            { value: 'legacy_fill', label: '待补录要素与盖章件' },
            { value: 'legacy_clue', label: '重号与凭证线索待核' },
          ]}
        />
      </div>
      <Space wrap style={{ marginBottom: 12 }}>
        <Button onClick={()=>setCatalogOpen(true)}>法审制度与范本</Button>
        <Button onClick={() => setExportOpen(true)}>报送导出 (月报 / 纪巡财审)</Button>
        {can('contract:import') && <Button onClick={() => navigate('/contracts/import')}>台账导入</Button>}
        <Select allowClear placeholder="状态" value={status} onChange={(v) => update({ status: v })} style={{ width: 110 }} options={Object.entries(CONTRACT_STATUS).map(([value, m]) => ({ value, label: m.text }))} />
        <Select allowClear placeholder="阶段" value={stage} onChange={(v) => update({ stage: v })} style={{ width: 120 }} options={CONTRACT_STAGE_ORDER.map((value) => ({ value, label: CONTRACT_STAGE_LABELS[value] }))} />
        <Select allowClear placeholder="收支方向" value={direction} onChange={(v) => update({ direction: v })} style={{ width: 110 }} options={Object.entries(DIRECTION_LABELS).map(([value, label]) => ({ value, label }))} />
        <Select allowClear placeholder="计价方式" value={pricingMode} onChange={(v) => update({ pricingMode: v })} style={{ width: 110 }} options={Object.entries(PRICING_MODE_LABELS).map(([value, label]) => ({ value, label }))} />
        <Select allowClear placeholder="归档状态" value={archiveStatus} onChange={(v) => update({ archiveStatus: v })} style={{ width: 130 }} options={Object.entries(ARCHIVE_STATUS_LABELS).map(([value, label]) => ({ value, label }))} />
        <Select
          aria-label="法审类别筛选"
          allowClear
          placeholder="法审类别"
          value={legalCategory}
          onChange={(v) => update({ legalCategory: v })}
          style={{ width: 135 }}
          options={LEGAL_CATEGORIES.map((value) => ({ value, label: LEGAL_LABELS[value] }))}
        />
        <Select
          aria-label="采购方式筛选"
          allowClear
          placeholder="采购方式"
          value={procurementMethod}
          onChange={(v) => update({ procurementMethod: v })}
          style={{ width: 135 }}
          options={PROCUREMENT_METHODS.map((value) => ({ value, label: METHOD_LABELS[value] }))}
        />
        <DatePicker.RangePicker
          value={signDateFrom && signDateTo ? [dayjs(signDateFrom), dayjs(signDateTo)] : null}
          placeholder={['签订起日', '签订止日']}
          style={{ width: 235 }}
          onChange={(dates) =>
            update({
              signDateFrom: dates?.[0] ? dates[0].format('YYYY-MM-DD') : undefined,
              signDateTo: dates?.[1] ? dates[1].format('YYYY-MM-DD') : undefined,
            })
          }
        />
        <Select
          aria-label="建档模式筛选"
          allowClear
          placeholder="建档来源"
          value={migrationMode}
          onChange={(v) => update({ migrationMode: v })}
          style={{ width: 125 }}
          options={[
            { value: 'normal', label: '正常建档' },
            { value: 'legacy_tolerant', label: '历史容缺' },
          ]}
        />
        <OrgSelect value={orgId} onChange={(v) => update({ orgId: v })} placeholder="全部授权组织" />
        <Input.Search key={keyword ?? ''} defaultValue={keyword} maxLength={100} allowClear placeholder="编号或名称" onSearch={(v) => update({ keyword: v.trim() || undefined })} style={{ width: 200 }} />
        {can('contract:write') && <Button type="primary" onClick={() => setCreating(true)}>新建合同</Button>}
      </Space>
      {todoValid && (
        <Alert type="info" showIcon style={{ marginBottom: 12 }} message={`只显示:${TODO_LABEL[todoValid]}`}
          action={<Button size="small" onClick={() => update({ todo: undefined })}>显示全部</Button>} />
      )}
      {list.error ? <QueryErrorResult title="合同加载失败" error={list.error} refetch={list.refetch} /> : (
        <Table<ContractDto>
          rowKey="id"
          size="small"
          loading={list.isFetching}
          dataSource={list.data?.items ?? []}
          onChange={(_pagination, _filters, sorter) => {
            const sObj = (Array.isArray(sorter) ? sorter[0] : sorter) as SorterResult<ContractDto>;
            const colKey = (sObj?.columnKey ?? sObj?.field) as ContractSortField | undefined;
            if (!sObj?.order || !colKey) {
              if (sortBy || sortDir) update({ sortBy: undefined, sortDir: undefined }, false);
              return;
            }
            const nextDir: ContractSortDir = sObj.order === 'ascend' ? 'asc' : 'desc';
            if (colKey !== sortBy || nextDir !== sortDir) {
              update({ sortBy: colKey, sortDir: nextDir }, false);
            }
          }}
          pagination={{
            current: list.data?.page ?? page, pageSize, total: list.data?.total ?? 0, showSizeChanger: true, pageSizeOptions: [10, 20, 50, 100],
            showTotal: (total) => `共 ${total} 条`, onChange: (p, size) => update({ page: size === pageSize ? p : 1, pageSize: size }, false),
          }}
          scroll={{ x: 1620 }}
          onRow={(r) => ({ onClick: () => setOpenId(r.id), style: { cursor: 'pointer' } })}
          summary={() => {
            const totals = list.data?.totals ?? [];
            if (totals.length === 0) return null;
            return (
              <Table.Summary fixed>
                {totals.map((t) => (
                  <Table.Summary.Row key={t.currency}>
                    <Table.Summary.Cell index={0} colSpan={8}>
                      <Typography.Text strong>
                        当前筛选合计（{t.currency} · {t.count} 份）
                      </Typography.Text>
                    </Table.Summary.Cell>
                    <Table.Summary.Cell index={8} align="right">
                      <Money value={t.originalTotal} />
                    </Table.Summary.Cell>
                    <Table.Summary.Cell index={9} align="right">
                      <Money value={t.currentTotal} />
                    </Table.Summary.Cell>
                    <Table.Summary.Cell index={10} align="right">
                      <Space direction="vertical" size={0}>
                        <span>付:<Money value={t.paidTotal} /></span>
                        {t.receivedTotal !== '0.00' && <span>收:<Money value={t.receivedTotal} /></span>}
                      </Space>
                    </Table.Summary.Cell>
                    <Table.Summary.Cell index={11} colSpan={4}>
                      <Typography.Text type="secondary" style={{ fontSize: 12 }}>
                        累计结算：<Money value={t.settledTotal} />（严禁跨币种直接相加）
                      </Typography.Text>
                    </Table.Summary.Cell>
                  </Table.Summary.Row>
                ))}
              </Table.Summary>
            );
          }}
          columns={[
            { title: '合同编号', key: 'contractNo', dataIndex: 'contractNo', width: 145, fixed: 'left', sorter: true, sortOrder: sortOrderOf('contractNo') },
            { title: '方向', dataIndex: 'direction', width: 72, render: (v?: ContractDirection) => (v === 'income' ? <Tag color="green">收入</Tag> : <Tag>支出</Tag>) },
            { title: '名称', dataIndex: 'name', ellipsis: true },
            { title: '组织', dataIndex: 'orgName', width: 120 },
            { title: '项目', dataIndex: 'projectName', width: 140, ellipsis: true, render: (v: string | null) => v ?? '—' },
            { title: '供应商', dataIndex: 'supplierName', width: 140, ellipsis: true, render: (v: string | null) => v ?? '—' },
            { title: '阶段', dataIndex: 'stage', width: 90, render: (v: string) => CONTRACT_STAGE_LABELS[v] },
            { title: '状态', dataIndex: 'status', width: 80, render: (v: string) => statusTag(CONTRACT_STATUS, v) },
            { title: '原始金额', key: 'originalAmount', dataIndex: 'originalAmount', width: 130, align: 'right', sorter: true, sortOrder: sortOrderOf('originalAmount'), render: (v: string) => <Money value={v} /> },
            { title: '当前金额', dataIndex: 'currentAmount', width: 140, align: 'right', render: (v: string, r) => <span><Money value={v} />{r.currency && r.currency !== '人民币' ? ' ' + r.currency : ''}{r.pricingMode === 'unit_price' && <Tag style={{ marginLeft: 4 }}>单价</Tag>}</span> },
            { title: '已付/已收', key: 'paidOrRec', width: 130, align: 'right', render: (_, r) => <Money value={r.direction === 'income' ? (r.receivedAmount ?? '0.00') : r.paidAmount} /> },
            { title: '执行比例', key: 'execRate', width: 90, align: 'right', render: (_, r) => { const rate = r.direction === 'income' ? r.receiptRate : r.paymentRate; return rate == null ? '—' : <Ratio value={rate} />; } },
            { title: '签订日期', key: 'signDate', dataIndex: 'signDate', width: 110, sorter: true, sortOrder: sortOrderOf('signDate'), render: (v: string | null) => v ?? '—' },
            { title: '更新时间', key: 'updatedAt', dataIndex: 'updatedAt', width: 115, sorter: true, sortOrder: sortOrderOf('updatedAt'), render: (v: string) => shortTime(v) },
            {
              title: '待办', key: 'todo', width: 150, render: (_, r) => (
                <Space size={2} wrap>
                  {r.pendingReviews > 0 && <Tag color="warning">审核 {r.pendingReviews}</Tag>}
                  {r.pendingChanges > 0 && <Tag color="warning">变更 {r.pendingChanges}</Tag>}
                  {r.openPayments > 0 && <Tag color="warning">付款 {r.openPayments}</Tag>}
                  {(r.openReceipts ?? 0) > 0 && <Tag color="warning">收款 {r.openReceipts}</Tag>}
                  {(r.pendingSettlements ?? 0) > 0 && <Tag color="warning">结算 {r.pendingSettlements}</Tag>}
                </Space>
              ),
            },
          ]} />
      )}
      <ContractBaseFormModal open={creating} onClose={() => setCreating(false)} onSaved={(c) => setOpenId(c.id)} />
      <ContractDrawer id={openId} onClose={() => setOpenId(null)} />
    </div>
  );
}
