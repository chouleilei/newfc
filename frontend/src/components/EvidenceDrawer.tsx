import { useEffect, useState } from 'react';
import { Drawer, Descriptions, List, Space, Tag, Typography, Button, Empty, Table, Alert, Tooltip, Result } from 'antd';
import type { TableColumnsType } from 'antd';
import { useQuery } from '@tanstack/react-query';
import { Link } from 'react-router-dom';
import { api, download } from '../api/client';
import { getImportBatchDetail } from '../api/importBatch';
import { summarizeImportBatch } from '../utils/importBatchSummary';
import MoneyText from './MoneyText';
import { formatQuantity } from '../utils/money';
import { buildScopeSearch } from '../utils/workspaceScope';
import { VerifyBar, type VerifyItem } from './VerifyBar';
import { AssistantSurfaceBoundary } from './assistant/AssistantSurfaceBoundary';

/** 后端核验事实(与 backend/src/modules/report/verification.ts 对应)。 */
interface VerificationFactItem {
  factKey: string;
  serverLevel: 'ok' | 'warn' | 'bad';
  scope: { versionId: number | null; batchId: number | null; orgScopeId: number | null; accountScopeId: number | null; sheetKey: string | null };
  label: string;
  details: string[];
  facts: Record<string, number | string | null>;
  actionTarget: { kind: 'anchor'; anchor: string; hint: string } | null;
}

/** 单元格穿透:科目 → 子科目 → 叶子单元格 → 公式/测算依据/导入原件 */
export interface CellEvidenceTarget {
  type: 'budget' | 'actual';
  sourceId: number;
  accountId: number;
  orgId?: number;
}

/** 指标穿透:指标 → 公式项 → 科目(转入 CellEvidenceTarget 继续下钻)。范围参数须与分析页筛选一致 */
export interface MetricEvidenceTarget {
  type: 'metric';
  versionId: number;
  metricId: number;
  batchId?: number | null;
  orgScopeId?: number | null;
  accountScopeId?: number | null;
  sheetKey?: string | null;
}

export type EvidenceTarget = CellEvidenceTarget | MetricEvidenceTarget;

interface CellEvidenceResponse {
  sourceType: 'budget' | 'actual';
  version?: { id: number; year: number; name: string; kind: string; status: string };
  batch?: { id: number; year: number; snapshotDate: string; revision: number; source: string };
  organization: { id: number; code: string; name: string };
  account: { id: number; code: string; name: string; type: string; unit?: string };
  value: { amountCents: number; quantity: number };
  directComponents: { accountId: number; code: string; name: string; type: string; unit?: string; amountCents: number; quantity: number }[];
  entry?: { formula: string; note: string; updatedAt: string } | null;
  /** 测算参数:value 的单位由 valueKind 判别(quantity=10^4 缩放数量,amount=金额分),不能混用 */
  calculationSources?: { ruleId: number; ruleName: string; inputs: { code: string; name: string; valueKind: 'quantity' | 'amount'; accountType: string | null; unit: string | null; value: number | null }[] }[];
  importSources?: { id: number; original_name: string; sha256: string; committed_at: string }[];
  importSource?: { id: number; original_name: string; sha256: string; committed_at: string } | null;
}

interface MetricEvidenceTerm {
  sourceType: 'account' | 'metric';
  sourceId: number;
  code: string;
  name: string;
  coefficient: 1 | -1;
  accountType: string | null;
  accountStatus: string | null;
  missing: boolean;
  missingReason: string | null;
  coveredLeafCount: number | null;
  budgetCents: number;
  actualCents: number;
  varianceCents: number;
  varianceShare: number | null;
  drillable: boolean;
}

interface MetricEvidenceResponse {
  sourceType: 'metric';
  version: { id: number; year: number; name: string; kind: string; status: string };
  actualBasis: { asOfDate: string | null; source: string; batchId: number | null };
  scopeBasis: { sheetKey: string; sheetName: string; orgScopeId: number | null; accountScopeId: number | null };
  scopeNarrowed: boolean;
  metric: { id: number; code: string; name: string };
  value: { budgetCents: number; actualCents: number; varianceCents: number };
  terms: MetricEvidenceTerm[];
  reconciliation: {
    budget: { sumOfTermsCents: number; valueCents: number; reconciled: boolean };
    actual: { sumOfTermsCents: number; valueCents: number; reconciled: boolean };
  };
  actualCoverage: {
    unbudgetedActual: {
      count: number;
      amountCents: number;
      entries: {
        orgId: number; orgCode: string; orgName: string;
        accountId: number; accountCode: string; accountName: string; accountType: string;
        amountCents: number; quantity: number | null; reason: string;
      }[];
    };
    reconciliation: { sourceActualCents: number; displayedActualCents: number; differenceCents: number };
  };
  /** 核验事实(§9.5):coverage / coverage_unbudgeted,与本抽屉核验条及助手共用 */
  verificationFacts: VerificationFactItem[];
  notes: string[];
}

