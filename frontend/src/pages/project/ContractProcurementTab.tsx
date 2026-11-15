import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert, App as AntdApp, Button, Card, Checkbox, Col, DatePicker, Descriptions, Form,
  Input, InputNumber, Modal, Row, Segmented, Select, Space, Switch, Tag, Typography,
} from 'antd';
import dayjs from 'dayjs';
import { can, errorText } from '../../api/client';
import {
  contractApi,
  type ContractDetailDto,
  type DirectProcurementGround,
  type ProcurementRecordDto,
  type ProcurementRecordSaveRequest,
} from '../../api/projectContract';
import { compact, Money } from '../financeData/shared';
import {
  METHOD_LABELS,
  parseMoneyToCentsPreview,
  PROCUREMENT_METHODS,
  procurementTierPreview,
  TIER_LABELS,
} from './contractOptions';

const DIRECT_GROUND_OPTIONS: { value: DirectProcurementGround; label: string }[] = [
  { value: 'ground_1_state_secret', label: '情形1：涉及国家秘密或抢险救灾不适宜竞争' },
  { value: 'ground_2_sole_source_patent', label: '情形2：使用不可替代专利/专有技术只能从唯一供应商采购' },
  { value: 'ground_3_add_on_compatibility', label: '情形3：原采购后续添购须保证与既有设施服务配套一致' },
  { value: 'ground_4_emergency_rescue', label: '情形4：突发应急抢修保供时间紧迫无法履行竞争程序' },
  { value: 'ground_5_twice_tender_failed', label: '情形5：公开/邀请采购连续两次流标且采购文件无歧视条款' },
  { value: 'ground_6_group_strategic_mgm', label: '情形6：经集团经营层专题决策认定的特殊直接采购（必填决策文号）' },
  { value: 'ground_7_gov_designated_tariff', label: '情形7：水电气热讯等政府定价或特许专营垄断项目' },
  { value: 'ground_8_internal_subsidiary_cap', label: '情形8：符合内部关联协同规定且具备法定承接资质项目' },
];

const dateProps = {
  getValueProps: (v?: string | null) => ({ value: v ? dayjs(v) : null }),
  normalize: (d: dayjs.Dayjs | null) => (d ? d.format('YYYY-MM-DD') : null),
};

const nonNegMoneyRule = {
  validator: (_: unknown, v?: string) => {
    if (!v || !String(v).trim()) return Promise.resolve();
    const c = parseMoneyToCentsPreview(v);
    return c === null || c < 0n ? Promise.reject(new Error('请输入非负金额(最多2位小数)')) : Promise.resolve();
  },
};

function isReviewerQualifiedPreview(r?: {
  titleLevel?: string;
  midTitleYears?: number | null;
  hasRegQualification?: boolean;
}): boolean {
  if (!r) return false;
  if (r.hasRegQualification) return true;
  if (/高级|正高|副高|教授级/.test(r.titleLevel ?? '')) return true;
  if ((r.midTitleYears ?? 0) >= 8) return true;
  return false;
}

