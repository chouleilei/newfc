import { useEffect, useMemo, useState } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  Alert, App as AntdApp, Button, Card, Checkbox, Col, DatePicker, Descriptions, Drawer,
  Form, Input, InputNumber, Modal, Row, Segmented, Select, Space, Table, Tag, Typography,
} from 'antd';
import dayjs from 'dayjs';
import { api, can, download, errorText, getSession } from '../../api/client';
import {
  planApi,
  type PlanAdjustType,
  type PlanAdjustmentCreateRequest,
  type PlanAdjustmentDto,
  type PlanAdjustmentLineInput,
  type PlanAdjustmentValueType,
  type PlanApprovalBody,
  type PlanAttachmentSummaryDto,
  type PlanCycleStatus,
  type PlanIssuanceCycleCreateRequest,
  type PlanIssuanceCycleDto,
  type PlanIssuanceStage,
  type PlanPackSignStatus,
  type PlanReconcileReportDto,
  type PlanSheetCode,
  type PlanTaxCheckItemDto,
  type PlanUnitPackDto,
} from '../../api/projectContract';
import { QueryErrorResult } from '../../components/QueryErrorResult';
import { useAssistantDraft } from '../../assistant/contextHooks';
import { ConfigFormAssistant } from '../../components/assistant/ConfigFormAssistant';
import { centsToWan } from '../../utils/money';
import { shortTime } from '../../utils/relativeTime';
import { compact, Money } from '../financeData/shared';
import { parseMoneyToCentsPreview, formatCentsPreview } from './contractOptions';

const ISSUANCE_STAGE_LABELS: Record<PlanIssuanceStage, string> = {
  pre_arrangement: '预安排',
  formal_draft: '正式草案',
  official: '正式下达',
  adjusted: '年中调整修订',
};

const CYCLE_STATUS_META: Record<PlanCycleStatus, { text: string; color: string }> = {
  draft: { text: '草稿编校', color: 'gold' },
  published: { text: '已正式下达', color: 'success' },
  superseded: { text: '已被修订替代', color: 'default' },
  archived: { text: '已归档', color: 'default' },
};

const PACK_STATUS_META: Record<PlanPackSignStatus, { text: string; color: string }> = {
  draft: { text: '待下发', color: 'default' },
  issued: { text: '待签收', color: 'processing' },
  acknowledged: { text: '已签收', color: 'success' },
  adjust_requested: { text: '调整申请中', color: 'warning' },
};

const ADJUST_TYPE_LABELS: Record<PlanAdjustType, string> = {
  within_total_realloc: '总体指标内执行方案调剂',
  overall_target_change: '新增产能/总收入/利润等总体指标调整',
  unplanned_hq_or_station: '本部及直属电站计划外立项',
  unplanned_subsidiary_within_cap: '分子公司年度专项控制目标内计划外项目',
  unplanned_subsidiary_over_cap: '分子公司超年度专项控制目标计划外项目',
  emergency_retroactive: '防汛/突发应急先开工后补立项',
};

const APPROVAL_BODY_LABELS: Record<PlanApprovalBody, string> = {
  gm_office: '总经理办公会审定',
  board_of_directors: '党组前置/董事会批准',
  joint_review_company: '专业与财务联合会审后报集团审批',
  subsidiary_self_decision: '分子公司依制度自决并报备',
  company_approval: '报集团公司审批',
};

const VALUE_TYPE_OPTIONS: { value: PlanAdjustmentValueType; label: string; defaultUnit: string; scale: number }[] = [
  { value: 'amount_cents', label: '金额(元)', defaultUnit: '元', scale: 2 },
  { value: 'scaled_int', label: '数量指标(万kWh / MW)', defaultUnit: '万kWh', scale: 4 },
  { value: 'rate_bp', label: '比率(%)', defaultUnit: '%', scale: 2 },
  { value: 'text', label: '文本说明', defaultUnit: '', scale: 0 },
];

const CHECK_KIND_LABELS: Record<PlanTaxCheckItemDto['kind'], string> = {
  vat_maintenance: '含税运维 ↔ 不含税预算 (÷1.06)',
  mgmt_fee_nested: '管理费嵌套恒等 (R17=R18+R19+R20+R21)',
  controllable_mgmt_step: '可控管理费 (R19+R20) 两位万元步长',
  cross_unit_formula: '跨单元单元格公式错引检查',
  consolidation_balance: '8单元+合并调节项 == 集团合并总表',
};

function countWeekdaysSince(fromDate?: string | null): number {
  if (!fromDate || !/^\d{4}-\d{2}-\d{2}$/.test(fromDate)) return 0;
  const start = dayjs(fromDate).startOf('day');
  const end = dayjs().startOf('day');
  if (!start.isValid() || !end.isAfter(start)) return 0;
  let cur = start.add(1, 'day');
  let count = 0;
  while (!cur.isAfter(end)) {
    const dow = cur.day();
    if (dow !== 0 && dow !== 6) count++;
    cur = cur.add(1, 'day');
  }
  return count;
}

function deriveApprovalBodyPreview(adjustType?: PlanAdjustType, exceedsOverall?: boolean): PlanApprovalBody {
  if (exceedsOverall || adjustType === 'overall_target_change') return 'board_of_directors';
  switch (adjustType) {
    case 'within_total_realloc':
      return 'gm_office';
    case 'unplanned_hq_or_station':
      return 'joint_review_company';
    case 'unplanned_subsidiary_within_cap':
      return 'subsidiary_self_decision';
    case 'unplanned_subsidiary_over_cap':
    case 'emergency_retroactive':
    default:
      return 'company_approval';
  }
}

function computeDeltaPreview(valueType: PlanAdjustmentValueType, beforeVal?: string, afterVal?: string): string {
  if (valueType === 'text') return `${beforeVal ?? ''} → ${afterVal ?? ''}`;
  if (valueType === 'amount_cents') {
    const b = parseMoneyToCentsPreview(beforeVal ?? '0') ?? 0n;
    const a = parseMoneyToCentsPreview(afterVal ?? '0') ?? 0n;
    const diff = a - b;
    return (diff > 0n ? '+' : '') + formatCentsPreview(diff);
  }
  const bn = Number(beforeVal ?? 0);
  const an = Number(afterVal ?? 0);
  if (!Number.isFinite(bn) || !Number.isFinite(an)) return '0';
  const d = an - bn;
  return `${d > 0 ? '+' : ''}${d.toFixed(valueType === 'rate_bp' ? 2 : 4)}`;
}

interface UnitBudgetBrief {
  version: { id: number; name: string; year: number };
  totalsByAccountType: { income: number; cost: number; expense: number };
}