const ACTUAL_SOURCE_LABEL: Record<string, string> = {
  current: '当前实际累计',
  snapshot: '指定实际快照',
  final: '年度关闭最终快照',
  none: '尚无实际数据',
};

function pathOf(target: EvidenceTarget): string {
  if (target.type === 'metric') {
    const query = new URLSearchParams({ versionId: String(target.versionId), metricId: String(target.metricId) });
    if (target.batchId != null) query.set('batchId', String(target.batchId));
    if (target.orgScopeId != null) query.set('orgScopeId', String(target.orgScopeId));
    if (target.accountScopeId != null) query.set('accountScopeId', String(target.accountScopeId));
    if (target.sheetKey) query.set('sheetKey', target.sheetKey);
    return `/evidence/metric-cell?${query.toString()}`;
  }
  const key = target.type === 'budget' ? 'versionId' : 'batchId';
  const query = new URLSearchParams({ [key]: String(target.sourceId), accountId: String(target.accountId) });
  if (target.orgId != null) query.set('orgId', String(target.orgId));
  return `/evidence/${target.type === 'budget' ? 'budget-cell' : 'actual-cell'}?${query.toString()}`;
}

/** 带符号金额:利润方向正数有利,与年度执行分析页指标表同口径(不做成本费用取正处理) */
/** 带符号金额:利润方向正数有利,与年度执行分析页指标表同口径(不做成本费用取正处理)。
 *  差异的「好/坏」由调用方判定后经 tone 传入 —— 组件本身不按正负自动上语义色。 */
function signedText(cents: number) {
  return <MoneyText cents={cents} tone={cents > 0 ? 'good' : cents < 0 ? 'bad' : 'neutral'} hideUnit />;
}

