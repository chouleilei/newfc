import { useMutation, useQuery } from '@tanstack/react-query';
import { useEffect } from 'react';
import { Alert, App as AntdApp, Button, Checkbox, Col, Collapse, DatePicker, Form, Input, InputNumber, Modal, Row, Select, Space, Tag } from 'antd';
import dayjs from 'dayjs';
import { api, errorText } from '../../api/client';
import { contractApi, planApi, type ContractDetailDto } from '../../api/projectContract';
import { compact, defaultOrgId, OrgSelect } from '../financeData/shared';
import {
  ACQUISITION_METHOD_LABELS, BUDGET_TYPE_LABELS, CONTRACT_CURRENCIES, DECISION_METHOD_LABELS,
  DIRECTION_LABELS, FUNDING_SOURCE_LABELS, LEGAL_CATEGORIES, LEGAL_LABELS, MEETING_TYPE_LABELS,
  METHOD_LABELS, PARTY_ROLES, PRICING_MODE_LABELS, PROCUREMENT_METHODS, REPORT_CATEGORY_LABELS,
  ROLE_LABELS, TENDER_BODY_LABELS, TERM_TYPE_LABELS, TIER_LABELS, parseMoneyToCentsPreview, procurementTierPreview,
} from './contractOptions';
import { CONTRACT_STAGE_ORDER } from './shared';

interface MasterOption { id: number; code: string | null; name: string }
function useMasterOptions(kind: 'projects' | 'suppliers', enabled: boolean) {
  const q = useQuery({ queryKey: ['master-options', kind], queryFn: () => api.get<MasterOption[]>('/master/' + kind), enabled, staleTime: 60_000 });
  return { loading: q.isLoading, options: (q.data ?? []).map((m) => ({ value: m.id, label: m.name + (m.code ? '(' + m.code + ')' : '') })) };
}

const dateField = (label: string, name: string) => (
  <Form.Item name={name} label={label} getValueProps={(v?: string) => ({ value: v ? dayjs(v) : null })} normalize={(d: dayjs.Dayjs | null) => (d ? d.format('YYYY-MM-DD') : null)}>
    <DatePicker style={{ width: '100%' }} />
  </Form.Item>
);
const moneyRule = { pattern: /^-?\d{1,13}(\.\d{1,2})?$/, message: '金额最多 2 位小数' };
const requiredNonNegMoneyRule = { pattern: /^\d{1,13}(\.\d{1,2})?$/, message: '正常合同金额须为非负数(最多 2 位小数，单价合同可填 0.00)' };
const nonNegMoneyRule = { pattern: /^(\d{1,13}(\.\d{1,2})?)?$/, message: '须为非负金额(最多 2 位小数)' };
const ratioRule = { pattern: /^(0(\.\d{1,6})?|1(\.0{1,6})?)?$/, message: '0～1 的小数(最多 6 位)' };