function PackDetailDrawer({
  packId,
  onClose,
  onAckClick,
}: {
  packId: number | null;
  onClose: () => void;
  onAckClick?: (pack: PlanUnitPackDto) => void;
}) {
  const q = useQuery({
    queryKey: ['plan-issuance-pack', packId],
    queryFn: () => planApi.pack(packId!),
    enabled: packId != null,
  });
  const p = q.data;
  const unitBudgetQ = useQuery({
    queryKey: ['pack-unit-budget', p?.budgetVersionId, p?.unitOrgId],
    queryFn: () => api.get<UnitBudgetBrief>(`/versions/${p!.budgetVersionId}/unit-view?orgId=${p!.unitOrgId}`),
    enabled: !!p?.budgetVersionId && can('budget:read'),
  });
  const canAck = p?.signOffStatus === 'issued' && can('plan:write');

  return (
    <Drawer
      open={packId != null}
      onClose={onClose}
      width={980}
      destroyOnClose
      title={p ? `${p.unitOrgName} · 综合计划与预算下达包 (${p.docNo || '待编文号'})` : '单元下达包详情'}
      extra={
        p && (
          <Space>
            {can('plan:read') && (
              <Button onClick={() => void download(planApi.exportPackDocxPath(p.id), `综合计划与预算下达通知_${p.unitOrgName}.docx`)}>
                导出下达公文及责任书 (.docx)
              </Button>
            )}
            {canAck && onAckClick && (
              <Button type="primary" onClick={() => onAckClick(p)}>
                确认签收
              </Button>
            )}
          </Space>
        )
      }
    >
      {q.error ? (
        <QueryErrorResult title="下达包详情加载失败" error={q.error} refetch={q.refetch} />
      ) : (
        p && (
          <Space direction="vertical" style={{ width: '100%' }} size={12}>
            <Descriptions size="small" bordered column={3}>
              <Descriptions.Item label="归口下达单元">{p.unitOrgName} ({p.unitOrgCode})</Descriptions.Item>
              <Descriptions.Item label="发文字号">{p.docNo || '—'}</Descriptions.Item>
              <Descriptions.Item label="签收状态">
                <Tag color={PACK_STATUS_META[p.signOffStatus].color}>{PACK_STATUS_META[p.signOffStatus].text}</Tag>
              </Descriptions.Item>
              <Descriptions.Item label="归并下属法人" span={2}>
                {p.mergedChildOrgs.length > 0 ? p.mergedChildOrgs.map((c) => `${c.name}(${c.code})`).join('、') : '仅本级主体'}
              </Descriptions.Item>
              <Descriptions.Item label="目标责任书">
                {p.hasResponsibilityLetter ? <Tag color="blue">{p.responsibilityLetterNo || '含目标责任书'}</Tag> : <Tag>总部无责任书</Tag>}
              </Descriptions.Item>
              <Descriptions.Item label="营业总收入"><Money value={p.metrics.operatingRevenue} /></Descriptions.Item>
              <Descriptions.Item label="利润总额"><Money value={p.metrics.profitBeforeTax} /></Descriptions.Item>
              <Descriptions.Item label="固定资产投资"><Money value={p.metrics.investmentTotal} /></Descriptions.Item>
              <Descriptions.Item label="五项费用(精确/批复)">
                <Money value={p.metrics.fiveExpensesExact} /> / <Money value={p.metrics.fiveExpensesIssued} />
              </Descriptions.Item>
              <Descriptions.Item label="可控管理费 R19+R20 (精确/批复)" span={2}>
                <Money value={p.metrics.controllableMgmtFeeExact} /> / <Money value={p.metrics.controllableMgmtFeeIssued} />
              </Descriptions.Item>
              {p.ackAt && (
                <Descriptions.Item label="签收记录" span={3}>
                  {p.ackUserName ?? '—'} 于 {shortTime(p.ackAt)} 签收 {p.ackNote ? `· 备注：${p.ackNote}` : ''}
                </Descriptions.Item>
              )}
            </Descriptions>

            {unitBudgetQ.data && (
              <Card size="small" title={`关联经营预算快照摘要 · ${unitBudgetQ.data.version.name}`}>
                <Space size={24} wrap>
                  <span>营业收入预算：{centsToWan(unitBudgetQ.data.totalsByAccountType.income)} 万元</span>
                  <span>营业成本预算：{centsToWan(unitBudgetQ.data.totalsByAccountType.cost)} 万元</span>
                  <span>期间费用预算：{centsToWan(unitBudgetQ.data.totalsByAccountType.expense)} 万元</span>
                </Space>
              </Card>
            )}

            <Card size="small" title={`下达附表清单（共 ${p.attachments?.length ?? p.attachmentCount} 张）`}>
              <Table<PlanAttachmentSummaryDto>
                rowKey="attachmentNo"
                size="small"
                pagination={false}
                dataSource={p.attachments ?? []}
                expandable={{
                  expandedRowRender: (att) => (
                    <Table
                      rowKey={(_, idx) => String(idx)}
                      size="small"
                      pagination={false}
                      dataSource={att.rows}
                      columns={[
                        { title: '序号', dataIndex: 'seqNo', width: 70 },
                        { title: '项目/指标名称', dataIndex: 'itemName' },
                        { title: '单位', dataIndex: 'unit', width: 90 },
                        { title: '下达指标值', dataIndex: 'amountOrValue', width: 140, align: 'right' },
                        { title: '实际承办主体', dataIndex: 'undertakeOrgName', width: 150, render: (v: string | null) => v ?? '—' },
                        { title: '备注', dataIndex: 'note', ellipsis: true },
                      ]}
                    />
                  ),
                }}
                columns={[
                  { title: '附件号', dataIndex: 'attachmentNo', width: 75, render: (n: number) => `附表${n}` },
                  { title: '附表名称', dataIndex: 'title' },
                  { title: '明细行数', dataIndex: 'leafRowCount', width: 90, align: 'right' },
                  { title: '系统精确计算(元)', dataIndex: 'exactTotalAmount', width: 145, align: 'right', render: (v: string) => <Money value={v} /> },
                  { title: '正式批复下达(元)', dataIndex: 'issuedTotalAmount', width: 145, align: 'right', render: (v: string) => <Money value={v} /> },
                  { title: '尾差归因', dataIndex: 'diffReasonCode', width: 170, render: (v: string) => v ? <Tag>{v}</Tag> : '—' },
                ]}
              />
            </Card>

            {(p.undertakeItems?.length ?? 0) > 0 && (
              <Card size="small" title={`跨单位实际承办任务明细（${p.undertakeItems!.length} 项）`}>
                <Table
                  rowKey="itemId"
                  size="small"
                  pagination={false}
                  dataSource={p.undertakeItems}
                  columns={[
                    { title: '工作表', dataIndex: 'sheetCode', width: 130 },
                    { title: '项目名称', dataIndex: 'itemName' },
                    { title: '归口下达单元', dataIndex: 'ownerUnitOrgName', width: 150 },
                    { title: '实际承办法人', dataIndex: 'undertakeOrgName', width: 150 },
                    { title: '批复金额(元)', dataIndex: 'approvedAmount', width: 140, align: 'right', render: (v: string) => <Money value={v} /> },
                  ]}
                />
              </Card>
            )}
          </Space>
        )
      )}
    </Drawer>
  );
}