function MetricBody({ data, onDrill }: { data: MetricEvidenceResponse; onDrill: (next: EvidenceTarget) => void }) {
  const scope: MetricEvidenceTarget = {
    type: 'metric',
    versionId: data.version.id,
    metricId: data.metric.id,
    batchId: data.actualBasis.batchId,
    orgScopeId: data.scopeBasis.orgScopeId,
    accountScopeId: data.scopeBasis.accountScopeId,
    sheetKey: data.scopeBasis.sheetKey,
  };
  const columns: TableColumnsType<MetricEvidenceTerm> = [
    {
      title: '公式项',
      width: 250,
      render: (_v, row) => (
        <Space size={4} wrap>
          <Typography.Text strong style={{ fontSize: 15 }}>{row.coefficient > 0 ? '+' : '−'}</Typography.Text>
          <Tag>{row.code}</Tag>
          <span>{row.name}</span>
          {row.sourceType === 'metric' && <Tag color="blue">指标</Tag>}
          {row.accountStatus === 'inactive' && <Tooltip title="科目已停用，历史数据仍计入"><Tag color="orange">已停用</Tag></Tooltip>}
          {row.missing && <Tooltip title={row.missingReason ?? ''}><Tag color="red">按零计入</Tag></Tooltip>}
          {!row.missing && row.coveredLeafCount === 0 && (
            <Tooltip title="当前筛选范围内没有该科目的数据，因此按零计入"><Tag color="orange">范围内无数据</Tag></Tooltip>
          )}
        </Space>
      ),
    },
    { title: '年度预算(万元)', align: 'right', width: 130, render: (_v, row) => <MoneyText cents={row.budgetCents} hideUnit /> },
    { title: '累计实际(万元)', align: 'right', width: 130, render: (_v, row) => <MoneyText cents={row.actualCents} hideUnit /> },
    { title: '差异(万元)', align: 'right', width: 120, sorter: (a, b) => Math.abs(a.varianceCents) - Math.abs(b.varianceCents), render: (_v, row) => signedText(row.varianceCents) },
    {
      title: '占差异',
      align: 'right',
      width: 88,
      render: (_v, row) => (row.varianceShare == null ? '—' : `${(row.varianceShare * 100).toFixed(1)}%`),
    },
    {
      title: '继续穿透',
      width: 140,
      render: (_v, row) => {
        if (!row.drillable) return <Typography.Text type="secondary">—</Typography.Text>;
        if (row.sourceType === 'metric') {
          return <Button type="link" size="small" style={{ paddingInline: 4 }} onClick={() => onDrill({ ...scope, metricId: row.sourceId })}>公式项</Button>;
        }
        return (
          <Space size={0}>
            <Button type="link" size="small" style={{ paddingInline: 4 }}
              onClick={() => onDrill({ type: 'budget', sourceId: data.version.id, accountId: row.sourceId, orgId: data.scopeBasis.orgScopeId ?? undefined })}>预算</Button>
            {data.actualBasis.batchId != null && (
              <Button type="link" size="small" style={{ paddingInline: 4 }}
                onClick={() => onDrill({ type: 'actual', sourceId: data.actualBasis.batchId!, accountId: row.sourceId, orgId: data.scopeBasis.orgScopeId ?? undefined })}>实际</Button>
            )}
          </Space>
        );
      },
    },
  ];

  const reconciled = data.reconciliation.budget.reconciled && data.reconciliation.actual.reconciled;
  return (
    <>
      <Descriptions size="small" bordered column={2}>
        <Descriptions.Item label="指标">{data.metric.code} {data.metric.name}</Descriptions.Item>
        <Descriptions.Item label="预算版本">{data.version.year} · {data.version.name}</Descriptions.Item>
        <Descriptions.Item label="年度预算"><MoneyText cents={data.value.budgetCents} /></Descriptions.Item>
        <Descriptions.Item label="累计实际"><MoneyText cents={data.value.actualCents} /></Descriptions.Item>
        <Descriptions.Item label="预算差异">{signedText(data.value.varianceCents)}</Descriptions.Item>
        <Descriptions.Item label="实际数截至">
          {data.actualBasis.asOfDate ?? '无'}
          <Typography.Text type="secondary" style={{ marginLeft: 6, fontSize: 12 }}>
            {ACTUAL_SOURCE_LABEL[data.actualBasis.source] ?? data.actualBasis.source}
          </Typography.Text>
        </Descriptions.Item>
        <Descriptions.Item label="口径" span={2}>
          <Space size={4} wrap>
            <Tag>{data.scopeBasis.sheetName}</Tag>
            {data.scopeBasis.orgScopeId != null && <Tag color="cyan">已限定组织范围</Tag>}
            {data.scopeBasis.accountScopeId != null && <Tag color="cyan">已限定科目范围</Tag>}
            <Tag color={data.version.status === 'draft' ? 'default' : 'green'}>
              {data.version.status === 'draft' ? '公式取当前配置' : '公式取定稿固化快照'}
            </Tag>
          </Space>
        </Descriptions.Item>
      </Descriptions>

      {/* 抽屉里的勾稽结论与页面/助手共用后端 verificationFacts(§9.5)；
          打开明细即登记 evidence:metric 核验焦点,助手可回答「这个核验为什么没通过」。 */}
      <VerifyBar
        style={{ marginTop: 12 }}
        items={(data.verificationFacts ?? []).map((fact): VerifyItem => ({
          key: fact.factKey.replace(/_/g, '-'),
          level: fact.serverLevel,
          label: fact.label,
          details: fact.details.length ? fact.details : undefined,
          assistantTarget: {
            ownerKey: `evidence:metric:${data.version.id}:${data.metric.id}`,
            factKey: fact.factKey,
            scopeRef: {
              versionId: data.version.id,
              metricId: data.metric.id,
              ...(fact.scope.batchId != null ? { batchId: fact.scope.batchId } : {}),
              ...(fact.scope.orgScopeId != null ? { orgScopeId: fact.scope.orgScopeId } : {}),
              ...(fact.scope.accountScopeId != null ? { accountScopeId: fact.scope.accountScopeId } : {}),
            },
          },
        }))}
      />
      {data.actualCoverage.unbudgetedActual.count > 0 && (
        <Table
          style={{ marginTop: 8 }}
          rowKey={(row) => `${row.orgId}:${row.accountId}`}
          size="small"
          pagination={{ pageSize: 5, hideOnSinglePage: true }}
          dataSource={data.actualCoverage.unbudgetedActual.entries}
          columns={[
            { title: '未预算实际组织', width: 180, render: (_v, row) => `${row.orgCode} ${row.orgName}` },
            { title: '未预算实际科目', width: 200, render: (_v, row) => `${row.accountCode} ${row.accountName}` },
            { title: '原因', dataIndex: 'reason', width: 190 },
            { title: '金额(万元,利润方向)', align: 'right', width: 150, render: (_v, row) => <MoneyText cents={row.amountCents} hideUnit /> },
          ]}
          scroll={{ x: 720 }}
        />
      )}

      <Typography.Title level={5} style={{ marginTop: 18 }}>公式构成</Typography.Title>
      <Typography.Paragraph type="secondary" style={{ fontSize: 12, marginBottom: 8 }}>
        各项为已乘 ± 系数的贡献额，相加即为指标值；差异 = 实际 − 预算（利润方向，正数有利）。按差异列排序可找出主要影响项。
      </Typography.Paragraph>
      <Table
        rowKey={(row) => `${row.sourceType}:${row.sourceId}`}
        size="small"
        pagination={false}
        dataSource={data.terms}
        columns={columns}
        scroll={{ x: 860 }}
        summary={() => (
          <Table.Summary.Row>
            <Table.Summary.Cell index={0}><Typography.Text strong>逐项合计</Typography.Text></Table.Summary.Cell>
            <Table.Summary.Cell index={1} align="right">
              <MoneyText cents={data.reconciliation.budget.sumOfTermsCents} hideUnit />
            </Table.Summary.Cell>
            <Table.Summary.Cell index={2} align="right">
              <MoneyText cents={data.reconciliation.actual.sumOfTermsCents} hideUnit />
            </Table.Summary.Cell>
            <Table.Summary.Cell index={3} align="right">
              <MoneyText cents={data.value.varianceCents} hideUnit />
            </Table.Summary.Cell>
            <Table.Summary.Cell index={4} colSpan={2}>
              {reconciled
                ? <Tag color="green">与指标值一致</Tag>
                : <Tag color="red">与指标值不符</Tag>}
            </Table.Summary.Cell>
          </Table.Summary.Row>
        )}
      />

      {data.scopeNarrowed && (
        <Alert
          type="warning"
          showIcon
          style={{ marginTop: 12 }}
          message="当前收窄了科目或表格范围"
          description="继续穿透科目时，科目明细按完整科目树计算，其合计可能大于本页该项金额。"
        />
      )}
      {!reconciled && (
        <Alert type="error" showIcon style={{ marginTop: 12 }} message="逐项贡献之和与指标值不相等，请检查该指标的公式定义" />
      )}
      <List
        size="small"
        style={{ marginTop: 12 }}
        header={<Typography.Text type="secondary" style={{ fontSize: 12 }}>口径说明</Typography.Text>}
        dataSource={data.notes}
        renderItem={(note) => <List.Item><Typography.Text type="secondary" style={{ fontSize: 12 }}>{note}</Typography.Text></List.Item>}
      />
      {/* UX-03:回到分析页的入口携带与本抽屉完全一致的范围;
          历史快照口径是只读结果,在链接旁明说不可原地改写 */}
      <div style={{ marginTop: 12 }}>
        <Link to={`/analysis?${buildScopeSearch('analysis', {
          year: data.version.year,
          budgetVersionId: data.version.id,
          actualSnapshotId: data.actualBasis.batchId ?? undefined,
          orgScopeId: data.scopeBasis.orgScopeId ?? undefined,
          accountScopeId: data.scopeBasis.accountScopeId ?? undefined,
          sheet: data.scopeBasis.sheetKey,
        })}`}>在执行分析中打开相同口径（只读）</Link>
        {data.actualBasis.source !== 'current' && data.actualBasis.batchId != null && (
          <Typography.Text type="secondary" style={{ fontSize: 12, marginLeft: 8 }}>
            当前为历史快照口径，历史结果不可原地改写。
          </Typography.Text>
        )}
      </div>
    </>
  );
}