export function ContractBaseFormModal({ open, contract, onClose, onSaved }: { open: boolean; contract?: ContractDetailDto; onClose: () => void; onSaved: (c: ContractDetailDto) => void }) {
  const { message } = AntdApp.useApp();
  const [form] = Form.useForm();
  const projects = useMasterOptions('projects', open);
  const suppliers = useMasterOptions('suppliers', open);
  const incomeContracts = useQuery({
    queryKey: ['contracts', 'income-options'],
    queryFn: () => contractApi.list({ direction: 'income' }),
    enabled: open,
    staleTime: 60_000,
  });

  const legalType = contract?.legalReviewEnabled ?? false;
  const isLegacyTolerant = contract?.migrationMode === 'legacy_tolerant';
  const amountLocked = !!contract && (
    CONTRACT_STAGE_ORDER.indexOf(contract.stage) > CONTRACT_STAGE_ORDER.indexOf('approval') ||
    (contract.stage === 'approval' && (!legalType || contract.documents.some((d) => d.docType === 'signed') ||
      (contract.reviews.some((r) => r.status === 'approved') && !contract.blockers.some((b) => b.code === 'LEGAL_REVIEW_OUTDATED' || b.code === 'REVIEW_OUTDATED'))))
  );

  const orgIdWatch = Form.useWatch('orgId', form) as number | undefined;
  const signingSubjectOrgId = Form.useWatch('signingSubjectOrgId', form) as number | undefined;
  const signingEntityLevel = (Form.useWatch('signingEntityLevel', form) ?? 'company') as 'company' | 'secondary_unit';
  const contractTypeWatch = Form.useWatch('contractType', form) as string | undefined;
  const legalCategoryWatch = Form.useWatch('legalCategory', form) as string | undefined;
  const direction = Form.useWatch('direction', form) ?? 'expense';
  const pricingMode = Form.useWatch('pricingMode', form) ?? 'lump_sum';
  const currency = Form.useWatch('currency', form) ?? '人民币';
  const fundingSource = Form.useWatch('fundingSource', form) ?? 'self_owned_other';
  const isEmergency = Form.useWatch('isEmergency', form);
  const procurement = Form.useWatch('isProcurement', form);
  const target = Form.useWatch('procurementTarget', form);
  const method = Form.useWatch('procurementMethod', form);
  const amount = Form.useWatch('originalAmount', form);
  const ceilingAmount = Form.useWatch('estimatedCeilingAmount', form);
  const decisionMethod = Form.useWatch('decisionMethod', form);
  const meetingType = Form.useWatch('meetingType', form);
  const acquisitionMethod = Form.useWatch('acquisitionMethod', form);
  const tenderBodyType = Form.useWatch('tenderBodyType', form);
  const termType = Form.useWatch('termType', form) ?? 'unspecified';
  const hasWarranty = Form.useWatch('hasWarranty', form);

  const nextNoPreview = useQuery({
    queryKey: ['contract-next-no', orgIdWatch, signingSubjectOrgId, signingEntityLevel, contractTypeWatch, legalCategoryWatch, direction],
    queryFn: () =>
      contractApi.suggestNextNo({
        orgId: orgIdWatch!,
        signingSubjectOrgId,
        signingEntityLevel,
        category: contractTypeWatch,
        legalCategory: legalCategoryWatch,
        direction,
      }),
    enabled: open && !contract && !!orgIdWatch,
    staleTime: 10_000,
  });

  // 直属电站资金进项合同强制锁定公司名义签订（制度 17.1）
  useEffect(() => {
    if (!contract && nextNoPreview.data?.isDirectStation && direction === 'income' && signingEntityLevel !== 'company') {
      form.setFieldValue('signingEntityLevel', 'company');
    }
  }, [contract, nextNoPreview.data?.isDirectStation, direction, signingEntityLevel, form]);

  const currentYear = Number((contract?.signDate ?? dayjs().format('YYYY-MM-DD')).slice(0, 4));
  const planItemsQ = useQuery({
    queryKey: ['contract-plan-items', currentYear, orgIdWatch],
    queryFn: async () => {
      const batches = await planApi.batches({ year: currentYear, status: 'imported' });
      const activeBatch = batches.find((b) => b.isCurrent) ?? batches[0];
      if (!activeBatch) return [];
      const items = await planApi.items(activeBatch.id);
      return items.filter((it) => !orgIdWatch || !it.orgId || it.orgId === orgIdWatch || it.undertakeOrgId === orgIdWatch);
    },
    enabled: open && !!orgIdWatch,
    staleTime: 30_000,
  });

  const fillSuggestedNo = async () => {
    if (!orgIdWatch) {
      message.warning('请先选择承办组织');
      return;
    }
    try {
      const res = await contractApi.suggestNextNo({
        orgId: orgIdWatch,
        signingSubjectOrgId,
        signingEntityLevel,
        category: contractTypeWatch,
        legalCategory: legalCategoryWatch,
        direction,
      });
      form.setFieldValue('contractNo', res.suggestedNo);
    } catch (e) {
      message.error(errorText(e));
    }
  };

  const amountCents = parseMoneyToCentsPreview(amount);
  const ceilingCents = parseMoneyToCentsPreview(ceilingAmount);
  const tierAmount = pricingMode === 'unit_price' && (amountCents === null || amountCents === 0n) && ceilingCents !== null ? ceilingCents : amountCents;
  const tier = tierAmount !== null && tierAmount >= 0n ? procurementTierPreview(procurement !== false, target ?? null, tierAmount, method ?? null) : null;

  const save = useMutation({
    mutationFn: (v: Record<string, unknown>) => {
      const body: Record<string, unknown> = {
        ...v,
        paymentCapRatio: v.paymentCapRatio || null,
        estimatedCeilingAmount: v.estimatedCeilingAmount || null,
        exchangeRate: v.currency === '人民币' ? null : (v.exchangeRate || null),
        bidAwardAmount: v.bidAwardAmount || null,
        warrantyRetentionRatio: v.hasWarranty ? (v.warrantyRetentionRatio || null) : null,
        warrantyMonths: v.hasWarranty ? (v.warrantyMonths ?? null) : null,
      };
      if (!contract) return contractApi.create(compact(body) as never);
      const { contractNo: _no, orgId: _org, ...rest } = body;
      if (amountLocked) delete rest.originalAmount;
      return contractApi.update(contract.id, {
        ...rest,
        projectId: rest.projectId ?? null,
        supplierId: rest.supplierId ?? null,
        planItemId: rest.planItemId ?? null,
        signingSubjectOrgId: rest.signingSubjectOrgId ?? null,
        sourceIncomeContractId: rest.sourceIncomeContractId ?? null,
        expectedVersion: contract.version,
      });
    },
    onSuccess: (c) => { message.success(contract ? '已保存' : '已创建合同 ' + c.contractNo); onSaved(c); onClose(); },
    onError: (e) => message.error(errorText(e)),
  });

  const initialValues = contract ? {
    contractNo: contract.contractNo, name: contract.name, contractType: contract.contractType, orgId: contract.orgId,
    projectId: contract.projectId, supplierId: contract.supplierId, planItemId: contract.planItemId ?? null,
    signingSubjectOrgId: contract.signingSubjectOrgId ?? null,
    direction: contract.direction ?? 'expense', pricingMode: contract.pricingMode ?? 'lump_sum',
    unitPriceDesc: contract.unitPriceDesc ?? '', estimatedCeilingAmount: contract.estimatedCeilingAmount ?? '',
    currency: contract.currency ?? '人民币', exchangeRate: contract.exchangeRate ?? '',
    reportCategory: contract.reportCategory ?? 'other', budgetType: contract.budgetType ?? 'single_listed',
    outOfPlanApprovedDate: contract.outOfPlanApprovedDate ?? null,
    isEmergency: contract.isEmergency ?? false, emergencyStartDate: contract.emergencyStartDate ?? null,
    fundingSource: contract.fundingSource ?? 'self_owned_other', fundingSourceDetail: contract.fundingSourceDetail ?? '',
    sourceIncomeContractId: contract.sourceIncomeContractId ?? null, externalNoExempt: contract.externalNoExempt ?? false,
    summaryText: contract.summaryText ?? '', remark: contract.remark ?? '',
    counterpartyNames: contract.counterpartyNames ?? '', undertakerName: contract.undertakerName ?? '', undertakerDept: contract.undertakerDept ?? '',
    ourSignatoryName: contract.ourSignatoryName ?? '', ourSignatoryTitle: contract.ourSignatoryTitle ?? '', ourSignatoryIsLegalRep: contract.ourSignatoryIsLegalRep ?? null,
    counterpartySignatoryName: contract.counterpartySignatoryName ?? '', counterpartySignatoryTitle: contract.counterpartySignatoryTitle ?? '', counterpartySignatoryIsLegalRep: contract.counterpartySignatoryIsLegalRep ?? null,
    farmerWageAccount: contract.farmerWageAccount ?? '', entrustReason: contract.entrustReason ?? '',
    legalCategory: contract.legalCategory ?? 'other', partyRole: contract.partyRole ?? 'buyer',
    signingEntityLevel: contract.signingEntityLevel ?? 'company', isProcurement: contract.isProcurement ?? true,
    procurementTarget: contract.procurementTarget, procurementMethod: contract.procurementMethod,
    procurementMethodOther: contract.procurementMethodOther ?? '', isGovProcurement: contract.isGovProcurement ?? false,
    procurementPlanText: contract.procurementPlanText ?? '', procurementStartDate: contract.procurementStartDate ?? null,
    supplierConfirmDate: contract.supplierConfirmDate ?? null, bidAwardAmount: contract.bidAwardAmount ?? '',
    responseDocsComplete: contract.responseDocsComplete ?? null, creditChecked: contract.creditChecked ?? null,
    acquisitionMethod: contract.acquisitionMethod ?? null, acquisitionMethodOther: contract.acquisitionMethodOther ?? '',
    tenderBodyType: contract.tenderBodyType ?? null, consortiumMembers: contract.consortiumMembers ?? '',
    isImportant: contract.isImportant ?? false, isTripleMajor: contract.isTripleMajor ?? false,
    decisionMethod: contract.decisionMethod ?? null, decisionMethodOther: contract.decisionMethodOther ?? '',
    meetingType: contract.meetingType ?? null, meetingTypeOther: contract.meetingTypeOther ?? '',
    finalApproverName: contract.finalApproverName ?? '', finalApproverTitle: contract.finalApproverTitle ?? '',
    deptReviewerName: contract.deptReviewerName ?? '', relatedMgmtDepts: contract.relatedMgmtDepts ?? '',
    relatedMgmtReviewers: contract.relatedMgmtReviewers ?? '', unitApproverName: contract.unitApproverName ?? '', unitApproverTitle: contract.unitApproverTitle ?? '',
    termType: contract.termType ?? 'unspecified', termStartDate: contract.termStartDate ?? null, termEndDate: contract.termEndDate ?? null,
    termConditionText: contract.termConditionText ?? '', deliverableSubmitted: contract.deliverableSubmitted ?? null,
    finalAccepted: contract.finalAccepted ?? false, hasWarranty: contract.hasWarranty ?? false,
    warrantyMonths: contract.warrantyMonths ?? null, warrantyRetentionRatio: contract.warrantyRetentionRatio ?? '',
    originalAmount: contract.originalAmount, paymentCapRatio: contract.paymentCapRatio ?? '',
    signDate: contract.signDate, effectiveDate: contract.effectiveDate,
  } : {
    orgId: defaultOrgId(), originalAmount: '0.00', direction: 'expense', pricingMode: 'lump_sum', currency: '人民币',
    reportCategory: 'other', budgetType: 'single_listed', fundingSource: 'self_owned_other', termType: 'unspecified',
    legalCategory: 'other', partyRole: 'buyer', signingEntityLevel: 'company', isProcurement: true, isImportant: false,
    isTripleMajor: false, isEmergency: false, hasWarranty: false, externalNoExempt: false,
  };

  const collapseItems = [
    {
      key: 'base',
      label: '一、基本与立项来源',
      forceRender: true,
      children: (
        <Row gutter={12}>
          <Col span={10}>
            <Form.Item
              name="contractNo"
              label="合同编号"
              extra={
                !contract ? (
                  <Button size="small" type="link" style={{ padding: 0, height: 'auto' }} onClick={() => void fillSuggestedNo()}>
                    生成建议编号
                  </Button>
                ) : undefined
              }
              rules={[{ required: true, whitespace: true }]}
            >
              <Input maxLength={64} disabled={!!contract} placeholder="XX－YY－序号（补X）/年份－流水号" />
            </Form.Item>
          </Col>
          <Col span={4}><Form.Item name="externalNoExempt" label="外部编号豁免" valuePropName="checked"><Checkbox disabled={amountLocked}>免规则校验</Checkbox></Form.Item></Col>
          <Col span={10}><Form.Item name="name" label="合同名称" rules={[{ required: true, whitespace: true }]}><Input maxLength={200} /></Form.Item></Col>
          {!contract && nextNoPreview.data && (
            <Col span={24} style={{ marginBottom: 10 }}>
              <Alert
                type="info"
                showIcon
                message={`规范取号码：${nextNoPreview.data.canonicalPrefix} ｜ 实际签约主体：${nextNoPreview.data.signingOrgName} vs 法定统计法人：${nextNoPreview.data.legalEntityOrgName}`}
                description={
                  nextNoPreview.data.isDirectStation && direction === 'income'
                    ? '直属水电站资金进项合同按制度强制锁定以母公司名义签订。'
                    : nextNoPreview.data.orgKind === 'direct_unit' && !nextNoPreview.data.isDirectStation && direction === 'income'
                      ? '直属分支机构签订资金进项合同后，须在 10 个工作日内报公司企管与财务备案。'
                      : undefined
                }
              />
            </Col>
          )}
          <Col span={8}>
            <Form.Item
              name="orgId"
              label="承办组织"
              extra={contract ? '组织归属创建后不可直接更改' : undefined}
              rules={[{ required: true, message: '请选择组织' }]}
            >
              <OrgSelect
                disabled={!!contract}
                disableInactive={!contract}
                onChange={(v) => form.setFieldValue('orgId', v)}
                width={240}
                allowClear={false}
              />
            </Form.Item>
          </Col>
          <Col span={8}><Form.Item name="direction" label="收支方向"><Select disabled={amountLocked} options={Object.entries(DIRECTION_LABELS).map(([value, label]) => ({ value, label }))} /></Form.Item></Col>
          <Col span={8}><Form.Item name="reportCategory" label="监督报送分类"><Select options={Object.entries(REPORT_CATEGORY_LABELS).map(([value, label]) => ({ value, label }))} /></Form.Item></Col>
          <Col span={8}><Form.Item name="contractType" label="合同类型"><Input maxLength={50} placeholder="如 工程 / 货物 / 服务" /></Form.Item></Col>
          <Col span={8}><Form.Item name="pricingMode" label="计价方式"><Select disabled={amountLocked} options={Object.entries(PRICING_MODE_LABELS).map(([value, label]) => ({ value, label }))} /></Form.Item></Col>
          <Col span={8}><Form.Item name="currency" label="币种"><Select showSearch disabled={amountLocked} options={CONTRACT_CURRENCIES.map((c) => ({ value: c, label: c }))} /></Form.Item></Col>
          <Col span={8}>
            <Form.Item
              name="originalAmount"
              label="原始金额(元)"
              rules={[{ required: true }, isLegacyTolerant ? moneyRule : requiredNonNegMoneyRule]}
              extra={amountLocked ? '已有有效批准或签署件时金额锁定；履约后通过变更调整' : (pricingMode === 'unit_price' ? '单价合同可填 0.00' : '签署前纠错后需重新法审')}
            >
              <Input disabled={amountLocked} />
            </Form.Item>
          </Col>
          {pricingMode === 'unit_price' && (
            <>
              <Col span={8}><Form.Item name="estimatedCeilingAmount" label="估算上限金额(元)" rules={[nonNegMoneyRule]}><Input disabled={amountLocked} placeholder="用于单价合同限额控制" /></Form.Item></Col>
              <Col span={8}><Form.Item name="unitPriceDesc" label="单价与计价标准说明"><Input maxLength={500} placeholder="如 500元/工日据实结算" /></Form.Item></Col>
            </>
          )}
          {currency !== '人民币' && (
            <Col span={8}><Form.Item name="exchangeRate" label="参考汇率" rules={[{ pattern: /^(\d+(\.\d{1,6})?)?$/, message: '正数(最多6位小数)' }]}><Input placeholder="折算人民币汇率" /></Form.Item></Col>
          )}
          <Col span={8}><Form.Item name="paymentCapRatio" label="付款上限比例(0～1,可空)" rules={[ratioRule]}><Input placeholder="如 0.95" /></Form.Item></Col>
          <Col span={8}><Form.Item name="projectId" label="项目"><Select allowClear showSearch optionFilterProp="label" loading={projects.loading} options={projects.options} /></Form.Item></Col>
          <Col span={8}>
            <Form.Item name="planItemId" label="关联综合计划项">
              <Select
                allowClear
                showSearch
                optionFilterProp="label"
                loading={planItemsQ.isLoading}
                placeholder="可选，绑定已导入综合计划明细"
                options={(planItemsQ.data ?? []).map((it) => ({
                  value: it.id,
                  label: `${it.itemName}${it.projectCode ? ` (${it.projectCode})` : ''}`,
                }))}
              />
            </Form.Item>
          </Col>
          <Col span={8}><Form.Item name="budgetType" label="立项计划口径"><Select options={Object.entries(BUDGET_TYPE_LABELS).map(([value, label]) => ({ value, label }))} /></Form.Item></Col>
          <Col span={8}><Form.Item name="fundingSource" label="资金来源"><Select options={Object.entries(FUNDING_SOURCE_LABELS).map(([value, label]) => ({ value, label }))} /></Form.Item></Col>
          {direction === 'expense' && fundingSource === 'income_contract' && (
            <Col span={16}>
              <Form.Item name="sourceIncomeContractId" label="关联收入合同（以收定支）" rules={[{ required: true, message: '请选择关联收入合同' }]}>
                <Select showSearch optionFilterProp="label" loading={incomeContracts.isLoading} options={(incomeContracts.data ?? []).filter((x) => x.status !== 'voided' && x.id !== contract?.id).map((x) => ({ value: x.id, label: x.contractNo + ' · ' + x.name }))} />
              </Form.Item>
            </Col>
          )}
          <Col span={8}><Form.Item name="fundingSourceDetail" label="资金来源说明"><Input maxLength={500} /></Form.Item></Col>
          <Col span={8}><Form.Item name="isEmergency" label="应急项目" valuePropName="checked"><Checkbox>属于应急/抢险抢修</Checkbox></Form.Item></Col>
          {isEmergency && <Col span={8}>{dateField('应急开工日期', 'emergencyStartDate')}</Col>}
          <Col span={8}>{dateField('超预算审批日期', 'outOfPlanApprovedDate')}</Col>
          <Col span={24}><Form.Item name="summaryText" label="合同主要内容摘录"><Input.TextArea rows={2} maxLength={2000} /></Form.Item></Col>
        </Row>
      ),
    },
    {
      key: 'party',
      label: '二、多方主体、承办人与签署授权',
      forceRender: true,
      children: (
        <Row gutter={12}>
          <Col span={8}><Form.Item name="supplierId" label="主供应商 / 客户"><Select allowClear showSearch optionFilterProp="label" loading={suppliers.loading} options={suppliers.options} /></Form.Item></Col>
          <Col span={16}><Form.Item name="counterpartyNames" label="全部相对方名称（联合体或多方用逗号分隔）"><Input maxLength={1000} /></Form.Item></Col>
          <Col span={8}><Form.Item name="undertakerName" label="承办人"><Input maxLength={100} /></Form.Item></Col>
          <Col span={8}><Form.Item name="undertakerDept" label="承办部门"><Input maxLength={100} /></Form.Item></Col>
          <Col span={8}>
            <Form.Item name="signingEntityLevel" label="签约主体层级">
              <Select
                disabled={amountLocked || Boolean(!contract && nextNoPreview.data?.isDirectStation && direction === 'income')}
                options={[{ value: 'company', label: '公司名义' }, { value: 'secondary_unit', label: '二级单位名义' }]}
              />
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item name="signingSubjectOrgId" label="对外签约名义组织（可选）">
              <OrgSelect width={240} placeholder="默认按承办组织及层级推导" onChange={(v) => form.setFieldValue('signingSubjectOrgId', v ?? null)} />
            </Form.Item>
          </Col>
          <Col span={8}><Form.Item name="ourSignatoryName" label="我方签署人姓名"><Input maxLength={100} /></Form.Item></Col>
          <Col span={8}><Form.Item name="ourSignatoryTitle" label="我方签署人职务"><Input maxLength={100} /></Form.Item></Col>
          <Col span={8}><Form.Item name="ourSignatoryIsLegalRep" label="我方签署人为法定代表人"><Select allowClear options={[{ value: true, label: '是（法定代表人）' }, { value: false, label: '否（须附授权委托书）' }]} /></Form.Item></Col>
          <Col span={8}><Form.Item name="counterpartySignatoryName" label="对方签署人姓名"><Input maxLength={100} /></Form.Item></Col>
          <Col span={8}><Form.Item name="counterpartySignatoryTitle" label="对方签署人职务"><Input maxLength={100} /></Form.Item></Col>
          <Col span={8}><Form.Item name="counterpartySignatoryIsLegalRep" label="对方签署人为法定代表人"><Select allowClear options={[{ value: true, label: '是（法定代表人）' }, { value: false, label: '否（须附授权委托书）' }]} /></Form.Item></Col>
          {direction === 'expense' && <Col span={12}><Form.Item name="farmerWageAccount" label="农民工工资专户账号"><Input maxLength={100} placeholder="施工类合同按规定登记" /></Form.Item></Col>}
          <Col span={direction === 'expense' ? 12 : 24}><Form.Item name="entrustReason" label="委托 / 签约缘由说明"><Input maxLength={1000} /></Form.Item></Col>
        </Row>
      ),
    },
    {
      key: 'decision',
      label: '三、法审分类、决策审批与采购过程',
      forceRender: true,
      children: (
        <Row gutter={12}>
          <Col xs={24} sm={8}><Form.Item name="legalCategory" label="法审大类"><Select disabled={amountLocked} options={LEGAL_CATEGORIES.map((value) => ({ value, label: LEGAL_LABELS[value] }))} /></Form.Item></Col>
          <Col xs={24} sm={8}><Form.Item name="partyRole" label="我方立场"><Select disabled={amountLocked} options={PARTY_ROLES.map((value) => ({ value, label: ROLE_LABELS[value] }))} /></Form.Item></Col>
          <Col xs={24} sm={8}>
            <Space style={{ marginTop: 30 }}>
              <Form.Item name="isProcurement" valuePropName="checked" noStyle><Checkbox disabled={amountLocked}>采购类合同</Checkbox></Form.Item>
              <Form.Item name="isImportant" valuePropName="checked" noStyle><Checkbox disabled={amountLocked}>重要合同</Checkbox></Form.Item>
              <Form.Item name="isTripleMajor" valuePropName="checked" noStyle><Checkbox>三重一大</Checkbox></Form.Item>
            </Space>
          </Col>
          {direction === 'expense' && procurement !== false && (
            <>
              <Col xs={24} sm={8}><Form.Item name="procurementTarget" label="采购对象"><Select disabled={amountLocked} allowClear options={[{ value: 'goods', label: '货物' }, { value: 'construction', label: '施工' }, { value: 'service', label: '服务' }]} /></Form.Item></Col>
              <Col xs={24} sm={8}><Form.Item name="procurementMethod" label="采购方式"><Select disabled={amountLocked} allowClear options={PROCUREMENT_METHODS.map((value) => ({ value, label: METHOD_LABELS[value] }))} /></Form.Item></Col>
              <Col xs={24} sm={8}><Form.Item name="bidAwardAmount" label="审定中标金额(元)" rules={[nonNegMoneyRule]}><Input placeholder="可空" /></Form.Item></Col>
              <Col xs={24} sm={8}>{dateField('开始实施采购日期', 'procurementStartDate')}</Col>
              <Col xs={24} sm={8}>{dateField('供应商确定日期', 'supplierConfirmDate')}</Col>
              <Col xs={24} sm={8}><Form.Item name="isGovProcurement" label="是否政府采购" valuePropName="checked"><Checkbox>政府采购</Checkbox></Form.Item></Col>
            </>
          )}
          {direction === 'income' && (
            <>
              <Col xs={24} sm={8}><Form.Item name="acquisitionMethod" label="项目取得方式"><Select allowClear options={Object.entries(ACQUISITION_METHOD_LABELS).map(([value, label]) => ({ value, label }))} /></Form.Item></Col>
              {acquisitionMethod === 'other' && <Col xs={24} sm={8}><Form.Item name="acquisitionMethodOther" label="其他取得方式说明"><Input maxLength={200} /></Form.Item></Col>}
              <Col xs={24} sm={8}><Form.Item name="tenderBodyType" label="投标主体形式"><Select allowClear options={Object.entries(TENDER_BODY_LABELS).map(([value, label]) => ({ value, label }))} /></Form.Item></Col>
              {tenderBodyType === 'consortium' && <Col xs={24} sm={8}><Form.Item name="consortiumMembers" label="联合体成员"><Input maxLength={1000} /></Form.Item></Col>}
            </>
          )}
          <Col span={24}>
            <Alert style={{ marginBottom: 12 }} type="info"
              message={'系统采购层级：' + (tier ? TIER_LABELS[tier] : '请填写采购对象与金额')}
              description={procurement === false ? '非采购需公司批准文件；销售合同需相对方书面邀约。' : (tier === 'tier_1' || tier === 'tier_2') ? '请上传采购方案审批、定标审批、中标/成交通知书及评审报告。' : '三级采购需定标审批；直接报账适用性及重要合同材料另行核验。'} />
          </Col>
          <Col span={8}><Form.Item name="decisionMethod" label="决策方式"><Select allowClear options={Object.entries(DECISION_METHOD_LABELS).map(([value, label]) => ({ value, label }))} /></Form.Item></Col>
          {decisionMethod === 'meeting' && <Col span={8}><Form.Item name="meetingType" label="会议类型"><Select allowClear options={Object.entries(MEETING_TYPE_LABELS).map(([value, label]) => ({ value, label }))} /></Form.Item></Col>}
          {decisionMethod === 'other' && <Col span={8}><Form.Item name="decisionMethodOther" label="其他决策方式"><Input maxLength={200} /></Form.Item></Col>}
          {meetingType === 'other' && <Col span={8}><Form.Item name="meetingTypeOther" label="其他会议名称"><Input maxLength={200} /></Form.Item></Col>}
          <Col span={8}><Form.Item name="finalApproverName" label="最终审批人姓名"><Input maxLength={100} /></Form.Item></Col>
          <Col span={8}><Form.Item name="finalApproverTitle" label="最终审批人职务"><Input maxLength={100} /></Form.Item></Col>
          <Col span={8}><Form.Item name="deptReviewerName" label="部门审签人"><Input maxLength={100} /></Form.Item></Col>
          <Col span={8}><Form.Item name="relatedMgmtDepts" label="相关归口部门"><Input maxLength={500} /></Form.Item></Col>
          <Col span={8}><Form.Item name="unitApproverName" label="单位审签领导"><Input maxLength={100} /></Form.Item></Col>
        </Row>
      ),
    },
    {
      key: 'term',
      label: '四、履约期限、质保与签署日期',
      forceRender: true,
      children: (
        <Row gutter={12}>
          <Col span={8}>{dateField('签订日期', 'signDate')}</Col>
          <Col span={8}>{dateField('生效日期', 'effectiveDate')}</Col>
          <Col span={8}><Form.Item name="termType" label="履约期限类型"><Select options={Object.entries(TERM_TYPE_LABELS).map(([value, label]) => ({ value, label }))} /></Form.Item></Col>
          {termType === 'fixed' && (
            <>
              <Col span={8}>{dateField('履约开始日期', 'termStartDate')}</Col>
              <Col span={8}>{dateField('履约结束日期', 'termEndDate')}</Col>
            </>
          )}
          {termType === 'conditional' && <Col span={16}><Form.Item name="termConditionText" label="履约期限条件说明"><Input maxLength={50} /></Form.Item></Col>}
          <Col span={8}><Form.Item name="hasWarranty" label="约定质保期" valuePropName="checked"><Checkbox>进入质保维护阶段</Checkbox></Form.Item></Col>
          {hasWarranty && (
            <>
              <Col span={8}><Form.Item name="warrantyMonths" label="质保期(月)"><InputNumber min={0} max={600} style={{ width: '100%' }} /></Form.Item></Col>
              <Col span={8}><Form.Item name="warrantyRetentionRatio" label="质保金比例(0～1)" rules={[ratioRule]}><Input placeholder="如 0.05" /></Form.Item></Col>
            </>
          )}
          <Col span={8}><Form.Item name="deliverableSubmitted" label="约定成果提交"><Select allowClear options={[{ value: true, label: '已按约定提交' }, { value: false, label: '尚未提交' }]} /></Form.Item></Col>
          <Col span={8}><Form.Item name="finalAccepted" label="最终验收状态" valuePropName="checked"><Checkbox>已完成最终验收</Checkbox></Form.Item></Col>
          <Col span={24}><Form.Item name="remark" label="备注"><Input.TextArea rows={2} maxLength={2000} /></Form.Item></Col>
        </Row>
      ),
    },
  ];

  return (
    <Modal open={open} title={contract ? '编辑合同 ' + contract.contractNo : '新建合同'} width={900} onCancel={onClose} destroyOnClose confirmLoading={save.isPending}
      styles={{ body: { maxHeight: '72vh', overflowY: 'auto' } }}
      onOk={() => form.validateFields().then((v) => save.mutate(v), () => {})}>
      {isLegacyTolerant && contract && (
        <Alert
          type="warning"
          showIcon
          style={{ marginBottom: 12 }}
          message={
            <Space wrap size={6}>
              <span>历史容缺迁入合同（待逐步补录转正）</span>
              {contract.syntheticNoFlag && <Tag color="purple">合成号</Tag>}
              {contract.isReversal && <Tag color="magenta">红冲</Tag>}
            </Space>
          }
          description={
            <div style={{ fontSize: 12, lineHeight: 1.7 }}>
              <div>
                实际签约主体：{contract.signingOrgName || contract.orgName} ｜ 法定法人统计口径：{contract.legalEntityOrgName || contract.orgName}
              </div>
              {(contract.missingFields?.length ?? 0) > 0 && <div>待补录缺口：{contract.missingFields!.join('、')}</div>}
              {contract.legacyRawNo && <div>原台账原始编号：{contract.legacyRawNo}</div>}
              {contract.rawSignDateText && <div>原始签订日期文本：{contract.rawSignDateText}</div>}
              {contract.rawAmountText && <div>原始金额文本：{contract.rawAmountText}</div>}
              {contract.foreignAmountText && <div>原币金额原文：{contract.foreignAmountText}</div>}
              {contract.noExemptReason && <div>无号豁免/赋码说明：{contract.noExemptReason}</div>}
            </div>
          }
        />
      )}
      <Form form={form} layout="vertical" preserve={false} initialValues={initialValues}>
        <Collapse defaultActiveKey={['base', 'party', 'decision', 'term']} items={collapseItems} />
      </Form>
    </Modal>
  );
}