export function PlanCyclesTab({
  year,
  sheetLabels,
}: {
  year: number;
  sheetLabels: Record<PlanSheetCode, string>;
}) {
  const { message, modal } = AntdApp.useApp();
  const qc = useQueryClient();
  const allOrgs = getSession()?.user.allOrgs ?? false;
  const canManage = can('plan:write') && allOrgs;
  const readable = can('plan:read');

  const [selectedCycleId, setSelectedCycleId] = useState<number | null>(null);
  const [createOpen, setCreateOpen] = useState(false);
  const [cycleDraftApplied, setCycleDraftApplied] = useState(false);
  const [packDrawerId, setPackDrawerId] = useState<number | null>(null);
  const [reconcileMode, setReconcileMode] = useState<'legacy_reconcile' | 'strict_compile'>('legacy_reconcile');
  const [form] = Form.useForm();

  useEffect(() => {
    if (!createOpen) setCycleDraftApplied(false);
  }, [createOpen]);

  useAssistantDraft(createOpen, `plan:cycle:new:${year}`, () => {
    const v = form.getFieldsValue(true) as Record<string, unknown>;
    return {
      kind: 'plan_issuance_draft',
      base: { operation: 'create', clientKey: 'new-plan-cycle' },
      changes: compact({
        year: v.year ?? year,
        cycleCode: v.cycleCode,
        issuanceStage: v.issuanceStage ?? 'official',
      }),
    };
  });

  useEffect(() => {
    if (!createOpen) return;
    const onApply = (event: Event) => {
      const detail = (event as CustomEvent<{ kind?: string; suggestedFields?: Record<string, unknown> }>).detail;
      if (!detail || detail.kind !== 'plan_issuance_draft' || !detail.suggestedFields) return;
      const sf = detail.suggestedFields;
      const patch: Record<string, unknown> = {};
      for (const k of ['year', 'cycleCode', 'issuanceStage'] as const) {
        if (sf[k] !== undefined && sf[k] !== null && sf[k] !== '') patch[k] = sf[k];
      }
      if (Object.keys(patch).length > 0) form.setFieldsValue(patch);
      setCycleDraftApplied(true);
    };
    window.addEventListener('newfc:assistant-apply-draft', onApply);
    return () => window.removeEventListener('newfc:assistant-apply-draft', onApply);
  }, [createOpen, form]);

  const cyclesQ = useQuery({
    queryKey: ['plan-issuance-cycles', year],
    queryFn: () => planApi.cycles({ year }),
  });
  const cycles = cyclesQ.data?.items ?? [];

  useEffect(() => {
    if (cycles.length > 0 && (selectedCycleId == null || !cycles.some((c) => c.id === selectedCycleId))) {
      setSelectedCycleId(cycles[0].id);
    }
  }, [cycles, selectedCycleId]);

  const detailQ = useQuery({
    queryKey: ['plan-issuance-cycle', selectedCycleId],
    queryFn: () => planApi.cycle(selectedCycleId!),
    enabled: selectedCycleId != null,
  });
  const cycle: PlanIssuanceCycleDto | undefined = detailQ.data;
  const report: PlanReconcileReportDto | null = cycle?.reconcileReport ?? null;

  const planBatchesQ = useQuery({
    queryKey: ['plan-batches', year],
    queryFn: () => planApi.batches({ year }),
    enabled: createOpen,
  });
  const budgetVersionsQ = useQuery({
    queryKey: ['versions', year],
    queryFn: () => api.get<{ id: number; name: string; year: number }[]>(`/versions?year=${year}`),
    enabled: createOpen && can('budget:read'),
  });

  const refresh = () => {
    void qc.invalidateQueries({ queryKey: ['plan-issuance-cycles'] });
    void qc.invalidateQueries({ queryKey: ['plan-issuance-cycle'] });
    void qc.invalidateQueries({ queryKey: ['plan-issuance-packs'] });
    void qc.invalidateQueries({ queryKey: ['workbench-todos'] });
  };

  const createMut = useMutation({
    mutationFn: (v: Record<string, unknown>) => {
      const body: PlanIssuanceCycleCreateRequest = compact({
        year: Number(v.year ?? year),
        cycleCode: String(v.cycleCode ?? '').trim(),
        issuanceStage: (v.issuanceStage as PlanIssuanceStage) ?? 'official',
        sourcePlanBatchId: v.sourcePlanBatchId ? Number(v.sourcePlanBatchId) : null,
        sourceBudgetVersionId: v.sourceBudgetVersionId ? Number(v.sourceBudgetVersionId) : null,
        issuedDate: v.issuedDate ? String(v.issuedDate) : null,
        docNoPrefix: v.docNoPrefix ? String(v.docNoPrefix).trim() : undefined,
        decisionDocMeta: compact({
          partyCommitteeDocNo: v.partyCommitteeDocNo ? String(v.partyCommitteeDocNo).trim() : undefined,
          gmOfficeDocNo: v.gmOfficeDocNo ? String(v.gmOfficeDocNo).trim() : undefined,
          boardDocNo: v.boardDocNo ? String(v.boardDocNo).trim() : undefined,
        }),
      }) as PlanIssuanceCycleCreateRequest;
      return planApi.createCycle(body);
    },
    onSuccess: (created) => {
      message.success(`已创建合一下达周期 ${created.cycleCode}`);
      setCreateOpen(false);
      setSelectedCycleId(created.id);
      refresh();
    },
    onError: (e) => message.error(errorText(e)),
  });

  const reconcileMut = useMutation({
    mutationFn: (id: number) => planApi.reconcileCycle(id, { mode: reconcileMode }),
    onSuccess: (res) => {
      if (res.passed && res.blockingCount === 0 && res.crossUnitFormulaErrors.length === 0) {
        message.success('跨模块合并、含税/不含税(÷1.06)与五项费用稽核通过');
      } else {
        message.warning(`稽核检出 ${res.blockingCount + res.crossUnitFormulaErrors.length} 项阻断问题，请先消缺`);
      }
      refresh();
    },
    onError: (e) => message.error(errorText(e)),
  });

  const publishMut = useMutation({
    mutationFn: (id: number) => planApi.publishCycle(id),
    onSuccess: (published) => {
      message.success(`周期 ${published.cycleCode} 已正式发布下达，已向各单元推送签收待办`);
      refresh();
    },
    onError: (e) => message.error(errorText(e)),
  });

  const hasCrossRefBlocking = (report?.crossUnitFormulaErrors?.length ?? 0) > 0;
  const canPublish =
    canManage &&
    cycle?.status === 'draft' &&
    !!report &&
    report.passed &&
    report.blockingCount === 0 &&
    !hasCrossRefBlocking;

  void sheetLabels;

  return (
    <Space direction="vertical" style={{ width: '100%' }} size={12}>
      <Space wrap style={{ justifyContent: 'space-between', width: '100%' }}>
        <Space wrap>
          <span>下达周期：</span>
          <Select
            aria-label="选择下达周期"
            placeholder="请选择或创建下达周期"
            style={{ width: 280 }}
            value={selectedCycleId ?? undefined}
            onChange={setSelectedCycleId}
            options={cycles.map((c) => ({
              value: c.id,
              label: `${c.cycleCode} · ${ISSUANCE_STAGE_LABELS[c.issuanceStage]} (${CYCLE_STATUS_META[c.status].text})`,
            }))}
          />
          {canManage && (
            <Select
              value={reconcileMode}
              onChange={setReconcileMode}
              style={{ width: 170 }}
              options={[
                { value: 'legacy_reconcile', label: '容差归因核对模式' },
                { value: 'strict_compile', label: '严格零差编制模式' },
              ]}
            />
          )}
          {canManage && cycle && (
            <Button
              loading={reconcileMut.isPending}
              onClick={() => reconcileMut.mutate(cycle.id)}
            >
              运行合并与税率/五项费用稽核
            </Button>
          )}
          {canManage && cycle && (
            <Button
              type="primary"
              disabled={!canPublish}
              loading={publishMut.isPending}
              onClick={() =>
                modal.confirm({
                  title: `确认正式发布下达周期「${cycle.cycleCode}」？`,
                  content: '发布后将冻结本周期下达快照，并向各归口下达单元生成正式签收任务。',
                  okText: '确认发布下达',
                  onOk: () => publishMut.mutateAsync(cycle.id),
                })
              }
            >
              正式发布下达
            </Button>
          )}
        </Space>
        <Space wrap>
          {readable && allOrgs && cycle && (
            <Button
              onClick={() =>
                void download(planApi.exportCycleZipPath(cycle.id), `综合计划与预算合一下达全包_${cycle.cycleCode}.zip`)
              }
            >
              打包下载全集团下达公文包 (.zip)
            </Button>
          )}
          {canManage && (
            <Button type="primary" onClick={() => { form.resetFields(); setCreateOpen(true); }}>
              创建下达周期
            </Button>
          )}
        </Space>
      </Space>

      {cyclesQ.error && <QueryErrorResult title="下达周期加载失败" error={cyclesQ.error} refetch={cyclesQ.refetch} />}

      {cycle && (
        <>
          {hasCrossRefBlocking && (
            <Alert
              type="error"
              showIcon
              message={`阻断发布：检出跨单位单元格公式错引 (CROSS_UNIT_CELL_REF) 共 ${report!.crossUnitFormulaErrors.length} 处`}
              description={
                <ul style={{ margin: 0, paddingLeft: 18 }}>
                  {report!.crossUnitFormulaErrors.map((err, i) => (
                    <li key={i}>
                      <Tag color="error">{err.code}</Tag> [{err.sheet} 第{err.row}行] {err.message}
                    </li>
                  ))}
                </ul>
              }
            />
          )}

          {report && !hasCrossRefBlocking && (!report.passed || report.blockingCount > 0) && (
            <Alert
              type="error"
              showIcon
              message={`阻断发布：存在 ${report.blockingCount} 项未解释算术或勾稽失衡，修正并重跑稽核通过后方可发布下达`}
            />
          )}

          {cycle.excludedOrgs.length > 0 && (
            <Alert
              type="info"
              showIcon
              message={`合并总表调节项提示：${cycle.excludedOrgs.map((o) => `${o.name}(${o.code})`).join('、')} 标记为不单发下达通知 (isPlanExcluded=1)，仅计入集团合并总表调节项，不生成独立单元下达包。`}
            />
          )}

          {report && (
            <Card
              size="small"
              title={
                <Space>
                  <span>四层数值语义合并对账 & 含税/不含税(÷1.06) · 五项费用稽核报告</span>
                  <Tag color={report.passed && report.blockingCount === 0 && !hasCrossRefBlocking ? 'success' : 'error'}>
                    {report.passed && report.blockingCount === 0 && !hasCrossRefBlocking ? '稽核通过' : `阻断 ${report.blockingCount + report.crossUnitFormulaErrors.length} 项`}
                  </Tag>
                  {report.warningCount > 0 && <Tag color="warning">尾差归因提示 {report.warningCount} 项</Tag>}
                </Space>
              }
            >
              <Descriptions size="small" bordered column={{ xs: 1, sm: 2, lg: 3 }} style={{ marginBottom: 12 }}>
                <Descriptions.Item label="下达单元汇总营业总收入">
                  <Money value={report.consolidation.sum8UnitsOperatingRevenue} />
                </Descriptions.Item>
                <Descriptions.Item label="不单发通知调节主体收入">
                  <Money value={report.consolidation.excludedOrgsOperatingRevenue} />
                </Descriptions.Item>
                <Descriptions.Item label="集团合并总表营业总收入 (差额)">
                  <Money value={report.consolidation.groupConsolidatedOperatingRevenue} />{' '}
                  <Tag>{report.consolidation.operatingRevenueSubCentDiff} 元</Tag>
                </Descriptions.Item>
                <Descriptions.Item label="下达单元汇总利润总额">
                  <Money value={report.consolidation.sum8UnitsProfitBeforeTax} />
                </Descriptions.Item>
                <Descriptions.Item label="不单发通知调节主体利润">
                  <Money value={report.consolidation.excludedOrgsProfitBeforeTax} />
                </Descriptions.Item>
                <Descriptions.Item label="集团合并总表利润总额 (差额)">
                  <Money value={report.consolidation.groupConsolidatedProfitBeforeTax} />{' '}
                  <Tag>{report.consolidation.profitDiff} 元</Tag>
                </Descriptions.Item>
                <Descriptions.Item label="固定资产投资总计">
                  <Money value={report.consolidation.investmentTotal} />
                </Descriptions.Item>
                <Descriptions.Item label="安全生产投入总计">
                  <Money value={report.consolidation.safetyInputTotal} />
                </Descriptions.Item>
                <Descriptions.Item label="五项费用 (精确计算 vs 两位万元批复)">
                  <Money value={report.consolidation.fiveExpensesExactTotal} /> vs{' '}
                  <Money value={report.consolidation.fiveExpensesIssuedTotal} />{' '}
                  <Tag color="blue">步长差 {report.consolidation.fiveExpensesStepDiff} 元</Tag>
                </Descriptions.Item>
              </Descriptions>

              <Table<PlanTaxCheckItemDto>
                rowKey={(r) => `${r.unitOrgId ?? 'grp'}-${r.kind}-${r.reasonCode}-${r.message}`}
                size="small"
                pagination={false}
                dataSource={report.checks}
                columns={[
                  { title: '单元', dataIndex: 'unitName', width: 130 },
                  { title: '稽核维度', dataIndex: 'kind', width: 240, render: (k: PlanTaxCheckItemDto['kind']) => CHECK_KIND_LABELS[k] ?? k },
                  { title: '含税计划/左侧值', dataIndex: 'planInclusiveAmount', width: 130, align: 'right', render: (v: string | null) => (v ? <Money value={v} /> : '—') },
                  { title: '理论不含税/右侧值', dataIndex: 'expectedBudgetExclAmount', width: 135, align: 'right', render: (v: string | null) => (v ? <Money value={v} /> : '—') },
                  { title: '实列核对值', dataIndex: 'actualBudgetExclAmount', width: 130, align: 'right', render: (v: string | null) => (v ? <Money value={v} /> : '—') },
                  { title: '到分差额', dataIndex: 'diffAmount', width: 110, align: 'right', render: (v: string) => <Money value={v} tone /> },
                  { title: '归因码', dataIndex: 'reasonCode', width: 170, render: (v: string) => <Tag>{v}</Tag> },
                  {
                    title: '结论',
                    key: 'res',
                    width: 90,
                    render: (_, r) =>
                      r.blocking ? <Tag color="error">阻断</Tag> : r.passed ? <Tag color="success">通过</Tag> : <Tag color="warning">提示</Tag>,
                  },
                  { title: '说明', dataIndex: 'message', ellipsis: true },
                ]}
              />
            </Card>
          )}

          <Card
            size="small"
            title={`分单位合一下达包（共 ${cycle.packs?.length ?? cycle.unitPackCount} 个单元 · 已签收 ${cycle.acknowledgedCount} 个）`}
          >
            <Table<PlanUnitPackDto>
              rowKey="id"
              size="small"
              pagination={false}
              dataSource={cycle.packs ?? []}
              scroll={{ x: 1200 }}
              columns={[
                {
                  title: '归口下达单元',
                  key: 'unit',
                  width: 190,
                  render: (_, p) => (
                    <div>
                      <Typography.Text strong>{p.unitOrgName}</Typography.Text>
                      {p.mergedChildOrgs.length > 0 && (
                        <div style={{ fontSize: 12, color: 'var(--newfc-text-tertiary)' }}>
                          含：{p.mergedChildOrgs.map((c) => c.name).join('、')}
                        </div>
                      )}
                    </div>
                  ),
                },
                { title: '发文字号', dataIndex: 'docNo', width: 150, render: (v: string) => v || '—' },
                { title: '附表数', dataIndex: 'attachmentCount', width: 75, align: 'right' },
                {
                  title: '目标责任书',
                  key: 'resp',
                  width: 140,
                  render: (_, p) =>
                    p.hasResponsibilityLetter ? <Tag color="blue">{p.responsibilityLetterNo || '含责任书'}</Tag> : <Tag>无(本部)</Tag>,
                },
                { title: '营业总收入', key: 'rev', width: 135, align: 'right', render: (_, p) => <Money value={p.metrics.operatingRevenue} /> },
                { title: '利润总额', key: 'prof', width: 125, align: 'right', render: (_, p) => <Money value={p.metrics.profitBeforeTax} /> },
                { title: '五项费用(批复)', key: 'five', width: 130, align: 'right', render: (_, p) => <Money value={p.metrics.fiveExpensesIssued} /> },
                {
                  title: '签收状态',
                  dataIndex: 'signOffStatus',
                  width: 105,
                  render: (s: PlanPackSignStatus) => <Tag color={PACK_STATUS_META[s].color}>{PACK_STATUS_META[s].text}</Tag>,
                },
                {
                  title: '签收人 / 时间',
                  key: 'ack',
                  width: 155,
                  render: (_, p) => (p.ackAt ? `${p.ackUserName ?? ''} · ${shortTime(p.ackAt)}` : '—'),
                },
                {
                  title: '操作',
                  key: 'op',
                  width: 200,
                  render: (_, p) => (
                    <Space size={4}>
                      <Button size="small" onClick={() => setPackDrawerId(p.id)}>
                        详情
                      </Button>
                      {readable && (
                        <Button
                          size="small"
                          onClick={() =>
                            void download(planApi.exportPackDocxPath(p.id), `综合计划与预算下达通知_${p.unitOrgName}.docx`)
                          }
                        >
                          导出 .docx
                        </Button>
                      )}
                    </Space>
                  ),
                },
              ]}
            />
          </Card>
        </>
      )}

      <PackDetailDrawer packId={packDrawerId} onClose={() => setPackDrawerId(null)} />

      <Modal
        open={createOpen}
        title="创建年度综合计划与预算合一下达周期"
        width={680}
        onCancel={() => setCreateOpen(false)}
        confirmLoading={createMut.isPending}
        destroyOnClose
        onOk={() => form.validateFields().then((v) => createMut.mutate(v), () => undefined)}
      >
        <Space wrap style={{ marginBottom: 8 }}>
          <ConfigFormAssistant kind="plan_issuance_draft" form={form} />
          {cycleDraftApplied && <Tag color="processing">助手建议草稿 · 待人工确认</Tag>}
        </Space>
        <Form
          form={form}
          layout="vertical"
          preserve={false}
          initialValues={{ year, cycleCode: `${year}-FORMAL`, issuanceStage: 'official', docNoPrefix: `集团企〔${year}〕` }}
        >
          <Row gutter={12}>
            <Col span={8}>
              <Form.Item name="year" label="下达年度" rules={[{ required: true }]}>
                <InputNumber min={2000} max={2100} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="cycleCode" label="周期编码" rules={[{ required: true, whitespace: true }]}>
                <Input placeholder="如 2026-PRE / 2026-FORMAL" maxLength={64} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="issuanceStage" label="下达阶段" rules={[{ required: true }]}>
                <Select options={Object.entries(ISSUANCE_STAGE_LABELS).map(([value, label]) => ({ value, label }))} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="sourcePlanBatchId" label="关联综合计划导入批次">
                <Select
                  allowClear
                  placeholder="缺省取当前生效批次"
                  options={(planBatchesQ.data ?? []).map((b) => ({
                    value: b.id,
                    label: `#${b.id} ${b.fileName} (${b.actualPeriod}${b.isCurrent ? ' · 当前' : ''})`,
                  }))}
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="sourceBudgetVersionId" label="关联经营预算版本">
                <Select
                  allowClear
                  placeholder="缺省关联当前年度预算版本"
                  options={(budgetVersionsQ.data ?? []).map((v) => ({ value: v.id, label: `${v.name} (${v.year})` }))}
                />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item name="docNoPrefix" label="发文字号前缀">
                <Input placeholder="如 集团企〔2026〕" maxLength={64} />
              </Form.Item>
            </Col>
            <Col span={12}>
              <Form.Item
                name="issuedDate"
                label="发文日期"
                getValueProps={(v?: string) => ({ value: v ? dayjs(v) : null })}
                normalize={(d: dayjs.Dayjs | null) => (d ? d.format('YYYY-MM-DD') : null)}
              >
                <DatePicker style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="partyCommitteeDocNo" label="党组前置纪要文号">
                <Input maxLength={80} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="gmOfficeDocNo" label="总经理办公会纪要文号">
                <Input maxLength={80} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="boardDocNo" label="董事会决议文号">
                <Input maxLength={80} />
              </Form.Item>
            </Col>
          </Row>
        </Form>
      </Modal>
    </Space>
  );
}