/**
 * 导入来源条目(UX-19):与导入批次列表/详情共用同一业务摘要表达
 * (来源/年度/目标/动作计数),并给「查看批次详情」互链;详情查询失败时回退到
 * 原有的文件名+指纹展示,不阻塞抽屉其余内容。
 */
function ImportSourceItem({ item }: { item: { id: number; original_name: string; sha256: string; committed_at: string } }) {
  const detailQuery = useQuery({
    queryKey: ['import-batch-detail', item.id],
    queryFn: () => getImportBatchDetail(item.id),
    staleTime: 60_000,
  });
  const business = detailQuery.data ? summarizeImportBatch(detailQuery.data) : null;
  return (
    <List.Item
      actions={[
        <Link key="detail" to={`/data?tab=imports&batch=${item.id}`}>查看批次详情</Link>,
        <Button key="download" size="small" onClick={() => download(`/io/import-batches/${item.id}/source`, item.original_name)}>下载原文件</Button>,
      ]}
    >
      <div>
        <div>批次 #{item.id} · {item.original_name}</div>
        {business?.recognized ? (
          <Typography.Text type="secondary" style={{ fontSize: 12 }}>
            {[business.sourceLabel, business.yearsLabel, business.targetLabel].filter(Boolean).join(' · ')}
            {business.actionsLabel ? `；${business.actionsLabel}` : ''}
            {business.countLabel ? `；${business.countLabel}` : ''}
          </Typography.Text>
        ) : (
          <Typography.Text type="secondary">SHA-256：{item.sha256}</Typography.Text>
        )}
      </div>
    </List.Item>
  );
}