export function ContractProcurementTab({
  contract,
  onChanged,
}: {
  contract: ContractDetailDto;
  onChanged: (d?: ContractDetailDto) => void;
}) {
  const { message, modal } = AntdApp.useApp();
  const qc = useQueryClient();
  const writable = can('contract:write') && contract.status !== 'voided';

  const [mode, setMode] = useState<'edit' | 'link'>('edit');
  const [searchKeyword, setSearchKeyword] = useState('');
  const [selectedLinkId, setSelectedLinkId] = useState<number | null>(contract.procurementRecordId ?? null);
  const [form] = Form.useForm();

  const detailQ = useQuery({
    queryKey: ['contract-procurement', contract.id, contract.procurementRecordId],
    queryFn: () => contractApi.getProcurement(contract.id),
    initialData: contract.procurementRecord ?? null,
  });
  const record: ProcurementRecordDto | null = detailQ.data ?? contract.procurementRecord ?? null;

  const searchRecordsQ = useQuery({
    queryKey: ['procurement-records-search', contract.orgId, searchKeyword],
    queryFn: () => contractApi.listProcurementRecords({ orgId: contract.orgId, keyword: searchKeyword || undefined }),
    enabled: mode === 'link',
  });

  useEffect(() => {
    setSelectedLinkId(record?.id ?? contract.procurementRecordId ?? null);
    if (record) {
      form.setFieldsValue({
        procurementCode: record.procurementCode ?? '',
        procurementTitle: record.procurementTitle,
        procurementTarget: record.procurementTarget ?? contract.procurementTarget ?? 'service',
        procurementMethod: record.procurementMethod ?? contract.procurementMethod ?? 'public_tender',
        estimatedAmount: record.estimatedAmount ?? contract.originalAmount ?? '0.00',
        isLegallyMandatoryTender: record.isLegallyMandatoryTender,
        undertakerUnitType: record.undertakerUnitType ?? 'secondary_unit',
        approvalTier: record.approvalTier ?? '',
        approverName: record.approverName ?? '',
        twiceTenderFailed: record.twiceTenderFailed,
        mgmDecisionDoc: record.mgmDecisionDoc ?? '',
        tenderAgency: record.tenderAgency ?? '',
        planSubmittedAt: record.planSubmittedAt,
        announcementDate: record.announcementDate,
        prequalSaleStart: record.prequalSaleStart,
        prequalSaleEnd: record.prequalSaleEnd,
        docSaleStartDate: record.docSaleStartDate,
        clarificationSiteDate: record.clarificationSiteDate,
        bidOpenDate: record.bidOpenDate,
        evalReportSubmitDate: record.evalReportSubmitDate,
        evalReportReceiveDate: record.evalReportReceiveDate,
        candidatePublicityStart: record.candidatePublicityStart,
        candidatePublicityEnd: record.candidatePublicityEnd,
        awardNoticeDate: record.awardNoticeDate,
        invitedVendorCount: record.invitedVendorCount,
        supplierInPool: record.supplierInPool ?? true,
        directProcurementGrounds: record.directProcurementGrounds ?? [],
        candidateRanking: record.candidateRanking ?? [],
        comparisonQuotes: record.comparisonQuotes ?? [],
        protestFlag: record.protestFlag ?? false,
        protestDetail: record.protestDetail ?? '',
        protestResolvedAt: record.protestResolvedAt,
        reviewers: (record.reviewers ?? []).map((rv) => ({
          reviewerName: rv.reviewerName,
          identity: rv.identity,
          titleLevel: rv.titleLevel,
          midTitleYears: rv.midTitleYears,
          hasRegQualification: rv.hasRegQualification,
        })),
      });
    } else {
      form.setFieldsValue({
        procurementCode: '',
        procurementTitle: contract.name,
        procurementTarget: contract.procurementTarget ?? 'service',
        procurementMethod: contract.procurementMethod ?? 'public_tender',
        estimatedAmount: contract.originalAmount ?? '0.00',
        isLegallyMandatoryTender: false,
        undertakerUnitType: 'secondary_unit',
        twiceTenderFailed: false,
        supplierInPool: true,
        directProcurementGrounds: [],
        candidateRanking: [],
        comparisonQuotes: [],
        protestFlag: false,
        reviewers: [],
      });
    }
  }, [record, contract.id, contract.name, contract.originalAmount, contract.procurementMethod, contract.procurementRecordId, contract.procurementTarget, form]);

  const watched = (Form.useWatch([], form) ?? {}) as Record<string, any>;
  const methodWatch = watched.procurementMethod as string | undefined;
  const targetWatch = watched.procurementTarget as string | undefined;
  const estWatch = watched.estimatedAmount as string | undefined;
  const invitedCountWatch = watched.invitedVendorCount as number | null | undefined;
  const groundsWatch = (watched.directProcurementGrounds ?? []) as DirectProcurementGround[];
  const protestFlagWatch = Boolean(watched.protestFlag);
  const reviewersWatch = (watched.reviewers ?? []) as {
    reviewerName?: string;
    identity?: 'owner' | 'staff' | 'external';
    titleLevel?: string;
    midTitleYears?: number | null;
    hasRegQualification?: boolean;
  }[];

  const announcementDate = watched.announcementDate as string | null | undefined;
  const prequalStart = watched.prequalSaleStart as string | null | undefined;
  const prequalEnd = watched.prequalSaleEnd as string | null | undefined;
  const docSaleStart = watched.docSaleStartDate as string | null | undefined;
  const bidOpenDate = watched.bidOpenDate as string | null | undefined;
  const evalSubmitDate = watched.evalReportSubmitDate as string | null | undefined;
  const evalReceiveDate = watched.evalReportReceiveDate as string | null | undefined;
  const pubStart = watched.candidatePublicityStart as string | null | undefined;
  const pubEnd = watched.candidatePublicityEnd as string | null | undefined;
  const awardDate = watched.awardNoticeDate as string | null | undefined;

  const dateOrderWarnings = useMemo(() => {
    const list: string[] = [];
    const check = (earlier: string | null | undefined, later: string | null | undefined, msg: string) => {
      if (earlier && later && later < earlier) list.push(msg);
    };
    check(prequalStart, prequalEnd, '资格预审文件发售截止日早于发售起始日');
    check(announcementDate, docSaleStart, '招标文件发售起始日早于招标公告发布日');
    check(announcementDate, bidOpenDate, '开标/投标截止日期早于招标公告发布日期');
    check(docSaleStart, bidOpenDate, '开标/投标截止日期早于采购文件发售起始日');
    check(bidOpenDate, evalSubmitDate, '提交评标报告日期早于开标日期');
    check(evalSubmitDate, evalReceiveDate, '收到评标报告日期早于提交评标报告日期');
    check(evalSubmitDate, pubStart, '中标候选人公示起始日早于提交评标报告日期');
    check(pubStart, pubEnd, '中标候选人公示截止日早于公示起始日');
    check(pubStart, awardDate, '中标通知书发出日期早于中标候选人公示起始日');
    return list;
  }, [announcementDate, prequalStart, prequalEnd, docSaleStart, bidOpenDate, evalSubmitDate, evalReceiveDate, pubStart, pubEnd, awardDate]);

  const vendorCountWarning = useMemo(() => {
    if (invitedCountWatch == null) return null;
    if (methodWatch === 'invited_tender' && invitedCountWatch < 3) return '邀请招标邀请供应商不足 3 家（PW-08）';
    if (methodWatch === 'negotiation' && invitedCountWatch < 2) return '竞争性谈判有效供应商不足 2 家';
    if (methodWatch === 'inquiry' && invitedCountWatch < 3) return '询比采购有效报价供应商不足 3 家（PW-09）';
    if (methodWatch === 'bidding' && invitedCountWatch < 3) return '竞价采购参与供应商不足 3 家';
    return null;
  }, [methodWatch, invitedCountWatch]);

  const isTenderMethod = methodWatch === 'public_tender' || methodWatch === 'invited_tender';
  const derivedTier = useMemo(() => {
    const cents = parseMoneyToCentsPreview(estWatch ?? '0') ?? 0n;
    return procurementTierPreview(true, targetWatch ?? null, cents >= 0n ? cents : 0n, methodWatch ?? null);
  }, [targetWatch, estWatch, methodWatch]);

  const committeeSize = reviewersWatch.length;
  const committeeQualifiedCount = reviewersWatch.filter((r) => isReviewerQualifiedPreview(r)).length;
  const linkedCount = record?.linkedContractCount ?? contract.linkedProcurementContractCount ?? 0;

  const saveMut = useMutation({
    mutationFn: (payload: ProcurementRecordSaveRequest | { linkProcurementRecordId: number | null }) =>
      contractApi.saveProcurement(contract.id, payload),
    onSuccess: () => {
      message.success('招采全过程记录已保存');
      void detailQ.refetch();
      void qc.invalidateQueries({ queryKey: ['procurement-records-search'] });
      onChanged();
    },
    onError: (e) => message.error(errorText(e)),
  });

  const handleSubmitForm = async () => {
    let v: Record<string, any>;
    try {
      v = await form.validateFields();
    } catch {
      return;
    }
    const payload: ProcurementRecordSaveRequest = {
      procurementCode: v.procurementCode?.trim() || undefined,
      procurementTitle: String(v.procurementTitle ?? '').trim(),
      projectId: contract.projectId,
      orgId: record?.orgId ?? contract.orgId,
      procurementTarget: v.procurementTarget,
      procurementMethod: v.procurementMethod,
      estimatedAmount: v.estimatedAmount?.trim() || null,
      isLegallyMandatoryTender: Boolean(v.isLegallyMandatoryTender),
      undertakerUnitType: v.undertakerUnitType ?? null,
      approvalTier: v.approvalTier?.trim() || undefined,
      approverName: v.approverName?.trim() || undefined,
      twiceTenderFailed: Boolean(v.twiceTenderFailed),
      mgmDecisionDoc: v.mgmDecisionDoc?.trim() || undefined,
      tenderAgency: v.tenderAgency?.trim() || undefined,
      planSubmittedAt: v.planSubmittedAt ?? null,
      announcementDate: v.announcementDate ?? null,
      prequalSaleStart: v.prequalSaleStart ?? null,
      prequalSaleEnd: v.prequalSaleEnd ?? null,
      docSaleStartDate: v.docSaleStartDate ?? null,
      clarificationSiteDate: v.clarificationSiteDate ?? null,
      bidOpenDate: v.bidOpenDate ?? null,
      evalReportSubmitDate: v.evalReportSubmitDate ?? null,
      evalReportReceiveDate: v.evalReportReceiveDate ?? null,
      candidatePublicityStart: v.candidatePublicityStart ?? null,
      candidatePublicityEnd: v.candidatePublicityEnd ?? null,
      awardNoticeDate: v.awardNoticeDate ?? null,
      invitedVendorCount: v.invitedVendorCount ?? null,
      supplierInPool: v.supplierInPool ?? null,
      directProcurementGrounds: v.procurementMethod === 'direct' ? (v.directProcurementGrounds ?? []) : [],
      candidateRanking: (v.candidateRanking ?? []).map((c: { rank?: number; vendorName?: string; bidAmount?: string }, idx: number) => ({
        rank: Number(c.rank ?? idx + 1),
        vendorName: String(c.vendorName ?? '').trim(),
        bidAmount: String(c.bidAmount ?? '0.00').trim(),
      })),
      comparisonQuotes: (v.comparisonQuotes ?? []).map((q: { vendorName?: string; quoteAmount?: string; selected?: boolean }) => ({
        vendorName: String(q.vendorName ?? '').trim(),
        quoteAmount: String(q.quoteAmount ?? '0.00').trim(),
        selected: Boolean(q.selected),
      })),
      protestFlag: Boolean(v.protestFlag),
      protestDetail: v.protestFlag ? String(v.protestDetail ?? '').trim() : '',
      protestResolvedAt: v.protestFlag ? (v.protestResolvedAt ?? null) : null,
      reviewers: (v.reviewers ?? []).map((rv: {
        reviewerName?: string;
        identity?: 'owner' | 'staff' | 'external';
        titleLevel?: string;
        midTitleYears?: number | null;
        hasRegQualification?: boolean;
      }) => compact({
        reviewerName: String(rv.reviewerName ?? '').trim(),
        identity: rv.identity ?? 'external',
        titleLevel: rv.titleLevel?.trim() || undefined,
        midTitleYears: rv.midTitleYears ?? null,
        hasRegQualification: Boolean(rv.hasRegQualification),
      })) as ProcurementRecordSaveRequest['reviewers'],
    };

    if (linkedCount > 1) {
      modal.confirm({
        title: '多合同共享招采记录更新确认',
        content: `当前招采记录被 ${linkedCount} 份合同共享，保存后将同步更新关联合同摘要并重新校验相关法审/会签状态（若不含跨单位编辑权限将被服务端拒绝）。`,
        okText: '确认共享更新',
        onOk: () => saveMut.mutateAsync({ ...payload, updateShared: true }),
      });
      return;
    }
    await saveMut.mutateAsync(payload);
  };

  return (
    <Space direction="vertical" style={{ width: '100%' }} size={12}>
      <Space wrap style={{ justifyContent: 'space-between', width: '100%' }}>
        <Segmented<'edit' | 'link'>
          value={mode}
          onChange={setMode}
          options={[
            { value: 'edit', label: '新建 / 维护招采全过程台账' },
            { value: 'link', label: '关联已有招采项目 (1:N 共享)' },
          ]}
        />
        <Space size={6} wrap>
          {linkedCount > 0 && (
            <Tag color={linkedCount > 1 ? 'purple' : 'blue'}>
              共享挂接合同：{linkedCount} 份
            </Tag>
          )}
          {record?.linkedContracts?.map((lc, idx) =>
            lc.redacted ? (
              <Tag key={`redacted-${idx}`}>跨单位关联合同(范围外已脱敏)</Tag>
            ) : (
              <Tag key={lc.id} color="cyan">
                {lc.contractNo} · {lc.name}
              </Tag>
            ),
          )}
        </Space>
      </Space>

      {mode === 'link' ? (
        <Card size="small" title="关联已有招采项目（支持一标多签 / 年度框架协议多合同共享同一招采档案）">
          <Space wrap style={{ width: '100%' }}>
            <Select
              aria-label="搜索既有招采项目"
              showSearch
              allowClear
              filterOption={false}
              onSearch={setSearchKeyword}
              loading={searchRecordsQ.isFetching}
              placeholder="按采购项目编号或名称搜索既有招采记录"
              style={{ width: 460 }}
              value={selectedLinkId ?? undefined}
              onChange={(v) => setSelectedLinkId(v ?? null)}
              options={(searchRecordsQ.data ?? []).map((r) => ({
                value: r.id,
                label: `${r.procurementCode ? `[${r.procurementCode}] ` : ''}${r.procurementTitle}（已挂接 ${r.linkedContractCount} 份合同）`,
              }))}
            />
            {writable && (
              <Button
                type="primary"
                loading={saveMut.isPending}
                disabled={selectedLinkId == null}
                onClick={() => saveMut.mutate({ linkProcurementRecordId: selectedLinkId })}
              >
                确认挂接所选招采项目
              </Button>
            )}
            {writable && record && (
              <Button
                danger
                loading={saveMut.isPending}
                onClick={() => saveMut.mutate({ linkProcurementRecordId: null })}
              >
                解除招采挂接
              </Button>
            )}
          </Space>
        </Card>
      ) : (
        <Form form={form} layout="vertical" disabled={!writable}>
          {isTenderMethod && (
            <Alert
              type="info"
              showIcon
              style={{ marginBottom: 12 }}
              message="依 20号文附件1 招标采购项目一律按一级管理（服务端强制锁定 procurementTier = tier_1）"
            />
          )}
          {dateOrderWarnings.length > 0 && (
            <Alert
              type="error"
              showIcon
              style={{ marginBottom: 12 }}
              message={`采购过程节点时间倒置告警（${dateOrderWarnings.length} 项）：${dateOrderWarnings.join('；')}`}
            />
          )}
          {vendorCountWarning && (
            <Alert type="warning" showIcon style={{ marginBottom: 12 }} message={`有效供应商数量合规预警：${vendorCountWarning}`} />
          )}
          {(record?.warnings?.length ?? 0) > 0 && (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 12 }}
              message={`招采合规检核提示：${record!.warnings.join('；')}`}
            />
          )}

          <Card size="small" title="一、项目定级、审批与代理信息（采购分级与评委合格数由服务端权威重算）" style={{ marginBottom: 12 }}>
            <Descriptions size="small" bordered column={3} style={{ marginBottom: 12 }}>
              <Descriptions.Item label="权威采购分级(只读)">
                <Tag color="blue">{derivedTier ? TIER_LABELS[derivedTier] : (record?.procurementTier ? TIER_LABELS[record.procurementTier] : '待定')}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="评标/评审委员会总人数(只读)">
                <Space size={4}>
                  <span>{record ? `${committeeSize} 人` : `${committeeSize} 人`}</span>
                  {committeeSize > 0 && committeeSize % 2 === 0 && <Tag color="error">须为奇数</Tag>}
                  {isTenderMethod && committeeSize > 0 && committeeSize < 5 && <Tag color="error">招标须≥5人</Tag>}
                </Space>
              </Descriptions.Item>
              <Descriptions.Item label="符合资深资格评委数(只读)">
                <Space size={4}>
                  <span>{committeeQualifiedCount} 人</span>
                  {committeeSize > 0 && committeeQualifiedCount * 3 < committeeSize * 2 && (
                    <Tag color="warning">资质评委未达 2/3</Tag>
                  )}
                </Space>
              </Descriptions.Item>
            </Descriptions>

            <Row gutter={12}>
              <Col span={8}><Form.Item name="procurementCode" label="采购项目编号"><Input maxLength={64} /></Form.Item></Col>
              <Col span={10}><Form.Item name="procurementTitle" label="采购项目名称" rules={[{ required: true, whitespace: true }]}><Input maxLength={200} /></Form.Item></Col>
              <Col span={6}><Form.Item name="estimatedAmount" label="采购预算/概算(元)" rules={[nonNegMoneyRule]}><Input /></Form.Item></Col>
              <Col span={6}>
                <Form.Item name="procurementTarget" label="采购标的" rules={[{ required: true }]}>
                  <Select options={[{ value: 'goods', label: '货物' }, { value: 'construction', label: '工程施工' }, { value: 'service', label: '服务' }]} />
                </Form.Item>
              </Col>
              <Col span={6}>
                <Form.Item name="procurementMethod" label="采购方式" rules={[{ required: true }]}>
                  <Select options={PROCUREMENT_METHODS.map((m) => ({ value: m, label: METHOD_LABELS[m] }))} />
                </Form.Item>
              </Col>
              <Col span={6}>
                <Form.Item name="undertakerUnitType" label="承办主体类型">
                  <Select allowClear options={[{ value: 'dept_center', label: '本部部门/直属中心' }, { value: 'secondary_unit', label: '二级法人单位' }]} />
                </Form.Item>
              </Col>
              <Col span={6}><Form.Item name="planSubmittedAt" label="采购计划报送日期" {...dateProps}><DatePicker style={{ width: '100%' }} /></Form.Item></Col>
              <Col span={6}><Form.Item name="approvalTier" label="方案审批层级"><Input maxLength={64} /></Form.Item></Col>
              <Col span={6}><Form.Item name="approverName" label="定标/方案审批人"><Input maxLength={100} /></Form.Item></Col>
              <Col span={6}><Form.Item name="tenderAgency" label="招标代理机构"><Input maxLength={200} /></Form.Item></Col>
              <Col span={6}>
                <Form.Item
                  name="mgmDecisionDoc"
                  label="经营层/总办会决策文号"
                  rules={
                    methodWatch === 'direct' && groundsWatch.includes('ground_6_group_strategic_mgm')
                      ? [{ required: true, whitespace: true, message: '选择直接采购情形6时必须填写经营层决策文号' }]
                      : []
                  }
                >
                  <Input maxLength={120} />
                </Form.Item>
              </Col>
              <Col span={8}><Form.Item name="isLegallyMandatoryTender" valuePropName="checked"><Checkbox>属于依法必须招标项目</Checkbox></Form.Item></Col>
              <Col span={8}><Form.Item name="twiceTenderFailed" valuePropName="checked"><Checkbox>公开/邀请连续两次招标失败</Checkbox></Form.Item></Col>
              <Col span={8}><Form.Item name="supplierInPool" label="成交供应商属合格库内" valuePropName="checked"><Switch /></Form.Item></Col>
            </Row>
          </Card>

          <Card size="small" title="二、10+ 关键招采时间节点（自动比对前后时序）" style={{ marginBottom: 12 }}>
            <Row gutter={12}>
              <Col span={6}><Form.Item name="announcementDate" label="招标/采购公告发布日" {...dateProps}><DatePicker style={{ width: '100%' }} /></Form.Item></Col>
              <Col span={6}><Form.Item name="prequalSaleStart" label="资格预审文件发售起" {...dateProps}><DatePicker style={{ width: '100%' }} /></Form.Item></Col>
              <Col span={6}><Form.Item name="prequalSaleEnd" label="资格预审文件发售止" {...dateProps}><DatePicker style={{ width: '100%' }} /></Form.Item></Col>
              <Col span={6}><Form.Item name="docSaleStartDate" label="招标文件发售起始日" {...dateProps}><DatePicker style={{ width: '100%' }} /></Form.Item></Col>
              <Col span={6}><Form.Item name="clarificationSiteDate" label="澄清及现场踏勘日" {...dateProps}><DatePicker style={{ width: '100%' }} /></Form.Item></Col>
              <Col span={6}><Form.Item name="bidOpenDate" label="开标/投标截止日期" {...dateProps}><DatePicker style={{ width: '100%' }} /></Form.Item></Col>
              <Col span={6}><Form.Item name="evalReportSubmitDate" label="提交评标报告日期" {...dateProps}><DatePicker style={{ width: '100%' }} /></Form.Item></Col>
              <Col span={6}><Form.Item name="evalReportReceiveDate" label="收到评标报告日期" {...dateProps}><DatePicker style={{ width: '100%' }} /></Form.Item></Col>
              <Col span={6}><Form.Item name="candidatePublicityStart" label="中标候选人公示起" {...dateProps}><DatePicker style={{ width: '100%' }} /></Form.Item></Col>
              <Col span={6}><Form.Item name="candidatePublicityEnd" label="中标候选人公示止" {...dateProps}><DatePicker style={{ width: '100%' }} /></Form.Item></Col>
              <Col span={6}><Form.Item name="awardNoticeDate" label="中标通知书发出日" {...dateProps}><DatePicker style={{ width: '100%' }} /></Form.Item></Col>
              <Col span={6}><Form.Item name="invitedVendorCount" label="邀请/有效报价家数"><InputNumber min={0} max={500} style={{ width: '100%' }} /></Form.Item></Col>
            </Row>
          </Card>

          {methodWatch === 'direct' && (
            <Card size="small" title="三、直接采购法定适用情形（§8.1.6 八种情形，至少选 1 项）" style={{ marginBottom: 12 }}>
              <Form.Item
                name="directProcurementGrounds"
                label="直接采购法定情形"
                rules={[{ required: true, type: 'array', min: 1, message: '直接采购必须至少勾选 1 项 §8.1.6 法定情形' }]}
              >
                <Checkbox.Group options={DIRECT_GROUND_OPTIONS} style={{ display: 'flex', flexDirection: 'column', gap: 6 }} />
              </Form.Item>
            </Card>
          )}

          {methodWatch === 'direct_reimburse' && (
            <Alert
              type="warning"
              showIcon
              style={{ marginBottom: 12 }}
              message="小额直接报账（≤30,000.00元）合规要求（§8.1.7）"
              description="3万元（含）以内内容单一、无后续服务直接报账项目不适用 §8.1.6 直接采购情形审批，但必须开展市场比价并上传《书面市场比价报告》作为报账依据，严禁同组织短期连续拆单规避 3万元限额。"
            />
          )}

          <Card size="small" title="四、评审委员会评委明细（ct_procurement_reviewer）" style={{ marginBottom: 12 }}>
            <Form.List name="reviewers">
              {(fields, { add, remove }) => (
                <Space direction="vertical" style={{ width: '100%' }} size={8}>
                  {fields.map((field, index) => {
                    const { key, ...restField } = field;
                    const cur = reviewersWatch[index];
                    const qualified = isReviewerQualifiedPreview(cur);
                    return (
                      <Row key={key} gutter={8} align="middle">
                        <Col span={5}>
                          <Form.Item {...restField} name={[restField.name, 'reviewerName']} label="评委姓名" rules={[{ required: true, whitespace: true }]}>
                            <Input maxLength={60} />
                          </Form.Item>
                        </Col>
                        <Col span={4}>
                          <Form.Item {...restField} name={[restField.name, 'identity']} label="身份类别" rules={[{ required: true }]}>
                            <Select options={[{ value: 'owner', label: '采购人代表' }, { value: 'staff', label: '内部专家' }, { value: 'external', label: '外部专家' }]} />
                          </Form.Item>
                        </Col>
                        <Col span={5}>
                          <Form.Item {...restField} name={[restField.name, 'titleLevel']} label="职称等级">
                            <Input placeholder="如 高级工程师 / 中级" maxLength={60} />
                          </Form.Item>
                        </Col>
                        <Col span={3}>
                          <Form.Item {...restField} name={[restField.name, 'midTitleYears']} label="中级满年">
                            <InputNumber min={0} max={60} style={{ width: '100%' }} />
                          </Form.Item>
                        </Col>
                        <Col span={3}>
                          <Form.Item {...restField} name={[restField.name, 'hasRegQualification']} label="执业资格" valuePropName="checked">
                            <Switch size="small" />
                          </Form.Item>
                        </Col>
                        <Col span={3}>
                          <Tag color={qualified ? 'success' : 'default'}>{qualified ? '资深合格' : '一般评委'}</Tag>
                        </Col>
                        <Col span={1}>
                          {writable && <Button size="small" danger type="link" onClick={() => remove(field.name)}>删</Button>}
                        </Col>
                      </Row>
                    );
                  })}
                  {writable && (
                    <Button type="dashed" onClick={() => add({ reviewerName: '', identity: 'external', titleLevel: '高级工程师', midTitleYears: 8, hasRegQualification: false })}>
                      + 添加评委记录
                    </Button>
                  )}
                </Space>
              )}
            </Form.List>
          </Card>

          <Row gutter={12} style={{ marginBottom: 12 }}>
            <Col span={12}>
              <Card size="small" title="五、中标候选人排名">
                <Form.List name="candidateRanking">
                  {(fields, { add, remove }) => (
                    <Space direction="vertical" style={{ width: '100%' }} size={6}>
                      {fields.map((field, idx) => {
                        const { key, ...restField } = field;
                        return (
                        <Row key={key} gutter={6} align="middle">
                          <Col span={4}><Form.Item {...restField} name={[restField.name, 'rank']} label="排名"><InputNumber min={1} max={20} style={{ width: '100%' }} /></Form.Item></Col>
                          <Col span={11}><Form.Item {...restField} name={[restField.name, 'vendorName']} label="候选单位" rules={[{ required: true }]}><Input /></Form.Item></Col>
                          <Col span={7}><Form.Item {...restField} name={[restField.name, 'bidAmount']} label="投标额(元)" rules={[nonNegMoneyRule]}><Input /></Form.Item></Col>
                          <Col span={2}>{writable && <Button size="small" danger type="link" onClick={() => remove(restField.name)}>删</Button>}</Col>
                          {idx < 0 && <Money value="0.00" />}
                        </Row>
                        );
                      })}
                      {writable && <Button size="small" type="dashed" onClick={() => add({ rank: fields.length + 1, vendorName: '', bidAmount: '0.00' })}>+ 添加候选人</Button>}
                    </Space>
                  )}
                </Form.List>
              </Card>
            </Col>
            <Col span={12}>
              <Card size="small" title="六、市场比价报价明细">
                <Form.List name="comparisonQuotes">
                  {(fields, { add, remove }) => (
                    <Space direction="vertical" style={{ width: '100%' }} size={6}>
                      {fields.map((field) => {
                        const { key, ...restField } = field;
                        return (
                        <Row key={key} gutter={6} align="middle">
                          <Col span={11}><Form.Item {...restField} name={[restField.name, 'vendorName']} label="报价单位" rules={[{ required: true }]}><Input /></Form.Item></Col>
                          <Col span={7}><Form.Item {...restField} name={[restField.name, 'quoteAmount']} label="报价(元)" rules={[nonNegMoneyRule]}><Input /></Form.Item></Col>
                          <Col span={4}><Form.Item {...restField} name={[restField.name, 'selected']} label="中选" valuePropName="checked"><Switch size="small" /></Form.Item></Col>
                          <Col span={2}>{writable && <Button size="small" danger type="link" onClick={() => remove(restField.name)}>删</Button>}</Col>
                        </Row>
                        );
                      })}
                      {writable && <Button size="small" type="dashed" onClick={() => add({ vendorName: '', quoteAmount: '0.00', selected: false })}>+ 添加比价单位</Button>}
                    </Space>
                  )}
                </Form.List>
              </Card>
            </Col>
          </Row>

          <Card size="small" title="七、质疑、澄清、投诉及举报处置记录（同步输出至月报 05_招标项目清查表）" style={{ marginBottom: 12 }}>
            <Row gutter={12}>
              <Col span={8}>
                <Form.Item name="protestFlag" label="是否存在质疑/澄清/投诉/举报" valuePropName="checked">
                  <Switch />
                </Form.Item>
              </Col>
              {protestFlagWatch && (
                <>
                  <Col span={8}>
                    <Form.Item name="protestResolvedAt" label="异议/投诉办结日期" {...dateProps}>
                      <DatePicker style={{ width: '100%' }} />
                    </Form.Item>
                  </Col>
                  <Col span={24}>
                    <Form.Item
                      name="protestDetail"
                      label="质疑/投诉事项及核查处置结论详述（必填）"
                      rules={[{ required: true, whitespace: true, message: '存在质疑或投诉时必须填写详述与处置情况' }]}
                    >
                      <Input.TextArea rows={2} maxLength={1000} />
                    </Form.Item>
                  </Col>
                </>
              )}
            </Row>
          </Card>

          {writable && (
            <Space>
              <Button type="primary" loading={saveMut.isPending} onClick={() => void handleSubmitForm()}>
                保存招采过程记录
              </Button>
            </Space>
          )}
        </Form>
      )}
    </Space>
  );
}