export function PlanPacksTab({
  year,
  initialStatus,
}: {
  year: number;
  initialStatus?: string;
}) {
  const { message } = AntdApp.useApp();
  const qc = useQueryClient();
  const [view, setView] = useState<'unit' | 'undertake'>('unit');
  const [statusFilter, setStatusFilter] = useState<string | undefined>(initialStatus);
  const [drawerPackId, setDrawerPackId] = useState<number | null>(null);
  const [ackTarget, setAckTarget] = useState<PlanUnitPackDto | null>(null);
  const [ackForm] = Form.useForm<{ ackNote?: string }>();

  useEffect(() => {
    if (initialStatus !== undefined) setStatusFilter(initialStatus || undefined);
  }, [initialStatus]);

  const packsQ = useQuery({
    queryKey: ['plan-issuance-packs', year, statusFilter, view],
    queryFn: () => planApi.packs({ year, status: statusFilter, view }),
  });

  const ackMut = useMutation({
    mutationFn: ({ pack, ackNote }: { pack: PlanUnitPackDto; ackNote?: string }) =>
      planApi.acknowledgePack(pack.id, {
        expectedVersion: pack.version,
        ackNote: ackNote?.trim() || undefined,
      }),
    onSuccess: (updated) => {
      message.success(`已完成「${updated.unitOrgName}」下达包签收确认`);
      setAckTarget(null);
      void qc.invalidateQueries({ queryKey: ['plan-issuance-packs'] });
      void qc.invalidateQueries({ queryKey: ['plan-issuance-pack'] });
      void qc.invalidateQueries({ queryKey: ['plan-issuance-cycle'] });
      void qc.invalidateQueries({ queryKey: ['workbench-todos'] });
    },
    onError: (e) => message.error(errorText(e)),
  });

  return (
    <Space direction="vertical" style={{ width: '100%' }} size={12}>
      <Space wrap>
        <Segmented<'unit' | 'undertake'>
          value={view}
          onChange={setView}
          options={[
            { value: 'unit', label: '按归口下达单元视角' },
            { value: 'undertake', label: '按实际承办法人视角' },
          ]}
        />
        <Select
          allowClear
          placeholder="签收状态"
          style={{ width: 150 }}
          value={statusFilter}
          onChange={setStatusFilter}
          options={Object.entries(PACK_STATUS_META).map(([value, m]) => ({ value, label: m.text }))}
        />
      </Space>

      {packsQ.error ? (
        <QueryErrorResult title="本单位下达包加载失败" error={packsQ.error} refetch={packsQ.refetch} />
      ) : (
        <Table<PlanUnitPackDto>
          rowKey="id"
          size="small"
          loading={packsQ.isLoading}
          dataSource={packsQ.data?.items ?? []}
          pagination={false}
          columns={[
            {
              title: '归口下达单元',
              key: 'unit',
              width: 200,
              render: (_, p) => (
                <div>
                  <Typography.Text strong>{p.unitOrgName}</Typography.Text>
                  {p.mergedChildOrgs.length > 0 && (
                    <div style={{ fontSize: 12, color: 'var(--newfc-text-tertiary)' }}>
                      归并：{p.mergedChildOrgs.map((c) => c.name).join('、')}
                    </div>
                  )}
                </div>
              ),
            },
            { title: '发文字号', dataIndex: 'docNo', width: 160, render: (v: string) => v || '—' },
            {
              title: '目标责任书',
              key: 'resp',
              width: 150,
              render: (_, p) =>
                p.hasResponsibilityLetter ? <Tag color="blue">{p.responsibilityLetterNo || '含责任书'}</Tag> : <Tag>无(本部)</Tag>,
            },
            { title: '营业总收入', key: 'rev', width: 135, align: 'right', render: (_, p) => <Money value={p.metrics.operatingRevenue} /> },
            { title: '固定资产投资', key: 'inv', width: 135, align: 'right', render: (_, p) => <Money value={p.metrics.investmentTotal} /> },
            { title: '可控管理费(批复)', key: 'cm', width: 145, align: 'right', render: (_, p) => <Money value={p.metrics.controllableMgmtFeeIssued} /> },
            {
              title: '签收状态',
              dataIndex: 'signOffStatus',
              width: 110,
              render: (s: PlanPackSignStatus) => <Tag color={PACK_STATUS_META[s].color}>{PACK_STATUS_META[s].text}</Tag>,
            },
            {
              title: '操作',
              key: 'op',
              width: 270,
              render: (_, p) => (
                <Space size={4} wrap>
                  <Button size="small" onClick={() => setDrawerPackId(p.id)}>
                    查看详情
                  </Button>
                  {can('plan:read') && (
                    <Button
                      size="small"
                      onClick={() =>
                        void download(planApi.exportPackDocxPath(p.id), `综合计划与预算下达通知_${p.unitOrgName}.docx`)
                      }
                    >
                      导出下达公文及责任书 (.docx)
                    </Button>
                  )}
                  {p.signOffStatus === 'issued' && can('plan:write') && (
                    <Button
                      size="small"
                      type="primary"
                      onClick={() => {
                        ackForm.resetFields();
                        setAckTarget(p);
                      }}
                    >
                      确认签收
                    </Button>
                  )}
                </Space>
              ),
            },
          ]}
        />
      )}

      <PackDetailDrawer
        packId={drawerPackId}
        onClose={() => setDrawerPackId(null)}
        onAckClick={(p) => {
          setDrawerPackId(null);
          ackForm.resetFields();
          setAckTarget(p);
        }}
      />

      <Modal
        open={ackTarget != null}
        title={ackTarget ? `确认签收「${ackTarget.unitOrgName}」年度计划与预算下达包` : '确认签收'}
        onCancel={() => setAckTarget(null)}
        confirmLoading={ackMut.isPending}
        destroyOnClose
        okText="确认签收"
        onOk={() =>
          ackForm.validateFields().then((v) => {
            if (ackTarget) ackMut.mutate({ pack: ackTarget, ackNote: v.ackNote });
          }, () => undefined)
        }
      >
        <Alert
          type="info"
          showIcon
          style={{ marginBottom: 12 }}
          message="签收后本单位年度综合计划与关联经营预算指标正式生效，可作为项目预算编制与合同立项限额依据。"
        />
        <Form form={ackForm} layout="vertical" preserve={false}>
          <Form.Item name="ackNote" label="签收备注（可选）">
            <Input.TextArea rows={3} maxLength={500} placeholder="如 经本单位经营班子核对无异议，予以签收执行" />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}

export function PlanAdjustmentsTab({
  year,
  initialStatus,
  sheetLabels,
}: {
  year: number;
  initialStatus?: string;
  sheetLabels: Record<PlanSheetCode, string>;
}) {
  const { message } = AntdApp.useApp();
  const qc = useQueryClient();
  const session = getSession();
  const allOrgs = session?.user.allOrgs ?? false;
  const currentUserId = session?.user.id ?? null;
  const writable = can('plan:write');
  const canReview = writable && allOrgs;

  const [statusFilter, setStatusFilter] = useState<string | undefined>(initialStatus);
  const [createOpen, setCreateOpen] = useState(false);
  const [adjDraftApplied, setAdjDraftApplied] = useState(false);
  const [reviewTarget, setReviewTarget] = useState<PlanAdjustmentDto | null>(null);
  const [form] = Form.useForm();
  const [reviewForm] = Form.useForm();

  useEffect(() => {
    if (initialStatus !== undefined) setStatusFilter(initialStatus || undefined);
  }, [initialStatus]);

  const listQ = useQuery({
    queryKey: ['plan-issuance-adjustments', statusFilter],
    queryFn: () => planApi.adjustments({ status: statusFilter }),
  });
  const cyclesQ = useQuery({
    queryKey: ['plan-issuance-cycles', year],
    queryFn: () => planApi.cycles({ year }),
    enabled: createOpen,
  });
  const selectedCycleId = Form.useWatch('cycleId', form) as number | undefined;
  const packsQ = useQuery({
    queryKey: ['plan-issuance-packs-for-adj', selectedCycleId],
    queryFn: () => planApi.packs({ cycleId: selectedCycleId }),
    enabled: createOpen && selectedCycleId != null,
  });

  const adjustTypeWatch = Form.useWatch('adjustType', form) as PlanAdjustType | undefined;
  const exceedsWatch = Boolean(Form.useWatch('exceedsOverallTarget', form));
  const emergencyDateWatch = Form.useWatch('emergencyStartDate', form) as string | undefined;
  const linesWatch = (Form.useWatch('lines', form) ?? []) as Partial<PlanAdjustmentLineInput>[];
  const reviewActionWatch = (Form.useWatch('action', reviewForm) ?? 'approve') as 'approve' | 'reject';
  const reviewExceptionWatch = (Form.useWatch('exceptionReason', reviewForm) ?? '') as string;

  useEffect(() => {
    if (!createOpen) setAdjDraftApplied(false);
  }, [createOpen]);

  useAssistantDraft(createOpen, `plan:adjust:new:${year}`, () => {
    const v = form.getFieldsValue(true) as Record<string, unknown>;
    return {
      kind: 'plan_issuance_draft',
      base: { operation: 'adjust', clientKey: 'new-plan-adjust' },
      changes: compact({
        unitPackId: v.unitPackId,
        adjustType: v.adjustType,
        exceedsOverallTarget: v.exceedsOverallTarget,
        emergencyStartDate: v.emergencyStartDate,
        decisionDocNo: v.decisionDocNo,
        reason: v.reason,
      }),
    };
  });

  useEffect(() => {
    if (!createOpen) return;
    const onApply = (event: Event) => {
      const detail = (event as CustomEvent<{ kind?: string; suggestedFields?: Record<string, unknown> }>).detail;
      if (!detail || detail.kind !== 'plan_issuance_draft' || !detail.suggestedFields) return;
      const sf = detail.suggestedFields;
      const patch: Record<string, unknown> = {};
      for (const k of ['unitPackId', 'adjustType', 'exceedsOverallTarget', 'emergencyStartDate', 'decisionDocNo', 'reason'] as const) {
        if (sf[k] !== undefined && sf[k] !== null && sf[k] !== '') patch[k] = sf[k];
      }
      if (!patch.unitPackId && sf.unitOrgId != null && !form.getFieldValue('unitPackId')) {
        const matchedPack = (packsQ.data?.items ?? []).find((p) => p.unitOrgId === Number(sf.unitOrgId));
        if (matchedPack) patch.unitPackId = matchedPack.id;
      }
      if (Object.keys(patch).length > 0) form.setFieldsValue(patch);
      setAdjDraftApplied(true);
    };
    window.addEventListener('newfc:assistant-apply-draft', onApply);
    return () => window.removeEventListener('newfc:assistant-apply-draft', onApply);
  }, [createOpen, form, packsQ.data?.items]);

  const previewApprovalBody = useMemo(
    () => deriveApprovalBodyPreview(adjustTypeWatch, exceedsWatch),
    [adjustTypeWatch, exceedsWatch],
  );
  const emergencyWeekdays = useMemo(
    () => (adjustTypeWatch === 'emergency_retroactive' ? countWeekdaysSince(emergencyDateWatch) : 0),
    [adjustTypeWatch, emergencyDateWatch],
  );

  const isSelfReview =
    reviewTarget != null &&
    currentUserId != null &&
    reviewTarget.submittedByUserId === currentUserId;

  const createMut = useMutation({
    mutationFn: (v: Record<string, unknown>) => {
      const rawLines = (v.lines as PlanAdjustmentLineInput[]) ?? [];
      const body: PlanAdjustmentCreateRequest = {
        cycleId: Number(v.cycleId),
        unitPackId: Number(v.unitPackId),
        adjustType: v.adjustType as PlanAdjustType,
        decisionDocNo: v.decisionDocNo ? String(v.decisionDocNo).trim() : undefined,
        decisionAttachmentId: v.decisionAttachmentId ? Number(v.decisionAttachmentId) : null,
        emergencyStartDate: v.emergencyStartDate ? String(v.emergencyStartDate) : null,
        exceedsOverallTarget: Boolean(v.exceedsOverallTarget),
        reason: String(v.reason ?? '').trim(),
        lines: rawLines.map((ln) => {
          const meta = VALUE_TYPE_OPTIONS.find((o) => o.value === ln.valueType) ?? VALUE_TYPE_OPTIONS[0];
          return {
            targetSheetCode: ln.targetSheetCode,
            targetItemName: String(ln.targetItemName ?? '').trim(),
            valueType: ln.valueType ?? 'amount_cents',
            scale: ln.scale ?? meta.scale,
            unit: ln.unit ?? meta.defaultUnit,
            beforeVal: String(ln.beforeVal ?? '0').trim(),
            afterVal: String(ln.afterVal ?? '0').trim(),
            note: ln.note ? String(ln.note).trim() : undefined,
          };
        }),
      };
      return planApi.createAdjustment(body);
    },
    onSuccess: (created) => {
      message.success(`已提交计划与预算联动调整申请 #${created.id}`);
      setCreateOpen(false);
      void qc.invalidateQueries({ queryKey: ['plan-issuance-adjustments'] });
      void qc.invalidateQueries({ queryKey: ['plan-issuance-packs'] });
      void qc.invalidateQueries({ queryKey: ['workbench-todos'] });
    },
    onError: (e) => message.error(errorText(e)),
  });

  const reviewMut = useMutation({
    mutationFn: (v: Record<string, unknown>) =>
      planApi.reviewAdjustment(reviewTarget!.id, {
        action: v.action as 'approve' | 'reject',
        decisionDocNo: v.decisionDocNo ? String(v.decisionDocNo).trim() : undefined,
        decisionAttachmentId: v.decisionAttachmentId ? Number(v.decisionAttachmentId) : null,
        comment: v.comment ? String(v.comment).trim() : undefined,
        exceptionReason: v.exceptionReason ? String(v.exceptionReason).trim() : undefined,
      }),
    onSuccess: (res) => {
      message.success(res.status === 'approved' ? `调整申请已批准，生成修订周期 #${res.newCycleId}` : '调整申请已驳回');
      setReviewTarget(null);
      void qc.invalidateQueries({ queryKey: ['plan-issuance-adjustments'] });
      void qc.invalidateQueries({ queryKey: ['plan-issuance-cycles'] });
      void qc.invalidateQueries({ queryKey: ['plan-issuance-packs'] });
      void qc.invalidateQueries({ queryKey: ['workbench-todos'] });
    },
    onError: (e) => message.error(errorText(e)),
  });

  return (
    <Space direction="vertical" style={{ width: '100%' }} size={12}>
      <Space wrap style={{ justifyContent: 'space-between', width: '100%' }}>
        <Select
          allowClear
          placeholder="审批状态"
          style={{ width: 150 }}
          value={statusFilter}
          onChange={setStatusFilter}
          options={[
            { value: 'submitted', label: '待复核' },
            { value: 'approved', label: '已批准' },
            { value: 'rejected', label: '已驳回' },
          ]}
        />
        {writable && (
          <Button
            type="primary"
            onClick={() => {
              form.resetFields();
              setCreateOpen(true);
            }}
          >
            发起调整申请
          </Button>
        )}
      </Space>

      {listQ.error ? (
        <QueryErrorResult title="计划调整申请加载失败" error={listQ.error} refetch={listQ.refetch} />
      ) : (
        <Table<PlanAdjustmentDto>
          rowKey="id"
          size="small"
          loading={listQ.isLoading}
          dataSource={listQ.data?.items ?? []}
          scroll={{ x: 1180 }}
          expandable={{
            expandedRowRender: (adj) => (
              <Table
                rowKey="id"
                size="small"
                pagination={false}
                dataSource={adj.lines}
                columns={[
                  { title: '目标工作表', dataIndex: 'targetSheetCode', width: 150, render: (c: PlanSheetCode) => sheetLabels[c] ?? c },
                  { title: '调整项目/指标', dataIndex: 'targetItemName' },
                  { title: '单位', dataIndex: 'unit', width: 80 },
                  { title: '调整前', dataIndex: 'beforeVal', width: 120, align: 'right' },
                  { title: '调整后', dataIndex: 'afterVal', width: 120, align: 'right' },
                  { title: '增减变化 (delta)', dataIndex: 'deltaVal', width: 130, align: 'right' },
                  { title: '说明', dataIndex: 'note', ellipsis: true },
                ]}
              />
            ),
          }}
          columns={[
            { title: '申请#', dataIndex: 'id', width: 70 },
            { title: '原周期', dataIndex: 'cycleCode', width: 125 },
            { title: '申请单位', dataIndex: 'unitOrgName', width: 140 },
            { title: '调整类型', dataIndex: 'adjustTypeLabel', width: 210 },
            {
              title: '法定审定机构(服务端锁定)',
              dataIndex: 'approvalBodyLabel',
              width: 195,
              render: (v: string, r) => <Tag color="geekblue">{v || APPROVAL_BODY_LABELS[r.approvalBody]}</Tag>,
            },
            { title: '决策文号', dataIndex: 'decisionDocNo', width: 150, render: (v: string) => v || '—' },
            {
              title: '应急开工 / 时限',
              key: 'emg',
              width: 175,
              render: (_, r) =>
                r.emergencyStartDate ? (
                  <Space size={4} wrap>
                    <span>{r.emergencyStartDate}</span>
                    {r.emergencyOverdue5Workdays && <Tag color="error">超5工作日补报预警</Tag>}
                  </Space>
                ) : (
                  '—'
                ),
            },
            {
              title: '状态',
              dataIndex: 'status',
              width: 90,
              render: (s: string) =>
                s === 'approved' ? <Tag color="success">已批准</Tag> : s === 'rejected' ? <Tag color="error">已驳回</Tag> : <Tag color="processing">待复核</Tag>,
            },
            {
              title: '修订新周期',
              dataIndex: 'newCycleId',
              width: 105,
              render: (v: number | null) => (v ? <Tag color="blue">周期 #{v}</Tag> : '—'),
            },
            {
              title: '操作',
              key: 'op',
              width: 95,
              render: (_, r) =>
                canReview && r.status === 'submitted' ? (
                  <Button
                    size="small"
                    type="primary"
                    onClick={() => {
                      reviewForm.resetFields();
                      reviewForm.setFieldsValue({
                        action: 'approve',
                        decisionDocNo: r.decisionDocNo || '',
                        decisionAttachmentId: r.decisionAttachmentId ?? undefined,
                      });
                      setReviewTarget(r);
                    }}
                  >
                    复核
                  </Button>
                ) : null,
            },
          ]}
        />
      )}

      <Modal
        open={createOpen}
        title="发起计划与预算联动调整申请"
        width={860}
        onCancel={() => setCreateOpen(false)}
        confirmLoading={createMut.isPending}
        destroyOnClose
        onOk={() => form.validateFields().then((v) => createMut.mutate(v), () => undefined)}
      >
        <Space wrap style={{ marginBottom: 8 }}>
          <ConfigFormAssistant kind="plan_issuance_draft" form={form} />
          {adjDraftApplied && <Tag color="processing">助手建议草稿 · 待人工确认</Tag>}
        </Space>
        <Form
          form={form}
          layout="vertical"
          preserve={false}
          initialValues={{
            adjustType: 'within_total_realloc',
            exceedsOverallTarget: false,
            lines: [{ targetSheetCode: 'investment', targetItemName: '', valueType: 'amount_cents', unit: '元', beforeVal: '0.00', afterVal: '0.00' }],
          }}
        >
          <Alert
            type="info"
            showIcon
            style={{ marginBottom: 12 }}
            message={
              <Space>
                <span>法定审定机构预览（服务端强制锁定，禁止前端降级）：</span>
                <Tag color="geekblue">{APPROVAL_BODY_LABELS[previewApprovalBody]}</Tag>
              </Space>
            }
          />
          {adjustTypeWatch === 'emergency_retroactive' && emergencyWeekdays > 5 && (
            <Alert
              type="error"
              showIcon
              style={{ marginBottom: 12 }}
              message={`超 5 工作日补报警示：应急开工日期距今已超 ${emergencyWeekdays} 个工作日（制度要求开工后 5 个工作日内补报集团立项），提交后将同步留痕预警。`}
            />
          )}
          <Row gutter={12}>
            <Col span={8}>
              <Form.Item name="cycleId" label="原下达周期" rules={[{ required: true, message: '请选择下达周期' }]}>
                <Select
                  placeholder="选择已发布周期"
                  options={(cyclesQ.data?.items ?? []).map((c) => ({ value: c.id, label: `${c.cycleCode} (${CYCLE_STATUS_META[c.status].text})` }))}
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="unitPackId" label="申请调整单元包" rules={[{ required: true, message: '请选择单元包' }]}>
                <Select
                  placeholder="选择本单位下达包"
                  options={(packsQ.data?.items ?? []).map((p) => ({ value: p.id, label: `${p.unitOrgName} (${p.docNo || '#' + p.id})` }))}
                />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="adjustType" label="调整类型" rules={[{ required: true }]}>
                <Select options={Object.entries(ADJUST_TYPE_LABELS).map(([value, label]) => ({ value, label }))} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="decisionDocNo" label="决策纪要/批复文号">
                <Input maxLength={120} placeholder="如 集团总办纪〔2026〕08号" />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="decisionAttachmentId" label="决策附件ID(可选)">
                <InputNumber min={1} style={{ width: '100%' }} />
              </Form.Item>
            </Col>
            <Col span={8}>
              <Form.Item name="exceedsOverallTarget" label="突破集团年度总体指标" valuePropName="checked">
                <Checkbox>突破总体经营/产能/总额控制指标</Checkbox>
              </Form.Item>
            </Col>
            {adjustTypeWatch === 'emergency_retroactive' && (
              <Col span={8}>
                <Form.Item
                  name="emergencyStartDate"
                  label="应急先开工日期"
                  rules={[{ required: true, message: '请选择应急开工日期' }]}
                  getValueProps={(v?: string) => ({ value: v ? dayjs(v) : null })}
                  normalize={(d: dayjs.Dayjs | null) => (d ? d.format('YYYY-MM-DD') : null)}
                >
                  <DatePicker style={{ width: '100%' }} />
                </Form.Item>
              </Col>
            )}
            <Col span={24}>
              <Form.Item name="reason" label="调整事由与预算联动说明" rules={[{ required: true, whitespace: true }]}>
                <Input.TextArea rows={2} maxLength={1000} />
              </Form.Item>
            </Col>
          </Row>

          <Typography.Text strong>多量纲调整明细行</Typography.Text>
          <Form.List name="lines">
            {(fields, { add, remove }) => (
              <Space direction="vertical" style={{ width: '100%', marginTop: 8 }} size={8}>
                {fields.map((field, index) => {
                  const { key, ...restField } = field;
                  const ln = linesWatch[index] ?? {};
                  const vt = (ln.valueType ?? 'amount_cents') as PlanAdjustmentValueType;
                  const deltaText = computeDeltaPreview(vt, ln.beforeVal, ln.afterVal);
                  return (
                    <Card key={key} size="small">
                      <Row gutter={8} align="middle">
                        <Col span={5}>
                          <Form.Item {...restField} name={[restField.name, 'targetSheetCode']} label="工作表" rules={[{ required: true }]}>
                            <Select options={(Object.entries(sheetLabels) as [PlanSheetCode, string][]).map(([value, label]) => ({ value, label }))} />
                          </Form.Item>
                        </Col>
                        <Col span={5}>
                          <Form.Item {...restField} name={[restField.name, 'targetItemName']} label="指标/项目名称" rules={[{ required: true, whitespace: true }]}>
                            <Input maxLength={200} />
                          </Form.Item>
                        </Col>
                        <Col span={4}>
                          <Form.Item {...restField} name={[restField.name, 'valueType']} label="量纲类型">
                            <Select options={VALUE_TYPE_OPTIONS.map((o) => ({ value: o.value, label: o.label }))} />
                          </Form.Item>
                        </Col>
                        <Col span={3}>
                          <Form.Item {...restField} name={[restField.name, 'beforeVal']} label="调整前">
                            <Input />
                          </Form.Item>
                        </Col>
                        <Col span={3}>
                          <Form.Item {...restField} name={[restField.name, 'afterVal']} label="调整后">
                            <Input />
                          </Form.Item>
                        </Col>
                        <Col span={3}>
                          <div style={{ fontSize: 12, color: 'var(--newfc-text-tertiary)' }}>增减 delta</div>
                          <Tag color="blue">{deltaText}</Tag>
                        </Col>
                        <Col span={1}>
                          {fields.length > 1 && (
                            <Button size="small" danger type="link" onClick={() => remove(field.name)}>
                              删
                            </Button>
                          )}
                        </Col>
                      </Row>
                    </Card>
                  );
                })}
                <Button
                  type="dashed"
                  onClick={() =>
                    add({ targetSheetCode: 'investment', targetItemName: '', valueType: 'amount_cents', unit: '元', beforeVal: '0.00', afterVal: '0.00' })
                  }
                >
                  + 新增调整明细行
                </Button>
              </Space>
            )}
          </Form.List>
        </Form>
      </Modal>

      <Modal
        open={reviewTarget != null}
        title={reviewTarget ? `复核计划与预算调整申请 #${reviewTarget.id}` : '复核调整申请'}
        onCancel={() => setReviewTarget(null)}
        confirmLoading={reviewMut.isPending}
        okButtonProps={{
          disabled: isSelfReview && reviewActionWatch === 'approve' && !reviewExceptionWatch.trim(),
        }}
        destroyOnClose
        onOk={() => reviewForm.validateFields().then((v) => reviewMut.mutate(v), () => undefined)}
      >
        {isSelfReview && (
          <Alert
            type="warning"
            showIcon
            style={{ marginBottom: 12 }}
            message="同人自审管控提示：当前登录账号与申请提交人为同一人，仅在单管理员演练/应急场景填写「同人复核例外原因」后方可批准（必填决策文号绝不可豁免）。"
          />
        )}
        <Form form={reviewForm} layout="vertical" preserve={false} initialValues={{ action: 'approve' }}>
          <Form.Item name="action" label="复核结论" rules={[{ required: true }]}>
            <Select options={[{ value: 'approve', label: '批准并生成修订下达周期' }, { value: 'reject', label: '驳回申请' }]} />
          </Form.Item>
          <Form.Item
            name="decisionDocNo"
            label="法定审定决策文号（批准必填）"
            rules={reviewActionWatch === 'approve' ? [{ required: true, whitespace: true, message: '批准调整必须登记法定决策文号' }] : []}
          >
            <Input maxLength={120} placeholder="如 集团总办纪〔2026〕09号" />
          </Form.Item>
          {isSelfReview && reviewActionWatch === 'approve' && (
            <Form.Item
              name="exceptionReason"
              label="同人复核例外原因（必填）"
              rules={[{ required: true, whitespace: true, message: '同人复核必须填写例外原因' }]}
            >
              <Input.TextArea rows={2} maxLength={500} placeholder="说明单管理员应急复核原因" />
            </Form.Item>
          )}
          <Form.Item name="comment" label="复核意见">
            <Input.TextArea rows={2} maxLength={1000} />
          </Form.Item>
        </Form>
      </Modal>
    </Space>
  );
}