function CellBody({ data, onDrill }: { data: CellEvidenceResponse; onDrill: (next: EvidenceTarget) => void }) {
  const imports = data.importSources ?? (data.importSource ? [data.importSource] : []);
  /* UX-03:跨页入口带同口径范围;已定稿版本与历史快照是只读事实,
     入口与「可编辑目标」分开表达,不允许被误解为进入编辑。 */
  const analysisSearch = buildScopeSearch('analysis', {
    year: data.version?.year ?? data.batch?.year,
    budgetVersionId: data.version?.id,
    actualSnapshotId: data.batch?.id,
    orgScopeId: data.organization.id,
    accountScopeId: data.account.id,
  });
  return (
    <>
      <Descriptions size="small" bordered column={2}>
        <Descriptions.Item label="数据来源">{data.version ? `${data.version.year} · ${data.version.name}` : `${data.batch?.year} 实际快照 #${data.batch?.id}`}</Descriptions.Item>
        <Descriptions.Item label="组织">{data.organization.code} {data.organization.name}</Descriptions.Item>
        <Descriptions.Item label="科目">{data.account.code} {data.account.name}</Descriptions.Item>
        <Descriptions.Item label="当前值">{data.account.type === 'quantity' ? formatQuantity(data.value.quantity, data.account.unit) : <MoneyText cents={data.account.type === 'cost' || data.account.type === 'expense' ? -data.value.amountCents : data.value.amountCents} />}</Descriptions.Item>
        {data.entry?.formula && <Descriptions.Item label="公式" span={2}><Typography.Text code>{data.entry.formula}</Typography.Text></Descriptions.Item>}
        {data.entry?.note && <Descriptions.Item label="测算依据" span={2}>{data.entry.note}</Descriptions.Item>}
      </Descriptions>

      <Typography.Title level={5} style={{ marginTop: 18 }}>直接构成</Typography.Title>
      {data.directComponents.length === 0 ? <Typography.Text type="secondary">叶子数据，没有下级构成。</Typography.Text> : <List size="small" dataSource={data.directComponents} renderItem={(item) => <List.Item actions={[<Button key="open" type="link" onClick={() => onDrill({ type: data.sourceType, sourceId: data.version?.id ?? data.batch!.id, accountId: item.accountId, orgId: data.organization.id })}>继续查看</Button>]}>
        <Space><Tag>{item.code}</Tag><span>{item.name}</span>{item.type === 'quantity' ? <Typography.Text type="secondary">{formatQuantity(item.quantity, item.unit)}</Typography.Text> : <MoneyText cents={item.type === 'cost' || item.type === 'expense' ? -item.amountCents : item.amountCents} size="sm" />}</Space>
      </List.Item>} />}

      {(data.calculationSources?.length ?? 0) > 0 && <><Typography.Title level={5}>测算参数</Typography.Title><List size="small" dataSource={data.calculationSources} renderItem={(rule) => <List.Item><div><b>{rule.ruleName}</b>{rule.inputs.map((input) => <div key={input.code}><Tag>{input.code}</Tag>{input.name}：{input.value == null ? '未填' : input.valueKind === 'quantity' ? formatQuantity(input.value, input.unit ?? undefined) : <MoneyText cents={input.accountType === 'cost' || input.accountType === 'expense' ? -input.value : input.value} size="sm" />}</div>)}</div></List.Item>} /></>}

      <Typography.Title level={5}>导入来源</Typography.Title>
      {imports.length === 0 ? <Typography.Text type="secondary">没有匹配的 Excel 导入批次，可能来自手工录入或后续修改。</Typography.Text> : <List size="small" dataSource={imports} renderItem={(item) => <ImportSourceItem item={item} />} />}

      <Typography.Title level={5}>相关入口</Typography.Title>
      <Space wrap>
        {analysisSearch && <Link to={`/analysis?${analysisSearch}`}>在执行分析中查看（只读）</Link>}
        {data.version && data.version.status === 'draft' && (
          <Link to={`/budget/${data.version.id}?orgId=${data.organization.id}&accountId=${data.account.id}`}>进入预算编制</Link>
        )}
        {data.version && data.version.status !== 'draft' && (
          <Link to={`/budget/${data.version.id}?orgId=${data.organization.id}&accountId=${data.account.id}`}>查看预算版本（只读）</Link>
        )}
      </Space>
      {data.version && data.version.status !== 'draft' && (
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: '6px 0 0' }}>
          该版本已定稿，是只读结果，不可原地改写；需要修订时请复制为新草稿。
        </Typography.Paragraph>
      )}
      {data.batch && (
        <Typography.Paragraph type="secondary" style={{ fontSize: 12, margin: '6px 0 0' }}>
          实际快照是只读的历史结果，不可原地改写；需要修正时请在「实际录入与快照」中更新当前累计或补录历史快照。
        </Typography.Paragraph>
      )}
    </>
  );
}

export function EvidenceDrawer(props: {
  target: EvidenceTarget | null;
  onTargetChange: (target: EvidenceTarget | null) => void;
}) {
  const { target, onTargetChange } = props;
  /** 下钻路径:指标→公式项→科目→子科目 会走好几层,必须能逐层退回 */
  const [trail, setTrail] = useState<EvidenceTarget[]>([]);
  useEffect(() => { if (!target) setTrail([]); }, [target]);

  const path = target ? pathOf(target) : '';
  const query = useQuery({
    queryKey: ['evidence', path],
    queryFn: () => api.get<CellEvidenceResponse | MetricEvidenceResponse>(path),
    enabled: Boolean(target),
  });
  const data = query.data;

  const drill = (next: EvidenceTarget) => {
    if (target) setTrail((prev) => [...prev, target]);
    onTargetChange(next);
  };
  const back = () => {
    const prev = trail[trail.length - 1];
    setTrail((rest) => rest.slice(0, -1));
    onTargetChange(prev ?? null);
  };

  return (
    <Drawer
      title={
        <Space>
          {trail.length > 0 && (
            <Button size="small" icon={<i className="ri-arrow-left-line" aria-hidden />} onClick={back}>返回上一层</Button>
          )}
          <span>{target?.type === 'metric' ? '指标穿透' : '数字来源'}</span>
          {trail.length > 0 && <Typography.Text type="secondary" style={{ fontSize: 12 }}>第 {trail.length + 1} 层</Typography.Text>}
        </Space>
      }
      width={target?.type === 'metric' ? 'min(900px, 94vw)' : 'min(680px, 94vw)'}
      open={Boolean(target)}
      onClose={() => onTargetChange(null)}
      loading={query.isLoading}
    >
      {/* 登记 evidence_detail 浮层(§7.3)：当前 EvidenceTarget 是唯一有效对象，
          drill/back 原子替换 entity；抽屉内的核验 Popover 自动成为它的子浮层。 */}
      <AssistantSurfaceBoundary
        open={Boolean(target)}
        kind="drawer"
        surfaceKey="evidence_detail"
        entity={target
          ? target.type === 'metric'
            ? { entityType: 'metric', id: target.metricId }
            : { entityType: 'account', id: target.accountId }
          : null}
      >
        {query.error
          ? <Result status="error" title="数字来源加载失败" subTitle={query.error instanceof Error ? query.error.message : '请稍后重试'} extra={<Button onClick={() => void query.refetch()}>重试</Button>} />
          : !data
          ? <Empty description="暂无来源信息" />
          : data.sourceType === 'metric'
            ? <MetricBody data={data} onDrill={drill} />
            : <CellBody data={data} onDrill={drill} />}
      </AssistantSurfaceBoundary>
    </Drawer>
  );
}
